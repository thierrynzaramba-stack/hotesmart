// tests/controle-marche.test.js — le controle permanent (V2.5) et le verrou de
// la regle 19.
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - un ecart qui juge la methode contre la MAUVAISE grille (mesuree 3 ans :
//     il contiendrait de la derive, pas de la methode) ;
//   - une grille mesuree qui contient du menage comparee au marche (hors
//     menage) SANS LE DIRE — et, a l'inverse, un bien bloque en entier par une
//     liste d'UUID recopiee (retiree le 24 septembre, elle mentait en staging) ;
//   - un ecart — ou un niveau marche, qui le donne par soustraction — qui sort
//     de l'API AVANT que le critere de l'interrupteur soit fixe (regle 19).
//
// CONTRE-EPREUVE (regle 19) : contre un releve qui compare au 3 ans, « l ecart
// juge contre la mesuree 12 mois » rougit ; contre un endpoint qui rend les
// niveaux quel que soit le verrou, « le verrou » rougit. Rejoue le 24 septembre.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { construireReleve, grilleMesureeDouzeMois } = require('../lib/marche/controle')
const { menageFacture, sejoursAvecMenage } = require('../lib/marche/menage')
const { relevesLisibles, CRITERE_INTERRUPTEUR, ETAPE_3_EN_PLACE } = require('../lib/marche/critere')
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
  assert.deepEqual(r.ecarts[0], { nom: 'Base', marche: 115, mesure_12m: 110, ecart_eur: 5, ecart_pct: 4.5,
    mesure_12m_airbnb: null, ecart_airbnb_eur: null, ecart_airbnb_pct: null })
  assert.equal(r.ecarts[2].ecart_eur, -5, 'Haut : 135 marche contre 140 mesure 12 mois — PAS contre le 3 ans')
  assert.equal(r.fenetre_debut, '2025-09-01')
  assert.equal(r.fenetre_fin, '2026-08-31')
  assert.deepEqual(r.niveaux_mesure_3ans.map(n => n.prix), [115, 125, 140, 155, 165], 'le 3 ans est garde, a cote')
})

// ⚠ REECRIT LE 24 SEPTEMBRE 2026 (regle 17) : la premiere version exigeait
// « Coeur de vie 23 en attente, aucun ecart » par une liste d'UUID. Thierry a
// leve l'attente : la fenetre de 12 mois de ce bien est propre ; seule la
// mesuree 3 ans contient du menage, et elle le DIT.
test('LE TEST QUI COMPTE : Coeur de vie 23 n est plus en attente — son ecart se calcule, sa mesuree 3 ans porte le drapeau menage', () => {
  const r = construireReleve({ bien: COEUR, marche: marche(), mesure12, grille3ans, motif: 'mensuel', releveLe: '2026-10-01T00:00:00Z',
    menage: { trois_ans: 113, douze_mois: 0 } })
  assert.equal(r.statut, 'fiable')
  assert.equal(r.ecarts.length, 5)
  assert.match(r.avertissements.find(a => a.type === 'menage_mesure_3ans').phrase, /3 ans contient des frais de ménage \(113 séjour\(s\), dette 26\)/)
  assert.ok(!r.avertissements.some(a => a.type === 'menage_mesure_12m'), 'la fenetre de 12 mois est propre : pas de drapeau')
  const sale = construireReleve({ bien: COEUR, marche: marche(), mesure12, grille3ans, motif: 'mensuel', releveLe: '2026-10-01T00:00:00Z',
    menage: { trois_ans: 5, douze_mois: 2 } })
  assert.equal(sale.statut, 'fiable', 'un drapeau, jamais un blocage')
  assert.ok(sale.avertissements.some(a => a.type === 'menage_mesure_12m'))
})

test('LE TEST QUI COMPTE : le menage se lit dans les trois formes vues en production, montant POSITIF seulement', () => {
  assert.equal(menageFacture({ invoiceItems: [{ description: 'frais de ménage', type: 'charge', qty: 1, amount: 40, lineTotal: 40 }] }), true)
  assert.equal(menageFacture({ rateDescription: 'Base Price 480 EUR\nCleaning 45 EUR' }), true)
  assert.equal(menageFacture({ rooms: [{ services: [{ name: 'Cleaning Fee', type: 'Cleaning Fee', total_price: '20.00' }] }] }), true)
  assert.equal(menageFacture({ rateDescription: 'Cleaning 0 EUR' }), false, 'zero euro n est pas un menage facture')
  assert.equal(menageFacture({ invoiceItems: [{ description: 'frais de ménage', lineTotal: 0 }] }), false)
  assert.equal(menageFacture({ rateDescription: 'Base Price 480 EUR' }), false)
  assert.equal(menageFacture(null), false)
  // Review du 24 septembre : une ligne de PAIEMENT n'est pas un frais ;
  // « Ménage 45 EUR » se lit ; « Cleaning -45 » (remise) ne se lit pas.
  assert.equal(menageFacture({ invoiceItems: [{ description: 'ménage', type: 'payment', lineTotal: 45 }] }), false)
  assert.equal(menageFacture({ invoiceItems: [{ description: 'ménage', lineTotal: 45 }] }), true, 'type absent : garde')
  assert.equal(menageFacture({ rateDescription: 'Ménage 45 EUR' }), true)
  assert.equal(menageFacture({ rateDescription: 'Cleaning -45 EUR' }), false)
  // Par fenetre : seuls les sejours COMPTES ayant une nuit dedans.
  const lignes = [{ raw: { rateDescription: 'Cleaning 45 EUR' } }, { raw: { rateDescription: 'Cleaning 45 EUR' } }, { raw: { rateDescription: 'Cleaning 45 EUR' } }]
  const ecl = [{ compte: true, nuits: [{ date: '2024-02-10' }] }, { compte: false, nuits: [] }, { compte: true, nuits: [{ date: '2026-01-10' }] }]
  assert.equal(sejoursAvecMenage(lignes, ecl, '2023-09-24', '2026-09-23'), 2)
  assert.equal(sejoursAvecMenage(lignes, ecl, '2025-09-01', '2026-08-31'), 1)
})

test('LE TEST QUI COMPTE : la variante Airbnb est un DIAGNOSTIC — l ecart qui juge reste contre les ventes tous canaux', () => {
  const air = { niveaux: NIV([100, 120, 130, 150, 160]), nuits: 150 }
  const r = construireReleve({ bien: BULLE, marche: marche(), mesure12, mesure12Airbnb: air, grille3ans, motif: 'mensuel', releveLe: '2026-10-01T00:00:00Z' })
  assert.deepEqual(r.ecarts[0], { nom: 'Base', marche: 115, mesure_12m: 110, ecart_eur: 5, ecart_pct: 4.5,
    mesure_12m_airbnb: 100, ecart_airbnb_eur: 15, ecart_airbnb_pct: 15 })
  assert.equal(r.nuits_mesure_12m_airbnb, 150)
  assert.deepEqual(r.niveaux_mesure_12m_airbnb.map(n => n.prix), [100, 120, 130, 150, 160])
  // Le filtre : seules les nuits Airbnb (Beds24 ou Channex, casse indifferente).
  const ctx = R.construireContexte({ zoneBien: 'C', vacances: [], debut: '2024-01-01', fin: '2026-12-31' })
  const ecl = (d, prix, id, canal) => ({ compte: true, canal, booking_id: id, nuits: [{ date: d, prix, hors_reference: false }] })
  const lignes = []
  for (let i = 0; i < 30; i++) lignes.push(ecl(`2025-10-${String(1 + i % 28).padStart(2, '0')}`, 100, `A${i}`, i % 2 ? 'Airbnb' : 'airbnb'))
  for (let i = 0; i < 30; i++) lignes.push(ecl(`2025-11-${String(1 + i % 28).padStart(2, '0')}`, 200, `B${i}`, 'booking'))
  const f = { debut: '2025-09', fin: '2026-08' }
  assert.equal(grilleMesureeDouzeMois({ eclatements: lignes, contexte: ctx, fenetre: f }).nuits, 60)
  const a = grilleMesureeDouzeMois({ eclatements: lignes, contexte: ctx, fenetre: f, airbnbSeul: true })
  assert.equal(a.nuits, 30)
  assert.ok(a.niveaux.every(n => n.prix_mesure === 100), 'aucune nuit Booking a 200 € dans la variante Airbnb')
})

test('LE TEST QUI COMPTE : marche fiable mais ventes du bien trop minces = mesure insuffisante, pas reference amincie', () => {
  const r = construireReleve({ bien: BULLE, marche: marche(), mesure12: { niveaux: null, nuits: 12 }, grille3ans, motif: 'mensuel', releveLe: '2026-10-01T00:00:00Z' })
  assert.equal(r.statut, 'mesure_insuffisante')
  assert.equal(r.ecarts, null)
  assert.match(r.avertissements.find(a => a.type === 'mesure_insuffisante').phrase, /Vos ventes sur la même période \(12 nuits\)/)
})

// ⚠ REECRIT LE 24 SEPTEMBRE 2026 (regle 17) : « sans ecart » suivait la
// premiere decision 7 (aucun niveau sous le seuil), renversee par Thierry.
test('reference amincie : releve ecrit avec les niveaux ET l ecart, marques par le statut', () => {
  const amincie = { ...marche('reference_amincie'), niveaux: NIV([115, 125, 135, 150, 160]) }
  const r = construireReleve({ bien: BULLE, marche: amincie, mesure12, grille3ans, motif: 'rafraichissement', releveLe: '2026-10-01T00:00:00Z' })
  assert.equal(r.statut, 'reference_amincie')
  assert.equal(Array.isArray(r.ecarts), true, 'l ecart existe des que les deux grilles existent')
  assert.equal(r.ecarts[0].ecart_eur, 5)
  assert.ok(r.avertissements.some(a => a.type === 'reference_amincie'))
  // Marche amincie ET ventes trop minces : le statut dit l'un, l'avertissement
  // dit l'autre (review).
  const deuxFois = construireReleve({ bien: BULLE, marche: amincie, mesure12: { niveaux: null, nuits: 9 }, grille3ans, motif: 'rafraichissement', releveLe: '2026-10-01T00:00:00Z' })
  assert.equal(deuxFois.statut, 'reference_amincie')
  assert.ok(deuxFois.avertissements.some(x => x.type === 'mesure_insuffisante'))
  // Sans niveau du tout (trop peu de nuits pour un quantile) : pas d'ecart.
  const vide = construireReleve({ bien: BULLE, marche: marche('reference_amincie'), mesure12, grille3ans, motif: 'rafraichissement', releveLe: '2026-10-01T00:00:00Z' })
  assert.equal(vide.ecarts, null)
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

// ⚠ REECRIT LE 24 SEPTEMBRE 2026 (regle 17) : la premiere version exigeait
// un critere `null`. Il est desormais fixe et grave ; le verrou tient par le
// second drapeau (l'etape 3 n'est pas en place). Le test verifie les DEUX.
test('LE TEST QUI COMPTE : le verrou de la regle 19 — critere grave, mais aucun niveau ni ecart ne sort tant que l etape 3 n est pas en place', async () => {
  assert.notEqual(CRITERE_INTERRUPTEUR, null, 'le critere est grave')
  assert.equal(CRITERE_INTERRUPTEUR.fixe_le, '2026-09-24')
  assert.match(CRITERE_INTERRUPTEUR.texte, /^CRITÈRE DE L'INTERRUPTEUR V2\.6 — fixé et daté le 24 septembre 2026/)
  assert.match(CRITERE_INTERRUPTEUR.texte, /Un critère assoupli après avoir vu les chiffres ne vaut rien\.$/)
  assert.equal(ETAPE_3_EN_PLACE, false, 'aucun ecart lu avant l etape 3 (Thierry, 24 septembre 2026)')
  assert.equal(relevesLisibles(), false, 'graver le critere n ouvre pas l affichage')
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
