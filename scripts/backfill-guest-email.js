// scripts/backfill-guest-email.js
// Etape 1 du chantier « canal e-mail pour les reservations directes » :
// docs/specs/spec-canal-email-resa-directe.md.
//
// Pose `snapshot.guestEmail` sur les lignes DEJA en base, en le re-derivant du
// payload provider conserve dans `raw`.
//
// HORS CRON. One-shot, idempotent, rejouable.
//
// USAGE
//   node scripts/backfill-guest-email.js [--execute]
//     par defaut : DRY RUN (aucune ecriture), --execute pour ecrire
//
// ⚠ AUCUN APPEL PROVIDER. Tout vient du `raw` deja conserve par le writer : c'est
// la regle du coeur de donnees — la donnee est deja repertoriee, on ne redemande
// rien a personne.
//
// ⚠ AUCUNE EXTRACTION RECOPIEE. L'adresse est derivee par `mapBooking`, la
// fonction du writer elle-meme. Recopier ici « customer.mail » ferait exister la
// regle a deux endroits, et l'un des deux finirait par mentir.
//
// ⚠ ECRITURE CHIRURGICALE. On passe au writer un snapshot ne portant QUE
// `provider` et `guestEmail` : le merge non destructif laisse les 15 autres
// champs intacts, donc `detectChange` compare des valeurs identiques et ne rend
// RIEN. Aucun evenement, aucun menage, aucun message. Repasser le `raw` entier
// au writer aurait re-derive tout le snapshot avec les mappers d'aujourd'hui —
// une correction silencieuse hors perimetre.
//
// ⚠ ET `initialImport: true` MALGRE TOUT. Le raisonnement ci-dessus dit qu'aucun
// evenement ne peut naitre ; le drapeau est la pour le jour ou il se trompe.
// `recordChangeEvent` ecrit l'evenement AVANT l'upsert : un `r.change` constate
// apres coup est DEJA en base, distribuable, et l'arret du script ne le defait
// pas — le dispatcher le consommerait au cycle */5 suivant (message de
// bienvenue, menage, code d'acces). C'est l'incident du 10 septembre 2026, ou
// trois voyageurs ont recu deux fois leur message de bienvenue. Avec le drapeau,
// un evenement inattendu naitrait DEJA marque traite : il se verrait sans rien
// declencher. Constat de review, 16 septembre 2026.
//
// ⚠ ORDRE DE DEPLOIEMENT : CE SCRIPT D'ABORD, LE PUSH ENSUITE.
// Une fois `guestEmail` deploye dans les mappers, toute reservation dont le
// payload porte une adresse rend un `merged` different de l'existant : la garde
// « ligne inchangee » du writer est contournee et chaque ligne repasse par un
// upsert SEQUENTIEL dans le cron */5. Le budget `budgetRaw` ne couvre PAS ce
// chemin — il ne protege que le rafraichissement du `raw`. Lance avant le push,
// ce script rend le deploiement neutre : le code d'aujourd'hui conserve les
// champs hors schema au merge, donc poser l'adresse maintenant ne derange rien,
// et le mapper deploye ne trouvera plus rien a changer.
//
// ⚠ LECTURE PAGINEE PAR CURSEUR, ET VERIFIEE. PostgREST plafonne un rendu a 1000
// lignes SANS ERREUR (incident du 7 septembre 2026, et la 9e rouge du 14). On lit
// donc par pages et on CONFRONTE le total lu au compte exact.
//
// Le curseur (`id > dernier`) plutot qu'un offset : la table est ecrite par le
// cron toutes les 5 minutes, et une suppression concurrente (purge du futur,
// suppression d'une resa figee) DECALE les offsets — une ligne serait sautee en
// silence, pages pleines, confrontation satisfaite. Constat de review : la garde
// affirmait plus qu'elle ne tenait.

require('dotenv').config({ path: '.env.local', quiet: true })
const { createClient } = require('@supabase/supabase-js')
const { mapBooking, saveBookingSnapshot } = require('../lib/bookings-snapshot')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const EXECUTE = process.argv.includes('--execute')
const PAGE = 200

const t = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(t(), ...a)

// Une adresse ne s'affiche pas en clair dans un compte rendu de script.
const masque = e => {
  const s = String(e || '')
  const i = s.indexOf('@')
  return i < 1 ? `<${s.length} car>` : `${s.slice(0, 2)}***@${s.slice(i + 1)}`
}

async function lireTout () {
  const { count, error: eCount } = await supabase
    .from('bookings_snapshot')
    .select('booking_id', { count: 'exact', head: true })
  if (eCount) throw new Error(`comptage impossible : ${eCount.message}`)

  const lignes = []
  let curseur = null
  for (;;) {
    let q = supabase
      .from('bookings_snapshot')
      .select('id, user_id, booking_id, property_id, snapshot, raw, raw_hash')
      .order('id', { ascending: true })
      .limit(PAGE)
    if (curseur !== null) q = q.gt('id', curseur)
    const { data, error } = await q
    if (error) throw new Error(`lecture apres ${curseur} : ${error.message}`)
    if (!data || !data.length) break
    lignes.push(...data)
    curseur = data[data.length - 1].id
    if (data.length < PAGE) break
  }

  // La confrontation qui empeche un « rien a faire » tronque de passer pour un
  // succes. Un verificateur qui n'a rien lu doit ECHOUER, pas rendre zero.
  // Le compte est lu AVANT les pages : une ecriture concurrente peut donc rendre
  // `lignes.length` superieur. C'est un ecart benin (le script est idempotent) —
  // seul un DEFICIT signale une lecture amputee.
  if (lignes.length < count) {
    throw new Error(`lecture incomplete : ${lignes.length} lignes lues pour ${count} annoncees`)
  }
  return { lignes, count }
}

async function main () {
  log(EXECUTE ? 'MODE ECRITURE' : 'DRY RUN — aucune ecriture')

  const { lignes, count } = await lireTout()
  log(`${count} lignes dans bookings_snapshot, ${lignes.length} lues et confrontees`)

  const bilan = {
    deja: 0,           // guestEmail deja pose
    sansRaw: 0,        // pas de payload a re-deriver
    sansProvider: 0,   // provider inconnu : on ne l'invente pas (voir plus bas)
    sansAdresse: 0,    // payload present, mais le provider n'a pas servi d'adresse
    aPoser: 0,
    ecrites: 0,
    echecs: 0,
    parSource: {}
  }
  const aEcrire = []

  for (const l of lignes) {
    const snap = l.snapshot || {}
    if (snap.guestEmail) { bilan.deja++; continue }
    if (!l.raw) { bilan.sansRaw++; continue }

    // ⚠ ON NE DEVINE PAS LE PROVIDER. Le snapshot minimal ecrit plus bas le
    // PERSISTE, et `readStatus` prefere `snapshot.provider` au defaut de
    // l'appelant : une inference fausse changerait la canonisation du statut de
    // cette reservation pour TOUS les lecteurs, definitivement. Une ligne sans
    // provider se repare avec l'outil fait pour ca —
    // `scripts/backfill-snapshot-provider.js` — puis on repasse ici.
    // Constat de review, 16 septembre 2026.
    if (!snap.provider) { bilan.sansProvider++; continue }
    const provider = snap.provider
    let email
    try {
      email = mapBooking(provider, l.raw).guestEmail
    } catch (e) {
      log(`⚠ mapping impossible pour ${l.booking_id} (${provider}) : ${e.message}`)
      bilan.echecs++
      continue
    }
    if (!email) { bilan.sansAdresse++; continue }

    bilan.aPoser++
    const src = snap.source || '(sans source)'
    bilan.parSource[src] = (bilan.parSource[src] || 0) + 1
    aEcrire.push({ l, provider, email })
  }

  console.log('')
  log(`deja pourvues        : ${bilan.deja}`)
  log(`sans payload brut    : ${bilan.sansRaw}`)
  log(`provider inconnu     : ${bilan.sansProvider}`
    + (bilan.sansProvider ? '  ⚠ lancer scripts/backfill-snapshot-provider.js d\'abord' : ''))
  log(`payload sans adresse : ${bilan.sansAdresse}`)
  log(`mapping en echec     : ${bilan.echecs}`)
  log(`A POSER              : ${bilan.aPoser}`)
  console.log('')
  log('par source :', JSON.stringify(bilan.parSource))

  // Le detail des Offline : ce sont elles que le chantier sert.
  const offline = aEcrire.filter(x => /offline/i.test(String(x.l.snapshot?.source || '')))
  if (offline.length) {
    console.log('')
    log(`dont ${offline.length} Offline :`)
    for (const x of offline) {
      log(`  ${x.l.booking_id.slice(0, 8)} ${x.l.snapshot.arrival}->${x.l.snapshot.departure} ${masque(x.email)}`)
    }
  }

  if (!EXECUTE) {
    console.log('')
    log('DRY RUN termine. Relancer avec --execute pour ecrire.')
    return
  }

  console.log('')
  for (const { l, provider, email } of aEcrire) {
    const r = await saveBookingSnapshot(supabase, {
      userId:     l.user_id,
      bookingId:  l.booking_id,
      propertyId: l.property_id,
      provider,
      // Le snapshot MINIMAL : le merge non destructif ne touchera que guestEmail.
      snapshot:   { provider, guestEmail: email },
      existing:   l.snapshot || null,
      existingPropertyId: l.property_id,
      existingRawHash:    l.raw_hash ?? null,
      // Voir l'en-tete : ceinture, pour un evenement qui ne devrait pas naitre.
      initialImport: true
    })
    if (r.ok && !r.inchange) bilan.ecrites++
    else if (!r.ok) {
      bilan.echecs++
      log(`⚠ ecriture refusee ${l.booking_id} : ${r.reason || 'inconnue'}`)
    }
    // Une garde, pas une decoration : si le writer produisait un evenement ici,
    // le dispatcher le consommerait au prochain cycle — menage, code, message.
    if (r.change) {
      // Marque DEJA traite par `initialImport` : il ne partira nulle part. On
      // s'arrete quand meme — un evenement ici veut dire que le snapshot minimal
      // n'etait pas si minimal, et ca se comprend avant de continuer.
      log(`⚠⚠ EVENEMENT INATTENDU sur ${l.booking_id} : ${r.change.type}. `
        + 'Materialise sans distribution (initialImport), mais le backfill ne doit '
        + 'RIEN produire — arret.')
      process.exit(1)
    }
  }

  console.log('')
  log(`ecrites : ${bilan.ecrites} / ${bilan.aPoser}`)
  log(`echecs  : ${bilan.echecs}`)
}

main().catch(e => { console.error('ERREUR', e.message); process.exit(1) })
