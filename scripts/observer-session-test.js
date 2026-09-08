// Observation d'une session de test du moteur de reservation.
// LECTURE SEULE, STRICTEMENT. Aucun POST, aucune ecriture, aucun appel
// a un endpoint qui agit.
//
// ⚠ VECU (etape 4) : un outil de « validation » qui POSTait sur
// /api/book-pay pour eprouver la garde a cree une vraie tentative et
// tenu trois nuits. Un observateur n'agit pas : il lit Supabase.
//
// ⚠ N'IMPRIME JAMAIS un jeton, une cle ou un secret.
//
// Usage : node scripts/observer-session-test.js [AAAA-MM-JJ debut] [jours]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const PID  = 'e14e25f6-168a-4826-80dd-ddbf78ac44c1'   // properties.id (UUID)
const PROP = '0544fd9a-6579-44e7-b75e-19c63a2019ba'   // provider_property_id (TEXT)
const UID  = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'

const DEBUT = process.argv[2] || '2026-11-17'
const JOURS = Number(process.argv[3] || 4)

function plage (debut, jours) {
  const out = []
  const d = new Date(debut + 'T12:00:00Z')
  for (let i = 0; i < jours; i++) {
    out.push(new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10))
  }
  return out
}

async function main () {
  const dates = plage(DEBUT, JOURS)
  console.log('=== OBSERVATION ' + new Date().toISOString().slice(0, 16) + ' — Colomiers ===')
  console.log('   plage observee :', dates[0], '→', dates[dates.length - 1])

  // 1. Liens de reservation. Le jeton n'est JAMAIS imprime.
  const { data: liens, error: eL } = await s
    .from('booking_links')
    .select('id, label, price_coefficient, active, created_at')
    .eq('property_id', PID).order('created_at')
  console.log('\n-- LIENS --')
  if (eL) console.log('   erreur :', eL.message)
  else if (!liens.length) console.log('   (aucun)')
  else liens.forEach(l => console.log('  ', (l.label || '(sans label)').padEnd(28),
    'coef=' + l.price_coefficient, l.active ? 'ACTIF' : 'revoque', l.created_at.slice(0, 16)))

  // 2. La memoire d'intention, nuit par nuit.
  const { data: inv, error: eI } = await s
    .from('calendar_inventory')
    .select('date, stop_sell, rate, avail, min_stay_arrival, min_stay_through, cta, ctd, updated_at')
    .eq('property_id', PID).in('date', dates).order('date')
  console.log('\n-- NUITS (memoire d\'intention) --')
  if (eI) console.log('   erreur :', eI.message)
  else dates.forEach(d => {
    const r = (inv || []).find(x => x.date === d)
    if (!r) return console.log('  ', d, 'AUCUNE LIGNE')
    const c = [r.min_stay_arrival > 1 && 'msa=' + r.min_stay_arrival,
               r.min_stay_through > 1 && 'mst=' + r.min_stay_through,
               r.cta && 'CTA', r.ctd && 'CTD'].filter(Boolean).join(' ')
    console.log('  ', d,
      (r.stop_sell ? 'FERMEE' : 'ouverte').padEnd(8),
      ('prix=' + (r.rate == null ? 'base(86)' : r.rate)).padEnd(14),
      'avail=' + r.avail,
      c ? '| ' + c : '',
      '| maj ' + String(r.updated_at).slice(0, 16))
  })

  // 3. Les tentatives de reservation.
  const { data: t, error: eT } = await s
    .from('booking_attempts')
    .select('id, status, arrival, departure, guests, amount_cents, price_coefficient, paid_at, provider_booking_id, hold_expires_at, last_error, created_at')
    .eq('property_id', PID).order('created_at', { ascending: false }).limit(10)
  console.log('\n-- TENTATIVES (10 dernieres) --')
  if (eT) console.log('   erreur :', eT.message)
  else if (!t.length) console.log('   (aucune)')
  else t.forEach(x => console.log('  ', x.id.slice(0, 8),
    String(x.status).padEnd(10), x.arrival, '→', x.departure,
    (x.amount_cents / 100).toFixed(2) + '€', 'coef=' + x.price_coefficient,
    x.paid_at ? 'paye ' + x.paid_at.slice(11, 16) : 'non paye',
    x.provider_booking_id ? 'CRS=' + String(x.provider_booking_id).slice(0, 8) : '',
    x.last_error ? '| ERR ' + String(x.last_error).slice(0, 60) : ''))

  // 4. Les verrous : une tenue de nuits en cours.
  const { data: w, error: eW } = await s
    .from('write_locks').select('key, expire_at, created_at').order('created_at', { ascending: false }).limit(5)
  console.log('\n-- VERROUS --')
  if (eW) console.log('   erreur :', eW.message)
  else if (!w.length) console.log('   (aucun)')
  else w.forEach(x => console.log('  ', x.key, 'expire', String(x.expire_at).slice(0, 16)))

  // 5. Ce que le coeur a enregistre cote provider.
  const { data: b, error: eB } = await s
    .from('bookings_snapshot').select('booking_id, snapshot, updated_at').eq('property_id', PROP).limit(500)
  console.log('\n-- RESAS DU COEUR sur la plage --')
  if (eB) console.log('   erreur :', eB.message)
  else {
    const sur = (b || []).map(x => ({
      id: x.booking_id,
      a: x.snapshot?.arrival || x.snapshot?.checkin,
      d: x.snapshot?.departure || x.snapshot?.checkout,
      s: x.snapshot?.status, maj: x.updated_at
    })).filter(x => x.a && x.d && x.a <= dates[dates.length - 1] && x.d >= dates[0])
    if (!sur.length) console.log('   (aucune)')
    else sur.forEach(x => console.log('  ', x.a, '→', x.d, String(x.s).padEnd(10), x.id.slice(0, 8), '| maj', String(x.maj).slice(0, 16)))
  }

  // 6. Le compte Stripe de l'hote. Aucune cle, aucun secret.
  const { data: st, error: eS } = await s
    .from('stripe_accounts')
    .select('mode, key_restricted, webhook_endpoint_id, verified_at, last_error')
    .eq('user_id', UID)
  console.log('\n-- COMPTE STRIPE DE L\'HOTE --')
  if (eS) console.log('   erreur :', eS.message)
  else if (!st.length) console.log('   (aucun)')
  else st.forEach(x => console.log('  ', 'mode=' + x.mode, x.key_restricted ? 'clé restreinte' : '⚠ NON RESTREINTE',
    'webhook=' + (x.webhook_endpoint_id ? 'cree' : 'AUCUN'),
    'verifie=' + (x.verified_at ? x.verified_at.slice(0, 10) : 'jamais'),
    x.last_error ? '| ERR ' + x.last_error : ''))
}

main().catch(e => { console.error('observation impossible :', e.message); process.exit(1) })
