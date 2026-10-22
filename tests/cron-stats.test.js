// tests/cron-stats.test.js
// LA LIGNE DE MESURE D'UN PASSAGE, ET SA LECTURE EN CLASSEMENT.
//
// ⚠ LA PROPRIETE QUI COMPTE PLUS QUE TOUTES LES AUTRES : L'ECRITURE DE LA
// MESURE NE PEUT PAS FAIRE ECHOUER LE CRON. C'est l'exigence posee par
// Thierry le 22 octobre 2026, et elle n'est pas de confort : le cycle de
// 5 minutes envoie des messages au voyageur, cree des codes de serrure et
// pousse des prix au canal. Un lot de MESURE qui casserait ca aurait coute
// plus que ce qu'il mesure.
//
// On eprouve donc les quatre facons de mal finir : l'insertion qui leve,
// celle qui rend une erreur, la table absente, et la base qui PEND.

const test = require('node:test')
const assert = require('node:assert')
const S = require('../lib/cron-stats')

// ─── Une fausse base, chainable comme postgrest ──────────────────────────────
function fausseBase (comportements = {}) {
  const appels = []
  const r = (quoi, defaut) => (typeof comportements[quoi] === 'function'
    ? comportements[quoi]()
    : (comportements[quoi] !== undefined ? comportements[quoi] : defaut))
  const client = {
    from (table) {
      return {
        insert (ligne) { appels.push({ table, op: 'insert', ligne }); return Promise.resolve(r('insert', { error: null })) },
        upsert (ligne) { appels.push({ table, op: 'upsert', ligne }); return Promise.resolve(r('upsert', { error: null })) },
        delete () {
          return { lt (colonne, valeur) { appels.push({ table, op: 'delete', colonne, valeur }); return Promise.resolve(r('delete', { error: null })) } }
        },
        select (colonnes) {
          appels.push({ table, op: 'select', colonnes })
          const fin = {
            eq: () => ({ maybeSingle: () => Promise.resolve(r('marqueur', { data: null, error: null })) }),
            order: () => ({ limit: (n) => { appels.push({ table, op: 'limit', n }); return Promise.resolve(r('lignes', { data: [], error: null })) } }),
          }
          return fin
        },
      }
    },
    rpc (nom, args) { appels.push({ op: 'rpc', nom, args }); return Promise.resolve(r('rpc', { data: [], error: null })) },
  }
  return { client, appels }
}

const UN_PASSAGE = {
  cron: 'cron',
  commence_le: '2026-10-22T08:00:00.000Z',
  duree_ms: 41234,
  requetes: 312,
  appels_externes: 7,
  taches: [{ nom: 'dispatch_changements', n: 1, ms: 20000, ms_seul: 20000, req: 180, ext: { haiku: 4 }, ext_total: 4, travail: { totalBookingChanges: 3 }, travail_total: 3 }],
  totaux: { taches: 1, tronquees: 0, externes: { haiku: 4 }, travail: { totalBookingChanges: 3 } },
}

// ─── 1. L'ecriture ──────────────────────────────────────────────────────────

test('un passage s ecrit en une ligne, avec sa date de DEBUT', async () => {
  const b = fausseBase()
  const r = await S.ecrireLePassage(b.client, UN_PASSAGE, { maintenant: () => Date.parse('2026-10-22T08:00:41.234Z') })
  assert.equal(r.ok, true)
  const ligne = b.appels.find(a => a.op === 'insert').ligne
  assert.equal(ligne.cron, 'cron')
  // ⚠ `commence_le` est la date du PASSAGE, pas celle de l'ecriture : un
  // cycle de 41 s ecrit sa ligne 41 s apres son debut, et classer sur
  // l'ecriture decalerait chaque passage.
  assert.equal(ligne.commence_le, '2026-10-22T08:00:00.000Z')
  assert.equal(ligne.termine_le, '2026-10-22T08:00:41.234Z')
  assert.equal(ligne.duree_ms, 41234)
  assert.equal(ligne.requetes, 312)
  assert.equal(ligne.appels_externes, 7)
  assert.equal(ligne.taches[0].nom, 'dispatch_changements')
})

test('⚠ une insertion qui LEVE ne fait pas echouer le cron', async () => {
  const b = fausseBase({ insert: () => { throw new Error('socket fermee') } })
  const r = await S.ecrireLePassage(b.client, UN_PASSAGE)
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'exception')
})

test('⚠ une insertion qui rend une erreur ne fait pas echouer le cron', async () => {
  const b = fausseBase({ insert: { error: { message: 'duplicate key' } } })
  const r = await S.ecrireLePassage(b.client, UN_PASSAGE)
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'erreur')
})

test('⚠ la table absente est dite UNE fois, et nomme la migration', async () => {
  const dits = []
  const vrai = console.error
  console.error = (...a) => dits.push(a.join(' '))
  try {
    const b = fausseBase({ insert: { error: { message: 'relation "public.cron_stats" does not exist' } } })
    const r1 = await S.ecrireLePassage(b.client, UN_PASSAGE)
    const r2 = await S.ecrireLePassage(b.client, UN_PASSAGE)
    assert.equal(r1.raison, 'table_absente')
    assert.equal(r2.raison, 'table_absente')
    const nommees = dits.filter(d => /2026-10-22-cron-stats/.test(d))
    assert.equal(nommees.length, 1, 'une fois par instance, pas 288 fois par jour')
  } finally { console.error = vrai }
})

test('⚠ UNE BASE QUI PEND N EST PAS ATTENDUE : le cycle continue', async () => {
  // Le cycle a 60 s de budget pour envoyer des messages au voyageur. Une
  // mesure qui attend indefiniment une base lente mangerait ce budget — donc
  // le lot de mesure causerait la panne qu'il cherche a prevenir.
  const b = fausseBase({ insert: () => new Promise(() => {}) })
  const avant = Date.now()
  const r = await S.ecrireLePassage(b.client, UN_PASSAGE, { delaiMs: 40 })
  assert.equal(r.raison, 'en_retard')
  assert.ok(Date.now() - avant < 2000, 'rendu tout de suite, pas apres le delai du cron')
})

test('un detail vide ne produit aucune ecriture', async () => {
  const b = fausseBase()
  assert.equal((await S.ecrireLePassage(b.client, null)).raison, 'detail_vide')
  assert.equal(b.appels.length, 0)
})

// ─── 2. La purge ────────────────────────────────────────────────────────────

test('la purge retire ce qui depasse 30 jours, et pose son marqueur', async () => {
  const b = fausseBase({ marqueur: { data: { last_run: '2026-09-01T00:00:00.000Z' }, error: null } })
  const r = await S.purgerSiDue(b.client, { maintenant: () => Date.parse('2026-10-22T09:00:00.000Z') })
  assert.equal(r.faite, true)
  const suppression = b.appels.find(a => a.op === 'delete')
  assert.equal(suppression.table, 'cron_stats')
  assert.equal(suppression.colonne, 'commence_le')
  assert.equal(suppression.valeur, '2026-09-22T09:00:00.000Z')
  const marqueur = b.appels.find(a => a.op === 'upsert')
  assert.equal(marqueur.ligne.id, S.MARQUEUR_PURGE)
})

test('⚠ la purge ne repart pas a chaque tick : un marqueur du jour la saute', async () => {
  // Sans marqueur, le `delete` partirait aux 288 ticks quotidiens : une
  // requete de plus par passage, DANS le compteur qu'on est en train de
  // mesurer. Le lot faussait alors sa propre mesure.
  const b = fausseBase({ marqueur: { data: { last_run: '2026-10-22T07:00:00.000Z' }, error: null } })
  const r = await S.purgerSiDue(b.client, { maintenant: () => Date.parse('2026-10-22T09:00:00.000Z') })
  assert.equal(r.saute, true)
  assert.equal(b.appels.filter(a => a.op === 'delete').length, 0)
})

test('⚠ LE MARQUEUR SE POSE AVANT LE DELETE, pas apres', async () => {
  // CONSTAT DE REVIEW : la purge n'avait aucun garde-temps et le cycle
  // l'attendait. Une fois par jour, le `delete` porte sur ~13 000 lignes a
  // colonne JSON : une base lente bloquait le handler jusqu'au couperet des
  // 60 s. On peut desormais ABANDONNER l'attente — et c'est sans danger
  // UNIQUEMENT parce que le marqueur est deja pose : sinon la purge
  // repartirait au tick suivant, puis au suivant.
  const b = fausseBase({ marqueur: { data: null, error: null } })
  await S.purgerSiDue(b.client, { maintenant: () => Date.parse('2026-10-22T09:00:00.000Z') })
  const ordre = b.appels.filter(a => a.op === 'upsert' || a.op === 'delete').map(a => a.op)
  assert.deepEqual(ordre, ['upsert', 'delete'])
})

test('⚠ LE CRON N ATTEND PAS UNE PURGE LENTE', async () => {
  const b = fausseBase({ marqueur: { data: null, error: null }, delete: () => new Promise(() => {}) })
  const avant = Date.now()
  const r = await S.purgerSiDue(b.client, { delaiMs: 40, maintenant: () => Date.parse('2026-10-22T09:00:00.000Z') })
  assert.equal(r.raison, 'en_retard')
  assert.ok(Date.now() - avant < 2000)
  // Le marqueur est quand meme pose : la purge ne repartira pas au tick suivant.
  assert.ok(b.appels.find(a => a.op === 'upsert'))
})

test('⚠ UN MARQUEUR ILLISIBLE FAIT SAUTER LA PURGE, il ne la declenche pas', async () => {
  // CONSTAT DE REVIEW : l'erreur de lecture n'etait pas distinguee de
  // l'absence de ligne. Une base qui refuse la lecture rendait `dernier =
  // null`, donc « purge due », donc un `delete` a CHACUN des 288 ticks
  // quotidiens — l'inverse exact de ce que le marqueur sert a empecher.
  // Perdre un jour de purge sur 30 jours de conservation ne coute rien.
  const b = fausseBase({ marqueur: { data: null, error: { message: 'timeout' } } })
  const r = await S.purgerSiDue(b.client, { maintenant: () => Date.parse('2026-10-22T09:00:00.000Z') })
  assert.equal(r.raison, 'marqueur_illisible')
  assert.equal(b.appels.filter(a => a.op === 'delete').length, 0)
  assert.equal(b.appels.filter(a => a.op === 'upsert').length, 0)
})

test('⚠ une purge qui echoue ne fait pas echouer le cron', async () => {
  const b = fausseBase({ marqueur: { data: null, error: null }, delete: () => { throw new Error('timeout') } })
  const r = await S.purgerSiDue(b.client, { maintenant: () => Date.parse('2026-10-22T09:00:00.000Z') })
  assert.equal(r.raison, 'exception')
})

// ─── 3. Le classement ───────────────────────────────────────────────────────

const LIGNES_RPC = [
  { cron: 'cron', tache: 'lente_sans_requete', passages: 10, appels: 10, ms: 90000, requetes: 0, externes: 0, travail: 0 },
  { cron: 'cron', tache: 'dispatch_changements', passages: 10, appels: 10, ms: 20000, requetes: 1800, externes: 40, travail: 30 },
  { cron: 'cron', tache: 'sonde_croissance', passages: 10, appels: 10, ms: 1000, requetes: 1800, externes: 0, travail: 0 },
]

test('le classement est trie par REQUETES puis par TEMPS', async () => {
  // L'ordre demande par Thierry. Le temps seul designe les taches qui
  // ATTENDENT un partenaire ; les requetes designent celles qui chargent la
  // base — et c'est la base qui est le sujet du decoupage.
  const b = fausseBase({ rpc: () => ({ data: LIGNES_RPC, error: null }) })
  const r = await S.classement(b.client, { heures: 24, maintenant: () => Date.parse('2026-10-22T09:00:00.000Z') })
  assert.equal(r.ok, true)
  assert.deepEqual(r.classement.map(l => l.tache),
    ['dispatch_changements', 'sonde_croissance', 'lente_sans_requete'])
  // La fenetre part bien de l'heure demandee.
  const rpc = b.appels.find(a => a.op === 'rpc' && a.nom === 'cron_stats_classement')
  assert.equal(rpc.args.depuis, '2026-10-21T09:00:00.000Z')
})

test('la limite coupe la liste, et le total des taches reste dit', async () => {
  const b = fausseBase({ rpc: () => ({ data: LIGNES_RPC, error: null }) })
  const r = await S.classement(b.client, { limite: 1, maintenant: () => Date.parse('2026-10-22T09:00:00.000Z') })
  assert.equal(r.classement.length, 1)
  assert.equal(r.taches, 3, 'le classement dit combien de taches il a vues, pas combien il en montre')
})

test('⚠ la fonction SQL absente se dit « migration non appliquee », pas « erreur »', async () => {
  // Un refus qui ne dit pas sa cause fait chercher du cote des droits
  // pendant une heure. Vecu sur la page de diagnostic le 30 septembre.
  const b = fausseBase({ rpc: () => ({ data: null, error: { message: 'Could not find the function public.cron_stats_classement' } }) })
  const r = await S.classement(b.client, { maintenant: () => Date.parse('2026-10-22T09:00:00.000Z') })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'migration_non_appliquee')
})

test('le total par jour accompagne le classement, et son echec ne le tue pas', async () => {
  let n = 0
  const b = fausseBase({
    rpc: () => {
      n++
      if (n === 1) return { data: LIGNES_RPC, error: null }
      return { data: null, error: { message: 'boum' } }
    }
  })
  const r = await S.classement(b.client, { maintenant: () => Date.parse('2026-10-22T09:00:00.000Z') })
  assert.equal(r.ok, true, 'le classement reste lisible meme sans le total par jour')
  assert.deepEqual(r.par_jour, [])
  assert.equal(r.par_jour_erreur, 'boum')
})

test('les derniers passages se lisent BORNES, un par cron', async () => {
  const b = fausseBase({ lignes: {
    data: [
      { cron: 'cron', commence_le: '2026-10-22T09:00:00Z', duree_ms: 1, requetes: 1, appels_externes: 0, taches: [] },
      { cron: 'cron', commence_le: '2026-10-22T08:55:00Z', duree_ms: 1, requetes: 1, appels_externes: 0, taches: [] },
      { cron: 'cron-messages', commence_le: '2026-10-22T08:50:00Z', duree_ms: 1, requetes: 1, appels_externes: 0, taches: [] },
    ], error: null } })
  const r = await S.derniersPassages(b.client)
  assert.equal(r.ok, true)
  assert.deepEqual(r.passages.map(p => p.cron), ['cron', 'cron-messages'])
  // ⚠ Supabase tronque a 1000 lignes SANS erreur : toute lecture est bornee.
  assert.ok(b.appels.find(a => a.op === 'limit'), 'la lecture porte une borne explicite')
})
