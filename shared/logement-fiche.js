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
export function suppressionAffiche (suppression) {
  if (!suppression || suppression.possible !== true) {
    const motif = suppression && suppression.motif
    return {
      active: false,
      cle: motif === 'relie'
        ? 'fiche.supprimer_relie'
        : 'fiche.supprimer_inconnu'
    }
  }
  return { active: true, cle: 'fiche.supprimer_aide' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Les pouces de propreté
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ NEUTRES, JAMAIS ROUGES, ET SANS LÉGENDE (décision de Thierry du 21 octobre
// 2026). La charte §7 réserve le rouge à la suppression et aux erreurs : une
// remarque de ménage n'est ni l'une ni l'autre. « Juste le compteur, sans
// légende » — le libellé des pouces suffit, une phrase d'explication sous
// chaque chiffre encombre une colonne déjà dense.
//
// ⚠ ET « PAS ENCORE ANALYSÉ » N'EST PAS « RIEN SIGNALÉ ». Les confondre
// afficherait un pouce vert pour un avis qu'on n'a pas lu — c'est la règle que
// l'endpoint porte déjà, l'écran ne doit pas la défaire.
export function poucesAffiches (avis) {
  if (!avis) return null
  const n = (x) => Number(x) || 0
  return {
    positif: n(avis.positif),
    remarque: n(avis.remarque),
    enAttente: n(avis.non_analyses),
    jours: n(avis.proprete_sur_jours) || n(avis.fenetre_jours) || 30,
    // Lu, et rien à montrer : on le dit plutôt que d'afficher trois zéros.
    vide: n(avis.positif) + n(avis.remarque) + n(avis.non_analyses) === 0
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

export function enTeteHtml (fiche, outils) {
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
  const faitTexte = fait.valeurs
    ? t(fait.cle, Object.fromEntries(Object.entries(fait.valeurs).map(([k, v]) => [k, outils.dateEnClair(v)])))
    : t(fait.cle)

  return `<header class="fic-entete">
    <div class="fic-photo">${photo}</div>
    <div class="fic-entete__texte">
      <h1 class="h2 fic-nom">${esc(b.nom || '')}</h1>
      ${sous ? `<p class="fic-sous caption">${sous}</p>` : ''}
      <div class="fic-canaux">${canauxHtml(fiche, outils)}</div>
      <p class="fic-fait${fait.muet ? ' fic-muet' : ''} caption" data-fait="${b && fiche.fait_date ? fiche.fait_date.type : 'indisponible'}">${esc(faitTexte)}</p>
      ${signalHtml(fiche, outils)}
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
  if (releveDuCompteEnEchec([fiche])) return { cle: 'fiche.canaux_echec', valeurs: null, echec: true }
  const f = fraicheurDuCompte([fiche], maintenant)
  if (!f) return null
  return {
    cle: f.vieux ? 'logements.fraicheur_vieille' : 'logements.fraicheur',
    valeurs: { quand: String(f.quand).slice(0, 10) }, echec: false, vieux: f.vieux
  }
}

export function venteHtml (fiche, outils) {
  const { t, esc, dateEnClair } = outils
  if (fiche.canaux == null) return nonLu('fiche.canaux_non_lus', outils)
  const f = fraicheurAffichee(fiche)
  const ligne = !f ? ''
    : `<p class="fic-fraicheur caption${f.echec || f.vieux ? ' fic-fraicheur--alerte' : ''}"`
      + ` data-fraicheur="${f.echec ? 'echec' : (f.vieux ? 'vieille' : 'fraiche')}">`
      + `${esc(t(f.cle, f.valeurs ? { quand: dateEnClair(f.valeurs.quand) } : {}))}</p>`
  if (!fiche.canaux.length) {
    return `<p class="fic-vide caption">${esc(t('logements.aucun_canal'))}</p>${ligne}`
  }
  return `<div class="fic-vente">${canauxHtml(fiche, outils)}</div>${ligne}`
}

// ─── 2. Prix ────────────────────────────────────────────────────────────────
export function prixHtml (fiche, outils) {
  const { t, esc, argent, nombre } = outils
  const p = prixAffiche(fiche.bien)
  const ligne = (cle, valeur, extra = '') =>
    `<div class="fic-ligne"${extra}><span class="fic-ligne__cle caption">${esc(t(cle))}</span>`
    + `<span class="fic-ligne__val">${valeur}</span></div>`

  return `<div class="fic-prix">
    ${ligne('fiche.prix_mode', esc(t(p.modeCle)), ' data-mode')}
    ${p.base != null ? ligne('fiche.prix_base', esc(argent(p.base, p.devise))) : ''}
    ${ligne('fiche.prix_plancher',
      esc(p.plancherParDefaut
        ? t('fiche.prix_plancher_defaut', { montant: argent(p.plancher, p.devise) })
        : argent(p.plancher, p.devise)), ' data-plancher')}
    ${p.voyageursInclus != null ? ligne('fiche.prix_inclus', esc(nombre(p.voyageursInclus, 0))) : ''}
    ${p.supplement != null ? ligne('fiche.prix_supplement', esc(argent(p.supplement, p.devise))) : ''}
  </div>`
}

// ─── 3. Le logement ─────────────────────────────────────────────────────────
export function logementHtml (fiche, outils) {
  const { t, esc, nombre } = outils
  const b = fiche.bien
  const champs = [
    ['fiche.champ_nom', b.nom],
    ['fiche.champ_capacite', b.capacite != null ? nombre(b.capacite, 0) : null],
    ['fiche.champ_adresse', b.adresse],
    ['fiche.champ_cp', b.code_postal],
    ['fiche.champ_ville', b.ville],
    ['fiche.champ_pays', b.pays]
  ]
  // ⚠ UN CHAMP VIDE SE DIT « — », il ne disparaît pas : à l'étape 3 il devient
  // éditable sur place, et une ligne absente n'offrirait nulle part où écrire.
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
export function supprimerHtml (fiche, outils, { peutSupprimer = false } = {}) {
  if (!peutSupprimer) return null
  const { t, esc, icone } = outils
  const s = suppressionAffiche(fiche.suppression)
  return `<div class="fic-supprimer">
    <button type="button" class="btn btn--danger" data-bind="supprimer"${s.active ? '' : ' disabled'}>
      ${icone('i-close', 'icon')}<span>${esc(t('fiche.supprimer'))}</span>
    </button>
    <p class="caption fic-muet" data-raison>${esc(t(s.cle))}</p>
  </div>`
}

// ─── 5. Ménage ──────────────────────────────────────────────────────────────
//
// ⚠ AUCUNE RÈGLE MÉTIER ICI (décision de Thierry, étape 0) : ce qu'est « une
// prestataire assignée » appartient à l'app ménage. On montre ce que l'endpoint
// descend — le nom, le rang, et si elle doit accuser réception — sans le
// réduire à « assignée / proposée », ce qui recopierait ici une règle qui vit
// dans lib/cleaning/garde.js.
export function menageHtml (fiche, outils) {
  const { t, esc } = outils
  if (fiche.menage == null) return nonLu('fiche.menage_non_lu', outils)
  if (!fiche.menage.length) return `<p class="fic-vide caption">${esc(t('fiche.menage_vide'))}</p>`
  return `<ul class="fic-liste">${fiche.menage.map(m => {
    const nom = [m.prenom, m.nom].filter(Boolean).join(' ').trim()
    const rang = m.rang != null && Number(m.rang) > 1
      ? t('fiche.menage_rang', { n: Number(m.rang) })
      : t('fiche.menage_office')
    return `<li class="fic-personne" data-presta>`
      + `<span class="fic-personne__nom">${esc(nom || t('fiche.menage_sans_nom'))}</span>`
      + `<span class="caption fic-muet">${esc(rang)}</span></li>`
  }).join('')}</ul>`
}

// ─── 6. Avis ────────────────────────────────────────────────────────────────
//
// ⚠ LA MÊME NOTE QUE LA CARTE DE LA LISTE (décision de Thierry du 21 octobre
// 2026) : « les deux écrans doivent dire la même chose ». Elle passe donc par
// `avisHtml` du module commun, et non par un rendu propre à la fiche.
// Les pouces, eux, ne parlent QUE de propreté, en couleur neutre, et sans
// légende sous les chiffres.
export function avisBlocHtml (fiche, outils) {
  const { t, esc, icone } = outils
  if (fiche.avis == null) {
    return outils.avisIndisponibles === true ? nonLu('logements.avis_non_lus', outils) : null
  }
  const note = avisHtml(fiche, outils)
  const p = poucesAffiches(fiche.avis)
  const pouce = (cle, n, id) =>
    `<span class="fic-pouce" data-pouce="${id}">${icone(id === 'positif' ? 'i-thumb-up' : 'i-thumb-down', 'icon')}`
    + `<span class="fic-pouce__n">${esc(String(n))}</span>`
    + `<span class="sr-only"> ${esc(t(cle))}</span></span>`

  return `<div class="fic-avis">
    ${note}
    ${p.vide
      ? `<p class="fic-vide caption" data-proprete="vide">${esc(t('fiche.proprete_vide', { jours: p.jours }))}</p>`
      : `<div class="fic-pouces" data-proprete>
          ${pouce('fiche.proprete_positif', p.positif, 'positif')}
          ${pouce('fiche.proprete_remarque', p.remarque, 'remarque')}
          ${p.enAttente ? `<span class="fic-pouce fic-muet" data-pouce="attente">${icone('i-circle-dashed', 'icon')}<span class="fic-pouce__n">${esc(String(p.enAttente))}</span><span class="sr-only"> ${esc(t('fiche.proprete_attente'))}</span></span>` : ''}
        </div>`}
  </div>`
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
export function reglagesHtml (fiche, outils) {
  const { t, esc } = outils
  const morceaux = []

  if (fiche.serrures == null) morceaux.push(nonLu('fiche.serrure_non_lue', outils))
  else if (!fiche.serrures.length) morceaux.push(`<div class="fic-ligne"><span class="fic-ligne__cle caption">${esc(t('fiche.serrure'))}</span><span class="fic-ligne__val fic-muet">${esc(t('fiche.serrure_aucune'))}</span></div>`)
  else morceaux.push(`<div class="fic-ligne"><span class="fic-ligne__cle caption">${esc(t('fiche.serrure'))}</span>`
    + `<span class="fic-ligne__val">${esc(t('fiche.serrure_n', { n: fiche.serrures.length }))}</span></div>`)

  if (fiche.taxe == null) morceaux.push(nonLu('fiche.taxe_non_lue', outils))
  else if (fiche.taxe.connue !== true) morceaux.push(`<div class="fic-ligne"><span class="fic-ligne__cle caption">${esc(t('fiche.taxe'))}</span><span class="fic-ligne__val fic-muet">${esc(t('fiche.taxe_aucune'))}</span></div>`)
  else morceaux.push(`<div class="fic-ligne"><span class="fic-ligne__cle caption">${esc(t('fiche.taxe'))}</span>`
    + `<span class="fic-ligne__val">${esc(fiche.taxe.commune || t('fiche.taxe_connue'))}</span></div>`)

  return `<div class="fic-reglages">${morceaux.join('')}</div>`
}

// ─── L'assemblage ───────────────────────────────────────────────────────────
//
// ⚠ UN BLOC REFUSÉ N'EST PAS RENDU, et c'est `bloc()` qui le décide sur un
// corps `null`. Le JSON peut porter le refus, l'écran le cache.
export function ficheHtml (fiche, outils, droits = {}) {
  const inds = Array.isArray(fiche.indisponibles) ? fiche.indisponibles : []
  const refs = Array.isArray(fiche.refuses) ? fiche.refuses : []
  const o = { ...outils, avisIndisponibles: inds.includes('avis') }
  const refuse = (nom) => refs.includes(nom)

  const gauche = [
    bloc('fiche.bloc_vente', venteHtml(fiche, o), o),
    bloc('fiche.bloc_prix', prixHtml(fiche, o), o),
    bloc('fiche.bloc_logement', logementHtml(fiche, o), o),
    bloc('fiche.bloc_supprimer', supprimerHtml(fiche, o, droits), o)
  ].join('')

  const droite = [
    refuse('menage') ? '' : bloc('fiche.bloc_menage', menageHtml(fiche, o), o),
    refuse('avis') ? '' : bloc('fiche.bloc_avis', avisBlocHtml(fiche, o), o),
    (refuse('serrures') && refuse('taxe')) ? '' : bloc('fiche.bloc_reglages', reglagesHtml(fiche, o), o)
  ].join('')

  return `${enTeteHtml(fiche, o)}
    <div class="fic-colonnes">
      <div class="fic-col fic-col--gauche">${gauche}</div>
      <div class="fic-col fic-col--droite">${droite}</div>
    </div>`
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
