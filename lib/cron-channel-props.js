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
const { surveillerContradictionPrix } = require('./contradiction-prix')
const { channelCall } = require('./channels/channex')
const { reportIncident } = require('./founder-notify')

async function processChannelProperties(results) {
  const { data: props, error } = await supabase
    .from('properties')
    // ⚠ `id`, `rate_sync_mode`, `provider_rate_plan_id` et
    // `migration_target_property_id` sont lus par la surveillance des prix :
    // une garde qui juge sur une colonne non selectionnee est une garde ouverte.
    .select('id, user_id, name, address, provider, provider_property_id, migration_target_property_id, '
      + 'provider_rate_plan_id, rate_sync_mode, capacity, inventory_type, checkin_time, checkout_time')
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
    // ⚠ LES HORAIRES DU BIEN VOYAGENT AVEC LUI. Sans eux, `{checkin}` et
    // `{checkout}` retombaient sur 18:00/10:00 en dur, quels que soient ceux
    // reellement regles. Le telephone, lui, n'a pas de colonne : il vit dans
    // `knowledge`, et c'est `lib/cron-messages.js` qui l'y lit.
    const property = {
      id: p.provider_property_id,
      name: p.name,
      address: p.address,
      provider: p.provider,
      capacity: p.capacity,
      inventory_type: p.inventory_type,
      checkin_time: p.checkin_time,
      checkout_time: p.checkout_time
    }

    // ⚠ SON PROPRE `try`, ET AVANT LE RESTE N'AURAIT PAS D'IMPORTANCE — c'est
    // l'ISOLEMENT qui compte. Le 10 septembre, un `ReferenceError` dans le
    // PREMIER appel du try commun a emporte `processArrivalCodes` pendant 24 h :
    // plus aucun code d'acces cree, une voyageuse devant une porte fermee. Une
    // surveillance qui tombe ne doit jamais couter un code d'acces.
    try {
      const v = await surveillerContradictionPrix(supabase, p, { channelCall, reportIncident })
      if (v && v.contradiction) {
        console.warn(`[ChannelProps] ${v.message}`)
        results.contradictionsPrix = (results.contradictionsPrix || 0) + 1
      }
    } catch (err) {
      console.error(`[ChannelProps] surveillance prix ${p.provider_property_id}:`, err.message)
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
