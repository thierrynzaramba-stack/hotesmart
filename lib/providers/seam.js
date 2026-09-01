// ⚠️ DOC : comportement documenté dans docs/kb/codes-acces.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce kb (MÊME COMMIT).
// lib/providers/seam.js — Provider Seam centralisé HôteSmart
// Fonctions : generateCode, deleteCode, getStatus, getStatusAll, listDevices, getSeamKey

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const SEAM_BASE = 'https://connect.getseam.com'

// ─── getSeamKey ───────────────────────────────────────────────────────────────
//
// ⚠ LE REPLI SUR LA CLE PLATEFORME EST RETIRE POUR UN COMPTE IDENTIFIE.
// La ligne `data?.seam_api_key || process.env.SEAM_API_KEY` faisait qu'un hote
// SANS cle Seam propre empruntait celle de la plateforme — donc le meme compte
// Seam que tous les autres hotes dans ce cas. `devices/list` leur listait alors
// les serrures des uns et des autres, et `access_codes/delete` acceptait
// n'importe quel code_id. Une fuite entre comptes, amorcee des que SEAM_API_KEY
// est posee en environnement.
// Un compte sans cle obtient desormais `null`, et l'appelant repond « Cle Seam
// non configuree » — message juste, aucun emprunt.
//
// `!userId` (appel interne sans compte : scripts, diagnostics) conserve la cle
// d'environnement : il n'y a la aucun compte a confondre avec un autre.
async function getSeamKey(userId) {
  if (!userId) return process.env.SEAM_API_KEY || null
  const { data, error } = await supabase
    .from('api_keys')
    .select('seam_api_key, seam_enabled')
    .eq('user_id', userId)
    .maybeSingle()
  // Une panne ne doit pas se lire comme « pas de cle » : le repli plateforme
  // ayant disparu, l'appelant repondrait « non configuree » a tort.
  if (error) { console.error('[seam] lecture cle', error.message); throw new Error('Lecture de la cle Seam impossible') }
  if (data?.seam_enabled === false) return null
  return data?.seam_api_key || null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
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
// pollForPin : si true (defaut, compat historique), on attend le PIN jusqu'a ~40s.
// Le cron arrival-code passe false pour NE PAS bloquer le run (chaque code igloohome
// bloquait 40s -> timeout Vercel -> INSERT jamais fait -> doublons Seam). Le PIN est
// alors recupere hors chemin critique, en PHASE 2 (sendArrivalMessage re-fetch Seam).
async function generateCode({ seamDeviceId, guestName, startsAt, endsAt, apiKey, pollForPin = true }) {
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

  let code = accessCode.code

  // Pour les serrures offline (igloohome notamment), Seam genere le PIN de
  // maniere asynchrone cote serveur et peut prendre jusqu'a 30-40s. On ne poll
  // QUE si pollForPin (chemin non-critique) — sinon retour immediat, PHASE 2 fetch.
  if (pollForPin && !code) {
    const delays = [2000, 3000, 5000, 10000, 20000] // 2s + 3s + 5s + 10s + 20s = 40s max
    for (const delay of delays) {
      if (code) break
      await new Promise(r => setTimeout(r, delay))
      try {
        const d2 = await seamFetch(`/access_codes/get?access_code_id=${accessCode.access_code_id}`, { apiKey })
        code = d2.access_code?.code
        if (code) {
          console.log(`[Seam] Code recupere apres attente cumulee (delai ${delay}ms) : ${accessCode.access_code_id}`)
          break
        }
      } catch (err) {
        console.warn(`[Seam] Polling erreur sur ${accessCode.access_code_id} :`, err.message)
      }
    }
    if (!code) {
      console.warn(`[Seam] Code toujours null apres 40s de polling pour ${accessCode.access_code_id} — Seam asynchrone trop lent, a investiguer`)
    }
  }

  return {
    seam_code_id: accessCode.access_code_id,
    code:         code || null,
    starts_at:    startsAt,
    ends_at:      endsAt
  }
}

// ─── deleteCode ───────────────────────────────────────────────────────────────
async function deleteCode({ seamCodeId, apiKey }) {
  await seamFetch('/access_codes/delete', {
    method: 'POST',
    apiKey,
    body: { access_code_id: seamCodeId }
  })
  return { deleted: true }
}

// ─── getStatus ────────────────────────────────────────────────────────────────
async function getStatus({ seamDeviceId, apiKey }) {
  const d = await seamFetch(`/devices/get?device_id=${seamDeviceId}`, { apiKey })
  const dev = d.device
  const props = dev?.properties || {}
  const rawLevel = props.battery_level ?? props.battery?.level ?? null
  const batteryLevel = rawLevel !== null ? Math.round(rawLevel * 100) : null

  return {
    battery_level:  batteryLevel,
    battery_status: props.battery_status || null,
    is_locked:      props.locked ?? null,
    is_online:      props.online ?? false,
    raw:            dev
  }
}

// ─── getStatusAll ─────────────────────────────────────────────────────────────
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

module.exports = { generateCode, deleteCode, getStatus, getStatusAll, listDevices, getSeamKey }
