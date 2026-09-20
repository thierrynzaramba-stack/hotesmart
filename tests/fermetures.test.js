// tests/fermetures.test.js — lot 4.6.2, LES FERMETURES DE L'HOTE.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter §4-§5, §7-A, §7-B.
//
// CE QUE CES TESTS DEFENDENT, dans l'ordre d'importance :
//   1. une fermeture n'est PAS une seconde source de verite : ce module rend
//      des segments, il n'ecrit jamais calendar_inventory ;
//   2. une reouverture SCINDE (arbitrage B) — le dernier geste gagne ;
//   3. une lecture en echec LEVE : un vide par erreur ferait OUVRIR ;
//   4. le cloisonnement est dans le WHERE, pas seulement dans la garde.
//
// ⚠ CES TESTS EXECUTENT le module avec un faux supabase qui enregistre chaque
// requete. Un test qui lirait la source ne verrait pas ce qu'il fait.

const test = require('node:test')
const assert = require('node:assert')
const {
  fermeturesDuBien, fermeturesDesBiens, nuitsFermees, creerFermeture, supprimerFermeture, scinder, scinderAutour, NUITS_MAX
} = require('../lib/fermetures')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const BIEN = '22222222-2222-4222-8222-222222222222'
const F1 = '33333333-3333-4333-8333-333333333333'

// Faux client : ne sert QUE la table `fermetures`, enregistre tout.
function fausseBase (lignes = [], { erreur = null } = {}) {
  const journal = []
  const client = {
    journal,
    from (table) {
      assert.equal(table, 'fermetures', 'ce module ne touche que sa table')
      const q = { table, op: 'select', f: [], ligne: null, lte: null, gte: null, cols: null, dans: null }
      q.select = (cols) => { q.cols = cols; return q }
      q.eq = (c, v) => { q.f.push([c, v]); return q }
      q.in = (c, v) => { q.dans = [c, v]; return q }
      q.lte = (c, v) => { q.lte = [c, v]; return q }
      q.gte = (c, v) => { q.gte = [c, v]; return q }
      q.order = () => q
      q.insert = (row) => { q.op = 'insert'; q.ligne = row; return q }
      q.delete = () => { q.op = 'delete'; return q }
      q.single = () => q
      const executer = () => {
        journal.push({ op: q.op, f: q.f, ligne: q.ligne, lte: q.lte, gte: q.gte, cols: q.cols, dans: q.dans })
        if (erreur) return { data: null, error: erreur }
        if (q.op === 'insert') return { data: { id: 'neuf-' + journal.length, ...q.ligne }, error: null }
        if (q.op === 'delete') {
          const cible = lignes.filter(l => q.f.every(([c, v]) => String(l[c]) === String(v)))
          return { data: cible, error: null }
        }
        // select : croisement de periode + filtres eq + in
        let out = lignes.filter(l => q.f.every(([c, v]) => String(l[c]) === String(v)))
        if (q.dans) out = out.filter(l => q.dans[1].includes(l[q.dans[0]]))
        if (q.lte) out = out.filter(l => l[q.lte[0]] <= q.lte[1])
        if (q.gte) out = out.filter(l => l[q.gte[0]] >= q.gte[1])
        return { data: out, error: null }
      }
      q.then = (res, rej) => Promise.resolve(executer()).then(res, rej)
      return q
    }
  }
  return client
}
const fermeture = (o = {}) => ({ id: F1, user_id: COMPTE, property_id: BIEN,
  date_debut: '2026-10-12', date_fin: '2026-10-20', raison: 'travaux', ...o })

// ─── 1. Pas une seconde source de verite ────────────────────────────────────
test('LE TEST QUI COMPTE : creer une fermeture rend des SEGMENTS, elle n ecrit pas le calendrier', async () => {
  const sb = fausseBase()
  const r = await creerFermeture(sb, { userId: COMPTE, propertyId: BIEN, debut: '2026-10-12', fin: '2026-10-20', raison: '  travaux  ' })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(r.segments, [{ date_from: '2026-10-12', date_to: '2026-10-20', stop_sell: true }],
    'ce que la porte passera au writer du calendrier : stop_sell sur la periode, rien d autre')
  assert.equal(r.fermeture.raison, 'travaux', 'la raison est nettoyee')
  const ins = sb.journal.find(j => j.op === 'insert')
  assert.equal(ins.ligne.user_id, COMPTE); assert.equal(ins.ligne.property_id, BIEN)
  assert.ok(sb.journal.every(j => j.op !== 'update'), 'aucune ecriture de calendar_inventory ici')
})

test('une fermeture sans raison, ou a l envers, est refusee — sans exception', async () => {
  const sb = fausseBase()
  assert.equal((await creerFermeture(sb, { userId: COMPTE, propertyId: BIEN, debut: '2026-10-12', fin: '2026-10-20', raison: '   ' })).raison, 'raison_manquante')
  assert.equal((await creerFermeture(sb, { userId: COMPTE, propertyId: BIEN, debut: '2026-10-20', fin: '2026-10-12', raison: 'x' })).raison, 'periode_invalide')
  assert.equal((await creerFermeture(sb, { userId: 'pas-un-uuid', propertyId: BIEN, debut: '2026-10-12', fin: '2026-10-12', raison: 'x' })).raison, 'parametres_invalides')
  assert.equal(sb.journal.length, 0, 'rien n est parti en base')
})

test('une fermeture d UN jour est valide : debut = fin', async () => {
  const r = await creerFermeture(fausseBase(), { userId: COMPTE, propertyId: BIEN, debut: '2026-10-12', fin: '2026-10-12', raison: 'x' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.segments[0], { date_from: '2026-10-12', date_to: '2026-10-12', stop_sell: true })
})

// ─── 2. La lecture croise, et LEVE en echec ─────────────────────────────────
test('LE TEST QUI COMPTE : une lecture en echec LEVE — un vide par erreur ferait OUVRIR', async () => {
  const sb = fausseBase([], { erreur: { message: 'timeout' } })
  await assert.rejects(() => fermeturesDuBien(sb, BIEN, '2026-10-01', '2026-10-31'), /lecture : timeout/)
  await assert.rejects(() => fermeturesDuBien(sb, 'pas-un-uuid', '2026-10-01', '2026-10-31'), /uuid/)
  await assert.rejects(() => fermeturesDuBien(sb, BIEN, '2026-10-31', '2026-10-01'), /periode invalide/)
})

test('la lecture rend les fermetures qui CROISENT la periode, pas seulement incluses', async () => {
  const sb = fausseBase([fermeture()])
  assert.equal((await fermeturesDuBien(sb, BIEN, '2026-10-15', '2026-10-16')).length, 1, 'la semaine du 15 est dans la fermeture 12-20')
  assert.equal((await fermeturesDuBien(sb, BIEN, '2026-10-21', '2026-10-31')).length, 0, 'le 21 est dehors')
  assert.equal((await fermeturesDuBien(sb, BIEN, '2026-10-20', '2026-10-20')).length, 1, 'la borne est DEDANS')
})

test('nuitsFermees : les nuits couvertes, bornees a la periode demandee', () => {
  const s = nuitsFermees([fermeture()], '2026-10-18', '2026-10-25')
  assert.deepEqual([...s].sort(), ['2026-10-18', '2026-10-19', '2026-10-20'])
  assert.equal(nuitsFermees([], '2026-10-01', '2026-10-31').size, 0)
  const deux = nuitsFermees([fermeture(), fermeture({ id: 'f2', date_debut: '2026-10-19', date_fin: '2026-10-22' })], '2026-10-01', '2026-10-31')
  assert.equal(deux.size, 11, 'du 12 au 22, sans doublon')
})

// ─── 3. La scission (arbitrage B) ───────────────────────────────────────────
test('LE TEST QUI COMPTE : une reouverture SCINDE — le dernier geste gagne', () => {
  const f = fermeture()
  assert.deepEqual(scinder(f, ['2026-10-15']), [
    { date_debut: '2026-10-12', date_fin: '2026-10-14' }, { date_debut: '2026-10-16', date_fin: '2026-10-20' }])
  assert.deepEqual(scinder(f, ['2026-10-12']), [{ date_debut: '2026-10-13', date_fin: '2026-10-20' }], 'rouvrir le premier jour raccourcit')
  assert.deepEqual(scinder(f, ['2026-10-20']), [{ date_debut: '2026-10-12', date_fin: '2026-10-19' }], 'rouvrir le dernier aussi')
  assert.deepEqual(scinder(f, ['2026-10-14', '2026-10-15', '2026-10-16']), [
    { date_debut: '2026-10-12', date_fin: '2026-10-13' }, { date_debut: '2026-10-17', date_fin: '2026-10-20' }], 'plusieurs nuits contigues')
  assert.deepEqual(scinder(fermeture({ date_fin: '2026-10-12' }), ['2026-10-12']), [], 'une fermeture d un jour rouverte disparait')
  assert.deepEqual(scinder(f, ['2026-11-05']), [{ date_debut: '2026-10-12', date_fin: '2026-10-20' }], 'une nuit hors de la fermeture ne la touche pas')
  assert.deepEqual(scinder(f, ['n importe quoi']), [{ date_debut: '2026-10-12', date_fin: '2026-10-20' }], 'une date invalide est ignoree')
})

test('scinderAutour : retire l ancienne, recree les morceaux avec la MEME raison, sous le meme compte', async () => {
  const sb = fausseBase([fermeture()])
  const r = await scinderAutour(sb, { userId: COMPTE, propertyId: BIEN, nuitsRouvertes: ['2026-10-15'] })
  assert.equal(r.ok, true)
  assert.equal(r.touchees.length, 1)
  assert.deepEqual(r.touchees[0].rouvertes, ['2026-10-15'])
  assert.deepEqual(r.touchees[0].apres.map(m => [m.date_debut, m.date_fin]), [['2026-10-12', '2026-10-14'], ['2026-10-16', '2026-10-20']])
  const del = sb.journal.find(j => j.op === 'delete')
  assert.ok(del.f.some(([c, v]) => c === 'user_id' && v === COMPTE), 'le compte est dans le WHERE du delete')
  assert.ok(del.f.some(([c, v]) => c === 'property_id' && v === BIEN), 'et le bien')
  const ins = sb.journal.filter(j => j.op === 'insert')
  assert.equal(ins.length, 2)
  assert.ok(ins.every(i => i.ligne.raison === 'travaux' && i.ligne.user_id === COMPTE), 'la raison suit les morceaux')
})

test('scinderAutour sans fermeture touchee ne fait RIEN en base', async () => {
  const sb = fausseBase([fermeture()])
  const r = await scinderAutour(sb, { userId: COMPTE, propertyId: BIEN, nuitsRouvertes: ['2026-11-05'] })
  assert.equal(r.ok, true); assert.equal(r.touchees.length, 0)
  assert.ok(sb.journal.every(j => j.op === 'select'), 'lecture seule')
  const r2 = await scinderAutour(sb, { userId: COMPTE, propertyId: BIEN, nuitsRouvertes: [] })
  assert.deepEqual(r2, { ok: true, touchees: [] })
})

// ─── 4. Le retrait ──────────────────────────────────────────────────────────
test('supprimer rend le segment de REOUVERTURE, cloisonne au compte et au bien', async () => {
  const sb = fausseBase([fermeture()])
  const r = await supprimerFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.segments, [{ date_from: '2026-10-12', date_to: '2026-10-20', stop_sell: false }])
  const del = sb.journal.find(j => j.op === 'delete')
  assert.ok(del.f.some(([c]) => c === 'user_id') && del.f.some(([c]) => c === 'property_id'))
})

test('supprimer une fermeture d un AUTRE compte ne trouve rien, et le dit', async () => {
  const sb = fausseBase([fermeture({ user_id: '99999999-9999-4999-8999-999999999999' })])
  const r = await supprimerFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1 })
  assert.equal(r.ok, false); assert.equal(r.raison, 'introuvable')
})

// ─── 5. Correctifs de review ────────────────────────────────────────────────
test('LE TEST QUI COMPTE : deux fermetures ne se CHEVAUCHENT jamais — la seconde est refusee, sans ecriture', async () => {
  // Sinon retirer l'une rouvrait des nuits que l'autre dit fermees : l'objet
  // et la memoire en desaccord, dans le sens interdit.
  const sb = fausseBase([fermeture()])
  const r = await creerFermeture(sb, { userId: COMPTE, propertyId: BIEN, debut: '2026-10-18', fin: '2026-10-25', raison: 'perso' })
  assert.equal(r.ok, false); assert.equal(r.raison, 'chevauchement')
  assert.match(r.message, /2026-10-12 au 2026-10-20/)
  assert.ok(sb.journal.every(j => j.op === 'select'), 'rien n est ecrit')
  // Le lendemain de la fin, c'est libre : les bornes sont incluses, pas plus.
  const r2 = await creerFermeture(sb, { userId: COMPTE, propertyId: BIEN, debut: '2026-10-21', fin: '2026-10-25', raison: 'perso' })
  assert.equal(r2.ok, true)
})

test('une lecture en echec AVANT de creer refuse, et le dit — on ne cree pas a l aveugle', async () => {
  const sb = fausseBase([], { erreur: { message: 'timeout' } })
  const r = await creerFermeture(sb, { userId: COMPTE, propertyId: BIEN, debut: '2026-10-12', fin: '2026-10-20', raison: 'x' })
  assert.equal(r.ok, false); assert.equal(r.raison, 'lecture_impossible')
})

test('une fermeture trop longue est refusee — on ne tronque pas', async () => {
  const sb = fausseBase()
  const r = await creerFermeture(sb, { userId: COMPTE, propertyId: BIEN, debut: '2026-01-01', fin: '2999-12-31', raison: 'x' })
  assert.equal(r.ok, false); assert.equal(r.raison, 'periode_trop_longue')
  assert.equal(sb.journal.length, 0)
  const ok = await creerFermeture(sb, { userId: COMPTE, propertyId: BIEN, debut: '2026-01-01', fin: '2028-09-26', raison: 'x' })
  assert.equal(ok.ok, true, `${NUITS_MAX} nuits exactement passent`)
})

test('LE TEST QUI COMPTE : scinderAutour INSERE les morceaux AVANT de retirer l ancienne', () => {
  // Sans transaction, l'ordre inverse laissait sur un insert en echec une
  // fermeture disparue : nuits fermees en memoire, sans objet — rouvrables.
  return (async () => {
    const sb = fausseBase([fermeture()])
    await scinderAutour(sb, { userId: COMPTE, propertyId: BIEN, nuitsRouvertes: ['2026-10-15'] })
    const ops = sb.journal.map(j => j.op).filter(o => o !== 'select')
    assert.deepEqual(ops, ['insert', 'insert', 'delete'])
  })()
})

test('la lecture ne rapporte JAMAIS user_id : ces lignes partent telles quelles au calendrier', async () => {
  const sb = fausseBase([fermeture()])
  await fermeturesDuBien(sb, BIEN, '2026-10-01', '2026-10-31')
  await fermeturesDesBiens(sb, [BIEN], '2026-10-01', '2026-10-31')
  for (const j of sb.journal) assert.ok(!/user_id/.test(j.cols), `colonnes lues : ${j.cols}`)
})

test('fermeturesDesBiens : UNE requete, groupee par bien, chaque bien a sa cle meme vide', async () => {
  const AUTRE = '44444444-4444-4444-8444-444444444444'
  const sb = fausseBase([fermeture(), fermeture({ id: 'f2', property_id: AUTRE, date_debut: '2026-10-01', date_fin: '2026-10-02' })])
  const r = await fermeturesDesBiens(sb, [BIEN, AUTRE, '55555555-5555-4555-8555-555555555555'], '2026-10-10', '2026-10-31')
  assert.equal(sb.journal.length, 1, 'une seule requete')
  assert.deepEqual(sb.journal[0].dans[0], 'property_id')
  assert.equal(r[BIEN].length, 1); assert.deepEqual(r[AUTRE], [], 'hors periode'); assert.deepEqual(r['55555555-5555-4555-8555-555555555555'], [])
  await assert.rejects(() => fermeturesDesBiens(sb, [BIEN, 'pas-un-uuid'], '2026-10-01', '2026-10-31'), /uuid/)
})
