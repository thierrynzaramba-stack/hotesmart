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

// ⚠ L'ECHELLE DE LA NOTE VIENT DE `shared/aujourdhui.js`, ELLE NE SE RECOPIE
// PAS. Le cœur stocke sur 10, l'ecran affiche sur 5 « partout » (decision de
// Thierry, lot 1) : deux divisions par deux dans deux fichiers finiraient par
// afficher 9,8 ici et 4,9 sur l'accueil pour le meme logement. Chemin RELATIF —
// le reste du depot ecrit `/shared/…`, qui ne se resout pas sous Node, et ce
// module doit se tester sans navigateur.
import { noteSur5 } from './aujourdhui.js'

// ─────────────────────────────────────────────────────────────────────────────
// Le fait daté
// ─────────────────────────────────────────────────────────────────────────────
//
// L'endpoint rend des FAITS (`type`, `du`, `au`) ; ici on choisit la phrase.
// Cinq cas, et un sixième qui n'est pas une phrase : `null` = on n'a pas pu
// lire, et ça ne se dit pas « Libre ».
//
// ⚠ LA CARTE DE LA LISTE NE L'AFFICHE PLUS (demande de Thierry, 20 octobre
// 2026 : « au lieu de Fermé jusqu'au mercredi 21 octobre, met les avis total
// sur le logement »). Ce qui a disparu de la carte avec la fermeture :
// « Occupé · départ le … », « Libre jusqu'au … » et « Libre · aucune arrivée
// prévue ». Le fait reste dans la réponse de l'endpoint, et la FICHE (étape 2)
// l'affiche — c'est pour ça que la règle reste ici, et qu'elle garde ses tests.
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
// ⚠ `actif` COMPTE AUTANT QUE `mappe`, et l'oublier etait un FAUX POSITIF
// COMMERCIAL. L'ecran d'aujourd'hui exige les deux (`shared/properties.js` :
// `active: c.actif === true && c.mappe === true`), et son commentaire dit
// pourquoi — defaut du 11 septembre 2026, un bien neuf affichait une pastille
// verte. Un canal eteint chez le partenaire (OAuth expire, canal desactive) sur
// un bien pourtant mappe ne vend RIEN : afficher « En vente » ferait croire a
// l'hote qu'il vend pendant que rien ne part. C'est le meme registre de mensonge
// que « Libre » sur un fait date non lu.
//
// QUATRE etats, donc, et c'est un de plus que la spec : elle n'avait pas prevu
// le canal eteint, parce que l'ecran d'aujourd'hui le nomme « — inactif » (D11)
// et que ce libelle devait disparaitre. Le FAIT, lui, reste.
const LIBELLES = {
  vente: 'logements.canal_en_vente',
  'canal-eteint': 'logements.canal_eteint',
  'pas-ce-bien': 'logements.canal_pas_ce_bien',
  indetermine: 'logements.canal_indetermine'
}

export function etatDuCanal (c) {
  if (c.mappe == null) return 'indetermine'
  if (c.mappe !== true) return 'pas-ce-bien'
  // `actif` absent de la reponse = on ne le sait pas : on ne degrade pas pour
  // autant, c'est `mappe` qui porte l'information principale.
  return c.actif === false ? 'canal-eteint' : 'vente'
}

export function pastillesDesCanaux (canaux) {
  if (canaux == null) return null       // on n'a pas pu lire
  return canaux.map(c => {
    const etat = etatDuCanal(c)
    return {
      ota: c.ota,
      // ⚠ LE LIBELLE DU CANAL, PAS SON SLUG. `canaux_du_bien.ota` est normalise
      // en minuscules par le writer : afficher `esc(c.ota)` donnait « airbnb »,
      // « booking », et « open » pour un canal direct. L'ecran d'aujourd'hui
      // traduit par une table, avec repli sur le TITRE que l'endpoint descend.
      label: libelleDuCanal(c),
      etat,
      titre: LIBELLES[etat]
    }
  })
}

// Les noms des canaux, tels que l'hote les connait. Meme table que
// `shared/properties.js` : deux copies divergeraient, donc celle-ci est
// comparee a l'autre par un test.
const OTA_LABELS = [
  { match: /airbnb/i, label: 'Airbnb' },
  { match: /booking/i, label: 'Booking.com' },
  { match: /expedia/i, label: 'Expedia' },
  { match: /vrbo|homeaway/i, label: 'Vrbo' }
]
export function libelleDuCanal (c) {
  return OTA_LABELS.find(o => o.match.test(c.ota || ''))?.label
    || c.titre || c.ota || 'Canal'
}

// ─────────────────────────────────────────────────────────────────────────────
// Les avis du logement — la note et le nombre TOTAL
// ─────────────────────────────────────────────────────────────────────────────
//
// Demande de Thierry du 20 octobre 2026. « TOTAL » qualifie la PÉRIODE : tous
// les avis du logement, pas la fenêtre de 30 jours de la fiche. L'endpoint rend
// trois nombres (`total`, `notes`, `moyenne`) et c'est ici qu'on choisit la
// phrase — quatre cas, et ils ne se confondent pas :
//
//   · `null` ET rien d'autre      on ne dit RIEN. Deux causes mènent à `null`,
//                                 et elles sont indiscernables au grain du
//                                 bien : on n'a pas pu lire, ou on n'a pas le
//                                 DROIT. « On ne montre jamais ce qui mène à un
//                                 refus » (règle de Thierry du 20 octobre) ;
//   · `null` + `indisponible`     là, le motif est connu et ce n'est pas un
//                                 refus : la réponse porte `indisponibles:
//                                 ['avis']`, un fait du COMPTE. On le dit, muet ;
//   · `total: 0`                  lu, et vide. « Aucun avis » est une RÉPONSE ;
//   · des avis                    la note sur 5 et le compte.
//
// ⚠ `total: 0` NE SE CONFOND PAS AVEC `null`. Afficher « Aucun avis » sur un
// logement qui en a 336 est le même mensonge que « Libre » sur un bien complet :
// c'est la règle qui tient tout ce lot.
//
// ⚠ ET UNE MOYENNE ABSENTE N'EST PAS UNE MOYENNE DE ZÉRO. Mesuré en production
// le 20 octobre 2026 : les cinq avis DIRECTS n'ont pas de note (le cœur stocke
// `overall_score` brut, et un avis direct n'en porte pas). La bulle a 336 avis
// visibles pour 332 notés — on montre le total, et l'étoile seulement si une
// note existe.
export function avisAffiche (avis, { indisponible = false } = {}) {
  if (avis == null) {
    return indisponible
      ? { etat: 'inconnu', cle: 'logements.avis_non_lus', valeurs: null, muet: true }
      : null
  }
  const total = Number(avis.total)
  // Une réponse mal formée se traite comme « non lu », jamais comme « aucun » :
  // c'est le même raisonnement que `Array.isArray` dans `etatDeLaPage`.
  if (!Number.isFinite(total)) {
    return { etat: 'inconnu', cle: 'logements.avis_non_lus', valeurs: null, muet: true }
  }
  if (!total) return { etat: 'aucun', cle: 'logements.avis_aucun', valeurs: null, muet: true }
  const note = noteSur5(avis.moyenne)
  if (note == null) return { etat: 'sans-note', cle: 'logements.avis_sans_note', valeurs: { n: total } }
  return { etat: 'note', cle: 'logements.avis', valeurs: { n: total, note } }
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
// ⚠ L'ECHEC DU RELEVE N'EST PLUS UN SIGNAL DE CARTE (constat de la revue du
// 20 octobre). Il est au grain du COMPTE — une seule ligne `canaux_releve` —
// donc il s'affichait a l'identique sur les quatre cartes, et sans son bouton.
// C'est la decision de Thierry du 19 octobre, ecrite en tete de
// `shared/properties.js` : « IL S'AFFICHE UNE SEULE FOIS, EN HAUT DE LA PAGE.
// Repeter le meme message sous chacune des cartes dirait dix fois la meme chose
// et laisserait croire a dix pannes. Le bouton « Actualiser » accompagne ce
// message, puisqu'il porte la meme action. »
//
// Effet de bord qui achevait de le rendre faux : « un seul signal » faisait que
// la pause MASQUAIT l'echec sur les biens en pause et pas sur les autres — le
// meme fait de compte apparaissait donc sur certaines cartes seulement.
export function signalDuBien (bien) {
  if (bien.assistant_en_pause === true) return { cle: 'logements.signal_pause', icone: 'i-pause' }
  return null
}

// Un seul echec pour tout le compte : il suffit qu'un bien le porte. Meme
// regle que `releveEnEchec` de `shared/properties.js`.
export function releveDuCompteEnEchec (biens) {
  return (biens || []).some(b => b && b.canaux_echec === true)
}

// ⚠ LA MEME REGLE DES 24 HEURES que `shared/properties.js` (dette 59, decision
// de Thierry) : au-dela, on DIT que la verification est vieille au lieu de
// laisser croire que c'est a jour — et c'est la seule circonstance ou le bouton
// « Actualiser » apparait. Un test compare les deux valeurs, pour qu'elles ne
// divergent pas.
export const VIEUX_MS = 24 * 3600 * 1000

// La fraicheur la plus ANCIENNE du compte : c'est elle qui decide. Montrer la
// plus recente ferait passer pour frais un releve dont la moitie date.
export function fraicheurDuCompte (biens, maintenant = Date.now()) {
  const dates = (biens || []).map(b => b && b.canaux_vu_le).filter(Boolean)
    .map(d => Date.parse(d)).filter(Number.isFinite)
  if (!dates.length) return null
  const plusAncien = Math.min(...dates)
  return { quand: new Date(plusAncien).toISOString(), vieux: (maintenant - plusAncien) >= VIEUX_MS }
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
  // ⚠ `Array.isArray`, pas `== null` : une reponse mal formee (`{}`, un objet,
  // une chaine) retombait sur « vide », donc sur « Ajoutez votre premier
  // logement ». C'est le dernier trou de la regle qui fait tout ce lot.
  if (!Array.isArray(biens)) return 'panne'
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
// ⚠ LES OUTILS SONT INJECTÉS (`t`, `esc`, `icone`, `nombre`) : ce module ne
// connaît ni `window.I18n`, ni le DOM. Il rend une chaîne, et c'est tout — donc
// il se teste sans navigateur et sans monter la page.
//
// ⚠ `dateEnClair` A QUITTÉ LE RENDU avec le fait daté, et son utilitaire
// (`valeursEnClair`) aussi : une fonction que plus personne n'appelle est du
// code dormant, et ce lot en SUPPRIME (spec §1). `faitDateAffiche`, elle, reste
// — elle porte une règle métier éprouvée (« `null` ne devient jamais Libre »)
// que la fiche consomme à l'étape 2, et la réécrire serait la perdre.

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
  // ⚠ L'ETAT SE LIT SANS LA COULEUR NI LE SURVOL (constat de la revue). A 8 px,
  // un rond en pointilles et un rond en trait plein sont indiscernables, et il
  // n'y a pas de survol au doigt : le quatrieme etat — celui que la dette 59 a
  // ouvert — n'etait donc pas lisible sur un telephone, ni pour un lecteur
  // d'ecran. `.sr-only` porte le libelle, `title` reste pour la souris.
  return pastilles.map(p =>
    `<span class="log-pastille log-pastille--${p.etat}" data-ota="${esc(p.ota)}" data-etat="${p.etat}" title="${esc(t(p.titre))}">`
    + `<span class="log-point"></span>${esc(p.label)}`
    + `<span class="sr-only"> — ${esc(t(p.titre))}</span></span>`).join('')
}

// ⚠ L'ETOILE SEULEMENT S'IL Y A UNE NOTE, et le libelle complet pour le lecteur
// d'ecran : une icone `aria-hidden` suivie de « 4,9 · 336 avis » se lit
// « quatre virgule neuf, trois cent trente-six avis », ce qui est juste. Mais
// une note SANS son unite ne dit pas sur quelle echelle elle est : `title`
// porte l'echelle pour la souris, `.sr-only` pour la voix.
export function avisHtml (bien, outils) {
  const { t, esc, icone, nombre } = outils
  const dit = avisAffiche(bien.avis, { indisponible: outils.avisIndisponibles === true })
  if (!dit) return ''
  // ⚠ `{}`, JAMAIS `null`. Le moteur du depot declare `t(key, vars = {})` : le
  // defaut ne couvre que `undefined`, et sa reduction des pluriels lit
  // `vars[cle]` sans garde. Passer `null` levait « Cannot convert undefined or
  // null to object » — donc une carte dont les avis ne sont pas lus faisait
  // tomber TOUTE la liste dans l'etat « panne ». Trouve par le test de la page.
  const valeurs = dit.valeurs
    ? { ...dit.valeurs, ...(dit.valeurs.note != null ? { note: nombre(dit.valeurs.note) } : {}) }
    : {}
  const etoile = dit.etat === 'note' ? icone('i-review', 'icon icon--fill') : ''
  return `<div class="log-avis${dit.muet ? ' log-avis--muet' : ''} caption" data-avis="${dit.etat}">`
    + `${etoile}${esc(t(dit.cle, valeurs))}</div>`
}

export function carteHtml (bien, outils) {
  const { t, esc, icone } = outils
  const signal = signalDuBien(bien)
  const sous = sousTitre(bien)
    .map(x => x.texte != null ? esc(x.texte) : esc(t(x.cle, x.valeurs)))
    .join(' · ')
  const photo = bien.photo_url
    ? `<img src="${esc(bien.photo_url)}" alt="" loading="lazy">`
    : icone('i-home', 'icon')

  return `<article class="log-carte" data-bien="${esc(bien.id)}">
    <div class="log-photo">${photo}</div>
    <div class="log-texte">
      <div class="log-nom">${esc(bien.nom || '')}</div>
      ${sous ? `<div class="log-sous caption">${sous}</div>` : ''}
    </div>
    <div class="log-canaux">${canauxHtml(bien, outils)}</div>
    ${avisHtml(bien, outils)}
    ${signal ? `<div class="log-signal-ligne"><span class="log-signal" data-signal>${icone(signal.icone, 'icon')}${esc(t(signal.cle))}</span></div>` : ''}
  </article>`
}

// Le contenu de la zone d'état, pour les trois situations qui ne sont pas une
// liste. Les textes passent par `data-i18n` : la page les traduit après
// insertion, comme partout dans la V5.
export function etatHtml (quoi, { peutAjouter = false } = {}) {
  if (quoi === 'vide') {
    // ⚠ CE MESSAGE NE S'AFFICHE QUE SUR UNE LECTURE RÉUSSIE. Le dire sur une
    // panne ferait lire « Ajoutez votre premier logement » à un hôte qui en a
    // quatre — et, à l'onboarding, une réconciliation contre une liste amputée
    // CRÉE des biens en double chez le canal.
    // ⚠ LES DEUX ACTIONS SONT GARDEES PAR LE DROIT (constat de la revue). Elles
    // menent a `/pages/connexions` et `/biens/nouveau`, DEUX pages classees NON
    // DELEGABLES : un membre delegue dont le perimetre est vide y verrait ses
    // PROPRES cles en croyant regler le compte consulte, et le POST de creation
    // le refuserait en 403. La regle de Thierry du 20 octobre : « on ne montre
    // jamais ce qui mene a un refus » — et c'est l'argument que ce meme fichier
    // applique deja au bouton « Reessayer » d'un refus de droit.
    return `<h2 class="h2" data-i18n="logements.vide_titre"></h2>
      <p class="muted" data-i18n="${peutAjouter ? 'logements.vide_aide' : 'logements.vide_aide_membre'}"></p>
      ${peutAjouter ? `<div class="log-etat__actions">
        <a class="btn btn--primary" href="/pages/connexions" data-i18n="logements.vide_connecter"></a>
        <a class="btn btn--secondary" href="/biens/nouveau" data-i18n="logements.vide_manuel"></a>
      </div>` : ''}`
  }
  if (quoi === 'refus') return `<p data-i18n="logements.refus"></p>`
  return `<p data-i18n="logements.panne"></p>
      <div class="log-etat__actions">
        <button type="button" class="btn btn--secondary" data-bind="reessayer" data-i18n="logements.reessayer"></button>
      </div>`
}
