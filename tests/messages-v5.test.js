// tests/messages-v5.test.js — page « Messages » V5, lot 2 ETAPE 1 (lecture
// seule). Spec : docs/specs/spec-refonte-ui-v5-lot-messages.md §9.

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

const html = () => lire('pages/messages.html')

// ─── Regles V5 ───────────────────────────────────────────────────────────────
test('messages : aucun hexa, aucun emoji, aucune icone dessinee', () => {
  const src = sansCommentaires(html())
  assert.ok(!/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/.test(src.replace(/&#\d+;/g, '')), 'couleur en dur')
  assert.ok(!/\p{Extended_Pictographic}/u.test(src), 'emoji')
  assert.ok(!/<(path|circle|rect|polyline|line)\b/.test(src), 'forme SVG dessinee dans la page')
})

test('messages : chaque cle de texte existe dans les trois langues', () => {
  const src = html()
  const cles = new Set([
    ...[...src.matchAll(/data-i18n="([\w.]+)"/g)].map(m => m[1]),
    ...[...src.matchAll(/data-i18n-attr="[^"]*?:([\w.]+)/g)].map(m => m[1]),
    ...[...src.matchAll(/\bt\('([\w.]+)'/g)].map(m => m[1])
  ])
  assert.ok(cles.size > 10, 'extraction vide')
  for (const l of ['fr', 'en', 'es']) {
    const d = JSON.parse(lire(`shared/i18n/${l}.json`))
    for (const k of cles) assert.ok(k in d, `${l} : cle « ${k} » absente`)
  }
})

test('messages : le point « non lu » et le robot d\'attente sont INFO, jamais ambre', () => {
  const css = lire('shared/ui.css')
  assert.ok(/\.conv__nonlu[^}]*var\(--info\)/.test(css), 'non lu = bleu info (l\'ambre dit « HôteSmart attend ta décision »)')
  assert.ok(/\.conv \.icon--robot[^}]*var\(--info\)/.test(css))
  const theme = lire('shared/theme.css')
  assert.ok((theme.match(/--info:/g) || []).length >= 2, '--info defini en clair ET en sombre')
})

// ─── Etape 1 : LECTURE SEULE ─────────────────────────────────────────────────
test('messages : aucune saisie ni action d\'envoi (etapes 2-3)', () => {
  const src = sansCommentaires(html())
  assert.ok(!/<textarea/.test(src), 'pas de zone de saisie a l\'etape 1')
  // `i-send` existe ailleurs (menu Outils, ligne SMS) : on interdit un BOUTON
  // d'envoi dans le fil, pas l'icone dans le menu.
  assert.ok(!/<button[^>]*i-send|data-envoyer/.test(src), 'pas de bouton envoyer dans le fil')
  for (const k of ['validate.send', 'validate.edit', 'messages.send', 'messages.reject']) {
    assert.ok(!src.includes(`'${k}'`), `action ${k} hors etape 1`)
  }
  assert.ok(!/method:\s*'POST'/.test(src), 'la page n\'ecrit RIEN')
})

test('messages : une proposition d\'une conversation FERMEE n\'apparait pas (regle du lot 1, partagee)', () => {
  const src = sansCommentaires(html())
  assert.ok(/import \{[^}]*tachesOuvertes[^}]*\} from '\/shared\/aujourdhui\.js'/.test(src),
    'la regle vient du module partage, jamais recopiee')
  assert.ok(/etat\.taches = tachesOuvertes\(/.test(src), 'et elle est APPLIQUEE')
  assert.ok(!/in\('status', \['pending', /.test(src), 'seules les pending_validation alimentent la page')
})

test('messages : aucun appel provider, X-Compte partout', () => {
  const src = sansCommentaires(html())
  for (const interdit of ['/api/beds24', '/api/channel-property', '/api/channel-mapping', 'beds24.com', 'channex']) {
    assert.ok(!src.toLowerCase().includes(interdit.toLowerCase()), `appel interdit : ${interdit}`)
  }
  for (const m of src.matchAll(/fetch\(/g)) {
    assert.ok(src.slice(m.index, m.index + 300).includes('enteteCompte()'), 'fetch sans X-Compte')
  }
})

test('messages : sur telephone, le fil ouvert masque la barre du bas', () => {
  const css = lire('shared/ui.css')
  assert.ok(/body\[data-fil\] \.bottombar \{ display: none; \}/.test(css))
  const src = sansCommentaires(html())
  assert.ok(src.includes("document.body.dataset.fil = '1'") && src.includes('delete document.body.dataset.fil'))
})

test('messages : les correctifs de la revue de acf0fa0 tiennent', () => {
  const src = sansCommentaires(html())
  const css = lire('shared/ui.css')
  // 1. Le retour du fil couvre TOUTE la plage du fil plein ecran (<900px).
  assert.ok(src.includes('msg-retour') && !/only-mobile" data-bind="retour"/.test(src))
  assert.ok(css.includes('@media (max-width: 899px) {' + String.fromCharCode(10) + '  .msg-retour { display: inline-flex; }'))
  // 2. Un sejour annule ne tient pas une proposition ouverte.
  assert.ok(src.includes("SANS_SEJOUR") && src.includes("'cancelled'") && src.includes("'demapped'"))
  // 3. La garde de date vaut pour la LISTE comme pour le fil.
  assert.ok(src.includes("function heureCourte (iso) {" + String.fromCharCode(10) + "  if (!valide(iso)) return ''"))
  // 5. Coche verte distincte du bleu d'attente.
  assert.ok(src.includes("icone('i-check', 'icon icon--fait')"))
  assert.ok(/\.conv \.icon--fait[^}]*var\(--ok\)/.test(css))
  // 6. Canal inconnu neutre, jamais le A d'Airbnb.
  assert.ok(src.includes("lettreCanal") && !src.includes("(c.ota || '?')[0]"))
  // 4. Echec de chargement : aucun compte, aucun badge calcules sur du vide.
  assert.ok(src.includes("etat.chargementOk === false) { $('.msg-liste__outils').hidden = true"))
  assert.ok(src.includes('etat.chargementOk ? { pendingMessages'))
  // 7. Index des taches par reservation.
  assert.ok(src.includes('tachesParResa'))
})

test('messages : les arrivees du jour et de demain sont CONSERVEES (inventaire §12)', () => {
  const src = sansCommentaires(html())
  assert.ok(src.includes('function groupeArrivee'), 'le groupe d\'arrivee existe')
  assert.ok(src.includes('return g < 2 ? g : tachesDe(c).length ? 2'),
    'arrivees du JOUR en tete, demain ensuite, AVANT les « a valider » (decision du 11 octobre)')
  assert.ok(src.includes('msg-groupe'), 'etiquettes de groupe « Arrive aujourd\'hui / demain »')
  assert.ok(src.includes('msg-separe'), 'separation visuelle avec le reste de la liste')
  assert.ok(/badgeArrivee[\s\S]{0,800}lienTelephone\(c\)/.test(src), 'le telephone vit dans la LIGNE pour les arrivees')
  assert.ok(src.includes('messages.arrives_today') && src.includes('messages.arrives_tomorrow'))
  assert.ok(src.includes("c.arrivee?.menage === 'fait'"), 'pastille menage POSITIVE seulement')
  assert.ok(src.includes('function lienTelephone'), 'le telephone en lien d\'appel')
  assert.ok(/groupeArrivee\(c\) > 1 \|\| !c\.guestPhone/.test(src), 'le tel reste borne aux arrivees j / j+1')
  assert.ok(src.includes('SANS_ARRIVEE'), 'une annulee n\'est pas une arrivee')
})

test('messages : miniature du logement et logos de canal (demande du 11 octobre)', () => {
  const src = sansCommentaires(html())
  assert.ok(src.includes('function avatarConv'), 'le grand cercle porte la photo du bien')
  assert.ok(src.includes('bien?.photo'), 'repli : les initiales quand pas de photo')
  assert.ok(src.includes("icone('i-canal-airbnb'"), 'le belo Airbnb vient du sprite')
  assert.ok(src.includes("'B.'"), 'le logo Booking est son « B. »')
  const theme = lire('shared/theme.css')
  for (const tk of ['--canal-airbnb', '--canal-booking', '--canal-direct', '--on-canal']) {
    assert.ok(theme.includes(tk + ':'), `jeton ${tk} dans theme.css (seul fichier a hexas)`)
  }
  const css = lire('shared/ui.css')
  assert.ok(!/#[0-9A-Fa-f]{3,6}\b/.test(css), 'aucune couleur de marque en dur hors theme.css')
})

test('icons.svg : XML valide, et JAMAIS de double tiret dans un commentaire', () => {
  // Vecu du 11 octobre 2026 : « .icon--fill » cite dans un commentaire a coupe
  // l'analyse du sprite — tous les symboles suivants (belo compris)
  // disparaissaient, sans erreur visible.
  const svg = lire('shared/icons.svg')
  for (const m of svg.matchAll(/<!--([\s\S]*?)-->/g)) {
    assert.ok(!m[1].includes('--'), 'double tiret dans un commentaire XML : le sprite casse a partir de la')
  }
  assert.ok(svg.includes('id="i-canal-airbnb"'))
  const apres = svg.slice(svg.indexOf('i-canal-airbnb'))
  assert.ok(apres.includes('id="i-help"') && apres.includes('id="i-logout"'),
    'les symboles places APRES le belo restent atteignables')
})

// ─── Branchements ────────────────────────────────────────────────────────────
test('l\'onglet Messages mene a la nouvelle page, l\'ancienne messagerie ne vit plus dans aucun menu', () => {
  assert.ok(lire('shared/nav.js').includes("href: '/pages/messages'"))
  assert.ok(!lire('shared/nav.js').includes('agent-ai/messagerie'))
  assert.ok(!sansCommentaires(lire('components/sidebar.js')).includes('agent-ai/messagerie'),
    'la barre laterale des anciens ecrans ne pointe plus l\'ancienne messagerie')
})

test('la reecriture /messages est posee sans .html (cleanUrls)', () => {
  const vercel = JSON.parse(lire('vercel.json'))
  const r = vercel.rewrites.find(x => x.source === '/messages')
  assert.ok(r && r.destination === '/pages/messages')
})

test('messages : l\'ouverture directe ?conv= exige que le fil existe', () => {
  const src = sansCommentaires(html())
  assert.ok(/etat\.conversations\.some\([\s\S]{0,120}?demandee/.test(src),
    'jamais un ecran « introuvable » depuis un lien interne')
})
