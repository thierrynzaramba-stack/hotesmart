#!/usr/bin/env node
/* Force UN passage du releve des comparables. À BLANC par défaut ; `--go` écrit.
 *
 * Usage :
 *   ENV_FILE=/chemin/.env.staging node scripts/relever-comparables.js
 *   ENV_FILE=/chemin/.env.staging node scripts/relever-comparables.js --go
 *
 * ⚠ IL REFUSE LA PRODUCTION, ET C'EST SA PREMIÈRE LIGNE DE DÉFENSE. Ce script
 * DÉPENSE de l'argent (0,10 $ par appel AirROI) et ÉCRIT en base. Un `.env`
 * mal collé est la menace réelle — pas un attaquant. `lib/empreinte-base.js`
 * nomme la base ; si c'est la production, on s'arrête avant tout.
 *
 * ⚠ ET IL NE RELÈVE QU'UN LOGEMENT, comme le cron : le coût est réel et les
 * garde-fous AirROI sont partagés avec l'étude de marché. Pour en faire
 * plusieurs, on relance — chaque passage prend le bien suivant.
 */
const fs = require('fs')
const path = require('path')

const envFile = process.env.ENV_FILE
if (!envFile) {
  console.error('ECHEC : ENV_FILE est obligatoire. Exemple :')
  console.error('  ENV_FILE=~/hotesmart/.env.staging node scripts/relever-comparables.js')
  process.exit(2)
}
for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const i = l.indexOf('=')
  if (i <= 0 || l.trim().startsWith('#')) continue
  // Les guillemets et le retour chariot Windows, sinon l'URL est invalide.
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/\r$/, '').replace(/^["']|["']$/g, '')
}

const { nomDeLaBase, estLaProduction } = require(path.join('..', 'lib', 'empreinte-base'))
const url = process.env.SUPABASE_URL || ''
const nom = nomDeLaBase(url)

// ⚠ LE REFUS EST COLLÉ AU TEST, et `tests/empreinte-base.test.js` l'exige :
// la garde doit se lire d'un coup d'œil, sans que quatre lignes de message
// séparent la condition de la sortie. Le détail s'imprime AVANT.
const POURQUOI = [
  'Ce script dépense de l argent et écrit en base : il ne tourne que sur staging.',
  'Pour la production, ce n est pas ce script — c est le cron, qui a sa cadence',
  'et ses garde-fous.'
]
if (estLaProduction(url)) { console.error(`REFUS : base de PRODUCTION (${nom}).`, '\n' + POURQUOI.join('\n')); process.exit(3) }
// ⚠ `INCONNUE` EN MAJUSCULES, et j'avais écrit `'inconnue'`. `nomDeLaBase` ne
// rend QUE 'PRODUCTION', 'STAGING' ou 'INCONNUE', jamais une chaîne vide :
// `!nom` était donc toujours faux et la comparaison toujours fausse. Le refus
// était du CODE MORT, et le test du dépôt ne le voyait pas parce que l'autre
// branche (`estLaProduction`) satisfaisait à elle seule le motif de garde.
// Un `.env` pointant un projet Supabase valide mais non reconnu — un ancien
// projet, une instance recopiée, une `DATABASE_URL` collée dans `SUPABASE_URL`
// — serait parti en appels payants sur une base que personne ne peut nommer.
if (nom !== 'PRODUCTION' && nom !== 'STAGING') { console.error(`REFUS : base « ${nom} » non reconnue. Un résultat sans base nommée ne vaut rien.`); process.exit(3) }

const aGo = process.argv.includes('--go')
console.log(`Base : ${nom}`)
console.log(aGo ? 'Mode : RÉEL — le relevé sera écrit.' : 'Mode : À BLANC — rien ne sera écrit ni appelé.')
console.log('')

const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(url, process.env.SUPABASE_SERVICE_KEY)
const { releverSiDu } = require(path.join('..', 'lib', 'marche', 'comparables-releves'))

;(async () => {
  // ⚠ À BLANC, ON NE CONSTRUIT MÊME PAS LE CLIENT AIRROI : on montre ce qui
  // SERAIT fait. Un « à blanc » qui appellerait le provider aurait déjà payé.
  if (!aGo) {
    const { data: retenus, error } = await supabase
      .from('comparables_retenus').select('property_id, listing_id').eq('actif', true).limit(2001)
    if (error) { console.error('Lecture impossible :', error.message); process.exit(1) }
    const mois = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date()).slice(0, 7)
    const { data: faits } = await supabase
      .from('comparables_releves').select('property_id').gte('created_at', `${mois}-01T00:00:00Z`).limit(20000)
    const dejaFaits = new Set((faits || []).map(x => String(x.property_id)))
    const parBien = new Map()
    for (const r of retenus || []) {
      const k = String(r.property_id)
      if (!parBien.has(k)) parBien.set(k, [])
      parBien.get(k).push(String(r.listing_id))
    }
    const cible = [...parBien.entries()].find(([k]) => !dejaFaits.has(k))
    console.log(`logements avec comparables actifs : ${parBien.size}`)
    console.log(`déjà relevés ce mois-ci (${mois})   : ${dejaFaits.size}`)
    if (!cible) { console.log('\nRien à relever : tout le parc est fait ce mois-ci.'); return }
    const [bien, listings] = cible
    console.log(`\nLe prochain passage prendrait : ${bien}`)
    console.log(`  ${listings.length} comparable(s), 2 appels chacun`)
    // ⚠ LE TARIF SE LIT, IL NE SE RECOPIE PAS. Un nombre écrit à la main dans
    // le script dont le rôle est d'annoncer la dépense avant de la faire est
    // exactement ce qui finit par mentir le jour où le tarif change.
    const { tarif } = require(path.join('..', 'lib', 'airroi', 'cout'))
    const parComparable = tarif('GET /listings/metrics/all') + tarif('GET /listings/live/calendar')
    const { PLAFOND_RELEVE_MOIS_USD } = require(path.join('..', 'lib', 'marche', 'comparables-releves'))
    console.log(`  coût maximal estimé : ${(listings.length * parComparable).toFixed(2)} $`)
    console.log(`  plafond du relevé   : ${PLAFOND_RELEVE_MOIS_USD.toFixed(2)} $ par logement et par mois`)
    console.log('\nRelancer avec --go pour l écrire.')
    return
  }

  const { creerClient } = require(path.join('..', 'lib', 'airroi', 'client'))
  const { depotSupabase } = require(path.join('..', 'lib', 'airroi', 'depot'))
  const { PLAFOND_RELEVE_90J_USD } = require(path.join('..', 'lib', 'marche', 'comparables-releves'))
  const MARQ = 'comparables_releves'
  const resultats = { errors: [] }
  const bilan = await releverSiDu(resultats, {
    supabase,
    // Le même plafond que le cron : le script ne doit pas pouvoir dépenser
    // ce que le cron ne dépenserait pas.
    client: () => creerClient({
      depot: depotSupabase(supabase),
      gardes: { plafondBien90jUsd: PLAFOND_RELEVE_90J_USD }
    }),
    // ⚠ CE QUI EMPÊCHE DE REPAYER, C'EST LE FILTRE PAR BIEN, pas un drapeau.
    // J'avais passé `forcer: true` et un `marqueur.lire` : le module ne lit ni
    // l'un ni l'autre depuis que la cadence est par bien. Deux clés mortes et
    // un commentaire qui décrivait un mécanisme disparu. Ce qui reste vrai, et
    // qui suffit : un bien déjà relevé ce mois-ci est sauté, donc dix
    // lancements ne paient jamais deux fois le même relevé.
    marqueur: {
      ecrire: async (iso, ecrites) => {
        await supabase.from('cron_logs').upsert({
          id: MARQ, last_run: iso, total_messages: ecrites || 0, total_replies: 0, errors: []
        }, { onConflict: 'id' })
      }
    }
  })
  console.log('bilan :', JSON.stringify(bilan))
  if (resultats.errors.length) {
    console.log('\nerreurs :')
    for (const e of resultats.errors) console.log('  -', e.error)
  }
  // ⚠ UN SKIP N'EST PAS UN SUCCÈS : on sort en 1 pour que l appelant le voie.
  if (bilan && bilan.skipped) { console.log(`\n(aucun relevé : ${bilan.skipped})`); process.exit(1) }
})().catch(e => { console.error('ECHEC :', e && e.message); process.exit(1) })
