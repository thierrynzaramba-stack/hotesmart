// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Cron arrival code
// Generation du code d'acces et envoi du message d'arrivee JUSTE-A-TEMPS :
// declenche le jour meme de l'arrivee du voyageur, avec les dates a jour.
//
// Conditions cumulees pour traiter un booking :
//   1. property_status = 'ready' (menage termine, voyageur detache)
//   2. Un booking a arrival = today sur cette propriete
//   3. Template 'menage_done' actif existe pour ce bien
//   4. Heure courante >= earliest_send_time du template (Europe/Paris)
//   5. Pas deja envoye pour ce booking (message_sent_log)
//
// Validite du code Seam :
//   starts_at = maintenant (moment de generation)
//   ends_at   = departure_date + knowledge.checkout + 1h (marge de securite)
// ═══════════════════════════════════════════════════════════════════════════

const { supabase } = require('./cron-shared')
const { sendViaBeds24 } = require('./cron-beds24')
const { buildMessage } = require('./message-builder')
const { generateCode } = require('./providers/seam')

// ─── Helpers ────────────────────────────────────────────────────────────────
function getParisOffsetMinutes(date) {
  const parisParts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date)
  const get = (type) => Number(parisParts.find(p => p.type === type)?.value || 0)
  const parisAsUTC = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour'), get('minute'), get('second')
  )
  return (parisAsUTC - date.getTime()) / (60 * 1000)
}

// Construit une Date UTC a partir d'une date YYYY-MM-DD et heure HH:MM
// interpretees en heure Europe/Paris.
function combineDateAndTime(dateStr, timeStr) {
  if (!dateStr) return null
  const [hStr, mStr] = (timeStr || '00:00').trim().split(':')
  const h = Number(hStr) || 0
  const m = Number(mStr) || 0
  const iso = `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`
  const naive = new Date(iso)
  const offsetMin = getParisOffsetMinutes(naive)
  return new Date(naive.getTime() - offsetMin * 60 * 1000)
}

// Heure actuelle a Paris au format HH:MM
function nowParisHHMM() {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date())
}

// Date du jour a Paris au format YYYY-MM-DD
function todayParisISO() {
  const parts = new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date())
  return parts // "2026-04-21"
}

// Recupere la cle Seam de l'utilisateur (base + fallback env)
async function getSeamKey(userId) {
  const { data } = await supabase
    .from('api_keys')
    .select('seam_api_key, seam_enabled')
    .eq('user_id', userId)
    .maybeSingle()
  if (data?.seam_enabled === false) return null
  return data?.seam_api_key || process.env.SEAM_API_KEY || null
}

// ─── processArrivalCodes ────────────────────────────────────────────────────
// A appeler pour chaque propriete lors de chaque tick de cron.
async function processArrivalCodes(userId, beds24Key, property, bookings, results) {
  // 1. Verifier que le statut est 'ready'
  const { data: status } = await supabase
    .from('property_status')
    .select('status')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .maybeSingle()

  if (status?.status !== 'ready') {
    return // Pas pret pour un nouvel arrivant
  }

  // 2. Chercher un booking avec arrival = today sur cette propriete
  const today = todayParisISO()
  const todayArrival = (bookings || []).find(b =>
    String(b.propertyId || b.propId) === String(property.id) &&
    b.arrival === today &&
    b.status !== 'cancelled' && b.status !== 'black'
  )

  if (!todayArrival) return

  // 3. Charger le(s) template(s) menage_done actifs pour ce bien
  const { data: templates } = await supabase
    .from('message_templates')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('event_type', 'menage_done')
    .eq('active', true)

  if (!templates?.length) {
    console.log(`[ArrivalCode] Pas de template menage_done actif pour ${property.id}`)
    return
  }

  // 4. Charger la base de connaissance (type='fixed') pour les placeholders
  //    et aussi l'heure de checkout pour le ends_at du code Seam.
  const { data: knowledgeRows } = await supabase
    .from('knowledge')
    .select('key, value')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('type', 'fixed')

  const knowledge = {}
  ;(knowledgeRows || []).forEach(r => { knowledge[r.key] = r.value })

  const checkoutTime = (knowledge.checkout || '11:00').trim()
  const guestName = `${todayArrival.firstName || ''} ${todayArrival.lastName || ''}`.trim() || 'Voyageur'
  const nowHHMM = nowParisHHMM()

  // 5. Pour chaque template eligible, verifier l'heure et envoyer
  for (const template of templates) {
    const earliest = template.earliest_send_time || '15:00'
    if (nowHHMM < earliest) {
      console.log(`[ArrivalCode] ${property.id} : trop tot (${nowHHMM} < ${earliest}), report au prochain tick`)
      continue
    }

    // 6. Deja envoye pour ce booking + template ?
    const { data: alreadySent } = await supabase
      .from('message_sent_log')
      .select('id')
      .eq('user_id', userId)
      .eq('booking_id', String(todayArrival.id))
      .eq('template_id', template.id)
      .maybeSingle()

    if (alreadySent) continue

    // 7. Generer le code Seam (si une serrure est configuree)
    let seamCode = null
    let seamCodeId = null

    if (template.lock_id) {
      try {
        const { data: lock } = await supabase
          .from('locks')
          .select('seam_device_id')
          .eq('id', template.lock_id)
          .single()

        if (lock?.seam_device_id) {
          const apiKey = await getSeamKey(userId)
          if (!apiKey) {
            console.warn(`[ArrivalCode] Cle Seam manquante pour user ${userId}`)
          } else {
            // starts_at = maintenant, ends_at = departure + checkout + 1h
            const startsAt = new Date()
            const checkoutMoment = combineDateAndTime(todayArrival.departure, checkoutTime)
            const endsAt = checkoutMoment
              ? new Date(checkoutMoment.getTime() + 60 * 60 * 1000) // +1h marge
              : new Date(Date.now() + 72 * 60 * 60 * 1000) // fallback 72h

            const result = await generateCode({
              seamDeviceId: lock.seam_device_id,
              guestName,
              startsAt: startsAt.toISOString(),
              endsAt:   endsAt.toISOString(),
              apiKey
            })

            seamCode = result.code
            seamCodeId = result.seam_code_id

            if (seamCode) {
              await supabase.from('access_codes').insert({
                lock_id: template.lock_id,
                booking_id: String(todayArrival.id),
                property_id: String(property.id),
                seam_code_id: seamCodeId,
                code: seamCode,
                starts_at: startsAt.toISOString(),
                ends_at: endsAt.toISOString(),
                status: 'active'
              })
              console.log(`[ArrivalCode] Code genere booking ${todayArrival.id} : ${seamCode} (valide jusqu'a ${endsAt.toISOString()})`)
            } else {
              console.warn(`[ArrivalCode] Code Seam null apres polling pour booking ${todayArrival.id}`)
            }
          }
        }
      } catch (err) {
        console.error(`[ArrivalCode] Erreur generation code booking ${todayArrival.id}:`, err.message)
      }
    }

    // 8. Construire et envoyer le message
    const message = buildMessage(template, todayArrival, guestName, seamCode, knowledge)
    if (!message) {
      console.log(`[ArrivalCode] Template vide, skip booking ${todayArrival.id}`)
      continue
    }

    try {
      // Log conversation
      await supabase.from('conversations').insert({
        user_id: userId,
        property_id: String(property.id),
        guest_name: guestName,
        guest_message: '[AUTO: arrival_code]',
        agent_reply: message,
        book_id: String(todayArrival.id)
      })

      // Envoi via Beds24 (respecte le flag DRY RUN)
      await sendViaBeds24(beds24Key, todayArrival.id, message)

      // Log dans message_sent_log pour eviter un renvoi au prochain tick
      await supabase.from('message_sent_log').insert({
        user_id: userId,
        booking_id: String(todayArrival.id),
        template_id: template.id,
        status: 'sent',
        sent_at: new Date().toISOString(),
        payload: JSON.stringify({
          message, seam_code: seamCode, seam_code_id: seamCodeId,
          property_id: String(property.id), lock_id: template.lock_id || null
        })
      })

      console.log(`[ArrivalCode] Message envoye booking ${todayArrival.id} (template ${template.id})`)
      results.totalAutoMessages = (results.totalAutoMessages || 0) + 1
    } catch (err) {
      console.error(`[ArrivalCode] Erreur envoi booking ${todayArrival.id}:`, err.message)
    }
  }
}

module.exports = { processArrivalCodes }
