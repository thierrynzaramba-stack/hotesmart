// shared/presta-etat.js — « EST-CE QUE CETTE PERSONNE RECEVRA DES MENAGES ? »
// Lot Menages V5, fenetre de configuration d'une prestataire (inventaire
// partie I, point 6 : « la phrase d'etat du point 1 ne se cache jamais »).
//
// ⚠ UNE FONCTION PURE, ET C'EST TOUT L'INTERET. La question se repond avec la
// regle du MOTEUR, pas avec une approximation d'ecran : trois filtres
// (`lib/cleaning/garde.js`) plus la restriction de proposition
// (`lib/cleaning/assign.js`). La recopier dans la page la ferait divergher du
// jour ou le moteur change ; l'ecrire ici la rend eprouvable sans DOM, et
// partageable entre l'ordinateur et le telephone (regle du depot : une regle
// commune vit dans un module commun).
//
// ⚠ ELLE NE REND AUCUN TEXTE. Les libelles sont i18n (`menages.equipe.config`)
// et vivent dans la page ; ici on rend des CLES et des faits.
//
// ⚠ LE CAS QUI MOTIVE CE MODULE EST REEL : Lola est liee ACTIVE a deux biens,
// en « elle confirme », avec AUCUN jour confie (`weekdays` null). Le moteur ne
// lui proposera JAMAIS rien — elle est candidate, mais la file de proposition
// ne retient que les liaisons dont les jours sont EXPLICITEMENT regles
// (decision du 4 septembre 2026). Aucun ecran ne le disait.

// La convention du moteur : 0 = dimanche … 6 = samedi
// (`lib/cleaning/availability.js`).
export const SAMEDI = 6
export const DIMANCHE = 0

// Le defaut d'une liaison, ou `null` si elle produit vraiment des menages.
//
//   `weekdays` null/absent  → attitree TOUS les jours (toutes les liaisons
//                             d'avant le lot 3 sont dans cet etat)
//   `weekdays` []           → AUCUN jour : choix explicite de l'hote
//
// ⚠ ET LES DEUX NE SE TRAITENT PAS PAREIL SELON L'ENGAGEMENT. « Tous les
// jours » suffit a une porteuse d'office — elle ne confirme rien. La meme
// valeur, pour quelqu'un qui doit confirmer, veut dire « jamais sollicitee ».
export function defautDeLaLiaison (l) {
  if (!l || l.active === false) return 'inactive'
  const jours = Array.isArray(l.weekdays) ? l.weekdays : null
  if (jours && !jours.length) return 'aucun_jour'
  // `requires_ack !== false` : le meme defaut prudent que `garde.js:73` — une
  // liaison lue sans cette colonne est traitee comme « elle confirme », parce
  // que devenir assignee d'office par omission d'un champ engagerait quelqu'un
  // sans son accord.
  const confirme = l.requires_ack !== false
  if (confirme && !jours) return 'jours_a_regler'
  return null
}

// ⚠ CE QUE L'ECRAN MONTRE, ET CE QU'UN CLIC EN FAIT : UNE SEULE SOURCE.
// `weekdays = null` se peint de DEUX facons, et c'est la que le defaut s'est
// loge (re-revue de e528ca1) :
//   - sur un bien ATTRIBUE D'OFFICE, les sept cases sont PLEINES — elle les
//     recoit vraiment tous, la valeur ne bloque rien ;
//   - sur un bien PROPOSE, elles sont VIDES — « ses jours ne sont pas regles »,
//     la file ne la sollicitera jamais.
// Le rendu et le gestionnaire de clic en avaient chacun leur idee : les cases
// etaient peintes vides, et le clic partait de « tous les jours » pour en
// retirer un. Cliquer lundi envoyait donc « tous les jours SAUF lundi » —
// l'inverse exact du geste, sur le reglage meme qui bloque.
export function joursAffiches (l) {
  if (!l) return []
  if (Array.isArray(l.weekdays)) return [...l.weekdays].sort((a, b) => a - b)
  // `null` : plein si elle recoit vraiment tout, vide si rien ne partira.
  return l.requires_ack === false ? [0, 1, 2, 3, 4, 5, 6] : []
}

// L'etat APRES un clic sur `jour`, a partir de ce que l'ecran montrait.
export function joursApresClic (l, jour) {
  const n = Number(jour)
  const jours = joursAffiches(l)
  const i = jours.indexOf(n)
  if (i >= 0) jours.splice(i, 1)
  else if (Number.isInteger(n) && n >= 0 && n <= 6) jours.push(n)
  return jours.sort((a, b) => a - b)
}

// Quelle FORME prennent ses jours, pour une phrase lisible. Rend une cle, pas
// une phrase : `tous`, `weekend`, `semaine`, ou `liste` (avec les jours).
export function formeDesJours (jours) {
  if (!Array.isArray(jours) || !jours.length) return { cle: 'tous', jours: null }
  const u = [...new Set(jours.map(Number).filter(j => Number.isInteger(j) && j >= 0 && j <= 6))].sort()
  if (u.length === 7) return { cle: 'tous', jours: null }
  if (u.length === 2 && u[0] === DIMANCHE && u[1] === SAMEDI) return { cle: 'weekend', jours: u }
  if (u.length === 5 && u.join() === '1,2,3,4,5') return { cle: 'semaine', jours: u }
  return { cle: 'liste', jours: u }
}

// `liaisons` : ses lignes `property_cleaning_providers` (actives ET inactives :
// c'est `active` qui tranche, pas l'appelant). `nomDuBien(propertyId)` rend le
// nom affichable, ou `null` pour un bien hors du perimetre de l'appelant.
//
// Rend :
//   { etat: 'ok' | 'rien', motif, biens: [...], biensEnDefaut: [...], action }
//
// ⚠ DEUX ETATS, PAS TROIS (demande de Thierry : « jamais d'ambre ici »).
// `rien` est reserve au cas ou elle ne recevra AUCUN menage — c'est la phrase
// qu'il a ecrite. Un bien mal regle PARMI d'autres qui marchent ne rougit pas
// tout l'en-tete : il porte son propre avertissement sur sa ligne, la ou le
// geste se fait. Sinon la seule alerte vraiment grave — « cette personne ne
// sert a rien » — se noierait dans du rouge permanent.
export function etatDeLaPrestataire ({ liaisons = [], nomDuBien = () => null } = {}) {
  const actives = (liaisons || []).filter(l => l && l.active !== false)
  const biens = []
  const biensEnDefaut = []
  for (const l of actives) {
    const nom = nomDuBien(String(l.property_id))
    if (nom === null || nom === undefined) continue   // hors perimetre : inexistant pour l'ecran
    const defaut = defautDeLaLiaison(l)
    const ligne = {
      propertyId: String(l.property_id),
      nom,
      // Le rang sert a ordonner les tours ; l'ecran n'en propose que 1 et 2,
      // mais une liaison en rang 3 existante doit se LIRE (decision de
      // Thierry), donc on rend la valeur telle quelle.
      rang: Number.isInteger(l.rang) ? l.rang : 1,
      dOffice: l.requires_ack === false,
      jours: Array.isArray(l.weekdays) ? [...l.weekdays].sort((a, b) => a - b) : null,
      forme: formeDesJours(l.weekdays),
      defaut
    }
    if (defaut) biensEnDefaut.push(ligne)
    else biens.push(ligne)
  }
  // Le tour se compose du rang le plus petit : on lit dans cet ordre.
  biens.sort((a, b) => (a.rang - b.rang) || String(a.nom).localeCompare(String(b.nom)))
  biensEnDefaut.sort((a, b) => String(a.nom).localeCompare(String(b.nom)))

  if (biens.length) {
    return { etat: 'ok', motif: null, biens, biensEnDefaut, action: biensEnDefaut.length ? 'jours' : null }
  }
  // Elle ne recevra rien. Le MOTIF commande le geste proposé, et il n'y en a
  // qu'un : « aucun logement » se répare en cochant un bien, « aucun jour » en
  // choisissant des jours. Deux boutons pour deux causes différentes.
  if (!actives.length || (!biens.length && !biensEnDefaut.length)) {
    return { etat: 'rien', motif: 'aucun_bien', biens, biensEnDefaut, action: 'biens' }
  }
  const motif = biensEnDefaut.every(b => b.defaut === 'aucun_jour') ? 'aucun_jour' : 'jours_a_regler'
  return { etat: 'rien', motif, biens, biensEnDefaut, action: 'jours' }
}

// ─── UN JOUR DE SON CALENDRIER, TOUCHE PAR L'HOTE (14 octobre 2026) ──────────
//
// ⚠ LA TABLE DE VERITE VIT ICI, PAS DANS LA PAGE. Quatre sorties pour un seul
// clic — poser une absence, poser une venue, retirer ce que l'hote avait pose,
// ne rien faire — et la revue de fc6c27d l'a relevee : rien ne la couvrait. A
// l'etape 2 (la recurrence A/B dans la V5), une refonte du calendrier peut en
// inverser une sans qu'aucun test ne bouge, et « une absence posee sur le
// mauvais jour ne se voit pas : elle se decouvre quand personne ne vient ».
//
// ⚠ LE SENS VIENT DU SERVEUR, PAS D'UN CALCUL D'ECRAN. `jour.sans_exception`
// dit ce que le jour vaudrait si on retirait son exception — calcule par
// `estDisponible`, le code du moteur. Quand la recurrence dit DEJA ce que
// l'hote veut, on RETIRE au lieu d'empiler une exception redondante.
//
// ⚠ ON NE RETIRE QUE LES GESTES DE L'HOTE. Defaire une absence que la
// PRESTATAIRE a declaree supprimerait sa ligne : le jour redeviendrait un jour
// ordinaire de sa recurrence, sans point et sans phrase dans son application, et
// elle n'apprendrait nulle part qu'on l'attend. C'est pourtant le geste qui
// compte le plus — « je sais que tu t'es declaree absente, viens quand meme ».
// On pose donc par-dessus, au prix d'une exception que la recurrence dirait
// deja : la trace vaut mieux que la purete.
export function gesteDuJour (jour, { aujourdhui = null, peutEcrire = true } = {}) {
  if (!jour || !jour.date) return { action: 'rien', motif: 'inconnu' }
  if (!peutEcrire) return { action: 'rien', motif: 'sans_droit' }
  // ⚠ Le conge PRIME sur tout, exception comprise : une exception posee la ne
  // changerait rien, et l'ecran promettrait un geste sans effet. Il se defait
  // par la liste des conges.
  if (jour.conge) return { action: 'rien', motif: 'conge' }
  if (aujourdhui && String(jour.date) < String(aujourdhui)) return { action: 'rien', motif: 'passe' }

  const voulu = jour.dispo !== true
  const exc = jour.exception || null
  const sienne = !!(exc && exc.source === 'prestataire')
  // ⚠ RETIRER DEMANDE UN IDENTIFIANT : le serveur n'accepte que l'id. S'il
  // manque — reponse d'un serveur d'avant ce lot — on pose : degrade, mais juste.
  if (jour.sans_exception === voulu && exc && exc.id && !sienne) {
    return { action: 'retirer', id: exc.id }
  }
  return { action: 'poser', date: jour.date, available: voulu }
}
