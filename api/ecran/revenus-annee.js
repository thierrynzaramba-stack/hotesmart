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

  return rendre(res, t0, requetes, {
    annee, jour, par_bien: parBien, hors_biens: horsBiens, total, indisponibles,
    comparables
  })
}

// Le min et le max, mois par mois, parmi les comparables d'un logement.
//
// ⚠ ON NE REND QUE CE QUI A ETE MESURE. Un mois dont aucun comparable n'a de
// montant n'entre PAS dans la reponse : l'ecran distingue alors « pas de bande
// ici » de « bande a zero ». C'est la meme regle que la vue Annee, et c'est
// celle que sa recette a fait corriger trois fois.
//
// ⚠ UN SEUL RELEVE PAR (comparable, mois) : LE PLUS RECENT. La table garde
// toutes les photos — c'est son role —, mais la bande d'aujourd'hui se lit sur
// la derniere. Melanger deux photos du meme comparable ferait un min et un max
// qui ne parlent pas du meme instant.
async function bandeDesComparables (supabase, bienId, annee, jour) {
  const debut = `${annee - 1}-01-01`
  const fin = `${annee + 1}-01-01`
  const { data, error } = await supabase
    .from('comparables_releves')
    .select('listing_id, mois, nature, montant_estime_cents, montant_affiche_cents, nuits_indisponibles, nuits_mesurees, releve_le')
    .eq('property_id', bienId)
    .gte('mois', debut)
    .lt('mois', fin)
    .order('releve_le', { ascending: false })
    .limit(5000)
  if (error) {
    console.error('[ecran/revenus-annee] comparables :', error.message)
    return null
  }
  // La photo la plus recente de chaque (comparable, mois). `order` est
  // decroissant, donc la PREMIERE vue est la bonne.
  const vues = new Set()
  const parMois = new Map()
  let releveLe = null
  for (const l of data || []) {
    const cleLigne = `${l.listing_id}|${l.mois}`
    if (vues.has(cleLigne)) continue
    vues.add(cleLigne)
    const montant = l.nature === 'clos' ? l.montant_estime_cents : l.montant_affiche_cents
    if (montant === null || montant === undefined) continue
    const cle = String(l.mois).slice(0, 7)
    if (!parMois.has(cle)) parMois.set(cle, { nature: l.nature, min: montant, max: montant, comparables: 0, releve_le: l.releve_le })
    const b = parMois.get(cle)
    b.min = Math.min(b.min, montant)
    b.max = Math.max(b.max, montant)
    b.comparables++
    if (!releveLe || String(l.releve_le) > releveLe) releveLe = String(l.releve_le)
  }
  const mois = {}
  for (const [cle, b] of parMois) {
    mois[cle] = {
      nature: b.nature, min_cents: b.min, max_cents: b.max,
      comparables: b.comparables, releve_le: b.releve_le
    }
  }
  return { mois, releve_le: releveLe, jour }
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
