// tests/prix-hote-survie.test.js — DETTE 22 : la main de l'hote survit a la
// desactivation du pilote, et sa vie se trace.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter ; registre docs/kb/dettes-v1.md.
//
// VECU (recette du 22 septembre 2026, piece 4) : deux prix de l'hote (150 € le
// 5 octobre, 120 € le 6 novembre) ont perdu leur marque par un aller-retour du
// bouton « activé / désactivé ». Le passage suivant du moteur les aurait
// ecrases. La base n'a pas su dire pourquoi : la cause n'a ete etablie que par
// deduction. Decision de Thierry, (a) : les marques survivent ; a la
// reactivation, chacune reprend le prix affiche au calendrier, et la
// confirmation dit « N nuits gardent votre prix ».
//
// CE QUE CES TESTS DEFENDENT :
//   1. desactiver n'efface rien ; reactiver recale sur le calendrier ;
//   2. un refus du writer DEFAIT la pose, il ne supprime pas la marque d'avant ;
//   3. chaque evenement laisse une trace, et une trace perdue ne bloque pas le
//      geste de l'hote mais se crie ;
//   4. l'ecran annonce le compte, et ne montre la main que sur un bien pilote.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { poserPrixHote, annulerPose, retirerPrixHote, purgerPrixHotePasses, recalerPrixHote, compterPrixHote } = require('../lib/prix-hote')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const BIEN = '22222222-2222-4222-8222-222222222222'
const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const sansCommentaires = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// Une base QUI GARDE SON ETAT : on verifie des transitions, pas des requetes.
function baseVivante (tables = {}, { pannes = {} } = {}) {
  const t = { prix_hote: [], prix_hote_journal: [], calendar_inventory: [], ...tables }
  const cle = { prix_hote: l => `${l.property_id}|${l.stay_date}` }
  return { t, from (table) {
    assert.ok(table in t, `table inattendue : ${table}`)
    const q = { op: 'select', f: [], opts: {} }
    const garde = l => q.f.every(([op, c, v]) =>
      op === 'eq' ? l[c] === v : op === 'in' ? v.includes(l[c]) : op === 'gte' ? l[c] >= v : op === 'lt' ? l[c] < v : true)
    q.select = (cols, o) => { q.opts = o || {}; return q }
    q.eq = (c, v) => { q.f.push(['eq', c, v]); return q }
    q.in = (c, v) => { q.f.push(['in', c, v]); return q }
    q.gte = (c, v) => { q.f.push(['gte', c, v]); return q }
    q.lt = (c, v) => { q.f.push(['lt', c, v]); return q }
    q.delete = () => { q.op = 'delete'; return q }
    q.insert = rows => { q.op = 'insert'; q.rows = rows; return q }
    q.upsert = rows => { q.op = 'upsert'; q.rows = rows; return q }
    q.update = champs => { q.op = 'update'; q.champs = champs; return q }
    q.then = (res, rej) => {
      const panne = pannes[table] && (pannes[table].op == null || pannes[table].op === q.op) ? pannes[table].erreur : null
      if (panne) return Promise.resolve({ data: null, error: panne, count: null }).then(res, rej)
      let data = null
      if (q.op === 'select') {
        data = t[table].filter(garde).map(l => ({ ...l }))
        if (q.opts.head) return Promise.resolve({ data: null, error: null, count: data.length }).then(res, rej)
      } else if (q.op === 'delete') {
        data = t[table].filter(garde).map(l => ({ ...l }))
        t[table] = t[table].filter(l => !garde(l))
      } else if (q.op === 'update') {
        data = []
        t[table] = t[table].map(l => { if (!garde(l)) return l; const n = { ...l, ...q.champs }; data.push({ ...n }); return n })
      } else if (q.op === 'insert') {
        t[table].push(...q.rows.map(r => ({ ...r })))
      } else if (q.op === 'upsert') {
        for (const r of q.rows) {
          const i = t[table].findIndex(l => cle[table](l) === cle[table](r))
          if (i >= 0) t[table][i] = { ...t[table][i], ...r }; else t[table].push({ ...r })
        }
      }
      return Promise.resolve({ data, error: null }).then(res, rej)
    }
    return q
  } }
}
const marque = (date, cents) => ({ user_id: COMPTE, property_id: BIEN, stay_date: date, rate_cents: cents })
const prixDe = sb => Object.fromEntries(sb.t.prix_hote.map(l => [l.stay_date, l.rate_cents]))
const traces = sb => sb.t.prix_hote_journal.map(l => [l.stay_date, l.evenement, l.geste, l.rate_cents_avant, l.rate_cents])

test('LE TEST QUI COMPTE : desactiver le pilote n efface plus la main de l hote — l endpoint n a plus de geste de vidage', () => {
  const src = sansCommentaires(lire('api/yield-pilote.js'))
  assert.ok(!/viderPrixHote/.test(src), 'plus aucun vidage au retour en calendrier')
  assert.ok(!/from\('prix_hote'\)/.test(src), 'et aucun acces direct a la table : le writer seul')
  assert.match(src, /if \(voulu === 'yieldflow' && actuel !== 'yieldflow'\) \{\n\s+const rc = await recalerPrixHote\(/, 'a la REACTIVATION, et seulement la, on recale')
  assert.ok(!/module\.exports\s*=\s*\{[^}]*viderPrixHote/.test(lire('lib/prix-hote.js')), 'la fonction de vidage n existe plus')
})

test('LE TEST QUI COMPTE : a la reactivation, chaque marque reprend le prix AFFICHE au calendrier ; une nuit sans prix garde la sienne ; le passe est purge', async () => {
  // La recette : 150 € et 120 € poses, puis l'hote, pilote desactive, passe
  // le 5 octobre a 170 € a la main dans le calendrier. Le 1er decembre n'a
  // plus de prix au calendrier : on ne remplace pas une decision par un vide.
  const sb = baseVivante({
    prix_hote: [marque('2026-09-01', 8000), marque('2026-10-05', 15000), marque('2026-11-06', 12000), marque('2026-12-01', 9000)],
    calendar_inventory: [
      { property_id: BIEN, date: '2026-10-05', rate: 170 },
      { property_id: BIEN, date: '2026-11-06', rate: 120 },
      { property_id: BIEN, date: '2026-12-01', rate: null }
    ]
  })
  const r = await recalerPrixHote(sb, { userId: COMPTE, propertyId: BIEN, aujourdHui: '2026-09-23' })
  assert.deepEqual(r, { ok: true, nuits: 3, recalees: 1 }, '3 nuits gardent votre prix, 1 recalee')
  assert.deepEqual(prixDe(sb), { '2026-10-05': 17000, '2026-11-06': 12000, '2026-12-01': 9000 }, 'le prix du calendrier est retenu ; le passe est parti')
  assert.deepEqual(traces(sb), [
    ['2026-09-01', 'purgee', 'nuit_passee', 8000, null],
    ['2026-10-05', 'recalee', 'reactivation_pilote', 15000, 17000]
  ], 'la purge et le recalage laissent chacun leur trace ; une marque inchangee n en laisse pas')
})

test('un recalage illisible le dit, et ne touche a rien', async () => {
  const sb = baseVivante({ prix_hote: [marque('2026-10-05', 15000)] }, { pannes: { calendar_inventory: { erreur: { code: '57014', message: 'timeout' } } } })
  const r = await recalerPrixHote(sb, { userId: COMPTE, propertyId: BIEN, aujourdHui: '2026-09-23' })
  assert.equal(r.ok, false); assert.equal(r.nuits, 1)
  assert.deepEqual(prixDe(sb), { '2026-10-05': 15000 }, 'la marque reste, a son ancien montant : elle protege toujours la nuit')
})

test('LE TEST QUI COMPTE : un refus du writer DEFAIT la pose — la marque d avant retrouve son prix, une marque neuve disparait', async () => {
  // Scenario : l'hote a « votre prix » a 150 € et saisit 5 € par erreur ;
  // le plancher refuse. L'ancien code RETIRAIT la marque : 150 € perdait sa
  // protection sans que l'hote l'ait touche.
  const sb = baseVivante({ prix_hote: [marque('2026-10-05', 15000)] })
  const nuits = [{ date: '2026-10-05', cents: 500 }, { date: '2026-10-06', cents: 500 }]
  const pose = await poserPrixHote(sb, { userId: COMPTE, propertyId: BIEN, nuits })
  assert.equal(pose.ok, true); assert.deepEqual([...pose.avant], [['2026-10-05', 15000]])
  assert.deepEqual(prixDe(sb), { '2026-10-05': 500, '2026-10-06': 500 })
  const a = await annulerPose(sb, { userId: COMPTE, propertyId: BIEN, nuits, avant: pose.avant })
  assert.equal(a.ok, true)
  assert.deepEqual(prixDe(sb), { '2026-10-05': 15000 }, '150 € revient ; la nuit neuve n a plus de marque')
  assert.deepEqual(traces(sb), [
    ['2026-10-05', 'remplacee', 'saisie_hote', 15000, 500],
    ['2026-10-06', 'posee', 'saisie_hote', null, 500],
    ['2026-10-05', 'annulee', 'refus_ecriture', 500, 15000],
    ['2026-10-06', 'annulee', 'refus_ecriture', 500, null]
  ])
})

test('api/calendar.js : un REFUS defait la pose ; une EXCEPTION du writer garde la marque (le prix est peut-etre deja ecrit)', () => {
  const src = sansCommentaires(lire('api/calendar.js'))
  const debut = src.indexOf('let pose = null')
  const bloc = debut < 0 ? '' : src.slice(debut, src.indexOf('if (r.refus) return res.status(r.refus.status).json(r.refus.body)', debut))
  assert.ok(bloc.length > 0, 'la borne existe')
  const leCatch = bloc.slice(bloc.indexOf('} catch (e) {'), bloc.indexOf('throw e'))
  assert.ok(leCatch.length > 0 && !/annulerPose|retirerPrixHote/.test(leCatch), 'le catch ne defait rien')
  assert.match(bloc, /if \(r\.refus && pose\) \{\n\s+const a = await annulerPose\(supabase, \{ userId: compte, propertyId: bienId, nuits: nuitsPrixHote, avant: pose\.avant \}\)/, 'le refus defait')
  assert.ok(/ANNULATION INCOMPLETE/.test(bloc), 'et une annulation incomplete se crie')
  assert.ok(!/retirerPrixHote/.test(bloc), 'plus de retrait aveugle')
})

test('poser sans pouvoir lire ce qu on remplace est refuse : l annulation serait aveugle', async () => {
  const sb = baseVivante({}, { pannes: { prix_hote: { op: 'select', erreur: { code: '57014', message: 'timeout' } } } })
  const r = await poserPrixHote(sb, { userId: COMPTE, propertyId: BIEN, nuits: [{ date: '2026-10-05', cents: 15000 }] })
  assert.equal(r.ok, false); assert.equal(r.raison, 'ecriture_impossible')
  assert.deepEqual(sb.t.prix_hote, [], 'rien n est pose')
})

test('retirer et purger laissent leur trace, avec le prix que la marque portait', async () => {
  const sb = baseVivante({ prix_hote: [marque('2026-09-20', 9000), marque('2026-10-05', 15000)] })
  await retirerPrixHote(sb, { userId: COMPTE, propertyId: BIEN, dates: ['2026-10-05'] })
  await purgerPrixHotePasses(sb, BIEN, '2026-09-23')
  assert.deepEqual(traces(sb), [
    ['2026-10-05', 'retiree', 'retrait_hote', 15000, null],
    ['2026-09-20', 'purgee', 'nuit_passee', 9000, null]
  ])
})

test('LE TEST QUI COMPTE : une trace perdue ne bloque pas le geste de l hote, mais se CRIE ; un journal absent se dit une fois', async () => {
  const cris = []
  const err = console.error, warn = console.warn
  console.error = (...a) => cris.push(['error', a.join(' ')]); console.warn = (...a) => cris.push(['warn', a.join(' ')])
  try {
    const panne = baseVivante({}, { pannes: { prix_hote_journal: { erreur: { code: '57014', message: 'timeout' } } } })
    const r = await poserPrixHote(panne, { userId: COMPTE, propertyId: BIEN, nuits: [{ date: '2026-10-05', cents: 15000 }] })
    assert.equal(r.ok, true, 'la marque est posee')
    assert.deepEqual(prixDe(panne), { '2026-10-05': 15000 })
    assert.ok(cris.some(([n, m]) => n === 'error' && /TRACE PERDUE/.test(m)), 'et la perte se crie')
    const absente = baseVivante({}, { pannes: { prix_hote_journal: { erreur: { code: 'PGRST205', message: "Could not find the table 'public.prix_hote_journal'" } } } })
    assert.equal((await poserPrixHote(absente, { userId: COMPTE, propertyId: BIEN, nuits: [{ date: '2026-10-06', cents: 15000 }] })).ok, true)
    assert.ok(cris.some(([n, m]) => n === 'warn' && /journal absent/.test(m)), 'une base sans la migration le dit')
  } finally { console.error = err; console.warn = warn }
})

test('le compte des nuits a venir : table absente = 0, panne = null (« je ne sais pas » n est pas « aucune »)', async () => {
  const sb = baseVivante({ prix_hote: [marque('2026-09-01', 8000), marque('2026-10-05', 15000), marque('2026-11-06', 12000)] })
  assert.equal(await compterPrixHote(sb, { userId: COMPTE, propertyId: BIEN, aujourdHui: '2026-09-23' }), 2)
  const absente = baseVivante({}, { pannes: { prix_hote: { erreur: { code: 'PGRST205', message: "Could not find the table 'public.prix_hote'" } } } })
  assert.equal(await compterPrixHote(absente, { userId: COMPTE, propertyId: BIEN, aujourdHui: '2026-09-23' }), 0)
  const err = console.error; console.error = () => {}
  try {
    const panne = baseVivante({}, { pannes: { prix_hote: { erreur: { code: '57014', message: 'timeout' } } } })
    assert.equal(await compterPrixHote(panne, { userId: COMPTE, propertyId: BIEN, aujourdHui: '2026-09-23' }), null)
  } finally { console.error = err }
})

test('l ecran annonce « N nuits gardent votre prix » dans les deux confirmations, et l API ne montre la main que sur un bien pilote', () => {
  const page = sansCommentaires(lire('apps/yield/prix.html'))
  assert.ok(page.includes("const phrasePrixHote = n => `${n} nuit${n > 1 ? 's' : ''} garde${n > 1 ? 'nt' : ''} votre prix YieldFlow`"), 'la phrase de la decision (a)')
  const conf = page.slice(page.indexOf('function confirmerBascule'), page.indexOf('const libelleFenetre'))
  const dem = page.slice(page.indexOf('function demanderFenetre'), page.indexOf('async function basculerPilote'))
  assert.ok(conf.includes('phrasePrixHote(nuitsPrixHote)'), 'desactiver le dit')
  assert.ok(dem.includes('phrasePrixHote(nuitsPrixHote)'), 'reactiver le dit')
  const charger = page.slice(page.indexOf('async function chargerPilote'), page.indexOf('function confirmerBascule'))
  assert.ok(charger.indexOf('nuitsPrixHote = null') < charger.indexOf('await fetch'), 'jamais le compte du logement precedent')
  assert.match(sansCommentaires(lire('api/yield-pilote.js')), /prix_hote: \{ nuits: nuitsPrixHote \}/, 'le GET porte le compte')
  assert.match(sansCommentaires(lire('api/yield-prix.js')), /if \(piloteDuBien\(bien\) === 'yieldflow'\) \{\n\s+try \{ prixHote = await prixHoteDuBien\(/, 'en mode calendrier, pas de « votre prix »')
})

test('la migration du journal : append-only, cloisonnee, lignes courtes pour le collage', () => {
  const sql = lire('migrations/2026-09-23-prix-hote-journal.sql')
  assert.ok(sql.split('\n').every(l => l.length < 60), 'lignes < 60 caracteres')
  assert.match(sql, /revoke insert, update, delete\n\s+on table public\.prix_hote_journal\n\s+from anon, authenticated;/)
  assert.match(sql, /using \(user_id = auth\.uid\(\)\)/)
  for (const e of ['posee', 'remplacee', 'retiree', 'annulee', 'recalee', 'purgee', 'saisie_hote', 'retrait_hote', 'refus_ecriture', 'reactivation_pilote', 'nuit_passee']) {
    assert.ok(sql.includes(`'${e}'`), `la contrainte connait ${e}`)
    assert.ok(lire('lib/prix-hote.js').includes(`'${e}'`), `et le writer aussi : ${e}`)
  }
})

test('LE TEST QUI COMPTE : annuler ne touche pas une marque reposee entre-temps par un autre onglet', async () => {
  // A pose 5 € (sa photo : 150 €), B pose 180 € par-dessus et passe le writer,
  // puis A est refuse. Restaurer 150 € sans condition ecrasait les 180 € de B.
  const sb = baseVivante({ prix_hote: [marque('2026-10-05', 15000)] })
  const nuitsA = [{ date: '2026-10-05', cents: 500 }]
  const poseA = await poserPrixHote(sb, { userId: COMPTE, propertyId: BIEN, nuits: nuitsA })
  await poserPrixHote(sb, { userId: COMPTE, propertyId: BIEN, nuits: [{ date: '2026-10-05', cents: 18000 }] })
  const a = await annulerPose(sb, { userId: COMPTE, propertyId: BIEN, nuits: nuitsA, avant: poseA.avant })
  assert.equal(a.ok, true)
  assert.deepEqual(prixDe(sb), { '2026-10-05': 18000 }, 'la marque de B reste')
  assert.ok(!traces(sb).some(([, e]) => e === 'annulee'), 'et rien n est trace comme annule : rien ne l a ete')
})

test('deux segments sur la meme nuit : une seule ligne, le dernier l emporte (plus de 503)', async () => {
  const sb = baseVivante()
  const r = await poserPrixHote(sb, { userId: COMPTE, propertyId: BIEN, nuits: [{ date: '2026-10-05', cents: 15000 }, { date: '2026-10-05', cents: 16000 }] })
  assert.equal(r.ok, true); assert.equal(r.posees, 1)
  assert.deepEqual(prixDe(sb), { '2026-10-05': 16000 })
})

test('LE TEST QUI COMPTE : a la reactivation, le recalage passe AVANT la bascule, et son echec REFUSE l activation', () => {
  // Apres la bascule, un tick du cron pouvait ouvrir une nuit marquee a
  // l'ancien montant ; le recalage relisait ce montant, le prix saisi pendant
  // la desactivation etait perdu. Avant, les marques sont inertes.
  const src = sansCommentaires(lire('api/yield-pilote.js'))
  const post = src.slice(src.indexOf("const actuel = piloteDuBien(bien)"))
  const iRecal = post.indexOf('await recalerPrixHote(')
  const iMaj = post.indexOf(".from('properties')\n    .update(maj)")
  const iMarq = post.indexOf('await effacerMarqueur(')
  assert.ok(iRecal > 0 && iMaj > 0 && iMarq > 0, 'les trois gestes existent')
  assert.ok(iRecal < iMaj && iMaj < iMarq, 'recaler, puis basculer, puis effacer le marqueur')
  assert.match(post, /if \(!rc\.ok\) \{[\s\S]{0,200}return res\.status\(503\)[\s\S]{0,300}code: 'prix_hote_illisibles'/, 'un recalage impossible refuse, sans basculer')
})
