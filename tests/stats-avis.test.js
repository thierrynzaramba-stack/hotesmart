// tests/stats-avis.test.js
// La fonction de ratio est PARTAGÉE entre /avis (côté hôte) et, bientôt, la
// fiche prestataire. Ces tests fixent son contrat : deux chiffres calculés
// différemment pour la même chose finiraient par se contredire, et c'est celui
// montré à la prestataire qui perdrait sa crédibilité.

const test = require('node:test')
const assert = require('node:assert')
const { ratioProprete, borneDepuis, PERIODES } = require('../lib/stats-avis')

const T0 = Date.parse('2026-09-03T12:00:00Z')

function fauxClient (lignes = [], journal = [], erreur = null) {
  return {
    from (table) {
      const appel = { table, filtres: {}, in: null, gte: null }
      journal.push(appel)
      const chain = {
        select () { return chain },
        eq (c, v) { appel.filtres[c] = v; return chain },
        gte (c, v) { appel.gte = { colonne: c, valeur: v }; return chain },
        in (c, v) { appel.in = { colonne: c, valeurs: (v || []).map(String) }; return chain },
        then (r) {
          if (erreur) return Promise.resolve({ data: null, error: erreur }).then(r)
          const d = lignes.filter(l =>
            (appel.filtres.user_id == null || l.user_id === appel.filtres.user_id) &&
            (appel.filtres.statut == null || (l.statut || 'confirme') === appel.filtres.statut) &&
            (!appel.gte || String(l[appel.gte.colonne] || '') >= String(appel.gte.valeur)) &&
            (!appel.in || appel.in.valeurs.includes(String(l[appel.in.colonne]))))
          return Promise.resolve({ data: d, error: null }).then(r)
        }
      }
      return chain
    }
  }
}

const L = (o) => ({ user_id: 'u1', statut: 'confirme', ai_analyzed_at: '2026-09-01T00:00:00Z',
                    received_at: '2026-09-01T00:00:00Z', property_id_ref: '209413', ...o })

// ─── Les périodes ───────────────────────────────────────────────────────────
test('borneDepuis : les quatre périodes, et « toujours » sans borne', () => {
  assert.ok(borneDepuis('15j', T0) > borneDepuis('30j', T0))
  assert.ok(borneDepuis('30j', T0) > borneDepuis('6mois', T0))
  assert.strictEqual(borneDepuis('toujours', T0), null)
  assert.deepStrictEqual(Object.keys(PERIODES), ['15j', '30j', '6mois', 'toujours'])
})

test('borneDepuis : une période inventée retombe sur 30 jours', () => {
  // Le paramètre vient de l'URL : il ne désigne rien tant qu'il n'est pas
  // reconnu. Retomber sur « toujours » élargirait le calcul silencieusement.
  assert.strictEqual(borneDepuis('pipo', T0), borneDepuis('30j', T0))
  assert.strictEqual(borneDepuis(undefined, T0), borneDepuis('30j', T0))
})

// ─── Le comptage ────────────────────────────────────────────────────────────
test('ratio : compte par verdict', async () => {
  const r = await ratioProprete(fauxClient([
    L({ ai_clean_verdict: 'positif' }), L({ ai_clean_verdict: 'positif' }),
    L({ ai_clean_verdict: 'remarque' }), L({ ai_clean_verdict: 'rien_signale' })
  ]), { userId: 'u1', periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.total, 4)
  assert.strictEqual(r.positif, 2)
  assert.strictEqual(r.remarque, 1)
  assert.strictEqual(r.rien_signale, 1)
})

test('ratio : les DÉTECTIONS EN ATTENTE ne comptent pas', async () => {
  // Une détection non validée n'est pas un fait. La compter reviendrait à
  // reprocher à la prestataire quelque chose que l'hôte n'a pas confirmé.
  const journal = []
  const r = await ratioProprete(fauxClient([
    L({ ai_clean_verdict: 'remarque' }),
    L({ ai_clean_verdict: 'remarque', statut: 'detecte' }),
    L({ ai_clean_verdict: 'remarque', statut: 'ignore' })
  ], journal), { userId: 'u1', periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.remarque, 1)
  assert.strictEqual(journal[0].filtres.statut, 'confirme')
})

test('ratio : un avis non analysé est compté à part', async () => {
  const r = await ratioProprete(fauxClient([
    L({ ai_clean_verdict: null, ai_analyzed_at: null })
  ]), { userId: 'u1', periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.total, 1)
  assert.strictEqual(r.non_analyses, 1)
  assert.strictEqual(r.rien_signale, 0, 'ne pas le ranger dans « rien signalé »')
})

// ─── Le cloisonnement ───────────────────────────────────────────────────────
test('ratio : TOUJOURS filtré par user_id', async () => {
  // Le cron et les endpoints tournent en service key : la RLS ne les protège
  // pas, ce filtre est la seule défense (REVIEW.md règle 1).
  const journal = []
  const r = await ratioProprete(fauxClient([
    L({ ai_clean_verdict: 'positif' }),
    L({ ai_clean_verdict: 'remarque', user_id: 'u2' })
  ], journal), { userId: 'u1', periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.total, 1)
  assert.strictEqual(journal[0].filtres.user_id, 'u1')
})

test('ratio : sans userId, aucun chiffre et aucune requête', async () => {
  const journal = []
  const r = await ratioProprete(fauxClient([L({ ai_clean_verdict: 'positif' })], journal), { periode: 'toujours' })
  assert.strictEqual(r.total, 0)
  assert.strictEqual(journal.length, 0)
})

test('ratio : périmètre VIDE rend zéro, jamais « tous »', async () => {
  // `[]` veut dire « aucun bien », `null` veut dire « tous ». Les confondre
  // montrerait à un membre au périmètre vide les chiffres de tout le compte.
  const journal = []
  const r = await ratioProprete(fauxClient([L({ ai_clean_verdict: 'positif' })], journal),
    { userId: 'u1', refs: [], periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.total, 0)
  assert.strictEqual(journal.length, 0, 'aucune requête n\'est même émise')
})

test('ratio : périmètre restreint à certains biens', async () => {
  const r = await ratioProprete(fauxClient([
    L({ ai_clean_verdict: 'positif', property_id_ref: '209413' }),
    L({ ai_clean_verdict: 'remarque', property_id_ref: '169567' })
  ]), { userId: 'u1', refs: ['209413'], periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.total, 1)
  assert.strictEqual(r.positif, 1)
})

// ─── Ce dont la fiche prestataire aura besoin ───────────────────────────────
test('ratio : restriction aux ménages d\'une prestataire', async () => {
  // C'est par ce paramètre que la fiche prestataire n'affichera que le travail
  // de la personne concernée. Sans lui, elle verrait le ratio de tout le compte.
  const r = await ratioProprete(fauxClient([
    L({ ai_clean_verdict: 'positif', menage_event_id: 'm1' }),
    L({ ai_clean_verdict: 'remarque', menage_event_id: 'm2' }),
    L({ ai_clean_verdict: 'remarque', menage_event_id: null })
  ]), { userId: 'u1', menageEventIds: ['m1'], periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.total, 1)
  assert.strictEqual(r.positif, 1)
  assert.strictEqual(r.remarque, 0)
})

test('ratio : liste de ménages VIDE rend zéro, jamais « tous »', async () => {
  // Une prestataire sans aucun ménage rattaché doit voir zéro — pas le ratio
  // de l'hôte entier.
  const journal = []
  const r = await ratioProprete(fauxClient([L({ ai_clean_verdict: 'remarque' })], journal),
    { userId: 'u1', menageEventIds: [], periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.total, 0)
  assert.strictEqual(journal.length, 0)
})

// ─── Une panne n'est pas un résultat ────────────────────────────────────────
test('ratio : une panne SQL se signale, elle ne rend pas zéro en silence', async () => {
  const r = await ratioProprete(fauxClient([], [], { message: 'timeout' }),
    { userId: 'u1', periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.erreur, true)
  assert.strictEqual(r.total, 0)
})

test('ratio : la période filtre bien sur received_at', async () => {
  const journal = []
  await ratioProprete(fauxClient([], journal), { userId: 'u1', periode: '15j', maintenant: T0 })
  assert.strictEqual(journal[0].gte.colonne, 'received_at')
  assert.strictEqual(journal[0].gte.valeur, borneDepuis('15j', T0))
})
