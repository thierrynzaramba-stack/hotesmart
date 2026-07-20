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

async function fetchBeds24Properties() {
  const data = await api.beds24.getProperties()
  return (data.properties || []).map(p => ({ ...p, _source: 'beds24' }))
}

async function fetchChannelProperties() {
  const data = await api.channel.listProperties()
  // channel-property renvoie AUSSI les biens beds24 de l'utilisateur : on les
  // retire ici pour ne pas les compter deux fois avec fetchBeds24Properties().
  return (data.properties || [])
    .filter(p => p.provider !== 'beds24')
    .map(p => ({ ...p, _source: 'channel' }))
}

// Les deux sources en parallele : si l'une tombe, l'autre s'affiche quand meme.
// Renvoie { properties, beds24Failed, channelFailed, allFailed } — allFailed
// permet a l'appelant de distinguer "aucun bien" d'un "chargement casse".
export async function loadAllProperties() {
  const [beds24Res, channelRes] = await Promise.allSettled([
    fetchBeds24Properties(),
    fetchChannelProperties()
  ])

  const beds24Props  = beds24Res.status  === 'fulfilled' ? beds24Res.value  : []
  const channelProps = channelRes.status === 'fulfilled' ? channelRes.value : []

  const beds24Failed  = beds24Res.status  === 'rejected'
  const channelFailed = channelRes.status === 'rejected'
  if (beds24Failed)  logger.error('properties', 'Beds24: '  + beds24Res.reason?.message)
  if (channelFailed) logger.error('properties', 'Channel: ' + channelRes.reason?.message)

  const properties = [...beds24Props, ...channelProps]
  logger.info('properties', `${properties.length} biens (${beds24Props.length} Beds24, ${channelProps.length} channel)`)

  return {
    properties,
    beds24Failed,
    channelFailed,
    allFailed: beds24Failed && channelFailed
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
