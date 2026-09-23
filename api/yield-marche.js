// api/yield-marche.js — LA GRILLE DU MARCHE, pour le bloc replie de
// « Prediction de prix ». Lot V2.5. Cadrage : docs/kb/chantier-nouveau-bien.md.
//
//   GET ?property_id=  ->  le dernier releve du controle, s'il est lisible.
//
// ⚠ INFORMATION PARALLELE, LECTURE SEULE : rien ici n'appelle AirROI (les
// appels payants passent par les scripts et le rafraichissement, jamais par
// l'ouverture d'une page) et rien ne touche un prix.
// ⚠ REGLE 19 (lib/marche/critere.js) : tant que le critere de l'interrupteur
// n'est pas grave, l'endpoint ne rend NI les ecarts NI les niveaux de la grille
// marche — qui donneraient l'ecart par soustraction. Il dit seulement qu'un
// releve existe, sa date et son statut.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { relevesLisibles } = require('../lib/marche/critere')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'methode_non_supportee' })
  }
  const brut = v => (Array.isArray(v) ? v[0] : v)
  const propertyId = String(brut(req.query.property_id) || '').trim()
  if (!propertyId) return res.status(400).json({ error: 'bien_requis' })
  const garde = await requirePermission(req, res, {
    domaine: 'reservations', niveau: 'read', bien: propertyId, bienRequis: true
  })
  if (!garde.ok) return
  try {
    const { data: releves, error } = await supabase.from('grille_controle')
      .select('*').eq('property_id', garde.bien.id).order('releve_le', { ascending: false }).limit(1)
    // Table absente (migration pas encore collee) : le bloc dit « pas encore ».
    if (error && /grille_controle/.test(error.message || '') && /(does not exist|schema cache)/i.test(error.message || '')) {
      return res.status(200).json({ source: 'marche', etat: 'pas_de_releve', lisible: false })
    }
    if (error) throw new Error(`grille_controle : ${error.message}`)
    const r = (releves || [])[0]
    if (!r) return res.status(200).json({ source: 'marche', etat: 'pas_de_releve', lisible: false })
    const lisible = relevesLisibles()
    const commun = { source: 'marche', etat: 'releve', lisible, releve_le: r.releve_le, statut: r.statut,
      fraicheur_marche: r.fraicheur_marche, fenetre: { debut: r.fenetre_debut, fin: r.fenetre_fin },
      nb_comparables: Array.isArray(r.comparables) ? r.comparables.length : 0 }
    if (!lisible) return res.status(200).json(commun)
    return res.status(200).json({ ...commun,
      niveaux_marche: r.niveaux_marche, niveaux_mesure_12m: r.niveaux_mesure_12m,
      niveaux_mesure_3ans: r.niveaux_mesure_3ans, ecarts: r.ecarts,
      nuits_marche: r.nuits_marche, nuits_mesure_12m: r.nuits_mesure_12m,
      comparables: r.comparables, avertissements: r.avertissements })
  } catch (e) {
    console.error('[yield-marche]', e.message)
    return res.status(500).json({ error: 'lecture_impossible' })
  }
}
