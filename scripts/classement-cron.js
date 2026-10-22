#!/usr/bin/env node
// scripts/classement-cron.js
// LE CLASSEMENT DU COUT DU CRON, EN LIGNE DE COMMANDE. Lecture seule.
//
// C'est la meme lecture que la carte 20 de la page de diagnostic
// (lib/cron-stats.js), en version operateur : elle sert a rendre le top 10
// apres les 48 h de mesure, sans dependre d'une session navigateur ni de
// FOUNDER_EMAIL cote Vercel.
//
// ⚠ IL DIT AUSSI LA COUVERTURE DE LA FENETRE, et c'est le point que personne
// ne pense a verifier : un classement sur 48 h qui n'a vu que 12 heures de
// passages n'est pas un classement, c'est un echantillon — et il designerait
// la tache la plus frequente plutot que la plus couteuse. `cron` passe toutes
// les 5 minutes et `cron-messages` toutes les 10 (vercel.json) : on compare
// donc le nombre de passages vus a celui attendu.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.local \
//     node scripts/classement-cron.js --heures 48 --limite 10

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')
const { classement, derniersPassages } = require('../lib/cron-stats')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
const arg = (nom, defaut) => {
  const i = process.argv.indexOf(`--${nom}`)
  if (i === -1) return defaut
  const v = parseInt(process.argv[i + 1], 10)
  return Number.isFinite(v) ? v : defaut
}
const quelCron = (() => {
  const i = process.argv.indexOf('--cron')
  return i === -1 ? null : process.argv[i + 1] || null
})()
const HEURES = arg('heures', 24)
const LIMITE = arg('limite', 10)
// Cadences de vercel.json. Un passage attendu toutes les N minutes.
const CADENCE = { cron: 5, 'cron-messages': 10 }

const sb = createClient(URL, KEY)
const PROJET = (URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || ''
const sec = (ms) => `${(ms / 1000).toFixed(1)} s`
const col = (v, n, droite) => (droite ? String(v).padStart(n) : String(v).padEnd(n))

;(async () => {
  const r = await classement(sb, { heures: HEURES, limite: LIMITE, cron: quelCron })
  if (!r.ok) {
    console.error(r.raison === 'migration_non_appliquee'
      ? 'Table de mesure absente : migration 2026-10-22-cron-stats non appliquee.'
      : `Classement illisible : ${r.detail}`)
    process.exit(1)
  }
  console.log(`Projet ${PROJET} — fenetre ${HEURES} h (depuis ${r.depuis})`)
  console.log(`${r.taches} tache(s) mesuree(s), ${r.classement.length} affichee(s)\n`)

  console.log(col('#', 3) + col('cron', 15) + col('tache', 28) + col('passages', 10, true)
    + col('requetes', 10, true) + col('req/pass', 10, true) + col('externes', 10, true)
    + col('temps', 12, true) + col('travail', 9, true))
  console.log('-'.repeat(107))
  r.classement.forEach((t, i) => {
    console.log(col(i + 1, 3) + col(t.cron, 15) + col(String(t.tache).slice(0, 27), 28)
      + col(t.passages, 10, true) + col(t.requetes, 10, true)
      + col(t.passages ? (t.requetes / t.passages).toFixed(1) : '-', 10, true)
      + col(t.externes, 10, true) + col(sec(t.ms), 12, true) + col(t.travail, 9, true))
  })

  console.log('\nTOTAL PAR JOUR (heure de Paris)')
  console.log(col('jour', 13) + col('cron', 15) + col('passages', 10, true)
    + col('requetes', 10, true) + col('externes', 10, true) + col('temps', 12, true)
    + col('moy./pass.', 12, true))
  console.log('-'.repeat(82))
  for (const j of r.par_jour) {
    console.log(col(j.jour, 13) + col(j.cron, 15) + col(j.passages, 10, true)
      + col(j.requetes, 10, true) + col(j.externes, 10, true) + col(sec(j.ms), 12, true)
      + col(j.passages ? sec(j.ms / j.passages) : '-', 12, true))
  }

  // ⚠ LA COUVERTURE : un classement sur une fenetre a moitie vide designe la
  // tache la plus frequente, pas la plus couteuse.
  console.log('\nCOUVERTURE DE LA FENETRE')
  const vus = new Map()
  for (const j of r.par_jour) vus.set(j.cron, (vus.get(j.cron) || 0) + j.passages)
  for (const [nom, minutes] of Object.entries(CADENCE)) {
    if (quelCron && nom !== quelCron) continue
    const attendus = Math.round((HEURES * 60) / minutes)
    const n = vus.get(nom) || 0
    const part = attendus ? Math.round((n / attendus) * 100) : 0
    console.log(`  ${col(nom, 15)}${col(n, 6, true)} passage(s) vus sur ${attendus} attendus`
      + ` (${part} %)${part < 90 ? '  ⚠ fenetre incomplete' : ''}`)
  }

  const der = await derniersPassages(sb)
  if (der.ok) {
    for (const p of der.passages) {
      if (quelCron && p.cron !== quelCron) continue
      console.log(`\nDERNIER PASSAGE ${p.cron} — ${p.commence_le} — ${sec(p.duree_ms)}, `
        + `${p.requetes} requete(s), ${p.appels_externes} appel(s) externe(s)`)
      for (const t of (p.taches || []).slice(0, 15)) {
        console.log('  ' + col(String(t.nom).slice(0, 30), 32) + col(t.req, 6, true)
          + col(sec(t.ms_seul), 10, true) + '  ' + JSON.stringify(t.travail || {}))
      }
    }
  }
})().catch(e => { console.error('classement en echec :', e.message); process.exit(3) })
