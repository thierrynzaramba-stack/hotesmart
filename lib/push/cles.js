// lib/push/cles.js — les clés de notification de l'environnement, et le
// contact que les services d'envoi exigent. Rien d'autre.
// KB : docs/kb/pwa.md §8 et §13
//
// ⚠ UN MODULE À PART, SANS `web-push`, pour une raison de coût (constat 7 de
// la review du lot 3, étape 1) : la page de la prestataire n'a besoin que de
// savoir si les notifications sont configurées, et de la clé PUBLIQUE.
// Importer `lib/push/envoyer.js` pour cela chargeait `web-push` à chaque
// démarrage à froid de son endpoint (~30 ms mesurés en local).
//
// ⚠ LA CLÉ PRIVÉE NE SORT JAMAIS DU SERVEUR : ni dans un journal, ni dans une
// réponse, ni dans une erreur. Seul `lib/push/envoyer.js` s'en sert ; tout
// autre appelant ne lit que `publique`.

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

module.exports = { clesVapid, sujetVapid }
