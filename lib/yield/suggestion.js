// lib/yield/suggestion.js — LA GRILLE ET LE PIPELINE DE SUGGESTION.
// Lot 4.4 de l'etape 4. Spec : docs/specs/spec-yieldflow-v1.md §7.3.
// DOC : docs/kb/suggestion-yield.md (modif = MEME COMMIT)
//
// ⚠ FONCTIONS PURES. Ni base, ni reseau, ni horloge : la date d'observation et
// la capacite arrivent de l'appelant. Un moteur de prix qui lit l'horloge est
// intestable, et ses tests deviennent faux le jour ou ils passent.
//
// ⚠ AUCUNE ECRITURE, JAMAIS. Ce module PROPOSE. L'hote valide, et le prix part
// par le chemin normal du calendrier (lot 4.6) — regle gravee du produit :
// « aucun prix ne part aux OTA sans validation de l'hote ».
//
// ⚠ 100 % DETERMINISTE. Memes entrees, meme sortie, et chaque euro se justifie
// par une couche nommee et chiffree. Un prix qu'on ne sait pas expliquer est un
// prix qu'on ne peut pas defendre devant l'hote — et qu'il n'appliquera pas.

const { estJourISO } = require('./capacite')
const { segmenterJour, SEGMENTS } = require('./reference')
const { tarifAcceptable } = require('./prix-plancher')

// ⚠ LES CINQ NIVEAUX N'INVENTENT AUCUN POURCENTAGE.
// Chaque niveau est un quantile des prix REELLEMENT OBTENUS par ce logement sur
// ce type de nuit. « -10 % / +10 % » aurait ete un chiffre sorti de nulle part ;
// ici, chaque niveau repond a « vous avez deja vendu a ce prix ce type de
// nuit », ce qui se defend devant l'hote et se verifie dans ses donnees.
const NIVEAUX = [
  { nom: 'Prudent', quantile: 0.20 },
  { nom: 'Mesuré', quantile: 0.35 },
  { nom: 'Référence', quantile: 0.50 },
  { nom: 'Ferme', quantile: 0.65 },
  { nom: 'Haut', quantile: 0.80 }
]

// Le socle : la mediane. Arbitrage de Thierry — le moteur part de ce que l'hote
// a obtenu une fois sur deux, puis corrige. Neutre tant qu'aucun signal ne
// justifie de bouger.
const SOCLE = 2

// ⚠ DEUX NIVEAUX D'AMPLITUDE MAXIMUM, arbitrage de Thierry. C'est toute la
// grille : le moteur ne propose jamais un prix hors de ce que l'hote a deja
// pratique sur ce segment.
const AMPLITUDE_MAX = 2

// Seuils : LES MEMES QUE LA REFERENCE. Si la reference se tait, la suggestion
// se tait — une seule regle dans tout le moteur.
const SEUIL_NUITS = 8
const SEUIL_RESERVATIONS = 3

const MOTIFS = {
  FERMEE: 'date_fermee_a_la_vente',
  OUVERTURE_INCONNUE: 'ouverture_de_la_date_inconnue',
  NUIT_PASSEE: 'nuit_deja_passee',
  // ⚠ NOM GENERIQUE, PARCE QUE LA CAUSE EST PLURIELLE. Le deplacement peut ne
  // produire aucun euro parce que l'etendue du jour est etroite, mais AUSSI
  // parce que les niveaux du segment sont eux-memes ecrases (quand un prix
  // domine l'historique, P50 a P80 valent la meme chose). Le motif dit l'effet,
  // le detail dit la cause.
  PIPELINE_NEUTRALISE: 'deplacement_sans_effet_sur_le_prix',
  SEGMENT_MINCE: 'segment_sous_le_seuil',
  SOUS_PLANCHER: 'suggestion_sous_le_plancher',
  DATE_INVALIDE: 'date_invalide',
  HORS_CONTEXTE: 'hors_fenetre_du_contexte',
  PAS_DE_GRILLE: 'aucune_grille'
}

/** Quantile lineaire sur une liste DEJA TRIEE. */
function quantile (tries, p) {
  if (!tries || !tries.length) return null
  const i = (tries.length - 1) * p
  const bas = Math.floor(i)
  const haut = Math.ceil(i)
  if (bas === haut) return tries[bas]
  return tries[bas] + (tries[haut] - tries[bas]) * (i - bas)
}

const arrondi = (v, d = 2) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d

/**
 * LA GRILLE : cinq niveaux par SEGMENT, plus le ratio de chaque jour de semaine.
 *
 * ⚠ LE JOUR DE SEMAINE N'EST PAS UN AXE DE LA GRILLE, C'EST UNE COUCHE FINALE.
 * La spec l'exige (« correction jour-de-semaine en dernier »), et ce n'est pas
 * un detail d'ordre : croiser le segment par le jour des le socle aurait divise
 * chaque echantillon par sept — 30 cases dont la moitie sous le seuil sur
 * La bulle — et surtout aurait fait du jour un critere de CHOIX DU NIVEAU,
 * alors que c'est une correction MULTIPLICATIVE sur le prix. Un samedi ne se
 * vend pas « a un niveau plus haut » : il se vend 24,6 % plus cher que la
 * mediane de son segment, mesure sur 58 nuits.
 */
function construireGrille (eclatements, options = {}) {
  const { contexte = {}, debut = null, fin = null,
    seuil = SEUIL_NUITS, seuilResas = SEUIL_RESERVATIONS } = options
  const parSegment = new Map()
  const parJour = new Map()
  const resasSegment = new Map()
  const resasParJour = new Map()
  let nuitsVues = 0
  let nuitsEcartees = 0
  let idAuto = 0

  for (const e of eclatements || []) {
    if (!e || !e.compte) continue
    const id = e.booking_id != null ? String(e.booking_id) : `anon-${idAuto++}`
    for (const n of e.nuits || []) {
      if (debut && n.date < debut) continue
      if (fin && n.date > fin) continue
      nuitsVues++
      // Memes exclusions que la reference : une fermeture pour travaux et un
      // long sejour degressif ne disent pas ce qu'une nuit vaut.
      if (n.hors_reference || e.long_sejour) { nuitsEcartees++; continue }
      if (n.prix == null || !Number.isFinite(n.prix) || n.prix <= 0) { nuitsEcartees++; continue }
      const s = segmenterJour(n.date, contexte)
      if (!s || !s.segment) { nuitsEcartees++; continue }

      if (!parSegment.has(s.segment)) parSegment.set(s.segment, [])
      parSegment.get(s.segment).push(n.prix)
      if (!resasSegment.has(s.segment)) resasSegment.set(s.segment, new Set())
      resasSegment.get(s.segment).add(id)

      const cle = `${s.segment}|${s.jour_semaine}`
      if (!parJour.has(cle)) parJour.set(cle, [])
      parJour.get(cle).push(n.prix)
      if (!resasParJour.has(cle)) resasParJour.set(cle, new Set())
      resasParJour.get(cle).add(id)
    }
  }

  const segments = new Map()
  for (const [seg, prix] of parSegment) {
    const tries = [...prix].sort((a, b) => a - b)
    const resas = (resasSegment.get(seg) || new Set()).size
    const fiable = tries.length >= seuil && resas >= seuilResas
    segments.set(seg, {
      segment: seg,
      echantillon: tries.length,
      reservations: resas,
      fiable,
      mediane: fiable ? arrondi(quantile(tries, 0.5)) : null,
      // ⚠ LA FOURCHETTE EST MONTREE — arbitrage de Thierry. Elle dit du meme
      // coup si le segment est homogene ou disperse, donc si le chiffre merite
      // confiance. Un segment qui va de 35 a 206 EUR n'a pas la meme autorite
      // qu'un segment resserre.
      min: fiable ? arrondi(tries[0]) : null,
      max: fiable ? arrondi(tries[tries.length - 1]) : null,
      niveaux: fiable
        ? NIVEAUX.map(n => ({ ...n, prix: arrondi(quantile(tries, n.quantile)) }))
        : null,
      non_calculable: fiable ? null : MOTIFS.SEGMENT_MINCE
    })
  }

  // ⚠ LE RATIO DU JOUR EST MESURE, PAS DECRETE. Et il ne s'applique que si le
  // couple (segment, jour) a lui-meme assez de matiere : sinon on corrigerait
  // un prix par un rapport tire de trois nuits.
  const ratios = new Map()
  for (const [cle, prix] of parJour) {
    const seg = cle.split('|')[0]
    const s = segments.get(seg)
    // ⚠ LES DEUX SEUILS, PAS UN — releve en review. L'arbitrage est « 8 nuits
    // ET 3 reservations » et le commentaire l'annonçait, mais seul le compte de
    // nuits etait teste. Deux sejours de 24 nuits a 300 EUR suffisaient a fixer
    // le ratio ET l'etendue de borne : tous les mardis du segment geles a
    // 300 EUR, quel que soit le niveau. C'est la couche qui multiplie
    // directement l'euro.
    const resasJour = (resasParJour.get(cle) || new Set()).size
    if (!s || !s.fiable || prix.length < seuil || resasJour < seuilResas) continue
    const tries = [...prix].sort((a, b) => a - b)
    const med = quantile(tries, 0.5)
    if (!(s.mediane > 0) || !(med > 0)) continue
    // ⚠ L'ETENDUE DU COUPLE, POUR BORNER LE PRIX FINAL. Sans elle, la couche
    // jour peut faire sortir le prix de tout ce que le logement a pratique :
    // niveau Prudent 100 € × ratio mardi 0,8 = 80 €, alors que la nuit la moins
    // chere jamais vendue etait a 100. Trouve par le test d'invariant, pas en
    // relisant le code — c'est tout l'interet d'eprouver une propriete sur
    // toutes les entrees plutot qu'un cas choisi.
    ratios.set(cle, {
      ratio: arrondi(med / s.mediane, 4),
      echantillon: tries.length,
      reservations: resasJour,
      min: arrondi(tries[0]),
      max: arrondi(tries[tries.length - 1])
    })
  }

  return {
    seuil,
    seuil_reservations: seuilResas,
    fenetre: { debut, fin },
    niveaux: NIVEAUX.map(n => n.nom),
    segments,
    ratios_jour: ratios,
    nuits_vues: nuitsVues,
    nuits_ecartees: nuitsEcartees
  }
}

/**
 * LE PIPELINE, EN QUATRE COUCHES NOMMEES ET CHIFFREES.
 *
 *   1. socle            la mediane du segment
 *   2. pression         le portefeuille a date contre le meme delai N-1
 *   3. delai            le temps qui reste avant la nuit
 *   4. jour de semaine  EN DERNIER, ratio mesure
 *   puis le plancher, qui REFUSE et ne rabote jamais.
 *
 * @param {Object} options
 *   - date            la nuit a tarifer
 *   - grille          sortie de `construireGrille`
 *   - contexte        pour segmenter la date
 *   - ouverte         la date est-elle ouverte a la vente ? (memoire d'intention)
 *   - delaiJours      jours entre l'observation et la nuit
 *   - pression        { ecart } — ecart relatif du portefeuille vs N-1, ou null
 *   - bien            pour le plancher (`prix_minimum`)
 */
function suggerer (options = {}) {
  const { date, grille, contexte = {}, ouverte = null, delaiJours = null,
    pression = null, bien = null } = options
  const base = { date, prix: null, niveau: null, couches: [], non_calculable: [] }

  if (!estJourISO(date)) {
    base.non_calculable.push(MOTIFS.DATE_INVALIDE)
    return base
  }
  // ⚠ AUCUNE SUGGESTION SUR UNE DATE FERMEE — arbitrage de Thierry.
  // Le prix n'a aucun effet tant qu'elle l'est, et l'appliquer alimenterait le
  // journal des prix avec un tarif que personne ne verra jamais : c'est le cas
  // que le lot 4.3 vient de corriger a l'autre bout. On le DIT, et on dit quoi
  // faire — huit des douze prochains mois de La bulle sont dans ce cas.
  if (ouverte === false) {
    base.non_calculable.push(MOTIFS.FERMEE)
    return base
  }
  // ⚠ « JE NE SAIS PAS » N'EST PAS « OUI » — trouve en eprouvant le pipeline
  // sur des dates reelles. Le calendrier de La bulle s'arrete au 7 decembre
  // 2026 : au-dela, la memoire d'intention n'existe pas, et `ouverte` vaut
  // `null`. La premiere version suggerait quand meme — un prix pour une nuit
  // dont personne ne sait si elle est vendable. C'est la regle qui traverse
  // tout ce chantier depuis le lot 3.2, appliquee au dernier maillon.
  if (ouverte !== true) {
    base.non_calculable.push(MOTIFS.OUVERTURE_INCONNUE)
    return base
  }

  const s = segmenterJour(date, contexte)
  if (!s) { base.non_calculable.push(MOTIFS.DATE_INVALIDE); return base }
  if (!s.segment) {
    base.non_calculable.push(s.non_calculable || MOTIFS.HORS_CONTEXTE)
    return base
  }
  // ⚠ LE SEGMENT RENDU EST CELUI QUI A FAIT LE PRIX — releve en review.
  // La grille est indexee sur `segment` (« vacances de la zone »), pas sur
  // `detail` (« vacances de la zone : hiver ») : annoncer le detail ferait
  // lire « vacances d'hiver : 144 € » alors que le chiffre est la mediane de
  // TOUTES les vacances de la zone, ete compris. C'est exactement ce que
  // `reference.js` interdit — et elle, au moins, porte un drapeau `replie`.
  base.segment = s.segment
  base.segment_detaille = s.detail
  base.jour_semaine = s.jour_semaine
  base.libelle = s.libelle || null

  // ⚠ UNE GRILLE SERIALISEE N'EST PLUS UNE GRILLE — releve en review.
  // `construireGrille` rend des `Map`. Apres un aller-retour JSON — le chemin
  // naturel des le lot 4.5 — `segments` devient `{}`, qui est TRUTHY : le
  // garde passait et `.get` levait un TypeError, donc un 500 au lieu d'un
  // motif. On verifie la FORME, pas seulement la presence.
  const grilleUtilisable = grille && grille.segments &&
    typeof grille.segments.get === 'function'
  if (!grilleUtilisable) { base.non_calculable.push(MOTIFS.PAS_DE_GRILLE); return base }
  const g = grille.segments.get(s.segment)
  if (!g) { base.non_calculable.push(MOTIFS.PAS_DE_GRILLE); return base }
  if (!g.fiable) {
    base.non_calculable.push(MOTIFS.SEGMENT_MINCE)
    base.echantillon = g.echantillon
    base.reservations = g.reservations
    return base
  }

  // ─── 1. SOCLE ─────────────────────────────────────────────────────────────
  let indice = SOCLE
  base.couches.push({
    nom: 'socle',
    niveau: NIVEAUX[SOCLE].nom,
    prix: g.niveaux[SOCLE].prix,
    detail: `médiane de ${g.echantillon} nuit(s) sur ${g.reservations} réservation(s)`
  })

  // ─── 2. PRESSION : le portefeuille contre le meme delai l'an dernier ──────
  let deplacementPression = 0
  if (pression && pression.ecart != null && Number.isFinite(pression.ecart)) {
    if (pression.ecart <= -0.25) deplacementPression = -1
    else if (pression.ecart >= 0.25) deplacementPression = 1
    base.couches.push({
      nom: 'pression',
      deplacement: deplacementPression,
      detail: `${(pression.ecart * 100).toFixed(0)} % de portefeuille vs N-1 au même délai`
        + (deplacementPression === 0 ? ' — dans la fourchette, inchangé' : '')
    })
  } else {
    base.couches.push({ nom: 'pression', deplacement: 0,
      detail: 'aucun N-1 comparable — inchangé' })
  }

  // ─── 3. DELAI : le temps qui reste ────────────────────────────────────────
  let deplacementDelai = 0
  // ⚠ UN DELAI NEGATIF EST UNE NUIT PASSEE, PAS UNE NUIT PROCHE — releve en
  // review. `-120 <= 14` etait vrai : le moteur suggerait un prix prudent pour
  // une nuit consommee depuis quatre mois, en expliquant « la nuit approche ».
  // `reference.js` a deja tranche l'inverse pour la meme grandeur (« les
  // delais negatifs se comptent, ils ne s'evaporent pas »).
  if (delaiJours != null && Number.isFinite(delaiJours) && delaiJours < 0) {
    base.non_calculable.push(MOTIFS.NUIT_PASSEE)
    return base
  }
  if (delaiJours != null && Number.isFinite(delaiJours)) {
    if (delaiJours <= 14) deplacementDelai = -1
    else if (delaiJours >= 60) deplacementDelai = 1
    base.couches.push({
      nom: 'delai',
      deplacement: deplacementDelai,
      detail: `${delaiJours} jour(s) avant la nuit`
        + (deplacementDelai === -1 ? ' — la nuit approche'
          : deplacementDelai === 1 ? ' — le temps joue pour vous' : ' — inchangé')
    })
  } else {
    base.couches.push({ nom: 'delai', deplacement: 0, detail: 'délai inconnu — inchangé' })
  }

  // ⚠ DEUX NIVEAUX MAXIMUM, ET LE CUMUL SE DIT — arbitrage de Thierry.
  // Quand pression et delai poussent du meme cote, la suggestion s'eloigne le
  // plus du prix actuel : c'est precisement le cas ou l'hote veut regarder
  // avant d'appliquer.
  const brut = deplacementPression + deplacementDelai
  const borne = Math.max(-AMPLITUDE_MAX, Math.min(AMPLITUDE_MAX, brut))
  if (deplacementPression !== 0 && deplacementPression === deplacementDelai) {
    base.cumul = true
    base.couches.push({ nom: 'cumul', deplacement: 0,
      detail: `deux signaux dans le même sens (${borne > 0 ? 'hausse' : 'baisse'})` })
  }
  indice = Math.max(0, Math.min(NIVEAUX.length - 1, SOCLE + borne))
  const niveau = g.niveaux[indice]
  base.niveau = niveau.nom
  base.deplacement = indice - SOCLE

  // ─── 4. JOUR DE SEMAINE, EN DERNIER ───────────────────────────────────────
  const r = grille.ratios_jour ? grille.ratios_jour.get(`${s.segment}|${s.jour_semaine}`) : null
  // ⚠ CE QU'AURAIT DONNE LE SOCLE, pour savoir si le pipeline a produit un
  // euro. Voir le bloc « le niveau annonce ne doit pas mentir » plus bas.
  const prixSocle = g.niveaux[SOCLE].prix
  let prix = niveau.prix
  if (r) {
    const avant = arrondi(prix * r.ratio)
    // ⚠ LE PRIX RESTE DANS CE QUI A DEJA ETE PRATIQUE CE JOUR-LA.
    // Toute la conception repose sur « chaque niveau est un prix reellement
    // obtenu » : un produit niveau × ratio peut sortir de l'etendue observee,
    // et le moteur proposerait alors un tarif que ce logement n'a jamais
    // vendu — exactement ce que la grille par quantiles existe pour eviter.
    prix = Math.min(r.max, Math.max(r.min, avant))
    base.couches.push({
      nom: 'jour_de_semaine',
      ratio: r.ratio,
      prix,
      detail: `${s.jour_semaine} : ×${r.ratio} mesuré sur ${r.echantillon} nuit(s)`
        + (prix !== avant
          ? ` — ramené dans l’étendue observée (${r.min} – ${r.max} €)`
          : '')
    })
    if (prix !== avant) { base.borne_par_etendue = true; base.prix_avant_borne = avant }
    base.fourchette_jour = { min: r.min, max: r.max }
    // ⚠ LE NIVEAU ANNONCE NE DOIT PAS MENTIR — releve en review, et c'est le
    // defaut le plus insidieux du lot.
    // Quand l'etendue du couple (segment, jour) est plus resserree que celle du
    // segment, les cinq niveaux s'ecrasent apres bornage : l'hote lisait
    // « Haut, +2 niveaux, deux signaux dans le meme sens » et voyait
    // EXACTEMENT le prix neutre. Les quatre couches, l'amplitude et le cumul
    // n'avaient produit aucun euro, pendant que la reponse affirmait le
    // contraire — l'exigence « chaque euro se justifie par une couche » prise
    // a revers dans le meme objet.
    const socleBorne = Math.min(r.max, Math.max(r.min, arrondi(prixSocle * r.ratio)))
    if (base.deplacement !== 0 && prix === socleBorne) {
      base.deplacement_effectif = 0
      base.niveau_effectif = NIVEAUX[SOCLE].nom
      base.non_calculable.push(MOTIFS.PIPELINE_NEUTRALISE)
      // Deux causes possibles, et l'hote doit savoir laquelle : soit ce
      // jour-la s'est toujours vendu au meme prix, soit c'est le segment
      // entier qui est ecrase par un tarif dominant.
      const etendueEtroite = r.min === r.max
      base.couches.push({
        nom: 'neutralisation',
        deplacement: 0,
        detail: etendueEtroite
          ? `ce ${s.jour_semaine} s’est toujours vendu à ${r.min} € :`
            + ` le déplacement de ${base.deplacement > 0 ? '+' : ''}${base.deplacement}`
            + ` niveau(x) ne change aucun euro`
          : `les niveaux de ce type de période se confondent (${niveau.prix} €) :`
            + ` le déplacement de ${base.deplacement > 0 ? '+' : ''}${base.deplacement}`
            + ` niveau(x) ne change aucun euro`
      })
    }
  } else {
    base.couches.push({ nom: 'jour_de_semaine', ratio: null, prix,
      detail: `${s.jour_semaine} : pas assez de nuits, aucune correction` })
  }

  // ─── 5. LE PLANCHER : IL REFUSE, IL NE RABOTE PAS ─────────────────────────
  // Regle gravee au KB du prix plancher : on FERME la date, on ne remonte
  // jamais le prix a la place de l'hote. Ici, on refuse de suggerer — proposer
  // un prix releve au plancher ferait croire que le moteur le recommande.
  const cents = Math.round(prix * 100)
  // ⚠ `bien || {}`, JAMAIS `bien ? … : { ok: true }` — releve en review.
  // La valeur par defaut du parametre est `null`, et l'ancienne ligne sautait
  // alors le plancher ENTIEREMENT. Or `plancherDuBien(null)` rend le plancher
  // GLOBAL de 10 EUR : cette garde existe precisement pour le cas « aucun
  // reglage ». Un appelant qui oublie `prix_minimum` dans son SELECT restait
  // protege ; un appelant qui oublie `bien` tout court n'avait plus aucun
  // plancher — et c'est le plus facile a produire.
  const verdict = tarifAcceptable(cents, bien || {})
  if (!verdict.ok) {
    base.non_calculable.push(MOTIFS.SOUS_PLANCHER)
    base.prix_refuse = prix
    base.plancher = verdict.plancher != null ? arrondi(verdict.plancher / 100) : null
    return base
  }

  base.prix = prix
  // Le niveau REELLEMENT servi : identique au niveau choisi, sauf quand
  // l'etendue du jour l'a neutralise.
  if (base.deplacement_effectif == null) {
    base.deplacement_effectif = base.deplacement
    base.niveau_effectif = base.niveau
  }
  base.fourchette = { min: g.min, max: g.max }
  base.echantillon = g.echantillon
  base.reservations = g.reservations
  return base
}

module.exports = {
  NIVEAUX,
  SOCLE,
  AMPLITUDE_MAX,
  SEUIL_NUITS,
  SEUIL_RESERVATIONS,
  MOTIFS,
  quantile,
  construireGrille,
  suggerer
}
