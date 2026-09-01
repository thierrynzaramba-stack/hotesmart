// scripts/test-droits.js
// Test REEL des politiques de droits, vu par le compte test.
//
// Se connecte a Supabase avec l'ANON KEY et la session du compte test — donc
// exactement comme le navigateur, RLS active. La service key n'est jamais
// utilisee ici : elle contournerait ce qu'on cherche a verifier.
//
// USAGE
//   node scripts/test-droits.js            # lot en cours (LOT_COURANT)
//   node scripts/test-droits.js 1          # un lot precis
//   node scripts/test-droits.js toutes     # toutes les tables connues
//
// PREREQUIS dans .env.local (jamais commite) :
//   TEST_EMAIL=...    TEST_PASSWORD=...    SUPABASE_URL=...    SUPABASE_ANON_KEY=...
//
// Les tentatives d'ECRITURE font partie du test : elles DOIVENT echouer. Aucune
// donnee n'est modifiee — si une ecriture passait, ce serait justement le bug.

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')

const LOT_COURANT = 1

// Perimetre attendu du compte test : un seul bien, lecture reservations + menages.
const DROITS_ATTENDUS = { reservations: 'read', menages: 'read' }

// domaine : le domaine de la table · cle : 'text' | 'uuid' | null (pas de bien)
const LOTS = {
  1: [
    { table: 'automation_incidents', domaine: 'reglages', cle: 'text' },
    { table: 'integration_requests',  domaine: 'reglages', cle: null },
    { table: 'onboarding_state',      domaine: 'reglages', cle: null },
    { table: 'agent_prompting',       domaine: 'reglages', cle: 'text' },
    { table: 'conversation_flags',    domaine: 'messages', cle: null }
  ],
  2: [
    { table: 'sms_logs',         domaine: 'messages', cle: 'text' },
    { table: 'message_sent_log', domaine: 'messages', cle: null },
    { table: 'agent_tasks',      domaine: 'messages', cle: 'text' },
    { table: 'menage_comments',  domaine: 'menages',  cle: 'text' },
    { table: 'menage_done',      domaine: 'menages',  cle: 'text' }
  ],
  3: [
    { table: 'menage_events',     domaine: 'menages',      cle: 'text' },
    { table: 'property_status',   domaine: 'menages',      cle: 'text' },
    { table: 'public_tokens',     domaine: 'prestataires', cle: null },
    { table: 'locks',             domaine: 'reglages',     cle: null },
    { table: 'lock_alert_config', domaine: 'reglages',     cle: null }
  ],
  4: [
    { table: 'messages',          domaine: 'messages', cle: 'text' },
    { table: 'conversations',     domaine: 'messages', cle: 'text' },
    { table: 'message_templates', domaine: 'messages', cle: 'text' },
    { table: 'knowledge',         domaine: 'reglages', cle: 'text' }
  ],
  5: [
    { table: 'bookings_snapshot',      domaine: 'reservations', cle: 'text' },
    { table: 'booking_change_events',  domaine: 'reservations', cle: 'text' },
    { table: 'access_codes',           domaine: 'reservations', cle: 'text' },
    { table: 'property_locks',         domaine: 'reglages',     cle: 'text' },
    { table: 'airbnb_connect_sessions',domaine: 'reglages',     cle: 'uuid' }
  ],
  6: [
    { table: 'properties',        domaine: 'dedie',       cle: 'uuid' },
    { table: 'api_keys',          domaine: 'dedie',       cle: null },
    { table: 'agent_alert_config',domaine: 'reglages',    cle: null },
    { table: 'accounts',          domaine: 'facturation', cle: null },
    { table: 'subscriptions',     domaine: 'facturation', cle: null }
  ]
}

const V = '\x1b[32m✓\x1b[0m'
const X = '\x1b[31m✗\x1b[0m'
const bilan = { ok: 0, ko: 0, details: [] }

function verdict(condition, libelle, detail) {
  if (condition) { bilan.ok++; console.log(`      ${V} ${libelle}`) }
  else { bilan.ko++; bilan.details.push(libelle); console.log(`      ${X} ${libelle}${detail ? '  — ' + detail : ''}`) }
}

async function main() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, TEST_EMAIL, TEST_PASSWORD } = process.env
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { console.error('SUPABASE_URL / SUPABASE_ANON_KEY absents de .env.local'); process.exit(1) }
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    console.error('TEST_EMAIL / TEST_PASSWORD absents de .env.local.')
    console.error('Ajoutez-les (le fichier est deja ignore par git) :')
    console.error('  TEST_EMAIL=thierrylapoule31@gmail.com')
    console.error('  TEST_PASSWORD=...')
    process.exit(1)
  }

  // ANON KEY + session utilisateur : exactement ce que fait le navigateur.
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD })
  if (authErr) { console.error('Connexion du compte test impossible :', authErr.message); process.exit(1) }
  console.log(`Connecte en tant que ${TEST_EMAIL}\n`)

  // Le perimetre tel que la base le voit.
  const { data: perms } = await sb.from('profile_permissions').select('*')
  const { data: profs } = await sb.from('profiles').select('*')
  const monProfil = (profs || []).find(p => p.member_user_id === auth.user.id && !p.is_owner)
  const mesDroits = (perms || []).find(p => p.profile_id === monProfil?.id)

  if (!monProfil) {
    console.log('⚠ Aucun profil de membre trouve : le SQL d\'invitation a-t-il ete execute ?\n')
  } else {
    console.log(`Profil : ${monProfil.first_name} ${monProfil.last_name || ''} · compte ${String(monProfil.account_user_id).slice(0, 8)}…`)
    if (mesDroits) {
      console.log(`Perimetre : ${mesDroits.property_scope} · refs autorisees ${JSON.stringify(mesDroits.property_refs)}`)
      console.log(`Droits : ${Object.entries(DROITS_ATTENDUS).map(([d, n]) => `${d}=${n}`).join(' ')}\n`)
    }
  }

  const refsOk = new Set((mesDroits?.property_refs || []).map(String))
  const idsOk  = new Set((mesDroits?.property_ids  || []).map(String))
  const arg = process.argv[2]
  const lots = arg === 'toutes' ? Object.keys(LOTS) : [String(arg || LOT_COURANT)]

  for (const numero of lots) {
    const tables = LOTS[numero]
    if (!tables) { console.error(`Lot ${numero} inconnu`); continue }
    console.log(`\n${'═'.repeat(72)}\nLOT ${numero}\n${'═'.repeat(72)}`)

    for (const { table, domaine, cle } of tables) {
      const attendu = DROITS_ATTENDUS[domaine] || 'none'
      console.log(`\n  ${table}  (domaine ${domaine}, droit attendu : ${attendu})`)

      // ── LECTURE ──
      const { data, error } = await sb.from(table).select('*')
      if (error) {
        verdict(attendu === 'none', `lecture refusee (${error.message.slice(0, 40)})`, attendu !== 'none' ? 'attendu : lisible' : '')
        continue
      }
      const lignes = data || []

      if (attendu === 'none') {
        verdict(lignes.length === 0, `aucune ligne visible (${lignes.length} remontee(s))`,
                lignes.length ? 'FUITE : domaine non autorise' : '')
      } else {
        // Le compte test doit voir SES lignes autorisees, et rien d'autre.
        if (cle) {
          const autorisees = new Set(cle === 'uuid' ? idsOk : refsOk)
          const horsPerimetre = lignes.filter(r => r.property_id != null && !autorisees.has(String(r.property_id)))
          verdict(horsPerimetre.length === 0,
                  `${lignes.length} ligne(s) visible(s), toutes dans le perimetre`,
                  horsPerimetre.length ? `FUITE : ${horsPerimetre.length} ligne(s) d'un autre bien` : '')
        } else {
          verdict(true, `${lignes.length} ligne(s) visible(s) (table sans bien)`)
        }
      }

      // ── ECRITURE (doit echouer) ──
      // On tente une mise a jour qui ne change rien de reel : seule compte la
      // reponse de la RLS. Si la table est vide ou invisible, on tente un insert
      // minimal, egalement voue a l'echec.
      let ecritureRefusee = false, motif = ''
      if (lignes.length) {
        const cible = lignes[0]
        const { error: upErr, count } = await sb.from(table)
          .update({ updated_at: new Date().toISOString() })
          .eq('id', cible.id ?? null)
          .select('*', { count: 'exact', head: true })
        ecritureRefusee = !!upErr || count === 0
        motif = upErr ? upErr.message.slice(0, 50) : (count === 0 ? 'aucune ligne affectee' : 'ECRITURE ACCEPTEE')
      } else {
        const { error: insErr } = await sb.from(table).insert({ user_id: auth.user.id })
        ecritureRefusee = !!insErr
        motif = insErr ? insErr.message.slice(0, 50) : 'ECRITURE ACCEPTEE'
      }
      verdict(ecritureRefusee, `ecriture refusee`, ecritureRefusee ? '' : motif)
    }
  }

  console.log(`\n${'═'.repeat(72)}`)
  console.log(`BILAN : ${bilan.ok} conforme(s), ${bilan.ko} ecart(s)`)
  if (bilan.ko) {
    console.log('\nEcarts :')
    bilan.details.forEach(d => console.log('  -', d))
  }
  await sb.auth.signOut()
  process.exit(bilan.ko ? 1 : 0)
}

main().catch(e => { console.error(e.message); process.exit(1) })
