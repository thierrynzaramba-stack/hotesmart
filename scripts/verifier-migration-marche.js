#!/usr/bin/env node
// scripts/verifier-migration-marche.js — LES MIGRATIONS 2026-09-24-marche-airroi,
// 2026-09-24-controle-airbnb ET 2026-09-24-calendrier-marche SONT-ELLES
// APPLIQUEES SUR LA BASE VISEE ?
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
  // Troisieme migration (2026-09-24-calendrier-marche) : la table ET sa
  // FORME. `create table if not exists` reussit en silence sur une table du
  // meme nom deja la sous une autre forme (Thierry, 24 septembre 2026) : on
  // lit les 22 colonnes par leur nom — une seule absente fait echouer.
  const COLONNES = ['id', 'pays', 'region', 'localite', 'capture_le', 'calcule_le', 'source', 'statut', 'motif',
    'fenetre_debut', 'fenetre_fin', 'horizon_fin', 'regimes', 'saisons', 'ruptures', 'au_dela', 'pics',
    'evenements_possibles', 'ecart_semaine_week_end', 'couverture_calendrier', 'limites', 'methode']
  const mc = await sb.from('marche_calendrier').select(COLONNES.join(', '), { count: 'exact' }).limit(1)
  const mcOk = !mc.error && Number.isInteger(mc.count)
  console.log(`marche_calendrier (calendrier-marche.sql) : ${mcOk ? `presente, ${COLONNES.length} colonnes lues par leur nom, ${mc.count} ligne(s)` : `ABSENTE ou d'une autre forme (${mc.error ? mc.error.message : 'compte illisible'})`}`)
  if (!mcOk) manques.push('marche_calendrier (2026-09-24-calendrier-marche.sql)')
  // Quatrieme migration (2026-09-24-marche-biens) : le lien logement → marche,
  // lu par ses 8 colonnes (le premier attendu annoncait 9 : c'est le controle
  // de forme colle par Thierry qui l'a attrape, 24 septembre 2026).
  const MB = ['id', 'user_id', 'property_id', 'pays', 'region', 'localite', 'lie_par', 'lie_le']
  const mb = await sb.from('marche_biens').select(MB.join(', '), { count: 'exact' }).limit(1)
  const mbOk = !mb.error && Number.isInteger(mb.count)
  console.log(`marche_biens (marche-biens.sql) : ${mbOk ? `presente, ${MB.length} colonnes lues par leur nom, ${mb.count} ligne(s)` : `ABSENTE ou d'une autre forme (${mb.error ? mb.error.message : 'compte illisible'})`}`)
  if (!mbOk) manques.push('marche_biens (2026-09-24-marche-biens.sql)')
  // La lecture COTE CLIENT doit echouer : la cle service contourne la RLS et ne
  // peut pas le voir (review). Sonde avec la cle anon, si elle est connue.
  if (process.env.SUPABASE_ANON_KEY) {
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    for (const t of ['airroi_cache', 'airroi_appels', 'grille_controle', 'marche_calendrier', 'marche_biens']) {
      const r = await anon.from(t).select('*').limit(1)
      const ferme = !!r.error || !(r.data || []).length
      console.log(`${t} vu du navigateur (anon) : ${r.error ? `refuse (${r.error.code || r.error.message})` : `${(r.data || []).length} ligne(s)`}`)
      if (!ferme) manques.push(`${t} lisible cote client`)
    }
  } else console.log('Cle anon absente : lecture cote client non sondee (voir la requete SQL, colonne lecture_client).')
  console.log(manques.length ? `MANQUE : ${manques.join(', ')}` : 'OK : migration presente (RLS et droits : la requete de verification du SQL).')
  process.exit(manques.length ? 3 : 0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
