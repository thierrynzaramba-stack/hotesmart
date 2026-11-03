// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Message builder partagé
// Bâtit le message d'un modèle pour le chemin du CODE D'ACCÈS.
// ⚠ UN SEUL IMPORTEUR DE PRODUCTION, et je l'ai mesuré au lieu de recopier :
// `lib/cron-arrival-code.js:34`. L'en-tête d'avant annonçait aussi
// `api/menages-public.js`, qui ne l'importe pas — une affirmation fausse
// héritée, qu'un en-tête neuf n'avait aucune raison de reconduire.
//
// ⚠ LE REMPLACEMENT N'EST PLUS ICI. Il vit dans `lib/balises.js`, seul
// remplaceur du dépôt depuis le lot 1 du chantier « Base de connaissance V5 » :
// ce fichier en portait une copie, `lib/cron-messages.js` l'autre, et les deux
// avaient déjà divergé sur le wifi, le logement et les replis provider. Ce qui
// reste ici est ce qui est PROPRE à ce chemin : la forme du contexte, et le
// fait qu'on rende une chaîne (la garde de ce chemin est `hasUnresolvedCode`,
// posée par l'appelant au moment de l'envoi).
// ═══════════════════════════════════════════════════════════════════════════

const {
  remplacerBalises, prenomNeutre, formatDate, hasUnresolvedCode, UNRESOLVED_CODE
} = require('./balises')

function buildMessage (template, booking, guestName, seamCode, knowledge = {}) {
  const text = template.template_text || ''
  if (!text.trim()) return null

  // ⚠ LES REPLIS SONT CEUX DE CE CHEMIN, et ils ne sont pas ceux des messages
  // programmés : ici l'horaire de repli vient de la RÉSERVATION (le provider le
  // porte), là-bas du BIEN. Les passer explicitement est ce qui permet au
  // remplaceur d'être commun sans uniformiser des comportements qui diffèrent
  // pour de bonnes raisons.
  const { texte } = remplacerBalises(text, {
    reservation: {
      prenom: booking.firstName, nom: booking.lastName,
      arrivee: booking.arrival, depart: booking.departure,
      logement: booking.propName
    },
    connaissance: knowledge || {},
    replis: { checkin: booking.checkInStart, checkout: booking.checkOutEnd },
    codeAcces: seamCode
  })
  return texte
}

module.exports = {
  prenomNeutre, buildMessage, formatDate, hasUnresolvedCode, UNRESOLVED_CODE }
