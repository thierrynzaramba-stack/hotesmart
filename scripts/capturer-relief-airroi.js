#!/usr/bin/env node
// scripts/capturer-relief-airroi.js — LE RELIEF JOUR PAR JOUR DU MODELE
// D'AIRROI, CAPTURE EN FIXTURE. Lot « marche global » (cadrage §14). UN appel,
// 0,10 $ (airroi.com/api/pricing, releve le 30 septembre 2026), puis ZERO a la
// relance du MEME MOIS (le cache : la cle ne change qu'au 1er du mois).
//
// Usage — c'est Thierry qui le lance, depuis /home/thierry/hotesmart-v23 (la
// cle ne s'ecrit nulle part : elle passe par l'environnement) :
//   AIRROI_API_KEY="$AIRROI_KEY" node scripts/capturer-relief-airroi.js [--confirmer] [--cache=<dossier>] [--budget=1]
//
// ⚠ `AIRROI_KEY` doit deja etre posee dans le shell : ne JAMAIS coller la cle
// en clair dans la commande (elle partirait dans l'historique).
// ⚠ Sans --confirmer : le script dit ce que l'appel COUTERAIT (0 $ si le cache
// le sert, 0,10 $ sinon) et s'arrete sans rien payer.
//
// Ce qu'il fait, sur Bagneres-de-Bigorre (coordonnees de La bulle lues dans la
// fixture moi.json, AUCUNE base touchee) :
//   1. POST /price-recommendation/calendar-prices, base_price = 100, devise
//      EUR (cet endpoint refuse `native` : code ISO en majuscules), du 1er du mois SUIVANT (heure de Paris :
//      jamais une date passee) a +729 jours ;
//   2. il verifie que la reponse ne contient la cle sous AUCUNE forme — sinon
//      il n'ecrit RIEN dans le depot et echoue ;
//   3. il ecrit la reponse BRUTE dans
//      tests/fixtures/airroi/relief-bagneres-<date de capture>.json.
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
const confirmer = args.includes('--confirmer')
const FIX = path.join(__dirname, '..', 'tests', 'fixtures', 'airroi')
const JOURS = 730

;(async () => {
  if (!(Number.isFinite(budget) && budget > 0)) { console.error('ECHEC : --budget doit etre un nombre positif'); process.exit(1) }
  const moi = lireJson(fs.readFileSync(path.join(FIX, 'moi.json'), 'utf8'))
  const { latitude, longitude } = moi.location_info
  const [an, mo] = jourLocalParis(new Date().toISOString()).slice(0, 7).split('-').map(Number)
  const debut = new Date(Date.UTC(an, mo, 1)).toISOString().slice(0, 10)
  const fin = new Date(Date.parse(`${debut}T00:00:00Z`) + (JOURS - 1) * 86400000).toISOString().slice(0, 10)
  const depot = depotFichier(dossier)
  const client = creerClient({ depot, alerter: null, gardes: { budgetMensuelUsd: budget } })
  console.log(`Cache : ${dossier} · budget du script : ${budget} $ · ${debut} → ${fin} (${JOURS} jours)`)

  const E = 'POST /price-recommendation/calendar-prices'
  const params = { location: { latitude, longitude }, currency: 'EUR', base_price: 100, start_date: debut, end_date: fin }
  // Le cout AVANT tout appel (review de f13526c : une relance un autre mois
  // payait sans prevenir).
  const cout = await client.estimer([{ endpoint: E, params }])
  console.log(`Cout de cet appel : ${cout === 0 ? '0 $ (servi par le cache)' : `${cout.toFixed(2)} $`}`)
  if (cout > 0 && !confirmer) {
    console.log('Rien n est paye : relancer avec --confirmer pour payer.')
    process.exit(0)
  }

  const r = await client.reliefCalendrier({ latitude, longitude, debut, fin }, { horsCompte: true })

  // La reponse BRUTE, lue dans le cache (le texte exact d'AirROI).
  const brut = await depot.lireCache(cleCanonique(E, params))
  if (!brut || typeof brut.reponse !== 'string') throw new Error('reponse introuvable dans le cache')

  // Aucune trace de la cle, verifiee AVANT d'ecrire dans le depot (review :
  // un processus tue entre l'ecriture et le controle laissait le fichier).
  const cle = process.env.AIRROI_API_KEY || ''
  const formes = cle ? [cle, encodeURIComponent(cle), JSON.stringify(cle).slice(1, -1)] : []
  if (formes.some(f => f && brut.reponse.includes(f))) {
    console.error(`ECHEC : la reponse contient la cle — RIEN n'est ecrit dans le depot. Purger aussi le cache local (${dossier}).`)
    process.exit(4)
  }
  // Le jour de CAPTURE, a l'heure de Paris (`market_demand` en depend).
  const jour = jourLocalParis(String(brut.recupere_le || new Date().toISOString()))
  const fichier = path.join(FIX, `relief-bagneres-${jour}.json`)
  fs.writeFileSync(fichier, brut.reponse)
  const contenu = brut.reponse

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
    console.error('ECHEC : aucun jour date reconnu. Fixture ecrite, forme a lire.')
    process.exit(5)
  }
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
