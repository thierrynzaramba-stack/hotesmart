// shared/reordonner-biens.js — RÉORDONNER LES BLOCS D'UN PLANNING à la
// poignée, souris ET doigt. Extrait de pages/calendrier.html le 13 octobre
// 2026 (recette de Thierry : « reprendre les composants, pas les imiter »).
//
// ⚠ POURQUOI CE MODULE EXISTE. La page Ménages avait réécrit ce geste à la
// main et réintroduit, un par un, les quatre défauts que le calendrier avait
// déjà payés en review : insertion toujours AVANT la cible (descendre un bien
// ne faisait rien), `draggable` jamais désarmé, `dragstart` non gardé (glisser
// la photo du bien réordonnait tout), et aucun filtre sur le payload (un texte
// déposé d'une autre page entrait dans les préférences). Deux copies d'une
// règle divergent — ici, elles avaient divergé avant même d'être écrites.
//
// Le module ne connaît ni le DOM de la page, ni ses préférences : il reçoit
// la liste ordonnée, rend la NOUVELLE liste, et la page persiste et repeint.

// Les classes d'état sont celles du calendrier : une seule grammaire visuelle.
const CL_SAISI = 'cal-bien--saisi'
const CL_CIBLE = 'cal-bien--cible'

// Déplacer `id` sur `cibleId` dans `liste`. Rend la nouvelle liste, ou `null`
// quand le geste n'a pas lieu d'être (payload étranger, même bien, inconnu).
//
// ⚠ SI LA SOURCE PRÉCÉDAIT LA CIBLE, ON INSÈRE APRÈS ELLE : sinon, avec deux
// biens, descendre le premier sur le second était un no-op silencieux
// (revue de 4929bcd, puis re-trouvé sur la page Ménages).
export function deplacer (liste, id, cibleId) {
  if (!id || !cibleId || id === cibleId) return null
  if (!liste.includes(id) || !liste.includes(cibleId)) return null
  const descendait = liste.indexOf(id) < liste.indexOf(cibleId)
  const sans = liste.filter(x => x !== id)
  const i = sans.indexOf(cibleId)
  sans.splice(descendait ? i + 1 : i, 0, id)
  return sans
}

// Branche les poignées d'une zone fraîchement rendue.
//   zone      : l'élément qui contient les `[data-bien-section]`
//   ordre()   : rend la liste ordonnée COMPLÈTE (biens masqués compris — un
//               bien caché garde sa place, sinon il revient en dernier)
//   onOrdre(l): reçoit la nouvelle liste ; la page persiste et repeint
export function brancherReordonnancement (zone, { ordre, onOrdre }) {
  const sections = [...zone.querySelectorAll('[data-bien-section]')]
  const appliquer = (id, cibleId) => {
    const neuf = deplacer(ordre(), id, cibleId)
    if (neuf) onOrdre(neuf)
  }
  for (const section of sections) {
    const poigne = section.querySelector('[data-poigne]')
    if (!poigne) continue
    // Le drag ne s'ARME que par la poignée, et se désarme au mouseup même
    // sans drag (sinon la section restait draggable et un glisser anodin —
    // photo native, texte sélectionné — réordonnait les biens).
    poigne.addEventListener('mousedown', () => {
      section.setAttribute('draggable', 'true')
      section.dataset.armePoigne = '1'
      document.addEventListener('mouseup', () => {
        section.removeAttribute('draggable'); delete section.dataset.armePoigne
      }, { once: true })
    })
    section.addEventListener('dragstart', (e) => {
      if (!section.dataset.armePoigne) { e.preventDefault(); return }
      e.dataTransfer.setData('text/plain', section.dataset.bienSection)
      e.dataTransfer.effectAllowed = 'move'
      section.classList.add(CL_SAISI)
    })
    section.addEventListener('dragend', () => {
      section.removeAttribute('draggable'); delete section.dataset.armePoigne
      section.classList.remove(CL_SAISI)
    })
    section.addEventListener('dragover', (e) => { e.preventDefault(); section.classList.add(CL_CIBLE) })
    section.addEventListener('dragleave', (e) => {
      // Les frontières des enfants émettent dragleave : on n'éteint que
      // quand on QUITTE vraiment la section (sinon le surlignage clignote).
      if (!section.contains(e.relatedTarget)) section.classList.remove(CL_CIBLE)
    })
    section.addEventListener('drop', (e) => {
      e.preventDefault()
      section.classList.remove(CL_CIBLE)
      appliquer(e.dataTransfer.getData('text/plain'), section.dataset.bienSection)
    })
    // Tactile : glisser la poignée, la section sous le doigt est la cible ;
    // près des bords, la page DÉFILE (sinon une cible hors écran est
    // inatteignable) ; touchcancel nettoie SANS déplacer.
    let cible = null
    poigne.addEventListener('touchmove', (e) => {
      e.preventDefault()
      const tp = e.touches[0]
      if (tp.clientY < 90) window.scrollBy(0, -16)
      else if (tp.clientY > window.innerHeight - 90) window.scrollBy(0, 16)
      const el = document.elementFromPoint(tp.clientX, tp.clientY)
      const s = el && el.closest('[data-bien-section]')
      for (const x of sections) x.classList.toggle(CL_CIBLE, x === s && s !== section)
      cible = s && s !== section ? s.dataset.bienSection : null
    }, { passive: false })
    poigne.addEventListener('touchend', () => {
      for (const x of sections) x.classList.remove(CL_CIBLE)
      if (cible) appliquer(section.dataset.bienSection, cible)
      cible = null
    })
    poigne.addEventListener('touchcancel', () => {
      for (const x of sections) x.classList.remove(CL_CIBLE)
      cible = null
    })
  }
}
