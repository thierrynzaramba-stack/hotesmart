// scripts/remplir-fiche-unifiee.js
// Etape 2 du chantier « migration Channex » : remplissage de la fiche unifiee.
//
// HORS CRON. Idempotent. DRY RUN par defaut.
//
// USAGE
//   node scripts/remplir-fiche-unifiee.js [--execute]
//
// SOURCE DES VALEURS
//   - `property_type` et `timezone` : le brut rapatrie (property_snapshots),
//     jamais une valeur inventee.
//   - `capacity` : le brut (maxPeople / occ_adults) — c'est lui qui corrige le
//     2 errone de « coeur de vie 23 », qui en accueille 6.
//   - `included_guests` / `extra_guest_fee` : SAISIE DE THIERRY (8 septembre
//     2026). Beds24 vend au logement et ne sert aucun supplement par voyageur.
//
// ⚠ `base_price` N'EST PAS ECRIT, ET C'EST UNE DECISION.
// Thierry n'utilise pas de prix de base : tous ses prix sont saisis par date.
// Le `rackRate` rapatrie (85 / 70) N'EST PAS son prix reel et ne doit etre
// ecrit nulle part comme tarif.

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const EXECUTE = process.argv.includes('--execute')

// Valeurs decidees par Thierry. Cle = provider_property_id.
const SAISIE = {
  '169567': { included_guests: 4, extra_guest_fee: 10 },   // coeur de vie 23, 6 pers.
  '209413': { included_guests: 2, extra_guest_fee: 0 }     // La bulle, 2 pers., pas de supplement
}

const TZ_PAR_DEFAUT = 'Europe/Paris'

function depuisLeBrut (raw) {
  const rt = (raw.roomTypes || raw.room_types || [])[0] || {}
  return {
    property_type: raw.propertyType || raw.property_type || null,
    timezone: raw.timezone || TZ_PAR_DEFAUT,
    capacity: rt.maxPeople ?? rt.occ_adults ?? null
  }
}

async function main () {
  console.log(EXECUTE ? 'MODE ECRITURE' : 'DRY RUN — aucune ecriture, --execute pour ecrire')

  const { data: biens, error } = await supabase
    .from('properties')
    .select('id, name, provider, provider_property_id, capacity, base_price, included_guests, extra_guest_fee, property_type, timezone')
    .order('name')
  if (error) throw new Error(`properties : ${error.message}`)

  const { data: bruts, error: eB } = await supabase
    .from('property_snapshots').select('provider, property_id, raw')
  if (eB) throw new Error(`property_snapshots : ${eB.message}`)

  let aEcrire = 0
  for (const b of biens) {
    const brut = (bruts || []).find(x =>
      x.provider === b.provider && String(x.property_id) === String(b.provider_property_id))
    if (!brut) { console.log(`  ${b.name} — aucun brut rapatrie, ignore`); continue }

    const duBrut = depuisLeBrut(brut.raw)
    const saisi = SAISIE[String(b.provider_property_id)] || {}
    const cible = { ...duBrut, ...saisi }

    const diff = {}
    for (const [k, v] of Object.entries(cible)) {
      if (v == null) continue
      if (String(b[k] ?? '') !== String(v)) diff[k] = { avant: b[k], apres: v }
    }

    if (!Object.keys(diff).length) { console.log(`  ${b.name.padEnd(26)} rien a changer`); continue }
    aEcrire++
    console.log(`  ${b.name.padEnd(26)} ${b.provider}`)
    for (const [k, d] of Object.entries(diff)) {
      console.log(`      ${k.padEnd(17)} ${String(d.avant).padEnd(12)} -> ${d.apres}`)
    }
    console.log(`      base_price        ${String(b.base_price).padEnd(12)} -> INCHANGE (decision de Thierry)`)

    if (EXECUTE) {
      const patch = {}
      for (const k of Object.keys(diff)) patch[k] = diff[k].apres
      const { error: e } = await supabase.from('properties').update(patch).eq('id', b.id)
      if (e) { console.log(`      ECHEC : ${e.message}`); process.exitCode = 1 }
      else console.log('      ecrit')
    }
  }
  console.log(EXECUTE ? 'termine.' : `${aEcrire} bien(s) a modifier. Relancer avec --execute.`)
}

main().catch(e => { console.error('echec :', e.message); process.exit(1) })
