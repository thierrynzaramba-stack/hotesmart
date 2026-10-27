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
  erreurRpc = null, erreurBiens = null
} = {}) {
  const vu = { rpc: [], selects: [], filtres: [] }

  const client = {
    rpc (nom, args) {
      vu.rpc.push({ nom, args })
      return Promise.resolve({ data: erreurRpc ? null : lignes, error: erreurRpc })
    },
    from (table) {
      vu.selects.push(table)
      const q = {
        select () { return q },
        eq (c, v) { vu.filtres.push(['eq', c, v]); return q },
        in (c, v) { vu.filtres.push(['in', c, v]); return q },
        limit () { return Promise.resolve({ data: erreurBiens ? null : biens.map(id => ({ id })), error: erreurBiens }) },
        then (r) { return Promise.resolve({ data: erreurBiens ? null : biens.map(id => ({ id })), error: erreurBiens }).then(r) }
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
  require.cache[absGarde].exports = Object.assign({}, vraieGarde, {
    contexteDEcran: async () => ({ ok: true, userId: contexte.userId, accountUserId: TITULAIRE, contexte })
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
  await endpoint({ method: methode, query }, res)

  require.cache[absSdk].exports.createClient = vraiCreate
  require.cache[absGarde].exports = vraieGarde
  delete require.cache[absEndpoint]
  return { ...rep, vu }
}

const ligne = (uuid, annee, mois, o = {}) => ({
  property_uuid: uuid, annee, mois,
  sejours: 1, recu_cents: 0, a_venir_cents: 0, total_cents: 0,
  bruts: 0, sans_montant: 0, ...o
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
  assert.strictEqual(m.vu.rpc[0].args.p_user_id, TITULAIRE,
    'le compte interroge doit rester celui de la garde, jamais celui de la requete')
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
})
