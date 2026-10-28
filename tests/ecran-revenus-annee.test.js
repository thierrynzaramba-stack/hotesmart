// tests/ecran-revenus-annee.test.js — `/api/ecran/revenus-annee`
//
// ⚠ CET ENDPOINT LIT AVEC LA CLE DE SERVICE, donc AUCUNE des 28 policies RLS
// ne s'applique. Le seul cloisonnement entre comptes est celui qu'on ecrit en
// JavaScript — `p_user_id` et `p_refs` — et c'est ce fichier qui le garde. Les
// dix fuites du chantier profils et droits sont toutes nees de cette famille :
// une lecture qui oublie son perimetre, dans un fichier ou les autres
// l'appliquent.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')

const TITULAIRE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const BIEN_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const BIEN_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const BIEN_MORT = 'dddddddd-3333-4333-8333-dddddddddddd'

const TOUS_DOMAINES = ['reservations', 'menages', 'messages', 'avis', 'reglages']

// Un appel complet, avec la garde et le client doubles.
async function appeler ({
  query = {}, methode = 'GET', titulaire = true, refs = null,
  domaines = TOUS_DOMAINES, lignes = [], biens = [BIEN_A, BIEN_B],
  erreurRpc = null, erreurBiens = null,
  // Les lignes de `comparables_releves`, et une erreur de lecture au besoin.
  releves = [], erreurReleves = null
} = {}) {
  const vu = { rpc: [], selects: [], filtres: [] }

  const client = {
    rpc (nom, args) {
      vu.rpc.push({ nom, args })
      return Promise.resolve({ data: erreurRpc ? null : lignes, error: erreurRpc })
    },
    from (table) {
      vu.selects.push(table)
      // ⚠ LE DOUBLE REPOND PAR TABLE. Une seule reponse pour toutes les tables
      // ferait passer la lecture des comparables pour une liste de biens, et
      // les tests de la bande mesureraient autre chose que ce qu'ils croient.
      const comparables = table === 'comparables_releves'
      const reponse = () => comparables
        ? { data: erreurReleves ? null : releves, error: erreurReleves }
        : { data: erreurBiens ? null : biens.map(id => ({ id })), error: erreurBiens }
      const q = {
        select () { return q },
        eq (c, v) { vu.filtres.push(['eq', c, v]); return q },
        in (c, v) { vu.filtres.push(['in', c, v]); return q },
        gte (c, v) { vu.filtres.push(['gte', c, v]); return q },
        lt (c, v) { vu.filtres.push(['lt', c, v]); return q },
        order (c, o) { vu.filtres.push(['order', c, (o || {}).ascending]); return q },
        limit () { return Promise.resolve(reponse()) },
        then (r) { return Promise.resolve(reponse()).then(r) }
      }
      return q
    }
  }

  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client

  // ⚠ ON CHARGE AVANT DE CAPTURER. Lire `require.cache[...]` avant le `require`
  // rend un cache vide, donc un double PARTIEL qui perd `UUID_RE` — que
  // l'endpoint importe du MEME module. Le piege est documente dans
  // `tests/ecran-aujourdhui-isolation.test.js`, qui l'a vecu.
  const absGarde = require.resolve('../lib/require-permission')
  require('../lib/require-permission')
  const vraieGarde = require.cache[absGarde].exports

  const permissions = { property_scope: refs === null ? 'all' : 'selected',
    property_ids: refs === null ? [] : refs, property_refs: [] }
  for (const d of TOUS_DOMAINES) permissions[d] = domaines.includes(d) ? 'read' : 'none'
  const contexte = titulaire
    ? { userId: TITULAIRE, accountUserId: TITULAIRE, profil: null, permissions: null }
    : { userId: MEMBRE, accountUserId: TITULAIRE,
        profil: { active: true, accepted_at: '2026-01-01', member_user_id: MEMBRE, account_user_id: TITULAIRE },
        permissions }
  // ⚠ LE DOUBLE POSE L'EN-TETE PRIVE, COMME LA VRAIE GARDE. Sans lui, le test
  // « l'en-tete precede le refus de methode » ne peut PAS echouer : il
  // n'assertait que le 405 et le `Allow`, que l'ordre inverse satisfait aussi.
  // Mesure de la review : deplacer `contexteDEcran` APRES le refus de methode —
  // la regression exacte de la dette 90 — rendait `fail 0`.
  require.cache[absGarde].exports = Object.assign({}, vraieGarde, {
    contexteDEcran: async (rq, rs) => {
      if (rs && typeof rs.setHeader === 'function') rs.setHeader('cache-control', 'private, no-store')
      return { ok: true, userId: contexte.userId, accountUserId: TITULAIRE, contexte }
    }
  })

  const absEndpoint = require.resolve('../api/ecran/revenus-annee')
  delete require.cache[absEndpoint]
  const endpoint = require(absEndpoint)

  const rep = { statut: null, charge: null, entetes: {} }
  const res = {
    setHeader (k, v) { rep.entetes[k] = v },
    status (s) { rep.statut = s; return res },
    json (c) { rep.charge = c; return res }
  }
  // ⚠ LA RESTAURATION PASSE PAR UN `finally`. Sans lui, une assertion qui leve
  // laisse le faux `createClient` et la fausse garde en place pour les tests
  // SUIVANTS du meme fichier : des rouges en cascade dont le premier seul est
  // vrai. Ce depot compte ses rouges, et un compte fausse coute une enquete.
  try {
    await endpoint({ method: methode, query }, res)
  } finally {
    require.cache[absSdk].exports.createClient = vraiCreate
    require.cache[absGarde].exports = vraieGarde
    delete require.cache[absEndpoint]
  }
  return { ...rep, vu }
}

// ⚠ DES MONTANTS DISTINCTS PAR DEFAUT, ET C'EST UN CORRECTIF. Ma fixture
// mettait tout a zero, et le seul test qui posait des euros donnait
// `recu_cents` EGAL a `total_cents`. Trois mutations mesurees par la review
// rendaient donc `fail 0` : recu et a-venir permutes, le total prive de
// l'a-venir, et le jour de reference remplace par une date morte. Un jeu
// d'essai ou les grandeurs ne se distinguent pas ne distingue rien.
const ligne = (uuid, annee, mois, o = {}) => ({
  property_uuid: uuid, annee, mois,
  sejours: 3, recu_cents: 700, a_venir_cents: 1300, total_cents: 2000,
  bruts: 1, sans_montant: 2, ...o
})

test("LE TEST QUI COMPTE : sans le droit `reservations`, la fonction n'est PAS appelee", async () => {
  // ⚠ LE MASQUAGE DE L'ECRAN EST UN CONFORT ; CETTE GARDE PROTEGE. Le test qui
  // tranche, selon la regle du depot : si on retire le masquage et qu'on
  // clique, le serveur refuse-t-il en 403 ? Et il refuse AVANT de lire.
  // ⚠ C'EST UN MEMBRE, ET IL LE FAUT : un TITULAIRE a tous les droits par
  // construction, `peutLire` lui rend `true` quoi que portent ses permissions.
  // Ma premiere version de ce test passait `domaines: []` sur un titulaire :
  // elle rendait 200 et prouvait l'inverse de ce qu'elle annonçait.
  const r = await appeler({ titulaire: false, refs: [BIEN_A], domaines: ['menages', 'messages'] })
  assert.strictEqual(r.statut, 403, `statut ${r.statut}`)
  assert.deepEqual(r.vu.rpc, [], 'la fonction SQL a ete appelee malgre le refus')
  assert.deepEqual(r.vu.selects, [], 'une table a ete lue malgre le refus')
})

test("LE TEST QUI COMPTE : un titulaire ne porte AUCUNE borne, un membre en porte une", async () => {
  const t = await appeler({ titulaire: true })
  assert.strictEqual(t.vu.rpc.length, 1)
  assert.strictEqual(t.vu.rpc[0].args.p_user_id, TITULAIRE,
    'le compte interroge n est pas celui de la garde')
  assert.strictEqual(t.vu.rpc[0].args.p_refs, null,
    'un titulaire recoit une borne : il verrait MOINS que son compte')

  const m = await appeler({ titulaire: false, refs: [BIEN_A] })
  assert.deepEqual(m.vu.rpc[0].args.p_refs, [BIEN_A],
    'le membre delegue lit SANS borne : c est une fuite inter-biens')

  // ⚠ ET LA REQUETE ESSAIE DE DESIGNER UN AUTRE COMPTE. Mon assertion
  // precedente verifiait bien `p_user_id === TITULAIRE`, mais AUCUN scenario ne
  // passait de compte dans la requete : la borne n'etait jamais mise a
  // l'epreuve. Mesure de la review : la mutation
  // `p_user_id: req.query.compte || compte` rendait `fail 0`. Un garde-fou qui
  // ne peut pas echouer n'en est pas un.
  const AUTRE = '99999999-9999-4999-8999-999999999999'
  const vole = await appeler({
    titulaire: false, refs: [BIEN_A],
    query: { annee: '2026', compte: AUTRE, user_id: AUTRE, p_user_id: AUTRE, accountUserId: AUTRE }
  })
  assert.strictEqual(vole.vu.rpc[0].args.p_user_id, TITULAIRE,
    'le compte interroge vient de la REQUETE : un hote lirait le compte d un autre')
  assert.deepEqual(vole.vu.rpc[0].args.p_refs, [BIEN_A],
    'le perimetre vient de la requete : le membre sortirait de ses biens')
})

test("LE TEST QUI COMPTE : un perimetre VIDE rend un ecran vide, jamais le compte entier", async () => {
  // ⚠ `[]` EST « FALSY-ADJACENT » : un `if (refs)` laisserait un perimetre vide
  // SANS filtre, donc tout le compte visible. C'est la forme exacte de
  // plusieurs des dix fuites du chantier profils et droits.
  const r = await appeler({ titulaire: false, refs: [] })
  assert.strictEqual(r.statut, 200)
  assert.deepEqual(r.vu.rpc, [], 'le perimetre vide a quand meme lu')
  assert.strictEqual(r.charge.perimetre_vide, true, 'l ecran ne sait pas que le perimetre est vide')
  assert.deepEqual(r.charge.par_bien, {}, 'des lignes sont rendues a un membre qui ne voit rien')
})

test("LE TEST QUI COMPTE : un perimetre sans UUID dit « je ne sais pas », pas zero", async () => {
  // Un membre dont la delegation n'est exprimee qu'en cles PROVIDER : `refsUuid`
  // vaut `[]` alors que le perimetre n'est pas vide. Rendre zero euro
  // affirmerait qu'il n'a rien gagne.
  const r = await appeler({ titulaire: false, refs: ['209413'] })
  assert.strictEqual(r.statut, 200)
  assert.deepEqual(r.vu.rpc, [], 'on a lu avec un perimetre qu on ne sait pas exprimer')
  assert.ok((r.charge.indisponibles || []).includes('revenus'),
    'l ecran croira que ces revenus valent zero')
  // ⚠ ET LA FORME COMPTE AUTANT QUE LE DRAPEAU. « Je ne sais pas » rendait le
  // MEME objet vide qu'un perimetre legitimement vide, et le seul discriminant
  // etait `indisponibles`. L'ecran testerait `par_bien === null` — le reflexe
  // que les branches d'echec lui enseignent — et afficherait 0 €.
  assert.strictEqual(r.charge.par_bien, null,
    'un perimetre qu on ne sait pas exprimer rend un objet VIDE : l ecran y lira zero euro')
  assert.strictEqual(r.charge.total, null)
  // Et le perimetre VIDE, lui, garde sa forme : c est un FAIT, pas une
  // ignorance — ce membre ne voit aucun bien, donc zero est la bonne reponse.
  const vide = await appeler({ titulaire: false, refs: [] })
  assert.deepEqual(vide.charge.par_bien, {},
    'un perimetre vide est devenu « je ne sais pas » : les deux ne se distinguent plus')
})

test("LE TEST QUI COMPTE : une annee hors bornes est REFUSEE, pas remplacee en silence", async () => {
  // Un ecran qui montre 2026 a qui a demande 1870 ment sur ce qu'il affiche, et
  // l hote ne verrait que le resultat.
  for (const mauvaise of ['1870', '9999', 'abcd', '20260']) {
    const r = await appeler({ query: { annee: mauvaise } })
    assert.strictEqual(r.statut, 400, `annee=${mauvaise} rend ${r.statut}`)
    assert.deepEqual(r.vu.rpc, [], `annee=${mauvaise} a quand meme lu`)
  }
  // Et une annee valide passe, telle quelle.
  const ok = await appeler({ query: { annee: '2025' } })
  assert.strictEqual(ok.vu.rpc[0].args.p_annee, 2025, 'l annee demandee n est pas celle transmise')
})

test("LE TEST QUI COMPTE : un logement SUPPRIME va dans la reserve, pas sur une ligne", async () => {
  // ⚠ `revenus_annee` groupe par `property_uuid` SANS jointure : un sejour d un
  // logement supprime garde son uuid, entre dans le total, et n a aucune ligne.
  // Le partage se fait ICI, cote serveur — un fait d argent ne se deduit pas a
  // l ecran.
  const r = await appeler({
    biens: [BIEN_A],
    lignes: [
      ligne(BIEN_A, 2026, 3, { total_cents: 20000, recu_cents: 20000 }),
      ligne(BIEN_MORT, 2026, 3, { total_cents: 10000, recu_cents: 10000 }),
      ligne(null, 2026, 3, { total_cents: 500, recu_cents: 500 })
    ]
  })
  assert.strictEqual(r.statut, 200)
  assert.deepEqual(Object.keys(r.charge.par_bien), [BIEN_A],
    'un logement supprime a fabrique une ligne')
  assert.strictEqual(r.charge.par_bien[BIEN_A]['2026-03'].total_cents, 20000)
  // Le bien mort ET le `property_uuid` nul vont tous deux dans la reserve :
  // c est la regle de `revenus_hors_mois`, version DEPLOYEE (`is null OR not
  // exists`), pas celle de la migration 3 qui ne comptait que les nuls.
  assert.strictEqual(r.charge.hors_biens['2026-03'].total_cents, 10500,
    'la reserve ne porte pas tout ce qui n est sur aucune ligne')
  // Et le total porte les trois : il ne doit jamais etre la somme des lignes.
  assert.strictEqual(r.charge.total['2026-03'].total_cents, 30500,
    'le total du compte a perdu l argent sans logement')
})

test("LE TEST QUI COMPTE : aucun trou n'est comble — un mois absent n'est pas un mois a zero", async () => {
  // ⚠ DECISION DE THIERRY DU 27 OCTOBRE 2026 : « la courbe d un logement
  // commence a son premier mois d activite ». Si l endpoint remplissait les
  // mois manquants de zeros, l ecran ne pourrait plus distinguer « rien vendu »
  // de « le bien n existait pas » — et la courbe partirait de janvier a zero
  // pour un logement ouvert en septembre.
  const r = await appeler({
    biens: [BIEN_A],
    lignes: [ligne(BIEN_A, 2026, 9, { total_cents: 1000 }), ligne(BIEN_A, 2026, 10, { total_cents: 2000 })]
  })
  assert.deepEqual(Object.keys(r.charge.par_bien[BIEN_A]).sort(), ['2026-09', '2026-10'],
    'des mois absents ont ete combles : la courbe partira de zero en janvier')
  assert.deepEqual(Object.keys(r.charge.total).sort(), ['2026-09', '2026-10'])
})

test("LE TEST QUI COMPTE : un agregat en echec REFUSE le bloc au lieu de rendre zero", async () => {
  const r = await appeler({ erreurRpc: { message: 'panne simulee' } })
  assert.strictEqual(r.statut, 200)
  assert.strictEqual(r.charge.total, null, 'un total est rendu alors que la lecture a echoue')
  assert.ok((r.charge.indisponibles || []).includes('revenus'))

  // Et sans la liste des biens, le partage vivant/supprime serait INVENTE.
  const b = await appeler({ erreurBiens: { message: 'properties illisible' } })
  assert.strictEqual(b.charge.par_bien, null,
    'le partage est rendu alors qu on ne sait pas quels biens existent')
})

test("LE TEST QUI COMPTE : l'en-tete prive est pose AVANT le refus de methode", async () => {
  // Dette 90 : un refus de methode qui precede l en-tete laisse une reponse
  // cachable sur un chemin authentifie.
  const r = await appeler({ methode: 'POST' })
  assert.strictEqual(r.statut, 405)
  assert.strictEqual(r.entetes.Allow, 'GET')
  assert.deepEqual(r.vu.rpc, [], 'un POST a declenche une lecture')
  // ⚠ ET C'EST CETTE LIGNE QUI MORD. Les deux precedentes sont vraies que la
  // garde passe avant ou apres : un refus de methode rend 405 et `Allow` dans
  // les deux cas. Seule la presence de l'en-tete PRIVE sur la reponse 405
  // distingue les deux ordres — et c'est la dette 90.
  assert.strictEqual(r.entetes['cache-control'], 'private, no-store',
    'le refus de methode a repondu SANS en-tete prive : la garde passe apres lui')
})

test("LE TEST QUI COMPTE : recu, a-venir et total ne se confondent JAMAIS", async () => {
  // ⚠ TROIS MUTATIONS RENDAIENT `fail 0` AVANT CE TEST (mesure de la review) :
  // recu et a-venir permutes, le total prive de l'a-venir, et `p_aujourdhui`
  // remplace par une date morte. Aucune assertion du fichier ne nommait
  // `recu_cents`, `a_venir_cents`, `bruts` ni `sans_montant`.
  //
  // Ce partage n'est pas decoratif : la decision 3 de Thierry — recu en trait
  // plein, a venir en pointille — repose entierement dessus, et `p_aujourdhui`
  // en est le SEUL arbitre.
  const r = await appeler({
    biens: [BIEN_A],
    lignes: [ligne(BIEN_A, 2026, 5, { recu_cents: 700, a_venir_cents: 1300, total_cents: 2000, bruts: 1, sans_montant: 2 })]
  })
  const m = r.charge.par_bien[BIEN_A]['2026-05']
  assert.strictEqual(m.recu_cents, 700, 'le recu a pris une autre valeur')
  assert.strictEqual(m.a_venir_cents, 1300, 'l a-venir a pris une autre valeur')
  assert.strictEqual(m.total_cents, 2000, 'le total n est pas celui de la base')
  // Les deux compteurs d'honnetete voyagent aussi : sans eux, l'ecran ne peut
  // pas dire qu'un montant est brut ou non calculable.
  assert.strictEqual(m.bruts, 1, 'le compte des montants bruts est perdu')
  assert.strictEqual(m.sans_montant, 2, 'le compte des montants non calculables est perdu')
  // Et le total du compte porte les memes.
  assert.strictEqual(r.charge.total['2026-05'].a_venir_cents, 1300)

  // ⚠ LE JOUR DE REFERENCE EST CELUI DE PARIS, et c'est lui qui tranche entre
  // recu et a venir. `current_date` cote Postgres est en UTC : une comparaison
  // faite en base se decalerait d'un jour chaque soir entre minuit et 2 heures,
  // et ce depot a deja paye ce decalage.
  const parisAujourdhui = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
  assert.strictEqual(r.vu.rpc[0].args.p_aujourdhui, parisAujourdhui,
    'le jour passe a la base n est pas celui de Paris')
})

test("LE TEST QUI COMPTE : la lecture des biens est bornee au COMPTE", async () => {
  // ⚠ `vu.filtres` etait collecte et JAMAIS asserte : retirer
  // `.eq('user_id', compte)` de la lecture de `properties` ne faisait rougir
  // personne (mesure de la review). Un filtre de cloisonnement qu'on peut
  // supprimer sans rouge est un filtre qui disparaitra dans une refonte.
  const t = await appeler({ titulaire: true })
  assert.ok(t.vu.filtres.some(f => f[0] === 'eq' && f[1] === 'user_id' && f[2] === TITULAIRE),
    'la liste des biens n est pas bornee au compte : 500 places pour TOUS les comptes')

  const m = await appeler({ titulaire: false, refs: [BIEN_A] })
  assert.ok(m.vu.filtres.some(f => f[0] === 'eq' && f[1] === 'user_id' && f[2] === TITULAIRE),
    'la lecture du membre n est pas bornee au compte')
  assert.ok(m.vu.filtres.some(f => f[0] === 'in' && f[1] === 'id'),
    'la lecture du membre n est pas bornee a son perimetre')
})

test("LE TEST QUI COMPTE : une liste de biens TRONQUEE refuse le partage", async () => {
  // ⚠ RELEVE PAR LA REVIEW. Au-dela du plafond, les biens manquants seraient
  // traites comme SUPPRIMES : leurs sejours tomberaient dans la reserve
  // « rattaches a aucun de vos logements » alors que les logements sont
  // vivants. Le total resterait juste, les lignes fausses, et rien ne le
  // dirait — la classe exacte que ce depot a deja payee avec un plafond de
  // conversations dont le drapeau ne pouvait jamais se lever.
  const beaucoup = Array.from({ length: 501 }, (_, i) =>
    `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, '0')}`)
  const r = await appeler({ biens: beaucoup, lignes: [ligne(beaucoup[0], 2026, 4)] })
  assert.strictEqual(r.charge.par_bien, null,
    'le partage est affirme alors que la liste des biens est incomplete')
  assert.ok((r.charge.indisponibles || []).includes('revenus'),
    'la troncature ne se dit pas : les lignes seraient fausses en silence')

  // Et juste en dessous du plafond, rien ne change.
  const sous = Array.from({ length: 500 }, (_, i) =>
    `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, '0')}`)
  const ok = await appeler({ biens: sous, lignes: [ligne(sous[0], 2026, 4)] })
  assert.ok(ok.charge.par_bien && ok.charge.par_bien[sous[0]],
    'le plafond mord un cran trop tot')
})

// ─── LA BANDE DES COMPARABLES (28 octobre 2026) ────────────────────────────
// ⚠ CE CHEMIN ETAIT A ZERO COUVERTURE, et la review l'a mesure : cinq
// mutations y survivaient, dont la SUPPRESSION DE LA GARDE 403. Le depot a
// deja paye trois fois la classe « masquage sans garde serveur ».

const releve = (o = {}) => ({
  listing_id: '111', mois: '2026-05-01', nature: 'clos',
  montant_estime_cents: 500000, montant_affiche_cents: null,
  nuits_indisponibles: null, nuits_mesurees: null, motif: null,
  releve_le: '2026-10-06', ...o
})

test("LE TEST QUI COMPTE (SECURITE) : un bien HORS PERIMETRE rend 403", async () => {
  // Un membre delegue dont le perimetre ne porte que BIEN_A demande la bande de
  // BIEN_B. Un masquage d'ecran ne protege rien : c'est le serveur qui refuse.
  const r = await appeler({
    titulaire: false, refs: [BIEN_A], biens: [BIEN_A],
    query: { annee: '2026', bien: BIEN_B },
    releves: [releve({ mois: '2026-05-01' })]
  })
  assert.equal(r.statut, 403,
    `un bien hors perimetre rend ${r.statut} au lieu de 403 : les comparables d un logement interdit sont lisibles`)
  // ⚠ ET LE REFUS TOMBE AVANT TOUTE LECTURE : rien n a ete lu de la table.
  assert.ok(!r.vu.selects.includes('comparables_releves'),
    'la table des comparables a ete lue AVANT le refus')
})

test("LE TEST QUI COMPTE : un uuid malforme rend 400, pas une lecture", async () => {
  const r = await appeler({ query: { annee: '2026', bien: 'pas-un-uuid' } })
  assert.equal(r.statut, 400, `un uuid malforme rend ${r.statut}`)
  assert.ok(!r.vu.selects.includes('comparables_releves'), 'la table a ete lue sur un uuid malforme')
})

test("LE TEST QUI COMPTE : sans `?bien=`, la table n est pas lue du tout", async () => {
  // Le budget de l ecran : la bande ne coute rien a qui ne la demande pas.
  const r = await appeler({ query: { annee: '2026' }, releves: [releve()] })
  assert.equal(r.statut, 200)
  assert.ok(!r.vu.selects.includes('comparables_releves'),
    'la table des comparables est lue sans logement designe')
  assert.equal(r.charge.comparables, null, 'une bande est rendue sans logement designe')
})

test("LE TEST QUI COMPTE : un `futur` sur un mois DEJA CLOS est ecarte", async () => {
  // Il vient de drapeaux `available` releves AVANT la fin du mois. L ecran le
  // libellerait « occupe chez les comparables » — sur un mois termine.
  const r = await appeler({
    query: { annee: '2026', bien: BIEN_A },
    releves: [
      releve({ mois: '2026-01-01', nature: 'futur', montant_estime_cents: null, montant_affiche_cents: 300000, nuits_mesurees: 31 }),
      releve({ mois: '2026-05-01', nature: 'clos' })
    ]
  })
  assert.equal(r.statut, 200)
  const mois = r.charge.comparables.mois
  assert.ok(!mois['2026-01'], 'un mois clos est trace dans la bande du futur, a partir de donnees perimees')
  assert.ok(mois['2026-05'], 'le mois clos legitime a disparu : le test ne demontre rien')
})

test("LE TEST QUI COMPTE : un mois dont la COUVERTURE est partielle est ecarte", async () => {
  // Le calendrier AirROI commence a sa date de capture : son premier mois est
  // tronque. Trace a cote d une courbe qui porte le mois entier, il s ecrase au
  // ras de l axe et l hote lit « mes comparables font dix fois moins que moi ».
  const r = await appeler({
    query: { annee: '2026', bien: BIEN_A },
    releves: [
      releve({ mois: '2026-12-01', nature: 'futur', montant_estime_cents: null, montant_affiche_cents: 9380, nuits_mesurees: 4 }),
      releve({ mois: '2026-11-01', nature: 'futur', montant_estime_cents: null, montant_affiche_cents: 300000, nuits_mesurees: 30 })
    ]
  })
  const mois = r.charge.comparables.mois
  assert.ok(!mois['2026-12'], 'un mois couvert sur 4 nuits sur 31 est trace comme un mois entier')
  assert.ok(mois['2026-11'], 'le mois complet a disparu : le test ne demontre rien')
})

test("LE TEST QUI COMPTE : deux PHOTOS DE DATES DIFFERENTES ne se melangent pas", async () => {
  // `releve_le` vient du cache AirROI, propre a chaque annonce : le min
  // pourrait venir d une photo de juillet et le max d une d octobre, sous une
  // seule date affichee.
  const r = await appeler({
    query: { annee: '2026', bien: BIEN_A },
    releves: [
      releve({ listing_id: '111', mois: '2026-05-01', montant_estime_cents: 100000, releve_le: '2026-07-01' }),
      releve({ listing_id: '222', mois: '2026-05-01', montant_estime_cents: 900000, releve_le: '2026-10-06' }),
      releve({ listing_id: '111', mois: '2026-06-01', montant_estime_cents: 200000, releve_le: '2026-10-06' }),
      releve({ listing_id: '222', mois: '2026-06-01', montant_estime_cents: 400000, releve_le: '2026-10-06' })
    ]
  })
  const mois = r.charge.comparables.mois
  assert.ok(!mois['2026-05'], 'un mois dont les photos ont deux dates est trace quand meme')
  assert.ok(mois['2026-06'], 'le mois a photo unique a disparu : le test ne demontre rien')
  assert.equal(mois['2026-06'].min_cents, 200000)
  assert.equal(mois['2026-06'].max_cents, 400000)
  assert.equal(mois['2026-06'].comparables, 2)
})

test("LE TEST QUI COMPTE : les deux grandeurs ne se min/maxent JAMAIS ensemble", async () => {
  // Une estimation de revenu AirROI et une somme de prix affiches ne sont pas
  // la meme grandeur. Les fondre ferait un min et un max qui ne parlent pas de
  // la meme chose — ce que la migration dit explicitement d eviter.
  const r = await appeler({
    query: { annee: '2026', bien: BIEN_A },
    releves: [
      releve({ listing_id: '111', mois: '2026-11-01', nature: 'clos', montant_estime_cents: 800000 }),
      releve({ listing_id: '222', mois: '2026-11-01', nature: 'futur', montant_estime_cents: null, montant_affiche_cents: 1000, nuits_mesurees: 30 })
    ]
  })
  const m = r.charge.comparables.mois['2026-11']
  assert.ok(m, 'le mois a disparu')
  assert.equal(m.nature, 'clos', 'le realise ne prime pas sur l occupe')
  assert.equal(m.min_cents, 800000, 'le min vient d une autre grandeur que le max')
  assert.equal(m.max_cents, 800000)
  assert.equal(m.comparables, 1, 'deux grandeurs ont ete comptees comme deux comparables du meme mois')
})

test("LE TEST QUI COMPTE : une lecture ratee rend `null`, pas une bande vide", async () => {
  // `null` veut dire « on n a pas pu lire ». Une bande vide dirait « ce
  // logement n a pas de comparables » — un fait, et il serait faux.
  const r = await appeler({
    query: { annee: '2026', bien: BIEN_A },
    erreurReleves: { message: 'panne' }
  })
  assert.equal(r.statut, 200)
  assert.equal(r.charge.comparables, null, 'une lecture ratee rend une bande vide au lieu de `null`')
  assert.ok((r.charge.indisponibles || []).includes('comparables'),
    'une lecture ratee des comparables n est pas declaree dans `indisponibles`')
})

test("LE TEST QUI COMPTE : d un MEME comparable, seule la photo la plus recente compte", async () => {
  // La table garde toutes les photos — c est son role. Mais la bande
  // d aujourd hui se lit sur la derniere : garder les deux ferait un min et un
  // max du meme logement a deux instants, et le mois serait meme ecarte pour
  // « photos de dates differentes » alors qu il n y a qu un comparable.
  // ⚠ LES LIGNES ARRIVENT DEJA TRIEES decroissant, comme la base les rend
  // (`order('releve_le', { ascending: false })`). Le double n applique pas le
  // tri : c est a la fixture de le refleter, sinon le test mesurerait l ordre
  // du double et non la regle.
  const r = await appeler({
    query: { annee: '2026', bien: BIEN_A },
    releves: [
      releve({ listing_id: '111', mois: '2026-06-01', montant_estime_cents: 500000, releve_le: '2026-10-06' }),
      releve({ listing_id: '111', mois: '2026-06-01', montant_estime_cents: 100000, releve_le: '2026-07-01' })
    ]
  })
  const m = r.charge.comparables.mois['2026-06']
  assert.ok(m, 'le mois a disparu : les deux photos du meme comparable ont ete prises pour deux dates')
  assert.equal(m.comparables, 1, `${m.comparables} comparables comptes pour une seule annonce`)
  assert.equal(m.min_cents, 500000, 'une photo perimee est entree dans le min')
  assert.equal(m.max_cents, 500000)
  assert.equal(m.releve_le, '2026-10-06', 'la date affichee n est pas celle de la photo retenue')
})

test("LE TEST QUI COMPTE : un comparable SANS ACTIVITE ne tire pas le minimum a zero", async () => {
  // ⚠ CONSTAT 3 DE LA RECETTE DU 28 OCTOBRE : « juin, le bas de la bande
  // descend a 0 € ». Un logement FERME un mois rend 0 — ce n est pas « il a
  // gagne zero », c est « il n etait pas sur le marche ». Le garder faisait
  // lire a l hote l effondrement d un comparable.
  const r = await appeler({
    query: { annee: '2026', bien: BIEN_A },
    releves: [
      releve({ listing_id: '111', mois: '2026-06-01', montant_estime_cents: 400000 }),
      releve({ listing_id: '222', mois: '2026-06-01', montant_estime_cents: 900000 }),
      releve({ listing_id: '333', mois: '2026-06-01', montant_estime_cents: 0 })
    ]
  })
  const m = r.charge.comparables.mois['2026-06']
  assert.ok(m, 'le mois a disparu')
  assert.equal(m.min_cents, 400000, `le minimum vaut ${m.min_cents} : un comparable ferme y est entre`)
  assert.equal(m.max_cents, 900000)
  assert.equal(m.comparables, 2, 'le comparable ferme est compte comme actif')
  // ⚠ ET IL SE DECLARE : un comparable ecarte en silence est un comparable
  // qu on a perdu sans le savoir.
  assert.equal(m.sans_activite, 1, 'le comparable ecarte n est pas compte dans la reserve')
})

test("LE TEST QUI COMPTE : un mois dont TOUS les comparables sont fermes n a pas de bande", async () => {
  // Et ce n est PAS une bande a zero : il n y a rien a comparer.
  const r = await appeler({
    query: { annee: '2026', bien: BIEN_A },
    releves: [
      releve({ listing_id: '111', mois: '2026-07-01', montant_estime_cents: 0 }),
      releve({ listing_id: '222', mois: '2026-07-01', montant_estime_cents: 0 }),
      releve({ listing_id: '111', mois: '2026-08-01', montant_estime_cents: 500000 })
    ]
  })
  const mois = r.charge.comparables.mois
  assert.ok(!mois['2026-07'], 'un mois sans aucun comparable actif est trace comme une bande a zero')
  assert.ok(mois['2026-08'], 'le mois actif a disparu : le test ne demontre rien')
})
