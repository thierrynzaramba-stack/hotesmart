// scripts/dedoublonner-sejours-remappes.js
// Rapproche par CODE OTA les sejours livres deux fois lors d'un remapping, et
// neutralise la version de l'ancien channel manager.
//
// ⚠ POURQUOI CE DOUBLON EXISTE. Au mapping d'un canal, le nouveau provider
// livre les sejours DEJA PRIS. Ils existent alors sous deux `booking_id` : celui
// de l'ancien CM et celui du nouveau. `bookings_snapshot` est clee
// `(user_id, booking_id)` : aucune contrainte ne s'y oppose, les deux vivent.
//
// Mesure du 10 septembre 2026 sur La bulle : trois sejours Airbnb en double
// (HMXJPMDJEN, HMYSC3QK8X, HM4TMX5QXQ), et trois menages de plus — dont un sur
// un depart qui en avait deja un, accepte par la prestataire.
//
// ⚠ LA VERSION CONSERVEE EST CELLE DU NOUVEAU PROVIDER, et ce n'est pas
// arbitraire : c'est elle qui recevra les mises a jour (annulation, changement
// de dates, message du voyageur). Garder l'ancienne, c'est garder une ligne qui
// ne bougera plus jamais.
//
// ⚠ LE CODE OTA EST LE SEUL LIEN. `otaReservationCode` traverse le changement
// de channel manager — c'est deja la cle de rattachement des avis et
// l'empreinte des messages. Rapprocher par dates aurait confondu deux voyageurs
// aux memes nuits (surreservation, cas que ce produit gere explicitement).
//
// ⚠ ECRITURE DIRECTE DANS `bookings_snapshot`, EXCEPTION ASSUMEE.
// Le writer unique est la couche sync. Passer par elle produirait un evenement
// de changement, donc une DISTRIBUTION — exactement ce qu'on repare. Un UPDATE
// direct du JSON ne journalise rien : le statut change, personne n'est
// notifie. Migration ponctuelle, pas un precedent.
//
// DRY RUN par defaut.
// USAGE : node scripts/dedoublonner-sejours-remappes.js <la-bulle> [--ecrire]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { readStatus, STATUS } = require('../lib/bookings-snapshot-status')
const { codeOtaBrut } = require('../lib/bookings-snapshot')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const ECRIRE = process.argv.includes('--ecrire')

const CIBLES = {
  'la-bulle': {
    nom: 'La bulle',
    fiche: '091d9abf-ff86-45ce-8123-3425e6f3900f',
    cle: '0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4',
    // La liste est FERMEE et nommee : un dedoublonnage qui decide seul quelle
    // version garder pourrait neutraliser la mauvaise sur un cas limite.
    codes: ['HMXJPMDJEN', 'HMYSC3QK8X', 'HM4TMX5QXQ'],
    // Le provider dont la version est CONSERVEE.
    garder: 'channex'
  }
}
const CLE = process.argv.find(a => CIBLES[a])
if (!CLE) {
  console.error(`USAGE : node scripts/dedoublonner-sejours-remappes.js <${Object.keys(CIBLES).join('|')}> [--ecrire]`)
  process.exit(1)
}
const C = CIBLES[CLE]

// Un `booking_id` de l'ancien CM est numerique ; celui de Channex est un UUID.
// C'est le seul discriminant disponible sans relire le provider, et il est
// verifie sur les donnees reelles avant tout geste.
const estUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))

async function main () {
  console.log(`${ECRIRE ? 'MODE ECRITURE' : 'DRY RUN'}  ${C.nom}`)

  const tous = []
  let de = 0
  for (;;) {
    const { data, error } = await supabase.from('bookings_snapshot')
      .select('booking_id, snapshot, created_at')
      .eq('property_id', C.cle).order('booking_id').range(de, de + 499)
    if (error) throw new Error(`bookings_snapshot : ${error.message}`)
    tous.push(...(data || []))
    if (!data || data.length < 500) break
    de += 500
  }
  console.log(`   ${tous.length} sejours lus sous ${C.cle}`)

  const plan = []
  for (const code of C.codes) {
    const versions = tous.filter(b => codeOtaBrut(b.snapshot) === code)
    console.log(`\n── ${code} : ${versions.length} version(s)`)
    for (const v of versions) {
      console.log(`      ${String(v.booking_id).padEnd(38)} ${v.snapshot.arrival}->${v.snapshot.departure}`
        + `  ${readStatus(v.snapshot)}  cree ${String(v.created_at).slice(0, 19)}`)
    }
    if (versions.length < 2) { console.log('      pas de doublon — rien a faire'); continue }
    if (versions.length > 2) { console.log('      ⚠ PLUS DE DEUX versions : a trancher a la main, on saute'); continue }

    const garde = versions.find(v => estUuid(v.booking_id))
    const neutralise = versions.find(v => !estUuid(v.booking_id))
    if (!garde || !neutralise) {
      console.log('      ⚠ impossible de distinguer les deux versions par leur id : on saute')
      continue
    }
    // Les deux doivent decrire LE MEME sejour : sinon on ne rapproche pas.
    if (garde.snapshot.arrival !== neutralise.snapshot.arrival
      || garde.snapshot.departure !== neutralise.snapshot.departure) {
      console.log(`      ⚠ DATES DIFFERENTES entre les deux versions : on saute`)
      continue
    }
    console.log(`      garde      ${garde.booking_id}  (${C.garder})`)
    console.log(`      neutralise ${neutralise.booking_id}  (ancien CM)`)
    plan.push({ code, garde, neutralise })
  }

  // Les menages du cote neutralise : ils feront doublon.
  console.log('\n── menages a supprimer (cote neutralise)')
  const aSupprimer = []
  for (const p of plan) {
    const { data: m } = await supabase.from('menages')
      .select('id, departure_date, status, provider_id').eq('booking_id', String(p.neutralise.booking_id))
    for (const x of m || []) {
      // ⚠ ON NE SUPPRIME PAS UN MENAGE DONT LE TRAVAIL EST FAIT.
      // `menage_done` est la trace du travail de la prestataire et l'assise de
      // l'historique de qualite. S'il existe, on laisse le cron annuler la
      // ligne plutot que de l'effacer.
      const { count: fait } = await supabase.from('menage_done')
        .select('*', { count: 'exact', head: true }).eq('menage_id', x.id)
      const { count: cmt } = await supabase.from('menage_comments')
        .select('*', { count: 'exact', head: true }).eq('menage_id', x.id)
      if (fait || cmt) {
        console.log(`   ⚠ ${x.id} depart ${x.departure_date} : ${fait} trace(s) de travail, ${cmt} commentaire(s) — CONSERVE`)
        continue
      }
      // Et le cote garde doit bien porter un menage sur la meme date, sinon on
      // supprimerait le seul qui existe.
      const { data: jumeau } = await supabase.from('menages')
        .select('id, status, provider_id').eq('booking_id', String(p.garde.booking_id))
        .eq('departure_date', x.departure_date)
      if (!(jumeau || []).length) {
        console.log(`   ⚠ ${x.id} depart ${x.departure_date} : AUCUN menage cote garde — CONSERVE`)
        continue
      }
      console.log(`   ${x.id}  depart ${x.departure_date}  ${x.status}`
        + `  -> conserve cote garde : ${jumeau[0].id} ${jumeau[0].status}`
        + ` provider=${jumeau[0].provider_id ? 'oui' : 'AUCUN ⚠'}`)
      aSupprimer.push(x)
    }
  }
  if (!aSupprimer.length) console.log('   aucun')

  if (!ECRIRE) { console.log('\nEssai a blanc — rien ecrit. Relancer avec --ecrire.'); return }
  if (!plan.length) { console.log('\nRien a dedoublonner.'); return }

  // ── SAUVEGARDE avant toute modification ──────────────────────────────────
  const { error: eBk } = await supabase.from('rekeying_backup').insert({
    bien_id: C.fiche,
    source: 'doublons de remapping',
    cible: C.cle,
    nom_table: 'bookings_snapshot + menages (dedoublonnage)',
    lignes: { neutralises: plan.map(p => p.neutralise), menages_supprimes: aSupprimer }
  })
  if (eBk) throw new Error(`sauvegarde : ${eBk.message}`)
  console.log(`\n✓ sauvegarde dans rekeying_backup`)

  // ── NEUTRALISATION ────────────────────────────────────────────────────────
  const maintenant = new Date().toISOString()
  for (const p of plan) {
    const s = { ...p.neutralise.snapshot }
    const avant = readStatus(s)
    s.status = STATUS.DEMAPPED
    // ⚠ `initialImport` EST POSE EXPLICITEMENT, comme Thierry l'a demande.
    // Il dit : cette ligne est un vestige d'import, elle ne doit rien
    // declencher. Le `demappage` porte de quoi remonter le fil.
    s.initialImport = true
    s.demappage = {
      neutralise_le: maintenant,
      statut_avant: avant,
      raison: 'doublon_de_remapping',
      code_ota: p.code,
      conserve_sous: String(p.garde.booking_id)
    }
    const { error } = await supabase.from('bookings_snapshot')
      .update({ snapshot: s, updated_at: maintenant })
      .eq('property_id', C.cle).eq('booking_id', String(p.neutralise.booking_id))
    console.log(`   ${p.code} : ${error ? 'ECHEC ' + error.message : `${avant} -> demapped (initialImport)`}`)
  }

  // ── MENAGES EN DOUBLON ────────────────────────────────────────────────────
  for (const x of aSupprimer) {
    const { error } = await supabase.from('menages').delete().eq('id', x.id)
    console.log(`   menage ${x.id} depart ${x.departure_date} : ${error ? 'ECHEC ' + error.message : 'supprime'}`)
  }
}

main().catch(e => { console.error('\nECHEC :', e.message); process.exitCode = 1 })
