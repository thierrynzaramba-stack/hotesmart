const { supabase, getSignatureForKey, SENDVIABEDS24_ENABLED } = require('./cron-shared')

// ─── Refresh automatique tokens Beds24 ───────────────────────────────────────
// Tourne à chaque cron (5 min). Les tokens Beds24 expirent en 24h, les refresh
// tokens en 30 jours d'inutilisation. Tant que le cron tourne, tout reste valide.
async function refreshBeds24Tokens() {
  const { data: keys } = await supabase
    .from('api_keys')
    .select('user_id, refresh_token')
    .not('refresh_token', 'is', null)

  if (!keys?.length) return

  for (const key of keys) {
    try {
      const r = await fetch('https://beds24.com/api/v2/authentication/token', {
        method: 'GET',
        headers: { 'accept': 'application/json', 'refreshToken': key.refresh_token }
      })
      const d = await r.json()
      if (d.token) {
        await supabase
          .from('api_keys')
          .update({ api_key: d.token })
          .eq('user_id', key.user_id)
        console.log(`[Beds24] Token rafraîchi pour user ${key.user_id}`)
      } else {
        console.error(`[Beds24] Refresh échoué user ${key.user_id}:`, d.error)
      }
    } catch (err) {
      console.error(`[Beds24] Erreur refresh user ${key.user_id}:`, err.message)
    }
  }
}

// ─── Fetch properties ────────────────────────────────────────────────────────
async function fetchProperties(beds24Key) {
  const r = await fetch('https://beds24.com/api/v2/properties', {
    headers: { token: beds24Key }
  })
  const d = await r.json()
  return d.data || []
}

// ─── Statuts Beds24 demandes explicitement ───────────────────────────────────
// ⚠ GET /bookings EXCLUT LES ANNULATIONS PAR DEFAUT, et ne le dit nulle part :
// pas d'erreur, pas d'indice, la reservation disparait simplement de la reponse.
// Consequence mesuree en production sur le bien 209413 : une reservation
// confirmee puis annulee n'est jamais revue par le writer, donc detectChange ne
// voit aucune transition et le snapshot reste `confirmed` POUR TOUJOURS. Trois
// reservations annulees etaient encore actives en base, dont une a venir
// (92209790, 12-13 septembre 2026) : menage notifie, code d'acces pose et
// message envoye pour un sejour qui n'existe plus.
//
// Demander la liste complete coute le meme prix (1,5 credit par page, mesure).
const TOUS_STATUTS = ['new', 'confirmed', 'request', 'inquiry', 'black', 'cancelled']
  .map(s => `&status=${s}`).join('')

// ─── Fetch bookings ──────────────────────────────────────────────────────────
// ATTENTION : Beds24 ignore le filtre propId côté API, on filtre côté client.
//
// `includeCancelled` est OPT-IN, et c'est deliberé. TROIS appelants partagent
// cette fonction — les verifier tous avant d'en changer le defaut :
//   - lib/cron-bookings.js (writer de snapshots) : demande les annulees, c'est
//     tout l'objet du correctif.
//   - lib/cron-messages.js (envoi des templates arrival/departure) : ne les
//     demande PAS. Ce chemin envoie un message par booking rapporte ; lui servir
//     les annulees enverrait « bienvenue » et « bon retour » a des voyageurs
//     dont le sejour est annule. Il filtre en plus par isActiveStatus.
//   - api/cron.js (fenetre 0/+2j) -> lib/cron-arrival-code.js : POSE LES CODES DE
//     SERRURE. Il filtre deja par isActiveStatus, mais un code d'acces ouvert pour
//     un sejour annule est le pire des trois cas : le verifier en premier.
// Un defaut a false garantit qu'aucun appelant existant ne change de
// comportement sans qu'on l'ait ecrit.
async function fetchBookings(beds24Key, propertyId, { daysBefore = 1, daysAfter = 90, includeCancelled = false } = {}) {
  const today = new Date()
  const dateFrom = new Date(today); dateFrom.setDate(today.getDate() - daysBefore)
  const dateTo   = new Date(today); dateTo.setDate(today.getDate() + daysAfter)

  const url = `https://beds24.com/api/v2/bookings?propId=${propertyId}`
    + `&arrivalFrom=${dateFrom.toISOString().split('T')[0]}`
    + `&arrivalTo=${dateTo.toISOString().split('T')[0]}`
    + (includeCancelled ? TOUS_STATUTS : '')

  const r = await fetch(url, { headers: { token: beds24Key } })
  const d = await r.json()
  // Une erreur API rendait `[]` sans un mot : detectBookingChanges passait alors
  // une liste vide au writer, donc plus aucun snapshot mis a jour ni changement
  // detecte, et rien dans les logs pour le dire. D'autant moins acceptable qu'on
  // vient d'ajouter six parametres `status` a cette URL : si Beds24 les refuse un
  // jour, le cron doit le CRIER, pas s'endormir.
  if (d.success === false) {
    console.error(`[Beds24] fetchBookings ${propertyId} echec`, JSON.stringify(d).slice(0, 200))
  }
  return (d.data || []).filter(b => String(b.propertyId) === String(propertyId))
}

// ─── Fetch bookings passés (pour classification messages) ────────────────────
// ⚠ PAGINE. Sans cela, seule la premiere page etait lue : l'API plafonne a 100
// reservations par page et signale la suite dans `pages.nextPageExists`, que
// l'ancien code ignorait. Sur le bien 209413, six mois d'historique en comptent
// plus de 100 — le reste etait perdu en silence, et lib/cron-classify.js
// rattachait donc les messages a un sous-ensemble arbitraire des sejours.
//
// Les annulees restent HORS de ce fetch : la classification rattache un message
// a un sejour reel, et le plafond de pages borne le cout comme la memoire.
//
// ⚠ CE FETCH TOURNE A CHAQUE CYCLE `*/5`, PAR BIEN (api/cron.js -> cron-classify).
// Chaque page coute 1,5 credit sur un budget Beds24 de 100 par fenetre glissante
// de 5 minutes, et un appel HTTP en serie dans un cycle deja mesure a 40-56 s pour
// un plafond Vercel de 60 s. Le plafond est donc volontairement BAS : 5 pages =
// 500 reservations sur six mois, tres au-dela du besoin reel (181 sur le bien le
// plus charge). Il borne le pire cas a 7,5 credits et ~2 s par bien.
const PAGE_MAX = 5

async function fetchBookingsHistory(beds24Key, propertyId, monthsBack = 6) {
  const dateFrom = new Date()
  dateFrom.setMonth(dateFrom.getMonth() - monthsBack)

  const base = `https://beds24.com/api/v2/bookings?propId=${propertyId}`
    + `&arrivalFrom=${dateFrom.toISOString().split('T')[0]}`

  const out = []
  for (let page = 1; page <= PAGE_MAX; page++) {
    const r = await fetch(`${base}&page=${page}`, { headers: { token: beds24Key } })
    const d = await r.json()
    if (d.success === false) {
      // `return`, pas `break` : sortir par la boucle ferait passer l'echec sous le
      // warn « plafond atteint » ci-dessous, qui enverrait le diagnostic dans la
      // mauvaise direction. Deux troncatures differentes, deux messages differents.
      console.error(`[Beds24] fetchBookingsHistory ${propertyId} page ${page} echec, historique tronque`, JSON.stringify(d).slice(0, 200))
      return out
    }
    out.push(...(d.data || []))
    if (!d.pages?.nextPageExists) return out
  }
  // Plafond atteint : on rend ce qu'on a, mais on le DIT. Un historique
  // silencieusement tronque est exactement le defaut qu'on corrige ici.
  console.warn(`[Beds24] fetchBookingsHistory ${propertyId} : plafond de ${PAGE_MAX} pages atteint, historique tronque`)
  return out
}

// ─── Fetch messages ──────────────────────────────────────────────────────────
async function fetchMessages(beds24Key, propertyId, limit = 100) {
  const url = `https://beds24.com/api/v2/bookings/messages?propId=${propertyId}&limit=${limit}`
  const r = await fetch(url, { headers: { token: beds24Key } })
  const d = await r.json()
  return (d.data || []).filter(m => String(m.propertyId) === String(propertyId))
}

// ─── Envoi message au voyageur via Beds24 ────────────────────────────────────
// Signature GuestFlow : UNIQUEMENT pour les comptes sans abonnement actif
// (mécanisme viral du plan gratuit). Résolution via getSignatureForKey.
// Contrôlé par SENDVIABEDS24_ENABLED (flag env Vercel) pour bascule safe.
// Fonctionne pour réservations OTA uniquement (Airbnb, Booking.com).
// Les réservations directes (channel vide) échouent silencieusement.
async function sendViaBeds24(beds24Key, bookingId, message) {
  if (!message || !beds24Key || !bookingId) {
    console.warn('[Beds24] sendViaBeds24 appelé avec paramètres manquants')
    return { ok: false, reason: 'missing_params' }
  }

  const signature = await getSignatureForKey(beds24Key)
  const finalMessage = message + signature

  if (!SENDVIABEDS24_ENABLED) {
    console.log(`[Beds24] [DRY RUN] Envoi simulé booking ${bookingId} : "${finalMessage.substring(0, 80)}..."`)
    return { ok: true, dryRun: true }
  }

  try {
    const r = await fetch('https://beds24.com/api/v2/bookings/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'token': beds24Key
      },
      body: JSON.stringify([{ bookingId: Number(bookingId), message: finalMessage }])
    })
    const d = await r.json()

    const result = Array.isArray(d) ? d[0] : d
    if (result?.success === false) {
      console.error(`[Beds24] Envoi échoué booking ${bookingId}:`, result.errors || result)
      return { ok: false, error: result.errors || 'unknown' }
    }

    console.log(`[Beds24] Message envoyé booking ${bookingId}`)
    return { ok: true }
  } catch (err) {
    console.error(`[Beds24] Erreur envoi booking ${bookingId}:`, err.message)
    return { ok: false, error: err.message }
  }
}

module.exports = {
  refreshBeds24Tokens,
  fetchProperties,
  fetchBookings,
  fetchBookingsHistory,
  fetchMessages,
  sendViaBeds24
}
