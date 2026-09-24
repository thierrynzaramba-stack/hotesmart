#!/usr/bin/env node
// scripts/capturer-pacing.js — LE PACING DU MARCHE, CAPTURE EN FIXTURE.
// Lot V2.3.0 (etape 1, le marche). Deux appels, 0,21 $ au plus, puis ZERO a
// la relance (le cache).
//
// Usage — c'est Thierry qui le lance, depuis /home/thierry/hotesmart-v23 (la
// cle ne s'ecrit nulle part : elle passe par l'environnement) :
//   AIRROI_API_KEY="$AIRROI_KEY" node scripts/capturer-pacing.js [--cache=<dossier>] [--budget=0.5]
//
// Ce qu'il fait, sur Bagneres-de-Bigorre (coordonnees de La bulle lues dans la
// fixture moi.json, AUCUNE base touchee) :
//   1. GET /markets/lookup trouve le marche (0,01 $ ; 0 $ s'il est deja en
//      cache — meme dossier que scripts/verifier-airroi.js) ;
//   2. il verifie que c'est le MEME marche que la fixture marche-60.json
//      (sinon il s'arrete AVANT de payer le pacing) ;
//   3. POST /markets/metrics/future/pacing (0,20 $) ;
//   4. il ecrit la reponse BRUTE, telle qu'AirROI l'a rendue, dans
//      tests/fixtures/airroi/pacing-bagneres-<date de capture>.json ;
//   5. il verifie que le fichier ne contient la cle sous AUCUNE forme (brute,
//      encodee URL, echappee JSON) — sinon il le SUPPRIME et echoue.
//
// ⚠ LA CLE N'EST JAMAIS AFFICHEE, ni en entier, ni en partie, ni sa longueur.
// ⚠ BUDGET DUR : au-dela de --budget (defaut 0,50 $), le client refuse AVANT
// l'appel (garde-fou, sur le journal du dossier de cache).
// ⚠ LA DATE DE CAPTURE COMPTE : le pacing regarde 365 jours DEVANT lui. Les
// ruptures du 22 septembre (19 decembre, 2 janvier, 6 mars) se relisent sur
// une capture de fin septembre ; le nom du fichier porte la date.

const path = require('path')
const fs = require('fs')
const { creerClient, cleCanonique } = require('../lib/airroi/client')
const { depotFichier } = require('../lib/airroi/depot')
const { lireJson } = require('../lib/airroi/json')

const args = process.argv.slice(2)
const val = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d }
const dossier = val('cache', path.join(require('os').homedir(), '.hotesmart-airroi-cache'))
const budget = Number(val('budget', '0.5'))
const FIX = path.join(__dirname, '..', 'tests', 'fixtures', 'airroi')
const CHAMPS_MARCHE = ['country', 'region', 'locality']

;(async () => {
  if (!(Number.isFinite(budget) && budget > 0)) { console.error('ECHEC : --budget doit etre un nombre positif'); process.exit(1) }
  const moi = lireJson(fs.readFileSync(path.join(FIX, 'moi.json'), 'utf8'))
  const { latitude, longitude } = moi.location_info
  const attendu = lireJson(fs.readFileSync(path.join(FIX, 'marche-60.json'), 'utf8')).market
  const depot = depotFichier(dossier)
  const client = creerClient({ depot, gardes: { budgetMensuelUsd: budget } })
  const ctx = { horsCompte: true }
  console.log(`Cache : ${dossier} · budget du script : ${budget} $`)
  const etapes = []
  const noter = (nom, r) => { etapes.push({ nom, cout: r.cout, cache: r.depuisCache }); return r }

  // 1-2. Le marche, et le meme que la fixture des 60 mois — sinon on ne paie pas.
  const m = noter('GET /markets/lookup', await client.trouverMarche(latitude, longitude, ctx))
  const d = m.donnees || {}
  const source = d.market && typeof d.market === 'object' ? d.market : d
  const marche = Object.fromEntries(CHAMPS_MARCHE.map(k => [k, source[k]]))
  const memeMarche = CHAMPS_MARCHE.every(k => typeof marche[k] === 'string' && marche[k] === attendu[k])
  console.log(`1. marche : ${CHAMPS_MARCHE.map(k => marche[k]).join(' / ')} — ${memeMarche ? 'le MEME que marche-60.json' : `DIFFERENT de marche-60.json (${CHAMPS_MARCHE.map(k => attendu[k]).join(' / ')})`}`)
  if (!memeMarche) {
    console.error('ECHEC : marche different de la fixture des 60 mois — pacing NON appele (0,20 $ epargnes).')
    process.exit(3)
  }

  // 3. Le pacing.
  const p = noter('POST /markets/metrics/future/pacing', await client.pacingMarche(marche, ctx))

  // 4. La reponse BRUTE, lue dans le cache (le texte exact d'AirROI, pas un
  // JSON re-serialise qui pourrait arrondir un nombre).
  const brut = await depot.lireCache(cleCanonique('POST /markets/metrics/future/pacing', { market: marche, currency: 'native' }))
  if (!brut || typeof brut.reponse !== 'string') throw new Error('reponse du pacing introuvable dans le cache')
  const jour = String(brut.recupere_le || new Date().toISOString()).slice(0, 10)
  const fichier = path.join(FIX, `pacing-bagneres-${jour}.json`)
  fs.writeFileSync(fichier, brut.reponse)

  // 5. Aucune trace de la cle, sous aucune forme. Rien n'est affiche d'elle.
  const cle = process.env.AIRROI_API_KEY || ''
  const formes = cle ? [cle, encodeURIComponent(cle), JSON.stringify(cle).slice(1, -1)] : []
  const contenu = fs.readFileSync(fichier, 'utf8')
  if (formes.some(f => f && contenu.includes(f))) {
    fs.unlinkSync(fichier)
    console.error('ECHEC : la fixture contenait la cle — fichier SUPPRIME, rien a commiter.')
    process.exit(4)
  }

  // Ce que contient la reponse : sa forme, pas ses chiffres (ils se liront au
  // lot V2.3.1, dans les tests).
  const donnees = p.donnees || {}
  const points = Array.isArray(donnees) ? donnees : (Object.values(donnees).find(Array.isArray) || [])
  const premier = points[0] || {}
  const dates = points.map(x => x && (x.date || x.day || x.stay_date)).filter(Boolean).sort()
  console.log(`2. pacing : ${points.length} point(s)${dates.length ? `, du ${dates[0]} au ${dates[dates.length - 1]}` : ''}`)
  console.log(`   cles de premier niveau : ${Array.isArray(donnees) ? '(tableau)' : Object.keys(donnees).join(', ')}`)
  console.log(`   champs d un point : ${Object.keys(premier).join(', ') || '(aucun)'}`)
  console.log(`3. fixture ecrite : ${path.relative(path.join(__dirname, '..'), fichier)} (${contenu.length} octets) — aucune trace de la cle.`)

  const total = etapes.reduce((t, e) => t + e.cout, 0)
  console.log('\nDepense de cette execution, endpoint par endpoint :')
  for (const e of etapes) console.log(`  ${e.nom} : ${e.cache ? 'cache, 0 $' : `${e.cout.toFixed(2)} $`}`)
  console.log(`  TOTAL : ${total.toFixed(2)} $${total === 0 ? ' (tout vient du cache)' : ''}`)
  // Un script qui n'a rien capture doit echouer.
  process.exit(points.length > 0 ? 0 : 3)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
