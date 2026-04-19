const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')

// ─── Clients partagés ─────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY })

// ─── Signature GuestFlow AI ──────────────────────────────────────────────────
// Injectée dans tous les messages envoyés via sendViaBeds24 (plan Free).
// TODO Pro : désactivable via flag api_keys.signature_enabled = false
const GUESTFLOW_SIGNATURE = '\n\n— propulsé par GuestFlow'

// ─── Flag d'activation production sendViaBeds24 ──────────────────────────────
// Permet de basculer en prod via variable Vercel sans redéployer le code.
// false = mode "safety" : on log ce qu'on aurait envoyé mais on n'envoie pas.
// true  = envoi réel au voyageur via Beds24.
const SENDVIABEDS24_ENABLED = process.env.SENDVIABEDS24_ENABLED === 'true'

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
  getPropertyMode,
  formatDate,
  parseDelay
}
