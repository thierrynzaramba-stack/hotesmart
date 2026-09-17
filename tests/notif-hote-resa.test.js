// tests/notif-hote-resa.test.js
// « Vous avez une nouvelle reservation » — l'e-mail a l'HOTE.
//
// CE QUE CES TESTS DEFENDENT :
//   - une reservation OTA ne declenche RIEN (les plateformes notifient deja) ;
//   - l'hote est prevenu une fois, jamais deux ;
//   - une lecture en echec n'est pas « pas de destinataire » ;
//   - et ce qui manque au voyageur est dit A L'HOTE, quand il peut encore agir.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const etat = { profil: null, erreurProfil: null, erreurLog: null, envois: [], logs: [],
               reponseEnvoi: null, plateforme: [], reponsePlateforme: null, suppressions: [] }

const origine = Module._load
Module._load = function (d, ...reste) {
  if (d === './cron-shared') return {
    supabase: {
      from (table) {
        const b = {
          select: () => b, eq: () => b,
          maybeSingle: async () => table === 'profiles'
            ? { data: etat.profil, error: etat.erreurProfil }
            : { data: null, error: null },
          insert: async (row) => { etat.logs.push(row); return { error: etat.erreurLog } },
          // `delete().eq().eq().eq()` : le dernier maillon est attendable.
          delete () { etat.suppressions.push(table); return b },
          then (resoudre) { return Promise.resolve({ error: null }).then(resoudre) }
        }
        return b
      }
    }
  }
  if (d === './email-guestflow') return {
    envoyerHtml: async o => { etat.envois.push(o); return etat.reponseEnvoi || { ok: true } }
  }
  if (d === './platform-notify') return {
    sendPlatformEmail: async (to, sujet, html) => {
      etat.plateforme.push({ to, sujet, html })
      return etat.reponsePlateforme || { ok: true }
    }
  }
  return origine.apply(this, [d, ...reste])
}

const { notifierNouvelleResa, corps, sujet, SENTINELLE } = require('../lib/notif-hote-resa')
test.after(() => { Module._load = origine })

const SNAP = {
  source: 'Offline', status: 'confirmed',
  firstName: 'Marie', lastName: 'Durand',
  guestEmail: 'marie@exemple.test', guestPhone: '+33600000000',
  arrival: '2026-10-02', departure: '2026-10-05',
  numAdult: 2, numChild: 1, amount: 450, currency: 'EUR',
  otaReservationCode: 'HS-123'
}
const APPEL = { userId: 'compte-A', bookingId: 'b-1', propertyId: 'prop-1',
                bien: 'La bulle', snapshot: SNAP, politique: 'flexible_j2' }

function remise (o = {}) {
  etat.profil = o.profil !== undefined ? o.profil
    : { email: 'hote@exemple.test', notify_email: true, active: true }
  etat.erreurProfil = o.erreurProfil || null
  etat.erreurLog = o.erreurLog || null
  etat.reponseEnvoi = o.reponseEnvoi || null
  etat.reponsePlateforme = o.reponsePlateforme || null
  etat.envois = []; etat.logs = []; etat.plateforme = []; etat.suppressions = []
}

// ─── Offline seulement ──────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : une reservation OTA ne declenche RIEN', async () => {
  // Les plateformes notifient deja. Doubler, c'est apprendre a ignorer les deux.
  for (const source of ['AirBNB', 'BookingCom', 'booking', 'airbnb', 'direct', '']) {
    remise()
    const r = await notifierNouvelleResa({ ...APPEL, snapshot: { ...SNAP, source } })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.ignore, true, `source ${source}`)
    assert.strictEqual(etat.envois.length, 0)
    assert.strictEqual(etat.logs.length, 0, 'et rien n\'est journalise non plus')
  }
})

test('Offline, quelle que soit la casse', async () => {
  remise()
  const r = await notifierNouvelleResa({ ...APPEL, snapshot: { ...SNAP, source: ' OFFLINE ' } })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(etat.envois.length, 1)
})

// ─── Le destinataire ────────────────────────────────────────────────────────
test('l\'e-mail part au proprietaire, par la cle de SON compte', async () => {
  remise()
  await notifierNouvelleResa(APPEL)
  assert.strictEqual(etat.envois.length, 1)
  assert.strictEqual(etat.envois[0].destinataire, 'hote@exemple.test')
  assert.strictEqual(etat.envois[0].userId, 'compte-A')
})

test('LE TEST QUI COMPTE : un profil illisible n\'est PAS « pas de destinataire »', async () => {
  // Fail-closed : sur une panne, on rend l'erreur — personne ne doit croire que
  // l'hote a ete prevenu.
  remise({ erreurProfil: { message: 'timeout' } })
  const r = await notifierNouvelleResa(APPEL)
  assert.strictEqual(r.ok, false)
  assert.ok(/timeout/.test(r.raison))
  assert.strictEqual(etat.envois.length, 0)
})

test('un refus de notification est respecte, et n\'est PAS une panne', async () => {
  remise({ profil: { email: 'hote@x.fr', notify_email: false, active: true } })
  const r = await notifierNouvelleResa(APPEL)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.ignore, true, 'aucun incident ne doit naitre d\'un choix de l\'hote')
  assert.strictEqual(etat.envois.length, 0)
})

test('profil desactive ou sans adresse : echec dit, pas silence', async () => {
  for (const profil of [{ email: 'x@y.fr', active: false }, { email: null, active: true }]) {
    remise({ profil })
    const r = await notifierNouvelleResa(APPEL)
    assert.strictEqual(r.ok, false)
    assert.ok(r.raison)
  }
})

// ─── La dédup ───────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : le journal est pose AVANT l\'envoi', async () => {
  // Pose apres, deux cycles qui se croisent enverraient deux fois. La base
  // tranche, pas notre vigilance.
  remise()
  await notifierNouvelleResa(APPEL)
  assert.strictEqual(etat.logs.length, 1)
  assert.strictEqual(etat.logs[0].template_id, SENTINELLE,
    'un UUID sentinelle occupe la colonne : l\'index unique fait la dedup')
  assert.strictEqual(etat.logs[0].booking_id, 'b-1')
})

test('LE TEST QUI COMPTE : une seconde tentative n\'envoie rien', async () => {
  // 23505 = l'index unique a tranche une course que le SELECT n'aurait pas vue.
  remise({ erreurLog: { code: '23505', message: 'duplicate key' } })
  const r = await notifierNouvelleResa(APPEL)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.deja, true)
  assert.strictEqual(etat.envois.length, 0, 'l\'hote n\'est pas prevenu deux fois')
})

test('un journal en panne (hors 23505) arrete tout', async () => {
  remise({ erreurLog: { code: '42P01', message: 'relation does not exist' } })
  const r = await notifierNouvelleResa(APPEL)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(etat.envois.length, 0, 'sans dedup possible, on n\'envoie pas')
})

// ─── Le contenu ─────────────────────────────────────────────────────────────
test('le sujet porte le bien et les dates', () => {
  assert.strictEqual(sujet({ bien: 'La bulle', arrival: '2026-10-02', departure: '2026-10-05' }),
    'Nouvelle réservation — La bulle — 02/10/2026 au 05/10/2026')
})

test('le corps porte tout ce qu\'il faut pour agir sans ouvrir un ecran', () => {
  const h = corps({ bien: 'La bulle', firstName: 'Marie', lastName: 'Durand',
    guestEmail: 'marie@exemple.test', guestPhone: '+33600000000',
    arrival: '2026-10-02', departure: '2026-10-05', numAdult: 2, numChild: 1,
    amount: 450, currency: 'EUR', politique: 'flexible_j2', reference: 'HS-123' })
  for (const attendu of ['Marie Durand', 'marie@exemple.test', '+33600000000',
                         '02/10/2026', '05/10/2026', '2 adultes, 1 enfant',
                         '450 EUR', 'HS-123', 'Annulation gratuite']) {
    assert.ok(h.includes(attendu), `manque : ${attendu}`)
  }
  assert.ok(h.includes('3'), 'le nombre de nuits')
})

test('LE TEST QUI COMPTE : l\'absence d\'adresse est dite A L\'HOTE', () => {
  // C'est le pendant du badge : il l'apprend quand il peut encore appeler son
  // voyageur, pas le jour de l'arrivee devant une porte fermee.
  const h = corps({ bien: 'La bulle', firstName: 'Marie', arrival: '2026-10-02',
    departure: '2026-10-05', guestEmail: null })
  assert.ok(/Pas d’adresse e-mail/.test(h))
  assert.ok(/code d’accès/.test(h), 'et ce qui ne partira pas')
})

test('un champ absent ne laisse pas « undefined » dans l\'e-mail', () => {
  const h = corps({ bien: 'X', arrival: '2026-10-02', departure: '2026-10-03' })
  assert.ok(!/undefined|null|NaN/.test(h), h.slice(0, 200))
})

test('le corps echappe ce qui vient du voyageur', () => {
  const h = corps({ bien: 'X', firstName: '<script>alert(1)</script>',
    arrival: '2026-10-02', departure: '2026-10-03' })
  assert.ok(!/<script>/.test(h))
  assert.ok(/&lt;script&gt;/.test(h))
})

// ─── Le repli plateforme ────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un hote sans Brevo est prevenu QUAND MEME', async () => {
  // Sans repli, l'hote qui n'a jamais connecte Brevo n'aurait JAMAIS ete prevenu
  // de ses ventes directes — exactement le manque que cette fonction comble —
  // pendant que le fondateur recevait un SMS a chaque vente.
  // Et ici la marque blanche ne protege rien : le destinataire est l'hote, qui
  // sait parfaitement ce qu'est HoteSmart.
  remise({ reponseEnvoi: { ok: false, raison: 'brevo_non_configure', permanent: true } })
  const r = await notifierNouvelleResa(APPEL)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.canal, 'plateforme')
  assert.strictEqual(etat.plateforme.length, 1)
  assert.strictEqual(etat.plateforme[0].to, 'hote@exemple.test')
  assert.ok(/Nouvelle réservation/.test(etat.plateforme[0].sujet))
})

test('LE TEST QUI COMPTE : les deux canaux muets + echec TRANSITOIRE -> le journal est retire', async () => {
  // Un quota Brevo se retablit a minuit. Sans ce geste, la sentinelle
  // condamnerait l'annonce pour toujours, rattrapage manuel compris.
  remise({ reponseEnvoi: { ok: false, raison: 'brevo_429', permanent: false },
           reponsePlateforme: { ok: false, error: 'quota plateforme' } })
  const r = await notifierNouvelleResa(APPEL)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(etat.suppressions.length, 1, 'la ligne de journal est retiree')
})

test('les deux canaux muets + echec PERMANENT -> le journal RESTE', async () => {
  // Rien ne sert de reessayer ce qui ne peut pas marcher.
  remise({ reponseEnvoi: { ok: false, raison: 'destinataire_manquant', permanent: true },
           reponsePlateforme: { ok: false, error: 'destinataire manquant' } })
  const r = await notifierNouvelleResa(APPEL)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(etat.suppressions.length, 0)
})

// ─── Jamais d'exception vers le dispatcher ──────────────────────────────────
test('un echec des deux canaux remonte en { ok:false }, jamais en exception', async () => {
  remise({ reponseEnvoi: { ok: false, raison: 'brevo_400', permanent: true },
           reponsePlateforme: { ok: false, error: 'plateforme muette' } })
  const r = await notifierNouvelleResa(APPEL)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.permanent, true)
  assert.ok(/brevo_400/.test(r.raison) && /plateforme/.test(r.raison),
    'les deux causes sont dites, pas seulement la derniere')
})
