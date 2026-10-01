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

// ─── L'évaluation du voyageur, sur la fiche (lot 5 du chantier avis) ────────
// UNE fonction pour l'ordinateur et le téléphone (la règle « le mobile suit
// l'ordinateur ») : après le départ, le cœur dit où en est l'évaluation du
// séjour — PAR LE BUS, jamais par ses tables ni son endpoint.
//   - publiée          → « Évaluation publiée ✓ » ;
//   - à faire + droit  → un bouton « Évaluer ce voyageur » qui ouvre la
//                        fenêtre du cœur (`avis.evaluer`) ;
//   - rien à dire      → la zone reste vide (Booking, réservation directe,
//                        pas encore d'évaluation, droit absent, bus absent).
// ⚠ LE BUS SE CHARGE À LA DEMANDE : un import statique qui échouerait ferait
// tomber le calendrier entier. ⚠ `encoreAffichee` : une réponse tardive ne
// peint pas la fiche suivante.
function aujourdhuiLocal () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export async function brancherEvaluation ({ resa, cible, encoreAffichee = () => true, bus = undefined, aujourdhui = aujourdhuiLocal() } = {}) {
  if (!resa || !cible) return 'rien'
  cible.innerHTML = ''
  // Une réservation sans identifiant n'a pas d'évaluation : pas d'appel inutile.
  if (resa.id == null || resa.id === '') return 'rien'
  const depart = String(resa.checkout || '').slice(0, 10)
  if (!depart || depart > aujourdhui) return 'avant_depart'
  let b = bus
  if (b === undefined) {
    try { b = (await import('./hs-bus.js')).hsBus } catch { b = null }
  }
  if (!b) return 'sans_bus'
  const bookingUid = String(resa.id)
  const r = await b.demander('avis.statut', { booking_uid: bookingUid })
  if (!encoreAffichee() || !r || !r.ok || !r.data) return 'rien'
  const peindrePubliee = () => {
    cible.innerHTML = '<div style="margin:0 0 12px;padding:8px 12px;border-radius:8px;background:#eef8f0;color:#1E7B34;font-size:13px">⭐ Évaluation publiée ✓</div>'
  }
  if (r.data.etat === 'publiee') { peindrePubliee(); return 'publiee' }
  if (!r.data.evaluable) return 'rien'
  if (!(await b.disponible('avis.evaluer')) || !encoreAffichee()) return 'sans_droit'
  // 44 px de haut au moins : la cible tactile d'un doigt, dans la feuille du téléphone.
  cible.innerHTML = '<button type="button" style="width:100%;min-height:44px;margin:0 0 12px;padding:12px;border:0;border-radius:8px;background:#fff8e6;color:#7a5200;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit">⭐ Évaluer ce voyageur</button>'
  cible.querySelector('button').addEventListener('click', () => b.ouvrir('avis.evaluer', { booking_uid: bookingUid }))
  // ⚠ PUBLIÉE PENDANT QUE LA FICHE EST OUVERTE : elle le dit tout de suite,
  // au lieu de garder un bouton qui mènerait à « déjà publiée ».
  if (typeof b.ecouter === 'function') {
    const stop = b.ecouter('avis.evaluation_publiee', (d) => {
      if (!d || String(d.booking_uid) !== bookingUid) return
      if (encoreAffichee()) peindrePubliee()
      if (typeof stop === 'function') stop()
    })
  }
  return 'bouton'
}
