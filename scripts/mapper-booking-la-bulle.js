// scripts/mapper-booking-la-bulle.js
// Pose le mapping Booking.com sur le canal de Cœur de vie « La bulle ».
//
// DRY RUN par defaut. Rien n'est envoye sans `--ecrire`.
//
// ⚠ POURQUOI UN SCRIPT ET PAS L'ENDPOINT. `api/channel-bcom-write.js`
// (`action=map`) fait la meme chose et reste le chemin produit. Ce script
// existe pour la bascule des deux biens de Bagneres, ou l'appel doit partir
// sans passer par une session authentifiee.
//
// ⚠ LES CODES VIENNENT DE L'OTA, PAS DE NOUS.
// Lus le 10 septembre 2026 par `POST /channels/mapping_details` avec
// `settings: { hotel_id: "10853342" }` — hotel_id en CHAINE. En NOMBRE le meme
// appel rend HTTP 422 `{"errors":null}`, un corps vide indiscernable d'un refus
// de l'OTA : c'est ce piege qui a fait croire que Channex n'etait pas autorise
// chez Booking. La CREATION, elle, exige un NOMBRE (chaine -> HTTP 500).
// Voir docs/CHANNEL_TECH.md.
//
//   room_type_code = rooms[].id            -> 1085334201 « One-Bedroom Apartment »
//   rate_plan_code = rooms[].rates[].id    -> 39174986   « Standard Rate »
//   pricing_type   = data.pricing_type     -> "Standard"
//   occupancy      = capacity du bien = max_persons de l'OTA -> 2
//
// ⚠ LE TARIF CIBLE EST LE DERIVE, PAS LA BASE.
// `043297fc-…` = « Cœur de vie « La bulle » — booking (derive) ». Mapper
// `1beec49b-…` (« Tarif Standard », le plan de base porte par
// properties.provider_rate_plan_id) enverrait le prix NON derive a l'OTA. Le
// canal Booking de Colomiers, seul en production, mappe bien son derive.
//
// ⚠ `is_active` N'EST PAS ENVOYE. L'activation reste un geste a part, apres le
// re-keying — sinon l'OTA pousserait sur une cle qui n'a pas encore ses donnees.
//
// USAGE : node scripts/mapper-booking-la-bulle.js [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const BASE = process.env.CHANNEL_BASE_URL, KEY = process.env.CHANNEL_API_KEY
const CH = '49528214-64fc-4f3a-8360-62b9859c23fe'
const payload = {
  channel: {
    rate_plans: [{
      rate_plan_id: '043297fc-4e8f-4127-8ed5-43546d0d9ea6', // La bulle — booking (derive)
      settings: {
        occ_changed: false,
        occupancy: 2,                 // capacity du bien = max_persons Booking
        pricing_type: 'Standard',     // mapping_details : data.pricing_type
        primary_occ: true,
        rate_plan_code: 39174986,     // rooms[].rates[].id
        readonly: false,
        room_type_code: 1085334201    // rooms[].id
      }
    }]
  }
}
;(async () => {
  if (process.argv.includes('--ecrire')) {
    const r = await fetch(`${BASE}/channels/${CH}`, {
      method: 'PUT',
      headers: { 'user-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    console.log('PUT HTTP', r.status)
    console.log((await r.text()).slice(0, 400))
  } else {
    console.log('DRY RUN — PUT /channels/' + CH)
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  const g = await fetch(`${BASE}/channels/${CH}`, { headers: { 'user-api-key': KEY } })
  const j = await g.json()
  const a = j.data?.attributes || {}
  console.log('\nPREUVE  is_active=' + a.is_active + '  hotel_id=' + JSON.stringify((a.settings||{}).hotel_id))
  console.log('rate_plans=' + JSON.stringify(a.rate_plans, null, 1))
})()
