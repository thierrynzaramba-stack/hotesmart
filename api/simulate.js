// api/simulate.js — Simule le traitement d'un message exactement comme le cron
const { createClient } = require('@supabase/supabase-js')
const { requirePermission, verifierSession } = require('../lib/require-permission')
const { sendAlertNotifications } = require('../lib/alert-notify')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  // Endpoint appele uniquement par les pages HoteSmart.
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const appelant = await verifierSession(req, res)
  if (!appelant) return

  // ── DELETE : supprimer un résultat de simulation ──────────────────────────
  if (req.method === 'DELETE') {
    // Simulation d'un message voyageur : domaine `messages`. Pas d'identifiant de
    // bien ici, le filtre user_id reste la defense reelle.
    const gardeDel = await requirePermission(req, res, {
      domaine: 'messages', niveau: 'write', userId: appelant
    })
    if (!gardeDel.ok) return
    const user = { id: gardeDel.accountUserId }
    const { task_id, conv_id } = req.body || {}
    // ⚠ SEULEMENT les lignes de SIMULATION (book_id `SIM_…`). Avant, n'importe
    // quelle tache ou conversation du compte s'effacait par son id : un membre
    // limite a un bien pouvait supprimer des taches reelles d'autres biens
    // (constat de review du lot 3 GuestFlow, preexistant).
    if (task_id) await supabase.from('agent_tasks').delete().eq('id', task_id).eq('user_id', user.id).like('book_id', 'SIM_%')
    if (conv_id) await supabase.from('conversations').delete().eq('id', conv_id).eq('user_id', user.id).like('book_id', 'SIM_%')
    return res.status(200).json({ success: true })
  }

  // ── POST : simuler un message ─────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' })

  const { message, guestName, propertyId } = req.body || {}
  if (!message || !propertyId) return res.status(400).json({ error: 'message et propertyId requis' })

  // Le bien vient du client : resolu en base, c'est lui qui designe le compte.
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write', bien: propertyId, bienRequis: true, userId: appelant
  })
  if (!garde.ok) return
  const user = { id: garde.accountUserId }
  // ⚠ Reference RESOLUE : les tables enfants portent le provider_property_id
  // (REVIEW.md §10), et la valeur client peut etre l'UUID comme la reference canal.
  // ⚠ Elle peut etre NULL (bien cree mais pas encore provisionne cote canal).
  // Sans ce refus, String(null) donnait la chaine 'null' : la base de
  // connaissances etait cherchee sur property_id='null' (toujours vide, donc
  // classification systematique en info_unknown) et les lignes ecrites devenaient
  // invisibles a la messagerie.
  const refBien = garde.bien.provider_property_id
  if (refBien == null || refBien === '') {
    return res.status(400).json({ error: 'Bien non connecté au PMS' })
  }

  // ⚠ LE SIMULATEUR PASSE PAR LE MEME CODE QUE L'AGENT REEL (lot 3 de l'audit
  // GuestFlow, 2 octobre 2026). Il avait son propre prompt, Haiku ecrit en dur,
  // ni historique, ni consignes de l'hote, ni regles d'escalade : Thierry a teste
  // « je veux arriver à 16h » et obtenu « nous pouvons vous transmettre le code
  // pour une arrivée plus tôt » — une promesse que l'agent reel, lui, ne fait
  // pas (arrivee anticipee = decision de l'hote). Un simulateur qui ne simule
  // pas rassure ou inquiete a tort.
  // Desormais : `preparerLot` + `classifierLot` de lib/cron-classify.js, le
  // modele de GUESTFLOW_MODEL, les consignes de l'hote, l'historique de la
  // simulation. Seul l'etat des envois differe : il n'y a pas de reservation.
  const { preparerLot, classifierLot, buildKnowledgeText, modeleConfigure, MODELE_PAR_DEFAUT } = require('../lib/cron-classify')

  const { data: knowledge } = await supabase
    .from('knowledge').select('*')
    .eq('user_id', user.id)
    .eq('property_id', String(refBien))
  const knowledgeText = buildKnowledgeText(knowledge || [])

  // L'historique vient du client : on n'en garde que la forme attendue, borne.
  // ⚠ LES HEURES SONT ATTRIBUEES ICI, DANS L'ORDRE RECU. Melanger l'horloge du
  // navigateur (historique) et celle du serveur (message courant) pouvait trier
  // le message courant AVANT la reponse precedente : le simulateur classait
  // alors l'ancienne question (constat de review).
  const LIMITE = 4000
  const historique = (Array.isArray(req.body?.historique) ? req.body.historique : [])
    .filter(m => m && ['guest', 'ai'].includes(m.source) && typeof m.message === 'string' && m.message.trim())
    .slice(-30)
    .map(m => ({ source: m.source, message: m.message.slice(0, LIMITE) }))
  const base = Date.now() - (historique.length + 1) * 1000
  const fil = [...historique, { source: 'guest', message: String(message).slice(0, LIMITE) }]
    .map((m, i) => ({ ...m, time: new Date(base + i * 1000).toISOString() }))

  const nomVoyageur = guestName || 'Voyageur Test'
  const lot = preparerLot(fil, nomVoyageur)
  // Meme regle que l'agent : rien en attente, rien a classer.
  if (!lot.enAttente.length) return res.status(400).json({ error: 'Aucun message du voyageur en attente' })
  const results = { errors: [] }
  const heure = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })
  const blocEtat = `- Date et heure actuelles : ${heure} (heure de Paris)\n`
    + '- Simulation : aucune réservation réelle, AUCUN message automatique (confirmation, code d\'accès, consignes) n\'a été envoyé.'
  let classification
  try {
    classification = await classifierLot({
      userId: user.id, property: { id: refBien, name: garde.bien.name || '' }, bookingId: 'simulation',
      guestName: nomVoyageur, guestPhone: '', arrival: '', departure: '',
      knowledgeText, results, lot, blocEtat, fonctionIA: 'guestflow_simulateur'
    })
  } catch (e) {
    // Credit epuise, prompt trop long, panne reseau : une erreur LISIBLE pour
    // l'interface, au lieu d'un 500 non-JSON.
    console.error('[Simulate] modele indisponible :', e.message)
    return res.status(502).json({ error: 'Le modèle IA ne répond pas : ' + String(e.message).slice(0, 200) })
  }
  // Le modele qui a REELLEMENT repondu : celui de la variable, sauf repli.
  const modeleVoulu = modeleConfigure()
  const modele = (results.modelesRefuses || []).includes(modeleVoulu) ? `${MODELE_PAR_DEFAUT} (repli)` : modeleVoulu

  const bookId    = `SIM_${Date.now()}`
  const guestN    = guestName || 'Voyageur Test'
  let savedConvId = null
  let savedTaskId = null

  if (classification.type === 'sympathy' || classification.type === 'info_known') {
    if (classification.auto_reply) {
      const { data: conv } = await supabase.from('conversations').insert({
        user_id:       user.id,
        property_id:   String(refBien),
        guest_name:    guestN,
        guest_message: lot.message,
        agent_reply:   classification.auto_reply,
        book_id:       bookId
      }).select('id').single()
      savedConvId = conv?.id
    }
  } else {
    const subTasks = classification.sub_tasks || [{ question: lot.message, summary: classification.reason, suggested_reply: null }]

    const { data: newTask, error: taskError } = await supabase.from('agent_tasks').insert({
      user_id:         user.id,
      property_id:     String(refBien),
      book_id:         bookId,
      guest_name:      guestN,
      guest_message:   lot.message,
      task_type:       classification.type,
      summary:         classification.reason,
      suggested_reply: subTasks[0]?.suggested_reply || null,
      status:          'pending',
      source_thread:   lot.sortedThread.map(m => ({ source: m.source, message: m.message, time: m.time })),
      sub_tasks:       subTasks
    }).select().single()

    savedTaskId = newTask?.id

    // 🔔 Envoyer les alertes notifications
    if (!taskError && newTask) {
      try {
        await sendAlertNotifications({
          type:       classification.type,
          task:       newTask,
          propertyId: String(refBien)
        })
      } catch (alertErr) {
        console.error('[Simulate] Erreur alert-notify:', alertErr.message)
      }
    }
  }

  return res.status(200).json({
    success:        true,
    classification,
    modele,
    book_id:        bookId,
    saved_conv_id:  savedConvId,
    saved_task_id:  savedTaskId
  })
}
