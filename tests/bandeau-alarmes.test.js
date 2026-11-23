// tests/bandeau-alarmes.test.js
//
// LE BANDEAU D'ALARMES DE /aujourdhui : CE QU'IL MONTRE, ET CE QU'IL NE DOIT
// JAMAIS CHASSER.
//
// ⚠ DECISION DE THIERRY DU 30 OCTOBRE 2026, et une mesure qui l'a precisee.
// Sa crainte : « la prod a 1 209 send_failure et 11 977 api_credit jamais
// acquittes : le bandeau risque d'etre noye, et l'alarme de surreservation
// chassee (limit 50) ».
//
// MESURE EN PRODUCTION, EN LECTURE SEULE, AVANT LE CORRECTIF :
//   api_credit    11 977 ouverts  — PAS dans la liste du bandeau
//   send_failure   1 209 ouverts  — PAS dans la liste du bandeau
//   table_growth     131 ouverts  — PAS dans la liste
//   cles_migrees_illisible 5      — PAS dans la liste
//   overbooking          1 ligne, 0 OUVERTE
//   les trois types d'envoi : 0 ligne, ils naissent avec ce correctif
// Donc le bandeau afficherait ZERO alarme au deploiement : sa premisse ne
// tenait pas. Mais le MECANISME qu'il decrit est reel — `limit(50)` etait
// PARTAGE et trie par date, et une alerte d'envoi est par nature plus fraiche
// qu'une surreservation qui dure. D'ou les deux garanties ci-dessous.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const src = fs.readFileSync(path.join(__dirname, '..', 'api/ecran/aujourdhui.js'), 'utf8')
// ⚠ LA TRANCHE VA JUSQU'A LA FONCTION SUIVANTE, PAS JUSQU'AU PREMIER `const
// lire…` : `lireFamille` est DANS `lireAlarmes`, et couper dessus amputait la
// tranche de tout ce qu'on veut mesurer. Mon premier jet rougissait sur sa
// propre lecture.
const lecteur = src.split('const lireAlarmes')[1].split('\n  const lireArrivees')[0]

test('LE TEST QUI COMPTE : une surreservation ne peut PLUS etre chassee par les alertes d envoi', () => {
  // Deux lectures, deux plafonds : la famille critique a le sien.
  assert.match(lecteur, /lireFamille\(\['overbooking'\], null\)/,
    'la surreservation a sa propre lecture, et SANS borne de date')
  assert.ok(/TYPES_ALARME\.filter\(t => t !== 'overbooking'\)/.test(lecteur),
    'les alertes d envoi ont la leur')
  // Un seul `limit` partage serait le defaut : il doit y en avoir un PAR famille.
  const limites = (lecteur.match(/\.limit\(/g) || []).length
  assert.equal(limites, 1, 'le plafond vit dans `lireFamille`, donc il s applique a CHAQUE famille')
  // Et la critique passe en TETE du rendu : c est elle qu on ne doit pas rater.
  const iCrit = lecteur.indexOf('...(critiques.data')
  const iEnv = lecteur.indexOf('...(envois.data')
  assert.ok(iCrit > 0 && iCrit < iEnv, 'la surreservation est rendue en premier')
})

test('LE TEST QUI COMPTE : les alertes d envoi sont bornees au deploiement, la surreservation NON', () => {
  // « L'ecran n'affiche que les incidents d'envoi nes apres le deploiement. »
  // ⚠ PAS DE `[^)]*` ICI : l'appel contient lui-meme une parenthese
  // (`filter(t => t !== 'overbooking')`), donc la classe negative s'arretait
  // avant le seuil et l'assertion rougissait sur sa propre regex. On lit la
  // ligne entiere.
  const ligneEnvois = lecteur.split('\n').find(l => l.includes('lireFamille(TYPES_ALARME'))
  assert.ok(ligneEnvois, 'l appel pour les alertes d envoi est lisible')
  assert.match(ligneEnvois, /SEUIL_ALARMES_ENVOI\)\s*$/,
    'les alertes d envoi portent le seuil')
  assert.match(lecteur, /lireFamille\(\['overbooking'\], null\)/,
    'et la surreservation ne le porte PAS : une alarme ancienne doit rester visible')
  // La borne est appliquee, pas seulement passee.
  const famille = src.split('const lireFamille')[1].split('\n    }')[0]
  assert.match(famille, /if \(borneDate\) q = q\.gte\('created_at', borneDate\)/,
    'la borne se traduit par un `gte` sur la date de creation')
})

test('LE TEST QUI COMPTE : le seuil est dans le PASSE, et le restera', () => {
  // ⚠ UN SEUIL DANS LE FUTUR MASQUERAIT TOUTES LES ALERTES D ENVOI, EN SILENCE.
  // C est la famille de defaut que ce chantier passe son temps a fermer : un
  // ecran qui se tait au lieu de dire. Ce test est la seule chose qui empeche
  // qu on le deplace par megarde.
  const m = /const SEUIL_ALARMES_ENVOI = '([^']+)'/.exec(src)
  assert.ok(m, 'le seuil est lisible')
  const seuil = Date.parse(m[1])
  assert.ok(Number.isFinite(seuil), 'et c est une date valide')
  assert.ok(seuil <= Date.now(),
    `le seuil (${m[1]}) doit etre dans le passe, sinon aucune alerte d envoi ne s affiche`)
})

test('les deux listes de types restent identiques a celle de l acquittement', () => {
  // Une alarme affichee mais non acquittable laisse un bouton qui rend 404.
  const acq = fs.readFileSync(path.join(__dirname, '..', 'api/incidents-acquitter.js'), 'utf8')
  const liste = (s, nom) => {
    const i = s.indexOf('const ' + nom + ' = [')
    assert.ok(i > 0, nom + ' est lisible')
    return [...s.slice(i, s.indexOf(']', i)).matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort()
  }
  assert.deepEqual(liste(src, 'TYPES_ALARME'), liste(acq, 'TYPES_ACQUITTABLES'),
    'tout type affiche est acquittable, et reciproquement')
})

test('une panne de lecture sur UNE famille rend `null`, pas une liste amputee', () => {
  // ⚠ SINON L ECRAN PRETEND QU IL N Y A PAS D ALARME. La page distingue `null`
  // (« je ne sais pas ») d un tableau vide (« il n y en a pas ») : rendre la
  // moitie des alarmes quand l autre lecture echoue serait affirmer a tort.
  assert.match(lecteur, /if \(critiques\.error \|\| envois\.error\)/,
    'les deux erreurs sont lues')
  assert.match(lecteur, /indisponibles\.push\('alarmes'\); return null/,
    'et une seule suffit a rendre `null`')
})

// ─────────────────────────────────────────────────────────────────────────────
// LE TITRE ET LE PIED DE CHAQUE CARTE, RENDUS — PAS GREPES.
//
// ⚠ CONSTAT D'UNE REVUE INDEPENDANTE, VERIFIE. Le bandeau n'a longtemps servi
// que la surreservation, et ses trois phrases sont ecrites pour elle :
// « Surréservation · {bien} », « Deux séjours sur la même nuit. », et
// « L'alerte se répète jusqu'à acquittement. » En y faisant entrer les alarmes
// d'envoi, j'ai laisse les trois : sur un ARRET d'envoi, aucune n'est vraie —
// et la derniere est l'inverse du mecanisme qu'on vient d'ecrire, puisqu'un
// arret est pose UNE fois et que la porte le relit ensuite sans realerter.
// On EXECUTE donc le rendu de la page sur deux alarmes de familles
// differentes, et on lit ce que l'hote lirait.
const vm = require('vm')
const { JSDOM } = require('jsdom')

function rendre (alarmes) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pages/aujourdhui.html'), 'utf8')
  const i = src.indexOf('const TYPES_ENVOI =')
  assert.notEqual(i, -1, 'la liste des types d envoi est dans la page')
  // ⚠ ON PREND LA FONCTION JUSQU A SON ACCOLADE : couper avant la rendait
  // syntaxiquement invalide, et un `SyntaxError` est un rouge qui ne parle pas
  // du defaut mesure. Le `addEventListener` final est inoffensif ici — la
  // fleche n est jamais appelee faute de clic.
  const ancre = src.indexOf("zone.querySelectorAll('[data-acquitter]')", i)
  assert.notEqual(ancre, -1, 'la fin du rendu est reperable')
  const fin = src.indexOf('\n}', ancre)
  assert.notEqual(fin, -1, 'la fonction se ferme')
  const code = src.slice(i, fin + 2)
  const dom = new JSDOM('<div data-list="alarms" hidden></div>')
  const ctx = {
    document: dom.window.document,
    $: (s) => dom.window.document.querySelector(s),
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    icone: (id, cls = 'icon') => `<svg class="${cls}" data-icone="${id}"></svg>`,
    // ⚠ `t` REND SA CLE : on mesure QUELLE phrase est choisie, pas sa traduction.
    t: (k, v = {}) => `[${k}]${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')}`,
    I18n: { date: () => '29 octobre 11:00' },
    peutEcrire: () => true,
    nomDuBien: () => 'La bulle',
    etat: { alarmes }
  }
  vm.createContext(ctx)
  vm.runInContext(code + '\nrenderAlarmes()', ctx)
  return dom.window.document.querySelector('[data-list="alarms"]').innerHTML
}

test('LE TEST QUI COMPTE : une alarme d envoi ne se titre PAS « Surréservation »', () => {
  const html = rendre([{ id: '1', type: 'message_ota_arret', property_id: 'p1',
    created_at: '2026-10-29T11:00:00Z', detail: { message: 'ARRET : arrival ne partira pas' } }])
  assert.match(html, /\[alarm\.send_title\]/, 'elle se titre par l envoi')
  assert.doesNotMatch(html, /\[alarm\.title\]/, 'et jamais par la surreservation')
  // ⚠ ET LE PIED NON PLUS : « l alerte se repete jusqu a acquittement » est
  // l inverse du mecanisme — un arret alerte UNE fois.
  assert.match(html, /\[alarm\.send_since\]/)
  assert.doesNotMatch(html, /\[alarm\.since\]/)
})

test('la surreservation garde ses phrases, mot pour mot', () => {
  const html = rendre([{ id: '2', type: 'overbooking', property_id: 'p1',
    created_at: '2026-10-29T11:00:00Z', detail: { message: 'deux sejours' } }])
  assert.match(html, /\[alarm\.title\]/)
  assert.match(html, /\[alarm\.since\]/)
  assert.doesNotMatch(html, /\[alarm\.send_/)
})

test('les trois types d envoi SERVIS par l ecran sont tous reconnus par le rendu', () => {
  // ⚠ LE PIEGE QUE CE TEST FERME : la page porte SA PROPRE liste de types. Si
  // l ecran en sert un quatrieme, il s affiche avec les phrases de la
  // surreservation — faux, et silencieux. On compare les deux listes.
  const ecran = fs.readFileSync(path.join(__dirname, '..', 'api/ecran/aujourdhui.js'), 'utf8')
  const servis = (/const TYPES_ALARME = \[([^\]]+)\]/.exec(ecran)[1].match(/'([^']+)'/g) || [])
    .map(x => x.replace(/'/g, '')).filter(x => x !== 'overbooking')
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages/aujourdhui.html'), 'utf8')
  const connus = (/const TYPES_ENVOI = \[([^\]]+)\]/.exec(page)[1].match(/'([^']+)'/g) || [])
    .map(x => x.replace(/'/g, ''))
  assert.deepEqual(servis.slice().sort(), connus.slice().sort(),
    'l ecran et la page nomment les memes types d envoi')
  for (const type of servis) {
    const html = rendre([{ id: type, type, property_id: 'p1',
      created_at: '2026-10-29T11:00:00Z', detail: { message: 'x' } }])
    assert.match(html, /\[alarm\.send_title\]/, `${type} est rendu comme un envoi`)
  }
})

test("l e-mail abandonne est ACQUITTABLE, et c est le meme defaut qu on avait ferme pour l OTA", () => {
  // ⚠ CONSTAT D UNE REVUE : `email_voyageur_abandon` etait pose avec
  // `threshold: 1` — donc SMS et e-mail au fondateur — et n etait dans AUCUNE
  // des deux listes. Invisible a l ecran, donc inacquittable : exactement le
  // defaut que ce lot citait en majuscules pour les trois types OTA, reste
  // ouvert du cote e-mail.
  const cron = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-messages.js'), 'utf8')
  assert.match(cron, /reportIncident\('email_voyageur_abandon'/, 'le type est bien pose')
  const ecran = fs.readFileSync(path.join(__dirname, '..', 'api/ecran/aujourdhui.js'), 'utf8')
  const acq = fs.readFileSync(path.join(__dirname, '..', 'api/incidents-acquitter.js'), 'utf8')
  for (const [nom, src] of [['l ecran', ecran], ['l acquittement', acq]]) {
    assert.match(src, /'email_voyageur_abandon'/, `${nom} le connait`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// LA SEPARATION DES DEUX FAMILLES, EXECUTEE — ET PAS GREPEE.
//
// ⚠ CONSTAT D'UNE REVUE INDEPENDANTE, ET IL EST JUSTE. Les trois premiers tests
// de ce fichier assertent des fragments de la SOURCE de l'endpoint :
// `lireFamille(['overbooking'], null)`, `TYPES_ALARME.filter(...)`, un seul
// `.limit(`. Un refactor qui garde ces fragments mais recable l'affectation —
// extraire les deux appels en `const pCritiques = …` / `const pEnvois = …`
// avant le `Promise.all`, ou simplement echanger les deux arguments —
// resterait VERT tout en posant la borne de date sur la SURRESERVATION et en
// laissant la famille envoi sans borne. C'est exactement ce que le commentaire
// du seuil dit de ne jamais laisser arriver en silence.
//
// On execute donc le bloc avec un double de Supabase qui ENREGISTRE ce que
// chaque requete porte : ses types, sa borne de date, son plafond.
function lireLesDeuxFamilles () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/ecran/aujourdhui.js'), 'utf8')
  const i = src.indexOf('    const TYPES_ALARME = [')
  assert.notEqual(i, -1, 'le bloc des alarmes est reperable')
  const ancre = src.indexOf('return [...(critiques.data', i)
  assert.notEqual(ancre, -1, 'la sortie du bloc est reperable')
  const code = src.slice(i, src.indexOf('\n', ancre))
  const seuil = /const SEUIL_ALARMES_ENVOI = '([^']+)'/.exec(src)[1]

  const requetes = []
  const faux = () => {
    const vu = { types: null, gte: null, limit: null, trie: false }
    requetes.push(vu)
    const o = {
      select: () => o, eq: () => o, is: () => o,
      in (col, val) { if (col === 'type') vu.types = val; return o },
      gte (col, val) { if (col === 'created_at') vu.gte = val; return o },
      order () { vu.trie = true; return o },
      limit (n) { vu.limit = n; return Promise.resolve({ data: [], error: null }) }
    }
    return o
  }
  const ctx = {
    supabase: { from: () => faux() },
    compte: 'u1',
    // ⚠ LA VALEUR VIENT DU MODULE LUI-MEME, pas d'une copie : le bloc mesure
    // reference le nom, et c'est la constante du fichier qu'on lui donne.
    SEUIL_ALARMES_ENVOI: seuil,
    bornerRef: (q) => q,
    compter: async (p) => p,
    indisponibles: []
  }
  vm.createContext(ctx)
  vm.runInContext('(async () => {\n' + code + '\n})()', ctx)
  return { requetes, seuil, indisponibles: ctx.indisponibles }
}

test('LE TEST QUI COMPTE : la borne de date tombe sur l envoi, JAMAIS sur la surreservation', async () => {
  const { requetes, seuil } = lireLesDeuxFamilles()
  await new Promise(r => setImmediate(r))
  assert.equal(requetes.length, 2, 'deux lectures, une par famille')
  const critiques = requetes.find(q => (q.types || []).includes('overbooking'))
  const envois = requetes.find(q => !(q.types || []).includes('overbooking'))
  assert.ok(critiques && envois, 'les deux familles sont distinctes')
  // ⚠ LE CŒUR DU TEST : si les deux arguments etaient echanges, c est ICI que
  // ca se verrait — et nulle part dans les assertions de source.
  assert.equal(critiques.gte, null,
    'la surreservation n a AUCUNE borne de date : une alarme ancienne doit rester visible')
  assert.equal(envois.gte, seuil, 'la famille envoi porte le seuil, et elle seule')
  // Un plafond PAR famille : c est ce qui empeche l envoi de chasser le conflit.
  assert.equal(critiques.limit, 25)
  assert.equal(envois.limit, 25)
  assert.ok(critiques.trie && envois.trie, 'les deux sont triees')
  // Et la famille envoi ne contient pas la surreservation, sinon le seuil la
  // masquerait par la bande.
  assert.ok(!(envois.types || []).includes('overbooking'))
  assert.ok((envois.types || []).length >= 2, 'et elle porte bien les types d envoi')
})
