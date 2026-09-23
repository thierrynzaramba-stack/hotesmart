// lib/marche/etude.js — L'ETUDE D'UN BIEN : ses comparables retenus, leurs
// 26 mois, par le client AirROI (cache d'abord). Lot V2.1 / V2.5.
//
// ⚠ AUCUN APPEL TANT QUE LE BIEN N'A PAS SES COORDONNEES ET SON PLANCHER
// (arbitrage 6) : on refuse AVANT le premier appel, avec le motif.
// ⚠ ON PART D'UNE LISTE DE listing_id STOCKEE PAR BIEN (`comparables_retenus`),
// quelle que soit son origine : le fondateur aujourd'hui, l'ecran de selection
// (V2.4) demain.
// ⚠ AUCUN FILTRE PAR PRIX : le prix annonce par le proprietaire ne choisit pas
// l'echantillon (§7, pieges).

async function comparablesRetenus (supabase, propertyId) {
  const { data, error } = await supabase.from('comparables_retenus')
    .select('listing_id, retenu_par, note').eq('property_id', propertyId).eq('actif', true).order('id')
  if (error) throw new Error(`[etude] comparables retenus : ${error.message}`)
  return (data || []).map(r => ({ ...r, listing_id: String(r.listing_id) }))
}

/**
 * @returns { refus } ou { comparables: [entree de grilleMarche], fraicheur, prixMinimum }
 */
async function etudierBien ({ supabase, client, bien, listingIds = null }) {
  if (bien.latitude == null || bien.longitude == null) {
    return { refus: 'coordonnees_absentes', message: 'Les coordonnées du logement ne sont pas renseignées : aucune étude du marché possible.' }
  }
  if (!(Number(bien.prix_minimum) > 0)) {
    return { refus: 'plancher_absent', message: 'Le prix plancher du logement n’est pas renseigné : aucune étude du marché avant lui.' }
  }
  const ids = listingIds || (await comparablesRetenus(supabase, bien.id)).map(r => r.listing_id)
  if (!ids.length) return { refus: 'aucun_comparable_retenu', message: 'Aucun comparable retenu pour ce logement.' }
  const ctx = { userId: bien.user_id, propertyId: bien.id }
  const comparables = []
  const dates = []
  for (const id of ids) {
    // La fiche (nom, gestionnaire) et les mois : deux appels, chacun en cache.
    const fiche = await client.annonce(id, ctx)
    const mois = await client.metriquesAnnonce(id, ctx)
    dates.push(fiche.recupereLe, mois.recupereLe)
    const f = fiche.donnees || {}
    comparables.push({
      listing_id: String(id),
      nom: f.listing_info ? f.listing_info.listing_name : null,
      host_id: f.host_info && f.host_info.host_id != null ? String(f.host_info.host_id) : null,
      host_name: f.host_info ? f.host_info.host_name : null,
      cohost_ids: f.host_info ? (f.host_info.cohost_ids || []).map(String) : [],
      mensuel: (mois.donnees && mois.donnees.results) || []
    })
  }
  // La fraicheur affichee est celle de la donnee la PLUS ANCIENNE.
  const fraicheur = dates.filter(Boolean).sort()[0] || null
  return { comparables, fraicheur, prixMinimum: Number(bien.prix_minimum) / 100 }
}

module.exports = { etudierBien, comparablesRetenus }
