// lib/notifications/contacts.js — LES CONTACTS LIBRES : qui, HORS du compte,
// reçoit une alerte (PWA lot 2c-3).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §16.3, Q25 et Q29 à Q32
// KB : docs/kb/pwa.md §12
//
// Un contact libre (un gardien, par exemple) est une adresse et/ou un numéro
// réglés par le titulaire, POUR DES BIENS CHOISIS. Il reprend les listes
// d'`agent_alert_config` : chacun garde ce que sa liste recevait (Q25) —
//   'urgences'       : l'urgence de l'IA (b), le code non résolu (j), le ménage
//                      refusé (l), les disponibilités modifiées (m) et
//                      l'évaluation du voyageur (o) — l'ancienne liste
//                      « intervention » ;
//   'info_manquante' : l'information manquante (c) — l'ancienne liste
//                      « info_unknown ».
// Il reçoit l'e-mail et le SMS, JAMAIS de notification (il n'a pas d'appareil),
// aux heures et dans la langue du titulaire (§4, Q31).
//
// ⚠ TOUJOURS SUR LE COMPTE : `compte_id` filtre chaque lecture. Un contact d'un
// compte n'est jamais lu pour un autre, même sur un bien dont l'identifiant
// serait partagé.
//
// ⚠ UN CONTACT DÉSINSCRIT NE REÇOIT PLUS RIEN (Q30) : sa ligne reste, pour que
// le titulaire le voie dans Réglages, mais aucune lecture d'envoi ne la rend.

function client () {
  return require('../cron-shared').supabase
}

const ALERTES = Object.freeze({
  urgences: Object.freeze(['urgence_ia', 'code_non_resolu', 'menage_refuse', 'disponibilites_modifiees', 'evaluation_voyageur']),
  info_manquante: Object.freeze(['info_manquante'])
})

// L'alerte d'un contact qui couvre cet événement, ou null : un événement hors
// de ces deux listes (une réservation, un avis…) ne va jamais à un contact.
function alerteDe (code) {
  for (const [alerte, codes] of Object.entries(ALERTES)) if (codes.includes(code)) return alerte
  return null
}

const COLONNES = 'id, compte_id, nom, email, telephone, biens, alertes, jeton, desinscrit_le'
// Les contacts d'UN bien pour UNE alerte : quelques-uns en pratique.
const PLAFOND_CONTACTS = 100

// Une adresse comparable : l'e-mail en minuscules ; le numéro en chiffres, au
// format international (« 06 12… », « 0033 6 12… » et « +33612… » sont le même).
function cleEmail (v) {
  const t = String(v || '').trim().toLowerCase()
  return t || null
}
function cleTelephone (v) {
  let t = String(v || '').replace(/[\s.\-()]/g, '')
  if (!t) return null
  if (t.startsWith('00')) t = '+' + t.slice(2)
  else if (/^0\d{9}$/.test(t)) t = '+33' + t.slice(1)
  return t.startsWith('+') ? t : '+' + t
}

// Ce qu'un envoi garde d'un contact : ses coordonnées et de quoi se désinscrire.
function versDestinataire (l) {
  return { contactId: l.id, email: l.email || null, telephone: l.telephone || null, jeton: l.jeton || null }
}

// L'identifiant HôteSmart du bien. Les émetteurs le passent presque toujours ;
// sinon, sa référence provider le retrouve sur le compte — le bien ACTIF, sinon
// le premier (la règle de lib/notifications/bien.js).
// ⚠ UN `id` ÉGAL À LA RÉFÉRENCE N'EST PAS UN `properties.id` (review de
// l'étape 1, constat 2) : c'est ce que rend `bienDuCompte` quand la lecture du
// bien est en panne, pour une référence Channex (en forme d'UUID). On le relit
// alors par sa référence — et une panne se dit.
async function idDuBien (compte, bien, db) {
  if (bien && bien.id && !(bien.ref && String(bien.id) === String(bien.ref))) return { ok: true, id: String(bien.id) }
  if (!bien || !bien.ref) return { ok: true, id: null }
  const { data, error } = await db.from('properties').select('id, archive_le')
    .eq('user_id', compte).eq('provider_property_id', String(bien.ref)).limit(5)
  if (error) return { ok: false }
  const lignes = Array.isArray(data) ? data : []
  const l = lignes.find(x => !x.archive_le) || lignes[0] || null
  return { ok: true, id: l ? String(l.id) : null }
}

/**
 * Les contacts libres d'un compte à prévenir pour cet événement, sur ce bien.
 * @returns {{ ok: true, contacts: Array<{ contactId, email, telephone, jeton }> } | { ok: false, motif }}
 */
async function contactsPour ({ compte, code, bien = null, db = client() }) {
  const alerte = alerteDe(code)
  if (!alerte || !compte) return { ok: true, contacts: [] }
  try {
    const b = await idDuBien(compte, bien, db)
    if (!b.ok) return { ok: false, motif: 'lecture_impossible' }
    // Un contact est réglé POUR DES BIENS : sans bien connu, personne.
    if (!b.id) return { ok: true, contacts: [] }
    const { data, error } = await db.from('notifications_contacts').select(COLONNES)
      .eq('compte_id', compte)
      .is('desinscrit_le', null)
      .contains('alertes', [alerte])
      .contains('biens', [b.id])
      .order('cree_le', { ascending: true })
      .limit(PLAFOND_CONTACTS)
    if (error) return { ok: false, motif: 'lecture_impossible' }
    // Au-delà du plafond, la coupe se DIT (constat 5) — les premiers créés passent.
    const tronque = (data || []).length >= PLAFOND_CONTACTS
    return { ok: true, tronque, contacts: (data || []).filter(l => l.email || l.telephone).map(versDestinataire) }
  } catch (e) {
    return { ok: false, motif: 'lecture_impossible' }
  }
}

/**
 * Un contact relu au moment de partir (la file des heures calmes) : toujours
 * sur ce compte, pas désinscrit, et réglé pour cet événement sur ce bien. Sinon
 * null — la ligne est écartée. Rend { ok: false } sur une lecture en panne : la
 * ligne reste en file pour le cycle suivant.
 */
async function relireContact ({ compte, contactId, code, bien = null, db = client() }) {
  try {
    const { data, error } = await db.from('notifications_contacts').select(COLONNES)
      .eq('id', contactId).eq('compte_id', compte).limit(1)
    if (error) return { ok: false }
    const l = Array.isArray(data) ? data[0] : data
    if (!l || l.desinscrit_le) return { ok: true, contact: null }
    const alerte = alerteDe(code)
    if (!alerte || !(l.alertes || []).includes(alerte)) return { ok: true, contact: null }
    const b = await idDuBien(compte, bien, db)
    if (!b.ok) return { ok: false }
    if (!b.id || !(l.biens || []).map(String).includes(b.id)) return { ok: true, contact: null }
    if (!l.email && !l.telephone) return { ok: true, contact: null }
    return { ok: true, contact: versDestinataire(l) }
  } catch (e) {
    return { ok: false }
  }
}

// ─── L'ÉCRITURE ─────────────────────────────────────────────────────────────
// ⚠ CE MODULE EST LE SEUL QUI ÉCRIT `notifications_contacts` (migration
// 2026-11-10) : la reprise des listes passe par ici (review de l'étape 2,
// constat 9), l'écran de Réglages aussi (étape 3).

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const RE_TELEPHONE = /^\+?[0-9]{7,15}$/
const NOM_MAX = 80

// Un contact tel qu'il s'écrira, ou le motif du refus. Le numéro se range tel
// qu'il a été saisi, espaces retirés — c'est ce que les listes envoyaient, et
// l'envoi le met au format international (`normalizePhone`).
function validerContact (c) {
  if (!c || typeof c !== 'object') return { ok: false, motif: 'contact_illisible' }
  const nom = c.nom == null || c.nom === '' ? null : String(c.nom).trim().slice(0, NOM_MAX) || null
  const email = c.email == null || c.email === '' ? null : String(c.email).trim()
  const telephone = c.telephone == null || c.telephone === '' ? null : String(c.telephone).replace(/\s/g, '')
  if (!email && !telephone) return { ok: false, motif: 'adresse_absente' }
  if (email && !RE_EMAIL.test(email)) return { ok: false, motif: 'email_illisible' }
  if (telephone && !RE_TELEPHONE.test(telephone)) return { ok: false, motif: 'telephone_illisible' }
  const alertes = Array.isArray(c.alertes) ? [...new Set(c.alertes)] : []
  if (!alertes.length || alertes.some(a => typeof a !== 'string' || !Object.hasOwn(ALERTES, a))) return { ok: false, motif: 'alertes_illisibles' }
  const biens = Array.isArray(c.biens) ? [...new Set(c.biens.map(String))] : []
  if (!biens.length) return { ok: false, motif: 'biens_absents' }
  return { ok: true, contact: { nom, email, telephone, alertes: alertes.sort(), biens: biens.sort() } }
}

// Crée des contacts sur UN compte, en une seule écriture : tous ou aucun.
// ⚠ CHAQUE BIEN DOIT ÊTRE UN BIEN DU COMPTE — relu en base, jamais cru.
async function creerContacts ({ compte, contacts, db = client() }) {
  if (!compte) return { ok: false, motif: 'compte_absent' }
  const lignes = []
  for (const c of contacts || []) {
    const v = validerContact(c)
    if (!v.ok) return v
    lignes.push({ compte_id: compte, ...v.contact })
  }
  if (!lignes.length) return { ok: true, n: 0 }
  const biens = [...new Set(lignes.flatMap(l => l.biens))]
  const { data, error } = await db.from('properties').select('id').eq('user_id', compte).in('id', biens)
  if (error) return { ok: false, motif: 'biens_illisibles' }
  const duCompte = new Set((data || []).map(p => String(p.id)))
  if (biens.some(b => !duCompte.has(b))) return { ok: false, motif: 'bien_hors_compte' }
  const { error: e2 } = await db.from('notifications_contacts').insert(lignes)
  if (e2) return { ok: false, motif: 'ecriture_impossible' }
  return { ok: true, n: lignes.length }
}

// ─── LA GESTION PAR LE TITULAIRE (étape 3, spec §16.8) ──────────────────────
// ⚠ CHAQUE FONCTION PREND LE COMPTE ET FILTRE DESSUS, À L'ÉCRITURE COMME À LA
// LECTURE : un id de contact d'un autre compte rend « introuvable », jamais
// « interdit » — rien n'apprend qu'il existe. Le jeton de désinscription ne
// sort jamais d'ici vers un écran.

const COLONNES_ECRAN = 'id, nom, email, telephone, biens, alertes, desinscrit_le, dernier_essai_le, cree_le'
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RE_JETON = /^[0-9a-f]{64}$/
const jourParis = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(t))

// Les contacts du compte, pour l'écran. Lus à PLAFOND + 1 : au-delà, on le dit.
async function listerContacts ({ compte, db = client() }) {
  const { data, error } = await db.from('notifications_contacts').select(COLONNES_ECRAN)
    .eq('compte_id', compte).order('cree_le', { ascending: true }).limit(PLAFOND_CONTACTS + 1)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  const l = data || []
  return { ok: true, contacts: l.slice(0, PLAFOND_CONTACTS), tronque: l.length > PLAFOND_CONTACTS }
}

// Un essai est-il possible aujourd'hui (Q32) ? Le jour est celui de Paris.
function essaiPossible (contact, maintenant = Date.now()) {
  if (!contact || contact.desinscrit_le) return false
  return !contact.dernier_essai_le || jourParis(contact.dernier_essai_le) !== jourParis(maintenant)
}

async function biensDuCompte ({ compte, biens, db }) {
  const { data, error } = await db.from('properties').select('id').eq('user_id', compte).in('id', biens)
  if (error) return { ok: false, motif: 'biens_illisibles' }
  const duCompte = new Set((data || []).map(p => String(p.id)))
  return biens.some(b => !duCompte.has(b)) ? { ok: false, motif: 'bien_hors_compte' } : { ok: true }
}

// Créer UN contact depuis l'écran : le plafond par compte s'ajoute aux règles
// de `creerContacts`.
async function ajouterContact ({ compte, contact, db = client() }) {
  const { data, error } = await db.from('notifications_contacts').select('id').eq('compte_id', compte).limit(PLAFOND_CONTACTS)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  if ((data || []).length >= PLAFOND_CONTACTS) return { ok: false, motif: 'plafond_contacts' }
  return creerContacts({ compte, contacts: [contact], db })
}

async function modifierContact ({ compte, id, contact, db = client() }) {
  if (!RE_UUID.test(String(id || ''))) return { ok: false, motif: 'contact_introuvable' }
  const v = validerContact(contact)
  if (!v.ok) return v
  const b = await biensDuCompte({ compte, biens: v.contact.biens, db })
  if (!b.ok) return b
  const { data, error } = await db.from('notifications_contacts')
    .update({ ...v.contact, maj_le: new Date().toISOString() })
    .eq('id', id).eq('compte_id', compte).select('id')
  if (error) return { ok: false, motif: 'ecriture_impossible' }
  return (data || []).length === 1 ? { ok: true } : { ok: false, motif: 'contact_introuvable' }
}

async function retirerContact ({ compte, id, db = client() }) {
  if (!RE_UUID.test(String(id || ''))) return { ok: false, motif: 'contact_introuvable' }
  const { data, error } = await db.from('notifications_contacts').delete().eq('id', id).eq('compte_id', compte).select('id')
  if (error) return { ok: false, motif: 'ecriture_impossible' }
  return (data || []).length === 1 ? { ok: true } : { ok: false, motif: 'contact_introuvable' }
}

// Réinscrire (Q33) : le titulaire le peut, depuis Réglages.
async function reinscrireContact ({ compte, id, db = client() }) {
  if (!RE_UUID.test(String(id || ''))) return { ok: false, motif: 'contact_introuvable' }
  const { data, error } = await db.from('notifications_contacts')
    .update({ desinscrit_le: null, maj_le: new Date().toISOString() })
    .eq('id', id).eq('compte_id', compte).select('id')
  if (error) return { ok: false, motif: 'ecriture_impossible' }
  return (data || []).length === 1 ? { ok: true } : { ok: false, motif: 'contact_introuvable' }
}

// RÉSERVER L'ESSAI DU JOUR (Q32), avant d'envoyer : une écriture CONDITIONNELLE
// à la valeur lue — deux clics simultanés n'en font partir qu'un. Rend le
// contact (avec son jeton, pour le lien de l'e-mail) et la valeur d'avant, pour
// `rendreEssai` si rien n'est parti.
async function reserverEssai ({ compte, id, maintenant = Date.now(), db = client() }) {
  if (!RE_UUID.test(String(id || ''))) return { ok: false, motif: 'contact_introuvable' }
  const { data: lu, error } = await db.from('notifications_contacts')
    .select('id, email, telephone, jeton, desinscrit_le, dernier_essai_le').eq('id', id).eq('compte_id', compte).maybeSingle()
  if (error) return { ok: false, motif: 'lecture_impossible' }
  if (!lu) return { ok: false, motif: 'contact_introuvable' }
  if (lu.desinscrit_le) return { ok: false, motif: 'contact_desinscrit' }
  if (!essaiPossible(lu, maintenant)) return { ok: false, motif: 'essai_deja_fait' }
  let q = db.from('notifications_contacts').update({ dernier_essai_le: new Date(maintenant).toISOString() })
    .eq('id', id).eq('compte_id', compte)
  q = lu.dernier_essai_le == null ? q.is('dernier_essai_le', null) : q.eq('dernier_essai_le', lu.dernier_essai_le)
  const { data: pris, error: e2 } = await q.select('id')
  if (e2) return { ok: false, motif: 'ecriture_impossible' }
  if ((pris || []).length !== 1) return { ok: false, motif: 'essai_deja_fait' }
  return { ok: true, contact: lu, avant: lu.dernier_essai_le || null }
}

// Rien n'est parti : l'essai du jour n'est pas consommé.
async function rendreEssai ({ compte, id, avant, db = client() }) {
  await db.from('notifications_contacts').update({ dernier_essai_le: avant }).eq('id', id).eq('compte_id', compte)
}

// ─── LA PAGE DE DÉSINSCRIPTION (publique, par jeton) ────────────────────────
async function contactParJeton ({ jeton, db = client() }) {
  if (!RE_JETON.test(String(jeton || ''))) return { ok: true, contact: null }
  const { data, error } = await db.from('notifications_contacts')
    .select('id, compte_id, email, telephone, biens, desinscrit_le').eq('jeton', jeton).maybeSingle()
  if (error) return { ok: false, motif: 'lecture_impossible' }
  return { ok: true, contact: data || null }
}

// Se désinscrire, ou revenir (Q30, Q33).
// ⚠ « NE PLUS RECEVOIR CES ALERTES » VAUT POUR LA PERSONNE, pas pour une ligne :
// une même adresse peut porter deux contacts du compte (deux ensembles
// d'alertes, la reprise des listes en crée) — les deux se taisent, et
// reviennent ensemble. Le geste ne sort jamais du compte du lien.
async function changerInscriptionParJeton ({ jeton, inscrit, maintenant = Date.now(), db = client() }) {
  const lu = await contactParJeton({ jeton, db })
  if (!lu.ok) return lu
  if (!lu.contact) return { ok: false, motif: 'contact_introuvable' }
  const c = lu.contact
  const { data: tous, error } = await db.from('notifications_contacts').select('id, email, telephone')
    .eq('compte_id', c.compte_id).limit(PLAFOND_CONTACTS + 1)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  const cles = (x) => [cleEmail(x.email) && `e:${cleEmail(x.email)}`, cleTelephone(x.telephone) && `t:${cleTelephone(x.telephone)}`].filter(Boolean)
  const siennes = new Set(cles(c))
  const ids = [...new Set([c.id, ...(tous || []).filter(x => cles(x).some(k => siennes.has(k))).map(x => x.id)])]
  const { data, error: e2 } = await db.from('notifications_contacts')
    .update({ desinscrit_le: inscrit ? null : new Date(maintenant).toISOString(), maj_le: new Date(maintenant).toISOString() })
    .eq('compte_id', c.compte_id).in('id', ids).select('id')
  if (e2) return { ok: false, motif: 'ecriture_impossible' }
  return (data || []).length ? { ok: true, n: data.length } : { ok: false, motif: 'contact_introuvable' }
}

module.exports = {
  ALERTES, PLAFOND_CONTACTS, alerteDe, cleEmail, cleTelephone, contactsPour, relireContact, validerContact, creerContacts,
  listerContacts, essaiPossible, ajouterContact, modifierContact, retirerContact, reinscrireContact, reserverEssai, rendreEssai,
  contactParJeton, changerInscriptionParJeton
}
