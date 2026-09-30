#!/usr/bin/env node
// scripts/capturer-occupation-airroi.js — L'OCCUPATION DU MARCHE, CAPTUREE EN
// FIXTURE, POUR LIRE SA FORME. Lot « marche global » (cadrage §14). UN appel,
// 0,10 $ (airroi.com/api/pricing, releve le 30 septembre 2026), puis zero a la
// relance (cache, 365 jours).
//
// ⚠ LA QUESTION QU'IL TRANCHE : la doc de /markets/metrics/occupancy dit
// « Returns daily, monthly, and aggregated occupancy data », son exemple est
// mensuel. Le script affiche les cles de premier niveau et les dates des
// premiers points de chaque serie — rien d'autre n'est interprete.
//
// Usage — c'est Thierry qui le lance, depuis /home/thierry/hotesmart-v23 :
//   AIRROI_API_KEY="$AIRROI_KEY" node scripts/capturer-occupation-airroi.js [--confirmer] [--cache=<dossier>] [--budget=0.6]
//
// ⚠ `AIRROI_KEY` doit deja etre posee dans le shell : ne JAMAIS coller la cle
// en clair dans la commande.
// ⚠ Sans --confirmer : le script dit ce que l'appel COUTERAIT et s'arrete.
// ⚠ Marche de Bagneres lu dans la fixture marche-60.json (le meme que les
// 60 mois), 60 mois, devise native. AUCUNE base touchee.
// ⚠ La cle est cherchee dans la reponse AVANT toute ecriture dans le depot.

const path = require('path')
const fs = require('fs')
const { creerClient, cleCanonique } = require('../lib/airroi/client')
const { depotFichier } = require('../lib/airroi/depot')
const { lireJson } = require('../lib/airroi/json')
const { ecrireFixtureSansCle, RefusFixture } = require('../lib/airroi/fixture-sure')
const { jourLocalParis } = require('../lib/yield/zones-scolaires')

const args = process.argv.slice(2)
const val = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d }
const dossier = val('cache', path.join(require('os').homedir(), '.hotesmart-airroi-cache'))
const budget = Number(val('budget', '0.6'))
const confirmer = args.includes('--confirmer')
// Les fixtures de LECTURE (moi.json, marche-60.json) viennent toujours du
// depot ; `--fixtures` ne deplace que l'ECRITURE (les tests l'isolent).
const FIX = path.join(__dirname, '..', 'tests', 'fixtures', 'airroi')
const SORTIE = val('fixtures', FIX)
const MOIS = 60

;(async () => {
  if (!(Number.isFinite(budget) && budget > 0)) { console.error('ECHEC : --budget doit etre un nombre positif'); process.exit(1) }
  const m = lireJson(fs.readFileSync(path.join(FIX, 'marche-60.json'), 'utf8')).market
  const market = { country: m.country.normalize('NFC'), region: m.region.normalize('NFC'), locality: m.locality.normalize('NFC') }
  const depot = depotFichier(dossier)
  const client = creerClient({ depot, alerter: null, gardes: { budgetMensuelUsd: budget } })
  const E = 'POST /markets/metrics/occupancy'
  const params = { market, num_months: MOIS, currency: 'native' }
  console.log(`Cache : ${dossier} · plafond du MOIS civil sur ce journal local : ${budget} $ · ${market.locality} (${market.region}, ${market.country}) · ${MOIS} mois`)
  const cout = await client.estimer([{ endpoint: E, params }])
  console.log(`Cout de cet appel : ${cout === 0 ? '0 $ (servi par le cache)' : `${cout.toFixed(2)} $`}`)
  if (cout > 0 && !confirmer) { console.log('Rien n est paye : relancer avec --confirmer pour payer.'); process.exit(0) }

  const r = await client.occupationMarche(market, MOIS, { horsCompte: true })
  const brut = await depot.lireCache(cleCanonique(E, params))
  if (!brut || typeof brut.reponse !== 'string') throw new Error('reponse introuvable dans le cache')
  // Le jour de CAPTURE, a l'heure de Paris.
  const jour = jourLocalParis(String(brut.recupere_le || new Date().toISOString()))
  const fichier = path.join(SORTIE, `occupation-bagneres-${jour}.json`)
  // Cle verifiee EN MEMOIRE avant toute ecriture ; sans cle, refus (code 6).
  ecrireFixtureSansCle(brut.reponse, fichier, process.env.AIRROI_API_KEY || '')

  // LA FORME, telle quelle : cles de premier niveau, puis chaque tableau avec
  // sa longueur, les champs de son premier point et ses premieres dates.
  const d = r.donnees || {}
  console.log(`1. occupancy : ${r.depuisCache ? 'cache, 0 $' : `${r.cout.toFixed(2)} $`}`)
  const premiers = Object.keys(d)
  console.log(`   cles de premier niveau (${premiers.length}) : ${premiers.slice(0, 20).join(', ')}${premiers.length > 20 ? ', …' : ''}`)
  const decrire = (nom, v, prof = 0) => {
    if (Array.isArray(v)) {
      const p = v[0]
      const dates = v.map(x => x && typeof x === 'object' ? (x.date || x.day || x.month) : null).filter(Boolean)
      console.log(`   ${'  '.repeat(prof)}${nom} : tableau de ${v.length}${p && typeof p === 'object' ? ` · champs ${Object.keys(p).join(', ')}` : ''}`)
      if (dates.length) console.log(`   ${'  '.repeat(prof)}  premieres dates : ${dates.slice(0, 5).join(', ')} … derniere ${dates[dates.length - 1]}`)
    } else if (v && typeof v === 'object' && prof < 2) {
      // Borne : un dictionnaire indexe par date ferait des milliers de lignes.
      const cles = Object.keys(v)
      console.log(`   ${'  '.repeat(prof)}${nom} : objet de ${cles.length} cle(s) · ${cles.slice(0, 20).join(', ')}${cles.length > 20 ? ', …' : ''}`)
      for (const k of cles.slice(0, 5)) if (v[k] && typeof v[k] === 'object') decrire(`${nom}.${k}`, v[k], prof + 1)
    }
  }
  for (const [k, v] of Object.entries(d).slice(0, 20)) decrire(k, v)
  console.log(`2. fixture ecrite : ${path.relative(path.join(__dirname, '..'), fichier)} (${brut.reponse.length} octets) — aucune trace de la cle.`)
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(e instanceof RefusFixture ? e.code : 1) })
