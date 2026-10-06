// api/marche-temperature.js — LE CALENDRIER DE TEMPERATURE D'UN LOGEMENT, selon
// le pipeline AirROI (lecture seule). Spec : docs/kb/chantier-nouveau-bien.md §15.
//
//   GET ?property_id=  ->  du marche relie a ce logement, la derniere capture
//                          AirROI : un niveau par jour (Creux, Modere,
//                          Favorable, Pic), le sens de chaque composante, les
//                          evenements nommes, et les analyses ; « En resume »
//                          sur les 12 mois a partir du mois en cours a Paris
//                          (spec §18).
//
// ⚠ PIPELINE ETANCHE : rien de l'historique des ventes n'est lu ici. Seul le
// calendrier officiel des vacances scolaires (`school_holidays`, dates
// publiques) est lu, pour leur impact (§19, decision de Thierry du 5 octobre
// 2026 : ce n'est pas un melange de pipelines).
// ⚠ AUCUN PRIX dans la reponse, ni en euros ni en base 100 (§15.6).
// ⚠ SECURITE : garde du LOGEMENT (meme garde que api/marche-global.js) ; seul
// le marche relie a CE logement (`marche_biens`) est lu. Pas de lien : « marche
// inconnu », jamais un autre marche.
// ⚠ AUCUN APPEL AIRROI, aucune ecriture.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { lireDerniereCapture, pourLEcran } = require('../lib/marche/temperature-airroi')
const { lireVacances, etendueSource } = require('../lib/yield/vacances')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
// Le mois en cours, a l'heure de Paris : le depart des 12 mois du resume (§18),
// le meme que celui du calendrier de la page.
const moisDeParis = (maintenant = new Date()) => maintenant.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0, 7)
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
    if (absente(lien.error, 'marche_biens')) return res.status(200).json({ source: 'airroi', etat: 'marche_inconnu', motif: 'le lien entre les logements et les marchés n’existe pas encore' })
    if (lien.error) throw new Error(`marche_biens : ${lien.error.message}`)
    const brutLien = (lien.data || [])[0]
    // Le marche se lit en forme NFC, comme a l'ecriture.
    const nfc = v => String(v || '').normalize('NFC')
    const m = brutLien ? { pays: nfc(brutLien.pays), region: nfc(brutLien.region), localite: nfc(brutLien.localite) } : null
    if (!m) return res.status(200).json({ source: 'airroi', etat: 'marche_inconnu' })
    const c = await lireDerniereCapture(supabase, m)
    if (c.erreur) {
      if (/marche_temperature_airroi/.test(c.erreur) && /(does not exist|schema cache)/i.test(c.erreur)) {
        return res.status(200).json({ source: 'airroi', etat: 'capture_absente', marche: m, motif: 'le calendrier de température n’est pas encore disponible' })
      }
      throw new Error(`marche_temperature_airroi : ${c.erreur}`)
    }
    if (!c.capture_le) {
      return res.status(200).json({ source: 'airroi', etat: 'capture_absente', marche: m,
        // ⚠ Le message va a l'HOTE : ni cout, ni jargon (revue de 675ed3b). Le
        // geste technique (une capture, par un script) est dans la spec §15.
        motif: 'le calendrier de température n’a pas encore été établi pour ce marché' })
    }
    // §19 : les vacances de la fenetre ; illisibles (null), seul leur bloc le dit.
    const depart = moisDeParis()
    const [a0, m0] = depart.split('-').map(Number)
    const fin = new Date(Date.UTC(a0, m0 - 1 + 12, 0)).toISOString().slice(0, 10)
    // Et jusqu'ou elles sont connues : la zone publiee le moins loin fixe la
    // borne (review de 7a11102 : une annee non importee disparaissait en silence).
    let vacances
    let connuesJusquau = null
    try {
      const [v, etendue] = await Promise.all([lireVacances(supabase, `${depart}-01`, fin), etendueSource(supabase)])
      vacances = v
      const fins = (etendue || []).map(e => e.date_fin).filter(Boolean).sort()
      connuesJusquau = fins.length ? fins[0] : null
    } catch (e) {
      console.error('[marche-temperature] vacances', e.message)
      vacances = null
    }
    return res.status(200).json({ source: 'airroi', etat: 'calcule', marche: m, ...pourLEcran(c, depart, vacances, connuesJusquau) })
  } catch (e) {
    console.error('[marche-temperature]', e.message)
    return res.status(503).json({ error: 'temperature_illisible' })
  }
}
