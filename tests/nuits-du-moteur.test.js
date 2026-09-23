// tests/nuits-du-moteur.test.js — DEUX ORIGINES, DEUX TRAITEMENTS.
// Changement de dessin du 23 septembre 2026 (decisions A1 / B1 / C1 de Thierry).
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter.
//
// Les prix du CALENDRIER sont remplaces par les predictions a l'activation ;
// les prix poses depuis YieldFlow (✎, `prix_hote`) ne le sont jamais. La
// confirmation d'activation annonce les deux nombres.
//
// CE QUE CES TESTS DEFENDENT :
//   1. le compte n'inclut que ce que le moteur va recalculer, et qui porte un
//      prix : ni indisponibilite, ni prix YieldFlow, ni nuit fermee, ni nuit
//      sans ligne ou sans prix, ni nuit hors fenetre ;
//   2. LE COMPTE SUIT LE MOTEUR : meme regle de saut, une seule fonction ;
//   3. l'endpoint ne compte que sur demande, et un compte illisible ne se lit
//      jamais « 0 » a l'ecran.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { sautDuMoteur, compterPrixARemplacer, prixCalendrierARemplacer } = require('../lib/nuits-du-moteur')
// Le moteur cree un client a l'import (comme tests/moteur-prix.test.js) : jamais appele ici.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
const { calculerPrix } = require('../lib/moteur-prix')

const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const sansCommentaires = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
const ouverte = (date, rate) => ({ date, rate, avail: 1, stop_sell: false })

// Une semaine d'octobre, un cas par nuit. Dates figees : l'horloge est injectee.
const AUJ = '2026-10-01'
const FIN = '2026-10-08'
const LIGNES = [
  ouverte('2026-10-01', 100), // compte
  ouverte('2026-10-02', 100), // indisponibilite de l'hote
  ouverte('2026-10-03', 150), // prix YieldFlow (✎)
  { date: '2026-10-04', rate: 100, avail: 1, stop_sell: true }, // fermee a la main
  { date: '2026-10-05', rate: 100, avail: 0, stop_sell: false }, // stock a 0
  ouverte('2026-10-06', null), // ouverte sans prix : rien a remplacer
  // 2026-10-07 : aucune ligne (pas encore ouverte : le moteur d'ouverture l'ouvrira)
  ouverte('2026-10-08', 120), // compte
  ouverte('2026-10-09', 120) // hors fenetre
]
const FERMETURES = [{ date_debut: '2026-10-02', date_fin: '2026-10-02', raison: 'travaux' }]
const PRIX_HOTE = new Map([['2026-10-03', 15000]])
// Une nuit VENDUE garde avail=1 et son prix au calendrier (une reservation
// n'ecrit pas dans calendar_inventory) : le moteur ne la tarife pas.
LIGNES.push(ouverte('2026-10-07', 110))
const VENDUES = new Set(['2026-10-07'])

test('LE TEST QUI COMPTE : on ne compte que les prix du calendrier que le moteur va recalculer', () => {
  assert.equal(compterPrixARemplacer({ aujourdHui: AUJ, fin: FIN, lignes: LIGNES, fermetures: FERMETURES, prixHote: PRIX_HOTE, vendues: VENDUES }), 2,
    'le 1er et le 8 : ni indisponibilite, ni prix YieldFlow, ni fermee, ni sans prix, ni vendue, ni hors fenetre')
  assert.equal(compterPrixARemplacer({ aujourdHui: AUJ, fin: FIN, lignes: LIGNES, fermetures: FERMETURES, prixHote: PRIX_HOTE }), 3,
    'sans les ventes, la nuit reservee serait annoncee remplacee : c est le defaut releve en review')
})

test('LE TEST QUI COMPTE : le compte SUIT le moteur — chaque nuit comptee est une nuit que calculerPrix recalcule, et reciproquement', () => {
  // Le moteur est interroge avec une regle qui tarife tout a 1 € de plus :
  // chaque nuit qu'il ne saute pas devient un « changement ».
  // Elle rend `nuit_deja_vendue` pour la nuit reservee, comme la vraie regle.
  const r = calculerPrix({ aujourdHui: AUJ, fin: FIN, lignes: LIGNES, fermetures: FERMETURES, prixHote: PRIX_HOTE,
    prix: (j) => VENDUES.has(j) ? { prix: null, non_calculable: ['nuit_deja_vendue'] }
      : { prix: ((LIGNES.find(x => x.date === j) || {}).rate || 100) + 1, non_calculable: [] } })
  assert.equal(r.comptes.vendues, 1, 'le moteur voit la nuit vendue')
  const recalculees = new Set(r.changements.map(c => c.date))
  const avecPrix = new Set([...recalculees].filter(j => { const l = LIGNES.find(x => x.date === j); return l && l.rate > 0 }))
  assert.equal(avecPrix.size, compterPrixARemplacer({ aujourdHui: AUJ, fin: FIN, lignes: LIGNES, fermetures: FERMETURES, prixHote: PRIX_HOTE, vendues: VENDUES }))
  assert.ok(!recalculees.has('2026-10-07'), 'ni la nuit vendue')
  assert.ok(!recalculees.has('2026-10-03'), 'le prix YieldFlow n est jamais recalcule')
  assert.ok(!recalculees.has('2026-10-02'), 'l indisponibilite non plus')
  assert.match(sansCommentaires(lire('lib/moteur-prix.js')), /const saut = sautDuMoteur\(j, \{ parLHote, prixHote, parDate, ouverts \}\)/, 'une seule regle de saut, partagee')
})

test('sautDuMoteur nomme chaque motif comme les compteurs du moteur', () => {
  const parDate = new Map(LIGNES.map(l => [l.date, l]))
  const parLHote = new Set(['2026-10-02'])
  const motif = j => sautDuMoteur(j, { parLHote, prixHote: PRIX_HOTE, parDate })
  assert.deepEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-07'].map(motif),
    [null, 'fermees_par_l_hote', 'prix_hote', 'fermees', 'fermees', null])
  assert.equal(sautDuMoteur('2026-10-07', { parLHote, prixHote: PRIX_HOTE, parDate, vendues: VENDUES }), 'vendues')
  assert.equal(sautDuMoteur('2026-10-20', { parLHote, prixHote: PRIX_HOTE, parDate }), 'sans_ligne')
  assert.equal(sautDuMoteur('2026-10-01', { parLHote, prixHote: PRIX_HOTE, parDate, ouverts: new Set() }), 'ouverture_inconnue')
})

test('l endpoint ne compte que SUR DEMANDE, pour la fenetre saisie, validee par la regle du pilote', () => {
  const src = sansCommentaires(lire('api/yield-pilote.js'))
  assert.match(src, /if \(req\.query\.fenetre_type != null \|\| req\.query\.fenetre_valeur != null\) \{\n\s+const v = validerFenetre\(\{ type: req\.query\.fenetre_type, valeur: req\.query\.fenetre_valeur \}\)/)
  assert.match(src, /\.\.\.\(prixCalendrier !== undefined \? \{ prix_calendrier: prixCalendrier \} : \{\}\)/, 'absent de la lecture ordinaire')
  assert.ok(/prixCalendrier = await prixCalendrierARemplacer\(supabase, bien, v\.fenetre, aujourdHui\)/.test(src), 'la regle partagee')
  assert.match(src, /\.select\('id, user_id, name, provider_property_id, inventory_units, /, 'le bien porte de quoi lire ses ventes')
  assert.ok(!/moteur-prix|moteur-ouverture|canal-calendrier|pilote-quotidien/.test(src), 'l endpoint n importe jamais le moteur')
})

test('l ecran : « N nuits ont deja un prix au calendrier… Continuer ? », « M nuits gardent votre prix YieldFlow », et un compte illisible ne se lit jamais 0', () => {
  const page = sansCommentaires(lire('apps/yield/prix.html'))
  assert.ok(page.includes("const phrasePrixCalendrier = n => `${n} nuit${n > 1 ? 's ont' : ' a'} déjà un prix au calendrier`"), 'A1 : pas « que vous avez definis »')
  assert.ok(page.includes("const phrasePrixHote = n => `${n} nuit${n > 1 ? 's' : ''} garde${n > 1 ? 'nt' : ''} votre prix YieldFlow`"))
  const cpt = page.slice(page.indexOf('async function compterPrixCalendrier'), page.indexOf('async function basculerPilote'))
  assert.ok(cpt.includes('YieldFlow va ${n > 1 ? \'les\' : \'le\'} remplacer par ses prédictions ; une nuit qu’il ne sait pas encore prédire garde son prix. Continuer ?'), 'la question, exacte quand la regle ne sait pas')
  assert.ok(cpt.includes("if (jeton !== enCoursCompte || !el('yp-act-compte')) return"), 'le compte d une autre fenetre ne s affiche pas')
  const att = page.slice(page.indexOf('function attendreCompte ()'), page.indexOf('async function compterPrixCalendrier'))
  assert.ok(att.includes('++enCoursCompte') && att.includes('valider.disabled = true'), 'le jeton avance et Activer attend')
  assert.ok(page.includes('const relire = () => { clearTimeout(attente); attendreCompte();'), 'des la frappe, pas a la fin de la pause')
  assert.ok(cpt.includes('liberer()'), 'Activer se libere quand le compte (ou son absence) est dit')
  assert.ok(cpt.includes('n == null') && cpt.includes('Impossible de compter'), 'illisible se dit')
  assert.ok(cpt.indexOf('n == null') < cpt.indexOf('n === 0'), 'et se teste AVANT zero')
  const dem = page.slice(page.indexOf('function demanderFenetre'), page.indexOf('async function compterPrixCalendrier'))
  assert.ok(dem.includes('id="yp-act-compte"') && dem.includes('compterPrixCalendrier()'), 'la confirmation compte a l ouverture')
  assert.ok(!dem.includes('avec leur prix actuel (ou le prix de base)'), 'la promesse perimee du 4.6.3 est partie')
  assert.ok(dem.includes('au prix prédit par YieldFlow'))
})

// ─── LE COMPTE, EXECUTE ─────────────────────────────────────────────────────
const BIEN_UUID = '22222222-2222-4222-8222-222222222222'
function baseLectures (tables, { panne = null } = {}) {
  return { from (table) {
    const q = { f: [] }
    for (const m of ['select', 'order', 'limit', 'range']) q[m] = () => q
    for (const op of ['eq', 'gte', 'lte', 'lt', 'in']) q[op] = (c, v) => { q.f.push([op, c, v]); return q }
    q.then = (res, rej) => {
      if (panne === table) return Promise.resolve({ data: null, error: { code: '57014', message: 'timeout' } }).then(res, rej)
      const ok = l => q.f.every(([op, c, v]) => op === 'eq' ? l[c] === v : op === 'gte' ? l[c] >= v : op === 'lte' ? l[c] <= v : op === 'lt' ? l[c] < v : v.includes(l[c]))
      return Promise.resolve({ data: (tables[table] || []).filter(ok), error: null }).then(res, rej)
    }
    return q
  } }
}
const BIEN_CAL = { id: BIEN_UUID, user_id: '11111111-1111-4111-8111-111111111111', provider_property_id: null, inventory_units: 1, pilote_tarifaire: 'calendrier', pilote_fenetre_type: null, pilote_fenetre_valeur: null }
const TABLES = {
  calendar_inventory: [
    { property_id: BIEN_UUID, date: '2026-10-01', rate: 100, avail: 1, stop_sell: false },
    { property_id: BIEN_UUID, date: '2026-10-25', rate: 100, avail: 1, stop_sell: false },
    { property_id: BIEN_UUID, date: '2026-11-15', rate: 100, avail: 1, stop_sell: false }
  ],
  fermetures: [], prix_hote: []
}

test('LE TEST QUI COMPTE : le compte s execute sur un bien ENCORE en mode calendrier, fenetre en mois ou en jours', async () => {
  // Sans la surcharge du pilote, finDeFenetre rendrait null sur ce bien, et
  // l ecran dirait « impossible de compter » a chaque activation.
  assert.deepEqual(await prixCalendrierARemplacer(baseLectures(TABLES), BIEN_CAL, { type: 'mois', valeur: 1 }, '2026-10-01'), { nuits: 2, fin: '2026-11-01' })
  assert.deepEqual(await prixCalendrierARemplacer(baseLectures(TABLES), BIEN_CAL, { type: 'jours', valeur: 60 }, '2026-10-01'), { nuits: 3, fin: '2026-11-30' })
})

test('une lecture en panne rend null — l ecran dit « impossible de compter », jamais 0', async () => {
  const err = console.error; console.error = () => {}
  try {
    for (const t of ['calendar_inventory', 'fermetures', 'prix_hote']) {
      assert.equal(await prixCalendrierARemplacer(baseLectures(TABLES, { panne: t }), BIEN_CAL, { type: 'mois', valeur: 1 }, '2026-10-01'), null, `panne de ${t}`)
    }
  } finally { console.error = err }
})
