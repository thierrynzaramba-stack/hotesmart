#!/usr/bin/env node
// scripts/creer-membre-test-staging.js
//
// CREE LE SECOND COMPTE DE TEST, ET LE RATTACHE COMME MEMBRE RESTREINT.
//
// Demande de Thierry du 30 septembre 2026. La preuve du perimetre `avis_config`
// (scripts/prouver-rls-avis.js) exige un compte DISTINCT du titulaire : le
// titulaire voit tout par construction, et lui faire passer ce controle rendrait
// des « ok » qui ne prouvent rien.
//
// ⚠ STAGING UNIQUEMENT, ET DEUX EMPREINTES LE VERIFIENT : la reference du projet
// et le nombre de biens. Ce script CREE UN COMPTE dans l'authentification d'une
// base reelle — en production, ce serait un compte de plus dans la vraie liste
// des utilisateurs. Il refuse de demarrer ailleurs.
//
// ⚠ IL EST IDEMPOTENT. Relance : si le compte existe, il ne le recree pas et ne
// touche pas a son mot de passe ; si le profil existe, il ajuste seulement ce
// qui doit l'etre. Un script de provisionnement qui casse a la seconde execution
// ne sert qu'une fois.
//
// ⚠ LE MOT DE PASSE N'EST JAMAIS AFFICHE. Il est genere, ecrit dans le fichier
// d'environnement vise, et le terminal n'en voit que la longueur.
//
// Usage : node --env-file=.env.staging scripts/creer-membre-test-staging.js
const { createClient } = require('@supabase/supabase-js')
const crypto = require('node:crypto')
const fs = require('node:fs')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY requis.'); process.exit(1) }

const EMAIL = 'thierrylapoule31+membre@gmail.com'
const FICHIER_ENV = process.env.FICHIER_ENV || '/home/thierry/hotesmart/.env.staging'
const PROJET_STAGING = 'ortyofzzdsthlhqmzsnq'

const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++; process.exitCode = 1 }

// Un mot de passe qui satisfait les regles usuelles sans etre devinable.
function motDePasse () {
  const base = crypto.randomBytes(24).toString('base64url')
  return `Hs${base}9!`
}

// ⚠ ON N'ECRASE PAS UNE LIGNE EXISTANTE SANS LE DIRE, et on ne reecrit pas le
// fichier entier : on remplace la ligne visee, ou on l'ajoute a la fin.
function poserDansEnv (fichier, cles) {
  let contenu = ''
  try { contenu = fs.readFileSync(fichier, 'utf8') } catch (e) {
    ko(`fichier d environnement illisible (${fichier}) : ${e.message}`)
    return false
  }
  let lignes = contenu.split('\n')
  for (const [nom, valeur] of Object.entries(cles)) {
    const i = lignes.findIndex(l => l.startsWith(`${nom}=`))
    if (i >= 0) lignes[i] = `${nom}=${valeur}`
    else {
      if (lignes.length && lignes[lignes.length - 1] === '') lignes.splice(lignes.length - 1, 0, `${nom}=${valeur}`)
      else lignes.push(`${nom}=${valeur}`)
    }
  }
  try { fs.writeFileSync(fichier, lignes.join('\n')) } catch (e) {
    ko(`ecriture du fichier d environnement impossible : ${e.message}`)
    return false
  }
  return true
}

;(async () => {
  console.log(`Projet Supabase : ${projet}`)
  const { count: biens } = await sb.from('properties').select('*', { count: 'exact', head: true })
  console.log(`Empreinte : ${biens} bien(s)\n`)
  if (projet !== PROJET_STAGING) {
    console.error(`ECHEC : ce script CREE UN COMPTE. Il ne tourne que sur STAGING (${PROJET_STAGING}),`)
    console.error(`        et SUPABASE_URL pointe sur « ${projet} ».`)
    process.exit(1)
  }
  if (biens !== 3) {
    console.error('ECHEC : projet de staging reconnu, mais 3 biens attendus. La base a change :')
    console.error('        relis la garde avant de forcer.')
    process.exit(1)
  }

  // ─── Le compte ──────────────────────────────────────────────────────────
  const { data: liste, error: eListe } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (eListe) { console.error('ECHEC : liste des comptes illisible :', eListe.message); process.exit(1) }
  const deja = (liste?.users || []).find(u => String(u.email || '').toLowerCase() === EMAIL.toLowerCase())

  let userId
  let mdp = null
  if (deja) {
    userId = deja.id
    ok(`le compte ${EMAIL} existe deja : ni recree, ni son mot de passe touche`)
    console.log('        (si son mot de passe est inconnu, supprime la ligne MEMBRE_TEST_PASSWORD')
    console.log('         et relance apres avoir supprime le compte — decision de Thierry)')
  } else {
    mdp = motDePasse()
    const { data: cree, error: eUser } = await sb.auth.admin.createUser({
      email: EMAIL, password: mdp, email_confirm: true,
    })
    if (eUser) { console.error('ECHEC : creation du compte impossible :', eUser.message); process.exit(1) }
    userId = cree.user.id
    ok(`compte cree : ${EMAIL} (mot de passe genere, ${mdp.length} caracteres)`)
  }

  // ─── Le compte hote et son premier bien ─────────────────────────────────
  const { data: props, error: eProps } = await sb.from('properties')
    .select('id, user_id, name, provider_property_id').order('created_at').limit(2)
  if (eProps) { console.error('ECHEC : lecture des biens impossible :', eProps.message); process.exit(1) }
  if (!props || props.length < 2) {
    console.error('ECHEC : il faut deux biens sur staging pour que « un seul bien » veuille dire quelque chose.')
    process.exit(1)
  }
  const [bienA, bienB] = props
  const compte = bienA.user_id
  if (userId === compte) {
    console.error('ECHEC : ce compte EST le titulaire. La preuve du perimetre serait vide de sens.')
    process.exit(1)
  }
  console.log(`\nCompte hote ${String(compte).slice(0, 8)} · bien A « ${bienA.name} » · bien B « ${bienB.name} »`)

  // ─── Le profil membre, avec acces par COMPTE (pas par lien) ─────────────
  // ⚠ `access_mode = 'compte'` : c'est un MEMBRE, pas une prestataire. La
  // decision de Thierry du 30 septembre 2026 fait de cette colonne la frontiere
  // entre les deux, et la preuve du perimetre porte sur un membre.
  const { data: profilDeja, error: eLect } = await sb.from('profiles')
    .select('*').eq('account_user_id', compte).eq('member_user_id', userId).maybeSingle()
  if (eLect) { console.error('ECHEC : lecture du profil impossible :', eLect.message); process.exit(1) }

  let profil = profilDeja
  if (profil) {
    const { error: eMaj } = await sb.from('profiles').update({
      access_mode: 'compte', active: true,
      accepted_at: profil.accepted_at || new Date().toISOString(),
    }).eq('id', profil.id)
    if (eMaj) ko(`mise a jour du profil : ${eMaj.message}`)
    else ok('profil membre deja present : remis actif, acces par compte')
  } else {
    const { data: cree, error: eProfil } = await sb.from('profiles').insert({
      account_user_id: compte, member_user_id: userId,
      first_name: 'Membre', last_name: 'Test', email: EMAIL,
      access_mode: 'compte', active: true, accepted_at: new Date().toISOString(),
    }).select().single()
    if (eProfil) { console.error('ECHEC : creation du profil impossible :', eProfil.message); process.exit(1) }
    profil = cree
    ok('profil membre cree, accepte, actif')
  }

  // ─── Les droits : un seul bien, avis en LECTURE ──────────────────────────
  const droits = {
    profile_id: profil.id, account_user_id: compte,
    property_scope: 'selected',
    property_ids: [bienA.id],
    property_refs: [String(bienA.provider_property_id)],
    avis: 'read',
  }
  const { error: ePerm } = await sb.from('profile_permissions').upsert(droits, { onConflict: 'profile_id' })
  if (ePerm) { console.error('ECHEC : droits impossibles :', ePerm.message); process.exit(1) }
  ok(`droits poses : avis=read, perimetre = le seul bien A (« ${bienA.name} »)`)

  // ⚠ ON RELIT CE QU'ON A ECRIT. Une ecriture annoncee n'est pas une ecriture
  // faite : c'est la regle de tous les scripts de ce dossier.
  const { data: relu, error: eRelu } = await sb.from('profile_permissions')
    .select('avis, property_scope, property_ids').eq('profile_id', profil.id).maybeSingle()
  if (eRelu) ko(`relecture des droits impossible : ${eRelu.message}`)
  else if (!relu || relu.avis !== 'read' || relu.property_scope !== 'selected'
           || !(relu.property_ids || []).includes(bienA.id)) {
    ko('les droits relus ne sont pas ceux qu on a ecrits')
  } else ok('droits relus depuis la base : conformes')

  // ─── Les identifiants dans le fichier d'environnement ───────────────────
  if (mdp) {
    if (poserDansEnv(FICHIER_ENV, { MEMBRE_TEST_EMAIL: EMAIL, MEMBRE_TEST_PASSWORD: mdp })) {
      ok(`identifiants ecrits dans ${FICHIER_ENV} (MEMBRE_TEST_EMAIL, MEMBRE_TEST_PASSWORD)`)
    }
  } else if (!process.env.MEMBRE_TEST_PASSWORD) {
    ko(`le compte existait deja et MEMBRE_TEST_PASSWORD est absent de ${FICHIER_ENV} :`)
    console.error('        son mot de passe est inconnu, la preuve ne pourra pas se connecter.')
  } else {
    if (poserDansEnv(FICHIER_ENV, { MEMBRE_TEST_EMAIL: EMAIL })) ok('MEMBRE_TEST_EMAIL confirme dans le fichier d environnement')
  }

  // ⚠ CONTRE-PREUVE : LE COMPTE SE CONNECTE-T-IL VRAIMENT ? Un compte cree et
  // un compte utilisable ne sont pas la meme chose — un email non confirme, par
  // exemple, se cree sans probleme et ne se connecte pas.
  const ANON = process.env.SUPABASE_ANON_KEY
  const mdpPourEssai = mdp || process.env.MEMBRE_TEST_PASSWORD
  if (!ANON) ko('SUPABASE_ANON_KEY absente : la connexion du membre n a PAS ete eprouvee')
  else if (!mdpPourEssai) ko('mot de passe indisponible : la connexion du membre n a PAS ete eprouvee')
  else {
    const client = createClient(URL, ANON, { auth: { persistSession: false } })
    const { data: s, error: eS } = await client.auth.signInWithPassword({ email: EMAIL, password: mdpPourEssai })
    if (eS) ko(`le membre NE SE CONNECTE PAS : ${eS.message}`)
    else if (s.user.id !== userId) ko('la connexion rend un autre identifiant que celui cree')
    else { ok('le membre se connecte, et c est bien lui'); await client.auth.signOut() }
  }

  if (echecs) { console.error(`\nECHEC : ${echecs} controle(s) en defaut.`); process.exit(1) }
  console.log('\nOK : le membre de test existe sur STAGING, restreint au seul bien A, avis en lecture.')
  console.log('     Etape suivante : node --env-file=.env.staging scripts/prouver-rls-avis.js')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
