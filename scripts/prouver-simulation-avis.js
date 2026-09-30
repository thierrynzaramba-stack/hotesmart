#!/usr/bin/env node
// scripts/prouver-simulation-avis.js
//
// LA PUBLICATION EST-ELLE VRAIMENT SIMULEE SUR LE DEPLOIEMENT ?
//
// La variable `AVIS_PUBLICATION_SIMULEE=1` est posee a la main sur le projet
// Vercel. Croire qu'elle est active parce qu'on l'a posee n'est pas la meme chose
// que le VERIFIER : une variable non lue faute de redeploiement, une faute de
// frappe dans son nom, un projet different — chacun de ces cas se voit
// exactement comme un succes, jusqu'au jour ou un avis reel part chez Airbnb.
//
// Ce script publie une evaluation JETABLE de bout en bout, par HTTP, avec une
// vraie session, et exige que la reponse porte `simulation: true`.
//
// ⚠ STAGING UNIQUEMENT, sur les deux bouts : la base (empreinte) ET l'URL
// appelee (motif ancre, le meme que shared/config.js). Il ECRIT et il NETTOIE.
//
// ⚠ LA REFERENCE PROVIDER N'EXISTE PAS CHEZ CHANNEX. Si la simulation etait
// inactive, le POST echouerait en 404 au lieu de publier quoi que ce soit : ce
// script ne peut pas envoyer un avis reel, meme en cas de mauvaise surprise.
//
// Usage : node --env-file=.env.staging scripts/prouver-simulation-avis.js
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const ANON = process.env.SUPABASE_ANON_KEY
const EMAIL = process.env.MEMBRE_TEST_EMAIL
const MDP = process.env.MEMBRE_TEST_PASSWORD
const SITE = process.env.SITE_URL || 'https://hotesmart-staging.vercel.app'
const PROJET_STAGING = 'ortyofzzdsthlhqmzsnq'

for (const [nom, v] of [['SUPABASE_URL', URL], ['SUPABASE_SERVICE_KEY', KEY],
  ['SUPABASE_ANON_KEY', ANON], ['MEMBRE_TEST_EMAIL', EMAIL], ['MEMBRE_TEST_PASSWORD', MDP]]) {
  if (!v) { console.error(`${nom} requis.`); process.exit(1) }
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++; process.exitCode = 1 }

;(async () => {
  console.log(`Base    : ${projet}`)
  console.log(`Site    : ${SITE}\n`)
  const { count: biens } = await sb.from('properties').select('*', { count: 'exact', head: true })
  if (projet !== PROJET_STAGING || biens !== 3) {
    console.error(`ECHEC : ce script ECRIT. Base STAGING attendue (${PROJET_STAGING}, 3 biens).`)
    process.exit(1)
  }
  // ⚠ LE MEME MOTIF ANCRE QUE shared/config.js. « contient staging » laisserait
  // passer une preview du projet de PRODUCTION nommee staging-xxx, dont les
  // fonctions /api tournent sur la prod.
  const hote = new global.URL(SITE).hostname
  if (!/^hotesmart-staging[-.]/.test(hote) && !/^staging\./.test(hote)) {
    console.error(`ECHEC : « ${hote} » n est pas un hote du projet STAGING. Ce script publie.`)
    process.exit(1)
  }

  const aNettoyer = { evaluation: null, review: null, evenements: [] }
  try {
    // Le bien A : celui du perimetre du compte de test.
    const { data: bien } = await sb.from('properties')
      .select('id, user_id, name, provider_property_id').order('created_at').limit(1).single()
    const compte = bien.user_id

    const reference = `SIMULATION-${Date.now()}`
    const { data: review, error: eRev } = await sb.from('ota_reviews').insert({
      user_id: compte, property_id: bien.id, provider: 'channex', ota: 'airbnb',
      external_review_id: reference, property_id_ref: String(bien.provider_property_id),
      received_at: new Date().toISOString(),
    }).select().single()
    if (eRev) { ko(`objet review impossible : ${eRev.message}`); return }
    aNettoyer.review = review.id

    // ⚠ UNE EVALUATION COMPLETE, sur la grille qui s'applique vraiment. On la
    // charge depuis la base plutot que de la deviner : si l'hote a configure la
    // sienne pendant la recette, c'est elle qui compte.
    const { chargerGrille } = require('../lib/avis/evaluations')
    const grille = await chargerGrille(sb, { userId: compte, propertyId: bien.id })
    const meilleur = (c) => c.categorie === 'recommandation'
      ? (c.niveaux.find(n => n.recommande === true) || c.niveaux[0]).cle
      : [...c.niveaux].sort((a, b) => (b.note || 0) - (a.note || 0))[0].cle
    const reponses = Object.fromEntries(grille.criteres.map(c => [c.cle, meilleur(c)]))

    const { data: ev, error: eEval } = await sb.from('guest_evaluations').insert({
      user_id: compte, property_id: bien.id,
      property_id_ref: String(bien.provider_property_id),
      booking_uid: reference, ota_review_id: review.id,
      provider: 'channex', ota: 'airbnb', status: 'a_valider', language: 'fr',
      deadline_at: new Date(Date.now() + 5 * 86400000).toISOString(),
      answers_host: reponses, grille_figee: grille,
      public_text: 'Verification technique du mode simulation. Ce texte ne doit atteindre aucune plateforme.',
    }).select().single()
    if (eEval) { ko(`evaluation impossible : ${eEval.message}`); return }
    aNettoyer.evaluation = ev.id
    ok(`evaluation jetable prete (${grille.criteres.length} critere(s), statut a_valider)`)

    // La session du compte de test.
    const client = createClient(URL, ANON, { auth: { persistSession: false } })
    const { data: session, error: eAuth } = await client.auth.signInWithPassword({ email: EMAIL, password: MDP })
    if (eAuth) { ko(`session impossible : ${eAuth.message}`); return }
    ok('session du compte de test ouverte')

    // ⚠ L'APPEL PASSE PAR HTTP, comme le navigateur. Tester le module en local ne
    // dirait rien de la variable posee sur le deploiement.
    const reponse = await fetch(`${SITE}/api/avis?action=eval-publier`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.session.access_token}`,
        'X-Compte': compte,
      },
      body: JSON.stringify({ action: 'eval-publier', booking_uid: reference }),
    })
    const corps = await reponse.json().catch(() => ({}))
    await client.auth.signOut()

    console.log(`\n  Reponse HTTP ${reponse.status} : ${JSON.stringify(corps).slice(0, 220)}\n`)

    if (reponse.status !== 200) {
      // ⚠ TOUT REFUS VENU DU PROVIDER PROUVE QUE LA SIMULATION EST INACTIVE, pas
      // seulement un 404. Mesure du 30 septembre 2026 : Channex a rendu 422
      // « id is invalid » sur notre reference jetable, et la premiere version de
      // ce script ne nommait que le 404 — elle disait donc « echec » sans dire
      // POURQUOI, alors que la cause etait la seule qui compte.
      const vientDuProvider = /^provider \d/.test(String(corps.motif || ''))
      if (vientDuProvider) {
        ko('LA SIMULATION EST INACTIVE : l appel est PARTI chez le provider, qui l a refuse.')
        console.error(`        Sa reponse : ${corps.motif}`)
        console.error('')
        console.error('        Ce qu il faut verifier, dans cet ordre :')
        console.error('        1. la variable s appelle exactement AVIS_PUBLICATION_SIMULEE et vaut 1 ;')
        console.error('        2. elle est posee sur l environnement qui SERT la branche `staging` —')
        console.error('           pour le projet Vercel staging, c est « Production », pas « Preview » ;')
        console.error('        3. un REDEPLOIEMENT a eu lieu APRES : une variable ajoutee n est pas')
        console.error('           relue par un deploiement deja construit.')
        console.error('')
        console.error('        Rien n a ete publie : la reference de ce decor n existe pas chez le')
        console.error('        provider, et c est la ceinture qui a tenu. Ne compte pas sur elle.')
      } else {
        ko(`la publication a echoue (HTTP ${reponse.status}) — ${corps.error || 'sans message'}`)
        if (corps.motif) console.error(`        motif : ${corps.motif}`)
      }
      return
    }

    corps.simulation === true
      ? ok('LA SIMULATION EST ACTIVE : la reponse le dit, rien n est parti chez l OTA')
      : ko('LA SIMULATION EST INACTIVE : la publication a abouti SANS le drapeau — '
          + 'l appel est donc parti pour de vrai. Retire ce decor et corrige la variable.')

    const { data: relu } = await sb.from('guest_evaluations')
      .select('status, published_at, provider_response').eq('id', ev.id).single()
    relu.status === 'publiee' && relu.published_at
      ? ok('la ligne porte « publiee » et sa date')
      : ko(`la ligne n a pas ete mise a jour : ${relu.status}`)
    // La trace du double : elle dit, en base, que l'envoi etait simule.
    JSON.stringify(relu.provider_response || {}).includes('simulation')
      ? ok('la reponse provider enregistree porte la marque de la simulation')
      : ko('la reponse provider enregistree ne porte PAS la marque de la simulation')
  } finally {
    let reste = 0
    const { data: evs } = await sb.from('core_events').select('id').eq('subject_id', aNettoyer.evaluation || '00000000-0000-0000-0000-000000000000')
    for (const e of evs || []) { const { error } = await sb.from('core_events').delete().eq('id', e.id); if (error) reste++ }
    if (aNettoyer.evaluation) {
      const { error } = await sb.from('guest_evaluations').delete().eq('id', aNettoyer.evaluation)
      if (error) reste++
    }
    if (aNettoyer.review) {
      const { error } = await sb.from('ota_reviews').delete().eq('id', aNettoyer.review)
      if (error) reste++
    }
    // Le verrou de publication ne s'auto-nettoie pas : il expire. On le retire.
    if (aNettoyer.evaluation) await sb.from('write_locks').delete().eq('key', `avis-publier:${aNettoyer.evaluation}`)
    let restants = 0
    if (aNettoyer.evaluation) {
      const { count, error } = await sb.from('guest_evaluations')
        .select('*', { count: 'exact', head: true }).eq('id', aNettoyer.evaluation)
      if (error) restants++; else restants += count || 0
    }
    console.log(`\nNettoyage : ${reste} erreur(s) · ${restants} ligne(s) restante(s)`)
    if (reste || restants) { console.error('ECHEC : le decor jetable n a pas ete retire.'); process.exitCode = 1 }
  }

  if (echecs) { console.error(`\nECHEC : ${echecs} controle(s) en defaut.`); process.exit(1) }
  console.log('\nOK : sur ce deploiement, publier n envoie RIEN a l OTA.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
