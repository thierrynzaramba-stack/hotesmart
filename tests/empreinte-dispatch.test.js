// tests/empreinte-dispatch.test.js
// LE DEFAUT : l'empreinte de sejour etait INERTE sur le chemin du dispatcher,
// celui qui envoie le message de bienvenue.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const { codeOtaBrut } = require('../lib/bookings-snapshot')

test('LE TEST QUI COMPTE : le booking du dispatcher porte le code OTA, sinon la garde est morte', () => {
  // ⚠ MESURE DU 10 SEPTEMBRE 2026, 21:10. Au mapping Airbnb de La bulle,
  // Channex a livre trois sejours qui existaient deja sous la cle Beds24, et le
  // message `booking_confirmed` — le message de BIENVENUE — est reparti aux
  // trois voyageurs, qui l'avaient recu les 5, 7 et 9 septembre.
  //
  // Leurs lignes de journal portaient la bonne empreinte
  // (`stay_key = HMXJPMDJEN`, `HMYSC3QK8X`, `HM4TMX5QXQ`). La garde de
  // `triggerTemplates` ne l'a pas lue : `bookingDepuisSnapshot` reconstruisait
  // l'objet avec SIX champs et pas le code OTA, donc
  // `codeOtaBrut(booking)` rendait `null`, la garde etait sautee, et l'ecriture
  // notait `stay_key = NULL` — invisible a la garde suivante.
  //
  // Le mecanisme etait bon ; il etait branche sur un objet amputé.
  const src = lire('lib/booking-changes-dispatch.js')
  const i = src.indexOf('function bookingDepuisSnapshot')
  assert.ok(i > 0, 'la fonction existe')
  const corps = src.slice(i, src.indexOf('\n}', i))
  assert.ok(/otaReservationCode:\s*s\.otaReservationCode/.test(corps),
    'le code OTA est recopie depuis le snapshot')
})

test('LE TEST QUI COMPTE : `codeOtaBrut` reconnait l objet du dispatcher', () => {
  // Le test precedent lit la source. Celui-ci exerce la CHAINE REELLE : on
  // reconstruit l'objet comme le dispatcher le fait, et on verifie que la
  // fonction qui calcule l'empreinte le reconnait. C'est ce maillon qui a
  // casse — pas la lecture du journal, pas l'ecriture, le passage entre les
  // deux.
  const bookingDepuisSnapshot = (event, snapshot) => {
    const s = snapshot || {}
    return {
      id: event.booking_id, propertyId: event.property_id,
      firstName: s.firstName || '', lastName: s.lastName || '',
      arrival: s.arrival || null, departure: s.departure || null,
      source: s.source || null,
      otaReservationCode: s.otaReservationCode || null
    }
  }
  const snapshot = {
    firstName: 'X', arrival: '2026-09-11', departure: '2026-09-12',
    source: 'AirBNB', otaReservationCode: 'HMXJPMDJEN', status: 'confirmed'
  }
  const b = bookingDepuisSnapshot(
    { booking_id: '726e95e9-1c10-48e7-b016-754b0d140fd8', property_id: 'x' }, snapshot)
  assert.equal(codeOtaBrut(b), 'HMXJPMDJEN', 'l empreinte est calculable')

  // ⚠ LA CONTRE-EPREUVE, celle qui documente le defaut : sans le champ,
  // l'empreinte vaut null et la garde de `triggerTemplates` est sautee — elle
  // est conditionnee a `if (empreinteT)`.
  const { otaReservationCode, ...ampute } = b
  assert.equal(codeOtaBrut(ampute), null,
    'sans le champ, l empreinte est nulle : c est ce qui a laisse partir les 3 messages')
})

test('LE TEST QUI COMPTE : la garde de triggerTemplates est bien conditionnee a l empreinte', () => {
  // Si elle etait inconditionnelle, une empreinte nulle aurait au moins fait
  // echouer bruyamment au lieu de laisser passer en silence. Elle ne l'est
  // pas — et c'est defendable (une reservation directe sans code OTA doit
  // pouvoir recevoir ses messages). Mais ca rend le champ OBLIGATOIRE en
  // amont : ce test dit que les deux moitiés vont ensemble.
  const src = lire('lib/cron-messages.js')
  assert.ok(src.includes('const empreinteT = codeOtaBrut(booking)'),
    'triggerTemplates calcule l empreinte depuis le booking recu')
  assert.ok(src.includes('if (empreinteT) {'),
    'et ne garde QUE si elle est calculable — donc l amont doit la fournir')
})

test('les trois formes de code OTA sont acceptees, camelCase comme snake_case', () => {
  // Les deux providers ne nomment pas ce champ pareil, et le repli `apiReference`
  // vient de Beds24. Une seule des trois manquante suffirait a rendre
  // l empreinte nulle sur un chemin.
  assert.equal(codeOtaBrut({ otaReservationCode: 'abc' }), 'ABC')
  assert.equal(codeOtaBrut({ ota_reservation_code: 'abc' }), 'ABC')
  assert.equal(codeOtaBrut({ apiReference: 'abc' }), 'ABC')
  assert.equal(codeOtaBrut({ otaReservationCode: '  hm4t  ' }), 'HM4T', 'trim + majuscules')
  assert.equal(codeOtaBrut({}), null)
  assert.equal(codeOtaBrut(null), null)
})

test('LE TEST QUI COMPTE : un sejour dont le code OTA est deja connu n est pas distribue', () => {
  // ⚠ `initialImport` ETAIT UN PARAMETRE QUE L'APPELANT DEVAIT PENSER A FOURNIR.
  // Personne ne le fournit au moment ou un canal se mappe et ou le provider
  // livre les sejours deja pris : le writer les voyait donc comme `new`, et le
  // dispatcher les a distribues.
  //
  // Mesure du 10 septembre 2026, 21:10 : trois evenements `new` ecrits
  // `processed_at = NULL` pour trois sejours qui existaient deja sous la cle
  // Beds24 — donc trois messages de bienvenue reenvoyes. Le commentaire de
  // `recordChangeEvent` decrivait ce scenario depuis toujours ; il manquait la
  // detection.
  //
  // La regle : le code de reservation de l'OTA est le seul identifiant qui
  // traverse un changement de channel manager. Deja connu du compte sous un
  // AUTRE booking_id => ce n'est pas une nouveaute, c'est la meme reservation
  // par un autre chemin.
  const src = lire('lib/bookings-snapshot.js')

  assert.ok(src.includes("change.type === 'new' && !initialImport"),
    'la detection ne s applique qu aux nouveautes, et laisse passer un initialImport explicite')
  assert.ok(src.includes(".eq('snapshot->>otaReservationCode', codeOta)"),
    'elle cherche le code OTA du compte')
  assert.ok(src.includes(".neq('booking_id', String(bookingId))"),
    'sous un AUTRE booking_id — sinon elle se trouverait elle-meme')
  assert.ok(src.includes(".eq('user_id', userId)"), 'cloisonnee par compte')
  assert.ok(src.includes('initialImport: initialImport || reimport'),
    'le re-import est traite comme un import initial : materialise, non distribue')

  // ⚠ FAIL-SAFE : une lecture en echec ne doit RIEN bloquer. Bloquer perdrait
  // des notifications legitimes pour se proteger d'un doublon.
  const i = src.indexOf('let reimport = false')
  const bloc = src.slice(i, i + 2000)
  assert.ok(/recherche de re-import impossible, on distribue/.test(bloc),
    'sur echec de lecture : on distribue, et on hurle')
  assert.ok(/exception recherche de re-import, on distribue/.test(bloc),
    'idem sur exception')

  // ⚠ ET SEULEMENT SUR `new` : un `modified` ou `cancelled` sur un sejour connu
  // DOIT etre distribue — c'est tout l'objet du suivi.
  assert.ok(!/change\.type === 'modified'[\s\S]{0,120}reimport/.test(src),
    'la detection ne touche pas les modifications ni les annulations')
})
