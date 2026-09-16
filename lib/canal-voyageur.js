// lib/canal-voyageur.js
// DOC : docs/kb/guestflow.md (modif = MEME COMMIT)
// Spec : docs/specs/spec-canal-email-resa-directe.md — etape 2
//
// PAR OU SORT UN MESSAGE AU VOYAGEUR. Ce module decide, et il dit pourquoi.
//
// Il ne connait aucun provider, n'ecrit rien, n'envoie rien : il compare une
// reservation a des regles et rend un canal. Meme forme que
// `lib/booking-changes.js`, et pour la meme raison — une decision qu'on peut
// tester sans reseau est une decision qu'on peut corriger sans peur.
//
// ⚠ C'EST LA SOURCE QUI TRANCHE, JAMAIS LA PRESENCE D'UNE ADRESSE.
// Booking.com sert un alias de relais (`…@guest.booking.com`) dans le meme champ
// que celui d'une reservation directe, et cet alias DELIVRE. Router sur « une
// adresse existe » detournerait vers l'e-mail des reservations qui ont une
// messagerie OTA parfaitement fonctionnelle — mesure du 16 septembre 2026 :
// 114 des 148 adresses du coeur sont des adresses d'OTA, contre 7 Offline.
//
// ⚠ L'ADRESSE SE LIT DANS LE COEUR (`snapshot.guestEmail`), jamais dans un
// payload provider. C'est ce qui rend ce module utilisable des deux cotes le jour
// ou la saisie directe Beds24 rejoindra le canal e-mail : il faudra alors que son
// booking vienne du snapshot, pas de l'API — la regle du coeur de donnees, prise
// par le bon bout.

const { emailOuRien } = require('./bookings-snapshot')

// ⚠ L'INTERRUPTEUR DE L'ETAPE 3, ET IL EST LU A DEUX ENDROITS.
// Tant qu'il vaut `false`, le canal e-mail est DECIDE mais jamais tente : la
// couche d'envoi (cle Brevo de l'hote, expediteur verifie, mise en forme) n'existe
// pas encore. Les moteurs de templates s'en servent pour sortir AVANT la
// generation du message — un appel Claude Haiku par reservation et par template,
// toutes les 5 minutes, pour un envoi qui ne partira pas, c'est le budget du cron
// qu'on dilapide (le depot vient d'encaisser un 504 sur ce budget).
//
// A l'etape 3 : passer a `true`, et retirer les sorties anticipees qui le citent.
const ENVOI_EMAIL_BRANCHE = false

const CANAL = {
  OTA:   'ota',     // messagerie du canal de vente (Channex / Beds24)
  EMAIL: 'email',   // e-mail direct au voyageur
  AUCUN: 'aucun'    // rien a tenter — et on dit pourquoi
}

const MOTIF = {
  MESSAGERIE_OTA: 'messagerie_ota',
  EMAIL_VOYAGEUR: 'email_voyageur',
  PAS_D_EMAIL:    'pas_d_email',
  SANS_CANAL:     'sans_canal'
}

// Ce que l'hote lit. Un motif qui ne se traduit pas finit en code brut a l'ecran.
const MOTIF_LISIBLE = {
  [MOTIF.MESSAGERIE_OTA]: 'messagerie du canal de vente',
  [MOTIF.EMAIL_VOYAGEUR]: 'e-mail au voyageur',
  [MOTIF.PAS_D_EMAIL]:    'pas d\'adresse e-mail — messages non envoyes',
  [MOTIF.SANS_CANAL]:     'reservation sans canal de communication'
}

// Les sources qui n'ont AUCUNE messagerie derriere.
// `Offline` est le nom que Channex donne a une reservation entree par le CRS —
// c'est la notre, vendue par le moteur ou saisie a la main dans le calendrier.
// Verifie chez le provider le 16 septembre 2026 : GET /bookings/<id>/messages
// rend HTTP 422 `not_supported` sur ces reservations, contre 200 sur un temoin
// Airbnb. Ce n'est pas une panne a reessayer, c'est une absence a contourner.
const SOURCES_SANS_MESSAGERIE = ['offline']

// Une saisie directe Beds24 n'a pas davantage de fil de messagerie, mais elle
// n'entre PAS dans le canal e-mail en v1 : son booking arrive encore du payload
// provider et non du coeur, donc son adresse n'est pas lisible ici. Elle garde
// le comportement qu'elle a toujours eu — aucun envoi tente. Voir l'en-tete.
const SOURCES_DIRECTES_BEDS24 = ['', 'direct']

function normaliser (v) {
  return String(v == null ? '' : v).trim().toLowerCase()
}

// ⚠ UN BOOKING SANS SOURCE N'EST PAS UNE RESERVATION DIRECTE.
// Le chemin Beds24 porte ses canaux dans `channel` / `apiSource` / `referer` et
// non dans `source` : au moindre canal renseigne, il y a un fil. La regle est
// reprise telle quelle de `hasMessagingThread`, qu'elle remplace — la changer
// ici couperait des envois OTA qui fonctionnent.
function aUnCanalDeVente (booking) {
  const b = booking || {}
  if (b.channel || b.apiSource || b.referer) return true
  const src = normaliser(b.source)
  return src !== '' && !SOURCES_DIRECTES_BEDS24.includes(src)
}

// La decision. Rend TOUJOURS { canal, motif, destinataire } — jamais null :
// « je ne sais pas » n'est pas une reponse, et un motif absent est un motif
// qu'on finit par ignorer.
function canalPour (booking) {
  const b = booking || {}
  const src = normaliser(b.source)

  if (SOURCES_SANS_MESSAGERIE.includes(src)) {
    const adresse = emailOuRien(b.guestEmail)
    if (!adresse) {
      // Aucun envoi, et surtout AUCUNE ligne de journal : le jour ou l'adresse
      // est saisie, les messages doivent pouvoir partir. Une ligne posee ici les
      // condamnerait en silence — c'est deja arrive a trois reservations, avec
      // le 422 de Channex pour seule trace.
      return { canal: CANAL.AUCUN, motif: MOTIF.PAS_D_EMAIL, destinataire: null }
    }
    return { canal: CANAL.EMAIL, motif: MOTIF.EMAIL_VOYAGEUR, destinataire: adresse }
  }

  if (!aUnCanalDeVente(b)) {
    return { canal: CANAL.AUCUN, motif: MOTIF.SANS_CANAL, destinataire: null }
  }

  return { canal: CANAL.OTA, motif: MOTIF.MESSAGERIE_OTA, destinataire: null }
}

// Pour les appelants qui n'ont qu'une question a poser.
const passeParEmail = booking => canalPour(booking).canal === CANAL.EMAIL
const passeParOta   = booking => canalPour(booking).canal === CANAL.OTA

module.exports = {
  ENVOI_EMAIL_BRANCHE,
  CANAL,
  MOTIF,
  MOTIF_LISIBLE,
  SOURCES_SANS_MESSAGERIE,
  canalPour,
  passeParEmail,
  passeParOta
}
