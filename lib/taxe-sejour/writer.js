// lib/taxe-sejour/writer.js
// Spec : docs/specs/spec-taxe-sejour.md §2 (validee le 9 octobre 2026).
//
// LE WRITER UNIQUE DE `taxes_sejour`. Appele par la couche sync
// (lib/bookings-snapshot.js, juste apres l'ecriture de la reservation) et par le
// rattrapage (scripts/rattraper-taxes-sejour.js). Aucune app n'y ecrit.
//
// ⚠ FAIL-SAFE : la taxe est un ENRICHISSEMENT de la reservation. Son echec ne
// fait jamais echouer la synchro (un cycle qui saute une reservation pour une
// taxe illisible serait bien pire) : on le dit en console et on rend
// { ok: false }. La ligne sera reecrite au prochain changement de la
// reservation, ou par le rattrapage.

const { taxeSejourDe } = require('./lecture')

const TABLE = 'taxes_sejour'
const CACHE_MS = 10 * 60 * 1000

// properties.id par (compte, cle provider). Cache de module : une instance
// chaude du cron sert plusieurs cycles, un bien ne change pas d'identite.
const cacheBiens = new Map()

async function uuidDuBien (sb, userId, propertyId, maintenant = Date.now()) {
  const cle = `${userId}|${propertyId}`
  const c = cacheBiens.get(cle)
  if (c && c.expire > maintenant) return c.uuid
  const { data, error } = await sb.from('properties').select('id')
    .eq('user_id', userId).eq('provider_property_id', String(propertyId)).limit(2)
  if (error) throw new Error(`lecture du bien : ${error.message}`)
  // Zero ou deux biens : on ne devine pas, la colonne reste vide (la cle provider
  // est toujours la).
  const uuid = data && data.length === 1 ? data[0].id : null
  cacheBiens.set(cle, { uuid, expire: maintenant + CACHE_MS })
  return uuid
}

/** Pure : la ligne de `taxes_sejour` d'une reservation. */
function ligneTaxe ({ userId, bookingId, propertyId, propertyUuid = null, lu }) {
  return {
    user_id: userId,
    booking_id: String(bookingId),
    property_id: String(propertyId),
    property_uuid: propertyUuid,
    montant_cents: lu.montant_cents,
    communale_cents: lu.communale_cents,
    departementale_cents: lu.departementale_cents,
    regionale_cents: lu.regionale_cents,
    commune: lu.commune,
    collecteur: lu.collecteur,
    origine: lu.origine,
    inclus_dans_prix: lu.inclus_dans_prix,
    adultes: lu.adultes,
    nuits: lu.nuits,
    source: lu.source,
    updated_at: new Date().toISOString(),
  }
}

const tableAbsente = (e) => /taxes_sejour/.test(String(e && e.message)) && /(does not exist|schema cache)/i.test(String(e && e.message))
let absenceDite = false

/**
 * Lit la taxe dans le payload et ecrit la ligne. Ne leve jamais.
 * @returns { ok: true, ligne } | { ok: false, raison }
 */
async function ecrireTaxeSejour (sb, { userId, bookingId, propertyId, provider, snapshot, raw }) {
  try {
    if (!userId || !bookingId || !propertyId) return { ok: false, raison: 'cles_manquantes' }
    // Sans payload, rien a lire : on n'ecrase pas une ligne connue par du vide.
    if (raw === undefined || raw === null) return { ok: false, raison: 'sans_raw' }
    const lu = taxeSejourDe(snapshot, raw, provider)
    const propertyUuid = await uuidDuBien(sb, userId, propertyId)
    const ligne = ligneTaxe({ userId, bookingId, propertyId, propertyUuid, lu })
    const { error } = await sb.from(TABLE).upsert(ligne, { onConflict: 'user_id,booking_id' })
    if (error) {
      if (tableAbsente(error)) {
        if (!absenceDite) { absenceDite = true; console.error('[taxe-sejour] table taxes_sejour absente : migration 2026-10-09-taxes-sejour non appliquee') }
        return { ok: false, raison: 'table_absente' }
      }
      console.error('[taxe-sejour] ecriture echec', bookingId, error.message)
      return { ok: false, raison: 'db', erreur: error.message }
    }
    return { ok: true, ligne }
  } catch (e) {
    console.error('[taxe-sejour] exception', bookingId, e.message)
    return { ok: false, raison: 'exception', erreur: e.message }
  }
}

/**
 * Ecriture d'un LOT de lignes deja calculees par `ligneTaxe` (rattrapage).
 * Par paquets de 200 ; rend le nombre de lignes ecrites et la premiere erreur.
 * ⚠ Contrairement a `ecrireTaxeSejour`, une erreur ARRETE le lot : le
 * rattrapage est un geste humain, il doit s'arreter et le dire.
 */
async function ecrireLot (sb, lignes, { paquet = 200 } = {}) {
  let ecrites = 0
  for (let i = 0; i < lignes.length; i += paquet) {
    const tranche = lignes.slice(i, i + paquet)
    const { error } = await sb.from(TABLE).upsert(tranche, { onConflict: 'user_id,booking_id' })
    if (error) return { ecrites, erreur: error.message }
    ecrites += tranche.length
  }
  return { ecrites, erreur: null }
}

function _viderCache () { cacheBiens.clear(); absenceDite = false }

module.exports = { ecrireTaxeSejour, ecrireLot, ligneTaxe, uuidDuBien, TABLE, _viderCache }
