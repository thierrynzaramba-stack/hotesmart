// api/channel-import-messages.js
// Endpoint MANUEL : importe l'historique des messages d'un bien via la couche
// canal (getProvider(prop.provider).importMessages). Equivalent "Pull" messages.
// POST { property_id (uuid Supabase) }, auth Bearer, ownership verifiee.
// Retourne { imported, skipped, error? }. En mode debug (defaut ici, phase test),
// logue les reponses brutes des 2 premiers appels Channex pour valider :
//   (a) le filtre property_id sur /message_threads
//   (b) l'egalite thread.booking.id == bookings_snapshot.booking_id
// TODO post-validation : brancher l'appel automatique en fin de mapping OTA.

const { createClient } = require('@supabase/supabase-js')
const { getProvider } = require('../lib/channels')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode non autorisee' })
  }

  // ===== AUTH =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) {
    return res.status(401).json({ error: 'Session invalide' })
  }
  const user = userData.user

  // ===== Bien demande (ownership) =====
  const pid = req.body?.property_id
  if (!pid) return res.status(400).json({ error: 'property_id requis' })

  const { data: prop, error: propErr } = await supabase
    .from('properties')
    .select('id, provider, provider_property_id, name')
    .eq('id', pid)
    .eq('user_id', user.id)          // securite : seulement SES biens
    .maybeSingle()

  if (propErr) {
    console.error('[channel-import-messages] SELECT error', propErr.message)
    return res.status(500).json({ error: 'Erreur lecture' })
  }
  if (!prop) return res.status(404).json({ error: 'Bien introuvable' })
  if (!prop.provider_property_id) {
    return res.status(400).json({ error: 'Bien non provisionne cote canal' })
  }

  // ===== Import via la couche canal =====
  const provider = getProvider(prop.provider || 'channex')
  if (typeof provider.importMessages !== 'function') {
    return res.status(400).json({ error: 'Import non supporte par ce canal' })
  }

  const result = await provider.importMessages({
    userId:            user.id,
    propertyId:        prop.provider_property_id,
    providerPropertyId: prop.provider_property_id,
    debug:             true   // phase test : capture les reponses brutes
  })

  // Log des captures brutes (phase validation) puis retrait du _debug de la reponse.
  if (result && result._debug) {
    console.log('[channel-import-messages] DEBUG threads_raw', JSON.stringify(result._debug.threads_raw))
    console.log('[channel-import-messages] DEBUG first_thread_messages_raw', JSON.stringify(result._debug.first_thread_messages_raw))
    delete result._debug
  }

  console.log(`[channel-import-messages] ${prop.name} (${prop.provider_property_id}) -> imported=${result?.imported} skipped=${result?.skipped} error=${result?.error || 'none'}`)
  return res.status(200).json(result)
}
