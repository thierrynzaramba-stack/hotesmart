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
// point d'envoi après la reprise. Une perte bloque l'écriture du compte.
//
// ⚠ CE QUE LES LISTES N'ENVOYAIENT PAS NE SE REPREND PAS : une liste dont le
// canal est décoché (`sms_enabled` ou `email_enabled` faux) n'envoyait rien —
// elle ne devient rien. La règle est celle de `sendAlertNotifications`.

const { ALERTES, alerteDe, cleEmail, cleTelephone } = require('./contacts')

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

/**
 * Le plan de reprise d'UN compte. Pur : il ne lit ni n'écrit rien.
 * @param {object} p
 * @param {Array} p.lignes            lignesDeLaConfig(config)
 * @param {Map}   p.biensParRef       ref → properties.id (ou absent : bien inconnu)
 * @param {Array} p.personnes         [{ userId, titulaire, email, telephone, emailPermis, smsPermis, appareils }]
 *                                    — `emailPermis` / `smsPermis` : ce que le titulaire a laissé
 *                                    ouvert sur le profil (destinataires.js) ; `appareils` : le
 *                                    nombre d'appareils abonnés (le SMS d'une personne ne part
 *                                    que sans appareil, Q11)
 * @param {Function} p.destinataire   (userId, code, bienId) → bool : ses droits couvrent-ils l'événement ?
 * @param {Map}   p.reglages          userId → réglages EFFECTIFS ({ evenements })
 * @param {Array} [p.existants]       contacts déjà en base : [{ email, telephone, biens, alertes, desinscrit_le }]
 */
function planifier ({ lignes, biensParRef, personnes, destinataire, reglages, existants = [] }) {
  const inconnus = new Set()
  const cocher = new Map() // userId → Set(code|canal)
  const parAdresse = new Map() // cle → { canal, valeur, nom, parBien: Map(bienId → Set(alerte)) }
  const avant = [] // { canal, cle, valeur, bienId, code }
  const personneDe = (cle) => personnes.find(p => (cleEmail(p.email) && cle === `e:${cleEmail(p.email)}`) ||
    (cleTelephone(p.telephone) && cle === `t:${cleTelephone(p.telephone)}`)) || null

  for (const l of lignes) {
    const bienId = biensParRef.get(l.ref)
    if (!bienId) { inconnus.add(l.ref); continue }
    const codes = ALERTES[l.alerte]
    for (const code of codes) avant.push({ canal: l.canal, cle: l.cle, valeur: l.valeur, bienId, code })
    const p = personneDe(l.cle)
    let resteAuContact = codes
    if (p) {
      // Ce que ses droits couvrent sur ce bien passe par SES réglages — titulaire
      // ou membre, la même règle ; le reste, par un contact (Q29). Un canal ne
      // se coche que pour un événement qu'il reçoit : cocher ce que ses droits
      // ne couvrent pas changerait ses réglages pour rien.
      const couverts = codes.filter(code => destinataire(p.userId, code, bienId))
      if (couverts.length && !cocher.has(p.userId)) cocher.set(p.userId, new Set())
      for (const code of couverts) cocher.get(p.userId).add(`${code}|${l.canal}`)
      resteAuContact = codes.filter(code => !couverts.includes(code))
    }
    if (!resteAuContact.length) continue
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
  const aCreer = contacts.filter(c => !existants.some(e => memeContact(c, e)) && !clesDe(c).some(k => partis.has(k)))
  const ecartes = contacts.filter(c => !existants.some(e => memeContact(c, e)) && clesDe(c).some(k => partis.has(k))).length

  // Les réglages après reprise : le canal coché, événement par événement.
  const apres = new Map()
  for (const p of personnes) {
    const eff = reglages.get(p.userId) || { evenements: {} }
    const ev = {}
    for (const code of Object.values(ALERTES).flat()) ev[code] = { ...((eff.evenements || {})[code] || {}) }
    for (const k of (cocher.get(p.userId) || [])) { const [code, canal] = k.split('|'); ev[code][canal] = true }
    apres.set(p.userId, ev)
  }

  // ⚠ LA VÉRIFICATION, AVEC LES RÈGLES DU POINT D'ENVOI : chaque (canal,
  // adresse, bien, événement) que délivrait une liste est-il encore délivré ?
  // Pour une PERSONNE destinataire, le point d'envoi fait taire le contact
  // (notifier.js) : seul ce qui lui part compte, et il obéit à trois règles
  // (envoi.js) — le canal coché ; ce que le titulaire a laissé ouvert sur son
  // profil ; et le SMS ne part que sans appareil abonné (Q11), une notification
  // cochée le remplaçant alors. Une seule de ces règles oubliée, et la
  // vérification dirait « rien de perdu » là où plus rien ne part.
  const tous = [...existants.filter(e => !e.desinscrit_le), ...aCreer]
  const couvre = (c, a) => (a.canal === 'email' ? cleEmail(c.email) && `e:${cleEmail(c.email)}` === a.cle
    : cleTelephone(c.telephone) && `t:${cleTelephone(c.telephone)}` === a.cle) &&
    (c.biens || []).map(String).includes(String(a.bienId)) && (c.alertes || []).includes(alerteDe(a.code))
  const pertes = []
  let desinscrits = 0
  let parNotification = 0
  for (const a of avant) {
    const p = personneDe(a.cle)
    const estDestinataire = p && destinataire(p.userId, a.code, a.bienId)
    let motif = null
    if (estDestinataire) {
      const r = apres.get(p.userId)[a.code] || {}
      const avecAppareil = Number(p.appareils) > 0
      if (!r[a.canal]) motif = 'canal_non_coche'
      else if (a.canal === 'email' && p.emailPermis === false) motif = 'email_coupe_sur_le_profil'
      else if (a.canal === 'sms' && p.smsPermis === false) motif = 'sms_coupe_sur_le_profil'
      else if (a.canal === 'sms' && avecAppareil && !r.push) motif = 'appareil_sans_notification'
      else if (a.canal === 'sms' && avecAppareil) parNotification++
    } else if (!tous.some(c => couvre(c, a))) {
      motif = 'aucun_contact'
    }
    if (!motif) continue
    // Une adresse qui s'est désinscrite elle-même (Q30) n'est pas une perte :
    // c'est son choix, et la reprise ne la réinscrit pas.
    if (motif === 'aucun_contact' && partis.has(a.cle)) { desinscrits++; continue }
    pertes.push({ ...a, motif })
  }

  return {
    contacts: aCreer,
    dejaPresents: contacts.length - aCreer.length - ecartes,
    ecartes,
    parNotification,
    cocher: new Map([...cocher].map(([u, s]) => [u, [...s].sort()])),
    reglagesApres: apres,
    inconnus: [...inconnus].sort(),
    avant: avant.length,
    desinscrits,
    pertes
  }
}

// Une adresse lisible dans un compte rendu, sans l'exposer : « j***@exemple.fr »,
// « +336****5678 ».
function masquer (canal, valeur) {
  const v = String(valeur || '')
  if (canal === 'email') {
    const [u, d] = v.split('@')
    return `${(u || '').slice(0, 1)}***@${d || '?'}`
  }
  return v.length > 8 ? `${v.slice(0, 4)}****${v.slice(-4)}` : '****'
}

module.exports = { TYPES, lireListe, lignesDeLaConfig, planifier, masquer }
