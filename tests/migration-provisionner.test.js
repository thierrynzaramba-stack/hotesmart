// tests/migration-provisionner.test.js
// L'etape « provisionner chez le nouveau provider ».
//
// ⚠ CE QU'ELLE NE DOIT JAMAIS FAIRE : creer un second bien, ou toucher
// `provider_property_id` — la cle de 4 274 lignes d'historique sur les deux
// biens de Bagneres.

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'

const { provisionner, raisonDeRefus, payloadRatePlan } = require('../lib/migration-provisionner')

const BIEN = {
  id: 'uuid-bien', name: 'La bulle', provider: 'beds24',
  provider_property_id: '209413', capacity: 2, currency: 'EUR',
  property_type: 'apartment', timezone: 'Europe/Paris',
  included_guests: 2, extra_guest_fee: 0, base_price: null,
  migration_target_property_id: null
}

// Faux Supabase : rend { data, error }, ne throw pas, et NOTE ce qu'on ecrit.
function fauxBase (erreur = null) {
  const ecrits = []
  const api = {
    from () { return api },
    update (patch) { ecrits.push(patch); return { eq: async () => ({ error: erreur }) } }
  }
  return { api, ecrits }
}

function fauxCanal (reponses) {
  const appels = []
  return {
    appels,
    appel: async (methode, chemin, corps) => {
      appels.push({ methode, chemin, corps })
      const r = reponses[chemin.split('?')[0]] || reponses[chemin] ||
        Object.entries(reponses).find(([k]) => chemin.startsWith(k))?.[1]
      return r || { ok: true, status: 200, json: { data: { id: 'auto' } } }
    }
  }
}

const OK = {
  '/properties': { ok: true, status: 201, json: { data: { id: 'chx-prop' } } },
  '/room_types': { ok: true, status: 201, json: { data: { id: 'chx-rt' } } },
  '/rate_plans': { ok: true, status: 201, json: { data: { id: 'chx-rp' } } },
  '/applications/install': { ok: true, status: 200, json: {} }
}

test('dry run par defaut : rien n est appele, rien n est ecrit', async () => {
  const b = fauxBase()
  const c = fauxCanal(OK)
  const r = await provisionner(b.api, BIEN, { appel: c.appel })
  assert.equal(r.dry_run, true)
  assert.equal(c.appels.length, 0, 'aucun appel au provider')
  assert.equal(b.ecrits.length, 0, 'aucune ecriture en base')
  assert.ok(r.va_creer.propriete.property.title)
})

test('LE TEST QUI COMPTE : provider_property_id n est JAMAIS touche', async () => {
  // C'est la cle de bookings_snapshot, menages, messages, access_codes,
  // conversations... L'ecraser ici couperait le bien de son historique AVANT
  // meme que la bascule commence.
  const b = fauxBase()
  const c = fauxCanal(OK)
  const r = await provisionner(b.api, BIEN, { dryRun: false, appel: c.appel })
  assert.equal(r.ok, true)
  const patch = b.ecrits[0]
  assert.ok(!('provider_property_id' in patch), 'provider_property_id absent du patch')
  assert.ok(!('provider' in patch), 'le provider n est pas bascule non plus')
  assert.equal(patch.migration_target_property_id, 'chx-prop')
  assert.equal(patch.provider_room_type_id, 'chx-rt')
  assert.equal(patch.provider_rate_plan_id, 'chx-rp')
})

test('c est un UPDATE, jamais un INSERT', async () => {
  // POST /api/channel-property fait un INSERT : l'utiliser creerait un SECOND
  // bien a cote de celui qui porte l'historique.
  const b = fauxBase()
  const api = { ...b.api, insert: () => { throw new Error('INSERT interdit') } }
  const c = fauxCanal(OK)
  const r = await provisionner(api, BIEN, { dryRun: false, appel: c.appel })
  assert.equal(r.ok, true)
})

test('un echec de room_type ne laisse pas d orphelin chez le provider', async () => {
  const c = fauxCanal({ ...OK, '/room_types': { ok: false, status: 422, json: { errors: 'x' } } })
  const r = await provisionner(fauxBase().api, BIEN, { dryRun: false, appel: c.appel })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'creation_room_type')
  assert.ok(c.appels.some(a => a.methode === 'DELETE' && a.chemin.includes('chx-prop')),
    'la propriete creee est supprimee')
})

test('un echec d ECRITURE dit ce qui existe chez le provider', async () => {
  // Sinon la base ignore des objets qui existent : orphelin muet.
  const c = fauxCanal(OK)
  const r = await provisionner(fauxBase({ message: 'rls' }).api, BIEN, { dryRun: false, appel: c.appel })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'ecriture_base')
  assert.deepEqual(r.a_nettoyer_chez_channex, { propriete: 'chx-prop', room_type: 'chx-rt', rate_plan: 'chx-rp' })
})

test('idempotence : un bien deja provisionne est refuse', async () => {
  assert.equal(raisonDeRefus({ ...BIEN, migration_target_property_id: 'chx-prop' }), 'deja_provisionne')
})

test('les champs que le provisionnement EXIGE sont nommes un par un', async () => {
  assert.equal(raisonDeRefus({ ...BIEN, capacity: null }), 'sans_capacite')
  assert.equal(raisonDeRefus({ ...BIEN, property_type: null }), 'sans_type')
  assert.equal(raisonDeRefus({ ...BIEN, timezone: null }), 'sans_fuseau')
  assert.equal(raisonDeRefus(BIEN), null)
})

test('le rate plan part a ZERO, jamais avec un prix invente', async () => {
  // Un prix de reference finirait par se vendre. Les prix voyagent par l'ARI.
  const perRoom = payloadRatePlan(BIEN, 'p', 'rt').rate_plan
  assert.equal(perRoom.sell_mode, 'per_room')
  assert.deepEqual(perRoom.options.map(o => o.rate), [0])

  const avecSupp = payloadRatePlan({ ...BIEN, capacity: 6, included_guests: 4, extra_guest_fee: 10 }, 'p', 'rt').rate_plan
  assert.equal(avecSupp.sell_mode, 'per_person', 'la structure par occupation est respectee')
  assert.equal(avecSupp.options.length, 6)
  assert.deepEqual([...new Set(avecSupp.options.map(o => o.rate))], [0], 'tous a zero')
  assert.equal(avecSupp.options[5].is_primary, true)
})

// ─── Les refus qui protegent un bien VIVANT ─────────────────────────────────
// Cette etape ECRIT sur une ligne existante : elle n'a pas le filet d'un INSERT.
// Un refus qui manque, et c'est un bien en production qui perd ses identifiants
// de canal au profit d'une propriete neuve et vide.

const { motifDeRefus } = require('../lib/migration-provisionner')

test('LE TEST QUI COMPTE : un bien deja chez la cible est refuse', async () => {
  // Colomiers est chez Channex avec des canaux ACTIFS. Provisionner ecraserait
  // `provider_room_type_id` / `provider_rate_plan_id` : son ARI partirait ensuite
  // vers un room type neuf, et le vrai calendrier ne serait plus alimente.
  const bienVivant = { ...BIEN, provider: 'channex', provider_property_id: 'chx-colomiers',
    provider_room_type_id: 'chx-rt-vivant', provider_rate_plan_id: 'chx-rp-vivant' }
  assert.equal(raisonDeRefus(bienVivant), 'deja_chez_la_cible')

  const b = fauxBase()
  const c = fauxCanal(OK)
  const r = await provisionner(b.api, bienVivant, { dryRun: false, appel: c.appel })
  assert.equal(r.ok, false)
  assert.equal(c.appels.length, 0, 'aucun appel au provider')
  assert.equal(b.ecrits.length, 0, 'aucune ecriture en base')
})

test('des identifiants de canal sans propriete cible : on ne les ecrase pas', async () => {
  assert.equal(raisonDeRefus({ ...BIEN, provider_room_type_id: 'venu-d-ailleurs' }),
    'ids_canal_deja_poses')
  assert.equal(raisonDeRefus({ ...BIEN, provider_rate_plan_id: 'venu-d-ailleurs' }),
    'ids_canal_deja_poses')
})

test('un refus dit QUOI FAIRE, pas seulement ce qui cloche', () => {
  for (const raison of ['deja_chez_la_cible', 'deja_provisionne', 'ids_canal_deja_poses',
    'sans_nom', 'sans_capacite', 'sans_type', 'sans_fuseau']) {
    const m = motifDeRefus(raison)
    assert.ok(m.length > 20 && m !== raison, `${raison} a un motif lisible`)
  }
  const m = motifDeRefus('type_non_supporte_par_la_cible', { property_type: 'townhome' })
  assert.match(m, /townhome/)
  assert.match(m, /apartment/, 'les types valides sont nommes')
})

test('le refus voyage avec son motif, jusqu au client', async () => {
  const r = await provisionner(fauxBase().api, { ...BIEN, property_type: 'townhome' }, { dryRun: false })
  assert.equal(r.raison, 'type_non_supporte_par_la_cible')
  assert.match(r.message, /townhome/)
})
