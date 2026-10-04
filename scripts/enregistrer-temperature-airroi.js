#!/usr/bin/env node
// scripts/enregistrer-temperature-airroi.js — LE PIPELINE AIRROI, STOCKE
// dans `marche_temperature_airroi`. Spec : docs/kb/chantier-nouveau-bien.md §15.
//
//   node --env-file=<.env de la base visee> scripts/enregistrer-temperature-airroi.js \
//     --relief=tests/fixtures/airroi/relief-bagneres-2026-09-30.json \
//     --marche60=tests/fixtures/airroi/marche-60.json [--go --biens=<N>]
//
// ⚠ AUCUN APPEL AIRROI : le relief vient d'une capture deja payee
// (scripts/capturer-relief-airroi.js). `--marche60` ne sert qu'a nommer le
// marche (pays, region, localite) : la capture du relief ne le porte pas.
// ⚠ --go EXIGE --biens=N (3 staging, 5 production) : l'empreinte arrete une
// ecriture sur la mauvaise base. Sans --go : AUCUNE ecriture, le resume seul.
// ⚠ N'ECRIT QUE dans `marche_temperature_airroi` (writer unique). Aucun prix.

const fs = require('fs')
const { createClient } = require('@supabase/supabase-js')
const { lireJson } = require('../lib/airroi/json')
const { construireLignes, enregistrerTemperature, METHODE } = require('../lib/marche/temperature-airroi')

const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')

;(async () => {
  if (!val('relief') || !val('marche60')) { console.error('Usage : --relief=<capture> --marche60=<fichier> [--go --biens=<N>]'); process.exit(1) }
  if (go && !/^\d+$/.test(String(val('biens') || ''))) { console.error('ECHEC : --go exige --biens=<N> (3 staging, 5 production)'); process.exit(1) }
  const relief = lireJson(fs.readFileSync(val('relief'), 'utf8'))
  const marche60 = lireJson(fs.readFileSync(val('marche60'), 'utf8'))
  if (!marche60.market) throw new Error('le fichier des 60 mois ne porte pas son marche (cle `market`)')

  const lignes = construireLignes({ marche: marche60.market, reponse: relief })
  const compte = {}
  for (const l of lignes) compte[l.niveau] = (compte[l.niveau] || 0) + 1
  console.log(`${lignes[0].localite} · capture du ${lignes[0].capture_le} · ${lignes.length} jours (${lignes[0].jour} → ${lignes[lignes.length - 1].jour}) · methode ${METHODE}`)
  console.log(`  creux ${compte.creux || 0} · modere ${compte.modere || 0} · favorable ${compte.favorable || 0} · pic ${compte.pic || 0}`)
  if (!go) { console.log('Sans --go : AUCUNE ecriture.'); return }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) throw new Error(`empreinte illisible ${error ? error.message : ''}`)
  const projet = String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]
  console.log(`Projet ${projet} · biens = ${count} (5 = production, 3 = staging)`)
  if (Number(val('biens')) !== count) { console.error(`ECHEC : --biens=${val('biens')} annonce, la base en compte ${count} — mauvaise base, rien n'est ecrit`); process.exit(3) }
  const n = await enregistrerTemperature(sb, lignes)
  console.log(`${n} jours ecrits dans marche_temperature_airroi.`)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
