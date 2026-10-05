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
const { reunirEtTrier } = require('../lib/marche/pertinence')
const { rechercheDuProfil, validerChoix, enregistrerChoix, corpsRechercheEquipements, COUTS, QUOTA, MESSAGE_QUOTA } = require('../lib/marche/choix-comparables')
const { FRAICHEUR_JOURS } = require('../lib/airroi/cout')
const { comparablesRetenus } = require('../lib/marche/etude')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const ENDPOINT = 'GET /listings/comparables'
const ENDPOINT_EQ = 'POST /listings/search/radius'

// Ce que l'ecran voit du profil. §21.4 : SA position, pour son marqueur sur la
// carte. Elle est servie a qui peut lire les reservations de ce bien (titulaire
// et membres delegues de ce bien) — rien de plus que l'adresse, deja servie.
const profilPublic = p => (p ? {
  adresse: p.adresse, adresse_trouvee: p.adresse_trouvee, voyageurs: p.voyageurs, chambres: p.chambres,
  pieces: p.pieces, salles_de_bain: p.salles_de_bain, equipements: p.equipements, maj_le: p.maj_le,
  latitude: p.latitude, longitude: p.longitude,
} : null)

// Une reponse AirROI en cache, FRAICHE seulement (au-dela de sa duree de
// fraicheur, elle n'est plus proposee). Rien n'est paye. Rend le tableau `champ`
// de la reponse, ou null.
async function cacheFrais (endpoint, params, champ, maintenant = new Date()) {
  const cle = cleCanonique(endpoint, params)
  const { data, error } = await supabase.from('airroi_cache').select('reponse, recupere_le').eq('cle', cle).limit(1)
  if (error) throw new Error(`airroi_cache : ${error.message}`)
  const l = (data || [])[0]
  if (!l) return null
  if ((maintenant - new Date(l.recupere_le)) / 86400000 > FRAICHEUR_JOURS[endpoint]) return null
  let donnees
  try { donnees = lireJson(l.reponse) } catch (e) { return null }
  return donnees && Array.isArray(donnees[champ]) ? donnees[champ] : []
}
// La liste de base de CE profil (les 25 voisins).
const listeEnCache = profil => cacheFrais(ENDPOINT, { ...rechercheDuProfil(profil), currency: 'native' }, 'listings')
// La recherche par equipement de CE profil (§21.2) : [] s'il n'a aucun
// equipement rare, null si elle reste a faire.
async function complementEnCache (profil) {
  const corps = corpsRechercheEquipements(profil)
  return corps ? cacheFrais(ENDPOINT_EQ, corps, 'results') : []
}

// Une table V2 pas encore installee (migration non appliquee) : la page le dit,
// sans erreur brute (review de 4f19d8b, C3).
const tableAbsente = e => /(bien_profil|comparables_retenus|comparables_recherches|reserver_recherche_comparables|airroi_cache|airroi_appels)/.test(String(e && e.message)) && /(does not exist|schema cache)/i.test(String(e && e.message))
const INDISPONIBLE = 'Cette page n’est pas encore disponible pour ce logement.'

// ⚠ LE QUOTA EST ATOMIQUE (review de 7ace057, SECURITE) : la fonction SQL compte
// et reserve sous verrou, dans une meme transaction. Rend 'ok' ou le plafond
// atteint ; une reponse illisible est un REFUS (jamais un paiement par defaut).
// §21.3 : chaque appel payant reserve son COUT (0,10 $ ou 0,50 $).
async function reserverRecherche ({ bienId, compte, cout }) {
  const { data, error } = await supabase.rpc('reserver_recherche_comparables', {
    p_user: compte, p_property: bienId, p_cout: cout,
    p_bien_jour: QUOTA.parBienJour, p_compte_jour: QUOTA.parCompteJour,
    p_compte_30j: QUOTA.parCompte30j, p_budget_mois: QUOTA.budgetMoisUsd,
  })
  if (error) throw new Error(`reserver_recherche_comparables : ${error.message}`)
  return typeof data === 'string' ? data : 'illisible'
}
// Un appel qui a echoue RAND sa reservation (review de 25ab9e6, C1). Son propre
// echec n'empeche rien : il est journalise.
async function rendreRecherche ({ bienId, cout }) {
  try {
    const { error } = await supabase.rpc('rendre_recherche_comparables', { p_property: bienId, p_cout: cout })
    if (error) console.error('[marche-comparables] rendre', error.message)
  } catch (e) { console.error('[marche-comparables] rendre', e.message) }
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
      const lignes = await comparablesRetenus(supabase, bienId)
      const base = profil ? await listeEnCache(profil) : null
      const complement = base ? await complementEnCache(profil) : null
      // Les retenus du FONDATEUR sont dits a part : la page les montre
      // verrouilles, et compte ceux qui sont hors de la liste (review de 7ace057).
      return res.status(200).json({ etat: 'calcule', profil: profilPublic(profil),
        retenus: lignes.map(r => r.listing_id),
        fondateur: lignes.filter(r => r.retenu_par === 'fondateur').map(r => r.listing_id),
        comparables: base ? reunirEtTrier(base, complement || [], profil) : null,
        // La recherche par equipement reste a faire : la page propose de la lancer.
        complement_a_chercher: !!(base && complement === null) })
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
      // ⚠ Une liste FRAICHE en cache est servie telle quelle, sans appeler le
      // client (il relirait le cache et paierait sans reservation s'il expirait
      // entre-temps — verification de 13ffd29). Chaque appel payant RESERVE son
      // cout d'abord (§21.3) ; le client n'est cree que s'il faut payer.
      let client = null
      const leClient = () => (client = client || creerClient({ depot: depotSupabase(supabase) }))
      const ctx = { propertyId: bienId, userId: compte }
      const panne = 'La liste des biens du marché n’est pas disponible pour le moment. Réessayez plus tard.'
      let base = await listeEnCache(profil)
      if (!base) {
        const motif = await reserverRecherche({ bienId, compte, cout: COUTS.base })
        if (motif !== 'ok') return res.status(200).json({ etat: 'indisponible', message: MESSAGE_QUOTA[motif] || MESSAGE_QUOTA.mois })
        try {
          const r = await leClient().comparables(rechercheDuProfil(profil), ctx)
          base = r && r.donnees && Array.isArray(r.donnees.listings) ? r.donnees.listings : []
        } catch (e) {
          // Garde-fou, cle absente, AirROI en panne : une phrase simple pour
          // l'hote ; le detail au journal (jamais de cle : client.js la masque).
          console.error('[marche-comparables] airroi', e && (e.code || e.message))
          await rendreRecherche({ bienId, cout: COUTS.base })
          return res.status(200).json({ etat: 'indisponible', message: panne })
        }
      }
      // La recherche par equipement (§21.2) : son echec n'empeche jamais la
      // liste de base, il se dit.
      let complement = await complementEnCache(profil)
      let note = null
      if (complement === null) {
        // Une panne de la reservation elle-meme n'empeche pas la liste de base
        // (review de 25ab9e6, C2) : on refuse le complement, sans payer.
        let motif
        try { motif = await reserverRecherche({ bienId, compte, cout: COUTS.equipements }) } catch (e) {
          console.error('[marche-comparables] reservation equipements', e.message)
          motif = 'panne'
        }
        if (motif !== 'ok') {
          complement = []
          note = motif === 'panne' ? 'La recherche des biens qui ont vos équipements n’est pas disponible pour le moment.'
            : 'La recherche des biens qui ont vos équipements n’a pas pu être lancée : ' + (MESSAGE_QUOTA[motif] || MESSAGE_QUOTA.mois).charAt(0).toLowerCase() + (MESSAGE_QUOTA[motif] || MESSAGE_QUOTA.mois).slice(1)
        } else {
          try {
            const r = await leClient().rechercheEquipements(corpsRechercheEquipements(profil), ctx)
            complement = r && r.donnees && Array.isArray(r.donnees.results) ? r.donnees.results : []
          } catch (e) {
            console.error('[marche-comparables] airroi equipements', e && (e.code || e.message))
            await rendreRecherche({ bienId, cout: COUTS.equipements })
            complement = []
            note = 'La recherche des biens qui ont vos équipements n’est pas disponible pour le moment.'
          }
        }
      }
      const lignes = await comparablesRetenus(supabase, bienId)
      return res.status(200).json({ etat: 'calcule', comparables: reunirEtTrier(base, complement, profil), note,
        retenus: lignes.map(x => x.listing_id), fondateur: lignes.filter(x => x.retenu_par === 'fondateur').map(x => x.listing_id) })
    }

    if (corps.action === 'retenir') {
      const profil = await lireProfil(supabase, bienId)
      if (!profil) return res.status(400).json({ error: 'profil_absent', message: 'Décrivez d’abord votre logement.' })
      const base = await listeEnCache(profil)
      if (!base) return res.status(400).json({ error: 'liste_absente', message: 'Relancez la recherche des biens du marché.' })
      // Les biens proposes : la liste de base ET ceux trouves par equipement.
      const v = validerChoix(corps.listing_ids, [...base, ...((await complementEnCache(profil)) || [])])
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
