// lib/channel-pricing.js
// Regle metier : tarifs par occupation (ARI per-occupancy Channex).
// Partagee par le full sync (lib/channel-fullsync.js) et le push delta
// (api/calendar.js) pour ne pas dupliquer la logique.
//
//   prix(occ) = basePriceCents                                        si occ <= includedGuests
//             = basePriceCents + (occ - includedGuests) * extraFeeCents   sinon
//
// Retourne [{ occupancy, rate }] (rate en CENTS entiers), ou null.
// null => le caller CONSERVE l'ancien format `rate` singulier. Aucun bien
// sans supplement n'est impacte (ils restent en per_room mono-option).
function buildOccupancyRates(basePriceCents, capacity, includedGuests, extraFeeCents) {
  const base = Math.round(Number(basePriceCents) || 0)
  const cap  = parseInt(capacity, 10)
  const inc  = parseInt(includedGuests, 10)
  const fee  = Math.round(Number(extraFeeCents) || 0)

  // capacity absente/invalide : impossible de generer les lignes.
  if (!Number.isFinite(cap) || cap < 1) return null
  // fee<=0 : bien sans supplement, rate plan reste per_room mono-option.
  // -> null : le caller garde le rate singulier (comportement actuel, pas de 422).
  if (fee <= 0) return null
  // fee>0 => rate plan per_person (options 1..cap existent). inc absent/invalide :
  // on defaut a cap, EXACTEMENT comme le provisioning (channel-property.js `|| cap`)
  // -> rates[] plat (toutes = base), coherent et accepte (les options existent).
  const incEff = (Number.isFinite(inc) && inc >= 1) ? inc : cap

  const rates = []
  for (let occ = 1; occ <= cap; occ++) {
    const extra = occ > incEff ? (occ - incEff) * fee : 0
    rates.push({ occupancy: occ, rate: base + extra })
  }
  return rates
}

module.exports = { buildOccupancyRates }
