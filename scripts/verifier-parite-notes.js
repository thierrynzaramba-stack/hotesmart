#!/usr/bin/env node
// scripts/verifier-parite-notes.js — lot 2 du chantier chargement
// (20 octobre 2026). REVIEW.md regle 8 : une optimisation ne vaut que si elle
// rend EXACTEMENT les memes chiffres.
//
// Ce qu'il compare, sur les DONNEES REELLES de la base visee :
//   ANCIEN : ce que `pages/aujourdhui` obtenait, soit `noteMoyenne` appelee
//            une fois sans bien (le global) PUIS une fois par bien — les
//            1 + N appels a `/api/avis?action=cartes` que le lot supprime.
//   NOUVEAU : `notesDuPerimetre`, une seule lecture, global et par bien.
// Les deux viennent de lib/stats-avis.js : ce sont LES fonctions de
// production, pas une reimplementation — une copie prouverait la copie.
//
// Usage : node --env-file=/home/thierry/hotesmart/.env.local   scripts/verifier-parite-notes.js
//         node --env-file=/home/thierry/hotesmart/.env.staging scripts/verifier-parite-notes.js
//
// ⚠ EMPREINTE DE LA BASE EN TETE. Un resultat qui ne dit pas OU il a ete
// obtenu ne prouve rien, et « c'est conforme » sur la mauvaise base est pire
// que rien. 5 biens en production, 3 en staging (regle du depot).
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER. Zero avis partout n'est pas
// une parite, c'est une absence de mesure : le script le refuse explicitement.
//
// LECTURE SEULE : aucune ecriture, aucun DDL.

const { createClient } = require('@supabase/supabase-js')
const { noteMoyenne, notesDuPerimetre, PERIODES } = require('../lib/stats-avis')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents. Passer --env-file.')
  process.exit(1)
}
const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

let echecs = 0
let comparaisons = 0
let notesVues = 0
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++ }

const egal = (a, b) => a.moyenne === b.moyenne && a.notes === b.notes
const dire = (x) => (x.moyenne == null ? 'aucune note' : `${x.moyenne}/10 sur ${x.notes} avis`)

async function main () {
  console.log(`\nBase : ${projet}`)

  const { data: biens, error: eB } = await sb.from('properties')
    .select('id, name, user_id, provider_property_id')
    .not('provider_property_id', 'is', null).order('name')
  if (eB) { console.error('Lecture des biens impossible :', eB.message); process.exit(1) }
  if (!biens || !biens.length) { console.error('ECHEC : aucun bien lu. Rien a comparer.'); process.exit(1) }

  const { count: totalAvis, error: eA } = await sb.from('ota_reviews')
    .select('id', { count: 'exact', head: true })
  if (eA) { console.error('Lecture des avis impossible :', eA.message); process.exit(1) }

  console.log(`Empreinte : ${biens.length} bien(s) avec cle provider, ${totalAvis} avis dans ota_reviews.`)

  const comptes = [...new Set(biens.map(b => b.user_id))]
  console.log(`${comptes.length} compte(s) proprietaire(s).\n`)

  // Les quatre periodes, pas seulement celle de l'accueil : la fonction est
  // partagee, et une divergence peut n'apparaitre qu'a une borne.
  for (const periode of Object.keys(PERIODES)) {
    console.log(`── periode « ${periode} » ─────────────────────────────────────`)
    for (const userId of comptes) {
      const lesSiens = biens.filter(b => b.user_id === userId)

      // NOUVEAU : une lecture.
      const neuf = await notesDuPerimetre(sb, { userId, periode })
      if (neuf.erreur) { ko(`compte ${userId.slice(0, 8)} : lecture groupee en echec`); continue }

      // ANCIEN : le global, puis un appel par bien.
      const ancienGlobal = await noteMoyenne(sb, { userId, periode })
      comparaisons++
      notesVues += ancienGlobal.notes
      if (!egal(neuf.global, ancienGlobal)) {
        ko(`compte ${userId.slice(0, 8)} global : ancien ${dire(ancienGlobal)} / nouveau ${dire(neuf.global)}`)
      } else {
        console.log(`  ok    compte ${userId.slice(0, 8)} global : ${dire(ancienGlobal)}`)
      }

      for (const b of lesSiens) {
        const ref = String(b.provider_property_id)
        const ancien = await noteMoyenne(sb, { userId, periode, refs: [ref] })
        // Un bien sans avis n'a PAS de cle dans la reponse groupee : c'est
        // zero, et c'est ce que rendait son appel.
        const nouveau = neuf.par_bien[ref] || { moyenne: null, notes: 0 }
        comparaisons++
        if (!egal(nouveau, ancien)) {
          ko(`${b.name} (${ref}) : ancien ${dire(ancien)} / nouveau ${dire(nouveau)}`)
        } else {
          console.log(`  ok    ${b.name.padEnd(22)} ${dire(ancien)}`)
        }
      }

      // Une cle rendue pour un bien qui n'existe pas serait une fuite de
      // perimetre : le groupe doit se limiter aux refs du compte.
      const refsDuCompte = new Set(lesSiens.map(b => String(b.provider_property_id)))
      for (const ref of Object.keys(neuf.par_bien)) {
        if (!refsDuCompte.has(ref)) {
          ko(`la reponse groupee porte la reference ${ref}, qui n'est aucun bien de ce compte`)
        }
      }
    }
    console.log('')
  }

  console.log(`${comparaisons} comparaison(s).`)
  if (notesVues === 0) {
    console.error('\nECHEC : zero note comptee sur toutes les periodes et tous les comptes.')
    console.error('Une parite entre deux zeros ne prouve rien. Verifier la base visee.')
    process.exit(1)
  }
  if (echecs) {
    console.error(`\n${echecs} DIVERGENCE(S). Le lot ne doit pas partir.`)
    process.exit(1)
  }
  console.log('\nPARITE COMPLETE : la lecture groupee rend exactement les memes chiffres.')
}

main().catch(e => { console.error('Erreur :', e.message); process.exit(1) })
