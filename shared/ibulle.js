// shared/ibulle.js — l'ouverture des info-bulles ⓘ au TOUCHER.
//
// Demande de Thierry du 29 octobre 2026 : « tout passe en info-bulles ⓘ
// (survol / toucher) ». Le survol est en CSS (`.ibulle:hover .ibulle__txt`).
// Le toucher demande un ETAT, et cet etat est `aria-expanded` sur le bouton :
// une seule source de verite pour le CSS qui ouvre la bulle
// (`.ibulle__btn[aria-expanded="true"] + .ibulle__txt`) et pour ce qu'un
// lecteur d'ecran annonce.
//
// ⚠ POURQUOI UN MODULE, et pas dix lignes dans la balise `<script>` de la
// page : un comportement qui vit dans la page ne se teste qu'en extrayant son
// code a la regex. Ce depot vient de payer deux fois un test qui mesurait
// l'intention au lieu du rendu. Ici, le test DOM exerce la MEME fonction que
// la page appelle.
//
// ⚠ ET IL EST DELEGUE SUR LA RACINE, parce que la ⓘ des comparables est
// RECONSTRUITE a chaque rendu de la legende : un ecouteur pose sur le bouton
// serait perdu au rendu suivant, et un ecouteur repose a chaque rendu
// s'empilerait.

/** Les boutons ⓘ actuellement ouverts. */
const ouverts = (racine) => racine.querySelectorAll('[data-ibulle][aria-expanded="true"]')

/**
 * Branche l'ouverture au toucher sur une racine (le `document` de la page).
 * Idempotent : deux appels ne posent qu'un jeu d'ecouteurs.
 */
export function brancherInfoBulles (racine) {
  if (!racine || racine.__ibulleBranchee) return
  racine.__ibulleBranchee = true

  racine.addEventListener('click', (e) => {
    const cible = e.target && e.target.closest ? e.target : null
    // ⚠ UN TOUCHER DANS LA BULLE NE LA REFERME PAS (constat 4 de la revue de
    // 6d82af4d). Le texte est un FRERE du bouton, pas un descendant : sans
    // cette garde, `closest('[data-ibulle]')` rend `null`, donc le clic est
    // traite comme « ailleurs » et referme tout. Sur telephone la bulle est une
    // feuille de quatre lignes : l'hote qui touche le texte pour le lire, le
    // faire defiler ou le selectionner le voyait disparaitre.
    if (cible && cible.closest('.ibulle__txt')) return
    const btn = cible && cible.closest('[data-ibulle]')
    // ⚠ UN CLIC AILLEURS REFERME TOUT. Sans cela, une bulle ouverte au doigt
    // reste par-dessus le reste de l'ecran et rien ne dit comment la fermer :
    // il n'y a pas de survol a quitter sur un telephone.
    for (const b of ouverts(racine)) {
      if (b !== btn) b.setAttribute('aria-expanded', 'false')
    }
    if (!btn) return
    btn.setAttribute('aria-expanded', btn.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')
  })

  // Et la touche d'echappement, pour le clavier.
  racine.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    for (const b of ouverts(racine)) b.setAttribute('aria-expanded', 'false')
  })
}
