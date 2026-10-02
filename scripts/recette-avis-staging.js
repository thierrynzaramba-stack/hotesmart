#!/usr/bin/env node
// scripts/recette-avis-staging.js
//
// PREPARE LE DECOR DE RECETTE HUMAINE DU CHANTIER « EVALUATION DU VOYAGEUR »,
// et bascule le rôle du compte de test.
//
// ⚠ STAGING UNIQUEMENT, deux empreintes le verifient : la reference du projet et
// le nombre de biens. Il ECRIT (une ligne ota_reviews, une evaluation, et le
// profil du compte de test) et il refuse de demarrer ailleurs.
//
// ⚠ AUCUNE PUBLICATION REELLE N'EST POSSIBLE PENDANT LA RECETTE, a condition que
// la variable `AVIS_PUBLICATION_SIMULEE=1` soit posee sur le deploiement. Ce
// script le RAPPELLE et refuse de preparer le decor si l'objet review qu'il cree
// pouvait atteindre l'OTA — il donne une reference qui n'existe pas chez Channex,
// donc un envoi reel echouerait en 404 plutot que de partir.
//
// Usage :
//   node --env-file=.env.staging scripts/recette-avis-staging.js            (etat)
//   node --env-file=.env.staging scripts/recette-avis-staging.js --decor    (cree une evaluation a remplir)
//   node --env-file=.env.staging scripts/recette-avis-staging.js --decor-pwa
//        (lots 5 a 7 : une prestataire PAR LIEN, NON autorisee, un sejour
//         Airbnb termine hier et un menage a elle PAS ENCORE FAIT — c'est la
//         recette qui clique « Menage fait ». Le lien de sa PWA porte un JETON :
//         il est ecrit dans ~/recette-avis-lien-pwa.txt, jamais affiche.)
//   node --env-file=.env.staging scripts/recette-avis-staging.js --role=membre
//   node --env-file=.env.staging scripts/recette-avis-staging.js --role=prestataire
//   node --env-file=.env.staging scripts/recette-avis-staging.js --nettoyer
const { createClient } = require('@supabase/supabase-js')
const crypto = require('node:crypto')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY requis.'); process.exit(1) }
const MEMBRE_EMAIL = process.env.MEMBRE_TEST_EMAIL
const PROJET_STAGING = 'ortyofzzdsthlhqmzsnq'
const MARQUE = 'RECETTE-AVIS'

const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

const args = process.argv.slice(2)
const a = (n) => args.find(x => x === `--${n}` || x.startsWith(`--${n}=`))
const val = (n) => { const x = a(n); return x && x.includes('=') ? x.split('=').slice(1).join('=') : null }

let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++; process.exitCode = 1 }

;(async () => {
  console.log(`Projet Supabase : ${projet}`)
  const { count: biens } = await sb.from('properties').select('*', { count: 'exact', head: true })
  console.log(`Empreinte : ${biens} bien(s)\n`)
  if (projet !== PROJET_STAGING) {
    console.error(`ECHEC : ce script ECRIT. Il ne tourne que sur STAGING (${PROJET_STAGING}).`)
    process.exit(1)
  }
  if (biens !== 3) {
    console.error('ECHEC : projet de staging reconnu, mais 3 biens attendus. La base a change.')
    process.exit(1)
  }

  const { data: props } = await sb.from('properties')
    .select('id, user_id, name, provider_property_id, provider').order('created_at').limit(2)
  const [bienA, bienB] = props
  const compte = bienA.user_id

  // ─── Nettoyage ──────────────────────────────────────────────────────────
  if (a('nettoyer')) {
    const { data: evals } = await sb.from('guest_evaluations')
      .select('id, ota_review_id').eq('user_id', compte).like('booking_uid', `${MARQUE}%`)
    for (const e of evals || []) {
      await sb.from('core_events').delete().eq('subject_id', e.id)
      await sb.from('guest_evaluations').delete().eq('id', e.id)
      if (e.ota_review_id) await sb.from('ota_reviews').delete().eq('id', e.ota_review_id)
    }
    // Les criteres de recette aussi.
    await sb.from('avis_criteres').delete().eq('user_id', compte).like('libelle', `${MARQUE}%`)
    // Le decor PWA (--decor-pwa) : taches, etat du fil, menage, sejour, lien,
    // personne. ⚠ Chaque suppression est LUE, et ce qui reste est COMPTE
    // (constat de revue : un reste passait sans bruit).
    // Les lignes de droits des profils de decor, AVANT les profils eux-memes.
    const { data: decor } = await sb.from('profiles').select('id')
      .eq('account_user_id', compte).like('pwa_token', `${MARQUE.toLowerCase()}%`)
    for (const p of decor || []) {
      const { error } = await sb.from('profile_permissions').delete().eq('profile_id', p.id)
      if (error) ko(`nettoyage profile_permissions : ${error.message}`)
    }
    const pwa = [
      ...['agent_tasks', 'conversation_flags'].map(t => [t, 'user_id', 'book_id', `${MARQUE}%`]),
      ...['menage_done', 'menages', 'bookings_snapshot'].map(t => [t, 'user_id', 'booking_id', `${MARQUE}%`]),
      ['public_tokens', 'user_id', 'label', `${MARQUE}%`],
      ['profiles', 'account_user_id', 'pwa_token', `${MARQUE.toLowerCase()}%`],
    ]
    for (const [t, cCompte, c, motif] of pwa) {
      const { error } = await sb.from(t).delete().eq(cCompte, compte).like(c, motif)
      if (error) ko(`nettoyage ${t} : ${error.message}`)
      const { count } = await sb.from(t).select('*', { count: 'exact', head: true }).eq(cCompte, compte).like(c, motif)
      if (count) ko(`${t} : ${count} ligne(s) de decor restante(s)`)
    }
    const { count: reste } = await sb.from('guest_evaluations')
      .select('*', { count: 'exact', head: true }).eq('user_id', compte).like('booking_uid', `${MARQUE}%`)
    console.log(`Nettoyage : ${(evals || []).length} evaluation(s) retiree(s), ${reste || 0} restante(s)`)
    if (reste) { ko('le decor de recette n a pas ete entierement retire'); process.exit(1) }
    ok('decor de recette retire')
    return
  }

  // ─── Le decor de la PWA (lots 5 a 7) ─────────────────────────────────────
  if (a('decor-pwa')) {
    const os = require('node:os')
    const fs = require('node:fs')
    const path = require('node:path')
    const suffixe = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const BK = `${MARQUE}-PWA-${suffixe}`
    const jeton = `${MARQUE.toLowerCase()}-pwa-${crypto.randomBytes(12).toString('hex')}`
    const hier = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    // Une nuit au moins : un sejour de zero nuit ne se dessine pas au calendrier.
    const avantHier = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
    const REF = String(bienA.provider_property_id)
    const { data: profil, error: eP } = await sb.from('profiles').insert({
      account_user_id: compte, first_name: 'Recette', last_name: 'PWA',
      access_mode: 'lien', active: true, accepted_at: new Date().toISOString(),
      // ⚠ NON AUTORISEE : la recette l'autorise elle-meme depuis la fiche.
      pwa_token: jeton, eval_scope: 'aucun', eval_power: 'soumettre',
    }).select().single()
    if (eP) { ko(`prestataire impossible : ${eP.message}`); process.exit(1) }
    // ⚠ SA LIGNE DE DROITS, COMME L'ECRAN LA CREE (recette du 2 octobre 2026) :
    // sans elle, « Enregistrer » sur sa fiche repondait « droits introuvables »
    // (api/membres.js refuse un profil sans ligne). Le preset `prestataire`,
    // limite au bien de recette.
    const { PRESETS } = require('../lib/permissions')
    const { error: eDroits } = await sb.from('profile_permissions').insert({
      profile_id: profil.id, account_user_id: compte, ...PRESETS.prestataire,
      property_scope: 'selected', property_ids: [bienA.id], property_refs: [REF],
    })
    if (eDroits) { ko(`droits de la prestataire : ${eDroits.message} — relance --nettoyer`); process.exit(1) }
    const etapes = [
      ['public_tokens', { user_id: compte, token: jeton, label: `${MARQUE} PWA`, property_ids: [REF] }],
      ['bookings_snapshot', { user_id: compte, booking_id: BK, property_id: REF,
        snapshot: { provider: 'channex', source: 'AirBNB', arrival: avantHier, departure: hier, firstName: 'Voyageur', lastName: 'Recette', status: 'confirmed' } }],
      ['menages', { user_id: compte, property_id: REF, booking_id: BK, departure_date: hier, provider_id: profil.id, status: 'accepted', assigned_by: 'manual' }],
    ]
    for (const [table, ligne] of etapes) {
      const { error } = await sb.from(table).insert(ligne)
      if (error) { ko(`${table} : ${error.message} — relance --nettoyer`); process.exit(1) }
    }
    // ⚠ LE LIEN PORTE UN JETON : il s'ecrit dans un fichier hors du depot, que
    // Thierry ouvre lui-meme. Le terminal ne dit que son nom et sa longueur.
    const lien = `https://hotesmart-staging.vercel.app/apps/menages/public?token=${jeton}`
    const fichier = path.join(os.homedir(), 'recette-avis-lien-pwa.txt')
    fs.writeFileSync(fichier, lien + '\n', { mode: 0o600 })
    ok(`prestataire « Recette PWA » creee, PAR LIEN, NON autorisee (a autoriser depuis sa fiche)`)
    ok(`sejour Airbnb termine hier sur « ${bienA.name} », menage a elle, PAS encore fait`)
    console.log(`        lien de sa PWA : ecrit dans ${fichier} (${lien.length} caracteres)`)
    console.log('        a la fin : --nettoyer retire tout ce decor')
    return
  }

  // ─── Le rôle du compte de test ──────────────────────────────────────────
  const role = val('role')
  if (role) {
    if (!['membre', 'prestataire'].includes(role)) {
      console.error('ECHEC : --role attend « membre » ou « prestataire ».')
      process.exit(1)
    }
    if (!MEMBRE_EMAIL) {
      console.error('ECHEC : MEMBRE_TEST_EMAIL absent. Lance d abord scripts/creer-membre-test-staging.js.')
      process.exit(1)
    }
    const { data: users } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 })
    const membre = (users?.users || []).find(u => String(u.email || '').toLowerCase() === MEMBRE_EMAIL.toLowerCase())
    if (!membre) { console.error(`ECHEC : le compte ${MEMBRE_EMAIL} n existe pas dans l auth.`); process.exit(1) }

    const { data: profil } = await sb.from('profiles')
      .select('*').eq('account_user_id', compte).eq('member_user_id', membre.id).maybeSingle()
    if (!profil) { console.error('ECHEC : ce compte n est pas membre du compte hote. Relance creer-membre-test-staging.js.'); process.exit(1) }

    // ⚠ UN PROFIL `lien` ACTIF EXIGE UN pwa_token (profiles_token_coherent).
    // On en pose un jetable, et on le retire en repassant en « compte » : la
    // contrainte interdit un jeton sur un profil de compte.
    const maj = role === 'prestataire'
      ? { access_mode: 'lien', pwa_token: profil.pwa_token || `recette-${crypto.randomBytes(9).toString('hex')}`,
          eval_scope: 'selon_grille', eval_power: 'valider' }
      : { access_mode: 'compte', pwa_token: null }
    const { error } = await sb.from('profiles').update(maj).eq('id', profil.id)
    if (error) { ko(`bascule impossible : ${error.message}`); process.exit(1) }

    // ⚠ LA RECETTE DOIT POUVOIR REMPLIR, DONC ECRIRE. Le compte de test est cree
    // avec `avis: read` — ce que la preuve de perimetre exige (elle mesure ce
    // qu'un membre LIT). Mais remplir une evaluation demande `write` : sans lui,
    // la recette s'arreterait sur un 403 qui n'apprendrait rien.
    //
    // ⚠ ET LE PERIMETRE RESTE RESTREINT AU BIEN A. C'est tout l'interet : la
    // recette doit pouvoir constater que le bien B lui echappe.
    const { error: eDroits } = await sb.from('profile_permissions')
      .update({ avis: 'write' }).eq('profile_id', profil.id)
    if (eDroits) { ko(`droits d ecriture impossibles : ${eDroits.message}`); process.exit(1) }
    const { data: droits } = await sb.from('profile_permissions')
      .select('avis, property_scope, property_ids').eq('profile_id', profil.id).maybeSingle()
    if (!droits || droits.avis !== 'write') { ko('les droits d ecriture ne sont pas poses'); process.exit(1) }
    ok(`droits : avis=${droits.avis}, perimetre ${droits.property_scope} (${(droits.property_ids || []).length} bien)`)

    const { data: relu } = await sb.from('profiles')
      .select('access_mode, eval_power, eval_scope').eq('id', profil.id).maybeSingle()
    if (!relu || relu.access_mode !== maj.access_mode) { ko('la bascule n a pas pris'); process.exit(1) }
    ok(`compte de test bascule en « ${role} » (access_mode = ${relu.access_mode}`
      + (role === 'prestataire' ? `, eval_power = ${relu.eval_power}, eval_scope = ${relu.eval_scope})` : ')'))
    console.log('\n  ⚠ Le rôle est PORTE PAR LE PROFIL, pas par la session : deconnecte-toi')
    console.log('    et reconnecte-toi avec ce compte pour que le serveur le relise.')
    if (role === 'prestataire') {
      console.log('\n  ⚠ MONTAGE DE RECETTE. Une vraie prestataire entre par un LIEN (jeton),')
      console.log('    sans session : l action `avis.questions_prestataire` arrive au lot 5.')
      console.log('    Ici, le profil porte `access_mode = lien` ET un compte, ce qui permet')
      console.log('    d eprouver le RÔLE prestataire des maintenant, par la page /avis.')
    }
    return
  }

  // ─── Le decor : une evaluation a remplir ────────────────────────────────
  if (a('decor')) {
    const suffixe = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const reference = `${MARQUE}-${suffixe}`

    const { data: review, error: eRev } = await sb.from('ota_reviews').insert({
      user_id: compte, property_id: bienA.id, provider: 'channex', ota: 'airbnb',
      // ⚠ UNE REFERENCE QUI N'EXISTE PAS CHEZ CHANNEX. Si la simulation etait
      // oubliee, le POST echouerait en 404 au lieu de publier quoi que ce soit.
      external_review_id: reference,
      property_id_ref: String(bienA.provider_property_id),
      received_at: new Date().toISOString(),
    }).select().single()
    if (eRev) { ko(`objet review impossible : ${eRev.message}`); process.exit(1) }

    const { data: ev, error: eEval } = await sb.from('guest_evaluations').insert({
      user_id: compte, property_id: bienA.id,
      property_id_ref: String(bienA.provider_property_id),
      booking_uid: reference, ota_review_id: review.id,
      provider: 'channex', ota: 'airbnb', status: 'a_remplir', language: 'fr',
      deadline_at: new Date(Date.now() + 12 * 86400000).toISOString(),
    }).select().single()
    if (eEval) { ko(`evaluation impossible : ${eEval.message}`); process.exit(1) }

    ok(`evaluation de recette creee sur « ${bienA.name} »`)
    console.log(`        sejour   : ${reference}`)
    console.log(`        statut   : a_remplir · echeance dans 12 jours`)
    console.log(`        (la reference provider n existe pas chez Channex : un envoi reel echouerait)`)
  }

  // ─── L'etat, toujours affiche ───────────────────────────────────────────
  console.log('\n─── Etat du decor de recette ───────────────────────────────')
  console.log(`Compte hote      : ${String(compte).slice(0, 8)}…`)
  console.log(`Bien A (perimetre du membre) : « ${bienA.name} »`)
  console.log(`Bien B (hors perimetre)      : « ${bienB.name} »`)

  const { data: profilTest } = MEMBRE_EMAIL
    ? await sb.from('profiles').select('id, access_mode, active, eval_power, eval_scope, first_name')
        .eq('account_user_id', compte).eq('email', MEMBRE_EMAIL).maybeSingle()
    : { data: null }
  console.log(`Compte de test   : ${MEMBRE_EMAIL || '(MEMBRE_TEST_EMAIL absent)'}`)
  console.log(`  rôle actuel    : ${profilTest ? (profilTest.access_mode === 'lien' ? 'prestataire (acces lien)' : 'membre du compte') : 'aucun profil'}`)
  if (profilTest && profilTest.access_mode === 'lien') {
    console.log(`  pouvoir        : ${profilTest.eval_power} · perimetre de questions : ${profilTest.eval_scope}`)
  }
  if (profilTest) {
    const { data: d } = await sb.from('profile_permissions')
      .select('avis, property_scope, property_ids')
      .eq('account_user_id', compte).eq('profile_id', profilTest.id).maybeSingle()
    if (d) console.log(`  droits         : avis=${d.avis} · perimetre ${d.property_scope} (${(d.property_ids || []).length} bien)`)
  }

  const { data: evals } = await sb.from('guest_evaluations')
    .select('booking_uid, status, deadline_at').eq('user_id', compte)
    .like('booking_uid', `${MARQUE}%`).order('created_at', { ascending: false })
  console.log(`\nEvaluations de recette : ${(evals || []).length}`)
  for (const e of evals || []) console.log(`  · ${e.booking_uid} — ${e.status}`)

  const { data: criteres } = await sb.from('avis_criteres')
    .select('libelle, categorie, actif, property_id').eq('user_id', compte)
  console.log(`\nGrille en base : ${(criteres || []).length} critere(s)`)
  for (const c of criteres || []) {
    console.log(`  · ${c.libelle} (${c.categorie})${c.actif ? '' : ' — INACTIF'}${c.property_id ? ' — niveau bien' : ' — niveau compte'}`)
  }
  if (!(criteres || []).length) console.log('  (aucun : la grille par defaut du code s applique)')

  if (echecs) process.exit(1)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
