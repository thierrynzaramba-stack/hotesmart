// api/channel-message.js
// Envoi d'un message sortant (hote -> voyageur) via le provider channel (Channex).
// POST { bookingId, message } -> getProvider('channex').sendMessage
const { createClient } = require('@supabase/supabase-js')
const { getProvider } = require('../lib/channels')
// Double ecriture vers la table source de verite `messages` (etape 2 messagerie unifiee).
const { recordMessage } = require('../lib/record-message')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' })

  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: u, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !u?.user) return res.status(401).json({ error: 'Session invalide' })

  const { bookingId, message, propertyId } = req.body || {}
  if (!bookingId || !message) return res.status(400).json({ error: 'bookingId et message requis' })

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
      userId:        u.user.id,
      provider:      'channex',
      propertyId:    propertyId,
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
