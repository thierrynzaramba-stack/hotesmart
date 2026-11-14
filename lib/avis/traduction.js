// lib/avis/traduction.js — LE WRITER UNIQUE de `avis_traductions`.
// Spec : docs/specs/avis-v5/spec-traduction-avis.md.
//
// Un avis ecrit dans une autre langue s'affiche traduit dans la langue de
// lecture (fr, en, es), avec « Voir l'original » (decisions de Thierry du
// 11 novembre 2026). La traduction est une donnee NON URGENTE : elle se fait
// ici, en tache de fond, et les ecrans la LISENT — aucun ecran n'appelle l'IA.
//
// ⚠ DEUX APPELS AU PLUS PAR AVIS, ET L'EXTRAIT TOUJOURS SEUL (decision de
// Thierry du 15 novembre 2026, Q6 = A, apres la seconde revue du lot) :
//   - appel A : le texte public et le retour prive, JAMAIS l'extrait ;
//   - appel B : l'extrait SEUL, quand l'avis en a un.
// La prestataire ne lit que l'extrait. Traduit dans le meme appel que le retour
// prive, il pouvait en porter une phrase jusqu'a elle — par un ajout du modele
// ou par deux champs intervertis — et sans l'etiquette « retour prive » (revue,
// constat 1). Une borne de longueur limitait la place, pas la provenance. La
// seule garantie est l'isolement : un appel ne peut pas rendre ce qu'il n'a pas
// recu. Dans chaque appel, le modele detecte la langue de CHAQUE champ (un
// voyageur peut ecrire le public en anglais et le prive en francais). L'unite
// de cout plafonnee par Thierry reste l'APPEL (Q5 = A).
//
// ⚠ RIEN N'EST ECRIT SANS ETRE VALIDE. Un modele peut rendre du JSON casse, une
// langue inventee, un champ vide ou un champ qu'on ne lui a pas demande : la
// reponse entiere est alors refusee, rien n'est ecrit en traduction, et l'echec
// est note pour que l'avis ne repasse pas a chaque passage.
//
// ⚠ L'EMPREINTE DIT SI UNE TRADUCTION EST ENCORE VRAIE. Elle porte sur les
// trois textes traduits ; un texte qui change (Airbnb revele l'avis, la
// classification pose un nouvel extrait) la rend perimee : l'ecran ne la sert
// plus et l'avis repasse dans la file. Meme regle que la fonction SQL
// `avis_empreinte` (migrations/2026-11-11-avis-traductions.sql).

const crypto = require('node:crypto')
const { avecContexteIA } = require('../ia/journal')

const LANGUES = ['fr', 'en', 'es']
const CHAMPS = ['public', 'prive', 'extrait']
const MODELE = 'claude-haiku-4-5-20251001'
const SEPARATEUR = '\u001f'
// Un champ plus long que ca n'est PAS traduit (revue du lot, constat 4) : une
// traduction d'un texte coupe s'afficherait a la place de l'original complet,
// sans rien en dire. Il garde son original.
const MAX_CARACTERES = 4000
// Le plafond de la reponse. Le cout se paie a la sortie REELLE, pas au plafond :
// un plafond trop bas coupe la reponse (JSON illisible, echec a chaque essai —
// revue, constat 2), un plafond haut ne coute rien de plus.
const MAX_TOKENS = 16000
const LANGUE_RE = /^[a-z]{2}$/

// Le texte public tel que l'ecran l'affiche (lib/avis/cartes.js :
// `a.content_public || a.content`).
const textePublic = (a) => (a && (a.content_public || a.content)) || null

/** L'empreinte des trois textes traduits — meme regle que `avis_empreinte`. */
function empreinte (pub, prive, extrait) {
  const s = [pub, prive, extrait].map(v => (v == null ? '' : String(v))).join(SEPARATEUR)
  return crypto.createHash('md5').update(s, 'utf8').digest('hex')
}

/** L'empreinte d'une ligne d'`ota_reviews`, telle que l'ecran la recalcule. */
const empreinteAvis = (a) => empreinte(textePublic(a), a && a.content_private, a && a.ai_clean_excerpt)

/** Les champs non vides a traduire, depuis une ligne de la file SQL. */
function champsDe (ligne) {
  const brut = { public: ligne && ligne.texte_public, prive: ligne && ligne.texte_prive, extrait: ligne && ligne.texte_extrait }
  const champs = {}
  for (const c of CHAMPS) {
    const v = brut[c] == null ? '' : String(brut[c])
    if (v.trim() && v.length <= MAX_CARACTERES) champs[c] = v
  }
  return champs
}

// La sortie attendue : chaque champ en trois langues au plus, a 1,2 token par
// caractere SOURCE — le pire cas mesurable, un texte en ideogrammes rendu en
// trois langues alphabetiques (400 caracteres chinois ≈ 1 200 a 1 400 tokens,
// revue du lot, constat 2). Plus le JSON.
const maxTokensPour = (champs) => Math.min(MAX_TOKENS,
  400 + Math.ceil(Object.values(champs).reduce((n, v) => n + v.length, 0) * 3 * 1.2))

function construirePrompt (champs) {
  const entree = JSON.stringify(champs)
  return `Tu traduis un avis de voyageur sur un logement de location courte duree.
Il a jusqu'a trois champs : "public" (l'avis publie), "prive" (le retour prive
a l'hote) et "extrait" (une phrase citee de l'avis).

Pour CHAQUE champ recu :
- detecte sa langue (code ISO 639-1 en minuscules : "fr", "en", "de", "it"...) ;
- traduis-le en francais ("fr"), anglais ("en") et espagnol ("es"), SAUF dans
  sa propre langue.

Regles :
- Traduction fidele, ton conserve, rien ajoute, rien retire, aucune note.
- Les noms propres et les prenoms restent tels quels.
- Ne traduis que les champs recus. N'invente aucun champ.

Reponds en JSON strict, sans texte autour, de la forme :
{"public":{"source":"en","fr":"...","es":"..."},"prive":{"source":"fr","en":"...","es":"..."}}

Champs : ${entree}`
}

/**
 * Valide la reponse du modele contre les champs demandes. Rend
 * `{ ok: true, textes }` ou `{ ok: false, motif }`.
 *
 * Une version dans la langue SOURCE elle-meme est ignoree (rien a traduire) ;
 * une version MANQUANTE dans une langue cible refuse tout.
 */
function lireReponse (brut, champs) {
  let json
  try {
    json = JSON.parse(String(brut || '').replace(/```json|```/g, '').trim())
  } catch { return { ok: false, motif: 'json_illisible' } }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, motif: 'json_illisible' }

  const demandes = Object.keys(champs)
  for (const k of Object.keys(json)) if (!demandes.includes(k)) return { ok: false, motif: 'champ_invente' }

  const textes = {}
  for (const c of demandes) {
    const r = json[c]
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, motif: 'champ_manquant' }
    const source = String(r.source || '').trim().toLowerCase()
    if (!LANGUE_RE.test(source)) return { ok: false, motif: 'langue_illisible' }
    for (const k of Object.keys(r)) {
      if (k !== 'source' && !LANGUES.includes(k)) return { ok: false, motif: 'langue_inventee' }
    }
    const sortie = { source }
    // Une borne large : elle arrete une reponse absurde, pas une traduction
    // fidele depuis des ideogrammes (revue, constat 2). Ce n'est plus elle qui
    // protege la prestataire : c'est l'isolement de l'extrait (voir en tete).
    const plafond = champs[c].length * 4 + 400
    for (const l of LANGUES) {
      if (l === source) continue
      const v = typeof r[l] === 'string' ? r[l].trim() : ''
      if (!v) return { ok: false, motif: 'traduction_vide' }
      if (v.length > plafond) return { ok: false, motif: 'traduction_trop_longue' }
      sortie[l] = v
    }
    textes[c] = sortie
  }
  return { ok: true, textes }
}

/**
 * Les appels d'une ligne, dans l'ordre : A (public + prive), puis B (l'extrait
 * SEUL). Un groupe vide n'est pas un appel. Se connait AVANT d'appeler : le cron
 * reserve son plafond la-dessus.
 */
function groupesDe (ligne) {
  const champs = champsDe(ligne)
  const a = {}
  if (champs.public != null) a.public = champs.public
  if (champs.prive != null) a.prive = champs.prive
  const groupes = []
  if (Object.keys(a).length) groupes.push(a)
  if (champs.extrait != null) groupes.push({ extrait: champs.extrait })
  return groupes
}

/** Le nombre d'appels qu'une ligne coutera : 0, 1 ou 2. */
const appelsPrevus = (ligne) => groupesDe(ligne).length

async function appeler (client, ligne, champs, options) {
  try {
    const reponse = await avecContexteIA({ fonction: 'avis_traduction', userId: ligne.user_id, propertyId: ligne.property_id_ref, bookingId: ligne.booking_uid },
      () => client.messages.create({
        model: MODELE,
        max_tokens: maxTokensPour(champs),
        messages: [{ role: 'user', content: construirePrompt(champs) }]
      }, ...options))
    // Une reponse coupee au plafond n'est pas illisible par hasard : on le dit.
    if (reponse && reponse.stop_reason === 'max_tokens') return { ok: false, motif: 'reponse_tronquee' }
    return lireReponse(reponse?.content?.[0]?.text, champs)
  } catch (err) {
    return { ok: false, motif: 'appel_en_echec', detail: String(err && err.message || err).slice(0, 200) }
  }
}

/**
 * Traduit UNE ligne de la file : un ou deux appels a l'IA (voir en tete).
 * Rend `{ ok, textes, appels }` ou `{ ok: false, motif, appels }` ; ne leve pas,
 * une erreur d'API est un echec. Tout ou rien : un appel en echec fait echouer
 * l'avis, et l'appel B n'est pas tente quand l'appel A a echoue.
 *
 * @param deps { anthropic, timeoutMs } — `anthropic` injectable, par defaut le
 *             client PARTAGE (lib/cron-shared.js), seul porteur du journal des
 *             appels ; `timeoutMs` : la duree maximale de CHAQUE appel (cron).
 */
async function traduireLigne (ligne, deps = {}) {
  const groupes = groupesDe(ligne)
  // ⚠ RIEN A TRADUIRE EST UNE REUSSITE VIDE, pas un echec (revue du lot,
  // constat 5) : ecrite avec son empreinte, la ligne sort de la file jusqu'a ce
  // que le texte change. Un echec la ferait revenir toutes les 24 h.
  if (!groupes.length) return { ok: true, textes: {}, motif: 'rien_a_traduire', appels: 0 }
  const client = deps.anthropic || require('../cron-shared').anthropic
  // ⚠ UN APPEL DU CRON A UNE DUREE BORNEE, ET AUCUNE RELANCE (revue du lot,
  // constat 1) : un appel qui depasserait le reste du cycle serait coupe par
  // la plateforme, paye et jamais compte. Le script, lui, n'a pas d'echeance.
  const options = Number.isFinite(deps.timeoutMs) ? [{ timeout: Math.max(1, Math.floor(deps.timeoutMs)), maxRetries: 0 }] : []
  const textes = {}
  let appels = 0
  for (const champs of groupes) {
    appels++
    const r = await appeler(client, ligne, champs, options)
    if (!r.ok) return { ...r, appels }
    // ⚠ Chaque appel ne rend QUE ses champs (`lireReponse` refuse un champ
    // invente) : l'extrait ne peut venir que de l'appel qui ne voit que lui.
    Object.assign(textes, r.textes)
  }
  return { ok: true, textes, appels }
}

/**
 * Ecrit le resultat d'une traduction. Une reussite pose la traduction ET efface
 * l'echec ; un echec ne touche PAS la derniere traduction reussie (elle reste
 * perimee, donc non servie) et note l'heure et l'empreinte de l'essai.
 *
 * ⚠ Les colonnes ecrites sont celles du payload, et seulement elles : un echec
 * n'ecrit ni `textes` ni `empreinte`.
 */
const echecsApres = (ligne) => (Number.isInteger(ligne.echecs) && ligne.echecs > 0 ? ligne.echecs : 0) + 1
const tentative = (ligne, quand) => ({ review_id: ligne.id, user_id: ligne.user_id, echec_le: quand,
  echec_empreinte: ligne.empreinte, echecs: echecsApres(ligne) })

async function ecrireResultat (sb, ligne, resultat, { maintenant = Date.now() } = {}) {
  const quand = new Date(maintenant).toISOString()
  const payload = resultat.ok
    ? { review_id: ligne.id, user_id: ligne.user_id, empreinte: ligne.empreinte, textes: resultat.textes,
        traduit_le: quand, echec_le: null, echec_empreinte: null, echecs: 0 }
    : tentative(ligne, quand)
  const { error } = await sb.from('avis_traductions').upsert(payload, { onConflict: 'review_id' })
  return error || null
}

/**
 * ⚠ LES TENTATIVES SONT NOTEES AVANT LES APPELS (revue du lot, constat 1) : un
 * passage coupe pendant un appel laisse chaque avis du lot marque « essaye »,
 * donc ecarte 24 h — sinon le meme avis repasserait en tete au passage
 * suivant, hors de tout plafond. Une reussite efface la tentative ; un echec
 * la reecrit a l'identique. Une seule ecriture pour le lot.
 */
async function noterTentatives (sb, lignes, { maintenant = Date.now() } = {}) {
  if (!lignes.length) return null
  const quand = new Date(maintenant).toISOString()
  const { error } = await sb.from('avis_traductions').upsert(lignes.map(l => tentative(l, quand)), { onConflict: 'review_id' })
  return error || null
}

// PostgREST : PGRST202 (fonction absente du cache de schema), PGRST205 (table
// absente) ; Postgres : 42883 (fonction), 42P01 (relation). Meme regle que
// lib/avis/resume.js : les CODES font foi, et une COLONNE absente n'est pas une
// migration en attente, c'est un schema qui a derive.
const CODES_MIGRATION_ABSENTE = new Set(['PGRST202', 'PGRST205', '42P01', '42883'])
const TEXTE_MIGRATION_ABSENTE_RE = /\b(relation|function) "?[\w.]*(avis_traductions|avis_a_traduire|avis_empreinte)\w*"?(\([^)]*\))? does not exist|could not find the (function|table) '?[\w.]*(avis_traductions|avis_a_traduire)/i
function migrationAbsente (error) {
  if (!error) return false
  if (error.code) return CODES_MIGRATION_ABSENTE.has(String(error.code))
  return TEXTE_MIGRATION_ABSENTE_RE.test(String(error.message || ''))
}

/**
 * La traduction a servir pour UNE ligne d'`ota_reviews` lue par un ecran, dans
 * la langue `langue`. Rend `null` quand il n'y a rien a montrer de plus que
 * l'original : pas de traduction, traduction perimee, ou texte deja dans la
 * langue de lecture. Sinon `{ public?, prive?, extrait? }`, chaque champ
 * `{ source, texte }`.
 *
 * ⚠ LA TRADUCTION PERIMEE N'EST JAMAIS SERVIE : un texte modifie depuis la
 * traduction montrerait une version qui ne dit plus la meme chose.
 */
function traductionPour (ligneAvis, traduction, langue) {
  if (!traduction || !traduction.textes || !traduction.empreinte) return null
  if (!LANGUES.includes(langue)) return null
  if (traduction.empreinte !== empreinteAvis(ligneAvis)) return null
  const sortie = {}
  for (const c of CHAMPS) {
    const t = traduction.textes[c]
    if (!t || !LANGUE_RE.test(String(t.source || '')) || t.source === langue) continue
    const texte = typeof t[langue] === 'string' ? t[langue] : ''
    if (texte.trim()) sortie[c] = { source: t.source, texte }
  }
  return Object.keys(sortie).length ? sortie : null
}

module.exports = {
  LANGUES, CHAMPS, MODELE, MAX_CARACTERES, MAX_TOKENS,
  empreinte, empreinteAvis, textePublic, champsDe, groupesDe, appelsPrevus, maxTokensPour,
  construirePrompt, lireReponse, traduireLigne, ecrireResultat, noterTentatives,
  migrationAbsente, traductionPour
}
