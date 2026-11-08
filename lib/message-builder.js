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
  remplacerBalises, replisDuBien, prenomNeutre, formatDate, hasUnresolvedCode, UNRESOLVED_CODE
} = require('./balises')

function buildMessage (template, booking, guestName, seamCode, knowledge = {}, property = {}) {
  const text = template.template_text || ''
  if (!text.trim()) return null

  // ⚠ LES REPLIS SONT CEUX DE CE CHEMIN, et ils ne sont pas ceux des messages
  // programmés : ici l'horaire de repli vient de la RÉSERVATION (le provider le
  // porte), là-bas du BIEN. Les passer explicitement est ce qui permet au
  // remplaceur d'être commun sans uniformiser des comportements qui diffèrent
  // pour de bonnes raisons.
  // ⚠ ET L'ADRESSE VIENT DU BIEN, PLUS DE LA BASE (spec Accueil du voyageur) :
  // `adresse` porte `fiche: true`, donc le remplaceur ignore la ligne de la
  // base. Sans les replis du bien, ce chemin — le seul qui envoie le PIN —
  // envoyait « [ADRESSE] » sur tout modele qui la cite, meme fiche remplie
  // (constat BLOQUANT de la review 1 du lot).
  // ⚠ CE QUI RESTE VRAI, ET C'EST UN ECART CONNU, PAS UNE GARANTIE : quand la
  // FICHE est vide, le marqueur part encore. Ce chemin rend une chaine et jette
  // les manquants ; sa seule garde, `hasUnresolvedCode`, ne regarde que le
  // code. Comportement d'avant le lot (base vide = meme marqueur), inscrit au
  // registre des dettes : retenir le PIN ou l'envoyer en prevenant l'hote est
  // une decision de Thierry (review 2 du lot, constat 2).
  const bien = replisDuBien(property)
  const { texte } = remplacerBalises(text, {
    reservation: {
      prenom: booking.firstName, nom: booking.lastName,
      arrivee: booking.arrival, depart: booking.departure,
      logement: booking.propName
    },
    connaissance: knowledge || {},
    replis: {
      ...bien,
      checkin: [booking.checkInStart, ...bien.checkin],
      checkout: [booking.checkOutEnd, ...bien.checkout]
    },
    codeAcces: seamCode
  })
  return texte
}

module.exports = {
  prenomNeutre, buildMessage, formatDate, hasUnresolvedCode, UNRESOLVED_CODE }
