// scripts/backfill-beds24-host.js
// ─────────────────────────────────────────────────────────────────────────────
// BACKFILL ONE-SHOT (etape 4, Option A2) : reinjecte dans la table `messages`
// les messages HOST (sortants cote hote) de l'historique des threads Beds24, qui
// n'ont jamais ete ecrits (syncMessages n'ecrit QUE les guest, et les producteurs
// de l'etape 2 n'ont commence qu'au deploiement).
//
// ANTI-DOUBLON = COUPURE TEMPORELLE :
//   on ne backfille QUE les host dont time < CUTOFF (1er write Beds24 sortant).
//   Avant CUTOFF, `messages` n'avait aucun sortant Beds24 -> zero overlap.
//   Apres CUTOFF, les sortants sont deja couverts (id-less) par les producteurs.
//   Idempotent : provider_msg_id = m.id -> recordMessage Cas 1 (SELECT-then-INSERT)
//   -> re-jouable sans doublon.
//
// AUTONOME : lit les cles Beds24 depuis api_keys, itere les biens (fetchProperties),
// lit le thread (fetchMessages) + les bookings (fetchBookingsHistory, pour l'ota).
// Ne touche a RIEN d'autre : lecture Beds24 + ecriture `messages` via recordMessage.
//
// DEUX usages :
//   1) CLI    : node scripts/backfill-beds24-host.js   (DRY_RUN reglable ci-dessous)
//   2) require: const { runBackfill } = require('.../scripts/backfill-beds24-host')
//               await runBackfill({ dryRun }) -> renvoie le recap structure
//      (utilise par l'endpoint one-shot api/backfill-beds24-host.js)
// ─────────────────────────────────────────────────────────────────────────────

// ── Reglages (bien visibles) ────────────────────────────────────────────────
const CUTOFF         = '2026-06-30T12:02:56+02:00'  // 1er write Beds24 sortant (commit ae1668b)
const MSG_LIMIT      = 500                            // messages fetches par bien
const HISTORY_MONTHS = 12                            // profondeur bookings (pour l'ota)
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { refreshBeds24Tokens, fetchProperties, fetchBookingsHistory, fetchMessages } = require('../lib/cron-beds24')
const { recordMessage } = require('../lib/record-message')

const CUTOFF_MS = new Date(CUTOFF).getTime()

// Coeur du backfill. Renvoie un recap structure (JSON-serialisable). Ne fait
// jamais process.exit (utilisable depuis un endpoint). dryRun=true -> aucune ecriture.
async function runBackfill({ dryRun = true } = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { error: 'env_missing', cutoff: CUTOFF, dryRun, global: null, properties: [] }
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

  console.log('[backfill] CUTOFF', CUTOFF, '| MODE', dryRun ? 'DRY-RUN' : 'REEL')

  // Token Beds24 frais avant tout fetch (comme api/cron.js). Non bloquant.
  try { await refreshBeds24Tokens() }
  catch (err) { console.error('[backfill] refresh tokens echec (on continue):', err.message) }

  const { data: apiKeys, error: keyErr } = await supabase
    .from('api_keys')
    .select('user_id, api_key')
    .not('api_key', 'is', null)
  if (keyErr) return { error: 'api_keys:' + keyErr.message, cutoff: CUTOFF, dryRun, global: null, properties: [] }
  if (!apiKeys?.length) return { error: null, cutoff: CUTOFF, dryRun, global: emptyCounters(), properties: [] }

  const G = emptyCounters()
  const perProperty = []

  for (const { user_id, api_key } of apiKeys) {
    let properties = []
    try { properties = await fetchProperties(api_key) }
    catch (err) { console.error(`[backfill] fetchProperties echec user ${user_id}:`, err.message); continue }

    for (const property of (properties || [])) {
      const P = emptyCounters()
      try {
        const messages = await fetchMessages(api_key, property.id, MSG_LIMIT)
        const bookingsData = await fetchBookingsHistory(api_key, property.id, HISTORY_MONTHS)
        const bookingsMap = {}
        ;(bookingsData || []).forEach(b => { bookingsMap[String(b.id)] = b })

        const hosts = (messages || []).filter(m => m.source === 'host')
        P.hostFound = hosts.length

        for (const m of hosts) {
          if (!(new Date(m.time).getTime() < CUTOFF_MS)) continue   // coupure stricte
          P.beforeCutoff++
          if (!m.id) { P.noId++; continue }                         // pas d'id -> on n'injecte pas

          const booking = bookingsMap[String(m.bookingId)]
          const ota = booking ? (booking.channel || booking.apiSource || booking.referer || null) : null

          if (dryRun) { P.inserted++; continue }                    // "would insert"

          const r = await recordMessage({
            userId:        user_id,
            provider:      'beds24',
            propertyId:    property.id,
            bookingId:     m.bookingId,
            direction:     'outbound',
            sender:        'host',
            body:          m.message,
            providerMsgId: m.id,
            ota:           ota,
            sentAt:        m.time,
            kind:          'message'
          })
          if (!r.ok)          P.errors++
          else if (r.skipped) P.skipped++
          else                P.inserted++
        }
      } catch (err) {
        console.error(`[backfill] erreur bien ${property.id}:`, err.message)
        P.errors++
      }

      perProperty.push({ propId: String(property.id), name: property.name || '', ...P })
      addCounters(G, P)
      console.log(`[backfill] bien ${property.id} host:${P.hostFound} <cutoff:${P.beforeCutoff} ${dryRun ? 'aInserer' : 'inseres'}:${P.inserted} skip:${P.skipped} sansId:${P.noId} err:${P.errors}`)
    }
  }

  console.log('[backfill] GLOBAL', JSON.stringify(G), '| MODE', dryRun ? 'DRY-RUN' : 'REEL')
  return { error: null, cutoff: CUTOFF, dryRun, global: G, properties: perProperty }
}

function emptyCounters() { return { hostFound: 0, beforeCutoff: 0, inserted: 0, skipped: 0, errors: 0, noId: 0 } }
function addCounters(g, p) { for (const k of Object.keys(g)) g[k] += p[k] }

// ── Entree CLI directe : node scripts/backfill-beds24-host.js ────────────────
// Regler DRY_RUN ici pour le lancement en ligne de commande.
if (require.main === module) {
  const DRY_RUN = true
  runBackfill({ dryRun: DRY_RUN })
    .then(recap => { console.log(JSON.stringify(recap, null, 2)); process.exit(recap.error ? 1 : 0) })
    .catch(err => { console.error('[backfill] fatal:', err); process.exit(1) })
}

module.exports = { runBackfill, CUTOFF }
