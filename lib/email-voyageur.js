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

// ⚠ LE CANAL DE L'HOTE D'ABORD. Ce module partait par `sendPlatformEmail`, donc
// sous « HoteSmart <alertes@hotesmart.fr> » : le CORPS etait en marque blanche
// (seul le nom du bien y figure), l'ENVELOPPE non. Le voyageur qui vient de payer
// chez un hote recevait sa confirmation d'un tiers dont il n'a jamais entendu
// parler — le meilleur moyen de finir en indesirable, et de faire douter d'un
// paiement qui vient d'aboutir.
const { envoyerHtml } = require('./email-guestflow')
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
//
// ⚠ NOM EXPLICITE, PARCE QU'IL Y EN A DEUX. `lib/email-guestflow.js` exporte une
// `enveloppe()` generique (celle des messages de parcours) et ce module le
// require depuis l'etape 5 : deux fonctions du meme nom dans deux modules qui se
// connaissent, c'est une ambiguite pour le lecteur — et
// `tests/imports-manquants.test.js` s'y est trompe le premier. Celle-ci porte un
// titre en tete ; l'autre non.
function enveloppeConfirmation (titre, corps) {
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

// ⚠ CETTE ALERTE VA AU FONDATEUR, PAS A L'HOTE — et c'est une limite connue.
// `reportIncident` ecrit dans `automation_incidents` puis notifie FOUNDER_EMAIL /
// FOUNDER_PHONE. Aucun ecran ne sert cette table a l'hote : il n'apprendra donc
// rien par lui-meme. Le commentaire de ce module et la doc affirmaient le
// contraire — un filet documente qui n'existait pas, ce qui est pire que pas de
// filet du tout, parce qu'on cesse de le chercher.
//
// DETTE : tant que l'hote n'a pas d'ecran d'incidents, c'est Thierry qui doit le
// prevenir. Voir docs/kb/moteur-reservation.md §12.
//
// ⚠ LA CONSIGNE SUIT LA CAUSE. Conseiller « reglez votre compte Brevo » sur une
// panne Supabase transitoire, ou sur une adresse de voyageur manquante, c'est
// envoyer quelqu'un reparer ce qui n'est pas casse — du bruit, sur une alerte a
// seuil 1.
async function prevenirDuRepli (r, issue, raison) {
  const quota = /brevo_(429|402)/.test(String(raison || ''))
  // Le quota a deja son signalement propre (`signalerSiPanneFacturation`, dans
  // lib/email-guestflow.js) : un second incident pour le meme fait est du bruit.
  if (quota && issue === 'repli') return

  const consigne = /brevo_non_configure|aucun_expediteur_verifie|brevo_desactive/.test(String(raison || ''))
    ? 'Reglez votre compte Brevo et votre adresse d\'expedition dans Connexions — '
      + 'vos voyageurs verront alors votre nom.'
    : /destinataire_manquant/.test(String(raison || ''))
      ? 'Cette reservation n\'a pas d\'adresse de voyageur : rien ne peut lui etre envoye.'
      : 'Panne temporaire du canal d\'envoi — rien a regler, mais a surveiller si ca se repete.'

  const quoi = issue === 'repli'
    ? 'La confirmation est PARTIE, mais sous l\'identite HoteSmart et non la votre.'
    : issue === 'incertain'
      ? 'La confirmation a PEUT-ETRE ete envoyee : la connexion a ete coupee en cours d\'appel. '
        + 'Nous n\'avons PAS renvoye, pour ne pas risquer une seconde confirmation. A verifier.'
      : 'La confirmation N\'EST PAS PARTIE, ni sous votre identite ni sous la notre. '
        + 'Le voyageur a paye et n\'a rien recu — a traiter a la main.'

  try {
    const { reportIncident } = require('./founder-notify')
    await reportIncident('email_confirmation_repli', {
      userId: r.userId, propertyId: r.propertyId != null ? String(r.propertyId) : null,
      propertyName: r.bien, threshold: 1,
      detail: `${quoi} Cause : ${raison}. ${consigne}`
    })
  } catch (e) { console.error('[email-voyageur] incident non enregistre', e.message) }
}

async function envoyer (r, sorte) {
  const l = langue(r.lang)
  const t = T[l]
  const resa = { ...r, lang: l }
  const confirmation = sorte !== 'remboursement'
  const sujet = confirmation ? t.sujet_ok(r.bien) : t.sujet_remb(r.bien)
  const html = enveloppeConfirmation(confirmation ? t.titre_ok : t.titre_remb,
    confirmation ? corpsConfirmation(resa, t) : corpsRemboursement(resa, t))

  let echecHote = null

  // ─── 1. Le canal de l'hote ─────────────────────────────────────────────────
  // ⚠ SON PROPRE try/catch, ET C'EST TOUT LE POINT. Sous un `try` commun avec le
  // repli, une exception du canal hote (lecture Supabase en panne pendant le
  // webhook Stripe) sautait directement au catch final : le repli n'etait JAMAIS
  // tente, et le voyageur qui vient de payer ne recevait rien — alors qu'avant ce
  // chantier, la plateforme envoyait. On aurait casse l'invariant que cette
  // etape pretend defendre. Constat de review.
  if (r.userId) {
    try {
      const envoi = await envoyerHtml({
        userId: r.userId, destinataire: r.email, sujet, html,
        propertyId: r.propertyId, propertyName: r.bien
      })
      if (envoi.ok) return { ok: true, canal: 'hote' }
      echecHote = envoi
    } catch (e) {
      console.error('[email-voyageur] canal hote en exception', e.message)
      echecHote = { raison: `exception: ${e.message}` }
    }
  }

  // ⚠ ISSUE INCERTAINE : ON N'ENVOIE PAS DEUX FOIS.
  // La connexion a Brevo a ete coupee en cours d'appel : le message a PEUT-ETRE
  // ete accepte. Replier enverrait alors une seconde confirmation pour un seul
  // paiement — et rien n'est plus inquietant, pour qui vient de payer, que deux
  // confirmations qui pourraient etre deux reservations. On s'abstient et on le
  // dit. Meme regle que le POST CRS d'issue incertaine du moteur.
  if (echecHote && echecHote.incertain) {
    console.error('[email-voyageur] issue incertaine cote Brevo, PAS de repli :', echecHote.raison)
    await prevenirDuRepli(r, 'incertain', echecHote.raison)
    return { ok: false, raison: echecHote.raison, incertain: true }
  }

  try {
    if (echecHote) {

      // ⚠ ET SI L'HOTE N'A PAS CONFIGURE BREVO ? ON ENVOIE QUAND MEME.
      // Ce message-ci n'est pas un message de parcours : c'est la preuve qu'un
      // PAIEMENT a abouti. Ne pas le delivrer laisse un voyageur qui vient de
      // payer sans rien — ni confirmation, ni dates, ni contact — et c'est le
      // pire etat du produit, bien avant une enveloppe a la mauvaise enseigne.
      //
      // ⚠ ARBITRAGE ASSUME, A TRANCHER PAR LE PRODUCT OWNER. La regle du
      // chantier est « la cle de l'hote, jamais celle de la plateforme ». Elle
      // vaut pleinement pour les messages de parcours, qui peuvent attendre ; pas
      // pour une confirmation de paiement, qui ne le peut pas.
      console.error('[email-voyageur] canal hote indisponible, repli plateforme :', echecHote.raison)
    }

    // ─── 2. Le repli plateforme ──────────────────────────────────────────────
    const envoi = await sendPlatformEmail(r.email, sujet, html)

    // ⚠ L'ALERTE VIENT APRES LE RESULTAT, ET ELLE DIT CE QUI S'EST REELLEMENT
    // PASSE. Posee avant, elle affirmait « la confirmation est partie sous
    // l'identite HoteSmart » — y compris quand la plateforme echouait a son tour
    // et que le voyageur n'avait, en fait, RIEN recu. Une alerte qui se trompe
    // de fait est pire qu'une alerte absente. Constat de review.
    if (echecHote) {
      await prevenirDuRepli(r, (envoi && envoi.ok !== false) ? 'repli' : 'rien', echecHote.raison)
    }

    if (!envoi || envoi.ok === false) {
      console.error('[email-voyageur] envoi refuse', sorte, envoi && envoi.error)
      return { ok: false, raison: (envoi && envoi.error) || 'envoi_refuse' }
    }
    return { ok: true, canal: 'plateforme' }
  } catch (e) {
    // Ne remonte JAMAIS : la reservation existe, l'e-mail est un service rendu.
    console.error('[email-voyageur] envoi echec', sorte, e.message)
    return { ok: false, raison: e.message }
  }
}

const envoyerConfirmation = r => envoyer(r, 'confirmation')
const envoyerRemboursement = r => envoyer(r, 'remboursement')

module.exports = { T, POLITIQUES, LANGUES, envoyerConfirmation, envoyerRemboursement }
