// scripts/reconcilier-menages-orphelins.js
// Pose le `cancelled` manquant dans `menage_events` pour les reservations dont le
// snapshot est `cancelled` mais dont le journal de notifications s'arrete a `new`.
//
// POURQUOI CE SCRIPT EXISTE
// Le backfill historique (scripts/backfill-historique.js) reconcilie le statut des
// reservations annulees restees `confirmed` dans le coeur. Mais la garde
// d'anciennete de lib/booking-changes.js bloque tout evenement sur un sejour
// termine depuis plus de 7 jours : le snapshot bascule en `cancelled`, et AUCUN
// evenement `cancelled` n'est produit. Le journal `menage_events` garde alors un
// `new` que rien ne vient fermer — le planning et les statistiques comptent un
// menage qui n'a jamais eu lieu.
//
// Constate sur les 11 annulations passees des deux biens Beds24 (avril-aout 2026),
// toutes notifiees a la meme prestataire, toutes NON LUES.
//
// ⚠ `menage_events` et `menages` sont DEUX TABLES DISTINCTES. Annuler l'entite
// `menages` (ce que fait lib/cleaning/sync-menages-entite.js pour les departs de
// sa fenetre -30/+180 j) n'ecrit AUCUN `menage_event`. Une reservation peut donc
// avoir son entite annulee et son journal encore ouvert : c'est le cas des deux
// departs d'aout. Ce script ne traite QUE le journal.
//
// SILENCIEUX PAR CONSTRUCTION : l'ecriture passe par syncMenageEvent, qui
// n'importe que supabase et n'a aucun chemin de notification. Le SMS ne part que
// par notifierProposition (propositions d'assignation), jamais d'ici. Verifie par
// les faits : sms_logs est reste vide pendant toute l'operation.
//
// Le type `note` (note manuelle de l'hote) n'est JAMAIS touche : syncMenageEvent
// ne produit que new | modified | cancelled.
//
// USAGE
//   node scripts/reconcilier-menages-orphelins.js            (dry run)
//   node scripts/reconcilier-menages-orphelins.js --execute

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')
const { syncMenageEvent, loadContext, cle } = require('../lib/cleaning/sync-menages')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const EXECUTE = process.argv.includes('--execute')

// Ne remonte que les sejours DEJA TERMINES : le present et le futur sont l'affaire
// du cron, qui les traite par le chemin normal.
const JOURS_MIN_PASSE = 7

async function main () {
  const aujourdhui = new Date().toISOString().slice(0, 10)
  const limite = new Date(); limite.setDate(limite.getDate() - JOURS_MIN_PASSE)
  const limiteStr = limite.toISOString().slice(0, 10)

  console.log(`\n${'═'.repeat(72)}`)
  console.log(`RECONCILIATION DES MENAGE_EVENTS ORPHELINS — ${EXECUTE ? 'EXECUTION' : 'DRY RUN'}`)
  console.log(`${'═'.repeat(72)}`)

  // 1. Les snapshots annules, sejour termine.
  let snaps = []
  let de = 0
  for (;;) {
    const { data, error } = await supabase
      .from('bookings_snapshot')
      .select('user_id, booking_id, property_id, snapshot')
      .eq('snapshot->>status', 'cancelled')
      .lt('snapshot->>departure', limiteStr)
      .order('booking_id')          // sans ORDER BY, LIMIT/OFFSET ne garantit rien
      .range(de, de + 999)
    if (error) throw new Error(`lecture snapshots : ${error.message}`)
    snaps = snaps.concat(data || [])
    if (!data || data.length < 1000) break
    de += 1000
  }
  console.log(`\n  annulations au sejour termine : ${snaps.length}`)

  // 2. Celles dont le journal s'arrete a `new` / `modified`.
  const ids = snaps.map(s => String(s.booking_id))
  const orphelins = []
  const PAS = 200
  for (let i = 0; i < ids.length; i += PAS) {
    const lot = ids.slice(i, i + PAS)
    // ⚠ `user_id` EST LU ET COMPARE. `booking_id` n'a aucune unicite globale : deux
    // hotes peuvent porter le meme identifiant provider (c'est la raison d'etre du
    // filtre user_id dans tokensPourBien, et des tests « FUITE » du repo). Sans lui,
    // le `cancelled` de l'hote B ferait disparaitre l'orphelin reel de l'hote A —
    // jamais reconcilie — ou son `new` ferait passer pour notifiee une reservation
    // de A qui ne l'a jamais ete, et un `cancelled` parasite partirait dans le
    // journal des prestataires de A.
    const { data: evs, error } = await supabase
      .from('menage_events')
      .select('user_id, booking_id, event_type, created_at')
      .in('booking_id', lot)
      // PostgREST plafonne a 1 000 lignes par defaut : avec 200 booking_id par lot
      // et un evenement par prestataire notifiee, le plafond est atteignable. Un
      // `cancelled` deja present passerait alors inapercu et on ecrirait un doublon.
      .order('created_at')
      .limit(5000)
    if (error) throw new Error(`lecture menage_events : ${error.message}`)
    // ⚠ ON PARCOURT LA TRANCHE COURANTE, pas `snaps` refiltre : deux comptes
    // portant le meme booking_id provider feraient matcher les deux lignes dans
    // CHAQUE lot contenant cet id, et `orphelins` recevrait le meme couple
    // plusieurs fois. syncMenageEvent fait un insert sec, sans dedoublonnage :
    // la prestataire recevrait deux `cancelled` pour la meme reservation.
    for (const s of snaps.slice(i, i + PAS)) {
      const miens = (evs || []).filter(e =>
        String(e.booking_id) === String(s.booking_id) && e.user_id === s.user_id)
      // Un `note` seul ne compte pas : ce n'est pas une notification de menage.
      const diffuses = miens.filter(e => e.event_type !== 'note')
      if (!diffuses.length) continue                              // jamais notifie : rien a fermer
      if (diffuses.some(e => e.event_type === 'cancelled')) continue  // deja ferme
      orphelins.push({ ...s, evenements: miens.map(e => e.event_type) })
    }
  }

  console.log(`  dont ORPHELINS (un new jamais ferme) : ${orphelins.length}\n`)
  if (!orphelins.length) { console.log('  rien a faire.'); return }

  orphelins.forEach(o => console.log(
    `    ${String(o.booking_id).padEnd(10)} bien ${String(o.property_id).padEnd(8)} ` +
    `${o.snapshot.arrival} -> ${o.snapshot.departure}  [${o.evenements.join(', ')}]`))

  if (!EXECUTE) {
    console.log('\n  DRY RUN — aucune ecriture. Relancer avec --execute.')
    return
  }

  // 3. Contexte partage (tokens, biens) : meme chargement que le dispatcher, donc
  //    meme isolation multi-comptes (le filtre user_id est dans tokensPourBien).
  const userIds = [...new Set(orphelins.map(o => o.user_id))]
  const propIds = [...new Set(orphelins.map(o => String(o.property_id)))]
  const ctx = await loadContext(userIds, propIds)

  let ecrits = 0, sansPrestataire = 0, echecs = 0
  for (const o of orphelins) {
    const bien = ctx.propsByKey[cle(o.user_id, o.property_id)]
    try {
      const r = await syncMenageEvent(
        { type: 'cancelled', user_id: o.user_id, booking_id: o.booking_id, property_id: o.property_id, changes: null },
        { snapshot: o.snapshot, propertyName: bien?.name || null, tokens: ctx.tokens }
      )
      if (r.written) { ecrits += r.written; console.log(`    ✓ ${o.booking_id} : ${r.written} notification(s) fermee(s)`) }
      else { sansPrestataire++; console.log(`    · ${o.booking_id} : aucun prestataire concerne`) }
    } catch (e) {
      echecs++
      console.error(`    ✗ ${o.booking_id} : ${e.message}`)
    }
  }

  console.log(`\n  BILAN : ${ecrits} evenements ecrits, ${sansPrestataire} sans prestataire, ${echecs} echecs`)
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exit(1) })
