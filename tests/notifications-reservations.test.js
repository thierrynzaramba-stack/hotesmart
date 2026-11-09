// tests/notifications-reservations.test.js
// PWA lot 2c-2, domaine Réservations (docs/kb/pwa.md §11) : les textes de la
// nouvelle réservation (f), de l'annulation ou modification (g), du code d'accès
// non résolu (j), et le branchement du code non résolu sur le point d'envoi.
// Le branchement de f et g vit dans tests/booking-changes-dispatch.test.js.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const textes = require('../lib/notifications/textes')
const { evenement } = require('../lib/notifications/catalogue')

// ─── Les textes ──────────────────────────────────────────────────────────────

test('les trois événements ont un texte dans les trois langues, et le catalogue les connaît', () => {
  for (const code of ['reservation', 'annulation_modification', 'code_non_resolu']) {
    assert.ok(evenement(code), code)
    for (const langue of ['fr', 'en', 'es']) {
      const t = textes.rediger(code, langue, { bien: 'La bulle', prenom: 'Jean', arrivee: '2026-12-12', depart: '2026-12-15' })
      assert.ok(t && t.titre && t.corps, `${code}/${langue}`)
      assert.ok(t.titre.includes('La bulle'), `${code}/${langue} : le bien dans le titre`)
    }
  }
})

test('une réservation directe se dit « Direct », jamais « Offline »', () => {
  const d = { bien: 'La bulle', prenom: 'Jean', arrivee: '2026-12-12', depart: '2026-12-15', canal: 'Offline' }
  assert.strictEqual(textes.rediger('reservation', 'fr', d).corps, 'Jean, du 12/12 au 15/12 · Direct.')
  assert.ok(textes.rediger('reservation', 'es', d).corps.includes('Directa'))
  for (const l of ['fr', 'en', 'es']) assert.ok(!/offline/i.test(textes.rediger('reservation', l, d).corps))
  assert.strictEqual(textes.rediger('reservation', 'fr', { ...d, canal: 'Booking.com' }).corps, 'Jean, du 12/12 au 15/12 · Booking.com.')
  assert.strictEqual(textes.rediger('reservation', 'fr', { ...d, canal: null, prenom: null }).corps, 'Un voyageur, du 12/12 au 15/12.')
})

test('une modification dit CE QUI a changé (les quatre champs du cœur), une annulation le dit', () => {
  const modif = textes.rediger('annulation_modification', 'fr', {
    bien: 'La bulle', prenom: 'Jean', arrivee: '2026-12-13', depart: '2026-12-15', annulation: false,
    // Un champ inchangé vaut null dans `changes` (lib/booking-changes.js) : il ne se dit pas.
    changements: { arrival: { before: '2026-12-12', after: '2026-12-13' }, departure: null, numAdult: { before: 2, after: 3 }, numChild: null }
  })
  assert.deepStrictEqual(modif, { titre: 'Réservation modifiée — La bulle', corps: 'Jean : arrivée 12/12 → 13/12, adultes 2 → 3.' })
  const sansDetail = textes.rediger('annulation_modification', 'fr', { bien: 'La bulle', prenom: 'Jean', arrivee: '2026-12-13', depart: '2026-12-15', annulation: false, changements: null })
  assert.strictEqual(sansDetail.corps, 'Jean, du 13/12 au 15/12.')
  const annul = textes.rediger('annulation_modification', 'fr', { bien: 'La bulle', prenom: 'Jean', arrivee: '2026-12-12', depart: '2026-12-15', annulation: true })
  assert.deepStrictEqual(annul, { titre: 'Annulation — La bulle', corps: 'Jean, du 12/12 au 15/12 : réservation annulée.' })
})

test('une annulation Channex sans dates ni voyageur ne laisse aucun trou dans le texte', () => {
  for (const l of ['fr', 'en', 'es']) {
    const t = textes.rediger('annulation_modification', l, { bien: 'Colomiers', prenom: '', arrivee: null, depart: null, annulation: true })
    assert.ok(!/,\s*[:.]|\s{2}|undefined|null/.test(t.corps), `${l} : « ${t.corps} »`)
  }
  assert.strictEqual(textes.rediger('annulation_modification', 'fr', { bien: 'Colomiers', annulation: true }).corps, 'Un voyageur : réservation annulée.')
})

test('un prénom tapé par un visiteur est borné ; le canal se dit par la règle du dépôt, pas par l\'orthographe du partenaire', () => {
  const long = textes.rediger('reservation', 'fr', { bien: 'B', prenom: 'x'.repeat(200), arrivee: '2026-12-12', depart: '2026-12-15' })
  assert.ok(long.corps.length < 80, long.corps)
  const canal = (c) => textes.rediger('reservation', 'fr', { bien: 'B', prenom: 'Jean', arrivee: '2026-12-12', depart: '2026-12-15', canal: c }).corps
  assert.strictEqual(canal('BookingCom'), 'Jean, du 12/12 au 15/12 · Booking.com.')
  assert.strictEqual(canal('AirBNB'), 'Jean, du 12/12 au 15/12 · Airbnb.')
  assert.strictEqual(canal('abb'), 'Jean, du 12/12 au 15/12 · Airbnb.')
})

test('chaque événement rédigé a son essai (POST /api/push, essai_evenement)', () => {
  for (const code of textes.rediges()) {
    const d = textes.exemple(code)
    assert.ok(d && d.essai, code)
    assert.ok(textes.rediger(code, 'fr', d).titre.startsWith('Essai — '), code)
  }
})

test('le code non résolu dit quoi faire', () => {
  const t = textes.rediger('code_non_resolu', 'fr', { bien: 'La bulle', prenom: 'Jean', arrivee: '2026-12-12' })
  assert.strictEqual(t.titre, 'Code d’accès indisponible — La bulle')
  assert.strictEqual(t.corps, 'Jean, arrivée le 12/12 : le message d’arrivée est retenu. Transmettez le code vous-même, ou vérifiez la serrure.')
})

// ─── Le code non résolu passe par le point d'envoi ──────────────────────────

const COMPTE = 'compte-1'
const UUID_BIEN = '3f2a1b4c-1111-4222-8333-944455556666'
// Une référence Channex a la forme d'un UUID (lib/channels/channex.js) : elle ne
// doit jamais être prise pour l'identifiant HôteSmart du bien.
const REF_CHANNEX = '0db6b39b-b8f6-4c1e-9a7d-5e2f3a4b5c6d'
const UUID_COLOMIERS = '7a8b9c0d-2222-4333-8444-955566667777'

function stub (rel, exports) {
  const abs = require.resolve(path.join(__dirname, '..', rel))
  const m = new Module(abs); m.exports = exports; m.loaded = true
  require.cache[abs] = m
}

function preparer ({ dejaAlerte = false, bienLisible = true } = {}) {
  const etat = { notifications: [], emails: [], sms: [], taches: [], lecturesBien: [] }
  const client = {
    // L'adresse de connexion du titulaire : l'ancien e-mail de repli la lisait ici.
    // Sans elle, le test « plus d'e-mail de repli » passerait pour une mauvaise raison.
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'hote@exemple.fr' } }, error: null }) } },
    from (table) {
      const f = {}
      const chain = {
        select () { return chain },
        eq (c, v) { f[c] = v; return chain },
        maybeSingle () {
          if (table === 'agent_tasks') return Promise.resolve({ data: dejaAlerte ? { id: 't1' } : null, error: null })
          return Promise.resolve({ data: null, error: null })
        },
        // Le bien se lit en liste (lib/notifications/bien.js : plusieurs lignes possibles).
        limit () {
          if (table !== 'properties') return Promise.resolve({ data: [], error: null })
          etat.lecturesBien.push({ ...f })
          if (!bienLisible) return Promise.resolve({ data: null, error: { message: 'panne' } })
          if (f.user_id !== COMPTE) return Promise.resolve({ data: [], error: null })
          if (f.provider_property_id === '209413' || f.id === UUID_BIEN) return Promise.resolve({ data: [{ id: UUID_BIEN, name: 'La bulle', provider_property_id: '209413' }], error: null })
          if (f.provider_property_id === REF_CHANNEX || f.id === UUID_COLOMIERS) return Promise.resolve({ data: [{ id: UUID_COLOMIERS, name: 'Colomiers', provider_property_id: REF_CHANNEX }], error: null })
          return Promise.resolve({ data: [], error: null })
        },
        // Aucune configuration d'alerte : l'ancien code envoyait alors l'e-mail de repli.
        single () { return Promise.resolve({ data: null, error: { message: 'aucune' } }) },
        insert (row) { etat.taches.push(row); return Promise.resolve({ error: null }) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  stub('api/sms', { sendSms: async (to, msg) => { etat.sms.push(msg); return { ok: true } } })
  stub('lib/platform-notify', { sendPlatformEmail: async (to, sujet) => { etat.emails.push(sujet); return { ok: true } } })
  stub('lib/notifications/notifier.js', { notifier: async (o) => { etat.notifications.push(o); return { ok: true, erreurs: [] } } })
  delete require.cache[require.resolve('../lib/alert-notify')]
  const { alertMissingAccessCode } = require('../lib/alert-notify')
  return { alertMissingAccessCode, etat }
}

const RESA = { id: 555, firstName: 'Jean', lastName: 'Dupont', arrival: '2026-12-12', departure: '2026-12-15' }

test('LE TEST QUI COMPTE : le code non résolu prévient par le point d\'envoi, avec les DEUX identifiants du bien', async () => {
  const { alertMissingAccessCode, etat } = preparer()
  await alertMissingAccessCode({ userId: COMPTE, propertyId: '209413', booking: RESA })
  assert.strictEqual(etat.notifications.length, 1)
  const n = etat.notifications[0]
  assert.deepStrictEqual({ compte: n.compte, code: n.code, bien: n.bien, sejour: n.sejour, donnees: n.donnees, chemin: n.chemin, sujet: n.sujet }, {
    compte: COMPTE, code: 'code_non_resolu',
    // Un membre dont le périmètre est en UUID est prévenu : la référence seule ne le trouvait pas.
    bien: { id: UUID_BIEN, ref: '209413' },
    sejour: { arrivee: '2026-12-12', depart: '2026-12-15' },
    donnees: { bien: 'La bulle', prenom: 'Jean', arrivee: '2026-12-12' },
    chemin: '/pages/messages?conv=555', sujet: 'code:555'
  })
  // L'ancien e-mail de repli au titulaire ne part plus : c'est le point d'envoi qui
  // le porte, selon les réglages de chacun (sinon deux e-mails).
  assert.deepStrictEqual(etat.emails, [])
  assert.strictEqual(etat.taches.length, 1, 'la tâche in-app reste')
})

test('LE TEST QUI COMPTE : une référence Channex (forme d\'UUID) se lit comme une RÉFÉRENCE — le bien garde son nom et ses deux identifiants', async () => {
  const { alertMissingAccessCode, etat } = preparer()
  await alertMissingAccessCode({ userId: COMPTE, propertyId: REF_CHANNEX, booking: RESA })
  assert.deepStrictEqual(etat.lecturesBien[0], { user_id: COMPTE, provider_property_id: REF_CHANNEX })
  assert.deepStrictEqual(etat.notifications[0].bien, { id: UUID_COLOMIERS, ref: REF_CHANNEX })
  assert.strictEqual(etat.notifications[0].donnees.bien, 'Colomiers')
})

test('appelé avec l\'UUID HôteSmart, le bien se retrouve ; une lecture en panne n\'empêche pas l\'alerte', async () => {
  const a = preparer()
  await a.alertMissingAccessCode({ userId: COMPTE, propertyId: UUID_BIEN, booking: RESA })
  assert.deepStrictEqual(a.etat.lecturesBien, [{ user_id: COMPTE, provider_property_id: UUID_BIEN }, { user_id: COMPTE, id: UUID_BIEN }])
  assert.deepStrictEqual(a.etat.notifications[0].bien, { id: UUID_BIEN, ref: '209413' })

  const b = preparer({ bienLisible: false })
  await b.alertMissingAccessCode({ userId: COMPTE, propertyId: '209413', booking: RESA })
  assert.strictEqual(b.etat.notifications.length, 1)
  assert.deepStrictEqual(b.etat.notifications[0].bien, { id: undefined, ref: '209413' })
  // En panne, une valeur en forme d'UUID part des deux côtés : elle ne peut
  // désigner que ce bien, et le membre au périmètre en UUID reste prévenu.
  const c = preparer({ bienLisible: false })
  await c.alertMissingAccessCode({ userId: COMPTE, propertyId: REF_CHANNEX, booking: RESA })
  assert.deepStrictEqual(c.etat.notifications[0].bien, { id: REF_CHANNEX, ref: REF_CHANNEX })
})

test('une alerte déjà posée pour ce séjour ne prévient pas une seconde fois', async () => {
  const { alertMissingAccessCode, etat } = preparer({ dejaAlerte: true })
  await alertMissingAccessCode({ userId: COMPTE, propertyId: '209413', booking: RESA })
  assert.strictEqual(etat.notifications.length, 0)
})
