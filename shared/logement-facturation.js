// shared/logement-facturation.js — ouvrir la fenêtre « Facturation » depuis la
// fiche d'un logement (facture voyageur, étape 1b, D2 bis).
// Spec : docs/specs/spec-facture-voyageur.md §5.1 · KB : docs/kb/entites-juridiques.md
//
// ⚠ UN MODULE ET PAS DU CODE DANS LA PAGE (constat 4 de la review 3) : écrit
// dans la balise `<script>` de pages/logement.html, ce geste ne se testait
// qu'en lisant le source — et le test passait sans `surFermeture`, qui rend le
// bouton inerte après la première fermeture. Ici, il s'exécute dans un DOM.
//
// La page le charge AU CLIC (import dynamique), comme la fenêtre elle-même :
// la fiche n'en paie rien tant qu'on ne l'ouvre pas.

import { facturationBlocHtml } from './logement-fiche.js'

// Une seule fenêtre à la fois, pour toute la page.
let ouverte = null

/**
 * @param {object} o
 * @param {Document} o.doc
 * @param {object}   o.api        `api.entitesJuridiques` (lire, ecrire)
 * @param {Function} o.fiche      rend la fiche COURANTE (elle peut être relue pendant que la fenêtre est ouverte)
 * @param {string}   o.idDuBien   repli si la fiche n'a pas l'UUID du bien
 * @param {object}   o.outils     les outils de rendu de la fiche (`t`, `esc`…)
 * @param {Function} [o.chargerVue]  injecté par les tests ; sinon l'import dynamique
 * @returns {Promise<boolean>}   vrai si une fenêtre a été ouverte
 */
export async function ouvrirFacturation ({ doc, api, fiche, idDuBien, outils, langue = 'fr',
  chargerVue = () => import('./entites-juridiques-vue.js') }) {
  const courante = fiche()
  if (ouverte || !courante) return false
  ouverte = 'ouverture'
  try {
    const { ouvrirFenetre } = await chargerVue()
    const bien = courante.bien && courante.bien.id ? courante.bien.id : idDuBien
    ouverte = ouvrirFenetre({
      doc, api, bien, t: outils.t, esc: outils.esc, langue,
      // Après chaque geste réussi : le nom de l'entité, dans la fiche, repeint
      // seul — sans relire toute la fiche.
      surChangement: (etat) => {
        const f = fiche()
        if (!f) return
        const sienne = (etat.entites || []).find(e => e.id === etat.bien.entite_id) || null
        f.facturation = {
          ...(f.facturation || {}),
          entite: sienne ? { id: sienne.id, nom: sienne.nom, archivee: !!sienne.archivee_le } : null
        }
        const bloc = doc.querySelector('[data-bloc="facturation"]')
        if (bloc) bloc.outerHTML = facturationBlocHtml(f, outils)
      },
      // Le bouton d'ouverture a pu être repeint : le focus revient au nouveau.
      retourFocus: () => doc.querySelector('[data-bind="facturation"]'),
      // ⚠ SANS ÇA, LE BOUTON DEVIENT INERTE APRÈS LA PREMIÈRE FERMETURE.
      surFermeture: () => { ouverte = null }
    })
    return true
  } catch (e) {
    ouverte = null
    throw e
  }
}
