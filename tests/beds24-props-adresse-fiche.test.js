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

function charger ({ lignes, archives = [], archivesIllisibles = false, erreurAdresses = null }) {
  const selects = []
  const lectures = []
  const table = () => {
    const filtre = {}
    let colonnes = null
    let refs = null
    const q = {
      select (c) { colonnes = c; selects.push(c); return q },
      eq (col, val) { filtre[col] = String(val); return q },
      is () { return q },
      in (col, vals) { refs = vals.map(String); return q },
      maybeSingle: async () => ({ data: lignes[filtre.provider_property_id] || null, error: null }),
      // La lecture dediee des adresses : une LISTE, bornee par `.in`.
      then (res, rej) {
        lectures.push({ user_id: filtre.user_id, provider: filtre.provider, refs })
        if (erreurAdresses) return Promise.resolve({ data: null, error: erreurAdresses }).then(res, rej)
        // ⚠ LE DOUBLE APPLIQUE LES FILTRES (review 3, constat 2) : il rendait
        // tout sans `.in` et ignorait le compte, donc retirer ces filtres du
        // code laissait le test « bornee, par compte » vert.
        const data = (filtre.user_id === 'u1' && filtre.provider === 'beds24' && refs)
          ? Object.entries(lignes).filter(([ref]) => refs.includes(ref))
            .map(([ref, l]) => ({ provider_property_id: ref, address: l.address, zip_code: l.zip_code, city: l.city }))
          : []
        return Promise.resolve({ data, error: null, colonnes }).then(res, rej)
      },
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
      clesArchivees: async () => ({ complet: !archivesIllisibles, cles: new Set(archives.map(r => `u1|${r}`)) }),
      cleDuBien: (u, p) => `${u}|${p}`
    })
  ]
  delete require.cache[require.resolve('../lib/cron-beds24-props')]
  const mod = require('../lib/cron-beds24-props')
  delete require.cache[require.resolve('../lib/cron-beds24-props')]
  for (const c of chemins) delete require.cache[c]
  return { mod, selects, lectures }
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

test('bien neuf (pas encore dans le coeur) : pas de decoration, l adresse Beds24 est celle qui entre dans la fiche', async () => {
  const { mod } = charger({ lignes: {} })
  const biens = [{ id: 222, name: 'Neuf', address: 'Adresse Beds24' }]
  await mod.materializeBeds24Properties('u1', biens, {})
  assert.strictEqual(biens[0].adresseFiche, undefined)
  const { replisDuBien } = require('../lib/balises')
  assert.strictEqual(replisDuBien(biens[0]).adresse, 'Adresse Beds24')
})

// ⚠ CONSTAT 3 DE LA REVIEW 2 : posee dans la boucle de materialisation, la
// decoration manquait exactement la ou les gardes renoncent — et l'ancienne
// adresse Beds24 repartait au voyageur, alors que l'hote l'avait corrigee.
test('LE TEST QUI COMPTE : un bien ARCHIVE (saute par la materialisation) porte quand meme l adresse de la fiche', async () => {
  const { mod } = charger({ lignes: { 111: { id: 'uuid-1', active_at: '2026-01-01', address: 'Adresse corrigee' } }, archives: ['111'] })
  const biens = [{ id: 111, name: 'Gite', address: 'Ancienne adresse Beds24' }]
  await mod.materializeBeds24Properties('u1', biens, {})
  assert.strictEqual(biens[0].adresseFiche, 'Adresse corrigee')
})

test('archives illisibles (la materialisation renonce au cycle) : les biens sont decores quand meme', async () => {
  const { mod } = charger({ lignes: { 111: { id: 'uuid-1', active_at: '2026-01-01', address: 'Adresse corrigee' } }, archivesIllisibles: true })
  const biens = [{ id: 111, name: 'Gite', address: 'Ancienne adresse Beds24' }]
  await mod.materializeBeds24Properties('u1', biens, { errors: [] })
  assert.strictEqual(biens[0].adresseFiche, 'Adresse corrigee')
})

test('lecture des adresses en echec : aucune decoration, l adresse Beds24 reste le repli, et rien ne leve', async () => {
  const { mod } = charger({ lignes: { 111: { id: 'uuid-1', active_at: '2026-01-01', address: 'X' } }, erreurAdresses: { message: 'panne' } })
  const biens = [{ id: 111, name: 'Gite', address: 'Adresse Beds24' }]
  await mod.materializeBeds24Properties('u1', biens, {})
  assert.strictEqual(biens[0].adresseFiche, undefined)
})

test('une seule lecture des adresses par compte, bornee aux biens rendus par Beds24', async () => {
  const { mod, selects, lectures } = charger({ lignes: { 111: { id: 'a', active_at: 'x', address: 'A' }, 112: { id: 'b', active_at: 'x', address: 'B' }, 999: { id: 'z', active_at: 'x', address: 'Z' } } })
  const biens = [{ id: 111 }, { id: 112 }]
  await mod.materializeBeds24Properties('u1', biens, {})
  assert.strictEqual(selects.filter(c => c === 'provider_property_id, address, zip_code, city').length, 1)
  const lecture = lectures.find(l => l.refs)
  assert.deepStrictEqual(lecture, { user_id: 'u1', provider: 'beds24', refs: ['111', '112'] },
    'la lecture est bornee au compte, au provider et aux biens rendus par l API')
  assert.deepStrictEqual(biens.map(b => b.adresseFiche), ['A', 'B'])
})

test('objet NON decore (materialisation qui a renonce) : l adresse du provider reste le repli', () => {
  const { replisDuBien } = require('../lib/balises')
  assert.strictEqual(replisDuBien({ address: 'Adresse Beds24' }).adresse, 'Adresse Beds24')
  // Et les autres chemins, ou `address` EST la fiche, ne changent pas.
  assert.strictEqual(replisDuBien({ address: '12 rue des Lilas' }).adresse, '12 rue des Lilas')
})

test('la decoration Beds24 assemble la rue, le code postal et la ville de la fiche', async () => {
  // Recette du 9 novembre 2026 : la fiche range l'adresse en trois champs.
  const { mod } = charger({ lignes: { 111: { id: 'a', active_at: 'x', address: '4 rue du bourg vieux', zip_code: '65200', city: 'Bagnères-de-Bigorre' } } })
  const biens = [{ id: 111, address: 'Adresse Beds24' }]
  await mod.materializeBeds24Properties('u1', biens, {})
  assert.strictEqual(biens[0].adresseFiche, '4 rue du bourg vieux, 65200 Bagnères-de-Bigorre')
})
