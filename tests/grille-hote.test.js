// tests/grille-hote.test.js — lot 4.6.7, LA GRILLE FIXEE PAR L'HOTE
// (decisions de Thierry du 30 septembre 2026).
//
// CE QU'ILS DEFENDENT, dans l'ordre d'importance :
//   1. un niveau fixe remplace le MONTANT, jamais le positionnement : aucun
//      contexte ne change de niveau ; et les ajustements (jour de semaine,
//      preuve N-1, fourchette) s'appliquent PAR-DESSUS (decision 3) ;
//   2. les bornes (decision 2) : grille strictement croissante, rien sous le
//      prix minimum ; un Exceptionnel fixe au-dessus du plafond fait tomber la
//      fourchette ;
//   3. l'ecrivain : une ligne par bien et par niveau, cloisonnee par compte,
//      avec le recommande ; « au calcul » retire la ligne ; tout se journalise ;
//   4. l'endpoint : bornes refusees, nombre confirme exige, repere du moteur
//      efface ; et `prix_hote` garde le prix recommande au ✎.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const S = require('../lib/yield/suggestion')
const R = require('../lib/yield/reference')
const G = require('../lib/yield/grille-hote')

const NIV = [115, 125, 140, 155, 165]
function grille ({ plafond = 295 } = {}) {
  const niveaux = S.NIVEAUX.map((n, i) => ({ ...n, prix: NIV[i], prix_mesure: NIV[i], etire: false }))
  const pos = indice => ({ fiable: true, indice, niveau: niveaux[indice].nom, crans: 0, echantillon: 40, reservations: 20, mediane: NIV[indice] })
  return {
    base: { fiable: true, echantillon: 854, reservations: 400, niveaux, min: 35, max: 295, plafond },
    positions: new Map([['hors_vacances', { ...pos(1), crans: 0 }]]),
    positions_jour: new Map([['hors_vacances|samedi', pos(4)], ['hors_vacances|mardi', pos(0)]])
  }
}
const CTX = R.construireContexte({ zoneBien: 'C', vacances: [], debut: '2025-01-01', fin: '2027-12-31' })
const SAMEDI = '2026-11-21'
const MARDI = '2026-11-17'
const fixes = o => new Map(Object.entries(o).map(([k, v]) => [k, { rate_cents: v * 100 }]))
const nuit = (g, date, extra = {}) => S.suggerer({ date, grille: g, contexte: CTX, ouverte: true, delaiJours: 30, bien: { prix_minimum: 1 }, ...extra })

test('LE TEST QUI COMPTE : un niveau fixe remplace le MONTANT, pas la position — et le jour de semaine s applique par-dessus', () => {
  const g0 = grille()
  const g = G.appliquerGrilleHote(g0, fixes({ Base: 100, Exceptionnel: 180 }))
  assert.deepEqual(g.base.niveaux.map(n => [n.nom, n.prix, n.prix_calcule, !!n.fixe_par_hote]),
    [['Base', 100, 115, true], ['Moyen', 125, 125, false], ['Haut', 140, 140, false], ['Très haut', 155, 155, false], ['Exceptionnel', 180, 165, true]])
  assert.equal(g.positions, g0.positions, 'les positions ne sont pas recalculees')
  assert.equal(g0.base.niveaux[0].prix, 115, 'l entree n est pas modifiee')
  // Le mardi est positionne Base : il prend le montant FIXE.
  assert.deepEqual([nuit(g, MARDI).niveau, nuit(g, MARDI).prix], ['Base', 100])
  // Le samedi est positionne Exceptionnel : le montant FIXE, sans preuve.
  assert.deepEqual([nuit(g, SAMEDI).niveau, nuit(g, SAMEDI).prix], ['Exceptionnel', 180])
})

test('LE TEST QUI COMPTE (decision 3) : la preuve N-1 et la fourchette s appliquent PAR-DESSUS le montant fixe', () => {
  const g = G.appliquerGrilleHote(grille(), fixes({ Exceptionnel: 180 }))
  const s = nuit(g, SAMEDI, { preuveN1: { date: '2025-11-22', prix: 230, ventes: 1, meme_segment: true, hors_reference: false } })
  assert.equal(s.prix, 230, 'la prime prouvee monte au-dessus du montant fixe')
  assert.deepEqual(s.fourchette_exceptionnel, { bas: 180, plafond: 295 })
})

test('un Exceptionnel fixe AU-DESSUS du plafond fait tomber la fourchette ; sans niveau fixe, la grille est rendue telle quelle', () => {
  const g = G.appliquerGrilleHote(grille({ plafond: 200 }), fixes({ Exceptionnel: 220 }))
  assert.equal(g.base.plafond, null)
  const g0 = grille()
  assert.equal(G.appliquerGrilleHote(g0, new Map()), g0)
})

test('LE TEST QUI COMPTE (decision 2) : grille strictement croissante, rien sous le prix minimum', () => {
  const niv = p => S.NIVEAUX.map((n, i) => ({ nom: n.nom, prix: p[i] }))
  assert.deepEqual(G.validerGrille(niv([90, 105, 115, 125, 140]), 8500), { ok: true })
  assert.equal(G.validerGrille(niv([90, 105, 105, 125, 140]), 8500).code, 'ordre', 'egalite refusee : deux niveaux egaux ne sont pas deux niveaux')
  assert.equal(G.validerGrille(niv([90, 130, 115, 125, 140]), 8500).code, 'ordre')
  assert.equal(G.validerGrille(niv([80, 105, 115, 125, 140]), 8500).code, 'sous_prix_minimum')
  assert.match(G.validerGrille(niv([90, 130, 115, 125, 140]), 8500).message, /^Haut \(115 €\) doit être au-dessus de Moyen \(130 €\)\.$/)
})

// ─── L'ecrivain ─────────────────────────────────────────────────────────────
const COMPTE = 'a1a1a1a1-0000-4000-8000-000000000001'
const BIEN = 'b1b1b1b1-0000-4000-8000-000000000001'
function fausseBase (lignes = []) {
  const journal = []
  const table = new Map(lignes.map(l => [l.niveau, { ...l }]))
  return {
    journal, table,
    from (nom) {
      const q = { f: [], del: false }
      q.select = () => q
      q.eq = (c, v) => { q.f.push([c, v]); return q }
      q.maybeSingle = async () => { const n = (q.f.find(([c]) => c === 'niveau') || [])[1]; return { data: table.get(n) || null, error: null } }
      q.upsert = async (l, o) => { journal.push({ op: 'upsert', nom, l, o }); table.set(l.niveau, l); return { error: null } }
      q.insert = async l => { journal.push({ op: 'insert', nom, l }); return { error: null } }
      q.delete = () => { q.del = true; return q }
      q.then = res => {
        if (q.del) {
          journal.push({ op: 'delete', nom, f: q.f })
          const n = (q.f.find(([c]) => c === 'niveau') || [])[1]
          const l = table.get(n); table.delete(n)
          return Promise.resolve({ data: l ? [l] : [], error: null }).then(res)
        }
        return Promise.resolve({ data: [...table.values()], error: null }).then(res)
      }
      return q
    }
  }
}

test('LE TEST QUI COMPTE : fixer ecrit UNE ligne par bien et par niveau, avec le recommande, et se journalise ; « au calcul » retire la ligne', async () => {
  const sb = fausseBase()
  const r = await G.fixerNiveau(sb, { userId: COMPTE, propertyId: BIEN, niveau: 'Moyen', cents: 12000, recommandeCents: 10500 })
  assert.deepEqual(r, { ok: true, avant: null })
  const up = sb.journal.find(j => j.op === 'upsert')
  assert.deepEqual([up.l.user_id, up.l.property_id, up.l.niveau, up.l.rate_cents, up.l.recommended_rate_cents, up.o.onConflict],
    [COMPTE, BIEN, 'Moyen', 12000, 10500, 'property_id,niveau'])
  assert.deepEqual(sb.journal.find(j => j.op === 'insert').l,
    { user_id: COMPTE, property_id: BIEN, niveau: 'Moyen', evenement: 'posee', rate_cents: 12000, rate_cents_avant: null, recommended_rate_cents: 10500 })
  const x = await G.remettreAuCalcul(sb, { userId: COMPTE, propertyId: BIEN, niveau: 'Moyen' })
  assert.deepEqual(x, { ok: true, retire: true })
  const del = sb.journal.find(j => j.op === 'delete')
  assert.deepEqual(del.f, [['user_id', COMPTE], ['property_id', BIEN], ['niveau', 'Moyen']], 'cloisonne dans le WHERE')
  assert.equal(sb.journal.filter(j => j.op === 'insert').at(-1).l.evenement, 'retiree')
})

test('ecrivain : niveau inconnu, montant nul ou compte absent refuses sans ecriture ; table absente = aucun niveau fixe', async () => {
  const sb = fausseBase()
  assert.equal((await G.fixerNiveau(sb, { userId: COMPTE, propertyId: BIEN, niveau: 'Luxe', cents: 100 })).raison, 'niveau_inconnu')
  assert.equal((await G.fixerNiveau(sb, { userId: COMPTE, propertyId: BIEN, niveau: 'Base', cents: 0 })).raison, 'montant_invalide')
  assert.equal((await G.fixerNiveau(sb, { userId: 'x', propertyId: BIEN, niveau: 'Base', cents: 100 })).raison, 'parametres_invalides')
  assert.deepEqual(sb.journal, [])
  const absente = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.grille_hote'" } }) }) }) }
  assert.deepEqual(await G.grilleHoteDuBien(absente, BIEN), new Map())
  const panne = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'timeout' } }) }) }) }
  await assert.rejects(G.grilleHoteDuBien(panne, BIEN), /lecture : timeout/)
})

// ─── L'endpoint ─────────────────────────────────────────────────────────────
function chargerEndpoint ({ sim, fixesActuels = new Map(), bien = {} }) {
  const gestes = []
  const ligneBien = { id: BIEN, user_id: COMPTE, prix_minimum: 8500, pilote_tarifaire: 'yieldflow', pilote_fenetre_type: 'mois', pilote_fenetre_valeur: 3, rate_sync_mode: 'managed', ...bien }
  const sb = { from () { const q = {}; q.select = () => q; q.eq = (c, v) => { gestes.push(['lecture', c, v]); return q }; q.maybeSingle = async () => ({ data: ligneBien, error: null }); return q } }
  const stubs = {
    '@supabase/supabase-js': { createClient: () => sb },
    '/require-permission': { requirePermission: async (req, res, o) => { gestes.push(['garde', o.domaine, o.niveau]); return { ok: true, bien: { id: BIEN }, accountUserId: COMPTE } } },
    '/simuler-grille': { simulerGrille: async (s, b, a, p) => { gestes.push(['simulation', [...p.entries()].map(([k, v]) => `${k}=${v.rate_cents}`).join(',')]); return sim(p) } },
    '/ouverture-marqueur': { effacerMarqueur: async () => { gestes.push(['marqueur']); return {} }, jourParis: () => '2026-10-01' }
  }
  const avant = Module._load
  Module._load = function (d, ...reste) {
    for (const [k, v] of Object.entries(stubs)) if (d === k || d.endsWith(k)) return v
    if (/\/grille-hote$/.test(d)) {
      const vrai = avant.apply(this, [d, ...reste])
      return { ...vrai, grilleHoteDuBien: async () => fixesActuels,
        fixerNiveau: async (s, o) => { gestes.push(['fixer', o.niveau, o.cents, o.recommandeCents]); return { ok: true } },
        remettreAuCalcul: async (s, o) => { gestes.push(['au_calcul', o.niveau]); return { ok: true } } }
    }
    return avant.apply(this, [d, ...reste])
  }
  delete require.cache[require.resolve('../api/yield-grille')]
  const api = require('../api/yield-grille')
  Module._load = avant
  const appeler = (method, donnees) => new Promise(resolve => {
    let code = 200
    const res = { status (c) { code = c; return res }, setHeader () {}, json: corps => resolve({ code, corps }) }
    api({ method, query: method === 'GET' ? { bien: BIEN, ...donnees } : {}, body: method === 'POST' ? { bien: BIEN, ...donnees } : {}, headers: {} }, res)
  })
  return { appeler, gestes }
}
const grilleSim = prix => S.NIVEAUX.map((n, i) => ({ nom: n.nom, prix: prix[i], prix_calcule: [90, 105, 115, 125, 140][i], fixe_par_hote: prix[i] !== [90, 105, 115, 125, 140][i] }))
const SIM = p => ({ pilote: true, nuits: 12, du: '2026-10-03', au: '2026-12-29', min: 90, max: 145,
  grille: grilleSim([90, p.has('Moyen') ? p.get('Moyen').rate_cents / 100 : 105, 115, 125, 140]) })

test('LE TEST QUI COMPTE (endpoint) : GET annonce, POST exige le nombre ; ecrit avec le recommande CALCULE ; efface le repere du moteur', async () => {
  const e = chargerEndpoint({ sim: SIM })
  const g = await e.appeler('GET', { niveau: 'Moyen', prix_centimes: '11000' })
  assert.deepEqual([g.code, g.corps.valide, g.corps.confirmation.nuits], [200, true, 12])
  assert.deepEqual(e.gestes.filter(x => x[0] === 'garde')[0], ['garde', 'reservations', 'read'])
  const sans = await e.appeler('POST', { niveau: 'Moyen', prix_centimes: 11000 })
  assert.equal(sans.code, 409)
  const faux = await e.appeler('POST', { niveau: 'Moyen', prix_centimes: 11000, confirme: { nuits: 3 } })
  assert.equal(faux.code, 409)
  assert.equal(e.gestes.some(x => x[0] === 'fixer'), false, 'rien n est ecrit sans le bon nombre')
  const ok = await e.appeler('POST', { niveau: 'Moyen', prix_centimes: 11000, confirme: { nuits: 12 } })
  assert.equal(ok.code, 200)
  assert.deepEqual(e.gestes.filter(x => x[0] === 'garde').at(-1), ['garde', 'reglages', 'write'])
  assert.deepEqual(e.gestes.find(x => x[0] === 'fixer'), ['fixer', 'Moyen', 11000, 10500], 'le recommande est le montant CALCULE du niveau')
  assert.ok(e.gestes.some(x => x[0] === 'marqueur'), 'les prix partent au prochain passage')
  assert.ok(e.gestes.some(x => x[0] === 'lecture' && x[1] === 'user_id' && x[2] === COMPTE), 'le bien se lit cloisonne par compte')
})

test('LE TEST QUI COMPTE (endpoint, decision 2) : une grille qui ne tient pas les bornes est REFUSEE, et rien n est ecrit', async () => {
  const e = chargerEndpoint({ sim: SIM })
  const g = await e.appeler('GET', { niveau: 'Moyen', prix_centimes: '12000' })
  assert.deepEqual([g.corps.valide, g.corps.code], [false, 'ordre'], 'Moyen 120 > Haut 115')
  const p = await e.appeler('POST', { niveau: 'Moyen', prix_centimes: 12000, confirme: { nuits: 12 } })
  assert.equal(p.code, 400)
  const bas = await e.appeler('POST', { niveau: 'Moyen', prix_centimes: 8000, confirme: { nuits: 12 } })
  assert.deepEqual([bas.code, bas.corps.code], [400, 'sous_prix_minimum'], '80 € : sous le prix minimum (85 €)')
  assert.equal(e.gestes.some(x => x[0] === 'fixer'), false)
})

test('endpoint : « au calcul » passe par la meme confirmation ; un bien non pilote n efface aucun repere', async () => {
  const e = chargerEndpoint({ sim: p => ({ ...SIM(p), pilote: false, nuits: 0 }), fixesActuels: new Map([['Moyen', { rate_cents: 11000 }]]), bien: { pilote_tarifaire: 'calendrier' } })
  const r = await e.appeler('POST', { niveau: 'Moyen', retirer: true, confirme: { nuits: 0 } })
  assert.equal(r.code, 200)
  assert.deepEqual(e.gestes.find(x => x[0] === 'au_calcul'), ['au_calcul', 'Moyen'])
  assert.equal(e.gestes.find(x => x[0] === 'simulation')[1], '', 'la grille proposee n a plus de niveau fixe')
  assert.equal(e.gestes.some(x => x[0] === 'marqueur'), false)
})

// ─── prix_hote : le recommande au ✎ ─────────────────────────────────────────
test('LE TEST QUI COMPTE : poserPrixHote garde le prix recommande — celui de la porte pour une nuit neuve, celui d ORIGINE pour une nuit deja fixee', async () => {
  const { poserPrixHote } = require('../lib/prix-hote')
  const ecrit = []
  const exist = [{ stay_date: '2026-10-16', rate_cents: 15000, recommended_rate_cents: 11000 }]
  const sb = { from (nom) {
    const q = {}; q.select = () => q; q.eq = () => q; q.in = () => Promise.resolve({ data: nom === 'prix_hote' ? exist : [], error: null })
    q.upsert = async l => { ecrit.push(...l); return { error: null } }
    q.insert = async () => ({ error: null })
    return q
  } }
  const r = await poserPrixHote(sb, { userId: COMPTE, propertyId: BIEN, nuits: [
    { date: '2026-10-15', cents: 13000, recommande_cents: 10500 }, { date: '2026-10-16', cents: 14000, recommande_cents: 15000 }] })
  assert.equal(r.ok, true)
  assert.deepEqual(ecrit.map(l => [l.stay_date, l.rate_cents, l.recommended_rate_cents]), [['2026-10-15', 13000, 10500], ['2026-10-16', 14000, 11000]])
})

test('poserPrixHote : colonne absente (migration non appliquee) — le geste de l hote passe quand meme, sans la trace', async () => {
  const { poserPrixHote } = require('../lib/prix-hote')
  const ecrit = []
  let essais = 0
  const sb = { from () {
    const q = {}; q.select = cols => { q.cols = cols; return q }; q.eq = () => q
    q.in = () => { essais++; return Promise.resolve(/recommended_rate_cents/.test(q.cols) ? { data: null, error: { message: 'column prix_hote.recommended_rate_cents does not exist' } } : { data: [], error: null }) }
    q.upsert = async l => { ecrit.push(...l); return { error: null } }
    q.insert = async () => ({ error: null })
    return q
  } }
  const r = await poserPrixHote(sb, { userId: COMPTE, propertyId: BIEN, nuits: [{ date: '2026-10-15', cents: 13000, recommande_cents: 10500 }] })
  assert.equal(r.ok, true)
  assert.equal(essais, 2)
  assert.equal('recommended_rate_cents' in ecrit[0], false)
})

test('la porte du calendrier lit le prix en place AVANT d ecrire le ✎, et le passe comme recommande', () => {
  const src = require('fs').readFileSync(require.resolve('../api/calendar.js'), 'utf8')
  const i = src.indexOf("for (const n of nuitsPrixHote) n.recommande_cents")
  const j = src.indexOf('pose = await poserPrixHote(')
  const k = src.indexOf('r = await ecrireCalendrier({', j)
  assert.ok(i > 0 && i < j && j < k, 'lecture, puis pose, puis ecriture du calendrier')
})

test('LE TEST QUI COMPTE : preparerContexte — le point unique — applique les niveaux fixes lus en base ; `grilleCalculee` reste intacte ; l option les remplace', async () => {
  const calculee = grille()
  const avant = Module._load
  Module._load = function (d, ...reste) {
    if (/\/grille-du-bien$/.test(d)) return { grilleDuBien: async () => ({ eclatements: [], duBien: [], grille: calculee }) }
    return avant.apply(this, [d, ...reste])
  }
  delete require.cache[require.resolve('../lib/yield/contexte-du-bien')]
  const { preparerContexte } = require('../lib/yield/contexte-du-bien')
  Module._load = avant
  delete require.cache[require.resolve('../lib/yield/contexte-du-bien')]
  const base = () => ({ from (table) {
    const q = {}
    for (const m of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'lt', 'gt', 'order', 'range', 'limit', 'is', 'or', 'not']) q[m] = () => q
    q.maybeSingle = () => Promise.resolve({ data: null, error: null }); q.single = q.maybeSingle
    q.then = (res, rej) => Promise.resolve({ data: table === 'grille_hote' ? [{ niveau: 'Moyen', rate_cents: 13000, recommended_rate_cents: 12500 }] : [], error: null, count: 0 }).then(res, rej)
    return q
  } })
  const B = { id: BIEN, user_id: COMPTE, provider: 'channex', provider_property_id: 'P', zone_scolaire: 'C', capacity: 2, inventory_units: 1, base_price: 100, prix_minimum: 5000, pilote_tarifaire: 'yieldflow', rate_sync_mode: 'managed' }
  const ctx = await preparerContexte(base(), B, COMPTE, { aujourdHui: '2026-09-23', debut: '2026-10-01', fin: '2026-10-31' })
  assert.deepEqual([ctx.grille.base.niveaux[1].prix, ctx.grille.base.niveaux[1].fixe_par_hote, ctx.grilleCalculee.base.niveaux[1].prix], [130, true, 125])
  const sim = await preparerContexte(base(), B, COMPTE, { aujourdHui: '2026-09-23', debut: '2026-10-01', fin: '2026-10-31', grilleHote: new Map() })
  assert.equal(sim.grille.base.niveaux[1].prix, 125, 'une Map vide en option : la grille calculee, sans lire la base')
})
