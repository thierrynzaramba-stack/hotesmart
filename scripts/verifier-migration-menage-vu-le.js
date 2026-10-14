#!/usr/bin/env node
// scripts/verifier-migration-menage-vu-le.js — la migration
// `migrations/2026-10-14-menage-vu-le.sql` est-elle appliquee sur CETTE base ?
// Regle du depot : on colle la migration, et la verification passe par un
// script lance contre la base visee, qui affiche son empreinte en tete.
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-menage-vu-le.js
//
// ⚠ LECTURE SEULE, ET CHAQUE COLONNE SE LIT PAR SON NOM : un `select` limite a
// zero ligne. Une colonne absente ou mal nommee est une ERREUR, pas un silence.
//
// ⚠ LES TROIS COLONNES SE VERIFIENT SEPAREMENT, pas en un seul `select` : un
// `create table if not exists` ou une migration collee a moitie laisse
// exactement ce cas — deux colonnes sur trois — et un select groupe echouerait
// sans dire laquelle manque (feedback « verifier la forme d'une migration »).
//
// ⚠ CE QUI DEPEND DE CES COLONNES. Le bouton « Vu » de sa page, l'alerte
// « Non valide » de la bulle et de la fiche, et les deux relances du cron
// (J-1 et le jour J a 9 h de Paris). Sans elles, le bouton echoue et les
// relances ne partent pas.

const { createClient } = require('@supabase/supabase-js')

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) {
    console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1)
  }
  console.log(`Projet ${String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]} · biens = ${count} (5 = production, 3 = staging)`)

  let echecs = 0
  const COLONNES = ['vu_le', 'relance_vu_j1_le', 'relance_vu_j0_le']
  for (const col of COLONNES) {
    const { error: e1 } = await sb.from('menages').select(col).limit(0)
    if (e1) { echecs++; console.log(`  ✖ menages.${col} : ${e1.message}`); continue }
    // ⚠ UN INSTANT, PAS UN TEXTE : un `gte` sur une date ISO echoue si le type
    // ne la comprend pas. Sans cette passe, une colonne creee en `text` par
    // erreur passerait le controle ci-dessus.
    const { error: e2 } = await sb.from('menages')
      .select('id').gte(col, '2020-01-01T00:00:00Z').limit(0)
    if (e2) { echecs++; console.log(`  ✖ menages.${col} n'accepte pas une borne de temps : ${e2.message}`); continue }
    console.log(`  ✔ menages.${col} lue par son nom, et comparable a un instant`)
  }

  // Le rattrapage : ce qu'elle avait deja accepte doit etre valide. Une mesure,
  // pas une assertion — un compte a zero est normal sur une base ou personne
  // n'a jamais accepte de proposition depuis sa page.
  const { count: valides, error: e3 } = await sb.from('menages')
    .select('id', { count: 'exact', head: true }).not('vu_le', 'is', null)
  const { count: oui, error: e4 } = await sb.from('menages')
    .select('id', { count: 'exact', head: true })
    .not('accepted_at', 'is', null).or('assignment_reason.like.Accepte par %,assignment_reason.like.Pris par %')
  if (!e3 && !e4 && Number.isInteger(valides) && Number.isInteger(oui)) {
    console.log(`  · ${valides} menage(s) valide(s) ; ${oui} avai(en)t deja un oui d'elle (rattrapage attendu : ${oui})`)
    if (valides < oui) { echecs++; console.log('  ✖ le rattrapage n\'a pas ete execute : des oui deja donnes seraient relances') }
  }

  if (echecs) { console.error(`ECHEC : ${echecs} ecart(s) — migration absente ou incomplete.`); process.exit(2) }
  console.log('Migration 2026-10-14-menage-vu-le : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
