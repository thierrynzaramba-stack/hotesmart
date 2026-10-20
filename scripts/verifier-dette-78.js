#!/usr/bin/env node
// scripts/verifier-dette-78.js — la preuve avant/apres de la dette 78
// (20 octobre 2026, demande de Thierry). REVIEW.md regle 8.
//
// « Une nuit fermee n'est pas une nuit invendue. » `eclater` retire deja des
// nuits de REFERENCE celles qu'une exception ou une fermeture declaree couvre,
// et `calculerIndicateurs` divise `nuiteesRef` par `jours_ouverts` — mais
// AUCUN appelant ne passait `joursExclus` a `joursOuverts`. Le numerateur
// retirait, le denominateur gardait.
//
// CE QU'IL COMPARE, bien par bien et fenetre par fenetre, avec les fonctions de
// PRODUCTION : seule l'option `joursExclus` de `joursOuverts` change.
//   A (avant) : denominateur qui garde les jours declares fermes
//   B (apres) : denominateur qui les retire, comme le numerateur
//
// ⚠ CE QU'IL ASSERTE, et pas seulement affiche :
//   1. le NUMERATEUR est identique des deux cotes — seul le denominateur bouge ;
//   2. on ne retire jamais plus de jours qu'il n'y en a de declares fermes ;
//   3. la correction ne peut que FAIRE MONTER le taux, jamais le baisser ;
//   4. au moins une fenetre doit porter une fermeture declaree, sinon la preuve
//      est vide — un verificateur qui n'a rien lu doit echouer.
//
// Usage : node --env-file=.env.local   scripts/verifier-dette-78.js
//         node --env-file=.env.staging scripts/verifier-dette-78.js [debut] [fin]
//
// LECTURE SEULE : ce script n'ecrit rien.

// ⚠ LE GARDE D'ENVIRONNEMENT AVANT LES `require` APPLICATIFS : `lib/yield/*`
// et `api/*` construisent un client Supabase au CHARGEMENT. Sans cet ordre, un
// oubli de `--env-file` sort une pile Node de dix lignes au lieu du nom de la
// variable manquante.
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents. Passer --env-file.')
  process.exit(1)
}

const { createClient } = require('@supabase/supabase-js')
const { eclater, construirePontDemapped } = require('../lib/yield/eclatement')
const { calculerIndicateurs } = require('../lib/yield/indicateurs')
const { joursOuverts, lignesDuCalendrier, joursDeLaPeriode } = require('../lib/yield/capacite')
const { joursExclus, exceptionsDuBien } = require('../lib/yield/exceptions')

const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
const jourLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const ajouter = (j, n) => { const [a, m, d] = j.split('-').map(Number); return jourLocal(new Date(a, m - 1, d + n)) }
const pct = (x) => (x == null ? 'non calculable' : (x * 100).toFixed(1).replace('.', ',') + ' %')
const eur = (x) => (x == null ? 'non calculable' : x.toFixed(2).replace('.', ',') + ' €')

let echecs = 0
let avecFermeture = 0
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++ }

// Agrege la fenetre a partir des periodes rendues par le moteur. TO et RevPAR
// de la fenetre = somme des numerateurs / somme des jours ouverts, la formule
// de lib/yield/indicateurs.js.
function agreger (periodes) {
  let nuiteesRef = 0, caRef = 0, ouverts = 0, estimee = false, declaresFermes = 0
  for (const p of periodes) {
    declaresFermes += p.jours_estimes_fermes_par_exception || 0
    if (p.jours_ouverts == null) continue
    nuiteesRef += (p.nuitees || 0) - (p.nuitees_exclues_du_taux || 0)
    caRef += (p.ca || 0) - (p.ca_exclu_du_revpar || 0)
    ouverts += p.jours_ouverts
    if (p.capacite_estimee) estimee = true
  }
  return {
    to: ouverts > 0 ? nuiteesRef / ouverts : null,
    revpar: ouverts > 0 ? caRef / ouverts : null,
    nuiteesRef, caRef, ouverts, estimee, declaresFermes
  }
}

async function main () {
  const auj = jourLocal(new Date())
  const { data: biens, error: eB } = await sb.from('properties').select('*')
    .not('provider_property_id', 'is', null).order('name')
  if (eB) { console.error('Lecture des biens impossible :', eB.message); process.exit(1) }
  if (!biens || !biens.length) { console.error('ECHEC : aucun bien lu.'); process.exit(1) }

  const parCompte = {}
  for (const b of biens) (parCompte[b.user_id] = parCompte[b.user_id] || []).push(b)
  const compte = Object.keys(parCompte).sort((a, c) => parCompte[c].length - parCompte[a].length)[0]
  const lesSiens = parCompte[compte]
  console.log(`\nBase    : ${projet}`)
  console.log(`Compte  : ${compte.slice(0, 8)}, ${lesSiens.length} bien(s) raccorde(s)`)

  let lignes = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('bookings_snapshot')
      .select('user_id, booking_id, property_id, snapshot, raw')
      .eq('user_id', compte).order('booking_id').range(from, from + 999)
    if (error) throw new Error(`bookings_snapshot : ${error.message}`)
    lignes = lignes.concat(data || [])
    if (!data || data.length < 1000) break
  }

  // Les trois fenetres de la mesure du 20 octobre 2026, ou celle passee en
  // arguments. La troisieme est celle ou la dette MORD : le passe ancien, sans
  // memoire d'intention, ou la convention « un jour passe sans ligne est repute
  // ouvert » s'applique.
  const fenetres = process.argv[2] && process.argv[3]
    ? [{ nom: 'fenetre demandee', debut: process.argv[2], fin: process.argv[3] }]
    : [
      { nom: '30 derniers jours', debut: ajouter(auj, -30), fin: ajouter(auj, -1) },
      { nom: 'fermetures a venir (futur)', debut: auj, fin: ajouter(auj, 42) },
      { nom: 'passe ancien SANS memoire d intention', debut: ajouter(auj, -395), fin: ajouter(auj, -370) }
    ]

  for (const f of fenetres) {
    console.log(`\n── ${f.nom} : ${f.debut} -> ${f.fin} ──────────────────────`)
    const l = (s, n) => String(s).padEnd(n)
    console.log('  ' + l('bien', 22) + l('TO avant', 13) + l('TO apres', 13)
      + l('RevPAR avant', 15) + l('RevPAR apres', 15) + 'jours retires')
    for (const bien of lesSiens) {
      const { pont } = construirePontDemapped(lignes, bien.provider)
      const duBien = lignes.filter(x => x.property_id === bien.provider_property_id)
      const exceptions = await exceptionsDuBien(sb, bien.id, f.debut, f.fin)
      const exclus = await joursExclus(sb, bien.id, f.debut, f.fin, { exceptions })
      const eclatements = duBien.map(x => eclater(x, { pont, joursExclus: exclus, defaultProvider: bien.provider }))
      const jours = joursDeLaPeriode(f.debut, f.fin) || []
      const nbExclus = jours.filter(j => (exclus.has ? exclus.has(j) : !!exclus[j])).length
      if (nbExclus) avecFermeture++
      const lignesCal = await lignesDuCalendrier(sb, bien.id, f.debut, f.fin)

      const capa = new Map()
      const capb = new Map()
      for (const j of jours) {
        capa.set(j, await joursOuverts(sb, bien, j, j, { aujourdHui: auj, estimerLePasse: true, lignes: lignesCal }))
        capb.set(j, await joursOuverts(sb, bien, j, j, { aujourdHui: auj, estimerLePasse: true, lignes: lignesCal, joursExclus: exclus }))
      }
      const dans = (ps) => ps.filter(p => p.periode >= f.debut && p.periode <= f.fin)
      const A = agreger(dans(calculerIndicateurs(eclatements, { granularite: 'jour', capacites: capa, capacitePersonnes: bien.capacity })))
      const B = agreger(dans(calculerIndicateurs(eclatements, { granularite: 'jour', capacites: capb, capacitePersonnes: bien.capacity })))
      const retires = A.ouverts - B.ouverts

      // ⚠ LES ASSERTIONS, pas seulement l'affichage.
      if (A.nuiteesRef !== B.nuiteesRef || Math.abs(A.caRef - B.caRef) > 0.005) {
        ko(`${bien.name} / ${f.nom} : le NUMERATEUR a bouge (${A.nuiteesRef} -> ${B.nuiteesRef} nuitees,`
          + ` ${A.caRef.toFixed(2)} -> ${B.caRef.toFixed(2)} EUR) : seul le denominateur devait changer`)
      }
      if (retires < 0) ko(`${bien.name} / ${f.nom} : ${retires} jours retires, le denominateur a GRANDI`)
      if (retires > nbExclus) {
        ko(`${bien.name} / ${f.nom} : ${retires} jours retires pour ${nbExclus} declares fermes`)
      }
      if (retires > 0 && A.to != null && B.to != null && B.to < A.to) {
        ko(`${bien.name} / ${f.nom} : le taux BAISSE (${pct(A.to)} -> ${pct(B.to)})`)
      }
      if (retires > 0 && B.declaresFermes !== retires) {
        ko(`${bien.name} / ${f.nom} : ${retires} jours retires mais ${B.declaresFermes} annonces`
          + ' : le compte des jours fermes par declaration ne suit pas')
      }

      console.log('  ' + l(bien.name, 22) + l(pct(A.to), 13) + l(pct(B.to), 13)
        + l(eur(A.revpar), 15) + l(eur(B.revpar), 15)
        + `${retires} / ${A.ouverts} ouverts`
        + (nbExclus ? `  (${nbExclus} jour(s) declare(s) ferme(s))` : '')
        + (A.estimee || B.estimee ? '  [capacite ESTIMEE]' : ''))
    }
  }

  console.log('')
  if (!avecFermeture) {
    console.error('ECHEC : aucune fenetre ne porte de fermeture declaree.')
    console.error('Un avant/apres sur rien ne prouve rien. Choisir une fenetre qui en contient.')
    process.exit(1)
  }
  console.log(`${avecFermeture} couple(s) bien x fenetre portant au moins une fermeture declaree.`)
  if (echecs) { console.error(`\n${echecs} ECHEC(S). Le lot ne doit pas partir.`); process.exit(1) }
  console.log('AVANT/APRES CONFORME : le numerateur est intact, seul le denominateur retire les')
  console.log('jours declares fermes, et il ne retire jamais plus qu il n y en a de declares.')
}

main().catch(e => { console.error('Erreur :', e.message); process.exit(1) })
