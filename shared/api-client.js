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
  }
}