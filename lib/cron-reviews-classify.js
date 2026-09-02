// lib/cron-reviews-classify.js
// Classification de la PROPRETE dans les avis voyageurs -> ota_reviews.ai_*.
//
// DEUX ETAGES, et c'est le coeur de la conception :
//
//   Etage 1 — REGLE DETERMINISTE, sans appel IA. Airbnb livre deja des tags de
//   proprete (squeaky_clean_bathroom, pristine_kitchen, spotless...) et une note
//   de categorie. Sur les 70 premiers avis reels, 19 etaient tranchables par les
//   seuls tags : payer un LLM pour redire ce qu'Airbnb dit en clair serait
//   absurde, et surtout moins auditable — une regle se relit, un verdict de LLM
//   se croit.
//
//   Etage 2 — HAIKU, uniquement sur ce que l'etage 1 ne tranche pas : pas de tag
//   exploitable mais du texte. 30 des 70 avis n'ont AUCUN tag (dont les avis
//   Booking, qui n'en fournit jamais), et 13 parlent de proprete dans leur texte
//   sans qu'aucun tag ne le signale. C'est exactement ce que l'IA seule voit.
//
// L'IA garde une mission que rien d'autre ne remplit : l'EXTRAIT cite mot pour
// mot. Sur la fiche prestataire, montrer la phrase du voyageur vaut mieux qu'un
// verdict — c'est verifiable, et ca ne se conteste pas.

const { supabase, anthropic } = require('./cron-shared')

const MARQUEUR   = 'reviews_classify'
// ⚠ CADENCE HORAIRE, PAS QUOTIDIENNE, et le lot reste borne a 20.
// Le lot de 20 est un plafond de COUT par passage ; la cadence, elle, fixe le
// DEBIT. A 24 h, le debit maximal etait de 20 avis par jour POUR TOUTE LA
// PLATEFORME : un hote qui connecte un compte avec 200 avis d'historique
// monopolisait la file pendant dix jours, au detriment de tous les autres. Et
// comme le tri est received_at desc, les avis entrants passent devant
// l'historique — celui-ci n'aurait jamais ete servi des que le flux approche
// 20/jour. A l'heure, le debit monte a 480/jour au meme cout unitaire, la file
// etant persistante et le traitement idempotent.
const PERIODE_MS = 60 * 60 * 1000
const LOT_MAX    = 20        // avis par passage : rien ici n'est urgent
const BUDGET_MS  = 15000     // part du cycle de 60 s que cette etape s'autorise
const MODELE     = 'claude-haiku-4-5-20251001'

const VERDICTS = new Set(['rien_signale', 'remarque', 'positif'])

// ─── Etage 1 : la regle ─────────────────────────────────────────────────────

// ⚠ LA POLARITE SE LIT DANS LE TAG, ELLE NE SE DEVINE PAS.
//
// Les tags Airbnb portent leur polarite en clair : `..._positive_...` ou
// `..._negative_...`. Une premiere version l'ignorait et deduisait la polarite
// de la racine lexicale — avec deux consequences fausses, verifiees :
//   - `..._positive_stainless_steel_appliances` contient "stain" -> classe
//     REMARQUE. Un tag elogieux devenait un reproche de proprete adresse au
//     prestataire, sans extrait pour le verifier (l'etage 1 n'en pose jamais).
//   - `..._negative_cleanliness_other` n'etait pas reconnu comme negatif ; sans
//     texte a analyser, l'avis finissait classe `rien_signale` alors que le
//     voyageur avait explicitement signale un probleme de proprete.
//
// On lit donc d'abord la polarite, ensuite le sujet.
const POLARITE_POSITIVE = /_positive_/i
const POLARITE_NEGATIVE = /_negative_/i

// Sujet "proprete". Racines ancrees par `_` des deux cotes pour ne pas attraper
// un mot qui les contient (stainless, smelling, moldings...).
const SUJET_PROPRETE = /(^|_)(squeaky_clean|pristine|spotless|free_of_clutter|clean|cleanliness|dirty|unclean|stain|stains|dust|dusty|grime|grimy|mold|smell|smells)(_|$)/i

// `cleanliness_other` sans polarite dit "proprete" sans dire quoi : il ne
// tranche RIEN et envoie a l'etage 2 pour que le texte decide.
const TAG_AMBIGU = /(^|_)cleanliness_other(_|$)/i

function estTagProprete (tag) { return SUJET_PROPRETE.test(tag) }

// ⚠ ASYMETRIE ASSUMEE ENTRE OTA — ne pas "harmoniser".
// Le seuil de note ne s'applique qu'a Airbnb, dont l'echelle sur 10 est connue
// et coherente. Chez Booking, la sonde du 2 septembre 2026 a montre des echelles
// qui ne coincident pas : un overall_score de 1 avec toutes les categories a
// 2.5, un overall de 10 avec toutes les categories a 7.5. Comme on stocke brut
// sans normaliser (c'est voulu, cf. docs/kb/avis-voyageurs.md), un seuil sur ces
// valeurs serait un pari, pas une regle. Les avis Booking sans tag partent donc
// directement a l'etage 2 : le TEXTE tranche.
const SEUIL_NOTE_AIRBNB = 6

// Renvoie { verdict, raison } quand la regle tranche, sinon null.
function classerParRegle (avis) {
  const tags = Array.isArray(avis?.tags) ? avis.tags.map(String) : []
  const proprete = tags.filter(estTagProprete)

  // Un negatif l'emporte : un avis peut saluer la salle de bain et signaler une
  // literie sale. C'est la remarque qui interesse le prestataire.
  if (proprete.some(t => POLARITE_NEGATIVE.test(t))) {
    return { verdict: 'remarque', raison: 'tag_negatif' }
  }
  // Ambigu AVANT positif : `cleanliness_other` sans polarite ne dit pas si
  // c'est un compliment ou un reproche.
  if (proprete.some(t => TAG_AMBIGU.test(t) && !POLARITE_POSITIVE.test(t))) return null

  if (proprete.some(t => POLARITE_POSITIVE.test(t))) {
    return { verdict: 'positif', raison: 'tag_positif' }
  }
  // Tag de proprete sans polarite lisible : on ne devine pas, le texte tranchera.
  if (proprete.length) return null

  if (avis?.ota === 'airbnb' && avis.score_clean != null && Number(avis.score_clean) <= SEUIL_NOTE_AIRBNB) {
    return { verdict: 'remarque', raison: 'note_basse' }
  }

  return null
}

// Le texte du VOYAGEUR, seul objet de l'analyse. La reponse de l'hote n'en fait
// pas partie : elle ne change pas ce que le voyageur a dit de la proprete.
//
// ⚠ CHOIX ASSUME : le retour PRIVE (private_feedback Airbnb) est inclus. C'est
// la qu'un defaut de proprete se dit le plus souvent — l'unique remarque des 70
// premiers avis en venait, sur un avis public elogieux note 10/10. Consequence a
// connaitre : un extrait cite sur la fiche prestataire peut provenir d'un
// message que le voyageur croyait reserve a l'hote. Si cela devait changer, le
// filtre se pose ICI, pas dans le prompt.
function texteVoyageur (avis) {
  // Dedoublonne : `content_public` retombe sur `content` quand l'OTA ne fournit
  // pas de champ dedie, donc les deux portent souvent la MEME phrase. L'envoyer
  // deux fois gonfle le prompt et donne au modele une repetition qu'il peut lire
  // comme une insistance.
  const morceaux = [avis?.content_public, avis?.content_private, avis?.content]
    .filter(v => v && String(v).trim())
    .map(v => String(v).trim())
  return [...new Set(morceaux)].join('\n').trim()
}

// ─── Etage 2 : Haiku ────────────────────────────────────────────────────────

function construirePrompt (texte) {
  return `Tu analyses UN avis de voyageur sur un logement de location courte duree.
Question unique : le voyageur parle-t-il de la PROPRETE du logement ?

Reponds en JSON strict, sans texte autour :
{"verdict":"rien_signale"|"remarque"|"positif","extrait":"<citation exacte ou null>"}

- "positif"      : le voyageur salue la proprete du logement.
- "remarque"     : le voyageur signale un defaut de proprete, meme leger,
                   meme noye dans un avis globalement bon.
- "rien_signale" : la proprete n'est pas evoquee. C'est le cas le PLUS
                   FREQUENT et la bonne reponse par defaut.

Regles :
- "extrait" est une CITATION MOT POUR MOT tiree de l'avis, jamais reformulee.
  null si verdict = rien_signale.
- Ne juge QUE la proprete. Le bruit, l'emplacement, l'accueil, le rapport
  qualite-prix, l'equipement ne sont pas de la proprete.
- Un logement "parfait" ou "super" sans mention de proprete = rien_signale.
  N'infere jamais la proprete d'une appreciation generale.
- Le linge, la literie, la salle de bain et la cuisine comptent comme proprete.
  L'usure, la vetuste et un equipement manquant n'en sont pas.

Avis : """${texte}"""`
}

// Valide la reponse du modele. Un LLM peut renvoyer n'importe quoi : rien n'est
// ecrit en base sans passer par ici.
function lireReponse (brut, texte) {
  let json
  try {
    const propre = String(brut || '').replace(/```json|```/g, '').trim()
    json = JSON.parse(propre)
  } catch { return null }

  const verdict = String(json?.verdict || '').trim()
  if (!VERDICTS.has(verdict)) return null

  let extrait = json?.extrait
  if (extrait != null && typeof extrait !== 'string') extrait = null
  if (typeof extrait === 'string') {
    extrait = extrait.trim()
    if (!extrait) extrait = null
  }

  // L'extrait doit etre une citation REELLE. Un modele qui reformule produirait
  // une phrase que le voyageur n'a jamais ecrite, affichee telle quelle au
  // prestataire. On ne garde que ce qu'on retrouve dans le texte.
  if (extrait && !texte.includes(extrait)) extrait = null
  // Pas de proprete evoquee : pas d'extrait, quoi qu'en dise le modele.
  if (verdict === 'rien_signale') extrait = null

  return { verdict, extrait }
}

async function classerParIA (texte, deps = {}) {
  const client = deps.anthropic || anthropic
  const reponse = await client.messages.create({
    model: MODELE,
    max_tokens: 200,
    messages: [{ role: 'user', content: construirePrompt(texte) }]
  })
  return lireReponse(reponse?.content?.[0]?.text, texte)
}

// ─── Passage ────────────────────────────────────────────────────────────────

async function classerAvis (results, deps = {}) {
  const sb = deps.supabase || supabase
  const maintenant = deps.now || (() => Date.now())

  if (!deps.forcer) {
    const { data: marker } = await sb
      .from('cron_logs').select('last_run').eq('id', MARQUEUR).maybeSingle()
    if (marker?.last_run && (maintenant() - new Date(marker.last_run).getTime()) < PERIODE_MS) {
      return { skipped: 'cadence' }
    }
  }

  // Marqueur pose AVANT le travail, meme raison que le poll : une invocation
  // tuee par le plafond de 60 s ne doit pas relancer cette etape a chaque tick
  // de 5 min. Le reliquat part au passage suivant, la file etant persistante
  // (ai_analyzed_at is null).
  const { error: errMarqueur } = await sb.from('cron_logs').upsert({
    id: MARQUEUR, last_run: new Date(maintenant()).toISOString(),
    total_messages: 0, total_replies: 0, errors: []
  }, { onConflict: 'id' })
  if (errMarqueur) {
    console.error('[reviews-classify] marqueur NON ecrit:', errMarqueur.message)
    results?.errors?.push({ context: 'reviews_classify', error: 'marqueur: ' + errMarqueur.message })
    return { skipped: 'marqueur_illisible' }
  }

  const echeance = maintenant() + BUDGET_MS
  const bilan = { lus: 0, regle: 0, ia: 0, sans_texte: 0, erreurs: 0,
                  positif: 0, remarque: 0, rien_signale: 0 }

  // File d'attente : l'index partiel ota_reviews_a_analyser_idx existe pour ca.
  const { data: file, error } = await sb
    .from('ota_reviews')
    .select('id, user_id, ota, tags, score_clean, content, content_public, content_private')
    .is('ai_analyzed_at', null)
    // nullsFirst: false — `received_at` est nullable, et PostgreSQL trie
    // DESC en NULLS FIRST par defaut : un avis sans date resterait en tete de
    // file a chaque passage. Combine a un echec permanent, il monopoliserait le
    // premier slot indefiniment ; vingt suffiraient a bloquer toute la file.
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(LOT_MAX)
  if (error) {
    console.error('[reviews-classify] lecture de la file echec:', error.message)
    results?.errors?.push({ context: 'reviews_classify', error: error.message })
    return { ...bilan, interrompu: 'db' }
  }
  if (!file || !file.length) return bilan

  for (const avis of file) {
    if (maintenant() > echeance) { bilan.interrompu = 'budget'; break }
    bilan.lus++

    let resultat = null
    const regle = classerParRegle(avis)

    if (regle) {
      resultat = { verdict: regle.verdict, extrait: null }
      bilan.regle++
    } else {
      const texte = texteVoyageur(avis)
      if (!texte) {
        // Ni tag exploitable ni texte : il n'y a rien a analyser, et c'est une
        // reponse, pas un echec. Sans cela l'avis reviendrait dans la file a
        // chaque passage, indefiniment.
        resultat = { verdict: 'rien_signale', extrait: null }
        bilan.sans_texte++
      } else {
        try {
          resultat = await classerParIA(texte, deps)
          if (resultat) bilan.ia++
        } catch (e) {
          console.error('[reviews-classify] appel IA echec:', e.message)
          resultat = null
        }
      }
    }

    if (!resultat) {
      // Non classe : on NE POSE PAS ai_analyzed_at, l'avis repassera. Le poser
      // sur un echec le sortirait de la file pour toujours.
      bilan.erreurs++
      continue
    }

    // ⚠ Filtre sur user_id en plus de l'id : REVIEW.md regle 1 vaut aussi pour
    // les updates d'un traitement multi-comptes.
    const { error: e } = await sb.from('ota_reviews').update({
      ai_clean_verdict: resultat.verdict,
      ai_clean_excerpt: resultat.extrait,
      ai_analyzed_at:   new Date(maintenant()).toISOString()
    }).eq('id', avis.id).eq('user_id', avis.user_id)

    if (e) { bilan.erreurs++; console.error('[reviews-classify] update echec:', e.message) }
    else bilan[resultat.verdict]++
  }

  if (bilan.erreurs > 0) {
    // Un avis en echec n'est pas marque, donc il repasse — c'est voulu. Mais un
    // echec PERMANENT (cle d'API expiree, texte que le modele refuse) serait
    // alors rejoue chaque jour, sans fin et sans que personne ne le voie : le
    // cycle afficherait un bilan sans erreur. On le fait remonter.
    console.error('[reviews-classify] avis non classes:', bilan.erreurs)
    results?.errors?.push({ context: 'reviews_classify',
                            error: bilan.erreurs + ' avis non classes (seront rejoues)' })
  }
  if (bilan.lus > 0) console.log('[reviews-classify] bilan', JSON.stringify(bilan))
  if (results) results.totalReviewsClassified = (results.totalReviewsClassified || 0) + bilan.ia + bilan.regle
  return bilan
}

module.exports = {
  classerAvis,
  // exportes pour les tests
  classerParRegle,
  estTagProprete,
  texteVoyageur,
  lireReponse,
  construirePrompt
}
