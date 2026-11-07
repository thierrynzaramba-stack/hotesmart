// lib/push/abonnements.js — LE SEUL MODULE QUI ÉCRIT dans `push_abonnements`.
// Spec : docs/specs/spec-pwa-lot2-notifications.md §9.1-9.2 · KB : docs/kb/pwa.md §8
//
// Une ligne = un appareil abonné, pour une personne. Toutes les écritures
// passent ici : l'abonnement (POST /api/push), le désabonnement, et le
// nettoyage d'un abonnement mort (404 ou 410 du service d'envoi).
//
// ⚠ L'ADRESSE D'ENVOI VIENT DU NAVIGATEUR, ET LE SERVEUR VA L'APPELER. Sans
// contrôle, n'importe quel utilisateur connecté ferait appeler par nos serveurs
// une adresse de son choix (SSRF). Elle est donc validée à CHAQUE écriture :
// `https` obligatoire, et seulement les services d'envoi connus.
//
// ⚠ UN APPAREIL N'EST JAMAIS ABONNÉ POUR DEUX PERSONNES. Un navigateur rend la
// même adresse à quiconque s'abonne après un autre : l'adresse est unique en
// base, et la ligne PASSE au dernier abonné (son compte, rien de l'ancien).
const crypto = require('crypto')

const PLAFOND_APPAREILS = 10

// Les services d'envoi des navigateurs. Comparés au NOM D'HÔTE lu par `new URL()`,
// exactement ou par suffixe AVEC son point : `fcm.googleapis.com.exemple.fr`
// et `xpush.apple.com` sont refusés.
//   Google (Chrome, Edge Android, Opera, Brave) : fcm.googleapis.com
//   Apple (Safari, iPhone) : web.push.apple.com, sous *.push.apple.com
//   Mozilla (Firefox) : updates.push.services.mozilla.com
//   Microsoft (Edge Windows) : wns2-*.notify.windows.com
const HOTES_EXACTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com']
const SUFFIXES = ['.push.apple.com', '.notify.windows.com']

// Clés du navigateur : base64url. p256dh = 65 octets (≈ 87 caractères), auth =
// 16 octets (≈ 22). Des bornes larges, mais un texte arbitraire est refusé.
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/

function client () {
  return require('../cron-shared').supabase
}

function adresseValide (endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false
  let u
  try { u = new URL(endpoint) } catch { return false }
  if (u.protocol !== 'https:') return false
  if (u.username || u.password || u.port) return false
  const hote = u.hostname.toLowerCase()
  return HOTES_EXACTS.includes(hote) || SUFFIXES.some(s => hote.endsWith(s) && hote.length > s.length)
}

// Rend { ok: true, abonnement } ou { ok: false, motif } — jamais un « non » muet.
function validerAbonnement (brut) {
  if (!brut || typeof brut !== 'object') return { ok: false, motif: 'abonnement_absent' }
  const { endpoint } = brut
  const cles = brut.keys || {}
  if (!adresseValide(endpoint)) return { ok: false, motif: 'adresse_refusee' }
  const p256dh = cles.p256dh
  const auth = cles.auth
  if (typeof p256dh !== 'string' || !BASE64URL.test(p256dh) || p256dh.length < 80 || p256dh.length > 100) {
    return { ok: false, motif: 'cle_p256dh_invalide' }
  }
  if (typeof auth !== 'string' || !BASE64URL.test(auth) || auth.length < 16 || auth.length > 32) {
    return { ok: false, motif: 'cle_auth_invalide' }
  }
  return { ok: true, abonnement: { endpoint, keys: { p256dh, auth } } }
}

// Un libellé lisible (« iPhone », « Chrome sur Android »), borné, sans balise.
function libelleAppareil (brut) {
  const s = String(brut == null ? '' : brut).replace(/[<>\u0000-\u001f]/g, '').trim()
  return s ? s.slice(0, 60) : null
}

// L'empreinte d'une adresse d'envoi : ce que le navigateur reçoit pour
// reconnaître « cet appareil » dans la liste, sans que l'adresse elle-même
// quitte jamais le serveur.
function empreinte (endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 16)
}

async function enregistrer ({ userId, abonnement, appareil, db = client() }) {
  const v = validerAbonnement(abonnement)
  if (!v.ok) return { ok: false, motif: v.motif }
  const { endpoint, keys } = v.abonnement

  // Le plafond se compte HORS de cet appareil : réabonner un appareil déjà
  // enregistré ne doit jamais être refusé.
  const { data: miens, error: e1 } = await db.from('push_abonnements')
    .select('id, endpoint').eq('user_id', userId)
  if (e1) return { ok: false, motif: 'lecture_impossible' }
  const autres = (miens || []).filter(l => l.endpoint !== endpoint)
  if (autres.length >= PLAFOND_APPAREILS) return { ok: false, motif: 'plafond_atteint' }

  // ⚠ UPSERT SUR L'ADRESSE : si un autre utilisateur avait cet appareil, la
  // ligne passe à celui-ci, avec SES valeurs (clés, libellé) et un historique
  // remis à zéro. L'ancien n'y reçoit plus rien.
  const ligne = {
    user_id: userId,
    endpoint,
    cle_p256dh: keys.p256dh,
    cle_auth: keys.auth,
    appareil: libelleAppareil(appareil),
    cree_le: new Date().toISOString(),
    dernier_envoi_le: null,
    dernier_echec: null
  }
  const { error: e2 } = await db.from('push_abonnements').upsert(ligne, { onConflict: 'endpoint' })
  if (e2) return { ok: false, motif: 'ecriture_impossible' }
  return { ok: true, empreinte: empreinte(endpoint) }
}

// Désabonner : par l'adresse (l'appareil qui se désabonne lui-même) ou par
// l'identifiant (« retirer » un appareil de la liste). TOUJOURS restreint aux
// lignes de l'appelant.
async function retirer ({ userId, endpoint = null, id = null, db = client() }) {
  if (!endpoint && !id) return { ok: false, motif: 'cible_absente' }
  let q = db.from('push_abonnements').delete().eq('user_id', userId)
  q = endpoint ? q.eq('endpoint', String(endpoint)) : q.eq('id', String(id))
  const { error } = await q
  if (error) return { ok: false, motif: 'ecriture_impossible' }
  return { ok: true }
}

// La liste des appareils de la personne, SANS adresse d'envoi ni clé.
async function lister ({ userId, db = client() }) {
  const { data, error } = await db.from('push_abonnements')
    .select('id, endpoint, appareil, cree_le, dernier_envoi_le')
    .eq('user_id', userId)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  const appareils = (data || []).map(l => ({
    id: l.id,
    appareil: l.appareil,
    cree_le: l.cree_le,
    dernier_envoi_le: l.dernier_envoi_le,
    empreinte: empreinte(l.endpoint)
  }))
  return { ok: true, appareils }
}

// Les abonnements COMPLETS d'une personne, pour l'envoi. Jamais rendus au
// navigateur.
async function pourEnvoi ({ userId, db = client() }) {
  const { data, error } = await db.from('push_abonnements')
    .select('id, endpoint, cle_p256dh, cle_auth')
    .eq('user_id', userId)
  if (error) return { ok: false, motif: 'lecture_impossible' }
  return { ok: true, abonnements: data || [] }
}

// Après un envoi : 404/410 = l'abonnement est mort, la ligne part ; un succès
// date le dernier envoi ; un autre échec se note, sans supprimer.
async function apresEnvoi ({ id, resultat, db = client() }) {
  if (resultat.mort) {
    await db.from('push_abonnements').delete().eq('id', id)
    return
  }
  const maj = resultat.ok
    ? { dernier_envoi_le: new Date().toISOString(), dernier_echec: null }
    : { dernier_echec: String(resultat.motif || resultat.statut || 'echec').slice(0, 120) }
  await db.from('push_abonnements').update(maj).eq('id', id)
}

module.exports = {
  PLAFOND_APPAREILS,
  adresseValide,
  validerAbonnement,
  libelleAppareil,
  empreinte,
  enregistrer,
  retirer,
  lister,
  pourEnvoi,
  apresEnvoi
}
