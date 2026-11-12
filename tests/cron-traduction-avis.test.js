// tests/cron-traduction-avis.test.js — QUAND et COMBIEN la tâche
// `traduction_avis` traduit (lib/cron-traduction-avis.js ; spec avis-v5
// spec-traduction-avis.md §3.6, plafonds décidés par Thierry, Q5 = A).
//
// ⚠ LA TRADUCTION EST INJECTÉE (`deps.traduire`) : le writer a ses tests
// (tests/avis-traduction.test.js). Ici on prouve le COÛT — combien d'appels,
// quand on s'arrête, et ZÉRO appel quand rien n'est à traduire. Le temps est
// injecté, donc les dates sont figées (règle du dépôt).

const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../lib/cron-traduction-avis')

const T0 = Date.parse('2026-11-11T09:00:00Z')            // 10:00 à Paris

function fauxBase ({ marqueur = null, file = [], pannes = {} } = {}) {
  const journal = { lectures: 0, rpc: [], ecrits: [], marqueurs: [] }
  return {
    journal,
    from (table) {
      if (table === 'cron_logs') {
        return {
          select () { return this },
          eq () { return this },
          async maybeSingle () { journal.lectures++; return pannes.marqueur ? { data: null, error: pannes.marqueur } : { data: marqueur, error: null } },
          async upsert (payload) { journal.marqueurs.push(payload); return { error: pannes.ecritureMarqueur || null } }
        }
      }
      if (table === 'avis_traductions') {
        // Une tentative s'ecrit en lot (tableau), un resultat seul : on aplatit.
        return { async upsert (payload) {
          if (pannes.tentative && Array.isArray(payload)) return { error: pannes.tentative }
          journal.ecrits.push(...[].concat(payload)); return { error: null } } }
      }
      throw new Error('faux : table inattendue ' + table)
    },
    async rpc (nom, args) {
      journal.rpc.push({ nom, args })
      if (pannes.rpc) return { data: null, error: pannes.rpc }
      return { data: file.slice(0, args.p_limite), error: null }
    }
  }
}

const ligne = (i) => ({ id: 'r' + i, user_id: 'u1', property_id_ref: '209413', booking_uid: 'b' + i,
  texte_public: 'Great stay ' + i, texte_prive: null, texte_extrait: null, empreinte: 'E' + i, echecs: 0 })
const file = (n) => Array.from({ length: n }, (_, i) => ligne(i + 1))

function traducteur ({ ok = true, leve = false } = {}) {
  const appels = []
  const fn = async (l) => {
    appels.push(l.id)
    if (leve) throw new Error('panne')
    return ok ? { ok: true, textes: { public: { source: 'en', fr: 'Bon séjour', es: 'Buena estancia' } }, appel: true }
      : { ok: false, motif: 'json_illisible', appel: true }
  }
  fn.appels = appels
  return fn
}

const horloge = (debut = T0) => { let t = debut; const f = () => t; f.avancer = (ms) => { t += ms }; return f }

test('⚠ RIEN À TRADUIRE : ZÉRO APPEL à l’IA, et rien n’est écrit (une lecture + la file)', async () => {
  const sb = fauxBase({ file: [] })
  const traduire = traducteur()
  const results = { errors: [] }
  const b = await C.traduireAvisDus(results, { supabase: sb, now: horloge(), traduire })
  assert.equal(traduire.appels.length, 0)
  assert.equal(b.appels, 0)
  assert.equal(sb.journal.lectures, 1)
  assert.equal(sb.journal.rpc.length, 1)
  assert.equal(sb.journal.marqueurs.length, 0, 'aucun compte du jour à écrire')
  assert.equal(sb.journal.ecrits.length, 0)
  assert.deepEqual(results.errors, [])
})

test('la file est lue avec les bons seuils : 10 au plus, classement attendu 48 h, échec attendu 24 h', async () => {
  const sb = fauxBase({ file: [] })
  await C.traduireAvisDus({ errors: [] }, { supabase: sb, now: horloge(), traduire: traducteur() })
  assert.deepEqual(sb.journal.rpc[0], { nom: 'avis_a_traduire', args: {
    p_limite: 10,
    p_classe_avant: '2026-11-09T09:00:00.000Z',
    p_echec_avant: '2026-11-10T09:00:00.000Z',
    p_longueur_max: 3000,
    p_echecs_max: 3
  } })
})

test('trois avis : trois appels, trois tentatives puis trois traductions, et le compte du jour monte de trois', async () => {
  const sb = fauxBase({ file: file(3), marqueur: { last_run: '2026-11-11T07:00:00Z', total_messages: 12 } })
  const traduire = traducteur()
  const b = await C.traduireAvisDus({ errors: [] }, { supabase: sb, now: horloge(), traduire })
  assert.deepEqual(traduire.appels, ['r1', 'r2', 'r3'])
  assert.equal(b.traduits, 3)
  assert.equal(sb.journal.ecrits.filter(e => e.echec_le).length, 3, 'les tentatives')
  assert.equal(sb.journal.ecrits.filter(e => e.textes).length, 3, 'les traductions')
  assert.equal(sb.journal.marqueurs.length, 1, 'réservé une fois, rien à rendre')
  assert.equal(sb.journal.marqueurs[0].id, C.MARQUEUR_JOUR)
  assert.equal(sb.journal.marqueurs[0].total_messages, 15)
  assert.equal(b.appels_jour, 15)
})

test('⚠ 10 APPELS AU PLUS PAR PASSAGE, même si la file en rend plus', async () => {
  const sb = fauxBase({ file: file(25) })
  const sbTrop = { ...sb, rpc: async (nom, args) => { sb.journal.rpc.push({ nom, args }); return { data: file(25), error: null } } }
  const traduire = traducteur()
  const b = await C.traduireAvisDus({ errors: [] }, { supabase: sbTrop, now: horloge(), traduire })
  assert.equal(traduire.appels.length, 10)
  assert.equal(b.appels, 10)
})

test('⚠ 100 APPELS AU PLUS PAR JOUR : au plafond, ni file ni appel ; à 95, la file est bornée à 5', async () => {
  const plein = fauxBase({ file: file(5), marqueur: { last_run: '2026-11-11T06:00:00Z', total_messages: 100 } })
  const t1 = traducteur()
  const b1 = await C.traduireAvisDus({ errors: [] }, { supabase: plein, now: horloge(), traduire: t1 })
  assert.equal(b1.skipped, 'plafond_jour')
  assert.equal(plein.journal.rpc.length, 0)
  assert.equal(t1.appels.length, 0)

  const presque = fauxBase({ file: file(20), marqueur: { last_run: '2026-11-11T06:00:00Z', total_messages: 95 } })
  const t2 = traducteur()
  const b2 = await C.traduireAvisDus({ errors: [] }, { supabase: presque, now: horloge(), traduire: t2 })
  assert.equal(presque.journal.rpc[0].args.p_limite, 5)
  assert.equal(t2.appels.length, 5)
  assert.equal(b2.appels_jour, 100)
})

test('le compte repart à zéro au jour suivant, à l’heure de PARIS', async () => {
  // 23:30 UTC le 10 = 00:30 à Paris le 11 : c'est déjà un autre jour.
  const sb = fauxBase({ file: file(2), marqueur: { last_run: '2026-11-10T22:50:00Z', total_messages: 100 } })
  const traduire = traducteur()
  const b = await C.traduireAvisDus({ errors: [] }, { supabase: sb, now: horloge(Date.parse('2026-11-10T23:30:00Z')), traduire })
  assert.equal(b.skipped, undefined)
  assert.equal(traduire.appels.length, 2)
  assert.equal(sb.journal.marqueurs[0].total_messages, 2)

  // 22:50 et 22:55 UTC sont 23:50 et 23:55 à Paris le 10 : même jour, plafond
  // atteint.
  const meme = fauxBase({ file: file(2), marqueur: { last_run: '2026-11-10T22:50:00Z', total_messages: 100 } })
  const b2 = await C.traduireAvisDus({ errors: [] }, { supabase: meme, now: horloge(Date.parse('2026-11-10T22:55:00Z')), traduire: traducteur() })
  assert.equal(b2.skipped, 'plafond_jour')
})

test('⚠ un appel qui échoue COMPTE dans le plafond, et l’échec est écrit', async () => {
  const sb = fauxBase({ file: file(2) })
  const b = await C.traduireAvisDus({ errors: [] }, { supabase: sb, now: horloge(), traduire: traducteur({ ok: false }) })
  assert.equal(b.echecs, 2)
  assert.equal(b.appels, 2)
  assert.equal(sb.journal.marqueurs[0].total_messages, 2)
  assert.deepEqual(sb.journal.ecrits.map(e => e.echec_empreinte), ['E1', 'E2'])
})

test('⚠ un traducteur qui LÈVE : l’appel est compté, le passage continue et rend son bilan', async () => {
  const sb = fauxBase({ file: file(2) })
  const b = await C.traduireAvisDus({ errors: [] }, { supabase: sb, now: horloge(), traduire: traducteur({ leve: true }) })
  assert.equal(b.appels, 2)
  assert.equal(b.echecs, 2)
  assert.equal(sb.journal.marqueurs[0].total_messages, 2)
})

test('le budget de temps du passage arrête la boucle ; le reste du cycle aussi', async () => {
  const sb = fauxBase({ file: file(5) })
  const now = horloge()
  const traduire = async (l) => { now.avancer(5000); return { ok: true, textes: {}, appel: true } }
  const b = await C.traduireAvisDus({ errors: [] }, { supabase: sb, now, traduire })
  assert.equal(b.interrompu, 'budget')
  assert.equal(b.appels, 3, '0 s, 5 s, 10 s partent ; à 15 s le budget de 12 s est dépassé')
  assert.deepEqual(sb.journal.marqueurs.map(m => m.total_messages), [5, 3], 'le lot réservé, puis ce qui n’est pas parti rendu')
  assert.equal(sb.journal.ecrits.filter(e => e.echec_le).length, 3, 'aucune tentative notée pour un avis qui n’est pas parti')

  const sb2 = fauxBase({ file: file(5) })
  const t2 = traducteur()
  const b2 = await C.traduireAvisDus({ errors: [] }, { supabase: sb2, now: horloge(), traduire: t2, resteMs: () => 20000 })
  assert.equal(b2.skipped, 'temps')
  assert.equal(sb2.journal.rpc.length, 0)
  assert.equal(t2.appels.length, 0)
})

test('migration absente : on attend sans alerter ; une autre panne alerte', async () => {
  const results = { errors: [] }
  const b = await C.traduireAvisDus(results, { supabase: fauxBase({ pannes: { rpc: { code: 'PGRST202', message: 'x' } } }), now: horloge(), traduire: traducteur() })
  assert.equal(b.skipped, 'migration_absente')
  assert.equal(results.traductionAvisEnAttente, 'migration_absente')
  assert.deepEqual(results.errors, [])

  const r2 = { errors: [] }
  const b2 = await C.traduireAvisDus(r2, { supabase: fauxBase({ pannes: { rpc: { code: '57014', message: 'timeout' } } }), now: horloge(), traduire: traducteur() })
  assert.equal(b2.skipped, 'file_illisible')
  assert.equal(r2.errors.length, 1)
  assert.equal(r2.errors[0].context, 'traduction_avis')
})

test('compte du jour illisible : rien ne part (on ne sait pas combien il en reste)', async () => {
  const results = { errors: [] }
  const sb = fauxBase({ file: file(3), pannes: { marqueur: { message: 'down' } } })
  const traduire = traducteur()
  const b = await C.traduireAvisDus(results, { supabase: sb, now: horloge(), traduire })
  assert.equal(b.skipped, 'marqueur_illisible')
  assert.equal(traduire.appels.length, 0)
  assert.equal(results.errors.length, 1)
})

test('compte du jour NON écrit : alerte, et AUCUN appel (le plafond ne tiendrait plus)', async () => {
  const results = { errors: [] }
  const traduire = traducteur()
  const b = await C.traduireAvisDus(results, { supabase: fauxBase({ file: file(1), pannes: { ecritureMarqueur: { message: 'down' } } }), now: horloge(), traduire })
  assert.equal(b.skipped, 'compte_non_ecrit')
  assert.equal(traduire.appels.length, 0)
  assert.equal(results.errors.length, 1)
  assert.match(results.errors[0].error, /compte du jour NON ecrit/)
})

test('⚠ LE COMPTE EST RÉSERVÉ ET LA TENTATIVE NOTÉE AVANT L’APPEL : un passage coupé pendant l’appel ne perd rien', async () => {
  const sb = fauxBase({ file: file(2), marqueur: { last_run: '2026-11-11T07:00:00Z', total_messages: 40 } })
  const vu = []
  const traduire = async (l) => {
    vu.push({ id: l.id, reserve: sb.journal.marqueurs.map(m => m.total_messages), tentatives: sb.journal.ecrits.filter(e => e.echec_le).map(e => e.review_id) })
    return { ok: true, textes: {}, appel: true }
  }
  await C.traduireAvisDus({ errors: [] }, { supabase: sb, now: horloge(), traduire })
  assert.deepEqual(vu, [
    { id: 'r1', reserve: [42], tentatives: ['r1'] },
    { id: 'r2', reserve: [42], tentatives: ['r1', 'r2'] }
  ])
})

test('⚠ chaque appel porte sa durée maximale : 20 s, et jamais au-delà du reste du cycle moins 25 s', async () => {
  const durees = []
  const traduire = async (l, d) => { durees.push(d.timeoutMs); return { ok: true, textes: {}, appel: true } }
  await C.traduireAvisDus({ errors: [] }, { supabase: fauxBase({ file: file(1) }), now: horloge(), traduire })
  await C.traduireAvisDus({ errors: [] }, { supabase: fauxBase({ file: file(1) }), now: horloge(), traduire, resteMs: () => 31000 })
  assert.deepEqual(durees, [20000, 6000])
})

test('moins de 3 s devant lui, l’appel ne part pas, et la réservation est rendue', async () => {
  const sb = fauxBase({ file: file(2) })
  const traduire = traducteur()
  const b = await C.traduireAvisDus({ errors: [] }, { supabase: sb, now: horloge(), traduire, resteMs: () => 27000 })
  assert.equal(b.interrompu, 'budget')
  assert.equal(traduire.appels.length, 0)
  assert.deepEqual(sb.journal.marqueurs.map(m => m.total_messages), [2, 0])
})

test('une tentative qui ne s’écrit pas arrête le passage AVANT l’appel', async () => {
  const results = { errors: [] }
  const traduire = traducteur()
  const b = await C.traduireAvisDus(results, { supabase: fauxBase({ file: file(2), pannes: { tentative: { message: 'down' } } }), now: horloge(), traduire })
  assert.equal(traduire.appels.length, 0)
  assert.equal(b.interrompu, 'ecriture')
  assert.match(results.errors[0].error, /tentative r1/)
})

test('une traduction réussie efface la tentative ; un échec la laisse telle quelle (c’est elle, l’échec)', async () => {
  const ok = fauxBase({ file: file(1) })
  await C.traduireAvisDus({ errors: [] }, { supabase: ok, now: horloge(), traduire: traducteur() })
  assert.deepEqual(ok.journal.ecrits.map(e => [e.echec_le ? 'tentative' : 'traduction', e.echec_le === null ? 'efface' : '']), [['tentative', ''], ['traduction', 'efface']])
  const ko = fauxBase({ file: file(1) })
  await C.traduireAvisDus({ errors: [] }, { supabase: ko, now: horloge(), traduire: traducteur({ ok: false }) })
  assert.equal(ko.journal.ecrits.length, 1, 'la seule tentative')
})

test('les plafonds sont ceux décidés par Thierry (Q5 = A)', () => {
  assert.equal(C.PAR_PASSAGE, 10)
  assert.equal(C.PAR_JOUR, 100)
})
