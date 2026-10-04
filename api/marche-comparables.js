// api/marche-comparables.js — « CHOISIR VOS COMPARABLES » (spec §20 de
// docs/kb/chantier-nouveau-bien.md).
//
//   GET  ?property_id=                         le profil du bien, les comparables
//                                               retenus, et la derniere liste AirROI
//                                               SI ELLE EST EN CACHE (aucun appel paye)
//   POST ?property_id= { action: 'profil', … } decrit le bien (adresse geocodee)
//   POST ?property_id= { action: 'chercher' }  les 25 comparables, tries (cache,
//                                               sinon un appel AirROI a 0,10 $)
//   POST ?property_id= { action: 'retenir', listing_ids } au moins 3, tous dans la liste
//
// ⚠ SECURITE : garde du LOGEMENT, bien requis. Lecture : `reservations` en
// lecture ; tout ce qui ecrit ou PAIE : `reglages` en ecriture. Les lignes
// portent le COMPTE resolu par la garde (`accountUserId`), jamais l'identite de
// l'appelant (review de a52b3e4, S3).
// ⚠ L'APPEL PAYANT EST UN POST : un GET ne paie jamais, meme rejoue par un
// navigateur ou un robot.
// ⚠ ON PREND A AIRROI SA DONNEE, JAMAIS SES PRIX : la reponse ne porte que des
// cartes construites par liste blanche (lib/marche/pertinence.js).
// ⚠ La cle AirROI reste au serveur (lib/airroi/client.js).

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { creerClient, cleCanonique } = require('../lib/airroi/client')
const { depotSupabase } = require('../lib/airroi/depot')
const { lireJson } = require('../lib/airroi/json')
const { validerProfil, geocoder, lireProfil, enregistrerProfil } = require('../lib/marche/profil-bien')
const { trierComparables } = require('../lib/marche/pertinence')
const { rechercheDuProfil, validerChoix, enregistrerChoix, jugerQuota } = require('../lib/marche/choix-comparables')
const { FRAICHEUR_JOURS } = require('../lib/airroi/cout')
const { comparablesRetenus } = require('../lib/marche/etude')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const ENDPOINT = 'GET /listings/comparables'

// Ce que l'ecran voit du profil : pas de position brute.
const profilPublic = p => (p ? {
  adresse: p.adresse, adresse_trouvee: p.adresse_trouvee, voyageurs: p.voyageurs, chambres: p.chambres,
  pieces: p.pieces, salles_de_bain: p.salles_de_bain, equipements: p.equipements, maj_le: p.maj_le,
} : null)

// La derniere liste AirROI de CE profil, en cache seulement (rien n'est paye),
// et FRAICHE : au-dela de sa duree de fraicheur, elle n'est plus proposee.
async function listeEnCache (profil, maintenant = new Date()) {
  const cle = cleCanonique(ENDPOINT, { ...rechercheDuProfil(profil), currency: 'native' })
  const { data, error } = await supabase.from('airroi_cache').select('reponse, recupere_le').eq('cle', cle).limit(1)
  if (error) throw new Error(`airroi_cache : ${error.message}`)
  const l = (data || [])[0]
  if (!l) return null
  if ((maintenant - new Date(l.recupere_le)) / 86400000 > FRAICHEUR_JOURS[ENDPOINT]) return null
  let donnees
  try { donnees = lireJson(l.reponse) } catch (e) { return null }
  return { listings: (donnees && Array.isArray(donnees.listings)) ? donnees.listings : [], recupere_le: l.recupere_le }
}

// Une table V2 pas encore installee (migration non appliquee) : la page le dit,
// sans erreur brute (review de 4f19d8b, C3).
const tableAbsente = e => /(bien_profil|comparables_retenus|airroi_cache|airroi_appels)/.test(String(e && e.message)) && /(does not exist|schema cache)/i.test(String(e && e.message))
const INDISPONIBLE = 'Cette page n’est pas encore disponible pour ce logement.'

// Le quota des recherches nouvelles (S1) : lu dans le journal des appels.
async function quotaAtteint (depot, { bienId, compte }) {
  const now = Date.now()
  const jour = new Date(now - 86400000).toISOString()
  const d = new Date(now)
  const mois = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
  const deCetEndpoint = l => (l || []).filter(a => a.endpoint === ENDPOINT).length
  const [bienJour, compteJour, toutMois] = await Promise.all([
    depot.appelsDepuis({ depuis: jour, propertyId: bienId }),
    depot.appelsDepuis({ depuis: jour, userId: compte }),
    depot.appelsDepuis({ depuis: mois }),
  ])
  return jugerQuota({ bienJour: deCetEndpoint(bienJour), compteJour: deCetEndpoint(compteJour), mois: deCetEndpoint(toutMois) })
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'methode_non_supportee' })
  }
  const brut = v => (Array.isArray(v) ? v[0] : v)
  const propertyId = String(brut(req.query && req.query.property_id) || '').trim()
  if (!propertyId) return res.status(400).json({ error: 'bien_requis' })
  const lecture = req.method === 'GET'
  const garde = await requirePermission(req, res, lecture
    ? { domaine: 'reservations', niveau: 'read', bien: propertyId, bienRequis: true }
    : { domaine: 'reglages', niveau: 'write', bien: propertyId, bienRequis: true })
  if (!garde.ok) return
  const bienId = garde.bien.id
  const compte = garde.accountUserId
  try {
    if (lecture) {
      const profil = await lireProfil(supabase, bienId)
      const retenus = (await comparablesRetenus(supabase, bienId)).map(r => r.listing_id)
      const liste = profil ? await listeEnCache(profil) : null
      return res.status(200).json({ etat: 'calcule', profil: profilPublic(profil), retenus,
        comparables: liste ? trierComparables(liste.listings, profil) : null })
    }

    const corps = req.body && typeof req.body === 'object' ? req.body : {}
    if (corps.action === 'profil') {
      const v = validerProfil(corps)
      if (v.erreur) return res.status(400).json({ error: 'profil_invalide', message: v.erreur })
      const geo = await geocoder(v.profil.adresse)
      if (geo.erreur) {
        if (geo.technique) console.error('[marche-comparables] geocodage', geo.technique)
        return res.status(400).json({ error: 'adresse_introuvable', message: geo.erreur })
      }
      await enregistrerProfil(supabase, { userId: compte, propertyId: bienId, profil: v.profil, geo })
      return res.status(200).json({ etat: 'enregistre', profil: profilPublic(await lireProfil(supabase, bienId)) })
    }

    if (corps.action === 'chercher') {
      const profil = await lireProfil(supabase, bienId)
      if (!profil) return res.status(400).json({ error: 'profil_absent', message: 'Décrivez d’abord votre logement.' })
      const depot = depotSupabase(supabase)
      // Une liste fraiche en cache ne coute rien ; sinon, le quota d'abord.
      const fraiche = await listeEnCache(profil)
      if (!fraiche && await quotaAtteint(depot, { bienId, compte })) {
        return res.status(200).json({ etat: 'indisponible', message: 'Plusieurs recherches ont déjà été lancées récemment. Réessayez demain.' })
      }
      const client = creerClient({ depot })
      let r
      try {
        r = await client.comparables(rechercheDuProfil(profil), { propertyId: bienId, userId: compte })
      } catch (e) {
        // Garde-fou de cout, cle absente, AirROI en panne : l'hote lit une phrase
        // simple ; le detail va au journal (jamais de cle : client.js la masque).
        console.error('[marche-comparables] airroi', e && (e.code || e.message))
        return res.status(200).json({ etat: 'indisponible', message: 'La liste des biens du marché n’est pas disponible pour le moment. Réessayez plus tard.' })
      }
      const listings = r && r.donnees && Array.isArray(r.donnees.listings) ? r.donnees.listings : []
      const retenus = (await comparablesRetenus(supabase, bienId)).map(x => x.listing_id)
      return res.status(200).json({ etat: 'calcule', comparables: trierComparables(listings, profil), retenus })
    }

    if (corps.action === 'retenir') {
      const profil = await lireProfil(supabase, bienId)
      if (!profil) return res.status(400).json({ error: 'profil_absent', message: 'Décrivez d’abord votre logement.' })
      const liste = await listeEnCache(profil)
      if (!liste) return res.status(400).json({ error: 'liste_absente', message: 'Relancez la recherche des biens du marché.' })
      const v = validerChoix(corps.listing_ids, liste.listings)
      if (v.erreur) return res.status(400).json({ error: 'choix_invalide', message: v.erreur })
      await enregistrerChoix(supabase, { userId: compte, propertyId: bienId, ids: v.ids })
      return res.status(200).json({ etat: 'enregistre', retenus: v.ids })
    }

    return res.status(400).json({ error: 'action_inconnue' })
  } catch (e) {
    if (tableAbsente(e)) {
      console.error('[marche-comparables] table absente', e.message)
      return res.status(200).json({ etat: 'indisponible', message: INDISPONIBLE })
    }
    console.error('[marche-comparables]', e.message)
    return res.status(500).json({ error: 'lecture_impossible' })
  }
}
