// lib/yield/pickup.js — le « A DATE » : le portefeuille deja vendu, compare au
// meme delai l'an dernier. Lot 3.3 de l'etape 3 (spec §6).
//
// CE QU'IL REPOND, ET QUE LE REALISE NE DIT PAS. Le realise d'octobre ne se
// connait qu'en novembre : trop tard pour agir sur le prix. Le « a date » dit
// AUJOURD'HUI ou en est octobre par rapport a l'an dernier au meme moment —
// c'est le seul indicateur qui laisse encore le temps de corriger.
//
// ⚠ FONCTIONS PURES. Ni base, ni reseau, ni horloge : le pivot est TOUJOURS
// fourni par l'appelant. Un module de pickup qui lirait l'horloge systeme
// serait intestable — et ses tests deviendraient faux le jour ou ils passent.
//
// ⚠ LE BIAIS QUI FAIT TOUT LE SEL DE CE LOT — lire `aveuglement` plus bas.
// Le portefeuille N-1 n'est pas OBSERVE au 12/09/2025 : il est RECONSTRUIT
// depuis l'etat d'aujourd'hui. Les reservations qui existaient ce jour-la puis
// ont ete annulees ont disparu. Le module ne peut pas les retrouver — il le
// DIT, chiffres a l'appui, plutot que de servir un ecart muet.

const {
  calculerIndicateurs, comparerAN1, periodePrecedente, clePeriode
} = require('./indicateurs')
// ⚠ ON REUTILISE LA VALIDATION DE `capacite.js`, ON NE LA REECRIT PAS.
// Releve en review : une version locale ne verifiait que le FORMAT, et
// `'2026-13-45'` passait — `new Date` levait alors un RangeError qui casse la
// page, et `'2026-02-30'` devenait silencieusement le 2 mars. La leçon avait
// deja ete payee dans `capacite.js` ; la recopier en plus faible l'annulait.
const { estJourISO } = require('./capacite')

// Raisons pour lesquelles une reservation ne peut pas entrer dans un « a date ».
const MOTIFS_ECART = {
  // Vendue apres le pivot : elle existe, mais pas encore a la date observee.
  // ⚠ C'EST LE CAS NORMAL ET SAIN, jamais un signe d'aveuglement.
  POSTERIEURE: 'vendue_apres_le_pivot',
  // Date de vente absente du payload provider.
  SANS_DATE: 'sans_date_de_vente',
  // Date presente mais non fiable (reconstruite, ou date de migration).
  NON_FIABLE: 'date_de_vente_non_fiable'
}

// Drapeaux portes PAR LA DONNEE, pas par l'interface (exigence de Thierry au
// lot 3.2, reconduite ici) : l'etape 4 ne doit pas POUVOIR afficher un
// portefeuille reconstruit comme un portefeuille observe.
const DRAPEAUX = {
  // Le N-1 est reconstruit depuis l'etat final : annulations invisibles.
  PORTEFEUILLE_RECONSTRUIT: 'portefeuille_n1_reconstruit',
  // On ne VOIT pas le portefeuille N-1 : son zero ne veut pas dire « rien
  // vendu », il veut dire « rien de visible ».
  AVEUGLE_AVANT_BASCULE: 'aveugle_avant_bascule',
  // ⚠ LE DRAPEAU QUI EVITE LE CONTRESENS LE PLUS COUTEUX DE CE LOT.
  // La periode visee est FERMEE a la vente : zero vendu n'est pas un echec
  // commercial, c'est une decision de l'hote. Constate le 12/09/2026 sur
  // Coeur de vie 23 — octobre 2026 a ZERO jour ouvert (bascule inachevee) et
  // affichait le meme « -100 % » que La bulle, ouverte et reellement sans
  // vente. Deux situations opposees, un seul chiffre : sans ce drapeau, le
  // moteur suggererait de brader un logement qu'on ne peut pas vendre.
  PERIODE_FERMEE: 'periode_fermee_a_la_vente',
  // ⚠ LE MEME RAISONNEMENT, COTE N-1 — releve en review. Un bien ferme pour
  // travaux l'an dernier n'a pas « fait zero » : il ne POUVAIT pas vendre.
  // Sans ce miroir, le moteur lit « +360 € contre l'an dernier » et felicite
  // au lieu d'alerter. La regle « la fermeture se lit dans la capacite,
  // jamais dans l'absence de vente » vaut des DEUX cotes.
  PERIODE_N1_FERMEE: 'periode_n1_fermee_a_la_vente',
  // La capacite de la periode visee n'est pas calculable, ou pas fournie :
  // ni taux d'occupation ni RevPAR, et le zero du CA ne se compare a rien.
  CAPACITE_NON_AMORCEE: 'capacite_de_la_periode_non_amorcee',
  CAPACITE_N1_NON_AMORCEE: 'capacite_n1_non_amorcee',
  // Des dates de vente sont inexploitables. ⚠ DEUX DRAPEAUX, PAS UN :
  // l'interface doit savoir LEQUEL des deux chiffres est degrade pour decider
  // lequel taire.
  DATES_INCOMPLETES: 'dates_de_vente_incompletes',
  DATES_INCOMPLETES_N1: 'dates_de_vente_incompletes_n1'
}

// Les drapeaux qui DISQUALIFIENT le N-1 comme terme de comparaison. Tant que
// l'un d'eux est leve, un ecart chiffre serait une invention.
const DISQUALIFIENT_LE_N1 = [
  DRAPEAUX.AVEUGLE_AVANT_BASCULE,
  DRAPEAUX.PERIODE_N1_FERMEE,
  DRAPEAUX.CAPACITE_N1_NON_AMORCEE
]

// Le JOUR, jamais l'instant. `bookingTime` de Beds24 porte l'heure, `arrival`
// non : comparer les deux en brut a deja produit « 164 dates corrompues » qui
// n'etaient que 162 ventes le jour meme (regle 13 de REVIEW.md).
function jour (v) {
  if (typeof v !== 'string') return null
  const j = v.slice(0, 10)
  return estJourISO(j) ? j : null
}

function decalerJours (iso, n) {
  const j = jour(iso)
  if (j == null || !Number.isFinite(n)) return null
  const d = new Date(`${j}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function joursEntre (a, b) {
  const ja = jour(a); const jb = jour(b)
  if (!ja || !jb) return null
  return Math.round((Date.parse(`${jb}T00:00:00Z`) - Date.parse(`${ja}T00:00:00Z`)) / 86400000)
}

// Premier jour d'une cle de periode ('2026-10' -> '2026-10-01').
function debutDePeriode (cle) {
  if (/^\d{4}$/.test(cle)) return estJourISO(`${cle}-01-01`) ? `${cle}-01-01` : null
  if (/^\d{4}-\d{2}$/.test(cle)) return estJourISO(`${cle}-01`) ? `${cle}-01` : null
  if (/^\d{4}-\d{2}-\d{2}$/.test(cle)) return estJourISO(cle) ? cle : null
  return null
}

/**
 * LE PIVOT N-1 : DEUX ALIGNEMENTS, PARCE QU'IL Y A DEUX QUESTIONS.
 *
 * 1. PERIODE A VENIR (pivot avant le debut) — « a combien de jours de
 *    l'ouverture en suis-je ? ». Le sujet EST le delai : octobre 2026 vu a
 *    19 jours de son premier jour se compare a octobre 2025 vu a 19 jours du
 *    sien. On recule donc en JOURS. Reculer date a date donnerait le meme
 *    resultat neuf fois sur dix, mais pas quand un 29 fevrier s'intercale : le
 *    delai glisserait d'un jour, sans que rien ne le signale, precisement sur
 *    les periodes vues le plus longtemps a l'avance.
 *
 * 2. PERIODE DEJA COMMENCEE (pivot dans ou apres la periode) — « ou en est mon
 *    cumul ? ». Le sujet n'est plus un delai mais un POINT D'AVANCEMENT, et
 *    c'est le calendrier qui fait foi. ⚠ RELEVE EN REVIEW : appliquer le
 *    decalage en jours ici amputait le N-1 d'une journee des qu'une annee
 *    bissextile s'intercalait — `pivotN1('2025-09-12', '2025')` rendait
 *    `2024-09-11`, donc un cumul annuel compare a un cumul arrete la veille.
 *    Le biais allait TOUJOURS dans le meme sens : progression flattee.
 *
 * Le mode retenu est porte DANS la donnee (`alignement`), jamais devine.
 */
function pivotN1 (pivot, cle) {
  const debut = debutDePeriode(cle)
  const clePrec = periodePrecedente(cle)
  const debutN1 = clePrec ? debutDePeriode(clePrec) : null
  const p = jour(pivot)
  if (!debut || !debutN1 || !p) return null
  const delai = joursEntre(p, debut)
  if (delai == null) return null
  if (delai > 0) {
    return { pivot_n1: decalerJours(debutN1, -delai), delai_jours: delai,
      alignement: 'delai_avant_le_debut' }
  }
  // Periode commencee : meme jour calendaire, un an plus tot. Le 29 fevrier
  // n'existant pas toutes les annees, `estJourISO` le refuse et on retombe
  // sur le 28 — la veille, jamais le 1er mars.
  const candidat = `${Number(p.slice(0, 4)) - 1}${p.slice(4)}`
  const pn1 = estJourISO(candidat) ? candidat : decalerJours(candidat.slice(0, 8) + '28', 0)
  return { pivot_n1: pn1, delai_jours: delai, alignement: 'meme_jour_calendaire' }
}

/**
 * Retient les eclatements VENDUS au plus tard au pivot, et compte les autres.
 *
 * ⚠ UNE DATE NON FIABLE EST ECARTEE, PAS SUPPOSEE. Sur un bien migre, la date
 * de vente d'une ligne recreee cote Channex vaut la date de la MIGRATION : la
 * garder ferait apparaitre tout le portefeuille au meme jour, et le pickup
 * bondirait de zero a tout. Le pont demapped en recupere ce qu'il peut ; le
 * reste est ecarte et COMPTE.
 */
function filtrerADate (eclatements, pivot) {
  const p = jour(pivot)
  const retenus = []
  const ecartes = { [MOTIFS_ECART.POSTERIEURE]: 0, [MOTIFS_ECART.SANS_DATE]: 0,
    [MOTIFS_ECART.NON_FIABLE]: 0 }
  let candidats = 0
  for (const e of eclatements || []) {
    if (!e || !e.compte) continue
    candidats++
    if (!e.date_vente) { ecartes[MOTIFS_ECART.SANS_DATE]++; continue }
    if (!e.date_vente_fiable) { ecartes[MOTIFS_ECART.NON_FIABLE]++; continue }
    const dv = jour(e.date_vente)
    // ⚠ LA BRANCHE PAR DEFAUT EST « J'ECARTE », JAMAIS « JE GARDE ».
    // Une date illisible retenue entrerait au portefeuille comme si elle etait
    // anterieure au pivot : le module est construit sur « je ne suppose pas ».
    if (dv == null || p == null) { ecartes[MOTIFS_ECART.NON_FIABLE]++; continue }
    if (dv > p) { ecartes[MOTIFS_ECART.POSTERIEURE]++; continue }
    retenus.push(e)
  }
  return { retenus, ecartes, candidats }
}

function perdues (ecartes) {
  return ecartes[MOTIFS_ECART.SANS_DATE] + ecartes[MOTIFS_ECART.NON_FIABLE]
}

/**
 * Le « a date » d'UNE periode, et son N-1 au meme delai.
 *
 * @param {Array} eclatements  sortie d'`eclater()`, N ET N-1 melanges
 * @param {Object} options
 *   - periode        cle de periode visee ('2026-10')
 *   - pivot          date d'observation ('2026-09-12') — jamais l'horloge
 *   - granularite    'jour' | 'mois' | 'annee' (defaut 'mois')
 *   - capacites      Map cle -> sortie de `joursOuverts`
 *   - capacitePersonnes
 */
function pickup (eclatements, options = {}) {
  const { periode, pivot, granularite = 'mois', capacites = null,
    capacitePersonnes = null } = options
  const cleN1 = periodePrecedente(periode)
  const decalage = pivotN1(pivot, periode)

  const vue = (cle, pivotVue) => {
    if (!cle || !pivotVue) return null
    // ⚠ LES COMPTEURS D'ECART SE RESTREIGNENT A LA PERIODE OBSERVEE.
    // Filtrer sur tout le portefeuille du bien faisait compter « vendue apres
    // le pivot » chaque reservation de chaque autre mois : 215 ecartees sur
    // La bulle / octobre 2025, c'est-a-dire quatre ans de reservations.
    // Un chiffre de ce genre ne se lit pas, il s'ignore.
    const duMois = (eclatements || []).filter(e =>
      e && e.nuits && e.nuits.some(n => clePeriode(n.date, granularite) === cle))
    const f = filtrerADate(duMois, pivotVue)
    // On passe `capacites` ENTIER : c'est lui qui amorce les periodes ouvertes
    // sans vente (lot 3.2), sans quoi une periode invendue n'existerait pas.
    const ind = calculerIndicateurs(f.retenus, { granularite, capacites, capacitePersonnes })
    const ligne = ind.find(x => x.periode === cle) || null
    return { cle, pivot: pivotVue, ligne, ...f }
  }

  const n = vue(periode, jour(pivot))
  const n1 = vue(cleN1, decalage ? decalage.pivot_n1 : null)

  const out = {
    periode,
    pivot: jour(pivot),
    periode_n1: cleN1,
    pivot_n1: decalage ? decalage.pivot_n1 : null,
    delai_jours: decalage ? decalage.delai_jours : null,
    alignement: decalage ? decalage.alignement : null,
    a_date: n ? n.ligne : null,
    a_date_n1: n1 ? n1.ligne : null,
    ecartes: n ? n.ecartes : null,
    ecartes_n1: n1 ? n1.ecartes : null,
    // ⚠ UN COMPTEUR SANS SON DENOMINATEUR NE SE LIT PAS — releve en review.
    // « 6 vendues apres le pivot » ne dit rien tant qu'on ignore si c'est 6
    // sur 9 ou 6 sur 200.
    candidats: n ? n.candidats : null,
    candidats_n1: n1 ? n1.candidats : null,
    drapeaux: [],
    vs_n1: {}
  }

  // ─── LES DRAPEAUX, DANS LA DONNEE ─────────────────────────────────────────
  // ⚠ EXIGENCE DE THIERRY : « l'aveuglement pre-bascule dit explicitement
  // plutot que masque ». Un zero au pickup N-1 peut vouloir dire deux choses
  // opposees — « le bien ne vendait rien » ou « nous ne voyons rien » — et
  // seule la seconde interdit de conclure.
  if (n1 && n1.ligne) out.drapeaux.push(DRAPEAUX.PORTEFEUILLE_RECONSTRUIT)

  // ⚠ FERME N'EST PAS « N'A RIEN VENDU ». On le lit dans la CAPACITE, jamais
  // dans le chiffre de vente : c'est la memoire d'intention de l'hote qui
  // tranche, pas l'absence de resultat. Les deux cotes, pas seulement N.
  const capa = (v, ferme, absente) => {
    if (!v || !v.ligne) { out.drapeaux.push(absente); return }
    if (v.ligne.jours_ouverts === 0) out.drapeaux.push(ferme)
    else if (v.ligne.jours_ouverts == null) out.drapeaux.push(absente)
  }
  capa(n, DRAPEAUX.PERIODE_FERMEE, DRAPEAUX.CAPACITE_NON_AMORCEE)
  if (cleN1) capa(n1, DRAPEAUX.PERIODE_N1_FERMEE, DRAPEAUX.CAPACITE_N1_NON_AMORCEE)

  // ⚠ L'AVEUGLEMENT SE MESURE SUR CE QU'ON N'A PAS PU LIRE, JAMAIS SUR CE
  // QU'ON A ECARTE A BON DROIT — les deux erreurs inverses relevees en review.
  // Premiere version : la condition portait sur le nombre de CANDIDATS, donc
  // (a) elle criait « aveugle » sur le cas le plus sain — un N-1 dont les
  // ventes sont simplement posterieures au pivot, ce qui est l'information la
  // plus actionnable du pickup — et (b) elle se taisait sur le cas qu'elle
  // nomme, un bien migre sans historique repris, ou il n'y a AUCUN candidat.
  // Un drapeau qui crie tout le temps ne dit plus rien.
  if (n1) {
    const illisibles = perdues(n1.ecartes) > 0 && !(n1.ligne && n1.ligne.nuitees > 0)
    // Aucune trace du bien avant la fin de la periode N-1 : son zero n'est pas
    // un resultat, c'est une absence de memoire. S'il a de l'historique
    // anterieur, en revanche, le zero est VRAI et doit rester un signal.
    const debutN1 = debutDePeriode(cleN1)
    const aDeLHistoire = (eclatements || []).some(e =>
      e && e.compte && e.nuits && e.nuits.some(x => debutN1 && x.date < debutN1))
    const muet = n1.candidats === 0 && !aDeLHistoire
    if (illisibles || muet) out.drapeaux.push(DRAPEAUX.AVEUGLE_AVANT_BASCULE)
  }

  if (n && perdues(n.ecartes) > 0) out.drapeaux.push(DRAPEAUX.DATES_INCOMPLETES)
  if (n1 && perdues(n1.ecartes) > 0) out.drapeaux.push(DRAPEAUX.DATES_INCOMPLETES_N1)

  // ─── La comparaison ───────────────────────────────────────────────────────
  // ⚠ ON REUTILISE `comparerAN1`, ON NE LE REECRIT PAS — releve en review.
  // La version locale avait perdu en route la distinction `n1_hors_perimetre`
  // (« l'appelant n'a pas fourni la periode ») / `periode_n1_absente` (« elle
  // n'existe pas »), que `indicateurs.js` declare essentielle. Deux causes
  // opposees rendaient la meme chaine.
  const lignes = [out.a_date_n1, out.a_date].filter(Boolean)
  const compare = comparerAN1(lignes).find(x => x.periode === periode)
  out.vs_n1 = compare ? compare.vs_n1 : { periode_n1: cleN1, disponible: false }

  // ⚠ UN ECART EST UN CHIFFRE, DONC IL SE TAIT AUSSI — releve en review.
  // `variation` etait protege du N-1 a zero, pas `ecart` : l'interface recevait
  // « +500 € » et « +6,45 points de TO » contre un N-1 nul PAR IGNORANCE.
  // C'est exactement le chiffre reconstruit presente comme observe que
  // l'en-tete de ce fichier promet d'empecher.
  const disqualifie = out.drapeaux.find(d => DISQUALIFIENT_LE_N1.includes(d))
  if (disqualifie) {
    for (const champ of Object.keys(out.vs_n1)) {
      const c = out.vs_n1[champ]
      if (!c || typeof c !== 'object' || !('ecart' in c)) continue
      c.ecart = null
      c.variation = null
      c.non_calculable = disqualifie
    }
  }
  return out
}

module.exports = {
  MOTIFS_ECART,
  DRAPEAUX,
  DISQUALIFIENT_LE_N1,
  pivotN1,
  filtrerADate,
  pickup,
  decalerJours,
  joursEntre,
  debutDePeriode
}
