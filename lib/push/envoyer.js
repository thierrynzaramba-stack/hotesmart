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

const DELAI_MS = 5000
const TTL_S = 24 * 3600

// Les clés de l'environnement. Rend null si l'une manque : les notifications
// ne sont alors pas configurées, et l'appelant le dit.
function clesVapid (env = process.env) {
  const publique = String(env.PUSH_VAPID_PUBLIC || '').trim()
  const privee = String(env.PUSH_VAPID_PRIVATE || '').trim()
  if (!publique || !privee) return null
  return { publique, privee, sujet: sujetVapid(env) }
}

// Le contact que les services d'envoi (Apple en particulier) exigent. Décision
// de Thierry du 7 novembre 2026 : l'e-mail fondateur. Staging n'a pas
// FOUNDER_EMAIL (docs/STAGING.md §3) : repli sur l'adresse du site, que la
// RFC 8292 accepte aussi (`https:`).
function sujetVapid (env = process.env) {
  const mail = String(env.FOUNDER_EMAIL || '').trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return 'mailto:' + mail
  const site = String(env.APP_URL || '').trim()
  if (/^https:\/\/[^\s/]+/.test(site)) return site.replace(/\/+$/, '')
  return 'https://hotesmart.vercel.app'
}

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

// Envoie un message à TOUS les appareils d'une personne, nettoie les morts,
// date les succès. Rend { envoyes, morts, echecs, aucun_appareil }.
async function envoyerAPersonne ({ userId, message, cles = clesVapid(), fetch: f = globalThis.fetch, db }) {
  const ab = require('./abonnements')
  const opts = db ? { db } : {}
  const r = await ab.pourEnvoi({ userId, ...opts })
  if (!r.ok) return { ok: false, motif: r.motif }
  const bilan = { ok: true, envoyes: 0, morts: 0, echecs: 0, aucun_appareil: r.abonnements.length === 0 }
  for (const abonnement of r.abonnements) {
    const resultat = await envoyer({ abonnement, message, cles, fetch: f })
    if (resultat.ok) bilan.envoyes++
    else if (resultat.mort) bilan.morts++
    else bilan.echecs++
    await ab.apresEnvoi({ id: abonnement.id, resultat, ...opts })
  }
  return bilan
}

module.exports = { clesVapid, sujetVapid, cheminDuSite, messageDeclaratif, envoyer, envoyerAPersonne, DELAI_MS }
