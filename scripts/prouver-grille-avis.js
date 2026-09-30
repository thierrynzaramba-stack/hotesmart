#!/usr/bin/env node
// scripts/prouver-grille-avis.js
//
// LES REGLES DE LA GRILLE TIENNENT-ELLES VRAIMENT EN BASE ?
// Spec docs/specs/spec-evaluation-voyageur.md §4.2 et §7 bis.
//
// La spec justifie deux tables plutot qu'un jsonb par un seul argument : les
// regles que l'hote ne peut pas defaire doivent tenir EN BASE, donc etre vraies
// meme si un bug, un import ou un lot futur ecrit directement. Cet argument ne
// vaut que si on le VERIFIE : ce script ecrit des grilles invalides et exige que
// la base les refuse.
//
// Usage : node --env-file=.env.staging scripts/prouver-grille-avis.js
//
// ⚠ STAGING UNIQUEMENT, ET IL LE VERIFIE (empreinte 3 biens). Il ECRIT, puis
// NETTOIE dans un `finally`, et RELIT pour le prouver.
//
// ⚠ UN REFUS DOIT PORTER LE BON CODE. Une insertion refusee parce qu'une
// colonne obligatoire manque (23502) ne prouve rien sur la contrainte qu'on
// teste : on exige 23514 (check) ou 23503 (cle etrangere), et on nomme le reste.
const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })

let echecs = 0
const ok = (m) => console.log(`  ok    ${m}`)
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++; process.exitCode = 1 }

;(async () => {
  const { count: biens } = await sb.from('properties').select('*', { count: 'exact', head: true })
  const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
  console.log(`Projet : ${projet}`)
  console.log(`Empreinte : ${biens} bien(s)\n`)
  // ⚠ DEUX EMPREINTES, PAS UNE. Le nombre de biens est une donnee metier
  // MUTABLE : le jour ou staging en gagne un quatrieme, un comptage seul
  // bloquerait le script legitime, et le jour ou une autre base en compte
  // trois, il ecrirait dedans. La reference du projet, elle, ne bouge pas.
  // Constat de review.
  const PROJET_STAGING = 'ortyofzzdsthlhqmzsnq'
  if (projet !== PROJET_STAGING) {
    console.error(`ECHEC : ce script ECRIT. Il ne tourne que sur STAGING (${PROJET_STAGING}), et SUPABASE_URL pointe sur « ${projet} ».`)
    process.exit(1)
  }
  if (biens !== 3) { console.error('ECHEC : projet de staging reconnu, mais 3 biens attendus. La base a change : relis la garde avant de forcer.'); process.exit(1) }

  const aNettoyer = []
  try {
    const { data: prop } = await sb.from('properties').select('user_id').limit(1).single()
    const compte = prop.user_id

    // Un critere note, pour y accrocher des niveaux.
    const { data: crit, error: eC } = await sb.from('avis_criteres')
      .insert({ user_id: compte, libelle: 'PREUVE — propreté', categorie: 'cleanliness', rempli_par: 'hote', rang: 99 })
      .select().single()
    if (eC) { ko(`critere de preuve impossible : ${eC.message}`); return }
    aNettoyer.push(crit.id)
    ok('critere de preuve cree (categorie notee)')

    const { data: critReco, error: eR } = await sb.from('avis_criteres')
      .insert({ user_id: compte, libelle: 'PREUVE — recommandation', categorie: 'recommandation', rempli_par: 'hote', rang: 98 })
      .select().single()
    if (eR) { ko(`critere recommandation impossible : ${eR.message}`); return }
    aNettoyer.push(critReco.id)

    // Chaque cas : ce qu'on insere, et le code de refus attendu.
    const CAS = [
      ['une note 1 SANS drapeau negatif',
       { critere_id: crit.id, categorie: 'cleanliness', cle: 'a', libelle: 'A', rang: 1, note: 1, negatif: false }, 'avis_niveaux_un_est_negatif'],
      ['un refus de recommander SANS drapeau negatif',
       { critere_id: critReco.id, categorie: 'recommandation', cle: 'b', libelle: 'B', rang: 1, note: null, recommande: false, negatif: false }, 'avis_niveaux_refus_est_negatif'],
      ['une note hors 1-5',
       { critere_id: crit.id, categorie: 'cleanliness', cle: 'c', libelle: 'C', rang: 1, note: 9, negatif: false }, 'avis_niveaux_forme_par_categorie'],
      ['une categorie notee SANS note',
       { critere_id: crit.id, categorie: 'cleanliness', cle: 'd', libelle: 'D', rang: 1, note: null, negatif: false }, 'avis_niveaux_forme_par_categorie'],
      ['une categorie notee qui porte « recommande »',
       { critere_id: crit.id, categorie: 'cleanliness', cle: 'e', libelle: 'E', rang: 1, note: 5, recommande: true, negatif: false }, 'avis_niveaux_forme_par_categorie'],
      ['« recommandation » qui porte une note',
       { critere_id: critReco.id, categorie: 'recommandation', cle: 'f', libelle: 'F', rang: 1, note: 5, recommande: true, negatif: false }, 'avis_niveaux_forme_par_categorie'],
      ['une categorie qui CONTREDIT celle du critere',
       { critere_id: crit.id, categorie: 'communication', cle: 'g', libelle: 'G', rang: 1, note: 5, negatif: false }, 'avis_niveaux_categorie_fk'],
    ]
    // ⚠ LA CLASSE D'ERREUR NE SUFFIT PAS, LE NOM NON PLUS N'EST PAS OPTIONNEL.
    // Un 23514 prouve qu'« une » contrainte a parle, pas que c'est CELLE qu'on
    // teste : la contrainte ajoutee demain rendrait un controle vert pour la
    // mauvaise raison. Postgres met le nom dans le message ; on l'exige.
    const ATTENDUS = new Set(['23514', '23503'])
    for (const [quoi, ligne, contrainte] of CAS) {
      const { data, error } = await sb.from('avis_criteres_niveaux').insert(ligne).select()
      if (!error) {
        ko(`${quoi} : ACCEPTEE par la base — la regle ne tient pas`)
        if (data && data[0]) await sb.from('avis_criteres_niveaux').delete().eq('id', data[0].id)
        continue
      }
      const code = String(error.code || '')
      const texte = `${error.message || ''} ${error.details || ''}`
      if (!ATTENDUS.has(code)) {
        ko(`${quoi} : refusee pour une AUTRE raison (${code}) — ${String(error.message).slice(0, 60)}`)
      } else if (contrainte && !texte.includes(contrainte)) {
        ko(`${quoi} : refusee (${code}) mais par « ${String(texte).slice(0, 70)} », pas par ${contrainte}`)
      } else {
        ok(`${quoi} : refusee par ${contrainte} (${code})`)
      }
    }

    // Et le chemin normal passe : sans quoi on aurait prouve une base bloquee,
    // pas une base qui protege.
    const { error: eOk } = await sb.from('avis_criteres_niveaux')
      .insert({ critere_id: crit.id, categorie: 'cleanliness', cle: 'valide', libelle: 'Valide', rang: 1, note: 5, negatif: false })
    eOk ? ko(`un niveau VALIDE est refuse : ${eOk.message}`) : ok('un niveau valide passe — la base protege, elle ne bloque pas')

    const { error: eNeg } = await sb.from('avis_criteres_niveaux')
      .insert({ critere_id: crit.id, categorie: 'cleanliness', cle: 'pire', libelle: 'Pire', rang: 2, note: 1, negatif: true })
    eNeg ? ko(`une note 1 AVEC drapeau est refusee : ${eNeg.message}`) : ok('une note 1 avec son drapeau passe')
  } finally {
    let reste = 0
    for (const id of aNettoyer) {
      // Les niveaux partent en cascade avec leur critere.
      const { error } = await sb.from('avis_criteres').delete().eq('id', id)
      if (error) reste++
    }
    // ⚠ `error` SE LIT. Un comptage tete seule qui echoue rend { count: null,
    // error: <...> } : sans cette lecture, « je n ai rien pu lire » devenait
    // « il ne reste rien ». C'est le faux vert exact que
    // scripts/verifier-avis-evaluation.js documente, et que ce script avait
    // reintroduit. Constat de review.
    const { count, error } = await sb.from('avis_criteres')
      .select('*', { count: 'exact', head: true }).like('libelle', 'PREUVE%')
    if (error) ko(`nettoyage invérifiable : ${error.message}`)
    else console.log(`\nNettoyage : ${reste} erreur(s) · ${count || 0} critere(s) de preuve restant(s)`)

    // ⚠ CE QUI RESTE EN BASE N'EST PAS UN DECHET INERTE. Les criteres
    // « PREUVE — … » portent property_id nul : ils forment une GRILLE DE
    // COMPTE reelle. Laisses en place, `grilleDe` cesserait de rendre la grille
    // par defaut pour ce compte, et toutes les evaluations staging suivantes
    // seraient notees sur un decor de test.
    if (reste || count) ko('le decor de test n a pas ete entierement retire')
  }

  // ⚠ `ko()` INCREMENTE `echecs`, DONC LE BILAN NE PEUT PLUS MENTIR. La version
  // precedente posait process.exitCode dans le finally sans toucher `echecs` :
  // le script imprimait « ECHEC ... » puis « OK ... » en derniere ligne, et
  // c'est la derniere ligne que l'humain lit. Constat de review.
  if (echecs) { console.error(`\nECHEC : ${echecs} controle(s) en defaut.`); process.exit(1) }
  console.log('\nOK : les regles de la grille tiennent EN BASE, pas seulement dans le code.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
