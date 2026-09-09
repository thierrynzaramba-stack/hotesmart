// lib/nuits-occupees.js
// QUELLES NUITS SONT REELLEMENT VENDUES — point unique.
//
// ⚠ CE CALCUL EXISTAIT EN DOUBLE, dans `scripts/audit-stop-sell.js` et
// `scripts/reconcilier-stop-sell.js`, a l'identique. Deux copies d'une regle
// metier finissent par diverger — c'est le defaut que ce depot a deja paye
// plusieurs fois. Il vit desormais ici ; les scripts l'appellent.
//
// ⚠ LA REGLE DE BORNE, ET ELLE COMPTE : un sejour 12 → 15 occupe le 12, le 13
// et le 14 — PAS le 15. La nuit du depart est libre : c'est ce qui permet a un
// arrivant de prendre la chambre le jour ou le precedent s'en va
// (docs/kb/reservation-directe.md §3).
//
// ⚠ SEULS LES SEJOURS `confirmed` OCCUPENT. Une demande, une option ou une
// annulation ne bloque aucune nuit : compter large fermerait des nuits vendables.
//
// Source : `bookings_snapshot`, le coeur — jamais un provider en direct
// (docs/kb/coeur-de-donnees.md).

const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const jourPlus = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d }

// Rend { 'AAAA-MM-JJ': [booking_id, …] } pour les nuits occupees de la fenetre.
// Une date portant PLUSIEURS identifiants est une surreservation deja en base.
//
// `debut` et `fin` acceptent une Date ou une chaine 'AAAA-MM-JJ'.
async function nuitsOccupees (supabase, providerPropertyId, debut, fin) {
  const bornes = (x) => (x instanceof Date ? isoLocal(x) : String(x))
  const de = bornes(debut)
  const a = bornes(fin)
  const par = {}
  let offset = 0
  for (;;) {
    // Pagination explicite : un bien de Bagneres porte 784 snapshots, et la
    // limite implicite de postgrest (1000) est atteinte par le suivant.
    const { data, error } = await supabase
      .from('bookings_snapshot')
      .select('booking_id, snapshot')
      .eq('property_id', String(providerPropertyId))
      // ⚠ `order` AVANT `range` : postgrest ne garantit aucun ordre stable sans
      // lui. Deux pages pourraient se recouvrir ou sauter des lignes — un sejour
      // confirme disparaitrait en silence, et la nuit vendue passerait pour libre.
      .order('booking_id')
      .range(offset, offset + 999)
    if (error) throw new Error('bookings_snapshot : ' + error.message)
    for (const b of data || []) {
      const s = b.snapshot || {}
      if (s.status !== 'confirmed') continue
      if (!s.arrival || !s.departure) continue
      // ⚠ 'AAAA-MM-JJ' seul se parse en UTC, et `isoLocal` relit en heure locale :
      // sur une machine a decalage negatif, tout le sejour glisserait d'un jour.
      // On force le parsage LOCAL.
      for (let d = new Date(s.arrival + 'T00:00:00'); isoLocal(d) < s.departure; d = jourPlus(d, 1)) {
        const j = isoLocal(d)
        if (j < de || j > a) continue
        ;(par[j] || (par[j] = [])).push(b.booking_id)
      }
    }
    if (!data || data.length < 1000) break
    offset += 1000
  }
  return par
}

module.exports = { nuitsOccupees }
