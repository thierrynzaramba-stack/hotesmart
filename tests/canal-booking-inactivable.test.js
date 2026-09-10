// tests/canal-booking-inactivable.test.js
// LE DEFAUT : tout canal Booking cree par notre endpoint etait INACTIVABLE.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('LE TEST QUI COMPTE : `hotel_id` est normalise en CHAINE juste apres la creation', () => {
  // ⚠ LE PIEGE SE REFERMAIT SUR LUI-MEME, ET C'EST MESURE DES DEUX COTES :
  //   POST /channels              -> exige un NOMBRE (chaine  -> HTTP 500, sans detail)
  //   POST /channels/:id/activate -> refuse un NOMBRE
  //        422 {"errors":{"details":{"settings":["invalid settings"]}}}
  //
  // Tout canal cree par cet endpoint etait donc inactivable POUR TOUJOURS, et
  // l'ecran de liaison finissait sur « la connexion n'a pas pu etre
  // finalisee ». Constate le 10 septembre 2026 : les deux canaux Booking qui
  // fonctionnent portent une CHAINE, celui de La bulle portait un NOMBRE,
  // n'avait jamais ete touche par Channex depuis sa creation (`updated_at` a
  // 0,06 s de `inserted_at`) et n'avait pas de `tax_settings`.
  const src = lire('api/channel-bcom-write.js')

  // La creation envoie toujours un NOMBRE — c'est l'exigence de Channex.
  assert.ok(src.includes('hotel_id: Number(hotelId)'), 'la creation envoie un nombre')

  // Et le PUT de normalisation suit IMMEDIATEMENT, avant la preuve.
  assert.ok(/settings: \{ hotel_id: String\(hotelId\) \}/.test(src),
    'un PUT normalise ensuite en chaine')
  const iCreate = src.indexOf("const w = await channelCall('POST', '/channels', payload)")
  const iPut = src.indexOf('hotel_id: String(hotelId)')
  const iProof = src.indexOf('let proof = null')
  assert.ok(iCreate > 0 && iPut > iCreate, 'la normalisation vient APRES la creation')
  assert.ok(iPut < iProof, 'et AVANT la relecture de preuve, sinon la preuve mentirait')

  // ⚠ LA PREUVE RENDUE DOIT DIRE SI LE CANAL EST ACTIVABLE. Un `is_active:
  // false` ne distingue pas « pas encore active » de « jamais activable ».
  assert.ok(src.includes('hotel_id_type: typeof sAfter.hotel_id'), 'le type est rendu')
  assert.ok(src.includes("activable: typeof sAfter.hotel_id === 'string'"),
    'et le verdict activable/inactivable avec lui')
})

test('LE TEST QUI COMPTE : un refus d activation dit POURQUOI, et un 422 n est pas un 502', () => {
  // L'endpoint rendait 502 avec la cause enfouie dans `result`, que le front
  // jette (`shared/api-client.js` compose son message avec `data.error`).
  // Thierry a donc lu « Erreur serveur » sur un refus parfaitement explicite,
  // et cherche une panne reseau. Un 422 est un refus de validation.
  const src = lire('api/channel-bcom-activate.js')
  assert.ok(/res\.status\(w\.status === 422 \? 422 : 502\)/.test(src),
    'un 422 de Channex ressort en 422')
  assert.ok(/error: `L'activation du canal a ete refusee/.test(src),
    'le champ `error` est present, c est le seul que le front lit')
  // La chaine porte des accents graves dans la source (`hotel_id`) : on cherche
  // un fragment sans balisage, sinon le test rougit pour la mise en forme.
  assert.ok(src.includes('NUMERIQUE, que Channex refuse'),
    'et la cause connue est nommee quand on la reconnait')
  assert.ok(src.includes('hotel_id_type: typeof sAct.hotel_id'),
    'le type est rendu pour trancher sans relire Channex')
})

test('LE TEST QUI COMPTE : un canal mappe mais inactif ne renvoie pas l hote a la saisie', () => {
  // ⚠ TROISIEME ECRAN DE LA JOURNEE A AFFICHER UN ETAT FAUX.
  // Un canal mappe mais inactif portait la pastille GRISE de « non connecte »,
  // et le bouton renvoyait a l'ecran A — celui qui redemande l'identifiant
  // Booking, que le canal contient deja. Thierry a refait toute la saisie pour
  // recevoir un 502.
  const cx = lire('components/connexions.js')
  assert.ok(/\.cx-dot\.pending/.test(cx), 'une pastille distincte existe pour l attente')
  assert.ok(/bookingMappedInactive \? 'pending' : 'off'/.test(cx),
    'et elle est utilisee pour un canal mappe inactif')
  assert.ok(/en attente d\\'activation/.test(cx), 'le libelle dit l etat reel')

  const bk = lire('components/booking-connect.js')
  assert.ok(bk.includes('function screenPendingActivation'), 'un ecran dedie existe')
  assert.ok(/else if \(existingChannel && existingChannel\.id\) screenPendingActivation\(\)/.test(bk),
    'un canal existant y mene, au lieu de repartir de l ecran A')
  // L'ordre compte : actif d'abord, puis mappe-inactif, puis rien.
  const iActif = bk.indexOf("existingChannel.is_active === true")
  const iPending = bk.indexOf('screenPendingActivation()\n  else screenA()')
  assert.ok(iActif > 0 && iPending > iActif, 'le canal actif garde la priorite')
  // Et l'ecran d'attente montre la cause d'un echec, sinon on renvoie l'hote
  // refaire une saisie qui n'y changera rien.
  const bloc = bk.slice(bk.indexOf('function screenPendingActivation'), bk.indexOf('// ---------- D :'))
  assert.ok(/Détail :/.test(bloc), 'la cause du refus est affichee')
  assert.ok(/api\.channel\.bcom\.activate\(S\.channelId/.test(bloc), 'et le geste manquant est propose')
})
