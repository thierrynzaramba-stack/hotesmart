// tests/presta-etat.test.js — « est-ce que cette personne recevra des menages ? »
// Lot Menages V5, fenetre de configuration. Module PUR, teste pour de vrai.
//
// ⚠ CE QUI EST EN JEU. C'est la phrase que l'hote lit en haut de la fiche, et
// la seule chose qui lui dise qu'un reglage ne produira jamais rien. Deux
// fautes la rendraient nuisible : rougir une personne qui travaille (il apprend
// a ignorer la phrase), ou verdir Lola — liee a deux biens, « elle confirme »,
// aucun jour confie — a qui le moteur ne proposera JAMAIS un ménage.
//
// ⚠ ON TESTE L'INVARIANT, PAS LE TEXTE : le module ne rend aucune phrase, les
// libelles sont i18n et vivent dans la page.

const test = require('node:test')
const assert = require('node:assert/strict')

const { etatDeLaPrestataire, defautDeLaLiaison, formeDesJours } =
  require('../shared/presta-etat.js')

const BIENS = { 101: 'La bulle', 102: 'Cœur de vie 23', 103: 'Ofuro Futari' }
const nomDuBien = (id) => (Object.prototype.hasOwnProperty.call(BIENS, id) ? BIENS[id] : null)
const lien = (o = {}) => ({ property_id: '101', active: true, requires_ack: true,
                            rang: 1, weekdays: [2, 3], ...o })
const etat = (liaisons) => etatDeLaPrestataire({ liaisons, nomDuBien })

// ─── Les trois etats d'une liaison, cote moteur ─────────────────────────────

test('weekdays [] = AUCUN jour, quel que soit l\'engagement', async () => {
  assert.equal(defautDeLaLiaison(lien({ weekdays: [] })), 'aucun_jour')
  assert.equal(defautDeLaLiaison(lien({ weekdays: [], requires_ack: false })), 'aucun_jour',
    'meme d\'office : sans jour attitre, elle n\'est jamais candidate')
})

test('weekdays absent = TOUS les jours : suffisant d\'office, pas si elle confirme', async () => {
  assert.equal(defautDeLaLiaison(lien({ weekdays: null, requires_ack: false })), null,
    'une porteuse d\'office ne confirme rien : tous les jours lui vont')
  assert.equal(defautDeLaLiaison(lien({ weekdays: null, requires_ack: true })), 'jours_a_regler',
    'LE CAS LOLA : candidate tous les jours, mais la file de proposition ne retient que les jours REGLES')
})

test('une colonne d\'engagement absente est traitee comme « elle confirme »', async () => {
  // Le meme defaut prudent que garde.js:73 — on ne devient pas responsable
  // d'un logement par omission d'un champ.
  const l = lien({ weekdays: null })
  delete l.requires_ack
  assert.equal(defautDeLaLiaison(l), 'jours_a_regler')
})

test('une liaison inactive n\'existe pas pour le moteur', async () => {
  assert.equal(defautDeLaLiaison(lien({ active: false })), 'inactive')
  assert.deepEqual(etat([lien({ active: false })]).etat, 'rien')
  assert.equal(etat([lien({ active: false })]).motif, 'aucun_bien',
    'desactivee, donc aucun logement ne lui est confie')
})

// ─── Vert ───────────────────────────────────────────────────────────────────

test('deux biens reglés : vert, et les biens sortent dans l\'ordre du TOUR', async () => {
  const e = etat([
    lien({ property_id: '103', rang: 2, weekdays: [0, 6] }),
    lien({ property_id: '101', rang: 1, weekdays: [2] })
  ])
  assert.equal(e.etat, 'ok')
  assert.deepEqual(e.biens.map(b => b.nom), ['La bulle', 'Ofuro Futari'],
    'le rang le plus petit d\'abord : c\'est lui qui compose le tour')
  assert.equal(e.action, null, 'rien a reparer, aucun bouton')
})

test('un bien mal reglé PARMI d\'autres ne rougit pas l\'en-tete (« jamais d\'ambre »)', async () => {
  // Decision de Thierry : `rien` est reserve a « elle ne recevra AUCUN
  // menage ». Un bien en defaut porte son avertissement sur sa ligne.
  const e = etat([lien({ property_id: '101', weekdays: [2] }),
                  lien({ property_id: '102', weekdays: null })])
  assert.equal(e.etat, 'ok')
  assert.deepEqual(e.biens.map(b => b.nom), ['La bulle'])
  assert.deepEqual(e.biensEnDefaut.map(b => b.nom), ['Cœur de vie 23'])
  assert.equal(e.action, 'jours', 'le geste reste offert, sans crier')
})

test('d\'office sans aucun jour precise : vert, elle recoit tout', async () => {
  const e = etat([lien({ weekdays: null, requires_ack: false })])
  assert.equal(e.etat, 'ok')
  assert.equal(e.biens[0].dOffice, true)
  assert.equal(e.biens[0].jours, null)
  assert.equal(e.biens[0].forme.cle, 'tous')
})

// ─── Rouge ──────────────────────────────────────────────────────────────────

test('LE CAS LOLA : deux biens confies, aucun jour, elle confirme → rouge', async () => {
  const e = etat([lien({ property_id: '101', weekdays: null }),
                  lien({ property_id: '102', weekdays: null })])
  assert.equal(e.etat, 'rien')
  assert.equal(e.motif, 'jours_a_regler')
  assert.equal(e.action, 'jours')
  assert.deepEqual(e.biensEnDefaut.map(b => b.nom), ['Cœur de vie 23', 'La bulle'])
})

test('aucune liaison du tout → rouge, et le geste est « choisir ses biens »', async () => {
  const e = etat([])
  assert.equal(e.etat, 'rien')
  assert.equal(e.motif, 'aucun_bien')
  assert.equal(e.action, 'biens')
})

test('tous ses biens a zero jour → rouge, motif « aucun jour »', async () => {
  const e = etat([lien({ weekdays: [] })])
  assert.equal(e.etat, 'rien')
  assert.equal(e.motif, 'aucun_jour', 'un choix explicite de l\'hote, pas un oubli de reglage')
  assert.equal(e.action, 'jours')
})

// ─── Le perimetre de l'appelant ─────────────────────────────────────────────

test('un bien hors du perimetre est IGNORE, jamais rendu sans nom', async () => {
  // Un delegue ne voit qu'une partie des biens : une ligne « (sans nom) » ne
  // veut rien dire, et la compter en defaut l'alerterait sur un bien qu'il ne
  // peut meme pas ouvrir.
  const e = etat([lien({ property_id: '999', weekdays: null }),
                  lien({ property_id: '101', weekdays: [2] })])
  assert.equal(e.etat, 'ok')
  assert.deepEqual(e.biens.map(b => b.nom), ['La bulle'])
  assert.deepEqual(e.biensEnDefaut, [])
})

test('tous ses biens hors perimetre : « aucun bien », pas une fausse alerte de jours', async () => {
  const e = etat([lien({ property_id: '999', weekdays: null })])
  assert.equal(e.etat, 'rien')
  assert.equal(e.motif, 'aucun_bien')
})

// ─── La forme des jours, pour une phrase lisible ────────────────────────────

test('formeDesJours resume ce qui se resume, et liste le reste', async () => {
  assert.equal(formeDesJours(null).cle, 'tous', 'aucun jour precise = tous les jours')
  assert.equal(formeDesJours([0, 1, 2, 3, 4, 5, 6]).cle, 'tous')
  assert.equal(formeDesJours([6, 0]).cle, 'weekend', 'samedi + dimanche, dans n\'importe quel ordre')
  assert.equal(formeDesJours([1, 2, 3, 4, 5]).cle, 'semaine')
  assert.deepEqual(formeDesJours([3, 2]), { cle: 'liste', jours: [2, 3] }, 'et les jours sont tries')
})

test('formeDesJours ecarte ce qui n\'est pas un jour de la semaine', async () => {
  // La convention du moteur est 0-6 ; une valeur hors bornes viendrait d'une
  // donnee abimee, et l'afficher inventerait un huitieme jour.
  assert.deepEqual(formeDesJours([2, 9, -1, 2]), { cle: 'liste', jours: [2] })
})

test('rang 3 existant se LIT, meme si l\'ecran n\'en propose que deux', async () => {
  // Decision de Thierry : afficher 1 et 2, mais ne jamais mentir sur une
  // liaison deja posee en rang 3.
  assert.equal(etat([lien({ rang: 3 })]).biens[0].rang, 3)
  assert.equal(etat([lien({ rang: null })]).biens[0].rang, 1, 'un rang absent vaut 1')
})
