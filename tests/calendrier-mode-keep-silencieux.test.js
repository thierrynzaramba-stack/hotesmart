// tests/calendrier-mode-keep-silencieux.test.js
// LE DEFAUT : « Enregistre et publie » alors que rien ne partait.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('LE TEST QUI COMPTE : le mode `keep` PREVIENT l hote, il ne se contente pas d un drapeau', () => {
  // ⚠ MESURE DU 10 SEPTEMBRE 2026. Thierry a rouvert le samedi 31 octobre dans
  // le calendrier, lu « Enregistre et publie », et attendu QUINZE MINUTES
  // devant une date restee fermee sur Booking et Airbnb.
  //
  // Les trois maillons, verifies un par un : le coeur portait bien
  // `stop_sell = false` et 160 € ; AUCUNE poussee n'est partie
  // (`rate_sync_mode = 'keep'`, `last_fullsync_at = jamais`) ; Channex detenait
  // toujours `stop_sell: true, availability: 0`.
  //
  // `api/calendar.js` notait `task_ids.restrictions_skipped = 'mode_keep'` —
  // un drapeau POUR LE CODE. Le front ne lit que `warnings`, vide, donc il
  // affichait le message de succes. Le mode `keep` est un choix legitime ; son
  // SILENCE ne l'etait pas.
  const src = lire('api/calendar.js')

  const i = src.indexOf("taskIdsSave.restrictions_skipped = 'mode_keep'")
  assert.ok(i > 0, 'le drapeau existe toujours')
  // L'avertissement doit etre pose DANS la meme branche, juste apres le drapeau.
  const branche = src.slice(i, i + 1800)
  assert.ok(/pushWarnings\.push\(/.test(branche),
    'la branche mode_keep pousse un avertissement, pas seulement un drapeau')
  assert.ok(/je garde mes prix/.test(branche),
    'le message nomme le mode dans les mots de l hote')
  // ⚠ La chaine est coupee par la concatenation dans la source : on cherche un
  // fragment qui tient sur une ligne, sinon le test rougit pour la mise en
  // forme et pas pour le fond.
  assert.ok(/HôteSmart gère mes/.test(branche),
    'et dit QUOI FAIRE pour que ca parte : passer en « HôteSmart gère mes prix »')

  // ⚠ LE FRONT NE LIT QUE `warnings` — c'est la raison d'etre du correctif.
  // Si un jour il lisait `task_ids`, ce test pourrait s'assouplir ; tant qu'il
  // ne le fait pas, l'avertissement est le seul canal.
  const front = lire('pages/biens-calendrier.html')
  assert.ok(/resp\.warnings/.test(front), 'le front lit warnings')
  assert.ok(!/restrictions_skipped/.test(front),
    'et NE lit pas restrictions_skipped : le drapeau seul est invisible a l hote')

  // Les deux cas voisins avaient deja leur message ; celui-ci n'en avait aucun.
  assert.ok(/ce bien est géré par Beds24/.test(src), 'le cas Beds24 est dit')
  assert.ok(/non connecté au canal de distribution/.test(src), 'le cas non connecte aussi')
})

test('LE TEST QUI COMPTE : en `keep`, la mise en file du full sync refuse AUSSI', () => {
  // La garde de `canPushRates` existe aux DEUX endroits : la sauvegarde par
  // segments (qui saute les restrictions) et la mise en file du full sync (qui
  // refuse). Sans la seconde, un hote en `keep` aurait pu croire publier par
  // ce chemin-la.
  const src = lire('api/calendar.js')
  assert.ok(src.includes('if (!canPushRates(bienFs)) {'), 'le full sync est garde')
  assert.ok(/enqueued: false, \.\.\.RATE_PUSH_BLOCKED/.test(src),
    'et rend le refus standard du depot, lisible par le code')
})
