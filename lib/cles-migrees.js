// lib/cles-migrees.js
// Les cles provider ABANDONNEES par une migration : plus jamais synchronisees.
//
// ⚠ LE REPLI EST FERME. DECISION DE THIERRY, 14 SEPTEMBRE 2026.
// Ce module retombait OUVERT quand la table est illisible : « au pire un
// message renvoye a un voyageur ». Deux mesures ont montre que c'etait faux.
//
//   12 septembre — `materializeBeds24Properties` passait aussi et RECREAIT les
//   fiches migrees avec un `active_at` neuf (03:00:58 et 06:00:39, deux cycles
//   isoles sur une centaine) : la facturation est passee de 2 a 4 biens. Le
//   repli a alors ete ferme LA seulement, parce que l'argent etait en jeu.
//
//   14 septembre — le vrai prix du repli ouvert ailleurs. La cle `169567`
//   (Cœur de vie l 23) est repartie sous son ancienne cle Beds24 lors de trois
//   cycles isoles (12/09 14:15, 13/09 16:01, 14/09 05:00) : 82 sejours ont
//   quitte la fiche Channex, et cinq minutes plus tard le writer des menages,
//   ne les voyant plus vivants, a ANNULE SEIZE MENAGES d'un coup — dont celui
//   du depart du samedi. Rouvrir une cle abandonnee n'est pas reversible : ca
//   coupe le coeur en deux, et les consommateurs en aval agissent sur la
//   moitie qu'ils voient.
//
// LA REGLE EST DONC : si on ne peut pas lire les cles migrees, ON NE TRAITE PAS
// LE BIEN, et on leve un incident. Un bien non synchronise pendant un cycle ne
// coute rien — le suivant le rattrape. Un bien dont la cle se rouvre, si.
//
// ⚠ CE QUE CE CHOIX COUTE, ET POURQUOI IL EST ASSUME. Une table illisible
// arrete desormais la synchro de TOUS les biens de TOUS les hotes, pour une
// table vide chez 99 % des comptes. C'etait l'argument du repli ouvert, et il
// reste vrai. Mais une synchro en pause se rattrape toute seule au cycle
// suivant et se VOIT (incident `cles_migrees_illisible`), alors qu'une cle
// rouverte ne se voit pas et detruit du travail deja fait.
//
// ⚠ ET L'INCIDENT EST LE POINT. Pendant quatre jours l'echec n'a existe que
// dans un `console.error` — donc dans des logs Vercel ephemeres, donc nulle
// part. C'est la lecon deja payee (« erreur avalee, cron a 200 ») : on ne
// diagnostique pas ce qui n'a pas ete ecrit quelque part de durable.
//
// ⚠ LE DEFAUT QUE CE MODULE FERME, MESURE LE 10 SEPTEMBRE 2026.
// Apres le transfert de Cœur de vie « La bulle » vers sa fiche Channex
// (2 645 lignes deplacees, 0 restante, verifie), la fiche Beds24 s'est
// RECREEE toute seule sous un nouvel uuid, et 106 sejours sont repartis sous
// l'ancienne cle `209413`. Ecritures horodatees a la minute, apres le
// transfert.
//
// LA CAUSE : `api/cron.js` fait `fetchProperties(beds24Key)` — la liste LIVE
// des biens du compte Beds24 — puis boucle dessus. Le bien migre y est
// toujours (decision de Thierry : il RESTE dans le compte Beds24, c'est le
// filet de rollback tant qu'aucune resa reelle n'a traverse la chaine Channex
// de bout en bout). Le cron le materialise donc, resynchronise ses sejours…
// et LUI ENVOIE DES MESSAGES.
//
// ⚠ CE DERNIER POINT EST LE PLUS GRAVE, ET C'EST POURQUOI LA GARDE NE PEUT PAS
// SE LIMITER A LA MATERIALISATION. `processMessageTemplates` tourne dans la
// meme boucle : un bien migre continuerait a declencher des envois depuis le
// cote Beds24 — exactement ce que Thierry a grave (« il ne faut pas envoyer
// des messages deja envoyes au voyageur »). Supprimer la fiche ne protege
// rien : la boucle ne lit pas `properties`, elle lit Beds24.
//
// ⚠ `automation_paused` NE SUFFIT PAS NON PLUS : la pause coupe le voyageur,
// jamais la synchro provider. Choix assume du kill switch, pas un oubli.
//
// ⚠ POURQUOI UNE TABLE ET PAS `rekeying_backup`. La sauvegarde porte bien la
// cle source, mais PAS de `user_id` — et `provider_property_id` n'a AUCUNE
// unicite globale : deux hotes d'un meme property manager Beds24 partagent
// l'espace de numerotation (documente dans lib/cron-access.js). Filtrer sur la
// seule cle aurait coupe la synchro du bien `209413` d'un AUTRE hote le jour ou
// celui-ci migre le sien. La table est cloisonnee par compte, et c'est le
// point.

// ⚠ MEMOIRE COURTE, ET BORNEE. Sans elle, chaque garde relit la table pour
// chaque bien : trois lectures par bien et par cycle. La table est
// normalement vide ou minuscule, mais un compte a 50 biens ferait 150 allers-
// retours toutes les cinq minutes pour rien. 60 s couvre un cycle de cron sans
// jamais garder une decision d'un cycle a l'autre.
const CACHE_MS = 60 * 1000
// ⚠ ET UN CACHE COURT SUR L'ECHEC, RELEVE EN REVIEW.
// Ne rien mettre en cache sur le chemin d'erreur reintroduisait exactement la
// charge que le cache existe pour eviter : table illisible = 4 lectures par
// bien et par cycle, toutes en echec, dans une fonction plafonnee a 60 s. Et
// une table illisible arrive typiquement quand la base est deja sous tension :
// le cycle pouvait etre tue AVANT les codes d'arrivee et les messages. Cinq
// secondes suffisent a couvrir un cycle sans jamais figer une decision.
const CACHE_ECHEC_MS = 5 * 1000
const cache = new Map()   // `${userId}|${provider}` -> { at, cles: Set, echec?: true }

// ⚠ LE DEBIT DE L'INCIDENT EST BORNE, ET C'EST UN CORRECTIF DE REVIEW.
// Le cache d'echec ne dure que 5 s : une panne franche produisait jusqu'a une
// douzaine d'incidents par compte et par cycle, chacun etant un INSERT puis un
// SELECT sur la base qui vient justement d'echouer. Le remede ajoutait de la
// charge au malade. Un incident toutes les dix minutes dit la meme chose : la
// panne est en cours, et elle est datee.
const INCIDENT_MS = 10 * 60 * 1000
const dernierIncident = new Map()   // `${userId}|${provider}` -> horodatage

function _vider () { cache.clear() }   // tests uniquement

// Rend l'ensemble des `provider_property_id` migres de ce compte pour ce
// provider. En cas d'echec de lecture, rend un ensemble VIDE — voir plus bas.
async function clesMigrees (supabase, userId, provider = 'beds24') {
  if (!supabase || !userId) return new Set()
  const cle = `${userId}|${provider}`
  const vu = cache.get(cle)
  if (vu && (Date.now() - vu.at) < (vu.echec ? CACHE_ECHEC_MS : CACHE_MS)) return vu.cles

  const { data, error } = await supabase
    .from('provider_keys_migrated')
    .select('provider_property_id')
    .eq('user_id', userId)
    .eq('provider', provider)

  if (error) {
    // ⚠ ON RETOMBE FERME (voir l'en-tete). L'ensemble rendu reste VIDE — il ne
    // faut pas inventer des cles migrees — mais il porte `lectureEnEchec`, et
    // c'est ce drapeau qui fait refuser le traitement chez l'appelant.
    console.error('[cles-migrees] LECTURE IMPOSSIBLE, aucun bien traite ce cycle :', error.message)
    // ⚠ TRACE DURABLE, PAS UN LOG. Un incident survit au cycle et se relit :
    // c'est lui qui nommera la cause (timeout, pooler, schema cache) la
    // prochaine fois. Une panne de l'alerte ne doit pas devenir une panne de la
    // garde : elle est donc attrapee, jamais relancee.
    //
    // ⚠ ET IL EST ATTENDU (`await`), CORRECTIF DE REVIEW. Une promesse
    // flottante est perdue quand Vercel gele l'instance juste apres la reponse —
    // exactement sur les chemins HTTP, ou cette trace remplace un `console.error`
    // qu'on a deja juge insuffisant. Attendre coute une requete, sur un chemin
    // qui est deja en panne et qui se produit trois fois en quatre jours.
    const cleIncident = `${userId}|${provider}`
    const vuIncident = dernierIncident.get(cleIncident) || 0
    if (Date.now() - vuIncident >= INCIDENT_MS) {
      dernierIncident.set(cleIncident, Date.now())
      try {
        const { reportIncident } = require('./founder-notify')
        await reportIncident('cles_migrees_illisible', {
          userId,
          detail: { provider, message: error.message, code: error.code || null }
        })
      } catch (e) {
        console.error('[cles-migrees] incident non enregistre :', e.message)
      }
    }
    const vide = new Set()
    // ⚠ L'ECHEC EST MARQUE SUR L'ENSEMBLE LUI-MEME.
    // Sans ce drapeau, « la lecture a echoue » et « aucune cle migree » sont
    // indiscernables pour l'appelant — les deux donnent un ensemble vide.
    //
    // ⚠ CE PARAGRAPHE DISAIT L'INVERSE JUSQU'AU 14 SEPTEMBRE 2026 : « les
    // appelants dont l'action est reversible peuvent l'ignorer ». Plus aucun ne
    // le peut. Tout appelant s'abstient (`motifNonSync` -> 'illisible'), et
    // celui dont l'action DETRUIT quelque chose — `scripts/supprimer-residu-beds24.js`,
    // ou « migre » autorise une suppression — doit exiger le fait 'migree', pas
    // une valeur de verite.
    Object.defineProperty(vide, 'lectureEnEchec', { value: true, enumerable: false })
    cache.set(cle, { at: Date.now(), cles: vide, echec: true })
    return vide
  }

  const cles = new Set((data || []).map(x => String(x.provider_property_id)))
  cache.set(cle, { at: Date.now(), cles })
  return cles
}

// POURQUOI CE BIEN NE DOIT PAS ETRE TRAITE — ou `null` s'il peut l'etre.
//   'migree'    : la cle est abandonnee, on n'y touche plus jamais.
//   'illisible' : la garde est AVEUGLE, on s'abstient par precaution.
// Les deux arretent le traitement, mais ce ne sont pas les memes faits, et un
// appelant qui les confond ecrit un message faux dans le journal — la lecon de
// `cron-beds24-props` (« trois cas, et il faut les distinguer »).
async function motifNonSync (supabase, userId, propId, provider = 'beds24') {
  // ⚠ ON CONSULTE AVANT DE SORTIR SUR `propId` NUL — CORRECTIF DE REVIEW.
  // Ma premiere version sortait `null` (« traite-le ») sans meme lire la table :
  // une garde aveugle passait donc inapercue, et sans incident, des qu'un
  // appelant ne savait pas nommer son bien. « Je ne sais pas quel bien » et
  // « je ne sais pas si ce bien est migre » sont deux ignorances, pas une
  // permission.
  const cles = await clesMigrees(supabase, userId, provider)
  if (cles.lectureEnEchec) return 'illisible'
  if (propId == null) return null
  return cles.has(String(propId)) ? 'migree' : null
}

// Ce bien doit-il etre laisse tranquille ? `propId` est la cle du provider (TEXT).
// ⚠ REND `true` AUSSI QUAND LA GARDE EST AVEUGLE. C'est le repli ferme : un
// appelant qui ne connait que cette fonction est protege par defaut, sans avoir
// a penser au cas. Qui a besoin de distinguer les deux causes appelle
// `motifNonSync`.
async function estCleMigree (supabase, userId, propId, provider = 'beds24') {
  return (await motifNonSync(supabase, userId, propId, provider)) !== null
}

// Enregistre une cle comme migree. Idempotent (cle primaire composite).
async function noterCleMigree (supabase, { userId, provider, propId, cibleFiche }) {
  if (!userId || !provider || propId == null) {
    throw new Error('noterCleMigree : userId, provider et propId requis')
  }
  const { error } = await supabase.from('provider_keys_migrated').upsert({
    user_id: userId,
    provider,
    provider_property_id: String(propId),
    target_property_id: cibleFiche || null
  }, { onConflict: 'user_id,provider,provider_property_id' })
  if (error) throw new Error(`noterCleMigree : ${error.message}`)
  cache.delete(`${userId}|${provider}`)
  return true
}

module.exports = { clesMigrees, motifNonSync, estCleMigree, noterCleMigree, _vider }
