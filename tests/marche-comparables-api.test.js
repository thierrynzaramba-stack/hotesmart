// tests/marche-comparables-api.test.js — la route « Choisir vos comparables »
// (spec §20.4 de docs/kb/chantier-nouveau-bien.md, lot C2).
//
// CE QU'ILS EMPECHENT :
//   - ⚠ SECURITE : une ecriture ou un paiement sans le droit d'ecrire les
//     reglages ; une ligne au nom de l'APPELANT au lieu du compte resolu ;
//   - un GET qui paierait AirROI ;
//   - un prix qui sortirait ;
//   - un choix de moins de 3 biens, ou d'un bien hors de la liste proposee.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { lireJson } = require('../lib/airroi/json')
const { cleCanonique } = require('../lib/airroi/client')

const RACINE = path.join(__dirname, '..')
const COMPS_BRUT = fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'comps-labulle.json'), 'utf8')
const COMPS = lireJson(COMPS_BRUT).listings
const PROFIL = { adresse: '12 rue des Thermes', adresse_trouvee: '12 Rue des Thermes 65200 Bagnères-de-Bigorre', latitude: '43.0636', longitude: '0.1476', geocode_score: '0.93', voyageurs: 2, chambres: 1, pieces: 2, salles_de_bain: 1, equipements: ['parking'], maj_le: '2026-10-05T10:00:00Z' }
const CLE = cleCanonique('GET /listings/comparables', { latitude: 43.0636, longitude: 0.1476, bedrooms: 1, baths: 1, guests: 2, currency: 'native' })

// Un simulacre de Supabase qui applique eq / not, et journalise les ecritures.
function base (tables) {
  const lus = []
  const ecrits = []
  const client = { from: tb => {
    lus.push(tb)
    let lignes = [...(tables[tb] || [])]
    const absente = (tables.__absentes || []).includes(tb)
    const erreur = { message: `Could not find the table 'public.${tb}' in the schema cache` }
    const q = {
      select: () => q,
      eq: (k, v) => { lignes = lignes.filter(l => String(l[k]) === String(v)); return q },
      gte: (k, v) => { lignes = lignes.filter(l => l[k] >= v); return q },
      order: () => q,
      limit: n => Promise.resolve(absente ? { data: null, error: erreur } : { data: lignes.slice(0, n), error: null }),
      // Comme le vrai client : range() se chaine encore (eq apres range).
      range: (a, z) => { lignes = lignes.slice(a, z + 1); return q },
      then: (ok, ko) => Promise.resolve(absente ? { data: null, error: erreur } : { data: lignes, error: null }).then(ok, ko),
      upsert: (ligne, opts) => { ecrits.push({ tb, op: 'upsert', ligne, opts }); if (tb === 'bien_profil') tables.bien_profil = [{ ...PROFIL, ...ligne, latitude: String(ligne.latitude), longitude: String(ligne.longitude) }]; return Promise.resolve({ error: null }) },
      update: (maj) => {
        const u = { tb, op: 'update', maj, filtres: [] }
        ecrits.push(u)
        const w = {
          eq: (k, v) => { u.filtres.push(['eq', k, v]); return w },
          in: (k, v) => { u.filtres.push(['in', k, v]); return Promise.resolve({ error: null }) },
          not: (k, op, v) => { u.filtres.push(['not', k, op, v]); return Promise.resolve({ error: null }) },
        }
        return w
      },
    }
    return q
  } }
  return { client, lus, ecrits }
}

async function appeler ({ method = 'GET', query = { property_id: 'REF-42' }, body = null, tables = {}, garde = { ok: true, userId: 'MEMBRE', accountUserId: 'COMPTE', bien: { id: 'BIEN-A' } }, airroi = null, geocode = null }) {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'factice-non-secret'
  const ch = m => require.resolve(path.join(RACINE, m))
  const cheminGarde = ch('lib/require-permission')
  const cheminClient = ch('lib/airroi/client')
  const cheminSb = require.resolve('@supabase/supabase-js')
  const vraieGarde = require(cheminGarde)
  const vraiClient = require(cheminClient)
  const vraiSb = require(cheminSb)
  const gardes = []
  const appelsAirroi = []
  const b = base(tables)
  const fetchAvant = globalThis.fetch
  try {
    require.cache[cheminGarde].exports = { ...vraieGarde, requirePermission: async (req, res, o) => { gardes.push(o); return garde } }
    require.cache[cheminSb].exports = { ...vraiSb, createClient: () => b.client }
    require.cache[cheminClient].exports = { ...vraiClient, creerClient: () => ({ comparables: async (params, ctx) => {
      appelsAirroi.push({ params, ctx })
      if (airroi instanceof Error) throw airroi
      return { donnees: airroi || { listings: COMPS }, depuisCache: false }
    } }) }
    globalThis.fetch = async () => ({ ok: true, json: async () => geocode || { features: [{ geometry: { coordinates: [0.1476, 43.0636] }, properties: { label: '12 Rue des Thermes 65200 Bagnères-de-Bigorre', score: 0.93, type: 'housenumber' } }] } })
    delete require.cache[ch('api/marche-comparables')]
    const api = require(path.join(RACINE, 'api', 'marche-comparables'))
    const r = await new Promise(resolve => {
      let code = 200
      const res = { status (c) { code = c; return res }, setHeader () {}, json: corps => resolve({ code, corps }) }
      Promise.resolve(api({ method, query, body, headers: {} }, res)).then(() => resolve({ code, corps: null }))
    })
    return { ...r, gardes, lus: b.lus, ecrits: b.ecrits, appelsAirroi }
  } finally {
    require.cache[cheminGarde].exports = vraieGarde
    require.cache[cheminClient].exports = vraiClient
    require.cache[cheminSb].exports = vraiSb
    globalThis.fetch = fetchAvant
    delete require.cache[ch('api/marche-comparables')]
  }
}

const TABLES = () => ({
  bien_profil: [{ ...PROFIL, property_id: 'BIEN-A' }],
  comparables_retenus: [{ property_id: 'BIEN-A', listing_id: String(COMPS[0].listing_info.listing_id), actif: true }],
  airroi_cache: [{ cle: CLE, reponse: COMPS_BRUT, recupere_le: '2026-10-05T10:00:00Z' }],
})
const IDS = COMPS.slice(0, 3).map(c => String(c.listing_info.listing_id))

test('LE TEST QUI COMPTE (securite) : lecture sous reservations:read, toute ecriture ou paiement sous reglages:write — bien requis, le bien RESOLU', async () => {
  const g = await appeler({ tables: TABLES() })
  assert.deepEqual(g.gardes, [{ domaine: 'reservations', niveau: 'read', bien: 'REF-42', bienRequis: true }])
  for (const action of ['profil', 'chercher', 'retenir']) {
    const p = await appeler({ method: 'POST', body: { action }, tables: TABLES() })
    assert.deepEqual(p.gardes, [{ domaine: 'reglages', niveau: 'write', bien: 'REF-42', bienRequis: true }], action)
  }
  const refus = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: TABLES(), garde: { ok: false } })
  assert.deepEqual(refus.lus, [])
  assert.equal(refus.appelsAirroi.length, 0)
  assert.equal((await appeler({ query: {}, tables: TABLES() })).code, 400)
  assert.equal((await appeler({ method: 'PUT', tables: TABLES() })).code, 405)
})

test('LE TEST QUI COMPTE (securite, review S3) : les lignes portent le COMPTE resolu par la garde, jamais l appelant ; le bien resolu, jamais la reference brute', async () => {
  const p = await appeler({ method: 'POST', body: { action: 'profil', adresse: '12 rue des Thermes', voyageurs: 2, chambres: 1, pieces: 2, salles_de_bain: 1, equipements: ['parking'] }, tables: TABLES() })
  assert.equal(p.code, 200)
  const profil = p.ecrits.find(e => e.tb === 'bien_profil')
  assert.equal(profil.ligne.user_id, 'COMPTE')
  assert.equal(profil.ligne.property_id, 'BIEN-A')
  const r = await appeler({ method: 'POST', body: { action: 'retenir', listing_ids: IDS }, tables: TABLES() })
  assert.equal(r.code, 200)
  const up = r.ecrits.find(e => e.tb === 'comparables_retenus' && e.op === 'upsert')
  assert.ok(up.ligne.every(l => l.user_id === 'COMPTE' && l.property_id === 'BIEN-A' && l.retenu_par === 'proprietaire' && l.actif === true))
  assert.deepEqual(up.opts, { onConflict: 'property_id,listing_id', ignoreDuplicates: true }, 'une ligne existante n est jamais reecrite')
  const ch = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: TABLES() })
  assert.deepEqual(ch.appelsAirroi[0].ctx, { propertyId: 'BIEN-A', userId: 'COMPTE' }, 'les plafonds de depense comptent le bien et le compte')
})

test('LE TEST QUI COMPTE : un GET ne paie JAMAIS — il ne lit que le cache', async () => {
  const g = await appeler({ tables: TABLES() })
  assert.equal(g.appelsAirroi.length, 0)
  assert.equal(g.corps.comparables.length, 25)
  const sansCache = await appeler({ tables: { ...TABLES(), airroi_cache: [] } })
  assert.equal(sansCache.appelsAirroi.length, 0)
  assert.equal(sansCache.corps.comparables, null)
  assert.ok(!g.ecrits.length, 'aucune ecriture')
})

test('LE TEST QUI COMPTE : AUCUN prix, revenu ou occupation ne sort — ni au GET ni a la recherche ; pas de position brute du bien', async () => {
  for (const r of [await appeler({ tables: TABLES() }), await appeler({ method: 'POST', body: { action: 'chercher' }, tables: TABLES() })]) {
    const texte = JSON.stringify(r.corps)
    for (const interdit of ['rate', 'revenue', 'occupancy', 'revpar', 'cleaning_fee', 'price', 'latitude', 'longitude']) assert.ok(!texte.includes(interdit), interdit)
  }
})

test('chercher : la recherche AirROI part du PROFIL (position geocodee, vraies chambres, salles de bain, voyageurs)', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: TABLES() })
  assert.deepEqual(r.appelsAirroi[0].params, { latitude: 43.0636, longitude: 0.1476, bedrooms: 1, baths: 1, guests: 2 })
  assert.equal(r.corps.comparables.length, 25)
  assert.deepEqual(r.corps.retenus, [String(COMPS[0].listing_info.listing_id)])
})

test('chercher : sans profil, on le demande ; AirROI indisponible (plafond, cle, panne) — une phrase simple, aucun detail technique', async () => {
  const sans = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), bien_profil: [] } })
  assert.equal(sans.code, 400)
  assert.match(sans.corps.message, /Décrivez d’abord votre logement/)
  assert.equal(sans.appelsAirroi.length, 0)
  const e = Object.assign(new Error('Budget AirROI du mois atteint (9.95 $ sur 10 $)'), { code: 'budget_mensuel' })
  const panne = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: TABLES(), airroi: e })
  assert.equal(panne.corps.etat, 'indisponible')
  assert.ok(!/\$|budget|airroi|clé|cle/i.test(panne.corps.message), panne.corps.message)
})

test('LE TEST QUI COMPTE : retenir — au moins 3, tous dans la derniere liste proposee ; les autres sont desactives, pas supprimes', async () => {
  const deux = await appeler({ method: 'POST', body: { action: 'retenir', listing_ids: IDS.slice(0, 2) }, tables: TABLES() })
  assert.equal(deux.code, 400)
  assert.match(deux.corps.message, /au moins 3/)
  const intrus = await appeler({ method: 'POST', body: { action: 'retenir', listing_ids: [...IDS.slice(0, 2), '123456789'] }, tables: TABLES() })
  assert.equal(intrus.code, 400)
  assert.match(intrus.corps.message, /ne fait plus partie de la liste/)
  assert.ok(!intrus.ecrits.length, 'rien n est ecrit')
  const ok = await appeler({ method: 'POST', body: { action: 'retenir', listing_ids: [...IDS, IDS[0]] }, tables: TABLES() })
  assert.deepEqual(ok.corps.retenus, IDS, 'doublon retire')
  const [react, desact] = ok.ecrits.filter(e => e.op === 'update')
  assert.deepEqual(react.maj, { actif: true })
  assert.deepEqual(react.filtres, [['eq', 'property_id', 'BIEN-A'], ['in', 'listing_id', IDS]])
  assert.deepEqual(desact.maj, { actif: false })
  // ⚠ Review de 4f19d8b (C1) : seuls les anciens choix DU PROPRIETAIRE sont
  // desactives ; ceux du fondateur restent.
  assert.deepEqual(desact.filtres, [['eq', 'property_id', 'BIEN-A'], ['eq', 'retenu_par', 'proprietaire'], ['not', 'listing_id', 'in', `(${IDS.join(',')})`]])
  assert.ok(!ok.ecrits.some(e => e.op === 'delete'))
})

test('retenir : sans liste en cache pour ce profil, on demande de relancer la recherche', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'retenir', listing_ids: IDS }, tables: { ...TABLES(), airroi_cache: [] } })
  assert.equal(r.code, 400)
  assert.match(r.corps.message, /Relancez la recherche/)
})

test('profil : saisie invalide ou adresse introuvable — 400 avec le message pour l hote, rien n est ecrit', async () => {
  const mauvais = await appeler({ method: 'POST', body: { action: 'profil', adresse: '12 rue', voyageurs: 2, chambres: 3, pieces: 2, salles_de_bain: 1 }, tables: TABLES() })
  assert.equal(mauvais.code, 400)
  assert.match(mauvais.corps.message, /pièces/)
  const vague = await appeler({ method: 'POST', body: { action: 'profil', adresse: 'Bagnères', voyageurs: 2, chambres: 1, pieces: 2, salles_de_bain: 1 }, tables: TABLES(),
    geocode: { features: [{ geometry: { coordinates: [0.14, 43.06] }, properties: { label: 'Bagnères-de-Bigorre', score: 0.9, type: 'municipality' } }] } })
  assert.equal(vague.code, 400)
  assert.match(vague.corps.message, /trop vague/)
  assert.ok(!mauvais.ecrits.length && !vague.ecrits.length)
})

test('action inconnue : refusee', async () => {
  assert.equal((await appeler({ method: 'POST', body: { action: 'payer' }, tables: TABLES() })).code, 400)
})

test('WRITER UNIQUE : seul choix-comparables.js ecrit dans comparables_retenus', () => {
  const fautifs = []
  const parcourir = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const c = path.join(d, f.name)
    if (f.isDirectory()) parcourir(c)
    else if (f.name.endsWith('.js') && /from\('comparables_retenus'\)\s*\.(upsert|insert|update|delete)/.test(fs.readFileSync(c, 'utf8')) && !c.endsWith(path.join('lib', 'marche', 'choix-comparables.js'))) fautifs.push(c)
  } }
  parcourir(path.join(RACINE, 'lib')); parcourir(path.join(RACINE, 'api'))
  assert.deepEqual(fautifs, [])
})

// ─── Constats de la review de 4f19d8b ───────────────────────────────────────
const appel = (o) => ({ endpoint: 'GET /listings/comparables', created_at: new Date(Date.now() - 3600000).toISOString(), cout_usd: 0.1, ...o })

test('LE TEST QUI COMPTE (SECURITE, review S1) : le quota des recherches NOUVELLES — par bien, par compte, et pour tout le mois', async () => {
  const sansCache = { ...TABLES(), airroi_cache: [] }
  const cas = {
    bien: Array.from({ length: 3 }, () => appel({ property_id: 'BIEN-A', user_id: 'COMPTE' })),
    compte: Array.from({ length: 5 }, (_, i) => appel({ property_id: `AUTRE-${i}`, user_id: 'COMPTE' })),
    mois: Array.from({ length: 50 }, (_, i) => appel({ property_id: `X-${i}`, user_id: `U-${i}`, created_at: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 0, 1)).toISOString() })),
  }
  for (const [nom, journal] of Object.entries(cas)) {
    const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...sansCache, airroi_appels: journal } })
    assert.equal(r.appelsAirroi.length, 0, `${nom} : aucun appel paye`)
    assert.equal(r.corps.etat, 'indisponible', nom)
    assert.match(r.corps.message, /Réessayez demain/)
    assert.ok(!/\$|budget|quota|airroi/i.test(r.corps.message))
  }
  // Juste sous les plafonds : la recherche part.
  const sous = [...cas.bien.slice(0, 2), appel({ endpoint: 'GET /listings/metrics/all', property_id: 'BIEN-A', user_id: 'COMPTE' })]
  const ok = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...sansCache, airroi_appels: sous } })
  assert.equal(ok.appelsAirroi.length, 1, 'les autres endpoints ne comptent pas dans ce quota')
})

test('quota : une liste FRAICHE en cache ne compte pas — la recherche est servie meme quota atteint', async () => {
  const journal = Array.from({ length: 3 }, () => appel({ property_id: 'BIEN-A', user_id: 'COMPTE' }))
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_appels: journal } })
  assert.equal(r.corps.etat, 'calcule')
})

test('REVIEW : une liste en cache PERIMEE (plus de 90 jours) n est plus proposee ni ne valide un choix', async () => {
  const vieux = { ...TABLES(), airroi_cache: [{ ...TABLES().airroi_cache[0], recupere_le: '2026-01-01T00:00:00Z' }] }
  const g = await appeler({ tables: vieux })
  assert.equal(g.corps.comparables, null)
  const r = await appeler({ method: 'POST', body: { action: 'retenir', listing_ids: IDS }, tables: vieux })
  assert.equal(r.code, 400)
  assert.match(r.corps.message, /Relancez la recherche/)
})

test('REVIEW (C3) : la table du profil absente (migration non appliquee) — un message, jamais une erreur brute', async () => {
  const t = { ...TABLES(), __absentes: ['bien_profil'] }
  const g = await appeler({ tables: t })
  assert.equal(g.code, 200)
  assert.equal(g.corps.etat, 'indisponible')
  assert.match(g.corps.message, /pas encore disponible/)
  const p = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: t })
  assert.equal(p.corps.etat, 'indisponible')
  assert.equal(p.appelsAirroi.length, 0)
})

test('REVIEW : retenir apres un changement de profil, avec l ancienne liste encore en cache — refuse, rien n est ecrit', async () => {
  const t = TABLES()
  t.bien_profil = [{ ...t.bien_profil[0], voyageurs: 4 }]
  const r = await appeler({ method: 'POST', body: { action: 'retenir', listing_ids: IDS }, tables: t })
  assert.equal(r.code, 400)
  assert.ok(!r.ecrits.length)
})

test('une carte renvoyee a exactement les cles de la liste blanche', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: TABLES() })
  for (const c of r.corps.comparables) {
    assert.deepEqual(Object.keys(c).sort(), ['chambres', 'distance_km', 'equipements', 'listing_id', 'nom', 'ouvert_toute_annee', 'photo', 'position_approchee', 'ressemblance', 'voyageurs'])
  }
})
