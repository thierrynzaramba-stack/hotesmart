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
//   · `data_collection: 'deny'` sur chaque appel — aucun hébergeur qui garde
//     ou entraîne sur les données (le compte OpenRouter le refuse aussi) ;
//   · hors de Chine QUAND C'EST POSSIBLE : les hébergeurs chinois sont exclus
//     au premier essai ; si aucun autre hébergeur ne sert le modèle, on
//     relance sans l'exclusion et la réponse le DIT (`restrictionLevee`).
//     Un modèle qui ne tourne qu'en Chine est signalé, jamais caché.

const { noterAppelIA } = require('./journal')
const { extrait } = require('../incident-facturation')

// La SEULE destination des appels, et de la clé.
const API = 'https://openrouter.ai/api/v1'

// Un identifiant du catalogue : `auteur/modele`, avec une variante éventuelle
// (`:nitro`). Rien d'autre ne passe — pas d'URL, pas d'espace, pas de `..`.
const ID_MODELE = /^[a-z0-9][a-z0-9._-]{0,60}\/[a-z0-9][a-z0-9._:-]{0,100}$/i

// Les hébergeurs établis en Chine, par leur identifiant OpenRouter (`ignore`)
// et par leur nom tel que la réponse le rend (`provider`). ⚠ À VÉRIFIER sur la
// fiche d'un modèle OpenRouter si un nouvel hébergeur apparaît : la page du
// labo affiche toujours le nom de l'hébergeur qui a servi, donc un oubli se
// voit à l'écran.
const HEBERGEURS_CHINE = ['deepseek', 'moonshotai', 'alibaba', 'z-ai', 'minimax',
  'baidu', 'siliconflow', 'stepfun', 'xiaomi', 'tencent', 'bytedance']
const NOMS_CHINE = new Set(['deepseek', 'moonshotai', 'moonshot', 'alibaba', 'alibabacloud',
  'qwen', 'zai', 'zhipu', 'zhipuai', 'minimax', 'baidu', 'siliconflow', 'stepfun',
  'xiaomi', 'tencent', 'bytedance', 'volcengine'])

// Un modèle qui réfléchit longtemps reste sous le mur de la fonction
// (`maxDuration` de api/labo-ia.js dans vercel.json).
const DELAI_MS = 100000
const CATALOGUE_TTL_MS = 3600 * 1000

const normaliserNom = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** L'hébergeur nommé par la réponse est-il établi en Chine ? null s'il est inconnu. */
function estHebergeurChinois (nom) {
  const n = normaliserNom(nom)
  if (!n) return null
  return NOMS_CHINE.has(n)
}

/** Prix OpenRouter (dollars PAR TOKEN, en texte) -> dollars par million, ou null. */
function prixParMillion (v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1e6 * 10000) / 10000
}

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
    sortie.push({
      id,
      nom: String(m.name || id).slice(0, 120),
      auteur: id.split('/')[0],
      contexte: Number.isFinite(Number(m.context_length)) ? Number(m.context_length) : null,
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

// Cache par instance : le catalogue change à l'échelle de la journée, et la
// page le redemande à chaque ouverture.
let cacheCatalogue = null

async function lireCatalogue (deps = {}) {
  const fetchFn = deps.fetch || fetch
  const horloge = deps.horloge || Date.now
  if (!deps.sansCache && cacheCatalogue && horloge() - cacheCatalogue.lu < CATALOGUE_TTL_MS) {
    return { ok: true, modeles: cacheCatalogue.modeles, cache: true }
  }
  let res
  try {
    res = await fetchFn(`${API}/models`, { method: 'GET', signal: AbortSignal.timeout(15000) })
  } catch (e) {
    return { ok: false, motif: 'reseau', message: extrait(e && e.message) }
  }
  if (!res.ok) return { ok: false, motif: `http_${res.status}` }
  let json
  try { json = await res.json() } catch { return { ok: false, motif: 'reponse_illisible' } }
  const modeles = reduireCatalogue(json)
  if (!modeles.length) return { ok: false, motif: 'catalogue_vide' }
  cacheCatalogue = { lu: horloge(), modeles }
  return { ok: true, modeles, cache: false }
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
  if (!u) return { entree: null, sortie: null, raisonnement: null, cache: null, coutUsd: null }
  const cout = Number(u.cost)
  return {
    entree: entier(u.prompt_tokens),
    sortie: entier(u.completion_tokens),
    raisonnement: entier(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
    cache: entier(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens),
    coutUsd: Number.isFinite(cout) && cout >= 0 ? Math.round(cout * 1e8) / 1e8 : null
  }
}

/**
 * Le refus veut-il dire « aucun hébergeur ne sert ce modèle sous ces
 * conditions » ? C'est le seul cas où l'on relance sans l'exclusion chinoise.
 * Un 401/402/429/5xx n'en est jamais un : la relance coûterait sans rien
 * changer.
 */
function estSansHebergeur (statut, message) {
  if (![400, 404].includes(statut)) return false
  // ⚠ PAS le mot « provider » seul : « Provider returned error » est la panne
  // ordinaire d'un hébergeur, et la relancer lèverait l'exclusion pour rien.
  return /(no (allowed |available )?(endpoints?|providers?)|endpoints? found|data policy|ignored providers?|(unknown|invalid) provider)/i.test(String(message || ''))
}

/**
 * Un appel au modèle `modele`. Rend
 *   { ok: true, texte, modele, hebergeur, enChine, restrictionLevee, usage, coutUsd, dureeMs, fin }
 * ou { ok: false, motif, statut, message, dureeMs }.
 * `journal` : { fonction, userId, propertyId, bookingId } — la ligne de `ia_appels`.
 * `deps` : { fetch, sb, cle, horloge, delaiMs } pour les tests.
 */
async function appelerModele ({ modele, messages, maxTokens = 2000, plugins = null, horsChine = true, journal = {} }, deps = {}) {
  const fetchFn = deps.fetch || fetch
  const horloge = deps.horloge || Date.now
  const sb = deps.sb || require('../cron-shared').supabase
  const cle = deps.cle !== undefined ? String(deps.cle || '').trim() : String(process.env.OPENROUTER_API_KEY || '').trim()
  if (!cle) return { ok: false, motif: 'cle_absente', message: 'OPENROUTER_API_KEY absente de la configuration' }
  if (!ID_MODELE.test(String(modele || ''))) return { ok: false, motif: 'modele_invalide' }
  if (!Array.isArray(messages) || !messages.length) return { ok: false, motif: 'messages_vides' }

  const essais = horsChine ? [HEBERGEURS_CHINE, null] : [null]
  const debutTotal = horloge()
  let dernier = null
  for (let i = 0; i < essais.length; i++) {
    const ignore = essais[i]
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
        signal: AbortSignal.timeout(deps.delaiMs || DELAI_MS)
      })
      statut = res.status
      try { json = await res.json() } catch { json = null }
    } catch (e) {
      erreurReseau = e
    }
    const dureeMs = horloge() - debut
    const erreurApi = json && json.error ? json.error : null
    const usage = usageDe(json)
    const texte = texteDeReponse(json)
    const ok = !erreurReseau && statut >= 200 && statut < 300 && !erreurApi && !!texte
    const message = erreurReseau
      ? (erreurReseau.name === 'TimeoutError' ? `délai dépassé (${Math.round((deps.delaiMs || DELAI_MS) / 1000)} s)` : extrait(erreurReseau.message))
      : erreurApi ? extrait(erreurApi.message || JSON.stringify(erreurApi)) : (!texte && statut >= 200 && statut < 300 ? 'réponse vide' : (statut >= 300 ? `HTTP ${statut}` : null))

    await noterAppelIA(sb, {
      fonction: String(journal.fonction || 'labo-ia'),
      user_id: journal.userId || null,
      property_id: journal.propertyId ? String(journal.propertyId) : null,
      booking_id: journal.bookingId ? String(journal.bookingId) : null,
      modele: (json && json.model) || modele,
      input_tokens: usage.entree,
      output_tokens: usage.sortie,
      cache_read_tokens: usage.cache,
      cache_write_tokens: null,
      cout_usd: usage.coutUsd,
      duree_ms: Math.round(dureeMs),
      stop_reason: (json && json.choices && json.choices[0] && json.choices[0].finish_reason) || null,
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
        enChine: estHebergeurChinois(hebergeur),
        restrictionLevee: i > 0,
        usage,
        coutUsd: usage.coutUsd,
        dureeMs: horloge() - debutTotal,
        fin: (json.choices[0] && json.choices[0].finish_reason) || null
      }
    }
    const statutErreur = erreurApi && Number.isFinite(Number(erreurApi.code)) ? Number(erreurApi.code) : statut
    dernier = { ok: false, motif: erreurReseau ? 'reseau' : `http_${statutErreur || statut}`, statut: statutErreur || statut, message, dureeMs: horloge() - debutTotal }
    // On ne relance QUE sur « aucun hébergeur hors de Chine ».
    if (!(ignore && estSansHebergeur(statutErreur || statut, message))) break
  }
  return dernier
}

module.exports = {
  API, ID_MODELE, HEBERGEURS_CHINE, DELAI_MS,
  reduireCatalogue, lireCatalogue, prixParMillion, texteDeReponse, usageDe,
  estHebergeurChinois, estSansHebergeur, appelerModele,
  _viderCache: () => { cacheCatalogue = null }
}
