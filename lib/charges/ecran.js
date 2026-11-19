// lib/charges/ecran.js — LES LECTURES DE L'ÉCRAN `/charges` (lot 3).
// Spec : docs/specs/spec-compte-de-charges.md §13.
//
// ⚠ LECTURE SEULE, ET CHAQUE REQUÊTE PORTE `user_id` : la clé de service ne
// filtre rien d'elle-même (RLS sans politique). Le compte vient de la garde de
// l'endpoint, jamais du navigateur.
//
// Deux catégories de données, et elles ne se mélangent pas (§13.1) :
//   · TEMPS RÉEL — la file « À traiter » et la liste des factures, lues dans
//     `charges` par index ;
//   · NON URGENT — les totaux, servis par `charges_totaux` à partir du résumé
//     tenu par trigger. Rien n'est additionné ici à partir des factures.

const { jourParis, CATEGORIES } = require('./regles')

// L'ordre de la liste fermée (Q5), tel que la spec la donne : un tableau, pas
// un `Set` — un `Set` passe en JSON comme un objet vide.
const ORDRE_CATEGORIES = CATEGORIES.map(c => c.cle)

const PAGE = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/
// Un instant tel que PostgREST le rend (`cree_le`) : chiffres, `T`, `:`, `.`,
// et un fuseau. Rien qui puisse fermer les guillemets du filtre.
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/

// Les colonnes d'une ligne de l'écran. Pas `lecture_ia` entière : la réponse
// brute de l'IA n'a rien à faire dans une liste (elle peut peser plusieurs Ko
// par ligne). Lot 7a : le type, la période, et de l'IA le SEUL solde lu d'une
// régularisation, montré à côté de la consommation et jamais compté.
const COLONNES = 'id, statut, motif, origine, entite_juridique_id, bien_id, fournisseur_nom, ' +
  'fournisseur_siret, numero_facture, date_facture, jour, date_repli, montant_ht_cents, ' +
  'montant_tva_cents, montant_ttc_cents, categorie, signal, signal_tranche, groupe_doublon, ' +
  'tentatives_lecture, cree_le, valide_le, type_document, periode_debut, periode_fin, ' +
  'solde_lu:lecture_ia->solde_ttc_cents'

// Les mots d'avant le lot 8a restent COMPRIS (liens et onglets déjà ouverts) :
// `exercice` est l'exercice en cours, `exercice_precedent` celui d'avant,
// `12_mois` retombe sur l'exercice en cours. Une période se nomme désormais
// par l'année où l'exercice commence (`2025`).
const PERIODES_D_AVANT = ['exercice', 'exercice_precedent', '12_mois']
// Le réglage standard (décision de Thierry du 19 novembre 2026, §14.21) : une
// entité sans début d'exercice suit l'année civile.
const DEBUT_STANDARD = '01-01'
// Au plus tant d'exercices proposés avant celui en cours : une date de
// facture saisie en 1926 n'ouvre pas cent options.
const EXERCICES_MAX = 20
const ANNEE_RE = /^\d{4}$/
const MOIS_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

// ─── Les bornes d'une période ────────────────────────────────────────────────
const enJour = (d) => d.toISOString().slice(0, 10)
function dateUTC (a, m, j) { return new Date(Date.UTC(a, m - 1, j)) }

/** Le premier jour d'un exercice qui commence le `mmjj` de l'année `a`. */
function debutExercice (a, mmjj) {
  const [m, j] = mmjj.split('-').map(Number)
  const d = dateUTC(a, m, j)
  // Un 29 février une année ordinaire : le dernier jour du mois, le 28.
  return d.getUTCMonth() === m - 1 ? d : dateUTC(a, m + 1, 0)
}

/** L'année où commence l'exercice (`mmjj`) qui contient le jour `jour`. */
function anneeDExercice (jour, mmjj) {
  const a = Number(String(jour).slice(0, 4))
  return enJour(debutExercice(a, mmjj)) > jour ? a - 1 : a
}

/**
 * L'exercice demandé pour une entité, ses bornes, et les exercices proposés.
 * ⚠ §14.21 (décisions de Thierry du 19 novembre 2026) : une entité SANS début
 * d'exercice suit l'année civile — le réglage standard —, et l'on choisit un
 * exercice parmi ceux qui portent des factures, l'exercice en cours toujours
 * compris. Cela REMPLACE Q22 et Q33 (« les 12 derniers mois »).
 * `bornes` : `{ premier, dernier }`, les jours extrêmes du résumé pour
 * l'entité (ou rien : seul l'exercice en cours est proposé).
 * Une période inconnue retombe sur l'exercice en cours.
 */
function bornesPeriode ({ periode, entite, aujourdhui = jourParis(), bornes = null }) {
  const reglee = entite && entite.debut_exercice && /^\d{2}-\d{2}$/.test(entite.debut_exercice)
  const mmjj = reglee ? entite.debut_exercice : DEBUT_STANDARD
  const enCours = anneeDExercice(aujourdhui, mmjj)
  const jourOk = (j) => typeof j === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j)
  let plusAncien = enCours
  let plusRecent = enCours
  if (bornes && jourOk(bornes.premier)) plusAncien = Math.min(enCours, anneeDExercice(bornes.premier, mmjj))
  if (bornes && jourOk(bornes.dernier)) plusRecent = Math.max(enCours, anneeDExercice(bornes.dernier, mmjj))
  plusAncien = Math.max(plusAncien, enCours - EXERCICES_MAX)
  const proposees = []
  for (let a = plusRecent; a >= plusAncien; a--) proposees.push(String(a))
  let annee = enCours
  if (periode === 'exercice_precedent') annee = enCours - 1
  else if (typeof periode === 'string' && ANNEE_RE.test(periode)) {
    const n = Number(periode)
    // Un exercice hors de la liste se lit quand même s'il est raisonnable :
    // l'URL d'un exercice ancien reste valable. Hors de [enCours − 20 ;
    // enCours + 5], l'exercice en cours.
    if (n >= enCours - EXERCICES_MAX && n <= enCours + 5) annee = n
  }
  const debut = debutExercice(annee, mmjj)
  const fin = new Date(debutExercice(annee + 1, mmjj).getTime() - 24 * 3600 * 1000)
  return { periode: String(annee), proposees, debut: enJour(debut), fin: enJour(fin), debut_exercice: mmjj, standard: !reglee }
}

/** Le premier et le dernier jour d'un mois `YYYY-MM`, ou `null`. */
function bornesMois (mois) {
  const m = MOIS_RE.exec(String(mois || ''))
  if (!m) return null
  const a = Number(m[1])
  const n = Number(m[2])
  return { debut: enJour(dateUTC(a, n, 1)), fin: enJour(dateUTC(a, n + 1, 0)) }
}

// ─── Le curseur de la liste : « jour|cree_le|id » ────────────────────────────
// ⚠ IL ENTRE DANS UN FILTRE PostgREST (`or(...)`) : chaque partie est validée
// par un motif ANCRÉ avant, et l'instant est en plus mis entre guillemets (il
// porte `:` et `.`, réservés dans un filtre). Un texte libre y ajouterait des
// conditions.
function lireCurseur (brut) {
  if (brut == null || brut === '') return { ok: true, curseur: null }
  const parts = String(brut).split('|')
  if (parts.length !== 3) return { ok: false }
  const [jour, cree, id] = parts
  if (!JOUR_RE.test(jour) || !INSTANT_RE.test(cree) || !UUID_RE.test(id)) return { ok: false }
  return { ok: true, curseur: { jour, cree_le: cree, id } }
}
const ecrireCurseur = (c) => `${c.jour}|${c.cree_le}|${c.id}`

// ─── Les lectures ────────────────────────────────────────────────────────────
/**
 * « À traiter » (temps réel) : à vérifier, en lecture, illisible, et tout
 * doublon non tranché. Les 50 plus récentes, et leur nombre EXACT — compté en
 * base sur toutes les lignes, pas sur la page.
 */
async function aTraiter (db, compte) {
  const { data, error, count } = await db.from('charges').select(COLONNES, { count: 'exact' })
    .eq('user_id', compte)
    .or('statut.in.(a_lire,a_verifier,illisible),and(signal.not.is.null,signal_tranche.is.false)')
    .neq('statut', 'envoi')
    .order('cree_le', { ascending: false }).order('id', { ascending: false })
    .limit(PAGE)
  if (error || typeof count !== 'number') return { ok: false }
  return { ok: true, lignes: data || [], nombre: count }
}

/**
 * Toutes les factures (temps réel), les plus récentes d'abord : jour de la
 * charge, puis arrivée (spec §13.2), puis identifiant pour départager deux
 * arrivées à la même microseconde. ⚠ PAR CURSEUR, JAMAIS PAR DÉCALAGE : une
 * facture qui arrive entre deux pages ne décale ni ne double aucune ligne. On
 * lit PAGE + 1 pour savoir s'il y a une suite sans la compter.
 */
async function liste (db, compte, curseur = null, entiteId = null) {
  let q = db.from('charges').select(COLONNES)
    .eq('user_id', compte).neq('statut', 'envoi')
  // ⚠ UNE ENTITÉ À LA FOIS (§14.21, décision 7) : la liste suit l'entité
  // choisie ; « À traiter » reste commun au compte.
  if (entiteId) q = q.eq('entite_juridique_id', entiteId)
  if (curseur) {
    const { jour, cree_le: cree, id } = curseur
    q = q.or(`jour.lt.${jour},and(jour.eq.${jour},cree_le.lt."${cree}"),and(jour.eq.${jour},cree_le.eq."${cree}",id.lt.${id})`)
  }
  const { data, error } = await q
    .order('jour', { ascending: false }).order('cree_le', { ascending: false }).order('id', { ascending: false })
    .limit(PAGE + 1)
  if (error) return { ok: false }
  const lignes = (data || []).slice(0, PAGE)
  const suite = (data || []).length > PAGE ? ecrireCurseur(lignes[lignes.length - 1]) : null
  return { ok: true, lignes, suite }
}

// ⚠ PAGE APRÈS PAGE (règle 6 de la case performance) : PostgREST rend 1000
// lignes SANS erreur. Un compte n'a pas 1000 logements aujourd'hui ; la lecture
// ne le suppose pas.
async function tousLesBiens (db, compte) {
  const lignes = []
  for (let depuis = 0; ; depuis += 1000) {
    const { data, error } = await db.from('properties').select('id, name, archive_le')
      .eq('user_id', compte).order('id', { ascending: true }).range(depuis, depuis + 999)
    if (error) return { ok: false }
    lignes.push(...(data || []))
    if (!data || data.length < 1000) return { ok: true, lignes }
  }
}

/**
 * Les logements du compte et leur entité, en DEUX listes.
 * ⚠ `biens` : les logements ACTIFS, ceux qu'on propose dans la fiche.
 * `biens_archives` : ceux qu'on ne propose plus, mais dont une facture
 * ancienne garde le nom — une ligne de liste ou de répartition doit pouvoir
 * le nommer et le marquer « archivé » (même partage que l'accueil, décision 1
 * de Thierry du 31 octobre 2026).
 */
async function biens (db, compte, deps = {}) {
  const ej = deps.entites || require('../entites-juridiques')
  const [b, l] = await Promise.all([tousLesBiens(db, compte), ej.liensDuCompte(compte, { db })])
  if (!b.ok || !l.ok) return { ok: false }
  const entiteDe = new Map((l.liens || []).map(x => [String(x.property_uuid), x.entite_id]))
  const forme = (x) => ({ id: x.id, nom: x.name, entite_id: entiteDe.get(String(x.id)) || null })
  const tous = b.lignes.sort((x, y) => String(x.name || '').localeCompare(String(y.name || '')))
  return {
    ok: true,
    biens: tous.filter(x => !x.archive_le).map(forme),
    archives: tous.filter(x => x.archive_le).map(forme)
  }
}

/**
 * Les totaux (non urgent), lus dans le résumé par `charges_totaux`, en UN
 * objet : aucune lecture ne peut être tronquée. ⚠ UN MONTANT ABSENT RESTE
 * `null` : la fonction ne remplace jamais une somme vide par 0.
 */
async function totaux (db, compte, { debut, fin, entiteId = null }) {
  const { data, error } = await db.rpc('charges_totaux', {
    p_user: compte, p_debut: debut, p_fin: fin, p_entite: entiteId
  })
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) return { ok: false }
  return { ok: true, totaux: data }
}

/**
 * Le premier et le dernier jour du résumé qui portent une facture, pour une
 * entité (§14.21) : l'écran en tire les exercices proposés. Non urgent, lu
 * dans le résumé, en UN objet.
 */
async function exercicesBornes (db, compte, entiteId) {
  const { data, error } = await db.rpc('charges_exercices_bornes', { p_user: compte, p_entite: entiteId })
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) return { ok: false }
  return { ok: true, bornes: { premier: data.premier || null, dernier: data.dernier || null } }
}

/**
 * Les factures d'un mois et la PART de chacune (§14.21.2), par
 * `charges_detail_mois` : la règle du résumé à l'identique, donc la somme des
 * parts est le total « Étalé » du mois, au centime. Temps réel (une liste),
 * en UN objet : aucune troncature possible.
 */
async function detailMois (db, compte, { mois, entiteId }) {
  const b = bornesMois(mois)
  if (!b || !entiteId) return { ok: false, invalide: true }
  const { data, error } = await db.rpc('charges_detail_mois', { p_user: compte, p_debut: b.debut, p_fin: b.fin, p_entite: entiteId })
  if (error || !Array.isArray(data)) return { ok: false }
  return { ok: true, mois: String(mois), debut: b.debut, fin: b.fin, lignes: data }
}

/**
 * Les crédits du compte, et leurs ÉCHÉANCES de la période (§14.20) : la
 * mensualité entière — capital compris — que l'écran montre mois par mois
 * comme un décaissement. ⚠ CE N'EST PAS UNE DONNÉE CALCULÉE : ce sont les
 * lignes du tableau d'amortissement telles qu'importées, lues par index
 * (`user_id`, `date_echeance`) ; l'écran ne fait que les ranger par mois.
 * ⚠ PAGE APRÈS PAGE : vingt crédits sur trois ans font 720 lignes, et
 * PostgREST tronque à 1000 sans le dire.
 */
async function credits (db, compte, { debut, fin, entiteId = null }) {
  let q = db.from('charges_credits')
    .select('id, entite_juridique_id, bien_id, preteur, nb_echeances, premiere_echeance, derniere_echeance, cree_le')
    .eq('user_id', compte)
  if (entiteId) q = q.eq('entite_juridique_id', entiteId)
  const { data: cs, error } = await q.order('cree_le', { ascending: true }).limit(100)
  if (error) return { ok: false }
  const liste = cs || []
  // Le jour, à Paris : l'écran sépare la mensualité PAYÉE de celle À VENIR
  // (review du lot, bloquant B1).
  const aujourdhui = jourParis()
  if (!liste.length) return { ok: true, credits: [], echeances: [], aujourdhui }
  const ids = liste.map(c => c.id)
  const echeances = []
  for (let de = 0; ; de += 1000) {
    const { data, error: eE } = await db.from('charges_credit_echeances')
      .select('credit_id, indice, date_echeance, interets_cents, assurance_cents, accessoires_cents, capital_cents, echeance_cents, capital_restant_cents')
      .eq('user_id', compte).in('credit_id', ids)
      .gte('date_echeance', debut).lte('date_echeance', fin)
      // Un ordre TOTAL (la clé de la table) : sans `indice`, deux échéances
      // d'un même crédit à la même date pouvaient glisser d'une page à
      // l'autre (review du lot, mineur 7).
      .order('date_echeance', { ascending: true }).order('credit_id', { ascending: true }).order('indice', { ascending: true })
      .range(de, de + 999)
    if (eE) return { ok: false }
    echeances.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return { ok: true, credits: liste, echeances, aujourdhui }
}

module.exports = {
  aTraiter, liste, biens, totaux, credits, exercicesBornes, detailMois, bornesPeriode, bornesMois,
  anneeDExercice, lireCurseur, ecrireCurseur,
  PAGE, PERIODES_D_AVANT, COLONNES, ORDRE_CATEGORIES, DEBUT_STANDARD, EXERCICES_MAX
}
