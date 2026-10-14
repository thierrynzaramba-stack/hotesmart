#!/usr/bin/env node
// scripts/verifier-migration-menage-vu-le.js — les migrations
// `migrations/2026-10-14-menage-vu-le.sql` ET `...-menage-vu-par.sql`
// sont-elles appliquees sur CETTE base ?
//
// ⚠ LES DEUX ENSEMBLE, ET C'EST VOULU. `vu_le` sans `vu_par` dit QUAND
// quelqu'un a valide, pas QUI : la validation de la porteuse precedente reste
// collee au menage apres une reassignation, et l'hote lit « A jour » sur
// quelqu'un qui n'a jamais rien lu (constat de la revue de 20fb83d). Un script
// qui dirait « conforme » sur la premiere seule validerait ce trou.
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
  const COLONNES = ['vu_le', 'vu_par', 'relance_vu_j1_le', 'relance_vu_j0_le']
  for (const col of COLONNES) {
    const { error: e1 } = await sb.from('menages').select(col).limit(0)
    if (e1) { echecs++; console.log(`  ✖ menages.${col} : ${e1.message}`); continue }
    // `vu_par` est un identifiant, pas un instant : il se compare a un uuid.
    if (col === 'vu_par') {
      const { error: eId } = await sb.from('menages')
        .select('id').eq(col, '00000000-0000-0000-0000-000000000000').limit(0)
      if (eId) { echecs++; console.log(`  ✖ menages.${col} n'accepte pas un identifiant : ${eId.message}`); continue }
      console.log(`  ✔ menages.${col} lue par son nom, et comparable a un identifiant`)
      continue
    }
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

  // ⚠ UNE VALIDATION SANS AUTEUR EST UN TROU OUVERT : elle survivrait au
  // prochain changement de porteuse. Le rattrapage du complement doit avoir
  // tourne, et ce compte est ce qui le prouve.
  const { count: orphelines, error: e5 } = await sb.from('menages')
    .select('id', { count: 'exact', head: true })
    .not('vu_le', 'is', null).is('vu_par', null).not('provider_id', 'is', null)
  if (!e5 && Number.isInteger(orphelines)) {
    if (orphelines > 0) {
      echecs++
      console.log(`  ✖ ${orphelines} validation(s) sans auteur : le rattrapage de -vu-par n'a pas tourne`)
    } else console.log('  ✔ aucune validation sans auteur')
  }

  if (echecs) { console.error(`ECHEC : ${echecs} ecart(s) — migration absente ou incomplete.`); process.exit(2) }
  console.log('Migrations 2026-10-14-menage-vu-le et -vu-par : conformes sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
