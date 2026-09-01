// api/channel-message.js
// Envoi d'un message sortant (hote -> voyageur) via le provider channel (Channex).
// POST { bookingId, message } -> getProvider('channex').sendMessage
//
// ⚠ FUITE ENTRE COMPTES CORRIGEE (2 septembre 2026). Cet endpoint ne verifiait
// que la validite de la session : le `bookingId` venait du client SANS aucune
// verification de propriete. Tout utilisateur connecte pouvait envoyer un
// message, EN SON NOM, au voyageur de n'importe quelle reservation Channex de
// n'importe quel compte. C'est une ecriture ET un envoi reel a un tiers.
const { createClient } = require('@supabase/supabase-js')
const { getProvider } = require('../lib/channels')
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
      // property_id revalide serveur, jamais celui envoye par le client.
      propertyId:    garde.bien ? garde.bien.provider_property_id : garde.booking.property_id,
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
