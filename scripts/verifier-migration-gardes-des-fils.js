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
const {
  TYPES_CLASSIFICATION: TYPES,
  MOTIF_PAUSE: MOTIF,
  PREFIXE_AUTO,
  FENETRE_CONVERSATIONS,
  FENETRE_TACHES_PAUSE
} = require('../lib/gardes-des-fils')

// ⚠ LES VALEURS VIENNENT DU MODULE, PAS D'UNE COPIE. Un verificateur qui
// recopie les arguments verifie sa propre copie : il verdirait sur une base ou
// les fonctions attendent autre chose.
// ⚠ ET DE `lib/gardes-des-fils.js`, PAS DE `lib/cron-classify.js` : charger
// celui-la construit le client Anthropic de `lib/cron-shared.js`, donc exige
// `CLAUDE_API_KEY` — en production, la cle FACTURABLE. Un script de lecture
// seule n'a aucune raison de la charger (constat 15 de la review).

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
  // ⚠ LE TEMOIN DOIT PORTER DES LIGNES A TROUVER, PAS SEULEMENT DES FILS.
  // Un bien dont les 500 messages lus portent tous des reservations sans la
  // moindre ligne `agent_tasks` ni `conversations` ferait rendre `[]` aux
  // fonctions — et le point 2 n'eprouverait rien (constat 5). On classe donc
  // les biens par le nombre de reservations qui ont AU MOINS une tache de
  // classification, et c'est ce bien-la qu'on interroge.
  // Le `order by` explicite : sans lui, les 500 lignes rendues sont arbitraires.
  // ⚠ LE SCORE PORTE SUR LE MEME ENSEMBLE QUE LA LISTE INTERROGEE (constat 3
  // de la re-review) : je notais 200 identifiants et j'en interrogeais 500. Un
  // bien dont les reservations porteuses de taches tombent au-dela du 200e
  // marquait zero, et le script refusait une migration saine.
  // ⚠ ET IL COMPTE LES DEUX FAMILLES, PAS UNE (constat 2). Le point 2 exige une
  // reponse non vide des DEUX fonctions « derniere ». Noter le temoin sur les
  // seules taches laissait passer un bien a taches SANS conversation repondue —
  // la forme normale d'un `info_unknown` en Mode Test — et `rend ZERO ligne`
  // devenait un faux bloquant sur une migration correcte.
  const LOT_IDS = 200
  let bien = null, cle = null, ids = [], score = -1, detailScore = ''
  for (const b of biens) {
    const k = String(b.provider_property_id)
    const { data: msgs } = await sb.from('messages').select('booking_id, sent_at')
      .eq('user_id', b.user_id).eq('property_id', k).not('booking_id', 'is', null)
      .order('sent_at', { ascending: false }).limit(LOT_IDS)
    const liste = [...new Set((msgs || []).map(m => String(m.booking_id)))]
    if (!liste.length) continue
    const { data: avecTache } = await sb.from('agent_tasks').select('book_id')
      .eq('user_id', b.user_id).eq('property_id', k).in('book_id', liste)
      .in('task_type', TYPES).limit(1000)
    const nT = new Set((avecTache || []).map(x => String(x.book_id))).size
    const { data: avecReponse } = await sb.from('conversations').select('book_id')
      .eq('user_id', b.user_id).eq('property_id', k).in('book_id', liste)
      .not('agent_reply', 'is', null).limit(1000)
    const nR = new Set((avecReponse || []).map(x => String(x.book_id))).size
    // Le temoin doit nourrir LES DEUX fonctions : on prend le minimum, pas la
    // somme — un bien fort d'un cote et vide de l'autre ne vaut rien ici.
    const n = Math.min(nT, nR)
    if (n > score) { bien = b; cle = k; ids = liste; score = n; detailScore = `${nT} avec tache, ${nR} avec reponse` }
  }
  if (!bien || !ids.length) {
    console.error('KO  aucun bien channex ne porte de fil : les fonctions ne seraient interrogees')
    console.error('    qu avec une liste vide, ce qui ne prouve rien.')
    process.exit(1)
  }
  console.log(`Bien temoin : ${cle} — ${ids.length} reservation(s) dans ses fils (${detailScore})`)
  if (score === 0) {
    console.error('KO  aucun bien ne porte A LA FOIS une tache de classification et une')
    console.error('    conversation repondue : les deux fonctions « derniere » ne peuvent pas')
    console.error('    etre eprouvees sur cette base, et un vert ne voudrait rien dire.')
    process.exit(1)
  }

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
  //
  // ⚠ ZERO LIGNE NE PROUVE RIEN, ET C'ETAIT LE CONSTAT 5 : ma version d'avant
  // se gardait d'une liste d'identifiants vide, pas d'une REPONSE vide. Une
  // fonction qui rendrait deux lignes par reservation, ou les reservations d'un
  // autre compte, passait ce point sans etre interrogee — et le verdict final
  // disait « migration appliquee et fermee ». Une reponse vide est desormais un
  // KO : c'est le troisieme faux vert de ce script, et le troisieme de la meme
  // famille dans ce depot.
  for (const nom of ['cron_derniere_tache_classif', 'cron_derniere_reponse_hote']) {
    const lignes = reponses[nom]
    if (!lignes) continue
    if (!lignes.length) {
      ko++
      console.error(`KO  ${nom} rend ZERO ligne pour ${ids.length} reservation(s) :`)
      console.error('    la forme de sa reponse n a donc pas pu etre verifiee.')
      continue
    }
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
