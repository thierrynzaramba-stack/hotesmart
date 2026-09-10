// scripts/corriger-mapping-vers-derive.js
// Rebascule un canal mappe sur le TARIF DE BASE vers le tarif DERIVE du canal.
//
// ⚠ POURQUOI CES MAPPINGS SONT FAUX. Les canaux de Cœur de vie l 23 ont ete
// crees depuis le tableau de bord AVANT le deploiement du correctif : la
// branche `create` de api/channel-bcom-write.js envoyait
// `properties.provider_rate_plan_id`, c'est-a-dire « Tarif Standard ». Le
// parcours Airbnb fait de meme. L'OTA lit donc le prix NON derive : la
// commission et le `min_stay` portes par `property_channel_rate_plans`
// disparaissent, en silence.
// Reference : le canal Booking de Colomiers, seul en production depuis
// juillet, mappe bien son derive.
//
// ⚠ DEUX MECANIQUES DIFFERENTES, ET CE N'EST PAS UN DETAIL.
//   Booking : `PUT /channels/:id` avec le seul `rate_plans` — mesure du
//             10 septembre, le PUT partiel fonctionne.
//   Airbnb  : JAMAIS de PUT. Les `settings` du canal contiennent les JETONS
//             OAuth, et un PUT les fait transiter. On passe par
//             `POST /channels/:id/mappings` + `DELETE .../mappings/:id`, comme
//             `action=remap_airbnb` de api/channel-rateplan.js.
//             Airbnb impose UN mapping par annonce : on supprime l'ancien
//             AVANT d'ajouter le nouveau, et on remet l'ancien si l'ajout
//             echoue — sinon l'annonce reste non mappee.
//
// DRY RUN par defaut.
// USAGE : node scripts/corriger-mapping-vers-derive.js [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY
const ECRIRE = process.argv.includes('--ecrire')

// Liste fermee, nommee en dur : un script de bascule ne prend pas d'identifiant
// libre en argument.
const A_CORRIGER = [
  // ⚠ LES DEUX PREMIERS SONT TRAITES ET LAISSES POUR MEMOIRE : le script est
  // idempotent (il saute un canal deja sur son derive) et le canal Airbnb du 23
  // a ete deconnecte depuis, par un test volontaire de Thierry — sa lecture
  // rend simplement « AUCUN mapping ».
  {
    nom: 'Booking — Cœur de vie l 23',
    canal: '2b0f16df-c0c2-4e48-85fb-da4062168904',
    type: 'booking',
    derive: 'bc2eadea-60db-4b23-a0f1-e6ade92cfda0'
  },
  {
    nom: 'Airbnb — Cœur de vie l 23 (canal deconnecte le 10/09)',
    canal: 'a42a7f18-e389-4903-b64f-e2e275adc690',
    type: 'airbnb',
    derive: '97462698-d3ea-4c70-84ec-67d0f71429ea'
  },
  // ⚠ LE PARCOURS AIRBNB POSE LE TARIF DE BASE, ET C'EST MESURE DEUX FOIS.
  // Le mapping Airbnb de La bulle, fait par Thierry le 10 septembre au soir,
  // pointait `5d35913a-…` = « Tarif Standard » au lieu de son derive. Meme
  // defaut que le parcours Booking (corrige dans api/channel-bcom-write.js), et
  // meme consequence : l'OTA lit le prix NON derive, donc la commission et le
  // min_stay portes par `property_channel_rate_plans` disparaissent en silence.
  //
  // Remapper est sans risque ici : mesure du meme soir, le derive porte deja
  // `stop_sell: true` ET `availability: 0` sur les 500 dates — la dispo est au
  // niveau du room type, donc aucun tarif ne peut vendre.
  {
    nom: 'Airbnb — La bulle',
    canal: '224cbb66-0e3f-4f4d-9a27-3071629ab27c',
    type: 'airbnb',
    derive: '6b34530e-4e2c-4232-91ba-174040d44a2b'
  }
]

async function appel (methode, chemin, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { 'user-api-key': KEY, 'Content-Type': 'application/json' },
    ...(corps ? { body: JSON.stringify(corps) } : {})
  })
  let json = null
  try { json = await r.json() } catch { json = null }
  return { ok: r.ok, status: r.status, json }
}

async function main () {
  console.log(ECRIRE ? 'MODE ECRITURE' : 'DRY RUN — rien ne part (--ecrire pour agir)')

  for (const c of A_CORRIGER) {
    const g = await appel('GET', `/channels/${c.canal}`)
    const a = (g.json && g.json.data && g.json.data.attributes) || {}
    const rps = Array.isArray(a.rate_plans) ? a.rate_plans : []
    const cur = rps[0] || null
    console.log(`\n══ ${c.nom}`)
    console.log(`   canal ${c.canal}  is_active=${a.is_active}  mappings=${rps.length}`)
    if (!cur) { console.log('   AUCUN mapping — rien a corriger ici'); continue }
    console.log(`   actuel  rate_plan_id=${cur.rate_plan_id}`)
    console.log(`   cible   rate_plan_id=${c.derive}`)
    if (cur.rate_plan_id === c.derive) { console.log('   DEJA sur le derive'); continue }

    if (c.type === 'booking') {
      // ⚠ ON NE RENVOIE QUE `rate_plans`. Renvoyer `settings` risquerait
      // d'effacer ce qu'on ne connait pas (Channex y met `machine_account` et
      // sept reglages de paiement).
      const payload = { channel: { rate_plans: [{
        rate_plan_id: c.derive,
        settings: { ...cur.settings }
      }] } }
      if (!ECRIRE) { console.log('   ferait : PUT /channels/' + c.canal); console.log('   ' + JSON.stringify(payload)); continue }
      const w = await appel('PUT', `/channels/${c.canal}`, payload)
      console.log(`   PUT HTTP ${w.status}`)
    } else {
      const ancien = cur.id
      const listing = cur.settings && cur.settings.listing_id
      if (!ancien || !listing) { console.log('   ⚠ id de mapping ou listing_id absent — abandon'); continue }
      const neuf = { mapping: { rate_plan_id: c.derive,
        settings: { listing_id: listing, primary_occ: cur.settings.primary_occ !== false } } }
      if (!ECRIRE) {
        console.log(`   ferait : DELETE /channels/${c.canal}/mappings/${ancien}`)
        console.log(`   puis   : POST   /channels/${c.canal}/mappings  ${JSON.stringify(neuf)}`)
        continue
      }
      const del = await appel('DELETE', `/channels/${c.canal}/mappings/${ancien}`)
      console.log(`   DELETE ancien mapping HTTP ${del.status}`)
      if (!del.ok) { console.log('   ancien mapping intact, on n ajoute rien'); continue }
      const add = await appel('POST', `/channels/${c.canal}/mappings`, neuf)
      console.log(`   POST nouveau mapping HTTP ${add.status}`)
      if (!add.ok) {
        console.log('   ECHEC — rollback vers l ancien tarif pour ne pas laisser l annonce non mappee')
        const rb = await appel('POST', `/channels/${c.canal}/mappings`, { mapping: {
          rate_plan_id: cur.rate_plan_id,
          settings: { listing_id: listing, primary_occ: cur.settings.primary_occ !== false } } })
        console.log(`   rollback HTTP ${rb.status}`)
        continue
      }
    }

    const apres = await appel('GET', `/channels/${c.canal}`)
    const aa = (apres.json && apres.json.data && apres.json.data.attributes) || {}
    console.log(`   PREUVE  mappings=${JSON.stringify((aa.rate_plans || []).map(x => x.rate_plan_id))}`)
    console.log(`           is_active=${aa.is_active}`)
  }
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
