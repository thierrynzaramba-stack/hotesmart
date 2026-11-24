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
// ⚠ « SANS ENTITÉ JURIDIQUE » (lot 5 bis, §14.25) : les factures d'un logement
// qui n'a pas d'entité. C'est CE nom, et lui seul, qui devient `NULL` au moment
// d'appeler une lecture du résumé — `p_entite` NULL veut dire « sans entité »
// (migrations/2026-11-24-charges-sans-entite.sql). Une entité absente est
// refusée : un argument oublié ne devient pas une lecture « sans entité ».
const SANS_ENTITE = 'sans'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/
// Un instant tel que PostgREST le rend (`cree_le`) : chiffres, `T`, `:`, `.`,
// et un fuseau. Rien qui puisse fermer les guillemets du filtre.
const estEntiteLue = (e) => e === SANS_ENTITE || UUID_RE.test(String(e || ''))
const pEntite = (e) => (e === SANS_ENTITE ? null : e)
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/

// Les colonnes d'une ligne de l'écran. Pas `lecture_ia` entière : la réponse
// brute de l'IA n'a rien à faire dans une liste (elle peut peser plusieurs Ko
// par ligne). Lot 7a : le type, la période, et de l'IA le SEUL solde lu d'une
// régularisation, montré à côté de la consommation et jamais compté.
const COLONNES = 'id, statut, motif, origine, entite_juridique_id, bien_id, fournisseur_nom, ' +
  'fournisseur_siret, numero_facture, date_facture, jour, date_repli, montant_ht_cents, ' +
  'montant_tva_cents, montant_ttc_cents, categorie, signal, signal_tranche, groupe_doublon, ' +
  'tentatives_lecture, cree_le, valide_le, type_document, periode_debut, periode_fin, ' +
  'solde_lu:lecture_ia->solde_ttc_cents, ' +
  // Un tableau d'amortissement reconnu (§14.21.3) : son nombre d'échéances et ses bornes.
  'tableau_lu:lecture_ia->tableau, ' +
  // Lot 5 (§14.24) : une facture reçue par e-mail, et la ligne « sans facture
  // lisible » qui montre l'e-mail (Q19). Vides pour tout le reste.
  'email_expediteur, email_sujet, email_texte, email_recu_le'

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
// … et au plus tant d'exercices après lui (une facture qui couvre trois ans).
const EXERCICES_AVENIR = 5
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
  // Les mêmes bornes que la lecture (ci-dessous) : une date de facture lue en
  // 2099 n'ouvre pas soixante-dix options qu'on ne pourrait pas lire.
  plusAncien = Math.max(plusAncien, enCours - EXERCICES_MAX)
  plusRecent = Math.min(plusRecent, enCours + EXERCICES_AVENIR)
  let annee = enCours
  if (periode === 'exercice_precedent') annee = enCours - 1
  else if (typeof periode === 'string' && ANNEE_RE.test(periode)) {
    const n = Number(periode)
    // Un exercice hors de la liste se lit quand même s'il est raisonnable :
    // l'URL d'un exercice ancien reste valable. Hors de [enCours − 20 ;
    // enCours + 5], l'exercice en cours.
    if (n >= enCours - EXERCICES_MAX && n <= enCours + EXERCICES_AVENIR) annee = n
  }
  // ⚠ L'exercice LU est toujours proposé (review 1 du lot 8a, constat 6) :
  // sinon le menu montre un autre exercice que les totaux affichés — un
  // exercice choisi dont la dernière facture vient d'être supprimée.
  const proposees = []
  for (let a = Math.max(plusRecent, annee); a >= Math.min(plusAncien, annee); a--) proposees.push(String(a))
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

// ─── Le curseur de « À traiter » et du parcours : « cree_le|id » (lot 8c) ────
// Même discipline que celui de la liste : chaque partie validée par un motif
// ANCRÉ, l'instant entre guillemets dans le filtre.
function lireCurseurArrivee (brut) {
  if (brut == null || brut === '') return { ok: true, curseur: null }
  const parts = String(brut).split('|')
  if (parts.length !== 2) return { ok: false }
  const [cree, id] = parts
  if (!INSTANT_RE.test(cree) || !UUID_RE.test(id)) return { ok: false }
  return { ok: true, curseur: { cree_le: cree, id } }
}
const ecrireCurseurArrivee = (c) => `${c.cree_le}|${c.id}`
// Le filtre « avant » ou « après » un curseur d'arrivée (cree_le, puis id).
const auDelaDe = ({ cree_le: cree, id }, sens) =>
  `cree_le.${sens}."${cree}",and(cree_le.eq."${cree}",id.${sens}.${id})`

// ─── Les lectures ────────────────────────────────────────────────────────────
/**
 * « À traiter » (temps réel) : à vérifier, en lecture, illisible, et tout
 * doublon non tranché. Les 50 plus récentes, et leur nombre EXACT — compté en
 * base sur toutes les lignes, pas sur la page.
 * ⚠ LA SUITE PAR CURSEUR (lot 8c, dette 153) : au-delà des 50 premières, une
 * ligne était invisible partout. Un dépôt de 50 factures la dépasserait tout
 * de suite. On lit PAGE + 1 pour savoir s'il y a une suite.
 */
// `tableau` (§14.21.3) : un tableau d'amortissement reconnu attend son import.
// `sans_facture` (lot 5, §14.24) : un e-mail reçu sans pièce lisible, que
// l'hôte doit voir — il ajoute le PDF à la main, puis supprime la ligne.
const A_TRAITER = 'statut.in.(a_lire,a_verifier,illisible,tableau,sans_facture),and(signal.not.is.null,signal_tranche.is.false)'
async function aTraiter (db, compte, curseur = null) {
  // ⚠ UN SEUL `or` : la condition de la file ET celle du curseur s'imbriquent
  // dans un `and(...)`, plutôt que deux paramètres `or` dont la combinaison
  // dépendrait du serveur.
  const filtre = curseur ? `and(or(${A_TRAITER}),or(${auDelaDe(curseur, 'lt')}))` : A_TRAITER
  const { data, error, count } = await db.from('charges').select(COLONNES, curseur ? undefined : { count: 'exact' })
    .eq('user_id', compte)
    .or(filtre)
    .neq('statut', 'envoi')
    .order('cree_le', { ascending: false }).order('id', { ascending: false })
    .limit(PAGE + 1)
  if (error || (!curseur && typeof count !== 'number')) return { ok: false }
  const lignes = (data || []).slice(0, PAGE)
  const suite = (data || []).length > PAGE ? ecrireCurseurArrivee(lignes[lignes.length - 1]) : null
  return { ok: true, lignes, suite, ...(curseur ? {} : { nombre: count }) }
}

/**
 * Le PARCOURS (lot 8c, décisions 5 et 6) : les factures « À vérifier » du
 * compte, dans l'ORDRE DE DÉPÔT (`cree_le` puis `id`, croissants), par pages
 * de 50 et par curseur ; leur nombre exact à la première page.
 */
async function aVerifier (db, compte, curseur = null) {
  let q = db.from('charges').select(COLONNES, curseur ? undefined : { count: 'exact' })
    .eq('user_id', compte).eq('statut', 'a_verifier')
  if (curseur) q = q.or(auDelaDe(curseur, 'gt'))
  const { data, error, count } = await q
    .order('cree_le', { ascending: true }).order('id', { ascending: true })
    .limit(PAGE + 1)
  if (error || (!curseur && typeof count !== 'number')) return { ok: false }
  const lignes = (data || []).slice(0, PAGE)
  const suite = (data || []).length > PAGE ? ecrireCurseurArrivee(lignes[lignes.length - 1]) : null
  return { ok: true, lignes, suite, ...(curseur ? {} : { nombre: count }) }
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
  // choisie ; « À traiter » reste commun au compte. « Sans entité » : les
  // factures qui n'en ont pas (lot 5 bis).
  if (entiteId === SANS_ENTITE) q = q.is('entite_juridique_id', null)
  else if (entiteId) q = q.eq('entite_juridique_id', entiteId)
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
async function totaux (db, compte, { debut, fin, entiteId }) {
  if (!estEntiteLue(entiteId)) return { ok: false, invalide: true }
  const { data, error } = await db.rpc('charges_totaux', {
    p_user: compte, p_debut: debut, p_fin: fin, p_entite: pEntite(entiteId)
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
  if (!estEntiteLue(entiteId)) return { ok: false, invalide: true }
  const { data, error } = await db.rpc('charges_exercices_bornes', { p_user: compte, p_entite: pEntite(entiteId) })
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) return { ok: false }
  return { ok: true, bornes: { premier: data.premier || null, dernier: data.dernier || null } }
}

/**
 * La plage lue au clic sur un mois : le mois, COUPÉ aux bornes de l'exercice.
 * ⚠ Review 1 du lot 8a, constat 1 : un exercice qui ne commence pas un 1er
 * (une SCI au 15 mars, un 29 février une année ordinaire) a des mois de bord
 * PARTIELS. Lire le mois civil entier y montrait des factures de l'exercice
 * voisin et des parts dont la somme n'était plus le total « Étalé » du mois.
 * `null` : le mois ne touche pas l'exercice.
 */
function plageDuMois (mois, exercice) {
  const b = bornesMois(mois)
  if (!b || !exercice) return null
  const debut = b.debut > exercice.debut ? b.debut : exercice.debut
  const fin = b.fin < exercice.fin ? b.fin : exercice.fin
  if (debut > fin) return null
  return { debut, fin, partiel: debut !== b.debut || fin !== b.fin }
}

/**
 * Les factures d'une plage (un mois de l'exercice) et la PART de chacune
 * (§14.21.2), par `charges_detail_mois` : la règle du résumé à l'identique,
 * donc la somme des parts est le total « Étalé » de la plage, au centime.
 * Temps réel (une liste), en UN objet : aucune troncature possible.
 */
async function detailMois (db, compte, { debut, fin, entiteId }) {
  if (!JOUR_RE.test(String(debut || '')) || !JOUR_RE.test(String(fin || '')) || !estEntiteLue(entiteId)) return { ok: false, invalide: true }
  const { data, error } = await db.rpc('charges_detail_mois', { p_user: compte, p_debut: debut, p_fin: fin, p_entite: pEntite(entiteId) })
  if (error || !Array.isArray(data)) return { ok: false }
  return { ok: true, lignes: data }
}

// ─── L'export d'un exercice (lot 8d, §14.23) ─────────────────────────────────
// Les colonnes d'une ligne d'export. `justificatif_chemin` est LU pour savoir
// si la charge a un fichier, et ne SORT PAS : l'adresse d'un fichier ne se
// donne que signée, par `POST /api/charges { action: 'export_urls' }`. Les
// signaux sont lus pour dire si la charge COMPTE, et ne sortent pas non plus.
const COLONNES_EXPORT = 'id, jour, date_facture, fournisseur_nom, fournisseur_siret, numero_facture, ' +
  'type_document, categorie, bien_id, periode_debut, periode_fin, montant_ht_cents, ' +
  'montant_tva_cents, montant_ttc_cents, origine, justificatif_type, justificatif_chemin, ' +
  'signal, signal_tranche, groupe_doublon, cree_le'
// Au-delà, l'export est refusé et le DIT : une liste coupée en silence serait
// un export faux (règle 6 de la case performance).
const EXPORT_MAX = 5000
const PAGE_EXPORT = 1000

/**
 * ⚠ LA RÈGLE DU RÉSUMÉ, À L'IDENTIQUE (review du lot 8d, B1) : une charge
 * enregistrée n'entre PAS dans les totaux si c'est un échéancier (Q25), un
 * doublon non tranché ou une commission déjà comptée non tranchée —
 * `charges_detail_mois`, migrations/2026-11-19-charges-exercice-mois.sql.
 * Le PDF le dit sur la ligne, et son total ne la compte pas.
 */
const compteDansLesTotaux = (c) => c.type_document !== 'echeancier' &&
  !(c.signal === 'commission_deja_comptee' && !c.signal_tranche) &&
  !(c.groupe_doublon && !c.signal_tranche)

// La suite APRÈS une ligne (jour, cree_le, id croissants). ⚠ CHAQUE PARTIE EST
// VALIDÉE AVANT D'ENTRER DANS LE FILTRE, même lue en base (même discipline
// que `lireCurseur`).
const apresLigne = (c) => `jour.gt.${c.jour},and(jour.eq.${c.jour},cree_le.gt."${c.cree_le}"),and(jour.eq.${c.jour},cree_le.eq."${c.cree_le}",id.gt.${c.id})`

/**
 * Les factures ENREGISTRÉES (`validee`) de l'entité dont le jour est dans
 * l'exercice — la lecture « Date de facture » de l'écran —, par jour puis par
 * arrivée. ⚠ PAR CURSEUR, JAMAIS PAR DÉCALAGE (review du lot 8d, M7) : une
 * écriture entre deux pages (le cron qui crée une échéance de crédit) ne
 * double ni ne saute aucune ligne. PostgREST rend 1 000 lignes sans erreur.
 */
async function aExporter (db, compte, { debut, fin, entiteId }) {
  if (!JOUR_RE.test(String(debut || '')) || !JOUR_RE.test(String(fin || '')) || !estEntiteLue(entiteId)) return { ok: false, invalide: true }
  const lignes = []
  const vues = new Set()
  let dernier = null
  for (;;) {
    let q = db.from('charges').select(COLONNES_EXPORT).eq('user_id', compte)
    q = entiteId === SANS_ENTITE ? q.is('entite_juridique_id', null) : q.eq('entite_juridique_id', entiteId)
    q = q.eq('statut', 'validee').gte('jour', debut).lte('jour', fin)
    if (dernier) {
      if (!JOUR_RE.test(String(dernier.jour)) || !INSTANT_RE.test(String(dernier.cree_le)) || !UUID_RE.test(String(dernier.id))) return { ok: false }
      q = q.or(apresLigne(dernier))
    }
    const { data, error } = await q
      .order('jour', { ascending: true }).order('cree_le', { ascending: true }).order('id', { ascending: true })
      .limit(PAGE_EXPORT)
    if (error) return { ok: false }
    for (const c of data || []) {
      if (vues.has(String(c.id))) continue
      vues.add(String(c.id))
      const { justificatif_chemin: chemin, signal, signal_tranche: tranche, groupe_doublon: groupe, ...reste } = c
      lignes.push({
        ...reste,
        fichier: Boolean(chemin) && c.origine !== 'ota' && c.origine !== 'credit',
        compte: compteDansLesTotaux({ type_document: c.type_document, signal, signal_tranche: tranche, groupe_doublon: groupe })
      })
    }
    if (lignes.length > EXPORT_MAX) return { ok: false, trop: true }
    if (!data || data.length < PAGE_EXPORT) return { ok: true, lignes }
    dernier = data[data.length - 1]
  }
}

/**
 * Le compte a-t-il un total « Sans entité juridique » à montrer (lot 5 bis,
 * §14.25) ? Une cellule du résumé, sans entité, qui compte une facture. Non
 * urgent (le résumé), et UNE ligne au plus : `limit 1`.
 */
async function sansEntitePresente (db, compte) {
  const { data, error } = await db.from('charges_resume').select('jour')
    .eq('user_id', compte).is('entite_juridique_id', null)
    .or('nb_factures.gt.0,nb_etale.gt.0').limit(1)
  if (error || !Array.isArray(data)) return { ok: false }
  return { ok: true, oui: data.length > 0 }
}

/**
 * Le nombre de factures du compte encore « À traiter » et NON enregistrées :
 * ce sont elles qui ne sont pas dans l'export. ⚠ Une facture enregistrée qui
 * porte un doublon non tranché est dans « À traiter » ET dans l'export (review
 * du lot 8d, B1) : elle n'est pas comptée ici, le PDF la marque « non comptée ».
 */
async function nombreATraiter (db, compte) {
  const { error, count } = await db.from('charges').select('id', { count: 'exact', head: true })
    .eq('user_id', compte).or(A_TRAITER).neq('statut', 'envoi').neq('statut', 'validee')
  if (error || typeof count !== 'number') return { ok: false }
  return { ok: true, nombre: count }
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
  aTraiter, aVerifier, lireCurseurArrivee, liste, biens, totaux, credits, exercicesBornes, detailMois, plageDuMois, bornesPeriode, bornesMois,
  aExporter, nombreATraiter, compteDansLesTotaux, EXPORT_MAX, sansEntitePresente, SANS_ENTITE,
  anneeDExercice, lireCurseur, ecrireCurseur,
  PAGE, PERIODES_D_AVANT, EXERCICES_AVENIR, COLONNES, ORDRE_CATEGORIES, DEBUT_STANDARD, EXERCICES_MAX
}
