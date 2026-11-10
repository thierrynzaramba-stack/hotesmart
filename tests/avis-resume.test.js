// tests/avis-resume.test.js — le writer unique de `resume_bien_avis`.
// Spec : docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md §10.
//
// ⚠ LES CHIFFRES SONT ECRITS EN CLAIR, ET LA PARITE EST MESUREE A PART. Le
// writer importe les regles de `ratioProprete` et `notesDuPerimetre` ; un test
// qui ne ferait que les comparer entre eux prouverait une identite de
// structure, pas un comptage juste. Les deux existent ici.
//
// ⚠ LE TEMPS EST INJECTE (`maintenant: T0`) : les dates des fixtures sont donc
// FIGEES, et c'est la regle du depot — elles ne glissent pas avec l'horloge.

const test = require('node:test')
const assert = require('node:assert')
const { calculerResumeAvis, MOTIF_INCOMPLET } = require('../lib/avis/resume')
const { ratioProprete, notesDuPerimetre, PERIODES } = require('../lib/stats-avis')
const { arrondiDixiemes, MICRO } = require('../lib/avis/echelle')
const FAUX = require('./faux-postgrest')

const T0 = Date.parse('2026-11-10T12:00:00Z')
const JOUR = 24 * 3600 * 1000
const ilYa = (j) => new Date(T0 - j * JOUR).toISOString()
const U = 'compte-1'

// ─── Le double ──────────────────────────────────────────────────────────────
// ⚠ IL HONORE TOUT CE QUE LE WRITER ET LES DEUX FONCTIONS DE L'ECRAN EMETTENT,
// et il REFUSE le reste : `range()` leve (la lecture pagine par curseur), une
// table inconnue leve, un `or()` inconnu leve (tests/faux-postgrest.js).
// `maxRows` imite `db-max-rows` : une page plus courte que demandee alors que
// le compte exact dit qu'il en reste.
function fauxBase ({ avis = [], biens = [], existantes = [], pannes = {}, maxRows = Infinity } = {}) {
  const journal = []
  const resume = existantes.map(l => ({ ...l }))
  const rpcs = []
  const cmpTexte = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)
  const sb = {
    journal, resume, rpcs,
    from (table) {
      const source = table === 'ota_reviews' ? avis : table === 'properties' ? biens : null
      if (!source) throw new Error('faux : table inattendue ' + table)
      const appel = { table, eqs: [], ins: [], gts: [], gtes: [], ors: [], nonNuls: [], tris: [], head: false, count: null, limite: null }
      journal.push(appel)
      const retenues = () => {
        const out = source.filter(l =>
          appel.eqs.every(([c, v]) => l[c] === v) &&
          appel.ins.every(([c, vs]) => vs.includes(String(l[c]))) &&
          // `gt` sert au CURSEUR (texte) et au filtre `overall_score > 0`
          // (numerique) ; `NULL > x` vaut NULL, donc faux.
          appel.gts.every(([c, v]) => l[c] != null && (typeof v === 'number'
            ? Number.isFinite(Number(l[c])) && Number(l[c]) > v
            : cmpTexte(l[c], v) > 0)) &&
          appel.gtes.every(([c, v]) => l[c] != null && Date.parse(l[c]) >= Date.parse(v)) &&
          appel.nonNuls.every(c => l[c] != null) &&
          appel.ors.every(e => FAUX.evaluerOr(l, e)))
        for (const [c, asc] of [...appel.tris].reverse()) {
          out.sort((x, y) => (asc ? 1 : -1) * cmpTexte(x[c], y[c]))
        }
        return out
      }
      const repondre = () => {
        if (pannes[table]) return { data: null, count: null, error: pannes[table] }
        const tous = retenues()
        const n = Math.min(appel.limite == null ? Infinity : appel.limite, maxRows)
        return {
          data: appel.head ? null : tous.slice(0, n),
          count: appel.count === 'exact' ? tous.length : null,
          error: null
        }
      }
      const chain = {
        select (cols, opts) { appel.select = cols; appel.head = !!(opts && opts.head); appel.count = opts && opts.count; return chain },
        eq (c, v) { appel.eqs.push([c, v]); return chain },
        neq () { throw new Error('faux : neq non modelise') },
        in (c, vs) { appel.ins.push([c, (vs || []).map(String)]); return chain },
        gt (c, v) { appel.gts.push([c, v]); return chain },
        gte (c, v) { appel.gtes.push([c, v]); return chain },
        or (e) { appel.ors.push(String(e)); return chain },
        not (c, op, v) {
          if (op !== 'is' || v !== null) throw new Error('faux : not non modelise')
          appel.nonNuls.push(c); return chain
        },
        order (c, opts) { appel.tris.push([c, !(opts && opts.ascending === false)]); return chain },
        range () { throw new Error('faux : range() refuse — la lecture pagine par curseur') },
        limit (n) { appel.limite = n; return Promise.resolve(repondre()) },
        then (ok, ko) { return Promise.resolve(repondre()).then(ok, ko) }
      }
      return chain
    },
    // La semantique de `resume_bien_avis_remplacer` (la migration), contrainte
    // `resume_complet` comprise : un double qui accepterait un zero avec motif
    // laisserait passer le defaut que la contrainte existe pour refuser.
    async rpc (nom, p) {
      rpcs.push({ nom, p })
      if (nom !== 'resume_bien_avis_remplacer') throw new Error('faux : rpc inattendue ' + nom)
      if (pannes.rpc) return { data: null, error: pannes.rpc }
      const siennes = resume.filter(l => l.user_id === p.p_user_id)
      const plusRecent = siennes.map(l => Date.parse(l.calcule_le)).reduce((a, b) => Math.max(a, b), -Infinity)
      if (plusRecent > Date.parse(p.p_calcule_le)) return { data: { ecrit: false, motif: 'perime' }, error: null }
      const COMPTEURS = ['total', 'positif', 'remarque', 'rien_signale', 'notes', 'notes_micro']
      for (const l of p.p_lignes) {
        const complet = l.motif_non_calculable == null && COMPTEURS.every(c => Number.isInteger(l[c]) && l[c] >= 0)
        const vide = l.motif_non_calculable != null && COMPTEURS.every(c => l[c] == null)
        if (!complet && !vide) return { data: null, error: { message: 'violates check constraint "resume_complet"' } }
        if (!PERIODES.hasOwnProperty(l.periode)) return { data: null, error: { message: 'violates check constraint "resume_periode"' } }
      }
      for (let i = resume.length - 1; i >= 0; i--) if (resume[i].user_id === p.p_user_id) resume.splice(i, 1)
      for (const l of p.p_lignes) resume.push({ ...l, user_id: p.p_user_id, calcule_le: p.p_calcule_le })
      return { data: { ecrit: true, lignes: p.p_lignes.length }, error: null }
    }
  }
  return sb
}

// Un avis du compte, confirme, visible, avec une note et un texte. Chaque test
// ecrit ce qui le distingue — jamais un defaut du double.
let seq = 0
const A = (o = {}) => ({
  id: 'a' + String(++seq).padStart(6, '0'), user_id: U, statut: 'confirme', is_hidden: false,
  ota: 'airbnb', overall_score: 10, content: 'Super séjour', content_public: null,
  property_id_ref: 'R1', ai_clean_verdict: 'positif', received_at: ilYa(3), ...o
})
const B = (ref, o = {}) => ({ id: 'p-' + ref, user_id: U, provider_property_id: ref, ...o })

const ligne = (resultat, ref, periode) => resultat.lignes.find(l => l.property_id_ref === ref && l.periode === periode)
const sansAlarme = async () => {}

// ─── La population ──────────────────────────────────────────────────────────
test('ne comptent que les avis confirmés, visibles, où le voyageur a écrit', async () => {
  const sb = fauxBase({
    biens: [B('R1')],
    avis: [
      A({ overall_score: 10 }),                                          // compte, note 5,0
      A({ overall_score: null, content: 'Texte seul', ai_clean_verdict: 'remarque' }), // compte, sans note
      A({ statut: 'detecte' }),                                          // detection en attente : non
      A({ statut: 'ignore' }),                                           // ecartee : non
      A({ is_hidden: true }),                                            // masque par Airbnb : non
      A({ overall_score: 0, content: '', content_public: '' }),          // objet vide : non
      A({ overall_score: null, content: null, content_public: 'Public' }), // texte public : oui
      A({ user_id: 'autre-compte' })                                     // un autre compte : jamais
    ]
  })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
  assert.strictEqual(r.ecrit, true)
  const l = ligne(r, 'R1', 'toujours')
  assert.strictEqual(l.total, 3)
  assert.strictEqual(l.notes, 1)
  assert.strictEqual(l.notes_micro, 5 * MICRO)
  assert.strictEqual(l.positif, 2)
  assert.strictEqual(l.remarque, 1)
  assert.strictEqual(l.rien_signale, 0)
  // Le filtre du compte part dans CHAQUE lecture : la cle de service contourne
  // la RLS, ce filtre est la seule defense.
  for (const a of sb.journal) assert.ok(a.eqs.some(([c, v]) => c === 'user_id' && v === U), a.table)
})

test('les quatre périodes : bornes sur received_at, un avis sans date seulement dans « toujours »', async () => {
  const sb = fauxBase({
    biens: [B('R1')],
    avis: [
      A({ received_at: ilYa(10) }),   // 15j, 30j, 6mois, toujours
      A({ received_at: ilYa(20) }),   // 30j, 6mois, toujours
      A({ received_at: ilYa(100) }),  // 6mois, toujours
      A({ received_at: ilYa(300) }),  // toujours
      A({ received_at: null })        // toujours seulement
    ]
  })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
  assert.deepStrictEqual(
    ['15j', '30j', '6mois', 'toujours'].map(p => ligne(r, 'R1', p).total),
    [1, 2, 3, 5])
  assert.deepStrictEqual(
    ['15j', '30j', '6mois', 'toujours'].map(p => ligne(r, 'R1', p).notes),
    [1, 2, 3, 5])
})

test('la note : somme en micro-unités sur 5, une source inconnue compte dans le total mais pas dans la note — et sonne', async () => {
  const alarmes = []
  const sb = fauxBase({
    biens: [B('R1')],
    avis: [
      A({ overall_score: 9 }),                      // 4,5 / 5
      A({ overall_score: 8, ota: 'booking' }),      // 4,0 / 5
      A({ overall_score: 4, ota: 'canal-inconnu' }) // ecartee de la note
    ]
  })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: async (code, d) => alarmes.push([code, d.sources]) })
  const l = ligne(r, 'R1', 'toujours')
  assert.strictEqual(l.total, 3)
  assert.strictEqual(l.notes, 2)
  assert.strictEqual(l.notes_micro, 8.5 * MICRO)
  assert.strictEqual(arrondiDixiemes(l.notes_micro, l.notes), 4.3)
  assert.deepStrictEqual(alarmes, [['avis_echelle_inconnue', ['canal-inconnu']]])
})

test('la propreté : un verdict absent ou inconnu compte dans le total, dans aucun pouce', async () => {
  const sb = fauxBase({
    biens: [B('R1')],
    avis: [
      A({ ai_clean_verdict: 'positif' }), A({ ai_clean_verdict: 'positif' }),
      A({ ai_clean_verdict: 'remarque' }), A({ ai_clean_verdict: 'rien_signale' }),
      A({ ai_clean_verdict: null }), A({ ai_clean_verdict: 'autre' })
    ]
  })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
  const l = ligne(r, 'R1', '30j')
  assert.deepStrictEqual([l.total, l.positif, l.remarque, l.rien_signale], [6, 2, 1, 1])
})

// ─── Les références ─────────────────────────────────────────────────────────
test('chaque bien a ses lignes, à zéro sans avis ; archivé compris ; orpheline comprise ; sans référence, aucune', async () => {
  const sb = fauxBase({
    biens: [B('R1'), B('R2'), B('R3', { archive_le: '2026-11-03T10:00:00Z' }), B(null, { id: 'p-sans-ref' })],
    avis: [A({ property_id_ref: 'R1' }), A({ property_id_ref: 'R3' }), A({ property_id_ref: 'ORPHELINE' })]
  })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
  const refs = [...new Set(r.lignes.map(l => l.property_id_ref))].sort()
  assert.deepStrictEqual(refs, ['ORPHELINE', 'R1', 'R2', 'R3'])
  assert.strictEqual(r.lignes.length, 4 * 4)
  const zero = ligne(r, 'R2', 'toujours')
  assert.deepStrictEqual(
    [zero.total, zero.notes, zero.notes_micro, zero.motif_non_calculable],
    [0, 0, 0, null])
  assert.strictEqual(ligne(r, 'R3', 'toujours').total, 1)
  assert.strictEqual(ligne(r, 'ORPHELINE', 'toujours').total, 1)
})

// ─── L'écriture ─────────────────────────────────────────────────────────────
test('le remplacement efface les références disparues et porte l\'heure de la LECTURE', async () => {
  const sb = fauxBase({
    biens: [B('R1')],
    avis: [A()],
    existantes: [{ user_id: U, periode: 'toujours', property_id_ref: 'DISPARUE', total: 9, positif: 9, remarque: 0,
                   rien_signale: 0, notes: 9, notes_micro: 45 * MICRO, motif_non_calculable: null, calcule_le: ilYa(1) },
                 { user_id: 'autre-compte', periode: 'toujours', property_id_ref: 'X', total: 1, positif: 1, remarque: 0,
                   rien_signale: 0, notes: 1, notes_micro: 5 * MICRO, motif_non_calculable: null, calcule_le: ilYa(1) }]
  })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
  assert.strictEqual(r.ecrit, true)
  assert.strictEqual(r.calcule_le, new Date(T0).toISOString())
  const miennes = sb.resume.filter(l => l.user_id === U)
  assert.deepStrictEqual([...new Set(miennes.map(l => l.property_id_ref))], ['R1'])
  assert.ok(miennes.every(l => l.calcule_le === new Date(T0).toISOString()))
  // L'autre compte n'est pas touche.
  assert.strictEqual(sb.resume.filter(l => l.user_id === 'autre-compte').length, 1)
  assert.strictEqual(sb.rpcs[0].p.p_user_id, U)
})

test('un calcul qui a LU plus tôt ne remplace pas un calcul qui a lu plus tard (périmé)', async () => {
  const plusTard = new Date(T0 + 60 * 1000).toISOString()
  const sb = fauxBase({
    biens: [B('R1')], avis: [A()],
    existantes: [{ user_id: U, periode: 'toujours', property_id_ref: 'R1', total: 2, positif: 2, remarque: 0,
                   rien_signale: 0, notes: 2, notes_micro: 10 * MICRO, motif_non_calculable: null, calcule_le: plusTard }]
  })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
  assert.strictEqual(r.ecrit, false)
  assert.strictEqual(r.motif, 'perime')
  assert.strictEqual(sb.resume[0].total, 2)
})

test('une lecture en panne n\'écrit rien et ne supprime rien', async () => {
  for (const table of ['ota_reviews', 'properties']) {
    const sb = fauxBase({
      biens: [B('R1')], avis: [A()], pannes: { [table]: { message: 'timeout' } },
      existantes: [{ user_id: U, periode: 'toujours', property_id_ref: 'R1', total: 7, positif: 7, remarque: 0,
                     rien_signale: 0, notes: 7, notes_micro: 35 * MICRO, motif_non_calculable: null, calcule_le: ilYa(1) }]
    })
    const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
    assert.strictEqual(r.ecrit, false, table)
    assert.ok(r.erreur, table)
    assert.strictEqual(sb.rpcs.length, 0, table)
    assert.strictEqual(sb.resume.length, 1, table)
    assert.strictEqual(sb.resume[0].total, 7, table)
  }
})

test('une écriture refusée par la base se dit', async () => {
  const sb = fauxBase({ biens: [B('R1')], avis: [A()], pannes: { rpc: { message: 'deadlock' } } })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
  assert.strictEqual(r.ecrit, false)
  assert.strictEqual(r.erreur, 'ecriture')
})

test('à blanc : calcule, n\'écrit pas', async () => {
  const sb = fauxBase({ biens: [B('R1')], avis: [A()] })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme, aBlanc: true })
  assert.strictEqual(r.aBlanc, true)
  assert.strictEqual(sb.rpcs.length, 0)
  assert.strictEqual(ligne(r, 'R1', 'toujours').total, 1)
})

test('sans compte, il refuse au lieu de tout lire', async () => {
  await assert.rejects(() => calculerResumeAvis(fauxBase(), { maintenant: T0 }), /userId requis/)
})

// ─── La pagination ──────────────────────────────────────────────────────────
test('plus de 1000 avis : pagination par curseur, rien de perdu, rien de compté deux fois', async () => {
  const avis = []
  for (let i = 0; i < 2345; i++) avis.push(A({ property_id_ref: i % 2 ? 'R1' : 'R2' }))
  const sb = fauxBase({ biens: [B('R1'), B('R2')], avis })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
  assert.strictEqual(ligne(r, 'R1', 'toujours').total + ligne(r, 'R2', 'toujours').total, 2345)
  const lectures = sb.journal.filter(a => a.table === 'ota_reviews')
  assert.strictEqual(lectures.length, 3)
  assert.ok(lectures.every(a => a.tris.length && a.tris[0][0] === 'id' && a.tris[0][1] === true))
  assert.strictEqual(lectures[0].gts.length, 0)
  assert.ok(lectures.slice(1).every(a => a.gts.length === 1 && a.gts[0][0] === 'id'))
})

test('une lecture rognée (db-max-rows) s\'écrit en null avec son motif — jamais un zéro', async () => {
  const avis = []
  for (let i = 0; i < 1500; i++) avis.push(A())
  const sb = fauxBase({ biens: [B('R1'), B('R2')], avis, maxRows: 900 })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
  assert.strictEqual(r.ecrit, true)
  assert.strictEqual(r.incomplet, true)
  assert.strictEqual(r.lignes.length, 2 * 4)
  for (const l of r.lignes) {
    assert.strictEqual(l.motif_non_calculable, MOTIF_INCOMPLET)
    for (const c of ['total', 'positif', 'remarque', 'rien_signale', 'notes', 'notes_micro']) assert.strictEqual(l[c], null, c)
  }
})

// ─── La parité avec le calcul d'aujourd'hui ─────────────────────────────────
// Le meme jeu, lu par le writer et par les deux fonctions qui servent l'ecran
// aujourd'hui. La somme des lignes d'un perimetre doit rendre leurs chiffres :
// tout le compte, chaque bien, et un sous-ensemble (un membre limite).
test('parité : la somme des lignes rend ratioProprete et notesDuPerimetre, pour tout périmètre et toute période', async () => {
  const avis = []
  const refs = ['R1', 'R2', 'R3', 'ORPHELINE']
  const verdicts = ['positif', 'remarque', 'rien_signale', null]
  const otas = ['airbnb', 'booking', 'airbnb', 'canal-inconnu']
  for (let i = 0; i < 160; i++) {
    avis.push(A({
      property_id_ref: refs[i % 4],
      ai_clean_verdict: verdicts[(i * 7) % 4],
      ota: otas[(i * 3) % 4],
      overall_score: i % 9 === 0 ? null : 5 + (i % 6),
      content: i % 9 === 0 ? 'Texte' : 'ok',
      received_at: i % 23 === 0 ? null : ilYa((i * 5) % 250),
      statut: i % 31 === 0 ? 'detecte' : 'confirme',
      is_hidden: i % 37 === 0
    }))
  }
  const sb = fauxBase({ biens: [B('R1'), B('R2'), B('R3')], avis })
  const r = await calculerResumeAvis(sb, { userId: U, maintenant: T0, alarme: sansAlarme })
  const perimetres = [null, ['R1'], ['R2'], ['ORPHELINE'], ['R1', 'R3']]
  for (const periode of Object.keys(PERIODES)) {
    for (const p of perimetres) {
      const lignes = r.lignes.filter(l => l.periode === periode && (p === null || p.includes(l.property_id_ref)))
      const somme = (c) => lignes.reduce((s, l) => s + l[c], 0)
      const ratio = await ratioProprete(sb, { userId: U, periode, refs: p, maintenant: T0 })
      const notes = await notesDuPerimetre(sb, { userId: U, periode, refs: p, maintenant: T0, alarme: sansAlarme })
      const qui = `${periode} ${p ? p.join('+') : 'tout'}`
      assert.strictEqual(somme('total'), ratio.total, qui)
      assert.strictEqual(somme('positif'), ratio.positif, qui)
      assert.strictEqual(somme('remarque'), ratio.remarque, qui)
      assert.strictEqual(somme('rien_signale'), ratio.rien_signale, qui)
      assert.strictEqual(somme('notes'), notes.global.notes, qui)
      assert.strictEqual(arrondiDixiemes(somme('notes_micro'), somme('notes')), notes.global.note_sur_5, qui)
      assert.ok(ratio.total > 0 || periode === '15j', qui + ' : le jeu doit compter quelque chose')
    }
  }
})
