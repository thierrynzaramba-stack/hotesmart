// tests/porte-ota-execution.test.js
// LA PORTE DU REJEU, EXECUTEE — PAS LUE.
//
// ⚠ POURQUOI CE FICHIER EXISTE. Mon test du plafond faisait
// `plafond.indexOf('noterArretOta')` sur la SOURCE de `lib/cron-messages.js` :
// il mesurait qu'une ligne etait ECRITE, pas qu'elle s'EXECUTE. Il est reste
// VERT pendant que la branche qui la portait etait devenue inatteignable — une
// pre-porte placee en amont rendait `!ok` et retournait sans rien poser. Donc :
// cinq refus en 24 h, puis plus aucune alarme, et le message repartait tout
// seul le lendemain quand la fenetre de comptage s'effacait. Constat HAUT d'une
// revue independante, verifie avant correction.
//
// Ici, on APPELLE `porteOta` avec un faux Supabase et un faux `reportIncident`,
// et on regarde ce qui est reellement pose.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')

const racine = path.join(__dirname, '..')

// ─── Le double de Supabase : il rend les lignes qu'on lui pose, par type ─────
// `lireLignes` enchaine .select().eq('type', T).ilike(...)[.gte(...)].order().limit()
let LIGNES = {}
let PANNE = null
function requete () {
  const o = {
    _type: null,
    select () { return o },
    eq (col, val) { if (col === 'type') o._type = val; return o },
    ilike () { return o },
    gte () { return o },
    order () { return o },
    limit () {
      if (PANNE) return Promise.resolve({ data: null, error: { message: PANNE } })
      return Promise.resolve({ data: LIGNES[o._type] || [], error: null })
    }
  }
  return o
}
require.cache[require.resolve('@supabase/supabase-js')] = {
  id: 'faux-supabase', filename: 'faux-supabase', loaded: true,
  exports: { createClient: () => ({ from: () => requete() }) }
}

// ─── Le double de l'alerteur : il enregistre, il ne telephone a personne ─────
const ALERTES = []
require.cache[require.resolve(path.join(racine, 'lib/founder-notify.js'))] = {
  id: 'faux-notify', filename: 'faux-notify', loaded: true,
  exports: { reportIncident: async (type, opts) => { ALERTES.push({ type, ...opts }) } }
}

const { porteOta, MAX_TENTATIVES_OTA, TYPE_ARRET_OTA, TYPE_ECHEC_OTA, cleArret } =
  require(path.join(racine, 'lib/envoi-ota.js'))

const CTX = { userId: 'u1', propertyId: 'p1', propertyName: 'La bulle',
  bookingId: '42', templateId: 't7', eventType: 'arrival', voyageur: 'Lea' }
const vieille = (minutes) => ({ id: 'x', created_at: new Date(Date.now() - minutes * 60000).toISOString() })

test.beforeEach(() => { LIGNES = {}; PANNE = null; ALERTES.length = 0 })

test('LE TEST QUI COMPTE : au plafond, la porte POSE l arret et alerte UNE fois', async () => {
  // Cinq refus comptes dans les 24 h : le plafond est atteint.
  LIGNES[TYPE_ECHEC_OTA] = Array.from({ length: MAX_TENTATIVES_OTA }, (_, i) => vieille(30 + i * 60))
  const r = await porteOta(CTX)
  assert.equal(r.ok, false, 'le message n est pas tente')
  assert.equal(r.motif, 'plafond')
  // ⚠ ET C EST ICI QUE LE TEST PRECEDENT MENTAIT : il verifiait la ligne, pas
  // l execution. On exige l EFFET.
  const arrets = ALERTES.filter(a => a.type === TYPE_ARRET_OTA)
  assert.equal(arrets.length, 1, 'un arret est pose, et un seul')
  assert.equal(arrets[0].threshold, 1, 'il reveille l hote tout de suite')
  assert.match(arrets[0].detail, new RegExp(cleArret(CTX.bookingId, CTX.templateId)),
    'il porte sa cle, donc la porte le relira au tick suivant')
  assert.match(arrets[0].detail, /NE PARTIRA PAS/)
  assert.match(arrets[0].detail, new RegExp(`${MAX_TENTATIVES_OTA} tentatives`),
    'et le compte des tentatives, que l abandon portait avant lui')
  assert.match(arrets[0].detail, /\/messages/, 'et le geste qui debloque')
  // ⚠ UNE SEULE ALARME AU TOTAL : `noterAbandonOta` doublait celle-ci sous un
  // autre type, donc deux cartes, deux SMS et deux e-mails pour un seul echec
  // (l anti-spam de reportIncident est cle sur (type, property_id), il ne
  // deduplique pas entre types DIFFERENTS).
  assert.equal(ALERTES.length, 1, 'une seule alarme pour un seul echec')
})

test('LE TEST QUI COMPTE : au tick suivant, l arret bloque SANS realerter', async () => {
  LIGNES[TYPE_ARRET_OTA] = [vieille(5)]
  LIGNES[TYPE_ECHEC_OTA] = Array.from({ length: MAX_TENTATIVES_OTA }, (_, i) => vieille(30 + i * 60))
  const r = await porteOta(CTX)
  assert.equal(r.ok, false)
  assert.equal(r.motif, 'arret', 'l arret est lu AVANT le plafond')
  assert.equal(ALERTES.length, 0, 'et il ne realerte pas : une alarme, une fois')
})

test('un message sans refus passe la porte, et rien n est pose', async () => {
  const r = await porteOta(CTX)
  assert.equal(r.ok, true)
  assert.equal(ALERTES.length, 0)
})

test('une panne de LECTURE laisse tenter, et n arrete rien', async () => {
  // Fail-safe dans le bon sens : un message abandonne par une panne de lecture
  // serait le pire des deux maux.
  PANNE = 'connexion perdue'
  const r = await porteOta(CTX)
  assert.equal(r.ok, true)
  assert.equal(r.motif, 'lecture_impossible')
  assert.equal(ALERTES.length, 0, 'aucun arret sur une panne de lecture')
})

test('en palier, la porte refuse sans rien arreter : le message repassera', async () => {
  LIGNES[TYPE_ECHEC_OTA] = [vieille(1)]
  const r = await porteOta(CTX)
  assert.equal(r.ok, false)
  assert.equal(r.motif, 'palier')
  assert.equal(ALERTES.length, 0, 'un palier n est pas un abandon')
})
