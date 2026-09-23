// tests/controle-marche.test.js — le controle permanent (V2.5) et le verrou de
// la regle 19.
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - un ecart qui juge la methode contre la MAUVAISE grille (mesuree 3 ans :
//     il contiendrait de la derive, pas de la methode) ;
//   - Coeur de vie 23 compare avant la dette 26 (menage dans son historique) ;
//   - un ecart — ou un niveau marche, qui le donne par soustraction — qui sort
//     de l'API AVANT que le critere de l'interrupteur soit fixe (regle 19).
//
// CONTRE-EPREUVE (regle 19) : contre un releve qui compare au 3 ans, « l ecart
// juge contre la mesuree 12 mois » rougit ; contre un endpoint qui rend les
// niveaux quel que soit le verrou, « le verrou » rougit. Rejoue le 24 septembre.

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { construireReleve, grilleMesureeDouzeMois, EN_ATTENTE_DETTE_26 } = require('../lib/marche/controle')
const { relevesLisibles, CRITERE_INTERRUPTEUR } = require('../lib/marche/critere')
const R = require('../lib/yield/reference')

const NIV = prix => ['Base', 'Moyen', 'Haut', 'Très haut', 'Exceptionnel'].map((nom, i) => ({ nom, prix: prix[i] }))
const BULLE = { id: '091d9abf-ff86-45ce-8123-3425e6f3900f', user_id: 'u' }
const COEUR = { id: 'efe1daf1-652c-4177-b29b-19f1db377c96', user_id: 'u' }
const marche = (statut = 'fiable') => ({ statut, fenetre: { debut: '2025-09', fin: '2026-08' }, nuits: 600,
  niveaux: statut === 'fiable' ? NIV([115, 125, 135, 150, 160]) : null, comparables: [], avertissements: [], motifs: statut === 'fiable' ? [] : ['2 comparable(s)'] })
const mesure12 = { niveaux: NIV([110, 125, 140, 155, 165]), nuits: 280 }
const grille3ans = { base: { fiable: true, niveaux: NIV([115, 125, 140, 155, 165]) } }

test('LE TEST QUI COMPTE : l ecart juge contre la MESUREE 12 MOIS, sur la meme fenetre', () => {
  const r = construireReleve({ bien: BULLE, marche: marche(), mesure12, grille3ans, motif: 'mensuel', releveLe: '2026-10-01T00:00:00Z' })
  assert.equal(r.statut, 'fiable')
  assert.equal(r.source, 'marche')
  assert.deepEqual(r.ecarts[0], { nom: 'Base', marche: 115, mesure_12m: 110, ecart_eur: 5, ecart_pct: 4.5 })
  assert.equal(r.ecarts[2].ecart_eur, -5, 'Haut : 135 marche contre 140 mesure 12 mois — PAS contre le 3 ans')
  assert.equal(r.fenetre_debut, '2025-09-01')
  assert.equal(r.fenetre_fin, '2026-08-31')
  assert.deepEqual(r.niveaux_mesure_3ans.map(n => n.prix), [115, 125, 140, 155, 165], 'le 3 ans est garde, a cote')
})

test('LE TEST QUI COMPTE : Coeur de vie 23 attend la dette 26 — aucun ecart calcule', () => {
  assert.ok(EN_ATTENTE_DETTE_26.has(COEUR.id))
  const r = construireReleve({ bien: COEUR, marche: marche(), mesure12, grille3ans, motif: 'mensuel', releveLe: '2026-10-01T00:00:00Z' })
  assert.equal(r.statut, 'attente_dette_26')
  assert.equal(r.ecarts, null)
})

test('LE TEST QUI COMPTE : marche fiable mais ventes du bien trop minces = mesure insuffisante, pas reference amincie', () => {
  const r = construireReleve({ bien: BULLE, marche: marche(), mesure12: { niveaux: null, nuits: 12 }, grille3ans, motif: 'mensuel', releveLe: '2026-10-01T00:00:00Z' })
  assert.equal(r.statut, 'mesure_insuffisante')
  assert.equal(r.ecarts, null)
  assert.match(r.avertissements.find(a => a.type === 'mesure_insuffisante').phrase, /Vos ventes sur la même période \(12 nuits\)/)
})

test('reference amincie : releve ecrit avec les nombres, sans ecart', () => {
  const r = construireReleve({ bien: BULLE, marche: marche('reference_amincie'), mesure12, grille3ans, motif: 'rafraichissement', releveLe: '2026-10-01T00:00:00Z' })
  assert.equal(r.statut, 'reference_amincie')
  assert.equal(r.ecarts, null)
  assert.ok(r.avertissements.some(a => a.type === 'reference_amincie'))
})

test('la mesuree 12 mois vient de la V1, bornee a la fenetre du marche', () => {
  const ctx = R.construireContexte({ zoneBien: 'C', vacances: [], debut: '2024-01-01', fin: '2026-12-31' })
  const ecl = (d, prix, id) => ({ compte: true, booking_id: id, nuits: [{ date: d, prix, hors_reference: false }] })
  const lignes = []
  for (let i = 0; i < 40; i++) lignes.push(ecl(`2025-${String(10 + (i % 3)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`, 100 + (i % 5) * 10, `A${i}`))
  lignes.push(ecl('2024-12-15', 900, 'VIEUX'))   // avant la fenetre : ne compte pas
  lignes.push(ecl('2026-09-05', 900, 'APRES'))   // APRES la fenetre : ne compte pas non plus
  const m = grilleMesureeDouzeMois({ eclatements: lignes, contexte: ctx, fenetre: { debut: '2025-09', fin: '2026-08' } })
  assert.equal(m.nuits, 40, 'les ventes hors de la fenetre, des deux cotes, ne comptent pas')
  assert.ok(m.niveaux.every(n => 'prix_mesure' in n && 'etire' in n), 'les drapeaux de construction voyagent')
})

test('LE TEST QUI COMPTE : le verrou de la regle 19 — aucun niveau ni ecart ne sort tant que le critere n est pas fixe', async () => {
  assert.equal(CRITERE_INTERRUPTEUR, null, 'le critere n est pas encore fixe (24 septembre 2026)')
  assert.equal(relevesLisibles(), false)
  // L'endpoint, avec sa garde et sa base simulees : un releve COMPLET en base.
  // (Adresse locale factice : les modules creent leur client au chargement ;
  // aucune requete ne part, la base est remplacee ci-dessous.)
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'factice-non-secret'
  const racine = path.join(__dirname, '..')
  const cheminGarde = require.resolve(path.join(racine, 'lib', 'require-permission'))
  const vraie = require(cheminGarde)
  require.cache[cheminGarde].exports = { ...vraie, requirePermission: async () => ({ ok: true, bien: { id: BULLE.id }, accountUserId: 'u' }) }
  const cheminSb = require.resolve('@supabase/supabase-js')
  const vraiSb = require(cheminSb)
  const releve = { ...construireReleve({ bien: BULLE, marche: marche(), mesure12, grille3ans, motif: 'mensuel', releveLe: '2026-10-01T00:00:00Z' }), fraicheur_marche: '2026-09-24T00:00:00Z' }
  const q = { select: () => q, eq: () => q, order: () => q, limit: () => Promise.resolve({ data: [releve], error: null }) }
  require.cache[cheminSb].exports = { ...vraiSb, createClient: () => ({ from: () => q }) }
  delete require.cache[require.resolve(path.join(racine, 'api', 'yield-marche'))]
  const api = require(path.join(racine, 'api', 'yield-marche'))
  const corps = await Promise.race([
    new Promise(resolve => {
      const res = { status () { return res }, setHeader () {}, json: resolve }
      api({ method: 'GET', query: { property_id: BULLE.id }, headers: {} }, res)
    }),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('l API n a pas repondu')), 5000))
  ])
  require.cache[cheminGarde].exports = vraie
  require.cache[cheminSb].exports = vraiSb
  assert.equal(corps.etat, 'releve')
  assert.equal(corps.lisible, false)
  for (const cle of ['niveaux_marche', 'niveaux_mesure_12m', 'niveaux_mesure_3ans', 'ecarts', 'comparables', 'avertissements']) {
    assert.ok(!(cle in corps), `${cle} ne sort pas avant le critere`)
  }
  assert.ok(!JSON.stringify(corps).includes('"prix"'), 'aucun prix, nulle part dans la reponse')
  // La liste EXACTE des cles : un niveau ne peut pas fuir sous un autre nom.
  assert.deepEqual(Object.keys(corps).sort(), ['etat', 'fenetre', 'fraicheur_marche', 'lisible', 'nb_comparables', 'releve_le', 'source', 'statut'])
})
