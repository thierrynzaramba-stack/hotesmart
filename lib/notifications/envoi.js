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
// ⚠ LE DERNIER APPAREIL (décision Q13) : quand l'envoi trouve TOUS les appareils
// d'une personne morts (404 ou 410), elle n'en a plus aucun — elle est prévenue
// par e-mail, et le SMS coché part dès cet envoi-ci.
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
 * @param {object} p.personne  { userId, email, telephone }
 * @param {string[]} p.canaux  canaux cochés, parmi push, email, sms
 * @param {object} p.contenu   { titre, corps, chemin, sujet, rappel, langue }
 * @param {string} p.compte    le compte dont la clé Brevo envoie le SMS
 * @param {string} [p.bienRef] pour le journal des SMS
 */
async function envoyerMaintenant ({ personne, canaux, contenu, compte, bienRef = null, deps = {} }) {
  const d = { ...depsParDefaut(), ...deps }
  const bilan = { push: 0, email: false, sms: false, dernier_appareil: false, erreurs: [] }
  const langue = textes.langueDe(contenu.langue)

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
    try {
      message = require('../push/envoyer').messageDeclaratif({
        titre: contenu.titre, corps: contenu.corps, chemin: contenu.chemin,
        sujet: contenu.sujet || null, rappel: !!contenu.rappel, langue
      })
    } catch (e) { bilan.erreurs.push('message_illisible') }
    if (message) {
      try {
        const r = await d.envoyerPush({ userId: personne.userId, message, cles: d.cles })
        if (r && r.ok) {
          const total = r.envoyes + r.morts + r.echecs
          sansAppareil = r.aucun_appareil || (total > 0 && r.morts === total)
          bilan.push = r.envoyes
          bilan.dernier_appareil = total > 0 && r.morts === total
        } else bilan.erreurs.push('push_lecture_impossible')
      } catch (e) { bilan.erreurs.push('push_echec') }
    }
  }

  // 2. Le dernier appareil vient de disparaître : la personne le sait par e-mail.
  if (bilan.dernier_appareil && personne.email) {
    try {
      const m = textes.emailDernierAppareil({ langue })
      await d.envoyerEmail(personne.email, m.sujet, m.html)
    } catch (e) { bilan.erreurs.push('email_dernier_appareil_echec') }
  }

  // 3. L'e-mail.
  if (canaux.includes('email') && personne.email) {
    try {
      const m = textes.email({ langue, titre: contenu.titre, corps: contenu.corps, chemin: contenu.chemin })
      const r = await d.envoyerEmail(personne.email, m.sujet, m.html)
      bilan.email = !!(r && r.ok)
      if (!bilan.email) bilan.erreurs.push('email_echec')
    } catch (e) { bilan.erreurs.push('email_echec') }
  }

  // 4. Le SMS : seulement sans appareil abonné (Q11), par la clé du compte.
  if (canaux.includes('sms') && sansAppareil && personne.telephone) {
    try {
      const r = await d.envoyerSms(personne.telephone, textes.sms(contenu), bienRef, 'notification', compte)
      bilan.sms = !!(r && r.success)
      if (!bilan.sms) bilan.erreurs.push('sms_echec')
    } catch (e) { bilan.erreurs.push('sms_echec') }
  }
  return bilan
}

module.exports = { envoyerMaintenant }
