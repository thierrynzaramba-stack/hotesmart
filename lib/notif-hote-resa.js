// lib/notif-hote-resa.js
// DOC : docs/kb/guestflow.md (modif = MEME COMMIT)
// Spec : docs/specs/spec-canal-email-resa-directe.md
//
// « VOUS AVEZ UNE NOUVELLE RESERVATION » — l'e-mail a l'HOTE.
//
// Une reservation Airbnb ou Booking, l'hote l'apprend par la plateforme : elle
// lui ecrit, sa propre application le notifie. Une reservation DIRECTE, personne
// ne la lui annonce — ni le moteur, ni la saisie manuelle. Il devait ouvrir
// HoteSmart pour savoir qu'il avait vendu.
//
// ⚠ OFFLINE SEULEMENT, EN V1. Notifier aussi les OTA doublerait ce que les
// plateformes font deja : deux e-mails pour un meme fait, et on apprend a les
// ignorer tous les deux.
//
// ⚠ MEME CANAL HOST-OWNED QUE LE RESTE. La cle Brevo du compte proprietaire,
// son expediteur verifie. L'hote s'ecrit donc a lui-meme, sous son propre nom :
// c'est coherent, et surtout ca ne fait pas dependre une notification de sa
// vente d'une cle plateforme qu'il ne controle pas.
//
// ⚠ MAIS AVEC REPLI PLATEFORME, ET ICI IL VA DE SOI. Un hote qui n'a jamais
// connecte Brevo n'aurait JAMAIS ete prevenu de ses ventes directes — exactement
// le manque que cette fonction existe pour combler — pendant que le fondateur
// recevait un SMS a chaque vente. Constat de review, et les deux moities du
// defaut se tenaient : l'hote muet, l'alarme bruyante.
//
// Le chemin frere (la confirmation au voyageur, lib/email-voyageur.js) se replie
// deja sur la plateforme pour la meme cause, sur decision de Thierry du
// 17 septembre. Ici la question est encore plus simple : le destinataire est
// l'HOTE. La marque blanche protege l'illusion du voyageur, pas celle de
// quelqu'un qui sait parfaitement ce qu'est HoteSmart — une annonce de vente
// arrivee sous notre enseigne reste une annonce de vente arrivee.
//
// ⚠ DEDUP PAR `message_sent_log`, avec un identifiant de template SENTINELLE.
// La table porte un index unique `(user_id, booking_id, template_id)` et
// `template_id` n'a AUCUNE cle etrangere : un UUID constant y tient donc la
// place d'un template, et c'est la base qui garantit l'unicite — pas notre
// vigilance. Le dispatcher peut rejouer un evenement (echec d'un consommateur,
// reprise apres coupure) ; sans cette garde, l'hote recevrait deux fois la meme
// annonce.

// Le client du depot, pas un second : `lib/cron-shared.js` en expose un seul,
// et tout `lib/` s'en sert. En creer un ici doublait les connexions pour rien.
const { supabase } = require('./cron-shared')
const { envoyerHtml } = require('./email-guestflow')
const { sendPlatformEmail } = require('./platform-notify')

// UUID fixe, jamais present dans `message_templates` : il ne designe pas un
// template, il occupe la colonne pour que l'index unique fasse la dedup.
const SENTINELLE = '00000000-0000-4000-8000-000000000001'

const POLITIQUES = {
  non_remboursable: 'Non remboursable',
  j14: 'Annulation gratuite jusqu’à 14 jours avant l’arrivée',
  j7: 'Annulation gratuite jusqu’à 7 jours avant l’arrivée',
  flexible_j2: 'Annulation gratuite jusqu’à 2 jours avant l’arrivée'
}

function esc (v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const jourFr = d => {
  if (!d) return '—'
  const [a, m, j] = String(d).split('-')
  return (a && m && j) ? `${j}/${m}/${a}` : String(d)
}

function nuits (arrivee, depart) {
  if (!arrivee || !depart) return null
  const n = Math.round((new Date(depart) - new Date(arrivee)) / 86400000)
  return Number.isFinite(n) && n > 0 ? n : null
}

function ligne (libelle, valeur) {
  if (valeur == null || valeur === '') return ''
  return `<tr><td style="padding:7px 0;color:#6f6b65;font-size:13px;vertical-align:top">${esc(libelle)}</td>`
    + `<td style="padding:7px 0;text-align:right;font-size:13px"><strong>${esc(valeur)}</strong></td></tr>`
}

// ⚠ CE QUI MANQUE SE DIT, il ne se cache pas. Une reservation sans adresse
// signifie qu'aucun message automatique ne partira : l'hote doit l'apprendre
// ICI, au moment ou il peut encore appeler son voyageur — pas le jour de
// l'arrivee devant une porte fermee. C'est le pendant du badge sur la fiche.
function corps (r) {
  const n = nuits(r.arrival, r.departure)
  const voyageurs = [
    r.numAdult ? `${r.numAdult} adulte${r.numAdult > 1 ? 's' : ''}` : null,
    r.numChild ? `${r.numChild} enfant${r.numChild > 1 ? 's' : ''}` : null
  ].filter(Boolean).join(', ')

  const sansContact = !r.guestEmail
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;`
    + `max-width:560px;margin:0 auto;color:#1f1e1c;line-height:1.6;font-size:15px">`
    + `<h2 style="font-size:19px;font-weight:600;margin:0 0 4px">Nouvelle réservation</h2>`
    + `<p style="margin:0 0 18px;color:#6f6b65;font-size:14px">${esc(r.bien)}</p>`
    + `<table style="width:100%;border-collapse:collapse;border-top:1px solid #e6e4e0">`
    + ligne('Voyageur', [r.firstName, r.lastName].filter(Boolean).join(' ') || '—')
    + ligne('E-mail', r.guestEmail)
    + ligne('Téléphone', r.guestPhone)
    + ligne('Arrivée', jourFr(r.arrival))
    + ligne('Départ', jourFr(r.departure))
    + ligne('Nuits', n)
    + ligne('Voyageurs', voyageurs)
    + ligne('Prix payé', r.amount != null ? `${r.amount} ${r.currency || 'EUR'}` : null)
    + ligne('Conditions', POLITIQUES[r.politique] || r.politique)
    + ligne('Référence', r.reference)
    + `</table>`
    + (sansContact
        ? `<p style="margin-top:18px;padding:10px 12px;border-radius:8px;background:#fdf3e7;`
          + `border:1px solid #e8c9a0;font-size:13px;color:#7a4b12">`
          + `<strong>Pas d’adresse e-mail pour ce voyageur.</strong><br>`
          + `Aucun message automatique ne pourra lui être envoyé — ni confirmation, `
          + `ni consignes d’arrivée, ni code d’accès. Pensez à le contacter vous-même.</p>`
        : '')
    + `<p style="margin-top:22px;font-size:13px;color:#6f6b65">Réservation directe, `
      + `enregistrée dans HôteSmart.</p></div>`
}

const sujet = r => `Nouvelle réservation — ${r.bien} — `
  + `${jourFr(r.arrival)} au ${jourFr(r.departure)}`

// ─── Le destinataire ─────────────────────────────────────────────────────────
// ⚠ LE PROFIL PROPRIETAIRE, PAS UN MEMBRE DELEGUE. Une nouvelle vente s'annonce
// a qui possede le bien. Et `notify_email = false` est un refus explicite : on
// le respecte, meme si ce drapeau est ne pour les prestataires.
//
// Fail-CLOSED : une lecture en echec n'est PAS « pas de destinataire ». On rend
// l'erreur, l'appelant la signale, et personne ne croit que l'hote a ete prevenu.
async function destinataire (userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('email, notify_email, active')
    .eq('account_user_id', userId).eq('is_owner', true)
    .maybeSingle()
  if (error) return { ok: false, raison: `profil illisible : ${error.message}` }
  if (!data) return { ok: false, raison: 'aucun profil proprietaire' }
  if (data.active === false) return { ok: false, raison: 'profil proprietaire desactive' }
  if (data.notify_email === false) return { ok: false, raison: 'notifications e-mail refusees', choix: true }
  if (!data.email) return { ok: false, raison: 'profil proprietaire sans adresse' }
  return { ok: true, email: data.email }
}

// ─── L'envoi ─────────────────────────────────────────────────────────────────
// Rend { ok } | { ok:false, raison } | { ok:true, deja:true } | { ok:true, ignore:true }.
// Ne throw JAMAIS : le dispatcher a d'autres consommateurs a faire tourner, et
// une notification ratee ne doit pas emporter le menage ni le code d'acces.
async function notifierNouvelleResa ({ userId, bookingId, propertyId, bien, snapshot, politique }) {
  try {
    const s = snapshot || {}

    // Offline seulement : les OTA notifient deja.
    if (String(s.source || '').trim().toLowerCase() !== 'offline') {
      return { ok: true, ignore: true, raison: 'source non Offline' }
    }

    const qui = await destinataire(userId)
    if (!qui.ok) {
      // Un REFUS de l'hote n'est pas une panne : on n'alerte pas pour ca.
      if (qui.choix) return { ok: true, ignore: true, raison: qui.raison }
      return { ok: false, raison: qui.raison }
    }

    // ⚠ LA DEDUP AVANT L'ENVOI, et par la base. On pose la ligne d'abord : si
    // deux cycles se croisent, l'index unique en refuse une, et c'est celle-la
    // qui n'enverra pas. Poser apres laisserait la fenetre ouverte.
    //
    // Contrepartie assumee, INVERSE de celle du canal voyageur : un envoi rate
    // ne sera pas rejoue. C'est le bon compromis ici — cette notification vaut
    // pour l'instant ou elle arrive, et un doublon « nouvelle reservation »
    // inquiete plus qu'un manque, que l'ecran des reservations comble.
    const { error: eLog } = await supabase.from('message_sent_log').insert({
      user_id: userId, booking_id: String(bookingId), template_id: SENTINELLE
    })
    if (eLog) {
      if (eLog.code === '23505') return { ok: true, deja: true }
      return { ok: false, raison: `journal : ${eLog.message}` }
    }

    const r = {
      bien: bien || 'votre logement',
      firstName: s.firstName, lastName: s.lastName,
      guestEmail: s.guestEmail, guestPhone: s.guestPhone,
      arrival: s.arrival, departure: s.departure,
      numAdult: s.numAdult, numChild: s.numChild,
      amount: s.amount, currency: s.currency,
      politique, reference: s.otaReservationCode
    }

    const envoi = await envoyerHtml({
      userId, destinataire: qui.email, sujet: sujet(r), html: corps(r),
      propertyId, propertyName: bien
    })
    if (envoi.ok) return { ok: true, destinataire: qui.email, canal: 'hote' }

    // ─── Repli plateforme ────────────────────────────────────────────────────
    const repli = await sendPlatformEmail(qui.email, sujet(r), corps(r))
    if (repli && repli.ok !== false) {
      return { ok: true, destinataire: qui.email, canal: 'plateforme', raison: envoi.raison }
    }

    // ⚠ LES DEUX CANAUX MUETS. On retire la ligne de journal quand l'echec peut
    // ne pas se reproduire : un quota Brevo se retablit a minuit, et sans ce
    // geste la sentinelle condamnerait l'annonce pour toujours — y compris pour
    // un rattrapage a la main. `permanent` ne se rattrape pas, lui : on garde
    // alors la ligne, pour ne pas reessayer ce qui ne peut pas marcher.
    if (envoi.permanent !== true) {
      const { error: eDel } = await supabase.from('message_sent_log')
        .delete().eq('user_id', userId)
        .eq('booking_id', String(bookingId)).eq('template_id', SENTINELLE)
      if (eDel) console.error('[notif-hote] journal non retire', eDel.message)
    }
    return { ok: false, raison: `${envoi.raison} ; repli plateforme : `
      + `${(repli && repli.error) || 'echec'}`, permanent: envoi.permanent }
  } catch (e) {
    return { ok: false, raison: `exception : ${e.message}` }
  }
}

module.exports = { notifierNouvelleResa, SENTINELLE, corps, sujet, destinataire, POLITIQUES }
