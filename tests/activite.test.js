// tests/activite.test.js — un bien du marche est-il REELLEMENT actif ? (spec
// §22.10, decision de Thierry du 5 octobre 2026). Fonction pure : aucune base,
// aucun reseau, aucune horloge.
//
// LE DEFAUT QU'IL EMPECHE : proposer comme comparable un bien qui ne vend plus
// (recette du 5 octobre : 5 des 10 biens « avec spa » de Toulouse etaient
// inactifs, dont 2 retires d'Airbnb et 2 chambres privees).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { lireJson } = require('../lib/airroi/json')
const { estActive, seulementActives } = require('../lib/marche/activite')

const fiche = (perf = {}, room = 'entire_home') => ({ listing_info: { listing_id: '1', room_type: room },
  performance_metrics: { ttm_days_reserved: 200, l90d_days_reserved: 30, l90d_available_days: 60, ...perf } })

test('LE TEST QUI COMPTE : logement entier ; 30 nuits sur 12 mois OU 10 sur 90 jours ; au moins 1 nuit ouverte sur 90 jours', () => {
  assert.equal(estActive(fiche()), true)
  assert.equal(estActive(fiche({}, 'private_room')), false, 'une chambre privee n est pas un logement entier')
  assert.equal(estActive(fiche({ ttm_days_reserved: 30, l90d_days_reserved: 0 })), true, '30 nuits sur 12 mois suffisent')
  assert.equal(estActive(fiche({ ttm_days_reserved: 29, l90d_days_reserved: 9 })), false)
  assert.equal(estActive(fiche({ ttm_days_reserved: 12, l90d_days_reserved: 10 })), true, 'une annonce recente : 10 nuits sur 90 jours')
  assert.equal(estActive(fiche({ l90d_available_days: 0 })), false, 'calendrier mort')
})

test('un indicateur absent ou illisible = NON actif (l absence de preuve n est pas une activite)', () => {
  assert.equal(estActive(fiche({ l90d_available_days: null })), false)
  assert.equal(estActive(fiche({ ttm_days_reserved: '200', l90d_days_reserved: undefined })), false)
  assert.equal(estActive({ listing_info: { room_type: 'entire_home' } }), false)
  assert.equal(estActive(null), false)
  assert.equal(seulementActives(null), null, 'null reste null (« a chercher »)')
})

test('VECU (Toulouse, 5 octobre 2026) : la vraie reponse de la recherche des actifs ne porte que des biens actifs selon la regle', () => {
  const nouvelle = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'actifs-jacuzzi-toulouse-2026-10-05.json'), 'utf8')).results
  assert.equal(nouvelle.filter(estActive).length, 10, 'la nouvelle recherche ne rend que des actifs')
})
