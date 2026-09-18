// api/channel-message.js
// Envoi d'un message sortant (hote -> voyageur) via le provider channel (Channex).
// POST { bookingId, message } -> getProvider('channex').sendMessage
//
// ⚠ FUITE ENTRE COMPTES CORRIGEE (2 septembre 2026). Cet endpoint ne verifiait
// que la validite de la session : le `bookingId` venait du client SANS aucune
// verification de propriete. Tout utilisateur connecte pouvait envoyer un
// message, EN SON NOM, au voyageur de n'importe quelle reservation Channex de
// n'importe quel compte. C'est une ecriture ET un envoi reel a un tiers.
//
// ⚠ IL NE PARLE PLUS SEULEMENT A CHANNEX. Depuis l'etape 3 du canal e-mail, cet
// endpoint route comme le cron : par la SOURCE de la reservation. Une resa
// `Offline` n'a pas de fil chez Channex (HTTP 422 `not_supported`) — le message
// de l'hote part par e-mail au voyageur. Le nom du fichier ment un peu ; le
// renommer casserait le front, et un renommage n'est pas une correction.
const { createClient } = require('@supabase/supabase-js')
const { getProvider } = require('../lib/channels')
const { CANAL, MOTIF, canalPour } = require('../lib/canal-voyageur')
const { envoyerEmailVoyageur, sujetPour } = require('../lib/email-guestflow')
// Double ecriture vers la table source de verite `messages` (etape 2 messagerie unifiee).
const { recordMessage } = require('../lib/record-message')
const { requirePermission } = require('../lib/require-permission')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' })

  const { bookingId, message, propertyId } = req.body || {}
  if (!message) return res.status(400).json({ error: 'message requis' })

  // La reservation designe le compte ET le bien : un bookingId d'un autre compte
  // donne 404, une reservation hors perimetre 403 — avant tout envoi.
  const garde = await requirePermission(req, res, {
    domaine: 'messages', niveau: 'write',
    booking: bookingId, bookingRequis: true,
    bien: propertyId || null
  })
  if (!garde.ok) return

  try {
    // ⚠ LE SNAPSHOT DE LA GARDE, PAS UNE SECONDE LECTURE. `requirePermission` a
    // deja resolu la reservation pour verifier le perimetre : c'est la meme ligne
    // du coeur, et elle porte la source et l'adresse du voyageur.
    const snap = garde.booking?.snapshot || {}
    const decision = canalPour({ id: bookingId, ...snap })

    // ⚠ ON NE REFUSE QUE CE QU'ON SAIT IMPOSSIBLE — `pas_d_email`, c'est-a-dire
    // une reservation Offline sans adresse : il n'existe litteralement aucune
    // destination.
    //
    // `sans_canal`, LUI, PASSE QUAND MEME, et c'est un correctif de review.
    // Le normaliseur Channex ecrit `source: ota_name || 'direct'`, et `'direct'`
    // compte parmi les sources sans canal cote Beds24 : une reservation Channex
    // sans `ota_name` (ou dont le snapshot est vide) se serait vu refuser
    // l'ecriture, alors que l'appel Channex fonctionnait tres bien avant. Ce
    // filtre a ete ecrit pour des bookings Beds24 ; l'appliquer a un snapshot
    // Channex retirait a l'hote la possibilite d'ecrire a son voyageur.
    // En cas de doute, on laisse le provider trancher — c'est lui l'autorite.
    if (decision.motif === MOTIF.PAS_D_EMAIL) {
      // On le dit a l'hote au lieu de laisser le provider rendre un 422 illisible.
      console.warn('[channel-message] aucune adresse', bookingId)
      return res.status(422).json({ success: false, motif: decision.motif,
        error: 'Cette réservation n\'a pas d\'adresse e-mail : aucun message ne peut partir.' })
    }

    if (decision.canal === CANAL.EMAIL) {
      const envoi = await envoyerEmailVoyageur({
        // Le compte PROPRIETAIRE du bien : sa cle Brevo, ses credits. Jamais
        // l'appelant, qui peut etre un membre delegue.
        userId: garde.accountUserId,
        destinataire: decision.destinataire,
        sujet: sujetPour(null, garde.bien?.name),
        texte: message,
        // Le fil doit revenir ici, pas dans la boite de l'hote.
        bookingId
      })
      if (!envoi.ok) {
        console.error('[channel-message] echec e-mail', bookingId, envoi.raison)
        return res.status(502).json({ success: false, canal: 'email', error: 'Envoi e-mail échoué',
          detail: envoi.raison })
      }
      await recordMessage({
        userId:        garde.accountUserId,
        provider:      'channex',
        propertyId:    garde.booking.property_id,
        bookingId:     bookingId,
        direction:     'outbound',
        sender:        'host',
        body:          message,
        providerMsgId: envoi.id || null,
        ota:           null,
        sentAt:        null,
        kind:          'message',
        canal:         'email'
      })
      return res.status(200).json({ success: true, canal: 'email' })
    }

    const r = await getProvider('channex').sendMessage({}, { bookingId, message })
    if (!r.success) {
      console.error('[channel-message] echec', bookingId, r.status)
      return res.status(502).json({ success: false, error: 'Envoi channel echoue', status: r.status, detail: r.data })
    }

    // DOUBLE ECRITURE (etape 2) : message manuel hote sortant dans `messages`,
    // sans toucher au flux d'envoi ni a l'INSERT conversations (fait cote front).
    // Fail-safe : recordMessage ne throw jamais, n'affecte pas la reponse.
    // ota null -> lookup bookings_snapshot (snapshot.source). providerMsgId null
    // -> dedup logique.
    await recordMessage({
      // Le compte propriétaire de la reservation, pas l'appelant : c'est lui qui
      // possede le fil de messages.
      userId:        garde.accountUserId,
      provider:      'channex',
      // property_id de la RESERVATION, jamais celui envoye par le client : c'est
      // elle qui designe le fil de messages. `garde.bien` peut etre null si le
      // bien n'est plus materialise — la reference du snapshot reste valable.
      propertyId:    garde.booking.property_id,
      bookingId:     bookingId,
      direction:     'outbound',
      sender:        'host',
      body:          message,
      providerMsgId: null,
      ota:           null,
      sentAt:        null,
      kind:          'message'
    })

    return res.status(200).json({ success: true })
  } catch (e) {
    console.error('[channel-message] exception', e.message)
    return res.status(500).json({ success: false, error: e.message })
  }
}
