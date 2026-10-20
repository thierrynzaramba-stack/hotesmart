// ═══════════════════════════════════════════════════════════════════════════
// LA LISTE DES LOGEMENTS — les règles d'affichage, partagées par les deux
// versions de l'écran (ordinateur et téléphone)
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ UN MODULE COMMUN, PAS DEUX COPIES. Règle du dépôt : « une règle partagée
// par les deux versions vit dans un module commun, jamais recopiée dans chaque
// page : deux copies divergent ». Vécu le 30 septembre 2026 — la couleur des
// réservations était tirée au sort sur les deux calendriers, l'ordinateur avait
// été corrigé, le téléphone jamais.
//
// Ici, la liste V5 est UNE page responsive, donc une seule consommatrice
// aujourd'hui. Le module existe quand même : la fiche (étape 2) affiche le même
// fait daté et les mêmes pastilles, et c'est là que la copie se ferait.
//
// ⚠ AUCUN TEXTE EN DUR, AUCUN HEXA. Ce module rend des CLÉS i18n et des valeurs ;
// la page traduit et met en forme. Un module qui rendrait « Occupé · départ
// vendredi » serait intraduisible (c'est le défaut D1 de l'inventaire).

// ─────────────────────────────────────────────────────────────────────────────
// Le fait daté
// ─────────────────────────────────────────────────────────────────────────────
//
// L'endpoint rend des FAITS (`type`, `du`, `au`) ; ici on choisit la phrase.
// Cinq cas, et un sixième qui n'est pas une phrase : `null` = on n'a pas pu
// lire, et ça ne se dit pas « Libre ».
//
// ⚠ `null` NE DEVIENT JAMAIS « Libre ». C'est la règle qui tient tout le lot :
// afficher « Libre jusqu'au… » sur un bien dont on n'a pas pu lire les
// réservations est un mensonge commercial, affiché sur la carte d'un bien
// peut-être complet.
export function faitDateAffiche (fait) {
  if (fait == null) return { cle: 'logements.fait_indisponible', valeurs: null, muet: true }
  switch (fait.type) {
    case 'occupe':
      return { cle: 'logements.fait_occupe', valeurs: { date: fait.au } }
    case 'ferme':
      return { cle: 'logements.fait_ferme', valeurs: { date: fait.au } }
    case 'arrivee':
      return { cle: 'logements.fait_arrivee', valeurs: { date: fait.du } }
    case 'fermeture':
      return { cle: 'logements.fait_fermeture', valeurs: { debut: fait.du, fin: fait.au } }
    case 'libre':
      return { cle: 'logements.fait_libre', valeurs: null }
    default:
      // Un type inconnu ne s'invente pas : on se tait plutôt que de deviner.
      return { cle: 'logements.fait_indisponible', valeurs: null, muet: true }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Les pastilles de canaux
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §2, trois états et pas deux : point plein = en vente pour CE bien ; rond
// vide = canal relié mais ce bien n'y est pas en vente ; canal absent = pas de
// pastille du tout.
//
// ⚠ UN QUATRIÈME ÉTAT EXISTE, et le taire serait reproduire le défaut que la
// dette 59 a fermé : `mappe === null` veut dire « le relevé n'a PAS PU
// conclure ». Ce n'est ni « en vente » ni « pas en vente ».
//
// ⚠ COULEURS NEUTRES. Les couleurs Airbnb/Booking/Direct (`--canal-*`) restent
// réservées au Calendrier : ici, deux pastilles de la même forme ne doivent pas
// se lire comme deux canaux différents par la couleur.
export function pastillesDesCanaux (canaux) {
  if (canaux == null) return null       // on n'a pas pu lire
  return canaux.map(c => ({
    ota: c.ota,
    etat: c.mappe === true ? 'vente'
      : c.mappe === false ? 'pas-ce-bien'
      : 'indetermine',
    titre: c.mappe === true ? 'logements.canal_en_vente'
      : c.mappe === false ? 'logements.canal_pas_ce_bien'
      : 'logements.canal_indetermine'
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Un seul signal par carte
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §2 : « un seul signal si présent ». L'écran d'avant en empilait
// plusieurs, et une carte qui crie trois fois ne dit plus rien. L'ordre est
// celui de la gravité POUR L'HÔTE : une automatisation coupée se voit avant une
// vérification en retard.
//
// ⚠ GRIS NEUTRE, PAS ROUGE. La charte réserve le rouge à la suppression et aux
// erreurs (§7) : un assistant en pause est un CHOIX de l'hôte — Ofuro Futari
// l'est volontairement depuis le 6 octobre — pas une panne.
export function signalDuBien (bien) {
  if (bien.assistant_en_pause === true) return { cle: 'logements.signal_pause', icone: 'i-shield-off' }
  if (bien.canaux_echec === true) return { cle: 'logements.signal_canaux', icone: 'i-alert' }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// La ligne « ville · capacité »
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ D3 : RIEN si la capacité est vide. L'écran d'avant affichait
// « Capacité : personne(s) » — une chaîne de gabarit non remplie, lue par
// l'hôte comme un bug. L'endpoint rend déjà `null` plutôt que 0 ; ici on
// n'ajoute simplement pas le segment.
export function sousTitre (bien) {
  const bouts = []
  if (bien.ville) bouts.push({ texte: bien.ville })
  if (bien.capacite != null) bouts.push({ cle: 'logements.capacite', valeurs: { n: bien.capacite } })
  return bouts
}

// ─────────────────────────────────────────────────────────────────────────────
// Ce que la page doit afficher à la place de la liste
// ─────────────────────────────────────────────────────────────────────────────
//
// Quatre situations, et elles ne se confondent pas — c'est la même discipline
// que l'endpoint, portée jusqu'à l'écran :
//   · `refus`   le profil n'a pas le droit de lire les logements ;
//   · `panne`   la lecture a échoué (503) ;
//   · `vide`    on a lu, le compte n'a aucun logement ;
//   · `liste`   on affiche.
//
// ⚠ « VIDE » ET « PANNE » NE SE CONFONDENT PAS. Un 200 à liste vide ferait lire
// « Ajoutez votre premier logement » à un hôte qui en a quatre — et à
// l'onboarding, une réconciliation contre du vide CRÉE des biens en double chez
// le canal. L'endpoint lève (503) pour cette raison ; l'écran doit le dire.
export function etatDeLaPage ({ erreur = null, biens = null } = {}) {
  if (erreur) return erreur.status === 403 ? 'refus' : 'panne'
  if (biens == null) return 'panne'
  return biens.length ? 'liste' : 'vide'
}

// ═══════════════════════════════════════════════════════════════════════════
// LE RENDU
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ ICI ET PAS DANS LA PAGE, pour une raison précise : un rendu écrit dans la
// balise `<script>` d'un fichier HTML ne se teste qu'en extrayant son code à la
// regex — un test fragile, qui passe le jour où la page bouge. Le dépôt a déjà
// tranché cette question pour les avis (`core/avis/cartes.js`, éprouvé en
// jsdom), et c'est le même choix ici.
//
// ⚠ LES OUTILS SONT INJECTÉS (`t`, `esc`, `dateEnClair`, `icone`) : ce module ne
// connaît ni `window.I18n`, ni le DOM. Il rend une chaîne, et c'est tout — donc
// il se teste sans navigateur et sans monter la page.

// Les dates du fait daté passent par `dateEnClair` ; le reste est déjà du texte.
function valeursEnClair (valeurs, dateEnClair) {
  if (!valeurs) return {}
  return Object.fromEntries(Object.entries(valeurs).map(([k, v]) => [k, dateEnClair(v)]))
}

export function canauxHtml (bien, { t, esc }) {
  const pastilles = pastillesDesCanaux(bien.canaux)
  // ⚠ TROIS CAS, PAS DEUX. `null` = on n'a pas pu lire ; `[]` = lu, et il n'y a
  // aucun canal relié. Les confondre ferait lire « aucun canal » à un hôte qui
  // en a deux : le défaut exact que la dette 59 a fermé.
  if (pastilles == null) {
    return `<span class="log-pastille log-pastille--indetermine" data-canaux="non-lus">`
      + `<span class="log-point"></span>${esc(t('logements.canaux_non_lus'))}</span>`
  }
  if (!pastilles.length) {
    return `<span class="caption muted" data-canaux="aucun">${esc(t('logements.aucun_canal'))}</span>`
  }
  return pastilles.map(p =>
    `<span class="log-pastille log-pastille--${p.etat}" data-ota="${esc(p.ota)}" data-etat="${p.etat}" title="${esc(t(p.titre))}">`
    + `<span class="log-point"></span>${esc(p.ota)}</span>`).join('')
}

export function carteHtml (bien, outils) {
  const { t, esc, dateEnClair, icone } = outils
  const fait = faitDateAffiche(bien.fait_date)
  const signal = signalDuBien(bien)
  const sous = sousTitre(bien)
    .map(x => x.texte != null ? esc(x.texte) : esc(t(x.cle, x.valeurs)))
    .join(' · ')
  const photo = bien.photo_url
    ? `<img src="${esc(bien.photo_url)}" alt="" loading="lazy">`
    : icone('i-home', '')

  return `<article class="log-carte" data-bien="${esc(bien.id)}">
    <div class="log-photo">${photo}</div>
    <div>
      <div class="log-nom">${esc(bien.nom || '')}</div>
      ${sous ? `<div class="log-sous caption">${sous}</div>` : ''}
    </div>
    <div class="log-canaux">${canauxHtml(bien, outils)}</div>
    <div class="log-fait${fait.muet ? ' log-fait--muet' : ''} caption" data-fait="${bien.fait_date ? bien.fait_date.type : 'indisponible'}">${esc(t(fait.cle, valeursEnClair(fait.valeurs, dateEnClair)))}</div>
    ${signal ? `<div><span class="log-signal" data-signal>${icone(signal.icone, '')}${esc(t(signal.cle))}</span></div>` : ''}
  </article>`
}

// Le contenu de la zone d'état, pour les trois situations qui ne sont pas une
// liste. Les textes passent par `data-i18n` : la page les traduit après
// insertion, comme partout dans la V5.
export function etatHtml (quoi) {
  if (quoi === 'vide') {
    // ⚠ CE MESSAGE NE S'AFFICHE QUE SUR UNE LECTURE RÉUSSIE. Le dire sur une
    // panne ferait lire « Ajoutez votre premier logement » à un hôte qui en a
    // quatre — et, à l'onboarding, une réconciliation contre une liste amputée
    // CRÉE des biens en double chez le canal.
    return `<h2 class="h2" data-i18n="logements.vide_titre"></h2>
      <p class="muted" data-i18n="logements.vide_aide"></p>
      <div class="log-etat__actions">
        <a class="btn btn--primary" href="/pages/connexions" data-i18n="logements.vide_connecter"></a>
        <a class="btn btn--secondary" href="/biens/nouveau" data-i18n="logements.vide_manuel"></a>
      </div>`
  }
  if (quoi === 'refus') return `<p data-i18n="logements.refus"></p>`
  return `<p data-i18n="logements.panne"></p>
      <div class="log-etat__actions">
        <button type="button" class="btn btn--secondary" data-bind="reessayer" data-i18n="logements.reessayer"></button>
      </div>`
}
