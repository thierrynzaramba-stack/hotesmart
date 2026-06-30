// lib/record-message.js
// Helper UNIQUE d'écriture dans la table source de vérité `messages`.
// Étape 2 (double écriture) : tous les producteurs appellent recordMessage()
// EN PLUS de leur écriture existante. Aucun producteur ne dépend de son succès.
//
// CommonJS. Service key (RLS sans policy → écriture serveur uniquement).
// Client dédié léger : on NE réutilise PAS cron-shared.js (qui charge le SDK
// Anthropic), on calque sur lib/channel-availability.js.

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Fenêtre de dédup logique pour les SORTANTS sans provider_msg_id.
// 10 min couvre deux cycles du cron */5 (réémission accidentelle), sans
// risquer de masquer un envoi légitime distinct (templates = 1 par évènement).
const OUTBOUND_DEDUP_WINDOW_MS = 10 * 60 * 1000

// Résolution best-effort de l'OTA depuis la réservation.
// L'OTA vit sur la réservation, jamais sur le message :
//  - Channex : bookings_snapshot.snapshot.source (rangé par le webhook/feed)
//  - Beds24  : non stocké → renverra null (le caller cron-classify passe l'ota)
// Race Channex (message avant snapshot) → null, backfill ultérieur. Jamais throw.
async function resolveOta(userId, bookingId) {
  if (!userId || !bookingId) return null
  try {
    const { data } = await supabase
      .from('bookings_snapshot')
      .select('snapshot')
      .eq('user_id', userId)
      .eq('booking_id', String(bookingId))
      .maybeSingle()
    return data?.snapshot?.source || null
  } catch (e) {
    console.warn('[recordMessage] resolveOta echec', e.message)
    return null
  }
}

// Écrit un message dans `messages`. Fail-safe absolu : attrape tout, ne throw
// jamais, ne casse jamais le producteur appelant.
// Retour informatif (jamais à traiter par le caller) :
//   { ok:true, skipped:false } inséré
//   { ok:true, skipped:true, reason } ignoré (doublon)
//   { ok:false, error }         échec silencieux loggé
async function recordMessage(params) {
  try {
    const {
      userId,
      provider,                 // 'beds24' | 'channex' (routage interne)
      propertyId,               // provider propId (TEXT)
      bookingId = null,
      direction,                // 'inbound' | 'outbound'
      sender,                   // 'guest' | 'host' | 'ai' | 'auto' | 'system'
      body = '',
      providerMsgId = null,
      ota = null,
      sentAt = null,
      kind = 'message'
    } = params || {}

    // Garde-fous minimaux (les CHECK base couvrent direction/sender, mais on
    // évite un aller-retour réseau inutile si l'appel est manifestement cassé).
    if (!userId || !provider || !propertyId || !direction || !sender) {
      console.warn('[recordMessage] params manquants', { userId, provider, propertyId, direction, sender })
      return { ok: false, error: 'missing_params' }
    }

    // OTA : si non fournie par le caller, lookup best-effort (utile surtout
    // pour l'entrant Channex qui n'a pas l'OTA sous la main).
    const resolvedOta = ota || (await resolveOta(userId, bookingId))

    const row = {
      user_id:         userId,
      provider,
      ota:             resolvedOta,
      property_id:     String(propertyId),
      booking_id:      bookingId != null ? String(bookingId) : null,
      provider_msg_id: providerMsgId != null ? String(providerMsgId) : null,
      direction,
      sender,
      body:            body || '',
      kind:            kind || 'message',
      sent_at:         sentAt || new Date().toISOString()
    }

    // ── Cas 1 : message AVEC id provider (entrants) ──────────────────────────
    // Idempotence garantie par l'index unique partiel (provider, provider_msg_id).
    // ON CONFLICT DO NOTHING via ignoreDuplicates.
    if (row.provider_msg_id) {
      const { error } = await supabase
        .from('messages')
        .upsert(row, { onConflict: 'provider,provider_msg_id', ignoreDuplicates: true })
      if (error) {
        console.error('[recordMessage] upsert echec', error.message)
        return { ok: false, error: error.message }
      }
      return { ok: true, skipped: false }
    }

    // ── Cas 2 : message SANS id provider (sortants générés par nous) ─────────
    // Pas de clé d'unicité base possible → dédup logique sur une fenêtre courte,
    // cohérente avec api/channel-webhook.js (même body, même résa, non répété).
    const since = new Date(Date.now() - OUTBOUND_DEDUP_WINDOW_MS).toISOString()
    let dupQuery = supabase
      .from('messages')
      .select('id')
      .eq('user_id', userId)
      .eq('sender', sender)
      .eq('direction', direction)
      .eq('body', row.body)
      .gte('created_at', since)
      .limit(1)
    dupQuery = row.booking_id
      ? dupQuery.eq('booking_id', row.booking_id)
      : dupQuery.is('booking_id', null)

    const { data: dup } = await dupQuery
    if (dup && dup.length) {
      return { ok: true, skipped: true, reason: 'duplicate_outbound' }
    }

    const { error: insErr } = await supabase.from('messages').insert(row)
    if (insErr) {
      console.error('[recordMessage] insert echec', insErr.message)
      return { ok: false, error: insErr.message }
    }
    return { ok: true, skipped: false }

  } catch (e) {
    // Fail-safe ultime : aucune exception ne remonte au producteur.
    console.error('[recordMessage] exception', e.message)
    return { ok: false, error: e.message }
  }
}

module.exports = { recordMessage }
