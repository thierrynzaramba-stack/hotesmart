#!/usr/bin/env node
// scripts/mesurer-prix-hors-taxe.js — taxe de sejour, lot 2
// (docs/specs/spec-taxe-sejour.md §3 et §5) : COMBIEN DE PRIX RECOMMANDES
// CHANGENT quand le prix vendu sort hors taxe de sejour, de combien, sur quels
// biens et quelles dates.
//
// Usage :
//   git archive origin/main | tar -x -C <dossier>      (le code d'AVANT)
//   node --env-file=<.env de la base visee> scripts/mesurer-prix-hors-taxe.js --avant=<dossier> [--jours=365] [--detail]
//
// ⚠ LECTURE SEULE. Ni canal, ni writer, ni marqueur : les deux versions du
// moteur sont appelees par leurs fonctions pures de lecture
// (`preparerContexte` → `prixDeLaNuit`), sur la MEME base, au MEME instant.
// La seule difference entre les deux colonnes est le code : celui du dossier
// `--avant`, et celui de cet arbre.
//
// Deux mesures par bien :
//   - ECRAN : la « Prediction de prix », nuit par nuit sur `--jours` jours,
//     chaque nuit calculee comme ouverte (ce que l'hote voit) ;
//   - PILOTE : les nuits que le pilote quotidien tarifierait aujourd'hui
//     (bien pilote par YieldFlow, fenetre reglee, nuit ouverte, ni vendue ni
//     fermee ni tenue par l'hote) — la regle de saut est celle du moteur
//     (`calculerPrix`), pas une copie.
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT LE DIRE : code 1 si un bien est
// illisible ou si aucune nuit n'a ete comparee.

const path = require('path')
const fs = require('fs')
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
const args = process.argv.slice(2)
const avant = path.resolve((args.find(a => a.startsWith('--avant=')) || '').slice(8) || '.')
const jours = Number((args.find(a => a.startsWith('--jours=')) || '--jours=365').slice(8))
const DETAIL = args.includes('--detail')
if (avant === path.resolve(__dirname, '..') || !fs.existsSync(path.join(avant, 'lib', 'yield', 'contexte-du-bien.js'))) {
  console.error('Usage : --avant=<dossier du code d avant> (git archive origin/main | tar -x -C <dossier>)'); process.exit(1)
}
if (!Number.isInteger(jours) || jours < 1 || jours > 730) { console.error('--jours=1..730'); process.exit(1) }
// Le code d'avant doit vraiment etre different : sinon la mesure ne mesure rien.
const eclAvant = fs.readFileSync(path.join(avant, 'lib', 'yield', 'eclatement.js'), 'utf8')
if (/taxeSejourDe/.test(eclAvant)) { console.error(`REFUS : ${avant} porte deja le prix hors taxe — ce n est pas le code d avant.`); process.exit(1) }

const { createClient } = require('@supabase/supabase-js')
const APRES = require('../lib/yield/contexte-du-bien')
const AVANT = require(path.join(avant, 'lib', 'yield', 'contexte-du-bien'))
const { calculerPrix } = require('../lib/moteur-prix')
const { fermeturesDuBien } = require('../lib/fermetures')
const { prixHoteDuBien } = require('../lib/prix-hote')
const { finDeFenetre } = require('../lib/pilote-tarifaire')
const sb = createClient(URL, KEY)

const jourParis = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)
const decaler = (j, n) => { const d = new Date(`${j}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const cents = (s) => (s && s.prix != null && Number.isFinite(Number(s.prix)) ? Math.round(Number(s.prix) * 100) : null)
const niveau = (s) => (s && (s.niveau_effectif || s.niveau)) || null
const eur = (c) => (c == null ? '—' : `${(c / 100).toFixed(2)} €`)
const mediane = (xs) => { const t = [...xs].sort((a, b) => a - b); return t.length ? (t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2) : null }

function comparer (dates, av, ap) {
  const changes = []
  let comparees = 0
  for (const d of dates) {
    const a = av.get(d), p = ap.get(d)
    comparees++
    const ca = cents(a), cp = cents(p)
    if (ca !== cp || niveau(a) !== niveau(p)) changes.push({ date: d, avant: ca, apres: cp, niveau_avant: niveau(a), niveau_apres: niveau(p) })
  }
  return { comparees, changes }
}

function rapport (titre, { comparees, changes }) {
  console.log(`  ${titre} : ${comparees} nuits comparees · ${changes.length} changent`)
  if (!changes.length) return
  const deltas = changes.filter(c => c.avant != null && c.apres != null).map(c => c.apres - c.avant)
  if (deltas.length) {
    console.log(`    ecart apres − avant : min ${eur(Math.min(...deltas))} · mediane ${eur(mediane(deltas))} · max ${eur(Math.max(...deltas))} · baisses ${deltas.filter(x => x < 0).length} · hausses ${deltas.filter(x => x > 0).length} · meme prix, autre niveau ${deltas.filter(x => x === 0).length}`)
  }
  const sansPrix = changes.filter(c => (c.avant == null) !== (c.apres == null))
  if (sansPrix.length) console.log(`    prix apparu ou disparu : ${sansPrix.length}`)
  const parMois = {}
  for (const c of changes) parMois[c.date.slice(0, 7)] = (parMois[c.date.slice(0, 7)] || 0) + 1
  console.log(`    par mois : ${Object.entries(parMois).map(([m, n]) => `${m} ${n}`).join(' · ')}`)
  for (const c of (DETAIL ? changes : changes.slice(0, 8))) {
    console.log(`    ${c.date} : ${eur(c.avant)} (${c.niveau_avant || '—'}) → ${eur(c.apres)} (${c.niveau_apres || '—'})`)
  }
  if (!DETAIL && changes.length > 8) console.log(`    … ${changes.length - 8} autres (--detail pour tout)`)
}

;(async () => {
  console.log(`Projet Supabase : ${projet} — LECTURE SEULE — avant = ${avant}\n`)
  const { data: biens, error } = await sb.from('properties').select('*').order('name')
  if (error || !biens) { console.error('ECHEC : biens illisibles', error ? error.message : ''); process.exit(1) }
  console.log(`biens = ${biens.length} (5 = production, 3 = staging)\n`)
  const auj = jourParis()
  const finEcran = decaler(auj, jours - 1)
  let total = 0, totalChanges = 0, echec = false
  for (const bien of biens) {
    const fenetre = bien.pilote_tarifaire === 'yieldflow' ? finDeFenetre(bien, auj) : null
    const fin = [finEcran, fenetre || finEcran].sort()[1]
    console.log(`## ${bien.name} (${bien.id})${fenetre ? ` — pilote YieldFlow, fenetre jusqu'au ${fenetre}` : ' — non pilote'}`)
    let cAv, cAp
    try {
      cAv = await AVANT.preparerContexte(sb, bien, bien.user_id, { aujourdHui: auj, debut: auj, fin })
      cAp = await APRES.preparerContexte(sb, bien, bien.user_id, { aujourdHui: auj, debut: auj, fin })
    } catch (e) { console.log(`  matiere illisible — ${e.message}\n`); continue }
    const gr = (c) => (c.grille && c.grille.base && c.grille.base.niveaux ? c.grille.base.niveaux.map(n => n.prix) : null)
    console.log(`  grille avant ${JSON.stringify(gr(cAv))} · apres ${JSON.stringify(gr(cAp))}`)
    // ⚠ LA MATIERE D'ABORD (un verificateur qui n'a rien lu doit le dire) : 0
    // prix change ne prouve rien si aucune taxe n'a ete retiree de l'historique.
    const avecTaxe = (cAp.eclatements || []).filter(e => e.taxe_sejour_retiree > 0)
    const somme = (c) => (c.eclatements || []).reduce((a, e) => a + (e.prix_total || 0), 0)
    console.log(`  matiere : ${(cAp.eclatements || []).length} reservations lues · ${avecTaxe.length} avec taxe retiree (${avecTaxe.reduce((a, e) => a + e.taxe_sejour_retiree, 0).toFixed(2)} €) · CA lu avant ${somme(cAv).toFixed(2)} € → apres ${somme(cAp).toFixed(2)} €`)
    const brut = (c) => (c.grille && c.grille.base && c.grille.base.niveaux ? c.grille.base.niveaux.map(n => (n.prix_mesure != null ? Number(n.prix_mesure) : null)) : null)
    if (brut(cAp) && brut(cAp).some(x => x != null)) console.log(`  quantiles mesures (avant arrondi au pas) avant ${JSON.stringify(brut(cAv))} · apres ${JSON.stringify(brut(cAp))}`)
    const av = new Map(), ap = new Map(), dates = []
    for (let j = auj; j <= finEcran; j = decaler(j, 1)) {
      dates.push(j)
      av.set(j, AVANT.prixDeLaNuit(cAv, j, { ouverte: true }))
      ap.set(j, APRES.prixDeLaNuit(cAp, j, { ouverte: true }))
    }
    const ecran = comparer(dates, av, ap)
    rapport(`ECRAN (${auj} → ${finEcran})`, ecran)
    total += ecran.comparees; totalChanges += ecran.changes.length

    if (fenetre) {
      // Les nuits que le pilote tarifierait : celles pour lesquelles le moteur
      // de prix demande un prix, moins les vendues.
      const fermetures = await fermeturesDuBien(sb, bien.id, auj, fenetre)
      const { data: lignes, error: eL } = await sb.from('calendar_inventory').select('date, rate, avail, stop_sell')
        .eq('property_id', bien.id).gte('date', auj).lte('date', fenetre).limit(2000)
      if (eL) { console.error(`  ECHEC : memoire illisible — ${eL.message}`); echec = true; continue }
      const prixHote = await prixHoteDuBien(sb, bien.id, auj, fenetre)
      const tarifees = []
      const avP = new Map(), apP = new Map()
      calculerPrix({ aujourdHui: auj, fin: fenetre, lignes: lignes || [], fermetures, prixHote,
        prix: (date, o) => {
          const p = APRES.prixDeLaNuit(cAp, date, o)
          if (!((p && p.non_calculable) || []).includes('nuit_deja_vendue')) {
            tarifees.push(date); avP.set(date, AVANT.prixDeLaNuit(cAv, date, o)); apP.set(date, p)
          }
          return p
        } })
      rapport(`PILOTE (nuits ouvertes a tarifer, ${auj} → ${fenetre})`, comparer(tarifees, avP, apP))
    }
    console.log('')
  }
  if (echec) { console.error('Mesure INCOMPLETE : au moins une lecture a echoue.'); process.exit(1) }
  if (!total) { console.error('ECHEC : aucune nuit comparee — rien n a ete mesure.'); process.exit(1) }
  console.log(`TOTAL ecran : ${totalChanges} nuit(s) changent sur ${total}.`)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
