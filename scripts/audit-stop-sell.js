// scripts/audit-stop-sell.js
// DOC : docs/specs/spec-audit-stop-sell.md (etape 0)
//
// LECTURE SEULE. N'ECRIT RIEN — ni en base, ni chez le provider.
// Affiche le controle AVANT / APRES de la reconciliation, pour validation
// humaine avant toute ecriture.
//
// Le principe (spec §1 et §1 bis) :
//   stop_sell = intention de l'hote, memorisee, restituee a chaque poussee
//   avail     = stock, CALCULE au moment de pousser, jamais une source
//
// Conversion proposee, par nuit :
//   stop_sell(apres) = provider.stop_sell                     (amorce, une fois)
//                      OU (local.avail === 0 ET aucune resa)  (l'ancienne facon
//                                                              de dire « ferme »)
//   avail(apres)     = inventory_units − resas confirmed de la nuit
//
// USAGE : node scripts/audit-stop-sell.js [--jours 500] [--bien <uuid>]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY

const JOURS = Number((process.argv.find(a => a.startsWith('--jours=')) || '').split('=')[1] || 500)
const BIEN = (process.argv.find(a => a.startsWith('--bien=')) || '').split('=')[1] || null

// ⚠ Date LOCALE, pas UTC : `toISOString()` sur un minuit local en UTC+2 rend la
// veille, et la fenetre d'audit demarrait donc un jour trop tot (constate).
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const jour = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d }

// ─── Provider : LECTURE SEULE ────────────────────────────────────────────────
// Channex rend les restrictions par rate_plan et l'availability par room_type.
// On decoupe la fenetre : une plage de 500 jours en une requete n'est pas
// garantie, et un 400 silencieux passerait pour « rien a signaler ».
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
    // Plusieurs rate_plans peuvent repondre. Celui du bien fait foi ; les autres
    // sont compares pour signaler une divergence, jamais utilises en silence.
    const plans = Object.keys(data)
    const retenu = data[ratePlanId] || {}
    for (const [date, v] of Object.entries(retenu)) {
      out[date] = { stop_sell: !!v.stop_sell, plans: plans.length }
    }
    for (const p of plans) {
      if (p === ratePlanId) continue
      for (const [date, v] of Object.entries(data[p] || {})) {
        if (out[date] && out[date].stop_sell !== !!v.stop_sell) out[date].divergent = true
      }
    }
  }
  return out
}

async function availabilityProvider (propId, roomTypeId, debut, fin) {
  const out = {}
  for (let d = new Date(debut); d <= fin; d = jour(d, PAS)) {
    const f = jour(d, PAS - 1) > fin ? fin : jour(d, PAS - 1)
    const data = await lireProvider('/availability', {
      'filter[property_id]': propId,
      'filter[date][gte]': iso(d),
      'filter[date][lte]': iso(f)
    })
    Object.assign(out, data[roomTypeId] || {})
  }
  return out
}

// ─── Le coeur : les nuits reellement occupees ────────────────────────────────
// Un sejour 12 → 15 occupe 12, 13 et 14 — pas le 15 (KB reservation-directe §3).
async function nuitsOccupees (providerPropertyId, debut, fin) {
  const par = {}
  let de = 0
  for (;;) {
    const { data, error } = await supabase
      .from('bookings_snapshot')
      .select('booking_id, snapshot')
      .eq('property_id', String(providerPropertyId))
      .range(de, de + 999)
    if (error) throw new Error('bookings_snapshot : ' + error.message)
    for (const b of data || []) {
      const s = b.snapshot || {}
      if (s.status !== 'confirmed') continue
      if (!s.arrival || !s.departure) continue
      for (let d = new Date(s.arrival); iso(d) < s.departure; d = jour(d, 1)) {
        const j = iso(d)
        if (j < iso(debut) || j > iso(fin)) continue
        ;(par[j] || (par[j] = [])).push(b.booking_id)
      }
    }
    if (!data || data.length < 1000) break
    de += 1000
  }
  return par
}

async function memoireLocale (bienId, debut, fin) {
  const par = {}
  let de = 0
  for (;;) {
    const { data, error } = await supabase
      .from('calendar_inventory')
      .select('date, avail, stop_sell, rate')
      .eq('property_id', bienId).gte('date', iso(debut)).lte('date', iso(fin))
      .order('date').range(de, de + 999)
    if (error) throw new Error('calendar_inventory : ' + error.message)
    for (const r of data || []) par[r.date] = r
    if (!data || data.length < 1000) break
    de += 1000
  }
  return par
}

// ─── Affichage : plages, pas 500 lignes ──────────────────────────────────────
function plages (dates) {
  const t = [...dates].sort(); const out = []
  for (const d of t) {
    const p = out[out.length - 1]
    if (p && iso(jour(new Date(p[1]), 1)) === d) p[1] = d
    else out.push([d, d])
  }
  return out.map(([a, b]) => (a === b ? a : `${a} → ${b}`))
}

const resume = (l, max = 6) =>
  l.length <= max ? l.join(', ') : l.slice(0, max).join(', ') + ` … (+${l.length - max})`

;(async () => {
  const { data: biens, error } = await supabase.from('properties')
    .select('id, name, provider, provider_property_id, provider_room_type_id, provider_rate_plan_id, inventory_units')
  if (error) throw new Error('properties : ' + error.message)

  const debut = new Date(); debut.setHours(0, 0, 0, 0)
  const fin = jour(debut, JOURS - 1)
  console.log(`Fenetre : ${iso(debut)} → ${iso(fin)}  (${JOURS} jours)`)
  console.log('LECTURE SEULE — aucune ecriture, ni en base ni chez le provider.\n')

  for (const b of biens || []) {
    if (BIEN && b.id !== BIEN) continue
    console.log('═'.repeat(78))
    console.log(`${b.name}  [${b.provider}]  unites=${b.inventory_units}`)

    const local = await memoireLocale(b.id, debut, fin)
    const occ = await nuitsOccupees(b.provider_property_id, debut, fin)

    if (b.provider !== 'channex') {
      console.log('  provider non-Channex — pas de lecture d\'inventaire distante.')
      console.log(`  memoire locale : ${Object.keys(local).length} ligne(s) sur la fenetre`)
      console.log('  → question ouverte : la memoire doit-elle exister pour ce bien ?\n')
      continue
    }
    if (!b.provider_rate_plan_id || !b.provider_room_type_id) {
      console.log('  ⚠ rate_plan ou room_type absent — bien non configure, ignore.\n')
      continue
    }

    let rest, avail
    try {
      rest = await restrictionsProvider(b.provider_property_id, b.provider_rate_plan_id, debut, fin)
      avail = await availabilityProvider(b.provider_property_id, b.provider_room_type_id, debut, fin)
    } catch (e) {
      console.log('  ⚠ lecture provider impossible :', e.message, '\n')
      continue
    }

    const chgStop = [], chgAvail = [], creations = [], divergences = []
    let inchange = 0
    for (let i = 0; i < JOURS; i++) {
      const j = iso(jour(debut, i))
      const l = local[j] || null
      const p = rest[j] || null
      if (p && p.divergent) divergences.push(j)

      // stop_sell propose : le provider fait foi (amorce), sinon l'ancien avail=0
      // sans reservation, qui disait « ferme » dans la mauvaise colonne.
      const sansResa = !(occ[j] && occ[j].length)
      const ancienneFermeture = l && l.avail === 0 && sansResa
      const apresStop = p ? p.stop_sell : !!ancienneFermeture

      // avail propose : le stock, calcule. Rien d'autre.
      const apresAvail = Math.max(0, (b.inventory_units || 1) - (occ[j] ? occ[j].length : 0))

      if (!l) { creations.push(j); continue }
      if (!!l.stop_sell !== apresStop) chgStop.push([j, !!l.stop_sell, apresStop])
      if (l.avail !== apresAvail) chgAvail.push([j, l.avail, apresAvail])
      if (!!l.stop_sell === apresStop && l.avail === apresAvail) inchange++
    }

    console.log(`  memoire locale : ${Object.keys(local).length} ligne(s) — provider : ${Object.keys(rest).length} date(s) lues`)
    console.log(`  nuits occupees (confirmed) : ${Object.keys(occ).length}`)
    console.log()
    console.log('  ── AVANT (memoire locale) ──')
    console.log(`     stop_sell=true : ${Object.values(local).filter(r => r.stop_sell).length}`)
    console.log(`     avail=0        : ${Object.values(local).filter(r => r.avail === 0).length}`)
    console.log('  ── PROVIDER (etat reel, amorce) ──')
    console.log(`     stop_sell=true : ${Object.values(rest).filter(r => r.stop_sell).length}`)
    console.log(`     availability=0 : ${Object.values(avail).filter(v => v === 0).length}`)
    console.log('  ── APRES (propose) ──')
    console.log(`     lignes a creer            : ${creations.length}  ${creations.length ? resume(plages(creations)) : ''}`)
    console.log(`     stop_sell false → true    : ${chgStop.filter(c => c[2]).length}  ${resume(plages(chgStop.filter(c => c[2]).map(c => c[0])))}`)
    console.log(`     stop_sell true  → false   : ${chgStop.filter(c => !c[2]).length}  ${resume(plages(chgStop.filter(c => !c[2]).map(c => c[0])))}`)
    console.log(`     avail recalcule (change)  : ${chgAvail.length}  ${resume(plages(chgAvail.map(c => c[0])))}`)
    console.log(`     inchange                  : ${inchange}`)
    if (divergences.length) console.log(`  ⚠ rate_plans en desaccord sur stop_sell : ${resume(plages(divergences))}`)

    const ech = chgStop.slice(0, 5).concat(chgAvail.slice(0, 5))
    if (ech.length) {
      console.log('\n  echantillon (10 premieres lignes touchees) :')
      for (const [j, av, ap] of ech) console.log(`     ${j}  ${av} → ${ap}`)
    }
    console.log()
  }
  console.log('═'.repeat(78))
  console.log('Rien n\'a ete ecrit. Validation humaine requise avant l\'ecriture.')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
