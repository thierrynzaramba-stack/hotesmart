// tests/creation-bien-garde-appelee.test.js
//
// ⚠ POURQUOI CE FICHIER EXISTE ALORS QUE DEUX AUTRES PARLENT DEJA DE CETTE
// GARDE. Parce qu'aucun des deux ne la MESURE. Review du 22 octobre 2026, deux
// mutations sur une copie de l'arbre :
//
//   · `if (false && !estTitulaireDuCompte({…}))` — garde titulaire neutralisee
//     -> 106 tests, 106 verts ;
//   · `compteDelegue: true` retire de la garde du POST — le defaut EXACT du
//     19 octobre 2026, celui qui a coute une propriete provisionnee chez le
//     partenaire -> 106 tests, 106 verts.
//
// Les motifs textuels survivaient parce qu'ils sont satisfaits AILLEURS dans le
// meme fichier : `compteDelegue: true` par la garde du GET et par celle de
// `relever_canaux`, `res.status(403)` par d'autres refus, `estTitulaireDuCompte`
// par le `require`. Et la tranche de `creation-bien-titulaire.test.js` contient
// la garde de `relever_canaux`, qui porte son propre `compteDelegue`.
//
// C'est la regle 20 de REVIEW.md, mot pour mot : « un controle de securite
// verifie un COMPORTEMENT, jamais une forme de code. Appeler, pas lire. »
// On appelle donc le handler, et on exige le refus.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const TITULAIRE = '11111111-1111-1111-1111-111111111111'
const MEMBRE = '22222222-2222-2222-2222-222222222222'

// Ce que la garde d'entree rendra : pilote par chaque test.
const garde = { ok: true, userId: MEMBRE, accountUserId: TITULAIRE }
// Tout appel au partenaire est une FAUTE ici : le refus doit tomber avant.
const appelsPartenaire = []

const CHEMIN_PERM = path.join(__dirname, '..', 'lib', 'require-permission.js')
const vraiPermission = require(CHEMIN_PERM)

const origine = Module._load
Module._load = function (demande, parent) {
  if (demande === '@supabase/supabase-js') {
    // L'authentification repond (l'endpoint commence par la), mais LA BASE EST
    // FERMEE : si le refus arrivait apres une lecture ou une ecriture, ce test
    // leverait au lieu de rendre 403, et on le saurait.
    return {
      createClient: () => ({
        auth: { getUser: async () => ({ data: { user: { id: garde.userId } }, error: null }) },
        from () { throw new Error('la base ne doit pas etre touchee : le refus vient AVANT') }
      })
    }
  }
  if (demande === '../lib/require-permission' || demande === './require-permission') {
    return {
      ...vraiPermission,
      requirePermission: async (req, res, opts) => {
        // ⚠ ON MEMORISE LES OPTIONS : c'est `compteDelegue` qui fait venir le
        // compte cible de l'en-tete. Sans lui, `accountUserId` retombe sur
        // l'appelant, et tout le monde est titulaire de son propre compte.
        garde.vues = garde.vues || []
        garde.vues.push(opts)
        if (!garde.ok) { res.status(403).json({ error: 'refus de la garde' }); return { ok: false } }
        // ⚠ LE COMPTE CIBLE VIENT DE L'EN-TETE DE LA REQUETE, PAS D'UNE VARIABLE.
        // Premiere version : il etait injecte par `garde.accountUserId`, donc le
        // test prouvait « le handler DEMANDE compteDelegue et refuse un non
        // titulaire », mais pas « la requete qui porte l'en-tete atteint la
        // garde ». Un handler qui appellerait la garde avec un `x-compte`
        // efface restait vert (angle mort releve a la re-review du 22 octobre
        // 2026). On rejoue donc `compteDemande()` sur les VRAIS en-tetes.
        const entete = req && req.headers && req.headers['x-compte']
        const compte = opts && opts.compteDelegue && entete ? entete : garde.userId
        return { ok: true, userId: garde.userId, accountUserId: compte, contexte: {} }
      }
    }
  }
  return origine.apply(this, arguments)
}

// `global.fetch` est le seul chemin vers le partenaire : on le ferme.
const vraiFetch = global.fetch
global.fetch = async (url, ...r) => {
  appelsPartenaire.push(String(url))
  throw new Error('appel partenaire interdit dans ce test')
}

const handler = require('../api/channel-property.js')

function fausseReponse () {
  const r = { code: null, corps: null, entetes: {} }
  r.setHeader = (k, v) => { r.entetes[k] = v }
  r.status = (c) => { r.code = c; return r }
  r.json = (o) => { r.corps = o; return r }
  r.end = () => r
  return r
}

const corpsValide = {
  name: 'Studio Recette', capacity: 2, currency: 'EUR', country: 'FR',
  base_price: 80, address: null, city: null, zip_code: null,
  included_guests: null, extra_guest_fee: null
}

async function creer ({ appelant, compteVise }) {
  garde.ok = true
  garde.userId = appelant
  garde.accountUserId = compteVise
  garde.vues = []
  appelsPartenaire.length = 0
  const res = fausseReponse()
  await handler({
    method: 'POST',
    query: {},
    // L'en-tete de compte, comme le navigateur l'envoie en mode delegue.
    headers: { authorization: 'Bearer jeton-de-test', 'x-compte': compteVise },
    body: { ...corpsValide }
  }, res)
  return res
}

test('LE TEST QUI COMPTE : un membre qui vise le compte d un autre recoit 403', async () => {
  // ⚠ C'EST LA MESURE DU 19 OCTOBRE 2026, REJOUEE. Avant le correctif, ce meme
  // appel rendait 400 — le refus de la VALIDATION, qui vient APRES la garde.
  // Un 400 ici voudrait dire que la garde a dit OUI.
  const res = await creer({ appelant: MEMBRE, compteVise: TITULAIRE })
  assert.equal(res.code, 403, `attendu 403, obtenu ${res.code} — la garde a laisse passer`)
  assert.match(String(res.corps && res.corps.error), /titulaire/i,
    'le refus doit dire POURQUOI : sinon l hote ne peut rien en faire')
})

test('LE TEST QUI COMPTE : le refus tombe AVANT tout appel au partenaire', async () => {
  // Ce chemin provisionne une propriete, un type de chambre et un plan
  // tarifaire. Un refus qui arrive apres ne repare rien : la propriete existe
  // deja chez le partenaire.
  await creer({ appelant: MEMBRE, compteVise: TITULAIRE })
  assert.deepEqual(appelsPartenaire, [],
    'aucun appel au partenaire ne doit partir avant le refus')
})

test('LE TEST QUI COMPTE : la garde demande bien `compteDelegue`', async () => {
  // ⚠ SANS CE DRAPEAU, LA GARDE NE FILTRE RIEN, POUR PERSONNE : le compte cible
  // retombe sur l'appelant, et tout utilisateur authentifie est titulaire de
  // son propre compte. C'est exactement le defaut du 19 octobre, et c'est la
  // seule facon de le voir — en observant ce que le handler DEMANDE, puis le
  // refus qui en decoule.
  const res = await creer({ appelant: MEMBRE, compteVise: TITULAIRE })
  const gardeCreation = (garde.vues || []).find(o => o && o.domaine === 'reglages' && o.niveau === 'write')
  assert.ok(gardeCreation, 'la creation doit passer par une garde `reglages:write`')
  assert.equal(gardeCreation.compteDelegue, true,
    'sans `compteDelegue`, le compte cible retombe sur l appelant et la garde est ouverte')
  assert.equal(res.code, 403)
})

test('et le titulaire, lui, n est PAS refuse par cette garde', async () => {
  // ⚠ LA CONTRE-EPREUVE DU REFUS : un garde-fou qui refuse tout le monde est
  // aussi faux qu'un garde-fou qui n'arrete personne. Le parcours normal — un
  // hote qui cree son premier logement — doit franchir la garde. Il echouera
  // plus loin (la base est fermee dans ce test), mais PAS en 403.
  const res = await creer({ appelant: TITULAIRE, compteVise: TITULAIRE })
  assert.notEqual(res.code, 403,
    'le titulaire ne doit pas etre arrete par la garde de titularite')
})

test('un refus de la garde d entree ne devient jamais un 200', async () => {
  garde.ok = false
  const res = fausseReponse()
  await handler({ method: 'POST', query: {}, headers: { authorization: 'Bearer jeton-de-test' }, body: { ...corpsValide } }, res)
  assert.equal(res.code, 403)
  garde.ok = true
})

test.after(() => {
  Module._load = origine
  global.fetch = vraiFetch
})
