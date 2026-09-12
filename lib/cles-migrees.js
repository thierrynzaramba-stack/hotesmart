// lib/cles-migrees.js
// Les cles provider ABANDONNEES par une migration : plus jamais synchronisees.
//
// ⚠ LE REPLI OUVERT N'EST PAS ACCEPTABLE PARTOUT — MESURE DU 12 SEPTEMBRE 2026.
// Ce module retombe OUVERT quand la table est illisible (voir plus bas), et
// l'en-tete affirmait que « le seul degat serait un message renvoye a un
// voyageur ». C'est faux : `materializeBeds24Properties` passait aussi, et
// RECREAIT les fiches migrees avec un `active_at` neuf. Deux fiches Beds24 sont
// ainsi revenues dans la nuit — a 03:00:58 et 06:00:39, deux cycles isoles sur
// une centaine — et la facturation est passee de 2 a 4 biens.
// Le repli ouvert reste le bon choix pour les actions REVERSIBLES ; une action
// a consequence financiere doit, elle, retomber FERMEE. D'ou `lectureEnEchec`.
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
    // ⚠ ON RETOMBE OUVERT, ET C'EST RAISONNE.
    // Fermer sur un echec de lecture arreterait la synchro de TOUS les biens
    // de tous les hotes des que cette table devient illisible — une panne
    // locale deviendrait une panne generale, pour une table qui est vide chez
    // 99 % des comptes.
    // Le risque du repli ouvert est borne : le seul degat serait un message
    // renvoye a un voyageur, et c'est deja couvert par l'empreinte de sejour
    // (`message_sent_log.stay_key`, migration du 10 septembre) qui reconnait
    // un envoi meme sous un nouvel identifiant de reservation.
    // On HURLE, en revanche : ce silence-la est ce qui a laisse le defaut
    // ouvert une journee entiere.
    console.error('[cles-migrees] LECTURE IMPOSSIBLE, on continue sans filtre :', error.message)
    const vide = new Set()
    // ⚠ L'ECHEC EST MARQUE SUR L'ENSEMBLE LUI-MEME.
    // Sans ce drapeau, « la lecture a echoue » et « aucune cle migree » sont
    // indiscernables pour l'appelant — et le repli OUVERT devient invisible.
    // Les appelants dont l'action est reversible (messages, snapshots) peuvent
    // l'ignorer ; ceux dont l'action a une consequence FINANCIERE doivent
    // refuser d'agir. Voir `materializeBeds24Properties`.
    Object.defineProperty(vide, 'lectureEnEchec', { value: true, enumerable: false })
    cache.set(cle, { at: Date.now(), cles: vide, echec: true })
    return vide
  }

  const cles = new Set((data || []).map(x => String(x.provider_property_id)))
  cache.set(cle, { at: Date.now(), cles })
  return cles
}

// Ce bien a-t-il ete migre ? `propId` est la cle du provider (TEXT).
async function estCleMigree (supabase, userId, propId, provider = 'beds24') {
  if (propId == null) return false
  const cles = await clesMigrees(supabase, userId, provider)
  return cles.has(String(propId))
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

module.exports = { clesMigrees, estCleMigree, noterCleMigree, _vider }
