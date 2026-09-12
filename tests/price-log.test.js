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
  enregistrerPrixPousses, cloturerVente, nuitsDuSejour, centimesValides,
  ouverturesDeDatesTarifees, nuitsAJournaliser, estOuverte
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

test('LE TEST QUI COMPTE : le journal lit le compte de la GARDE, pas celui du bien', () => {
  // ⚠ LE DEFAUT DU 12 SEPTEMBRE 2026, ET IL A COUTE TROIS PRIX REELS.
  // `bien` vient d'un SELECT qui ne porte pas `user_id` : passer `bien.user_id`
  // a `nuitsOccupees` lui donnait `undefined`, la fonction levait « userId
  // requis », et le `catch` du bloc avalait l'exception dans un `console.error`
  // invisible depuis le poste. Les prix partaient aux plateformes, le journal
  // n'ecrivait rien, et RIEN ne le signalait.
  //
  // Il a fallu remonter l'erreur dans la reponse HTTP pour la voir. C'est le
  // piege de la colonne non selectionnee — documente trois fois dans ce depot,
  // et reproduit ici meme.
  const src = lireSrc('api/calendar.js')
  assert.ok(!/occupees\(supabase, bien\.provider_property_id,[\s\S]{0,200}userId: bien\.user_id/.test(src),
    'le journal ne doit PAS lire bien.user_id : ce SELECT ne le porte pas')
  assert.ok(/datesPrix\[datesPrix\.length - 1\], \{ userId: compte \}/.test(src),
    'il lit `compte`, le compte proprietaire resolu par la garde')
  // Et le writer ecrit sous le meme compte : les deux doivent s'accorder.
  const bloc = src.slice(src.lastIndexOf('await enregistrerPrixPousses'))
  assert.ok(/userId: compte/.test(bloc.slice(0, 300)),
    'le writer ecrit sous ce meme compte')
})

test('une non-ecriture du journal est toujours DITE', () => {
  // Le journal n'est pas retroactif : une non-ecriture silencieuse perd le prix
  // pour toujours, et rend le defaut indiagnostiquable. Le `if` doit parler
  // quand il ne fait rien.
  const src = lireSrc('api/calendar.js')
  assert.ok(/journal des prix NON ecrit/.test(src))
  // ⚠ LES DEUX ORIGINES DOIVENT ETRE NOMMEES, pas seulement le total.
  // Depuis le 12/09/2026 le journal a deux sources — un tarif pousse
  // (`/restrictions`) et une date ouverte deja tarifee (`/availability`) — et
  // chacune peut echouer seule. Un log qui ne dit que « 0 nuit » laisserait
  // indiagnostiquable le cas ou seule la seconde a ete perdue.
  assert.ok(/tarifs_pousses: Object\.keys\(prixParNuit\)\.length/.test(src),
    'et dit QUEL terme a echoue, pas seulement qu il a echoue')
  assert.ok(/ouvertures_tarifees: Object\.keys\(ouverturesTarifees\)\.length/.test(src),
    'y compris l origine « ouverture »')
  assert.ok(/availability: resultatsPoussee\.availability/.test(src),
    'et l etat du flux qui la porte')
  assert.ok(/JOURNAL DES PRIX NON ECRIT/.test(src), 'idem pour une exception')
})

// ⚠ UN GESTE EXPLICITE EST EXIGE : le journal ne peut appeler « ouverture »
// qu'une date dont la requete touche vraiment `avail` ou `stop_sell`.
// `G(objet)` declare que chaque date de cet objet porte un geste de
// disponibilite — la situation normale d'une ouverture depuis le calendrier.
const G = (o, quoi = { avail: true }) =>
  Object.fromEntries(Object.keys(o).map(d => [d, quoi]))

// ─── OUVRIR UNE DATE DEJA TARIFEE, C'EST L'AFFICHER ──────────────────────────
// LE DEFAUT QU'ILS EMPECHENT : une nuit qui devient vendable avec un prix que
// le journal ignore. Trouve le 12 septembre 2026 en verifiant Coeur de vie 23 —
// 14 nuits de week-end portaient 110 ou 130 EUR depuis le 10 septembre, etaient
// FERMEES lors de l'amorcage (donc legitimement non amorcees), puis ont ete
// ouvertes par un segment qui ne portait que la disponibilite. Pour le moteur,
// ces nuits n'avaient jamais eu de prix. Le journal ne se rattrape pas.

test('LE TEST QUI COMPTE : fermee+tarifee qui s ouvre entre au journal', () => {
  // Le cas reel, mot pour mot : 2026-11-07, samedi, 130 EUR en base depuis le
  // 10 septembre, stop_sell=true, puis ouverte sans nouveau tarif.
  const avant = { '2026-11-07': { date: '2026-11-07', rate: 130, avail: 0, stop_sell: true } }
  const apres = { '2026-11-07': { date: '2026-11-07', rate: 130, avail: 1, stop_sell: false } }
  const r = ouverturesDeDatesTarifees(avant, apres, { gestes: G(avant), dejaPousses: {} })
  assert.deepStrictEqual(r, { '2026-11-07': { cents: 13000, flux: ['availability'] } },
    'le prix devient affiche : il se journalise')
})

test('une date DEJA ouverte ne rejournalise rien', () => {
  // Sans cette garde, chaque enregistrement du calendrier rouvrirait une ligne
  // pour toutes les dates ouvertes de la plage — le bruit que ce journal evite.
  const avant = { '2026-11-07': { rate: 130, avail: 1, stop_sell: false } }
  const apres = { '2026-11-07': { rate: 130, avail: 1, stop_sell: false } }
  assert.deepEqual(ouverturesDeDatesTarifees(avant, apres, { gestes: G(avant) }), {})
})

test('une date qui reste FERMEE n est jamais affichee', () => {
  const avant = { '2026-11-07': { rate: 130, avail: 0, stop_sell: true } }
  assert.deepEqual(ouverturesDeDatesTarifees(avant,
    { '2026-11-07': { rate: 130, avail: 0, stop_sell: true } }, { gestes: G(avant) }), {})
  // Fermee par le stock seul, ou par l'intention seule : les deux comptent.
  assert.deepEqual(ouverturesDeDatesTarifees(avant,
    { '2026-11-07': { rate: 130, avail: 1, stop_sell: true } }, { gestes: G(avant) }), {})
  assert.deepEqual(ouverturesDeDatesTarifees(avant,
    { '2026-11-07': { rate: 130, avail: 0, stop_sell: false } }, { gestes: G(avant) }), {})
})

test('LE TEST QUI COMPTE : un tarif pousse dans le meme geste ne compte pas deux fois', () => {
  // Les deux chemins se croisent sur une date a la fois ouverte ET retarifee.
  // Sans cette garde, un seul changement ouvrirait deux lignes de journal.
  const avant = { '2026-11-07': { rate: 130, avail: 0, stop_sell: true } }
  const apres = { '2026-11-07': { rate: 160, avail: 1, stop_sell: false } }
  const r = ouverturesDeDatesTarifees(avant, apres, { gestes: G(avant), dejaPousses: { '2026-11-07': 16000 } })
  assert.deepEqual(r, {}, 'la poussee de tarif le journalise deja')
})

test('pas de ligne AVANT vaut FERMEE, jamais « inconnue »', () => {
  // Meme regle que runFullSync et que l'amorcage : l'absence de memoire
  // d'intention vaut `availability: 0`. Une date neuve qui s'ouvre avec un
  // prix EST une date qui s'affiche.
  const r = ouverturesDeDatesTarifees({},
    { '2026-12-24': { rate: 200, avail: 1, stop_sell: false } },
    { gestes: { '2026-12-24': { avail: true } } })
  assert.deepStrictEqual(r, { '2026-12-24': { cents: 20000, flux: ['availability'] } })
})

test('LE TEST QUI COMPTE : sans prix du jour NI base_price, rien n est affiche', () => {
  // ⚠ MEME REGLE QUE runFullSync, MOT POUR MOT : sans tarif, il FERME la date.
  // Les deux biens de Bagneres ont `base_price` a null — journaliser un prix
  // ici inventerait un affichage qui n'a pas eu lieu.
  const avant = { '2026-11-06': { rate: null, avail: 0, stop_sell: true } }
  const apres = { '2026-11-06': { rate: null, avail: 1, stop_sell: false } }
  assert.deepEqual(ouverturesDeDatesTarifees(avant, apres, { gestes: G(avant), basePrice: null }), {})
  assert.deepEqual(ouverturesDeDatesTarifees(avant, apres, { gestes: G(avant), basePrice: 0 }), {})
  // Avec un prix de base, en revanche, c'est lui qui part aux plateformes.
  assert.deepStrictEqual(
    ouverturesDeDatesTarifees(avant, apres, { gestes: G(avant), basePrice: 95 }),
    { '2026-11-06': { cents: 9500, flux: ['availability'] } })
  // Un rate a 0 n'est pas un prix : c'est l'absence d'exception (regle du
  // full sync), donc repli sur le prix de base.
  assert.deepStrictEqual(ouverturesDeDatesTarifees(
    { '2026-11-06': { rate: 0, avail: 0, stop_sell: true } },
    { '2026-11-06': { rate: 0, avail: 1, stop_sell: false } },
    { gestes: { '2026-11-06': { avail: true } }, basePrice: 95 }),
  { '2026-11-06': { cents: 9500, flux: ['availability'] } })
})

test('le cas reel complet : 4 week-ends ouverts, 2 dates sans prix ignorees', () => {
  // Le lot du 12 septembre 2026 a 11:12 sur Coeur de vie 23, reduit a sa
  // structure : des samedis tarifes a 130 qui s'ouvrent, et des vendredis sans
  // prix qui s'ouvrent aussi. Seuls les premiers sont affiches.
  const avant = {}
  const apres = {}
  for (const d of ['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28']) {
    avant[d] = { rate: 130, avail: 0, stop_sell: true }
    apres[d] = { rate: 130, avail: 1, stop_sell: false }
  }
  for (const d of ['2026-11-06', '2026-11-13']) {
    avant[d] = { rate: null, avail: 0, stop_sell: true }
    apres[d] = { rate: null, avail: 1, stop_sell: false }
  }
  const r = ouverturesDeDatesTarifees(avant, apres, { gestes: G(avant), basePrice: null })
  assert.deepEqual(Object.keys(r).sort(),
    ['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28'])
  assert.ok(Object.values(r).every(v => v.cents === 13000))
})

test('un prix aberrant est ecarte, comme partout ailleurs dans ce module', () => {
  const avant = { '2026-11-07': { rate: 130, avail: 0, stop_sell: true } }
  assert.deepEqual(ouverturesDeDatesTarifees(avant,
    { '2026-11-07': { rate: -5, avail: 1, stop_sell: false } }, { gestes: G(avant), basePrice: null }), {},
  'un rate negatif retombe sur base_price, absent ici')
  assert.deepEqual(ouverturesDeDatesTarifees(avant,
    { '2026-11-07': { rate: Infinity, avail: 1, stop_sell: false } }, { gestes: G(avant) }), {})
})

test('la fonction est PURE : elle ne modifie pas ses entrees', () => {
  const avant = { '2026-11-07': { rate: 130, avail: 0, stop_sell: true } }
  const apres = { '2026-11-07': { rate: 130, avail: 1, stop_sell: false } }
  const dejaPousses = {}
  const copieAvant = JSON.stringify(avant)
  const copieApres = JSON.stringify(apres)
  ouverturesDeDatesTarifees(avant, apres, { gestes: G(avant), dejaPousses })
  assert.equal(JSON.stringify(avant), copieAvant)
  assert.equal(JSON.stringify(apres), copieApres)
  assert.deepEqual(dejaPousses, {})
  assert.deepStrictEqual(ouverturesDeDatesTarifees(null, null, {}), {})
})

// ─── LA COMPOSITION FINALE : CHAQUE ORIGINE CONTRE SON FLUX ──────────────────
// LE DEFAUT QU'ILS EMPECHENT : une ligne de journal pour une nuit qui est
// restee FERMEE chez le provider. C'est le pire defaut possible ici — il
// fausse durablement la mesure que ce journal existe pour rendre, et il ne se
// rattrape pas. La premiere version du correctif en produisait trois ; ils ont
// ete trouves en review, et AUCUN test de forme ne pouvait les voir.

test('LE TEST QUI COMPTE : availability.ok n est PAS un verdict par date', () => {
  // ⚠ LE MODE DE PANNE DU 11-12 SEPTEMBRE. Quand `nuitsOccupees` echoue, le
  // repli retire TOUTES les ouvertures de la poussee mais laisse partir les
  // fermetures — et `pousserAri` repose alors `availability.ok = true` parce
  // que l'appel HTTP a abouti. La date retiree serait journalisee comme
  // affichee alors qu'elle est restee fermee chez Channex.
  const ouvertures = { '2026-11-07': { cents: 13000, flux: ['availability'] } }
  const ok = { availability: { ok: true }, restrictions: { ok: true } }

  // L'ouverture a ete RETIREE de la poussee : elle n'est pas dans availEnvoyees.
  assert.deepStrictEqual(
    nuitsAJournaliser({ ouvertures, resultats: ok, availEnvoyees: { '2026-11-08': 0 } }),
    {}, 'une ouverture qui n est pas partie ne se journalise pas')

  // Elle est partie, mais a stock ZERO (plafonnee : nuit deja vendue).
  assert.deepStrictEqual(
    nuitsAJournaliser({ ouvertures, resultats: ok, availEnvoyees: { '2026-11-07': 0 } }),
    {}, 'poussee a stock zero = toujours invendable')

  // Elle est partie, ouverte : la, et seulement la, on journalise.
  assert.deepStrictEqual(
    nuitsAJournaliser({ ouvertures, resultats: ok, availEnvoyees: { '2026-11-07': 1 } }),
    { '2026-11-07': 13000 })

  // Et sans la liste de ce qui est parti, on ne suppose pas.
  assert.deepStrictEqual(nuitsAJournaliser({ ouvertures, resultats: ok }), {})
})

test('LE TEST QUI COMPTE : une levee de stop_sell se valide contre /restrictions', () => {
  // ⚠ DEUX ERREURS SYMETRIQUES RELEVEES EN REVIEW. Une date `avail: 1` fermee
  // par « stop vente » que l'hote rouvre part par /restrictions, pas par
  // /availability. Classer par lot produisait :
  //   - un faux NEGATIF : sans geste sur `avail`, `availability` n'est jamais
  //     pose, donc rien n'etait journalise — le defaut d'origine, intact ;
  //   - un faux POSITIF : si /restrictions echoue mais que /availability
  //     reussit pour une AUTRE date, celle-ci etait journalisee alors qu'elle
  //     reste en stop_sell chez le provider.
  const ouvertures = { '2026-11-07': { cents: 13000, flux: ['restrictions'] } }

  // /restrictions a abouti : journalisee, sans rien exiger d availability.
  assert.deepStrictEqual(
    nuitsAJournaliser({ ouvertures, resultats: { restrictions: { ok: true } } }),
    { '2026-11-07': 13000 }, 'aucune poussee de dispo n est exigee')

  // /restrictions a echoue pendant que /availability reussissait ailleurs.
  assert.deepStrictEqual(
    nuitsAJournaliser({
      ouvertures,
      resultats: { restrictions: { ok: false }, availability: { ok: true } },
      availEnvoyees: { '2026-11-08': 1 }
    }), {}, 'le succes d un AUTRE flux ne vaut pas preuve')
})

test('un geste qui touche les DEUX flux exige les deux', () => {
  const ouvertures = { '2026-11-07': { cents: 13000, flux: ['availability', 'restrictions'] } }
  const envoyees = { '2026-11-07': 1 }
  assert.deepStrictEqual(nuitsAJournaliser({ ouvertures,
    resultats: { availability: { ok: true }, restrictions: { ok: false } },
    availEnvoyees: envoyees }), {})
  assert.deepStrictEqual(nuitsAJournaliser({ ouvertures,
    resultats: { availability: { ok: false }, restrictions: { ok: true } },
    availEnvoyees: envoyees }), {})
  assert.deepStrictEqual(nuitsAJournaliser({ ouvertures,
    resultats: { availability: { ok: true }, restrictions: { ok: true } },
    availEnvoyees: envoyees }), { '2026-11-07': 13000 })
})

test('les tarifs pousses restent conditionnes a /restrictions — aucune regression', () => {
  const prixPousses = { '2026-11-07': 16000 }
  assert.deepStrictEqual(
    nuitsAJournaliser({ prixPousses, resultats: { restrictions: { ok: true } } }),
    { '2026-11-07': 16000 })
  assert.deepStrictEqual(
    nuitsAJournaliser({ prixPousses, resultats: { restrictions: { ok: false },
      availability: { ok: true } }, availEnvoyees: { '2026-11-07': 1 } }),
    {}, 'une poussee de dispo ne prouve rien sur le tarif')
  assert.deepStrictEqual(nuitsAJournaliser({ prixPousses, resultats: {} }), {})
})

test('LE TEST QUI COMPTE : sans geste de disponibilite, aucune ouverture', () => {
  // ⚠ LE CALENDRIER MOBILE POUSSE UN SEGMENT PAR PARAMETRE sur la meme plage.
  // Regler « sejour minimum 2 » sur octobre-novembre touche ~60 dates, dont
  // beaucoup sans ligne en base : `etatAvant` absent valait « fermee », l objet
  // neuf n avait ni `stop_sell` ni `avail` donc passait pour « ouvert », et le
  // prix de base etait journalise. Soixante lignes « prix affiche » fabriquees
  // pour des nuits que personne ne peut reserver.
  const apres = {
    '2026-10-03': { property_id: 'p', date: '2026-10-03', min_stay_arrival: 2 },
    '2026-10-04': { property_id: 'p', date: '2026-10-04', min_stay_arrival: 2 }
  }
  assert.deepStrictEqual(
    ouverturesDeDatesTarifees({}, apres, { gestes: {}, basePrice: 95 }), {},
    'aucun geste de disponibilite : rien ne devient affiche')

  // Le meme lot, mais l hote ouvre VRAIMENT le 3 : lui seul est retenu.
  const r = ouverturesDeDatesTarifees({}, {
    ...apres,
    '2026-10-03': { property_id: 'p', date: '2026-10-03', min_stay_arrival: 2, avail: 1 }
  }, { gestes: { '2026-10-03': { avail: true } }, basePrice: 95 })
  assert.deepStrictEqual(Object.keys(r), ['2026-10-03'])
  assert.equal(r['2026-10-03'].cents, 9500)
})

test('LE TEST QUI COMPTE : sous le plancher, la date part FERMEE — rien a journaliser', () => {
  // ⚠ DESACCORD AVEC runFullSync RELEVE EN REVIEW. Le full sync FERME toute
  // date dont le tarif est sous `prix_minimum` et ne pousse aucun prix. Sans
  // ce test, le journal aurait inscrit 8 EUR pendant que le cycle suivant
  // fermait la meme nuit : les deux points de capture se seraient contredits.
  const avant = { '2026-11-07': { rate: 8, avail: 0, stop_sell: true } }
  const apres = { '2026-11-07': { rate: 8, avail: 1, stop_sell: false } }
  const gestes = { '2026-11-07': { avail: true } }
  assert.deepStrictEqual(
    ouverturesDeDatesTarifees(avant, apres, { gestes, bien: { prix_minimum: 1000 } }), {},
    '8 EUR sous un plancher de 10 EUR : la date sera fermee, rien n est affiche')
  // Au-dessus du plancher, elle passe.
  assert.equal(
    ouverturesDeDatesTarifees(avant,
      { '2026-11-07': { rate: 15, avail: 1, stop_sell: false } },
      { gestes, bien: { prix_minimum: 1000 } })['2026-11-07'].cents, 1500)
})

test('« ouverte » se lit sans comparaison stricte (regle 4)', () => {
  // `etatApres` melange des lignes relues en base (Postgres rend un nombre) et
  // des valeurs venues du corps de la requete, qui n est pas type. Un
  // `avail: "0"` echappait a `=== 0` et faisait passer une date fermee pour
  // ouverte.
  assert.equal(estOuverte({ avail: 0 }), false)
  assert.equal(estOuverte({ avail: '0' }), false)
  assert.equal(estOuverte({ stop_sell: true }), false)
  assert.equal(estOuverte({ stop_sell: 'true' }), false)
  assert.equal(estOuverte({ avail: 1 }), true)
  assert.equal(estOuverte({ avail: null }), true, 'null = jamais pousse, pas ferme')
  assert.equal(estOuverte({}), true)
  assert.equal(estOuverte(null), false)

  const r = ouverturesDeDatesTarifees(
    { '2026-11-07': { rate: 130, avail: 0, stop_sell: true } },
    { '2026-11-07': { rate: 130, avail: '0', stop_sell: false } },
    { gestes: { '2026-11-07': { avail: true } } })
  assert.deepStrictEqual(r, {}, 'un stock a zero en CHAINE reste un stock a zero')
})
