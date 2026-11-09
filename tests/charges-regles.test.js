// tests/charges-regles.test.js — les règles pures du compte de charges
// (spec docs/specs/spec-compte-de-charges.md : Q5, Q6, Q14, Q17 ; §6).
// Rien n'est inventé : une valeur illisible devient `null`, jamais 0.

const test = require('node:test')
const assert = require('node:assert/strict')
const R = require('../lib/charges/regles')

test('les montants : euros -> centimes, et une valeur illisible vaut null, jamais 0', () => {
  assert.equal(R.centimesDepuisEuros(12.5), 1250)
  assert.equal(R.centimesDepuisEuros('1 234,56 €'), 123456)
  assert.equal(R.centimesDepuisEuros(0), 0, 'une TVA à 0 lue reste 0 (Q17)')
  assert.equal(R.centimesDepuisEuros(null), null)
  assert.equal(R.centimesDepuisEuros(''), null)
  assert.equal(R.centimesDepuisEuros('douze'), null)
  assert.equal(R.centimesDepuisEuros(-3), null, 'un montant négatif n’est pas une facture lue')
  assert.equal(R.centimesDepuisEuros(1e12), null)
})

test('les centimes saisis : entier >= 0, vide = null, le reste est INVALIDE (undefined)', () => {
  assert.equal(R.centimesSaisis(1200), 1200)
  assert.equal(R.centimesSaisis(''), null)
  assert.equal(R.centimesSaisis(null), null)
  assert.equal(R.centimesSaisis(12.5), undefined)
  assert.equal(R.centimesSaisis(-1), undefined)
  assert.equal(R.centimesSaisis('abc'), undefined)
})

test('les dates : une date qui EXISTE, sinon null', () => {
  assert.equal(R.dateValide('2026-11-09'), '2026-11-09')
  assert.equal(R.dateValide('2026-02-30'), null)
  assert.equal(R.dateValide('09/11/2026'), null)
  assert.equal(R.dateValide('1999-12-31'), null)
})

test('le SIRET : 9 ou 14 chiffres, espaces retirés', () => {
  assert.equal(R.siretNormalise('123 456 789 00012'), '12345678900012')
  assert.equal(R.siretNormalise('123456789'), '123456789')
  assert.equal(R.siretNormalise('1234'), null)
})

test('le type d’un fichier se lit dans ses octets, jamais dans son nom', () => {
  assert.equal(R.typeReel(Buffer.from('%PDF-1.7 ...')), 'application/pdf')
  assert.equal(R.typeReel(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0])), 'image/jpeg')
  assert.equal(R.typeReel(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), 'image/png')
  assert.equal(R.typeReel(Buffer.from('<html>')), null)
  assert.equal(R.typeReel(Buffer.alloc(0)), null)
})

test('la lecture normalisée : toute forme fausse devient null ; la catégorie est dans la liste', () => {
  const l = R.normaliserLecture({
    fournisseur_nom: '  EDF  ', fournisseur_siret: '552 081 317 00015', numero_facture: 'F-12',
    date_facture: '2026-10-31', date_echeance: 'demain', montant_ht: 100, montant_tva: '20,00',
    montant_ttc: 120, destinataire_nom: 'SCI Le Florian', destinataire_siret: null,
    categorie: 'energie', confiance: { montant_ttc: 0.97, fournisseur_nom: 3 }
  })
  assert.equal(l.fournisseur_nom, 'EDF')
  assert.equal(l.fournisseur_siret, '55208131700015')
  assert.equal(l.date_echeance, null)
  assert.equal(l.montant_tva_cents, 2000)
  assert.equal(l.categorie, 'energie')
  assert.equal(l.confiance.fournisseur_nom, 1, 'la confiance est bornée à [0, 1]')
  assert.equal(R.normaliserLecture({ categorie: 'vacances' }).categorie, null)
  assert.equal(R.normaliserLecture(null).montant_ttc_cents, null)
})

test('Q6 : l’entité proposée par SIRET, puis par nom, parmi les entités NON archivées', () => {
  const entites = [
    { id: 'e1', nom: 'SCI Le Florian', siret: '12345678900012', archivee_le: null },
    { id: 'e2', nom: 'Thierry Nzaramba', siret: null, archivee_le: null },
    { id: 'e3', nom: 'Ancienne SARL', siret: '99999999900011', archivee_le: '2026-01-01T00:00:00Z' }
  ]
  assert.equal(R.proposerEntite(entites, { destinataire_siret: '12345678900012' }), 'e1')
  assert.equal(R.proposerEntite(entites, { destinataire_siret: '123456789' }), 'e1', 'le SIREN suffit')
  assert.equal(R.proposerEntite(entites, { destinataire_nom: 'thierry  NZARAMBA' }), 'e2')
  assert.equal(R.proposerEntite(entites, { destinataire_siret: '99999999900011' }), null,
    'une entité archivée n’est jamais proposée')
  assert.equal(R.proposerEntite(entites, {}), null)
})

test('Q6 : deux candidates possibles -> aucune proposition (l’hôte choisit)', () => {
  const entites = [
    { id: 'a', nom: 'Thierry Nzaramba', archivee_le: null },
    { id: 'b', nom: 'Thierry Nzaramba', archivee_le: null }
  ]
  assert.equal(R.proposerEntite(entites, { destinataire_nom: 'Thierry Nzaramba' }), null)
})

test('Q14 : la clé « même fournisseur, même numéro » ; une moitié de preuve ne fait pas de doublon', () => {
  const a = R.cleFournisseurNumero({ fournisseur_siret: '12345678900012', numero_facture: 'F 12' })
  const b = R.cleFournisseurNumero({ fournisseur_siret: '123456789', numero_facture: 'f-12' })
  assert.equal(a, b)
  assert.equal(R.cleFournisseurNumero({ fournisseur_nom: 'EDF', numero_facture: null }), null)
  assert.equal(R.cleFournisseurNumero({ numero_facture: 'F12' }), null)
})

test('le jour d’une charge : la date de la facture, sinon le jour de réception MARQUÉ', () => {
  assert.deepEqual(R.jourDeLaCharge('2026-10-31', '2026-11-09'), { jour: '2026-10-31', date_repli: false })
  assert.deepEqual(R.jourDeLaCharge(null, '2026-11-09'), { jour: '2026-11-09', date_repli: true })
})
