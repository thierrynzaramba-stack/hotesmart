const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')
const { envelopper } = require('./ia/journal')
const { compterAppelExterne } = require('./metriques-cron')

// ─── Clients partagés ─────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const anthropicBrut = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY })

// ⚠ UNE PANNE DE FACTURATION NE DOIT PLUS ETRE SILENCIEUSE.
// Vecu du 8 septembre 2026 : credit Anthropic epuise, TOUTE l'IA du produit
// arretee (classification, reponses suggerees, agent, extraction KB), et rien
// ne le disait — l'erreur ne vivait que dans `cron_logs.errors`, un champ que
// personne ne regarde.
//
// ⚠ ET AUCUN APPEL N'ECHAPPE AU JOURNAL (spec-journal-ia, 9 octobre 2026) :
// chaque appel ecrit sa ligne dans `ia_appels` (fonction, compte, bien,
// tokens, cout). C'est LE client Anthropic du produit — api/grok.js et
// api/extract-kb.js passent par lui ; tests/ia-journal-garde.test.js refuse
// tout autre `new Anthropic`.
//
// On enveloppe `messages.create` plutot que d'aller modifier chaque appelant :
// un point unique ne peut pas etre oublie par le prochain appel qu'on ecrira.
// L'erreur est RELANCEE telle quelle (lib/ia/journal.js, `envelopper`) — cette
// enveloppe observe, elle n'avale rien.
//
// ⚠ ET CHAQUE APPEL SE COMPTE DANS LA MESURE DU PASSAGE (22 octobre 2026).
// C'est le SEUL chemin : le SDK capture `fetch` a la construction, donc
// l'interception globale du compteur ne le voit pas. Hors passage de cron,
// `compterAppelExterne` est un no-op.
const anthropic = envelopper(anthropicBrut, {
  sb: supabase,
  surErreur: (e) => require('./incident-facturation').signalerSiPanneFacturation('Anthropic (IA)', e),
  surAppel: () => compterAppelExterne('haiku'),
})

// ─── Signature GuestFlow AI ──────────────────────────────────────────────────
// Mécanisme viral du plan GRATUIT uniquement : un abonnement guestflow actif
// (trialing / active / past_due) supprime la signature.
const GUESTFLOW_SIGNATURE = '\n\n— propulsé par GuestFlow'

// ─── Flag d'activation production sendViaBeds24 ──────────────────────────────
// Permet de basculer en prod via variable Vercel sans redéployer le code.
// false = mode "safety" : on log ce qu'on aurait envoyé mais on n'envoie pas.
// true  = envoi réel au voyageur via Beds24.
const SENDVIABEDS24_ENABLED = process.env.SENDVIABEDS24_ENABLED === 'true'

// ─── Abonnement actif ? ──────────────────────────────────────────────────────
// Même logique que la sidebar : module guestflow, status trialing/active/past_due.
// Cache mémoire 5 min (durée de vie d'une invocation cron) pour éviter une
// requête par message envoyé.
const _subCache = new Map() // userId -> { value, expires }

async function hasActiveSubscription(userId) {
  if (!userId) return false
  const cached = _subCache.get(userId)
  if (cached && cached.expires > Date.now()) return cached.value

  let value = false
  try {
    const { data } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', userId)
      .eq('module', 'guestflow')
      .maybeSingle()
    value = !!data && ['trialing', 'active', 'past_due'].includes(data.status)
  } catch {
    value = false
  }
  _subCache.set(userId, { value, expires: Date.now() + 5 * 60 * 1000 })
  return value
}

// ─── Signature à apposer pour une clé Beds24 donnée ──────────────────────────
// Résout l'utilisateur depuis api_keys.api_key puis vérifie son abonnement.
// Renvoie '' (abonné) ou GUESTFLOW_SIGNATURE (plan gratuit / clé inconnue).
const _keyUserCache = new Map() // beds24Key -> { userId, expires }

async function getSignatureForKey(beds24Key) {
  if (!beds24Key) return GUESTFLOW_SIGNATURE
  try {
    let userId = null
    const cached = _keyUserCache.get(beds24Key)
    if (cached && cached.expires > Date.now()) {
      userId = cached.userId
    } else {
      const { data } = await supabase
        .from('api_keys')
        .select('user_id')
        .eq('api_key', beds24Key)
        .maybeSingle()
      userId = data?.user_id || null
      _keyUserCache.set(beds24Key, { userId, expires: Date.now() + 5 * 60 * 1000 })
    }
    if (!userId) return GUESTFLOW_SIGNATURE
    return (await hasActiveSubscription(userId)) ? '' : GUESTFLOW_SIGNATURE
  } catch {
    return GUESTFLOW_SIGNATURE
  }
}

// ⚠ LE CONTRAT DES DELAIS EST PARTAGE, PLUS RECOPIE (constat de la seconde
// revue du 27 octobre 2026) : la borne 0..1440 etait ecrite ici a la main ET
// dans /api/agent-config. Une derive entre les deux aurait rendu « hors
// contrat » a la lecture une valeur acceptee et stockee par l'ecriture.
const { minutesValides, formeExploitable } = require('./guestflow/delais-contrat')

// ─── Lecture des reglages GuestFlow d'un logement ────────────────────────────
// Chantier « delai de reponse IA », lot 1. Spec : docs/specs/spec-delai-reponse-ia.md
//
// ⚠ UNE SEULE LECTURE POUR LES DEUX USAGES. `getPropertyMode` ci-dessous en
// DERIVE le binaire test/auto ; le lot 2 lira le delai par la meme fonction.
// Deux fonctions qui liraient le blob separement feraient deux requetes par
// bien et par passe, sur un chemin qui en fait deja une de trop (voir la note
// de scalabilite sous `getPropertyMode`).
//
// Rend toujours un objet : `{ mode, delais }`, `delais` a `null` quand le bien
// n'en a pas. Une panne de lecture rend `{ mode: 'test', delais: null }` — le
// repli le plus SUR : validation manuelle, donc rien ne part tout seul.
async function lireReglagesDuBien (userId, propertyId) {
  try {
    const { data } = await supabase
      .from('agent_alert_config')
      .select('config')
      .eq('user_id', userId)
      .single()
    const entree = data?.config?.[propertyId] || null
    return {
      mode: entree?.mode || 'test',
      // ⚠ `formeExploitable` exclut le TABLEAU : `typeof [] === 'object'`. Un
      // `delais: []` retomberait sur `mode` (un tableau n'a pas `reponse_ia`),
      // donc sans degat — on le ferme quand meme ICI, parce que c'est le seul
      // endroit que tous les lecteurs traversent, et parce que le serveur
      // lui-meme etalait un tel bloc en l'alignant (constat 4 de la seconde
      // revue).
      delais: formeExploitable(entree && entree.delais) ? entree.delais : null
    }
  } catch {
    return { mode: 'test', delais: null }
  }
}

// ─── Lecture mode test/auto par logement ─────────────────────────────────────
// ⚠ LA SIGNATURE ET LE CONTRAT NE CHANGENT PAS (decision de Thierry du
// 27 octobre 2026) : trois des quatre appelants — les modeles programmes
// (lib/cron-messages.js x2) et le code d'acces (lib/cron-arrival-code.js) —
// restent binaires et ne changent pas d'une ligne. Seule la REPONSE IA
// (lib/cron-classify.js) apprendra le delai, au lot 2.
//
// Ce que cette fonction fait de neuf : quand le bien porte un bloc `delais`,
// elle en DERIVE le binaire au lieu de lire `mode`.
//
//   delais.reponse_ia === null   -> 'test'  (Validation manuelle)
//   delais.reponse_ia  = 0 ou N  -> 'auto'  (ca part : tout de suite, ou dans N)
//
// Pour un modele programme, « auto » garde donc exactement son sens d'avant :
// il part sans validation. Un delai de reponse IA ne retarde PAS un modele
// programme — ils partent a leur heure (spec §4.0).
//
// ⚠ ET LE REPLI SUR `mode` RESTE, le temps de la bascule (spec §6) : un bien
// qui n'a pas encore de bloc `delais` se lit comme avant. La cle `mode` ne
// disparait qu'au lot 4, une fois les deux chemins prouves d'accord.
//
// ⚠ DETTE CONNUE, NI CREEE NI AGGRAVEE ICI : une requete par bien et par
// passe, alors que le blob est unique par COMPTE. Inoffensif a quatre biens,
// condamne a 30 000 comptes (spec §11).
async function getPropertyMode(userId, propertyId) {
  const { mode, delais } = await lireReglagesDuBien(userId, propertyId)
  const d = delais && 'reponse_ia' in delais ? delais.reponse_ia : undefined
  if (d === undefined) return mode
  // Validation manuelle.
  if (d === null) return 'test'
  // ⚠ LA VALIDATION EST AU POINT DE LECTURE, ET C'EST UN CONSTAT GRAVE DE LA
  // REVUE DU 27 OCTOBRE 2026. Cette fonction rendait `'auto'` pour TOUTE valeur
  // non nulle — donc `"15"`, `15.5`, `99999`, `{}` rendaient « ca part tout
  // seul », le sens NON sur, et debloquaient aussi les modeles programmes et le
  // code d'acces.
  //
  // ⚠ ET LE MOTIF QUE J'AVAIS ECRIT ICI ETAIT FAUX (seconde revue du meme
  // jour). Il affirmait que le POST legacy « n'appelle pas `delaisPropres` » et
  // qu'il est « le writer des defauts 15/15 des biens neufs ». Les deux sont
  // dementis par le code du meme lot : `CLES_RESERVEES_AUX_CIBLES` ecarte
  // `delais` de TOUTE charge legacy, et `seedAlertConfig` n'ecrit ni `delais`
  // ni 15/15. Une affirmation dans un commentaire se lit comme une mesure et ne
  // rougit jamais : dans six mois, celle-la aurait envoye quelqu'un chercher un
  // writer qui n'existe pas.
  //
  // LE MOTIF REEL, ET IL SUFFIT : cette fonction est le point de passage de
  // TOUS les lecteurs, et le blob est une colonne JSONB qu'aucune contrainte de
  // base ne borne. Un script, une migration, une correction manuelle en console
  // Supabase, ou un writer futur peuvent y poser n'importe quelle forme sans
  // croiser l'endpoint. Une garde a la LECTURE ne depend d'aucun inventaire des
  // ecrivains — et c'est ce qui la rend vraie quand l'inventaire change.
  //
  // Une valeur hors contrat n'est pas une permission : on retombe sur `mode`,
  // et on le DIT.
  if (minutesValides(d)) return 'auto'
  console.error(`[cron-shared] delais.reponse_ia hors contrat pour le bien ${propertyId} `
    + `(${JSON.stringify(d)}) — repli sur mode=${mode}`)
  return mode
}

// ─── Kill switch par bien (arret d'urgence de TOUT l'automatique) ─────────────
// Lu sur properties.automation_paused, keye par provider_property_id (fonctionne
// pour Channex et pour Beds24 materialise). Defaut = false : en cas d'absence de
// ligne ou d'erreur, on NE gele PAS par accident (la synchro reste prioritaire).
async function isAutomationPaused(userId, providerPropertyId) {
  try {
    const { data } = await supabase
      .from('properties')
      .select('automation_paused')
      .eq('user_id', userId)
      .eq('provider_property_id', String(providerPropertyId))
      .limit(1)
    return data && data[0]?.automation_paused === true
  } catch {
    return false
  }
}

// ─── Helpers format ──────────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  })
}

function parseDelay(value) {
  if (!value) return 0
  const map = {
    '5min': 5, '15min': 15, '30min': 30,
    '1h': 60, '2h': 120, '4h': 240, '8h': 480,
    '24h': 1440, '0min': 0
  }
  return map[value] || 0
}

// ⚠ LE FUSEAU DU RUNTIME EST DIT UNE FOIS PAR DEMARRAGE A FROID, ET C'EST UNE
// DETTE DE DIAGNOSTIC QU'ON SOLDE. Le 14 septembre 2026, un instant sans fuseau
// lu en heure locale a duplique 83 messages. Toute la hierarchie de gravite de
// cette famille de defauts depend d'une seule inconnue — le fuseau ou tourne
// reellement le cron — et elle a ete posee en HYPOTHESE faute de pouvoir la
// mesurer. Une ligne de log au demarrage la transforme en fait.
//
// Cout : une ligne par instance froide, jamais dans la boucle.
console.log('[cron-shared] runtime TZ =', Intl.DateTimeFormat().resolvedOptions().timeZone,
  '| decalage =', -new Date().getTimezoneOffset() / 60, 'h',
  '| temoin nu =', new Date('2026-07-22T15:50:10').toISOString())

module.exports = {
  supabase,
  anthropic,
  GUESTFLOW_SIGNATURE,
  SENDVIABEDS24_ENABLED,
  hasActiveSubscription,
  getSignatureForKey,
  getPropertyMode,
  lireReglagesDuBien,
  isAutomationPaused,
  formatDate,
  parseDelay
}
