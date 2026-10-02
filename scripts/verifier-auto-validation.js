#!/usr/bin/env node
// scripts/verifier-auto-validation.js — la migration du 2 octobre 2026
// (2026-10-02-avis-auto-validation.sql) est-elle REELLEMENT appliquee sur la
// base visee ?
//
// Usage : node --env-file=.env.local   scripts/verifier-auto-validation.js
//         node --env-file=.env.staging scripts/verifier-auto-validation.js
//
// LECTURE SEULE. Il lit les deux colonnes neuves, et rejoue les DEUX requetes
// du cron qui en dependent (la file de l'auto-validation, les departs du jour)
// avec leurs filtres exacts.
//
// ⚠ EMPREINTE EN TETE (5 biens = production, 3 = staging).
//
// ⚠ CE QU'IL NE VOIT PAS. PostgREST n'expose pas pg_catalog : ni la contrainte
// `avis_config_auto_validation_check`, ni les index `guest_evaluations_auto_publier_idx`
// et `menages_depart_idx` ne se lisent d'ici. Il prouve que les colonnes
// existent et que les requetes du cron passent ; la presence des index se lit
// dans l'editeur Supabase (Database → Indexes).
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER : une colonne absente, une
// requete en erreur, c'est un ECHEC, jamais un « 0 ligne ».

const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++ }

;(async () => {
  const { count: biens, error: eB } = await sb.from('properties').select('*', { count: 'exact', head: true })
  if (eB) { console.error('Empreinte illisible :', eB.message); process.exit(1) }
  const nom = biens === 5 ? 'PRODUCTION' : biens === 3 ? 'STAGING' : 'INCONNUE'
  console.log(`Base : ${projet} — ${biens} bien(s) — ${nom}\n`)
  if (nom === 'INCONNUE') { console.error('Empreinte inconnue : arret.'); process.exit(1) }

  // 1. Le reglage de l'hote.
  const { data: cfg, error: eC } = await sb.from('avis_config').select('user_id, property_id, auto_validation_heures').limit(1000)
  if (eC) ko(`avis_config.auto_validation_heures illisible : ${eC.message}`)
  else {
    ok(`avis_config.auto_validation_heures lisible (${cfg.length} ligne(s))`)
    const hors = cfg.filter(c => c.auto_validation_heures !== null && !(c.auto_validation_heures >= 1 && c.auto_validation_heures <= 336))
    if (hors.length) ko(`${hors.length} reglage(s) hors de 1..336`)
    const actives = cfg.filter(c => c.auto_validation_heures !== null).length
    console.log(`        auto-validation activee : ${actives} reglage(s) sur ${cfg.length}`)
  }

  // 2. La file de l'auto-validation, avec le filtre du cron.
  const maintenant = new Date().toISOString()
  const { data: file, error: eF } = await sb.from('guest_evaluations')
    .select('id, status, auto_publier_le, auto_rappel_le').lte('auto_publier_le', maintenant)
    .order('auto_publier_le', { ascending: true }).limit(20)
  if (eF) ko(`guest_evaluations.auto_publier_le illisible : ${eF.message}`)
  else ok(`file de l'auto-validation lisible (${file.length} echue(s) maintenant)`)
  const { count: programmees, error: eP } = await sb.from('guest_evaluations')
    .select('*', { count: 'exact', head: true }).not('auto_publier_le', 'is', null)
  if (eP) ko(`comptage des programmees impossible : ${eP.message}`)
  else console.log(`        evaluations programmees : ${programmees}`)

  // 3. Les departs du jour (naissance, §9 bis), avec le filtre du cron.
  const jour = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
  const { data: departs, error: eD } = await sb.from('menages')
    .select('booking_id').in('departure_date', [jour]).neq('status', 'cancelled').limit(500)
  if (eD) ko(`menages.departure_date illisible : ${eD.message}`)
  else ok(`departs du jour lisibles (${departs.length} le ${jour})`)

  console.log('\nNon vu d ici (pg_catalog n est pas expose) : la contrainte 1..336 et les deux index.')
  if (echecs) { console.error(`\n${echecs} ECHEC(S)`); process.exit(1) }
  console.log('\nOK')
})()
