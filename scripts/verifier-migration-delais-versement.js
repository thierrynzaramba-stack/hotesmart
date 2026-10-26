#!/usr/bin/env node
// scripts/verifier-migration-delais-versement.js
// La migration migrations/2026-10-25-delais-versement.sql est-elle appliquee ?
//
// ⚠ IL NE SUFFIT PAS DE DEMANDER « la table existe-t-elle ? ». `create table
// if not exists` reussit EN SILENCE sur une table a la forme differente, et
// une table peut exister SANS ses trois lignes : l'ecran rangerait alors tous
// les sejours dans « delai absent », c'est-a-dire nulle part, et le total
// aurait l'air juste.
//
// ON L'INTERROGE DONC PAR SON COMPORTEMENT :
//   1. la table se lit, et ses 5 colonnes sont la ;
//   2. les TROIS canaux sont semes, avec la base et le delai decides par
//      Thierry le 24 octobre 2026 — airbnb arrivee+1, booking depart+1,
//      direct reservation+3 ;
//   3. les deux CHECK mordent : une base inconnue et un delai negatif sont
//      refuses par la base, pas seulement par le code ;
//   4. la RLS est activee, et la cle publique LIT (c'est voulu : ces valeurs
//      ne sont la donnee de personne) mais n'ECRIT pas.
//
// Lecture seule par defaut : il peut donc tourner contre la PRODUCTION, et
// c'est la que ca compte — une migration « appliquee » sur staging seulement
// est le defaut le plus cher du depot.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migration-delais-versement.js --ecrit
//   ENV_FILE=/home/thierry/hotesmart/.env.local \
//     node scripts/verifier-migration-delais-versement.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const ANON = process.env.SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
// ⚠ L'EMPREINTE EST LA REFERENCE DU PROJET, PAS LE NOMBRE DE BIENS — et c'est
// une correction du 26 octobre 2026, mesuree. Les verificateurs du depot
// identifiaient la base par son nombre de logements ; staging en porte QUATRE
// depuis qu'un bien y a ete cree, et ce script a refuse de travailler sur une
// base parfaitement identifiable. Une empreinte qui derive avec la donnee n'est
// pas une empreinte : la reference du projet, elle, ne bouge pas. Le compte des
// biens reste imprime — il situe la base d'un coup d'oeil — mais il ne decide
// plus.
//
// ⚠ ET LA REGLE VIENT DU MODULE COMMUN, elle n'est plus recopiee ici. Ce
// fichier portait sa PROPRE copie des deux references et sa propre extraction
// d'URL — une divergence que je savais et que j'avais annoncee comme « sans
// consequence sur le merge ». C'ETAIT FAUX, et c'est le test du lot
// `fix-empreinte-par-projet` qui l'a dit : sur l'arbre fusionne, 6332 tests,
// 6331 verts, UN rouge — « aucun script ne recopie une reference de projet ».
// Deux fichiers differents, aucun conflit git, un invariant casse : le defaut
// que ce test existe pour attraper, et il m'a attrape moi.
//
// ⚠⚠ ET LA COPIE N'ETAIT PAS QU'UNE REDONDANCE, C'ETAIT LE MEME TROU DE
// SECURITE que la re-review a trouve dans quatre autres scripts. L'extraction
// maison `(URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1]` n'est ni ancree, ni
// insensible a la casse, et n'accepte que `https:` : sur `http://`, sur
// `HTTPS://` ou avec des identifiants, elle rend une chaine VIDE, donc
// `PROJET === PROD` devient faux — ET `--ecrit` AURAIT ECRIT EN PRODUCTION.
// C'est le script qui pose des lignes temoins dans `delais_versement` : il
// aurait insere et supprime sur la base de production, en annoncant staging.
const PROJET = refDuProjet(URL) || ''
const ECRIT = process.argv.includes('--ecrit')
if (ECRIT && nomDeLaBase(URL) === 'PRODUCTION') {
  console.error(`REFUS : ${PROJET} est la PRODUCTION. --ecrit est reserve a staging.`)
  process.exit(2)
}

const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const pub = ANON ? createClient(URL, ANON, { auth: { persistSession: false } }) : null

let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++ }

// Les trois regles, telles que la migration les seme. Elles sont ECRITES ICI
// pour que le verificateur ait une attente a lui : lire la table et dire
// « conforme a elle-meme » ne prouverait rien.
const ATTENDU = {
  airbnb: { base: 'arrivee', jours: 1 },
  booking: { base: 'depart', jours: 1 },
  direct: { base: 'reservation', jours: 3 }
}

;(async () => {
  // ⚠ L'EMPREINTE EN TETE : un resultat qui ne dit pas OU il a ete obtenu ne
  // prouve rien. C'est la REFERENCE DU PROJET qui la donne, et le nombre de
  // biens est imprime a cote, a titre d'information.
  const { count: biens, error: eB } = await sb.from('properties')
    .select('*', { count: 'exact', head: true })
  if (eB) { console.error('Empreinte illisible :', eB.message); process.exit(1) }
  const nom = nomDeLaBase(URL)
  console.log(`Base : ${PROJET} — ${nom} — ${biens} bien(s)\n`)
  if (nom === 'INCONNUE') {
    console.error(`Projet inconnu (${PROJET}) : arret. Un resultat qui ne dit pas OU`)
    console.error('il a ete obtenu ne prouve rien.')
    process.exit(1)
  }

  // 1 et 2 : la table, sa forme, et ses trois lignes.
  const { data, error } = await sb.from('delais_versement')
    .select('canal, base, jours, libelle, maj_le')
  if (error) {
    ko(`table illisible : ${error.message}`)
    console.error('\nLa migration n est PAS appliquee sur cette base.')
    process.exit(1)
  }
  const lignes = data || []
  if (!lignes.length) {
    // ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER. Une table vide rendrait
    // tous les sejours « delai absent » — donc aucun revenu range, et un total
    // qui a l'air juste.
    ko('la table existe mais ne porte AUCUNE ligne : aucun revenu ne serait range')
  } else {
    ok(`${lignes.length} ligne(s) lues`)
  }
  for (const [canal, attendu] of Object.entries(ATTENDU)) {
    const l = lignes.find(x => x.canal === canal)
    if (!l) { ko(`le canal ${canal} n est pas seme`); continue }
    if (l.base !== attendu.base || Number(l.jours) !== attendu.jours) {
      ko(`${canal} : ${l.base} + ${l.jours} j, attendu ${attendu.base} + ${attendu.jours} j`)
    } else {
      ok(`${canal} : ${l.base} + ${l.jours} j`)
    }
  }
  // Les colonnes, comptees — pas seulement l'existence de la table.
  const manquantes = ['canal', 'base', 'jours', 'libelle', 'maj_le']
    .filter(c => lignes.length && !(c in lignes[0]))
  if (manquantes.length) ko(`colonnes absentes : ${manquantes.join(', ')}`)
  else if (lignes.length) ok('les 5 colonnes sont la')

  // 3 : les deux CHECK mordent. On ECRIT pour le savoir, donc staging seulement.
  if (ECRIT) {
    // ⚠ UN REFUS NE PROUVE RIEN S'IL NE DIT PAS POURQUOI (constat de la revue
    // du 26 octobre 2026). Ma premiere version comptait TOUT refus comme la
    // preuve du CHECK : une ligne temoin restee d'un passage interrompu
    // (violation de cle primaire), ou n'importe quelle contrainte ajoutee plus
    // tard, rendait les trois sondes vertes SANS que le CHECK ait ete exerce
    // une seule fois. On exige donc que le message NOMME la contrainte.
    const refus = async (ligne, quoi, contrainte) => {
      const { error: e } = await sb.from('delais_versement').insert(ligne)
      if (!e) {
        ko(`${quoi} : ACCEPTE par la base`)
        await sb.from('delais_versement').delete().eq('canal', ligne.canal)
        return
      }
      const dit = String(e.message || '') + ' ' + String(e.details || '')
      if (dit.includes(contrainte)) ok(`${quoi} : refuse par ${contrainte}`)
      else ko(`${quoi} : refuse, mais pas par ${contrainte} — ${e.message}`)
    }
    // Chaque temoin porte un canal qui lui est propre : deux sondes sur le meme
    // canal se refuseraient l'une l'autre par la cle primaire, et c'est
    // precisement le faux refus qu'on vient de fermer.
    await refus({ canal: '_temoin_base', base: 'au depart', jours: 1 },
      'base inconnue', 'delais_versement_base_connue')
    await refus({ canal: '_temoin_jours', base: 'depart', jours: -1 },
      'delai negatif', 'delais_versement_jours_sense')
    await refus({ canal: '_temoin_plafond', base: 'depart', jours: 999 },
      'delai hors plafond', 'delais_versement_jours_sense')
    // ⚠ ET LE `default 0` RETIRE (migration du 26 octobre) : une insertion qui
    // OUBLIE la colonne doit etre refusee, pas completee par une supposition.
    const { error: eD } = await sb.from('delais_versement')
      .insert({ canal: '_temoin_defaut', base: 'depart' })
    if (eD) ok('colonne `jours` omise : refusee (pas de valeur par defaut)')
    else {
      ko('colonne `jours` omise : ACCEPTEE — un canal a zero jour entre en silence')
      await sb.from('delais_versement').delete().eq('canal', '_temoin_defaut')
    }
  } else {
    console.log('  (les CHECK ne sont pas eprouves : --ecrit, sur staging seulement)')
  }

  // 4 : la RLS. Lecture ouverte, ecriture fermee.
  if (pub) {
    // ⚠ `anon` N'EST PAS `authenticated`, ET MA PREMIERE VERSION CONFONDAIT LES
    // DEUX (mesure du 26 octobre 2026). La policy vise le role `authenticated` :
    // la cle publique SEULE lit donc zero ligne, ce qui est correct — et ne
    // prouve RIEN sur le cas reel, un hote connecte qui ouvre son accueil.
    // J'affichais « 0 ligne(s), comme prevu » : vrai, et hors sujet.
    const { data: anon, error: eA } = await pub.from('delais_versement').select('canal')
    if (eA) ko(`lecture anonyme en erreur : ${eA.message}`)
    else if ((anon || []).length) ko(`la cle PUBLIQUE lit ${anon.length} ligne(s) : la policy vise `
      + '`authenticated`, pas tout le monde')
    else ok('la cle publique (role `anon`) ne lit rien — la policy vise `authenticated`')

    // LE CAS REEL : un hote CONNECTE. Sans ce point, « lecture ouverte » n'est
    // qu'une intention lue dans le SQL.
    const email = process.env.TEST_EMAIL
    const mdp = process.env.TEST_PASSWORD
    if (email && mdp) {
      const { data: session, error: eS } = await pub.auth.signInWithPassword({ email, password: mdp })
      if (eS || !session || !session.session) {
        ko(`connexion du compte de test impossible : ${(eS && eS.message) || 'pas de session'}`)
      } else {
        const { data: luCo, error: eC } = await pub.from('delais_versement').select('canal, base, jours')
        if (eC) ko(`un hote CONNECTE ne lit pas la table : ${eC.message} — l ecran ne saurait pas ranger`)
        else if (!(luCo || []).length) ko('un hote connecte lit ZERO ligne : la policy ne mord pas comme annonce')
        else ok(`un hote connecte lit ${luCo.length} ligne(s)`)
        await pub.auth.signOut()
      }
    } else {
      console.log('  (lecture connectee non eprouvee : TEST_EMAIL / TEST_PASSWORD absents)')
    }
    const { error: eE } = await pub.from('delais_versement')
      .insert({ canal: '_temoin_rls', base: 'depart', jours: 1 })
    if (eE) ok('la cle publique n ECRIT pas')
    else {
      ko('LA CLE PUBLIQUE ECRIT : n importe qui peut deplacer les revenus d un mois')
      await sb.from('delais_versement').delete().eq('canal', '_temoin_rls')
    }
  } else {
    console.log('  (RLS non eprouvee : SUPABASE_ANON_KEY absente)')
  }

  console.log(echecs ? `\n${echecs} ECHEC(S)` : '\nTout est conforme.')
  process.exit(echecs ? 1 : 0)
})().catch(e => { console.error('Exception :', e.message); process.exit(1) })
