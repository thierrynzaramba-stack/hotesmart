#!/usr/bin/env node
// scripts/recette-auto-sans-prestataire.js — jouer, SUR STAGING, l'echeance de
// la publication automatique « sans prestataire » (decision de Thierry du
// 9 novembre 2026).
//
// Usage :
//   node --env-file=.env.staging scripts/recette-auto-sans-prestataire.js             (etat)
//   node --env-file=.env.staging scripts/recette-auto-sans-prestataire.js --echeance  (le delai est ecoule)
//   ... --compte <user_id>   pour les seules evaluations de ce compte
//
// Pourquoi ce script. Staging n'a AUCUN cron (docs/STAGING.md §1) : rien n'y
// fait passer l'heure de publication. Celui-ci appelle le MEME moteur que le
// cron (`executerAutoValidations`, lib/avis/auto-validation.js) avec les MEMES
// outils de redaction et de publication (`outilsAutoValidation`, api/avis.js),
// en se placant une minute apres l'heure prevue. Rien n'est recopie : ce qui
// passe ici est ce qui passera en production.
//
// Le deroule de la recette :
//   1. la publication automatique activee sur le bien A, page Avis de staging ;
//   2. scripts/recette-avis-staging.js --decor  (une evaluation a remplir) ;
//   3. scripts/armer-avis-sans-prestataire.js --nees-avant <maintenant> --compte <compte>,
//      a blanc puis --go  (l'horloge part) ;
//   4. CE script --echeance  (l'avis part, en simulation) ;
//   5. la page Avis : l'evaluation est publiee, « automatiquement ».
//
// ⚠ STAGING UNIQUEMENT, verifie par la reference du projet (lib/empreinte-base.js).
// ⚠ PUBLICATION SIMULEE. Hors production, api/avis.js simule par defaut, et
// UNE seule variable leve la simulation : `AVIS_PUBLICATION_REELLE=1`. Le script
// REFUSE de tourner si elle est posee — dans .env.staging comme dans le terminal
// (`--env-file` ne remplace pas une variable deja exportee). Une version de ce
// script posait `AVIS_PUBLICATION_SIMULEE=1` en croyant imposer la simulation :
// cette variable n'est lue qu'en production, pour y etre ignoree (review de
// f04b563, constat 1). Apres coup, chaque publication est relue : une reponse
// du canal sans la marque de simulation fait sortir le script en ECHEC.
// Et l'objet du decor porte une reference inconnue de Channex : un envoi reel
// echouerait en 404 plutot que de partir.
// ⚠ AUCUNE NOTIFICATION REELLE : l'envoi des taches (SMS, courriel) est
// remplace par un journal a l'ecran.
// ⚠ SEULES LES EVALUATIONS DU DECOR (`RECETTE-AVIS…`) sont touchees.

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY requis.'); process.exit(1) }
const MARQUE = 'RECETTE-AVIS'
const args = process.argv.slice(2)
const ECHEANCE = args.includes('--echeance')
const iCompte = args.indexOf('--compte')
const COMPTE = iCompte >= 0 ? args[iCompte + 1] : null
if (iCompte >= 0 && (!COMPTE || COMPTE.startsWith('--'))) { console.error('--compte attend un identifiant de compte.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const heureParis = (v) => (v ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(v)) : '—')
const COLONNES = 'id, user_id, booking_uid, status, deadline_at, auto_publier_le, answers_host, answers_cleaner, grille_figee, published_at, public_text, origine_texte, provider_response'

async function lireDecor () {
  let q = sb.from('guest_evaluations').select(COLONNES)
    .like('booking_uid', `${MARQUE}%`).order('created_at', { ascending: false }).limit(50)
  if (COMPTE) q = q.eq('user_id', COMPTE)
  const { data, error } = await q
  if (error) { console.error('Evaluations illisibles :', error.message); process.exit(1) }
  return data || []
}

function afficher (evals) {
  console.log(`\nEvaluations de recette : ${evals.length}`)
  for (const e of evals) {
    console.log(`  · ${e.booking_uid} — ${e.status}${e.origine_texte ? ` (${e.origine_texte})` : ''}`)
    console.log(`      horloge     : ${e.auto_publier_le ? heureParis(e.auto_publier_le) : 'aucune'}`)
    console.log(`      échéance    : ${heureParis(e.deadline_at)}`)
    if (e.published_at) console.log(`      publiée le  : ${heureParis(e.published_at)}`)
    if (e.answers_host) console.log(`      réponses    : ${JSON.stringify(e.answers_host)}`)
    if (e.grille_figee) console.log(`      grille      : ${(e.grille_figee.criteres || []).length} question(s), figée`)
    if (e.public_text) console.log(`      texte       : « ${String(e.public_text).slice(0, 160)}${String(e.public_text).length > 160 ? '…' : ''} »`)
  }
}

;(async () => {
  console.log(`Projet Supabase : ${refDuProjet(URL)}`)
  if (nomDeLaBase(URL) !== 'STAGING') {
    console.error(`ECHEC : ce script ne tourne que sur STAGING (base « ${nomDeLaBase(URL)} »).`)
    process.exit(1)
  }
  const avant = await lireDecor()
  afficher(avant)
  if (!ECHEANCE) { console.log('\n(--echeance pour faire comme si le délai était écoulé)'); return }

  if (process.env.AVIS_PUBLICATION_REELLE) {
    console.error('\nECHEC : AVIS_PUBLICATION_REELLE est posée — la publication partirait POUR DE VRAI. Retirez-la (fichier .env.staging ou terminal) et relancez.')
    process.exit(1)
  }
  // Seulement les evaluations dont l'echeance d'Airbnb tombe APRES l'heure
  // jouee (review de f04b563, constat 2) : un vieux decor arme d'une recette
  // precedente serait sinon desarme « delai passe » au lieu de rester a part.
  const candidates = avant.filter(e => e.auto_publier_le && e.status !== 'publiee')
  const plusTard = candidates.length ? Math.max(...candidates.map(e => Date.parse(e.auto_publier_le))) + 60000 : 0
  const armees = candidates.filter(e => Date.parse(e.deadline_at) > plusTard)
  for (const e of candidates.filter(x => !armees.includes(x))) console.log(`  (écartée : ${e.booking_uid}, son échéance passerait avant l’heure jouée)`)
  if (!armees.length) {
    console.error('\nAucune évaluation de recette n’a d’horloge : lancer d’abord scripts/armer-avis-sans-prestataire.js --go.')
    process.exit(1)
  }
  const { outilsAutoValidation } = require('../api/avis')
  const { executerAutoValidations } = require('../lib/avis/auto-validation')

  // Une minute apres la plus tardive des horloges : toutes sont echues.
  const maintenant = plusTard
  console.log(`\n─── Échéance jouée comme s’il était ${heureParis(maintenant)} ───`)
  // noterEtEnvoyer passe { type, propertyId, task: { summary } } (lib/avis/notifications.js).
  const deps = { envoyer: async (m) => console.log(`  [notification, non envoyée] ${(m && m.task && m.task.summary) || ''}`) }
  const bilan = await executerAutoValidations(sb, {
    maintenant, outils: outilsAutoValidation, deps, seulement: armees.map(e => e.booking_uid),
  })
  console.log('Bilan :', JSON.stringify(bilan))

  const apres = await lireDecor()
  afficher(apres)
  // La preuve que rien n'est parti : chaque evaluation publiee ICI porte la
  // reponse du double de provider, marquee simulation.
  const publieesIci = apres.filter(e => e.status === 'publiee' && armees.some(a => a.id === e.id))
  // Le double rend { data: { id, simulation: true } } a la publication et
  // { simulation: true } a la relecture (api/avis.js, providerSimule).
  const simulee = (r) => Boolean(r && (r.simulation === true || (r.data && r.data.simulation === true)))
  const reelles = publieesIci.filter(e => !simulee(e.provider_response))
  if (reelles.length) {
    console.error(`\nECHEC : ${reelles.length} publication(s) SANS la marque de simulation — vérifier immédiatement : ${reelles.map(e => e.booking_uid).join(', ')}`)
    process.exit(1)
  }
  if (publieesIci.length) console.log(`\n${publieesIci.length} publication(s), toutes simulées.`)
  process.exit(bilan.publiees ? 0 : 1)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
