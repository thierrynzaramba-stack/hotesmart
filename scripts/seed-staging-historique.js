#!/usr/bin/env node
// scripts/seed-staging-historique.js — UN HISTORIQUE DE VENTES POUR LA RECETTE.
// Lot 4.6.4. Le seed de staging (scripts/seed-staging.sql) cree des biens
// sans aucune reservation passee : la grille du moteur de prix n'y est jamais
// fiable (« segment sous le seuil » sur toutes les nuits), et la recette du
// mode auto-pilote ne pourrait pas voir un seul prix calcule.
//
// Ce script pose, sur UN bien de staging, deux ans de sejours SYNTHETIQUES au
// format exact des snapshots Channex/Airbnb (ce que `lib/yield/eclatement.js`
// sait lire : amount + Host Fee en notes, inserted_at, statut confirmed), avec
// une saisonnalite lisible — ete et vacances plus chers, week-ends plus chers.
// Rien d'aleatoire : meme entree, meme historique (regle du moteur).
//
// ⚠ STAGING SEULEMENT. Le projet de production est refuse, sans option. Et ces
// lignes se reconnaissent : booking_id prefixe `RECETTE-`, `raw.meta.is_seed`.
// `--purge` les retire.
//
// Usage :
//   node --env-file=.env.staging scripts/seed-staging-historique.js --bien=<uuid>          (dry-run)
//   node --env-file=.env.staging scripts/seed-staging-historique.js --bien=<uuid> --go
//   node --env-file=.env.staging scripts/seed-staging-historique.js --bien=<uuid> --purge

const { createClient } = require('@supabase/supabase-js')
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
if (projet === 'cjmrizpdyhrcurmgyrhs') { console.error('REFUS : ce script ne tourne JAMAIS sur la production.'); process.exit(1) }
const args = process.argv.slice(2)
const GO = args.includes('--go'), PURGE = args.includes('--purge')
const bienId = (args.find(a => a.startsWith('--bien=')) || '').slice(7)
if (!bienId) { console.error('--bien=<uuid> requis.'); process.exit(1) }
const sb = createClient(URL, KEY)

const decaler = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const auj = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())

// Le prix d'une nuit, deterministe : base 90, ete +40, vacances de fin d'annee
// +30, mai-juin et septembre +15, week-end +20, hiver -10.
function prixNuit (iso) {
  const m = Number(iso.slice(5, 7)), d = new Date(`${iso}T00:00:00Z`).getUTCDay()
  let p = 90
  if (m === 7 || m === 8) p += 40
  else if (m === 12 || (m === 1 && Number(iso.slice(8, 10)) <= 4)) p += 30
  else if (m === 5 || m === 6 || m === 9) p += 15
  else if (m === 1 || m === 2 || m === 11) p -= 10
  if (d === 5 || d === 6) p += 20
  return p
}

// Les sejours : un toutes les ~9 nuits sur deux ans, longueur 2 a 5 nuits,
// vendus 12 a 60 jours avant — deterministes par la date.
function genererSejours () {
  const out = []
  let debut = decaler(auj, -730)
  let k = 0
  while (debut < decaler(auj, -3)) {
    const longueur = 2 + (k % 4)              // 2,3,4,5
    const depart = decaler(debut, longueur)
    let total = 0
    for (let j = debut; j < depart; j = decaler(j, 1)) total += prixNuit(j)
    const avance = 12 + ((k * 7) % 49)         // 12..60 jours
    out.push({
      booking_id: `RECETTE-${debut.replace(/-/g, '')}`,
      arrival: debut, departure: depart, total, inserted_at: `${decaler(debut, -avance)}T10:00:00Z`,
      adultes: 1 + (k % 3)
    })
    debut = decaler(depart, 4 + (k % 5))       // 4 a 8 nuits de vide
    k++
  }
  return out
}

;(async () => {
  const { data: bien, error } = await sb.from('properties').select('id, name, user_id, provider, provider_property_id').eq('id', bienId).maybeSingle()
  if (error) { console.error('ECHEC lecture bien :', error.message); process.exit(1) }
  if (!bien) { console.error('Bien introuvable sur', projet); process.exit(1) }
  console.log(`Projet ${projet} — ${bien.name} (${bien.provider} ${bien.provider_property_id})`)
  const { data: deja } = await sb.from('bookings_snapshot').select('booking_id').eq('user_id', bien.user_id).eq('property_id', bien.provider_property_id).like('booking_id', 'RECETTE-%')
  console.log(`${(deja || []).length} sejour(s) de recette deja en place`)
  if (PURGE) {
    if (!(deja || []).length) { console.log('Rien a purger.'); return }
    const { error: eP } = await sb.from('bookings_snapshot').delete().eq('user_id', bien.user_id).eq('property_id', bien.provider_property_id).like('booking_id', 'RECETTE-%')
    if (eP) { console.error('ECHEC purge :', eP.message); process.exit(1) }
    console.log(`${deja.length} sejour(s) de recette retire(s).`); return
  }
  const sejours = genererSejours()
  const nuits = sejours.reduce((s, x) => s + Math.round((Date.parse(x.departure) - Date.parse(x.arrival)) / 86400000), 0)
  console.log(`${sejours.length} sejours synthetiques sur deux ans, ${nuits} nuits, du ${sejours[0].arrival} au ${sejours[sejours.length - 1].departure}`)
  console.log(`exemples : ${sejours.slice(0, 3).map(s => `${s.arrival}→${s.departure} ${s.total} €`).join(' · ')}`)
  if (!GO) { console.log('\nDry-run : rien n a ete ecrit. Relancer avec --go.'); return }
  const lignes = sejours.map(s => ({
    user_id: bien.user_id, booking_id: s.booking_id, property_id: bien.provider_property_id,
    snapshot: { provider: 'channex', source: 'airbnb', status: 'confirmed', arrival: s.arrival, departure: s.departure,
      guest_name: 'Voyageur de recette', numAdult: s.adultes, numChild: 0, amount: s.total, currency: 'EUR' },
    raw: { amount: String(s.total), currency: 'EUR', inserted_at: s.inserted_at, notes: 'Listing Cancellation Host Fee: 0\n',
      meta: { amount_type: 'Payout Amount', is_seed: true, is_imported: false }, ota_name: 'Airbnb', status: 'new' }
  }))
  for (let i = 0; i < lignes.length; i += 100) {
    const { error: eI } = await sb.from('bookings_snapshot').upsert(lignes.slice(i, i + 100), { onConflict: 'user_id,booking_id' })
    if (eI) { console.error('ECHEC ecriture :', eI.message); process.exit(1) }
  }
  console.log(`${lignes.length} sejour(s) ecrits. Relancer scripts/piloter-yieldflow.js pour voir la grille.`)
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
