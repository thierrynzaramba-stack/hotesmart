// tests/confirmation-hote.test.js
// Etape 5 du chantier « canal e-mail pour les reservations directes ».
//
// CE QUE CES TESTS DEFENDENT :
//   1. la confirmation de reservation part SOUS L'IDENTITE DE L'HOTE ;
//   2. mais elle PART TOUJOURS — un voyageur qui vient de payer ne doit jamais
//      se retrouver sans preuve que sa reservation existe ;
//   3. et quand elle repart sous l'enseigne de la plateforme, l'hote l'APPREND.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const etat = { hote: null, plateforme: [], incidents: [] }

const origine = Module._load
Module._load = function (d, ...reste) {
  if (d === './email-guestflow') return {
    envoyerHtmlVoyageur: async o => {
      etat.hote = o
      if (etat.leveHote) throw new Error('supabase injoignable')
      return etat.reponseHote || { ok: true, id: 'msg-hote' }
    }
  }
  if (d === './platform-notify') return {
    sendPlatformEmail: async (to, sujet, html) => {
      etat.plateforme.push({ to, sujet, html })
      return etat.reponsePlateforme || { ok: true }
    }
  }
  if (d === './founder-notify') return {
    reportIncident: async (type, o) => { etat.incidents.push({ type, ...o }) }
  }
  return origine.apply(this, [d, ...reste])
}

const { envoyerConfirmation, envoyerRemboursement } = require('../lib/email-voyageur')
test.after(() => { Module._load = origine })

const RESA = {
  userId: 'compte-A', propertyId: 'bien-1',
  email: 'voyageur@exemple.test', prenom: 'Marie', lang: 'fr',
  bien: 'La bulle', arrivee: '2099-07-01', depart: '2099-07-05', nuits: 4,
  voyageurs: 2, total: '450.00 EUR', politique: 'j7', reference: 'HS-123'
}
const remise = () => { etat.hote = null; etat.plateforme = []; etat.incidents = []
                       etat.reponseHote = null; etat.reponsePlateforme = null
                       etat.leveHote = false }

// ─── Le chemin nominal ──────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : la confirmation part par le canal de l\'HOTE', async () => {
  remise()
  const r = await envoyerConfirmation(RESA)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.canal, 'hote')
  assert.strictEqual(etat.hote.userId, 'compte-A', 'sa clé Brevo, son adresse')
  assert.strictEqual(etat.hote.destinataire, 'voyageur@exemple.test')
  assert.strictEqual(etat.plateforme.length, 0, 'la plateforme n\'est pas sollicitée')
})

test('le bien accompagne l\'envoi, pour qu\'un quota s\'annonce avec lui', async () => {
  remise()
  await envoyerConfirmation(RESA)
  assert.strictEqual(etat.hote.propertyId, 'bien-1')
  assert.strictEqual(etat.hote.propertyName, 'La bulle')
})

test('le corps reste celui qu\'il etait : trilingue, en marque blanche', async () => {
  remise()
  await envoyerConfirmation({ ...RESA, lang: 'es' })
  assert.ok(/Su reserva en La bulle está confirmada/.test(etat.hote.sujet),
    'la langue est celle de la tentative, pas celle du serveur')
  assert.ok(/La bulle/.test(etat.hote.html))
  assert.ok(!/h[oô]tesmart/i.test(etat.hote.html), 'aucune mention de la plateforme')
})

test('le remboursement emprunte le meme canal', async () => {
  remise()
  const r = await envoyerRemboursement(RESA)
  assert.strictEqual(r.canal, 'hote')
  assert.ok(/n’a pas pu être confirmée/.test(etat.hote.sujet))
})

// ─── Le repli, et pourquoi il existe ────────────────────────────────────────
test('LE TEST QUI COMPTE : sans compte Brevo, la confirmation PART QUAND MEME', async () => {
  // Ce message n'est pas un message de parcours : c'est la preuve qu'un PAIEMENT
  // a abouti. Ne pas le delivrer laisse un voyageur qui vient de payer sans rien
  // — ni dates, ni contact. C'est pire qu'une enveloppe a la mauvaise enseigne.
  remise()
  etat.reponseHote = { ok: false, raison: 'brevo_non_configure', permanent: true }
  const r = await envoyerConfirmation(RESA)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.canal, 'plateforme')
  assert.strictEqual(etat.plateforme.length, 1)
  assert.strictEqual(etat.plateforme[0].to, 'voyageur@exemple.test')
})

test('LE TEST QUI COMPTE : ce repli n\'est PAS un silence', async () => {
  // ⚠ L'alerte part au FONDATEUR, pas a l'hote : `reportIncident` notifie
  // FOUNDER_EMAIL/PHONE et aucun ecran ne sert `automation_incidents` a l'hote.
  // C'est une limite connue, ecrite au KB — pas un filet qu'on imagine.
  remise()
  etat.reponseHote = { ok: false, raison: 'aucun_expediteur_verifie', permanent: true }
  await envoyerConfirmation(RESA)
  const inc = etat.incidents.find(i => i.type === 'email_confirmation_repli')
  assert.ok(inc, 'un incident est enregistre')
  assert.strictEqual(inc.userId, 'compte-A')
  assert.strictEqual(inc.threshold, 1, 'il est dit des la premiere fois')
  assert.ok(/aucun_expediteur_verifie/.test(inc.detail), 'avec la cause')
  assert.ok(/Connexions/.test(inc.detail), 'et le geste a faire')
  assert.ok(/est PARTIE/.test(inc.detail), 'et ce qui s\'est reellement passe')
})

test('LE TEST QUI COMPTE : une exception du canal hote ne prive PAS du repli', async () => {
  // Sous un `try` commun, une lecture Supabase en panne pendant le webhook Stripe
  // sautait au catch final : le repli n'etait jamais tente et le voyageur, qui
  // venait de payer, ne recevait rien — alors qu'avant ce chantier la plateforme
  // envoyait. On aurait casse l'invariant que cette etape pretend defendre.
  remise()
  etat.leveHote = true
  const r = await envoyerConfirmation(RESA)
  etat.leveHote = false
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.canal, 'plateforme')
  assert.strictEqual(etat.plateforme.length, 1)
})

test('LE TEST QUI COMPTE : une issue INCERTAINE ne se rejoue pas', async () => {
  // La connexion a ete coupee en cours d'appel : le message a PEUT-ETRE ete
  // accepte. Replier enverrait une seconde confirmation pour un seul paiement —
  // et deux confirmations peuvent se lire comme deux reservations.
  remise()
  etat.reponseHote = { ok: false, raison: 'brevo_injoignable: ECONNRESET',
                       permanent: false, incertain: true }
  const r = await envoyerConfirmation(RESA)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.incertain, true)
  assert.strictEqual(etat.plateforme.length, 0, 'aucun second envoi')
  const inc = etat.incidents.find(i => i.type === 'email_confirmation_repli')
  assert.ok(/PEUT-ETRE/.test(inc.detail), 'et l\'incertitude est dite telle quelle')
})

test('LE TEST QUI COMPTE : quand RIEN ne part, l\'alerte ne dit pas le contraire', async () => {
  // Posee avant l'envoi, elle affirmait « la confirmation est partie sous
  // l'identite HoteSmart » — y compris quand la plateforme echouait a son tour.
  // Une alerte qui se trompe de fait est pire qu'une alerte absente.
  remise()
  etat.reponseHote = { ok: false, raison: 'brevo_non_configure', permanent: true }
  etat.reponsePlateforme = { ok: false, error: 'quota plateforme' }
  await envoyerConfirmation(RESA)
  const inc = etat.incidents.find(i => i.type === 'email_confirmation_repli')
  assert.ok(/N'EST PAS PARTIE/.test(inc.detail))
  assert.ok(/a paye et n'a rien recu/.test(inc.detail), 'et ce que ca implique')
  assert.ok(!/est PARTIE, mais/.test(inc.detail))
})

test('la consigne suit la cause : pas de « reglez Brevo » sur une panne', async () => {
  remise()
  etat.reponseHote = { ok: false, raison: 'lecture_config_impossible', permanent: false }
  await envoyerConfirmation(RESA)
  const inc = etat.incidents.find(i => i.type === 'email_confirmation_repli')
  assert.ok(/Panne temporaire/.test(inc.detail))
  assert.ok(!/Reglez votre compte Brevo/.test(inc.detail),
    'envoyer reparer ce qui n\'est pas casse est du bruit')
})

test('un quota Brevo ne produit pas un SECOND incident', async () => {
  // Il a deja son signalement propre dans lib/email-guestflow.js.
  remise()
  etat.reponseHote = { ok: false, raison: 'brevo_429: daily limit', permanent: false, quota: true }
  await envoyerConfirmation(RESA)
  assert.strictEqual(etat.plateforme.length, 1, 'la confirmation part quand meme')
  assert.strictEqual(etat.incidents.length, 0, 'mais sans doublon d\'alerte')
})

test('les deux canaux en echec : on rend faux, sans jamais lever', async () => {
  // La reservation existe chez le provider : un e-mail rate n'est pas une
  // reservation a defaire.
  remise()
  etat.reponseHote = { ok: false, raison: 'brevo_non_configure', permanent: true }
  etat.reponsePlateforme = { ok: false, error: 'quota plateforme' }
  const r = await envoyerConfirmation(RESA)
  assert.strictEqual(r.ok, false)
  assert.ok(/quota plateforme/.test(r.raison))
})

test('sans compte propriétaire connu, le repli plateforme joue directement', async () => {
  // Cas des appelants qui ne fournissent pas encore `userId` : on ne devine pas
  // un compte pour envoyer sur la cle de quelqu'un d'autre.
  remise()
  const r = await envoyerConfirmation({ ...RESA, userId: null })
  assert.strictEqual(r.canal, 'plateforme')
  assert.strictEqual(etat.hote, null, 'aucun envoi tenté sur un compte inconnu')
  assert.strictEqual(etat.incidents.length, 0, 'et pas d\'incident : rien n\'a échoué')
})

// ─── Le moteur passe bien le compte ─────────────────────────────────────────
const fs = require('node:fs')
const path = require('node:path')
test('le moteur de reservation transmet le compte et le bien', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/moteur-creation.js'), 'utf8')
  const bloc = src.split('async function prevenirVoyageur')[1].slice(0, 1600)
  assert.ok(/userId: t\.user_id/.test(bloc), 'le compte proprietaire')
  assert.ok(/propertyId: bien \? bien\.id : null/.test(bloc), 'et le bien')
})
