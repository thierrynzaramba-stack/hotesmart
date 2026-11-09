// tests/ecran-avis-recents.test.js — `/api/ecran/avis-recents`
//
// LA SUITE du bloc « Derniers avis » de l'accueil, chargee au DEFILEMENT.
//
// ⚠ CET ENDPOINT LIT AVEC LA CLE DE SERVICE, donc AUCUNE des 28 policies RLS
// ne s'applique. Le seul cloisonnement entre comptes est celui qu'on ecrit en
// JavaScript — `userId` et `refs` — et c'est ce fichier qui le garde. Les dix
// fuites du chantier profils et droits sont toutes nees de cette famille : une
// lecture qui oublie son perimetre, dans un fichier ou les autres l'appliquent.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')

const TITULAIRE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const TOUS_DOMAINES = ['reservations', 'menages', 'messages', 'avis', 'reglages']
// ⚠ `ota_reviews.id` EST UN `uuid` (migration du 2 septembre 2026). Un curseur
// a identifiant libre part en base et rend une erreur Postgres 22P02.
const AVIS_3 = '33333333-3333-4333-8333-333333333333'

// Une ligne d'`ota_reviews` telle que la lecture la rend.
const avis = (n, jour, o = {}) => ({
  id: n, property_id_ref: 'P1', ota: 'airbnb',
  content: null, content_public: `Commentaire ${n}`,
  overall_score: 9, received_at: `2026-10-${String(jour).padStart(2, '0')}T10:00:00+00:00`,
  guest_name: 'Chloé Durand', ...o
})

async function appeler ({
  query = {}, methode = 'GET', titulaire = true, refs = null,
  domaines = TOUS_DOMAINES, lignes = [], erreur = null
} = {}) {
  const vu = { selects: [], filtres: [], limites: [] }

  const client = {
    from (table) {
      vu.selects.push(table)
      const q = {
        select () { return q },
        eq (c, v) { vu.filtres.push(['eq', c, v]); return q },
        in (c, v) { vu.filtres.push(['in', c, v]); return q },
        gte (c, v) { vu.filtres.push(['gte', c, v]); return q },
        or (f) { vu.filtres.push(['or', f]); return q },
        order (c, o2) { vu.filtres.push(['order', c, (o2 || {}).ascending]); return q },
        limit (n) { vu.limites.push(n); return Promise.resolve({ data: erreur ? null : lignes, error: erreur }) },
        then (r) { return Promise.resolve({ data: erreur ? null : lignes, error: erreur }).then(r) }
      }
      return q
    }
  }

  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client

  // ⚠ ON CHARGE AVANT DE CAPTURER : lire le cache avant le `require` rend un
  // double PARTIEL qui perd `UUID_RE`, que l'endpoint importe du MEME module.
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
  // n'assertait que le 405, que l'ordre inverse satisfait aussi (dette 90).
  require.cache[absGarde].exports = Object.assign({}, vraieGarde, {
    contexteDEcran: async (rq, rs) => {
      if (rs && typeof rs.setHeader === 'function') rs.setHeader('cache-control', 'private, no-store')
      return { ok: true, userId: contexte.userId, accountUserId: TITULAIRE, contexte }
    }
  })

  const absEndpoint = require.resolve('../api/ecran/avis-recents')
  delete require.cache[absEndpoint]
  const endpoint = require(absEndpoint)

  const rep = { statut: null, charge: null, entetes: {} }
  const res = {
    setHeader (k, v) { rep.entetes[k] = v },
    status (s) { rep.statut = s; return res },
    json (c) { rep.charge = c; return res }
  }
  // La restauration passe par un `finally` : sans lui, une assertion qui leve
  // laisse les doubles en place pour les tests SUIVANTS du meme fichier.
  try {
    await endpoint({ method: methode, query }, res)
  } finally {
    require.cache[absSdk].exports.createClient = vraiCreate
    require.cache[absGarde].exports = vraieGarde
    delete require.cache[absEndpoint]
  }
  return { ...rep, vu }
}

test("LE TEST QUI COMPTE : sans le droit `avis`, 403 AVANT toute lecture", async () => {
  // ⚠ L'ACCUEIL RETIRE LE BLOC DU DOM SANS CE DROIT — c'est un confort
  // d'interface, qui tombe sur une feuille absente ou devant une requete faite
  // a la main. Le test qui tranche : on retire le masquage, on appelle, le
  // serveur refuse-t-il en 403 ? Et il doit refuser AVANT de lire : un 403
  // pose apres la lecture a deja sorti les donnees de la base.
  const r = await appeler({ titulaire: false, domaines: ['reservations'], lignes: [avis(1, 28)] })
  assert.strictEqual(r.statut, 403, `statut ${r.statut} au lieu de 403`)
  assert.deepStrictEqual(r.vu.selects, [], `une lecture a eu lieu : ${r.vu.selects.join(', ')}`)
})

test("LE TEST QUI COMPTE : un perimetre VIDE rend une liste vide, jamais tout le compte", async () => {
  // ⚠ C'EST LA FORME DE FUITE QUE CE DEPOT A FERMEE DIX FOIS. `[]` est
  // « falsy-adjacent » : un `if (refs)` laisserait le perimetre vide SANS
  // filtre, donc tous les avis du compte visibles par un membre a qui aucun
  // bien n'est confie.
  const r = await appeler({ titulaire: false, refs: [], lignes: [avis(1, 28)] })
  assert.strictEqual(r.statut, 200)
  assert.deepStrictEqual(r.charge, { avis: [], fin: true })
  assert.deepStrictEqual(r.vu.selects, [], 'une lecture est partie sur un perimetre vide')
})

test("LE TEST QUI COMPTE : le perimetre d un membre BORNE la lecture", async () => {
  const r = await appeler({ titulaire: false, refs: ['P1', 'P2'], lignes: [avis(1, 28)] })
  assert.strictEqual(r.statut, 200)
  const borne = r.vu.filtres.find(f => f[0] === 'in' && f[1] === 'property_id_ref')
  assert.ok(borne, `aucune borne de perimetre : ${JSON.stringify(r.vu.filtres)}`)
  assert.deepStrictEqual(borne[2], ['P1', 'P2'])
  // Et le compte, toujours : la borne par bien ne remplace pas la borne par compte.
  assert.ok(r.vu.filtres.some(f => f[0] === 'eq' && f[2] === TITULAIRE),
    `la lecture n est pas bornee au compte : ${JSON.stringify(r.vu.filtres)}`)
})

test("LE TEST QUI COMPTE : un curseur A MOITIE rend 400, il ne pagine pas sur une seule cle", async () => {
  // ⚠ LE TRI EST `(received_at desc, id desc)` : deux avis recus au meme
  // instant ne se departagent que par `id`. Paginer sur la seule date les
  // sauterait tous les deux, ou les rendrait deux fois. On refuse plutot que
  // de rendre une page dont on ne sait pas si elle est juste.
  for (const q of [{ depuis: '2026-10-26T10:00:00Z' }, { apres_id: AVIS_3 }]) {
    const r = await appeler({ query: q, lignes: [avis(1, 28)] })
    assert.strictEqual(r.statut, 400, `${JSON.stringify(q)} rend ${r.statut} au lieu de 400`)
    assert.deepStrictEqual(r.vu.selects, [], 'une lecture est partie sur un curseur incomplet')
  }
})

test("LE TEST QUI COMPTE : une date de curseur illisible rend 400", async () => {
  // Elle entre dans un filtre PostgREST : une chaine libre y ferait au mieux
  // une erreur opaque, au pire un filtre que personne n a voulu.
  const r = await appeler({ query: { depuis: 'avant-hier', apres_id: AVIS_3 }, lignes: [] })
  assert.strictEqual(r.statut, 400, `statut ${r.statut} au lieu de 400`)
  assert.deepStrictEqual(r.vu.selects, [], 'une lecture est partie sur une date illisible')
})

test("LE TEST QUI COMPTE : une date que `Date.parse` ACCEPTE mais qui n est pas une date rend 400", async () => {
  // ⚠ CONSTAT DE LA REVIEW DU 29 OCTOBRE 2026, ET LE PLUS INSTRUCTIF DU LOT.
  // `Date.parse('Oct 26 2026 (",or(id.gte.0)")')` rend une date FINIE : le
  // parseur de secours de V8 traite les parentheses comme un commentaire et
  // tolere les caracteres epars. Une garde `Number.isFinite(Date.parse(...))`
  // laissait donc passer une chaine qui porte des termes de filtre, et c'est la
  // chaine BRUTE qui entrait dans le filtre PostgREST. Ce qui sauvait, c'etait
  // la malformation du filtre obtenu — pas la garde.
  const hostiles = [
    'Oct 26 2026 (",or(id.gte.0)")',
    '2026-10-26T10:00:00Z",or(id.gte.0)',
    'Oct 26 2026',
    '2026/10/26'
  ]
  for (const d of hostiles) {
    const r = await appeler({ query: { depuis: d, apres_id: AVIS_3 }, lignes: [] })
    assert.strictEqual(r.statut, 400, `« ${d} » rend ${r.statut} au lieu de 400`)
    assert.deepStrictEqual(r.vu.selects, [], `une lecture est partie sur « ${d} »`)
  }
})

test("LE TEST QUI COMPTE : un identifiant de curseur qui n est pas un uuid rend 400", async () => {
  // ⚠ C'EST LE PIEGE QUE `api/ecran/aujourdhui.js` DOCUMENTE SUR VINGT-CINQ
  // LIGNES (« LE PIEGE UUID, POUR LA TROISIEME FOIS »). Sans cette garde, une
  // chaine libre part en base, Postgres rend 22P02, l'endpoint traduit en
  // « indisponible », et la suite des avis s'arrete — sur une entree du client.
  // `UUID_RE` etait importe dans ce fichier sans etre appele nulle part.
  for (const id of ['3', 'pas-un-uuid', "33333333-3333-4333-8333-333333333333'", '']) {
    const r = await appeler({ query: { depuis: '2026-10-26T10:00:00Z', apres_id: id }, lignes: [] })
    assert.strictEqual(r.statut, 400, `« ${id} » rend ${r.statut} au lieu de 400`)
    assert.deepStrictEqual(r.vu.selects, [], `une lecture est partie sur « ${id} »`)
  }
})

test("LE TEST QUI COMPTE : la date du filtre est NORMALISEE, jamais la chaine recue", async () => {
  // Deux ecritures de la MEME date doivent poser le MEME filtre : c'est ce qui
  // garantit qu'aucun caractere du client ne traverse.
  for (const d of ['2026-10-26T10:00:00+00:00', '2026-10-26T12:00:00+02:00']) {
    const r = await appeler({ query: { depuis: d, apres_id: AVIS_3 }, lignes: [] })
    assert.strictEqual(r.statut, 200, `« ${d} » rend ${r.statut}`)
    const curseur = r.vu.filtres.filter(f => f[0] === 'or').map(f => f[1])
      .find(x => /received_at\.lt\./.test(x))
    assert.match(curseur, /received_at\.lt\."2026-10-26T10:00:00\.000Z"/,
      `« ${d} » pose « ${curseur} » : la date n est pas normalisee`)
  }
})

test("LE TEST QUI COMPTE : la taille de page n est PAS pilotable par le client", async () => {
  // Un `?par=500` ferait de cet endpoint une extraction. La constante est en
  // dur, et `DERNIERS_MAX` la plafonne une seconde fois dans la lib.
  const r = await appeler({ query: { par: '500', limite: '500' }, lignes: [] })
  assert.deepStrictEqual(r.vu.limites, [4],
    `limite demandee : ${JSON.stringify(r.vu.limites)} — le client pilote la taille de page`)
})

test("LE TEST QUI COMPTE : le curseur pose les DEUX cles dans le filtre", async () => {
  const r = await appeler({
    query: { depuis: '2026-10-26T10:00:00+00:00', apres_id: AVIS_3 },
    lignes: [avis(4, 25)]
  })
  assert.strictEqual(r.statut, 200)
  const ors = r.vu.filtres.filter(f => f[0] === 'or').map(f => f[1])
  const curseur = ors.find(x => /received_at\.lt\./.test(x))
  assert.ok(curseur, `aucun filtre de curseur : ${JSON.stringify(ors)}`)
  assert.match(curseur, /received_at\.lt\."2026-10-26T10:00:00\.000Z"/,
    `la borne de date manque : ${curseur}`)
  assert.match(curseur, new RegExp(`and\\(received_at\\.eq\\."2026-10-26T10:00:00\\.000Z",id\\.lt\\."${AVIS_3}"\\)`),
    `le departiteur par identifiant manque : ${curseur}`)
})

test("LE TEST QUI COMPTE : il demande UNE LIGNE DE PLUS que la page, et c est elle qui dit « encore »", async () => {
  // ⚠ SANS CETTE LIGNE DE PLUS, « page pleine » et « derniere page exactement
  // pleine » sont indistinguables : l ecran afficherait un chargement de plus,
  // vide, chaque fois que le total est un multiple de trois. Mesure par
  // mutation : ramener la limite a 3 laissait la suite VERTE avant ce test.
  const quatre = [avis(1, 28), avis(2, 27), avis(3, 26), avis(4, 25)]
  const r = await appeler({ lignes: quatre })
  assert.deepStrictEqual(r.vu.limites, [4], `limite demandee : ${JSON.stringify(r.vu.limites)}`)
  assert.strictEqual(r.charge.avis.length, 3, 'la page rendue ne fait pas trois cartes')
  assert.strictEqual(r.charge.fin, false, 'la quatrieme ligne ne dit pas « il y en a encore »')

  // Exactement trois : c est la fin, et aucune page de plus ne sera demandee.
  const r3 = await appeler({ lignes: quatre.slice(0, 3) })
  assert.strictEqual(r3.charge.avis.length, 3)
  assert.strictEqual(r3.charge.fin, true, 'trois lignes exactement ne sont pas annoncees comme la fin')
})

test("LE TEST QUI COMPTE : « encore » se compte sur les lignes LUES, pas sur les cartes rendues", async () => {
  // ⚠ CONSTAT DE LA REVIEW DU 29 OCTOBRE 2026. La `limit` est posee en SQL ; le
  // filtre de texte s'applique APRES, en JavaScript, parce qu'il TRIM — un
  // `content_public` reduit a des espaces passe `content_public.neq.''` et
  // tombe au `.trim()`. Quatre lignes lues dont une vide rendaient donc trois
  // cartes, et « trois cartes » etait lu comme « c'est la fin » : la suite
  // s'arretait POUR DE BON, en plein milieu de la fenetre de 30 jours.
  const r = await appeler({
    lignes: [avis(1, 28), avis(2, 27), avis(3, 26), avis(4, 25, { content_public: '   ', content: null })]
  })
  assert.strictEqual(r.charge.avis.length, 3, 'la ligne sans texte est rendue comme une carte')
  assert.strictEqual(r.charge.fin, false,
    'quatre lignes lues dont une vide sont annoncees comme la fin : la suite s arrete en plein milieu')
})

test("LE TEST QUI COMPTE : il reste dans les 30 JOURS, comme le bloc l annonce", async () => {
  // Decision de Thierry du 28 octobre 2026, option 3. Mesure en production le
  // meme jour : 16 avis avec texte sur 30 jours contre 645 au total. Sans cette
  // borne, l accueil deviendrait un second /avis — et le compte de son propre
  // en-tete (« N avis notes sur 30 jours ») deviendrait faux.
  const r = await appeler({ lignes: [avis(1, 28)] })
  const borne = r.vu.filtres.find(f => f[0] === 'gte' && f[1] === 'received_at')
  assert.ok(borne, `aucune borne de 30 jours : ${JSON.stringify(r.vu.filtres)}`)
  const jours = (Date.now() - Date.parse(borne[2])) / 86400000
  assert.ok(jours > 29 && jours < 31, `la borne est a ${jours.toFixed(1)} jours, pas a 30`)
})

test("LE TEST QUI COMPTE : une lecture qui ECHOUE rend `null`, jamais une liste vide", async () => {
  // ⚠ `null` N'EST PAS `[]`. Rendre une liste vide ferait conclure l ecran a la
  // fin de l historique, donc afficher « c est tout » a un hote dont la lecture
  // vient d echouer.
  const r = await appeler({ erreur: { message: 'boom' }, lignes: [] })
  assert.strictEqual(r.statut, 200)
  assert.strictEqual(r.charge.avis, null, `la charge rend ${JSON.stringify(r.charge.avis)}`)
  assert.strictEqual(r.charge.indisponible, true, 'l echec ne se declare pas')
})

test("LE TEST QUI COMPTE : le nom du voyageur suit `reservations`, pas `avis`", async () => {
  // Le CONTENU de l avis suit `avis`, ce qu il dit du SEJOUR suit
  // `reservations` — meme partage que l appel d ecran et que `api/avis.js`.
  const avecNom = await appeler({ titulaire: false, domaines: ['avis', 'reservations'], lignes: [avis(1, 28)] })
  assert.ok(avecNom.charge.avis[0].voyageur, 'le nom manque a qui a le droit')
  const sansNom = await appeler({ titulaire: false, domaines: ['avis'], lignes: [avis(1, 28)] })
  assert.strictEqual(sansNom.charge.avis[0].voyageur, null,
    `le nom fuite sans le droit « reservations » : ${sansNom.charge.avis[0].voyageur}`)
})

test("LE TEST QUI COMPTE : l en-tete prive precede le refus de methode", async () => {
  const r = await appeler({ methode: 'POST' })
  assert.strictEqual(r.statut, 405)
  assert.strictEqual(r.entetes['cache-control'], 'private, no-store',
    'l en-tete prive manque sur un refus de methode (dette 90)')
  assert.strictEqual(r.entetes.Allow, 'GET')
})
