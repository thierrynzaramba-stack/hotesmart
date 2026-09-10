// scripts/mapper-booking-fiche-neuve.js
// Remplace le canal Booking de la phase 0 par celui de la fiche NEUVE, mappe.
//
// ⚠ POURQUOI UNE SUPPRESSION EST NECESSAIRE. Un `hotel_id` Booking ne peut
// porter qu'un canal Channex : celui de la propriete de phase 0
// (`3197fbfc-…`) l'occupe. La creation d'un second a ete refusee le
// 10 septembre. Mesure du meme jour : supprimer puis recreer un canal ne fait
// PAS perdre la connexion cote Booking — elle est restee « XML Active » avec
// les huit scopes.
//
// ⚠ hotel_id en NOMBRE a la creation, en CHAINE a la lecture. Voir
// docs/CHANNEL_TECH.md : c'est l'inverse selon l'appel, et un nombre envoye a
// `mapping_details` rend un 422 a corps vide, indiscernable d'un refus d'OTA.
//
// ⚠ LE CANAL EST CREE INACTIF, ET CA COMPTE. Un canal actif livrerait des
// reservations avant le transfert des donnees : le meme sejour existerait sous
// deux `booking_id`, et `lib/cleaning/sync-menages-entite.js` n'a aucune
// deduplication par empreinte de sejour — deux menages pour un depart, en
// silence. L'activation vient APRES le transfert.
//
// DRY RUN par defaut. USAGE : node scripts/mapper-booking-fiche-neuve.js [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const BASE = process.env.CHANNEL_BASE_URL
const KEY = process.env.CHANNEL_API_KEY
const ECRIRE = process.argv.includes('--ecrire')

const ANCIEN_CANAL = '49528214-64fc-4f3a-8360-62b9859c23fe'
const HOTEL_ID = '10853342'
const PROPRIETE_NEUVE = '0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4'
const RATE_PLAN_DERIVE = 'd16d59b7-30fd-4783-b94f-7318502c3b3d'

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

  // 1) Les codes de l'OTA, relus a l'instant. On ne les code jamais en dur :
  // Booking peut les changer, et un mapping sur un code perime est un mapping
  // muet.
  const md = await appel('POST', '/channels/mapping_details',
    { channel: 'BookingCom', settings: { hotel_id: HOTEL_ID } })
  if (!md.ok) {
    throw new Error(`mapping_details HTTP ${md.status} — ${JSON.stringify(md.json)}`)
  }
  const d = md.json.data || {}
  const room = (d.rooms || [])[0]
  const rate = room && (room.rates || [])[0]
  if (!room || !rate) throw new Error('aucune chambre/tarif chez Booking')
  console.log(`\n── codes lus chez Booking (hotel_id ${HOTEL_ID})`)
  console.log(`   chambre  ${room.id}  ${JSON.stringify(room.title)}`)
  console.log(`   tarif    ${rate.id}  ${JSON.stringify(rate.title)}  max_persons=${rate.max_persons}`)
  console.log(`   pricing  ${d.pricing_type}`)

  // 2) L'ancien canal, celui de la phase 0.
  const vieux = await appel('GET', `/channels/${ANCIEN_CANAL}`)
  const va = (vieux.json && vieux.json.data && vieux.json.data.attributes) || {}
  console.log(`\n── ancien canal ${ANCIEN_CANAL}`)
  console.log(`   HTTP ${vieux.status}  is_active=${va.is_active}  `
    + `rate_plans=${(va.rate_plans || []).length}  proprietes=${JSON.stringify(va.properties || [])}`)
  if (vieux.ok && va.is_active === true) {
    throw new Error('l ancien canal est ACTIF — suppression refusee, verifier a la main')
  }

  // 3) LE GROUP_ID DE LA PROPRIETE, LU CHEZ LE PROVIDER.
  // ⚠ IL EST EXIGE A LA CREATION ET ABSENT EN LECTURE — un canal existant ne
  // le rend pas dans ses attributs (docs/CHANNEL_TECH.md). Il ne vient d'aucune
  // variable d'environnement : `api/channel-bcom-write.js` le resout par
  // `GET /groups` en cherchant le groupe qui porte la propriete. J'avais
  // d'abord ecrit `process.env.CHANNEL_GROUP_ID`, qui n'existe pas : la cle
  // aurait disparu du JSON et la creation serait partie sans, pour un 422
  // « You not have access to requested group ».
  const grp = await appel('GET', '/groups')
  const groupes = Array.isArray(grp.json && grp.json.data) ? grp.json.data : []
  const mien = groupes.find(g => {
    const rel = g.relationships && g.relationships.properties && g.relationships.properties.data
    return Array.isArray(rel) && rel.some(x => String(x.id) === String(PROPRIETE_NEUVE))
  })
  if (!mien) {
    throw new Error(`aucun groupe ne porte la propriete ${PROPRIETE_NEUVE} `
      + `(GET /groups HTTP ${grp.status}, ${groupes.length} groupe(s))`)
  }
  console.log(`\n── group_id : ${mien.id}  ${JSON.stringify((mien.attributes || {}).title)}`)

  const payload = {
    channel: {
      channel: 'BookingCom',
      title: 'Booking.com — La bulle',
      is_active: false,
      group_id: mien.id,
      properties: [PROPRIETE_NEUVE],
      known_mappings_list: [],
      rate_plans: [{
        rate_plan_id: RATE_PLAN_DERIVE,
        settings: {
          occ_changed: false,
          occupancy: rate.max_persons || 2,
          pricing_type: d.pricing_type || 'Standard',
          primary_occ: true,
          rate_plan_code: rate.id,
          readonly: false,
          room_type_code: room.id
        }
      }],
      settings: { hotel_id: Number(HOTEL_ID) }
    }
  }

  if (!ECRIRE) {
    console.log(`\n── ferait : DELETE /channels/${ANCIEN_CANAL}`)
    console.log('── puis   : POST /channels')
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  const sup = await appel('DELETE', `/channels/${ANCIEN_CANAL}`)
  console.log(`\nDELETE ancien canal : HTTP ${sup.status}`)

  // ⚠ ON VERIFIE LA CONNEXION AVANT DE RECREER. Si la suppression avait fait
  // tomber l'autorisation cote Booking, mieux vaut le savoir ici que sur un
  // canal a moitie cree.
  const cd = await appel('POST', '/channels/connection_details',
    { channel: 'BookingCom', settings: { hotel_id: HOTEL_ID } })
  const statut = cd.json && cd.json.data && cd.json.data.attributes
    && cd.json.data.attributes.connection_status
  console.log(`connexion Booking apres suppression : HTTP ${cd.status}  statut=${statut}`)
  if (statut !== 'XML Active') {
    throw new Error('la connexion Booking n est plus active — NE PAS recreer, verifier l extranet')
  }

  const cre = await appel('POST', '/channels', payload)
  console.log(`\nPOST /channels : HTTP ${cre.status}`)
  const id = cre.json && cre.json.data && cre.json.data.id
  if (!cre.ok || !id) {
    console.log(JSON.stringify(cre.json, null, 2))
    throw new Error('creation echouee')
  }

  const apres = await appel('GET', `/channels/${id}`)
  const aa = (apres.json && apres.json.data && apres.json.data.attributes) || {}
  console.log(`\nPREUVE canal ${id}`)
  console.log(`   is_active=${aa.is_active}  (doit etre false)`)
  console.log(`   hotel_id=${JSON.stringify((aa.settings || {}).hotel_id)}`)
  console.log(`   rate_plans=${JSON.stringify(aa.rate_plans || [], null, 1)}`)
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
