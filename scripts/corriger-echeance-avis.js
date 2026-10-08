#!/usr/bin/env node
// scripts/corriger-echeance-avis.js — recette de Thierry du 9 octobre 2026.
//
// Neuf evaluations nees de l'objet Channex portaient son echeance (reception +
// ~30 jours) au lieu de celle d'Airbnb (depart + 14 jours) : la page affichait
// « 5 a 20 jours restants » sur des fenetres deja fermees. Le code est corrige
// (lib/avis/naissance.js) ; ce script repare les evaluations OUVERTES deja nees :
//   - echeance = la plus proche entre l'actuelle et depart + 14 jours (12:00 UTC,
//     `echeanceDuDepart`) ; sans depart connu, reception de l'objet + 14 jours ;
//   - fenetre fermee (echeance passee) OU avis du voyageur visible (regle 1) :
//     statut « expiree » — ou « evaluee_ailleurs » si l'avis est devenu visible
//     AVANT reception + 14 jours (l'hote a evalue sur Airbnb, spec §6) —,
//     publication automatique desarmee.
//   ⚠ JAMAIS un `echec_publication` (revue de 1ad5881) : notre avis est peut-etre
//     parti ; seule la relecture chez le provider tranche. Son echeance seule
//     est corrigee.
//
//   node --env-file=<.env de la base visee> scripts/corriger-echeance-avis.js [--go --biens=<N>]
//
// Sans --go : AUCUNE ecriture, la liste exacte. L'echeance ne recule jamais
// (on ne retarde rien). N'ecrit que `deadline_at`, `status` et `auto_publier_le`
// de guest_evaluations.

const { createClient } = require('@supabase/supabase-js')
const { echeanceDuDepart, voyageurAEcrit, FENETRE_AIRBNB_MS } = require('../lib/avis/naissance')

const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')
const OUVERTS = ['a_remplir', 'soumise_prestataire', 'a_valider', 'echec_publication']

;(async () => {
  if (go && !/^\d+$/.test(String(val('biens') || ''))) { console.error('ECHEC : --go exige --biens=<N> (3 staging, 5 production)'); process.exit(1) }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const { count } = await sb.from('properties').select('id', { count: 'exact', head: true })
  const projet = String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]
  console.log(`Projet ${projet} · biens = ${count} · ${go ? 'ECRITURE' : 'sans --go : AUCUNE ecriture'}`)
  if (go && Number(val('biens')) !== count) { console.error(`ECHEC : --biens=${val('biens')} annonce, la base en compte ${count}`); process.exit(3) }

  const { data: E, error } = await sb.from('guest_evaluations').select('id, user_id, booking_uid, status, deadline_at, ota_review_id, auto_publier_le').in('status', OUVERTS)
  if (error) throw new Error(error.message)
  // ⚠ UNE LECTURE EN ECHEC ARRETE TOUT : sans elles, le script retomberait en
  // silence sur de mauvaises echeances ou croirait tous les avis masques.
  const { data: S, error: eS } = await sb.from('bookings_snapshot').select('booking_id, user_id, snapshot').in('booking_id', E.map(e => e.booking_uid))
  if (eS) throw new Error(`reservations : ${eS.message}`)
  const snap = new Map((S || []).map(s => [`${s.user_id}|${s.booking_id}`, s.snapshot || {}]))
  const ids = E.map(e => e.ota_review_id).filter(Boolean)
  const { data: R, error: eR } = ids.length ? await sb.from('ota_reviews').select('id, received_at, ota, cache:raw->attributes->is_hidden, note:raw->attributes->overall_score, texte:raw->attributes->content').in('id', ids) : { data: [], error: null }
  if (eR) throw new Error(`avis : ${eR.message}`)
  const objet = new Map((R || []).map(r => [r.id, r]))
  const maintenant = Date.now()
  const plan = []
  for (const e of E) {
    const s = snap.get(`${e.user_id}|${e.booking_uid}`) || {}
    const o = objet.get(e.ota_review_id) || null
    const airbnb = s.departure ? echeanceDuDepart(s.departure)
      : (o && o.received_at ? new Date(Date.parse(o.received_at) + FENETRE_AIRBNB_MS).toISOString() : null)
    const echeance = airbnb && (!e.deadline_at || Date.parse(airbnb) < Date.parse(e.deadline_at)) ? airbnb : e.deadline_at
    const visible = Boolean(o && String(o.ota).toLowerCase() === 'airbnb' && voyageurAEcrit({ is_hidden: o.cache, overall_score: o.note, content: o.texte }))
    const fermee = e.status !== 'echec_publication' && ((echeance && Date.parse(echeance) <= maintenant) || visible)
    const ailleurs = visible && o.received_at && maintenant < Date.parse(o.received_at) + FENETRE_AIRBNB_MS
    const maj = {}
    if (echeance !== e.deadline_at) maj.deadline_at = echeance
    if (fermee) { maj.status = ailleurs ? 'evaluee_ailleurs' : 'expiree'; maj.auto_publier_le = null; maj.updated_at = new Date().toISOString() }
    if (!Object.keys(maj).length) continue
    plan.push({ e, maj })
    const qui = ((s.firstName || '') + ' ' + (s.lastName || '')).trim() || e.booking_uid.slice(0, 8)
    console.log(`  ${String(s.departure || '?').slice(0, 10)} ${qui.padEnd(22).slice(0, 22)} echeance ${String(e.deadline_at).slice(0, 10)} → ${String(echeance).slice(0, 10)}${fermee ? ` · ${e.status} → ${maj.status}${visible ? ' (avis du voyageur visible)' : ' (fenetre fermee)'}` : ''}${e.status === 'echec_publication' ? ' · echec de publication : statut inchange' : ''}`)
  }
  console.log(`${plan.length} evaluation(s) a corriger.`)
  if (!go) { console.log('Sans --go : AUCUNE ecriture.'); return }
  let n = 0
  for (const { e, maj } of plan) {
    const { data, error: eU } = await sb.from('guest_evaluations').update(maj).eq('id', e.id).eq('user_id', e.user_id).in('status', OUVERTS).select('id')
    if (eU) { console.error(`  ECHEC ${e.id} : ${eU.message}`); continue }
    n += (data || []).length
  }
  console.log(`${n} evaluation(s) corrigee(s).`)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
