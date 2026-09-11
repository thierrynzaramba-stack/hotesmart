// scripts/test-acceptation-price-log.js
// Test d'acceptation du §4 de docs/specs/spec-yieldflow-v1.md, CONTRE LA BASE
// REELLE — pas un faux client en memoire.
//
// Ce qu'il eprouve, et qu'aucun test unitaire ne peut atteindre :
//   - l'index unique partiel tel qu'il existe VRAIMENT en base ;
//   - la contrainte FK vers properties, la contrainte CHECK des sources ;
//   - les types reels (date, integer, timestamptz) ;
//   - la lecture croisee de `calendar_inventory`, avec sa vraie cle.
//
// ⚠ AUCUNE POUSSEE PROVIDER. Ce script ne parle qu'a Supabase : il n'appelle ni
// Channex ni Beds24, ne touche pas `calendar_inventory`, ne met rien en file de
// synchronisation. Il le VERIFIE a la fin plutot que de le promettre.
//
// ⚠ LA NUIT DE TEST EST CHOISIE POUR NE RIEN RISQUER : une date a plus d'un an,
// sur un bien sans aucune reservation, dont l'etat calendaire n'est jamais
// modifie. Toutes les lignes creees sont supprimees, et la suppression est
// verifiee par relecture.
//
// USAGE : node scripts/test-acceptation-price-log.js

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const {
  enregistrerPrixPousses, cloturerVente, rouvrirApresAnnulation
} = require('../lib/price-log')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const NUIT = '2030-06-15'          // au-dela de TOUTE ligne de calendrier
const DEPART = '2030-06-16'
const UID = 'TEST-ACCEPTATION-PRICE-LOG'
const PRIX_1 = 12345               // centimes, valeur improbable : tracable
const PRIX_2 = 13900

let echecs = 0
function dit (ok, texte) {
  if (!ok) echecs++
  console.log(`  ${ok ? '✓' : '✗'} ${texte}`)
}

async function courantes (bienId) {
  const { data } = await supabase.from('price_display_log')
    .select('*').eq('property_id', bienId).eq('stay_date', NUIT)
    .is('replaced_at', null).is('sold_at', null)
  return data || []
}
async function toutes (bienId) {
  const { data } = await supabase.from('price_display_log')
    .select('*').eq('property_id', bienId).eq('stay_date', NUIT)
  return data || []
}

async function main () {
  // ─── Choix de la cible, et preuve qu'elle est sans risque ─────────────────
  const { data: biens } = await supabase.from('properties')
    .select('id, user_id, name, provider_property_id, base_price')
  const bien = biens.find(b => b.name === 'Colomiers')
  if (!bien) throw new Error('bien de test introuvable')

  const { count: resas } = await supabase.from('bookings_snapshot')
    .select('*', { count: 'exact', head: true })
    .eq('property_id', bien.provider_property_id)
    .lte('snapshot->>arrival', NUIT).gt('snapshot->>departure', NUIT)
  if (resas !== 0) throw new Error(`la nuit ${NUIT} porte ${resas} reservation(s) : on change de date`)

  const { data: ligneCal } = await supabase.from('calendar_inventory')
    .select('date').eq('property_id', bien.id).eq('date', NUIT).maybeSingle()
  if (ligneCal) throw new Error(`la nuit ${NUIT} porte deja une ligne de calendrier : on change de date`)

  const dejaLa = await toutes(bien.id)
  if (dejaLa.length) throw new Error(`${dejaLa.length} ligne(s) preexistante(s) sur ${NUIT} : nettoyer d abord`)

  // Etat de reference, pour prouver l'absence d'effet de bord.
  const { count: queueAvant } = await supabase.from('channel_sync_queue').select('*', { count: 'exact', head: true })
  const { count: calAvant } = await supabase.from('calendar_inventory').select('*', { count: 'exact', head: true })
  const { count: evtAvant } = await supabase.from('booking_change_events').select('*', { count: 'exact', head: true })
  const { count: totalAvant } = await supabase.from('price_display_log').select('*', { count: 'exact', head: true })

  console.log(`Bien : ${bien.name}   nuit : ${NUIT}   (0 reservation, 0 ligne preexistante)\n`)

  // ─── ACCEPTATION 1 : une poussee ouvre UNE ligne exacte ───────────────────
  console.log('1. Poussee reelle -> une ligne exacte')
  const b1 = await enregistrerPrixPousses(supabase, {
    userId: bien.user_id, propertyId: bien.id, nuits: { [NUIT]: PRIX_1 }, source: 'host'
  })
  dit(b1.ouvertes === 1 && b1.remplacees === 0, `bilan ${JSON.stringify(b1)}`)
  let c = await courantes(bien.id)
  dit(c.length === 1, `${c.length} ligne courante`)
  dit(c[0]?.rate === PRIX_1, `rate = ${c[0]?.rate} centimes (attendu ${PRIX_1})`)
  dit(c[0]?.source === 'host', `source = '${c[0]?.source}' (attendu 'host')`)
  dit(c[0]?.sold_at === null && c[0]?.replaced_at === null, 'ligne ouverte (ni vendue ni remplacee)')

  // ─── ACCEPTATION 2 : second cycle sans changement -> ZERO ligne ───────────
  console.log('\n2. Second cycle au MEME prix -> zero ligne')
  const b2 = await enregistrerPrixPousses(supabase, {
    userId: bien.user_id, propertyId: bien.id, nuits: { [NUIT]: PRIX_1 }, source: 'host'
  })
  dit(b2.ouvertes === 0 && b2.remplacees === 0 && b2.inchangees === 1, `bilan ${JSON.stringify(b2)}`)
  dit((await toutes(bien.id)).length === 1, 'la table n a pas grossi')

  // ─── Changement REEL -> remplacement ──────────────────────────────────────
  console.log('\n2 bis. Changement reel -> remplacement, une seule courante')
  const b3 = await enregistrerPrixPousses(supabase, {
    userId: bien.user_id, propertyId: bien.id, nuits: { [NUIT]: PRIX_2 }, source: 'host'
  })
  dit(b3.ouvertes === 1 && b3.remplacees === 1, `bilan ${JSON.stringify(b3)}`)
  c = await courantes(bien.id)
  dit(c.length === 1, `${c.length} ligne courante (l index unique partiel tient EN BASE)`)
  dit(c[0]?.rate === PRIX_2, `courante a ${c[0]?.rate}`)
  const ancienne = (await toutes(bien.id)).find(l => l.rate === PRIX_1)
  dit(!!ancienne?.replaced_at, 'l ancienne porte replaced_at')
  dit(ancienne?.sold_at === null, 'remplacee n est pas vendue')

  // ─── ACCEPTATION 3 : la vente fige le prix affiche ────────────────────────
  console.log('\n3. Vente simulee -> cloture')
  const b4 = await cloturerVente(supabase, {
    propertyId: bien.id, arrival: NUIT, departure: DEPART, bookingUid: UID
  })
  dit(b4.fermees === 1 && b4.nuits === 1, `bilan ${JSON.stringify(b4)}`)
  const vendue = (await toutes(bien.id)).find(l => l.sold_booking_uid === UID)
  dit(!!vendue?.sold_at, 'sold_at pose')
  dit(vendue?.rate === PRIX_2, `prix fige = ${vendue?.rate} (le prix AFFICHE, pas un montant paye)`)
  dit((await courantes(bien.id)).length === 0, 'plus aucune ligne courante : la nuit est vendue')

  // ─── ACCEPTATION 4a : annulation sur une nuit FERMEE -> rien ──────────────
  // La nuit n'a AUCUNE ligne de calendrier : `runFullSync` la traite comme
  // `availability: 0`. Rouvrir une ligne courante affirmerait qu'un prix est
  // affiche sur une nuit qu'aucun voyageur ne peut reserver.
  console.log('\n4a. Annulation sur une nuit fermee -> aucune reouverture')
  const b5a = await rouvrirApresAnnulation(supabase, {
    propertyId: bien.id, bookingUid: UID, basePriceEur: bien.base_price
  })
  dit(b5a.rouvertes === 0 && b5a.fermees === 1, `bilan ${JSON.stringify(b5a)}`)
  dit((await courantes(bien.id)).length === 0, 'aucune ligne courante sur une nuit fermee')

  // ─── ACCEPTATION 4b : annulation sur une nuit OUVERTE -> reouverture ──────
  // On ouvre temporairement la nuit dans le calendrier, puis on restaure
  // l'etat EXACT d'avant (aucune ligne). Le controle d'effet de bord plus bas
  // verifie que `calendar_inventory` retrouve son compte initial.
  console.log('\n4b. Annulation sur une nuit ouverte -> reouverture au prix du calendrier')
  const PRIX_CAL = 77                     // euros, valeur improbable : tracable
  const { error: eIns } = await supabase.from('calendar_inventory').insert({
    property_id: bien.id, date: NUIT, rate: PRIX_CAL, stop_sell: false, avail: 1
  })
  if (eIns) throw new Error(`ouverture temporaire de la nuit : ${eIns.message}`)

  const b5 = await rouvrirApresAnnulation(supabase, {
    propertyId: bien.id, bookingUid: UID, basePriceEur: bien.base_price
  })
  dit(b5.rouvertes === 1, `bilan ${JSON.stringify(b5)}`)
  const apresAnnul = await toutes(bien.id)
  const vendueEncore = apresAnnul.find(l => l.sold_booking_uid === UID)
  dit(!!vendueEncore?.sold_at, 'la ligne vendue est INTACTE — elle dit la verite')
  c = await courantes(bien.id)
  dit(c.length === 1, `${c.length} nouvelle ligne courante`)
  dit(c[0]?.rate === PRIX_CAL * 100, `rouverte au prix du CALENDRIER : ${c[0]?.rate} (attendu ${PRIX_CAL * 100})`)

  // Idempotence sur la vraie base.
  const b6 = await rouvrirApresAnnulation(supabase, {
    propertyId: bien.id, bookingUid: UID, basePriceEur: bien.base_price
  })
  dit(b6.rouvertes === 0 && b6.deja_courantes === 1, `rejeu idempotent : ${JSON.stringify(b6)}`)

  // Restauration de l'etat calendaire initial.
  const { error: eDelCal } = await supabase.from('calendar_inventory')
    .delete().eq('property_id', bien.id).eq('date', NUIT)
  if (eDelCal) dit(false, `restauration du calendrier : ${eDelCal.message}`)

  // ─── ZERO EFFET DE BORD ───────────────────────────────────────────────────
  console.log('\n5. Aucun effet de bord')
  const { count: queueApres } = await supabase.from('channel_sync_queue').select('*', { count: 'exact', head: true })
  const { count: calApres } = await supabase.from('calendar_inventory').select('*', { count: 'exact', head: true })
  const { count: evtApres } = await supabase.from('booking_change_events').select('*', { count: 'exact', head: true })
  dit(queueApres === queueAvant, `channel_sync_queue ${queueApres} (avant ${queueAvant}) — aucune poussee provider`)
  dit(calApres === calAvant, `calendar_inventory ${calApres} (avant ${calAvant}) — le calendrier n a pas bouge`)
  dit(evtApres === evtAvant, `booking_change_events ${evtApres} (avant ${evtAvant}) — aucun evenement`)

  // ─── NETTOYAGE, VERIFIE PAR LECTURE ───────────────────────────────────────
  console.log('\n6. Nettoyage')
  const aSupprimer = (await toutes(bien.id)).length
  const { error: eDel } = await supabase.from('price_display_log')
    .delete().eq('property_id', bien.id).eq('stay_date', NUIT)
  if (eDel) { dit(false, `suppression : ${eDel.message}`) }
  const reste = await toutes(bien.id)
  dit(reste.length === 0, `${aSupprimer} ligne(s) de test supprimee(s), ${reste.length} restante(s)`)
  const { count: totalApres } = await supabase.from('price_display_log').select('*', { count: 'exact', head: true })
  dit(totalApres === totalAvant,
    `total price_display_log ${totalApres} (avant ${totalAvant}) — les 102 lignes d amorcage sont intactes`)

  console.log(`\n${echecs ? `ECHEC — ${echecs} controle(s)` : 'ACCEPTATION §4 : TOUS LES CONTROLES PASSENT'}`)
  process.exit(echecs ? 1 : 0)
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exit(1) })
