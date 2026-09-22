// api/yield-prix.js — LA TARIFICATION JOUR PAR JOUR.
// Lot 4.4 (restitution) de l'etape 4. Spec : docs/specs/spec-yieldflow-v1.md §7.3.
//
//   GET ?property_id=&debut=&fin=
//   -> une ligne PAR NUIT : etat, prix actuellement pousse, suggestion,
//      niveau, fourchette, et les motifs quand il n'y a pas de suggestion.
//
// ⚠ POURQUOI UN ENDPOINT A PART DE `/api/yield`.
// Le lot 4.1 pose que `/api/yield` est la source unique de l'ecran de synthese,
// et il l'est. Mais il raisonne par PERIODE : lui demander 365 jours de detail
// ferait une reponse de plusieurs Mo pour une page qui se lit mois par mois.
// Ici la maille est la NUIT, la fenetre est courte, et la question est autre :
// « que dois-je changer aujourd'hui ? ».
//
// ⚠ LECTURE SEULE. Cet endpoint ne propose pas d'appliquer : « Appliquer »
// passera par le chemin normal du calendrier au lot 4.6, jamais par ici.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { peutEcrire } = require('../lib/permissions')
const { eclater, construirePontDemapped } = require('../lib/yield/eclatement')
const { dateOuverture, piloteDuBien } = require('../lib/pilote-tarifaire')
const { prixHoteDuBien } = require('../lib/prix-hote')
const { joursOuverts, estJourISO, joursDeLaPeriode } = require('../lib/yield/capacite')
const { exceptionsDuBien, joursExclus } = require('../lib/yield/exceptions')
const { evenementsDuBien } = require('../lib/yield/evenements')
const { datesCommerciales } = require('../lib/yield/dates-commerciales')
const { reglagesDuBien, reglagePour } = require('../lib/yield/reglages-segment')
const { lireVacances, etendueSource } = require('../lib/yield/vacances')
const { pickup, DRAPEAUX } = require('../lib/yield/pickup')
const { nuitsOccupees } = require('../lib/nuits-occupees')
const R = require('../lib/yield/reference')
const S = require('../lib/yield/suggestion')
const { nuitComparable } = require('../lib/yield/comparable')
const SJ = require('../lib/yield/sejours')
const { readStatus, STATUS } = require('../lib/bookings-snapshot-status')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ FENETRE COURTE, ET C'EST LE SUJET. Cette page se regarde le matin : elle
// repond a « que dois-je changer aujourd'hui ? », pas a « comment s'est passee
// l'annee ». Une fenetre longue la rendrait illisible AVANT de la rendre lente.
// Douze mois glissants : le cadrage PROSPECTIF de l'app (spec §7).
const RADAR_MOIS = 12
const JOURS_DEFAUT = 60
const JOURS_MAX = 120
const ANS_REFERENCE = 3
const RESERVATIONS_MAX = 20000

function jourLocal (d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)
}
function decaler (iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function reculerAns (iso, n) {
  const [a, m, j] = iso.split('-')
  const c = `${Number(a) - n}-${m}-${j}`
  if (estJourISO(c)) return c
  const repli = `${Number(a) - n}-${m}-28`
  return estJourISO(repli) ? repli : null
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'methode_non_supportee' })
  }
  const brut = (v) => (Array.isArray(v) ? v[0] : v)
  const propertyId = String(brut(req.query.property_id) || brut(req.query.bien) || '').trim()
  if (!propertyId) return res.status(400).json({ error: 'bien_requis' })

  const garde = await requirePermission(req, res, {
    domaine: 'reservations', niveau: 'read', bien: propertyId, bienRequis: true
  })
  if (!garde.ok) return

  const compte = garde.accountUserId
  try {
    // ⚠ LA FICHE COMPLETE — le defaut du 11 septembre, deja paye deux fois.
    // `resoudreBien` ne rend que six colonnes : sans relecture, `zone_scolaire`
    // vaut `undefined` et TOUT part en « vacances d'une autre zone ».
    const { data: bien, error: eBien } = await supabase
      .from('properties').select('*').eq('id', garde.bien.id).maybeSingle()
    if (eBien) throw new Error(`properties : ${eBien.message}`)
    if (!bien) return res.status(404).json({ error: 'bien_introuvable' })
    if (!bien.provider_property_id) {
      return res.status(409).json({ error: 'bien_non_raccorde' })
    }
    const MANQUANTES = ['base_price', 'capacity', 'zone_scolaire', 'prix_minimum', 'provider']
      .filter(c => !Object.prototype.hasOwnProperty.call(bien, c))
    if (MANQUANTES.length) {
      console.error('[yield-prix] colonnes absentes :', MANQUANTES.join(', '))
      return res.status(500).json({ error: 'configuration_incomplete', colonnes: MANQUANTES })
    }

    const auj = jourLocal(new Date())
    // ⚠ UN MOIS A LA FOIS — arbitrage de Thierry. La page se lit comme un
    // tableau mensuel : une fenetre glissante coupait les mois en deux, et la
    // comparaison au meme mois de l'an dernier — qui EST l'information — n'avait
    // plus de bornes claires.
    const moisDemande = String(brut(req.query.mois) || '').trim()
    let debut, fin
    if (/^\d{4}-\d{2}$/.test(moisDemande)) {
      const [a, m] = moisDemande.split('-').map(Number)
      if (!(m >= 1 && m <= 12)) return res.status(400).json({ error: 'mois_invalide' })
      debut = `${moisDemande}-01`
      fin = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10)
    } else {
      debut = estJourISO(brut(req.query.debut)) ? brut(req.query.debut) : auj
      fin = estJourISO(brut(req.query.fin)) ? brut(req.query.fin)
        : decaler(debut, JOURS_DEFAUT - 1)
    }
    if (fin < debut) return res.status(400).json({ error: 'periode_invalide' })
    const jours = joursDeLaPeriode(debut, fin)
    if (!jours || !jours.length || jours.length > JOURS_MAX) {
      return res.status(400).json({ error: 'fenetre_trop_large', max: JOURS_MAX })
    }
    // ⚠ LE PASSE N'A PAS DE PRIX A CHANGER. On le refuse a la porte plutot que
    // de servir des lignes ou chaque suggestion dirait « nuit deja passee ».
    // Un mois deja ecoule reste lisible : c'est son bilan. Les suggestions y
    // porteront « nuit deja passee », ce qui est la verite.
    if (fin < auj && !/^\d{4}-\d{2}$/.test(moisDemande)) {
      return res.status(400).json({ error: 'fenetre_entierement_passee' })
    }

    // ─── LE RADAR : DOUZE MOIS GLISSANTS, SANS UNE REQUETE DE PLUS ──────────
    // ⚠ CONTRAINTE DE THIERRY : « aucune nouvelle lecture serveur ». Elle a
    // decide de la forme, et c'est elle qui a rendu ce bloc possible.
    //
    // La voie naive — appeler `joursOuverts` pour chacun des douze mois et de
    // leurs N-1 — coute 24 requetes. Mesure sur La bulle : 2 673 ms, sur une
    // page qui s'ouvre chaque matin. On lit donc UNE fois le calendrier sur
    // toute la fenetre, et `joursOuverts` recoit les lignes au lieu de les
    // relire : 169 ms, et la regle « qu'est-ce qu'un jour ouvert » reste a un
    // seul endroit (un test compare les deux chemins).
    const moisRadar = []
    for (let i = 0; i < RADAR_MOIS; i++) {
      const d = new Date(Date.UTC(Number(auj.slice(0, 4)), Number(auj.slice(5, 7)) - 1 + i, 1))
      moisRadar.push(d.toISOString().slice(0, 7))
    }
    // ⚠ LE MOIS CONSULTE PEUT ETRE HORS DU RADAR, ET IL SE RANGE A SA PLACE.
    // Releve en review, et c'etait a UN CLIC : « mois precedent » ajoutait le
    // mois passe EN FIN de tableau, donc `moisRadar[dernier]` devenait
    // anterieur a `moisRadar[0]`. La fenetre de `nuitsOccupees` partait alors
    // du 1er septembre au 31 aout — INVERSEE. Elle ne laissait passer aucune
    // nuit : `vendues` valait {} pour TOUTE la reponse, chaque nuit vendue
    // repartait « a vendre » et recevait une suggestion, et les douze tuiles
    // annonçaient « 0 vendue » en comptant ces nuits dans le gain.
    const cleAffichee = debut.slice(0, 7)
    if (!moisRadar.includes(cleAffichee)) moisRadar.push(cleAffichee)
    moisRadar.sort()
    const finDeMois = c => {
      const [a, m] = c.split('-').map(Number)
      return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10)
    }
    // La plage a lire couvre les mois du radar ET leurs N-1 (pour le pickup).
    const clesCapacite = new Set()
    for (const c of moisRadar) {
      clesCapacite.add(c)
      clesCapacite.add(`${Number(c.slice(0, 4)) - 1}-${c.slice(5)}`)
    }
    const triCap = [...clesCapacite].sort()
    const debutCal = `${triCap[0]}-01`
    const finCal = finDeMois(triCap[triCap.length - 1])

    // ⚠ PAGINATION OBLIGATOIRE : PostgREST plafonne a 1000 lignes, et deux ans
    // de calendrier les depassent des que le bien est provisionne chaque jour.
    // Sans `order`, la pagination n'est meme pas deterministe.
    const lignesCal = []
    for (let from = 0; ; from += 1000) {
      const { data, error: eInv } = await supabase
        .from('calendar_inventory')
        .select('date, rate, avail, stop_sell')
        .eq('property_id', bien.id).gte('date', debutCal).lte('date', finCal)
        .order('date').range(from, from + 999)
      if (eInv) throw new Error(`calendar_inventory : ${eInv.message}`)
      lignesCal.push(...(data || []))
      if (!data || data.length < 1000) break
    }

    // ⚠ LA FENETRE D'HISTORIQUE EST UNE PROPRIETE DU BIEN, PAS DU MOIS REGARDE.
    // Releve en review, 13 septembre 2026. Elle etait ancree sur le MOIS
    // demande (`reculerAns(debut, 3)`) alors que sa borne haute suivait
    // aujourd'hui : la grille retrecissait d'un mois a chaque clic sur « mois
    // suivant ». Mesure au 13 septembre 2026 :
    //   septembre 2026 -> 3,03 ans   septembre 2027 -> 2,03 ans
    //   septembre 2028 -> 1,03 an    octobre 2029   -> FENETRE VIDE
    // Au-dela de trois ans d'horizon, chaque nuit portait « echantillon sous le
    // seuil » — un motif qui accuse la donnee de l'hote alors que c'est la
    // fenetre qui etait fausse. Et `historique: { ans: 3 }` l'affirmait quand
    // meme. Symetriquement, un mois passe elargissait la fenetre a 5,7 ans.
    const debutHistorique = reculerAns(auj, ANS_REFERENCE)
    const finRef = decaler(auj, -1)
    if (!debutHistorique) return res.status(400).json({ error: 'periode_invalide' })
    // ⚠ LE CONTEXTE, LUI, DOIT COUVRIR TOUT CE QU'ON SEGMENTE : l'historique,
    // le mois affiche, ET les nuits comparables N-1 (que la cascade va chercher
    // jusqu'a cinq semaines autour du decalage de 52 semaines). Un jour hors de
    // cette fenetre rend « hors_fenetre_du_contexte » — un silence, pas un
    // plantage, donc invisible sans ce calcul explicite.
    const debutContexte = [debutHistorique, decaler(debut, -364 - 40)]
      .sort()[0]
    // ⚠ ET LA BORNE HAUTE DOIT COUVRIR LA GRILLE, PAS SEULEMENT LE MOIS AFFICHE.
    // Releve en review. Le contexte finissait a `fin` — la fin du mois
    // consulte — alors que la grille court jusqu'a HIER. Sur un mois passe
    // (autorise par `?mois=`), toutes les nuits posterieures a ce mois
    // sortaient en « hors fenetre du contexte » et disparaissaient des
    // segments : l'echantillon de `hors_vacances` tombait de 51 a 32 nuits
    // pour la MEME grille, selon le mois qu'on regardait.
    // Consequence nouvelle : l'ecran des evenements, qui lit la grille par
    // `grille-du-bien.js` (sans ce defaut), annonçait des crans differents de
    // ceux de la page des prix. Deux ecrans, deux verites.
    // ⚠ ET IL DOIT COUVRIR LE RADAR, PAS SEULEMENT LE MOIS AFFICHE.
    // Trouve en l'executant : le contexte s'arretait a la fin du mois
    // consulte, donc TOUS les mois suivants du radar tombaient
    // « hors_fenetre_du_contexte ». La tuile de decembre annonçait
    // « 7 segments incertains » alors que le calendrier scolaire couvre
    // jusqu'en juillet 2027 — un faux signal, sur le champ meme qui doit
    // alerter l'hote.
    const finContexte = [fin, auj, finCal].sort()[2]

    // ─── Le coeur ───────────────────────────────────────────────────────────
    let lignes = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('bookings_snapshot')
        .select('user_id, booking_id, property_id, snapshot, raw')
        .eq('user_id', compte).order('booking_id').range(from, from + 999)
      if (error) throw new Error(`bookings_snapshot : ${error.message}`)
      lignes = lignes.concat(data || [])
      if (!data || data.length < 1000) break
      if (lignes.length > RESERVATIONS_MAX) {
        return res.status(413).json({ error: 'historique_trop_volumineux' })
      }
    }
    const { pont } = construirePontDemapped(lignes, bien.provider)
    const duBien = lignes.filter(l => l.property_id === bien.provider_property_id)
    const exceptions = await exceptionsDuBien(supabase, bien.id, debutContexte, finContexte)
    // ⚠ PAR `joursExclus` : exceptions ∪ FERMETURES de l'hote (lot 4.6.2).
    const exclus = await joursExclus(supabase, bien.id, debutContexte, finContexte, { exceptions })
    const eclatements = duBien.map(l => eclater(l, {
      pont, joursExclus: exclus, defaultProvider: bien.provider
    }))

    // ─── La grille, sur l'historique ────────────────────────────────────────
    const vacances = await lireVacances(supabase, debutContexte, finContexte)
    // ⚠ JUSQU'OU LE CALENDRIER SCOLAIRE EST-IL PUBLIE ? Au-dela, une nuit de
    // vacances part silencieusement en « hors vacances » : `lireVacances` ne
    // rend AUCUN motif pour les jours qu'elle ne couvre pas. C'est ce risque
    // que l'alerte « segments incertains » doit porter.
    const etendue = await etendueSource(supabase)
    const couvertureVacances = (etendue || [])
      .find(e => e.zone === bien.zone_scolaire) || null
    // ⚠ LES EVENEMENTS DE L'HOTE ENTRENT DANS LE CONTEXTE, comme les vacances.
    // Sans cette lecture, tout le mecanisme restait inerte : une nuit de saison
    // thermale etait segmentee « hors vacances », tarifee au niveau de la basse
    // saison, sans un mot. C'est le defaut exact que l'en-tete d'`evenements.js`
    // annonce vouloir empecher — et il a vecu deux commits.
    //
    // ⚠ MEME FENETRE QUE LE RESTE DU CONTEXTE. Un evenement lu sur une fenetre
    // plus etroite que l'historique ferait diverger la grille (qui compterait
    // ses nuits en « hors vacances ») de la segmentation du mois affiche.
    const declares = await evenementsDuBien(supabase, bien.id, debutContexte, finContexte)
    // ⚠ CE QUE L'HOTE DECIDE DES CONTEXTES : ajustements de niveau et
    // desactivations. Lu AVANT le contexte, parce qu'une date commerciale
    // coupee ne doit pas entrer dans la segmentation du tout — la couper plus
    // tard l'aurait laissee compter dans la grille.
    const reglages = await reglagesDuBien(supabase, bien.id)
    const coupees = new Set()
    for (const [cle, r] of reglages) if (r.actif === false) coupees.add(cle)
    // ⚠ LES TROIS FAMILLES ENTRENT PAR LA MEME PORTE. Vacances et feries sont
    // deja dans le contexte ; les dates commerciales et les evenements de
    // l'hote partagent la meme forme, donc la meme branche de `segmenterJour`.
    // Deux portes auraient fait deux regles a tenir d'accord.
    const commerciales = datesCommerciales(debutContexte, finContexte, { desactivees: coupees })
    const evenements = [...declares, ...commerciales]
    const contexte = R.construireContexte({
      zoneBien: bien.zone_scolaire, vacances, evenements,
      debut: debutContexte, fin: finContexte
    })
    const grille = S.construireGrille(eclatements, {
      contexte, debut: debutHistorique, fin: finRef
    })

    // ─── L'etat du calendrier, jour par jour ────────────────────────────────
    const capacite = await joursOuverts(supabase, bien, debut, fin,
      { aujourdHui: auj, estimerLePasse: false, lignes: lignesCal })
    // ⚠ L'OUVERTURE SE LIT SUR TOUTE LA FENETRE DU RADAR, PAS SUR LE MOIS.
    // Trouve en l'executant : bornes au mois affiche, octobre rendait « 30
    // nuits non renseignees » alors que la page d'octobre les tarifait —
    // `parDate` n'avait aucune ligne hors du mois courant, donc `ouverte`
    // valait `null` partout. La tuile disait le contraire du mois qu'elle
    // annonce.
    const capaciteRadar = await joursOuverts(supabase, bien, debutCal, finCal,
      { aujourdHui: auj, estimerLePasse: false, lignes: lignesCal })
    // ⚠ « JE NE SAIS PAS » NE DEVIENT PAS « FERME » — releve en review, et
    // c'est l'inversion exacte que la regle cardinale interdit.
    // `detail` vaut `null` quand la capacite n'est pas calculable : le `|| []`
    // faisait alors de CHAQUE nuit portant une ligne au calendrier une nuit
    // « fermee a la vente », c'est-a-dire une affirmation la ou la fonction
    // disait explicitement qu'elle ne savait pas.
    //
    // Ce n'etait pas atteignable avant le radar : la fenetre valait un mois.
    // Elle fait maintenant deux ans et traverse TOUJOURS le futur, donc la
    // garde `estRelieAuCanal` tire sur tout bien Beds24, et au-dela de
    // JOURS_MAX elle rend `periode_trop_longue`. Dans les deux cas la page
    // entiere passait en « fermee », pendant que son propre pied annonçait
    // « 3 jours ouverts ». Deux verites dans une seule reponse.
    const ouvertureConnue = !!(capaciteRadar && capaciteRadar.calculable &&
      capaciteRadar.detail)
    const ouverts = new Set(ouvertureConnue ? capaciteRadar.detail : [])
    // ⚠ « HORS FENETRE » VIENT DE LA CAPACITE, PAS D'UNE SECONDE DECISION ICI
    // — releve en review. `detail_hors_fenetre` est porte par le resultat, y
    // compris quand la periode entiere est hors fenetre (raison dediee, non
    // calculable). Une seule regle, un seul endroit qui l'applique.
    const horsFenetre = new Set((capaciteRadar && capaciteRadar.detail_hors_fenetre) || [])
    const motifOuverture = ouvertureConnue ? null
      : (capaciteRadar ? capaciteRadar.raison : 'capacite_non_calculable')
    const parDate = new Map(lignesCal.map(l => [l.date, l]))
    // La main de l'hote (arbitrage A bis) : « votre prix » a cote de ce que
    // YieldFlow proposait. Table absente = aucune main ; panne = on le dit.
    let prixHote = new Map()
    try { prixHote = await prixHoteDuBien(supabase, bien.id, debutCal, finCal) }
    catch (e) { console.error('[yield-prix] prix_hote illisibles', e.message) }

    // ⚠ UNE NUIT VENDUE N'A PLUS DE PRIX A CHANGER. Le montrer comme
    // « tarifiable » ferait perdre du temps a l'hote sur la seule ligne ou il
    // ne peut rien faire.
    // ⚠ UNE SEULE LECTURE, SUR LA FENETRE DU RADAR. Elle servait le mois
    // affiche ; le radar en a besoin sur douze. Elargir la fenetre coute la
    // meme requete — la decouper par mois en aurait coute douze.
    const venduesRadar = await nuitsOccupees(supabase, bien.provider_property_id,
      debutCal, finCal, { userId: compte })
    const vendues = venduesRadar

    // ─── La pression, par mois ──────────────────────────────────────────────
    const capacitesMois = new Map()
    for (const c of triCap) {
      capacitesMois.set(c, await joursOuverts(supabase, bien, `${c}-01`, finDeMois(c),
        { aujourdHui: auj, estimerLePasse: true, lignes: lignesCal }))
    }
    const pressionParMois = new Map()
    for (const cle of moisRadar) {
      const pk = pickup(eclatements, { periode: cle, pivot: auj, granularite: 'mois',
        capacites: capacitesMois, capacitePersonnes: bien.capacity })
      const c = pk.vs_n1 && pk.vs_n1.ca ? pk.vs_n1.ca : null
      // ⚠ UN ECART CALCULE SUR UN DENOMINATEUR PARTIEL NE DEPLACE PAS UN PRIX.
      // Releve en review, 13 septembre 2026 — et le defaut agissait DEJA sur
      // La bulle, dont le portefeuille N-1 porte `portefeuille_n1_reconstruit`.
      //
      // Ces deux drapeaux ne disqualifient pas le N-1 au sens de `pickup`
      // (`DISQUALIFIENT_LE_N1`) : le chiffre reste montrable, il est seulement
      // SOUS-COMPTE par construction — annulations invisibles, dates de vente
      // perdues a la migration. Le montrer est honnete ; en tirer « +40 %, on
      // monte d'un niveau » ne l'est pas : le biais est systematiquement
      // positif, donc la hausse serait automatique et fausse.
      //
      // On garde donc le chiffre pour l'ecran, et on retire au moteur le droit
      // de bouger dessus. `fiable: false` voyage avec, et la couche le DIT.
      const degrade = (pk.drapeaux || []).find(x =>
        x === DRAPEAUX.PORTEFEUILLE_RECONSTRUIT || x === DRAPEAUX.DATES_INCOMPLETES_N1)
      pressionParMois.set(cle, {
        ecart: c && c.variation != null ? c.variation : null,
        ca: c ? c.valeur : null, ca_n1: c ? c.n1 : null,
        fiable: !degrade,
        motif_non_fiable: degrade || null,
        drapeaux: pk.drapeaux || []
      })
    }

    // ─── LE REEL DE L'AN DERNIER, NUIT PAR NUIT ────────────────────────────
    // ⚠ LE PRIX VENDU, PAS LA REFERENCE. Arbitrage de Thierry : « la
    // comparaison au N-1 reel est plus parlante que toute justification ». La
    // reference dit ce qui est normal ; ce chiffre-ci dit ce que CETTE nuit a
    // rapporte l'an dernier — c'est le seul auquel l'hote peut confronter sa
    // memoire.
    // ⚠ ET LE REEL DE CETTE ANNEE AUSSI. Une nuit deja vendue n'a pas de
    // « prix affiche » : `calendar_inventory` ne remonte pas dans le passe, et
    // la memoire d'intention a ete amorcee a la migration. La ligne affichait
    // donc un tiret sur la nuit dont on connait PRECISEMENT le prix — celui
    // qu'elle a rapporte. C'est ce chiffre-la que l'hote vient chercher.
    const reelAnnee = new Map()
    const reelN1 = new Map()
    for (const e of eclatements) {
      if (!e.compte) continue
      for (const n of e.nuits || []) {
        if (n.prix == null) continue
        if (n.date >= debut && n.date <= fin) {
          reelAnnee.set(n.date, Math.round(n.prix * 100) / 100)
        }
        reelN1.set(n.date, {
          prix: Math.round(n.prix * 100) / 100,
          date_vente: e.date_vente_fiable ? e.date_vente : null,
          hors_reference: !!n.hors_reference
        })
      }
    }

    // ─── Une ligne par nuit ─────────────────────────────────────────────────
    // ⚠ UNE SEULE FONCTION POUR LA LIGNE ET POUR LA TUILE. Le radar doit
    // annoncer EXACTEMENT ce que le mois affichera au clic : recalculer les
    // compteurs autrement aurait fait deux verites, et c'est la tuile qu'on
    // aurait crue.
    const construireNuit = (date) => {
      const l = parDate.get(date) || null
      const vendue = (vendues[date] || []).length >= Math.max(1, Number(bien.inventory_units) || 1)
      // ⚠ `vendue` EST UN ETAT A PART, PAS UN `ouverte: false`. Le confondre
      // faisait porter « fermee a la vente » a dix nuits vendues — ce qui
      // aurait envoye l'hote ouvrir un calendrier qui n'a rien a ouvrir.
      // ⚠ TROIS ETATS, PAS DEUX : ouverte, fermee, ET « je ne sais pas ».
      // Sans ligne au calendrier, personne n'a rien decide. Et si la capacite
      // elle-meme n'est pas calculable, on ne sait pas davantage — meme si la
      // ligne existe.
      const ouverte = !ouvertureConnue ? null
        : (parDate.has(date) ? ouverts.has(date) : null)
      const delai = Math.round(
        (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${auj}T00:00:00Z`)) / 86400000)
      const seg = R.segmenterJour(date, contexte)
      const pr = pressionParMois.get(date.slice(0, 7)) || null
      // ⚠ UNE NUIT NON OUVERTE MONTRE LES MEMES INFORMATIONS QU'UNE NUIT
      // OUVERTE — demande de Thierry (recette du 22 septembre 2026) : « pour
      // que l'utilisateur puisse anticiper ». Pas encore ouverte (au-dela de la
      // fenetre) ou non renseignee (aucune ligne), la nuit recoit une
      // PROJECTION : la suggestion calculee comme si elle etait ouverte — le
      // prix auquel elle s'ouvrira, ou celui que YieldFlow proposerait. Le
      // drapeau `projection` voyage avec, l'ecran le dit, et le radar ne compte
      // pas ces nuits « a monter » (elles n'ont pas de prix actuel). Une nuit
      // FERMEE par l'hote, elle, garde son refus : c'est sa decision.
      // ⚠ Sans ligne, seulement si l'ouverture est CONNUE : quand la capacite
      // n'est pas calculable, « non renseignee » serait une affirmation de
      // plus la ou l'on ne sait rien (releve en relecture).
      const projection = !vendue && delai >= 0 && ouverte !== false &&
        (horsFenetre.has(date) || (ouvertureConnue && !parDate.has(date)))
      const s = S.suggerer({
        date, grille, contexte, ouverte: projection ? true : ouverte, vendue, delaiJours: delai,
        pression: pr && pr.ecart != null
          ? { ecart: pr.ecart, fiable: pr.fiable !== false,
            motif_non_fiable: pr.motif_non_fiable || null }
          : null,
        // ⚠ LE REGLAGE LE PLUS FIN QUI EXISTE : « ferie:toussaint » avant
        // « ferie ». L'hote ajuste une periode precise, pas toute une famille.
        reglage: reglagePour(reglages, seg),
        bien
      })
      // ⚠ NI LA DATE CALENDAIRE, NI 52 SEMAINES : LA CASCADE D'ALIGNEMENT.
      // Arbitrage de Thierry (13 septembre 2026), quatre etages, premier qui
      // trouve : (a) evenement a date fixe, (b) position dans l'evenement
      // mobile, (c) meme segment + meme jour de semaine + rang dans le mois,
      // (d) pas de comparable — et alors AUCUN chiffre. La regle vit dans
      // `lib/yield/comparable.js`, avec ses tests ; ici on l'applique.
      const cmp = nuitComparable(date, { contexte })
      const dateN1 = cmp && cmp.date ? cmp.date : null
      const rn1 = dateN1 ? (reelN1.get(dateN1) || null) : null
      // ⚠ « A CE DELAI, ETAIT-ELLE DEJA VENDUE ? » — la question qui dit si on
      // est en avance ou en retard SUR CETTE NUIT, pas sur le mois. Elle se
      // pose sur la nuit REELLEMENT retenue par la cascade, jamais sur une
      // date nominale que l'appariement n'a pas choisie.
      let venduePlusTotN1 = null
      if (rn1 && rn1.date_vente) {
        const limite = decaler(dateN1, -Math.max(0, delai))
        venduePlusTotN1 = String(rn1.date_vente).slice(0, 10) <= limite
      }

      return {
        date,
        jour_semaine: seg ? seg.jour_semaine : null,
        segment: seg ? seg.segment : null,
        segment_detaille: seg ? seg.detail : null,
        libelle: seg ? (seg.libelle || null) : null,
        delai_jours: delai,
        // L'etat, dans l'ordre ou il compte pour l'hote.
        vendue,
        ouverte,
        // Le motif voyage avec l'inconnue : « je ne sais pas » se justifie.
        ouverture_non_calculable: ouvertureConnue ? null : motifOuverture,
        // ⚠ LOT 4.6.0 — « PAS ENCORE OUVERTE » A SA PROPRE REPONSE, et sa
        // DATE. Sans ligne au calendrier, `ouverte` vaut `null` : pour un bien
        // en mode calendrier, c'est « non renseignee, votre calendrier ne va
        // pas jusque-la ». Pour un bien auto-pilote au-dela de sa fenetre,
        // c'est faux : personne n'a rien oublie, la fenetre glisse et la nuit
        // s'ouvrira seule. L'ecran doit pouvoir dire QUAND, sinon un
        // calendrier vide sur huit mois se lit comme une panne. La regle et
        // la date viennent de lib/pilote-tarifaire.js, en un seul endroit.
        hors_fenetre: horsFenetre.has(date),
        projection,
        prix_hote: prixHote.has(date) ? prixHote.get(date) / 100 : null,
        ouverture_prevue: horsFenetre.has(date) ? dateOuverture(bien, date, auj) : null,
        // ⚠ LE PRIX DE BASE N'EST PAS « LE PRIX AFFICHE » — releve en review.
        // Sans ligne au calendrier, `ouverte` vaut `null` (« ouverture
        // inconnue ») mais ce champ AFFIRMAIT un prix : l'ecran montrait un
        // tarif sur une nuit dont personne ne sait si elle est vendable. Et
        // quand `rate <= 0`, la capacite lit « fermee » — le repli y affichait
        // precisement le prix que le moteur refuse de pousser.
        //
        // Le repli sur `base_price` ne vaut donc que si une ligne EXISTE et
        // que la date est ouverte : la ou il decrit vraiment ce qui se vend.
        prix_actuel: l && l.rate != null && Number(l.rate) > 0
          ? Number(l.rate)
          : (parDate.has(date) && ouverts.has(date) && Number(bien.base_price) > 0
            ? Number(bien.base_price) : null),
        prix_actuel_est_le_prix_de_base: !!(
          (!l || l.rate == null || !(Number(l.rate) > 0)) &&
          parDate.has(date) && ouverts.has(date) && Number(bien.base_price) > 0),
        prix_du_jour: l && l.rate != null ? Number(l.rate) : null,
        // Le prix REELLEMENT obtenu sur cette nuit, quand elle est vendue.
        // ⚠ REPARTITION UNIFORME du prix du sejour sur ses nuits (KB
        // eclatement-yield) : ce n'est pas le prix affiche ce jour-la, c'est la
        // part de cette nuit dans ce que le voyageur a paye. Les deux different
        // sur un sejour a tarif degressif, et c'est le second qui a ete encaisse.
        prix_vendu: reelAnnee.has(date) ? reelAnnee.get(date) : null,
        suggestion: s.prix,
        niveau: s.niveau_effectif || s.niveau,
        niveau_choisi: s.niveau,
        // ⚠ L'ETIQUETTE VIENT DU MOTEUR, PAS DE L'ECRAN. Un seul vocabulaire :
        // si la page recomposait « niveau · jour » de son cote, la spec, le KB
        // et l'ecran finiraient par ne plus dire la meme chose.
        etiquette: s.etiquette || s.niveau_effectif || s.niveau || null,
        etiquette_corrigee: !!s.etiquette_corrigee,
        deplacement: s.deplacement_effectif != null ? s.deplacement_effectif : s.deplacement,
        cumul: !!s.cumul,
        // ⚠ UNE GRILLE EMPRUNTEE SE DIT. Sur un pont, le prix vient des jours
        // feries : l'ecran doit pouvoir l'annoncer, sinon l'hote lit un chiffre
        // mesure la ou il y a un emprunt raisonne.
        reference_empruntee: s.reference_empruntee || null,
        couches: s.couches,
        fourchette: s.fourchette || null,
        // ⚠ L'ETENDUE DE LA GRILLE (Prudent → Haut), pas le min-max des prix
        // observes — demande de Thierry : « le 35 € brade fait peur pour rien ».
        // Un extreme unique n'est pas une borne de decision, c'est un accident.
        // ⚠ UNE SEULE GRILLE, DONC UNE SEULE ETENDUE. La « grille du segment »
        // n'existe plus : le segment se POSITIONNE sur celle du bien.
        position: (() => {
          const p = grille.positions.get(seg ? seg.segment : null)
          if (!p) return null
          return { niveau: p.niveau, indice: p.indice, mediane: p.mediane,
            echantillon: p.echantillon, fiable: !!p.fiable,
            reference_empruntee: p.reference_empruntee || null }
        })(),
        niveau_de_depart: s.niveau_de_depart || null,
        // ⚠ L'AJUSTEMENT SE VOIT. Un niveau surprenant doit s'expliquer par le
        // reglage de l'hote plutot que de passer pour une erreur du moteur.
        ajuste_par_l_hote: !!s.ajuste_par_l_hote,
        // ⚠ L'INFLUENCE SE DIT EN CRANS, et le cran MESURE voyage a cote du
        // cran applique : l'ecart entre les deux est exactement ce que l'hote
        // a decide, et il doit pouvoir le constater.
        crans: s.crans ?? null,
        crans_mesures: s.crans_mesures ?? null,
        niveau_structure: s.niveau_structure || null,
        // ⚠ D'OU VIENT LE PRIX : mesure, modele, ou reglage de l'hote. Une
        // deduction ne se presente pas comme une observation.
        source_du_niveau: s.source_du_niveau || null,
        niveau_mesure: s.niveau_mesure || null,
        niveau_modele: s.niveau_modele || null,
        echantillon_couple: s.echantillon_couple ?? 0,
        mediane_couple: s.mediane_couple ?? null,
        ecart_modele_mesure: s.ecart_modele_mesure ?? null,
        anomalie_modele_mesure: s.anomalie_modele_mesure || null,
        cle_reglage: s.cle_reglage || null,
        affine_par_le_jour: !!s.affine_par_le_jour,
        borne_par_la_grille: !!s.borne_par_la_grille,
        echantillon: s.echantillon ?? null,
        reservations: s.reservations ?? null,
        prix_refuse: s.prix_refuse ?? null,
        plancher: s.plancher ?? null,
        non_calculable: s.non_calculable,
        n1: {
          date: dateN1,
          // ⚠ L'ETAGE VOYAGE AVEC LE CHIFFRE. L'hote doit pouvoir verifier
          // CHAQUE appariement : quelle nuit a ete retenue, et par quelle
          // regle. Sans cela, une colonne « l'an dernier » est une affirmation
          // qu'on ne peut pas contredire.
          etage: cmp ? cmp.etage : null,
          alignement: cmp ? cmp.alignement : null,
          raison: cmp ? (cmp.raison || null) : null,
          jour_semaine: cmp ? cmp.jour_semaine : null,
          meme_jour: !!(cmp && cmp.meme_jour),
          meme_segment: !!(cmp && cmp.meme_segment),
          segment: cmp ? cmp.segment : null,
          libelle: cmp ? cmp.libelle : null,
          rang: cmp ? cmp.rang : null,
          rang_n1: cmp ? cmp.rang_n1 : null,
          ecart_jours: cmp ? cmp.ecart_jours : null,
          prix_vendu: rn1 ? rn1.prix : null,
          date_vente: rn1 ? rn1.date_vente : null,
          vendue_a_ce_delai: venduePlusTotN1,
          hors_reference: rn1 ? rn1.hors_reference : false
        }
      }
    }
    const nuits = jours.map(construireNuit)

    // ─── LE RADAR, TUILE PAR TUILE ──────────────────────────────────────────
    // ⚠ LES MEMES COMPTEURS QUE LE BANDEAU D'ACTION DU MOIS, par construction :
    // la tuile appelle `construireNuit`, exactement comme la page. Recalculer
    // autrement aurait fait deux verites, et l'hote aurait cru la tuile.
    //
    // ⚠ ET LES MEMES REGLES DE SILENCE. Une nuit passee ne compte pas ; une
    // nuit fermee, non renseignee ou vendue n'a rien a monter. Ce sont les
    // alertes qui les portent — elles disent pourquoi il n'y a rien a faire.
    const radar = moisRadar.map(cle => {
      const debutM = `${cle}-01`
      const finM = finDeMois(cle)
      const joursM = joursDeLaPeriode(debutM, finM) || []
      const nuitsM = cle === cleAffichee ? nuits : joursM.map(construireNuit)
      const aVenir = nuitsM.filter(n => n.delai_jours >= 0)
      const avec = aVenir.filter(n => n.suggestion != null && n.prix_actuel != null)
      const monter = avec.filter(n => n.suggestion > n.prix_actuel)
      const baisser = avec.filter(n => n.suggestion < n.prix_actuel)
      const gain = avec.reduce((t, n) => t + (n.suggestion - n.prix_actuel), 0)
      const fermees = aVenir.filter(n => n.ouverte === false && !n.vendue)
      // ⚠ LE RADAR AVAIT SA PROPRE COPIE DU COMPTE — trouve en recette par
      // Thierry sur staging, 20 septembre 2026. Le resume du mois affiche (dans
      // la page) separait deja « pas encore ouverte » de « non renseignee » ;
      // celui-ci, calcule ici pour les douze tuiles, comptait encore toute
      // nuit `ouverte == null` comme non renseignee. Les tuiles disaient
      // « votre calendrier ne va pas jusque-la » sur des mois entiers que la
      // fenetre glissante n'a simplement pas encore atteints. Une quatrieme
      // recopie du meme compte, apres les trois que la review avait nommees.
      const attente = aVenir.filter(n => n.hors_fenetre && !n.vendue)
      const inconnues = aVenir.filter(n => n.ouverte == null && !n.vendue && !n.hors_fenetre)
      const retard = aVenir.filter(n => !n.vendue && n.ouverte === true &&
        n.n1 && n.n1.vendue_a_ce_delai === true)
      // ⚠ CE COMPTEUR ETAIT MORT, ET IL MESURAIT AUTRE CHOSE QUE SON NOM.
      // Releve en review. Il comptait `hors_fenetre_du_contexte`, motif qui n'a
      // qu'une origine — la garde de fenetre de `segmenterJour` — et que le
      // correctif `finContexte` rend desormais inatteignable : le compteur
      // valait 0 pour toujours, et le point ambre correspondant ne pouvait plus
      // s'allumer.
      //
      // Or « segments incertains » designe un risque REEL et different :
      // au-dela de la couverture du calendrier scolaire, une nuit de vacances
      // part silencieusement en « hors vacances » — `lireVacances` ne rend
      // aucun motif pour les jours qu'elle ne couvre pas. On mesure donc
      // CELA : les nuits au-dela de la derniere date publiee pour la zone du
      // bien.
      // ⚠ LE CHAMP S'APPELLE `date_fin`, PAS `fin`. J'ai ecrit `.fin` dans le
      // correctif meme qui remplaçait un compteur mort : l'alerte restait a
      // zero, sans erreur, sans rien qui paraisse casse. C'est exactement la
      // forme du defaut qu'on venait de corriger — un compteur qui ne compte
      // rien se lit comme « tout va bien ». Trouve en verifiant le chiffre
      // contre la couverture reelle (zone C, 2027-07-03), pas en relisant.
      const incertains = couvertureVacances && couvertureVacances.date_fin
        ? joursM.filter(j => j > couvertureVacances.date_fin && j >= auj).length
        : 0
      return {
        periode: cle,
        affiche: cle === cleAffichee,
        passe: finM < auj,
        nuits: nuitsM.length,
        a_monter: monter.length,
        a_baisser: baisser.length,
        vendues: aVenir.filter(n => n.vendue).length,
        gain: Math.round(gain),
        alertes: {
          fermees: fermees.length,
          non_renseignees: inconnues.length,
          pas_encore_ouvertes: attente.length,
          // La premiere date d'ouverture du mois : la tuile peut dire QUAND.
          premiere_ouverture: attente.map(n => n.ouverture_prevue).filter(Boolean).sort()[0] || null,
          en_retard: retard.length,
          segments_incertains: incertains
        }
      }
    })

    // ─── LES SEJOURS, POUR LES DEUX COLONNES DE PLANNING ────────────────────
    // ⚠ ON REPART DES LIGNES BRUTES, PAS DES SEULS ECLATEMENTS.
    // `eclater` rend `nuits: []` pour tout ce qui n'est pas confirme : une
    // demande ou une option n'aurait donc aucune barre, alors que c'est
    // precisement ce que la barre grisee existe pour montrer.
    const parBooking = new Map(eclatements.map(e => [String(e.booking_id), e]))
    const sejoursBruts = []
    for (const l of duBien) {
      const snap = l.snapshot || {}
      if (!snap.arrival || !snap.departure) continue
      const statut = readStatus(snap, bien.provider)
      // Une annulation n'occupe rien : la dessiner ferait croire a un sejour.
      if (statut === STATUS.CANCELLED) continue
      const e = parBooking.get(String(l.booking_id)) || null
      sejoursBruts.push({
        booking_id: l.booking_id,
        arrivee: String(snap.arrival).slice(0, 10),
        depart: String(snap.departure).slice(0, 10),
        statut,
        confirme: statut === STATUS.CONFIRMED || statut === STATUS.BLOCKED,
        canal: snap.source || (e && e.canal) || null,
        prix_total: e && e.prix_total != null ? Math.round(e.prix_total * 100) / 100 : null,
        date_vente: e ? e.date_vente : null,
        date_vente_fiable: !!(e && e.date_vente_fiable)
      })
    }
    const barresAnnee = SJ.barres(sejoursBruts, { jours, decalage: 0, aujourdHui: auj })
    const barresN1 = SJ.barres(sejoursBruts,
      { jours, decalage: SJ.DECALAGE_N1, aujourdHui: auj })
    const sejours = {
      decalage_n1_jours: SJ.DECALAGE_N1,
      annee: SJ.segmentsParJour(barresAnnee, jours.length),
      n1: SJ.segmentsParJour(barresN1, jours.length),
      compte: { annee: barresAnnee.length, n1: barresN1.length }
    }

    // ─── LE PIED DE MOIS ────────────────────────────────────────────────────
    // ⚠ CA VENDU A DATE CONTRE LE MEME DELAI N-1, pas contre le mois complet.
    // Comparer ce qui est vendu aujourd'hui a un mois entier de l'an dernier
    // donnerait toujours une chute, sur tous les mois a venir.
    const cleMois = debut.slice(0, 7)
    const pkMois = pickup(eclatements, { periode: cleMois, pivot: auj,
      granularite: 'mois', capacites: capacitesMois, capacitePersonnes: bien.capacity })
    // ⚠ LA PROJECTION A BESOIN DE LA COURBE ET DE LA REFERENCE, sinon elle rend
    // « trajectoire non calculable » — ce qui serait vrai, mais evitable : les
    // deux se construisent sur le meme historique deja charge.
    const reference = R.construireReference(eclatements,
      { contexte, debut: debutHistorique, fin: finRef })
    const courbe = R.courbeDeDelai(eclatements,
      { contexte, debut: debutHistorique, fin: finRef })
    const n1Mois = `${Number(cleMois.slice(0, 4)) - 1}-${cleMois.slice(5)}`
    const capN1 = capacitesMois.get(n1Mois)
    const projMois = R.projeter({
      jours: (capacite && capacite.detail) ? capacite.detail : [],
      reference, courbe, contexte,
      capacite,
      delaiJours: pkMois.delai_jours,
      nuiteesVendues: pkMois.a_date ? pkMois.a_date.nuitees : 0,
      // L'occupation de reference : celle du meme mois l'an dernier.
      occupationReference: capN1 && capN1.calculable && capN1.jours_ouverts > 0 &&
        pkMois.a_date_n1
        ? null   // le N-1 « a date » n'est pas une occupation finale
        : null
    })
    const pied = {
      periode: cleMois,
      // ⚠ LE REVPAR ENTRE AU PIED — demande de Thierry, passe 5. C'est le seul
      // indicateur qui rapporte le CA a la CAPACITE : deux mois a 2 000 € ne
      // valent pas la meme chose si l'un avait 30 nuits ouvertes et l'autre 12.
      a_date: pkMois.a_date
        ? { ca: pkMois.a_date.ca, nuitees: pkMois.a_date.nuitees,
          revpar: pkMois.a_date.revpar ?? null }
        : null,
      a_date_n1: pkMois.a_date_n1
        ? { ca: pkMois.a_date_n1.ca, nuitees: pkMois.a_date_n1.nuitees,
          revpar: pkMois.a_date_n1.revpar ?? null }
        : null,
      vs_n1: pkMois.vs_n1 || null,
      delai_jours: pkMois.delai_jours,
      drapeaux: pkMois.drapeaux || [],
      jours_ouverts: capacite && capacite.calculable ? capacite.jours_ouverts : null,
      capacite_non_calculable: capacite && !capacite.calculable
        ? (capacite.raison || 'capacite_non_calculable') : null,
      // La projection du mois, en FOURCHETTE — jamais un point.
      projection: {
        nuitees: projMois.nuitees_finales_extrapolees ?? null,
        nuitees_min: projMois.nuitees_finales_min ?? null,
        nuitees_max: projMois.nuitees_finales_max ?? null,
        non_calculable: projMois.non_calculable || []
      }
    }

    return res.status(200).json({
      pied,
      // ⚠ SERVI PAR LE MEME APPEL : aucune requete de plus depuis le
      // navigateur, aucun second endpoint. La bande vient avec le mois.
      radar,
      sejours,
      // ⚠ LES EVENEMENTS SONT RENDUS A L'ECRAN, pas seulement consommes.
      // Un niveau « Haut » en plein mois de mai doit pouvoir s'expliquer par
      // l'evenement qui l'a produit, sinon il passe pour une erreur.
      // ⚠ LA LISTE SERVIE EST CELLE DU MOIS AFFICHE, pas celle du contexte.
      // Le contexte couvre trois ans d'historique : le rendre tel quel donnait
      // douze Saint-Valentin a un ecran qui en montre une.
      evenements: evenements
        .filter(e => e.date_fin >= debut && e.date_debut <= fin)
        .map(e => ({
        id: e.id || null, nom: e.nom, segment: e.segment,
        debut: e.date_debut, fin: e.date_fin,
        origine: e.origine || 'declare',
        recurrence: e.recurrence || null, parent_segment: e.parent_segment || null
        })),
      bien: {
        pilote: piloteDuBien(bien),
        
        id: bien.id, name: bien.name, provider: bien.provider,
        capacity: bien.capacity ?? null, zone_scolaire: bien.zone_scolaire ?? null,
        prix_minimum: bien.prix_minimum ?? null, base_price: bien.base_price ?? null
      },
      fenetre: { debut, fin, aujourdhui: auj, jours: jours.length },
      // ⚠ LA FENETRE ANNONCEE EST CELLE REELLEMENT UTILISEE. Elle affirmait
      // « 3 ans » quelle que soit sa largeur reelle.
      historique: { debut: debutHistorique, fin: finRef, ans: ANS_REFERENCE,
        contexte: { debut: debutContexte, fin: finContexte } },
      grille: {
        seuil: grille.seuil,
        seuil_reservations: grille.seuil_reservations,
        niveaux: grille.niveaux,
        // ⚠ LA GRILLE DU BIEN, ET ELLE SEULE. Les contextes ne portent qu'un
        // POSITIONNEMENT dessus : aucun prix propre, donc aucun moyen
        // d'afficher « la grille des vacances » a cote de celle du bien.
        base: grille.base,
        positions: Object.fromEntries(grille.positions),
        positions_jour: Object.fromEntries(grille.positions_jour),
        nuits_vues: grille.nuits_vues
      },
      pression: Object.fromEntries(pressionParMois),
      nuits,
      droits_ecriture: garde.contexte
        ? peutEcrire(garde.contexte, 'reglages',
          { id: bien.id, ref: bien.provider_property_id })
        : true
    })
  } catch (e) {
    console.error('[yield-prix] echec :', e.message)
    return res.status(500).json({ error: 'lecture_impossible' })
  }
}
