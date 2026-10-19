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
export function fraicheurCanaux (vuLe, maintenant = Date.now()) {
  if (!vuLe) return null
  const ms = maintenant - new Date(vuLe).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const vieux = ms >= 24 * HEURE
  if (ms < HEURE) {
    const min = Math.max(1, Math.round(ms / 60000))
    return { texte: `vérifié il y a ${min} min`, vieux }
  }
  const h = Math.round(ms / HEURE)
  if (h < 24) return { texte: `vérifié il y a ${h} h`, vieux }
  const j = Math.floor(ms / (24 * HEURE))
  return { texte: `non vérifié depuis ${j} jour${j > 1 ? 's' : ''}`, vieux }
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

