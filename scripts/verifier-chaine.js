// scripts/verifier-chaine.js
// Affiche la CHAINE COMPLETE d'une reservation, du snapshot jusqu'aux effets :
// snapshot -> booking_change_event (+ processed_at) -> menage_event -> message
// envoye -> code d'acces.
//
// A utiliser des qu'une reservation bouge, pour verifier bout en bout le flux
// d'unification (docs/kb/booking-changes.md).
//
// USAGE
//   node scripts/verifier-chaine.js <booking_id>
//   node scripts/verifier-chaine.js <booking_id> --avec-code   (affiche le PIN en clair)
//   node scripts/verifier-chaine.js --recents                  (10 derniers changements)
//
// LECTURE SEULE : ce script n'ecrit jamais rien.
// Le PIN de la serrure est masque par defaut (c'est un secret d'acces physique).

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const args      = process.argv.slice(2)
const AVEC_CODE = args.includes('--avec-code')
const RECENTS   = args.includes('--recents')
const bookingId = args.find(a => !a.startsWith('--'))

const t   = s => String(s == null ? '—' : s)
const ok  = b => (b ? '✓' : '✗')
const cut = (s, n) => { const v = t(s); return v.length > n ? v.slice(0, n) + '…' : v }

function titre(s) { console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`) }

// ─── Les 10 derniers changements, pour trouver quoi inspecter ───────────────
async function recents() {
  const { data, error } = await supabase
    .from('booking_change_events')
    .select('booking_id, property_id, provider, type, created_at, processed_at, processing_errors')
    .order('created_at', { ascending: false })
    .limit(10)
  if (error) return console.error('lecture booking_change_events :', error.message)
  if (!data?.length) return console.log('Aucun changement enregistre pour le moment.')

  titre('10 DERNIERS CHANGEMENTS')
  data.forEach(e => {
    const etat = e.processed_at ? 'traite' : 'EN ATTENTE'
    const err  = e.processing_errors ? ' ⚠ ' + cut(JSON.stringify(e.processing_errors), 60) : ''
    console.log(`${t(e.created_at).slice(0, 19)}  ${t(e.type).padEnd(9)} booking=${t(e.booking_id).padEnd(12)} ${t(e.provider).padEnd(8)} ${etat}${err}`)
  })
  console.log('\nDetail : node scripts/verifier-chaine.js <booking_id>')
}

async function chaine(id) {
  console.log(`\n╔${'═'.repeat(70)}╗`)
  console.log(`║  CHAINE DE LA RESERVATION ${id.padEnd(43)}║`)
  console.log(`╚${'═'.repeat(70)}╝`)

  // ─── 1. Snapshot (source de verite) ───
  titre('1. SNAPSHOT  (bookings_snapshot — memoire d\'etat)')
  const { data: snaps, error: snapErr } = await supabase
    .from('bookings_snapshot').select('*').eq('booking_id', id)
  if (snapErr) console.error('  erreur :', snapErr.message)
  else if (!snaps?.length) console.log('  ✗ AUCUN SNAPSHOT — la reservation n\'a jamais ete synchronisee')
  else snaps.forEach(r => {
    const s = r.snapshot || {}
    console.log(`  bien ${t(r.property_id)} · maj ${t(r.updated_at).slice(0, 19)}`)
    console.log(`  provider=${t(s.provider)}  statut=${t(s.status)} (brut: ${t(s.statusRaw)})`)
    console.log(`  ${t(s.firstName)} ${t(s.lastName)} · ${t(s.arrival)} -> ${t(s.departure)} · ${t(s.numAdult)} adulte(s) ${t(s.numChild)} enfant(s)`)
    console.log(`  source=${t(s.source)}  codeOTA=${t(s.otaReservationCode)}  montant=${t(s.amount)} ${t(s.currency || '')}`)
  })

  // ─── 2. Changements detectes ───
  titre('2. CHANGEMENTS  (booking_change_events — file du dispatcher)')
  const { data: evs, error: evErr } = await supabase
    .from('booking_change_events').select('*').eq('booking_id', id)
    .order('created_at', { ascending: true })
  if (evErr) console.error('  erreur :', evErr.message)
  else if (!evs?.length) console.log('  ✗ aucun changement enregistre (normal si la reservation n\'a jamais bouge)')
  else evs.forEach(e => {
    const attente = !e.processed_at
    console.log(`  ${t(e.created_at).slice(0, 19)}  ${t(e.type).toUpperCase()}`)
    console.log(`     traite : ${ok(!!e.processed_at)} ${e.processed_at ? t(e.processed_at).slice(0, 19) : 'EN ATTENTE — sera distribue au prochain cycle'}`)
    if (attente) console.log('     ⚠ en attente depuis plus de 5 min ? verifier les logs du cron')
    if (e.changes) {
      Object.entries(e.changes).forEach(([champ, v]) => {
        if (v) console.log(`     ${champ} : ${t(v.before)} -> ${t(v.after)}`)
      })
    }
    if (e.processing_errors) console.log(`     ⚠ ERREURS : ${JSON.stringify(e.processing_errors)}`)
  })

  // ─── 3. Notifications prestataire ───
  titre('3. MENAGE  (menage_events — notifications prestataire)')
  const { data: mes, error: meErr } = await supabase
    .from('menage_events').select('*').eq('booking_id', id)
    .order('created_at', { ascending: true })
  if (meErr) console.error('  erreur :', meErr.message)
  else if (!mes?.length) console.log('  ✗ aucune notification prestataire')
  else mes.forEach(m => {
    const d = m.event_data || {}
    console.log(`  ${t(m.created_at).slice(0, 19)}  ${t(m.event_type).padEnd(9)} token=${cut(m.token, 8)} lu=${ok(m.read)}`)
    console.log(`     ${t(d.guestName)} · ${t(d.arrival)} -> ${t(d.departure)}${d.changes ? ' · modifs: ' + cut(JSON.stringify(d.changes), 60) : ''}`)
  })

  // ─── 4. Messages voyageur ───
  titre('4. MESSAGES  (message_sent_log = anti-doublon · messages = trace)')
  const { data: logs, error: logErr } = await supabase
    .from('message_sent_log').select('*').eq('booking_id', id)
  if (logErr) console.error('  erreur :', logErr.message)
  else if (!logs?.length) console.log('  ✗ aucun envoi enregistre')
  else logs.forEach(l => console.log(`  ${t(l.sent_at).slice(0, 19)}  template=${cut(l.template_id, 8)}`))

  const { data: msgs, error: msgErr } = await supabase
    .from('messages').select('*').eq('booking_id', id)
    .order('created_at', { ascending: true })
  if (!msgErr && msgs?.length) {
    msgs.forEach(m => console.log(`  ${t(m.created_at).slice(0, 19)}  ${t(m.direction).padEnd(8)} ${t(m.sender).padEnd(6)} ota=${t(m.ota).padEnd(8)} provider=${t(m.provider).padEnd(8)} « ${cut(m.body, 60)} »`))
  }

  // ─── 5. Code d'acces ───
  titre('5. CODE D\'ACCES  (access_codes)')
  const { data: codes, error: codeErr } = await supabase
    .from('access_codes').select('*').eq('booking_id', id)
    .order('created_at', { ascending: true })
  if (codeErr) console.error('  erreur :', codeErr.message)
  else if (!codes?.length) console.log('  ✗ aucun code (normal sans serrure associee)')
  else codes.forEach(c => {
    const pin = c.code ? (AVEC_CODE ? c.code : `[${String(c.code).length} chiffres — --avec-code pour l'afficher]`) : 'AUCUN PIN';
    console.log(`  ${t(c.created_at).slice(0, 19)}  statut=${t(c.status).padEnd(8)} ${t(c.starts_at).slice(0, 16)} -> ${t(c.ends_at).slice(0, 16)}`)
    console.log(`     pin=${pin}  seam=${ok(!!c.seam_code_id)}`)
  })

  // ─── Verdict ───
  titre('LECTURE DE LA CHAINE')
  const enAttente = (evs || []).filter(e => !e.processed_at).length
  const enErreur  = (evs || []).filter(e => e.processing_errors).length
  console.log(`  snapshot : ${ok(snaps?.length)}   changements : ${(evs || []).length}   menage : ${(mes || []).length}   envois : ${(logs || []).length}   codes : ${(codes || []).length}`)
  if (enAttente) console.log(`  ⚠ ${enAttente} changement(s) EN ATTENTE de distribution`)
  if (enErreur)  console.log(`  ⚠ ${enErreur} changement(s) avec erreur de consommateur — voir processing_errors ci-dessus`)
  if (!enAttente && !enErreur && (evs || []).length) console.log('  ✓ tous les changements ont ete distribues sans erreur')
  console.log()
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents de .env.local')
    process.exit(1)
  }
  if (RECENTS) return recents()
  if (!bookingId) {
    console.log('Usage : node scripts/verifier-chaine.js <booking_id> [--avec-code]')
    console.log('        node scripts/verifier-chaine.js --recents')
    process.exit(1)
  }
  await chaine(bookingId)
}
main().catch(e => { console.error(e.message); process.exit(1) })
