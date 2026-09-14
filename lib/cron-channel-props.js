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
const { importerMessagesDuBien, ordonnerPourImport } = require('./cron-channel-messages-sync')

// Part du cycle que l'import des messages peut consommer, pour TOUT le parc.
// Mesure du 14 septembre : lister les fils des quatre biens coute ~300 ms, et
// aller chercher un fil qui a bouge ~80 ms. Huit secondes laissent donc large,
// et restent tres en deca du reliquat d'un cycle a 56 s sur 60.
const BUDGET_IMPORT_PARC_MS = 8000

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

  // ─── SECONDE PASSE : l'import des messages ecrits par l'hote chez l'OTA ────
  // ⚠ UNE PHASE A PART, ET C'EST LE CORRECTIF DU BLOQUANT 4.
  // L'echeance etait posee AVANT la boucle metier : elle mesurait donc le
  // CYCLE, pas l'import. Le travail de chaque bien — templates, classification,
  // `fetchChannelBookings`, codes Seam — la consommait, et des le 2e ou 3e bien
  // il ne restait rien : abstention `cycle_en_retard` a CHAQUE cycle, incident
  // au troisieme, puis plus rien — et les messages des derniers biens JAMAIS
  // importes. Ce n'etait pas « un budget pour tout le parc », c'etait « tout le
  // budget au premier bien ».
  //
  // La phase demarre ICI, donc son echeance mesure ce qu'elle borne.
  //
  // ⚠ ET ELLE VIENT APRES LES CODES D'ACCES DE TOUS LES BIENS, ce qui est plus
  // fort que l'exigence de Thierry (« apres les codes d'acces dans l'ordre du
  // cycle ») : meme un import qui deborde ne peut plus couter un code, puisque
  // tous sont deja poses. Lecon du 10 septembre, ou un `ReferenceError` dans un
  // try commun a coute 24 h de codes d'acces et une voyageuse devant une porte.
  const echeanceImport = Date.now() + BUDGET_IMPORT_PARC_MS
  let aImporter = props
  try {
    aImporter = await ordonnerPourImport(supabase, props)
  } catch (err) {
    console.error('[ChannelProps] ordre d import illisible, ordre d origine :', err.message)
  }
  for (const p of aImporter) {
    if (!p.provider_property_id) continue
    // ⚠ SON PROPRE `try`, PAR BIEN. Une panne sur un bien ne doit pas priver
    // les suivants de leur import.
    try {
      await importerMessagesDuBien(supabase, p, { echeance: echeanceImport, results })
    } catch (err) {
      console.error(`[ChannelProps] import messages ${p.provider_property_id}:`, err.message)
      results?.errors?.push({ property_id: p.provider_property_id, error: 'import_messages: ' + err.message })
    }
  }
}

module.exports = { processChannelProperties }
