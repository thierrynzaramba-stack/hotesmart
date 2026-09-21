// tests/fermetures.test.js — lot 4.6.2, LES FERMETURES DE L'HOTE.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter §4-§5, §7-A, §7-B.
//
// CE QUE CES TESTS DEFENDENT, dans l'ordre d'importance :
//   1. une fermeture n'est PAS une seconde source de verite : ce module rend
//      des segments, il n'ecrit jamais calendar_inventory ;
//   2. une fermeture ne change que par la main de l'hote (modifier) ;
//   3. une lecture en echec LEVE : un vide par erreur ferait OUVRIR ;
//   4. le cloisonnement est dans le WHERE, pas seulement dans la garde.
//
// ⚠ CES TESTS EXECUTENT le module avec un faux supabase qui enregistre chaque
// requete. Un test qui lirait la source ne verrait pas ce qu'il fait.

const test = require('node:test')
const assert = require('node:assert')
const {
  fermeturesDuBien, fermeturesDesBiens, nuitsFermees, creerFermeture, modifierFermeture, supprimerFermeture, plagesDepuisNuits, NUITS_MAX
} = require('../lib/fermetures')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const BIEN = '22222222-2222-4222-8222-222222222222'
const F1 = '33333333-3333-4333-8333-333333333333'

// Faux client : ne sert QUE la table `fermetures`, enregistre tout.
function fausseBase (lignes = [], { erreur = null, erreurPour = {} } = {}) {
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
      q.update = (row) => { q.op = 'update'; q.ligne = row; return q }
      q.delete = () => { q.op = 'delete'; return q }
      q.single = () => q
      q.maybeSingle = () => { q.unSeul = true; return q }
      const executer = () => {
        journal.push({ op: q.op, f: q.f, ligne: q.ligne, lte: q.lte, gte: q.gte, cols: q.cols, dans: q.dans })
        if (erreur) return { data: null, error: erreur }
        if (erreurPour[q.op]) return { data: null, error: erreurPour[q.op] }
        if (q.op === 'insert') return { data: { id: 'neuf-' + journal.length, ...q.ligne }, error: null }
        if (q.op === 'update') {
          const cible = lignes.filter(l => q.f.every(([c, v]) => String(l[c]) === String(v)))
          for (const l of cible) Object.assign(l, q.ligne)   // comme la base : la ligne change
          return { data: cible[0] || null, error: null }
        }
        if (q.op === 'delete') {
          const cible = lignes.filter(l => q.f.every(([c, v]) => String(l[c]) === String(v)))
          for (const l of cible) lignes.splice(lignes.indexOf(l), 1)   // comme la base : retiree
          return { data: cible, error: null }
        }
        // select : croisement de periode + filtres eq + in
        let out = lignes.filter(l => q.f.every(([c, v]) => String(l[c]) === String(v)))
        if (q.dans) out = out.filter(l => q.dans[1].includes(l[q.dans[0]]))
        if (q.unSeul) return { data: out[0] || null, error: null }
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

// ─── 6. Correctifs de re-review ─────────────────────────────────────────────
test('une date qui a la forme mais n existe pas (30 fevrier) est une periode INVALIDE, pas une panne', async () => {
  const sb = fausseBase()
  const r = await creerFermeture(sb, { userId: COMPTE, propertyId: BIEN, debut: '2026-02-30', fin: '2026-03-02', raison: 'x' })
  assert.equal(r.ok, false); assert.equal(r.raison, 'periode_invalide')
  assert.equal(sb.journal.length, 0, 'rien n est parti en base — surtout pas une lecture qui echouerait en 503')
  await assert.rejects(() => fermeturesDuBien(sb, BIEN, '2026-02-30', '2026-03-02'), /periode invalide/)
})

test('LE TEST QUI COMPTE : sous concurrence, c est la base qui refuse le chevauchement — et on le dit pareil', async () => {
  // Deux onglets passent tous deux la lecture vide ; le second insert heurte la
  // contrainte d'exclusion (23P01). Ce n'est pas une panne : c'est un
  // chevauchement, dit par la base.
  // Par le CODE seul (PostgREST le rend toujours) et par le MESSAGE seul (un
  // client qui ne rend pas le code) : les deux chemins disent « chevauchement ».
  for (const err of [{ code: '23P01', message: 'conflicting key value' },
                     { message: 'violates exclusion constraint "fermetures_sans_chevauchement"' }]) {
    const sb = fausseBase([], { erreurPour: { insert: err } })
    const r = await creerFermeture(sb, { userId: COMPTE, propertyId: BIEN, debut: '2026-10-12', fin: '2026-10-20', raison: 'x' })
    assert.equal(r.ok, false); assert.equal(r.raison, 'chevauchement', JSON.stringify(err))
  }
  // Une autre erreur d'ecriture reste une panne, pas un chevauchement.
  const sb2 = fausseBase([], { erreurPour: { insert: { code: '57014', message: 'canceling statement' } } })
  assert.equal((await creerFermeture(sb2, { userId: COMPTE, propertyId: BIEN, debut: '2026-10-12', fin: '2026-10-20', raison: 'x' })).raison, 'ecriture_impossible')
})

test('LE TEST QUI COMPTE : retirer une fermeture ne rouvre QUE ce qu aucune autre ne couvre', async () => {
  // Un doublon laisse par une scission dont le DELETE a echoue : retirer l'un
  // des jumeaux ne doit pas rouvrir des nuits que l'autre dit fermees.
  const F2 = '66666666-6666-4666-8666-666666666666'
  const sb = fausseBase([fermeture(), fermeture({ id: F2, date_debut: '2026-10-15', date_fin: '2026-10-25', raison: 'perso' })])
  const r = await supprimerFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.segments, [{ date_from: '2026-10-12', date_to: '2026-10-14', stop_sell: false }], 'seules 12-14 rouvrent')
  assert.match(r.avertissement, /6 nuit\(s\) restent fermées/)
  // Retirer la seconde rouvre le reste : l'etat se repare par le geste normal.
  const r2 = await supprimerFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F2 })
  assert.deepEqual(r2.segments, [{ date_from: '2026-10-15', date_to: '2026-10-25', stop_sell: false }])
  assert.equal(r2.avertissement, undefined)
})

test('retirer avec une relecture en echec ne rouvre RIEN, et le dit', async () => {
  const sb = fausseBase([fermeture()], { erreurPour: { select: { message: 'timeout' } } })
  const r = await supprimerFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1 })
  assert.equal(r.ok, true); assert.deepEqual(r.segments, []); assert.match(r.avertissement, /pas été rouverte/)
})

test('nuitsFermees ne TRONQUE jamais : une fermeture plus longue que la borne rend toutes ses nuits', () => {
  // Une nuit absente du Set est une nuit que le canal interne peut ouvrir.
  const longue = fermeture({ date_debut: '2026-01-01', date_fin: '2030-01-01' })   // 1462 nuits > NUITS_MAX
  assert.equal(nuitsFermees([longue], '2026-01-01', '2030-01-01').size, 1462)
  assert.ok(nuitsFermees([longue], '2029-12-01', '2030-01-01').has('2030-01-01'))
})

test('LE TEST QUI COMPTE : la table ABSENTE rend « aucune fermeture », une PANNE leve — ce sont deux choses', async () => {
  // Staging, 21 septembre 2026 : deploye avant la migration, tout le radar
  // yield repondait 500. Une table qui n'existe pas ne contient aucune
  // fermeture : vide est exact. Un timeout, lui, ouvrirait a tort : il leve.
  const absente = { code: 'PGRST205', message: "Could not find the table 'public.fermetures' in the schema cache" }
  assert.deepEqual(await fermeturesDuBien(fausseBase([], { erreur: absente }), BIEN, '2026-10-01', '2026-10-31'), [])
  const parBien = await fermeturesDesBiens(fausseBase([], { erreur: { code: '42P01', message: 'relation "public.fermetures" does not exist' } }), [BIEN], '2026-10-01', '2026-10-31')
  assert.deepEqual(parBien, { [BIEN]: [] })
  await assert.rejects(() => fermeturesDuBien(fausseBase([], { erreur: { code: '57014', message: 'canceling statement due to statement timeout' } }), BIEN, '2026-10-01', '2026-10-31'), /lecture : canceling/)
  // Une relation absente qui n'est PAS la notre (une jointure cassee) reste une panne.
  await assert.rejects(() => fermeturesDuBien(fausseBase([], { erreur: { message: 'relation "autre" does not exist' } }), BIEN, '2026-10-01', '2026-10-31'), /lecture/)
})

// ─── 7. Modifier : le SEUL chemin par lequel une fermeture change ──────────
test('LE TEST QUI COMPTE : modifier les dates ferme les nuits ajoutees et rouvre les nuits retirees — par des segments', async () => {
  // 12-20 devient 15-25 : 21-25 se ferment, 12-14 rouvrent. Le module rend
  // les segments ; la porte ecrit par le writer. Aucune app ne passe ici.
  const sb = fausseBase([fermeture()])
  const r = await modifierFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1, debut: '2026-10-15', fin: '2026-10-25', raison: '  travaux prolongés ' })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.fermeture.raison, 'travaux prolongés')
  assert.deepEqual(r.segments, [
    { date_from: '2026-10-21', date_to: '2026-10-25', stop_sell: true },
    { date_from: '2026-10-12', date_to: '2026-10-14', stop_sell: false }
  ])
  const maj = sb.journal.find(j => j.op === 'update')
  assert.ok(maj.f.some(([c, v]) => c === 'user_id' && v === COMPTE) && maj.f.some(([c, v]) => c === 'property_id' && v === BIEN), 'cloisonne dans le WHERE')
  assert.ok(!sb.journal.some(j => j.op === 'insert' || j.op === 'delete'), 'un update, jamais un objet de plus ni de moins')
})

test('modifier seulement la raison ne touche AUCUNE nuit', async () => {
  const sb = fausseBase([fermeture()])
  const r = await modifierFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1, debut: '2026-10-12', fin: '2026-10-20', raison: 'autre raison' })
  assert.equal(r.ok, true); assert.deepEqual(r.segments, [])
})

test('modifier : introuvable, chevauchement avec une AUTRE, raison vide, periode a l envers — refuses sans ecriture', async () => {
  const F2 = '66666666-6666-4666-8666-666666666666'
  const sb = fausseBase([fermeture(), fermeture({ id: F2, date_debut: '2026-11-01', date_fin: '2026-11-05', raison: 'perso' })])
  assert.equal((await modifierFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: '77777777-7777-4777-8777-777777777777', debut: '2026-10-12', fin: '2026-10-20', raison: 'x' })).raison, 'introuvable')
  assert.equal((await modifierFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1, debut: '2026-10-12', fin: '2026-11-02', raison: 'x' })).raison, 'chevauchement')
  assert.equal((await modifierFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1, debut: '2026-10-12', fin: '2026-10-20', raison: '  ' })).raison, 'raison_manquante')
  assert.equal((await modifierFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1, debut: '2026-10-20', fin: '2026-10-12', raison: 'x' })).raison, 'periode_invalide')
  // Etendre jusqu'au 31 octobre ne croise pas le 1er novembre : les bornes sont incluses, pas plus.
  assert.equal((await modifierFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1, debut: '2026-10-12', fin: '2026-10-31', raison: 'x' })).ok, true)
  assert.ok(!sb.journal.some(j => j.op === 'update' && j.ligne.date_fin === '2026-11-02'), 'le chevauchement n a rien ecrit')
})

test('modifier : une nuit retiree encore couverte par une autre fermeture ne rouvre pas', async () => {
  const F2 = '66666666-6666-4666-8666-666666666666'
  // (etat de doublon impossible par la contrainte, mais le module ne s'y fie pas)
  const sb = fausseBase([fermeture(), fermeture({ id: F2, date_debut: '2026-10-12', date_fin: '2026-10-13', raison: 'perso' })])
  const r = await modifierFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1, debut: '2026-10-15', fin: '2026-10-20', raison: 'x' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.segments, [{ date_from: '2026-10-14', date_to: '2026-10-14', stop_sell: false }])
  assert.match(r.avertissement, /2 nuit\(s\) restent fermées/)
})

test('modifier : la contrainte d exclusion (23P01) sous concurrence est rendue « chevauchement »', async () => {
  const sb = fausseBase([fermeture()], { erreurPour: { update: { code: '23P01', message: 'conflicting key value' } } })
  const r = await modifierFermeture(sb, { userId: COMPTE, propertyId: BIEN, id: F1, debut: '2026-10-12', fin: '2026-10-25', raison: 'x' })
  assert.equal(r.ok, false); assert.equal(r.raison, 'chevauchement')
})

test('plagesDepuisNuits : des jours epars en plages contigues, tries, sans doublon', () => {
  assert.deepEqual(plagesDepuisNuits(['2026-10-14', '2026-10-12', '2026-10-13', '2026-10-20', '2026-10-13']),
    [{ date_from: '2026-10-12', date_to: '2026-10-14' }, { date_from: '2026-10-20', date_to: '2026-10-20' }])
  assert.deepEqual(plagesDepuisNuits([]), [])
})
