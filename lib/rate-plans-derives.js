// lib/rate-plans-derives.js
// Le tarif DERIVE d'un canal : creation et lignes de liaison.
//
// ⚠ POURQUOI CE MODULE EXISTE, ET CE QUE SON ABSENCE COUTAIT.
// Cette logique vivait uniquement dans `api/channel-rateplan.js`
// (`action=create_derived`), atteignable seulement a la main. Rien ne
// l'appelait a la creation d'un bien. Un logement neuf naissait donc avec son
// seul « Tarif Standard » :
//
//   - aucune ligne dans `property_channel_rate_plans`, donc aucune regle de
//     prix par canal — la commission Booking et le `min_stay` n'avaient nulle
//     part ou vivre ;
//   - et surtout, RIEN A MAPPER. Le mapping Booking doit pointer le tarif
//     DERIVE du canal, jamais la base (mesure du 10 septembre 2026 sur le canal
//     de Colomiers, le seul en production). Depuis que `action=map` refuse en
//     l'absence de derive, un bien neuf etait litteralement inconnectable a
//     Booking.
//
// Le defaut ne concernait pas que la migration de Bagneres : il touchait TOUT
// nouvel hote. Colomiers ne l'avait pas revele parce que ses derives avaient
// ete crees a la main.
//
// ⚠ IDEMPOTENT. Un derive deja present est rendu tel quel, sans second appel
// Channex : le provisionnement peut etre rejoue, et l'endpoint manuel reste
// utilisable sur un parc existant.
//
// ⚠ LA BASE N'EST LIEE A AUCUN OTA. Elle prend une ligne sentinelle
// `channel='base'`, ce qui garde `unique(property_id, channel)` propre. Chaque
// OTA a son derive. Ce modele est celui de Colomiers.

const { proprieteChezLeProvider } = require('./rate-sync')

// Les canaux qu'un bien neuf doit avoir d'emblee.
const CANAUX_PAR_DEFAUT = ['booking', 'airbnb']

// Cree le tarif derive de `canal` pour `bien`, et pose les lignes de liaison.
//
// `bien` doit porter : id, name, currency, capacity, provider,
// provider_property_id, migration_target_property_id, provider_rate_plan_id,
// provider_room_type_id.
//
// Rend { ok: true, deja: bool, derivedRatePlanId, sellMode } ou
//      { ok: false, raison, http, detail }.
async function creerDerive (supabase, channelCall, bien, canal) {
  const base = bien && bien.provider_rate_plan_id
  const roomType = bien && bien.provider_room_type_id
  if (!base || !roomType) {
    return { ok: false, raison: 'provisionnement_incomplet', http: 400,
      detail: 'Bien sans base rate plan / room type' }
  }

  // ⚠ `role='derived'` DANS LE FILTRE : sans lui, la ligne sentinelle
  // `channel='base'` pourrait etre prise pour un derive.
  const { data: existant, error: eLire } = await supabase
    .from('property_channel_rate_plans')
    .select('id, provider_rate_plan_id')
    .eq('property_id', bien.id).eq('channel', canal).eq('role', 'derived')
    .maybeSingle()
  if (eLire) return { ok: false, raison: 'lecture', http: 500, detail: eLire.message }
  if (existant && existant.provider_rate_plan_id) {
    return { ok: true, deja: true, derivedRatePlanId: existant.provider_rate_plan_id }
  }

  // On clone le sell_mode et la structure d'occupation du base : un derive qui
  // vend « par personne » alors que le base vend « par chambre » enverrait des
  // prix qui ne veulent rien dire.
  const b = await channelCall('GET', `/rate_plans/${base}`)
  if (!b.ok) return { ok: false, raison: 'lecture_base', http: 502, detail: b.status }
  const battr = (b.json && b.json.data && b.json.data.attributes) || {}
  const sellMode = battr.sell_mode || 'per_room'
  const baseOptions = Array.isArray(battr.options) ? battr.options : []
  const childOptions = (baseOptions.length
    ? baseOptions
    : [{ occupancy: bien.capacity || 4, is_primary: true }]
  ).map(o => ({
    occupancy: o.occupancy,
    is_primary: !!o.is_primary,
    derived_option: { rate: [['increase_by_percent', '0']] }
  }))

  // L'enfant est NEUTRE : +0 %, min stay herite. Il ne change rien tant que
  // l'hote n'a pas pose sa regle.
  const c = await channelCall('POST', '/rate_plans', {
    rate_plan: {
      property_id: proprieteChezLeProvider(bien) || bien.provider_property_id,
      room_type_id: roomType,
      title: `${bien.name || 'Bien'} — ${canal} (dérivé)`,
      currency: bien.currency || 'EUR',
      sell_mode: sellMode,
      rate_mode: 'derived',
      parent_rate_plan_id: base,
      inherit_rate: true,
      inherit_min_stay_arrival: true,
      inherit_min_stay_through: true,
      options: childOptions
    }
  })
  if (!c.ok) {
    return { ok: false, raison: 'creation_enfant', http: 502, detail: c.json || c.status }
  }
  const childId = c.json && c.json.data && c.json.data.id
  if (!childId) return { ok: false, raison: 'pas_d_id', http: 502 }

  const rows = [
    { property_id: bien.id, channel: 'base', role: 'base',
      provider_rate_plan_id: base, derive_mode: null, derive_value: 0, is_active: true },
    { property_id: bien.id, channel: canal, role: 'derived',
      provider_rate_plan_id: childId, derive_mode: 'percent', derive_value: 0,
      min_stay: null, is_active: true }
  ]
  const { error: eUp } = await supabase
    .from('property_channel_rate_plans')
    .upsert(rows, { onConflict: 'property_id,channel' })
  if (eUp) {
    // ⚠ L'ENFANT EXISTE DEJA CHEZ LE PROVIDER. On le dit, plutot que de
    // rendre un echec sec : sans cette information, un second passage
    // creerait un DEUXIEME enfant, et le mapping n'aurait plus de cible
    // unique (refus 409 de choisirTarifDerive).
    return { ok: false, raison: 'liaison_db', http: 500,
      detail: eUp.message, derivedRatePlanId: childId }
  }

  return { ok: true, deja: false, derivedRatePlanId: childId, sellMode }
}

// Pose les derives de tous les canaux par defaut. Utilise au provisionnement.
//
// ⚠ NON BLOQUANT, COMME LES INSTALLATIONS D'APPLICATIONS. Un bien dont le
// derive Booking a echoue reste utilisable ; il n'est simplement pas
// connectable a Booking tant que ce n'est pas rattrape. L'echec est RENDU a
// l'appelant, jamais avale : c'est ce silence-la qui a laisse le trou ouvert.
async function poserDerivesParDefaut (supabase, channelCall, bien, canaux) {
  const liste = Array.isArray(canaux) && canaux.length ? canaux : CANAUX_PAR_DEFAUT
  const resultats = {}
  for (const canal of liste) {
    try {
      resultats[canal] = await creerDerive(supabase, channelCall, bien, canal)
    } catch (e) {
      resultats[canal] = { ok: false, raison: 'exception', detail: e.message }
    }
    if (!resultats[canal].ok) {
      console.error('[rate-plans-derives] derive', canal, 'echoue :',
        resultats[canal].raison, JSON.stringify(resultats[canal].detail || ''))
    }
    // ⚠ UN ECHEC DE LIAISON ARRETE LA BOUCLE, ET CE N'EST PAS DE LA PRUDENCE.
    // `liaison_db` signale un probleme de SCHEMA, pas de canal : l'upsert
    // exige l'index unique (property_id, channel), et sans lui Postgres rend
    // 42P10 sur l'`ON CONFLICT`. Continuer sur le canal suivant creerait alors
    // un SECOND enfant chez le provider sans plus l'enregistrer — deux rate
    // plans orphelins par creation de bien, et deux de plus a chaque tentative.
    // `choisirTarifDerive` refuserait ensuite en 409 sur doublon : le bien
    // deviendrait DEFINITIVEMENT inconnectable, l'inverse exact du trou que ce
    // module ferme. Releve en review le 10 septembre 2026.
    // (Verifie le meme jour : l'index existe bien sur cette base. La garde vaut
    // pour une installation neuve, ou si l'index venait a disparaitre.)
    if (resultats[canal].raison === 'liaison_db') {
      resultats.arret = 'liaison_db : index unique (property_id, channel) manquant ?'
      break
    }
  }
  return resultats
}

module.exports = { creerDerive, poserDerivesParDefaut, CANAUX_PAR_DEFAUT }
