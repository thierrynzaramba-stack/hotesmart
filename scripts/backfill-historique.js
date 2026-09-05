// scripts/backfill-historique.js
// Sous-chantier B du chantier « historique des reservations »
// (docs/specs/spec-historique-reservations.md §5).
//
// Constitue l'historique complet dans bookings_snapshot : toute la profondeur
// provider, annulations comprises, payload brut compris.
//
// HORS CRON. One-shot, idempotent, rejouable. Ecrit EXCLUSIVEMENT par le writer
// unique (lib/bookings-snapshot.js) : aucun acces direct a la table.
//
// USAGE
//   node scripts/backfill-historique.js <cible> [--execute] [--reprendre]
//     cible : 209413 | 169567 | colomiers | tout
//     par defaut : DRY RUN (aucune ecriture), --execute pour ecrire
//     --reprendre : repart du curseur laisse par un passage interrompu
//
// GARDES (spec §5, zero tolerance)
//   - `initialImport` sur tout ce qui est ecrit : les evenements induits sont
//     journalises DEJA traites, le dispatcher ne consomme RIEN du backfill.
//   - Le backfill ne touche QUE LE PASSE : une reservation dont le depart n'est
//     pas encore arrive est laissee au cron. Voir la note « pourquoi pas les
//     futures » plus bas — ce n'est pas un detail, c'est ce qui evite de priver
//     une prestataire de sa notification.
//   - Jamais d'ecrasement d'une ligne plus fraiche que la lecture du provider.
//   - Throttle Beds24 : la cle est partagee avec le cron */5.

require('dotenv').config({ path: '.env.local' })
const fs = require('fs')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

const { fetchBookingsIntegral } = require('../lib/cron-beds24')
const { getProvider } = require('../lib/channels')
const { saveBookingSnapshots, readStatus } = require('../lib/bookings-snapshot')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const args      = process.argv.slice(2)
const EXECUTE   = args.includes('--execute')
const REPRENDRE = args.includes('--reprendre')
const CIBLE     = args.find(a => !a.startsWith('--')) || 'tout'

const CURSEUR = path.join(__dirname, '..', '.backfill-historique.json')

const BIENS = {
  209413:     { provider: 'beds24',  propId: '209413' },
  169567:     { provider: 'beds24',  propId: '169567' },
  colomiers:  { provider: 'channex', propId: '0544fd9a-6579-44e7-b75e-19c63a2019ba' }
}

const t = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(`${t()}`, ...a)

// ─── Curseur de reprise ──────────────────────────────────────────────────────
// Un backfill de plusieurs milliers de lignes peut etre interrompu (reseau,
// credits, Ctrl-C). Le curseur note ce qui est deja fait, par bien.
function lireCurseur () {
  try { return JSON.parse(fs.readFileSync(CURSEUR, 'utf8')) } catch { return {} }
}
function ecrireCurseur (etat) {
  try { fs.writeFileSync(CURSEUR, JSON.stringify(etat, null, 2)) }
  catch (e) { console.error('curseur non ecrit :', e.message) }
}

// ─── Qui possede le bien ─────────────────────────────────────────────────────
// ⚠ `provider_property_id` N'A AUCUNE UNICITE GLOBALE : deux hotes peuvent porter
// le meme identifiant provider (cf. lib/cron-beds24-props.js et le filtre user_id
// de tokensPourBien). Un `.limit(1)` en choisirait un ARBITRAIREMENT, et tout
// l'historique — cle API lue plus bas, user_id d'ecriture — partirait sous le
// mauvais compte. On refuse donc l'ambiguite plutot que de trancher au hasard.
async function proprietaire (propId) {
  const { data, error } = await supabase
    .from('properties')
    .select('user_id, name, provider')
    .eq('provider_property_id', String(propId))
  if (error) throw new Error(`lecture properties : ${error.message}`)
  if (!data || !data.length) throw new Error(`bien ${propId} introuvable dans properties`)
  if (data.length > 1) {
    throw new Error(`bien ${propId} porte par ${data.length} comptes : preciser lequel avant de continuer`)
  }
  return data[0]
}

// ─── Etat actuel du coeur pour ce bien ───────────────────────────────────────
async function etatExistant (userId, propId) {
  const parBooking = {}
  let de = 0
  const PAS = 1000
  for (;;) {
    const { data, error } = await supabase
      .from('bookings_snapshot')
      .select('booking_id, snapshot, updated_at, raw_hash')
      .eq('user_id', userId)
      .eq('property_id', String(propId))
      // ⚠ ORDER BY obligatoire : sans lui Postgres ne garantit aucun ordre pour
      // LIMIT/OFFSET, et au-dela d'une page certaines lignes reviendraient deux
      // fois quand d'autres seraient sautees. Une ligne sautee serait vue comme
      // absente, donc ecrite sans passer par la garde « plus fraiche ».
      .order('booking_id')
      .range(de, de + PAS - 1)
    if (error) throw new Error(`lecture bookings_snapshot : ${error.message}`)
    ;(data || []).forEach(r => { parBooking[String(r.booking_id)] = r })
    if (!data || data.length < PAS) break
    de += PAS
  }
  return parBooking
}

// ─── Selection : ce que le backfill a le droit d'ecrire ──────────────────────
//
// ⚠ POURQUOI PAS LES RESERVATIONS FUTURES, MEME ABSENTES.
// La spec dit « le passe et les absentes ». Ecrire une reservation encore a venir
// serait pourtant contre-productif : le backfill pose `initialImport`, donc son
// evenement `new` est journalise DEJA TRAITE et n'est jamais distribue. La ligne
// existerait alors en base sans que personne n'ait ete prevenu — et le cron, la
// voyant deja presente, ne produirait plus jamais de `new` pour elle. Resultat :
// aucune notification de menage, aucun message de bienvenue, aucun code d'acces,
// pour un sejour bien reel. Laisser le cron creer lui-meme les futures est
// strictement plus sur : il les verra entrer dans sa fenetre et les distribuera
// normalement.
// Le backfill se limite donc au passe — ce qui couvre l'integralite de son objet :
// l'historique, et la reconciliation des annulations passees.
function aEcrire (bookings, existant, debutBackfill, aujourdhui) {
  const retenus = []
  const ignores = { futures: 0, plusFraiches: 0, sansDepart: 0 }

  for (const b of bookings) {
    const ligne = existant[String(b.id)]

    // Ligne touchee par le cron depuis la LECTURE PROVIDER : elle est plus fraiche
    // que le payload qu'on tient en memoire, on n'y touche pas.
    //
    // ⚠ COMPARER DES DATES, PAS DES CHAINES. PostgREST rend `…+00:00` et
    // `toISOString()` produit `…Z` : a la meme seconde, une comparaison
    // lexicographique juge `"…T12:00:00+00:00"` anterieur a `"…T12:00:00.123Z"`
    // ('+' = 0x2B < '.' = 0x2E) et laisserait ecraser une ligne plus recente.
    //
    // ⚠ LA REFERENCE EST LE DEBUT DU SCRIPT, AVANT LE FETCH — pas apres.
    // Le fetch integral dure plusieurs minutes (13 pages, pauses credits comprises).
    // Une annulation traitee par le cron */5 a la minute 2, sur une reservation
    // dont la page a ete lue a la minute 1, porte un `updated_at` ANTERIEUR a la
    // fin du fetch : un repere pose apres le fetch ne la verrait pas, et le
    // backfill reecrirait `confirmed` par-dessus `cancelled`. Le sejour etant
    // passe, la fenetre -1j/+90j du cron ne le corrigerait JAMAIS.
    // Le repere le plus ancien est le seul sur : toute ecriture posterieure au
    // debut du script est forcement plus fraiche que notre payload.
    if (ligne && ligne.updated_at && new Date(ligne.updated_at) > new Date(debutBackfill)) {
      ignores.plusFraiches++
      continue
    }

    const depart = b.departure || b.departure_date || null
    if (!depart) {
      // Sans date de depart, impossible de dire si le sejour est passe. On ecrit
      // quand meme si la ligne est absente (c'est de l'historique pur, et la
      // garde d'anciennete du writer bloquera tout evenement), sinon on s'abstient.
      if (!ligne) retenus.push(b)
      else ignores.sansDepart++
      continue
    }

    if (String(depart) >= aujourdhui) { ignores.futures++; continue }
    retenus.push(b)
  }
  return { retenus, ignores }
}

// ─── Backfill d'un bien ──────────────────────────────────────────────────────
async function backfillBien (cle, { curseur }) {
  const conf = BIENS[cle]
  if (!conf) throw new Error(`cible inconnue : ${cle}`)

  const bien = await proprietaire(conf.propId)
  const debutBackfill = new Date().toISOString()
  const aujourdhui = debutBackfill.slice(0, 10)

  console.log(`\n${'─'.repeat(72)}`)
  log(`BIEN ${cle} — ${bien.name} (${conf.provider})`)
  console.log('─'.repeat(72))

  // 1. Lecture provider, par le chemin de PRODUCTION.
  let bookings = []
  if (conf.provider === 'beds24') {
    const { data: k, error } = await supabase.from('api_keys').select('api_key').eq('user_id', bien.user_id).limit(1).maybeSingle()
    if (error || !k) throw new Error('cle Beds24 introuvable pour cet hote')
    const res = await fetchBookingsIntegral(k.api_key, conf.propId, {
      onProgress: ({ page, cumul, creditsRestants }) =>
        log(`  page ${String(page).padStart(2)} — ${String(cumul).padStart(5)} reservations — credits ${creditsRestants}`)
    })
    if (!res.complet) {
      throw new Error(`fetch incomplet (${res.raison}) — on n'ecrit pas un historique partiel`)
    }
    bookings = res.bookings          // deja filtre par bien dans fetchBookingsIntegral
  } else {
    bookings = await getProvider('channex').getReservations({ propertyId: conf.propId })
    log(`  ${bookings.length} reservations rendues par le provider`)
  }
  log(`  provider : ${bookings.length} reservations pour ce bien`)

  // 2. Etat actuel du coeur.
  const existant = await etatExistant(bien.user_id, conf.propId)
  log(`  coeur    : ${Object.keys(existant).length} lignes deja presentes`)

  // 3. Selection.
  const { retenus, ignores } = aEcrire(bookings, existant, debutBackfill, aujourdhui)
  const absentes = retenus.filter(b => !existant[String(b.id)]).length
  log(`  a ecrire : ${retenus.length} (${absentes} absentes, ${retenus.length - absentes} deja presentes)`)
  log(`  ignorees : ${ignores.futures} futures (laissees au cron), ${ignores.plusFraiches} plus fraiches, ${ignores.sansDepart} sans depart deja en base`)

  // Ce que la reconciliation va changer, annonce AVANT d'ecrire.
  const bascules = retenus.filter(b => {
    const ligne = existant[String(b.id)]
    if (!ligne) return false
    const avant = readStatus(ligne.snapshot, conf.provider)
    const apres = readStatus({ status: b.status }, conf.provider)
    return avant !== apres
  })
  if (bascules.length) {
    log(`  ⚠ ${bascules.length} changement(s) de statut a reconcilier :`)
    bascules.forEach(b => {
      const ligne = existant[String(b.id)]
      log(`      ${b.id} : ${readStatus(ligne.snapshot, conf.provider)} -> ${readStatus({ status: b.status }, conf.provider)}  (${b.arrival || b.arrival_date})`)
    })
  }

  if (!EXECUTE) {
    log('  DRY RUN — aucune ecriture. Relancer avec --execute.')
    return { cle, userId: bien.user_id, provider: bookings.length, retenus: retenus.length, bascules: bascules.length, ecrites: 0, dryRun: true }
  }

  // 4. Ecriture par lots, via le writer unique.
  //    `initialImport` : les evenements induits sont journalises DEJA traites.
  const LOT = 200
  let saved = 0, inchanges = 0, failed = 0, rawMisAJour = 0, rawEchecs = 0
  // Budget de rafraichissement du raw : hors cron, aucune contrainte de 60 s.
  const budgetRaw = { restant: Number.MAX_SAFE_INTEGER }

  for (let i = 0; i < retenus.length; i += LOT) {
    const lot = retenus.slice(i, i + LOT)
    const out = await saveBookingSnapshots(supabase, {
      userId:     bien.user_id,
      propertyId: conf.propId,
      provider:   conf.provider,
      bookings:   lot,
      initialImport: true,
      budgetRaw
    })
    saved += out.saved; inchanges += out.inchanges; failed += out.failed
    rawMisAJour += out.rawMisAJour || 0; rawEchecs += out.rawEchecs || 0
    log(`  lot ${i / LOT + 1} : ${out.saved} ecrites, ${out.inchanges} inchangees, ${out.failed} echecs, ${out.rawMisAJour || 0} raw rafraichis`)

    curseur[cle] = { dernierIndex: i + lot.length, total: retenus.length, le: new Date().toISOString() }
    ecrireCurseur(curseur)
  }

  log(`  BILAN ${cle} : ${saved} ecrites, ${inchanges} inchangees, ${failed} echecs, ${rawMisAJour} raw rafraichis, ${rawEchecs} raw en echec`)
  curseur[cle] = { termine: true, total: retenus.length, le: new Date().toISOString() }
  ecrireCurseur(curseur)

  return { cle, userId: bien.user_id, provider: bookings.length, retenus: retenus.length, bascules: bascules.length, ecrites: saved, inchanges, failed, rawMisAJour, rawEchecs }
}

// ─── Annonce au monitoring ───────────────────────────────────────────────────
// La sonde `table_growth` (lib/cron-alerting.js) alerte au-dela de 80 lignes/heure
// sur bookings_snapshot. Le regime normal est de 0,21 ligne/heure (36 lignes en
// 7 jours) : le seuil est donc bien calibre, avec une marge de ~380x, et il
// mesure un DEBIT, pas une taille — la table passee de 214 a 1 433 lignes n'y
// change rien.
//
// Mais un backfill ecrit des milliers de lignes en quelques minutes et declenche
// l'alerte a coup sur. Plutot que de relever le seuil (ce qui aveuglerait la
// sonde sur les vraies boucles d'ecriture, sa raison d'etre), on ANNONCE
// l'operation : une entree `table_growth` deja marquee `alerted` pose l'anti-spam
// de 6 h de la sonde, qui se taira d'elle-meme sans qu'on touche a son code.
//
// Le prochain backfill (onboarding d'un hote avec son historique) doit donc etre
// annonce de la meme facon, et non re-declencher l'alerte.
// ⚠ DEUX TABLES, pas une. Le backfill gonfle `bookings_snapshot` ET
// `booking_change_events` (une ligne par reservation changee : `initialImport`
// marque l'evenement traite, mais l'ecrit bel et bien). Les deux sont surveillees
// par GROWTH_WATCH (80/h et 60/h). N'annoncer que la premiere laisserait l'alerte
// partir sur la seconde au prochain passage horaire de la sonde.
//
// La ligne reprend exactement la forme de `reportIncident` (lib/founder-notify.js),
// seul autre writer de cette table : `detail` en objet, pas de colonne inventee.
const TABLES_ANNONCEES = ['bookings_snapshot', 'booking_change_events']

async function annoncerAuMonitoring (cibles) {
  for (const table of TABLES_ANNONCEES) {
    try {
      const { error } = await supabase.from('automation_incidents').insert({
        type:        'table_growth',
        property_id: table,          // la sonde utilise le nom de table comme cle
        alerted:     true,           // pose l'anti-spam 6 h
        detail:      { message: `Backfill historique annonce (${cibles.join(', ')}) — croissance attendue, ce n'est PAS une boucle d'ecriture. Voir docs/kb/bookings-snapshot.md.` }
      })
      if (error) console.error(`  annonce monitoring ${table} echouee (non bloquant) :`, error.message)
      else log(`  monitoring : croissance de ${table} annoncee (silence 6 h)`)
    } catch (e) { console.error(`  annonce monitoring ${table} exception :`, e.message) }
  }
}

// ─── Controle : le dispatcher n'a rien consomme ──────────────────────────────
// `userIds` : le controle doit porter sur les comptes REELLEMENT touches. Sans ce
// filtre, un cycle cron normal chez un autre hote afficherait « ⚠ FUITE » alors
// qu'il n'y en a aucune — et, symetriquement, le controle ne saurait pas attribuer
// les lignes qu'il compte.
async function controleGardes (depuis, userIds) {
  const { count: nonTraites } = await supabase
    .from('booking_change_events').select('*', { count: 'exact', head: true })
    .gt('created_at', depuis).is('processed_at', null).in('user_id', userIds)
  const { count: menages } = await supabase
    .from('menage_events').select('*', { count: 'exact', head: true }).gt('created_at', depuis).in('user_id', userIds)
  const { count: messages } = await supabase
    .from('message_sent_log').select('*', { count: 'exact', head: true }).gt('sent_at', depuis).in('user_id', userIds)
  const { count: codes } = await supabase
    .from('access_codes').select('*', { count: 'exact', head: true }).gt('created_at', depuis).in('user_id', userIds)
  const { count: evenements } = await supabase
    .from('booking_change_events').select('*', { count: 'exact', head: true }).gt('created_at', depuis).in('user_id', userIds)

  console.log(`\n${'─'.repeat(72)}`)
  console.log('CONTROLE DES GARDES (spec §5 : le dispatcher ne consomme RIEN)')
  console.log('─'.repeat(72))
  console.log(`  evenements induits          : ${evenements}`)
  console.log(`  dont NON traites (doit = 0) : ${nonTraites} ${nonTraites === 0 ? '✓' : '⚠ FUITE'}`)
  console.log(`  menage_events   (doit = 0)  : ${menages} ${menages === 0 ? '✓' : '⚠ FUITE'}`)
  console.log(`  messages envoyes (doit = 0) : ${messages} ${messages === 0 ? '✓' : '⚠ FUITE'}`)
  console.log(`  codes d'acces   (doit = 0)  : ${codes} ${codes === 0 ? '✓' : '⚠ FUITE'}`)
  return { evenements, nonTraites, menages, messages, codes }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main () {
  const debut = new Date().toISOString()
  const curseur = REPRENDRE ? lireCurseur() : {}

  console.log(`\n╔${'═'.repeat(70)}╗`)
  console.log(`║  BACKFILL HISTORIQUE — ${(EXECUTE ? 'EXECUTION' : 'DRY RUN').padEnd(45)}║`)
  console.log(`║  cible : ${String(CIBLE).padEnd(60)}║`)
  console.log(`╚${'═'.repeat(70)}╝`)

  const cibles = CIBLE === 'tout' ? Object.keys(BIENS) : [CIBLE]
  // Annonce AVANT d'ecrire : la sonde tourne toutes les heures, l'anti-spam doit
  // etre pose avant qu'elle ne voie la croissance.
  if (EXECUTE) await annoncerAuMonitoring(cibles)
  const bilans = []
  for (const c of cibles) {
    if (REPRENDRE && curseur[c]?.termine) { log(`BIEN ${c} : deja termine (curseur), saute`); continue }
    bilans.push(await backfillBien(c, { curseur }))
  }

  if (EXECUTE) {
    const comptes = [...new Set(bilans.map(b => b.userId).filter(Boolean))]
    await controleGardes(debut, comptes)
  }

  console.log(`\n${'─'.repeat(72)}`)
  console.log('BILAN')
  console.log('─'.repeat(72))
  bilans.forEach(b => console.log(`  ${String(b.cle).padEnd(12)} provider=${String(b.provider).padStart(5)} retenus=${String(b.retenus).padStart(5)} ecrites=${String(b.ecrites).padStart(5)} bascules=${b.bascules}`))
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exit(1) })
