#!/usr/bin/env node
// scripts/verifier-migration-beds24-token-expire.js
// La migration migrations/2026-10-23-beds24-token-expire.sql est-elle appliquee ?
//
// ⚠ POURQUOI UN VERIFICATEUR POUR DEUX COLONNES (constat de review).
// `add column if not exists` reussit EN SILENCE, et l'enjeu est propre a ce
// lot : sans les colonnes, le code reste sur son chemin de repli, refait
// 288 renouvellements par jour et N'ECRIT JAMAIS d'expiration. Le lot entier
// est alors inerte, et le seul signal est un `console.warn` que personne ne
// lit. « Appliquee » doit se PROUVER.
//
// ⚠ ET IL VERIFIE LE TYPE, PAS SEULEMENT LA PRESENCE. Une colonne `text` au
// lieu de `timestamptz` se lirait sans erreur et se comparerait en ORDRE
// LEXICAL : « 2026-9-1 » serait posterieur a « 2026-10-23 », et le cron
// sauterait des renouvellements sur un jeton mort. On le prouve en lecture
// seule, en demandant une comparaison avec une valeur qui n'est pas une date :
// une colonne temporelle la REFUSE (22007), une colonne texte l'accepte.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migration-beds24-token-expire.js
//   ENV_FILE=/home/thierry/hotesmart/.env.local \
//     node scripts/verifier-migration-beds24-token-expire.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
const PROJET = (URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || ''
const sb = createClient(URL, KEY)
const COLONNES = ['token_expire_le', 'token_renouvele_le']
const absente = (m) => /(does not exist|schema cache|not find|could not find)/i.test(String(m || ''))

;(async () => {
  console.log(`Projet Supabase : ${PROJET} (lecture seule)`)
  let ko = 0

  // 1. Les deux colonnes se lisent.
  {
    const { error } = await sb.from('api_keys')
      .select(['user_id', ...COLONNES].join(', ')).limit(1)
    if (error) {
      ko++
      console.error(absente(error.message)
        ? `KO  colonnes ABSENTES : ${error.message}`
        : `KO  lecture impossible : ${error.message}`)
    } else {
      console.log(`OK  les ${COLONNES.length} colonnes se lisent`)
    }
  }

  // 2. Chacune est bien TEMPORELLE, pas du texte.
  for (const c of COLONNES) {
    const { error } = await sb.from('api_keys').select('user_id').gt(c, 'pas-une-date').limit(1)
    if (error && absente(error.message)) {
      ko++
      console.error(`KO  ${c} : absente, type non verifiable`)
      continue
    }
    if (error) {
      console.log(`OK  ${c} est temporelle (${error.code || 'refus'} sur une non-date)`)
      continue
    }
    ko++
    console.error(`KO  ${c} ACCEPTE une non-date : elle n est pas timestamptz.`)
    console.error('    Les comparaisons se feraient en ordre LEXICAL, et le cron')
    console.error('    sauterait des renouvellements sur un jeton mort.')
  }

  // 3. L'etat des lignes, pour lire ce que le prochain cycle va faire.
  {
    const { data, error } = await sb.from('api_keys')
      .select('user_id, token_expire_le, token_renouvele_le')
      .not('refresh_token', 'is', null)
    if (error) { ko++; console.error(`KO  lecture des cles : ${error.message}`) } else {
      console.log(`--  ${(data || []).length} cle(s) avec un refresh_token`)
      for (const k of data || []) {
        const e = k.token_expire_le
        const reste = e ? Math.round((new Date(e).getTime() - Date.now()) / 60000) : null
        console.log(`    user ${String(k.user_id).slice(0, 8)} : `
          + (e ? `expire dans ${reste} min` : 'expiration INCONNUE -> le prochain cycle renouvelle')
          + (k.token_renouvele_le ? `, renouvele le ${k.token_renouvele_le}` : ', jamais renouvele par le lot'))
      }
    }
  }

  console.log('')
  if (ko) {
    console.error(`VERDICT : ${ko} point(s) en echec. La migration n est PAS en etat.`)
    process.exit(1)
  }
  console.log('VERDICT : migration 2026-10-23-beds24-token-expire appliquee.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
