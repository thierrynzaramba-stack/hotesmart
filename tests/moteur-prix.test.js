// tests/moteur-prix.test.js — lot 4.6.4, LE MOTEUR DE PRIX.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter §1, §6 et « 4.6.4 livre ».
//
// CE QUE CES TESTS DEFENDENT, dans l'ordre d'importance :
//   1. le moteur ne tarife JAMAIS une indisponibilite, une nuit fermee, une
//      nuit vendue, une nuit sans ligne ;
//   2. seuls les prix qui CHANGENT sont demandes (diff avant journal) ;
//   3. « non calculable » garde le prix en place ; sous le plancher aussi ;
//   4. une poussee refusee est un echec, pas un succes.
//
// ⚠ LA REGLE EST INJECTEE (`prix`) : ces tests eprouvent la DECISION du
// moteur, pas la suggestion (tests/suggestion-yield.test.js s'en charge).

const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
const { calculerPrix, entretenirLesPrix } = require('../lib/moteur-prix')

const AUJ = '2026-10-01', FIN = '2026-10-07'
const ID = 'b1b1b1b1-0000-4000-8000-000000000001'
const COMPTE = 'a1a1a1a1-0000-4000-8000-000000000001'
const ouverte = (date, rate) => ({ date, stop_sell: false, avail: 1, rate })
const regle = (table) => (date) => table[date] === undefined ? { prix: 100, non_calculable: [] } : table[date]

test('LE TEST QUI COMPTE : jamais sur une indisponibilite, une nuit fermee, une nuit vendue, une nuit sans ligne', () => {
  const fermetures = [{ id: 'f1', property_id: ID, date_debut: '2026-10-02', date_fin: '2026-10-02', raison: 'travaux' }]
  const lignes = [
    ouverte('2026-10-01', 80),
    ouverte('2026-10-02', 80),                                   // indisponibilite : meme pas regardee
    { date: '2026-10-03', stop_sell: true, avail: 0, rate: 80 }, // fermee a la main
    { date: '2026-10-04', stop_sell: false, avail: 0, rate: 80 },// stock a 0
    ouverte('2026-10-05', 80)                                    // vendue (la regle le dit)
    // 06 et 07 : sans ligne — pas encore ouvertes
  ]
  const prix = regle({ '2026-10-05': { prix: null, non_calculable: ['nuit_deja_vendue'] } })
  const r = calculerPrix({ aujourdHui: AUJ, fin: FIN, lignes, fermetures, prix })
  assert.deepEqual(r.changements.map(c => c.date), ['2026-10-01'], 'une seule nuit tarifable')
  assert.deepEqual(r.comptes, { calculees: 1, changees: 1, inchangees: 0, non_calculables: 0, sous_plancher: 0,
    fermees: 2, fermees_par_l_hote: 1, vendues: 1, sans_ligne: 2 })
})

test('LE TEST QUI COMPTE : diff avant journal — un prix egal au centime n est pas demande', () => {
  const lignes = [ouverte('2026-10-01', 100), ouverte('2026-10-02', 99.99), ouverte('2026-10-03', 100.001)]
  const r = calculerPrix({ aujourdHui: AUJ, fin: '2026-10-03', lignes, fermetures: [], prix: regle({}) })
  assert.deepEqual(r.changements.map(c => [c.date, c.avant_centimes, c.prix_centimes]), [['2026-10-02', 9999, 10000]])
  assert.equal(r.comptes.inchangees, 2, '100 et 100.001 valent 10000 centimes : rien ne part')
  // Second passage sans changement : ZERO demande.
  const apres = [ouverte('2026-10-01', 100), ouverte('2026-10-02', 100), ouverte('2026-10-03', 100)]
  assert.deepEqual(calculerPrix({ aujourdHui: AUJ, fin: '2026-10-03', lignes: apres, fermetures: [], prix: regle({}) }).changements, [])
})

test('« non calculable » garde le prix en place et compte le motif ; sous le plancher aussi', () => {
  const lignes = [ouverte('2026-10-01', 80), ouverte('2026-10-02', 80), ouverte('2026-10-03', 80)]
  const prix = regle({
    '2026-10-01': { prix: null, non_calculable: ['segment_sous_le_seuil'] },
    '2026-10-02': { prix: null, non_calculable: ['suggestion_sous_le_plancher'], prix_refuse: 40 }
  })
  const r = calculerPrix({ aujourdHui: AUJ, fin: '2026-10-03', lignes, fermetures: [], prix })
  assert.deepEqual(r.changements.map(c => c.date), ['2026-10-03'])
  assert.equal(r.comptes.non_calculables, 1); assert.equal(r.comptes.sous_plancher, 1)
  assert.deepEqual(r.motifs, { segment_sous_le_seuil: 1, suggestion_sous_le_plancher: 1 })
})

// ─── entretenirLesPrix : contexte, canal, poussee ───────────────────────────
const bien = (o = {}) => ({ id: ID, user_id: COMPTE, name: 'Loft', provider: 'channex', pilote_tarifaire: 'yieldflow',
  pilote_fenetre_type: 'jours', pilote_fenetre_valeur: 6, base_price: 90, inventory_units: 1, ...o })
function fausseBase ({ fermetures = [], lignes = [] } = {}) {
  return { from (table) {
    const q = { f: {} }; const ch = () => q
    q.select = ch; q.order = ch; q.limit = ch; q.eq = (c, v) => { q.f[c] = v; return q }
    q.gte = (c, v) => { q.g = v; return q }; q.lte = (c, v) => { q.l = v; return q }
    q.then = (res, rej) => Promise.resolve(table === 'fermetures'
      ? { data: fermetures, error: null }
      : { data: lignes.filter(x => x.date >= q.g && x.date <= q.l), error: null }).then(res, rej)
    return q
  } }
}
const fauxCtx = (table) => ({ parDate: new Map(), auj: AUJ, __table: table })
const fauxCanal = (rep) => { const appels = []; const fn = async (sb, b, demande, deps) => { appels.push(demande); return rep || { ok: true, ecrit: { saved: demande.nuits.length }, ignorees: null } }; fn.appels = appels; return fn }

test('LE TEST QUI COMPTE : ce qui part au canal est le DELTA, en centimes, sans `ouvrir`', async () => {
  const lignes = [ouverte('2026-10-01', 100), ouverte('2026-10-02', 80)]
  const canal = fauxCanal()
  const r = await entretenirLesPrix(fausseBase(), bien(), { aujourdHui: AUJ, ctx: fauxCtx(), lignes, demander: canal, prix: regle({}) })
  assert.equal(r.ok, true); assert.equal(r.changees, 1)
  assert.deepEqual(canal.appels[0].nuits, [{ date: '2026-10-02', prix_centimes: 10000 }], 'seul le 02 change ; aucun `ouvrir`')
})

test('rien a changer : aucune demande au canal, et c est un succes', async () => {
  const canal = fauxCanal()
  const r = await entretenirLesPrix(fausseBase(), bien(), { aujourdHui: AUJ, ctx: fauxCtx(), lignes: [ouverte('2026-10-01', 100)], demander: canal, prix: regle({}) })
  assert.equal(r.ok, true); assert.equal(r.changees, 0); assert.equal(canal.appels.length, 0)
})

test('une poussee refusee est un ECHEC nomme, pas un succes', async () => {
  const canal = fauxCanal({ ok: true, ecrit: { pushFailed: true, warnings: ['restrictions HTTP 503'] }, ignorees: null })
  const r = await entretenirLesPrix(fausseBase(), bien(), { aujourdHui: AUJ, ctx: fauxCtx(), lignes: [ouverte('2026-10-01', 80)], demander: canal, prix: regle({}) })
  assert.equal(r.ok, false); assert.equal(r.refus, 'poussee_refusee'); assert.match(r.message, /503/)
})

test('un bien non pilote, ou sans fenetre, est refuse sans lecture', async () => {
  assert.equal((await entretenirLesPrix(fausseBase(), bien({ pilote_tarifaire: 'calendrier' }), { aujourdHui: AUJ })).refus, 'bien_non_pilote')
  assert.equal((await entretenirLesPrix(fausseBase(), bien({ pilote_fenetre_type: null, pilote_fenetre_valeur: null }), { aujourdHui: AUJ })).refus, 'fenetre_non_reglee')
})

test('un contexte illisible refuse, sans toucher au canal', async () => {
  const canal = fauxCanal()
  const r = await entretenirLesPrix(fausseBase(), bien(), { aujourdHui: AUJ, preparer: async () => { throw new Error('bookings_snapshot : timeout') }, demander: canal })
  assert.equal(r.ok, false); assert.equal(r.refus, 'contexte_illisible'); assert.equal(canal.appels.length, 0)
})
