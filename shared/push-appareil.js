// shared/push-appareil.js — les notifications push SUR CET APPAREIL (PWA lots 2a et 2b).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §6, §9.8-9.10, §15 · KB : docs/kb/pwa.md §8-9
//
// Un seul module pour tout ce que le navigateur fait des notifications :
// s'abonner (sur un geste), se désabonner, et oublier l'appareil à la
// déconnexion ou quand une autre personne se connecte. Utilisé par
// /settings, par `purgerCachesLocaux` (shared/supabase.js) et par
// `requireAuth` (components/auth-guard.js).
//
// ⚠ AUCUN APPEL RÉSEAU AU CHARGEMENT D'UNE PAGE. `verifierProprietaire` compare
// deux valeurs locales ; le réseau n'est touché que sur un geste.
//
// ⚠ CE MODULE N'ENREGISTRE AUCUN SERVICE WORKER : c'est le rôle de
// shared/nav.js seul (tests/pwa-nav.test.js). Il prend l'enregistrement de
// portée `/` s'il existe.

const CLE_TITULAIRE = 'hs.push.titulaire'
const CLE_EMPREINTE = 'hs.push.empreinte'
const DELAI_SERVEUR_MS = 3000

function lireLocal (k) { try { return localStorage.getItem(k) } catch { return null } }
function ecrireLocal (k, v) { try { localStorage.setItem(k, v) } catch { /* stockage bloqué */ } }
function effacerLocal (k) { try { localStorage.removeItem(k) } catch { /* stockage bloqué */ } }

export function pris () {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

// L'iPhone et l'iPad n'offrent les notifications qu'à l'appli POSÉE sur
// l'écran d'accueil et ouverte depuis son icône.
export function iphoneHorsAppli () {
  if (typeof navigator === 'undefined') return false
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent || '') ||
    (/Macintosh/.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1)
  if (!ios) return false
  const posee = navigator.standalone === true ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  return !posee
}

export function libelleAppareil () {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  const systeme = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Appareil'
  const nav = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : ''
  return nav ? `${nav} sur ${systeme}` : systeme
}

// LE TYPE D'APPAREIL, pour dire le BON chemin quand les notifications sont
// bloquées (décision Q21 : « le plus simple et clair pour l'utilisateur »).
// Rend 'iphone' (iPhone et iPad), 'android' (Chrome sous Android),
// 'android-autre' (Samsung Internet, Firefox, Edge, Opera sous Android : leurs
// menus ne sont pas ceux de Chrome) ou 'ordinateur'.
export function plateforme () {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  if (/iPhone|iPad|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)) return 'iphone'
  if (/Android/.test(ua)) {
    return /Chrome\//.test(ua) && !/SamsungBrowser|Firefox|EdgA|OPR/.test(ua) ? 'android' : 'android-autre'
  }
  return 'ordinateur'
}

// La permission est-elle DÉJÀ refusée sur cet appareil ? Se lit sans rien
// demander : l'écran le dit dès l'ouverture, avant tout clic.
export function bloquee () {
  return pris() && Notification.permission === 'denied'
}

async function enregistrement () {
  if (!pris()) return null
  try { return (await navigator.serviceWorker.getRegistration('/')) || null } catch { return null }
}

export async function abonnementActuel () {
  const reg = await enregistrement()
  if (!reg || !reg.pushManager) return null
  try { return await reg.pushManager.getSubscription() } catch { return null }
}

// L'empreinte d'une adresse d'envoi, calculée comme le serveur
// (lib/push/abonnements.js) : sha256, 16 premiers caractères hexadécimaux.
export async function empreinte (endpoint) {
  // La forme NORMALISÉE, comme le serveur la range.
  let e = String(endpoint)
  try { e = new URL(e).href } catch { /* on garde la chaîne */ }
  const octets = new TextEncoder().encode(e)
  const h = await crypto.subtle.digest('SHA-256', octets)
  return [...new Uint8Array(h)].map(o => o.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

function enOctets (base64url) {
  const b = String(base64url).replace(/-/g, '+').replace(/_/g, '/')
  const brut = atob(b + '='.repeat((4 - (b.length % 4)) % 4))
  return Uint8Array.from(brut, c => c.charCodeAt(0))
}

function memeCle (sub, octets) {
  const k = sub && sub.options && sub.options.applicationServerKey
  if (!k) return false
  const a = new Uint8Array(k)
  return a.length === octets.length && a.every((v, i) => v === octets[i])
}

async function appelServeur (jeton, methode, corps, { keepalive = false } = {}) {
  const ctl = new AbortController()
  const minuteur = setTimeout(() => ctl.abort(), DELAI_SERVEUR_MS * 3)
  try {
    const r = await fetch('/api/push', {
      method: methode,
      headers: { authorization: `Bearer ${jeton}`, ...(corps ? { 'content-type': 'application/json' } : {}) },
      body: corps ? JSON.stringify(corps) : undefined,
      cache: 'no-store',
      keepalive,
      signal: ctl.signal
    })
    let d = {}
    try { d = await r.json() } catch { d = {} }
    return { ok: r.ok, statut: r.status, ...d }
  } finally { clearTimeout(minuteur) }
}

export async function etatServeur (jeton) {
  return appelServeur(jeton, 'GET')
}

// S'ABONNER. ⚠ À APPELER DIRECTEMENT DANS LE GESTE (le clic) : l'iPhone exige
// que la demande de permission suive un geste. D'où l'ordre : la permission
// d'abord, puis la clé, puis l'abonnement, puis le serveur.
// Rend { ok, motif?, message? }.
// `session()` rend { jeton, userId } : elle n'est appelée qu'APRÈS la demande
// de permission, pour qu'aucune attente ne s'intercale entre le geste et elle.
export async function abonner ({ session }) {
  // L'iPhone d'abord : dans un onglet Safari, `PushManager` n'existe pas.
  if (iphoneHorsAppli()) return { ok: false, motif: 'iphone_hors_appli' }
  if (!pris()) return { ok: false, motif: 'non_pris' }
  // ⚠ LA PREMIÈRE ATTENTE EST LA PERMISSION, ET RIEN AVANT : sur iPhone, une
  // demande qui ne suit pas immédiatement le geste est ignorée.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, motif: permission === 'denied' ? 'refusee' : 'ignoree' }
  const reg = await enregistrement()
  if (!reg) return { ok: false, motif: 'sans_service_worker' }
  const { jeton, userId } = (await session()) || {}
  if (!jeton) return { ok: false, motif: 'serveur', message: 'Session expirée : reconnectez-vous.' }
  const etat = await appelServeur(jeton, 'GET')
  if (!etat.ok) return { ok: false, motif: 'serveur', message: etat.error }
  if (!etat.pret || !etat.cle_publique) return { ok: false, motif: 'cles_absentes' }
  const cle = enOctets(etat.cle_publique)
  let sub = await reg.pushManager.getSubscription()
  // Un abonnement fait avec une AUTRE clé (changement de clé) ne recevrait
  // plus rien : on le défait avant de se réabonner.
  if (sub && !memeCle(sub, cle)) { try { await sub.unsubscribe() } catch { /* déjà mort */ } sub = null }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: cle })
  const r = await appelServeur(jeton, 'POST', { action: 'abonner', abonnement: sub.toJSON(), appareil: libelleAppareil() })
  if (!r.ok) return { ok: false, motif: r.motif || 'serveur', message: r.error }
  if (userId) ecrireLocal(CLE_TITULAIRE, userId)
  if (r.empreinte) ecrireLocal(CLE_EMPREINTE, r.empreinte)
  return { ok: true, empreinte: r.empreinte }
}

// LES RÉGLAGES DE LA PERSONNE (lot 2b) : le tableau des événements et les heures
// calmes, enregistrés ensemble.
export async function enregistrerReglages (jeton, { evenements, plages }) {
  return appelServeur(jeton, 'POST', { action: 'reglages', evenements, plages })
}

// LA LANGUE DE LA PERSONNE (lot 2b), dans laquelle ses notifications lui
// arriveront. Appelée par le sélecteur du menu ≡ (shared/nav.js), seulement sur
// ce geste.
// ⚠ `keepalive` : si la page se recharge malgré l'attente de shared/nav.js
// (réseau lent), le navigateur termine quand même l'envoi.
export async function enregistrerLangue (jeton, langue) {
  return appelServeur(jeton, 'POST', { action: 'langue', langue }, { keepalive: true })
}

export async function essai (jeton) {
  return appelServeur(jeton, 'POST', { action: 'essai' })
}

export async function retirer (jeton, id) {
  return appelServeur(jeton, 'DELETE', { id })
}

// OUBLIER CET APPAREIL : le serveur (si la session vit encore, sans attendre
// plus de 3 s), PUIS le navigateur — toujours, même si le serveur a échoué.
// Une fois le navigateur désabonné, le service d'envoi répond 410 et le
// serveur nettoie la ligne au premier envoi.
export async function oublierAppareil (jeton = null) {
  const sub = await abonnementActuel()
  if (sub && jeton) {
    try {
      await Promise.race([
        appelServeur(jeton, 'DELETE', { endpoint: sub.endpoint }),
        new Promise(resolve => setTimeout(resolve, DELAI_SERVEUR_MS))
      ])
    } catch { /* session expirée, hors ligne : le navigateur suffit */ }
  }
  if (sub) { try { await sub.unsubscribe() } catch { /* déjà mort */ } }
  effacerLocal(CLE_TITULAIRE)
  effacerLocal(CLE_EMPREINTE)
}

// À CHAQUE PAGE PROTÉGÉE (components/auth-guard.js) :
//   1. l'appareil est-il abonné pour une AUTRE personne, ou pour un titulaire
//      inconnu ? Alors on le désabonne, localement, sans appel réseau ;
//   2. le navigateur a-t-il renouvelé l'abonnement (`pushsubscriptionchange`
//      du service worker, qui n'a pas de session) ? Alors on renvoie le nouveau
//      au serveur, par le même POST et les mêmes contrôles. C'est le SEUL cas
//      où cette vérification touche le réseau, et il est rare.
export async function verifierAppareil (userId, jeton = null) {
  if (!pris() || !userId) return
  const sub = await abonnementActuel()
  if (!sub) return
  if (lireLocal(CLE_TITULAIRE) !== userId) {
    try { await sub.unsubscribe() } catch { /* déjà mort */ }
    effacerLocal(CLE_TITULAIRE)
    effacerLocal(CLE_EMPREINTE)
    return
  }
  const actuelle = await empreinte(sub.endpoint)
  if (actuelle === lireLocal(CLE_EMPREINTE) || !jeton) return
  const r = await appelServeur(jeton, 'POST', { action: 'abonner', abonnement: sub.toJSON(), appareil: libelleAppareil() }).catch(() => null)
  if (r && r.ok) ecrireLocal(CLE_EMPREINTE, actuelle)
}
