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
