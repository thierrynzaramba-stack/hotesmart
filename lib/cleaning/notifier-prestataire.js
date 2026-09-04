// lib/cleaning/notifier-prestataire.js
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// Prevenir une prestataire qu'un menage lui est attribue — ou propose.
//
// ⚠ POURQUOI CE MODULE EXISTE. L'assignation directe est le geste d'URGENCE de
// l'hote : il l'utilise a deux heures du depart, quand quelqu'un se decommande.
// Le menage apparait aussitot dans la PWA — mais personne ne regarde sa PWA
// toutes les cinq minutes. Sans notification, le geste d'urgence est muet, et le
// logement n'est pas prepare alors que l'hote croit l'avoir confie.
//
// ⚠ UNE PROPOSITION EST DANS LE MEME CAS, EN PIRE : elle a une ECHEANCE. Muette,
// elle expire sans que la personne ait jamais su qu'on lui demandait quelque
// chose — et le menage retombe sur sa porteuse, qui n'avait rien demande.
//
// ⚠ BEST-EFFORT, ET C'EST VOULU. L'ecriture est deja faite en base quand on
// arrive ici : un envoi qui echoue ne doit ni la defaire ni faire echouer la
// requete. La verite reste la base ; le SMS n'est qu'un rappel.

const { createClient } = require('@supabase/supabase-js')
const { sendSms } = require('../../api/sms')
const { sendPlatformEmail } = require('../platform-notify')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Le nom d'un bien vient du compte, pas d'un client — mais il finit dans un
// `innerHTML` d'email : un « & » ou un « < » y casserait le rendu.
function esc (t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function jourLisible (date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (!m) return String(date || '')
  // ⚠ En UTC : `departure_date` est une date de calendrier, pas un instant.
  // La lire en heure locale la decale d'un jour a l'ouest de Greenwich.
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'
  })
}

// L'echeance d'une proposition, telle qu'on la dit a quelqu'un.
//
// ⚠ EN HEURE DE PARIS, pas en UTC. `offer_expires_at` est un INSTANT : l'afficher
// en UTC annonce 16 h a quelqu'un qui a jusqu'a 18 h, et fait passer une
// proposition de fin de journee pour deja perdue.
function echeanceLisible (iso) {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return null
  return d.toLocaleString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Paris'
  })
}

// Le profil a prevenir, ou `null`.
//
// ⚠ `access_mode = 'lien'` ICI AUSSI. Ce module est une lib reutilisable : sa
// garde ne doit pas etre plus faible que celle de ses appelants.
async function profilNotifiable (userId, providerId) {
  const { data: prof, error } = await supabase.from('profiles')
    .select('first_name, phone, email, active, pwa_token')
    .eq('id', providerId).eq('account_user_id', userId).eq('access_mode', 'lien')
    .maybeSingle()
  if (error || !prof || prof.active === false) return null
  return prof
}

// L'envoi lui-meme. Rend `{ sms, email }` : ce qui est REELLEMENT parti, pour que
// l'appelant puisse le dire a l'hote plutot que de promettre.
//
// ⚠ NI `sendSms` NI `sendPlatformEmail` NE LEVENT.
// Cle Brevo absente, `brevo_enabled` a false, numero invalide, erreur Brevo :
// tout ressort en `{ success: false }` / `{ ok: false }`. Le `try/catch`
// n'attrapait donc RIEN, et le bilan valait `{ sms: !!phone, email: !!email }`
// quoi qu'il arrive — l'ecran affichait « Elle a ete prevenue » a un hote sans
// Brevo configure, qui croyait avoir confie son logement. C'est la promesse
// centrale de ce module : elle se verifie sur la VALEUR DE RETOUR.
async function envoyer (prof, { userId, propertyId, texte, sujet, etiquette }) {
  const bilan = { sms: false, email: false }
  if (prof.phone) {
    try {
      const r = await sendSms(prof.phone, texte, propertyId || null, etiquette, userId)
      bilan.sms = !!(r && r.success)
    } catch (e) { console.error('[notifier-prestataire] sms echec:', e.message) }
  }
  if (prof.email) {
    try {
      const r = await sendPlatformEmail(prof.email, sujet,
        `<p>Bonjour ${esc(prof.first_name || '')},</p><p>${esc(texte)}</p>`)
      bilan.email = !!(r && r.ok !== false)
    } catch (e) { console.error('[notifier-prestataire] email echec:', e.message) }
  }
  return bilan
}

// Le lien de la PWA, avec son jeton.
//
// ⚠ LE LIEN PORTE SON JETON. Sans `?token=`, la PWA affiche « Lien invalide »
// sur tout appareil qui ne l'a pas deja en localStorage — c'est-a-dire le
// telephone ou elle ouvre le SMS pour la premiere fois, ou le navigateur
// integre de l'app SMS. Le geste d'urgence serait alors muet, ce que ce module
// existe precisement pour empecher.
function lienAvecJeton (lien, prof) {
  return lien && prof.pwa_token ? `${lien}?token=${prof.pwa_token}` : null
}

// ⚠ Tiret SIMPLE partout, pas cadratin : « — » n'est pas dans GSM-7 et fait
// basculer TOUT le message en UCS-2, soit 67 caracteres par segment au lieu de
// 160. Mesure : 2 a 3 SMS par notification au lieu d'un, sur la cle Brevo de
// l'hote.
function suffixeBien (propertyName) {
  return propertyName ? ` - ${propertyName}` : ''
}

// UN MENAGE VIENT DE LUI ETRE ATTRIBUE (elle le porte, rien a confirmer).
async function notifierAssignation ({ userId, providerId, propertyName, propertyId, departureDate, lien }) {
  const bilan = { sms: false, email: false }
  if (!userId || !providerId) return bilan
  const prof = await profilNotifiable(userId, providerId)
  if (!prof) return bilan

  const quand = jourLisible(departureDate)
  const ou = suffixeBien(propertyName)
  const url = lienAvecJeton(lien, prof)
  const texte = `Nouveau menage vous est attribue : ${quand}${ou}.` +
                (url ? ` Votre planning : ${url}` : '')
  return envoyer(prof, { userId, propertyId, texte,
                         sujet: `Menage du ${quand}${ou}`, etiquette: 'menage-assignation' })
}

// UN MENAGE LUI EST PROPOSE : elle doit repondre, et avant une date.
//
// ⚠ L'ECHEANCE EST DANS LE MESSAGE. Une proposition sans terme annonce n'est pas
// une demande, c'est une information : on ne peut pas reprocher a quelqu'un de
// n'avoir pas repondu a temps a un delai qu'on ne lui a pas dit.
async function notifierProposition ({ userId, providerId, propertyName, propertyId,
                                      departureDate, expireLe, lien }) {
  const bilan = { sms: false, email: false }
  if (!userId || !providerId) return bilan
  const prof = await profilNotifiable(userId, providerId)
  if (!prof) return bilan

  const quand = jourLisible(departureDate)
  const ou = suffixeBien(propertyName)
  const url = lienAvecJeton(lien, prof)
  const avant = echeanceLisible(expireLe)
  const texte = `Menage a confirmer : ${quand}${ou}.` +
                (avant ? ` Repondez avant le ${avant}.` : '') +
                (url ? ` Repondre : ${url}` : '')
  return envoyer(prof, { userId, propertyId, texte,
                         sujet: `Menage a confirmer : ${quand}${ou}`,
                         etiquette: 'menage-proposition' })
}

module.exports = { notifierAssignation, notifierProposition, jourLisible, echeanceLisible }
