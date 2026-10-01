// lib/avis/notifications.js
//
// LOT 6 DU CHANTIER AVIS — prevenir l'hote et le relancer (spec §10).
//
//   1. `prevenirHote` : la prestataire a rempli sa part — « Regina a rempli
//      l'etat du logement, evaluez le voyageur ».
//   2. `relancerEvaluations` : J-5 et J-1 avant l'echeance de l'OTA, pour ce
//      qui attend encore l'hote.
//
// ⚠ LE MEME CANAL QUE `alertMenageRefuse` (lib/alert-notify.js) : une ligne
// dans les taches de l'hote (`agent_tasks`), qui RESTE, plus l'envoi SMS / e-mail
// qu'il a configure, qui peut se rater. Les deux, parce qu'un SMS non lu ne doit
// pas effacer l'information. Ce module n'ecrit PAS dans lib/alert-notify.js : il
// en utilise l'envoi, rien d'autre.
//
// ⚠ IDEMPOTENT PAR LE MARQUEUR DE LA TACHE, comme `alertMenageRefuse` :
// `guest_message` porte « [AUTO: avis …] » avec le sejour et le palier. Deux
// passages, deux onglets, deux cycles du cron ne font qu'une tache et qu'un envoi.
//
// ⚠ PAS DE BALAYAGE (spec §3) : les relances lisent `guest_evaluations` par
// `(status, deadline_at)`, dans une fenetre de cinq jours, plafonnee.
//
// ⚠ NE LEVE JAMAIS : une notification qui rate n'est pas une raison de faire
// echouer l'enregistrement d'une evaluation ni un cycle du cron.

const EN_ATTENTE = ['a_remplir', 'soumise_prestataire', 'a_valider']
const PLAFOND_RELANCES = 200
const JOUR = 86400000

const marqueurPrestataire = (bookingUid) => `[AUTO: avis rempli ${bookingUid}]`
const marqueurRelance = (palier, bookingUid) => `[AUTO: avis relance ${palier} ${bookingUid}]`

function envoyer () {
  // Paresseux : lib/alert-notify.js construit un client au chargement ; les
  // modules qui ne notifient jamais n'ont pas a le payer.
  return require('../alert-notify').sendAlertNotifications
}

const dateFr = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' })
}

// Une tache + un envoi, sauf si la tache existe deja. Rend true si elle a ete creee.
async function noterEtEnvoyer (sb, { userId, propertyRef, bookingUid, marqueur, nom, summary, deps = {} }) {
  const { data: deja, error } = await sb.from('agent_tasks')
    .select('id').eq('user_id', userId).eq('book_id', String(bookingUid))
    .eq('guest_message', marqueur).maybeSingle()
  if (error) { console.error('[avis] notification : taches illisibles', error.message); return false }
  if (deja) return false

  const { error: eIns } = await sb.from('agent_tasks').insert({
    user_id: userId,
    property_id: String(propertyRef),
    book_id: String(bookingUid),
    guest_name: nom || 'Évaluation',
    guest_message: marqueur,
    task_type: 'auto_message',
    summary,
    suggested_reply: '',
    status: 'pending_validation',
    sub_tasks: [],
  })
  if (eIns) { console.error('[avis] notification : tache non creee', eIns.message); return false }

  try {
    await (deps.envoyer || envoyer())({
      type: 'intervention',
      propertyId: String(propertyRef),
      task: { user_id: userId, arrival: null, departure: null, summary },
    })
  } catch (e) {
    console.error('[avis] notification : envoi best-effort echoue', e.message)
  }
  return true
}

/**
 * La prestataire a rempli sa part : l'hote est prevenu, une seule fois par sejour.
 * @returns {Promise<boolean>} true si une notification est partie
 */
async function prevenirHote (sb, { evaluation, prenomPrestataire, nomBien = null, deps = {} }) {
  try {
    const e = evaluation || {}
    if (!e.user_id || !e.booking_uid || !e.property_id_ref) return false
    const qui = prenomPrestataire || 'Votre prestataire'
    const ou = nomBien ? ` (${nomBien})` : ''
    const quand = e.deadline_at ? ` À publier avant le ${dateFr(e.deadline_at)}.` : ''
    const summary = `${qui} a rempli sa part de l’évaluation du voyageur${ou}. `
      + `Ouvrez la page Avis pour la compléter et la publier.${quand}`
    return await noterEtEnvoyer(sb, {
      userId: e.user_id, propertyRef: e.property_id_ref, bookingUid: e.booking_uid,
      marqueur: marqueurPrestataire(e.booking_uid), nom: qui, summary, deps,
    })
  } catch (err) {
    console.error('[avis] prevenirHote : exception', err.message)
    return false
  }
}

/**
 * Relances J-5 et J-1 avant l'echeance. Une requete bornee, puis une tache et un
 * envoi par evaluation et par palier, jamais deux.
 * @returns {Promise<{ lues: number, relancees: number, erreurs: number }>}
 */
async function relancerEvaluations (sb, { maintenant = Date.now(), deps = {} } = {}) {
  const bilan = { lues: 0, relancees: 0, erreurs: 0 }
  try {
    const debut = new Date(maintenant).toISOString()
    const fin = new Date(maintenant + 5 * JOUR).toISOString()
    const { data, error } = await sb.from('guest_evaluations')
      .select('id, user_id, booking_uid, property_id_ref, status, deadline_at')
      .in('status', EN_ATTENTE)
      .gt('deadline_at', debut).lte('deadline_at', fin)
      .order('deadline_at', { ascending: true })
      .limit(PLAFOND_RELANCES)
    if (error) { bilan.erreurs++; console.error('[avis] relances : lecture impossible', error.message); return bilan }
    bilan.lues = (data || []).length
    if (!bilan.lues) return bilan

    // ⚠ CE QUI EST DEJA RELANCE, EN UNE REQUETE POUR TOUT LE LOT. Le cron
    // passe toutes les cinq minutes : une lecture de taches par evaluation et par
    // passage aurait coute jusqu'a deux cents requetes pour ne rien faire.
    const attendus = data.map(e => {
      const palier = (Date.parse(e.deadline_at) - maintenant) <= JOUR ? 'J-1' : 'J-5'
      return { e, palier, marqueur: marqueurRelance(palier, e.booking_uid) }
    })
    const { data: deja, error: eDeja } = await sb.from('agent_tasks')
      .select('user_id, guest_message')
      .in('guest_message', attendus.map(a => a.marqueur))
    if (eDeja) { bilan.erreurs++; console.error('[avis] relances : taches illisibles', eDeja.message); return bilan }
    const faits = new Set((deja || []).map(t => `${t.user_id}|${t.guest_message}`))
    const aFaire = attendus.filter(a => !faits.has(`${a.e.user_id}|${a.marqueur}`))
    if (!aFaire.length) return bilan

    // Les noms des biens, en une requete pour tout le lot.
    const refs = [...new Set(data.map(e => String(e.property_id_ref)))]
    const { data: biens } = await sb.from('properties').select('user_id, provider_property_id, name')
      .in('provider_property_id', refs)
    const nomDe = new Map((biens || []).map(b => [`${b.user_id}|${b.provider_property_id}`, b.name]))

    for (const { e, palier } of aFaire) {
      const nomBien = nomDe.get(`${e.user_id}|${e.property_id_ref}`)
      const summary = palier === 'J-1'
        ? `Dernier jour pour évaluer le voyageur${nomBien ? ` (${nomBien})` : ''} : `
          + `après le ${dateFr(e.deadline_at)}, la plateforme ne l’accepte plus. Ouvrez la page Avis.`
        : `L’évaluation du voyageur${nomBien ? ` (${nomBien})` : ''} vous attend : `
          + `elle est à publier avant le ${dateFr(e.deadline_at)}. Ouvrez la page Avis.`
      try {
        const ok = await noterEtEnvoyer(sb, {
          userId: e.user_id, propertyRef: e.property_id_ref, bookingUid: e.booking_uid,
          marqueur: marqueurRelance(palier, e.booking_uid), nom: 'Évaluation', summary, deps,
        })
        if (ok) bilan.relancees++
      } catch (err) {
        bilan.erreurs++
        console.error('[avis] relance echouee', e.booking_uid, err.message)
      }
    }
  } catch (err) {
    bilan.erreurs++
    console.error('[avis] relances : exception', err.message)
  }
  return bilan
}

module.exports = { prevenirHote, relancerEvaluations, marqueurPrestataire, marqueurRelance, EN_ATTENTE }
