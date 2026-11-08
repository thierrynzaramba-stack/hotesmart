// lib/notifications/envoi.js — FAIRE PARTIR UNE NOTIFICATION VERS UNE PERSONNE, MAINTENANT.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §6 et §16.2 · KB : docs/kb/pwa.md §10
//
// Trois canaux, trois clés :
//   - la NOTIFICATION sur ses appareils abonnés (lib/push/envoyer.js) ;
//   - l'E-MAIL par la clé PLATEFORME (lib/platform-notify.js) : le canal de
//     service, universel, sans coût unitaire (docs/kb/alertes.md §1) ;
//   - le SMS par la clé Brevo DU COMPTE (api/sms.js) : aucun SMS n'est payé par
//     HôteSmart (docs/kb/alertes.md, « Rappel »).
//
// ⚠ LA NOTIFICATION REMPLACE LE SMS (décision Q11) : une personne qui a au moins
// un appareil abonné ne reçoit JAMAIS de SMS, quel que soit l'événement. Si on ne
// PEUT PAS savoir (lecture en panne, clés d'envoi absentes), on la traite comme
// sans appareil : un SMS de trop vaut mieux qu'une surréservation manquée.
//
// ⚠ UNE NOTIFICATION QUI N'A ATTEINT AUCUN APPAREIL NE REMPLACE RIEN (constat
// de review) : si aucun appareil ne l'a reçue — 404/410, mais aussi 5xx, délai
// dépassé, 403 après un changement de clé —, la personne est traitée comme sans
// appareil, et le SMS coché part. Avant, un appareil en panne permanente
// faisait taire le SMS de la surréservation pour toujours.
//
// ⚠ LE DERNIER APPAREIL (décision Q13) : quand l'envoi trouve TOUS les appareils
// d'une personne morts (404 ou 410), elle n'en a plus aucun — elle est prévenue
// par e-mail, et le SMS coché part dès cet envoi-ci.
//
// ⚠ CE QUE LE TITULAIRE A COUPÉ SUR LE PROFIL D'UNE PERSONNE (`smsPermis`,
// `emailPermis`, destinataires.js) ne part pas, quels que soient ses réglages.
//
// ⚠ NE LÈVE JAMAIS : une notification ratée n'est pas une raison de faire
// échouer l'émetteur (un cycle du cron, un endpoint). Le bilan dit ce qui est parti.
const textes = require('./textes')

function depsParDefaut () {
  const envoyer = require('../push/envoyer')
  return {
    cles: envoyer.clesVapid(),
    envoyerPush: (o) => envoyer.envoyerAPersonne(o),
    compterAppareils: async ({ userId }) => {
      const r = await require('../push/abonnements').pourEnvoi({ userId })
      return r.ok ? { ok: true, n: r.abonnements.length } : { ok: false }
    },
    envoyerEmail: (...a) => require('../platform-notify').sendPlatformEmail(...a),
    envoyerSms: (...a) => require('../../api/sms').sendSms(...a)
  }
}

/**
 * @param {object} p
 * @param {object} p.personne  { userId, email, telephone, emailPermis?, smsPermis? }
 * @param {string[]} p.canaux  canaux cochés, parmi push, email, sms
 * @param {object} p.contenu   { titre, corps, chemin, sujet, rappel, langue }
 * @param {object} [p.contenus] un contenu PAR CANAL (le regroupé de fin de
 *                             plage : chaque canal ne porte que ses lignes)
 * @param {string} p.compte    le compte dont la clé Brevo envoie le SMS
 * @param {string} [p.bienRef] pour le journal des SMS
 */
// `courrielDernierAppareil` : faux quand l'appelant a EXCLU l'e-mail (l'essai sur
// soi). Sinon l'essai redevenait un relais d'e-mail par ce chemin-ci : abonner une
// adresse qui répond 410, essayer, recommencer (constat de SÉCURITÉ, seconde review).
async function envoyerMaintenant ({ personne, canaux, contenu, contenus = null, compte, bienRef = null,
  courrielDernierAppareil = true, deps = {} }) {
  const d = { ...depsParDefaut(), ...deps }
  const bilan = { push: 0, email: false, sms: false, dernier_appareil: false, erreurs: [] }
  const langue = textes.langueDe(contenu.langue)
  const pour = (canal) => (contenus && contenus[canal]) || contenu

  // 1. La notification — et ce qu'elle apprend des appareils de la personne.
  // Sans notification cochée pour cet événement, les appareils se COMPTENT quand
  // même : c'est leur existence, pas ce réglage, qui décide du SMS (Q11).
  let sansAppareil = true
  if (!canaux.includes('push') || !d.cles) {
    if (d.cles) {
      try {
        const c = await d.compterAppareils({ userId: personne.userId })
        sansAppareil = !(c && c.ok) || c.n === 0
      } catch (e) { bilan.erreurs.push('appareils_lecture_impossible') }
    }
  } else {
    let message = null
    const c = pour('push')
    try {
      message = require('../push/envoyer').messageDeclaratif({
        titre: c.titre, corps: c.corps, chemin: c.chemin,
        sujet: c.sujet || null, rappel: !!c.rappel, langue
      })
    } catch (e) { bilan.erreurs.push('message_illisible') }
    if (message) {
      try {
        const r = await d.envoyerPush({ userId: personne.userId, message, cles: d.cles })
        if (r && r.ok) {
          const total = r.envoyes + r.morts + r.echecs
          sansAppareil = r.aucun_appareil || r.envoyes === 0
          bilan.push = r.envoyes
          bilan.dernier_appareil = total > 0 && r.morts === total
          if (total > 0 && r.envoyes === 0 && !bilan.dernier_appareil) bilan.erreurs.push('push_non_livree')
        } else bilan.erreurs.push('push_lecture_impossible')
      } catch (e) { bilan.erreurs.push('push_echec') }
    }
  }

  // 2. Le dernier appareil vient de disparaître : la personne le sait par e-mail.
  if (bilan.dernier_appareil && courrielDernierAppareil && personne.email && personne.emailPermis !== false) {
    try {
      const m = textes.emailDernierAppareil({ langue })
      await d.envoyerEmail(personne.email, m.sujet, m.html)
    } catch (e) { bilan.erreurs.push('email_dernier_appareil_echec') }
  }

  // 3. L'e-mail.
  if (canaux.includes('email') && personne.email && personne.emailPermis !== false) {
    try {
      const c = pour('email')
      const m = textes.email({ langue, titre: c.titre, corps: c.corps, chemin: c.chemin })
      const r = await d.envoyerEmail(personne.email, m.sujet, m.html)
      bilan.email = !!(r && r.ok)
      if (!bilan.email) bilan.erreurs.push('email_echec')
    } catch (e) { bilan.erreurs.push('email_echec') }
  }

  // 4. Le SMS : seulement sans appareil abonné (Q11), par la clé du compte.
  if (canaux.includes('sms') && sansAppareil && personne.telephone && personne.smsPermis !== false) {
    try {
      const r = await d.envoyerSms(personne.telephone, textes.sms(pour('sms')), bienRef, 'notification', compte)
      bilan.sms = !!(r && r.success)
      if (!bilan.sms) bilan.erreurs.push('sms_echec')
    } catch (e) { bilan.erreurs.push('sms_echec') }
  }
  return bilan
}

module.exports = { envoyerMaintenant }
