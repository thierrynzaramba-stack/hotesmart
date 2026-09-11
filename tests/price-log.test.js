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
    from (table) {
      assert.equal(table, 'price_display_log', 'le writer ne touche que sa table')
      return requete()
    }
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

test('la source est verrouillee sur host|engine', async () => {
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
  assert.ok(/if \(!obj\.stop_sell\) prixParNuitFs\[iso\] = rateCents/.test(fullsync),
    'le full sync exclut les nuits fermees')

  const calendrier = lireSrc('api/calendar.js')
  assert.ok(/seg\.stop_sell === true \|\| seg\.avail === 0.*delete prixParNuit/s.test(calendrier),
    'le calendrier retire les nuits que l hote ferme dans le meme geste')
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
