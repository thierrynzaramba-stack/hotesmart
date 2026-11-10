// tests/messages-direct-regles.test.js
// Le fil de Messages en direct : les REGLES, sans navigateur ni reseau.
// Spec : docs/specs/spec-messages-fil-en-direct.md (§2 et §6).
//
// Le rythme est une decision de Thierry (10 novembre 2026, 01:06) : fil 5 s,
// liste une fois par minute, une relecture par minute apres 15 minutes sans
// geste, et RIEN quand l'onglet est cache. Ce fichier tient le cout par
// onglet que la spec annonce au chef de file : 12 relectures par minute fil
// ouvert, 1 sans fil ou page oubliee, 0 onglet cache.

const test = require('node:test')
const assert = require('node:assert/strict')

let R
test.before(async () => { R = await import('../shared/messages-direct.js') })

const MIN = 60000
const parMinute = (d) => d == null ? 0 : MIN / d

test('LE TEST QUI COMPTE : onglet CACHE = aucune relecture, quel que soit l etat', () => {
  for (const filOuvert of [true, false]) {
    for (const echecs of [0, 1, 5]) {
      for (const inactifDepuisMs of [0, 20 * MIN]) {
        assert.equal(R.delaiDirect({ visible: false, filOuvert, echecs, inactifDepuisMs }), null)
      }
    }
  }
  assert.equal(R.delaiDirect(), null, 'sans argument : pas de relecture')
})

test('LE TEST QUI COMPTE : le cout par onglet annonce dans la spec — 12, 1, 1, 0 relectures par minute', () => {
  assert.equal(parMinute(R.delaiDirect({ visible: true, filOuvert: true })), 12, 'fil ouvert et affiche')
  assert.equal(parMinute(R.delaiDirect({ visible: true, filOuvert: false })), 1, 'liste seule')
  assert.equal(parMinute(R.delaiDirect({ visible: true, filOuvert: true, inactifDepuisMs: 15 * MIN })), 1, 'page oubliee')
  assert.equal(parMinute(R.delaiDirect({ visible: false, filOuvert: true })), 0, 'onglet cache')
})

test('la page oubliee bascule a 15 minutes pile, pas avant', () => {
  assert.equal(R.delaiDirect({ visible: true, filOuvert: true, inactifDepuisMs: 15 * MIN - 1 }), 5000)
  assert.equal(R.delaiDirect({ visible: true, filOuvert: true, inactifDepuisMs: 15 * MIN }), MIN)
})

test('les echecs espacent : 20 s, 40 s, 80 s, puis 2 min au plus — jamais plus vite que le rythme', () => {
  const d = (echecs, filOuvert = true) => R.delaiDirect({ visible: true, filOuvert, echecs })
  assert.deepEqual([1, 2, 3, 4, 9].map(e => d(e)), [20000, 40000, 80000, 120000, 120000])
  assert.equal(d(1, false), MIN, 'liste seule : un echec ne la fait pas relire plus souvent')
})

test('la liste ne se relit que si le serveur annonce du neuf, et au plus une fois par minute', () => {
  const t0 = Date.parse('2026-11-10T08:00:00Z')
  const base = { dernierConnu: '2026-11-10T07:59:00Z', derniereListe: t0 - 2 * MIN, maintenant: t0 }
  assert.equal(R.listeARelire({ ...base, dernier: '2026-11-10T07:59:00Z' }), false, 'rien de neuf')
  assert.equal(R.listeARelire({ ...base, dernier: '2026-11-10T07:58:00Z' }), false, 'plus vieux')
  assert.equal(R.listeARelire({ ...base, dernier: '2026-11-10T07:59:30Z' }), true, 'du neuf')
  assert.equal(R.listeARelire({ ...base, dernier: '2026-11-10T07:59:30Z', derniereListe: t0 - 30000 }), false,
    'du neuf, mais la liste a ete relue il y a 30 s')
  assert.equal(R.listeARelire({ ...base, dernier: 'pas une date' }), false)
  assert.equal(R.listeARelire({ ...base, dernierConnu: null, dernier: '2026-11-10T07:59:30Z' }), true)
})

test('le point de reprise du fil ignore les bulles posees par la page (horloge du navigateur)', () => {
  const messages = [
    { sent_at: '2026-11-10T08:00:00Z', direction: 'inbound', body: 'a' },
    { sent_at: '2026-11-10T08:05:00Z', direction: 'outbound', body: 'b', _local: true },
    { sent_at: '2026-11-10T08:01:00Z', direction: 'outbound', body: 'c' },
    { sent_at: 'invalide', direction: 'inbound', body: 'd' }
  ]
  assert.equal(R.apresDuFil(messages), '2026-11-10T08:01:00.000Z')
  assert.equal(R.apresDuFil([]), null)
  assert.equal(R.apresDuFil([{ sent_at: '2026-11-10T08:05:00Z', _local: true }]), null)
})

test('LE TEST QUI COMPTE : aucun doublon — le message connu revient (>=), il n est pas rajoute', () => {
  const connu = { sent_at: '2026-11-10T08:00:00Z', direction: 'inbound', body: 'Bonjour' }
  const neuf = { sent_at: '2026-11-10T08:00:07Z', direction: 'inbound', body: 'Je suis devant la porte' }
  const r = R.fusionnerMessages([connu], [{ ...connu, sent_at: '2026-11-10T08:00:00.000Z' }, neuf])
  assert.equal(r.messages.length, 2)
  assert.equal(r.ajoutes, 1)
  assert.equal(r.entrants, 1)
  assert.equal(r.messages[1].body, 'Je suis devant la porte')
})

test('LE TEST QUI COMPTE : la bulle posee par la page apres un envoi est REMPLACEE par sa ligne du coeur', () => {
  const local = { sent_at: '2026-11-10T08:00:03Z', direction: 'outbound', body: 'Le code est 1234', _local: true }
  const coeur = { sent_at: '2026-11-10T08:00:01Z', direction: 'outbound', body: 'Le code est 1234 ', kind: 'message', origine: 'hote' }
  const r = R.fusionnerMessages([local], [coeur])
  assert.equal(r.messages.length, 1, 'le message envoye apparait deux fois')
  assert.equal(r.remplaces, 1)
  assert.equal(r.ajoutes, 0)
  assert.equal(r.messages[0]._local, undefined, 'la bulle porte maintenant la ligne du coeur')
  assert.equal(r.messages[0].sent_at, '2026-11-10T08:00:01Z')
})

test('une bulle locale ne mange pas un message identique envoye bien plus tard, ni un autre texte', () => {
  const local = { sent_at: '2026-11-10T08:00:00Z', direction: 'outbound', body: 'Merci', _local: true }
  const tard = { sent_at: '2026-11-10T08:06:00Z', direction: 'outbound', body: 'Merci' }
  const autre = { sent_at: '2026-11-10T08:00:01Z', direction: 'outbound', body: 'Merci beaucoup' }
  const r = R.fusionnerMessages([local], [tard, autre])
  assert.equal(r.messages.length, 3)
  assert.equal(r.remplaces, 0)
  assert.equal(r.entrants, 0, 'un sortant n est pas un message du voyageur')
})

test('les propositions du fil : une nouvelle arrive, une partie disparait, celle qu on tient reste', () => {
  const autreFil = { id: 9, book_id: 'B2', suggested_reply: 'x' }
  const partie = { id: 1, book_id: 'B1', suggested_reply: 'envoyee par le cron' }
  const enEnvoi = { id: 2, book_id: 'B1', suggested_reply: 'je l envoie', etatEnvoi: 'en_cours' }
  const enEdition = { id: 3, book_id: 'B1', suggested_reply: 'je la corrige' }
  const nouvelle = { id: 4, book_id: 'B1', suggested_reply: 'nouvelle', send_after: '2026-11-10T08:10:00Z' }
  const r = R.fusionnerTaches([autreFil, partie, enEnvoi, enEdition], 'B1', [nouvelle], 3)
  const ids = r.taches.map(x => x.id).sort()
  assert.deepEqual(ids, [2, 3, 4, 9])
  assert.equal(r.change, true)
})

test('les propositions inchangees ne demandent aucun rendu, et l etat d envoi tenu par la page survit', () => {
  const x = { id: 1, book_id: 'B1', suggested_reply: 'a', etatEnvoi: 'echec' }
  const r = R.fusionnerTaches([x], 'B1', [{ id: 1, book_id: 'B1', suggested_reply: 'a' }])
  assert.equal(r.change, false)
  assert.equal(r.taches[0].etatEnvoi, 'echec')
})

test('LE TEST QUI COMPTE : la ligne du coeur arrivee AVANT la bulle locale — la bulle est retiree, pas doublee', () => {
  // Review 1, constat 2 : un cycle ramene la ligne pendant l'envoi, la page
  // pose sa bulle APRES. Au cycle suivant la ligne n'est plus « neuve » : sans
  // la passe finale, le doublon restait pour toujours.
  const coeur = { sent_at: '2026-11-10T08:00:01Z', direction: 'outbound', body: 'Avec plaisir', kind: 'message' }
  const local = { sent_at: '2026-11-10T08:00:02Z', direction: 'outbound', body: 'Avec plaisir', _local: true }
  const r = R.fusionnerMessages([coeur, local], [coeur])
  assert.equal(r.messages.length, 1)
  assert.equal(r.messages[0]._local, undefined)
  assert.equal(r.remplaces, 1, 'un retrait doit demander un rendu')
})

test('une horloge de poste decalee de 4 minutes ne laisse pas de doublon', () => {
  // Review 1, constat 9 : deux horloges, la fenetre est de 5 minutes.
  const local = { sent_at: '2026-11-10T08:04:00Z', direction: 'outbound', body: 'Ok', _local: true }
  const coeur = { sent_at: '2026-11-10T08:00:00Z', direction: 'outbound', body: 'Ok' }
  assert.equal(R.fusionnerMessages([local], [coeur]).messages.length, 1)
  assert.equal(R.FENETRE_JUMELLE_MS, 5 * MIN)
})

test('aDejaSaLigne : la page ne pose pas sa bulle si la ligne du coeur est deja la', () => {
  const t = Date.parse('2026-11-10T08:00:00Z')
  const coeur = { sent_at: '2026-11-10T07:59:58Z', direction: 'outbound', body: 'Le code est 4821' }
  assert.equal(R.aDejaSaLigne([coeur], 'Le code est 4821 ', t), true)
  assert.equal(R.aDejaSaLigne([coeur], 'Autre texte', t), false)
  assert.equal(R.aDejaSaLigne([{ ...coeur, _local: true }], 'Le code est 4821', t), false, 'une bulle locale n est pas une ligne du coeur')
  assert.equal(R.aDejaSaLigne([{ ...coeur, direction: 'inbound' }], 'Le code est 4821', t), false)
})

test('LE TEST QUI COMPTE : la fusion des propositions se fait EN PLACE — l objet que la page tient reste le bon', () => {
  // Review 1, constat 5b : `envoyerProposition` ecrit `etatEnvoi` sur l'objet
  // qu'il tient ; un objet neuf a l'ecran restait fige.
  const x = { id: 1, book_id: 'B1', suggested_reply: 'a' }
  const r = R.fusionnerTaches([x], 'B1', [{ id: 1, book_id: 'B1', suggested_reply: 'b' }])
  assert.equal(r.taches[0], x, 'un objet neuf a remplace celui de la page')
  assert.equal(x.suggested_reply, 'b')
  assert.equal(r.change, true)
})

test('LE TEST QUI COMPTE : une proposition close par la page ne ressuscite pas sur une reponse lue avant la cloture', () => {
  // Review 1, constat 5a.
  const lue = [{ id: 7, book_id: 'B1', suggested_reply: 'rejetee' }]
  const r = R.fusionnerTaches([], 'B1', lue, null, new Set(['7']))
  assert.equal(r.taches.length, 0)
  assert.equal(r.change, false)
})

test('la portee `null` fond TOUTES les propositions (relecture de la liste) sans perdre celle qu on envoie', () => {
  // Review 1, constat BLOQUANT : la relecture de la liste ECRASAIT les
  // propositions — celle que l'hote envoyait (`sending` cote serveur, donc
  // absente de la lecture) disparaissait, et sa cloture ne partait jamais.
  const enEnvoi = { id: 1, book_id: 'B1', suggested_reply: 'je l envoie', etatEnvoi: 'en_cours' }
  const autre = { id: 2, book_id: 'B2', suggested_reply: 'x' }
  const r = R.fusionnerTaches([enEnvoi, autre], null, [{ id: 2, book_id: 'B2', suggested_reply: 'x' }, { id: 3, book_id: 'B3', suggested_reply: 'neuve' }])
  assert.equal(r.taches.map(x => x.id).join(','), '1,2,3')
  assert.equal(r.taches[0], enEnvoi)
})
