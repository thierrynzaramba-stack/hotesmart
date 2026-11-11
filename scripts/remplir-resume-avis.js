#!/usr/bin/env node
// scripts/remplir-resume-avis.js — calculer a la main les trois chiffres de la
// page Avis (`resume_bien_avis`), compte par compte.
// Spec : docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md §10.4.
//
// Usage : node --env-file=.env.staging scripts/remplir-resume-avis.js            (a blanc)
//         node --env-file=.env.staging scripts/remplir-resume-avis.js --go       (ecrit)
//         ... --compte <user_id>   pour un seul compte
//
// Pourquoi. En production, le cron calcule a 06:00 et 18:00, et le premier tick
// apres le collage de la migration remplit tout. STAGING N'A PAS DE CRON
// (docs/STAGING.md §1) : sans ce script, la recette verrait « Les chiffres
// n'ont pas encore ete calcules » jusqu'a la fin des temps.
//
// ⚠ A BLANC PAR DEFAUT : la sortie dit, compte par compte, ce qui serait ecrit.
// ⚠ LE MEME WRITER QUE LE CRON ET QUE LA PAGE (`calculerResumeAvis`), jamais une
// copie : un script qui calculerait a sa facon ecrirait des chiffres que rien
// d'autre ne produit.
// ⚠ PAGINE PAR CURSEUR : PostgREST rend 1000 lignes sans erreur.
// ⚠ EMPREINTE EN TETE : la reference du projet Supabase (lib/empreinte-base.js).

const { createClient } = require('@supabase/supabase-js')
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { calculerResumeAvis } = require('../lib/avis/resume')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const valeur = (nom) => {
  const i = args.indexOf(nom)
  if (i < 0) return null
  const v = args[i + 1]
  if (!v || v.startsWith('--')) { console.error(`${nom} attend une valeur.`); process.exit(1) }
  return v
}
const ECRIRE = args.includes('--go')
const COMPTE = valeur('--compte')
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
  if (nom === 'INCONNUE') { console.error('Projet inconnu : arret.'); process.exit(1) }
  console.log(ECRIRE ? 'MODE : ECRITURE (--go)' : 'MODE : A BLANC (rien n’est ecrit ; --go pour ecrire)')

  const comptes = await lesComptes()
  console.log(`${comptes.length} compte(s)\n`)
  const bilan = { ecrits: 0, a_blanc: 0, perimes: 0, incomplets: 0, erreurs: 0 }
  for (const userId of comptes) {
    const r = await calculerResumeAvis(sb, { userId, aBlanc: !ECRIRE })
    const tout = (r.lignes || []).filter(l => l.periode === 'toujours')
    const somme = (c) => tout.reduce((s, l) => s + (l[c] || 0), 0)
    const resume = `${tout.length} bien(s), ${somme('total')} avis, ${somme('notes')} note(s), `
      + `${somme('positif')} pouce(s) haut, ${somme('remarque')} remarque(s)`
    if (r.erreur) { bilan.erreurs++; console.error(`  ERREUR   ${userId} — ${r.erreur}`); continue }
    if (r.incomplet) bilan.incomplets++
    if (r.aBlanc) { bilan.a_blanc++; console.log(`  à écrire ${userId} — ${resume}${r.incomplet ? ' — LECTURE INCOMPLETE' : ''}`) }
    else if (r.ecrit) { bilan.ecrits++; console.log(`  écrit    ${userId} — ${resume}${r.incomplet ? ' — LECTURE INCOMPLETE' : ''}`) }
    else if (r.motif === 'perime') { bilan.perimes++; console.log(`  laissé   ${userId} — un calcul plus récent existe déjà`) }
    else { bilan.erreurs++; console.error(`  REFUSE   ${userId} — ${r.motif || 'motif inconnu'}`) }
  }
  console.log(`\n${ECRIRE ? `${bilan.ecrits} écrit(s)` : `${bilan.a_blanc} à écrire`}, ${bilan.perimes} laissé(s), `
    + `${bilan.incomplets} incomplet(s), ${bilan.erreurs} erreur(s)`)
  process.exit(bilan.erreurs ? 1 : 0)
})()
