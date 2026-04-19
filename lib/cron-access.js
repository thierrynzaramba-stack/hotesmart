const { supabase } = require('./cron-shared')
const { sendViaBeds24 } = require('./cron-beds24')

// ─── Annulation code d'accès (sur booking cancelled) ─────────────────────────
async function cancelAccessCode(bookingId) {
  await supabase
    .from('access_codes')
    .update({ status: 'deleted' })
    .eq('booking_id', bookingId)
    .neq('status', 'deleted')

  await supabase
    .from('message_sent_log')
    .delete()
    .eq('booking_id', bookingId)
    .eq('status', 'pending')

  console.log(`[Access] Code annulé booking ${bookingId}`)
}

// ─── Rafraîchissement code d'accès (sur modification dates) ──────────────────
async function refreshAccessCode(bookingId, booking) {
  const { data: existing } = await supabase
    .from('access_codes')
    .select('id, lock_id, seam_code_id, status')
    .eq('booking_id', bookingId)
    .neq('status', 'deleted')
    .maybeSingle()
  if (!existing) return

  await supabase
    .from('access_codes')
    .update({ status: 'deleted' })
    .eq('id', existing.id)

  const { data: keyRow } = await supabase
    .from('api_keys')
    .select('seam_api_key, user_id')
    .not('seam_api_key', 'is', null)
    .maybeSingle()
  if (!keyRow?.seam_api_key) return

  const { data: lock } = await supabase
    .from('locks')
    .select('seam_device_id, label')
    .eq('id', existing.lock_id)
    .single()
  if (!lock) return

  const { generateCode } = require('./providers/seam')
  try {
    const result = await generateCode({
      seamDeviceId: lock.seam_device_id,
      guestName:    `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur',
      startsAt:     new Date(booking.arrival).toISOString(),
      endsAt:       new Date(booking.departure + 'T23:59:59').toISOString(),
      apiKey:       keyRow.seam_api_key
    })

    await supabase.from('access_codes').insert({
      lock_id: existing.lock_id,
      booking_id: bookingId,
      property_id: String(booking.propertyId),
      seam_code_id: result.seam_code_id,
      code: result.code,
      starts_at: result.starts_at,
      ends_at: result.ends_at,
      status: 'active'
    })

    // Mise à jour du payload des messages pending qui contiennent l'ancien code
    const { data: pending } = await supabase
      .from('message_sent_log')
      .select('id, payload')
      .eq('booking_id', bookingId)
      .eq('status', 'pending')
      .maybeSingle()
    if (pending?.payload) {
      const pl = JSON.parse(pending.payload)
      pl.seam_code = result.code
      pl.message   = pl.message?.replace(/\d{4,8}/g, result.code) || pl.message
      await supabase
        .from('message_sent_log')
        .update({ payload: JSON.stringify(pl) })
        .eq('id', pending.id)
    }

    console.log(`[Access] Code rafraîchi booking ${bookingId}: ${result.code}`)
  } catch (err) {
    console.error(`[Access] Erreur refresh booking ${bookingId}:`, err.message)
  }
}

// ─── Envoi des messages en attente (scheduled_at dépassé) ────────────────────
// Utilisé notamment pour les messages menage_done programmés avec délai.
async function checkPendingMessages(results) {
  const now = new Date()
  const { data: pending } = await supabase
    .from('message_sent_log')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now.toISOString())

  if (!pending?.length) return

  console.log(`[Access] ${pending.length} message(s) pending à envoyer`)

  // Récupère les clés Beds24 par user pour envoi
  const { data: apiKeys } = await supabase
    .from('api_keys')
    .select('user_id, api_key')
    .eq('service', 'beds24')
  const keysByUser = {}
  ;(apiKeys || []).forEach(k => { keysByUser[k.user_id] = k.api_key })

  for (const log of pending) {
    try {
      const pl = log.payload ? JSON.parse(log.payload) : {}
      if (!pl.message) {
        await supabase.from('message_sent_log').update({ status: 'error' }).eq('id', log.id)
        continue
      }

      await supabase.from('conversations').insert({
        user_id: log.user_id,
        property_id: pl.property_id,
        guest_name: pl.guest_name || 'Voyageur',
        guest_message: '[AUTO: menage_done]',
        agent_reply: pl.message,
        book_id: log.booking_id
      })

      await supabase
        .from('message_sent_log')
        .update({ status: 'sent', payload: null })
        .eq('id', log.id)

      const beds24Key = keysByUser[log.user_id]
      if (beds24Key) {
        await sendViaBeds24(beds24Key, log.booking_id, pl.message)
      } else {
        console.warn(`[Access] Pas de clé Beds24 pour user ${log.user_id}, envoi skip`)
      }

      results.totalAutoMessages++
      console.log(`[Access] Pending envoyé booking ${log.booking_id}`)
    } catch (err) {
      console.error(`[Access] Erreur pending ${log.id}:`, err.message)
      await supabase
        .from('message_sent_log')
        .update({ status: 'error' })
        .eq('id', log.id)
    }
  }
}

// ─── Vérification batterie serrures ──────────────────────────────────────────
// TODO : lecture batterie igloohome nécessite un bridge ou l'API igloohome
// directe (Seam ne remonte pas la batterie pour igloohome algoPIN).
async function checkBatteries(results) {
  // Placeholder — sera implémenté quand bridge igloohome ou API directe dispo
}

module.exports = {
  cancelAccessCode,
  refreshAccessCode,
  checkPendingMessages,
  checkBatteries
}
