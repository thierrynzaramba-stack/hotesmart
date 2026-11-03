// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — LE remplaceur de balises, et il n'y en a qu'un
//
// Chantier « Base de connaissance V5 », lot 1.
// Spec : docs/specs/spec-base-connaissance-v5.md
//
// ⚠ POURQUOI CE FICHIER EXISTE. Le remplacement vivait en DEUX copies :
// `lib/message-builder.js` (codes d'acces, app menage) et
// `lib/cron-messages.js` (messages programmes). Elles avaient DEJA diverge, et
// l'ecart mordait sur un envoi au voyageur :
//
//   · `cron-messages` ne lisait JAMAIS la base pour `{wifi_nom}` et
//     `{wifi_mdp}` — il posait le marqueur en toutes circonstances, et comme
//     ces deux balises n'entraient pas dans les « manquants », le message
//     partait au voyageur avec « [WIFI NOM] » en clair. Latent aujourd'hui
//     (aucun des onze modeles de production ne les utilise), reel demain.
//   · `{logement}` venait de `booking.propName` d'un cote, de `property.name`
//     de l'autre ; `{adresse}` et `{telephone_hote}` avaient un repli provider
//     d'un cote seulement.
//
// La V5 ajoute un TROISIEME usage — les reponses pretes, cote hote et cote IA.
// Une troisieme copie aurait diverge a son tour : c'est pour ca que le lot 1
// vient AVANT l'ecran.
//
// ⚠ CE MODULE NE DECIDE PAS DE BLOQUER. Il REND ce qu'il a constate
// (`manquants`, `inconnues`) et chaque appelant garde sa politique, parce
// qu'elles sont legitimement differentes : les messages programmes refusent
// d'envoyer et alertent l'hote, le code d'acces a sa propre garde
// (`hasUnresolvedCode`), et l'ecran, lui, affichera une etiquette rouge.
// Unifier les politiques ici aurait change des comportements en production
// sous couvert de refactor.
// ═══════════════════════════════════════════════════════════════════════════

// Sentinelle posee quand le code de la serrure est indisponible (PIN null).
const UNRESOLVED_CODE = '[CODE À INSÉRER]'

// ⚠ UNE BALISE RESTEE DANS LE TEXTE est une variable que personne ne connait :
// le modele la porte, la substitution ne l'a pas vue. Meme motif qu'avant le
// lot (lib/cron-messages.js), garde a l'identique.
const VARIABLE = /\{[\p{L}\p{N}_ ]{1,40}\}/u
const VARIABLES = /\{[\p{L}\p{N}_ ]{1,40}\}/gu

// ⚠ LA LISTE FAIT FOI, ET ELLE PORTE L'ORIGINE DE CHAQUE VALEUR.
// `etiquette` est ce que l'ecran V5 montre a la place de `{…}` (direction du
// 3 novembre 2026 : jamais d'accolades sous les yeux de l'hote).
// `ou` dit OU la remplir, et c'est ce que lit l'alerte « info manquante ».
const BALISES = {
  prenom:   { origine: 'reservation', etiquette: 'Prénom' },
  nom:      { origine: 'reservation', etiquette: 'Nom' },
  arrivee:  { origine: 'reservation', etiquette: "Date d'arrivée" },
  depart:   { origine: 'reservation', etiquette: 'Date de départ' },
  logement: { origine: 'reservation', etiquette: 'Logement' },

  // ⚠ CES DEUX-LA ONT UN DEFAUT RAISONNABLE, donc ni marqueur ni alerte : un
  // bien sans horaire regle garde l'horaire usuel, et c'est un fait, pas un
  // trou. La convention « marqueur plutot que blanc » ne vaut que pour ce qui
  // n'a aucun defaut acceptable.
  checkin:  { origine: 'base', etiquette: "Heure d'arrivée", defaut: '18:00',
              ou: 'Base de connaissance → Infos du logement → Heure d’arrivée' },
  checkout: { origine: 'base', etiquette: 'Heure de départ', defaut: '10:00',
              ou: 'Base de connaissance → Infos du logement → Heure de départ' },

  adresse:        { origine: 'base', etiquette: 'Adresse', marqueur: '[ADRESSE]',
                    ou: 'Base de connaissance → Infos du logement → Adresse' },
  telephone_hote: { origine: 'base', etiquette: 'Téléphone', marqueur: '[TÉLÉPHONE HÔTE]',
                    ou: 'Base de connaissance → Infos du logement → Téléphone' },
  wifi_nom:       { origine: 'base', etiquette: 'Nom wifi', marqueur: '[WIFI NOM]',
                    ou: 'Base de connaissance → Infos du logement → Nom wifi' },
  wifi_mdp:       { origine: 'base', etiquette: 'Mot de passe wifi', marqueur: '[WIFI MOT DE PASSE]',
                    ou: 'Base de connaissance → Infos du logement → Mot de passe wifi' },

  // ⚠ LE CODE N'ENTRE JAMAIS DANS `manquants`, ET C'EST VOLONTAIRE. Son absence
  // est NORMALE au moment ou un message programme est bati (la serrure n'a pas
  // encore genere le code) : l'ajouter aux manquants ferait refuser des modeles
  // qui partent aujourd'hui. Sa garde est ailleurs, et elle est plus forte :
  // `hasUnresolvedCode` refuse l'ENVOI, cote serrure.
  code_acces:     { origine: 'serrure', etiquette: "Code d'accès", marqueur: UNRESOLVED_CODE }
}

const DE_LA_BASE = Object.keys(BALISES).filter(c => BALISES[c].origine === 'base')

// ⚠ LES DEUX CHEMINS NE FORMATENT PAS LES DATES PAREIL, ET LE LOT NE TRANCHE
// PAS. Le code d'acces rend « dimanche 2 novembre » (ce fichier), les messages
// programmes « 02 novembre 2026 » (`formatDate` de lib/cron-shared.js). Mesure
// du 3 novembre 2026 : imposer l'un des deux a tout le monde changeait le texte
// recu par le voyageur dans tous les messages portant `{arrivee}` — et ce lot
// promet « rien de visible ». Le format est donc INJECTE par l'appelant, la
// divergence reste visible ici, et c'est une question produit pour Thierry.
function formatDate (dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d)) return dateStr
  const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
  const mois  = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre']
  return `${jours[d.getDay()]} ${d.getDate()} ${mois[d.getMonth()]}`
}

// ⚠ UN PRENOM MANQUANT NE PART JAMAIS EN CLAIR NI EN « Voyageur » (decision de
// Thierry, 8 octobre 2026). Avec prenom : remplace. Sans : « Bonjour {prenom}, »
// donne « Bonjour, » ; « {prenom}, bienvenue » en tete de ligne donne
// « Bienvenue ».
function prenomNeutre (text, firstName) {
  const prenom = String(firstName || '').trim()
  if (prenom) return text.replace(/{prenom}/g, prenom)
  return text
    .replace(/^([ \t]*){prenom}[ \t]*,?[ \t]*(\S)/gm, (m, debut, c) => debut + c.toUpperCase())
    .replace(/[ \t]*{prenom}/g, '')
}

/**
 * Remplace les balises d'un texte. NE BLOQUE RIEN : rend ce qu'il a constate.
 *
 * @param {string} texte
 * @param {object} ctx
 *   @param {object} ctx.reservation  { prenom, nom, arrivee, depart, logement }
 *   @param {object} ctx.connaissance valeurs de la base (prioritaires)
 *   @param {object} ctx.replis       repli par balise quand la base est muette
 *                                    (valeurs du provider), facultatif
 *   @param {string} ctx.codeAcces    code de la serrure, ou null
 *   @param {function} ctx.formatDate formateur de date de CE chemin ; sans lui,
 *                                    la forme longue « dimanche 2 novembre »
 * @returns {{texte: string, manquants: string[], inconnues: string[]}}
 *   `manquants` : balises UTILISEES par le texte, sans valeur et sans defaut.
 *   `inconnues` : accolades restees dans le texte apres substitution.
 */
function remplacerBalises (texte, ctx = {}) {
  const src = String(texte == null ? '' : texte)
  const r = ctx.reservation || {}
  const k = ctx.connaissance || {}
  const replis = ctx.replis || {}
  const manquants = []
  // Le format de date de CE chemin (voir la note au-dessus de `formatDate`).
  const dateDe = typeof ctx.formatDate === 'function' ? ctx.formatDate : formatDate

  // ⚠ ON NE SIGNALE QUE CE QUE LE TEXTE DEMANDE. Constat de review d'un lot
  // precedent : evaluer les quatre valeurs inconditionnellement poussait
  // `adresse` et `telephone_hote` dans les manquants d'un modele qui ne les
  // utilise pas — un avertissement par message, par bien, toutes les 5 minutes.
  const utilise = (cle) => src.includes(`{${cle}}`)
  const propre = (v) => (v != null && String(v).trim() ? String(v).trim() : null)

  const valeurDeLaBase = (cle) => {
    const def = BALISES[cle]
    const trouve = propre(k[cle]) || propre(replis[cle])
    if (trouve) return trouve
    if (def.defaut) return def.defaut
    if (utilise(cle)) manquants.push(cle)
    return def.marqueur
  }

  let out = prenomNeutre(src, r.prenom)
    .replace(/{nom}/g,      r.nom || '')
    .replace(/{arrivee}/g,  dateDe(r.arrivee))
    .replace(/{depart}/g,   dateDe(r.depart))
    .replace(/{logement}/g, r.logement || '')

  for (const cle of DE_LA_BASE) {
    out = out.replace(new RegExp(`\\{${cle}\\}`, 'g'), valeurDeLaBase(cle))
  }
  out = out.replace(/{code_acces}/g, propre(ctx.codeAcces) || UNRESOLVED_CODE)

  const inconnues = [...new Set(out.match(VARIABLES) || [])]
  return { texte: out, manquants, inconnues }
}

// Un message ne doit JAMAIS partir au voyageur avec un code non resolu. Couvre
// les deux formes : le placeholder brut `{code_acces}` (modele non rendu) et la
// sentinelle posee quand le PIN de la serrure est null.
function hasUnresolvedCode (message) {
  if (!message) return false
  return message.includes(UNRESOLVED_CODE) || /\{code_acces\}/.test(message)
}

// Ou l'hote remplit une information manquante — lu par l'alerte « info
// manquante ». Derive de BALISES, jamais recopie : une table ecrite a la main
// se desynchronise de la liste qu'elle decrit.
const OU_REMPLIR = Object.fromEntries(
  Object.entries(BALISES).filter(([, d]) => d.ou).map(([cle, d]) => [cle, d.ou]))

// L'etiquette lisible d'une balise, pour l'ecran V5 (lot 3) : jamais `{…}`.
const etiquetteDe = (cle) => (BALISES[cle] && BALISES[cle].etiquette) || cle

module.exports = {
  BALISES, DE_LA_BASE, OU_REMPLIR, UNRESOLVED_CODE, VARIABLE, VARIABLES,
  remplacerBalises, prenomNeutre, formatDate, hasUnresolvedCode, etiquetteDe
}
