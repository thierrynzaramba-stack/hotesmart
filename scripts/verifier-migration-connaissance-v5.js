#!/usr/bin/env node
// scripts/verifier-migration-connaissance-v5.js
// La migration `2026-11-04-connaissance-v5.sql` est-elle appliquee, et sous la
// BONNE FORME ?
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-connaissance-v5.js
//
// ⚠ LECTURE SEULE.
//
// ⚠ LA FORME, PAS L'EXISTENCE — lecon du depot : `create table if not exists`
// et `add column if not exists` reussissent EN SILENCE sur une forme differente.
// On lit donc chaque colonne par son NOM, on EPROUVE son TYPE en demandant a la
// base de comparer une valeur impossible (elle refuse dans le langage du type),
// et on EPROUVE le defaut sur TOUTES les lignes reelles.
//
// ⚠ CE QUE CE SCRIPT NE PEUT PAS PROUVER, ET IL LE DIT :
//   · l'INDEX : PostgREST n'expose pas `pg_indexes` (dette 32). La preuve se lit
//     dans l'editeur SQL :
//       select indexname, indexdef from pg_indexes
//       where tablename = 'knowledge' order by indexname;
//     On doit y voir `idx_knowledge_bien` sur (user_id, property_id, type).
//   · la contrainte NOT NULL elle-meme : l'API ne montre que des VALEURS. Le
//     script prouve qu'aucune ligne n'est nulle, pas que la colonne l'interdit.
//   · le defaut sur une table VIDE : sans ligne, il n'y a rien a eprouver, et le
//     script le dit au lieu de conclure « conforme » (constat de review).
//   · le TYPE EXACT de `verifie_le` : le refus prouve « date/heure » (ni texte
//     ni nombre), mais `date`, `timestamp` et `timestamptz` refusent tous
//     « pas-une-date ». « Avec fuseau » se lit dans l'editeur SQL :
//       select column_name, data_type from information_schema.columns
//       where table_name = 'knowledge' order by column_name;

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')

const COLONNES = ['verifie_le', 'lisible_par_ia']
const PAGE = 1000

// Le type se prouve par le REFUS, et des DEUX CÔTÉS (seconde review) : la
// colonne doit refuser une valeur impossible ET accepter une valeur de son
// type. Une colonne `text` accepterait tout ; une colonne `integer` refuserait
// aussi « pas-un-booleen », mais elle refuse « true » — d'où la seconde preuve.
const PREUVES_DE_TYPE = [
  { colonne: 'verifie_le', refusee: 'pas-une-date', codes: ['22007', '22008'],
    acceptee: '2026-01-01T00:00:00Z', type: 'date/heure (fuseau : voir l’en-tête)' },
  { colonne: 'lisible_par_ia', refusee: 'pas-un-booleen', codes: ['22P02'],
    acceptee: 'true', type: 'booléen' }
]

;(async () => {
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  if (base === 'INCONNUE') {
    console.error('ÉCHEC : base non reconnue — un vérificateur qui ne sait pas')
    console.error('        d’où il parle rend un résultat sans origine.')
    process.exit(3)
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count } = await sb.from('knowledge').select('id', { count: 'exact', head: true })
  console.log(`Base ${base} · knowledge = ${count} ligne(s)\n`)

  // 1. Chaque colonne repond par son NOM.
  for (const c of COLONNES) {
    const { error } = await sb.from('knowledge').select(c).limit(0)
    if (error) { console.error(`  ✖ ${c} : ${error.message}`); process.exit(1) }
    console.log(`  ✔ ${c} : la colonne répond`)
  }

  // 2. Chaque colonne a le BON TYPE.
  for (const p of PREUVES_DE_TYPE) {
    const { error } = await sb.from('knowledge').select('id').eq(p.colonne, p.refusee).limit(1)
    const code = String((error && error.code) || '')
    if (!error || !p.codes.includes(code)) {
      console.error(`  ✖ ${p.colonne} : pas un type ${p.type} (la base a ${error ? `rendu ${code || error.message}` : 'accepté une valeur impossible'})`)
      process.exit(1)
    }
    const { error: eOk } = await sb.from('knowledge').select('id').eq(p.colonne, p.acceptee).limit(1)
    if (eOk) {
      console.error(`  ✖ ${p.colonne} : refuse une valeur de type ${p.type} (${eOk.code || eOk.message})`)
      process.exit(1)
    }
    console.log(`  ✔ ${p.colonne} : type ${p.type} (refus ${code}, accepte « ${p.acceptee} »)`)
  }

  // 3. LE DEFAUT DE `lisible_par_ia` EST `true`, eprouve sur TOUTES les lignes,
  //    par curseur : PostgREST coupe a 1000 SANS ERREUR, et une colonne ajoutee
  //    avec le mauvais defaut aurait coupe l'IA sur toute la base, en silence.
  const lignes = []
  let apres = null
  for (;;) {
    let q = sb.from('knowledge').select('id, lisible_par_ia, verifie_le').order('id').limit(PAGE)
    if (apres != null) q = q.gt('id', apres)
    const { data, error } = await q
    if (error) { console.error('ÉCHEC :', error.message); process.exit(1) }
    lignes.push(...(data || []))
    if (!data || data.length < PAGE) break
    apres = data[data.length - 1].id
  }
  if (count != null && lignes.length !== count) {
    console.error(`ÉCHEC : ${lignes.length} ligne(s) lue(s) pour ${count} comptée(s) — lecture incomplète`)
    process.exit(1)
  }
  if (!lignes.length) {
    console.log('  ? lisible_par_ia : table VIDE — le défaut n’est PAS éprouvé ici.')
    console.log('\nMigration 2026-11-04-connaissance-v5 : colonnes et types présents ; défaut NON PROUVÉ (aucune ligne).')
    console.log('(L’INDEX n’est pas prouvé ici — voir l’en-tête du script.)')
    process.exit(2)
  }
  const horsIa = lignes.filter(l => l.lisible_par_ia === false)
  const nulles = lignes.filter(l => l.lisible_par_ia == null)
  console.log(`  ${nulles.length === 0 ? '✔' : '✖'} aucune valeur nulle parmi les ${lignes.length} ligne(s)`)
  // ⚠ « Hors IA » EST UN GESTE DE L'HÔTE, PAS UN ÉCHEC (seconde review) : le
  // script échouait au premier cadenas posé, donc il aurait sonné faux sur
  // staging comme en production. Le jour du collage, ce nombre doit être 0 ;
  // ensuite, il compte les « Hors IA » posés depuis l'écran.
  console.log(`  ℹ lisible_par_ia : ${lignes.length - horsIa.length}/${lignes.length} à true, ${horsIa.length} « Hors IA » posé(s) par l’hôte`)
  if (nulles.length) process.exit(1)

  // 4. `verifie_le` EST NULLE PARTOUT tant que l'hote n'a rien enregistre, et
  //    c'est le comportement attendu : une date posee par le systeme dirait
  //    « verifie » de ce que personne n'a relu.
  const posees = lignes.filter(l => l.verifie_le != null)
  console.log(`  ℹ verifie_le : ${posees.length} ligne(s) vérifiée(s) sur ${lignes.length}`)
  if (!posees.length) console.log('    (aucune : normal avant le premier enregistrement dans l’écran V5)')

  console.log(`\nMigration 2026-11-04-connaissance-v5 : conforme sur ce que l’API permet de prouver.`)
  console.log('(L’INDEX, la contrainte NOT NULL et le fuseau de verifie_le ne sont pas prouvés ici — voir l’en-tête du script.)')
})().catch(e => { console.error('ÉCHEC :', e.message); process.exit(1) })
