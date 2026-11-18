// shared/push-prestataire.js — les notifications de la PRESTATAIRE DE MÉNAGE sur
// son téléphone (PWA lot 3, étape 2).
// Spec : docs/specs/spec-pwa-lot3-prestataires.md §3 et §7 · KB : docs/kb/pwa.md §13
// Utilisé par apps/menages/public.html, chargé à la demande (import dynamique) :
// hors ligne, son absence masque le bloc et ne casse rien d'autre.
//
// Le jumeau de shared/push-appareil.js (l'hôte, lot 2), avec trois écarts qui
// tiennent à la personne :
//   - pas de session : le LIEN est son identité, et l'API est celle de sa page
//     (`/api/menages-public`, actions `push_abonner` / `push_retirer`) ;
//   - l'état connu du serveur arrive avec sa page (`push` du GET) : aucun appel
//     réseau de plus pour l'afficher ;
//   - l'enregistrement de service worker est celui de SON appli, portée
//     `/apps/menages/` — jamais celui de l'hôte (portée `/`), qui existe sur le
//     même navigateur quand quelqu'un utilise les deux.
// Les primitives du navigateur (support, iPhone, plateforme, empreinte, clé)
// sont CELLES DE L'HÔTE, importées : deux copies divergent.

import { pris, iphoneHorsAppli, libelleAppareil, plateforme, bloquee, empreinte, enOctets, memeCle } from './push-appareil.js'

export { plateforme }

const PORTEE = '/apps/menages/'
// Les empreintes des abonnements envoyés DEPUIS CET APPAREIL, PAR LIEN (les
// dernières), pour reconnaître un abonnement renouvelé par le navigateur.
// ⚠ RANGÉES PAR LIEN, ET VIDÉES QUAND ELLE SE DÉSABONNE (review de l'étape 2,
// constat 1) : sans cela, une ancienne adresse encore connue du serveur faisait
// passer son « Ne plus recevoir » pour un renouvellement, et la page la
// réabonnait à l'ouverture suivante — contre ce qu'elle venait de demander.
// La clé d'un lien est une EMPREINTE de son jeton, jamais le jeton.
const CLE_ENVOYES = 'hotesmart-clean-push-envoyes'
const GARDES = 5
const DELAI_MS = 10000

function lireTout () {
  try {
    const v = JSON.parse(localStorage.getItem(CLE_ENVOYES) || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}
function ecrireTout (tout) {
  try {
    if (Object.keys(tout).length) localStorage.setItem(CLE_ENVOYES, JSON.stringify(tout))
    else localStorage.removeItem(CLE_ENVOYES)
  } catch { /* stockage bloqué */ }
}
// L'espace rend la chaîne illisible comme adresse : `empreinte` la hache telle
// quelle, sans la « normaliser » comme une URL.
async function cleDuLien (jeton) {
  return 'l' + await empreinte('lien ' + String(jeton))
}
async function lireEnvoyes (jeton) {
  const v = lireTout()[await cleDuLien(jeton)]
  return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
}
async function noterEnvoye (jeton, e) {
  if (!e) return
  const cle = await cleDuLien(jeton)
  const tout = lireTout()
  const avant = Array.isArray(tout[cle]) ? tout[cle] : []
  tout[cle] = [e, ...avant.filter(x => x !== e)].slice(0, GARDES)
  ecrireTout(tout)
}
async function oublierEnvoyes (jeton) {
  const cle = await cleDuLien(jeton)
  const tout = lireTout()
  delete tout[cle]
  ecrireTout(tout)
}

// ⚠ L'ENREGISTREMENT DE SON APPLI, ET AUCUN AUTRE. `getRegistration` et
// `ready` rendent la portée la plus proche : si son service worker n'est pas
// (encore) enregistré et que celui de l'hôte l'est sur ce navigateur, ce serait
// celui de l'hôte — et la notification s'ouvrirait sur son accueil à lui.
function sienne (reg) {
  try { return reg && new URL(reg.scope).pathname === PORTEE ? reg : null } catch { return null }
}

async function enregistrementPresta ({ attendre = false } = {}) {
  if (!pris()) return null
  try {
    const reg = sienne(await navigator.serviceWorker.getRegistration(PORTEE))
    if (reg && reg.active) return reg
    if (!attendre) return reg
    // Première ouverture : son service worker s'installe encore. On attend
    // qu'il soit actif, sans jamais attendre indéfiniment.
    const pret = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise(resolve => setTimeout(() => resolve(null), DELAI_MS))
    ])
    return sienne(pret)
  } catch { return null }
}

async function abonnementPresta () {
  const reg = await enregistrementPresta()
  if (!reg || !reg.pushManager) return null
  try { return await reg.pushManager.getSubscription() } catch { return null }
}

async function appel (jeton, corps) {
  const ctl = new AbortController()
  const minuteur = setTimeout(() => ctl.abort(), DELAI_MS)
  try {
    const r = await fetch('/api/menages-public?token=' + encodeURIComponent(jeton), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corps),
      cache: 'no-store',
      signal: ctl.signal
    })
    let d = {}
    try { d = await r.json() } catch { d = {} }
    return { ...d, ok: r.ok, statut: r.status }
  } catch {
    return { ok: false, motif: 'reseau' }
  } finally { clearTimeout(minuteur) }
}

// L'ÉTAT À AFFICHER, SANS APPEL RÉSEAU : `push` est celui qu'a rendu le GET de
// sa page. Rend { etat } parmi :
//   'indisponible'      — le site n'a pas de clés, ou ce navigateur ne sait pas
//                          faire : le bloc ne s'affiche pas ;
//   'iphone_hors_appli' — iPhone, page ouverte dans Safari : l'installer d'abord ;
//   'bloquee'           — l'autorisation est refusée sur ce téléphone ;
//   'inconnu'           — le serveur n'a pas pu lire ses appareils ;
//   'abonne'            — CET appareil est connu du serveur pour ce lien ;
//   'a_activer'         — sinon.
// ⚠ « ABONNÉ » EST CE QUE LE SERVEUR SAIT, pas ce que le navigateur croit : un
// nouveau lien a pu purger ses appareils, et le navigateur garde l'abonnement.
export async function etatNotifications (push) {
  if (!push || !push.pret || !push.cle_publique) return { etat: 'indisponible' }
  // L'iPhone d'abord : dans un onglet Safari, `PushManager` n'existe pas.
  if (iphoneHorsAppli()) return { etat: 'iphone_hors_appli' }
  if (!pris()) return { etat: 'indisponible' }
  if (bloquee()) return { etat: 'bloquee' }
  if (!Array.isArray(push.appareils)) return { etat: 'inconnu' }
  if (Notification.permission === 'granted') {
    const sub = await abonnementPresta()
    if (sub && push.appareils.includes(await empreinte(sub.endpoint))) return { etat: 'abonne' }
  }
  return { etat: 'a_activer' }
}

// S'ABONNER. ⚠ À APPELER DIRECTEMENT DANS LE GESTE (le clic), sans attente
// avant : l'iPhone ignore une demande de permission qui ne suit pas
// immédiatement un toucher. D'où l'ordre : contrôles sans attente, la
// permission, puis l'abonnement, puis le serveur.
// Rend { ok, push?, motif?, message? } — `push` est l'état à jour.
export async function activerNotifications ({ push, jeton }) {
  if (!push || !push.pret || !push.cle_publique) return { ok: false, motif: 'cles_absentes' }
  if (iphoneHorsAppli()) return { ok: false, motif: 'iphone_hors_appli' }
  if (!pris()) return { ok: false, motif: 'non_pris' }
  if (!jeton) return { ok: false, motif: 'sans_lien' }
  // ⚠ LA PREMIÈRE ATTENTE EST LA PERMISSION, ET RIEN AVANT.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, motif: permission === 'denied' ? 'refusee' : 'ignoree' }
  const reg = await enregistrementPresta({ attendre: true })
  if (!reg || !reg.pushManager) return { ok: false, motif: 'sans_service_worker' }
  let sub
  try {
    const cle = enOctets(push.cle_publique)
    sub = await reg.pushManager.getSubscription()
    // Un abonnement fait avec une AUTRE clé ne recevrait plus rien.
    if (sub && !memeCle(sub, cle)) { try { await sub.unsubscribe() } catch { /* déjà mort */ } sub = null }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: cle })
  } catch {
    return { ok: false, motif: 'abonnement_impossible' }
  }
  const r = await appel(jeton, { action: 'push_abonner', abonnement: sub.toJSON(), appareil: libelleAppareil() })
  if (!r.ok) return { ok: false, motif: r.motif || 'serveur', message: r.error }
  await noterEnvoye(jeton, r.empreinte)
  return { ok: true, push: r.push || null }
}

// NE PLUS RECEVOIR SUR CE TÉLÉPHONE, pour CE lien. ⚠ LE NAVIGATEUR GARDE SON
// ABONNEMENT : sur Android, il peut servir aussi l'appli d'un autre hôte de la
// même prestataire (même portée). Le serveur, lui, n'envoie plus rien à ce
// lien sur cet appareil — c'est ce qu'elle a demandé.
// ⚠ ET LA MÉMOIRE DES ADRESSES ENVOYÉES POUR CE LIEN EST OUBLIÉE : c'est ce qui
// empêche le renouvellement de la réabonner à l'ouverture suivante.
export async function desactiverNotifications ({ jeton }) {
  if (!jeton) return { ok: false, motif: 'sans_lien' }
  const sub = await abonnementPresta()
  if (!sub) { await oublierEnvoyes(jeton); return { ok: true, push: null } }
  const r = await appel(jeton, { action: 'push_retirer', endpoint: sub.endpoint })
  if (!r.ok) return { ok: false, motif: r.motif || 'serveur', message: r.error }
  await oublierEnvoyes(jeton)
  return { ok: true, push: r.push || null }
}

// À L'OUVERTURE DE SA PAGE : le navigateur a-t-il RENOUVELÉ l'abonnement
// (`pushsubscriptionchange` du service worker, qui n'a ni session ni lien) ?
// Alors on renvoie le nouveau, par le même geste serveur et ses contrôles.
// C'est le seul cas où cette vérification touche le réseau, et il est rare.
// ⚠ SEULEMENT UN RENOUVELLEMENT : une adresse déjà envoyée depuis cet appareil,
// POUR CE LIEN, doit être ENCORE connue du serveur. Une purge — nouveau lien,
// personne désactivée — a vidé la liste : on ne réabonne pas derrière l'hôte.
// Et son propre « Ne plus recevoir » a vidé la mémoire locale de ce lien : on
// ne la réabonne pas derrière elle non plus.
// Rend l'état serveur à jour, ou null si rien n'a été fait.
export async function verifierRenouvellement ({ push, jeton }) {
  if (!jeton || !push || !push.pret || !Array.isArray(push.appareils)) return null
  if (!pris() || iphoneHorsAppli() || Notification.permission !== 'granted') return null
  const sub = await abonnementPresta()
  if (!sub) return null
  const actuelle = await empreinte(sub.endpoint)
  if (push.appareils.includes(actuelle)) { await noterEnvoye(jeton, actuelle); return null }
  const renouvele = (await lireEnvoyes(jeton)).some(e => e !== actuelle && push.appareils.includes(e))
  if (!renouvele) return null
  const r = await appel(jeton, { action: 'push_abonner', abonnement: sub.toJSON(), appareil: libelleAppareil() })
  if (!r.ok) return null
  await noterEnvoye(jeton, r.empreinte || actuelle)
  return r.push || null
}
