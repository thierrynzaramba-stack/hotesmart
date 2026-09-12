// lib/yield/capacite.js
// DOC : docs/kb/capacite-yield.md (modif = MEME COMMIT)
// Spec : docs/specs/spec-yieldflow-v1.md §5 (etape 2, lot 2.1)
//
// LECTURE SEULE. Aucune ecriture, aucun appel provider.
//
// LE DENOMINATEUR DU TAUX D'OCCUPATION ET DU RevPAR.
// Un taux d'occupation n'a de sens que rapporte aux jours ou l'hote ACCEPTAIT
// de vendre. Rapporter les nuitees a tous les jours du calendrier ferait
// plonger le TO d'un hote qui ferme son logement deux mois pour travaux, et
// YieldFlow lui suggererait de baisser ses prix pour « remplir » des nuits
// qu'il ne veut pas vendre.
//
// ⚠ AUCUNE TABLE NOUVELLE — decision de la spec §5.
// La memoire d'intention existe deja : `calendar_inventory.stop_sell`, ecrite
// par le seul `api/calendar.js` (chantier audit stop_sell). En creer une
// seconde ferait deux verites divergentes, exactement le defaut que le
// chantier « un writer unique » a ferme.
//
// ⚠ LA CONVENTION EST CELLE DE runFullSync, MOT POUR MOT :
//   - `stop_sell = true`  -> ferme (intention explicite de l'hote) ;
//   - `avail = 0`         -> ferme (api/calendar.js pose stop_sell avec) ;
//   - AUCUNE LIGNE        -> ferme. `runFullSync` calcule
//     `availability = r ? Math.min(annonce, stock) : 0` : l'absence de ligne
//     vaut zero. Une nuit sans ligne n'est vendable nulle part.
//   - AUCUN PRIX          -> ferme. C'est la « fermeture calculee » : quand
//     `rate` est nul ou <= 0 ET que `base_price` ne prend pas le relais,
//     `runFullSync` force `obj.stop_sell = true` et empile la date dans
//     `fermeesSansPrix`. Le moteur direct fait de meme
//     (`lib/moteur-reservation.js`, raison `sans_prix`). Une nuit sans prix
//     n'est proposee nulle part.
//   - tout le reste       -> ouvert.
//
// ⚠ LA REGLE « SANS PRIX » A ETE OUBLIEE DANS LA PREMIERE VERSION, ET LE
// COMMENTAIRE DISAIT POURTANT « MOT POUR MOT ». Sur un bien dont l'amorcage
// des prix a rate — le cas exact que l'alerte `fermeesSansPrix` existe pour
// signaler — le denominateur se serait gonfle de centaines de nuits jamais
// mises en vente. TO effondre, et YieldFlow recommandant de baisser les prix
// sur des nuits qu'aucun voyageur n'a jamais pu voir.
//
// ⚠ UNE NUIT VENDUE RESTE UNE NUIT OUVERTE.
// Elle etait a la vente, et elle s'est vendue : c'est le numerateur du TO, pas
// une soustraction du denominateur. La vente reduit le STOCK (calcule au moment
// de pousser), jamais l'INTENTION (memorisee). Les exclure ferait un TO de
// 100 % sur tout bien qui vend, indefiniment.

const { estRelieAuCanal } = require('../rate-sync')

// ⚠ CECI EST UN CONTRAT D'APPEL, PAS UNE GARDE INTERNE — precise en review.
// `joursOuverts` recoit des chaines 'YYYY-MM-DD' deja construites : il ne peut
// pas savoir comment l'appelant les a fabriquees. Or la fenetre de
// `runFullSync` est calculee a MINUIT LOCAL, et en Europe/Paris entre 00 h et
// 02 h une fenetre batie avec `toISOString()` est decalee d'un jour — le
// dernier jour n'est ni lu ni compte, un faux vert a une heure ou personne ne
// regarde. Cet helper est exporte pour que les appelants construisent leurs
// bornes de la meme facon que le writer. L'utiliser reste a leur charge.
function jourLocal (d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ⚠ LE FORMAT NE SUFFIT PAS, LES BORNES COMPTENT — releve en review.
// `/^\d{4}-\d{2}-\d{2}$/` accepte `2026-13-45`. La consequence etait
// rattrapee plus loin (`new Date` rend Invalid Date, la periode sort vide),
// mais par accident : une date impossible doit etre refusee ICI, la ou on
// pretend la valider.
function estJourISO (v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [a, m, j] = v.split('-').map(Number)
  if (m < 1 || m > 12 || j < 1 || j > 31) return false
  const d = new Date(Date.UTC(a, m - 1, j))
  // Rejette le 31 d'un mois a 30 jours, et le 29 fevrier hors annee bissextile.
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j
}

// Enumere les jours d'une periode, bornes incluses.
function joursDeLaPeriode (debut, fin) {
  if (!estJourISO(debut) || !estJourISO(fin) || fin < debut) return []
  const out = []
  const d = new Date(`${debut}T00:00:00Z`)
  const stop = new Date(`${fin}T00:00:00Z`)
  while (d <= stop) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
    // ⚠ ON NE TRONQUE PAS EN SILENCE — releve en review.
    // La premiere version rendait 2001 jours pour une periode de 5 ans, tandis
    // que la requete couvrait la periode ENTIERE : l'appelant recevait
    // `calculable: true` sur une fenetre amputee. Un denominateur invente est
    // pire qu'un trou declare — la regle du fichier s'applique a lui-meme.
    if (out.length > JOURS_MAX) return null
  }
  return out
}

// Raisons pour lesquelles la capacite n'est PAS calculable.
const NON_CALCULABLE = {
  PROVIDER: 'provider_sans_memoire_intention',
  VIDE: 'memoire_non_amorcee',
  // ⚠ TOUTES les sorties non calculables passent par cette constante.
  // Trois y etaient, la quatrieme etait une chaine libre : un appelant qui
  // fait `switch (r.raison)` sur les membres exportes tombait en `default`
  // sur une periode inversee — cas que les tests produisent pourtant.
  PARAMETRES: 'parametres_invalides',
  // Le futur sans memoire reste non calculable : on n'estime JAMAIS l'avenir.
  FUTUR_NON_AMORCE: 'futur_sans_memoire_intention',
  PERIODE_TROP_LONGUE: 'periode_trop_longue',
  // La colonne `base_price` n'a pas ete selectionnee par l'appelant : sans
  // elle, impossible de savoir si une nuit sans `rate` retombe sur un prix.
  COLONNE_MANQUANTE: 'base_price_non_selectionne'
}

// Plus longue fenetre acceptee. Au-dela, on REFUSE plutot que de tronquer.
const JOURS_MAX = 2000

/**
 * Jours OUVERTS A LA VENTE d'un bien sur une periode.
 *
 * ⚠ REND `calculable: false` PLUTOT QUE ZERO.
 * C'est la demande explicite de Thierry, et elle porte tout le sens de cette
 * fonction : « zero jour ouvert » et « je ne sais pas » sont deux reponses
 * opposees pour le moteur. La premiere donne un TO de 0/0 qu'une division
 * rendra `NaN` ou `Infinity` ; la seconde dit a l'etape 3 d'ecarter le bien du
 * calcul et de le SIGNALER. Un moteur de yield qui invente un denominateur
 * suggere des prix sur du vide.
 *
 * Deux cas de non-calculabilite :
 *  1. le bien n'est pas pilote par nous (Beds24) : sa memoire d'intention
 *     n'est amorcee qu'a la migration vers Channex. Lire `calendar_inventory`
 *     y rendrait quelques lignes eparses — celles que l'hote a touchees depuis
 *     HoteSmart — et ferait passer 360 jours pour fermes ;
 *  2. aucune ligne du tout sur la periode : indiscernable de « tout ferme »,
 *     mais bien plus probablement « jamais configure ». Le bien de test
 *     `colomier` est exactement dans ce cas.
 */
async function joursOuverts (supabase, bien, debut, fin, options = {}) {
  // ⚠ CONVENTION ESTIMEE POUR LE PASSE — decision de Thierry, 12 sept. 2026.
  //
  // La memoire d'intention (`calendar_inventory`) ne remonte pas dans le
  // passe : elle a ete amorcee a la migration. Mesure du jour : 4 ans
  // d'historique de VENTES (2022-09-08 → 2026-10-28), trois jours d'historique
  // d'INTENTION sur La bulle. Sans convention, le taux d'occupation et le
  // RevPAR — les deux indicateurs centraux d'un moteur de yield — n'existent
  // sur AUCUN mois passe.
  //
  // La convention, en une phrase : UN JOUR PASSE SANS MEMOIRE EST REPUTE
  // OUVERT, SAUF s'il est couvert par une exception declaree.
  //
  // Elle se complete donc avec `yield_exceptions` : plus l'hote declare ses
  // fermetures passees, plus l'estime est juste. C'est le seul levier, et il
  // est entre ses mains.
  //
  // ⚠ ET LE DRAPEAU VIT DANS LA DONNEE, pas seulement dans l'interface :
  // chaque resultat calcule sur estimation porte `estimee: true` et le compte
  // des jours concernes. L'etape 4 ne DOIT PAS pouvoir l'afficher comme mesure.
  //
  // ⚠ BASCULE AUTOMATIQUE : des qu'un jour porte une ligne reelle, c'est elle
  // qui fait foi. L'estimation ne comble que les trous du passe.
  const { joursExclus = null, aujourdHui = null, estimerLePasse = true } = options
  const jours = joursDeLaPeriode(debut, fin)
  const base = {
    calculable: false,
    raison: null,
    jours_total: jours ? jours.length : 0,
    jours_ouverts: 0,
    jours_fermes: 0,
    jours_sans_ligne: 0,
    jours_sans_prix: 0,
    detail: null
  }
  if (jours === null) {
    return { ...base, raison: NON_CALCULABLE.PERIODE_TROP_LONGUE }
  }
  if (!supabase || !bien?.id || !jours.length) {
    return { ...base, raison: NON_CALCULABLE.PARAMETRES }
  }

  // Borne « passe » : tout ce qui precede aujourd'hui est estimable.
  const auj = estJourISO(aujourdHui) ? aujourdHui : jourLocal(new Date())

  // Cas 1 : provider dont la memoire d'intention n'existe pas encore.
  // ⚠ NE VAUT QUE POUR LE FUTUR. Le passe d'un bien Beds24 est estimable comme
  // celui de n'importe quel autre : c'est justement parce que sa memoire
  // n'existe pas qu'on estime. Refuser ici priverait d'historique tous les
  // biens migres — dont La bulle, dont les quatre ans de ventes sont Beds24.
  if (!estRelieAuCanal(bien) && !(estimerLePasse && debut < auj)) {
    return { ...base, raison: NON_CALCULABLE.PROVIDER }
  }

  // ⚠ LA COLONNE NON SELECTIONNEE, DITE PLUTOT QUE SUBIE.
  // Meme garde que `runFullSync` : sans `base_price`, on ne sait pas si une
  // nuit sans `rate` retombe sur un prix ou part fermee. `undefined` serait lu
  // comme « pas de prix » et fermerait tout le calendrier d'un bien qui vend,
  // sans la moindre erreur. Ce depot a paye quatre fois ce piege.
  if (!Object.prototype.hasOwnProperty.call(bien, 'base_price')) {
    return { ...base, raison: NON_CALCULABLE.COLONNE_MANQUANTE }
  }
  const basePrixPositif = Number(bien.base_price) > 0

  // ⚠ PAGINATION OBLIGATOIRE — releve en review.
  // PostgREST plafonne a 1000 lignes. Une fenetre de 3 ans ramenait 1000 lignes
  // sur 1096, les 96 manquantes tombaient en « sans ligne » donc « fermees »,
  // et la fonction rendait `calculable: true`. Denominateur faux, silencieux —
  // et non reproductible faute d'`order`.
  const lignes = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('calendar_inventory')
      .select('date, stop_sell, avail, rate')
      .eq('property_id', bien.id)        // UUID : calendar_inventory est clee dessus
      .gte('date', debut).lte('date', fin)
      .order('date')
      .range(from, from + 999)
    if (error) {
      // On ne devine pas : un denominateur invente est pire qu'un trou declare.
      throw new Error(`[capacite] lecture du calendrier : ${error.message}`)
    }
    lignes.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  // Cas 2 : memoire jamais amorcee sur cette periode.
  // ⚠ N'EST PLUS BLOQUANT POUR LE PASSE : c'est exactement le cas que la
  // convention estimee existe pour traiter. Le futur, lui, reste non
  // calculable — on n'estime jamais l'avenir.
  if (!lignes.length && !(estimerLePasse && debut < auj)) {
    return { ...base, raison: NON_CALCULABLE.VIDE }
  }

  const parJour = new Map(lignes.map(l => [l.date, l]))
  const ouverts = []
  let fermes = 0
  let sansLigne = 0
  let sansPrix = 0
  let estimes = 0            // jours passes ouverts PAR CONVENTION
  let estimesFermes = 0      // jours passes fermes par une exception declaree
  for (const j of jours) {
    const l = parJour.get(j)
    if (!l) {
      // ⚠ BASCULE : une ligne reelle fait toujours foi. On n'arrive ici que
      // s'il n'y en a AUCUNE pour ce jour.
      if (estimerLePasse && j < auj) {
        // Une fermeture DECLAREE prime sur la convention : l'hote sait mieux.
        if (joursExclus && (joursExclus.has ? joursExclus.has(j) : joursExclus[j])) {
          estimesFermes++; fermes++; continue
        }
        estimes++; ouverts.push(j); continue
      }
      sansLigne++; fermes++; continue
    }
    if (l.stop_sell === true || l.avail === 0) { fermes++; continue }
    // Fermeture CALCULEE : pas de tarif du jour, et pas de prix de base pour
    // prendre le relais. `runFullSync` pousse `stop_sell: true` sur ces dates.
    const aUnPrix = (l.rate != null && Number(l.rate) > 0) || basePrixPositif
    if (!aUnPrix) { sansPrix++; fermes++; continue }
    ouverts.push(j)
  }

  return {
    calculable: true,
    raison: null,
    jours_total: jours.length,
    jours_ouverts: ouverts.length,
    jours_fermes: fermes,
    // Compte a part, sans changer le verdict : une nuit sans ligne EST fermee
    // (convention runFullSync), mais une proportion elevee signale un bien dont
    // la memoire d'intention n'a jamais ete completee. L'etape 3 doit pouvoir
    // le dire a l'hote plutot que de lui montrer un TO flatteur.
    jours_sans_ligne: sansLigne,
    // Meme role que `jours_sans_ligne` : compte a part, ne change pas le
    // verdict. Une valeur elevee est le signe d'un amorcage de prix rate —
    // c'est ce que l'alerte `poussee_dates_sans_prix` du full sync signale.
    jours_sans_prix: sansPrix,
    // ⚠ LE DRAPEAU VIT DANS LA DONNEE. Tout indicateur calcule a partir d'un
    // resultat `estimee: true` est un ESTIME, et doit se presenter comme tel.
    estimee: estimes > 0,
    jours_estimes_ouverts: estimes,
    jours_estimes_fermes_par_exception: estimesFermes,
    detail: ouverts
  }
}

module.exports = {
  joursOuverts,
  joursDeLaPeriode,
  jourLocal,
  estJourISO,
  NON_CALCULABLE,
  JOURS_MAX
}
