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
  remplacerBalises, replisDuBien, heureDeLaFiche, prenomNeutre, formatDate, hasUnresolvedCode, UNRESOLVED_CODE
} = require('./balises')

// ⚠ LES MANQUANTS NE SONT PLUS JETES (dette 137, decision de Thierry du
// 9 novembre 2026, option a). Le message du code part quand meme — sans lui la
// porte reste fermee — mais l'appelant doit savoir qu'il part avec un trou pour
// prevenir l'hote. `buildMessage` garde son contrat (une chaine) pour ses
// lecteurs ; `buildMessageDetaille` rend aussi ce qui manque, et les balises
// inconnues du modele.
function buildMessageDetaille (template, booking, guestName, seamCode, knowledge = {}, property = {}) {
  const text = template.template_text || ''
  if (!text.trim()) return null

  // ⚠ LES REPLIS SONT PASSÉS EXPLICITEMENT : ce chemin n'a pas de téléphone de
  // repli, contrairement aux messages programmés. Les horaires, eux, sont ceux
  // du BIEN comme partout depuis la spec heures-logement (ils venaient de la
  // RÉSERVATION avant le 22 novembre 2026).
  // ⚠ ET L'ADRESSE VIENT DU BIEN, PLUS DE LA BASE (spec Accueil du voyageur) :
  // `adresse` porte `fiche: true`, donc le remplaceur ignore la ligne de la
  // base. Sans les replis du bien, ce chemin — le seul qui envoie le PIN —
  // envoyait « [ADRESSE] » sur tout modele qui la cite, meme fiche remplie
  // (constat BLOQUANT de la review 1 du lot).
  // ⚠ QUAND LA FICHE EST VIDE, LE MARQUEUR PART ENCORE, ET C'EST VOULU
  // (dette 137, option a) : le code n'est pas retenu pour une adresse, mais
  // `buildMessageDetaille` rend les manquants et `sendArrivalMessage` previent
  // l'hote. La garde `hasUnresolvedCode` ne regarde toujours que le code.
  // ⚠ DU BIEN, L'ADRESSE ET LES HEURES DE LA FICHE (spec heures-logement,
  // S2 et S3, decision de Thierry du 22 novembre 2026). Les heures vivent dans
  // la fiche (`checkin` / `checkout` portent `fiche: true`) : la base n'en
  // porte plus, et la reservation non plus — un `checkInStart` du partenaire
  // passait devant l'heure saisie par l'hote. La fenetre de validite du code
  // (`cron-arrival-code.js`, `cron-access.js`) lit la MEME heure de depart,
  // par la MEME fonction (`heureDeLaFiche`) : le message qui porte le PIN
  // n'annonce jamais un depart apres l'expiration de ce PIN. Et pas de
  // telephone de repli : ce chemin n'en avait pas.
  const { texte, manquants, inconnues } = remplacerBalises(text, {
    reservation: {
      prenom: booking.firstName, nom: booking.lastName,
      arrivee: booking.arrival, depart: booking.departure,
      logement: booking.propName
    },
    connaissance: knowledge || {},
    replis: {
      adresse: replisDuBien(property).adresse,
      checkin: heureDeLaFiche(property, 'checkin'),
      checkout: heureDeLaFiche(property, 'checkout')
    },
    codeAcces: seamCode
  })
  // `inconnues` aussi (review 1 du lot, constat 5) : une balise que le
  // remplaceur ne connait pas part en clair avec le PIN ; l'hote doit le savoir.
  return { texte, manquants, inconnues }
}

function buildMessage (...args) {
  const r = buildMessageDetaille(...args)
  return r ? r.texte : null
}

module.exports = {
  prenomNeutre, buildMessage, buildMessageDetaille, formatDate, hasUnresolvedCode, UNRESOLVED_CODE }
