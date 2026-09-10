// scripts/backfill-empreinte-messages.js
// Remplit `message_sent_log.stay_key` pour les lignes deja ecrites.
// Migration : migrations/2026-09-10-empreinte-sejour-messages.sql
//
// ⚠ POURQUOI CE BACKFILL EST LE VRAI ENJEU, ET PAS LE CODE.
// L'empreinte protege les envois FUTURS des le deploiement. Mais les messages
// DEJA envoyes, eux, n'ont que leur `booking_id` — celui qui ne survivra pas au
// remapping. Sans ce rattrapage, les 13 messages deja recus par les voyageurs
// des 11 sejours a venir repartiraient quand meme : le journal ne saurait pas
// les reconnaitre sous leur nouvel identifiant.
//
// A PASSER AVANT LA BASCULE. Apres, c'est trop tard : les anciens identifiants
// auront disparu.
//
// DRY RUN par defaut. LECTURE SEULE sans `--ecrire`.
//
// USAGE : node scripts/backfill-empreinte-messages.js [--ecrire] [--bien <propId>]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { codeOtaBrut } = require('../lib/bookings-snapshot')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const ECRIRE = process.argv.includes('--ecrire')
const iBien = process.argv.indexOf('--bien')
const BIEN = iBien > -1 ? process.argv[iBien + 1] : null

async function main () {
  console.log(ECRIRE ? 'MODE ECRITURE' : 'DRY RUN — aucune ecriture, --ecrire pour ecrire')

  // 1) Toutes les lignes du journal sans empreinte.
  const lignes = []
  let de = 0
  for (;;) {
    const { data, error } = await supabase
      .from('message_sent_log')
      .select('id, user_id, booking_id, template_id, stay_key')
      .is('stay_key', null)
      .order('id')
      .range(de, de + 999)
    if (error) throw new Error(`message_sent_log : ${error.message}`)
    for (const l of data || []) lignes.push(l)
    if (!data || data.length < 1000) break
    de += 1000
  }
  console.log(`\n${lignes.length} ligne(s) de journal sans empreinte`)
  if (!lignes.length) return

  // 2) Le code OTA de chaque sejour concerne. On lit par lots : une requete par
  // ligne aurait fait 632 allers-retours.
  // ⚠ CLOISONNE PAR COMPTE, ET LA CLE EST LE COUPLE.
  // La cle primaire de `bookings_snapshot` est `(user_id, booking_id)` : deux
  // hotes d'un meme property manager Beds24 PARTAGENT l'espace de numerotation
  // (documente dans lib/cron-access.js). Indexer sur le seul `booking_id`
  // laissait la derniere ligne rendue gagner, arbitrairement : une ligne de
  // journal de l'hote A recevait le code OTA du sejour de l'hote B. Le backfill
  // aurait ete silencieusement faux — et il ne passe qu'une fois, sans filet.
  const parCouple = new Map()
  const cle = (userId, bookingId) => `${userId}|${bookingId}`
  const parUtilisateur = new Map()
  for (const l of lignes) {
    if (!parUtilisateur.has(l.user_id)) parUtilisateur.set(l.user_id, new Set())
    parUtilisateur.get(l.user_id).add(String(l.booking_id))
  }
  for (const [userId, setIds] of parUtilisateur) {
    const ids = [...setIds]
    for (let i = 0; i < ids.length; i += 200) {
      const lot = ids.slice(i, i + 200)
      let q = supabase.from('bookings_snapshot')
        .select('booking_id, property_id, snapshot')
        .eq('user_id', userId)
        .in('booking_id', lot)
      if (BIEN) q = q.eq('property_id', String(BIEN))
      const { data, error } = await q
      if (error) throw new Error(`bookings_snapshot : ${error.message}`)
      for (const sn of data || []) {
        // `snapshot.otaReservationCode` est le champ canonique ; `codeOtaBrut`
        // applique la MEME normalisation qu'a l'envoi (trim + majuscules),
        // sinon l'empreinte ecrite ici ne correspondrait pas a celle
        // recherchee.
        const code = codeOtaBrut({ otaReservationCode: (sn.snapshot || {}).otaReservationCode })
        // ⚠ ON ENREGISTRE MEME SANS CODE : c'est ce qui permet de distinguer
        // « sejour introuvable » (a investiguer) de « reservation directe »
        // (normal). Sans ca, le compteur des directes etait du code mort et le
        // rapport annoncait toujours 0.
        parCouple.set(cle(userId, String(sn.booking_id)), { code, property_id: sn.property_id })
      }
    }
  }

  const aEcrire = []
  let sansCode = 0
  let sansSejour = 0
  const biensSansCode = {}
  for (const l of lignes) {
    const trouve = parCouple.get(cle(l.user_id, String(l.booking_id)))
    if (!trouve) { sansSejour++; continue }
    if (!trouve.code) {
      sansCode++
      biensSansCode[trouve.property_id] = (biensSansCode[trouve.property_id] || 0) + 1
      continue
    }
    aEcrire.push({ id: l.id, stay_key: trouve.code, property_id: trouve.property_id })
  }

  console.log(`  a remplir            : ${aEcrire.length}`)
  console.log(`  sejour introuvable   : ${sansSejour}  ⚠ a investiguer : snapshot absent pour ce compte`)
  console.log(`  sejour sans code OTA : ${sansCode}  (aucun code : la garde par booking_id suffit)`)
  if (sansCode) {
    for (const [pid, n] of Object.entries(biensSansCode)) console.log(`       ${pid} : ${n}`)
  }

  // Ce qui compte vraiment : les sejours A VENIR, ceux qui repartiraient.
  const parBien = {}
  for (const e of aEcrire) {
    parBien[e.property_id] = (parBien[e.property_id] || 0) + 1
  }
  console.log('\n  par bien :')
  for (const [pid, n] of Object.entries(parBien).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(pid).padEnd(40)} ${n}`)
  }

  if (!ECRIRE) {
    console.log('\nEssai a blanc — rien n\'a ete ecrit. Relancer avec --ecrire.')
    return
  }

  // 3) Ecriture, par lots. Un UPDATE par ligne : `stay_key` differe a chaque
  // fois, il n'y a rien a grouper.
  let faits = 0
  for (const e of aEcrire) {
    const { error } = await supabase.from('message_sent_log')
      .update({ stay_key: e.stay_key }).eq('id', e.id)
    if (error) {
      console.error(`  echec sur la ligne ${e.id} : ${error.message}`)
      continue
    }
    faits++
  }
  console.log(`\n${faits}/${aEcrire.length} empreinte(s) ecrite(s).`)
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
