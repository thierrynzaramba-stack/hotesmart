// tests/projection-ecran.test.js — quelle nuit l'ecran « Prediction de prix »
// projette, et pourquoi (lib/yield/projection.js). 23 septembre 2026.
//
// LE DEFAUT QU'ILS EMPECHENT : un bien ferme a la vente qui ne montre aucun
// prix (impossible de verifier avant d'ouvrir plus large) — et, a l'inverse,
// une nuit ou l'hote a pose SON prix qui s'afficherait au prix de YieldFlow, ou
// une indisponibilite de l'hote qu'on lui dirait de « rouvrir » au calendrier.
//
// CONTRE-EPREUVE (REVIEW.md regle 19) : ces tests rougissent contre la regle
// d'avant 4431959 (« ouverte !== false ») pour les nuits fermees, et contre
// 4431959 lui-meme pour la nuit fermee avec un prix de l'hote et le motif
// « fermeture » (constats de la review).

const test = require('node:test')
const assert = require('node:assert')
const { estProjection, motifProjection } = require('../lib/yield/projection')

const base = { vendue: false, delai: 30, ouverte: true, horsFenetre: false, ouvertureConnue: true, aUneLigne: true, prixHote: null }
const P = x => estProjection({ ...base, ...x })

test('LE TEST QUI COMPTE : la table de verite de la projection', () => {
  assert.equal(P({}), false, 'ouverte et au calendrier : suggestion normale, pas de projection')
  assert.equal(P({ ouverte: false }), true, 'FERMEE : projetee (demande de Thierry)')
  assert.equal(P({ ouverte: false, prixHote: 150 }), false, 'fermee avec le prix de l hote : « votre prix » garde la ligne')
  assert.equal(P({ ouverte: null, horsFenetre: true, aUneLigne: false }), true, 'hors fenetre')
  assert.equal(P({ ouverte: null, aUneLigne: false }), true, 'sans ligne, ouverture connue')
  assert.equal(P({ ouverte: null, aUneLigne: false, ouvertureConnue: false }), false, 'ouverture inconnue : on ne sait rien, rien de projete')
  assert.equal(P({ ouverte: false, vendue: true }), false, 'vendue : jamais')
  assert.equal(P({ ouverte: false, delai: -1 }), false, 'passee : jamais')
})

test('LE TEST QUI COMPTE : chaque nuit projetee dit SA condition', () => {
  const M = x => motifProjection({ ouverte: false, horsFenetre: false, fermeeParLHote: false, fermeturesLisibles: true, ...x })
  assert.equal(M({}), 'fermee', 'fermee a la vente : se rouvre au calendrier')
  assert.equal(M({ fermeeParLHote: true }), 'fermeture', 'indisponibilite de l hote : se libere dans l indisponibilite, jamais « rouvrez-la »')
  assert.equal(M({ fermeturesLisibles: false }), 'fermee_inconnu', 'on ne sait pas laquelle : texte neutre')
  assert.equal(M({ ouverte: null, horsFenetre: true }), 'fenetre')
  assert.equal(M({ ouverte: null }), 'non_renseignee')
})
