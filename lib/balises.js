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
// (`manquants`, `inconnues`, `codeNonResolu`) et chaque appelant garde sa
// politique, parce qu'elles sont legitimement differentes : les messages
// programmes refusent d'envoyer et alertent l'hote, le chemin de la serrure a
// sa propre garde (`hasUnresolvedCode`), et l'ecran affichera une etiquette
// rouge. ⚠ C'est ce partage qui a ete mal applique une fois : la premiere
// version du lot 1b a fait entrer le code dans `manquants`, donc le module
// decidait de bloquer — et il bloquait la GENERATION, pas l'envoi.
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
              ou: 'GuestFlow → Base de connaissance → Heure de check-in' },
  checkout: { origine: 'base', etiquette: 'Heure de départ', defaut: '10:00',
              ou: 'GuestFlow → Base de connaissance → Heure de check-out' },

  adresse:        { origine: 'base', etiquette: 'Adresse', marqueur: '[ADRESSE]',
                    ou: 'GuestFlow → Base de connaissance → Adresse' },
  telephone_hote: { origine: 'base', etiquette: 'Téléphone', marqueur: '[TÉLÉPHONE HÔTE]',
                    ou: 'GuestFlow → Base de connaissance → Téléphone hôte' },
  wifi_nom:       { origine: 'base', etiquette: 'Nom wifi', marqueur: '[WIFI NOM]',
                    ou: 'GuestFlow → Base de connaissance → Nom wifi' },
  wifi_mdp:       { origine: 'base', etiquette: 'Mot de passe wifi', marqueur: '[WIFI MOT DE PASSE]',
                    ou: 'GuestFlow → Base de connaissance → Mot de passe wifi' },

  // ⚠ LE CODE N'ENTRE PAS DANS `manquants` — il a son propre drapeau,
  // `codeNonResolu`, et la raison est dans le corps de `remplacerBalises` : un
  // manque fait refuser la GENERATION, et refuser de generer ferme aussi la
  // proposition que l'hote complete a la main. Pour le code, c'est la seule
  // issue qui existe.
  //
  // ⚠ LA GARDE COUVRE DESORMAIS TOUS LES CHEMINS (decision de Thierry du
  // 3 novembre 2026, lot 1b), mais elle refuse l'ENVOI, pas la preparation.
  // Avant, elle n'existait qu'a un endroit du depot
  // (`lib/cron-arrival-code.js:560`) : un modele d'arrivee portant
  // `{code_acces}` envoyait « [CODE À INSÉRER] » en clair au voyageur, apres
  // etre passe par Haiku. Mesure du 3 novembre : aucun modele de production de
  // type `arrival`, `departure` ou `booking_confirmed` ne le porte — les deux
  // qui le portent sont `menage_done`, envoyes par le chemin serrure, qui
  // FOURNIT le code. Rien ne change donc aujourd'hui.
  // ⚠ PAS DE `ou` ICI, ET C'EST MESURE : `prevenirManque` l'insere dans
  // « A renseigner dans ${ou}. Le message repartira au prochain cycle une fois
  // l'information saisie. » — une phrase agrammaticale et FAUSSE pour un code,
  // puisque rien ne se saisit nulle part et qu'un `booking_confirmed` est
  // one-shot : le message n'est pas en attente, il est perdu. Le code ne passe
  // donc pas par ce gabarit.
  code_acces:     { origine: 'serrure', etiquette: "Code d'accès", marqueur: UNRESOLVED_CODE }
}

// ⚠ « OU LE REMPLIR » DOIT ETRE VRAI AUJOURD'HUI, PAS APRES LE LOT 3, ET LES
// LIBELLES SONT CEUX QUE L'ECRAN PORTE — mesures dans
// `apps/agent-ai/knowledge.html`, qui dit « Heure de check-in » et « Heure de
// check-out », pas « Heure d'arrivee ». Deux fois de suite j'ai ecrit un chemin
// plausible au lieu d'aller le lire : la premiere pointait une section du lot 3,
// la seconde un libelle qui n'existe nulle part. Mon
// premier jet pointait « Base de connaissance → Infos du logement », la forme
// de l'ecran V5 — qui n'existe pas encore. Un hote lisant cette alerte serait
// parti chercher une section introuvable. Ces chemins suivront l'ecran quand
// l'ecran existera, dans le lot 3, et le test de parite de ce fichier le
// rappellera en rougissant.
const DE_LA_BASE = Object.keys(BALISES).filter(c => BALISES[c].origine === 'base')

// ⚠ UN SEUL FORMAT DE DATE, SUR TOUS LES CHEMINS — decision de Thierry du
// 3 novembre 2026 (lot 1b), confirmee dans sa fenetre parce qu'elle CHANGE le
// texte recu par le voyageur : les messages programmes rendaient
// « 02 novembre 2026 » (`formatDate` de lib/cron-shared.js), ils rendront
// « lundi 2 novembre » comme le code d'acces.
//
// ⚠ ET L'INJECTION A ETE RETIREE, PAS SEULEMENT INUTILISEE. Le lot 1 avait
// rendu le format injectable pour ne rien changer ; laisser le point
// d'injection en place aurait permis a un appelant futur de redivergier en une
// ligne, sans conflit et sans test rouge. Un seul format veut dire qu'il n'y a
// plus d'endroit ou en choisir un autre.
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
// ⚠ PAR FONCTION ICI AUSSI, ET C'EST UN CONSTAT DE LA SECONDE REVIEW : mon
// premier correctif avait converti TOUT le reste et oublie `{prenom}` — le
// champ le plus souvent substitue du produit, et du texte libre venu de l'OTA.
// Mesure : « C$`D » donnait « Bonjour CBonjour D » (le texte d'avant recopie),
// « Jo$$ie » donnait « Jo$ie », et « A$&B » laissait `{prenom}` dans le texte,
// donc l'hote etait accuse d'une « variable inconnue » qu'il n'avait pas ecrite.
function prenomNeutre (text, firstName) {
  const prenom = String(firstName || '').trim()
  if (prenom) return text.replace(/{prenom}/g, () => prenom)
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

  // ⚠ ON NE SIGNALE QUE CE QUE LE TEXTE DEMANDE. Constat de review d'un lot
  // precedent : evaluer les quatre valeurs inconditionnellement poussait
  // `adresse` et `telephone_hote` dans les manquants d'un modele qui ne les
  // utilise pas — un avertissement par message, par bien, toutes les 5 minutes.
  const utilise = (cle) => src.includes(`{${cle}}`)
  const propre = (v) => (v != null && String(v).trim() ? String(v).trim() : null)
  // ⚠ UN REPLI PEUT ETRE UNE CHAINE DE REPLIS, et c'est un constat de review :
  // `property.checkInStart || property.checkin_time` ecrase le second des que le
  // premier est une chaine d'ESPACES — truthy, puis annulee par `propre`, donc
  // l'horaire reel du bien etait perdu au profit du defaut. On essaie chaque
  // repli dans l'ordre, et on saute ceux qui sont blancs.
  // ⚠ `0` ET `false` SE SAUTENT, comme le faisait `||` — constat de la seconde
  // review : `propre(0)` rend « 0 », donc un provider qui pose `checkInStart: 0`
  // pour « non regle » aurait affiche « 0 » comme heure d'arrivee, la ou le code
  // d'avant prenait l'horaire reel du bien au repli suivant.
  const utilisable = (v) => (v === 0 || v === false ? null : propre(v))
  const premierPropre = (v) => (Array.isArray(v) ? v.map(utilisable).find(Boolean) || null : utilisable(v))

  const valeurDeLaBase = (cle) => {
    const def = BALISES[cle]
    const trouve = propre(k[cle]) || premierPropre(replis[cle])
    if (trouve) return trouve
    if (def.defaut) return def.defaut
    if (utilise(cle)) manquants.push(cle)
    return def.marqueur
  }

  // ⚠ LE REMPLACEMENT SE FAIT PAR FONCTION, JAMAIS PAR CHAINE, ET C'EST UN
  // CONSTAT DE REVIEW MESURE. Dans une chaine de remplacement, `$$`, `$&`,
  // ``$` `` et `$'` sont des MOTIFS. Mesure du 3 novembre 2026 :
  //   mot de passe « pa$$w0rd » -> « pa$w0rd »   (le voyageur recoit un faux)
  //   mot de passe « ab$&cd »   -> « ab{wifi_mdp}cd »
  //   mot de passe « x$`y »     -> « xwifi: y »  (le texte d'avant recopie)
  // Aucun de ces cas ne leve, aucun n'entre dans `manquants` ni dans
  // `inconnues` : il n'existe AUCUNE garde en aval. Et c'est le champ le plus
  // susceptible de porter un `$` qui arrive par ce lot — le mot de passe wifi.
  const pose = (texte, motif, valeur) => texte.replace(motif, () => valeur)

  let out = prenomNeutre(src, r.prenom)
  out = pose(out, /{nom}/g,      r.nom || '')
  out = pose(out, /{arrivee}/g,  formatDate(r.arrivee))
  out = pose(out, /{depart}/g,   formatDate(r.depart))
  out = pose(out, /{logement}/g, r.logement || '')

  for (const cle of DE_LA_BASE) {
    out = pose(out, new RegExp(`\\{${cle}\\}`, 'g'), valeurDeLaBase(cle))
  }
  // ⚠ LE CODE SE SIGNALE, IL N'ENTRE PAS DANS `manquants`, ET LA DIFFERENCE
  // EST TOUT — constat de review, et ma premiere version du lot 1b avait tort.
  // `manquants` fait RETOURNER `null` a `generateAutoMessage`, et ce `null`
  // tombe AVANT la fourche auto/Test : en mode Test, la proposition
  // `agent_tasks` que l'hote relit et COMPLETE A LA MAIN disparaissait aussi.
  // Or pour un code il n'existe aucune autre issue — la base de connaissance ne
  // porte pas `code_acces`, et le moteur programme ne fournit jamais le code.
  // Fermer la generation, c'etait donc fermer le seul chemin qui restait.
  //
  // La decision de Thierry dit « refuser d'ENVOYER », pas « refuser de
  // preparer ». On SIGNALE ici ; l'appelant refuse l'envoi et garde la
  // proposition.
  // ⚠ SUR `out`, PAS SUR `src` — constat de review. `utilise()` lit le texte
  // d'ORIGINE, alors que la boucle ci-dessus a deja injecte les valeurs de la
  // base : une valeur de la base contenant `{code_acces}` posait donc le
  // marqueur SANS lever le drapeau. Si l'IA effacait ensuite le marqueur, plus
  // rien ne retenait le message — il partait sans son code ET sans sa marque.
  // Peu probable aujourd'hui, mais c'est exactement le contrat que la V5
  // etend aux « reponses pretes ».
  const code = propre(ctx.codeAcces)
  const codeNonResolu = !code && out.includes('{code_acces}')
  out = pose(out, /{code_acces}/g, code || UNRESOLVED_CODE)

  const inconnues = [...new Set(out.match(VARIABLES) || [])]
  return { texte: out, manquants, inconnues, codeNonResolu }
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
