async function apiCall(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  }
  if (body) options.body = JSON.stringify(body)

  const res = await fetch(`/api/${endpoint}`, options)
  const data = await res.json()

  if (!res.ok) throw new Error(data.error || 'Erreur serveur')
  return data
}

export const api = {
  beds24: {
    getBookings: (propertyId) => apiCall('beds24', 'POST', { action: 'getBookings', propertyId }),
    getMessages: (propertyId) => apiCall('beds24', 'POST', { action: 'getMessages', propertyId }),
    sendMessage: (bookingId, message) => apiCall('beds24', 'POST', { action: 'sendMessage', bookingId, message }),
    getProperties: () => apiCall('beds24', 'POST', { action: 'getProperties' })
  },
  auth: {
    login: (email, password) => apiCall('auth', 'POST', { action: 'login', email, password }),
    register: (email, password) => apiCall('auth', 'POST', { action: 'register', email, password })
  },
  keys: {
    save: (service, key) => apiCall('auth', 'POST', { action: 'saveKey', service, key }),
    get: (service) => apiCall('auth', 'POST', { action: 'getKey', service })
  }
}