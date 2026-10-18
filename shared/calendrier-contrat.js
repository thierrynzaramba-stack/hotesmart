// shared/calendrier-contrat.js — LE CONTRAT DE PARITÉ DES DEUX ÉCRANS.
//
// Spec lot Calendrier §14 : « la liste des cinq actions, des rubriques de la
// popup et des champs de fiche est UNE SEULE constante partagée ». Les deux
// dispositions de pages/calendrier.html consomment CES listes — jamais une
// copie par écran (c'est la divergence desktop/mobile de l'ancien calendrier
// qui a coûté l'inventaire du 12 octobre 2026).

// Les CINQ actions de la barre flottante, dans l'ordre de la spec §4.2.
export const ACTIONS_BARRE = [
  { id: 'prix', cle: 'cal.action_prix', icone: 'i-edit' },
  { id: 'fermer', cle: 'cal.action_fermer', cleInverse: 'cal.action_rouvrir', icone: 'i-close' },
  { id: 'bloquer', cle: 'cal.action_bloquer', icone: 'i-shield' },
  { id: 'reservation', cle: 'cal.action_reservation', icone: 'i-plus' },
  { id: 'plus', cle: 'cal.action_plus', icone: 'i-settings' }
]

// Les rubriques de la popup « Configurer les dates » (§5) — inventaire A.7
// au complet, stop vente COMPRIS (constat 9 : il manquait au téléphone),
// plus la rubrique orphelines (arbitrage (d) du 12 octobre : dans la popup à
// l'étape 1, volet Prix à l'étape 2).
export const RUBRIQUES_POPUP = [
  { id: 'rate', cle: 'cal.rub_prix' },
  { id: 'perPerson', cle: 'cal.rub_par_personne' },
  { id: 'avail', cle: 'cal.rub_dispo' },
  { id: 'minStayArrival', cle: 'cal.rub_min_arrivee' },
  { id: 'minStayThrough', cle: 'cal.rub_min_sejour' },
  { id: 'maxStay', cle: 'cal.rub_max' },
  { id: 'cta', cle: 'cal.rub_cta' },
  { id: 'ctd', cle: 'cal.rub_ctd' },
  { id: 'stopSell', cle: 'cal.rub_stop' },
  { id: 'orphelines', cle: 'cal.rub_orphelines' }
]

// Les champs de la fiche de réservation (§7) — inventaire A.9, la ligne
// Statut sur LES DEUX écrans (constat 6). `snap` = bookings_snapshot.
export const CHAMPS_FICHE = [
  { id: 'statut', cle: 'cal.fiche_statut' },
  { id: 'arrivee', cle: 'cal.fiche_arrivee' },
  { id: 'depart', cle: 'cal.fiche_depart' },
  { id: 'nuits', cle: 'cal.fiche_nuits' },
  { id: 'voyageurs', cle: 'cal.fiche_voyageurs' },
  { id: 'montant', cle: 'cal.fiche_montant' },
  { id: 'canal', cle: 'cal.fiche_canal' },
  { id: 'commission', cle: 'cal.fiche_commission' },
  { id: 'reference', cle: 'cal.fiche_reference' },
  { id: 'identifiant', cle: 'cal.fiche_identifiant' }
]

// Les QUATRE états d'une nuit (§4.1, dette 20 fermée). La vendabilité se lit
// EXCLUSIVEMENT dans calendar_inventory (constat 12) ; « pas encore
// ouverte » = au-delà de la fenêtre du pilote d'un bien PILOTÉ, non vendue.
// `s` = état d'inventaire du jour (buildStateFromInventory) ; `vendue` =
// une réservation couvre la nuit ; `horsFenetre` = pilote actif ET la nuit
// est après (aujourd'hui + fenêtre).
export function etatDeNuit ({ vendue, fermee, horsFenetre }) {
  if (vendue) return 'vendue'
  if (horsFenetre) return 'attente'
  if (fermee) return 'fermee'
  return 'ouverte'
}

// Devise via Intl, PARTOUT (constat 7 : le « € » en dur du mobile affichait
// la mauvaise devise pour un bien GBP). `langue` = I18n courant.
export function prixIntl (montant, devise, langue) {
  if (montant == null || !Number.isFinite(Number(montant))) return null
  try {
    return new Intl.NumberFormat(langue || 'fr', {
      style: 'currency', currency: devise || 'EUR', maximumFractionDigits: 0
    }).format(Number(montant))
  } catch {
    return new Intl.NumberFormat(langue || 'fr', { maximumFractionDigits: 0 }).format(Number(montant))
  }
}

// Dates via Intl, memes formats sur les deux ecrans (constat 6).
export function dateIntl (iso, langue, options) {
  const [a, m, j] = String(iso).slice(0, 10).split('-').map(Number)
  if (!a || !m || !j) return String(iso || '')
  return new Intl.DateTimeFormat(langue || 'fr', options || { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(Date.UTC(a, m - 1, j, 12)))
}
