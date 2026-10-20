// tests/stats-avis.test.js
// La fonction de ratio est PARTAGÉE entre /avis (côté hôte) et, bientôt, la
// fiche prestataire. Ces tests fixent son contrat : deux chiffres calculés
// différemment pour la même chose finiraient par se contredire, et c'est celui
// montré à la prestataire qui perdrait sa crédibilité.

const test = require('node:test')
const assert = require('node:assert')
const { ratioProprete, noteMoyenne, notesDuPerimetre, borneDepuis, PERIODES } = require('../lib/stats-avis')
// La semantique PostgREST que ce double doit honorer — une seule implementation
// pour les trois fichiers qui montent un double d'`ota_reviews`.
const FAUX = require('./faux-postgrest')

const T0 = Date.parse('2026-09-03T12:00:00Z')

// ⚠ Ce double COMPTE, comme la vraie base. `ratioProprete` utilise
// `select('id', { count: 'exact', head: true })` : compter en JS sur des lignes
// rapatriees tronquait en silence au-dela de 1000 (db-max-rows).
//
// ⚠ Il ACCUMULE les `in` dans un tableau. Une version precedente n'en gardait
// qu'un seul : le second appel ecrasait le premier, et le test « la prestataire
// ne voit que son travail » serait passe au vert avec le cloisonnement par bien
// silencieusement ignore.
function fauxClient (lignes = [], journal = [], erreur = null) {
  return {
    from (table) {
      const appel = { table, filtres: {}, ins: [], gte: null, head: false }
      journal.push(appel)
      // ⚠ Les tables de l'attribution existent maintenant que ratioProprete
      // accepte `prestataireId`. Sans elles, le double renvoyait les avis pour
      // n'importe quelle table — y compris `profiles` — et le test « une
      // prestataire sans attribution voit zéro » ne testait rien de réel.
      const AUTRES = ['profiles', 'prestataire_periodes', 'menage_events']

      const evaluerOr = (l, e) => FAUX.evaluerOr(l, e)
      const passeEmbed = (l) =>
        FAUX.passeEmbed(l, appel.filtres, (fauxClient.attribution || {}).menage_events)
      const retenir = (l) =>
        Object.entries(appel.filtres).every(([c, v]) =>
          // ⚠ Les colonnes de l'EMBED ne sont pas des colonnes d'`ota_reviews` :
          // elles sont traitees par `passeEmbed`. Les comparer ici les rendait
          // toutes fausses (`l['menage_events.user_id']` n'existe pas), et le
          // filtre n'aurait plus rien retenu — un test rouge pour la mauvaise
          // raison, ce qui est aussi trompeur qu'un test vert pour la mauvaise.
          c.startsWith('menage_events.') ? true
          : c === 'statut' ? (l.statut || 'confirme') === v
          // Un avis sans drapeau est visible, comme la colonne `is_hidden` (defaut false).
          : c === 'is_hidden' ? (l.is_hidden === true) === v : l[c] === v) &&
        passeEmbed(l) &&
        (!appel.gte || String(l[appel.gte.colonne] || '') >= String(appel.gte.valeur)) &&
        appel.ins.every(f => f.valeurs.includes(String(l[f.colonne]))) &&
        (appel.ors || []).every(e => evaluerOr(l, e))
      // Jeu d'attribution optionnel : sans lui, `avisDuPrestataire` sort tout de
      // suite et la ligne `.in('id', idsAttribues)` n'est JAMAIS exercee — le
      // test de l'invariant central du §6 ne testait donc rien.
      const attrib = fauxClient.attribution || null
      const chain = {
        select (c, opts) { appel.select = c; appel.head = !!(opts && opts.head); appel.count = opts && opts.count; return chain },
        eq (c, v) { appel.filtres[c] = v; return chain },
        // ⚠ LE DOUBLE EVALUE `or()`, IL NE L'IGNORE PAS — et il REFUSE ce qu'il
        // ne sait pas evaluer. Un double qui laisserait passer une expression
        // inconnue rendrait le bornage par dates indetectable : on pourrait le
        // casser sans qu'un test bronche. Deux formes seulement sont emises par
        // `bornerParDate`, ce sont les deux qui sont reconnues ; toute autre
        // leve, et c'est voulu.
        or (expr) { (appel.ors = appel.ors || []).push(String(expr)); return chain },
        gte (c, v) { appel.gte = { colonne: c, valeur: v }; return chain },
        in (c, v) { appel.ins.push({ colonne: c, valeurs: (v || []).map(String) }); return chain },
        not (c, op, v) { if (op === 'is' && v === null) (appel.nonNuls = appel.nonNuls || []).push(c); return chain },
        order () { return chain },
        // La moyenne lit par pages : `range` resout comme `limit`.
        // ⚠ ET IL HONORE `erreur`, comme `then`. Jusqu'au 20 octobre 2026 il
        // resolvait toujours sans erreur : les deux fonctions qui lisent par
        // pages (`noteMoyenne`, `notesDuPerimetre`) etaient les seules dont le
        // chemin de PANNE ne pouvait etre eprouve par ce double. Une panne qui
        // se lirait « aucun avis » est precisement ce qu'elles promettent
        // d'eviter.
        // ⚠ ET IL HONORE `head` ET `count`, comme PostgREST. Mesure du 20 octobre
        // 2026 : un double qui ENREGISTRE `head` sans l'appliquer laissait passer
        // `select(select, { count: 'exact', head: true })` — l'idiome que
        // `ratioProprete` vante justement, dans un lot dont le sujet est le cout
        // des lectures. En production, `head: true` ne transfere AUCUNE ligne :
        // `n` resterait a 0 et l'accueil n'afficherait plus de note, en silence,
        // pour tout le monde. Le `count` est celui de TOUT le filtre, pas de la
        // page : c'est ce qui permet de voir une lecture incomplete.
        range (a, z) {
          if (erreur) return Promise.resolve({ data: null, count: null, error: erreur })
          const tous = lignes.filter(retenir).filter(l => (appel.nonNuls || []).every(c => l[c] != null))
          return Promise.resolve({
            data: appel.head ? null : tous.slice(a, z + 1),
            count: appel.count === 'exact' ? tous.length : null,
            error: null
          })
        },
        // `avisDuPrestataire` borne ses lectures : le double doit resoudre.
        limit () {
          if (AUTRES.includes(table)) {
            const d = attrib && attrib[table] ? attrib[table] : []
            return Promise.resolve({ data: d, error: null })
          }
          return Promise.resolve({ data: lignes.filter(retenir), error: null })
        },
        maybeSingle () {
          if (AUTRES.includes(table)) {
            const d = attrib && attrib[table] ? attrib[table] : []
            return Promise.resolve({ data: d[0] || null, error: null })
          }
          return Promise.resolve({ data: null, error: null })
        },
        then (r) {
          if (AUTRES.includes(table)) {
            const d = attrib && attrib[table] ? attrib[table] : []
            return Promise.resolve({ data: d, count: d.length, error: null }).then(r)
          }
          if (erreur) return Promise.resolve({ data: null, count: null, error: erreur }).then(r)
          const d = lignes.filter(retenir)
          return Promise.resolve({ data: appel.head ? null : d, count: d.length, error: null }).then(r)
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

test('ratio : les DEUX filtres s\'appliquent ensemble', async () => {
  // ⚠ C'est l'appel de la fiche prestataire : les ménages de la personne, dans
  // les biens de son périmètre. Un double qui n'accumulait qu'un seul `in`
  // aurait laissé ce test au vert en n'appliquant qu'une des deux restrictions —
  // le cloisonnement par bien silencieusement ignoré.
  const r = await ratioProprete(fauxClient([
    L({ ai_clean_verdict: 'positif',  property_id_ref: '209413', menage_event_id: 'm1' }),
    L({ ai_clean_verdict: 'remarque', property_id_ref: '169567', menage_event_id: 'm1' }),
    L({ ai_clean_verdict: 'remarque', property_id_ref: '209413', menage_event_id: 'm2' })
  ]), { userId: 'u1', refs: ['209413'], menageEventIds: ['m1'], periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.total, 1, 'seule la ligne qui satisfait LES DEUX filtres')
  assert.strictEqual(r.positif, 1)
  assert.strictEqual(r.remarque, 0)
})

test('ratio : le comptage se fait côté base, sans rapatrier les lignes', async () => {
  // Compter en JS sur la réponse tronquait en silence au-delà de db-max-rows
  // (1000) : le total était faux, en moins, et rien ne le disait.
  const journal = []
  await ratioProprete(fauxClient([L({ ai_clean_verdict: 'positif' })], journal),
    { userId: 'u1', periode: 'toujours', maintenant: T0 })
  assert.ok(journal.length >= 4, 'un comptage par verdict, plus le total')
  for (const a of journal) {
    assert.strictEqual(a.count, 'exact', 'count exact')
    assert.strictEqual(a.head, true, 'aucune ligne ne doit être transférée')
  }
})

test('ratio : la période rendue est NORMALISÉE, pas celle reçue', async () => {
  // Rendre l'entrée telle quelle faisait se contredire `periode` et `depuis`
  // dans le même objet.
  const r = await ratioProprete(fauxClient([]), { userId: 'u1', periode: 'constructor', maintenant: T0 })
  assert.strictEqual(r.periode, '30j')
  assert.strictEqual(r.depuis, borneDepuis('30j', T0))
})

// ─── L'attribution à une prestataire ────────────────────────────────────────
test('ratio : une prestataire sans attribution voit ZÉRO, pas le ratio de l\'hôte', async () => {
  // ⚠ L'invariant le plus important de la fiche prestataire. Si l'absence
  // d'attribution se lisait comme « aucun filtre », elle verrait le travail de
  // tout le monde — y compris les remarques qui ne la concernent pas.
  const sb = fauxClient([L({ ai_clean_verdict: 'remarque' })])
  // Aucun profil, donc aucune attribution possible.
  const r = await ratioProprete(sb, { userId: 'u1', prestataireId: 'inconnu',
                                      periode: 'toujours', maintenant: T0 })
  assert.strictEqual(r.total, 0)
  assert.strictEqual(r.remarque, 0)
})

// ─── L'invariant central du §6, réellement exercé ──────────────────────────
test('ratio : une prestataire ne voit QUE ses avis, jamais ceux de l\'hôte', async () => {
  // ⚠ Supprimer `.in('id', idsAttribues)` de ratioProprete fait voir à la
  // prestataire le ratio COMPLET de l'hôte — le scénario que la spec déclare le
  // plus important à empêcher — et les 801 tests restaient verts. Le test
  // précédent utilisait un prestataireId inconnu : il ne quittait jamais la
  // sortie anticipée et n'atteignait jamais la ligne à protéger. C'est la
  // version confortable du cas dangereux, exactement ce que REVIEW.md §8 décrit.
  const SIEN = L({ ai_clean_verdict: 'positif',  id: 'sien',  property_id_ref: 'COL' })
  const AUTRE = L({ ai_clean_verdict: 'remarque', id: 'autre', property_id_ref: 'AILLEURS' })
  fauxClient.attribution = {
    profiles: [{ id: 'p1', account_user_id: 'u1', pwa_token: null }],
    prestataire_periodes: [{ user_id: 'u1', provider_id: 'p1', property_id_ref: 'COL', debut: null, fin: null }],
    menage_events: []
  }
  try {
    const r = await ratioProprete(fauxClient([SIEN, AUTRE]),
      { userId: 'u1', prestataireId: 'p1', periode: 'toujours', maintenant: T0 })
    assert.strictEqual(r.total, 1, 'seul son avis compte')
    assert.strictEqual(r.positif, 1)
    assert.strictEqual(r.remarque, 0, 'la remarque d\'un bien qui n\'est pas le sien ne doit pas remonter')
  } finally {
    fauxClient.attribution = null
  }
})

// ─── Le comptage ne connaît plus la borne des identifiants ─────────────────
//
// ⚠ CE QUE CES TESTS FERMENT, mesuré en production le 14 septembre 2026.
// Le ratio comptait `.in('id', idsAttribues)`, et cette liste est bornée à
// MAX_IDS = 150 par la longueur d'URL. Régina avait **577** avis attribuables ;
// sa PWA en affichait **150**, marqués « tronqués », donc son en-tête restait
// masquée — 74 % de son travail invisible pour elle. Le chiffre n'était même pas
// un sous-total : la borne s'appliquait DEUX fois (150 par période puis 150 au
// global) sur des lignes qu'aucun `order` ne fixait, donc il pouvait changer
// d'un appel à l'autre.

const { MAX_IDS } = require('../lib/attribution-prestataire')

function jeuDeLignes (n, ref) {
  return Array.from({ length: n }, (_, i) =>
    L({ id: 'a' + i, property_id_ref: ref,
        ai_clean_verdict: i % 2 ? 'positif' : 'rien_signale' }))
}

test('ratio : EXACT au-delà de MAX_IDS, et plus aucun drapeau tronqué', async () => {
  const N = MAX_IDS * 3 + 7            // très au-delà de la borne, comme Régina
  fauxClient.attribution = {
    profiles: [{ id: 'p1', account_user_id: 'u1', pwa_token: null }],
    prestataire_periodes: [{ user_id: 'u1', provider_id: 'p1', property_id_ref: 'COL',
                             debut: null, fin: null }],
    menage_events: []
  }
  try {
    const r = await ratioProprete(fauxClient(jeuDeLignes(N, 'COL')),
      { userId: 'u1', prestataireId: 'p1', periode: 'toujours', maintenant: T0 })
    assert.strictEqual(r.total, N, 'le compteur ne doit plus s\'arrêter à la borne')
    assert.strictEqual(r.positif, Math.floor(N / 2))
    assert.strictEqual(r.tronque, undefined,
      'plus de drapeau : un compteur exact n\'a rien à signaler, et le drapeau masquait l\'en-tête')
  } finally { fauxClient.attribution = null }
})

test('ratio : un avis qui relève des DEUX voies n\'est compté qu\'une fois', async () => {
  // ⚠ LE PIÈGE DU COMPTAGE PAR FILTRES. `avisDuPrestataire` ne pouvait pas avoir
  // ce défaut — sa `Map` dédoublonnait par id. En comptant par filtres, un avis
  // dont le ménage est précisément le sien ET qui tombe dans une période
  // déclarée serait compté deux fois. Et gonfler le total ADOUCIT son ratio de
  // remarques : un chiffre faux dans le sens flatteur reste un chiffre faux.
  const DEUX_VOIES = L({ id: 'x', property_id_ref: 'COL', menage_event_id: 'e1',
                         ai_clean_verdict: 'remarque' })
  const PERIODE_SEULE = L({ id: 'y', property_id_ref: 'COL', ai_clean_verdict: 'positif' })
  fauxClient.attribution = {
    profiles: [{ id: 'p1', account_user_id: 'u1', pwa_token: 'jeton-p1' }],
    prestataire_periodes: [{ user_id: 'u1', provider_id: 'p1', property_id_ref: 'COL',
                             debut: null, fin: null }],
    menage_events: [{ id: 'e1', token: 'jeton-p1' }]
  }
  try {
    const r = await ratioProprete(fauxClient([DEUX_VOIES, PERIODE_SEULE]),
      { userId: 'u1', prestataireId: 'p1', periode: 'toujours', maintenant: T0 })
    assert.strictEqual(r.total, 2, 'deux avis, pas trois')
    assert.strictEqual(r.remarque, 1, 'la remarque ne compte qu\'une fois')
  } finally { fauxClient.attribution = null }
})

test('ratio : le ménage d\'une AUTRE prestataire ne lui est pas compté deux fois non plus', async () => {
  // Contre-épreuve de la soustraction : si l'intersection retirait plus que la
  // voie 1 ne rapporte, un avis légitime disparaîtrait du compte.
  const AUTRE = L({ id: 'z', property_id_ref: 'COL', menage_event_id: 'e9',
                    ai_clean_verdict: 'positif' })
  fauxClient.attribution = {
    profiles: [{ id: 'p1', account_user_id: 'u1', pwa_token: 'jeton-p1' }],
    prestataire_periodes: [{ user_id: 'u1', provider_id: 'p1', property_id_ref: 'COL',
                             debut: null, fin: null }],
    menage_events: [{ id: 'e9', token: 'jeton-de-quelqu-un-d-autre' }]
  }
  try {
    const r = await ratioProprete(fauxClient([AUTRE]),
      { userId: 'u1', prestataireId: 'p1', periode: 'toujours', maintenant: T0 })
    assert.strictEqual(r.total, 1,
      'la période déclarée le lui attribue — c\'est la règle en vigueur, on ne la change pas ici')
  } finally { fauxClient.attribution = null }
})

test('ratio : deux périodes qui se chevauchent sur le MÊME bien ne doublent pas le compte', async () => {
  // ⚠ Les intervalles sont FUSIONNÉS avant comptage. Sans fusion, un avis
  // couvert par les deux périodes est compté deux fois — c'est le second piège
  // du comptage par filtres, et il n'existait pas avec la Map.
  fauxClient.attribution = {
    profiles: [{ id: 'p1', account_user_id: 'u1', pwa_token: null }],
    prestataire_periodes: [
      { user_id: 'u1', provider_id: 'p1', property_id_ref: 'COL', debut: null, fin: '2026-08-31' },
      { user_id: 'u1', provider_id: 'p1', property_id_ref: 'COL', debut: '2026-08-01', fin: null }
    ],
    menage_events: []
  }
  try {
    const r = await ratioProprete(
      fauxClient([L({ id: 'a', property_id_ref: 'COL', stay_end: '2026-08-15',
                      ai_clean_verdict: 'positif' })]),
      { userId: 'u1', prestataireId: 'p1', periode: 'toujours', maintenant: T0 })
    assert.strictEqual(r.total, 1, 'un seul avis, même s\'il tombe dans les deux périodes')
    assert.strictEqual(r.positif, 1)
  } finally { fauxClient.attribution = null }
})

test('ratio : un avis SANS aucune date n\'entre dans aucune période, même non bornée', async () => {
  // ⚠ `dansLaPeriode` rend `false` quand la date de rattachement est nulle.
  // Un intervalle ouvert des deux côtés se traduirait par « aucun filtre », donc
  // par l'inclusion de cet avis : la divergence entre les deux implémentations
  // du même invariant. Aucun cas en base aujourd'hui — on ferme la divergence,
  // pas le symptôme.
  fauxClient.attribution = {
    profiles: [{ id: 'p1', account_user_id: 'u1', pwa_token: null }],
    prestataire_periodes: [{ user_id: 'u1', provider_id: 'p1', property_id_ref: 'COL',
                             debut: null, fin: null }],
    menage_events: []
  }
  try {
    const r = await ratioProprete(
      fauxClient([{ user_id: 'u1', statut: 'confirme', id: 'sansdate',
                    property_id_ref: 'COL', stay_end: null, received_at: null,
                    ai_clean_verdict: 'positif' }]),
      { userId: 'u1', prestataireId: 'p1', periode: 'toujours', maintenant: T0 })
    assert.strictEqual(r.total, 0)
  } finally { fauxClient.attribution = null }
})

// ─── Le jour de bord, où le compteur et la liste se contredisaient ─────────

test('ratio : un avis reçu le DERNIER jour de la période y est compté', async () => {
  // ⚠ CONSTAT DE REVIEW, ET LE DOUBLE LE CACHAIT.
  // `received_at` est un `timestamptz` ; `fin` une date nue. `received_at <=
  // '2026-08-31'` vaut `<= 2026-08-31 00:00:00` : un avis reçu ce jour-là à 18 h
  // était EXCLU du compteur, pendant que `dansLaPeriode` — qui alimente la
  // LISTE — tronque à `slice(0,10)` et l'INCLUT. Les deux se contredisaient
  // exactement sur le jour de bord, et comme 136 avis sur 168 n'ont pas de
  // `stay_end`, c'est la branche dominante.
  // La première version de `tests/faux-postgrest.js` tronquait les deux colonnes
  // avant de comparer : elle reproduisait la sémantique de `dansLaPeriode`, pas
  // celle de PostgREST, donc ce test n'aurait pas pu échouer. Un double plus
  // indulgent que la base est un faux vert.
  fauxClient.attribution = {
    profiles: [{ id: 'p1', account_user_id: 'u1', pwa_token: null }],
    prestataire_periodes: [{ user_id: 'u1', provider_id: 'p1', property_id_ref: 'COL',
                             debut: null, fin: '2026-08-31' }],
    menage_events: []
  }
  try {
    const r = await ratioProprete(fauxClient([
      // Pas de séjour résolu : c'est `received_at` qui date l'avis.
      L({ id: 'bord', property_id_ref: 'COL', stay_end: null,
          received_at: '2026-08-31T18:30:00Z', ai_clean_verdict: 'remarque' }),
      // Le lendemain, lui, est bien DEHORS : sans cette contre-épreuve, un
      // correctif trop large passerait aussi.
      L({ id: 'apres', property_id_ref: 'COL', stay_end: null,
          received_at: '2026-09-01T00:00:00Z', ai_clean_verdict: 'positif' })
    ]), { userId: 'u1', prestataireId: 'p1', periode: 'toujours', maintenant: T0 })
    assert.strictEqual(r.total, 1, 'le 31 août à 18 h est DANS une période qui finit le 31 août')
    assert.strictEqual(r.remarque, 1)
    assert.strictEqual(r.positif, 0, 'le 1er septembre reste dehors')
  } finally { fauxClient.attribution = null }
})

test('ratio : la borne BASSE inclut bien tout le premier jour', async () => {
  // Contre-épreuve de la précédente : `>= debut` vaut `>= debut 00:00:00`, donc
  // la journée entière. Corriger la borne haute ne doit pas déplacer celle-ci.
  fauxClient.attribution = {
    profiles: [{ id: 'p1', account_user_id: 'u1', pwa_token: null }],
    prestataire_periodes: [{ user_id: 'u1', provider_id: 'p1', property_id_ref: 'COL',
                             debut: '2026-08-01', fin: null }],
    menage_events: []
  }
  try {
    const r = await ratioProprete(fauxClient([
      L({ id: 'premier', property_id_ref: 'COL', stay_end: null,
          received_at: '2026-08-01T00:00:01Z', ai_clean_verdict: 'positif' }),
      L({ id: 'veille', property_id_ref: 'COL', stay_end: null,
          received_at: '2026-07-31T23:59:59Z', ai_clean_verdict: 'remarque' })
    ]), { userId: 'u1', prestataireId: 'p1', periode: 'toujours', maintenant: T0 })
    assert.strictEqual(r.total, 1)
    assert.strictEqual(r.positif, 1)
    assert.strictEqual(r.remarque, 0, 'la veille reste dehors')
  } finally { fauxClient.attribution = null }
})

test('ratio : la voie 1 reste cloisonnée par COMPTE, pas seulement par jeton', async () => {
  // ⚠ DEFENSE EN PROFONDEUR, retiree par megarde en passant a l'embed puis
  // remise (constat de review). Un jeton n'a AUCUNE unicite garantie entre
  // comptes : deux hotes d'un meme property manager peuvent porter le meme.
  // Sans `menage_events.user_id`, seul `ota_reviews.user_id` contraignait.
  fauxClient.attribution = {
    profiles: [{ id: 'p1', account_user_id: 'u1', pwa_token: 'jeton-partage' }],
    prestataire_periodes: [],
    menage_events: [{ id: 'e1', token: 'jeton-partage', user_id: 'u1' },
                    { id: 'e2', token: 'jeton-partage', user_id: 'AUTRE-COMPTE' }]
  }
  try {
    const r = await ratioProprete(fauxClient([
      L({ id: 'sien', menage_event_id: 'e1', ai_clean_verdict: 'positif' }),
      L({ id: 'autre', menage_event_id: 'e2', ai_clean_verdict: 'remarque' })
    ]), { userId: 'u1', prestataireId: 'p1', periode: 'toujours', maintenant: T0 })
    assert.strictEqual(r.total, 1, 'le menage de l\'autre compte ne compte pas')
    assert.strictEqual(r.remarque, 0, 'et surtout pas sa remarque')
  } finally { fauxClient.attribution = null }
})

test('ratio : deux biens aux MÊMES bornes tiennent en une seule voie', async () => {
  // ⚠ Chaque voie coûte QUATRE requêtes (une par verdict), et l'endpoint en
  // lance jusqu'à deux séries. Une voie par bien donnait 88 requêtes par
  // chargement pour un hôte à cinq biens — sur un endpoint ouvert sans session.
  // Le regroupement ne change PAS le résultat, seulement la forme de la requête :
  // ce test vérifie les deux à la fois.
  const { filtresAttribution } = require('../lib/attribution-prestataire')
  fauxClient.attribution = {
    profiles: [{ id: 'p1', account_user_id: 'u1', pwa_token: null }],
    prestataire_periodes: [
      { user_id: 'u1', provider_id: 'p1', property_id_ref: 'A', debut: null, fin: null },
      { user_id: 'u1', provider_id: 'p1', property_id_ref: 'B', debut: null, fin: null },
      // Bornes DIFFÉRENTES : celui-là reste une voie à part, et c'est voulu.
      { user_id: 'u1', provider_id: 'p1', property_id_ref: 'C', debut: null, fin: '2026-08-31' }
    ],
    menage_events: []
  }
  try {
    const f = await filtresAttribution(fauxClient([]), { userId: 'u1', prestataireId: 'p1' })
    assert.strictEqual(f.voies.length, 2,
      'A et B partagent leurs bornes — une seule voie ; C en a d\'autres — la sienne')

    const r = await ratioProprete(fauxClient([
      L({ id: 'a', property_id_ref: 'A', stay_end: '2026-07-01', ai_clean_verdict: 'positif' }),
      L({ id: 'b', property_id_ref: 'B', stay_end: '2026-07-02', ai_clean_verdict: 'positif' }),
      L({ id: 'c', property_id_ref: 'C', stay_end: '2026-07-03', ai_clean_verdict: 'remarque' }),
      // Hors des bornes de C : ne doit pas être compté.
      L({ id: 'c2', property_id_ref: 'C', stay_end: '2026-09-15', ai_clean_verdict: 'remarque' }),
      // Un bien qui n'est à personne.
      L({ id: 'z', property_id_ref: 'AILLEURS', ai_clean_verdict: 'positif' })
    ]), { userId: 'u1', prestataireId: 'p1', periode: 'toujours', maintenant: T0 })
    assert.strictEqual(r.total, 3, 'A, B et le C dans les bornes — rien d\'autre')
    assert.strictEqual(r.positif, 2)
    assert.strictEqual(r.remarque, 1)
  } finally { fauxClient.attribution = null }
})


// ─── Recette du 7 octobre 2026 : les avis MASQUES par Airbnb ────────────────
// Double aveugle : le voyageur a depose son avis, Airbnb le cache (ni texte ni
// note) tant que l'hote n'a pas evalue. Ils entraient dans le total (688 au
// lieu de 664) et a 0/10 dans la moyenne (9,0 au lieu de 9,57).
test('recette du 7 octobre : un avis MASQUE par Airbnb ne compte ni dans le total ni dans la moyenne', async () => {
  const lignes = [
    { user_id: 'U', ai_clean_verdict: 'positif', overall_score: 10, received_at: '2026-10-01T00:00:00Z' },
    { user_id: 'U', ai_clean_verdict: 'positif', overall_score: 8, received_at: '2026-10-01T00:00:00Z' },
    { user_id: 'U', ai_clean_verdict: 'rien_signale', overall_score: 0, is_hidden: true, received_at: '2026-10-02T00:00:00Z' },
    { user_id: 'U', ai_clean_verdict: null, overall_score: null, received_at: '2026-10-02T00:00:00Z' },
  ]
  const r = await ratioProprete(fauxClient(lignes), { userId: 'U', periode: 'toujours' })
  assert.strictEqual(r.total, 3, 'le masque est exclu du total')
  const m = await noteMoyenne(fauxClient(lignes), { userId: 'U', periode: 'toujours' })
  assert.deepStrictEqual(m, { moyenne: 9, notes: 2 }, 'la moyenne : 10 et 8, ni le 0 du masque ni la note absente')
})

test('noteMoyenne : TOUTES les pages, jamais les 500 premieres lignes ; perimetre vide = rien', async () => {
  const lignes = Array.from({ length: 2500 }, (_, i) => ({ user_id: 'U', overall_score: i < 2000 ? 10 : 6, received_at: '2026-10-01T00:00:00Z' }))
  const m = await noteMoyenne(fauxClient(lignes), { userId: 'U', periode: 'toujours' })
  assert.deepStrictEqual(m, { moyenne: 9.2, notes: 2500 })
  assert.deepStrictEqual(await noteMoyenne(fauxClient(lignes), { userId: 'U', refs: [] }), { moyenne: null, notes: 0 })
  assert.deepStrictEqual(await noteMoyenne(fauxClient(lignes), { userId: null }), { moyenne: null, notes: 0 })
})

// ─── notesDuPerimetre : la même population, groupée par bien ────────────────
//
// ⚠ CE QU'ELLE DOIT GARANTIR. L'accueil demandait `cartes` une fois pour le
// compte puis une fois par bien, pour n'en lire que `moyenne` et `notes` : 4
// appels, 10,7 s puis 3 x 4-5 s en production le 20 octobre 2026. La nouvelle
// lecture ne vaut QUE si elle rend les mêmes chiffres — règle 8 de REVIEW.md.
// Ces tests comparent les deux fonctions ligne à ligne ; `scripts/verifier-
// parite-notes.js` refait la comparaison sur les données réelles.

const PARITE = [
  { user_id: 'U', overall_score: 10, property_id_ref: 'A', received_at: '2026-10-01T00:00:00Z' },
  { user_id: 'U', overall_score: 9,  property_id_ref: 'A', received_at: '2026-10-02T00:00:00Z' },
  { user_id: 'U', overall_score: 8,  property_id_ref: 'B', received_at: '2026-10-02T00:00:00Z' },
  { user_id: 'U', overall_score: 7,  property_id_ref: 'C', received_at: '2026-10-03T00:00:00Z' },
  // Ni l'un ni l'autre ne doit compter : masqué par Airbnb, et note absente.
  { user_id: 'U', overall_score: 0,  property_id_ref: 'A', is_hidden: true, received_at: '2026-10-03T00:00:00Z' },
  { user_id: 'U', overall_score: null, property_id_ref: 'B', received_at: '2026-10-03T00:00:00Z' },
  // Un autre compte : jamais.
  { user_id: 'AUTRE', overall_score: 1, property_id_ref: 'A', received_at: '2026-10-03T00:00:00Z' },
]

test('LE TEST QUI COMPTE : notesDuPerimetre rend EXACTEMENT ce que noteMoyenne rendait, bien par bien', async () => {
  const opts = { userId: 'U', periode: 'toujours' }
  const une = await notesDuPerimetre(fauxClient(PARITE), opts)

  // Le global, contre l'appel sans bien que faisait l'accueil.
  assert.deepStrictEqual(une.global, await noteMoyenne(fauxClient(PARITE), opts),
    'le global ne vaut plus ce que rendait l appel pour le compte')

  // Chaque bien, contre l'appel par bien qu'il remplace.
  for (const ref of ['A', 'B', 'C']) {
    assert.deepStrictEqual(une.par_bien[ref], await noteMoyenne(fauxClient(PARITE), { ...opts, refs: [ref] }),
      `le bien ${ref} ne vaut plus ce que rendait son appel`)
  }
  // Et les chiffres eux-memes, ecrits en clair : un test qui ne compare que
  // deux fonctions reste vert si les DEUX se trompent de la meme facon.
  assert.deepStrictEqual(une.global, { moyenne: 8.5, notes: 4 })
  assert.deepEqual({ ...une.par_bien }, {
    A: { moyenne: 9.5, notes: 2 }, B: { moyenne: 8, notes: 1 }, C: { moyenne: 7, notes: 1 }
  })
})

test("LE TEST QUI COMPTE : une reference `__proto__` ne fait pas disparaitre un bien", () => {
  // `property_id_ref` est une colonne TEXT alimentee par un provider. Avec un
  // objet litteral, `par_bien['__proto__'] = x` ecrit le PROTOTYPE au lieu de
  // creer une cle : le bien disparait de la reponse sans erreur, et ni
  // `Object.keys` ni `JSON.stringify` ne le montrent. D'ou `Object.create(null)`.
  const vide = Object.create(null)
  vide['__proto__'] = { moyenne: 9, notes: 1 }
  assert.deepEqual(Object.keys(vide), ['__proto__'],
    'le prototype nul ne protege plus : la cle est avalee')
})

test("LE TEST QUI COMPTE : les options d'attribution sont REFUSEES, pas ignorees", async () => {
  // `ratioProprete` les honore et restreint aux avis attribuables a une
  // prestataire. Les notes ne savent pas faire : les ignorer rendrait la
  // moyenne de l'HOTE sur l'ecran d'une femme de menage, sans erreur ni test
  // rouge. La fiche prestataire est le prochain consommateur annonce.
  for (const inconnue of ['prestataireId', 'menageEventIds', 'voies']) {
    await assert.rejects(
      () => notesDuPerimetre(fauxClient(PARITE), { userId: 'U', periode: 'toujours', [inconnue]: 'x' }),
      new RegExp(inconnue), `\`${inconnue}\` est accepte en silence`)
  }
})

test('un avis dont la reference ne designe aucun bien compte au global', async () => {
  // ⚠ CE QUE CE TEST EPROUVE VRAIMENT. `property_id_ref` est `text NOT NULL`
  // (migrations/2026-09-02-ota-reviews.sql:27) : la ligne a ref NULLE de ce jeu
  // n'existe pas en base, et le garde du code est une ceinture. Ce qui existe,
  // et que ce test represente, c'est la reference ORPHELINE — la colonne n'a
  // pas de cle etrangere, donc un re-keying Beds24 -> Channex, une bascule ou
  // un bien supprime laissent des avis dont la ref ne designe plus aucun bien.
  // Dans les deux cas la regle est la meme, et c'est elle qu'on fige : ils
  // comptent au GLOBAL, exactement comme dans l'appel global d'avant le lot, et
  // dans aucun groupe que l'ecran sache afficher.
  const lignes = [...PARITE, { user_id: 'U', overall_score: 2, property_id_ref: null, received_at: '2026-10-04T00:00:00Z' }]
  const r = await notesDuPerimetre(fauxClient(lignes), { userId: 'U', periode: 'toujours' })
  assert.strictEqual(r.global.notes, 5, 'la note sans bien est perdue pour le global')
  assert.deepStrictEqual(r.global, await noteMoyenne(fauxClient(lignes), { userId: 'U', periode: 'toujours' }))
  assert.deepStrictEqual(Object.keys(r.par_bien).sort(), ['A', 'B', 'C'], 'une cle de bien est apparue pour une ref nulle')
})

test('LE TEST QUI COMPTE : le perimetre d un membre est applique, et un perimetre VIDE rend zero', async () => {
  const restreint = await notesDuPerimetre(fauxClient(PARITE), { userId: 'U', periode: 'toujours', refs: ['A'] })
  assert.deepEqual({ ...restreint.par_bien }, { A: { moyenne: 9.5, notes: 2 } },
    'un membre limite au bien A voit les notes des autres biens')
  assert.deepStrictEqual(restreint.global, { moyenne: 9.5, notes: 2 },
    'le global d un membre restreint porte sur tout le compte')

  // Perimetre vide = aucun bien. JAMAIS « tous » : c'est le distinguo qui
  // empeche un membre revoque de voir le compte entier.
  const vide = await notesDuPerimetre(fauxClient(PARITE), { userId: 'U', refs: [] })
  assert.deepStrictEqual(vide.global, { moyenne: null, notes: 0 })
  assert.deepEqual({ ...vide.par_bien }, {})
  assert.strictEqual(Object.getPrototypeOf(vide.par_bien), null,
    'par_bien a de nouveau un prototype : une reference `__proto__` l ecrirait')
  assert.deepStrictEqual((await notesDuPerimetre(fauxClient(PARITE), { userId: null })).global, { moyenne: null, notes: 0 })
})

test('notesDuPerimetre lit TOUTES les pages, et une panne se DIT', async () => {
  // Une lecture non bornee serait tronquee a 1000 lignes sans erreur
  // (db-max-rows) : la moyenne porterait sur une fraction, en silence.
  const lignes = Array.from({ length: 2500 }, (_, i) => ({
    user_id: 'U', overall_score: i < 2000 ? 10 : 6, property_id_ref: i % 2 ? 'A' : 'B',
    received_at: '2026-10-01T00:00:00Z'
  }))
  const r = await notesDuPerimetre(fauxClient(lignes), { userId: 'U', periode: 'toujours' })
  assert.strictEqual(r.global.notes, 2500, 'la lecture est tronquee')
  assert.deepStrictEqual(r.global, await noteMoyenne(fauxClient(lignes), { userId: 'U', periode: 'toujours' }))

  const panne = await notesDuPerimetre(fauxClient(lignes, [], { message: 'boom' }), { userId: 'U', periode: 'toujours' })
  assert.strictEqual(panne.erreur, true, 'une panne de lecture passe pour « aucun avis »')
  assert.deepStrictEqual(panne.global, { moyenne: null, notes: 0 })
})

test('la periode borne les deux fonctions de la meme facon', async () => {
  const maintenant = Date.parse('2026-10-20T00:00:00Z')
  const lignes = [
    { user_id: 'U', overall_score: 10, property_id_ref: 'A', received_at: '2026-10-18T00:00:00Z' },
    { user_id: 'U', overall_score: 2,  property_id_ref: 'A', received_at: '2026-05-01T00:00:00Z' },
  ]
  const r = await notesDuPerimetre(fauxClient(lignes), { userId: 'U', periode: '30j', maintenant })
  assert.deepStrictEqual(r.global, { moyenne: 10, notes: 1 }, 'l avis hors periode est compte')
  assert.deepStrictEqual(r.global, await noteMoyenne(fauxClient(lignes), { userId: 'U', periode: '30j', maintenant }))
  assert.strictEqual(r.periode, '30j')
})

test("LE TEST QUI COMPTE : l'ordre PostgREST est respecte — select AVANT les filtres", async () => {
  // ⚠ CE QUE LES DOUBLES DE CE FICHIER NE PEUVENT PAS VOIR. Leur chaine accepte
  // tout, dans n'importe quel ordre. Le vrai client, non : `from()` rend un
  // QueryBuilder qui n'expose que select/insert/update/upsert/delete, et `eq`
  // n'existe qu'APRES `select`. Ecrit `from().eq(...).select(...)`, le code
  // leve un TypeError en production avec la suite entierement verte — c'est
  // arrive le 20 octobre 2026, en ecrivant `requeteDesNotes`.
  // Ce double a la FORME du vrai, et c'est tout ce qu'on lui demande.
  const vus = []
  const tris = []
  const strict = {
    from (table) {
      return {
        select (colonnes) {
          vus.push(colonnes)
          assert.ok(typeof colonnes === 'string' && colonnes.length,
            `select() appele sans colonnes sur ${table}`)
          let trie = false
          const f = {
            eq: () => f, gte: () => f, in: () => f, not: () => f,
            order: (c, o) => { trie = true; tris.push([c, o]); return f },
            // ⚠ `range` EXIGE d'avoir ete trie. C'est la seule facon de voir
            // disparaitre un `.order('id')` : aucun autre double ne l'observe.
            range: () => {
              assert.ok(trie, 'range() appele sans order() : la pagination n est pas une partition')
              return Promise.resolve({ data: [], count: 0, error: null })
            }
          }
          return f
        },
        insert () {}, update () {}, upsert () {}, delete () {}
      }
    }
  }
  // Les DEUX fonctions : elles partagent `requeteDesNotes`, donc le defaut.
  await noteMoyenne(strict, { userId: 'U', periode: 'toujours' })
  await notesDuPerimetre(strict, { userId: 'U', periode: 'toujours', refs: ['A'] })
  // Une seule lecture existe desormais : `noteMoyenne` en est la vue globale.
  assert.deepStrictEqual(vus, ['id, overall_score, property_id_ref', 'id, overall_score, property_id_ref'],
    'les colonnes demandees ont change : verifier que la lecture a toujours de quoi grouper')
  // ⚠ ET LE TRI EST DANS LA REQUETE PARTAGEE. Sans ORDER BY, PostgREST ne
  // garantit aucun ordre : deux `range()` peuvent se chevaucher ou sauter des
  // lignes, et la moyenne porte sur autre chose qu'une partition. Aucun autre
  // double du depot n'observe `order()`.
  assert.deepStrictEqual(tris, [['id', { ascending: true }], ['id', { ascending: true }]],
    'la lecture paginee n est plus triee : `range()` devient un tirage, pas une pagination')
})

test("LE TEST QUI COMPTE : une lecture ROGNEE se dit, elle ne rend pas une moyenne partielle", async () => {
  // Une page plus courte que demandee veut dire « fin des donnees »… ou
  // « db-max-rows a rogne ». Les deux sont indistinguables SANS le total, et
  // rogner en silence donne une moyenne sur une fraction sans la moindre
  // erreur — exactement ce que le bloc de `ratioProprete` raconte avoir vecu.
  // Le compte exact est demande avec la PREMIERE page, dans la meme requete.
  const plafond = 500
  const rogne = {
    from: () => ({
      select (colonnes, opts) {
        const compte = !!(opts && opts.count === 'exact')
        const f = {
          eq: () => f, gte: () => f, in: () => f, not: () => f, order: () => f,
          range: () => Promise.resolve({
            data: Array.from({ length: plafond }, (_, i) => ({ id: i, overall_score: 10, property_id_ref: 'A' })),
            count: compte ? 3000 : null,
            error: null
          })
        }
        return f
      }
    })
  }
  const r = await notesDuPerimetre(rogne, { userId: 'U', periode: 'toujours' })
  assert.strictEqual(r.tronque, true, '500 lignes lues sur 3000 annoncees, et la reponse ne le dit pas')
  assert.strictEqual(r.global.notes, 500)
  // Et la vue globale porte le meme drapeau : c'est la MEME lecture.
  const m = await noteMoyenne(rogne, { userId: 'U', periode: 'toujours' })
  assert.strictEqual(m.tronque, true)
})
