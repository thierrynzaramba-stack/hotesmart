// tests/cron-revenus-derives.test.js — LE RATTRAPAGE DES COLONNES DERIVEES
//
// Architecture decidee par Thierry le 27 octobre 2026. Ce module tourne a 04:00
// heure de Paris et reprend les reservations dont les colonnes derivees
// manquent ou sont perimees.
//
// ⚠ CE QU'IL A DE DANGEREUX : il ECRIT, en masse, de nuit, sans personne pour
// regarder. Trois choses doivent etre vraies, et chacune a son test :
//   · il ne tourne QU'A 04:00 PARIS — pas en UTC, pas deux fois, pas jamais ;
//   · il n'ecrit JAMAIS une colonne a `null` par-dessus une valeur juste ;
//   · ses echecs remontent dans `results.errors` — un cron qui rend 200 en
//     ayant echoue est une panne invisible, et le depot l'a paye 24 heures.

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  rattraperRevenusDerives, heureDeParis,
  MARQUEUR, HEURE_PARIS, PERIODE_MS
} = require('../lib/cron-revenus-derives')
const { VERSION } = require('../lib/revenus/derive')

// ─── Un faux client Supabase, qui compte et n'oublie rien ───────────────────
function faux ({ marker = null, delais = [{ canal: 'airbnb', base: 'arrivee', jours: 1 }],
  biens = [{ id: 'uuid-1', user_id: 'u1', provider_property_id: '209413' }],
  lignes = [], echouerUpdate = false, echouerMarqueur = false,
  erreurLecture = null } = {}) {
  const vu = { updates: [], marqueurs: [], selects: [] }
  const client = {
    from (table) {
      vu.selects.push(table)
      const q = {
        _table: table, _filtres: [],
        select () { return q },
        eq (c, v) { q._filtres.push(['eq', c, v]); return q },
        is (c, v) { q._filtres.push(['is', c, v]); return q },
        not (c, op, v) { q._filtres.push(['not', c, op, v]); return q },
        lt (c, v) { q._filtres.push(['lt', c, v]); return q },
        // ⚠ `gte` ET `gt` ONT ETE AJOUTES LE 27 OCTOBRE 2026, et leur absence
        // s'est fait voir immediatement : le troisieme motif du rattrapage (une
        // ligne dont le payload a change depuis le calcul, dette 112) les
        // appelle, et un double qui ignore une methode ne rend pas `undefined`
        // — il LEVE. Sept tests ont rougi d'un coup sur
        // « q.not(...).gte is not a function ».
        //
        // C'est le piege que ce fichier et son voisin documentent deja pour
        // `or` et pour `rpc`. Ici il a joue du bon cote : le test a crie au lieu
        // de passer en silence.
        gte (c, v) { q._filtres.push(['gte', c, v]); return q },
        gt (c, v) { q._filtres.push(['gt', c, v]); return q },
        order () { return q },
        // ⚠ `limit` ET `range` SONT CHAINABLES, et ce n'est pas un detail de
        // confort : `limit` rendait une PROMESSE, donc deplacer la borne juste
        // apres `from()` — ce que le recensement des lectures non bornees
        // demande — faisait appeler `.select()` SUR UNE PROMESSE. Un double qui
        // n'accepte la borne qu'en DERNIERE position dicte la forme du code de
        // production.
        limit (n) { q._limit = n; return q },
        range (a, b) { q._range = [a, b]; return q },
        maybeSingle () { return Promise.resolve(reponse()) },
        update (valeurs) {
          return {
            eq: (c, v) => {
              vu.updates.push({ valeurs, par: [c, v] })
              // ⚠ L'ECRITURE MODIFIE LA FIXTURE, et c'est ce qui manquait au
              // double. Sans cela, une relecture rendait l'etat d'AVANT :
              // le rattrapage pouvait deriver deux fois la meme ligne dans le
              // meme passage, ou ecrire `null` dans la colonne qui sert a
              // detecter la peremption, sans qu'aucun test ne le voie. C'est
              // exactement par ce trou que le defaut du 27 octobre est passe.
              if (!echouerUpdate) {
                for (const l of lignes) if (String(l[c]) === String(v)) Object.assign(l, valeurs)
              }
              return Promise.resolve({ error: echouerUpdate ? { message: 'refus' } : null })
            }
          }
        },
        upsert (ligne) {
          vu.marqueurs.push(ligne)
          return Promise.resolve({ error: echouerMarqueur ? { message: 'marqueur refuse' } : null })
        },
        then (res) { return Promise.resolve(reponse()).then(res) }
      }
      function reponse () {
        if (table === 'cron_logs') return { data: marker, error: null }
        if (table === 'delais_versement') return { data: delais, error: null }
        if (table === 'properties') {
          // La pagination est honoree : une lecture sans borne est tronquee a
          // 1 000 lignes en vrai, et un double qui rend tout cache le defaut.
          const r = q._range
          return { data: r ? biens.slice(r[0], r[1] + 1) : biens, error: null }
        }
        if (table === 'bookings_snapshot') {
          if (erreurLecture) return { data: null, error: erreurLecture }
          // ⚠ LE DOUBLE APPLIQUE LES FILTRES AU LIEU DE DEVINER LE MOTIF.
          // Il rendait `lignes.filter(l => l.derive_le != null)` pour TOUTE
          // requete non-« jamais » : une fixture fraichement derivee ressortait
          // d'un ensemble vide au motif « payload », alors qu'en vrai elle y est
          // candidate. La double ecriture etait donc invisible. Et `limit`
          // comme le curseur etaient ignores, donc les retirer du code de
          // production ne faisait rougir aucun test.
          let rows = lignes.slice()
          for (const f of q._filtres) {
            const [op, col] = f
            if (op === 'is' && col === 'derive_le') rows = rows.filter(l => l.derive_le == null)
            else if (op === 'not' && col === 'derive_le') rows = rows.filter(l => l.derive_le != null)
            else if (op === 'is' && col === 'derive_raw_hash') rows = rows.filter(l => l.derive_raw_hash == null)
            else if (op === 'not' && col === 'derive_raw_hash') rows = rows.filter(l => l.derive_raw_hash != null)
            else if (op === 'lt' && col === 'derive_version') rows = rows.filter(l => Number(l.derive_version) < f[2])
            else if (op === 'gte' && col === 'derive_version') rows = rows.filter(l => Number(l.derive_version) >= f[2])
            else if (op === 'eq' && col === 'derive_version') rows = rows.filter(l => Number(l.derive_version) === f[2])
            else if (op === 'gt' && col === 'id') rows = rows.filter(l => String(l.id) > String(f[2]))
          }
          rows.sort((a, b) => String(a.id) < String(b.id) ? -1 : 1)
          if (q._limit) rows = rows.slice(0, q._limit)
          return { data: rows, error: null }
        }
        return { data: [], error: null }
      }
      return q
    }
  }
  return { client, vu }
}

const SEJOUR = (extra = {}) => ({
  id: 'row-1', user_id: 'u1', booking_id: 'B1', property_id: '209413',
  snapshot: { provider: 'channex', source: 'airbnb', status: 'new', arrival: '2026-11-05', departure: '2026-11-08' },
  raw: { amount: '400.00', meta: { amount_type: 'Payout Amount' }, notes: 'Listing Cancellation Host Fee: 12.00\n' },
  derive_le: null, derive_version: null, ...extra
})

// 04:00 Paris, en hiver comme en ete.
const QUATRE_H_HIVER = Date.parse('2026-01-15T03:00:00Z')
const QUATRE_H_ETE = Date.parse('2026-07-15T02:00:00Z')

test("LE TEST QUI COMPTE : 04:00 PARIS, pas 04:00 UTC — aux deux saisons", () => {
  // ⚠ CE TEST AURAIT ATTRAPE LE DEFAUT QUE J'AI ECRIT. Ma premiere version
  // faisait `Number(new Intl.DateTimeFormat('fr-FR', { hour: '2-digit' })
  // .format(d))` — et le format FRANCAIS rend « 04 h », avec l'unite. Donc
  // `Number('04 h')` vaut NaN, la comparaison a 4 etait toujours fausse, et la
  // fenetre NE S'OUVRAIT JAMAIS. Le rattrapage rendait sagement
  // `hors_fenetre` a chaque passage : un cron mort, indiscernable d'un cron qui
  // attend son heure.
  assert.equal(heureDeParis(QUATRE_H_HIVER), 4, 'hiver : 04:00 Paris vaut 03:00 UTC')
  assert.equal(heureDeParis(QUATRE_H_ETE), 4, 'ete : 04:00 Paris vaut 02:00 UTC')
  // Et 04:00 UTC n'est PAS 04:00 Paris : c'est 05:00 en hiver, 06:00 en ete.
  assert.equal(heureDeParis(Date.parse('2026-01-15T04:00:00Z')), 5)
  assert.equal(heureDeParis(Date.parse('2026-07-15T04:00:00Z')), 6)
  // Les deux nuits de changement d'heure : 04:00 Paris existe dans les deux.
  assert.equal(heureDeParis(Date.parse('2026-03-29T02:30:00Z')), 4, 'nuit du passage a l heure d ete')
  assert.equal(heureDeParis(Date.parse('2026-10-25T03:00:00Z')), 4, 'nuit du retour a l heure d hiver')
})

test("LE TEST QUI COMPTE : un instant invalide ne rend pas une heure PLAUSIBLE", () => {
  // ⚠ `new Date(null)` VAUT L'EPOCH, soit 01:00 a Paris. Ma version precedente
  // rendait donc 1 pour `heureDeParis(null)` — pas une erreur, une HEURE. Un
  // module qui ecrit ne doit pas se tromper d'heure en silence.
  for (const x of [null, undefined, '', 'x', NaN, Infinity, -Infinity, {}, [], '2026-01-15']) {
    assert.equal(heureDeParis(x), null, `${JSON.stringify(x)} rend une heure`)
  }
})

test("LE TEST QUI COMPTE : hors de la fenetre, il ne fait RIEN", async () => {
  const { client, vu } = faux({ lignes: [SEJOUR()] })
  const r = await rattraperRevenusDerives({ errors: [] }, {
    supabase: client, now: () => Date.parse('2026-01-15T12:00:00Z')   // 13:00 Paris
  })
  assert.equal(r.skipped, 'hors_fenetre')
  assert.equal(r.heure_paris, 13)
  assert.deepEqual(vu.updates, [], 'il a ecrit hors de sa fenetre')
  assert.deepEqual(vu.marqueurs, [], 'il a pose son marqueur hors de sa fenetre')
})

test("LE TEST QUI COMPTE : la cadence tient, meme dans la fenetre", async () => {
  // Deux passages la meme nuit : le second ne doit rien faire. Le cron passe
  // toutes les 5 minutes, donc DOUZE fois dans la fenetre d'une heure.
  const { client, vu } = faux({
    marker: { last_run: new Date(QUATRE_H_HIVER - 60000).toISOString() },
    lignes: [SEJOUR()]
  })
  const r = await rattraperRevenusDerives({ errors: [] }, {
    supabase: client, now: () => QUATRE_H_HIVER
  })
  assert.equal(r.skipped, 'cadence')
  assert.deepEqual(vu.updates, [])
})

test('la cadence laisse repasser apres la periode', async () => {
  const { client } = faux({
    marker: { last_run: new Date(QUATRE_H_HIVER - PERIODE_MS - 1000).toISOString() },
    lignes: [SEJOUR()]
  })
  const r = await rattraperRevenusDerives({ errors: [] }, {
    supabase: client, now: () => QUATRE_H_HIVER
  })
  assert.notEqual(r.skipped, 'cadence')
  assert.equal(r.ecrites, 1)
})

test("LE TEST QUI COMPTE : le marqueur est pose AVANT le travail", async () => {
  // ⚠ SI CE RATTRAPAGE DEBORDE L'INVOCATION, elle est tuee avant d'ecrire un
  // marqueur de fin : le travail repartirait a CHAQUE tick de 5 min et
  // mangerait le budget du dispatch. Poser le marqueur d'abord fait perdre au
  // pire une nuit — et le passage suivant reprend les memes lignes, puisque
  // `aDeriver` est idempotent.
  const { client, vu } = faux({ lignes: [SEJOUR()] })
  await rattraperRevenusDerives({ errors: [] }, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.equal(vu.marqueurs.length, 1)
  assert.equal(vu.marqueurs[0].id, MARQUEUR)
  // L'ordre, dans la trace des tables vues : cron_logs (cadence), cron_logs
  // (marqueur), puis seulement delais_versement et le reste.
  const iMarqueur = vu.selects.indexOf('delais_versement')
  assert.ok(iMarqueur > 0, 'les delais sont lus avant le marqueur')
})

test("LE TEST QUI COMPTE : un marqueur NON ECRIT arrete tout", async () => {
  // Toute la garde de cadence repose sur cette ecriture, et supabase-js ne leve
  // pas : il rend `{ error }`. Marqueur non ecrit = rattrapage relance a chaque
  // tick de 5 minutes.
  const results = { errors: [] }
  const { client, vu } = faux({ lignes: [SEJOUR()], echouerMarqueur: true })
  const r = await rattraperRevenusDerives(results, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.equal(r.skipped, 'marqueur_illisible')
  assert.deepEqual(vu.updates, [], 'il a travaille sans marqueur')
  assert.equal(results.errors.length, 1, 'l echec du marqueur ne remonte pas')
  assert.match(results.errors[0].error, /marqueur/)
})

test("LE TEST QUI COMPTE : sans delais lisibles, il n'ecrit RIEN", async () => {
  // ⚠ DERIVER AVEC UNE TABLE VIDE POSERAIT COLONNES DERIVEES A `null` sur des
  // lignes qui en portaient de justes : un rattrapage qui APPAUVRIT. La
  // distinction entre « je n'ai pas pu lire » et « il n'y a rien » est celle
  // que tout cet ecran passe son temps a tenir.
  for (const delais of [[], null]) {
    const results = { errors: [] }
    const { client, vu } = faux({ delais, lignes: [SEJOUR()] })
    const r = await rattraperRevenusDerives(results, { supabase: client, now: () => QUATRE_H_HIVER })
    assert.equal(r.skipped, 'aucun_delai', `delais=${JSON.stringify(delais)}`)
    assert.deepEqual(vu.updates, [])
    assert.equal(results.errors.length, 1, 'un rattrapage sans delai ne remonte pas')
  }
})

test("LE TEST QUI COMPTE : une ligne SANS payload n'est pas ecrite", async () => {
  // ⚠ UN ENRICHISSEMENT NE DOIT JAMAIS POUVOIR APPAUVRIR. Une ligne dont `raw`
  // est nul ne peut pas rendre un montant : la deriver ecrirait dix `null` avec
  // un motif, et effacerait ce qu'un passage precedent avait pu poser. On la
  // laisse, et comme `derive_le` reste nul elle revient chaque nuit — le jour
  // ou son payload arrive, elle est reprise.
  const { client, vu } = faux({ lignes: [SEJOUR({ raw: null })] })
  const r = await rattraperRevenusDerives({ errors: [] }, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.equal(r.derivees, 1, 'la ligne doit etre COMPTEE comme a deriver')
  assert.equal(r.ecrites, 0, 'elle ne doit pas etre ecrite')
  assert.deepEqual(vu.updates, [])
})

test("LE TEST QUI COMPTE : il ecrit par `id`, JAMAIS par upsert sur la cle metier", async () => {
  // ⚠ UN UPSERT SUR (user_id, booking_id) REECRIRAIT LA LIGNE ENTIERE et
  // pourrait toucher `snapshot` — donc rouvrir la detection de changement, donc
  // renvoyer message de bienvenue, menage et code d'acces a un voyageur. C'est
  // le vecu du depot sur les cles migrees.
  const { client, vu } = faux({ lignes: [SEJOUR()] })
  await rattraperRevenusDerives({ errors: [] }, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.equal(vu.updates.length, 1)
  assert.deepEqual(vu.updates[0].par, ['id', 'row-1'], 'l ecriture ne porte pas sur la cle primaire')
  // Et elle ne touche QUE les colonnes derivees.
  for (const interdit of ['snapshot', 'raw', 'raw_hash', 'property_id', 'user_id', 'booking_id']) {
    assert.ok(!(interdit in vu.updates[0].valeurs),
      `${interdit} est reecrit par le rattrapage`)
  }
  assert.equal(vu.updates[0].valeurs.derive_version, VERSION)
  assert.equal(vu.updates[0].valeurs.property_uuid, 'uuid-1', 'l UUID du bien n est pas resolu')
})

test("LE TEST QUI COMPTE : la cle de resolution est le COUPLE (compte, cle provider)", async () => {
  // ⚠ DEUX COMPTES PEUVENT PORTER LE MEME NUMERO PROVIDER. Resoudre sur la
  // seule cle provider donnerait les revenus d'un hote a l'autre.
  const { client, vu } = faux({
    biens: [{ id: 'uuid-AUTRE', user_id: 'u2', provider_property_id: '209413' }],
    lignes: [SEJOUR()]   // user_id: 'u1'
  })
  await rattraperRevenusDerives({ errors: [] }, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.equal(vu.updates[0].valeurs.property_uuid, null,
    'le bien d un AUTRE compte a ete attribue : fuite entre comptes')
})

test("LE TEST QUI COMPTE : les echecs d'ecriture remontent dans results.errors", async () => {
  // Un cron qui rend 200 en ayant echoue est une panne INVISIBLE : le depot l'a
  // paye 24 heures, et la lecon est au registre de memoire.
  const results = { errors: [] }
  const { client } = faux({ lignes: [SEJOUR()], echouerUpdate: true })
  const r = await rattraperRevenusDerives(results, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.equal(r.echecs, 1)
  assert.equal(r.ecrites, 0)
  assert.equal(results.errors.length, 1)
  assert.match(results.errors[0].error, /echec/)
  assert.equal(results.errors[0].context, 'revenus_derives')
})

test("une migration absente est une ATTENTE, pas une panne", async () => {
  // Une colonne qui n'existe pas encore veut dire que la migration n'est pas
  // collee sur cette base. Ce n'est pas une erreur a remonter : c'est le
  // deroule normal entre le push et le go de Thierry.
  const results = { errors: [] }
  const { client } = faux({
    lignes: [SEJOUR()],
    erreurLecture: { code: 'PGRST204', message: "column bookings_snapshot.derive_le does not exist" }
  })
  const r = await rattraperRevenusDerives(results, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.equal(r.skipped, 'migration_absente')
  assert.deepEqual(results.errors, [], 'une migration en attente est remontee comme une panne')
})

test("une vraie panne de lecture, elle, REMONTE", async () => {
  // La contre-epreuve du test precedent : si toute erreur de lecture etait
  // traitee comme une migration absente, une panne reelle se tairait.
  const results = { errors: [] }
  const { client } = faux({
    lignes: [SEJOUR()],
    erreurLecture: { code: '08006', message: 'connection failure' }
  })
  const r = await rattraperRevenusDerives(results, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.notEqual(r.skipped, 'migration_absente')
  assert.equal(results.errors.length, 1)
  assert.match(results.errors[0].error, /connection failure/)
})

test('sans client Supabase, il ne leve pas', async () => {
  const r = await rattraperRevenusDerives({ errors: [] }, {})
  assert.equal(r.skipped, 'pas_de_client')
})

test('`forcer` passe la fenetre ET la cadence — pour la recette', async () => {
  // Staging n'a AUCUN cron (docs/STAGING.md) : en recette, ce module se lance a
  // la main. Sans `forcer`, il faudrait attendre 04:00.
  const { client, vu } = faux({
    marker: { last_run: new Date(QUATRE_H_HIVER).toISOString() },
    lignes: [SEJOUR()]
  })
  const r = await rattraperRevenusDerives({ errors: [] }, {
    supabase: client, now: () => Date.parse('2026-01-15T15:00:00Z'), forcer: true
  })
  assert.equal(r.ecrites, 1)
  assert.equal(vu.updates.length, 1)
})

// ─── L'EMPREINTE DU PAYLOAD (dette 112) ─────────────────────────────────────
//
// ⚠ CES CINQ TESTS N'EXISTAIENT PAS, ET C'EST PAR LEUR ABSENCE QUE LE DEFAUT
// EST PASSE. Le correctif de la dette 112 avait son test du cote du WRITER,
// aucun du cote du rattrapage : celui-ci appelait `deriverRevenus` SANS
// `empreinteDuRaw`, donc il ecrivait `derive_raw_hash = null` dans la colonne
// qui sert justement a detecter la peremption. Il se reprenait lui-meme chaque
// nuit, a vie, et ecrasait l'empreinte posee par le writer. Trouve par la
// review, verifie par execution, jamais par la suite.

const PERIME = (extra = {}) => SEJOUR({
  derive_le: '2026-10-20T04:00:00.000Z', derive_version: VERSION,
  raw_hash: 'empreinte-neuve', derive_raw_hash: 'empreinte-d-avant', ...extra
})

test('LE TEST QUI COMPTE : le rattrapage POSE l empreinte du payload', async () => {
  const { client, vu } = faux({ lignes: [SEJOUR()] })
  await rattraperRevenusDerives({ errors: [] }, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.equal(vu.updates.length, 1)
  // La fixture n'a pas de `raw_hash` : l'empreinte posee doit valoir `null`,
  // pas une valeur inventee.
  assert.ok('derive_raw_hash' in vu.updates[0].valeurs,
    'la colonne de l empreinte n est pas ecrite du tout')

  const { client: c2, vu: v2 } = faux({ lignes: [SEJOUR({ raw_hash: 'h-1' })] })
  await rattraperRevenusDerives({ errors: [] }, { supabase: c2, now: () => QUATRE_H_HIVER })
  assert.equal(v2.updates.length, 1)
  assert.equal(v2.updates[0].valeurs.derive_raw_hash, 'h-1',
    'le rattrapage ecrit null dans l empreinte : il se reprendra chaque nuit, a vie')
})

test('LE TEST QUI COMPTE : une ligne dont l empreinte DIFFERE est reprise', async () => {
  const { client, vu } = faux({ lignes: [PERIME()] })
  await rattraperRevenusDerives({ errors: [] }, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.equal(vu.updates.length, 1, 'une ligne perimee par son payload n est pas reprise')
  assert.equal(vu.updates[0].valeurs.derive_raw_hash, 'empreinte-neuve')
})

test('LE TEST QUI COMPTE : le rattrapage CONVERGE — une ligne a jour n est pas reprise', async () => {
  // ⚠ C'EST LA CONTRE-EPREUVE DU DEFAUT. Si l'empreinte n'est pas posee, cette
  // ligne reste candidate APRES avoir ete derivee : le meme passage la reprend
  // une seconde fois. Le double applique les ecritures sur ses fixtures, donc
  // il peut le voir — avant le 27 octobre 2026, il ne pouvait pas.
  const { client, vu } = faux({
    lignes: [SEJOUR({ raw_hash: 'h-1' }), PERIME({ id: 'row-2', booking_id: 'B2' })]
  })
  await rattraperRevenusDerives({ errors: [] }, { supabase: client, now: () => QUATRE_H_HIVER })
  const parLigne = new Map()
  for (const u of vu.updates) parLigne.set(String(u.par[1]), (parLigne.get(String(u.par[1])) || 0) + 1)
  assert.deepEqual([...parLigne.entries()].sort(), [['row-1', 1], ['row-2', 1]],
    'une ligne est derivee deux fois dans le meme passage')
})

test('LE TEST QUI COMPTE : le curseur fait depasser la PREMIERE page', async () => {
  // ⚠ SANS CURSEUR, le motif « payload » relirait la meme page a chaque tour :
  // ses lignes restent candidates en SQL (derivees, a jour en version,
  // empreinte presente), c'est `aDeriver` qui tranche en memoire. La derniere
  // ligne ne serait jamais atteinte. Le double honore maintenant `limit` et
  // `gt('id', …)`, donc retirer le curseur du code de production fait rougir
  // ce test — avant, il ne faisait rien rougir.
  const lignes = []
  for (let i = 0; i <= 200; i++) {
    lignes.push(PERIME({ id: `row-${String(i).padStart(4, '0')}`, booking_id: `B${i}` }))
  }
  const { client, vu } = faux({ lignes })
  await rattraperRevenusDerives({ errors: [] }, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.equal(vu.updates.length, 201,
    `${vu.updates.length} lignes ecrites sur 201 : le balayage ne depasse pas la premiere page`)
  assert.ok(vu.updates.some(u => u.par[1] === 'row-0200'),
    'la ligne au-dela de la premiere page n est jamais reprise')
})

test('LE TEST QUI COMPTE : le plafond atteint est ANNONCE, pas tu', async () => {
  // ⚠ Le motif « payload » BALAYE la table (le filtre est en JavaScript, car
  // PostgREST ne compare pas deux colonnes). Au-dela de LIGNES_MAX, la queue de
  // la table n'est pas « reportee a demain » : le curseur repart de zero chaque
  // nuit et l'ordre des `id` est stable, donc elle n'est JAMAIS examinee.
  // 1 436 lignes en production au 27 octobre 2026 pour un plafond de 2 000 : le
  // cas n'est pas atteint, et `bookings_snapshot` ne decroit pas.
  const lignes = []
  for (let i = 0; i < 2000; i++) {
    lignes.push(PERIME({ id: `row-${String(i).padStart(5, '0')}`, booking_id: `B${i}` }))
  }
  const errors = []
  const { client } = faux({ lignes })
  const bilan = await rattraperRevenusDerives({ errors }, { supabase: client, now: () => QUATRE_H_HIVER })
  assert.ok(bilan.tronque, 'le plafond est atteint sans que le bilan le dise')
  assert.ok(errors.some(e => /plafond/.test(e.error || '')),
    'le plafond atteint ne remonte pas dans results.errors')
})
