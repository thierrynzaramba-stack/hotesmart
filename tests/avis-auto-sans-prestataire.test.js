// tests/avis-auto-sans-prestataire.test.js — l'horloge de la publication
// automatique quand on ne demande pas son avis a la prestataire (decision de
// Thierry du 9 novembre 2026).
//
// Ce que ces tests gardent. Mesure du 9 novembre en production : La bulle et
// Coeur de vie 23 reglees a 24 h, ZERO publication automatique depuis le
// 2 octobre et 14 evaluations expirees. L'horloge ne partait qu'a la fin de la
// part de la prestataire, et aucune prestataire n'etait autorisee a evaluer :
// « sa part finie » n'arrivait jamais. Regle de Thierry : « si l'avis de la
// prestataire n'est pas demande, ca doit envoyer un message positif en 24 h ».
const test = require('node:test')
const assert = require('node:assert')

const { armerSansPrestataire, prestataireParticipe, executerAutoValidations } = require('../lib/avis/auto-validation')
const { naitreAuDepart, rattacherObjetsRecus } = require('../lib/avis/naissance')
const { GRILLE_DEFAUT } = require('../lib/avis/notes-evaluation')

const H = 3600000
const MAINTENANT = Date.parse('2026-11-09T10:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const GRILLE = JSON.parse(JSON.stringify(GRILLE_DEFAUT))
const TOUT_AU_MEILLEUR = { etat: 'impeccable', degats: 'aucun', poubelles: 'fait', communication: 'excellente', regles: 'oui', recommande: 'oui' }

// ─── Un double de base generique ────────────────────────────────────────────
// Des tables en tableaux, des filtres lus colonne par colonne. Chaque requete
// est tracee : un test compte ce qui a ete lu.
function base (tables = {}, { pannes = [], pannesEcriture = [], apres = {} } = {}) {
  const etat = { requetes: [] }
  for (const [t, lignes] of Object.entries(tables)) etat[t] = lignes.map(l => ({ ...l }))
  const lignesDe = (t) => (etat[t] = etat[t] || [])
  const from = (table) => {
    const q = { table, f: [], op: 'select' }
    etat.requetes.push(q)
    const garde = (r) => q.f.every(([op, c, v]) =>
      op === 'eq' ? r[c] === v
        : op === 'neq' ? r[c] !== v
          : op === 'lte' ? r[c] != null && r[c] <= v
            : op === 'gt' ? r[c] != null && r[c] > v
              : op === 'is' ? (r[c] == null) === (v === null)
                : op === 'in' ? v.includes(r[c]) : true)
    const executer = () => {
      const r = executer1()
      if (apres[table]) apres[table](etat)
      return r
    }
    const executer1 = () => {
      if (pannes.includes(table)) return { data: null, error: { message: 'panne simulee' } }
      if (q.op !== 'select' && pannesEcriture.includes(table)) return { data: null, error: { message: 'ecriture refusee' } }
      const lignes = lignesDe(table)
      if (q.op === 'insert') { for (const l of [].concat(q.ligne)) lignes.push({ ...l }); return { data: null, error: null } }
      if (q.op === 'upsert') {
        const l = q.ligne
        if (lignes.some(r => r.user_id === l.user_id && r.booking_uid === l.booking_uid)) return { data: [], error: null }
        const nee = { id: 'ev-' + (lignes.length + 1), ota_review_id: null, deadline_at: null, auto_publier_le: null,
          answers_host: null, answers_cleaner: null, grille_figee: null, ...l }
        lignes.push(nee)
        return { data: [{ ...nee }], error: null }
      }
      const cibles = lignes.filter(garde)
      if (q.op === 'update') {
        for (const r of cibles) Object.assign(r, q.maj)
        return { data: cibles.map(r => ({ id: r.id })), error: null }
      }
      let out = cibles.map(r => ({ ...r }))
      if (q.limite) out = out.slice(0, q.limite)
      return { data: out, error: null }
    }
    const c = {
      select () { return c },
      eq (k, v) { q.f.push(['eq', k, v]); return c },
      neq (k, v) { q.f.push(['neq', k, v]); return c },
      lte (k, v) { q.f.push(['lte', k, v]); return c },
      gt (k, v) { q.f.push(['gt', k, v]); return c },
      in (k, v) { q.f.push(['in', k, v]); return c },
      is (k, v) { q.f.push(['is', k, v]); return c },
      or () { return c }, not () { return c },
      order () { return c },
      limit (n) { q.limite = n; return c },
      update (maj) { q.op = 'update'; q.maj = maj; return c },
      insert (ligne) { q.op = 'insert'; q.ligne = ligne; return c },
      upsert (ligne) { q.op = 'upsert'; q.ligne = ligne; return c },
      maybeSingle: async () => { const r = executer(); return { data: r.data && r.data[0] ? r.data[0] : (r.error ? null : null), error: r.error } },
      then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) },
    }
    return c
  }
  return { etat, sb: { from } }
}

const NEE = (a = {}) => ({
  id: 'ev-1', user_id: 'u1', property_id: 'bien-1', property_id_ref: 'ref-1', booking_uid: 'BK-1',
  status: 'a_remplir', deadline_at: iso(MAINTENANT + 14 * 24 * H), auto_publier_le: null,
  answers_host: null, answers_cleaner: null, grille_figee: null, ota_review_id: null, ...a,
})
const REGLAGE_24H = [{ user_id: 'u1', property_id: 'bien-1', heures: 24 }]
const MENAGE = (provider = 'presta-1') => [{ user_id: 'u1', property_id: 'ref-1', booking_id: 'BK-1', provider_id: provider }]
const PROFIL = (a = {}) => [{ id: 'presta-1', account_user_id: 'u1', eval_scope: 'aucun', active: true, ...a }]
const armer = (sb, e) => armerSansPrestataire(sb, e, { maintenant: MAINTENANT })

// ─── Qui participe ──────────────────────────────────────────────────────────
test('la prestataire ne participe que si elle est ACTIVE, AUTORISEE, et que la grille lui ouvre une question', async () => {
  const cas = [
    [{ menages: MENAGE(), profiles: PROFIL({ eval_scope: 'selon_grille' }) }, GRILLE, true],
    [{ menages: MENAGE(), profiles: PROFIL() }, GRILLE, false],                                          // `aucun` : le cas de Regina
    [{ menages: MENAGE(), profiles: PROFIL({ eval_scope: 'selon_grille', active: false }) }, GRILLE, false],
    [{ menages: MENAGE(null), profiles: PROFIL({ eval_scope: 'selon_grille' }) }, GRILLE, false],      // personne au menage
    [{ menages: [], profiles: [] }, GRILLE, false],
    // Une grille sans question pour elle : on ne lui demande rien, meme autorisee.
    [{ menages: MENAGE(), profiles: PROFIL({ eval_scope: 'selon_grille' }) }, { criteres: GRILLE.criteres.filter(c => c.rempli_par === 'hote') }, false],
  ]
  for (const [tables, grille, attendu] of cas) {
    const { sb } = base(tables)
    const r = await prestataireParticipe(sb, { userId: 'u1', propertyRef: 'ref-1', bookingUid: 'BK-1', grille })
    assert.strictEqual(r.participe, attendu, JSON.stringify(tables))
  }
})

test('une lecture en panne n’est pas un « non » : elle se dit', async () => {
  const { sb } = base({ profiles: PROFIL() }, { pannes: ['menages'] })
  const r = await prestataireParticipe(sb, { userId: 'u1', propertyRef: 'ref-1', bookingUid: 'BK-1', grille: GRILLE })
  assert.ok(r.erreur)
})

// ─── L'armement ─────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : bien regle a 24 h, prestataire non autorisee — l’horloge part a la naissance (maintenant + 24 h)', async () => {
  const { etat, sb } = base({ guest_evaluations: [NEE()], avis_auto_validation: REGLAGE_24H, menages: MENAGE(), profiles: PROFIL() })
  const r = await armer(sb, NEE())
  assert.deepStrictEqual(r, { arme: true, quand: iso(MAINTENANT + 24 * H) })
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, iso(MAINTENANT + 24 * H))
})

test('a blanc (le script avant --go) : la meme decision, rien n’est ecrit', async () => {
  const { etat, sb } = base({ guest_evaluations: [NEE()], avis_auto_validation: REGLAGE_24H, menages: MENAGE(), profiles: PROFIL() })
  const r = await armerSansPrestataire(sb, NEE(), { maintenant: MAINTENANT, aBlanc: true })
  assert.deepStrictEqual(r, { arme: true, quand: iso(MAINTENANT + 24 * H), aBlanc: true })
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, null)
  assert.strictEqual(etat.requetes.filter(q => q.op === 'update').length, 0)
})

test('sans personne au menage, l’horloge part aussi', async () => {
  const { etat, sb } = base({ guest_evaluations: [NEE()], avis_auto_validation: REGLAGE_24H, menages: [] })
  assert.strictEqual((await armer(sb, NEE())).arme, true)
  assert.ok(etat.guest_evaluations[0].auto_publier_le)
})

test('la prestataire est autorisee : on attend sa part, l’horloge ne part pas ici (chemin d’avant)', async () => {
  const { etat, sb } = base({ guest_evaluations: [NEE()], avis_auto_validation: REGLAGE_24H, menages: MENAGE(), profiles: PROFIL({ eval_scope: 'selon_grille' }) })
  const r = await armer(sb, NEE())
  assert.strictEqual(r.arme, false)
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, null)
})

test('reglage desactive, deja des reponses, horloge deja posee, statut avance, echeance trop proche : rien ne part', async () => {
  const cas = [
    [NEE(), []],
    [NEE({ answers_host: { communication: 'correcte' } }), REGLAGE_24H],
    [NEE({ answers_cleaner: { etat: 'impeccable' } }), REGLAGE_24H],
    [NEE({ auto_publier_le: iso(MAINTENANT + 5 * H) }), REGLAGE_24H],
    [NEE({ status: 'a_valider' }), REGLAGE_24H],
    [NEE({ status: 'abandonnee' }), REGLAGE_24H],
    [NEE({ deadline_at: iso(MAINTENANT + 11 * H) }), REGLAGE_24H],
    [NEE({ property_id_ref: null }), REGLAGE_24H],
  ]
  for (const [e, reglage] of cas) {
    const { etat, sb } = base({ guest_evaluations: [e], avis_auto_validation: reglage, menages: [], profiles: [] })
    const r = await armer(sb, e)
    assert.strictEqual(r.arme, false, JSON.stringify(e))
    assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, e.auto_publier_le, JSON.stringify(e))
  }
})

test('l’echeance est plafonnee 12 h avant celle d’Airbnb', async () => {
  const e = NEE({ deadline_at: iso(MAINTENANT + 30 * H) })
  const { sb } = base({ guest_evaluations: [e], avis_auto_validation: [{ user_id: 'u1', property_id: 'bien-1', heures: 48 }], menages: [] })
  assert.strictEqual((await armer(sb, e)).quand, iso(MAINTENANT + 18 * H))
})

test('l’hote a repondu entre la lecture et l’ecriture : l’ecriture conditionnee ne pose rien sur une evaluation avancee', async () => {
  const lue = NEE()
  const { etat, sb } = base({ guest_evaluations: [NEE({ status: 'a_valider' })], avis_auto_validation: REGLAGE_24H, menages: [] })
  const r = await armer(sb, lue)
  assert.strictEqual(r.arme, false)
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, null)
})

test('une panne de reglage ou de menage se dit, et ne pose rien', async () => {
  for (const panne of ['avis_auto_validation', 'menages']) {
    const { etat, sb } = base({ guest_evaluations: [NEE()], avis_auto_validation: REGLAGE_24H }, { pannes: [panne] })
    const r = await armer(sb, NEE())
    assert.ok(r.erreur, panne)
    assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, null, panne)
  }
})

// ─── A l'echeance ───────────────────────────────────────────────────────────
function outils () {
  const appels = { rediger: [], publier: [] }
  return {
    appels,
    rediger: async (e) => { appels.rediger.push(e); return { ok: true, public_text: 'Merci !' } },
    publier: async (e) => { appels.publier.push(e); return { code: 200, body: { ok: true, simulation: true } } },
  }
}
const ECHUE = (a = {}) => NEE({ auto_publier_le: iso(MAINTENANT - 60000), ota_review_id: 'objet-1', ...a })
const lancer = (sb, o) => executerAutoValidations(sb, { maintenant: MAINTENANT, outils: o, deps: { envoyer: async () => {} } })

test('LE TEST QUI COMPTE : a l’echeance, sans prestataire, TOUTES les questions prennent le meilleur niveau, la grille se fige, l’avis part en positif', async () => {
  const { etat, sb } = base({ guest_evaluations: [ECHUE()], avis_auto_validation: REGLAGE_24H, menages: MENAGE(), profiles: PROFIL() })
  const o = outils()
  const bilan = await lancer(sb, o)
  assert.strictEqual(bilan.publiees, 1, JSON.stringify(bilan))
  const e = etat.guest_evaluations[0]
  assert.deepStrictEqual(e.answers_host, TOUT_AU_MEILLEUR)
  assert.deepStrictEqual(e.grille_figee.criteres.map(c => c.cle), GRILLE.criteres.map(c => c.cle), 'la grille est figee a la prise')
  assert.strictEqual(e.auto_publier_le, null)
  assert.strictEqual(o.appels.rediger.length, 1, 'le texte est redige, il n existait pas')
  assert.ok(o.appels.rediger[0].grille_figee, 'la redaction lit la meme grille')
  assert.deepStrictEqual(o.appels.publier[0].answers_host, TOUT_AU_MEILLEUR)
  assert.strictEqual(etat.core_events[0].type, 'avis.auto_publiee')
})

test('a l’echeance, la prestataire est devenue autorisee entre-temps et sa part est vide : rien ne part, l’hote est prevenu', async () => {
  const { etat, sb } = base({ guest_evaluations: [ECHUE()], avis_auto_validation: REGLAGE_24H, menages: MENAGE(), profiles: PROFIL({ eval_scope: 'selon_grille' }) })
  const o = outils()
  await lancer(sb, o)
  assert.strictEqual(o.appels.publier.length, 0)
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, null)
  assert.strictEqual(etat.guest_evaluations[0].answers_host, null, 'rien n est ecrit au nom de l hote')
  assert.ok((etat.agent_tasks || []).length, 'l hote est prevenu')
})

test('la part de la prestataire est finie (chemin d’avant) : aucune lecture de menage ni de prestataire', async () => {
  const { etat, sb } = base({
    guest_evaluations: [ECHUE({ status: 'soumise_prestataire', grille_figee: GRILLE, answers_cleaner: { etat: 'impeccable', degats: 'aucun', poubelles: 'fait' }, public_text: 'Merci.' })],
    avis_auto_validation: REGLAGE_24H,
  })
  const o = outils()
  const bilan = await lancer(sb, o)
  assert.strictEqual(bilan.publiees, 1)
  assert.strictEqual(etat.requetes.filter(q => q.table === 'menages' || q.table === 'profiles').length, 0)
  assert.ok(!('grille_figee' in (etat.requetes.find(q => q.op === 'update' && q.maj && 'answers_host' in q.maj) || { maj: {} }).maj), 'une grille deja figee n est pas reecrite')
})

test('une lecture de menage en panne a l’echeance : report d’une heure, rien ne part, rien n est desarme', async () => {
  const { etat, sb } = base({ guest_evaluations: [ECHUE()], avis_auto_validation: REGLAGE_24H }, { pannes: ['menages'] })
  const o = outils()
  const bilan = await lancer(sb, o)
  assert.strictEqual(o.appels.publier.length, 0)
  assert.strictEqual(bilan.erreurs, 1)
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, iso(MAINTENANT + H))
})

// ─── A la naissance ─────────────────────────────────────────────────────────
const jourParis = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(ms))

test('LE TEST QUI COMPTE : le jour du depart, l’evaluation nait ET son horloge part, sans prestataire autorisee', async () => {
  const { etat, sb } = base({
    menages: [{ user_id: 'u1', property_id: 'ref-1', booking_id: 'BK-1', departure_date: jourParis(MAINTENANT), status: 'pending', provider_id: 'presta-1' }],
    bookings_snapshot: [{ user_id: 'u1', booking_id: 'BK-1', property_id: 'ref-1', snapshot: { provider: 'channex', source: 'Airbnb', status: 'confirmed' } }],
    properties: [{ id: 'bien-1', user_id: 'u1', provider_property_id: 'ref-1' }],
    guest_evaluations: [],
    avis_auto_validation: REGLAGE_24H,
    profiles: PROFIL(),
  })
  const bilan = await naitreAuDepart(sb, { maintenant: MAINTENANT })
  assert.strictEqual(bilan.crees, 1, JSON.stringify(bilan))
  assert.strictEqual(bilan.armees, 1, JSON.stringify(bilan))
  // ⚠ COMPTE DEPUIS LE CHECK-OUT (midi, heure de Paris), pas depuis la
  // naissance a minuit (revue de 6e73da3, constat 2) : le 9 novembre, midi a
  // Paris = 11:00 UTC.
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, '2026-11-10T11:00:00.000Z')
  assert.strictEqual(etat.core_events[0].type, 'avis.auto_armee')
})

test('le jour du depart, prestataire autorisee : l’evaluation nait SANS horloge (elle attend sa part)', async () => {
  const { etat, sb } = base({
    menages: [{ user_id: 'u1', property_id: 'ref-1', booking_id: 'BK-1', departure_date: jourParis(MAINTENANT), status: 'pending', provider_id: 'presta-1' }],
    bookings_snapshot: [{ user_id: 'u1', booking_id: 'BK-1', property_id: 'ref-1', snapshot: { provider: 'channex', source: 'Airbnb', status: 'confirmed' } }],
    properties: [{ id: 'bien-1', user_id: 'u1', provider_property_id: 'ref-1' }],
    guest_evaluations: [],
    avis_auto_validation: REGLAGE_24H,
    profiles: PROFIL({ eval_scope: 'selon_grille' }),
  })
  const bilan = await naitreAuDepart(sb, { maintenant: MAINTENANT })
  assert.strictEqual(bilan.crees, 1)
  assert.ok(!bilan.armees)
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, null)
})

test('une evaluation nee de l’objet Channex arme aussi son horloge', async () => {
  const { etat, sb } = base({
    ota_reviews: [{ id: 'objet-1', user_id: 'u1', provider: 'channex', external_review_id: 'rev-1', expired_at: iso(MAINTENANT + 20 * 24 * H) }],
    guest_evaluations: [],
    avis_auto_validation: REGLAGE_24H,
    menages: [],
  })
  const ligne = {
    user_id: 'u1', property_id: 'bien-1', property_id_ref: 'ref-1', provider: 'channex', ota: 'airbnb',
    external_review_id: 'rev-1', booking_uid: 'BK-1', expired_at: iso(MAINTENANT + 20 * 24 * H), received_at: iso(MAINTENANT - H),
  }
  const bilan = await rattacherObjetsRecus(sb, [ligne], { maintenant: MAINTENANT })
  assert.strictEqual(bilan.crees, 1, JSON.stringify(bilan))
  assert.strictEqual(bilan.armees, 1, JSON.stringify(bilan))
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, iso(MAINTENANT + 24 * H))
})

// ─── Constats de la revue de 6e73da3 ────────────────────────────────────────
test('JAMAIS DEUX FOIS : une evaluation deja armee une fois (marque au journal) ne se rearme pas', async () => {
  const marque = { user_id: 'u1', type: 'avis.auto_armee', subject_type: 'guest_evaluation', subject_id: 'ev-1' }
  const { etat, sb } = base({ guest_evaluations: [NEE()], avis_auto_validation: REGLAGE_24H, menages: [], core_events: [marque] })
  const r = await armer(sb, NEE())
  assert.deepStrictEqual(r, { arme: false, motif: 'deja armee une fois' })
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, null)
})

test('la marque d’un AUTRE compte ou d’une autre evaluation n’empeche rien', async () => {
  const autres = [
    { user_id: 'u2', type: 'avis.auto_armee', subject_type: 'guest_evaluation', subject_id: 'ev-1' },
    { user_id: 'u1', type: 'avis.auto_armee', subject_type: 'guest_evaluation', subject_id: 'ev-9' },
  ]
  const { sb } = base({ guest_evaluations: [NEE()], avis_auto_validation: REGLAGE_24H, menages: [], core_events: autres })
  assert.strictEqual((await armer(sb, NEE())).arme, true)
})

test('la marque est posee AVANT l’horloge ; sans marque possible, pas d’horloge', async () => {
  const a = base({ guest_evaluations: [NEE()], avis_auto_validation: REGLAGE_24H, menages: [] })
  await armer(a.sb, NEE())
  const ordre = a.etat.requetes.filter(q => q.op !== 'select').map(q => q.table)
  assert.deepStrictEqual(ordre, ['core_events', 'guest_evaluations'])
  const b = base({ guest_evaluations: [NEE()], avis_auto_validation: REGLAGE_24H, menages: [] }, { pannesEcriture: ['core_events'] })
  const r = await armer(b.sb, NEE())
  assert.ok(r.erreur)
  assert.strictEqual(b.etat.guest_evaluations[0].auto_publier_le, null)
})

test('l’hote a coche UNE reponse (statut toujours a_remplir) entre la lecture et l’ecriture : pas d’horloge', async () => {
  const { etat, sb } = base({ guest_evaluations: [NEE({ answers_host: { communication: 'correcte' } })], avis_auto_validation: REGLAGE_24H, menages: [] })
  const r = await armer(sb, NEE())
  assert.strictEqual(r.arme, false)
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, null)
})

test('le script exige le delai plein : plafonne par Airbnb, l’evaluation n’est PAS armee et le dit', async () => {
  const e = NEE({ deadline_at: iso(MAINTENANT + 30 * H) })
  const { etat, sb } = base({ guest_evaluations: [e], avis_auto_validation: REGLAGE_24H, menages: [] })
  const r = await armerSansPrestataire(sb, e, { maintenant: MAINTENANT, exigerDelaiPlein: true })
  assert.deepStrictEqual(r, { arme: false, motif: 'delai plein impossible avant l echeance', plafonne: iso(MAINTENANT + 18 * H) })
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, null)
  const loin = NEE({ deadline_at: iso(MAINTENANT + 5 * 24 * H) })
  const b = base({ guest_evaluations: [loin], avis_auto_validation: REGLAGE_24H, menages: [] })
  assert.strictEqual((await armerSansPrestataire(b.sb, loin, { maintenant: MAINTENANT, exigerDelaiPlein: true })).arme, true)
})

test('CLOISONNEMENT : le menage et la prestataire d’un AUTRE compte ne comptent pas', async () => {
  const cas = [
    // Un menage du compte u2, meme bien, meme sejour, prestataire autorisee.
    { menages: [{ user_id: 'u2', property_id: 'ref-1', booking_id: 'BK-1', provider_id: 'presta-1' }], profiles: PROFIL({ eval_scope: 'selon_grille' }) },
    // Notre menage, mais un profil autorise qui appartient au compte u2.
    { menages: MENAGE(), profiles: PROFIL({ eval_scope: 'selon_grille', account_user_id: 'u2' }) },
  ]
  for (const tables of cas) {
    const { sb } = base(tables)
    const r = await prestataireParticipe(sb, { userId: 'u1', propertyRef: 'ref-1', bookingUid: 'BK-1', grille: GRILLE })
    assert.strictEqual(r.participe, false, JSON.stringify(tables))
  }
})

// Une grille PROPRE a l'hote : les cles sont des identifiants de base, pas
// celles de la grille par defaut. C'est elle qui doit etre completee, figee,
// redigee et publiee — jamais la grille par defaut.
const NIV = (prefixe, notes) => notes.map((n, i) => ({ cle: `${prefixe}-${i}`, libelle: `${prefixe} ${i}`, rang: i + 1, note: n, negatif: n <= 2 }))
const CRITERES_HOTE = [
  { id: 'c-proprete-uuid', user_id: 'u1', property_id: null, libelle: 'Propreté', categorie: 'cleanliness', rempli_par: 'prestataire', rang: 1, actif: true, avis_criteres_niveaux: NIV('p', [3, 5, 1]) },
  { id: 'c-comm-uuid', user_id: 'u1', property_id: null, libelle: 'Communication', categorie: 'communication', rempli_par: 'hote', rang: 2, actif: true, avis_criteres_niveaux: NIV('m', [4, 5]) },
  { id: 'c-reco-uuid', user_id: 'u1', property_id: null, libelle: 'Recommandation', categorie: 'recommandation', rempli_par: 'hote', rang: 3, actif: true,
    avis_criteres_niveaux: [{ cle: 'non', libelle: 'Non', rang: 1, recommande: false, negatif: true }, { cle: 'oui', libelle: 'Oui', rang: 2, recommande: true, negatif: false }] },
]

test('LE TEST QUI COMPTE : une grille PROPRE a l’hote est celle qui est completee, figee, redigee et publiee', async () => {
  const { etat, sb } = base({ guest_evaluations: [ECHUE()], avis_auto_validation: REGLAGE_24H, menages: MENAGE(), profiles: PROFIL(), avis_criteres: CRITERES_HOTE })
  const o = outils()
  const bilan = await lancer(sb, o)
  assert.strictEqual(bilan.publiees, 1, JSON.stringify(bilan))
  const attendu = { 'c-proprete-uuid': 'p-1', 'c-comm-uuid': 'm-1', 'c-reco-uuid': 'oui' }
  const e = etat.guest_evaluations[0]
  assert.deepStrictEqual(e.answers_host, attendu, 'la meilleure NOTE, pas le premier rang')
  assert.deepStrictEqual(e.grille_figee.criteres.map(c => c.cle), ['c-proprete-uuid', 'c-comm-uuid', 'c-reco-uuid'])
  assert.deepStrictEqual(o.appels.rediger[0].grille_figee.criteres.map(c => c.cle), ['c-proprete-uuid', 'c-comm-uuid', 'c-reco-uuid'])
  assert.deepStrictEqual(o.appels.publier[0].answers_host, attendu)
})

test('une prestataire coche sa part pendant l’echeance : la prise renonce, sa reponse n’est pas ecrasee', async () => {
  const { etat, sb } = base(
    { guest_evaluations: [ECHUE()], avis_auto_validation: REGLAGE_24H, menages: MENAGE(), profiles: PROFIL() },
    { apres: { profiles: (s) => { s.guest_evaluations[0].answers_cleaner = { etat: 'correct' } } } },
  )
  const o = outils()
  await lancer(sb, o)
  assert.strictEqual(o.appels.publier.length, 0)
  assert.deepStrictEqual(etat.guest_evaluations[0].answers_cleaner, { etat: 'correct' })
  assert.strictEqual(etat.guest_evaluations[0].answers_host, null)
})

test('une panne de lecture pres du plafond : on renonce et l’hote est prevenu, pas de report dans les 12 dernieres heures', async () => {
  const { etat, sb } = base({ guest_evaluations: [ECHUE({ deadline_at: iso(MAINTENANT + 12.5 * H) })], avis_auto_validation: REGLAGE_24H }, { pannes: ['menages'] })
  const o = outils()
  await lancer(sb, o)
  assert.strictEqual(o.appels.publier.length, 0)
  assert.strictEqual(etat.guest_evaluations[0].auto_publier_le, null)
  assert.ok((etat.agent_tasks || []).length, 'l hote est prevenu')
})

test('une evaluation nee de l’objet Channex dont l’horloge echoue : comptee a part, pas en « non nee »', async () => {
  const { sb } = base({
    ota_reviews: [{ id: 'objet-1', user_id: 'u1', provider: 'channex', external_review_id: 'rev-1', expired_at: iso(MAINTENANT + 20 * 24 * H) }],
    guest_evaluations: [], avis_auto_validation: REGLAGE_24H,
  }, { pannes: ['menages'] })
  const ligne = {
    user_id: 'u1', property_id: 'bien-1', property_id_ref: 'ref-1', provider: 'channex', ota: 'airbnb',
    external_review_id: 'rev-1', booking_uid: 'BK-1', expired_at: iso(MAINTENANT + 20 * 24 * H), received_at: iso(MAINTENANT - H),
  }
  const bilan = await rattacherObjetsRecus(sb, [ligne], { maintenant: MAINTENANT })
  assert.strictEqual(bilan.crees, 1)
  assert.strictEqual(bilan.erreurs, 0)
  assert.strictEqual(bilan.erreurs_armement, 1)
})
