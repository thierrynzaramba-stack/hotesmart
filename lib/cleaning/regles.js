// lib/cleaning/regles.js
// LA REGLE RECURRENTE, VALIDEE EN UN SEUL ENDROIT.
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// ⚠ POURQUOI CE MODULE EXISTE. Depuis le 15 septembre 2026, DEUX endpoints
// ecrivent les jours habituels d'une prestataire : `api/disponibilites.js`
// (l'hote, depuis la fiche) et `api/menages-public.js` (elle-meme, depuis sa
// PWA). Recopier la validation dans le second aurait produit deux regles pour
// la meme chose — et ce depot a deja paye trois fois le meme prix : la copie
// devient plus permissive que l'original, et personne ne s'en apercoit avant
// qu'une donnee impossible soit en base.
//
// Ce module ne touche PAS la base. Il rend ce qu'il faut ecrire, ou pourquoi on
// ne peut pas : les gardes de compte, de droit et de jeton restent chez les
// appelants, ou elles different reellement.

const { construireRrule, cleJour } = require('./availability')

// ⚠ AU SINGULIER, ET ON N'Y TOUCHE PAS. C'est la forme deja stockee en base
// (« Tous les lundi et mardi ») : la mettre au pluriel en deplacant ce code
// aurait fait diverger les libelles des regles NEUVES de ceux des anciennes,
// sans que personne l'ait demande. Un libelle est une donnee, pas un affichage.
const NOMS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']

// ⚠ AU-DELA DE 4, CE N'EST PLUS UNE CADENCE DE MENAGE : c'est une saisie qui a
// derape, et la recurrence deviendrait illisible a l'ecran.
const CADENCE_MAX = 4

// Le libelle lu par les deux ecrans ET par la PWA. Il est STOCKE en base : le
// changer ici ne renomme pas les regles existantes, il ne vaut que pour les
// suivantes.
function libelle (jours, cadence) {
  const tries = [...jours].sort((a, b) => a - b)
  const noms = tries.map(j => NOMS[j])
  const liste = noms.length > 1
    ? `${noms.slice(0, -1).join(', ')} et ${noms[noms.length - 1]}`
    : noms[0]
  if (cadence === 1) return `Tous les ${liste}`
  if (cadence === 2) return `${liste.charAt(0).toUpperCase()}${liste.slice(1)}, une semaine sur deux`
  return `${liste.charAt(0).toUpperCase()}${liste.slice(1)}, toutes les ${cadence} semaines`
}

// Rend `{ erreur }` ou `{ rrule, label, jours, cadence }`.
//
// ⚠ AUCUNE CHAINE RRULE N'ENTRE ICI. Le client envoie des JOURS, une cadence et
// une ancre ; la chaine est CONSTRUITE par le serveur. C'est la regle du §2 de
// la spec, et elle vaut dans les deux sens : ce qui ne descend pas ne remonte
// pas non plus. Accepter une RRULE du client laisserait ecrire n'importe quelle
// recurrence — une `FREQ=MONTHLY` qu'aucun des deux ecrans ne sait relire, donc
// invisible et sans issue par l'interface.
// ⚠ `cleJour` VIENT D'ICI, il n'est plus injecte. La premiere version le
// prenait en parametre alors que ce module importe deja `./availability` : une
// couture ouverte pour rien, par laquelle un troisieme appelant aurait pu passer
// une autre normalisation et changer la semantique de l'ancrage sans qu'aucun
// test ne bouge.
function validerRegle ({ jours, toutes_les_n_semaines: cadenceBrute, depuis }) {
  if (!Array.isArray(jours) || !jours.length) {
    return { erreur: 'Choisissez au moins un jour' }
  }
  // ⚠ Les jours arrivent parfois en CHAINES (une `value` de case a cocher, un
  // JSON construit a la main). Les refuser d'emblee rendait le meme corps
  // acceptable depuis un ecran et refuse depuis l'autre.
  const lus = jours.map(v =>
    typeof v === 'number' ? v
      : (typeof v === 'string' && /^[0-6]$/.test(v.trim()) ? Number(v) : NaN))
  if (lus.some(j => !Number.isInteger(j) || j < 0 || j > 6)) {
    return { erreur: 'Jours invalides' }
  }
  const cadence = cadenceBrute === undefined ? 1 : Number(cadenceBrute)
  if (!Number.isInteger(cadence) || cadence < 1 || cadence > CADENCE_MAX) {
    return { erreur: 'Cadence invalide' }
  }
  // ⚠ L'ANCRAGE DECIDE QUELLE SEMAINE EST « ON ». Une date illisible retombe sur
  // aujourd'hui plutot que d'echouer : c'est le comportement de
  // `construireRrule`, et les deux ecrans envoient toujours une date.
  const ancre = depuis && cleJour(depuis) ? cleJour(depuis) : null
  // ⚠ DEDUPLIQUE AVANT LE LIBELLE. `construireRrule` deduplique de son cote, si
  // bien qu'un corps `{jours:[1,1,2]}` produisait une RRULE correcte mais un
  // libelle « Tous les lundi, lundi et mardi » — affiche tel quel dans les
  // deux ecrans, et stocke pour toujours.
  const joursUniques = [...new Set(lus)].sort((a, b) => a - b)
  const rrule = construireRrule({ jours: joursUniques, toutesLesNSemaines: cadence, depuis: ancre })
  if (!rrule) return { erreur: 'Règle impossible' }

  return { rrule, label: libelle(joursUniques, cadence), jours: joursUniques, cadence }
}

// REMPLACER TOUS SES JOURS HABITUELS, EN UNE SEULE ECRITURE (16 octobre 2026).
//
// ⚠ POURQUOI UNE FONCTION POSTGRES ET PAS DEUX APPELS. Remplacer, c'est
// DESACTIVER ce qui existe et INSERER ce qui remplace. Tant que ce sont deux
// ecritures distinctes, le reseau peut couper entre les deux, et il reste un
// etat a moitie ecrit. Les deux moities ne se valent pas :
//   · desactiver PUIS inserer laisse ZERO regle active, c'est-a-dire
//     « disponible TOUS LES JOURS » (etage 4 de la precedence) : le moteur lui
//     attribue des menages n'importe quel jour, et personne ne l'a demande ;
//   · inserer PUIS desactiver laisse l'ANCIEN et le NOUVEAU actifs — l'union
//     des deux, que l'ecran affiche fidelement et que le geste suivant corrige.
// Le second est le moindre mal, et c'est ce que ce module faisait. Mais un
// moindre mal reste un mal : l'union attribue elle aussi des menages les jours
// que l'hote venait de retirer. Un bloc plpgsql est une TRANSACTION — les deux
// ecritures aboutissent ensemble, ou aucune n'a lieu. Il n'y a plus d'etat
// intermediaire a choisir.
//
// ⚠ LA VALIDATION RESTE ICI, EN JAVASCRIPT. La fonction SQL ne valide ni les
// jours, ni la cadence, ni la RRULE : une seconde validation en SQL finirait
// par diverger de celle-ci, et c'est exactement ce que ce module existe pour
// empecher.
//
// ⚠ CE MODULE NE CONNAIT NI LES DROITS NI LES JETONS. Les gardes restent chez
// les appelants, ou elles different reellement : la PWA verifie
// `self_availability`, la fiche verifie `prestataires: write`.
//
// `lots` : une entree par ligne de l'ecran — une en semaine simple, deux en
// quinzaine (A et B). Une ligne VIDE est legitime (« aucun jour cette
// semaine-la ») et ne pose rien.
const RPC_REGLES = 'remplacer_regles_dispo'

// ⚠ UNE SEULE BORNE, ET ELLE VIT ICI (16 octobre 2026). Les deux endpoints en
// portaient une chacun — 50 pour la PWA, 200 pour la fiche — et les passaient
// a la MEME fonction : la meme prestataire pouvait donc etre reglable depuis
// un ecran et refusee depuis l'autre, sans que rien ne l'explique. C'est le
// defaut classique d'une regle recopiee : les deux copies derivent, et la plus
// permissive gagne par accident.
// ⚠ ET C'EST AUSSI LE DEFAUT DE LA FONCTION SQL (`p_max_actives int default
// 50`) : les deux chiffres doivent rester egaux, et le test le verifie.
const MAX_REGLES_ACTIVES = 50

async function remplacerRegles (supabase, { userId, providerId, lots, cadence, source,
                                           maxActives = MAX_REGLES_ACTIVES }) {
  // ⚠ ON VALIDE TOUT AVANT D'ECRIRE QUOI QUE CE SOIT. Valider lot par lot en
  // ecrivant au fil de l'eau laisserait la moitie d'un reglage en base.
  const aPoser = []
  // La FORME de ce qu'on pose, en jours de semaine : c'est elle que l'appelant
  // compare a l'existant pour ANNONCER le changement (« elle ne travaille plus
  // le samedi »), jamais des RRULE — personne ne lit « regle #a4f2 desactivee ».
  const formes = []
  for (const lot of (lots || [])) {
    const jours = (lot && lot.jours) || []
    // ⚠ UN `jours` QUI N'EST PAS UN TABLEAU EST UN REFUS, pas une ligne vide :
    // le passer en silence enregistrerait un reglage ampute.
    if (!Array.isArray(jours)) return { erreur: 'Jours invalides', status: 400 }
    // ⚠ UNE LIGNE VIDE EST LEGITIME — « aucun jour cette semaine-la ».
    if (!jours.length) continue
    // ⚠ LES DEUX ECRANS NE NOMMENT PAS L'ANCRE PAREIL (`ancre` dans la fiche,
    // `depuis` dans la PWA) : on accepte les deux plutot que d'aller renommer
    // un contrat deja en production des deux cotes.
    const v = validerRegle({ jours, toutes_les_n_semaines: cadence,
                             depuis: (lot && (lot.ancre || lot.depuis)) })
    if (v.erreur) return { erreur: v.erreur, status: 400 }
    aPoser.push({ rrule: v.rrule, label: v.label })
    formes.push({ jours: v.jours, cadence: v.cadence })
  }

  const { data, error } = await supabase.rpc(RPC_REGLES, {
    p_user_id: userId, p_provider_id: providerId, p_source: source,
    p_regles: aPoser, p_max_actives: maxActives
  })

  if (error) {
    // ⚠ LA FONCTION MANQUE = LA MIGRATION N'EST PAS COLLEE, et ce n'est pas une
    // panne passagere : on le DIT dans le journal, sinon le symptome (« je ne
    // peux plus regler ses jours ») se cherche dans le navigateur pendant une
    // heure. Pas de repli sur l'ancienne mecanique : retomber sur un chemin
    // qu'on vient de juger mauvais, en silence, serait le pire des deux.
    const manquante = String(error.code || '') === '42883' ||
                      /remplacer_regles_dispo/.test(String(error.message || ''))
    if (manquante) return { erreur: 'rpc_absente', status: 503, detail: error.message }
    if (String(error.code || '') === '54000') return { erreur: 'plafond', status: 503, detail: error.message }
    return { erreur: 'ecriture', status: 503, detail: error.message }
  }

  // ⚠ LA FORME D'AVANT VIENT DE LA FONCTION, pas d'une lecture faite a cote :
  // entre une lecture et l'ecriture, l'autre ecran a pu poser quelque chose.
  const avant = Array.isArray(data && data.avant) ? data.avant : []
  return { avant, formes, poses: aPoser.length }
}

module.exports = { validerRegle, libelle, remplacerRegles, CADENCE_MAX, MAX_REGLES_ACTIVES }
