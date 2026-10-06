#!/usr/bin/env node
// scripts/verifier-eval-scope.js — la migration du 2 octobre 2026
// (2026-10-02-avis-eval-scope-sur-autorisation.sql) est-elle REELLEMENT
// appliquee sur la base visee ?
//
// Usage : node --env-file=.env.local   scripts/verifier-eval-scope.js
//         node --env-file=.env.staging scripts/verifier-eval-scope.js
//
// LECTURE SEULE. Il ne lit que `profiles` (deux colonnes) et compte.
//
// ⚠ EMPREINTE EN TETE (5 biens = production, 3 = staging) : un resultat qui ne
// dit pas OU il a ete obtenu ne prouve rien.
//
// ⚠ CE QU'IL PROUVE, ET CE QU'IL NE VOIT PAS. PostgREST n'expose pas
// pg_catalog : la VALEUR PAR DEFAUT de la colonne ne se lit pas d'ici. Ce qu'il
// prouve : aucune valeur hors de `aucun` / `selon_grille` (les anciennes ont ete
// converties), et le nombre de prestataires AUTORISEES — juste apres le collage,
// il doit valoir ZERO (la migration remet tout le monde a `aucun`) ; ensuite, il
// compte les autorisations donnees depuis les fiches.
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER : zero profil lu est un echec.

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

  const { data, error } = await sb.from('profiles').select('id, access_mode, eval_scope').limit(10000)
  if (error) { ko(`profiles illisible : ${error.message}`); process.exit(1) }
  if (!data || !data.length) { ko('aucun profil lu : ce verificateur ne prouve rien'); process.exit(1) }
  ok(`${data.length} profil(s) lu(s)`)

  const parValeur = {}
  for (const p of data) parValeur[p.eval_scope ?? '(nul)'] = (parValeur[p.eval_scope ?? '(nul)'] || 0) + 1
  console.log('        repartition :', JSON.stringify(parValeur))

  const hors = data.filter(p => !['aucun', 'selon_grille'].includes(p.eval_scope))
  if (hors.length) ko(`${hors.length} profil(s) hors de aucun / selon_grille (anciennes valeurs non converties ?)`)
  else ok('toutes les valeurs sont aucun ou selon_grille')

  const autorisees = data.filter(p => p.access_mode === 'lien' && p.eval_scope === 'selon_grille').length
  const prestataires = data.filter(p => p.access_mode === 'lien').length
  console.log(`        prestataires autorisees : ${autorisees} sur ${prestataires}`)
  console.log('        (juste apres le collage : 0 attendu ; ensuite, les autorisations donnees depuis les fiches)')

  console.log('\nNon vu d ici (pg_catalog n est pas expose par PostgREST) : la valeur par defaut de la colonne.')
  console.log('Elle est posee par le collage : un editeur sans erreur l a posee.')
  console.log(echecs ? `\n${echecs} ECHEC(S).` : '\nOK.')
  process.exit(echecs ? 1 : 0)
})()
