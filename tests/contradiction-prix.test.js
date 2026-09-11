// tests/contradiction-prix.test.js
//
// ⚠ LA PANNE COMMERCIALE SILENCIEUSE QUE CE MODULE REND VISIBLE — 11 septembre 2026.
//
// Un logement en `keep` (« prix encore gérés par l'ancien channel manager »),
// avec un canal ACTIF, et des dates tarifées dans le cœur. Les trois faits ne
// peuvent pas etre vrais ensemble : l'hote tarife chez nous en nous interdisant
// d'envoyer. La disponibilite part TOUJOURS, les tarifs seulement en `managed` :
// les dates s'ouvrent donc au prix du provisionnement.
//
// Sur « Ofuro Futari » : 31 nuits vendables a 199 € a plat — 14 sous-vendues
// (410 € de manque a gagner), 4 sur-vendues de 30 € au detriment du voyageur,
// 13 sans aucun prix saisi. Personne n'a rien vu jusqu'a ce que l'hote regarde.
//
// DEUX EXIGENCES, POSEES PAR THIERRY :
//  1. l'alerte CHIFFRE le cout, elle ne le qualifie pas ;
//  2. elle part en INCIDENT FONDATEUR, pas en ligne de log — c'est la lecon du
//     cron qui rendait 200 en portant ses erreurs dans le corps, et de la
//     poussee refusee qui ne produisait qu'un `warnings[0]`.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')

const { jugerContradiction, chiffrerEcartDePrix, messageContradiction,
        surveillerContradictionPrix } = require('../lib/contradiction-prix')

const BIEN = { id: 'uuid-1', name: 'Ofuro Futari', user_id: 'u1', rate_sync_mode: 'keep',
  provider_property_id: '204cef81', provider_rate_plan_id: 'rp-base' }
// Le cas reel, reduit : deux nuits sous-vendues, une sur-vendue, une sans prix.
const LIGNES = [
  { date: '2026-09-20', rate: 219, stop_sell: false },
  { date: '2026-10-02', rate: 229, stop_sell: false },
  { date: '2026-09-21', rate: 169, stop_sell: false },
  { date: '2026-11-05', rate: 300, stop_sell: false }   // fermee chez le provider
]
const PAR_DATE = {
  '2026-09-20': { rate: '199.00', availability: 1, stop_sell: false },
  '2026-10-02': { rate: '199.00', availability: 1, stop_sell: false },
  '2026-09-21': { rate: '199.00', availability: 1, stop_sell: false },
  '2026-09-25': { rate: '199.00', availability: 1, stop_sell: false },  // aucun prix au coeur
  '2026-11-05': { rate: '199.00', availability: 0, stop_sell: true }     // fermee : ne coute rien
}

test('le chiffrage rend le cout exact, dans les deux sens', () => {
  const b = chiffrerEcartDePrix(LIGNES, PAR_DATE)
  assert.strictEqual(b.sous_vendues, 2, '20/09 (219→199) et 02/10 (229→199)')
  assert.strictEqual(b.manque_a_gagner, 50, '20 € + 30 €')
  assert.strictEqual(b.sur_vendues, 1, '21/09 : 169 € voulu, 199 € payes')
  assert.strictEqual(b.trop_paye, 30)
  assert.strictEqual(b.sans_prix_vendables, 1, '25/09 : vendable sans aucun prix saisi')
})

test('une nuit FERMEE chez le provider ne coute rien', () => {
  // 05/11 : 300 € au coeur, 199 € affiches — mais stop_sell. Personne ne peut
  // l'acheter : la compter gonflerait l'alerte et la rendrait inutilisable.
  const b = chiffrerEcartDePrix(LIGNES, PAR_DATE)
  assert.ok(!b.nuits.some(n => n.date === '2026-11-05'))
})

test('le message CHIFFRE, il ne qualifie pas', () => {
  const m = messageContradiction('Ofuro Futari', chiffrerEcartDePrix(LIGNES, PAR_DATE))
  assert.match(m, /2 nuit\(s\) vendue\(s\) 199 € au lieu de votre grille/)
  assert.match(m, /50 € de manque a gagner/)
  assert.match(m, /1 nuit\(s\) vendue\(s\) 30 € TROP CHER au voyageur/)
  assert.match(m, /1 nuit\(s\) vendable\(s\) sans aucun prix/)
  assert.match(m, /Passez le logement en « HoteSmart gere mes prix »/, 'et dit QUOI FAIRE')
})

test('les trois faits doivent etre vrais ENSEMBLE', () => {
  const base = { bien: BIEN, canauxActifs: ['AirBNB'], lignes: LIGNES, parDate: PAR_DATE }
  assert.strictEqual(jugerContradiction(base).contradiction, true)
  // mode managed -> le cas normal, aucune alerte
  assert.strictEqual(jugerContradiction({ ...base, bien: { ...BIEN, rate_sync_mode: 'managed' } }).verdict, 'mode_managed')
  // aucun canal actif -> `keep` est legitime (bascule en cours, rien de vendable)
  assert.strictEqual(jugerContradiction({ ...base, canauxActifs: [] }).verdict, 'aucun_canal_actif')
  // aucune date tarifee -> l'hote n'a rien saisi, rien ne se contredit
  assert.strictEqual(jugerContradiction({ ...base, lignes: [] }).verdict, 'aucune_date_tarifee')
})

test('canaux ILLISIBLES : on s abstient, on ne conclut pas « pas de contradiction »', () => {
  // Conclure sur une panne, c'est le faux vert que ce depot paie depuis trois
  // jours. `incertain` le dit explicitement.
  const v = jugerContradiction({ bien: BIEN, canauxActifs: null, lignes: LIGNES, parDate: PAR_DATE })
  assert.strictEqual(v.verdict, 'canaux_illisibles')
  assert.strictEqual(v.contradiction, false)
  assert.strictEqual(v.incertain, true)
})

test('la contradiction existe meme sans ecart chiffrable', () => {
  // Provider illisible, ou prix identiques par hasard : l'hote tarife chez nous
  // et rien ne part. Le chiffrage precise le cout, il ne le conditionne pas.
  const v = jugerContradiction({ bien: BIEN, canauxActifs: ['AirBNB'], lignes: LIGNES, parDate: {} })
  assert.strictEqual(v.contradiction, true)
  assert.strictEqual(v.manque_a_gagner, 0)
})

// ═══════════════════════════════════════════════════════════════════════════
// LE RUNNER — l'incident part, et il porte les chiffres
// ═══════════════════════════════════════════════════════════════════════════
function doubles ({ canaux = [{ attributes: { channel: 'AirBNB', is_active: true } }],
                    okCanaux = true, lignes = LIGNES, erreurCoeur = null, parDate = PAR_DATE }) {
  const incidents = []
  const appels = []
  const channelCall = async (m, chemin) => {
    appels.push(chemin)
    if (chemin.startsWith('/channels')) return { ok: okCanaux, json: { data: canaux } }
    return { ok: true, json: { data: { 'rp-base': parDate } } }
  }
  const supabase = { from: () => { const q = {
    select: () => q, eq: () => q, gte: () => q, lte: () => q,
    limit: async () => ({ data: lignes, error: erreurCoeur })
  }; return q } }
  return { supabase, channelCall, appels, incidents,
    reportIncident: async (type, opts) => { incidents.push({ type, opts }) } }
}

test('un bien en `managed` ne coute AUCUN appel reseau', async () => {
  const d = doubles({})
  const v = await surveillerContradictionPrix(d.supabase, { ...BIEN, rate_sync_mode: 'managed' }, d)
  assert.strictEqual(v.contradiction, false)
  assert.deepStrictEqual(d.appels, [], 'la porte d entree doit etre gratuite')
})

test('la contradiction leve un INCIDENT FONDATEUR, avec les chiffres', async () => {
  const d = doubles({})
  const v = await surveillerContradictionPrix(d.supabase, BIEN, d)
  assert.strictEqual(v.contradiction, true)
  assert.strictEqual(d.incidents.length, 1, 'exactement un incident')
  const inc = d.incidents[0]
  assert.strictEqual(inc.type, 'prix_non_pousses')
  assert.strictEqual(inc.opts.threshold, 1, 'une seule occurrence suffit : ca coute de l argent')
  assert.strictEqual(inc.opts.propertyName, 'Ofuro Futari')
  assert.strictEqual(inc.opts.detail.manque_a_gagner, 50)
  assert.strictEqual(inc.opts.detail.sur_vendues, 1)
  assert.strictEqual(inc.opts.detail.trop_paye, 30)
  assert.strictEqual(inc.opts.detail.sans_prix_vendables, 1)
  assert.ok(Array.isArray(inc.opts.detail.exemples) && inc.opts.detail.exemples.length,
    'des nuits nommees, pour que l hote verifie')
  assert.match(inc.opts.detail.message, /manque a gagner/)
})

test('aucun incident quand il n y a pas de contradiction', async () => {
  const d = doubles({ canaux: [{ attributes: { channel: 'AirBNB', is_active: false } }] })
  const v = await surveillerContradictionPrix(d.supabase, BIEN, d)
  assert.strictEqual(v.verdict, 'aucun_canal_actif')
  assert.strictEqual(d.incidents.length, 0)
})

test('lecture des canaux en echec : aucun incident, mais on le DIT', async () => {
  const d = doubles({ okCanaux: false })
  const v = await surveillerContradictionPrix(d.supabase, BIEN, d)
  assert.strictEqual(v.verdict, 'canaux_illisibles')
  assert.strictEqual(v.incertain, true)
  assert.strictEqual(d.incidents.length, 0, 'on n alerte pas sur une incertitude')
})

test('lecture du coeur en echec ne se lit PAS « aucune date tarifee »', async () => {
  const d = doubles({ erreurCoeur: { message: 'timeout' } })
  const v = await surveillerContradictionPrix(d.supabase, BIEN, d)
  assert.strictEqual(v.verdict, 'coeur_illisible')
  assert.strictEqual(v.incertain, true)
})

test("un incident qui echoue ne casse pas la surveillance", async () => {
  const d = doubles({})
  d.reportIncident = async () => { throw new Error('canal fondateur injoignable') }
  const v = await surveillerContradictionPrix(d.supabase, BIEN, d)
  assert.strictEqual(v.contradiction, true, 'le verdict reste rendu')
})

test('le cron branche la surveillance, et dans SON PROPRE try', () => {
  const fs = require('node:fs'); const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-channel-props.js'), 'utf8')
  assert.match(src, /await surveillerContradictionPrix\(supabase, p, \{ channelCall, reportIncident \}\)/)
  // ⚠ ISOLEMENT : le 10 septembre, une exception dans le premier appel du try
  // commun a emporte `processArrivalCodes` pendant 24 h.
  const i = src.indexOf('surveillerContradictionPrix(supabase')
  const avant = src.slice(0, i)
  assert.ok(avant.lastIndexOf('try {') > avant.lastIndexOf('await processMessageTemplates'),
    'la surveillance a son propre try/catch')
  assert.match(src, /rate_sync_mode, capacity/, 'le SELECT lit le mode — sinon la porte d entree est aveugle')
})
