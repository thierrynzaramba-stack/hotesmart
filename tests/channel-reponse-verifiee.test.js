// tests/channel-reponse-verifiee.test.js
// UNE REPONSE SE VERIFIE, ELLE NE SE COERCE PAS.
//
// ⚠ POURQUOI CE FICHIER EXISTE. Trouve le 19 octobre 2026 pendant la recette de
// la dette 59 : `channelCall` rangeait une reponse non-JSON en `{ raw: text }`
// et gardait le succes du code HTTP. Un `200` portant une page HTML — URL mal
// reglee, page d'erreur d'un pare-feu, maintenance — devenait donc une reponse
// VALIDE annoncant une liste vide. Pour une lecture : « ce compte n'a rien ».
// Pour une ecriture : « c'est fait ».
// Inventaire complet des consequences : docs/kb/reponse-200-sans-json.md.

// Le module construit un client Supabase au chargement : on lui donne de quoi
// se construire, jamais de quoi atteindre une base reelle.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const { channelCall } = require('../lib/channels/channex')

// Un faux partenaire : on ne sort jamais, et on choisit le corps ET l'en-tete.
function partenaireQuiRend ({ status = 200, corps = '', type = 'application/json' }) {
  const vrai = global.fetch
  // ⚠ `Response` REFUSE un corps sur un 204 : passer '' y leve une TypeError,
  // qui deviendrait un faux rouge attribue au code teste.
  global.fetch = async () => new Response(status === 204 ? null : corps, {
    status, headers: { 'content-type': type }
  })
  return { restore: () => { global.fetch = vrai } }
}

test('LE TEST QUI COMPTE : un 200 qui porte du HTML est un ECHEC', async () => {
  const f = partenaireQuiRend({ status: 200, type: 'text/html',
    corps: '<!DOCTYPE html><html><body>Not Found</body></html>' })
  try {
    const r = await channelCall('GET', '/channels')
    assert.equal(r.ok, false, 'une page HTML a ete rendue comme un succes')
    assert.equal(r.json?.errors?.code, 'reponse_non_json')
    // ⚠ ET L'EXTRAIT DU CORPS NE SORT PAS DANS LA REPONSE. Un appelant la
    // renvoyait au navigateur : une page d'erreur du partenaire porte
    // plausiblement sa marque, et le nom du partenaire ne sort jamais vers
    // l'hote. L'extrait va au journal, ou on diagnostique.
    assert.equal(JSON.stringify(r.json).includes('DOCTYPE'), false,
      'le corps du partenaire repart dans la reponse')
    assert.equal(r.status, 200, 'le statut d origine est perdu')
  } finally { f.restore() }
})

test('LE TEST QUI COMPTE : un JSON valide SANS la forme attendue est un ECHEC', async () => {
  // Du JSON, mais pas la forme JSON:API du partenaire : ni `data`, ni `meta`,
  // ni `errors`. C'est ce que rend une passerelle qui s'interpose.
  const f = partenaireQuiRend({ status: 200,
    corps: JSON.stringify({ message: 'service temporarily unavailable' }) })
  try {
    const r = await channelCall('GET', '/channels')
    assert.equal(r.ok, false, 'un corps sans `data` a ete rendu comme un succes')
    assert.equal(r.json?.errors?.code, 'forme_inattendue')
  } finally { f.restore() }
})

test('une liste VRAIMENT vide reste un succes', async () => {
  // ⚠ LA CONTRE-EPREUVE DU GUARD. Un compte sans canal rend `data: []` : c'est
  // une reponse, pas une panne. Si ce test rougit, le guard est trop large et
  // ferait passer tout compte vide pour un incident.
  const f = partenaireQuiRend({ status: 200,
    corps: JSON.stringify({ data: [], meta: { total: 0 } }) })
  try {
    const r = await channelCall('GET', '/channels')
    assert.equal(r.ok, true, 'un compte sans canal a ete pris pour une panne')
    assert.deepEqual(r.json.data, [])
  } finally { f.restore() }
})

test('un corps VIDE sur une suppression reste un succes', async () => {
  // ⚠ L'AUTRE BORD DU GUARD. `DELETE /channels/{id}` rend 204 sans corps, et
  // `/deactivate` peut rendre 200 vide. Un guard qui exige du JSON casserait la
  // deconnexion d'une annonce — un chemin d'ECRITURE, le plus couteux a casser.
  for (const status of [200, 204]) {
    const f = partenaireQuiRend({ status, corps: '' })
    try {
      const r = await channelCall('DELETE', '/channels/abc')
      assert.equal(r.ok, true, `un corps vide en ${status} a ete pris pour une panne`)
    } finally { f.restore() }
  }
})

test('un echec HTTP garde son corps et son motif d origine', async () => {
  // Le guard ne doit pas ecraser le diagnostic d'un vrai echec du partenaire.
  const f = partenaireQuiRend({ status: 422,
    corps: JSON.stringify({ errors: { code: 'validation', title: 'rate_plan_id' } }) })
  try {
    const r = await channelCall('GET', '/channels')
    assert.equal(r.ok, false)
    assert.equal(r.json?.errors?.code, 'validation')
  } finally { f.restore() }
})

// ─── Les portes trouvees par la revue de 5739d02 ────────────────────────────

test('LE TEST QUI COMPTE : un 200 SANS CORPS sur une LECTURE est un echec', async () => {
  // ⚠ LA LIGNE QUI ROUVRAIT LE DEFAUT. La tolerance du corps vide, posee pour
  // le 204 d'un DELETE, etait aveugle a la methode : un `GET /bookings` qui
  // repond 200 sans corps rendait `data: []`, donc « ce bien n'a aucune
  // reservation » — et par getPropertyRaw, une fiche complete ecrasee par une
  // fiche amputee.
  for (const corps of ['', '   ']) {
    const f = partenaireQuiRend({ status: 200, corps })
    try {
      const r = await channelCall('GET', '/channels')
      assert.equal(r.ok, false, `un corps vide (${JSON.stringify(corps)}) est passe pour une liste vide`)
      assert.equal(r.json?.errors?.code, 'reponse_vide')
    } finally { f.restore() }
  }
})

test('un 200 sans corps sur une ECRITURE reste un succes', async () => {
  // ⚠ L'AUTRE BORD. Le partenaire rend ce qu'il veut sur une ecriture, et
  // c'est le code HTTP qui dit si elle a eu lieu. Exiger une forme casserait
  // des reponses legitimes non mesurees.
  for (const m of ['POST', 'PUT', 'DELETE']) {
    const f = partenaireQuiRend({ status: 200, corps: '' })
    try {
      const r = await channelCall(m, '/channels/abc')
      assert.equal(r.ok, true, `un corps vide en ${m} a ete pris pour une panne`)
    } finally { f.restore() }
  }
})

test('LE TEST QUI COMPTE : `data: null` n est pas une liste vide', async () => {
  // La cle presente ne suffit pas : `{"data": null}` passait pour un succes, et
  // les lecteurs de listes le coercaient en `[]`. Le defaut, par une troisieme
  // porte.
  const f = partenaireQuiRend({ status: 200, corps: JSON.stringify({ data: null }) })
  try {
    const r = await channelCall('GET', '/channels')
    assert.equal(r.ok, false, '`data: null` est passe pour un succes')
    assert.equal(r.json?.errors?.code, 'forme_inattendue')
  } finally { f.restore() }
})

test('un JSON sans forme est refuse en LECTURE, accepte en ecriture', async () => {
  // ⚠ L'ASYMETRIE, EPROUVEE DANS LES DEUX SENS. `POST /applications/install`
  // rend peut-etre `{}` — un stub du depot le suggere, et on ne peut pas le
  // mesurer sans ECRIRE chez le partenaire. On ne casse donc pas les ecritures
  // sur une forme qu'on n'a pas mesuree ; la lecture, elle, exige sa donnee.
  const f1 = partenaireQuiRend({ status: 200, corps: '{}' })
  try {
    const r = await channelCall('GET', '/channels')
    assert.equal(r.ok, false, '`{}` est passe pour une lecture valide')
    assert.equal(r.json?.errors?.code, 'forme_inattendue')
  } finally { f1.restore() }

  const f2 = partenaireQuiRend({ status: 200, corps: '{}' })
  try {
    const r = await channelCall('POST', '/applications/install', { x: 1 })
    assert.equal(r.ok, true, '`{}` a fait echouer une ecriture : POST /applications/install casse')
  } finally { f2.restore() }
})

test('un corps JSON qui n est pas un objet est refuse', async () => {
  for (const corps of ['[]', 'null', '42', '"texte"']) {
    const f = partenaireQuiRend({ status: 200, corps })
    try {
      const r = await channelCall('GET', '/channels')
      assert.equal(r.ok, false, `${corps} est passe pour un succes`)
    } finally { f.restore() }
  }
})

test('une page HTML est refusee aussi sur une ECRITURE', async () => {
  // Ce qui signe la page d'erreur, c'est qu'elle n'est pas du JSON — et ca vaut
  // pour les poussees de prix et de disponibilite, qui se croyaient faites.
  const f = partenaireQuiRend({ status: 200, type: 'text/html',
    corps: '<html><body>Service Unavailable</body></html>' })
  try {
    const r = await channelCall('POST', '/availability', { values: [] })
    assert.equal(r.ok, false, 'une poussee de dispo s est crue faite sur une page HTML')
    assert.equal(r.json?.errors?.code, 'reponse_non_json')
  } finally { f.restore() }
})
