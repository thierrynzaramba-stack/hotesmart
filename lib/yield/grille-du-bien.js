// lib/yield/grille-du-bien.js — LA GRILLE D'UN BIEN, LUE UNE FOIS.
// Etape 4 de YieldFlow. Spec : docs/specs/spec-yieldflow-v1.md §7.3.
//
// ⚠ POURQUOI CE FICHIER EXISTE. Deux ecrans ont besoin de la grille : la page
// des prix, et le calendrier de pilotage (pour montrer ou chaque contexte se
// positionne). Recopier la lecture aurait fait DEUX chemins vers le meme
// chiffre — et deux chemins finissent toujours par diverger. C'est le defaut
// que ce depot a deja paye plusieurs fois (`nuits-occupees.js` est ne de la
// meme facon).
//
// ⚠ CE MODULE LIT, IL N'ECRIT RIEN, et il ne decide de rien : il assemble la
// matiere et delegue le calcul aux modules purs.

const { eclater, construirePontDemapped } = require('./eclatement')
const { estJourISO } = require('./capacite')
const { exceptionsDuBien, joursExclus } = require('./exceptions')
const S = require('./suggestion')

const RESERVATIONS_MAX = 20000

/**
 * Toutes les reservations du COMPTE, paginees.
 *
 * ⚠ LE COMPTE EST OBLIGATOIRE : `provider_property_id` n'a aucune unicite
 * globale. Filtrer d'abord sur `user_id`, ensuite sur le bien — jamais
 * l'inverse.
 * ⚠ PAGINATION OBLIGATOIRE : PostgREST plafonne a 1000 lignes, et un
 * historique de trois ans les depasse. Sans elle, les lignes manquantes
 * tombaient en silence et la grille etait batie sur une partie du passe.
 */
async function lireReservations (supabase, compte) {
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
      throw new Error('historique_trop_volumineux')
    }
  }
  return lignes
}

/**
 * Les eclatements d'un bien sur une fenetre, exceptions appliquees.
 * @returns {Array} sortie d'`eclater()`, nuits en exception MARQUEES
 */
async function eclatementsDuBien (supabase, bien, compte, debut, fin) {
  return (await lireEtEclater(supabase, bien, compte, debut, fin)).eclatements
}

// Les lignes BRUTES du bien et leurs eclatements, en une lecture. L'ecran des
// prix a besoin des deux (les sejours non confirmes n'ont pas de nuits, mais
// ont une barre) : les rendre ici lui evite de relire `bookings_snapshot`.
async function lireEtEclater (supabase, bien, compte, debut, fin) {
  const lignes = await lireReservations(supabase, compte)
  const { pont } = construirePontDemapped(lignes, bien.provider)
  const duBien = lignes.filter(l => l.property_id === bien.provider_property_id)
  const exceptions = await exceptionsDuBien(supabase, bien.id, debut, fin)
  // ⚠ PAR `joursExclus` : exceptions ∪ FERMETURES de l'hote (lot 4.6.2).
  const exclus = await joursExclus(supabase, bien.id, debut, fin, { exceptions })
  return {
    duBien,
    eclatements: duBien.map(l => eclater(l, {
      pont, joursExclus: exclus, defaultProvider: bien.provider
    }))
  }
}

/**
 * LA GRILLE DU BIEN, et le positionnement de chaque contexte dessus.
 *
 * @param {Object} options
 *   - contexte       sortie de `construireContexte`, evenements inclus
 *   - debut / fin    la fenetre d'HISTORIQUE (ancree sur aujourd'hui, pas sur
 *                    le mois regarde — la grille est une propriete du bien)
 *   - exclus         { debut, fin } : la fenetre sur laquelle les nuits en
 *                    exception ou en fermeture sont MARQUEES. Par defaut,
 *                    l'historique. L'ecran des prix passe la fenetre de son
 *                    contexte (ses sejours et son N-1 lisent ces marques) ; la
 *                    grille, elle, ne lit que l'historique — elle est la meme.
 * @returns { eclatements, grille, duBien } — `duBien` : les lignes brutes.
 */
async function grilleDuBien (supabase, bien, compte, options = {}) {
  const { contexte, debut, fin } = options
  if (!estJourISO(debut) || !estJourISO(fin)) {
    throw new Error('[grille] fenetre d historique invalide')
  }
  const ex = options.exclus && estJourISO(options.exclus.debut) && estJourISO(options.exclus.fin)
    ? options.exclus : { debut, fin }
  const { duBien, eclatements } = await lireEtEclater(supabase, bien, compte, ex.debut, ex.fin)
  return {
    eclatements,
    duBien,
    grille: S.construireGrille(eclatements, { contexte, debut, fin })
  }
}

module.exports = { RESERVATIONS_MAX, lireReservations, eclatementsDuBien, grilleDuBien }
