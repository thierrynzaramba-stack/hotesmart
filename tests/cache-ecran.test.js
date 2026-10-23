// tests/cache-ecran.test.js
//
// LOT (b) DE LA SPEC PERFORMANCE : l'affichage INSTANTANE. `shared/cache-ecran.js`
// garde les dernieres donnees connues d'un ecran dans le navigateur, pour que la
// deuxieme ouverture de la journee ne soit pas une page blanche.
//
// ⚠ UN CACHE DE DONNEES D'HOTE EST UNE SURFACE DE FUITE, et ce fichier le traite
// comme telle. Deux interdits de la spec s'y jouent :
//   · interdit 1 : aucune donnee d'hote dans un cache PARTAGE — ici c'est le
//     `localStorage` du navigateur, donc prive par construction, mais la CLE
//     doit porter l'utilisateur ET le compte : le selecteur de compte permet a
//     un membre delegue de passer d'un compte a l'autre dans le meme onglet ;
//   · interdit 2 : aucun etat critique (codes d'acces, paiements,
//     surreservation) affiche depuis le cache sans relecture.
//
// ⚠ COMMENT CE FICHIER CHARGE LE MODULE. `shared/cache-ecran.js` est un module
// ES sans import : on retire les mots-cles `export` et on execute la VRAIE
// source dans un `vm`, avec un faux `localStorage`. Les objets rendus
// traversent donc un realm — on compare par copie (`JSON.parse(JSON.stringify)`)
// et non par `deepEqual` direct, piege deja paye par ce depot.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'shared/cache-ecran.js'), 'utf8')

const MOI = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const AUTRE_MEMBRE = '18920ead-f936-4e26-b62e-9a5f52b5e657'
const COMPTE_A = 'aaaa0000-1111-4222-8333-444444444444'
const COMPTE_B = 'bbbb0000-1111-4222-8333-444444444444'

const copie = (x) => JSON.parse(JSON.stringify(x))

function charger ({ horloge = null } = {}) {
  const magasin = new Map()
  const localStorage = {
    get length () { return magasin.size },
    key: (i) => [...magasin.keys()][i] ?? null,
    getItem: (k) => (magasin.has(k) ? magasin.get(k) : null),
    setItem: (k, v) => { magasin.set(k, String(v)) },
    removeItem: (k) => { magasin.delete(k) }
  }
  const sandbox = { localStorage, JSON, Object, console, module: { exports: {} } }
  if (horloge) sandbox.Date = new Proxy(Date, { apply: (t, s, a) => Reflect.apply(t, s, a),
    get: (t, p) => (p === 'now' ? horloge : t[p]) })
  const code = SOURCE.replace(/^export const /gm, 'const ')
    .replace(/^export function /gm, 'function ')
    + '\n;module.exports = { ecrire, lire, oublierTout, _interne }'
  vm.runInNewContext(code, sandbox, { filename: 'shared/cache-ecran.js' })
  return { ...sandbox.module.exports, magasin }
}

const ECRAN = {
  jour: '2026-10-23',
  biens: [{ id: 'b1', name: 'La bulle' }],
  taches: [{ id: 1 }],
  // Les trois etats critiques, tels que l'endpoint les rend.
  etats_arrivee: { B1: { menage: 'fait', codeEtat: 'transmis' } },
  alarmes: [{ id: 9, type: 'overbooking', detail: 'deux resas sur la meme nuit' }],
  notes: { global: { note_sur_5: 4.7 } },
  fait_pour_vous: { messages_ia: 10 }
}

// ─── Interdit 2 : les etats critiques ─────────────────────────────────────────

test("LE TEST QUI COMPTE : l'etat du code et l'alarme ne sont JAMAIS ecrits", () => {
  // ⚠ RETIRES A L'ECRITURE, PAS FILTRES A LA LECTURE, et la difference est
  // tout l'interet : ce qui n'est pas ECRIT ne peut pas fuiter par un lecteur
  // distrait — ni par un second lecteur ajoute dans six mois, ni par l'onglet
  // d'a cote, ni par quelqu'un qui ouvre la console.
  const c = charger()
  assert.strictEqual(c.ecrire('aujourdhui', MOI, COMPTE_A, ECRAN), true)
  const brut = [...c.magasin.values()][0]
  assert.ok(!brut.includes('codeEtat'), "l'etat du code d'acces est ecrit dans le cache")
  assert.ok(!brut.includes('transmis'), "le verdict du code est ecrit dans le cache")
  assert.ok(!brut.includes('overbooking'), "l'alarme de surreservation est ecrite dans le cache")
  assert.ok(!brut.includes('deux resas'), "le detail de l'alarme est ecrit dans le cache")

  const relu = copie(c.lire('aujourdhui', MOI, COMPTE_A).donnees)
  assert.strictEqual(relu.etats_arrivee, undefined,
    "l'ecran pourrait afficher un code d'acces depuis le cache : l'hote croirait que le voyageur l'a recu")
  assert.strictEqual(relu.alarmes, undefined,
    'une surreservation acquittee reapparaitrait, ou une nouvelle serait manquee')
  // Et le reste est bien garde, sinon le cache ne servirait a rien.
  assert.deepEqual(relu.biens, [{ id: 'b1', name: 'La bulle' }])
  assert.deepEqual(relu.taches, [{ id: 1 }])
  assert.strictEqual(relu.jour, '2026-10-23')
})

test('la liste des blocs jamais gardes couvre les deux etats critiques de cet ecran', () => {
  // Une liste de noms vieillit mal : si un bloc critique est ajoute a
  // l'endpoint sans etre ajoute ici, il serait garde en silence. Ce test
  // nomme ce qui DOIT y etre ; le fichier d'isolation nomme ce que l'endpoint
  // rend.
  const { _interne } = charger()
  for (const bloc of ['etats_arrivee', 'alarmes']) {
    assert.ok(_interne.JAMAIS_GARDES.includes(bloc), `${bloc} n'est plus protege`)
  }
})

// ─── Interdit 1 : la cle porte l'utilisateur ET le compte ─────────────────────

test("LE TEST QUI COMPTE : le cache d'un compte n'est jamais servi pour un autre", () => {
  // Le selecteur de compte fait exactement ce geste : meme navigateur, meme
  // utilisateur, deux comptes. Une cle qui ne porterait que l'ecran afficherait
  // les chiffres du compte precedent — une fuite entre comptes.
  const c = charger()
  c.ecrire('aujourdhui', MOI, COMPTE_A, { biens: [{ id: 'a' }] })
  c.ecrire('aujourdhui', MOI, COMPTE_B, { biens: [{ id: 'b' }] })
  assert.deepEqual(copie(c.lire('aujourdhui', MOI, COMPTE_A).donnees.biens), [{ id: 'a' }])
  assert.deepEqual(copie(c.lire('aujourdhui', MOI, COMPTE_B).donnees.biens), [{ id: 'b' }])
  // Et l'autre personne sur le meme poste ne lit rien du premier.
  assert.strictEqual(c.lire('aujourdhui', AUTRE_MEMBRE, COMPTE_A), null,
    "un autre utilisateur lit le cache du premier : la cle ne porte pas l'utilisateur")
})

test('une cle incomplete n ecrit rien et ne lit rien', () => {
  // ⚠ LE CAS QUI COMPTE : `compteCourant()` rend `null` tant que le contexte
  // n'est pas charge. Sans cette garde, la cle deviendrait
  // `hs.ecran.aujourdhui.<moi>.null` — une cle VALIDE, partagee par tous les
  // comptes de cet utilisateur. La fuite exacte que la cle devait fermer.
  const c = charger()
  assert.strictEqual(c.ecrire('aujourdhui', MOI, null, ECRAN), false)
  assert.strictEqual(c.ecrire('aujourdhui', null, COMPTE_A, ECRAN), false)
  assert.strictEqual(c.ecrire(null, MOI, COMPTE_A, ECRAN), false)
  assert.strictEqual(c.magasin.size, 0, 'une cle incomplete a quand meme ecrit')
  assert.strictEqual(c.lire('aujourdhui', MOI, null), null)
})

test('la deconnexion efface TOUS les ecrans de TOUS les comptes', () => {
  const c = charger()
  c.ecrire('aujourdhui', MOI, COMPTE_A, { biens: [] })
  c.ecrire('aujourdhui', MOI, COMPTE_B, { biens: [] })
  c.ecrire('menages', AUTRE_MEMBRE, COMPTE_A, { biens: [] })
  c.magasin.set('autre.chose', 'a garder')   // ce qui n'est pas a nous reste
  assert.strictEqual(c.oublierTout(), 3)
  assert.strictEqual(c.magasin.size, 1)
  assert.strictEqual(c.magasin.get('autre.chose'), 'a garder')
})

// ─── L'age, et la peremption ──────────────────────────────────────────────────

test("LE TEST QUI COMPTE : la lecture rend l'AGE, et refuse au-dela de 12 h", () => {
  // Un chiffre dont personne ne connait l'age est un chiffre faux en
  // puissance : une page ouverte depuis la veille montrerait les arrivees
  // d'hier comme celles du jour.
  let maintenant = 1_700_000_000_000
  const c = charger({ horloge: () => maintenant })
  c.ecrire('aujourdhui', MOI, COMPTE_A, { biens: [] })
  maintenant += 60_000
  assert.strictEqual(c.lire('aujourdhui', MOI, COMPTE_A).age_ms, 60_000)
  maintenant += 11 * 3600_000
  assert.ok(c.lire('aujourdhui', MOI, COMPTE_A), 'refuse a 11 h, alors que la peremption est a 12')
  maintenant += 2 * 3600_000
  assert.strictEqual(c.lire('aujourdhui', MOI, COMPTE_A), null,
    "sert des donnees de plus de 12 h : l'ecran afficherait les arrivees d'hier")
})

test("LE TEST QUI COMPTE : un age NEGATIF est refuse, pas lu comme « tout frais »", () => {
  // ⚠ CE DEFAUT A ETE TROUVE PAR UNE REVIEW SUR LE CACHE DU CONTEXTE DE
  // COMPTE, au lot (a). Une horloge en avance puis corrigee en arriere — ou
  // une machine qui se synchronise au reveil — ecrit un `ts` dans le futur.
  // `age < PEREMPTION` est alors vrai pour l'eternite : le cache ne se
  // rafraichit plus JAMAIS, en silence.
  let maintenant = 1_700_000_000_000
  const c = charger({ horloge: () => maintenant })
  c.ecrire('aujourdhui', MOI, COMPTE_A, { biens: [] })
  maintenant -= 3600_000
  assert.strictEqual(c.lire('aujourdhui', MOI, COMPTE_A), null,
    'un horodatage dans le futur rend le cache eternel')
})

test('un contenu illisible ou tronque ne fait pas planter l ecran', () => {
  // `localStorage` peut rendre n'importe quoi : quota atteint en pleine
  // ecriture, extension qui bricole, version precedente du format.
  const c = charger()
  const k = c._interne.cle('aujourdhui', MOI, COMPTE_A)
  for (const brut of ['{', 'null', '[]', '{"ts":123}', '{"donnees":{}}', '']) {
    c.magasin.set(k, brut)
    assert.strictEqual(c.lire('aujourdhui', MOI, COMPTE_A), null, `rendu pour ${brut}`)
  }
})

test('un localStorage indisponible ne fait pas planter la page', () => {
  // Navigation privee, cookies bloques : chaque acces LEVE. L'affichage
  // instantane est un confort, jamais une dependance.
  const code = SOURCE.replace(/^export const /gm, 'const ')
    .replace(/^export function /gm, 'function ')
    + '\n;module.exports = { ecrire, lire, oublierTout }'
  const sandbox = { JSON, Object, console, module: { exports: {} },
    localStorage: { get length () { throw new Error('bloque') },
      getItem () { throw new Error('bloque') }, setItem () { throw new Error('bloque') },
      removeItem () { throw new Error('bloque') }, key () { throw new Error('bloque') } } }
  vm.runInNewContext(code, sandbox, { filename: 'shared/cache-ecran.js' })
  const c = sandbox.module.exports
  assert.strictEqual(c.ecrire('aujourdhui', MOI, COMPTE_A, ECRAN), false)
  assert.strictEqual(c.lire('aujourdhui', MOI, COMPTE_A), null)
  assert.strictEqual(c.oublierTout(), 0)
})

// ─── Le cablage de la page ────────────────────────────────────────────────────

test("LE TEST QUI COMPTE : la page efface le cache a la deconnexion", () => {
  // Sans cela, la personne suivante sur le poste retrouve les chiffres du
  // precedent — et ce poste est souvent partage (bureau, tablette d'accueil).
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared/supabase.js'), 'utf8')
  assert.match(src, /cache-ecran/, 'shared/supabase.js ne connait pas le cache des ecrans')
  assert.match(src, /oublierTout/, 'la deconnexion n efface pas le cache des ecrans')
})

test("LE TEST QUI COMPTE : l'accueil n'ecrit au cache que ce qu'il vient d'afficher", () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages/aujourdhui.html'), 'utf8')
  assert.match(page, /CacheEcran\.lire\('aujourdhui'/, "l'accueil ne lit pas le cache")
  assert.match(page, /CacheEcran\.ecrire\('aujourdhui', moi\(\), compteCourant\(\)/,
    "l'accueil n'ecrit pas le cache avec la cle utilisateur + compte")
  // ⚠ ET L'AGE EST GARDE EN ETAT, parce que l'ecran doit pouvoir le montrer.
  assert.match(page, /ageCache/, "l'age du cache n'est pas garde : l'ecran ne peut pas le dire")
})
