// shared/temperature-calendrier.js — LE CALENDRIER DE TEMPERATURE AirROI, JOUR
// PAR JOUR. Module commun a la page « La temperature du marche »
// (apps/yield/marche-temperature.html) et au bloc AirROI de « Le marche
// global » (apps/yield/marche-global.html), spec §16.1 de
// docs/kb/chantier-nouveau-bien.md : une regle partagee vit dans un module
// commun, jamais recopiee dans chaque page.
//
// ⚠ PIPELINE AirROI SEUL : il rend les `jours` de /api/marche-temperature
// (niveau, sens des composantes, evenement) et rien d'autre. AUCUN prix, ni
// en euros ni en base 100. Sa palette : les quatre bleus de l'ancien calendrier
// de l'historique (§17.1), une seule pour ce calendrier, ou qu'il s'affiche.
// ⚠ Tout texte venu du serveur passe par ech().

const JOURS_COURTS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']
const MOIS_LONGS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const JOURS_SEM = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim']
export const NIVEAUX = { creux: 'Creux', modere: 'Modéré', favorable: 'Favorable', pic: 'Pic' }
export const DESCRIPTION = { creux: 'marché faible', modere: 'marché normal', favorable: 'bon moment', pic: 'très forte demande' }
const SENS = { haut: 'tire vers le haut', neutre: 'neutre', bas: 'tire vers le bas' }

export const ech = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const moisFr = m => `${MOIS_LONGS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`
export const jourFr = iso => /^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? `${Number(iso.slice(8, 10))} ${MOIS_LONGS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '—'
// ⚠ UN NIVEAU INCONNU N'ENTRE JAMAIS DANS UN STYLE (revue de 675ed3b) : seuls
// les quatre niveaux connus sont interpoles.
export const niv = n => (Object.prototype.hasOwnProperty.call(NIVEAUX, n) ? n : null)
export const badge = n => niv(n) ? `<span class="tc-badge" style="background:var(--tc-${niv(n)});color:var(--tc-${niv(n)}-txt)">${NIVEAUX[niv(n)]}</span>` : '<span class="non-calc">—</span>'
const sens = v => SENS[v] || '—'
const joursValides = jours => (jours || []).filter(x => x && /^\d{4}-\d{2}-\d{2}$/.test(String(x.jour)))

// Le detail d'un jour : ce qui fait son niveau, en sens, jamais en chiffres.
function listeDuJour (x) {
  const sn = x.sens || {}
  return `<dl><dt>Saison</dt><dd>${sens(sn.saison)}</dd>`
    + `<dt>Jour de semaine</dt><dd>${sens(sn.semaine)}${x.week_end ? ' (nuit de week-end)' : ''}</dd>`
    + `<dt>Férié ou événement</dt><dd>${x.evenement ? `${ech(x.evenement)} — ${sens(sn.evenement)}` : 'aucun'}</dd>`
    + `<dt>Demande du marché</dt><dd>${sens(sn.demande)} <span class="non-calc">(non comptée dans le niveau : elle date du calcul)</span></dd></dl>`
}

// Une seule teinte, quatre paliers ; leur version sombre ; les classes du
// calendrier. Injecte une fois par page.
const STYLES = `
  :root {
    --tc-creux: #E8EEF7; --tc-modere: #B9CCE9; --tc-favorable: #6F97D3; --tc-pic: #1E3F73;
    --tc-creux-txt: #1c2b44; --tc-modere-txt: #1c2b44; --tc-favorable-txt: #1c2b44; --tc-pic-txt: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --tc-creux: #1d2735; --tc-modere: #2c4466; --tc-favorable: #4f7bbd; --tc-pic: #a9c4ef;
      --tc-creux-txt: #c9d6ea; --tc-modere-txt: #e3ecf8; --tc-favorable-txt: #ffffff; --tc-pic-txt: #0f1d33;
    }
  }
  :root[data-theme="dark"] {
    --tc-creux: #1d2735; --tc-modere: #2c4466; --tc-favorable: #4f7bbd; --tc-pic: #a9c4ef;
    --tc-creux-txt: #c9d6ea; --tc-modere-txt: #e3ecf8; --tc-favorable-txt: #ffffff; --tc-pic-txt: #0f1d33;
  }
  .tc-legende { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 12px; }
  .tc-niv { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; padding: 3px 10px 3px 3px;
            border: 0.5px solid var(--border); border-radius: 999px; }
  .tc-pastille { width: 18px; height: 18px; border-radius: 50%; display: inline-block; }
  .tc-badge { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
  .tc-nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; max-width: 560px; }
  .tc-nav button { font: inherit; border: 0.5px solid var(--border2); background: var(--bg); color: var(--text);
                   border-radius: 8px; padding: 6px 12px; cursor: pointer; min-width: 44px; min-height: 44px; }
  .tc-nav button:disabled { opacity: .4; cursor: default; }
  .tc-nav h3 { margin: 0; font-size: 16px; text-transform: capitalize; }
  .tc-grille { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; max-width: 560px; }
  .tc-jsem { font-size: 11px; color: var(--text2); text-align: center; padding-bottom: 2px; }
  .tc-jour { aspect-ratio: 1; border: 0; border-radius: 8px; font: inherit; font-size: 13px; cursor: pointer;
             display: flex; align-items: center; justify-content: center; position: relative; padding: 0; }
  .tc-jour.evt::after { content: ''; position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .tc-jour[aria-pressed="true"] { outline: 2px solid var(--text); outline-offset: 1px; }
  .tc-jour:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  .tc-detail { margin-top: 12px; border-top: 0.5px solid var(--border); padding-top: 10px; font-size: 13.5px; line-height: 1.6; }
  .tc-detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 6px 0 0; }
  .tc-detail dt { color: var(--text2); }
  .tc-detail dd { margin: 0; }
  /* La vue « 12 mois d'un coup » (§17.1) : la grille et les petites cases de
     l'ancien calendrier de l'historique. */
  .tc-legende-simple { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--text2); margin: 8px 0 2px; }
  .tc-legende-simple i { display: inline-block; width: 18px; height: 10px; vertical-align: -1px; margin-right: 6px; border-radius: 2px; border: 0.5px solid var(--border); }
  .tc-annee { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px 18px; margin-top: 10px; }
  .tc-mois h3 { font-size: 13px; font-weight: 600; margin: 0 0 6px; text-transform: capitalize; }
  .tc-mini { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .tc-mjsem { font-size: 10.5px; color: var(--text2); text-align: center; }
  .tc-case { font: inherit; font-size: 11px; line-height: normal; text-align: center; padding: 4px 0; border: 0; border-radius: 3px; cursor: pointer; }
  .tc-case:focus-visible { outline: 2px solid var(--text); outline-offset: 1px; }
  .tc-vide { font-size: 11px; text-align: center; padding: 4px 0; color: var(--text2); }
  /* La fenetre de detail d'un jour. */
  .tc-fond { position: fixed; inset: 0; background: rgba(0, 0, 0, .4); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 1000; }
  .tc-popup { background: var(--bg); color: var(--text); border: 0.5px solid var(--border2); border-radius: 12px; width: 100%; max-width: 380px;
              padding: 14px 16px; box-shadow: 0 8px 30px rgba(0, 0, 0, .25); font-size: 13.5px; line-height: 1.6; }
  .tc-popup-tete { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .tc-popup h3 { margin: 0; font-size: 15px; }
  .tc-popup .tc-fermer { font: inherit; font-size: 20px; border: 0; background: transparent; color: var(--text); cursor: pointer; min-width: 44px; min-height: 44px; }
  .tc-popup dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 8px 0 0; }
  .tc-popup dt { color: var(--text2); }
  .tc-popup dd { margin: 0; }
`

export function injecterStyles () {
  if (document.getElementById('tc-styles')) return
  const s = document.createElement('style')
  s.id = 'tc-styles'
  s.textContent = STYLES
  document.head.appendChild(s)
}

// Monte le calendrier dans `conteneur` (un element vide). Son etat (mois
// affiche, jour choisi) et ses ecouteurs restent DANS le conteneur : deux
// calendriers peuvent coexister sans se voir.
export function monterCalendrierTemperature (conteneur, jours) {
  injecterStyles()
  // Un jour sans date lisible est ignore ; les mois sont tries, quel que soit
  // l'ordre recu (review de 98a49da).
  const valides = joursValides(jours)
  const parJour = new Map(valides.map(x => [x.jour, x]))
  const mois = [...new Set(valides.map(x => x.jour.slice(0, 7)))].sort()
  let moisCourant = 0
  let jourChoisi = null
  if (!mois.length) { conteneur.innerHTML = '<p class="non-calc">Aucun jour à afficher pour ce marché.</p>'; return }

  function detail () {
    if (!jourChoisi) return '<span class="non-calc">Touchez un jour pour voir son détail.</span>'
    const x = parJour.get(jourChoisi)
    if (!x) return ''
    return `<b>${ech(jourFr(x.jour))}</b> · ${badge(x.niveau)} <span class="non-calc">${DESCRIPTION[niv(x.niveau)] || ''}</span>` + listeDuJour(x)
  }

  function peindre () {
    const m = mois[moisCourant]
    const [a, mm] = m.split('-').map(Number)
    const decalage = (new Date(Date.UTC(a, mm - 1, 1)).getUTCDay() + 6) % 7
    const nb = new Date(Date.UTC(a, mm, 0)).getUTCDate()
    let cases = JOURS_SEM.map(x => `<div class="tc-jsem">${x}</div>`).join('') + '<div></div>'.repeat(decalage)
    for (let d = 1; d <= nb; d++) {
      const cle = `${m}-${String(d).padStart(2, '0')}`
      const x = parJour.get(cle)
      const n = x && niv(x.niveau)
      cases += n
        ? `<button type="button" class="tc-jour${x.evenement ? ' evt' : ''}" data-jour="${cle}" aria-pressed="${cle === jourChoisi}" style="background:var(--tc-${n});color:var(--tc-${n}-txt)" aria-label="${ech(jourFr(cle))} : ${NIVEAUX[n]}${x.evenement ? ', ' + ech(x.evenement) : ''}">${d}</button>`
        : '<div></div>'
    }
    const legende = Object.keys(NIVEAUX).map(n => `<span class="tc-niv"><span class="tc-pastille" style="background:var(--tc-${n})"></span><b>${NIVEAUX[n]}</b> ${DESCRIPTION[n]}</span>`).join('')
    conteneur.innerHTML = `<div class="tc-legende">${legende}</div>`
      + `<div class="tc-nav"><button type="button" data-tc="prec" aria-label="Mois précédent"${moisCourant === 0 ? ' disabled' : ''}>‹</button>`
      + `<h3>${ech(moisFr(m))}</h3>`
      + `<button type="button" data-tc="suiv" aria-label="Mois suivant"${moisCourant === mois.length - 1 ? ' disabled' : ''}>›</button></div>`
      + `<div class="tc-grille">${cases}</div>`
      + `<div class="tc-detail" aria-live="polite">${detail()}</div>`
    conteneur.querySelector('[data-tc="prec"]').addEventListener('click', () => { if (moisCourant > 0) { moisCourant--; jourChoisi = null; peindre() } })
    conteneur.querySelector('[data-tc="suiv"]').addEventListener('click', () => { if (moisCourant < mois.length - 1) { moisCourant++; jourChoisi = null; peindre() } })
    conteneur.querySelectorAll('.tc-jour').forEach(b => b.addEventListener('click', () => {
      jourChoisi = b.dataset.jour
      conteneur.querySelectorAll('.tc-jour').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.jour === jourChoisi)))
      conteneur.querySelector('.tc-detail').innerHTML = detail()
    }))
  }
  peindre()
}

// ─── La fenetre de detail d'un jour (§17.1) ─────────────────────────────────
// Se ferme par son bouton, la touche Echap ou un clic a cote ; le focus
// revient au jour clique.
export function ouvrirDetailDuJour (x, retour) {
  fermerDetail()
  const fond = document.createElement('div')
  fond.className = 'tc-fond'
  fond.innerHTML = `<div class="tc-popup" role="dialog" aria-modal="true" aria-labelledby="tc-popup-titre">`
    + `<div class="tc-popup-tete"><h3 id="tc-popup-titre">${ech(jourFr(x.jour))}</h3>`
    + `<button type="button" class="tc-fermer" aria-label="Fermer">×</button></div>`
    + `<div>${badge(x.niveau)} <span class="non-calc">${DESCRIPTION[niv(x.niveau)] || ''}</span></div>`
    + listeDuJour(x) + `</div>`
  const touche = e => { if (e.key === 'Escape') fermer() }
  function fermer () {
    document.removeEventListener('keydown', touche)
    fond.remove()
    if (retour && typeof retour.focus === 'function') retour.focus()
  }
  fond._fermer = fermer
  fond.addEventListener('click', e => { if (e.target === fond) fermer() })
  fond.querySelector('.tc-fermer').addEventListener('click', fermer)
  document.addEventListener('keydown', touche)
  document.body.appendChild(fond)
  fond.querySelector('.tc-fermer').focus()
}

export function fermerDetail () {
  const ouvert = document.querySelector('.tc-fond')
  if (ouvert && ouvert._fermer) ouvert._fermer()
}

// ─── La vue « 12 mois d'un coup » (§17.1) ───────────────────────────────────
// Tous les mois visibles ensemble, sans navigation, a partir de `premierMois`
// (AAAA-MM). Un clic sur un jour ouvre sa fenetre de detail.
export function monterAnneeTemperature (conteneur, jours, { premierMois = null, nbMois = 12 } = {}) {
  injecterStyles()
  const valides = joursValides(jours)
  const parJour = new Map(valides.map(x => [x.jour, x]))
  const debut = /^\d{4}-\d{2}$/.test(String(premierMois || '')) ? premierMois : ''
  const mois = [...new Set(valides.map(x => x.jour.slice(0, 7)))].sort().filter(m => m >= debut).slice(0, nbMois)
  if (!mois.length) { conteneur.innerHTML = '<p class="non-calc">Aucun jour à afficher pour ce marché.</p>'; return }
  const legende = `<div class="tc-legende-simple">${Object.keys(NIVEAUX).map(n => `<span><i style="background:var(--tc-${n})"></i>${NIVEAUX[n]} (${DESCRIPTION[n]})</span>`).join('')}</div>`
  const entete = JOURS_COURTS.map(j => `<span class="tc-mjsem">${j}</span>`).join('')
  const blocs = mois.map(m => {
    const [a, mm] = m.split('-').map(Number)
    const decalage = (new Date(Date.UTC(a, mm - 1, 1)).getUTCDay() + 6) % 7
    const nb = new Date(Date.UTC(a, mm, 0)).getUTCDate()
    let cases = '<span></span>'.repeat(decalage)
    for (let d = 1; d <= nb; d++) {
      const cle = `${m}-${String(d).padStart(2, '0')}`
      const x = parJour.get(cle)
      const n = x && niv(x.niveau)
      cases += n
        ? `<button type="button" class="tc-case" data-jour="${cle}" style="background:var(--tc-${n});color:var(--tc-${n}-txt)" aria-label="${ech(jourFr(cle))} : ${NIVEAUX[n]}${x.evenement ? ', ' + ech(x.evenement) : ''}" title="${ech(jourFr(cle))} · ${NIVEAUX[n]}${x.evenement ? ' · ' + ech(x.evenement) : ''}">${d}</button>`
        : `<span class="tc-vide">${d}</span>`
    }
    return `<div class="tc-mois"><h3>${ech(moisFr(m))}</h3><div class="tc-mini">${entete}${cases}</div></div>`
  }).join('')
  conteneur.innerHTML = `${legende}<div class="tc-annee">${blocs}</div>`
  conteneur.querySelectorAll('.tc-case').forEach(b => b.addEventListener('click', () => {
    const x = parJour.get(b.dataset.jour)
    if (x) ouvrirDetailDuJour(x, b)
  }))
}
