// tests/canal-voyageur.test.js
// Etape 2 du chantier « canal e-mail pour les reservations directes » :
// docs/specs/spec-canal-email-resa-directe.md.
//
// LA DECISION DE CANAL, ISOLEE. Ce que ces tests protegent tient en une phrase :
// une reservation OTA doit passer EXACTEMENT comme avant, et une reservation
// Offline ne doit plus jamais frapper l'API messages de Channex.

const test = require('node:test')
const assert = require('node:assert')

const { CANAL, MOTIF, canalPour, passeParOta, passeParEmail } = require('../lib/canal-voyageur')

// ─── Les reservations OTA : rien ne bouge ────────────────────────────────────
test('Airbnb (Channex) -> messagerie OTA', () => {
  const d = canalPour({ id: '512013a3', source: 'AirBNB', guestEmail: null })
  assert.strictEqual(d.canal, CANAL.OTA)
  assert.strictEqual(d.motif, MOTIF.MESSAGERIE_OTA)
})

test('Booking.com avec son alias de relais -> messagerie OTA, JAMAIS l\'e-mail', () => {
  // Le piege central du chantier. Cet alias delivre : router sur « une adresse
  // existe » sortirait cette reservation de sa messagerie OTA.
  const d = canalPour({ id: 'a2a77727', source: 'BookingCom',
    guestEmail: 'avelina.m5261285458@guest.booking.com' })
  assert.strictEqual(d.canal, CANAL.OTA)
  assert.strictEqual(passeParEmail({ source: 'BookingCom', guestEmail: 'x@guest.booking.com' }), false)
})

test('Beds24 : un canal renseigne suffit, meme sans source', () => {
  // Regle reprise telle quelle de l'ancien `hasMessagingThread` : la changer
  // couperait des envois OTA qui fonctionnent.
  assert.strictEqual(canalPour({ id: 1, channel: 'airbnb' }).canal, CANAL.OTA)
  assert.strictEqual(canalPour({ id: 1, apiSource: 'booking' }).canal, CANAL.OTA)
  assert.strictEqual(canalPour({ id: 1, referer: 'Booking.com' }).canal, CANAL.OTA)
  assert.strictEqual(canalPour({ id: 1, source: 'booking' }).canal, CANAL.OTA)
})

// ─── Les reservations Offline ────────────────────────────────────────────────
test('Offline avec adresse -> e-mail, et le destinataire est rendu', () => {
  const d = canalPour({ id: 'c87f24ce', source: 'Offline', guestEmail: 'voyageur@exemple.test' })
  assert.strictEqual(d.canal, CANAL.EMAIL)
  assert.strictEqual(d.motif, MOTIF.EMAIL_VOYAGEUR)
  assert.strictEqual(d.destinataire, 'voyageur@exemple.test')
})

test('Offline sans adresse -> aucun canal, et le motif le dit', () => {
  const d = canalPour({ id: '61415d10', source: 'Offline', guestEmail: null })
  assert.strictEqual(d.canal, CANAL.AUCUN)
  assert.strictEqual(d.motif, MOTIF.PAS_D_EMAIL)
  assert.strictEqual(d.destinataire, null)
})

test('Offline : la casse et les espaces ne changent rien', () => {
  assert.strictEqual(canalPour({ source: ' OFFLINE ', guestEmail: 'a@b.fr' }).canal, CANAL.EMAIL)
})

test('Offline : une adresse vide ou blanche ne vaut pas une adresse', () => {
  assert.strictEqual(canalPour({ source: 'Offline', guestEmail: '   ' }).motif, MOTIF.PAS_D_EMAIL)
  assert.strictEqual(canalPour({ source: 'Offline', guestEmail: '' }).motif, MOTIF.PAS_D_EMAIL)
})

// ─── La saisie directe Beds24 : inchangee, hors perimetre v1 ─────────────────
test('Beds24 direct -> aucun canal (comportement historique, inchange)', () => {
  const d = canalPour({ id: 84489862, source: 'direct', email: 'direct@exemple.test' })
  assert.strictEqual(d.canal, CANAL.AUCUN)
  assert.strictEqual(d.motif, MOTIF.SANS_CANAL)
})

test('booking sans aucune source -> aucun canal', () => {
  assert.strictEqual(canalPour({ id: 1 }).canal, CANAL.AUCUN)
  assert.strictEqual(canalPour(null).canal, CANAL.AUCUN)
})

// ─── L'invariant qui tient tout ──────────────────────────────────────────────
test('INVARIANT : la decision ne rend jamais null, et toujours un motif', () => {
  // « je ne sais pas » n'est pas une reponse. Un motif absent est un motif qu'on
  // finit par ignorer a l'ecran.
  const cas = [null, undefined, {}, { source: 'Offline' }, { source: 'AirBNB' },
               { source: 'direct' }, { channel: 'x' }, { source: 'Offline', guestEmail: 'a@b.fr' }]
  for (const c of cas) {
    const d = canalPour(c)
    assert.ok(d && d.canal, `canal manquant pour ${JSON.stringify(c)}`)
    assert.ok(d.motif, `motif manquant pour ${JSON.stringify(c)}`)
    assert.ok(Object.values(CANAL).includes(d.canal), `canal hors liste : ${d.canal}`)
  }
})

test('INVARIANT : une adresse ne suffit jamais a basculer vers l\'e-mail', () => {
  // Deux reservations, la meme adresse, deux canaux. Seule la source les separe.
  const adresse = 'meme@exemple.test'
  assert.strictEqual(canalPour({ source: 'AirBNB',  guestEmail: adresse }).canal, CANAL.OTA)
  assert.strictEqual(canalPour({ source: 'Offline', guestEmail: adresse }).canal, CANAL.EMAIL)
})

test('passeParOta est le raccourci exact de la decision', () => {
  for (const b of [{ source: 'AirBNB' }, { source: 'Offline', guestEmail: 'a@b.fr' },
                   { source: 'direct' }, { channel: 'x' }]) {
    assert.strictEqual(passeParOta(b), canalPour(b).canal === CANAL.OTA)
  }
})
