#!/usr/bin/env node
// scripts/verifier-migrations-4-6.js — les migrations du lot 4.6, PROUVEES
// SUR LA BASE VISEE. Registre : docs/kb/dettes-v1.md (dettes 2, 18, 23).
//
//   2026-09-20-pilote-fenetre.sql      properties.pilote_fenetre_type / _valeur
//   2026-09-22-prix-hote.sql           table prix_hote
//   2026-09-23-prix-hote-journal.sql   table prix_hote_journal
//
// Usage : node --env-file=.env.local scripts/verifier-migrations-4-6.js
//
// ⚠ POURQUOI CE SCRIPT (23 septembre 2026). La table `fermetures` était
// déclarée « collée en prod, vérifications conformes » depuis la veille, et
// l'API de production ne la connaissait pas. Le SQL de contrôle collé à la main
// répond aussi bien sur staging : il ne prouve pas QUELLE base a reçu la
// migration. Ce script interroge l'API du projet visé — celle que le code lit.
//
// ⚠ LECTURE SEULE. Une ligne au plus par table, colonnes nommées : si une
// colonne ou une table manque, PostgREST refuse la requête, et c'est la preuve.
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT LE DIRE : une lecture en échec est
// une sortie 1 ; toutes présentes, sortie 0.

const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

const ATTENDUS = [
  { migration: '2026-09-20-pilote-fenetre.sql', table: 'properties', colonnes: 'id, pilote_fenetre_type, pilote_fenetre_valeur' },
  { migration: '2026-09-22-prix-hote.sql', table: 'prix_hote', colonnes: 'id, user_id, property_id, stay_date, rate_cents, created_at, updated_at' },
  { migration: '2026-09-23-prix-hote-journal.sql', table: 'prix_hote_journal', colonnes: 'id, user_id, property_id, stay_date, evenement, geste, rate_cents, rate_cents_avant, created_at' }
]

;(async () => {
  console.log(`Projet Supabase : ${projet} — lecture seule\n`)
  let manquantes = 0
  for (const a of ATTENDUS) {
    const { data, error, count } = await sb.from(a.table).select(a.colonnes, { count: 'exact' }).limit(1)
    if (error) {
      manquantes++
      console.log(`✖ ${a.migration} — ${a.table} : ${error.message}`)
    } else {
      console.log(`✔ ${a.migration} — ${a.table} : colonnes présentes (${count} ligne(s), ${(data || []).length} lue(s))`)
    }
  }
  // Une empreinte de la base, pour que le compte rendu dise laquelle a répondu.
  const { count: biens, error: eB } = await sb.from('properties').select('id', { count: 'exact', head: true })
  console.log(`\nEmpreinte : ${eB ? 'illisible' : biens + ' bien(s) dans properties'}`)
  if (manquantes) { console.error(`\nECHEC : ${manquantes} migration(s) absente(s) de ${projet}.`); process.exit(1) }
  console.log(`\nOK : les ${ATTENDUS.length} migrations du lot 4.6 sont présentes sur ${projet}.`)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
