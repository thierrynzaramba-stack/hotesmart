import { supabase } from '/shared/supabase.js'
import { logger } from '/shared/logger.js'

async function apiCall(endpoint, method = 'GET', body = null) {
  try {
    // Récupère le token de session automatiquement
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` })
      }
    }

    if (body) options.body = JSON.stringify(body)

    logger.info('API', `${method} /api/${endpoint}`)

    const res = await fetch(`/api/${endpoint}`, options)
    const data = await res.json()

    if (!res.ok) {
      logger.error('API', data.error || 'Erreur serveur', { endpoint, status: res.status })
      throw new Error(data.error || 'Erreur serveur')
    }

    logger.info('API', `Réponse OK /api/${endpoint}`)
    return data

  } catch (err) {
    logger.error('API', err.message, { endpoint })
    throw err
  }
}

export const api = {
  beds24: {
    getProperties: () => apiCall('beds24', 'POST', { action: 'getProperties' }),
    getBookings: (propertyId) => apiCall('beds24', 'POST', { action: 'getBookings', propertyId }),
    getMessages: (propertyId) => apiCall('beds24', 'POST', { action: 'getMessages', propertyId }),
    sendMessage: (bookingId, message) => apiCall('beds24', 'POST', { action: 'sendMessage', bookingId, message })
  },
  auth: {
    saveKey: (service, key) => apiCall('auth', 'POST', { action: 'saveKey', service, key }),
    getKey: (service) => apiCall('auth', 'POST', { action: 'getKey', service })
  },
  channel: {
    listProperties: () => apiCall('channel-property', 'GET'),
    createProperty: (data) => apiCall('channel-property', 'POST', data),
    getToken: (propertyId) => apiCall('channel-token', 'POST', { property_id: propertyId }),
    // Connexion OAuth : renvoie { iframe_url } vers la page /channels (marque blanche).
    // propertyId = UUID HoteSmart (channel-connect verifie l'ownership par id).
    connect: (propertyId) => apiCall(`channel-connect?property_id=${encodeURIComponent(propertyId)}`, 'GET'),
    // OAuth Airbnb lien-direct : renvoie { oauth_url } (airbnb.com/oauth2/auth...).
    // propertyUuid = UUID HoteSmart. channelId (option) = flux de re-connexion : on ajoute
    // le bien a un canal Airbnb existant au lieu d'en creer un nouveau (multi-biens/compte).
    airbnbConnect: (propertyUuid, { channelId = '' } = {}) =>
      apiCall('channel-airbnb-connect', 'POST',
        { property_id: propertyUuid, ...(channelId ? { channel_id: channelId } : {}) }),
    // Le compte du user a-t-il deja une connexion Airbnb (via ses autres biens) ?
    // Renvoie { existing_channels: [{ id, title, is_active, via_property }] }.
    airbnbAccountStatus: (propertyUuid) =>
      apiCall('channel-airbnb-connect?action=account_status', 'POST', { property_id: propertyUuid }),
    // Retour Airbnb : valide token+channel_id (resolution par TOKEN, pas la session).
    // Renvoie { property_id, provider_property_id, name, channel_id }.
    airbnbValidate: (token, channelId) =>
      apiCall('channel-airbnb-connect?action=validate', 'POST', { token, channel_id: channelId }),
    // Actions de mapping (channel-mapping). ATTENTION : property_id = provider_property_id
    // (UUID Channex du bien), PAS l'UUID HoteSmart. dry_run=false = ecriture reelle.
    mapping: {
      // Liste les annonces OTA du compte connecte (ecran de choix, ancien iframe).
      listListings: (providerPropertyId, channelId = '') =>
        apiCall(`channel-mapping?action=list_listings&property_id=${encodeURIComponent(providerPropertyId)}`
          + (channelId ? `&channel_id=${encodeURIComponent(channelId)}` : ''), 'GET'),
      // Annonces Airbnb via GET /channels/:id/action/listings (parcours lien-direct).
      actionListings: (providerPropertyId, channelId = '') =>
        apiCall(`channel-mapping?action=action_listings&property_id=${encodeURIComponent(providerPropertyId)}`
          + (channelId ? `&channel_id=${encodeURIComponent(channelId)}` : ''), 'GET'),
      // Etat des canaux du bien (polling detection fin OAuth).
      channels: (providerPropertyId) =>
        apiCall(`channel-mapping?action=channels&property_id=${encodeURIComponent(providerPropertyId)}`, 'GET'),
      // Lie notre rate plan au listing choisi (POST /channels/:id/mappings).
      map: (providerPropertyId, channelId, listingId, { dryRun = false, force = false } = {}) =>
        apiCall(`channel-mapping?action=map&property_id=${encodeURIComponent(providerPropertyId)}`
          + `&channel_id=${encodeURIComponent(channelId)}&listing_id=${encodeURIComponent(listingId)}`
          + `&dry_run=${dryRun}${force ? '&force=1' : ''}`, 'GET'),
      // Passe le canal live (POST /channels/:id/activate). Idempotent : no-op si deja actif.
      activate: (providerPropertyId, channelId, { dryRun = false, force = false } = {}) =>
        apiCall(`channel-mapping?action=activate&property_id=${encodeURIComponent(providerPropertyId)}`
          + `&channel_id=${encodeURIComponent(channelId)}&dry_run=${dryRun}${force ? '&force=1' : ''}`, 'GET'),
      // Tire les resas d'un listing rejoignant un canal (POST action/load_future_reservations).
      loadReservations: (providerPropertyId, channelId, listingId) =>
        apiCall(`channel-mapping?action=load_reservations&property_id=${encodeURIComponent(providerPropertyId)}`
          + `&channel_id=${encodeURIComponent(channelId)}&listing_id=${encodeURIComponent(listingId)}`, 'GET'),
      // Deconnecte CE bien de son annonce OTA : demappe le bien, supprime le canal seulement
      // s'il devient vide (protege les autres biens d'un compte Airbnb partage). dry_run=false.
      disconnect: (providerPropertyId, channelId = '') =>
        apiCall(`channel-mapping?action=disconnect&property_id=${encodeURIComponent(providerPropertyId)}`
          + (channelId ? `&channel_id=${encodeURIComponent(channelId)}` : '') + `&dry_run=false`, 'GET')
    }
  },
  calendar: {
    load: (propertyIds, start, end) =>
      apiCall(`calendar?property_ids=${encodeURIComponent(propertyIds.join(','))}&start=${start}&end=${end}`, 'GET'),
    save: (propertyId, segments) =>
      apiCall('calendar', 'POST', { action: 'save', property_id: propertyId, segments }),
    fullsync: (propertyId) =>
      apiCall('calendar', 'POST', { action: 'fullsync', property_id: propertyId })
  }
}