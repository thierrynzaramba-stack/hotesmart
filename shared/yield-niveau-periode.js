// shared/yield-niveau-periode.js — LA PASTILLE DE NIVEAU D'UNE PERIODE.
//
// ⚠⚠ AMENDEMENT DU 29 OCTOBRE 2026, recette de Thierry. Consigne gravee, mot
// pour mot :
//
//   « Les seuls niveaux de prix de YieldFlow sont Base / Moyen / Haut /
//     Tres haut / Exceptionnel. "un peu plus chers / nettement / moins chers /
//     prix normaux" ne correspondent a rien dans le moteur : on les retire
//     partout. »
//
// Ce module ne CALCULE rien : il met en mots ce que le serveur a calcule
// (`niveaux_jour`, un niveau par jour de semaine, pose par
// lib/yield/calendrier-pilotage.js avec la formule du moteur). Il n'a ni
// horloge, ni reseau, ni DOM — il se teste seul.
//
// ⚠ ET LE CHIFFRE EST TOUJOURS ECRIT (regle 2 de Thierry, 3 novembre 2026) :
// « 1 · Base » … « 5 · Exceptionnel ». Depuis l'echelle d'encre, le fond ne
// porte plus l'information au bas de l'echelle — --niveau-1 est a ΔE 1,0 du
// fond « nuit passee ». C'est le chiffre qui la porte.

export const NIVEAUX_ORDRE = ['Base', 'Moyen', 'Haut', 'Très haut', 'Exceptionnel']

// La semaine dans l'ordre ou on la lit, pas dans l'ordre de getUTCDay().
export const JOURS_ORDRE = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']

// ⚠ LE WEEK-END DU MOTEUR EST SAMEDI + DIMANCHE (`estWeekEnd`,
// lib/yield/reference.js). Celui de la maquette du chantier voisin est
// vendredi + samedi. Les deux sont justes dans leur contexte, et on ne les
// « aligne » jamais par megarde : ici c'est le moteur qui fait foi, puisque
// c'est lui qui a produit les niveaux.
const WEEK_END = new Set(['samedi', 'dimanche'])

const PLURIEL = {
  lundi: 'lundis', mardi: 'mardis', mercredi: 'mercredis', jeudi: 'jeudis',
  vendredi: 'vendredis', samedi: 'samedis', dimanche: 'dimanches'
}

/** « 3 · Haut ». Le niveau inconnu rend null, jamais un chiffre invente. */
export function avecChiffre (niveau) {
  const i = NIVEAUX_ORDRE.indexOf(niveau)
  return i < 0 ? null : `${i + 1} · ${niveau}`
}

const et = (mots) => mots.length <= 1 ? (mots[0] || '')
  : `${mots.slice(0, -1).join(', ')} et ${mots[mots.length - 1]}`

/**
 * Regroupe les sept jours par niveau.
 * @param {object|null} niveauxJour { lundi: 'Haut', … } — un jour sans mesure
 *   vaut `null` et n'entre dans AUCUN groupe : on n'invente pas un niveau.
 * @returns {{groupes: Array<{niveau, jours, indice}>, mesures: number, inconnus: string[]}}
 *   `groupes` tries du plus NOMBREUX au moins nombreux, puis du plus HAUT.
 *   `mesures` = combien de jours ont un niveau. `inconnus` = les valeurs que
 *   le serveur a envoyees et que cette table ne connait pas.
 */
export function analyser (niveauxJour) {
  const vide = { groupes: [], mesures: 0, inconnus: [] }
  if (!niveauxJour || typeof niveauxJour !== 'object') return vide
  const par = new Map()
  const inconnus = []
  let mesures = 0
  for (const j of JOURS_ORDRE) {
    const n = niveauxJour[j]
    if (n == null) continue
    if (NIVEAUX_ORDRE.indexOf(n) < 0) {
      // ⚠ UN NIVEAU INCONNU NE SE JETTE PAS EN SILENCE — constat de review.
      // Le serveur transmet la CHAINE du niveau, pas son indice : un renommage
      // dans NIVEAUX ferait disparaitre des jours sans un mot, et la pastille
      // affirmerait « toute la semaine » sur ce qui reste.
      if (!inconnus.includes(n)) inconnus.push(n)
      continue
    }
    mesures++
    if (!par.has(n)) par.set(n, [])
    par.get(n).push(j)
  }
  const groupes = [...par.entries()]
    .map(([niveau, jours]) => ({ niveau, jours, indice: NIVEAUX_ORDRE.indexOf(niveau) }))
    .sort((a, b) => b.jours.length - a.jours.length || b.indice - a.indice)
  return { groupes, mesures, inconnus }
}

/** Compatibilite : la liste seule. */
export function groupes (niveauxJour) { return analyser(niveauxJour).groupes }

/**
 * Le libelle de la pastille, selon les QUATRE cas de la spec (§0 bis.1).
 * @returns {{principal: string, complement: string|null, titre: string}|null}
 *   null quand il n'y a RIEN a dire — l'appelant affiche alors « Automatique ».
 */
export function libellePastille (niveauxJour) {
  const { groupes: g, mesures, inconnus } = analyser(niveauxJour)
  if (!g.length) return null

  const detail = g.map(x => `${et(x.jours.map(j => PLURIEL[j]))} : ${avecChiffre(x.niveau)}`).join(' · ')
  // ⚠ ON NE PARLE QUE DES JOURS MESURES — constat de review. « Toute la
  // semaine au niveau X » affirme sur SEPT jours ; avec un seul jour mesure,
  // c'est une affirmation sur six jours qu'on n'a jamais vus. C'est la faute
  // que §0 bis.1 ferme pour le mot « week-end », rouverte sur « la semaine ».
  const complet = mesures === JOURS_ORDRE.length
  const reserve = inconnus.length
    ? ` ⚠ ${inconnus.length} niveau(x) non reconnu(s) : ${inconnus.join(', ')}.`
    : (complet ? '' : ` ${JOURS_ORDRE.length - mesures} jour(s) sans mesure.`)

  // 1. TOUS les jours mesures au meme niveau → UNE pastille.
  if (g.length === 1) {
    return { principal: avecChiffre(g[0].niveau), complement: null,
      titre: (complet
        ? `Toute la semaine au niveau ${avecChiffre(g[0].niveau)}.`
        : `${et(g[0].jours.map(j => PLURIEL[j]))} : ${avecChiffre(g[0].niveau)}.`) + reserve }
  }

  const [base, autre] = g
  // 2. les jours qui different sont EXACTEMENT le week-end du moteur.
  const estWeekEnd = g.length === 2 && autre.jours.length === WEEK_END.size
    && autre.jours.every(j => WEEK_END.has(j))
  if (estWeekEnd) {
    return { principal: avecChiffre(base.niveau),
      complement: `week-ends ${avecChiffre(autre.niveau)}`, titre: `${detail}.${reserve}` }
  }
  // 3. sinon, ON NOMME LES JOURS.
  if (g.length === 2) {
    return { principal: avecChiffre(base.niveau),
      complement: `${et(autre.jours.map(j => PLURIEL[j]))} ${avecChiffre(autre.niveau)}`,
      titre: `${detail}.${reserve}` }
  }
  // 4. plus de deux groupes → le plus NOMBREUX et le plus HAUT.
  const haut = g.slice().sort((a, b) => b.indice - a.indice)[0]
  if (haut.niveau === base.niveau) {
    return { principal: avecChiffre(base.niveau), complement: null, titre: `${detail}.${reserve}` }
  }
  return { principal: avecChiffre(base.niveau),
    complement: `${et(haut.jours.map(j => PLURIEL[j]))} ${avecChiffre(haut.niveau)}`,
    titre: `${detail}.${reserve}` }
}

/**
 * Ce que ▲ ou ▼ donnerait, pour l'annoncer AVANT le clic (§0 bis.2).
 *
 * ⚠⚠ LE PAS SE CALCULE SUR LES CRANS, PAS SUR LES INDICES AFFICHES — deux
 * constats de review, mesures tous les deux. Ma premiere version faisait
 * `indice ± 1` sur des indices DEJA ECRETES, et le gestionnaire de clic, lui,
 * ecrete les CRANS a ±max. D'ou :
 *   · structure 4 + crans +2 → affiche Exceptionnel ; ▼ annoncait « passe a
 *     Tres haut » et le clic (crans 1) laissait Exceptionnel — un bouton actif
 *     qui ne fait rien ;
 *   · crans_mesures +4 (possible : l'ecart de deux indices va de −4 a +4) et
 *     structure 0 → ▼ annoncait Tres haut, le clic ecrivait 2 → Haut, deux
 *     crans plus bas que promis.
 *
 * ⚠ ET ▼ N'EST PLUS COUPE PARCE QU'UN GROUPE EST A BASE. Base est le quantile
 * 0,25 : les jours ordinaires de semaine y sont le cas COURANT. Avec une
 * semaine a Base et un week-end a Haut, passer de +2 a +1 fait reellement
 * descendre le week-end — refuser le pas rendait la periode inajustable a la
 * baisse. La borne qui compte est celle du moteur (±max) ; l'ecretage de
 * l'echelle, lui, est un effet de bord, pas un refus.
 *
 * @param {object} opts { niveauxJour, structure, crans, cransMax } —
 *   `structure` = { lundi: indice, … }, la structure ORDINAIRE par jour, celle
 *   sur laquelle le cran s'applique. Sans elle, on annonce le geste sans
 *   promettre un niveau d'arrivee.
 * @returns {{possible: boolean, raison: string|null, apres: string|null, pas: number}}
 *   `pas` = le nombre de crans que le clic deplacera reellement (signe
 *   compris) ; plus d'un quand la mesure du moteur depasse l'amplitude.
 */
export function apresLePas (opts, sens, cransActuels, cransMax) {
  // Compatibilite : un appel a l'ancienne (niveauxJour en premier) reste lu,
  // mais il ne peut pas promettre d'arrivee — il n'a pas la structure.
  const o = (opts && (opts.niveauxJour !== undefined || opts.structure !== undefined))
    ? opts : { niveauxJour: opts }
  const crans = (o.crans !== undefined ? o.crans : cransActuels)
  const max = Number.isFinite(o.cransMax !== undefined ? o.cransMax : cransMax)
    ? (o.cransMax !== undefined ? o.cransMax : cransMax) : 2
  const c = crans == null ? 0 : crans
  // ⚠ LA CIBLE EST CELLE QUE LE CLIC ENVERRA : `clamp(c + sens, ±max)`
  // (constat de la review de la chaine, 8 novembre 2026). `c` peut etre la
  // MESURE du moteur, qui va de −4 a +4 : un ferie mesure a +4 que l'on baisse
  // recoit 2, soit DEUX crans de descente — l'annoncer « d'un cran, passe a
  // Tres haut » etait faux. Le pas reel est rendu (`pas`) pour que l'ecran le
  // dise.
  const cible = Math.max(-max, Math.min(max, c + sens))
  // ⚠ LA SEULE BORNE QUI REFUSE EST CELLE DU MOTEUR. Au-dela, le serveur
  // refuserait la valeur : un bouton qui envoie ce qui sera refuse ment.
  // Et un ▲ dont la cible serait PLUS BASSE que la mesure (mesure +4, cible
  // +2) n'est pas une montee : il est refuse, avec la vraie raison.
  if (sens > 0 ? cible <= c : cible >= c) {
    const raison = (o.pose === false && Math.abs(c) > max)
      ? `le moteur mesure déjà ${c > 0 ? '+' : ''}${c} crans, et un réglage s’arrête à ${max}`
      : `le réglage est déjà au maximum (${max} crans)`
    return { possible: false, raison, apres: null, pas: 0 }
  }
  const s = o.structure
  if (!s || typeof s !== 'object') return { possible: true, raison: null, apres: null, pas: cible - c }
  // Le niveau d'arrivee se recalcule depuis la STRUCTURE, comme le moteur.
  const dernier = NIVEAUX_ORDRE.length - 1
  const apresJour = {}
  for (const j of JOURS_ORDRE) {
    const i = s[j]
    if (i == null || !Number.isFinite(i)) continue
    apresJour[j] = NIVEAUX_ORDRE[Math.max(0, Math.min(dernier, i + cible))]
  }
  // ⚠ LA SECONDE BORNE REFUSE QUAND LE PAS NE CHANGERAIT RIEN — et seulement
  // la. La spec (§0 bis.2) demande trois bornes : Base, Exceptionnel, et
  // l'amplitude du moteur. Ma premiere version refusait des qu'UN groupe
  // touchait le bord : avec une semaine a Base et un week-end a Haut — le cas
  // COURANT, Base etant le quantile 0,25 — ▼ mourait pour toute la periode
  // alors que le week-end, lui, serait bien descendu. Constat de review,
  // mesure.
  //
  // Le critere juste n'est pas « un groupe bute » mais « RIEN ne bouge » :
  // on compare l'etat d'arrivee a l'etat de depart.
  const avantJour = {}
  for (const j of JOURS_ORDRE) {
    const i = s[j]
    if (i == null || !Number.isFinite(i)) continue
    avantJour[j] = NIVEAUX_ORDRE[Math.max(0, Math.min(dernier, i + c))]
  }
  const identique = JOURS_ORDRE.every(j => avantJour[j] === apresJour[j])
  if (identique) {
    const a = analyser(avantJour).groupes
    const bute = a.find(x => sens > 0 ? x.indice >= dernier : x.indice <= 0) || a[0]
    if (bute) {
      const pluriel = !(a.length === 1
        || (bute.jours.every(j => WEEK_END.has(j)) && bute.jours.length === WEEK_END.size))
      const quoi = a.length === 1 ? 'la semaine'
        : (pluriel ? `les ${et(bute.jours.map(j => PLURIEL[j]))}` : 'le week-end')
      return { possible: false,
        raison: `${quoi} ${pluriel ? 'sont' : 'est'} déjà à ${avecChiffre(bute.niveau)}`, apres: null, pas: 0 }
    }
  }
  const p = libellePastille(apresJour)
  return { possible: true, raison: null, apres: p ? p.principal : null, pas: cible - c }
}
