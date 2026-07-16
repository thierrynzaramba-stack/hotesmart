// lib/cron-channel-messages-backfill.js
// Rattrapage de l'import des messages apres activation d'un canal.
// Au webhook activate_channel (channel-events.js), les message_threads OTA ne sont pas
// encore ingeres cote Channex (asynchrone) -> importMessages rend 0. Cette passe cron
// rejoue importMessages pour les biens actives recemment, dans une fenetre bornee (30 min),
// puis pose messages_backfilled=true (STOP) dans les DEUX cas : succes OU fenetre ecoulee.
//
// Idempotent : importMessages deduplique via provider_msg_id -> rejouer est safe.
// Non bloquant : une erreur sur un bien n'interrompt ni les autres biens, ni le cron.

const { supabase } = require('./cron-shared')
const { getProvider } = require('./channels')

const WINDOW_MS = 30 * 60 * 1000  // fenetre de rattrapage : 30 min apres l'activation

async function processMessagesBackfill(results) {
  // Biens actives (channel_ready) pas encore rattrapes. Pas de borne haute en SQL :
  // on veut AUSSI voir les biens juste sortis de la fenetre pour poser le drapeau STOP.
  const { data: props, error } = await supabase
    .from('properties')
    .select('id, user_id, provider, provider_property_id, channel_ready_at')
    .eq('channel_ready', true)
    .eq('messages_backfilled', false)
    .not('channel_ready_at', 'is', null)

  if (error) {
    console.error('[MsgBackfill] SELECT properties echec:', error.message)
    results?.errors?.push({ context: 'messages_backfill', error: error.message })
    return
  }
  if (!props?.length) return

  for (const p of props) {
    if (!p.provider_property_id) continue
    try {
      const age = Date.now() - new Date(p.channel_ready_at).getTime()

      // CAS 1 : fenetre 30 min ecoulee -> STOP (pas d'historique reel a rattraper).
      if (age > WINDOW_MS) {
        const { error: upErr } = await supabase
          .from('properties').update({ messages_backfilled: true }).eq('id', p.id)
        if (upErr) console.error('[MsgBackfill] flag timeout echec', p.id, upErr.message)
        else console.log(`[MsgBackfill] ${p.provider_property_id} -> fenetre 30min ecoulee (STOP)`)
        continue
      }

      // CAS 2 : dans la fenetre -> on (re)tente l'import.
      const provider = getProvider(p.provider || 'channex')
      if (typeof provider.importMessages !== 'function') continue
      const r = await provider.importMessages({
        userId: p.user_id,
        propertyId: p.provider_property_id,
        providerPropertyId: p.provider_property_id
      })
      const imported = (r && typeof r === 'object') ? (r.imported || 0) : 0

      if (imported > 0) {
        // Succes -> STOP.
        const { error: upErr } = await supabase
          .from('properties').update({ messages_backfilled: true }).eq('id', p.id)
        if (upErr) console.error('[MsgBackfill] flag succes echec', p.id, upErr.message)
        results.totalMessages = (results.totalMessages || 0) + imported
        console.log(`[MsgBackfill] ${p.provider_property_id} -> imported=${imported} (STOP)`)
      } else {
        // Encore vide dans la fenetre -> on laisse pour le prochain cron */5.
        console.log(`[MsgBackfill] ${p.provider_property_id} -> imported=0 (retry au prochain cron)`)
      }
    } catch (e) {
      // Non bloquant : log + on continue les autres biens.
      console.error('[MsgBackfill] import echec', p.provider_property_id, e.message)
      results?.errors?.push({ context: 'messages_backfill', property_id: p.provider_property_id, error: e.message })
    }
  }
}

module.exports = { processMessagesBackfill }
