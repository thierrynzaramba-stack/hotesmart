#!/usr/bin/env node
// scripts/verifier-migration-preferences-ecran.js
// La migration 2026-11-11-preferences-ecran.sql est-elle appliquee ?
// Spec : docs/specs/spec-yf-ecran-evenements.md §16.5.
//
// ⚠ IL NE SUFFIT PAS DE DEMANDER « la table existe-t-elle ? » : on
// l'interroge par son COMPORTEMENT —
//   1. ses 5 colonnes se lisent ;
//   2. la contrainte refuse une `valeur` qui n'est pas un objet, et un nom
//      d'ecran mal forme ;
//   3. l'ecriture de l'endpoint (upsert sur la cle personne + compte + ecran)
//      passe deux fois sans doubler la ligne, et se relit a l'identique ;
//   4. ⚠ PERSONNE NE LIT CETTE TABLE hors cle de service : ni la cle anonyme,
//      ni une session AUTHENTIFIEE — et c'est la seconde qui compte (lecon du
//      faux vert, 19 octobre 2026).
// Les points 2 et 3 ECRIVENT : la production est refusee par defaut, et les
// lignes d'essai sont nettoyees.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migration-preferences-ecran.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')
const { REF_PRODUCTION, nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
// ⚠ LA REFERENCE SE LIT PAR LE MODULE COMMUN, jamais par un motif maison
// (correction de securite du 26 octobre 2026).
const PROJET = refDuProjet(URL) || ''
const PROD = REF_PRODUCTION
const CONFIRME = String(process.env.CONFIRMER_PROD || '').trim() === PROD
if (nomDeLaBase(URL) === 'PRODUCTION' && !CONFIRME) {
  console.error(`REFUS : ${PROJET} est la PRODUCTION. Ce script ecrit — staging seulement.`)
  console.error(`Pour un passage unique et assume : CONFIRMER_PROD=${PROD}`)
  process.exit(2)
}
if (nomDeLaBase(URL) === 'PRODUCTION') {
  console.log('⚠ PASSAGE EN PRODUCTION ASSUME — ' + new Date().toISOString())
  console.log('  ecrit : 1 ligne d essai dans preferences_ecran (personne fictive),')
  console.log('          puis sa suppression et sa relecture.\n')
}

// Un hoquet reseau ne doit pas se lire « migration absente » (faux rouge).
const fetchTenace = async (u, o) => {
  let d
  for (let i = 0; i < 5; i++) {
    try { return await fetch(u, o) } catch (e) { d = e; await new Promise(r => setTimeout(r, 300 * (i + 1))) }
  }
  throw d
}
const sb = createClient(URL, KEY, { global: { fetch: fetchTenace } })
const anon = createClient(URL, process.env.SUPABASE_ANON_KEY, { global: { fetch: fetchTenace } })

const TABLE = 'preferences_ecran'
const COLONNES = ['user_id', 'compte_id', 'ecran', 'valeur', 'mis_a_jour_le']
// Une personne et un compte FICTIFS : aucune preference reelle n'est touchee.
const ESSAI = '00000000-0000-4000-8000-00000000e4b1'
const ECRAN = 'verif_migration'

;(async () => {
  console.log(`Projet Supabase : ${PROJET}`)
  let ko = 0
  const ok = (m) => console.log('  ✓ ' + m)
  const rat = (m) => { console.error('  ✗ ' + m); ko++ }

  // 1. Les colonnes. ⚠ TOUT CE QUI SUIT EN DEPEND : sans la table, « personne
  // ne lit » serait vrai et ne prouverait rien.
  const { error: e1 } = await sb.from(TABLE).select(COLONNES.join(', ')).limit(1)
  const tableLa = !e1
  if (e1) rat(`les ${COLONNES.length} colonnes ne se lisent pas : ` + e1.message.slice(0, 80))
  else ok(`les ${COLONNES.length} colonnes se lisent`)

  const ligne = (valeur, ecran = ECRAN) => ({ user_id: ESSAI, compte_id: ESSAI, ecran, valeur })
  if (tableLa) await sb.from(TABLE).delete().eq('user_id', ESSAI)

  // 2. Les contraintes.
  if (tableLa) {
    const { error: e2 } = await sb.from(TABLE).insert(ligne(['n3']))
    if (!e2) rat('une `valeur` tableau a ete acceptee : la contrainte pe_valeur_chk manque')
    else if (e2.code === '23514') ok('une `valeur` qui n\'est pas un objet est refusee (23514)')
    else rat('refus pour une AUTRE raison : ' + (e2.code || '?') + ' ' + e2.message.slice(0, 60))
    const { error: e3 } = await sb.from(TABLE).insert(ligne({ eteintes: [] }, 'Mauvais Nom'))
    if (!e3) rat('un nom d\'ecran mal forme a ete accepte : la contrainte pe_ecran_chk manque')
    else if (e3.code === '23514') ok('un nom d\'ecran mal forme est refuse (23514)')
    else rat('refus pour une AUTRE raison : ' + (e3.code || '?') + ' ' + e3.message.slice(0, 60))
  }

  // 3. L'ecriture de l'endpoint, deux fois : une seule ligne, la derniere.
  if (tableLa) {
    const ecrire = v => sb.from(TABLE).upsert({ ...ligne(v), mis_a_jour_le: new Date().toISOString() },
      { onConflict: 'user_id,compte_id,ecran' })
    const { error: e4 } = await ecrire({ eteintes: ['n3'] })
    const { error: e5 } = await ecrire({ eteintes: ['n2', 'n3'] })
    if (e4 || e5) rat('l\'upsert de l\'endpoint echoue : ' + ((e4 || e5).message || '').slice(0, 80))
    const { data: relues } = await sb.from(TABLE).select('valeur').eq('user_id', ESSAI).eq('ecran', ECRAN)
    if (!relues || relues.length !== 1) rat(`${(relues || []).length} ligne(s) pour 1 attendue : la cle primaire manque`)
    else if (JSON.stringify(relues[0].valeur) === JSON.stringify({ eteintes: ['n2', 'n3'] })) {
      ok('deux ecritures, une ligne, relue a l\'identique')
    } else rat('relecture differente : ' + JSON.stringify(relues[0].valeur))
  }

  // 4. PERSONNE ne lit cette table hors cle de service.
  if (!tableLa) {
    rat('cloisonnement NON EPROUVE : la table n\'existe pas, aucun refus ne prouve rien')
  } else {
    const { error: eAnon } = await anon.from(TABLE).select('ecran').limit(1)
    if (eAnon) ok('la cle anonyme ne lit pas la table')
    else rat('la cle ANONYME lit la table')

    if (process.env.TEST_EMAIL && process.env.TEST_PASSWORD) {
      const c = createClient(URL, process.env.SUPABASE_ANON_KEY, { global: { fetch: fetchTenace } })
      const { data: s, error: eS } = await c.auth.signInWithPassword({
        email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD })
      if (eS) rat('session de test impossible : ' + eS.message.slice(0, 60))
      else {
        const { data: vues, error: eA } = await c.from(TABLE).select('ecran').limit(1)
        if (eA) ok(`une session AUTHENTIFIEE (${s.user.email}) ne lit pas la table`)
        else if ((vues || []).length === 0) {
          rat('une session authentifiee n\'est pas REFUSEE (elle lit 0 ligne) : '
              + 'le privilege de table devrait refuser')
        } else rat('une session AUTHENTIFIEE LIT la table : ' + (vues || []).length + ' ligne(s)')
      }
    } else {
      rat('TEST_EMAIL/TEST_PASSWORD absents : le point qui compte n\'a pas ete eprouve')
    }
  }

  // Nettoyage, et preuve qu'il a eu lieu.
  if (tableLa) {
    await sb.from(TABLE).delete().eq('user_id', ESSAI)
    const { data: reste } = await sb.from(TABLE).select('ecran').eq('user_id', ESSAI)
    if (reste && reste.length) rat('les lignes d\'essai n\'ont pas ete nettoyees')
    else ok('lignes d\'essai nettoyees')
  }

  console.log(ko ? `\n${ko} point(s) en echec.` : '\nMigration appliquee et prouvee.')
  process.exit(ko ? 1 : 0)
})().catch(e => { console.error('Erreur :', e.message); process.exit(2) })
