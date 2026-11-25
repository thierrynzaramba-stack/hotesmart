// lib/push/envoyer.js — envoyer une notification push à un appareil abonné.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §9.3-9.4 · KB : docs/kb/pwa.md §8
//
// ⚠ LA BIBLIOTHÈQUE PRÉPARE, `fetch` ENVOIE. `web-push` signe (RFC 8292) et
// chiffre (RFC 8291) par `generateRequestDetails()`, qui n'envoie rien. L'envoi
// passe par `fetch` : c'est ce que compte le compteur de coût du cron
// (docs/kb/cout-du-cron.md §2 — il ne voit que `fetch`). `sendNotification`
// passerait par `https.request`, invisible du compteur.
//
// ⚠ LE MESSAGE EST AU FORMAT DÉCLARATIF (`web_push: 8030`), JAMAIS `mutable`.
// Un iPhone 18.4+ l'affiche lui-même, sans consulter le service worker — donc
// l'adresse ouverte au toucher (`navigate`) est construite ICI, côté serveur,
// en chemin du site, jamais à partir d'une donnée du voyageur.
//
// ⚠ LA CLÉ PRIVÉE NE SORT JAMAIS DE CE MODULE : ni dans un journal, ni dans une
// réponse, ni dans une erreur. On ne journalise que le NOM d'une variable
// manquante.
const webpush = require('web-push')
// Les clés et le contact vivent dans un module sans `web-push` (lot 3) ; ils
// restent exportés d'ici, pour que les appelants du lot 2 ne changent pas.
const { clesVapid, sujetVapid } = require('./cles')

const DELAI_MS = 5000
const TTL_S = 24 * 3600

// Un chemin du site, et rien d'autre : commence par `/`, pas par `//`, sans `\`,
// sans caractère de contrôle ni espace, et RÉSOLU sur une origine témoin pour
// vérifier qu'il y reste. Sinon, l'accueil.
// ⚠ LE CONTRÔLE DE RÉSOLUTION N'EST PAS UNE REDITE (constat de review) :
// « /\t/evil.example » passait les trois premiers tests et se résolvait en
// https://evil.example/ — le parseur d'URL retire tabulations et retours à la
// ligne. Sur iPhone, `navigate` est ouvert sans passer par le service worker.
const TEMOIN = 'https://site.invalid'
function cheminDuSite (chemin) {
  const s = String(chemin == null ? '' : chemin)
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || /[\u0000-\u0020\u007f]/.test(s) || /^\/[^/]*:/.test(s)) return '/dashboard'
  let u
  try { u = new URL(s, TEMOIN) } catch { return '/dashboard' }
  if (u.origin !== TEMOIN) return '/dashboard'
  return (u.pathname + u.search + u.hash).slice(0, 500)
}

function texte (v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
}

// Le message déclaratif. `titre` obligatoire ; `chemin` : où ouvrir au toucher ;
// `sujet` : deux notifications du même sujet se remplacent ; `rappel` : la
// remplaçante sonne quand même (relance de surréservation).
function messageDeclaratif ({ titre, corps = '', chemin = '/dashboard', sujet = null, rappel = false, langue = 'fr' }) {
  const t = texte(titre, 120)
  if (!t) throw new Error('notification sans titre')
  const notification = {
    title: t,
    body: texte(corps, 300),
    navigate: cheminDuSite(chemin),
    lang: ['fr', 'en', 'es'].includes(langue) ? langue : 'fr',
    dir: 'ltr',
    silent: false
  }
  if (sujet) {
    notification.tag = texte(sujet, 64)
    if (rappel) notification.renotify = true
  }
  return { web_push: 8030, notification }
}

// Envoie UN message à UN abonnement. Ne lève jamais : rend
//   { ok: true, statut }                       envoyé
//   { ok: false, mort: true, statut }          404/410 : l'abonnement est à supprimer
//   { ok: false, motif, statut? }              autre échec (réseau, délai, refus)
async function envoyer ({ abonnement, message, cles = clesVapid(), fetch: f = globalThis.fetch, delaiMs = DELAI_MS }) {
  if (!cles) return { ok: false, motif: 'cles_absentes' }
  let details
  try {
    details = webpush.generateRequestDetails(
      { endpoint: abonnement.endpoint, keys: { p256dh: abonnement.cle_p256dh, auth: abonnement.cle_auth } },
      JSON.stringify(message),
      {
        vapidDetails: { subject: cles.sujet, publicKey: cles.publique, privateKey: cles.privee },
        TTL: TTL_S,
        urgency: 'high',
        contentEncoding: 'aes128gcm'
      }
    )
  } catch (e) {
    // Une clé du navigateur illisible, ou une paire VAPID mal formée. Le message
    // d'erreur de la bibliothèque ne contient pas la clé privée, mais on ne le
    // recopie pas pour autant : le motif suffit.
    return { ok: false, motif: 'preparation_impossible' }
  }
  // ⚠ UN MINUTEUR À NOUS, PAS `AbortSignal.timeout()` : le sien est détaché de
  // la boucle d'événements (`unref`), donc une fonction qui n'a plus rien
  // d'autre à attendre peut finir avant lui — et l'envoi resterait suspendu.
  const ctl = new AbortController()
  let depasse = false
  const minuteur = setTimeout(() => { depasse = true; ctl.abort() }, delaiMs)
  let res
  try {
    res = await f(details.endpoint, {
      method: details.method,
      headers: details.headers,
      body: details.body,
      redirect: 'error',
      signal: ctl.signal
    })
  } catch (e) {
    return { ok: false, motif: depasse ? 'delai_depasse' : 'reseau' }
  } finally {
    clearTimeout(minuteur)
  }
  const statut = res.status
  // Le corps de la réponse n'est jamais lu : on l'annule, sinon `fetch` garde
  // la connexion ouverte (sensible au volume du lot 2c).
  try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel() } catch { /* déjà consommé */ }
  if (statut === 404 || statut === 410) return { ok: false, mort: true, statut }
  if (statut >= 200 && statut < 300) return { ok: true, statut }
  return { ok: false, motif: 'refus_service', statut }
}

// ⚠ LE DISJONCTEUR DU CHEMIN PRESTATAIRE (review de l'étape 3 du lot 3,
// constat 2). Un service d'envoi qui ne répond pas coûte 5 s par appel, et ces
// envois partent du cron (60 s pour tout le cycle) et du clic de l'hôte. Après
// un délai dépassé ou une erreur réseau vers un service (son nom d'hôte : Apple,
// Google…), on ne l'appelle plus pendant cinq minutes DANS CETTE INSTANCE : la
// notification compte comme non reçue, donc le SMS part, tout de suite.
const PAUSE_SERVICE_MS = 5 * 60 * 1000
const servicesEnPause = new Map()   // hôte du service d'envoi → fin de la pause (ms)
function hoteDuService (endpoint) {
  try { return new URL(endpoint).host } catch { return '' }
}
function reinitialiserPauses () { servicesEnPause.clear() }

// Envoie un message à TOUS les abonnements que `ab.pourEnvoi(critere)` rend,
// nettoie les morts, date les succès. Rend { envoyes, morts, echecs,
// aucun_appareil }. Un seul chemin pour les deux tables : celle des personnes
// qui ont un compte (lot 2), celle des prestataires (lot 3).
// `parallele` et `disjoncteur` : le chemin prestataire seulement (lot 3) ; le
// lot 2 garde exactement son déroulé, un appareil après l'autre.
async function envoyerAuxAbonnements ({ ab, critere, message, cles, fetch: f, db, parallele = false, disjoncteur = false }) {
  const opts = db ? { db } : {}
  const r = await ab.pourEnvoi({ ...critere, ...opts })
  if (!r.ok) return { ok: false, motif: r.motif }
  const bilan = { ok: true, envoyes: 0, morts: 0, echecs: 0, aucun_appareil: r.abonnements.length === 0 }
  const traiter = async (abonnement) => {
    const hote = disjoncteur ? hoteDuService(abonnement.endpoint) : ''
    if (disjoncteur && (servicesEnPause.get(hote) || 0) > Date.now()) {
      return { ok: false, motif: 'service_en_pause' }
    }
    const resultat = await envoyer({ abonnement, message, cles, fetch: f })
    if (disjoncteur && (resultat.motif === 'delai_depasse' || resultat.motif === 'reseau')) {
      servicesEnPause.set(hote, Date.now() + PAUSE_SERVICE_MS)
    }
    await ab.apresEnvoi({ id: abonnement.id, resultat, ...opts })
    return resultat
  }
  let resultats
  if (parallele) resultats = await Promise.all(r.abonnements.map(traiter))
  else {
    resultats = []
    for (const abonnement of r.abonnements) resultats.push(await traiter(abonnement))
  }
  for (const resultat of resultats) {
    if (resultat.ok) bilan.envoyes++
    else if (resultat.mort) bilan.morts++
    else bilan.echecs++
  }
  return bilan
}

// Tous les appareils d'une PERSONNE qui a un compte (lot 2).
async function envoyerAPersonne ({ userId, message, cles = clesVapid(), fetch: f = globalThis.fetch, db }) {
  return envoyerAuxAbonnements({ ab: require('./abonnements'), critere: { userId }, message, cles, fetch: f, db })
}

// Tous les appareils d'une PRESTATAIRE DE MÉNAGE, par son profil (lot 3,
// spec §7.6). ⚠ SANS CLÉS, AUCUNE LECTURE : chaque envoi échouerait de toute
// façon, et l'appelant doit savoir tout de suite que rien n'est parti — c'est
// ce qui décide du SMS (spec §6).
// ⚠ EN PARALLÈLE, ET DERRIÈRE LE DISJONCTEUR : le SMS attend ce résultat, donc
// une notification coûte au plus UN délai (5 s), quel que soit le nombre de ses
// appareils — et rien du tout pendant la pause d'un service en panne.
async function envoyerAPrestataire ({ profilId, message, cles = clesVapid(), fetch: f = globalThis.fetch, db }) {
  if (!cles) return { ok: false, motif: 'cles_absentes' }
  return envoyerAuxAbonnements({ ab: require('./abonnements-prestataires'), critere: { profilId }, message, cles, fetch: f, db,
    parallele: true, disjoncteur: true })
}

module.exports = { clesVapid, sujetVapid, cheminDuSite, messageDeclaratif, envoyer, envoyerAPersonne, envoyerAPrestataire,
  reinitialiserPauses, PAUSE_SERVICE_MS, DELAI_MS }
