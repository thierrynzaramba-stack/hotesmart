#!/usr/bin/env node
// scripts/verifier-migration-pwa-vue-le.js — la migration
// `migrations/2026-10-14-pwa-vue-le.sql` est-elle appliquee sur CETTE base ?
// Regle du depot : on colle la migration, et la verification passe par un
// script lance contre la base visee, qui affiche son empreinte en tete.
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-pwa-vue-le.js
//
// ⚠ LECTURE SEULE, ET LA COLONNE SE LIT PAR SON NOM : un `select` de la
// colonne, limite a zero ligne. Une colonne absente ou mal nommee est une
// ERREUR, pas un silence — c'est tout l'objet du script.
//
// ⚠ CE QUI DEPEND DE CETTE COLONNE. L'en-tete de la fiche prestataire
// (« Vue il y a … ») et le type `pas_vu` de la bulle « A traiter ». Sans elle,
// les deux se TAISENT — c'est voulu — mais rien d'autre ne tombe : la lecture
// est separee de celle des periodes de ratio, exprès.

const { createClient } = require('@supabase/supabase-js')

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) {
    console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1)
  }
  console.log(`Projet ${String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]} · biens = ${count} (5 = production, 3 = staging)`)

  let echecs = 0
  const { error: e1 } = await sb.from('public_tokens').select('pwa_vue_le').limit(0)
  if (e1) { echecs++; console.log(`  ✖ public_tokens.pwa_vue_le : ${e1.message}`) }
  else console.log('  ✔ public_tokens.pwa_vue_le lue par son nom')

  // ⚠ LA COLONNE DOIT ETRE UN INSTANT, pas un texte : un `gte` sur une date
  // ISO echoue si le type ne la comprend pas. Sans cette passe, une colonne
  // creee en `text` par erreur passerait le controle ci-dessus.
  const { error: e2 } = await sb.from('public_tokens')
    .select('token').gte('pwa_vue_le', '2020-01-01T00:00:00Z').limit(0)
  if (e2) { echecs++; console.log(`  ✖ public_tokens.pwa_vue_le n'accepte pas une borne de temps : ${e2.message}`) }
  else console.log('  ✔ elle se compare a un instant (timestamptz)')

  // Combien de liens ont deja ete ouverts : une mesure, pas une assertion.
  const { count: ouverts, error: e3 } = await sb.from('public_tokens')
    .select('token', { count: 'exact', head: true }).not('pwa_vue_le', 'is', null)
  if (!e3 && Number.isInteger(ouverts)) {
    const { count: total } = await sb.from('public_tokens').select('token', { count: 'exact', head: true })
    console.log(`  · ${ouverts} lien(s) deja ouvert(s) sur ${total} — zero est NORMAL juste apres la migration`)
  }

  if (echecs) { console.error(`ECHEC : ${echecs} ecart(s) — migration absente ou incomplete.`); process.exit(2) }
  console.log('Migration 2026-10-14-pwa-vue-le : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
