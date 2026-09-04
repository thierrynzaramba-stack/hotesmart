// lib/cleaning/notifier-prestataire.js
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// Prevenir une prestataire qu'un menage vient de lui etre attribue.
//
// ⚠ POURQUOI CE MODULE EXISTE. L'assignation directe est le geste d'URGENCE de
// l'hote : il l'utilise a deux heures du depart, quand quelqu'un se decommande.
// Le menage apparait aussitot dans la PWA — mais personne ne regarde sa PWA
// toutes les cinq minutes. Sans notification, le geste d'urgence est muet, et le
// logement n'est pas prepare alors que l'hote croit l'avoir confie.
//
// ⚠ BEST-EFFORT, ET C'EST VOULU. L'assignation est deja ecrite en base quand on
// arrive ici : un envoi qui echoue ne doit pas defaire l'affectation ni faire
// echouer la requete. La verite reste la base ; le SMS n'est qu'un rappel.

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

// Rend `{ sms, email }` : ce qui est REELLEMENT parti, pour que l'appelant
// puisse le dire a l'hote plutot que de promettre.
async function notifierAssignation ({ userId, providerId, propertyName, propertyId, departureDate, lien }) {
  const bilan = { sms: false, email: false }
  if (!userId || !providerId) return bilan

  // ⚠ `access_mode = 'lien'` ici AUSSI. Ce module est une lib reutilisable : sa
  // garde ne doit pas etre plus faible que celle de son seul appelant actuel.
  const { data: prof, error } = await supabase.from('profiles')
    .select('first_name, phone, email, active, pwa_token')
    .eq('id', providerId).eq('account_user_id', userId).eq('access_mode', 'lien')
    .maybeSingle()
  if (error || !prof || prof.active === false) return bilan

  const quand = jourLisible(departureDate)
  // ⚠ Tiret SIMPLE, pas cadratin : « — » n'est pas dans GSM-7 et fait basculer
  // TOUT le message en UCS-2, soit 67 caracteres par segment au lieu de 160.
  // Mesure : 2 a 3 SMS par notification au lieu d'un, sur la cle Brevo de l'hote.
  const ou = propertyName ? ` - ${propertyName}` : ''
  // ⚠ LE LIEN PORTE SON JETON. Sans `?token=`, la PWA affiche « Lien invalide »
  // sur tout appareil qui ne l'a pas deja en localStorage — c'est-a-dire le
  // telephone ou elle ouvre le SMS pour la premiere fois, ou le navigateur
  // integre de l'app SMS. Le geste d'urgence serait alors muet, ce que ce module
  // existe precisement pour empecher.
  const url = lien && prof.pwa_token ? `${lien}?token=${prof.pwa_token}` : null
  const texte = `Nouveau menage vous est attribue : ${quand}${ou}.` +
                (url ? ` Votre planning : ${url}` : '')

  // ⚠ NI `sendSms` NI `sendPlatformEmail` NE LEVENT.
  // Cle Brevo absente, `brevo_enabled` a false, numero invalide, erreur Brevo :
  // tout ressort en `{ success: false }` / `{ ok: false }`. Le `try/catch`
  // n'attrapait donc RIEN, et le bilan valait `{ sms: !!phone, email: !!email }`
  // quoi qu'il arrive — l'ecran affichait « Elle a ete prevenue » a un hote sans
  // Brevo configure, qui croyait avoir confie son logement. C'est la promesse
  // centrale de ce module : elle se verifie sur la VALEUR DE RETOUR.
  if (prof.phone) {
    try {
      const r = await sendSms(prof.phone, texte, propertyId || null, 'menage-assignation', userId)
      bilan.sms = !!(r && r.success)
    } catch (e) { console.error('[notifier-prestataire] sms echec:', e.message) }
  }
  if (prof.email) {
    try {
      const r = await sendPlatformEmail(prof.email, `Menage du ${quand}${ou}`,
        `<p>Bonjour ${esc(prof.first_name || '')},</p><p>${esc(texte)}</p>`)
      bilan.email = !!(r && r.ok !== false)
    } catch (e) { console.error('[notifier-prestataire] email echec:', e.message) }
  }
  return bilan
}

module.exports = { notifierAssignation, jourLisible }
