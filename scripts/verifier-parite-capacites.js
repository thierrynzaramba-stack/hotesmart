#!/usr/bin/env node
// scripts/verifier-parite-capacites.js — lot 3 du chantier chargement
// (20 octobre 2026). REVIEW.md regle 8 : une optimisation ne vaut que si elle
// rend EXACTEMENT les memes chiffres.
//
// CE QU'IL COMPARE, sur les donnees reelles de la base visee, bien par bien :
//   ANCIEN : `joursOuverts` appelee UNE FOIS PAR PERIODE, chacune faisant sa
//            propre lecture de `calendar_inventory` — ce que faisait
//            api/yield.js jusqu'au 20 octobre 2026.
//   NOUVEAU : UNE lecture de la plage entiere, puis la meme `joursOuverts`
//            avec `options.lignes`.
//
// ⚠ LES PERIODES VIENNENT DE L'ENDPOINT, PAS D'UNE COPIE. `clesDePeriode` et
// `bornesDePeriode` sont importees de `api/yield.js` (`outilsPeriodes`), et
// `joursOuverts` de `lib/yield/capacite.js`. Les recopier ici aurait prouve la
// copie, pas le chemin.
//
// ⚠ CE QUI EST PROUVE EST LA PARITE, PAS LA FENETRE. Les deux fenetres jouees
// sont celles de l'accueil, parce que c'est la qu'on a mesure le cout ; mais la
// regle doit tenir pour n'importe quelle fenetre, et une divergence sur
// celles-ci suffirait a arreter le lot.
//
// Usage : node --env-file=.env.local   scripts/verifier-parite-capacites.js
//         node --env-file=.env.staging scripts/verifier-parite-capacites.js
//
// ⚠ EMPREINTE DE LA BASE EN TETE : un resultat qui ne dit pas OU il a ete
// obtenu ne prouve rien.
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER : zero periode comparee, ou
// zero ligne de calendrier vue, est un echec, pas un succes.
//
// LECTURE SEULE : ce script n'ecrit rien.

// ⚠ LE GARDE D'ENVIRONNEMENT PASSE AVANT LES `require` APPLICATIFS, et ce
// n'etait pas le cas : `require('../api/yield')` construit un client Supabase
// AU CHARGEMENT (via lib/require-permission.js), donc sept lignes avant ce
// controle. Lance sans `--env-file` — l'oubli que ce message existe pour
// rattraper — le script mourait sur « Error: supabaseUrl is required. » et dix
// lignes de pile pointant dans node_modules. Le product owner n'est pas
// developpeur : il recevait une trace Node a la place du nom de la variable
// manquante. Meme ordre que `scripts/prouver-lots-5-7-avis.js`, qui requiert
// son endpoint TARDIVEMENT.
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents. Passer --env-file.')
  process.exit(1)
}

const { createClient } = require('@supabase/supabase-js')
// ⚠ `lignesDuCalendrier` EST IMPORTEE, PAS RECOPIEE — et c'est le coeur de la
// preuve. La premiere version de ce script recopiait la lecture hissee de
// l'endpoint : il comparait donc SA copie au chemin par periode, et prouvait la
// parite de la copie. Une borne impossible, ou la perte de `property_id` dans
// la projection, auraient affecte les DEUX colonnes et le script aurait encore
// affiche « 0 divergence ».
const { joursOuverts, lignesDuCalendrier, estJourISO } = require('../lib/yield/capacite')
const { periodePrecedente } = require('../lib/yield/indicateurs')
const { clesDePeriode, bornesDePeriode } = require('../api/yield').outilsPeriodes
const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

let echecs = 0
let comparees = 0
let lignesVues = 0
let nonVerifiables = 0
// ⚠ `echecs` COMPTE TOUT, l'affichage seul est borne. La premiere version
// n'incrementait que sous `if (divergentes <= 3)` : 730 periodes divergentes
// auraient affiche « 30 DIVERGENCE(S) », un chiffre faux d'un facteur 24, et
// c'est ce chiffre qu'on recopie au commit et au KB. Regle du depot : une
// exemption se COMPTE, elle ne se decrit pas.
const ko = (m, afficher = true) => { if (afficher) console.error(`  ECHEC ${m}`); echecs++ }

const jourLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const ajouter = (j, n) => {
  const [a, m, d] = j.split('-').map(Number)
  return jourLocal(new Date(a, m - 1, d + n))
}

// Les memes `cles` que l'endpoint : les periodes visees, plus la precedente de
// chacune (c'est la comparaison N-1 qui les exige).
function clesCommeLEndpoint (debut, fin, granularite) {
  const visees = clesDePeriode(debut, fin, granularite)
  return [...new Set(visees.flatMap(c => {
    const prec = periodePrecedente(c)
    return prec ? [prec, c] : [c]
  }))].sort()
}

// La plage lue, exactement comme l'endpoint la calcule : les bornes de toutes
// les periodes, et le MEME filtre `estJourISO` — `periodePrecedente` fait de
// l'arithmetique de chaine et peut rendre un 29 fevrier d'annee non bissextile,
// que Postgres refuse.
async function lireLaPlage (bienId, cles) {
  const bornes = cles.map(bornesDePeriode)
    .filter(b => b && estJourISO(b[0]) && estJourISO(b[1]))
  if (!bornes.length) return []
  return lignesDuCalendrier(sb, bienId,
    bornes.map(b => b[0]).sort()[0],
    bornes.map(b => b[1]).sort().slice(-1)[0])
}

const chrono = async (f) => { const t = Date.now(); const r = await f(); return [Date.now() - t, r] }

async function main () {
  console.log(`\nBase      : ${projet}`)
  const { data: biens, error: eB } = await sb.from('properties').select('*')
    .not('provider_property_id', 'is', null).order('name')
  if (eB) { console.error('Lecture des biens impossible :', eB.message); process.exit(1) }
  if (!biens || !biens.length) { console.error('ECHEC : aucun bien lu.'); process.exit(1) }
  console.log(`Empreinte : ${biens.length} bien(s) raccorde(s).`)

  // ⚠ UNE SEULE HORLOGE, passee aux DEUX chemins : `joursOuverts` lit
  // `aujourdHui` pour decider ce qui est estimable. Deux horloges a quelques
  // secondes d'ecart suffiraient a inventer une divergence a minuit.
  const auj = jourLocal(new Date())
  // ⚠ LES FENETRES SONT NOMMEES PAR CE QU'ELLES SONT. La seconde etait
  // annoncee « celle du radar, douze mois » : elle joue 400 jours, soit
  // 14 mois et 26 periodes, mois COURANT inclus — alors que l'accueil demande
  // `douzeMoisComplets`, 12 mois et 24 periodes, mois courant EXCLU. Qui
  // voulait rejouer la mesure de la page croyait l'avoir fait.
  //
  // ⚠ ET LA TROISIEME EST A CHEVAL SUR AUJOURD'HUI, parce que c'est la que
  // l'asymetrie compte. Dans le PASSE, une ligne manquante devient « estime
  // ouvert » : le jour reste au denominateur, seul un drapeau bouge. Dans le
  // FUTUR, la meme ligne manquante devient `jours_fermes` avec
  // `calculable: true` et AUCUN drapeau — le « denominateur faux, credible et
  // muet » que le module dit refuser. Les deux premieres fenetres finissent
  // hier : la preuve avait ete faite la ou un manque est le moins visible.
  // Celle-ci est la fenetre de la vue « Pilotage » (mois courant -> +12 mois).
  const fenetres = [
    { nom: "accueil, 60 jours (jour)", debut: ajouter(auj, -60), fin: ajouter(auj, -1), granularite: 'jour' },
    { nom: '400 jours, 14 mois (mois) — PAS les 12 mois complets de la page',
      debut: ajouter(auj, -400), fin: ajouter(auj, -1), granularite: 'mois' },
    { nom: 'pilotage, A CHEVAL sur aujourd hui (mois)',
      debut: ajouter(auj, -30), fin: ajouter(auj, 330), granularite: 'mois' },
  ]

  let totalAncien = 0
  let totalNeuf = 0
  for (const f of fenetres) {
    const cles = clesCommeLEndpoint(f.debut, f.fin, f.granularite)
    console.log(`\n── ${f.nom} : ${cles.length} periode(s) ─────────────────`)
    for (const bien of biens) {
      // ANCIEN : une requete par periode.
      const [tAncien, ancien] = await chrono(async () => {
        const m = new Map()
        for (const cle of cles) {
          const b = bornesDePeriode(cle)
          if (!b) continue
          m.set(cle, await joursOuverts(sb, bien, b[0], b[1], { aujourdHui: auj, estimerLePasse: true }))
        }
        return m
      })
      // NOUVEAU : une lecture, puis le classement en memoire.
      const [tNeuf, neuf] = await chrono(async () => {
        const lignes = await lireLaPlage(bien.id, cles)
        lignesVues += lignes.length
        const m = new Map()
        m.lignes = lignes.length
        for (const cle of cles) {
          const b = bornesDePeriode(cle)
          if (!b) continue
          m.set(cle, await joursOuverts(sb, bien, b[0], b[1], { aujourdHui: auj, estimerLePasse: true, lignes }))
        }
        return m
      })
      totalAncien += tAncien
      totalNeuf += tNeuf

      let divergentes = 0
      for (const cle of cles) {
        const a = ancien.get(cle)
        const n = neuf.get(cle)
        // ⚠ UNE PAIRE OU LES DEUX COTES SONT ABSENTS N'EST PAS UNE COMPARAISON.
        // `JSON.stringify(undefined) !== JSON.stringify(undefined)` vaut FAUX,
        // donc elle passait pour « identique » et gonflait le compteur qui sert
        // de preuve de non-vacuite.
        if (a === undefined && n === undefined) continue
        comparees++
        if (JSON.stringify(a) !== JSON.stringify(n)) {
          divergentes++
          ko(`${bien.name} / ${cle} :\n      ancien  ${JSON.stringify(a)}\n      nouveau ${JSON.stringify(n)}`,
            divergentes <= 3)
        }
      }
      // ⚠ LA NON-VACUITE SE COMPTE PAR BIEN ET PAR FENETRE, pas globalement.
      // Un seul bien pourvu de lignes faisait passer le test pour tous les
      // autres — et le cas est le cas reel : le bien de test `colomier` n'a
      // AUCUNE ligne de calendrier, un bien Beds24 n'en a que quelques-unes.
      // Sur une fenetre passee, un bien sans ligne fait rendre aux DEUX chemins
      // le meme objet PAR CONSTRUCTION (`lignes = []` des deux cotes, donc la
      // meme estimation du passe) : « identiques » n'y prouve rien, et ses
      // periodes entraient quand meme dans le total cite au commit et au KB.
      const vues = neuf.lignes
      if (!vues) nonVerifiables++
      const verdict = divergentes ? `${divergentes} DIVERGENTE(S)`
        : vues ? 'identiques' : 'NON VERIFIABLE (aucune ligne de calendrier)'
      console.log(`  ${divergentes ? 'ECHEC' : vues ? 'ok   ' : 'note '} ${String(bien.name).padEnd(22)} ${verdict}`
        + `  ${String(tAncien).padStart(6)} ms -> ${String(tNeuf).padStart(5)} ms`)
    }
  }

  console.log(`\n${comparees} periode(s) comparee(s), ${lignesVues} ligne(s) de calendrier lue(s).`)
  if (nonVerifiables) {
    console.log(`${nonVerifiables} couple(s) bien x fenetre NON VERIFIABLE(S) : aucune ligne de`
      + ' calendrier, donc les deux chemins rendent le meme objet par construction.')
  }
  console.log(`Temps cumule : ancien ${totalAncien} ms, nouveau ${totalNeuf} ms`
    + ` (x${(totalAncien / Math.max(totalNeuf, 1)).toFixed(1)}).`)
  if (!comparees || !lignesVues) {
    console.error('\nECHEC : rien de compare, ou aucune ligne de calendrier lue.')
    console.error('Une parite entre deux vides ne prouve rien. Verifier la base visee.')
    process.exit(1)
  }
  if (echecs) {
    console.error(`\n${echecs} DIVERGENCE(S). Le lot ne doit pas partir.`)
    process.exit(1)
  }
  console.log('\nPARITE COMPLETE : une lecture unique classe exactement comme une lecture par periode.')
}

main().catch(e => { console.error('Erreur :', e.message); process.exit(1) })
