// lib/yield/exceptions.js
// DOC : docs/kb/capacite-yield.md §8 (modif = MEME COMMIT)
// SEUL WRITER AUTORISE de la table `yield_exceptions`.
// Spec : docs/specs/spec-yieldflow-v1.md §5 (etape 2, lot 2.2)
//
// Aucun appel provider : ces periodes sont une declaration de l'hote sur SON
// historique, elles n'existent chez aucun canal.
//
// A QUOI SERVENT CES PERIODES. Le moteur calcule sa reference sur 2-3 ans
// d'historique lisse. Des travaux, une fermeture personnelle, un confinement :
// ces mois-la ont vendu zero nuit pour une raison qui n'a rien de commercial.
// Les laisser dans la reference ferait croire au moteur que la demande
// s'effondre a cette saison — et il suggererait de brader l'an prochain.

const { estJourISO, joursDeLaPeriode, JOURS_MAX } = require('./capacite')

// Un identifiant Postgres `uuid` : tout le reste ferait ECHOUER la requete
// (« invalid input syntax for type uuid »), pas rendre un resultat vide.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Bornes INCLUSES, comme partout ailleurs dans le produit : une exception du
// 1er au 3 couvre trois jours. La contrainte CHECK de la table dit la meme
// chose, pour que la regle tienne meme si un jour un autre chemin ecrit.
function periodeValide (debut, fin) {
  return estJourISO(debut) && estJourISO(fin) && fin >= debut
}

// ─── Lecture : les exceptions qui CROISENT une periode ───────────────────────
// ⚠ CROISEMENT, PAS INCLUSION. Une exception du 1er au 30 juin doit ressortir
// quand le moteur interroge la seule semaine du 15 au 21 : la tester par
// inclusion (`date_debut >= debut AND date_fin <= fin`) la manquerait, et la
// semaine entrerait dans la reference alors qu'elle est explicitement exclue.
// Deux intervalles se croisent si chacun commence avant que l'autre ne finisse.
async function exceptionsDuBien (supabase, propertyId, debut, fin) {
  if (!supabase || !propertyId) {
    throw new Error('[yield-exceptions] supabase et propertyId requis')
  }
  // ⚠ UNE FENETRE INVALIDE LEVE, ELLE NE REND PAS UNE LISTE VIDE.
  // Releve en review, et c'etait une contradiction avec le paragraphe suivant :
  // ce module justifie son `throw` sur erreur de lecture par « une exception
  // manquee fait entrer dans la reference une periode ecartee, silencieusement »
  // — puis rendait `[]` sur une borne mal formee. Un `debut=2026-6-1` (mois non
  // padde), ou un parametre repete que Vercel rend en tableau, produisait un
  // 200 « aucune exception declaree » a un hote qui en a declare. Le meme
  // silence, par la porte d'a cote.
  if (!periodeValide(debut, fin)) {
    throw new Error(`[yield-exceptions] periode invalide : ${debut} -> ${fin}`)
  }
  const { data, error } = await supabase
    .from('yield_exceptions')
    .select('id, date_debut, date_fin, motif, created_at')
    .eq('property_id', propertyId)
    .lte('date_debut', fin)
    .gte('date_fin', debut)
    .order('date_debut')
  if (error) {
    // On ne devine pas : une exception manquee fait entrer dans la reference
    // une periode que l'hote a explicitement ecartee. Silencieusement.
    throw new Error(`[yield-exceptions] lecture : ${error.message}`)
  }
  return data || []
}

// L'ensemble des jours exclus, pour que le moteur filtre sans re-deriver les
// bornes a chaque appel — et sans risquer de les deriver autrement.
async function joursExclus (supabase, propertyId, debut, fin) {
  // ⚠ BORNE D'AMPLITUDE, comme `capacite.js` — releve en review.
  // Rien ne limitait l'enumeration : ni `periodeValide`, ni le CHECK de la
  // migration. Une fenetre 1900-2999 — la paire exacte des valeurs par defaut
  // du GET, donc facile a copier — produisait 400 000 iterations et un Set de
  // 400 000 entrees A CHAQUE appel du moteur. On refuse, on ne tronque pas.
  const jours = joursDeLaPeriode(debut, fin)
  if (jours === null) {
    throw new Error(`[yield-exceptions] fenetre trop longue : ${debut} -> ${fin} (max ${JOURS_MAX} jours)`)
  }
  const periodes = await exceptionsDuBien(supabase, propertyId, debut, fin)
  const exclus = new Set()
  for (const p of periodes) {
    const d = new Date(`${p.date_debut}T00:00:00Z`)
    const stop = new Date(`${p.date_fin}T00:00:00Z`)
    while (d <= stop) {
      const j = d.toISOString().slice(0, 10)
      // On ne garde que ce qui tombe DANS la fenetre demandee : une exception
      // qui deborde ne doit pas elargir la reponse.
      if (j >= debut && j <= fin) exclus.add(j)
      d.setUTCDate(d.getUTCDate() + 1)
    }
  }
  return exclus
}

// ─── Ecriture ────────────────────────────────────────────────────────────────
// ⚠ LE CHEVAUCHEMENT EST AUTORISE, ET C'EST DELIBERE.
// Deux exceptions peuvent se recouvrir (« travaux » du 1er au 30, « fermeture
// personnelle » du 15 au 20) : ce sont deux faits distincts, tous deux vrais.
// Les fusionner perdrait le motif de l'un, et le moteur ne calcule que sur
// l'UNION des jours exclus — un jour exclu deux fois est exclu une fois.
async function creerException (supabase, { userId, propertyId, debut, fin, motif }) {
  if (!supabase) throw new Error('[yield-exceptions] supabase requis')
  if (!userId || !propertyId) throw new Error('[yield-exceptions] userId et propertyId requis')
  if (!periodeValide(debut, fin)) {
    throw new Error(`[yield-exceptions] periode invalide : ${debut} -> ${fin}`)
  }
  const texte = String(motif || '').trim()
  if (!texte) throw new Error('[yield-exceptions] motif requis')
  // Borne haute : le motif est une trace pour l'hote, pas un journal.
  if (texte.length > 500) throw new Error('[yield-exceptions] motif trop long (max 500)')

  const { data, error } = await supabase
    .from('yield_exceptions')
    .insert({
      user_id: userId, property_id: propertyId,
      date_debut: debut, date_fin: fin, motif: texte
    })
    .select('id, property_id, date_debut, date_fin, motif, created_at')
    .single()
  if (error) throw new Error(`[yield-exceptions] creation : ${error.message}`)
  return data
}

// La suppression est une correction de saisie, pas une operation courante.
// Elle porte sur l'id ET sur le bien : sans le second filtre, un id devine
// suffirait a supprimer l'exception d'un autre compte — l'endpoint verifie deja
// le droit sur le bien, cette ceinture rend l'erreur impossible ici aussi.
async function supprimerException (supabase, { propertyId, id }) {
  if (!supabase || !propertyId || !id) return { supprimees: 0 }
  // ⚠ UN ID NON-UUID N'EST PAS UNE PANNE — releve en review.
  // `.eq('id', 'abc')` sur une colonne `uuid` fait ECHOUER la requete, pas
  // rendre zero ligne. L'erreur remontait jusqu'au 503 « service
  // indisponible » et partait dans `console.error` comme une panne d'infra.
  // C'est le piege n° 1 deja documente dans `lib/require-permission.js`, qui
  // avait coute une regression reelle.
  if (!UUID_RE.test(String(id))) return { supprimees: 0 }
  const { data, error } = await supabase
    .from('yield_exceptions')
    .delete()
    .eq('id', id)
    .eq('property_id', propertyId)
    .select('id')
  if (error) throw new Error(`[yield-exceptions] suppression : ${error.message}`)
  return { supprimees: (data || []).length }
}

module.exports = {
  exceptionsDuBien,
  joursExclus,
  creerException,
  supprimerException,
  periodeValide
}
