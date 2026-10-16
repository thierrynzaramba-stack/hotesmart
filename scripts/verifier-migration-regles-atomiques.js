#!/usr/bin/env node
// scripts/verifier-migration-regles-atomiques.js — la migration
// migrations/2026-10-16-regles-atomiques.sql est-elle appliquee ?
//
// ⚠ IL NE SUFFIT PAS DE DEMANDER « la fonction existe-t-elle ? ». Une fonction
// peut exister avec une signature voisine, ou sans ses gardes : l'appel
// passerait et la premiere ecriture reelle ferait la difference, en
// production, sur les jours de quelqu'un.
//
// ON L'INTERROGE DONC PAR SON COMPORTEMENT, ET SANS RIEN ECRIRE :
//   1. `p_source` invalide -> elle doit REFUSER (22023). Ce refus prouve a la
//      fois qu'elle existe, qu'elle a la bonne signature, et que la garde de
//      source est en place ;
//   2. liaison manquante -> elle doit refuser aussi (22023) ;
//   3. plafond : on appelle avec `p_max_actives = -1`, ce qui rend tout compte
//      superieur au plafond -> 54000. Aucun jour n'est touche, puisque la
//      fonction leve avant d'ecrire.
// Aucun de ces trois appels n'insere ni ne desactive quoi que ce soit.
//
// ⚠ ET ON DIT CONTRE QUELLE BASE on a verifie : une migration « appliquee » ne
// veut rien dire si l'on ne sait pas ou. Le dépôt a déjà payé un jour entier
// une migration prouvée contre staging et annoncée en prod.
//
//   node scripts/verifier-migration-regles-atomiques.js
//   (lit SUPABASE_URL / SUPABASE_SERVICE_KEY de l'environnement)

require('dotenv').config({ path: process.env.ENV_FILE || '.env.local' })
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
const supabase = createClient(URL, KEY)

// Le projet, sans sa cle : c'est ce qui dit CONTRE QUOI on a verifie.
const PROJET = (URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || '(inconnu)'

const FAUX_UUID = '00000000-0000-0000-0000-000000000000'

async function appeler (args) {
  const { data, error } = await supabase.rpc('remplacer_regles_dispo', args)
  return { data, error }
}

;(async () => {
  console.log(`Projet Supabase : ${PROJET}`)
  let ko = 0

  // 1. La source est gardee — et donc la fonction existe, avec sa signature.
  {
    const { error } = await appeler({
      p_user_id: FAUX_UUID, p_provider_id: FAUX_UUID,
      p_source: 'pas-une-source', p_regles: [], p_max_actives: 50
    })
    if (!error) { console.error('✗ une source invalide a ete ACCEPTEE'); ko++ }
    else if (String(error.code) === '42883' || /does not exist/i.test(error.message || '')) {
      console.error('✗ la fonction remplacer_regles_dispo est ABSENTE — migration non appliquee')
      ko++
    } else if (/source invalide/.test(error.message || '')) {
      console.log('✓ la fonction existe, et elle refuse une source inconnue')
    } else {
      console.error('✗ refus inattendu :', error.code, error.message); ko++
    }
  }

  // 2. La liaison est gardee.
  {
    const { error } = await appeler({
      p_user_id: null, p_provider_id: FAUX_UUID,
      p_source: 'hote', p_regles: [], p_max_actives: 50
    })
    if (error && /liaison manquante/.test(error.message || '')) {
      console.log('✓ elle refuse une liaison incomplete')
    } else {
      console.error('✗ une liaison incomplete n\'est pas refusee :',
        error ? error.message : '(aucune erreur)')
      ko++
    }
  }

  // 3. Le plafond refuse, il n'ecrete pas.
  {
    const { error } = await appeler({
      p_user_id: FAUX_UUID, p_provider_id: FAUX_UUID,
      p_source: 'hote', p_regles: [], p_max_actives: -1
    })
    if (error && /trop de regles actives/.test(error.message || '')) {
      console.log('✓ le plafond REFUSE au lieu d\'ecreter')
    } else {
      // ⚠ Sur une liaison inexistante, le compte vaut 0 : 0 > -1 est vrai,
      // donc le refus doit tomber. S'il ne tombe pas, le garde n'est pas pose.
      console.error('✗ le plafond ne refuse pas :', error ? error.message : '(aucune erreur)')
      ko++
    }
  }

  console.log(ko === 0
    ? `\nMigration 2026-10-16-regles-atomiques APPLIQUEE sur ${PROJET}.`
    : `\n${ko} verification(s) en echec sur ${PROJET}.`)
  process.exit(ko === 0 ? 0 : 1)
})().catch((e) => { console.error('Erreur :', e.message); process.exit(2) })
