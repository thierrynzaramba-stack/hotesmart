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
  const rpcs = []
  const client = { rpc: async (fn, params) => {
    rpcs.push({ fn, params })
    if (tables.__rpcPanneNieme === rpcs.length) return { data: null, error: { message: 'connexion perdue' } }
    if (tables.__rpcAbsente) return { data: null, error: { message: `Could not find the function public.${fn}(...) in the schema cache` } }
    if (fn === 'rendre_recherche_comparables') return { data: true, error: null }
    if (tables.__rpcPanneCout !== undefined && params.p_cout === tables.__rpcPanneCout) return { data: null, error: { message: 'connexion perdue' } }
    return { data: tables.__rpc === undefined ? 'ok' : tables.__rpc, error: null }
  }, from: tb => {
    lus.push(tb)
    let lignes = [...(tables[tb] || [])]
    const absente = (tables.__absentes || []).includes(tb)
    const erreur = { message: `Could not find the table 'public.${tb}' in the schema cache` }
    const q = {
      select: () => q,
      eq: (k, v) => { lignes = lignes.filter(l => String(l[k]) === String(v)); return q },
      gte: (k, v) => { lignes = lignes.filter(l => l[k] >= v); return q },
      // ⚠ Comme le VRAI client (recette du 5 octobre 2026) : supabase-js n'echappe
      // pas les guillemets d'une valeur, et PostgREST ne trouve alors RIEN.
      in: (k, vs) => { lignes = lignes.filter(l => vs.includes(l[k]) && !/["\\]/.test(String(l[k]))); return q },
      // La liste PostgREST echappee a la main : "a\"b","c" -> ['a"b', 'c'].
      filter: (k, op, liste) => {
        assert.equal(op, 'in')
        const vs = [...String(liste).matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1'))
        lignes = lignes.filter(l => vs.includes(l[k]))
        return q
      },
      order: () => q,
      limit: n => Promise.resolve(absente ? { data: null, error: erreur } : { data: lignes.slice(0, n), error: null }),
      // Comme le vrai client : range() se chaine encore (eq apres range).
      range: (a, z) => { lignes = lignes.slice(a, z + 1); return q },
      then: (ok, ko) => Promise.resolve(absente ? { data: null, error: erreur } : { data: lignes, error: null }).then(ok, ko),
      upsert: (ligne, opts) => { ecrits.push({ tb, op: 'upsert', ligne, opts }); if (tables.__upsertPanne === tb) return Promise.resolve({ error: { message: 'connexion perdue' } }); if (tb === 'bien_profil') tables.bien_profil = [{ ...PROFIL, ...ligne, latitude: String(ligne.latitude), longitude: String(ligne.longitude) }]; return Promise.resolve({ error: null }) },
      update: (maj) => {
        const u = { tb, op: 'update', maj, filtres: [] }
        ecrits.push(u)
        const w = {
          eq: (k, v) => { u.filtres.push(['eq', k, v]); return w },
          select: () => Promise.resolve({ data: (tables[tb] || []).filter(l => u.filtres.every(([op, k, v]) => op !== 'eq' || String(l[k]) === String(v))), error: null }),
          in: (k, v) => { u.filtres.push(['in', k, v]); return Promise.resolve({ error: null }) },
          not: (k, op, v) => { u.filtres.push(['not', k, op, v]); return Promise.resolve({ error: null }) },
        }
        return w
      },
    }
    return q
  } }
  return { client, lus, ecrits, rpcs }
}

async function appeler ({ method = 'GET', query = { property_id: 'REF-42' }, body = null, tables = {}, garde = { ok: true, userId: 'MEMBRE', accountUserId: 'COMPTE', bien: { id: 'BIEN-A' } }, airroi = null, airroiEq = null, geocode = null }) {
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
    require.cache[cheminClient].exports = { ...vraiClient, creerClient: () => ({
      comparables: async (params, ctx) => {
        appelsAirroi.push({ params, ctx })
        if (airroi instanceof Error) throw airroi
        // Comme le VRAI client : la reponse entre au cache (la route le relit).
        const donnees = airroi || { listings: COMPS }
        const cleBase = cleCanonique('GET /listings/comparables', { ...params, currency: 'native' })
        tables.airroi_cache = [...(tables.airroi_cache || []).filter(c => c.cle !== cleBase), { cle: cleBase, reponse: JSON.stringify(donnees), recupere_le: new Date().toISOString() }]
        return { donnees, depuisCache: false }
      },
      calendrierAnnonce: async (listingId, ctx) => {
        appelsAirroi.push({ calendrier: String(listingId), ctx })
        if ((tables.__calendrier404 || []).includes(String(listingId))) throw Object.assign(new Error('HTTP 404'), { coutLibere: true, http: 404 })
        if (tables.__calendrierEnPanne) throw Object.assign(new Error('HTTP 500'), { coutLibere: tables.__calendrierEnPanne !== 'facture' })
        return { donnees: { currency: 'EUR', results: CALENDRIER(100) }, depuisCache: false }
      },
      rechercheActifs: async (corps, ctx) => {
        appelsAirroi.push({ corps, ctx, actifs: true })
        const page = corps.pagination.offset / 10
        const err = typeof airroiEq === 'function' ? airroiEq(page) : airroiEq
        if (err instanceof Error) throw err
        const reponse = pageActifs(page, tables.__totalActifs ?? 76, tables.__poolActifs || POOL)
        if (tables.__cacheMuet) return { donnees: lireJson(reponse), depuisCache: false }
        const cle = cleCanonique('POST /listings/search/radius', corps)
        // Comme le vrai depot : upsert sur la cle (l'ancienne ligne est remplacee).
        tables.airroi_cache = [...(tables.airroi_cache || []).filter(c => c.cle !== cle), { cle, reponse, recupere_le: new Date().toISOString() }]
        return { donnees: lireJson(reponse), depuisCache: false }
      },
    }) }
    globalThis.fetch = async () => ({ ok: true, json: async () => geocode || { features: [{ geometry: { coordinates: [0.1476, 43.0636] }, properties: { label: '12 Rue des Thermes 65200 Bagnères-de-Bigorre', score: 0.93, type: 'housenumber' } }] } })
    delete require.cache[ch('api/marche-comparables')]
    const api = require(path.join(RACINE, 'api', 'marche-comparables'))
    const r = await new Promise(resolve => {
      let code = 200
      const res = { status (c) { code = c; return res }, setHeader () {}, json: corps => resolve({ code, corps }) }
      Promise.resolve(api({ method, query, body, headers: {} }, res)).then(() => resolve({ code, corps: null }))
    })
    return { ...r, gardes, lus: b.lus, ecrits: b.ecrits, rpcs: b.rpcs, appelsAirroi }
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

// Une carte ne porte AUCUNE cle d'argent, a aucun niveau, ni de montant dans un texte.
// Mots ENTIERS d'une cle (« strategie » contient « rate » sans en etre une).
const CLES_ARGENT = /^(ttm_|l90d_)|(^|_)(rate|revenue|occupancy|revpar|fee|price|prix|currency)(_|$)/i
function clesArgent (o, chemin = '') {
  if (Array.isArray(o)) return o.flatMap((x, i) => clesArgent(x, `${chemin}[${i}]`))
  if (!o || typeof o !== 'object') return []
  return Object.entries(o).flatMap(([k, v]) => [...(CLES_ARGENT.test(k) ? [`${chemin}.${k}`] : []), ...clesArgent(v, `${chemin}.${k}`)])
}
const IDS = COMPS.slice(0, 3).map(c => String(c.listing_info.listing_id))
// §22.10 : les biens ACTIFS avec jacuzzi — vraie reponse AirROI (Toulouse, 5
// octobre 2026), declinee en 50 annonces distinctes pour les pages suivantes.
const ACTIFS = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'actifs-jacuzzi-toulouse-2026-10-05.json'), 'utf8')).results
const POOL = Array.from({ length: 50 }, (_, i) => ({ ...ACTIFS[i % 10], listing_info: { ...ACTIFS[i % 10].listing_info, listing_id: String(7000000 + i) } }))
const { corpsRechercheActifs } = require('../lib/marche/choix-comparables')
const PROFIL_SPA = { ...PROFIL, equipements: ['parking', 'spa'] }
const cleActifs = page => cleCanonique('POST /listings/search/radius', corpsRechercheActifs({ ...PROFIL_SPA, latitude: 43.0636, longitude: 0.1476 }, page))
const pageActifs = (page, total = 76, pool = POOL) => JSON.stringify({ pagination: { total_count: total, page_size: 10, offset: page * 10 }, results: pool.slice(page * 10, page * 10 + 10) })
const pageEnCache = (page, total, pool) => ({ cle: cleActifs(page), reponse: pageActifs(page, total, pool), recupere_le: new Date().toISOString() })

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
  const r = await appeler({ method: 'POST', body: { action: 'retenir', choix: (IDS).map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: TABLES() })
  assert.equal(r.code, 200)
  const up = r.ecrits.find(e => e.tb === 'comparables_retenus' && e.op === 'upsert')
  assert.ok(up.ligne.every(l => l.user_id === 'COMPTE' && l.property_id === 'BIEN-A' && l.retenu_par === 'proprietaire' && l.actif === true))
  assert.deepEqual(up.opts, { onConflict: 'property_id,listing_id', ignoreDuplicates: true }, 'une ligne existante n est jamais reecrite')
  const ch = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [] } })
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

test('LE TEST QUI COMPTE : AUCUN prix, revenu ou occupation ne sort — ni au GET ni a la recherche ; la position de l hote seulement dans SON profil (§21.4)', async () => {
  // §22.7 : les prix de DEPART de l'hote sont affiches a dessein ; ce qui ne
  // porte jamais de prix, ce sont les cartes des comparables et le profil.
  for (const r of [await appeler({ tables: TABLES() }), await appeler({ method: 'POST', body: { action: 'chercher' }, tables: TABLES() })]) {
    assert.deepEqual(clesArgent({ comparables: r.corps.comparables, profil: r.corps.profil }), [], 'aucune cle d argent dans les cartes ni le profil')
    assert.ok(!/geocode_score|€/.test(JSON.stringify(r.corps)))
  }
  const g = await appeler({ tables: TABLES() })
  assert.equal(g.corps.profil.latitude, 43.0636)
  assert.equal(g.corps.profil.longitude, 0.1476)
})

test('chercher : la recherche AirROI part du PROFIL (position geocodee, vraies chambres, salles de bain, voyageurs)', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [] } })
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
  const panne = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [] }, airroi: e })
  assert.equal(panne.corps.etat, 'indisponible')
  assert.ok(!/\$|budget|airroi|clé|cle/i.test(panne.corps.message), panne.corps.message)
})

test('LE TEST QUI COMPTE : retenir — au moins 3, tous dans la derniere liste proposee ; les autres sont desactives, pas supprimes', async () => {
  const deux = await appeler({ method: 'POST', body: { action: 'retenir', choix: (IDS.slice(0, 2)).map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: TABLES() })
  assert.equal(deux.code, 400)
  assert.match(deux.corps.message, /au moins 3/)
  const intrus = await appeler({ method: 'POST', body: { action: 'retenir', choix: ([...IDS.slice(0, 2), '123456789']).map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: TABLES() })
  assert.equal(intrus.code, 400)
  assert.match(intrus.corps.message, /ne fait plus partie de la liste/)
  assert.ok(!intrus.ecrits.length, 'rien n est ecrit')
  const ok = await appeler({ method: 'POST', body: { action: 'retenir', choix: ([...IDS, IDS[0]]).map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: TABLES() })
  assert.deepEqual(ok.corps.retenus, IDS, 'doublon retire')
  const majs = ok.ecrits.filter(e => e.op === 'update')
  const react = majs.find(e => e.maj.actif === true)
  const desact = majs.find(e => e.maj.actif === false)
  // Review de 1e64a2b : les positions AVANT la reactivation.
  assert.ok(majs.findIndex(e => e.maj.position) < majs.indexOf(react))
  assert.deepEqual(react.maj, { actif: true })
  assert.deepEqual(react.filtres, [['eq', 'property_id', 'BIEN-A'], ['in', 'listing_id', IDS]])
  assert.deepEqual(desact.maj, { actif: false })
  // ⚠ Review de 4f19d8b (C1) : seuls les anciens choix DU PROPRIETAIRE sont
  // desactives ; ceux du fondateur restent.
  assert.deepEqual(desact.filtres, [['eq', 'property_id', 'BIEN-A'], ['eq', 'retenu_par', 'proprietaire'], ['not', 'listing_id', 'in', `(${IDS.join(',')})`]])
  assert.ok(!ok.ecrits.some(e => e.op === 'delete'))
})

test('retenir : sans liste en cache pour ce profil, on demande de relancer la recherche', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'retenir', choix: (IDS).map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: { ...TABLES(), airroi_cache: [] } })
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

// ─── Le quota ATOMIQUE (reviews de 4f19d8b et 7ace057, SECURITE) ───────────
test('LE TEST QUI COMPTE (SECURITE) : une recherche NOUVELLE passe d abord par la reservation atomique, avec les plafonds', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [] } })
  assert.deepEqual(r.rpcs, [{ fn: 'reserver_recherche_comparables', params: { p_user: 'COMPTE', p_property: 'BIEN-A', p_cout: 0.10, p_nature: 'recherche', p_bien_jour: 5, p_compte_jour: 10, p_compte_30j: 20, p_calendriers_90j: 15, p_budget_mois: 25 } }])
  assert.equal(r.appelsAirroi.length, 1)
})

test('LE TEST QUI COMPTE (SECURITE) : reservation refusee — AUCUN appel paye, une phrase simple selon le plafond', async () => {
  const attendus = { bien: /ce logement aujourd’hui\. Réessayez demain/, compte: /aujourd’hui\. Réessayez demain/, compte_mois: /ce mois est atteint/, mois: /momentanément indisponible/, autre: /momentanément indisponible/ }
  for (const [motif, message] of Object.entries(attendus)) {
    const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [], __rpc: motif } })
    assert.equal(r.appelsAirroi.length, 0, motif)
    assert.equal(r.corps.etat, 'indisponible')
    assert.match(r.corps.message, message, motif)
    assert.ok(!/\$|budget|quota|airroi/i.test(r.corps.message))
  }
  // Une reponse illisible de la fonction est un REFUS, jamais un paiement.
  const nulle = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [], __rpc: null } })
  assert.equal(nulle.appelsAirroi.length, 0)
})

test('quota : une liste FRAICHE en cache ne reserve rien, et le client AirROI n est meme pas appele', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), __rpc: 'mois' } })
  assert.equal(r.rpcs.length, 0)
  assert.equal(r.appelsAirroi.length, 0, 'servie depuis la lecture du cache, sans second passage par le client')
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.comparables.length, 25)
})

test('quota : la fonction SQL absente (migration non appliquee) — un message, aucun appel paye', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [], __rpcAbsente: true } })
  assert.equal(r.appelsAirroi.length, 0)
  assert.equal(r.corps.etat, 'indisponible')
})

test('LE TEST QUI COMPTE (SECURITE) : la migration du quota — verrou, comptage ET reservation dans la meme fonction, execution fermee aux clients', () => {
  const sql = fs.readFileSync(path.join(RACINE, 'migrations', '2026-10-05-comparables-recherches.sql'), 'utf8')
  assert.ok(sql.split('\n').every(l => l.length < 60), 'lignes courtes')
  const corpsFn = sql.slice(sql.indexOf('as $$'), sql.lastIndexOf('$$;'))
  assert.match(corpsFn, /pg_advisory_xact_lock/)
  assert.ok(corpsFn.indexOf('pg_advisory_xact_lock') < corpsFn.indexOf('select count'), 'le verrou AVANT le premier comptage')
  assert.ok(corpsFn.lastIndexOf('select count') < corpsFn.indexOf('insert into comparables_recherches'), 'la reservation APRES tous les comptages, dans la meme fonction')
  for (const p of ["date_trunc('month', now(), 'UTC')", "interval '24 hours'", "interval '30 days'"]) assert.ok(corpsFn.includes(p), p)
  assert.match(sql, /security definer/)
  assert.match(sql, /set search_path = public/)
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/)
  assert.match(sql, /enable row level security/)
})

test('GET : les retenus du FONDATEUR sont dits a part', async () => {
  const t = TABLES()
  t.comparables_retenus = [{ property_id: 'BIEN-A', listing_id: 'F1', actif: true, retenu_par: 'fondateur' }, { property_id: 'BIEN-A', listing_id: String(COMPS[0].listing_info.listing_id), actif: true, retenu_par: 'proprietaire' }]
  const g = await appeler({ tables: t })
  assert.deepEqual(g.corps.fondateur, ['F1'])
  assert.equal(g.corps.retenus.length, 2)
})

test('REVIEW : une liste en cache PERIMEE (plus de 90 jours) n est plus proposee ni ne valide un choix', async () => {
  const vieux = { ...TABLES(), airroi_cache: [{ ...TABLES().airroi_cache[0], recupere_le: '2026-01-01T00:00:00Z' }] }
  const g = await appeler({ tables: vieux })
  assert.equal(g.corps.comparables, null)
  const r = await appeler({ method: 'POST', body: { action: 'retenir', choix: (IDS).map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: vieux })
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
  const r = await appeler({ method: 'POST', body: { action: 'retenir', choix: (IDS).map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: t })
  assert.equal(r.code, 400)
  assert.ok(!r.ecrits.length)
})

test('une carte renvoyee a exactement les cles de la liste blanche', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: TABLES() })
  for (const c of r.corps.comparables) {
    assert.deepEqual(Object.keys(c).sort(), ['a_vos_equipements', 'chambres', 'details', 'distance_km', 'equipements', 'latitude', 'listing_id', 'longitude', 'nom', 'ouvert_toute_annee', 'photo', 'photos', 'position_approchee', 'rares_en_plus', 'rares_manquants', 'ressemblance', 'source', 'voyageurs'])
  }
})

// ─── §21 : la recherche par equipement ──────────────────────────────────────
const AVEC_SPA = () => ({ ...TABLES(), bien_profil: [{ ...PROFIL_SPA, property_id: 'BIEN-A' }] })

// ─── §22.10 : la selection — actifs, meme valeur percue, tries par revenu ───
const ids = r => r.corps.comparables.map(c => c.listing_id)

test('LE TEST QUI COMPTE (§22.10) : un bien avec jacuzzi — 20 biens ACTIFS qui ONT un jacuzzi, dans l ordre du revenu, 2 pages reservees a 0,50 $ ; aucun voisin', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: AVEC_SPA() })
  assert.deepEqual(reservations(r), [0.50, 0.50])
  assert.ok(!r.appelsAirroi.some(a => a.params), 'la liste des 25 voisins n est pas demandee')
  const pages = r.appelsAirroi.filter(a => a.actifs)
  assert.deepEqual(pages.map(a => a.corps.pagination.offset), [0, 10])
  const f = pages[0].corps
  assert.deepEqual(f.filter.amenities, { all: ['hot_tub'] }, 'jacuzzi = jacuzzi : un sauna seul ne compte pas')
  assert.deepEqual(f.filter.bedrooms, { eq: 1 }, 'meme nombre de chambres')
  assert.deepEqual(f.filter.room_type, { eq: 'entire_home' })
  assert.deepEqual(f.sort, { ttm_revenue: 'desc' })
  assert.equal(f.radius_miles, 6.2)
  assert.deepEqual([f.latitude, f.longitude], [43.06, 0.15], 'la zone, arrondie au centieme : la cle se partage')
  assert.deepEqual(ids(r), POOL.slice(0, 20).map(x => x.listing_info.listing_id), 'l ordre d AirROI (revenu), pas la ressemblance')
  assert.equal(r.corps.encore, true)
  assert.deepEqual(pages[0].ctx, { propertyId: 'BIEN-A', userId: 'COMPTE' })
})

test('§22.10 : « Voir 10 de plus » charge la page SUIVANTE (0,50 $), jusqu a 50 au plus', async () => {
  const t = AVEC_SPA()
  t.airroi_cache.push(pageEnCache(0), pageEnCache(1))
  const r = await appeler({ method: 'POST', body: { action: 'plus' }, tables: t })
  assert.deepEqual(reservations(r), [0.50])
  assert.deepEqual(r.appelsAirroi.map(a => a.corps.pagination.offset), [20])
  assert.equal(r.corps.comparables.length, 30)
  assert.equal(r.corps.encore, true)
  // 5 pages : plus rien a voir, rien n est paye.
  const plein = AVEC_SPA()
  plein.airroi_cache.push(...[0, 1, 2, 3, 4].map(i => pageEnCache(i)))
  const g = await appeler({ tables: plein })
  assert.equal(g.corps.comparables.length, 50)
  assert.equal(g.corps.encore, false)
  const non = await appeler({ method: 'POST', body: { action: 'plus' }, tables: plein })
  assert.equal(non.code, 400)
  assert.deepEqual([non.rpcs.length, non.appelsAirroi.length], [0, 0])
})

test('§22.10 : AirROI n en a que 8 — une seule page, rien a voir de plus', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...AVEC_SPA(), __totalActifs: 8, __poolActifs: POOL.slice(0, 8) } })
  assert.deepEqual(reservations(r), [0.50])
  assert.equal(r.corps.comparables.length, 8)
  assert.equal(r.corps.encore, false)
})

test('LE TEST QUI COMPTE (§22.10) : le cache se PARTAGE — les pages chargees par un autre hote du secteur ne se repaient pas', async () => {
  const t = AVEC_SPA()
  t.airroi_cache.push(pageEnCache(0), pageEnCache(1))
  // Un autre bien du meme secteur (a quelques centaines de metres) : meme zone.
  t.bien_profil = [{ ...PROFIL_SPA, latitude: '43.0612', longitude: '0.1531', property_id: 'BIEN-A' }]
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: t })
  assert.deepEqual([r.rpcs.length, r.appelsAirroi.length], [0, 0])
  assert.equal(r.corps.comparables.length, 20)
  const g = await appeler({ tables: t })
  assert.equal(g.corps.comparables.length, 20)
  assert.equal(g.corps.encore, true)
  assert.equal(g.appelsAirroi.length, 0)
})

test('LE TEST QUI COMPTE (§22.10) : aucun bien INACTIF ni retire n est propose — ni affiche, ni retenable', async () => {
  const pool = POOL.map(x => ({ ...x }))
  pool[0] = { ...pool[0], performance_metrics: { ...pool[0].performance_metrics, l90d_available_days: 0 } }           // calendrier mort
  pool[1] = { ...pool[1], performance_metrics: { ...pool[1].performance_metrics, ttm_days_reserved: 12, l90d_days_reserved: 3 } } // trop peu vendu
  pool[2] = { ...pool[2], performance_metrics: { ...pool[2].performance_metrics, ttm_days_reserved: 12, l90d_days_reserved: 10 } } // annonce recente : ACTIVE
  const t = AVEC_SPA()
  t.airroi_cache.push(pageEnCache(0, 76, pool), pageEnCache(1, 76, pool))
  t.airroi_annonces_retirees = [{ listing_id: '7000003', http: 404, constatee_le: new Date().toISOString() }]
  const g = await appeler({ tables: t })
  const vus = ids(g)
  assert.ok(!vus.includes('7000000') && !vus.includes('7000001') && !vus.includes('7000003'))
  assert.ok(vus.includes('7000002'), '10 nuits sur 90 jours suffisent')
  assert.equal(vus.length, 17)
  const r = await appeler({ method: 'POST', body: { action: 'retenir', choix: ['7000000', '7000004', '7000005'].map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: t })
  assert.equal(r.code, 400)
  const ok = await appeler({ method: 'POST', body: { action: 'retenir', choix: ['7000002', '7000004', '7000005'].map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: t })
  assert.equal(ok.code, 200)
})

test('§22.10 : un bien SANS equipement rare garde ses 25 voisins — seulement les actifs ; pas de « plus »', async () => {
  const comps = COMPS.map(x => ({ ...x }))
  comps[0] = { ...comps[0], listing_info: { ...comps[0].listing_info, room_type: 'private_room' } }
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [] }, airroi: { listings: comps } })
  assert.deepEqual(reservations(r), [0.10])
  assert.ok(!r.appelsAirroi.some(a => a.actifs))
  assert.equal(r.corps.comparables.length, 24, 'la chambre privee n est pas proposee')
  assert.equal(r.corps.encore, false)
  const plus = await appeler({ method: 'POST', body: { action: 'plus' }, tables: TABLES() })
  assert.equal(plus.code, 400)
  assert.equal(plus.rpcs.length, 0)
})

test('§22.10 : la 2e page refusee par le quota — la 1re s affiche, et c est dit', async () => {
  const t = AVEC_SPA()
  t.airroi_cache.push(pageEnCache(0))
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...t, __rpc: 'bien' } })
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.comparables.length, 10)
  assert.match(r.corps.note, /Plusieurs recherches/)
  assert.equal(r.appelsAirroi.length, 0)
})

test('§22.10 : la cle de cache d une page est celle qu ecrit le VRAI client AirROI', async () => {
  const { creerClient: vraiCreer } = require('../lib/airroi/client')
  const ecrits = []
  const depot = { lireCache: async () => null, ecrireCache: async (l) => { ecrits.push(l.cle) }, reserver: async () => 1, terminer: async () => {}, appelsDepuis: async () => [] }
  const avant = process.env.AIRROI_API_KEY
  process.env.AIRROI_API_KEY = 'cle-de-test-factice'
  try {
    const client = vraiCreer({ depot, alerter: null, fetch: async () => ({ ok: true, status: 200, text: async () => pageActifs(1) }) })
    await client.rechercheActifs(corpsRechercheActifs({ ...PROFIL_SPA, latitude: 43.0636, longitude: 0.1476 }, 1), { propertyId: 'BIEN-A', userId: 'COMPTE' })
  } finally { if (avant === undefined) delete process.env.AIRROI_API_KEY; else process.env.AIRROI_API_KEY = avant }
  assert.deepEqual(ecrits, [cleActifs(1)])
})

test('LE TEST QUI COMPTE (SECURITE, §21.3) : la migration du quota en dollars — cout reserve sous le meme verrou, somme du mois, ancienne signature supprimee', () => {
  const sql = fs.readFileSync(path.join(RACINE, 'migrations', '2026-10-05-comparables-recherches-cout.sql'), 'utf8')
  assert.ok(sql.split('\n').every(l => l.length < 60))
  const corpsFn = sql.slice(sql.indexOf('as $$'), sql.lastIndexOf('$$;'))
  assert.ok(corpsFn.indexOf('pg_advisory_xact_lock') < corpsFn.indexOf('sum(cout_usd)'), 'le verrou avant la somme')
  assert.ok(corpsFn.lastIndexOf('select count') < corpsFn.indexOf('insert into comparables_recherches'))
  assert.match(corpsFn, /\(user_id, property_id, cout_usd\)/)
  assert.match(corpsFn, /depense \+ p_cout > p_budget_mois/)
  assert.match(sql, /drop function if exists[\s\S]*uuid, uuid, int, int, int, int\)/)
  assert.match(sql, /revoke all on function[\s\S]*uuid, uuid, numeric, int, int, int, numeric\)[\s\S]*from public, anon, authenticated/)
  assert.match(sql, /security definer/)
})

// ─── Constats de la review de 25ab9e6 ───────────────────────────────────────
const reservations = r => r.rpcs.filter(x => x.fn === 'reserver_recherche_comparables').map(x => x.params.p_cout)
const rendus = r => r.rpcs.filter(x => x.fn === 'rendre_recherche_comparables').map(x => x.params)

test('LE TEST QUI COMPTE (review C1) : un appel qui ECHOUE rend sa reservation — base comme page des actifs', async () => {
  const libere = m => Object.assign(new Error(m), { coutLibere: true })
  const base = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [] }, airroi: libere('HTTP 422') })
  assert.deepEqual(rendus(base), [{ p_property: 'BIEN-A', p_cout: 0.10, p_nature: 'recherche' }])
  assert.equal(base.corps.etat, 'indisponible')
  const comp = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: AVEC_SPA(), airroiEq: libere('HTTP 422') })
  assert.deepEqual(rendus(comp), [{ p_property: 'BIEN-A', p_cout: 0.50, p_nature: 'recherche' }])
  assert.equal(comp.corps.etat, 'indisponible')
  // Un appel reussi ne rend rien.
  const ok = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: AVEC_SPA() })
  assert.deepEqual(rendus(ok), [])
})

test('LE TEST QUI COMPTE (SECURITE) : la migration — deux couts seulement, parametres nuls refuses, rendre sous le meme verrou et borne a 10 minutes', () => {
  const sql = fs.readFileSync(path.join(RACINE, 'migrations', '2026-10-05-comparables-recherches-cout.sql'), 'utf8')
  assert.ok(sql.split('\n').every(l => l.length < 60))
  assert.match(sql, /p_cout not in \(0\.10, 0\.50\)/)
  assert.match(sql, /or p_budget_mois is null then/)
  const rendre = sql.slice(sql.indexOf('rendre_recherche_comparables('), sql.lastIndexOf('$$;'))
  assert.ok(rendre.indexOf('pg_advisory_xact_lock') < rendre.indexOf('delete from comparables_recherches'))
  assert.match(rendre, /interval '10 minutes'/)
  assert.match(sql, /revoke all on function\s+public\.rendre_recherche_comparables\(\s+uuid, numeric\)\s+from public, anon, authenticated/)
})

// ─── §22.1 : la position par comparable ─────────────────────────────────────
test('LE TEST QUI COMPTE (§22.1) : retenir enregistre la POSITION de chaque comparable — jamais sur un retenu de l equipe', async () => {
  const choix = [{ listing_id: IDS[0], position: 'dessous' }, { listing_id: IDS[1], position: 'equivalent' }, { listing_id: IDS[2], position: 'dessus' }]
  const r = await appeler({ method: 'POST', body: { action: 'retenir', choix }, tables: TABLES() })
  assert.equal(r.code, 200)
  assert.deepEqual(r.corps.positions, { [IDS[0]]: 'dessous', [IDS[1]]: 'equivalent', [IDS[2]]: 'dessus' })
  const up = r.ecrits.find(e => e.op === 'upsert')
  assert.deepEqual(up.ligne.map(l => [l.listing_id, l.position]), choix.map(c => [c.listing_id, c.position]))
  const parPos = r.ecrits.filter(e => e.op === 'update' && e.maj.position)
  assert.deepEqual(parPos.map(e => [e.maj.position, e.filtres]), [
    ['dessous', [['eq', 'property_id', 'BIEN-A'], ['eq', 'retenu_par', 'proprietaire'], ['in', 'listing_id', [IDS[0]]]]],
    ['equivalent', [['eq', 'property_id', 'BIEN-A'], ['eq', 'retenu_par', 'proprietaire'], ['in', 'listing_id', [IDS[1]]]]],
    ['dessus', [['eq', 'property_id', 'BIEN-A'], ['eq', 'retenu_par', 'proprietaire'], ['in', 'listing_id', [IDS[2]]]]],
  ])
})

test('§22.1 : une position inconnue, ou deux positions pour un meme bien, sont refusees — rien n est ecrit', async () => {
  const mauvais = [
    [{ listing_id: IDS[0], position: 'similaire' }, { listing_id: IDS[1], position: 'equivalent' }, { listing_id: IDS[2], position: 'dessus' }],
    [{ listing_id: IDS[0], position: 'dessous' }, { listing_id: IDS[0], position: 'dessus' }, { listing_id: IDS[1], position: 'equivalent' }, { listing_id: IDS[2], position: 'dessus' }],
  ]
  for (const choix of mauvais) {
    const r = await appeler({ method: 'POST', body: { action: 'retenir', choix }, tables: TABLES() })
    assert.equal(r.code, 400)
    assert.ok(!r.ecrits.length)
  }
  const ancien = await appeler({ method: 'POST', body: { action: 'retenir', listing_ids: IDS }, tables: TABLES() })
  assert.equal(ancien.code, 400, 'l ancienne forme sans position est refusee')
})

test('§22.1 : le GET rend la position de chaque retenu', async () => {
  const t = TABLES()
  t.comparables_retenus = [{ property_id: 'BIEN-A', listing_id: IDS[0], actif: true, retenu_par: 'proprietaire', position: 'dessus' }]
  const g = await appeler({ tables: t })
  assert.deepEqual(g.corps.positions, { [IDS[0]]: 'dessus' })
})

test('LE TEST QUI COMPTE (§22.1) : la migration de la position — trois valeurs, nullable, rejouable', () => {
  const sql = fs.readFileSync(path.join(RACINE, 'migrations', '2026-10-05-comparables-position.sql'), 'utf8')
  assert.ok(sql.split('\n').every(l => l.length < 60))
  assert.match(sql, /add column if not exists position text\s+check \(position in \(\s+'dessous', 'equivalent', 'dessus'\)\)/)
})

// ─── §22.2 : la strategie, et la colonne de position absente ────────────────
const TROIS_RETENUS = () => IDS.map(id => ({ property_id: 'BIEN-A', listing_id: id, actif: true, retenu_par: 'proprietaire' }))
test('LE TEST QUI COMPTE (§22.2) : strategie — sous reglages:write, validee, ecrite sur le bien RESOLU', async () => {
  const t = TABLES()
  t.comparables_retenus = TROIS_RETENUS()
  t.bien_profil[0].strategie = 'agressif'; t.bien_profil[0].sejour_min = 2
  const r = await appeler({ method: 'POST', body: { action: 'strategie', strategie: 'agressif', sejour_min: '2' }, tables: t })
  assert.deepEqual(r.gardes, [{ domaine: 'reglages', niveau: 'write', bien: 'REF-42', bienRequis: true }])
  const maj = r.ecrits.find(e => e.tb === 'bien_profil' && e.op === 'update')
  assert.deepEqual([maj.maj.strategie, maj.maj.sejour_min], ['agressif', 2])
  assert.deepEqual(maj.filtres, [['eq', 'property_id', 'BIEN-A']])
  assert.equal(r.corps.profil.strategie, 'agressif')
  const mauvais = await appeler({ method: 'POST', body: { action: 'strategie', strategie: 'luxe', sejour_min: 2 }, tables: TABLES() })
  assert.equal(mauvais.code, 400)
  assert.ok(!mauvais.ecrits.length)
})

test('REVIEW (dd8c060) : le serveur refuse une strategie sans 3 comparables de l hote — ceux de l equipe ne comptent pas', async () => {
  const t = TABLES()
  t.comparables_retenus = [...TROIS_RETENUS().slice(0, 2), { property_id: 'BIEN-A', listing_id: 'F1', actif: true, retenu_par: 'fondateur' }]
  const r = await appeler({ method: 'POST', body: { action: 'strategie', strategie: 'juste', sejour_min: 1 }, tables: t })
  assert.equal(r.code, 400)
  assert.match(r.corps.message, /au moins 3 comparables/)
  assert.ok(!r.ecrits.length)
})

test('§22.2 : le GET rend la strategie du profil et la repartition du marche par sejour minimum', async () => {
  const g = await appeler({ tables: TABLES() })
  assert.equal(g.corps.profil.strategie, null)
  assert.equal(g.corps.profil.sejour_min, null)
  assert.deepEqual(g.corps.marche_sejour_min, { total: 25, une: 5, deux: 11, trois_plus: 9 })
})

test('REVIEW (1e64a2b) : la colonne de position absente (migration non collee) — la page dit « pas encore disponible », jamais une erreur brute', async () => {
  const t = { ...TABLES(), __absentes: ['comparables_retenus'] }
  const g = await appeler({ tables: t })
  assert.equal(g.code, 200)
  assert.equal(g.corps.etat, 'indisponible')
})

// ─── §22.7 : les prix de depart ─────────────────────────────────────────────
const t = require('../lib/marche/temperature-airroi')
const RELIEF = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'relief-bagneres-2026-09-30.json'), 'utf8'))
const TEMPERATURE = t.construireLignes({ marche: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, reponse: RELIEF })
// §22.11 : un calendrier RELATIF a aujourd'hui (la route lit l'horloge : regle
// du depot), 365 nuits, une saison continue (sommet en fevrier, +30 %) et une
// prime week-end de 25 % ; `plat` : ni saison ni prime.
const AUJ = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' })
const CALENDRIER = (base, { plat = false } = {}) => Array.from({ length: 365 }, (_, i) => {
  const date = new Date(Date.parse(`${AUJ()}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10)
  const mois = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${date.slice(0, 4)}-02-10T00:00:00Z`)) / (86400000 * 365) * 2 * Math.PI
  const we = [5, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())
  return { date, available: true, rate: Math.round(base * (plat ? 1 : (1 + 0.3 * Math.max(0, Math.cos(mois))) * (we ? 1.25 : 1)) * 100) / 100, min_nights: 2 }
})
// Le calendrier du MARCHE, relatif lui aussi (le repli s'y lit) : la vraie
// capture de Bagneres, ses jours decales pour commencer aujourd'hui.
const TEMPERATURE_REL = () => TEMPERATURE.map((r, i) => ({ ...r, jour: new Date(Date.parse(`${AUJ()}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10) }))
// Les 5 retenus des tests de prix : 5 hotes distincts (fixture comps-labulle).
const IDS5 = COMPS.slice(0, 5).map(c => String(c.listing_info.listing_id))
const cleCal = id => cleCanonique('GET /listings/live/calendar', { listing_id: String(id), currency: 'native' })
function tablesPrix ({ calendriersEnCache = 5, strategie = 'juste', localite = 'Bagnères-de-Bigorre', plat = false } = {}) {
  const tb = TABLES()
  tb.bien_profil = [{ ...PROFIL, property_id: 'BIEN-A', strategie, sejour_min: 2 }]
  tb.comparables_retenus = IDS5.map((id, i) => ({ property_id: 'BIEN-A', listing_id: id, actif: true, retenu_par: 'proprietaire', position: ['dessous', 'equivalent', 'dessus'][i % 3] }))
  tb.marche_biens = [{ property_id: 'BIEN-A', pays: 'France', region: 'Occitania', localite }]
  tb.marche_temperature_airroi = TEMPERATURE_REL()
  for (const id of IDS5.slice(0, calendriersEnCache)) tb.airroi_cache.push({ cle: cleCal(id), reponse: JSON.stringify({ currency: 'EUR', results: CALENDRIER(80 + 30 * IDS5.indexOf(id), { plat }) }), recupere_le: new Date().toISOString() })
  return tb
}
const reservCal = r => r.rpcs.filter(x => x.fn === 'reserver_recherche_comparables' && x.params.p_nature === 'calendrier')

test('LE TEST QUI COMPTE (§22.11) : le GET calcule les 8 cases depuis le CACHE seul — 5 hotes, tout monte, aucun paiement', async () => {
  const g = await appeler({ tables: tablesPrix() })
  const pd = g.corps.prix_depart
  assert.equal(pd.etat, 'calcule')
  assert.equal(pd.prix.statut, 'calcule')
  assert.equal(pd.prix.hotes, 5)
  assert.equal(pd.prix.niveaux_source, 'segment')
  assert.deepEqual(pd.prix.cases.map(c => `${c.niveau}/${c.type}`), ['creux/semaine', 'creux/weekend', 'modere/semaine', 'modere/weekend', 'favorable/semaine', 'favorable/weekend', 'pic/semaine', 'pic/weekend'])
  assert.deepEqual(pd.prix.alertes, [])
  for (const c of pd.prix.cases.filter(x => x.type === 'weekend')) assert.ok(c.prix > pd.prix.cases.find(x => x.niveau === c.niveau && x.type === 'semaine').prix, `${c.niveau} : le week-end au-dessus`)
  assert.equal(g.rpcs.length, 0)
  assert.equal(g.appelsAirroi.length, 0)
  // Un calendrier manque : 4 hotes seulement — le GET le DIT, sans rien payer.
  const manque = await appeler({ tables: tablesPrix({ calendriersEnCache: 4 }) })
  assert.equal(manque.corps.prix_depart.a_capturer, 1)
  assert.equal(manque.corps.prix_depart.prix.statut, 'non_calculable')
  assert.match(manque.corps.prix_depart.prix.motif, /4 hôtes indépendants/)
  assert.equal(manque.rpcs.length, 0)
  const rien = await appeler({ tables: tablesPrix({ calendriersEnCache: 0 }) })
  assert.equal(rien.corps.prix_depart.etat, 'a_capturer')
  assert.equal(rien.corps.prix_depart.a_capturer, 5)
})

test('LE TEST QUI COMPTE (§22.5) : « prix » releve chaque calendrier MANQUANT — reserve 0,10 $ (nature calendrier) avant de partir', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tablesPrix({ calendriersEnCache: 1 }) })
  assert.deepEqual(r.gardes, [{ domaine: 'reglages', niveau: 'write', bien: 'REF-42', bienRequis: true }])
  assert.equal(reservCal(r).length, 4)
  assert.ok(reservCal(r).every(x => x.params.p_cout === 0.10 && x.params.p_calendriers_90j === 15))
  assert.deepEqual(r.appelsAirroi.map(a => a.calendrier).sort(), IDS5.slice(1).sort())
  assert.ok(r.appelsAirroi.every(a => a.ctx.propertyId === 'BIEN-A' && a.ctx.userId === 'COMPTE'))
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.a_capturer, 0)
})

test('§22.5 : un calendrier qui echoue rend sa reservation (nature calendrier) ; le plafond atteint arrete les releves suivants, et c est dit', async () => {
  const panne = await appeler({ method: 'POST', body: { action: 'prix' }, tables: { ...tablesPrix({ calendriersEnCache: 4 }), __calendrierEnPanne: 'libere' } })
  assert.deepEqual(rendus(panne), [{ p_property: 'BIEN-A', p_cout: 0.10, p_nature: 'calendrier' }])
  assert.equal(panne.corps.a_capturer, 1)
  assert.match(panne.corps.note, /Les prix de 1 comparable ne sont pas encore relevés/)
  const plafond = await appeler({ method: 'POST', body: { action: 'prix' }, tables: { ...tablesPrix({ calendriersEnCache: 0 }), __rpc: 'calendriers' } })
  // Quatre releves partent ensemble : au plus quatre reservations demandees, toutes
  // refusees (donc gratuites), et AUCUN appel AirROI.
  assert.ok(reservCal(plafond).length >= 1 && reservCal(plafond).length <= 4)
  assert.equal(plafond.appelsAirroi.length, 0)
  assert.match(plafond.corps.note, /déjà été relevés plusieurs fois ce trimestre/)
})

test('LE TEST QUI COMPTE (§22.11) : les niveaux viennent des COMPARABLES — sans marche relie a l adresse, le calcul se fait quand meme ; le marche ne sert qu au repli', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tablesPrix({ localite: 'Toulouse' }) })
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.prix.niveaux_source, 'segment')
  assert.equal(r.appelsAirroi.length, 0)
  // Des comparables PLATS et aucun marche de l'adresse : rien n'est invente.
  const plats = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tablesPrix({ localite: 'Toulouse', plat: true }) })
  assert.equal(plats.corps.prix.statut, 'non_calculable')
  assert.match(plats.corps.prix.motif, /changent trop peu de prix/)
})

test('§22.7 : sans strategie, ou sans 3 comparables de l hote, rien n est calcule ni paye', async () => {
  const sans = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tablesPrix({ strategie: null }) })
  assert.equal(sans.corps.etat, 'strategie_absente')
  const tb = tablesPrix()
  tb.comparables_retenus = [...tb.comparables_retenus.slice(0, 2), { property_id: 'BIEN-A', listing_id: 'F1', actif: true, retenu_par: 'fondateur' }]
  const peu = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tb })
  assert.equal(peu.corps.etat, 'comparables_insuffisants')
  assert.equal(peu.rpcs.length + sans.rpcs.length, 0)
})

test('LE TEST QUI COMPTE (SECURITE, §22.5) : la migration de la nature — deux natures, plafond des calendriers, anciennes signatures supprimees, execution fermee', () => {
  const sql = fs.readFileSync(path.join(RACINE, 'migrations', '2026-10-05-comparables-recherches-nature.sql'), 'utf8')
  assert.ok(sql.split('\n').every(l => l.length < 60))
  assert.match(sql, /check \(nature in \('recherche', 'calendrier'\)\)/)
  assert.match(sql, /drop function if exists\s+public\.reserver_recherche_comparables\(\s+uuid, uuid, numeric, int, int, int, numeric\)/)
  assert.match(sql, /drop function if exists\s+public\.rendre_recherche_comparables\(\s+uuid, numeric\)/)
  assert.match(sql, /p_nature = 'calendrier' and p_cout <> 0\.10/)
  const res = sql.slice(sql.indexOf('as $$'), sql.indexOf('$$;'))
  assert.ok(res.indexOf('pg_advisory_xact_lock') < res.indexOf('sum(cout_usd)'))
  assert.match(res, /nature = 'calendrier'\s+and cree_le > now\(\) - interval '90 days'/)
  assert.match(sql, /revoke all on function\s+public\.reserver_recherche_comparables\(\s+uuid, uuid, numeric, text,\s+int, int, int, int, numeric\)\s+from public, anon, authenticated/)
  assert.match(sql, /revoke all on function\s+public\.rendre_recherche_comparables\(\s+uuid, numeric, text\)\s+from public, anon, authenticated/)
})

// ─── Constats de la review de f37b7da ───────────────────────────────────────
test('LE TEST QUI COMPTE (SECURITE, review S1) : un appel PEUT-ETRE FACTURE (reponse vide, coupure) ne rend PAS sa reservation — base, page des actifs, calendrier', async () => {
  const facture = m => Object.assign(new Error(m), { coutLibere: false })
  const base = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [] }, airroi: facture('reponse inattendue') })
  assert.deepEqual(rendus(base), [])
  const comp = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: AVEC_SPA(), airroiEq: facture('reseau') })
  assert.deepEqual(rendus(comp), [])
  const cal = await appeler({ method: 'POST', body: { action: 'prix' }, tables: { ...tablesPrix({ calendriersEnCache: 2 }), __calendrierEnPanne: 'facture' } })
  assert.deepEqual(rendus(cal), [])
})

test('REVIEW : le marche du REPLI doit figurer en MOTS ENTIERS dans l adresse — « Pau » n est pas dans « Saint-Paul » ; une commune vide ne passe pas', async () => {
  const pau = tablesPrix({ localite: 'Pau', plat: true })
  pau.bien_profil[0].adresse_trouvee = '12 Rue Saint-Paul 31000 Toulouse'
  assert.equal((await appeler({ tables: pau })).corps.prix_depart.prix.statut, 'non_calculable')
  assert.equal((await appeler({ tables: tablesPrix({ localite: '', plat: true }) })).corps.prix_depart.prix.statut, 'non_calculable')
  const ok = tablesPrix({ plat: true })
  ok.bien_profil[0].adresse_trouvee = '12 RUE DES THERMES 65200 BAGNERES DE BIGORRE'
  const r = (await appeler({ tables: ok })).corps.prix_depart.prix
  assert.equal(r.statut, 'calcule', 'tirets et espaces equivalents, accents et casse ignores')
  assert.equal(r.niveaux_source, 'marche')
})

test('REVIEW (C3) : une panne du calcul des prix au GET n empeche pas les comparables', async () => {
  const tb = { ...tablesPrix(), __absentes: ['marche_biens'] }
  const g = await appeler({ tables: tb })
  assert.equal(g.code, 200)
  assert.equal(g.corps.comparables.length, 25)
  assert.equal(g.corps.prix_depart.etat, 'erreur')
})

test('§22.11 : repli sur un marche qui ne couvre pas les 6 prochains mois — non calcule, et dit', async () => {
  const tb = tablesPrix({ plat: true })
  tb.marche_temperature_airroi = TEMPERATURE_REL().slice(0, 30)
  const g = await appeler({ tables: tb })
  assert.equal(g.corps.prix_depart.prix.statut, 'non_calculable')
  assert.match(g.corps.prix_depart.prix.motif, /ne couvre pas les 6 prochains mois/)
})

// ⚠ RE-REVIEW DE 0fab219 : une panne de la reservation dans UN ouvrier ne laisse
// pas les trois autres payer apres la reponse (Promise.all les abandonnait).
test('RE-REVIEW : une reservation en panne arrete TOUS les releves, et la reponse attend ceux en vol', async () => {
  const tb = tablesPrix({ calendriersEnCache: 0 })
  tb.comparables_retenus = Array.from({ length: 12 }, (_, i) => ({ property_id: 'BIEN-A', listing_id: String(9000 + i), actif: true, retenu_par: 'proprietaire', position: 'equivalent' }))
  // Sans selection en cache, tous les retenus comptent (§22.10) : ce test porte sur les calendriers.
  tb.airroi_cache = tb.airroi_cache.filter(c => c.cle !== CLE)
  tb.__rpcPanneNieme = 1
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tb })
  const aLaReponse = r.appelsAirroi.length
  await new Promise(res => setTimeout(res, 30))
  assert.equal(r.appelsAirroi.length, aLaReponse, 'aucun releve paye apres la reponse')
  assert.ok(aLaReponse <= 3, `au plus un releve par ouvrier encore en vol (vu : ${aLaReponse})`)
  assert.ok(r.code >= 500, 'la panne est dite')
})

// Decision de Thierry (5 octobre 2026) : 10 calendriers par bien au plus, ceux
// deja en cache d'abord (gratuits), puis dans l'ordre des retenus.
test('DECISION : au plus 10 calendriers servent au calcul — ceux en cache d abord, et on ne releve jamais au-dela', async () => {
  const tb = tablesPrix({ calendriersEnCache: 0 })
  tb.comparables_retenus = Array.from({ length: 14 }, (_, i) => ({ property_id: 'BIEN-A', listing_id: String(9000 + i), actif: true, retenu_par: 'proprietaire', position: 'equivalent' }))
  // Sans selection en cache, tous les retenus comptent (§22.10) : ce test porte sur les calendriers.
  tb.airroi_cache = tb.airroi_cache.filter(c => c.cle !== CLE)
  // Deux calendriers en cache, en FIN de liste : ils passent devant.
  for (const id of ['9012', '9013']) tb.airroi_cache.push({ cle: cleCal(id), reponse: JSON.stringify({ currency: 'EUR', results: CALENDRIER(120) }), recupere_le: new Date().toISOString() })
  const g = await appeler({ tables: tb })
  assert.equal(g.corps.prix_depart.a_capturer, 8, '10 au plus, dont 2 deja en cache')
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tb })
  assert.equal(reservCal(r).length, 8)
  assert.deepEqual(r.appelsAirroi.map(a => a.calendrier).sort(), Array.from({ length: 8 }, (_, i) => String(9000 + i)).sort())
  assert.equal(r.corps.a_capturer, 0)
})

test('DECISION (review de c04e356) : le calcul recoit 10 calendriers au plus, et l equipe passe avant l ordre du choix', async () => {
  // 12 calendriers en cache : 10 servent, aucun releve.
  const plein = tablesPrix({ calendriersEnCache: 0 })
  plein.comparables_retenus = Array.from({ length: 12 }, (_, i) => ({ property_id: 'BIEN-A', listing_id: String(9000 + i), actif: true, retenu_par: 'proprietaire', position: 'equivalent' }))
  // Sans selection en cache, tous les retenus comptent (§22.10) : ce test porte sur les calendriers.
  plein.airroi_cache = plein.airroi_cache.filter(c => c.cle !== CLE)
  for (const l of plein.comparables_retenus) plein.airroi_cache.push({ cle: cleCal(l.listing_id), reponse: JSON.stringify({ currency: 'EUR', results: CALENDRIER(100) }), recupere_le: new Date().toISOString() })
  const g = await appeler({ tables: plein })
  assert.equal(g.corps.prix_depart.prix.comparables, 10)
  assert.equal(g.corps.prix_depart.a_capturer, 0)
  // Rien en cache, deux comparables de l'equipe EN FIN de liste : releves d'abord.
  const equipe = tablesPrix({ calendriersEnCache: 0 })
  equipe.comparables_retenus = Array.from({ length: 12 }, (_, i) => ({ property_id: 'BIEN-A', listing_id: String(9000 + i), actif: true, retenu_par: i >= 10 ? 'fondateur' : 'proprietaire', position: i >= 10 ? null : 'equivalent' }))
  // Sans selection en cache, tous les retenus comptent (§22.10) : ce test porte sur les calendriers.
  equipe.airroi_cache = equipe.airroi_cache.filter(c => c.cle !== CLE)
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: equipe })
  const releves = r.appelsAirroi.map(a => a.calendrier)
  assert.equal(releves.length, 10)
  assert.ok(releves.includes('9010') && releves.includes('9011'), 'l equipe est relevee')
  assert.ok(!releves.includes('9008') && !releves.includes('9009'), 'les deux derniers choix de l hote attendent')
})

// ─── §22.9 : les annonces retirees d'Airbnb ne s'affichent pas ──────────────
// Dates RELATIVES : le code lit l'horloge (constat valable 30 jours).
const ilYa = jours => new Date(Date.now() - jours * 86400000).toISOString()
const retiree = (id, http = 404, age = 1) => ({ listing_id: id, http, constatee_le: ilYa(age) })

test('LE TEST QUI COMPTE (§22.9) : une annonce retiree n apparait NULLE PART — carte, retenus, positions, calcul', async () => {
  const tb = tablesPrix()
  tb.airroi_annonces_retirees = [retiree(IDS[0])]
  const g = await appeler({ tables: tb })
  assert.ok(!g.corps.comparables.some(c => c.listing_id === IDS[0]), 'absente de la carte')
  assert.equal(g.corps.comparables.length, 24)
  assert.deepEqual(g.corps.retenus, IDS5.slice(1), 'absente des retenus')
  assert.ok(!(IDS[0] in g.corps.positions))
  // Cinq retenus dont un retire : 4 hotes, le calcul le dit.
  assert.equal(g.corps.prix_depart.prix.comparables, 4)
  assert.match(g.corps.prix_depart.prix.motif, /4 hôtes indépendants/)
})

test('§22.9 : un calendrier qui repond 404 note l annonce retiree (pour tous les biens), rend la reservation, et ne la compte plus', async () => {
  const tb = tablesPrix({ calendriersEnCache: 2 })
  tb.__calendrier404 = [IDS[2]]
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tb })
  const notes = r.ecrits.filter(e => e.tb === 'airroi_annonces_retirees')
  assert.deepEqual(notes.map(e => [e.op, e.ligne.listing_id, e.ligne.http, e.opts]), [['upsert', IDS[2], 404, { onConflict: 'listing_id' }]])
  assert.ok(Math.abs(Date.parse(notes[0].ligne.constatee_le) - Date.now()) < 60000, 'le constat est date du jour')
  assert.deepEqual(rendus(r), [{ p_property: 'BIEN-A', p_cout: 0.10, p_nature: 'calendrier' }], '404 non facture : reservation rendue')
  assert.equal(r.corps.a_capturer, 0, 'elle ne se propose plus a relever')
})

test('§22.9 : une annonce retiree ne se choisit pas, et ne se releve plus', async () => {
  const tb = TABLES()
  tb.airroi_annonces_retirees = [retiree(IDS[0])]
  const r = await appeler({ method: 'POST', body: { action: 'retenir', choix: IDS.map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: tb })
  assert.equal(r.code, 400)
  const p = tablesPrix({ calendriersEnCache: 0 })
  p.comparables_retenus.push({ property_id: 'BIEN-A', listing_id: '9999', actif: true, retenu_par: 'proprietaire', position: 'equivalent' })
  p.airroi_annonces_retirees = [retiree('9999')]
  const pr = await appeler({ method: 'POST', body: { action: 'prix' }, tables: p })
  assert.ok(!pr.appelsAirroi.some(a => a.calendrier === '9999'))
  assert.equal(reservCal(pr).length, 5)
})

test('GARDE-FOU (review de b83823a, SECURITE) : trois 404 ou plus sans aucun releve reussi = panne presumee, RIEN n est note', async () => {
  const tb = tablesPrix({ calendriersEnCache: 0 })
  tb.__calendrier404 = [...IDS5]
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tb })
  assert.equal(r.ecrits.filter(e => e.tb === 'airroi_annonces_retirees').length, 0)
  assert.equal(rendus(r).length, 5, 'les cinq reservations rendues (404 non facture)')
  assert.equal(r.corps.a_capturer, 5, 'elles restent a relever')
  // Un seul 404 parmi des releves reussis : c'est une annonce retiree.
  const un = tablesPrix({ calendriersEnCache: 0 })
  un.__calendrier404 = [IDS[0]]
  const r1 = await appeler({ method: 'POST', body: { action: 'prix' }, tables: un })
  assert.deepEqual(r1.ecrits.filter(e => e.tb === 'airroi_annonces_retirees').map(e => e.ligne.listing_id), [IDS[0]])
})

test('C1 (review de b83823a) : un constat qui ne s ecrit pas ne casse pas le calcul, et la reservation est RENDUE', async () => {
  const tb = tablesPrix({ calendriersEnCache: 2 })
  tb.__calendrier404 = [IDS[2]]
  tb.__upsertPanne = 'airroi_annonces_retirees'
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tb })
  assert.equal(r.code, 200)
  assert.deepEqual(rendus(r), [{ p_property: 'BIEN-A', p_cout: 0.10, p_nature: 'calendrier' }])
  assert.equal(r.corps.a_capturer, 1, 'non notee : elle reste a relever')
})

test('§22.9 : un constat de plus de 30 jours vieillit — l annonce redevient visible et se re-verifie', async () => {
  const tb = tablesPrix()
  tb.airroi_annonces_retirees = [retiree(IDS[0], 404, 31)]
  const g = await appeler({ tables: tb })
  assert.ok(g.corps.comparables.some(c => c.listing_id === IDS[0]))
  assert.ok(g.corps.retenus.includes(IDS[0]))
})

// ─── Constats de la review de 428fe8c ───────────────────────────────────────
test('REVIEW (428fe8c) : d anciens retenus qui ne sont plus PROPOSES ne comptent plus — ni au « au moins 3 », ni aux prix — et c est dit', async () => {
  const t = { ...tablesPrix(), bien_profil: [{ ...PROFIL_SPA, property_id: 'BIEN-A', strategie: 'juste', sejour_min: 2 }] }
  t.airroi_cache.push(pageEnCache(0), pageEnCache(1))
  // Les 5 retenus (IDS5) sont d'anciens voisins, absents de la selection des actifs avec jacuzzi.
  const g = await appeler({ tables: t })
  assert.deepEqual(g.corps.retenus, [])
  assert.equal(g.corps.retenus_hors_liste, 5)
  assert.equal(g.corps.prix_depart.etat, 'comparables_insuffisants')
  const st = await appeler({ method: 'POST', body: { action: 'strategie', strategie: 'juste', sejour_min: 2 }, tables: t })
  assert.equal(st.code, 400)
  // Un retenu de l'EQUIPE reste, meme hors de la liste.
  t.comparables_retenus[0] = { ...t.comparables_retenus[0], retenu_par: 'fondateur' }
  const g2 = await appeler({ tables: t })
  assert.deepEqual(g2.corps.fondateur, [IDS[0]])
  assert.equal(g2.corps.retenus_hors_liste, 4)
})

test('REVIEW (428fe8c) : « plus » quand la 1re page a expire recharge le debut — jamais « plus rien » a tort', async () => {
  const t = AVEC_SPA()
  t.airroi_cache.push({ ...pageEnCache(0), recupere_le: new Date(Date.now() - 91 * 86400000).toISOString() }, pageEnCache(1))
  const r = await appeler({ method: 'POST', body: { action: 'plus' }, tables: t })
  assert.equal(r.code, 200)
  assert.deepEqual(r.appelsAirroi.map(a => a.corps.pagination.offset), [0])
  assert.equal(r.corps.comparables.length, 20)
})

test('GARDE-FOU (review de 428fe8c) : une page payee qui ne se relit pas dans le cache ARRETE la boucle — jamais un paiement sans fin', async () => {
  const t = AVEC_SPA()
  t.__cacheMuet = true
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: t })
  assert.equal(r.appelsAirroi.length, 1, 'une seule page payee')
  assert.equal(r.corps.etat, 'indisponible')
})

test('LE TEST QUI COMPTE (§22.11, decision de Thierry) : les releves visent des HOTES DIFFERENTS d abord — jamais deux annonces du meme hote tant qu il manque des hotes', async () => {
  // La selection : les 25 voisins ; le 2e a le MEME hote que le 1er.
  const comps = COMPS.map(c => ({ ...c }))
  comps[1] = { ...comps[1], host_info: { ...comps[1].host_info, host_id: comps[0].host_info.host_id } }
  const t = tablesPrix({ calendriersEnCache: 0 })
  t.airroi_cache = [{ cle: CLE, reponse: JSON.stringify({ listings: comps }), recupere_le: new Date().toISOString() }]
  // 11 retenus, dans l'ordre de la liste : 10 hotes distincts plus le doublon.
  t.comparables_retenus = comps.slice(0, 11).map(c => ({ property_id: 'BIEN-A', listing_id: String(c.listing_info.listing_id), actif: true, retenu_par: 'proprietaire', position: 'equivalent' }))
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: t })
  const releves = r.appelsAirroi.map(a => a.calendrier)
  assert.equal(releves.length, 10)
  assert.ok(!releves.includes(String(comps[1].listing_info.listing_id)), 'la 2e annonce du meme hote attend')
  assert.ok(releves.includes(String(comps[10].listing_info.listing_id)), 'un 10e hote passe avant elle')
})

// ─── Constats de la review de b745bb8 (route) ───────────────────────────────
test('review de b745bb8 : un CO-HOTE commun fait une seule voix — la 2e annonce de la conciergerie attend', async () => {
  const comps = COMPS.map(c => ({ ...c }))
  comps[1] = { ...comps[1], host_info: { ...comps[1].host_info, cohost_ids: [String(comps[0].host_info.host_id)] } }
  const t = tablesPrix({ calendriersEnCache: 0 })
  t.airroi_cache = [{ cle: CLE, reponse: JSON.stringify({ listings: comps }), recupere_le: new Date().toISOString() }]
  t.comparables_retenus = comps.slice(0, 11).map(c => ({ property_id: 'BIEN-A', listing_id: String(c.listing_info.listing_id), actif: true, retenu_par: 'proprietaire', position: 'equivalent' }))
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: t })
  const releves = r.appelsAirroi.map(a => a.calendrier)
  assert.equal(releves.length, 10)
  assert.ok(!releves.includes(String(comps[1].listing_info.listing_id)))
})

test('LE TEST QUI COMPTE (review de b745bb8) : la liste du marche a expire — les hotes ne sont plus identifiables, le calcul REFUSE et dit de relancer la recherche', async () => {
  const t = tablesPrix()
  t.airroi_cache = t.airroi_cache.filter(c => c.cle !== CLE)
  const g = await appeler({ tables: t })
  assert.equal(g.corps.prix_depart.prix.statut, 'non_calculable')
  assert.match(g.corps.prix_depart.prix.motif, /n’est pas identifié \(la liste des biens du marché a expiré\) : relancez la recherche/)
})

test('§22.13 : le detail des 365 jours seulement sur demande (`?jours=1`) — la page des comparables n en recoit pas', async () => {
  const sans = await appeler({ tables: tablesPrix() })
  assert.equal(sans.corps.prix_depart.prix.jours, undefined)
  const avec = await appeler({ query: { property_id: 'REF-42', jours: '1' }, tables: tablesPrix() })
  assert.equal(avec.corps.prix_depart.prix.jours.length, 365)
  assert.ok(avec.corps.prix_depart.prix.jours.every(j => /^\d{4}-\d{2}-\d{2}$/.test(j.date) && ['semaine', 'weekend'].includes(j.type)))
  assert.deepEqual([avec.rpcs.length, avec.appelsAirroi.length], [0, 0], 'une lecture : rien n est paye')
})
