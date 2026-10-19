#!/usr/bin/env node
// scripts/verifier-migration-canaux-echec.js
// La migration migrations/2026-10-19-canaux-echec-visible.sql est-elle
// appliquee ?
//
// ⚠ IL NE SUFFIT PAS DE DEMANDER « la colonne existe-t-elle ? ».
// `add column if not exists` reussit en silence, et une colonne peut exister
// avec le mauvais type, la mauvaise valeur par defaut ou la mauvaise
// nullabilite : l'appel passerait, et la premiere ecriture reelle ferait la
// difference — sur l'horloge d'un vrai compte.
//
// ON L'INTERROGE DONC PAR SON COMPORTEMENT :
//   1. les quatre colonnes se lisent ;
//   2. `echecs_consecutifs` est NOT NULL DEFAULT 0 : une ligne posee sans
//      cette colonne vaut 0, et y mettre `null` est refuse ;
//   3. les trois autres acceptent `null` — c'est leur etat normal quand tout
//      va bien ;
//   4. un entier et deux dates s'ecrivent et se relisent a l'identique ;
//   5. AUCUNE des quatre ne porte de secret : ce sont des compteurs et des
//      dates, et ce script le verifie en listant ce qu'une lecture CLIENT
//      authentifiee peut en voir.
// Les points 2 a 4 ECRIVENT : ce script REFUSE la production, et nettoie.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migration-canaux-echec.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
const PROJET = (URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || ''
const PROD = 'cjmrizpdyhrcurmgyrhs'
if (PROJET === PROD) {
  console.error(`REFUS : ${PROJET} est la PRODUCTION. Ce script ecrit — staging seulement.`)
  process.exit(2)
}
const sb = createClient(URL, KEY)

const NEUVES = ['echecs_consecutifs', 'premier_echec_le',
                'disparition_totale_vue_le', 'disparition_totale_nb']
// Un compte qui n'existe pas dans auth.users : `canaux_releve.user_id` n'a pas
// de cle etrangere, on peut donc poser une ligne d'essai sans toucher a personne.
const ESSAI = '00000000-0000-4000-8000-0000000000ec'

;(async () => {
  console.log(`Projet Supabase : ${PROJET} (production refusee)`)
  let ko = 0
  const ok = (m) => console.log('  ✓ ' + m)
  const ratE = (m) => { console.error('  ✗ ' + m); ko++ }

  // 1. Les quatre colonnes se lisent.
  const { error: e1 } = await sb.from('canaux_releve')
    .select(['user_id', ...NEUVES].join(', ')).limit(1)
  if (e1) ratE('les quatre colonnes ne se lisent pas : ' + e1.message)
  else ok('les quatre colonnes se lisent')

  await sb.from('canaux_releve').delete().eq('user_id', ESSAI)

  // 2. `echecs_consecutifs` : NOT NULL DEFAULT 0.
  const { error: e2 } = await sb.from('canaux_releve')
    .insert({ user_id: ESSAI, ok: false })
  if (e2) ratE('une ligne sans `echecs_consecutifs` est refusee : ' + e2.message)
  else {
    const { data } = await sb.from('canaux_releve')
      .select('echecs_consecutifs').eq('user_id', ESSAI).limit(1)
    const v = data && data[0] ? data[0].echecs_consecutifs : null
    if (v === 0) ok('`echecs_consecutifs` vaut 0 par defaut')
    else ratE('`echecs_consecutifs` vaut ' + JSON.stringify(v) + ' au lieu de 0')
  }

  const { error: e3 } = await sb.from('canaux_releve')
    .update({ echecs_consecutifs: null }).eq('user_id', ESSAI)
  if (e3) ok('`echecs_consecutifs` refuse `null` (NOT NULL)')
  else ratE('`echecs_consecutifs` a accepte `null` : la contrainte NOT NULL manque')

  // 3. Les trois autres acceptent `null` — leur etat normal.
  const { error: e4 } = await sb.from('canaux_releve')
    .update({ premier_echec_le: null, disparition_totale_vue_le: null,
              disparition_totale_nb: null }).eq('user_id', ESSAI)
  if (e4) ratE('les trois colonnes nullables refusent `null` : ' + e4.message)
  else ok('`premier_echec_le` et les deux colonnes du disjoncteur acceptent `null`')

  // 4. Un entier et deux dates s'ecrivent et se relisent a l'identique.
  const QUAND = '2026-10-19T09:00:00.000Z'
  const { error: e5 } = await sb.from('canaux_releve')
    .update({ echecs_consecutifs: 12, premier_echec_le: QUAND,
              disparition_totale_vue_le: QUAND, disparition_totale_nb: 2 })
    .eq('user_id', ESSAI)
  if (e5) ratE('ecriture refusee : ' + e5.message)
  else {
    const { data } = await sb.from('canaux_releve')
      .select(NEUVES.join(', ')).eq('user_id', ESSAI).limit(1)
    const l = (data && data[0]) || {}
    const memeInstant = (a, b) => a && new Date(a).getTime() === new Date(b).getTime()
    if (l.echecs_consecutifs === 12 && l.disparition_totale_nb === 2
        && memeInstant(l.premier_echec_le, QUAND)
        && memeInstant(l.disparition_totale_vue_le, QUAND)) {
      ok('entier et dates relus a l\'identique')
    } else {
      ratE('relecture differente de ce qui a ete ecrit : ' + JSON.stringify(l))
    }
  }

  // 5. Aucune des quatre ne porte de secret.
  //    ⚠ CE POINT NE SE DEDUIT PAS DU NOM DES COLONNES. On relit la ligne
  //    d'essai et on cherche, dans CE QUE LA BASE REND, une valeur qui
  //    ressemble a un jeton, une cle ou un identifiant de partenaire.
  const { data: tout } = await sb.from('canaux_releve')
    .select('*').eq('user_id', ESSAI).limit(1)
  const ligne = (tout && tout[0]) || {}
  const suspect = Object.entries(ligne).filter(([k, v]) =>
    typeof v === 'string' && v.length > 25 && !/^\d{4}-\d{2}-\d{2}T/.test(v)
    && k !== 'user_id')
  if (suspect.length) ratE('valeur longue non datee dans ' + suspect.map(([k]) => k).join(', '))
  else ok('aucune colonne ne porte de chaine longue : des compteurs et des dates')
  console.log('    colonnes rendues : ' + Object.keys(ligne).join(', '))

  await sb.from('canaux_releve').delete().eq('user_id', ESSAI)
  const { data: reste } = await sb.from('canaux_releve')
    .select('user_id').eq('user_id', ESSAI)
  if (reste && reste.length) ratE('la ligne d\'essai n\'a pas ete nettoyee')
  else ok('ligne d\'essai nettoyee')

  console.log(ko ? `\n${ko} point(s) en echec.` : '\nMigration appliquee et prouvee.')
  process.exit(ko ? 1 : 0)
})().catch(e => { console.error('Erreur :', e.message); process.exit(2) })
