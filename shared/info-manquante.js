// shared/info-manquante.js — la carte « Information manquante » de Messages.
// Spec : docs/specs/spec-info-manquante-choix.md (étape 1 : A et B).
//
// Ce module ne touche ni au réseau ni au DOM : il décide QUELLE carte montrer,
// QUAND « Rédiger la réponse » devient possible, et CE QUI part au serveur.
// La page (pages/messages.html) fait l'appel et le rendu. Séparés pour que les
// règles qui comptent — une carte périmée, une précision oubliée, des choix
// pris sur d'anciennes questions — se testent sans navigateur.
//
// ⚠ LES QUESTIONS VIENNENT DU SERVEUR, DÉJÀ TRIÉES : `GET /api/messages?direct=1`
// rend `infos: [{ id, book_id, property_id, created_at, maj, questions }]`,
// sans la note interne (`suggested_reply`) et sans les tâches système (pause,
// arrêt de l'agent). Ce module ne refait pas ce tri : il n'en a pas les moyens.

// Copies tenues par un test contre lib/guestflow/rediger.js : le serveur
// refuse ce que le client laisserait passer, mais un écart se voit en rouge.
export const REPONSES = Object.freeze(['oui', 'non', 'autre'])
export const MAX_PRECISION = 300
export const MAX_BROUILLON = 4000

const momentInfo = (x) => { const t = new Date(x).getTime(); return Number.isFinite(t) ? t : null }

/**
 * La carte à montrer sous le fil, ou `null`.
 * La plus RÉCENTE des tâches servies, et seulement si l'hôte n'a pas répondu
 * depuis : le cron ne clôt jamais une tâche `pending` quand l'hôte répond à la
 * main, donc une tâche ouverte n'est pas forcément une question en attente.
 * Vaut réponse : un message SORTANT qui n'est pas un message automatique
 * (modèle) — la même règle que la proposition (`api/guestflow-proposer.js`).
 */
export function infoAAfficher (infos, messages) {
  const liste = (Array.isArray(infos) ? infos : [])
    .filter(x => x && x.id != null && Array.isArray(x.questions) && x.questions.length && momentInfo(x.maj || x.created_at) != null)
  if (!liste.length) return null
  const plusRecente = liste.reduce((a, b) => momentInfo(b.maj || b.created_at) > momentInfo(a.maj || a.created_at) ? b : a)
  const depuis = momentInfo(plusRecente.maj || plusRecente.created_at)
  const repondu = (Array.isArray(messages) ? messages : []).some(m =>
    m && m.direction === 'outbound' && m.kind !== 'auto' && momentInfo(m.sent_at) != null && momentInfo(m.sent_at) > depuis)
  return repondu ? null : plusRecente
}

/** L'état de la carte à son ouverture : aucune réponse choisie. */
export function etatInitial (info) {
  return {
    tacheId: info ? String(info.id) : null,
    questions: info ? info.questions.slice() : [],
    choix: (info ? info.questions : []).map(() => ({ reponse: null, precision: '' }))
  }
}

/**
 * La même carte, toujours ? Une tâche COMPLÉTÉE par le cron garde son `id`
 * mais change de questions : l'état de l'hôte ne vaut plus, il repart à zéro.
 */
export function memeCarte (etat, info) {
  if (!etat || !info || String(etat.tacheId) !== String(info.id)) return false
  return etat.questions.length === info.questions.length && etat.questions.every((q, i) => q === info.questions[i])
}

/** Choisir Oui / Non / Autre pour la question `i`. Rend un NOUVEL état. */
export function choisir (etat, i, reponse) {
  if (!REPONSES.includes(reponse) || !etat.choix[i]) return etat
  const choix = etat.choix.map((c, j) => j === i ? { ...c, reponse } : c)
  return { ...etat, choix }
}

/** La précision d'un « Autre », bornée comme au serveur. */
export function preciser (etat, i, texte) {
  if (!etat.choix[i]) return etat
  const precision = String(texte == null ? '' : texte).slice(0, MAX_PRECISION)
  const choix = etat.choix.map((c, j) => j === i ? { ...c, precision } : c)
  return { ...etat, choix }
}

/** « Rédiger la réponse » : chaque question a un choix, et chaque « Autre » sa précision. */
export function pretARediger (etat) {
  return !!(etat && etat.choix.length && etat.choix.every(c =>
    REPONSES.includes(c.reponse) && (c.reponse !== 'autre' || c.precision.trim())))
}

/** Le corps de `POST /api/guestflow-rediger`, action `choix`. */
export function corpsChoix (etat, bookingId) {
  return {
    action: 'choix',
    bookingId: String(bookingId),
    tacheId: etat.tacheId,
    choix: etat.choix.map((c, i) => c.reponse === 'autre'
      ? { question: etat.questions[i], reponse: c.reponse, precision: c.precision.trim() }
      : { question: etat.questions[i], reponse: c.reponse })
  }
}

/** Le bouton « IA » n'apparaît que si du texte est tapé. */
export function iaPossible (brouillon) {
  const b = String(brouillon == null ? '' : brouillon).trim()
  return b.length > 0 && b.length <= MAX_BROUILLON
}

/** Le corps de `POST /api/guestflow-rediger`, action `texte`. */
export function corpsTexte (bookingId, brouillon) {
  return { action: 'texte', bookingId: String(bookingId), brouillon: String(brouillon || '').trim() }
}

// Chaque refus du serveur a sa phrase (clés i18n `messages.info.erreur.*`).
// Une erreur inconnue retombe sur « réessayez » : jamais un écran muet.
const CLES_ERREUR = {
  en_pause: 'en_pause',
  garde_ia: 'garde_ia',
  ia_indisponible: 'ia_indisponible',
  deja_traitee: 'deja_traitee',
  sans_question: 'deja_traitee',
  questions_changees: 'questions_changees',
  deja_close: 'deja_traitee'
}
export function cleErreur (code) {
  return 'messages.info.erreur.' + (CLES_ERREUR[code] || 'autre')
}

/**
 * Après un refus, faut-il RELIRE la carte ? Oui quand la tâche a bougé
 * ailleurs (traitée, complétée) : la garder à l'écran inviterait à répondre
 * à une question qui n'est plus celle-là.
 */
export function relireApres (code) {
  return code === 'deja_traitee' || code === 'sans_question' || code === 'questions_changees' || code === 'deja_close'
}
