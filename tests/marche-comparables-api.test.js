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
      in: (k, vs) => { lignes = lignes.filter(l => vs.includes(l[k])); return q },
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
        return { donnees: airroi || { listings: COMPS }, depuisCache: false }
      },
      calendrierAnnonce: async (listingId, ctx) => {
        appelsAirroi.push({ calendrier: String(listingId), ctx })
        if (tables.__calendrierEnPanne) throw Object.assign(new Error('HTTP 500'), { coutLibere: tables.__calendrierEnPanne !== 'facture' })
        return { donnees: { currency: 'EUR', results: CALENDRIER(100) }, depuisCache: false }
      },
      rechercheEquipements: async (corps, ctx) => {
        appelsAirroi.push({ corps, ctx, equipements: true })
        if (airroiEq instanceof Error) throw airroiEq
        return { donnees: airroiEq || { results: SPA }, depuisCache: false }
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
// Les biens « trouves par equipement » : d'autres annonces reelles (Coeur de vie 23), avec un jacuzzi.
const SPA = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'comps-cdv23.json'), 'utf8')).listings.slice(0, 4)
  .map(f => ({ ...f, property_details: { ...f.property_details, amenities: [...f.property_details.amenities, 'Hot tub'] } }))
const { corpsRechercheEquipements } = require('../lib/marche/choix-comparables')
const PROFIL_SPA = { ...PROFIL, equipements: ['parking', 'spa'] }
const CLE_SPA = cleCanonique('POST /listings/search/radius', corpsRechercheEquipements({ ...PROFIL_SPA, latitude: 43.0636, longitude: 0.1476 }))

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
  assert.deepEqual(r.rpcs, [{ fn: 'reserver_recherche_comparables', params: { p_user: 'COMPTE', p_property: 'BIEN-A', p_cout: 0.10, p_nature: 'recherche', p_bien_jour: 3, p_compte_jour: 5, p_compte_30j: 10, p_calendriers_90j: 15, p_budget_mois: 15 } }])
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

test('LE TEST QUI COMPTE (§21.2-21.3) : un equipement rare declenche la recherche complementaire, qui RESERVE 0,50 $ avant de partir', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: AVEC_SPA() })
  assert.deepEqual(r.rpcs.map(x => x.params.p_cout), [0.50], 'la liste de base etait en cache : seule la recherche par equipement reserve')
  const eq = r.appelsAirroi.find(a => a.equipements)
  assert.deepEqual(eq.corps.filter.amenities, { any: ['hot_tub', 'sauna'] })
  assert.deepEqual(eq.ctx, { propertyId: 'BIEN-A', userId: 'COMPTE' })
  assert.equal(r.corps.comparables.length, 29)
  assert.equal(r.corps.comparables.filter(c => c.source === 'equipements').length, 4)
  assert.ok(r.corps.comparables.filter(c => c.source === 'equipements').every(c => c.equipements.includes('spa')))
})

test('§21.2 : complementaire refuse par le quota — la liste de base s affiche quand meme, et c est dit ; rien n est paye pour lui', async () => {
  const t = { ...AVEC_SPA(), __rpc: 'bien' }
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: t })
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.comparables.length, 25)
  assert.match(r.corps.note, /vos équipements n’a pas pu être lancée : plusieurs recherches/)
  assert.ok(!r.appelsAirroi.some(a => a.equipements))
})

test('§21.2 : complementaire en panne chez AirROI — la liste de base reste, la panne est dite', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: AVEC_SPA(), airroiEq: new Error('HTTP 500') })
  assert.equal(r.corps.comparables.length, 25)
  assert.match(r.corps.note, /pas disponible pour le moment/)
})

test('§21.2 : tout en cache (base ET complement) — aucune reservation, aucun appel ; le GET sert les deux', async () => {
  const t = AVEC_SPA()
  t.airroi_cache = [...t.airroi_cache.filter(c => c.cle !== CLE), { cle: cleCanonique('GET /listings/comparables', { latitude: 43.0636, longitude: 0.1476, bedrooms: 1, baths: 1, guests: 2, currency: 'native' }), reponse: COMPS_BRUT, recupere_le: new Date().toISOString() },
    { cle: CLE_SPA, reponse: JSON.stringify({ results: SPA }), recupere_le: new Date().toISOString() }]
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: t })
  assert.equal(r.rpcs.length, 0)
  assert.equal(r.appelsAirroi.length, 0)
  assert.equal(r.corps.comparables.length, 29)
  const g = await appeler({ tables: t })
  assert.equal(g.corps.comparables.length, 29)
  assert.equal(g.corps.complement_a_chercher, false)
})

test('§21.2 : le GET dit quand la recherche par equipement reste a faire, sans rien payer', async () => {
  const g = await appeler({ tables: AVEC_SPA() })
  assert.equal(g.corps.complement_a_chercher, true)
  assert.equal(g.rpcs.length, 0)
  assert.equal(g.appelsAirroi.length, 0)
})

test('§21.2 : un bien trouve par equipement peut etre retenu ; un bien inconnu, toujours pas', async () => {
  const t = AVEC_SPA()
  t.airroi_cache.push({ cle: CLE_SPA, reponse: JSON.stringify({ results: SPA }), recupere_le: new Date().toISOString() })
  const ids = [...IDS.slice(0, 2), String(SPA[0].listing_info.listing_id)]
  const r = await appeler({ method: 'POST', body: { action: 'retenir', choix: (ids).map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: t })
  assert.equal(r.code, 200)
  const non = await appeler({ method: 'POST', body: { action: 'retenir', choix: ([...IDS.slice(0, 2), '999999']).map(listing_id => ({ listing_id, position: 'equivalent' })) }, tables: t })
  assert.equal(non.code, 400)
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

test('REVIEW : base absente et equipement rare — la base reserve 0,10 $ PUIS le complement 0,50 $', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...AVEC_SPA(), airroi_cache: [] } })
  assert.deepEqual(reservations(r), [0.10, 0.50])
  assert.equal(r.corps.comparables.length, 29)
})

test('LE TEST QUI COMPTE (review C1) : un appel qui ECHOUE rend sa reservation — base comme complement', async () => {
  const libere = m => Object.assign(new Error(m), { coutLibere: true })
  const base = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [] }, airroi: libere('HTTP 422') })
  assert.deepEqual(rendus(base), [{ p_property: 'BIEN-A', p_cout: 0.10, p_nature: 'recherche' }])
  assert.equal(base.corps.etat, 'indisponible')
  const comp = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: AVEC_SPA(), airroiEq: libere('HTTP 422') })
  assert.deepEqual(rendus(comp), [{ p_property: 'BIEN-A', p_cout: 0.50, p_nature: 'recherche' }])
  assert.equal(comp.corps.comparables.length, 25)
  // Un appel reussi ne rend rien.
  const ok = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: AVEC_SPA() })
  assert.deepEqual(rendus(ok), [])
})

test('REVIEW (C2) : la reservation du complement en PANNE n empeche pas la liste de base — rien n est paye pour lui', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...AVEC_SPA(), __rpcPanneCout: 0.50 } })
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.comparables.length, 25)
  assert.match(r.corps.note, /pas disponible pour le moment/)
  assert.ok(!r.appelsAirroi.some(a => a.equipements))
})

test('REVIEW : la cle de cache du complement est celle qu ecrit le VRAI client AirROI', async () => {
  const { creerClient: vraiCreer } = require('../lib/airroi/client')
  const ecrits = []
  const depot = { lireCache: async () => null, ecrireCache: async (l) => { ecrits.push(l.cle) }, reserver: async () => 1, terminer: async () => {}, appelsDepuis: async () => [] }
  const avant = process.env.AIRROI_API_KEY
  process.env.AIRROI_API_KEY = 'cle-de-test-factice'
  try {
    const client = vraiCreer({ depot, alerter: null, fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results: SPA }) }) })
    await client.rechercheEquipements(corpsRechercheEquipements({ ...PROFIL_SPA, latitude: 43.0636, longitude: 0.1476 }), { propertyId: 'BIEN-A', userId: 'COMPTE' })
  } finally { if (avant === undefined) delete process.env.AIRROI_API_KEY; else process.env.AIRROI_API_KEY = avant }
  assert.deepEqual(ecrits, [CLE_SPA])
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
// Un calendrier qui suit le marche : base + 3 € par point d'ecart.
const CALENDRIER = base => TEMPERATURE.filter(j => j.jour < '2027-10-01').map(j => ({ date: j.jour, available: true, rate: Math.round(base + 3 * j.ecart), min_nights: 2 }))
const cleCal = id => cleCanonique('GET /listings/live/calendar', { listing_id: String(id), currency: 'native' })
function tablesPrix ({ calendriersEnCache = 3, strategie = 'juste', localite = 'Bagnères-de-Bigorre' } = {}) {
  const tb = TABLES()
  tb.bien_profil = [{ ...PROFIL, property_id: 'BIEN-A', strategie, sejour_min: 2 }]
  tb.comparables_retenus = IDS.map((id, i) => ({ property_id: 'BIEN-A', listing_id: id, actif: true, retenu_par: 'proprietaire', position: ['dessous', 'equivalent', 'dessus'][i] }))
  tb.marche_biens = [{ property_id: 'BIEN-A', pays: 'France', region: 'Occitania', localite }]
  tb.marche_temperature_airroi = TEMPERATURE
  for (const id of IDS.slice(0, calendriersEnCache)) tb.airroi_cache.push({ cle: cleCal(id), reponse: JSON.stringify({ currency: 'EUR', results: CALENDRIER(100 + 10 * IDS.indexOf(id)) }), recupere_le: new Date().toISOString() })
  return tb
}
const reservCal = r => r.rpcs.filter(x => x.fn === 'reserver_recherche_comparables' && x.params.p_nature === 'calendrier')

test('LE TEST QUI COMPTE (§22.7) : le GET calcule les prix de depart depuis le CACHE seul — quatre niveaux, aucun paiement', async () => {
  const g = await appeler({ tables: tablesPrix() })
  const pd = g.corps.prix_depart
  assert.equal(pd.etat, 'calcule')
  assert.deepEqual(pd.prix.niveaux.map(n => n.yieldflow), ['Base', 'Moyen', 'Haut', 'Très haut ou Exceptionnel'])
  assert.ok(pd.prix.niveaux.every(n => n.statut === 'calcule' && n.prix % 5 === 0))
  const prix = pd.prix.niveaux.map(n => n.prix)
  for (let i = 1; i < prix.length; i++) assert.ok(prix[i] >= prix[i - 1], 'les niveaux montent')
  assert.equal(g.rpcs.length, 0)
  assert.equal(g.appelsAirroi.length, 0)
  // Un calendrier manque : le GET calcule avec ce qu'il a, et le DIT, sans rien
  // payer (review de f37b7da, C4 : GET et POST disent la meme chose).
  const manque = await appeler({ tables: tablesPrix({ calendriersEnCache: 2 }) })
  assert.equal(manque.corps.prix_depart.etat, 'calcule')
  assert.equal(manque.corps.prix_depart.a_capturer, 1)
  assert.match(manque.corps.prix_depart.note, /Les prix de 1 comparable ne sont pas encore relevés/)
  assert.equal(manque.rpcs.length, 0)
  const rien = await appeler({ tables: tablesPrix({ calendriersEnCache: 0 }) })
  assert.equal(rien.corps.prix_depart.etat, 'a_capturer')
  assert.equal(rien.corps.prix_depart.a_capturer, 3)
})

test('LE TEST QUI COMPTE (§22.5) : « prix » releve chaque calendrier MANQUANT — reserve 0,10 $ (nature calendrier) avant de partir', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tablesPrix({ calendriersEnCache: 1 }) })
  assert.deepEqual(r.gardes, [{ domaine: 'reglages', niveau: 'write', bien: 'REF-42', bienRequis: true }])
  assert.equal(reservCal(r).length, 2)
  assert.ok(reservCal(r).every(x => x.params.p_cout === 0.10 && x.params.p_calendriers_90j === 15))
  assert.deepEqual(r.appelsAirroi.map(a => a.calendrier).sort(), IDS.slice(1).sort())
  assert.ok(r.appelsAirroi.every(a => a.ctx.propertyId === 'BIEN-A' && a.ctx.userId === 'COMPTE'))
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.a_capturer, 0)
})

test('§22.5 : un calendrier qui echoue rend sa reservation (nature calendrier) ; le plafond atteint arrete les releves suivants, et c est dit', async () => {
  const panne = await appeler({ method: 'POST', body: { action: 'prix' }, tables: { ...tablesPrix({ calendriersEnCache: 2 }), __calendrierEnPanne: 'libere' } })
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

test('LE TEST QUI COMPTE (§22.7) : le marche relie doit etre celui de l ADRESSE du profil — sinon ni calcul ni paiement', async () => {
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tablesPrix({ calendriersEnCache: 0, localite: 'Toulouse' }) })
  assert.equal(r.corps.etat, 'marche_absent')
  assert.match(r.corps.message, /Le marché de votre adresse n’est pas encore disponible/)
  assert.equal(r.rpcs.length, 0)
  assert.equal(r.appelsAirroi.length, 0)
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
test('LE TEST QUI COMPTE (SECURITE, review S1) : un appel PEUT-ETRE FACTURE (reponse vide, coupure) ne rend PAS sa reservation — base, complement, calendrier', async () => {
  const facture = m => Object.assign(new Error(m), { coutLibere: false })
  const base = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: { ...TABLES(), airroi_cache: [] }, airroi: facture('reponse inattendue') })
  assert.deepEqual(rendus(base), [])
  const comp = await appeler({ method: 'POST', body: { action: 'chercher' }, tables: AVEC_SPA(), airroiEq: facture('reseau') })
  assert.deepEqual(rendus(comp), [])
  const cal = await appeler({ method: 'POST', body: { action: 'prix' }, tables: { ...tablesPrix({ calendriersEnCache: 2 }), __calendrierEnPanne: 'facture' } })
  assert.deepEqual(rendus(cal), [])
})

test('REVIEW : le marche relie doit figurer en MOTS ENTIERS dans l adresse — « Pau » n est pas dans « Saint-Paul » ; une commune vide ne passe pas', async () => {
  const pau = tablesPrix({ localite: 'Pau' })
  pau.bien_profil[0].adresse_trouvee = '12 Rue Saint-Paul 31000 Toulouse'
  assert.equal((await appeler({ tables: pau })).corps.prix_depart.etat, 'marche_absent')
  assert.equal((await appeler({ tables: tablesPrix({ localite: '' }) })).corps.prix_depart.etat, 'marche_absent')
  const ok = tablesPrix()
  ok.bien_profil[0].adresse_trouvee = '12 RUE DES THERMES 65200 BAGNERES DE BIGORRE'
  assert.equal((await appeler({ tables: ok })).corps.prix_depart.etat, 'calcule', 'tirets et espaces equivalents, accents et casse ignores')
})

test('REVIEW (C3) : une panne du calcul des prix au GET n empeche pas les comparables', async () => {
  const tb = { ...tablesPrix(), __absentes: ['marche_biens'] }
  const g = await appeler({ tables: tb })
  assert.equal(g.code, 200)
  assert.equal(g.corps.comparables.length, 25)
  assert.equal(g.corps.prix_depart.etat, 'erreur')
})

test('REVIEW (C7) : un calendrier du marche trop ancien (moins de 300 jours a venir) — non calcule, et dit', async () => {
  const tb = tablesPrix()
  const limite = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10)
  tb.marche_temperature_airroi = TEMPERATURE.filter(j => j.jour < limite)
  const g = await appeler({ tables: tb })
  assert.equal(g.corps.prix_depart.etat, 'marche_absent')
  assert.match(g.corps.prix_depart.message, /trop ancien/)
})

// ⚠ RE-REVIEW DE 0fab219 : une panne de la reservation dans UN ouvrier ne laisse
// pas les trois autres payer apres la reponse (Promise.all les abandonnait).
test('RE-REVIEW : une reservation en panne arrete TOUS les releves, et la reponse attend ceux en vol', async () => {
  const tb = tablesPrix({ calendriersEnCache: 0 })
  tb.comparables_retenus = Array.from({ length: 12 }, (_, i) => ({ property_id: 'BIEN-A', listing_id: String(9000 + i), actif: true, retenu_par: 'proprietaire', position: 'equivalent' }))
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
  // Deux calendriers en cache, en FIN de liste : ils passent devant.
  for (const id of ['9012', '9013']) tb.airroi_cache.push({ cle: cleCal(id), reponse: JSON.stringify({ currency: 'EUR', results: CALENDRIER(120) }), recupere_le: new Date().toISOString() })
  const g = await appeler({ tables: tb })
  assert.equal(g.corps.prix_depart.a_capturer, 8, '10 au plus, dont 2 deja en cache')
  const r = await appeler({ method: 'POST', body: { action: 'prix' }, tables: tb })
  assert.equal(reservCal(r).length, 8)
  assert.deepEqual(r.appelsAirroi.map(a => a.calendrier).sort(), Array.from({ length: 8 }, (_, i) => String(9000 + i)).sort())
  assert.equal(r.corps.a_capturer, 0)
})
