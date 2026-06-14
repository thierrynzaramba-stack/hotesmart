// api/channel-message.js
// Envoi d'un message sortant (hote -> voyageur) via le provider channel (Channex).
// POST { bookingId, message } -> getProvider('channex').sendMessage
const { createClient } = require('@supabase/supabase-js')
const { getProvider } = require('../lib/channels')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' })

  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: u, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !u?.user) return res.status(401).json({ error: 'Session invalide' })

  const { bookingId, message } = req.body || {}
  if (!bookingId || !message) return res.status(400).json({ error: 'bookingId et message requis' })

  try {
    const r = await getProvider('channex').sendMessage({}, { bookingId, message })
    if (!r.success) {
      console.error('[channel-message] echec', bookingId, r.status)
      return res.status(502).json({ success: false, error: 'Envoi channel echoue', status: r.status, detail: r.data })
    }
    return res.status(200).json({ success: true })
  } catch (e) {
    console.error('[channel-message] exception', e.message)
    return res.status(500).json({ success: false, error: e.message })
  }
}
