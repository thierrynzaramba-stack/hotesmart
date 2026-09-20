// lib/pilote-tarifaire.js — QUI ECRIT LE PRIX D'UN BIEN.
// Spec : docs/specs/spec-yieldflow-v1.md §2 bis (amendement grave le
// 12 septembre 2026) — DOC : docs/kb/coeur-de-donnees.md
//
// Deux modes, exclusifs, par bien :
//   'calendrier' (DEFAUT) — l'hote saisit ses prix dans le calendrier.
//     Comportement actuel, inchange.
//   'yieldflow'  — les prix se travaillent et se VALIDENT dans l'app Yield,
//     qui ecrit par la chaine existante (journal alimente, source 'engine').
//
// ⚠ JAMAIS DEUX ECRIVAINS DE PRIX SUR UN MEME BIEN. C'est la raison d'etre du
// mode. En 'yieldflow', le calendrier passe en consultation TARIFAIRE pour ce
// bien — et cette exclusivite est tenue par une garde SERVEUR, pas par un
// bandeau : « une restriction d'UI n'est pas une restriction ».
//
// ⚠ LE PILOTE N'EMPORTE QUE LE TARIF (arbitrage B du §2 bis).
// La DISPONIBILITE et le STOP_SELL restent au calendrier DANS LES DEUX MODES :
// la memoire d'intention commerciale (chantier audit stop_sell) et
// l'anti-surreservation ne changent pas de mains. Le refus porte donc sur le
// seul `rate`. Un refus qui engloberait le segment entier empecherait l'hote de
// FERMER une nuit — c'est exactement la regression du 7 septembre, et ce module
// existe en partie pour qu'elle ne se refasse pas.

const MODES = ['calendrier', 'yieldflow']
const DEFAUT = 'calendrier'

// ⚠ FAIL-CLOSED A L'ENVERS, ET C'EST VOULU. Un bien dont la colonne est
// absente, nulle ou porte une valeur inconnue est lu 'calendrier' : le mode le
// moins surprenant, celui qui laisse l'hote ecrire. Se tromper dans l'autre
// sens bloquerait la saisie de prix sur un bien que personne n'a bascule.
function piloteDuBien (bien) {
  const v = bien && bien.pilote_tarifaire
  return MODES.includes(v) ? v : DEFAUT
}

// ⚠ SANS ACCENT DANS L'IDENTIFIANT : il se tape mal, se greppe mal, et un
// fichier servi dans un autre encodage le casse en silence.
const pilotParYield = bien => piloteDuBien(bien) === 'yieldflow'

// ⚠ LA MEME QUESTION QUE `canPushRates`, MAIS CE N'EST PAS LA MEME QUESTION.
// `rate_sync_mode` repond « HoteSmart pousse-t-il mes prix ? ».
// `pilote_tarifaire` repond « qui les decide ? ». Deux reglages distincts —
// mais UNE combinaison interdite, ci-dessous.
const pousseSesPrix = bien => !!bien && bien.rate_sync_mode === 'managed'

// ⚠ B BIS — UN BIEN EN 'keep' NE PEUT PAS PASSER EN 'yieldflow'.
// Sinon l'app ecrirait des prix que RIEN ne pousse : `calendar_inventory`
// porterait une strategie tarifaire invisible des plateformes, et le journal
// des prix ne verrait rien — il ne journalise que ce qui part reellement.
//
// Le message est en FRANCAIS et s'adresse a l'hote : il dit ce qui est refuse,
// pourquoi, et QUEL GESTE le debloque. Un refus muet le renverrait a l'ecran
// sans qu'il comprenne ce qui vient de lui etre epargne (meme patron que le
// refus de `rate_sync_mode = 'keep'` sur un bien connecte).
function peutPasserEnYieldflow (bien) {
  if (!bien) return { ok: false, error: 'Logement introuvable.' }
  if (pousseSesPrix(bien)) return { ok: true }
  return {
    ok: false,
    code: 'pilote_refuse_keep',
    error: 'Ce logement est réglé sur « Je garde mes prix » : HôteSmart '
      + 'n\'envoie aucun tarif aux plateformes. YieldFlow ne peut pas le '
      + 'piloter, car les prix qu\'il proposerait ne partiraient nulle part. '
      + 'Activez d\'abord l\'envoi des prix pour ce logement, puis revenez ici.'
  }
}

// ⚠ ET LA PORTE INVERSE, QUE LE §2 BIS NE TRANCHAIT PAS.
// Rien n'y interdisait de repasser un bien DEJA pilote par YieldFlow en
// `rate_sync_mode = 'keep'` — ce qui atteint le meme etat interdit par l'autre
// cote : l'app ecrit des prix que plus rien ne pousse. On REFUSE, plutot que de
// retomber en 'calendrier' tout seul : le choix de l'ecrivain appartient a
// l'hote, et un mode qui change sans geste est precisement ce que le lot 4.5
// s'interdit (« defaut : rien ne change sans mon geste »).
function peutCouperLaPousseeDesPrix (bien) {
  if (!pilotParYield(bien)) return { ok: true }
  return {
    ok: false,
    code: 'pilote_yieldflow_actif',
    error: 'Les prix de ce logement sont pilotés par YieldFlow. Repassez-le '
      + 'en pilotage par le calendrier avant de désactiver l\'envoi des prix, '
      + 'sinon les tarifs calculés ne partiraient plus vers les plateformes.'
  }
}

// ⚠ LE REFUS D'ECRITURE TARIFAIRE, cote calendrier.
// `dates` sert a le rendre concret : l'hote voit QUELLES nuits sont refusees,
// comme pour le prix plancher. On ne renvoie que les 20 premieres — la liste
// est une illustration, pas un journal.
function refusEcritureTarifaire (nbDates) {
  return {
    code: 'pilote_yieldflow',
    error: 'Les prix de ce logement sont pilotés par YieldFlow'
      + (nbDates ? ` : la saisie de ${nbDates} tarif${nbDates > 1 ? 's' : ''} `
        + 'a été refusée' : '')
      + '. Modifiez-les dans YieldFlow, ou repassez ce logement en pilotage '
      + 'par le calendrier. La disponibilité et la fermeture à la vente, elles, '
      + 'se règlent toujours ici.'
  }
}

// ⚠ LA COLLECTE VIT ICI POUR ETRE EXECUTEE PAR UN TEST, pas seulement relue.
// Laissee inline dans `api/calendar.js`, la seule facon de l'eprouver aurait
// ete un test qui LIT la source — et « un test qui lit du code ne voit pas ce
// que le code fait » (lecon du chantier inbound, 18 septembre 2026, gravee
// apres qu'un grep de source a laisse passer une regression complete).
//
// Rend les nuits d'une requete qui portent un TARIF. Les segments sans `rate`
// — disponibilite, stop_sell, sejour minimum — n'y figurent pas : c'est
// l'arbitrage B, et c'est ce qui laisse l'hote fermer une nuit en mode
// yieldflow.
function datesTarifees (dateSegments, expandDays) {
  const out = []
  for (const seg of dateSegments || []) {
    if (!seg || seg.rate == null) continue
    out.push(...expandDays(seg.date_from, seg.date_to, seg.days))
  }
  return out
}

// ─── LA FENETRE GLISSANTE D'UN BIEN AUTO-PILOTE (lot 4.6.0) ────────────────
// Spec §2 ter. En mode yieldflow, les nuits s'ouvrent a la vente sur un
// intervalle glissant choisi a l'activation : N jours, ou N mois. Au-dela,
// une nuit est PAS ENCORE OUVERTE — ce n'est pas une fermeture, aucun objet
// n'est cree, aucune intention n'est memorisee. La fenetre glisse, la nuit
// s'ouvre seule.
//
// ⚠ POURQUOI LA REGLE VIT ICI ET PAS DANS lib/yield/capacite.js.
// La fenetre est une propriete du PILOTE, pas de la capacite : le moteur
// d'ouverture (4.6.3), l'ecran des prix (4.6.0) et le denominateur (4.6.0)
// doivent tous lire la MEME borne. Trois recopies feraient trois verites sur
// « jusqu'ou le bien est-il ouvert ? » — et le jour ou l'une d'elles compte
// les mois autrement, le TO dit une chose et l'ecran une autre.
//
// ⚠ UN BIEN SANS FENETRE N'A PAS DE « HORS FENETRE ». Un bien en mode
// calendrier, ou un bien yieldflow dont la fenetre n'est pas encore reglee,
// rend `null` : rien ne change pour lui. C'est ce qui garantit que le lot
// 4.6.0 n'altere AUCUN comportement existant.
const FENETRE_TYPES = ['jours', 'mois']

function fenetreDuBien (bien) {
  if (!pilotParYield(bien)) return null
  const type = bien.pilote_fenetre_type
  const valeur = bien.pilote_fenetre_valeur
  if (!FENETRE_TYPES.includes(type)) return null
  // ⚠ LA VALEUR BRUTE, PAS `Number(...)` — releve en review. `Number(true)`
  // vaut 1 : un formulaire d'activation (4.6.3) qui transmettrait une case
  // cochee obtiendrait une fenetre d'UN jour, valide, sans erreur. La
  // contrainte SQL protege la base ; ce module est la regle en memoire.
  if (typeof valeur !== 'number' || !Number.isInteger(valeur) || valeur <= 0) return null
  return { type, valeur }
}

// Arithmetique de dates EN UTC sur des jours ISO : aucun fuseau n'entre en
// jeu, un jour ISO reste un jour ISO (regle du depot : un instant sans fuseau
// est lu en heure locale, et ca duplique en silence).
function decalerJours (jour, n) {
  const d = new Date(`${jour}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
// ⚠ « N MOIS GLISSANTS » = LE MEME JOUR CALENDAIRE, N MOIS PLUS LOIN, BORNE
// AU DERNIER JOUR DU MOIS D'ARRIVEE. Le 31 janvier + 1 mois donne le 28 (ou
// 29) fevrier, jamais le 3 mars : un setMonth nu deborde, et une fenetre de
// « 1 mois » aurait fait 31 jours en janvier et 34 en fevrier.
function decalerMois (jour, n) {
  const [a, m, j] = jour.split('-').map(Number)
  const cible = new Date(Date.UTC(a, m - 1 + n, 1))
  const dernier = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate()
  cible.setUTCDate(Math.min(j, dernier))
  return cible.toISOString().slice(0, 10)
}

// La DERNIERE nuit ouverte par la fenetre, vue d'aujourd'hui. `null` = pas de
// fenetre (bien non pilote, ou fenetre non reglee) : rien n'est hors fenetre.
function finDeFenetre (bien, aujourdHui) {
  const f = fenetreDuBien(bien)
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(String(aujourdHui || ''))) return null
  return f.type === 'jours' ? decalerJours(aujourdHui, f.valeur) : decalerMois(aujourdHui, f.valeur)
}

function estHorsFenetre (bien, date, aujourdHui) {
  const fin = finDeFenetre(bien, aujourdHui)
  return fin != null && String(date) > fin
}

// LE JOUR OU LA FENETRE ATTEINDRA CETTE NUIT — ce que l'ecran dit a l'hote a
// la place de « fermee » : « pas encore ouverte, s'ouvrira le … ». Sans cette
// date, un calendrier vide sur huit mois se lit comme une panne.
function dateOuverture (bien, date, aujourdHui) {
  const f = fenetreDuBien(bien)
  if (!f || !estHorsFenetre(bien, date, aujourdHui)) return null
  let candidat = f.type === 'jours' ? decalerJours(date, -f.valeur) : decalerMois(date, -f.valeur)
  // ⚠ LE CANDIDAT SE VERIFIE DANS L'AUTRE SENS — releve en review, et le
  // defaut etait exactement celui que ce lot veut eviter. En mois,
  // decaler(-N) puis decaler(+N) n'est PAS l'identite en fin de mois : la nuit
  // du 31 mars donnait « s'ouvrira le 28 fevrier », or le 28 fevrier + 1 mois
  // = le 28 mars, et le 31 est ENCORE hors fenetre ce jour-la. L'hote revient
  // le jour annonce, lit toujours « pas encore ouverte », et c'est la lecture
  // « panne » que la date existe pour empecher. Ma premiere version l'avait
  // vu et l'avait excuse (« c'est le calendrier ») : une date annoncee est
  // une promesse, pas une approximation.
  // On avance jour par jour jusqu'a ce que la fenetre atteigne la nuit. En
  // pratique 0 a 3 pas ; la borne de 40 evite une boucle si une regle change.
  for (let i = 0; i < 40 && finDeFenetre(bien, candidat) < date; i++) {
    candidat = decalerJours(candidat, 1)
  }
  return candidat
}

module.exports = {
  FENETRE_TYPES,
  fenetreDuBien,
  finDeFenetre,
  estHorsFenetre,
  dateOuverture,
  datesTarifees,
  MODES,
  DEFAUT,
  piloteDuBien,
  pilotParYield,
  pousseSesPrix,
  peutPasserEnYieldflow,
  peutCouperLaPousseeDesPrix,
  refusEcritureTarifaire
}
