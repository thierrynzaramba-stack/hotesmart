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

const COLONNES_ECRAN = 'id, nom, email, telephone, biens, alertes, desinscrit_le, cree_le'
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RE_JETON = /^[0-9a-f]{64}$/
const PLAFOND_ESSAIS_JOUR = 10
const PLAFOND_LECTURE = 1000
const jourParis = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(t))
const nouveauJeton = () => require('node:crypto').randomBytes(32).toString('hex')

// Les adresses d'un contact, normalisées : ce qui désigne une personne.
function clesAdresse (c) {
  return [cleEmail(c && c.email) && `e:${cleEmail(c.email)}`, cleTelephone(c && c.telephone) && `t:${cleTelephone(c.telephone)}`].filter(Boolean)
}

// Les contacts du compte, pour l'écran. Lus à PLAFOND + 1 : au-delà, on le dit.
async function listerContacts ({ compte, db = client() }) {
  const { data, error } = await db.from('notifications_contacts').select(COLONNES_ECRAN)
    .eq('compte_id', compte).order('cree_le', { ascending: true }).limit(PLAFOND_CONTACTS + 1)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  const l = data || []
  return { ok: true, contacts: l.slice(0, PLAFOND_CONTACTS), tronque: l.length > PLAFOND_CONTACTS }
}

// LES ESSAIS DU JOUR DU COMPTE (Q37) : les adresses déjà essayées aujourd'hui
// (jour de Paris), et leur nombre. La trace vit HORS de la ligne du contact :
// retirer puis recréer un contact ne rend pas d'essai.
async function essaisDuJour ({ compte, maintenant = Date.now(), db = client() }) {
  const { data, error } = await db.from('notifications_contacts_essais').select('cle')
    .eq('compte_id', compte).eq('jour', jourParis(maintenant)).limit(PLAFOND_LECTURE)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  const cles = new Set((data || []).map(x => x.cle))
  return { ok: true, cles, nombre: (data || []).length }
}

// Un essai est-il possible aujourd'hui (Q32, Q37) : pas désinscrit, le compte
// sous son plafond, et au moins une de ses adresses pas encore essayée.
function essaiPossible (contact, essais) {
  if (!contact || contact.desinscrit_le || !essais) return false
  if (essais.nombre >= PLAFOND_ESSAIS_JOUR) return false
  return clesAdresse(contact).some(k => !essais.cles.has(k))
}

async function biensDuCompte ({ compte, biens, db }) {
  const { data, error } = await db.from('properties').select('id').eq('user_id', compte).in('id', biens)
  if (error) return { ok: false, motif: 'biens_illisibles' }
  const duCompte = new Set((data || []).map(p => String(p.id)))
  return biens.some(b => !duCompte.has(b)) ? { ok: false, motif: 'bien_hors_compte' } : { ok: true }
}

// Une adresse du contact appartient-elle à quelqu'un qui s'est désinscrit des
// alertes de ce compte (Q36) ? Rend la plus récente date de désinscription.
async function desinscriptionDe ({ compte, cles, sauf = null, db }) {
  const { data, error } = await db.from('notifications_contacts').select('id, email, telephone, desinscrit_le')
    .eq('compte_id', compte).not('desinscrit_le', 'is', null).order('id', { ascending: true }).limit(PLAFOND_LECTURE)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  const dates = (data || []).filter(x => x.id !== sauf && clesAdresse(x).some(k => cles.includes(k))).map(x => x.desinscrit_le).sort()
  return { ok: true, le: dates.length ? dates[dates.length - 1] : null }
}

// Créer UN contact depuis l'écran : le plafond par compte s'ajoute aux règles
// de `creerContacts`. ⚠ L'ADRESSE D'UNE PERSONNE QUI S'EST DÉSINSCRITE (Q36) :
// refusée tant que le titulaire n'a pas confirmé (`confirme`) — l'écran le
// prévient, il choisit.
async function ajouterContact ({ compte, contact, confirme = false, db = client() }) {
  const v = validerContact(contact)
  if (!v.ok) return v
  const { data, error } = await db.from('notifications_contacts').select('id').eq('compte_id', compte).limit(PLAFOND_CONTACTS)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  if ((data || []).length >= PLAFOND_CONTACTS) return { ok: false, motif: 'plafond_contacts' }
  if (!confirme) {
    const d = await desinscriptionDe({ compte, cles: clesAdresse(v.contact), db })
    if (!d.ok) return d
    if (d.le) return { ok: false, motif: 'adresse_desinscrite', desinscrit_le: d.le }
  }
  return creerContacts({ compte, contacts: [contact], db })
}

// ⚠ DEUX RÈGLES QUAND L'ADRESSE CHANGE :
// - LE JETON CHANGE DÈS QUE L'E-MAIL CHANGE : le lien vit dans les e-mails, et
//   l'ancienne adresse ne doit plus pouvoir faire taire la nouvelle (constat de
//   SÉCURITÉ de review) ;
// - LA LIGNE REPART INSCRITE QUAND AUCUNE DE SES ANCIENNES ADRESSES NE RESTE
//   (Q35) : c'est une autre personne, qui ne s'est jamais désinscrite. Une
//   adresse gardée (le numéro, quand seul l'e-mail change) garde l'état de la
//   personne : on ne la réinscrit pas dans son dos.
// Une adresse inchangée (casse près) garde tout : son jeton, son état.
async function modifierContact ({ compte, id, contact, confirme = false, db = client() }) {
  if (!RE_UUID.test(String(id || ''))) return { ok: false, motif: 'contact_introuvable' }
  const v = validerContact(contact)
  if (!v.ok) return v
  const { data: lu, error } = await db.from('notifications_contacts').select('id, email, telephone')
    .eq('id', id).eq('compte_id', compte).maybeSingle()
  if (error) return { ok: false, motif: 'lecture_impossible' }
  if (!lu) return { ok: false, motif: 'contact_introuvable' }
  const b = await biensDuCompte({ compte, biens: v.contact.biens, db })
  if (!b.ok) return b
  const avant = clesAdresse(lu)
  const apres = clesAdresse(v.contact)
  const adresseChange = avant.sort().join('|') !== apres.sort().join('|')
  const emailChange = (cleEmail(lu.email) || null) !== (cleEmail(v.contact.email) || null)
  const autrePersonne = !avant.some(k => apres.includes(k))
  if (adresseChange && !confirme) {
    const d = await desinscriptionDe({ compte, cles: clesAdresse(v.contact), sauf: id, db })
    if (!d.ok) return d
    if (d.le) return { ok: false, motif: 'adresse_desinscrite', desinscrit_le: d.le }
  }
  const maj = { ...v.contact, maj_le: new Date().toISOString(),
    ...(emailChange ? { jeton: nouveauJeton() } : {}), ...(autrePersonne ? { desinscrit_le: null } : {}) }
  const { data, error: e2 } = await db.from('notifications_contacts').update(maj)
    .eq('id', id).eq('compte_id', compte).select('id')
  if (e2) return { ok: false, motif: 'ecriture_impossible' }
  return (data || []).length === 1 ? { ok: true, adresseChange } : { ok: false, motif: 'contact_introuvable' }
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

// RÉSERVER L'ESSAI DU JOUR (Q32, Q37), AVANT d'envoyer : une ligne par adresse
// dans `notifications_contacts_essais`, dont la clé primaire (compte, adresse,
// jour) EST la réservation — deux clics n'en font partir qu'un, et retirer puis
// recréer le contact n'en rend aucun. Seules les adresses pas encore essayées
// aujourd'hui partent. Rend le contact (avec son jeton, pour le lien de
// l'e-mail), les canaux réservés et ce qu'il faut pour `rendreEssai`.
async function reserverEssai ({ compte, id, maintenant = Date.now(), db = client() }) {
  if (!RE_UUID.test(String(id || ''))) return { ok: false, motif: 'contact_introuvable' }
  const { data: lu, error } = await db.from('notifications_contacts')
    .select('id, email, telephone, jeton, desinscrit_le').eq('id', id).eq('compte_id', compte).maybeSingle()
  if (error) return { ok: false, motif: 'lecture_impossible' }
  if (!lu) return { ok: false, motif: 'contact_introuvable' }
  if (lu.desinscrit_le) return { ok: false, motif: 'contact_desinscrit' }
  const e = await essaisDuJour({ compte, maintenant, db })
  if (!e.ok) return e
  if (e.nombre >= PLAFOND_ESSAIS_JOUR) return { ok: false, motif: 'plafond_essais' }
  const jour = jourParis(maintenant)
  const libres = clesAdresse(lu).filter(k => !e.cles.has(k)).slice(0, PLAFOND_ESSAIS_JOUR - e.nombre)
  if (!libres.length) return { ok: false, motif: 'essai_deja_fait' }
  // Toutes ou aucune : une adresse prise entre la lecture et l'écriture (un
  // autre clic) fait refuser l'insertion entière.
  const { error: e2 } = await db.from('notifications_contacts_essais').insert(libres.map(cle => ({ compte_id: compte, cle, jour })))
  if (e2) return { ok: false, motif: e2.code === '23505' ? 'essai_deja_fait' : 'ecriture_impossible' }
  const canaux = [libres.some(k => k.startsWith('e:')) ? 'email' : null, libres.some(k => k.startsWith('t:')) ? 'sms' : null].filter(Boolean)
  return { ok: true, contact: lu, canaux, reserve: { cles: libres, jour } }
}

// Rien n'est parti : on retire SES PROPRES lignes de réservation, et rien
// d'autre (la clé porte le jour : un autre clic, un autre jour, n'est pas touché).
async function rendreEssai ({ compte, reserve, db = client() }) {
  if (!reserve || !reserve.cles || !reserve.cles.length) return { ok: true }
  const { error } = await db.from('notifications_contacts_essais').delete()
    .eq('compte_id', compte).eq('jour', reserve.jour).in('cle', reserve.cles)
  return error ? { ok: false, motif: 'ecriture_impossible' } : { ok: true }
}

// ─── LA PAGE DE DÉSINSCRIPTION (publique, par jeton) ────────────────────────
async function contactParJeton ({ jeton, db = client() }) {
  if (!RE_JETON.test(String(jeton || ''))) return { ok: true, contact: null }
  const { data, error } = await db.from('notifications_contacts')
    .select('id, compte_id, email, telephone, biens, desinscrit_le').eq('jeton', jeton).maybeSingle()
  if (error) return { ok: false, motif: 'lecture_impossible' }
  return { ok: true, contact: data || null }
}

// LES LIGNES QUE LE LIEN FAIT TAIRE : celles du compte du lien qui portent une
// de ses adresses. ⚠ C'EST L'ADRESSE QUI SE DÉSINSCRIT, pas un nom : deux
// lignes d'une même personne sans adresse commune (un e-mail seul, un numéro
// seul) restent distinctes, et le texte de la page parle de l'adresse.
async function lignesDuLien ({ jeton, db = client() }) {
  const lu = await contactParJeton({ jeton, db })
  if (!lu.ok || !lu.contact) return lu
  const c = lu.contact
  const { data: tous, error } = await db.from('notifications_contacts').select('id, email, telephone, biens')
    .eq('compte_id', c.compte_id).order('id', { ascending: true }).limit(PLAFOND_LECTURE)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  const siennes = new Set(clesAdresse(c))
  const lignes = (tous || []).filter(x => x.id === c.id || clesAdresse(x).some(k => siennes.has(k)))
  return { ok: true, contact: c, lignes }
}

// Se désinscrire, ou revenir (Q30, Q33) : toutes les lignes du lien, ensemble.
async function changerInscriptionParJeton ({ jeton, inscrit, maintenant = Date.now(), db = client() }) {
  const lu = await lignesDuLien({ jeton, db })
  if (!lu.ok) return lu
  if (!lu.contact) return { ok: false, motif: 'contact_introuvable' }
  const ids = lu.lignes.map(x => x.id)
  const { data, error } = await db.from('notifications_contacts')
    .update({ desinscrit_le: inscrit ? null : new Date(maintenant).toISOString(), maj_le: new Date(maintenant).toISOString() })
    .eq('compte_id', lu.contact.compte_id).in('id', ids).select('id')
  if (error) return { ok: false, motif: 'ecriture_impossible' }
  return (data || []).length ? { ok: true, n: data.length } : { ok: false, motif: 'contact_introuvable' }
}

module.exports = {
  ALERTES, PLAFOND_CONTACTS, PLAFOND_ESSAIS_JOUR, alerteDe, cleEmail, cleTelephone, clesAdresse, contactsPour, relireContact,
  validerContact, creerContacts, listerContacts, essaisDuJour, essaiPossible, ajouterContact, modifierContact, retirerContact,
  reinscrireContact, reserverEssai, rendreEssai, contactParJeton, lignesDuLien, changerInscriptionParJeton
}
