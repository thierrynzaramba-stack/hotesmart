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

// ⚠ LE MOIS COURANT SE CALCULE, IL NE S'ECRIT PAS. Regle du depot : dates
// relatives si le test lit l'horloge, dates figees s'il injecte le temps. Ici
// `charger()` sans `horloge` laisse le module lire l'horloge reelle, donc la
// fixture doit la suivre — un « 2026-10 » fige rougirait le 1er novembre.
const moisDeLHorloge = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

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

// ⚠ CETTE FIXTURE PORTE LE CODE D'ACCES DANS `taches`, ET C'EST LE POINT.
// `lib/cron-arrival-code.js` ecrit litteralement
//   summary: `Code d'accès généré pour ${guestName} : ${seamCode} — …`
//   suggested_reply: <le message d'arrivee rendu, code compris>
// en `status: 'pending_validation'`. Ma premiere version de ce test mettait
// `taches: [{ id: 1 }]` et ASSERTAIT que `taches` etait garde : elle gravait
// donc la violation de l'interdit 2 en contrat. Une fixture qui ne ressemble
// pas a la donnee reelle ne prouve rien.
const CODE = '483921'
const ECRAN = {
  jour: '2026-10-23',
  biens: [{ id: 'b1', name: 'La bulle' }],
  taches: [{
    id: 1, book_id: 'B1', status: 'pending_validation', guest_name: 'Camille',
    summary: `Code d'accès généré pour Camille : ${CODE} — envoi automatique impossible.`,
    suggested_reply: `Bonjour Camille, votre code d'entrée est le ${CODE}.`
  }],
  // Les etats critiques, tels que l'endpoint les rend.
  etats_arrivee: { B1: { menage: 'fait', codeEtat: 'transmis' } },
  alarmes: [{ id: 9, type: 'overbooking', detail: 'deux resas sur la meme nuit' }],
  conversations: ['B1', 'B2'],
  notes: { global: { note_sur_5: 4.7 } },
  // ⚠ LA PREMIERE DONNEE NOMINATIVE DE CET ECRAN (etape 2 du lot Aujourd'hui
  // V5, 25 octobre 2026) : le bloc « Derniers avis » porte le prenom et
  // l'initiale du voyageur. Le droit qui le gouverne (`reservations`) n'est pas
  // dans la cle du cache, et aucune purge ne suit une revocation.
  derniers_avis: [{ id: 'r1', texte: 'Sejour parfait', voyageur: 'Claire B.', note_sur_5: 5 }],
  // ⚠ `surreservation` EST DANS CETTE FIXTURE, et il n'y etait pas : ma
  // premiere version assertait `deepEqual(fait_pour_vous, { messages_ia: 10 })`
  // sur un objet qui ne portait QUE cette cle — elle gravait donc l'omission
  // en contrat, exactement comme `taches` y etait entre.
  fait_pour_vous: { messages_ia: 10, surreservation: 2, menages: 5, prix: 7 }
}

// ─── Interdit 2 : les etats critiques ─────────────────────────────────────────

test("LE TEST QUI COMPTE : le CODE D'ACCES n'atterrit jamais dans le navigateur", () => {
  // ⚠ LE CONSTAT LE PLUS CHER DE LA REVIEW DU LOT (b). Je retirais
  // `etats_arrivee` et `alarmes`, en pensant avoir couvert les etats
  // critiques — et je gardais `taches`, qui PORTE le code d'acces en clair
  // dans deux champs. Le code du voyageur partait donc sur le disque pour
  // 12 h, et se repeignait au premier affichage meme si la serrure avait ete
  // re-codee depuis : « un code affiche depuis le cache ferait croire a l'hote
  // qu'un voyageur l'a recu », mot pour mot le motif de l'interdit.
  const c = charger()
  c.ecrire('aujourdhui', MOI, COMPTE_A, ECRAN)
  const brut = [...c.magasin.values()][0]
  assert.ok(!brut.includes(CODE),
    "LE CODE D'ACCES EST ECRIT SUR LE DISQUE : " + brut.slice(0, 200))
  assert.ok(!brut.includes('Code d\'accès'), 'le resume de la tache est garde')
  assert.ok(!brut.includes('code d\'entrée'), 'la reponse proposee est gardee')
  const relu = copie(c.lire('aujourdhui', MOI, COMPTE_A).donnees)
  assert.strictEqual(relu.taches, undefined,
    'les taches sont gardees : elles portent le code, et un fil perime fait repondre deux fois')
})

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
  assert.strictEqual(relu.conversations, undefined,
    'un fil perime fait repondre deux fois (spec §5.1)')
  // ⚠ LE PRENOM DU VOYAGEUR N'EST PAS ECRIT SUR LE DISQUE. La cle du cache
  // porte l'ecran, l'utilisateur et le compte — jamais les DROITS. Un membre a
  // qui l'on retire `reservations` relirait sinon les prenoms ecrits quand il
  // l'avait, pendant douze heures, et `purgerCachesLocaux` n'est appele qu'a la
  // deconnexion, jamais a une revocation.
  assert.ok(!brut.includes('Claire B.'), 'le prenom du voyageur est ecrit dans le cache')
  assert.strictEqual(relu.derniers_avis, undefined,
    'les derniers avis sont gardes : ils portent un prenom, et le droit qui les gouverne n est pas dans la cle')
  // Et le reste est bien garde, sinon le cache ne servirait a rien : la liste
  // des biens, les notes et les compteurs de la semaine — rien qui perime en
  // une heure, rien qu'un hote puisse prendre pour un fait du jour.
  assert.deepEqual(relu.biens, [{ id: 'b1', name: 'La bulle' }])
  assert.deepEqual(relu.notes, { global: { note_sur_5: 4.7 } })
  assert.strictEqual('surreservation' in (relu.fait_pour_vous || {}), false,
    'le compte de surreservation est garde : l interdit 2 le nomme')
  assert.strictEqual(relu.jour, '2026-10-23')
})

test('la liste des blocs jamais gardes couvre les deux etats critiques de cet ecran', () => {
  // Une liste de noms vieillit mal : si un bloc critique est ajoute a
  // l'endpoint sans etre ajoute ici, il serait garde en silence. Ce test
  // nomme ce qui DOIT y etre ; le fichier d'isolation nomme ce que l'endpoint
  // rend.
  const { _interne } = charger()
  for (const bloc of ['etats_arrivee', 'alarmes', 'taches', 'arrivees', 'conversations',
    'derniers_avis']) {
    assert.ok(_interne.JAMAIS_GARDES.includes(bloc), `${bloc} n'est plus protege`)
  }
  // Et le champ critique a l'interieur d'un bloc garde.
  assert.deepEqual(_interne.CHAMPS_JAMAIS_GARDES.fait_pour_vous, ['surreservation'],
    'le compte de surreservation n est plus retire de « Fait pour vous »')
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

test("LE TEST QUI COMPTE : les CINQ sorties effacent le cache, par un seul geste partage", () => {
  // ⚠ UN SEUL DES QUATRE CHEMINS LE FAISAIT, ET LA REVIEW LES A COMPTES.
  // Le module a choisi `localStorage` plutot que `sessionStorage` POUR qu'il
  // survive a l'onglet ; la contrepartie explicite est l'effacement a la
  // sortie. Il n'etait cable que dans `shared/supabase.js`. Les trois autres :
  //   · `components/auth-guard.js` — c'est le cas « un AUTRE utilisateur sur ce
  //     navigateur », exactement celui qu'on veut couvrir. Il nettoyait deux
  //     cles de `sessionStorage` et appelait `reinitialiser()`, qui ne touche
  //     ni au `localStorage` ni a ce cache. Le premier affichage de B montrait
  //     les logements, les notes et les compteurs de A.
  //   · `pages/compte.html` — la SUPPRESSION DE COMPTE appelle `signOut()` en
  //     direct : les chiffres de l'hote restaient sur le disque apres la
  //     suppression de son compte, jusqu'a 12 h — ou indefiniment, puisqu'une
  //     cle perimee est refusee a la lecture mais n'est pas effacee.
  //   · `pages/invitation.html` — l'invite arrive sur un compte NEUF dans le
  //     meme onglet.
  // ⚠ CINQ, PAS QUATRE — ET LE CINQUIEME N'EFFACAIT RIEN DU TOUT.
  // `pages/invitation.html` a DEUX boutons : « rejoindre » et « ce n'est pas
  // moi ». Le second est une sortie de session (`supabase.auth.signOut()` en
  // direct), et mon inventaire l'avait manque — un hote qui ouvre un lien
  // d'invitation sur la tablette partagee du bureau et clique « ce n'est pas
  // moi » laissait `hs.ecran.*` ET `hs_compte_courant` sur le disque.
  //
  // ⚠ ET LE TEST PRECEDENT NE POUVAIT PAS LE VOIR : il cherchait
  // `/cache-ecran/` et `/oublierTout/` dans le FICHIER ENTIER, et la branche
  // « rejoindre », onze lignes plus haut, satisfaisait les deux. Il serait
  // aussi passe sur un appel mort ou commente. On teste donc chaque GESTE,
  // dans son bloc.
  //
  // ⚠ ET LES CINQ APPELLENT LE MEME GESTE PARTAGE. Chaque recopie oubliait une
  // moitie differente : `compte.html` ne vidait que le cache d'ecran et
  // laissait le compte courant ; `auth-guard` ne vidait que le compte courant.
  // Un seul `purgerCachesLocaux` ferme la classe.
  const geste = /purgerCachesLocaux\(\)/
  const blocs = [
    ['shared/supabase.js', 'la deconnexion', /export async function signOut[\s\S]*?\n\}/],
    ['components/auth-guard.js', 'un autre utilisateur sur ce navigateur',
      /if \(cachedUserId && cachedUserId !== userId\)[\s\S]*?\n    \}/],
    ['pages/compte.html', 'la suppression de compte',
      /btnDeleteFinal[\s\S]*?login\.html\?deleted=1/],
    ['pages/invitation.html', "« ce n'est pas moi »",
      /\$\('b-non'\)\.onclick[\s\S]*?\n      \}/]
  ]
  for (const [f, quand, borne] of blocs) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    const bloc = (src.match(borne) || [''])[0]
    assert.ok(bloc, `${f} : le bloc de ${quand} est introuvable`)
    assert.match(bloc, geste, `${f} (${quand}) n appelle pas la purge partagee`)
  }
  // Le cinquieme geste : « rejoindre » un compte, qui oublie la LISTE des
  // comptes et le cache d'ecran, mais garde le compte qu'on vient de rejoindre.
  const inv = fs.readFileSync(path.join(__dirname, '..', 'pages/invitation.html'), 'utf8')
  assert.match(inv, /oublierCacheComptes\(\)/, 'rejoindre un compte ne rafraichit pas la liste')
  assert.match(inv, /cache-ecran[\s\S]{0,200}oublierTout/,
    'rejoindre un compte ne vide pas le cache d ecran')

  // Et le geste partage vide bien LES DEUX caches.
  const sb = fs.readFileSync(path.join(__dirname, '..', 'shared/supabase.js'), 'utf8')
  const purge = (sb.match(/export async function purgerCachesLocaux[\s\S]*?\n\}/) || [''])[0]
  assert.match(purge, /reinitialiser\(\)/, 'la purge partagee ne vide pas le compte courant')
  assert.match(purge, /oublierTout\(\)/, 'la purge partagee ne vide pas le cache d ecran')
})

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

// ─── Les revenus : gardes 12 h, mais SEULEMENT pour le mois courant ──────────

test("LE TEST QUI COMPTE : le bloc revenus se garde pour le mois COURANT", () => {
  // Decision Q8 de Thierry du 24 octobre 2026 : « Cache des revenus par bien :
  // autorise 12 h, purge a la deconnexion. » Ce sont des totaux par LOGEMENT,
  // pas des montants par voyageur — donc cachables, contrairement aux cinq
  // blocs critiques.
  const { ecrire, lire } = charger()
  const mois = moisDeLHorloge()
  const avecRevenus = { ...ECRAN, mois, revenus: { mois, total: { total_cents: 123400 } } }
  ecrire('aujourdhui', MOI, COMPTE_A, avecRevenus)
  // ⚠ `lire` rend une ENVELOPPE `{ donnees, age_ms }`, pas les donnees nues.
  // Ma premiere version lisait `.revenus` a la racine et rougissait en
  // accusant le module : le test etait faux, pas le code.
  const relu = copie(lire('aujourdhui', MOI, COMPTE_A)).donnees
  assert.ok(relu.revenus, 'le bloc revenus du mois courant doit etre garde')
  assert.strictEqual(relu.revenus.total.total_cents, 123400)
})

test("LE TEST QUI COMPTE : un AUTRE mois n est PAS garde — sinon il se repeindrait a la place du bon", () => {
  // ⚠ LA CLE DU CACHE PORTE L'ECRAN, L'UTILISATEUR ET LE COMPTE, JAMAIS LE MOIS.
  // Un hote qui consulte octobre, puis revient le lendemain sur son accueil,
  // verrait donc les chiffres d'OCTOBRE repeints instantanement sous l'etiquette
  // du mois courant — un total faux, affiche avec l'aplomb des vrais, pendant
  // douze heures. Ce n'est pas un defaut de confidentialite : c'est un defaut de
  // JUSTESSE, et il est de la meme famille que
  // `fait_pour_vous.surreservation` — la donnee critique vit dans la VALEUR d'un
  // champ, pas dans le bloc.
  const { ecrire, lire } = charger()
  const autre = '2024-03'
  ecrire('aujourdhui', MOI, COMPTE_A, { ...ECRAN, mois: autre, revenus: { mois: autre, total: { total_cents: 999900 } } })
  const relu = copie(lire('aujourdhui', MOI, COMPTE_A)).donnees
  assert.strictEqual(relu.revenus, undefined,
    'les revenus d un autre mois sont gardes : ils s afficheront a la place du mois courant')
  // Le reste de l'ecran reste garde : on retire un bloc, pas la page.
  assert.ok(relu.biens, 'le reste de l ecran a disparu avec le bloc revenus')
})

test('un bloc revenus sans mois, ou malforme, n est pas garde', () => {
  // Un bloc dont on ne peut pas VERIFIER le mois ne se garde pas : le repli sur
  // est de ne rien afficher instantanement, pas d afficher peut-etre faux.
  const { ecrire, lire } = charger()
  for (const revenus of [{ total: { total_cents: 1 } }, {}, null, 'x', 42, [], { mois: null }, { mois: '2026-13' }]) {
    ecrire('aujourdhui', MOI, COMPTE_A, { ...ECRAN, revenus })
    const relu = copie(lire('aujourdhui', MOI, COMPTE_A)).donnees
    assert.strictEqual(relu.revenus, undefined, `garde a tort : ${JSON.stringify(revenus)}`)
  }
})
