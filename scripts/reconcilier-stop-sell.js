// scripts/reconcilier-stop-sell.js
// DOC : docs/specs/spec-audit-stop-sell.md (etape 0)
//
// Amorce UNIQUE de la memoire d'intention, pour UN bien Channex.
// N'ecrit QUE `calendar_inventory` (memoire locale). AUCUNE ecriture chez le
// provider — la reconciliation ne pousse rien, elle enregistre.
//
// Conversion appliquee (spec §1 bis) :
//   stop_sell = provider.stop_sell OU (avail local = 0 ET aucune resa cette nuit)
//   avail     = inventory_units − resas confirmed de la nuit   (le STOCK, calcule)
//
// Les autres colonnes (rate, min_stay_*, max_stay, cta, ctd) sont RECOPIEES
// telles quelles : la reconciliation ne touche que les deux colonnes du modele.
//
// USAGE :
//   node scripts/reconcilier-stop-sell.js --bien=<uuid>              (essai a blanc)
//   node scripts/reconcilier-stop-sell.js --bien=<uuid> --ecrire     (ecrit)

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || null
const BIEN = arg('bien')
const JOURS = Number(arg('jours') || 500)
const ECRIRE = process.argv.includes('--ecrire')

// Date LOCALE, jamais UTC (minuit local en UTC+2 rendrait la veille).
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const jour = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d }
const PAS = 100

async function lireProvider (chemin, params) {
  const q = new URLSearchParams(params).toString()
  const r = await fetch(`${BASE}${chemin}?${q}`, { headers: { 'user-api-key': KEY } })
  const t = await r.text()
  if (!r.ok) throw new Error(`GET ${chemin} → HTTP ${r.status} : ${t.slice(0, 200)}`)
  return JSON.parse(t).data || {}
}

async function restrictionsProvider (propId, ratePlanId, debut, fin) {
  const out = {}
  for (let d = new Date(debut); d <= fin; d = jour(d, PAS)) {
    const f = jour(d, PAS - 1) > fin ? fin : jour(d, PAS - 1)
    const data = await lireProvider('/restrictions', {
      'filter[property_id]': propId,
      'filter[date][gte]': iso(d),
      'filter[date][lte]': iso(f),
      'filter[restrictions]': 'stop_sell'
    })
    for (const [date, v] of Object.entries(data[ratePlanId] || {})) out[date] = !!v.stop_sell
  }
  return out
}

// Les nuits reellement occupees : la regle vit dans lib/nuits-occupees.js
// (elle etait ecrite ici ET dans l'autre script du chantier — deux copies d'une
// regle metier finissent par diverger).
const { nuitsOccupees: nuitsOccupeesDuCoeur } = require('../lib/nuits-occupees')
const nuitsOccupees = (providerPropertyId, debut, fin) =>
  nuitsOccupeesDuCoeur(supabase, providerPropertyId, debut, fin)

;(async () => {
  if (!BIEN) throw new Error('--bien=<uuid> requis')

  const { data: biens, error } = await supabase.from('properties')
    .select('id, name, provider, provider_property_id, provider_room_type_id, provider_rate_plan_id, inventory_units')
    .eq('id', BIEN)
  if (error) throw new Error('properties : ' + error.message)
  const b = (biens || [])[0]
  if (!b) throw new Error('bien introuvable : ' + BIEN)
  if (b.provider !== 'channex') throw new Error(`bien ${b.provider} — l'amorce Channex ne s'applique pas`)
  if (!b.provider_rate_plan_id) throw new Error('provider_rate_plan_id absent — bien non configure')

  const debut = new Date(); debut.setHours(0, 0, 0, 0)
  const fin = jour(debut, JOURS - 1)
  console.log(`Bien   : ${b.name} (${b.id})`)
  console.log(`Fenetre: ${iso(debut)} → ${iso(fin)}  (${JOURS} jours)`)
  console.log(ECRIRE ? 'Mode   : ECRITURE (calendar_inventory uniquement)\n' : 'Mode   : ESSAI A BLANC — aucune ecriture\n')

  const rest = await restrictionsProvider(b.provider_property_id, b.provider_rate_plan_id, debut, fin)
  const occ = await nuitsOccupees(b.provider_property_id, debut, fin)

  const existantes = {}
  let de = 0
  for (;;) {
    const { data, error: e } = await supabase.from('calendar_inventory')
      .select('*').eq('property_id', b.id).gte('date', iso(debut)).lte('date', iso(fin))
      .order('date').range(de, de + 999)
    if (e) throw new Error('calendar_inventory : ' + e.message)
    for (const r of data || []) existantes[r.date] = r
    if (!data || data.length < 1000) break
    de += 1000
  }

  const lignes = []
  let creees = 0, majStop = 0, majAvail = 0, sansProvider = 0
  for (let i = 0; i < JOURS; i++) {
    const j = iso(jour(debut, i))
    const l = existantes[j]
    const nb = occ[j] ? occ[j].length : 0
    const p = rest[j]
    if (p === undefined) sansProvider++

    const ancienneFermeture = l && l.avail === 0 && nb === 0
    const stopSell = p !== undefined ? p : !!ancienneFermeture
    const avail = Math.max(0, (b.inventory_units || 1) - nb)

    if (!l) creees++
    else {
      if (!!l.stop_sell !== stopSell) majStop++
      if (l.avail !== avail) majAvail++
    }

    // Les autres colonnes sont recopiees : la reconciliation ne touche que
    // stop_sell et avail. `id` est omis : l'upsert resout par (property_id,date).
    lignes.push({
      property_id: b.id, date: j,
      stop_sell: stopSell, avail,
      rate: l ? l.rate : null,
      min_stay_arrival: l ? l.min_stay_arrival : 0,
      min_stay_through: l ? l.min_stay_through : 0,
      max_stay: l ? l.max_stay : 0,
      cta: l ? l.cta : false,
      ctd: l ? l.ctd : false,
      updated_at: new Date().toISOString()
    })
  }

  console.log(`lignes preparees        : ${lignes.length}`)
  console.log(`  a creer               : ${creees}`)
  console.log(`  stop_sell modifie     : ${majStop}`)
  console.log(`  avail recalcule       : ${majAvail}`)
  console.log(`  dates sans reponse provider (repli sur avail=0) : ${sansProvider}`)
  console.log(`  stop_sell=true apres  : ${lignes.filter(l => l.stop_sell).length}`)
  console.log(`  avail=0 apres         : ${lignes.filter(l => l.avail === 0).length}`)

  if (!ECRIRE) return console.log('\nEssai a blanc — rien n\'a ete ecrit. Relancer avec --ecrire.')

  const LOT = 200
  for (let i = 0; i < lignes.length; i += LOT) {
    const { error: e } = await supabase.from('calendar_inventory')
      .upsert(lignes.slice(i, i + LOT), { onConflict: 'property_id,date' })
    if (e) throw new Error(`upsert lot ${i / LOT + 1} : ${e.message}`)
    process.stdout.write(`\r  ecrit ${Math.min(i + LOT, lignes.length)}/${lignes.length}`)
  }
  console.log('\nEcriture terminee. Aucune poussee chez le provider.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
