// api/guestflow-proposer.js — « Proposer une réponse » (messagerie V5, lot 2
// étape 2 ; spec-refonte-ui-v5-lot-messages.md §3.4).
//
// POST { bookingId, propertyId? } -> { ok: true } et une tâche
// `pending_validation` déposée : la proposition apparaît dans le fil.
//
// ⚠ RIEN N'EST DUPLIQUÉ DU CRON. La génération est CELLE de
// lib/cron-classify (`preparerLot` + `classifierLot` : prompt, connaissances,
// état des envois) et la garde de coût est CELLE de lib/guestflow-garde
// (plafond jour + délai après échecs). Cet endpoint ne fait que : garder,
// charger le fil, appeler, déposer la tâche.
//
// Refus parlants, jamais silencieux :
//  - 409 rien_en_attente : aucun message du voyageur n'attend de réponse ;
//  - 409 deja_propose    : une proposition attend déjà la validation ;
//  - 409 en_pause        : kill switch actif sur le bien ;
//  - 429 garde_ia        : plafond ou délai de la garde IA.
//
// ⚠ Si l'IA classe le lot « intervention » ou « info inconnue », on NE DÉPOSE
// RIEN : déposer la tâche ici court-circuiterait l'alerte SMS du cron (sa
// garde verrait la tâche et se tairait). On répond le motif, et le cron
// traitera le lot entièrement à son prochain passage.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { preparerLot, classifierLot, buildKnowledgeText, etatDesEnvois } = require('../lib/cron-classify')
const { peutAppeler, noterAppel } = require('../lib/guestflow-garde')
const { isAutomationPaused } = require('../lib/cron-shared')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async function handler (req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const { bookingId, propertyId } = req.body || {}
  if (!bookingId) return res.status(400).json({ error: 'bookingId requis' })

  // La réservation désigne le compte ET le bien — même garde que l'envoi
  // manuel (api/channel-message.js) : écrire une proposition est un geste
  // du domaine messages.
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write',
    booking: bookingId, bookingRequis: true,
    bien: propertyId || null
  })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const snap = garde.booking?.snapshot || {}

  try {
    const { data: bien, error: eBien } = await supabase.from('properties')
      .select('*').eq('user_id', userId)
      .eq('provider_property_id', String(garde.booking.property_id)).maybeSingle()
    if (eBien || !bien) return res.status(404).json({ error: 'Bien introuvable' })
    // ⚠ PIEGE N°1 DU DEPOT : agent_tasks, knowledge, la garde IA et le kill
    // switch sont cles sur la REFERENCE PROVIDER (TEXT), jamais l'UUID. Le
    // cron passe un objet property dont `id` EST cette reference : on fait
    // pareil, l'UUID reste a cote.
    const refBien = String(bien.provider_property_id)
    const propertyPourIA = { ...bien, id: refBien, uuid: bien.id }

    if (await isAutomationPaused(userId, refBien)) {
      return res.status(409).json({ error: 'en_pause', message: 'Automatisation en pause sur ce bien.' })
    }

    // Une proposition à la fois : la valider ou la rejeter d'abord (étape 3,
    // ou l'ancienne messagerie en attendant).
    const { data: attente, error: eT } = await supabase.from('agent_tasks')
      .select('id').eq('user_id', userId).eq('book_id', String(bookingId))
      .eq('status', 'pending_validation').limit(1)
    if (eT) return res.status(503).json({ error: 'Lecture impossible' })
    if (attente && attente.length) {
      return res.status(409).json({ error: 'deja_propose', message: 'Une proposition attend déjà votre validation.' })
    }

    // La garde de coût du cron, à l'identique : un hôte qui clique en boucle
    // ne vide pas la clé IA.
    const decision = await peutAppeler(supabase, { userId, propertyId: refBien, bookingId })
    if (decision && decision.ok === false) {
      return res.status(429).json({ error: 'garde_ia', message: 'Trop d’appels récents : réessayez dans quelques minutes.' })
    }

    // Le fil, depuis le coeur (table messages) — jamais un provider.
    const { data: msgs, error: eM } = await supabase.from('messages')
      .select('direction, kind, body, sent_at')
      .eq('user_id', userId).eq('booking_id', String(bookingId))
      .order('sent_at', { ascending: true }).limit(500)
    if (eM) return res.status(503).json({ error: 'Lecture impossible' })
    const thread = (msgs || []).map(m => ({
      source: m.direction === 'inbound' ? 'guest' : (m.kind === 'auto' ? 'auto' : 'host'),
      message: m.body || '', time: m.sent_at
    }))
    const guestName = [snap.firstName, snap.lastName].filter(Boolean).join(' ').trim() || 'Voyageur'
    const lot = preparerLot(thread, guestName)
    if (!lot.enAttente.length) {
      return res.status(409).json({ error: 'rien_en_attente', message: 'Aucun message du voyageur n’attend de réponse.' })
    }

    const { data: knowledge } = await supabase.from('knowledge')
      .select('*').eq('user_id', userId).eq('property_id', refBien)
    const knowledgeText = buildKnowledgeText(knowledge || [])
    const blocEtat = await etatDesEnvois(userId, refBien, String(bookingId))

    let classification
    try {
      classification = await classifierLot({
        userId, property: propertyPourIA, bookingId: String(bookingId), guestName,
        guestPhone: snap.guestPhone || null,
        arrival: snap.arrival || null, departure: snap.departure || null,
        knowledgeText, results: null, lot, blocEtat
      })
    } catch (err) {
      await noterAppel(supabase, { userId, propertyId: refBien, bookingId: String(bookingId), ok: false, erreur: err?.message })
      console.error('[guestflow-proposer] classification echec', err.message)
      return res.status(502).json({ error: 'ia_indisponible', message: 'L’assistant n’a pas pu répondre, réessayez.' })
    }
    await noterAppel(supabase, { userId, propertyId: refBien, bookingId: String(bookingId), ok: true, modele: classification.modele || null })

    if (!classification.auto_reply) {
      // Intervention / info inconnue : le cron alertera au prochain passage.
      return res.status(200).json({
        ok: true, proposition: false, type: classification.type,
        message: 'L’assistant ne propose pas de réponse : ce message demande votre intervention.'
      })
    }

    const { error: eIns } = await supabase.from('agent_tasks').insert({
      user_id: userId,
      property_id: refBien,
      book_id: String(bookingId),
      guest_name: guestName,
      guest_message: lot.message,
      guest_phone: snap.guestPhone || null,
      arrival: snap.arrival || null,
      departure: snap.departure || null,
      task_type: classification.type,
      summary: classification.reason,
      suggested_reply: classification.auto_reply,
      status: 'pending_validation',
      source_thread: lot.sortedThread.map(m => ({ source: m.source, message: m.message, time: m.time })),
      sub_tasks: []
    })
    if (eIns) {
      console.error('[guestflow-proposer] depot tache echec', eIns.message)
      return res.status(500).json({ error: 'Enregistrement impossible' })
    }
    return res.status(200).json({ ok: true, proposition: true, type: classification.type })
  } catch (err) {
    console.error('[guestflow-proposer] exception', err.message)
    return res.status(500).json({ error: 'Erreur interne' })
  }
}
