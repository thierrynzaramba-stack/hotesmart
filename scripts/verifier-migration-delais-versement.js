#!/usr/bin/env node
// scripts/verifier-migration-delais-versement.js
// La migration migrations/2026-10-25-delais-versement.sql est-elle appliquee ?
//
// ⚠ IL NE SUFFIT PAS DE DEMANDER « la table existe-t-elle ? ». `create table
// if not exists` reussit EN SILENCE sur une table a la forme differente, et
// une table peut exister SANS ses trois lignes : l'ecran rangerait alors tous
// les sejours dans « delai absent », c'est-a-dire nulle part, et le total
// aurait l'air juste.
//
// ON L'INTERROGE DONC PAR SON COMPORTEMENT :
//   1. la table se lit, et ses 5 colonnes sont la ;
//   2. les TROIS canaux sont semes, avec la base et le delai decides par
//      Thierry le 24 octobre 2026 — airbnb arrivee+1, booking depart+1,
//      direct reservation+3 ;
//   3. les deux CHECK mordent : une base inconnue et un delai negatif sont
//      refuses par la base, pas seulement par le code ;
//   4. la RLS est activee, et la cle publique LIT (c'est voulu : ces valeurs
//      ne sont la donnee de personne) mais n'ECRIT pas.
//
// Lecture seule par defaut : il peut donc tourner contre la PRODUCTION, et
// c'est la que ca compte — une migration « appliquee » sur staging seulement
// est le defaut le plus cher du depot.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migration-delais-versement.js --ecrit
//   ENV_FILE=/home/thierry/hotesmart/.env.local \
//     node scripts/verifier-migration-delais-versement.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const ANON = process.env.SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
const PROJET = (URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || ''
const PROD = 'cjmrizpdyhrcurmgyrhs'
const ECRIT = process.argv.includes('--ecrit')
if (ECRIT && PROJET === PROD) {
  console.error(`REFUS : ${PROJET} est la PRODUCTION. --ecrit est reserve a staging.`)
  process.exit(2)
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const pub = ANON ? createClient(URL, ANON, { auth: { persistSession: false } }) : null

let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++ }

// Les trois regles, telles que la migration les seme. Elles sont ECRITES ICI
// pour que le verificateur ait une attente a lui : lire la table et dire
// « conforme a elle-meme » ne prouverait rien.
const ATTENDU = {
  airbnb: { base: 'arrivee', jours: 1 },
  booking: { base: 'depart', jours: 1 },
  direct: { base: 'reservation', jours: 3 }
}

;(async () => {
  // ⚠ L'EMPREINTE EN TETE : un resultat qui ne dit pas OU il a ete obtenu ne
  // prouve rien. 5 biens = production, 3 = staging.
  const { count: biens, error: eB } = await sb.from('properties')
    .select('*', { count: 'exact', head: true })
  if (eB) { console.error('Empreinte illisible :', eB.message); process.exit(1) }
  const nom = biens === 5 ? 'PRODUCTION' : biens === 3 ? 'STAGING' : 'INCONNUE'
  console.log(`Base : ${PROJET} — ${biens} bien(s) — ${nom}\n`)
  if (nom === 'INCONNUE') { console.error('Empreinte inconnue : arret.'); process.exit(1) }

  // 1 et 2 : la table, sa forme, et ses trois lignes.
  const { data, error } = await sb.from('delais_versement')
    .select('canal, base, jours, libelle, maj_le')
  if (error) {
    ko(`table illisible : ${error.message}`)
    console.error('\nLa migration n est PAS appliquee sur cette base.')
    process.exit(1)
  }
  const lignes = data || []
  if (!lignes.length) {
    // ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER. Une table vide rendrait
    // tous les sejours « delai absent » — donc aucun revenu range, et un total
    // qui a l'air juste.
    ko('la table existe mais ne porte AUCUNE ligne : aucun revenu ne serait range')
  } else {
    ok(`${lignes.length} ligne(s) lues`)
  }
  for (const [canal, attendu] of Object.entries(ATTENDU)) {
    const l = lignes.find(x => x.canal === canal)
    if (!l) { ko(`le canal ${canal} n est pas seme`); continue }
    if (l.base !== attendu.base || Number(l.jours) !== attendu.jours) {
      ko(`${canal} : ${l.base} + ${l.jours} j, attendu ${attendu.base} + ${attendu.jours} j`)
    } else {
      ok(`${canal} : ${l.base} + ${l.jours} j`)
    }
  }
  // Les colonnes, comptees — pas seulement l'existence de la table.
  const manquantes = ['canal', 'base', 'jours', 'libelle', 'maj_le']
    .filter(c => lignes.length && !(c in lignes[0]))
  if (manquantes.length) ko(`colonnes absentes : ${manquantes.join(', ')}`)
  else if (lignes.length) ok('les 5 colonnes sont la')

  // 3 : les deux CHECK mordent. On ECRIT pour le savoir, donc staging seulement.
  if (ECRIT) {
    const refus = async (ligne, quoi) => {
      const { error: e } = await sb.from('delais_versement').insert(ligne)
      if (e) ok(`${quoi} : refuse par la base`)
      else {
        ko(`${quoi} : ACCEPTE par la base`)
        await sb.from('delais_versement').delete().eq('canal', ligne.canal)
      }
    }
    await refus({ canal: '_temoin_base', base: 'au depart', jours: 1 }, 'base inconnue')
    await refus({ canal: '_temoin_jours', base: 'depart', jours: -1 }, 'delai negatif')
    await refus({ canal: '_temoin_plafond', base: 'depart', jours: 999 }, 'delai hors plafond')
  } else {
    console.log('  (les CHECK ne sont pas eprouves : --ecrit, sur staging seulement)')
  }

  // 4 : la RLS. Lecture ouverte, ecriture fermee.
  if (pub) {
    const { data: lu, error: eL } = await pub.from('delais_versement').select('canal')
    if (eL) ko(`la cle publique ne LIT pas : ${eL.message} — l ecran ne saurait pas ranger`)
    else ok(`la cle publique lit ${(lu || []).length} ligne(s), comme prevu`)
    const { error: eE } = await pub.from('delais_versement')
      .insert({ canal: '_temoin_rls', base: 'depart', jours: 1 })
    if (eE) ok('la cle publique n ECRIT pas')
    else {
      ko('LA CLE PUBLIQUE ECRIT : n importe qui peut deplacer les revenus d un mois')
      await sb.from('delais_versement').delete().eq('canal', '_temoin_rls')
    }
  } else {
    console.log('  (RLS non eprouvee : SUPABASE_ANON_KEY absente)')
  }

  console.log(echecs ? `\n${echecs} ECHEC(S)` : '\nTout est conforme.')
  process.exit(echecs ? 1 : 0)
})().catch(e => { console.error('Exception :', e.message); process.exit(1) })
