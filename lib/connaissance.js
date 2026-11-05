// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — les règles de la base de connaissance V5
// Spec : docs/specs/spec-base-connaissance-v5.md (lot 3)
//
// ⚠ LES RÈGLES VIVENT ICI, PAS DANS L'ÉCRAN NI DANS L'ENDPOINT. Le seuil des
// 90 jours, ce qui fait qu'une réponse est « à revoir », et la mise en forme
// d'une carte sont des décisions ; écrites dans le balisage, elles seraient
// invisibles d'un test et recopiées au premier second écran (le téléphone en
// est un). C'est la leçon de `shared/calendrier-resa.js` : deux copies
// divergent.
// ═══════════════════════════════════════════════════════════════════════════

const { BALISES, etiquetteDe } = require('./balises')

// ⚠ 90 JOURS, ET LE CHIFFRE EST MESURÉ : le prix du champagne annoncé par l'IA
// le 2 novembre 2026 avait 106 jours. Un badge à 90 aurait sonné 16 jours avant
// la question du voyageur. Décision de Thierry du 3 novembre 2026.
const JOURS_A_REVOIR = 90
const MS_PAR_JOUR = 86400000

/**
 * Une entrée est-elle à revoir ? `null` quand on ne peut pas le dire.
 * ⚠ JAMAIS VÉRIFIÉE N'EST PAS PÉRIMÉE : une entrée que personne n'a encore
 * relue depuis l'écran V5 n'a pas de date. Dire « à revoir » de toutes les
 * entrées existantes le jour du déploiement ferait un écran entièrement ambre,
 * et l'ambre ne vaut que s'il est rare — la charte V5 n'en autorise qu'un par
 * écran.
 */
function aRevoir (verifieLe, maintenant) {
  if (!verifieLe) return false
  const quand = new Date(verifieLe)
  if (isNaN(quand)) return false
  const ref = new Date(maintenant == null ? Date.now() : maintenant)
  if (isNaN(ref)) return false
  return (ref - quand) > JOURS_A_REVOIR * MS_PAR_JOUR
}

/** Depuis quand une entrée n'a-t-elle pas été vérifiée ? `null` si jamais. */
function joursDepuis (verifieLe, maintenant) {
  if (!verifieLe) return null
  const quand = new Date(verifieLe)
  if (isNaN(quand)) return null
  const ref = new Date(maintenant == null ? Date.now() : maintenant)
  return Math.max(0, Math.floor((ref - quand) / MS_PAR_JOUR))
}

// ⚠ LES ÉTIQUETTES VIENNENT DE `lib/balises.js`, JAMAIS RECOPIÉES. L'écran
// montre « Téléphone », jamais `{telephone_hote}` (direction du 3 novembre
// 2026) — et le jour où une balise change de libellé, elle change partout.
const LIBELLE = (cle) => etiquetteDe(cle)

/**
 * Le texte d'une réponse, avec ses balises rendues en ÉTIQUETTES lisibles.
 * Rend aussi la liste des balises employées, pour que l'écran sache lesquelles
 * sont vides (étiquette rouge) sans refaire l'analyse de son côté.
 */
function enEtiquettes (texte, connaissance = {}) {
  const src = String(texte == null ? '' : texte)
  const employees = []
  const rendu = src.replace(/\{([\p{L}\p{N}_ ]{1,40})\}/gu, (brut, cle) => {
    const connue = Object.prototype.hasOwnProperty.call(BALISES, cle)
    const valeur = connaissance[cle]
    const vide = connue && BALISES[cle].origine === 'base'
      && !(valeur != null && String(valeur).trim())
    employees.push({ cle, connue, vide })
    return connue ? `⟦${LIBELLE(cle)}⟧` : brut
  })
  return { rendu, balises: employees }
}

/**
 * La carte d'une réponse prête, telle que les DEUX écrans l'affichent.
 * @param {object} entree  ligne de `knowledge`
 * @param {object} ctx     { connaissance, maintenant }
 */
function carte (entree, ctx = {}) {
  const e = entree || {}
  const { rendu, balises } = enEtiquettes(e.value, ctx.connaissance || {})
  return {
    id: e.id,
    sujet: e.key || '',
    texte: rendu,
    balises,
    // ⚠ TROIS ÉTATS, PAS DEUX : vérifiée, jamais vérifiée, à revoir. Les
    // confondre ferait dire « à revoir » d'une entrée que personne n'a jamais
    // relue — ce n'est pas la même information, et ça ne demande pas le même
    // geste.
    verifieLe: e.verifie_le || null,
    jours: joursDepuis(e.verifie_le, ctx.maintenant),
    aRevoir: aRevoir(e.verifie_le, ctx.maintenant),
    // ⚠ LE CADENAS DIT « HORS IA ». `lisible_par_ia` peut être absente tant que
    // la migration n'est pas passée : l'absence vaut `true`, le comportement
    // d'aujourd'hui, jamais `false` — sinon le déploiement couperait l'agent.
    horsIa: e.lisible_par_ia === false
  }
}

/** Les faits du bloc « Infos du logement », dans l'ordre de la maquette. */
const ORDRE_FAITS = ['telephone_hote', 'adresse', 'checkin', 'checkout', 'wifi_nom', 'wifi_mdp']

function faits (lignes, ctx = {}) {
  const parCle = new Map((lignes || []).filter(l => l.type === 'fixed').map(l => [l.key, l]))
  const connues = ORDRE_FAITS.filter(c => BALISES[c])
  const autres = [...parCle.keys()].filter(c => !connues.includes(c)).sort()
  return [...connues, ...autres].map(cle => {
    const l = parCle.get(cle)
    const valeur = l && l.value != null ? String(l.value) : ''
    return {
      cle,
      libelle: LIBELLE(cle),
      balise: BALISES[cle] ? `{${cle}}` : null,
      valeur,
      // ⚠ UNE VALEUR VIDE SE DIT « À REMPLIR », EN ROUGE (maquette validée) —
      // pas un blanc, pas un tiret : un blanc ne se remarque pas.
      aRemplir: !valeur.trim(),
      verifieLe: (l && l.verifie_le) || null,
      aRevoir: aRevoir(l && l.verifie_le, ctx.maintenant),
      horsIa: !!(l && l.lisible_par_ia === false),
      // Une clé sans balise n'est lisible que par l'IA : aucun message ne peut
      // l'insérer, et l'hôte doit le savoir.
      sansBalise: !BALISES[cle]
    }
  })
}

module.exports = {
  JOURS_A_REVOIR, ORDRE_FAITS,
  aRevoir, joursDepuis, enEtiquettes, carte, faits
}
