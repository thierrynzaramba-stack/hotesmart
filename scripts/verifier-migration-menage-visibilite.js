#!/usr/bin/env node
// scripts/verifier-migration-menage-visibilite.js — la migration
// migrations/2026-10-02-menage-visibilite.sql est-elle appliquee, et sous la
// bonne forme ? Meme regle que verifier-migration-grille-hote.js : on ne colle
// que la migration, la verification passe par ce script, qui affiche
// l'empreinte en tete (projet et nombre de biens : 5 = production, 3 = staging).
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-menage-visibilite.js
//
// ⚠ LECTURE SEULE. Les colonnes se lisent par leur NOM (un select de chaque
// colonne, limite a zero ligne) : une colonne absente est une erreur, pas un
// silence. Sonde du navigateur (cle anon, sans session) : la table ne doit
// rendre AUCUNE ligne sans session — la RLS est active.
// ⚠ LIMITE CONNUE (dette 32) : l'API ne donne pas le catalogue — les
// contraintes CHECK et les policies se prouvent par les deux `select` de preuve
// en fin de migration, dans l'editeur.
const { createClient } = require('@supabase/supabase-js')
const COLONNES = ['user_id', 'profile_id', 'par_bien', 'profils_vus', 'updated_at', 'updated_by']
;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) { console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1) }
  console.log(`Projet ${String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0].slice(0, 6)}… · biens = ${count} (5 = production, 3 = staging)`)
  let echecs = 0
  for (const c of COLONNES) {
    const { error: e } = await sb.from('menage_visibilite').select(c).limit(0)
    if (e) { echecs++; console.log(`  ✖ menage_visibilite.${c} : ${e.message}`) }
  }
  if (!echecs) console.log(`  ✔ menage_visibilite : ${COLONNES.length} colonnes lues par leur nom`)
  if (process.env.SUPABASE_ANON_KEY) {
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    const { data, error: e } = await anon.from('menage_visibilite').select('user_id').limit(1)
    if (e && /schema cache|does not exist/i.test(e.message || '')) { echecs++; console.log('  ✖ sonde navigateur : table absente') }
    else {
      const ferme = !!e || !(data || []).length
      if (!ferme) echecs++
      console.log(`  ${ferme ? '✔' : '✖'} sonde navigateur : ${ferme ? 'aucune ligne lisible sans session' : 'DES LIGNES SONT LISIBLES SANS SESSION'}`)
      // ⚠ UNE TABLE VIDE NE PROUVE PAS LA RLS (constat de review, REVIEW.md
      // regle 16) : juste apres la migration, « aucune ligne » est vrai de toute
      // facon. On le dit, au lieu de laisser un vert passer pour une preuve.
      const { count: n } = await sb.from('menage_visibilite').select('user_id', { count: 'exact', head: true })
      if (!n) console.log('  ⚠ table VIDE : la sonde ne prouve pas la RLS — la preuve est le `select pg_policies` de la migration.')
    }
  } else console.log('  (sonde navigateur non faite : SUPABASE_ANON_KEY absente)')
  if (echecs) { console.error(`ECHEC : ${echecs} ecart(s) — migration absente ou incomplete.`); process.exit(2) }
  console.log('Migration 2026-10-02-menage-visibilite : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
