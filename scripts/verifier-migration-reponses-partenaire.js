#!/usr/bin/env node
// scripts/verifier-migration-reponses-partenaire.js
// La migration 2026-10-19-reponses-partenaire-invalides.sql est-elle appliquee ?
//
// ⚠ IL NE SUFFIT PAS DE DEMANDER « la table existe-t-elle ? ».
// `create table if not exists` reussit en silence sur une table a la forme
// differente, et une table peut exister sans sa RLS ni sa contrainte : l'appel
// passerait, et la premiere ecriture reelle ferait la difference.
//
// ON L'INTERROGE DONC PAR SON COMPORTEMENT :
//   1. la table se lit, et ses 10 colonnes sont la ;
//   2. la contrainte refuse un `code` inconnu — c'est elle qui garantit que la
//      colonne ne porte que les trois motifs du writer ;
//   3. les trois motifs legitimes sont acceptes ;
//   4. une ligne s'ecrit et se relit a l'identique, `occurrences` comprise ;
//   5. ⚠ PERSONNE NE LIT CETTE TABLE hors cle de service : ni la cle anonyme,
//      ni une session AUTHENTIFIEE. Le second point est le seul qui compte —
//      la cle anonyme n'a aucun acces nulle part, un « refus » de sa part ne
//      prouve rien (lecon du faux vert, 19 octobre 2026).
// Les points 2 a 4 ECRIVENT : ce script REFUSE la production par defaut, et
// nettoie ce qu'il a pose.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migration-reponses-partenaire.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')
const { REF_PRODUCTION } = require('../lib/empreinte-base')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
const PROJET = (URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || ''
// ⚠ LA REFERENCE DE LA PRODUCTION VIENT DU MODULE COMMUN, elle ne se recopie
// plus (constat MINEUR de la review du 26 octobre 2026 : elle etait en dur
// dans 21 fichiers hors du module qui s'annonce « regle partagee »).
const PROD = REF_PRODUCTION
const CONFIRME = String(process.env.CONFIRMER_PROD || '').trim() === PROD
if (PROJET === PROD && !CONFIRME) {
  console.error(`REFUS : ${PROJET} est la PRODUCTION. Ce script ecrit — staging seulement.`)
  console.error(`Pour un passage unique et assume : CONFIRMER_PROD=${PROD}`)
  process.exit(2)
}
if (PROJET === PROD) {
  console.log('⚠ PASSAGE EN PRODUCTION ASSUME — ' + new Date().toISOString())
  console.log('  ecrit : 1 a 4 lignes d essai dans reponses_partenaire_invalides,')
  console.log('          puis leur suppression et leur relecture.\n')
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

const TABLE = 'reponses_partenaire_invalides'
const COLONNES = ['id', 'fichier', 'methode', 'chemin', 'statut', 'code',
                  'extrait', 'occurrences', 'vu_le', 'cree_le']
const MOTIFS = ['reponse_non_json', 'forme_inattendue', 'reponse_vide']
const MARQUE = 'VERIF-MIGRATION'

;(async () => {
  console.log(`Projet Supabase : ${PROJET}`)
  let ko = 0
  const ok = (m) => console.log('  ✓ ' + m)
  const rat = (m) => { console.error('  ✗ ' + m); ko++ }

  // 1. Les colonnes. ⚠ ET TOUT CE QUI SUIT EN DEPEND : sans la table, « personne
  // ne lit » et « les lignes sont nettoyees » sont vrais et ne prouvent RIEN.
  // Un ✓ pour la mauvaise raison est un faux vert (lecon du 19 octobre 2026).
  const { error: e1 } = await sb.from(TABLE).select(COLONNES.join(', ')).limit(1)
  const tableLa = !e1
  if (e1) rat(`les ${COLONNES.length} colonnes ne se lisent pas : ` + e1.message.slice(0, 80))
  else ok(`les ${COLONNES.length} colonnes se lisent`)

  await sb.from(TABLE).delete().eq('fichier', MARQUE)

  const ligne = (code) => ({
    fichier: MARQUE, methode: 'GET', chemin: '/channels',
    statut: 200, code, extrait: 'essai', occurrences: 1
  })

  // 2. La contrainte refuse un code inconnu.
  const { error: e2 } = await sb.from(TABLE).insert(ligne('code_invente'))
  if (!e2) rat('un `code` inconnu a ete accepte : la contrainte check manque')
  else if (e2.code === '23514') ok('un `code` inconnu est refuse (check, 23514)')
  else rat('refus pour une AUTRE raison : ' + (e2.code || '?') + ' ' + e2.message.slice(0, 60))

  // 3. Les trois motifs legitimes passent.
  let tous = true
  for (const m of MOTIFS) {
    const { error } = await sb.from(TABLE).insert(ligne(m))
    if (error) { rat(`le motif « ${m} » est refuse : ` + error.message.slice(0, 60)); tous = false }
  }
  if (tous) ok('les trois motifs du writer sont acceptes')

  // 4. Relecture a l'identique.
  const { data: relues } = await sb.from(TABLE)
    .select('code, statut, occurrences, chemin, extrait').eq('fichier', MARQUE)
  if (!relues || relues.length !== MOTIFS.length) {
    rat(`${(relues || []).length} ligne(s) relues pour ${MOTIFS.length} ecrites`)
  } else if (relues.every(r => r.statut === 200 && r.occurrences === 1
                           && r.chemin === '/channels' && r.extrait === 'essai')) {
    ok('les lignes se relisent a l\'identique')
  } else {
    rat('relecture differente de ce qui a ete ecrit : ' + JSON.stringify(relues[0]))
  }

  // 5. PERSONNE ne lit cette table hors cle de service.
  //    ⚠ LE POINT QUI COMPTE EST LA SESSION AUTHENTIFIEE. La cle anonyme n'a
  //    aucun acces nulle part : son refus ne prouverait rien.
  if (!tableLa) {
    rat('cloisonnement NON EPROUVE : la table n\'existe pas, aucun refus ne prouve rien')
  } else {
  const { error: eAnon } = await anon.from(TABLE).select('id').limit(1)
  if (eAnon) ok('la cle anonyme ne lit pas la table')
  else rat('la cle ANONYME lit la table')

  if (process.env.TEST_EMAIL && process.env.TEST_PASSWORD) {
    const c = createClient(URL, process.env.SUPABASE_ANON_KEY, { global: { fetch: fetchTenace } })
    const { data: s, error: eS } = await c.auth.signInWithPassword({
      email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD })
    if (eS) rat('session de test impossible : ' + eS.message.slice(0, 60))
    else {
      const { data: vues, error: eA } = await c.from(TABLE).select('id').limit(1)
      if (eA) ok(`une session AUTHENTIFIEE (${s.user.email}) ne lit pas la table`)
      else if ((vues || []).length === 0) {
        rat('une session authentifiee n\'est pas REFUSEE (elle lit 0 ligne) : '
            + 'la RLS filtre, mais le privilege de table devrait refuser')
      } else rat('une session AUTHENTIFIEE LIT la table : ' + (vues || []).length + ' ligne(s)')
    }
  } else {
    rat('TEST_EMAIL/TEST_PASSWORD absents : le point qui compte n\'a pas ete eprouve')
  }
  }

  // Nettoyage, et preuve qu'il a eu lieu. Sans la table, il n'y a rien a
  // nettoyer : ne pas l'annoncer comme un succes.
  if (tableLa) {
    await sb.from(TABLE).delete().eq('fichier', MARQUE)
    const { data: reste } = await sb.from(TABLE).select('id').eq('fichier', MARQUE)
    if (reste && reste.length) rat('les lignes d\'essai n\'ont pas ete nettoyees')
    else ok('lignes d\'essai nettoyees')
  }

  console.log(ko ? `\n${ko} point(s) en echec.` : '\nMigration appliquee et prouvee.')
  process.exit(ko ? 1 : 0)
})().catch(e => { console.error('Erreur :', e.message); process.exit(2) })
