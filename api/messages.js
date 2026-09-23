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
// La MEME regle que le cron des codes d'arrivee : le menage est « fait » quand
// le dernier menage du bien est posterieur au depart precedent. Ne pas la
// recopier, elle a deja ete corrigee deux fois.
const { etatMenage } = require('../lib/cron-arrival-code')

// Jour de Paris (celui des biens), YYYY-MM-DD, a un decalage de jours pres.
const jourParis = (decalage = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() + decalage * 86400000))
const STATUTS_SANS_ARRIVEE = new Set(['cancelled', 'demapped', 'request', 'blocked', 'inquiry', 'black'])

// ─── Etat d'arrivee : menage fait ? code transmis ? ────────────────────────
// Demande de Thierry (23 septembre 2026) : sur les arrivees du jour et du
// lendemain, la messagerie dit d'un coup d'oeil si le logement est pret et si
// le voyageur a son code. Calcule ICI, sur le compte du proprietaire (service
// role), pour les seules arrivees proches : quelques lignes par jour.
//
// « Code transmis » se PROUVE : un message sortant du fil contient le code.
// Ni `access_codes.status` (qui passe a 'active' meme en Mode Test, quand le
// message n'est qu'une tache a valider), ni `message_sent_log` (ecrit aussi
// en Mode Test) ne disent que le voyageur l'a recu.
async function etatsDArrivee(userId, conversations, snapByBooking) {
  const aujourdHui = jourParis(0), demain = jourParis(1)
  const proches = conversations.filter(c => {
    const st = String(c.status || '').toLowerCase()
    const arr = String(c.firstNight || '').slice(0, 10)
    return arr && st && !STATUTS_SANS_ARRIVEE.has(st) && (arr === aujourdHui || arr === demain)
  })
  if (!proches.length) return
  // Comme tous les lecteurs d'access_codes (cron-arrival-code, cron-access) :
  // jamais une ligne 'deleted' (elle garde son code), et la plus recente d'abord
  // — une reservation en a souvent plusieurs apres un changement de serrure.
  const { data: codes, error } = await supabase
    .from('access_codes')
    .select('booking_id, property_id, code, status, created_at')
    .in('booking_id', proches.map(c => c.bookId))
    .neq('status', 'deleted')
    .order('created_at', { ascending: false })
  if (error) console.error('[messages] lecture access_codes echec', error.message)
  // ⚠ Cle composite : un identifiant Beds24 n'est unique que par bien. La
  // premiere ligne rencontree est la plus recente : on la garde.
  const codeParBooking = {}
  for (const r of codes || []) { const k = `${r.property_id}|${r.booking_id}`; if (!codeParBooking[k]) codeParBooking[k] = r }
  for (const c of proches) {
    const snap = snapByBooking[c.bookId] || {}
    let menage = 'inconnu'
    try {
      menage = await etatMenage(userId, c.propertyId, { arrival: c.firstNight, id: c.bookId }, snap.provider || c.provider || 'beds24')
    } catch (e) { console.error('[messages] etatMenage echec', c.bookId, e.message) }
    const row = codeParBooking[`${c.propertyId}|${c.bookId}`]
    const code = row && row.code ? String(row.code).replace(/\D/g, '') : ''
    // Preuve stricte : le code, ENTIER (borne par des non-chiffres), dans un
    // message sortant POSTERIEUR a la creation de ce code. Un numero de
    // telephone qui le contient, ou un prix, ne vaut pas un code envoye.
    const motif = code ? new RegExp(`(^|\\D)${code}(\\D|$)`) : null
    const depuis = row && row.created_at ? new Date(row.created_at).getTime() : 0
    const transmis = !!motif && c.messages.some(m => m.direction === 'outbound'
      && new Date(m.sent_at).getTime() >= depuis && motif.test(String(m.body || '')))
    c.arrivee = { menage, codeEtat: transmis ? 'transmis' : row ? 'cree' : 'aucun' }
  }
}

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
  // Endpoint de COLLECTION : aucun identifiant client ne designe le compte, c'est
  // l'en-tete X-Compte qui le fait — revalide par la garde.
  //
  // ⚠ ENDPOINT DELEGABLE (etape 5, lot 3), et c'est le plus sensible du lot : il
  // renvoie les CONVERSATIONS DES VOYAGEURS, corps des messages compris. Trois
  // barrieres :
  //   1. `user_id` = compte cible ;
  //   2. filtre de perimetre sur `messages.property_id` ;
  //   3. meme filtre sur `bookings_snapshot`, qui porte les noms et les dates.
  // La troisieme n'est pas cosmetique : sans elle, un membre restreint recevrait
  // en memoire les reservations de tout le compte, et il suffirait d'un message
  // mal rattache pour qu'elles remontent a l'ecran.
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'read', compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId
  const refsAutorisees = refsDuPerimetre(garde.contexte)
  // Filtre de perimetre en SQL (construction + garde de format : lib/permissions).
  // Une expression vide signifie « perimetre vide ou refuse » : on echoue ferme.
  // Le cas property_id NULL est EXCLU (defaut) : une conversation voyageur sans
  // bien rattache ne doit pas apparaitre a un membre limite a un autre bien.
  const filtreOr = filtrePerimetreSql(refsAutorisees)
  if (filtreOr === '') return res.status(200).json({ conversations: [] })

  // ─── Existence d'un fil pour UNE reservation ───────────────────────────────
  // Sert au bouton « Ouvrir la conversation » de la fiche du calendrier
  // (docs/kb/reservation-directe.md §12) : un bouton actif qui ouvre une liste
  // vide fait croire a une panne, donc la fiche a besoin de savoir AVANT.
  //
  // ⚠ UNE RESERVATION A LA FOIS, VOLONTAIREMENT. La version precedente demandait
  // toute la fenetre d'un coup a `api/calendar.js` : `messages` etant un journal,
  // le rendu depassait le plafond de 1000 lignes de PostgREST — silencieusement —
  // et la liste d'identifiants faisait exploser la longueur d'URL. Ici, `limit(1)`
  // sur un index (booking_id, sent_at) : exact, borne, et paye seulement quand
  // l'hote ouvre une fiche.
  //
  // Memes barrieres que la collection : compte cible ET filtre de perimetre — un
  // membre limite au bien A ne doit pas apprendre qu'un fil existe sur le bien B.
  if (req.method === 'GET' && req.query && req.query.booking_id) {
    const bookingId = String(req.query.booking_id)
    try {
      // ⚠ `.or()` SEULEMENT SI LE FILTRE EXISTE, comme les deux requetes de la
      // collection juste en dessous. `refsDuPerimetre` rend `null` — pas `''` —
      // pour un PROPRIETAIRE de compte (perimetre total), et `filtrePerimetreSql`
      // propage ce `null` : la garde `=== ''` ne l'attrape pas. Un `.or(null)`
      // inconditionnel partait en `or=(null)`, que PostgREST refuse — l'endpoint
      // rendait donc 500 pour le cas NORMAL, et le bouton « Ouvrir la
      // conversation » restait eteint sur « Fil indisponible » pour tout le monde.
      let q = supabase
        .from('messages')
        .select('booking_id')
        .eq('user_id', userId)
        .eq('booking_id', bookingId)
      if (filtreOr) q = q.or(filtreOr)
      const { data, error } = await q.limit(1)
      if (error) {
        console.error('[messages] existence conversation', error.message)
        return res.status(500).json({ error: 'Lecture impossible' })
      }
      return res.status(200).json({ booking_id: bookingId, has_conversation: (data || []).length > 0 })
    } catch (e) {
      console.error('[messages] existence conversation echec', e.message)
      return res.status(500).json({ error: 'Lecture impossible' })
    }
  }

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
      // Le detail PostgREST (colonne, contrainte, fragment de requete) reste
      // dans les logs : la reponse ne porte qu'un libelle.
      console.error('[messages] select messages echec', msgRes.error.message)
      return res.status(500).json({ error: 'Erreur lecture messages' })
    }
    // ⚠ L'erreur du SECOND select doit remonter elle aussi. La laisser passer
    // rendait toutes les conversations « Voyageur », sans dates ni statut, sans
    // qu'aucune erreur ne soit visible — et le filtre de perimetre porte
    // desormais sur cette requete aussi.
    if (snapRes.error) {
      console.error('[messages] select bookings_snapshot echec', snapRes.error.message)
      return res.status(500).json({ error: 'Erreur lecture réservations' })
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
        // Le telephone du voyageur, tel que le snapshot le porte (Channex comme
        // Beds24 le nomment `guestPhone`). L'ecran messagerie en fait un lien
        // d'appel : le jour de l'arrivee, c'est souvent le seul canal qui reste.
        guestPhone:   snap.guestPhone || null,
        lastTime,
        messages:     conv.messages
      }
    })

    // Tri conversations par lastTime desc (plus recentes d'abord).
    conversations.sort((a, b) => new Date(b.lastTime || 0) - new Date(a.lastTime || 0))

    // Menage fait ? code transmis ? — pour les arrivees du jour et de demain.
    // Un echec ici ne prive personne de sa messagerie : les marques manquent, c'est tout.
    try { await etatsDArrivee(userId, conversations, snapByBooking) }
    catch (e) { console.error('[messages] etats d\'arrivee echec', e.message) }

    return res.status(200).json({ conversations })

  } catch (e) {
    console.error('[messages] exception', e.message)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}
