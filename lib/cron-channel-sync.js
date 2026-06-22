// lib/cron-channel-sync.js
// Worker de la file d'attente des full syncs Channex (channel_sync_queue).
// Appele par le cron (*/5). Depile UN seul bien par run (le plus ancien pending),
// execute le push ARI 500 jours, pose properties.last_fullsync_at, marque done/failed.
const { supabase } = require('./cron-shared')
const { runFullSync } = require('./channel-fullsync')

async function processSyncQueue(results) {
  // 1) Le plus ancien pending
  const { data: rows, error: selErr } = await supabase
    .from('channel_sync_queue')
    .select('id, property_id, attempts')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
  if (selErr) { console.error('[Cron] channel_sync select:', selErr.message); return }
  const job = rows && rows[0]
  if (!job) return // file vide

  // 2) Claim atomique : pending -> processing UNIQUEMENT si encore pending.
  //    Si une autre invocation l'a deja pris, l'update ne renvoie aucune ligne -> on sort.
  const { data: claimed, error: claimErr } = await supabase
    .from('channel_sync_queue')
    .update({ status: 'processing' })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select('id')
  if (claimErr) { console.error('[Cron] channel_sync claim:', claimErr.message); return }
  if (!claimed || !claimed.length) return // deja pris ailleurs

  const nowIso = new Date().toISOString()
  try {
    // 3) Charge le bien
    const { data: bienRows, error: bienErr } = await supabase
      .from('properties')
      .select('id, base_price, provider_property_id, provider_room_type_id, provider_rate_plan_id')
      .eq('id', job.property_id)
      .limit(1)
    if (bienErr) throw new Error('Lecture bien: ' + bienErr.message)
    const bien = bienRows && bienRows[0]
    if (!bien) throw new Error('Bien introuvable')
    if (!bien.provider_property_id || !bien.provider_rate_plan_id || !bien.provider_room_type_id) {
      throw new Error('Bien non connecte au canal (ids manquants)')
    }

    // 4) Push ARI 500 jours
    const r = await runFullSync(bien)

    // 5) Pose last_fullsync_at (dernier sync REELLEMENT execute) + marque done
    await supabase.from('properties').update({ last_fullsync_at: nowIso }).eq('id', bien.id)
    await supabase.from('channel_sync_queue')
      .update({ status: 'done', processed_at: nowIso })
      .eq('id', job.id)

    results.channelSync = { property_id: job.property_id, pushed: r.pushed, warnings: r.warnings, task_ids: r.task_ids }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err)
    await supabase.from('channel_sync_queue')
      .update({ status: 'failed', processed_at: nowIso, attempts: (job.attempts || 0) + 1, last_error: msg })
      .eq('id', job.id)
    results.errors.push({ context: 'channel_sync', property_id: job.property_id, error: msg })
  }
}

module.exports = { processSyncQueue }
