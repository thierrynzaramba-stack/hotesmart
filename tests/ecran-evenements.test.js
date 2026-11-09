// tests/ecran-evenements.test.js — l'appel d'ecran de « Ce qui fait bouger vos
// prix » (api/ecran/evenements.js) et son assemblee (lib/yield/ecran-evenements.js).
// Spec : docs/specs/spec-yf-ecran-evenements.md §3, §4, §5 et §8.
//
// ⚠ DEUX BANCS, ET C'EST VOULU.
//   - L'ASSEMBLEE se teste avec un contexte construit par les VRAIS modules
//     purs (contexte, resolveur, moteur) : seule la lecture de la base est
//     remplacee. C'est la regle de position et le niveau du moteur qu'on veut
//     voir, pas ceux d'un double.
//   - L'ENDPOINT se teste avec la VRAIE garde (`contexteDEcran`,
//     `lib/permissions`) et une base doublee : c'est l'ordre des refus, le
//     perimetre d'un membre et l'en-tete prive qu'on veut voir.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const R = require('../lib/yield/reference')
const P = require('../lib/yield/positions')
const S = require('../lib/yield/suggestion')
const DC = require('../lib/yield/dates-commerciales')

// ─── LE BANC DE L'ASSEMBLEE ─────────────────────────────────────────────────
// ⚠ DATES FIGEES, ET LE TEMPS EST INJECTE : l'assemblee recoit `aujourdHui`,
// elle ne lit pas l'horloge (regle du depot : dates figees si le test injecte
// le temps).
const AUJ = '2026-11-09'
const VACANCES = [
  { zone: 'C', nom: 'Vacances de Noël', date_debut: '2026-12-19', date_fin: '2027-01-03' },
  { zone: 'A', nom: 'Vacances de Noël', date_debut: '2026-12-19', date_fin: '2027-01-03' },
  { zone: 'C', nom: "Vacances d'Hiver", date_debut: '2027-02-20', date_fin: '2027-03-07' },
  { zone: 'A', nom: "Vacances d'Hiver", date_debut: '2027-02-06', date_fin: '2027-02-21' }
]
const SALON = { id: 'ev-salon', nom: 'Salon du chocolat', segment: 'evenement:salon_du_chocolat', date_debut: '2027-03-19', date_fin: '2027-03-21' }
// La cle que le resolveur donne aux vacances (`nomCourt` garde les accents).
const NOEL = `${R.SEGMENTS.VACANCES_ZONE}:${R.nomCourt('Vacances de Noël')}`
const REVEILLON = 'commercial:reveillon_noel'
const NIV = [115, 125, 140, 155, 165]

function grille () {
  const niveaux = S.NIVEAUX.map((x, i) => ({ ...x, prix: NIV[i], prix_mesure: NIV[i], etire: false }))
  const pos = i => ({ fiable: true, indice: i, niveau: niveaux[i].nom, crans: 0, echantillon: 40, reservations: 20, mediane: NIV[i] })
  return {
    base: { fiable: true, echantillon: 854, reservations: 400, niveaux, min: 35, max: 295, plafond: 295 },
    positions: new Map([['hors_vacances', pos(1)]]),
    positions_jour: new Map([['hors_vacances|samedi', pos(3)], ['hors_vacances|vendredi', pos(2)]])
  }
}
const jourSuivant = j => new Date(Date.parse(`${j}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)

/**
 * Charge l'assemblee avec un `preparerContexte` qui rend un contexte BATI PAR
 * LES VRAIS MODULES sur la fixture. Options :
 *   lignes, reglages, coupees (Set de segments commerciaux coupes), vendues,
 *   sansLigneAuCalendrier (Set de dates), ouvertureConnue.
 */
function charger (o = {}) {
  const reglages = o.reglages || new Map()
  const lignes = o.lignes || []
  const coupees = new Set()
  for (const [cle, r] of reglages) if (r && r.actif === false) coupees.add(cle)
  const evenements = [...DC.datesCommerciales('2023-01-01', '2027-12-31', { desactivees: coupees }), SALON]
  const appels = []
  const preparer = async (s, bien, compte, opt) => {
    appels.push(opt)
    const materiauxPositions = { reglages, zoneBien: 'C', vacances: VACANCES, evenements, debut: '2026-11-01', fin: opt.fin }
    const parDate = new Map()
    const ouverts = new Set()
    for (let j = opt.debut; j <= opt.fin; j = jourSuivant(j)) {
      if (o.sansLigneAuCalendrier && o.sansLigneAuCalendrier.has(j)) continue
      parDate.set(j, { date: j, rate: 100 })
      ouverts.add(j)
    }
    return {
      auj: opt.aujourdHui, bien, grille: grille(),
      contexte: R.construireContexte({ zoneBien: 'C', vacances: VACANCES, evenements, debut: '2023-11-09', fin: opt.fin }),
      evenements, reglages, lignesPosition: lignes, materiauxPositions,
      positions: P.positionsDuContexte({ ...materiauxPositions, lignes }),
      pressionParMois: new Map(), vendues: o.vendues || {}, parDate, ouverts,
      ouvertureConnue: o.ouvertureConnue !== false
    }
  }
  const avant = Module._load
  Module._load = function (d, ...reste) {
    if (d === './contexte-du-bien') { const vrai = avant.apply(this, [d, ...reste]); return { ...vrai, preparerContexte: preparer } }
    if (d === './vacances') { const vrai = avant.apply(this, [d, ...reste]); return { ...vrai, etendueSource: async () => [{ zone: 'C', date_debut: '2025-09-01', date_fin: '2027-07-03' }] } }
    return avant.apply(this, [d, ...reste])
  }
  const chemin = require.resolve('../lib/yield/ecran-evenements')
  delete require.cache[chemin]
  const E = require('../lib/yield/ecran-evenements')
  Module._load = avant
  delete require.cache[chemin]
  const assembler = () => E.assemblerEcranEvenements(null, { id: 'bien-1', zone_scolaire: 'C', prix_minimum: 1, inventory_units: 1 }, 'compte-1', { aujourdHui: AUJ })
  assembler.appels = appels
  assembler.materiaux = { reglages, zoneBien: 'C', vacances: VACANCES, evenements, debut: '2026-11-01', fin: '2027-11-09' }
  return assembler
}
const evenementDe = (ecran, cle, debut) => ecran.evenements.find(e => e.cle === cle && (!debut || e.debut === debut))
// La ligne que la page ecrirait pour une position recue : la position TELLE
// QUELLE, plus un niveau (spec §4 : aucune regle n'est recopiee dans la page).
const ligneDe = (cle, p, niveau, id) => ({ id, evenement: cle, zone: p.zone, rang: p.rang ?? null, jour: p.jour ?? null, nuit: p.nuit ?? null, niveau })

test('LE TEST QUI COMPTE (§4) : une position rendue pour une nuit, renvoyée telle quelle, règle CETTE nuit et aucune autre', async () => {
  // ⚠ C'EST TOUTE LA PROMESSE DE LA SPEC : la page ne recalcule rien, elle
  // renvoie ce qu'elle a recu. Si la traduction date → position etait fausse
  // (un jour perdu, un rang compte autrement que le resolveur), la ligne
  // ecrite tomberait sur une AUTRE nuit — ou sur plusieurs — sans un mot.
  const ecran = await charger()()
  const noel = evenementDe(ecran, NOEL)
  assert.ok(noel, 'les vacances de Noël doivent être un événement de l écran')
  const zones = new Set(noel.positions.map(p => p.zone))
  assert.deepEqual([...zones].sort(), ['apres', 'avant', 'evenement'], 'le rayonnement doit être rendu des deux côtés')
  const m = charger().materiaux
  for (const p of noel.positions) {
    const r = P.positionsDuContexte({ ...m, lignes: [ligneDe(NOEL, p, 'Haut', 'l-1')] })
    assert.deepEqual([...r.parNuit.keys()], [p.date], `la position de ${p.date} (${JSON.stringify(p)}) ne règle pas exactement cette nuit`)
  }
  // Et une date fixe : la nuit du réveillon se désigne par sa nuit, jamais par un jour de semaine.
  const rev = evenementDe(ecran, REVEILLON, '2026-12-24')
  assert.deepEqual(rev.positions.find(p => p.date === '2026-12-24'), { date: '2026-12-24', zone: 'evenement', nuit: 'date' })
})

test('LE TEST QUI COMPTE (Q2, B) : « tout l’événement » = une ligne par nuit — et une nuit absente cette année reste au calcul', async () => {
  const ecran = await charger()()
  const noel = evenementDe(ecran, NOEL)
  const lignes = noel.positions.filter(p => p.zone === 'evenement').map((p, i) => ligneDe(NOEL, p, 'Haut', `l-${i}`))
  assert.equal(lignes.length, noel.nuits.length, 'une ligne par nuit de l’événement, ni plus ni moins')
  assert.ok(lignes.every(l => l.rang != null && l.jour != null), 'aucun joker : chaque ligne nomme son rang et son jour')
  const avecLignes = await charger({ lignes })()
  for (const date of noel.nuits) {
    const n = avecLignes.nuits.find(x => x.date === date)
    assert.equal(n.regle && n.regle.cle, NOEL, `la nuit ${date} n'est pas réglée par les vacances de Noël`)
  }
  // L'an prochain, une nuit de plus (vacances du 18 décembre 2027 au 3 janvier
  // 2028, un samedi de plus en tête) : les lignes retrouvent leurs nuits, la
  // nuit nouvelle n'en a aucune.
  const m = charger().materiaux
  const plus = [...VACANCES, { zone: 'C', nom: 'Vacances de Noël', date_debut: '2027-12-18', date_fin: '2028-01-03' }]
  const r = P.positionsDuContexte({ ...m, vacances: plus, debut: '2027-12-01', fin: '2028-01-10', lignes })
  assert.ok(r.parNuit.has('2027-12-18'), 'le 1er samedi existe aussi en 2027')
  assert.equal(r.parNuit.has('2028-01-03'), false, 'le 3e lundi n’existait pas en 2026 : il reste au calcul')
})

test('LE TEST QUI COMPTE : un événement est une OCCURRENCE — le réveillon reste une nuit des vacances de Noël, et la nuit dit quel réglage la gouverne', async () => {
  // ⚠ L'ANCIEN ECRAN COUPAIT les vacances de Noel au reveillon (segmentation
  // du moteur). Compter « le 2e samedi » sur une periode coupee donnerait un
  // autre samedi que le resolveur.
  const ecran = await charger()()
  const noel = evenementDe(ecran, NOEL)
  assert.equal(noel.debut, '2026-12-19')
  assert.equal(noel.fin, '2027-01-03')
  assert.ok(noel.nuits.includes('2026-12-24') && noel.nuits.includes('2026-12-25'), 'le réveillon et Noël restent des nuits des vacances')
  // Le réveillon réglé à part l'emporte sur les vacances (priorité du moteur).
  const tout = noel.positions.filter(p => p.zone === 'evenement').map((p, i) => ligneDe(NOEL, p, 'Haut', `n-${i}`))
  const rev = evenementDe(ecran, REVEILLON, '2026-12-24').positions.find(p => p.zone === 'evenement')
  const avec = await charger({ lignes: [...tout, ligneDe(REVEILLON, rev, 'Exceptionnel', 'r-1')] })()
  const n24 = avec.nuits.find(x => x.date === '2026-12-24')
  const n26 = avec.nuits.find(x => x.date === '2026-12-26')
  assert.deepEqual([n24.regle.cle, n24.regle.niveau, n24.regle.ligne], [REVEILLON, 'Exceptionnel', 'r-1'])
  assert.deepEqual([n26.regle.cle, n26.regle.niveau], [NOEL, 'Haut'])
})

test('LE TEST QUI COMPTE (§5) : chaque nuit a un niveau et un prix, vendue ou sans ligne au calendrier — et son état voyage à côté', async () => {
  const ecran = await charger({ vendues: { '2026-12-19': [{ id: 'resa' }] }, sansLigneAuCalendrier: new Set(['2026-12-20']) })()
  assert.equal(ecran.nuits.length, 366, 'douze mois de nuits, le 13e mois partiel compris')
  assert.deepEqual([ecran.nuits[0].date, ecran.nuits[ecran.nuits.length - 1].date], ['2026-11-09', '2027-11-09'])
  const vendue = ecran.nuits.find(n => n.date === '2026-12-19')
  assert.equal(vendue.vendue, true)
  assert.ok(vendue.niveau && vendue.prix > 0, 'une nuit vendue garde le niveau que l’hôte règle pour sa position')
  const sansLigne = ecran.nuits.find(n => n.date === '2026-12-20')
  assert.equal(sansLigne.ouverte, null, '« je ne sais pas » n’est pas « fermée »')
  assert.ok(sansLigne.niveau && sansLigne.prix > 0)
  assert.equal(ecran.nuits.find(n => n.date === '2026-12-21').ouverte, true)
  // La capacité inconnue : aucune nuit n'est dite ouverte ni fermée.
  const inconnue = await charger({ ouvertureConnue: false })()
  assert.ok(inconnue.nuits.every(n => n.ouverte === null))
})

test('LE TEST QUI COMPTE (§5) : « le calcul disait » est NOMMÉ — la même nuit tarifée sans la ligne, niveau final et prix', async () => {
  const ecran = await charger()()
  const noel = evenementDe(ecran, NOEL)
  const p = noel.positions.find(x => x.date === '2026-12-22')
  const libre = ecran.nuits.find(n => n.date === '2026-12-22')
  assert.notEqual(libre.niveau, 'Exceptionnel', 'la fixture doit distinguer le niveau posé du calcul')
  const avec = await charger({ lignes: [ligneDe(NOEL, p, 'Exceptionnel', 'l-22')] })()
  const n = avec.nuits.find(x => x.date === '2026-12-22')
  assert.deepEqual([n.niveau, n.regle.niveau], ['Exceptionnel', 'Exceptionnel'])
  assert.deepEqual(n.sans_reglage, { niveau: libre.niveau, prix: libre.prix })
  // Une nuit sans réglage n'a rien à comparer ; « au calcul » non plus.
  assert.equal(libre.sans_reglage, undefined)
  const calcul = await charger({ lignes: [ligneDe(NOEL, p, P.CALCUL, 'l-c')] })()
  assert.equal(calcul.nuits.find(x => x.date === '2026-12-22').sans_reglage, undefined)
})

test('LE TEST QUI COMPTE : chaque événement de l’année a un NOM retrouvé à sa source — férié, pont, week-end prolongé, vacances, date commerciale, les miens', async () => {
  // ⚠ LE NOM VIENT D'UNE CLE INVERSEE. Si le resolveur nommait un pont
  // autrement, le nom tomberait sur `null` et la page afficherait la cle brute.
  const ecran = await charger()()
  const sansNom = ecran.evenements.filter(e => !e.nom)
  assert.deepEqual(sansNom.map(e => e.cle), [], 'événements sans nom')
  const types = new Set(ecran.evenements.map(e => e.type))
  for (const t of ['ferie', 'pont', 'week_end_prolonge', 'vacances_zone', 'vacances_autre', 'commercial', 'evenement']) {
    assert.ok(types.has(t), `la fixture doit couvrir le type ${t}`)
  }
  assert.equal(evenementDe(ecran, 'pont:pont_ascension').nom, 'Ascension')
  const salon = evenementDe(ecran, SALON.segment)
  assert.deepEqual([salon.nom, salon.famille, salon.id, salon.droits.supprimable], ['Salon du chocolat', 'mien', 'ev-salon', true])
  const ferie = ecran.evenements.find(e => e.type === 'ferie')
  assert.deepEqual([ferie.famille, ferie.droits.supprimable, ferie.droits.desactivable], ['officiel', false, false])
  assert.equal(evenementDe(ecran, REVEILLON, '2026-12-24').droits.desactivable, true)
})

test('LE TEST QUI COMPTE (Q6) : les crans posés par les anciennes flèches sont MONTRÉS — partagés quand la clé est large, et une largeur seule n’en est pas un', async () => {
  const reglages = new Map([
    ['week_end_prolonge', { segment: 'week_end_prolonge', crans: 1, actif: true }],
    [NOEL, { segment: NOEL, crans: -1, actif: true, weekends_avant: 2 }],
    ['ferie:noel', { segment: 'ferie:noel', crans: null, actif: true, weekends_apres: 1 }]
  ])
  const ecran = await charger({ reglages })()
  const wep = ecran.evenements.find(e => e.type === 'week_end_prolonge')
  assert.deepEqual(wep.reglage_d_avant, { crans: 1, cle: 'week_end_prolonge', partage: true })
  const noel = evenementDe(ecran, NOEL)
  assert.deepEqual(noel.reglage_d_avant, { crans: -1, cle: NOEL, partage: false })
  assert.deepEqual(noel.largeur, { avant: 2, apres: null })
  const ferieNoel = evenementDe(ecran, 'ferie:noel')
  assert.equal(ferieNoel.reglage_d_avant, null, 'une ligne qui ne porte qu’une largeur n’est pas un réglage')
  assert.deepEqual(ferieNoel.largeur, { avant: null, apres: 1 })
  assert.equal(evenementDe(ecran, 'ferie:jour_de_l_an').reglage_d_avant, null)
})

test('LE TEST QUI COMPTE : une date commerciale COUPÉE reste montrée, une fois, inactive et sans position', async () => {
  const reglages = new Map([['commercial:saint_valentin', { segment: 'commercial:saint_valentin', actif: false, crans: null }]])
  const ecran = await charger({ reglages })()
  const sv = ecran.evenements.filter(e => e.cle === 'commercial:saint_valentin')
  assert.equal(sv.length, 1, 'la Saint-Valentin coupée apparaît une fois (pas aussi son samedi)')
  assert.deepEqual([sv[0].actif, sv[0].positions.length, sv[0].debut], [false, 0, '2027-02-14'])
  assert.ok(ecran.evenements.filter(e => e.cle !== 'commercial:saint_valentin').every(e => e.actif === true))
  // ⚠ 2028 : le 14 février est un lundi, la date a son SAMEDI RATTACHÉ (le 12),
  // porté par le même segment. Une date coupée reste UNE ligne — son samedi
  // n'est pas une seconde chose à reprendre. (Le 14 février 2027 est un
  // dimanche : la fenêtre du banc n'a pas de samedi rattaché.)
  const { commercialesCoupees } = require('../lib/yield/ecran-evenements')
  const en2028 = commercialesCoupees({ reglages, debut: '2027-12-01', fin: '2028-03-01' })
  assert.deepEqual(en2028.map(e => [e.cle, e.debut]), [['commercial:saint_valentin', '2028-02-14']])
})

test('la légende porte les cinq niveaux et leur prix ; l’horizon du calendrier scolaire est dit', async () => {
  const ecran = await charger()()
  assert.deepEqual(ecran.niveaux.map(n => [n.nom, n.prix]), S.NIVEAUX.map((n, i) => [n.nom, NIV[i]]))
  assert.equal(ecran.niveaux_non_calculables, null)
  assert.equal(ecran.vacances_incertaines_apres, '2027-07-03')
  assert.equal(ecran.rayonnement_max, P.RAYONNEMENT_MAX)
  assert.deepEqual(ecran.fenetre, { debut: AUJ, fin: '2027-11-09' })
})

// ─── LE BANC DE L'ENDPOINT ─────────────────────────────────────────────────
const TITULAIRE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const BIEN_A = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: TITULAIRE, name: 'Colomiers', provider: 'channex', provider_property_id: 'ref-a', zone_scolaire: 'C', archive_le: null }
const BIEN_B = { id: 'bb22cc33-dd44-4ee5-8ff6-001122334455', user_id: TITULAIRE, name: 'La bulle', provider: 'channex', provider_property_id: 'ref-b', zone_scolaire: 'C', archive_le: null }
const BIEN_NU = { id: 'cc33dd44-ee55-4ff6-8007-112233445566', user_id: TITULAIRE, name: 'Anglet', provider: 'channex', provider_property_id: null, zone_scolaire: 'B', archive_le: null }
const RANGE = { id: 'dd44ee55-ff66-4007-8118-223344556677', user_id: TITULAIRE, name: 'Rangé', provider: 'channex', provider_property_id: 'ref-r', zone_scolaire: 'C', archive_le: '2026-11-03T20:42:19.342Z' }
const PROFIL = { id: 'profil-1', account_user_id: TITULAIRE, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' }

const MODULES = ['../api/ecran/evenements', '../lib/require-permission', '../lib/permissions', '../lib/compte-requetes']

function preparerEndpoint ({ user = TITULAIRE, profil = null, permissions = null, biens = [BIEN_A, BIEN_B, BIEN_NU, RANGE], assembler = null } = {}) {
  const etat = { tables: [], fetchs: 0, assemblees: [] }
  // ⚠ CHAQUE LECTURE DU DOUBLE PASSE PAR `fetch`, comme supabase-js : sinon le
  // compteur de `Server-Timing` ne serait jamais traverse.
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
        then (ok, ko) { return lire().then(ok, ko) }
      }
      async function lire () {
        await viaFetch('/rest/v1/' + nom)
        if (nom === 'properties') {
          let c = biens.filter(b => q.f.user_id == null || b.user_id === q.f.user_id)
          if ('archive_le' in q.f) c = c.filter(b => b.archive_le === q.f.archive_le)
          if (q.f.id) c = c.filter(b => b.id === q.f.id)
          return { data: c, error: null }
        }
        if (nom === 'profiles') {
          const ok = profil && profil.account_user_id === q.f.account_user_id && profil.member_user_id === q.f.member_user_id
          return { data: ok ? [profil] : [], error: null }
        }
        if (nom === 'profile_permissions') return { data: permissions && profil ? [{ ...permissions, profile_id: profil.id }] : [], error: null }
        return { data: [], error: null }
      }
      return chaine
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  // L'assemblee est doublee ici : son contenu a son propre banc, plus haut.
  const absE = require.resolve('../lib/yield/ecran-evenements')
  const e = new Module(absE)
  e.exports = { assemblerEcranEvenements: async (s, bien, compte, opt) => {
    etat.assemblees.push({ bien: bien.id, compte, opt })
    if (assembler) return assembler(bien)
    return { fenetre: { debut: opt.aujourdHui, fin: opt.aujourdHui }, niveaux: null, evenements: [], nuits: [], reglages_position: { lignes: [], sans_nuit: [], hors_zone: [] } }
  } }
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
const req = (query = {}, method = 'GET', compte = null) => ({ method, query, body: null, headers: { authorization: 'Bearer jeton', ...(compte ? { 'x-compte': compte } : {}) } })
const MEMBRE_SUR_A = (perm = {}) => ({ user: MEMBRE, profil: PROFIL,
  permissions: { reservations: 'read', reglages: 'none', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: ['ref-a'], ...perm } })
async function appeler (opts, query, method, compte) {
  const etat = preparerEndpoint(opts)
  const handler = require('../api/ecran/evenements')
  const res = reponse()
  await handler(req(query, method, compte), res)
  return { res, etat }
}

test('LE TEST QUI COMPTE : un membre limité à un logement ne voit que lui — l’autre n’est ni listé, ni servi', async () => {
  const { res } = await appeler(MEMBRE_SUR_A(), {}, 'GET', TITULAIRE)
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.biens, [{ id: BIEN_A.id, nom: 'Colomiers' }])
  assert.equal(res.body.bien, BIEN_A.id)
  const { res: autre, etat } = await appeler(MEMBRE_SUR_A(), { bien: BIEN_B.id }, 'GET', TITULAIRE)
  assert.equal(autre.code, 404)
  assert.equal(etat.assemblees.length, 0, 'aucun calcul pour un bien hors du périmètre')
  assert.ok(!JSON.stringify(autre.body).includes('La bulle'))
})

test('LE TEST QUI COMPTE : sans le droit « réservations », refus 403 AVANT toute lecture des logements', async () => {
  const { res, etat } = await appeler(MEMBRE_SUR_A({ reservations: 'none' }), {}, 'GET', TITULAIRE)
  assert.equal(res.code, 403)
  assert.equal(etat.tables.includes('properties'), false, 'la liste des logements a été lue avant le refus')
})

test('LE TEST QUI COMPTE : l’en-tête privé est posé avant le premier refus, 405 compris (dette 90)', async () => {
  const { res } = await appeler({}, {}, 'POST')
  assert.equal(res.code, 405)
  assert.equal(res.entetes['cache-control'], 'private, no-store')
  assert.equal(res.entetes.allow, 'GET')
  const sansSession = await appeler({ user: null }, {}, 'GET')
  assert.equal(sansSession.res.code, 401)
  assert.equal(sansSession.res.entetes['cache-control'], 'private, no-store')
})

test('les droits d’écriture suivent « réglages » sur le bien : le titulaire écrit, le membre en lecture non', async () => {
  const titulaire = await appeler({}, { bien: BIEN_B.id })
  assert.equal(titulaire.res.body.droits_ecriture, true)
  const membre = await appeler(MEMBRE_SUR_A(), {}, 'GET', TITULAIRE)
  assert.equal(membre.res.body.droits_ecriture, false)
  const ecrit = await appeler(MEMBRE_SUR_A({ reglages: 'write' }), {}, 'GET', TITULAIRE)
  assert.equal(ecrit.res.body.droits_ecriture, true)
})

test('LE TEST QUI COMPTE : le sélecteur survit — bien non raccordé, calcul en panne : 200, la liste, et le motif', async () => {
  const nu = await appeler({}, { bien: BIEN_NU.id })
  assert.equal(nu.res.code, 200)
  assert.equal(nu.res.body.indisponible, 'bien_non_raccorde')
  assert.equal(nu.etat.assemblees.length, 0)
  assert.equal(nu.res.body.biens.length, 3)
  const panne = await appeler({ assembler: () => { throw new Error('calendar_inventory : panne 10.0.0.12') } }, { bien: BIEN_A.id })
  assert.equal(panne.res.code, 200)
  assert.equal(panne.res.body.indisponible, 'calcul_impossible')
  assert.ok(!JSON.stringify(panne.res.body).includes('10.0.0.12'), 'le message brut de la base ne sort pas')
  assert.equal(panne.res.body.biens.length, 3)
})

test('un logement archivé n’est ni listé ni servi ; un identifiant mal formé est refusé', async () => {
  const { res } = await appeler({}, {})
  assert.deepEqual(res.body.biens.map(b => b.nom), ['Colomiers', 'La bulle', 'Anglet'])
  const range = await appeler({}, { bien: RANGE.id })
  assert.equal(range.res.code, 404)
  const mal = await appeler({}, { bien: 'pas-un-uuid' })
  assert.equal(mal.res.code, 400)
})

test('LE TEST QUI COMPTE (§8) : `Server-Timing` porte le nombre de requêtes, garde comprise, et `calcule_a` l’heure du calcul', async () => {
  const { res, etat } = await appeler({}, { bien: BIEN_A.id })
  assert.equal(res.code, 200)
  const st = res.entetes['server-timing']
  assert.match(st, /^total;dur=\d+;desc="\d+ requêtes"$/)
  assert.equal(Number(st.match(/"(\d+) requêtes"/)[1]), etat.fetchs, 'le compte doit être celui des lectures réellement faites')
  assert.ok(etat.fetchs >= 3, 'session, liste des logements, fiche du bien')
  assert.ok(!Number.isNaN(Date.parse(res.body.calcule_a)))
  assert.deepEqual(etat.assemblees.map(a => [a.bien, a.compte]), [[BIEN_A.id, TITULAIRE]])
  assert.match(etat.assemblees[0].opt.aujourdHui, /^\d{4}-\d{2}-\d{2}$/)
})
