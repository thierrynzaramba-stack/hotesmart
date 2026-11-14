// shared/avis-traduction.js — LE RENDU d'un avis traduit, partagé par la page
// Avis (core/avis/cartes.js) et la fiche ménage de l'hôte (pages/menages.html).
// Spec : docs/specs/avis-v5/spec-traduction-avis.md.
//
// Décision de Thierry du 11 novembre 2026 : un avis écrit dans une autre langue
// s'affiche TRADUIT dans la langue de lecture, avec une mention qui permet de
// lire l'original. Un clic montre l'original, un second revient à la traduction.
//
// ⚠ CE MODULE NE TRADUIT RIEN. La traduction arrive toute faite du serveur
// (`traduction` sur chaque avis, lib/avis/traduction.js `traductionPour`) : ici
// on ne fait que choisir quoi peindre. Aucun écran n'appelle l'IA.
//
// ⚠ L'ORIGINAL EST DANS LA PAGE, MASQUÉ, PAS RELU : basculer ne coûte aucun
// appel. Une seule bascule par avis — elle fait passer ensemble l'extrait, le
// texte public et le retour privé.
//
// ⚠ LA MENTION NE CONJUGUE PAS LA LANGUE (« Traduit (anglais) ») : « de
// l'anglais », « du japonais », « del inglés »… l'élision et l'article
// dépendent de chaque langue, et une règle de grammaire recopiée par langue
// serait fausse un jour sur deux. Le nom vient d'`Intl.DisplayNames`, dans la
// langue de lecture : aucune liste de langues n'est recopiée.

const echapper = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const LANGUE_RE = /^[a-z]{2}$/

/** Les noms des langues sources, dans la langue de lecture : « anglais et allemand ». */
export function nomsDesLangues (sources, langue = 'fr') {
  const codes = [...new Set((sources || []).filter(c => LANGUE_RE.test(String(c))))]
  let noms = codes
  try {
    const dn = new Intl.DisplayNames([langue], { type: 'language' })
    noms = codes.map(c => dn.of(c) || c)
  } catch { /* sans Intl.DisplayNames : les codes */ }
  try { return new Intl.ListFormat(langue, { type: 'conjunction' }).format(noms) } catch { return noms.join(', ') }
}

/** Les langues sources d'une traduction servie (`{ public?, prive?, extrait? }`). */
export const sourcesDe = (traduction) => traduction
  ? ['extrait', 'public', 'prive'].map(c => traduction[c] && traduction[c].source).filter(Boolean)
  : []

/**
 * Les deux versions d'UN champ : la traduction visible, l'original masqué.
 * Sans traduction, l'original seul — et rien d'autre.
 *
 * @param original  le texte d'origine
 * @param champ     la traduction de ce champ (`{ source, texte }`) ou rien
 * @param rendu     (texte, suffixe) → html — le texte est échappé par lui
 */
export function paire (original, champ, rendu) {
  if (!champ || !champ.texte) return rendu(original, '')
  return `<div class="avt-t">${rendu(champ.texte, '')}</div>`
    + `<div class="avt-o" hidden>${rendu(original, '-o')}</div>`
}

/**
 * La mention et sa bascule, pour la zone `cle`. Rien quand rien n'est traduit.
 * @param T  (cle) → texte : `traduction.traduit` ({langues}), `traduction.voir_original`
 */
export function mention (traduction, cle, T, langue = 'fr') {
  const sources = sourcesDe(traduction)
  if (!sources.length) return ''
  return `<p class="avt-mention"><span>${echapper(T('traduction.traduit', { langues: nomsDesLangues(sources, langue) }))}</span>`
    + ` · <button type="button" class="avt-bascule" data-trad-bascule="${echapper(cle)}">${echapper(T('traduction.voir_original'))}</button></p>`
}

/** Fait passer la zone `cle` de la traduction à l'original, ou l'inverse. */
export function basculer (racine, cle, T) {
  if (!racine || !cle) return
  // Comparée en clair, pas par sélecteur : une clé n'a pas à être échappée.
  const zone = [...racine.querySelectorAll('[data-trad-zone]')].find(z => z.dataset.tradZone === cle)
  if (!zone) return
  const bouton = zone.querySelector('[data-trad-bascule]')
  const versOriginal = !(bouton && bouton.dataset.original === '1')
  for (const t of zone.querySelectorAll('.avt-t')) t.hidden = versOriginal
  for (const o of zone.querySelectorAll('.avt-o')) o.hidden = !versOriginal
  if (bouton) {
    bouton.dataset.original = versOriginal ? '1' : ''
    bouton.textContent = T(versOriginal ? 'traduction.voir_traduction' : 'traduction.voir_original')
  }
}

/** Branche les bascules de `racine` (délégation : les zones peuvent être repeintes). */
export function installer (racine, T) {
  if (!racine || racine.__avtInstalle) return
  racine.__avtInstalle = true
  racine.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-trad-bascule]') : null
    if (!b) return
    ev.preventDefault()
    basculer(racine, b.dataset.tradBascule, T)
  })
}
