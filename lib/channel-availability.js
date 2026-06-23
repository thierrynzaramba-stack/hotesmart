// lib/channel-availability.js
// Push availability d'un bien "whole" vers le channel, AVEC idempotence (anti-doublon
// webhook+poll). Claim atomique fenetre glissante 60s via RPC claim_availability_push.
// White-label : variables CHANNEL_* (jamais CHANNEX_*).

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

async function channelCall(method, path, body) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Pousse l'availability SSI aucun push identique (property+dates+availability) dans
// les 60 dernieres secondes. Le claim est atomique cote Postgres (RPC) -> immunise
// contre la course webhook+poll a quelques ms.
async function pushAvailabilityOnce(owner, providerPropertyId, arrival, departure, available, tag = 'channel') {
  if (owner.inventory_type !== 'whole') return
  if (!owner.provider_room_type_id || !arrival || !departure) return

  // derniere nuit = veille du depart (nuit de depart non occupee)
  const lastNight = new Date(departure)
  lastNight.setDate(lastNight.getDate() - 1)
  const dateTo = lastNight.toISOString().split('T')[0]
  if (dateTo < arrival) return   // sejour 0 nuit

  const roomTypeId = owner.provider_room_type_id

  // Claim atomique fenetre glissante. true = on gagne le push ; false = doublon recent.
  const { data: won, error: rpcErr } = await supabase.rpc('claim_availability_push', {
    p_property: String(providerPropertyId),
    p_room: String(roomTypeId),
    p_from: arrival,
    p_to: dateTo,
    p_avail: available
    // p_window_s : defaut 60s cote SQL
  })

  if (rpcErr) {
    // FAIL-OPEN : rpc en erreur (ex. fonction absente, perms) -> on POUSSE quand meme.
    // Mieux vaut un doublon possible qu'une dispo desynchronisee chez le channel.
    console.error(`[${tag}] availability dedup rpc error -> fail-open push`, rpcErr.message)
  } else if (won === false) {
    console.log(`[${tag}] availability dedup skip`, available, arrival, '->', dateTo, providerPropertyId)
    return
  }

  const r = await channelCall('POST', '/availability', {
    values: [{ property_id: providerPropertyId, room_type_id: roomTypeId, date_from: arrival, date_to: dateTo, availability: available }]
  })
  if (!r.ok) console.error(`[${tag}] pushAvailability echec`, r.status, r.json)
  else console.log(`[${tag}] dispo`, available, arrival, '->', dateTo, providerPropertyId)
}

// Purge des traces > 10 min (fenetre 60s -> 10 min = large marge).
async function purgeAvailabilityPushLog() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { error } = await supabase.from('availability_push_log').delete().lt('pushed_at', cutoff)
  if (error) console.error('[channel-availability] purge error', error.message)
}

module.exports = { pushAvailabilityOnce, purgeAvailabilityPushLog }
