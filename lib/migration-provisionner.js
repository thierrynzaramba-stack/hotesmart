// lib/migration-provisionner.js
// ETAPE « provisionner chez le nouveau provider » — assistant de migration.
// Spec : docs/specs/spec-assistant-migration.md
// Plan : docs/specs/plan-bascule-jour-j.md, phase 0.
//
// ⚠ CE N'EST PAS `api/channel-property.js` POST, ET LA DIFFERENCE EST TOUT.
// Celui-la CREE un bien neuf (INSERT dans `properties`). L'utiliser pour une
// migration creerait un SECOND bien a cote de celui qui porte l'historique —
// 784 reservations, 176 menages, 783 messages, 117 codes d'acces sur La bulle.
// Ici on DEMENAGE un bien vivant : on cree chez Channex, et on pose les
// identifiants cibles sur la ligne EXISTANTE.
//
// ⚠ `provider_property_id` N'EST PAS TOUCHE. C'est la cle de toutes les tables
// enfants ; l'ecraser maintenant couperait le bien de son historique avant meme
// que la bascule commence. L'identifiant Channex va dans
// `migration_target_property_id` ; le re-keying (phase 2.8) le promeut, en meme
// temps qu'il deplace les 14 tables — un seul geste, ou rien.
//
// ⚠ LE RATE PLAN EST CREE A 0, ET C'EST SUR.
// Mesure staging (protocole, question 2) : un rate plan `per_room` a 0 est
// accepte (HTTP 201). Et il ne peut atteindre aucune date vendable : chaque
// date part avec son prix ou FERMEE (fermeture calculee), et la garde
// d'activation refuse de publier tant que le coeur ne detient aucun prix.
// Inventer un prix de reference serait pire : il finirait par se vendre.

const { getProvider } = require('./channels')

// Ce que Channex demande pour exister. Rien de plus : le contenu editorial des
// annonces n'est pas recree, il reste chez l'OTA (elles sont CONNECTEES).
function payloadPropriete (bien) {
  return {
    property: {
      title: bien.name,
      currency: bien.currency || 'EUR',
      property_type: bien.property_type || 'apartment',
      country: bien.country || 'FR',
      zip_code: bien.zip_code || undefined,
      timezone: bien.timezone || 'Europe/Paris',
      settings: {
        allow_availability_autoupdate_on_confirmation: true,
        allow_availability_autoupdate_on_modification: false,
        allow_availability_autoupdate_on_cancellation: false
      }
    }
  }
}

function payloadRoomType (bien, proprieteId) {
  const cap = Number(bien.capacity) || 1
  return {
    room_type: {
      property_id: proprieteId,
      title: bien.name,
      count_of_rooms: 1,          // inventory_type 'whole' : une seule unite vendable
      occ_adults: cap,
      occ_children: 0,
      occ_infants: 0,
      default_occupancy: cap
    }
  }
}

function payloadRatePlan (bien, proprieteId, roomTypeId) {
  const cap = Number(bien.capacity) || 1
  const fee = Number(bien.extra_guest_fee) || 0
  const inc = Number(bien.included_guests) || cap
  // Meme formule que le provisionnement existant, mais SANS montant : les prix
  // voyagent par l'ARI, date par date. Voir l'avertissement en tete de fichier.
  if (fee > 0) {
    const options = []
    for (let i = 1; i <= cap; i++) {
      options.push({ occupancy: i, rate: 0, is_primary: i === cap })
    }
    return { rate_plan: { property_id: proprieteId, room_type_id: roomTypeId,
      title: 'Tarif Standard', currency: bien.currency || 'EUR',
      sell_mode: 'per_person', options } }
  }
  return { rate_plan: { property_id: proprieteId, room_type_id: roomTypeId,
    title: 'Tarif Standard', currency: bien.currency || 'EUR',
    sell_mode: 'per_room',
    options: [{ occupancy: cap, rate: 0, is_primary: true }] } }
}

// ⚠ LE TYPE DU PROVIDER SOURCE N'EST PAS UN TYPE DE LA CIBLE.
// Constate en production le 9 septembre 2026 : « coeur de vie 23 » est un
// `townhome` chez Beds24, et Channex a refuse la creation — HTTP 422,
// `property_type ["is invalid"]`. La fiche unifiee avait fidelement rapatrie la
// valeur source ; personne n'avait verifie que la cible l'accepte.
//
// Liste etablie par execution sur le staging (creation puis suppression de
// chaque type), et non par lecture de doc : Channex n'expose pas d'endpoint de
// reference (`/property_types` rend 404).
const TYPES_CHANNEX = new Set([
  'apartment', 'villa', 'chalet', 'hotel', 'hostel', 'guest_house'
])
// Refuses, verifies : house, townhouse, townhome, bnb, cottage.

// ⚠ CE QUI REND CETTE GARDE VITALE : l'etape ECRIT sur une ligne EXISTANTE.
// Elle n'a pas le filet d'un INSERT, qui creerait au pire une ligne de trop. Ici
// un refus manque, et c'est le bien en production qui perd ses identifiants de
// canal au profit d'une propriete neuve et vide : son ARI part ensuite dans le
// vide, sans rien pour le dire.
function raisonDeRefus (bien) {
  if (!bien) return 'bien_inconnu'
  // Un bien DEJA chez la cible n'a rien a y creer. Sans ce refus, l'action
  // ecraserait `provider_room_type_id` / `provider_rate_plan_id` d'un bien vivant
  // — Colomiers a des canaux ACTIFS.
  if (bien.provider === 'channex') return 'deja_chez_la_cible'
  if (bien.migration_target_property_id) return 'deja_provisionne'
  // Des identifiants de canal sans propriete cible : on ignore d'ou ils viennent,
  // donc on ne les ecrase pas. On le DIT, et un humain tranche.
  if (bien.provider_room_type_id || bien.provider_rate_plan_id) return 'ids_canal_deja_poses'
  if (!bien.name) return 'sans_nom'
  if (!(Number(bien.capacity) > 0)) return 'sans_capacite'
  if (!bien.property_type) return 'sans_type'      // sinon 'apartment' en dur
  // On refuse AVANT l'appel plutot que d'encaisser un 422 : l'hote doit choisir
  // un type valide, pas se voir traduire son bien en silence.
  if (!TYPES_CHANNEX.has(bien.property_type)) return 'type_non_supporte_par_la_cible'
  if (!bien.timezone) return 'sans_fuseau'
  return null
}

// Un refus qui ne dit pas QUOI FAIRE envoie chercher au hasard (spec assistant,
// §2). Le texte vit ICI, avec la regle qu'il explique — pas dans l'endpoint.
function motifDeRefus (raison, bien = {}) {
  switch (raison) {
    case 'bien_inconnu': return 'Bien introuvable.'
    case 'deja_chez_la_cible': return 'Ce logement est deja chez le nouveau provider : il n\'y a rien a y creer.'
    case 'deja_provisionne': return 'Le logement existe deja chez le nouveau provider. Pour en creer un autre, il faudrait d\'abord effacer la cible actuelle — et cela laisserait une propriete orpheline.'
    case 'ids_canal_deja_poses': return 'Ce logement porte deja des identifiants de canal (room type / rate plan) sans propriete cible. Les ecraser couperait son calendrier. Verifier d\'ou ils viennent avant tout geste.'
    case 'sans_nom': return 'Le logement n\'a pas de nom. Renseignez-le dans la fiche avant de creer la propriete.'
    case 'sans_capacite': return 'La capacite n\'est pas renseignee. Elle determine l\'occupation du room type.'
    case 'sans_type': return 'Le type de logement n\'est pas renseigne.'
    case 'type_non_supporte_par_la_cible':
      return `Le type « ${bien.property_type} » n'existe pas chez le nouveau provider. `
        + `Choisissez-en un parmi : ${[...TYPES_CHANNEX].join(', ')}.`
    case 'sans_fuseau': return 'Le fuseau horaire n\'est pas renseigne. Sans lui, les dates du calendrier glissent.'
    default: return raison
  }
}

// `appel` est injectable : les tests n'atteignent jamais le reseau.
async function provisionner (supabase, bien, { dryRun = true, appel = null } = {}) {
  const refus = raisonDeRefus(bien)
  if (refus) return { ok: false, raison: refus, message: motifDeRefus(refus, bien) }

  const plans = {
    propriete: payloadPropriete(bien),
    room_type: '(depend de la propriete creee)',
    rate_plan: '(depend du room_type cree)'
  }
  if (dryRun) {
    return {
      ok: true, dry_run: true,
      bien: { id: bien.id, nom: bien.name, provider_actuel: bien.provider },
      va_creer: plans,
      note: 'Aucun canal n\'existe : rien ne peut atteindre un OTA. '
        + 'Le rate plan est cree a 0 — les prix voyagent par l\'ARI, date par date.'
    }
  }

  const channex = getProvider('channex')
  const call = appel || channex.channelCall
  if (typeof call !== 'function') return { ok: false, raison: 'canal_indisponible',
    message: 'Le canal de distribution n\'est pas joignable depuis ce serveur (configuration absente). Rien n\'a ete cree.' }

  const p = await call('POST', '/properties', plans.propriete)
  if (!p.ok || !p.json?.data?.id) return { ok: false, raison: 'creation_propriete', http: p.status, detail: p.json,
    message: `Le nouveau provider a refuse la creation du logement (HTTP ${p.status}). Rien n'a ete cree, rien n'a bouge en base. Le detail dit quel champ il refuse.` }
  const proprieteId = p.json.data.id

  const rt = await call('POST', '/room_types', payloadRoomType(bien, proprieteId))
  if (!rt.ok || !rt.json?.data?.id) {
    // On ne laisse pas d'orphelin chez le provider.
    await call('DELETE', `/properties/${proprieteId}`).catch(() => {})
    return { ok: false, raison: 'creation_room_type', http: rt.status, detail: rt.json,
      message: `Le room type a ete refuse (HTTP ${rt.status}). La propriete creee juste avant a ete SUPPRIMEE : aucun orphelin chez le provider, rien en base.` }
  }
  const roomTypeId = rt.json.data.id

  const rp = await call('POST', '/rate_plans', payloadRatePlan(bien, proprieteId, roomTypeId))
  if (!rp.ok || !rp.json?.data?.id) {
    await call('DELETE', `/properties/${proprieteId}`).catch(() => {})
    return { ok: false, raison: 'creation_rate_plan', http: rp.status, detail: rp.json,
      message: `Le rate plan a ete refuse (HTTP ${rp.status}). La propriete creee juste avant a ete SUPPRIMEE : aucun orphelin chez le provider, rien en base.` }
  }
  const ratePlanId = rp.json.data.id

  // L'ecriture CRS (reservation directe) — non bloquante, rattrapable a la volee.
  const crs = await call('POST', '/applications/install', {
    application_installation: { property_id: proprieteId, application_code: 'booking_crs' }
  }).catch(e => ({ ok: false, status: 0, json: { error: e.message } }))

  // ⚠ UPDATE, jamais INSERT. Et `provider_property_id` reste intact.
  const { error } = await supabase.from('properties').update({
    migration_target_property_id: proprieteId,
    migration_target_at: new Date().toISOString(),
    provider_room_type_id: roomTypeId,
    provider_rate_plan_id: ratePlanId
  }).eq('id', bien.id)
  if (error) {
    // La base ne sait pas ce qui existe chez le provider : on le DIT, avec les
    // identifiants, plutot que de laisser un orphelin muet.
    return { ok: false, raison: 'ecriture_base', detail: error.message,
      message: 'Le logement a bien ete cree chez le nouveau provider, mais la base n\'a pas pu '
        + 'enregistrer ses identifiants : elle ignore donc ce qui existe la-bas. NE PAS relancer '
        + 'cette etape — elle creerait un second logement. Supprimer d\'abord les trois objets '
        + 'listes dans `a_nettoyer_chez_channex`, puis relancer.',
      a_nettoyer_chez_channex: { propriete: proprieteId, room_type: roomTypeId, rate_plan: ratePlanId } }
  }

  return {
    ok: true, dry_run: false,
    cree: { propriete: proprieteId, room_type: roomTypeId, rate_plan: ratePlanId, crs_installe: !!crs.ok },
    note: 'Le bien vise desormais une propriete Channex. `provider` et '
      + '`provider_property_id` sont INCHANGES : la bascule appartient au re-keying.'
  }
}

module.exports = { provisionner, raisonDeRefus, motifDeRefus, TYPES_CHANNEX, payloadPropriete, payloadRoomType, payloadRatePlan }
