// lib/cleaning/menage-fait.js — LE writer de « ce ménage est fait ».
//
// ⚠ UN SEUL WRITER PAR DOMAINE (règle du dépôt). Deux portes mènent ici, et
// elles n'ont rien d'autre en commun que l'écriture :
//   - la PWA de la prestataire (`api/menages-public.js`, jeton + ses gardes
//     de porteuse, de fenêtre et de périmètre) ;
//   - l'écran de l'hôte (`api/menages.js`, session + `menages: write`).
// Les GARDES restent chez l'appelant — elles ne se ressemblent pas. Ce qui se
// partage, c'est le geste : la ligne `menage_done` et la remise à jour de
// `property_status`. Recopier ce geste aurait fait diverger les deux chemins
// à la première correction (écart D1 de docs/specs/inventaire-menages.md :
// l'écran de l'hôte ne marquait QUE dans son navigateur).
//
// ⚠ IDEMPOTENT. La file hors ligne de la PWA rejoue, l'hôte double-clique :
// marquer deux fois ne doit rien casser et ne rien dupliquer (la contrainte
// unique porte sur user_id + property_id + booking_id + departure_date).

const { markReady } = require('../cron-property-status')

// `parToken` : le jeton de la prestataire quand c'est elle qui marque, `null`
// quand c'est l'hôte depuis son écran. ⚠ CETTE COLONNE EST UNE TRACE : elle
// seule distingue « marqué par la personne qui l'a fait » d'un geste de
// l'hôte (ou d'un rattrapage d'historique). Ne jamais y mettre autre chose.
async function marquerFait (sb, { userId, propertyId, bookingId, departureDate, parToken = null }) {
  const { error } = await sb.from('menage_done').upsert({
    user_id: userId,
    property_id: String(propertyId),
    booking_id: String(bookingId),
    departure_date: departureDate,
    done_by_token: parToken
  }, { onConflict: 'user_id,property_id,booking_id,departure_date', ignoreDuplicates: true })
  if (error) return { ok: false, message: error.message }

  // ⚠ `property_status` NE BLOQUE PAS. La ligne `menage_done` est la vérité ;
  // celle-ci n'en est qu'un reflet pour l'écran d'accueil. Une panne ici ne
  // doit pas faire croire à la prestataire que son geste n'a pas pris.
  try {
    await markReady(userId, String(propertyId))
  } catch (e) {
    console.error('[menage-fait] markReady echec', e.message)
  }
  return { ok: true }
}

async function defaireFait (sb, { userId, propertyId, bookingId, departureDate }) {
  const { error } = await sb.from('menage_done').delete()
    .eq('user_id', userId)
    .eq('property_id', String(propertyId))
    .eq('booking_id', String(bookingId))
    .eq('departure_date', departureDate)
  if (error) return { ok: false, message: error.message }

  // On recale `last_menage_at` sur le ménage fait le plus récent qui RESTE.
  // ⚠ S'il n'en reste aucun, on NE TOUCHE À RIEN : cette date peut venir
  // d'ailleurs (cron, état ancien), et l'effacer aveuglément perdrait une
  // information qu'on ne sait pas reconstruire.
  const { data: dernier } = await sb.from('menage_done')
    .select('done_at')
    .eq('user_id', userId).eq('property_id', String(propertyId))
    .order('done_at', { ascending: false }).limit(1).maybeSingle()
  if (dernier) {
    await sb.from('property_status')
      .update({ last_menage_at: dernier.done_at, updated_at: new Date().toISOString() })
      .eq('user_id', userId).eq('property_id', String(propertyId))
  }
  return { ok: true }
}

module.exports = { marquerFait, defaireFait }
