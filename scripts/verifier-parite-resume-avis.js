#!/usr/bin/env node
// scripts/verifier-parite-resume-avis.js — prouver, sur les VRAIES donnees, que
// le resume rend les memes chiffres que le calcul d'aujourd'hui.
// Spec : docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md §10.3.
//
// Usage : node --env-file=.env.local scripts/verifier-parite-resume-avis.js
//         ... --compte <user_id>   pour un seul compte
//
// ⚠ LECTURE SEULE, ET C'EST TOUT SON INTERET : il tourne sur la PRODUCTION
// avant le merge, quand la table n'existe pas encore. Le writer est appele A
// BLANC (`aBlanc: true`) : il lit les avis et calcule les lignes, il n'ecrit
// rien et n'appelle pas la fonction SQL.
//
// Ce qu'il compare, pour chaque compte, chaque periode et chaque perimetre
// (le compte entier, puis chaque bien seul) :
//   · la SOMME des lignes que le resume ecrirait,
//   · contre `ratioProprete` (avis recus, pouces) et `notesDuPerimetre`
//     (nombre de notes, note sur 5) — les deux fonctions que la page appelle
//     aujourd'hui a chaque ouverture.
// Zero ecart exige avant de brancher l'ecran sur le resume. Une horloge unique
// (`maintenant`) pour tous les calculs : sinon un avis recu entre deux appels
// ferait un ecart qui n'en est pas un.
//
// ⚠ EMPREINTE EN TETE : la reference du projet Supabase (lib/empreinte-base.js).

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { calculerResumeAvis } = require('../lib/avis/resume')
const { ratioProprete, notesDuPerimetre, PERIODES } = require('../lib/stats-avis')
const { arrondiDixiemes } = require('../lib/avis/echelle')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const i = args.indexOf('--compte')
const COMPTE = i >= 0 ? args[i + 1] : null
if (i >= 0 && (!COMPTE || COMPTE.startsWith('--'))) { console.error('--compte attend une valeur.'); process.exit(1) }
const PAGE = 1000

async function lesComptes () {
  if (COMPTE) return [COMPTE]
  const comptes = new Set()
  let curseur = null
  for (;;) {
    let q = sb.from('properties').select('id, user_id')
      .not('provider_property_id', 'is', null)
      .order('id', { ascending: true }).limit(PAGE)
    if (curseur) q = q.gt('id', curseur)
    const { data, error } = await q
    if (error) { console.error('Biens illisibles :', error.message); process.exit(1) }
    for (const b of data || []) comptes.add(b.user_id)
    if (!data || data.length < PAGE) break
    curseur = data[data.length - 1].id
  }
  return [...comptes].sort()
}

;(async () => {
  const nom = nomDeLaBase(URL)
  console.log(`Base : ${refDuProjet(URL)} — ${nom}`)
  // Une mesure dont on ne sait pas de quelle base elle vient ne prouve rien.
  if (nom === 'INCONNUE') { console.error('Projet inconnu : arret.'); process.exit(1) }
  console.log('MODE : LECTURE SEULE (rien n’est écrit)\n')
  const maintenant = Date.now()
  const comptes = await lesComptes()
  let comparaisons = 0
  const ecarts = []
  for (const userId of comptes) {
    const r = await calculerResumeAvis(sb, { userId, maintenant, aBlanc: true, alarme: async () => {} })
    if (r.erreur) { ecarts.push(`${userId} : calcul impossible (${r.erreur})`); continue }
    if (r.incomplet) { ecarts.push(`${userId} : lecture incomplète`); continue }
    const refs = [...new Set(r.lignes.map(l => l.property_id_ref))].sort()
    for (const periode of Object.keys(PERIODES)) {
      for (const perimetre of [null, ...refs.map(x => [x])]) {
        const lignes = r.lignes.filter(l => l.periode === periode && (perimetre === null || perimetre.includes(l.property_id_ref)))
        const somme = (c) => lignes.reduce((s, l) => s + l[c], 0)
        const ratio = await ratioProprete(sb, { userId, periode, refs: perimetre, maintenant })
        const notes = await notesDuPerimetre(sb, { userId, periode, refs: perimetre, maintenant })
        const qui = `${userId} ${periode} ${perimetre ? perimetre[0] : 'compte entier'}`
        if (ratio.erreur || notes.erreur) { ecarts.push(`${qui} : le calcul d’aujourd’hui a échoué`); continue }
        const paires = [
          ['avis reçus', somme('total'), ratio.total],
          ['pouces haut', somme('positif'), ratio.positif],
          ['remarques', somme('remarque'), ratio.remarque],
          ['non évoquée', somme('rien_signale'), ratio.rien_signale],
          ['nombre de notes', somme('notes'), notes.global.notes],
          ['note sur 5', arrondiDixiemes(somme('notes_micro'), somme('notes')), notes.global.note_sur_5]
        ]
        for (const [quoi, resume, aujourdhui] of paires) {
          comparaisons++
          if (resume !== aujourdhui) ecarts.push(`${qui} — ${quoi} : résumé ${resume}, aujourd’hui ${aujourdhui}`)
        }
      }
    }
    const tout = r.lignes.filter(l => l.periode === 'toujours')
    console.log(`  ${userId} — ${refs.length} référence(s), ${tout.reduce((s, l) => s + l.total, 0)} avis au total`)
  }
  console.log(`\n${comptes.length} compte(s), ${comparaisons} comparaison(s), ${ecarts.length} écart(s)`)
  for (const e of ecarts) console.log(`  ÉCART  ${e}`)
  process.exit(ecarts.length ? 1 : 0)
})()
