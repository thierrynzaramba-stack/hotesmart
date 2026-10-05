// api/marche-comparables.js — « CHOISIR VOS COMPARABLES » (spec §20 de
// docs/kb/chantier-nouveau-bien.md).
//
//   GET  ?property_id=                         le profil du bien, les comparables
//                                               retenus, et la derniere liste AirROI
//                                               SI ELLE EST EN CACHE (aucun appel paye)
//   POST ?property_id= { action: 'profil', … } decrit le bien (adresse geocodee)
//   POST ?property_id= { action: 'chercher' }  la selection (§22.10) : bien avec
//                                               equipement rare, 20 biens ACTIFS qui
//                                               l'ont, tries par revenu (2 pages,
//                                               0,50 $ chacune) ; sinon les 25 voisins
//                                               ACTIFS (0,10 $). Cache d'abord.
//   POST ?property_id= { action: 'plus' }      10 biens de plus (0,50 $), 50 au plus
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
const { validerProfil, validerStrategie, geocoder, lireProfil, enregistrerProfil, enregistrerStrategie } = require('../lib/marche/profil-bien')
const { reunirEtTrier, cartesDansLOrdre, repartitionSejourMin } = require('../lib/marche/pertinence')
const { seulementActives } = require('../lib/marche/activite')
const { prixDeDepart } = require('../lib/marche/prix-depart')
const { lireDerniereCapture } = require('../lib/marche/temperature-airroi')
const { rechercheDuProfil, validerChoix, enregistrerChoix, corpsRechercheActifs, PAGE, PAGES_INITIALES, PAGES_MAX, COUTS, QUOTA, MESSAGE_QUOTA, CALENDRIERS_PAR_BIEN } = require('../lib/marche/choix-comparables')
const { FRAICHEUR_JOURS } = require('../lib/airroi/cout')
const { comparablesRetenus } = require('../lib/marche/etude')
const { annoncesRetirees, noterRetiree, sansRetirees } = require('../lib/marche/annonces-retirees')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const ENDPOINT = 'GET /listings/comparables'
const ENDPOINT_EQ = 'POST /listings/search/radius'
const ENDPOINT_CAL = 'GET /listings/live/calendar'

// Ce que l'ecran voit du profil. §21.4 : SA position, pour son marqueur sur la
// carte. Elle est servie a qui peut lire les reservations de ce bien (titulaire
// et membres delegues de ce bien) — rien de plus que l'adresse, deja servie.
const profilPublic = p => (p ? {
  adresse: p.adresse, adresse_trouvee: p.adresse_trouvee, voyageurs: p.voyageurs, chambres: p.chambres,
  pieces: p.pieces, salles_de_bain: p.salles_de_bain, equipements: p.equipements, maj_le: p.maj_le,
  latitude: p.latitude, longitude: p.longitude,
  // §22.2 : nulles tant que l'hote n'a pas repondu.
  strategie: p.strategie || null, sejour_min: Number.isInteger(p.sejour_min) ? p.sejour_min : null,
} : null)

// Une reponse AirROI en cache, FRAICHE seulement (au-dela de sa duree de
// fraicheur, elle n'est plus proposee). Rien n'est paye. Rend le tableau `champ`
// de la reponse, ou null.
async function cacheFrais (endpoint, params, champ, maintenant = new Date()) {
  const d = await reponseFraiche(endpoint, params, maintenant)
  if (d === null) return null
  return d && Array.isArray(d[champ]) ? d[champ] : []
}
// La reponse entiere (§22.10 : la page porte aussi `pagination.total_count`).
async function reponseFraiche (endpoint, params, maintenant = new Date()) {
  const cle = cleCanonique(endpoint, params)
  const { data, error } = await supabase.from('airroi_cache').select('reponse, recupere_le').eq('cle', cle).limit(1)
  if (error) throw new Error(`airroi_cache : ${error.message}`)
  const l = (data || [])[0]
  if (!l) return null
  if ((maintenant - new Date(l.recupere_le)) / 86400000 > FRAICHEUR_JOURS[endpoint]) return null
  let donnees
  try { donnees = lireJson(l.reponse) } catch (e) { return null }
  return donnees && typeof donnees === 'object' ? donnees : {}
}
// ⚠ §22.9 : une annonce RETIREE d'Airbnb ne s'affiche jamais. Elle est
// ecartee a la SOURCE — listes en cache, retenus — donc de la carte, du choix,
// du « au moins 3 » et du calcul.
// La liste de base de CE profil (les 25 voisins).
const listeEnCache = async profil => sansRetirees(supabase, await cacheFrais(ENDPOINT, { ...rechercheDuProfil(profil), currency: 'native' }, 'listings'))
// ⚠ §22.10 : LA SELECTION PROPOSEE, lue dans le cache (rien n'est paye).
//   - bien avec un equipement rare : les pages de la recherche des ACTIFS qui
//     l'ont, chargees A LA SUITE depuis la premiere (cache partage par zone :
//     une page chargee par un autre hote est gratuite ici), dans l'ordre
//     d'AirROI (revenu decroissant) ;
//   - sinon : les 25 voisins, tries par ressemblance.
//   Dans les deux cas, seulement les biens ACTIFS (lib/marche/activite.js) et
//   jamais une annonce retiree (§22.9).
// Rend { rare, fiches (null = a chercher), pages, encore }.
async function selectionEnCache (profil) {
  if (!corpsRechercheActifs(profil, 0)) {
    const base = await listeEnCache(profil)
    return { rare: false, fiches: base === null ? null : seulementActives(base), pages: 0, encore: false }
  }
  const pages = []
  let total = 0
  for (let i = 0; i < PAGES_MAX; i++) {
    const d = await reponseFraiche(ENDPOINT_EQ, corpsRechercheActifs(profil, i))
    if (d === null) break
    pages.push(Array.isArray(d.results) ? d.results : [])
    total = Number(d.pagination && d.pagination.total_count) || 0
    if ((i + 1) * PAGE >= total) break
  }
  if (!pages.length) return { rare: true, fiches: null, pages: 0, encore: false }
  const fiches = seulementActives(await sansRetirees(supabase, pages.flat()))
  return { rare: true, fiches, pages: pages.length, encore: pages.length < PAGES_MAX && pages.length * PAGE < total }
}
const cartesDe = (sel, profil) => (sel.rare ? cartesDansLOrdre(sel.fiches, profil) : reunirEtTrier(sel.fiches, [], profil))

// Une page de la recherche des actifs, PAYEE : reservee d'abord (0,50 $), rendue
// si rien n'a ete facture. Rend null, ou le message a dire a l'hote.
async function chargerPage (profil, page, { bienId, compte, leClient }) {
  let motif
  try { motif = await reserverRecherche({ bienId, compte, cout: COUTS.page }) } catch (e) {
    console.error('[marche-comparables] reservation page', e.message)
    return 'La recherche des biens du marché n’est pas disponible pour le moment. Réessayez plus tard.'
  }
  if (motif !== 'ok') return MESSAGE_QUOTA[motif] || MESSAGE_QUOTA.mois
  try {
    await leClient().rechercheActifs(corpsRechercheActifs(profil, page), { propertyId: bienId, userId: compte })
    return null
  } catch (e) {
    console.error('[marche-comparables] airroi page', page, e && (e.code || e.message))
    // ⚠ On ne RAND que si rien n'a ete facture (review de f37b7da, SECURITE).
    if (e && e.coutLibere === true) await rendreRecherche({ bienId, cout: COUTS.page })
    return 'La recherche des biens du marché n’est pas disponible pour le moment. Réessayez plus tard.'
  }
}
// Les comparables retenus de ce bien, sans les annonces retirees.
async function retenusEnLigne (bienId) {
  const lignes = await comparablesRetenus(supabase, bienId)
  const retirees = await annoncesRetirees(supabase, lignes.map(l => l.listing_id))
  return lignes.filter(l => !retirees.has(String(l.listing_id)))
}
// ⚠ §22.10 (review de 428fe8c) : les retenus QUI COMPTENT. Quand la selection
// est en cache, un retenu de l'hote qui n'y est plus (inactif, sans les
// equipements rares, profil change) ne compte plus : ni dans le « au moins 3 »,
// ni dans le calcul des prix — et l'hote en est averti (`horsListe`). Ceux de
// l'equipe restent (verrouilles). Sans selection en cache, on ne peut pas
// juger : tous comptent.
// §22.11 : rend aussi l'HOTE de chaque annonce de la selection (un hote = une
// voix) ; une annonce hors selection compte seule.
async function retenusProposes (bienId, profil, sel = null) {
  const lignes = await retenusEnLigne(bienId)
  const s = sel || (profil ? await selectionEnCache(profil) : null)
  if (!s || !s.fiches) return { lignes, horsListe: 0, hoteDe: new Map() }
  const idDe = f => String(f && f.listing_info && f.listing_info.listing_id)
  const proposes = new Set(s.fiches.map(idDe))
  const hoteDe = new Map(s.fiches.filter(f => f && f.host_info && f.host_info.host_id != null).map(f => [idDe(f), String(f.host_info.host_id)]))
  const garde = lignes.filter(l => l.retenu_par === 'fondateur' || proposes.has(String(l.listing_id)))
  return { lignes: garde, horsListe: lignes.length - garde.length, hoteDe }
}

// Une table V2 pas encore installee (migration non appliquee) : la page le dit,
// sans erreur brute (review de 4f19d8b, C3).
const tableAbsente = e => /(bien_profil|comparables_retenus|comparables_recherches|reserver_recherche_comparables|airroi_cache|airroi_appels|airroi_annonces_retirees)/.test(String(e && e.message)) && /(does not exist|schema cache)/i.test(String(e && e.message))
const INDISPONIBLE = 'Cette page n’est pas encore disponible pour ce logement.'

// ⚠ LE QUOTA EST ATOMIQUE (review de 7ace057, SECURITE) : la fonction SQL compte
// et reserve sous verrou, dans une meme transaction. Rend 'ok' ou le plafond
// atteint ; une reponse illisible est un REFUS (jamais un paiement par defaut).
// §21.3 : chaque appel payant reserve son COUT (0,10 $ ou 0,50 $).
async function reserverRecherche ({ bienId, compte, cout, nature = 'recherche' }) {
  const { data, error } = await supabase.rpc('reserver_recherche_comparables', {
    p_user: compte, p_property: bienId, p_cout: cout, p_nature: nature,
    p_bien_jour: QUOTA.parBienJour, p_compte_jour: QUOTA.parCompteJour,
    p_compte_30j: QUOTA.parCompte30j, p_calendriers_90j: QUOTA.calendriersBien90j,
    p_budget_mois: QUOTA.budgetMoisUsd,
  })
  if (error) throw new Error(`reserver_recherche_comparables : ${error.message}`)
  return typeof data === 'string' ? data : 'illisible'
}
// Un appel qui a echoue RAND sa reservation (review de 25ab9e6, C1). Son propre
// echec n'empeche rien : il est journalise.
async function rendreRecherche ({ bienId, cout, nature = 'recherche' }) {
  try {
    const { error } = await supabase.rpc('rendre_recherche_comparables', { p_property: bienId, p_cout: cout, p_nature: nature })
    if (error) console.error('[marche-comparables] rendre', error.message)
  } catch (e) { console.error('[marche-comparables] rendre', e.message) }
}

// ─── §22.3 et §22.7 : les prix de depart ────────────────────────────────────
// Le marche du bien doit etre celui de l'adresse de son profil : sa commune doit
// figurer EN MOTS ENTIERS dans l'adresse trouvee (review de f37b7da : « Pau »
// n'est pas dans « Saint-Paul »). Sinon, aucun calcul, aucun paiement.
const enMots = v => ` ${String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
async function marcheDuBien (bienId, profil) {
  const { data, error } = await supabase.from('marche_biens').select('pays, region, localite').eq('property_id', bienId).limit(1)
  if (error) throw new Error(`marche_biens : ${error.message}`)
  const m = (data || [])[0]
  if (!m || !String(m.localite || '').trim() || !enMots(profil.adresse_trouvee).includes(enMots(m.localite))) return null
  const nfc = v => String(v || '').normalize('NFC')
  return { pays: nfc(m.pays), region: nfc(m.region), localite: nfc(m.localite) }
}

// ⚠ Une cle du cache contient des guillemets et des virgules ; `.in()` de
// supabase-js ne les echappe pas, et la lecture rend ZERO ligne sans erreur
// (recette du 5 octobre 2026 : la page ne voyait aucun calendrier releve et
// proposait de tout repayer). La liste PostgREST, echappee a la main.
const listeEchappee = vs => `(${vs.map(v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`

// Les calendriers en cache (frais), en UNE lecture (review de f37b7da) :
// Map listing_id -> nuits.
async function calendriersEnCache (ids, maintenant = new Date()) {
  const cles = new Map(ids.map(id => [cleCanonique(ENDPOINT_CAL, { listing_id: String(id), currency: 'native' }), String(id)]))
  if (!cles.size) return new Map()
  const { data, error } = await supabase.from('airroi_cache').select('cle, reponse, recupere_le').filter('cle', 'in', listeEchappee([...cles.keys()]))
  if (error) throw new Error(`airroi_cache : ${error.message}`)
  const out = new Map()
  for (const l of data || []) {
    if ((maintenant - new Date(l.recupere_le)) / 86400000 > FRAICHEUR_JOURS[ENDPOINT_CAL]) continue
    let d; try { d = lireJson(l.reponse) } catch (e) { continue }
    if (d && Array.isArray(d.results)) out.set(cles.get(l.cle), d.results)
  }
  return out
}

const PARALLELE = 4
const SEUIL_PANNE_404 = 3
const jourParis = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' })

// Les prix de depart : `payer` faux = le cache seulement (le GET). Rend
// { etat, prix?, message?, a_capturer, note? }.
async function calculerPrix ({ bienId, compte, profil, payer }) {
  if (!profil || !profil.strategie) return { etat: 'strategie_absente', message: 'Choisissez d’abord votre stratégie de prix.' }
  const { lignes, hoteDe } = await retenusProposes(bienId, profil)
  if (lignes.filter(l => l.retenu_par !== 'fondateur').length < 3) return { etat: 'comparables_insuffisants', message: 'Choisissez d’abord au moins 3 comparables.' }
  // §22.11 : les niveaux viennent des comparables ; le marche de l'adresse ne
  // sert qu'au REPLI (segment trop plat). Son absence n'empeche rien d'emblee.
  const aujourdhui = jourParis()
  const marche = await marcheDuBien(bienId, profil)
  let jours = []
  if (marche) {
    const capture = await lireDerniereCapture(supabase, marche)
    if (capture.erreur) throw new Error(`temperature : ${capture.erreur}`)
    jours = capture.jours.filter(j => j.jour >= aujourdhui)
  }
  // ⚠ Au plus CALENDRIERS_PAR_BIEN calendriers servent au calcul (decision de
  // Thierry). §22.11 : des HOTES DIFFERENTS d'abord — jamais deux annonces du
  // meme hote tant qu'il manque des hotes independants ; dans un hote, l'annonce
  // deja en cache (gratuite) d'abord, et les hotes deja en cache d'abord. Puis
  // l'equipe, puis l'ordre du choix.
  const hoteDeL = id => hoteDe.get(id) || `annonce:${id}`
  const ordre = [...lignes.filter(l => l.retenu_par === 'fondateur'), ...lignes.filter(l => l.retenu_par !== 'fondateur')].map(l => String(l.listing_id))
  const cache = await calendriersEnCache(ordre)
  const parHote = new Map()
  for (const id of ordre) { const h = hoteDeL(id); if (!parHote.has(h)) parHote.set(h, []); parHote.get(h).push(id) }
  const enCacheDabord = xs => [...xs.filter(id => cache.has(id)), ...xs.filter(id => !cache.has(id))]
  // Un representant par hote ; parmi eux, ceux deja en cache (gratuits) d'abord.
  const premiers = enCacheDabord([...parHote.values()].map(xs => enCacheDabord(xs)[0]))
  const ids = [...premiers, ...enCacheDabord(ordre.filter(id => !premiers.includes(id)))].slice(0, CALENDRIERS_PAR_BIEN)
  let manquants = ids.filter(id => !cache.has(id))
  let refus = null
  const retireesIci = new Set()
  const introuvables = new Set()
  let reussis = 0
  if (payer && manquants.length) {
    let client = null
    const ctx = { propertyId: bienId, userId: compte }
    // Quatre releves a la fois ; chaque calendrier RESERVE son cout d'abord.
    const file = [...manquants]
    const ouvrier = async () => {
      while (file.length && !refus) {
        const id = file.shift()
        const motif = await reserverRecherche({ bienId, compte, cout: COUTS.calendrier, nature: 'calendrier' })
        if (motif !== 'ok') { refus = MESSAGE_QUOTA[motif] || MESSAGE_QUOTA.mois; return }
        try {
          client = client || creerClient({ depot: depotSupabase(supabase) })
          const r = await client.calendrierAnnonce(id, ctx)
          if (r && r.donnees && Array.isArray(r.donnees.results)) { cache.set(id, r.donnees.results); reussis++ }
        } catch (e) {
          console.error('[marche-comparables] calendrier', e && (e.code || e.message))
          // ⚠ On ne RAND que si rien n'a ete facture (review de f37b7da, SECURITE).
          // Rendre AVANT de noter (review de b83823a, C1).
          if (e && e.coutLibere === true) await rendreRecherche({ bienId, cout: COUTS.calendrier, nature: 'calendrier' })
          // §22.9 : 404 = annonce retiree d'Airbnb, notee APRES la boucle.
          if (e && e.http === 404) introuvables.add(id)
        }
      }
    }
    // ⚠ allSettled, pas all (re-review de 0fab219) : une panne dans un ouvrier
    // arrete la file pour TOUS, et la reponse attend ceux encore en vol — sinon
    // ils continuaient a payer apres elle.
    const ouvrierSur = () => ouvrier().catch(e => { refus = refus || MESSAGE_QUOTA.mois; throw e })
    const fins = await Promise.allSettled(Array.from({ length: Math.min(PARALLELE, file.length) }, ouvrierSur))
    const panne = fins.find(f => f.status === 'rejected')
    if (panne) throw panne.reason
    // ⚠ GARDE-FOU (review de b83823a, SECURITE) : le constat cache l'annonce
    // pour TOUS les hotes. Trois 404 ou plus sans AUCUN releve reussi dans le
    // meme appel ressemblent a une panne d'AirROI, pas a des annonces retirees :
    // rien n'est note. Un constat dure 30 jours (lib/marche/annonces-retirees.js).
    if (introuvables.size >= SEUIL_PANNE_404 && !reussis) {
      console.error(`[marche-comparables] ${introuvables.size} calendriers en 404 sans aucun releve reussi : panne presumee, rien n'est note`)
    } else {
      for (const id of introuvables) {
        try { await noterRetiree(supabase, id, 404); retireesIci.add(id) } catch (e) {
          console.error('[marche-comparables] annonce retiree', e.message)
        }
      }
    }
    manquants = ids.filter(id => !cache.has(id) && !retireesIci.has(id))
  }
  const calendriers = lignes.filter(l => ids.includes(String(l.listing_id)) && cache.has(String(l.listing_id))).map(l => ({
    listing_id: String(l.listing_id), hote: hoteDeL(String(l.listing_id)), position: l.retenu_par === 'fondateur' ? 'equivalent' : l.position,
    jours: cache.get(String(l.listing_id)).filter(n => n && String(n.date) >= aujourdhui),
  }))
  // Rien en cache et rien paye : il faut relever.
  if (!calendriers.length) return { etat: 'a_capturer', a_capturer: manquants.length, note: refus }
  // Avec ce qui est disponible, on calcule ; les manquants se proposent a cote
  // (review de f37b7da, C4 : le GET et le POST disent la meme chose).
  const prix = prixDeDepart({ calendriers, marche: jours, strategie: profil.strategie, aujourdhui })
  return { etat: 'calcule', prix, a_capturer: manquants.length,
    note: refus || (manquants.length ? `Les prix de ${manquants.length} comparable${manquants.length > 1 ? 's' : ''} ne sont pas encore relevés.` : null) }
}

// Au GET, une panne du calcul des prix n'empeche pas les comparables (C3).
async function prixSansPanne (o) {
  try { return await calculerPrix(o) } catch (e) {
    console.error('[marche-comparables] prix', e.message)
    return { etat: 'erreur', message: 'Vos prix de départ sont momentanément indisponibles.' }
  }
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
      const sel = profil ? await selectionEnCache(profil) : { fiches: null, encore: false }
      const { lignes, horsListe } = await retenusProposes(bienId, profil, sel)
      // Les retenus du FONDATEUR sont dits a part : la page les montre
      // verrouilles, et compte ceux qui sont hors de la liste (review de 7ace057).
      return res.status(200).json({ etat: 'calcule', profil: profilPublic(profil),
        retenus: lignes.map(r => r.listing_id),
        fondateur: lignes.filter(r => r.retenu_par === 'fondateur').map(r => r.listing_id),
        positions: Object.fromEntries(lignes.filter(r => r.position).map(r => [r.listing_id, r.position])),
        comparables: sel.fiches ? cartesDe(sel, profil) : null,
        // §22.2 : ce que pratique le marche en sejour minimum (lu dans les fiches).
        marche_sejour_min: sel.fiches ? repartitionSejourMin(sel.fiches) : null,
        // §22.10 : AirROI en a d'autres, et on n'en a pas 50 : « Voir 10 de plus ».
        encore: !!sel.encore,
        retenus_hors_liste: horsListe,
        // §22.7 : les prix de depart, depuis le cache seulement (un GET ne paie jamais).
        prix_depart: profil ? await prixSansPanne({ bienId, compte, profil, payer: false }) : null })
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

    // §22.10 : la selection. « chercher » charge ce qui manque des 2 premieres
    // pages (ou la liste des voisins) ; « plus » charge la page suivante.
    if (corps.action === 'chercher' || corps.action === 'plus') {
      const profil = await lireProfil(supabase, bienId)
      if (!profil) return res.status(400).json({ error: 'profil_absent', message: 'Décrivez d’abord votre logement.' })
      // ⚠ Une page FRAICHE en cache est servie telle quelle, sans appeler le
      // client (il relirait le cache et paierait sans reservation s'il expirait
      // entre-temps — verification de 13ffd29). Chaque appel payant RESERVE son
      // cout d'abord (§21.3) ; le client n'est cree que s'il faut payer.
      let client = null
      const leClient = () => (client = client || creerClient({ depot: depotSupabase(supabase) }))
      const panne = 'La liste des biens du marché n’est pas disponible pour le moment. Réessayez plus tard.'
      let sel = await selectionEnCache(profil)
      let note = null
      if (sel.rare) {
        if (corps.action === 'plus' && sel.fiches) {
          if (!sel.encore) return res.status(400).json({ error: 'plus_rien', message: 'Il n’y a pas d’autres biens à voir.' })
          note = await chargerPage(profil, sel.pages, { bienId, compte, leClient })
        } else {
          // « plus » sans selection en cache (la 1re page a expire, review de
          // 428fe8c) : on recharge le debut, comme « chercher ».
          // Les pages manquantes parmi les 2 premieres, a la suite.
          // ⚠ AU PLUS 2 TOURS, et arret si la page payee ne se relit pas dans le
          // cache : jamais une boucle qui paie sans fin (review de 428fe8c).
          for (let tour = 0; tour < PAGES_INITIALES && !note && sel.pages < PAGES_INITIALES && (sel.pages === 0 || sel.encore); tour++) {
            const avant = sel.pages
            note = await chargerPage(profil, sel.pages, { bienId, compte, leClient })
            if (note) break
            sel = await selectionEnCache(profil)
            if (sel.pages <= avant) {
              console.error('[marche-comparables] page payee mais absente du cache : arret')
              note = 'La recherche des biens du marché n’est pas disponible pour le moment. Réessayez plus tard.'
            }
          }
        }
        sel = await selectionEnCache(profil)
        if (!sel.fiches) return res.status(200).json({ etat: 'indisponible', message: note || panne })
      } else {
        if (corps.action === 'plus') return res.status(400).json({ error: 'plus_rien', message: 'Il n’y a pas d’autres biens à voir.' })
        if (!sel.fiches) {
          const motif = await reserverRecherche({ bienId, compte, cout: COUTS.base })
          if (motif !== 'ok') return res.status(200).json({ etat: 'indisponible', message: MESSAGE_QUOTA[motif] || MESSAGE_QUOTA.mois })
          try {
            await leClient().comparables(rechercheDuProfil(profil), { propertyId: bienId, userId: compte })
          } catch (e) {
            // Garde-fou, cle absente, AirROI en panne : une phrase simple pour
            // l'hote ; le detail au journal (jamais de cle : client.js la masque).
            console.error('[marche-comparables] airroi', e && (e.code || e.message))
            // ⚠ On ne RAND que si rien n'a ete facture (review de f37b7da, SECURITE).
            if (e && e.coutLibere === true) await rendreRecherche({ bienId, cout: COUTS.base })
            return res.status(200).json({ etat: 'indisponible', message: panne })
          }
          sel = await selectionEnCache(profil)
          if (!sel.fiches) return res.status(200).json({ etat: 'indisponible', message: panne })
        }
      }
      const { lignes, horsListe } = await retenusProposes(bienId, profil, sel)
      return res.status(200).json({ etat: 'calcule', comparables: cartesDe(sel, profil), note, encore: !!sel.encore, retenus_hors_liste: horsListe,
        marche_sejour_min: repartitionSejourMin(sel.fiches),
        retenus: lignes.map(x => x.listing_id), fondateur: lignes.filter(x => x.retenu_par === 'fondateur').map(x => x.listing_id),
        positions: Object.fromEntries(lignes.filter(x => x.position).map(x => [x.listing_id, x.position])) })
    }

    // §22.7 : relever les prix des comparables (cache, sinon 0,10 $ chacun) et
    // calculer les prix de depart.
    if (corps.action === 'prix') {
      const profil = await lireProfil(supabase, bienId)
      if (!profil) return res.status(400).json({ error: 'profil_absent', message: 'Décrivez d’abord votre logement.' })
      return res.status(200).json(await calculerPrix({ bienId, compte, profil, payer: true }))
    }

    // §22.2 : la strategie de prix et le sejour minimum souhaite.
    if (corps.action === 'strategie') {
      const v = validerStrategie(corps)
      if (v.erreur) return res.status(400).json({ error: 'strategie_invalide', message: v.erreur })
      // Le serveur exige lui aussi 3 comparables de l'hote (review de dd8c060).
      const siens = (await retenusProposes(bienId, await lireProfil(supabase, bienId))).lignes.filter(x => x.retenu_par !== 'fondateur')
      if (siens.length < 3) return res.status(400).json({ error: 'comparables_insuffisants', message: 'Choisissez d’abord au moins 3 comparables.' })
      const ecrit = await enregistrerStrategie(supabase, { propertyId: bienId, strategie: v.strategie, sejourMin: v.sejour_min })
      if (!ecrit) return res.status(400).json({ error: 'profil_absent', message: 'Décrivez d’abord votre logement.' })
      return res.status(200).json({ etat: 'enregistre', profil: profilPublic(await lireProfil(supabase, bienId)) })
    }

    if (corps.action === 'retenir') {
      const profil = await lireProfil(supabase, bienId)
      if (!profil) return res.status(400).json({ error: 'profil_absent', message: 'Décrivez d’abord votre logement.' })
      // Les biens PROPOSES (§22.10) : actifs, jamais retires, de la selection en cache.
      const sel = await selectionEnCache(profil)
      if (!sel.fiches) return res.status(400).json({ error: 'liste_absente', message: 'Relancez la recherche des biens du marché.' })
      const v = validerChoix(corps.choix, sel.fiches)
      if (v.erreur) return res.status(400).json({ error: 'choix_invalide', message: v.erreur })
      await enregistrerChoix(supabase, { userId: compte, propertyId: bienId, ids: v.ids, positions: v.positions })
      return res.status(200).json({ etat: 'enregistre', retenus: v.ids, positions: v.positions })
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
