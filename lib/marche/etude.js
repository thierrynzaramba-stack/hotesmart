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

const { GARDES, TARIFS } = require('../airroi/cout')

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
  const plafond = GARDES.plafondBien90jUsd
  const trop = (usd) => ({ refus: 'etude_trop_chere', message: `Cette étude coûterait ${usd.toFixed(2)} $ (${ids.length} comparables), au-delà du plafond par logement (${plafond} $).` })
  const metriques = ids.map(id => ({ endpoint: 'GET /listings/metrics/all', params: { listing_id: String(id), num_months: 60, currency: 'native' } }))
  const ficheSeule = id => ({ endpoint: 'GET /listings', params: { listing_id: String(id), currency: 'native' } })
  const dates = []

  // ⚠ LES FICHES VIENNENT DE `listings/comparables` (Thierry, 24 septembre
  // 2026, decision 11 renversee) : un appel a 0,10 $ rend les fiches completes
  // des 25 annonces voisines. Payer 0,10 $ par comparable pour une fiche qu'on
  // a deja serait du gaspillage : par comparable, on ne paie que ses mois
  // (`listings/metrics/all`). La recherche prend chambres, salles de bain et
  // voyageurs de l'annonce Airbnb DU BIEN (une fiche, en cache 90 jours).
  // Un comparable retenu ABSENT de la liste (la recherche n'en rend que 25)
  // est lu par sa fiche, et seulement lui.
  // ⚠ LE COUT SE JUGE AVANT DE PAYER LES MOIS (review) : estimation d'abord ;
  // puis, liste lue, les fiches des absents s'ajoutent AVANT le premier appel
  // des mois — l'etude ne s'arrete jamais au milieu apres avoir paye.
  const fiches = new Map()
  let paye = 0   // ce que l'etude a deja engage (appels hors cache), en dollars
  if (bien.airbnb_listing_id) {
    const moiAppel = ficheSeule(bien.airbnb_listing_id)
    // Avant tout : le pire cas connu (fiche du bien, liste hors cache, mois).
    const pire = await client.estimer([moiAppel, ...metriques]) + TARIFS['GET /listings/comparables']
    if (pire > plafond) return trop(pire)
    paye += await client.estimer([moiAppel])
    const moi = await client.annonce(bien.airbnb_listing_id, ctx)
    dates.push(moi.recupereLe)
    const pd = (moi.donnees && moi.donnees.property_details) || {}
    const recherche = { latitude: Number(bien.latitude), longitude: Number(bien.longitude),
      bedrooms: Number(pd.bedrooms), baths: Number(pd.baths), guests: Number(pd.guests) }
    paye += await client.estimer([{ endpoint: 'GET /listings/comparables', params: { ...recherche, currency: 'native' } }])
    const liste = await client.comparables(recherche, ctx)
    dates.push(liste.recupereLe)
    for (const l of (liste.donnees && liste.donnees.listings) || []) {
      const id = l && l.listing_info && l.listing_info.listing_id
      if (id != null) fiches.set(String(id), l)
    }
  }
  const absents = ids.filter(id => !fiches.has(String(id)))
  const total = paye + await client.estimer([...absents.map(ficheSeule), ...metriques])
  if (total > plafond) return trop(total)
  for (const id of absents) {
    const f = await client.annonce(id, ctx)
    dates.push(f.recupereLe)
    fiches.set(String(id), f.donnees || {})
  }

  const comparables = []
  for (const id of ids) {
    const mois = await client.metriquesAnnonce(id, ctx)
    dates.push(mois.recupereLe)
    const f = fiches.get(String(id)) || {}
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
