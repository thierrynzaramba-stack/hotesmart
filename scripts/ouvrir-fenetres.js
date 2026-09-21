#!/usr/bin/env node
// scripts/ouvrir-fenetres.js — lot 4.6.3.
// Fait tourner le moteur d'ouverture (lib/moteur-ouverture.js) sur la base
// visee, comme le cron le fait en prod — utile sur staging, ou AUCUN cron
// n'est planifie (docs/STAGING.md §1), et pour une recette.
//
// Usage :
//   node --env-file=.env.staging scripts/ouvrir-fenetres.js            (dry-run)
//   node --env-file=.env.staging scripts/ouvrir-fenetres.js --go       (ecrit)
//   ... --bien=<uuid>   (un seul bien)   --jour=YYYY-MM-DD   (horloge injectee)
//
// ⚠ DRY-RUN PAR DEFAUT. Le moteur ecrit par le canal interne, donc par le
// writer : plancher, journal des prix, poussee ARI si le bien est relie. Un
// « --go » sur la prod est un geste de production.
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT LE DIRE : zero bien pilote avec
// fenetre est un compte rendu, une lecture en echec est une sortie 1.

const { createClient } = require('@supabase/supabase-js')
const { ouvrirFenetres, nuitsAOuvrir, PREFIXE_MARQUEUR } = require('../lib/moteur-ouverture')
const { fermeturesDuBien } = require('../lib/fermetures')
const { finDeFenetre } = require('../lib/pilote-tarifaire')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
const args = process.argv.slice(2)
const GO = args.includes('--go')
const bienVoulu = (args.find(a => a.startsWith('--bien=')) || '').slice(7) || null
const jour = (args.find(a => a.startsWith('--jour=')) || '').slice(7) || null
// ⚠ DEUX GARDES — relevees en review. `--go` sur la PROD exige `--prod` (le
// cron y tourne deja, un passage manuel est un geste de production). Et
// `--go` avec `--jour` est refuse : le marqueur serait pose a la date REELLE
// pour un travail fait a une date injectee, et le cron sauterait le bien.
if (GO && jour) { console.error('REFUS : --go et --jour ensemble poseraient un marqueur faux. Le dry-run accepte --jour.'); process.exit(1) }
if (GO && projet === 'cjmrizpdyhrcurmgyrhs' && !args.includes('--prod')) { console.error('REFUS : --go sur la PRODUCTION exige --prod (le cron y tourne deja).'); process.exit(1) }

// Le client canal, si le bien est relie : meme fonction que le fullsync et le
// cron. Sans variables CHANNEL_*, on le dit et on ne l'invente pas.
let appel = null
if (process.env.CHANNEL_BASE_URL && process.env.CHANNEL_API_KEY) {
  appel = require('../lib/channel-fullsync').channelCall
}

;(async () => {
  console.log(`Projet Supabase : ${projet} — ${GO ? 'ECRITURE (--go)' : 'dry-run'}${jour ? ` — jour ${jour}` : ''}\n`)
  let q = sb.from('properties').select('*').eq('pilote_tarifaire', 'yieldflow')
    .not('pilote_fenetre_type', 'is', null).not('pilote_fenetre_valeur', 'is', null).order('name')
  if (bienVoulu) q = q.eq('id', bienVoulu)
  const { data: biens, error } = await q
  if (error) { console.error('ECHEC lecture des biens :', error.message); process.exit(1) }
  if (!biens || !biens.length) { console.log('Aucun bien pilote par YieldFlow avec une fenetre reglee : rien a ouvrir.'); return }
  const auj = jour || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())

  for (const bien of biens) {
    const fin = finDeFenetre(bien, auj)
    const fermetures = await fermeturesDuBien(sb, bien.id, auj, fin)
    const { data: lignes, error: eL } = await sb.from('calendar_inventory').select('date, rate, avail, stop_sell')
      .eq('property_id', bien.id).gte('date', auj).lte('date', fin).limit(2000)
    if (eL) { console.error(`ECHEC lecture memoire ${bien.name} :`, eL.message); process.exit(1) }
    const d = nuitsAOuvrir({ bien, aujourdHui: auj, lignes: lignes || [], fermetures })
    const { data: m } = await sb.from('cron_logs').select('last_run').eq('id', PREFIXE_MARQUEUR + bien.id).maybeSingle()
    console.log(`${bien.name} — fenetre ${bien.pilote_fenetre_valeur} ${bien.pilote_fenetre_type}, jusqu'au ${fin}${appel || !bien.provider_room_type_id ? '' : ' (relie au canal, sans client : refusera)'}`)
    console.log(`  a ouvrir ${d.comptes.a_ouvrir} · deja ouvertes ${d.comptes.deja_ouvertes} · indisponibilites ${d.comptes.fermees_par_l_hote} · intention existante ${d.comptes.intention_existante} · sans prix ${d.comptes.sans_prix}`)
    console.log(`  derniere ouverture par le moteur : ${m && m.last_run ? m.last_run : 'jamais'}`)
  }

  if (!GO) { console.log('\nDry-run : rien n a ete ecrit. Relancer avec --go pour ouvrir.'); return }
  const bilan = await ouvrirFenetres(sb, { appel, aujourdHui: auj })
  console.log('\nBilan :', JSON.stringify({ jour: bilan.jour, biens: bilan.biens, traites: bilan.traites, ouvertes: bilan.ouvertes, sautes: bilan.sautes, reportes: bilan.reportes, erreurs: bilan.erreurs }))
  for (const d of bilan.details) console.log(`  ${d.nom} : ${d.ok ? `${d.ouvertes} nuit(s) ouverte(s)` : `REFUS ${d.refus} — ${d.message}`}${d.ignorees ? ' · ignorees ' + JSON.stringify(Object.fromEntries(Object.entries(d.ignorees).filter(([, v]) => v && v.length).map(([k, v]) => [k, v.length]))) : ''}`)
  if (bilan.erreurs.length) process.exit(1)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
