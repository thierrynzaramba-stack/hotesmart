// api/yield-menu.js — LES FAITS DU MENU YIELDFLOW DU CALENDRIER.
// Spec : docs/specs/spec-yf-bouton-calendrier.md (modif = MEME COMMIT)
// Faits : lib/yield/menu-calendrier.js
//
//   GET /api/yield-menu?bien=<uuid>
//     -> { pilote, fenetre, fenetre_fin, marche, evenements, comparables,
//          prix_ajustes, jours }
//
// ⚠ LECTURE SEULE, ET RIEN D'AUTRE. Cet endpoint n'ecrit pas, n'ouvre rien, ne
// bascule rien, n'appelle ni le moteur, ni un provider, ni AirROI. Le menu du
// calendrier OUVRE DES PAGES : la bascule du pilote reste
// `POST /api/yield-pilote`, avec sa confirmation comptee serveur. Jamais de
// bascule en un clic (spec §4).
//
// ⚠ POURQUOI UN APPEL A L'OUVERTURE DU MENU, ET RIEN AU CHARGEMENT.
// Le calendrier garde ses appels actuels a l'identique : l'etat du pilote, qui
// colore le bouton, est deja servi par `/api/channel-property`. Ce qui coute
// — trois comptages — ne part que sur un GESTE de l'hote, pour UN bien.
// C'est l'exception datee du 28 octobre 2026 a la regle « donnee non urgente =
// resume pre-calcule » de CLAUDE.md, et sa condition tient a cette phrase :
// le jour ou l'un de ces chiffres s'affiche SANS clic, il faut la table de
// resume, le cron et l'heure du calcul (spec §6 bis).
//
// ⚠ DROIT `reservations` EN LECTURE, comme le calendrier qui porte le menu.
// Les deux entrees du PIED (« Reglages du pilote », « Activer le pilote ») ne
// passent pas par ici : elles ouvrent `apps/yield/prix`, dont les ecritures
// sont gardees par `/api/yield-pilote` en `reglages` write. Cet endpoint ne
// rend que des faits de lecture, et les masquages de l'ecran ne sont qu'un
// confort — la garde est chez l'ecrivain.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { piloteDuBien, fenetreDuBien, finDeFenetre } = require('../lib/pilote-tarifaire')
const { jourParis } = require('../lib/ouverture-marqueur')
const {
  JOURS_COMPTEUR, compterPrixAjustes, compterEvenementsAVenir,
  compterComparables, lireMarcheRelie
} = require('../lib/yield/menu-calendrier')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async (req, res) => {
  // ⚠ L'EN-TETE AVANT LE PREMIER REFUS, PAS AVANT LA GARDE (dette 90). Un 400
  // de parametre manquant et un 405 de methode sont des reponses de compte
  // eux aussi : si l'en-tete arrive apres eux, ils partent cachables.
  res.setHeader('cache-control', 'private, no-store')
  res.setHeader('vary', 'authorization, x-compte')

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }

  // Les deux noms, comme `yield-pilote` et `yield-exceptions` : un ecran qui
  // envoie `property_id` a un endpoint qui attend `bien` recoit « Aucun
  // logement designe » a chaque geste. On ne refait pas ce vocabulaire.
  const bienDemande = req.query.bien || req.query.property_id
  if (!bienDemande) return res.status(400).json({ error: 'bien_requis' })

  const garde = await requirePermission(req, res, {
    domaine: 'reservations', niveau: 'read', bien: bienDemande, bienRequis: true
  })
  if (!garde.ok) return

  const compte = garde.accountUserId
  const t0 = Date.now()

  // ⚠ LA GARDE NE CHARGE PAS CE QUE CET ENDPOINT JUGE — la lecon est gravee
  // dans `api/yield-pilote.js` et dans `api/channel-property.js` :
  // `resoudreBien` ne selectionne ni `pilote_tarifaire`, ni les deux colonnes
  // de la fenetre. Juger sur `garde.bien` rendrait TOUT bien « non pilote »,
  // en silence — le bouton serait gris pour tout le monde.
  const { data: bien, error: eBien } = await supabase.from('properties')
    .select('id, name, pilote_tarifaire, pilote_fenetre_type, pilote_fenetre_valeur')
    .eq('id', garde.bien.id).eq('user_id', compte).maybeSingle()
  if (eBien) {
    console.error('[yield-menu] lecture bien', eBien.message)
    return res.status(503).json({ error: 'Réglage illisible pour le moment. Réessayez.' })
  }
  if (!bien) return res.status(404).json({ error: 'Logement introuvable.' })

  const aujourdHui = jourParis(new Date())
  const pilote = piloteDuBien(bien)

  // ⚠ LES QUATRE LECTURES EN PARALLELE, ET AUCUNE NE PEUT FAIRE TOMBER LES
  // AUTRES : chaque fait rend `null` quand il est illisible, et l'ecran se
  // tait sur ce fait-la seulement. Un menu qui refuse de s'ouvrir parce qu'un
  // repere de confort est illisible serait une panne fabriquee.
  //
  // Le compteur du moteur n'est LU QUE POUR UN BIEN PILOTE : sur un bien en
  // pilote calendrier, la ligne ambre n'existe pas (spec §4), et une requete
  // dont on jettera le resultat est une requete de trop.
  const [marche, evenements, comparables, prixAjustes] = await Promise.all([
    lireMarcheRelie(supabase, { propertyId: bien.id }),
    compterEvenementsAVenir(supabase, { propertyId: bien.id, userId: compte, aujourdHui }),
    compterComparables(supabase, { propertyId: bien.id, userId: compte }),
    pilote === 'yieldflow'
      ? compterPrixAjustes(supabase, { propertyId: bien.id, userId: compte, maintenantMs: Date.now() })
      : Promise.resolve(null)
  ])

  // ⚠ LE COMPTE DE REQUETES, PAS SEULEMENT LA DUREE (regle 7 du chargement
  // rapide) : la duree designe une reponse lente, le nombre designe la CAUSE.
  //
  // ⚠ ET C'EST UN PLANCHER, PAS UN COMPTE EXACT — constat de la re-review du
  // 28 octobre 2026. Ce commentaire affirmait « il est EXACT ici », et c'etait
  // faux : `requirePermission` fait ses propres lectures avant nous —
  // `resoudreBien` TOUJOURS, et `chargerProfil` pour un membre delegue — donc
  // une a deux requetes de plus, invisibles d'ici. Le chiffre servi au
  // navigateur sous-estimait d'autant.
  // Une affirmation d'exactitude ecrite a la main se lit comme une mesure et
  // ne rougit jamais : on annonce donc ce qu'on sait compter, et on DIT ce
  // qu'on ne compte pas. Meme forme que `api/ecran/aujourdhui.js`.
  const requetes = 4 + (pilote === 'yieldflow' ? 1 : 0)
  const total = Date.now() - t0
  res.setHeader('Server-Timing',
    `db;dur=${total};desc="${requetes} req + garde (plancher)", total;dur=${total}`)

  return res.status(200).json({
    bien: bien.id,
    pilote,
    // La fenetre telle qu'elle est reglee, et sa FIN calculee par la regle du
    // moteur (`finDeFenetre`, jour de Paris) : une approximation client
    // (mois x 30, date locale) divergeait de 5 jours sur 12 mois, relevee en
    // review de c8e7dff.
    fenetre: fenetreDuBien(bien),
    fenetre_fin: finDeFenetre(bien, aujourdHui),
    marche,
    evenements,
    comparables,
    prix_ajustes: prixAjustes,
    jours: JOURS_COMPTEUR
  })
}
