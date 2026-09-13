// api/yield-evenements.js
// Les EVENEMENTS declares par l'hote — saison thermale, festival, salon.
// Spec : docs/specs/spec-yieldflow-v1.md §6 ter
// Writer : lib/yield/evenements.js — DOC : docs/kb/evenements-yield.md
//
// ⚠ DEUX DOMAINES DE DROITS, LE MEME ARBITRAGE QU'AUX EXCEPTIONS.
//
//   ECRITURE -> `reglages`. Un evenement cree un SEGMENT : declarer « saison
//   thermale, avril a juin » change le niveau auquel le moteur positionnera
//   toutes ces nuits. C'est le meme niveau de consequence qu'un prix, donc le
//   meme droit que le calendrier tarifaire.
//
//   LECTURE -> `reservations`. Les ecrans de statistiques doivent pouvoir
//   AFFICHER les segments de l'hote — sans quoi un niveau « Haut » en plein
//   mois de mai resterait inexplicable a qui le regarde.
//
// Aucun appel provider : ces periodes n'existent chez aucun canal.

const { requirePermission, UUID_RE } = require('../lib/require-permission')
const { peutEcrire } = require('../lib/permissions')
const { createClient } = require('@supabase/supabase-js')
const { estJourISO } = require('../lib/yield/capacite')
const {
  evenementsDuBien, toutesLesOccurrences, creerEvenement, supprimerEvenement,
  reconductionsAProposer, RECURRENCES, PARENTS_AUTORISES, NOM_MAX, DUREE_MAX_JOURS
} = require('../lib/yield/evenements')
const { datesCommerciales, DATES } = require('../lib/yield/dates-commerciales')
const { reglagesDuBien, poserReglage, NIVEAUX_VALIDES, CRANS_MAX } =
  require('../lib/yield/reglages-segment')
const { calendrier, ORIGINES } = require('../lib/yield/calendrier-pilotage')
const { lireVacances, etendueSource } = require('../lib/yield/vacances')
const R = require('../lib/yield/reference')
const { grilleDuBien } = require('../lib/yield/grille-du-bien')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// La meme fenetre d'historique que la page des prix : la grille est une
// propriete du BIEN, pas de l'ecran qui la regarde.
const ANS_GRILLE = 3

// ⚠ LE JOUR A PARIS, PAS LE JOUR DU PROCESS. Aucun `TZ` n'est pose dans
// `vercel.json` : la fonction tourne en UTC. Meme correctif qu'aux exceptions.
function jourLocal (d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)
}
function veilleDe (iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
function reculerAns (iso, n) {
  const [a, m, j] = iso.split('-')
  const c = `${Number(a) - n}-${m}-${j}`
  return estJourISO(c) ? c : `${Number(a) - n}-${m}-28`
}
function decalerAns (iso, n) {
  const [a, m, j] = iso.split('-')
  const c = `${Number(a) + n}-${m}-${j}`
  // Le 29 fevrier n'existe pas tous les ans : on recule au 28 plutot que de
  // laisser une date invalide traverser la fenetre.
  return estJourISO(c) ? c : `${Number(a) + n}-${m}-28`
}

module.exports = async (req, res) => {
  const body = req.body || {}
  const brut = (v) => (Array.isArray(v) ? v[0] : v)
  // ⚠ DEUX NOMS POUR LA MEME CHOSE — le defaut qui avait tue le lot 4.3 entier.
  // L'endpoint des exceptions attendait `bien`, l'ecran envoyait `property_id` :
  // chaque saisie repondait « aucun logement designe », AVANT meme la garde, et
  // `npm test` etait vert. On accepte les deux des le premier jour.
  const bienDemande = brut(req.query.bien) || body.bien ||
    brut(req.query.property_id) || body.property_id
  if (!bienDemande) return res.status(400).json({ error: 'bien_requis' })

  const ecriture = req.method !== 'GET'
  const garde = await requirePermission(req, res, {
    domaine: ecriture ? 'reglages' : 'reservations',
    niveau: ecriture ? 'write' : 'read',
    bien: bienDemande,
    bienRequis: true
  })
  if (!garde.ok) return

  // ⚠ LA FICHE COMPLETE, PAS CELLE DE LA GARDE — le defaut du 11 septembre,
  // et je viens de le reproduire ici. `resoudreBien` ne rend que six colonnes :
  // sans relecture, `zone_scolaire` vaut `undefined` et TOUTES les vacances
  // partent en « vacances d'une autre zone », le seul segment dont le KB dit
  // qu'il ne porte aucun signal de prix. Rien ne paraissait casse : la liste
  // affichait bien « Vacances de la Toussaint », puisque le libelle vient du
  // nom de la periode et non de la zone.
  const { data: bien, error: eBien } = await supabase
    .from('properties').select('*').eq('id', garde.bien.id).maybeSingle()
  if (eBien) {
    console.error('[yield-evenements] properties :', eBien.message)
    return res.status(503).json({ error: 'lecture_impossible' })
  }
  if (!bien) return res.status(404).json({ error: 'bien_introuvable' })
  // ⚠ LA COLONNE ABSENTE SE DIT, elle ne se subit pas. `undefined` serait lu
  // comme « aucune zone » et produirait exactement le silence ci-dessus.
  if (!Object.prototype.hasOwnProperty.call(bien, 'zone_scolaire')) {
    console.error('[yield-evenements] colonne zone_scolaire absente')
    return res.status(500).json({ error: 'configuration_incomplete', colonnes: ['zone_scolaire'] })
  }
  const compte = garde.accountUserId

  // ─── GET : lister, et PROPOSER les reconductions ─────────────────────────
  if (req.method === 'GET') {
    const debutBrut = brut(req.query.debut)
    const finBrut = brut(req.query.fin)
    // ⚠ UNE FENETRE FOURNIE DOIT ETRE CORRECTE. Une borne mal formee rendant
    // « aucun evenement » ferait disparaitre les segments de l'hote en silence,
    // et le moteur retomberait sur « hors vacances » sans un mot.
    if ((debutBrut && !estJourISO(debutBrut)) || (finBrut && !estJourISO(finBrut))) {
      return res.status(400).json({ error: 'periode_invalide' })
    }
    if (debutBrut && finBrut && finBrut < debutBrut) {
      return res.status(400).json({ error: 'periode_invalide' })
    }
    try {
      const auj = jourLocal(new Date())
      // ⚠ LA FENETRE PAR DEFAUT EST PROSPECTIVE : les douze prochains mois.
      // Meme cadrage que l'app (spec §7) — « au 20 decembre, l'annee en cours
      // n'interesse plus le pilotage ».
      const f1 = debutBrut || auj
      const f2 = finBrut || decalerAns(auj, 1)
      // ⚠ LE CONTEXTE COUVRE L'HISTORIQUE **ET** LA FENETRE AFFICHEE.
      // Releve en l'executant : bati sur les seuls douze prochains mois, il
      // rendait « hors_fenetre_du_contexte » sur toutes les nuits passees, donc
      // AUCUN positionnement — la colonne « niveau » etait vide partout sans
      // qu'aucune erreur ne sorte. C'est exactement ce que la garde `fenetre`
      // de `segmenterJour` existe pour rendre visible.
      const debutHistorique = reculerAns(auj, ANS_GRILLE)
      const [declares, toutes, vacances, etendue, reglages] = await Promise.all([
        evenementsDuBien(supabase, bien.id, f1, f2),
        toutesLesOccurrences(supabase, bien.id),
        lireVacances(supabase, debutHistorique, f2),
        etendueSource(supabase),
        reglagesDuBien(supabase, bien.id)
      ])
      const coupees = new Set()
      for (const [cle, r] of reglages) if (r.actif === false) coupees.add(cle)
      // Les evenements et les dates commerciales couvrent eux aussi
      // l'historique : c'est lui qui donne leur positionnement.
      const declaresLarges = await evenementsDuBien(supabase, bien.id, debutHistorique, f2)
      const commerciales = datesCommerciales(debutHistorique, f2, { desactivees: coupees })
      const contexte = R.construireContexte({
        zoneBien: bien.zone_scolaire, vacances,
        evenements: [...declaresLarges, ...commerciales],
        debut: debutHistorique, fin: f2
      })
      // ⚠ LES DATES DESACTIVEES RESTENT MONTREES, mais hors du contexte : elles
      // doivent apparaitre a l'ecran pour etre reactivables. Les retirer de la
      // liste aurait rendu la desactivation irreversible depuis l'interface.
      const toutesCommerciales = datesCommerciales(f1, f2)
      // ⚠ LA GRILLE VIENT DU MEME MODULE QUE LA PAGE DES PRIX. Deux lectures
      // separees auraient fait deux chiffres pour la meme question — et c'est
      // ainsi qu'un ecran finit par contredire l'autre.
      let positions = null
      try {
        const g = await grilleDuBien(supabase, bien, compte, {
          contexte, debut: debutHistorique, fin: veilleDe(auj)
        })
        positions = g.grille.positions
      } catch (e) {
        // ⚠ UNE GRILLE ABSENTE N'EMPECHE PAS DE REGLER SES EVENEMENTS. On perd
        // la colonne « niveau calcule », pas l'ecran : `position_non_calculable`
        // le dira, plutot que de rendre 503 sur une lecture annexe.
        console.error('[yield-evenements] grille indisponible :', e.message)
      }
      const liste = calendrier({
        contexte, debut: f1, fin: f2, reglages, positions,
        evenements: [...declaresLarges, ...commerciales]
      })
      // Les dates coupees, ajoutees a part puisqu'elles ne segmentent plus rien.
      // ⚠ UNE SEULE LIGNE PAR DATE COUPEE — releve en review. Une
      // Saint-Valentin desactivee en produisait DEUX (le 14 et le samedi
      // rattache), pointant la meme cle : deux boutons « reactiver » pour un
      // seul geste, dont l'un aurait paru sans effet.
      const dejaVues = new Set()
      for (const c of toutesCommerciales) {
        if (!coupees.has(c.segment) && !coupees.has(c.cle)) continue
        if (!c.principale) continue
        if (dejaVues.has(c.segment)) continue
        dejaVues.add(c.segment)
        if (liste.some(x => x.cle === c.segment && x.debut === c.date_debut)) continue
        liste.push({
          cle: c.segment, segment: c.segment, nom: c.nom, origine: ORIGINES.CALENDRIER,
          debut: c.date_debut, fin: c.date_fin, nuits: 1,
          droits: { supprimable: false, desactivable: true, ajustable: true },
          niveau_calcule: null, crans: null, crans_mesures: null,
          crans_ajustes: null, mediane: null, echantillon: 0,
          reference_empruntee: null, ferie_voisin: null,
          actif: false, cle_reglage: c.segment,
          influence_non_calculable: 'date_desactivee'
        })
      }
      liste.sort((a, b) => a.debut.localeCompare(b.debut))

      // La zone du bien decide du seul segment de vacances qui porte un signal.
      const couvertureZone = (etendue || []).find(e => e.zone === bien.zone_scolaire) || null
      return res.status(200).json({
        bien: bien.id,
        aujourdhui: auj,
        fenetre: { debut: f1, fin: f2 },
        // ⚠ LE CALENDRIER COMPLET, UNE SEULE LISTE, TROIS ORIGINES.
        calendrier: liste,
        // ⚠ L'HORIZON DIT. Au-dela de la couverture du calendrier scolaire, les
        // segments deviennent incertains : l'ecran doit le DIRE plutot que de
        // presenter « hors vacances » comme une mesure.
        source_vacances: {
          nom: 'Ministère de l’Éducation nationale',
          url: 'https://data.education.gouv.fr',
          zone: bien.zone_scolaire || null,
          couverture_fin: couvertureZone ? couvertureZone.date_fin : null,
          couverture_debut: couvertureZone ? couvertureZone.date_debut : null,
          incertain_apres: couvertureZone && couvertureZone.date_fin < f2
            ? couvertureZone.date_fin : null
        },
        dates_commerciales: DATES.map(d => ({
          cle: d.cle, nom: d.nom, quoi: d.quoi,
          weekend_proche: d.weekend_proche,
          actif: !coupees.has(`commercial:${d.cle}`) && !coupees.has(d.cle)
        })),
        niveaux: NIVEAUX_VALIDES,
        // ⚠ L'ECRAN PARLE EN CRANS, comme le moteur. Un seul vocabulaire.
        crans_max: CRANS_MAX,
        // ⚠ L'ECRAN MASQUE, L'ENDPOINT REFUSE. Ce drapeau sert a ne pas
        // montrer un formulaire qui sera refuse — il ne remplace aucune garde.
        droits_ecriture: garde.contexte
          ? peutEcrire(garde.contexte, 'reglages',
            { id: bien.id, ref: bien.provider_property_id })
          : true,
        evenements: declares,
        // ⚠ DES PROPOSITIONS, PAS DES LIGNES. Elles ne sont ecrites que si
        // l'hote confirme : un evenement mal date fausse le segment, ce qui est
        // pire qu'un evenement absent.
        reconductions: reconductionsAProposer(toutes, { aujourdHui: auj }),
        // Ce que l'ecran doit savoir pour construire son formulaire, sans
        // recopier une liste que la base connait deja.
        recurrences: Object.values(RECURRENCES),
        parents: PARENTS_AUTORISES,
        limites: { nom_max: NOM_MAX, duree_max_jours: DUREE_MAX_JOURS }
      })
    } catch (e) {
      console.error('[yield-evenements] GET', e.message)
      return res.status(503).json({ error: 'lecture_impossible' })
    }
  }

  // ─── POST : declarer, ou confirmer une reconduction ──────────────────────
  if (req.method === 'POST') {
    const { nom, debut, fin, recurrence, parent_segment: parent, reconduit_de: source } = body
    try {
      const cree = await creerEvenement(supabase, {
        // ⚠ NI LE BIEN NI LE COMPTE NE VIENNENT DU CORPS DE LA REQUETE.
        // La garde a deja tranche a qui appartient le bien ; les relire dans
        // `body` reviendrait a redonner a l'appelant ce qu'on vient de lui
        // verifier. Le writer revalide par-dessus, en seconde barriere.
        userId: compte,
        propertyId: bien.id,
        nom, debut, fin, recurrence,
        parent_segment: parent,
        reconduitDe: source
      })
      console.log(`[yield-evenements] ${bien.name} : « ${cree.nom} » ${cree.date_debut} -> ${cree.date_fin}`)
      return res.status(201).json({ evenement: cree })
    } catch (e) {
      // ⚠ UNE SAISIE INVALIDE EST UNE ERREUR D'APPELANT (400), PAS UNE PANNE.
      // La liste est ANCREE sur les messages reels du writer : une alternative
      // nue capturerait aussi « supabase requis », un defaut de cablage
      // SERVEUR qui sortirait en 400 sans `console.error`, donc invisible.
      const validation = /nom requis|nom trop long|periode invalide|periode trop longue|recurrence inconnue|parent inconnu|doublon/
        .test(e.message)
      if (!validation) console.error('[yield-evenements] POST', e.message)
      if (!validation) return res.status(503).json({ error: 'ecriture_impossible' })
      const code = /doublon/.test(e.message) ? 'evenement_en_double'
        : /periode trop longue/.test(e.message) ? 'periode_trop_longue' : null
      return res.status(400).json({
        error: code || e.message.replace('[yield-events] ', ''),
        ...(code ? { detail: e.message.replace('[yield-events] ', '') } : {})
      })
    }
  }

  // ─── PATCH : ajuster un positionnement, ou (des)activer un contexte ──────
  // ⚠ UN VERBE A PART, ET CE N'EST PAS DU STYLE. POST cree une occurrence ;
  // PATCH regle un SEGMENT — deux ressources differentes. Les fondre aurait
  // fait un endpoint dont le corps decide de la nature de l'ecriture, donc un
  // endroit de plus ou se tromper.
  if (req.method === 'PATCH') {
    const { segment, crans, actif } = body
    try {
      const r = await poserReglage(supabase, {
        // ⚠ NI LE BIEN NI LE COMPTE NE VIENNENT DU CORPS. La garde a tranche.
        userId: compte,
        propertyId: bien.id,
        segment,
        // On ne transmet QUE les champs presents : `crans: null` veut dire
        // « retire mon ajustement », l'absence veut dire « n'y touche pas ».
        ...(Object.prototype.hasOwnProperty.call(body, 'crans') ? { crans } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'actif') ? { actif } : {})
      })
      console.log(`[yield-evenements] ${bien.name} : reglage « ${segment} » ->` +
        ` ${r.crans == null ? 'cran mesure' : (r.crans > 0 ? '+' : '') + r.crans + ' cran(s)'},` +
        ` actif ${r.actif !== false}`)
      return res.status(200).json({ reglage: r })
    } catch (e) {
      const validation = /segment requis|segment trop long|crans doit etre|crans hors bornes|actif doit etre/
        .test(e.message)
      if (!validation) console.error('[yield-evenements] PATCH', e.message)
      if (!validation) return res.status(503).json({ error: 'ecriture_impossible' })
      return res.status(400).json({ error: e.message.replace('[yield-reglages] ', '') })
    }
  }

  // ─── DELETE : corriger une saisie ────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = brut(req.query.id) || body.id
    if (!id) return res.status(400).json({ error: 'id_requis' })
    // ⚠ UN ID MAL FORME EST UNE ERREUR D'APPELANT, PAS UNE PANNE. `.eq('id',
    // 'abc')` sur une colonne `uuid` fait echouer la requete : sans ce test,
    // l'appelant recevait 503 et l'incident partait en panne d'infra.
    if (!UUID_RE.test(String(id))) return res.status(400).json({ error: 'id_invalide' })
    try {
      const r = await supprimerEvenement(supabase, { propertyId: bien.id, id })
      if (!r.supprimees) return res.status(404).json({ error: 'evenement_introuvable' })
      return res.status(200).json({ supprimees: r.supprimees })
    } catch (e) {
      console.error('[yield-evenements] DELETE', e.message)
      return res.status(503).json({ error: 'suppression_impossible' })
    }
  }

  return res.status(405).json({ error: 'methode_non_supportee' })
}
