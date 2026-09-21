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
// Une fenetre de FILTRE peut depasser JOURS_MAX (borne d'ENUMERATION de
// capacite.js) : dix ans, c'est deja au-dela de tout ce que le radar demande.
const FENETRE_MAX = 3660
const nuits = (debut, fin) => Math.round((Date.parse(`${fin}T00:00:00Z`) - Date.parse(`${debut}T00:00:00Z`)) / 86400000) + 1
const { fermeturesDuBien, nuitsFermees } = require('../fermetures')

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
//
// ⚠ DEUX SOURCES, UN SEUL ENSEMBLE (lot 4.6.2). Les EXCEPTIONS (declarations
// de l'hote sur son passe) et les FERMETURES (verrous poses sur l'avenir)
// sont deux objets, deux tables — mais pour le moteur c'est la meme chose :
// une nuit que l'hote a explicitement retiree de la vente n'est ni une
// reference ni une capacite. Une fermeture passee sort donc de la reference
// comme une exception, SANS qu'on la recopie dans l'autre table. C'est le
// pont, et il n'existe qu'ici : tout appelant qui filtre par `joursExclus`
// voit les deux, et aucun ne peut en oublier une.
// ⚠ C'EST LA SEULE PORTE VERS « QUELS JOURS SORTENT DE LA REFERENCE » — releve
// en review : trois chemins de prod (api/yield.js, api/yield-prix.js,
// lib/yield/grille-du-bien.js) construisaient leur propre Set depuis
// `exceptionsDuBien`, et les fermetures n'en sortaient jamais. Ils passent ici
// desormais ; `opts.exceptions` evite de relire ce qu'ils ont deja lu pour
// l'ecran.
async function joursExclus (supabase, propertyId, debut, fin, opts = {}) {
  // ⚠ BORNE D'AMPLITUDE, comme `capacite.js` — releve en review.
  // Rien ne limitait l'enumeration : ni `periodeValide`, ni le CHECK de la
  // migration. Une fenetre 1900-2999 — la paire exacte des valeurs par defaut
  // du GET, donc facile a copier — produisait 400 000 iterations et un Set de
  // 400 000 entrees A CHAQUE appel du moteur. On refuse, on ne tronque pas.
  // ⚠ LA FENETRE EST UN FILTRE, PAS UNE ENUMERATION — precise en re-review du
  // 4.6.2. On n'enumere que les jours des exceptions et des fermetures, bornes
  // par leur propre longueur ; la fenetre ne sert qu'a ne garder que ce qui
  // tombe dedans. La garde ci-dessus vise l'absurde (1900-2999), pas les
  // fenetres de contexte legitimes du radar (`api/yield-prix.js` remonte trois
  // ans en arriere et jusqu'au dernier mois consulte : 2 000 jours se
  // depassent des 2029). Brancher les trois chemins de prod sur cette fonction
  // avec la borne stricte les faisait tomber en 500 sur ces mois.
  if (!estJourISO(debut) || !estJourISO(fin) || fin < debut) {
    throw new Error(`[yield-exceptions] fenetre invalide : ${debut} -> ${fin}`)
  }
  if (joursDeLaPeriode(debut, fin) === null && nuits(debut, fin) > FENETRE_MAX) {
    throw new Error(`[yield-exceptions] fenetre trop longue : ${debut} -> ${fin} (max ${FENETRE_MAX} jours)`)
  }
  const periodes = Array.isArray(opts.exceptions) ? opts.exceptions : await exceptionsDuBien(supabase, propertyId, debut, fin)
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
  // Les fermetures de l'hote : memes bornes, meme regle de croisement. Une
  // lecture en echec LEVE ici aussi — un vide par erreur gonflerait le
  // denominateur de nuits que l'hote a fermees.
  for (const j of nuitsFermees(await fermeturesDuBien(supabase, propertyId, debut, fin), debut, fin)) exclus.add(j)
  return exclus
}

// ─── Ecriture ────────────────────────────────────────────────────────────────
// ⚠ LE CHEVAUCHEMENT EST AUTORISE, ET C'EST DELIBERE.
// Deux exceptions peuvent se recouvrir (« travaux » du 1er au 30, « fermeture
// personnelle » du 15 au 20) : ce sont deux faits distincts, tous deux vrais.
// Les fusionner perdrait le motif de l'un, et le moteur ne calcule que sur
// l'UNION des jours exclus — un jour exclu deux fois est exclu une fois.
/**
 * ⚠ UNE EXCEPTION PORTE SUR LE PASSE, JAMAIS SUR L'AVENIR — arbitrage de
 * Thierry au lot 4.3.
 *
 * Le futur se pilote par le CALENDRIER (fermer la date) ou par les PRIX, jamais
 * par une exception. Raison : une exception dit « ces nuits ne comptent pas
 * comme normales » — c'est une relecture de ce qui a eu lieu. Posee sur
 * l'avenir, elle serait une intention deguisee : le moteur retirerait de sa
 * reference des jours que l'hote n'a pas fermes et qui peuvent encore se
 * vendre, et le jour ou ils se vendraient, leur CA serait dans le realise mais
 * leurs nuits hors de la reference. Deux verites pour la meme nuit.
 *
 * ⚠ `aujourdHui` EST FOURNI PAR L'APPELANT, comme partout dans ce chantier.
 * Un module qui lit l'horloge est intestable, et ses tests deviennent faux le
 * jour ou ils passent.
 */
async function creerException (supabase, { userId, propertyId, debut, fin, motif, aujourdHui }) {
  if (!supabase) throw new Error('[yield-exceptions] supabase requis')
  if (!userId || !propertyId) throw new Error('[yield-exceptions] userId et propertyId requis')
  if (!periodeValide(debut, fin)) {
    throw new Error(`[yield-exceptions] periode invalide : ${debut} -> ${fin}`)
  }
  if (!estJourISO(aujourdHui)) {
    throw new Error('[yield-exceptions] aujourdHui requis (contrat d appel)')
  }
  // La borne est STRICTE : une periode qui finit aujourd'hui contient le jour
  // en cours, qui n'est pas fini. On refuse a la porte plutot que de tronquer —
  // tronquer changerait la declaration de l'hote sans le lui dire.
  if (fin >= aujourdHui) {
    throw new Error(`[yield-exceptions] periode dans le futur : ${debut} -> ${fin}`
      + ' (une exception porte sur le passe ; fermez la date au calendrier pour l avenir)')
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
