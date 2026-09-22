#!/usr/bin/env node
// scripts/piloter-yieldflow.js — lots 4.6.3 a 4.6.5.
// Fait tourner le PILOTE QUOTIDIEN (lib/pilote-quotidien.js : ouverture puis
// prix, alarmes) sur la base visee, comme le cron le fait en prod — utile sur
// staging, ou AUCUN cron n'est planifie (docs/STAGING.md §1), et en recette.
//
// Usage :
//   node --env-file=.env.staging scripts/piloter-yieldflow.js            (dry-run)
//   node --env-file=.env.staging scripts/piloter-yieldflow.js --go       (ecrit)
//   ... --bien=<uuid>   (un seul bien)   --jour=YYYY-MM-DD   (horloge injectee)
//
// Le dry-run dit, par bien : ce que l'ouverture ferait, et ce que la regle
// des prix dirait de chaque nuit ouverte (changes, inchanges, non calculables
// et leurs motifs). `--go` fait le passage complet et pose le marqueur.
//
// ⚠ DRY-RUN PAR DEFAUT. Le moteur ecrit par le canal interne, donc par le
// writer : plancher, journal des prix, poussee ARI si le bien est relie. Un
// « --go » sur la prod est un geste de production.
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT LE DIRE : zero bien pilote avec
// fenetre est un compte rendu, une lecture en echec est une sortie 1.

const { createClient } = require('@supabase/supabase-js')
const { nuitsAOuvrir, PREFIXE_MARQUEUR } = require('../lib/moteur-ouverture')
const { calculerPrix } = require('../lib/moteur-prix')
const { piloterLesBiens } = require('../lib/pilote-quotidien')
const { preparerContexte, prixDeLaNuit } = require('../lib/yield/contexte-du-bien')
const { fermeturesDuBien } = require('../lib/fermetures')
const { prixHoteDuBien } = require('../lib/prix-hote')
const { finDeFenetre } = require('../lib/pilote-tarifaire')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
const args = process.argv.slice(2)
const GO = args.includes('--go')
const bienVoulu = (args.find(a => a.startsWith('--bien=')) || '').slice(7) || null
const jour = (args.find(a => a.startsWith('--jour=')) || '').slice(7) || null
// ⚠ DEUX GARDES — relevees en review. `--go` sur la PROD exige `--prod` (le
// cron y tourne deja, un passage manuel est un geste de production). Et
// `--go` avec `--jour` est refuse : le marqueur serait pose a la date REELLE
// pour un travail fait a une date injectee, et le cron sauterait le bien.
if (GO && jour) { console.error('REFUS : --go et --jour ensemble poseraient un marqueur faux. Le dry-run accepte --jour.'); process.exit(1) }
if (GO && projet === 'cjmrizpdyhrcurmgyrhs' && !args.includes('--prod')) { console.error('REFUS : --go sur la PRODUCTION exige --prod (le cron y tourne deja).'); process.exit(1) }

// Le client canal : meme fonction que le fullsync et le cron. Sans variables
// CHANNEL_* (un poste qui n'a que la base), on fournit un client qui REFUSE
// honnetement : le canal exige un client pour tout bien Channex (precondition
// du 4.6.1), le writer ne l'appelle que si le bien porte des ids de canal —
// un bien de recette sans mapping reste « HoteSmart seulement » et s'ouvre ;
// un bien reellement relie verrait sa poussee refusee, donc un full sync en
// file et pas de marqueur : rien n'est ouvert en memoire sans que ce soit dit.
let appel
if (process.env.CHANNEL_BASE_URL && process.env.CHANNEL_API_KEY) {
  appel = require('../lib/channel-fullsync').channelCall
} else {
  console.log('⚠ CHANNEL_* absents : client canal de refus (les biens sans mapping s ouvrent en local, les biens relies partent en full sync).\n')
  appel = async (method, path) => ({ ok: false, status: 0, json: { error: `client canal absent (script sans CHANNEL_*) : ${method} ${path} non envoye` } })
}

;(async () => {
  console.log(`Projet Supabase : ${projet} — ${GO ? 'ECRITURE (--go)' : 'dry-run'}${jour ? ` — jour ${jour}` : ''}\n`)
  let q = sb.from('properties').select('*').eq('pilote_tarifaire', 'yieldflow')
    .not('pilote_fenetre_type', 'is', null).not('pilote_fenetre_valeur', 'is', null).order('name')
  if (bienVoulu) q = q.eq('id', bienVoulu)
  const { data: biens, error } = await q
  if (error) { console.error('ECHEC lecture des biens :', error.message); process.exit(1) }
  if (!biens || !biens.length) { console.log('Aucun bien pilote par YieldFlow avec une fenetre reglee : rien a ouvrir.'); return }
  const auj = jour || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())

  for (const bien of biens) {
    const fin = finDeFenetre(bien, auj)
    const fermetures = await fermeturesDuBien(sb, bien.id, auj, fin)
    const { data: lignes, error: eL } = await sb.from('calendar_inventory').select('date, rate, avail, stop_sell')
      .eq('property_id', bien.id).gte('date', auj).lte('date', fin).limit(2000)
    if (eL) { console.error(`ECHEC lecture memoire ${bien.name} :`, eL.message); process.exit(1) }
    // La matiere, pour dire ce que la regle ferait — lecture seule.
    let ctx = null, prixCalcule = new Map(), erreurCtx = null
    try {
      ctx = await preparerContexte(sb, bien, bien.user_id, { aujourdHui: auj, debut: auj, fin })
      for (let j = auj; j <= fin; j = new Date(Date.parse(j + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) {
        const s = prixDeLaNuit(ctx, j, { ouverte: true }); if (s && s.prix != null) prixCalcule.set(j, Math.round(s.prix * 100))
      }
    } catch (e) { erreurCtx = e.message }
    const prixHote = await prixHoteDuBien(sb, bien.id, auj, fin)
    const d = nuitsAOuvrir({ bien, aujourdHui: auj, lignes: lignes || [], fermetures, prixCalcule, prixHote })
    const { data: m } = await sb.from('cron_logs').select('last_run, errors').eq('id', PREFIXE_MARQUEUR + bien.id).maybeSingle()
    console.log(`${bien.name} — fenetre ${bien.pilote_fenetre_valeur} ${bien.pilote_fenetre_type}, jusqu'au ${fin}`)
    console.log(`  OUVERTURE : a ouvrir ${d.comptes.a_ouvrir} · deja ouvertes ${d.comptes.deja_ouvertes} · indisponibilites ${d.comptes.fermees_par_l_hote} · intention existante ${d.comptes.intention_existante} · sans prix ${d.comptes.sans_prix} · sous plancher ${d.comptes.sous_plancher}`)
    if (ctx) {
      const p = calculerPrix({ aujourdHui: auj, fin, lignes: lignes || [], fermetures, prixHote, prix: (date, o) => prixDeLaNuit(ctx, date, o) })
      if (prixHote.size) console.log(`  main de l'hote : ${prixHote.size} nuit(s) tenue(s), jamais recalculees`)
      console.log(`  PRIX (nuits ouvertes) : calculables ${p.comptes.calculees} (a changer ${p.comptes.changees}, inchanges ${p.comptes.inchangees}) · non calculables ${p.comptes.non_calculables} · sous plancher ${p.comptes.sous_plancher} · vendues ${p.comptes.vendues} · fermees ${p.comptes.fermees}`)
      if (Object.keys(p.motifs).length) console.log(`  motifs : ${Object.entries(p.motifs).map(([k, v]) => `${k} ×${v}`).join(', ')}`)
      if (p.changements.length) console.log(`  exemples : ${p.changements.slice(0, 5).map(c => `${c.date} ${c.avant_centimes == null ? '—' : (c.avant_centimes / 100) + ' €'} → ${c.prix_centimes / 100} €`).join(' · ')}`)
      console.log(`  grille : ${ctx.grille && ctx.grille.base ? (ctx.grille.base.fiable ? `fiable (${ctx.grille.base.echantillon} nuits, ${ctx.grille.base.reservations} resas)` : `NON FIABLE (${ctx.grille.base.echantillon || 0} nuits)`) : 'absente'}`)
    } else console.log(`  PRIX : matiere illisible — ${erreurCtx}`)
    console.log(`  dernier passage du pilote : ${m && m.last_run ? m.last_run : 'jamais'}`)
  }

  if (!GO) { console.log('\nDry-run : rien n a ete ecrit. Relancer avec --go pour ouvrir.'); return }
  // Tous les biens en un passage (le cron en fait un par tick) ; les alarmes
  // partent au fondateur comme en prod (reportIncident), on le dit.
  console.log('\n⚠ Les alarmes partent au fondateur comme en production.')
  const bilan = await piloterLesBiens(sb, { appel, aujourdHui: auj, biensParPassage: 50, budgetMs: 120000 })
  console.log('\nBilan :', JSON.stringify({ jour: bilan.jour, biens: bilan.biens, traites: bilan.traites, ouvertes: bilan.ouvertes, prix_changes: bilan.prix_changes, sautes: bilan.sautes, reportes: bilan.reportes, erreurs: bilan.erreurs, alarmes: bilan.alarmes, retards: bilan.retards }))
  for (const d of bilan.details) {
    const o = d.ouverture || {}, p = d.prix || {}
    console.log(`  ${d.nom} : ouverture ${o.ok ? `${o.ouvertes} nuit(s)` : `REFUS ${o.refus} — ${o.message}`} · prix ${p.ok ? `${p.changees} changé(s)` : `REFUS ${p.refus} — ${p.message}`}`)
  }
  if (bilan.erreurs.length) process.exit(1)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
