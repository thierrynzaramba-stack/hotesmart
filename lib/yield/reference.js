// lib/yield/reference.js — LA REFERENCE PAR SEGMENT et la PROJECTION.
// Lot 3.4 de l'etape 3, le dernier. Spec : docs/specs/spec-yieldflow-v1.md §6.
//
// ⚠ FONCTIONS PURES. Les vacances arrivent deja chargees (`vacances.js`), les
// feries se calculent (`jours-feries.js`). Ni base, ni reseau, ni horloge.
//
// CE QU'ELLE REPOND : « qu'est-ce qui est NORMAL pour ce bien, un samedi de
// vacances d'hiver ? ». Le realise dit ce qui s'est passe, le « a date » dit
// ou on en est ; la reference dit a quoi comparer. Sans elle, une suggestion
// de prix n'aurait aucun point d'appui.

const { estJourISO, joursDeLaPeriode } = require('./capacite')
const { joursFeriesEntre } = require('./jours-feries')
const { mediane } = require('./indicateurs')

const JOURS_SEMAINE = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi',
  'vendredi', 'samedi']

// ⚠ UN SEUL SEGMENT PAR JOUR, PAR PRIORITE — arbitrage de Thierry.
// Le 14 juillet est ferie ET en vacances d'ete : sans ordre fixe, il compterait
// deux fois et les echantillons se chevaucheraient. L'ordre va du plus
// specifique au plus general.
const SEGMENTS = {
  FERIE: 'ferie',
  PONT: 'pont',
  VACANCES_ZONE: 'vacances_zone_du_bien',
  VACANCES_AUTRE: 'vacances_autre_zone',
  HORS_VACANCES: 'hors_vacances'
}

// Les quatre niveaux de la cascade, du plus fin au plus grossier.
//
// ⚠ LE DERNIER NIVEAU EST LE JOUR DE SEMAINE, PAS « TOUT LE BIEN ».
// Premiere version : le plancher etait la mediane de toutes les nuits du bien.
// Constate sur piece — le pont du 2 mai 2025, 7 nuits vendues en trois ans
// donc sous le seuil, recevait 124,39 € : la mediane de 665 nuits toutes
// saisons et tous jours confondus, un chiffre sans aucun rapport avec un
// vendredi de pont. Or le jour de semaine est le signal le plus stable du
// parc : 145,80 € le samedi hors vacances contre 109,71 € le mardi, +33 %.
// Replier sur « tous les vendredis » garde ce signal-la quand la saison n'a
// plus assez de matiere ; replier sur « tout » n'en gardait aucun.
const NIVEAUX = ['segment_detaille_x_jour', 'segment_x_jour', 'segment', 'jour_de_semaine']

// ⚠ SEUIL MESURE, PAS CHOISI AU HASARD. Sur La bulle, 3 ans, 680 nuits
// vendues : la decoupe la plus fine (nom des vacances x jour de semaine)
// produit 66 cases dont 36 sous 5 nuits tarifees. Une mediane sur 3 nuits
// n'est pas une reference, c'est un accident. A 8, la cascade place 18 cases
// au niveau le plus fin, 29 au deuxieme, 19 au troisieme, et AUCUNE au
// plancher — c'est le point ou elle cesse d'etre un cache-misere.
const SEUIL_DEFAUT = 8

// ⚠ HUIT NUITS NE FONT PAS HUIT OBSERVATIONS — releve en review.
// `eclater` repartit le prix UNIFORMEMENT : les 11 nuits d'un sejour portent
// exactement le meme prix. Une seule reservation franchissait donc le seuil de
// 8, et la « norme » de tous les etes du bien pouvait etre UNE reservation.
// Une case doit aussi reposer sur plusieurs reservations distinctes.
const SEUIL_RESERVATIONS = 3

// Au-dela de ce seuil, `eclater` marque `long_sejour`. Ces nuits sont ecartees
// de la REFERENCE : un sejour de 28 nuits a tarif degressif verse 4 samedis
// identiques dans une case qui en compte 18, et fabrique la norme au lieu de
// la mesurer. `eclatement.js` posait deja le drapeau « pour que les moyennes
// les ecartent » — personne ne le lisait.

function jourDeSemaine (iso) {
  if (!estJourISO(iso)) return null
  return JOURS_SEMAINE[new Date(`${iso}T00:00:00Z`).getUTCDay()]
}

function estWeekEnd (iso) {
  const j = jourDeSemaine(iso)
  return j === 'samedi' || j === 'dimanche'
}

function decaler (iso, n) {
  if (!estJourISO(iso)) return null
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * LES PONTS, CALCULES — il n'existe aucune source officielle qui les publie.
 *
 * Definition retenue, celle de l'usage francais : un jour OUVRE et NON FERIE
 * coince entre un ferie et un week-end.
 *   - jeudi 8 mai ferie  → vendredi 9 mai est un pont (ferie avant, samedi apres)
 *   - mardi 1er mai ferie → lundi 30 avril est un pont (dimanche avant, ferie apres)
 *
 * ⚠ CHAQUE JOUR EST JUGE SEUL, ON N'INVENTE PAS DE SEMAINE DE PONT. Un
 * mercredi ferie ne fait pas du lundi et du mardi des ponts : ni l'un ni
 * l'autre n'est encadre. Une semaine peut malgre tout produire plusieurs ponts
 * quand plusieurs feries s'y suivent — releve en review : en mai 2029, les 7,
 * 9 et 11 sont ponts, le 9 etant pris entre le 8 mai et l'Ascension du 10.
 * Chacun est bien encadre : c'est la definition qui le veut, pas une
 * extrapolation.
 */
function pontsEntre (debut, fin) {
  const out = new Map()
  if (!estJourISO(debut) || !estJourISO(fin) || fin < debut) return out
  // On elargit d'un jour de chaque cote : un pont du 1er janvier depend du
  // 31 decembre precedent.
  const feries = joursFeriesEntre(decaler(debut, -3), decaler(fin, 3))
  // ⚠ `joursDeLaPeriode` rend `null` au-dela de JOURS_MAX — releve en review.
  // `for (const j of null)` levait un TypeError, et l'appel le plus plausible
  // (couvrir historique ET horizon d'un seul coup) depasse la borne.
  const jours = joursDeLaPeriode(debut, fin)
  if (!jours || !jours.length) return out
  for (const j of jours) {
    if (feries.has(j) || estWeekEnd(j)) continue
    const veille = decaler(j, -1)
    const lendemain = decaler(j, 1)
    const avant = feries.has(veille) || estWeekEnd(veille)
    const apres = feries.has(lendemain) || estWeekEnd(lendemain)
    if (avant && apres) {
      // Le nom du ferie qui le cause, pour que l'hote comprenne la ligne.
      out.set(j, feries.get(veille) || feries.get(lendemain) || 'pont')
    }
  }
  return out
}

/**
 * Classe UN jour dans un seul segment, et rend aussi son detail.
 *
 * @param {string} iso        le jour
 * @param {Object} contexte
 *   - zoneBien   'A' | 'B' | 'C' — situe le bien, ne limite pas le moteur
 *   - vacances   sortie de `lireVacances` (toutes zones)
 *   - feries     Map jour -> nom (sortie de `joursFeriesEntre`)
 *   - ponts      Map jour -> nom (sortie de `pontsEntre`)
 */
function segmenterJour (iso, contexte = {}) {
  const { zoneBien = null, vacances = [], feries = null, ponts = null,
    fenetre = null } = contexte
  if (!estJourISO(iso)) return null
  // ⚠ UN CONTEXTE QUI NE COUVRE PAS LE JOUR SE DIT — releve en review.
  // `feries` et `ponts` sont des Map bornees a la fenetre sur laquelle on les
  // a calculees. Un jour hors de cette fenetre n'y figure pas : la priorite
  // etait alors contournee par simple ABSENCE, sans un signal. Constate :
  // avec un contexte bati sur 2025, le 14 juillet 2026 partait en
  // « hors_vacances » au lieu de « ferie », et `construireReference` (3 ans
  // d'historique) et `referencePour` (jours futurs) divergeaient en silence.
  if (fenetre && (iso < fenetre.debut || iso > fenetre.fin)) {
    return { date: iso, jour_semaine: jourDeSemaine(iso), zone_bien: zoneBien,
      segment: null, detail: null, non_calculable: 'hors_fenetre_du_contexte' }
  }
  const js = jourDeSemaine(iso)
  const base = { date: iso, jour_semaine: js, zone_bien: zoneBien }

  if (feries && feries.has && feries.has(iso)) {
    return { ...base, segment: SEGMENTS.FERIE, detail: SEGMENTS.FERIE,
      libelle: feries.get(iso) }
  }
  if (ponts && ponts.has && ponts.has(iso)) {
    return { ...base, segment: SEGMENTS.PONT, detail: SEGMENTS.PONT,
      libelle: `pont ${ponts.get(iso)}` }
  }
  // ⚠ LA ZONE DU BIEN D'ABORD, LES AUTRES ENSUITE. Mesure sur La bulle,
  // 3 ans : mediane de 145,00 € en vacances de sa propre zone contre 117,00 €
  // en vacances d'une AUTRE zone — soit exactement la mediane hors vacances.
  // Les vacances des autres zones ne remplissent pas ce bien. Les confondre
  // aurait dilue le seul segment qui porte un vrai signal.
  const dansZone = vacances.filter(v => v && v.zone === zoneBien &&
    iso >= v.date_debut && iso <= v.date_fin)
  if (dansZone.length) {
    return { ...base, segment: SEGMENTS.VACANCES_ZONE,
      detail: `${SEGMENTS.VACANCES_ZONE}:${nomCourt(dansZone[0].nom)}`,
      libelle: dansZone[0].nom, zones_en_vacances: zonesDuJour(iso, vacances) }
  }
  const autres = vacances.filter(v => v && iso >= v.date_debut && iso <= v.date_fin)
  if (autres.length) {
    return { ...base, segment: SEGMENTS.VACANCES_AUTRE,
      detail: `${SEGMENTS.VACANCES_AUTRE}:${nomCourt(autres[0].nom)}`,
      libelle: autres[0].nom, zones_en_vacances: zonesDuJour(iso, vacances) }
  }
  return { ...base, segment: SEGMENTS.HORS_VACANCES, detail: SEGMENTS.HORS_VACANCES }
}

/**
 * Assemble un contexte de segmentation SUR UNE FENETRE EXPLICITE.
 *
 * ⚠ A PREFERER A UN OBJET BATI A LA MAIN. C'est lui qui garantit que les
 * feries, les ponts et la fenetre parlent de la meme periode — l'incoherence
 * que la review a trouvee venait d'un contexte assemble a la main pour
 * l'historique, puis reutilise pour des jours futurs qu'il ne couvrait pas.
 */
function construireContexte (options = {}) {
  const { zoneBien = null, vacances = [], debut, fin } = options
  if (!estJourISO(debut) || !estJourISO(fin) || fin < debut) {
    return { zoneBien, vacances: [], feries: new Map(), ponts: new Map(),
      fenetre: null, non_calculable: 'fenetre_invalide' }
  }
  return {
    zoneBien,
    vacances: vacances || [],
    feries: joursFeriesEntre(debut, fin),
    ponts: pontsEntre(debut, fin),
    fenetre: { debut, fin }
  }
}

function zonesDuJour (iso, vacances) {
  return [...new Set((vacances || [])
    .filter(v => v && iso >= v.date_debut && iso <= v.date_fin)
    .map(v => v.zone))].sort()
}

function nomCourt (nom) {
  return String(nom || '')
    .replace(/^Vacances\s+(de\s+la\s+|de\s+|d'|du\s+)?/i, '')
    .trim().toLowerCase().replace(/\s+/g, '_')
}

/**
 * Construit la reference d'un bien : la mediane du prix par nuit, par case.
 *
 * ⚠ LA MEDIANE, JAMAIS LA MOYENNE. Une seule nuit bradee a 40 € ou un long
 * sejour a tarif degressif deplacerait une moyenne de plusieurs euros sur un
 * echantillon de dix nuits. La mediane ne bouge pas.
 *
 * ⚠ LES NUITS HORS REFERENCE SONT EXCLUES — c'est leur raison d'etre. Une
 * fermeture pour travaux appartient au realise, pas a la norme.
 *
 * @param {Array} eclatements  sortie d'`eclater()`
 * @param {Object} options
 *   - contexte   { zoneBien, vacances, feries, ponts }
 *   - debut/fin  fenetre d'historique (3 ans glissants : arbitrage de Thierry)
 *   - seuil      nuits tarifees minimum pour qu'une case fasse reference
 */
function construireReference (eclatements, options = {}) {
  const { contexte = {}, debut = null, fin = null, seuil = SEUIL_DEFAUT,
    seuilResas = SEUIL_RESERVATIONS } = options
  const cases = [new Map(), new Map(), new Map(), new Map()]
  const ajouter = (i, cle, prix) => {
    if (!cases[i].has(cle)) cases[i].set(cle, [])
    cases[i].get(cle).push(prix)
  }
  let nuitsVues = 0
  let nuitsSansPrix = 0
  let nuitsHorsReference = 0
  let nuitsLongSejour = 0
  const reservations = [new Map(), new Map(), new Map(), new Map()]
  const compterResa = (i, cle, id) => {
    if (!reservations[i].has(cle)) reservations[i].set(cle, new Set())
    reservations[i].get(cle).add(id)
  }

  let idAuto = 0
  for (const e of eclatements || []) {
    if (!e || !e.compte) continue
    const id = e.booking_id != null ? String(e.booking_id) : `anon-${idAuto++}`
    for (const n of e.nuits || []) {
      if (debut && n.date < debut) continue
      if (fin && n.date > fin) continue
      nuitsVues++
      if (n.hors_reference) { nuitsHorsReference++; continue }
      if (e.long_sejour) { nuitsLongSejour++; continue }
      if (n.prix == null || !Number.isFinite(n.prix)) { nuitsSansPrix++; continue }
      const s = segmenterJour(n.date, contexte)
      if (!s || !s.segment) continue
      const cles = [`${s.detail}|${s.jour_semaine}`, `${s.segment}|${s.jour_semaine}`,
        s.segment, s.jour_semaine]
      for (let i = 0; i < 4; i++) { ajouter(i, cles[i], n.prix); compterResa(i, cles[i], id) }
    }
  }

  const resume = (m, i) => {
    const out = new Map()
    for (const [cle, prix] of m) {
      out.set(cle, { valeur: mediane(prix), echantillon: prix.length,
        reservations: (reservations[i].get(cle) || new Set()).size,
        min: Math.min(...prix), max: Math.max(...prix) })
    }
    return out
  }
  return {
    seuil,
    seuil_reservations: seuilResas,
    fenetre: { debut, fin },
    niveaux: cases.map(resume),
    nuits_vues: nuitsVues,
    nuits_sans_prix: nuitsSansPrix,
    nuits_hors_reference: nuitsHorsReference,
    nuits_long_sejour: nuitsLongSejour
  }
}

/**
 * La reference applicable a UN jour, avec le niveau reellement utilise.
 *
 * ⚠ LE NIVEAU DE REPLI VIT DANS LA DONNEE, pas dans l'interface. Meme exigence
 * qu'aux lots 3.2 et 3.3 : l'etape 4 ne doit pas POUVOIR presenter « la
 * mediane de tout le bien » comme « la mediane des samedis de fevrier ». Un
 * repli est une reponse plus faible, et cela doit se voir.
 */
function referencePour (reference, iso, contexte = {}) {
  const vide = { valeur: null, niveau: null, echantillon: 0, segment: null,
    non_calculable: 'aucun_historique' }
  if (!reference || !reference.niveaux) return vide
  const s = segmenterJour(iso, contexte)
  if (!s) return { ...vide, non_calculable: 'date_invalide' }
  if (!s.segment) return { ...vide, non_calculable: s.non_calculable || 'segment_inconnu' }
  const cles = [`${s.detail}|${s.jour_semaine}`, `${s.segment}|${s.jour_semaine}`,
    s.segment, s.jour_semaine]
  // Les segments sans sous-decoupe (ferie, pont, hors vacances) ont le meme
  // libelle aux deux premiers niveaux : annoncer « segment detaille » y serait
  // faux, la finesse annoncee n'existe pas.
  const premierNiveauReel = s.detail === s.segment ? 1 : 0
  const seuilResas = reference.seuil_reservations || 1
  for (let i = 0; i < cles.length; i++) {
    const c = reference.niveaux[i].get(cles[i])
    // ⚠ DEUX SEUILS, PAS UN : des nuits ET des reservations distinctes.
    if (c && c.echantillon >= reference.seuil && c.valeur != null &&
        (c.reservations == null || c.reservations >= seuilResas)) {
      const niveau = NIVEAUX[Math.max(i, premierNiveauReel)]
      return { valeur: c.valeur, niveau, echantillon: c.echantillon,
        reservations: c.reservations,
        segment: s.detail, jour_semaine: s.jour_semaine, libelle: s.libelle || null,
        // Un repli est une reponse plus faible : on le DIT.
        replie: Math.max(i, premierNiveauReel) > premierNiveauReel ? niveau : null,
        min: c.min, max: c.max }
    }
  }
  // ⚠ AUCUN NIVEAU NE TIENT : on ne rend PAS la derniere mediane disponible.
  // Servir la mediane d'une case a deux nuits parce qu'il n'y a rien d'autre,
  // c'est exactement le « chiffre la ou la verite est je ne sais pas » que ce
  // chantier combat depuis le lot 3.2.
  const plancher = reference.niveaux[3].get(s.jour_semaine)
  return { ...vide, segment: s.detail, jour_semaine: s.jour_semaine,
    echantillon: plancher ? plancher.echantillon : 0,
    non_calculable: 'echantillon_sous_le_seuil' }
}

/**
 * LA COURBE DE DELAI : quelle part du portefeuille est vendue a J-n.
 *
 * C'est la moitie « trajectoire » de la projection. La reference dit COMBIEN
 * une nuit vaut ; la courbe dit QUAND elle se vend. Sans elle, un pickup a
 * 30 % de l'an dernier ne se lit pas : encore faut-il savoir si, a ce delai,
 * 30 % est en avance ou en retard.
 *
 * ⚠ DATES FIABLES SEULEMENT. Une date de vente reconstruite a la migration
 * placerait toutes les ventes au meme delai et ecraserait la courbe.
 */
function courbeDeDelai (eclatements, options = {}) {
  const { contexte = {}, debut = null, fin = null, seuil = SEUIL_DEFAUT,
    paliers = [0, 7, 14, 30, 60, 90, 180] } = options
  const parSegment = new Map()
  let sansDateFiable = 0

  for (const e of eclatements || []) {
    if (!e || !e.compte) continue
    for (const n of e.nuits || []) {
      if (debut && n.date < debut) continue
      if (fin && n.date > fin) continue
      if (n.hors_reference) continue
      const s = segmenterJour(n.date, contexte)
      if (!s || !s.segment) continue
      if (!parSegment.has(s.segment)) {
        parSegment.set(s.segment,
          { total: 0, delais: [], sans_date: 0, negatifs: 0, illisibles: 0 })
      }
      const p = parSegment.get(s.segment)
      p.total++
      if (!e.date_vente_fiable || !e.date_vente) { p.sans_date++; sansDateFiable++; continue }
      const d = Math.round((Date.parse(`${n.date}T00:00:00Z`) -
        Date.parse(`${String(e.date_vente).slice(0, 10)}T00:00:00Z`)) / 86400000)
      // ⚠ LES DELAIS NEGATIFS SE COMPTENT, ILS NE S'EVAPORENT PAS — releve en
      // review. Une nuit vendue APRES sa propre date (saisie tardive cote
      // Channex) etait comptee au total, absente des delais ET absente des
      // sans-date : la somme des trois compteurs ne faisait plus le total, et
      // « champ absent » se confondait avec « regle violee » (regle 13).
      if (!Number.isFinite(d)) { p.illisibles++; continue }
      if (d < 0) { p.negatifs++; continue }
      p.delais.push(d)
    }
  }

  const out = new Map()
  for (const [seg, p] of parSegment) {
    // ⚠ LE DENOMINATEUR EST LE NOMBRE DE NUITS A DATE FIABLE, PAS LE TOTAL.
    // Compter au denominateur des nuits dont on ignore la date de vente
    // ferait croire que rien ne s'est vendu tot : la courbe serait ecrasee
    // vers le bas, et le moteur dirait « en retard » a un bien en avance.
    const base = p.delais.length
    // ⚠ CE QUE CETTE COURBE EST, ET CE QU'ELLE N'EST PAS.
    // `part_vendue` est la part des ventes FINALES du segment deja realisees a
    // J-n. Ce n'est PAS un taux d'occupation : le denominateur est ce qui a
    // fini par se vendre, pas la capacite ouverte. Le palier J-0 vaut donc 1
    // par construction — c'est une identite, pas une mesure, et on le DIT
    // plutot que de laisser un lecteur y voir « 100 % d'occupation ».
    const courbe = paliers.map(j => ({
      jours_avant: j,
      part_vendue: base ? Math.round((p.delais.filter(d => d >= j).length / base) * 10000) / 10000 : null,
      trivial: j === 0 || undefined
    }))
    out.set(seg, {
      segment: seg,
      mesure: 'part des ventes finales deja realisees',
      nuits: p.total,
      nuits_datees: base,
      nuits_sans_date_fiable: p.sans_date,
      nuits_delai_negatif: p.negatifs,
      nuits_delai_illisible: p.illisibles,
      delai_median: mediane(p.delais),
      courbe,
      // Sous le seuil, une courbe n'est qu'une anecdote.
      fiable: base >= seuil,
      non_calculable: base >= seuil ? null : 'echantillon_sous_le_seuil'
    })
  }
  return { paliers, par_segment: out, nuits_sans_date_fiable: sansDateFiable }
}

/**
 * La projection d'une periode : ce que la reference et la courbe laissent
 * attendre, et ou en est le portefeuille par rapport a cette attente.
 *
 * ⚠ ON NE PROJETTE QUE CE QUI EST OUVERT. Le denominateur est `joursOuverts`,
 * la meme memoire d'intention que partout ailleurs : projeter des nuits sur un
 * bien ferme inventerait un manque a gagner qui n'existe pas (Coeur de vie 23,
 * octobre 2026, zero jour ouvert — lot 3.3).
 */
function projeter (options = {}) {
  const { jours = [], reference = null, courbe = null, contexte = {},
    delaiJours = null, nuiteesVendues = 0, capacite = null,
    occupationReference = null } = options
  const detail = []
  let caAttendu = 0
  let joursSansReference = 0
  let joursReplies = 0

  for (const j of jours) {
    const r = referencePour(reference, j, contexte)
    detail.push({ date: j, ...r })
    if (r.valeur == null) { joursSansReference++; continue }
    caAttendu += r.valeur
    // ⚠ LE NIVEAU DE REPLI NE DOIT PAS SE PERDRE DANS LA MOYENNE — releve en
    // review. `prix_attendu_moyen` melangeait sans compteur les jours servis
    // au niveau le plus fin et ceux servis au plancher « jour de semaine ».
    // C'est la regle du lot 3.2 qui sautait a l'endroit precis ou l'etape 4
    // ne lira qu'un seul chiffre.
    if (r.replie) joursReplies++
  }

  const out = {
    jours_projetes: jours.length,
    jours_sans_reference: joursSansReference,
    jours_replies: joursReplies,
    // Prix attendu par nuit PROJETEE. ⚠ L'appelant doit passer les jours
    // OUVERTS s'il veut un prix par nuit ouverte : ce module ne peut pas le
    // verifier, c'est un contrat d'appel — releve en review, dit ici.
    prix_attendu_moyen: jours.length > joursSansReference
      ? Math.round((caAttendu / (jours.length - joursSansReference)) * 100) / 100
      : null,
    detail,
    non_calculable: []
  }
  if (joursSansReference) out.non_calculable.push('jours_sans_reference')

  // ─── LA TRAJECTOIRE ───────────────────────────────────────────────────────
  // ⚠ CE QUI A ETE REFAIT APRES LA REVIEW, ET POURQUOI.
  // Premiere version : `nuitees_attendues = jours_ouverts x part_vendue`. Or
  // `part_vendue` est une part des ventes FINALES, pas de la capacite : le
  // produit supposait 100 % d'occupation finale. Le palier J-0 valant 1 par
  // construction, un bien a 3 jours ouverts et 1 nuit vendue s'entendait dire
  // « 2 nuits de retard » alors qu'il etait normal. Le biais etait systematique
  // et d'un seul cote, sur le chiffre-titre du lot.
  //
  // La courbe repond a « quelle part de mes ventes finales est deja faite ? ».
  // On l'utilise donc dans ce sens : EXTRAPOLER le final depuis le portefeuille
  // (`vendu / part`), jamais multiplier une capacite. Et comparer ce final
  // extrapole demande une OCCUPATION DE REFERENCE, que ce module ne peut pas
  // deviner : l'appelant la fournit (taux d'occupation N-1 ou du segment), ou
  // l'avance/retard n'est pas calculable. On prefere ne rien dire.
  if (!capacite || capacite.calculable !== true) {
    // ⚠ « FERME » ET « JE NE SAIS PAS » NE SONT PAS LA MEME CHOSE — releve en
    // review. `joursOuverts` rend `jours_ouverts: 0` sur ses SIX motifs de
    // non-calculabilite : la branche ne lisait que le zero et annoncait
    // « periode fermee a la vente » a un bien Beds24 sans memoire d'intention,
    // qui vend pourtant. Le defaut meme que ce chantier combat, dans le module
    // qui pretend ne pas le commettre.
    out.non_calculable.push('capacite_non_calculable')
    if (capacite && capacite.raison) out.capacite_raison = capacite.raison
    return out
  }
  if (capacite.jours_ouverts === 0) {
    // Rien a projeter sur une periode fermee, et ce n'est pas un manque.
    out.non_calculable.push('periode_fermee_a_la_vente')
    return out
  }
  if (!courbe || delaiJours == null) {
    out.non_calculable.push('trajectoire_non_calculable')
    return out
  }
  // ⚠ UNE PERIODE DEJA COMMENCEE N'A PLUS DE TRAJECTOIRE « AVANT DEBUT ».
  // Constate a la premiere lecture reelle de l'endpoint : septembre 2026, vu
  // du 12 septembre, a un delai NEGATIF. Aucun palier de la courbe (tous >= 0)
  // ne pouvait s'y appliquer, et le motif rendu etait « aucune_courbe_fiable »
  // — qui accuse la DONNEE alors que c'est la QUESTION qui ne se pose plus.
  // Un lecteur aurait conclu que son historique est trop mince.
  // ⚠ `<= 0`, PAS `< 0` — releve en review. Le PREMIER jour de la periode a un
  // delai de zero : il attrapait alors le palier J-0, dont `courbeDeDelai` dit
  // lui-meme qu'il vaut 1 PAR CONSTRUCTION et le marque `trivial`. Un
  // portefeuille de 12 nuitees au 1er octobre rendait
  // « 12 nuitees finales attendues, 9 de retard » sur un mois qui commence :
  // le chiffre faux et credible que ce correctif visait, decale d'une journee.
  if (delaiJours <= 0) {
    out.non_calculable.push('periode_deja_commencee')
    return out
  }

  // Part attendue, ponderee par le nombre de jours de chaque segment.
  const segs = new Map()
  for (const j of jours) {
    const s = segmenterJour(j, contexte)
    if (s && s.segment) segs.set(s.segment, (segs.get(s.segment) || 0) + 1)
  }
  let attendue = 0
  let couverts = 0
  for (const [seg, n] of segs) {
    const c = courbe.par_segment.get(seg)
    if (!c || !c.fiable) continue
    const palier = [...c.courbe].reverse().find(p => p.jours_avant <= delaiJours)
    if (!palier || palier.part_vendue == null) continue
    attendue += n * palier.part_vendue
    couverts += n
  }
  if (couverts === 0) {
    out.non_calculable.push('aucune_courbe_fiable')
    return out
  }
  out.part_attendue_a_ce_delai = Math.round((attendue / couverts) * 10000) / 10000
  out.nuitees_vendues = nuiteesVendues
  if (couverts < jours.length) {
    out.non_calculable.push('trajectoire_partielle')
    out.jours_hors_trajectoire = jours.length - couverts
  }

  // EXTRAPOLATION : ou finira ce portefeuille s'il suit le rythme habituel.
  if (out.part_attendue_a_ce_delai > 0) {
    out.nuitees_finales_extrapolees =
      Math.round((nuiteesVendues / out.part_attendue_a_ce_delai) * 100) / 100
    out.taux_occupation_extrapole =
      Math.round((out.nuitees_finales_extrapolees / capacite.jours_ouverts) * 10000) / 10000
  } else {
    // A ce delai, l'historique n'avait rien vendu : diviser par zero
    // inventerait un infini. On ne sait pas, on le dit.
    out.non_calculable.push('rien_ne_se_vend_a_ce_delai')
    return out
  }

  // AVANCE OU RETARD : seulement contre une occupation de reference FOURNIE.
  if (occupationReference == null) {
    out.non_calculable.push('occupation_de_reference_absente')
    return out
  }
  out.occupation_reference = occupationReference
  out.nuitees_de_reference =
    Math.round(capacite.jours_ouverts * occupationReference * 100) / 100
  out.avance_retard =
    Math.round((out.nuitees_finales_extrapolees - out.nuitees_de_reference) * 100) / 100
  if (capacite.estimee) out.capacite_estimee = true
  return out
}

module.exports = {
  SEGMENTS,
  NIVEAUX,
  SEUIL_DEFAUT,
  SEUIL_RESERVATIONS,
  construireContexte,
  JOURS_SEMAINE,
  jourDeSemaine,
  pontsEntre,
  segmenterJour,
  construireReference,
  referencePour,
  courbeDeDelai,
  projeter,
  nomCourt
}
