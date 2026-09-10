// tests/empreinte-sejour-messages.test.js
// NE JAMAIS RENVOYER UN MESSAGE DEJA RECU — demande de Thierry.
//
// Le defaut, mesure le 10 septembre 2026 : l'anti-doublon des messages
// programmes est `(user_id, booking_id, template_id)`. Au remapping d'un
// logement, l'OTA rend ses sejours a venir avec de NOUVEAUX identifiants : le
// journal ne les reconnait pas, et 13 messages DEJA RECUS repartaient aux
// voyageurs des 11 sejours a venir des deux biens de Bagneres.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// `cron-messages` charge `cron-shared`, qui construit un client Supabase a
// l'import : sans ces variables, le seul `require` jette.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const { codeOtaBrut } = require('../lib/bookings-snapshot')

const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

// ─── L'empreinte elle-meme ──────────────────────────────────────────────────

test('LE TEST QUI COMPTE : l empreinte est le code OTA, identique des deux cotes', () => {
  // Beds24 l'appelle `apiReference`, Channex `ota_reservation_code`, le snapshot
  // `otaReservationCode`. C'est le MEME code chez l'OTA — le plan de bascule
  // fonde sa reconciliation dessus, et les avis voyageurs leur rattachement.
  assert.equal(codeOtaBrut({ apiReference: 'HMXJPMDJEN' }), 'HMXJPMDJEN')
  assert.equal(codeOtaBrut({ ota_reservation_code: '5917242568' }), '5917242568')
  assert.equal(codeOtaBrut({ otaReservationCode: 'HM4TMX5QXQ' }), 'HM4TMX5QXQ')
})

test('l empreinte est normalisee : le meme code doit se reconnaitre', () => {
  // Ecrite a l'envoi et relue au remapping : si l'une des deux normalise et pas
  // l'autre, la garde ne reconnait rien et le message repart.
  assert.equal(codeOtaBrut({ apiReference: '  hmxjpmdjen  ' }), 'HMXJPMDJEN')
  assert.equal(codeOtaBrut({ apiReference: 'HmXjPmDjEn' }), 'HMXJPMDJEN')
})

test('une reservation DIRECTE porte SON code, et c est bien ainsi', () => {
  // `api/reservation-directe.js` et `lib/moteur-creation.js` posent tous deux un
  // `otaReservationCode` (HS-… / HSM-…), unique par sejour. Il devient donc une
  // empreinte comme une autre — la doc disait le contraire, c'etait faux.
  assert.equal(codeOtaBrut({ otaReservationCode: 'HS-2026-0912-AB' }), 'HS-2026-0912-AB')
  // Et sans aucun code, la garde par `booking_id` suffit : aucun OTA ne
  // reimportera ce sejour.
  assert.equal(codeOtaBrut({}), null)
  assert.equal(codeOtaBrut({ apiReference: '' }), null)
  assert.equal(codeOtaBrut({ apiReference: '   ' }), null)
  assert.equal(codeOtaBrut(null), null)
})

// ─── La garde dans le moteur d'envoi ────────────────────────────────────────

test('LE TEST QUI COMPTE : le moteur verifie l empreinte EN PLUS de l identifiant', () => {
  const src = lire('lib/cron-messages.js')
  assert.ok(src.includes("const empreinte = codeOtaBrut(booking)"), 'l empreinte est calculee')
  assert.ok(/\.eq\('stay_key', empreinte\)/.test(src), 'et interrogee dans le journal')
  // La garde par identifiant reste : elle protege les reservations directes.
  assert.ok(/\.eq\('booking_id', bookingId\)/.test(src), 'la garde par identifiant subsiste')
})

test('LE TEST QUI COMPTE : UN SEUL chemin d ecriture du journal, et il porte l empreinte', () => {
  // Six points d'ecriture repartis sur deux fichiers, chacun a completer a la
  // main : un seul oubli, et le message de ce template repartira au remapping.
  // Ils passent desormais tous par `noterEnvoi`.
  for (const f of ['lib/cron-messages.js', 'lib/cron-arrival-code.js']) {
    const src = lire(f)
    const directs = src.split("from('message_sent_log')").slice(1)
      .filter(bloc => bloc.trimStart().startsWith('.upsert('))
    assert.equal(directs.length, f === 'lib/cron-messages.js' ? 2 : 0,
      `${f} : les ecritures doivent passer par noterEnvoi (${directs.length} upsert direct)`)
  }
  // Les deux upserts restants sont ceux DU helper (tentative + repli).
  const moteur = lire('lib/cron-messages.js')
  const helper = moteur.slice(moteur.indexOf('async function noterEnvoi'),
    moteur.indexOf('async function', moteur.indexOf('async function noterEnvoi') + 10))
  assert.ok(/stay_key: empreinte \|\| null/.test(helper), 'la tentative porte l empreinte')
  assert.ok(/upsert\(base, opts\)/.test(helper), 'et le repli s en passe')

  // Chaque appelant fournit une empreinte.
  for (const f of ['lib/cron-messages.js', 'lib/cron-arrival-code.js']) {
    const src = lire(f)
    const appels = src.split('noterEnvoi(supabase,').slice(1)
    assert.ok(appels.length, `${f} : aucun appel a noterEnvoi`)
    for (const a of appels) {
      assert.ok(/empreinte: codeOtaBrut\(/.test(a.slice(0, 320)),
        `${f} : un appel sans empreinte — ` + a.slice(0, 90))
    }
  }
})

test('LE TEST QUI COMPTE : un upsert refuse RETOMBE sans empreinte au lieu de ne rien ecrire', async () => {
  // Deployer ce code avant sa migration ferait rejeter l'upsert entier
  // (colonne absente du cache de schema) : le message vient d'etre envoye, et
  // rien ne le note — le voyageur le recevrait toutes les cinq minutes.
  const { noterEnvoi } = require('../lib/cron-messages')
  const tentes = []
  const faux = {
    from () { return faux },
    upsert: async (row) => {
      tentes.push(row)
      // La premiere tentative echoue, comme PostgREST sans la colonne.
      return tentes.length === 1
        ? { error: { message: "column message_sent_log.stay_key does not exist" } }
        : { error: null }
    }
  }
  const ok = await noterEnvoi(faux, { userId: 'u1', bookingId: '123', templateId: 't1', empreinte: 'HMX' })
  assert.equal(ok, true, 'l anti-doublon est ecrit malgre tout')
  assert.equal(tentes.length, 2, 'une tentative, puis un repli')
  assert.equal(tentes[0].stay_key, 'HMX')
  assert.equal(tentes[1].stay_key, undefined, 'le repli n envoie pas la colonne absente')
})

test('un echec TOTAL de l anti-doublon est hurle, pas avale', async () => {
  const { noterEnvoi } = require('../lib/cron-messages')
  const faux = {
    from () { return faux },
    upsert: async () => ({ error: { message: 'base injoignable' } })
  }
  const ok = await noterEnvoi(faux, { userId: 'u1', bookingId: '123', templateId: 't1', empreinte: 'HMX' })
  assert.equal(ok, false, 'l appelant peut le savoir')
  const src = lire('lib/cron-messages.js')
  assert.ok(/ECHEC TOTAL/.test(src))
  assert.ok(/LE MESSAGE PEUT REPARTIR AU PROCHAIN TICK/.test(src))
  assert.ok(/reportIncident/.test(src), 'et une alerte part')
})

test('LE TEST QUI COMPTE : les DEUX moteurs d envoi verifient l empreinte', () => {
  // C'est le defaut qui avait echappe au premier test : `triggerTemplates`
  // ECRIVAIT l empreinte sans jamais la LIRE. Le message de bienvenue
  // (`booking_confirmed`) serait reparti aux 11 voyageurs au remapping.
  const src = lire('lib/cron-messages.js')
  const gardes = src.match(/\.eq\('stay_key', empreinte(T)?\)/g) || []
  assert.equal(gardes.length, 2, `deux moteurs, deux gardes de lecture (vu ${gardes.length})`)
  // Et chaque garde laisse une trace : un envoi supprime doit se voir.
  const traces = src.match(/empreinte reconnue, envoi supprime/g) || []
  assert.equal(traces.length, 2)
})

test('LE TEST QUI COMPTE : le CODE D ARRIVEE verifie aussi l empreinte', () => {
  // C'est le message ou le defaut coute le plus cher : au remapping, un nouvel
  // identifiant ferait repartir un code d'acces au voyageur qui l'a deja.
  const src = lire('lib/cron-arrival-code.js')
  assert.ok(src.includes('const empreinte = codeOtaBrut(todayArrival)'))
  assert.ok(/\.eq\('stay_key', empreinte\)/.test(src))
})

// ─── Ce que la migration garantit ───────────────────────────────────────────

test('la colonne est ADDITIVE : les 632 lignes existantes continuent de fonctionner', () => {
  const sql = lire('migrations/2026-09-10-empreinte-sejour-messages.sql')
  assert.ok(/add column if not exists stay_key text/.test(sql))
  assert.ok(!/not null/i.test(sql.split('add column')[1].split(';')[0]),
    'la colonne est nullable : une ligne sans empreinte reste valide')
})

test('LE TEST QUI COMPTE : AUCUNE contrainte unique sur l empreinte', () => {
  // Une contrainte aurait transforme un doute en refus d'ecriture. Et deux
  // voyageurs peuvent legitimement partager un template : la garde est en
  // LECTURE, dans le code, ou on peut la nuancer.
  const sql = lire('migrations/2026-09-10-empreinte-sejour-messages.sql')
  assert.ok(!/create unique index/i.test(sql), 'index de lecture, pas d unicite')
  assert.ok(/create index if not exists message_sent_log_stay_key_idx/.test(sql))
})

// ─── Le rattrapage, qui est le vrai enjeu ───────────────────────────────────

test('LE TEST QUI COMPTE : le backfill applique la MEME normalisation qu a l envoi', () => {
  // Si le rattrapage ecrivait le code brut et l'envoi le code normalise, les
  // empreintes ne se reconnaitraient pas — et le backfill n'aurait servi a rien.
  const src = lire('scripts/backfill-empreinte-messages.js')
  assert.ok(src.includes("require('../lib/bookings-snapshot')"), 'meme helper')
  assert.ok(/codeOtaBrut\(\{ otaReservationCode:/.test(src))
})

test('le backfill est en DRY RUN par defaut', () => {
  const src = lire('scripts/backfill-empreinte-messages.js')
  assert.ok(/ECRIRE = process\.argv\.includes\('--ecrire'\)/.test(src))
  assert.ok(/Essai a blanc/.test(src))
})

test('le backfill dit ce qu il ne peut PAS remplir', () => {
  // Un rattrapage qui ne rend qu'un total laisse croire qu'il a tout couvert.
  const src = lire('scripts/backfill-empreinte-messages.js')
  assert.ok(/sejour introuvable/.test(src))
  assert.ok(/sejour sans code OTA/.test(src))
})
