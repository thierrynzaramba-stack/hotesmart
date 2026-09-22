// tests/pilote-quotidien.test.js — lot 4.6.5, LE RYTHME QUOTIDIEN ET LES ALARMES.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter « 4.6.5 livre ».
//
// CE QUE CES TESTS DEFENDENT :
//   1. l'ordre : matiere, ouverture (avec le prix de la regle), prix, marqueur ;
//   2. une matiere illisible n'empeche pas l'ouverture (memoire, prix de base) ;
//   3. les alarmes : poussee refusee, sans prix, regle muette, retard — et
//      RIEN pour un passage normal ;
//   4. une fois par jour et par bien, un bien par tick, un echec se retente.

const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
const { piloterLesBiens, piloterLeBien, alarmerSurLePassage, sonderLesRetards } = require('../lib/pilote-quotidien')
const { PREFIXE_MARQUEUR } = require('../lib/ouverture-marqueur')

const AUJ = '2026-10-01'
const ID = 'b1b1b1b1-0000-4000-8000-000000000001'
const COMPTE = 'a1a1a1a1-0000-4000-8000-000000000001'
const bien = (o = {}) => ({ id: ID, user_id: COMPTE, name: 'Loft', provider: 'channex', provider_property_id: 'STG-1', pilote_tarifaire: 'yieldflow',
  pilote_fenetre_type: 'jours', pilote_fenetre_valeur: 3, base_price: 90, inventory_units: 1, ...o })

function fausseBase ({ lignes = [], fermetures = [], marqueurs = {}, biens = [], prixHote = null } = {}) {
  const journal = []
  return { journal, marqueurs, lignes,
    from (table) {
      const q = { f: {}, op: 'select', ligne: null }; const ch = () => q
      q.select = ch; q.order = ch; q.not = ch; q.limit = ch; q.in = ch; q.range = ch; q.lt = ch; q.gt = ch; q.or = ch; q.neq = ch
      q.eq = (c, v) => { q.f[c] = v; return q }
      q.gte = (c, v) => { q.g = v; return q }; q.lte = (c, v) => { q.l = v; return q }
      q.upsert = (row) => { q.op = 'upsert'; q.ligne = row; return q }
      q.insert = (row) => { q.op = 'insert'; q.ligne = row; return q }
      q.delete = () => { q.op = 'delete'; return q }
      q.maybeSingle = () => { q.un = true; return q }
      const exec = () => {
        journal.push({ table, op: q.op, f: { ...q.f }, ligne: q.ligne })
        if (table === 'fermetures') return { data: fermetures, error: null }
        if (table === 'calendar_inventory') return { data: lignes.filter(x => x.date >= q.g && x.date <= q.l), error: null }
        if (table === 'properties') return { data: biens, error: null }
        if (table === 'bookings_snapshot') return { data: [], error: null }
        if (table === 'prix_hote') return { data: q.op === 'select' ? (prixHote || []) : null, error: null }
        if (table === 'cron_logs') {
          if (q.op === 'upsert') { marqueurs[q.ligne.id] = { last_run: q.ligne.last_run, errors: q.ligne.errors }; return { data: null, error: null } }
          return { data: marqueurs[q.f.id] || null, error: null }
        }
        return { data: [], error: null }
      }
      q.then = (res, rej) => Promise.resolve(exec()).then(res, rej)
      return q
    } }
}
// Un canal qui « ouvre » : il ecrit les nuits demandees dans la memoire du
// faux client, pour que la passe des prix les relise.
const canalQuiEcrit = (sb, reponse) => { const appels = []; const fn = async (s, b, demande) => { appels.push(demande); if (reponse) return reponse
  for (const n of demande.nuits) { const l = sb.lignes.find(x => x.date === n.date); if (l) { if (n.ouvrir) { l.stop_sell = false; l.avail = 1 } if (n.prix_centimes != null) l.rate = n.prix_centimes / 100 } else sb.lignes.push({ date: n.date, stop_sell: n.ouvrir ? false : null, avail: n.ouvrir ? 1 : null, rate: n.prix_centimes != null ? n.prix_centimes / 100 : null }) }
  return { ok: true, ecrit: { saved: demande.nuits.length }, ignorees: null } }; fn.appels = appels; return fn }
// Une matiere factice : la regle rend 120 EUR partout, sauf ce que `table` dit.
const preparerFactice = (table = {}) => async () => ({ auj: AUJ, parDate: new Map(), vendues: {}, ouvertureConnue: true, ouverts: new Set(), __regle: table })
// La regle est INJECTEE (`deps.prix`) : 120 EUR partout, sauf ce que `table` dit.
const regleDe = (table) => (ctx, date) => table[date] !== undefined ? table[date] : { prix: 120, non_calculable: [] }
const avecRegle = (table, fn) => fn(regleDe(table))

test('LE TEST QUI COMPTE : l ordre — ouverture avec le prix de la REGLE, puis prix des nuits ouvertes, puis marqueur avec le bilan', async () => {
  const sb = fausseBase({ biens: [bien()] })
  const canal = canalQuiEcrit(sb)
  const alarmes = []
  const b = await avecRegle({}, (prix) => piloterLesBiens(sb, { aujourdHui: AUJ, maintenant: () => Date.parse('2026-10-01T10:00:00Z'),
    demander: canal, preparer: preparerFactice(), prix, alerter: async (type) => { alarmes.push(type) } }))
  assert.equal(b.traites, 1); assert.equal(b.ouvertes, 4, 'quatre nuits (aujourd hui + 3)')
  assert.deepEqual(canal.appels[0].nuits.map(n => [n.date, n.ouvrir, n.prix_centimes])[0], ['2026-10-01', true, 12000], 'ouverte AU PRIX DE LA REGLE, pas au prix de base')
  assert.equal(canal.appels.length, 1, 'les prix des nuits ouvertes sont deja bons : aucune seconde demande')
  assert.equal(b.prix_changes, 0)
  const m = sb.marqueurs[PREFIXE_MARQUEUR + ID]
  assert.ok(m && m.errors[0].prix && m.errors[0].prix.comptes.inchangees === 4, 'le bilan des prix voyage avec le marqueur')
  assert.deepEqual(alarmes, [], 'un passage normal n alarme pas')
})

test('le lendemain : la nuit qui entre s ouvre, et un prix qui a bouge est redemande — le DELTA seulement', async () => {
  const lignes = ['2026-10-02', '2026-10-03', '2026-10-04'].map(d => ({ date: d, stop_sell: false, avail: 1, rate: 120 }))
  const sb = fausseBase({ biens: [bien()], lignes })
  const canal = canalQuiEcrit(sb)
  const b = await avecRegle({ '2026-10-03': { prix: 150, non_calculable: [] } }, (prix) => piloterLesBiens(sb, { aujourdHui: '2026-10-02', maintenant: () => Date.parse('2026-10-02T10:00:00Z'),
    demander: canal, preparer: preparerFactice(), prix, alerter: async () => {} }))
  assert.equal(b.ouvertes, 1, 'le 05 entre dans la fenetre')
  assert.equal(b.prix_changes, 1, 'le 03 passe de 120 a 150')
  const demandesPrix = canal.appels.filter(d => d.nuits.every(n => !n.ouvrir))
  assert.deepEqual(demandesPrix[0].nuits, [{ date: '2026-10-03', prix_centimes: 15000 }], 'le delta, rien d autre')
})

test('une matiere illisible n empeche PAS l ouverture : memoire ou prix de base ; le marqueur est pose, l etat est alarme UNE fois', async () => {
  const sb = fausseBase({ biens: [bien()] })
  const canal = canalQuiEcrit(sb)
  const alarmes = []
  const deps = () => ({ aujourdHui: AUJ, maintenant: () => 0, demander: canal, preparer: async () => { throw new Error('bookings_snapshot : timeout') }, alerter: async (t) => alarmes.push(t), sonderRetards: false })
  const b = await piloterLesBiens(sb, deps())
  assert.equal(b.ouvertes, 4, 'ouvert quand meme')
  assert.equal(canal.appels[0].nuits[0].prix_centimes, 9000, 'au prix de base')
  assert.equal(b.erreurs.length, 1); assert.equal(b.erreurs[0].refus, 'contexte_illisible'); assert.equal(b.erreurs[0].marqueur, 'pose')
  assert.ok(sb.marqueurs[PREFIXE_MARQUEUR + ID], 'marqueur pose : on ne rejoue pas la pagination du compte 288 fois par jour')
  assert.deepEqual(alarmes, ['pilote_matiere_illisible'])
  // Le lendemain, meme etat : pas de nouvelle alarme (transition seulement).
  const b2 = await piloterLesBiens(sb, { ...deps(), aujourdHui: '2026-10-02' })
  assert.equal(b2.erreurs.length, 1); assert.deepEqual(alarmes, ['pilote_matiere_illisible'], 'l etat persiste, il n alarme plus')
})

test('LE TEST QUI COMPTE : les alarmes — poussee refusee, sans prix, regle muette ; rien sinon ; sur TRANSITION, message stable', async () => {
  const b0 = bien()
  const alarmes = []
  const alerter = async (type, o) => { alarmes.push([type, o.propertyId, o.detail]) }
  await alarmerSurLePassage(b0, { ouverture: { ok: false, refus: 'poussee_refusee', message: 'availability 503' }, prix: null }, { alerter })
  await alarmerSurLePassage(b0, { ouverture: { ok: true, ouvertes: 0, comptes: { sans_prix: 24 } }, prix: { ok: true, comptes: { calculees: 3, non_calculables: 0, sous_plancher: 0 } } }, { alerter })
  const muette = { ouverture: { ok: true, ouvertes: 0, comptes: { sans_prix: 0 } }, prix: { ok: true, comptes: { calculees: 0, non_calculables: 9, sous_plancher: 1 }, motifs: { segment_sous_le_seuil: 9 } } }
  const r3 = await alarmerSurLePassage(b0, muette, { alerter })
  await alarmerSurLePassage(b0, { ouverture: { ok: true, ouvertes: 2, comptes: { sans_prix: 0, fermees_par_l_hote: 3 } }, prix: { ok: true, comptes: { calculees: 5, non_calculables: 2, sous_plancher: 0 } } }, { alerter })
  assert.deepEqual(alarmes.map(a => a[0]), ['pilote_poussee_refusee', 'pilote_sans_prix', 'pilote_regle_muette'], 'trois alarmes, et le passage normal n en fait aucune')
  assert.ok(alarmes.every(a => a[1] === ID), 'chacune porte le bien')
  assert.ok(alarmes.every(a => !/\d/.test(a[2].message)), 'le message est STABLE : les chiffres voyagent a cote, pas dedans')
  assert.equal(alarmes[2][2].prix.non_calculables, 9)
  // Le meme etat le lendemain (bilan precedent porte l etat) : rien ne repart.
  const encore = []
  await alarmerSurLePassage(b0, muette, { alerter: async (t) => encore.push(t) }, { etats: r3.etats })
  assert.deepEqual(encore, [], 'un etat qui persiste n alarme plus')
  // Sauf la poussee refusee, qui est un fait, pas un etat : elle repart.
  await alarmerSurLePassage(b0, { ouverture: { ok: false, refus: 'poussee_refusee', message: 'x' }, prix: null }, { alerter: async (t) => encore.push(t) }, { etats: ['pilote_poussee_refusee'] })
  assert.deepEqual(encore, ['pilote_poussee_refusee'])
  // Sous 7 nuits tarifables, une regle muette n alarme pas : trop peu pour conclure.
  const peu = []
  await alarmerSurLePassage(b0, { ouverture: { ok: true, comptes: {} }, prix: { ok: true, comptes: { calculees: 0, non_calculables: 3, sous_plancher: 0 }, motifs: {} } }, { alerter: async (t) => peu.push(t) })
  assert.deepEqual(peu, [])
})

test('le budget se verifie ENTRE l ouverture et les prix : les prix attendent le tick suivant, l ouverture est faite', async () => {
  const sb = fausseBase({ biens: [bien()] })
  const canal = canalQuiEcrit(sb)
  let t = 0
  const canalLent = async (...a) => { t += 30000; return canal(...a) }
  const b = await piloterLesBiens(sb, { aujourdHui: AUJ, maintenant: () => t, budgetMs: 20000, demander: canalLent, preparer: preparerFactice(), prix: regleDe({}), alerter: async () => {}, sonderRetards: false })
  assert.equal(b.ouvertes, 4); assert.equal(b.erreurs[0].refus, 'budget_epuise')
  assert.ok(!sb.marqueurs[PREFIXE_MARQUEUR + ID], 'pas de marqueur : le tick suivant fera les prix')
})

test('la sonde de retard : plus de 36 h sans passage alarme ; jamais passe n est pas un retard', async () => {
  const B2 = 'b2b2b2b2-0000-4000-8000-000000000002'
  const t = Date.parse('2026-10-03T12:00:00Z')
  const sb = fausseBase({ marqueurs: { [PREFIXE_MARQUEUR + ID]: { last_run: '2026-10-01T10:00:00Z', errors: [] } } })
  const alarmes = []
  const retards = await sonderLesRetards(sb, [bien(), bien({ id: B2 })], { alerter: async (type, o) => alarmes.push([type, o.propertyId]) }, t)
  assert.deepEqual(retards, [ID]); assert.deepEqual(alarmes, [['pilote_en_retard', ID]])
})

test('un bien par tick, une fois par jour ; un echec se retente au tick suivant', async () => {
  const B2 = 'b2b2b2b2-0000-4000-8000-000000000002'
  const sb = fausseBase({ biens: [bien(), bien({ id: B2, name: 'Studio' })] })
  let t = Date.parse('2026-10-01T10:00:00Z')
  const canal = canalQuiEcrit(sb)
  const deps = () => ({ aujourdHui: AUJ, maintenant: () => t, demander: canal, preparer: preparerFactice(), prix: regleDe({}), alerter: async () => {}, sonderRetards: false })
  const b1 = await piloterLesBiens(sb, deps())
  assert.equal(b1.traites, 1); assert.equal(b1.reportes, 1, 'le Studio attend le tick suivant')
  t += 300000
  const b2 = await piloterLesBiens(sb, deps())
  assert.equal(b2.sautes, 1); assert.equal(b2.traites, 1, 'le Loft est saute, le Studio passe')
  t += 300000
  const b3 = await piloterLesBiens(sb, deps())
  assert.equal(b3.sautes, 2); assert.equal(b3.traites, 0)
})

test('LE TEST QUI COMPTE : la main de l hote est sautee par les DEUX moteurs — a l ouverture elle donne son prix, a l entretien elle n est pas recalculee', async () => {
  const lignes = [{ date: '2026-10-02', stop_sell: false, avail: 1, rate: 200 }]   // la nuit de l hote, a 200
  const sb = fausseBase({ biens: [bien()], lignes, prixHote: [{ stay_date: '2026-10-02', rate_cents: 20000 }, { stay_date: '2026-10-03', rate_cents: 15000 }] })
  const canal = canalQuiEcrit(sb)
  const b = await piloterLesBiens(sb, { aujourdHui: AUJ, maintenant: () => Date.parse('2026-10-01T10:00:00Z'), demander: canal, preparer: preparerFactice(), prix: regleDe({}), alerter: async () => {}, sonderRetards: false })
  assert.equal(b.ouvertes, 3, '01, 03 et 04 s ouvrent (02 etait deja ouverte)')
  const ouv = canal.appels[0].nuits.find(n => n.date === '2026-10-03')
  assert.equal(ouv.prix_centimes, 15000, 'le 03 s ouvre AU PRIX DE L HOTE, pas a celui de la regle (12000)')
  const demandesPrix = canal.appels.filter(d => d.nuits.every(n => !n.ouvrir))
  assert.ok(!demandesPrix.some(d => d.nuits.some(n => n.date === '2026-10-02')), 'le 02 a 200 EUR n est jamais redemande a 120')
  assert.equal(b.prix_changes, 0)
})
