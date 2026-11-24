// tests/charges-ecran.test.js — l'appel d'écran `/api/ecran/charges` et ses
// lectures (`lib/charges/ecran.js`). Compte de charges, lot 3.
// Spec : docs/specs/spec-compte-de-charges.md §13.5 à §13.7.
//
// ⚠ CE QUI COMPTE ICI : un membre est refusé AVANT toute lecture (Q9) ; chaque
// lecture porte le compte de la garde ; les totaux viennent du résumé par UNE
// fonction et un montant absent reste `null` ; la liste se pagine par curseur.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const { baseEnregistreuse, filtre } = require('./outils/base-enregistreuse')
const ecran = require('../lib/charges/ecran')
const { jourParis } = require('../lib/charges/regles')

const TITULAIRE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const ENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ENT_AUTRE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const BIEN_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const BIEN_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const TOTAUX = {
  total: { ht: 10000, tva: 2000, ttc: null, nb_factures: 2, nb_non_verifiees: 1, nb_signaux: 0, nb_sans_ht: 0, nb_sans_tva: 0, nb_sans_ttc: 1 },
  par_mois: [], par_categorie: [], par_bien: [], calcule_le: '2026-11-10T19:00:00Z'
}

// Les entités du compte, comme les rend lib/entites-juridiques.js.
function entitesDouble ({ entites = [], panne = false } = {}) {
  const appels = []
  return {
    appels,
    entitesDuCompte: async (u) => { appels.push(['entites', u]); return panne ? { ok: false, motif: 'panne' } : { ok: true, entites } },
    liensDuCompte: async (u) => { appels.push(['liens', u]); return { ok: true, liens: [{ property_uuid: BIEN_1, entite_id: ENT_A }] } }
  }
}

/**
 * Appelle le VRAI endpoint, garde doublée (titulaire ou membre).
 * `repondre(r)` répond aux requêtes ; `rpc(nom, args)` à la fonction des totaux.
 */
async function appeler ({ methode = 'GET', query = {}, titulaire = true, repondre, rpc, entites } = {}) {
  const { client, requetes, rpcs } = baseEnregistreuse(repondre || (() => ({ data: [], error: null, count: 0 })), {
    rpc: rpc || (() => ({ data: TOTAUX, error: null }))
  })
  const absGarde = require.resolve('../lib/require-permission')
  require('../lib/require-permission')
  const vraieGarde = require.cache[absGarde].exports
  const contexte = titulaire
    ? { userId: TITULAIRE, accountUserId: TITULAIRE, profil: null, permissions: null }
    : { userId: MEMBRE, accountUserId: TITULAIRE, profil: { active: true }, permissions: { facturation: 'write', reglages: 'write' } }
  let gardeAppelee = 0
  require.cache[absGarde].exports = Object.assign({}, vraieGarde, {
    contexteDEcran: async () => { gardeAppelee++; return { ok: true, userId: contexte.userId, accountUserId: TITULAIRE, contexte } }
  })
  const absEndpoint = require.resolve('../api/ecran/charges')
  delete require.cache[absEndpoint]
  const { handler } = require(absEndpoint)
  const ej = entites || entitesDouble({ entites: [
    { id: ENT_A, nom: 'Moi', archivee_le: null, debut_exercice: null },
    { id: ENT_B, nom: 'SCI', archivee_le: null, debut_exercice: '04-01' }
  ] })
  const rep = { statut: null, corps: null, entetes: {} }
  const res = {
    headersSent: false,
    setHeader (k, v) { rep.entetes[String(k).toLowerCase()] = v },
    status (s) { rep.statut = s; return res },
    json (c) { rep.corps = c; return res }
  }
  try {
    await handler({ method: methode, headers: {}, query }, res, { db: client, entites: ej })
  } finally {
    require.cache[absGarde].exports = vraieGarde
    delete require.cache[absEndpoint]
  }
  return { rep, requetes, rpcs, ej, gardeAppelee }
}

const CREE = '2026-10-15T08:30:00.123456+00:00'
const ligne = (n, jour = '2026-11-01', extra = {}) => ({ id: uuid(n), user_id: TITULAIRE, statut: 'validee', jour, cree_le: CREE, montant_ttc_cents: 1000, ...extra })

// ─── La garde ────────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un POST est refusé en 405, en-tête privé posé AVANT, sans garde ni lecture', async () => {
  const r = await appeler({ methode: 'POST' })
  assert.equal(r.rep.statut, 405)
  assert.equal(r.rep.entetes.allow, 'GET')
  assert.match(String(r.rep.entetes['cache-control']), /private/)
  assert.match(String(r.rep.entetes['cache-control']), /no-store/)
  assert.equal(r.gardeAppelee, 0)
  assert.equal(r.requetes.length + r.rpcs.length, 0)
})

test('LE TEST QUI COMPTE : un MEMBRE délégué est refusé en 403 AVANT TOUTE LECTURE (Q9)', async () => {
  const r = await appeler({ titulaire: false })
  assert.equal(r.rep.statut, 403)
  assert.match(String(r.rep.entetes['cache-control']), /private, no-store/)
  assert.equal(r.requetes.length, 0, 'aucune requête Supabase')
  assert.equal(r.rpcs.length, 0, 'aucun totaux')
  assert.deepEqual(r.ej.appels, [], 'aucune lecture des entités')
})

// ─── L'écran entier ──────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : chaque lecture porte le compte de la GARDE, et les totaux viennent de `charges_totaux`', async () => {
  const r = await appeler({
    repondre: (q) => {
      if (q.table === 'properties') return { data: [{ id: BIEN_1, name: 'Studio', archive_le: null, user_id: TITULAIRE }, { id: BIEN_2, name: 'Vieux', archive_le: '2026-01-01', user_id: TITULAIRE }], error: null }
      if (q.optionsSelect && q.optionsSelect.count) return { data: [ligne(1, '2026-11-02', { statut: 'a_verifier' })], error: null, count: 7 }
      return { data: [ligne(2)], error: null }
    }
  })
  assert.equal(r.rep.statut, 200)
  for (const q of r.requetes) assert.equal(filtre(q, 'user_id'), TITULAIRE, `${q.table} sans le compte`)
  assert.deepEqual(r.ej.appels.map(a => a[1]), [TITULAIRE, TITULAIRE])
  // Lot 5 bis : les bornes « sans entité » (p_entite NULL) disent si l'option
  // « Sans entité juridique » est offerte.
  assert.deepEqual(r.rpcs.map(x => x.nom).sort(), ['charges_exercices_bornes', 'charges_exercices_bornes', 'charges_totaux'])
  assert.deepEqual(r.rpcs.filter(x => x.nom === 'charges_exercices_bornes').map(x => x.args.p_entite).sort(), [ENT_A, null].sort())
  for (const x of r.rpcs) assert.equal(x.args.p_user, TITULAIRE)
  // ⚠ Plus de « toutes les entités » (§14.21, décision 7) : sans entité
  // demandée, la première ACTIVE par son nom — « Moi » avant « SCI ».
  assert.equal(r.rpcs.find(x => x.nom === 'charges_totaux').args.p_entite, ENT_A)
  assert.equal(r.rep.corps.entite, ENT_A)

  const c = r.rep.corps
  assert.equal(c.a_traiter.nombre, 7, 'le nombre EXACT, compté en base, pas la longueur de la page')
  assert.equal(c.a_traiter.lignes.length, 1)
  assert.equal(c.liste.lignes.length, 1)
  assert.equal(c.liste.suite, null)
  assert.deepEqual(c.entites.map(e => [e.id, e.debut_exercice]), [[ENT_A, null], [ENT_B, '04-01']])
  assert.deepEqual(c.biens, [{ id: BIEN_1, nom: 'Studio', entite_id: ENT_A }], 'les logements ACTIFS seulement')
  assert.deepEqual(c.biens_archives, [{ id: BIEN_2, nom: 'Vieux', entite_id: null }])
  assert.equal(c.categories.length, 15)
  assert.equal(c.categories[0], 'menage')
  assert.match(String(r.rep.entetes['server-timing']), /requêtes/)
})

test('LE TEST QUI COMPTE : un montant absent reste `null` jusqu\'à la page — jamais 0', async () => {
  const r = await appeler()
  assert.equal(r.rep.corps.totaux.total.ttc, null)
  assert.equal(r.rep.corps.totaux.total.nb_sans_ttc, 1)
  assert.equal(r.rep.corps.totaux.calcule_le, '2026-11-10T19:00:00Z', "l'heure du calcul est servie")
})

test('LE TEST QUI COMPTE (§14.21) : sans entité demandée, ou « toutes » (un lien d\'avant), la première entité active par son nom — et son exercice civil, le réglage standard', async () => {
  for (const query of [{}, { entite: 'toutes' }]) {
    const r = await appeler({ query })
    assert.equal(r.rep.statut, 200)
    const t = r.rep.corps.totaux
    const attendu = ecran.bornesPeriode({ entite: { debut_exercice: null }, aujourdhui: jourParis() })
    assert.equal(t.entite, ENT_A)
    assert.equal(t.periode, attendu.periode)
    assert.equal(t.debut, `${attendu.periode}-01-01`)
    assert.equal(t.fin, `${attendu.periode}-12-31`)
    assert.equal(t.standard, true, 'l\'écran dit « réglage standard »')
    const tot = r.rpcs.find(x => x.nom === 'charges_totaux')
    assert.deepEqual([tot.args.p_debut, tot.args.p_fin, tot.args.p_entite], [t.debut, t.fin, ENT_A])
    // La liste suit l'entité ; « À traiter » reste commun au compte.
    const liste = r.requetes.find(q => q.table === 'charges' && !(q.optionsSelect && q.optionsSelect.count))
    assert.equal(filtre(liste, 'entite_juridique_id'), ENT_A)
    const file = r.requetes.find(q => q.table === 'charges' && q.optionsSelect && q.optionsSelect.count)
    assert.equal(filtre(file, 'entite_juridique_id'), undefined)
  }
})

test('une SCI au 1er avril se lit par exercice d\'avril à mars ; les exercices proposés viennent des bornes du résumé', async () => {
  const r = await appeler({
    query: { entite: ENT_B, periode: '2025' },
    rpc: (nom) => (nom === 'charges_exercices_bornes' ? { data: { premier: '2023-05-10', dernier: '2026-02-01' }, error: null } : { data: TOTAUX, error: null })
  })
  assert.equal(r.rep.statut, 200)
  const t = r.rep.corps.totaux
  assert.equal(t.entite, ENT_B)
  assert.equal(t.periode, '2025')
  assert.equal(t.debut, '2025-04-01')
  assert.equal(t.fin, '2026-03-31')
  assert.equal(t.standard, false)
  const enCours = ecran.anneeDExercice(jourParis(), '04-01')
  assert.equal(t.proposees[0], String(Math.max(enCours, 2025)))
  assert.equal(t.proposees[t.proposees.length - 1], '2023', 'du premier exercice qui porte une facture')
  assert.ok(r.rpcs.some(x => x.nom === 'charges_exercices_bornes' && x.args.p_entite === ENT_B))
})

test('un compte SANS entité ni facture d\'un logement sans entité : « À traiter » et la liste, pas de totaux', async () => {
  const r = await appeler({ entites: entitesDouble({ entites: [] }) })
  assert.equal(r.rep.statut, 200)
  assert.deepEqual(r.rep.corps.totaux, { sans_entite: true })
  assert.equal(r.rep.corps.entite, null)
  // La seule lecture du résumé : la présence « sans entité » (lot 5 bis).
  assert.deepEqual(r.rpcs.map(x => [x.nom, x.args.p_entite]), [['charges_exercices_bornes', null]])
})

test('LE TEST QUI COMPTE : une entité qui n\'est pas du compte rend 404, sans totaux', async () => {
  const r = await appeler({ query: { entite: ENT_AUTRE } })
  assert.equal(r.rep.statut, 404)
  assert.ok(!r.rpcs.some(x => x.nom === 'charges_totaux' || x.args.p_entite === ENT_AUTRE))
})

test('une entité mal formée rend 400', async () => {
  const r = await appeler({ query: { entite: "x' or 1=1" } })
  assert.equal(r.rep.statut, 400)
  assert.equal(r.rpcs.length, 0)
})

test('les totaux en panne se DISENT (`null`) sans casser l\'écran ; la liste en panne rend 503', async () => {
  const a = await appeler({ rpc: () => ({ data: null, error: { message: 'panne' } }) })
  assert.equal(a.rep.statut, 200)
  assert.equal(a.rep.corps.totaux, null)
  // Un tableau n'est pas un objet de totaux (une fonction qui rendrait des lignes).
  const b = await appeler({ rpc: () => ({ data: [], error: null }) })
  assert.equal(b.rep.corps.totaux, null)
  const c = await appeler({ repondre: (q) => (q.table === 'charges' ? { data: null, error: { message: 'panne' } } : { data: [], error: null }) })
  assert.equal(c.rep.statut, 503)
})

test('les entités en panne rendent 503, sans autre lecture que la présence « sans entité » partie avec elles', async () => {
  const r = await appeler({ entites: entitesDouble({ panne: true }) })
  assert.equal(r.rep.statut, 503)
  // Lot 5 bis (§14.25) : la présence d'un total « Sans entité » part EN MÊME
  // TEMPS que les entités (un compte sans entité ouvre dessus) ; rien après.
  assert.equal(r.requetes.length, 0)
  assert.deepEqual(r.rpcs.map(x => [x.nom, x.args.p_entite]), [['charges_exercices_bornes', null]])
})

// ─── La liste, par curseur ───────────────────────────────────────────────────
test('LE TEST QUI COMPTE : 51 lignes lues = une page de 50 et un curseur « jour|arrivée|id » sur la 50e', async () => {
  const lignes = Array.from({ length: 51 }, (_, i) => ligne(100 - i, '2026-10-15'))
  const r = await appeler({ repondre: (q) => (q.optionsSelect && q.optionsSelect.count ? { data: [], error: null, count: 0 } : (q.table === 'charges' ? { data: lignes, error: null } : { data: [], error: null })) })
  const l = r.rep.corps.liste
  assert.equal(l.lignes.length, 50)
  assert.equal(l.suite, `2026-10-15|${CREE}|${lignes[49].id}`)
  const q = r.requetes.find(x => x.table === 'charges' && !(x.optionsSelect && x.optionsSelect.count))
  assert.equal(q.limite, 51)
  assert.deepEqual(q.ordre, [['jour', false], ['cree_le', false], ['id', false]], 'jour, puis arrivée (spec §13.2)')
  assert.ok(q.filtres.some(f => f[0] === 'neq' && f[1] === 'statut' && f[2] === 'envoi'), 'un envoi pas encore confirmé n\'est pas une facture')
})

test('« Afficher plus » : la page suivante SEULE, filtrée par le curseur', async () => {
  const r = await appeler({ query: { curseur: `2026-10-15|${CREE}|${uuid(51)}` } })
  assert.equal(r.rep.statut, 200)
  assert.deepEqual(Object.keys(r.rep.corps), ['liste'])
  assert.equal(r.requetes.length, 1)
  assert.equal(r.rpcs.length, 0)
  assert.deepEqual(r.ej.appels, [])
  const q = r.requetes[0]
  assert.equal(filtre(q, 'user_id'), TITULAIRE)
  const or = q.filtres.find(f => f[0] === 'or')
  assert.equal(or[1], `jour.lt.2026-10-15,and(jour.eq.2026-10-15,cree_le.lt."${CREE}"),and(jour.eq.2026-10-15,cree_le.eq."${CREE}",id.lt.${uuid(51)})`)
})

test('LE TEST QUI COMPTE : un curseur forgé est refusé AVANT d\'entrer dans le filtre (400)', async () => {
  for (const c of ['2026-10-15', `2026-10-15|${uuid(1)}`, `2026-10-15|${CREE}|${uuid(1)},user_id.neq.x`, `2026-10-15|${CREE}"),user_id.neq.(x|${uuid(1)}`, `2026-10-15|2026-10-15|${uuid(1)}`, 'x|y|z', `15-10-2026|${CREE}|${uuid(1)}`, `2026-10-15|${CREE}|${uuid(1)}|en-trop`]) {
    const r = await appeler({ query: { curseur: c } })
    assert.equal(r.rep.statut, 400, c)
    assert.equal(r.requetes.length, 0, c)
  }
})

test('« À traiter » : à lire, à vérifier, illisible, et tout signal non tranché ; jamais un envoi', async () => {
  const r = await appeler()
  const q = r.requetes.find(x => x.table === 'charges' && x.optionsSelect && x.optionsSelect.count === 'exact')
  assert.ok(q, 'la file compte en base')
  assert.equal(q.limite, 51, 'une page de 50, plus une ligne pour savoir s\'il y a une suite (lot 8c, dette 153)')
  assert.deepEqual(q.filtres.find(f => f[0] === 'or'), ['or', 'statut.in.(a_lire,a_verifier,illisible,tableau,sans_facture),and(signal.not.is.null,signal_tranche.is.false)'], 'un tableau reconnu attend son import (§14.21.3) ; un e-mail sans facture lisible se voit (lot 5)')
  assert.ok(q.filtres.some(f => f[0] === 'neq' && f[2] === 'envoi'))
  assert.doesNotMatch(q.colonnes, /justificatif_chemin/, 'jamais le chemin du fichier')
  // ⚠ De la réponse de l'IA, le SEUL solde d'une régularisation (lot 7a).
  assert.deepEqual(q.colonnes.match(/[\w:>-]*lecture_ia[\w:>-]*/g), ['solde_lu:lecture_ia->solde_ttc_cents', 'tableau_lu:lecture_ia->tableau'], 'jamais la réponse brute de l\'IA entière : le solde d\'une régularisation, et les bornes d\'un tableau reconnu (lot 8b)')
})

// ─── Lot 8c : la suite de « À traiter », le parcours ────────────────────────
test('8c : `suite_a_traiter` et `parcours` — un membre est refusé, un curseur forgé aussi, AVANT toute requête', async () => {
  const CR = '2026-11-22T19:00:00.123+00:00'
  for (const query of [{ suite_a_traiter: `${CR}|${uuid(1)}` }, { parcours: 'debut' }]) {
    const m = await appeler({ titulaire: false, query })
    assert.equal(m.rep.statut, 403)
    assert.equal(m.requetes.length, 0)
  }
  for (const query of [{ suite_a_traiter: `${CR}"),user_id.neq.(x|${uuid(1)}` }, { parcours: 'x|y' }]) {
    const r = await appeler({ query })
    assert.equal(r.rep.statut, 400, JSON.stringify(query))
    assert.equal(r.requetes.length, 0)
  }
})

test('8c : `parcours=debut` lit les « À vérifier » dans l\'ordre de dépôt, et rien d\'autre de l\'écran', async () => {
  const r = await appeler({ query: { parcours: 'debut' }, repondre: () => ({ data: [], count: 0 }) })
  assert.equal(r.rep.statut, 200)
  assert.deepEqual(r.rep.corps, { parcours: { lignes: [], suite: null, nombre: 0 } })
  assert.equal(r.requetes.length, 1, 'une seule lecture')
  assert.equal(filtre(r.requetes[0], 'statut'), 'a_verifier')
  assert.equal(filtre(r.requetes[0], 'user_id'), TITULAIRE)
})

// ─── Les bornes d'une période ────────────────────────────────────────────────
test('LE TEST QUI COMPTE (§14.21) : sans début d\'exercice, l\'année civile — le réglage standard, plus les 12 derniers mois', () => {
  assert.deepEqual(ecran.bornesPeriode({ aujourdhui: '2026-11-10' }), { periode: '2026', proposees: ['2026'], debut: '2026-01-01', fin: '2026-12-31', debut_exercice: '01-01', standard: true })
  assert.deepEqual(ecran.bornesPeriode({ aujourdhui: '2026-01-01' }).debut, '2026-01-01')
  assert.deepEqual(ecran.bornesPeriode({ aujourdhui: '2027-12-31' }).fin, '2027-12-31')
  // Un réglage illisible vaut le standard.
  assert.equal(ecran.bornesPeriode({ entite: { debut_exercice: 'n/a' }, aujourdhui: '2026-11-10' }).standard, true)
})

test('exercice : nommé par l\'année où il commence, choisi un par un ; les mots d\'avant restent compris', () => {
  const avril = { debut_exercice: '04-01' }
  assert.deepEqual(ecran.bornesPeriode({ entite: avril, aujourdhui: '2026-03-31' }), { periode: '2025', proposees: ['2025'], debut: '2025-04-01', fin: '2026-03-31', debut_exercice: '04-01', standard: false })
  assert.deepEqual(ecran.bornesPeriode({ entite: avril, aujourdhui: '2026-04-01' }).debut, '2026-04-01')
  const p = ecran.bornesPeriode({ entite: avril, periode: '2024', aujourdhui: '2026-04-01' })
  assert.deepEqual([p.debut, p.fin], ['2024-04-01', '2025-03-31'])
  assert.equal(ecran.bornesPeriode({ periode: 'exercice_precedent', aujourdhui: '2026-11-10' }).periode, '2025')
  assert.equal(ecran.bornesPeriode({ periode: 'exercice', aujourdhui: '2026-11-10' }).periode, '2026')
  assert.equal(ecran.bornesPeriode({ periode: '12_mois', aujourdhui: '2026-11-10' }).periode, '2026')
})

test('les exercices proposés : du premier au dernier qui portent une facture, l\'exercice en cours toujours compris, au plus 20 en arrière', () => {
  const b = (premier, dernier, extra = {}) => ecran.bornesPeriode({ aujourdhui: '2026-11-10', bornes: { premier, dernier }, ...extra })
  assert.deepEqual(b('2024-03-01', '2028-02-25').proposees, ['2028', '2027', '2026', '2025', '2024'], 'une facture de trois ans ouvre les exercices à venir')
  assert.deepEqual(b('2026-05-01', '2026-05-01').proposees, ['2026'])
  assert.deepEqual(b(null, null).proposees, ['2026'])
  assert.equal(b('1926-01-01', '2026-01-01').proposees.length, 21)
  const juillet = b('2025-01-01', '2026-11-01', { entite: { debut_exercice: '07-01' } })
  assert.deepEqual(juillet.proposees, ['2026', '2025', '2024'], 'janvier 2025 appartient à l\'exercice 2024-2025')
})

test('un 29 février se lit le 28 les années ordinaires, et les exercices se suivent sans trou', () => {
  const e = { debut_exercice: '02-29' }
  const a = ecran.bornesPeriode({ entite: e, aujourdhui: '2027-06-01' })
  assert.deepEqual([a.debut, a.fin], ['2027-02-28', '2028-02-28'])
  const b = ecran.bornesPeriode({ entite: e, aujourdhui: '2028-03-01' })
  assert.equal(b.debut, '2028-02-29')
})

test('une période inconnue, ou trop loin, retombe sur l\'exercice en cours ; une année raisonnable hors de la liste se lit', () => {
  assert.equal(ecran.bornesPeriode({ periode: 'x', aujourdhui: '2026-11-10' }).periode, '2026')
  assert.equal(ecran.bornesPeriode({ periode: '1900', aujourdhui: '2026-11-10' }).periode, '2026')
  assert.equal(ecran.bornesPeriode({ periode: '2040', aujourdhui: '2026-11-10' }).periode, '2026')
  assert.equal(ecran.bornesPeriode({ periode: '2019', aujourdhui: '2026-11-10' }).periode, '2019')
})

test('un mois : « YYYY-MM », ses bornes, février des années bissextiles compris', () => {
  assert.deepEqual(ecran.bornesMois('2026-02'), { debut: '2026-02-01', fin: '2026-02-28' })
  assert.deepEqual(ecran.bornesMois('2028-02'), { debut: '2028-02-01', fin: '2028-02-29' })
  for (const m of ['2026-13', '2026-00', '26-02', '2026-2', '', null, "2026-02' or 1=1"]) assert.equal(ecran.bornesMois(m), null, String(m))
})

test('le curseur : « jour|arrivée|uuid », rien d\'autre', () => {
  assert.deepEqual(ecran.lireCurseur(''), { ok: true, curseur: null })
  assert.deepEqual(ecran.lireCurseur(`2026-10-15|${CREE}|${uuid(3)}`), { ok: true, curseur: { jour: '2026-10-15', cree_le: CREE, id: uuid(3) } })
  assert.equal(ecran.lireCurseur(`2026-10-15|2026-10-15T08:30:00Z|${uuid(3)}`).ok, true, 'un instant en Z')
  assert.equal(ecran.lireCurseur(`2026-10-15|${CREE}|pas-un-uuid`).ok, false)
  assert.equal(ecran.ecrireCurseur({ jour: '2026-10-15', cree_le: CREE, id: uuid(3) }), `2026-10-15|${CREE}|${uuid(3)}`)
})

test('LE TEST QUI COMPTE : les logements se lisent PAGE APRÈS PAGE — jamais tronqués à 1000 en silence', async () => {
  const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: uuid(5000 + i), name: `B${i}`, archive_le: null, user_id: TITULAIRE }))
  const page2 = [{ id: uuid(9999), name: 'Le dernier', archive_le: null, user_id: TITULAIRE }]
  const r = await appeler({
    repondre: (q) => {
      if (q.table !== 'properties') return { data: [], error: null, count: 0 }
      return { data: q.plage && q.plage[0] === 0 ? page1 : page2, error: null }
    }
  })
  const lectures = r.requetes.filter(q => q.table === 'properties')
  assert.deepEqual(lectures.map(q => q.plage), [[0, 999], [1000, 1999]])
  assert.equal(r.rep.corps.biens.length, 1001)
  assert.ok(r.rep.corps.biens.some(b => b.nom === 'Le dernier'))
})

// ─── Les crédits (§14.20) ───────────────────────────────────────────────────
const CREDIT_A = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
test('LE TEST QUI COMPTE (§14.20) : l\'écran sert les crédits du COMPTE et leurs échéances de la PÉRIODE — deux lectures, dans le même appel', async () => {
  const r = await appeler({
    repondre: (q) => {
      if (q.table === 'charges_credits') return { data: [{ id: CREDIT_A, user_id: TITULAIRE, entite_juridique_id: ENT_A, preteur: 'Banque' }] }
      if (q.table === 'charges_credit_echeances') return { data: [{ credit_id: CREDIT_A, user_id: TITULAIRE, date_echeance: '2026-11-22', echeance_cents: 123543, capital_cents: 83258 }] }
      return { data: [], count: 0 }
    }
  })
  assert.equal(r.rep.statut, 200)
  assert.equal(r.rep.corps.credits.liste[0].id, CREDIT_A)
  assert.equal(r.rep.corps.credits.echeances[0].echeance_cents, 123543)
  const c = r.requetes.find(q => q.table === 'charges_credits')
  assert.equal(filtre(c, 'user_id'), TITULAIRE)
  const e = r.requetes.find(q => q.table === 'charges_credit_echeances')
  assert.equal(filtre(e, 'user_id'), TITULAIRE)
  const { debut, fin } = r.rep.corps.totaux
  assert.deepEqual(e.filtres.filter(f => ['in', 'gte', 'lte'].includes(f[0])), [['in', 'credit_id', [CREDIT_A]], ['gte', 'date_echeance', debut], ['lte', 'date_echeance', fin]])
  assert.deepEqual(e.plage, [0, 999], 'page après page')
})

test('sans crédit, les échéances ne se lisent pas ; une entité choisie filtre ses crédits ; une panne dit `null`, sans casser l\'écran', async () => {
  const sans = await appeler()
  assert.deepEqual(sans.rep.corps.credits, { liste: [], echeances: [], aujourdhui: jourParis() })
  assert.equal(sans.requetes.filter(q => q.table === 'charges_credit_echeances').length, 0)
  const une = await appeler({ query: { entite: ENT_A } })
  assert.equal(filtre(une.requetes.find(q => q.table === 'charges_credits'), 'entite_juridique_id'), ENT_A)
  const panne = await appeler({ repondre: (q) => (q.table === 'charges_credits' ? { error: { message: 'x' } } : { data: [], count: 0 }) })
  assert.equal(panne.rep.statut, 200)
  assert.equal(panne.rep.corps.credits, null)
})

test('mesure (case PERFORMANCE, point 8) : l\'écran complet compte 9 lectures sans crédit, 10 avec ; la vue « Sans entité », 9', async () => {
  const sans = await appeler()
  const avec = await appeler({ repondre: (q) => (q.table === 'charges_credits' ? { data: [{ id: CREDIT_A }] } : { data: [], count: 0 }) })
  const vueSans = await appeler({ query: { entite: 'sans' } })
  const compte = (r) => r.requetes.length + r.rpcs.length + r.ej.appels.length
  // Lot 5 bis (§14.25.10) : +1, la présence d'un total « Sans entité » (8 → 9,
  // 9 → 10). La vue « Sans entité » ne lit aucun crédit (un crédit a toujours
  // son entité) et lit les liens des logements, que sa liste écarte.
  assert.equal(compte(sans), 9)
  assert.equal(compte(avec), 10)
  assert.equal(compte(vueSans), 9)
  assert.equal(vueSans.requetes.filter(q => q.table === 'charges_credits').length, 0)
})

// ─── Le détail d'un mois (§14.21.2) ──────────────────────────────────────────
test('LE TEST QUI COMPTE : le détail d\'un mois — entité vérifiée AVANT, une seule fonction, rien d\'autre lu', async () => {
  const lignes = [{ id: uuid(1), part_ttc_cents: 100, montant_ttc_cents: 1200, compte: true }]
  // ENT_B (SCI) commence au 1er avril : mars 2026 est le dernier mois de
  // l'exercice 2025, entier.
  const r = await appeler({ query: { mois: '2026-03', entite: ENT_B, periode: '2025' }, rpc: (nom) => (nom === 'charges_detail_mois' ? { data: lignes, error: null } : { data: TOTAUX, error: null }) })
  assert.equal(r.rep.statut, 200)
  assert.deepEqual(Object.keys(r.rep.corps), ['detail_mois'])
  assert.deepEqual(r.rep.corps.detail_mois, { mois: '2026-03', periode: '2025', debut: '2026-03-01', fin: '2026-03-31', partiel: false, entite: ENT_B, lignes })
  assert.equal(r.requetes.length, 0)
  assert.deepEqual(r.rpcs.map(x => [x.nom, x.args]), [['charges_detail_mois', { p_user: TITULAIRE, p_debut: '2026-03-01', p_fin: '2026-03-31', p_entite: ENT_B }]])
  assert.deepEqual(r.ej.appels.map(a => a[0]), ['entites'])
  assert.match(String(r.rep.entetes['cache-control']), /private, no-store/)
  assert.match(String(r.rep.entetes['server-timing']), /requêtes/)
})

test('LE TEST QUI COMPTE : le détail d\'une entité d\'un AUTRE compte rend 404 sans rien lire ; mois ou entité invalides, 400', async () => {
  const autre = await appeler({ query: { mois: '2026-03', entite: ENT_AUTRE, periode: '2026' } })
  assert.equal(autre.rep.statut, 404)
  assert.equal(autre.rpcs.length, 0)
  for (const query of [{ mois: '2026-13', entite: ENT_A, periode: '2026' }, { mois: '2026-03', periode: '2026' }, { mois: '2026-03', entite: 'x', periode: '2026' }]) {
    const r = await appeler({ query })
    assert.equal(r.rep.statut, 400, JSON.stringify(query))
    assert.equal(r.rpcs.length, 0)
  }
  // Un membre délégué : 403 avant tout, comme l'écran.
  const m = await appeler({ titulaire: false, query: { mois: '2026-03', entite: ENT_A, periode: '2026' } })
  assert.equal(m.rep.statut, 403)
  assert.equal(m.rpcs.length, 0)
})

test('le détail en panne rend 503 ; une fonction qui rendrait un objet n\'est pas une liste', async () => {
  for (const rep of [{ data: null, error: { message: 'panne' } }, { data: { x: 1 }, error: null }]) {
    const r = await appeler({ query: { mois: '2026-03', entite: ENT_A, periode: '2026' }, rpc: () => rep })
    assert.equal(r.rep.statut, 503)
  }
})

// ─── Review 1 du lot 8a ─────────────────────────────────────────────────────
const SCI_MARS = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const entitesMars = () => entitesDouble({ entites: [{ id: SCI_MARS, nom: 'SCI mars', archivee_le: null, debut_exercice: '03-15' }] })

test('LE TEST QUI COMPTE (review 1, constat 1) : un exercice au 15 mars — ses mois de bord ne se lisent que pour leur PART dans l\'exercice', async () => {
  const lire = async (mois, periode) => appeler({ entites: entitesMars(), query: { mois, entite: SCI_MARS, periode }, rpc: () => ({ data: [], error: null }) })
  const debut = await lire('2026-03', '2026')
  assert.equal(debut.rep.statut, 200)
  assert.deepEqual([debut.rpcs[0].args.p_debut, debut.rpcs[0].args.p_fin], ['2026-03-15', '2026-03-31'])
  assert.equal(debut.rep.corps.detail_mois.partiel, true)
  const fin = await lire('2027-03', '2026')
  assert.deepEqual([fin.rpcs[0].args.p_debut, fin.rpcs[0].args.p_fin], ['2027-03-01', '2027-03-14'])
  // Le même mois civil, lu dans l'exercice d'avant : l'autre moitié.
  const avant = await lire('2026-03', '2025')
  assert.deepEqual([avant.rpcs[0].args.p_debut, avant.rpcs[0].args.p_fin], ['2026-03-01', '2026-03-14'])
  const plein = await lire('2026-07', '2026')
  assert.deepEqual([plein.rpcs[0].args.p_debut, plein.rpcs[0].args.p_fin, plein.rep.corps.detail_mois.partiel], ['2026-07-01', '2026-07-31', false])
  // Un mois hors de l'exercice : refusé, rien n'est lu.
  const hors = await lire('2028-06', '2026')
  assert.equal(hors.rep.statut, 400)
  assert.equal(hors.rep.corps.error, 'mois_hors_exercice')
  assert.equal(hors.rpcs.length, 0)
})

test('le détail exige son exercice, et un exercice hors des bornes de lecture n\'est pas lu en silence comme un autre', async () => {
  for (const [periode, code] of [[undefined, 'periode_requise'], ['exercice', 'periode_requise'], ['2090', 'periode_invalide']]) {
    const r = await appeler({ query: { mois: '2026-03', entite: ENT_A, periode } })
    assert.equal(r.rep.statut, 400, String(periode))
    assert.equal(r.rep.corps.error, code)
    assert.equal(r.rpcs.length, 0)
  }
})

test('un 29 février : l\'exercice d\'une année ordinaire commence le 28, et février n\'y compte qu\'un jour', () => {
  const ex = ecran.bornesPeriode({ entite: { debut_exercice: '02-29' }, periode: '2027', aujourdhui: '2027-06-01' })
  assert.deepEqual([ex.debut, ex.fin], ['2027-02-28', '2028-02-28'])
  assert.deepEqual(ecran.plageDuMois('2027-02', ex), { debut: '2027-02-28', fin: '2027-02-28', partiel: true })
  assert.deepEqual(ecran.plageDuMois('2028-02', ex), { debut: '2028-02-01', fin: '2028-02-28', partiel: true })
  assert.equal(ecran.plageDuMois('2028-03', ex), null)
})

test('review 1, constats 5 et 6 : au plus 5 exercices à venir ; l\'exercice LU est toujours proposé', () => {
  const loin = ecran.bornesPeriode({ aujourdhui: '2026-11-10', bornes: { premier: '2026-01-01', dernier: '2099-06-01' } })
  assert.deepEqual(loin.proposees, ['2031', '2030', '2029', '2028', '2027', '2026'])
  // 2024 choisi, puis sa seule facture supprimée : il reste dans le menu.
  const seul = ecran.bornesPeriode({ periode: '2024', aujourdhui: '2026-11-10', bornes: { premier: '2026-02-01', dernier: '2026-02-01' } })
  assert.equal(seul.periode, '2024')
  assert.deepEqual(seul.proposees, ['2026', '2025', '2024'])
})

test('review 1, constat 7 : une panne des bornes des exercices se DIT, les totaux restent', async () => {
  const r = await appeler({ rpc: (nom) => (nom === 'charges_exercices_bornes' ? { data: null, error: { message: 'panne' } } : { data: TOTAUX, error: null }) })
  assert.equal(r.rep.statut, 200)
  assert.equal(r.rep.corps.totaux.exercices_indisponibles, true)
  assert.equal(r.rep.corps.totaux.proposees.length, 1)
  const ok = await appeler({ rpc: (nom) => (nom === 'charges_exercices_bornes' ? { data: { premier: null, dernier: null }, error: null } : { data: TOTAUX, error: null }) })
  assert.equal(ok.rep.corps.totaux.exercices_indisponibles, false)
})

test('« Afficher plus » suit l\'entité choisie', async () => {
  const r = await appeler({ query: { curseur: `2026-10-15|${CREE}|${uuid(51)}`, entite: ENT_B } })
  assert.equal(r.rep.statut, 200)
  assert.equal(filtre(r.requetes[0], 'entite_juridique_id'), ENT_B)
})

test('les échéances se lisent page après page, dans un ordre TOTAL — 1000 + 1 lignes, deux pages (review, mineur 7)', async () => {
  const lignes = Array.from({ length: 1001 }, (_, i) => ({ credit_id: CREDIT_A, user_id: TITULAIRE, indice: i + 1, date_echeance: '2026-11-22', echeance_cents: 1 }))
  const r = await appeler({
    repondre: (q) => {
      if (q.table === 'charges_credits') return { data: [{ id: CREDIT_A, user_id: TITULAIRE }] }
      if (q.table === 'charges_credit_echeances') return { data: lignes.slice(q.plage[0], q.plage[1] + 1) }
      return { data: [], count: 0 }
    }
  })
  const pages = r.requetes.filter(q => q.table === 'charges_credit_echeances')
  assert.deepEqual(pages.map(q => q.plage), [[0, 999], [1000, 1999]])
  assert.deepEqual(pages[0].ordre, [['date_echeance', true], ['credit_id', true], ['indice', true]])
  assert.equal(r.rep.corps.credits.echeances.length, 1001)
})

// ─── Lot 8d (§14.23) : la liste d'export d'un exercice ───────────────────────
const ligneExport = (n, extra = {}) => ({
  id: uuid(n), jour: '2026-03-0' + ((n % 9) + 1), date_facture: '2026-03-01', fournisseur_nom: 'F' + n, fournisseur_siret: null,
  numero_facture: 'N' + n, type_document: 'facture', categorie: 'energie', bien_id: null, periode_debut: null, periode_fin: null,
  montant_ht_cents: 1000, montant_tva_cents: 200, montant_ttc_cents: 1200, origine: 'fichier', justificatif_type: 'application/pdf',
  justificatif_chemin: `${TITULAIRE}/${uuid(n)}.pdf`, cree_le: '2026-03-01T10:00:00Z', ...extra
})

test('LE TEST QUI COMPTE (8d) : `?export=1` rend les factures ENREGISTRÉES de l\'entité et de l\'exercice, sans le chemin de leur fichier, et le nombre à traiter', async () => {
  const r = await appeler({
    query: { export: '1', entite: ENT_A, periode: '2026' },
    repondre: (q) => {
      if (q.optionsSelect && q.optionsSelect.head) return { count: 4 }
      return { data: [
        ligneExport(1), ligneExport(2, { origine: 'ota', justificatif_chemin: null }), ligneExport(3, { origine: 'credit', justificatif_chemin: 'x' }),
        ligneExport(4, { type_document: 'echeancier' }), ligneExport(5, { groupe_doublon: uuid(1), signal: 'doublon', signal_tranche: false }),
        ligneExport(6, { signal: 'commission_deja_comptee', signal_tranche: false }), ligneExport(7, { groupe_doublon: uuid(1), signal: 'doublon', signal_tranche: true })
      ] }
    }
  })
  assert.equal(r.rep.statut, 200)
  const x = r.rep.corps.export
  assert.deepEqual([x.periode, x.debut, x.fin, x.a_traiter, x.entite.nom], ['2026', '2026-01-01', '2026-12-31', 4, 'Moi'])
  assert.deepEqual(x.lignes.map(l => l.fichier), [true, false, false, true, true, true, true], 'une commission et une échéance de crédit n\'ont pas de fichier')
  // Review du lot 8d, B1 : la règle du résumé, à l'identique.
  assert.deepEqual(x.lignes.map(l => l.compte), [true, true, true, false, false, false, true], 'échéancier, doublon et commission non tranchés ne comptent pas')
  assert.ok(x.lignes.every(l => !('justificatif_chemin' in l) && !('signal' in l) && !('groupe_doublon' in l)), 'ni le chemin du fichier ni les signaux ne sortent')
  const lecture = r.requetes.find(q => q.table === 'charges' && !(q.optionsSelect && q.optionsSelect.head))
  assert.equal(filtre(lecture, 'user_id'), TITULAIRE)
  assert.equal(filtre(lecture, 'entite_juridique_id'), ENT_A)
  assert.equal(filtre(lecture, 'statut'), 'validee')
  assert.deepEqual(lecture.filtres.filter(f => f[0] === 'gte' || f[0] === 'lte'), [['gte', 'jour', '2026-01-01'], ['lte', 'jour', '2026-12-31']])
  assert.deepEqual(lecture.ordre, [['jour', true], ['cree_le', true], ['id', true]])
  assert.equal(lecture.limite, 1000)
  const compte = r.requetes.find(q => q.optionsSelect && q.optionsSelect.head)
  assert.equal(filtre(compte, 'user_id'), TITULAIRE)
  // Review B1 : une facture ENREGISTRÉE n'est pas « hors de l'export ».
  assert.ok(compte.filtres.some(f => f[0] === 'neq' && f[1] === 'statut' && f[2] === 'validee'))
  assert.match(String(r.rep.entetes['cache-control'] || ''), /no-store|private/)
})

test('8d : l\'export d\'un exercice décalé suit le début d\'exercice de l\'entité RELUE', async () => {
  const r = await appeler({ query: { export: '1', entite: ENT_B, periode: '2025' }, repondre: (q) => (q.optionsSelect && q.optionsSelect.head ? { count: 0 } : { data: [] }) })
  assert.equal(r.rep.statut, 200)
  assert.deepEqual([r.rep.corps.export.debut, r.rep.corps.export.fin], ['2025-04-01', '2026-03-31'])
})

test('8d (review M7) : l\'export se lit PAR CURSEUR — la page suivante part APRÈS la dernière ligne (jour, arrivée, id), une ligne vue deux fois ne compte qu\'une fois ; au-delà de 5 000, refus dit', async () => {
  const mille = Array.from({ length: 1000 }, (_, i) => ligneExport(i + 1, { jour: '2026-03-01', cree_le: '2026-03-01T10:00:00.123456+00:00' }))
  let pages = 0
  const r = await appeler({ query: { export: '1', entite: ENT_A, periode: '2026' }, repondre: (q) => {
    if (q.optionsSelect && q.optionsSelect.head) return { count: 0 }
    pages++
    // La seconde page rend aussi la dernière de la première (une écriture
    // entre deux pages) : elle ne doit pas être numérotée deux fois.
    return { data: pages === 1 ? mille : [mille[999], ligneExport(5000)] }
  } })
  assert.equal(r.rep.statut, 200)
  assert.equal(r.rep.corps.export.lignes.length, 1001)
  const lectures = r.requetes.filter(q => q.table === 'charges' && !(q.optionsSelect && q.optionsSelect.head))
  assert.equal(lectures.length, 2)
  assert.equal(lectures[0].filtres.find(f => f[0] === 'or'), undefined)
  const d = mille[999]
  assert.deepEqual(lectures[1].filtres.find(f => f[0] === 'or'), ['or', `jour.gt.2026-03-01,and(jour.eq.2026-03-01,cree_le.gt."${d.cree_le}"),and(jour.eq.2026-03-01,cree_le.eq."${d.cree_le}",id.gt.${d.id})`])
  assert.ok(lectures.every(q => q.limite === 1000 && !q.plage), 'jamais par décalage')
  const trop = await appeler({ query: { export: '1', entite: ENT_A, periode: '2026' }, repondre: (q) => {
    if (q.optionsSelect && q.optionsSelect.head) return { count: 0 }
    pages++
    return { data: Array.from({ length: 1000 }, (_, i) => ligneExport(pages * 1000 + i, { jour: '2026-03-01' })) }
  } })
  assert.equal(trop.rep.statut, 413)
  assert.equal(trop.rep.corps.error, 'trop_de_factures')
  assert.equal(trop.requetes.filter(q => q.table === 'charges' && q.limite === 1000).length, 6, 'on s\'arrête après 5 000, sans tout lire')
})

test('⚠ 8d : un MEMBRE est refusé AVANT toute lecture ; une entité, un exercice ou une entité d\'un autre compte manquants ou faux sont refusés avant la liste', async () => {
  const m = await appeler({ titulaire: false, query: { export: '1', entite: ENT_A, periode: '2026' } })
  assert.equal(m.rep.statut, 403)
  assert.equal(m.requetes.length, 0)
  for (const [query, statut, erreur] of [
    [{ export: '1', periode: '2026' }, 400, 'entite_requise'],
    [{ export: '1', entite: 'pas-un-uuid', periode: '2026' }, 400, 'entite_invalide'],
    [{ export: '1', entite: ENT_A }, 400, 'periode_requise'],
    [{ export: '1', entite: ENT_AUTRE, periode: '2026' }, 404, 'entite_introuvable'],
    [{ export: '1', entite: ENT_A, periode: '1900' }, 400, 'periode_invalide']
  ]) {
    const r = await appeler({ query })
    assert.deepEqual([r.rep.statut, r.rep.corps.error], [statut, erreur], JSON.stringify(query))
    assert.equal(r.requetes.filter(q => q.table === 'charges').length, 0, 'aucune facture lue')
  }
})

// ─── « Sans entité juridique » (lot 5 bis, §14.25) ──────────────────────────
// Une présence de total « sans entité » : les bornes du résumé « sans entité »
// (p_entite NULL), la même règle que les totaux, dite par la base.
let r0 = 0
const avecSans = (nom, args) => (nom === 'charges_exercices_bornes'
  ? { data: args.p_entite === null ? { premier: '2026-11-10', dernier: '2026-11-10' } : { premier: null, dernier: null }, error: null }
  : { data: TOTAUX, error: null })
// Les liens bien → entité du double : BIEN_1 est rattaché à ENT_A.

test('LE TEST QUI COMPTE : ?entite=sans lit les totaux, les bornes et la liste SANS entité — p_entite NULL, aucune entité inventée', async () => {
  const r = await appeler({ query: { entite: 'sans' }, rpc: avecSans })
  assert.equal(r.rep.statut, 200)
  assert.equal(r.rep.corps.entite, 'sans')
  assert.equal(r.rep.corps.option_sans_entite, true)
  // Les lectures du résumé : « sans entité », c'est NULL, et le compte.
  assert.deepEqual(r.rpcs.map(x => x.nom).sort(), ['charges_exercices_bornes', 'charges_exercices_bornes', 'charges_totaux'])
  for (const x of r.rpcs) assert.deepEqual([x.args.p_user, x.args.p_entite], [TITULAIRE, null], x.nom)
  // La liste : sans entité, AVEC un logement, et pas un logement RATTACHÉ —
  // la règle des totaux (Thierry, 25 novembre 2026, review 1 B1).
  const liste = r.requetes.find(q => q.table === 'charges' && !(q.optionsSelect && q.optionsSelect.count) && q.limite === 51)
  assert.ok(liste.filtres.some(f => f[0] === 'is' && f[1] === 'entite_juridique_id' && f[2] === null))
  assert.ok(liste.filtres.some(f => f[0] === 'not' && f[1] === 'bien_id' && f[2] === 'is' && f[3] === null), 'pas une charge générale')
  assert.ok(liste.filtres.some(f => f[0] === 'not' && f[1] === 'bien_id' && f[2] === 'in' && f[3] === `(${BIEN_1})`), 'pas un logement rattaché')
  assert.ok(!liste.filtres.some(f => f[0] === 'eq' && f[1] === 'entite_juridique_id'))
  assert.deepEqual(r.ej.appels.map(a => a[0]).sort(), ['entites', 'liens', 'liens'])
  // Aucun crédit (un crédit a toujours son entité), et l'année civile.
  assert.equal(r.requetes.filter(q => q.table === 'charges_credits').length, 0)
  assert.deepEqual(r.rep.corps.credits, { liste: [], echeances: [], aujourdhui: null })
  assert.equal(r.rep.corps.totaux.entite, 'sans')
  assert.equal(r.rep.corps.totaux.debut_exercice, '01-01')
  assert.equal(r.rep.corps.totaux.standard, true)
})

test('la présence « sans entité » : les bornes du résumé « sans entité » du compte — la règle des totaux, dite par la base', async () => {
  const r = await appeler({ rpc: avecSans })
  assert.ok(r.rpcs.some(x => x.nom === 'charges_exercices_bornes' && x.args.p_user === TITULAIRE && x.args.p_entite === null))
  assert.equal(r.requetes.filter(x => x.table === 'charges_resume').length, 0, 'aucune lecture du résumé hors de ses fonctions')
  // Un compte AVEC entités : la première reste lue par défaut, l'option est offerte.
  assert.equal(r.rep.corps.entite, ENT_A)
  assert.equal(r.rep.corps.option_sans_entite, true)
  // Sans total sans entité : pas d'option.
  const rien = await appeler()
  assert.equal(rien.rep.corps.option_sans_entite, false)
})

test('LE TEST QUI COMPTE : un compte SANS aucune entité ouvre sur « Sans entité » s\'il y a de quoi l\'afficher ; sinon, comme avant', async () => {
  const aucune = entitesDouble({ entites: [] })
  const r = await appeler({ entites: aucune, rpc: avecSans })
  assert.equal(r.rep.corps.entite, 'sans')
  assert.equal(r.rep.corps.totaux.entite, 'sans')
  assert.ok(r.rpcs.some(x => x.nom === 'charges_totaux' && x.args.p_entite === null))
  const vide = await appeler({ entites: entitesDouble({ entites: [] }) })
  assert.equal(vide.rep.corps.entite, null)
  assert.deepEqual(vide.rep.corps.totaux, { sans_entite: true })
  assert.deepEqual(vide.rpcs.map(x => [x.nom, x.args.p_entite]), [['charges_exercices_bornes', null]], 'la présence seule : ni totaux ni bornes d\'exercice')
  assert.equal(vide.rep.corps.option_sans_entite, false)
})

test('?entite=sans : la présence en panne n\'empêche pas la vue, et l\'option reste offerte puisqu\'on la lit', async () => {
  const r = await appeler({ query: { entite: 'sans' }, rpc: (nom, args) => (nom === 'charges_exercices_bornes' && args.p_entite === null && !r0++ ? { data: null, error: { message: 'panne' } } : { data: TOTAUX, error: null }) })
  assert.equal(r.rep.statut, 200)
  assert.equal(r.rep.corps.option_sans_entite, true)
})

test('le détail d\'un mois « sans entité » : aucune entité relue, l\'année civile, p_entite NULL', async () => {
  const lignes = [{ id: uuid(1), part_ttc_cents: 100, compte: true }]
  const r = await appeler({ query: { mois: '2026-03', entite: 'sans', periode: '2026' }, rpc: () => ({ data: lignes, error: null }) })
  assert.equal(r.rep.statut, 200)
  assert.deepEqual(r.rep.corps.detail_mois, { mois: '2026-03', periode: '2026', debut: '2026-03-01', fin: '2026-03-31', partiel: false, entite: 'sans', lignes })
  assert.deepEqual(r.rpcs.map(x => [x.nom, x.args]), [['charges_detail_mois', { p_user: TITULAIRE, p_debut: '2026-03-01', p_fin: '2026-03-31', p_entite: null }]])
  assert.deepEqual(r.ej.appels, [])
})

test('LE TEST QUI COMPTE : l\'export « sans entité » — les factures enregistrées SANS entité, et une entité qui le dit', async () => {
  const r = await appeler({ query: { export: '1', entite: 'sans', periode: '2026' }, repondre: (q) => (q.optionsSelect && q.optionsSelect.count ? { data: null, error: null, count: 0 } : { data: [], error: null }) })
  assert.equal(r.rep.statut, 200)
  assert.deepEqual(r.rep.corps.export.entite, { id: 'sans', nom: null, siret: null, sans: true })
  assert.deepEqual([r.rep.corps.export.debut, r.rep.corps.export.fin], ['2026-01-01', '2026-12-31'])
  const q = r.requetes.find(x => x.table === 'charges' && !(x.optionsSelect && x.optionsSelect.count))
  assert.equal(filtre(q, 'user_id'), TITULAIRE)
  assert.equal(filtre(q, 'statut'), 'validee')
  assert.ok(q.filtres.some(f => f[0] === 'is' && f[1] === 'entite_juridique_id' && f[2] === null))
  assert.ok(!q.filtres.some(f => f[0] === 'eq' && f[1] === 'entite_juridique_id'))
  assert.deepEqual(r.ej.appels, [])
})

test('une entité ni UUID ni « sans » : 400, rien lu', async () => {
  for (const entite of ['SANS', 'sans ', 'null', 'x']) {
    const r = await appeler({ query: { entite } })
    assert.equal(r.rep.statut, 400, entite)
    assert.equal(r.requetes.length + r.rpcs.length, 0)
  }
})

test('LE TEST QUI COMPTE : les lectures du résumé refusent une entité ABSENTE — un oubli ne devient pas « sans entité »', async () => {
  const { client, rpcs, requetes } = baseEnregistreuse(() => ({ data: [], error: null }), { rpc: () => ({ data: {}, error: null }) })
  const plage = { debut: '2026-01-01', fin: '2026-12-31' }
  for (const entiteId of [undefined, null, '', 'toutes']) {
    assert.equal((await ecran.totaux(client, TITULAIRE, { ...plage, entiteId })).invalide, true, String(entiteId))
    assert.equal((await ecran.exercicesBornes(client, TITULAIRE, entiteId)).invalide, true, String(entiteId))
    assert.equal((await ecran.detailMois(client, TITULAIRE, { ...plage, entiteId })).invalide, true, String(entiteId))
    assert.equal((await ecran.aExporter(client, TITULAIRE, { ...plage, entiteId })).invalide, true, String(entiteId))
  }
  assert.equal(rpcs.length + requetes.length, 0)
  // Une entité nommée passe telle quelle ; « sans » devient NULL.
  await ecran.totaux(client, TITULAIRE, { ...plage, entiteId: ENT_A })
  await ecran.totaux(client, TITULAIRE, { ...plage, entiteId: ecran.SANS_ENTITE })
  assert.deepEqual(rpcs.map(x => x.args.p_entite), [ENT_A, null])
})

test('« Afficher plus » en vue « sans » : les logements rattachés relus et écartés ; leurs liens en panne → 503, aucune facture lue', async () => {
  const r = await appeler({ query: { entite: 'sans', curseur: `2026-10-15|${CREE}|${uuid(51)}` } })
  assert.equal(r.rep.statut, 200)
  assert.deepEqual(r.ej.appels.map(a => a[0]), ['liens'])
  const q = r.requetes.find(x => x.table === 'charges')
  assert.ok(q.filtres.some(f => f[0] === 'not' && f[1] === 'bien_id' && f[2] === 'in' && f[3] === `(${BIEN_1})`))
  const panne = entitesDouble({ entites: [] })
  panne.liensDuCompte = async (u) => { panne.appels.push(['liens', u]); return { ok: false, motif: 'panne' } }
  const p = await appeler({ query: { entite: 'sans', curseur: `2026-10-15|${CREE}|${uuid(51)}` }, entites: panne })
  assert.equal(p.rep.statut, 503)
  assert.equal(p.requetes.length, 0)
  const e = await appeler({ query: { entite: 'sans' }, entites: panne })
  assert.equal(e.rep.statut, 503)
})

test('la liste « sans entité » refuse un lien qui ne serait pas un UUID (il entre dans un filtre)', async () => {
  const { client, requetes } = baseEnregistreuse(() => ({ data: [], error: null }))
  const l = await ecran.liste(client, TITULAIRE, null, ecran.SANS_ENTITE, { rattaches: ['x),id.neq.(0'] })
  assert.equal(l.ok, false)
  assert.equal(requetes.length, 0)
})
