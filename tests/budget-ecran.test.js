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
    // ⚠ `/api/yield` A DISPARU DE CET INVENTAIRE A L'ETAPE 4, ET C'EST LE PLUS
    // GROS GAIN DE LA REFONTE. Il etait appele DEUX FOIS PAR BIEN, apres le
    // premier affichage : mesure du 22 octobre 2026 en production, compte reel a
    // 4 logements, 72 requetes Supabase et 586 Ko — a lui seul 72 % des requetes
    // de la page, pour du CA et du TO sur 30 jours, c'est-a-dire exactement de
    // la donnee NON URGENTE.
    //
    // Ses trois consommateurs ont trouve leur place : le CA 30 j par bien est
    // remplace par le bloc « Revenus nets » (en mois de VERSEMENT, decision Q3,
    // inventaire I29), les min/max mensuels partent dans la fiche du logement
    // (Q4, I30, dette 96), et le repli « non raccorde » vit deja sur /logements.
    //
    // ⚠ SA LIGNE EST RETIREE, PAS COMMENTEE, parce que le message de ce test le
    // demande : « UN DE MOINS : il a ete replie, retirez sa ligne pour que le
    // gain soit garde. » Le jour ou un appel par bien revient sur cet ecran, ce
    // test rougira — et c'est tout l'objet.
    // Et une ACTION, qui ne part que sur un clic de l'hote.
    '/api/incidents-acquitter': 1,
    // ⚠ LA VUE ANNEE, ET ELLE NE PART QUE SUR UN CLIC (27 octobre 2026).
    // Ce test demande de nommer a quoi sert un appel de plus et pourquoi il ne
    // pouvait pas entrer dans l'appel d'ecran. Les deux raisons :
    //   · ce qu'il sert — douze mois de DEUX annees, par logement, pour la
    //     courbe de la vue Annee ;
    //   · pourquoi il n'entre pas dans l'appel d'ouverture — parce qu'il serait
    //     alors paye par CHAQUE hote a CHAQUE visite, pour un ecran que
    //     beaucoup n'ouvriront jamais. Le budget du PREMIER AFFICHAGE reste
    //     donc a deux appels : celui-ci n'y figure pas, il arrive au clic.
    //
    // ⚠ ET IL NE CROIT PAS AVEC LE NOMBRE DE LOGEMENTS : un seul appel rend
    // les douze mois des deux annees pour TOUS les biens. C'est ce que le test
    // « l'accueil n'a PLUS AUCUN appel par bien » garde juste en dessous.
    //
    // ⚠ DEUX SITES D'APPEL DEPUIS LE 28 OCTOBRE 2026, et le second se justifie
    // ici parce que ce test l'exige avant de l'inscrire :
    //   1. `chargerAnnee` — les douze mois des deux annees, au clic sur
    //      « Annee ».
    //   2. `chargerComparables` — la BANDE DES COMPARABLES d'UN logement, au
    //      clic sur SA PASTILLE.
    // Pourquoi le second ne pouvait pas entrer dans le premier : au moment du
    // clic sur « Annee », AUCUN logement n'est choisi — la pastille est un
    // geste humain qui vient apres. Charger d'avance les bandes de tous les
    // biens multiplierait la lecture par leur nombre, pour une donnee que
    // personne n'a demandee, et ferait exactement ce que ce test interdit :
    // un cout qui croit avec le parc.
    // ⚠ ET IL NE S'APPELLE QU'UNE FOIS PAR BIEN : `etat.comparablesParBien`
    // garde la reponse, cle posee AVANT l'appel pour que deux clics rapides
    // n'en lancent pas deux. Revenir sur une pastille deja vue ne coute rien.
    // ⚠ NI L'UN NI L'AUTRE N'EST DANS LE BUDGET DU PREMIER AFFICHAGE : il
    // reste a DEUX appels, et c'est ce que le test du chargement garde.
    '/api/ecran/revenus-annee': 2
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

test("LE TEST QUI COMPTE : l'accueil n'a PLUS AUCUN appel par bien", () => {
  // ⚠ CE TEST A CHANGE DE SENS A L'ETAPE 4, ET C'EST UNE VICTOIRE, PAS UNE
  // PERTE. Il comptait les deux appels `/api/yield` par bien pour que le cout
  // reste VISIBLE — « un appel par bien de plus multiplie par le nombre de
  // logements ». Mesure du 22 octobre 2026 : 72 requetes et 586 Ko a 4 biens.
  // Ces appels sont retires ; il garde donc maintenant leur ABSENCE.
  //
  // C'est le seul cout de l'accueil qui croissait avec le nombre de logements.
  // Les revenus arrivent desormais AVEC la reponse d'ecran, dans la meme
  // requete que tout le reste — l'endpoint fait deux lectures Supabase (les
  // delais, puis les sejours, paginee), quel que soit le nombre de biens.
  const src = lire('pages/aujourdhui.html')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('<!--')).join('\n')

  // Aucune boucle sur les biens qui part en reseau.
  assert.doesNotMatch(code, /chargerChiffresBien/,
    'la fonction qui appelait /api/yield par bien est revenue')
  assert.doesNotMatch(code, /\/api\/yield/,
    "l'accueil joint /api/yield : c'est le cout qui croit avec le nombre de logements")

  // ⚠ ET LE CONTROLE QUI COMPTE VRAIMENT : aucun `await appel(` dans une
  // iteration sur `etat.biens`. Un endpoint different appele par bien couterait
  // exactement la meme chose — ce test ne doit pas garder un NOM d'endpoint,
  // mais la FORME du 1 + N.
  //
  // ⚠ MA PREMIERE VERSION NE MORDAIT PAS, ET LA REVIEW L'A PROUVE PAR MUTATION.
  // Elle cherchait `etat\.biens\s*\.map\(`, et la page ecrit
  // `(etat.biens || []).map(b => {` — la parenthese de garde suffisait a lui
  // echapper. Mesure : un vrai 1 + N plante dans la boucle REELLE laissait la
  // suite a `fail 0`. Donc seuls les deux `doesNotMatch` ci-dessus mordaient,
  // c'est-a-dire des NOMS — exactement ce que ce commentaire dit vouloir
  // eviter.
  //
  // Le motif ne presume plus de la forme : il cherche `etat.biens` suivi d'un
  // iterateur OU un `for..of` dessus, puis un appel reseau dans la portee qui
  // suit. Les quatre formes sont couvertes, y compris celle de la page.
  const FORMES = [
    /etat\.biens[^\n]{0,30}\.(map|forEach|flatMap|reduce)\s*\([\s\S]{0,400}?await appel\(/,
    /for\s*\([^)]{0,60}\bof\b[^)]{0,60}etat\.biens[\s\S]{0,400}?await appel\(/,
    /etat\.biens[^\n]{0,30}\.(map|forEach|flatMap)\s*\([\s\S]{0,400}?fetch\s*\(/
  ]
  for (const f of FORMES) {
    const m = code.match(f)
    assert.strictEqual(m, null,
      `un appel reseau part dans une boucle sur les biens : ${m && m[0].slice(0, 120)}`)
  }

  // ⚠ ET LE MOTIF SE PROUVE SUR DES FORMES FABRIQUEES, parce qu'un motif qui ne
  // reconnait rien passe au vert sans rien mesurer — c'est le faux vert que je
  // viens de payer. Quatre formes doivent etre VUES, et le code reel ne doit
  // pas l'etre.
  const DOIVENT_MORDRE = [
    'etat.biens.map(b => { await appel("/api/x") })',
    '(etat.biens || []).map(b => { await appel("/api/x") })',
    'for (const b of etat.biens) { await appel("/api/x") }',
    'for (const b of (etat.biens || [])) { await appel("/api/x") }'
  ]
  for (const faux of DOIVENT_MORDRE) {
    assert.ok(FORMES.some(f => f.test(faux)),
      `la garde ne reconnait pas cette forme de 1 + N : ${faux}`)
  }
  assert.ok(!FORMES.some(f => f.test('etat.biens.map(b => b.name).join(", ")')),
    'la garde crie sur une boucle qui ne part pas en reseau')
})
