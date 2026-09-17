// scripts/observer-test-canal-email.js
// Etape 6 du chantier « canal e-mail pour les reservations directes ».
//
// LE VERDICT DU TEST REEL, LU EN BASE — pas deduit.
//
// LECTURE SEULE. N'ecrit rien, n'envoie rien.
//
// USAGE
//   node scripts/observer-test-canal-email.js [--depuis 2026-09-17T11:00:00]
//     sans --depuis : les 2 dernieres heures
//
// ⚠ CE SCRIPT A DEJA MENTI, ET C'EST LA PIRE FAUTE POUR UN OBSERVATEUR.
// Premiere version, trois faux verts d'un coup (constats de review) :
//   - sans `--depuis`, `indexOf(...) + 1` valait `argv[0]`, donc le chemin du
//     binaire node : la requete partait avec une date invalide ;
//   - un `return dire('ROUGE', …)` sortait AVANT le calcul du verdict, donc
//     code de sortie 0 sur un point rouge ;
//   - le temoin OTA bouclait sur une liste vide et rendait VERT sans avoir rien
//     verifie.
// Un observateur qui ne peut pas echouer ne prouve rien. Les regles qui suivent
// existent pour ca : aucun retour anticipe, tout echec de LECTURE est un point
// rouge, et un controle sans matiere se declare SANS OBJET — jamais vert.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { canalPour, CANAL } = require('../lib/canal-voyageur')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ `indexOf` rend -1 quand le drapeau est absent, et `argv[-1 + 1]` est le
// chemin de node. On exige donc la forme `--depuis <valeur>` ET on verifie que
// la valeur est une date.
function lireDepuis () {
  const i = process.argv.indexOf('--depuis')
  const brut = i >= 0 ? process.argv[i + 1] : null
  if (!brut || brut.startsWith('--')) {
    return new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  }
  const d = new Date(brut)
  if (isNaN(d.getTime())) {
    console.error(`--depuis « ${brut} » n'est pas une date lisible.`)
    process.exit(1)
  }
  return d.toISOString()
}
const DEPUIS = lireDepuis()

// ⚠ BORNE AU COMPTE. Avec la service key, une lecture non bornee rapporte le
// trafic de TOUS les comptes : un doublon sans rapport avec le test rendrait la
// section 4 rouge, et un e-mail d'un autre hote ferait crier au detournement.
const COMPTE = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'

const masque = e => { const s = String(e || ''); const i = s.indexOf('@')
  return i < 1 ? '(aucune)' : s.slice(0, 2) + '***@' + s.slice(i + 1) }
const court = v => String(v == null ? '(sans id)' : v).slice(0, 8)

const resultats = []
// ⚠ « AUCUN INCIDENT » N'EST PAS UNE PREUVE QUE LE TEST A EU LIEU.
// Premiere correction insuffisante : le verdict comptait les verts, et deux
// controles d'ABSENCE (« aucun incident », une tache sans rapport) suffisaient a
// rendre « aucun point rouge » sur une fenetre ou rien du test ne s'etait passe.
// On distingue donc les controles qui constatent un FAIT DU TEST — une
// reservation Offline apparue, un e-mail parti — de ceux qui constatent qu'il ne
// s'est rien passe de mal.
let faitsDuTest = 0
const dire = (verdict, titre, detail, estUnFaitDuTest) => {
  resultats.push({ verdict, titre })
  if (estUnFaitDuTest && verdict === 'VERT') faitsDuTest++
  const marque = verdict === 'VERT' ? '  ✓' : verdict === 'ROUGE' ? '  ✗' : '  ·'
  console.log(`${marque} ${titre}`)
  if (detail) for (const l of [].concat(detail).filter(Boolean)) console.log(`      ${l}`)
}

// ⚠ `canal` peut MANQUER : la migration 2026-09-17 se colle a la main, et
// `lib/record-message.js` prevoit un repli qui ecrit la ligne SANS la colonne.
// Sur une base ou elle n'est pas passee, un select qui la nomme fait tomber
// toute la section. On tente avec, on retombe sans, ET ON LE DIT — sans quoi on
// classerait un e-mail reel en « OTA » et le temoin serait vert a vide.
async function lireMessages () {
  const base = () => supabase.from('messages')
    .select('created_at, sender, kind, ota, booking_id, body, canal')
    .eq('user_id', COMPTE).eq('direction', 'outbound')
    .gte('created_at', DEPUIS).order('created_at')
  let { data, error } = await base()
  if (!error) return { data, avecCanal: true }
  const { data: d2, error: e2 } = await supabase.from('messages')
    .select('created_at, sender, kind, ota, booking_id, body')
    .eq('user_id', COMPTE).eq('direction', 'outbound')
    .gte('created_at', DEPUIS).order('created_at')
  return { data: d2, error: e2, avecCanal: false }
}

async function main () {
  console.log(`\nFenetre d'observation : depuis ${DEPUIS}`)
  console.log(`Compte : ${COMPTE.slice(0, 8)}\n`)

  // ─── 1. Les reservations Offline apparues ─────────────────────────────────
  console.log('1. RESERVATIONS OFFLINE APPARUES')
  // ⚠ BORNEE, ET C'EST LE TEST QUI ME L'A RAPPELE.
  // PostgREST plafonne un rendu a 1000 lignes SANS ERREUR. La fenetre
  // d'observation rend cette lecture courte en pratique — mais « en pratique »
  // n'est pas une borne, et `tests/bookings-snapshot-troncature.test.js` compte
  // les lectures non bornees pour cette raison exacte : le depot a deja paye une
  // rechute de cette forme, dans un script neuf, le 14 septembre.
  const PLAFOND = 500
  const { data: toutes, error: e1 } = await supabase
    .from('bookings_snapshot')
    .select('booking_id, property_id, snapshot, created_at')
    .eq('user_id', COMPTE).gte('created_at', DEPUIS)
    .order('created_at', { ascending: true })
    .limit(PLAFOND)
  if (e1) {
    dire('ROUGE', 'lecture des reservations impossible', e1.message)
  } else {
    // Une fenetre qui rend le plafond exact est une fenetre tronquee : on le dit
    // plutot que de conclure sur une liste amputee.
    if ((toutes || []).length >= PLAFOND) {
      dire('ROUGE', `lecture tronquee au plafond de ${PLAFOND} lignes`,
        'reduire la fenetre avec --depuis, le verdict porterait sur une liste amputee')
    }
    // Casse normalisee, comme `lib/canal-voyageur.js` : une derive de casse cote
    // provider ferait dire « aucune reservation » au lieu de rendre un verdict.
    const neuves = (toutes || []).filter(r =>
      String(r.snapshot?.source || '').trim().toLowerCase() === 'offline')
    if (!neuves.length) {
      dire('SANS OBJET', 'aucune reservation Offline sur la fenetre',
        `${(toutes || []).length} reservation(s) toutes sources — le test attend la sienne`)
    } else {
      for (const r of neuves) {
        const s = r.snapshot
        const d = canalPour({ id: r.booking_id, ...s })
        dire(d.canal === CANAL.EMAIL ? 'VERT' : 'ROUGE',
          `${court(r.booking_id)} ${s.arrival}->${s.departure} — canal ${d.canal} (${d.motif})`,
          [`adresse ${masque(s.guestEmail)}`, `bien ${court(r.property_id)}`], true)
      }
    }
  }

  // ─── 2. Ce qui est parti, et par ou ───────────────────────────────────────
  console.log('\n2. MESSAGES SORTANTS')
  const { data: msg, error: e2, avecCanal } = await lireMessages()
  let parEmail = []
  if (e2) {
    dire('ROUGE', 'lecture des messages impossible', e2.message)
  } else if (!avecCanal) {
    dire('ROUGE', 'la colonne `canal` est absente — migration 2026-09-17 non appliquee',
      'sans elle, un e-mail reel serait classe « OTA » et le temoin serait vert a vide')
  } else if (!msg.length) {
    dire('SANS OBJET', 'aucun message sortant sur la fenetre')
  } else {
    parEmail = msg.filter(m => m.canal === 'email')
    const sansCanal = msg.filter(m => m.canal == null)
    for (const m of msg) {
      dire('VERT', `${String(m.canal || '(nul)').padEnd(6)} ${String(m.created_at).slice(11, 16)} `
        + `${m.sender}/${m.kind} ota=${m.ota || '-'} ${court(m.booking_id)}`,
        m.canal === 'email' ? `« ${String(m.body).slice(0, 60).replace(/\n/g, ' ')} »` : null,
        m.canal === 'email')
    }
    if (sansCanal.length) {
      dire('ROUGE', `${sansCanal.length} message(s) sans canal — repli d'ecriture declenche`,
        'la migration est passee en lecture mais pas au moment de l\'ecriture ?')
    }
  }

  // ─── 3. LE TEMOIN OTA ─────────────────────────────────────────────────────
  console.log('\n3. TEMOIN OTA — aucune reservation OTA detournee vers l\'e-mail')
  if (e2 || !avecCanal) {
    dire('ROUGE', 'controle impossible : les messages n\'ont pas pu etre lus avec leur canal')
  } else if (!parEmail.length) {
    dire('SANS OBJET', 'aucun envoi e-mail sur la fenetre — rien a confronter')
  } else {
    const detournes = []
    let lectureOk = true
    for (const m of parEmail) {
      if (!m.booking_id) { detournes.push('un e-mail sans booking_id — origine invérifiable'); continue }
      const { data: b, error: eb } = await supabase.from('bookings_snapshot')
        .select('snapshot').eq('user_id', COMPTE).eq('booking_id', m.booking_id).maybeSingle()
      if (eb) { lectureOk = false; detournes.push(`${court(m.booking_id)} : ${eb.message}`); continue }
      const src = String(b?.snapshot?.source || '').trim().toLowerCase()
      if (src && src !== 'offline') detournes.push(`${court(m.booking_id)} source=${b.snapshot.source}`)
    }
    dire(detournes.length || !lectureOk ? 'ROUGE' : 'VERT',
      detournes.length ? `${detournes.length} anomalie(s)` : `${parEmail.length} e-mail(s), tous sur des Offline`,
      detournes)
  }

  // ─── 4. DEDUP ─────────────────────────────────────────────────────────────
  console.log('\n4. DEDUP — aucun message envoye deux fois')
  if (e2) {
    dire('ROUGE', 'controle impossible : messages illisibles')
  } else if (!msg || msg.length < 2) {
    dire('SANS OBJET', 'moins de deux messages : rien a confronter')
  } else {
    const vus = new Map(); const doubles = []
    for (const m of msg) {
      const cle = `${m.booking_id || '-'}|${m.kind}|${String(m.body).slice(0, 80)}`
      if (vus.has(cle)) doubles.push(`${court(m.booking_id)} ${m.kind} — ${String(m.created_at).slice(11, 16)} et ${vus.get(cle)}`)
      else vus.set(cle, String(m.created_at).slice(11, 16))
    }
    dire(doubles.length ? 'ROUGE' : 'VERT',
      doubles.length ? `${doubles.length} doublon(s)` : `${msg.length} message(s), aucun doublon`, doubles)
  }

  // ─── 5. Le journal anti-doublon ───────────────────────────────────────────
  console.log('\n5. JOURNAL message_sent_log')
  const { data: log, error: e5 } = await supabase.from('message_sent_log')
    .select('booking_id, template_id, sent_at').eq('user_id', COMPTE)
    .gte('sent_at', DEPUIS).order('sent_at')
  if (e5) dire('ROUGE', 'lecture du journal impossible', e5.message)
  else if (!log.length) dire('SANS OBJET', 'aucune ligne posee sur la fenetre')
  else for (const l of log) dire('VERT', `${String(l.sent_at).slice(11, 16)} ${court(l.booking_id)} tpl=${court(l.template_id)}`)

  // ─── 6. Mode test : les taches a valider ──────────────────────────────────
  console.log('\n6. MODE TEST — taches a valider')
  const { data: taches, error: e6 } = await supabase.from('agent_tasks')
    .select('book_id, task_type, status, summary, created_at')
    .eq('user_id', COMPTE).eq('task_type', 'auto_message')
    .gte('created_at', DEPUIS).order('created_at')
  if (e6) dire('ROUGE', 'lecture des taches impossible', e6.message)
  else if (!taches.length) dire('SANS OBJET', 'aucune tache de message creee')
  else for (const t of taches) {
    dire('VERT', `${String(t.created_at).slice(11, 16)} ${t.status} ${court(t.book_id)}`,
      String(t.summary || '').slice(0, 80))
  }

  // ─── 7. Ce qui a mal tourne ───────────────────────────────────────────────
  console.log('\n7. INCIDENTS')
  const { data: inc, error: e7 } = await supabase.from('automation_incidents')
    .select('type, detail, property_id, created_at')
    .eq('user_id', COMPTE).gte('created_at', DEPUIS).order('created_at')
  if (e7) {
    dire('ROUGE', 'lecture des incidents impossible', e7.message)
  } else {
    const pertinents = (inc || []).filter(i => /email|send_failure|message_non_envoye/.test(i.type))
    const autres = (inc || []).length - pertinents.length
    if (!pertinents.length) {
      dire('VERT', `aucun incident lie a l'e-mail${autres ? ` (${autres} autre(s), hors chantier)` : ''}`)
    }
    for (const i of pertinents) {
      dire('ROUGE', `${String(i.created_at).slice(11, 16)} ${i.type}`,
        String(i.detail?.message || JSON.stringify(i.detail)).slice(0, 140))
    }
  }

  // ─── Verdict ──────────────────────────────────────────────────────────────
  const rouges = resultats.filter(r => r.verdict === 'ROUGE')
  const verts = resultats.filter(r => r.verdict === 'VERT').length
  const sansObjet = resultats.filter(r => r.verdict === 'SANS OBJET').length
  console.log('\n' + '─'.repeat(62))
  if (rouges.length) {
    console.log(`VERDICT : ${rouges.length} POINT(S) ROUGE(S)`)
    for (const r of rouges) console.log(`  ✗ ${r.titre}`)
    process.exitCode = 1
  } else if (!faitsDuTest) {
    // Ni reservation Offline apparue, ni e-mail parti : quoi qu'affichent les
    // autres lignes, il n'y a rien a conclure.
    console.log('VERDICT : LE TEST N\'A PAS EU LIEU.')
    console.log('  Aucune reservation Offline apparue, aucun e-mail parti sur la fenetre.')
    console.log(`  (${verts} controle(s) d'absence verts, ${sansObjet} sans matiere — ce n'est pas un succes.)`)
    process.exitCode = 2
  } else {
    console.log(`VERDICT : aucun point rouge — ${faitsDuTest} fait(s) du test observe(s), `
      + `${verts} controle(s) verts, ${sansObjet} sans objet`)
  }
}

main().catch(e => { console.error('ERREUR', e.message); process.exit(1) })
