// scripts/staging-tarifs.js
// Execute docs/specs/protocole-staging-tarifs.md.
//
// ⚠ STAGING UNIQUEMENT. Le script REFUSE de demarrer si l'URL n'est pas celle
// du staging Channex. Aucune requete ne doit atteindre app.channex.io.
//
// ⚠ N'UTILISE PAS `channelCall` : ce helper lit CHANNEL_BASE_URL, c'est-a-dire
// la PRODUCTION. Client dedie, cle dediee, aucun partage possible.
//
// USAGE
//   node scripts/staging-tarifs.js            (execute et nettoie)
//   node scripts/staging-tarifs.js --garder   (n'efface pas — diagnostic)

require('dotenv').config({ path: '.env.local' })

const BASE = process.env.CHANNEX_STAGING_URL
const CLE  = process.env.CHANNEX_STAGING_API_KEY
const GARDER = process.argv.includes('--garder')

// ─── Les gardes, avant tout ──────────────────────────────────────────────────
if (!BASE || !CLE) { console.error('CHANNEX_STAGING_URL / CHANNEX_STAGING_API_KEY absentes'); process.exit(1) }
if (!/staging\.channex\.io/.test(BASE)) {
  console.error(`REFUS : l'URL de base n'est pas le staging (${BASE})`); process.exit(1)
}
// ⚠ PIEGE CONNU (memoire projet) : une URL de staging SANS /api/v1 rend 200 +
// du HTML, et se lit comme « 0 bien » — silencieusement.
if (!/\/api\/v1\/?$/.test(BASE)) {
  console.error(`REFUS : l'URL de staging doit finir par /api/v1 (${BASE})`); process.exit(1)
}

const t = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(t(), ...a)
const journal = []

async function appel (method, chemin, corps) {
  const url = BASE.replace(/\/$/, '') + chemin
  const r = await fetch(url, {
    method,
    headers: { 'user-api-key': CLE, 'Content-Type': 'application/json' },
    body: corps ? JSON.stringify(corps) : undefined
  })
  const texte = await r.text()
  let json = null
  try { json = JSON.parse(texte) } catch { /* HTML = le piege ci-dessus */ }
  const trace = { method, chemin, status: r.status, ok: r.ok }
  journal.push(trace)
  if (!json) trace.corps_non_json = texte.slice(0, 120)
  return { status: r.status, ok: r.ok, json, texte }
}

// Prix VOLONTAIREMENT improbables : si l'un d'eux apparaissait quelque part,
// on saurait immediatement d'ou il vient — jamais un tarif plausible.
const P1 = 111, P2 = 222, P3 = 333
const NOM = `ZZ-TEST-TARIFS-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`

const cree = { propriete: null, roomType: null, ratePlan: null, ratePlanNeutre: null, canal: null }

function extrait (o, cles) {
  const out = {}
  for (const k of cles) if (o && o[k] !== undefined) out[k] = o[k]
  return out
}

async function main () {
  log(`staging = ${BASE}`)
  log(`propriete de test : ${NOM}`)

  // Le POST /channels exige un `group_id` : sans lui, Channex rend 422
  // « You not have access to requested group » — une erreur de GROUPE, qui ne
  // dit rien du rate plan. Premier passage tombe dans ce piege.
  const groupes = await appel('GET', '/groups')
  const groupe = groupes.json?.data?.[0]?.id || null
  log(`group_id : ${groupe || 'AUCUN — la question 2 ne pourra pas etre tranchee'}`)

  // ═══ Q1 : la grille est-elle active des la creation du rate plan ? ═════════
  console.log('\n══ QUESTION 1 — grille active a la creation, ou au mapping ? ══')

  const p = await appel('POST', '/properties', {
    property: {
      title: NOM, currency: 'EUR', property_type: 'apartment',
      country: 'FR', zip_code: '65200', timezone: 'Europe/Paris'
    }
  })
  if (!p.ok) { log('ECHEC creation propriete', p.status, JSON.stringify(p.json).slice(0, 300)); return }
  cree.propriete = p.json?.data?.id
  log(`propriete creee : ${cree.propriete}`)

  const rt = await appel('POST', '/room_types', {
    room_type: {
      property_id: cree.propriete, title: 'Chambre test', count_of_rooms: 1,
      occ_adults: 4, occ_children: 0, occ_infants: 0, default_occupancy: 4
    }
  })
  if (!rt.ok) { log('ECHEC room_type', rt.status, JSON.stringify(rt.json).slice(0, 300)); return await nettoyer() }
  cree.roomType = rt.json?.data?.id
  log(`room_type cree : ${cree.roomType}`)

  const rp = await appel('POST', '/rate_plans', {
    rate_plan: {
      property_id: cree.propriete, room_type_id: cree.roomType,
      title: 'Grille test', currency: 'EUR', sell_mode: 'per_person',
      options: [
        { occupancy: 1, rate: P1 * 100, is_primary: false },
        { occupancy: 2, rate: P2 * 100, is_primary: false },
        { occupancy: 3, rate: P3 * 100, is_primary: false },
        { occupancy: 4, rate: P3 * 100, is_primary: true }
      ]
    }
  })
  if (!rp.ok) { log('ECHEC rate_plan', rp.status, JSON.stringify(rp.json).slice(0, 400)); return await nettoyer() }
  cree.ratePlan = rp.json?.data?.id
  log(`rate_plan cree : ${cree.ratePlan}`)

  const relu = await appel('GET', `/rate_plans/${cree.ratePlan}`)
  const attrs = relu.json?.data?.attributes || {}
  log('etat du rate plan a la creation :')
  console.log('   ', JSON.stringify(extrait(attrs, [
    'title', 'sell_mode', 'is_active', 'active', 'published', 'sync_category',
    'inherit_rate', 'auto_rate_settings', 'options'
  ])).slice(0, 700))

  const canaux = await appel('GET', '/channels')
  const nb = Array.isArray(canaux.json?.data) ? canaux.json.data.length : '?'
  log(`canaux existants sur ce compte staging : ${nb} (aucun mappe sur notre propriete de test)`)

  // ═══ Q3 : une date SANS champ rate ════════════════════════════════════════
  // Menee avant Q2 : elle ne depend pas du verdict de Q1, et c'est l'issue que
  // Thierry vise.
  console.log('\n══ QUESTION 3 — une date poussee SANS champ rate ══')

  const jour = (n) => {
    const d = new Date(); d.setDate(d.getDate() + 200 + n)
    return d.toISOString().slice(0, 10)
  }
  const commun = { property_id: cree.propriete, rate_plan_id: cree.ratePlan }
  const restrictions = {
    min_stay_arrival: 1, min_stay_through: 1, max_stay: 0,
    closed_to_arrival: false, closed_to_departure: false, stop_sell: false
  }

  // ⚠ VARIABLE CONFONDANTE DU PREMIER PASSAGE : sans disponibilite poussee, les
  // trois dates ressortaient `availability: 0`. Une date indisponible n'est pas
  // vendable quel que soit son prix — le test ne mesurait rien. On ouvre donc
  // les trois dates d'abord.
  const dispo = await appel('POST', '/availability', {
    values: [0, 1, 2].map(n => ({ property_id: cree.propriete, room_type_id: cree.roomType, date: jour(n), availability: 1 }))
  })
  log(`disponibilite ouverte sur les trois dates : HTTP ${dispo.status} ${dispo.ok ? 'OK' : 'ECHEC'}`)

  const essais = [
    ['A — avec rate', { ...commun, date: jour(0), ...restrictions, rate: P1 * 100 }],
    ['B — SANS rate', { ...commun, date: jour(1), ...restrictions }],
    ['C — rate 0',    { ...commun, date: jour(2), ...restrictions, rate: 0 }]
  ]
  for (const [nom, valeur] of essais) {
    const r = await appel('POST', '/restrictions', { values: [valeur] })
    log(`${nom.padEnd(16)} HTTP ${r.status} ${r.ok ? 'ACCEPTE' : 'REFUSE'} ${r.ok ? '' : JSON.stringify(r.json).slice(0, 260)}`)
  }

  const relecture = await appel('GET',
    `/restrictions?filter[property_id]=${cree.propriete}&filter[date][gte]=${jour(0)}&filter[date][lte]=${jour(2)}&filter[restrictions]=rate,availability`)
  log('relecture ARI, option PRIMAIRE seulement (occupancy 4) :')
  const parOption = relecture.json?.data || relecture.json || {}
  const primaire = parOption[cree.ratePlan] || {}
  for (const n of [0, 1, 2]) {
    const d = jour(n)
    const v = primaire[d] || {}
    const etiquette = ['A (avec rate 111)', 'B (SANS rate)', 'C (rate 0)'][n]
    console.log(`    ${etiquette.padEnd(20)} ${d}  rate=${v.rate}  availability=${v.availability}  raisons=${JSON.stringify(v.unavailable_reasons || [])}`)
  }

  // ═══ Q2 : un rate plan neutre traverse-t-il le mapping ? ══════════════════
  console.log('\n══ QUESTION 2 — un rate plan NEUTRE est-il mappable ? ══')

  const rpn = await appel('POST', '/rate_plans', {
    rate_plan: {
      property_id: cree.propriete, room_type_id: cree.roomType,
      title: 'Neutre test', currency: 'EUR', sell_mode: 'per_room',
      options: [{ occupancy: 4, rate: 0, is_primary: true }]
    }
  })
  log(`rate plan neutre (per_room, une option, rate 0) : HTTP ${rpn.status} ${rpn.ok ? 'ACCEPTE' : 'REFUSE'}`)
  if (!rpn.ok) console.log('   ', JSON.stringify(rpn.json).slice(0, 400))
  else cree.ratePlanNeutre = rpn.json?.data?.id

  if (cree.ratePlanNeutre) {
    if (!groupe) log('question 2 NON TRANCHEE : aucun group_id disponible sur ce compte staging')
    const ch = !groupe ? { status: 0, ok: false, json: { saute: 'pas de group_id' } } : await appel('POST', '/channels', {
      channel: {
        channel: 'BookingCom', title: NOM, is_active: false,
        group_id: groupe,
        properties: [cree.propriete],
        rate_plans: [{
          rate_plan_id: cree.ratePlanNeutre,
          settings: { occupancy: 4, pricing_type: 'OBP', primary_occ: true, rate_plan_code: 1, room_type_code: 1, readonly: false, occ_changed: false }
        }],
        settings: { hotel_id: '0000000' }
      }
    })
    log(`canal INACTIF avec le rate plan neutre : HTTP ${ch.status} ${ch.ok ? 'ACCEPTE' : 'REFUSE'}`)
    console.log('   ', JSON.stringify(ch.json).slice(0, 500))
    if (ch.ok) cree.canal = ch.json?.data?.id
  }

  await nettoyer()
}

async function nettoyer () {
  console.log('\n══ NETTOYAGE ══')
  if (GARDER) { log('--garder : rien supprime. A effacer a la main :'); console.log('   ', JSON.stringify(cree)); return }

  if (cree.canal) {
    const r = await appel('DELETE', `/channels/${cree.canal}`)
    log(`canal supprime : HTTP ${r.status}`)
  }
  if (cree.propriete) {
    const r = await appel('DELETE', `/properties/${cree.propriete}`)
    log(`propriete supprimee : HTTP ${r.status}`)
    const verif = await appel('GET', `/properties/${cree.propriete}`)
    if (verif.status === 404) log('verifie : la propriete de test a bien disparu')
    else log(`⚠ LA PROPRIETE EXISTE ENCORE (HTTP ${verif.status}) — a supprimer a la main : ${cree.propriete}`)
  }
  console.log(`\n${journal.length} appels, tous vers ${BASE}`)
}

main().catch(async e => {
  console.error('echec :', e.message)
  console.error('objets crees, a verifier :', JSON.stringify(cree))
  await nettoyer().catch(() => {})
  process.exit(1)
})
