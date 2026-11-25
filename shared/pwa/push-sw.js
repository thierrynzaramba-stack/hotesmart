/* ============================================================
   HôteSmart — notifications push, le code COMMUN aux deux service
   workers : celui de l'appli hôte (shared/pwa/service-worker.js, portée /)
   et celui de l'appli de la prestataire (apps/menages/sw.js, portée
   /apps/menages/). Chacun le charge par `importScripts`, puis appelle
   `installerNotifications({ accueil, portee, icone })`.
   KB : docs/kb/pwa.md §8 (lot 2a) et §13 (lot 3)
   Tests : tests/pwa-service-worker.test.js, tests/pwa-presta-sw.test.js

   ⚠ UN SEUL FICHIER, PARCE QUE DEUX COPIES DIVERGENT (CLAUDE.md, « le
   mobile suit l'ordinateur »). La lecture du message, la règle « afficher
   toujours », la règle du chemin et le réabonnement étaient écrits dans le
   service worker de l'hôte (lot 2a) ; le lot 3 en a besoin à l'identique
   pour la prestataire. Ils vivent ici, une fois.

   ⚠ VERSIONNÉ PAR SON EMPREINTE. Chaque service worker le charge avec
   `?v=<12 premiers hexa du sha256 de CE fichier>` : modifier ce fichier sans
   reporter l'empreinte est un rouge (tests/pwa-presta-sw.test.js). C'est
   aussi ce qui fait se réinstaller un service worker quand ce fichier
   change : ses propres octets changent avec l'adresse.

   CE QU'IL FAIT :
   1. `push` : chaque message reçu AFFICHE une notification, toujours —
      Safari retire l'abonnement d'un service worker qui en reçoit une sans
      rien montrer. Le message est au format déclaratif (`web_push: 8030`),
      écrit par le serveur (lib/push/envoyer.js) : le texte vient de lui.
   2. `notificationclick` : ouvre l'écran visé, jamais hors du site, et
      jamais hors de la PORTÉE de l'appli qui affiche — l'appli de la
      prestataire n'ouvre pas une page de l'hôte.
   3. `pushsubscriptionchange` : le navigateur a renouvelé l'abonnement, on
      se réabonne avec la même clé. Rien n'est écrit côté serveur (le
      service worker n'a ni session ni lien) : c'est la page qui le renvoie.
   Aucun hexa. Aucun texte affiché, sinon le nom « HôteSmart » quand le
   message reçu est illisible.
   ============================================================ */
'use strict'

function installerNotifications (options) {
  // ⚠ UNE PORTÉE ILLISIBLE ARRÊTE L'INSTALLATION, elle ne retombe pas sur `/`
  // — la plus large (review de l'étape 2 du lot 3, constat 8). Un service worker
  // qui ne s'installe pas laisse l'ancien en place ; un service worker trop
  // large ouvrirait les pages de l'autre appli.
  const portee = options && options.portee
  const accueil = options && options.accueil
  if (typeof portee !== 'string' || !portee.startsWith('/') || !portee.endsWith('/')) {
    throw new Error('installerNotifications : portée invalide')
  }
  if (typeof accueil !== 'string' || !accueil.startsWith(portee)) {
    throw new Error('installerNotifications : accueil hors de la portée')
  }
  const icone = options.icone

  function chaine (v, max) {
    return typeof v === 'string' ? v.slice(0, max) : ''
  }

  // Un chemin du site DANS LA PORTÉE de cette appli, et rien d'autre : sinon
  // l'accueil. Même règle que le serveur (lib/push/envoyer.js) et que la page
  // de connexion (`next`), plus la portée.
  // ⚠ NI `token` NI `apercu` DANS L'ADRESSE OUVERTE (review de l'étape 2,
  // constat 3) : un lien de prestataire ne voyage jamais dans une notification,
  // et `apercu` ouvrirait la page en lecture seule. C'est une défense de plus :
  // sur iPhone 18.4+, le système ouvre le message déclaratif SANS passer par
  // ici — la vraie garantie est l'expéditeur (lib/push/envoyer.js, étape 3).
  function cheminSur (brut) {
    const s = typeof brut === 'string' ? brut : ''
    if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return accueil
    try {
      const u = new URL(s, self.location.origin)
      if (u.origin !== self.location.origin || !u.pathname.startsWith(portee)) return accueil
      u.searchParams.delete('token')
      u.searchParams.delete('apercu')
      return u.pathname + u.search + u.hash
    } catch (_) { return accueil }
  }

  function lireMessage (event) {
    try {
      const m = event.data ? event.data.json() : null
      return m && typeof m === 'object' && m.notification && typeof m.notification === 'object' ? m.notification : {}
    } catch (_) { return {} }
  }

  // ⚠ AFFICHE TOUJOURS, MÊME SUR UN MESSAGE ILLISIBLE. Un push qui ne montre
  // rien fait retirer l'abonnement par Safari (« silent push penalties ») : on
  // préfère une notification nue à un appareil qui ne reçoit plus rien.
  function afficher (event) {
    const n = lireMessage(event)
    const titre = chaine(n.title, 120) || 'HôteSmart'
    const tag = chaine(n.tag, 64)
    const opts = {
      body: chaine(n.body, 300),
      icon: icone,
      lang: chaine(n.lang, 5) || 'fr',
      dir: n.dir === 'rtl' ? 'rtl' : 'ltr',
      data: { chemin: cheminSur(n.navigate) }
    }
    if (tag) {
      opts.tag = tag
      opts.renotify = n.renotify === true
    }
    return self.registration.showNotification(titre, opts)
  }

  // Reprend une fenêtre de l'appli déjà ouverte — de CETTE appli : une page
  // hors de la portée appartient à l'autre appli du même site (même origine).
  // (Le navigateur refuse déjà `navigate()` sur un client qu'il ne contrôle pas ;
  // le filtre évite d'essayer, et dit la règle.)
  // ⚠ JAMAIS UN CADRE (review de l'étape 2, constat 4) : l'aperçu que l'hôte
  // ouvre depuis la fiche d'une prestataire EST un cadre de même origine, sous
  // la portée `/` de l'hôte. Y naviguer ouvrirait sa messagerie dans le cadre,
  // ou — côté prestataire — sortirait le cadre du mode aperçu.
  async function ouvrir (chemin) {
    const cible = new URL(cheminSur(chemin), self.location.origin).href
    const fenetres = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const f of fenetres) {
      if (f.frameType && f.frameType !== 'top-level') continue
      let u
      try { u = new URL(f.url) } catch (_) { continue }
      if (u.origin !== self.location.origin || !u.pathname.startsWith(portee)) continue
      try {
        const ouverte = f.navigate ? await f.navigate(cible) : null
        if (ouverte && ouverte.focus) return ouverte.focus()
        if (f.focus) return f.focus()
      } catch (_) { /* fenêtre non contrôlée : on en ouvre une */ }
    }
    return self.clients.openWindow(cible)
  }

  self.addEventListener('push', (event) => {
    event.waitUntil(afficher(event))
  })

  self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data || {}
    event.waitUntil(ouvrir(data.chemin))
  })

  // Le navigateur a renouvelé l'abonnement : on se réabonne avec la même clé.
  // ⚠ RIEN N'EST ÉCRIT CÔTÉ SERVEUR : le service worker n'a pas de session. La
  // page, à sa prochaine ouverture, compare et renvoie l'abonnement, avec tous
  // les contrôles (shared/push-appareil.js, shared/push-prestataire.js).
  self.addEventListener('pushsubscriptionchange', (event) => {
    const avant = event.oldSubscription && event.oldSubscription.options
    if (!avant || !avant.applicationServerKey) return
    event.waitUntil(self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: avant.applicationServerKey
    }).catch(() => {}))
  })
}
