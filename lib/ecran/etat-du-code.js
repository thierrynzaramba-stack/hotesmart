// lib/ecran/etat-du-code.js
// L'ETAT DU CODE D'ACCES D'UNE ARRIVEE — un seul verdict, deux appelants.
//
// ⚠ POURQUOI CE MODULE EXISTE. `pages/aujourdhui.html` appelle
// `GET /api/messages` pour UN SEUL champ : `arrivee.codeEtat`. Mesure du
// 22 octobre 2026 contre la production, compte reel : cet appel coute
// 18 requetes et 437 212 OCTETS — 42 % du poids de l'ecran d'accueil — parce
// qu'il assemble TOUS les fils de messagerie du compte pour qu'on en lise
// l'etat du code de deux arrivees.
//
// ⚠ ET CE N'EST PAS UN DEFAUT DE `api/messages.js`, QUI SERT LA MESSAGERIE.
// C'est un ecran qui appelle l'endpoint d'un AUTRE ecran. La spec performance
// l'interdit explicitement au lot (b) : « il ne doit pas appeler
// /api/messages ».
//
// ⚠ LE VERDICT NE BOUGE PAS D'UN IOTA, et c'est tout l'objet de l'extraction.
// `api/messages.js` appelle desormais cette fonction avec les donnees qu'il a
// deja ; l'endpoint d'ecran l'appelle avec une lecture BORNEE aux arrivees du
// jour et du lendemain. Deux entrees, une seule regle. La recopier aurait fait
// deux regles qui divergent au premier correctif — le defaut que ce depot a
// paye sur le balisage des compteurs de proprete, sur les templates, et sur
// les deux calendriers.

// ⚠ LE SET VIENT DE `api/messages.js`, AU CARACTERE, ET J'AI FAILLI LE
// REECRIRE. Ma premiere version de ce module en avait invente un autre
// (`canceled`, `annule`, `annulee`, `declined`) — ce qui aurait fait traiter
// une demande (`request`, `inquiry`) comme une arrivee, et change le verdict
// que l'extraction avait pour but de preserver. Une extraction qui modifie la
// regle est pire que pas d'extraction : elle la modifie SANS QUE PERSONNE NE
// L'AIT DECIDE.
// `api/messages.js` l'importe desormais d'ici : une seule definition.
const STATUTS_SANS_ARRIVEE = new Set(['cancelled', 'demapped', 'request', 'blocked', 'inquiry', 'black'])

/**
 * Les arrivees PROCHES : aujourd'hui ou demain, et pas annulees.
 *
 * ⚠ `jourParis` est INJECTE, pas importe : les deux appelants n'ont pas la
 * meme horloge sous la main, et un module qui lit l'heure lui-meme ne se teste
 * qu'a dates figees — ce que la regle du depot interdit.
 */
function arriveesProches (conversations, jourParis) {
  const aujourdHui = jourParis(0)
  const demain = jourParis(1)
  return (conversations || []).filter(c => {
    const st = String(c.status || '').toLowerCase()
    const arr = String(c.firstNight || '').slice(0, 10)
    return arr && st && !STATUTS_SANS_ARRIVEE.has(st) && (arr === aujourdHui || arr === demain)
  })
}

/**
 * LE VERDICT, pour une arrivee et sa ligne `access_codes`.
 *
 * ⚠ PREUVE STRICTE, ET C'EST LA MOITIE QUI COMPTE. « transmis » exige le code
 * ENTIER, borne par des non-chiffres, dans un message SORTANT posterieur a la
 * creation de ce code. Un numero de telephone qui contient la suite, ou un
 * prix, ne vaut pas un code envoye — et un message anterieur au code parle
 * forcement d'autre chose.
 *
 * Pur : aucune lecture, aucune horloge. Il se teste cas par cas.
 */
function verdictDuCode (ligneCode, messages) {
  const code = ligneCode && ligneCode.code ? String(ligneCode.code).replace(/\D/g, '') : ''
  if (!code) return ligneCode ? 'cree' : 'aucun'
  const motif = new RegExp(`(^|\\D)${code}(\\D|$)`)
  const depuis = ligneCode.created_at ? new Date(ligneCode.created_at).getTime() : 0
  const transmis = (messages || []).some(m => m.direction === 'outbound' &&
    new Date(m.sent_at).getTime() >= depuis && motif.test(String(m.body || '')))
  return transmis ? 'transmis' : 'cree'
}

/**
 * La ligne `access_codes` retenue, par (bien, reservation).
 *
 * ⚠ CLE COMPOSITE, et ce n'est pas un detail : un identifiant Beds24 n'est
 * unique QUE par bien. Et jamais une ligne 'deleted' — elle garde son code.
 * La plus recente d'abord : une reservation en a souvent plusieurs apres un
 * changement de serrure.
 */
function codesParReservation (lignes) {
  const out = {}
  for (const r of lignes || []) {
    const k = `${r.property_id}|${r.booking_id}`
    if (!out[k]) out[k] = r
  }
  return out
}

/**
 * Lit les lignes `access_codes` des reservations demandees.
 *
 * ⚠ LA LISTE VIDE NE DOIT PAS PARTIR EN REQUETE. `.in('booking_id', [])` rend
 * zero ligne, mais c'est un aller-retour pour rien — et sur l'ecran d'accueil
 * d'un hote sans arrivee du jour, c'est le cas COURANT.
 */
async function lireLesCodes (sb, bookIds) {
  const ids = [...new Set((bookIds || []).map(String))].filter(Boolean)
  if (!ids.length) return { lignes: [], erreur: null }
  const { data, error } = await sb
    .from('access_codes')
    .select('booking_id, property_id, code, status, created_at')
    .in('booking_id', ids)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false })
  if (error) return { lignes: [], erreur: error.message }
  return { lignes: data || [], erreur: null }
}

module.exports = {
  STATUTS_SANS_ARRIVEE,
  arriveesProches,
  verdictDuCode,
  codesParReservation,
  lireLesCodes
}
