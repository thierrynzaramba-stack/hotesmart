// tests/outils/horloge-decalee.js
//
// LA CONTRE-EPREUVE CALENDAIRE, RENDUE UTILISABLE.
//
// CLAUDE.md prescrit, quand le compte de tests rouges MONTE sur un commit
// inchange : « decaler les fixtures d'un mois, relancer, restaurer l'arbre — si
// tout repasse au vert, c'est le calendrier ». La regle est juste. Ce qui
// manquait, c'est COMMENT decaler, et c'est tout le sujet.
//
// ⚠ TROIS METHODES, TROIS RESULTATS, MESURES LE 1er OCTOBRE 2026 sur
// `tests/pwa-mes-jours-dom.test.js` (2 rouges ce jour-la) :
//
//   decaler la constante de date des fixtures  ->  8 rouges
//   surcharger `Date` dans Node seulement      -> 10 rouges
//   decaler Node ET la fenetre jsdom (ce fichier) -> 132/132
//
// Les deux premieres FABRIQUENT leurs propres echecs et « prouvent » donc une
// regression qui n'existe pas. Il a fallu que deux sessions comparent leurs
// mesures pour s'en apercevoir ; sans cet outil, la troisieme personne
// recommencera.
//
// ⚠ POURQUOI LA FENETRE COMPTE. jsdom cree en `runScripts: 'outside-only'` vit
// dans un AUTRE realm : sa fenetre a son propre `Date`, que surcharger le global
// de Node ne touche pas. Le test lit alors une horloge decalee tandis que la
// page en lit une autre — les fixtures parlent d'un mois, l'affichage d'un
// autre, et les echecs qui en sortent ne disent rien du calendrier.
//
// ⚠ CE FICHIER NE S'IMPORTE PAS, IL SE PRECHARGE. Le patch de `JSDOM` doit etre
// pose AVANT que le test ne le requiere : un test qui destructure
// `const { JSDOM } = require('jsdom')` en tete garde la classe d'origine si on
// arrive apres lui.
//
//   JOURS=10 node --require ./tests/outils/horloge-decalee.js --test tests/mon-test.test.js
//   HEURES=-2 node --require ./tests/outils/horloge-decalee.js --test tests/mon-test.test.js
//
// ⚠ ET `HEURES` N'EST PAS UN CONFORT : IL Y A DES DEFAUTS QUE `JOURS` NE PEUT
// PAS VOIR, PAR CONSTRUCTION. Mesure du 23 octobre 2026 a 22 h 45 UTC : trois
// tests de `tests/ecran-aujourdhui-isolation.test.js` rouges, et
// `JOURS=-1`, `JOURS=0`, `JOURS=1` rendaient les TROIS MEMES rouges. La cause
// etait une fixture posee sur le jour UTC contre un code borne sur le jour
// PARIS : un decalage en jours entiers fait glisser la fixture ET le code
// ensemble, donc il est neutre sur un ecart de FUSEAU. Seule une heure
// differente le montre — ces tests sont rouges entre 22 h et minuit UTC (23 h
// en heure d'hiver) et verts le reste de la journee.
//
// Les deux se cumulent : `JOURS=2 HEURES=-3`.
//
// ⚠ LE `./` N'EST PAS DECORATIF. Sans lui, `--require` cherche un MODULE de ce
// nom dans node_modules et rend « Cannot find module » — verifie en ecrivant
// cette ligne. Un chemin absolu marche aussi.
//
// Il ne sert QU'A la contre-epreuve, a la main, et ne fait partie d'aucune
// suite : `npm test` ne le charge pas. Il ne doit jamais devenir un moyen de
// faire passer un test — un test qui n'est vert qu'a une certaine date est une
// dette a nommer, pas a masquer.

// ⚠ LE DEFAUT DE 10 JOURS NE VAUT QUE SI RIEN N'EST DEMANDE. Le garder quand
// seul `HEURES` est pose avancerait l'horloge de dix jours a l'insu de qui
// voulait deplacer deux heures — et la contre-epreuve mesurerait autre chose
// que ce qu'elle annonce.
const RIEN = process.env.JOURS == null && process.env.HEURES == null
const JOURS = RIEN ? 10 : Number(process.env.JOURS || 0)
const HEURES = Number(process.env.HEURES || 0)
const DECALAGE = JOURS * 86400000 + HEURES * 3600000

// ⚠ `new Date(x)` GARDE SON SENS : seul l'appel SANS argument est deplace.
// Decaler aussi les dates explicites deplacerait les fixtures une seconde fois,
// et c'est exactement l'erreur de la premiere methode.
function decaler (D) {
  return class extends D {
    constructor (...a) { a.length ? super(...a) : super(D.now() + DECALAGE) }
    static now () { return D.now() + DECALAGE }
  }
}

globalThis.Date = decaler(Date)

// La fenetre jsdom, des sa construction. Le `require` de jsdom est resolu
// depuis ce fichier : il faut donc que le prechargement tourne depuis la racine
// du depot, comme les tests.
try {
  const jsdom = require('jsdom')
  const Origine = jsdom.JSDOM
  jsdom.JSDOM = class extends Origine {
    constructor (...a) {
      super(...a)
      const w = this.window
      if (w && w.Date) w.Date = decaler(w.Date)
    }
  }
} catch (e) {
  // ⚠ ON LE DIT. Un prechargement qui echoue en silence ferait croire a une
  // contre-epreuve complete alors que seule la moitie de l'horloge a bouge —
  // precisement la methode qui rend de faux echecs.
  console.error('[horloge-decalee] jsdom introuvable : SEULE l horloge de Node est decalee,')
  console.error('[horloge-decalee] et la contre-epreuve d un test a DOM ne prouvera rien.', e.message)
}

// ⚠ LA TRACE DIT L'INSTANT OBTENU, PAS SEULEMENT LE DECALAGE DEMANDE (regle 18
// de REVIEW.md : une mesure dit sa plage). Un ecart de fuseau se lit dans la
// difference entre les deux lignes ci-dessous, et une contre-epreuve qui ne les
// recopie pas ne se rejoue pas : le meme `HEURES` ne tombe pas sur la meme
// heure demain.
const MAINTENANT = new Date(Date.now())
console.error(`[horloge-decalee] Node et jsdom decales de ${JOURS} jour(s) et ${HEURES} heure(s). Contre-epreuve seulement.`)
console.error(`[horloge-decalee] instant : ${MAINTENANT.toISOString()} UTC`
  + ` — jour UTC ${MAINTENANT.toISOString().slice(0, 10)}`
  + `, jour Paris ${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(MAINTENANT)}`)
