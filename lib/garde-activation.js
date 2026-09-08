// lib/garde-activation.js
// LE CRAN D'ARRET AVANT ACTIVATION D'UN CANAL — point de verite unique.
// Regle gravee par Thierry (8 septembre 2026) : « aucun rate plan, aucun prix,
// aucune grille d'occupation ne part vers les OTA a la connexion sans ma
// validation explicite. La sync tarifaire est un acte separe de la connexion. »
//
// ⚠ POURQUOI ON NE JUGE PAS SUR CE QUE CHANNEX REND.
// Premiere version de cette garde : compter les dates que Channex detient. Elle
// etait INERTE, et c'est un piege qu'il faut garder ecrit.
// Channex rend une grille DENSE — une entree par date, remplie par le prix par
// defaut de l'option du rate plan — meme quand HoteSmart n'a JAMAIS rien pousse.
// Mesure directe : docs/specs/protocole-staging-tarifs.md, question 3 — une date
// poussee sans champ `rate` relit `333.00`, le defaut du plan. Et analyse.md §1.2
// l'avait deja constate : « 365 jours rendus sur 365, 365 avec un prix » sur un
// bien en mode `keep`, sans une seule ligne dans `calendar_inventory`.
// Compter ces dates, c'est lire comme preuve de securite la donnee qui EST le
// danger.
//
// ⚠ ET PAS SUR `last_fullsync_at` NON PLUS : il n'est pose que par le full sync
// du cron, jamais par les poussees delta d'api/calendar.js. Les quatre biens du
// parc le portent a NULL, Colomiers compris — un bien qui a pourtant vendu.
//
// LE SEUL JUGE HONNETE EST LE COEUR : detenons-NOUS un prix pour ce bien ?
// Si non, ce que Channex publierait ne vient pas de l'hote — il vient du defaut
// du rate plan. C'est mesurable chez nous, et rien de ce que le provider raconte
// ne peut le fausser.

const FENETRE_JOURS = 400

// Rend { pret, raison, message, prix_detenus }.
// `supabase` est injecte : cette fonction ne cree aucun client (testable).
async function jugerPrixDuCoeur (supabase, prop) {
  if (!prop || !prop.id) {
    return { pret: false, raison: 'bien_inconnu', message: 'Bien introuvable.' }
  }

  // Un prix de base couvre TOUTES les dates : rien ne peut partir sans prix.
  const base = prop.base_price != null ? Number(prop.base_price) : null
  if (base && base > 0) {
    return { pret: true, raison: null, prix_detenus: 'base_price' }
  }

  // Sinon : le coeur detient-il au moins une exception de prix a venir ?
  // ⚠ CLE UUID. `calendar_inventory.property_id` porte `properties.id`, pas
  // l'identifiant provider (piege documente, verifie sur Colomiers).
  const debut = new Date().toISOString().slice(0, 10)
  const fin = new Date(Date.now() + FENETRE_JOURS * 86400000).toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('calendar_inventory')
    .select('date, rate')
    .eq('property_id', prop.id)
    .gte('date', debut).lte('date', fin)
    .not('rate', 'is', null)
    .limit(1000)
  // postgrest-js NE THROW PAS. Une garde qui ne lit pas `error` prendrait une
  // panne de lecture pour « aucun prix » — ici c'est le sens SUR (on refuse),
  // mais il faut le dire, pas le subir.
  if (error) {
    return { pret: false, raison: 'lecture_impossible',
      message: `Impossible de verifier les prix du logement (${error.message}). On n'active pas a l'aveugle.` }
  }

  const avecPrix = (data || []).filter(r => Number(r.rate) > 0)
  if (!avecPrix.length) {
    return {
      pret: false, raison: 'aucun_prix_dans_le_coeur', prix_detenus: 0,
      message: 'Ce logement n\'a aucun prix dans HoteSmart : ni prix de base, ni prix par date sur les 400 prochains jours. '
        + 'Activer le canal publierait le prix par defaut du plan tarifaire — un prix que vous n\'avez jamais choisi. '
        + 'Saisissez vos prix, synchronisez, verifiez l\'apercu, puis activez.'
    }
  }

  return { pret: true, raison: null, prix_detenus: avecPrix.length }
}

module.exports = { jugerPrixDuCoeur, FENETRE_JOURS }
