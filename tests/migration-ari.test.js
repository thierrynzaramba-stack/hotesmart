// tests/migration-ari.test.js
// ETAPE 0.3 DU PLAN DE BASCULE — pousser l'ARI vers la propriete cible.
//
// Ce que cette etape ne doit jamais faire :
//   - pousser vers la cle du provider SOURCE (« 209413 » n'existe pas chez Channex) ;
//   - pousser les tarifs d'un bien que l'hote a laisse en « je garde mes prix » ;
//   - dire « fait » sur la foi d'un drapeau local plutot que du calendrier cible.

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'

// ⚠ AVANT le require : `channel-fullsync` capture `supabase` a l'import.
let INVENTAIRE = []
const fauxCoeur = {
  from () { return fauxCoeur }, select () { return fauxCoeur }, eq () { return fauxCoeur },
  gte () { return fauxCoeur }, lte () { return fauxCoeur }, not () { return fauxCoeur },
  order () { return fauxCoeur },
  then (r) { return Promise.resolve({ data: INVENTAIRE, error: null }).then(r) }
}
require('../lib/cron-shared').supabase = fauxCoeur

const { pousserAri, etatAri, raisonDeNePasPousser } = require('../lib/migration-ari')
const { proprieteQuiRecoitLARI } = require('../lib/rate-sync')

// L'etat EXACT de « La bulle » apres la phase 0 : ids de la propriete CIBLE,
// cle Beds24 toujours en place, mode « HoteSmart gere mes prix ».
const EN_MIGRATION = {
  id: 'uuid-bulle', user_id: 'uuid-hote', name: 'La bulle', provider: 'beds24',
  provider_property_id: '209413',
  migration_target_property_id: 'chx-cible',
  provider_room_type_id: 'chx-rt', provider_rate_plan_id: 'chx-rp',
  capacity: 2, included_guests: 2, extra_guest_fee: 0, base_price: null,
  rate_sync_mode: 'managed'
}

// Faux Supabase : rend l'inventaire demande, ne throw pas.
function fauxBase (lignes = []) {
  const api = {
    from () { return api }, select () { return api }, eq () { return api },
    gte () { return api }, lte () { return api }, not () { return api },
    order () { return api },
    limit: async () => ({ data: lignes, error: null }),
    then (r) { return Promise.resolve({ data: lignes, error: null }).then(r) }
  }
  return api
}

// ─── La destination ─────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : l ARI vise la propriete CIBLE, jamais la cle source', () => {
  assert.equal(proprieteQuiRecoitLARI(EN_MIGRATION), 'chx-cible')
  assert.notEqual(proprieteQuiRecoitLARI(EN_MIGRATION), '209413')
})

test('apres le re-keying, la cle promue redevient la seule verite', () => {
  // `provider_property_id` porte alors l'UUID Channex, et la colonne cible garde
  // seulement la memoire du chantier : elle ne doit plus rien commander.
  const migre = { ...EN_MIGRATION, provider: 'channex', provider_property_id: 'chx-cible' }
  assert.equal(proprieteQuiRecoitLARI(migre), 'chx-cible')
})

test('un bien ni chez le canal ni provisionne n a nulle part ou pousser', () => {
  const orphelin = { ...EN_MIGRATION, migration_target_property_id: null }
  assert.equal(proprieteQuiRecoitLARI(orphelin), null)
  assert.equal(raisonDeNePasPousser(orphelin).raison, 'pas_de_destination')
})

// ─── Les refus ──────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : le mode « je garde mes prix » tient pendant la migration', async () => {
  // Le mode est une decision de l'hote. Demenager ne l'annule pas — et le refus
  // doit prevenir de ce qui l'attend s'il n'en change pas.
  const keep = { ...EN_MIGRATION, rate_sync_mode: 'keep' }
  const r = await pousserAri(keep, { dryRun: false })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'mode_keep')
  assert.match(r.message, /ne poussera plus/, 'il dit la consequence apres la bascule')
})

test('sans room type ni rate plan, l ARI n aurait pas ou se poser', () => {
  assert.equal(raisonDeNePasPousser({ ...EN_MIGRATION, provider_rate_plan_id: null }).raison,
    'ids_canal_manquants')
})

// ─── L'etat, lu chez la cible ───────────────────────────────────────────────

const COEUR = [{ date: '2026-09-10', rate: 120 }, { date: '2026-09-11', rate: 130 }]

test('rien chez la cible : l etape est a faire, et propose son geste', async () => {
  const r = await etatAri(fauxBase(COEUR), EN_MIGRATION, {
    appel: async () => ({ ok: true, status: 200, json: { data: {} } })
  })
  assert.equal(r.etat, 'a_faire')
  assert.equal(r.action, 'poussee_ari')
})

test('LE TEST QUI COMPTE : une poussee PARTIELLE ne passe pas pour faite', async () => {
  // Le cas qui coute cher le jour J : 200 en HTTP, une partie perdue en tache
  // de fond. Un drapeau local dirait « fait » ; la lecture de la cible, non.
  const r = await etatAri(fauxBase(COEUR), EN_MIGRATION, {
    appel: async () => ({ ok: true, status: 200,
      json: { data: { 'chx-rp': { '2026-09-10': { rate: 12000 } } } } })
  })
  assert.equal(r.etat, 'a_faire')
  assert.match(r.message, /2026-09-11/, 'la date manquante est NOMMEE')
})

test('toutes les nuits du coeur chez la cible : fait', async () => {
  const r = await etatAri(fauxBase(COEUR), EN_MIGRATION, {
    appel: async () => ({ ok: true, status: 200,
      json: { data: { 'chx-rp': { '2026-09-10': { rate: 12000 }, '2026-09-11': { rate: 13000 } } } } })
  })
  assert.equal(r.etat, 'fait')
})

test('une panne de lecture chez la cible BLOQUE, elle ne passe pas pour « a faire »', async () => {
  const r = await etatAri(fauxBase(COEUR), EN_MIGRATION, {
    appel: async () => ({ ok: false, status: 503, json: {} })
  })
  assert.equal(r.etat, 'bloque')
  assert.equal(r.raison, 'lecture_cible')
})

test('un coeur sans prix bloque AVANT tout appel : la poussee fermerait tout', async () => {
  let appele = false
  const r = await etatAri(fauxBase([]), EN_MIGRATION, {
    appel: async () => { appele = true; return { ok: true, status: 200, json: { data: {} } } }
  })
  assert.equal(r.etat, 'bloque')
  assert.equal(r.raison, 'coeur_sans_prix')
  assert.equal(appele, false, 'aucun appel reseau pour un blocage connu d avance')
})

test('l etat lit le rate plan DU BIEN, pas le premier venu', async () => {
  // Une propriete peut porter plusieurs rate plans (le derive « min stay »
  // existe deja en production). Compter les dates du mauvais plan dirait
  // « fait » sur un calendrier vide.
  const r = await etatAri(fauxBase(COEUR), EN_MIGRATION, {
    appel: async () => ({ ok: true, status: 200,
      json: { data: { 'un-autre-plan': { '2026-09-10': { rate: 12000 }, '2026-09-11': { rate: 13000 } } } } })
  })
  assert.equal(r.etat, 'a_faire')
})

// ─── Ce que cette etape N'EST PAS : un bouton « pousser » generique ─────────

const { estEnMigration } = require('../lib/rate-sync')

// Colomiers : bien VIVANT chez Channex, canaux Booking et Airbnb mappes.
const BIEN_VIVANT = {
  id: 'uuid-colomiers', user_id: 'uuid-hote', name: 'Colomiers', provider: 'channex',
  provider_property_id: 'chx-colomiers',
  provider_room_type_id: 'chx-rt-vif', provider_rate_plan_id: 'chx-rp-vif',
  capacity: 4, included_guests: 4, extra_guest_fee: 0, base_price: 70,
  rate_sync_mode: 'managed', migration_target_property_id: null
}

test('LE TEST QUI COMPTE : un bien VIVANT chez le canal est refuse, sans un seul appel', async () => {
  // Sans ce refus, l'action poussait 500 jours vers les OTA de ce bien —
  // `stop_sell` sur chaque date sans prix — hors du cooldown 24 h et hors de la
  // file serialisee du calendrier, en affirmant dans sa reponse qu'aucun canal
  // n'existait sur la cible.
  const vraiFetch = global.fetch
  let appels = 0
  global.fetch = async () => { appels++; return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' } }
  try {
    const r = await pousserAri(BIEN_VIVANT, { dryRun: false })
    assert.equal(r.ok, false)
    assert.equal(r.raison, 'pas_en_migration')
    assert.equal(appels, 0, 'aucun appel reseau')
  } finally { global.fetch = vraiFetch }
})

test('APRES le re-keying, l etape se refuse aussi : la bascule est finie', async () => {
  // La colonne cible reste renseignee ; elle n'est plus qu'une memoire du
  // chantier. Le bien repart par le chemin de tous les jours.
  const migre = { ...EN_MIGRATION, provider: 'channex', provider_property_id: 'chx-cible' }
  assert.equal(estEnMigration(migre), false)
  const r = await pousserAri(migre, { dryRun: false })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'pas_en_migration')
})

test('un bien en migration, lui, passe les refus', () => {
  assert.equal(estEnMigration(EN_MIGRATION), true)
  assert.equal(raisonDeNePasPousser(EN_MIGRATION), null)
})

// ─── Un prix de base EST un prix ────────────────────────────────────────────

test('un prix de base ne bloque plus l etape : la poussee tarifie les 500 dates', async () => {
  // `runFullSync` retombe explicitement sur `base_price` pour toute date sans
  // exception. Bloquer sur « aucun prix » disait le contraire de ce que la
  // poussee fait — et l'etape 4 dit deja « fait » sur ce meme bien.
  const surBase = { ...EN_MIGRATION, base_price: 86 }
  const dates = {}
  for (let i = 0; i < 30; i++) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i)
    dates[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = { rate: 8600 }
  }
  const r = await etatAri(fauxBase([]), surBase, {
    appel: async () => ({ ok: true, status: 200, json: { data: { 'chx-rp': dates } } })
  })
  assert.equal(r.etat, 'fait')
  assert.match(r.message, /86/)
})

test('ni date tarifee ni prix de base : la poussee fermerait tout, et l etape le dit', async () => {
  const r = await etatAri(fauxBase([]), { ...EN_MIGRATION, base_price: null }, {
    appel: async () => ({ ok: true, status: 200, json: { data: {} } })
  })
  assert.equal(r.etat, 'bloque')
  assert.equal(r.raison, 'coeur_sans_prix')
})

// ─── « En migration » ne veut pas dire « hors ligne » ───────────────────────
// Le plan de bascule active les canaux sur la propriete CIBLE en phase 2.6, et
// le re-keying n'a lieu qu'en 2.8. Entre les deux, le bien est toujours
// `provider = 'beds24'` avec sa cle source : une poussee partirait droit vers
// Booking et Airbnb.

const canaux = (n, actifs = n) => async (m, chemin) => {
  if (chemin.startsWith('/channels')) {
    return { ok: true, status: 200, json: { data: Array.from({ length: n }, (_, i) => ({
      id: `c${i}`, attributes: { is_active: i < actifs } })) } }
  }
  return { ok: true, status: 200, json: { data: [{ id: 'task-1' }] } }
}

test('LE TEST QUI COMPTE : des canaux ACTIFS sur la cible interdisent la poussee reelle', async () => {
  const r = await pousserAri(EN_MIGRATION, { dryRun: false, appel: canaux(2) })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'canaux_actifs_sur_la_cible')
  assert.match(r.message, /calendrier/, 'il renvoie vers le chemin qui a ses gardes')
})

test('canaux illisibles : on ne pousse pas « en esperant »', async () => {
  const r = await pousserAri(EN_MIGRATION, { dryRun: false,
    appel: async () => ({ ok: false, status: 500, json: {} }) })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'canaux_illisibles')
})

test('LA NOTE EST CALCULEE, PAS RECITEE', async () => {
  // Elle affirmait « aucun canal n'existe sur la propriete cible » sans l'avoir
  // verifie une seule fois.
  const vierge = await pousserAri(EN_MIGRATION, { dryRun: true, appel: canaux(0) })
  assert.match(vierge.note, /Aucun canal/)
  assert.equal(vierge.canaux_sur_la_cible.total, 0)

  const peuple = await pousserAri(EN_MIGRATION, { dryRun: true, appel: canaux(2, 1) })
  assert.match(peuple.note, /visible des plateformes/)
  assert.equal(peuple.canaux_sur_la_cible.actifs, 1)
})

// ─── Les prix d'un rate plan per_person ─────────────────────────────────────

test('LE TEST QUI COMPTE : un prix par occupation compte comme un prix', async () => {
  // `runFullSync` ecrit `rates[]` et JAMAIS `rate` pour un rate plan per_person
  // — c'est le cas de « coeur de vie 23 », 6 options. Ne lire que `rate` aurait
  // rendu « aucune nuit tarifee » a vie sur un calendrier pourtant correct.
  const r = await etatAri(fauxBase(COEUR), EN_MIGRATION, {
    appel: async () => ({ ok: true, status: 200, json: { data: { 'chx-rp': {
      '2026-09-10': { rates: [{ occupancy: 1, rate: 12000 }, { occupancy: 2, rate: 13000 }] },
      '2026-09-11': { rates: [{ occupancy: 2, rate: 13000 }] }
    } } } })
  })
  assert.equal(r.etat, 'fait')
})

test('une grille per_person entierement a zero n est pas un prix', async () => {
  const r = await etatAri(fauxBase(COEUR), EN_MIGRATION, {
    appel: async () => ({ ok: true, status: 200, json: { data: { 'chx-rp': {
      '2026-09-10': { rates: [{ occupancy: 1, rate: 0 }] }
    } } } })
  })
  assert.equal(r.etat, 'a_faire')
})

test('LE TEST QUI COMPTE : le mode « keep » n interdit pas de VOIR', async () => {
  // Sinon on demande a l hote de changer son reglage a l aveugle, pour decouvrir
  // apres coup ce que la publication fait de ses 500 dates.
  const keep = { ...EN_MIGRATION, rate_sync_mode: 'keep' }
  const vue = await pousserAri(keep, { dryRun: true, appel: canaux(0) })
  assert.equal(vue.ok, true)
  assert.equal(vue.dry_run, true)
  assert.match(vue.avertissement, /Je garde mes prix/, 'l apercu rappelle que rien ne partira')

  // Mais l ecriture, elle, reste refusee.
  const ecriture = await pousserAri(keep, { dryRun: false, appel: canaux(0) })
  assert.equal(ecriture.ok, false)
  assert.equal(ecriture.raison, 'mode_keep')
})
