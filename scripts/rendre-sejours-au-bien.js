// scripts/rendre-sejours-au-bien.js
// Ramene sur la fiche du COEUR des sejours restes accroches a une cle provider
// ABANDONNEE par une migration.
//
// ⚠ NE TOUCHE RIEN CHEZ LE PROVIDER. Ce script ne parle qu'a Supabase : il
// deplace la colonne `property_id` de `bookings_snapshot`, rien d'autre.
//
// POURQUOI CE CAS EXISTE — MESURE DU 14 SEPTEMBRE 2026.
// Le 23 est a cheval : son canal Airbnb est passe sur Channex le 10 septembre
// et Airbnb a re-livre ses reservations encore a venir, mais Booking.com ne
// re-livre JAMAIS les reservations anterieures au mapping. Ces sejours-la
// n'existent donc que sous l'ancienne cle Beds24 — invisibles de tous les
// lecteurs, qui filtrent sur `provider_property_id`.
//
// ⚠ CE QUE LE DEPLACEMENT DECLENCHE, ET QU'IL FAUT AVOIR VOULU :
//  - le writer des menages (lib/cleaning/sync-menages-entite.js) revoit le
//    sejour vivant et RESSUSCITE le menage annule, avec la garde du jour ;
//  - les modeles de messages du bien redeviennent eligibles pour ce sejour.
//    Si la reservation est inconnue du canal (cas Booking.com ci-dessus),
//    l'envoi ECHOUERA — incident `send_failure`, aucun impact voyageur.
//
// ⚠ AUCUN EVENEMENT DE CHANGEMENT N'EST ECRIT, ET C'EST VOULU. Un UPDATE direct
// ne passe pas par `saveBookingSnapshot`, donc `booking_change_events` reste
// intact : aucun message de bienvenue ne repart a un voyageur qui l'a deja recu.
//
// ⚠ A NE LANCER QU'APRES LA FERMETURE DE LA GARDE (lib/cles-migrees.js, repli
// FERME depuis le 14 septembre). Tant que la garde pouvait passer aveugle, le
// cycle suivant remettait les sejours sur l'ancienne cle.
//
// USAGE :
//   node scripts/rendre-sejours-au-bien.js --de=<cle_abandonnee> --vers=<provider_property_id> [--compte=<user_id>] [--booking=id,id] [--go]
//
// ⚠ UN SEJOUR DEJA PRESENT SOUS SON JUMEAU EST ECARTE. Quand l'OTA a re-livre
// le sejour au nouveau canal, il existe DEUX lignes pour le meme code OTA sous
// deux `booking_id` differents. Les reunir sur le meme bien produirait DEUX
// menages par depart — le piege deja note au KB. Le script les laisse ou ils sont.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { readStatus } = require('../lib/bookings-snapshot-status')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const arg = (n) => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || null
const DE = arg('de')
const VERS = arg('vers')
const BOOKINGS = (arg('booking') || '').split(',').map(s => s.trim()).filter(Boolean)
const COMPTE = arg('compte')
const GO = process.argv.includes('--go')

// ⚠ TOUTE LECTURE DE `bookings_snapshot` SE PAGINE, ET LA BORNE SE VOIT.
// PostgREST tronque a 1000 lignes SANS erreur : une lecture non bornee aurait
// fait croire au script qu'il avait tout vu, et il aurait laisse derriere lui
// les sejours au-dela du millier, silencieusement. C'est un test qui l'a
// rattrapee ici (tests/bookings-snapshot-troncature.test.js), pas ma relecture.
//
// ⚠ ET LA PAGINATION EST ECRITE A L'ENDROIT DE LA REQUETE, PAS DANS UN HELPER.
// Ma premiere correction cachait `.order().range()` derriere une fonction :
// le test ne la voyait plus, et un lecteur non plus. Une borne qu'on ne lit pas
// sur la requete est une borne qu'on oubliera a la prochaine copie.
const PAGE = 1000

async function main () {
  if (!DE || !VERS) throw new Error('--de=<cle abandonnee> et --vers=<provider_property_id> requis')

  // 1. La cible doit exister dans le coeur, sinon on deplace vers le vide.
  // ⚠ `provider_property_id` N'A AUCUNE UNICITE GLOBALE : deux hotes d'un meme
  // property manager Beds24 partagent l'espace de numerotation. Un
  // `maybeSingle()` sur cette seule colonne echouait « par chance » en cas de
  // collision (deux lignes -> erreur) ; on ne se protege pas par accident.
  let qBien = supabase.from('properties')
    .select('id, name, user_id, provider, provider_property_id')
    .eq('provider_property_id', VERS)
  if (COMPTE) qBien = qBien.eq('user_id', COMPTE)
  const { data: candidats, error: eBien } = await qBien
  if (eBien) throw new Error(`lecture properties : ${eBien.message}`)
  if (!candidats?.length) throw new Error(`aucun bien ne porte provider_property_id=${VERS} — rien a faire`)
  if (candidats.length > 1) {
    throw new Error(`${candidats.length} biens portent ${VERS} (comptes differents) — preciser --compte=<user_id>`)
  }
  const bien = candidats[0]

  // 2. La source doit etre une cle REELLEMENT migree, et vers CE bien.
  //    Sans cette verification, ce script deviendrait un outil pour deplacer
  //    n'importe quelle reservation vers n'importe quel bien.
  // La cle primaire est composite sur TROIS colonnes : filtrer sur deux
  // laisserait passer la meme cle migree chez un autre provider.
  const { data: mig, error: eMig } = await supabase
    .from('provider_keys_migrated')
    .select('provider_property_id, target_property_id, provider, migrated_at')
    .eq('user_id', bien.user_id)
    .eq('provider', 'beds24')
    .eq('provider_property_id', String(DE))
    .maybeSingle()
  if (eMig) throw new Error(`lecture provider_keys_migrated : ${eMig.message}`)
  if (!mig) throw new Error(`${DE} n'est pas une cle migree de ce compte — refus`)
  if (String(mig.target_property_id) !== String(bien.id)) {
    throw new Error(`${DE} a ete migree vers ${mig.target_property_id}, pas vers ${bien.id} — refus`)
  }

  console.log(`Bien cible   : ${bien.name} (${bien.provider}, ${VERS})`)
  console.log(`Cle source   : ${DE}, migree le ${String(mig.migrated_at).slice(0, 16)}`)

  // 3. Les lignes concernees.
  let lignes = []
  for (let debut = 0; ; debut += PAGE) {
    let q = supabase.from('bookings_snapshot')
      .select('booking_id, property_id, snapshot, updated_at')
      .eq('user_id', bien.user_id)
      .eq('property_id', String(DE))
      .order('booking_id', { ascending: true })
      .range(debut, debut + PAGE - 1)
    if (BOOKINGS.length) q = q.in('booking_id', BOOKINGS)
    const { data, error: eL } = await q
    if (eL) throw new Error(`lecture bookings_snapshot : ${eL.message}`)
    lignes.push(...(data || []))
    if (!data || data.length < PAGE) break
  }

  if (BOOKINGS.length && lignes.length !== BOOKINGS.length) {
    const vus = new Set(lignes.map(l => String(l.booking_id)))
    throw new Error(`sejours demandes introuvables sous ${DE} : ${BOOKINGS.filter(b => !vus.has(b)).join(', ')}`)
  }
  if (!lignes.length) { console.log('\nAucun sejour a deplacer.'); return }

  // ⚠ ON ECARTE LES SEJOURS DEJA PRESENTS SOUS LEUR JUMEAU (meme code OTA, autre
  // `booking_id`) : les reunir sur le meme bien ferait DEUX menages par depart.
  const cibles = []
  for (let debut = 0; ; debut += PAGE) {
    const { data, error: eC } = await supabase.from('bookings_snapshot')
      .select('booking_id, snapshot')
      .eq('user_id', bien.user_id)
      .eq('property_id', String(VERS))
      .order('booking_id', { ascending: true })
      .range(debut, debut + PAGE - 1)
    if (eC) throw new Error(`lecture des sejours du bien cible : ${eC.message}`)
    cibles.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  const codesCible = new Map()
  for (const c of (cibles || [])) {
    const code = c.snapshot?.otaReservationCode
    if (code) codesCible.set(String(code), String(c.booking_id))
  }
  const jumeles = []
  lignes = lignes.filter(l => {
    const code = l.snapshot?.otaReservationCode
    if (code && codesCible.has(String(code))) { jumeles.push({ l, jumeau: codesCible.get(String(code)) }); return false }
    return true
  })
  if (jumeles.length) {
    console.log(`\n${jumeles.length} sejour(s) ECARTE(S) — deja presents sous leur jumeau sur le bien cible :`)
    for (const j of jumeles) {
      console.log(`  ${j.l.booking_id} (code ${j.l.snapshot.otaReservationCode}) -> jumeau ${j.jumeau}`)
    }
  }
  if (!lignes.length) { console.log('\nRien a deplacer apres ecart des jumeaux.'); return }

  // 4. Ce que chaque ligne va declencher, dit AVANT d'agir.
  // ⚠ BORNE PAR LE COMPTE, MEME POUR UN SIMPLE APERCU. Les `booking_id` Beds24
  // sont numeriques et peuvent collisionner entre comptes : sans ce filtre,
  // l'operateur lirait « SERA RESSUSCITE » sur le menage d'un autre hote.
  const { data: menages } = await supabase.from('menages')
    .select('booking_id, property_id, departure_date, status, provider_id')
    .eq('user_id', bien.user_id)
    .in('booking_id', lignes.map(l => String(l.booking_id)))
  const { data: codes } = await supabase.from('access_codes')
    .select('booking_id, status')
    .eq('user_id', bien.user_id)
    .in('booking_id', lignes.map(l => String(l.booking_id)))

  console.log(`\n${lignes.length} sejour(s) a rendre au bien :\n`)
  for (const l of lignes.sort((a, b) => String(a.snapshot?.arrival).localeCompare(String(b.snapshot?.arrival)))) {
    const s = l.snapshot || {}
    const m = (menages || []).find(x => String(x.booking_id) === String(l.booking_id))
    const c = (codes || []).find(x => String(x.booking_id) === String(l.booking_id))
    console.log(`  ${l.booking_id}  ${s.arrival} -> ${s.departure}  ${String(s.firstName || '')} ${String(s.lastName || '')}`)
    console.log(`     canal ${s.source || '?'} | statut ${readStatus(s, s.provider)} | code OTA ${s.otaReservationCode || '-'}`)
    console.log(`     menage   : ${m ? `${m.status} (depart ${m.departure_date})` : 'aucune ligne'}`
      + `${m && m.status === 'cancelled' ? '  -> SERA RESSUSCITE' : ''}`)
    console.log(`     code acces : ${c ? c.status : 'aucun'}`)
  }

  if (!GO) { console.log('\nDRY-RUN — aucune ecriture. Relancer avec --go.'); return }

  // 5. Ecriture, une ligne a la fois, bornee par le compte ET par la cle source.
  //    Un UPDATE global sur `property_id` serait irreversible en cas d'erreur
  //    d'argument ; ligne a ligne, l'echec s'arrete a la ligne.
  let faits = 0
  for (const l of lignes) {
    const { error } = await supabase.from('bookings_snapshot')
      .update({ property_id: String(VERS) })
      .eq('user_id', bien.user_id)
      .eq('booking_id', String(l.booking_id))
      .eq('property_id', String(DE))     // garde anti-course : personne n'a bouge entre-temps
    if (error) { console.error(`  echec ${l.booking_id} : ${error.message}`); continue }
    faits++
    console.log(`  rendu : ${l.booking_id}`)
  }
  console.log(`\n${faits}/${lignes.length} sejour(s) rendus a ${bien.name}.`)
  console.log('Le writer des menages les reprendra au prochain cycle (*/5).')
}

main().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
