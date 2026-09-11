// scripts/audit-prix-voyageur.js
// DOC : docs/specs/spec-yieldflow-v1.md (etape 0, §3 et §9)
//
// LECTURE SEULE. N'ECRIT RIEN — ni en base, ni chez le provider.
// Repond a une seule question, par les faits :
//   pour chaque (provider, canal), QUEL CHAMP du payload vaut le prix
//   paye par le voyageur ?
//
// Le snapshot normalise promet `amount` = « total facture au VOYAGEUR, jamais
// le net hote » (lib/bookings-snapshot.js). Ce script mesure si la promesse
// tient, canal par canal, contre les payloads `raw` reels.
//
// USAGE : node scripts/audit-prix-voyageur.js [--detail]

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { ALL_STATUSES } = require('../lib/bookings-snapshot-status')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const DETAIL = process.argv.includes('--detail')

const num = v => { const x = Number(v); return Number.isFinite(x) ? x : null }
const r2 = v => (v == null ? null : Math.round(v * 100) / 100)
const mediane = a => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return r2(s[Math.floor(s.length / 2)])
}
// Egalite monetaire a 2 centimes pres. Channex sert des chaines ('82.21'),
// Beds24 des nombres, et on additionne des nuits : le cumul flottant derive.
const egal = (a, b) => a != null && b != null && Math.abs(a - b) < 0.02

// ⚠ COMPARER LES JOURS, PAS LES INSTANTS.
// `bookingTime` porte une heure ('2026-09-12T09:00:00Z'), `arrival` est un jour
// nu ('2026-09-12') que `new Date()` place a minuit UTC. Une vente faite le
// matin meme de l'arrivee est alors « posterieure a l'arrivee » — or c'est le
// delai 0, le cas le plus frequent des ventes de derniere minute. Les compter
// comme dates corrompues reviendrait a retirer de la courbe de pickup
// exactement ce que le yield doit mesurer.
const jour = v => (typeof v === 'string' ? v.slice(0, 10) : null)
const venduApresArrivee = (instant, arrivee) => {
  const a = jour(instant)
  const b = jour(arrivee)
  return a != null && b != null && a > b
}

// ─── Reconstructions candidates, par provider ────────────────────────────────

// Beds24 : `price`, la somme des lignes de facture, et le « Base Price » que
// Beds24 recopie en clair dans rateDescription pour les canaux OTA.
function candidatsBeds24 (raw) {
  const charges = (raw.invoiceItems || [])
    .filter(i => i.type === 'charge')
    .reduce((somme, i) => somme + (num(i.lineTotal) || 0), 0)
  const m = /Base Price ([\d.]+) EUR/.exec(raw.rateDescription || '')
  return {
    price: num(raw.price),
    commission: num(raw.commission) || 0,
    charges: charges || null,
    basePrice: m ? num(m[1]) : null
  }
}

// Channex : `amount`, la somme des nuits, les services (menage...), le total
// « vue voyageur » que Booking.com transmet, et les lignes de payout qu'Airbnb
// depose en texte libre dans `notes`.
function candidatsChannex (raw) {
  const rooms = raw.rooms || []
  let nuits = 0
  let services = 0
  for (const ro of rooms) {
    for (const v of Object.values(ro.days || {})) nuits += num(v) || 0
    for (const sv of ro.services || []) services += num(sv.total_price) || 0
  }
  // Somme sur TOUTES les chambres : `amount` couvre la reservation entiere, et
  // `nuits`/`services` ci-dessus somment deja les chambres. Ne lire que
  // rooms[0] ferait manquer une chambre entiere sur une resa multi-chambres.
  let guestView = null
  for (const ro of rooms) {
    const t = ro.meta?.price_details?.guest_view?.total
    const brutT = t ? num(t.amount) : null
    // `null / 100` vaut 0 : sans ce test, un total illisible passerait pour
    // une reservation a 0 € et degraderait le ratio publie.
    if (brutT == null) continue
    guestView = (guestView || 0) + brutT / Math.pow(10, t.decimal_places ?? 2)
  }
  const lire = re => { const m = re.exec(raw.notes || ''); return m ? num(m[1]) : null }
  const base = lire(/Listing Base Price: ([\d.]+)/)
  const menage = lire(/Cleaning Fee: ([\d.]+)/)
  const hostFee = lire(/Listing Cancellation Host Fee: ([\d.]+)/)
  const amount = num(raw.amount)
  return {
    amount,
    amountType: raw.meta?.amount_type || null,
    nuits: nuits || null,
    services: services || null,
    guestView,
    notesBase: base,
    notesMenage: menage,
    notesHostFee: hostFee,
    // Brut voyageur reconstruit. DEUX CHEMINS, ET UN SEUL EST FIABLE :
    //
    //  - `brut` = net + retenue Airbnb. Verifie contre le `price` Beds24 du
    //    MEME sejour sur les 5 reservations vues par les deux providers : 5/5.
    //  - `brutNotes` = tarif d'annonce + menage, lu dans le texte libre. Il
    //    tombe juste 3 fois sur 5 : sur HMADA4CMQR il rend 125 au lieu de 134,
    //    sur HMEA8PYCPM 413 au lieu de 485. Le `Listing Base Price` des notes
    //    est le tarif de l'annonce, pas le prix reellement paye (remises,
    //    supplements voyageurs et frais additionnels n'y figurent pas).
    //
    // On garde les deux pour que l'ecart reste mesurable, mais seul `brut`
    // fait foi.
    //
    // ⚠ LA RECONSTRUCTION NE VAUT QUE SI `amount` EST UN NET.
    // « Payout Amount » n'est pas une fatalite Channex : c'est HoteSmart qui le
    // regle (`booking_amount_settings`, api/channel-airbnb-connect.js). Un canal
    // repris via `reuseChannelId`, ou reconfigure cote Channex, peut servir un
    // `amount` deja brut — y ajouter la retenue rendrait ~23 % AU-DESSUS du prix
    // paye, sans erreur. Le discriminant est donc le payload, jamais le nom du
    // canal.
    brut: raw.meta?.amount_type !== 'Payout Amount' || amount == null || hostFee == null
      ? null
      : amount + hostFee,
    brutNotes: base == null ? null : base + (menage || 0)
  }
}

async function toutLeSnapshot () {
  let lignes = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('bookings_snapshot')
      .select('booking_id, property_id, created_at, snapshot, raw')
      // ⚠ SANS `order`, PostgreSQL ne garantit aucun ordre entre deux pages, et
      // le cron reecrit la table toutes les 5 minutes : une ligne deplacee entre
      // la page 1 et la page 2 est lue deux fois, ou pas du tout. La validation
      // croisee afficherait alors 4/5 (ou un faux 5/5) sur un simple cycle cron.
      .order('booking_id')
      .range(from, from + 999)
    if (error) throw error
    lignes = lignes.concat(data)
    if (data.length < 1000) break
  }
  return lignes
}

function canal (ligne) {
  return String(ligne.snapshot?.source || '?').toLowerCase()
}

async function main () {
  const lignes = await toutLeSnapshot()
  const { data: biens, error } = await supabase
    .from('properties')
    .select('id, name, provider, provider_property_id')
  if (error) throw error

  // Le snapshot est cle sur la CLE PROVIDER, pas sur properties.id. Cote
  // Channex cette cle est elle-meme un UUID : indiscernable d'un properties.id
  // a l'oeil nu, d'ou ce pont explicite.
  const parCleProvider = Object.fromEntries(
    biens.map(b => [b.provider_property_id, b])
  )

  console.log('# Audit prix voyageur — LECTURE SEULE')
  console.log(`lignes snapshot : ${lignes.length}`)
  console.log(`avec payload raw : ${lignes.filter(l => l.raw).length}`)

  // ─── 1. Beds24 ─────────────────────────────────────────────────────────────
  const b24 = lignes.filter(l => l.raw && l.snapshot?.provider === 'beds24')
  const statsB = {}
  for (const l of b24) {
    const c = canal(l)
    const s = (statsB[c] = statsB[c] || {
      n: 0, priceVide: 0, priceEgalCharges: 0,
      priceEgalChargesPlusComm: 0, baseEgalPrice: 0, tauxComm: []
    })
    const k = candidatsBeds24(l.raw)
    s.n++
    if (!k.price) s.priceVide++
    if (k.charges && egal(k.price, k.charges)) s.priceEgalCharges++
    if (k.charges && egal(k.price, k.charges + k.commission)) s.priceEgalChargesPlusComm++
    if (k.basePrice != null && egal(k.basePrice, k.price)) s.baseEgalPrice++
    if (k.price > 0) s.tauxComm.push(k.commission / k.price * 100)
  }
  console.log('\n## Beds24 — quelle grandeur porte `price` ?')
  for (const [c, s] of Object.entries(statsB)) {
    console.log(` ${c.padEnd(14)} n=${String(s.n).padStart(4)}` +
      `  price=charges ${s.priceEgalCharges}/${s.n}` +
      `  price=charges+comm ${s.priceEgalChargesPlusComm}/${s.n}` +
      `  price=BasePrice ${s.baseEgalPrice}/${s.n}` +
      `  comm.mediane ${mediane(s.tauxComm)}%` +
      `  price vide ${s.priceVide}`)
  }

  // ─── 2. Channex ────────────────────────────────────────────────────────────
  const chx = lignes.filter(l => l.raw && l.snapshot?.provider === 'channex')
  const statsC = {}
  for (const l of chx) {
    const c = canal(l)
    const s = (statsC[c] = statsC[c] || {
      n: 0, types: {}, egalNuits: 0, egalNuitsServices: 0,
      avecGuestView: 0, egalGuestView: 0, avecNotes: 0,
      avecHostFee: 0, notesConcordent: 0, ecarts: []
    })
    const k = candidatsChannex(l.raw)
    s.n++
    s.types[k.amountType || '(absent)'] = (s.types[k.amountType || '(absent)'] || 0) + 1
    if (egal(k.amount, k.nuits)) s.egalNuits++
    if (egal(k.amount, (k.nuits || 0) + (k.services || 0))) s.egalNuitsServices++
    if (k.guestView != null) {
      s.avecGuestView++
      if (egal(k.amount, k.guestView)) s.egalGuestView++
    }
    if (k.brut != null) {
      s.avecHostFee++
      if (k.amount) s.ecarts.push((k.brut - k.amount) / k.amount * 100)
      if (k.brutNotes != null && egal(k.brut, k.brutNotes)) s.notesConcordent++
    }
    if (k.brutNotes != null) s.avecNotes++
  }
  console.log('\n## Channex — `amount` est-il bien un total voyageur ?')
  for (const [c, s] of Object.entries(statsC)) {
    console.log(` ${c.padEnd(14)} n=${String(s.n).padStart(4)}` +
      `  meta.amount_type=${JSON.stringify(s.types)}`)
    console.log(`   amount=nuits ${s.egalNuits}/${s.n}` +
      `  amount=nuits+services ${s.egalNuitsServices}/${s.n}` +
      `  amount=guest_view ${s.egalGuestView}/${s.avecGuestView}` +
      `  Host Fee lisible ${s.avecHostFee}/${s.n}` +
      `  (dont notes concordantes ${s.notesConcordent}/${s.avecHostFee})` +
      `  ecart brut vs amount : mediane ${mediane(s.ecarts)}%`)
  }

  // ─── 3. Date de vente ──────────────────────────────────────────────────────
  console.log('\n## Date de vente')
  const btPresent = b24.filter(l => l.raw.bookingTime).length
  const btApresArrivee = b24.filter(l =>
    venduApresArrivee(l.raw.bookingTime, l.raw.arrival)).length
  console.log(` beds24  bookingTime present ${btPresent}/${b24.length}` +
    `  posterieur a l'arrivee ${btApresArrivee} (date de vente fausse)`)
  const importees = chx.filter(l => l.raw.meta?.is_imported === true).length
  const iaApresArrivee = chx.filter(l =>
    venduApresArrivee(l.raw.inserted_at, l.raw.arrival_date)).length
  console.log(` channex inserted_at present ${chx.filter(l => l.raw.inserted_at).length}/${chx.length}` +
    `  is_imported=true ${importees} (inserted_at = date de MIGRATION)` +
    `  posterieur a l'arrivee ${iaApresArrivee}`)

  // ─── 4. Rattachement et anomalies ──────────────────────────────────────────
  console.log('\n## Rattachement des lignes aux biens')
  const parBien = {}
  for (const l of lignes) {
    const b = parCleProvider[l.property_id]
    const k = b ? `${b.name} [${b.provider}]` : `(cle orpheline ${l.property_id})`
    const s = (parBien[k] = parBien[k] || { total: 0, beds24: 0, channex: 0, demapped: 0 })
    s.total++
    s[l.snapshot?.provider] = (s[l.snapshot?.provider] || 0) + 1
    if (l.snapshot?.status === 'demapped') s.demapped++
  }
  for (const [k, s] of Object.entries(parBien)) {
    const mixte = s.beds24 > 0 && s.channex > 0 ? '  <-- DEUX PROVIDERS SOUS UNE CLE' : ''
    console.log(` ${k.padEnd(26)} total=${String(s.total).padStart(4)}` +
      ` beds24=${String(s.beds24).padStart(4)} channex=${String(s.channex).padStart(3)}` +
      ` demapped=${s.demapped}${mixte}`)
  }
  // Les deux sections provider filtrent sur `snapshot.provider`. Une ligne qui
  // ne le porte pas (backfill-snapshot-provider.js se declare lui-meme « PAS
  // indispensable », donc jamais garanti applique) sortirait de tous les
  // comptes sans que rien ne le dise, et les totaux publies seraient faux en
  // silence. On l'affiche, meme a zero.
  const sansProvider = lignes.length -
    lignes.filter(l => ['beds24', 'channex'].includes(l.snapshot?.provider)).length
  console.log(` lignes sans provider reconnu : ${sansProvider}` +
    (sansProvider ? '  <-- EXCLUES DE TOUTES LES MESURES CI-DESSUS' : ''))
  const sansBien = biens.filter(b =>
    !lignes.some(l => l.property_id === b.provider_property_id))
  console.log(' biens sans aucune ligne snapshot :',
    sansBien.map(b => `${b.name} [${b.provider}/${b.provider_property_id}]`).join(', ') || 'aucun')

  console.log('\n## Anomalies')
  const statuts = lignes.reduce((a, l) => {
    const s = l.snapshot?.status || '(vide)'; a[s] = (a[s] || 0) + 1; return a
  }, {})
  console.log(' statuts :', JSON.stringify(statuts))
  // ⚠ ON LIT LE CANON, ON NE LE RECOPIE PAS.
  // La premiere version de ce script portait la liste en dur — copiee sur un
  // commentaire perime de lib/bookings-snapshot.js — et a donc declare « hors
  // canon » les 5 lignes `demapped`, qui y sont entrees le 10 septembre 2026 a
  // la demande explicite de Thierry. Une liste dupliquee se perime en silence
  // et accuse la donnee saine.
  const horsCanon = Object.keys(statuts).filter(s => !ALL_STATUSES.includes(s))
  if (horsCanon.length) console.log(' STATUTS HORS CANON :', horsCanon.join(', '))
  const codes = {}
  for (const l of lignes) {
    const c = l.snapshot?.otaReservationCode
    if (c) (codes[c] = codes[c] || []).push(l)
  }
  const doublons = Object.entries(codes).filter(([, v]) => v.length > 1)
  console.log(` codes OTA portes par plusieurs lignes : ${doublons.length}`)
  if (DETAIL) {
    for (const [c, v] of doublons) {
      console.log(`  ${c} : ` + v.map(l =>
        `${l.snapshot.provider}/${l.snapshot.status}`).join(' + '))
    }
  }
  console.log(' lignes sans raw :', lignes.filter(l => !l.raw).length)

  // ─── 4 bis. Validation croisee ────────────────────────────────────────────
  // Les 5 reservations dedoublonnees a la bascule sont un cadeau : le MEME
  // sejour reel, vu par les deux providers. C'est la seule maniere de prouver
  // qu'une reconstruction rend bien le prix voyageur, et pas une grandeur
  // plausible. Si ce bloc cesse de dire 5/5, la formule du §9 est fausse.
  console.log('\n## Validation croisee : meme sejour, deux providers')
  const parCode = {}
  for (const l of lignes) {
    const c = l.snapshot?.otaReservationCode
    if (c && l.raw) (parCode[c] = parCode[c] || []).push(l)
  }
  let croiseOk = 0
  let croiseTotal = 0
  let croiseIncalculable = 0
  for (const [code, v] of Object.entries(parCode)) {
    const b = v.find(l => l.snapshot.provider === 'beds24')
    const c = v.find(l => l.snapshot.provider === 'channex')
    if (!b || !c) continue
    croiseTotal++
    const kb = candidatsBeds24(b.raw)
    const kc = candidatsChannex(c.raw)
    // Un `brut` nul n'est PAS un ecart : c'est une reconstruction impossible
    // (Host Fee illisible, ou amount_type inattendu). Les confondre ferait
    // s'allumer le garde-fou « 5/5 » sur un simple changement de libelle
    // Airbnb, et imprimerait « ECART -134 » pour un calcul jamais fait.
    let verdict
    if (kc.brut == null || kb.price == null) {
      croiseIncalculable++
      verdict = `INCALCULABLE (amount_type=${kc.amountType || 'absent'},` +
        ` hostFee=${kc.notesHostFee == null ? 'illisible' : kc.notesHostFee})`
    } else if (egal(kc.brut, kb.price)) {
      croiseOk++
      verdict = 'CONCORDE'
    } else {
      verdict = 'ECART ' + r2(kc.brut - kb.price)
    }
    const okNotes = egal(kc.brutNotes, kb.price)
    console.log(` ${code} arr=${b.raw.arrival}` +
      `  beds24.price=${kb.price}  channex.amount=${kc.amount} + hostFee=${kc.notesHostFee}` +
      ` = ${r2(kc.brut)}  ${verdict}` +
      `  | via notes ${r2(kc.brutNotes)} ${okNotes ? 'ok' : 'FAUX'}`)
  }
  const croiseComparables = croiseTotal - croiseIncalculable
  console.log(` amount + Host Fee == beds24.price : ${croiseOk}/${croiseComparables}` +
    ` comparables (${croiseIncalculable} incalculables sur ${croiseTotal})`)

  // ─── 5. Impact chiffre : la bascule casse-t-elle la serie de CA ? ──────────
  console.log('\n## Impact de la bascule sur la comparaison N / N-1 (canal airbnb)')
  for (const [cle, bien] of Object.entries(parCleProvider)) {
    const duBien = lignes.filter(l =>
      l.property_id === cle && canal(l) === 'airbnb' &&
      l.snapshot?.status === 'confirmed' && l.raw)
    const hist = duBien.filter(l => l.snapshot.provider === 'beds24')
    const now = duBien.filter(l => l.snapshot.provider === 'channex')
    if (!hist.length || !now.length) continue
    const perte = now.reduce((somme, l) => {
      const k = candidatsChannex(l.raw)
      return somme + (k.brut != null && k.amount != null ? k.brut - k.amount : 0)
    }, 0)
    const vu = now.reduce((s, l) => s + (num(l.raw.amount) || 0), 0)
    console.log(` ${bien.name} : historique beds24 ${hist.length} resas (brut),` +
      ` present channex ${now.length} resas (net hote)`)
    // `perte / 0` imprimerait « Infinity % » dans un rapport d'ecart : un bien
    // migre dont les resas Channex sont toutes a montant nul est atteignable.
    const pct = vu > 0 ? `${r2(perte / vu * 100)} %` : 'incalculable (CA nul)'
    console.log(`   CA channex tel qu'enregistre ${r2(vu)} EUR,` +
      ` manque ${r2(perte)} EUR (${pct}) pour etre comparable`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
