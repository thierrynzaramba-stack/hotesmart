// tests/ecran-evenements-sejours.test.js — 4b « Ce qui fait bouger vos prix » :
// les sejours de quatre annees et les couches de chaque personne.
// Spec : docs/specs/spec-yf-ecran-evenements.md §16.
//
// ⚠ TROIS BANCS :
//   - les fonctions PURES de lib/yield/sejours.js, sur le VRAI resolveur
//     (`occurrences`) : c'est l'alignement qu'on veut voir, pas un double ;
//   - l'ASSEMBLEE (lib/yield/ecran-evenements.js), avec un contexte bati par
//     les vrais modules et un client Supabase NUL : une lecture ajoutee
//     leverait ;
//   - l'ENDPOINT, avec la vraie garde et une base doublee : c'est la ligne
//     ecrite par le PUT et l'ordre des refus qu'on veut voir.
// ⚠ DATES FIGEES, ET LE TEMPS EST INJECTE (`aujourdHui`) : rien ici ne lit
// l'horloge.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const R = require('../lib/yield/reference')
const P = require('../lib/yield/positions')
const S = require('../lib/yield/suggestion')
const DC = require('../lib/yield/dates-commerciales')
const SJ = require('../lib/yield/sejours')

const decaler = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const ecart = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5)
const jourSemaine = iso => new Date(`${iso}T00:00:00Z`).getUTCDay()

const AUJ = '2026-11-09'
// Les vacances d'hiver de la zone C BOUGENT d'une annee a l'autre (rotation
// des zones) : c'est le cas que le recul de 52 semaines rate.
const HIVER_C = [
  ['2024-02-10', '2024-02-25'], ['2025-02-15', '2025-03-02'],
  ['2026-02-07', '2026-02-22'], ['2027-02-20', '2027-03-07']
].map(([a, b]) => ({ zone: 'C', nom: "Vacances d'Hiver", date_debut: a, date_fin: b }))
const NOEL_C = [
  ['2023-12-23', '2024-01-07'], ['2024-12-21', '2025-01-05'],
  ['2025-12-20', '2026-01-04'], ['2026-12-19', '2027-01-03']
].map(([a, b]) => ({ zone: 'C', nom: 'Vacances de Noël', date_debut: a, date_fin: b }))
const VACANCES = [...HIVER_C, ...NOEL_C]
const HIVER = `${R.SEGMENTS.VACANCES_ZONE}:${R.nomCourt("Vacances d'Hiver")}`
const SALON = { id: 'ev-salon', nom: 'Salon du chocolat', segment: 'evenement:salon_du_chocolat', date_debut: '2027-03-19', date_fin: '2027-03-21' }
const MATERIAUX = { zoneBien: 'C', vacances: VACANCES, evenements: [...DC.datesCommerciales('2023-01-01', '2027-12-31'), SALON] }

const ferieQuiTombeLe = (date) => {
  const o = P.occurrences({ zoneBien: 'C', vacances: [], evenements: [], debut: decaler(date, -20), fin: decaler(date, 20) })
    .find(x => x.cle.startsWith(`${R.SEGMENTS.FERIE}:`) && x.nuits.includes(date))
  assert.ok(o, `aucun ferie le ${date}`)
  return o
}

// ─── 1. L'ALIGNEMENT (decision S1) ──────────────────────────────────────────

test('LE TEST QUI COMPTE (S1) : Pâques en face de Pâques — le recul de 52 semaines tombe deux semaines à côté', () => {
  const paques27 = ferieQuiTombeLe('2027-03-29') // lundi de Paques 2027
  for (const [k, attendu] of [[1, '2026-04-06'], [2, '2025-04-21'], [3, '2024-04-01']]) {
    const a = SJ.alignerAnnee({ cle: paques27.cle, debut: paques27.debut }, k, MATERIAUX)
    assert.equal(a.alignement, 'evenement', `recul ${k}`)
    assert.equal(decaler(paques27.debut, -a.decalage), attendu, `recul ${k} : le lundi de Paques de l'annee`)
    assert.equal(a.decalage % 7, 0, 'un multiple de 7 : le jour de semaine tient')
  }
  // Contre-epreuve : 52 semaines auraient mis le 30 mars 2026 en face — deux
  // semaines avant le lundi de Paques 2026.
  assert.equal(decaler('2027-03-29', -364), '2026-03-30')
})

test('LE TEST QUI COMPTE (S1) : une date fixe tombe à 3 jours au plus de sa date, et toujours le même jour de semaine', () => {
  const noel = ferieQuiTombeLe('2026-12-25')
  for (const k of SJ.RECULS) {
    const a = SJ.alignerAnnee({ cle: noel.cle, debut: noel.debut }, k, MATERIAUX)
    const p = decaler(noel.debut, -a.decalage)
    assert.equal(a.alignement, 'evenement')
    assert.equal(jourSemaine(p), jourSemaine(noel.debut), `recul ${k}`)
    assert.ok(Math.abs(ecart(`${2026 - k}-12-25`, p)) <= 3, `recul ${k} : ${p}`)
  }
})

test('LE TEST QUI COMPTE (S1) : des vacances qui changent de semaine sont mises en face d’elles-mêmes', () => {
  for (const [k, debutPasse] of [[1, '2026-02-07'], [2, '2025-02-15'], [3, '2024-02-10']]) {
    const a = SJ.alignerAnnee({ cle: HIVER, debut: '2027-02-20' }, k, MATERIAUX)
    assert.deepEqual([a.alignement, a.debut_passe, decaler('2027-02-20', -a.decalage)],
      ['evenement', debutPasse, debutPasse], `recul ${k}`)
  }
})

test('LE TEST QUI COMPTE (S1) : sans occurrence cette année-là, recul de 52 semaines par année — et c’est DIT', () => {
  for (const k of SJ.RECULS) {
    const a = SJ.alignerAnnee({ cle: SALON.segment, debut: SALON.date_debut }, k, MATERIAUX)
    assert.deepEqual([a.alignement, a.decalage], ['semaines', 364 * k])
  }
  // Une matiere absente est un repli, jamais une exception.
  assert.equal(SJ.alignerAnnee({ cle: HIVER, debut: '2027-02-20' }, 1, null).alignement, 'semaines')
})

test('LE TEST QUI COMPTE : deux occurrences l’année d’avant — la plus proche de la même date ; une seule, à deux mois — aucune', () => {
  const avec = (...dates) => ({ ...MATERIAUX,
    evenements: [...MATERIAUX.evenements, ...dates.map(([a, b]) => ({ ...SALON, date_debut: a, date_fin: b }))] })
  const salon = { cle: SALON.segment, debut: SALON.date_debut }
  // 40 jours avant et 1 jour apres le 19 mars 2026 : la seconde, meme si la
  // premiere vient d'abord dans l'ordre des dates.
  assert.equal(SJ.alignerAnnee(salon, 1, avec(['2026-02-07', '2026-02-09'], ['2026-03-20', '2026-03-22'])).debut_passe, '2026-03-20')
  // ⚠ 60 JOURS APRES : le resolveur la rend (sa marge de rayonnement deborde la
  // fenetre), mais ce n'est plus « le meme evenement l'an dernier ». Repli.
  const loin = SJ.alignerAnnee(salon, 1, avec(['2026-05-18', '2026-05-20']))
  assert.deepEqual([loin.alignement, loin.decalage], ['semaines', 364])
  // Et la fixture le prouve : sans le filtre, l'occurrence existait bien.
  assert.ok(P.occurrences({ zoneBien: 'C', vacances: [], evenements: avec(['2026-05-18', '2026-05-20']).evenements,
    debut: decaler('2026-03-19', -SJ.FENETRE_ALIGNEMENT), fin: decaler('2026-03-19', SJ.FENETRE_ALIGNEMENT) })
    .some(o => o.cle === SALON.segment && o.debut === '2026-05-18'))
})

// ─── 2. LES SEJOURS VENDUS ─────────────────────────────────────────────────

const ecl = (debut, n, o = {}) => ({
  compte: o.compte !== false,
  nuits: Array.from({ length: n }, (_, i) => ({ date: decaler(debut, i), prix: o.prix ?? 120 })),
  prix_par_nuit: o.prix === undefined ? 120 : o.prix,
  canal: o.canal || 'airbnb',
  date_vente: o.vente || null,
  date_vente_fiable: o.fiable !== false && !!o.vente
})

test('LE TEST QUI COMPTE : un séjour vendu = un séjour CONFIRMÉ ; son prix est celui d’`eclater`, jamais 0 quand il manque', () => {
  const liste = SJ.sejoursVendus([
    ecl('2026-02-07', 3, { vente: '2025-12-20T09:14:00Z' }),
    ecl('2026-02-13', 1, { prix: null }),
    ecl('2026-02-15', 2, { compte: false })
  ])
  assert.deepEqual(liste, [
    { debut: '2026-02-07', fin: '2026-02-09', nuits: 3, prix_nuit: 120, canal: 'airbnb', delai: 49 },
    { debut: '2026-02-13', fin: '2026-02-13', nuits: 1, prix_nuit: null, canal: 'airbnb', delai: null }
  ])
})

test('le délai se compte en JOURS, seulement sur une date de vente fiable, jamais négatif', () => {
  const [matin, importee, apres] = SJ.sejoursVendus([
    ecl('2026-03-01', 2, { vente: '2026-03-01T07:00:00Z' }),
    ecl('2026-04-01', 2, { vente: '2026-02-01', fiable: false }),
    ecl('2026-05-01', 2, { vente: '2026-05-03' })
  ])
  assert.equal(matin.delai, 0, 'vendu le matin de l’arrivée : délai 0, pas « après l’arrivée »')
  assert.equal(importee.delai, null, 'une date de migration n’est pas une date de vente')
  assert.equal(apres.delai, null)
})

test('la plage garde un séjour qui la touche d’une nuit, entier ; la première nuit vendue se lit sur tout l’historique', () => {
  const eclatements = [ecl('2019-07-01', 4), ecl('2026-01-30', 4), ecl('2026-03-01', 2)]
  const liste = SJ.sejoursVendus(eclatements, { debut: '2026-02-02', fin: '2026-02-28' })
  assert.deepEqual(liste.map(s => [s.debut, s.fin]), [['2026-01-30', '2026-02-02']])
  assert.equal(SJ.premiereNuitVendue(eclatements), '2019-07-01')
  assert.equal(SJ.premiereNuitVendue([ecl('2019-07-01', 1, { compte: false })]), null)
})

test('deux séjours sur la même nuit : le premier arrivé tient la nuit (surréservation déjà en base)', () => {
  const index = SJ.indexParNuit([{ debut: '2026-02-07', fin: '2026-02-08', prix_nuit: 1 }, { debut: '2026-02-08', fin: '2026-02-09', prix_nuit: 2 }])
  assert.deepEqual(['2026-02-07', '2026-02-08', '2026-02-09'].map(d => index.get(d).prix_nuit), [1, 1, 2])
})

// ─── 3. LE BILAN D'UNE ANNEE ET LES LIGNES PRESENTES ────────────────────────

test('LE TEST QUI COMPTE : le bilan compte les nuits PASSÉES ; un prix inconnu est compté à part, jamais au CA', () => {
  const index = SJ.indexParNuit(SJ.sejoursVendus([ecl('2026-02-07', 3), ecl('2026-02-13', 1, { prix: null }), ecl('2026-11-20', 2, { prix: 99 })]))
  const nuits = ['2027-02-20', '2027-02-21', '2027-02-22', '2027-02-23', '2027-02-26']
  assert.deepEqual(SJ.bilanDeLAnnee(nuits, 378, index, AUJ), { ca: 360, nuits: 4, prix_inconnus: 1, passees: 5 })
  // Reculee d'un an, la fin du 13e mois tombe apres aujourd'hui : pas encore jouee.
  assert.deepEqual(SJ.bilanDeLAnnee(['2027-11-20', '2027-11-21'], 364, index, AUJ), { ca: 0, nuits: 0, prix_inconnus: 0, passees: 0 })
})

test('LE TEST QUI COMPTE : sans historique à ce moment-là, PAS DE LIGNE — jamais une ligne de « — » pour un bien qui ne vendait pas', () => {
  const index = SJ.indexParNuit(SJ.sejoursVendus([ecl('2026-02-07', 3)]))
  const o = { cle: HIVER, debut: '2027-02-20', nuits: ['2027-02-20', '2027-02-21', '2027-02-22'] }
  const annees = SJ.anneesPassees(o, { materiaux: MATERIAUX, index, premiere: '2025-06-01', aujourdHui: AUJ })
  assert.deepEqual(annees, [{ recul: 1, annee: 2026, decalage: 378, alignement: 'evenement', ca: 360, nuits: 3 }])
  assert.deepEqual(SJ.anneesPassees(o, { materiaux: MATERIAUX, index, premiere: null, aujourdHui: AUJ }), [])
  // Le bien vendait deja en 2023 : trois lignes, meme vides.
  assert.deepEqual(SJ.anneesPassees(o, { materiaux: MATERIAUX, index, premiere: '2023-01-01', aujourdHui: AUJ }).map(a => [a.annee, a.nuits]),
    [[2026, 3], [2025, 0], [2024, 0]])
})

// ─── 4. L'ASSEMBLEE ─────────────────────────────────────────────────────────

const NIV = [115, 125, 140, 155, 165]
function grille () {
  const niveaux = S.NIVEAUX.map((x, i) => ({ ...x, prix: NIV[i], prix_mesure: NIV[i], etire: false }))
  const pos = i => ({ fiable: true, indice: i, niveau: niveaux[i].nom, crans: 0, echantillon: 40, reservations: 20, mediane: NIV[i] })
  return {
    base: { fiable: true, echantillon: 854, reservations: 400, niveaux, min: 35, max: 295, plafond: 295 },
    positions: new Map([['hors_vacances', pos(1)]]),
    positions_jour: new Map()
  }
}

function charger ({ eclatements = [], reglages = new Map() } = {}) {
  const evenements = MATERIAUX.evenements
  const appels = []
  const preparer = async (s, bien, compte, opt) => {
    appels.push(opt)
    const materiauxPositions = { reglages, zoneBien: 'C', vacances: VACANCES, evenements, debut: '2026-11-01', fin: opt.fin }
    return {
      auj: opt.aujourdHui, bien, grille: grille(),
      contexte: R.construireContexte({ zoneBien: 'C', vacances: VACANCES, evenements, debut: '2023-11-09', fin: opt.fin }),
      evenements, reglages, lignesPosition: [], materiauxPositions,
      positions: P.positionsDuContexte({ ...materiauxPositions, lignes: [] }),
      pressionParMois: new Map(), vendues: {}, parDate: new Map(), ouverts: new Set(), ouvertureConnue: false,
      eclatements
    }
  }
  const avant = Module._load
  Module._load = function (d, ...reste) {
    if (d === './contexte-du-bien') { const vrai = avant.apply(this, [d, ...reste]); return { ...vrai, preparerContexte: preparer } }
    if (d === './vacances') { const vrai = avant.apply(this, [d, ...reste]); return { ...vrai, etendueSource: async () => [] } }
    if (d === '../prix-hote') return { prixHoteDuBien: async () => new Map() }
    return avant.apply(this, [d, ...reste])
  }
  const chemin = require.resolve('../lib/yield/ecran-evenements')
  let E
  try {
    delete require.cache[chemin]
    E = require('../lib/yield/ecran-evenements')
  } finally {
    Module._load = avant
    delete require.cache[chemin]
  }
  const bien = { id: 'bien-1', zone_scolaire: 'C', prix_minimum: 1, inventory_units: 1 }
  // ⚠ LE CLIENT EST NUL : une lecture de plus (bookings_snapshot ou autre)
  // leverait — c'est la garde de la decision S3.
  const assembler = () => E.assemblerEcranEvenements(null, bien, 'compte-1', { aujourdHui: AUJ })
  assembler.appels = appels
  assembler.E = E
  return assembler
}

test('LE TEST QUI COMPTE (S3) : l’écran rend les séjours SANS AUCUNE lecture de plus — un client nul, et le contexte lu une fois', async () => {
  const assembler = charger({ eclatements: [ecl('2026-02-07', 3), ecl('2026-02-13', 1, { prix: null }), ecl('2027-02-20', 3, { prix: 150 }), ecl('2019-07-01', 2)] })
  const ecran = await assembler()
  assert.equal(assembler.appels.length, 1)
  // La plage couvre trois ans et une zone : le sejour de 2019 n'est pas
  // envoye, mais il dit que le bien vendait deja.
  assert.deepEqual(ecran.sejours.liste.map(s => s.debut), ['2026-02-07', '2026-02-13', '2027-02-20'])
  assert.equal(ecran.sejours.premiere_nuit, '2019-07-01')
  const hiver = ecran.evenements.find(e => e.cle === HIVER && e.debut === '2027-02-20')
  assert.deepEqual(hiver.annees.map(a => [a.annee, a.alignement, a.nuits, a.ca, a.prix_inconnus || 0]),
    [[2026, 'evenement', 4, 360, 1], [2025, 'evenement', 0, 0, 0], [2024, 'evenement', 0, 0, 0]])
})

test('LE TEST QUI COMPTE : chaque événement porte ses années ; une date commerciale coupée n’en a pas', async () => {
  const reglages = new Map([[DC.cleSegment(DC.DATES[0].cle), { actif: false }]])
  const ecran = await charger({ eclatements: [ecl('2024-01-02', 2)], reglages })()
  assert.ok(ecran.evenements.length > 10)
  for (const e of ecran.evenements) {
    assert.ok(Array.isArray(e.annees), e.cle)
    if (e.actif === false) assert.deepEqual(e.annees, [])
    for (const a of e.annees) {
      assert.equal(a.decalage % 7, 0, `${e.cle} : jour de semaine`)
      assert.ok(['evenement', 'semaines'].includes(a.alignement))
    }
  }
  assert.ok(ecran.evenements.some(e => e.actif === false), 'la fixture coupe bien une date commerciale')
})

test('LE TEST QUI COMPTE : la zone dont le serveur compte le CA est EXACTEMENT celle que la page affiche', async () => {
  const reglages = new Map([[HIVER, { weekends_avant: 2, weekends_apres: 1 }]])
  const assembler = charger({ eclatements: [ecl('2026-01-20', 40)], reglages })
  const ecran = await assembler()
  const rendu = await import(path.join(__dirname, '..', 'shared/yield-evenements-rendu.js'))
  let elargis = 0
  for (const e of ecran.evenements) {
    const page = [...new Set([...(e.nuits || []), ...rendu.weekEndsAffiches(e).flatMap(w => w.nuits)])].sort()
    assert.deepEqual(assembler.E.nuitsDeLaZoneAffichee(e), page, e.cle)
    if (page.length > (e.nuits || []).length) elargis++
  }
  assert.ok(elargis > 0, 'au moins un evenement elargi : sinon le test ne compare que les nuits')
})

// ─── 5. L'ENDPOINT : LES COUCHES (decision S2) ─────────────────────────────

const TITULAIRE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const BIEN_A = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: TITULAIRE, name: 'Colomiers', provider: 'channex', provider_property_id: 'ref-a', zone_scolaire: 'C', archive_le: null }
const PROFIL = { id: 'profil-1', account_user_id: TITULAIRE, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' }
const MODULES = ['../api/ecran/evenements', '../lib/require-permission', '../lib/permissions', '../lib/compte-requetes']

function preparerEndpoint ({ user = TITULAIRE, profil = null, permissions = null, prefs = [], pannePrefs = false } = {}) {
  const etat = { tables: [], ecrits: [], fetchs: 0 }
  globalThis.fetch = async () => { etat.fetchs++; return { ok: true } }
  const viaFetch = chemin => globalThis.fetch(process.env.SUPABASE_URL + chemin)
  const client = {
    auth: { getUser: async () => { await viaFetch('/auth/v1/user'); return user ? { data: { user: { id: user } }, error: null } : { data: null, error: { message: 'x' } } } },
    from (nom) {
      etat.tables.push(nom)
      const q = { f: {} }
      const chaine = {
        select () { return chaine },
        eq (c, v) { q.f[c] = v; return chaine },
        is (c, v) { q.f[c] = v; return chaine },
        in () { return chaine }, or () { return chaine }, order () { return chaine }, limit () { return chaine },
        maybeSingle: async () => { const r = await lire(); return { data: (r.data || [])[0] || null, error: r.error } },
        upsert: async (ligne, opt) => {
          await viaFetch('/rest/v1/' + nom)
          etat.ecrits.push({ nom, ligne, opt })
          return { error: pannePrefs ? { message: 'panne' } : null }
        },
        then (ok, ko) { return lire().then(ok, ko) }
      }
      async function lire () {
        await viaFetch('/rest/v1/' + nom)
        if (nom === 'properties') {
          let c = [BIEN_A].filter(b => q.f.user_id == null || b.user_id === q.f.user_id)
          if (q.f.id) c = c.filter(b => b.id === q.f.id)
          return { data: c, error: null }
        }
        if (nom === 'profiles') {
          const ok = profil && profil.account_user_id === q.f.account_user_id && profil.member_user_id === q.f.member_user_id
          return { data: ok ? [profil] : [], error: null }
        }
        if (nom === 'profile_permissions') return { data: permissions && profil ? [{ ...permissions, profile_id: profil.id }] : [], error: null }
        if (nom === 'preferences_ecran') {
          if (pannePrefs) return { data: null, error: { message: 'relation preferences_ecran does not exist' } }
          return { data: prefs.filter(p => p.user_id === q.f.user_id && p.compte_id === q.f.compte_id && p.ecran === q.f.ecran), error: null }
        }
        return { data: [], error: null }
      }
      return chaine
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  const absE = require.resolve('../lib/yield/ecran-evenements')
  const e = new Module(absE)
  e.exports = { assemblerEcranEvenements: async (s, bien, compte, opt) => ({ fenetre: { debut: opt.aujourdHui, fin: opt.aujourdHui }, evenements: [], nuits: [] }) }
  e.loaded = true
  require.cache[absE] = e
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return etat
}
function reponse () {
  const r = { code: null, body: null, entetes: {} }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = (k, v) => { r.entetes[String(k).toLowerCase()] = v; return r }
  return r
}
async function appeler (opts, { method = 'GET', body = null, compte = null } = {}) {
  const etat = preparerEndpoint(opts)
  const handler = require('../api/ecran/evenements')
  const res = reponse()
  await handler({ method, query: {}, body, headers: { authorization: 'Bearer jeton', ...(compte ? { 'x-compte': compte } : {}) } }, res)
  return { res, etat }
}
const MEMBRE_LECTEUR = { user: MEMBRE, profil: PROFIL,
  permissions: { reservations: 'read', reglages: 'none', property_scope: 'all', property_ids: [], property_refs: [] } }

test('LE TEST QUI COMPTE (S2) : le PUT écrit la ligne de l’APPELANT sur ce compte — jamais une autre, quoi que dise le corps', async () => {
  const { res, etat } = await appeler(MEMBRE_LECTEUR, { method: 'PUT', compte: TITULAIRE,
    body: { user_id: TITULAIRE, compte_id: MEMBRE, couches: { eteintes: ['n3', 'n1'] } } })
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.equal(etat.ecrits.length, 1)
  const { ligne, opt } = etat.ecrits[0]
  assert.deepEqual([ligne.user_id, ligne.compte_id, ligne.ecran], [MEMBRE, TITULAIRE, 'evenements'])
  // L'ordre est celui des couches, pas celui du corps.
  assert.deepEqual(ligne.valeur, { eteintes: ['n1', 'n3'] })
  assert.equal(opt.onConflict, 'user_id,compte_id,ecran')
  assert.deepEqual(res.body, { couches: { eteintes: ['n1', 'n3'], lisibles: true } })
  // Un membre en lecture seule ecrit son affichage : ce n'est pas un reglage du bien.
  assert.ok(!etat.tables.includes('properties'), 'le PUT ne lit aucun logement')
})

test('LE TEST QUI COMPTE : une couche inconnue est REFUSÉE, pas filtrée — et rien ne s’écrit', async () => {
  for (const body of [{ couches: { eteintes: ['n4'] } }, { couches: { eteintes: 'n3' } }, {}, 'pas du json', { couches: { eteintes: ['n1', 'n1', 'n2', 'n3', 'comparables'] } }]) {
    const { res, etat } = await appeler({}, { method: 'PUT', body })
    assert.equal(res.code, 400, JSON.stringify(body))
    assert.equal(res.body.error, 'couches_invalides')
    assert.equal(etat.ecrits.length, 0)
  }
  // Un corps texte valide est lu.
  const { res } = await appeler({}, { method: 'PUT', body: JSON.stringify({ couches: { eteintes: [] } }) })
  assert.equal(res.code, 200)
})

test('LE TEST QUI COMPTE : sans le droit « réservations », le PUT est refusé en 403 — en-tête privé posé, rien écrit', async () => {
  const sansDroit = { ...MEMBRE_LECTEUR, permissions: { ...MEMBRE_LECTEUR.permissions, reservations: 'none' } }
  const { res, etat } = await appeler(sansDroit, { method: 'PUT', compte: TITULAIRE, body: { couches: { eteintes: ['n3'] } } })
  assert.equal(res.code, 403)
  assert.equal(res.entetes['cache-control'], 'private, no-store')
  assert.equal(etat.ecrits.length, 0)
  const sansSession = await appeler({ user: null }, { method: 'PUT', body: { couches: { eteintes: [] } } })
  assert.equal(sansSession.res.code, 401)
  assert.equal(sansSession.etat.ecrits.length, 0)
})

test('une écriture en panne le dit (503), sans message de la base', async () => {
  const { res } = await appeler({ pannePrefs: true }, { method: 'PUT', body: { couches: { eteintes: ['n2'] } } })
  assert.equal(res.code, 503)
  assert.deepEqual(res.body, { error: 'ecriture_impossible' })
})

test('LE TEST QUI COMPTE (S2) : le GET rend les couches de CETTE personne sur CE compte ; illisibles, tout est allumé et c’est dit', async () => {
  const prefs = [
    { user_id: MEMBRE, compte_id: TITULAIRE, ecran: 'evenements', valeur: { eteintes: ['n2', 'inconnue'] } },
    { user_id: TITULAIRE, compte_id: TITULAIRE, ecran: 'evenements', valeur: { eteintes: ['n1'] } }
  ]
  const membre = await appeler({ ...MEMBRE_LECTEUR, prefs }, { compte: TITULAIRE })
  assert.equal(membre.res.code, 200)
  assert.deepEqual(membre.res.body.couches, { eteintes: ['n2'], lisibles: true })
  const titulaire = await appeler({ prefs })
  assert.deepEqual(titulaire.res.body.couches, { eteintes: ['n1'], lisibles: true })
  const aucune = await appeler({})
  assert.deepEqual(aucune.res.body.couches, { eteintes: [], lisibles: true })
  const panne = await appeler({ pannePrefs: true })
  assert.equal(panne.res.code, 200, 'l’écran reste')
  assert.deepEqual(panne.res.body.couches, { eteintes: [], lisibles: false })
  assert.ok(String(panne.res.entetes['server-timing']).includes('requêtes'))
})

// ─── 6. LA MIGRATION ───────────────────────────────────────────────────────

test('migration : RLS active, revoke, AUCUNE policy (tout passe par l’endpoint), clé personne + compte + écran, lignes courtes', () => {
  const SQL = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-11-11-preferences-ecran.sql'), 'utf8')
  assert.match(SQL, /alter table public\.preferences_ecran\s+enable row level security/)
  assert.match(SQL, /revoke all on public\.preferences_ecran\s+from anon, authenticated/)
  assert.doesNotMatch(SQL, /create policy/i)
  assert.match(SQL, /primary key \(user_id, compte_id, ecran\)/)
  for (const [i, l] of SQL.split('\n').entries()) assert.ok(l.length < 60, `ligne ${i + 1} : ${l.length} caractères`)
})
