#!/usr/bin/env node
// scripts/prouver-rls-avis.js — lot 2 du chantier « evaluation du voyageur ».
//
// PROUVE, SUR DONNEES REELLES, CE QU'UN MEMBRE RESTREINT VOIT.
// Question de Thierry (29 septembre 2026) : `can_read(user_id, 'avis', NULL)`
// laisse-t-il bien passer la ligne de NIVEAU COMPTE d'`avis_config` ? Et la
// surcharge uuid a-t-elle la meme semantique que la surcharge text ?
//
// Lire le SQL des fonctions ne prouve rien : c'est la base qui tranche. Ce
// script FABRIQUE le scenario, le mesure, et le defait.
//
// Usage : node --env-file=.env.staging scripts/prouver-rls-avis.js
//
// ⚠ STAGING UNIQUEMENT, ET IL LE VERIFIE. Il ECRIT (un compte membre, un
// profil, des permissions, trois lignes de config) puis NETTOIE. Sur la base
// de production, il refuse de demarrer : l'empreinte est le garde-fou.
//
// ⚠ IL NETTOIE MEME S'IL ECHOUE. Tout ce qu'il cree est enregistre au fur et
// a mesure ; le nettoyage tourne dans un `finally`. Un scenario de test qui
// reste en base est une pollution qu'on retrouve six mois plus tard.
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const ANON = process.env.SUPABASE_ANON_KEY
// ⚠ DEUX JEUX D'IDENTIFIANTS POSSIBLES, ET L'ORDRE COMPTE.
// `MEMBRE_TEST_EMAIL` d'abord : sur staging, TEST_EMAIL se trouve etre le
// TITULAIRE du compte, qui voit tout par construction — la preuve du perimetre
// exige un compte DISTINCT. Mesure du 30 septembre 2026 : l'auth de staging ne
// contient qu'un seul compte, celui du titulaire.
const TEST_EMAIL = process.env.MEMBRE_TEST_EMAIL || process.env.TEST_EMAIL
const TEST_PASSWORD = process.env.MEMBRE_TEST_PASSWORD || process.env.TEST_PASSWORD
if (!URL || !KEY || !ANON) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY requis.')
  process.exit(1)
}
// ⚠ SANS LE COMPTE TEST, LE SCRIPT NE TOURNE PAS — il ne se rabat pas sur un
// membre fabrique. Un repli silencieux ferait croire que la preuve demandee a
// eu lieu alors qu'on aurait prouve autre chose.
if (!TEST_EMAIL || !TEST_PASSWORD) {
  console.error('TEST_EMAIL / TEST_PASSWORD requis : la preuve porte sur LE COMPTE TEST,')
  console.error('passe membre restreint, pas sur un membre fabrique pour l occasion.')
  process.exit(1)
}
const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

// ⚠ UN ECHEC SORT EN ECHEC, TOUJOURS. Constat de review : chaque controle de
// decor faisait `ko(...); return` — or un `return` dans le `try` passe par le
// `finally` puis QUITTE la fonction, en sautant le bilan final. Le script
// affichait « ECHEC » sur la sortie d'erreur et rendait 0. Enchaine derriere un
// `&&`, il laissait passer la suite apres n'avoir rien prouve. C'est le faux
// vert exact que son voisin verifier-avis-evaluation.js existe pour empecher.
//
// Deux verrous desormais : `ko()` pose le code de sortie des le premier defaut,
// et un abandon de decor leve `Abandon`, rattrape par le .catch final.
let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++; process.exitCode = 1 }
class Abandon extends Error {}
const abandon = (m) => { ko(m); throw new Abandon(m) }

// ⚠ PLUS DE MEMBRE FABRIQUE. La preuve porte sur LE COMPTE TEST (TEST_EMAIL),
// passe membre restreint le temps du controle puis remis dans son etat. Les deux
// constantes d'avant creaient un compte jetable : elles ont disparu, et avec
// elles le filtre `rls-preuve-` du controle de nettoyage, qui ne cherchait plus
// rien.

;(async () => {
  // ─── Garde d'environnement ───────────────────────────────────────────────
  const { count: biens } = await sb.from('properties').select('*', { count: 'exact', head: true })
  console.log(`Projet Supabase : ${projet}`)
  console.log(`Empreinte : ${biens} bien(s)\n`)
  if (biens !== 3) {
    console.error('ECHEC : ce script ECRIT en base. Il ne tourne que sur STAGING (3 biens).')
    process.exit(1)
  }

  const aNettoyer = { userId: null, profileId: null, configs: [], restaurer: null, permissionsCreees: null }
  try {
    // ─── Le decor : deux biens du compte ──────────────────────────────────
    const { data: props } = await sb.from('properties')
      .select('id, user_id, name, provider_property_id').order('created_at').limit(2)
    if (!props || props.length < 2) abandon('il faut deux biens sur staging pour distinguer « le sien » de « l autre »')
    const [bienA, bienB] = props
    const compte = bienA.user_id
    console.log(`Compte : ${String(compte).slice(0, 8)} · bien A « ${bienA.name} » · bien B « ${bienB.name} »\n`)

    // ─── LE COMPTE TEST, passe membre restreint au bien A ─────────────────
    // ⚠ LE COMPTE TEST, PAS UN MEMBRE JETABLE. Decision de Thierry du
    // 30 septembre 2026 pour le lot 4 : « preuve reelle du perimetre
    // avis_config avec le compte test en membre restreint ». Un membre fabrique
    // de toutes pieces a, par construction, un profil parfait — celui que le
    // script vient d'ecrire. Le compte test, lui, est celui qui existe
    // vraiment, avec l'etat que les autres essais lui ont laisse.
    //
    // ⚠ ET ON LE REMET EXACTEMENT COMME ON L'A TROUVE. Son profil et ses
    // permissions sont sauvegardes ligne par ligne avant d'etre remplaces, et
    // restaures dans le `finally`. Un compte de test abime est un compte de test
    // qu'on ne croit plus.
    const identifiant = createClient(URL, ANON, { auth: { persistSession: false } })
    const { data: session, error: eSession } = await identifiant.auth
      .signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD })
    if (eSession) abandon(`le compte test ne se connecte pas : ${eSession.message}`)
    const membreUserId = session.user.id
    await identifiant.auth.signOut()

    // ⚠ S'IL EST LE TITULAIRE, LA PREUVE EST IMPOSSIBLE, ET ON LE DIT.
    // Le titulaire voit tout par construction (`can_read` rend true des que
    // userId === accountUserId) : lui faire passer ce test rendrait trois « ok »
    // qui ne prouveraient rien du perimetre.
    if (membreUserId === compte) {
      abandon([
        'le compte test EST le titulaire du compte staging.',
        '',
        '        Le titulaire voit tout par construction : `can_read` rend true des que',
        '        userId === accountUserId. Faire passer ce controle a ce compte rendrait',
        '        trois « ok » qui ne prouveraient rien du perimetre — le faux vert que ce',
        '        script existe pour empecher.',
        '',
        '        REMEDE : un SECOND compte dans l auth de staging, distinct du titulaire,',
        '        et ses identifiants dans MEMBRE_TEST_EMAIL / MEMBRE_TEST_PASSWORD.',
        '        Ce script ne le cree pas de lui-meme : creer un compte dans une base',
        '        reelle est une decision de Thierry, pas la mienne.',
      ].join('\n'))
    }

    const { data: profilExistant, error: eLectureProfil } = await sb.from('profiles')
      .select('*').eq('account_user_id', compte).eq('member_user_id', membreUserId).maybeSingle()
    if (eLectureProfil) abandon(`lecture du profil du compte test : ${eLectureProfil.message}`)

    let profil
    if (profilExistant) {
      const { data: permsAvant, error: ePA } = await sb.from('profile_permissions')
        .select('*').eq('profile_id', profilExistant.id).maybeSingle()
      if (ePA) abandon(`lecture des droits du compte test : ${ePA.message}`)
      aNettoyer.restaurer = { profil: profilExistant, permissions: permsAvant || null }
      profil = profilExistant

      const { error: eMaj } = await sb.from('profiles')
        .update({ access_mode: 'compte', active: true, accepted_at: profilExistant.accepted_at || new Date().toISOString() })
        .eq('id', profil.id)
      if (eMaj) abandon(`mise a jour du profil du compte test : ${eMaj.message}`)
      ok(`compte test deja membre de ce compte : etat sauvegarde pour restauration`)
    } else {
      const { data: cree, error: eProfil } = await sb.from('profiles').insert({
        account_user_id: compte, member_user_id: membreUserId,
        first_name: 'Compte', last_name: 'Test', email: TEST_EMAIL,
        access_mode: 'compte', active: true, accepted_at: new Date().toISOString(),
      }).select().single()
      if (eProfil) abandon(`creation du profil du compte test impossible : ${eProfil.message}`)
      profil = cree
      aNettoyer.profileId = cree.id
      ok('compte test rattache au compte staging comme membre (profil temporaire)')
    }

    const droits = {
      profile_id: profil.id, account_user_id: compte,
      property_scope: 'selected', property_ids: [bienA.id],
      property_refs: [String(bienA.provider_property_id)],
      avis: 'read',
    }
    const { error: ePerm } = await sb.from('profile_permissions')
      .upsert(droits, { onConflict: 'profile_id' })
    if (ePerm) abandon(`permissions impossibles : ${ePerm.message}`)
    if (!aNettoyer.restaurer) aNettoyer.permissionsCreees = profil.id
    ok('compte test : droit avis=read, perimetre = le seul bien A')

    // ─── Trois configurations : compte, bien A, bien B ────────────────────
    // ⚠ LA LIGNE DE NIVEAU COMPTE EXISTE PEUT-ETRE DEJA : `avis_config_compte_uniq`
    // est unique (user_id) where property_id is null. Un hote qui a regle ses
    // avis sur staging en a une. On la REUTILISE alors, sans la creer ni la
    // supprimer — sinon l'insertion tombe en 23505 et le script n'a rien prouve.
    for (const [libelle, property_id] of [['niveau compte', null], ['bien A', bienA.id], ['bien B', bienB.id]]) {
      const req = sb.from('avis_config').select('id').eq('user_id', compte)
      const { data: deja } = property_id === null
        ? await req.is('property_id', null).maybeSingle()
        : await req.eq('property_id', property_id).maybeSingle()
      if (deja) { console.log(`  (config « ${libelle} » deja presente : reutilisee, ni creee ni supprimee)`); continue }
      const { data, error } = await sb.from('avis_config')
        .insert({ user_id: compte, property_id, keywords: [`preuve-${libelle.replace(/\s/g, '-')}`] })
        .select().single()
      if (error) abandon(`insertion config « ${libelle} » : ${error.message}`)
      aNettoyer.configs.push(data.id)
    }
    ok('trois configurations en place : niveau compte, bien A, bien B')

    // ─── Ce que le membre VOIT, sous sa propre session ────────────────────
    const client = createClient(URL, ANON, { auth: { persistSession: false } })
    const { error: eAuth } = await client.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD })
    if (eAuth) abandon(`session du membre impossible : ${eAuth.message}`)

    const { data: vues, error: eLect } = await client.from('avis_config').select('id, property_id, keywords')
    if (eLect) abandon(`lecture par le membre impossible : ${eLect.message}`)
    const lues = new Set((vues || []).map(v => v.property_id))
    console.log(`\n  Le membre lit ${(vues || []).length} configuration(s).`)

    lues.has(null)
      ? ok('il voit la configuration de NIVEAU COMPTE — can_read(..., NULL) laisse passer')
      : ko('la configuration de NIVEAU COMPTE lui echappe — can_read(..., NULL) bloque a tort')
    lues.has(bienA.id)
      ? ok('il voit la configuration de SON bien — la surcharge uuid applique bien le perimetre')
      : ko('la configuration de son propre bien lui echappe')
    lues.has(bienB.id)
      ? ko('IL VOIT LA CONFIGURATION D UN AUTRE BIEN — le perimetre ne tient pas')
      : ok('il ne voit PAS la configuration de l autre bien')

    // ─── Et le journal : plus aucune lecture cliente ──────────────────────
    const { data: ev, error: eEv } = await client.from('core_events').select('id').limit(1)
    // ⚠ UNE ERREUR INCONNUE N'EST PAS UNE LECTURE ACCEPTEE. Le `else` attrapait
    // tout : un jeton expire (PGRST301) ou une coupure reseau se lisait
    // « la policy n a pas ete retiree », et envoyait rejouer une migration deja
    // appliquee. On nomme ce qu'on ne sait pas.
    const codeEv = eEv ? String(eEv.code || '') : ''
    if (codeEv === '42501') ok('core_events : lecture refusee au membre (42501)')
    else if (codeEv === 'PGRST205') ko('core_events : table absente')
    else if (eEv) ko(`core_events : erreur INCONNUE (${codeEv || 'sans code'}) — ni refus ni acceptation : ${eEv.message.slice(0, 60)}`)
    else if ((ev || []).length === 0) ko('core_events : lecture ACCEPTEE (liste vide) — le REVOKE SELECT manque')
    else ko(`core_events : lecture ACCEPTEE — la policy n a pas ete retiree (${(ev || []).length} ligne(s))`)

    await client.auth.signOut()
  } finally {
    // ─── Nettoyage, quoi qu'il arrive ────────────────────────────────────
    let reste = 0
    for (const id of aNettoyer.configs) {
      const { error } = await sb.from('avis_config').delete().eq('id', id)
      if (error) reste++
    }
    // ⚠ RESTAURER, PAS SUPPRIMER, quand le profil du compte test PREEXISTAIT.
    // Le supprimer retirerait au compte test un rattachement qu'on n'a pas cree
    // — et les autres essais qui s'en servent tomberaient sans qu'on comprenne
    // pourquoi.
    if (aNettoyer.restaurer) {
      const { profil: avant, permissions: permsAvant } = aNettoyer.restaurer
      const { error: eR } = await sb.from('profiles')
        .update({ access_mode: avant.access_mode, active: avant.active, accepted_at: avant.accepted_at })
        .eq('id', avant.id)
      if (eR) { console.error('  restauration du profil impossible :', eR.message); reste++ }
      if (permsAvant) {
        const { error: eRP } = await sb.from('profile_permissions')
          .upsert(permsAvant, { onConflict: 'profile_id' })
        if (eRP) { console.error('  restauration des droits impossible :', eRP.message); reste++ }
      } else {
        const { error: eDP } = await sb.from('profile_permissions').delete().eq('profile_id', avant.id)
        if (eDP) { console.error('  retrait des droits temporaires impossible :', eDP.message); reste++ }
      }
      // ⚠ CONTRE-PREUVE DE LA RESTAURATION : on RELIT, on ne suppose pas.
      const { data: apres } = await sb.from('profiles').select('access_mode, active').eq('id', avant.id).maybeSingle()
      if (!apres || apres.access_mode !== avant.access_mode || apres.active !== avant.active) {
        console.error('  le profil du compte test N EST PAS revenu a son etat d origine')
        reste++
      }
      if (permsAvant) {
        const { data: permsApres } = await sb.from('profile_permissions')
          .select('avis, property_scope').eq('profile_id', avant.id).maybeSingle()
        if (!permsApres || permsApres.avis !== permsAvant.avis || permsApres.property_scope !== permsAvant.property_scope) {
          console.error('  les droits du compte test NE SONT PAS revenus a leur etat d origine')
          reste++
        }
      }
    } else if (aNettoyer.profileId) {
      await sb.from('profile_permissions').delete().eq('profile_id', aNettoyer.profileId)
      const { error } = await sb.from('profiles').delete().eq('id', aNettoyer.profileId)
      if (error) reste++
    }
    // ⚠ LE COMPTE TEST N'EST JAMAIS SUPPRIME. Il ne nous appartient pas.
    if (aNettoyer.userId) {
      const { error } = await sb.auth.admin.deleteUser(aNettoyer.userId)
      if (error) reste++
    }
    // ⚠ CONTRE-PREUVE DU NETTOYAGE : ON RELIT LES LIGNES, PAR LEUR ID.
    // La premiere version filtrait `.like('keywords', '%preuve%')` sur une
    // colonne `text[]` : Postgres n'a pas d'operateur `text[] ~~ text`, la
    // requete tombait en 42883, l'erreur etait jetee par la destructuration, et
    // le compte valait toujours `null` — donc « 0 config restante », toujours.
    // Une contre-preuve qui ne peut rien trouver ne prouve rien.
    let configsRestantes = 0
    if (aNettoyer.configs.length) {
      const { count, error } = await sb.from('avis_config')
        .select('*', { count: 'exact', head: true }).in('id', aNettoyer.configs)
      if (error) { console.error('  relecture du nettoyage impossible :', error.message); configsRestantes = aNettoyer.configs.length }
      else configsRestantes = count || 0
    }
    // ⚠ ON VERIFIE QU'AUCUN COMPTE JETABLE N'EST RESTE d'une version
    // precedente de ce script, qui en creait un par execution.
    const { data: users, error: eUsers } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 })
    let membresRestants = 0
    if (eUsers) { console.error('  relecture des comptes impossible :', eUsers.message); membresRestants = -1 }
    else membresRestants = (users?.users || []).filter(u => /rls-preuve-/.test(u.email || '')).length
    console.log(`\nNettoyage : ${reste} erreur(s) · ${configsRestantes} config(s) de preuve restante(s) · ${membresRestants} compte(s) jetable(s) d une ancienne version`)
    if (reste || membresRestants !== 0 || configsRestantes) {
      console.error('ECHEC : le decor de test n a pas ete entierement retire.')
      process.exitCode = 1
    }
  }

  if (echecs) { console.error(`\nECHEC : ${echecs} controle(s) en defaut.`); process.exit(1) }
  console.log('\nOK : le perimetre par bien tient sur avis_config, et le journal n est plus lisible du navigateur.')
})().catch(e => {
  if (!(e instanceof Abandon)) console.error('ECHEC :', e.message)
  process.exit(1)
})
