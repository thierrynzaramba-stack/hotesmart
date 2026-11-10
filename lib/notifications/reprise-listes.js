// lib/notifications/reprise-listes.js — LA REPRISE DES LISTES D'ALERTES en
// contacts libres et en réglages (PWA lot 2c-3, étape 2).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §16.3, Q25 et Q29 · KB : docs/kb/pwa.md §12.2
// Script : scripts/reprendre-listes-alertes.js (à blanc, puis --go).
//
// Les listes d'`agent_alert_config` (par bien, deux types : `intervention` et
// `info_unknown`, deux canaux : `sms_lines` et `email_lines`) deviennent :
//   - pour l'adresse d'une PERSONNE du compte (titulaire ou membre) : le canal
//     coché dans SES réglages, pour les événements de la liste que ses droits
//     couvrent sur ce bien — pas de contact pour ceux-là, sinon tout en double
//     (§16.3) ; et pour ceux que ses droits ne couvrent pas, un contact libre,
//     pour ne rien perdre (Q29) — le point d'envoi fait taire ce contact là où
//     elle est destinataire (lib/notifications/notifier.js) ;
//   - pour toute autre adresse : un contact libre, avec ses biens et ses alertes ;
//   - une adresse désinscrite (Q30) : rien, elle ne revient par aucun contact.
//
// ⚠ PERSONNE NE PERD UN DESTINATAIRE, ET C'EST VÉRIFIÉ : ce que chaque liste
// délivrait (canal, adresse, bien, événement) est recompté avec les règles du
// point d'envoi après la reprise. Une perte bloque l'écriture du compte — un
// bien introuvable aussi, sauf décision humaine.
//
// ⚠ LA COUPURE SE FAIT PAR COMPTE, PAR LA REPRISE : une fois ses contacts et
// ses réglages écrits, les listes du compte sont mises de côté
// (`mettreDeCote`). Un compte bloqué garde ses listes, et elles envoient.
//
// ⚠ CE QUE LES LISTES N'ENVOYAIENT PAS NE SE REPREND PAS : une liste dont le
// canal est décoché (`sms_enabled` ou `email_enabled` faux) n'envoyait rien —
// elle ne devient rien. La règle est celle de `sendAlertNotifications`.

const { ALERTES, alerteDe, cleEmail, cleTelephone } = require('./contacts')

// ⚠ LE `--go` DU SCRIPT EST FERMÉ tant que ceci est faux. Il s'ouvre à l'étape 4,
// quand plus rien ne peut réécrire une liste (le tiroir Alertes de Messages, le
// préremplissage de l'onboarding) : sinon une liste réécrite après la coupure
// enverrait en double de son contact.
const REPRISE_OUVERTE = false

const TYPES = Object.freeze({ intervention: 'urgences', info_unknown: 'info_manquante' })
const CANAUX = Object.freeze({ sms: 'sms_lines', email: 'email_lines' })
const ACTIF = Object.freeze({ sms: 'sms_enabled', email: 'email_enabled' })

// « Nom : valeur », une par ligne — la règle de lecture des listes
// (`parseLines`, lib/alert-notify.js) : un numéro de 7 à 15 chiffres, un e-mail
// de forme simple ; le reste est ignoré, comme il l'était à l'envoi.
function lireListe (texte, canal) {
  return String(texte || '').split('\n')
    .map(l => l.trim()).filter(Boolean)
    .map(l => {
      const sep = l.indexOf(':')
      if (sep > 0 && sep < l.length - 1) return { nom: l.slice(0, sep).trim(), valeur: l.slice(sep + 1).trim() }
      return { nom: '', valeur: l }
    })
    .filter(({ valeur }) => canal === 'sms'
      ? /^\+?[0-9]{7,15}$/.test(valeur.replace(/\s/g, ''))
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valeur))
}

const cleAdresse = (canal, valeur) => canal === 'email' ? `e:${cleEmail(valeur)}` : `t:${cleTelephone(valeur)}`

/**
 * Ce que délivrait la config d'UN compte : une ligne par (bien, alerte, canal,
 * adresse). Les biens sont des références provider (les clés de la config).
 */
function lignesDeLaConfig (config) {
  const lignes = []
  if (!config || typeof config !== 'object' || Array.isArray(config)) return lignes
  for (const [ref, parType] of Object.entries(config)) {
    if (!parType || typeof parType !== 'object' || Array.isArray(parType)) continue
    for (const [type, alerte] of Object.entries(TYPES)) {
      const a = parType[type]
      if (!a || typeof a !== 'object') continue
      for (const canal of Object.keys(CANAUX)) {
        if (!a[ACTIF[canal]] || !a[CANAUX[canal]]) continue
        for (const { nom, valeur } of lireListe(a[CANAUX[canal]], canal)) {
          const brute = canal === 'sms' ? valeur.replace(/\s/g, '') : valeur.trim()
          lignes.push({ ref: String(ref), alerte, canal, nom, valeur: brute, cle: cleAdresse(canal, brute) })
        }
      }
    }
  }
  return lignes
}

// Les réglages par défaut d'une personne sans ligne (reglages.js).
function defauts () {
  return require('./reglages').effectifs(null)
}

/**
 * Le plan de reprise d'UN compte. Pur : il ne lit ni n'écrit rien.
 * @param {object} p
 * @param {Array} p.lignes            lignesDeLaConfig(config)
 * @param {Map}   p.biensParRef       ref → properties.id (ou absent : bien inconnu)
 * @param {Array} [p.biensDuCompte]   les properties.id du compte (pour compter ce qui part EN PLUS)
 * @param {Set}   [p.ignores]         refs introuvables que l'humain a décidé d'ignorer (`--ignorer-bien=`)
 * @param {Array} p.personnes         [{ userId, titulaire, email, telephone, emailPermis, smsPermis,
 *                                    appareils, autresComptes }], le titulaire d'abord.
 *                                    `emailPermis` / `smsPermis` : ce que le titulaire a laissé
 *                                    ouvert sur le profil (destinataires.js) ; `appareils` : le
 *                                    nombre d'appareils abonnés (le SMS d'une personne ne part
 *                                    que sans appareil, Q11) ; `autresComptes` : la personne
 *                                    reçoit aussi les événements d'un autre compte
 * @param {Function} p.destinataire   (userId, code, bienId) → bool : la règle du point d'envoi
 * @param {Map}   p.reglages          userId → réglages EFFECTIFS ({ evenements })
 * @param {Array} [p.existants]       contacts déjà en base : [{ email, telephone, biens, alertes, desinscrit_le }]
 */
function planifier ({ lignes, biensParRef, biensDuCompte = [], ignores = new Set(), personnes, destinataire, reglages, existants = [] }) {
  const ignoresVus = new Set()
  const cocher = new Map() // userId → Set(code|canal)
  const parAdresse = new Map() // cle → { canal, valeur, nom, parBien: Map(bienId → Set(alerte)) }
  const avant = [] // { canal, cle, valeur, bienId, code }
  const pertes = []
  const effectif = (u) => reglages.get(u) || defauts()
  const porte = (p, cle) => (cleEmail(p.email) && cle === `e:${cleEmail(p.email)}`) ||
    (cleTelephone(p.telephone) && cle === `t:${cleTelephone(p.telephone)}`)
  // ⚠ COMME LE POINT D'ENVOI : le contact se tait dès qu'UNE personne
  // destinataire de l'événement porte l'adresse (notifier.js) — pas la
  // première personne qui la porte (constat 4 de la review de l'étape 2).
  const destinatairesA = (cle, code, bienId) => personnes.filter(p => porte(p, cle) && destinataire(p.userId, code, bienId))

  for (const l of lignes) {
    const bienId = biensParRef.get(l.ref)
    const codes = ALERTES[l.alerte]
    if (!bienId) {
      // ⚠ UN BIEN INTROUVABLE EST UNE PERTE (constat 5) : l'ancienne liste
      // n'avait pas besoin d'une ligne dans `properties`, un contact si. Seul un
      // humain peut décider qu'une clé est abandonnée (`--ignorer-bien=`).
      if (ignores.has(l.ref)) { ignoresVus.add(l.ref); continue }
      for (const code of codes) pertes.push({ canal: l.canal, cle: l.cle, valeur: l.valeur, bienId: null, ref: l.ref, code, motif: 'bien_introuvable' })
      continue
    }
    for (const code of codes) avant.push({ canal: l.canal, cle: l.cle, valeur: l.valeur, bienId, code })
    let auContact = false
    for (const code of codes) {
      const d = destinatairesA(l.cle, code, bienId)
      if (!d.length) { auContact = true; continue }
      // Une personne du compte reçoit cet événement à cette adresse : SES
      // réglages, et pas de contact — il se tairait (§16.3, Q29). On ne coche
      // que ce qui ne part pas déjà ; et jamais chez une personne qui reçoit
      // aussi un autre compte : ses réglages valent pour tous ses comptes, et
      // la liste d'un compte ne décide pas pour un autre (constat S1).
      if (d.some(p => effectif(p.userId).evenements[code][l.canal])) continue
      const p = d.find(x => !x.autresComptes)
      if (!p) continue // la vérification le dit : personne_sur_plusieurs_comptes
      if (!cocher.has(p.userId)) cocher.set(p.userId, new Set())
      cocher.get(p.userId).add(`${code}|${l.canal}`)
    }
    if (!auContact) continue
    if (!parAdresse.has(l.cle)) parAdresse.set(l.cle, { canal: l.canal, valeur: l.valeur, nom: '', parBien: new Map() })
    const x = parAdresse.get(l.cle)
    if (!x.nom && l.nom) x.nom = l.nom
    if (!x.parBien.has(bienId)) x.parBien.set(bienId, new Set())
    x.parBien.get(bienId).add(l.alerte)
  }

  // Un contact par adresse ET par ensemble d'alertes : une adresse en
  // « urgences » sur un bien et en « urgences + info » sur un autre fait deux
  // contacts — sinon le premier bien recevrait une alerte que sa liste
  // n'envoyait pas.
  const contacts = []
  for (const x of parAdresse.values()) {
    const parEnsemble = new Map()
    for (const [bienId, alertes] of x.parBien) {
      const k = [...alertes].sort().join(',')
      if (!parEnsemble.has(k)) parEnsemble.set(k, [])
      parEnsemble.get(k).push(bienId)
    }
    for (const [k, biens] of parEnsemble) {
      contacts.push({
        nom: x.nom || null,
        email: x.canal === 'email' ? x.valeur : null,
        telephone: x.canal === 'sms' ? x.valeur : null,
        alertes: k.split(','),
        biens: biens.sort()
      })
    }
  }

  // Ce qui existe déjà (un premier passage) ne se recrée pas. Et une adresse
  // qui s'est désinscrite (Q30) ne revient par aucun contact : « Ne plus
  // recevoir ces alertes » vaut pour l'adresse, pas pour une ligne de la table.
  const memeContact = (a, b) => (cleEmail(a.email) || null) === (cleEmail(b.email) || null) &&
    (cleTelephone(a.telephone) || null) === (cleTelephone(b.telephone) || null) &&
    [...(a.alertes || [])].sort().join() === [...(b.alertes || [])].sort().join() &&
    [...(a.biens || [])].map(String).sort().join() === [...(b.biens || [])].map(String).sort().join()
  const clesDe = (c) => [cleEmail(c.email) && `e:${cleEmail(c.email)}`, cleTelephone(c.telephone) && `t:${cleTelephone(c.telephone)}`].filter(Boolean)
  const partis = new Set(existants.filter(e => e.desinscrit_le).flatMap(clesDe))
  const neufs = contacts.filter(c => !existants.some(e => memeContact(c, e)))
  const aCreer = neufs.filter(c => !clesDe(c).some(k => partis.has(k)))
  const ecartes = neufs.length - aCreer.length

  // Les réglages après reprise : l'effectif de chaque événement repris, le
  // canal coché. ⚠ C'EST CETTE MAP QUI S'ÉCRIT, telle quelle (constat 1) : le
  // plan, la vérification et l'écriture lisent la même donnée.
  const apres = new Map()
  for (const p of personnes) {
    const ev = {}
    for (const code of Object.values(ALERTES).flat()) ev[code] = { ...effectif(p.userId).evenements[code] }
    for (const k of (cocher.get(p.userId) || [])) { const [code, canal] = k.split('|'); ev[code][canal] = true }
    apres.set(p.userId, ev)
  }

  // ⚠ LA VÉRIFICATION, AVEC LES RÈGLES DU POINT D'ENVOI : chaque (canal,
  // adresse, bien, événement) que délivrait une liste est-il encore délivré ?
  // Si une personne destinataire porte l'adresse, le point d'envoi fait taire
  // le contact (notifier.js) : seul ce qui part à ces personnes compte, et il
  // obéit à trois règles (envoi.js) — le canal coché ; ce que le titulaire a
  // laissé ouvert sur le profil ; et le SMS ne part que sans appareil abonné
  // (Q11), une notification cochée le remplaçant alors.
  const tous = [...existants.filter(e => !e.desinscrit_le), ...aCreer]
  const couvre = (c, a) => (a.canal === 'email' ? cleEmail(c.email) && `e:${cleEmail(c.email)}` === a.cle
    : cleTelephone(c.telephone) && `t:${cleTelephone(c.telephone)}` === a.cle) &&
    (c.biens || []).map(String).includes(String(a.bienId)) && (c.alertes || []).includes(alerteDe(a.code))
  const motifPour = (p, a) => {
    const r = apres.get(p.userId)[a.code]
    const avecAppareil = Number(p.appareils) > 0
    if (!r[a.canal]) return p.autresComptes ? 'personne_sur_plusieurs_comptes' : 'canal_non_coche'
    if (a.canal === 'email' && p.emailPermis === false) return 'email_coupe_sur_le_profil'
    if (a.canal === 'sms' && p.smsPermis === false) return 'sms_coupe_sur_le_profil'
    if (a.canal === 'sms' && avecAppareil && !r.push) return 'appareil_sans_notification'
    return null
  }
  let desinscrits = 0
  let parNotification = 0
  for (const a of avant) {
    const d = destinatairesA(a.cle, a.code, a.bienId)
    let motif = null
    if (d.length) {
      const motifs = d.map(p => motifPour(p, a))
      if (motifs.includes(null)) {
        const livreur = d[motifs.indexOf(null)]
        if (a.canal === 'sms' && Number(livreur.appareils) > 0) parNotification++
      } else motif = motifs[0]
    } else if (!tous.some(c => couvre(c, a))) {
      motif = 'aucun_contact'
    }
    if (!motif) continue
    // Une adresse qui s'est désinscrite elle-même (Q30) n'est pas une perte :
    // c'est son choix, et la reprise ne la réinscrit pas.
    if (motif === 'aucun_contact' && partis.has(a.cle)) { desinscrits++; continue }
    pertes.push({ ...a, motif })
  }

  // CE QUI PART EN PLUS, et ça se dit : les réglages d'une personne valent pour
  // tous les biens du compte, une liste valait pour un bien. Un canal coché
  // pour la liste de La bulle part aussi pour Cœur de vie 23.
  const livreAvant = new Set(avant.map(a => `${a.canal}|${a.cle}|${a.bienId}|${a.code}`))
  let enPlus = 0
  for (const [userId, cles] of cocher) {
    const p = personnes.find(x => x.userId === userId)
    for (const k of cles) {
      const [code, canal] = k.split('|')
      const cle = canal === 'email' ? `e:${cleEmail(p.email)}` : `t:${cleTelephone(p.telephone)}`
      for (const bienId of biensDuCompte) {
        if (destinataire(userId, code, bienId) && !livreAvant.has(`${canal}|${cle}|${bienId}|${code}`)) enPlus++
      }
    }
  }

  return {
    contacts: aCreer,
    dejaPresents: contacts.length - neufs.length,
    ecartes,
    parNotification,
    enPlus,
    cocher: new Map([...cocher].map(([u, s]) => [u, [...s].sort()])),
    reglagesApres: apres,
    ignores: [...ignoresVus].sort(),
    avant: avant.length,
    desinscrits,
    pertes
  }
}

// LA COUPURE, COMPTE PAR COMPTE : la config du compte, ses listes mises de côté
// (`listes_reprises`, gardées pour un retour arrière) et retirées de
// `intervention` / `info_unknown`. Tout émetteur, quelle que soit sa version,
// ne trouve plus de liste à servir : ni double envoi, ni trou, quel que soit
// l'ordre des déploiements (constats 6 et 7). Pur.
function mettreDeCote (config, le) {
  const sortie = {}
  for (const [ref, valeur] of Object.entries(config || {})) {
    if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur) || !Object.keys(TYPES).some(t => t in valeur)) {
      sortie[ref] = valeur
      continue
    }
    const { intervention, info_unknown: infoUnknown, ...reste } = valeur
    const listes = { le }
    if (intervention !== undefined) listes.intervention = intervention
    if (infoUnknown !== undefined) listes.info_unknown = infoUnknown
    sortie[ref] = { ...reste, listes_reprises: listes }
  }
  return sortie
}

// Une adresse lisible dans un compte rendu, sans l'exposer : la première
// lettre d'un e-mail (si la partie locale en a au moins trois) et son domaine ;
// les deux derniers chiffres d'un numéro (constat S2).
function masquer (canal, valeur) {
  const v = String(valeur || '')
  if (canal === 'email') {
    const at = v.lastIndexOf('@')
    const u = at > 0 ? v.slice(0, at) : ''
    const d = at > 0 ? v.slice(at + 1) : '?'
    return `${u.length >= 3 ? u[0] : ''}***@${d}`
  }
  const chiffres = v.replace(/\D/g, '')
  return chiffres.length >= 6 ? `****${chiffres.slice(-2)}` : '****'
}

module.exports = { REPRISE_OUVERTE, TYPES, lireListe, lignesDeLaConfig, planifier, mettreDeCote, masquer }
