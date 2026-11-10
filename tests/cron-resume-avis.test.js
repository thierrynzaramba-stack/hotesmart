// tests/cron-resume-avis.test.js — QUAND les trois chiffres de la page Avis se
// calculent (lib/cron-resume-avis.js ; spec avis-v5 §10.4).
//
// ⚠ LE CALCUL EST INJECTE (`deps.calculer`) : il a ses tests
// (tests/avis-resume.test.js). Ici on prouve le MOMENT — quel compte, quand,
// combien de lectures quand il n'y a rien a faire — et le temps est INJECTE,
// donc les dates sont figees (regle du depot).

const test = require('node:test')
const assert = require('node:assert')
const { calculerResumesDus, debutDuCreneau, MARQUEUR_CRENEAU, MARQUEUR_BIENS, MARQUEUR_SUIVI } = require('../lib/cron-resume-avis')

const iso = (s) => new Date(Date.parse(s)).toISOString()

// ─── Les créneaux ───────────────────────────────────────────────────────────
test('le dernier créneau ouvert, à l\'heure de PARIS, hiver comme été', () => {
  const cas = [
    // hiver (UTC+1)
    ['2026-11-10T05:30:00Z', '2026-11-10T05:00:00.000Z'],   // 06:30 Paris -> 06:00
    ['2026-11-10T04:59:59Z', '2026-11-09T17:00:00.000Z'],   // 05:59 Paris -> la veille 18:00
    ['2026-11-10T17:00:00Z', '2026-11-10T17:00:00.000Z'],   // 18:00 pile
    ['2026-11-10T23:30:00Z', '2026-11-10T17:00:00.000Z'],   // 00:30 Paris le 11 -> 18:00 le 10
    // ete (UTC+2)
    ['2026-07-10T04:30:00Z', '2026-07-10T04:00:00.000Z'],   // 06:30 Paris
    ['2026-07-10T16:10:00Z', '2026-07-10T16:00:00.000Z'],   // 18:10 Paris
    // jours de changement d'heure
    ['2026-03-29T04:30:00Z', '2026-03-29T04:00:00.000Z'],   // passage a l'ete, 06:30 CEST
    ['2026-10-25T05:30:00Z', '2026-10-25T05:00:00.000Z']    // passage a l'hiver, 06:30 CET
  ]
  for (const [instant, attendu] of cas) {
    assert.strictEqual(new Date(debutDuCreneau(Date.parse(instant))).toISOString(), attendu, instant)
  }
  assert.strictEqual(debutDuCreneau(null), null)
  assert.strictEqual(debutDuCreneau(NaN), null)
})

// ─── Le double ──────────────────────────────────────────────────────────────
function fauxBase ({ biens = [], resume = [], marqueurs = {}, pannes = {} } = {}) {
  const journal = []
  const logs = Object.entries(marqueurs).map(([id, v]) => ({ id, ...v }))
  const tables = { properties: biens, resume_bien_avis: resume, cron_logs: logs }
  const cmp = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)
  return {
    journal, logs, resume, biens,
    from (table) {
      if (!tables[table]) throw new Error('faux : table inattendue ' + table)
      const a = { table, eqs: [], gts: [], gtes: [], nonNuls: [], tri: null, head: false, count: null }
      journal.push(a)
      const repondre = (limite) => {
        if (pannes[table]) return { data: null, count: null, error: pannes[table] }
        let l = tables[table].filter(r =>
          a.eqs.every(([c, v]) => r[c] === v) &&
          a.gts.every(([c, v]) => r[c] != null && cmp(r[c], v) > 0) &&
          a.gtes.every(([c, v]) => r[c] != null && Date.parse(r[c]) >= Date.parse(v)) &&
          a.nonNuls.every(c => r[c] != null))
        if (a.tri) l = [...l].sort((x, y) => cmp(x[a.tri], y[a.tri]))
        const n = l.length
        if (limite != null) l = l.slice(0, limite)
        return { data: a.head ? null : l, count: a.count === 'exact' ? n : null, error: null }
      }
      const chain = {
        select (c, o) { a.head = !!(o && o.head); a.count = o && o.count; return chain },
        eq (c, v) { a.eqs.push([c, v]); return chain },
        gt (c, v) { a.gts.push([c, v]); return chain },
        gte (c, v) { a.gtes.push([c, v]); return chain },
        not (c, op, v) { if (op !== 'is' || v !== null) throw new Error('faux : not'); a.nonNuls.push(c); return chain },
        order (c) { a.tri = c; return chain },
        range () { throw new Error('faux : range() refuse') },
        limit (n) { return Promise.resolve(repondre(n)) },
        maybeSingle: async () => { const r = repondre(); return { data: r.data ? (r.data[0] || null) : null, error: r.error } },
        upsert: async (row) => {
          a.upsert = row
          if (pannes.upsert) return { error: pannes.upsert }
          const i = logs.findIndex(x => x.id === row.id)
          if (i >= 0) logs[i] = { ...logs[i], ...row }; else logs.push({ ...row })
          return { error: null }
        },
        then (ok, ko) { return Promise.resolve(repondre()).then(ok, ko) }
      }
      return chain
    }
  }
}

const T = Date.parse('2026-11-10T05:20:00Z')        // 06:20 a Paris
const CRENEAU = '2026-11-10T05:00:00.000Z'
const AVANT = '2026-11-09T17:05:00.000Z'             // calcul du creneau precedent
const APRES = '2026-11-10T05:10:00.000Z'             // deja calcule dans ce creneau
const DIX_MIN_AVANT = '2026-11-10T05:10:00.000Z'     // dernier controle complet des biens
const B = (user, ref) => ({ id: `p-${user}-${ref}`, user_id: user, provider_property_id: ref })
const R = (user, ref, quand) => ({ user_id: user, property_id_ref: ref, periode: 'toujours', calcule_le: quand })

// Comme le vrai writer : les lignes du compte sont REMPLACEES, une par bien.
function ecrireLignes (sb, userId, quand) {
  for (let i = sb.resume.length - 1; i >= 0; i--) if (sb.resume[i].user_id === userId) sb.resume.splice(i, 1)
  for (const b of sb.biens) {
    if (b.user_id === userId && b.provider_property_id != null) sb.resume.push(R(userId, b.provider_property_id, quand))
  }
}

function calculateur (sb, comportement = {}, quand = new Date(T).toISOString()) {
  const appels = []
  return {
    appels,
    calculer: async (client, { userId }) => {
      appels.push(userId)
      const c = comportement[userId]
      if (typeof c === 'function') return c()
      if (c) return c
      ecrireLignes(sb, userId, quand)
      return { ecrit: true }
    }
  }
}

// ─── Le créneau ─────────────────────────────────────────────────────────────
test('créneau ouvert : seuls les comptes pas encore calculés depuis 06:00 le sont, puis le créneau est marqué', async () => {
  const sb = fauxBase({
    biens: [B('U1', 'R1'), B('U1', 'R2'), B('U2', 'R3'), B('U3', 'R4'), { id: 'p-sans', user_id: 'U4', provider_property_id: null }],
    resume: [R('U1', 'R1', AVANT), R('U2', 'R3', APRES)],
    marqueurs: { [MARQUEUR_CRENEAU]: { last_run: '2026-11-09T17:00:00.000Z' } }
  })
  const k = calculateur(sb)
  const results = { errors: [] }
  const bilan = await calculerResumesDus(results, { supabase: sb, now: () => T, calculer: k.calculer })
  assert.deepStrictEqual(k.appels, ['U1', 'U3'])
  assert.strictEqual(bilan.calcules, 2)
  assert.strictEqual(bilan.creneau, CRENEAU)
  assert.strictEqual(sb.logs.find(l => l.id === MARQUEUR_CRENEAU).last_run, CRENEAU)
  assert.deepStrictEqual(results.errors, [])
})

test('créneau fini et aucun bien nouveau : trois lectures, aucun calcul', async () => {
  const sb = fauxBase({
    biens: [B('U1', 'R1')],
    resume: [R('U1', 'R1', AVANT)],
    marqueurs: { [MARQUEUR_CRENEAU]: { last_run: CRENEAU }, [MARQUEUR_BIENS]: { last_run: DIX_MIN_AVANT, total_messages: 1 } }
  })
  const k = calculateur(sb)
  const bilan = await calculerResumesDus({ errors: [] }, { supabase: sb, now: () => T, calculer: k.calculer })
  assert.deepStrictEqual(k.appels, [])
  assert.strictEqual(bilan.calcules, 0)
  assert.deepStrictEqual(sb.journal.map(a => a.table), ['cron_logs', 'properties', 'cron_logs'])
  assert.strictEqual(sb.journal[1].head, true, 'les biens sont COMPTÉS, pas lus')
})

test('un créneau manqué se rattrape au tick suivant, sans fenêtre horaire', async () => {
  // 11:40 a Paris : le creneau de 06:00 n'a jamais tourne (cron en panne).
  const tard = Date.parse('2026-11-10T10:40:00Z')
  const sb = fauxBase({
    biens: [B('U1', 'R1')], resume: [R('U1', 'R1', AVANT)],
    marqueurs: { [MARQUEUR_CRENEAU]: { last_run: '2026-11-09T17:00:00.000Z' } }
  })
  const k = calculateur(sb)
  await calculerResumesDus({ errors: [] }, { supabase: sb, now: () => tard, calculer: k.calculer })
  assert.deepStrictEqual(k.appels, ['U1'])
})

test('le budget arrête le passage SANS marquer le créneau : le tick suivant finit', async () => {
  let t = T
  const sb = fauxBase({ biens: [B('U1', 'R1'), B('U2', 'R2'), B('U3', 'R3')] })
  const k = calculateur(sb)
  const calculer = async (c, o) => { t += 6000; return k.calculer(c, o) }   // 6 s par compte
  const bilan = await calculerResumesDus({ errors: [] }, { supabase: sb, now: () => t, calculer })
  assert.deepStrictEqual(k.appels, ['U1', 'U2'])
  assert.strictEqual(bilan.budget_atteint, true)
  assert.strictEqual(sb.logs.find(l => l.id === MARQUEUR_CRENEAU), undefined)
})

test('le reste du cycle sous 25 s : aucun calcul ne commence', async () => {
  const sb = fauxBase({ biens: [B('U1', 'R1')] })
  const k = calculateur(sb)
  const bilan = await calculerResumesDus({ errors: [] }, { supabase: sb, now: () => T, resteMs: () => 20000, calculer: k.calculer })
  assert.deepStrictEqual(k.appels, [])
  assert.strictEqual(bilan.budget_atteint, true)
})

test('un compte en échec est signalé UNE fois, et le créneau est quand même marqué', async () => {
  const sb = fauxBase({ biens: [B('U1', 'R1'), B('U2', 'R2'), B('U3', 'R3')] })
  const k = calculateur(sb, {
    U1: { ecrit: false, erreur: 'avis' },
    U3: () => { throw new Error('boum') }
  })
  const results = { errors: [] }
  const bilan = await calculerResumesDus(results, { supabase: sb, now: () => T, calculer: k.calculer })
  assert.deepStrictEqual(k.appels, ['U1', 'U2', 'U3'])
  assert.strictEqual(bilan.echecs, 2)
  assert.strictEqual(results.errors.length, 1)
  assert.match(results.errors[0].error, /2 compte\(s\) non calcule\(s\) : U1, U3/)
  assert.strictEqual(sb.logs.find(l => l.id === MARQUEUR_CRENEAU).last_run, CRENEAU)
})

test('« périmé » n\'est pas un échec : un calcul plus récent existe déjà', async () => {
  const sb = fauxBase({ biens: [B('U1', 'R1')] })
  // Un calcul plus recent (un geste de l'hote) a deja ecrit les lignes.
  const k = calculateur(sb, { U1: () => { ecrireLignes(sb, 'U1', new Date(T + 1000).toISOString()); return { ecrit: false, motif: 'perime' } } })
  const results = { errors: [] }
  const bilan = await calculerResumesDus(results, { supabase: sb, now: () => T, calculer: k.calculer })
  assert.strictEqual(bilan.perimes, 1)
  assert.deepStrictEqual(results.errors, [])
})

test('migration absente : une attente, pas une alerte — et rien n\'est marqué', async () => {
  // Par la fonction (le writer le dit) …
  {
    const sb = fauxBase({ biens: [B('U1', 'R1'), B('U2', 'R2')] })
    const k = calculateur(sb, { U1: { ecrit: false, erreur: 'migration_absente' } })
    const results = { errors: [] }
    const bilan = await calculerResumesDus(results, { supabase: sb, now: () => T, calculer: k.calculer })
    assert.strictEqual(bilan.skipped, 'migration_absente')
    assert.deepStrictEqual(k.appels, ['U1'], 'on n\'insiste pas compte par compte')
    assert.strictEqual(results.resumeAvisEnAttente, 'migration_absente')
    assert.deepStrictEqual(results.errors, [])
    assert.strictEqual(sb.logs.length, 0)
  }
  // … et par la table.
  {
    const sb = fauxBase({ biens: [B('U1', 'R1')], pannes: { resume_bien_avis: { code: 'PGRST205', message: 'Could not find the table' } } })
    const k = calculateur(sb)
    const results = { errors: [] }
    const bilan = await calculerResumesDus(results, { supabase: sb, now: () => T, calculer: k.calculer })
    assert.strictEqual(bilan.skipped, 'migration_absente')
    assert.deepStrictEqual(k.appels, [])
    assert.deepStrictEqual(results.errors, [])
  }
})

test('une panne de lecture est une alerte, et rien n\'est calculé', async () => {
  for (const table of ['properties', 'cron_logs']) {
    const sb = fauxBase({ biens: [B('U1', 'R1')], pannes: { [table]: { message: 'timeout' } } })
    const k = calculateur(sb)
    const results = { errors: [] }
    await calculerResumesDus(results, { supabase: sb, now: () => T, calculer: k.calculer })
    assert.deepStrictEqual(k.appels, [], table)
    assert.strictEqual(results.errors.length, 1, table)
  }
})

// ─── Le logement neuf ───────────────────────────────────────────────────────
test('un bien nouveau fait calculer SON compte au tick suivant, et seulement lui', async () => {
  const sb = fauxBase({
    biens: [B('U1', 'R1'), B('U2', 'R2'), B('U2', 'R9')],
    resume: [R('U1', 'R1', APRES), R('U2', 'R2', APRES)],
    marqueurs: { [MARQUEUR_CRENEAU]: { last_run: CRENEAU }, [MARQUEUR_BIENS]: { last_run: DIX_MIN_AVANT, total_messages: 2 } }
  })
  const k = calculateur(sb)
  const bilan = await calculerResumesDus({ errors: [] }, { supabase: sb, now: () => T, calculer: k.calculer })
  assert.deepStrictEqual(k.appels, ['U2'])
  assert.strictEqual(bilan.biens_neufs, 1)
  assert.strictEqual(sb.logs.find(l => l.id === MARQUEUR_BIENS).total_messages, 3)
})

test('premier passage après la mise en service : tous les comptes sont calculés une fois', async () => {
  const sb = fauxBase({ biens: [B('U1', 'R1'), B('U2', 'R2')] })
  const k = calculateur(sb)
  await calculerResumesDus({ errors: [] }, { supabase: sb, now: () => T, calculer: k.calculer })
  assert.deepStrictEqual(k.appels, ['U1', 'U2'], 'le contrôle des biens neufs ne refait pas ce que le créneau vient de faire')
  assert.strictEqual(sb.logs.find(l => l.id === MARQUEUR_CRENEAU).last_run, CRENEAU)
  assert.strictEqual(sb.logs.find(l => l.id === MARQUEUR_BIENS).total_messages, 2)
})

// ─── Les constats de la revue du lot ────────────────────────────────────────
test('constat 1 : un compte qui échoue LENTEMENT n\'affame pas les autres, et n\'alerte qu\'une fois par créneau', async () => {
  let t = T
  const sb = fauxBase({ biens: [B('U1', 'R1'), B('U2', 'R2'), B('U3', 'R3')] })
  const k = calculateur(sb, { U1: () => { t += 11000; return { ecrit: false, erreur: 'avis' } } })
  const passage = async () => {
    const results = { errors: [] }
    await calculerResumesDus(results, { supabase: sb, now: () => t, calculer: k.calculer })
    return results
  }
  const r1 = await passage()
  assert.deepStrictEqual(k.appels, ['U1'], 'premier tick : U1 mange le budget')
  assert.strictEqual(r1.errors.length, 1)
  assert.strictEqual(r1.resumeAvisBudgetAtteint, true)
  t += 5 * 60 * 1000
  const r2 = await passage()
  assert.deepStrictEqual(k.appels, ['U1', 'U2', 'U3'], 'tick suivant : U1 attend le créneau suivant, les autres passent')
  assert.deepStrictEqual(r2.errors, [], 'pas de seconde alerte pour U1')
  assert.strictEqual(sb.logs.find(l => l.id === MARQUEUR_CRENEAU).last_run, CRENEAU)
  // Le creneau suivant le retente.
  t = Date.parse('2026-11-10T17:05:00Z')
  await passage()
  assert.strictEqual(k.appels.filter(u => u === 'U1').length, 2)
})

test('constat 2 : une référence réécrite à nombre de biens constant est rattrapée dans l\'heure', async () => {
  const sb = fauxBase({
    biens: [B('U1', 'R1'), B('U2', 'NOUVELLE-REF')],
    resume: [R('U1', 'R1', APRES), R('U2', 'ANCIENNE-REF', APRES)],
    marqueurs: { [MARQUEUR_CRENEAU]: { last_run: CRENEAU }, [MARQUEUR_BIENS]: { last_run: DIX_MIN_AVANT, total_messages: 2 } }
  })
  const k = calculateur(sb)
  await calculerResumesDus({ errors: [] }, { supabase: sb, now: () => T, calculer: k.calculer })
  assert.deepStrictEqual(k.appels, [], 'dans l\'heure du dernier contrôle, le nombre seul décide')
  await calculerResumesDus({ errors: [] }, { supabase: sb, now: () => Date.parse(DIX_MIN_AVANT) + 3600 * 1000, calculer: k.calculer })
  assert.deepStrictEqual(k.appels, ['U2'], 'une heure après, le contrôle complet le voit')
})

test('constat 6 : un créneau pas fini deux heures après s\'alerte, une seule fois', async () => {
  const sb = fauxBase({ biens: [B('U1', 'R1')] })
  const k = calculateur(sb)
  const deuxHeuresApres = Date.parse(CRENEAU) + 2 * 3600 * 1000 + 60000
  const tick = async () => {
    const results = { errors: [] }
    await calculerResumesDus(results, { supabase: sb, now: () => deuxHeuresApres, resteMs: () => 10000, calculer: k.calculer })
    return results
  }
  const r1 = await tick()
  assert.strictEqual(r1.errors.length, 1)
  assert.match(r1.errors[0].error, /creneau de 06:00 pas fini/)
  assert.deepStrictEqual((await tick()).errors, [], 'une fois par créneau')
  assert.deepStrictEqual(k.appels, [])
})

test('la mémoire du créneau illisible : on ne travaille pas, on le dit', async () => {
  const sb = fauxBase({ biens: [B('U1', 'R1')] })
  const lire = sb.from.bind(sb)
  let n = 0
  sb.from = (t) => {
    const c = lire(t)
    if (t !== 'cron_logs') return c
    const ms = c.maybeSingle
    c.maybeSingle = async () => (++n === 2 ? { data: null, error: { message: 'timeout' } } : ms())
    return c
  }
  const k = calculateur(sb)
  const results = { errors: [] }
  const bilan = await calculerResumesDus(results, { supabase: sb, now: () => T, calculer: k.calculer })
  assert.strictEqual(bilan.skipped, 'suivi_illisible')
  assert.deepStrictEqual(k.appels, [])
  assert.strictEqual(results.errors.length, 1)
})
