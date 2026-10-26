#!/usr/bin/env node
// scripts/verifier-migration-read-at.js — la migration
// migrations/2026-10-11-conversation-read-at.sql est-elle appliquee ?
// Meme methode que verifier-migration-photo-url.js : empreinte en tete,
// colonne lue par son NOM. LECTURE SEULE.
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-read-at.js

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase } = require('../lib/empreinte-base')

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) { console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1) }
  const base = nomDeLaBase(process.env.SUPABASE_URL)
  console.log(`Base ${base} · biens = ${count}`)
  // ⚠ L'EMPREINTE EST LA REFERENCE DU PROJET, ET ELLE REFUSE (26 octobre 2026).
  // Ce script imprimait « biens = N (5 = production, 3 = staging) » puis
  // continuait sur n'importe quelle base designee par l'environnement. Deux
  // defauts dans une ligne : la legende est FAUSSE depuis que staging porte
  // quatre biens, et une legende n'est pas une garde — elle se lit apres coup,
  // dans une sortie que personne ne relit quand tout s'est bien passe.
  if (base === 'INCONNUE') {
    console.error(`ECHEC : projet Supabase inconnu — ni la production, ni staging.`)
    console.error(`Un resultat qui ne dit pas OU il a ete obtenu ne prouve rien.`)
    process.exit(1)
  }
  const { error: e } = await sb.from('conversation_flags').select('read_at').limit(0)
  if (e) { console.error(`  ✖ conversation_flags.read_at : ${e.message}`); console.error('ECHEC : migration absente.'); process.exit(2) }
  console.log('  ✔ conversation_flags.read_at lisible par son nom')
  console.log('Migration 2026-10-11-conversation-read-at : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
