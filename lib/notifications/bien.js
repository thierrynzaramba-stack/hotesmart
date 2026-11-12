// lib/notifications/bien.js — LE BIEN D'UNE NOTIFICATION : ses DEUX identifiants
// et son nom (PWA lot 2c-2, docs/kb/pwa.md §11).
//
// Les émetteurs passent ce qu'ils ont : le plus souvent la référence provider
// (`messages.property_id`, `agent_tasks.property_id`, cron-access…), parfois
// l'UUID. Or un membre peut avoir son périmètre en UUID : sans les deux, il ne
// serait pas prévenu d'un bien qui est pourtant le sien (lib/permissions.js,
// `dansPerimetre`).
//
// ⚠ UNE RÉFÉRENCE CHANNEX A LA FORME D'UN UUID (constat de review du 8 novembre) :
// on cherche donc D'ABORD par la référence provider, et par `properties.id`
// seulement si rien n'a été trouvé. Une lecture ratée rend ce qu'on a —
// l'alerte part quand même, avec la valeur reçue des deux côtés (elle ne peut
// désigner que ce bien).
// ⚠ TOUJOURS SUR LE COMPTE : `user_id` filtre chaque lecture.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function client () {
  return require('../cron-shared').supabase
}

async function bienDuCompte (userId, propertyId, db = client()) {
  const ref = String(propertyId)
  const estUuid = UUID.test(ref)
  // ⚠ PLUSIEURS LIGNES POSSIBLES pour une même référence sur un compte : un bien
  // archivé puis recréé (constat de review). `maybeSingle` levait, et la
  // notification perdait son nom et son UUID. On garde le bien ACTIF, sinon le
  // premier.
  const lire = async (colonne) => {
    const { data, error } = await db.from('properties')
      .select('id, name, provider_property_id, archive_le').eq('user_id', userId).eq(colonne, ref).limit(5)
    if (error) throw new Error(error.message)
    const lignes = Array.isArray(data) ? data : (data ? [data] : [])
    return lignes.find(l => !l.archive_le) || lignes[0] || null
  }
  try {
    const data = (await lire('provider_property_id')) || (estUuid ? await lire('id') : null)
    if (data) {
      return { id: data.id, ref: data.provider_property_id != null ? String(data.provider_property_id) : undefined, nom: data.name || null }
    }
  } catch (e) {
    console.error('[notifications] bien illisible :', e.message)
  }
  return { id: estUuid ? ref : undefined, ref, nom: null }
}

module.exports = { bienDuCompte }
