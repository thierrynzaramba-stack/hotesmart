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
  assert.equal(r.rpcs.length, 1)
  assert.equal(r.rpcs[0].nom, 'charges_totaux')
  assert.equal(r.rpcs[0].args.p_user, TITULAIRE)
  assert.equal(r.rpcs[0].args.p_entite, null, '« toutes les entités »')

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

test('« toutes les entités » se lit sur les 12 derniers mois (Q33), bornes passées à la fonction', async () => {
  const r = await appeler()
  const t = r.rep.corps.totaux
  const attendu = ecran.bornesPeriode({ periode: undefined, entite: null, aujourdhui: jourParis() })
  assert.equal(t.periode, '12_mois')
  assert.deepEqual(t.proposees, ['12_mois'])
  assert.equal(t.debut, attendu.debut)
  assert.equal(t.fin, attendu.fin)
  assert.equal(r.rpcs[0].args.p_debut, t.debut)
  assert.equal(r.rpcs[0].args.p_fin, t.fin)
})

test('une entité avec début d\'exercice se lit par exercice (Q22), et la fonction reçoit cette entité', async () => {
  const r = await appeler({ query: { entite: ENT_B, periode: 'exercice_precedent' } })
  assert.equal(r.rep.statut, 200)
  const t = r.rep.corps.totaux
  assert.equal(t.entite, ENT_B)
  assert.equal(t.periode, 'exercice_precedent')
  assert.deepEqual(t.proposees, ['exercice', 'exercice_precedent'])
  assert.equal(r.rpcs[0].args.p_entite, ENT_B)
  assert.match(t.debut, /-04-01$/)
  assert.match(t.fin, /-03-31$/)
})

test('LE TEST QUI COMPTE : une entité qui n\'est pas du compte rend 404, sans totaux', async () => {
  const r = await appeler({ query: { entite: ENT_AUTRE } })
  assert.equal(r.rep.statut, 404)
  assert.equal(r.rpcs.length, 0)
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

test('les entités en panne rendent 503, sans autre lecture', async () => {
  const r = await appeler({ entites: entitesDouble({ panne: true }) })
  assert.equal(r.rep.statut, 503)
  assert.equal(r.requetes.length, 0)
  assert.equal(r.rpcs.length, 0)
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
  assert.equal(q.limite, 50)
  assert.deepEqual(q.filtres.find(f => f[0] === 'or'), ['or', 'statut.in.(a_lire,a_verifier,illisible),and(signal.not.is.null,signal_tranche.is.false)'])
  assert.ok(q.filtres.some(f => f[0] === 'neq' && f[2] === 'envoi'))
  assert.doesNotMatch(q.colonnes, /lecture_ia|justificatif_chemin/, 'ni la réponse brute de l\'IA, ni le chemin du fichier')
})

// ─── Les bornes d'une période ────────────────────────────────────────────────
test('12 derniers mois : du 1er du mois d\'il y a 11 mois au dernier jour du mois en cours', () => {
  assert.deepEqual(ecran.bornesPeriode({ aujourdhui: '2026-11-10' }), { periode: '12_mois', proposees: ['12_mois'], debut: '2025-12-01', fin: '2026-11-30' })
  assert.deepEqual(ecran.bornesPeriode({ aujourdhui: '2026-01-31' }), { periode: '12_mois', proposees: ['12_mois'], debut: '2025-02-01', fin: '2026-01-31' })
  assert.deepEqual(ecran.bornesPeriode({ aujourdhui: '2028-02-29' }).fin, '2028-02-29')
})

test('exercice : celui qui contient aujourd\'hui, et le précédent', () => {
  const civil = { debut_exercice: '01-01' }
  assert.deepEqual(ecran.bornesPeriode({ entite: civil, aujourdhui: '2026-11-10' }), { periode: 'exercice', proposees: ['exercice', 'exercice_precedent'], debut: '2026-01-01', fin: '2026-12-31' })
  assert.deepEqual(ecran.bornesPeriode({ entite: civil, periode: 'exercice_precedent', aujourdhui: '2026-11-10' }).debut, '2025-01-01')
  const avril = { debut_exercice: '04-01' }
  assert.deepEqual(ecran.bornesPeriode({ entite: avril, aujourdhui: '2026-03-31' }), { periode: 'exercice', proposees: ['exercice', 'exercice_precedent'], debut: '2025-04-01', fin: '2026-03-31' })
  assert.deepEqual(ecran.bornesPeriode({ entite: avril, aujourdhui: '2026-04-01' }).debut, '2026-04-01')
  const p = ecran.bornesPeriode({ entite: avril, periode: 'exercice_precedent', aujourdhui: '2026-04-01' })
  assert.deepEqual([p.debut, p.fin], ['2025-04-01', '2026-03-31'])
})

test('un 29 février se lit le 28 les années ordinaires, et les exercices se suivent sans trou', () => {
  const e = { debut_exercice: '02-29' }
  const a = ecran.bornesPeriode({ entite: e, aujourdhui: '2027-06-01' })
  assert.deepEqual([a.debut, a.fin], ['2027-02-28', '2028-02-28'])
  const b = ecran.bornesPeriode({ entite: e, aujourdhui: '2028-03-01' })
  assert.equal(b.debut, '2028-02-29')
})

test('une période inconnue, ou d\'une autre forme d\'entité, retombe sur la première proposée', () => {
  assert.equal(ecran.bornesPeriode({ periode: 'exercice', aujourdhui: '2026-11-10' }).periode, '12_mois')
  assert.equal(ecran.bornesPeriode({ entite: { debut_exercice: '01-01' }, periode: '12_mois', aujourdhui: '2026-11-10' }).periode, 'exercice')
  assert.equal(ecran.bornesPeriode({ entite: { debut_exercice: 'n/a' }, aujourdhui: '2026-11-10' }).periode, '12_mois')
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
