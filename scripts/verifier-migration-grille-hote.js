#!/usr/bin/env node
// scripts/verifier-migration-grille-hote.js — la migration du lot 4.6.7
// (migrations/2026-09-30-grille-hote.sql) est-elle appliquee, et sous la bonne
// forme ? Regle du 25 septembre 2026 : on ne colle que la migration, la
// verification passe par un script qui affiche l'empreinte en tete (projet et
// nombre de biens : 5 = production, 3 = staging).
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-grille-hote.js
//
// ⚠ LECTURE SEULE. Les colonnes se lisent par leur NOM (un select de chaque
// colonne attendue, limite a zero ligne) : une colonne absente ou mal nommee
// est une erreur, pas un silence. Sonde du navigateur (cle anon) si
// SUPABASE_ANON_KEY est presente : les deux tables ne se lisent pas sans session.
// ⚠ LIMITE CONNUE (dette 32) : l'API ne donne pas le catalogue — ni les
// policies, ni les contraintes CHECK/UNIQUE ne sont prouvees ici ; la
// relecture du fichier de migration les couvre.

const { createClient } = require('@supabase/supabase-js')

const ATTENDU = {
  grille_hote: ['id', 'user_id', 'property_id', 'niveau', 'rate_cents', 'recommended_rate_cents', 'created_at', 'updated_at'],
  grille_hote_journal: ['id', 'user_id', 'property_id', 'niveau', 'evenement', 'rate_cents', 'rate_cents_avant', 'recommended_rate_cents', 'created_at'],
  prix_hote: ['recommended_rate_cents']
}

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) { console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1) }
  console.log(`Projet ${String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]} · biens = ${count} (5 = production, 3 = staging)`)
  let echecs = 0
  for (const [table, colonnes] of Object.entries(ATTENDU)) {
    for (const c of colonnes) {
      const { error: e } = await sb.from(table).select(c).limit(0)
      if (e) { echecs++; console.log(`  ✖ ${table}.${c} : ${e.message}`) }
    }
    if (!echecs) console.log(`  ✔ ${table} : ${colonnes.length} colonne(s) attendue(s) lues par leur nom`)
  }
  if (process.env.SUPABASE_ANON_KEY) {
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    for (const t of ['grille_hote', 'grille_hote_journal']) {
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
  console.log('Migration 2026-09-30-grille-hote : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
