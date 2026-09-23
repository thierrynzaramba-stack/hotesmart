#!/usr/bin/env node
// scripts/verifier-migration-marche.js — LA MIGRATION 2026-09-24-marche-airroi
// EST-ELLE APPLIQUEE SUR LA BASE VISEE ? Lecture seule.
//
//   node --env-file=.env.local scripts/verifier-migration-marche.js     (production)
//   node --env-file=.env.staging scripts/verifier-migration-marche.js   (staging)
//
// ⚠ EMPREINTE : le projet et le nombre de biens s'affichent en tete — 5 en
// production, 3 en staging. Un resultat sans empreinte ne prouve rien.
// ⚠ Une migration annoncee « collee en production » se prouve en lancant CE
// script CONTRE la production, avant d'ecrire « soldee ».
// Code de sortie : 0 = tout est la ; 3 = il manque quelque chose ; 1 = lecture impossible.

const { createClient } = require('@supabase/supabase-js')

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const projet = String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error) { console.error(`ECHEC : ${error.message}`); process.exit(1) }
  console.log(`Projet ${projet} · biens = ${count} (5 = production, 3 = staging)`)
  const manques = []
  const c = await sb.from('properties').select('latitude, longitude, coords_source, airbnb_listing_id').limit(1)
  console.log(`properties : colonnes ${c.error ? `ABSENTES (${c.error.message})` : 'presentes'}`)
  if (c.error) manques.push('colonnes de properties')
  // ⚠ PAS UNE REQUETE « head » : sur une table absente, elle rend un compte
  // `null` SANS erreur — la premiere version de ce script annoncait donc
  // « presente » quatre tables qui n'existaient pas (24 septembre 2026, contre
  // la production). Une vraie lecture, ET un compte qui est un nombre.
  for (const t of ['airroi_cache', 'airroi_appels', 'comparables_retenus', 'grille_controle']) {
    const r = await sb.from(t).select('*', { count: 'exact' }).limit(1)
    const ok = !r.error && Number.isInteger(r.count)
    console.log(`${t} : ${ok ? `presente, ${r.count} ligne(s)` : `ABSENTE (${r.error ? r.error.message : 'compte illisible'})`}`)
    if (!ok) manques.push(t)
  }
  console.log(manques.length ? `MANQUE : ${manques.join(', ')}` : 'OK : migration presente (RLS et policies : la requete de verification du SQL).')
  process.exit(manques.length ? 3 : 0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
