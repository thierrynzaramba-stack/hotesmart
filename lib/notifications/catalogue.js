// lib/notifications/catalogue.js — LES QUATORZE ÉVÉNEMENTS QUI PRÉVIENNENT L'HÔTE.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §3 et §15.2 · KB : docs/kb/pwa.md §9
//
// ⚠ C'EST LA SEULE LISTE. L'écran de `/settings` la reçoit du serveur (GET
// /api/push) au lieu de la recopier : deux copies divergent (règle du dépôt, « le
// mobile suit l'ordinateur »). Le writer des réglages refuse un code absent d'ici.
//
// Pour chaque événement :
//   code    — la clé rangée dans `notifications_reglages.evenements` ; ne se
//             renomme JAMAIS (un code renommé perd le réglage de chacun) ;
//   lettre  — sa lettre dans la spec (§3), pour qu'un lecteur retrouve la ligne ;
//   libelle — ce que l'hôte lit, en français (l'écran `/settings` l'est aussi) ;
//   groupe  — la section de l'écran ;
//   domaine — le domaine de droits qui ouvre l'événement à un membre (§5) ;
//             `null` = titulaire seul (k, la pause automatique) ;
//   ecriture — vrai si le domaine doit être en `write` (a, la surréservation : on
//             ne prévient que ceux qui peuvent l'acquitter) ;
//   urgent  — dans la liste des urgences PAR DÉFAUT (§4, décision Q16 : a, b, h, j).
//
// ⚠ L'ORDRE EST CELUI DE L'ÉCRAN, groupe par groupe.
const EVENEMENTS = Object.freeze([
  { code: 'surreservation', lettre: 'a', groupe: 'reservations', domaine: 'reservations', ecriture: true, urgent: true,
    libelle: 'Surréservation' },
  { code: 'reservation', lettre: 'f', groupe: 'reservations', domaine: 'reservations', ecriture: false, urgent: false,
    libelle: 'Nouvelle réservation (directe ou plateforme)' },
  { code: 'annulation_modification', lettre: 'g', groupe: 'reservations', domaine: 'reservations', ecriture: false, urgent: false,
    libelle: 'Annulation ou modification d’une réservation' },
  { code: 'code_non_resolu', lettre: 'j', groupe: 'reservations', domaine: 'reservations', ecriture: false, urgent: true,
    libelle: 'Code d’accès non résolu' },

  { code: 'urgence_ia', lettre: 'b', groupe: 'messages', domaine: 'messages', ecriture: false, urgent: true,
    libelle: 'Urgence repérée par l’assistant dans un message' },
  { code: 'info_manquante', lettre: 'c', groupe: 'messages', domaine: 'messages', ecriture: false, urgent: false,
    libelle: 'Information manquante demandée par l’assistant' },
  { code: 'brouillon_ia', lettre: 'd', groupe: 'messages', domaine: 'messages', ecriture: false, urgent: false,
    libelle: 'Réponse de l’assistant à valider' },
  { code: 'message_voyageur', lettre: 'e', groupe: 'messages', domaine: 'messages', ecriture: false, urgent: false,
    libelle: 'Nouveau message d’un voyageur' },
  { code: 'pause_automatique', lettre: 'k', groupe: 'messages', domaine: null, ecriture: false, urgent: false,
    libelle: 'Assistant mis en pause automatiquement sur un logement' },

  { code: 'menage_sans_personne', lettre: 'h', groupe: 'menages', domaine: 'menages', ecriture: false, urgent: true,
    libelle: 'Ménage sans personne' },
  { code: 'menage_pas_vu', lettre: 'i', groupe: 'menages', domaine: 'menages', ecriture: false, urgent: false,
    libelle: 'Ménage pas vu par la prestataire la veille' },
  { code: 'menage_refuse', lettre: 'l', groupe: 'menages', domaine: 'menages', ecriture: false, urgent: false,
    libelle: 'Ménage refusé par la prestataire' },
  { code: 'disponibilites_modifiees', lettre: 'm', groupe: 'menages', domaine: 'menages', ecriture: false, urgent: false,
    libelle: 'Disponibilités modifiées par une prestataire' },

  { code: 'avis', lettre: 'n', groupe: 'avis', domaine: 'avis', ecriture: false, urgent: false,
    libelle: 'Nouvel avis' }
].map(Object.freeze))

const GROUPES = Object.freeze([
  Object.freeze({ code: 'reservations', libelle: 'Réservations' }),
  Object.freeze({ code: 'messages', libelle: 'Messages' }),
  Object.freeze({ code: 'menages', libelle: 'Ménages' }),
  Object.freeze({ code: 'avis', libelle: 'Avis' })
])

// Les trois canaux, dans l'ordre des colonnes de l'écran.
const CANAUX = Object.freeze(['push', 'email', 'sms'])

// ⚠ LES CANAUX PAR DÉFAUT (décision Q23 de Thierry, 7 novembre 2026) :
// notification et e-mail cochés, SMS décoché — pour les quatorze. Une personne
// qui n'a jamais rien enregistré reçoit exactement ça.
const CANAUX_PAR_DEFAUT = Object.freeze({ push: true, email: true, sms: false })

const PAR_CODE = new Map(EVENEMENTS.map(e => [e.code, e]))

function evenement (code) {
  return PAR_CODE.get(code) || null
}

// Le réglage par défaut d'un événement : les canaux de Q23, et « urgent » selon
// la liste par défaut.
function reglageParDefaut (code) {
  const e = evenement(code)
  if (!e) return null
  return { ...CANAUX_PAR_DEFAUT, urgent: e.urgent }
}

module.exports = {
  EVENEMENTS,
  GROUPES,
  CANAUX,
  CANAUX_PAR_DEFAUT,
  evenement,
  reglageParDefaut
}
