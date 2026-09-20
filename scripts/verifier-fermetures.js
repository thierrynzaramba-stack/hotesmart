#!/usr/bin/env node
// scripts/verifier-fermetures.js — lot 4.6.2.
// Verifie que la migration `2026-09-21-fermetures.sql` est REELLEMENT
// appliquee sur la base visee, et que chaque fermeture est bien PORTEE par la
// memoire d'intention : toutes ses nuits sont `stop_sell = true` dans
// `calendar_inventory`.
//
// Usage : node --env-file=.env.staging scripts/verifier-fermetures.js
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT LE DIRE. Zero fermeture n'est pas une
// anomalie (un compte neuf n'en a pas) — mais « table absente » en est une, et
// on les distingue : la premiere rend 0, la seconde rend 1.
//
// ⚠ IL REUTILISE LA REGLE : `nuitsFermees` vient de lib/fermetures.js, celle
// que le canal interne applique. Une copie ici deriverait.

const { createClient } = require('@supabase/supabase-js')
const { nuitsFermees } = require('../lib/fermetures')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

;(async () => {
  console.log(`Projet Supabase : ${projet}\n`)
  const { data, error } = await sb.from('fermetures')
    .select('id, user_id, property_id, date_debut, date_fin, raison').order('date_debut')
  if (error) {
    if (/fermetures|schema cache/.test(error.message)) {
      console.error('ECHEC : la table `fermetures` est ABSENTE.')
      console.error('La migration migrations/2026-09-21-fermetures.sql n a pas ete appliquee.')
      process.exit(1)
    }
    console.error('ECHEC : lecture impossible —', error.message); process.exit(1)
  }
  console.log(`${(data || []).length} fermeture(s) lue(s)`)
  if (!data || !data.length) { console.log('\nOK : la table existe. Aucune fermeture a controler.'); return }

  let anomalies = 0
  for (const f of data) {
    const nuits = [...nuitsFermees([f], f.date_debut, f.date_fin)]
    const { data: lignes, error: e2 } = await sb.from('calendar_inventory')
      .select('date, stop_sell').eq('property_id', f.property_id).in('date', nuits)
    if (e2) { console.error('  ECHEC lecture inventaire :', e2.message); process.exit(1) }
    const par = new Map((lignes || []).map(l => [l.date, l]))
    const manquantes = nuits.filter(j => !par.has(j) || par.get(j).stop_sell !== true)
    const etat = manquantes.length ? `ANOMALIE : ${manquantes.length}/${nuits.length} nuit(s) non fermee(s) en memoire` : 'ok'
    console.log(`  ${f.date_debut} → ${f.date_fin}  « ${f.raison.slice(0, 40)} »  ${etat}`)
    if (manquantes.length) anomalies++
  }
  if (anomalies) {
    console.error(`\nECHEC : ${anomalies} fermeture(s) dont la memoire d intention ne porte pas stop_sell.`)
    console.error('Une fermeture n est pas une seconde source de verite : si elle existe, ses nuits sont fermees.')
    process.exit(1)
  }
  console.log('\nOK : chaque fermeture est portee par la memoire d intention.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
