// lib/bookings-snapshot.js
// DOC : docs/kb/bookings-snapshot.md (modif = MEME COMMIT)
// SEUL WRITER AUTORISÉ de la table `bookings_snapshot`.
//
// Pourquoi ce module (audit d'unification, écarts E3/E4/E5) : cinq writers
// écrivaient la même ligne avec des schémas différents (7 champs côté
// lib/cron-bookings.js, 12 ou 13 ailleurs) et des vocabulaires de statut
// divergents (Beds24 `black`/`inquiry` vs Channex `new`/`modified`). Résultat :
// snapshot non déterministe selon l'ordre d'exécution du cron, et ménages
// fantômes sur les statuts non reconnus par les lecteurs.
//
// Règles :
//  1. Schéma unique et complet (voir EMPTY_SNAPSHOT), `provider` TOUJOURS rempli.
//  2. Statut canonique normalisé à l'écriture (confirmed|cancelled|blocked|request).
//  3. Merge non destructif : un champ absent (undefined) du snapshot entrant ne
//     remet JAMAIS à null la valeur déjà en base. Un champ fourni à null est en
//     revanche une information ("ce provider sait qu'il n'y a pas de valeur").
//  4. Aucun appel provider ici : ce module ne fait que normaliser et persister.
//
// property_id reste TEXT = properties.provider_property_id (convention repo).
// Le pont vers properties.id (UUID) se fera via un helper dédié (chantier E6).

// ─── Statuts canoniques ──────────────────────────────────────────────────────
// Definis dans lib/bookings-snapshot-status.js (module partage avec la detection
// de changements, pour eviter un cycle d'imports). Re-exportes plus bas : les
// appelants continuent d'importer depuis ce fichier.
const {
  STATUS,
  ALL_STATUSES,
  canonicalStatus,
  readStatus,
  isActiveStatus
} = require('./bookings-snapshot-status')

// Detection neutre des changements de reservation (module sans effet de bord).
const { detectChange } = require('./booking-changes')

// ─── Schéma unique ───────────────────────────────────────────────────────────
const EMPTY_SNAPSHOT = {
  provider:           undefined,  // 'beds24' | 'channex' — toujours renseigné à l'écriture
  status:             undefined,  // canonique
  statusRaw:          undefined,  // statut brut provider, conservé pour debug
  arrival:            undefined,
  departure:          undefined,
  arrivalHour:        undefined,
  firstName:          undefined,
  lastName:           undefined,
  numAdult:           undefined,
  numChild:           undefined,
  source:             undefined,  // plateforme d'origine (airbnb, booking, direct…)
  otaReservationCode: undefined,  // référence OTA — clé de rattachement des avis voyageurs
  amount:             undefined,
  currency:           undefined
}
const SNAPSHOT_FIELDS = Object.keys(EMPTY_SNAPSHOT)

// ─── Mappers provider -> schéma unique ───────────────────────────────────────
// Un champ que le provider ne sait pas fournir est laissé `undefined` (et non
// null) : le merge le préservera au lieu de l'écraser.

function fromBeds24(booking) {
  const b = booking || {}
  return {
    provider:           'beds24',
    status:             canonicalStatus(b.status, 'beds24'),
    statusRaw:          b.status || null,
    arrival:            b.arrival || null,
    departure:          b.departure || null,
    arrivalHour:        undefined,                 // non fourni par l'API v2 bookings
    firstName:          b.firstName || '',
    lastName:           b.lastName || '',
    numAdult:           b.numAdult ?? null,
    numChild:           b.numChild ?? null,
    source:             b.channel || b.apiSource || b.referer || 'direct',
    otaReservationCode: b.apiReference || null,
    amount:             undefined,                 // non fourni sur cet endpoint
    currency:           undefined
  }
}

// Couvre indifféremment une réservation Channex (GET reservations) et une
// booking_revision (webhook / feed) : mêmes noms de champs côté Channex.
function fromChannex(booking) {
  const b = booking || {}
  const occ = b.occupancy || {}
  const customer = b.customer || {}
  return {
    provider:           'channex',
    status:             canonicalStatus(b.status, 'channex'),
    statusRaw:          b.status || null,
    arrival:            b.arrival_date || null,
    departure:          b.departure_date || null,
    arrivalHour:        b.arrival_hour || null,
    firstName:          customer.name || '',
    lastName:           customer.surname || '',
    numAdult:           occ.adults || null,
    numChild:           occ.children || null,
    source:             b.ota_name || 'direct',
    otaReservationCode: b.ota_reservation_code || null,
    amount:             b.amount || null,
    currency:           b.currency || null
  }
}

const MAPPERS = { beds24: fromBeds24, channex: fromChannex }

function mapBooking(provider, booking) {
  const fn = MAPPERS[String(provider || '').toLowerCase()]
  if (!fn) throw new Error(`[bookings-snapshot] provider inconnu: ${provider}`)
  return fn(booking)
}

// ─── Merge non destructif ────────────────────────────────────────────────────
// `undefined` = non fourni -> on garde l'existant. Tout le reste (y compris null)
// écrase. Les champs hors schéma déjà présents en base sont conservés.
function mergeSnapshot(previous, incoming) {
  const out = { ...(previous || {}) }
  for (const key of SNAPSHOT_FIELDS) {
    const value = (incoming || {})[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

// ─── Journal des changements ─────────────────────────────────────────────────
// Une ligne par changement detecte, consommee ensuite par
// lib/booking-changes-dispatch.js. Fail-safe : si la table n'existe pas encore
// (migration non appliquee) ou si l'insert echoue, on log et on continue — le
// snapshot doit etre ecrit quoi qu'il arrive.
// `initialImport` : import initial d'un bien (activation d'un canal). Les
// evenements sont ecrits DEJA marques traites — la file materialise l'historique
// sans rien distribuer. Sans cela, activer un bien Channex envoie un message de
// bienvenue a chaque reservation a venir deja prise il y a des mois, et inonde
// la PWA prestataire. La garde d'anciennete ne couvre que le passe.
async function recordChangeEvent(supabase, { userId, bookingId, propertyId, provider, change, initialImport }) {
  try {
    const { error } = await supabase.from('booking_change_events').insert({
      user_id:     userId,
      booking_id:  String(bookingId),
      property_id: String(propertyId),
      provider,
      type:        change.type,
      changes:     change.changes,
      processed_at:      initialImport ? new Date().toISOString() : null,
      processing_errors: initialImport ? [{ consommateur: 'import_initial', erreur: 'materialise sans distribution' }] : null
    })
    if (error) console.error('[bookings-snapshot] booking_change_events insert echec', error.message)
    return !error
  } catch (e) {
    console.error('[bookings-snapshot] booking_change_events exception', e.message)
    return false
  }
}

// ─── Écriture ────────────────────────────────────────────────────────────────
// supabase : client service-key fourni par l'appelant (aucun client créé ici,
// pour rester testable et sans dépendance croisée entre /api et /lib).
// existing : snapshot déjà lu par l'appelant (évite une seconde lecture).
// Fail-safe : ne throw jamais, renvoie { ok:false, reason }.
async function saveBookingSnapshot(supabase, { userId, bookingId, propertyId, provider, booking, snapshot, existing, initialImport } = {}) {
  try {
    if (!userId || !bookingId || !propertyId) {
      return { ok: false, reason: 'missing_keys' }
    }

    const incoming = snapshot || mapBooking(provider, booking)
    if (!incoming.provider) incoming.provider = String(provider || '').toLowerCase() || null

    let previous = existing
    if (previous === undefined) {
      const { data } = await supabase
        .from('bookings_snapshot')
        .select('snapshot')
        .eq('user_id', userId)
        .eq('booking_id', String(bookingId))
        .maybeSingle()
      previous = data?.snapshot || null
    }

    const merged = mergeSnapshot(previous, incoming)

    // Detection du changement AVANT l'upsert : c'est le seul instant ou l'etat
    // precedent et l'etat entrant coexistent. Le snapshot reste l'unique memoire
    // d'etat ; l'evenement produit est consomme plus tard par le dispatcher.
    // Fail-safe absolu : une detection en echec ne doit jamais empecher
    // l'ecriture du snapshot (la synchro des reservations prime).
    let change = null
    try {
      change = detectChange(previous, merged, provider)
    } catch (e) {
      console.error('[bookings-snapshot] detectChange exception', e.message)
    }

    // ⚠ ORDRE CRITIQUE : le changement est journalise AVANT l'upsert.
    // Le snapshot est la seule memoire d'etat : une fois avance, le changement
    // n'est plus detectable. Journaliser apres signifierait qu'un insert en
    // echec (migration pas encore appliquee, coupure reseau) perd le changement
    // DEFINITIVEMENT et en silence — plus jamais de notification menage, de
    // message de bienvenue ni d'annulation de code pour cette reservation.
    // Dans l'ordre inverse, un upsert en echec laisse au pire un evenement en
    // double au cycle suivant : du bruit, pas une perte.
    if (change) {
      const journalise = await recordChangeEvent(supabase, {
        userId,
        bookingId,
        propertyId,
        provider: merged.provider || provider || null,
        change,
        initialImport
      })
      if (!journalise) {
        // On n'avance PAS le snapshot : le changement sera redetecte au prochain
        // cycle, quand la table sera disponible.
        console.error('[bookings-snapshot] changement non journalise, snapshot non avance', bookingId)
        return { ok: false, reason: 'change_not_recorded', snapshot: merged, previous, change }
      }
    }

    const { error } = await supabase
      .from('bookings_snapshot')
      .upsert({
        user_id:     userId,
        booking_id:  String(bookingId),
        property_id: String(propertyId),
        snapshot:    merged,
        updated_at:  new Date().toISOString()
      }, { onConflict: 'user_id,booking_id' })

    if (error) {
      console.error('[bookings-snapshot] upsert echec', bookingId, error.message)
      return { ok: false, reason: 'db_error', error: error.message }
    }

    return { ok: true, snapshot: merged, previous, change }
  } catch (e) {
    console.error('[bookings-snapshot] exception', e.message)
    return { ok: false, reason: 'exception', error: e.message }
  }
}

// Écriture d'un LOT de réservations d'un même bien.
// Les boucles d'import (cron Beds24, activation d'un canal) appelaient
// saveBookingSnapshot par booking : le writer relisait alors la ligne une par une,
// soit 2N allers-retours Supabase. Ici la relecture se fait en UN select par lot,
// le merge non destructif étant inchangé. Le pré-chargement reste dans le writer
// pour qu'aucun appelant n'ait à le réimplémenter.
// Fail-safe : ne throw jamais, renvoie le compte des écritures.
const SELECT_CHUNK = 200

async function saveBookingSnapshots(supabase, { userId, propertyId, provider, bookings, initialImport } = {}) {
  const out = { saved: 0, failed: 0, results: [] }
  try {
    const list = (bookings || []).filter(b => b && b.id)
    if (!userId || !propertyId || !list.length) return out

    // Relecture groupée des snapshots existants (par tranches, pour ne pas
    // construire un IN(...) sans limite).
    const existingByBooking = {}
    const ids = list.map(b => String(b.id))
    for (let i = 0; i < ids.length; i += SELECT_CHUNK) {
      const chunk = ids.slice(i, i + SELECT_CHUNK)
      const { data, error } = await supabase
        .from('bookings_snapshot')
        .select('booking_id, snapshot')
        .eq('user_id', userId)
        .in('booking_id', chunk)
      if (error) {
        // Lecture impossible : on retombe sur la relecture unitaire du writer
        // (plus lente mais correcte) plutôt que d'écraser à l'aveugle.
        console.error('[bookings-snapshot] prefetch echec', error.message)
        return await saveEachWithoutPrefetch(supabase, { userId, propertyId, provider, list, out, initialImport })
      }
      ;(data || []).forEach(r => { existingByBooking[String(r.booking_id)] = r.snapshot || null })
    }

    for (const b of list) {
      const r = await saveBookingSnapshot(supabase, {
        userId,
        bookingId:  b.id,
        propertyId,
        provider,
        booking:    b,
        existing:   existingByBooking[String(b.id)] ?? null,
        initialImport
      })
      out.results.push(r)
      if (r.ok) out.saved++
      else out.failed++
    }
    return out
  } catch (e) {
    console.error('[bookings-snapshot] saveBookingSnapshots exception', e.message)
    return out
  }
}

// Repli quand la relecture groupée échoue : chaque appel relit sa propre ligne.
async function saveEachWithoutPrefetch(supabase, { userId, propertyId, provider, list, out, initialImport }) {
  for (const b of list) {
    const r = await saveBookingSnapshot(supabase, {
      userId, bookingId: b.id, propertyId, provider, booking: b, initialImport
    })
    out.results.push(r)
    if (r.ok) out.saved++
    else out.failed++
  }
  return out
}

module.exports = {
  STATUS,
  ALL_STATUSES,
  EMPTY_SNAPSHOT,
  SNAPSHOT_FIELDS,
  canonicalStatus,
  readStatus,
  isActiveStatus,
  fromBeds24,
  fromChannex,
  mapBooking,
  mergeSnapshot,
  saveBookingSnapshot,
  saveBookingSnapshots,
  recordChangeEvent
}
