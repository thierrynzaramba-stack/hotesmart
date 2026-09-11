// scripts/verifier-mapping-airbnb.js
// Verifie un mapping Airbnb apres coup, en LECTURE SEULE.
//
// ⚠ CE QU'ON VERIFIE, ET POURQUOI CHACUN.
//  1. le canal existe et pointe le TARIF DERIVE — mapper le tarif de base
//     enverrait le prix non derive a l'OTA, commission et min_stay perdus en
//     silence (constate deux fois le 10 septembre 2026) ;
//  2. `guests_included` / `price_per_extra_person` : le point A1. Airbnb
//     facture son supplement natif EN PLUS du prix qu'on pousse. C'est le seul
//     defaut de cette liste qui coute de l'argent au VOYAGEUR ;
//  3. 0 date ouverte a la vente — decision de Thierry jusqu'a la fin de la
//     migration verifiee. `availability = 0` ET `stop_sell = true` ;
//  4. le feed : les reservations du carnet remontent-elles bien ?
//
// USAGE : node scripts/verifier-mapping-airbnb.js

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY

const get = async (chemin) => {
  const r = await fetch(`${BASE}${chemin}`, { headers: { 'user-api-key': KEY } })
  let j = null
  try { j = await r.json() } catch { j = null }
  return { code: r.status, json: j }
}
const ok = (b) => b ? '✓' : '⛔'

const BIENS = [
  { nom: 'La bulle', fiche: '091d9abf-ff86-45ce-8123-3425e6f3900f',
    cle: '0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4', attendu: true },
  { nom: 'Cœur de vie l 23', fiche: 'efe1daf1-652c-4177-b29b-19f1db377c96',
    cle: '1655ab32-d339-413d-b8ff-b4ccbd2a7b66', attendu: true }
]

async function main () {
  const canaux = await get('/channels?pagination[limit]=50')
  const props = await get('/properties?pagination[limit]=50')
  const nomChx = {}
  for (const p of props.json?.data || []) nomChx[p.id] = p.attributes.title

  for (const B of BIENS) {
    console.log(`\n════════ ${B.nom}`)

    // ── les tarifs du bien, pour nommer la cible du mapping
    const rp = await get(`/rate_plans?filter[property_id]=${B.cle}&pagination[limit]=50`)
    const titreRp = {}
    for (const x of rp.json?.data || []) titreRp[x.id] = x.attributes.title
    const { data: liens } = await supabase.from('property_channel_rate_plans')
      .select('channel, role, provider_rate_plan_id')
      .eq('property_id', B.fiche).eq('channel', 'airbnb').eq('role', 'derived')
    const deriveAttendu = (liens || [])[0]?.provider_rate_plan_id || null

    const abnb = (canaux.json?.data || []).filter(c =>
      String(c.attributes.channel).toUpperCase() === 'AIRBNB'
      && (c.attributes.properties || []).includes(B.cle))

    if (!B.attendu) {
      console.log(`   ${ok(abnb.length === 0)} canal Airbnb ABSENT (attendu : absent jusqu'au transfert) — trouve ${abnb.length}`)
      console.log(`   ${ok(!!deriveAttendu)} lien airbnb/derived en base intact : ${deriveAttendu || 'AUCUN'}`)
      continue
    }

    console.log(`   ${ok(abnb.length === 1)} un seul canal Airbnb sur ce bien — trouve ${abnb.length}`)
    if (!abnb.length) continue
    const c = abnb[0]
    const a = c.attributes
    console.log(`      canal ${c.id}  ${JSON.stringify(a.title)}  actif=${a.is_active}`)
    console.log(`   ${ok(a.is_active === true)} canal ACTIF`)
    // ⚠ UN CANAL AIRBNB PORTE PLUSIEURS BIENS : celui de Thierry (`224cbb66`)
    // sert La bulle ET le 23, et il a donc DEUX mappings. Prendre
    // `rate_plans[0]` verifierait le bien voisin en croyant verifier celui-ci
    // — verdict vert sur le mauvais logement. On ne retient que les mappings
    // dont le tarif appartient AU BIEN LU (`titreRp` vient de
    // `/rate_plans?filter[property_id]`).
    const miens = (a.rate_plans || []).filter(x => titreRp[x.rate_plan_id] !== undefined)
    console.log(`   ${ok(miens.length === 1)} un seul mapping POUR CE BIEN — ${miens.length}`
      + `   (le canal en porte ${(a.rate_plans || []).length} au total)`)
    const m = miens[0]
    if (!m) continue

    // 1. LE BON TARIF
    const bon = m.rate_plan_id === deriveAttendu
    console.log(`   ${ok(bon)} mappe sur le tarif DERIVE`)
    console.log(`      envoye  : ${m.rate_plan_id}  ${JSON.stringify(titreRp[m.rate_plan_id] || '?')}`)
    console.log(`      attendu : ${deriveAttendu}  ${JSON.stringify(titreRp[deriveAttendu] || '?')}`)

    const s = m.settings || {}
    const p = s.pricing_setting || {}
    console.log(`      listing_id=${s.listing_id}  published=${s.published}  sync=${s.sync_category}`)

    // 2. A1 — le supplement natif Airbnb
    const { data: bien } = await supabase.from('properties')
      .select('capacity, included_guests, extra_guest_fee').eq('id', B.fiche).single()
    const gi = Number(p.guests_included)
    const pex = Number(p.price_per_extra_person)
    console.log(`\n   ── A1 : le supplement natif Airbnb`)
    console.log(`      guests_included        = ${p.guests_included}   (capacite HoteSmart : ${bien.capacity})`)
    console.log(`      price_per_extra_person = ${p.price_per_extra_person}`)
    // ⚠ L'ABSENCE DE REGLAGE N'EST PAS UNE ABSENCE DE RISQUE. Releve en review :
    // `s.pricing_setting || {}` rendait `gi`/`pex` a `NaN`, `NaN > 0` est faux,
    // donc le contrele affichait « aucun double comptage possible » SANS AVOIR
    // RIEN LU — sur le seul defaut de cette liste qui coute de l'argent au
    // voyageur. Et l'absence est un etat normal : la lecture du mapping est
    // DIFFEREE chez Channex, donc une verification lancee juste apres un
    // mapping tombe precisement dessus.
    if (!Number.isFinite(gi) || !Number.isFinite(pex)) {
      console.log(`   ⛔ reglage Airbnb PAS ENCORE LISIBLE (pricing_setting absent)`
        + ` — A1 NON VERIFIE, relancer dans quelques minutes`)
    } else {
      const risqueA1 = gi > 0 && gi < Number(bien.capacity) && pex > 0
      console.log(`   ${ok(!risqueA1)} ${risqueA1
        ? `A1 A POSER : Airbnb facturerait ${pex} € par personne au-dela de ${gi}, EN PLUS du prix pousse`
        : 'aucun double comptage possible'}`)
      if (risqueA1) process.exitCode = 1
    }

    // 3. ZERO DATE OUVERTE
    const auj = new Date().toISOString().slice(0, 10)
    const fin = new Date(Date.now() + 499 * 86400000).toISOString().slice(0, 10)
    const rr = await get(`/restrictions?filter[property_id]=${B.cle}`
      + `&filter[date][gte]=${auj}&filter[date][lte]=${fin}`
      + `&filter[restrictions]=rate,availability,stop_sell`)
    // ⚠ ON LIT LE TARIF QUE L'OTA LIT, pas le tarif de base : c'est le derive
    // qui est mappe, donc c'est lui qui decide ce qu'Airbnb affiche.
    const par = (rr.json?.data && rr.json.data[m.rate_plan_id]) || {}
    const dates = Object.keys(par)
    console.log(`\n   ── fermeture, sur le tarif MAPPE (${titreRp[m.rate_plan_id] || m.rate_plan_id})`)
    console.log(`      HTTP ${rr.code}  —  ${dates.length} dates lues`)
    // ⚠ RIEN LU N'EST PAS « TOUT FERME ». Releve en review : le verdict etait
    // `ouvertes.length === 0`, donc un tarif absent de la reponse (mapping sur
    // le tarif d'un autre bien, rate plan remappe, HTTP != 200, corps vide)
    // rendait `par = {}` et affichait ✓ sur LE controle qui compte — la
    // decision « tout ferme jusqu'a verification ».
    if (rr.code !== 200 || !dates.length) {
      console.log(`   ⛔ AUCUNE date lue pour ce tarif — la fermeture N'EST PAS VERIFIEE`
        + `  (tarifs rendus : ${Object.keys(rr.json?.data || {}).join(', ') || 'aucun'})`)
      process.exitCode = 1
    } else {
      // Un champ absent vaut INCONNU, jamais « ferme » : `Number(undefined)`
      // est `NaN` et `NaN > 0` est faux, ce qui comptait la date fermee.
      const inconnues = dates.filter(d =>
        par[d].stop_sell === undefined || !Number.isFinite(Number(par[d].availability)))
      const ouvertes = dates.filter(d => par[d].stop_sell !== true && Number(par[d].availability) > 0)
      console.log(`   ${ok(ouvertes.length === 0)} ${ouvertes.length} date(s) ouverte(s) a la vente`)
      if (ouvertes.length) console.log(`      ⚠ ${ouvertes.slice(0, 15).join(', ')}`)
      console.log(`   ${ok(inconnues.length === 0)} ${inconnues.length} date(s) au reglage ILLISIBLE (ni ouvertes ni fermees, indecidables)`)
      if (inconnues.length) console.log(`      ⚠ ${inconnues.slice(0, 15).join(', ')}`)
      console.log(`      dispo 0 : ${dates.filter(d => Number(par[d].availability) === 0).length}`
        + `   stop_sell true : ${dates.filter(d => par[d].stop_sell === true).length}`)
      if (ouvertes.length || inconnues.length) process.exitCode = 1
    }

    // 4. LE FEED
    const bk = await get(`/bookings?filter[property_id]=${B.cle}&pagination[limit]=100`)
    const resas = (bk.json?.data || []).map(x => x.attributes)
    const abnbResas = resas.filter(x => /airbnb/i.test(String(x.ota_name || '')))
    console.log(`\n   ── feed Channex : ${resas.length} reservation(s), dont ${abnbResas.length} Airbnb`)
    for (const x of abnbResas.slice(0, 10)) {
      console.log(`      ${x.arrival_date}->${x.departure_date}  ${x.ota_reservation_code}  ${x.status}  insere ${String(x.inserted_at || '').slice(0, 19)}`)
    }

    // Le carnet du coeur, pour comparer.
    // ⚠ PAGINE, ET UN TEST DU DEPOT L'EXIGE. Une lecture non bornee tronque a
    // 1 000 lignes SANS ERREUR : le verdict de ce script serait alors faux sur
    // un bien charge, et faux dans le sens rassurant — « ce sejour n'est pas
    // dans le carnet » alors qu'il y est, page suivante. Le recensement
    // `tests/bookings-snapshot-troncature.test.js` a attrape ce script.
    const bs = []
    let de = 0
    for (;;) {
      const { data, error } = await supabase.from('bookings_snapshot')
        .select('snapshot').eq('property_id', B.cle).order('booking_id').range(de, de + 499)
      if (error) { console.log(`   ⚠ lecture du carnet : ${error.message}`); break }
      bs.push(...(data || []))
      if (!data || data.length < 500) break
      de += 500
    }
    const auj2 = new Date().toISOString().slice(0, 10)
    const aVenirAbnb = (bs || []).map(x => x.snapshot || {})
      .filter(x => /airbnb/i.test(String(x.source || '')) && String(x.departure || '') > auj2
        && String(x.status || '').toLowerCase() === 'confirmed')
    console.log(`\n   ── carnet du coeur : ${aVenirAbnb.length} sejour(s) Airbnb A VENIR et confirme(s)`)
    const codesFeed = new Set(abnbResas.map(x => String(x.ota_reservation_code)))
    for (const x of aVenirAbnb) {
      const dansFeed = codesFeed.has(String(x.otaReservationCode))
      console.log(`      ${ok(dansFeed)} ${x.arrival}->${x.departure}  ${x.otaReservationCode}`
        + `  ${dansFeed ? 'present dans le feed' : 'ABSENT du feed'}`)
    }
    if (!aVenirAbnb.length) console.log('      (aucun — rien a comparer)')
  }
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
