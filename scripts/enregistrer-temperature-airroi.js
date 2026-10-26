#!/usr/bin/env node
// scripts/enregistrer-temperature-airroi.js — LE PIPELINE AIRROI, STOCKE
// dans `marche_temperature_airroi`. Spec : docs/kb/chantier-nouveau-bien.md §15.
//
//   node --env-file=<.env de la base visee> scripts/enregistrer-temperature-airroi.js \
//     --relief=tests/fixtures/airroi/relief-bagneres-2026-09-30.json \
//     --marche60=tests/fixtures/airroi/marche-60.json [--go --base=<STAGING|PRODUCTION>]
//
// ⚠ AUCUN APPEL AIRROI : le relief vient d'une capture deja payee
// (scripts/capturer-relief-airroi.js). `--marche60` ne sert qu'a nommer le
// marche (pays, region, localite) : la capture du relief ne le porte pas.
// ⚠ --go EXIGE --base=STAGING ou --base=PRODUCTION : l'empreinte arrete une
// ecriture sur la mauvaise base. Sans --go : AUCUNE ecriture, le resume seul.
// ⚠ N'ECRIT QUE dans `marche_temperature_airroi` (writer unique). Aucun prix.

const fs = require('fs')
const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')
const { lireJson } = require('../lib/airroi/json')
const { construireLignes, enregistrerTemperature, METHODE } = require('../lib/marche/temperature-airroi')

const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')

;(async () => {
  if (!val('relief') || !val('marche60')) { console.error('Usage : --relief=<capture> --marche60=<fichier> [--go --base=<STAGING|PRODUCTION>]'); process.exit(1) }
  if (go && !['STAGING', 'PRODUCTION'].includes(String(val('base') || '').toUpperCase())) { console.error('ECHEC : --go exige --base=STAGING ou --base=PRODUCTION'); process.exit(1) }
  const relief = lireJson(fs.readFileSync(val('relief'), 'utf8'))
  const marche60 = lireJson(fs.readFileSync(val('marche60'), 'utf8'))
  if (!marche60.market) throw new Error('le fichier des 60 mois ne porte pas son marche (cle `market`)')

  const lignes = construireLignes({ marche: marche60.market, reponse: relief })
  const compte = {}
  for (const l of lignes) compte[l.niveau] = (compte[l.niveau] || 0) + 1
  console.log(`${lignes[0].localite} · capture du ${lignes[0].capture_le} · ${lignes.length} jours (${lignes[0].jour} → ${lignes[lignes.length - 1].jour}) · methode ${METHODE}`)
  // Le marche vient de --marche60 : la capture ne porte que des coordonnees. On
  // les montre, pour qu'un relief ne se range pas sous le mauvais marche.
  const loc = relief.location || {}
  console.log(`  capture faite aux coordonnees ${loc.latitude}, ${loc.longitude} · marche nomme par --marche60 : ${marche60.market.locality} (${marche60.market.region})`)
  console.log(`  creux ${compte.creux || 0} · modere ${compte.modere || 0} · favorable ${compte.favorable || 0} · pic ${compte.pic || 0}`)
  if (!go) { console.log('Sans --go : AUCUNE ecriture.'); return }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) throw new Error(`empreinte illisible ${error ? error.message : ''}`)
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  console.log(`Projet ${base} · biens = ${count}`)
  // ⚠ L'OPERATEUR ANNONCE LA BASE, ET LE SCRIPT VERIFIE L'IDENTITE DU PROJET
  // — PLUS SON NOMBRE DE BIENS (26 octobre 2026, constat GRAVE de la review du
  // lot `fix-empreinte-par-projet`). L'accuse de reception humain GARDE sa
  // vertu : c'est lui qui protege d'un `--env-file` confondu, et il reste
  // exige. Ce qui change est ce qu'il annonce.
  //
  // Le compte de biens ne pouvait pas tenir ce role : staging en porte QUATRE
  // depuis qu'un bien y a ete cree, alors que l'aide de ce script disait
  // « 3 staging ». Un operateur qui suivait l'aide obtenait « mauvaise base »
  // SUR LA BONNE BASE — et le jour ou les deux bases porteraient le meme
  // nombre, il n'y aurait plus rien derriere : un `--env-file` confondu
  // ecrirait sur la mauvaise base en silence. La reference du projet, elle, ne
  // derive pas avec la donnee.
  if (base === 'INCONNUE') { console.error(`ECHEC : projet Supabase inconnu — ni la production, ni staging. Rien n'est ecrit.`); process.exit(3) }
  if (go && String(val('base')).toUpperCase() !== base) { console.error(`ECHEC : --base=${val('base')} annonce, la base est ${base} — mauvaise base, rien n'est ecrit`); process.exit(3) }
  const n = await enregistrerTemperature(sb, lignes)
  console.log(`${n} jours ecrits dans marche_temperature_airroi.`)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
