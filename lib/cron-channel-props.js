// lib/cron-channel-props.js
// Boucle de traitement des biens geres par le channel manager (provider='channex').
// Equivalent de processUser() pour Beds24, mais source = table properties + bookings_snapshot.
// Les reservations arrivent via webhook/poll (channel-webhook.js / cron-channel-feed.js) ;
// ici on applique les traitements METIER : messages automatiques (templates).
//
// Etend progressivement : codes d'acces, classification IA viendront quand le
// flux messages entrant (event 'message') sera valide.

const { supabase } = require('./cron-shared')
const { processMessageTemplates, fetchChannelBookings } = require('./cron-messages')
const { processArrivalCodes } = require('./cron-arrival-code')
const { processChannelPropertyMessages } = require('./cron-classify')

async function processChannelProperties(results) {
  const { data: props, error } = await supabase
    .from('properties')
    .select('user_id, name, address, provider, provider_property_id, capacity, inventory_type')
    .in('provider', ['channex', 'channel'])

  if (error) {
    console.error('[ChannelProps] SELECT properties echec:', error.message)
    results?.errors?.push({ context: 'channel_props', error: error.message })
    return
  }
  if (!props?.length) return

  for (const p of props) {
    if (!p.provider_property_id) continue

    // Format attendu par le metier (cron-messages) :
    // id = property_id TEXT utilise dans les tables (= provider_property_id).
    const property = {
      id: p.provider_property_id,
      name: p.name,
      address: p.address,
      provider: p.provider,
      capacity: p.capacity,
      inventory_type: p.inventory_type
    }

    try {
      await processMessageTemplates(p.user_id, null, property, results)
      await processChannelPropertyMessages(p.user_id, property, results)

      // Codes d'acces (Seam) : meme cycle que Beds24, source bookings_snapshot.
      const bookings = await fetchChannelBookings(p.user_id, property)
      await processArrivalCodes(p.user_id, null, property, bookings, results)
    } catch (err) {
      console.error(`[ChannelProps] Erreur bien ${p.provider_property_id}:`, err.message)
      results?.errors?.push({ property_id: p.provider_property_id, error: err.message })
    }
  }
}

module.exports = { processChannelProperties }
