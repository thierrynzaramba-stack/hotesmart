// lib/labo-ia.js — LES RÈGLES PURES DU LABO IA
//
// Chantier « Labo IA » (20 novembre 2026). Deux bancs d'essai réservés au
// fondateur : (1) la même question posée à plusieurs IA, avec la base de
// connaissance du bien et une conversation voyageur ; (2) la même facture lue
// par plusieurs IA, avec la consigne de lecture du compte de charges.
// Doc : docs/kb/labo-ia.md.
//
// ⚠ CE MODULE NE LIT AUCUNE BASE ET N'APPELLE AUCUNE IA. L'endpoint
// (api/labo-ia.js) lit, ce module met en forme, lib/ia/openrouter.js appelle.
//
// ⚠ RIEN N'EST ENVOYÉ AU VOYAGEUR ET RIEN N'EST ÉCRIT dans le produit : ni
// message, ni tâche, ni charge, ni base de connaissance. Le seul effet d'un
// essai est la ligne du journal `ia_appels` (et la dépense OpenRouter).

const { CONSIGNE, extraireJson } = require('./charges/lecture')
const { normaliserLecture, typeReel } = require('./charges/regles')
const { filEnTexte } = require('./guestflow/rediger')

const FONCTION_QUESTION = 'labo-ia-question'
const FONCTION_FACTURE = 'labo-ia-facture'

const MAX_QUESTION = 4000
// Le fil donné au modèle : les plus récents, comme la rédaction GuestFlow.
const MESSAGES_DU_FIL = 30
// Les conversations proposées pour un bien : les plus récentes.
const MAX_CONVERSATIONS = 40
// ⚠ LE CORPS D'UNE FONCTION VERCEL EST BORNÉ À 4,5 Mo. Le fichier voyage en
// base64 (+ 37 %) : 3 Mo bruts font ~4,1 Mo de texte.
const MAX_OCTETS_FACTURE = 3 * 1024 * 1024
const TYPES_FACTURE = ['application/pdf', 'image/jpeg', 'image/png']
// Garde de coût : un bug de boucle dans la page ne vide pas le crédit.
// La vraie limite est le plafond de la clé OpenRouter.
const PLAFOND_JOUR = 400
const MAX_TOKENS_QUESTION = 2000
const MAX_TOKENS_FACTURE = 1500
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** La question du fondateur, bornée. */
function validerQuestion (q) {
  const t = typeof q === 'string' ? q.trim() : ''
  if (!t) return { ok: false, erreur: 'question_vide' }
  if (t.length > MAX_QUESTION) return { ok: false, erreur: 'question_trop_longue' }
  return { ok: true, question: t }
}

/** Un identifiant de réservation venu du client : texte court, ou rien. */
function validerBooking (v) {
  if (v === undefined || v === null || v === '') return { ok: true, booking: null }
  if (typeof v !== 'string' && typeof v !== 'number') return { ok: false, erreur: 'booking_invalide' }
  const s = String(v).trim()
  if (!s || s.length > 200) return { ok: false, erreur: 'booking_invalide' }
  return { ok: true, booking: s }
}

const estUuid = (v) => typeof v === 'string' && UUID.test(v)

/**
 * Les conversations d'un bien, depuis ses messages (les plus récents d'abord)
 * et les réservations du cœur. Pure.
 * `messages` : [{ booking_id, sent_at, direction }] triés du plus récent.
 * `snaps` : [{ booking_id, snapshot }].
 */
function resumerConversations (messages, snaps) {
  const parSejour = new Map()
  for (const m of messages || []) {
    const id = m && m.booking_id != null ? String(m.booking_id) : ''
    if (!id || id === 'unknown') continue
    let c = parSejour.get(id)
    if (!c) {
      c = { bookingId: id, dernier: m.sent_at || null, messages: 0, voyageur: 0 }
      parSejour.set(id, c)
    }
    c.messages++
    if (m.direction === 'inbound') c.voyageur++
  }
  const snapDe = new Map((snaps || []).map(s => [String(s.booking_id), (s && s.snapshot) || {}]))
  return [...parSejour.values()].slice(0, MAX_CONVERSATIONS).map(c => {
    const s = snapDe.get(c.bookingId) || {}
    const nom = [s.firstName, s.lastName].filter(Boolean).join(' ').trim()
    return {
      bookingId: c.bookingId,
      voyageur: nom || null,
      arrivee: s.arrival || null,
      depart: s.departure || null,
      dernier: c.dernier,
      messages: c.messages,
      duVoyageur: c.voyageur
    }
  })
}

/** Le fil du cœur (messages du plus récent au plus ancien) remis à l'endroit. */
function filDepuisMessages (msgs) {
  return (msgs || []).slice().reverse().map(m => ({
    source: m.direction === 'inbound' ? 'guest' : (m.kind === 'auto' ? 'auto' : 'host'),
    message: m.body || ''
  }))
}

/**
 * Le message « système » : le même pour toutes les IA d'un essai, sinon la
 * comparaison ne compare rien. Pure.
 */
function contexteSysteme ({ bienNom, connaissance, consignes, voyageur, arrivee, depart, fil }) {
  const sejour = voyageur || arrivee || depart
    ? `\nSÉJOUR : ${voyageur || 'voyageur'}${arrivee ? `, arrivée le ${arrivee}` : ''}${depart ? `, départ le ${depart}` : ''}.\n`
    : ''
  const conversation = Array.isArray(fil) && fil.length
    ? `\nCONVERSATION AVEC LE VOYAGEUR (du plus ancien au plus récent) :\n${filEnTexte(fil)}\n`
    : ''
  return `Tu assistes l'hôte d'une location de vacances (logement : ${bienNom || 'le logement'}).
Réponds à sa demande en t'appuyant UNIQUEMENT sur la base de connaissance et la conversation ci-dessous.
Si une information n'y est pas, dis-le clairement au lieu de l'inventer.
Réponds dans la langue de la demande, de façon claire et concise.
${sejour}
BASE DE CONNAISSANCE DU LOGEMENT :
${connaissance || '(vide)'}
${consignes ? `\nCONSIGNES DE L'HÔTE :\n${consignes}\n` : ''}${conversation}`
}

function messagesQuestion (contexte, question) {
  return [
    { role: 'system', content: contexteSysteme(contexte) },
    { role: 'user', content: question }
  ]
}

/** Une estimation grossière (≈ 3,5 caractères par token), DITE estimation. */
function estimerTokens (texte) {
  const n = String(texte || '').length
  return n ? Math.ceil(n / 3.5) : 0
}

/**
 * Le fichier de facture venu du client, en base64. Son type est lu dans ses
 * octets, jamais dans son nom. Rend { ok, octets, type } ou { ok: false, erreur }.
 */
function validerFichier (b64) {
  if (typeof b64 !== 'string' || !b64) return { ok: false, erreur: 'fichier_absent' }
  const brut = b64.replace(/^data:[^;,]*;base64,/, '')
  if (brut.length > Math.ceil(MAX_OCTETS_FACTURE * 4 / 3) + 8) return { ok: false, erreur: 'fichier_trop_lourd' }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(brut)) return { ok: false, erreur: 'fichier_illisible' }
  const octets = Buffer.from(brut, 'base64')
  if (!octets.length) return { ok: false, erreur: 'fichier_illisible' }
  if (octets.length > MAX_OCTETS_FACTURE) return { ok: false, erreur: 'fichier_trop_lourd' }
  const type = typeReel(octets)
  if (!TYPES_FACTURE.includes(type)) return { ok: false, erreur: type ? 'type_non_pris' : 'type_inconnu', type }
  return { ok: true, octets, type }
}

/**
 * Les messages d'une lecture de facture : la consigne du compte de charges,
 * à l'identique, puis le document. Un PDF part comme fichier (OpenRouter le
 * donne au modèle s'il sait le lire, sinon passe par son OCR) ; une image
 * comme image (seuls les modèles qui voient les images la reçoivent).
 */
function messagesFacture ({ octets, type }) {
  const b64 = Buffer.from(octets).toString('base64')
  const doc = type === 'application/pdf'
    ? { type: 'file', file: { filename: 'facture.pdf', file_data: `data:application/pdf;base64,${b64}` } }
    : { type: 'image_url', image_url: { url: `data:${type};base64,${b64}` } }
  return [{ role: 'user', content: [{ type: 'text', text: CONSIGNE }, doc] }]
}

// Au moins un champ utile : comme lib/charges/lecture.js, un objet tout `null`
// est une lecture qui n'a rien vu.
const CHAMPS_UTILES = ['fournisseur_nom', 'numero_facture', 'date_facture',
  'montant_ht_cents', 'montant_tva_cents', 'montant_ttc_cents']

/** La lecture d'une réponse : { ok, lu } ou { ok: false, motif }. Pure. */
function lectureDeFacture (texte) {
  const brut = extraireJson(texte)
  if (!brut) return { ok: false, motif: 'reponse_illisible' }
  const lu = normaliserLecture(brut)
  if (!CHAMPS_UTILES.some(k => lu[k] !== null)) return { ok: false, motif: 'rien_lu' }
  return { ok: true, lu }
}

module.exports = {
  FONCTION_QUESTION, FONCTION_FACTURE, MAX_QUESTION, MESSAGES_DU_FIL, MAX_CONVERSATIONS,
  MAX_OCTETS_FACTURE, TYPES_FACTURE, PLAFOND_JOUR, MAX_TOKENS_QUESTION, MAX_TOKENS_FACTURE,
  validerQuestion, validerBooking, estUuid, resumerConversations, filDepuisMessages,
  contexteSysteme, messagesQuestion, estimerTokens, validerFichier, messagesFacture,
  lectureDeFacture, CHAMPS_UTILES
}
