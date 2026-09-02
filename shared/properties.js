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
    _source: p.provider === 'beds24' ? 'beds24' : 'channel'
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
    // `allFailed` est reserve a ce qui est reellement casse.
    const refuse = /droits insuffisants|non autoris/i.test(message)
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

// Canaux de distribution REELS du bien, lus chez Channex.
// Renvoie [] (jamais une erreur) pour tout bien qui ne peut pas en avoir :
// bien Beds24, ou bien channel pas encore provisionne (provider_property_id null).
// Un [] est donc un resultat legitime, pas un echec silencieux.
export async function fetchPropertyChannels(p) {
  if (p._source !== 'channel') return []
  const pid = p.provider_property_id
  if (!pid) return []

  // ATTENTION : channel-mapping attend le provider_property_id (UUID Channex),
  // surtout pas le `id` HoteSmart. Voir shared/api-client.js.
  const r = await api.channel.mapping.channels(pid)
  const rows = Array.isArray(r?.channels) ? r.channels : []

  return rows.map(c => ({
    label: OTA_LABELS.find(o => o.match.test(c.ota || ''))?.label
        || c.title || c.ota || 'Canal',
    // Un canal mappe mais inactif reste affiche (grise) : le masquer rendrait
    // une activation ratee invisible, donc indebuggable cote utilisateur.
    active: c.is_active === true
  }))
}

// Rendu commun des badges canaux. Retourne '' si aucun canal : l'appelant
// decide quoi afficher a la place (rien, ou un libelle "aucun canal").
export function renderChannelBadges(channels) {
  if (!channels.length) return ''
  return channels.map(c =>
    `<span class="badge badge-channel${c.active ? '' : ' is-inactive'}"`
    + `${c.active ? '' : ' title="Canal mappé mais non activé"'}>`
    + `${escapeHtml(c.label)}${c.active ? '' : ' — inactif'}</span>`
  ).join('')
}

// Charge les canaux en differe et les injecte dans la carte deja rendue.
// Lazy-load assume : 1 requete par bien. Si ca rame au-dela de quelques biens,
// c'est le signal pour ajouter un endpoint batch cote API.
export async function hydrateChannelBadges(p, container) {
  if (!container) return
  try {
    const channels = await fetchPropertyChannels(p)
    const html = renderChannelBadges(channels)
    if (html) container.innerHTML = html
    else container.remove()
  } catch (err) {
    logger.error('properties', `canaux illisibles (${p.id}): ${err.message}`)
    container.remove()
  }
}
