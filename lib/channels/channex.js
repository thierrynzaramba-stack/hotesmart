// lib/channels/channex.js
// Moteur Channex. Même contrat que beds24.js.
// Marque blanche absolue : variables CHANNEL_* (jamais CHANNEX_*),
// aucune mention "channex" exposée côté utilisateur.
// credentials : non utilisé (clé API globale via env), gardé pour le contrat.
// ctx.propertyId = properties.provider_property_id (uuid Channex)

const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const { recordMessage } = require('../record-message')
const BASE = process.env.CHANNEL_BASE_URL          // ex: https://staging.channex.io/api/v1
const KEY  = process.env.CHANNEL_API_KEY

// ⚠ LE POST N'EST JAMAIS REESSAYE, ET C'EST DELIBERE.
// `fetch` rejette aussi APRES que le serveur a traite la requete : une socket
// coupee pendant la lecture de la reponse est indiscernable d'une requete jamais
// partie. Rejouer un POST /bookings creerait alors une SECONDE reservation sur les
// memes nuits — deux resas, dispo fermee deux fois, deux revisions dans le feed —
// et Channex n'oppose aucune defense a la surreservation (mesure du protocole).
// Un echec visible vaut mieux qu'un doublon silencieux : l'appelant decidera.
// GET et PUT sont idempotents, eux : les rejouer est sans consequence.
const METHODES_REJOUABLES = new Set(['GET', 'PUT', 'HEAD', 'DELETE'])

// Base du backoff, injectable pour que les tests n'attendent pas reellement.
const BACKOFF_MS = Number(process.env.CHANNEL_BACKOFF_MS ?? 1000)

// Vraies pannes reseau : le code vient de `e.cause` (undici). Une URL invalide ou
// un corps non serialisable ne sont PAS des pannes reseau — les rejouer ferait
// d'une variable d'environnement manquante un timeout de fonction Vercel de 15 s
// au lieu d'un echec immediat, en accusant le reseau dans les logs.
const CODES_RESEAU = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
  'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'
])
const estPanneReseau = e => CODES_RESEAU.has(e?.cause?.code) || CODES_RESEAU.has(e?.code)

async function channelCall(method, path, body, _attempt = 0) {
  // Serialise AVANT le try : un corps non serialisable est une faute de
  // programmation, pas un incident reseau, et doit echouer tout de suite.
  const corps = body ? JSON.stringify(body) : undefined
  const rejouable = METHODES_REJOUABLES.has(String(method).toUpperCase())

  let r
  try {
    r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'user-api-key': KEY, 'Content-Type': 'application/json' },
      body: corps
    })
    // La LECTURE DU CORPS est dans le try : une coupure a cet instant leve aussi,
    // et laisser cette ligne dehors rendait l'exception nue que ce bloc pretend
    // supprimer — l'appelant teste `ok`, il ne doit jamais avoir a attraper.
    var text = await r.text()
  } catch (e) {
    if (estPanneReseau(e) && rejouable && _attempt < 4) {
      await new Promise(res => setTimeout(res, Math.min(BACKOFF_MS * Math.pow(2, _attempt), 8 * BACKOFF_MS)))
      return channelCall(method, path, body, _attempt + 1)
    }
    const cause = e?.cause?.code || e?.code || 'inconnue'
    console.error(`[channel] ${method} ${path} echec (${cause}) apres ${_attempt + 1} essai(s) :`, e.message)
    return {
      ok: false, status: 0,
      json: { errors: { code: estPanneReseau(e) ? 'network_error' : 'call_error', title: e.message, cause } }
    }
  }

  if ((r.status === 429 || r.status >= 500) && rejouable && _attempt < 4) {
    const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10)
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(BACKOFF_MS * Math.pow(2, _attempt), 8 * BACKOFF_MS)
    await new Promise(res => setTimeout(res, waitMs))
    return channelCall(method, path, body, _attempt + 1)
  }
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: r.ok, status: r.status, json }
}
// Récupère les réservations d'un bien (représentation "dernière révision connue").
// NB : le flux entrant temps réel passe par le webhook + feed (api/channel-webhook.js
// et lib/cron-channel-feed.js). Cette fonction sert aux relectures ponctuelles.
//
// ⚠ PAGINE. L'API plafonne par defaut a DIX reservations par page et annonce le
// reste dans `meta.total` — mesure sur Colomiers : 10 rendues sur 18 existantes.
// Sans pagination, `api/channel-events.js` (import initial a l'activation d'un
// bien) n'ecrivait donc que les dix dernieres reservations dans le coeur, en
// silence : un hote activant un bien a cinquante reservations n'en aurait vu que
// dix, et les quarante autres n'auraient exist  qu'au passage d'une revision.
// Meme famille que la troncature de fetchBookingsHistory cote Beds24.
const PAGE_LIMITE = 100
const PAGE_MAX = 50          // 5 000 reservations : borne de securite, jamais atteinte

async function getReservations(ctx) {
  const { propertyId } = ctx
  const out = []
  for (let page = 1; page <= PAGE_MAX; page++) {
    const r = await channelCall('GET',
      `/bookings?filter[property_id]=${propertyId}&pagination[page]=${page}&pagination[limit]=${PAGE_LIMITE}`)
    if (!r.ok) {
      console.error('[channel] getReservations echec', r.status, r.json)
      return out                     // ce qui est deja lu n'est pas perdu
    }
    const lot = Array.isArray(r.json?.data) ? r.json.data : []
    out.push(...lot.map(b => ({ id: b.id, ...b.attributes })))

    // ⚠ `meta.total` est teste EN PREMIER, et c'est deliberé. Si Channex plafonne
    // ou ignore `pagination[limit]` — son defaut est 10 —, la page 1 rend moins de
    // PAGE_LIMITE lignes et une sortie sur ce seul critere retournerait un
    // resultat tronque, exactement le defaut qu'on corrige ici. On ne s'arrete sur
    // une page courte qu'apres avoir constate qu'on a bien tout, et on CRIE sinon.
    const total = r.json?.meta?.total
    // Tout est la : on s'arrete.
    if (typeof total === 'number' && out.length >= total) return out
    // Page vide : plus rien a lire, et c'est la SEULE sortie sure quand `total`
    // manque. Sans elle, une API qui ignore `pagination[page]` ferait empiler
    // 50 fois la meme page.
    if (!lot.length) return out
    // Page courte MAIS `total` annonce davantage : c'est le cas ou Channex plafonne
    // ou ignore `pagination[limit]` (son defaut est 10). On CONTINUE — s'arreter
    // ici rendrait 10 reservations sur 18, la troncature meme qu'on corrige.
    if (lot.length < PAGE_LIMITE && typeof total !== 'number') return out
  }
  console.warn(`[channel] getReservations ${propertyId} : plafond de ${PAGE_MAX} pages atteint`)
  return out
}

// Envoi d'un message au voyageur, au niveau du booking.
// bookingId = bookings_snapshot.booking_id (id booking Channex).
// Prérequis : app "messages" installée sur la propriété (fait au provisioning).
// Erreurs notables : 403 = app messages absente, 422 = OTA sans support messages.
async function sendMessage(ctx, { bookingId, message }) {
  const r = await channelCall('POST', `/bookings/${bookingId}/messages`, {
    message: { message }
  })
  if (!r.ok) {
    const code = r.json?.errors?.code || ('HTTP ' + r.status)
    console.error('[channel] sendMessage echec', bookingId, code)
  }
  return { success: r.ok, status: r.status, data: r.json }
}

// Lecture des messages d'un booking (sender: 'guest' | 'property').
async function getMessages(ctx, bookingId) {
  const r = await channelCall('GET', `/bookings/${bookingId}/messages`)
  if (!r.ok) {
    console.error('[channel] getMessages echec', bookingId, r.status)
    return []
  }
  return Array.isArray(r.json?.data) ? r.json.data.map(m => ({ id: m.id, ...m.attributes })) : []
}

// Push ARI : dispo (0/1 pour whole), tarifs.
// ari = [{ room_type_id, date_from, date_to, availability?, rate? }]
async function updateAvailability(ctx, ari) {
  const { propertyId } = ctx
  const values = (Array.isArray(ari) ? ari : [ari]).map(v => ({
    property_id: propertyId,
    ...v
  }))
  const r = await channelCall('POST', '/availability', { values })
  if (!r.ok) console.error('[channel] updateAvailability echec', r.status, r.json)
  return { success: r.ok, data: r.json }
}

// Clé API statique : pas de refresh OAuth.
async function refreshToken(ctx) {
  return { success: true }
}

// Grain propriete pour Channex : les messages arrivent par webhook push
// (handleMessage les ecrit dans conversations). On lit donc la base, pas l API.
async function getPropertyMessages(ctx) {
  const propId = ctx.providerPropertyId || ctx.propertyId
  const { data, error } = await supabase
    .from('conversations')
    .select('book_id, guest_message, guest_name, created_at')
    .eq('property_id', String(propId))
    .is('agent_reply', null)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) { console.error('[channel] getPropertyMessages echec', error.message); return [] }
  return (data || []).map(c => ({
    bookingId: c.book_id || null,
    sender: 'guest',
    message: c.guest_message || '',
    time: c.created_at || null,
    guestName: c.guest_name || ''
  }))
}

// Normalise le provider d'un message_thread Channex vers notre vocabulaire ota.
function normOta(provider) {
  switch (provider) {
    case 'BookingCom': return 'booking'
    case 'Airbnb':     return 'airbnb'
    case 'Expedia':    return 'expedia'
    default:           return provider ? String(provider).toLowerCase() : null
  }
}

// Import de l'historique des messages d'un bien (equivalent "Pull" pour les messages).
// Flux : GET /message_threads?filter[property_id] (pagine) -> pour chaque thread,
// GET /message_threads/:id/messages (pagine) -> recordMessage (idempotent via
// provider_msg_id = id du message Channex). Re-executable sans doublon.
// Prerequis : app messages installee (sinon 403 -> error 'messages_app_absent').
// ctx.userId = proprietaire HoteSmart (requis) ; ctx.propertyId = provider_property_id.
// ctx.debug=true -> capture les reponses brutes du 1er thread-list et du 1er
// thread-messages (validation filtre property_id + egalite thread.booking.id).
async function importMessages(ctx) {
  const propId = ctx.propertyId || ctx.providerPropertyId
  const userId = ctx.userId
  if (!userId || !propId) {
    console.error('[channel] importMessages params manquants', { userId, propId })
    return { imported: 0, skipped: 0, error: 'missing_params' }
  }

  const debug = ctx.debug ? { threads_raw: null, first_thread_messages_raw: null } : null
  const LIMIT = 100
  let imported = 0
  let skipped = 0
  let threadPage = 1

  while (true) {
    const tr = await channelCall('GET', `/message_threads?filter[property_id]=${propId}&pagination[page]=${threadPage}&pagination[limit]=${LIMIT}`)
    if (debug && threadPage === 1) debug.threads_raw = tr.json
    if (!tr.ok) {
      const code = tr.json?.errors?.code || ('HTTP ' + tr.status)
      if (tr.status === 403) return { imported, skipped, error: 'messages_app_absent', _debug: debug }
      console.error('[channel] importMessages threads echec', tr.status, code)
      return { imported, skipped, error: code, _debug: debug }
    }
    const threads = Array.isArray(tr.json?.data) ? tr.json.data : []
    if (threads.length === 0) break

    for (const th of threads) {
      const attr = th.attributes || {}
      const bookingId = th.relationships?.booking?.data?.id || null
      const ota = normOta(attr.provider)

      let msgPage = 1
      while (true) {
        const mr = await channelCall('GET', `/message_threads/${th.id}/messages?pagination[page]=${msgPage}&pagination[limit]=${LIMIT}`)
        if (debug && debug.first_thread_messages_raw === null) debug.first_thread_messages_raw = mr.json
        if (!mr.ok) {
          // 422 = OTA sans support messages, 403 = app absente : on saute ce thread.
          console.error('[channel] importMessages messages echec', th.id, mr.status)
          break
        }
        const msgs = Array.isArray(mr.json?.data) ? mr.json.data : []
        if (msgs.length === 0) break

        for (const m of msgs) {
          const ma = m.attributes || {}
          const isGuest = ma.sender === 'guest'
          const res = await recordMessage({
            userId,
            provider:      'channex',
            propertyId:    propId,
            bookingId,
            direction:     isGuest ? 'inbound' : 'outbound',
            sender:        isGuest ? 'guest' : 'host',
            body:          ma.message || '',
            providerMsgId: m.id || null,
            ota,
            sentAt:        ma.inserted_at || null,
            kind:          'message'
          })
          if (res && res.skipped) skipped++
          else if (res && res.ok) imported++
        }

        const meta = mr.json?.meta || {}
        const limit = meta.limit || msgs.length
        if (msgs.length < limit) break
        msgPage++
      }
    }

    const meta = tr.json?.meta || {}
    const limit = meta.limit || threads.length
    if (threads.length < limit) break
    threadPage++
  }

  return { imported, skipped, _debug: debug }
}

// ═══════════════════════════════════════════════════════════════════════════
// ÉCRITURE CRS — reservation directe (spec-reservation-manuelle.md §3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Primitive d'ecriture partagee par la saisie manuelle (phase 2) et le futur
// moteur de reservation direct (phase 3). Aucun module metier n'appelle Channex
// en direct : tout passe par ici.
//
// TOUT CE BLOC EST MESURE, pas suppose — protocole CRS du 6 septembre 2026 sur le
// staging « test 2 ». Les six comportements verifies :
//   1. creation      -> la dispo se ferme sur les nuits occupees (bornes libres)
//   2. modification  -> anciennes nuits rouvertes, nouvelles fermees
//   3. annulation    -> dispo restauree ; la REPONSE ne porte ni dates ni rooms,
//                       mais la revision du feed les porte
//   4. feed          -> new / modified / cancelled, comme une revision OTA normale
//   5. surreservation-> ACCEPTEE (HTTP 200, stock a -1) : aucune defense provider
//   6. meta custom   -> rendu intact dans le feed (cles triees), absent de la reponse

// `ota_name` d'une reservation directe. Mesure : « Offline » est accepte et
// Channex genere un unique_id prefixe `OFL-` (distinct de `BDC-`/`ABB-`), donc il
// la traite comme un canal a part entiere. « Direct », « Website », « Manual »,
// « Booking CRS » et « Channex » sont TOUS refuses en `unknown provider` — d'ou
// la tentation d'emprunter le nom d'un OTA reel, qui polluerait les statistiques
// par canal. Ne pas y revenir.
const OTA_DIRECT = 'Offline'

// ⚠ PAYLOAD TOUJOURS COMPLET, MEME POUR ANNULER.
// Mesure : un PUT d'annulation dont `rooms[].days` est partiel est rejete en 422
// (« departure_date is not equal to maximum date + 1 day in rooms.days »).
// Channex revalide l'integralite du payload a chaque ecriture ; il n'existe pas
// de mise a jour partielle. Cette fonction est donc la seule forme autorisee.
//
// `days` : le prix NUIT PAR NUIT, de l'arrivee au dernier soir. La nuit de depart
// n'en fait pas partie — c'est ce qui laisse la borne libre pour l'arrivee
// suivante (verifie au point 1 : sejour 12->15, seules les nuits 12, 13 et 14
// passent a 0).
// ⚠ LES CHAMPS OBLIGATOIRES SONT REFUSES ICI, PAS AU CRS.
// `JSON.stringify` SUPPRIME les cles `undefined` : un champ oublie disparaissait
// du payload et revenait en 422 opaque — ou pire, passait. Et `String(undefined)`
// envoie la chaine « undefined » dans un champ de montant. Cette fonction est
// l'unique primitive d'ecriture du produit : ce qui manque doit se voir ici.
//
// `currency` est EXIGE, jamais devine : un bien en GBP dont l'appelant oublie la
// devise creerait une reservation au meme montant numerique en EUR, sans signal.
//
// `otaReservationCode` est EXIGE parce qu'il est notre seule cle de
// deduplication cote Channex — sans lui, impossible de savoir si un POST parti
// deux fois a cree deux reservations.
const CHAMPS_REQUIS = ['roomTypeId', 'ratePlanId', 'arrival', 'departure', 'amount', 'currency', 'otaReservationCode']

function montant (valeur, champ) {
  const n = Number(valeur)
  if (!Number.isFinite(n) || n < 0) throw new Error(`[channel] ${champ} invalide : ${JSON.stringify(valeur)}`)
  // Deux decimales : un total flottant donnerait « 0.30000000000000004 ».
  return n.toFixed(2)
}

function payloadCRS (propertyId, resa, statut) {
  if (!propertyId) throw new Error('[channel] payloadCRS : propertyId manquant')
  const r = resa || {}
  const manquants = CHAMPS_REQUIS.filter(c => r[c] === undefined || r[c] === null || r[c] === '')
  if (manquants.length) throw new Error(`[channel] payloadCRS : champ(s) manquant(s) — ${manquants.join(', ')}`)
  if (!r.days || !Object.keys(r.days).length) throw new Error('[channel] payloadCRS : `days` vide (prix nuit par nuit obligatoire)')

  const {
    roomTypeId, ratePlanId, arrival, departure,
    days, amount, currency,
    customer = {}, occupancy = {}, meta, otaReservationCode, arrivalHour
  } = r

  const jours = {}
  for (const [d, v] of Object.entries(days)) jours[d] = montant(v, `days[${d}]`)

  const booking = {
    property_id:          propertyId,
    ota_name:             OTA_DIRECT,
    ota_reservation_code: otaReservationCode,
    arrival_date:         arrival,
    departure_date:       departure,
    currency,
    customer: {
      name:     customer.name || '',
      surname:  customer.surname || '',
      mail:     customer.mail || null,
      phone:    customer.phone || null,
      country:  customer.country || null,
      language: customer.language || 'fr'
    },
    occupancy: {
      adults:   occupancy.adults ?? 1,
      children: occupancy.children ?? 0,
      infants:  occupancy.infants ?? 0
    },
    amount: montant(amount, 'amount'),
    rooms: [{
      room_type_id: roomTypeId,
      rate_plan_id: ratePlanId,
      days: jours,
      occupancy: {
        adults:   occupancy.adults ?? 1,
        children: occupancy.children ?? 0,
        infants:  occupancy.infants ?? 0
      },
      amount: montant(amount, 'amount')
    }]
  }
  // `meta` porte la SOUS-origine (saisie hote vs moteur direct), jamais l'origine :
  // celle-ci est deja dans ota_name. Omis s'il est vide, pour ne pas ecrire `{}`.
  if (meta && Object.keys(meta).length) booking.meta = meta
  if (arrivalHour) booking.arrival_hour = arrivalHour
  if (statut) booking.status = statut
  return { booking }
}

// Forme de retour unique des trois fonctions : { ok, id, status, erreurs, json }.
// ⚠ AUCUNE ERREUR N'EST AVALEE (lecon des reviews du chantier historique) : un
// echec est LOGGE et remonte avec son detail, jamais transforme en succes vide.
// Le cœur n'est PAS ecrit ici : la reservation y entrera par le feed/webhook
// standard. La reponse ne sert qu'a obtenir l'id et a detecter un echec — elle
// n'est pas une source fiable (a l'annulation elle ne porte ni dates ni rooms).
function resultat (op, r) {
  if (!r.ok) {
    const details = r.json?.errors ? JSON.stringify(r.json.errors) : String(r.status)
    console.error(`[channel] ${op} echec ${r.status} : ${details.slice(0, 300)}`)
    return { ok: false, status: r.status, erreurs: r.json?.errors || null, json: r.json }
  }
  return { ok: true, status: r.status, id: r.json?.data?.id || null, json: r.json }
}

// ⚠ POST NON REJOUE (cf. METHODES_REJOUABLES) : une panne reseau rend un echec,
// jamais un doublon. L'appelant qui veut reessayer doit d'abord verifier, via
// `ota_reservation_code`, qu'aucune reservation n'a ete creee entre-temps.
async function createBooking (propertyId, resa) {
  return resultat('createBooking', await channelCall('POST', '/bookings', payloadCRS(propertyId, resa)))
}

async function updateBooking (bookingId, propertyId, resa) {
  return resultat('updateBooking', await channelCall('PUT', `/bookings/${bookingId}`, payloadCRS(propertyId, resa)))
}

// L'annulation est un PUT porteur de `status: cancelled` et du payload COMPLET :
// `DELETE /bookings/:id` et `PUT /bookings/:id/cancel` n'existent pas (404 mesure).
async function cancelBooking (bookingId, propertyId, resa) {
  return resultat('cancelBooking', await channelCall('PUT', `/bookings/${bookingId}`, payloadCRS(propertyId, resa, 'cancelled')))
}

// L'app `booking_crs` doit etre installee sur le bien, sinon POST /bookings rend
// 403 (mesure). A appeler au provisioning d'un bien Channex, comme l'app messages.
async function installerCRS (propertyId) {
  return resultat('installerCRS', await channelCall('POST', '/applications/install', {
    application_installation: { property_id: propertyId, application_code: 'booking_crs' }
  }))
}

module.exports = {
  getReservations, getPropertyMessages, sendMessage, getMessages, updateAvailability,
  refreshToken, importMessages,
  createBooking, updateBooking, cancelBooking, installerCRS, payloadCRS, OTA_DIRECT
}
