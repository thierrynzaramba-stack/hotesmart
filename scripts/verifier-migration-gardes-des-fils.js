#!/usr/bin/env node
// scripts/verifier-migration-gardes-des-fils.js
// La migration migrations/2026-10-22-gardes-des-fils.sql est-elle appliquee ?
//
// ⚠ UNE FONCTION ABSENTE EST UN ECHEC, JAMAIS UN VERT. C'est la lecon du
// verificateur de cron_stats, qui avait rendu deux faux verts le 22 octobre :
// un refus d'ecriture faute de table se lisait « la cle publique n'ecrit pas ».
// Ici, chaque fonction manquante compte un KO et le script sort en 1.
//
// LES QUATRE POINTS :
//   1. les TROIS fonctions repondent a la cle service, avec la bonne SIGNATURE
//      (un argument renomme fait un 404 PostgREST : on le distingue) ;
//   2. elles rendent AU PLUS UNE LIGNE PAR RESERVATION — c'est leur raison
//      d'etre, et c'est ce qui rend la troncature impossible ;
//   3. elles sont FERMEES a la cle publique (revoke execute from anon,
//      authenticated) — `revoke from public` seul ne ferme rien chez Supabase ;
//   4. un appel avec une liste VIDE rend zero ligne sans lever : le cron le
//      fait pour un bien sans fil.
//
// Lecture seule, sans exception : il peut donc tourner contre la PRODUCTION.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migration-gardes-des-fils.js
//   ENV_FILE=/home/thierry/hotesmart/.env.local \
//     node scripts/verifier-migration-gardes-des-fils.js

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
const sb = createClient(URL, KEY)
const absente = (m) => /(does not exist|schema cache|not find|could not find)/i.test(String(m || ''))

// ⚠ LES VALEURS VIENNENT DU MODULE, PAS D'UNE COPIE. Un verificateur qui
// recopie les arguments verifie sa propre copie : il verdirait sur une base ou
// les fonctions attendent autre chose.
const {
  TYPES_CLASSIFICATION: TYPES,
  MOTIF_PAUSE: MOTIF,
  PREFIXE_AUTO,
  FENETRE_CONVERSATIONS,
  FENETRE_TACHES_PAUSE
} = require('../lib/cron-classify')

// Les trois fonctions, avec les arguments EXACTS que le cron leur passe.
const appels = (userId, propertyId, bookIds) => ([
  ['cron_derniere_tache_classif', { p_user_id: userId, p_property_id: propertyId, p_book_ids: bookIds, p_types: TYPES }],
  ['cron_derniere_reponse_hote', { p_user_id: userId, p_property_id: propertyId, p_book_ids: bookIds, p_prefixe_auto: PREFIXE_AUTO, p_fenetre: FENETRE_CONVERSATIONS }],
  ['cron_taches_pause_ouvertes', { p_user_id: userId, p_property_id: propertyId, p_book_ids: bookIds, p_motif: MOTIF, p_fenetre: FENETRE_TACHES_PAUSE }]
])

;(async () => {
  console.log(`Projet Supabase : ${PROJET} (lecture seule)`)
  let ko = 0

  // De vraies donnees : un bien channex qui PORTE des fils.
  //
  // ⚠ UN TEMOIN SANS FIL REND LES POINTS 1 ET 2 VIDES. Premiere version de ce
  // script : il prenait le premier bien venu, tombait sur `colomier` (zero
  // message), et interrogeait donc les fonctions avec une liste vide — elles
  // auraient rendu zero ligne meme fausses. Un verificateur qui n'a rien lu
  // doit echouer, pas verdir.
  const { data: biens, error: eB } = await sb.from('properties')
    .select('id, user_id, provider_property_id')
    .in('provider', ['channex', 'channel']).not('provider_property_id', 'is', null)
  if (eB || !biens?.length) {
    console.error(`KO  aucun bien channex lisible : ${eB?.message || 'liste vide'}`)
    process.exit(1)
  }
  let bien = null, cle = null, ids = []
  for (const b of biens) {
    const k = String(b.provider_property_id)
    const { data: msgs } = await sb.from('messages').select('booking_id')
      .eq('user_id', b.user_id).eq('property_id', k).not('booking_id', 'is', null).limit(500)
    const liste = [...new Set((msgs || []).map(m => String(m.booking_id)))]
    if (liste.length > ids.length) { bien = b; cle = k; ids = liste }
  }
  if (!bien || !ids.length) {
    console.error('KO  aucun bien channex ne porte de fil : les fonctions ne seraient interrogees')
    console.error('    qu avec une liste vide, ce qui ne prouve rien.')
    process.exit(1)
  }
  console.log(`Bien temoin : ${cle} — ${ids.length} reservation(s) dans ses fils`)

  // 1. Les trois fonctions repondent, avec la bonne signature.
  const reponses = {}
  for (const [nom, args] of appels(bien.user_id, cle, ids)) {
    const { data, error } = await sb.rpc(nom, args)
    if (error) {
      ko++
      console.error(absente(error.message)
        ? `KO  ${nom} ABSENTE ou signature differente : ${error.message}`
        : `KO  ${nom} repond une erreur : ${error.message}`)
      continue
    }
    reponses[nom] = data || []
    console.log(`OK  ${nom} repond — ${reponses[nom].length} ligne(s)`)
  }

  // 2. Au plus une ligne par reservation pour les deux gardes « derniere ».
  for (const nom of ['cron_derniere_tache_classif', 'cron_derniere_reponse_hote']) {
    const lignes = reponses[nom]
    if (!lignes) continue
    const vus = new Map()
    lignes.forEach(l => vus.set(String(l.book_id), (vus.get(String(l.book_id)) || 0) + 1))
    const fautifs = [...vus.entries()].filter(([, n]) => n > 1)
    if (fautifs.length) {
      ko++
      console.error(`KO  ${nom} rend PLUSIEURS lignes pour ${fautifs.length} reservation(s) — le distinct on ne mord pas`)
    } else {
      console.log(`OK  ${nom} : au plus une ligne par reservation`)
    }
    const hors = lignes.filter(l => !ids.includes(String(l.book_id)))
    if (hors.length) {
      ko++
      console.error(`KO  ${nom} rend ${hors.length} reservation(s) HORS de la liste demandee`)
    }
  }

  // 3. Les fonctions sont fermees a la cle publique.
  if (!ANON) {
    console.log('--  SUPABASE_ANON_KEY absente : le point des droits n a PAS ete verifie')
    ko++
  } else {
    const pub = createClient(URL, ANON)
    for (const [nom, args] of appels(bien.user_id, cle, ids)) {
      const { data, error } = await pub.rpc(nom, args)
      // ⚠ « ABSENTE » N'EST PAS « REFUSEE », ET LES CONFONDRE EST LE FAUX VERT
      // QUE CE DEPOT A DEJA PAYE. Ma premiere version lisait « OK, refusee a la
      // cle publique » sur une base ou la fonction n'existait meme pas : le
      // point le plus important du script verdissait sans rien prouver.
      if (error && absente(error.message)) {
        ko++
        console.error(`KO  ${nom} : droits NON verifiables, la fonction est absente`)
        continue
      }
      if (error) { console.log(`OK  ${nom} refusee a la cle publique (${error.code || 'refus'})`); continue }
      ko++
      console.error(`KO  ${nom} REPOND a la cle publique (${(data || []).length} ligne(s)) — revoke execute manquant`)
    }
  }

  // 4. Une liste vide ne leve pas.
  for (const [nom, args] of appels(bien.user_id, cle, [])) {
    const { data, error } = await sb.rpc(nom, args)
    if (error) { ko++; console.error(`KO  ${nom} leve sur une liste vide : ${error.message}`); continue }
    if ((data || []).length !== 0) { ko++; console.error(`KO  ${nom} rend ${data.length} ligne(s) pour une liste VIDE`); continue }
    console.log(`OK  ${nom} rend zero ligne sur une liste vide`)
  }

  console.log('')
  if (ko) {
    console.error(`VERDICT : ${ko} point(s) en echec. La migration n est PAS en etat.`)
    process.exit(1)
  }
  console.log('VERDICT : migration 2026-10-22-gardes-des-fils appliquee et fermee.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
