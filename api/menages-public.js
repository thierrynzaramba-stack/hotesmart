const { createClient } = require('@supabase/supabase-js')
const { sendViaBeds24 } = require('../lib/cron-beds24')
const { markReady } = require('../lib/cron-property-status')
const { buildMessage } = require('../lib/message-builder')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { token } = req.query
  if (!token) return res.status(401).json({ error: 'Token manquant' })

  if (req.method === 'POST') {
    const { action, event_ids, booking_id, property_id } = req.body || {}

    if (action === 'markRead' && event_ids?.length) {
      await supabase.from('menage_events').update({ read: true })
        .in('id', event_ids).eq('token', token)
      return res.json({ success: true })
    }

    if (action === 'markDone' && booking_id && property_id) {
      // Le clic "Marquer fait" de la femme de menage fait UNIQUEMENT basculer
      // le statut du logement en 'ready' (contrat locatif cloture, voyageur
      // detache). La generation du code Seam et l'envoi du message au prochain
      // voyageur sont deleguees au cron, qui les declenchera le JOUR meme de
      // l'arrivee du voyageur suivant. Cela evite les problemes lies a :
      //   - modifications d'arrival/departure entre le menage et l'arrivee
      //   - annulations apres le menage (code cree pour rien)
      //   - codes crees trop en avance avec dates obsoletes
      try {
        const { data: tokenData } = await supabase
          .from('public_tokens').select('user_id').eq('token', token).maybeSingle()
        if (!tokenData) return res.status(401).json({ error: 'Token invalide' })

        const userId = tokenData.user_id

        try {
          await markReady(userId, property_id)
          console.log(`[Menage] Logement ${property_id} : statut -> ready`)
        } catch (err) {
          console.error('[Menage] Erreur markReady:', err.message)
          return res.status(500).json({ error: 'Erreur changement de statut' })
        }

        return res.json({ success: true, message: 'Menage marque, logement pret' })
      } catch (err) {
        console.error('[Menage] markDone erreur:', err.message)
        return res.status(500).json({ error: err.message })
      }
    }

    return res.status(400).json({ error: 'Action inconnue' })
  }

  // GET — planning public
  try {
    const { data: tokenData, error: tokenError } = await supabase
      .from('public_tokens').select('user_id, label, property_ids, visibility_days')
      .eq('token', token).maybeSingle()

    if (tokenError || !tokenData) return res.status(401).json({ error: 'Token invalide' })

    const userId         = tokenData.user_id
    const visibilityDays = tokenData.visibility_days || 30

    const { data: keyData } = await supabase
      .from('api_keys').select('api_key').eq('user_id', userId).eq('service', 'beds24').single()
    if (!keyData) return res.status(400).json({ error: 'Beds24 non configuré' })

    const beds24Key = keyData.api_key
    const propsRes  = await fetch('https://beds24.com/api/v2/properties', { headers: { token: beds24Key } })
    const propsData = await propsRes.json()
    const allProperties = propsData.data || []

    const allowedIds = tokenData.property_ids || []
    const properties = allowedIds.length
      ? allProperties.filter(p => allowedIds.includes(String(p.id))) : allProperties

    const today   = new Date(); today.setHours(0,0,0,0)
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + visibilityDays)
    // On remonte aussi les 14 derniers jours pour que la femme de menage
    // puisse marquer des menages en retard (ex: depart hier, menage fait
    // le lendemain). Au-dela de 14 jours on considere que le menage est
    // perdu et ne fait plus partie du planning actif.
    const minDate  = new Date(today); minDate.setDate(minDate.getDate() - 14)
    const dateFrom = minDate.toISOString().split('T')[0]
    const dateTo   = maxDate.toISOString().split('T')[0]

    const allBookings = []
    for (const prop of properties) {
      const r = await fetch(
        `https://beds24.com/api/v2/bookings?propId=${prop.id}&departureFrom=${dateFrom}&departureTo=${dateTo}`,
        { headers: { token: beds24Key } }
      )
      const d = await r.json()
      const propBookings = (d.data || [])
        .filter(b => String(b.propertyId) === String(prop.id))
        .map(b => ({ ...b, propName: prop.name, propId: prop.id }))
      allBookings.push(...propBookings)
    }

    const bookingIds = allBookings.map(b => String(b.id))
    let comments = []
    if (bookingIds.length) {
      const { data: cd } = await supabase.from('menage_comments')
        .select('booking_id, departure_date, comment, property_id')
        .eq('user_id', userId).in('booking_id', bookingIds)
      comments = cd || []
    }

    const { data: eventsData } = await supabase.from('menage_events').select('*')
      .eq('token', token).eq('read', false)
      .gte('created_at', new Date(Date.now() - visibilityDays * 86400000).toISOString())
      .order('created_at', { ascending: false }).limit(50)

    return res.json({
      bookings: allBookings, label: tokenData.label,
      property_ids: allowedIds, visibility_days: visibilityDays,
      comments, events: eventsData || []
    })

  } catch (err) {
    console.error('[MenagesPublic]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}

// ─── Génération code Seam ─────────────────────────────────────────────────────
async function generateSeamCode(userId, lockId, booking) {
  try {
    const { data: lock } = await supabase
      .from('locks').select('seam_device_id, brand, label').eq('id', lockId).single()
    if (!lock?.seam_device_id) return null

    const { data: keyRow } = await supabase
      .from('api_keys').select('seam_api_key').eq('user_id', userId).maybeSingle()
    const apiKey = keyRow?.seam_api_key || process.env.SEAM_API_KEY
    if (!apiKey) return null

    // Réutiliser un code existant pending (pas encore envoyé)
    const { data: existing } = await supabase.from('access_codes').select('code, seam_code_id, status')
      .eq('booking_id', String(booking.id)).eq('lock_id', lockId).maybeSingle()
    if (existing?.code && existing.status !== 'deleted') {
      console.log(`[Menage] Code existant réutilisé booking ${booking.id}: ${existing.code}`)
      return existing.code
    }

    const { generateCode } = require('../lib/providers/seam')
    const result = await generateCode({
      seamDeviceId: lock.seam_device_id,
      guestName:    `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur',
      startsAt:     new Date(booking.arrival).toISOString(),
      endsAt:       new Date(booking.departure + 'T23:59:59').toISOString(),
      apiKey
    })

    await supabase.from('access_codes').insert({
      lock_id: lockId, booking_id: String(booking.id),
      property_id: String(booking.propertyId || booking.propId),
      seam_code_id: result.seam_code_id, code: result.code,
      starts_at: result.starts_at, ends_at: result.ends_at, status: 'active'
    })

    console.log(`[Menage] Code généré booking ${booking.id}: ${result.code}`)
    return result.code
  } catch (err) {
    console.error('[Menage] Erreur generateSeamCode:', err.message)
    return null
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function saveAndSend(userId, propertyId, bookingId, template, guestName, message, beds24Key) {
  await supabase.from('conversations').insert({
    user_id: userId, property_id: String(propertyId),
    guest_name: guestName, guest_message: '[AUTO: menage_done]',
    agent_reply: message, book_id: String(bookingId)
  })
  await supabase.from('message_sent_log').insert({
    user_id: userId, booking_id: String(bookingId),
    template_id: template.id, status: 'sent'
  })
  // Envoi reel au voyageur via Beds24 (controle par SENDVIABEDS24_ENABLED).
  // Tant que le flag est false (defaut), on reste en DRY RUN : log + pas d'envoi.
  await sendViaBeds24(beds24Key, bookingId, message)
}

function applyEarliestHour(date, earliestTime) {
  const [h, m] = earliestTime.split(':').map(Number)
  const earliest = new Date(date)
  earliest.setHours(h, m, 0, 0)
  // Si l'heure calculée est avant l'heure min → reporter à l'heure min
  if (date < earliest) return earliest
  // Si l'heure min est déjà passée aujourd'hui → date inchangée
  return date
}

function parseDelayMs(value) {
  const map = { '0min':0, '10min':600000, '15min':900000, '30min':1800000, '1h':3600000, '2h':7200000 }
  return map[value] || 0
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('fr-FR', { day:'2-digit', month:'long', year:'numeric' })
}
