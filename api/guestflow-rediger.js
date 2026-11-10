// api/guestflow-rediger.js — l'IA rédige la réponse de l'hôte au voyageur
// (spec docs/specs/spec-info-manquante-choix.md, étape 1).
//
// POST { action: 'choix', bookingId, tacheId, choix: [{ question, reponse, precision? }] }
//   -> { ok: true, texte }   à partir des choix Oui / Non / Autre de l'hôte
//      sur les questions d'une tâche « information manquante ».
// POST { action: 'texte', bookingId, brouillon }
//   -> { ok: true, texte }   à partir de la réponse brute tapée par l'hôte
//      (bouton « IA » de la zone de saisie).
//
// ⚠ RIEN NE PART ET RIEN N'EST ÉCRIT. Le texte rendu va dans la zone de saisie
// de l'hôte, qui l'envoie par le chemin d'envoi existant. Cet endpoint n'écrit
// ni `messages`, ni `agent_tasks`, ni la base de connaissance.
//
// Refus parlants, jamais silencieux :
//  - 409 en_pause        : kill switch actif sur le bien ;
//  - 409 deja_traitee    : la tâche n'attend plus (traitée ailleurs) ;
//  - 409 sans_question   : la tâche ne porte pas de question (intervention,
//                          tâche système de pause ou d'arrêt) ;
//  - 409 questions_changees : le cron a complété la tâche depuis l'affichage
//                          de la carte (le voyageur a écrit encore) ;
//  - 429 garde_ia        : plafond PROPRE à l'hôte (10 rédactions par fil sur
//                          24 h), distinct de celui de l'agent ;
//  - 502 ia_indisponible : le modèle n'a pas répondu, ou rien d'utilisable.
const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { buildKnowledgeText, loadPromptingInstructions, modeleConfigure, requeteClassification } = require('../lib/cron-classify')
const { isAutomationPaused, anthropic } = require('../lib/cron-shared')
const { replisDuBien } = require('../lib/balises')
const { avecContexteIA } = require('../lib/ia/journal')
const { compterRequetes, requetesJusquIci } = require('../lib/compte-requetes')
const R = require('../lib/guestflow/rediger')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const ACTIONS = ['choix', 'texte']

module.exports = async function handler (req, res) {
  // ⚠ AVANT LE PREMIER REFUS, le 405 compris (dette 90).
  res.setHeader('Cache-Control', 'private, no-store')
  const t0 = Date.now()
  const repondre = (statut, corps) => {
    const n = requetesJusquIci()
    res.setHeader('Server-Timing', `db;desc="${n == null ? '?' : n} requêtes";dur=${Date.now() - t0}`)
    return res.status(statut).json(corps)
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const corps = req.body || {}
  const action = corps.action
  const bookingId = typeof corps.bookingId === 'string' || typeof corps.bookingId === 'number' ? String(corps.bookingId).trim() : ''
  if (!ACTIONS.includes(action) || !bookingId || bookingId.length > 200) {
    return res.status(400).json({ error: 'Demande invalide' })
  }

  await compterRequetes(async () => {
    // La réservation désigne le compte ET le bien — même garde que
    // « Proposer une réponse » et que l'envoi manuel.
    const garde = await requirePermission(req, res, {
      domaine: 'messages', niveau: 'write',
      booking: bookingId, bookingRequis: true,
      bien: corps.propertyId || null
    })
    if (!garde.ok) return
    const userId = garde.accountUserId
    const snap = garde.booking?.snapshot || {}
    try {
      const { data: bien, error: eBien } = await supabase.from('properties')
        .select('*').eq('user_id', userId)
        .eq('provider_property_id', String(garde.booking.property_id)).maybeSingle()
      if (eBien) return repondre(503, { error: 'Lecture impossible' })
      if (!bien) return repondre(404, { error: 'Bien introuvable' })
      // ⚠ PIÈGE N°1 DU DÉPÔT : agent_tasks, knowledge, la garde IA et le kill
      // switch sont clés sur la RÉFÉRENCE PROVIDER (TEXT), jamais l'UUID.
      const refBien = String(bien.provider_property_id)

      if (await isAutomationPaused(userId, refBien)) {
        return repondre(409, { error: 'en_pause', message: 'Automatisation en pause sur ce bien.' })
      }

      // ── L'entrée de l'hôte, validée AVANT tout appel au modèle ──────────
      let entree
      if (action === 'choix') {
        const tacheId = String(corps.tacheId || '').trim()
        if (!tacheId || tacheId.length > 64) return repondre(400, { error: 'Demande invalide' })
        const { data: tache, error: eT } = await supabase.from('agent_tasks')
          .select('id, book_id, property_id, task_type, status, summary, sub_tasks')
          .eq('user_id', userId).eq('id', tacheId).maybeSingle()
        if (eT) return repondre(503, { error: 'Lecture impossible' })
        // Une tâche d'un autre séjour ou d'un autre bien est introuvable : 404,
        // pas 403 (même règle que la clôture d'une proposition).
        if (!tache || String(tache.book_id) !== bookingId || String(tache.property_id) !== refBien) {
          return repondre(404, { error: 'Tâche introuvable' })
        }
        if (tache.task_type === 'info_unknown' && tache.status !== 'pending') {
          return repondre(409, { error: 'deja_traitee', statut: tache.status })
        }
        const questions = R.questionsDe(tache)
        if (!questions.length) return repondre(409, { error: 'sans_question' })
        const v = R.validerChoix(corps.choix, questions)
        // La carte de l'hôte précède un complément du cron : 409, l'écran relit.
        if (!v.ok) return repondre(v.erreur === 'questions_changees' ? 409 : 400, { error: v.erreur })
        entree = { choix: v.choix }
      } else {
        const v = R.validerBrouillon(corps.brouillon)
        if (!v.ok) return repondre(400, { error: v.erreur })
        entree = { brouillon: v.brouillon }
      }

      // Le plafond PROPRE à l'hôte (lib/guestflow/rediger.js) : compté dans le
      // journal `ia_appels`, jamais dans celui de l'agent. Lecture impossible :
      // on n'appelle pas (on ne sait pas si le plafond est atteint).
      const { data: recents, error: eJ } = await supabase.from('ia_appels').select('id')
        .eq('fonction', R.FONCTION_IA).eq('user_id', userId).eq('booking_id', bookingId)
        .gte('created_at', new Date(Date.now() - R.FENETRE_REDACTION_MS).toISOString())
        .limit(R.PLAFOND_REDACTION)
      if (eJ) return repondre(503, { error: 'Lecture impossible' })
      if ((recents || []).length >= R.PLAFOND_REDACTION) {
        return repondre(429, { error: 'garde_ia', message: `L’assistant a déjà été sollicité ${R.PLAFOND_REDACTION} fois sur cette conversation en 24 h : écrivez celle-ci à la main.` })
      }

      // Le fil, depuis le cœur (table `messages`) — jamais un provider. Les plus
      // RÉCENTS, remis à l'endroit : une réponse se rédige sur la fin du fil.
      const { data: msgs, error: eM } = await supabase.from('messages')
        .select('direction, kind, body, sent_at')
        .eq('user_id', userId).eq('booking_id', bookingId)
        .order('sent_at', { ascending: false }).limit(R.MESSAGES_DU_FIL)
      if (eM) return repondre(503, { error: 'Lecture impossible' })
      const fil = (msgs || []).reverse().map(m => ({
        source: m.direction === 'inbound' ? 'guest' : (m.kind === 'auto' ? 'auto' : 'host'),
        message: m.body || ''
      }))
      const { data: knowledge } = await supabase.from('knowledge')
        .select('*').eq('user_id', userId).eq('property_id', refBien)
      // « Hors IA » s'applique ici aussi : buildKnowledgeText filtre.
      const knowledgeText = buildKnowledgeText(knowledge || [], { replis: replisDuBien(bien) })
      const consignesLues = await loadPromptingInstructions(userId, refBien)
      const consignes = [consignesLues.global, consignesLues.propertyOverride].filter(Boolean).join('\n')

      const guestName = [snap.firstName, snap.lastName].filter(Boolean).join(' ').trim() || 'Voyageur'
      const prompt = R.promptRedaction({
        guestName, bienNom: bien.name, fil, knowledgeText, consignes, ...entree
      })

      // ⚠ Pas de `noterAppel` (journal de l'AGENT) : l'appel est tracé par
      // l'enveloppe du client partagé dans `ia_appels`, sous son étiquette.
      let texte
      try {
        const reponse = await avecContexteIA({ fonction: R.FONCTION_IA, userId, propertyId: refBien, bookingId },
          () => anthropic.messages.create(requeteClassification(prompt, modeleConfigure())))
        texte = R.texteDe(reponse)
      } catch (err) {
        console.error('[guestflow-rediger] appel IA en echec', err?.message)
        return repondre(502, { error: 'ia_indisponible', message: 'L’assistant n’a pas pu répondre, réessayez.' })
      }
      if (!texte) return repondre(502, { error: 'ia_indisponible', message: 'L’assistant n’a rien proposé, réessayez.' })
      return repondre(200, { ok: true, texte })
    } catch (err) {
      console.error('[guestflow-rediger] exception', err?.message)
      return repondre(500, { error: 'Erreur interne' })
    }
  })
}
