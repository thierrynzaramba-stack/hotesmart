// lib/marche/menage.js — UNE RESERVATION PORTE-T-ELLE DES FRAIS DE MENAGE ?
// Drapeau du controle permanent (V2.5), calcule DEPUIS LES DONNEES.
//
// ⚠ POURQUOI (Thierry, 24 septembre 2026) : la premiere version mettait Coeur de
// vie 23 « en attente de la dette 26 » par une liste d'UUID recopiee — elle a
// menti en staging, ou l'identifiant differe. Le marche est HORS menage ; une
// grille mesuree qui en contient se compare mal. Le releve le DIT (drapeau),
// il ne bloque rien.
//
// ⚠ UN DRAPEAU DE PRESENCE, PAS UNE MESURE (dette 26) : `true` = un frais de
// menage POSITIF est ecrit dans le payload. `false` ne prouve pas l'absence —
// un prix peut fondre le menage sans le dire (Beds24 Booking : 9/205 lignes
// seulement le detaillent). Ce module ne retire aucun euro : c'est le travail
// de `tarifNuitee` (dette 26), qui reste a faire.
//
// Les trois formes relevees en production le 24 septembre 2026 (lecture
// seule, empreinte 5 biens) — les seules vues sur 1 490 reservations :
//   - Beds24 : `invoiceItems[]` de type charge, description « frais de ménage »
//     (Coeur de vie 23, Booking, 59 reservations, sept. 2022 → mars 2024) ;
//   - Beds24 Airbnb : `rateDescription` « Cleaning N EUR » (Coeur de vie 23,
//     54 reservations, sept. 2022 → fev. 2024) ;
//   - Channex Airbnb : `rooms[].services[]` nomme « Cleaning Fee » (Colomiers,
//     12 reservations depuis juillet 2026), repris dans `notes`.

const MOT = /cleaning|m[ée]nage/i
const positif = v => { const x = Number(v); return Number.isFinite(x) && x > 0 }

function menageFacture (raw) {
  const r = raw || {}
  for (const i of r.invoiceItems || []) {
    if (i && MOT.test(String(i.description || '')) && positif(i.lineTotal ?? i.amount)) return true
  }
  const m = String(r.rateDescription || '').match(/cleaning\D{0,20}(\d+(?:[.,]\d+)?)/i)
  if (m && positif(m[1].replace(',', '.'))) return true
  for (const ro of r.rooms || []) {
    for (const sv of (ro && ro.services) || []) {
      if (sv && MOT.test(String(sv.name || sv.type || '')) && positif(sv.total_price ?? sv.price_per_unit ?? sv.price)) return true
    }
  }
  return false
}

/**
 * Combien de sejours COMPTES, ayant au moins une nuit dans [debut, fin], portent
 * un menage. `lignes` et `eclatements` sont alignes (sortie de `lireEtEclater`).
 */
function sejoursAvecMenage (lignes, eclatements, debut, fin) {
  let n = 0
  ;(eclatements || []).forEach((e, i) => {
    if (!e || !e.compte) return
    if (!(e.nuits || []).some(x => x.date >= debut && x.date <= fin)) return
    if (menageFacture(lignes[i] && lignes[i].raw)) n++
  })
  return n
}

module.exports = { menageFacture, sejoursAvecMenage }
