const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')

// ─── Clients partagés ─────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY })

// ─── Signature GuestFlow AI ──────────────────────────────────────────────────
// Mécanisme viral du plan GRATUIT uniquement : un abonnement guestflow actif
// (trialing / active / past_due) supprime la signature.
const GUESTFLOW_SIGNATURE = '\n\n— propulsé par GuestFlow'

// ─── Flag d'activation production sendViaBeds24 ──────────────────────────────
// Permet de basculer en prod via variable Vercel sans redéployer le code.
// false = mode "safety" : on log ce qu'on aurait envoyé mais on n'envoie pas.
// true  = envoi réel au voyageur via Beds24.
const SENDVIABEDS24_ENABLED = process.env.SENDVIABEDS24_ENABLED === 'true'

// ─── Abonnement actif ? ──────────────────────────────────────────────────────
// Même logique que la sidebar : module guestflow, status trialing/active/past_due.
// Cache mémoire 5 min (durée de vie d'une invocation cron) pour éviter une
// requête par message envoyé.
const _subCache = new Map() // userId -> { value, expires }

async function hasActiveSubscription(userId) {
  if (!userId) return false
  const cached = _subCache.get(userId)
  if (cached && cached.expires > Date.now()) return cached.value

  let value = false
  try {
    const { data } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', userId)
      .eq('module', 'guestflow')
      .maybeSingle()
    value = !!data && ['trialing', 'active', 'past_due'].includes(data.status)
  } catch {
    value = false
  }
  _subCache.set(userId, { value, expires: Date.now() + 5 * 60 * 1000 })
  return value
}

// ─── Signature à apposer pour une clé Beds24 donnée ──────────────────────────
// Résout l'utilisateur depuis api_keys.api_key puis vérifie son abonnement.
// Renvoie '' (abonné) ou GUESTFLOW_SIGNATURE (plan gratuit / clé inconnue).
const _keyUserCache = new Map() // beds24Key -> { userId, expires }

async function getSignatureForKey(beds24Key) {
  if (!beds24Key) return GUESTFLOW_SIGNATURE
  try {
    let userId = null
    const cached = _keyUserCache.get(beds24Key)
    if (cached && cached.expires > Date.now()) {
      userId = cached.userId
    } else {
      const { data } = await supabase
        .from('api_keys')
        .select('user_id')
        .eq('api_key', beds24Key)
        .maybeSingle()
      userId = data?.user_id || null
      _keyUserCache.set(beds24Key, { userId, expires: Date.now() + 5 * 60 * 1000 })
    }
    if (!userId) return GUESTFLOW_SIGNATURE
    return (await hasActiveSubscription(userId)) ? '' : GUESTFLOW_SIGNATURE
  } catch {
    return GUESTFLOW_SIGNATURE
  }
}

// ─── Lecture mode test/auto par logement ─────────────────────────────────────
async function getPropertyMode(userId, propertyId) {
  try {
    const { data } = await supabase
      .from('agent_alert_config')
      .select('config')
      .eq('user_id', userId)
      .single()
    return data?.config?.[propertyId]?.mode || 'test'
  } catch {
    return 'test'
  }
}

// ─── Helpers format ──────────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  })
}

function parseDelay(value) {
  if (!value) return 0
  const map = {
    '5min': 5, '15min': 15, '30min': 30,
    '1h': 60, '2h': 120, '4h': 240, '8h': 480,
    '24h': 1440, '0min': 0
  }
  return map[value] || 0
}

module.exports = {
  supabase,
  anthropic,
  GUESTFLOW_SIGNATURE,
  SENDVIABEDS24_ENABLED,
  hasActiveSubscription,
  getSignatureForKey,
  getPropertyMode,
  formatDate,
  parseDelay
}
