// lib/yield/vacances.js — LECTEUR des vacances scolaires du coeur.
// Lot 3.4 de l'etape 3. Spec : docs/specs/spec-yieldflow-v1.md §5 et §6.
//
// ⚠ SEUL MODULE IMPUR DE LA REFERENCE, ET C'EST VOULU. `reference.js` ne lit
// rien : il recoit les periodes deja chargees. Ce fichier est la frontiere.
// La regle d'architecture du depot (provider → coeur → apps) veut qu'une app
// ne parle jamais a un tiers : les vacances viennent de `school_holidays`,
// remplie par `scripts/importer-vacances-scolaires.js`, jamais de
// data.education.gouv.fr en direct.
//
// Les jours feries, eux, ne se lisent nulle part : ils se CALCULENT
// (`lib/yield/jours-feries.js`). Deux donnees, deux traitements opposes —
// raisonne dans docs/kb/evenements-yield.md §1.

const TABLE = 'school_holidays'

/**
 * Charge les periodes de vacances couvrant une fenetre, toutes zones.
 *
 * ⚠ TOUTES LES ZONES, PAS SEULEMENT CELLE DU BIEN. Un logement de Bagneres
 * (zone C) accueille des Lyonnais (A) et des Lillois (B) : la demande depend
 * des vacances de TOUTES les zones. `properties.zone_scolaire` situe le bien,
 * elle ne limite pas le moteur (docs/kb/evenements-yield.md §2).
 *
 * @returns {Array} [{ zone, nom, date_debut, date_fin, annee_scolaire }]
 */
async function lireVacances (supabase, debut, fin) {
  if (!supabase || !debut || !fin) return []
  // Une periode CHEVAUCHANTE compte : les vacances de Noel commencent en
  // decembre et finissent en janvier. Filtrer sur `date_debut >= debut`
  // perdrait la moitie de chaque hiver.
  const { data, error } = await supabase
    .from(TABLE)
    .select('zone, nom, date_debut, date_fin, annee_scolaire')
    .lte('date_debut', fin)
    .gte('date_fin', debut)
    .order('date_debut')
  if (error) throw new Error(`lecture ${TABLE} : ${error.message}`)
  return data || []
}

/**
 * ⚠ LA COUVERTURE SE VERIFIE, ELLE NE SE SUPPOSE PAS.
 * La table s'arrete a la derniere annee scolaire publiee (2027-07-03 au
 * 12 septembre 2026). Au-dela, `segmenterJour` classerait chaque jour « hors
 * vacances » — un ete entier reduit a du hors-saison, sans la moindre erreur.
 * Le meme trou existe AVANT la premiere periode importee, et pour une ZONE
 * absente : les trois cas sont verifies ici pour que l'appelant les DISE
 * plutot que de servir une reference fausse.
 *
 * @param {string} zone  zone du bien — facultative, mais c'est elle qui decide
 *                       du seul segment qui porte un signal de prix.
 */
function couverture (periodes, debut, fin, zone = null) {
  const vide = { complete: false, debut: null, fin: null, zones: [],
    manque: 'aucune periode' }
  if (!periodes || !periodes.length) return vide
  const zones = [...new Set(periodes.map(p => p.zone))].sort()
  const min = periodes.reduce((a, p) => (a == null || p.date_debut < a) ? p.date_debut : a, null)
  const max = periodes.reduce((a, p) => (a == null || p.date_fin > a) ? p.date_fin : a, null)

  // ⚠ LES DEUX BORNES, PAS SEULEMENT LA FIN — releve en review.
  // Premiere version : `complete = max >= fin`. Une table ne contenant que
  // l'ete 2026 etait declaree « complete » pour une fenetre 2023-2025 : la
  // reference a trois ans se batissait alors avec deux etes classes « hors
  // vacances », le segment des vacances perdait les deux tiers de son
  // echantillon, et la mediane hors-vacances etait polluee de haute saison.
  // On ne peut pas exiger que les vacances couvrent CHAQUE jour — il y a des
  // jours hors vacances, c'est le principe — mais on exige que la SOURCE
  // deborde la fenetre des deux cotes.
  const manques = []
  if (min == null || min > debut) manques.push(`la source commence au ${min}, la fenetre au ${debut}`)
  if (max == null || max < fin) manques.push(`la source s'arrete au ${max}, la fenetre va au ${fin}`)

  // ⚠ ET LA ZONE DU BIEN, QUI DECIDE DU SEUL SEGMENT QUI PORTE UN SIGNAL.
  // Si l'import de la zone C a echoue, les zones A et B suffisaient a rendre
  // `complete: true` — et tous les jours de vacances du bien partaient en
  // « vacances autre zone », le segment dont le KB §2 dit qu'il ne porte
  // aucun signal de prix.
  if (zone && !zones.includes(zone)) {
    manques.push(`la zone ${zone} du bien est absente (zones presentes : ${zones.join(', ') || 'aucune'})`)
  }

  return {
    complete: manques.length === 0,
    debut: min,
    fin: max,
    zones,
    manque: manques.length ? manques.join(' ; ') : null
  }
}

/**
 * L'ETENDUE REELLE DE LA SOURCE, toutes zones — une ligne par zone.
 *
 * ⚠ POURQUOI ELLE EXISTE : `couverture()` attend l'etendue de la TABLE, pas
 * celle d'une lecture deja filtree. Passer la sortie de `lireVacances` — qui ne
 * rend que les periodes CHEVAUCHANT la fenetre — exigeait que les deux bornes
 * de la fenetre tombent DANS des vacances : le bandeau « source incomplete »
 * criait faux des qu'une fenetre commencait hors vacances, avec une table
 * pourtant complete. Releve en review.
 *
 * @returns {Array} [{ zone, date_debut, date_fin }] — une entree par zone,
 *                  aux bornes extremes de ce que la table contient.
 */
async function etendueSource (supabase) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from(TABLE).select('zone, date_debut, date_fin')
  if (error) throw new Error(`etendue ${TABLE} : ${error.message}`)
  const parZone = new Map()
  for (const l of data || []) {
    if (!l || !l.zone) continue
    const e = parZone.get(l.zone)
    if (!e) { parZone.set(l.zone, { zone: l.zone, date_debut: l.date_debut, date_fin: l.date_fin }); continue }
    if (l.date_debut < e.date_debut) e.date_debut = l.date_debut
    if (l.date_fin > e.date_fin) e.date_fin = l.date_fin
  }
  return [...parZone.values()]
}

module.exports = { lireVacances, couverture, etendueSource, TABLE }
