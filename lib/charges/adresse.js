// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/adresse.js — LES ADRESSES DE FACTURES (compte de charges, lot 5)
// Spec : docs/specs/spec-compte-de-charges.md §14.24
//
// Une adresse par entité juridique et une par logement (Thierry, 23 novembre
// 2026) : `la-bulle.k2j9x7q4@reply.hotesmart.fr`. Le nom de l'entité ou du
// logement, un point, 8 caractères tirés au hasard.
//
// ⚠ WRITER UNIQUE DE `charges_adresses_email` (migration
// 2026-11-23-charges-adresses-email.sql). RLS sans politique : la clé de
// service ne filtre rien d'elle-même, donc CHAQUE requête porte le compte, et
// toute entité ou logement désigné est RÉSOLU EN BASE dans ce compte avant
// d'être touché (REVIEW.md règle 11). La base le garantit une seconde fois
// (clé composée vers l'entité, déclencheur pour le logement).
//
// ⚠ LE NOM NE PROTÈGE RIEN, C'EST LE CODE. Le nom d'un logement est public
// (il est sur Airbnb) et deux hôtes peuvent avoir une « La bulle » : seul le
// code tiré au hasard rend l'adresse impossible à deviner. 36⁸ ≈ 2,8 × 10¹²
// combinaisons, tirées par `crypto`, jamais par un générateur ordinaire.
//
// ⚠ L'ADRESSE EST LA CLÉ. « Changer d'adresse » la REMPLACE : l'ancienne
// n'existe plus en base, donc un e-mail qui y arrive ne se résout pas. Rien à
// signer, aucun secret à garder dans Vercel (la signature prévue par Q16 est
// abandonnée, §14.24.2).
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('node:crypto')
const { DOMAINE } = require('../jeton-reponse')

const TABLE = 'charges_adresses_email'
// ⚠ LE MÊME MOTIF QUE LA MIGRATION (`cae_locale_ck`), comparé par
// tests/charges-adresse.test.js. Un point avant le code : une adresse de
// réponse d'un voyageur (`<réservation>-<signature>`) n'en a jamais.
const LOCALE_RE = /^[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9]{8}$/
const LONGUEUR_MAX = 50
const TAILLE_CODE = 8
const NOM_MAX = LONGUEUR_MAX - TAILLE_CODE - 1
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
// Les lettres qu'aucune décomposition Unicode ne ramène à l'ASCII.
const LIGATURES = { œ: 'oe', æ: 'ae', ß: 'ss', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th' }
const REPLI = { entite: 'factures', bien: 'logement' }
// Un compte n'a pas 2 000 entités et logements. La lecture le borne quand
// même, et un dépassement est une PANNE dite, jamais une liste tronquée.
const MAX_ADRESSES = 2000
const ESSAIS = 3
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const refus = (statut, code) => ({ ok: false, statut, code })
const panne = (code = 'panne') => refus(503, code)

// ─── La forme d'une adresse ─────────────────────────────────────────────────
/** Le nom, en minuscules ASCII et tirets, coupé à 41 caractères. */
function nomDAdresse (nom, repli = REPLI.bien) {
  let s = String(nom == null ? '' : nom).toLowerCase()
  s = s.replace(/[œæßøłđðþ]/g, c => LIGATURES[c])
  s = s.normalize('NFD').replace(/\p{M}/gu, '')
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length > NOM_MAX) s = s.slice(0, NOM_MAX).replace(/-+$/, '')
  return s || repli
}

/**
 * 8 caractères tirés au hasard parmi 36, SANS BIAIS : un octet ≥ 252 est
 * rejeté (252 = 36 × 7), sinon les 4 premières lettres sortiraient plus
 * souvent que les autres.
 */
function codeAuHasard (alea = crypto.randomBytes) {
  let s = ''
  while (s.length < TAILLE_CODE) {
    for (const o of alea(16)) {
      if (o < 252 && s.length < TAILLE_CODE) s += ALPHABET[o % 36]
    }
  }
  return s
}

const adresseComplete = (locale) => `${locale}@${DOMAINE}`

/**
 * La partie avant `@` d'une adresse de FACTURES, ou `null`. Accepte la forme
 * « Nom <adresse> » et un tableau d'une adresse (Brevo documente ses champs
 * comme optionnels, pas leur forme).
 */
function localeDe (adresse) {
  const brut = Array.isArray(adresse) ? adresse[0] : adresse
  let a = String(brut == null ? '' : brut).trim().toLowerCase()
  const m = /<([^>]*)>/.exec(a)
  if (m) a = m[1].trim()
  const at = a.lastIndexOf('@')
  if (at <= 0 || a.slice(at + 1) !== DOMAINE) return null
  const locale = a.slice(0, at)
  return locale.length <= LONGUEUR_MAX && LOCALE_RE.test(locale) ? locale : null
}
const estAdresseDeFactures = (adresse) => localeDe(adresse) !== null

// ─── Les lectures ───────────────────────────────────────────────────────────
function moduleEntites (deps) {
  return (deps && deps.entites) || require('../entites-juridiques')
}

// ⚠ PAGE APRÈS PAGE : PostgREST rend 1000 lignes SANS erreur.
async function biensDuCompte (db, compte) {
  const lignes = []
  for (let depuis = 0; ; depuis += 1000) {
    const { data, error } = await db.from('properties').select('id, name, archive_le')
      .eq('user_id', compte).order('id', { ascending: true }).range(depuis, depuis + 999)
    if (error) return { ok: false }
    lignes.push(...(data || []))
    if (!data || data.length < 1000) return { ok: true, biens: lignes }
  }
}

async function adressesDuCompte (db, compte) {
  const { data, error } = await db.from(TABLE).select('locale, entite_id, property_uuid')
    .eq('user_id', compte).limit(MAX_ADRESSES + 1)
  if (error || !Array.isArray(data) || data.length > MAX_ADRESSES) return { ok: false }
  return { ok: true, adresses: data }
}

/** L'adresse vivante d'UNE cible du compte : `{ ok, locale }` (`null` sans adresse). */
async function adresseDe (db, compte, cible) {
  let q = db.from(TABLE).select('locale').eq('user_id', compte)
  q = cible.entite_id ? q.eq('entite_id', cible.entite_id) : q.eq('property_uuid', cible.property_uuid)
  const { data, error } = await q.maybeSingle()
  if (error) return { ok: false }
  return { ok: true, locale: data ? data.locale : null }
}

// ─── Les écritures ──────────────────────────────────────────────────────────
/**
 * Crée l'adresse d'une cible. ⚠ UNE COLLISION N'EST PAS UNE PANNE : deux
 * fenêtres ouvertes en même temps créent la même adresse (l'index unique de la
 * cible refuse la seconde, et c'est la première qu'on rend) ; un code déjà
 * pris ailleurs (une chance sur 2,8 × 10¹²) se retire.
 */
async function creer (db, compte, cible, nom, repli, deps = {}) {
  for (let essai = 0; essai < ESSAIS; essai++) {
    const locale = `${nomDAdresse(nom, repli)}.${codeAuHasard(deps.alea)}`
    const { data, error } = await db.from(TABLE).insert({ locale, user_id: compte, ...cible })
      .select('locale').maybeSingle()
    if (!error && data) return { ok: true, locale: data.locale }
    if (!error || error.code !== '23505') return panne()
    const deja = await adresseDe(db, compte, cible)
    if (!deja.ok) return panne()
    if (deja.locale) return { ok: true, locale: deja.locale }
  }
  return panne()
}

/**
 * Les adresses du compte, celles qui manquent créées au passage : une par
 * entité NON archivée, une par logement NON archivé, logement sans entité
 * compris (Thierry, 23 novembre 2026 : « un bien peut avoir des factures sans
 * être lié à une entité, mais un rappel est fait »). Idempotent : rien n'est
 * créé deux fois. Rend aussi l'entité de chaque logement, pour le rappel.
 */
async function adresses (db, compte, deps = {}) {
  const ej = moduleEntites(deps)
  const [e, b, l, a] = await Promise.all([
    ej.entitesDuCompte(compte, { db }), biensDuCompte(db, compte),
    ej.liensDuCompte(compte, { db }), adressesDuCompte(db, compte)
  ])
  if (!e || !e.ok || !b.ok || !l || !l.ok || !a.ok) return panne()

  const parEntite = new Map()
  const parBien = new Map()
  for (const x of a.adresses) {
    if (x.entite_id) parEntite.set(String(x.entite_id), x.locale)
    else if (x.property_uuid) parBien.set(String(x.property_uuid), x.locale)
  }
  const entiteDe = new Map((l.liens || []).map(x => [String(x.property_uuid), x.entite_id]))
  const entites = (e.entites || []).filter(x => !x.archivee_le)
  const biens = b.biens.filter(x => !x.archive_le)
    .sort((x, y) => String(x.name || '').localeCompare(String(y.name || '')))

  const sortieEntites = []
  for (const x of entites) {
    let locale = parEntite.get(String(x.id))
    if (!locale) {
      const c = await creer(db, compte, { entite_id: x.id }, x.nom, REPLI.entite, deps)
      if (!c.ok) return c
      locale = c.locale
    }
    sortieEntites.push({ id: x.id, nom: x.nom, adresse: adresseComplete(locale) })
  }
  const sortieBiens = []
  for (const x of biens) {
    let locale = parBien.get(String(x.id))
    if (!locale) {
      const c = await creer(db, compte, { property_uuid: x.id }, x.name, REPLI.bien, deps)
      if (!c.ok) return c
      locale = c.locale
    }
    sortieBiens.push({ id: x.id, nom: x.name, entite_id: entiteDe.get(String(x.id)) || null, adresse: adresseComplete(locale) })
  }
  return { ok: true, entites: sortieEntites, biens: sortieBiens }
}

/**
 * « Changer d'adresse » : une nouvelle adresse, au nom du moment ; l'ancienne
 * est refusée AUSSITÔT (elle n'existe plus). La cible est résolue dans le
 * compte AVANT toute écriture ; une entité ou un logement archivé n'en reçoit
 * pas.
 */
async function changer (db, compte, { entiteId, bienId } = {}, deps = {}) {
  const e = entiteId == null || entiteId === '' ? null : String(entiteId)
  const b = bienId == null || bienId === '' ? null : String(bienId)
  if ((e === null) === (b === null)) return refus(400, 'cible_invalide')
  if (!UUID_RE.test(e || b)) return refus(400, 'cible_invalide')

  let cible, nom, repli
  if (e) {
    const r = await moduleEntites(deps).entiteDuCompte(compte, e, { db })
    if (!r || !r.ok) return panne()
    if (!r.entite) return refus(404, 'entite_introuvable')
    if (r.entite.archivee_le) return refus(409, 'entite_archivee')
    cible = { entite_id: e }; nom = r.entite.nom; repli = REPLI.entite
  } else {
    const { data, error } = await db.from('properties').select('id, name, archive_le')
      .eq('id', b).eq('user_id', compte).maybeSingle()
    if (error) return panne()
    if (!data) return refus(404, 'bien_introuvable')
    if (data.archive_le) return refus(409, 'bien_archive')
    cible = { property_uuid: b }; nom = data.name; repli = REPLI.bien
  }

  for (let essai = 0; essai < ESSAIS; essai++) {
    const locale = `${nomDAdresse(nom, repli)}.${codeAuHasard(deps.alea)}`
    let q = db.from(TABLE).update({ locale, cree_le: new Date().toISOString() }).eq('user_id', compte)
    q = cible.entite_id ? q.eq('entite_id', cible.entite_id) : q.eq('property_uuid', cible.property_uuid)
    const { data, error } = await q.select('locale')
    if (error && error.code === '23505') continue
    if (error) return panne()
    if (data && data.length) return { ok: true, adresse: adresseComplete(data[0].locale) }
    // Aucune adresse encore : c'est une création.
    const c = await creer(db, compte, cible, nom, repli, deps)
    return c.ok ? { ok: true, adresse: adresseComplete(c.locale) } : c
  }
  return panne()
}

// ─── La résolution d'une adresse reçue (lib/charges/email.js) ───────────────
/**
 * De quel compte, de quelle entité, de quel logement s'agit-il ? ⚠ TOUT VIENT
 * DE LA BASE, rien du message : l'adresse n'est qu'une clé.
 * `{ ok: true, compte, entiteId, bienId }`, ou `{ ok: false, raison,
 * definitif }` — `definitif` dit qu'un rejeu ne changerait rien (adresse
 * inconnue, changée, cible archivée) ; sans lui, c'est une panne passagère.
 * Pour un logement, l'entité est celle du logement À L'ARRIVÉE, ou aucune.
 */
async function resoudre (db, adresse, deps = {}) {
  const locale = localeDe(adresse)
  if (!locale) return { ok: false, definitif: true, raison: 'forme' }
  const { data, error } = await db.from(TABLE).select('user_id, entite_id, property_uuid')
    .eq('locale', locale).maybeSingle()
  if (error) return { ok: false, raison: 'lecture_adresse' }
  if (!data) return { ok: false, definitif: true, raison: 'adresse_inconnue' }
  const compte = data.user_id
  const ej = moduleEntites(deps)
  if (data.entite_id) {
    const r = await ej.entiteDuCompte(compte, data.entite_id, { db })
    if (!r || !r.ok) return { ok: false, raison: 'lecture_entite' }
    if (!r.entite || r.entite.archivee_le) return { ok: false, definitif: true, raison: 'entite_archivee' }
    return { ok: true, compte, entiteId: r.entite.id, bienId: null }
  }
  const { data: bien, error: eB } = await db.from('properties').select('id, archive_le')
    .eq('id', data.property_uuid).eq('user_id', compte).maybeSingle()
  if (eB) return { ok: false, raison: 'lecture_bien' }
  if (!bien || bien.archive_le) return { ok: false, definitif: true, raison: 'bien_archive' }
  const eb = await ej.entiteDuBien(compte, bien.id, { db })
  if (!eb || !eb.ok) return { ok: false, raison: 'lecture_entite' }
  return { ok: true, compte, entiteId: eb.entite ? eb.entite.id : null, bienId: bien.id }
}

module.exports = {
  adresses, changer, resoudre,
  nomDAdresse, codeAuHasard, localeDe, estAdresseDeFactures, adresseComplete,
  LOCALE_RE, LONGUEUR_MAX, TAILLE_CODE, NOM_MAX, MAX_ADRESSES, TABLE
}
