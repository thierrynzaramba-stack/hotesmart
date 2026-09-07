// lib/email-voyageur.js
// DOC : docs/kb/moteur-reservation.md §12 (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §6.4
//
// L'E-MAIL AU VOYAGEUR — trilingue, transactionnel.
//
// ⚠ CE MODULE NE CONNAIT PAS LE MOTEUR. Il recoit une reservation deja lue et
// rend un envoi. C'est voulu : la saisie manuelle (phase 2) et l'app avis en
// auront besoin, et un canal e-mail qui connaitrait le moteur ne se reutiliserait
// pas. Spec §2 : « Prevoir le canal email reutilisable par la saisie manuelle. »
//
// ⚠ LA LANGUE EST CELLE DE LA TENTATIVE, jamais celle du serveur. Un voyageur
// qui a reserve en espagnol lit sa confirmation en espagnol.
//
// ⚠ UN ECHEC D'ENVOI NE FAIT PAS ECHOUER LA RESERVATION. Elle existe chez le
// provider ; l'e-mail est un service rendu, pas une condition. On journalise et
// on rend `{ ok: false }` — l'appelant decide, et aucun appelant ne doit annuler
// une reservation parce qu'un e-mail n'est pas parti.

const { sendPlatformEmail } = require('./platform-notify')

const LANGUES = ['fr', 'es', 'en']
const langue = l => (LANGUES.includes(String(l || '').toLowerCase()) ? String(l).toLowerCase() : 'fr')

function esc (v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Les quatre politiques du §2, dites en clair au voyageur. Pas de jargon : il
// doit comprendre ce qui l'engage sans avoir a demander.
const POLITIQUES = {
  fr: {
    non_remboursable: 'Cette réservation n’est pas remboursable.',
    j14: 'Annulation gratuite jusqu’à 14 jours avant l’arrivée.',
    j7:  'Annulation gratuite jusqu’à 7 jours avant l’arrivée.',
    flexible_j2: 'Annulation gratuite jusqu’à 2 jours avant l’arrivée.'
  },
  es: {
    non_remboursable: 'Esta reserva no es reembolsable.',
    j14: 'Cancelación gratuita hasta 14 días antes de la llegada.',
    j7:  'Cancelación gratuita hasta 7 días antes de la llegada.',
    flexible_j2: 'Cancelación gratuita hasta 2 días antes de la llegada.'
  },
  en: {
    non_remboursable: 'This booking is non-refundable.',
    j14: 'Free cancellation up to 14 days before arrival.',
    j7:  'Free cancellation up to 7 days before arrival.',
    flexible_j2: 'Free cancellation up to 2 days before arrival.'
  }
}

const T = {
  fr: {
    sujet_ok: n => `Votre réservation à ${n} est confirmée`,
    titre_ok: 'Votre réservation est confirmée',
    bonjour: p => `Bonjour ${p},`,
    intro_ok: 'Nous avons le plaisir de vous confirmer votre séjour.',
    arrivee: 'Arrivée', depart: 'Départ', voyageurs: 'Voyageurs',
    nuits: 'Nuits', total: 'Total payé', reference: 'Référence',
    conditions: 'Conditions d’annulation', contact: 'Contact',
    pied: 'À très bientôt.',
    sujet_remb: n => `Votre réservation à ${n} n’a pas pu être confirmée`,
    titre_remb: 'Réservation non confirmée — vous êtes remboursé',
    intro_remb: 'Nous n’avons pas pu confirmer votre séjour, et votre paiement '
      + 'vous a été intégralement remboursé. Le remboursement apparaît sur votre '
      + 'compte sous quelques jours, selon votre banque. Nous en sommes désolés.'
  },
  es: {
    sujet_ok: n => `Su reserva en ${n} está confirmada`,
    titre_ok: 'Su reserva está confirmada',
    bonjour: p => `Hola ${p}:`,
    intro_ok: 'Nos complace confirmarle su estancia.',
    arrivee: 'Llegada', depart: 'Salida', voyageurs: 'Huéspedes',
    nuits: 'Noches', total: 'Total pagado', reference: 'Referencia',
    conditions: 'Condiciones de cancelación', contact: 'Contacto',
    pied: 'Hasta pronto.',
    sujet_remb: n => `Su reserva en ${n} no ha podido confirmarse`,
    titre_remb: 'Reserva no confirmada — reembolso efectuado',
    intro_remb: 'No hemos podido confirmar su estancia y le hemos reembolsado '
      + 'íntegramente. El reembolso aparecerá en su cuenta en unos días, según su '
      + 'banco. Lo sentimos mucho.'
  },
  en: {
    sujet_ok: n => `Your booking at ${n} is confirmed`,
    titre_ok: 'Your booking is confirmed',
    bonjour: p => `Hello ${p},`,
    intro_ok: 'We are pleased to confirm your stay.',
    arrivee: 'Arrival', depart: 'Departure', voyageurs: 'Guests',
    nuits: 'Nights', total: 'Total paid', reference: 'Reference',
    conditions: 'Cancellation policy', contact: 'Contact',
    pied: 'See you soon.',
    sujet_remb: n => `Your booking at ${n} could not be confirmed`,
    titre_remb: 'Booking not confirmed — you have been refunded',
    intro_remb: 'We were unable to confirm your stay, and your payment has been '
      + 'refunded in full. The refund will appear on your account within a few '
      + 'days, depending on your bank. We are sorry for the inconvenience.'
  }
}

function ligne (libelle, valeur) {
  return `<tr><td style="padding:6px 0;color:#6f6b65;font-size:13px">${esc(libelle)}</td>`
    + `<td style="padding:6px 0;text-align:right;font-size:13px"><strong>${esc(valeur)}</strong></td></tr>`
}

// ⚠ MARQUE BLANCHE. Le seul nom qui apparait est celui du BIEN. Aucun logo, aucune
// mention HoteSmart : pour le voyageur, cet e-mail vient de son hote.
function enveloppe (titre, corps) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;`
    + `max-width:560px;margin:0 auto;color:#1f1e1c;line-height:1.6">`
    + `<h2 style="font-size:19px;font-weight:600;margin:0 0 18px">${esc(titre)}</h2>`
    + corps + `</div>`
}

function corpsConfirmation (r, t) {
  const pol = POLITIQUES[r.lang] || POLITIQUES.fr
  return `<p>${esc(t.bonjour(r.prenom))}</p><p>${esc(t.intro_ok)}</p>`
    + `<h3 style="font-size:15px;font-weight:600;margin:22px 0 8px">${esc(r.bien)}</h3>`
    + `<table style="width:100%;border-collapse:collapse;border-top:1px solid #e6e4e0">`
    + ligne(t.arrivee, r.arrivee + (r.heure_arrivee ? ` · ${r.heure_arrivee}` : ''))
    + ligne(t.depart, r.depart + (r.heure_depart ? ` · ${r.heure_depart}` : ''))
    + ligne(t.nuits, r.nuits)
    + ligne(t.voyageurs, r.voyageurs)
    + ligne(t.total, r.total)
    + (r.reference ? ligne(t.reference, r.reference) : '')
    + `</table>`
    + (r.adresse ? `<p style="font-size:13px;color:#6f6b65;margin-top:16px">${esc(r.adresse)}</p>` : '')
    + `<p style="font-size:13px;margin-top:18px"><strong>${esc(t.conditions)}</strong><br>`
    + `${esc(pol[r.politique] || pol.non_remboursable)}</p>`
    + (r.telephone_hote
        ? `<p style="font-size:13px"><strong>${esc(t.contact)}</strong><br>${esc(r.telephone_hote)}</p>` : '')
    + `<p style="margin-top:22px">${esc(t.pied)}</p>`
}

function corpsRemboursement (r, t) {
  return `<p>${esc(t.bonjour(r.prenom))}</p><p>${esc(t.intro_remb)}</p>`
    + `<h3 style="font-size:15px;font-weight:600;margin:22px 0 8px">${esc(r.bien)}</h3>`
    + `<table style="width:100%;border-collapse:collapse;border-top:1px solid #e6e4e0">`
    + ligne(t.arrivee, r.arrivee) + ligne(t.depart, r.depart) + ligne(t.total, r.total)
    + `</table>`
    + (r.telephone_hote
        ? `<p style="font-size:13px;margin-top:18px"><strong>${esc(t.contact)}</strong><br>${esc(r.telephone_hote)}</p>` : '')
}

async function envoyer (r, sorte) {
  const l = langue(r.lang)
  const t = T[l]
  const resa = { ...r, lang: l }
  const confirmation = sorte !== 'remboursement'
  const sujet = confirmation ? t.sujet_ok(r.bien) : t.sujet_remb(r.bien)
  const html = enveloppe(confirmation ? t.titre_ok : t.titre_remb,
    confirmation ? corpsConfirmation(resa, t) : corpsRemboursement(resa, t))

  try {
    const envoi = await sendPlatformEmail(r.email, sujet, html)
    if (!envoi || envoi.ok === false) {
      console.error('[email-voyageur] envoi refuse', sorte, envoi && envoi.error)
      return { ok: false, raison: (envoi && envoi.error) || 'envoi_refuse' }
    }
    return { ok: true }
  } catch (e) {
    // Ne remonte JAMAIS : la reservation existe, l'e-mail est un service rendu.
    console.error('[email-voyageur] envoi echec', sorte, e.message)
    return { ok: false, raison: e.message }
  }
}

const envoyerConfirmation = r => envoyer(r, 'confirmation')
const envoyerRemboursement = r => envoyer(r, 'remboursement')

module.exports = { T, POLITIQUES, LANGUES, envoyerConfirmation, envoyerRemboursement }
