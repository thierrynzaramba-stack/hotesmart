// lib/taxe-sejour/lecture.js
// Spec : docs/specs/spec-taxe-sejour.md §1 et §2 (validee le 9 octobre 2026).
//
// LA SEULE REGLE QUI DIT « CECI EST DE LA TAXE DE SEJOUR ». Fonction pure : on
// recoit une ligne de `bookings_snapshot` (snapshot normalise + payload brut du
// provider) et on rend la ligne de `taxes_sejour`. Aucune base, aucun reseau.
// Lue par le writer (couche sync), par le rattrapage, et au lot 2 par
// `prixVoyageur()` : une seule lecture, jamais deux qui divergent.
//
// Ce que transmettent les plateformes (etape 0, 1 525 payloads reels) :
//   - Airbnb (Channex) : `raw_message.reservation.airbnb_collected_tax_details[]`
//     (taxe de sejour, additionnelles departementale et regionale, commune dans
//     le libelle) ; `amount` est un net hote, la taxe n'y est pas ; collectee
//     par Airbnb. `pass_through_tax_amount` : taxe reversee a l'hote (0 partout).
//   - Booking (Channex), deux modes :
//       « retenue » (La bulle) : `rooms[].collected_taxes[]`, `is_withheld` —
//       Booking la garde et la reverse ; hors de `amount` ;
//       « reversee » (Colomiers) : `rooms[].taxes[]` — comprise dans `amount`,
//       Booking la verse a l'hote, qui la declare.
//   - Booking (Beds24, historique) : ligne `invoiceItems` « taxe de séjour »,
//     comprise dans `price`.
//   - Airbnb (Beds24, historique) : rien de transmis — « absente, collectee par
//     Airbnb » (decision 2 de Thierry).
//   - Direct / Offline : rien — calcule par le bareme du bien au lot 3.
//
// ⚠ Les montants sont en CENTIMES entiers : une somme de decimaux en virgule
// flottante (0.18 + 1.80 + 0.61) ne vaut pas exactement 2.59.

const { STATUS, readStatus } = require('../bookings-snapshot-status')

// Libelles reconnus comme taxe de sejour dans les taxes Booking. Liste DERIVEE
// des payloads reels (« CITY_TAX (Withheld Tax) », « taxe de séjour (7.2%) ») ;
// tout autre libelle (TVA, frais de service) n'en est pas et reste dans le prix.
const LIBELLE_TS = /taxe\s+de\s+s[ée]jour|city[\s_]*tax|tourist[\s_]*tax/i

// Les composantes Airbnb, par leur nom.
const COMPOSANTES = [
  ['departementale', /d[ée]partementale/i],
  ['regionale', /r[ée]gionale/i],
  ['communale', /taxe\s+de\s+s[ée]jour/i],
]

const cents = (v) => {
  const x = Number(v)
  return Number.isFinite(x) ? Math.round(x * 100) : null
}

function nuitsDe (snapshot) {
  const a = Date.parse(String(snapshot?.arrival || '').slice(0, 10))
  const d = Date.parse(String(snapshot?.departure || '').slice(0, 10))
  if (!Number.isFinite(a) || !Number.isFinite(d) || d <= a) return null
  return Math.round((d - a) / 86400000)
}

function adultesDe (snapshot, raw) {
  const n = Number(snapshot?.numAdult ?? raw?.occupancy?.adults ?? raw?.numAdult)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function messageAirbnb (raw) {
  const m = raw?.raw_message
  if (!m) return null
  try {
    const o = typeof m === 'string' ? JSON.parse(m) : m
    return o?.reservation || null
  } catch { return null }
}

// « Taxe de Sejour (Fr - Bagnères-de-bigorre (216500595)) » → « Bagnères-de-bigorre (216500595) »
function communeDuLibelle (nom) {
  const m = /\(\s*[A-Za-z]{2}\s*-\s*(.+)\)\s*$/.exec(String(nom || ''))
  return m ? m[1].trim() : null
}

function vide (base, extra) {
  return {
    montant_cents: null, communale_cents: null, departementale_cents: null, regionale_cents: null,
    commune: null, collecteur: 'inconnu', origine: 'absent', inclus_dans_prix: null, source: null,
    libelles_inconnus: [], ...base, ...extra,
  }
}

/**
 * La taxe de sejour d'une reservation, lue dans ce que le provider a transmis.
 * @returns ligne de `taxes_sejour` (sans les cles), toujours un objet.
 */
function taxeSejourDe (snapshot, raw, defaultProvider = null) {
  const s = snapshot || {}
  const r = raw || {}
  const provider = String(s.provider || defaultProvider || '').toLowerCase()
  const canal = String(s.source || r.ota_name || '').trim().toLowerCase()
  const annulee = readStatus(s, provider) === STATUS.CANCELLED
  const base = { adultes: adultesDe(s, r), nuits: nuitsDe(s) }
  // Une reservation annulee ne doit pas de taxe : le montant passe a 0, ce qu'on
  // savait du collecteur est garde.
  const finir = (ligne) => (annulee && ligne.montant_cents != null
    ? { ...ligne, montant_cents: 0, communale_cents: ligne.communale_cents == null ? null : 0,
        departementale_cents: ligne.departementale_cents == null ? null : 0,
        regionale_cents: ligne.regionale_cents == null ? null : 0 }
    : ligne)

  if (provider === 'channex') {
    if (canal === 'airbnb') {
      const m = messageAirbnb(r)
      if (!m) return vide(base, { collecteur: 'plateforme', source: 'channex.airbnb', raison: 'raw_message illisible' })
      const details = Array.isArray(m.airbnb_collected_tax_details) ? m.airbnb_collected_tax_details : []
      const ligne = vide(base, { source: 'airbnb_collected_tax_details', origine: 'transmis', inclus_dans_prix: false })
      let somme = 0
      for (const d of details) {
        const c = cents(d?.amount) || 0
        const comp = COMPOSANTES.find(([, re]) => re.test(String(d?.name || '')))
        // ⚠ MEME REGLE QUE BOOKING (revue de 049d3ed) : un libelle non reconnu
        // n'est PAS compte comme taxe de sejour ; il est nomme, et le rapport du
        // rattrapage le montre.
        if (!comp) { ligne.libelles_inconnus.push(String(d?.name || '?')); continue }
        somme += c
        ligne[`${comp[0]}_cents`] = (ligne[`${comp[0]}_cents`] || 0) + c
        if (!ligne.commune) ligne.commune = communeDuLibelle(d?.name)
      }
      const collectee = details.length ? somme : (cents(m.airbnb_collected_tax_amount) || 0)
      const reversee = cents(m.pass_through_tax_amount) || 0
      ligne.montant_cents = collectee + reversee
      ligne.collecteur = collectee > 0 ? 'plateforme' : reversee > 0 ? 'hote' : 'personne'
      ligne.inclus_dans_prix = reversee > 0
      // Une annulee Airbnb rend deja 0.00 : sans montant, « personne » ne dirait
      // rien d'utile — on garde la plateforme, qui collecte sur ce canal.
      if (annulee && ligne.montant_cents === 0) ligne.collecteur = 'plateforme'
      return finir(ligne)
    }
    if (canal === 'bookingcom' || canal === 'booking.com' || canal === 'booking') {
      let retenue = 0, reversee = 0, vu = false
      const ligne = vide(base, { source: null, origine: 'transmis' })
      for (const ro of (r.rooms || [])) {
        for (const t of (ro?.collected_taxes || [])) {
          if (!LIBELLE_TS.test(String(t?.name || ''))) { ligne.libelles_inconnus.push(String(t?.name || '?')); continue }
          vu = true
          const c = cents(t.total_price) || 0
          if (t.is_withheld === false) reversee += c; else retenue += c
        }
        for (const t of (ro?.taxes || [])) {
          if (!LIBELLE_TS.test(String(t?.name || ''))) continue // TVA, frais de service : pas de la taxe de sejour
          vu = true
          reversee += cents(t.total_price) || 0
        }
      }
      ligne.montant_cents = retenue + reversee
      ligne.collecteur = retenue > 0 ? 'plateforme' : reversee > 0 ? 'hote' : 'personne'
      ligne.inclus_dans_prix = reversee > 0
      // Retenue ET reversee sur la meme reservation : jamais vu (revue de
      // 049d3ed). On ne choisit pas un collecteur : `inconnu`, et le rapport le dit.
      if (retenue > 0 && reversee > 0) {
        ligne.collecteur = 'inconnu'
        ligne.libelles_inconnus.push('mixte : taxe de sejour a la fois retenue par Booking et comprise dans le montant')
      }
      ligne.source = retenue > 0 ? 'collected_taxes' : reversee > 0 ? 'taxes' : 'rooms (aucune taxe de sejour)'
      if (!vu && !(r.rooms || []).length) return vide(base, { source: 'channex.booking', raison: 'aucune chambre' })
      return finir(ligne)
    }
    if (canal === 'offline') {
      // Saisie directe : rien de transmis, l'hote percoit. Calcul au lot 3.
      return vide(base, { collecteur: 'hote', source: 'channex.offline' })
    }
    return vide(base, { source: `channex.${canal || 'inconnu'}` })
  }

  if (provider === 'beds24') {
    const lignes = (r.invoiceItems || []).filter(i => i && i.type === 'charge' && LIBELLE_TS.test(String(i.description || '')))
    if (lignes.length) {
      const montant = lignes.reduce((a, i) => a + (cents(i.lineTotal) || 0), 0)
      return finir(vide(base, {
        montant_cents: montant, origine: 'transmis', inclus_dans_prix: true, source: 'invoiceItems',
        collecteur: canal === 'direct' ? 'hote' : 'inconnu',
      }))
    }
    // Decision 2 de Thierry : « absente, collectee par Airbnb ».
    if (canal === 'airbnb') return vide(base, { collecteur: 'plateforme', source: 'beds24.airbnb (non transmis)' })
    if (canal === 'direct') return vide(base, { collecteur: 'hote', source: 'beds24.direct' })
    return vide(base, { source: `beds24.${canal || 'inconnu'}` })
  }

  return vide(base, { source: 'provider inconnu' })
}

module.exports = { taxeSejourDe, LIBELLE_TS, communeDuLibelle }
