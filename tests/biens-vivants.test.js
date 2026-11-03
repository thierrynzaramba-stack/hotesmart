// tests/biens-vivants.test.js — la liste des biens ARCHIVES.
//
// Lot « archiver un bien ». Constats 6 et 8 de la revue de 320aa4f8, tous deux
// trouves parce qu'une mutation survivait a mes premiers tests.
//
// ⚠ CE FICHIER TESTE LE MODULE DIRECTEMENT, et c'est la raison de son
// existence : les deux proprietes qui comptent — la cle composite et l'aveu
// d'une lecture incomplete — ne se montrent pas a travers le double de la
// synchro des menages, ou une erreur de lecture coupe le cycle AVANT.

const test = require('node:test')
const assert = require('node:assert/strict')
const B = require('../lib/biens-vivants.js')

// Un double minimal, et STRICT : il refuse une methode qu'il ne connait pas.
function banc ({ lignes = [], erreur = null } = {}) {
  const vu = { filtres: [], borne: null, colonnes: null }
  const client = {
    from (t) {
      assert.strictEqual(t, 'properties', `table inattendue : ${t}`)
      const q = {
        select (c) { vu.colonnes = c; return q },
        in (c, v) { vu.filtres.push(['in', c, v]); return q },
        not (c, op, v) { vu.filtres.push(['not', c, op, v]); return q },
        is (c, v) { vu.filtres.push(['is', c, v]); return q },
        eq (c, v) { vu.filtres.push(['eq', c, v]); return q },
        limit (n) { vu.borne = n; return q },
        then (ok, ko) {
          return Promise.resolve(erreur ? { data: null, error: erreur } : { data: lignes, error: null })
            .then(ok, ko)
        }
      }
      return q
    }
  }
  return { client, vu }
}

test("LE TEST QUI COMPTE : la cle est COMPOSITE — deux comptes peuvent porter le meme numero", async () => {
  // ⚠ CONSTAT 6 : une fuite d'EFFET entre comptes. `provider_property_id` n'a
  // aucune unicite globale. Avec une cle non cloisonnee, le bien archive du
  // compte A faisait ecarter le bien VIVANT du compte B portant le meme numero.
  const b = banc({ lignes: [{ user_id: 'A', provider_property_id: '209413' }] })
  const r = await B.clesArchivees(b.client, ['A', 'B'])
  assert.ok(r.cles.has(B.cleDuBien('A', '209413')), 'le bien archive du compte A est absent')
  assert.ok(!r.cles.has(B.cleDuBien('B', '209413')),
    'le bien du compte B est traite comme archive : la cle n est pas cloisonnee')
  assert.ok(!r.cles.has('209413'), 'la cle nue est presente : elle ferait collision entre comptes')
  // Et la lecture demande bien les deux colonnes dont la cle est faite.
  assert.match(String(b.vu.colonnes), /user_id/, 'la lecture n ecarte pas le compte')
  assert.match(String(b.vu.colonnes), /provider_property_id/)
})

test("LE TEST QUI COMPTE : une lecture RATEE se dit incomplete, elle ne dit pas « aucun archive »", async () => {
  // ⚠ CONSTAT 8. Rendre un Set vide sur une panne fait passer TOUT le parc pour
  // vivant : on recreerait les menages des biens archives. L'appelant doit
  // pouvoir s'abstenir, donc la panne se DIT.
  const b = banc({ erreur: { message: 'properties illisible' } })
  const r = await B.clesArchivees(b.client, ['A'])
  assert.strictEqual(r.complet, false, 'une lecture ratee se declare complete')
  assert.strictEqual(r.cles.size, 0)
})

test("LE TEST QUI COMPTE : « la colonne n existe pas encore » n est PAS une panne", async () => {
  // ⚠ CONSTAT 5 DE LA REVUE DE 26339835, et il conditionne la MISE EN PROD.
  // Dans ce depot une migration se colle A LA MAIN apres le push : il y a donc
  // toujours une fenetre ou le code nomme une colonne que la base n'a pas, et
  // PostgREST echoue EN ENTIER (42703). Traite comme une panne, ce cas faisait
  // renoncer `cron-beds24-props` a materialiser A CHAQUE CYCLE pendant toute la
  // fenetre, en journalisant une erreur qui n'en est pas une.
  // ⚠ ET LA REPONSE « AUCUN BIEN ARCHIVE » EST LITTERALEMENT VRAIE : sans la
  // colonne, aucun bien ne PEUT etre archive. Ce n'est pas une degradation,
  // c'est le bon resultat.
  const b = banc({ erreur: { code: '42703', message: 'column properties.archive_le does not exist' } })
  const r = await B.clesArchivees(b.client, ['A'])
  assert.strictEqual(r.complet, true,
    'une colonne absente est traitee comme une panne : la materialisation Beds24 s arreterait a chaque cycle')
  assert.strictEqual(r.cles.size, 0)
  assert.strictEqual(r.colonneAbsente, true, 'le cas n est pas distingue dans la reponse')
})

test("une AUTRE erreur de lecture, elle, reste une panne", async () => {
  // Le contre-cas : sans lui, « tout traiter comme une colonne absente »
  // passerait le test precedent et avalerait les vraies pannes.
  const b = banc({ erreur: { code: '08006', message: 'connection failure' } })
  const r = await B.clesArchivees(b.client, ['A'])
  assert.strictEqual(r.complet, false, 'une panne de connexion est traitee comme « aucun bien archive »')
})

test("LE TEST QUI COMPTE : une lecture TRONQUEE se dit incomplete", async () => {
  // PostgREST tronque SANS erreur : c'est le cas le plus traitre des deux.
  const pleine = Array.from({ length: B.LOT_ARCHIVES }, (_, i) => ({
    user_id: 'A', provider_property_id: String(i)
  }))
  const b = banc({ lignes: pleine })
  const r = await B.clesArchivees(b.client, ['A'])
  assert.strictEqual(r.complet, false,
    `${B.LOT_ARCHIVES} lignes lues pour une borne de ${B.LOT_ARCHIVES} : la troncature n est pas detectee`)
  assert.strictEqual(b.vu.borne, B.LOT_ARCHIVES, 'la lecture n est pas bornee explicitement')
})

test("LE TEST QUI COMPTE : une lecture tronquee GARDE les cles lues", async () => {
  // ⚠ CONSTAT 3 DE LA REVUE DE 26339835. Jeter 1 000 cles JUSTES parce qu'il en
  // manque d'autres ferait recreer les menages de TOUS les biens archives, et
  // resonner les 3 780 incidents que cette lecture existe pour fermer. Le Set
  // partiel est strictement plus sur : les deux gardes de la synchro lisent le
  // MEME Set, donc un bien qui y figure est ecarte ET protege de l'annulation.
  const pleine = Array.from({ length: B.LOT_ARCHIVES }, (_, i) => ({
    user_id: 'A', provider_property_id: String(i)
  }))
  const b = banc({ lignes: pleine })
  const r = await B.clesArchivees(b.client, ['A'])
  assert.strictEqual(r.cles.size, B.LOT_ARCHIVES,
    `${r.cles.size} cle(s) gardee(s) sur une lecture tronquee : des biens archives repassent pour vivants`)
  assert.strictEqual(r.complet, false, 'la troncature doit rester DITE')
})

test("une lecture sous la borne se dit complete", async () => {
  const b = banc({ lignes: [{ user_id: 'A', provider_property_id: '1' }] })
  const r = await B.clesArchivees(b.client, ['A'])
  assert.strictEqual(r.complet, true)
})

test("sans compte, aucune lecture n est faite", async () => {
  const b = banc({ lignes: [{ user_id: 'A', provider_property_id: '1' }] })
  const r = await B.clesArchivees(b.client, [])
  assert.strictEqual(r.cles.size, 0)
  assert.strictEqual(r.complet, true, 'une liste de comptes vide est un resultat, pas une panne')
  assert.strictEqual(b.vu.borne, null, 'une lecture a ete faite pour rien')
})

test("la lecture ECARTE les biens vivants et ceux sans cle provider", async () => {
  // Les deux `not` sont la raison d'etre de cette lecture : sans eux, le Set
  // contiendrait tout le parc.
  const b = banc({ lignes: [] })
  await B.clesArchivees(b.client, ['A'])
  const nots = b.vu.filtres.filter(f => f[0] === 'not').map(f => f[1])
  assert.ok(nots.includes(B.COLONNE), 'la lecture ne demande pas les biens ARCHIVES')
  assert.ok(nots.includes('provider_property_id'),
    'un bien sans cle provider entrerait dans le Set avec une cle « A|null »')
})

test("sansArchives REFUSE ce qui n est pas une chaine Supabase", () => {
  // ⚠ IL LEVE PLUTOT QUE DE PASSER EN SILENCE, et c'est ce qui a revele que
  // quatre doubles du depot ne modelisaient pas `.is()`. Un filtre qui
  // s'evapore sur un objet inattendu, c'est un cron qui appelle le provider
  // pour un bien archive sans que rien ne le dise.
  assert.throws(() => B.sansArchives(null), TypeError)
  assert.throws(() => B.sansArchives({}), TypeError)
  let vu = null
  B.sansArchives({ is: (c, v) => { vu = [c, v]; return 'chaine' } })
  assert.deepStrictEqual(vu, [B.COLONNE, null])
})

// ─── Un bien archive reste tant qu'il a un depart a venir ───────────────────
test("LE TEST QUI COMPTE : un bien archive AVEC un depart a venir reste, sans depart il sort", () => {
  // ⚠ DECISION DE THIERRY DU 3 NOVEMBRE 2026, qui AFFINE le point 4. Sa
  // premiere forme — « un bien archive disparait des menages » — retirait du
  // planning de la prestataire un menage prevu demain sur un sejour DEJA VENDU.
  // L'archivage est autorise avec des sejours a venir : leurs codes d'acces
  // continuent de fonctionner, donc le voyageur arrive, donc il faut nettoyer
  // apres lui.
  const { archivesEpuisees } = require('../lib/biens-vivants')
  const biens = [
    { cle: 'vivant', archive_le: null },
    { cle: 'range-avec-depart', archive_le: '2026-11-03T20:42:19Z' },
    { cle: 'range-epuise', archive_le: '2026-11-03T20:42:19Z' }
  ]
  const sortent = archivesEpuisees({
    biens,
    departs: { 'range-avec-depart': ['2026-11-08'], 'range-epuise': ['2026-10-01'] },
    aujourdhui: '2026-11-04'
  })
  assert.deepEqual([...sortent], ['range-epuise'])

  // ⚠ UN BIEN VIVANT SANS AUCUN DEPART NE SORT JAMAIS, et ce n'est pas une
  // evidence : ma premiere version appelait `estArchive(b)` — une fonction
  // ASYNC qui interroge la base — donc testait une Promise, toujours vraie.
  // TOUS les biens etaient evalues, et un bien vivant sans reservation
  // disparaissait de l'ecran. Attrape par une mesure directe avant tout test.
  assert.ok(!sortent.has('vivant'),
    'un bien VIVANT sans depart a venir est retire de l ecran')

  // ⚠ `>=` ET NON `>` : un depart AUJOURD'HUI est un menage A FAIRE
  // aujourd'hui. Un `>` ferait disparaitre le bien le matin meme du dernier
  // depart, c'est-a-dire le jour ou la prestataire en a besoin.
  const leJourMeme = archivesEpuisees({
    biens: [{ cle: 'b', archive_le: '2026-11-03T20:42:19Z' }],
    departs: { b: ['2026-11-04'] },
    aujourdhui: '2026-11-04'
  })
  assert.equal(leJourMeme.size, 0, 'le bien sort le jour meme de son dernier depart')

  // Le lendemain, il sort.
  const lendemain = archivesEpuisees({
    biens: [{ cle: 'b', archive_le: '2026-11-03T20:42:19Z' }],
    departs: { b: ['2026-11-04'] },
    aujourdhui: '2026-11-05'
  })
  assert.deepEqual([...lendemain], ['b'])
})

test("archivesEpuisees EXIGE sa date : elle ne lit jamais l horloge", () => {
  // Regle du depot : dates relatives si le test lit l'horloge, dates figees
  // s'il injecte le temps. Cette fonction injecte, donc elle REFUSE de deviner
  // — un repli sur `new Date()` la rendrait ineprouvable a une autre date, et
  // c'est la maladie des 28 rouges calendaires du depot.
  const { archivesEpuisees } = require('../lib/biens-vivants')
  for (const mauvais of [undefined, null, '', '2026-11', 'demain', '04/11/2026']) {
    assert.throws(() => archivesEpuisees({ biens: [], departs: {}, aujourdhui: mauvais }),
      /aujourdhui/, `« ${mauvais} » a ete accepte comme date`)
  }
})
