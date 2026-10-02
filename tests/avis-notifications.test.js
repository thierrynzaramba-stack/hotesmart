// tests/avis-notifications.test.js
// Lot 6 du chantier avis (spec §10) — lib/avis/notifications.js, son
// declenchement dans api/avis.js, et l'etape du cron.
//
// Ce qui compte : une notification par sejour, une relance par palier, jamais
// deux ; une requete bornee, pas un balayage ; et rien ne leve.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { prevenirHote, relancerEvaluations, marqueurPrestataire, marqueurRelance } = require('../lib/avis/notifications')

const JOUR = 86400000
const MAINTENANT = Date.parse('2026-10-02T08:00:00Z')

// Un double : `agent_tasks` (lecture par marqueur, insertion), `guest_evaluations`
// (lecture avec les filtres de la relance), `properties` (noms).
function base ({ taches = [], evaluations = [], biens = [], panne = null } = {}) {
  const etat = { taches: taches.map(t => ({ ...t })), requetes: [], inserts: [] }
  function from (table) {
    const q = { table, f: {}, dans: {}, gt: null, lte: null, limite: null, op: 'select' }
    etat.requetes.push(q)
    const executer = () => {
      if (panne === table) return { data: null, error: { message: 'panne' } }
      if (table === 'agent_tasks' && q.op === 'insert') {
        etat.inserts.push(q.ligne); etat.taches.push(q.ligne); return { data: null, error: null }
      }
      if (table === 'agent_tasks') {
        let r = etat.taches.filter(t => Object.entries(q.f).every(([c, v]) => t[c] === v))
        if (q.dans.guest_message) r = r.filter(t => q.dans.guest_message.includes(t.guest_message))
        return { data: r, error: null }
      }
      if (table === 'guest_evaluations') {
        let r = evaluations.filter(e => (!q.dans.status || q.dans.status.includes(e.status))
          && (!q.gt || e.deadline_at > q.gt) && (!q.lte || e.deadline_at <= q.lte))
        if (q.limite) r = r.slice(0, q.limite)
        return { data: r, error: null }
      }
      if (table === 'properties') return { data: biens, error: null }
      return { data: [], error: null }
    }
    const c = {
      select () { return c }, eq (k, v) { q.f[k] = v; return c }, in (k, v) { q.dans[k] = v; return c },
      gt (k, v) { q.gt = v; return c }, lte (k, v) { q.lte = v; return c },
      order () { return c }, limit (n) { q.limite = n; return c },
      insert (ligne) { q.op = 'insert'; q.ligne = ligne; return c },
      maybeSingle: async () => { const r = executer(); return { data: (r.data || [])[0] || null, error: r.error } },
      then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) },
    }
    return c
  }
  return { etat, sb: { from } }
}
const envois = () => { const e = []; return { e, envoyer: async (x) => { e.push(x) } } }

const EVAL = { user_id: 'compte-1', booking_uid: 'BK-1', property_id_ref: 'ref-1', deadline_at: new Date(MAINTENANT + 4 * JOUR).toISOString() }

// ─── Prévenir l'hôte ─────────────────────────────────────────────────────────
test('la prestataire a rempli : une tâche et un envoi, avec son prénom et le bien', async () => {
  const { etat, sb } = base()
  const { e, envoyer } = envois()
  assert.strictEqual(await prevenirHote(sb, { evaluation: EVAL, prenomPrestataire: 'Regina', nomBien: 'Studio', deps: { envoyer } }), true)
  assert.strictEqual(etat.inserts.length, 1)
  const t = etat.inserts[0]
  assert.strictEqual(t.guest_message, marqueurPrestataire('BK-1'))
  assert.strictEqual(t.book_id, 'BK-1')
  assert.match(t.summary, /Regina a rempli sa part de l’évaluation du voyageur \(Studio\)/)
  assert.match(t.summary, /page Avis/)
  assert.strictEqual(e.length, 1)
  assert.strictEqual(e[0].type, 'intervention')
})

test('LE TEST QUI COMPTE : une seule notification par séjour', async () => {
  const { etat, sb } = base()
  const { e, envoyer } = envois()
  await prevenirHote(sb, { evaluation: EVAL, prenomPrestataire: 'Regina', deps: { envoyer } })
  assert.strictEqual(await prevenirHote(sb, { evaluation: EVAL, prenomPrestataire: 'Regina', deps: { envoyer } }), false)
  assert.strictEqual(etat.inserts.length, 1)
  assert.strictEqual(e.length, 1)
})

test('un envoi qui lève ne casse rien, la tâche reste', async () => {
  const { etat, sb } = base()
  const r = await prevenirHote(sb, { evaluation: EVAL, deps: { envoyer: async () => { throw new Error('SMS KO') } } })
  assert.strictEqual(r, true)
  assert.strictEqual(etat.inserts.length, 1)
})

test('une évaluation incomplète ou une panne : rien, et rien ne lève', async () => {
  const { sb } = base()
  assert.strictEqual(await prevenirHote(sb, { evaluation: { user_id: 'x' } }), false)
  const { sb: sbPanne } = base({ panne: 'agent_tasks' })
  assert.strictEqual(await prevenirHote(sbPanne, { evaluation: EVAL, deps: { envoyer: async () => {} } }), false)
})

// ─── Les relances ────────────────────────────────────────────────────────────
test('J-5 et J-1 selon l’échéance, une tâche chacune', async () => {
  const evaluations = [
    { ...EVAL, booking_uid: 'BK-5', status: 'a_remplir', deadline_at: new Date(MAINTENANT + 4 * JOUR).toISOString() },
    { ...EVAL, booking_uid: 'BK-1', status: 'a_valider', deadline_at: new Date(MAINTENANT + 0.5 * JOUR).toISOString() },
  ]
  const { etat, sb } = base({ evaluations, biens: [{ user_id: 'compte-1', provider_property_id: 'ref-1', name: 'Studio' }] })
  const { e, envoyer } = envois()
  const bilan = await relancerEvaluations(sb, { maintenant: MAINTENANT, deps: { envoyer } })
  assert.deepStrictEqual(bilan, { lues: 2, relancees: 2, erreurs: 0 })
  const marqueurs = etat.inserts.map(t => t.guest_message).sort()
  assert.deepStrictEqual(marqueurs, [marqueurRelance('J-1', 'BK-1'), marqueurRelance('J-5', 'BK-5')].sort())
  assert.match(etat.inserts.find(t => t.book_id === 'BK-1').summary, /Dernier jour.*\(Studio\)/)
  assert.strictEqual(e.length, 2)
})

test('LE TEST QUI COMPTE : un passage suivant ne relance PAS deux fois — et lit les marqueurs en UNE requête', async () => {
  const evaluations = [{ ...EVAL, status: 'a_remplir' }]
  const { etat, sb } = base({ evaluations })
  const { e, envoyer } = envois()
  await relancerEvaluations(sb, { maintenant: MAINTENANT, deps: { envoyer } })
  const avant = etat.requetes.length
  const bilan = await relancerEvaluations(sb, { maintenant: MAINTENANT, deps: { envoyer } })
  assert.strictEqual(bilan.relancees, 0)
  assert.strictEqual(e.length, 1)
  assert.strictEqual(etat.requetes.length - avant, 2, 'une lecture des évaluations, une des marqueurs, rien d’autre')
})

test('la requête est BORNÉE : statuts en attente, fenêtre de cinq jours, plafond', async () => {
  const { etat, sb } = base()
  await relancerEvaluations(sb, { maintenant: MAINTENANT })
  const q = etat.requetes.find(r => r.table === 'guest_evaluations')
  assert.deepStrictEqual(q.dans.status, ['a_remplir', 'soumise_prestataire', 'a_valider', 'echec_publication'])
  assert.strictEqual(q.gt, new Date(MAINTENANT).toISOString(), 'pas d’échéance passée')
  assert.strictEqual(q.lte, new Date(MAINTENANT + 5 * JOUR).toISOString())
  assert.strictEqual(q.limite, 500, 'la lecture est bornee')
})

test('une panne de lecture est comptée, pas levée', async () => {
  const { sb } = base({ panne: 'guest_evaluations' })
  const bilan = await relancerEvaluations(sb, { maintenant: MAINTENANT })
  assert.strictEqual(bilan.erreurs, 1)
})

// ─── Le déclenchement et le branchement ──────────────────────────────────────
test('api/avis.js prévient l’hôte quand la prestataire a fini et que l’évaluation lui revient', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'avis.js'), 'utf8')
  assert.match(api, /if \(role === 'prestataire' && r\.completRole && !r\.decision\.peutPublier\) await avertirHote\(\)/)
  assert.match(api, /if \(role !== 'prestataire'\) return/)
})

test('le cron appelle les relances, avant la distribution des changements', () => {
  const cron = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron.js'), 'utf8')
  const relances = cron.indexOf("chrono.mesure('relances_avis', () => relancerEvaluations(supabase))")
  const dispatch = cron.indexOf("chrono.mesure('dispatch_changements'")
  assert.ok(relances > 0, 'étape présente')
  assert.ok(relances < dispatch, 'avant le dispatch, le poste le plus lourd')
  assert.match(cron, /const \{ relancerEvaluations \} = require\('\.\.\/lib\/avis\/notifications'\)/)
})

test('le lien direct `/avis?evaluer=` ouvre la fenêtre par le bus', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'avis.html'), 'utf8')
  assert.match(page, /get\('evaluer'\)/)
  assert.match(page, /await hsBus\.ouvrir\('avis\.evaluer', \{ booking_uid: aEvaluer \}\)/)
})

test('LE TEST QUI COMPTE : la tâche ne s’affiche JAMAIS comme une réponse à envoyer au voyageur', async () => {
  // `pending_validation` = « Réponse générée — à valider » + « Valider et envoyer »
  // dans la conversation du voyageur. `pending` = le résumé, « Ignorer / Traité ».
  const { etat, sb } = base({ evaluations: [{ ...EVAL, status: 'a_remplir' }] })
  await prevenirHote(sb, { evaluation: EVAL, deps: { envoyer: async () => {} } })
  await relancerEvaluations(sb, { maintenant: MAINTENANT, deps: { envoyer: async () => {} } })
  assert.ok(etat.inserts.length >= 2)
  for (const t of etat.inserts) assert.strictEqual(t.status, 'pending')
})

test('le J-1 donne l’heure : une échéance à 2 h ferme le jour même', async () => {
  const deadline = new Date(MAINTENANT + 0.5 * JOUR).toISOString()
  const { etat, sb } = base({ evaluations: [{ ...EVAL, status: 'a_valider', deadline_at: deadline }] })
  await relancerEvaluations(sb, { maintenant: MAINTENANT, deps: { envoyer: async () => {} } })
  assert.match(etat.inserts[0].summary, /avant le .* à \d\d h \d\d/)
})

test('LE TEST QUI COMPTE : 20 ENVOIS par passage, comptés APRÈS avoir écarté les déjà relancées', async () => {
  // Vingt évaluations déjà relancées bouchaient la fenêtre : la 21e n'était jamais relancée.
  const evaluations = Array.from({ length: 25 }, (_, i) => ({ ...EVAL, booking_uid: 'BK-' + i, status: 'a_remplir',
    deadline_at: new Date(MAINTENANT + (2 + i / 100) * JOUR).toISOString() }))
  const taches = evaluations.slice(0, 20).map(e => ({ user_id: 'compte-1', guest_message: marqueurRelance('J-5', e.booking_uid), book_id: e.booking_uid }))
  const { etat, sb } = base({ evaluations, taches })
  const b1 = await relancerEvaluations(sb, { maintenant: MAINTENANT, deps: { envoyer: async () => {} } })
  assert.strictEqual(b1.relancees, 5, 'les cinq restantes partent, malgré les vingt déjà faites')
  const sb2 = base({ evaluations: Array.from({ length: 30 }, (_, i) => ({ ...EVAL, booking_uid: 'N-' + i, status: 'a_remplir' })) }).sb
  const b2 = await relancerEvaluations(sb2, { maintenant: MAINTENANT, deps: { envoyer: async () => {} } })
  assert.strictEqual(b2.relancees, 20, 'jamais plus de vingt envois par passage')
  void etat
})

test('`seulement` borne la relance à des séjours donnés (scripts de preuve)', async () => {
  const { etat, sb } = base()
  await relancerEvaluations(sb, { maintenant: MAINTENANT, seulement: ['BK-X'] })
  const q = etat.requetes.find(r => r.table === 'guest_evaluations')
  assert.deepStrictEqual(q.dans.booking_uid, ['BK-X'])
})

test('la tâche de l’hôte porte un titre neutre, pas le prénom de la prestataire', async () => {
  const { etat, sb } = base()
  await prevenirHote(sb, { evaluation: EVAL, prenomPrestataire: 'Regina', deps: { envoyer: async () => {} } })
  assert.strictEqual(etat.inserts[0].guest_name, 'Évaluation du voyageur')
})
