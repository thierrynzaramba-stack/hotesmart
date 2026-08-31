// lib/booking-changes.js
// DOC : docs/kb/booking-changes.md (modif = MEME COMMIT)
//
// Detection NEUTRE des changements de reservation. Ne connait aucun provider,
// n'ecrit rien, ne declenche aucun effet : elle compare deux snapshots et dit
// quel evenement en decoule. Les consommateurs (menages, codes d'acces,
// templates) sont branches par lib/booking-changes-dispatch.js.
//
// Appelee par le writer unique (lib/bookings-snapshot.js) au seul moment ou
// l'existant et l'entrant coexistent : juste avant l'upsert. Le snapshot reste
// l'unique memoire d'etat — aucune table miroir a maintenir.

const { STATUS, readStatus } = require('./bookings-snapshot-status')

// ─── Comparaison tolerante ───────────────────────────────────────────────────
// Reprises telles quelles de lib/cron-bookings.js. `numEq` ecrase la distinction
// null / undefined / 0 : c'est ce qui a neutralise les 79 350 faux menage_events
// (un writer ecrivait `0 || null` -> null, l'autre 0 ; chaque cycle rejugeait le
// booking "modifie" en boucle). Un passage reel de "0 enfant" a "information
// absente" ne produit donc aucun evenement — compromis assume : un faux positif
// coute un deplacement inutile a la femme de menage.
function numEq(a, b) { return Number(a || 0) === Number(b || 0) }
function strEq(a, b) { return (a || '') === (b || '') }

// Les QUATRE champs qui declenchent un 'modified'. Le statut est traite a part ;
// le nom du voyageur, la source OTA et le montant ne declenchent rien.
const DIFF_FIELDS = [
  { key: 'arrival',   eq: strEq },
  { key: 'departure', eq: strEq },
  { key: 'numAdult',  eq: numEq },
  { key: 'numChild',  eq: numEq }
]

function diffFields(prev, next) {
  const changes = {}
  let any = false
  for (const { key, eq } of DIFF_FIELDS) {
    if (eq(prev[key], next[key])) { changes[key] = null; continue }
    changes[key] = { before: prev[key] ?? null, after: next[key] ?? null }
    any = true
  }
  return any ? changes : null
}

// ─── Regle de typage ─────────────────────────────────────────────────────────
// Un seul evenement par booking et par ecriture. Renvoie null quand il n'y a
// rien a signaler.
//
//   pas d'existant + confirmed                      -> new
//   existant non-confirmed -> confirmed              -> new   (ex. request -> confirmed)
//   existant confirmed -> cancelled | blocked | request -> cancelled
//   existant confirmed, statut inchange, 1 des 4 champs bouge -> modified
//   request / blocked sans transition vers confirmed -> aucun evenement (E5)
//
// `defaultProvider` : les lignes anterieures a l'unification n'ont pas de champ
// provider (cf. docs/kb/bookings-snapshot.md).
function detectChange(previous, incoming, defaultProvider) {
  const next = incoming || {}
  const nextStatus = readStatus(next, defaultProvider)

  // Premiere apparition du booking.
  if (!previous) {
    return nextStatus === STATUS.CONFIRMED
      ? { type: 'new', changes: null }
      : null              // une demande ou un blocage jamais vu ne notifie personne
  }

  const prev = previous
  const prevStatus = readStatus(prev, defaultProvider)

  // Entree en reservation reelle : c'est une nouveaute pour les prestataires,
  // meme si le booking existait deja en base sous un autre statut.
  if (prevStatus !== STATUS.CONFIRMED && nextStatus === STATUS.CONFIRMED) {
    return { type: 'new', changes: null }
  }

  // Sortie de reservation reelle : le menage n'a plus lieu d'etre, quelle que
  // soit la raison (annulation, blocage proprietaire, retour en demande).
  if (prevStatus === STATUS.CONFIRMED && nextStatus !== STATUS.CONFIRMED) {
    return { type: 'cancelled', changes: null }
  }

  // Hors reservation reelle des deux cotes : rien a signaler.
  if (nextStatus !== STATUS.CONFIRMED) return null

  // Reservation reelle inchangee : seuls les quatre champs comptent.
  const changes = diffFields(prev, next)
  return changes ? { type: 'modified', changes } : null
}

module.exports = { detectChange, diffFields, numEq, strEq, DIFF_FIELDS }
