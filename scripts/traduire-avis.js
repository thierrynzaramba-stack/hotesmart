#!/usr/bin/env node
// scripts/traduire-avis.js — traduire l'HISTORIQUE des avis, une fois.
// Spec : docs/specs/avis-v5/spec-traduction-avis.md §3.6 (Q5 = A, decision de
// Thierry du 11 novembre 2026 : l'historique se traduit en une fois, par ce
// script, lance par lui apres la mise en production).
//
// Usage : node --env-file=<fichier d'env> scripts/traduire-avis.js            (a blanc)
//         node --env-file=<fichier d'env> scripts/traduire-avis.js --go       (traduit)
//         ... --max N   borne le nombre d'avis traduits (defaut et plafond : 800)
//
// ⚠ A BLANC PAR DEFAUT : la sortie dit combien d'avis sont a traduire, donc
//   combien d'appels a l'IA, et le cout estime. Rien n'est appele.
// ⚠ LE MEME WRITER ET LA MEME FILE QUE LE CRON (`avis_a_traduire`,
//   `traduireLigne`, `ecrireResultat`), jamais une copie.
// ⚠ IL NE CONSOMME PAS LE PLAFOND DU JOUR DU CRON : c'est une depense a part,
//   decidee a part, et bornee par --max.
// ⚠ LE CLIENT IA PARTAGE (lib/cron-shared.js) : chaque appel est journalise
//   dans `ia_appels`, comme ceux du cron.
// ⚠ EMPREINTE EN TETE : la reference du projet Supabase (lib/empreinte-base.js).

const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }

const args = process.argv.slice(2)
const PLAFOND = 800
const valeur = (nom) => {
  const i = args.indexOf(nom)
  if (i < 0) return null
  const v = args[i + 1]
  if (!v || v.startsWith('--')) { console.error(`${nom} attend une valeur.`); process.exit(1) }
  return v
}
const ECRIRE = args.includes('--go')
const MAX = (() => {
  const v = valeur('--max')
  if (v == null) return PLAFOND
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > PLAFOND) { console.error(`--max : un entier de 1 a ${PLAFOND}.`); process.exit(1) }
  return n
})()
// ≈ 0,3 centime par avis (Haiku 4.5, mesure de la spec §3.6) : une ESTIMATION,
// le cout reel se lit dans `ia_appels`.
const COUT_ESTIME_PAR_APPEL_EUR = 0.003
const LOT = 20

;(async () => {
  const nom = nomDeLaBase(URL)
  console.log(`Base : ${refDuProjet(URL)} — ${nom}`)
  if (nom === 'INCONNUE') { console.error('Projet inconnu : arret.'); process.exit(1) }
  if (ECRIRE && !process.env.CLAUDE_API_KEY) { console.error('CLAUDE_API_KEY absente : arret.'); process.exit(1) }
  console.log(ECRIRE ? `MODE : TRADUCTION (--go), ${MAX} avis au plus` : 'MODE : A BLANC (rien n’est appele ; --go pour traduire)')

  const { supabase: sb } = require('../lib/cron-shared')
  const traduction = require('../lib/avis/traduction')
  const maintenant = Date.now()
  // Le script n'attend pas l'apres-echec des 24 h : un avis en echec AVANT son
  // lancement est retente. Un avis en echec PENDANT ce lancement ne repasse pas
  // (son echec est posterieur a `maintenant`), sinon la file le rendrait a
  // chaque lot.
  const parametres = (limite) => ({
    p_limite: limite,
    p_classe_avant: new Date(maintenant - 48 * 3600 * 1000).toISOString(),
    p_echec_avant: new Date(maintenant).toISOString()
  })

  if (!ECRIRE) {
    const { data, error } = await sb.rpc('avis_a_traduire', parametres(1000))
    if (error) {
      console.error(traduction.migrationAbsente(error) ? 'Migration 2026-11-11-avis-traductions absente : arret.' : 'File illisible : ' + error.message)
      process.exit(1)
    }
    const n = (data || []).length
    const appels = Math.min(n, MAX)
    console.log(`\n${n >= 1000 ? 'au moins ' : ''}${n} avis a traduire ; avec --go : ${appels} appel(s) a l'IA, `
      + `cout estime ≈ ${(appels * COUT_ESTIME_PAR_APPEL_EUR).toFixed(2)} €`)
    process.exit(0)
  }

  const bilan = { traduits: 0, echecs: 0, appels: 0 }
  const motifs = {}
  const vus = new Set()
  while (bilan.appels < MAX) {
    const demande = Math.min(LOT, MAX - bilan.appels)
    const { data, error } = await sb.rpc('avis_a_traduire', parametres(demande))
    if (error) { console.error('File illisible : ' + error.message); process.exit(1) }
    // Un avis deja tente dans CE lancement ne repasse pas : un echec garde son
    // empreinte, et la file le rendrait encore.
    const lignes = (data || []).filter(l => !vus.has(l.id))
    if (!lignes.length) break
    for (const ligne of lignes) {
      if (bilan.appels >= MAX) break
      vus.add(ligne.id)
      const r = await traduction.traduireLigne(ligne)
      if (r.appel !== false) bilan.appels++
      if (r.ok) bilan.traduits++
      else { bilan.echecs++; motifs[r.motif] = (motifs[r.motif] || 0) + 1 }
      const err = await traduction.ecrireResultat(sb, ligne, r)
      if (err) { console.error(`  ecriture ${ligne.id} : ${err.message}`); process.exit(1) }
    }
    console.log(`  … ${bilan.traduits} traduit(s), ${bilan.echecs} echec(s), ${bilan.appels} appel(s)`)
    if ((data || []).length < demande) break
  }
  console.log(`\n${bilan.traduits} traduit(s), ${bilan.echecs} echec(s), ${bilan.appels} appel(s) a l'IA`
    + (Object.keys(motifs).length ? ` — motifs : ${JSON.stringify(motifs)}` : ''))
})().catch(e => { console.error(e && e.message || e); process.exit(1) })
