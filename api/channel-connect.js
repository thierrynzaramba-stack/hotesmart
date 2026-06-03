// api/channel-connect.js
// Genere l'URL d'iframe headless du gestionnaire de canaux pour qu'un hote
// connecte et mappe ses OTA (Booking, Airbnb) lui-meme, en marque blanche.
//
// Flux : auth hote -> charge le bien (verifie propriete) -> demande un
// one-time token au provider -> renvoie l'URL d'iframe (jamais le token brut
// ni la cle API au client).
//
// White-label : base URL via CHANNEL_APP_BASE (jamais "channex" en dur).

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_APP_BASE = process.env.CHANNEL_APP_BASE   // ex: https://staging.channex.io
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

// OTA proposees a l'hote dans l'iframe (cible LCD). BDC=Booking, ABB=Airbnb.
const ALLOWED_CHANNELS = 'BDC,ABB'

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Methode non autorisee' })
  }
  if (!CHANNEL_APP_BASE || !CHANNEL_KEY) {
    return res.status(503).json({ error: 'Gestionnaire de canaux non configure' })
  }

  // ===== AUTH hote =====
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) {
    return res.status(401).json({ error: 'Session invalide' })
  }
  const user = userData.user

  // ===== Bien demande =====
  const propertyId = req.query.property_id
  if (!propertyId) return res.status(400).json({ error: 'property_id requis' })

  const { data: prop, error: propErr } = await supabase
    .from('properties')
    .select('provider, provider_property_id, name')
    .eq('id', propertyId)
    .eq('user_id', user.id)          // securite : seulement SES biens
    .maybeSingle()

  if (propErr) {
    console.error('[channel-connect] SELECT error', propErr.message)
    return res.status(500).json({ error: 'Erreur lecture' })
  }
  if (!prop) return res.status(404).json({ error: 'Bien introuvable' })
  if (prop.provider !== 'channel' && prop.provider !== 'channex') {
    return res.status(400).json({ error: "Ce bien n'est pas gere par le gestionnaire de canaux" })
  }
  if (!prop.provider_property_id) {
    return res.status(400).json({ error: 'Bien non provisionne cote gestionnaire' })
  }

  // ===== One-time token =====
  // TEST TEMPORAIRE : username surchargeable via ?username= pour diagnostiquer
  // l'echec d'auth iframe. A retirer une fois le bon format identifie.
  const username = req.query.username || user.id
  try {
    const r = await fetch(`${CHANNEL_APP_BASE}/api/v1/auth/one_time_token`, {
      method: 'POST',
      headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        one_time_token: {
          property_id: prop.provider_property_id,
          username: username
        }
      })
    })
    const text = await r.text()
    let json
    try { json = JSON.parse(text) } catch { json = { raw: text } }

    if (!r.ok || !json?.data?.token) {
      console.error('[channel-connect] one_time_token echec', r.status, json)
      return res.status(502).json({ error: 'Generation du lien de connexion echouee' })
    }

    const oneTimeToken = json.data.token

    // ===== Construit l'URL d'iframe headless =====
    // Format exact de la doc, sans encodage de redirect_to ni channels.
    const iframeUrl = `${CHANNEL_APP_BASE}/auth/exchange`
      + `?oauth_session_key=${oneTimeToken}`
      + `&app_mode=headless`
      + `&redirect_to=/channels`
      + `&property_id=${prop.provider_property_id}`
      + `&channels=${ALLOWED_CHANNELS}`

    return res.status(200).json({
      iframe_url: iframeUrl,
      property_name: prop.name,
      expires_in: 900            // token valable 15 min
    })

  } catch (err) {
    console.error('[channel-connect] Internal error', err.message)
    return res.status(500).json({ error: 'Erreur interne' })
  }
}
