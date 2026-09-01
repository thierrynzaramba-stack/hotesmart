// api/messages.js
// Endpoint LECTURE de la messagerie unifiee (etape 4b).
// Le front (messagerie.html, etape 4c) lit UNIQUEMENT cet endpoint pour afficher
// les conversations. Source de verite = table `messages` (RLS sans policy -> lecture
// serveur en service key), enrichie par bookings_snapshot (metadonnees reservation :
// guestName, dates, statut, ota -- Channex + Beds24 unifies). CommonJS.

const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const { requirePermission } = require('../lib/require-permission')
const { refsDuPerimetre, filtrePerimetreSql } = require('../lib/permissions')

// ─── Normalisation OTA (marque blanche) ──────────────────────────────────────
// Valeur brute heterogene (Beds24 'airbnb' / Channex 'Airbnb.com' / ...) -> cle CSS.
function otaKey(raw) {
  const s = String(raw || '').toLowerCase()
  if (!s || s === 'direct')                                                    return 'direct'
  if (s.includes('airbnb'))                                                    return 'airbnb'
  if (s.includes('booking'))                                                   return 'booking'
  if (s.includes('vrbo') || s.includes('homeaway') || s.includes('abritel'))   return 'vrbo'
  if (s.includes('expedia'))                                                   return 'expedia'
  return 'ota'   // OTA non reconnue mais non-directe
}

const OTA_LABELS = { airbnb: 'Airbnb', booking: 'Booking.com', vrbo: 'Vrbo', expedia: 'Expedia', ota: 'Autre OTA', direct: 'Direct' }

// Libelle propre : cle connue -> label mappe ; 'ota' inconnue -> capitalize brut.
function otaLabel(raw) {
  const k = otaKey(raw)
  if (k === 'ota') {
    const r = String(raw || '').trim()
    return r ? r[0].toUpperCase() + r.slice(1) : 'Direct'
  }
  return OTA_LABELS[k]
}

// Regle marque blanche : Channex -> OTA seule ; Beds24 -> "Beds24 · OTA". Jamais 'Channex'.
function displayLabel(provider, raw) {
  const label = otaLabel(raw)
  return provider === 'beds24' ? `Beds24 · ${label}` : label
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode non autorisee' })
  }

  // ── Droits ──
  // Endpoint de COLLECTION : aucun identifiant client, donc aucune ressource ne
  // designe un compte — le compte cible est celui de l'appelant.
  //
  // ⚠ PORTEE REELLE, a ne pas surestimer : la garde et le filtre ci-dessous sont
  // INERTES aujourd'hui. Un appelant est toujours titulaire de son propre compte,
  // donc `niveauEffectif` renvoie 'write' et `refsDuPerimetre` renvoie null. La
  // consequence est fonctionnelle, pas securitaire : un membre invite ne voit pas
  // la messagerie du compte auquel il appartient, il voit la sienne (vide).
  // Le choix du compte cible est l'etape 5 ; le cablage est pose des maintenant
  // pour qu'elle n'ait qu'a fournir `accountUserId`. Couverture : les tests
  // portent sur refsDuPerimetre (lib/permissions), pas sur cet endpoint — un vert
  // ici ne prouverait rien.
  const garde = await requirePermission(req, res, { domaine: 'messages', niveau: 'read' })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const refsAutorisees = refsDuPerimetre(garde.contexte)
  // Filtre de perimetre en SQL (construction + garde de format : lib/permissions).
  // Une expression vide signifie « perimetre vide ou refuse » : on echoue ferme.
  const filtreOr = filtrePerimetreSql(refsAutorisees)
  if (filtreOr === '') return res.status(200).json({ conversations: [] })

  try {
    // Fenetre 6 mois.
    const since = new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000).toISOString()

    // ── 2 SELECT (zero N+1) : messages recents + snapshots du user ──
    const [msgRes, snapRes] = await Promise.all([
      (() => {
        let q = supabase
          .from('messages')
          .select('booking_id, property_id, provider, ota, sender, direction, body, sent_at, kind')
          .eq('user_id', userId)
          .gte('sent_at', since)
        if (filtreOr) q = q.or(filtreOr)
        return q
          .order('sent_at', { ascending: false })   // 2000 plus RECENTS (re-tri asc en memoire)
          .limit(2000)
      })(),
      (() => {
        let q = supabase
          .from('bookings_snapshot')
          .select('booking_id, snapshot')
          .eq('user_id', userId)
        // Le filtre messages suffirait (la jointure est pilotee par eux), mais
        // charger les reservations hors perimetre en memoire n'a aucun interet.
        if (filtreOr) q = q.or(filtreOr)
        return q
      })()
    ])

    if (msgRes.error) {
      console.error('[messages] select messages echec', msgRes.error.message)
      return res.status(500).json({ error: msgRes.error.message })
    }
    // ⚠ L'erreur du SECOND select doit remonter elle aussi. La laisser passer
    // rendait toutes les conversations « Voyageur », sans dates ni statut, sans
    // qu'aucune erreur ne soit visible — et le filtre de perimetre porte
    // desormais sur cette requete aussi.
    if (snapRes.error) {
      console.error('[messages] select bookings_snapshot echec', snapRes.error.message)
      return res.status(500).json({ error: snapRes.error.message })
    }
    const messages = msgRes.data || []
    const snaps    = snapRes.data || []

    // Jointure memoire : snapshot par booking_id.
    const snapByBooking = {}
    snaps.forEach(s => { snapByBooking[String(s.booking_id)] = s.snapshot || {} })

    // ── Group-by booking_id (un seul passage) ──
    const convMap = {}
    let nullBookingCount = 0
    for (const m of messages) {
      if (m.booking_id == null || m.booking_id === '') { nullBookingCount++; continue }
      const bookId = String(m.booking_id)
      if (!convMap[bookId]) {
        convMap[bookId] = {
          bookId,
          propertyId: m.property_id != null ? String(m.property_id) : '',
          provider:   m.provider || '',
          _otaRaw:    null,
          messages:   []
        }
      }
      const conv = convMap[bookId]
      // fallback ota : 1ere ota non-null rencontree dans les messages
      if (!conv._otaRaw && m.ota) conv._otaRaw = m.ota
      conv.messages.push({
        sender:    m.sender,
        direction: m.direction,
        body:      m.body,
        sent_at:   m.sent_at,
        kind:      m.kind
      })
    }

    if (nullBookingCount > 0) {
      console.log(`[messages] ${nullBookingCount} message(s) booking_id null ignore(s)`)
    }

    // ── Enrichissement snapshot + marque blanche ──
    const conversations = Object.values(convMap).map(conv => {
      const snap = snapByBooking[conv.bookId] || {}
      const guestName = [snap.firstName, snap.lastName].filter(Boolean).join(' ').trim() || 'Voyageur'
      // ota : priorite snapshot.source, fallback 1ere ota messages, sinon 'direct'
      const otaRaw = snap.source || conv._otaRaw || 'direct'
      // re-tri chronologique ASC (la requete etait DESC pour capter les plus recents)
      conv.messages.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at))
      const lastTime = conv.messages.length ? conv.messages[conv.messages.length - 1].sent_at : null
      return {
        bookId:       conv.bookId,
        propertyId:   conv.propertyId,
        provider:     conv.provider,
        ota:          otaLabel(otaRaw),
        platform:     otaKey(otaRaw),
        displayLabel: displayLabel(conv.provider, otaRaw),
        guestName,
        firstNight:   snap.arrival   || null,
        lastNight:    snap.departure || null,
        status:       snap.status    || null,
        lastTime,
        messages:     conv.messages
      }
    })

    // Tri conversations par lastTime desc (plus recentes d'abord).
    conversations.sort((a, b) => new Date(b.lastTime || 0) - new Date(a.lastTime || 0))

    return res.status(200).json({ conversations })

  } catch (e) {
    console.error('[messages] exception', e.message)
    return res.status(500).json({ error: e.message })
  }
}
