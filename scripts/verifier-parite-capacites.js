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

const { createClient } = require('@supabase/supabase-js')
const { joursOuverts } = require('../lib/yield/capacite')
const { periodePrecedente } = require('../lib/yield/indicateurs')
const { outilsPeriodes } = require('../api/yield')
const { clesDePeriode, bornesDePeriode } = outilsPeriodes

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents. Passer --env-file.')
  process.exit(1)
}
const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

let echecs = 0
let comparees = 0
let lignesVues = 0
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++ }

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

// La lecture hissee, a l'identique de celle que l'endpoint fait maintenant.
async function lireLaPlage (bienId, cles) {
  const bornes = cles.map(bornesDePeriode).filter(Boolean)
  if (!bornes.length) return []
  const spanDebut = bornes.map(b => b[0]).sort()[0]
  const spanFin = bornes.map(b => b[1]).sort().slice(-1)[0]
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('calendar_inventory')
      .select('date, stop_sell, avail, rate, property_id')
      .eq('property_id', bienId)
      .gte('date', spanDebut).lte('date', spanFin)
      .order('date').range(from, from + 999)
    if (error) throw new Error(`calendar_inventory : ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return out
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
  const fenetres = [
    // Celle de l'accueil : 60 jours, granularite jour.
    { nom: 'accueil, 60 jours (jour)', debut: ajouter(auj, -60), fin: ajouter(auj, -1), granularite: 'jour' },
    // Celle du radar : douze mois, granularite mois.
    { nom: 'radar, 12 mois (mois)', debut: ajouter(auj, -400), fin: ajouter(auj, -1), granularite: 'mois' },
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
        comparees++
        const a = ancien.get(cle)
        const n = neuf.get(cle)
        if (JSON.stringify(a) !== JSON.stringify(n)) {
          divergentes++
          if (divergentes <= 3) {
            ko(`${bien.name} / ${cle} :\n      ancien  ${JSON.stringify(a)}\n      nouveau ${JSON.stringify(n)}`)
          }
        }
      }
      const verdict = divergentes ? `${divergentes} DIVERGENTE(S)` : 'identiques'
      console.log(`  ${divergentes ? 'ECHEC' : 'ok   '} ${String(bien.name).padEnd(22)} ${verdict}`
        + `  ${String(tAncien).padStart(6)} ms -> ${String(tNeuf).padStart(5)} ms`)
    }
  }

  console.log(`\n${comparees} periode(s) comparee(s), ${lignesVues} ligne(s) de calendrier lue(s).`)
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
