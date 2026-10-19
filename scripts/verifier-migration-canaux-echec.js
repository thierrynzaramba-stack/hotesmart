#!/usr/bin/env node
// scripts/verifier-migration-canaux-echec.js
// La migration migrations/2026-10-19-canaux-echec-visible.sql est-elle
// appliquee ?
//
// ⚠ IL NE SUFFIT PAS DE DEMANDER « la colonne existe-t-elle ? ».
// `add column if not exists` reussit en silence, et une colonne peut exister
// avec le mauvais type, la mauvaise valeur par defaut ou la mauvaise
// nullabilite : l'appel passerait, et la premiere ecriture reelle ferait la
// difference — sur l'horloge d'un vrai compte.
//
// ON L'INTERROGE DONC PAR SON COMPORTEMENT :
//   1. les quatre colonnes se lisent ;
//   2. `echecs_consecutifs` est NOT NULL DEFAULT 0 : une ligne posee sans
//      cette colonne vaut 0, et y mettre `null` est refuse ;
//   3. les trois autres acceptent `null` — c'est leur etat normal quand tout
//      va bien ;
//   4. un entier et deux dates s'ecrivent et se relisent a l'identique ;
//   5. AUCUNE des quatre ne porte de secret : ce sont des compteurs et des
//      dates, et ce script le verifie en listant ce qu'une lecture CLIENT
//      authentifiee peut en voir.
// Les points 2 a 4 ECRIVENT : ce script REFUSE la production, et nettoie.
//
//   ENV_FILE=/home/thierry/hotesmart/.env.staging \
//     node scripts/verifier-migration-canaux-echec.js

require('dotenv').config({ path: process.env.ENV_FILE || '.env.staging' })
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.')
  process.exit(2)
}
const PROJET = (URL.match(/https:\/\/([a-z0-9]+)\./) || [])[1] || ''
const PROD = 'cjmrizpdyhrcurmgyrhs'

// ⚠ LE REFUS DE LA PRODUCTION RESTE LE DEFAUT, ET IL N'EST PAS RETIRE
// (condition de Thierry, 19 octobre 2026). Mais la regle du depot veut qu'une
// migration de prod soit PROUVEE CONTRE LA PROD, pas sur la foi d'un texte
// identique a celui de staging — la table `fermetures` a ete absente de la
// prod un jour entier parce qu'on s'en etait tenu au texte.
//
// D'ou ce passage EXPLICITE, qui ne s'ouvre pas par accident : il faut nommer
// soi-meme le projet de production dans `CONFIRMER_PROD`. Une variable a `1`,
// `true` ou `oui` ne suffit pas, et une faute de frappe referme la porte.
//
// Ce que le script ecrit alors, et rien d'autre : UNE ligne dans
// `canaux_releve`, sur un `user_id` qui n'appartient a aucun compte (cette
// table n'a pas de cle etrangere), trois `update` sur cette seule ligne, puis
// son `delete` — suivi d'une relecture qui verifie qu'elle est partie.
const CONFIRME = String(process.env.CONFIRMER_PROD || '').trim() === PROD
if (PROJET === PROD && !CONFIRME) {
  console.error(`REFUS : ${PROJET} est la PRODUCTION. Ce script ecrit — staging seulement.`)
  console.error('Pour un passage unique et assume, relancer avec '
                + `CONFIRMER_PROD=${PROD} (le nom du projet, pas un drapeau).`)
  process.exit(2)
}
if (PROJET === PROD) {
  console.log('⚠ PASSAGE EN PRODUCTION ASSUME — ' + new Date().toISOString())
  console.log('  confirme par CONFIRMER_PROD, et journalise ici.')
  console.log('  ecrit : 1 ligne d essai dans canaux_releve (user_id hors de tout compte),')
  console.log('          3 update sur cette ligne, puis son delete et sa relecture.')
  console.log('  ne touche : aucune autre table, aucune ligne existante, jamais le partenaire.\n')
}
// ⚠ UN HOQUET RESEAU NE DOIT PAS SE LIRE « MIGRATION ABSENTE ». Mesure du
// 19 octobre : un `TypeError: fetch failed` sur un POST supabase-js a fait
// rougir un point que la base aurait accepte. Un faux rouge fait chercher une
// panne la ou il n'y en a pas — l'exact pendant du faux vert. Meme reessai
// qu'ailleurs dans le depot.
const fetchTenace = async (u, o) => {
  let derniere
  for (let i = 0; i < 5; i++) {
    try { return await fetch(u, o) }
    catch (e) { derniere = e; await new Promise(r => setTimeout(r, 300 * (i + 1))) }
  }
  throw derniere
}
const sb = createClient(URL, KEY, { global: { fetch: fetchTenace } })

const NEUVES = ['echecs_consecutifs', 'premier_echec_le',
                'disparition_totale_vue_le', 'disparition_totale_nb']
// Un compte qui n'existe pas dans auth.users : `canaux_releve.user_id` n'a pas
// de cle etrangere, on peut donc poser une ligne d'essai sans toucher a personne.
const ESSAI = '00000000-0000-4000-8000-0000000000ec'

;(async () => {
  console.log(`Projet Supabase : ${PROJET} (production refusee)`)
  let ko = 0
  const ok = (m) => console.log('  ✓ ' + m)
  const ratE = (m) => { console.error('  ✗ ' + m); ko++ }

  // 1. Les quatre colonnes se lisent.
  const { error: e1 } = await sb.from('canaux_releve')
    .select(['user_id', ...NEUVES].join(', ')).limit(1)
  if (e1) ratE('les quatre colonnes ne se lisent pas : ' + e1.message)
  else ok('les quatre colonnes se lisent')

  await sb.from('canaux_releve').delete().eq('user_id', ESSAI)

  // 2. `echecs_consecutifs` : NOT NULL DEFAULT 0.
  const { error: e2 } = await sb.from('canaux_releve')
    .insert({ user_id: ESSAI, ok: false })
  if (e2) ratE('une ligne sans `echecs_consecutifs` est refusee : ' + e2.message)
  else {
    const { data } = await sb.from('canaux_releve')
      .select('echecs_consecutifs').eq('user_id', ESSAI).limit(1)
    const v = data && data[0] ? data[0].echecs_consecutifs : null
    if (v === 0) ok('`echecs_consecutifs` vaut 0 par defaut')
    else ratE('`echecs_consecutifs` vaut ' + JSON.stringify(v) + ' au lieu de 0')
  }

  // ⚠ UN REFUS NE SUFFIT PAS : IL FAUT LE BON REFUS. Mesure du 19 octobre,
  // AVANT la migration : ce point passait au vert parce que la colonne
  // n'existait pas — l'update echouait, donc « la contrainte tient ». Un ✓ pour
  // la mauvaise raison est un faux vert. On exige le code Postgres de la
  // violation NOT NULL (23502).
  const { error: e3 } = await sb.from('canaux_releve')
    .update({ echecs_consecutifs: null }).eq('user_id', ESSAI)
  if (!e3) ratE('`echecs_consecutifs` a accepte `null` : la contrainte NOT NULL manque')
  else if (e3.code === '23502') ok('`echecs_consecutifs` refuse `null` (NOT NULL, 23502)')
  else ratE('`echecs_consecutifs` a bien refuse, mais pour une AUTRE raison : '
            + (e3.code || '?') + ' ' + e3.message)

  // 3. Les trois autres acceptent `null` — leur etat normal.
  const { error: e4 } = await sb.from('canaux_releve')
    .update({ premier_echec_le: null, disparition_totale_vue_le: null,
              disparition_totale_nb: null }).eq('user_id', ESSAI)
  if (e4) ratE('les trois colonnes nullables refusent `null` : ' + e4.message)
  else ok('`premier_echec_le` et les deux colonnes du disjoncteur acceptent `null`')

  // 4. Un entier et deux dates s'ecrivent et se relisent a l'identique.
  const QUAND = '2026-10-19T09:00:00.000Z'
  const { error: e5 } = await sb.from('canaux_releve')
    .update({ echecs_consecutifs: 12, premier_echec_le: QUAND,
              disparition_totale_vue_le: QUAND, disparition_totale_nb: 2 })
    .eq('user_id', ESSAI)
  if (e5) ratE('ecriture refusee : ' + e5.message)
  else {
    const { data } = await sb.from('canaux_releve')
      .select(NEUVES.join(', ')).eq('user_id', ESSAI).limit(1)
    const l = (data && data[0]) || {}
    const memeInstant = (a, b) => a && new Date(a).getTime() === new Date(b).getTime()
    if (l.echecs_consecutifs === 12 && l.disparition_totale_nb === 2
        && memeInstant(l.premier_echec_le, QUAND)
        && memeInstant(l.disparition_totale_vue_le, QUAND)) {
      ok('entier et dates relus a l\'identique')
    } else {
      ratE('relecture differente de ce qui a ete ecrit : ' + JSON.stringify(l))
    }
  }

  // 5. Aucune des quatre ne porte de secret.
  //    ⚠ CE POINT NE SE DEDUIT PAS DU NOM DES COLONNES. On relit la ligne
  //    d'essai et on cherche, dans CE QUE LA BASE REND, une valeur qui
  //    ressemble a un jeton, une cle ou un identifiant de partenaire.
  const { data: tout } = await sb.from('canaux_releve')
    .select('*').eq('user_id', ESSAI).limit(1)
  const ligne = (tout && tout[0]) || {}
  // ⚠ ET CE POINT N'A DE SENS QUE SI LES QUATRE COLONNES SONT LA. Avant la
  // migration, la ligne n'en portait aucune : « aucune chaine longue » etait
  // vrai et ne prouvait rien. Meme faux vert que ci-dessus.
  const presentes = NEUVES.filter(c => c in ligne)
  if (presentes.length !== NEUVES.length) {
    ratE(`controle des secrets impossible : ${presentes.length}/${NEUVES.length} colonnes presentes`)
  } else {
    const suspect = Object.entries(ligne).filter(([k, v]) =>
      typeof v === 'string' && v.length > 25 && !/^\d{4}-\d{2}-\d{2}T/.test(v)
      && k !== 'user_id')
    if (suspect.length) ratE('valeur longue non datee dans ' + suspect.map(([k]) => k).join(', '))
    else ok('aucune colonne ne porte de chaine longue : des compteurs et des dates')
  }
  console.log('    colonnes rendues : ' + Object.keys(ligne).join(', '))

  await sb.from('canaux_releve').delete().eq('user_id', ESSAI)
  const { data: reste } = await sb.from('canaux_releve')
    .select('user_id').eq('user_id', ESSAI)
  if (reste && reste.length) ratE('la ligne d\'essai n\'a pas ete nettoyee')
  else ok('ligne d\'essai nettoyee')

  console.log(ko ? `\n${ko} point(s) en echec.` : '\nMigration appliquee et prouvee.')
  process.exit(ko ? 1 : 0)
})().catch(e => { console.error('Erreur :', e.message); process.exit(2) })
