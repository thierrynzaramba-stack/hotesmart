// api/marche-global.js — LE MARCHE GLOBAL D'UN LOGEMENT (lecture seule).
// Lot « marche global » (cadrage docs/kb/chantier-nouveau-bien.md §14).
//
//   GET ?property_id=  ->  l'indicateur 1 (RevPAR mois par mois, quantiles,
//                          couverture) du marche relie a ce logement.
//
// ⚠ SECURITE (lecon de V2.3.4) : garde du LOGEMENT (lecture des reservations,
// bien requis : le bien designe le compte) ; seul le marche relie a CE
// logement (`marche_biens`) est lu. Pas de lien : « marche inconnu », jamais
// un autre marche.
// ⚠ AUCUN APPEL AIRROI, JAMAIS DEPUIS UN ECRAN : les 60 mois se lisent dans
// `airroi_cache`, sous la cle canonique du client. Absents : on le dit, avec
// le cout de l'etude (0,50 $, par un script), sans rien payer.
// ⚠ Aucune ecriture, aucune table de l'existant lue hors la garde.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { cleCanonique } = require('../lib/airroi/client')
const { lireJson } = require('../lib/airroi/json')
const { revparMensuel } = require('../lib/marche/marche-global')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const absente = (error, t) => error && new RegExp(t).test(error.message || '') && /(does not exist|schema cache)/i.test(error.message || '')

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'methode_non_supportee' })
  }
  const brut = v => (Array.isArray(v) ? v[0] : v)
  const propertyId = String(brut(req.query.property_id) || '').trim()
  if (!propertyId) return res.status(400).json({ error: 'bien_requis' })
  const garde = await requirePermission(req, res, { domaine: 'reservations', niveau: 'read', bien: propertyId, bienRequis: true })
  if (!garde.ok) return
  try {
    const lien = await supabase.from('marche_biens').select('pays, region, localite').eq('property_id', garde.bien.id).limit(1)
    if (absente(lien.error, 'marche_biens')) return res.status(200).json({ source: 'marche', etat: 'marche_inconnu', motif: 'le lien entre logements et marches n existe pas encore' })
    if (lien.error) throw new Error(`marche_biens : ${lien.error.message}`)
    const m = (lien.data || [])[0]
    if (!m) return res.status(200).json({ source: 'marche', etat: 'marche_inconnu', motif: 'aucun marche relie a ce logement' })
    // La cle que le client AirROI calcule pour les 60 mois de ce marche.
    const cle = cleCanonique('POST /markets/metrics/all', { market: { country: m.pays, region: m.region, locality: m.localite }, num_months: 60, currency: 'native' })
    const c = await supabase.from('airroi_cache').select('reponse, recupere_le').eq('cle', cle).limit(1)
    if (absente(c.error, 'airroi_cache')) return res.status(200).json({ source: 'marche', etat: 'historique_absent', marche: m, motif: 'le cache AirROI n existe pas encore' })
    if (c.error) throw new Error(`airroi_cache : ${c.error.message}`)
    const ligne = (c.data || [])[0]
    if (!ligne) {
      return res.status(200).json({ source: 'marche', etat: 'historique_absent', marche: m,
        motif: 'les 60 mois de ce marche ne sont pas encore etudies (0,50 $, par un script, jamais depuis cet ecran)' })
    }
    const indicateur1 = revparMensuel(lireJson(ligne.reponse))
    return res.status(200).json({ source: 'marche', etat: 'calcule', marche: m, recupere_le: ligne.recupere_le, revpar: indicateur1 })
  } catch (e) {
    console.error('[marche-global]', e.message)
    return res.status(500).json({ error: 'lecture_impossible' })
  }
}
