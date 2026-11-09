// ═══════════════════════════════════════════════════════════════════════════
// lib/charges.js — LE WRITER UNIQUE DU COMPTE DE CHARGES (lot 2, le socle)
// Spec : docs/specs/spec-compte-de-charges.md §5, §6, §7
//
// ⚠ AUCUN AUTRE CODE N'ÉCRIT `charges`, `charges_ota_supprimees` NI LE BUCKET
// `justificatifs`. L'endpoint (`api/charges.js`) et le cron dédié
// (`api/cron-charges.js`) appellent ces fonctions ; ils ne font pas de
// requête eux-mêmes sur ces tables.
//
// ⚠ LA CLÉ DE SERVICE NE CONNAÎT PAS LA RLS. Le seul cloisonnement entre
// comptes est celui qu'on écrit ici : CHAQUE requête porte `user_id = compte`,
// et toute charge, entité ou bien désigné par l'appelant est RÉSOLU EN BASE
// dans ce compte avant d'être touché (REVIEW.md règle 11).
//
// ⚠ LES TOTAUX NE S'ÉCRIVENT PAS ICI. Le trigger `charges_resume_trg`
// (migration 2026-11-09-compte-de-charges.sql) recalcule la cellule d'avant et
// celle d'après dans la MÊME transaction que l'écriture de la charge : un
// writer qui « oublierait » le résumé ne peut pas exister.
//
// Chaque fonction rend `{ ok: true, ... }` ou `{ ok: false, statut, code }` :
// `statut` est le code HTTP que l'endpoint doit rendre.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('node:crypto')
const {
  BUCKET, TYPES, CLES_CATEGORIES, typeReel, centimesSaisis, dateValide,
  siretNormalise, texteCourt, proposerEntite, cleFournisseurNumero,
  jourParis, jourDeLaCharge
} = require('./charges/regles')

const MAX_TENTATIVES = 3
const DUREE_URL_CONSULTATION_S = 60
// ⚠ LA GARDE DE COÛT (spec §6, « plafond à fixer à l'étape 2 ») : au plus
// tant de lectures IA par compte sur 24 h glissantes, comptées dans
// `ia_appels` — la table où chaque appel est déjà journalisé, donc aucun
// second compteur à tenir. Mesure de l'ordre de grandeur : une facture de
// trois pages coûte moins d'un centime avec Haiku ; 50 lectures, moins de
// 0,40 $ par compte et par jour. Au-delà, la charge RESTE `a_lire` (rien
// n'est compté comme un échec) et le cron la relira quand le compte repasse
// sous le plafond.
const PLAFOND_LECTURES_JOUR = 50
// Le cron ne reprend une charge `a_lire` qu'après ce délai depuis sa dernière
// écriture : une charge confirmée à l'heure du passage quotidien est en train
// d'être lue par l'endpoint, et deux lectures du même fichier, c'est deux
// appels facturés.
const ATTENTE_AVANT_RELECTURE_MS = 2 * 60 * 1000
// ⚠ UN COMPTE NE GARDE PAS PLUS DE TANT D'ENVOIS OUVERTS SUR 24 H. Un envoi
// se confirme dans la seconde qui suit ; ceux qui ne le sont jamais ne
// s'effacent qu'au passage quotidien (Q28). Sans borne, une boucle de
// l'écran — ou un abus — créerait lignes et fichiers plus vite que la purge.
const MAX_ENVOIS_OUVERTS = 30
// Un téléchargement du bucket ne peut pas consommer le budget d'un passage.
const DELAI_TELECHARGEMENT_MS = 8000

/** La promesse, ou `{ delai: true }` passé `ms`. Ne lève jamais pour le délai. */
function avecDelai (promesse, ms) {
  let minuteur
  const delai = new Promise(resolve => { minuteur = setTimeout(() => resolve({ delai: true }), ms) })
  return Promise.race([promesse, delai]).finally(() => clearTimeout(minuteur))
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const refus = (statut, code) => ({ ok: false, statut, code })
const panne = (code = 'panne') => refus(503, code)

// Les colonnes rendues à l'écran : jamais le chemin du fichier, qui ne sert
// qu'au serveur (l'écran consulte par une URL signée de courte durée).
const RENDU = 'id, statut, motif, origine, entite_juridique_id, bien_id, fournisseur_nom, ' +
  'fournisseur_siret, numero_facture, date_facture, jour, date_repli, montant_ht_cents, ' +
  'montant_tva_cents, montant_ttc_cents, categorie, signal, signal_tranche, groupe_doublon, ' +
  'tentatives_lecture, lecture_ia, cree_le, valide_le, booking_id'

// ─── Les lectures de l'entité (fil facturation) ─────────────────────────────
// ⚠ ELLES VIENNENT DE `lib/entites-juridiques.js`, ÉCRIT PAR LE FIL
// FACTURATION, qui n'est pas encore dans `main` au moment de ce lot : le
// chargement se fait à la demande, et un module absent est une PANNE (503),
// jamais une liste vide — « aucune entité » serait un fait faux.
function lecturesEntites (deps) {
  if (deps && deps.entites) return deps.entites
  try {
    return require('./entites-juridiques')
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null
    throw e
  }
}

async function entitesDuCompte (db, compte, deps) {
  const mod = lecturesEntites(deps)
  if (!mod || typeof mod.entitesDuCompte !== 'function') return { ok: false, motif: 'module_absent' }
  const r = await mod.entitesDuCompte(compte, { db })
  return r && r.ok ? r : { ok: false, motif: 'panne' }
}

async function entiteDuBien (db, compte, bienId, deps) {
  const mod = lecturesEntites(deps)
  if (!mod || typeof mod.entiteDuBien !== 'function') return { ok: false, motif: 'module_absent' }
  const r = await mod.entiteDuBien(compte, bienId, { db })
  return r && r.ok ? r : { ok: false, motif: 'panne' }
}

// Le jour de RÉCEPTION, à Paris : le repli quand la date de la facture manque.
// Toujours recalculé depuis `cree_le` — jamais depuis `jour`, qui peut porter
// une date de facture effacée depuis.
const jourDeReception = (c) => jourParis(c && c.cree_le ? new Date(c.cree_le) : new Date())

// ─── Lecture d'une charge DANS le compte ────────────────────────────────────
async function chargeDuCompte (db, compte, id, colonnes = '*') {
  if (!UUID_RE.test(String(id || ''))) return { ok: false, statut: 400, code: 'charge_non_designee' }
  const { data, error } = await db.from('charges').select(colonnes)
    .eq('id', id).eq('user_id', compte).maybeSingle()
  if (error) return panne()
  if (!data) return refus(404, 'charge_introuvable')
  return { ok: true, charge: data }
}

// ─── 1. Ouvrir un envoi : la ligne et l'URL d'envoi signée ──────────────────
/**
 * ⚠ C'EST LE SERVEUR QUI CHOISIT LE CHEMIN, et il l'enregistre AVANT de
 * délivrer l'URL : le navigateur ne renvoie jamais un chemin, il renvoie
 * l'`id` de la charge, résolu en base dans son compte.
 */
async function ouvrirEnvoi (db, { compte, type, octets, origine = 'fichier' }) {
  if (!TYPES[type]) return refus(400, 'type_refuse')
  const taille = Number(octets)
  if (!Number.isInteger(taille) || taille <= 0) return refus(400, 'taille_invalide')
  if (taille > TYPES[type].max) return refus(413, 'trop_gros')
  if (!['photo', 'fichier'].includes(origine)) return refus(400, 'origine_invalide')

  const depuis = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { count, error: eCompte } = await db.from('charges').select('id', { count: 'exact', head: true })
    .eq('user_id', compte).eq('statut', 'envoi').gte('cree_le', depuis)
  if (eCompte || typeof count !== 'number') return panne()
  if (count >= MAX_ENVOIS_OUVERTS) return refus(429, 'trop_d_envois')

  const id = crypto.randomUUID()
  const chemin = `${compte}/${id}`
  const { error } = await db.from('charges').insert({
    id, user_id: compte, statut: 'envoi', origine,
    justificatif_chemin: chemin, justificatif_type: type, justificatif_octets: taille,
    jour: jourParis()
  })
  if (error) return panne()

  const { data, error: eUrl } = await db.storage.from(BUCKET).createSignedUploadUrl(chemin)
  if (eUrl || !data || !data.signedUrl) {
    // Pas d'URL, pas d'envoi possible : la ligne ne sert à rien.
    await db.from('charges').delete().eq('id', id).eq('user_id', compte).eq('statut', 'envoi')
    return panne('stockage')
  }
  return { ok: true, id, url: data.signedUrl, jeton: data.token }
}

// ─── 2. Confirmer un envoi : relire le fichier dans le bucket ───────────────
/**
 * ⚠ TROIS ISSUES, ET UNE PANNE DU STOCKAGE N'EST PAS UN FICHIER ABSENT :
 * `{ octets }`, `{ absent: true }` (l'objet n'existe pas — 404, ou le
 * `statusCode` « 404 » que l'API rend parfois sous un 400), `{ panne: true }`
 * (tout le reste, réseau compris). Confondre les deux ferait passer
 * `illisible` des factures intactes pendant un incident du stockage.
 */
function fichierAbsent (error) {
  const s = Number(error && error.status)
  const code = String((error && error.statusCode) || '')
  return s === 404 || code === '404' || /not.?found|nosuchkey/i.test(code)
}

async function telecharger (db, chemin) {
  if (!chemin) return { absent: true }
  let r
  try {
    r = await avecDelai(db.storage.from(BUCKET).download(chemin, undefined,
      { signal: AbortSignal.timeout(DELAI_TELECHARGEMENT_MS) }), DELAI_TELECHARGEMENT_MS + 500)
  } catch (e) {
    return { panne: true }
  }
  if (r && r.delai) return { panne: true }
  const { data, error } = r || {}
  if (error) return fichierAbsent(error) ? { absent: true } : { panne: true }
  if (!data) return { panne: true }
  return { octets: Buffer.from(await data.arrayBuffer()) }
}

async function effacerFichier (db, chemin) {
  if (!chemin) return
  try {
    const { error } = await db.storage.from(BUCKET).remove([chemin])
    if (error) console.error('[charges] fichier non efface', error.message)
  } catch (e) { console.error('[charges] fichier non efface', e && e.message) }
}

/**
 * Rapproche une charge d'une autre qui porte la même empreinte ou le même
 * couple fournisseur + numéro (Q14). Jamais un refus : un signal.
 *
 * ⚠ UN GROUPE N'A QU'UN NIVEAU. Il est désigné par sa RACINE (la charge dont
 * `groupe_doublon` est vide) ; tous les autres membres pointent sur elle. Le
 * résumé n'en compte que la racine tant que le signal n'est pas tranché.
 * D'où les deux pièges fermés ici :
 *   · les deux charges sont DÉJÀ dans le même groupe : rien à faire — sans
 *     cette garde, une racine rapprochée d'un de ses membres se désignait
 *     elle-même (`groupe_doublon = id`), et sortait du total ;
 *   · la charge est elle-même la racine d'un AUTRE groupe : c'est tout son
 *     groupe qui rejoint l'autre, sinon ses membres pointeraient sur une
 *     charge qui n'est plus une racine — un second niveau que rien ne lit.
 * Le groupe agrandi redemande une décision : `signal_tranche` repart à faux.
 */
async function regrouperDoublon (db, compte, charge, autre) {
  if (!autre || !charge || autre.id === charge.id) return
  const racineAutre = autre.groupe_doublon || autre.id
  const racineCharge = charge.groupe_doublon || charge.id
  if (racineAutre === racineCharge) return
  const marque = { groupe_doublon: racineAutre, signal: 'doublon', signal_tranche: false }
  const membres = await db.from('charges').update(marque)
    .eq('user_id', compte).eq('groupe_doublon', racineCharge)
  const racine = await db.from('charges').update(marque)
    .eq('user_id', compte).eq('id', racineCharge)
  // La racine qui accueille : elle prend le signal si elle n'en a pas, et
  // son groupe redevient « à trancher ». ⚠ Un AUTRE signal (commission déjà
  // comptée, lot 5) n'est pas écrasé : il dit autre chose.
  const accueil = await db.from('charges').update({ signal: 'doublon', signal_tranche: false })
    .eq('user_id', compte).eq('id', racineAutre).is('signal', null)
  const accueilBis = await db.from('charges').update({ signal_tranche: false })
    .eq('user_id', compte).eq('id', racineAutre).eq('signal', 'doublon')
  for (const r of [membres, racine, accueil, accueilBis]) {
    if (r && r.error) console.error('[charges] doublon non pose', r.error.message)
  }
}

async function confirmerEnvoi (db, { compte, id }) {
  const lu = await chargeDuCompte(db, compte, id)
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.statut !== 'envoi') return refus(409, 'deja_confirmee')

  const f = await telecharger(db, c.justificatif_chemin)
  if (f.panne) return panne('stockage')
  if (f.absent) return refus(409, 'fichier_absent')
  const octets = f.octets
  const type = typeReel(octets)
  // ⚠ LE TYPE SE LIT DANS LE CONTENU, PAS DANS CE QUE LE NAVIGATEUR ANNONCE.
  if (!type || !TYPES[type] || octets.length > TYPES[type].max) {
    await effacerFichier(db, c.justificatif_chemin)
    await db.from('charges').delete().eq('id', c.id).eq('user_id', compte).eq('statut', 'envoi')
    return !type ? refus(415, 'type_refuse') : refus(413, 'trop_gros')
  }
  const empreinte = crypto.createHash('sha256').update(octets).digest('hex')

  const { data: maj, error } = await db.from('charges').update({
    statut: 'a_lire', justificatif_type: type, justificatif_octets: octets.length,
    justificatif_empreinte: empreinte
  }).eq('id', c.id).eq('user_id', compte).eq('statut', 'envoi').select(RENDU).maybeSingle()
  if (error) return panne()
  if (!maj) return refus(409, 'deja_confirmee')

  const { data: memes } = await db.from('charges').select('id, groupe_doublon, signal')
    .eq('user_id', compte).eq('justificatif_empreinte', empreinte)
    .neq('id', c.id).neq('statut', 'envoi').order('cree_le', { ascending: true }).limit(1)
  if (memes && memes[0]) await regrouperDoublon(db, compte, maj, memes[0])

  return { ok: true, charge: maj, octets, type }
}

// ─── 3. Appliquer une lecture IA ────────────────────────────────────────────
/**
 * `resultat` : ce que rend `lireDocument`. Une PANNE ne compte pas ; un
 * ÉCHEC compte, et au troisième la charge passe `illisible` et n'est plus
 * relue — jamais une lecture facturée en boucle.
 */
async function appliquerLecture (db, { compte, id, resultat }, deps = {}) {
  if (!resultat || resultat.panne || resultat.plafond) {
    // Rien n'est compté. Le motif dit à l'écran pourquoi la lecture attend,
    // et l'écriture repousse la charge en fin de file du cron (`modifie_le`).
    if (!UUID_RE.test(String(id || ''))) return refus(400, 'charge_non_designee')
    const motif = resultat && resultat.plafond ? 'plafond_ia' : 'panne_ia'
    const { error } = await db.from('charges').update({ motif })
      .eq('id', id).eq('user_id', compte).eq('statut', 'a_lire')
    if (error) console.error('[charges] motif non pose', error.message)
    return { ok: true, issue: resultat && resultat.plafond ? 'plafond' : 'panne' }
  }
  const lu = await chargeDuCompte(db, compte, id, 'id, statut, tentatives_lecture, cree_le, groupe_doublon, signal')
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.statut !== 'a_lire') return refus(409, 'pas_a_lire')

  if (!resultat.ok) {
    const tentatives = (c.tentatives_lecture || 0) + 1
    const champs = tentatives >= MAX_TENTATIVES
      ? { tentatives_lecture: tentatives, statut: 'illisible', motif: 'lecture_impossible' }
      : { tentatives_lecture: tentatives }
    const { error } = await db.from('charges').update(champs)
      .eq('id', c.id).eq('user_id', compte).eq('statut', 'a_lire')
    if (error) return panne()
    return { ok: true, issue: champs.statut || 'a_relire', tentatives }
  }

  const l = resultat.lu
  // L'entité PROPOSÉE (Q6) : rapprochée par le code, jamais choisie par l'IA.
  // Une entité illisible (panne, module absent) laisse le champ vide : la
  // proposition est un confort, la validation la redemandera.
  const ent = await entitesDuCompte(db, compte, deps)
  const entite = ent.ok ? proposerEntite(ent.entites, l) : null
  const { jour, date_repli } = jourDeLaCharge(l.date_facture, jourDeReception(c))
  const champs = {
    statut: 'a_verifier', motif: null,
    fournisseur_nom: l.fournisseur_nom, fournisseur_siret: l.fournisseur_siret,
    numero_facture: l.numero_facture, date_facture: l.date_facture,
    montant_ht_cents: l.montant_ht_cents, montant_tva_cents: l.montant_tva_cents,
    montant_ttc_cents: l.montant_ttc_cents, categorie: l.categorie,
    entite_juridique_id: entite, jour, date_repli, cle_doublon: cleFournisseurNumero(l),
    // ⚠ JAMAIS ÉCRASÉ PAR LA SAISIE : l'écart lu / validé mesure la précision.
    lecture_ia: { ...l, modele: resultat.modele || null, lu_le: new Date().toISOString() }
  }
  const { data, error } = await db.from('charges').update(champs)
    .eq('id', c.id).eq('user_id', compte).eq('statut', 'a_lire').select(RENDU).maybeSingle()
  if (error) return panne()
  if (!data) return refus(409, 'pas_a_lire')
  await signalerDoublonFournisseur(db, compte, data)
  return { ok: true, issue: 'a_verifier', charge: data }
}

/**
 * ⚠ LE RAPPROCHEMENT SE FAIT SUR LA CLÉ NORMALISÉE (`cle_doublon`), jamais
 * sur le numéro brut : « FA-001 » et « FA 001 » du même fournisseur sont la
 * même facture, et une égalité exacte ne les voyait pas. La clé est écrite
 * par ce writer à chaque lecture et à chaque validation.
 * Une charge déjà dans un groupe (même empreinte) se rapproche quand même :
 * `regrouperDoublon` fusionne les deux groupes au lieu d'en chaîner deux.
 */
async function signalerDoublonFournisseur (db, compte, charge) {
  const cle = cleFournisseurNumero(charge)
  if (cle === null) return
  const { data, error } = await db.from('charges')
    .select('id, groupe_doublon')
    .eq('user_id', compte).eq('cle_doublon', cle)
    .neq('id', charge.id).not('statut', 'in', '(envoi,annulee,sans_facture)')
    .order('cree_le', { ascending: true }).limit(20)
  if (error) { console.error('[charges] doublon non cherche', error.message); return }
  const racineCharge = charge.groupe_doublon || charge.id
  const autre = (data || []).find(x => (x.groupe_doublon || x.id) !== racineCharge)
  if (autre) await regrouperDoublon(db, compte, charge, autre)
}

// ─── 4. Valider (ou corriger) une charge ────────────────────────────────────
/**
 * Les champs saisis par l'hôte. ⚠ L'ENTITÉ EST OBLIGATOIRE (D3, Q20) et doit
 * être une entité ACTIVE du compte ; le bien est facultatif (Q1) mais doit
 * relever de cette entité (Q18). Une commission de plateforme ne se modifie
 * pas à la main : elle se supprime (§7 bis).
 * Une charge pas encore lue (`a_lire`) se saisit à la main tout de suite
 * (Q29) : la saisie fait foi, et la lecture qui arriverait ensuite ne passe
 * plus (`appliquerLecture` n'écrit que sur une charge `a_lire`).
 */
const STATUTS_VALIDABLES = ['a_lire', 'a_verifier', 'validee', 'illisible']
async function valider (db, { compte, valideur, id, champs }, deps = {}) {
  const lu = await chargeDuCompte(db, compte, id, 'id, statut, origine, cree_le, groupe_doublon, entite_juridique_id, bien_id')
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.origine === 'ota') return refus(409, 'commission_automatique')
  if (!STATUTS_VALIDABLES.includes(c.statut)) return refus(409, 'statut_non_validable')

  const s = champs || {}
  const categorie = String(s.categorie || '')
  if (!CLES_CATEGORIES.has(categorie)) return refus(400, 'categorie_invalide')
  const montants = {}
  for (const k of ['montant_ht_cents', 'montant_tva_cents', 'montant_ttc_cents']) {
    const v = centimesSaisis(s[k])
    if (v === undefined) return refus(400, 'montant_invalide')
    montants[k] = v
  }
  const dateFacture = s.date_facture == null || s.date_facture === '' ? null : dateValide(s.date_facture)
  if (s.date_facture && !dateFacture) return refus(400, 'date_invalide')
  const siret = s.fournisseur_siret == null || s.fournisseur_siret === '' ? null : siretNormalise(s.fournisseur_siret)
  if (s.fournisseur_siret && !siret) return refus(400, 'siret_invalide')

  // ── L'entité : une entité de CE compte ────────────────────────────────────
  const entiteId = String(s.entite_juridique_id || '')
  if (!entiteId) return refus(409, 'entite_requise')
  const bienId = s.bien_id == null || s.bien_id === '' ? null : String(s.bien_id)
  if (bienId && !UUID_RE.test(bienId)) return refus(400, 'bien_invalide')
  const ent = await entitesDuCompte(db, compte, deps)
  if (!ent.ok) return panne(ent.motif === 'module_absent' ? 'entites_indisponibles' : 'panne')
  const entite = (ent.entites || []).find(e => String(e.id) === entiteId)
  if (!entite) return refus(403, 'entite_hors_compte')
  // ⚠ UNE CHARGE DÉJÀ VALIDÉE GARDE SON RATTACHEMENT (spec §6 : « les charges
  // déjà validées la gardent », et l'historique vit dans la charge). Quand
  // l'hôte la corrige SANS changer d'entité ni de bien, ni l'archivage de
  // l'entité ni le bien passé depuis à une autre entité ne la bloquent.
  // Toute autre validation — une charge neuve, ou un rattachement qui change
  // — exige une entité ACTIVE et un bien qui en relève aujourd'hui.
  const rattachementGarde = c.statut === 'validee' &&
    String(c.entite_juridique_id || '') === entiteId &&
    String(c.bien_id || '') === String(bienId || '')
  if (entite.archivee_le && !rattachementGarde) return refus(409, 'entite_archivee')

  // ── Le bien : du compte, ET de cette entité (Q18) ─────────────────────────
  if (bienId) {
    const { data: bien, error: eB } = await db.from('properties').select('id')
      .eq('id', bienId).eq('user_id', compte).maybeSingle()
    if (eB) return panne()
    if (!bien) return refus(403, 'bien_hors_compte')
  }
  if (bienId && !rattachementGarde) {
    const eb = await entiteDuBien(db, compte, bienId, deps)
    if (!eb.ok) return panne(eb.motif === 'module_absent' ? 'entites_indisponibles' : 'panne')
    // ⚠ DEPUIS D2 BIS, UN LOGEMENT SANS LIEN N'A PAS D'ENTITÉ — et ne relève
    // donc pas de celle choisie : « rattachez d'abord ce logement ».
    if (!eb.entite) return refus(409, 'bien_sans_entite')
    if (String(eb.entite.id) !== entiteId) return refus(409, 'bien_hors_entite')
  }

  const { jour, date_repli } = jourDeLaCharge(dateFacture, jourDeReception(c))
  const maj = {
    statut: 'validee', motif: null,
    fournisseur_nom: texteCourt(s.fournisseur_nom, 200), fournisseur_siret: siret,
    numero_facture: texteCourt(s.numero_facture, 100), date_facture: dateFacture,
    ...montants, categorie, entite_juridique_id: entiteId, bien_id: bienId,
    jour, date_repli, valide_le: new Date().toISOString(), valide_par: valideur
  }
  maj.cle_doublon = cleFournisseurNumero(maj)
  const { data, error } = await db.from('charges').update(maj)
    .eq('id', c.id).eq('user_id', compte).in('statut', STATUTS_VALIDABLES)
    .select(RENDU).maybeSingle()
  if (error) return panne()
  if (!data) return refus(409, 'statut_non_validable')
  await signalerDoublonFournisseur(db, compte, data)
  return { ok: true, charge: data }
}

// ─── 5. Trancher un signal « Vérifier » ─────────────────────────────────────
/**
 * L'hôte garde. Pour un groupe de doublons, c'est TOUT le groupe qui est
 * tranché (la première et les autres) : sinon la première compterait seule
 * et la seconde resterait « à trancher » pour toujours.
 */
async function trancher (db, { compte, id }) {
  const lu = await chargeDuCompte(db, compte, id, 'id, signal, groupe_doublon')
  if (!lu.ok) return lu
  const c = lu.charge
  if (!c.signal) return refus(409, 'aucun_signal')
  if (c.signal === 'doublon') {
    const racine = c.groupe_doublon || c.id
    const a = await db.from('charges').update({ signal_tranche: true })
      .eq('user_id', compte).eq('groupe_doublon', racine)
    const b = await db.from('charges').update({ signal_tranche: true })
      .eq('user_id', compte).eq('id', racine)
    if (a.error || b.error) return panne()
    return { ok: true, groupe: racine }
  }
  const { error } = await db.from('charges').update({ signal_tranche: true })
    .eq('user_id', compte).eq('id', c.id)
  if (error) return panne()
  return { ok: true }
}

// ─── 6. Supprimer (Q11 : à tout moment, justificatif compris) ───────────────
/**
 * ⚠ L'ORDRE COMPTE. Pour une commission de plateforme, la trace de
 * suppression est écrite AVANT la ligne effacée : dans l'ordre inverse, une
 * panne entre les deux laisserait la matérialisation quotidienne la recréer.
 * Le fichier part en dernier : un fichier orphelin se voit et se rattrape,
 * une ligne sans fichier ment.
 */
/**
 * ⚠ SUPPRIMER LA RACINE D'UN GROUPE DE DOUBLONS, C'EST D'ABORD LA REMPLACER.
 * Sans ça, la clé étrangère remet `groupe_doublon` à vide chez chaque membre :
 * chacun devient une racine seule, toujours signalée, et le résumé les compte
 * TOUS — la facture qu'on voulait compter une fois l'est deux fois. Le plus
 * ancien membre devient la racine, les autres le désignent ; s'il reste seul,
 * il n'est plus le doublon de rien et perd son signal.
 */
async function remplacerRacine (db, compte, racineId) {
  const { data: membres, error } = await db.from('charges').select('id')
    .eq('user_id', compte).eq('groupe_doublon', racineId)
    .order('cree_le', { ascending: true }).limit(1000)
  if (error) return false
  if (!membres || !membres.length) return true
  const nouvelle = membres[0].id
  const seule = membres.length === 1
  const a = await db.from('charges')
    .update(seule ? { groupe_doublon: null, signal: null, signal_tranche: false } : { groupe_doublon: null })
    .eq('user_id', compte).eq('id', nouvelle)
  if (a.error) return false
  if (!seule) {
    const b = await db.from('charges').update({ groupe_doublon: nouvelle })
      .eq('user_id', compte).eq('groupe_doublon', racineId)
    if (b.error) return false
  }
  return true
}

/** Le dernier membre parti, la racine n'est plus le doublon de rien. */
async function libererRacineSeule (db, compte, racineId) {
  const { data, error } = await db.from('charges').select('id')
    .eq('user_id', compte).eq('groupe_doublon', racineId).limit(1)
  if (error || (data && data.length)) return
  const r = await db.from('charges').update({ signal: null, signal_tranche: false })
    .eq('user_id', compte).eq('id', racineId).eq('signal', 'doublon')
  if (r.error) console.error('[charges] signal non retire', r.error.message)
}

async function supprimer (db, { compte, id }) {
  const lu = await chargeDuCompte(db, compte, id, 'id, origine, booking_id, justificatif_chemin, groupe_doublon')
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.origine === 'ota' && c.booking_id) {
    const { error } = await db.from('charges_ota_supprimees')
      .upsert({ user_id: compte, booking_id: String(c.booking_id) }, { onConflict: 'user_id,booking_id' })
    if (error) return panne()
  }
  // Une racine (pas de `groupe_doublon`) peut avoir des membres : on la
  // remplace AVANT de l'effacer. Une panne ici refuse la suppression plutôt
  // que de laisser un groupe compté deux fois.
  if (!c.groupe_doublon && !(await remplacerRacine(db, compte, c.id))) return panne()
  const { data, error } = await db.from('charges').delete()
    .eq('id', c.id).eq('user_id', compte).select('id')
  if (error) return panne()
  if (!data || !data.length) return refus(404, 'charge_introuvable')
  if (c.groupe_doublon) await libererRacineSeule(db, compte, c.groupe_doublon)
  await effacerFichier(db, c.justificatif_chemin)
  return { ok: true, supprime: c.id }
}

// ─── 7. Consulter le justificatif ───────────────────────────────────────────
/** La charge telle que l'écran la lit, dans le compte. */
async function lireCharge (db, { compte, id }) {
  return chargeDuCompte(db, compte, id, RENDU)
}

async function urlConsultation (db, { compte, id }) {
  const lu = await chargeDuCompte(db, compte, id, 'id, statut, justificatif_chemin')
  if (!lu.ok) return lu
  const c = lu.charge
  if (!c.justificatif_chemin || c.statut === 'envoi') return refus(404, 'sans_justificatif')
  const { data, error } = await db.storage.from(BUCKET)
    .createSignedUrl(c.justificatif_chemin, DUREE_URL_CONSULTATION_S)
  if (error || !data || !data.signedUrl) return panne('stockage')
  return { ok: true, url: data.signedUrl, expire_dans_s: DUREE_URL_CONSULTATION_S }
}

// ─── 8. Le cron dédié ───────────────────────────────────────────────────────
/**
 * Seule exception à « on garde tout » (Q12, acceptée par Thierry le
 * 9 novembre 2026) : un ENVOI jamais confirmé — un fichier qui n'est pas une
 * charge — est effacé avec sa ligne après 24 h. Borné, idempotent.
 */
async function purgerEnvois (db, { maintenant = Date.now(), limite = 100, echeance = Date.now() + 8000 } = {}) {
  const avant = new Date(maintenant - 24 * 3600 * 1000).toISOString()
  let purges = 0
  // ⚠ PAGE APRÈS PAGE JUSQU'À L'ÉCHÉANCE : le passage est quotidien (Q28),
  // une seule page de 100 laisserait s'accumuler ce qui dépasse.
  for (;;) {
    if (Date.now() > echeance) return { ok: true, purges, complet: false }
    const { data, error } = await db.from('charges').select('id, user_id, justificatif_chemin')
      .eq('statut', 'envoi').lt('cree_le', avant).order('cree_le', { ascending: true }).limit(limite)
    if (error) return { ok: false, purges }
    let effaces = 0
    for (const c of data || []) {
      if (Date.now() > echeance) return { ok: true, purges, complet: false }
      const { data: del, error: e } = await db.from('charges').delete()
        .eq('id', c.id).eq('user_id', c.user_id).eq('statut', 'envoi').select('id')
      if (e || !del || !del.length) continue
      await effacerFichier(db, c.justificatif_chemin)
      purges++
      effaces++
    }
    // Une page incomplète, ou une page dont rien n'a pu partir (une panne
    // d'écriture) : on s'arrête plutôt que de relire la même page en boucle.
    if (!data || data.length < limite || effaces === 0) return { ok: true, purges, complet: true }
  }
}

/**
 * La garde de coût : ce compte peut-il encore faire lire une facture ?
 * ⚠ UN COMPTE ILLISIBLE NE DIT PAS « OUI » : sans le compte des appels, on
 * ne dépense pas — la charge attend, elle n'est pas perdue.
 */
async function lectureAutorisee (db, compte, { maintenant = Date.now() } = {}) {
  const depuis = new Date(maintenant - 24 * 3600 * 1000).toISOString()
  const { count, error } = await db.from('ia_appels').select('id', { count: 'exact', head: true })
    .eq('fonction', 'charges-lecture').eq('user_id', compte).gte('created_at', depuis)
  if (error || typeof count !== 'number') return false
  return count < PLAFOND_LECTURES_JOUR
}

/**
 * Les lectures en attente (`a_lire`) : les envois e-mail (lot 5) et les
 * lectures interrompues par une panne ou par le plafond. Bornées par
 * `echeance`.
 *
 * ⚠ LA FILE TOURNE PAR `modifie_le`, PAS PAR `cree_le`. Chaque issue qui
 * laisse la charge `a_lire` (panne, plafond) la réécrit, donc la renvoie en
 * fin de file : une charge bloquée ne bloque plus celles qui la suivent. Et
 * une charge touchée il y a moins de deux minutes n'est pas prise — c'est
 * celle que l'endpoint est en train de lire.
 *
 * ⚠ TROIS PANNES, ET AUCUNE NE COMPTE COMME UN ÉCHEC : l'IA, le stockage, la
 * lecture du plafond. Une panne de l'IA ou du stockage ARRÊTE la passe — le
 * passage suivant (le cron est quotidien, Q28) réessaiera ; un compte au
 * plafond est seulement sauté.
 */
async function lireEnAttente (db, { lire, echeance, limite = 20, maintenant = Date.now() }, deps = {}) {
  const avant = new Date(maintenant - ATTENTE_AVANT_RELECTURE_MS).toISOString()
  const { data, error } = await db.from('charges')
    .select('id, user_id, justificatif_chemin')
    .eq('statut', 'a_lire').lt('modifie_le', avant)
    .order('modifie_le', { ascending: true }).limit(limite)
  if (error) return { ok: false, lues: 0 }
  const autorise = deps.lectureAutorisee || lectureAutorisee
  const plafonnes = new Set()
  let lues = 0
  let panneIa = false
  let panneStockage = false
  for (const c of data || []) {
    if (Date.now() > echeance) break
    if (plafonnes.has(c.user_id) || !(await autorise(db, c.user_id, { maintenant }))) {
      plafonnes.add(c.user_id)
      await appliquerLecture(db, { compte: c.user_id, id: c.id, resultat: { plafond: true } }, deps)
      continue
    }
    const f = await telecharger(db, c.justificatif_chemin)
    if (f.panne) { panneStockage = true; break }
    const type = f.octets ? typeReel(f.octets) : null
    const resultat = f.octets && type
      ? await lire({ octets: f.octets, type, compte: c.user_id })
      : { echec: true, motif: f.absent ? 'fichier_absent' : 'type_non_lisible' }
    if (resultat && resultat.panne) {
      await appliquerLecture(db, { compte: c.user_id, id: c.id, resultat }, deps)
      panneIa = true
      break
    }
    await appliquerLecture(db, { compte: c.user_id, id: c.id, resultat }, deps)
    lues++
  }
  return { ok: true, lues, panne: panneIa, panne_stockage: panneStockage, plafonnes: plafonnes.size }
}

module.exports = {
  ouvrirEnvoi, confirmerEnvoi, appliquerLecture, valider, trancher, supprimer,
  lireCharge, urlConsultation, purgerEnvois, lireEnAttente, lectureAutorisee,
  MAX_TENTATIVES, RENDU, PLAFOND_LECTURES_JOUR, ATTENTE_AVANT_RELECTURE_MS, MAX_ENVOIS_OUVERTS,
  avecDelai
}
