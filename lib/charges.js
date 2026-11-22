// ═══════════════════════════════════════════════════════════════════════════
// lib/charges.js — LE WRITER UNIQUE DU COMPTE DE CHARGES (lot 2, le socle)
// Spec : docs/specs/spec-compte-de-charges.md §5, §6, §7
//
// ⚠ AUCUN AUTRE CODE N'ÉCRIT `charges`, `charges_ota_supprimees`,
// `charges_credits`, `charges_credit_echeances` NI LE BUCKET
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
  jourParis, jourDeLaCharge, CLES_TYPES_DOCUMENT, periodeSaisie, montantsDuType, CATEGORIE_CREDIT
} = require('./charges/regles')
const { convertirIsole, ConversionImpossible, PanneConversion } = require('./charges/heic')
const { lireTableauIsole } = require('./charges/credit-tableau')

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
// ⚠ 100 DEPUIS LE LOT 8c (décision de Thierry, 22 novembre 2026) : le dépôt en
// masse — 50 fichiers d'un coup — en remplit la moitié ; moins de 0,80 $ par
// compte et par jour.
const PLAFOND_LECTURES_JOUR = 100
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
  'tentatives_lecture, lecture_ia, cree_le, valide_le, booking_id, type_document, ' +
  'periode_debut, periode_fin'

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

/**
 * Remplace le fichier stocké (même chemin) : `true` si le stockage l'a pris.
 * Une panne ou un délai rendent `false` — l'appelant n'écrit alors RIEN en
 * base, et le fichier d'origine reste en place.
 */
async function remplacerFichier (db, chemin, octets, type, delaiMs = DELAI_TELECHARGEMENT_MS) {
  let r
  try {
    r = await avecDelai(db.storage.from(BUCKET).upload(chemin, octets, { contentType: type, upsert: true }),
      delaiMs)
  } catch (e) {
    return false
  }
  return !!(r && !r.delai && !r.error)
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

async function confirmerEnvoi (db, { compte, id }, deps = {}) {
  const lu = await chargeDuCompte(db, compte, id)
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.statut !== 'envoi') return refus(409, 'deja_confirmee')

  const f = await telecharger(db, c.justificatif_chemin)
  if (f.panne) return panne('stockage')
  if (f.absent) return refus(409, 'fichier_absent')
  let octets = f.octets
  let type = typeReel(octets)
  // ⚠ LA LIGNE D'ABORD, LE FICHIER SEULEMENT SI ELLE ÉTAIT ENCORE `envoi`
  // (review du lot HEIC, constat 3) : deux confirmations du même envoi peuvent
  // se croiser, et celle qui échoue ne doit pas effacer le JPEG que l'autre
  // vient de poser sous une charge passée `a_lire`. Même règle que la purge.
  const abandonner = async () => {
    const { data } = await db.from('charges').delete()
      .eq('id', c.id).eq('user_id', compte).eq('statut', 'envoi').select('id')
    if (data && data.length) await effacerFichier(db, c.justificatif_chemin)
  }
  // ⚠ LE TYPE SE LIT DANS LE CONTENU, PAS DANS CE QUE LE NAVIGATEUR ANNONCE.
  if (!type || !TYPES[type] || octets.length > TYPES[type].max) {
    await abandonner()
    return !type ? refus(415, 'type_refuse') : refus(413, 'trop_gros')
  }
  // ⚠ UN HEIC SE CONVERTIT ICI, AVANT L'EMPREINTE ET LA LECTURE (§14.19) :
  // le JPEG REMPLACE la photo au même chemin, puis tout le reste — empreinte,
  // doublons, lecture IA, consultation — ne voit qu'un JPEG. Une photo qu'on
  // ne sait pas convertir s'efface comme un type refusé : rien ne reste
  // `a_lire` qu'aucune lecture ne saurait ouvrir.
  // ⚠ ET UNE PANNE N'EST PAS UNE PHOTO ILLISIBLE (review, constat 2) : un
  // convertisseur en délai, planté ou incomplet n'efface rien — 503, la
  // ligne reste `envoi`, l'hôte réessaie, la purge quotidienne la reprend.
  // De même pour une panne du stockage au remplacement.
  if (TYPES[type].convertir) {
    let jpeg
    try {
      jpeg = await (deps.convertir || convertirIsole)(octets, { max: TYPES[TYPES[type].convertir].max, cle: compte })
    } catch (e) {
      console.error('[charges] conversion', e && e.name, e && (e.motif || e.message), (e && e.detail) || '')
      // Le convertisseur est pris (file pleine, une autre photo du compte, ou
      // délai mangé par l'attente) : l'écran le dit, « réessayez dans un
      // instant » (troisième review, mineur 5) — rien n'est effacé.
      if (e instanceof PanneConversion && e.motif === 'occupe') return panne('conversion_occupee')
      if (!(e instanceof ConversionImpossible)) return panne('conversion')
      await abandonner()
      return refus(422, 'conversion_impossible')
    }
    if (!(await remplacerFichier(db, c.justificatif_chemin, jpeg, TYPES[type].convertir, deps.delaiStockageMs))) return panne('stockage')
    octets = jpeg
    type = TYPES[type].convertir
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

  // Lot 8b (§14.21.3) : le fichier est un tableau d'amortissement. Aucun
  // montant, aucune entité : il attend que l'hôte l'importe comme crédit.
  // UNE seule écriture pour les deux issues : gardée par le compte ET par le
  // statut `a_lire` (une autre écriture passée entre-temps ne s'écrase pas).
  const poser = async (champs) => {
    const { data, error } = await db.from('charges').update(champs)
      .eq('id', c.id).eq('user_id', compte).eq('statut', 'a_lire').select(RENDU).maybeSingle()
    if (error) return panne()
    if (!data) return refus(409, 'pas_a_lire')
    return { ok: true, charge: data }
  }
  if (resultat.tableau) {
    const p = await poser(champsDeTableau(resultat.tableau, c))
    return p.ok ? { ok: true, issue: 'tableau', charge: p.charge } : p
  }

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
  // ⚠ DANS LE DOUTE, RIEN (décision de Thierry, 22 novembre 2026, recette du
  // lot 8c) : l'entité est RECONNUE par le code — SIRET ou nom exact du
  // destinataire, une seule entité active qui correspond — sinon le champ
  // reste vide, et l'hôte la choisit pour enregistrer (`valider` l'exige).
  const ent = await entitesDuCompte(db, compte, deps)
  const entite = ent.ok ? proposerEntite(ent.entites, l) : null
  const { jour, date_repli } = jourDeLaCharge(l.date_facture, jourDeReception(c))
  const champs = {
    statut: 'a_verifier', motif: null,
    fournisseur_nom: l.fournisseur_nom, fournisseur_siret: l.fournisseur_siret,
    numero_facture: l.numero_facture, date_facture: l.date_facture,
    // Lot 7a : le type et la période lus ; l'avoir signé par le writer (Q26),
    // l'avis d'impôt sans TVA (HT = TTC, recette du 17 novembre 2026).
    ...montantsDuType(l.type_document, {
      montant_ht_cents: l.montant_ht_cents, montant_tva_cents: l.montant_tva_cents,
      montant_ttc_cents: l.montant_ttc_cents
    }),
    type_document: l.type_document || 'facture',
    periode_debut: l.periode_debut || null, periode_fin: l.periode_fin || null,
    categorie: l.categorie,
    entite_juridique_id: entite, jour, date_repli, cle_doublon: cleFournisseurNumero(l),
    // ⚠ JAMAIS ÉCRASÉ PAR LA SAISIE : l'écart lu / validé mesure la précision.
    lecture_ia: { ...l, modele: resultat.modele || null, lu_le: new Date().toISOString() }
  }
  const p = await poser(champs)
  if (!p.ok) return p
  await signalerDoublonFournisseur(db, compte, p.charge)
  return { ok: true, issue: 'a_verifier', charge: p.charge }
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
  const lu = await chargeDuCompte(db, compte, id, 'id, statut, origine, cree_le, groupe_doublon, entite_juridique_id, bien_id, type_document, periode_debut, periode_fin')
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.origine === 'ota') return refus(409, 'commission_automatique')
  // ⚠ Une échéance de crédit vient du tableau : elle ne se corrige pas une à
  // une, le crédit se supprime et se réimporte (§14.20).
  if (c.origine === 'credit') return refus(409, 'credit_automatique')
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
  // Lot 7a : le type (par défaut celui que la charge porte, sinon « facture »)
  // et la période, les deux bornes ou aucune, trois ans (1 096 jours) au plus.
  const type = s.type_document == null || s.type_document === '' ? (c.type_document || 'facture') : String(s.type_document)
  if (!CLES_TYPES_DOCUMENT.has(type)) return refus(400, 'type_invalide')
  // ⚠ UNE PÉRIODE NON ENVOYÉE SE GARDE, comme le type (review du lot 7a,
  // constat 6) : un écran d'avant le lot 7a ne doit pas effacer en silence la
  // période lue par l'IA. Envoyée vide, elle s'efface : c'est un geste.
  const periodeAbsente = s.periode_debut === undefined && s.periode_fin === undefined
  const periode = periodeAbsente
    ? { ok: true, debut: c.periode_debut || null, fin: c.periode_fin || null }
    : periodeSaisie(s.periode_debut, s.periode_fin)
  if (!periode.ok) return refus(400, periode.code)
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
    // ⚠ L'AVOIR EST NÉGATIF (Q26) : l'hôte tape le montant imprimé, le signe
    // est posé ICI. La base refuse un avoir positif comme une facture négative.
    // ⚠ L'AVIS D'IMPÔT N'A PAS DE TVA : HT = TTC et TVA = 0, posés ICI aussi,
    // quoi que l'écran envoie (`charges_impot_ck` le refuse sinon).
    ...montantsDuType(type, montants), type_document: type,
    periode_debut: periode.debut, periode_fin: periode.fin,
    categorie, entite_juridique_id: entiteId, bien_id: bienId,
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
  if (c.origine === 'credit') return refus(409, 'credit_automatique')
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
    .select('id, user_id, justificatif_chemin, pas_un_tableau:lecture_ia->pas_un_tableau')
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
      ? await lire({ octets: f.octets, type, compte: c.user_id, pasUnTableau: c.pas_un_tableau === true })
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

// ─── 8. Les crédits (§14.20) ────────────────────────────────────────────────
// ⚠ LE TABLEAU D'AMORTISSEMENT FAIT FOI, ÉCHÉANCE PAR ÉCHÉANCE (décision de
// Thierry, 19 novembre 2026) : chaque mensualité ÉCHUE devient une charge
// (intérêts + assurance + accessoires — jamais le capital, qui n'est pas une
// charge), validée, catégorie `credit`, rattachée à l'entité (et au logement,
// s'il est désigné) du crédit. Les mensualités à venir restent dans
// `charges_credit_echeances` ; le cron quotidien les fait entrer quand leur
// jour arrive. Une échéance ne se corrige pas seule : le crédit se supprime,
// et son tableau se réimporte.
const CREDIT_PDF_MAX = 2 * 1024 * 1024
const MAX_CREDITS = 20
const LOT_ECRITURE = 500

/** La charge d'une échéance de crédit, telle que la base la reçoit. */
function chargeDEcheance (credit, e, valideLe) {
  const montant = Number(e.interets_cents) + Number(e.assurance_cents) + Number(e.accessoires_cents)
  return {
    user_id: credit.user_id,
    entite_juridique_id: credit.entite_juridique_id,
    bien_id: credit.bien_id || null,
    statut: 'validee',
    origine: 'credit',
    credit_id: credit.id,
    credit_indice: e.indice,
    fournisseur_nom: credit.preteur,
    date_facture: e.date_echeance,
    jour: e.date_echeance,
    date_repli: false,
    montant_ht_cents: montant,
    montant_tva_cents: 0,
    montant_ttc_cents: montant,
    categorie: CATEGORIE_CREDIT,
    type_document: 'facture',
    valide_le: valideLe,
    valide_par: credit.user_id
  }
}

/**
 * Fait entrer en charges les échéances ÉCHUES d'un crédit. Rejouable : une
 * échéance déjà entrée ne l'est pas deux fois (`charges_credit_uidx`).
 * Rend le nombre d'échéances traitées, ou `null` sur une panne.
 */
async function materialiserEcheances (db, credit, echeances) {
  let n = 0
  const maintenant = new Date().toISOString()
  for (let i = 0; i < echeances.length; i += LOT_ECRITURE) {
    const lot = echeances.slice(i, i + LOT_ECRITURE)
    const { error } = await db.from('charges').upsert(lot.map(e => chargeDEcheance(credit, e, maintenant)),
      { onConflict: 'credit_id,credit_indice', ignoreDuplicates: true })
    if (error) { console.error('[charges] echeances non ecrites', error.message); return null }
    const { error: eM } = await db.from('charges_credit_echeances').update({ materialisee_le: maintenant })
      .eq('credit_id', credit.id).eq('user_id', credit.user_id).in('indice', lot.map(e => e.indice))
    if (eM) { console.error('[charges] echeances non marquees', eM.message); return null }
    n += lot.length
  }
  return n
}

/**
 * Importe un crédit depuis son tableau d'amortissement (PDF).
 * `{ ok, credit, charges }` ou un refus ; `detail` dit la ligne fautive.
 */
async function importerCredit (db, { compte, octets, entiteId, bienId, preteur, aujourdhui = jourParis() }, deps = {}) {
  const nom = texteCourt(preteur, 120)
  if (!nom) return refus(400, 'preteur_requis')
  const entite = String(entiteId || '')
  if (!UUID_RE.test(entite)) return refus(409, 'entite_requise')
  const bien = bienId == null || bienId === '' ? null : String(bienId)
  if (bien && !UUID_RE.test(bien)) return refus(400, 'bien_invalide')
  if (!Buffer.isBuffer(octets) || !octets.length) return refus(400, 'fichier_requis')
  if (octets.length > CREDIT_PDF_MAX) return refus(413, 'trop_gros')
  if (typeReel(octets) !== 'application/pdf') return refus(415, 'type_refuse')

  // ── L'entité ACTIVE de ce compte, et le logement qui en relève ────────────
  const ent = await entitesDuCompte(db, compte, deps)
  if (!ent.ok) return panne(ent.motif === 'module_absent' ? 'entites_indisponibles' : 'panne')
  const e = (ent.entites || []).find(x => String(x.id) === entite)
  if (!e) return refus(403, 'entite_hors_compte')
  if (e.archivee_le) return refus(409, 'entite_archivee')
  if (bien) {
    const { data: b, error: eB } = await db.from('properties').select('id')
      .eq('id', bien).eq('user_id', compte).maybeSingle()
    if (eB) return panne()
    if (!b) return refus(403, 'bien_hors_compte')
    const eb = await entiteDuBien(db, compte, bien, deps)
    if (!eb.ok) return panne(eb.motif === 'module_absent' ? 'entites_indisponibles' : 'panne')
    if (!eb.entite) return refus(409, 'bien_sans_entite')
    if (String(eb.entite.id) !== entite) return refus(409, 'bien_hors_entite')
  }

  // ── Une borne, et pas deux fois le même tableau ───────────────────────────
  const { count, error: eC } = await db.from('charges_credits').select('id', { count: 'exact', head: true })
    .eq('user_id', compte)
  if (eC || typeof count !== 'number') return panne()
  if (count >= MAX_CREDITS) return refus(429, 'trop_de_credits')
  const empreinte = crypto.createHash('sha256').update(octets).digest('hex')
  const { data: deja, error: eD } = await db.from('charges_credits').select('id')
    .eq('user_id', compte).eq('justificatif_empreinte', empreinte).limit(1)
  if (eD) return panne()
  if (deja && deja.length) return refus(409, 'credit_deja_importe')

  // ── La lecture, prouvée ligne par ligne, dans un fil à usage unique ───────
  // (review du lot, constat S1 : un PDF piégé ne gèle plus la fonction).
  // `cle: compte` : un compte, une place dans la file commune (troisième
  // review HEIC, constat de sécurité 1).
  const lu = await (deps.lireTableau || lireTableauIsole)(octets, { cle: compte })
  if (lu && lu.panne) return panne(lu.panne === 'occupe' ? 'occupe' : 'lecture')
  if (!lu || !lu.ok) return { ...refus(422, (lu && lu.code) || 'tableau_illisible'), detail: (lu && lu.detail) || null }
  const lignes = lu.echeances
  if (!lignes.length || lignes.length > 1000) return { ...refus(422, 'tableau_illisible'), detail: null }

  // ── Le fichier, le crédit, ses échéances, puis les échéances échues ───────
  const id = crypto.randomUUID()
  const chemin = `${compte}/credit-${id}`
  if (!(await remplacerFichier(db, chemin, octets, 'application/pdf'))) return panne('stockage')
  const credit = {
    id, user_id: compte, entite_juridique_id: entite, bien_id: bien, preteur: nom,
    justificatif_chemin: chemin, justificatif_empreinte: empreinte, nb_echeances: lignes.length,
    premiere_echeance: lignes[0].date, derniere_echeance: lignes[lignes.length - 1].date
  }
  // ⚠ TOUT OU RIEN : une écriture qui échoue en route efface le crédit — ses
  // échéances et ses charges partent avec lui (`on delete cascade`). Ce n'est
  // pas une transaction : une fonction tuée entre deux écritures laisserait
  // un crédit partiel, que l'hôte voit (« N échéances ») et supprime (dette
  // notée au §14.20). Un effacement qui échoue se JOURNALISE, et le fichier
  // reste alors avec sa ligne, pour qu'elle ne pointe pas dans le vide.
  const defaire = async () => {
    const { error } = await db.from('charges_credits').delete().eq('id', id).eq('user_id', compte)
    if (error) console.error('[charges] credit non defait', id, error.message)
    else await effacerFichier(db, chemin)
    return panne()
  }
  const { error: eI } = await db.from('charges_credits').insert(credit)
  if (eI) {
    if (eI.code === '23505') { await effacerFichier(db, chemin); return refus(409, 'credit_deja_importe') }
    // Une erreur ambiguë (délai après écriture) : la ligne existe peut-être.
    return defaire()
  }
  const echeances = lignes.map(l => ({
    credit_id: id, user_id: compte, indice: l.indice, rang: l.rang, date_echeance: l.date,
    interets_cents: l.interets_cents, assurance_cents: l.assurance_cents, accessoires_cents: l.accessoires_cents,
    capital_cents: l.capital_cents, echeance_cents: l.echeance_cents, capital_restant_cents: l.capital_restant_cents
  }))
  for (let i = 0; i < echeances.length; i += LOT_ECRITURE) {
    const { error } = await db.from('charges_credit_echeances').insert(echeances.slice(i, i + LOT_ECRITURE))
    if (error) return defaire()
  }
  const echues = echeances.filter(x => x.date_echeance <= aujourdhui)
  const n = await materialiserEcheances(db, credit, echues)
  if (n === null) return defaire()
  const { justificatif_chemin: _c, justificatif_empreinte: _e, ...rendu } = credit
  return { ok: true, credit: rendu, charges: n }
}

// ─── 8 bis. Un seul bouton « Ajouter » : le tableau reconnu (§14.21.3) ──────
// L'hôte dépose TOUT par le même bouton. Un PDF dont le lecteur de tableaux
// PROUVE au moins trois échéances est un tableau d'amortissement : la charge
// passe `tableau`, SANS appel à l'IA, et attend d'être importée comme crédit.
// ⚠ La charge `tableau` ne porte AUCUN montant : elle n'entre dans aucun
// total. C'est l'import qui crée le crédit, puis la retire.
const ECHEANCES_MIN_TABLEAU = 3
// Plus court que l'import (qui attend sa place dans la file) : une facture ne
// doit pas attendre longtemps de savoir qu'elle n'est pas un tableau.
const DELAI_RECONNAISSANCE_MS = 6000
const STATUTS_RETYPABLES = ['a_lire', 'a_verifier', 'illisible']

/**
 * Ce fichier est-il un tableau d'amortissement lisible ?
 * `{ ok: true, tableau: { echeances, debut, fin } }`, `{ ok: false }`, ou
 * `{ panne }` quand la lecture n'a pas pu se faire (file prise) — ce n'est
 * alors PAS un « non » : l'appelant choisit.
 */
async function lireCommeTableau (octets, type, compte, deps = {}) {
  if (type !== 'application/pdf' || !Buffer.isBuffer(octets) || !octets.length || octets.length > CREDIT_PDF_MAX) return { ok: false }
  const lu = await (deps.lireTableau || lireTableauIsole)(octets, { cle: compte, delaiMs: DELAI_RECONNAISSANCE_MS })
  if (lu && lu.panne) return { panne: lu.panne }
  const e = lu && lu.ok && Array.isArray(lu.echeances) ? lu.echeances : []
  if (e.length < ECHEANCES_MIN_TABLEAU || e.length > 1000) return { ok: false }
  return { ok: true, tableau: { echeances: e.length, debut: e[0].date, fin: e[e.length - 1].date } }
}

/**
 * Le lecteur du cron et de la confirmation : le tableau D'ABORD, l'IA sinon.
 * Une file prise laisse passer l'IA — une facture n'attend pas un tableau.
 */
function avecReconnaissance (lire, deps = {}) {
  return async ({ octets, type, compte, pasUnTableau }) => {
    // L'hôte a dit « ce n'est pas un tableau » : on ne le lui redemande pas.
    if (pasUnTableau) return lire({ octets, type, compte })
    const t = await lireCommeTableau(octets, type, compte, deps)
    if (t.ok) return { tableau: t.tableau }
    return lire({ octets, type, compte })
  }
}

/** Ce qu'une charge devient quand son fichier est un tableau : rien de lu. */
function champsDeTableau (tableau, charge) {
  return {
    statut: 'tableau', motif: null, type_document: 'tableau_amortissement',
    fournisseur_nom: null, fournisseur_siret: null, numero_facture: null, date_facture: null,
    montant_ht_cents: null, montant_tva_cents: null, montant_ttc_cents: null,
    periode_debut: null, periode_fin: null, categorie: null, cle_doublon: null,
    // ⚠ NI ENTITÉ NI LOGEMENT (review du lot 8c, M1) : une facture lue porte
    // l'entité reconnue, et l'hôte peut ensuite la dire « tableau ». Un tableau
    // choisit la sienne à l'import ; sinon il s'afficherait dans les factures
    // de l'entité.
    entite_juridique_id: null, bien_id: null,
    jour: jourDeReception(charge), date_repli: true,
    lecture_ia: { tableau, lu_le: new Date().toISOString() }
  }
}

const COLONNES_TABLEAU = 'id, user_id, statut, origine, cree_le, justificatif_chemin, justificatif_type'
const chargePourTableau = (db, compte, id) => chargeDuCompte(db, compte, id, COLONNES_TABLEAU)
/**
 * La charge telle que l'écran l'attend, relue APRÈS une écriture réussie.
 * Les écritures de cette section ne demandent que `id` (une liste littérale,
 * que tests/garde-colonne-selectionnee sait lire) ; une relecture en panne ne
 * défait rien : l'écran reçoit l'identifiant et le statut, et recharge.
 */
async function relue (db, compte, id, statut) {
  const l = await lireCharge(db, { compte, id })
  return l.ok ? l.charge : { id, statut }
}

/**
 * L'hôte choisit « Tableau d'amortissement » sur une charge pas encore
 * vérifiée : son PDF est relu comme tableau. 422 `pas_un_tableau` si le
 * lecteur ne le prouve pas — et rien n'est écrit.
 */
async function passerEnTableau (db, { compte, id }, deps = {}) {
  const lu = await chargePourTableau(db, compte, id)
  if (!lu.ok) return lu
  const c = lu.charge
  if (!STATUTS_RETYPABLES.includes(c.statut)) return refus(409, 'statut_non_retypable')
  if (c.origine === 'ota' || c.origine === 'credit') return refus(409, 'statut_non_retypable')
  if (c.justificatif_type !== 'application/pdf') return refus(422, 'pas_un_tableau')
  const f = await telecharger(db, c.justificatif_chemin)
  if (f.panne) return panne('stockage')
  if (f.absent) return refus(409, 'fichier_absent')
  const t = await lireCommeTableau(f.octets, typeReel(f.octets), compte, deps)
  if (t.panne) return panne('occupe')
  if (!t.ok) return refus(422, 'pas_un_tableau')
  const { data, error } = await db.from('charges').update({ ...champsDeTableau(t.tableau, c), entite_juridique_id: null, bien_id: null })
    .eq('id', c.id).eq('user_id', compte).eq('statut', c.statut).select('id').maybeSingle()
  if (error) return panne()
  if (!data) return refus(409, 'statut_non_retypable')
  return { ok: true, charge: await relue(db, compte, c.id, 'tableau') }
}

/**
 * « Ce n'est pas un tableau » : la charge repart `a_lire`, compteur d'échecs
 * à zéro, et rend son fichier pour que l'appelant le fasse lire par l'IA.
 * ⚠ LE CHOIX DE L'HÔTE SE MÉMORISE (`lecture_ia.pas_un_tableau`) : si l'IA ne
 * conclut pas tout de suite (plafond, panne, échec), c'est le cron qui relit,
 * et sans cette marque il reconnaîtrait le tableau de nouveau (review du lot
 * 8b, B1). Une lecture réussie l'écrase ; « Tableau d'amortissement » choisi à
 * la main aussi.
 */
async function tableauEnFacture (db, { compte, id }) {
  const lu = await chargePourTableau(db, compte, id)
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.statut !== 'tableau') return refus(409, 'pas_un_tableau')
  const f = await telecharger(db, c.justificatif_chemin)
  if (f.panne) return panne('stockage')
  if (f.absent) return refus(409, 'fichier_absent')
  const { data, error } = await db.from('charges')
    .update({ statut: 'a_lire', motif: null, type_document: 'facture', lecture_ia: { pas_un_tableau: true }, tentatives_lecture: 0 })
    .eq('id', c.id).eq('user_id', compte).eq('statut', 'tableau').select('id').maybeSingle()
  if (error) return panne()
  if (!data) return refus(409, 'pas_un_tableau')
  return { ok: true, charge: await relue(db, compte, c.id, 'a_lire'), octets: f.octets, type: typeReel(f.octets) }
}

/**
 * Importe comme crédit le tableau DÉJÀ déposé, puis retire la charge.
 * ⚠ L'ORDRE EST LA RÈGLE : le crédit d'abord. Un import refusé ou en panne ne
 * retire RIEN — ni la charge, ni son fichier. Une charge qui ne s'efface pas
 * après un import réussi laisse le crédit en place, et le dit
 * (`charge_retiree: false`) : elle ne porte aucun montant.
 */
async function importerTableau (db, { compte, id, preteur, entiteId, bienId, aujourdhui = jourParis() }, deps = {}) {
  const lu = await chargePourTableau(db, compte, id)
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.statut !== 'tableau') return refus(409, 'pas_un_tableau')
  const f = await telecharger(db, c.justificatif_chemin)
  if (f.panne) return panne('stockage')
  if (f.absent) return refus(409, 'fichier_absent')
  const r = await importerCredit(db, { compte, octets: f.octets, entiteId, bienId, preteur, aujourdhui }, deps)
  if (!r.ok) return r
  const s = await supprimer(db, { compte, id: c.id })
  if (!s.ok) console.error('[charges] tableau importe, charge non retiree', c.id, s.code)
  return { ok: true, credit: r.credit, charges: r.charges, charge_retiree: !!s.ok }
}

/** Supprime un crédit du compte : ses échéances et ses charges avec lui. */
async function supprimerCredit (db, { compte, id }) {
  if (!UUID_RE.test(String(id || ''))) return refus(400, 'credit_non_designe')
  const { data: c, error } = await db.from('charges_credits').select('id, justificatif_chemin')
    .eq('id', id).eq('user_id', compte).maybeSingle()
  if (error) return panne()
  if (!c) return refus(404, 'credit_introuvable')
  const { data, error: eS } = await db.from('charges_credits').delete()
    .eq('id', c.id).eq('user_id', compte).select('id')
  if (eS) return panne()
  if (!data || !data.length) return refus(404, 'credit_introuvable')
  await effacerFichier(db, c.justificatif_chemin)
  return { ok: true, supprime: c.id }
}

/**
 * LE PASSAGE QUOTIDIEN : les échéances arrivées à leur jour entrent en
 * charges, tous comptes confondus, par lots bornés. Chaque charge est écrite
 * avec le compte de SON crédit (lu par sa clé), jamais d'ailleurs.
 */
async function materialiserCredits (db, { aujourdhui = jourParis(), limite = 500, echeance = Date.now() + 8000 } = {}) {
  const { data, error } = await db.from('charges_credit_echeances')
    .select('credit_id, user_id, indice, date_echeance, interets_cents, assurance_cents, accessoires_cents')
    .is('materialisee_le', null).lte('date_echeance', aujourdhui)
    .order('date_echeance', { ascending: true }).limit(limite)
  if (error) return { ok: false, materialisees: 0 }
  const parCredit = new Map()
  for (const e of data || []) {
    if (!parCredit.has(e.credit_id)) parCredit.set(e.credit_id, [])
    parCredit.get(e.credit_id).push(e)
  }
  // ⚠ UN CRÉDIT EN PANNE N'ARRÊTE PAS LES AUTRES (review du lot, mineur 2) :
  // sinon le même, remis en tête par le tri chaque nuit, bloquerait tous les
  // comptes. Il est compté, et le passage le remonte.
  let n = 0
  let erreurs = 0
  for (const [creditId, echeances] of parCredit) {
    if (Date.now() > echeance) break
    const { data: credit, error: eC } = await db.from('charges_credits')
      .select('id, user_id, entite_juridique_id, bien_id, preteur')
      .eq('id', creditId).eq('user_id', echeances[0].user_id).maybeSingle()
    if (eC) { erreurs++; continue }
    if (!credit) continue
    const r = await materialiserEcheances(db, credit, echeances)
    if (r === null) { erreurs++; continue }
    n += r
  }
  return { ok: erreurs === 0, materialisees: n, erreurs }
}

module.exports = {
  ouvrirEnvoi, confirmerEnvoi, appliquerLecture, valider, trancher, supprimer,
  importerCredit, supprimerCredit, materialiserCredits, chargeDEcheance, MAX_CREDITS, CREDIT_PDF_MAX,
  lireCommeTableau, avecReconnaissance, passerEnTableau, tableauEnFacture, importerTableau,
  ECHEANCES_MIN_TABLEAU, DELAI_RECONNAISSANCE_MS,
  lireCharge, urlConsultation, purgerEnvois, lireEnAttente, lectureAutorisee,
  MAX_TENTATIVES, RENDU, PLAFOND_LECTURES_JOUR, ATTENTE_AVANT_RELECTURE_MS, MAX_ENVOIS_OUVERTS,
  avecDelai
}
