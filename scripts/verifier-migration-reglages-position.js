#!/usr/bin/env node
// scripts/verifier-migration-reglages-position.js — la migration du lot 2
// « Ce qui fait bouger vos prix » (migrations/2026-11-05-yield-reglages-position.sql)
// est-elle appliquee, et sous la bonne forme ? Regle du 25 septembre 2026 : on
// ne colle que la migration, la verification passe par un script qui dit OU il
// a mesure (empreinte du projet en tete, et refus d'une base inconnue).
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-reglages-position.js
//
// ⚠ LECTURE SEULE. Les colonnes se lisent par leur NOM (un select de chaque
// colonne attendue, limite a zero ligne) : une colonne absente ou mal nommee
// est une erreur, pas un silence. Sonde du navigateur (cle anon) si
// SUPABASE_ANON_KEY est presente : les deux tables ne se lisent pas sans session.
// ⚠ LIMITE CONNUE (dette 32) : l'API ne donne pas le catalogue — ni les
// policies, ni les contraintes CHECK/UNIQUE ne sont prouvees ici. Elles l'ont
// ete sur un Postgres embarque avant le commit (11 positions acceptees,
// 18 incoherences refusees) ; la relecture du fichier de migration les couvre.
const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')

const ATTENDU = {
  yield_reglages_position: ['id', 'user_id', 'property_id', 'evenement', 'zone', 'rang', 'jour', 'nuit', 'niveau', 'created_at', 'updated_at'],
  yield_reglages_position_journal: ['id', 'user_id', 'property_id', 'evenement', 'zone', 'rang', 'jour', 'nuit', 'geste', 'niveau', 'niveau_avant', 'recommandes', 'created_at'],
  yield_segment_reglages: ['weekends_avant', 'weekends_apres']
}

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) { console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1) }
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  console.log(`Base ${base} · biens = ${count}`)
  if (base === 'INCONNUE') {
    console.error('ECHEC : projet Supabase inconnu — ni la production, ni staging.')
    console.error('Un resultat qui ne dit pas OU il a ete obtenu ne prouve rien.')
    process.exit(1)
  }
  let echecs = 0
  for (const [table, colonnes] of Object.entries(ATTENDU)) {
    let ici = 0
    for (const c of colonnes) {
      const { error: e } = await sb.from(table).select(c).limit(0)
      if (e) { ici++; console.log(`  ✖ ${table}.${c} : ${e.message}`) }
    }
    echecs += ici
    if (!ici) console.log(`  ✔ ${table} : ${colonnes.length} colonne(s) attendue(s) lues par leur nom`)
  }
  if (process.env.SUPABASE_ANON_KEY) {
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    for (const t of ['yield_reglages_position', 'yield_reglages_position_journal']) {
      const { data, error: e } = await anon.from(t).select('id').limit(1)
      // Une table ABSENTE n'est pas une table fermee : un verificateur qui n'a
      // rien lu ne rassure pas.
      if (e && /schema cache|does not exist/i.test(e.message || '')) { echecs++; console.log(`  ✖ sonde navigateur sur ${t} : table absente`); continue }
      const ferme = !!e || !(data || []).length
      if (!ferme) echecs++
      console.log(`  ${ferme ? '✔' : '✖'} sonde navigateur sur ${t} : ${ferme ? 'aucune ligne lisible sans session' : 'DES LIGNES SONT LISIBLES SANS SESSION'}`)
    }
  } else console.log('  (sonde navigateur non faite : SUPABASE_ANON_KEY absente de ce fichier d environnement)')
  if (echecs) { console.error(`ECHEC : ${echecs} ecart(s) — migration absente ou incomplete.`); process.exit(2) }
  console.log('Migration 2026-11-05-yield-reglages-position : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
