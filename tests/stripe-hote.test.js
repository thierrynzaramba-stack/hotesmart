// tests/stripe-hote.test.js
// Spec : docs/specs/spec-moteur-reservation.md §3 bis et §5.1
//
// CE QUE CES TESTS DEFENDENT : les trois exigences gravees.
//   1. cles chiffrees, jamais loguees, jamais reaffichees
//   2. onboarding vers des cles RESTREINTES
//   3. webhook cree automatiquement — avec un repli VISIBLE, jamais silencieux
//
// Stripe est simule : ces tests ne joignent aucun reseau.

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')
const Module = require('node:module')

process.env.BOOKING_SECRET_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')
process.env.APP_URL = 'https://exemple.test'
process.env.SUPABASE_URL = 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = 'test'

// ─── Faux Stripe ────────────────────────────────────────────────────────────
const stripeEtat = { listeErreur: null, webhookErreur: null, webhooks: [], supprimes: [], cles: [] }

class FauxStripe {
  constructor (cle) { this.cle = cle; stripeEtat.cles.push(cle) }
  get paymentIntents () {
    return { list: async () => {
      if (stripeEtat.listeErreur) { const e = new Error('refus'); e.statusCode = stripeEtat.listeErreur; throw e }
      return { data: [] }
    } }
  }
  get webhookEndpoints () {
    return {
      create: async (opts) => {
        if (stripeEtat.webhookErreur) { const e = new Error('refus'); e.statusCode = stripeEtat.webhookErreur; throw e }
        const w = { id: 'we_' + stripeEtat.webhooks.length, secret: 'whsec_' + 'S'.repeat(32), url: opts.url, events: opts.enabled_events }
        stripeEtat.webhooks.push(w); return w
      },
      del: async (id) => { stripeEtat.supprimes.push({ id, cle: this.cle }); return { deleted: true } }
    }
  }
}

const origine = Module._load
Module._load = function (d) { return d === 'stripe' ? FauxStripe : origine.apply(this, arguments) }
const S = require('../lib/stripe-hote')
const C = require('../lib/chiffrement')
Module._load = origine

// ─── Fausse base ────────────────────────────────────────────────────────────
const base = { lignes: [] }
function table () {
  const q = { filtres: {} }
  const chaine = {
    select () { return chaine },
    eq (c, v) { q.filtres[c] = v; return chaine },
    async maybeSingle () {
      const l = base.lignes.find(x => Object.entries(q.filtres).every(([c, v]) => x[c] === v))
      return { data: l || null, error: null }
    },
    upsert (ligne) {
      const i = base.lignes.findIndex(x => x.user_id === ligne.user_id)
      if (i >= 0) base.lignes[i] = { ...base.lignes[i], ...ligne }
      else base.lignes.push({ id: 'row' + base.lignes.length, created_at: 'now', ...ligne })
      q.dernier = base.lignes.find(x => x.user_id === ligne.user_id)
      return chaine
    },
    update (maj) { q.maj = maj; return chaine },
    delete () { q.suppr = true; return chaine },
    then (res) {
      if (q.suppr) { base.lignes = base.lignes.filter(x => !Object.entries(q.filtres).every(([c, v]) => x[c] === v)); return res({ error: null }) }
      if (q.maj) {
        // `.update(...).select('id')` doit rendre les lignes TOUCHEES : c'est ce
        // qui permet de distinguer « mis a jour » de « aucune ligne ne
        // correspondait ». Le harnais le rendait toujours vide, ce qui masquait
        // le correctif.
        const touchees = base.lignes.filter(x => Object.entries(q.filtres).every(([c, v]) => x[c] === v))
        touchees.forEach(x => Object.assign(x, q.maj))
        return res({ data: touchees, error: null })
      }
      return res({ data: q.dernier || null, error: null })
    }
  }
  // `.upsert(...).select('*').maybeSingle()` doit rendre la ligne ecrite.
  const vrai = chaine.maybeSingle
  chaine.maybeSingle = async () => (q.dernier ? { data: q.dernier, error: null } : vrai())
  return chaine
}
const supabase = { from: table }

const CLE_RK = 'rk_test_' + 'a'.repeat(90)
const CLE_SK = 'sk_test_' + 'b'.repeat(90)
const HOTE = 'uuid-hote'

function reinit () {
  base.lignes = []
  stripeEtat.listeErreur = null; stripeEtat.webhookErreur = null
  stripeEtat.webhooks = []; stripeEtat.supprimes = []; stripeEtat.cles = []
}

// ─── Exigence 2 : la cle est verifiee AVANT d etre stockee ─────────────────
test('une cle de mauvaise forme est refusee sans appeler Stripe', async () => {
  reinit()
  for (const mauvaise of ['', 'bonjour', 'rk_', 'ca_test_abc', 'rk_test_'] ) {
    const r = await S.verifierCle(mauvaise)
    assert.equal(r.ok, false, `« ${mauvaise} » aurait du etre refusee`)
  }
  assert.equal(stripeEtat.cles.length, 0, 'aucun appel Stripe ne doit partir')
})

test('les trois issues de Stripe sont distinguees, pas confondues', async () => {
  reinit()
  stripeEtat.listeErreur = 401
  assert.equal((await S.verifierCle(CLE_RK)).raison, 'cle_refusee')
  stripeEtat.listeErreur = 403
  assert.equal((await S.verifierCle(CLE_RK)).raison, 'droit_paiements_manquant')
  stripeEtat.listeErreur = 500
  assert.equal((await S.verifierCle(CLE_RK)).raison, 'stripe_injoignable')
})

test('une cle SECRETE complete est REFUSEE, sans appel a Stripe', async () => {
  // Decision gravee : un avertissement qu'on clique pour passer n'est pas une
  // protection. Une `sk_` donnerait a HoteSmart les pleins pouvoirs sur le
  // compte Stripe de l'hote.
  reinit()
  const r = await S.verifierCle(CLE_SK)
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'cle_non_restreinte')
  assert.equal(stripeEtat.cles.length, 0, 'la cle refusee ne doit meme pas partir sur le reseau')

  assert.equal((await S.verifierCle('sk_live_' + 'z'.repeat(90))).raison, 'cle_non_restreinte')
  const rk = await S.verifierCle(CLE_RK)
  assert.equal(rk.ok, true)
  assert.equal(rk.restreinte, true)
})

test('une sk_ ne peut pas etre connectee, meme en forcant', async () => {
  reinit()
  const r = await S.connecter(supabase, HOTE, CLE_SK)
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'cle_non_restreinte')
  assert.equal(base.lignes.length, 0, 'rien ne doit etre ecrit')
  assert.equal(stripeEtat.webhooks.length, 0, 'aucun webhook ne doit etre cree')
})

test('le mode se lit dans le PREFIXE de la cle', async () => {
  reinit()
  assert.equal((await S.verifierCle(CLE_RK)).mode, 'test')
  assert.equal((await S.verifierCle('rk_live_' + 'c'.repeat(90))).mode, 'live')
})

// ─── Exigence 1 : rien en clair, rien de reaffiche ─────────────────────────
test('la cle est stockee CHIFFREE, jamais en clair', async () => {
  reinit()
  await S.connecter(supabase, HOTE, CLE_RK)
  const ligne = base.lignes[0]
  assert.ok(C.estChiffre(ligne.secret_key_cipher))
  assert.ok(C.estChiffre(ligne.webhook_secret_cipher))
  const brut = JSON.stringify(ligne)
  assert.ok(!brut.includes(CLE_RK), 'la cle apparait en clair dans la ligne')
  assert.ok(!brut.includes('whsec_SSSS'), 'le secret du webhook apparait en clair')
  assert.equal(C.dechiffrer(ligne.secret_key_cipher), CLE_RK)
})

test('la reponse de connexion ne contient AUCUN secret', async () => {
  reinit()
  const r = await S.connecter(supabase, HOTE, CLE_RK)
  const brut = JSON.stringify(r)
  assert.ok(!brut.includes(CLE_RK))
  assert.ok(!brut.includes('whsec_'))
  assert.ok(!brut.includes('v1:'), 'meme le chiffre ne doit pas sortir')
  assert.equal(r.etat.last4, CLE_RK.slice(-4))
  assert.equal(r.etat.mode, 'test')
})

test('etatPublic ne rend jamais qu un mode, 4 caracteres et un etat', () => {
  const e = S.etatPublic({
    secret_key_cipher: 'v1:a:b:c', webhook_secret_cipher: 'v1:d:e:f',
    key_last4: 'aaaa', mode: 'test', key_restricted: true,
    webhook_endpoint_id: 'we_1', webhook_url_token: 'z'.repeat(43), verified_at: 'hier'
  })
  const brut = JSON.stringify(e)
  assert.ok(!brut.includes('v1:'), 'le chiffre ne doit pas sortir')
  assert.ok(!brut.includes('z'.repeat(43)), 'le jeton d URL ne sort pas de lui-meme')
  assert.deepEqual(Object.keys(e).sort(),
    ['connecte', 'derniere_erreur', 'last4', 'mode', 'restreinte', 'verifie_le', 'webhook'].sort())
  assert.deepEqual(S.etatPublic(null), { connecte: false })
})

// ─── Exigence 3 : le webhook, et son repli VISIBLE ─────────────────────────
test('le webhook est cree automatiquement, sur l URL de l hote', async () => {
  reinit()
  await S.connecter(supabase, HOTE, CLE_RK)
  assert.equal(stripeEtat.webhooks.length, 1)
  const w = stripeEtat.webhooks[0]
  assert.match(w.url, /^https:\/\/exemple\.test\/api\/book-webhook\/[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(w.events, S.EVENEMENTS)
})

test('droit webhook manquant : la connexion ABOUTIT, le repli est VISIBLE', async () => {
  // Le point d incertitude signale dans la spec. Jamais de bascule silencieuse
  // vers une cle secrete complete.
  reinit()
  stripeEtat.webhookErreur = 403
  const r = await S.connecter(supabase, HOTE, CLE_RK)
  assert.equal(r.ok, true, 'l hote doit pouvoir avancer')
  assert.equal(base.lignes[0].last_error, 'droit_webhook_manquant')
  assert.equal(base.lignes[0].webhook_secret_cipher, null)
  assert.equal(r.webhook_manuel.raison, 'droit_webhook_manquant')
  assert.match(r.webhook_manuel.url, /\/api\/book-webhook\//)
  assert.deepEqual(r.webhook_manuel.evenements, S.EVENEMENTS)
  assert.equal(r.etat.webhook, 'manquant')
})

test('le secret colle a la main est chiffre, et sa forme est verifiee', async () => {
  reinit()
  stripeEtat.webhookErreur = 403
  await S.connecter(supabase, HOTE, CLE_RK)
  assert.equal((await S.poserSecretWebhookManuel(supabase, HOTE, 'pas-un-secret')).ok, false)
  const r = await S.poserSecretWebhookManuel(supabase, HOTE, 'whsec_' + 'K'.repeat(32))
  assert.equal(r.ok, true)
  assert.ok(C.estChiffre(base.lignes[0].webhook_secret_cipher))
  assert.equal(base.lignes[0].last_error, null)
})

// ─── Reconnexion : l ORDRE protege contre le webhook fantome ───────────────
test('remplacer une cle supprime l ancien webhook AVEC L ANCIENNE cle', async () => {
  // Une fois l ancienne cle ecrasee, l ancien webhook devient impossible a
  // supprimer, et il continue de livrer des evenements que plus aucun secret
  // ne verifie.
  reinit()
  await S.connecter(supabase, HOTE, CLE_RK)
  const ancienId = stripeEtat.webhooks[0].id
  const NOUVELLE = 'rk_test_' + 'n'.repeat(90)
  await S.connecter(supabase, HOTE, NOUVELLE)

  assert.equal(stripeEtat.supprimes.length, 1)
  assert.equal(stripeEtat.supprimes[0].id, ancienId)
  assert.equal(stripeEtat.supprimes[0].cle, CLE_RK, 'supprime avec l ANCIENNE cle')
  assert.equal(stripeEtat.webhooks.length, 2)
  assert.equal(C.dechiffrer(base.lignes[0].secret_key_cipher), NOUVELLE)
  assert.equal(base.lignes.length, 1, 'une seule ligne par hote')
})

test('le jeton d URL SURVIT a une reconnexion', async () => {
  // Le changer sans raison invaliderait une URL deja enregistree ailleurs.
  reinit()
  await S.connecter(supabase, HOTE, CLE_RK)
  const jeton = base.lignes[0].webhook_url_token
  await S.connecter(supabase, HOTE, 'rk_test_' + 'n'.repeat(90))
  assert.equal(base.lignes[0].webhook_url_token, jeton)
})

// ─── Lecture pour usage, et routage du webhook ─────────────────────────────
test('cleDeLHote rend la cle en clair — le seul chemin qui le fait', async () => {
  reinit()
  await S.connecter(supabase, HOTE, CLE_RK)
  const r = await S.cleDeLHote(supabase, HOTE)
  assert.equal(r.ok, true)
  assert.equal(r.cle, CLE_RK)
  assert.equal((await S.cleDeLHote(supabase, 'inconnu')).raison, 'non_connecte')
})

test('une ligne indechiffrable REFUSE d encaisser, elle ne devine pas', async () => {
  reinit()
  await S.connecter(supabase, HOTE, CLE_RK)
  base.lignes[0].secret_key_cipher = 'v1:AAAA:BBBB:CCCC'
  const r = await S.cleDeLHote(supabase, HOTE)
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'secret_illisible')
})

test('le secret du webhook se retrouve par le jeton de l URL', async () => {
  // Un webhook pose sur le compte propre d un hote ne porte AUCUN identifiant
  // de compte : seule l URL dit de qui il s agit.
  reinit()
  await S.connecter(supabase, HOTE, CLE_RK)
  const jeton = base.lignes[0].webhook_url_token
  const r = await S.secretWebhookParJeton(supabase, jeton)
  assert.equal(r.ok, true)
  assert.match(r.secret, /^whsec_/)
  assert.equal(r.ligne.user_id, HOTE)
  assert.equal((await S.secretWebhookParJeton(supabase, 'court')).raison, 'jeton_invalide')
  assert.equal((await S.secretWebhookParJeton(supabase, 'q'.repeat(43))).raison, 'jeton_inconnu')
})

// ─── Deconnexion ────────────────────────────────────────────────────────────
test('deconnecter supprime le webhook chez l hote AVANT d effacer la ligne', async () => {
  reinit()
  await S.connecter(supabase, HOTE, CLE_RK)
  await S.deconnecter(supabase, HOTE)
  assert.equal(stripeEtat.supprimes.length, 1, 'un webhook orphelin frapperait une URL morte')
  assert.equal(base.lignes.length, 0)
  assert.equal((await S.deconnecter(supabase, HOTE)).deja, true)
})

// ─── L URL de base ──────────────────────────────────────────────────────────
test('un slash final dans APP_URL ne peut pas produire une double barre', async () => {
  const avant = process.env.APP_URL
  process.env.APP_URL = 'https://exemple.test///'
  assert.equal(S.urlWebhook('z'.repeat(43)), 'https://exemple.test/api/book-webhook/' + 'z'.repeat(43))
  process.env.APP_URL = avant
})


// ─── CONSTAT DE REVIEW : ne pas effacer un secret qui marche ───────────────
test('reconnecter n EFFACE PAS le secret de webhook colle a la main', () => {
  // Scenario reel : creation auto refusee, l hote cree le webhook lui-meme et
  // colle son whsec_. Il fait tourner sa cle et se reconnecte. L ancien endpoint
  // survit chez Stripe (on n a pas son id), mais l upsert remettait le secret a
  // null : les paiements aboutissaient, plus aucun evenement n etait verifiable,
  // la tentative restait `pending` et AUCUNE alarme ne partait.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib/stripe-hote.js'), 'utf8')
  assert.match(src, /webhook_secret_cipher: w\.ok \? chiffrer\(w\.secret\)/)
  assert.match(src, /existante \? existante\.webhook_secret_cipher : null/)
})

test('le secret manuel refuse quand AUCUN compte n existe', async () => {
  // `.update()` sur zero ligne ne leve pas : la fonction annoncait « secret
  // enregistre, la confirmation est branchee » alors que rien n avait ete ecrit.
  reinit()
  base.lignes = []
  const r = await S.poserSecretWebhookManuel(supabase, 'inconnu', 'whsec_' + 'K'.repeat(32))
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'non_connecte')
})
