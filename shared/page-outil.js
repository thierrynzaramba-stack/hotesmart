// shared/page-outil.js — le socle commun des PAGES OUTILS (intégration V5).
// Spec : docs/specs/spec-integration-v5-lot-1.md.
//
// Les écrans du menu ≡ « Outils » (serrures, SMS, connexions, abonnement, puis
// YieldFlow, réservation directe, réglages…) ont quatre besoins que leurs
// anciennes versions recopiaient chacune : monter la navigation V5, dire l'état
// d'un service, afficher le retour d'un geste, et écrire une explication qui
// porte des liens. Ils vivent ICI, une fois (CLAUDE.md : « une règle partagée
// vit dans un module commun, jamais recopiée dans chaque page »).
//
// ⚠ AUCUN IMPORT : chaque fonction reçoit ce qu'elle utilise. Le module se
// teste tel quel, et le banc des pages (tests/outils/banc-page.js) l'exécute
// pour de vrai.

const ECHAPPER = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ECHAPPER[c])

// ─── Le texte riche d'une explication ───────────────────────────────────────
// Une traduction peut porter trois marques, et RIEN d'autre :
//   **gras**      → <b>
//   `code`        → <code>
//   [libellé](nom) → un lien vers l'adresse `liens[nom]`, fournie par la PAGE.
// ⚠ L'ADRESSE N'EST JAMAIS DANS LA TRADUCTION : le traducteur traduit le
// libellé, la page porte l'URL. Une marque dont le nom n'est pas fourni reste
// du texte. Et tout est ÉCHAPPÉ AVANT : une traduction ne peut pas injecter de
// balise, même par erreur.
export function rendreRiche (texte, liens = {}) {
  let h = esc(texte)
  h = h.replace(/\[([^\]]+)\]\((\w+)\)/g, (m, libelle, nom) => {
    const url = liens[nom]
    if (!url) return libelle
    const interne = url.startsWith('/')
    return `<a class="out-lien" href="${esc(url)}"${interne ? '' : ' target="_blank" rel="noopener"'}>${libelle}</a>`
  })
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>')
  return h
}

// Les éléments `[data-riche="clé"]` de `racine` ; leurs liens sont posés sur
// l'élément : `data-lien-<nom>="https://…"`.
export function appliquerRiches (racine, t) {
  for (const el of racine.querySelectorAll('[data-riche]')) {
    const liens = {}
    for (const a of el.attributes) {
      if (a.name.startsWith('data-lien-')) liens[a.name.slice('data-lien-'.length)] = a.value
    }
    el.innerHTML = rendreRiche(t(el.getAttribute('data-riche')), liens)
  }
}

// ─── L'état d'un service : TOUJOURS un mot ──────────────────────────────────
// type : 'ok' | 'off' | 'attente' | 'erreur' | 'bientot'. La couleur n'est
// qu'un renfort (règle du dépôt : jamais la couleur seule).
const ETATS = ['ok', 'attente', 'erreur', 'bientot']
export function poserEtat (el, type, texte, base = 'out-etat') {
  if (!el) return
  el.className = base + (ETATS.includes(type) ? ` ${base}--${type}` : '')
  el.textContent = texte
}

// ─── Le retour d'un geste ───────────────────────────────────────────────────
// Un message sous le geste, effacé après `delai` ms (les anciennes pages :
// 4 ou 5 s). Un nouveau message annule l'effacement du précédent.
const minuteries = new WeakMap()
export function afficherRetour (el, texte, type = 'ok', delai = 4000) {
  if (!el) return
  clearTimeout(minuteries.get(el))
  el.className = 'out-retour' + (['ok', 'erreur', 'attente'].includes(type) ? ` out-retour--${type}` : '')
  el.textContent = texte
  el.setAttribute('role', type === 'erreur' ? 'alert' : 'status')
  if (delai > 0) minuteries.set(el, setTimeout(() => { el.textContent = '' }, delai))
}

// ─── La coquille V5 : barre du haut, menu ≡, barre du bas ───────────────────
// Les MÊMES droits que les écrans V5 (appel de pages/aujourdhui.html) :
// Réglages au titulaire, Avis selon le droit, la section Outils de
// `HSNav.outils` (une seule liste, shared/nav.js). Le sélecteur de compte n'a
// rien de propre aux pages outils : il est celui du menu.
export function monterCoquille (o) {
  const { HSNav, I18n, session, compte, deconnexion } = o
  const initiales = document.querySelector('[data-bind="initials"]')
  if (initiales) initiales.textContent = ((session && session.user && session.user.email) || '').slice(0, 2).toUpperCase()
  HSNav.renderMenu({
    comptes: compte.comptes(), compteActif: compte.compteCourant(),
    onCompte: id => compte.basculerVers(id), onDeconnexion: deconnexion,
    reglages: compte.estTitulaire(), avis: compte.peutLire('avis'),
    outils: HSNav.outils({ peutLire: compte.peutLire, titulaire: compte.estTitulaire() })
  })
  HSNav.render({ peutLire: compte.peutLire })
  I18n.apply(document)
  appliquerRiches(document, (k, v) => I18n.t(k, v))
}
