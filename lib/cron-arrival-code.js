// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Cron arrival code (architecture découplée en 2 phases)
// ═══════════════════════════════════════════════════════════════════════════
//
// PHASE 1 — CRÉATION DU CODE
//   Pour chaque booking arrivant aujourd'hui et sans access_codes :
//     - Crée le code côté Seam (asynchrone côté Seam)
//     - Insert access_codes avec code=null, seam_code_id, status='pending'
//     - NE FAIT RIEN D'AUTRE (pas d'envoi message)
//
// PHASE 2 — RÉCUPÉRATION DU PIN + ENVOI DU MESSAGE
//   Pour chaque access_codes 'pending' dont le booking arrive aujourd'hui :
//   Conditions cumulatives pour envoyer :
//     - now >= access_codes.created_at + 20 minutes (délai de sécurité Seam)
//     - now >= earliest_send_time du template (Europe/Paris)
//     - Pas déjà dans message_sent_log
//     - Ménage du booking précédent validé (last_menage_at > prev departure)
//   Si toutes OK :
//     - Si code=null : GET Seam pour récupérer le PIN, update en base
//     - Build message, send via Beds24, log message_sent_log
//     - Update access_codes.status='active'
//
// Avantage sur l'ancienne archi : le code a le temps d'être généré côté Seam
// (20 minutes mini) avant qu'on n'essaie de récupérer le PIN. Évite les codes
// orphelins avec PIN=null de la version précédente.
// ═══════════════════════════════════════════════════════════════════════════

const { supabase, getPropertyMode } = require('./cron-shared')
const { sendViaBeds24 } = require('./cron-beds24')
const { buildMessage } = require('./message-builder')
const { generateCode, getSeamKey: getSeamKeyFromProvider } = require('./providers/seam')

// Délai minimum entre la création du code Seam et son envoi au voyageur.
// Garantit que Seam a eu le temps de générer le PIN pour les serrures offline.
// En pratique, Seam retourne le PIN en quelques secondes, donc 5 min est une
// marge largement suffisante. Overridable via env TEST_MIN_DELAY_MS pour les
// tests locaux ou pour ajuster sans re-déployer si besoin un jour.
const MIN_DELAY_AFTER_CREATION_MS = Number(process.env.TEST_MIN_DELAY_MS) || 5 * 60 * 1000

// ─── Helpers timezone ──────────────────────────────────────────────────────
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

function combineDateAndTime(dateStr, timeStr) {
  if (!dateStr) return null
  const [hStr, mStr] = (timeStr || '00:00').trim().split(':')
  const h = Number(hStr) || 0
  const m = Number(mStr) || 0
  const iso = `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`
  const naive = new Date(iso)
  const offsetMin = getParisOffsetMinutes(naive)
  return new Date(naive.getTime() - offsetMin * 60 * 1000)
}

function nowParisHHMM() {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date())
}

function todayParisISO() {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date())
}

// ─── Chargement knowledge (placeholders fixes) ─────────────────────────────
async function loadKnowledge(userId, propertyId) {
  const { data } = await supabase
    .from('knowledge')
    .select('key, value')
    .eq('user_id', userId)
    .eq('property_id', String(propertyId))
    .eq('type', 'fixed')
  const knowledge = {}
  ;(data || []).forEach(r => { knowledge[r.key] = r.value })
  return knowledge
}

// ─── Vérification : ménage précédent validé ? ──────────────────────────────
async function isMenageValidated(userId, propertyId, todayArrival) {
  const today = todayArrival.arrival

  const { data: pastSnapshots } = await supabase
    .from('bookings_snapshot')
    .select('snapshot')
    .eq('user_id', userId)
    .eq('property_id', String(propertyId))
    .order('updated_at', { ascending: false })
    .limit(50)

  const previousDeparture = (pastSnapshots || [])
    .map(r => r.snapshot)
    .filter(s => s && s.departure && s.status !== 'cancelled' && s.status !== 'black')
    .filter(s => s.departure <= today && String(s.bookingId || s.id) !== String(todayArrival.id))
    .sort((a, b) => b.departure.localeCompare(a.departure))[0]

  if (!previousDeparture) return true // premier voyageur, pas de ménage requis

  const { data: propStatus } = await supabase
    .from('property_status')
    .select('last_menage_at')
    .eq('user_id', userId)
    .eq('property_id', String(propertyId))
    .maybeSingle()

  if (!propStatus?.last_menage_at) return false

  const menageMoment = new Date(propStatus.last_menage_at)
  const prevDepartureDate = new Date(previousDeparture.departure + 'T00:00:00Z')
  return menageMoment > prevDepartureDate
}

// ─── PHASE 1 : création du code si absent ──────────────────────────────────
async function ensureCodeCreated(userId, property, todayArrival, template) {
  if (!template.lock_id) return null // pas de serrure configurée, rien à créer

  // Déjà un code en base pour ce booking + template ?
  const { data: existing } = await supabase
    .from('access_codes')
    .select('id, seam_code_id, code, starts_at, ends_at, status, created_at')
    .eq('booking_id', String(todayArrival.id))
    .eq('lock_id', template.lock_id)
    .maybeSingle()

  if (existing) return existing // déjà créé, on renvoie tel quel

  // Pas de code en base : créer côté Seam
  const { data: lock } = await supabase
    .from('locks')
    .select('seam_device_id')
    .eq('id', template.lock_id)
    .single()

  if (!lock?.seam_device_id) {
    console.warn(`[ArrivalCode] Serrure ${template.lock_id} sans seam_device_id`)
    return null
  }

  const apiKey = await getSeamKeyFromProvider(userId)
  if (!apiKey) {
    console.warn(`[ArrivalCode] Clé Seam manquante pour user ${userId}`)
    return null
  }

  // Fenêtre de validité du code : maintenant → departure + checkout + 1h
  const knowledge = await loadKnowledge(userId, property.id)
  const checkoutTime = (knowledge.checkout || '11:00').trim()
  const startsAt = new Date()
  const checkoutMoment = combineDateAndTime(todayArrival.departure, checkoutTime)
  const endsAt = checkoutMoment
    ? new Date(checkoutMoment.getTime() + 60 * 60 * 1000)
    : new Date(Date.now() + 72 * 60 * 60 * 1000)

  const guestName = `${todayArrival.firstName || ''} ${todayArrival.lastName || ''}`.trim() || 'Voyageur'

  let seamResult = null
  try {
    seamResult = await generateCode({
      seamDeviceId: lock.seam_device_id,
      guestName,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      apiKey
    })
  } catch (err) {
    console.error(`[ArrivalCode] Erreur création Seam booking ${todayArrival.id}:`, err.message)
    return null
  }

  if (!seamResult?.seam_code_id) {
    console.warn(`[ArrivalCode] Seam n'a pas retourné d'access_code_id booking ${todayArrival.id}`)
    return null
  }

  // Insert en base avec code=null si pas encore dispo (récupéré plus tard)
  const { data: inserted, error: insertErr } = await supabase
    .from('access_codes')
    .insert({
      lock_id: template.lock_id,
      booking_id: String(todayArrival.id),
      property_id: String(property.id),
      seam_code_id: seamResult.seam_code_id,
      code: seamResult.code || null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: 'pending'
    })
    .select()
    .single()

  if (insertErr) {
    console.error(`[ArrivalCode] Erreur insert access_codes booking ${todayArrival.id}:`, insertErr.message)
    return null
  }

  console.log(`[ArrivalCode] PHASE 1 — Code créé Seam pour booking ${todayArrival.id} (${seamResult.code ? 'PIN dispo: ' + seamResult.code : 'PIN async, récupération plus tard'})`)
  return inserted
}

// ─── PHASE 2 : récupération du PIN si manquant + envoi du message ──────────
async function sendArrivalMessage(userId, beds24Key, property, todayArrival, template, accessCode, knowledge) {
  const now = new Date()
  const guestName = `${todayArrival.firstName || ''} ${todayArrival.lastName || ''}`.trim() || 'Voyageur'

  // Vérif délai de 20 min après création du code
  if (accessCode?.created_at) {
    const createdAt = new Date(accessCode.created_at)
    const elapsed = now.getTime() - createdAt.getTime()
    if (elapsed < MIN_DELAY_AFTER_CREATION_MS) {
      const remainingMin = Math.ceil((MIN_DELAY_AFTER_CREATION_MS - elapsed) / 60000)
      console.log(`[ArrivalCode] Délai non atteint booking ${todayArrival.id} (encore ${remainingMin} min)`)
      return
    }
  }

  // Vérif earliest_send_time du template
  const earliest = template.earliest_send_time || '15:00'
  if (nowParisHHMM() < earliest) {
    console.log(`[ArrivalCode] Trop tôt pour ${todayArrival.id} (${nowParisHHMM()} < ${earliest})`)
    return
  }

  // Déjà envoyé ?
  const { data: alreadySent } = await supabase
    .from('message_sent_log')
    .select('id')
    .eq('user_id', userId)
    .eq('booking_id', String(todayArrival.id))
    .eq('template_id', template.id)
    .maybeSingle()
  if (alreadySent) return

  // Ménage validé ?
  const menageOk = await isMenageValidated(userId, property.id, todayArrival)
  if (!menageOk) {
    console.log(`[ArrivalCode] Ménage non validé pour booking ${todayArrival.id}, envoi différé`)
    return
  }

  // Récupérer le PIN si pas encore en base (access_codes.code = null)
  let seamCode = accessCode?.code || null
  if (accessCode && !seamCode && accessCode.seam_code_id) {
    try {
      const apiKey = await getSeamKeyFromProvider(userId)
      if (apiKey) {
        const r = await fetch(
          `https://connect.getseam.com/access_codes/get?access_code_id=${accessCode.seam_code_id}`,
          { headers: { 'Authorization': `Bearer ${apiKey}` } }
        )
        const d = await r.json()
        seamCode = d.access_code?.code || null
        if (seamCode) {
          await supabase
            .from('access_codes')
            .update({ code: seamCode })
            .eq('id', accessCode.id)
          console.log(`[ArrivalCode] PIN récupéré depuis Seam pour booking ${todayArrival.id}: ${seamCode}`)
        } else {
          console.warn(`[ArrivalCode] PIN toujours null côté Seam pour booking ${todayArrival.id}, réessai au prochain tick`)
          return
        }
      }
    } catch (err) {
      console.error(`[ArrivalCode] Erreur récupération PIN booking ${todayArrival.id}:`, err.message)
      return
    }
  }

  // Construire et envoyer le message
  const message = buildMessage(template, todayArrival, guestName, seamCode, knowledge)
  if (!message) return

  // Detection mode auto vs test (cf. pattern de cron-messages.js).
  // En mode 'auto' : envoi direct via Beds24.
  // Sinon (test/manuel) : la tache atterrit dans la to-do agent_tasks pour
  // validation manuelle par l hote avant envoi.
  const propMode = await getPropertyMode(userId, String(property.id))

  try {
    if (propMode === 'auto') {
      // Mode AUTO : envoi direct au voyageur
      await supabase.from('conversations').insert({
        user_id: userId,
        property_id: String(property.id),
        guest_name: guestName,
        guest_message: '[AUTO: arrival_code]',
        agent_reply: message,
        book_id: String(todayArrival.id)
      })

      await sendViaBeds24(beds24Key, todayArrival.id, message)

      await supabase.from('message_sent_log').insert({
        user_id: userId,
        booking_id: String(todayArrival.id),
        template_id: template.id,
        sent_at: new Date().toISOString()
      })

      console.log(`[ArrivalCode] Mode Auto — code envoye booking ${todayArrival.id} (template ${template.id})`)
    } else {
      // Mode TEST/MANUEL : creation d une tache pending_validation dans la to-do.
      // Le message_sent_log est insere AUSSI pour empecher le cron de re-creer
      // une tache au prochain tick. La to-do hote sert de point de validation.
      await supabase.from('agent_tasks').insert({
        user_id: userId,
        property_id: String(property.id),
        book_id: String(todayArrival.id),
        guest_name: guestName,
        guest_message: '[AUTO: arrival_code]',
        task_type: 'auto_message',
        summary: 'Message automatique "arrival_code" a valider avant envoi',
        suggested_reply: message,
        status: 'pending_validation',
        sub_tasks: []
      })

      await supabase.from('message_sent_log').insert({
        user_id: userId,
        booking_id: String(todayArrival.id),
        template_id: template.id,
        sent_at: new Date().toISOString()
      })

      console.log(`[ArrivalCode] Mode Test — code en attente booking ${todayArrival.id} (template ${template.id})`)
    }

    // Quel que soit le mode, on bascule l access_code en 'active' pour ne pas
    // re-tenter de l envoyer plus tard. L hote peut l envoyer manuellement via la to-do.
    if (accessCode) {
      await supabase
        .from('access_codes')
        .update({ status: 'active' })
        .eq('id', accessCode.id)
    }
  } catch (err) {
    console.error(`[ArrivalCode] Erreur envoi booking ${todayArrival.id}:`, err.message)
  }
}

// ─── ORCHESTRATEUR — appelé par le cron pour chaque propriété ──────────────
async function processArrivalCodes(userId, beds24Key, property, bookings, results) {
  const today = todayParisISO()

  const todayArrival = (bookings || []).find(b =>
    String(b.propertyId || b.propId) === String(property.id) &&
    b.arrival === today &&
    b.status !== 'cancelled' && b.status !== 'black'
  )

  if (!todayArrival) return

  const { data: templates } = await supabase
    .from('message_templates')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', String(property.id))
    .eq('event_type', 'menage_done')
    .eq('active', true)

  if (!templates?.length) return

  const knowledge = await loadKnowledge(userId, property.id)

  for (const template of templates) {
    // Phase 1 : s'assurer que le code existe (création si absent)
    const accessCode = await ensureCodeCreated(userId, property, todayArrival, template)

    // Phase 2 : tenter l'envoi si conditions réunies
    await sendArrivalMessage(userId, beds24Key, property, todayArrival, template, accessCode, knowledge)

    results.totalAutoMessages = (results.totalAutoMessages || 0) + 0 // compté à l'envoi réel
  }
}

module.exports = { processArrivalCodes }
