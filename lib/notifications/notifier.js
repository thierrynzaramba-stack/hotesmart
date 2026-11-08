// lib/notifications/notifier.js — LE POINT D'ENVOI UNIQUE DES ÉVÉNEMENTS DE L'HÔTE.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §16.2 · KB : docs/kb/pwa.md §10
//
// Chaque émetteur (surréservation, urgence de l'IA, ménage refusé…) appelle
// `notifier` et rien d'autre. Pour chaque événement :
//   1. les destinataires — titulaire et membres selon leurs droits, relus à
//      l'envoi (destinataires.js) ;
//   2. pour chaque personne, SES réglages et SA décision : maintenant, ou à la
//      fin de ses heures calmes (decision.js) ;
//   3. maintenant → notification, e-mail, SMS sans appareil (envoi.js) ;
//      plus tard  → la file d'attente, déjà rédigée dans sa langue (file.js).
//
// ⚠ CE QUI VA AU FONDATEUR NE PASSE PAS ICI (`reportIncident`,
// `envoyerAlerteBrute`) : c'est de la supervision, pas une notification d'hôte.
//
// ⚠ NE LÈVE JAMAIS. Le bilan dit qui a été prévenu, comment, et ce qui a raté ;
// un bilan sans aucun destinataire joignable se dit aussi (`personne_joignable`).
const { decider } = require('./decision')
const { destinataires } = require('./destinataires')
const reglages = require('./reglages')
const textes = require('./textes')
const file = require('./file')
const { envoyerMaintenant } = require('./envoi')

function client () {
  return require('../cron-shared').supabase
}

/**
 * @param {object} p
 * @param {string} p.compte    le titulaire du compte (account_user_id)
 * @param {string} p.code      code du catalogue
 * @param {object} [p.bien]    { id?, ref? } — pour les droits et le journal des SMS
 * @param {object} [p.sejour]  { arrivee, depart } — la réservation concernée, lue dans le cœur
 * @param {object} p.donnees   ce que le texte de l'événement affiche (textes.js)
 * @param {string} p.chemin    l'écran ouvert au toucher (chemin du site)
 * @param {string} p.sujet     une notification sur le même sujet remplace la précédente
 * @param {boolean} [p.rappel] la relance sonne de nouveau (surréservation, §7)
 */
// `canauxPermis` : restreint les canaux quoi que disent les réglages (l'essai
// sur soi : la notification seule — ni e-mail plateforme ni SMS, qu'un appel
// répété ferait partir vers une adresse réécrite à volonté, constat de review).
async function notifier ({ compte, code, bien = null, sejour = null, donnees = {}, chemin, sujet, rappel = false,
  seulement = null, canauxPermis = null, maintenant = Date.now(), db = client(), deps = {} }) {
  const bilan = { ok: true, destinataires: 0, maintenant: 0, en_attente: 0, sans_canal: 0, push: 0, emails: 0, sms: 0,
    derniers_appareils: 0, personne_joignable: true, erreurs: [] }
  try {
    const d = await destinataires({ compte, code, bien, db })
    if (!d.ok) return { ...bilan, ok: false, erreurs: [d.motif] }
    // `seulement` : l'essai d'une personne sur elle-même (POST /api/push,
    // `essai_evenement`) ne doit prévenir AUCUN autre membre du compte.
    if (seulement) d.personnes = d.personnes.filter(p => p.userId === seulement)
    bilan.destinataires = d.personnes.length

    const r = await reglages.lirePlusieurs({ userIds: d.personnes.map(p => p.userId), db })
    // ⚠ DES RÉGLAGES ILLISIBLES NE RENDENT PERSONNE MUET : chacun retombe sur
    // les défauts (pas d'heures calmes, les canaux de Q23), et c'est noté.
    if (!r.ok) bilan.erreurs.push('reglages_illisibles')
    const parPersonne = r.ok ? r.parPersonne : new Map()

    let joignable = false
    for (const personne of d.personnes) {
      const eff = parPersonne.get(personne.userId) || reglages.effectifs(null)
      const langue = textes.langueDe(eff.langue)
      const texte = textes.rediger(code, langue, donnees)
      if (!texte) { bilan.erreurs.push('texte_absent'); continue }
      const decision = decider({ code, reglages: eff, instant: maintenant, sejour })
      const canaux = canauxPermis ? decision.canaux.filter(c => canauxPermis.includes(c)) : decision.canaux
      if (!canaux.length) { bilan.sans_canal++; continue }

      const contenu = { ...texte, chemin, sujet, rappel, langue }
      if (decision.moment === 'fin_de_plage') {
        // ⚠ RIEN DE LA PERSONNE N'EST RANGÉ AVEC LA LIGNE (ni e-mail ni
        // téléphone) : à la sortie, ses droits et ses coordonnées sont relus.
        const f = await file.enfiler({
          userId: personne.userId, compte, code, sujet, canaux, a: decision.a,
          contenu: { ...contenu, bienRef: (bien && bien.ref) || null },
          db
        })
        if (f.ok) { bilan.en_attente++; joignable = true; continue }
        // ⚠ LA FILE EN PANNE NE REND PERSONNE MUET (constat de review) : mieux
        // vaut une alerte pendant les heures calmes qu'une alerte perdue.
        bilan.erreurs.push(f.motif)
      }
      // Ce qui part maintenant remplace la ligne du même sujet qui attendait.
      if (sujet) {
        const ret = await file.retirer({ userId: personne.userId, sujet, db })
        if (!ret.ok) bilan.erreurs.push('file_non_nettoyee')
      }
      const e = await envoyerMaintenant({
        personne, canaux, contenu, compte, bienRef: (bien && bien.ref) || null, deps
      })
      bilan.maintenant++
      bilan.push += e.push
      if (e.email) bilan.emails++
      if (e.sms) bilan.sms++
      if (e.dernier_appareil) bilan.derniers_appareils++
      if (e.push || e.email || e.sms) joignable = true
      bilan.erreurs.push(...e.erreurs)
    }
    bilan.personne_joignable = joignable
  } catch (e) {
    bilan.ok = false
    bilan.erreurs.push('exception')
  }
  return bilan
}

module.exports = { notifier }
