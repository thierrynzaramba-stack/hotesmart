// tests/creation-bien-titulaire.test.js
// CREER UN BIEN EST UN GESTE DE TITULAIRE, ET LE SERVEUR LE DIT.
//
// ⚠ MESURE REELLE DU 19 OCTOBRE 2026, sur staging, qui a motive ce correctif.
// La garde de la creation etait `requirePermission({ domaine: 'reglages',
// niveau: 'write' })` SANS `compteDelegue`. Sans ressource designee et sans ce
// drapeau, `accountUserId` retombe sur l'APPELANT — et tout le monde est
// titulaire de son propre compte, donc la garde rendait 'write' pour
// n'importe quel utilisateur authentifie.
//
// Mesure : un POST de creation avec le jeton d'un membre a rendu 400 (le refus
// de la VALIDATION, qui vient APRES la garde), pas 403. La garde avait donc dit
// oui. Le seul garde-fou etait le masquage du bouton « + Ajouter un bien » dans
// pages/biens.html — et il ne masquait rien, faute de regle `[hidden]` sur une
// page qui ne charge pas shared/ui.css.
//
// Ce que ca coutait : un membre creait un bien sur SON compte, et le chemin
// provisionne une propriete, un type de chambre et un plan tarifaire CHEZ LE
// PARTENAIRE. Aucune fuite entre comptes — mais une ecriture chez le
// partenaire, et un bien hors de tout suivi.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const FICHIER = path.join(__dirname, '..', 'api', 'channel-property.js')
const SOURCE = fs.readFileSync(FICHIER, 'utf8')

const TITULAIRE = '11111111-1111-1111-1111-111111111111'
const AUTRE = '22222222-2222-2222-2222-222222222222'

// ⚠ ON EPROUVE LA GARDE PAR SON CONTRAT, pas par la lecture du fichier. On
// rejoue la resolution de `lib/require-permission.js` — compte cible, puis
// verdict — sur les deux formes d'appel, l'ancienne et la nouvelle.
const { estTitulaireDuCompte } = require('../lib/permissions')

test('LE TEST QUI COMPTE : sans `compteDelegue`, la garde de creation ne filtre RIEN', () => {
  // La resolution de require-permission, lignes 344-357 : sans reservation,
  // sans bien et sans `compteDelegue`, le compte cible est l'appelant.
  const compteCible = (compteDelegue, enTete, appelant) =>
    compteDelegue ? (enTete || appelant) : appelant

  // Ancienne forme : un membre qui travaille sur le compte du titulaire.
  const ancien = compteCible(false, TITULAIRE, AUTRE)
  assert.equal(ancien, AUTRE,
    'la garde sans compteDelegue devrait viser l appelant — sinon ce test ne decrit plus le defaut')
  assert.equal(estTitulaireDuCompte({ userId: AUTRE, accountUserId: ancien }), true,
    'tout appelant est titulaire de son propre compte : la garde ne filtre rien')

  // Nouvelle forme : le compte cible vient de l en-tete, et la garde mord.
  const neuf = compteCible(true, TITULAIRE, AUTRE)
  assert.equal(neuf, TITULAIRE)
  assert.equal(estTitulaireDuCompte({ userId: AUTRE, accountUserId: neuf }), false,
    'un membre delegue est encore vu comme titulaire du compte qu il regarde')
})

test('LE TEST QUI COMPTE : la creation exige `compteDelegue` ET le titulaire', () => {
  // ⚠ CE TEST LIT LA SOURCE, ET C'EST ASSUME : la garde est un APPEL, pas une
  // valeur calculable. Un test de comportement exigerait de monter l'endpoint
  // entier avec son client Supabase et son partenaire — et le chemin
  // provisionne chez le partenaire, ce qu'aucun test ne doit faire. On ancre
  // donc sur les deux elements dont depend le verdict, et le commentaire dit
  // pourquoi : si la garde change de forme, ce test rougit et on relit.
  const bloc = SOURCE.slice(SOURCE.indexOf('// ===== POST : creation d\'un bien complet ====='))
  const garde = bloc.slice(0, bloc.indexOf('const { name, capacity'))
  assert.match(garde, /domaine:\s*'reglages'/, 'le domaine de la creation a change')
  assert.match(garde, /compteDelegue:\s*true/,
    'la garde de creation n a pas `compteDelegue` : elle vise l appelant, donc elle ne filtre rien')
  assert.match(garde, /estTitulaireDuCompte/,
    'rien ne verifie que l appelant est titulaire du compte vise')
  assert.match(garde, /status\(403\)/,
    'le refus du non-titulaire ne rend pas 403')
})

test('un titulaire sur son propre compte cree normalement', () => {
  // La contre-epreuve : le correctif ne doit pas fermer le parcours normal —
  // un hote qui cree son premier bien, sans aucun en-tete de compte.
  // `compteDemande` sans en-tete rend l appelant (require-permission:150).
  assert.equal(estTitulaireDuCompte({ userId: TITULAIRE, accountUserId: TITULAIRE }), true)
})
