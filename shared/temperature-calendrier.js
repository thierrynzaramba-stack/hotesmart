// shared/temperature-calendrier.js — LE CALENDRIER DE TEMPERATURE AirROI, JOUR
// PAR JOUR. Module commun a la page « La temperature du marche »
// (apps/yield/marche-temperature.html) et au bloc AirROI de « Le marche
// global » (apps/yield/marche-global.html), spec §16.1 de
// docs/kb/chantier-nouveau-bien.md : une regle partagee vit dans un module
// commun, jamais recopiee dans chaque page.
//
// ⚠ PIPELINE AirROI SEUL : il rend les `jours` de /api/marche-temperature
// (niveau, sens des composantes, evenement) et rien d'autre. AUCUN prix, ni
// en euros ni en base 100. Sa palette (brique, quatre paliers) est la sienne :
// elle ne se confond jamais avec celle de l'historique.
// ⚠ Tout texte venu du serveur passe par ech().

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

// Une seule teinte, quatre paliers ; leur version sombre ; les classes du
// calendrier. Injecte une fois par page.
const STYLES = `
  :root {
    --tc-creux: #f6ebe4; --tc-modere: #e2b9a0; --tc-favorable: #b8603a; --tc-pic: #6b2412;
    --tc-creux-txt: #4a2a1c; --tc-modere-txt: #3d1a0c; --tc-favorable-txt: #ffffff; --tc-pic-txt: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --tc-creux: #2c2320; --tc-modere: #6a3f2c; --tc-favorable: #b8603a; --tc-pic: #f0a27c;
      --tc-creux-txt: #e9d8cf; --tc-modere-txt: #f6e3d9; --tc-favorable-txt: #ffffff; --tc-pic-txt: #2a0e04;
    }
  }
  :root[data-theme="dark"] {
    --tc-creux: #2c2320; --tc-modere: #6a3f2c; --tc-favorable: #b8603a; --tc-pic: #f0a27c;
    --tc-creux-txt: #e9d8cf; --tc-modere-txt: #f6e3d9; --tc-favorable-txt: #ffffff; --tc-pic-txt: #2a0e04;
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
  const parJour = new Map((jours || []).map(x => [x.jour, x]))
  const mois = [...new Set((jours || []).map(x => x.jour.slice(0, 7)))]
  let moisCourant = 0
  let jourChoisi = null
  if (!mois.length) { conteneur.innerHTML = '<p class="non-calc">Aucun jour à afficher pour ce marché.</p>'; return }

  function detail () {
    if (!jourChoisi) return '<span class="non-calc">Touchez un jour pour voir son détail.</span>'
    const x = parJour.get(jourChoisi)
    if (!x) return ''
    const sn = x.sens || {}
    return `<b>${ech(jourFr(x.jour))}</b> · ${badge(x.niveau)} <span class="non-calc">${DESCRIPTION[niv(x.niveau)] || ''}</span>`
      + `<dl><dt>Saison</dt><dd>${sens(sn.saison)}</dd>`
      + `<dt>Jour de semaine</dt><dd>${sens(sn.semaine)}${x.week_end ? ' (nuit de week-end)' : ''}</dd>`
      + `<dt>Férié ou événement</dt><dd>${x.evenement ? `${ech(x.evenement)} — ${sens(sn.evenement)}` : 'aucun'}</dd>`
      + `<dt>Demande du marché</dt><dd>${sens(sn.demande)} <span class="non-calc">(non comptée dans le niveau : elle date du calcul)</span></dd></dl>`
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
