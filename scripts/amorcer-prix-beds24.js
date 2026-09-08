// scripts/amorcer-prix-beds24.js
// Amorcage des PRIX PAR DATE depuis Beds24 vers `calendar_inventory.rate`.
// Prealable a la migration Channex des deux biens de Bagneres.
//
// HORS CRON. Idempotent, rejouable. DRY RUN par defaut.
//
// USAGE
//   node scripts/amorcer-prix-beds24.js [--execute] [--jours N]
//
// ⚠ N'ECRIT QUE `rate`, ET C'EST UNE DECISION.
//   - `stop_sell` : la memoire d'intention n'appartient QU'A L'HOTE (regle
//     gravee du chantier audit stop_sell). L'amorcage n'en fabrique pas.
//   - `avail` : `numAvail: 0` chez Beds24 signifie « occupe par une
//     reservation », pas « ferme ». L'ecrire inventerait une intention.
//   - `min_stay` / `max_stay` : deja deux sources
//     (property_channel_rate_plans par canal, calendar_inventory par nuit), et
//     le moteur n'en lit aucune au niveau du bien. Pas de troisieme.
//
// ⚠ CLE UUID. `calendar_inventory.property_id` porte `properties.id`, jamais
// l'identifiant provider. Piege verifie sur Colomiers.

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const EXECUTE = process.argv.includes('--execute')
const iJours = process.argv.indexOf('--jours')
const JOURS = iJours > -1 ? Number(process.argv[iJours + 1]) : 510

const BIENS = ['169567', '209413']

const t = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(t(), ...a)

// Dates en heure LOCALE, comme le reste du produit. `toISOString()` decale d'un
// jour des qu'il est plus de 22 h a Paris — constate en test le 8 septembre.
function iso (d) {
  const p = x => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function jourPlus (n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n)
  return d
}

// Beds24 rend des PLAGES (`from`/`to`), pas des dates unitaires.
function deplier (calendrier) {
  const out = []
  for (const plage of calendrier || []) {
    if (!(plage.price1 > 0)) continue          // pas de prix = rien a amorcer
    const fin = new Date(plage.to + 'T12:00:00Z')
    for (let d = new Date(plage.from + 'T12:00:00Z'); d <= fin; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push({ date: d.toISOString().slice(0, 10), rate: Number(plage.price1) })
    }
  }
  return out
}

async function main () {
  console.log(EXECUTE ? 'MODE ECRITURE' : 'DRY RUN — aucune ecriture, --execute pour ecrire')

  const { data: cle, error: eCle } = await supabase
    .from('api_keys').select('api_key')
    .eq('user_id', '85e3a0ef-75bd-4c11-a3b7-e2811067dc36').maybeSingle()
  if (eCle) throw new Error(`api_keys : ${eCle.message}`)
  if (!cle) throw new Error('aucune cle Beds24')

  const { data: biens, error: eB } = await supabase
    .from('properties').select('id, name, provider, provider_property_id')
    .in('provider_property_id', BIENS)
  if (eB) throw new Error(`properties : ${eB.message}`)

  const debut = iso(jourPlus(0))
  const fin = iso(jourPlus(JOURS))
  let totalAEcrire = 0

  for (const bien of biens) {
    console.log(`\n══ ${bien.name} (${bien.provider_property_id}) ══`)

    const url = 'https://beds24.com/api/v2/inventory/rooms/calendar'
      + `?propertyId=${bien.provider_property_id}&startDate=${debut}&endDate=${fin}`
      + '&includePrices=true&includeNumAvail=true'
    const r = await fetch(url, { headers: { token: cle.api_key } })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j || j.error) {
      log(`  LECTURE BEDS24 ECHOUEE (HTTP ${r.status}) ${JSON.stringify(j && j.error).slice(0, 160)}`)
      process.exitCode = 1
      continue
    }
    const salles = j.data || []
    if (salles.length !== 1) {
      // Un bien a plusieurs room_types casserait l'hypothese « un prix par date ».
      log(`  ⚠ ${salles.length} room_type(s) rendus — attendu 1. On s'arrete sur ce bien.`)
      process.exitCode = 1
      continue
    }

    const prix = deplier(salles[0].calendar)
    log(`  Beds24 : ${prix.length} date(s) tarifee(s) entre ${debut} et ${fin}`)
    if (!prix.length) { log('  rien a amorcer'); continue }
    log(`  couverture : ${prix[0].date} → ${prix[prix.length - 1].date}`)

    // Ce que le coeur porte deja, pour ne rien ecraser inutilement.
    const { data: existant, error: eI } = await supabase
      .from('calendar_inventory').select('date, rate')
      .eq('property_id', bien.id)
      .gte('date', prix[0].date).lte('date', prix[prix.length - 1].date)
    if (eI) throw new Error(`calendar_inventory : ${eI.message}`)
    const dejaLa = {}
    ;(existant || []).forEach(x => { dejaLa[x.date] = x.rate })

    const aEcrire = prix.filter(p => Number(dejaLa[p.date]) !== p.rate)
    const identiques = prix.length - aEcrire.length
    log(`  coeur   : ${identiques} identique(s), ${aEcrire.length} a ecrire`)
    totalAEcrire += aEcrire.length

    console.log('  ── ECHANTILLON DE CONTROLE (a comparer au calendrier Beds24) ──')
    const pas = Math.max(1, Math.floor(prix.length / 5))
    for (let i = 0; i < prix.length && i / pas < 5; i += pas) {
      const p = prix[i]
      const avant = dejaLa[p.date]
      console.log(`     ${p.date}   Beds24 = ${p.rate} €   coeur = ${avant == null ? '(vide)' : avant + ' €'}`)
    }

    if (!EXECUTE) continue

    // Ecriture par lots, `rate` SEUL. `onConflict` sur la cle naturelle.
    const LOT = 100
    let ecrites = 0
    for (let i = 0; i < aEcrire.length; i += LOT) {
      const lot = aEcrire.slice(i, i + LOT).map(p => ({
        property_id: bien.id, date: p.date, rate: p.rate
      }))
      const { error } = await supabase
        .from('calendar_inventory').upsert(lot, { onConflict: 'property_id,date' })
      if (error) { log(`  ECRITURE ECHOUEE : ${error.message}`); process.exitCode = 1; break }
      ecrites += lot.length
    }
    log(`  ecrites : ${ecrites}`)
  }

  console.log(EXECUTE
    ? '\ntermine.'
    : `\n${totalAEcrire} date(s) a ecrire au total. Comparez l'echantillon a votre calendrier Beds24, puis --execute.`)
}

main().catch(e => { console.error('echec :', e.message); process.exit(1) })
