#!/usr/bin/env node
// scripts/verifier-avis-evaluation.js — lot 2 du chantier « evaluation du
// voyageur ». Verifie que les TROIS migrations du 25 septembre 2026 sont
// REELLEMENT appliquees sur la base visee :
//   2026-09-25-avis-evaluation-voyageur.sql
//   2026-09-25-core-events.sql
//   2026-09-25-conversation-flags-archivage.sql
//
// Usage : node --env-file=.env.local   scripts/verifier-avis-evaluation.js
//         node --env-file=.env.staging scripts/verifier-avis-evaluation.js
//
// ⚠ EMPREINTE DE LA BASE, EN TETE ET SANS QUOI RIEN NE COMPTE. 5 biens en
// production, 3 en staging (regle du depot). Un resultat sans elle ne dit pas
// OU il a ete obtenu, et « c'est applique » sur la mauvaise base est pire que
// rien.
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER. Zero evaluation est normal
// (aucun lot ne les ecrit encore) ; une table ABSENTE, une colonne manquante,
// une ecriture possible depuis le client sont des echecs. On les distingue.
//
// LECTURE SEULE : ce script n'ecrit rien. Il teste l'ecriture cliente par des
// requetes qui DOIVENT echouer — des tentatives refusees, pas des ecritures.
//
// ⚠ IL EST LA SEULE PREUVE, ET IL DIT OU S'ARRETE SA VUE. Regle gravee par
// Thierry (25 septembre 2026) : aucun SELECT de verification dans l'editeur
// Supabase. Ce script remplace ces requetes — mais il parle a PostgREST, qui
// n'expose que le schema `public`. Ce qu'il PROUVE : l'existence des tables,
// de chaque colonne, les valeurs des reglages, et le refus d'ecriture sous les
// deux roles. Ce qu'il NE VOIT PAS : les index, les declencheurs et les
// contraintes CHECK, qui vivent dans pg_catalog. Ceux-la sont crees par le
// collage lui-meme : si l'editeur n'a pas rendu d'erreur, ils sont la. Le
// script le RAPPELLE en fin de course au lieu de laisser croire le contraire.
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const ANON = process.env.SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.')
  process.exit(1)
}
const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++ }

// Une table existe-t-elle, et combien de lignes ?
//
// ⚠ PAS DE `head: true`. Mesure du 25 septembre 2026, sur cette base : une
// requete de comptage « tete seule » sur une table ABSENTE rend
// `{ count: null, error: null, status: 204 }` — aucune erreur. La premiere
// version de ce script annoncait donc « table presente (0 ligne(s)) » pour
// trois tables qui n'existaient pas. C'est le faux vert exact que le depot
// combat : un verificateur qui n'a rien lu doit ECHOUER, pas rassurer.
// On demande donc une vraie ligne : PostgREST rend alors PGRST205.
async function table (nom) {
  const { error } = await sb.from(nom).select('*').limit(1)
  if (error) {
    // ⚠ LE CODE, PAS LE MESSAGE. « permission denied for relation core_events »
    // contient « relation » : une regex large classait un refus de droits en
    // « table absente », et envoyait relancer une migration deja appliquee.
    if (error.code === 'PGRST205' || error.code === '42P01') return { absente: true }
    return { erreur: error.message }
  }
  const { count, error: eCount } = await sb.from(nom).select('*', { count: 'exact', head: true })
  if (eCount) return { erreur: eCount.message }
  return { lignes: count || 0 }
}

// Les colonnes d'une table, vues par une lecture d'une ligne vide : PostgREST
// rend l'erreur « column ... does not exist » si on demande une colonne absente.
async function colonnes (nom, liste) {
  const { error } = await sb.from(nom).select(liste.join(',')).limit(1)
  if (!error) return { toutes: true }
  const m = error.message.match(/column [^.]*\.?"?([a-z_]+)"? does not exist/i)
  return { toutes: false, manquante: m ? m[1] : error.message }
}

;(async () => {
  console.log(`Projet Supabase : ${projet}`)
  const biens = await table('properties')
  if (biens.absente || biens.erreur) {
    console.error('ECHEC : `properties` illisible — mauvaise base ou cle invalide.')
    process.exit(1)
  }
  const attendu = biens.lignes === 5 ? 'PRODUCTION' : biens.lignes === 3 ? 'STAGING' : 'INCONNUE'
  console.log(`Empreinte : ${biens.lignes} bien(s) → base ${attendu}\n`)
  if (attendu === 'INCONNUE') {
    console.error('ECHEC : empreinte inattendue (5 en prod, 3 en staging).')
    console.error('Verifier la base visee avant de conclure quoi que ce soit.')
    process.exit(1)
  }

  console.log('Migration 1 — guest_evaluations, avis_config, profiles')
  for (const nom of ['guest_evaluations', 'avis_config']) {
    const t = await table(nom)
    if (t.absente) ko(`table \`${nom}\` ABSENTE — migration non appliquee`)
    else if (t.erreur) ko(`table \`${nom}\` illisible : ${t.erreur}`)
    else ok(`table \`${nom}\` presente (${t.lignes} ligne(s))`)
  }
  const cEval = await colonnes('guest_evaluations', [
    'id', 'user_id', 'property_id', 'property_id_ref', 'booking_uid', 'ota_review_id',
    'menage_event_id', 'provider', 'ota', 'status', 'answers_cleaner', 'answers_host',
    'scores', 'public_text', 'private_note', 'language', 'filled_by_profile',
    'validated_by_profile', 'published_at', 'deadline_at', 'provider_response',
  ])
  cEval.toutes ? ok('guest_evaluations : les 21 colonnes attendues')
               : ko(`guest_evaluations : colonne manquante — ${cEval.manquante}`)
  const cConf = await colonnes('avis_config', ['user_id', 'property_id', 'keywords', 'tone', 'signature'])
  cConf.toutes ? ok('avis_config : les colonnes attendues')
               : ko(`avis_config : colonne manquante — ${cConf.manquante}`)
  const cProf = await colonnes('profiles', ['id', 'eval_scope', 'eval_power'])
  cProf.toutes ? ok('profiles : eval_scope et eval_power posees')
               : ko(`profiles : colonne manquante — ${cProf.manquante}`)
  if (cProf.toutes) {
    // Les defauts de la spec : proprete / soumettre. Sur les profils existants,
    // la valeur par defaut a ete appliquee par le ALTER.
    // ⚠ PAS DE `.limit()` MUETTE. La premiere version lisait 200 profils et
    // annoncait « valeurs conformes » : au-dela, les lignes n'etaient jamais
    // regardees, et la ligne se lisait comme un succes. On compte la base
    // entiere, et on compte les ecarts EN BASE, pas en memoire.
    const { count: total, error: eT } = await sb.from('profiles')
      .select('*', { count: 'exact', head: true })
    const { count: hors, error: eH } = await sb.from('profiles')
      .select('*', { count: 'exact', head: true })
      .or('eval_scope.not.in.(aucun,proprete,complet),eval_power.not.in.(soumettre,valider)')
    if (eT || eH) ko(`profiles : comptage impossible — ${(eT || eH).message}`)
    else if (hors) ko(`profiles : ${hors} profil(s) sur ${total} hors valeurs autorisees`)
    else ok(`profiles : ${total} profil(s) au total, tous conformes`)
  }

  console.log('\nMigration 2 — core_events')
  const ce = await table('core_events')
  if (ce.absente) ko('table `core_events` ABSENTE — migration non appliquee')
  else if (ce.erreur) ko(`table \`core_events\` illisible : ${ce.erreur}`)
  else {
    ok(`table \`core_events\` presente (${ce.lignes} ligne(s))`)
    const cEv = await colonnes('core_events', [
      'id', 'user_id', 'type', 'subject_type', 'subject_id', 'payload',
      'created_at', 'processed_at', 'processing_errors',
    ])
    cEv.toutes ? ok('core_events : les colonnes attendues')
               : ko(`core_events : colonne manquante — ${cEv.manquante}`)
    const { count, error: eFile } = await sb.from('core_events')
      .select('*', { count: 'exact', head: true }).is('processed_at', null)
    eFile ? ko(`core_events : file illisible — ${eFile.message}`)
          : ok(`core_events : ${count || 0} evenement(s) en attente de traitement`)
  }
  // booking_change_events doit etre INTOUCHEE : elle existe et garde son CHECK.
  const bce = await table('booking_change_events')
  bce.absente ? ko('booking_change_events a disparu — elle devait rester intouchee')
              : ok(`booking_change_events intouchee (${bce.lignes} ligne(s))`)

  console.log('\nMigration 3 — conversation_flags')
  const cf = await table('conversation_flags')
  if (cf.absente) ko('table `conversation_flags` ABSENTE')
  else {
    ok(`table \`conversation_flags\` presente (${cf.lignes} ligne(s))`)
    const cFl = await colonnes('conversation_flags', [
      'user_id', 'book_id', 'pinned', 'archive_after',
      'archived_manual', 'unarchived_manual_at', 'archived_reason', 'property_id_ref',
    ])
    cFl.toutes ? ok('conversation_flags : les colonnes d archivage sont posees')
               : ko(`conversation_flags : colonne manquante — ${cFl.manquante}`)
    // ⚠ `book_id` DOIT REPONDRE ENCORE. Le renommage en `booking_uid` est au
    // lot 7, avec le code de la messagerie qui le suit : renommer maintenant
    // casserait l'epinglage a l'instant du collage (voir l'en-tete de la
    // migration). Un `booking_uid` present ici signalerait un renommage
    // premature, pas un progres.
    const { error: eNouveau } = await sb.from('conversation_flags').select('booking_uid').limit(1)
    eNouveau ? ok('conversation_flags : `book_id` intacte, renommage bien differe au lot 7')
             : ko('conversation_flags : `booking_uid` existe deja — renommage premature, la messagerie lit `book_id`')
  }

  console.log('\nGardes — le client ne doit rien pouvoir ecrire')
  // ⚠ CE CONTROLE DOIT PROUVER LE REFUS DE DROIT, PAS UN AUTRE REFUS.
  // Constat de review : la premiere version inserait `{ user_id }` seul et
  // comptait TOUTE erreur comme une garde fermee. Or `guest_evaluations` a
  // cinq colonnes NOT NULL sans defaut et `core_events` exige `type` : la
  // requete echouait en 23502 (contrainte) meme si le REVOKE avait saute.
  // On envoie donc une ligne COMPLETE et VALIDE, et on exige le code du
  // refus de droit — 42501 cote Postgres, PGRST301 cote PostgREST.
  //
  // ⚠ ET SOUS LE ROLE `authenticated`, celui que visent les policies. La cle
  // anonyme n'exerce que le role `anon` : un REVOKE oublie sur
  // `authenticated` serait passe inapercu.
  const LIGNES = {
    guest_evaluations: {
      user_id: '00000000-0000-0000-0000-000000000000',
      property_id: '00000000-0000-0000-0000-000000000000',
      property_id_ref: 'garde-test', booking_uid: 'garde-test',
      provider: 'channex', ota: 'airbnb',
    },
    avis_config: { user_id: '00000000-0000-0000-0000-000000000000' },
    core_events: { user_id: '00000000-0000-0000-0000-000000000000', type: 'garde.test' },
  }
  const REFUS = new Set(['42501', 'PGRST301', 'PGRST204'])
  async function garde (client, role) {
    for (const [nom, ligne] of Object.entries(LIGNES)) {
      const { error } = await client.from(nom).insert(ligne)
      if (!error) { ko(`\`${nom}\` (${role}) : UNE ECRITURE A ETE ACCEPTEE — la garde est ouverte`); continue }
      const code = String(error.code || '')
      if (code === 'PGRST205') { ko(`\`${nom}\` (${role}) : garde NON TESTEE — la table est absente`); continue }
      if (REFUS.has(code)) { ok(`\`${nom}\` (${role}) : refus de droit (${code})`); continue }
      // Une contrainte violee ne prouve rien sur la garde : on le dit.
      ko(`\`${nom}\` (${role}) : refus AMBIGU (${code}) — ce n est pas un refus de droit : ${error.message.slice(0, 60)}`)
    }
  }
  // ⚠ « NON TESTEE » N'EST PAS « OK ». La garde d'ecriture est le controle le
  // plus lourd de consequence : une RLS ouverte, c'est une fuite entre comptes.
  // Sauter ce controle en silence et finir sur « OK » serait le faux vert que
  // ce script existe pour empecher. Cle absente => ECHEC, avec le remede.
  if (!ANON) {
    ko('SUPABASE_ANON_KEY absente de cet environnement : gardes NON TESTEES')
    console.error('        Remede : ajouter SUPABASE_ANON_KEY (la cle publique du')
    console.error('        projet, celle du front) au fichier .env vise, puis relancer.')
  } else {
    await garde(createClient(URL, ANON), 'anon')
    const { TEST_EMAIL, TEST_PASSWORD } = process.env
    if (!TEST_EMAIL || !TEST_PASSWORD) {
      ko('TEST_EMAIL / TEST_PASSWORD absents : role `authenticated` NON TESTE')
      console.error('        C est le role que visent les policies : le role `anon` seul')
      console.error('        ne prouve pas qu un REVOKE sur `authenticated` est en place.')
    } else {
      const connecte = createClient(URL, ANON)
      const { error: eAuth } = await connecte.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD })
      if (eAuth) ko(`session de test impossible : ${eAuth.message} — role \`authenticated\` non teste`)
      else { await garde(connecte, 'authenticated'); await connecte.auth.signOut() }
    }
  }

  if (echecs) {
    console.error(`\nECHEC : ${echecs} controle(s) en defaut sur la base ${attendu}.`)
    process.exit(1)
  }
  console.log(`\nOK : les trois migrations sont appliquees sur la base ${attendu}.`)
  console.log('\nNon vu d ici (pg_catalog n est pas expose par PostgREST) :')
  console.log('  index, declencheurs updated_at, contraintes CHECK.')
  console.log('  Ils sont crees par le collage : un editeur sans erreur les a poses.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
