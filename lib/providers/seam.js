// lib/providers/seam.js — Provider Seam centralisé HôteSmart
// Fonctions : generateCode, deleteCode, getStatus, listDevices
// Utilisé par : api/cron.js (batterie + codes auto) et api/serrures.js

const SEAM_BASE = 'https://connect.getseam.com'

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function seamFetch(path, { method = 'GET', body, apiKey } = {}) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(`${SEAM_BASE}${path}`, opts)
  const d = await r.json()
  if (!r.ok) throw new Error(d.error?.message || `Seam ${r.status} sur ${path}`)
  return d
}

// ─── generateCode ─────────────────────────────────────────────────────────────
// Crée un code d'accès offline (Algopin) avec période de validité exacte
// Retourne { seam_code_id, code, starts_at, ends_at }

async function generateCode({ seamDeviceId, guestName, startsAt, endsAt, apiKey }) {
  const d = await seamFetch('/access_codes/create', {
    method: 'POST',
    apiKey,
    body: {
      device_id:              seamDeviceId,
      name:                   `${guestName || 'Voyageur'} - HôteSmart`,
      starts_at:              startsAt,
      ends_at:                endsAt,
      is_offline_access_code: true
    }
  })

  const accessCode = d.access_code
  if (!accessCode?.access_code_id) throw new Error('Seam : code non créé')

  // Le code Algopin peut prendre quelques secondes à être calculé
  let code = accessCode.code
  if (!code) {
    await new Promise(r => setTimeout(r, 2000))
    const d2 = await seamFetch(`/access_codes/get?access_code_id=${accessCode.access_code_id}`, { apiKey })
    code = d2.access_code?.code
  }

  return {
    seam_code_id: accessCode.access_code_id,
    code:         code || null,
    starts_at:    startsAt,
    ends_at:      endsAt
  }
}

// ─── deleteCode ───────────────────────────────────────────────────────────────
// Révoque un code sur la serrure (utile pour Nuki, pas nécessaire pour igloohome)
// Ne pas appeler pour brand = 'igloohome' (expiration auto)

async function deleteCode({ seamCodeId, apiKey }) {
  await seamFetch('/access_codes/delete', {
    method: 'POST',
    apiKey,
    body: { access_code_id: seamCodeId }
  })
  return { deleted: true }
}

// ─── getStatus ────────────────────────────────────────────────────────────────
// Retourne l'état d'une serrure : batterie, connectivité, verrou
// Retourne {
//   battery_level  : int (0-100) ou null si non supporté
//   battery_status : 'critical' | 'low' | 'good' | 'full' | null
//   is_locked      : bool | null
//   is_online      : bool
//   raw            : objet complet Seam
// }

async function getStatus({ seamDeviceId, apiKey }) {
  const d = await seamFetch(`/devices/get?device_id=${seamDeviceId}`, { apiKey })
  const dev = d.device

  const props = dev?.properties || {}

  // Seam expose battery_level (0.0–1.0) et battery_status
  const rawLevel = props.battery_level ?? props.battery?.level ?? null
  const batteryLevel = rawLevel !== null ? Math.round(rawLevel * 100) : null

  return {
    battery_level:  batteryLevel,
    battery_status: props.battery_status || null,
    is_locked:      props.locked ?? null,
    is_online:      dev?.properties?.online ?? false,
    raw:            dev
  }
}

// ─── getStatusAll ─────────────────────────────────────────────────────────────
// Récupère le statut de toutes les serrures en une seule passe
// Retourne un tableau [{ seam_device_id, ...getStatus() }]

async function getStatusAll({ apiKey }) {
  const d = await seamFetch('/devices/list', { apiKey })
  const devices = d.devices || []

  return devices.map(dev => {
    const props = dev.properties || {}
    const rawLevel = props.battery_level ?? props.battery?.level ?? null
    const batteryLevel = rawLevel !== null ? Math.round(rawLevel * 100) : null

    return {
      seam_device_id: dev.device_id,
      battery_level:  batteryLevel,
      battery_status: props.battery_status || null,
      is_locked:      props.locked ?? null,
      is_online:      props.online ?? false,
      raw:            dev
    }
  })
}

// ─── listDevices ──────────────────────────────────────────────────────────────
// Liste tous les devices connectés au compte Seam (pour la page config)

async function listDevices({ apiKey }) {
  const d = await seamFetch('/devices/list', { apiKey })
  return (d.devices || []).map(dev => ({
    seam_device_id: dev.device_id,
    display_name:   dev.properties?.name || dev.device_id,
    device_type:    dev.device_type,
    brand:          dev.properties?.manufacturer || null,
    is_online:      dev.properties?.online ?? false
  }))
}

module.exports = { generateCode, deleteCode, getStatus, getStatusAll, listDevices }
