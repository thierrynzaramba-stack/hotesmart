// core/avis/cartes.js
// DOC : docs/kb/avis-voyageurs.md §14 et
//       docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md (modif = MEME COMMIT)
//
// LA PAGE /avis : UNE CARTE PAR SEJOUR, POUR TOUS LES AVIS (recette de Thierry
// du 7 octobre 2026), au socle V5 depuis le 8 novembre 2026.
//
//   1. « A traiter » — le SEUL moment ambre de l'ecran : les evaluations a faire
//      (ex-section « En attente de notation », meme tri par delai restant) et
//      les avis DETECTES dans un message, qui attendent une confirmation avant
//      d'etre comptes ;
//   2. « Recents » — les 20 derniers jours, une carte par sejour ;
//   3. « Anciens » — repliee, lue seulement quand on l'ouvre.
//
// Chaque carte : en tete la photo du bien, le voyageur, le bien, les dates, le
// canal et la prestataire ; « son avis » (note, classement proprete avec son
// menu de correction, texte) ; « notre avis » (etat, origine, texte).
//
// ⚠ L'ASSEMBLAGE EST AU SERVEUR (lib/avis/cartes.js). Ici on affiche, et on ne
// decide d'aucun droit : le serveur revalide chaque geste.
// ⚠ ELLE N'OUVRE PAS LA FENETRE D'EVALUATION ELLE-MEME : le bus la fournit
// (`hsBus.ouvrir('avis.evaluer', …)`).
// ⚠ AUCUN TEXTE EN DUR DANS LE RENDU : tout passe par `t` (I18n.t de la page).
// `TEXTES_FR` est le repli quand aucun `t` n'est fourni (tests, autre hote) ;
// `tests/avis-cartes-i18n.test.js` exige qu'il soit IDENTIQUE a
// shared/i18n/fr.json — deux copies d'un texte divergent, celle-ci ne le peut
// pas sans rougir.

const ECHAPPER = (t) => String(t == null ? '' : t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const ICONE = (nom, classe = '') => `<svg class="icon${classe ? ' ' + classe : ''}" aria-hidden="true"><use href="/shared/icons.svg#${nom}"/></svg>`

// ─── Les textes (repli francais ; la page passe I18n.t) ─────────────────────
export const TEXTES_FR = {
  'avis.a_traiter': 'À traiter',
  'avis.rien': 'Rien ne vous attend.',
  'avis.recents': 'Récents',
  'avis.recents_sous': '20 derniers jours',
  'avis.recents_vide': 'Aucun séjour ces 20 derniers jours.',
  'avis.anciens': 'Anciens',
  'avis.anciens_vide': 'Aucun séjour plus ancien.',
  'avis.anciens_tronques': 'Les 500 séjours les plus récents seulement.',
  'avis.chargement': 'Chargement…',
  'avis.incomplete': 'La liste est incomplète : les séjours les plus anciens ne sont pas tous affichés.',
  'avis.son_avis': 'Son avis',
  'avis.notre_avis': 'Notre avis',
  'avis.masque': 'Avis déposé, masqué par Airbnb jusqu’à votre évaluation.',
  'avis.analyse': 'Analyse en cours',
  'avis.corrige': 'corrigé',
  'avis.corriger': 'Corriger ce classement',
  'avis.proprete_aria': 'Classement propreté',
  'avis.v_positif': 'Propreté saluée',
  'avis.v_remarque': 'Remarque propreté',
  'avis.v_rien_signale': 'Propreté non évoquée',
  'avis.sans_texte': 'Sans commentaire écrit.',
  'avis.pas_recu': 'Pas encore reçu.',
  'avis.voir_tout': 'Voir tout',
  'avis.detecte': 'Détecté dans un message',
  'avis.a_confirmer': 'À confirmer avant d’être compté',
  'avis.confirmer': 'Confirmer',
  'avis.ignorer': 'Ignorer',
  'avis.dernier_jour': 'Dernier jour',
  'avis.jours_restants': '{n, plural, one {# jour restant} other {# jours restants}}',
  'avis.evaluer': 'Évaluer {prenom}',
  'avis.evaluer_court': 'Évaluer',
  'avis.masque_court': 'Avis masqué jusqu’à votre évaluation',
  'avis.recu_sms': 'reçu par SMS',
  'avis.recu_email': 'reçu par email',
  'avis.recu_oral': 'reçu de vive voix',
  'avis.recu_message': 'reçu dans la messagerie',
  'avis.recu_direct': 'reçu en direct',
  'avis.ce_voyageur': 'ce voyageur',
  'avis.aucune_eval': 'Aucune évaluation du voyageur pour ce séjour.',
  'avis.delai_passe': 'Le délai d’évaluation est passé : Airbnb ne l’accepte plus.',
  'avis.etat_le': '{etat} le {date}',
  'avis.etat_a_remplir': 'À remplir',
  'avis.etat_soumise_prestataire': 'Remplie par la prestataire',
  'avis.etat_a_valider': 'À valider',
  'avis.etat_publiee': 'Publiée',
  'avis.etat_echec_publication': 'Échec de publication',
  'avis.etat_expiree': 'Expirée',
  'avis.etat_abandonnee': 'Abandonnée',
  'avis.etat_evaluee_ailleurs': 'Évaluée sur Airbnb',
  'avis.origine_humain': 'écrit par vous',
  'avis.origine_ia': 'rédigé par l’IA, pas encore validé',
  'avis.origine_ia_valide': 'rédigé par l’IA, validé par vous',
  'avis.origine_ia_presta': 'rédigé par l’IA, validé par la prestataire',
  'avis.origine_ia_auto': 'rédigé par l’IA, publié automatiquement',
  'avis.origine_ailleurs': 'évalué directement sur Airbnb',
  'avis.origine_ia_inconnue': 'rédigé par l’IA',
  'avis.voyageur': 'Voyageur',
  'avis.bien_inconnu': 'Bien inconnu',
  'avis.du_au': 'du {du} au {au}',
  'avis.depart_le': 'départ le {date}',
  'avis.recu_le': 'reçu le {date}',
  'avis.menage': 'ménage : {nom}',
  'avis.p_airbnb': 'Airbnb',
  'avis.p_booking': 'Booking',
  'avis.p_sms': 'SMS',
  'avis.p_email': 'Email',
  'avis.p_oral': 'De vive voix',
  'avis.p_message': 'Messagerie',
  'avis.p_direct': 'Direct',
  'avis.p_avis': 'Avis',
  'avis.sur_5': 'sur 5',
  'avis.n_notes': '{n, plural, one {# note} other {# notes}}',
  'avis.avis_recus': 'avis reçus',
  'avis.proprete_lib': 'propreté saluée · remarques',
  'avis.stats_ko': 'Les compteurs n’ont pas pu être calculés. Rechargez pour réessayer.',
  'avis.acces_refuse': 'Vous n’avez pas accès aux avis de ce compte.',
  'avis.illisibles': 'Avis illisibles',
  'avis.correction_ko': 'Correction impossible.',
  'avis.action_ko': 'Action impossible.',
  'avis.eval_indispo': 'L’évaluation n’est pas disponible pour ce séjour.',
}

// `{n, plural, one {…} other {…}}` puis `{x}` : le sous-ensemble ICU que
// shared/i18n/i18n.modele.js comprend, pour que le repli rende la meme phrase.
function formater (s, vars = {}, langue = 'fr') {
  let out = String(s).replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g, (_, cle, corps) => {
    const n = Number(vars[cle])
    const formes = {}
    for (const m of corps.matchAll(/(=\d+|\w+)\s*\{([^{}]*)\}/g)) formes[m[1]] = m[2]
    let cat = 'other'
    try { cat = new Intl.PluralRules(langue).select(n) } catch { /* langue inconnue */ }
    const choisie = formes['=' + n] ?? formes[cat] ?? formes.other ?? ''
    return choisie.replace(/#/g, String(n))
  })
  out = out.replace(/\{(\w+)\}/g, (m, cle) => (vars[cle] !== undefined && vars[cle] !== null ? String(vars[cle]) : m))
  return out
}

function traducteur (t, langue) {
  if (typeof t === 'function') return (cle, vars) => t(cle, vars)
  return (cle, vars) => formater(TEXTES_FR[cle] ?? cle, vars, langue)
}

const ETATS = ['a_remplir', 'soumise_prestataire', 'a_valider', 'publiee', 'echec_publication', 'expiree', 'abandonnee', 'evaluee_ailleurs']
// Les libelles francais des etats, exportes pour le controle des accents
// (tests/avis-textes-et-lien.test.js).
export const ETAT_LISIBLE = Object.fromEntries(ETATS.map(e => [e, TEXTES_FR['avis.etat_' + e]]))

const VERDICTS = ['positif', 'remarque', 'rien_signale']
const ICONE_VERDICT = { positif: 'i-thumb-up', remarque: 'i-thumb-down', rien_signale: 'i-circle-dashed' }

// ⚠ UNE DATE DE SEJOUR (« 2026-09-21 ») SE LIT EN JOUR LOCAL : `new Date` la
// lirait en UTC, et un hote a l'ouest de l'UTC verrait la veille.
function dateCourte (d, langue, avecAnnee = false) {
  if (!d) return ''
  const jour = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d))
  const x = jour ? new Date(Number(jour[1]), Number(jour[2]) - 1, Number(jour[3])) : new Date(d)
  if (isNaN(x)) return ''
  try {
    return x.toLocaleDateString(langue, avecAnnee ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' })
  } catch { return x.toLocaleDateString('fr-FR') }
}

// ⚠ SUR 5, ET LA NOTE DESCEND DEJA CONVERTIE (decision de Thierry, 20 octobre
// 2026 : « plus aucun /10 affiche »). L'ecran ne divise rien : la conversion et
// l'unique arrondi vivent dans `lib/avis/echelle.js`. Une decimale, a la
// facon de la langue (« 4,8 » en francais).
function uneDecimale (n, langue) {
  try { return new Intl.NumberFormat(langue, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(n)) } catch { return Number(n).toFixed(1).replace('.', ',') }
}

// Le canal : une pastille a la lettre, sur la couleur du canal (jetons
// --canal-* de shared/theme.css). La source d'un avis recu en direct est
// ECRITE, la lettre seule ne la dirait pas.
function canalDe (p, T) {
  if (!p) return { classe: 'autre', lettre: '·', libelle: T('avis.p_avis'), ecrit: false }
  if (p.cle === 'airbnb') return { classe: 'airbnb', lettre: 'A', libelle: T('avis.p_airbnb'), ecrit: false }
  if (p.cle === 'booking') return { classe: 'booking', lettre: 'B', libelle: T('avis.p_booking'), ecrit: false }
  if (p.cle === 'direct') {
    const src = ['sms', 'email', 'oral', 'message'].includes(p.source) ? p.source : null
    return { classe: 'direct', lettre: 'D', libelle: T(src ? 'avis.p_' + src : 'avis.p_direct'), ecrit: true, phrase: T(src ? 'avis.recu_' + src : 'avis.recu_direct') }
  }
  // Une plateforme que l'ecran ne connait pas garde son nom (« expedia » dit
  // quelque chose) ; une plateforme INCONNUE (`autre`) ne s'ecrit pas.
  const nom = p.cle && p.cle !== 'autre' ? String(p.cle) : T('avis.p_avis')
  return { classe: 'autre', lettre: '·', libelle: nom, ecrit: true, phrase: nom }
}

const pastilleCanal = (c) => `<span class="avp-canal avp-canal--${ECHAPPER(c.classe)}" title="${ECHAPPER(c.libelle)}">`
  + `<span aria-hidden="true">${ECHAPPER(c.lettre)}</span><span class="sr-only">${ECHAPPER(c.libelle)}</span></span>`

// Deux formes d'un meme texte : la longue a l'ordinateur, la courte au
// telephone (spec §4). La forme cachee l'est par `display: none` : un lecteur
// d'ecran ne lit qu'une des deux.
const deuxFormes = (long, court) => `<span class="avp-long">${ECHAPPER(long)}</span><span class="avp-court">${ECHAPPER(court)}</span>`

const initiale = (nom) => String(nom || '?').trim().charAt(0).toUpperCase() || '?'

// La vignette du bien : sa photo, ou son initiale a defaut. Un bien archive
// n'est plus dans la liste `biens` : sa carte garde son nom, sans photo.
function vignette (c, ctx, classe = '') {
  const url = c.bien_ref ? ctx.photos.get(String(c.bien_ref)) : null
  return url
    ? `<img class="avp-photo${classe}" src="${ECHAPPER(url)}" alt="" loading="lazy" decoding="async">`
    : `<span class="avp-photo avp-photo--vide${classe}" aria-hidden="true">${ECHAPPER(initiale(c.bien))}</span>`
}

const nomDu = (c, T) => {
  const v = c.voyageur
  const qui = v ? [v.prenom, v.nom].filter(Boolean).join(' ') : ''
  return qui || T('avis.voyageur')
}

// « Julie M. » : le prenom et l'initiale du nom, pour une ligne d'action.
const nomCourt = (c, T) => {
  const v = c.voyageur
  if (!v || !v.prenom) return nomDu(c, T)
  const ini = v.nom ? ' ' + String(v.nom).trim().charAt(0).toUpperCase() + '.' : ''
  return v.prenom + ini
}

function infosDu (c, ctx) {
  const { T, langue } = ctx
  const sejour = c.arrivee && c.depart ? T('avis.du_au', { du: dateCourte(c.arrivee, langue), au: dateCourte(c.depart, langue, true) })
    : c.depart ? T('avis.depart_le', { date: dateCourte(c.depart, langue, true) })
      : c.recu_le ? T('avis.recu_le', { date: dateCourte(c.recu_le, langue, true) }) : ''
  return [c.bien || T('avis.bien_inconnu'), sejour, c.menage_par ? T('avis.menage', { nom: c.menage_par }) : ''].filter(Boolean)
}

// Le classement proprete : le MENU seul quand on peut corriger, le badge seul
// sinon — jamais les deux, qui affichaient deux fois le meme libelle (point A).
// Un avis non encore analyse dit « Analyse en cours », jamais le badge gris :
// celui-ci signifie « regarde, rien a signaler » (KB §8).
function proprete (a, ctx) {
  const { T } = ctx
  if (a.masque) return ''
  if (!a.analyse) return `<span class="avp-prop avp-prop--attente">${ECHAPPER(T('avis.analyse'))}</span>`
  const badge = (v) => v && VERDICTS.includes(v)
    ? `<span class="avp-prop avp-prop--${v}">${ICONE(ICONE_VERDICT[v])}${ECHAPPER(T('avis.v_' + v))}</span>` : ''
  if (a.detecte) return badge(a.verdict)
  const corrige = a.verdict_source === 'humain' ? `<span class="avp-corrige">${ECHAPPER(T('avis.corrige'))}</span>` : ''
  if (!ctx.peutEcrire) return badge(a.verdict) + corrige
  const opts = VERDICTS.map(v => `<option value="${v}"${a.verdict === v ? ' selected' : ''}>${ECHAPPER(T('avis.v_' + v))}</option>`).join('')
  return `<select class="avp-prop avp-prop--${ECHAPPER(a.verdict || 'attente')}" data-requalif="${ECHAPPER(a.id)}" title="${ECHAPPER(T('avis.corriger'))}" aria-label="${ECHAPPER(T('avis.proprete_aria'))}">${opts}</select>${corrige}`
}

function note (a, ctx) {
  if (a.note_sur_5 == null) return ''
  return `<span class="avp-note">${ICONE('i-review', 'icon--fill')}${ECHAPPER(uneDecimale(a.note_sur_5, ctx.langue))}<span class="avp-note__sur"> / 5</span></span>`
}

// Un texte long se replie a deux lignes, « Voir tout » le deplie.
function texteRepliable (texte, cle, ctx) {
  const long = texte.length > 220
  return `<p class="avp-texte${long ? ' avp-texte--replie' : ''}" data-texte="${ECHAPPER(cle)}">${ECHAPPER(texte)}</p>`
    + (long ? `<button type="button" class="avp-plus" data-plus="${ECHAPPER(cle)}">${ECHAPPER(ctx.T('avis.voir_tout'))}</button>` : '')
}

function blocSonAvis (a, ctx, cle) {
  const { T } = ctx
  if (a.masque) return `<p class="avp-gris">${ICONE('i-lock')}${ECHAPPER(T('avis.masque'))}</p>`
  const texte = a.texte || ''
  return `<div class="avp-son">`
    + `<div class="avp-ligne"><span class="sr-only">${ECHAPPER(T('avis.son_avis'))}</span>${note(a, ctx)}${proprete(a, ctx)}</div>`
    + (a.extrait ? `<p class="avp-extrait">« ${ECHAPPER(a.extrait)} »</p>` : '')
    + (texte ? texteRepliable(texte, cle, ctx) : `<p class="avp-gris">${ECHAPPER(T('avis.sans_texte'))}</p>`)
    + '</div>'
}

function delai (j, ctx) {
  if (j === null || j === undefined) return ''
  // Un jour restant ou moins : moins de 24 h, c'est le dernier jour.
  // ⚠ L'URGENCE SE DIT EN MOTS, la couleur ne fait que la souligner : une page
  // lue en niveaux de gris doit rester claire.
  if (j <= 1) return `<span class="avp-delai avp-delai--urgent">${ICONE('i-scheduled')}${ECHAPPER(ctx.T('avis.dernier_jour'))}</span>`
  return `<span class="avp-delai${j <= 3 ? ' avp-delai--urgent' : ''}">${ICONE('i-scheduled')}${ECHAPPER(ctx.T('avis.jours_restants', { n: j }))}</span>`
}

const etatDe = (e, ctx) => ctx.T('avis.etat_' + e.etat) === 'avis.etat_' + e.etat ? e.etat : ctx.T('avis.etat_' + e.etat)

function origineDe (e, ctx) {
  if (!e.origine) return ''
  const cle = 'avis.origine_' + e.origine.cle
  const t = ctx.T(cle)
  return t === cle ? (e.origine.libelle || '') : t
}

function boutonEvaluer (c, ctx) {
  const e = c.evaluation
  if (!e || !e.evaluable || !ctx.avecBus) return ''
  const prenom = (c.voyageur && c.voyageur.prenom) || ctx.T('avis.ce_voyageur')
  return `<button type="button" class="btn btn--primary avp-evaluer" data-evaluer="${ECHAPPER(e.booking_uid)}">${ICONE('i-edit')}${deuxFormes(ctx.T('avis.evaluer', { prenom }), ctx.T('avis.evaluer_court'))}</button>`
}

function blocNotreAvis (c, ctx, cle) {
  const { T } = ctx
  const e = c.evaluation
  const tete = `<span class="avp-lib">${ECHAPPER(T('avis.notre_avis'))}</span>`
  if (!e) return `<div class="avp-notre">${tete}<span class="avp-gris">${ECHAPPER(T('avis.aucune_eval'))}</span></div>`
  const etat = etatDe(e, ctx)
  const etatDate = e.publie_le ? T('avis.etat_le', { etat, date: dateCourte(e.publie_le, ctx.langue) }) : etat
  const origine = origineDe(e, ctx)
  const corps = e.texte
    ? texteRepliable(`« ${e.texte} »`, cle + '-n', ctx)
    : e.etat === 'expiree' ? `<p class="avp-gris">${ECHAPPER(T('avis.delai_passe'))}</p>` : ''
  return `<div class="avp-notre">${tete}`
    + `<span class="avp-etat">${e.etat === 'publiee' ? ICONE('i-check', 'avp-ok') : ''}${ECHAPPER(etatDate)}</span>`
    + (origine ? `<span class="avp-origine">${ICONE('i-ai')}${ECHAPPER(origine)}</span>` : '')
    + (e.evaluable ? delai(e.jours_restants, ctx) : '')
    + boutonEvaluer(c, ctx)
    + corps + '</div>'
}

function carte (c, ctx, cle) {
  const canal = canalDe(c.plateforme, ctx.T)
  const avis = c.avis.length
    ? c.avis.map((a, k) => blocSonAvis(a, ctx, `${cle}-${k}`)).join('')
    : `<p class="avp-gris">${ECHAPPER(ctx.T('avis.pas_recu'))}</p>`
  return `<li class="avp-carte" data-cle="${ECHAPPER(c.cle)}">`
    + `<div class="avp-carte__tete">${vignette(c, ctx)}`
    + `<div class="avp-id"><span class="avp-qui">${ECHAPPER(nomDu(c, ctx.T))}</span>`
    + `<span class="avp-infos">${infosDu(c, ctx).map(ECHAPPER).join(' · ')}</span></div>`
    + (canal.ecrit ? `<span class="avp-source">${ECHAPPER(canal.phrase || canal.libelle)}</span>` : '')
    + `${pastilleCanal(canal)}</div>`
    + avis + blocNotreAvis(c, ctx, cle)
    + '</li>'
}

// ─── « A traiter » ──────────────────────────────────────────────────────────
// Une evaluation a faire : la ligne dit qui, ou, quand, ce qu'en dit l'etat
// (« Remplie par la prestataire »…), le delai, et porte le bouton.
function ligneEvaluation (c, ctx, cle) {
  const { T } = ctx
  const e = c.evaluation || {}
  const canal = canalDe(c.plateforme, T)
  // L'etat et l'origine de notre avis, quand ils disent quelque chose
  // (« Remplie par la prestataire », « rédigé par l'IA, pas encore validé ») :
  // l'inventaire les garde (spec §5, D5 et E7).
  const etat = e.etat && e.etat !== 'a_remplir' ? `<span class="avp-etat">${ECHAPPER(etatDe(e, ctx))}</span>` : ''
  const origine = origineDe(e, ctx)
  // L'avis du voyageur, s'il en est un d'affichable : masque (le cas courant),
  // ou recu. Les detections sont sorties a part.
  const avis = c.avis.filter(a => !a.detecte).map((a, k) => (a.masque
    ? `<p class="avp-gris">${ICONE('i-lock')}${deuxFormes(T('avis.masque'), T('avis.masque_court'))}</p>`
    : blocSonAvis(a, ctx, `${cle}-${k}`))).join('')
  return `<li class="avp-ligne-atraiter" data-cle="${ECHAPPER(c.cle)}">${vignette(c, ctx, ' avp-photo--l')}`
    + `<div class="avp-id"><span class="avp-qui">${ECHAPPER(nomCourt(c, T))} ${pastilleCanal(canal)}</span>`
    + `<span class="avp-infos">${infosDu(c, ctx).map(ECHAPPER).join(' · ')}</span>${etat}`
    + (origine ? `<span class="avp-origine">${ICONE('i-ai')}${ECHAPPER(origine)}</span>` : '')
    + `${avis}</div>`
    + `<div class="avp-actions">${delai(e.jours_restants, ctx)}${boutonEvaluer(c, ctx)}</div></li>`
}

// Une detection dans un message : pas un fait tant qu'un humain ne l'a pas
// confirmee. Les boutons ne viennent qu'au droit d'ecriture.
//
// ⚠ L'EXTRAIT NE REMPLACE PAS LE MESSAGE (revue du lot Avis V5, constat 4).
// L'ancien bloc montrait les deux : « douche sale » seul ferait confirmer une
// remarque sur un message qui disait « la douche était sale mais sinon tout
// était parfait ». L'extrait en citation, le message entier replie dessous.
function ligneDetection (a, c, ctx, cle) {
  const { T } = ctx
  const texte = a.texte || ''
  const infos = [T('avis.detecte'), T('avis.a_confirmer'), c.bien || T('avis.bien_inconnu'),
    a.recu_le ? T('avis.recu_le', { date: dateCourte(a.recu_le, ctx.langue, true) }) : ''].filter(Boolean)
  return `<li class="avp-ligne-atraiter avp-ligne-atraiter--detection" data-detection="${ECHAPPER(a.id)}">`
    + `<span class="avp-tuile">${ICONE('i-message')}</span>`
    + `<div class="avp-id"><span class="avp-qui">${ECHAPPER(nomCourt(c, T))}${proprete(a, ctx)}</span>`
    + (a.extrait ? `<span class="avp-citation">« ${ECHAPPER(a.extrait)} »</span>` : '')
    + (texte ? texteRepliable(texte, cle, ctx) : '')
    + `<span class="avp-infos">${infos.map(ECHAPPER).join(' · ')}</span></div>`
    + (ctx.peutEcrire
      ? `<div class="avp-actions"><button type="button" class="btn btn--secondary" data-valider="${ECHAPPER(a.id)}" data-statut="ignore">${ECHAPPER(T('avis.ignorer'))}</button>`
        + `<button type="button" class="btn btn--primary" data-valider="${ECHAPPER(a.id)}" data-statut="confirme">${ICONE('i-check')}<span>${ECHAPPER(T('avis.confirmer'))}</span></button></div>`
      : '')
    + '</li>'
}

// Sort les detections des cartes : elles vont dans « A traiter ». Une carte qui
// n'avait qu'elles, sans evaluation, disparait (elle n'avait rien d'autre a dire).
function separerDetections (cartes) {
  const detections = []
  const restantes = []
  for (const c of cartes || []) {
    const det = (c.avis || []).filter(a => a.detecte)
    for (const a of det) detections.push({ a, c })
    const reste = { ...c, avis: (c.avis || []).filter(a => !a.detecte) }
    if (det.length && !reste.avis.length && !reste.evaluation) continue
    restantes.push(reste)
  }
  return { detections, restantes }
}

function contexte (data, opts) {
  const langue = opts.langue || 'fr'
  const photos = new Map(((data && data.biens) || [])
    .filter(b => b && b.provider_property_id != null && b.photo_url)
    .map(b => [String(b.provider_property_id), b.photo_url]))
  return { T: traducteur(opts.t, langue), langue, photos, peutEcrire: Boolean(opts.peutEcrire), avecBus: Boolean(opts.avecBus) }
}

export function rendreStats (s, opts = {}) {
  if (!s) return ''
  const ctx = contexte(null, opts)
  const { T } = ctx
  if (s.erreur) return `<p class="avp-erreur">${ECHAPPER(T('avis.stats_ko'))}</p>`
  // ⚠ SUR 5, comme partout ailleurs (decision de Thierry, 20 octobre 2026). La
  // note descend DEJA convertie et arrondie une seule fois : on l'affiche, on
  // ne la recalcule pas.
  const moy = s.note_sur_5 == null ? '—' : uneDecimale(s.note_sur_5, ctx.langue)
  const sousNote = [T('avis.sur_5'), s.notes ? T('avis.n_notes', { n: s.notes }) : ''].filter(Boolean).join(' · ')
  return `<div class="avp-chiffre"><b>${ICONE('i-review', 'icon--fill')}${ECHAPPER(moy)}</b><span>${ECHAPPER(sousNote)}</span></div>`
    + `<div class="avp-chiffre"><b>${ECHAPPER(s.total)}</b><span>${ECHAPPER(T('avis.avis_recus'))}</span></div>`
    + `<div class="avp-chiffre"><b><span class="avp-pos">${ICONE('i-thumb-up')}${ECHAPPER(s.positif)}</span>`
    + `<span class="avp-neg">${ICONE('i-thumb-down')}${ECHAPPER(s.remarque)}</span></b><span>${ECHAPPER(T('avis.proprete_lib'))}</span></div>`
}

/**
 * @param data   reponse de l'appel d'ecran (`/api/ecran/avis`)
 * @param opts   { peutEcrire, avecBus, anciensOuverts, t, langue }
 */
export function rendre (data, opts = {}) {
  const ctx = contexte(data, opts)
  const { T } = ctx
  const c = (data && data.cartes) || { attente: [], recents: [], anciens: null }
  const anciensCharges = Array.isArray(c.anciens)
  const att = separerDetections(c.attente)
  const rec = separerDetections(c.recents)
  // ⚠ LES DETECTIONS DES ANCIENS, MEME SECTION FERMEE : le serveur les sert a
  // part (`anciens_a_traiter`), sans quoi la bulle dirait « Rien ne vous
  // attend » pendant qu'un message ecrit apres le depart attend (revue du lot
  // Avis V5, constat 5). Section ouverte, elles viennent des Anciens eux-memes.
  // ⚠ LES DETECTIONS DES ANCIENS VIENNENT DES DEUX SOURCES, sans doublon : la
  // liste servie a part (bornee) ET la section ouverte (bornee autrement). Une
  // seule source les faisait apparaitre ou disparaitre a l'ouverture (re-review
  // du lot V5, B.2).
  const anc = anciensCharges ? separerDetections(c.anciens) : { detections: [], restantes: null }
  const vues = new Set()
  const detections = [...att.detections, ...rec.detections, ...anc.detections, ...separerDetections((data && data.anciens_a_traiter) || []).detections]
    .filter(({ a }) => (vues.has(a.id) ? false : (vues.add(a.id), true)))
  const attente = c.attente || []
  const n = attente.length + detections.length

  const aTraiter = n
    ? `<section class="avp-atraiter" aria-labelledby="avp-atraiter-titre"><div class="avp-atraiter__tete">`
      + `<h2 class="avp-h2" id="avp-atraiter-titre">${ECHAPPER(T('avis.a_traiter'))}</h2><span class="badge badge--amber" data-compte-atraiter>${n}</span></div>`
      + `<ul class="avp-lignes">${attente.map((x, i) => ligneEvaluation(x, ctx, `w${i}`)).join('')}`
      + `${detections.map(({ a, c: carteDe }, i) => ligneDetection(a, carteDe, ctx, `d${i}`)).join('')}</ul></section>`
    : `<p class="avp-rien" data-compte-atraiter="0">${ICONE('i-check')}${ECHAPPER(T('avis.rien'))}</p>`

  const grille = (liste, base) => `<ul class="avp-grille">${liste.map((x, i) => carte(x, ctx, `${base}${i}`)).join('')}</ul>`
  const recents = rec.restantes
  // Le compte des Anciens dit les CARTES que la section montre : une carte qui
  // n'avait qu'une detection est montee dans « À traiter » et n'y est plus.
  const seules = Number(data && data.anciens_detection_seule) || 0
  const anciensTotal = Math.max(0, (Number(data && data.anciens_total) || 0) - seules)
  const anciens = anciensCharges
    ? (anc.restantes.length ? grille(anc.restantes, 'a') : `<p class="avp-gris">${ECHAPPER(T('avis.anciens_vide'))}</p>`)
      + (data.anciens_tronques ? `<p class="avp-gris">${ECHAPPER(T('avis.anciens_tronques'))}</p>` : '')
    : `<p class="avp-gris">${ECHAPPER(T('avis.chargement'))}</p>`

  return aTraiter
    + (data && data.liste_incomplete ? `<p class="avp-erreur">${ECHAPPER(T('avis.incomplete'))}</p>` : '')
    + `<section class="avp-section"><div class="avp-section__tete"><h2 class="avp-h2">${ECHAPPER(T('avis.recents'))}</h2>`
    + `<span class="avp-sous">${ECHAPPER(T('avis.recents_sous'))}</span></div>`
    + (recents.length ? grille(recents, 'r') : `<p class="avp-gris">${ECHAPPER(T('avis.recents_vide'))}</p>`) + '</section>'
    + `<details class="avp-anciens" data-anciens${opts.anciensOuverts ? ' open' : ''}><summary>${ICONE('i-chevron', 'avp-chevron')}`
    + `<h2 class="avp-h2">${ECHAPPER(T('avis.anciens'))}</h2><span class="avp-compte">${anciensTotal}</span></summary>`
    + anciens + '</details>'
}

/**
 * Monte la liste dans `conteneur`, les chiffres dans `zoneStats`.
 * @param options.charger     (params: string) → donnees ; LEVE sur echec (`err.status`)
 * @param options.actions     { requalifier(id, verdict), valider(id, statut) } ; LEVENT sur echec
 * @param options.bus         hsBus, pour ouvrir la fenetre d'evaluation
 * @param options.peutEcrire  droit d'ecriture sur `avis` (confort : le serveur revalide)
 * @param options.filtres     () → { periode, bien }
 * @param options.surDonnees  rappel avec la reponse (biens, periodes) pour la page
 * @param options.initiales   donnees deja connues (cache), peintes avant la lecture
 * @param options.t, options.langue  la traduction de la page (I18n)
 */
export async function monter (conteneur, options = {}) {
  if (!conteneur) throw new Error('[avis] les cartes exigent un conteneur')
  const { charger: lire, actions = {}, bus = null, peutEcrire = false, filtres = () => ({}), surDonnees = () => {}, zoneStats = null, initiales = null, surPret = () => {}, surEchec = () => {}, t = null, langue = 'fr' } = options
  if (typeof lire !== 'function') throw new Error('[avis] les cartes exigent une lecture')
  const T = traducteur(t, langue)
  const etat = { data: null, anciensOuverts: false, seq: 0 }
  const alerter = (m) => { try { (conteneur.ownerDocument.defaultView || window).alert(m) } catch { /* sans fenetre */ } }
  const params = (anciens) => {
    const f = filtres() || {}
    return [f.periode ? `periode=${encodeURIComponent(f.periode)}` : '', f.bien ? `bien=${encodeURIComponent(f.bien)}` : '', anciens ? 'anciens=1' : '']
      .filter(Boolean).join('&')
  }
  const afficher = () => {
    conteneur.innerHTML = rendre(etat.data, { peutEcrire, avecBus: Boolean(bus), anciensOuverts: etat.anciensOuverts, t, langue })
    if (zoneStats) { zoneStats.innerHTML = rendreStats(etat.data && etat.data.stats, { t, langue }); zoneStats.hidden = false }
  }
  // ⚠ LA DERNIERE LECTURE DEMANDEE GAGNE, PAS LA DERNIERE ARRIVEE (revue du lot
  // Avis V5, constat 3). Deux filtres cliques vite, ou un geste suivi d'un
  // filtre, mettent deux lectures en vol ; sans numero, la plus lente
  // repeignait l'ecran avec un filtre qui n'est plus presse.
  async function charger () {
    const n = ++etat.seq
    let data
    try {
      data = await lire(params(etat.anciensOuverts))
    } catch (err) {
      if (n !== etat.seq) return false
      // ⚠ UN ECHEC SE DIT : une liste vide laisserait croire qu'il n'y a rien.
      const statut = err && (err.status || err.statut)
      surEchec(err)
      conteneur.innerHTML = `<p class="avp-erreur">${ECHAPPER(statut === 403 ? T('avis.acces_refuse') : (err && err.message) || T('avis.illisibles'))}</p>`
      if (zoneStats) zoneStats.hidden = true
      return false
    }
    if (n !== etat.seq) return false
    etat.data = data
    surDonnees(etat.data)
    // ⚠ `surDonnees` PEUT RELANCER UNE LECTURE (un filtre que le serveur ne
    // propose plus est remis au defaut) : on ne peint alors pas une reponse
    // qui vient d'etre perimee (re-review du lot V5, B.1).
    if (n !== etat.seq) return false
    afficher()
    return true
  }

  conteneur.addEventListener('toggle', async (ev) => {
    const d = ev.target
    if (!d || !d.matches || !d.matches('[data-anciens]')) return
    etat.anciensOuverts = d.open
    if (d.open && !(etat.data && etat.data.cartes && Array.isArray(etat.data.cartes.anciens))) await charger()
  }, true)
  conteneur.addEventListener('change', async (ev) => {
    const id = ev.target && ev.target.dataset && ev.target.dataset.requalif
    if (!id) return
    ev.target.disabled = true
    try { await actions.requalifier(id, ev.target.value) } catch (err) { alerter((err && err.message) || T('avis.correction_ko')) }
    // On RELIT dans tous les cas : en echec, l'ecran ne garde pas un choix que la base n'a pas.
    await charger()
  })
  conteneur.addEventListener('click', async (ev) => {
    const t0 = ev.target && ev.target.closest ? ev.target.closest('[data-valider],[data-plus],[data-evaluer]') : null
    if (!t0 || !t0.dataset) return
    if (t0.dataset.valider) {
      if (t0.disabled) return
      t0.disabled = true
      try { await actions.valider(t0.dataset.valider, t0.dataset.statut); await charger() } catch (err) { t0.disabled = false; alerter((err && err.message) || T('avis.action_ko')) }
      return
    }
    if (t0.dataset.plus) {
      const p = conteneur.querySelector(`[data-texte="${t0.dataset.plus}"]`)
      if (p) p.classList.remove('avp-texte--replie')
      t0.remove()
      return
    }
    if (t0.dataset.evaluer) {
      // ⚠ PAR LE BUS, TOUJOURS. Sans bus, le bouton n'est pas propose.
      if (!bus) return
      const r = await bus.ouvrir('avis.evaluer', { booking_uid: t0.dataset.evaluer })
      if (!r || r.ok !== true) { alerter(T('avis.eval_indispo')); return }
      // Au retour de la fenetre, l'etat a pu changer : on relit.
      await charger()
    }
  })

  // ⚠ LA RELECTURE EST CONFIEE A LA PAGE AVANT LA PREMIERE REPONSE (revue du
  // lot Avis V5, constat 2) : un filtre clique pendant le chargement doit
  // relire, pas seulement repeindre sa pastille.
  surPret(charger)
  // L'affichage instantane : les CHIFFRES et les filtres connus, peints tout de
  // suite. ⚠ JAMAIS LES CARTES : elles portent des noms de voyageurs, des dates
  // de sejour et le texte des avis, que le cache du navigateur ne garde pas
  // (revue du lot Avis V5, constat 1) — elles attendent le serveur.
  if (initiales) {
    surDonnees(initiales)
    if (zoneStats && initiales.stats) { zoneStats.innerHTML = rendreStats(initiales.stats, { t, langue }); zoneStats.hidden = false }
  }
  const ok = await charger()
  return { charge: ok, recharger: charger }
}
