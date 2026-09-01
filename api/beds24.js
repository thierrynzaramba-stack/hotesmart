const { createClient } = require('@supabase/supabase-js')
// Double ecriture vers la table source de verite `messages` (etape 2 messagerie unifiee).
const { recordMessage } = require('../lib/record-message')
const { requirePermission, verifierSession, resoudreBooking } = require('../lib/require-permission')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  try {
    const { action, propertyId, bookingId, message } = req.body || {}

    // ── Droits ──
    // Proxy Beds24. La cle du compte borne DEJA ce que Beds24 renvoie, mais elle
    // ne dit rien des droits INTERNES : sans garde, tout membre invite pouvait
    // lire les conversations voyageurs et en envoyer, quels que soient son
    // domaine et son perimetre.
    //
    // Chaque action declare son domaine et son niveau. `sendMessage` ne porte
    // qu'un bookingId : c'est la RESERVATION qui designe le bien et le compte
    // (le `propertyId` eventuellement joint par le client est ignore par la garde).
    const REGLES = {
      getProperties:    { domaine: 'reglages',     niveau: 'read'  },
      getBookings:      { domaine: 'reservations', niveau: 'read'  },
      getMessages:      { domaine: 'messages',     niveau: 'read'  },
      getHistory:       { domaine: 'messages',     niveau: 'read'  },
      getConversations: { domaine: 'messages',     niveau: 'read'  },
      sendMessage:      { domaine: 'messages',     niveau: 'write' }
    }
    // ⚠ hasOwnProperty, pas `REGLES[action]` : `constructor`, `toString` et
    // consorts sont herites d'Object.prototype et passaient le test, pour finir
    // en 500 « configuration de droits invalide » au lieu d'un 400.
    const regle = Object.prototype.hasOwnProperty.call(REGLES, action) ? REGLES[action] : null
    if (!regle) return res.status(400).json({ error: 'Action inconnue' })

    // Session verifiee AVANT toute lecture : resoudreBooking interroge la base en
    // service key, et son 409 « reservation ambigue » repondait a un appelant non
    // authentifie — un oracle sur l'existence d'un booking_id partage.
    const appelant = await verifierSession(req, res)
    if (!appelant) return

    // ⚠ SENDMESSAGE ET LA RESERVATION ABSENTE DU SNAPSHOT.
    // Passer bookingId a la garde serait la voie propre, mais le snapshot ne
    // couvre que la fenetre de sync du cron (-3 / +6 mois d'arrivee) alors que
    // l'action getMessages en expose sur ±1 an : exiger la reservation en base
    // ferait repondre 404 a une reponse voyageur parfaitement legitime.
    // On tente donc le snapshot d'abord (autoritaire), et a defaut on retombe
    // sur le bien fourni par le client — verifie par la garde, PUIS confronte a
    // Beds24 : la reservation doit reellement porter ce propId (controle plus
    // bas). Sans cette confrontation, un membre limite au bien A pourrait
    // ecrire au voyageur d'une reservation du bien B en passant `propertyId: A`.
    let bookingConnu = null
    if (action === 'sendMessage' && bookingId) {
      bookingConnu = await resoudreBooking(bookingId)
      if (bookingConnu && bookingConnu.ambigu) {
        return res.status(409).json({ error: 'Réservation ambiguë' })
      }
    }
    const parReservation = !!(bookingConnu && bookingConnu.property_id)

    const garde = await requirePermission(req, res, {
      domaine: regle.domaine,
      niveau:  regle.niveau,
      // getProperties n'a pas de bien : il liste ceux du compte de l'appelant.
      // ⚠ getProperties IGNORE `propertyId`. Le prendre en compte suffisait a
      // ouvrir tout le compte : un membre limite au bien A passait A, la garde
      // basculait `accountUserId` sur le proprietaire, la cle de celui-ci etait
      // chargee, et GET /properties renvoyait TOUS ses biens Beds24 — le
      // perimetre n'existant pas en sortie. Sans bien, la garde retombe sur le
      // compte de l'appelant : il ne voit que les siens.
      bien:    action === 'getProperties' ? null
               : action === 'sendMessage' ? (parReservation ? null : (propertyId || null))
               : (propertyId || null),
      // ⚠ Le repli de sendMessage n'EXIGE pas de bien. Le front n'en a pas
      // toujours un a fournir (messages.property_id peut etre NULL), et exiger
      // ici renvoyait 400 sur une reponse voyageur qui fonctionnait avant. Quand
      // il manque, c'est Beds24 qui donne le bien, et la garde repasse dessus.
      bienRequis: action !== 'getProperties' && !(action === 'sendMessage' && !parReservation),
      booking: parReservation ? bookingId : null,
      bookingRequis: false,
      userId: appelant
    })
    if (!garde.ok) return

    // Identifiant Beds24 RESOLU en base. Le propId brut du client n'atteint
    // jamais l'API : c'est le bien valide par la garde qui le fournit.
    const propId = garde.bien
      ? garde.bien.provider_property_id
      : (garde.booking ? garde.booking.property_id : propertyId)

    // Bien cree a l'onboarding mais jamais connecte : sans ce refus, l'URL
    // partait avec `propId=null` et l'hote voyait une liste vide sans savoir
    // pourquoi.
    if (action !== 'getProperties' && action !== 'sendMessage' && (propId == null || propId === '')) {
      return res.status(400).json({ error: 'Bien non connecté au PMS' })
    }

    // La cle appartient au compte PROPRIETAIRE du bien, pas a l'appelant : c'est
    // ce qui rend la delegation possible (un membre invite n'a pas de cle a lui).
    const { data: keyData, error: keyError } = await supabase
      .from('api_keys')
      .select('api_key')
      .eq('user_id', garde.accountUserId)
      .single()

    if (keyError || !keyData) {
      return res.status(400).json({ error: 'Clé Beds24 non configurée' })
    }

    const beds24Key = keyData.api_key

    switch (action) {

      case 'getProperties': {
        const r = await fetch('https://beds24.com/api/v2/properties', { headers: { token: beds24Key } })
        const d = await r.json()
        return res.json({ properties: d.data || [] })
      }

      case 'getBookings': {
        const r = await fetch(`https://beds24.com/api/v2/bookings?propId=${encodeURIComponent(propId)}`, { headers: { token: beds24Key } })
        const d = await r.json()
        const bookings = (d.data || []).filter(b => String(b.propertyId) === String(propId))
        return res.json({ bookings })
      }

      case 'getMessages': {
        const r = await fetch(
          `https://beds24.com/api/v2/bookings/messages?propId=${encodeURIComponent(propId)}&limit=200`,
          { headers: { token: beds24Key } }
        )
        const d = await r.json()
        const allMessages = (d.data || []).filter(m => String(m.propertyId) === String(propId))
        console.log('[Beds24] getMessages total:', (d.data || []).length, '→ filtrés:', allMessages.length)

        const byBooking = {}
        allMessages.forEach(msg => {
          if (!byBooking[msg.bookingId]) byBooking[msg.bookingId] = []
          byBooking[msg.bookingId].push(msg)
        })

        const bookingIds = Object.keys(byBooking)
        let bookingsMap = {}

        if (bookingIds.length > 0) {
          // Fetch bookings avec fenêtre large pour couvrir toutes les réservations
          const dateFrom = new Date(); dateFrom.setFullYear(dateFrom.getFullYear() - 1)
          const dateTo   = new Date(); dateTo.setFullYear(dateTo.getFullYear() + 1)
          const rb = await fetch(
            `https://beds24.com/api/v2/bookings?propId=${encodeURIComponent(propId)}&arrivalFrom=${dateFrom.toISOString().split('T')[0]}&arrivalTo=${dateTo.toISOString().split('T')[0]}`,
            { headers: { token: beds24Key } }
          )
          const db = await rb.json()
          ;(db.data || []).forEach(b => { bookingsMap[b.id] = b })
          console.log('[Beds24] messages fetched:', (db.data||[]).length)
        }

        const messages = bookingIds.filter(bookId => bookingsMap[bookId]).map(bookId => {
          const msgs = byBooking[bookId]
          const guestMsgs = msgs.filter(m => m.source === 'guest')
          if (!guestMsgs.length) return null

          const lastGuestMsg = guestMsgs.sort((a, b) => new Date(b.time) - new Date(a.time))[0]
          const lastMsg = msgs.sort((a, b) => new Date(b.time) - new Date(a.time))[0]
          const waitingReply = lastMsg?.source === 'guest'
          const booking = bookingsMap[bookId] || {}
          return {
            bookId:         parseInt(bookId),
            guestFirstName: booking.firstName  || '',
            guestName:      booking.lastName   || '',
            firstNight:     booking.arrival    || '',
            lastNight:      booking.departure  || '',
            channel:        booking.channel      || '',
            referer:        booking.referer      || '',
            apiSource:      booking.apiSource    || '',
            apiSourceId:    booking.apiSourceId  || null,
            apiReference:   booking.apiReference || '',
            guestMessage:   lastGuestMsg.message,
            message:        lastGuestMsg.message,
            messageId:      lastGuestMsg.id,
            messageTime:    lastGuestMsg.time,
            read:           lastGuestMsg.read,
            waitingReply,
            thread: msgs.map(m => ({
              id:      m.id,
              time:    m.time,
              message: m.message,
              source:  m.source
            })).sort((a, b) => new Date(a.time) - new Date(b.time))
          }
        }).filter(Boolean)

        console.log('[Beds24] messages voyageurs:', messages.length)
        return res.json({ messages })
      }

      case 'getHistory': {
        const r = await fetch(
          `https://beds24.com/api/v2/bookings/messages?propId=${encodeURIComponent(propId)}&limit=200`,
          { headers: { token: beds24Key } }
        )
        const d = await r.json()
        const messages = (d.data || [])
          .filter(m => String(m.propertyId) === String(propId))
          .map(m => ({ bookId: m.bookingId, message: m.message, guestMessage: m.message, source: m.source, time: m.time }))
        return res.json({ messages, totalBookings: messages.length })
      }

      case 'sendMessage': {
        // Chemin de repli (reservation absente du snapshot) : Beds24 tranche.
        // La cle ne repond que pour les reservations du compte, et on exige que
        // le propId retourne soit bien celui valide par la garde.
        let propIdEnvoi = propId
        if (!parReservation) {
          const rb = await fetch(
            `https://beds24.com/api/v2/bookings?id=${encodeURIComponent(bookingId)}`,
            { headers: { token: beds24Key } }
          )
          // ⚠ Distinguer les trois cas, sinon une panne Beds24 se presente comme
          // un refus de droits et le titulaire ne peut plus repondre a son
          // voyageur — precisement ce que ce repli existe pour eviter.
          if (!rb.ok) {
            console.error('[Beds24] verification reservation HTTP', rb.status)
            return res.status(502).json({ error: 'Vérification de la réservation impossible' })
          }
          const db = await rb.json().catch(() => null)
          if (!db || !Array.isArray(db.data)) {
            console.error('[Beds24] verification reservation : reponse illisible')
            return res.status(502).json({ error: 'Vérification de la réservation impossible' })
          }
          // Le filtre `id` doit avoir ete PRIS EN COMPTE : on exige que la ligne
          // renvoyee soit bien celle demandee, sinon Beds24 nous a repondu autre
          // chose et rien ne serait verifie.
          const resa = db.data.find(b => String(b.id) === String(bookingId))
          if (!resa) return res.status(404).json({ error: 'Réservation introuvable' })

          if (propId != null && propId !== '') {
            // Le client a annonce un bien : Beds24 doit le confirmer.
            if (String(resa.propertyId) !== String(propId)) {
              console.log('[Beds24] refus sendMessage : reservation hors du bien autorise')
              return res.status(403).json({ error: 'Droits insuffisants' })
            }
          } else {
            // Aucun bien annonce : c'est Beds24 qui le designe, et la garde
            // repasse dessus. La cle utilisee etant celle du compte de
            // l'appelant, Beds24 ne peut designer qu'un de ses biens — mais le
            // PERIMETRE, lui, reste a verifier.
            const gardeResa = await requirePermission(req, res, {
              domaine: 'messages', niveau: 'write',
              bien: resa.propertyId, bienRequis: true, userId: appelant
            })
            if (!gardeResa.ok) return
            if (String(gardeResa.accountUserId) !== String(garde.accountUserId)) {
              console.log('[Beds24] refus sendMessage : bien d\'un autre compte')
              return res.status(403).json({ error: 'Droits insuffisants' })
            }
            propIdEnvoi = gardeResa.bien.provider_property_id
          }
        }

        const r = await fetch('https://beds24.com/api/v2/bookings/messages', {
          method: 'POST',
          headers: { token: beds24Key, 'Content-Type': 'application/json' },
          body: JSON.stringify([{ bookingId, message }])
        })
        const d = await r.json()
        console.log('[Beds24] sendMessage response:', JSON.stringify(d))

        // DOUBLE ECRITURE (etape 2) : message manuel hote sortant dans `messages`,
        // sans toucher au flux d'envoi ni a l'INSERT conversations (fait cote front).
        // Fail-safe : recordMessage ne throw jamais, n'affecte pas la reponse.
        // ota null -> lookup (null pour Beds24). providerMsgId null -> dedup logique.
        if (r.ok) {
          await recordMessage({
            userId:        garde.accountUserId,
            provider:      'beds24',
            // La reservation fait foi : jamais le propertyId envoye par le client.
            propertyId:    propIdEnvoi,
            bookingId:     bookingId,
            direction:     'outbound',
            sender:        'host',
            body:          message,
            providerMsgId: null,
            ota:           null,
            sentAt:        null,
            kind:          'message'
          })
        }

        return res.json({ success: r.ok, data: d })
      }

      case 'getConversations': {
        // Fetch toutes les réservations récentes avec messages et infos plateforme
        const dateFrom = new Date(); dateFrom.setMonth(dateFrom.getMonth() - 3)
        const dateTo   = new Date(); dateTo.setMonth(dateTo.getMonth() + 6)

        const [bookingsRes, messagesRes] = await Promise.all([
          fetch(
            `https://beds24.com/api/v2/bookings?propId=${encodeURIComponent(propId)}&arrivalFrom=${dateFrom.toISOString().split('T')[0]}&arrivalTo=${dateTo.toISOString().split('T')[0]}`,
            { headers: { token: beds24Key } }
          ),
          fetch(
            `https://beds24.com/api/v2/bookings/messages?propId=${encodeURIComponent(propId)}&limit=200`,
            { headers: { token: beds24Key } }
          )
        ])

        const bookingsData = await bookingsRes.json()
        const messagesData = await messagesRes.json()

        const bookings = (bookingsData.data || []).filter(b => String(b.propertyId) === String(propId))
        const messages = (messagesData.data || []).filter(m => String(m.propertyId) === String(propId))

        // Grouper les messages par bookingId
        const messagesByBooking = {}
        messages.forEach(m => {
          if (!messagesByBooking[m.bookingId]) messagesByBooking[m.bookingId] = []
          messagesByBooking[m.bookingId].push(m)
        })

        // Construire la liste des conversations
        const conversations = bookings.map(booking => {
          const bookId  = String(booking.id)
          const msgs    = messagesByBooking[bookId] || []
          const thread  = msgs.map(m => ({
            id:      m.id,
            time:    m.time,
            message: m.message,
            source:  m.source
          })).sort((a, b) => new Date(a.time) - new Date(b.time))

          const lastMsg    = thread[thread.length - 1]
          const hasGuest   = msgs.some(m => m.source === 'guest')
          const waitingReply = lastMsg?.source === 'guest'

          return {
            bookId:        bookId,
            guestFirstName: booking.firstName  || '',
            guestName:     booking.lastName   || '',
            firstNight:    booking.arrival    || '',
            lastNight:     booking.departure  || '',
            channel:       booking.channel    || '',
            apiSource:     booking.apiSource  || '',
            apiSourceId:   booking.apiSourceId || null,
            apiReference:  booking.apiReference || '',
            referer:       booking.referer    || '',
            status:        booking.status     || '',
            hasMessages:   msgs.length > 0,
            hasGuest,
            waitingReply,
            lastTime:      lastMsg?.time || booking.bookingTime || booking.arrival,
            thread
          }
        })

        // Trier par date du dernier message ou date de réservation
        conversations.sort((a, b) => new Date(b.lastTime || 0) - new Date(a.lastTime || 0))

        console.log('[Beds24] getConversations:', conversations.length, 'réservations dont', conversations.filter(c => c.hasMessages).length, 'avec messages')
        return res.json({ conversations })
      }

      default:
        // Inatteignable : REGLES a deja filtre les actions connues.
        return res.status(400).json({ error: `Action inconnue : ${action}` })
    }

  } catch (err) {
    console.error('[Beds24]', err)
    return res.status(500).json({ error: 'Erreur serveur', detail: err.message })
  }
}
