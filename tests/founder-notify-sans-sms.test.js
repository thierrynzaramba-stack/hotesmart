// tests/founder-notify-sans-sms.test.js
//
// DECISION THIERRY, 8 septembre 2026 : « pas de SMS car pas d'urgence ».
// Le SMS est reserve a ce qui exige un GESTE. Un remboursement automatique n'en
// exige aucun — l'argent est rendu, le voyageur prevenu. L'e-mail part quand
// meme, et l'incident reste en base : un remboursement qui se repeterait ne doit
// pas passer inapercu.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

process.env.SUPABASE_URL = 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = 'test'

const { SANS_SMS, LABELS } = require('../lib/founder-notify')

test('le remboursement automatique n envoie PAS de SMS', () => {
  assert.ok(SANS_SMS.has('reservation_remboursee'))
})

test("l'argent en suspens REVEILLE toujours", () => {
  // ⚠ Ne jamais y mettre un incident qui demande d'agir. De l'argent encaisse
  // sans reservation attend une decision humaine, et il l'attend tout de suite.
  assert.ok(!SANS_SMS.has('paiement_issue_incertaine'))
  assert.ok(!SANS_SMS.has('paiement_orphelin'))
  assert.ok(!SANS_SMS.has('paiement_sans_reservation'))
})

test('la surreservation REVEILLE toujours', () => {
  // Le seul incident du produit qui ne se rattrape pas apres coup.
  assert.ok(!SANS_SMS.has('overbooking'))
  assert.ok(!SANS_SMS.has('stop_sell_perdu'))
})

test('chaque type sans SMS a un libelle lisible', () => {
  for (const t of SANS_SMS) {
    assert.ok(LABELS[t], `${t} n'a pas de libelle : l'e-mail afficherait le code brut`)
  }
})

test('le SMS est saute pour ce type, jamais l e-mail ni la trace', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib/founder-notify.js'), 'utf8')
  assert.match(src, /if \(FOUNDER_PHONE && !SANS_SMS\.has\(type\)\) out\.sms/)
  // L'e-mail reste inconditionnel.
  assert.match(src, /if \(FOUNDER_EMAIL\) out\.email/)
  // Et l'insertion en base precede tout envoi.
  assert.ok(src.indexOf("from('automation_incidents').insert") < src.indexOf('out.sms'))
})

test('le ménage sans personne est en PAUSE de SMS — mais pas silencieux', () => {
  // ⚠ C'EST UNE DETTE, PAS UN ACQUIS (17 septembre 2026). Un ménage sans
  // personne EXIGE un geste : c'est précisément ce que le SMS existe pour
  // porter. On le met en pause quand même, parce qu'il part aujourd'hui trop
  // souvent pour rester audible — et une alarme qu'on apprend à ignorer ne
  // protège plus rien le jour où elle dit vrai.
  // Ce qu'on accepte en échange : un trou de garde peut passer une nuit sans
  // réveiller personne.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'founder-notify.js'), 'utf8')
  const bloc = src.slice(src.indexOf('const SANS_SMS'), src.indexOf('const LABELS'))
  assert.match(bloc, /'menage_non_assigne'/)
  // ⚠ ET L'E-MAIL DOIT PARTIR QUAND MÊME. C'est ce qui sépare « en pause » de
  // « supprimé » : sans lui, l'incident deviendrait invisible hors de la base,
  // et la dette cesserait d'être payable parce qu'on ne la verrait plus.
  assert.ok(!/SANS_EMAIL|sansEmail/.test(src), 'aucun mécanisme ne coupe l\'e-mail')
  assert.match(src, /menage_non_assigne:\s*'/, 'et le type garde son libellé lisible')
})
