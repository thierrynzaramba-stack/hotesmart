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

// ⚠ LES MANQUANTS NE SONT PLUS JETES (dette 137, decision de Thierry du
// 9 novembre 2026, option a). Le message du code part quand meme — sans lui la
// porte reste fermee — mais l'appelant doit savoir qu'il part avec un trou pour
// prevenir l'hote. `buildMessage` garde son contrat (une chaine) pour ses
// lecteurs ; `buildMessageDetaille` rend aussi ce qui manque, et les balises
// inconnues du modele.
function buildMessageDetaille (template, booking, guestName, seamCode, knowledge = {}, property = {}) {
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
  // ⚠ QUAND LA FICHE EST VIDE, LE MARQUEUR PART ENCORE, ET C'EST VOULU
  // (dette 137, option a) : le code n'est pas retenu pour une adresse, mais
  // `buildMessageDetaille` rend les manquants et `sendArrivalMessage` previent
  // l'hote. La garde `hasUnresolvedCode` ne regarde toujours que le code.
  // ⚠ DU BIEN, L'ADRESSE SEULE (review finale du lot, constat 2). Les horaires
  // restent ceux d'avant le lot : la RESERVATION, puis la base, puis le
  // defaut. La fenetre de validite du code (`cron-arrival-code.js`,
  // `cron-access.js`) ne lit que la base pour l'heure de depart : prendre ici
  // l'heure synchronisee du bien (Beds24 `checkOutEnd`) aurait annonce, dans
  // le message qui porte le PIN, un depart APRES l'expiration de ce PIN. Et
  // pas de telephone de repli non plus : ce chemin n'en avait pas.
  const { texte, manquants, inconnues } = remplacerBalises(text, {
    reservation: {
      prenom: booking.firstName, nom: booking.lastName,
      arrivee: booking.arrival, depart: booking.departure,
      logement: booking.propName
    },
    connaissance: knowledge || {},
    replis: {
      adresse: replisDuBien(property).adresse,
      checkin: booking.checkInStart,
      checkout: booking.checkOutEnd
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
