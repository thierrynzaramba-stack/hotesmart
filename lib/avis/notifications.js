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

// ⚠ `echec_publication` EN FAIT PARTIE (constat de revue) : une publication
// echouee qui peut repartir attend l'hote autant qu'une evaluation a remplir.
const EN_ATTENTE = ['a_remplir', 'soumise_prestataire', 'a_valider', 'echec_publication']
// ⚠ 20 ENVOIS PAR PASSAGE, pas 200 (constat de revue) : chaque relance peut
// envoyer des SMS et des e-mails l'un apres l'autre, dans un cycle plafonne a
// 60 s. Le reliquat part au passage suivant, cinq minutes plus tard.
// ⚠ ET LE PLAFOND S'APPLIQUE APRES avoir ecarte ce qui est deja relance, pas a
// la lecture (constat de revue) : sinon vingt evaluations deja relancees
// bouchaient la fenetre, et la vingt-et-unieme n'etait jamais relancee.
const PLAFOND_RELANCES = 20
const PLAFOND_LECTURE = 500
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
// La date ET l'heure : une echeance a 2 h du matin ferme le jour meme.
const dateHeureFr = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const h = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
  return `${dateFr(iso)} à ${h.replace(':', ' h ')}`
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
    // ⚠ `pending`, JAMAIS `pending_validation` (constat de revue). La
    // messagerie affiche une tache `pending_validation` comme une REPONSE A
    // ENVOYER AU VOYAGEUR — zone de texte et bouton « Valider et envoyer » —
    // dans SA conversation : un hote aurait pu y ecrire son evaluation et
    // l'envoyer au voyageur. `pending` affiche le resume, « Ignorer / Traite ».
    status: 'pending',
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
      // ⚠ `nom` DEVIENT LE TITRE DU FIL dans la messagerie (constat de revue) :
      // le prenom de la prestataire faisait croire a une conversation avec elle.
      marqueur: marqueurPrestataire(e.booking_uid), nom: 'Évaluation du voyageur', summary, deps,
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
// `seulement` : une liste de sejours (scripts de preuve), pour ne jamais
// relancer une evaluation reelle par un test.
async function relancerEvaluations (sb, { maintenant = Date.now(), deps = {}, seulement = null } = {}) {
  const bilan = { lues: 0, relancees: 0, erreurs: 0 }
  try {
    const debut = new Date(maintenant).toISOString()
    const fin = new Date(maintenant + 5 * JOUR).toISOString()
    let requete = sb.from('guest_evaluations')
      .select('id, user_id, booking_uid, property_id_ref, status, deadline_at')
      .in('status', EN_ATTENTE)
      .gt('deadline_at', debut).lte('deadline_at', fin)
    if (Array.isArray(seulement)) requete = requete.in('booking_uid', seulement)
    const { data, error } = await requete
      .order('deadline_at', { ascending: true })
      .limit(PLAFOND_LECTURE)
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
    const aFaire = attendus.filter(a => !faits.has(`${a.e.user_id}|${a.marqueur}`)).slice(0, PLAFOND_RELANCES)
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
          + `à publier avant le ${dateHeureFr(e.deadline_at)}, ensuite la plateforme ne l’accepte plus. Ouvrez la page Avis.`
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

module.exports = { prevenirHote, relancerEvaluations, noterEtEnvoyer, dateHeureFr, marqueurPrestataire, marqueurRelance, EN_ATTENTE, PLAFOND_RELANCES, PLAFOND_LECTURE }
