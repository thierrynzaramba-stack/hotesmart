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
async function notifierAssignation ({ userId, providerId, propertyName, departureDate, lien }) {
  const bilan = { sms: false, email: false }
  if (!userId || !providerId) return bilan

  const { data: prof, error } = await supabase.from('profiles')
    .select('first_name, phone, email, active')
    .eq('id', providerId).eq('account_user_id', userId).maybeSingle()
  if (error || !prof || prof.active === false) return bilan

  const quand = jourLisible(departureDate)
  const ou = propertyName ? ` — ${propertyName}` : ''
  const texte = `Nouveau ménage vous est attribué : ${quand}${ou}.` +
                (lien ? ` Votre planning : ${lien}` : '')

  if (prof.phone) {
    try { await sendSms(prof.phone, texte, null, 'menage-assignation', userId); bilan.sms = true }
    catch (e) { console.error('[notifier-prestataire] sms echec:', e.message) }
  }
  if (prof.email) {
    try {
      await sendPlatformEmail(prof.email, `Ménage du ${quand}${ou}`,
        `<p>Bonjour ${prof.first_name || ''},</p><p>${texte}</p>`)
      bilan.email = true
    } catch (e) { console.error('[notifier-prestataire] email echec:', e.message) }
  }
  return bilan
}

module.exports = { notifierAssignation, jourLisible }
