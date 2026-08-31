// lib/bookings-snapshot-status.js
// DOC : docs/kb/bookings-snapshot.md (modif = MEME COMMIT)
//
// Vocabulaire de statut canonique, isole dans son propre module pour etre
// partage par le writer (lib/bookings-snapshot.js) et par la detection de
// changements (lib/booking-changes.js) sans cycle d'imports.
// Il reste re-exporte par lib/bookings-snapshot.js : les appelants existants
// n'ont rien a changer.

// ─── Statuts canoniques ──────────────────────────────────────────────────────
// confirmed : réservation réelle, occupe le logement, génère un ménage.
// cancelled : annulée, ne génère rien.
// blocked   : blocage propriétaire / maintenance. Occupe le calendrier, PAS de ménage.
// request   : demande non confirmée. N'occupe rien, PAS de ménage.
const STATUS = {
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  BLOCKED:   'blocked',
  REQUEST:   'request'
}
const ALL_STATUSES = Object.values(STATUS)

// Tables de correspondance. Listes fermées, tirées des API des deux providers.
const BEDS24_STATUS = {
  new:       STATUS.CONFIRMED,   // Beds24 appelle "new" une résa confirmée non encore vue
  confirmed: STATUS.CONFIRMED,
  request:   STATUS.REQUEST,
  inquiry:   STATUS.REQUEST,
  cancelled: STATUS.CANCELLED,
  black:     STATUS.BLOCKED      // blocage propriétaire : source des ménages fantômes
}
const CHANNEX_STATUS = {
  new:       STATUS.CONFIRMED,
  modified:  STATUS.CONFIRMED,
  confirmed: STATUS.CONFIRMED,
  cancelled: STATUS.CANCELLED
}
const STATUS_MAP = { beds24: BEDS24_STATUS, channex: CHANNEX_STATUS }

// Normalise un statut brut provider vers le vocabulaire canonique.
// - valeur vide/absente -> confirmed (comportement historique des 5 writers : `|| 'new'`).
// - valeur déjà canonique -> renvoyée telle quelle (idempotent : re-normaliser une
//   ligne déjà écrite par ce module ne la change pas).
// - valeur inconnue -> confirmed + warn. Choix délibéré : ne pas régresser le
//   comportement actuel (tout ce qui n'est pas 'cancelled' est traité comme actif)
//   sur un cas non spécifié, mais le rendre visible dans les logs.
function canonicalStatus(rawStatus, provider) {
  const raw = String(rawStatus || '').trim().toLowerCase()
  if (!raw) return STATUS.CONFIRMED
  if (ALL_STATUSES.includes(raw)) return raw

  const map = STATUS_MAP[String(provider || '').toLowerCase()] || {}
  if (map[raw]) return map[raw]

  console.warn(`[bookings-snapshot] statut inconnu "${raw}" (provider=${provider}) -> confirmed`)
  return STATUS.CONFIRMED
}

// Statut canonique d'une ligne déjà en base. Tolère les lignes écrites AVANT ce
// module (vocabulaire brut Beds24/Channex) : c'est ce qui évite un backfill SQL.
//
// `defaultProvider` sert aux bookings BRUTS d'un provider, qui ne portent pas de
// champ `provider` (ex. la réponse de l'API Beds24 v2, consommée directement par
// le cron sans passer par bookings_snapshot). Le provider du snapshot reste
// prioritaire : un appelant à source mixte (bookings bruts + snapshots) passe
// simplement le provider de sa source brute.
function readStatus(snapshot, defaultProvider) {
  const snap = snapshot || {}
  return canonicalStatus(snap.status, snap.provider || defaultProvider)
}

// Seul un `confirmed` occupe le logement et donne lieu à un ménage.
function isActiveStatus(snapshot, defaultProvider) {
  return readStatus(snapshot, defaultProvider) === STATUS.CONFIRMED
}

module.exports = {
  STATUS,
  ALL_STATUSES,
  BEDS24_STATUS,
  CHANNEX_STATUS,
  canonicalStatus,
  readStatus,
  isActiveStatus
}
