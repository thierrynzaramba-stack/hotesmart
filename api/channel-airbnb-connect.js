// api/channel-airbnb-connect.js
// OAuth Airbnb par LIEN DIRECT (doc officielle Airbnb Connection API, Evan).
// Remplace l'iframe multi-OTA (api/channel-connect.js) pour le parcours Airbnb :
// on genere un lien OAuth Airbnb cible (airbnb.com/oauth2/auth?...) via
// POST /meta/airbnb/connection_link, l'hote autorise sur Airbnb, puis Airbnb
// redirige vers pages/airbnb-retour.html avec ?success=true&channel_id=X&token=Y.
//
// Deux actions :
//   (create)  POST {property_id:<UUID>}          -> { oauth_url }   [AUTH hote requise]
//   validate  POST ?action=validate {token,channel_id} -> bien+channel [SANS session]
//
// SECURITE / CONCIERGERIE-READY : le RETOUR (validate) resout le bien via le TOKEN
// en base, JAMAIS via la session courante. Un proprietaire tiers (conciergerie) qui
// autorise l'annonce n'aura pas de session HoteSmart ; la source de verite est le
// token nonce (secret, transmis uniquement par le redirect Airbnb). On ne suppose
// donc PAS session.user == token.user_id.
//
// Anti-forge : validate verifie que le channel_id recu appartient bien au
// provider_property_id stocke avec le token (sinon un ?channel_id= force rattacherait
// un canal au mauvais compte).

const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY
const APP_URL = process.env.APP_URL || 'https://hotesmart.vercel.app'

async function channelCall(method, path, body) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Groupe Channex proprietaire du bien (requis par connection_link). Meme logique que
// channel-mapping.js action 'groups'.
async function resolveGroupId(providerPropertyId) {
  const r = await channelCall('GET', '/groups')
  const groups = Array.isArray(r.json?.data) ? r.json.data : []
  const match = groups.find(g => {
    const rel = g.relationships?.properties?.data
    return Array.isArray(rel) && rel.some(p => String(p.id) === String(providerPropertyId))
  })
  return match?.id || null
}

// Le channel_id recu appartient-il vraiment au provider_property_id stocke ? (anti-forge)
async function channelBelongsToProperty(channelId, providerPropertyId) {
  const r = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
  const rows = Array.isArray(r.json?.data) ? r.json.data : []
  return rows.some(c => String(c.id) === String(channelId))
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode non autorisee' })
  }
  if (!CHANNEL_API || !CHANNEL_KEY) {
    return res.status(503).json({ error: 'Gestionnaire de canaux non configure' })
  }

  const action = req.query.action || 'create'

  // ===================================================================
  // validate : RETOUR d'Airbnb. Resout le bien via le TOKEN, PAS la session.
  // (Concierge-ready : pas d'auth session requise ici — le token est le secret.)
  // ===================================================================
  if (action === 'validate') {
    const token = (req.body?.token || '').trim()
    const channelId = (req.body?.channel_id || '').trim()
    if (!token) return res.status(400).json({ error: 'token requis' })

    // TTL applique par filtre date a la lecture (pas de cron de nettoyage).
    const nowIso = new Date().toISOString()
    const { data: sess, error: sErr } = await supabase
      .from('airbnb_connect_sessions')
      .select('token, property_id, provider_property_id, status, expires_at')
      .eq('token', token)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .maybeSingle()
    if (sErr) {
      console.error('[channel-airbnb-connect] validate SELECT', sErr.message)
      return res.status(500).json({ error: 'Erreur lecture' })
    }
    if (!sess) return res.status(404).json({ error: 'Session de connexion invalide ou expiree' })

    if (!channelId) return res.status(400).json({ error: 'channel_id requis' })
    // Anti-forge : le canal doit appartenir au bien lie au token.
    const belongs = await channelBelongsToProperty(channelId, sess.provider_property_id)
    if (!belongs) {
      return res.status(403).json({ error: 'channel_id non rattache a ce bien' })
    }

    const { error: uErr } = await supabase
      .from('airbnb_connect_sessions')
      .update({ status: 'consumed', consumed_at: nowIso, channel_id: channelId })
      .eq('token', token)
    if (uErr) console.error('[channel-airbnb-connect] validate UPDATE', uErr.message)

    // Nom du bien (affichage ecran B) — lecture service-role, pas de fuite cross-user
    // car on n'expose que le bien deja lie au token.
    const { data: prop } = await supabase
      .from('properties')
      .select('name')
      .eq('id', sess.property_id)
      .maybeSingle()

    return res.status(200).json({
      property_id: sess.property_id,
      provider_property_id: sess.provider_property_id,
      name: prop?.name || null,
      channel_id: channelId
    })
  }

  // ===================================================================
  // create : genere le lien OAuth Airbnb direct. AUTH hote requise.
  // ===================================================================
  const authToken = req.headers.authorization?.replace('Bearer ', '')
  if (!authToken) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authError } = await supabase.auth.getUser(authToken)
  if (authError || !userData?.user) return res.status(401).json({ error: 'Session invalide' })
  const user = userData.user

  const propertyId = (req.body?.property_id || '').trim()
  if (!propertyId) return res.status(400).json({ error: 'property_id (UUID HoteSmart) requis' })

  // Ownership : SES biens uniquement.
  const { data: prop, error: propErr } = await supabase
    .from('properties')
    .select('id, provider, provider_property_id, name')
    .eq('id', propertyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (propErr) {
    console.error('[channel-airbnb-connect] create SELECT', propErr.message)
    return res.status(500).json({ error: 'Erreur lecture' })
  }
  if (!prop) return res.status(404).json({ error: 'Bien introuvable' })
  if (prop.provider !== 'channel' && prop.provider !== 'channex') {
    return res.status(400).json({ error: "Ce bien n'est pas gere par le gestionnaire de canaux" })
  }
  if (!prop.provider_property_id) {
    return res.status(400).json({ error: 'Bien non provisionne cote gestionnaire' })
  }

  try {
    const groupId = await resolveGroupId(prop.provider_property_id)
    if (!groupId) {
      return res.status(400).json({ error: 'Bien non rattache a un groupe (provisioning incomplet)' })
    }

    // Nonce de session : lie le retour Airbnb au bon hote/bien.
    const token = crypto.randomBytes(32).toString('hex')
    const { error: insErr } = await supabase
      .from('airbnb_connect_sessions')
      .insert({
        token,
        user_id: user.id,
        property_id: prop.id,
        provider_property_id: prop.provider_property_id,
        status: 'pending'
      })
    if (insErr) {
      console.error('[channel-airbnb-connect] INSERT session', insErr.message)
      return res.status(500).json({ error: 'Erreur creation session' })
    }

    const redirectUri = `${APP_URL}/pages/airbnb-retour.html`
    const failureUri = `${APP_URL}/pages/airbnb-retour.html?failure=1`

    const payload = { connection_link: {
      group_id: groupId,
      properties: [prop.provider_property_id],
      redirect_uri: redirectUri,
      failure_redirect_uri: failureUri,
      token,
      title: `HoteSmart — ${prop.name || 'Logement'}`,
      settings: {
        min_stay_type: 'Arrival',
        booking_amount_settings: 'Payout Amount',
        cohost_payout_calculations: false,
        send_email_notifications: false
      }
    }}

    const r = await channelCall('POST', '/meta/airbnb/connection_link', payload)
    const url = r.json?.data?.attributes?.url
    if (!r.ok || !url) {
      console.error('[channel-airbnb-connect] connection_link echec', r.status, JSON.stringify(r.json).slice(0, 500))
      return res.status(502).json({ error: 'Generation du lien Airbnb echouee' })
    }

    return res.status(200).json({ oauth_url: url })
  } catch (err) {
    console.error('[channel-airbnb-connect]', err.message)
    return res.status(500).json({ error: 'Erreur interne' })
  }
}
