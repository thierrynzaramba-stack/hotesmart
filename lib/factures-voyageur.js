// lib/factures-voyageur.js — WRITER UNIQUE des demandes de facture du voyageur
// et de leurs liens (étape 2).
// Spec : docs/specs/spec-facture-voyageur.md §2, §4 bis (P1-P5), §5.3, §11.1
// Base : migrations/2026-11-10-factures-voyageur-demandes.sql
//
// ⚠ CE MODULE NE GARDE RIEN. Il n'a ni session ni droits : c'est l'endpoint
// appelant qui garde (api/factures-voyageur.js pour l'hôte, avec
// `reservations` et `messages` en écriture ; api/facture-publique.js pour le
// voyageur, par son jeton). Il reçoit un `userId` DÉJÀ VÉRIFIÉ — le compte
// cible — et n'écrit jamais que sur ce compte.
//
// ⚠ UNE SEULE DEMANDE ACTIVE PAR RÉSERVATION, et ce n'est pas ce module qui la
// garantit : c'est l'index unique partiel de la base, que traversent les deux
// fonctions SQL `fv_ouvrir_demande` et `fv_nouveau_lien`. Ici, on ne crée
// JAMAIS une demande par un `insert` direct.
//
// ⚠ LE JETON EN CLAIR N'EXISTE QU'À L'INSTANT DE L'ENVOI. La base n'en garde
// que le sha256 : un lien perdu ne se relit pas, il se renvoie (chaque envoi
// crée un jeton neuf, les précédents restent valables jusqu'à leur expiration).
// 32 octets aléatoires = 256 bits, au-delà des 128 exigés (§5.3).
//
// ⚠ LE JETON VOYAGE DANS LE FRAGMENT de l'URL (`/facture#<jeton>`), jamais dans
// le chemin ni la requête : un fragment n'est envoyé à aucun serveur, il
// n'entre donc ni dans les journaux de Vercel ni dans un en-tête Referer. La
// page le lit et le poste dans le CORPS de sa requête.
//
// ⚠ UNE PANNE N'EST PAS UNE ABSENCE : toute erreur Supabase rend
// `{ ok: false, motif: 'panne' }`, jamais un « introuvable ».

const crypto = require('crypto')

function client () {
  return require('./cron-shared').supabase
}

const LANGUES = ['fr', 'en', 'es']
const PORTES = ['fiche', 'balise', 'guestflow', 'disponible']
// Formulaires reçus par jeton : de quoi corriger une faute plusieurs fois, pas
// de quoi servir de boîte d'écriture (§5.3, « nombre d'envois borné »).
const PLAFOND_FORMULAIRES = 20
const DUREE_LIEN_MS = 365 * 24 * 3600 * 1000
// Statuts où le destinataire peut encore changer (§5.3 : verrouillé à
// l'émission).
const MODIFIABLES = ['lien_envoye', 'formulaire_rempli', 'a_confirmer']

const refus = (motif, champ = null) => ({ ok: false, motif, ...(champ ? { champ } : {}) })
const panne = (contexte, error) => {
  console.error(`[factures-voyageur] ${contexte}`, error && error.message)
  return { ok: false, motif: 'panne' }
}

// ─── La langue du voyageur (Q9 bis, P5) ──────────────────────────────────────
// Même lecture que `voyageurDeLaReservation` (api/avis.js) : la langue du client
// dans le payload brut, puis celle du snapshot. Un code (« fr », « fr-FR »,
// « pt_BR »), jamais un nom. ⚠ Hors fr/en/es, ou inconnue : ANGLAIS (P5,
// Thierry, 8 nov. 2026, 22 h 09).
function langueDeLaReservation ({ snapshot = null, raw = null } = {}) {
  const sp = snapshot || {}
  const r = raw || {}
  const attributs = r.attributes || r
  const clientR = attributs.customer || r.customer || {}
  const brute = String(clientR.language || clientR.locale || sp.language || r.lang || '').trim().toLowerCase()
  const code = /^[a-z]{2}($|[-_])/.test(brute) ? brute.slice(0, 2) : null
  return LANGUES.includes(code) ? code : 'en'
}

// ─── Le jeton ────────────────────────────────────────────────────────────────
const JETON_RE = /^[A-Za-z0-9_-]{43}$/
const hacher = (clair) => crypto.createHash('sha256').update(String(clair)).digest('hex')
function nouveauJeton () {
  const clair = crypto.randomBytes(32).toString('base64url')
  return { clair, hash: hacher(clair) }
}
const jetonBienForme = (clair) => typeof clair === 'string' && JETON_RE.test(clair)

// ⚠ `APP_URL` D'ABORD, comme lib/stripe-hote.js : c'est la variable que
// staging porte avec SA valeur (docs/STAGING.md §3). Ne lire que
// `PUBLIC_BASE_URL`, absente de staging, faisait pointer les liens de la
// recette vers la production — qui répond « lien invalide » (review 1, B5).
function baseUrl () {
  return (process.env.APP_URL || process.env.PUBLIC_BASE_URL || 'https://hotesmart.vercel.app').replace(/\/+$/, '')
}
const lienPublic = (clair) => `${baseUrl()}/facture#${clair}`

// Expiration = la plus tardive du départ et de l'envoi, + 1 an (Q13) : un lien
// renvoyé après un an n'est pas déjà mort. Le départ est une date « AAAA-MM-JJ »
// (snapshot) : on prend la fin de ce jour, jamais son début.
function expirationDuLien ({ depart = null, maintenant = new Date() } = {}) {
  const t0 = maintenant.getTime()
  const td = /^\d{4}-\d{2}-\d{2}$/.test(String(depart || ''))
    ? Date.parse(`${depart}T23:59:59Z`)
    : NaN
  const base = Number.isFinite(td) ? Math.max(t0, td) : t0
  return new Date(base + DUREE_LIEN_MS)
}

// ─── Le message qui porte le lien (§11.1, VALIDÉ par Thierry le 8 nov. 2026) ──
// ⚠ Aucun texte ne nomme HôteSmart : le message part au nom de l'hôte.
// `{prenom}` suit la règle de lib/balises.js (sans prénom : « Bonjour, »).
const TEXTES_LIEN = {
  fr: 'Bonjour {prenom}, pour recevoir votre facture, merci de renseigner vos coordonnées de facturation ici : {lien}. Votre facture sera disponible sur ce même lien après votre séjour.',
  en: 'Hello {prenom}, to receive your invoice, please enter your billing details here: {lien}. Your invoice will be available at the same link after your stay.',
  es: 'Hola {prenom}, para recibir su factura, introduzca sus datos de facturación aquí: {lien}. Su factura estará disponible en este mismo enlace después de su estancia.'
}
// Le sujet, quand le lien part par e-mail (réservation directe) : dans la
// langue du voyageur, au nom du logement — le sujet par défaut du chemin commun
// est en français (review 1).
const SUJETS_LIEN = {
  fr: 'Votre facture — {bien}',
  en: 'Your invoice — {bien}',
  es: 'Su factura — {bien}'
}
function sujetDuLien (langue, bien) {
  const modele = SUJETS_LIEN[LANGUES.includes(langue) ? langue : 'en']
  return bien ? modele.replace('{bien}', () => String(bien)) : modele.replace(' — {bien}', '')
}

function texteDuLien (langue, prenom, lien) {
  const { prenomNeutre } = require('./balises')
  const modele = TEXTES_LIEN[LANGUES.includes(langue) ? langue : 'en']
  // Le lien d'abord, par une fonction : un `$` dans une valeur ne doit pas être
  // lu comme un motif de remplacement (le défaut connu de lib/balises.js).
  return prenomNeutre(modele.replace('{lien}', () => lien), prenom)
}

// ─── Le destinataire ─────────────────────────────────────────────────────────
// Les bornes sont celles de la base (fv_tailles_chk) : refuser ici donne un
// motif lisible, la base reste la dernière ligne.
const BORNES = { nom: 200, adresse1: 200, adresse2: 200, code_postal: 20, ville: 120, pays: 80, tva: 20 }
// Les caractères de contrôle n'ont rien à faire sur une facture ; un saut de
// ligne dans une adresse ligne non plus.
const propre = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()

function validerDestinataire (entree) {
  const e = entree && typeof entree === 'object' ? entree : {}
  const type = String(e.type || '')
  if (!['particulier', 'societe'].includes(type)) return refus('entree_invalide', 'type')
  const d = { type }
  for (const champ of Object.keys(BORNES)) {
    const v = propre(e[champ])
    if (v.length > BORNES[champ]) return refus('entree_invalide', champ)
    d[champ] = v || null
  }
  for (const requis of ['nom', 'adresse1', 'ville', 'pays']) {
    if (!d[requis]) return refus('entree_invalide', requis)
  }
  // Le SIREN : 9 chiffres, espaces tolérés à la saisie.
  const siren = propre(e.siren).replace(/\s/g, '')
  d.siren = siren || null
  if (d.siren && !/^\d{9}$/.test(d.siren)) return refus('entree_invalide', 'siren')
  // La TVA intracommunautaire : deux lettres de pays puis 2 à 13 caractères.
  d.tva = d.tva ? d.tva.replace(/[\s.-]/g, '').toUpperCase() : null
  if (d.tva && !/^[A-Z]{2}[A-Z0-9]{2,13}$/.test(d.tva)) return refus('entree_invalide', 'tva')
  // Un particulier n'a ni SIREN ni TVA : on ne garde pas ce qu'un formulaire
  // aurait laissé dans un champ caché.
  if (type === 'particulier') { d.siren = null; d.tva = null }
  return { ok: true, dest: d }
}

// ─── Un lien neuf (porte 1 : la fiche ; plus tard balise, GuestFlow) ─────────
// Ouvre (ou retrouve) la demande active et lui ajoute un jeton, en UNE
// transaction (fv_nouveau_lien). Rend le lien EN CLAIR : à l'appelant de
// l'envoyer, et de dire l'issue par `noterEnvoi`.
async function ouvrirLien (userId, { propertyUuid, bookingId, langue, porte, creePar = null, depart = null, maintenant = new Date() } = {}, { db = client() } = {}) {
  if (!userId || !propertyUuid || !bookingId) return refus('entree_invalide')
  if (!PORTES.includes(porte)) return refus('entree_invalide', 'porte')
  const lg = LANGUES.includes(langue) ? langue : 'en'
  const { clair, hash } = nouveauJeton()
  const expire = expirationDuLien({ depart, maintenant })
  const { data, error } = await db.rpc('fv_nouveau_lien', {
    p_user: userId, p_property: propertyUuid, p_booking: String(bookingId),
    p_langue: lg, p_cree_par: creePar, p_hash: hash, p_porte: porte,
    p_expire: expire.toISOString()
  })
  if (error) {
    // L'anti-double-clic de la base (errcode dédié FV429) : un refus, pas une
    // panne. ⚠ Pas 55P03, qui est aussi l'attente de verrou expirée.
    if (error.code === 'FV429') return refus('trop_rapproche')
    return panne('ouverture du lien', error)
  }
  const ligne = Array.isArray(data) ? data[0] : data
  if (!ligne || !ligne.r_demande || !ligne.r_jeton) return panne('ouverture du lien', { message: 'reponse vide' })
  return {
    ok: true,
    demande: { id: ligne.r_demande, statut: ligne.r_statut, creee: ligne.r_creee === true },
    jeton: { id: ligne.r_jeton, expire_le: expire.toISOString() },
    lien: lienPublic(clair)
  }
}

// L'issue du message qui a porté le lien. Filtré par compte : un jeton d'un
// autre compte ne se met pas à jour.
const ISSUES = ['livre', 'refus', 'incertain', 'permanent', 'sans_canal', 'differe']
async function noterEnvoi (userId, jetonId, { issue, motif = null } = {}, { db = client() } = {}) {
  if (!ISSUES.includes(issue)) return refus('entree_invalide', 'issue')
  const { error } = await db.from('factures_voyageur_jetons')
    .update({ envoi: issue, envoi_motif: motif ? String(motif).slice(0, 200) : null, envoi_le: new Date().toISOString() })
    .eq('id', jetonId).eq('user_id', userId)
  if (error) return panne('issue de l\'envoi', error)
  return { ok: true }
}

// ─── Ouvrir (ou retrouver) la demande, sans lien (saisie par l'hôte, Q12) ────
async function ouvrirDemande (userId, { propertyUuid, bookingId, langue, creePar = null } = {}, { db = client() } = {}) {
  if (!userId || !propertyUuid || !bookingId) return refus('entree_invalide')
  const { data, error } = await db.rpc('fv_ouvrir_demande', {
    p_user: userId, p_property: propertyUuid, p_booking: String(bookingId),
    p_langue: LANGUES.includes(langue) ? langue : 'en', p_cree_par: creePar
  })
  if (error) return panne('ouverture de la demande', error)
  const ligne = Array.isArray(data) ? data[0] : data
  if (!ligne || !ligne.r_demande) return panne('ouverture de la demande', { message: 'reponse vide' })
  return { ok: true, demande: { id: ligne.r_demande, statut: ligne.r_statut, creee: ligne.r_creee === true } }
}

// ─── La saisie de l'hôte (Q12), en UNE transaction ────────────────────────────
// fv_saisir_par_hote ouvre (ou retrouve) la demande ET l'enregistre : un échec
// ne laisse ni demande orpheline « lien envoyé » ni saisie partielle.
async function saisirParHote (userId, { propertyUuid, bookingId, langue, par, dest } = {}, { db = client() } = {}) {
  if (!userId || !propertyUuid || !bookingId || !par) return refus('entree_invalide')
  const { data, error } = await db.rpc('fv_saisir_par_hote', {
    p_user: userId, p_property: propertyUuid, p_booking: String(bookingId),
    p_langue: LANGUES.includes(langue) ? langue : 'en', p_par: par,
    p_dest: destPourLaBase(dest)
  })
  if (error) {
    if (error.code === 'FV409') {
      const issue = String(error.message || '').split(':').pop().trim()
      return refus(MOTIFS_SAISIE[issue] || 'verrouillee')
    }
    if (error.code === '23514') return refus('entree_invalide')
    return panne('saisie de l\'hôte', error)
  }
  const ligne = Array.isArray(data) ? data[0] : data
  if (!ligne || !ligne.r_demande) return panne('saisie de l\'hôte', { message: 'reponse vide' })
  return { ok: true, demande: { id: ligne.r_demande } }
}

// La demande ACTIVE d'une réservation, ou `null` — pour savoir, sur un bien
// archivé, s'il y a une demande en cours à mener au bout (P3).
async function demandeActive (userId, bookingId, { db = client() } = {}) {
  const { data, error } = await db.from('factures_voyageur')
    .select('id, statut')
    .eq('user_id', userId).eq('booking_id', String(bookingId)).eq('nature', 'facture')
    .not('statut', 'in', '(annulee_par_avoir,sans_objet)')
    .maybeSingle()
  if (error) return panne('lecture de la demande active', error)
  return { ok: true, demande: data || null }
}

// ─── Le destinataire, enregistré ─────────────────────────────────────────────
// `jetonId` : saisie du VOYAGEUR par son lien (plafond par jeton) ; `null` :
// saisie de l'HÔTE (Q12). La base verrouille après l'émission.
const MOTIFS_SAISIE = { verrouillee: 'verrouillee', plafond: 'plafond', introuvable: 'introuvable' }
const destPourLaBase = (dest) => ({
  type: dest.type, nom: dest.nom, adresse1: dest.adresse1, adresse2: dest.adresse2,
  code_postal: dest.code_postal, ville: dest.ville, pays: dest.pays,
  tva: dest.tva, siren: dest.siren
})
async function enregistrerDestinataire (userId, demandeId, dest, { jetonId = null, saisiPar, saisiParUser = null } = {}, { db = client() } = {}) {
  if (!['voyageur', 'hote'].includes(saisiPar)) return refus('entree_invalide', 'saisi_par')
  if (saisiPar === 'voyageur' && !jetonId) return refus('entree_invalide', 'jeton')
  const { data, error } = await db.rpc('fv_enregistrer_destinataire', {
    p_demande: demandeId, p_user: userId, p_jeton: jetonId,
    p_dest: destPourLaBase(dest),
    p_saisi_par: saisiPar, p_saisi_par_user: saisiParUser, p_max: PLAFOND_FORMULAIRES
  })
  if (error) {
    // Une contrainte de la base (taille, SIREN) : l'entrée, pas une panne.
    if (error.code === '23514') return refus('entree_invalide')
    return panne('enregistrement du destinataire', error)
  }
  if (data === 'ok') return { ok: true }
  if (MOTIFS_SAISIE[data]) return refus(MOTIFS_SAISIE[data])
  return panne('enregistrement du destinataire', { message: `issue inconnue : ${data}` })
}

// ─── Le voyageur, par son jeton ──────────────────────────────────────────────
const CHAMPS_DEMANDE = 'id, user_id, property_uuid, booking_id, nature, statut, langue, ' +
  'dest_type, dest_nom, dest_adresse_ligne1, dest_adresse_ligne2, dest_code_postal, dest_ville, ' +
  'dest_pays, dest_tva, dest_siren, saisi_par, saisi_le'

async function lireParJeton (clair, { db = client(), maintenant = new Date() } = {}) {
  if (!jetonBienForme(clair)) return refus('lien_invalide')
  const { data: jeton, error } = await db.from('factures_voyageur_jetons')
    .select('id, demande_id, user_id, expire_le, formulaires')
    .eq('jeton_hash', hacher(clair))
    .maybeSingle()
  if (error) return panne('lecture du jeton', error)
  if (!jeton) return refus('lien_invalide')
  if (Date.parse(jeton.expire_le) <= maintenant.getTime()) return refus('lien_expire')
  const { data: demande, error: e2 } = await db.from('factures_voyageur')
    .select(CHAMPS_DEMANDE)
    .eq('id', jeton.demande_id).eq('user_id', jeton.user_id)
    .maybeSingle()
  if (e2) return panne('lecture de la demande', e2)
  if (!demande) return refus('lien_invalide')
  return { ok: true, jeton, demande }
}

// Ce que la page du voyageur reçoit : SA demande, rien d'autre du compte.
function destinataireVu (d) {
  if (!d || !d.dest_type) return null
  return {
    type: d.dest_type, nom: d.dest_nom, adresse1: d.dest_adresse_ligne1, adresse2: d.dest_adresse_ligne2,
    code_postal: d.dest_code_postal, ville: d.dest_ville, pays: d.dest_pays,
    tva: d.dest_tva, siren: d.dest_siren
  }
}

module.exports = {
  LANGUES, PORTES, PLAFOND_FORMULAIRES, MODIFIABLES, TEXTES_LIEN, ISSUES,
  langueDeLaReservation, hacher, nouveauJeton, jetonBienForme, lienPublic, expirationDuLien,
  texteDuLien, sujetDuLien, validerDestinataire,
  ouvrirLien, noterEnvoi, ouvrirDemande, saisirParHote, demandeActive, enregistrerDestinataire,
  lireParJeton, destinataireVu
}
