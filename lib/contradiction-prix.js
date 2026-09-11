// lib/contradiction-prix.js
//
// ⚠ LA CONTRADICTION QUE CE MODULE DETECTE — mesuree le 11 septembre 2026.
//
// Un logement en `keep` (« prix encore geres par l'ancien channel manager »),
// avec un canal ACTIF, et des dates TARIFEES dans le coeur. L'hote tarife chez
// nous en nous interdisant d'envoyer : les trois faits ne peuvent pas etre vrais
// ensemble.
//
// Ce que ca produit, et qui a dure sans que personne ne le sache : la
// disponibilite part TOUJOURS (anti-surreservation, choix assume), les tarifs
// seulement en `managed`. Les dates s'ouvrent donc a la vente au prix que NOUS
// avons pousse au provisionnement, pendant que la grille de l'hote dort dans le
// coeur. Sur « Ofuro Futari » : 31 nuits vendables a 199 € a plat, 14
// sous-vendues pour 410 € de manque a gagner, 4 sur-vendues de 30 € au
// detriment du voyageur, 13 sans aucun prix saisi.
//
// ⚠ ET DEPUIS LE CONSTAT DE TERRAIN, CE N'EST PLUS UN ARBITRAGE : des qu'un
// channel manager est lie, l'extranet REFUSE que l'hote edite ses tarifs
// (« modification obligatoire par le CM »). En `keep` avec un canal actif,
// PERSONNE ne peut tarifer le logement. Ce n'est pas une preference, c'est une
// panne commerciale silencieuse.
//
// ⚠ POURQUOI UN INCIDENT ET PAS UNE LIGNE DE LOG. C'est la lecon du cron qui
// rendait HTTP 200 en portant ses erreurs dans le corps (24 h de panne totale
// invisible) et de la poussee refusee qui ne produisait qu'un `warnings[0]`.
// Une erreur qui coute de l'argent a l'hote — ou qui en fait payer trop au
// voyageur — n'est pas un avertissement.

// ─── LE CHIFFRAGE ─────────────────────────────────────────────────────────
// Pure : c'est elle que le test tient, et c'est elle qui doit chiffrer le cout
// EXACTEMENT comme on le chiffrerait a la main.
//
//   `lignes`  : le coeur — [{ date, rate, stop_sell }]
//   `parDate` : ce que le provider detient sur le tarif que l'OTA lit —
//               { date: { rate, availability, stop_sell } }
//
// Ne comptent que les nuits REELLEMENT VENDABLES chez le provider : une nuit
// fermee ne coute rien, quel que soit son prix affiche.
function chiffrerEcartDePrix (lignes, parDate) {
  const nuits = []
  let manqueAGagner = 0
  let tropPaye = 0
  let sansPrixVendables = 0

  const coeur = new Map((lignes || []).map(l => [l.date, l]))
  for (const [date, chez] of Object.entries(parDate || {})) {
    const vendable = chez && chez.stop_sell !== true && Number(chez.availability) > 0
    if (!vendable) continue
    const l = coeur.get(date)
    const voulu = l && l.rate != null && Number(l.rate) > 0 ? Number(l.rate) : null
    const affiche = Number(chez.rate)
    if (!Number.isFinite(affiche)) continue
    if (voulu == null) { sansPrixVendables++; continue }
    const ecart = voulu - affiche
    if (Math.abs(ecart) < 0.005) continue
    if (ecart > 0) manqueAGagner += ecart
    else tropPaye += -ecart
    nuits.push({ date, voulu, affiche, ecart: Math.round(ecart * 100) / 100 })
  }
  nuits.sort((a, b) => a.date < b.date ? -1 : 1)
  return {
    nuits,
    sous_vendues: nuits.filter(n => n.ecart > 0).length,
    sur_vendues: nuits.filter(n => n.ecart < 0).length,
    sans_prix_vendables: sansPrixVendables,
    manque_a_gagner: Math.round(manqueAGagner * 100) / 100,
    trop_paye: Math.round(tropPaye * 100) / 100
  }
}

// ─── LE MESSAGE ───────────────────────────────────────────────────────────
// ⚠ IL CHIFFRE, IL NE QUALIFIE PAS. « Vos prix ne partent pas » ne dit rien a
// un hote ; « 14 nuits vendues 199 € au lieu de votre grille, 410 € de manque a
// gagner » le fait agir. C'est la forme exacte dans laquelle le defaut a ete
// compris la premiere fois.
function messageContradiction (nomDuBien, bilan) {
  const bits = []
  if (bilan.sous_vendues) {
    const p = bilan.nuits.filter(n => n.ecart > 0)
    const prixVus = [...new Set(p.map(n => n.affiche))].slice(0, 3).join(' / ')
    bits.push(`${bilan.sous_vendues} nuit(s) vendue(s) ${prixVus} € au lieu de votre grille`
      + ` — ${bilan.manque_a_gagner} € de manque a gagner`)
  }
  if (bilan.sur_vendues) {
    bits.push(`${bilan.sur_vendues} nuit(s) vendue(s) ${bilan.trop_paye} € TROP CHER au voyageur`)
  }
  if (bilan.sans_prix_vendables) {
    bits.push(`${bilan.sans_prix_vendables} nuit(s) vendable(s) sans aucun prix dans votre calendrier`)
  }
  return `« ${nomDuBien} » est connecte a une plateforme mais ses tarifs ne partent pas`
    + ` (mode « prix geres par l'ancien channel manager »). ${bits.join(' ; ')}.`
    + ` Passez le logement en « HoteSmart gere mes prix » pour que votre grille parte.`
}

// ─── LE VERDICT ───────────────────────────────────────────────────────────
// Les trois faits doivent etre vrais ENSEMBLE. Pur, pour que le test puisse
// tenir chaque combinaison sans reseau ni base.
//
// ⚠ `canauxActifs === null` (on n'a pas pu lire) N'EST PAS « aucun canal ».
// Conclure « pas de contradiction » sur une panne, c'est exactement le faux
// vert que ce depot paie depuis trois jours : on s'abstient, et on le dit.
function jugerContradiction ({ bien, canauxActifs, lignes, parDate }) {
  if (!bien) return { verdict: 'inconnu', contradiction: false }
  if (bien.rate_sync_mode !== 'keep') return { verdict: 'mode_managed', contradiction: false }
  if (canauxActifs === null || canauxActifs === undefined) {
    return { verdict: 'canaux_illisibles', contradiction: false, incertain: true }
  }
  if (!canauxActifs.length) return { verdict: 'aucun_canal_actif', contradiction: false }

  const tarifees = (lignes || []).filter(l => l.rate != null && Number(l.rate) > 0)
  if (!tarifees.length) return { verdict: 'aucune_date_tarifee', contradiction: false }

  const bilan = chiffrerEcartDePrix(lignes, parDate)
  // Les trois faits sont la. Meme sans ecart chiffrable (provider illisible,
  // prix identiques par hasard), la contradiction EXISTE : l'hote tarife chez
  // nous et rien ne part. Le chiffrage precise le cout, il ne le conditionne pas.
  return {
    verdict: 'contradiction',
    contradiction: true,
    canaux: canauxActifs,
    dates_tarifees: tarifees.length,
    ...bilan,
    message: messageContradiction(bien.name || 'Ce logement', bilan)
  }
}

module.exports = { jugerContradiction, chiffrerEcartDePrix, messageContradiction }

// ─── LE RUNNER ────────────────────────────────────────────────────────────
// Branche le verdict sur les donnees reelles et leve l'incident.
//
// ⚠ ORDRE DES LECTURES, ET C'EST DELIBERE. La porte d'entree est la SEULE
// condition gratuite : `rate_sync_mode === 'keep'`. Un bien en `managed` — le
// cas normal depuis que la creation le pose — ne coute aucun appel reseau. Les
// deux lectures provider n'ont lieu que pour les rares biens en `keep`.
async function surveillerContradictionPrix (supabase, bien, { channelCall, reportIncident, maintenant = new Date() } = {}) {
  if (!bien || bien.rate_sync_mode !== 'keep') return { verdict: 'mode_managed', contradiction: false }

  const cle = bien.provider_property_id || bien.migration_target_property_id
  if (!cle) return { verdict: 'pas_de_cle', contradiction: false }

  // 1. Les canaux actifs. `null` = illisible, jamais « aucun ».
  let canauxActifs = null
  try {
    const r = await channelCall('GET', `/channels?filter[property_id]=${encodeURIComponent(cle)}`)
    if (r && r.ok) {
      const rows = Array.isArray(r.json?.data) ? r.json.data : []
      canauxActifs = rows.filter(c => c.attributes?.is_active === true)
        .map(c => String(c.attributes?.channel || c.attributes?.ota_name || 'canal'))
    }
  } catch (e) {
    console.error('[contradiction-prix] lecture des canaux echec', e.message)
  }
  if (canauxActifs === null) return { verdict: 'canaux_illisibles', contradiction: false, incertain: true }
  if (!canauxActifs.length) return { verdict: 'aucun_canal_actif', contradiction: false }

  // 2. Le coeur, sur la fenetre poussee.
  const debut = new Date(maintenant); debut.setHours(0, 0, 0, 0)
  const fin = new Date(debut); fin.setDate(fin.getDate() + 500)
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const { data: lignes, error: eCi } = await supabase
    .from('calendar_inventory')
    .select('date, rate, stop_sell')
    .eq('property_id', bien.id)
    .gte('date', iso(debut)).lte('date', iso(fin))
    .limit(1000)
  // ⚠ UNE LECTURE EN ECHEC N'EST PAS « AUCUNE DATE TARIFEE » : ce serait taire
  // l'alerte au moment ou elle sert.
  if (eCi) {
    console.error('[contradiction-prix] lecture du coeur echec', eCi.message)
    return { verdict: 'coeur_illisible', contradiction: false, incertain: true }
  }
  if (!(lignes || []).some(l => l.rate != null && Number(l.rate) > 0)) {
    return { verdict: 'aucune_date_tarifee', contradiction: false }
  }

  // 3. Ce que le provider detient, pour chiffrer le cout.
  let parDate = {}
  try {
    const rr = await channelCall('GET', `/restrictions?filter[property_id]=${encodeURIComponent(cle)}`
      + `&filter[date][gte]=${iso(debut)}&filter[date][lte]=${iso(fin)}`
      + `&filter[restrictions]=rate,availability,stop_sell`)
    if (rr && rr.ok) parDate = (rr.json?.data && rr.json.data[bien.provider_rate_plan_id]) || {}
  } catch (e) {
    console.error('[contradiction-prix] lecture des restrictions echec', e.message)
  }

  const verdict = jugerContradiction({ bien, canauxActifs, lignes, parDate })
  if (!verdict.contradiction) return verdict

  // ⚠ INCIDENT, PAS LIGNE DE LOG — `threshold: 1`. Une panne commerciale
  // silencieuse ne devient visible que si elle reveille quelqu'un.
  if (typeof reportIncident === 'function') {
    try {
      await reportIncident('prix_non_pousses', {
        userId: bien.user_id,
        propertyId: String(cle),
        propertyName: bien.name,
        threshold: 1,
        detail: {
          message: verdict.message,
          canaux: verdict.canaux,
          dates_tarifees: verdict.dates_tarifees,
          sous_vendues: verdict.sous_vendues,
          sur_vendues: verdict.sur_vendues,
          sans_prix_vendables: verdict.sans_prix_vendables,
          manque_a_gagner: verdict.manque_a_gagner,
          trop_paye: verdict.trop_paye,
          exemples: verdict.nuits.slice(0, 5)
        }
      })
    } catch (e) {
      console.error('[contradiction-prix] incident non remonte :', e.message)
    }
  }
  return verdict
}

module.exports.surveillerContradictionPrix = surveillerContradictionPrix
