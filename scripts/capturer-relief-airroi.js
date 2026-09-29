#!/usr/bin/env node
// scripts/capturer-relief-airroi.js — LE RELIEF JOUR PAR JOUR DU MODELE
// D'AIRROI, CAPTURE EN FIXTURE. Lot « marche global » (cadrage §14). UN appel,
// 0,10 $ (airroi.com/api/pricing, releve le 30 septembre 2026), puis ZERO a la
// relance (le cache).
//
// Usage — c'est Thierry qui le lance, depuis /home/thierry/hotesmart-v23 (la
// cle ne s'ecrit nulle part : elle passe par l'environnement) :
//   AIRROI_API_KEY="$AIRROI_KEY" node scripts/capturer-relief-airroi.js [--cache=<dossier>] [--budget=1]
//
// Ce qu'il fait, sur Bagneres-de-Bigorre (coordonnees de La bulle lues dans la
// fixture moi.json, AUCUNE base touchee) :
//   1. POST /price-recommendation/calendar-prices, base_price = 100, devise
//      native (l'euro a Bagneres), du jour de l'appel a +729 jours ;
//   2. il ecrit la reponse BRUTE dans
//      tests/fixtures/airroi/relief-bagneres-<date de capture>.json ;
//   3. il verifie que le fichier ne contient la cle sous AUCUNE forme — sinon
//      il le SUPPRIME et echoue.
//
// ⚠ BASE 100 : les pourcentages rendus sont des FACTEURS, jamais le prix d'un
// logement (le client refuse toute autre base). On prend a AirROI la
// decomposition de son modele, pas son prix (§8).
// ⚠ LA DATE DE CAPTURE COMPTE : `market_demand` regarde devant lui depuis le
// jour de l'appel. Le nom du fichier porte la date.
// ⚠ LA CLE N'EST JAMAIS AFFICHEE, ni en entier, ni en partie, ni sa longueur.
// ⚠ BUDGET DUR : au-dela de --budget (defaut 1 $), le client refuse AVANT
// l'appel.

const path = require('path')
const fs = require('fs')
const { creerClient, cleCanonique } = require('../lib/airroi/client')
const { depotFichier } = require('../lib/airroi/depot')
const { lireJson } = require('../lib/airroi/json')
const { jourLocalParis } = require('../lib/yield/zones-scolaires')

const args = process.argv.slice(2)
const val = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d }
const dossier = val('cache', path.join(require('os').homedir(), '.hotesmart-airroi-cache'))
const budget = Number(val('budget', '1'))
const FIX = path.join(__dirname, '..', 'tests', 'fixtures', 'airroi')
const JOURS = 730

;(async () => {
  if (!(Number.isFinite(budget) && budget > 0)) { console.error('ECHEC : --budget doit etre un nombre positif'); process.exit(1) }
  const moi = lireJson(fs.readFileSync(path.join(FIX, 'moi.json'), 'utf8'))
  const { latitude, longitude } = moi.location_info
  const debut = jourLocalParis(new Date().toISOString())
  const fin = new Date(Date.parse(`${debut}T00:00:00Z`) + (JOURS - 1) * 86400000).toISOString().slice(0, 10)
  const depot = depotFichier(dossier)
  const client = creerClient({ depot, alerter: null, gardes: { budgetMensuelUsd: budget } })
  console.log(`Cache : ${dossier} · budget du script : ${budget} $ · ${debut} → ${fin} (${JOURS} jours)`)

  const r = await client.reliefCalendrier({ latitude, longitude, debut, fin }, { horsCompte: true })

  // La reponse BRUTE, lue dans le cache (le texte exact d'AirROI).
  const params = { location: { latitude, longitude }, currency: 'native', base_price: 100, start_date: debut, end_date: fin }
  const brut = await depot.lireCache(cleCanonique('POST /price-recommendation/calendar-prices', params))
  if (!brut || typeof brut.reponse !== 'string') throw new Error('reponse introuvable dans le cache')
  const jour = String(brut.recupere_le || new Date().toISOString()).slice(0, 10)
  const fichier = path.join(FIX, `relief-bagneres-${jour}.json`)
  fs.writeFileSync(fichier, brut.reponse)

  const cle = process.env.AIRROI_API_KEY || ''
  const formes = cle ? [cle, encodeURIComponent(cle), JSON.stringify(cle).slice(1, -1)] : []
  const contenu = fs.readFileSync(fichier, 'utf8')
  if (formes.some(f => f && contenu.includes(f))) {
    fs.unlinkSync(fichier)
    console.error('ECHEC : la fixture contenait la cle — fichier SUPPRIME, rien a commiter.')
    process.exit(4)
  }

  // Sa FORME, pas ses chiffres (ils se liront dans les tests).
  const d = r.donnees || {}
  const estPoint = x => x && typeof x === 'object' && x.date
  const points = Array.isArray(d) ? d : (Object.values(d).find(v => Array.isArray(v) && v.some(estPoint)) || [])
  const dates = points.map(x => x.date).filter(Boolean).sort()
  console.log(`1. calendar-prices : ${r.depuisCache ? 'cache, 0 $' : `${r.cout.toFixed(2)} $`} · ${points.length} jour(s)${dates.length ? `, du ${dates[0]} au ${dates[dates.length - 1]}` : ''}`)
  console.log(`   cles de premier niveau : ${Array.isArray(d) ? '(tableau)' : Object.keys(d).join(', ')}`)
  console.log(`   champs d un jour : ${Object.keys(points[0] || {}).join(', ') || '(aucun)'}`)
  console.log(`2. fixture ecrite : ${path.relative(path.join(__dirname, '..'), fichier)} (${contenu.length} octets) — aucune trace de la cle.`)
  if (!points.length) {
    console.error('ECHEC : aucun jour date reconnu. Fixture ecrite, forme a lire ; relance gratuite (cache).')
    process.exit(5)
  }
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
