// tests/charges-lecture.test.js — la lecture d'une facture par l'IA
// (lib/charges/lecture.js ; spec §6 « La lecture », §7).
//
// ⚠ TROIS ISSUES QUI NE SE CONFONDENT JAMAIS : `ok`, `echec` (compte pour les
// trois tentatives) et `panne` (ne compte pas). Confondre une panne avec un
// échec rendrait « illisibles » toutes les factures en attente pendant un
// quart d'heure de surcharge.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const { lireDocument, estPanne, extraireJson, DELAI_IA_MS } = require('../lib/charges/lecture')
const { contexteIA } = require('../lib/ia/journal')

const PDF = Buffer.from('%PDF-1.7\nfacture\n')
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3])

function client (reponse, erreur) {
  const demandes = []
  const options = []
  let contexte = null
  return {
    demandes,
    options,
    contexte: () => contexte,
    messages: {
      create: async (d, o) => {
        demandes.push(d)
        options.push(o)
        contexte = contexteIA()
        if (erreur) throw erreur
        return reponse
      }
    }
  }
}
const texte = (t) => ({ model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: t }] })

test('un PDF part en bloc `document`, une image en bloc `image`, avec l’étiquette du journal', async () => {
  const c = client(texte('{"montant_ttc": 12, "fournisseur_nom": "EDF"}'))
  const r = await lireDocument({ octets: PDF, type: 'application/pdf', compte: 'u1' }, { client: c })
  assert.equal(r.ok, true)
  assert.equal(c.demandes[0].messages[0].content[0].type, 'document')
  assert.equal(c.demandes[0].messages[0].content[0].source.media_type, 'application/pdf')
  assert.equal(c.contexte().fonction, 'charges-lecture')
  assert.equal(c.contexte().userId, 'u1')
  const c2 = client(texte('{"montant_ttc": 12}'))
  await lireDocument({ octets: JPEG, type: 'image/jpeg', compte: 'u1' }, { client: c2 })
  assert.equal(c2.demandes[0].messages[0].content[0].type, 'image')
})

test('la réponse est normalisée : rien d’inventé, une TVA lue à 0 reste 0', async () => {
  const c = client(texte('Voici : {"fournisseur_nom": "Orange", "montant_ht": 50, "montant_tva": 0, "montant_ttc": 50, "date_facture": "2026-13-40", "categorie": "internet_telephone"} fin'))
  const r = await lireDocument({ octets: PDF, type: 'application/pdf', compte: 'u1' }, { client: c })
  assert.equal(r.lu.montant_tva_cents, 0)
  assert.equal(r.lu.date_facture, null, 'une date impossible n’est pas une date')
  assert.equal(r.lu.categorie, 'internet_telephone')
})

test('une réponse sans JSON, ou un JSON où rien n’est lu, est un ÉCHEC', async () => {
  assert.equal((await lireDocument({ octets: PDF, type: 'application/pdf' }, { client: client(texte('Je ne peux pas lire.')) })).echec, true)
  const vide = await lireDocument({ octets: PDF, type: 'application/pdf' }, { client: client(texte('{"fournisseur_nom": null}')) })
  assert.equal(vide.echec, true)
  assert.equal(vide.motif, 'rien_lu')
})

test('⚠ PANNE et non échec : réseau, surcharge, quota, clé, crédit épuisé', async () => {
  for (const e of [
    Object.assign(new Error('fetch failed'), {}),
    Object.assign(new Error('Overloaded'), { status: 529 }),
    Object.assign(new Error('rate'), { status: 429 }),
    Object.assign(new Error('auth'), { status: 401 }),
    Object.assign(new Error('Your credit balance is too low'), { status: 400 })
  ]) {
    const r = await lireDocument({ octets: PDF, type: 'application/pdf' }, { client: client(null, e) })
    assert.equal(r.panne, true, e.message)
  }
})

test('un refus de CE document (400 hors crédit) est un échec, pas une panne', async () => {
  const e = Object.assign(new Error('Could not process PDF'), { status: 400 })
  assert.equal(estPanne(e), false)
  const r = await lireDocument({ octets: PDF, type: 'application/pdf' }, { client: client(null, e) })
  assert.equal(r.echec, true)
})

test('un type non lisible n’appelle pas l’IA', async () => {
  const c = client(texte('{}'))
  const r = await lireDocument({ octets: Buffer.from('x'), type: 'text/plain' }, { client: c })
  assert.equal(r.echec, true)
  assert.equal(c.demandes.length, 0)
})

test('extraireJson : le premier objet d’un texte, ou null', () => {
  assert.deepEqual(extraireJson('a {"x": 1} b'), { x: 1 })
  assert.equal(extraireJson('pas de json'), null)
  assert.equal(extraireJson('{cassé'), null)
})

test('⚠ une lecture a un DÉLAI et aucune nouvelle tentative du SDK (sinon dix minutes, au-delà du mur de 60 s)', async () => {
  const c = client(texte('{"montant_ttc": 12}'))
  await lireDocument({ octets: PDF, type: 'application/pdf', compte: 'u1' }, { client: c })
  assert.deepEqual(c.options[0], { timeout: DELAI_IA_MS, maxRetries: 0 })
  assert.ok(DELAI_IA_MS <= 20000)
  const lent = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })
  const r = await lireDocument({ octets: PDF, type: 'application/pdf', compte: 'u1' }, { client: client(null, lent) })
  assert.equal(r.panne, true, 'un délai dépassé ne compte pas comme un échec')
})

test('⚠ 404 (modèle ou route introuvable) est une PANNE de configuration, jamais l’échec de CE document', () => {
  assert.equal(estPanne({ status: 404, message: 'model: not_found' }), true)
})

// ─── Lot 7a : la consigne lit le type, la période et le solde ───────────────
test('la consigne demande le type de document, la période couverte et le solde d\'une régularisation', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'charges', 'lecture.js'), 'utf8')
  for (const cle of ['"type_document"', '"periode_debut"', '"periode_fin"', '"solde_ttc"']) assert.ok(src.includes(cle), cle)
  // Les types de la consigne sont ceux de la base.
  for (const t of require('../lib/charges/regles').TYPES_DOCUMENT) assert.ok(src.includes(`"${t}"`), t)
  assert.match(src, /TOTAL facturé pour la période \(abonnement, énergie et taxes compris\), AVANT déduction des mensualités/)
})

test('LE TEST QUI COMPTE (Thierry, 18 novembre 2026) : sur une facture d\'ÉNERGIE, la consigne fait chercher la période des RELEVÉS dans toutes les pages', async () => {
  // Vécu en production : une régularisation EDF de 5 856,48 € lue sans
  // période — la consommation n'était écrite qu'en page 2 du détail. Sans
  // période, tout tombait sur le mois de la date.
  const { CONSIGNE } = require('../lib/charges/lecture')
  assert.match(CONSIGNE, /facture, une régularisation ou un avoir d'ÉNERGIE \(électricité, gaz, eau\) — pas un échéancier/)
  assert.match(CONSIGNE, /cherche-la dans TOUTES les pages/)
  assert.match(CONSIGNE, /14\/03\/24 donne 2024-03-14/, 'l\'année sur deux chiffres')
  assert.match(CONSIGNE, /Ne prends PAS la période de l'abonnement/)
  assert.match(CONSIGNE, /prends la période des relevés du contrat d'ÉLECTRICITÉ/)
  // ⚠ L'EXEMPLE N'EST PAS LA FACTURE DE PRODUCTION (review, constat 3) :
  // sinon sa relecture ne prouverait rien, et l'IA pourrait recopier ses dates.
  assert.doesNotMatch(CONSIGNE, /26\/09\/24|25\/09\/25/)
  // ⚠ L'UNION DES CONTRATS N'EST PLUS DEMANDÉE (review, constat 1) : elle
  // fabriquait des périodes de plus de 366 jours, refusées par la normalisation.
  assert.doesNotMatch(CONSIGNE, /le plus ancien et le dernier jour le plus récent/)
  // Et c'est bien CE texte qui part à l'IA (review, constat 5).
  const c = client(texte('{"montant_ttc": 12}'))
  await lireDocument({ octets: PDF, type: 'application/pdf', compte: 'u1' }, { client: c })
  assert.equal(c.demandes[0].messages[0].content[1].text, CONSIGNE)
})

test('une régularisation lue sur un an de relevés garde sa période, et sur 374 jours aussi ; au-delà de trois ans, elle tombe à null MAIS garde sa trace', async () => {
  const regul = (debut, fin) => texte(JSON.stringify({ type_document: 'regularisation', montant_ttc: 5856.48, montant_ht: 4932.24, montant_tva: 924.24, solde_ttc: 1916.83, periode_debut: debut, periode_fin: fin }))
  const c = client(regul('2024-09-26', '2025-09-25'))
  const r = await lireDocument({ octets: PDF, type: 'application/pdf', compte: 'u1' }, { client: c })
  assert.deepEqual([r.lu.periode_debut, r.lu.periode_fin, r.lu.periode_refusee], ['2024-09-26', '2025-09-25', null])
  // 374 jours : refusés au lot 7a, gardés depuis la borne de trois ans.
  const c1 = client(regul('2024-09-20', '2025-09-28'))
  const r1 = await lireDocument({ octets: PDF, type: 'application/pdf', compte: 'u1' }, { client: c1 })
  assert.deepEqual([r1.lu.periode_debut, r1.lu.periode_fin, r1.lu.periode_refusee], ['2024-09-20', '2025-09-28', null])
  const c2 = client(regul('2021-09-20', '2025-09-28'))
  const r2 = await lireDocument({ octets: PDF, type: 'application/pdf', compte: 'u1' }, { client: c2 })
  assert.deepEqual([r2.lu.periode_debut, r2.lu.periode_fin], [null, null], 'quatre ans : au-delà de la borne de la base')
  assert.deepEqual(r2.lu.periode_refusee, { debut: '2021-09-20', fin: '2025-09-28', motif: 'periode_trop_longue' })
  // Rien de lu : pas de trace inventée.
  const c3 = client(texte('{"montant_ttc": 12}'))
  const r3 = await lireDocument({ octets: PDF, type: 'application/pdf', compte: 'u1' }, { client: c3 })
  assert.equal(r3.lu.periode_refusee, null)
})
