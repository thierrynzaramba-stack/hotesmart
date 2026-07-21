const { supabase } = require('./cron-shared')
const { alertMissingAccessCode } = require('./alert-notify')

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
      // PIN null (génération Seam async) → 'pending' : PHASE 2 re-fetchera le PIN.
      status: result.code ? 'active' : 'pending'
    })

    // PIN indisponible : ne pas injecter un code null dans le message pending,
    // alerter l'hôte. Le message se résoudra quand le PIN arrivera (PHASE 2).
    if (!result.code) {
      await alertMissingAccessCode({ userId: keyRow.user_id, propertyId: booking.propertyId, booking })
      console.warn(`[Access] Refresh booking ${bookingId} : PIN Seam null, message non mis à jour, hôte alerté`)
      return
    }

    console.log(`[Access] Code rafraîchi booking ${bookingId}: ${result.code}`)
  } catch (err) {
    console.error(`[Access] Erreur refresh booking ${bookingId}:`, err.message)
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
  checkBatteries
}
