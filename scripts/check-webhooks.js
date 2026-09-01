// scripts/check-webhooks.js
// SCRIPT JETABLE (lecture seule) — à supprimer après usage.
// Liste les webhooks enregistrés côté channel manager (Channex) pour les
// comparer à ce que le code attend (cf. api/channel-webhook.js : event_mask
// 'booking;message', is_global true, is_active true).
//
// Aucun secret en dur : tout est lu depuis l'environnement.
// Charge .env s'il existe (optionnel), sinon utilise process.env tel quel.

try { require('dotenv').config() } catch { /* dotenv absent : on lit process.env directement */ }

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

function rappelEnv() {
  console.error('Variables manquantes. Fournir CHANNEL_BASE_URL et CHANNEL_API_KEY, ex :')
  console.error('  CHANNEL_BASE_URL=... CHANNEL_API_KEY=... node scripts/check-webhooks.js')
  console.error('(ou les définir dans un fichier .env à la racine)')
}

async function main() {
  if (!CHANNEL_API || !CHANNEL_KEY) {
    rappelEnv()
    process.exit(1)
  }

  // Même contrat que channelCall() dans api/channel-webhook.js :
  // URL = CHANNEL_BASE_URL + path, header d'auth = user-api-key.
  const res = await fetch(`${CHANNEL_API}/webhooks`, {
    method: 'GET',
    headers: {
      'user-api-key': CHANNEL_KEY,
      'Content-Type': 'application/json'
    }
  })

  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }

  if (!res.ok) {
    console.error('GET /webhooks a échoué — status', res.status)
    console.error(JSON.stringify(json, null, 2))
    process.exit(1)
  }

  const list = Array.isArray(json?.data) ? json.data : []
  console.log(`Webhooks enregistrés : ${list.length}`)
  console.log('Attendu par le code : event_mask "booking;message", is_global true, is_active true\n')

  list.forEach((item, i) => {
    const w = item.attributes || item
    console.log(`#${i + 1}`)
    console.log('  callback_url :', w.callback_url)
    console.log('  event_mask   :', w.event_mask)
    console.log('  is_active    :', w.is_active)
    console.log('  is_global    :', w.is_global)
    console.log('')
  })
}

main().catch((err) => {
  console.error('Erreur :', err.message)
  process.exit(1)
})
