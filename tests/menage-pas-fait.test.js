// tests/menage-pas-fait.test.js — PWA lot 4 : l'hôte prévenu d'un ménage pas
// fait 30 minutes avant l'heure d'arrivée du logement.
// Spec : docs/specs/spec-pwa-lot4-menage-pas-fait.md · KB : docs/kb/menage-pas-fait.md.
//
// ⚠ CES TESTS INJECTENT LE TEMPS (`maintenant`) : leurs dates sont FIGÉES, par
// la règle du dépôt. Ils tiennent donc à toute horloge.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')

const { prevenirMenagesPasFaits, minutesDeLHeure, horlogeDeParis, MAX_PAR_CYCLE } = require('../lib/cleaning/menage-pas-fait')
const ev = require('../lib/notifications/evenements-menages')

const A = 'compte-a'
const B = 'compte-b'
const BULLE = '209413'
const COEUR = '169567'
const REGINA = 'presta-regina'

// Hiver (UTC+1) : 14:35Z = 15:35 à Paris. Été (UTC+2) : 13:35Z = 15:35 à Paris.
const HIVER = '2026-12-10'
const aParis = (jour, hhmm, decalage = 1) => {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(Number(jour.slice(0, 4)), Number(jour.slice(5, 7)) - 1, Number(jour.slice(8, 10)), h - decalage, m))
}

// ─── Le faux Supabase : filtres, tri, limite, curseur, index unique ─────────

function faux (tables, { pannes = {} } = {}) {
  const requetes = []
  let suite = 0
  return {
    requetes,
    tables,
    from (table) {
      const filtres = []
      let mode = 'select'
      let charge = null
      let tri = null
      let limite = null
      const ok = (l) => filtres.every(f => f(l))
      const val = (l, c) => {
        const m = /^snapshot->>(\w+)$/.exec(c)
        return m ? (l.snapshot || {})[m[1]] : l[c]
      }
      const q = {
        select () { return q },
        eq (c, v) { filtres.push(l => String(val(l, c)) === String(v)); return q },
        neq (c, v) { filtres.push(l => String(val(l, c)) !== String(v)); return q },
        in (c, vs) { const s = new Set(vs.map(String)); filtres.push(l => s.has(String(val(l, c)))); return q },
        gte (c, v) { filtres.push(l => String(val(l, c)) >= String(v)); return q },
        lte (c, v) { filtres.push(l => String(val(l, c)) <= String(v)); return q },
        gt (c, v) { filtres.push(l => String(val(l, c)) > String(v)); return q },
        order (c, o = {}) { tri = { c, asc: o.ascending !== false }; return q },
        limit (n) { limite = n; return q },
        insert (row) { mode = 'insert'; charge = row; return q },
        delete () { mode = 'delete'; return q },
        then (res, rej) {
          requetes.push({ table, mode })
          const lignes = tables[table] = tables[table] || []
          if (pannes[table] && pannes[table](mode)) return Promise.resolve({ data: null, error: { message: `panne ${table}` } }).then(res, rej)
          if (mode === 'insert') {
            const doublon = table === 'message_sent_log' && lignes.some(l =>
              l.user_id === charge.user_id && l.booking_id === charge.booking_id && l.template_id === charge.template_id)
            if (doublon) return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate' } }).then(res, rej)
            lignes.push({ id: `ins-${++suite}`, ...charge })
            return Promise.resolve({ data: null, error: null }).then(res, rej)
          }
          if (mode === 'delete') {
            tables[table] = lignes.filter(l => !ok(l))
            return Promise.resolve({ data: null, error: null }).then(res, rej)
          }
          let r = lignes.filter(ok)
          if (tri) r = [...r].sort((x, y) => (String(x[tri.c]) < String(y[tri.c]) ? -1 : String(x[tri.c]) > String(y[tri.c]) ? 1 : 0) * (tri.asc ? 1 : -1))
          if (limite != null) r = r.slice(0, limite)
          return Promise.resolve({ data: r, error: null }).then(res, rej)
        }
      }
      return q
    }
  }
}

let nId = 0
const resa = (o = {}) => ({
  id: `s-${String(++nId).padStart(6, '0')}`, user_id: A, property_id: BULLE, booking_id: `b-${nId}`,
  snapshot: { provider: 'channex', status: 'new', arrival: HIVER, departure: '2026-12-13', ...(o.snapshot || {}) },
  ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'snapshot'))
})
const bien = (o = {}) => ({ id: `uuid-${o.provider_property_id || BULLE}-${o.user_id || A}`, user_id: A, name: 'La bulle',
  provider_property_id: BULLE, checkin_time: '16:00', archive_le: null, ...o })
const menage = (o = {}) => ({ id: `m-${++nId}`, user_id: A, property_id: BULLE, booking_id: 'b-avant', departure_date: HIVER,
  status: 'accepted', provider_id: REGINA, ...o })

function base (o = {}) {
  return {
    bookings_snapshot: o.resas || [resa()],
    properties: o.biens || [bien()],
    menages: o.menages || [menage()],
    menage_done: o.faits || [],
    profiles: o.profils || [{ id: REGINA, first_name: 'Régina' }],
    message_sent_log: o.memoires || []
  }
}

function lancer (tables, maintenant, { pannes, retour } = {}) {
  const db = faux(tables, { pannes })
  const envois = []
  const notifier = async (o) => { envois.push(o); return retour || { ok: true, destinataires: 1, push: 1, emails: 0, sms: 0 } }
  const results = { errors: [] }
  return prevenirMenagesPasFaits(results, { maintenant, db, deps: { envoi: { notifier } } })
    .then(bilan => ({ bilan, envois, results, db }))
}

// ─── La règle ────────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : 16:00 au logement, 15:35 à Paris, ménage pas fait — l\'hôte est prévenu, une fois', async () => {
  const tables = base()
  const { bilan, envois, results } = await lancer(tables, aParis(HIVER, '15:35'))
  assert.strictEqual(envois.length, 1, JSON.stringify(bilan))
  const e = envois[0]
  assert.strictEqual(e.compte, A)
  assert.strictEqual(e.code, 'menage_pas_fait')
  assert.deepStrictEqual(e.donnees, { bien: 'La bulle', heure: '16:00', prestataire: 'Régina', sans_personne: false })
  assert.deepStrictEqual(e.sejour, { arrivee: HIVER, depart: HIVER }, 'l\'arrivée du jour : elle passe les heures calmes')
  assert.strictEqual(e.sujet, `menage:${BULLE}:${HIVER}`, 'le sujet du ménage')
  assert.strictEqual(e.chemin, '/menages')
  assert.deepStrictEqual(results.errors, [])
  assert.ok(tables.message_sent_log.some(l => l.user_id === A && l.booking_id === `notif:menage_pas_fait:${BULLE}:${HIVER}`
    && l.template_id === ev.SENTINELLE_PAS_FAIT), 'la mémoire est posée')

  const second = await lancer(tables, aParis(HIVER, '15:40'))
  assert.strictEqual(second.envois.length, 0, 'une fois')
  assert.strictEqual(second.bilan.deja, 1)
  assert.ok(!second.db.requetes.some(r => r.table === 'menages'), 'tranchée : on ne relit même plus son ménage')
})

test('l\'échéance : 15:29 rien, 15:30 l\'alerte — et le cycle d\'avant ne lit pas les ménages', async () => {
  const avant = await lancer(base(), aParis(HIVER, '15:29'))
  assert.strictEqual(avant.envois.length, 0)
  assert.strictEqual(avant.bilan.dues, 0)
  assert.deepStrictEqual(avant.db.requetes.map(r => r.table), ['bookings_snapshot', 'properties'], 'deux lectures, pas plus')
  const pile = await lancer(base(), aParis(HIVER, '15:30'))
  assert.strictEqual(pile.envois.length, 1)
})

test('L\'HEURE DE LA PENDULE, ÉTÉ COMME HIVER : 15:30 à Paris, quel que soit l\'écart à UTC', async () => {
  const ETE = '2027-07-10'
  const t = () => base({ resas: [resa({ snapshot: { arrival: ETE } })], menages: [menage({ departure_date: ETE })] })
  assert.strictEqual((await lancer(t(), aParis(ETE, '15:29', 2))).envois.length, 0)
  assert.strictEqual((await lancer(t(), aParis(ETE, '15:30', 2))).envois.length, 1)
})

test('un jour sans arrivée coûte UNE lecture', async () => {
  const { bilan, db } = await lancer(base({ resas: [] }), aParis(HIVER, '15:35'))
  assert.strictEqual(bilan.arrivees, 0)
  assert.deepStrictEqual(db.requetes.map(r => r.table), ['bookings_snapshot'])
})

test('ménage marqué fait : rien — et la journée est tranchée, le cycle suivant ne relit rien', async () => {
  const tables = base({ faits: [{ user_id: A, property_id: BULLE, booking_id: 'b-avant', departure_date: HIVER }] })
  const { bilan, envois } = await lancer(tables, aParis(HIVER, '15:35'))
  assert.strictEqual(envois.length, 0)
  assert.strictEqual(bilan.faits, 1)
  const ensuite = await lancer(tables, aParis(HIVER, '15:40'))
  assert.strictEqual(ensuite.bilan.deja, 1)
  assert.ok(!ensuite.db.requetes.some(r => r.table === 'menages'))
})

test('Q49 : heure d\'arrivée vide ou illisible — pas d\'alerte, jamais une heure supposée', async () => {
  for (const h of [null, '', 'vers 16h', '25:00', 'midi']) {
    const { bilan, envois } = await lancer(base({ biens: [bien({ checkin_time: h })] }), aParis(HIVER, '23:00'))
    assert.strictEqual(envois.length, 0, String(h))
    assert.strictEqual(bilan.sans_heure, 1, String(h))
  }
  for (const h of ['16:00', '16:00:00', '16h', '16h00', '16 h 00', '16H']) {
    assert.strictEqual(minutesDeLHeure(h), 960, h)
  }
  assert.strictEqual(minutesDeLHeure('9:05'), 545)
  assert.strictEqual(minutesDeLHeure('16h30'), 990)
  const { envois } = await lancer(base({ biens: [bien({ checkin_time: '16h' })] }), aParis(HIVER, '15:30'))
  assert.strictEqual(envois[0].donnees.heure, '16:00', 'l\'heure dite est normalisée')
})

test('aucun ménage suivi dans HôteSmart pour ce logement : rien (l\'hôte ne suit pas ses ménages ici)', async () => {
  const tables = base({ menages: [] })
  const { bilan, envois } = await lancer(tables, aParis(HIVER, '15:35'))
  assert.strictEqual(envois.length, 0)
  assert.strictEqual(bilan.sans_menage, 1)
  const ensuite = await lancer(tables, aParis(HIVER, '15:40'))
  assert.strictEqual(ensuite.bilan.deja, 1, 'tranchée pour la journée')
  assert.ok(!ensuite.db.requetes.some(r => r.table === 'menages'), 'pas relue toutes les cinq minutes jusqu\'à minuit')
})

test('logement resté vide : c\'est le ménage du DERNIER départ qui compte, annulés exclus, jamais un ménage futur', async () => {
  const tables = base({
    menages: [
      menage({ booking_id: 'b-vieux', departure_date: '2026-12-01' }),
      menage({ booking_id: 'b-dernier', departure_date: '2026-12-07' }),
      menage({ booking_id: 'b-annule', departure_date: '2026-12-09', status: 'cancelled' }),
      menage({ booking_id: 'b-futur', departure_date: '2026-12-13' })
    ],
    faits: [{ user_id: A, property_id: BULLE, booking_id: 'b-vieux', departure_date: '2026-12-01' }]
  })
  const { envois } = await lancer(tables, aParis(HIVER, '15:35'))
  assert.strictEqual(envois.length, 1)
  assert.strictEqual(envois[0].sujet, `menage:${BULLE}:2026-12-07`, 'le ménage du 7, pas celui du 1er (fait), ni l\'annulé, ni le futur')
  assert.deepStrictEqual(envois[0].sejour, { arrivee: HIVER, depart: HIVER }, 'mais l\'arrivée, elle, est aujourd\'hui')
})

test('personne sur le ménage : on le dit', async () => {
  const { envois } = await lancer(base({ menages: [menage({ provider_id: null, status: 'unassigned' })] }), aParis(HIVER, '15:35'))
  assert.deepStrictEqual(envois[0].donnees, { bien: 'La bulle', heure: '16:00', prestataire: null, sans_personne: true })
})

test('arrivée annulée, logement archivé, arrivée d\'un autre jour : rien', async () => {
  const annulee = await lancer(base({ resas: [resa({ snapshot: { status: 'cancelled' } })] }), aParis(HIVER, '15:35'))
  assert.strictEqual(annulee.envois.length, 0)
  const archive = await lancer(base({ biens: [bien({ archive_le: '2026-11-01T00:00:00Z' })] }), aParis(HIVER, '15:35'))
  assert.strictEqual(archive.envois.length, 0)
  const demain = await lancer(base({ resas: [resa({ snapshot: { arrival: '2026-12-11' } })] }), aParis(HIVER, '15:35'))
  assert.strictEqual(demain.envois.length, 0)
})

test('ISOLATION (1) : la même référence chez un autre hôte ne prête ni son heure, ni son ménage', async () => {
  // Le ménage de B est PLUS RÉCENT que celui de A, et il est fait : lu sans le
  // compte, il serait « le dernier », et l'alerte de A se tairait.
  const tables = base({
    resas: [resa({ user_id: A })],
    biens: [bien({ user_id: B, checkin_time: '12:00' }), bien({ user_id: A, checkin_time: '18:00' })],
    menages: [menage({ user_id: A, booking_id: 'b-a', departure_date: '2026-12-09' }),
              menage({ user_id: B, booking_id: 'b-b', departure_date: HIVER })],
    faits: [{ user_id: B, property_id: BULLE, booking_id: 'b-b', departure_date: HIVER }]
  })
  const tot = await lancer(tables, aParis(HIVER, '15:35'))
  assert.strictEqual(tot.envois.length, 0, 'l\'heure de B (12:00) ne vaut pas pour A (18:00)')
  const { envois } = await lancer(tables, aParis(HIVER, '17:30'))
  assert.strictEqual(envois.length, 1, 'le ménage de B n\'est pas celui de A')
  assert.strictEqual(envois[0].compte, A)
  assert.strictEqual(envois[0].sujet, `menage:${BULLE}:2026-12-09`)
})

test('ISOLATION (2) : le « fait » d\'un autre hôte, sur la même clé, ne vaut pas pour A', async () => {
  const tables = base({
    menages: [menage({ user_id: A, booking_id: 'b-x' })],
    faits: [{ user_id: B, property_id: BULLE, booking_id: 'b-x', departure_date: HIVER }]
  })
  const { envois } = await lancer(tables, aParis(HIVER, '15:35'))
  assert.strictEqual(envois.length, 1)
})

test('DANS LE DOUTE, ON NE PRÉVIENT PAS : « fait » illisible — rien, l\'erreur se dit, et le cycle suivant reprend', async () => {
  const tables = base()
  const { envois, results, bilan } = await lancer(tables, aParis(HIVER, '15:35'), { pannes: { menage_done: () => true } })
  assert.strictEqual(envois.length, 0)
  assert.ok(results.errors.some(e => e.context === 'menage_pas_fait'), JSON.stringify(results.errors))
  assert.strictEqual(bilan.erreurs, 1)
  assert.ok(!tables.message_sent_log.length, 'rien de mémorisé')
  const reprise = await lancer(tables, aParis(HIVER, '15:40'))
  assert.strictEqual(reprise.envois.length, 1)
})

test('les arrivées illisibles : l\'erreur se dit, rien ne part, rien ne lève', async () => {
  const { envois, results, bilan } = await lancer(base(), aParis(HIVER, '15:35'), { pannes: { bookings_snapshot: () => true } })
  assert.strictEqual(envois.length, 0)
  assert.strictEqual(bilan.erreurs, 1)
  assert.strictEqual(results.errors[0].context, 'menage_pas_fait')
})

test('rien n\'est parti : la mémoire est retirée, le cycle suivant réessaie', async () => {
  const tables = base()
  const echec = await lancer(tables, aParis(HIVER, '15:35'), { retour: { ok: false, erreurs: ['brevo'] } })
  assert.strictEqual(echec.envois.length, 1)
  assert.strictEqual(echec.bilan.erreurs, 1)
  assert.ok(!tables.message_sent_log.length, 'mémoire retirée')
  const reprise = await lancer(tables, aParis(HIVER, '15:40'))
  assert.strictEqual(reprise.envois.length, 1)
  assert.strictEqual(reprise.bilan.prevenus, 1)
})

test('le plafond : au plus vingt arrivées tranchées par cycle, les plus proches d\'abord — le reste au cycle suivant', async () => {
  const n = MAX_PAR_CYCLE + 5
  const resas = []
  const biens = []
  const menages = []
  for (let i = 0; i < n; i++) {
    const ref = `ref-${String(i).padStart(2, '0')}`
    resas.push(resa({ property_id: ref }))
    // Les cinq derniers arrivent le plus tôt : ce sont eux qui passent d'abord.
    biens.push(bien({ provider_property_id: ref, name: ref, checkin_time: i >= MAX_PAR_CYCLE ? '15:00' : '16:00' }))
    menages.push(menage({ property_id: ref, booking_id: `b-${ref}` }))
  }
  const tables = base({ resas, biens, menages })
  const un = await lancer(tables, aParis(HIVER, '15:35'))
  assert.strictEqual(un.envois.length, MAX_PAR_CYCLE)
  assert.strictEqual(un.bilan.reportes, 5)
  for (let i = MAX_PAR_CYCLE; i < n; i++) {
    assert.ok(un.envois.some(e => e.sujet === `menage:ref-${i}:${HIVER}`), `ref-${i} arrive à 15:00 : il passe d'abord`)
  }
  const deux = await lancer(tables, aParis(HIVER, '15:40'))
  assert.strictEqual(deux.envois.length, 5)
  assert.strictEqual(deux.bilan.deja, MAX_PAR_CYCLE)
})

test('CURSEUR : une arrivée au-delà de la première page est lue (aucune troncature silencieuse)', async () => {
  const resas = []
  for (let i = 0; i < 520; i++) resas.push(resa({ property_id: 'autre', snapshot: { status: 'cancelled' } }))
  resas.push(resa()) // la seule active : la 521e, sur la seconde page
  const { bilan, envois } = await lancer(base({ resas }), aParis(HIVER, '15:35'))
  assert.strictEqual(bilan.arrivees, 1)
  assert.strictEqual(envois.length, 1)
})

test('horlogeDeParis : le jour et l\'heure de la pendule, minuit compris', () => {
  assert.deepStrictEqual(horlogeDeParis(aParis(HIVER, '15:35')), { jour: HIVER, minutes: 15 * 60 + 35 })
  assert.deepStrictEqual(horlogeDeParis(new Date('2026-12-10T23:30:00Z')), { jour: '2026-12-11', minutes: 30 })
})

// ─── Le texte ────────────────────────────────────────────────────────────────

test('les textes, dans les trois langues, avec et sans prestataire', () => {
  const textes = require('../lib/notifications/textes')
  assert.deepStrictEqual(textes.rediger('menage_pas_fait', 'fr', { bien: 'La bulle', heure: '16:00', prestataire: 'Régina' }),
    { titre: 'Ménage pas fait — La bulle', corps: 'Régina n’a pas marqué fait le ménage. Le voyageur arrive à 16:00.' })
  assert.strictEqual(textes.rediger('menage_pas_fait', 'fr', { bien: 'B', heure: '16:00', sans_personne: true }).corps,
    'Le ménage n’est pas marqué fait, et personne ne l’a pris. Le voyageur arrive à 16:00.')
  assert.strictEqual(textes.rediger('menage_pas_fait', 'fr', { bien: 'B', heure: '16:00' }).corps,
    'La prestataire n’a pas marqué fait le ménage. Le voyageur arrive à 16:00.')
  for (const l of ['en', 'es']) {
    for (const d of [{ prestataire: 'Régina' }, { sans_personne: true }]) {
      const t = textes.rediger('menage_pas_fait', l, { bien: 'La bulle', heure: '16:00', ...d })
      assert.ok(t.titre && t.corps && /16:00/.test(t.corps) && !/undefined|null/.test(JSON.stringify(t)), `${l}`)
    }
  }
})
