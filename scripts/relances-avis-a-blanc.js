#!/usr/bin/env node
// scripts/relances-avis-a-blanc.js — ce que les relances de l'evaluation du
// voyageur ENVERRAIENT au prochain passage du cron (lot 6, spec §10).
//
// Usage : node --env-file=.env.local   scripts/relances-avis-a-blanc.js
//         node --env-file=.env.staging scripts/relances-avis-a-blanc.js
//
// LECTURE SEULE. La meme requete que `relancerEvaluations`
// (lib/avis/notifications.js) — memes statuts, meme fenetre de cinq jours, meme
// plafond, memes marqueurs — sans rien ecrire ni rien envoyer. Une ecriture de
// masse s'annonce AVANT d'ecrire : ce script est cette annonce.

const { createClient } = require('@supabase/supabase-js')
const { EN_ATTENTE, marqueurRelance } = require('../lib/avis/notifications')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const JOUR = 86400000

;(async () => {
  const { count: biens } = await sb.from('properties').select('*', { count: 'exact', head: true })
  console.log(`Base : ${biens} bien(s) — ${biens === 5 ? 'PRODUCTION' : biens === 3 ? 'STAGING' : 'INCONNUE'} (lecture seule)\n`)
  const maintenant = Date.now()
  const { data, error } = await sb.from('guest_evaluations')
    .select('user_id, booking_uid, property_id_ref, status, deadline_at')
    .in('status', EN_ATTENTE)
    .gt('deadline_at', new Date(maintenant).toISOString())
    .lte('deadline_at', new Date(maintenant + 5 * JOUR).toISOString())
    .order('deadline_at', { ascending: true })
  if (error) { console.error('Lecture impossible :', error.message); process.exit(1) }
  const lignes = (data || []).map(e => {
    const palier = (Date.parse(e.deadline_at) - maintenant) <= JOUR ? 'J-1' : 'J-5'
    return { ...e, palier, marqueur: marqueurRelance(palier, e.booking_uid) }
  })
  const { data: deja } = lignes.length
    ? await sb.from('agent_tasks').select('user_id, guest_message').in('guest_message', lignes.map(l => l.marqueur))
    : { data: [] }
  const faits = new Set((deja || []).map(t => `${t.user_id}|${t.guest_message}`))
  const aEnvoyer = lignes.filter(l => !faits.has(`${l.user_id}|${l.marqueur}`))
  console.log(`Evaluations dans la fenetre : ${lignes.length} · deja relancees a ce palier : ${lignes.length - aEnvoyer.length}`)
  console.log(`A RELANCER au prochain passage : ${Math.min(aEnvoyer.length, 20)}${aEnvoyer.length > 20 ? ` (plafond 20, ${aEnvoyer.length - 20} au passage suivant)` : ''}\n`)
  for (const l of aEnvoyer) console.log(`  ${l.palier}  echeance ${l.deadline_at}  compte ${String(l.user_id).slice(0, 8)}  bien ${l.property_id_ref}  statut ${l.status}`)
  console.log('\nChaque relance : une tache dans la liste de l hote, et les SMS / e-mails de SA configuration d alertes.')
})()
