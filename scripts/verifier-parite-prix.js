#!/usr/bin/env node
// scripts/verifier-parite-prix.js — lot V2.0.0 (chantier nouveau bien, §11).
// L'ECRAN ET LE MOTEUR DONNENT-ILS LE MEME PRIX ? Mesure de la dette 17.
//
// `api/yield-prix.js` (l'ecran « Prediction de prix ») garde sa propre
// assemblee de la matiere du prix ; le moteur passe par
// `lib/yield/contexte-du-bien.js` (`preparerContexte` → `prixDeLaNuit`). Les
// deux « suivent les memes constantes » : ce script le VERIFIE, nuit par nuit,
// sur la base visee, au lieu de le supposer.
//
// Usage :
//   node --env-file=.env.local scripts/verifier-parite-prix.js --bien=<uuid> [--bien=<uuid>] [--jours=365]
//
// ⚠ LECTURE SEULE. L'endpoint est appele tel quel, avec sa garde de droits
// SIMULEE (le script n'a pas de session) : il ne fait que lire. Le moteur est
// appele par ses fonctions pures de lecture ; ni canal, ni writer, ni marqueur.
//
// ⚠ LE MOTEUR EST APPELE COMME LE PILOTE L'APPELLE : UN contexte pour toute la
// fenetre [aujourd'hui, +N jours], et `ouverte: true` (le pilote ne tarife que
// des nuits ouvertes, et ouvre au prix calcule comme si la nuit l'etait).
// L'ecran, lui, est appele MOIS PAR MOIS, comme la page le fait. Une
// divergence de fenetre de contexte est donc mesuree, pas masquee : c'est
// precisement la dette 17.
//
// ⚠ ON NE COMPARE QUE CE QUI SE COMPARE : les nuits ou l'ecran calcule avec
// une nuit ouverte (ouverte ou projetee). Une nuit fermee, l'ecran la refuse
// et le moteur ne la tarife pas — pas de prix des deux cotes.
//
// ⚠ DEPUIS LE LOT V2.0.1, les deux chemins appellent la MEME assemblee
// (`preparerContexte`) et la MEME regle (`prixDeLaNuit`) : la comparaison des
// prix ne mesure plus que l'ecart de leurs FENETRES (contexte, mois de
// pression). C'est voulu : c'est la seule chose qui peut encore diverger. Le
// script compare en plus la GRILLE que l'ecran annonce a celle du moteur, et
// `--mois-extra=YYYY-MM,...` l'interroge sur des mois lointains (passes, ou a
// plus de 30 mois), la ou la fenetre de contexte de l'ecran est la plus longue
// — c'est la que la review du V2.0.1 a trouve des ponts disparus.
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT LE DIRE. Code de sortie : 0 = zero
// divergence, et au moins une nuit comparee POUR CHAQUE BIEN ; 3 =
// divergences ; 1 = lecture impossible, ou un bien sans aucune nuit comparee.

const path = require('path')
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]

const args = process.argv.slice(2)
const biens = args.filter(a => a.startsWith('--bien=')).map(a => a.slice(7)).filter(Boolean)
const jours = Number((args.find(a => a.startsWith('--jours=')) || '--jours=365').slice(8))
const moisExtra = ((args.find(a => a.startsWith('--mois-extra=')) || '').slice(13)).split(',').filter(m => /^\d{4}-\d{2}$/.test(m))
if (!biens.length || !Number.isInteger(jours) || jours < 1 || jours > 730) {
  console.error('Usage : --bien=<uuid> [--bien=<uuid>] [--jours=1..730]'); process.exit(1)
}

// La garde de l'endpoint, simulee : le script lit en service key, sans session.
// On la remplace AVANT de charger l'endpoint ; le reste du module est le vrai.
const cheminGarde = require.resolve(path.join(__dirname, '..', 'lib', 'require-permission'))
const vraieGarde = require(cheminGarde)
let compteCourant = null
require.cache[cheminGarde].exports = {
  ...vraieGarde,
  requirePermission: async (req, res, { bien }) => ({ ok: true, bien: { id: bien }, accountUserId: compteCourant, contexte: null })
}
const ecran = require(path.join(__dirname, '..', 'api', 'yield-prix'))
const { createClient } = require('@supabase/supabase-js')
const { preparerContexte, prixDeLaNuit } = require('../lib/yield/contexte-du-bien')
const sb = createClient(URL, KEY)

const pick = p => p ? { prix: p.prix, motif: p.motif_sans_prime, date: p.preuve_date } : null
const jourParis = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)
const decaler = (j, n) => { const d = new Date(`${j}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

function appelerEcran (bien, mois) {
  return new Promise((resolve) => {
    const res = { statut: 200, headers: {} }
    res.status = (c) => { res.statut = c; return res }
    res.setHeader = (k, v) => { res.headers[k] = v }
    res.json = (corps) => resolve({ statut: res.statut, corps })
    ecran({ method: 'GET', query: { property_id: bien, mois }, headers: {} }, res)
      .catch(e => resolve({ statut: 0, corps: { error: e.message } }))
  })
}

;(async () => {
  console.log(`Projet Supabase : ${projet} — lecture seule\n`)
  const auj = jourParis()
  const fin = decaler(auj, jours - 1)
  let compareesTotal = 0, divergencesTotal = 0, echec = false
  for (const id of biens) {
    const { data: bien, error } = await sb.from('properties').select('*').eq('id', id).maybeSingle()
    if (error || !bien) { console.error(`ECHEC : bien ${id} illisible — ${error ? error.message : 'introuvable'}`); echec = true; continue }
    compteCourant = bien.user_id
    console.log(`## ${bien.name} (${id}) — ${auj} → ${fin}`)

    // Le moteur : un contexte pour toute la fenetre, comme le pilote.
    let ctx
    try { ctx = await preparerContexte(sb, bien, bien.user_id, { aujourdHui: auj, debut: auj, fin }) }
    catch (e) { console.error(`ECHEC : matiere du moteur illisible — ${e.message}`); echec = true; continue }

    // L'ecran : mois par mois.
    const mois = []
    for (let m = auj.slice(0, 7); m <= fin.slice(0, 7); m = decaler(`${m}-01`, 32).slice(0, 7)) mois.push(m)
    const nuitsEcran = new Map()
    // La grille du moteur, telle qu'un ecran doit l'annoncer.
    const empreinteGrille = g => JSON.stringify({ niveaux: (g.base && g.base.niveaux || []).map(n => n.prix),
      positions: [...(g.positions instanceof Map ? g.positions : new Map(Object.entries(g.positions || {})))].map(([k, v]) => [k, v && v.indice]).sort() })
    const grilleMoteur = empreinteGrille(ctx.grille)
    let grillesDivergentes = 0
    for (const m of [...mois, ...moisExtra]) {
      const r = await appelerEcran(id, m)
      if (r.statut !== 200) { console.error(`ECHEC : ecran ${m} → HTTP ${r.statut} ${JSON.stringify(r.corps).slice(0, 200)}`); echec = true; continue }
      if (empreinteGrille(r.corps.grille || {}) !== grilleMoteur) {
        grillesDivergentes++
        console.log(`  ✖ grille de l'ecran (${m}) ≠ grille du moteur`)
      }
      if (moisExtra.includes(m) && !mois.includes(m)) continue
      for (const n of r.corps.nuits || []) if (n.date >= auj && n.date <= fin) nuitsEcran.set(n.date, n)
    }
    divergencesTotal += grillesDivergentes

    let comparees = 0
    const divergences = []
    const parCause = {}
    for (const [date, n] of nuitsEcran) {
      // L'ecran calcule « comme ouverte » : nuit ouverte, ou projection.
      if (!(n.ouverte === true || n.projection === true)) continue
      const m = prixDeLaNuit(ctx, date, { ouverte: true })
      comparees++
      const pE = n.suggestion == null ? null : Number(n.suggestion)
      const pM = m && m.prix != null ? Number(m.prix) : null
      const nE = n.niveau || null, nM = (m && (m.niveau_effectif || m.niveau)) || null
      const mE = [...(n.non_calculable || [])].sort().join(','), mM = [...((m && m.non_calculable) || [])].sort().join(',')
      let cause = null
      if ((pE == null) !== (pM == null)) cause = pE == null ? 'ecran sans prix, moteur avec' : 'moteur sans prix, ecran avec'
      else if (pE != null && Math.round(pE * 100) !== Math.round(pM * 100)) cause = 'prix different'
      else if (pE != null && nE !== nM) cause = 'meme prix, niveau different'
      else if (pE == null && mE !== mM) cause = 'sans prix des deux cotes, motifs differents'
      // La fourchette Exceptionnel (V2.0.7) : meme prix, mais la PREUVE et le
      // motif sans prime doivent etre les memes aussi (regle 18 : dire sur quoi
      // la mesure rassure — les prix seuls ne le disaient pas).
      else if (JSON.stringify(pick(n.prime_exceptionnel)) !== JSON.stringify(pick(m && m.prime_exceptionnel))) cause = 'meme prix, preuve ou motif de prime different'
      else if (JSON.stringify(pick(n.releve_n1)) !== JSON.stringify(pick(m && m.releve_n1))) cause = 'meme prix, releve N-1 (preuve, retrait ou plafond) different'
      if (cause) {
        parCause[cause] = (parCause[cause] || 0) + 1
        divergences.push({ date, cause, ecran: pE, moteur: pM, niveau_ecran: nE, niveau_moteur: nM, motifs_ecran: mE, motifs_moteur: mM })
      }
    }
    compareesTotal += comparees
    divergencesTotal += divergences.length
    if (!comparees) { console.error(`ECHEC : aucune nuit comparee pour ${bien.name} — ce bien n'a rien prouve.`); echec = true }
    console.log(`nuits lues a l'ecran ${nuitsEcran.size} · comparees (ouvertes ou projetees) ${comparees} · divergences ${divergences.length} · grilles divergentes ${grillesDivergentes} / ${mois.length + moisExtra.length} mois`)
    if (divergences.length) {
      console.log('par cause :', JSON.stringify(parCause))
      const ecarts = divergences.filter(d => d.ecran != null && d.moteur != null).map(d => d.moteur - d.ecran)
      if (ecarts.length) console.log(`ecart moteur − ecran : min ${Math.min(...ecarts).toFixed(2)} € · max ${Math.max(...ecarts).toFixed(2)} €`)
      const parMois = {}; for (const d of divergences) parMois[d.date.slice(0, 7)] = (parMois[d.date.slice(0, 7)] || 0) + 1
      console.log('par mois :', JSON.stringify(parMois))
      for (const d of divergences.slice(0, 12)) console.log('  ', JSON.stringify(d))
    }
    console.log('')
  }
  if (echec) { console.error('Mesure INCOMPLETE : au moins une lecture a echoue.'); process.exit(1) }
  if (!compareesTotal) { console.error('ECHEC : aucune nuit comparee — rien n a ete verifie.'); process.exit(1) }
  console.log(divergencesTotal ? `DIVERGENCES : ${divergencesTotal} nuit(s) sur ${compareesTotal}.` : `OK : 0 divergence sur ${compareesTotal} nuit(s).`)
  process.exit(divergencesTotal ? 3 : 0)
})()
