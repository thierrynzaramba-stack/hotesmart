#!/usr/bin/env node
// scripts/verser-fixture-marche.js — VERSER UNE REPONSE AIRROI DEJA PAYEE
// (fixture) DANS `airroi_cache`, SANS AUCUN APPEL. Decision de Thierry,
// 25 septembre 2026 : les 60 mois de Bagneres, en staging.
//
//   node --env-file=<.env de la base visee> scripts/verser-fixture-marche.js \
//     --fichier=tests/fixtures/airroi/marche-60.json --recupere-le=2026-09-23T00:00:00Z [--go --biens=<N>]
//
// ⚠ AUCUN APPEL AIRROI, aucune cle lue. La reponse est ecrite TELLE QUELLE
// (texte brut, comme le client) sous la cle canonique que le client
// calculerait pour `POST /markets/metrics/all` (marche du fichier, 60 mois,
// devise native) : une lecture future trouve le cache au lieu de payer.
// ⚠ PAR LE DEPOT du client (`lib/airroi/depot.js`) : un seul chemin d'ecriture
// du cache. `cout_usd` = 0 : rien n'est paye par ce chemin (la reponse l'a ete
// a la main, le 22-23 septembre). Le journal des appels n'est pas touche.
// ⚠ `recupere_le` = la date de capture annoncee : elle regle la fraicheur (le
// cache des 60 mois vaut 365 jours).
// ⚠ Sans --go : AUCUNE ecriture. --go exige --biens=N (3 staging, 5 production).

const fs = require('fs')
const { createClient } = require('@supabase/supabase-js')
const { depotSupabase } = require('../lib/airroi/depot')
const { cleCanonique } = require('../lib/airroi/client')
const { lireJson } = require('../lib/airroi/json')

const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const go = args.includes('--go')

;(async () => {
  const fichier = val('fichier')
  const recupereLe = val('recupere-le')
  if (!fichier || !recupereLe || Number.isNaN(Date.parse(recupereLe))) { console.error('Usage : --fichier=<json> --recupere-le=<ISO> [--go --biens=<N>]'); process.exit(1) }
  if (go && !/^\d+$/.test(String(val('biens') || ''))) { console.error('ECHEC : --go exige --biens=<N> (3 staging, 5 production)'); process.exit(1) }
  const texte = fs.readFileSync(fichier, 'utf8')
  const donnees = lireJson(texte)
  const m = donnees && donnees.market
  if (!m || !m.country || !m.region || !m.locality || !Array.isArray(donnees.results) || !donnees.results.length) {
    throw new Error('le fichier n est pas une reponse de markets/metrics/all (market + results)')
  }
  const nfc = v => String(v).normalize('NFC')
  const params = { market: { country: nfc(m.country), region: nfc(m.region), locality: nfc(m.locality) }, num_months: 60, currency: 'native' }
  const endpoint = 'POST /markets/metrics/all'
  const cle = cleCanonique(endpoint, params)
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) throw new Error(`empreinte illisible ${error ? error.message : ''}`)
  const projet = String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]
  console.log(`Projet ${projet} · biens = ${count} (5 = production, 3 = staging) · ${go ? 'ECRITURE dans airroi_cache' : 'sans --go : AUCUNE ecriture'}`)
  if (go && Number(val('biens')) !== count) { console.error(`ECHEC : --biens=${val('biens')} annonce, la base en compte ${count} — mauvaise base, rien n'est ecrit`); process.exit(3) }
  console.log(`${endpoint} · ${m.locality} (${m.region}, ${m.country}) · ${donnees.results.length} mois (${donnees.results[0].date} → ${donnees.results[donnees.results.length - 1].date}) · ${texte.length} octets · recupere_le ${recupereLe} · cout_usd 0`)
  console.log(`cle : ${cle}`)
  if (!go) return
  await depotSupabase(sb).ecrireCache({ cle, endpoint, parametres: params, reponse: texte, cout: 0, recupereLe })
  const relu = await sb.from('airroi_cache').select('cle, endpoint, recupere_le, cout_usd').eq('cle', cle).maybeSingle()
  if (relu.error || !relu.data) throw new Error('relecture impossible apres ecriture')
  console.log(`Ecrit et relu : ${relu.data.endpoint} · recupere_le ${relu.data.recupere_le} · cout_usd ${relu.data.cout_usd}`)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
