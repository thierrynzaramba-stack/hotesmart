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
// ⚠ CE QUI OCCUPE LE CALENDRIER : `confirmed` ET `blocked`.
// Un blocage proprietaire (Beds24 `black`) ne genere pas de menage mais retient
// bien la nuit — la revendre serait une surreservation. Une demande (`request`)
// et une annulation, elles, ne retiennent rien : compter large fermerait des
// nuits vendables.
//
// ⚠ LE STATUT SE LIT PAR `readStatus`, JAMAIS EN BRUT. Comparer a la chaine
// 'confirmed' rate le vocabulaire provider des lignes ecrites avant la
// canonicalisation — un snapshot Beds24 `new` EST une reservation confirmee, et
// serait passe pour libre.
//
// Source : `bookings_snapshot`, le coeur — jamais un provider en direct
// (docs/kb/coeur-de-donnees.md).
//
// ⚠ LE COMPTE EST OBLIGATOIRE, ET CE N'EST PAS UNE PRECAUTION DE STYLE.
// `provider_property_id` n'a AUCUNE unicite globale : deux hotes peuvent porter
// le meme identifiant provider (constate et documente dans
// `lib/cron-overbooking.js`, qui indexe pour cette raison sur
// `user_id|property_id`). Cette lecture decide desormais du stock pousse aux
// OTA : sans le filtre, le sejour d'un AUTRE compte fermerait des nuits
// vendables — et le calendrier, lui cadre par compte, afficherait le contraire
// de ce qui part.

const { readStatus, STATUS } = require('./bookings-snapshot-status')

const OCCUPENT = new Set([STATUS.CONFIRMED, STATUS.BLOCKED])

const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const jourPlus = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d }

// Rend { 'AAAA-MM-JJ': [booking_id, …] } pour les nuits occupees de la fenetre.
// Une date portant PLUSIEURS identifiants est une surreservation deja en base.
//
// `debut` et `fin` acceptent une Date ou une chaine 'AAAA-MM-JJ'.
async function nuitsOccupees (supabase, providerPropertyId, debut, fin, { userId } = {}) {
  // Exige, jamais devine : un appelant qui l'oublie doit le savoir tout de
  // suite, pas decouvrir des nuits fermees par le voisin.
  if (!userId) throw new Error('nuitsOccupees : userId requis (provider_property_id n a pas d unicite globale)')
  if (!providerPropertyId) throw new Error('nuitsOccupees : providerPropertyId requis')
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
      .eq('user_id', userId)
      .eq('property_id', String(providerPropertyId))
      // ⚠ `order` AVANT `range` : postgrest ne garantit aucun ordre stable sans
      // lui. Deux pages pourraient se recouvrir ou sauter des lignes — un sejour
      // confirme disparaitrait en silence, et la nuit vendue passerait pour libre.
      .order('booking_id')
      .range(offset, offset + 999)
    if (error) throw new Error('bookings_snapshot : ' + error.message)
    for (const b of data || []) {
      const s = b.snapshot || {}
      if (!OCCUPENT.has(readStatus(s))) continue
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
