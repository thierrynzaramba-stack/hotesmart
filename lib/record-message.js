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
    // Idempotence via l'index unique PARTIEL (provider, provider_msg_id) WHERE
    // provider_msg_id is not null. Cet index partiel ne peut pas etre cible par
    // ON CONFLICT en supabase-js -> SELECT-then-INSERT. L'index reste le backstop
    // atomique : en cas de course (23505), on traite comme un skip.
    if (row.provider_msg_id) {
      const { data: exists } = await supabase
        .from('messages')
        .select('id')
        .eq('provider', row.provider)
        .eq('provider_msg_id', row.provider_msg_id)
        .limit(1)
      if (exists && exists.length) {
        return { ok: true, skipped: true, reason: 'duplicate_inbound' }
      }

      // ── L'ECHO DU PROVIDER ──────────────────────────────────────────────
      // ⚠ MESURE LE 11 SEPTEMBRE 2026 : un message automatique parti a 21:10
      // nous est revenu de Channex a 22:09, avec un `provider_msg_id` neuf.
      // La dedup logique ne pouvait pas le voir — sa fenetre est de 10 minutes
      // et l'echo passe par CETTE branche, qui ne compare que l'identifiant.
      // Le voyageur voyait son message deux fois dans le fil.
      //
      // On RECONCILIE au lieu de supprimer : notre ligne atteste que nous avons
      // envoye (et porte `kind = 'auto'`), l'echo apporte l'identite du message
      // chez l'OTA. Poser l'identifiant sur notre ligne garde les deux
      // informations et n'en duplique aucune. Rien n'est perdu, contrairement a
      // un simple « on ignore l'echo ».
      if (row.direction === 'outbound' && row.booking_id) {
        const { data: mien } = await supabase
          .from('messages')
          .select('id')
          .eq('user_id', row.user_id)
          .eq('booking_id', row.booking_id)
          .eq('direction', 'outbound')
          .eq('body', row.body)
          .is('provider_msg_id', null)
          .order('created_at', { ascending: false })
          .limit(1)
        if (mien && mien.length) {
          const { error: majErr } = await supabase
            .from('messages')
            .update({ provider_msg_id: row.provider_msg_id })
            .eq('id', mien[0].id)
            .is('provider_msg_id', null)   // course : un autre tick a pu le faire
          if (!majErr) return { ok: true, skipped: true, reason: 'echo_reconcilie' }
          console.warn('[recordMessage] reconciliation echo echouee', majErr.message)
        }
      }

      const { error: insErr } = await supabase.from('messages').insert(row)
      if (insErr) {
        // 23505 = violation unique (course rare entre SELECT et INSERT) :
        // l'index partiel a fait son office -> skip, pas une erreur (logs propres).
        if (insErr.code === '23505') {
          return { ok: true, skipped: true, reason: 'race_23505' }
        }
        console.error('[recordMessage] insert echec', insErr.message)
        return { ok: false, error: insErr.message }
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
      // ⚠ 23505 = l'index unique partiel `messages_sans_msgid_unique_idx` a
      // tranche une course que le SELECT ci-dessus ne pouvait pas voir : les
      // deux ticks ont lu avant que l'un d'eux n'ecrive. 23 groupes de doublons
      // etaient nes de cette course avant que l'index n'existe. C'est un SKIP,
      // pas une panne — le message est bien en base, ecrit par l'autre tick.
      if (insErr.code === '23505') {
        return { ok: true, skipped: true, reason: 'race_23505_outbound' }
      }
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
