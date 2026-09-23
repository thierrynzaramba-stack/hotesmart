#!/usr/bin/env node
// scripts/verifier-airroi.js — LA PLOMBERIE AIRROI CONTRE LE VRAI SERVICE.
// Lot V2.1. Trois appels, 0,21 $ au plus, puis ZERO a la relance (le cache).
//
// Usage (la cle ne s'ecrit nulle part : elle passe par l'environnement) :
//   AIRROI_API_KEY="$AIRROI_KEY" node scripts/verifier-airroi.js [--cache=<dossier>] [--budget=0.5]
//
// Ce qu'il prouve, sur La bulle (coordonnees et annonce lues dans la fixture
// moi.json, aucune base touchee) :
//   1. GET /markets/lookup trouve le marche (0,01 $) ;
//   2. GET /listings rend la fiche, et l'identifiant revient INTACT
//      (992723390568420450, pas ...500) (0,10 $) ;
//   3. GET /listings/metrics/all rend 26 mois, les memes que la fixture
//      labulle-60.json sur les mois communs (0,10 $) ;
//   4. une relance ne coute rien : tout vient du cache.
//
// ⚠ LA CLE N'EST JAMAIS AFFICHEE, ni en entier, ni en partie, ni sa longueur.
// ⚠ BUDGET DUR : au-dela de --budget (defaut 0,50 $), le script s'arrete AVANT
// l'appel (garde-fou du client, sur le journal du dossier de cache).

const path = require('path')
const fs = require('fs')
const { creerClient } = require('../lib/airroi/client')
const { depotFichier } = require('../lib/airroi/depot')
const { lireJson } = require('../lib/airroi/json')

const args = process.argv.slice(2)
const val = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d }
const dossier = val('cache', path.join(require('os').homedir(), '.hotesmart-airroi-cache'))
const budget = Number(val('budget', '0.5'))
const FIX = path.join(__dirname, '..', 'tests', 'fixtures', 'airroi')

;(async () => {
  const moi = lireJson(fs.readFileSync(path.join(FIX, 'moi.json'), 'utf8'))
  const id = moi.listing_info.listing_id
  const { latitude, longitude } = moi.location_info
  if (!(Number.isFinite(budget) && budget > 0)) { console.error('ECHEC : --budget doit etre un nombre positif'); process.exit(1) }
  const client = creerClient({ depot: depotFichier(dossier), gardes: { budgetMensuelUsd: budget } })
  const ctx = { horsCompte: true }
  console.log(`Cache : ${dossier} · budget du script : ${budget} $`)
  const etapes = []
  const noter = (nom, r) => { etapes.push({ nom, cout: r.cout, cache: r.depuisCache }); return r }

  const m = noter('GET /markets/lookup', await client.trouverMarche(latitude, longitude, ctx))
  console.log(`1. marche : ${JSON.stringify(m.donnees).slice(0, 160)}`)
  const f = noter('GET /listings', await client.annonce(id, ctx))
  const idRendu = f.donnees && f.donnees.listing_info ? String(f.donnees.listing_info.listing_id) : null
  console.log(`2. annonce : identifiant envoye ${id}, rendu ${idRendu} — ${idRendu === String(id) ? 'INTACT' : 'DIFFERENT'}`)
  const mm = noter('GET /listings/metrics/all', await client.metriquesAnnonce(id, ctx))
  const res = (mm.donnees && mm.donnees.results) || []
  const fixture = lireJson(fs.readFileSync(path.join(FIX, 'labulle-60.json'), 'utf8')).results
  const parMois = new Map(fixture.map(x => [x.date, x]))
  const communs = res.filter(x => parMois.has(x.date))
  const egaux = communs.filter(x => Number(x.average_daily_rate) === Number(parMois.get(x.date).average_daily_rate) &&
    Number(x.occupancy) === Number(parMois.get(x.date).occupancy))
  console.log(`3. metriques : ${res.length} mois (${res[0] && res[0].date} → ${res[res.length - 1] && res[res.length - 1].date}) ; ${egaux.length}/${communs.length} mois communs identiques a la fixture`)

  const total = etapes.reduce((t, e) => t + e.cout, 0)
  console.log('\nDepense de cette execution, endpoint par endpoint :')
  for (const e of etapes) console.log(`  ${e.nom} : ${e.cache ? 'cache, 0 $' : `${e.cout.toFixed(2)} $`}`)
  console.log(`  TOTAL : ${total.toFixed(2)} $${total === 0 ? ' (tout vient du cache)' : ''}`)
  // Un verificateur qui n'a rien compare doit echouer.
  const ok = idRendu === String(id) && res.length > 0 && communs.length > 0 && egaux.length === communs.length
  process.exit(ok ? 0 : 3)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
