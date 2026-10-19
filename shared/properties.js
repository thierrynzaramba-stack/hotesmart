// Source unique de verite pour "lister les biens d'un utilisateur".
//
// Deux backends coexistent et doivent apparaitre ensemble partout :
//   - Beds24        : API distante, biens jamais presents dans la table `properties`
//   - channel mgr   : table `properties` (provider 'channex' | 'channel')
//
// L'accueil n'interrogeait historiquement que Beds24, ce qui rendait les biens
// du channel manager structurellement invisibles. Toute page qui affiche des
// biens passe desormais par loadAllProperties() : c'est ce qui empeche les
// listes de rediverger.

import { api } from '/shared/api-client.js'
import { logger } from '/shared/logger.js'

export function escapeHtml(s) {
  if (s == null) return ''
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

// ⚠ UNE SEULE SOURCE : /api/channel-property.
//
// Cette fonction interrogeait DEUX endpoints et decidait elle-meme, en lisant
// `api_keys` cote client, si Beds24 etait configure. Deux raisons de ne plus le
// faire, et la seconde est bloquante :
//
//  1. Le front n'a pas a savoir qu'un provider existe. /api/channel-property
//     compose deja la liste des deux providers cote serveur — c'est le principe
//     du coeur de donnees (docs/kb/coeur-de-donnees.md).
//  2. La RLS d'`api_keys` est `user_id = auth.uid()` STRICTE, sans delegation :
//     un membre y lit toujours vide. Il en deduisait « Beds24 non configure »,
//     donc n'affichait AUCUN bien Beds24 — alors que le bien delegue peut
//     precisement en etre un. Desserrer la RLS aurait ete la mauvaise reponse :
//     une cle PMS engage le compte et ne se delegue pas.
//
// L'endpoint, lui, lit la cle en service key sur le COMPTE COURANT (en-tete
// X-Compte revalide) : il sait ce que le navigateur ne peut pas savoir.
async function fetchToutesProprietes() {
  const data = await api.channel.listProperties()
  return (data.properties || []).map(p => ({
    ...p,
    // `_source` reste la cle de provenance utilisee par les pages (badges,
    // canaux) : on la derive du provider renvoye par le serveur.
    // ⚠ UN BIEN EN COURS DE MIGRATION SE COMPORTE COMME UN BIEN DU CANAL.
    // `_source` commande l'affichage : avec 'beds24', `renderProperty` sort tot
    // (carte « gere via Beds24 », aucun bouton Connexions) et les badges de
    // canaux ne sont meme pas charges. Un bien qui a deja sa propriete chez le
    // nouveau provider doit donc etre traite comme tel — sinon il n'existe
    // aucun chemin pour le connecter, ce que Thierry a constate le
    // 10 septembre 2026.
    _source: (p.provider === 'beds24' && !p.migration_target_property_id) ? 'beds24' : 'channel'
  }))
}

// Les deux sources en parallele : si l'une tombe, l'autre s'affiche quand meme.
// Renvoie { properties, beds24Failed, channelFailed, allFailed } — allFailed
// permet a l'appelant de distinguer "aucun bien" d'un "chargement casse".
export async function loadAllProperties() {
  try {
    const properties = await fetchToutesProprietes()
    const beds24 = properties.filter(p => p._source === 'beds24').length
    logger.info('properties', `${properties.length} biens (${beds24} Beds24, ${properties.length - beds24} channel)`)
    // Les drapeaux d'echec par source sont conserves dans la signature : les
    // pages les lisent (`allFailed` distingue « aucun bien » d'un chargement
    // casse). Avec une source unique, les trois sont lies.
    return { properties, beds24Failed: false, channelFailed: false, allFailed: false, refuse: false }
  } catch (err) {
    const message = err?.message || String(err)
    // ⚠ UN REFUS DE DROITS N'EST PAS UNE PANNE. Un membre sans `reservations:read`
    // recoit un 403 parfaitement normal : afficher « Erreur de chargement » lui
    // ferait croire a un incident, et l'inciterait a recharger indefiniment.
    //
    // ⚠ ON TESTE LE STATUT, PAS LE TEXTE. Une regex sur le message confondait
    // 401 « Non autorisé » (session expiree, il faut se reconnecter) et 403
    // « Droits insuffisants » — et se serait retournee au premier libelle
    // reformule.
    const refuse = err?.status === 403
    if (refuse) {
      logger.info('properties', 'biens non accessibles avec les droits courants')
      return { properties: [], beds24Failed: false, channelFailed: false, allFailed: false, refuse: true }
    }
    logger.error('properties', 'chargement des biens echoue: ' + message)
    return { properties: [], beds24Failed: true, channelFailed: true, allFailed: true, refuse: false }
  }
}

// Badge de PROVENANCE ("qui gere ce bien"), a ne pas confondre avec les canaux
// de distribution ci-dessous : c'est precisement l'ambiguite qu'on corrige.
export function provenanceBadge(p) {
  return p._source === 'beds24' ? 'Beds24 ✓' : 'Géré par HôteSmart'
}

const OTA_LABELS = [
  { match: /airbnb/i,  label: 'Airbnb' },
  { match: /booking/i, label: 'Booking.com' }
]

// Les canaux de distribution du bien, LUS DANS LE COEUR (dette 59).
//
// ⚠ CE QUI A CHANGE, ET POURQUOI. Cette fonction interrogeait le partenaire EN
// DIRECT, un appel par bien, a chaque affichage de la page — et quand il ne
// repondait pas, `hydrateChannelBadges` faisait `container.remove()` : les
// pastilles disparaissaient SANS UN MOT, et l'hote lisait « aucun canal » la
// ou il en a deux. Les canaux descendent maintenant avec le bien, releves par
// la couche sync, et la date du dernier releve descend avec eux.
//
// Trois etats, et ils ne se confondent pas :
//   · `canaux` absent ou null  -> on n'a pas pu lire le coeur : on ne dit rien
//   · `canaux` vide            -> ce bien n'a aucun canal, et c'est une reponse
//   · `canaux` rempli          -> on les montre, avec leur fraicheur
export function canauxDuBien (p) {
  if (!p || !Array.isArray(p.canaux)) return null
  return p.canaux.map(c => ({
    label: OTA_LABELS.find(o => o.match.test(c.ota || ''))?.label
        || c.titre || c.ota || 'Canal',
    // ⚠ `mappe === null` = le serveur n'a pas pu conclure : on n'affiche pas un
    // badge vert sur une incertitude. Et `actif` est une propriete du CANAL,
    // pas du bien — un canal Airbnb porte plusieurs logements et devient actif
    // des qu'UN seul y est mappe (defaut du 11 septembre 2026, bien neuf avec
    // pastille verte).
    active: c.actif === true && c.mappe === true,
    url: c.listing_url || null
  }))
}

// « verifie il y a … » : la fraicheur de ce qu'on montre. Au-dela de 24 h, on
// le DIT au lieu de laisser croire que c'est a jour — et c'est la seule
// circonstance ou le bouton « Actualiser » apparait (decision de Thierry).
const HEURE = 3600000
// ⚠ L'ECHELLE EST CELLE DE THIERRY (recette du 19 octobre 2026) : les minutes
// jusqu'a 59, puis les heures, puis « hier », puis la date. La premiere
// version disait « non verifie depuis 2 jours » — un decompte en jours qu'on
// relit mal des qu'il depasse deux, et qui ne dit pas QUAND.
//
// ⚠ ET APRES L'HEURE, ON COMPTE EN JOURS CALENDAIRES, pas en tranches de 24 h.
// « hier » veut dire la veille, meme s'il ne s'est ecoule que quatre-vingt-dix
// minutes entre 23 h 30 et 1 h du matin : c'est ce qu'un humain lit. Le rouge
// et le bouton, eux, restent sur les 24 h ecoulees — c'est une mesure de
// fraicheur, pas une facon de parler.
const JOURS_ECART = (a, b) => {
  const jour = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((jour(a) - jour(b)) / (24 * HEURE))
}

// ⚠ LA DATE PASSE PAR `Intl`, COMME PARTOUT EN V5 (recette de Thierry) : mois
// en toutes lettres, et l'annee SEULEMENT si elle differe de l'annee en cours —
// « le 17 octobre » dans l'annee, « le 3 septembre 2025 » au-dela. Un « 17/10 »
// ne se lit pas de la meme facon selon le pays, et la V5 n'ecrit aucune date a
// la main.
//
// ⚠ ET LA LANGUE VIENT DU DOCUMENT, PAS D'UN IMPORT. `shared/i18n/i18n.js`
// pose `document.documentElement.lang` au demarrage ; l'importer ici creerait
// une dependance — et une initialisation a attendre — dans un module que cinq
// pages chargent. Le parametre reste injectable, pour les tests.
const langueDuDocument = () => {
  try {
    return (typeof document !== 'undefined' && document.documentElement
            && document.documentElement.lang) || 'fr'
  } catch { return 'fr' }
}

export function dateEnClair (quand, maintenant, langue) {
  const memeAnnee = quand.getFullYear() === new Date(maintenant).getFullYear()
  const options = memeAnnee
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' }
  try {
    return new Intl.DateTimeFormat(langue || langueDuDocument(), options).format(quand)
  } catch {
    // Un `Intl` indisponible ou une langue refusee ne doit pas faire
    // disparaitre la date : on replie sur une forme numerique lisible.
    const d = String(quand.getDate()).padStart(2, '0')
    const m = String(quand.getMonth() + 1).padStart(2, '0')
    return memeAnnee ? `${d}/${m}` : `${d}/${m}/${quand.getFullYear()}`
  }
}

export function fraicheurCanaux (vuLe, maintenant = Date.now(), langue = null) {
  if (!vuLe) return null
  const quand = new Date(vuLe)
  const ms = maintenant - quand.getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const vieux = ms >= 24 * HEURE
  if (ms < HEURE) {
    const min = Math.max(1, Math.round(ms / 60000))
    return { texte: `vérifié il y a ${min} min`, vieux }
  }
  const jours = JOURS_ECART(new Date(maintenant), quand)
  if (jours === 0) {
    const h = Math.max(1, Math.floor(ms / HEURE))
    return { texte: `vérifié il y a ${h} h`, vieux }
  }
  if (jours === 1) return { texte: 'vérifié hier', vieux }
  return { texte: `vérifié le ${dateEnClair(quand, maintenant, langue)}`, vieux }
}

// Les pastilles elles-memes. Inchangee depuis l'origine : un canal mappe mais
// INACTIF reste affiche, grise — le masquer rendrait une activation ratee
// invisible, donc indebuggable pour qui regarde l'ecran.
export function renderChannelBadges (canaux) {
  if (!canaux.length) return ''
  return canaux.map(c =>
    `<span class="badge badge-channel${c.active ? '' : ' is-inactive'}"`
    + `${c.active ? '' : ' title="Canal relié mais non activé"'}>`
    + `${escapeHtml(c.label)}${c.active ? '' : ' — inactif'}</span>`
  ).join('')
}

// Le mot que l'hote lit quand le releve a ECHOUE. Court, et il ne nomme JAMAIS
// le partenaire : l'hote n'a pas a savoir par qui nous passons.
//
// ⚠ IL S'AFFICHE UNE SEULE FOIS, EN HAUT DE LA PAGE (decision de Thierry,
// 19 octobre 2026). Le releve est au grain du COMPTE : un seul appel couvre
// tous les biens. Repeter le meme message sous chacune des cartes dirait dix
// fois la meme chose et laisserait croire a dix pannes. Le bouton
// « Actualiser » accompagne ce message, puisqu'il porte la meme action.
export const MOT_ECHEC = 'Vérification impossible pour l\'instant'

// Un seul echec pour tout le compte : il suffit qu'un bien le porte.
export function releveEnEchec (biens) {
  return (biens || []).some(p => p && p.canaux_echec === true)
}

export function hydrateChannelBadges (p, container) {
  if (!container) return
  const canaux = canauxDuBien(p)
  // ⚠ ON NE SUPPRIME PLUS LE CONTENEUR SUR UNE ABSENCE DE REPONSE. C'etait le
  // defaut : une lecture en echec se lisait « aucun canal ».
  if (canaux === null) { container.remove(); return }
  const html = renderChannelBadges(canaux)
  const f = fraicheurCanaux(p.canaux_vu_le)
  if (!html && !f) { container.remove(); return }
  container.innerHTML = html +
    (f ? `<span class="badge-fraicheur${f.vieux ? ' is-vieux' : ''}">${escapeHtml(f.texte)}</span>` : '')
}

