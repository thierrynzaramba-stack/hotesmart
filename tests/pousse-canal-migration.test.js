// tests/pousse-canal-migration.test.js
// LA GARDE DE PROVIDER SUR LES CHEMINS DE POUSSEE ARI.
//
// Regression trouvee en review le 9 septembre 2026, DEJA ACTIVE EN PRODUCTION :
// depuis le provisionnement de la migration (8c604b8), un bien BEDS24 porte les
// identifiants de canal de sa propriete CIBLE (room type, rate plan Channex)
// tout en gardant sa cle Beds24 dans `provider_property_id`. Les chemins de
// poussee ne jugeaient que sur la PRESENCE des ids : une simple edition de prix
// sur « La bulle » partait vers Channex avec `property_id: "209413"`.
//
// Consequences mesurees dans le code : rejet cote provider, et l'hote voyait
// « availability: HTTP 4xx » a la place du message « ce bien est gere par
// Beds24 » — la branche qui le porte n'etait plus atteinte.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { estRelieAuCanal, canPushRates } = require('../lib/rate-sync')

const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

// L'etat EXACT des deux biens de Bagneres apres la phase 0 de la migration.
const EN_MIGRATION = {
  provider: 'beds24',
  provider_property_id: '209413',              // cle BEDS24
  provider_room_type_id: 'chx-rt',             // ids de la propriete CIBLE
  provider_rate_plan_id: 'chx-rp',
  rate_sync_mode: 'managed'
}

test('LE TEST QUI COMPTE : un bien en migration a tous ses ids et ne pousse PAS', () => {
  assert.equal(estRelieAuCanal(EN_MIGRATION), false)
  // Et ce n'est pas le mode qui le protege : il est en 'managed'.
  assert.equal(canPushRates(EN_MIGRATION), true,
    'la garde des tarifs dit oui — seule la garde de provider ferme ce chemin')
})

test('les deux ecritures du provider chez le canal poussent', () => {
  assert.equal(estRelieAuCanal({ provider: 'channex' }), true)
  assert.equal(estRelieAuCanal({ provider: 'channel' }), true, 'marque blanche')
  assert.equal(estRelieAuCanal({ provider: 'beds24' }), false)
  assert.equal(estRelieAuCanal(null), false)
})

test('calendrier : le push delta juge le PROVIDER avant les ids', () => {
  const src = lire('api/calendar.js')
  assert.ok(/if \(estRelieAuCanal\(bien\) && propId && ratePlanId\)/.test(src),
    'la condition du push ARI porte la garde de provider')
})

test('calendrier : l enfilage du full sync refuse un bien hors canal', () => {
  const src = lire('api/calendar.js')
  assert.ok(/if \(!estRelieAuCanal\(bienFs\)\)/.test(src))
  assert.ok(/CHANNEL_NOT_CONNECTED/.test(src), 'le refus porte un motif lisible')
})

test('worker cron : il relit le provider A L EXECUTION, et le SELECTIONNE', () => {
  const src = lire('lib/cron-channel-sync.js')
  assert.ok(/if \(!estRelieAuCanal\(bien\)\)/.test(src),
    'le worker ne suppose pas que l appelant a garde : c est lui qui ecrit chez le provider')
  // Piege des colonnes non selectionnees : sans `provider` dans le SELECT, la
  // garde lirait `undefined` et ferait echouer TOUS les jobs.
  const sel = (src.match(/\.select\('id, user_id, name[^']*'\)/) || [''])[0]
  assert.ok(sel.includes('provider,'), 'le SELECT du worker porte la colonne provider : ' + sel)
})
