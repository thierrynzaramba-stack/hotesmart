// lib/ia/openrouter.js — LE CLIENT OPENROUTER DU LABO IA
//
// Chantier « Labo IA » (20 novembre 2026, décision de Thierry) : comparer
// plusieurs IA sur la même question ou la même facture, avec leur coût. Une
// seule clé (`OPENROUTER_API_KEY`) donne accès à tous les modèles du catalogue
// OpenRouter — Claude, GPT, Gemini, Mistral, DeepSeek, Qwen, Kimi, GLM…
//
// ⚠ CE CLIENT NE SERT QU'AU LABO. L'agent GuestFlow, la lecture des charges et
// tout le reste du produit restent sur le client Anthropic partagé
// (lib/cron-shared.js). Rien ici ne touche un voyageur.
//
// ⚠ AUCUN APPEL N'ÉCHAPPE AU JOURNAL `ia_appels` (spec-journal-ia) : chaque
// tentative y écrit sa ligne — fonction, compte, bien, séjour, modèle servi,
// tokens, coût, durée, succès ou échec. Le coût est celui qu'OpenRouter
// FACTURE (`usage.cost`, en dollars), pas une estimation de notre table de
// tarifs : c'est la seule valeur juste pour 400 modèles qui changent de prix.
// Jamais le texte envoyé ni la réponse.
//
// ⚠ LA CLÉ NE SORT JAMAIS : lue à chaque appel (pas figée au chargement), elle
// ne part que vers l'adresse CONSTANTE ci-dessous (règle 11 de REVIEW.md : une
// destination ne dépend jamais de l'appelant), et tout message d'erreur passe
// par `extrait`, qui masque les `sk-…`.
//
// ⚠ LES DONNÉES DES VOYAGEURS (décision par défaut du 20 novembre 2026, non
// contestée par Thierry) :
//   · `data_collection: 'deny'` sur chaque appel, à chaque tentative — aucun
//     hébergeur qui garde ou entraîne sur les données (le compte OpenRouter le
//     refuse aussi) ;
//   · hors de Chine QUAND C'EST POSSIBLE : les hébergeurs établis en Chine
//     (siège OU centre de données, lus dans la liste publique d'OpenRouter)
//     sont exclus au premier essai ; si OpenRouter répond qu'AUCUN autre
//     hébergeur ne sert le modèle, on relance sans l'exclusion et la réponse le
//     DIT (`restrictionLevee`). Un modèle qui ne tourne qu'en Chine est
//     signalé, jamais caché ; un hébergeur qu'on ne connaît pas est « pays
//     inconnu » (`enChine: null`), jamais « hors Chine ».

const { noterAppelIA } = require('./journal')
const { extrait } = require('../incident-facturation')

// La SEULE destination des appels, et de la clé.
const API = 'https://openrouter.ai/api/v1'

// Un identifiant du catalogue : `auteur/modele`, avec une variante éventuelle.
// Rien d'autre ne passe — pas d'URL, pas d'espace, pas de `..`. ⚠ La forme ne
// suffit pas : l'endpoint exige en plus que le modèle soit DANS le catalogue
// (`:online`, `openrouter/auto` ont la bonne forme et n'y sont pas).
const ID_MODELE = /^[a-z0-9][a-z0-9._-]{0,60}\/[a-z0-9][a-z0-9._:-]{0,100}$/i

// ⚠ REPLI SEULEMENT, quand la liste publique des hébergeurs est illisible.
// Relevée le 20 novembre 2026 sur `GET /api/v1/providers` (review du lot :
// ByteDance s'y nomme `seed`, et `nex-agi`, `streamlake`, `antdigital` y sont
// établis en Chine). La source normale est `lireHebergeurs`.
const HEBERGEURS_CHINE_REPLI = ['deepseek', 'moonshotai', 'alibaba', 'z-ai', 'minimax',
  'baidu', 'siliconflow', 'stepfun', 'xiaomi', 'tencent', 'seed', 'nex-agi',
  'streamlake', 'antdigital']
const NOMS_CHINE_REPLI = ['deepseek', 'moonshotai', 'moonshot', 'alibaba', 'alibabacloud',
  'zai', 'zhipu', 'zhipuai', 'minimax', 'baidu', 'siliconflow', 'stepfun',
  'xiaomi', 'tencent', 'seed', 'bytedance', 'volcengine', 'nexagi', 'streamlake',
  'antdigital', 'antgroup']

// Un modèle qui réfléchit longtemps reste sous le mur de la fonction
// (`maxDuration` 120 s de api/labo-ia.js dans vercel.json) : une tentative
// dure au plus `DELAI_MS`, et toutes ensemble au plus `BUDGET_MS`.
const DELAI_MS = 100000
const BUDGET_MS = 110000
// Une relance qui n'aurait pas ce temps devant elle ne part pas.
const RELANCE_MIN_MS = 15000
const CACHE_TTL_MS = 3600 * 1000

const normaliserNom = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Prix OpenRouter (dollars PAR TOKEN, en texte) -> dollars par million, ou null. */
function prixParMillion (v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1e6 * 10000) / 10000
}

const entierPositif = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null)

/**
 * Le catalogue, réduit à ce que la page affiche. Pure (testée sans réseau).
 * Écarte : les routeurs (prix -1), les variantes `:free` (le compte refuse les
 * hébergeurs gratuits qui entraînent sur les données), les modèles sans prix.
 */
function reduireCatalogue (brut) {
  const lignes = Array.isArray(brut && brut.data) ? brut.data : []
  const sortie = []
  for (const m of lignes) {
    const id = String((m && m.id) || '')
    if (!ID_MODELE.test(id) || /:free$/i.test(id)) continue
    const p = (m && m.pricing) || {}
    const entree = prixParMillion(p.prompt)
    const sortieP = prixParMillion(p.completion)
    if (entree === null || sortieP === null) continue
    const arch = (m && m.architecture) || {}
    const enEntree = Array.isArray(arch.input_modalities) ? arch.input_modalities.map(String) : []
    const enSortie = Array.isArray(arch.output_modalities) ? arch.output_modalities.map(String) : ['text']
    if (!enSortie.includes('text')) continue
    const top = (m && m.top_provider) || {}
    sortie.push({
      id,
      nom: String(m.name || id).slice(0, 120),
      auteur: id.split('/')[0],
      contexte: entierPositif(m.context_length),
      // La plus longue réponse que l'hébergeur principal accepte : la borne de
      // `max_tokens` pour ce modèle (null = non dite).
      sortieMax: entierPositif(top.max_completion_tokens),
      entree,
      sortie: sortieP,
      image: enEntree.includes('image'),
      fichier: enEntree.includes('file'),
      cree: Number.isFinite(Number(m.created)) ? Number(m.created) : null
    })
  }
  sortie.sort((a, b) => (b.cree || 0) - (a.cree || 0) || a.id.localeCompare(b.id))
  return sortie
}

/**
 * La liste des hébergeurs, réduite à ce qui sert : identifiant (`ignore`), nom
 * (celui que rend la réponse), et « établi en Chine » — siège OU centre de
 * données. Pure.
 */
function reduireHebergeurs (brut) {
  const lignes = Array.isArray(brut && brut.data) ? brut.data : []
  const pays = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map(x => String(x).trim().toUpperCase())
  return lignes
    .filter(h => h && h.slug)
    .map(h => ({
      slug: String(h.slug),
      nom: String(h.name || h.slug),
      enChine: pays(h.headquarters).includes('CN') || pays(h.datacenters).includes('CN')
    }))
}

// Caches par instance : catalogue et hébergeurs changent à l'échelle de la
// journée, et la page les redemande à chaque essai.
let cacheCatalogue = null
let cacheHebergeurs = null

async function lireJsonPublic (chemin, deps) {
  const fetchFn = deps.fetch || fetch
  let res
  try {
    res = await fetchFn(`${API}${chemin}`, { method: 'GET', signal: AbortSignal.timeout(15000) })
  } catch (e) {
    return { ok: false, motif: 'reseau', message: extrait(e && e.message) }
  }
  if (!res.ok) return { ok: false, motif: `http_${res.status}` }
  try { return { ok: true, json: await res.json() } } catch { return { ok: false, motif: 'reponse_illisible' } }
}

async function lireCatalogue (deps = {}) {
  const horloge = deps.horloge || Date.now
  if (!deps.sansCache && cacheCatalogue && horloge() - cacheCatalogue.lu < CACHE_TTL_MS) {
    return { ok: true, modeles: cacheCatalogue.modeles, cache: true }
  }
  const r = await lireJsonPublic('/models', deps)
  if (!r.ok) return r
  const modeles = reduireCatalogue(r.json)
  if (!modeles.length) return { ok: false, motif: 'catalogue_vide' }
  cacheCatalogue = { lu: horloge(), modeles }
  return { ok: true, modeles, cache: false }
}

/**
 * Les hébergeurs, depuis la liste publique d'OpenRouter. ⚠ Une liste illisible
 * ou sans aucun hébergeur chinois n'est pas crue : on retombe sur le repli.
 */
async function lireHebergeurs (deps = {}) {
  const horloge = deps.horloge || Date.now
  if (!deps.sansCache && cacheHebergeurs && horloge() - cacheHebergeurs.lu < CACHE_TTL_MS) {
    return { ok: true, hebergeurs: cacheHebergeurs.hebergeurs, cache: true }
  }
  const r = await lireJsonPublic('/providers', deps)
  if (!r.ok) return r
  const hebergeurs = reduireHebergeurs(r.json)
  if (!hebergeurs.some(h => h.enChine)) return { ok: false, motif: 'liste_sans_pays' }
  cacheHebergeurs = { lu: horloge(), hebergeurs }
  return { ok: true, hebergeurs, cache: false }
}

/** Les identifiants à exclure au premier essai. */
function hebergeursAExclure (hebergeurs) {
  if (Array.isArray(hebergeurs) && hebergeurs.length) {
    const liste = hebergeurs.filter(h => h.enChine).map(h => h.slug)
    if (liste.length) return liste
  }
  return HEBERGEURS_CHINE_REPLI.slice()
}

/**
 * L'hébergeur nommé par la réponse est-il établi en Chine ?
 * true / false s'il est CONNU (liste d'OpenRouter, ou repli pour la Chine) ;
 * null s'il est inconnu — jamais « hors Chine » par défaut.
 */
function estHebergeurChinois (nom, hebergeurs = null) {
  const n = normaliserNom(nom)
  if (!n) return null
  if (Array.isArray(hebergeurs) && hebergeurs.length) {
    const h = hebergeurs.find(x => normaliserNom(x.nom) === n || normaliserNom(x.slug) === n)
    if (h) return h.enChine
  }
  if (NOMS_CHINE_REPLI.includes(n)) return true
  return null
}

/** Le texte de la réponse, quel que soit son format (chaîne ou blocs). */
function texteDeReponse (json) {
  const msg = json && Array.isArray(json.choices) && json.choices[0] && json.choices[0].message
  if (!msg) return ''
  const c = msg.content
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) return c.map(b => (b && typeof b.text === 'string') ? b.text : '').join('').trim()
  return ''
}

const entier = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null)

/** L'usage normalisé : tokens et coût FACTURÉ. Pure. */
function usageDe (json) {
  const u = (json && json.usage) || null
  if (!u) return { entree: null, sortie: null, raisonnement: null, cache: null, cacheEcrit: null, coutUsd: null }
  const cout = Number(u.cost)
  const pd = u.prompt_tokens_details || {}
  return {
    entree: entier(u.prompt_tokens),
    sortie: entier(u.completion_tokens),
    raisonnement: entier(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
    cache: entier(pd.cached_tokens),
    cacheEcrit: entier(pd.cache_write_tokens),
    coutUsd: Number.isFinite(cout) && cout >= 0 ? Math.round(cout * 1e8) / 1e8 : null
  }
}

/**
 * Le refus veut-il dire « aucun hébergeur ne sert ce modèle sous ces
 * conditions » ? C'est le SEUL cas où l'on relance sans l'exclusion chinoise.
 * Un 401/402/429/5xx n'en est jamais un : la relance coûterait sans rien
 * changer. ⚠ PAS le mot « provider » seul : « Provider returned error » est la
 * panne ordinaire d'un hébergeur. ⚠ ET PAS un identifiant refusé dans notre
 * liste (`invalid provider`) : c'est NOTRE erreur, elle doit échouer à
 * l'écran, jamais lever l'exclusion (review du lot, constat 2).
 */
function estSansHebergeur (statut, message) {
  if (![400, 404].includes(statut)) return false
  const m = String(message || '')
  if (estListeRefusee(statut, m)) return false
  return /(no (allowed |available )?(endpoints?|providers?)|endpoints? found|data policy)/i.test(m)
}

/** OpenRouter refuse un identifiant de NOTRE liste d'exclusion. */
function estListeRefusee (statut, message) {
  return statut === 400 && /(unknown|invalid|unrecognized) provider/i.test(String(message || ''))
}

/**
 * Un appel au modèle `modele`. Rend
 *   { ok: true, texte, modele, hebergeur, enChine, restrictionLevee, usage, coutUsd, dureeMs, fin }
 * ou { ok: false, motif, statut, message, usage, coutUsd, dureeMs } — ⚠ un
 * échec FACTURÉ (réponse vide, limite de tokens atteinte) rend son coût.
 * `journal` : { fonction, userId, propertyId, bookingId } — la ligne de `ia_appels`.
 * `deps` : { fetch, sb, cle, horloge, delaiMs, hebergeurs } pour les tests.
 */
async function appelerModele ({ modele, messages, maxTokens = 2000, plugins = null, horsChine = true, journal = {} }, deps = {}) {
  const fetchFn = deps.fetch || fetch
  const horloge = deps.horloge || Date.now
  const sb = deps.sb || require('../cron-shared').supabase
  const cle = deps.cle !== undefined ? String(deps.cle || '').trim() : String(process.env.OPENROUTER_API_KEY || '').trim()
  if (!cle) return { ok: false, motif: 'cle_absente', message: 'OPENROUTER_API_KEY absente de la configuration' }
  if (!ID_MODELE.test(String(modele || ''))) return { ok: false, motif: 'modele_invalide' }
  if (!Array.isArray(messages) || !messages.length) return { ok: false, motif: 'messages_vides' }

  const hebergeurs = Array.isArray(deps.hebergeurs) ? deps.hebergeurs : null
  const essais = horsChine ? [hebergeursAExclure(hebergeurs), null] : [null]
  const delaiMax = deps.delaiMs || DELAI_MS
  const budget = deps.budgetMs || BUDGET_MS
  const debutTotal = horloge()
  let dernier = null
  let coutCumule = null
  for (let i = 0; i < essais.length; i++) {
    const ignore = essais[i]
    const reste = budget - (horloge() - debutTotal)
    if (i > 0 && reste < RELANCE_MIN_MS) break
    const delai = Math.max(1000, Math.min(delaiMax, reste))
    const provider = { data_collection: 'deny' }
    if (ignore) provider.ignore = ignore
    const corps = { model: modele, messages, max_tokens: maxTokens, provider }
    if (plugins) corps.plugins = plugins
    const debut = horloge()
    let statut = 0
    let json = null
    let erreurReseau = null
    try {
      const res = await fetchFn(`${API}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cle}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://hotesmart.vercel.app',
          'X-Title': 'HoteSmart Labo IA'
        },
        body: JSON.stringify(corps),
        signal: AbortSignal.timeout(delai)
      })
      statut = res.status
      try { json = await res.json() } catch { json = null }
    } catch (e) {
      erreurReseau = e
    }
    const dureeMs = horloge() - debut
    const erreurApi = json && json.error ? json.error : null
    const usage = usageDe(json)
    if (usage.coutUsd !== null) coutCumule = Math.round(((coutCumule || 0) + usage.coutUsd) * 1e8) / 1e8
    const texte = texteDeReponse(json)
    const fin = (json && Array.isArray(json.choices) && json.choices[0] && json.choices[0].finish_reason) || null
    const ok = !erreurReseau && statut >= 200 && statut < 300 && !erreurApi && !!texte
    const statutErreur = erreurApi && Number.isFinite(Number(erreurApi.code)) ? Number(erreurApi.code) : statut
    const message = erreurReseau
      ? (erreurReseau.name === 'TimeoutError' ? `délai dépassé (${Math.round(delai / 1000)} s) — un appel coupé peut avoir été facturé` : extrait(erreurReseau.message))
      : erreurApi ? extrait(erreurApi.message || JSON.stringify(erreurApi))
      : (!texte && statut >= 200 && statut < 300
        ? (fin === 'length' ? `limite de ${maxTokens} tokens atteinte avant toute réponse (réflexion trop longue)` : 'réponse vide')
        : (statut >= 300 ? `HTTP ${statut}` : null))

    await noterAppelIA(sb, {
      fonction: String(journal.fonction || 'labo-ia'),
      user_id: journal.userId || null,
      property_id: journal.propertyId ? String(journal.propertyId) : null,
      booking_id: journal.bookingId ? String(journal.bookingId) : null,
      modele: (json && json.model) || modele,
      input_tokens: usage.entree,
      output_tokens: usage.sortie,
      cache_read_tokens: usage.cache,
      cache_write_tokens: usage.cacheEcrit,
      cout_usd: usage.coutUsd,
      duree_ms: Math.round(dureeMs),
      stop_reason: fin,
      ok,
      erreur: ok ? null : (message || 'échec')
    })

    if (ok) {
      const hebergeur = (json && typeof json.provider === 'string') ? json.provider : null
      return {
        ok: true,
        texte,
        modele: (json && json.model) || modele,
        hebergeur,
        enChine: estHebergeurChinois(hebergeur, hebergeurs),
        restrictionLevee: i > 0,
        usage,
        coutUsd: coutCumule,
        dureeMs: horloge() - debutTotal,
        fin
      }
    }
    const motif = erreurReseau ? (erreurReseau.name === 'TimeoutError' ? 'delai' : 'reseau')
      : estListeRefusee(statutErreur, message) ? 'liste_hebergeurs_invalide'
      : (!erreurApi && statut >= 200 && statut < 300) ? (fin === 'length' ? 'limite_tokens' : 'reponse_vide')
      : `http_${statutErreur || statut}`
    dernier = { ok: false, motif, statut: statutErreur || statut, message, usage, coutUsd: coutCumule, dureeMs: horloge() - debutTotal }
    // On ne relance QUE sur « aucun hébergeur hors de Chine ».
    if (!(ignore && estSansHebergeur(statutErreur || statut, message))) break
  }
  return dernier
}

module.exports = {
  API, ID_MODELE, HEBERGEURS_CHINE_REPLI, DELAI_MS, BUDGET_MS,
  reduireCatalogue, reduireHebergeurs, lireCatalogue, lireHebergeurs, hebergeursAExclure,
  prixParMillion, texteDeReponse, usageDe,
  estHebergeurChinois, estSansHebergeur, estListeRefusee, appelerModele,
  _viderCache: () => { cacheCatalogue = null; cacheHebergeurs = null }
}
