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
const { lireDocument, estPanne, extraireJson } = require('../lib/charges/lecture')
const { contexteIA } = require('../lib/ia/journal')

const PDF = Buffer.from('%PDF-1.7\nfacture\n')
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3])

function client (reponse, erreur) {
  const demandes = []
  let contexte = null
  return {
    demandes,
    contexte: () => contexte,
    messages: {
      create: async (d) => {
        demandes.push(d)
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
