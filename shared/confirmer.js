// shared/confirmer.js
// UNE FENETRE DE CONFIRMATION DANS LA PAGE, A BOUTONS NOMMES.
//
// ⚠ POURQUOI ELLE REMPLACE `window.confirm` (decision de Thierry, 2 novembre
// 2026), et les deux raisons comptent autant l'une que l'autre :
//   1. « OK » et « Annuler » NE DISENT PAS CE QU'ILS FONT. Sur le chemin du
//      delai de reponse IA, « Annuler » voulait dire « garder pour validation »
//      — une action qui ECRIT — et il fallait le lire dans le texte du
//      dialogue. Trois recettes de suite ont bute dessus.
//   2. LA BOITE NATIVE BLOQUE L'EXTENSION CHROME qui joue les recettes.
//      `window.confirm` suspend le fil d'execution de la page : l'extension ne
//      repond plus, et aucune etape ne se joue. Vecu le 1er novembre 2026.
//
// ⚠ ET LA TROISIEME ISSUE EST LA RAISON PROFONDE. `window.confirm` n'a que deux
// sorties, donc « je ne reponds pas » etait indistinguable de « Annuler ».
// Ici, FERMER (croix, Echap, clic a cote) ne change RIEN : la pause reste, rien
// n'est desarme, rien n'est enregistre. Seul un clic sur un bouton NOMME
// decide. C'est ce qui permet d'avoir trois issues reelles la ou le natif n'en
// offrait que deux.
//
// ⚠ PAS DE `<dialog>` NATIF, ET C'EST UNE CONTRAINTE MESUREE : jsdom 26.1.0
// n'implemente ni `showModal` ni `close` (`el.showModal is not a function`).
// Or les garanties produit de ce lot se mesurent AU BANC, en cliquant. Un
// composant qu'on ne peut pas rendre dans le banc serait un composant dont les
// gardes ne sont tenues par rien. On reprend donc le patron que la page menages
// utilise deja : un voile + un panneau, en `hidden`.

// Les classes vivent dans shared/ui.css (`.hs-confirm*`).
const ANCRE = 'hs-confirm'

function vider (el) { while (el.firstChild) el.removeChild(el.firstChild) }

/**
 * Pose la question et rend la CLE du bouton clique, ou `null` si la fenetre a
 * ete FERMEE sans choisir.
 *
 * @param {object}   o
 * @param {string}   o.titre     une ligne, ce qui va se passer
 * @param {string}   o.texte     le detail, avec les nombres
 * @param {Array}    o.boutons   [{ cle, libelle, principal? }] dans l'ordre
 * @param {Document} [o.doc]     le document (le banc en injecte un)
 * @param {string}   [o.fermer]  l'etiquette accessible de la croix
 * @returns {Promise<string|null>}
 */
export function confirmerDansLaPage ({ titre, texte, boutons, doc, fermer = 'Fermer' }) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  if (!d || !Array.isArray(boutons) || !boutons.length) {
    // ⚠ PAS DE REPLI SUR `window.confirm` : il bloque l'extension, et un repli
    // silencieux ferait exactement ce que ce module existe pour empecher. Sans
    // document ni bouton, il n'y a pas de question posee — donc pas de
    // decision, donc `null`, qui ne change rien.
    return Promise.resolve(null)
  }

  const voile = d.createElement('div')
  voile.className = ANCRE + '__voile'
  voile.setAttribute('data-bind', ANCRE + '-voile')

  const boite = d.createElement('div')
  boite.className = ANCRE
  boite.setAttribute('role', 'dialog')
  boite.setAttribute('aria-modal', 'true')
  boite.setAttribute('data-bind', ANCRE)

  const h = d.createElement('p')
  h.className = ANCRE + '__titre'
  h.id = ANCRE + '-titre'
  h.textContent = String(titre || '')
  boite.setAttribute('aria-labelledby', h.id)

  const p = d.createElement('p')
  p.className = ANCRE + '__texte small'
  p.textContent = String(texte || '')

  const croix = d.createElement('button')
  croix.type = 'button'
  croix.className = 'btn btn--secondary btn--icon ' + ANCRE + '__croix'
  croix.setAttribute('data-confirm-fermer', '')
  croix.setAttribute('aria-label', String(fermer))
  croix.textContent = '×'

  const pied = d.createElement('div')
  pied.className = ANCRE + '__pied'

  boite.appendChild(croix)
  boite.appendChild(h)
  boite.appendChild(p)
  boite.appendChild(pied)

  const avant = d.activeElement
  let fini = false

  return new Promise((resolve) => {
    const finir = (cle) => {
      if (fini) return
      fini = true
      d.removeEventListener('keydown', surTouche, true)
      voile.remove(); boite.remove()
      // ⚠ LE FOCUS REVIENT D'OU IL VENAIT. Sans ca, il retombe sur `<body>` et
      // un hote au clavier repart du haut de la page.
      try { if (avant && typeof avant.focus === 'function') avant.focus() } catch (e) {}
      resolve(cle)
    }
    // ⚠ TOUTES LES FERMETURES RENDENT `null`, ET C'EST LA DECISION DE THIERRY :
    // « fermer la fenetre = ne rien changer ». La croix, Echap et le clic a
    // cote passent donc par le MEME chemin que l'absence de reponse.
    const surTouche = (e) => { if (e.key === 'Escape') { e.preventDefault(); finir(null) } }

    for (const b of boutons) {
      const el = d.createElement('button')
      el.type = 'button'
      el.className = 'btn ' + (b.principal ? 'btn--primary' : 'btn--secondary')
      el.setAttribute('data-confirm-choix', String(b.cle))
      el.textContent = String(b.libelle || b.cle)
      el.addEventListener('click', () => finir(String(b.cle)))
      pied.appendChild(el)
    }
    croix.addEventListener('click', () => finir(null))
    voile.addEventListener('click', () => finir(null))
    d.addEventListener('keydown', surTouche, true)

    d.body.appendChild(voile)
    d.body.appendChild(boite)
    // Le premier bouton prend le focus : la fenetre est utilisable au clavier
    // sans souris, et Echap reste la sortie neutre.
    const premier = pied.querySelector('[data-confirm-choix]')
    try { if (premier) premier.focus() } catch (e) {}
  })
}

// Y a-t-il une fenetre ouverte ? Utile a un ecran qui ne doit pas en ouvrir
// deux, et au banc pour l'affirmer.
export function fenetreOuverte (doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null)
  return !!(d && d.querySelector('[data-bind="' + ANCRE + '"]'))
}

export default confirmerDansLaPage
