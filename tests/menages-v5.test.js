// tests/menages-v5.test.js — page « Ménages » V5, lot 4 ÉTAPE 1 (lecture seule).
// Spec : docs/specs/lot-menages-v5/spec-refonte-ui-v5-lot-menages.md (+ §13).
// Fond : docs/specs/inventaire-menages.md (parties E, F, G).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')
const sansCommentaires = src => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')
const html = () => lire('pages/menages.html')

// ─── Règles V5 ───────────────────────────────────────────────────────────────
test('ménages : aucun hexa, aucun emoji, aucune icône dessinée', () => {
  const src = sansCommentaires(html())
  assert.ok(!/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/.test(src.replace(/&#\d+;/g, '')), 'couleur en dur')
  assert.ok(!/\p{Extended_Pictographic}/u.test(src), 'emoji')
  assert.ok(!/<(path|circle|rect|polyline|line)\b/.test(src), 'forme SVG dessinée dans la page')
})

test('ménages : les pastels des prestataires vivent dans theme.css, la page n\'en connaît que le nom', () => {
  const theme = lire('shared/theme.css')
  for (let i = 1; i <= 8; i++) assert.ok(theme.includes(`--presta-${i}:`), `--presta-${i} absent de theme.css`)
  // La page passe par le MODULE partagé (shared/presta-couleur.js), qui seul
  // nomme les jetons — plus aucune copie locale du hash (revue de 4235a21).
  assert.ok(sansCommentaires(html()).includes("from '/shared/presta-couleur.js'"), 'la page importe le module partagé')
  assert.ok(lire('shared/presta-couleur.js').includes('var(--presta-'), 'le module nomme les jetons')
  // Et ui.css reste sans hexa (règle de revue, spec socle §6.1).
  assert.ok(!/#[0-9A-Fa-f]{3,6}\b/.test(sansCommentaires(lire('shared/ui.css'))), 'hexa dans ui.css')
})

test('ménages : chaque clé de texte existe dans les trois langues', () => {
  const src = html()
  const cles = new Set([
    ...[...src.matchAll(/data-i18n="([\w.]+)"/g)].map(m => m[1]),
    ...[...src.matchAll(/data-i18n-attr="[^"]*?:([\w.]+)/g)].map(m => m[1]),
    ...[...src.matchAll(/\bt\('([\w.]+)'/g)].map(m => m[1])
  ])
  // Clés DYNAMIQUES (t('menages.tt_' + état), t('menages.retour_' …)) :
  // couvertes nominativement juste après.
  for (const k of [...cles]) if (k.endsWith('_')) cles.delete(k)
  assert.ok(cles.size > 15, 'extraction vide')
  const ETATS = ['fait', 'afaire', 'alerte']
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of cles) assert.ok(k in d, `${l} : clé « ${k} » absente`)
    for (const e of ETATS) assert.ok(('menages.tt_' + e) in d, `${l} : clé dynamique menages.tt_${e} absente`)
  }
})

test('ménages : dates via Intl, jamais de formatage à la main', () => {
  const src = sansCommentaires(html())
  assert.ok(src.includes('Intl.DateTimeFormat'), 'les dates passent par Intl')
  assert.ok(!/toLocaleDateString\('fr/.test(src), 'locale codée en dur')
})

// ─── Les décisions du design (§13), chacune NOMMÉE ──────────────────────────
test('décisions §13 : chaque règle de l\'étape 1 est présente, manquantes nommées', () => {
  const src = html()
  const LIGNES = {
    'la vérité « fait » vient du serveur (D1 lecture), jamais du localStorage': 'm.fait',
    'TROIS états seulement, lisibles sans légende (13/10)': "'alerte'",
    'badge retour vert/rouge sur un ménage fait (Q3)': 'men-mk__retour',
    'jours à régler = engrenage gris, jamais « € » (Q4)': 'men-regler',
    'bien non confié : aucune ligne, jamais de rouge (3 septembre)': 'menages.non_confie',
    'les jours sans AUCUNE prestataire : la COLONNE du bien, pas une ligne (13/10)': 'men-jj--trou',
    'sans prestataires:read : ligne neutre, pas d\'identifiant (invariant A.5)': 'CLE_COUVERTURE',
    'ligne temporaire de la remplaçante (ménage sans barre)': 'lignesDuBien',
    'deux ménages même jour même ligne : pastille chiffrée': 'men-mk__n',
    'désactivée : prénom grisé, ligne vide (13/10)': 'men-qui--off',
    'couleur stable par personne (hash, pastels du thème)': 'couleurDe(',
    'la BANDE du calendrier, composant partagé (13/10)': 'bandeJoursHtml',
    'le bloc bordé par bien du calendrier (13/10)': 'cal-bien__bandeau',
    'poignée de déplacement, ordre persisté (13/10)': 'brancherPoignees',
    'l\'angle et les bulles du calendrier': 'cal-angle__menu',
    'troncature DITE (bandeau, pas console.warn)': 'menages.truncated',
    'anti-course : la réponse en retard ne repeint pas': 'jetonLecture',
    'navigation non persistée (comme le calendrier)': 'decalage: 0',
    'biens masqués persistés par compte': 'hs_menages_v5_prefs',
    'le sélecteur en MOIS du calendrier (recette 13/10)': 'data-mois="12"',
    'au-delà de 92 jours, lecture par TRANCHES fusionnées': 'TRANCHE_MAX',
    'bulle « À traiter » : le module partagé décide, la page peint (étape 2)': 'lignesATraiter',
    'la bulle a sa PROPRE fenêtre J−30 → J+30, pas celle du planning': 'chargerATraiter',
    'badge ambre de l\'onglet Ménages = les lignes de la bulle': 'menagesATraiter',
    'une bulle qui n\'a pas pu lire se TAIT, elle n\'annonce pas le calme': 'menages.atraiter_panne',
    'rien à traiter : une ligne blanche à coche verte, sans ambre': 'men-bulle--calme',
    'téléphone : compteurs seuls, un appui ouvre la liste du type': 'typeOuvert',
    'valider un ménage écrit sur le SERVEUR, writer partagé avec la PWA (D1)': 'validerMenage',
    'changer la prestataire depuis la bulle': 'ouvrirChangement',
    '« Annuler » rejoue l\'inverse RÉEL (defaire), pas un simple retrait visuel': "action: 'defaire'",
    'X-Compte sur chaque appel': 'enteteCompte()',
    'entrée sous menages:read, erreur 403 dite': 'menages.no_access'
  }
  const manquantes = Object.entries(LIGNES).filter(([, motif]) => !src.includes(motif)).map(([nom]) => nom)
  assert.deepEqual(manquantes, [], 'règles ABSENTES : ' + manquantes.join(' ; '))
})

test('ménages : l\'état d\'une pastille suit les décisions Q1/Q2 (ordre des tests)', () => {
  const src = sansCommentaires(html())
  // fait AVANT « à faire » (un ménage fait reste vert même porté), et
  // porté/différé = À FAIRE, tout le reste = ALERTE (décision du 13 octobre).
  const corps = /function etatPastille[\s\S]*?\n}/.exec(src)
  assert.ok(corps, 'etatPastille introuvable')
  const ordre = ['m.fait', 'm.porteur', 'alerte']
  let pos = -1
  for (const jalon of ordre) {
    const p = corps[0].indexOf(jalon)
    assert.ok(p > pos, `ordre des états : « ${jalon} » mal placé`)
    pos = p
  }
  // Et AUCUN état « en cours » : il n'existe pas en donnée (Q1).
  assert.ok(!/en[_ ]cours|started/.test(corps[0]), 'un état inventé')
})

// ─── Gardes de périmètre ─────────────────────────────────────────────────────
test('ménages : aucun appel provider ni moteur depuis la page, un seul endpoint de lecture', () => {
  const src = sansCommentaires(html())
  assert.ok(!/channex\.io|beds24\.com|airroi/i.test(src))
  assert.ok(!src.includes('/api/beds24'), 'jamais un provider')
  assert.ok(!src.includes('/api/cron'), 'jamais le moteur')
  assert.ok(src.includes('/api/garde?du='), 'la lecture passe par api/garde')
  assert.ok(!src.includes("supabase.from("), 'aucune lecture Supabase directe')
})

test('ménages : la route /menages existe (cleanUrls : pas de .html en destination)', () => {
  const v = lire('vercel.json')
  assert.ok(v.includes('"/menages"'), 'route absente')
  assert.ok(!/"destination": "\/pages\/menages\.html"/.test(v), 'destination avec .html')
})

test('ménages : les écritures passent par l\'ENDPOINT gardé, jamais par Supabase direct', () => {
  // ⚠ Depuis l'étape 3 (gestes de la bulle), la page écrit. Ce qu'on garde :
  // aucune table touchée depuis le navigateur — tout passe par /api/menages,
  // qui porte la session, le droit et le périmètre.
  const src = sansCommentaires(html())
  assert.ok(!src.includes('.insert(') && !src.includes('.update(') && !src.includes('.upsert(') &&
            !src.includes('.delete('), 'écriture Supabase directe depuis la page')
  assert.ok(src.includes("poster('/api/menages'"), 'les gestes passent par l\'endpoint')
  // Et chaque bouton suit SON droit, absent du DOM sinon (décision G12).
  assert.ok(/peutEcrire\('menages'\)/.test(src), '« Valider » sous menages:write')
  assert.ok(/peutEcrire\('prestataires'\)/.test(src), '« Changer » sous prestataires:write')
})

test('ménages : le sprite porte les icônes neuves (bouclier barré, pouces)', () => {
  const sprite = lire('shared/icons.svg')
  for (const id of ['i-shield-off', 'i-thumb-up', 'i-thumb-down']) {
    assert.ok(sprite.includes(`id="${id}"`), `${id} absent du sprite`)
  }
})
