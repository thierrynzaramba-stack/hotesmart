// api/ecran/revenus-annee.js — la vue ANNEE du bloc Revenus.
//
// ⚠ POURQUOI UN ENDPOINT A PART, ET PAS UN PARAMETRE DE L'APPEL D'ECRAN.
// `api/ecran/aujourdhui.js` part a l'OUVERTURE de la page. Le budget de cet
// ecran est de DEUX appels au chargement (spec-aujourdhui-v5 §5 bis), et un
// test les compte. La vue Annee se charge AU CLIC : la mettre dans l'appel
// d'ouverture ferait payer a chaque hote, a chaque visite, douze mois de deux
// annees qu'il ne regardera peut-etre jamais.
//
// ⚠ ET IL NE CALCULE RIEN. Il appelle `revenus_annee`, qui agrege sur un index
// partiel, et il met en forme. Mesure en production du 27 octobre 2026,
// 1 565 lignes, mediane de 12 appels : l'agregat rend 66 ms la ou une requete
// d'UNE ligne en prend 74 — il ne coute rien au-dessus du reseau. La lecture
// BRUTE des memes lignes, elle, coute 487 ms. C'est pourquoi il n'y a pas de
// table de resume : le travail couteux a deja ete fait a l'ecriture.

const { createClient } = require('@supabase/supabase-js')
// ⚠ `contexteDEcran` ET `UUID_RE` VIENNENT DE `require-permission`, pas d'un
// module a leur nom. Ma premiere version importait `lib/contexte-ecran` et
// `lib/uuid` — deux fichiers qui n'existent pas — et `node -c` l'a laissee
// passer : il verifie la SYNTAXE, jamais la resolution. Le defaut ne serait
// sorti qu'au premier appel de l'endpoint.
const { contexteDEcran, UUID_RE } = require('../../lib/require-permission')
const { refsDuPerimetre, peutLire } = require('../../lib/permissions')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ LES BORNES DE L'ANNEE SONT DURES. `p_annee` entre dans `make_date`, et une
// valeur absurde ferait balayer la table sans index utile — ou lever. Le cœur
// porte des sejours depuis 2022 ; on accepte large, mais fini.
const ANNEE_MIN = 2000
const ANNEE_MAX = 2100

// ⚠ LE PLAFOND DE LA LISTE DES BIENS, ET IL SE SIGNALE. Un compte au-dela
// verrait ses biens manquants traites comme SUPPRIMES : leurs sejours
// tomberaient dans la reserve « rattaches a aucun de vos logements » alors que
// les logements sont vivants. Le total resterait juste, les lignes fausses, et
// rien ne le dirait.
//
// C'est la classe exacte que ce depot a deja payee — `CONVERSATIONS_MAX = 5000`
// contre un plafond serveur de 1 000, ou le drapeau de troncature ne pouvait
// jamais se lever. On demande donc UNE ligne de plus que le plafond : si elle
// revient, c'est qu'il y en a davantage, et on le DIT au lieu de deviner.
const BIENS_MAX = 500

// Le jour de PARIS, et pas celui du serveur : « recu » se compare a lui, et
// `current_date` cote Postgres est en UTC. Le depot a deja paye ce decalage
// d'un jour chaque soir entre minuit et 2 heures.
const jourDeParis = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())

const n = (v) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

module.exports = async (req, res) => {
  const t0 = Date.now()
  // L'en-tete prive est pose avant tout, y compris avant un refus de methode
  // (dette 90).
  const garde = await contexteDEcran(req, res)
  if (!garde.ok) return
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const { accountUserId: compte, contexte } = garde

  // ⚠ GARDE SERVEUR DU DROIT, AVANT TOUTE LECTURE. Le masquage de l'ecran est
  // un confort ; celui-ci protege. Meme droit que la vue Mois — decision Q5 de
  // Thierry : « lecture des reservations, limitee aux biens du profil ».
  if (!peutLire(contexte, 'reservations')) {
    return res.status(403).json({ error: 'Droit « réservations » requis' })
  }

  // ⚠ LE PERIMETRE A TROIS ETATS, ET C'EST ICI QU'UNE ERREUR D'UNE LIGNE EST
  // UNE FUITE INTER-COMPTES. `null` = aucune borne (titulaire) ; `[]` = le
  // membre ne voit RIEN ; une liste = ses biens. Le piege est que `[]` est
  // « falsy-adjacent » : un `if (refs)` laisserait un perimetre vide SANS
  // filtre, donc tout le compte visible.
  const refs = refsDuPerimetre(contexte)
  const perimetreVide = Array.isArray(refs) && refs.length === 0
  const refsUuid = refs === null ? null : refs.map(String).filter(r => UUID_RE.test(r))
  // ⚠ UN PERIMETRE SANS CLE UUID NE REND PAS ZERO EURO, IL REND « JE NE SAIS
  // PAS ». C'est le cas d'un membre dont la delegation n'est exprimee qu'en
  // cles provider : `refsUuid` vaut `[]` alors que le perimetre n'est pas vide.
  // Rendre zero affirmerait qu'il n'a rien gagne.
  const uuidIntrouvable = Array.isArray(refsUuid) && refsUuid.length === 0 && !perimetreVide

  const brut = String((req.query && req.query.annee) || '')
  const demandee = /^\d{4}$/.test(brut) ? Number(brut) : null
  const jour = jourDeParis()
  const anneeCourante = Number(jour.slice(0, 4))
  // ⚠ UNE ANNEE HORS BORNES NE REMPLACE PAS SILENCIEUSEMENT PAR L'ANNEE
  // COURANTE : on refuse. Un ecran qui montre 2026 a qui a demande 1870 ment
  // sur ce qu'il affiche — et l'hote ne verrait que le resultat.
  if (brut && (demandee === null || demandee < ANNEE_MIN || demandee > ANNEE_MAX)) {
    return res.status(400).json({ error: 'Année invalide' })
  }
  const annee = demandee === null ? anneeCourante : demandee

  let requetes = 0
  const indisponibles = []

  // ⚠ LES DEUX CAS SE RESSEMBLAIENT ET NE DISENT PAS LA MEME CHOSE, et la
  // review l'a releve avant que l'ecran n'existe. Un perimetre VIDE est un
  // FAIT : ce membre ne voit aucun bien, donc zero euro est la bonne reponse,
  // et `{}` la porte. Un perimetre dont aucune cle n'est un UUID est une
  // IGNORANCE : on ne sait pas exprimer sa borne, donc on ne sait pas ce qu'il
  // a gagne.
  //
  // Les deux rendaient `{}`, et le seul discriminant etait `indisponibles`.
  // L'ecran a venir testerait `par_bien === null` — le reflexe que les deux
  // branches d'echec plus bas lui enseignent — et afficherait 0 € a un membre
  // dont on ignore tout. C'est la regle gravee du depot prise a l'envers : un
  // resume qui ecrit 0 la ou le calcul n'a rien lu transforme une absence en
  // fait. « Je ne sais pas » prend donc la MEME forme que les echecs : `null`.
  if (uuidIntrouvable) {
    indisponibles.push('revenus')
    return rendre(res, t0, requetes, {
      annee, jour, par_bien: null, hors_biens: null, total: null, indisponibles
    })
  }
  if (perimetreVide) {
    return rendre(res, t0, requetes, {
      annee, jour, par_bien: {}, hors_biens: {}, total: {},
      perimetre_vide: true, indisponibles
    })
  }

  // ─── LES DEUX LECTURES ────────────────────────────────────────────────────
  //
  // ⚠ ELLES PARTENT ENSEMBLE. Sequentielles, elles couteraient deux
  // allers-retours la ou la latence domine le calcul.
  //
  // ⚠ ET `properties` EST LU POUR NOMMER LES ORPHELINS, PAS POUR JOINDRE.
  // `revenus_annee` groupe par `property_uuid` SANS jointure — un sejour d'un
  // logement supprime garde son uuid, entre dans le total, et n'a aucune ligne
  // a l'ecran. La vue Mois le dit par sa reserve (`revenus_hors_mois`) ; ici
  // c'est l'endpoint qui fait le partage, parce qu'un fait d'argent se
  // nomme COTE SERVEUR. Laisser l'ecran le deduire de `etat.biens` marcherait
  // aujourd'hui et ferait un total qu'aucune ligne n'explique le jour ou la
  // liste des biens arriverait incomplete.
  requetes += 2
  const [{ data: lignes, error: eAnnee }, { data: biens, error: eBiens }] = await Promise.all([
    supabase.rpc('revenus_annee', {
      p_user_id: compte,
      p_annee: annee,
      p_aujourdhui: jour,
      p_refs: refsUuid === null ? null : refsUuid
    }),
    // Borne explicite : les biens du COMPTE, et du perimetre s'il y en a un.
    (refsUuid === null
      ? supabase.from('properties').select('id').eq('user_id', compte).limit(BIENS_MAX + 1)
      : supabase.from('properties').select('id').eq('user_id', compte).in('id', refsUuid).limit(BIENS_MAX + 1))
  ])

  if (eAnnee) {
    console.error('[ecran/revenus-annee] revenus_annee echec:', eAnnee.message)
    // ⚠ ON REFUSE LE BLOC ENTIER PLUTOT QUE DE RENDRE UN TOTAL AMPUTE. Un
    // agregat qui a echoue et qu'on remplace par zero affirme une absence.
    return rendre(res, t0, requetes, {
      annee, jour, par_bien: null, hors_biens: null, total: null,
      indisponibles: ['revenus']
    })
  }
  if (eBiens) {
    console.error('[ecran/revenus-annee] properties echec:', eBiens.message)
    // Sans la liste des biens, on ne peut pas distinguer un logement vivant
    // d'un logement supprime : le partage serait invente.
    return rendre(res, t0, requetes, {
      annee, jour, par_bien: null, hors_biens: null, total: null,
      indisponibles: ['revenus']
    })
  }

  // ─── LA MISE EN FORME, ET ELLE NE CALCULE RIEN DE NEUF ────────────────────
  //
  // ⚠ UNE CLE PAR (bien, annee, mois), ET AUCUN TROU COMBLE. Un mois sans
  // ligne n'est PAS un mois a zero : pour un logement ouvert en septembre,
  // janvier veut dire « il n'existait pas ». C'est la decision de Thierry du
  // 27 octobre, et elle vit jusqu'ici : si l'endpoint remplissait les mois
  // manquants de zeros, l'ecran ne pourrait plus faire la difference.
  // ⚠ LA LISTE EST-ELLE COMPLETE ? On a demande `BIENS_MAX + 1` : si on les
  // recoit tous, il en existe au moins un de plus, et le partage
  // vivant / supprime ne peut plus etre affirme.
  if ((biens || []).length > BIENS_MAX) {
    console.error(`[ecran/revenus-annee] plus de ${BIENS_MAX} biens : partage impossible`)
    return rendre(res, t0, requetes, {
      annee, jour, par_bien: null, hors_biens: null, total: null,
      indisponibles: ['revenus']
    })
  }
  const connus = new Set((biens || []).map(b => String(b.id)))
  const vide = () => ({
    sejours: 0, recu_cents: 0, a_venir_cents: 0, total_cents: 0,
    bruts: 0, sans_montant: 0
  })
  const ajouter = (cible, l) => {
    cible.sejours += n(l.sejours)
    cible.recu_cents += n(l.recu_cents)
    cible.a_venir_cents += n(l.a_venir_cents)
    cible.total_cents += n(l.total_cents)
    cible.bruts += n(l.bruts)
    cible.sans_montant += n(l.sans_montant)
    return cible
  }

  const parBien = {}
  const horsBiens = {}
  const total = {}
  for (const l of lignes || []) {
    const cle = `${n(l.annee)}-${String(n(l.mois)).padStart(2, '0')}`
    total[cle] = ajouter(total[cle] || vide(), l)
    const uuid = l.property_uuid == null ? null : String(l.property_uuid)
    if (uuid !== null && connus.has(uuid)) {
      parBien[uuid] = parBien[uuid] || {}
      parBien[uuid][cle] = ajouter(parBien[uuid][cle] || vide(), l)
    } else {
      // ⚠ `property_uuid` NUL **ou** pointant un bien absent du compte : les
      // deux vont dans la reserve. C'est la meme regle que `revenus_hors_mois`,
      // qui compte `is null OR not exists (…)` — et c'est la version DEPLOYEE
      // de cette fonction, pas celle de la migration 3 qui ne comptait que les
      // nuls. (Verifie contre la base le 27 octobre 2026.)
      horsBiens[cle] = ajouter(horsBiens[cle] || vide(), l)
    }
  }

  // ─── LA BANDE DES COMPARABLES ───────────────────────────────────────────
  // ⚠ ELLE N'EXISTE QUE POUR UN LOGEMENT DESIGNE, et c'est la decision de
  // Thierry : un min-max de comparables n'a aucun sens pour un compte entier,
  // dont les logements ont chacun les leurs. Sans `?bien=`, rien n'est lu —
  // donc aucune requete de plus sur le chemin normal.
  // ⚠ ET L'ECRAN NE LIT QUE LA TABLE : aucun appel AirROI ici. C'est le cron
  // qui releve, une fois par mois, par un writer unique.
  let comparables = null
  const bienDemande = String((req.query && req.query.bien) || '')
  if (bienDemande) {
    if (!UUID_RE.test(bienDemande)) {
      return res.status(400).json({ error: 'Logement invalide' })
    }
    // ⚠ LE PERIMETRE S'APPLIQUE A LA BANDE AUSSI. Un membre delegue qui
    // demanderait un bien hors de son perimetre lirait les comparables d'un
    // logement qu'il n'a pas le droit de voir — un masquage d'ecran ne protege
    // rien, c'est la garde serveur qui refuse.
    if (!connus.has(bienDemande)) {
      return res.status(403).json({ error: 'Logement hors de votre périmètre' })
    }
    comparables = await bandeDesComparables(supabase, bienDemande, annee, jour)
    requetes++
    if (comparables === null) indisponibles.push('comparables')
  }

  // ─── « RESERVE A DATE » ─────────────────────────────────────────────────
  // ⚠ IL N'A DE SENS QUE POUR L'ANNEE EN COURS. Comparer « deja reserve
  // aujourd'hui » a « reserve a la meme date l'an dernier » suppose un
  // aujourd'hui : sur une annee passee, les deux annees sont finies et c'est
  // le revenu FINAL qui se compare, pas un etat intermediaire.
  let reserveADate = null
  if (annee === Number(jour.slice(0, 4))) {
    reserveADate = await reserveALaMemeDate(supabase, compte, annee - 1, jour, refsUuid)
    requetes++
    if (reserveADate === null) indisponibles.push('reserve_a_date')
  }

  return rendre(res, t0, requetes, {
    annee, jour, par_bien: parBien, hors_biens: horsBiens, total, indisponibles,
    comparables, reserve_a_date: reserveADate
  })
}

// ⚠ LE SEUIL : EN DESSOUS, ON NE COMPARE PAS, ET ON LE DIT.
// Decision de Thierry du 28 octobre 2026 (option 2). Une comparaison portee
// par deux ou trois reservations ne dit rien du marche : elle dit le hasard de
// deux voyageurs. Mesure de la fenetre reelle : novembre 2025 portait 15
// reservations au pivot, decembre 9 — les deux passent largement. Cinq est
// assez bas pour les laisser passer, assez haut pour refuser une comparaison
// qu'une seule annulation ferait basculer.
const SEUIL_RESERVE_A_DATE = 5

// Le meme jour, un an plus tot.
// ⚠ LE 29 FEVRIER N'EXISTE PAS TOUS LES ANS : `new Date` le decalerait au
// 1er mars sans un mot, et le pivot sauterait un jour une annee sur quatre.
// On retombe sur le 28, qui est le dernier jour comparable.
function memeJourAnneePrecedente (jour) {
  const [an, m, j] = String(jour).split('-')
  if (m === '02' && j === '29') return `${Number(an) - 1}-02-28`
  return `${Number(an) - 1}-${m}-${j}`
}

/**
 * Ce qui etait VENDU pour chaque mois de `annee`, au meme jour l'an dernier.
 *
 * ⚠ ON REND LE COMPTE MEME SOUS LE SEUIL, MAIS PAS LE MONTANT. Le compte sert
 * a EXPLIQUER le refus (« 2 ventes a cette date l'an dernier ») ; le montant,
 * lui, ne doit pas pouvoir etre trace par accident. Taire les deux laisserait
 * l'ecran muet sur un refus qu'il doit nommer.
 */
async function reserveALaMemeDate (supabase, userId, annee, jour, refsUuid) {
  const pivot = memeJourAnneePrecedente(jour)
  const { data, error } = await supabase.rpc('revenus_reserve_a_date', {
    p_user_id: userId,
    p_annee: annee,
    p_pivot: pivot,
    p_refs: Array.isArray(refsUuid) ? refsUuid : null
  })
  if (error) {
    console.error('[ecran/revenus-annee] reserve a date :', error.message)
    return null
  }
  // ⚠ LE DETAIL PAR LOGEMENT EST GARDE, et c'est necessaire : la pastille de
  // filtre doit pouvoir piloter cette ligne comme elle pilote les autres. Ma
  // premiere version agregeait sur le seul mois — la ligne « reserve a date »
  // aurait montre le COMPTE entier pendant que la courbe montrait un bien, et
  // l'ecran aurait superpose deux perimetres differents sans le dire.
  const vide = () => ({ sejours: 0, total_cents: 0, sans_date_annulation: 0, non_fiables: 0 })
  const ajouter = (c, l) => {
    c.sejours += n(l.sejours)
    c.total_cents += n(l.total_cents)
    c.sans_date_annulation += n(l.sans_date_annulation)
    c.non_fiables += n(l.non_fiables)
    return c
  }
  const brutTotal = {}
  const brutParBien = {}
  for (const l of data || []) {
    const cle = `${annee}-${String(n(l.mois)).padStart(2, '0')}`
    brutTotal[cle] = ajouter(brutTotal[cle] || vide(), l)
    const uuid = l.property_uuid == null ? null : String(l.property_uuid)
    if (uuid === null) continue
    brutParBien[uuid] = brutParBien[uuid] || {}
    brutParBien[uuid][cle] = ajouter(brutParBien[uuid][cle] || vide(), l)
  }
  // ⚠ LE SEUIL S'APPLIQUE A CHAQUE PERIMETRE SEPAREMENT. Un mois qui passe le
  // seuil pour le compte peut ne pas le passer pour UN bien : c'est le bien
  // qu'on trace quand la pastille le designe, donc c'est son compte a lui qui
  // decide. Appliquer le seuil du compte a la courbe d'un bien tracerait une
  // comparaison que ses trois ventes ne portent pas.
  const seuiller = (brut) => {
    const out = {}
    for (const [cle, b] of Object.entries(brut)) {
      out[cle] = b.sejours < SEUIL_RESERVE_A_DATE
        ? { sejours: b.sejours, sous_seuil: true, seuil: SEUIL_RESERVE_A_DATE }
        : { ...b, sous_seuil: false, seuil: SEUIL_RESERVE_A_DATE }
    }
    return out
  }
  const parBien = {}
  for (const [uuid, m] of Object.entries(brutParBien)) parBien[uuid] = seuiller(m)
  return { pivot, seuil: SEUIL_RESERVE_A_DATE, mois: seuiller(brutTotal), par_bien: parBien }
}

// Le min et le max, mois par mois, parmi les comparables d'un logement.
//
// ⚠ ON NE REND QUE CE QUI A ETE MESURE. Un mois dont aucun comparable n'a de
// montant n'entre PAS dans la reponse : l'ecran distingue alors « pas de bande
// ici » de « bande a zero ». C'est la regle du depot, et c'est celle que la
// recette de la vue Annee a fait corriger trois fois.
//
// TROIS FILTRES, ET CHACUN FERME UN DEFAUT MESURE PAR LA REVIEW :
//   · un mois dont la COUVERTURE est partielle est ecarte — le calendrier
//     AirROI commence a sa date de capture, donc son premier mois est tronque
//     (mesure : octobre couvert sur 4 nuits sur 31, trace au ras de l'axe a
//     cote d'une courbe qui porte le mois entier) ;
//   · une ligne `futur` sur un mois DEJA CLOS est perimee, pas une mesure :
//     elle vient de drapeaux `available` releves AVANT que le mois ne se
//     termine, et l'ecran la libellerait « occupe chez les comparables » ;
//   · un mois dont les comparables ne partagent pas la MEME nature ou la MEME
//     date de photo ne se trace pas. Min et max doivent parler de la meme
//     grandeur et du meme instant — sinon on min/maxe une estimation de
//     revenu AirROI contre une somme de prix affiches, ce que la migration dit
//     explicitement d'eviter.
async function bandeDesComparables (supabase, bienId, annee, jour) {
  const debut = `${annee - 1}-01-01`
  const fin = `${annee + 1}-01-01`
  const { data, error } = await supabase
    .from('comparables_releves')
    .select('listing_id, mois, nature, montant_estime_cents, montant_affiche_cents, nuits_indisponibles, nuits_mesurees, motif, releve_le')
    .eq('property_id', bienId)
    .gte('mois', debut)
    .lt('mois', fin)
    .order('releve_le', { ascending: false })
    .limit(5000)
  if (error) {
    console.error('[ecran/revenus-annee] comparables :', error.message)
    return null
  }
  const moisCourant = String(jour).slice(0, 7)
  // La photo la plus recente de chaque (comparable, mois, nature). `order` est
  // decroissant, donc la PREMIERE vue est la bonne.
  const vues = new Set()
  const parCle = new Map()
  for (const l of data || []) {
    const cleLigne = `${l.listing_id}|${l.mois}|${l.nature}`
    if (vues.has(cleLigne)) continue
    vues.add(cleLigne)
    const mois = String(l.mois).slice(0, 7)
    // Un `futur` sur un mois clos est une donnee perimee.
    if (l.nature === 'futur' && mois < moisCourant) continue
    // Une couverture partielle ne se trace pas : le mois le DIT par son motif,
    // pose a l'ecriture par le writer.
    if (l.nature === 'futur' && Number.isFinite(Number(l.nuits_mesurees))
        && Number(l.nuits_mesurees) < joursDuMois(mois)) continue
    const montant = l.nature === 'clos' ? l.montant_estime_cents : l.montant_affiche_cents
    if (montant === null || montant === undefined) continue
    const cle = `${mois}|${l.nature}`
    if (!parCle.has(cle)) {
      parCle.set(cle, { mois, nature: l.nature, min: null, max: null, comparables: 0, sansActivite: 0, dates: new Set() })
    }
    const b = parCle.get(cle)
    // ⚠ UN COMPARABLE SANS AUCUNE ACTIVITE CE MOIS-LA NE COMPTE PAS DANS LE
    // MIN. Constat de recette du 28 octobre : « juin, le bas de la bande
    // descend a 0 € ». Un logement FERME un mois rend 0 — ce n'est pas « il a
    // gagne zero », c'est « il n'etait pas sur le marche ». Le garder tirait le
    // plancher de la bande a zero, et l'hote y lisait l'effondrement d'un
    // comparable.
    // ⚠ ET IL SE COMPTE, pour que la note puisse le dire : un comparable
    // ecarte en silence est un comparable qu'on a perdu sans le savoir.
    if (montant === 0) { b.sansActivite++; b.dates.add(String(l.releve_le)); continue }
    b.min = b.min === null ? montant : Math.min(b.min, montant)
    b.max = b.max === null ? montant : Math.max(b.max, montant)
    b.comparables++
    b.dates.add(String(l.releve_le))
  }
  const mois = {}
  for (const b of parCle.values()) {
    // ⚠ UNE SEULE DATE DE PHOTO PAR MOIS. `releve_le` vient du cache AirROI,
    // propre a chaque annonce : le min pourrait venir d'une photo de juillet et
    // le max d'une d'octobre, et l'ecran afficherait une seule date pour les
    // deux. Un mois dont les photos divergent ne se trace pas — il se tait, ce
    // qui est la seule reponse qui n'invente rien.
    // ⚠ PLUS AUCUN COMPARABLE ACTIF : le mois n'a pas de bande, et ce n'est
    // PAS une bande a zero. Ce garde remplace celui qui ecartait les mois
    // futurs a zero : un mois dont tous les comparables sont fermes sort
    // desormais par la meme regle, et il n'y en a plus qu'une.
    if (!b.comparables) continue
    if (b.dates.size !== 1) continue
    // ⚠ ET UN MOIS DEJA PRIS PAR SA NATURE `clos` NE SE FAIT PAS DOUBLER par
    // une ligne `futur` : le realise prime sur l'occupe.
    if (mois[b.mois] && mois[b.mois].nature === 'clos') continue
    mois[b.mois] = {
      nature: b.nature, min_cents: b.min, max_cents: b.max,
      comparables: b.comparables, sans_activite: b.sansActivite,
      releve_le: [...b.dates][0]
    }
  }
  return { mois, jour }
}

// Le nombre de jours d'un mois « YYYY-MM ». ⚠ `Date.UTC(an, m, 0)` rend le
// DERNIER jour du mois precedent, donc le compte du mois `m`.
function joursDuMois (mois) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mois || ''))) return 0
  const [an, m] = String(mois).split('-').map(Number)
  return new Date(Date.UTC(an, m, 0)).getUTCDate()
}

// ⚠ `Server-Timing` PORTE LE COMPTE DE REQUETES, et c'est un PLANCHER annonce
// comme tel : `contexteDEcran` fait un a trois allers-retours qui ne sont pas
// comptes ici. Un instrument pose pour designer la CAUSE qui se donnerait pour
// exact serait pire que pas d'instrument.
function rendre (res, t0, requetes, charge) {
  const total = Date.now() - t0
  res.setHeader('Server-Timing', `total;dur=${total};desc="${requetes} req (ordre de grandeur)"`)
  return res.status(200).json(charge)
}
