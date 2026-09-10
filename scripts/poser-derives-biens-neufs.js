// scripts/poser-derives-biens-neufs.js
// Pose les rate plans derives (booking + airbnb) sur les biens NEUFS du plan
// « bien neuf » de Thierry, 10 septembre 2026.
//
// ⚠ POURQUOI UN SCRIPT ALORS QUE LE PROVISIONNEMENT LE FAIT MAINTENANT.
// Le correctif (api/channel-property.js etape 5) n'etait pas deploye quand
// Thierry a cree les deux fiches : elles n'ont que leur « Tarif Standard ».
// Ce script rattrape ces deux-la. Il appelle la MEME fonction que le
// provisionnement et que l'endpoint manuel — aucune logique dupliquee.
//
// DRY RUN par defaut. Rien n'est cree sans `--ecrire`.
//
// USAGE : node scripts/poser-derives-biens-neufs.js [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { poserDerivesParDefaut, CANAUX_PAR_DEFAUT } = require('../lib/rate-plans-derives')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY
const ECRIRE = process.argv.includes('--ecrire')

// Les fiches NEUVES, nommees en dur : ce script ne doit pas pouvoir toucher
// autre chose par accident.
const FICHES = [
  '091d9abf-ff86-45ce-8123-3425e6f3900f', // La bulle (neuve)
  'efe1daf1-652c-4177-b29b-19f1db377c96'  // Cœur de vie l 23 (neuve)
]

async function channelCall (method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'user-api-key': KEY, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  let json = null
  try { json = await r.json() } catch { json = null }
  return { ok: r.ok, status: r.status, json }
}

async function main () {
  console.log(ECRIRE ? 'MODE ECRITURE' : 'DRY RUN — rien ne sera cree (--ecrire pour creer)')

  const { data: biens, error } = await supabase
    .from('properties')
    .select('id, name, currency, capacity, provider, provider_property_id, '
      + 'migration_target_property_id, provider_rate_plan_id, provider_room_type_id')
    .in('id', FICHES)
  if (error) throw new Error(`properties : ${error.message}`)
  if (biens.length !== FICHES.length) {
    throw new Error(`${biens.length}/${FICHES.length} fiches trouvees — arret`)
  }

  for (const bien of biens) {
    console.log(`\n── ${bien.name}  (${bien.id})`)
    console.log(`   provider=${bien.provider}  cle=${bien.provider_property_id}`)
    console.log(`   base rate plan=${bien.provider_rate_plan_id}  room type=${bien.provider_room_type_id}`)

    if (!ECRIRE) {
      // On ne simule pas la creation : on dit ce qui serait cree, et on VERIFIE
      // que le base est lisible — c'est la seule lecture qui puisse echouer.
      const b = await channelCall('GET', `/rate_plans/${bien.provider_rate_plan_id}`)
      const a = (b.json && b.json.data && b.json.data.attributes) || {}
      console.log(`   base lisible : HTTP ${b.status}  sell_mode=${a.sell_mode}  `
        + `options=${JSON.stringify(a.options || [])}`)
      for (const canal of CANAUX_PAR_DEFAUT) {
        console.log(`   creerait : « ${bien.name} — ${canal} (dérivé) »  derive +0%, min stay herite`)
      }
      continue
    }

    const res = await poserDerivesParDefaut(supabase, channelCall, bien)
    for (const [canal, r] of Object.entries(res)) {
      console.log(`   ${canal.padEnd(8)} ${r.ok ? (r.deja ? 'DEJA' : 'CREE') : 'ECHEC'}  `
        + `${r.derivedRatePlanId || ''} ${r.ok ? '' : r.raison + ' ' + JSON.stringify(r.detail || '')}`)
    }
  }
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
