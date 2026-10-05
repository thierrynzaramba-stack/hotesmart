#!/usr/bin/env node
// scripts/recapturer-calendriers-comparables.js — LA SECONDE CAPTURE des
// calendriers des comparables d'un bien (dette 52 de docs/kb/dettes-v1.md,
// decision de Thierry du 5 octobre 2026).
//
// LA QUESTION : les comparables du loft de recette (Toulouse, jacuzzi) ont une
// prime week-end de novembre a mai, et plus rien a partir de juin. Deux causes
// possibles :
//   - une SAISON propre au segment (nuits romantiques avec jacuzzi : l'hiver) ;
//   - des PRIX LOINTAINS pas encore regles (au-dela de 8 mois, prix de base ;
//     l'outil de prix de l'hote les ajuste a l'approche).
// Un mois plus tard, si les nuits d'avril a septembre 2027 ont change de prix et
// que la prime week-end y est apparue : prix lointains. Sinon : saison.
//
//   1. LA PHOTO DU JOUR (gratuit, aucun appel AirROI) : les calendriers en cache
//      sur la base visee, recopies en fixture. La cle AirROI doit etre dans
//      l'environnement : sans elle, l'ecriture de fixture ne peut pas prouver
//      que la cle n'y est pas, et refuse (lib/airroi/fixture-sure.js).
//      node --env-file=<.env AirROI> --env-file=<.env de la base> \
//        scripts/recapturer-calendriers-comparables.js --bien=<uuid> --instantane
//   2. LA SECONDE CAPTURE (payante, le 5 novembre 2026) : sans --confirmer, le
//      cout seulement ; avec --confirmer, la capture puis la comparaison.
//      AIRROI_API_KEY dans l'environnement (jamais dans la commande) :
//      node --env-file=<.env AirROI> --env-file=<.env de la base> \
//        scripts/recapturer-calendriers-comparables.js --bien=<uuid> \
//        --avant=tests/fixtures/airroi/calendriers-comparables-<bien>-<date>.json [--confirmer]
//
// ⚠ LECTURE SEULE sur la base : rien n'y est ecrit. La capture passe par le
//   client AirROI (lib/airroi/client.js) avec un depot FICHIER NEUF — sinon le
//   cache (90 jours) servirait la reponse du 5 octobre et rien ne serait mesure.
// ⚠ PLAFOND DUR : 1,20 $ (accord de Thierry), garde-fou du client, avant tout
//   reseau.
// ⚠ L'ORDRE DES --env-file COMPTE : le dernier gagne. Le fichier de la base vient
//   EN DERNIER (vecu le 5 octobre 2026 : l'inverse visait la production ; seule
//   l'empreinte l'a arretee).
// ⚠ La cle AirROI n'est jamais affichee ; la fixture est verifiee sans elle.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')
const { creerClient, cleCanonique } = require('../lib/airroi/client')
const { depotFichier } = require('../lib/airroi/depot')
const { lireJson } = require('../lib/airroi/json')
const { ecrireFixtureSansCle } = require('../lib/airroi/fixture-sure')
const { TARIFS } = require('../lib/airroi/cout')

const ENDPOINT = 'GET /listings/live/calendar'
const PLAFOND_USD = 1.20
const FIX = path.join(__dirname, '..', 'tests', 'fixtures', 'airroi')
const args = process.argv.slice(2)
const val = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const jour = () => new Date().toISOString().slice(0, 10)
const weekEnd = j => [5, 6].includes(new Date(`${j}T00:00:00Z`).getUTCDay()) // NUITS du vendredi et du samedi (dette 30)
const mediane = xs => { if (!xs.length) return null; const t = [...xs].sort((a, b) => a - b); const m = Math.floor(t.length / 2); return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2 }

// La comparaison : par comparable et par mois, la mediane semaine / week-end
// avant et apres, et la part des nuits dont le prix a change.
function comparer (avant, apres) {
  const lignes = []
  for (const id of Object.keys(apres)) if (!avant[id]) lignes.push({ id, nouveau: true })
  for (const id of Object.keys(avant)) {
    if (!apres[id]) { lignes.push({ id, absent: true }); continue }
    const a = new Map(avant[id].map(n => [n.date, n.rate]))
    const b = new Map(apres[id].map(n => [n.date, n.rate]))
    const mois = [...new Set([...b.keys()].filter(j => a.has(j)).map(j => j.slice(0, 7)))].sort()
    for (const m of mois) {
      const jours = [...b.keys()].filter(j => j.startsWith(m) && a.has(j))
      const prime = src => {
        const se = mediane(jours.filter(j => !weekEnd(j)).map(j => src.get(j)).filter(x => x > 0))
        const we = mediane(jours.filter(weekEnd).map(j => src.get(j)).filter(x => x > 0))
        return { se, we }
      }
      const changes = jours.filter(j => a.get(j) !== b.get(j)).length
      lignes.push({ id, mois: m, avant: prime(a), apres: prime(b), changes, nuits: jours.length })
    }
  }
  return lignes
}

async function principal () {
  const bien = val('bien')
  if (!bien || !/^[0-9a-f-]{36}$/.test(bien)) { console.error('Usage : --bien=<uuid> (--instantane | --avant=<fixture> [--confirmer])'); process.exit(1) }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) throw new Error(`empreinte illisible ${error ? error.message : ''}`)
  // ⚠ STAGING SEULEMENT (review de 5876a4b) : le loft de recette n'existe que
  // la. Toute autre empreinte arrete le script.
  console.log(`Base : ${count} bien(s) — ${count === 3 ? 'STAGING' : 'PAS STAGING'} · lecture seule`)
  if (count !== 3) { console.error('ECHEC : ce script ne vise que staging (3 biens) — rien n est fait'); process.exit(3) }
  const { data: retenus, error: eR } = await sb.from('comparables_retenus').select('listing_id').eq('property_id', bien).eq('actif', true)
  if (eR) throw new Error(`comparables_retenus : ${eR.message}`)
  const ids = (retenus || []).map(r => String(r.listing_id)).filter(id => /^[0-9]{1,24}$/.test(id))
  if (!ids.length) throw new Error('aucun comparable retenu pour ce bien : rien a capturer')
  console.log(`${ids.length} comparable(s) retenu(s)`)

  if (args.includes('--instantane')) {
    const photo = {}
    for (const id of ids) {
      const { data } = await sb.from('airroi_cache').select('reponse, recupere_le').eq('cle', cleCanonique(ENDPOINT, { listing_id: id, currency: 'native' })).limit(1)
      if (!data || !data[0]) { console.log(`  ${id} : pas en cache — absent de la photo`); continue }
      photo[id] = { recupere_le: data[0].recupere_le, results: lireJson(data[0].reponse).results }
    }
    if (!Object.keys(photo).length) throw new Error('aucun calendrier en cache : la photo serait vide')
    const fichier = path.join(FIX, `calendriers-comparables-${bien.slice(0, 8)}-${jour()}.json`)
    ecrireFixtureSansCle(JSON.stringify(photo), fichier, process.env.AIRROI_API_KEY || '')
    console.log(`Photo ecrite : ${path.relative(path.join(__dirname, '..'), fichier)} (${Object.keys(photo).length} calendriers, aucun appel paye)`)
    return
  }

  const avantF = val('avant')
  if (!avantF) throw new Error('--avant=<photo du 5 octobre> requis')
  const avant = Object.fromEntries(Object.entries(lireJson(fs.readFileSync(avantF, 'utf8'))).map(([id, v]) => [id, v.results]))
  const cout = Math.round(ids.length * TARIFS[ENDPOINT] * 100) / 100
  console.log(`Cout au tarif du code (${TARIFS[ENDPOINT]} $) : ${cout} $ · plafond dur ${PLAFOND_USD} $`)
  if (!args.includes('--confirmer')) { console.log('Rien n est paye : relancer avec --confirmer.'); return }

  // Depot NEUF : aucun cache, chaque calendrier est relu chez AirROI.
  const depot = depotFichier(fs.mkdtempSync(path.join(os.tmpdir(), 'recapture-')))
  const client = creerClient({ depot, alerter: null, gardes: { budgetMensuelUsd: PLAFOND_USD } })
  const apres = {}
  const brut = {}
  for (const id of ids) {
    try {
      const r = await client.calendrierAnnonce(id, { horsCompte: true })
      apres[id] = r.donnees.results
      brut[id] = { recupere_le: r.recupereLe, results: r.donnees.results }
    } catch (e) {
      // Dire si l'appel a pu etre facture (review de 5876a4b).
      console.error(`  ${id} : ${e.message} — ${e.coutLibere === true ? 'non facture' : 'PEUT-ETRE FACTURE'}`)
    }
  }
  if (!Object.keys(brut).length) throw new Error('aucune capture reussie : pas de seconde photo ecrite')
  const fichier = path.join(FIX, `calendriers-comparables-${bien.slice(0, 8)}-${jour()}.json`)
  ecrireFixtureSansCle(JSON.stringify(brut), fichier, process.env.AIRROI_API_KEY || '')
  console.log(`Seconde photo : ${path.relative(path.join(__dirname, '..'), fichier)} · depense ${Math.round(client.depense.usd * 100) / 100} $`)

  console.log('\nPar comparable et par mois : semaine/week-end AVANT → APRES · nuits dont le prix a change')
  for (const l of comparer(avant, apres)) {
    if (l.absent) { console.log(`  ${l.id} : pas de seconde capture`); continue }
    if (l.nouveau) { console.log(`  ${l.id} : retenu depuis la photo d'octobre — rien a comparer`); continue }
    const f = p => `${p.se === null ? '—' : Math.round(p.se)}/${p.we === null ? '—' : Math.round(p.we)}`
    console.log(`  ${l.id.padEnd(20)} ${l.mois}  ${f(l.avant).padStart(9)} → ${f(l.apres).padEnd(9)} ${l.changes}/${l.nuits}`)
  }
  console.log('\nLecture : avril-septembre 2027 qui bougent et une prime week-end qui apparait = prix lointains pas encore regles ; inchanges = saison propre au segment.')
}

if (require.main === module) principal().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })

module.exports = { comparer }
