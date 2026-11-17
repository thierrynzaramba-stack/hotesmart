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

const PERIODES = ['exercice', 'exercice_precedent', '12_mois']

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

/**
 * Les périodes proposées pour une entité, et les bornes de celle demandée.
 * ⚠ Q22 : une entité AVEC début d'exercice se lit par exercice (en cours,
 * précédent) ; SANS, et « toutes les entités », par les 12 derniers mois
 * (Q33) — on ne suppose jamais une année civile à la place de l'hôte.
 * Une période inconnue ou indisponible retombe sur la première proposée.
 */
function bornesPeriode ({ periode, entite, aujourdhui = jourParis() }) {
  const mmjj = entite && entite.debut_exercice && /^\d{2}-\d{2}$/.test(entite.debut_exercice)
    ? entite.debut_exercice : null
  const proposees = mmjj ? ['exercice', 'exercice_precedent'] : ['12_mois']
  const choisie = proposees.includes(periode) ? periode : proposees[0]
  const [a, m] = aujourdhui.split('-').map(Number)
  if (choisie === '12_mois') {
    // Du premier jour du mois d'il y a 11 mois au dernier jour du mois en cours.
    return { periode: choisie, proposees, debut: enJour(dateUTC(a, m - 11, 1)), fin: enJour(dateUTC(a, m + 1, 0)) }
  }
  let debut = debutExercice(a, mmjj)
  if (enJour(debut) > aujourdhui) debut = debutExercice(a - 1, mmjj)
  if (choisie === 'exercice_precedent') debut = debutExercice(debut.getUTCFullYear() - 1, mmjj)
  const suivant = debutExercice(debut.getUTCFullYear() + 1, mmjj)
  const fin = new Date(suivant.getTime() - 24 * 3600 * 1000)
  return { periode: choisie, proposees, debut: enJour(debut), fin: enJour(fin) }
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
async function liste (db, compte, curseur = null) {
  let q = db.from('charges').select(COLONNES)
    .eq('user_id', compte).neq('statut', 'envoi')
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

module.exports = {
  aTraiter, liste, biens, totaux, bornesPeriode, lireCurseur, ecrireCurseur,
  PAGE, PERIODES, COLONNES, ORDRE_CATEGORIES
}
