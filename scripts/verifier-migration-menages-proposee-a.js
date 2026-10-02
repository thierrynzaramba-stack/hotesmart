#!/usr/bin/env node
// scripts/verifier-migration-menages-proposee-a.js — la migration
// migrations/2026-10-02-menages-proposee-a.sql est-elle appliquee, et sous la
// bonne forme ? Meme regle que verifier-migration-menage-visibilite.js : on ne
// colle que la migration, la verification passe par ce script, qui affiche
// l'empreinte en tete (projet et nombre de biens : 5 = production, 3 = staging).
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-menages-proposee-a.js
//
// ⚠ LECTURE SEULE. Trois preuves :
//   1. la colonne `proposee_a` se lit par son NOM (absente = erreur, pas silence) ;
//   2. elle est un TABLEAU d'uuid : le filtre d'appartenance que l'API emploie
//      (`cs`, « contient ») passe — sur une colonne texte, il echouerait ;
//   3. la recopie est complete : aucune proposition encore SEULEMENT dans
//      `offered_to`. Juste apres la migration ce compte doit etre 0 ; ensuite,
//      `rattraperBascule` reprend a chaque cycle celles que l'ancien code a pu
//      poser entre la migration et le deploiement.
// ⚠ LIMITE CONNUE (dette 32) : l'API ne donne pas le catalogue — les
// contraintes CHECK et l'index se prouvent par les `select` de preuve en fin de
// migration, dans l'editeur.
const { createClient } = require('@supabase/supabase-js')
const PERSONNE = '00000000-0000-4000-8000-000000000000'
;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) { console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1) }
  console.log(`Projet ${String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0].slice(0, 6)}… · biens = ${count} (5 = production, 3 = staging)`)
  let echecs = 0

  const { error: e1 } = await sb.from('menages').select('proposee_a').limit(0)
  if (e1) { echecs++; console.log(`  ✖ menages.proposee_a : ${e1.message}`) }
  else console.log('  ✔ menages.proposee_a : colonne lue par son nom')

  const { error: e2 } = await sb.from('menages').select('id').contains('proposee_a', [PERSONNE]).limit(1)
  if (e2) { echecs++; console.log(`  ✖ filtre d'appartenance refuse : ${e2.message}`) }
  else console.log('  ✔ filtre d\'appartenance accepte : la colonne est un tableau')

  const { count: enListe, error: e3 } = await sb.from('menages')
    .select('id', { count: 'exact', head: true }).not('proposee_a', 'is', null)
  const { count: nonRecopiees, error: e4 } = await sb.from('menages')
    .select('id', { count: 'exact', head: true }).not('offered_to', 'is', null).is('proposee_a', null)
  if (e3 || e4 || !Number.isInteger(enListe) || !Number.isInteger(nonRecopiees)) {
    echecs++; console.log(`  ✖ comptage illisible : ${(e3 || e4 || {}).message || 'compte absent'}`)
  } else {
    console.log(`  · propositions en liste : ${enListe}`)
    if (nonRecopiees) { echecs++; console.log(`  ✖ ${nonRecopiees} proposition(s) seulement dans offered_to : recopie incomplete`) }
    else console.log('  ✔ aucune proposition restee seulement dans offered_to')
  }

  if (echecs) { console.error(`ECHEC : ${echecs} ecart(s) — migration absente ou incomplete.`); process.exit(2) }
  console.log('Migration 2026-10-02-menages-proposee-a : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
