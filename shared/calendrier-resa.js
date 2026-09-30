// shared/calendrier-resa.js — LES RESERVATIONS DU CALENDRIER, UNE SEULE REGLE
// POUR LES DEUX ECRANS (ordinateur : pages/biens-calendrier.html ; telephone :
// pages/calendrier-mobile.html). Chantier « calendrier mobile », 30 septembre
// 2026.
//
// ⚠ POURQUOI CE MODULE EXISTE. La couleur des reservations etait tiree au sort
// (`SRC[idx % 3]`) sur les DEUX pages ; l'ordinateur l'avait corrige, le
// telephone jamais — une reservation Booking s'y affichait en rouge Airbnb.
// Deux copies d'une regle finissent toujours par diverger : la famille de
// source, la transformation des reservations et la regle « modifiable » vivent
// ICI, et nulle part ailleurs.
//
// ⚠ CE MODULE NE PARLE A AUCUNE API ET N'ECRIT RIEN : des fonctions pures. Les
// appels (reservation directe, fermetures, conversation) restent dans chaque
// page, par `shared/api-client.js`.

export const COULEURS_SOURCE = { airbnb: 'red', booking: 'blue', direct: 'green' }
export const LIBELLE_CANAL = { airbnb: 'Airbnb', booking: 'Booking.com', direct: 'Direct' }

export function familleSource (src) {
  const v = String(src || '').toLowerCase()
  if (v.includes('airbnb') || v.includes('abb')) return 'airbnb'
  if (v.includes('booking') || v.includes('bdc')) return 'booking'
  // « Offline » = reservation directe creee par nous (spec reservation
  // manuelle). Elle partage la couleur du direct : c'en est une.
  if (v === 'offline' || v.includes('direct')) return 'direct'
  return 'direct'
}
export function estOffline (src) { return String(src || '').toLowerCase() === 'offline' }

// ⚠ `demapped` EST MASQUE COMME `cancelled` : un sejour neutralise par un
// demappage n'occupe plus rien cote coeur (ses nuits repartent en vente).
export function mapResa (list) {
  return (list || []).filter(b => { const st = String(b.status || '').toLowerCase(); return st !== 'cancelled' && st !== 'demapped' }).map(b => {
    const ci = new Date(b.checkin + 'T00:00:00'), co = new Date(b.checkout + 'T00:00:00')
    const span = Math.max(1, Math.round((co - ci) / 86400000))
    const src = familleSource(b.source)
    return {
      id: b.booking_id || null,
      startISO: b.checkin, checkout: b.checkout, span,
      name: b.guest_name || 'Reservation',
      source: src, sourceBrute: b.source || null, offline: estOffline(b.source),
      color: COULEURS_SOURCE[src] || 'green',
      amount: b.amount ?? null, currency: b.currency || null,
      commission: b.commission ?? null,
      numAdult: b.numAdult ?? null, numChild: b.numChild ?? null,
      otaCode: b.otaReservationCode || null, arrivalHour: b.arrivalHour || null,
      statut: b.status || null,
      // Sous-origine : distingue une saisie de l'hote d'une vente du moteur
      // public, toutes deux `ota_name: "Offline"`.
      metaSource: b.metaSource || null,
      aEmail: b.aEmail === true
    }
  })
}

// Le statut du provider, dit en francais. Un statut inconnu s'affiche tel quel
// plutot que d'etre maquille.
const STATUTS = { new: 'Confirmée', confirmed: 'Confirmée', booked: 'Confirmée', modified: 'Modifiée', request: 'En attente', inquiry: 'En attente', cancelled: 'Annulée' }
export function libelleStatut (statut) {
  const v = String(statut || '').trim().toLowerCase()
  return v ? (STATUTS[v] || statut) : null
}

export function nuitsEntre (arriveeISO, departISO) {
  return Math.round((new Date(departISO + 'T00:00:00') - new Date(arriveeISO + 'T00:00:00')) / 86400000)
}

export function libelleCanal (resa) {
  // `sourceBrute` est la verite du provider ; le libelle n'est qu'un habillage.
  return resa.offline ? 'Direct (saisie HôteSmart)' : (LIBELLE_CANAL[resa.source] || resa.sourceBrute || resa.source)
}

/**
 * MODIFIABLE = les memes quatre conditions que l'annulation : reservation
 * directe (« Offline »), bien relie au canal, pas une vente du moteur public
 * (payee en ligne : la deplacer ne rembourserait rien), droit d'ecriture.
 * Une reservation OTA reste en consultation : Airbnb et Booking sont maitres
 * de leurs reservations. `note` dit pourquoi il n'y a pas de bouton.
 * @param ecriture  peutEcrire('reservations') && !lectureSeule
 */
export function droitsResa (bien, resa, ecriture) {
  const channex = bien.provider === 'channex' || bien.provider === 'channel'
  const venteEnLigne = resa.metaSource === 'hotesmart-engine'
  const modifiable = !!(resa.offline && channex && !venteEnLigne && ecriture)
  const canal = libelleCanal(resa)
  let note
  if (modifiable) note = 'Réservation directe : modifiable depuis HôteSmart.'
  else if (venteEnLigne && channex) note = 'Vendue par votre moteur de réservation et payée en ligne : toute modification passe par un remboursement ou un complément.'
  else if (resa.offline && channex) note = 'Réservation directe — vous n\'avez pas le droit de la modifier.'
  else note = channex ? 'Réservation venue de ' + canal + ' : modifiable uniquement chez ' + canal + '.' : 'Bien synchronisé hors HôteSmart : consultation seule.'
  return { channex, venteEnLigne, modifiable, note }
}

// Une reservation sans messagerie OTA (directe) ne recoit rien sans e-mail.
export function sansMessagerieOta (resa) {
  if (resa.offline) return true
  const src = String(resa.sourceBrute || resa.source || '').trim().toLowerCase()
  return src === '' || src === 'direct'
}
export const TEXTE_SANS_EMAIL = 'Cette réservation directe n\'a pas d\'adresse : ni confirmation, ni consignes d\'arrivée, ni code d\'accès ne peuvent partir. Transmettez-les vous-même, ou saisissez l\'adresse à la création pour les prochaines.'
export function badgeSansEmailVisible (resa) { return sansMessagerieOta(resa) && !resa.aEmail }

// La messagerie s'ouvre sur `booking_id` ; `bien` evite qu'un filtre de bien
// deja actif masque la conversation.
export function urlConversation (bien, resa) {
  return '/apps/agent-ai/messagerie?conv=' + encodeURIComponent(resa.id)
    + (bien.provider_property_id ? '&bien=' + encodeURIComponent(bien.provider_property_id) : '')
}

// Voyageurs plafonnes a la capacite (en PERSONNES), dit AVANT la validation.
export function messageCapacite (adultes, enfants, capacite) {
  if (!(adultes >= 1)) return 'Il faut au moins un adulte.'
  const total = adultes + (enfants || 0)
  return total > capacite
    ? 'Ce bien accueille ' + capacite + ' personne' + (capacite > 1 ? 's' : '') + ' au maximum — vous en avez saisi ' + total + '.'
    : null
}
