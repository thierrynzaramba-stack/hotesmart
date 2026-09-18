#!/usr/bin/env node
// scripts/verifier-pilote-tarifaire.js — lot 4.5.
// Verifie que la migration `2026-09-18-pilote-tarifaire.sql` est REELLEMENT
// appliquee sur la base visee, et que l'invariant de B bis y tient.
//
// Usage : node --env-file=.env.local scripts/verifier-pilote-tarifaire.js
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER.
// C'est la lecon du depot (feedback « verificateur et faux vert ») : un script
// qui compte zero anomalie sur zero ligne lue affiche « tout va bien » et ne
// prouve rien. Ici, zero bien lu = sortie 1. La non-vacuite est ASSERTEE, pas
// esperee.
//
// ⚠ ET IL REUTILISE LA REGLE, IL NE LA RECOPIE PAS. `piloteDuBien` et
// `peutPasserEnYieldflow` viennent de `lib/pilote-tarifaire.js` — celui-la
// meme que le serveur applique. Une copie ici derivereait le jour ou la regle
// changerait, et le verificateur validerait alors une regle qui n'existe plus.

const { createClient } = require('@supabase/supabase-js')
const {
  piloteDuBien, pousseSesPrix, peutPasserEnYieldflow
} = require('../lib/pilote-tarifaire')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents de l environnement.')
  process.exit(1)
}
const sb = createClient(URL, KEY)
// On dit SUR QUELLE BASE on travaille, sans jamais afficher la cle : le
// sous-domaine du projet suffit a distinguer staging de prod.
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

;(async () => {
  console.log(`Projet Supabase : ${projet}\n`)

  const { data, error } = await sb.from('properties')
    .select('id, name, rate_sync_mode, pilote_tarifaire')
    .order('name')

  if (error) {
    // Le cas le plus utile du script : la colonne n'existe pas encore.
    if (/pilote_tarifaire/.test(error.message)) {
      console.error('ECHEC : la colonne `pilote_tarifaire` est ABSENTE.')
      console.error('La migration migrations/2026-09-18-pilote-tarifaire.sql')
      console.error('n a pas ete appliquee sur cette base.')
      process.exit(1)
    }
    console.error('ECHEC : lecture impossible —', error.message)
    process.exit(1)
  }

  if (!data || !data.length) {
    console.error('ECHEC : aucun bien lu. Un verificateur qui n a rien lu')
    console.error('ne prouve rien — il ne doit pas rendre « tout va bien ».')
    process.exit(1)
  }

  let anomalies = 0
  const parMode = { calendrier: 0, yieldflow: 0 }

  for (const b of data) {
    const pilote = piloteDuBien(b)
    parMode[pilote] = (parMode[pilote] || 0) + 1

    // Anomalie 1 : une valeur que le module ne reconnait pas. Elle serait lue
    // « calendrier » (fail-closed a l envers) : silencieuse, donc a dire.
    if (b.pilote_tarifaire && b.pilote_tarifaire !== pilote) {
      console.error(`  ANOMALIE  ${b.name} : valeur inconnue `
        + `« ${b.pilote_tarifaire} », lue comme « ${pilote} »`)
      anomalies++
    }

    // Anomalie 2 : L INVARIANT DE B BIS. Un bien pilote par YieldFlow dont les
    // prix ne partent plus — l app ecrirait dans le vide.
    if (pilote === 'yieldflow' && !pousseSesPrix(b)) {
      console.error(`  ANOMALIE  ${b.name} : pilote par YieldFlow alors que `
        + `rate_sync_mode = « ${b.rate_sync_mode} ». `
        + 'Les prix calcules ne partiraient nulle part.')
      anomalies++
    }
  }

  console.log(`${data.length} biens lus`)
  console.log(`  pilote calendrier : ${parMode.calendrier}`)
  console.log(`  pilote yieldflow  : ${parMode.yieldflow}`)
  const basculables = data.filter(b => peutPasserEnYieldflow(b).ok).length
  console.log(`  dont basculables  : ${basculables} `
    + `(${data.length - basculables} en « je garde mes prix »)`)

  if (anomalies) {
    console.error(`\nECHEC : ${anomalies} anomalie(s).`)
    process.exit(1)
  }
  console.log('\nOK : la colonne existe, et aucun bien ne viole B bis.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
