// tests/budget-ecran.test.js
//
// LE BUDGET D'APPELS PAR ECRAN — spec §7.1 du chantier performance.
// DOC : docs/specs/spec-performance-pages.md
//
// ⚠ CE TEST MANQUAIT, ET LA REVIEW DU LOT (b) L'A RELEVE : sans lui, le
// « 13 appels -> 3 » du lot etait de la PROSE. Un appel remis dans une page ne
// casse rien, ne ralentit rien de visible en recette, et ne se voit pas a la
// lecture d'un diff — il se voit sur le telephone d'un hote en 4G, six mois
// plus tard.
//
// ⚠ IL COMPTE LE CODE, PAS UN NAVIGATEUR (la spec le demande ainsi). Donc il
// compte des SITES D'APPEL, pas des requetes a l'execution : un appel dans une
// boucle compte pour un. Ce qu'il garde est l'INVENTAIRE — quels endpoints une
// page s'autorise a joindre — et c'est exactement ce qui derive.
//
// ⚠ REGLE 19 DE REVIEW.md : CE FICHIER EST UN TEST DE NON-REGRESSION, PAS LE
// GARDE-FOU D'UN CORRECTIF — et il faut le dire, parce qu'il est VERT contre le
// commit precedent (mesure : 3 tests, 3 verts sur `bf811b3`). Il ne pouvait pas
// rougir contre « le code d'avant » : la version fautive qu'il garde n'est pas
// un etat passe du depot, c'est tout etat FUTUR ou un appel serait remis. Sa
// contre-epreuve se fait donc par mutation, et elle est faite : ajouter un
// repli `|| await appel('/api/avis?action=notes')` dans `chargerNotes` le fait
// rougir en nommant l'endpoint fautif.
//
// ⚠ ET L'ATTENDU EST CHIFFRE, PAS BORNE. « <= 4 » laisse passer la quatrieme
// sans rien dire. Une de plus OU une de moins, et le test parle : c'est la
// discipline du depot (`ATTENDU` de bookings-snapshot-troncature, exemptions
// de cache-prive-endpoints).

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')

// Les endpoints qu'une page joint, par leur chemin.
//
// ⚠ ON NE DEPOUILLE PAS LES COMMENTAIRES PAR REGEX SUR UNE PAGE HTML, ET C'EST
// MESURE. Les deux passes habituelles du depot — `/\*…\*/` puis `//…` — font
// disparaitre PRESQUE TOUT le script de `pages/aujourdhui.html` : il reste
// 1 endpoint sur 6 apres la premiere, zero apres la seconde. Un `/*` de CSS,
// une apostrophe, un `*/` dans une chaine, et le depouilleur avale le fichier.
// Un test de budget qui compte zero appel serait vert pour toujours.
//
// On prend donc le bloc `<script type="module">`, et on ecarte les lignes
// ENTIEREMENT commentees — la forme de loin la plus courante ici, et la seule
// qui cite des endpoints (les commentaires de ce depot nomment beaucoup
// `/api/messages` et `/api/avis` pour expliquer ce qu'on NE fait plus).
function endpointsDe (fichier) {
  const brut = lire(fichier)
  const scripts = [...brut.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1])
  assert.ok(scripts.length, `${fichier} n'a aucun bloc <script>`)
  const utile = scripts.join('\n').split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  const vus = new Map()
  for (const m of utile.matchAll(/['"`](\/api\/[a-z0-9\-/]+)/gi)) {
    const chemin = m[1].replace(/\/$/, '')
    vus.set(chemin, (vus.get(chemin) || 0) + 1)
  }
  return vus
}

// ⚠ L'ATTENDU EST MESURE, PAS SUPPOSE — 23 octobre 2026, apres le lot (b).
// Il porte les SITES D'APPEL par endpoint, et chaque ligne dit a quoi elle
// sert. Un endpoint qui apparait ici deux fois est une LECTURE et une ACTION
// (un POST de l'hote), ou deux usages distincts : la distinction compte, parce
// qu'une action ne pese pas sur le premier affichage.
const ATTENDU = {
  'pages/aujourdhui.html': {
    // Le premier affichage : trois endpoints, c'est le contrat du lot (b).
    '/api/ecran/aujourdhui': 1,          // l'ecran en un appel
    '/api/menages': 1,                   // la fenetre de 400 jours — lot (d)
    // ⚠ UN SEUL LITTERAL, MAIS DEUX ALLERS-RETOURS PAR BIEN : le chemin est
    // assemble une fois dans `const base` puis joint deux fois. C'est le
    // troisieme test de ce fichier qui compte les allers-retours ; celui-ci
    // compte les ENDPOINTS JOINTS. Les deux comptes sont necessaires, et les
    // confondre etait ma premiere version.
    '/api/yield': 1,                     // CA et TO, par bien — lot (c)
    // Et une ACTION, qui ne part que sur un clic de l'hote.
    '/api/incidents-acquitter': 1
  }
}

for (const [page, attendu] of Object.entries(ATTENDU)) {
  test(`LE TEST QUI COMPTE : le budget d'appels de ${page}`, () => {
    const vus = endpointsDe(page)
    const reel = Object.fromEntries([...vus.entries()].sort())
    assert.deepEqual(reel, Object.fromEntries(Object.entries(attendu).sort()),
      `l'inventaire des appels de ${page} a change.\n`
      + 'UN DE PLUS : nommez a quoi il sert et pourquoi il ne pouvait pas entrer dans\n'
      + "l'appel d'ecran, avant de l'ajouter ici. UN DE MOINS : il a ete replie, retirez\n"
      + 'sa ligne pour que le gain soit garde.')
  })
}

test("LE TEST QUI COMPTE : l'accueil n'appelle pas l'endpoint d'un AUTRE ecran", () => {
  // ⚠ INTERDIT DE LA SPEC : un ecran qui appelle l'endpoint d'un autre ecran
  // paie son assemblage ENTIER. Mesure du 22 octobre 2026 : l'accueil
  // appelait `/api/messages` pour UN champ — l'etat du code d'acces d'une
  // arrivee — et payait 18 requetes et 437 212 octets, soit 42 % du poids de
  // la page. `/api/menages` est l'exception assumee jusqu'au lot (d), nommee
  // dans l'ATTENDU ci-dessus.
  const vus = endpointsDe('pages/aujourdhui.html')
  for (const interdit of ['/api/messages', '/api/avis', '/api/calendar', '/api/logement']) {
    assert.ok(!vus.has(interdit),
      `l'accueil appelle ${interdit}, l'endpoint d'un autre ecran : il paie son assemblage entier`)
  }
})

test("LE TEST QUI COMPTE : les appels par BIEN sont comptes a part", () => {
  // Le seul cout de l'accueil qui croit avec le nombre de logements est
  // `/api/yield`, DEUX fois par bien (CA de la periode et de la precedente).
  // Mesure du 22 octobre 2026 : 72 requetes et 586 Ko a 4 biens. C'est la
  // moitie du lot (c), et il faut que ce soit VISIBLE ici — un appel par bien
  // de plus multiplie par le nombre de logements.
  const src = lire('pages/aujourdhui.html')
  const bloc = (src.match(/async function chargerChiffresBien[\s\S]*?\n\}/) || [''])[0]
  assert.ok(bloc, 'chargerChiffresBien a disparu : le compte par bien n est plus mesurable')
  // ⚠ SUR LES APPELS, PAS SUR LES LITTERAUX. `chargerChiffresBien` assemble
  // `const base = '/api/yield?...'` UNE fois et le joint DEUX fois : compter
  // les chaines `/api/` donnerait 1, et le lot (c) croirait n'avoir qu'un
  // appel par bien a replier.
  const parBien = (bloc.match(/await appel\(/g) || []).length
  assert.strictEqual(parBien, 2,
    `${parBien} appels par bien au lieu de 2 : a 4 logements cela fait ${parBien * 4} appels, `
    + 'et le lot (c) doit les ramener a une lecture de table de resume')
})
