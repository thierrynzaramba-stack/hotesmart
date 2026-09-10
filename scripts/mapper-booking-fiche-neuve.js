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

// ⚠ LES CIBLES SONT NOMMEES EN DUR, PAR BIEN. Un script de bascule qui prend
// un identifiant libre en argument peut mapper le mauvais logement sur le
// mauvais hotel — et un mapping errone envoie les prix d'un bien sur l'annonce
// d'un autre. On choisit par un nom court, la liste est fermee.
const CIBLES = {
  'la-bulle': {
    nom: 'La bulle',
    hotel_id: '10853342',
    propriete: '0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4',
    rate_plan_derive: 'd16d59b7-30fd-4783-b94f-7318502c3b3d',
    // Le canal de la phase 0 occupait cet hotel_id : un seul canal Channex par
    // hotel_id, la creation d'un second est refusee. Deja traite le
    // 10 septembre 2026 — laisse pour memoire, le script tolere son absence.
    ancien_canal: '49528214-64fc-4f3a-8360-62b9859c23fe'
  },
  'coeur-23': {
    nom: 'Cœur de vie l 23',
    hotel_id: '8985969',
    propriete: '1655ab32-d339-413d-b8ff-b4ccbd2a7b66',
    rate_plan_derive: 'bc2eadea-60db-4b23-a0f1-e6ade92cfda0',
    // Aucun canal de phase 0 sur cet hotel_id : rien a supprimer.
    ancien_canal: null
  }
}

const CLE = process.argv.find(a => CIBLES[a])
if (!CLE) {
  console.error(`USAGE : node scripts/mapper-booking-fiche-neuve.js <${Object.keys(CIBLES).join('|')}> [--ecrire]`)
  process.exit(1)
}
const C = CIBLES[CLE]
const ANCIEN_CANAL = C.ancien_canal
const HOTEL_ID = C.hotel_id
const PROPRIETE_NEUVE = C.propriete
const RATE_PLAN_DERIVE = C.rate_plan_derive

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

  // 2) L'ancien canal de la phase 0, s'il y en a un.
  let vieux = null
  let va = {}
  if (ANCIEN_CANAL) {
    vieux = await appel('GET', `/channels/${ANCIEN_CANAL}`)
    va = (vieux.json && vieux.json.data && vieux.json.data.attributes) || {}
    console.log(`\n── ancien canal ${ANCIEN_CANAL}`)
    console.log(`   HTTP ${vieux.status}  is_active=${va.is_active}  `
      + `rate_plans=${(va.rate_plans || []).length}  proprietes=${JSON.stringify(va.properties || [])}`)
    if (vieux.ok && va.is_active === true) {
      throw new Error('l ancien canal est ACTIF — suppression refusee, verifier a la main')
    }
    if (!vieux.ok) console.log('   (deja absent, rien a supprimer)')
  } else {
    console.log('\n── aucun ancien canal a supprimer sur cet hotel_id')
  }

  // ⚠ ET ON VERIFIE QU'AUCUN AUTRE CANAL N'OCCUPE DEJA CET hotel_id.
  // Un seul canal Channex par hotel_id : sans ce controle, la creation part et
  // se fait refuser sans dire pourquoi — c'est ce qui s'est passe le
  // 10 septembre depuis l'ecran de liaison.
  const tous = await appel('GET', '/channels?pagination[limit]=100')
  const occupe = ((tous.json && tous.json.data) || []).filter(c => {
    const a = c.attributes || {}
    return String(a.channel).toLowerCase() === 'bookingcom'
      && String((a.settings || {}).hotel_id) === String(HOTEL_ID)
      && c.id !== ANCIEN_CANAL
  })
  if (occupe.length) {
    throw new Error(`hotel_id ${HOTEL_ID} deja porte par le canal ${occupe[0].id} `
      + `(${JSON.stringify(occupe[0].attributes.title)}) — ne pas creer de doublon`)
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
      title: `Booking.com — ${C.nom}`,
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

  if (ANCIEN_CANAL && vieux && vieux.ok) {
    const sup = await appel('DELETE', `/channels/${ANCIEN_CANAL}`)
    console.log(`\nDELETE ancien canal : HTTP ${sup.status}`)
  }

  // ⚠ ON VERIFIE LA CONNEXION AVANT DE RECREER. Si la suppression avait fait
  // tomber l'autorisation cote Booking, mieux vaut le savoir ici que sur un
  // canal a moitie cree.
  const cd = await appel('POST', '/channels/connection_details',
    { channel: 'BookingCom', settings: { hotel_id: HOTEL_ID } })
  const statut = cd.json && cd.json.data && cd.json.data.attributes
    && cd.json.data.attributes.connection_status
  console.log(`connexion Booking avant creation : HTTP ${cd.status}  statut=${statut}`)
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
