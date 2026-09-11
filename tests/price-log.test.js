// tests/price-log.test.js
// LE DEFAUT QU'IL EMPECHE : un journal des prix qui ecrit une ligne par CYCLE
// au lieu d'une par CHANGEMENT REEL. Le calendrier repousse les memes prix a
// chaque enregistrement et le full sync repousse tout : le journal se remplirait
// de milliers de lignes identiques, et « tenue a 120 pendant trois mois puis
// bradee » deviendrait illisible sous le bruit.
//
// Test d'acceptation de docs/specs/spec-yieldflow-v1.md §4, les trois cas :
//   1. poussee reelle              -> UNE ligne exacte
//   2. second cycle sans changement -> ZERO ligne
//   3. vente                        -> cloture correcte

const test = require('node:test')
const assert = require('node:assert')

const {
  enregistrerPrixPousses, cloturerVente, nuitsDuSejour, centimesValides
} = require('../lib/price-log')

// ─── Faux Supabase, qui tient une vraie table en memoire ─────────────────────
// Il applique l'invariant que porte l'index unique partiel de la migration :
// au plus UNE ligne courante par (bien, nuit). Sans cela, le test passerait sur
// un writer qui en ouvre deux — exactement le defaut que l'index existe pour
// fermer.
function fausseBase () {
  const lignes = []
  let seq = 0
  const base = {
    lignes,
    journal: { lectures: 0, insertions: 0, majs: 0 },
    // Le writer touche aussi `calendar_inventory` et `properties` EN LECTURE
    // pour la reouverture apres annulation. Les autres tables restent
    // interdites : une ecriture ailleurs serait un writer de plus.
    inventaire: [],   // { property_id, date, rate }  (rate en EUROS)
    biens: [],        // { id, user_id, base_price }
    from (table) {
      if (table === 'calendar_inventory') return requeteSur(base.inventaire)
      if (table === 'properties') return requeteSur(base.biens)
      assert.equal(table, 'price_display_log', 'le writer n ECRIT que dans sa table')
      return requete()
    }
  }
  // Lecture seule sur une table annexe (calendar_inventory, properties).
  function requeteSur (source) {
    const f = { eq: [], in: [] }
    const q = {
      select () { return q },
      eq (c, v) { f.eq.push([c, v]); return q },
      in (c, vs) { f.in.push([c, vs]); return q },
      is () { return q },
      maybeSingle () {
        const r = filtrer()
        return Promise.resolve({ data: r[0] || null, error: null })
      },
      then (resolve) { return Promise.resolve({ data: filtrer(), error: null }).then(resolve) }
    }
    function filtrer () {
      return source.filter(l => {
        for (const [c, v] of f.eq) if (String(l[c]) !== String(v)) return false
        for (const [c, vs] of f.in) if (!vs.includes(l[c])) return false
        return true
      })
    }
    return q
  }

  function requete () {
    const f = { eq: [], in: [], isNull: [] }
    let action = null
    let charge = null
    const q = {
      select () { action = action || 'select'; return q },
      insert (rows) { action = 'insert'; charge = rows; return q },
      update (patch) { action = 'update'; charge = patch; return q },
      eq (col, val) { f.eq.push([col, val]); return q },
      in (col, vals) { f.in.push([col, vals]); return q },
      is (col, val) { assert.equal(val, null); f.isNull.push(col); return q },
      then (resolve) { return Promise.resolve(executer()).then(resolve) }
    }
    function correspond (l) {
      for (const [c, v] of f.eq) if (l[c] !== v) return false
      for (const [c, vs] of f.in) if (!vs.includes(l[c])) return false
      for (const c of f.isNull) if (l[c] != null) return false
      return true
    }
    function executer () {
      if (action === 'insert') {
        base.journal.insertions++
        const rows = Array.isArray(charge) ? charge : [charge]
        for (const r of rows) {
          // L'invariant de l'index unique partiel.
          const conflit = lignes.some(l => l.property_id === r.property_id &&
            l.stay_date === r.stay_date && l.replaced_at == null && l.sold_at == null)
          if (conflit) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint "price_display_log_courante_idx"' } }
          }
          lignes.push({ id: `l${++seq}`, replaced_at: null, sold_at: null, sold_booking_uid: null, ...r })
        }
        return { data: rows, error: null }
      }
      if (action === 'update') {
        base.journal.majs++
        const touchees = lignes.filter(correspond)
        touchees.forEach(l => Object.assign(l, charge))
        return { data: touchees.map(l => ({ id: l.id })), error: null }
      }
      base.journal.lectures++
      return { data: lignes.filter(correspond), error: null }
    }
    return q
  }
  return base
}

const BIEN = '11111111-1111-1111-1111-111111111111'
const HOTE = '22222222-2222-2222-2222-222222222222'
const courantes = (sb) => sb.lignes.filter(l => l.replaced_at == null && l.sold_at == null)

test('ACCEPTATION 1 — une poussee reelle ouvre UNE ligne exacte par nuit', async () => {
  const sb = fausseBase()
  const bilan = await enregistrerPrixPousses(sb, {
    userId: HOTE, propertyId: BIEN,
    nuits: { '2026-10-01': 12000, '2026-10-02': 12000 }, source: 'host'
  })
  assert.equal(bilan.ouvertes, 2)
  assert.equal(bilan.remplacees, 0)
  assert.equal(sb.lignes.length, 2)
  const l = sb.lignes[0]
  assert.equal(l.rate, 12000, 'le prix est en CENTIMES, tel que pousse')
  assert.equal(l.stay_date, '2026-10-01', 'la NUIT, pas la date de poussee')
  assert.equal(l.source, 'host')
  assert.equal(l.user_id, HOTE, 'le compte est porte : le journal ne sort pas du compte')
  assert.equal(l.replaced_at, null)
  assert.equal(l.sold_at, null)
})

test('ACCEPTATION 2 — un second cycle sans changement n ecrit RIEN', async () => {
  const sb = fausseBase()
  const nuits = { '2026-10-01': 12000, '2026-10-02': 13500 }
  await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits })
  const apresPremier = sb.lignes.length
  const insertionsApres1 = sb.journal.insertions

  // Le calendrier repousse exactement les memes prix — cas le plus frequent.
  const bilan = await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits })

  assert.equal(bilan.ouvertes, 0, 'aucune ligne ouverte')
  assert.equal(bilan.remplacees, 0, 'aucune ligne fermee')
  assert.equal(bilan.inchangees, 2, 'les deux nuits sont reconnues identiques')
  assert.equal(sb.lignes.length, apresPremier, 'la table n a pas grossi')
  assert.equal(sb.journal.insertions, insertionsApres1, 'aucun INSERT n a meme ete tente')
})

test('un changement REEL ferme l ancienne ligne et en ouvre une seule', async () => {
  const sb = fausseBase()
  await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 12000 } })
  const bilan = await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 9900 } })

  assert.equal(bilan.remplacees, 1)
  assert.equal(bilan.ouvertes, 1)
  assert.equal(sb.lignes.length, 2, 'l historique est conserve, pas ecrase')
  assert.equal(courantes(sb).length, 1, 'UNE SEULE ligne courante — l invariant de l index')
  assert.equal(courantes(sb)[0].rate, 9900)
  const ancienne = sb.lignes.find(l => l.rate === 12000)
  assert.ok(ancienne.replaced_at, 'l ancienne porte sa date de remplacement')
  assert.equal(ancienne.sold_at, null, 'remplacee n est pas vendue')
})

test('ACCEPTATION 3 — la vente fige le prix affiche des nuits occupees', async () => {
  const sb = fausseBase()
  await enregistrerPrixPousses(sb, {
    userId: HOTE, propertyId: BIEN,
    nuits: { '2026-10-01': 12000, '2026-10-02': 13500, '2026-10-03': 14000 }
  })

  // Sejour du 1er au 3 : occupe les nuits du 1 et du 2, PAS celle du 3.
  const bilan = await cloturerVente(sb, {
    propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-03', bookingUid: 'BK-42'
  })

  assert.equal(bilan.nuits, 2, 'le jour de depart n est pas une nuit')
  assert.equal(bilan.fermees, 2)
  const vendues = sb.lignes.filter(l => l.sold_at != null)
  assert.equal(vendues.length, 2)
  assert.deepEqual(vendues.map(l => l.stay_date).sort(), ['2026-10-01', '2026-10-02'])
  assert.ok(vendues.every(l => l.sold_booking_uid === 'BK-42'), 'la vente est tracable')
  assert.deepEqual(vendues.map(l => l.rate).sort((a, b) => a - b), [12000, 13500],
    'le prix fige est celui qui etait AFFICHE, pas le montant paye')

  // ⚠ LA NUIT DU DEPART RESTE EN VENTE.
  // Elle est revendable le jour meme : la fermer ferait disparaitre du journal
  // un prix encore affiche.
  const libre = sb.lignes.find(l => l.stay_date === '2026-10-03')
  assert.equal(libre.sold_at, null)
  assert.equal(courantes(sb).length, 1)
})

test('une nuit deja vendue n est pas re-fermee par une seconde reservation', async () => {
  const sb = fausseBase()
  await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 12000 } })
  await cloturerVente(sb, { propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-02', bookingUid: 'BK-1' })
  const bilan = await cloturerVente(sb, { propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-02', bookingUid: 'BK-2' })

  assert.equal(bilan.fermees, 0, 'rien a fermer : la ligne n est plus courante')
  assert.equal(sb.lignes.find(l => l.stay_date === '2026-10-01').sold_booking_uid, 'BK-1',
    'le journal dit ce qui etait affiche, pas qui a achete en dernier')
})

test('une nuit sans ligne courante ne fait pas echouer la vente', async () => {
  // Le journal n'est pas retroactif : les nuits vendues avant sa mise en
  // service n'ont rien a fermer. Ce n'est pas une anomalie.
  const sb = fausseBase()
  const bilan = await cloturerVente(sb, {
    propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-04', bookingUid: 'BK-9'
  })
  assert.equal(bilan.nuits, 3)
  assert.equal(bilan.fermees, 0)
})

test('les entrees invalides sont ecartees, jamais ecrites', async () => {
  const sb = fausseBase()
  const bilan = await enregistrerPrixPousses(sb, {
    userId: HOTE, propertyId: BIEN,
    nuits: {
      '2026-10-01': 12000,
      '01/10/2026': 9000,      // format refuse
      '2026-10-02': 120.5,     // pas un entier de centimes
      '2026-10-03': -100       // negatif
    }
  })
  assert.equal(bilan.ouvertes, 1)
  assert.equal(bilan.ignorees, 3)
  assert.equal(sb.lignes.length, 1)
})

test('la source est verrouillee sur host|engine|seed', async () => {
  const sb = fausseBase()
  await assert.rejects(
    () => enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 100 }, source: 'cron' }),
    /source invalide/,
    'une source inconnue casserait la mesure « le moteur fait-il mieux que l hote »')
})

test('nuitsDuSejour : bornes, sejour d une nuit, dates aberrantes', () => {
  assert.deepEqual(nuitsDuSejour('2026-10-01', '2026-10-02'), ['2026-10-01'])
  assert.deepEqual(nuitsDuSejour('2026-10-01', '2026-10-01'), [], 'depart = arrivee : aucune nuit')
  assert.deepEqual(nuitsDuSejour('2026-10-02', '2026-10-01'), [], 'depart avant arrivee : aucune nuit')
  assert.deepEqual(nuitsDuSejour(null, '2026-10-01'), [])
  // Passage de mois et annee bissextile, en UTC (pas de derive de fuseau).
  assert.deepEqual(nuitsDuSejour('2026-02-28', '2026-03-01'), ['2026-02-28'])
  assert.equal(nuitsDuSejour('2026-01-01', '2027-06-01').length, 400, 'garde-fou sur dates aberrantes')
})

test('centimesValides refuse ce qui casserait l INSERT en silence', () => {
  assert.ok(centimesValides(0))
  assert.ok(centimesValides(12000))
  assert.ok(!centimesValides(120.5), 'un flottant echouerait sur la contrainte integer')
  assert.ok(!centimesValides(-1))
  assert.ok(!centimesValides(NaN))
  assert.ok(!centimesValides('12000'), 'une chaine passerait puis comparerait mal a la relecture')
})

// ─── Annulation : rouvrir sans ressusciter la vente ──────────────────────────

const { rouvrirApresAnnulation } = require('../lib/price-log')

test('ANNULATION — la ligne vendue n est JAMAIS rouverte, une nouvelle s ouvre', async () => {
  const sb = fausseBase()
  sb.biens.push({ id: BIEN, user_id: HOTE, base_price: 100, provider: 'channex', rate_sync_mode: 'managed' })
  // Une nuit SANS ligne de calendrier est fermee (runFullSync pousse
  // availability: 0) : les fixtures portent donc explicitement l'etat ouvert.
  sb.inventaire.push({ property_id: BIEN, date: '2026-10-01', rate: 95, stop_sell: false, avail: 1 })
  sb.inventaire.push({ property_id: BIEN, date: '2026-10-02', rate: null, stop_sell: false, avail: 1 })

  await enregistrerPrixPousses(sb, {
    userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 12000, '2026-10-02': 12000 }
  })
  await cloturerVente(sb, {
    propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-03', bookingUid: 'BK-7'
  })
  assert.equal(sb.lignes.filter(l => l.sold_at != null).length, 2)

  const bilan = await rouvrirApresAnnulation(sb, {
    propertyId: BIEN, bookingUid: 'BK-7', basePriceEur: 100
  })

  assert.equal(bilan.rouvertes, 2)
  // La verite de la vente est intacte.
  const vendues = sb.lignes.filter(l => l.sold_booking_uid === 'BK-7')
  assert.equal(vendues.length, 2, 'les deux lignes vendues sont toujours la')
  assert.ok(vendues.every(l => l.sold_at != null),
    'sold_at n est pas efface : cette nuit A ETE vendue a ce prix')

  // Et les nuits sont de nouveau mesurables, au prix du calendrier.
  const cour = courantes(sb)
  assert.equal(cour.length, 2)
  const parDate = Object.fromEntries(cour.map(l => [l.stay_date, l.rate]))
  assert.equal(parDate['2026-10-01'], 9500, 'prix du calendrier (95 EUR) pour la nuit tarifee')
  assert.equal(parDate['2026-10-02'], 10000, 'repli sur le prix de base (100 EUR) sinon')
})

test('ANNULATION — idempotent : rejouer l evenement n ouvre pas de doublon', async () => {
  const sb = fausseBase()
  sb.biens.push({ id: BIEN, user_id: HOTE, base_price: 100, provider: 'channex', rate_sync_mode: 'managed' })
  sb.inventaire.push({ property_id: BIEN, date: '2026-10-01', rate: null, stop_sell: false, avail: 1 })
  await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 12000 } })
  await cloturerVente(sb, { propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-02', bookingUid: 'BK-8' })

  const un = await rouvrirApresAnnulation(sb, { propertyId: BIEN, bookingUid: 'BK-8', basePriceEur: 100 })
  const deux = await rouvrirApresAnnulation(sb, { propertyId: BIEN, bookingUid: 'BK-8', basePriceEur: 100 })

  assert.equal(un.rouvertes, 1)
  assert.equal(deux.rouvertes, 0, 'le second passage n ouvre rien')
  assert.equal(deux.deja_courantes, 1, 'il constate la ligne deja courante')
  assert.equal(courantes(sb).length, 1, 'UNE SEULE ligne courante — l invariant tient')
})

test('ANNULATION — un full sync passe entre-temps a la priorite', async () => {
  // Si le calendrier a deja repousse un prix apres l annulation, c est LUI la
  // verite affichee : on n ecrase pas.
  const sb = fausseBase()
  sb.biens.push({ id: BIEN, user_id: HOTE, base_price: 100, provider: 'channex', rate_sync_mode: 'managed' })
  await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 12000 } })
  await cloturerVente(sb, { propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-02', bookingUid: 'BK-9' })
  await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 8000 } })

  const bilan = await rouvrirApresAnnulation(sb, { propertyId: BIEN, bookingUid: 'BK-9', basePriceEur: 100 })
  assert.equal(bilan.rouvertes, 0)
  assert.equal(courantes(sb)[0].rate, 8000, 'le prix du full sync reste en place')
})

test('ANNULATION — une nuit sans aucun prix connu n est pas inventee', async () => {
  // Sans prix, runFullSync FERME la date : rien n est affiche, donc rien a
  // journaliser. Ouvrir une ligne mentirait.
  const sb = fausseBase()
  sb.biens.push({ id: BIEN, user_id: HOTE, base_price: null, provider: 'channex', rate_sync_mode: 'managed' })
  // Nuit OUVERTE mais sans tarif, et pas de prix de base : rien a afficher.
  sb.inventaire.push({ property_id: BIEN, date: '2026-10-01', rate: null, stop_sell: false, avail: 1 })
  await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 12000 } })
  await cloturerVente(sb, { propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-02', bookingUid: 'BK-A' })

  const bilan = await rouvrirApresAnnulation(sb, { propertyId: BIEN, bookingUid: 'BK-A', basePriceEur: null })
  assert.equal(bilan.rouvertes, 0)
  assert.equal(bilan.sans_prix, 1)
  assert.equal(courantes(sb).length, 0)
})

test('ANNULATION — une reservation inconnue du journal ne fait rien', async () => {
  const sb = fausseBase()
  sb.biens.push({ id: BIEN, user_id: HOTE, base_price: 100, provider: 'channex', rate_sync_mode: 'managed' })
  const bilan = await rouvrirApresAnnulation(sb, { propertyId: BIEN, bookingUid: 'INCONNU', basePriceEur: 100 })
  assert.deepEqual(bilan, { rouvertes: 0, deja_courantes: 0, sans_prix: 0 })
})

test('le dispatcher branche la reouverture sur les annulations', () => {
  const fs2 = require('fs')
  const dispatch = fs2.readFileSync(require('path').join(__dirname, '..', 'lib/booking-changes-dispatch.js'), 'utf8')
  assert.ok(/rouvrirApresAnnulation\(/.test(dispatch), 'le consommateur appelle la reouverture')
  assert.ok(/event\.type === 'cancelled'/.test(dispatch), 'sur les annulations')
  // ⚠ `calendar_inventory` est clee sur l'UUID (exception a la regle 10, comme
  // ce journal) : passer `event.property_id`, qui est la cle provider, rendrait
  // zero ligne SANS ERREUR et aucune nuit ne serait rouverte.
  assert.ok(!/providerPropertyId/.test(dispatch),
    'le dispatcher ne passe PAS de cle provider : calendar_inventory est clee sur l uuid')
  assert.ok(/propertyId:\s+bien\.id/.test(dispatch),
    'il passe l uuid du bien')

  // Le repli sur le prix de base exige que la colonne soit selectionnee.
  const ctx = fs2.readFileSync(require('path').join(__dirname, '..', 'lib/cleaning/sync-menages.js'), 'utf8')
  assert.ok(/base_price/.test(ctx),
    'loadContext selectionne base_price, sinon toutes les nuits seraient « sans prix » en silence')
})

test('ANNULATION — une nuit FERMEE n est pas rouverte', async () => {
  // Les biens de Bagneres sont « tout ferme a la vente jusqu'a verification » :
  // rouvrir une ligne au tarif du calendrier pour une nuit qu'aucun voyageur ne
  // peut reserver serait exactement le mensonge que ce module interdit.
  const sb = fausseBase()
  sb.biens.push({ id: BIEN, user_id: HOTE, base_price: 100, provider: 'channex', rate_sync_mode: 'managed' })
  sb.inventaire.push({ property_id: BIEN, date: '2026-10-01', rate: 95, stop_sell: true, avail: 1 })
  await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 12000 } })
  await cloturerVente(sb, { propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-02', bookingUid: 'BK-F' })

  const bilan = await rouvrirApresAnnulation(sb, { propertyId: BIEN, bookingUid: 'BK-F', basePriceEur: 100 })
  assert.equal(bilan.rouvertes, 0)
  assert.equal(bilan.fermees, 1)
  assert.equal(courantes(sb).length, 0)
})

test('ANNULATION — une nuit SANS ligne de calendrier est fermee, pas au prix de base', async () => {
  // `runFullSync` traite l'absence de ligne comme `availability: 0`. Retomber
  // sur `base_price` ouvrirait une ligne pour une nuit invendable.
  const sb = fausseBase()
  sb.biens.push({ id: BIEN, user_id: HOTE, base_price: 100, provider: 'channex', rate_sync_mode: 'managed' })
  await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 12000 } })
  await cloturerVente(sb, { propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-02', bookingUid: 'BK-G' })

  const bilan = await rouvrirApresAnnulation(sb, { propertyId: BIEN, bookingUid: 'BK-G', basePriceEur: 100 })
  assert.equal(bilan.rouvertes, 0)
  assert.equal(bilan.fermees, 1)
})

test('ANNULATION — un bien dont HoteSmart ne pousse pas les prix n est pas journalise', async () => {
  // `lib/rate-sync.js` : un prix ne compte comme AFFICHE que si nous l'envoyons.
  // Un bien en `keep`, ou un bien Beds24, n'a jamais recu nos tarifs.
  for (const bienNonPoussable of [
    { provider: 'channex', rate_sync_mode: 'keep' },
    { provider: 'beds24', rate_sync_mode: 'managed' }
  ]) {
    const sb = fausseBase()
    sb.biens.push({ id: BIEN, user_id: HOTE, base_price: 100, ...bienNonPoussable })
    sb.inventaire.push({ property_id: BIEN, date: '2026-10-01', rate: 95, stop_sell: false, avail: 1 })
    await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { '2026-10-01': 12000 } })
    await cloturerVente(sb, { propertyId: BIEN, arrival: '2026-10-01', departure: '2026-10-02', bookingUid: 'BK-H' })

    const bilan = await rouvrirApresAnnulation(sb, { propertyId: BIEN, bookingUid: 'BK-H', basePriceEur: 100 })
    assert.equal(bilan.rouvertes, 0, JSON.stringify(bienNonPoussable))
    assert.equal(bilan.non_pousse, true, 'et il le DIT, plutot que de sortir en silence')
  }
})

test('ANNULATION — les nuits PASSEES ne sont jamais rouvertes', async () => {
  // Une annulation arrive souvent apres le debut du sejour. Une ligne courante
  // sur une date revolue ne serait jamais fermee — ni par remplacement, ni par
  // vente — et polluerait le denominateur « affichee / non vendue ».
  const sb = fausseBase()
  sb.biens.push({ id: BIEN, user_id: HOTE, base_price: 100, provider: 'channex', rate_sync_mode: 'managed' })
  const hier = new Date(); hier.setDate(hier.getDate() - 1)
  const dHier = `${hier.getFullYear()}-${String(hier.getMonth() + 1).padStart(2, '0')}-${String(hier.getDate()).padStart(2, '0')}`
  sb.inventaire.push({ property_id: BIEN, date: dHier, rate: 95, stop_sell: false, avail: 1 })
  await enregistrerPrixPousses(sb, { userId: HOTE, propertyId: BIEN, nuits: { [dHier]: 12000 } })
  await cloturerVente(sb, { propertyId: BIEN, arrival: dHier, departure: '2099-01-01', bookingUid: 'BK-P' })

  const bilan = await rouvrirApresAnnulation(sb, { propertyId: BIEN, bookingUid: 'BK-P', basePriceEur: 100 })
  assert.equal(bilan.rouvertes, 0)
  assert.equal(bilan.passees, 1)
  assert.equal(courantes(sb).length, 0, 'aucune ligne courante sur une nuit revolue')
})

// ─── Les POINTS DE CAPTURE ───────────────────────────────────────────────────
// Un writer correct branche sur un seul chemin ne journalise rien. Ces tests
// lisent les sources : ils ne verifient pas que le code marche, mais qu'il est
// BRANCHE — ce qu'aucun test unitaire du module ne peut voir.

const fs = require('fs')
const path = require('path')
const lireSrc = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('LE TEST QUI COMPTE : le FULL SYNC alimente le journal, pas seulement le calendrier', () => {
  // ⚠ LE DEFAUT QU'IL FERME, TROUVE EN REVIEW.
  // La premiere version ne journalisait que `api/calendar.js`. Or le chemin par
  // lequel un prix atteint REELLEMENT les OTA est le full sync 500 jours :
  // file `channel_sync_queue`, migration ARI, changement de rate plan. Toutes
  // les nuits au `base_price` — soit la quasi-totalite — n'entraient donc
  // jamais au journal. Pire : baisser le prix de base poussait 90 EUR aux
  // plateformes pendant que le journal affirmait encore 120, et la vente
  // figeait un prix que personne n'avait vu.
  const fullsync = lireSrc('lib/channel-fullsync.js')
  assert.ok(fullsync.includes("require('./price-log')"),
    'le full sync importe le writer du journal')
  assert.ok(/enregistrerPrixPousses\(/.test(fullsync),
    'et l appelle')
  assert.ok(/if \(rr\.ok &&/.test(fullsync),
    'seulement si POST /restrictions a REUSSI : un refus laisse l ancien prix affiche')
  assert.ok(/propertyId: bien\.id/.test(fullsync),
    'avec l UUID du bien, pas la cle provider')

  const calendrier = lireSrc('api/calendar.js')
  assert.ok(/enregistrerPrixPousses\(/.test(calendrier),
    'le calendrier journalise aussi ses poussees directes')
})

test('une nuit FERMEE n entre pas au journal, sur les deux chemins', () => {
  // Une date peut porter un prix ET etre fermee (`stop_sell`). Aucun voyageur
  // ne voit ce prix : le journaliser ferait croire a une nuit « tenue a 120
  // pendant trois mois » alors qu'elle etait invendable.
  const fullsync = lireSrc('lib/channel-fullsync.js')
  assert.ok(/if \(!obj\.stop_sell && !dejaVendue\) prixParNuitFs\[iso\] = rateCents/.test(fullsync),
    'le full sync exclut les nuits fermees ET les nuits deja vendues')
  assert.ok(/const dejaVendue = \(vendues\[iso\] \|\| \[\]\)\.length >= unites/.test(fullsync),
    'la nuit vendue se juge sur le stock, comme le plafonnement de disponibilite')

  const calendrier = lireSrc('api/calendar.js')
  // ⚠ L'ETAT EFFECTIF, PAS LE SEGMENT : une date DEJA fermee en base dont on ne
  // change que le tarif doit rester hors du journal. `reaffirmerStopSell` la
  // repoussera fermee, donc personne ne verra ce prix.
  assert.ok(/const etat = rowsByDate\[ds\]/.test(calendrier),
    'le calendrier lit l etat fusionne (base + segment)')
  assert.ok(/etat\.stop_sell === true \|\| etat\.avail === 0.*delete prixParNuit/s.test(calendrier),
    'et retire du journal toute nuit fermee, quelle que soit l origine de la fermeture')
  // Une nuit VENDUE n'est plus affichee : l'index unique partiel autorise une
  // courante a cote d'une vendue, donc sans ce filtre la nuit redeviendrait
  // « affichee, jamais vendue ».
  assert.ok(/dejaVendues\[d\] \|\| \[\]\)\.length >= unitesBien/.test(calendrier),
    'le calendrier ecarte aussi les nuits deja vendues')
})

test('le journal ne peut pas faire echouer une poussee', () => {
  // Le prix EST parti : c'est la mesure qui a manque. Une erreur rendue a
  // l'hote lui ferait repousser, donc ecraser.
  for (const f of ['lib/channel-fullsync.js', 'api/calendar.js']) {
    const src = lireSrc(f)
    // ⚠ `lastIndexOf`, PAS `indexOf` : la premiere occurrence est la ligne
    // d'import, et le test passait alors a cote de l'appel qu'il pretend
    // verifier — il aurait dit « ok » sur un appel sans catch.
    const bloc = src.slice(src.lastIndexOf('await enregistrerPrixPousses'))
    assert.ok(/catch \(e\)/.test(bloc.slice(0, 1200)),
      `${f} entoure l ecriture du journal d un catch`)
    assert.ok(/JOURNAL DES PRIX NON ECRIT/.test(src),
      `${f} HURLE si le journal n est pas ecrit — un journal muet est un journal faux`)
  }
})

test('la cloture a la vente suit aussi les sejours PROLONGES', () => {
  // Une reservation prolongee du 15 au 18 vend des nuits qui n'existaient pas
  // au `new` : sans cela, elles resteraient « affichees, jamais vendues ».
  const dispatch = lireSrc('lib/booking-changes-dispatch.js')
  assert.ok(/event\.type === 'modified'/.test(dispatch),
    'le consommateur du journal traite les modifications')
  assert.ok(/changes\?\.arrival \|\| event\.changes\?\.departure/.test(dispatch),
    'et precisement quand les DATES bougent, comme le fait deja le code d acces')
})

test('RECENSEMENT : aucun chemin de poussee tarifaire n echappe au journal', () => {
  // ⚠ CE TEST GARDE UNE PROPRIETE QUE LE CODE NE PORTE NULLE PART.
  // Le journal n'est correct que si TOUT chemin poussant un tarif l'alimente.
  // Rien, dans le code, n'empeche d'en ajouter un douzieme demain : ce
  // recensement echoue alors, et force a trancher explicitement.
  //
  // Audit du 12 septembre 2026 (`grep -rn "POST', '/restrictions'"`), quatre
  // emetteurs en production, deux seulement portent un prix.
  const ATTENDUS = {
    // Poussent un RATE par date -> DOIVENT journaliser.
    'lib/channel-fullsync.js': 'tarifaire',
    'api/calendar.js':         'tarifaire',
    // Poussent /restrictions SANS aucun rate -> rien a journaliser.
    // `reaffirmerStopSell` ne porte que `stop_sell` (lib/rate-sync.js le dit
    // explicitement) ; `channel-rateplan` ne pousse que `min_stay` sur le rate
    // plan enfant (« rate non touche -> reste derive »), et sa branche
    // alternative repasse par runFullSync, donc par le journal.
    'lib/channel-availability.js': 'sans-prix',
    'api/channel-rateplan.js':     'sans-prix'
  }

  const racine = path.join(__dirname, '..')
  const emetteurs = []
  for (const dossier of ['lib', 'api']) {
    const base = path.join(racine, dossier)
    for (const f of fs.readdirSync(base)) {
      if (!f.endsWith('.js')) continue
      const rel = `${dossier}/${f}`
      const src = fs.readFileSync(path.join(base, f), 'utf8')
      // Un POST vers /restrictions, quelle que soit la forme de l'appel.
      if (/(POST'|POST"|POST`)\s*,\s*['"`]\/restrictions/.test(src)) emetteurs.push(rel)
    }
  }

  assert.ok(emetteurs.length, 'le recensement doit trouver au moins un emetteur')

  // 1. Aucun emetteur inconnu.
  const inconnus = emetteurs.filter(f => !ATTENDUS[f])
  assert.deepEqual(inconnus, [],
    `NOUVEAU chemin de poussee non recense : ${inconnus.join(', ')}. ` +
    'S il porte un rate, il DOIT alimenter price_display_log ; sinon, l inscrire ' +
    'comme « sans-prix » avec la raison.')

  // 2. Aucun emetteur recense n a disparu (le branchement ne se perd pas en silence).
  const disparus = Object.keys(ATTENDUS).filter(f => !emetteurs.includes(f))
  assert.deepEqual(disparus, [],
    `chemin recense qui ne POSTe plus /restrictions : ${disparus.join(', ')}. ` +
    'Mettre le recensement a jour plutot que de le laisser mentir.')

  // 3. Les emetteurs tarifaires journalisent reellement.
  for (const [f, nature] of Object.entries(ATTENDUS)) {
    const src = fs.readFileSync(path.join(racine, f), 'utf8')
    if (nature === 'tarifaire') {
      assert.ok(/enregistrerPrixPousses\(/.test(src),
        `${f} pousse un tarif sans alimenter le journal`)
    } else {
      // Un « sans-prix » qui se mettrait a porter un rate doit reveiller le test.
      assert.ok(!/\brate:\s*rateCents|\brates:\s*occRates/.test(src),
        `${f} etait recense « sans prix » mais pousse desormais un rate : ` +
        'il doit alimenter le journal, et changer de categorie ici.')
    }
  }
})

test('les scripts de poussee passent par runFullSync, donc par le journal', () => {
  // Les scripts one-shot (amorcage, grille reelle, passage en managed) ne
  // doivent jamais POSTer /restrictions eux-memes : ils appellent runFullSync,
  // qui journalise. `staging-tarifs.js` est l'exception assumee — il travaille
  // sur l'environnement de STAGING, jamais sur les biens reels.
  const base = path.join(__dirname, '..', 'scripts')
  const fautifs = []
  for (const f of fs.readdirSync(base)) {
    if (!f.endsWith('.js') || f === 'staging-tarifs.js') continue
    const src = fs.readFileSync(path.join(base, f), 'utf8')
    if (/(POST'|POST"|POST`)\s*,\s*['"`]\/restrictions/.test(src)) fautifs.push(f)
  }
  assert.deepEqual(fautifs, [],
    `script(s) poussant /restrictions en direct : ${fautifs.join(', ')} — ` +
    'passer par runFullSync, sinon le prix part sans entrer au journal.')
})
