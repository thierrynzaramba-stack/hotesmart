// ═══════════════════════════════════════════════════════════════════════════
// LA FICHE D'UN LOGEMENT — les règles d'affichage, partagées par les deux
// versions de l'écran (ordinateur et téléphone)
// ═══════════════════════════════════════════════════════════════════════════
//
// Étape 2 du lot « Logements V5 » (docs/specs/logements-v5/). LECTURE SEULE :
// aucun bouton n'agit ici, les actions sont l'étape 3. Ce module rend des CLÉS
// i18n et des valeurs ; la page traduit et met en forme.
//
// ⚠ IL RÉUTILISE `shared/logements-liste.js`, il ne le recopie pas. Les
// pastilles de canaux, le fait daté et la ligne d'avis sont les MÊMES qu'en
// liste — c'est la raison d'être du module commun, et la règle du dépôt : « une
// règle partagée vit dans un module commun, jamais recopiée dans chaque page :
// deux copies divergent ».
//
// ⚠ QUATRE ÉTATS PAR BLOC, comme l'endpoint les rend :
//   · `null` + nom dans `indisponibles`  on n'a PAS PU lire → on le dit, muet ;
//   · `null` + nom dans `refuses`        pas le droit → le bloc n'est pas rendu
//                                        DU TOUT (règle de Thierry du 20 oct. :
//                                        « on ne montre jamais ce qui mène à un
//                                        refus ») ;
//   · `[]` / `{connue:false}` / `0`      lu, et vide. C'est une RÉPONSE ;
//   · données                            on affiche.
import { canauxHtml, faitDateAffiche, avisHtml, sousTitre, fraicheurDuCompte, releveDuCompteEnEchec,
  pastillesDesCanaux,
  signalDuBien } from './logements-liste.js'

// ─────────────────────────────────────────────────────────────────────────────
// Le prix
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ LE PLANCHER VIDE SE DIT « 10 € (par défaut) » (décision de Thierry, recette
// du 20 octobre 2026). `properties.prix_minimum` est nullable, et le moteur
// applique alors un repli de 10 € — écrit dans docs/kb/prix-plancher.md. Ne
// rien afficher laisserait croire qu'aucun plancher ne protège le bien, alors
// que c'est la garde qui empêche une nuit de partir à zéro.
export const PLANCHER_PAR_DEFAUT = 10

export function plancherAffiche (bien) {
  const v = Number(bien && bien.prix_plancher)
  return Number.isFinite(v) && v > 0
    ? { montant: v, parDefaut: false }
    : { montant: PLANCHER_PAR_DEFAUT, parDefaut: true }
}

// ⚠ LE SÉLECTEUR DE MODE N'APPARAÎT QUE SI LE BIEN EST EN `keep` (spec §3.2) :
// « une fois en `managed`, le sélecteur disparaît ». C'est une bascule qui ne se
// défait pas — reproposer « Je garde mes prix actuels » à un bien déjà piloté
// serait offrir un retour en arrière qui n'existe pas.
//
// ⚠ ET `pilote_tarifaire` EST UNE COLONNE TEXTE À TROIS VALEURS, pas un booléen
// (constat H1 de la revue de l'étape 0) : 'calendrier', 'yieldflow', ou rien.
// La lire `=== true` la rendait fausse pour les deux biens que YieldFlow pilote.
export function prixAffiche (bien) {
  const mode = String((bien && bien.mode_des_prix) || '').toLowerCase()
  const plancher = plancherAffiche(bien)
  return {
    mode,
    modeCle: mode === 'managed' ? 'fiche.prix_mode_managed' : 'fiche.prix_mode_keep',
    // Le choix ne se montre que tant qu'il reste à faire.
    choixPossible: mode === 'keep',
    base: bien && bien.prix_de_base != null ? Number(bien.prix_de_base) : null,
    plancher: plancher.montant,
    plancherParDefaut: plancher.parDefaut,
    devise: (bien && bien.devise) || 'EUR',
    voyageursInclus: bien && bien.voyageurs_inclus != null ? Number(bien.voyageurs_inclus) : null,
    supplement: bien && bien.supplement_voyageur != null ? Number(bien.supplement_voyageur) : null,
    pilote: (bien && bien.pilote_tarifaire) || null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supprimer ce logement
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ ON S'ALIGNE SUR LE SERVEUR, C'EST LUI LA VRAIE PROTECTION (décision de
// Thierry du 21 octobre 2026, spec §3.4 corrigée). La spec d'origine disait
// « désactivé si le bien a des réservations ou des messages » — ce n'est PAS ce
// que `api/channel-property.js` refuse : il PURGE les réservations et les
// messages, et refuse un bien encore RELIÉ À UNE ANNONCE. Afficher la règle
// d'origine aurait promis un refus là où le serveur accepte, et l'inverse.
//
// ⚠ `possible: null` DÉSACTIVE AUSSI (constat H4 de la revue de l'étape 0) : si
// on n'a pas pu lire les canaux, on ne sait pas si le bien est en vente. Ouvrir
// l'action la plus destructrice du produit sur une lecture ratée est le seul
// cas qu'on ne peut pas se permettre.
// ⚠ LES MOTIFS SONT CEUX DU SERVEUR, AU CARACTÈRE PRÈS (revue de 5c0d759).
// Cette table disait `relie` ; `suppressionPossible` de lib/logement/lecture.js
// écrit `annonce_reliee`. La seule raison que Thierry avait demandée —
// « Déconnectez d'abord ses canaux » — ne s'affichait donc JAMAIS : elle
// tombait dans le fourre-tout « Impossible de vérifier ses canaux », qui est
// faux. Et les trois tests passaient, parce qu'ils posaient eux-mêmes la
// fixture `relie` : ils mesuraient leur propre double.
//
// `tests/logement-fiche-dom.test.js` DÉCOUVRE désormais les motifs dans le
// source du serveur et refuse qu'un seul tombe dans le fourre-tout.
export const MOTIFS = {
  annonce_reliee: 'fiche.supprimer_relie',       // le bien est encore en vente
  canaux_illisibles: 'fiche.supprimer_inconnu',  // on n'a pas pu lire
  mapping_inconnu: 'fiche.supprimer_inconnu',    // un canal au mappage incertain
  // ⚠ CE MOTIF S'APPELLE `jamais_releve` MAIS SE DÉCLENCHE SUR « AUCUN
  // CANAL ». Sa condition serveur — `!canaux.length && !vuLe` — dégénère en
  // `!canaux.length`, puisque `fraicheurDuBien` rend `null` dès qu'un bien
  // n'a aucun canal. Le texte dit donc ce qui est VRAI, pas ce que le nom
  // suggère. Mesuré en re-revue de 3dddb14 ; le nom se corrige côté serveur,
  // c'est une dette.
  jamais_releve: 'fiche.supprimer_jamais_releve'
}

// `droit_refuse` n'a PAS de message : il EFFACE le bloc. On ne montre jamais
// ce qui mène à un refus — a fortiori l'action la plus destructrice du produit.
export const MOTIFS_QUI_EFFACENT = ['droit_refuse']

export function suppressionAffiche (suppression) {
  if (!suppression || suppression.possible !== true) {
    const motif = suppression && suppression.motif
    return {
      active: false,
      motif: motif || null,
      cle: MOTIFS[motif] || 'fiche.supprimer_inconnu'
    }
  }
  return { active: true, motif: null, cle: 'fiche.supprimer_aide' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Les pouces de propreté
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ VERT ET ROUGE, COMME L'ÉCRAN MÉNAGES, ET SANS LÉGENDE (correction de
// Thierry du 21 octobre 2026, qui remplace la couleur neutre livrée la veille) :
// « vert OK, rouge problème ». Ces deux chiffres comptent le travail de ménage,
// pas la satisfaction générale : ils vivent donc dans le bloc Ménage, avec les
// classes de cet écran-là (voir `propreteHtml`). « Juste le compteur, sans
// légende » — le libellé des pouces suffit, une phrase d'explication sous
// chaque chiffre encombre une colonne déjà dense.
//
// ⚠ ET « PAS ENCORE ANALYSÉ » N'EST PAS « RIEN SIGNALÉ ». Les confondre
// afficherait un pouce vert pour un avis qu'on n'a pas lu — c'est la règle que
// l'endpoint porte déjà, l'écran ne doit pas la défaire.
//
// ⚠ ET UNE RÉPONSE MAL FORMÉE SE TRAIT COMME « PAS LU », JAMAIS COMME « AUCUN »
// (revue de f1d6cbd). `Number(x) || 0` ramenait tout à zéro : avec `avis = {}`,
// `'oui'` ou `42`, le bloc Ménage AFFIRMAIT « Aucun avis sur 30 jours » pendant
// que le bloc Avis, lui, disait « pas lisibles ». Deux états pour une seule
// source, et c'est le Ménage qui inventait. `avisAffiche` porte déjà cette
// garde pour la note (`!Number.isFinite(total)` → « non lu ») ; il manquait sa
// moitié ici. Les quatre compteurs descendent TOUJOURS ensemble du serveur
// (`lireAvis`), donc exiger les quatre n'écarte aucune réponse légitime.
export function poucesAffiches (avis) {
  if (!avis || typeof avis !== 'object' || Array.isArray(avis)) return null
  const fini = (x) => Number.isFinite(Number(x))
  if (!['positif', 'remarque', 'rien_signale', 'non_analyses'].every(c => fini(avis[c]))) return null
  const n = (x) => Number(x) || 0
  return {
    positif: n(avis.positif),
    remarque: n(avis.remarque),
    enAttente: n(avis.non_analyses),
    jours: n(avis.proprete_sur_jours) || n(avis.fenetre_jours) || 30,
    // Lu, et rien à montrer : on le dit plutôt que d'afficher trois zéros.
    vide: n(avis.positif) + n(avis.remarque) + n(avis.non_analyses) === 0,
    // ⚠ ET « RIEN SIGNALÉ » N'EST PAS « AUCUN AVIS » (revue de 5c0d759).
    // `rien_signale` n'entrait dans aucune somme : quatre avis lus, tous sans
    // remarque, disaient la MÊME phrase qu'une fenêtre sans aucun avis. C'est
    // le pli que tout ce lot refuse ailleurs — « lu, et vide » est une
    // RÉPONSE, distincte de « on n'a rien ».
    rienSignale: n(avis.rien_signale),
    aucunAvis: n(avis.positif) + n(avis.remarque) + n(avis.non_analyses) + n(avis.rien_signale) === 0
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ce que la page affiche à la place de la fiche
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ UN BIEN INTROUVABLE (404) NE SE DIT PAS « PANNE ». La garde de l'endpoint
// rend 404 sans distinguer « n'existe pas » de « ne vous appartient pas » :
// l'écran ne doit pas être plus bavard qu'elle.
export function etatDeLaPage ({ erreur = null, fiche = null } = {}) {
  if (erreur) {
    if (erreur.status === 403) return 'refus'
    if (erreur.status === 404) return 'introuvable'
    return 'panne'
  }
  // Une réponse mal formée retombe sur « panne », jamais sur une fiche vide :
  // même raisonnement que `Array.isArray` dans la liste.
  if (!fiche || typeof fiche !== 'object' || !fiche.bien) return 'panne'
  return 'fiche'
}

// ═══════════════════════════════════════════════════════════════════════════
// LE RENDU
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ ICI ET PAS DANS LA PAGE : un rendu écrit dans la balise `<script>` d'un
// fichier HTML ne se teste qu'en extrayant son code à la regex. Même choix
// qu'à l'étape 1, et que `core/avis/cartes.js` avant elle.
//
// Les outils sont injectés (`t`, `esc`, `icone`, `nombre`, `argent`,
// `dateEnClair`) : ce module ne connaît ni `window.I18n`, ni le DOM.

// Un bloc de la fiche, avec son titre. `null` ne rend RIEN quand le bloc est
// refusé — c'est la règle, et elle vaut pour les sept.
function bloc (cle, corps, { t, esc }, extra = '') {
  if (corps == null) return ''
  return `<section class="fic-bloc"${extra}>`
    + `<h2 class="fic-bloc__titre h3">${esc(t(cle))}</h2>${corps}</section>`
}

// Un bloc qu'on n'a pas pu lire : on le DIT, muet. Ne rien afficher le ferait
// passer pour vide — « aucune prestataire » sur un bien qui en a deux.
function nonLu (cle, outils) {
  const { t, esc } = outils
  return `<p class="fic-muet caption" data-non-lu>${esc(t(cle))}</p>`
}

// ─── En-tête ────────────────────────────────────────────────────────────────
// ⚠ L'ASSISTANT EN PAUSE SE DIT (constat de la capture du 21 octobre 2026).
// `assistant_en_pause` est descendu par l'endpoint depuis l'étape 0 et la
// fiche n'en disait rien, alors que la LISTE le signale sur chaque carte. Un
// hôte qui ouvre la fiche d'un bien en pause y lisait un bien ordinaire —
// aucun message ne part pour ce logement, et l'écran le taisait.
//
// ⚠ C'EST UN ÉTAT, PAS L'INTERRUPTEUR. La spec met un interrupteur dans
// l'en-tête ; il agit, donc il est de l'étape 3. Dire l'état est de la
// lecture, et c'est ce qui manquait.
export function signalHtml (fiche, { t, esc, icone }) {
  const s = signalDuBien(fiche.bien || {})
  if (!s) return ''
  return `<p class="fic-signal caption" data-signal="pause">`
    + `${icone(s.icone, 'icon')}<span>${esc(t(s.cle))}</span></p>`
}

// ⚠ LE LIEN VERS LE CALENDRIER DU BIEN (spec §3, en-tête). C'est un lien, donc
// de la lecture : il a sa place à l'étape 2. La cible est la route DÉCLARATIVE
// de `vercel.json` — `/calendrier?bien=:id` —, honorée par la V5 : le bien
// demandé s'affiche en tête.
export function calendrierHtml (fiche, { t, esc, icone }) {
  const id = fiche.bien && fiche.bien.id
  if (!id) return ''
  return `<p class="fic-liens"><a class="btn btn--secondary" href="/calendrier?bien=${encodeURIComponent(id)}" data-bind="calendrier">`
    + `${icone('i-calendar', 'icon')}<span>${esc(t('fiche.voir_calendrier'))}</span></a></p>`
}

// ⚠ PAS DE PASTILLES DANS L'EN-TETE (decision de Thierry, 21 octobre 2026).
// La spec §3 les y mettait, et le bloc « Ou il est en vente » les porte AUSSI,
// a cent pixels d'ecart : la meme information deux fois, dont une sans son
// etat ni sa date. Le bloc garde l'information COMPLETE — pastilles, etat et
// « Canaux verifies le … » —, l'en-tete garde le nom, le sous-titre et le fait
// date. Point signale en recette, tranche par Thierry.
// ─── Les deux actions de l'en-tête ─────────────────────────────────
//
// ⚠ L'INTERRUPTEUR REMPLACE LA LIGNE D'ÉTAT, il ne s'y ajoute pas. `signalHtml`
// dit déjà « Assistant en pause » — la même phrase que la carte de la liste — et
// l'interrupteur porte cet état dans son `aria-checked` et son libellé. Les deux
// ensemble diraient la même chose deux fois dans le même en-tête.
//
// ⚠ UN VRAI INTERRUPTEUR (`role="switch"`), pas deux boutons qui s'échangent :
// un lecteur d'écran annonce alors « Assistant HôteSmart, activé » et le
// changement d'état, là où un bouton qui change de nom l'oblige à deviner.
export function assistantHtml (fiche, outils, { peutModifier = false } = {}) {
  const { t, esc, icone } = outils
  if (!peutModifier) return signalHtml(fiche, outils)
  const enPause = (fiche.bien || {}).assistant_en_pause === true
  return `<p class="fic-assistant caption" data-assistant="${enPause ? 'pause' : 'actif'}">
    <button type="button" class="fic-bascule" role="switch" aria-checked="${enPause ? 'false' : 'true'}"
      data-bind="assistant" data-en-pause="${enPause ? '1' : ''}">
      <span class="fic-bascule__piste" aria-hidden="true"><span class="fic-bascule__rond"></span></span>
      <span>${esc(t('fiche.assistant'))}</span>
    </button>
    <span class="fic-muet" data-assistant-etat>${esc(t(enPause ? 'fiche.assistant_pause' : 'fiche.assistant_actif'))}</span>
    ${enPause ? `<span class="fic-muet">${icone('i-pause', 'icon')}</span>` : ''}
    <span class="fic-sauve caption" data-etat aria-live="polite"></span>
    <span class="fic-erreur caption" data-erreur hidden></span>
  </p>`
}

// ⚠ LE DÉCLENCHEUR EST UN `<label>` SUR UN `<input type=file>`, et le champ
// reste dans le DOM (hors de l'œil) : un bouton qui ouvre le sélecteur par
// `click()` sur un champ absent ne s'ouvre pas au clavier, et sur iOS il ne
// s'ouvre pas du tout hors geste direct.
export function photoHtml (fiche, outils, { peutModifier = false } = {}) {
  const { t, esc, icone } = outils
  if (!peutModifier) return ''
  const aUnePhoto = !!(fiche.bien || {}).photo_url
  return `<div class="fic-photo__action">
    <label class="btn btn--secondary fic-photo__btn" for="fic-photo-champ">
      ${icone('i-photo', 'icon')}<span>${esc(t(aUnePhoto ? 'fiche.photo_changer' : 'fiche.photo_ajouter'))}</span>
    </label>
    <input type="file" id="fic-photo-champ" accept="image/*" class="sr-only" data-bind="photo">
    <span class="fic-sauve caption" data-etat aria-live="polite"></span>
    <p class="fic-erreur caption" data-erreur hidden></p>
  </div>`
}

export function enTeteHtml (fiche, outils, { peutModifier = false } = {}) {
  const { t, esc, icone } = outils
  const b = fiche.bien
  const sous = sousTitre(b)
    .map(x => x.texte != null ? esc(x.texte) : esc(t(x.cle, x.valeurs)))
    .join(' · ')
  const photo = b.photo_url
    ? `<img src="${esc(b.photo_url)}" alt="" loading="lazy">`
    : icone('i-home', 'icon')
  // ⚠ LE FAIT DATÉ VIT ICI (décision de Thierry du 20 octobre 2026) : il a
  // quitté la carte de la liste pour laisser place aux avis, et c'est la fiche
  // qui le porte. La règle d'affichage est celle du module commun — `null` ne
  // devient JAMAIS « Libre ».
  const fait = faitDateAffiche(fiche.fait_date)
  // Un fait partiel reste affiché — il est VRAI, il est seulement incomplet —
  // mais il le dit, et il passe en muet : l'encre normale est la marque d'un
  // fait vérifié.
  const partiel = outils.faitPartiel === true && !fait.muet && fiche.fait_date != null
  const faitTexte = fait.valeurs
    ? t(fait.cle, Object.fromEntries(Object.entries(fait.valeurs).map(([k, v]) => [k, outils.dateEnClair(v)])))
    : t(fait.cle)

  return `<header class="fic-entete">
    <div class="fic-entete__visuel">
      <div class="fic-photo">${photo}</div>
      ${photoHtml(fiche, outils, { peutModifier })}
    </div>
    <div class="fic-entete__texte">
      <h1 class="h2 fic-nom">${esc(b.nom || '')}</h1>
      ${sous ? `<p class="fic-sous caption">${sous}</p>` : ''}
      <p class="fic-fait${fait.muet || partiel ? ' fic-muet' : ''} caption" data-fait="${esc(fait.muet ? 'indisponible' : fiche.fait_date.type)}"${partiel ? ' data-partiel' : ''}>${esc(faitTexte)}${partiel ? ` ${esc(t('fiche.fait_partiel'))}` : ''}</p>
      ${assistantHtml(fiche, outils, { peutModifier })}
      ${calendrierHtml(fiche, outils)}
    </div>
  </header>`
}

// ─── 1. Où il est en vente ──────────────────────────────────────────────────
//
// ⚠ TROIS CANAUX AU MÊME RANG (spec §3.1), et l'état vient du MÊME calcul que
// la liste. Un canal relié mais éteint ne vend rien : le dire « En vente »
// serait le faux positif commercial du 11 septembre 2026.
// ⚠ QUAND LE RELEVÉ A ÉTÉ FAIT, ET S'IL A ÉCHOUÉ. Constat de la capture 1440
// du 21 octobre 2026 : l'endpoint descend `canaux_vu_le` et `canaux_echec`
// depuis l'étape 0, et la fiche n'en disait RIEN. Des pastilles « en vente »
// sans leur date laissent croire à un état d'aujourd'hui alors qu'il peut
// dater de trois jours — et un relevé en échec se lisait comme un succès.
//
// La liste porte ce fait dans un bandeau de compte, une seule fois en tête
// (décision de Thierry du 19 octobre) ; ici, un seul bien est à l'écran, donc
// la ligne vit sous ses pastilles. On RÉUTILISE les deux règles du module
// commun — dont la règle des 24 heures — au lieu de les réécrire.
//
// ⚠ `releveDuCompteEnEchec` ÉTAIT DU CODE DORMANT : exportée, testée, appelée
// par aucun écran. La spec §1 interdit le code dormant ; la fiche est son
// appelant.
export function fraicheurAffichee (fiche, maintenant = Date.now()) {
  // ⚠ UN BIEN SANS CANAL NE DIT RIEN DU TOUT — décision de Thierry du 19 octobre
  // 2026, et ce garde-fou la rend vraie PAR CONSTRUCTION. Recette du 23 octobre :
  // sur un logement neuf, « Canaux non vérifiés depuis … » s'affichait sous
  // « Aucun canal relié » — deux phrases qui se contredisent, dont l'une parle
  // d'une vérification qui n'avait pas ce logement à vérifier.
  //
  // La règle vaut AVANT l'échec : un relevé en panne ne dit rien non plus d'un
  // bien qu'il n'avait pas à regarder.
  if (Array.isArray(fiche && fiche.canaux) && fiche.canaux.length === 0) return null
  if (releveDuCompteEnEchec([fiche])) return { cle: 'fiche.canaux_echec', valeurs: null, echec: true }
  const f = fraicheurDuCompte([fiche], maintenant)
  if (!f) return null
  return {
    cle: f.vieux ? 'logements.fraicheur_vieille' : 'logements.fraicheur',
    valeurs: { quand: String(f.quand).slice(0, 10) }, echec: false, vieux: f.vieux
  }
}

// ⚠ UN LIEN VERS L'ASSISTANT EXISTANT, PAS UN ASSISTANT DE PLUS (spec §3.1 :
// « assistant de connexion existant, reprise OAuth Airbnb conservée »).
//
// ⚠ ET C'EST UN LIEN, PAS UN BOUTON QUI OUVRIRAIT LA FENÊTRE ICI. L'assistant a
// besoin de la CLÉ DU PARTENAIRE pour lister les canaux ; la fiche ne la descend
// pas, et ce lot ne commencera pas à la faire circuler. La page des connexions,
// elle, la connaît déjà : on lui passe l'UUID du bien, et elle ouvre l'assistant
// sur le bon logement.
//
// ⚠ UNE SEULE ACTION POUR LE BLOC, pas une par canal : l'assistant traite déjà
// chaque plateforme à l'intérieur, et une action par ligne ferait trois chemins
// vers la même fenêtre.
export function connecterHtml (fiche, outils, { peutModifier = false } = {}) {
  const { t, esc, icone } = outils
  if (!peutModifier) return ''
  const noms = canauxDeVente(fiche.canaux)
  const cle = (noms && noms.length) ? 'fiche.connexions_gerer' : 'fiche.connecter'
  const id = encodeURIComponent((fiche.bien || {}).id || '')
  return `<p class="fic-liens"><a class="btn btn--secondary" data-bind="connecter"
    href="/pages/connexions?bien=${esc(id)}">${icone('i-link', 'icon')}<span>${esc(t(cle))}</span></a></p>`
}

export function venteHtml (fiche, outils, { peutModifier = false } = {}) {
  const { t, esc, dateEnClair } = outils
  // ⚠ `Array.isArray`, PAS `!= null` (revue de 5c0d759). Un `{}` — réponse
  // tronquée, champ renommé côté serveur — passe `!= null`, son `.length` vaut
  // `undefined`, et « Aucun canal relié » s'affiche sur un bien qui en a deux.
  // C'est le trou que `etatDeLaPage` ferme au niveau de la PAGE ; il descend
  // ici, au grain du bloc.
  // ⚠ L'ACTION EXISTE MÊME QUAND LES CANAUX NE SE LISENT PAS : c'est par là
  // qu'on en relie un, et son utilité ne dépend pas de la réussite d'une
  // lecture. La taire sur une panne enfermerait l'hôte dans un écran qui ne
  // propose rien.
  const connecter = connecterHtml(fiche, outils, { peutModifier })
  if (!Array.isArray(fiche.canaux)) return `${nonLu('fiche.canaux_non_lus', outils)}${connecter}`
  const f = fraicheurAffichee(fiche)
  const ligne = !f ? ''
    : `<p class="fic-fraicheur caption${f.echec || f.vieux ? ' fic-fraicheur--alerte' : ''}"`
      + ` data-fraicheur="${f.echec ? 'echec' : (f.vieux ? 'vieille' : 'fraiche')}">`
      + `${esc(t(f.cle, f.valeurs ? { quand: dateEnClair(f.valeurs.quand) } : {}))}</p>`
  // ⚠ « Aucun canal relié » est rendu par `canauxHtml`, le module commun : le
  // redire ici laisserait la CARTE mentir le jour où l'une des deux
  // changerait.
  if (!fiche.canaux.length) return `<p class="fic-vide caption">${canauxHtml(fiche, outils)}</p>${ligne}${connecter}`
  // ⚠ `log-canaux`, LA CLASSE DU MODULE COMMUN (revue de 5c0d759). Le bloc
  // utilisait `fic-vente`, qui n'était déclaré NULLE PART : trois pastilles
  // bord à bord, bordures jointives, là où l'en-tête les espaçait. Le correctif
  // du commit précédent n'avait réparé que la moitié du défaut — et l'en-tête,
  // lui, recopiait les quatre propriétés sous un autre nom.
  return `<div class="log-canaux">${canauxHtml(fiche, outils)}</div>${ligne}${connecter}`
}

// ──────────────────────────────────────────────────────────────────────────────
// Les champs modifiables — une seule table, lue par l'écran ET par la page
// ──────────────────────────────────────────────────────────────────────────────
//
// ⚠ UNE SEULE DÉFINITION. Le nom du champ côté serveur, son libellé, son type,
// ses bornes et sa conversion vivent ICI. La page ne les redéclare pas : deux
// copies divergent, et c'est la règle du dépôt. C'est aussi ce qui garantit que
// le champ rendu et le champ envoyé portent le même nom.
//
// ⚠ `grille: true` MARQUE LES CHAMPS QUI RECONSTRUISENT LA GRILLE CHEZ LE
// PARTENAIRE. `PATCH /api/channel-property` reconstruit le plan tarifaire EN
// BLOQUANT dès que l'un d'eux est présent dans le corps — même inchangé. On ne
// les envoie donc QUE s'ils ont bougé : l'ancien écran le faisait déjà, et c'est
// la raison pour laquelle il les comparait un par un.
//
// ⚠ `euros: true` : à l'écran en EUROS, en base en CENTIMES. La conversion se
// fait aux deux bouts — c'est le défaut ×100 trouvé en revue de l'étape 2.
export const CHAMPS = [
  { nom: 'name', bloc: 'logement', cle: 'fiche.champ_nom', type: 'texte', max: 100,
    depuis: (b) => b.nom },
  { nom: 'capacity', bloc: 'logement', cle: 'fiche.champ_capacite', type: 'entier',
    min: 1, borne: 20, grille: true, depuis: (b) => b.capacite },
  { nom: 'address', bloc: 'logement', cle: 'fiche.champ_adresse', type: 'texte', max: 200,
    depuis: (b) => b.adresse },
  { nom: 'zip_code', bloc: 'logement', cle: 'fiche.champ_cp', type: 'texte', max: 20,
    depuis: (b) => b.code_postal },
  { nom: 'city', bloc: 'logement', cle: 'fiche.champ_ville', type: 'texte', max: 100,
    depuis: (b) => b.ville },
  // ⚠ UN CHOIX, PAS UN CODE A TAPER (recette de Thierry, 23 octobre 2026). La
  // case affichait « FR » : l'hote lit un code ISO la ou l'ecran de creation lui
  // propose « France ». Et il devait CONNAITRE le code pour en changer.
  // Memes six pays que la creation, memes cles.
  { nom: 'country', bloc: 'logement', cle: 'fiche.champ_pays', type: 'choix', max: 2,
    choix: [['FR', 'nouveau.pays_fr'], ['BE', 'nouveau.pays_be'], ['CH', 'nouveau.pays_ch'],
      ['ES', 'nouveau.pays_es'], ['IT', 'nouveau.pays_it'], ['PT', 'nouveau.pays_pt']],
    depuis: (b) => b.pays },
  { nom: 'base_price', bloc: 'prix', cle: 'fiche.prix_base', type: 'montant',
    grille: true, depuis: (b) => b.prix_de_base },
  // ⚠ LE PLANCHER NE SE PRÉREMPLIT PAS À 10. Son défaut est une garde du moteur,
  // pas une valeur du bien : l'écrire dans la case le ferait ENREGISTRER au
  // premier passage, et le bien porterait un plancher que personne n'a voulu.
  { nom: 'prix_minimum', bloc: 'prix', cle: 'fiche.prix_plancher', type: 'montant',
    euros: true, depuis: (b) => (b.prix_plancher != null ? b.prix_plancher : null) },
  { nom: 'included_guests', bloc: 'prix', cle: 'fiche.prix_inclus', type: 'entier',
    min: 1, grille: true, depuis: (b) => b.voyageurs_inclus },
  { nom: 'extra_guest_fee', bloc: 'prix', cle: 'fiche.prix_supplement', type: 'montant',
    grille: true, depuis: (b) => b.supplement_voyageur }
]

export function champsDuBloc (bloc) {
  return CHAMPS.filter(c => c.bloc === bloc)
}

// La valeur telle qu'elle s'affiche DANS LA CASE : jamais une valeur par
// défaut, jamais un montant formaté (une case se réécrit, elle ne se lit pas).
export function valeurDeSaisie (champ, bien) {
  const v = champ.depuis(bien || {})
  if (v == null || v === '') return ''
  return String(v)
}

// À qui l'envoi va vraiment — LES CANAUX DU BIEN, pas une phrase écrite une
// fois pour toutes (décision de Thierry du 21 octobre 2026).
//
// ⚠ LA RÈGLE D'ÉTAT EST IMPORTÉE, PAS RECOPIÉE : `pastillesDesCanaux` dit déjà
// ce qu'est « en vente », et c'est elle que les pastilles affichent juste
// au-dessus. Deux définitions finiraient par désigner deux ensembles
// différents, et la phrase promettrait un canal que l'écran dit éteint.
//
// ⚠ TROIS RÉPONSES, PAS DEUX. `null` = on n'a pas pu lire les canaux ; `[]` =
// lu, et aucun n'est en vente ; sinon leurs noms. C'est la règle de tout le lot,
// et ici elle décide d'une phrase qui annonce une écriture chez un tiers.
export function canauxDeVente (canaux) {
  const pastilles = pastillesDesCanaux(canaux)
  if (pastilles === null) return null
  return pastilles.filter(p => p.etat === 'vente').map(p => p.label)
}

// Le bouton d'envoi d'un bloc qui porte des champs de GRILLE.
//
// ⚠ PAS D'ENREGISTREMENT AUTOMATIQUE SUR CES CHAMPS-LÀ (décision de Thierry du
// 21 octobre 2026). Les quatre champs marqués `grille` font reconstruire le plan
// tarifaire CHEZ LE PARTENAIRE, en bloquant : ce qui part de cet écran ne
// s'arrête pas à notre base, il atteint les annonces. Un geste pareil se décide,
// il ne se déclenche pas en sortant d'une case — et la phrase sous le bouton le
// DIT, avant le clic.
//
// ⚠ LE BOUTON N'EST JAMAIS DÉSACTIVÉ. Un bouton grisé tant qu'aucun champ n'a
// bougé obligerait à cliquer DEUX fois : le premier clic sort de la case (donc
// active le bouton) sans l'atteindre. Il est toujours cliquable, et il dit
// « aucun changement à envoyer » quand il n'y a rien à faire.
// ⚠ UN BIEN SANS CANAL EN VENTE N'A PAS DE PHRASE (décision de Thierry) :
// rien ne part chez personne, et l'annoncer serait faux. L'envoi, lui, reste
// possible — il écrit notre base et le plan tarifaire du bien.
//
// ⚠ ET DES CANAUX ILLISIBLES NE SE TAISENT PAS. Ne rien dire ferait croire
// qu'aucune annonce n'est touchée, alors qu'on ne sait pas : on nomme ce qu'on
// sait — « vos plateformes connectées » — sans inventer lesquelles.
function aideDEnvoiHtml (fiche, outils) {
  const { t, esc, liste } = outils
  const noms = canauxDeVente(fiche && fiche.canaux)
  // ⚠ EN « JE GARDE MES PRIX », LA PHRASE DIT AUSSI CE QUI NE BOUGE PAS
  // (demande de Thierry du 22 octobre 2026). Ce qu'on envoie est la GRILLE
  // tarifaire — le serveur la reconstruit chez les plateformes quel que soit le
  // mode — mais la poussée nuit par nuit, elle, reste suspendue. Sans la
  // seconde phrase, l'hôte qui a choisi de garder ses prix lit « sera envoyé à
  // Airbnb » et croit qu'on écrase ses tarifs.
  const keep = String(((fiche || {}).bien || {}).mode_des_prix || '').toLowerCase() === 'keep'
  if (noms === null) {
    return `<p class="caption fic-muet" data-envoi-aide="inconnu">`
      + `${esc(t(keep ? 'fiche.envoi_inconnu_keep' : 'fiche.envoi_inconnu'))}</p>`
  }
  if (!noms.length) return ''
  return `<p class="caption fic-muet" data-envoi-aide="canaux">`
    + `${esc(t(keep ? 'fiche.envoi_canaux_keep' : 'fiche.envoi_canaux',
      { canaux: liste ? liste(noms) : noms.join(', ') }))}</p>`
}

function envoiHtml (bloc, fiche, outils) {
  const { t, esc } = outils
  // DÉFENSIF : aujourd'hui les deux seuls appelants sont les deux blocs qui
  // PORTENT des champs de grille, donc cette garde ne mord jamais (mutation
  // vérifiée le 21 octobre 2026 : la retirer ne change rien). Elle reste pour
  // qu'un troisième bloc, un jour, n'affiche pas un bouton sans objet.
  if (!champsDuBloc(bloc).some(c => c.grille)) return ''
  return `<div class="fic-envoi" data-envoi="${esc(bloc)}">
    <button type="button" class="btn" data-bind="enregistrer" data-bloc="${esc(bloc)}">
      ${esc(t('fiche.enregistrer'))}
    </button>
    ${aideDEnvoiHtml(fiche, outils)}
    <span class="fic-sauve caption" data-etat aria-live="polite"></span>
    <p class="fic-erreur caption" data-erreur hidden></p>
  </div>`
}

// Une ligne modifiable. Hors droit d'écriture, c'est la ligne de LECTURE de
// l'étape 2 qui est rendue — aucune case, aucun bouton, rien dans le DOM.
function ligneSaisieHtml (champ, bien, outils) {
  const { t, esc } = outils
  const id = `ch-${champ.nom}`
  const val = valeurDeSaisie(champ, bien)
  const numerique = champ.type === 'entier' || champ.type === 'montant'
  const attrs = [
    `id="${id}"`, `name="${esc(champ.nom)}"`, `data-champ="${esc(champ.nom)}"`,
    `value="${esc(val)}"`, 'class="fic-saisie"', 'autocomplete="off"',
    numerique ? 'inputmode="decimal"' : '',
    champ.type === 'entier' ? 'inputmode="numeric"' : '',
    champ.max != null && !numerique ? `maxlength="${champ.max}"` : '',
    champ.grille ? 'data-grille="1"' : '',
    champ.euros ? 'data-euros="1"' : ''
  ].filter(Boolean).join(' ')
  // ⚠ UN CHOIX SE REND EN `select`, ET IL PORTE LES MEMES REPERES QUE L'INPUT
  // (`data-champ`, `fic-saisie`) : la page ecoute `change` sur `[data-champ]`,
  // et un `select` emet `change` comme un champ de texte. Le cablage
  // d'enregistrement ne bouge donc pas.
  const saisie = champ.type === 'choix'
    ? `<select id="${id}" name="${esc(champ.nom)}" data-champ="${esc(champ.nom)}" class="fic-saisie">`
      + champ.choix.map(([code, cle]) =>
        `<option value="${esc(code)}"${String(val) === code ? ' selected' : ''}>${esc(t(cle))}</option>`).join('')
      + '</select>'
    : `<input ${attrs}>`
  return `<div class="fic-ligne fic-ligne--saisie" data-ligne="${esc(champ.nom)}">
    <label class="fic-ligne__cle caption" for="${id}">${esc(t(champ.cle))}</label>
    <span class="fic-ligne__val">${saisie}</span>
    <span class="fic-sauve caption" data-etat aria-live="polite"></span>
    <p class="fic-erreur caption" data-erreur hidden></p>
  </div>`
}

// « Publier mes prix » : quand, et pourquoi pas.
//
// ⚠ JAMAIS SUR UN BIEN PILOTÉ PAR YIELDFLOW. C'est écrit dans l'endpoint de
// lecture, et c'est la raison d'être de `piloteDuBien` : proposer la
// publication sur un bien piloté mettrait DEUX écrivains de prix sur la même
// nuit. L'app de tarification pousse déjà ses prix ; ce bouton-là n'a rien à
// faire ici.
//
// ⚠ ET JAMAIS EN MODE « JE GARDE MES PRIX » : le serveur refuse la mise en file
// (`RATE_PUSH_BLOCKED`), donc le bouton mènerait à un refus certain.
// ⚠ LA RÉPONSE DU SERVEUR D'ABORD (constat de la recette de Thierry du
// 22 octobre 2026). L'écran déduisait « publiable » du mode et du pilote — les
// deux seules choses qu'il voit — et proposait le bouton sur un bien SANS
// AUCUN CANAL : le serveur rendait alors 400 « Bien non connecté au canal (ids
// manquants) », un message interne, pour un geste qu'on n'aurait pas dû offrir.
// Les identifiants du partenaire, qui tranchent, ne descendent pas ici — et ne
// doivent pas. `fiche.publication` porte donc la réponse, calculée là où la
// donnée est.
//
// La déduction locale reste en REPLI, pour une réponse qui ne porterait pas
// encore le champ : elle est moins bonne, pas fausse.
export function publierAffiche (bien, publication = null) {
  if (publication && typeof publication === 'object' && 'possible' in publication) {
    return { montre: publication.possible === true, motif: publication.motif || null }
  }
  const mode = String((bien && bien.mode_des_prix) || '').toLowerCase()
  if (mode !== 'managed') return { montre: false, motif: 'mode_keep' }
  if (((bien && bien.pilote_tarifaire) || '') === 'yieldflow') {
    return { montre: false, motif: 'pilote' }
  }
  return { montre: true, motif: null }
}

// ─── 2. Prix ────────────────────────────────────────────────────────────────
export function prixHtml (fiche, outils, { peutModifier = false } = {}) {
  const { t, esc, argent, nombre } = outils
  const p = prixAffiche(fiche.bien)
  const ligne = (cle, valeur, extra = '') =>
    `<div class="fic-ligne"${extra}><span class="fic-ligne__cle caption">${esc(t(cle))}</span>`
    + `<span class="fic-ligne__val">${valeur}</span></div>`

  // ⚠ LE CHOIX NE S'AFFICHE QUE TANT QU'IL RESTE À FAIRE (spec §3.2) : une fois
  // le bien en « HôteSmart envoie mes prix », le sélecteur DISPARAÎT. Le retour
  // en arrière est refusé par le serveur dès qu'un canal est actif, et montrer
  // un choix qui sera refusé est ce que ce lot s'interdit.
  const modeHtml = (peutModifier && p.choixPossible)
    ? `<div class="fic-ligne fic-ligne--saisie" data-ligne="mode">
        <label class="fic-ligne__cle caption" for="fic-mode">${esc(t('fiche.prix_mode_choix'))}</label>
        <span class="fic-ligne__val"><select class="fic-saisie" id="fic-mode" data-bind="mode">
          <option value="keep" selected>${esc(t('fiche.prix_mode_keep'))}</option>
          <option value="managed">${esc(t('fiche.prix_mode_managed'))}</option>
        </select></span>
        <span class="fic-sauve caption" data-etat aria-live="polite"></span>
        <p class="fic-erreur caption" data-erreur hidden></p>
      </div>`
    : ''

  // ⚠ UN BIEN PILOTÉ N'A PAS DE BOUTON, MAIS IL A UNE PHRASE (décision de
  // Thierry du 21 octobre 2026). L'absence seule se lirait comme un oubli, ou
  // comme un droit manquant ; la phrase dit que les prix PARTENT, et qu'ils
  // partent tout seuls. Elle ne nomme ni l'app de tarification ni le partenaire
  // technique — ce sont des noms de l'intérieur, et l'hôte n'a pas à les
  // connaître pour comprendre ce qui se passe sur ses annonces.
  //
  // ⚠ ET ELLE S'AFFICHE SANS CONDITION DE DROIT : c'est un ÉTAT du bien, pas
  // une action. La taire à un profil en lecture lui laisserait croire que ses
  // prix dorment.
  const pub = publierAffiche(fiche.bien, fiche.publication)
  const publierHtml = pub.motif === 'pilote'
    ? `<p class="fic-publier caption fic-muet" data-publier="automatique">${esc(t('fiche.prix_automatique'))}</p>`
    : ((outils.peutPublier === true && pub.montre)
      ? `<div class="fic-publier" data-publier>
          <button type="button" class="btn" data-bind="publier">${esc(t('fiche.publier'))}</button>
          <span class="fic-sauve caption" data-etat aria-live="polite"></span>
          <p class="fic-erreur caption" data-erreur hidden></p>
        </div>`
      : '')

  if (peutModifier) {
    // ⚠ LA DEVISE RESTE EN LECTURE, MÊME AVEC LE DROIT D'ÉCRITURE. `PATCH` ne
    // l'accepte pas — elle n'est pas dans son contrat — et l'ancien écran le
    // disait déjà : « devise non editable ». Une case qu'on ne peut pas
    // enregistrer est un leurre.
    //
    // ⚠ ET LE PLANCHER DIT SON DÉFAUT SOUS LA CASE, pas DANS la case : le
    // préremplir l'enregistrerait au premier passage.
    const vide = p.plancherParDefaut
      ? `<p class="fic-aide caption" data-plancher-defaut>${esc(t('fiche.prix_plancher_defaut',
        { montant: argent(p.plancher, p.devise) }))}</p>`
      : ''
    return `<div class="fic-prix">
      ${modeHtml || ligne('fiche.prix_mode', esc(t(p.modeCle)), ' data-mode')}
      ${champsDuBloc('prix').map(c => ligneSaisieHtml(c, fiche.bien, outils)
        + (c.nom === 'prix_minimum' ? vide : '')).join('')}
      ${ligne('fiche.champ_devise', `${esc(p.devise)} <span class="fic-muet caption">${esc(t('fiche.devise_fixe'))}</span>`, ' data-devise')}
      ${envoiHtml('prix', fiche, outils)}
      ${publierHtml}
    </div>`
  }

  return `<div class="fic-prix">
    ${ligne('fiche.prix_mode', esc(t(p.modeCle)), ' data-mode')}
    ${p.base != null ? ligne('fiche.prix_base', esc(argent(p.base, p.devise))) : ''}
    ${ligne('fiche.prix_plancher',
      esc(p.plancherParDefaut
        ? t('fiche.prix_plancher_defaut', { montant: argent(p.plancher, p.devise) })
        : argent(p.plancher, p.devise)), ' data-plancher')}
    ${p.voyageursInclus != null ? ligne('fiche.prix_inclus', esc(nombre(p.voyageursInclus, 0))) : ''}
    ${p.supplement != null ? ligne('fiche.prix_supplement', esc(argent(p.supplement, p.devise))) : ''}
    ${publierHtml}
  </div>`
}

// ─── 3. Le logement ─────────────────────────────────────────────────────────
export function logementHtml (fiche, outils, { peutModifier = false } = {}) {
  const { t, esc, nombre } = outils
  const b = fiche.bien
  if (peutModifier) {
    return `<div class="fic-champs">`
      + champsDuBloc('logement').map(c => ligneSaisieHtml(c, b, outils)).join('')
      // ⚠ DEUX PHRASES CONTRADICTOIRES, COLLÉES (revue de l'étape 3) : ce bloc
      // disait « il s'enregistre tout seul » puis montrait un bouton
      // « Enregistrer » juste en dessous — parce que la capacité, elle, part chez
      // les plateformes et attend le bouton. L'aide le dit maintenant.
      + `<p class="fic-aide caption" data-aide>${esc(t(
        champsDuBloc('logement').some(c => c.grille) ? 'fiche.modifier_aide_grille' : 'fiche.modifier_aide'))}</p>`
      + envoiHtml('logement', fiche, outils) + `</div>`
  }
  const champs = [
    ['fiche.champ_nom', b.nom],
    ['fiche.champ_capacite', b.capacite != null ? nombre(b.capacite, 0) : null],
    ['fiche.champ_adresse', b.adresse],
    ['fiche.champ_cp', b.code_postal],
    ['fiche.champ_ville', b.ville],
    ['fiche.champ_pays', b.pays]
  ]
  // ⚠ UN CHAMP VIDE SE DIT « — », il ne disparaît pas : il est éditable sur
  // place dès qu'on en a le droit, et une ligne absente n'offrirait nulle part
  // où écrire.
  return `<div class="fic-champs">${champs.map(([cle, val]) =>
    `<div class="fic-ligne"><span class="fic-ligne__cle caption">${esc(t(cle))}</span>`
    + `<span class="fic-ligne__val${val ? '' : ' fic-muet'}">${val ? esc(val) : '—'}</span></div>`
  ).join('')}</div>`
}

// ─── 4. Supprimer ───────────────────────────────────────────────────────────
//
// ⚠ LE BOUTON EST MASQUÉ SANS LE DROIT D'ÉCRITURE, ET LE SERVEUR REFUSE AUSSI.
// Règle absolue du dépôt : « un masquage par droit ne suffit jamais ». Ici le
// masquage n'est qu'un confort — `requirePermission({ reglages, write })` garde
// le DELETE, et c'est lui le test qui tranche.
// ⚠ LE DROIT VIENT DU SERVEUR, PAS DU NAVIGATEUR (constat de SÉCURITÉ de la
// revue de 5c0d759, et c'est la classe de défaut gravée au CLAUDE.md).
// La page passait `peutEcrire('reglages')` — qui répond pour le COMPTE
// COURANT, et rend `true` par `estTitulaire()` dès que le sélecteur est resté
// sur mon compte. Or cette fiche est justement l'endpoint qui IGNORE
// `X-Compte` : « le bien désigne le compte ». J'ouvre donc la fiche d'un bien
// d'un autre compte où je suis invité en lecture, et le bloc « Supprimer »
// s'affichait — alors que le serveur avait déjà tranché l'inverse DANS LA MÊME
// RÉPONSE : `{ possible: null, motif: 'droit_refuse' }`.
//
// C'est exactement l'alignement que Thierry a demandé le 21 octobre : « on
// s'aligne sur le serveur, c'est lui la vraie protection ». `peutSupprimer`
// reste accepté et intersecté — deux gardes valent mieux qu'une —, mais le
// refus du serveur est SOUVERAIN.
export function supprimerHtml (fiche, outils, { peutSupprimer = false } = {}) {
  const s = suppressionAffiche(fiche.suppression)
  if (!peutSupprimer || MOTIFS_QUI_EFFACENT.includes(s.motif)) return null
  // ⚠ À L'ÉTAPE 2, LE BLOC NE SE RENDAIT PAS QUAND LA SUPPRESSION ÉTAIT
  // POSSIBLE : un bouton rouge actif qui ne part pas est un leurre. À l'étape 3
  // il part, donc il se rend — et quand la suppression est REFUSÉE, c'est son
  // ÉTAT qui reste l'information, lisible AVANT le clic.
  const { t, esc, icone } = outils
  const bouton = (actif) => `<button type="button" class="btn btn--danger" data-bind="supprimer"${actif ? '' : ' disabled'}>`
    + `${icone('i-close', 'icon')}<span>${esc(t('fiche.supprimer'))}</span></button>`
  if (s.active) {
    return `<div class="fic-supprimer">
      ${bouton(true)}
      <span class="fic-sauve caption" data-etat aria-live="polite"></span>
      <p class="fic-erreur caption" data-erreur hidden></p>
    </div>`
  }
  return `<div class="fic-supprimer">
    ${bouton(false)}
    <p class="caption fic-muet" data-raison data-motif="${esc(s.motif || 'inconnu')}">${esc(t(s.cle))}</p>
  </div>`
}

// Ce que la confirmation ÉNUMÈRE, à partir des nombres du serveur.
//
// ⚠ LE LOGEMENT LUI-MÊME EST TOUJOURS DANS LA LISTE, même quand il n'a aucune
// donnée liée : une fenêtre qui n'énumère rien ferait croire qu'on ne perd rien.
//
// ⚠ UN COMPTE À ZÉRO NE S'ÉCRIT PAS. « 0 message » dans une liste de ce qui sera
// effacé est du bruit — on énumère ce qu'on PERD, pas ce qu'on n'a pas.
//
// ⚠ ET UN COMPTE ILLISIBLE (`null`) SE DIT, en toutes lettres. C'est la règle de
// tout ce lot au moment où elle coûte le plus cher : taire une lecture ratée
// ferait supprimer un bien en croyant ne rien perdre.
export const COMPTES_SUPPRESSION = [
  ['reservations', 'fiche.supprimer_reservations'],
  ['messages', 'fiche.supprimer_messages'],
  ['menages', 'fiche.supprimer_menages'],
  ['codes', 'fiche.supprimer_codes']
]

export function listeDeSuppression (compte, t) {
  const lignes = [t('fiche.supprimer_le_bien')]
  const c = compte || {}
  // ⚠ `cle_absente` EST UNE RÉPONSE, pas un champ décoratif (revue de l'étape
  // 3 : il descendait du serveur et personne ne le lisait). Il dit « ce bien
  // n'a pas de clé partenaire, donc la purge n'efface rien de lié » — et dans
  // ce cas, les quatre zéros ne sont pas une lecture vide, ce sont des zéros
  // CERTAINS. Rien de plus à énumérer, et surtout pas « nous n'avons pas pu
  // compter ».
  if (c.cle_absente === true) return lignes
  let illisible = false
  for (const [nom, cle] of COMPTES_SUPPRESSION) {
    const v = c[nom]
    if (v === null || v === undefined) { illisible = true; continue }
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) continue
    lignes.push(t(cle, { n }))
  }
  if (illisible) lignes.push(t('fiche.supprimer_illisible'))
  return lignes
}

// ⚠ CE QUI RESTE APRÈS LA SUPPRESSION, QUAND CE N'EST PAS ÉVIDENT.
//
// Décision de Thierry du 23 octobre 2026. Pour un bien Beds24 de l'hôte, le
// serveur ne touche à rien chez le partenaire : la garde du `DELETE` au channel
// manager est réservée aux biens du canal (`api/channel-property.js`, bloc
// DELETE). Rien ne le disait à l'hôte, qui pouvait croire qu'il efface son
// annonce en même temps que son logement.
//
// ⚠ ET C'EST ICI, PAS DANS LA PAGE. `tests/logement-page-dom.js` interdit à
// l'écran de nommer un partenaire — garde juste, et c'est le module commun qui
// porte déjà `beds24_de_l_hote` (shared/logements-liste.js). Écrire la
// condition dans la page aurait affaibli le garde-fou pour une phrase.
export function noteDeSuppression (bien, t) {
  if (!bien || bien.beds24_de_l_hote !== true) return null
  return t('fiche.supprimer_annonce_reste')
}

// ─── 5. Ménage ──────────────────────────────────────────────────────────────
//
// ⚠ AUCUNE RÈGLE MÉTIER ICI (décision de Thierry, étape 0) : ce qu'est « une
// prestataire assignée » appartient à l'app ménage. On montre ce que l'endpoint
// descend — le nom, le rang, et si elle doit accuser réception — sans le
// réduire à « assignée / proposée », ce qui recopierait ici une règle qui vit
// dans lib/cleaning/garde.js.
export function menageHtml (fiche, outils, refuses = []) {
  const { t, esc } = outils
  const morceaux = []
  // ⚠ `Array.isArray` : un `{}` passerait `!= null` et afficherait « Aucune
  // prestataire » sur un bien qui en a deux (revue de 5c0d759).
  if (!Array.isArray(fiche.menage)) morceaux.push(nonLu('fiche.menage_non_lu', outils))
  else if (!fiche.menage.length) morceaux.push(`<p class="fic-vide caption">${esc(t('fiche.menage_vide'))}</p>`)
  else morceaux.push(`<ul class="fic-liste">${fiche.menage.map(m => {
    const nom = [m.prenom, m.nom].filter(Boolean).join(' ').trim()
    const rang = m.rang != null && Number(m.rang) > 1
      ? t('fiche.menage_rang', { n: Number(m.rang) })
      : t('fiche.menage_office')
    return `<li class="fic-personne" data-presta>`
      + `<span class="fic-personne__nom">${esc(nom || t('fiche.menage_sans_nom'))}</span>`
      + `<span class="caption fic-muet">${esc(rang)}</span></li>`
  }).join('')}</ul>`)

  // Pas de seconde normalisation ici : `propreteHtml` garde elle-même son
  // entrée. Doubler la garde ne se mesure pas — la mutation « retire-la »
  // survivait, faute d'être observable de l'extérieur.
  const proprete = propreteHtml(fiche, outils, refuses)
  if (proprete) morceaux.push(proprete)
  return morceaux.join('')
}

// Le compteur de propreté — DANS LE BLOC MÉNAGE.
//
// ⚠ VERT ET ROUGE, PAR LES CLASSES DE L'ÉCRAN MÉNAGES (correction de Thierry
// du 21 octobre 2026) : « vert OK, rouge problème ». Ce sont les MÊMES
// déclarations que la note d'une prestataire — `.men-note*`, dans
// shared/ui.css — et pas une copie : la charte bouge aux deux endroits à la
// fois, et c'est la règle du dépôt (« une règle partagée vit dans un module
// commun »).
//
// ⚠ UN ZÉRO RESTE MUET (`men-note--vide`, la règle que l'écran Ménages porte
// déjà) : zéro remarque n'est pas un problème, donc n'est pas rouge.
//
// ⚠ ET AUCUNE LÉGENDE SOUS LES CHIFFRES (décision de Thierry) : le libellé
// n'existe que pour la voix.
//
// ⚠ UN REFUS DU DOMAINE `avis` EFFACE LE COMPTEUR, et une INDISPONIBILITÉ le
// TAIT ici : c'est le bloc Avis qui dit « pas lisible », une seule fois pour
// une seule source. Le dire deux fois ferait croire à deux pannes.
//
// ⚠ ET LE LIBELLÉ EST SUR LE SPAN (`title`), PAS SEULEMENT POUR LA VOIX (revue
// de f1d6cbd). À l'écran, ce qui distingue le vert du rouge, c'est la COULEUR
// et un pouce de 14 px : qui ne perçoit pas la couleur, à la souris, n'a aucun
// moyen d'apprendre ce que valent « 3 » et « 1 ». C'est la leçon déjà écrite
// pour les pastilles de la liste (`logements-liste.js`) : `.sr-only` porte le
// libellé, `title` reste pour la souris. Un `title` n'est pas une légende —
// rien ne s'ajoute à l'écran.
export function propreteHtml (fiche, outils, refuses = []) {
  const { t, esc, icone } = outils
  // ⚠ NORMALISÉ À L'ENTRÉE, pas testé en chemin : `Array.isArray(refuses) && …`
  // DONNAIT LE COMPTEUR à qui passait autre chose qu'un tableau. Une garde de
  // droit qui s'efface sur une entrée inattendue penche du mauvais côté.
  const refs = Array.isArray(refuses) ? refuses : []
  if (refs.includes('avis')) return null
  const p = poucesAffiches(fiche.avis)
  if (!p) return null
  if (p.vide) {
    return `<p class="fic-vide fic-proprete caption" data-proprete="${p.aucunAvis ? 'aucun' : 'rien-signale'}">`
      + `${esc(t(p.aucunAvis ? 'fiche.proprete_aucun_avis' : 'fiche.proprete_vide', { jours: p.jours }))}</p>`
  }
  const compte = (cle, n, id, classe, ic) =>
    `<span class="${classe}${n ? '' : ' men-note--vide'}" data-pouce="${id}" title="${esc(t(cle))}">`
    + `${icone(ic, 'icon')}<b>${esc(String(n))}</b>`
    + `<span class="sr-only"> ${esc(t(cle))}</span></span>`
  return `<div class="men-note fic-proprete" data-proprete>
    ${compte('fiche.proprete_positif', p.positif, 'positif', 'men-note__bon', 'i-thumb-up')}
    ${compte('fiche.proprete_remarque', p.remarque, 'remarque', 'men-note__mauvais', 'i-thumb-down')}
    ${p.enAttente ? compte('fiche.proprete_attente', p.enAttente, 'attente', 'men-note__attente', 'i-circle-dashed') : ''}
  </div>`
}

// ─── 6. Avis ──────────────────────────────────────────────────
//
// ⚠ LA MÊME NOTE QUE LA CARTE DE LA LISTE (décision de Thierry du 21 octobre
// 2026) : « les deux écrans doivent dire la même chose ». Elle passe donc par
// `avisHtml` du module commun, et non par un rendu propre à la fiche.
//
// ⚠ ET LA NOTE SEULE (correction de Thierry du 21 octobre 2026) : « le bloc
// Avis = note sur 5 + nombre d'avis seulement ». Les pouces de propreté sont
// partis dans le bloc Ménage, dont ils mesurent le travail.
export function avisBlocHtml (fiche, outils) {
  if (fiche.avis == null) {
    return outils.avisIndisponibles === true ? nonLu('logements.avis_non_lus', outils) : null
  }
  const note = avisHtml(fiche, outils)
  // DÉFENSIF, et c'est tout : aujourd'hui `avisHtml` ne rend '' que si
  // `fiche.avis` est nul, cas écarté juste au-dessus — cette branche n'est donc
  // jamais prise (vérifié en revue de f1d6cbd). Elle reste pour qu'un jour où
  // le rendu partagé se tairait, le bloc ne soit pas titré et vide.
  if (!note) return null
  return `<div class="fic-avis">${note}</div>`
}

// ─── 7. Réglages ────────────────────────────────────────────────────────────
//
// ⚠ LECTURE ET LIEN SEULEMENT (spec §3.7). La serrure se règle dans son app,
// la taxe dans la sienne : « la configuration d'une APP vit DANS l'app ».
//
// ⚠ ET LE BARÈME SEUL POUR LA TAXE (décision de Thierry, 20 octobre 2026) : les
// montants collectés restent sous `facturation`, hors de cette fiche.
// `origine: 'absent'` vaut `connue: false` — un bloc « Taxe de séjour » avec un
// collecteur et rien d'autre est un bloc vide qui a l'air plein.
// ⚠ CE BLOC LIT `refuses`, DEPUIS LA REVUE DE 5c0d759. Il ne le lisait pas, et
// la règle « un bloc refusé n'est pas rendu » n'y tenait que par la
// coïncidence que `serrures` ET `taxe` dépendent tous deux du domaine
// `reglages` : qu'un seul des deux soit refusé un jour, et l'écran aurait dit
// « La serrure n'est pas lisible pour l'instant » — le message de
// l'INDISPONIBILITÉ posé sur un REFUS DE DROIT. Les deux ne se confondent pas :
// l'un dit « on n'a pas pu », l'autre « vous n'y avez pas droit », et le
// second ne se dit pas du tout.
export function reglagesHtml (fiche, outils, refuses = []) {
  const { t, esc } = outils
  const morceaux = []
  const refuse = (nom) => Array.isArray(refuses) && refuses.includes(nom)

  if (refuse('serrures')) { /* refusé : rien, pas même un message */ }
  else if (!Array.isArray(fiche.serrures)) morceaux.push(nonLu('fiche.serrure_non_lue', outils))
  else if (!fiche.serrures.length) morceaux.push(`<div class="fic-ligne"><span class="fic-ligne__cle caption">${esc(t('fiche.serrure'))}</span><span class="fic-ligne__val fic-muet">${esc(t('fiche.serrure_aucune'))}</span></div>`)
  else morceaux.push(`<div class="fic-ligne"><span class="fic-ligne__cle caption">${esc(t('fiche.serrure'))}</span>`
    + `<span class="fic-ligne__val">${esc(t('fiche.serrure_n', { n: fiche.serrures.length }))}</span></div>`)

  if (refuse('taxe')) { /* refusé : rien */ }
  else if (fiche.taxe == null) morceaux.push(nonLu('fiche.taxe_non_lue', outils))
  else if (fiche.taxe.connue !== true) morceaux.push(`<div class="fic-ligne"><span class="fic-ligne__cle caption">${esc(t('fiche.taxe'))}</span><span class="fic-ligne__val fic-muet">${esc(t('fiche.taxe_aucune'))}</span></div>`)
  else morceaux.push(`<div class="fic-ligne"><span class="fic-ligne__cle caption">${esc(t('fiche.taxe'))}</span>`
    + `<span class="fic-ligne__val">${esc(fiche.taxe.commune || t('fiche.taxe_connue'))}</span></div>`)

  // Les deux moitiés refusées : plus rien à dire, donc pas de bloc.
  if (!morceaux.length) return null
  return `<div class="fic-reglages">${morceaux.join('')}</div>`
}

// ─── Le dialogue, un seul pour les trois confirmations ─────────────────
//
// ⚠ UN SEUL, RÉUTILISÉ : couper l'assistant, publier les prix, supprimer le
// logement. Trois fenêtres écrites séparément finiraient par ne pas se fermer
// pareil, ne pas rendre le focus pareil, et ne pas dire « Annuler » au même
// endroit.
//
// ⚠ `<dialog>` NATIF, et pas `window.confirm` comme les autres écrans V5 : la
// suppression exige de FRAPPER LE NOM du logement, ce qu'une boîte du navigateur
// ne sait pas faire. Le natif apporte en prime le piège de focus, Échap, et le
// retour du focus au bouton d'origine — trois choses qu'une fenêtre maison
// oublie.
//
// ⚠ LE DÉFAUT SÛR EST « ANNULER » : il est en premier dans le DOM, donc c'est
// lui qui prend le focus à l'ouverture, et Échap revient à lui. Jamais l'action
// destructrice.
export function dialogueHtml (outils) {
  const { t, esc } = outils
  return `<dialog class="fic-dlg" data-bind="dialogue" aria-labelledby="fic-dlg-titre">
    <form method="dialog" class="fic-dlg__corps">
      <h2 class="h3" id="fic-dlg-titre" data-dlg="titre"></h2>
      <p data-dlg="texte"></p>
      <ul class="fic-dlg__liste" data-dlg="liste" hidden></ul>
      <!-- ⚠ UNE NOTE, PAS UN ÉLÉMENT DE LA LISTE. La liste énumère ce qui SERA
           EFFACÉ ; cette phrase dit l'inverse — ce qui RESTE. L'écrire comme un
           élément de liste parmi les pertes se lirait comme une perte de plus.
           (Et pas d'accent grave ici : ce commentaire vit DANS un littéral de
           gabarit, où un accent grave ferme la chaîne — mesuré le 23 octobre
           2026, dix tests rouges sur « li is not defined ».) -->
      <p class="fic-dlg__note caption" data-dlg="note" hidden></p>
      <p class="fic-dlg__frappe" data-dlg="frappe" hidden>
        <label class="caption" for="fic-dlg-saisie" data-dlg="frappe-aide"></label>
        <input class="fic-saisie" id="fic-dlg-saisie" data-dlg="saisie" autocomplete="off">
      </p>
      <p class="fic-erreur caption" data-dlg="erreur" hidden></p>
      <div class="fic-dlg__pied">
        <button type="submit" value="annuler" class="btn btn--secondary" data-dlg="annuler">${esc(t('fiche.annuler'))}</button>
        <button type="submit" value="ok" class="btn" data-dlg="ok"></button>
      </div>
    </form>
  </dialog>`
}

// ─── L'assemblage ───────────────────────────────────────────────────────────
//
// ⚠ UN BLOC REFUSÉ N'EST PAS RENDU, et c'est `bloc()` qui le décide sur un
// corps `null`. Le JSON peut porter le refus, l'écran le cache.
export function ficheHtml (fiche, outils, droits = {}) {
  // ⚠ UN SEUL DROIT POUR LES CHAMPS : `reglages:write`, celui que `PATCH`
  // exige. Il arrive déjà sous le nom `peutSupprimer` depuis l'étape 2 — le
  // DELETE demande le même — et `peutModifier` le dit à sa place quand
  // l'appelant le fournit.
  const peutModifier = droits.peutModifier === true
    || (droits.peutModifier === undefined && droits.peutSupprimer === true)
  // ⚠ DEUX DROITS, PAS UN. « Publier mes prix » est gardé côté serveur par
  // `reservations:write` et non par `reglages:write` (voir §5 de la spec,
  // corrigé à l'ouverture de l'étape 3) : un membre peut tenir le calendrier
  // sans reconfigurer le bien, et l'inverse. Le dialogue sert les deux, donc il
  // existe dès que l'un des deux est là.
  const peutPublier = droits.peutPublier === true
  const avecActions = peutModifier || peutPublier
  const inds = Array.isArray(fiche.indisponibles) ? fiche.indisponibles : []
  const refs = Array.isArray(fiche.refuses) ? fiche.refuses : []
  const o = { ...outils,
    peutPublier,
    avisIndisponibles: inds.includes('avis'),
    // ⚠ UN FAIT DATÉ PARTIEL SE DIT (revue de 5c0d759). Le serveur pose
    // `indisponibles: ['fait_date']` quand il a pu affirmer une FERMETURE mais
    // pas lire les réservations — son commentaire le dit : « l'écran doit
    // savoir qu'une réservation pourrait s'y ajouter ». L'écran ne lisait ce
    // tableau que pour `avis`, et rendait « Fermé jusqu'au 1er décembre » en
    // encre normale, sans réserve, là où la moitié de la source était
    // illisible.
    faitPartiel: inds.includes('fait_date') }
  const refuse = (nom) => refs.includes(nom)

  const gauche = [
    bloc('fiche.bloc_vente', venteHtml(fiche, o, { peutModifier }), o),
    bloc('fiche.bloc_prix', prixHtml(fiche, o, { peutModifier }), o),
    bloc('fiche.bloc_logement', logementHtml(fiche, o, { peutModifier }), o)
  ].join('')

  const droite = [
    refuse('menage') ? '' : bloc('fiche.bloc_menage', menageHtml(fiche, o, refs), o),
    refuse('avis') ? '' : bloc('fiche.bloc_avis', avisBlocHtml(fiche, o), o),
    bloc('fiche.bloc_reglages', reglagesHtml(fiche, o, refs), o)
  ].join('')

  // ⚠ SUPPRIMER SORT DES COLONNES, ET VIENT EN DERNIER (constat de la recette
  // de Thierry du 22 octobre 2026). Il vivait au bas de la colonne GAUCHE : à
  // l'ordinateur il était bien en bas à gauche, mais au téléphone, où les deux
  // colonnes s'empilent, il arrivait AU MILIEU de la fiche — avant Ménage, Avis
  // et Réglages. L'action la plus destructrice du produit se lisait entre deux
  // blocs de lecture. La spec le veut « en bas » : hors colonnes, il l'est sur
  // les deux écrans.
  const supprimer = bloc('fiche.bloc_supprimer', supprimerHtml(fiche, o, droits), o)

  return `${avecActions ? dialogueHtml(o) : ''}${enTeteHtml(fiche, o, { peutModifier })}
    <div class="fic-colonnes">
      <div class="fic-col fic-col--gauche">${gauche}</div>
      <div class="fic-col fic-col--droite">${droite}</div>
    </div>
    ${supprimer}`
}

// Les états qui ne sont pas une fiche. Comme en liste : les textes passent par
// `data-i18n`, la page les traduit après insertion.
export function etatHtml (quoi) {
  if (quoi === 'refus') return `<p data-i18n="fiche.refus"></p>`
  if (quoi === 'introuvable') return `<p data-i18n="fiche.introuvable"></p>
      <div class="fic-etat__actions"><a class="btn btn--secondary" href="/logements" data-i18n="fiche.retour"></a></div>`
  return `<p data-i18n="fiche.panne"></p>
      <div class="fic-etat__actions">
        <button type="button" class="btn btn--secondary" data-bind="reessayer" data-i18n="logements.reessayer"></button>
      </div>`
}
