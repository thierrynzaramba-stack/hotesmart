#!/usr/bin/env node
// scripts/verifier-migration-marche.js — LES MIGRATIONS 2026-09-24-marche-airroi
// ET 2026-09-24-controle-airbnb SONT-ELLES APPLIQUEES SUR LA BASE VISEE ?
// Lecture seule.
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
  if (error || !Number.isInteger(count)) { console.error(`ECHEC : empreinte illisible ${error ? error.message : ''}`); process.exit(1) }
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
  // Seconde migration (2026-09-24-controle-airbnb) : la variante Airbnb.
  const v = await sb.from('grille_controle').select('niveaux_mesure_12m_airbnb, nuits_mesure_12m_airbnb').limit(1)
  console.log(`grille_controle, variante Airbnb (controle-airbnb.sql) : ${v.error ? `ABSENTE (${v.error.message})` : 'presente'}`)
  if (v.error) manques.push('colonnes Airbnb de grille_controle (2026-09-24-controle-airbnb.sql)')
  // La lecture COTE CLIENT doit echouer : la cle service contourne la RLS et ne
  // peut pas le voir (review). Sonde avec la cle anon, si elle est connue.
  if (process.env.SUPABASE_ANON_KEY) {
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    for (const t of ['airroi_cache', 'airroi_appels', 'grille_controle']) {
      const r = await anon.from(t).select('*').limit(1)
      const ferme = !!r.error || !(r.data || []).length
      console.log(`${t} vu du navigateur (anon) : ${r.error ? `refuse (${r.error.code || r.error.message})` : `${(r.data || []).length} ligne(s)`}`)
      if (!ferme) manques.push(`${t} lisible cote client`)
    }
  } else console.log('Cle anon absente : lecture cote client non sondee (voir la requete SQL, colonne lecture_client).')
  console.log(manques.length ? `MANQUE : ${manques.join(', ')}` : 'OK : migration presente (RLS et droits : la requete de verification du SQL).')
  process.exit(manques.length ? 3 : 0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
