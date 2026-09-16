// tests/email-guestflow.test.js
// Etape 3 du chantier « canal e-mail pour les reservations directes ».
//
// CE QUE CES TESTS DEFENDENT :
//   - la cle est celle de l'HOTE, jamais une cle plateforme ;
//   - le texte du template part tel quel, echappe, sans refonte ;
//   - un echec PERMANENT et un echec TRANSITOIRE ne se confondent jamais —
//     l'un abandonne et previent, l'autre repassera.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

// ─── Harnais ────────────────────────────────────────────────────────────────
const etat = { cles: {}, envois: [], reponseBrevo: null, senders: null, incidents: [], filtres: [], facturation: [] }

const origine = Module._load
Module._load = function (d, ...reste) {
  if (d === '@supabase/supabase-js') return {
    createClient: () => ({
      from (table) {
        const b = {
          select: () => b, eq: () => b, gte: () => b,
          // ⚠ ON CAPTURE LE FILTRE AU LIEU DE L'AVALER. Le mock precedent rendait
          // `ilike` passe-plat : il aurait accepte n'importe quelle colonne, y
          // compris celle qui fait lever Postgres. C'est ce qui a laisse passer
          // un plafond qui ne plafonnait rien.
          ilike: (colonne, motif) => { etat.filtres.push({ colonne, motif }); return b },
          limit: async () => ({ data: etat.incidents, error: null }),
          maybeSingle: async () => ({ data: etat.cles[table] ?? etat.cles.api_keys ?? null, error: null })
        }
        return b
      }
    })
  }
  if (d === './founder-notify') return {
    reportIncident: async (type, o) => { etat.incidents.push({ type, ...o }) }
  }
  if (d === './incident-facturation') return {
    signalerSiPanneFacturation: async (service, err, ctx) => {
      etat.facturation.push({ service, err, ctx }); return true
    }
  }
  return origine.apply(this, [d, ...reste])
}

const fetchOrigine = global.fetch
global.fetch = async (url, opts) => {
  if (String(url).includes('/senders')) {
    if (etat.senders === 'erreur') return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ senders: etat.senders || [] }) }
  }
  etat.envois.push({ url: String(url), corps: JSON.parse(opts.body), cle: opts.headers['api-key'] })
  const r = etat.reponseBrevo || { ok: true, status: 201, body: { messageId: 'msg-1' } }
  return { ok: r.ok, status: r.status, json: async () => r.body || {} }
}

const { envoyerEmailVoyageur, texteVersHtml, sujetPour, compterEchecs, cleEchec,
        _viderCacheExpediteur } = require('../lib/email-guestflow')

test.after(() => { Module._load = origine; global.fetch = fetchOrigine })

function remise ({ cle = 'cle-de-l-hote', actif = true, senders } = {}) {
  etat.cles = { api_keys: cle ? { brevo_api_key: cle, brevo_enabled: actif } : null }
  etat.senders = senders !== undefined ? senders
    : [{ id: 1, email: 'hote@exemple.test', name: 'Chez Éric', active: true }]
  etat.envois = []
  etat.reponseBrevo = null
  etat.incidents = []
  etat.filtres = []
  etat.facturation = []
  _viderCacheExpediteur()
}

// ─── La clé de l'hôte ───────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : la cle utilisee est celle du compte proprietaire', async () => {
  remise({ cle: 'cle-du-compte-A' })
  const r = await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test',
    sujet: 'Sujet', texte: 'Bonjour' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(etat.envois[0].cle, 'cle-du-compte-A',
    'ses credits, son domaine, sa reputation d\'expediteur')
})

test('aucune cle Brevo : echec PERMANENT, pas une boucle', async () => {
  remise({ cle: null })
  const r = await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test',
    sujet: 'S', texte: 'T' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.raison, 'brevo_non_configure')
  assert.strictEqual(r.permanent, true, 'aucun nombre de tentatives ne fera apparaitre une cle')
  assert.strictEqual(etat.envois.length, 0)
})

test('Brevo desactive par l\'hote : on n\'envoie pas', async () => {
  remise({ actif: false })
  const r = await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test', sujet: 'S', texte: 'T' })
  assert.strictEqual(r.raison, 'brevo_desactive')
  assert.strictEqual(etat.envois.length, 0)
})

// ─── L'expéditeur ───────────────────────────────────────────────────────────
test('l\'expediteur est un sender VERIFIE du compte, et le reply-to est le meme', async () => {
  remise()
  await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test', sujet: 'S', texte: 'T' })
  const c = etat.envois[0].corps
  assert.deepStrictEqual(c.sender, { email: 'hote@exemple.test', name: 'Chez Éric' })
  assert.deepStrictEqual(c.replyTo, { email: 'hote@exemple.test', name: 'Chez Éric' },
    'le voyageur repond, l\'hote recoit dans SA boite')
})

test('un sender inactif est ignore : Brevo rendrait 400 a l\'envoi', async () => {
  remise({ senders: [{ id: 1, email: 'pas-verifie@x.fr', active: false },
                     { id: 2, email: 'ok@x.fr', name: 'OK', active: true }] })
  await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test', sujet: 'S', texte: 'T' })
  assert.strictEqual(etat.envois[0].corps.sender.email, 'ok@x.fr')
})

test('aucun expediteur verifie : echec PERMANENT, et on le dit', async () => {
  remise({ senders: [] })
  const r = await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test', sujet: 'S', texte: 'T' })
  assert.strictEqual(r.raison, 'aucun_expediteur_verifie')
  assert.strictEqual(r.permanent, true)
})

test('senders injoignable (500) : TRANSITOIRE — on repassera', async () => {
  remise({ senders: 'erreur' })
  const r = await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test', sujet: 'S', texte: 'T' })
  assert.strictEqual(r.permanent, false, 'une panne n\'est pas une absence de configuration')
})

// ─── Le corps ───────────────────────────────────────────────────────────────
test('le texte du template part tel quel, echappe', () => {
  const html = texteVersHtml('Bonjour <Marie> & "co"\nLigne 2\n\nParagraphe 2')
  assert.ok(html.includes('&lt;Marie&gt;'), 'le HTML du voyageur n\'est pas injectable')
  assert.ok(html.includes('&amp;') && html.includes('&quot;'))
  assert.ok(html.includes('Ligne 2'))
  assert.strictEqual((html.match(/<p /g) || []).length, 2, 'une ligne vide = un paragraphe')
  assert.ok(/Bonjour[^<]*<br>/.test(html.replace(/&lt;Marie&gt; &amp; &quot;co&quot;/, '')),
    'un saut simple = un <br>')
})

test('MARQUE BLANCHE : aucune mention HoteSmart dans ce qui part', async () => {
  remise()
  await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test',
    sujet: 'Votre arrivée à La bulle', texte: 'Bonjour' })
  const c = etat.envois[0].corps
  assert.ok(!/h[oô]tesmart/i.test(c.htmlContent), 'le corps ne cite que le bien')
  assert.ok(!/h[oô]tesmart/i.test(JSON.stringify(c.sender)), 'l\'enveloppe non plus')
})

// ─── Les sujets ─────────────────────────────────────────────────────────────
test('le sujet se derive de l\'evenement et du bien', () => {
  assert.strictEqual(sujetPour('booking_confirmed', 'La bulle'), 'Votre réservation à La bulle')
  assert.strictEqual(sujetPour('arrival_code', 'La bulle'), 'Votre code d\'accès — La bulle')
  assert.strictEqual(sujetPour('departure', 'La bulle'), 'Votre départ de La bulle')
})

test('un evenement inconnu ou un bien sans nom ont quand meme un sujet', () => {
  // Un sujet vide part en spam, et « undefined » dans un objet de mail est pire
  // que tout : ce sont deux façons de perdre le voyageur.
  assert.strictEqual(sujetPour(null, 'La bulle'), 'La bulle — un message de votre hôte')
  assert.strictEqual(sujetPour('arrival', ''), 'Votre arrivée à votre séjour')
  assert.strictEqual(sujetPour(null, null), 'Un message de votre hôte')
  for (const s of [sujetPour('x', 'y'), sujetPour(undefined, undefined)]) {
    assert.ok(s && !/undefined|null/.test(s), `sujet douteux : ${s}`)
  }
})

// ─── Permanent vs transitoire ───────────────────────────────────────────────
test('LE TEST QUI COMPTE : 400 Brevo = PERMANENT (une adresse invalide le reste)', async () => {
  remise()
  etat.reponseBrevo = { ok: false, status: 400, body: { message: 'Invalid email address' } }
  const r = await envoyerEmailVoyageur({ userId: 'A', destinataire: 'pas-une-adresse', sujet: 'S', texte: 'T' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.permanent, true)
  assert.ok(/Invalid email/.test(r.raison), 'la cause de Brevo est conservee, pas avalee')
})

test('LE TEST QUI COMPTE : 500 Brevo = TRANSITOIRE (on repassera)', async () => {
  remise()
  etat.reponseBrevo = { ok: false, status: 503, body: { message: 'oups' } }
  const r = await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test', sujet: 'S', texte: 'T' })
  assert.strictEqual(r.permanent, false)
  assert.notStrictEqual(r.quota, true)
})

test('LE TEST QUI COMPTE : 429 = quota, transitoire ET hors plafond', async () => {
  // Un forfait journalier epuise rend 429 toute la journee. Le compter ferait
  // abandonner le message en vingt minutes, alors qu'il repart a minuit.
  remise()
  etat.reponseBrevo = { ok: false, status: 429, body: { message: 'daily limit' } }
  const r = await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test', sujet: 'S', texte: 'T' })
  assert.strictEqual(r.permanent, false)
  assert.strictEqual(r.quota, true)
})

test('reseau coupe : transitoire, et on ne perd pas la cause', async () => {
  remise()
  const f = global.fetch
  global.fetch = async (url) => String(url).includes('/senders')
    ? { ok: true, status: 200, json: async () => ({ senders: etat.senders }) }
    : (() => { throw new Error('ECONNRESET') })()
  const r = await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@exemple.test', sujet: 'S', texte: 'T' })
  global.fetch = f
  assert.strictEqual(r.permanent, false)
  assert.ok(/ECONNRESET/.test(r.raison))
})

// ─── Les garde-fous d'entrée ────────────────────────────────────────────────
test('sans destinataire, sans sujet ou sans texte : on n\'appelle pas Brevo', async () => {
  remise()
  for (const cas of [{ destinataire: null, sujet: 'S', texte: 'T' },
                     { destinataire: 'v@x.fr', sujet: null, texte: 'T' },
                     { destinataire: 'v@x.fr', sujet: 'S', texte: '' }]) {
    const r = await envoyerEmailVoyageur({ userId: 'A', ...cas })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.permanent, true)
  }
  assert.strictEqual(etat.envois.length, 0)
})

// ─── Les correctifs de review (16 septembre 2026) ───────────────────────────

test('LE TEST QUI COMPTE : le compteur interroge `detail->>message`, pas `detail`', async () => {
  // `automation_incidents.detail` est du JSONB, et `reportIncident` y range une
  // chaine sous `{ message }`. Un ILIKE sur la colonne entiere fait lever
  // Postgres ; l'erreur etait avalee par le fail-safe, le compte rendait 0, et le
  // plafond n'etait JAMAIS atteint — une ligne de plus toutes les 5 minutes,
  // indefiniment.
  remise()
  await compterEchecs('booking-1', 'tpl-1')
  assert.strictEqual(etat.filtres.length, 1)
  assert.strictEqual(etat.filtres[0].colonne, 'detail->>message',
    'sur la colonne brute, Postgres leve : operator does not exist: jsonb ~~*')
  assert.ok(etat.filtres[0].motif.includes(cleEchec('booking-1', 'tpl-1')))
})

test('402 (credits epuises) est un QUOTA, donc transitoire', async () => {
  // Il etait classe permanent, et comme l'appelant teste `permanent` avant
  // `quota`, le message etait condamne alors que l'hote recharge le lendemain.
  remise()
  etat.reponseBrevo = { ok: false, status: 402, body: { message: 'not enough credits' } }
  const r = await envoyerEmailVoyageur({ userId: 'A', destinataire: 'v@x.fr', sujet: 'S', texte: 'T' })
  assert.strictEqual(r.quota, true)
  assert.strictEqual(r.permanent, false, 'un credit se recharge ; un abandon ne se defait pas')
})

test('un quota epuise s\'annonce AVEC le compte et le bien concernes', async () => {
  // C'est le premier signalement de facturation sur une cle d'HOTE et non de
  // plateforme : sans contexte, l'anti-spam de 24 h par (type, bien) ferait taire
  // le second hote a court de credits.
  remise()
  etat.reponseBrevo = { ok: false, status: 429, body: { message: 'daily limit' } }
  await envoyerEmailVoyageur({ userId: 'compte-A', destinataire: 'v@x.fr', sujet: 'S', texte: 'T',
    propertyId: 'bien-1', propertyName: 'La bulle' })
  assert.strictEqual(etat.facturation.length, 1)
  assert.deepStrictEqual(etat.facturation[0].ctx,
    { userId: 'compte-A', propertyId: 'bien-1', propertyName: 'La bulle' })
})
