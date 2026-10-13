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
  assert.ok(sansCommentaires(html()).includes('var(--presta-'), 'la page consomme les jetons')
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
  const ETATS = ['fait', 'pris', 'np', 'na', 'avenir']
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of cles) assert.ok(k in d, `${l} : clé « ${k} » absente`)
    for (const e of ETATS) {
      assert.ok(('menages.tt_' + e) in d, `${l} : clé dynamique menages.tt_${e} absente`)
      assert.ok(('menages.leg_' + e) in d, `${l} : clé menages.leg_${e} absente`)
    }
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
    'pastille rouge dès que le ménage n\'est pas pris (Q2)': "'np'",
    'un différé n\'est jamais une alarme (Q2) — pastille à venir grise': "'avenir'",
    'badge retour vert/rouge sur un ménage fait (Q3)': 'men-mk__retour',
    'jours à régler = engrenage gris, jamais « € » (Q4)': 'men-regler',
    'bien non confié : aucune ligne, jamais de rouge (3 septembre)': 'menages.non_confie',
    '« Personne » rouge seulement quand un ménage tombe dans le trou (§12.6)': 'men-trou--calme',
    'sans prestataires:read : ligne neutre, pas d\'identifiant (invariant A.5)': 'CLE_COUVERTURE',
    'ligne temporaire de la remplaçante (ménage sans barre)': 'lignesDuBien',
    'deux ménages même jour même ligne : pastille chiffrée': 'men-mk__n',
    'prestataire désactivée : barre grise hachurée': 'men-barre--off',
    'couleur stable par personne (hash, pastels du thème)': 'couleurDe(',
    'photo de couverture du bien, repli initiales': 'men-bien__ini',
    'troncature DITE (bandeau, pas console.warn)': 'menages.truncated',
    'anti-course : la réponse en retard ne repeint pas': 'jetonLecture',
    'sélecteur de mois au clic sur la période': 'mois-choix',
    'navigation non persistée (comme le calendrier)': 'decalage: 0',
    'biens masqués en bulles, persistés': 'hs_menages_v5_prefs',
    'tour complet et échéance dans l\'infobulle (délai en heure de Paris)': "'Europe/Paris'",
    'X-Compte sur chaque appel': 'enteteCompte()',
    'entrée sous menages:read, erreur 403 dite': 'menages.no_access'
  }
  const manquantes = Object.entries(LIGNES).filter(([, motif]) => !src.includes(motif)).map(([nom]) => nom)
  assert.deepEqual(manquantes, [], 'règles ABSENTES : ' + manquantes.join(' ; '))
})

test('ménages : l\'état d\'une pastille suit les décisions Q1/Q2 (ordre des tests)', () => {
  const src = sansCommentaires(html())
  // fait AVANT porteur (un ménage fait reste vert même porté), porteur AVANT
  // proposition (porté + proposition en cours = PRIS, cas nominal §12.4),
  // proposition AVANT differe, differe AVANT « na ».
  const corps = /function etatPastille[\s\S]*?\n}/.exec(src)
  assert.ok(corps, 'etatPastille introuvable')
  const ordre = ['m.fait', 'm.porteur', 'proposeesA', 'differe']
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

test('ménages : étape 1 en LECTURE SEULE — aucune écriture depuis la page', () => {
  const src = sansCommentaires(html())
  assert.ok(!/method:\s*'POST'|method:\s*"POST"/.test(src), 'un POST à l\'étape 1')
  assert.ok(!src.includes('.insert(') && !src.includes('.update(') && !src.includes('.upsert('), 'écriture directe')
})

test('ménages : le sprite porte les icônes neuves (bouclier barré, pouces)', () => {
  const sprite = lire('shared/icons.svg')
  for (const id of ['i-shield-off', 'i-thumb-up', 'i-thumb-down']) {
    assert.ok(sprite.includes(`id="${id}"`), `${id} absent du sprite`)
  }
})
