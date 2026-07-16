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
// Renvoie le canal correspondant (avec attributes.is_active) ou null.
async function findChannelForProperty(channelId, providerPropertyId) {
  const r = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(providerPropertyId)}`)
  const rows = Array.isArray(r.json?.data) ? r.json.data : []
  return rows.find(c => String(c.id) === String(channelId)) || null
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
    const chan = await findChannelForProperty(channelId, sess.provider_property_id)
    if (!chan) {
      return res.status(403).json({ error: 'channel_id non rattache a ce bien' })
    }
    const channelIsActive = chan.attributes?.is_active === true

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
      channel_id: channelId,
      channel_is_active: channelIsActive
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

  // ===================================================================
  // account_status : le user a-t-il DEJA une connexion Airbnb (via ses autres biens) ?
  // Sert a proposer la re-connexion (multi-biens / meme compte Airbnb) plutot que de
  // recreer un canal en double. On ne PRESUME pas que 2 biens = meme compte : on liste
  // les canaux Airbnb existants et l'hote choisit (reutiliser vs nouveau compte).
  // ===================================================================
  if (action === 'account_status') {
    const { data: others, error: oErr } = await supabase
      .from('properties')
      .select('id, provider_property_id, name')
      .eq('user_id', user.id)
      .in('provider', ['channel', 'channex'])
      .neq('id', prop.id)
      .not('provider_property_id', 'is', null)
    if (oErr) {
      console.error('[channel-airbnb-connect] account_status SELECT', oErr.message)
      return res.status(500).json({ error: 'Erreur lecture' })
    }
    const seen = new Map()
    for (const o of (others || [])) {
      const r = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(o.provider_property_id)}`)
      const rows = Array.isArray(r.json?.data) ? r.json.data : []
      for (const c of rows) {
        const ota = c.attributes?.channel || c.attributes?.ota_name || ''
        if (String(ota).toUpperCase() !== 'AIRBNB') continue
        if (!seen.has(c.id)) {
          seen.set(c.id, {
            id: c.id,
            title: c.attributes?.title || 'Compte Airbnb',
            is_active: c.attributes?.is_active === true,
            via_property: o.name || null
          })
        }
      }
    }
    return res.status(200).json({ existing_channels: Array.from(seen.values()) })
  }

  // ===================================================================
  // create (+ re-connexion si channel_id fourni)
  // ===================================================================
  const reuseChannelId = (req.body?.channel_id || '').trim()

  try {
    let groupId = await resolveGroupId(prop.provider_property_id)
    // Liste des biens a associer au canal (le bien courant ; + ceux deja lies si re-connexion).
    let properties = [prop.provider_property_id]

    if (reuseChannelId) {
      // Flux de re-connexion (doc Channex : channel_id = canal existant). On garde les biens
      // deja lies et on AJOUTE le bien courant ; le canal reste le meme (pas de doublon).
      const ch = await channelCall('GET', `/channels/${reuseChannelId}`)
      const existing = ch.json?.data?.attributes?.properties || []
      properties = Array.from(new Set([...existing.map(String), prop.provider_property_id]))
      const grp = ch.json?.data?.relationships?.group?.data?.id
      if (grp) groupId = grp   // le groupe du canal existant prime
    }

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

    const link = {
      group_id: groupId,
      properties,
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
    }
    if (reuseChannelId) link.channel_id = reuseChannelId   // re-connexion : reutilise le canal
    const payload = { connection_link: link }

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
