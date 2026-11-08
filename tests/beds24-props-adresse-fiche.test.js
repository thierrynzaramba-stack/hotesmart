// tests/beds24-props-adresse-fiche.test.js
// Chemin Beds24 : l'adresse que recoit le voyageur est celle de la FICHE.
//
// ⚠ CONSTAT IMPORTANT DE LA REVIEW 1 DU LOT « Accueil du voyageur ». Sur le
// chemin Beds24, les messages programmes, l'IA et le message du code lisent
// l'objet rendu par `fetchProperties` : son `address` est celle de BEDS24. La
// fiche, elle, affiche `properties.address` — que l'hote peut modifier, sans
// que rien ne la renvoie a Beds24. « Une seule adresse : celle de la fiche »
// exige donc que l'objet Beds24 porte l'adresse de la fiche, et
// `materializeBeds24Properties` la pose depuis la lecture qu'il fait deja.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

function injecter (chemin, exports) {
  const abs = require.resolve(chemin)
  const m = new Module(abs)
  m.exports = exports
  m.loaded = true
  require.cache[abs] = m
  return abs
}

function charger ({ lignes }) {
  const selects = []
  const table = () => {
    const filtre = {}
    let colonnes = null
    const q = {
      select (c) { colonnes = c; selects.push(c); return q },
      eq (col, val) { filtre[col] = String(val); return q },
      is () { return q },
      maybeSingle: async () => ({
        data: lignes[filtre.provider_property_id] || null, error: null, colonnes
      }),
      insert: async () => ({ error: null }),
      update () { return { eq: () => ({ is: async () => ({ error: null }), then: (r) => r({ error: null }) }) } }
    }
    return q
  }
  const chemins = [
    injecter('../lib/cron-shared', { supabase: { from: table } }),
    injecter('../lib/billing', { syncAccountBilling: async () => {} }),
    injecter('../lib/cles-migrees', { clesMigrees: async () => new Set() }),
    injecter('../lib/biens-vivants', {
      clesArchivees: async () => ({ complet: true, cles: new Set() }),
      cleDuBien: (u, p) => `${u}|${p}`
    })
  ]
  delete require.cache[require.resolve('../lib/cron-beds24-props')]
  const mod = require('../lib/cron-beds24-props')
  delete require.cache[require.resolve('../lib/cron-beds24-props')]
  for (const c of chemins) delete require.cache[c]
  return { mod, selects }
}

test('LE TEST QUI COMPTE : l objet Beds24 porte l adresse de la fiche, et le remplaceur la prend', async () => {
  const { replisDuBien, remplacerBalises } = require('../lib/balises')
  const { mod } = charger({ lignes: { 111: { id: 'uuid-1', active_at: '2026-01-01', address: 'Adresse de la fiche' } } })
  const biens = [{ id: 111, name: 'Gite', address: 'Adresse Beds24' }]
  await mod.materializeBeds24Properties('u1', biens, {})
  assert.strictEqual(biens[0].adresseFiche, 'Adresse de la fiche')
  const r = remplacerBalises('{adresse}', { connaissance: {}, replis: replisDuBien(biens[0]) })
  assert.strictEqual(r.texte, 'Adresse de la fiche')
})

test('une fiche SANS adresse ne retombe pas sur Beds24 : c est un manque, que l apercu montre aussi', async () => {
  const { replisDuBien, remplacerBalises } = require('../lib/balises')
  const { mod } = charger({ lignes: { 111: { id: 'uuid-1', active_at: '2026-01-01', address: null } } })
  const biens = [{ id: 111, name: 'Gite', address: 'Adresse Beds24' }]
  await mod.materializeBeds24Properties('u1', biens, {})
  assert.strictEqual(biens[0].adresseFiche, '')
  const r = remplacerBalises('{adresse}', { connaissance: {}, replis: replisDuBien(biens[0]) })
  assert.deepStrictEqual(r.manquants, ['adresse'],
    'le voyageur recevrait une adresse que la fiche et l apercu disent manquante (S1)')
})

test('bien neuf (materialise a ce cycle) : la fiche vient d etre ecrite avec l adresse Beds24', async () => {
  const { mod } = charger({ lignes: {} })
  const biens = [{ id: 222, name: 'Neuf', address: 'Adresse Beds24' }]
  await mod.materializeBeds24Properties('u1', biens, {})
  assert.strictEqual(biens[0].adresseFiche, 'Adresse Beds24')
})

test('aucune requete de plus : l adresse vient du SELECT qui existait deja', async () => {
  const { mod, selects } = charger({ lignes: { 111: { id: 'uuid-1', active_at: '2026-01-01', address: 'X' } } })
  await mod.materializeBeds24Properties('u1', [{ id: 111, name: 'Gite' }], {})
  const lecturesDuBien = selects.filter(c => /active_at/.test(c))
  assert.strictEqual(lecturesDuBien.length, 1)
  assert.ok(/address/.test(lecturesDuBien[0]))
})

test('objet NON decore (materialisation qui a renonce) : l adresse du provider reste le repli', () => {
  const { replisDuBien } = require('../lib/balises')
  assert.strictEqual(replisDuBien({ address: 'Adresse Beds24' }).adresse, 'Adresse Beds24')
  // Et les autres chemins, ou `address` EST la fiche, ne changent pas.
  assert.strictEqual(replisDuBien({ address: '12 rue des Lilas' }).adresse, '12 rue des Lilas')
})
