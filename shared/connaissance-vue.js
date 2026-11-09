// shared/connaissance-vue.js — L'ÉCRAN DE LA BASE DE CONNAISSANCE V5 (lot 3).
// Spec : docs/specs/spec-base-connaissance-v5.md §3.
//
// ⚠ UN SEUL MODULE POUR LES DEUX ÉCRANS, ET C'EST LA RÈGLE « LE MOBILE SUIT
// L'ORDINATEUR » : le volet de 440 px de Messages (ordinateur) et la page plein
// écran /connaissance (téléphone) montent CETTE vue. Deux copies de la carte,
// de l'éditeur ou du bloc « Infos du logement » divergeraient au premier
// correctif — le dépôt l'a payé avec la couleur des réservations.
//
// ⚠ CE MODULE NE CALCULE AUCUNE RÈGLE. Les étiquettes, le « À remplir », le
// seuil des 90 jours et le « Hors IA » arrivent tout faits de
// `/api/ecran/connaissance`, qui les tient de `lib/connaissance.js`. L'aperçu
// « rempli avec le vrai voyageur » est calculé par le SERVEUR, avec le seul
// remplaceur du dépôt (`lib/balises.js`) : un remplacement refait ici serait la
// troisième copie que le lot 1 a supprimée.
//
// ⚠ ET IL NE NOMME RIEN AU NIVEAU DU MODULE EN DEHORS DE CE QU'IL EXPORTE, tous
// préfixés `kb`. Le banc de Messages évalue les modules partagés dans la MÊME
// portée que la page : un `const t` ou un `function esc` ici entrerait en
// collision avec ceux de `pages/messages.html`.

import { confirmerDansLaPage } from '/shared/confirmer.js'
// « Le remplir » écrit une info d'accueil par le MÊME module que la fiche du
// logement (lot « Accueil du voyageur », 8 novembre 2026) : deux copies
// divergent.
import { editeurInfoHtml, enregistrerInfo } from '/shared/accueil-voyageur.js'

// Les quatre balises de l'insertion rapide, dans l'ordre de la maquette ; le
// reste est derrière « Autre… ». Les LIBELLÉS viennent du serveur (BALISES).
export const KB_INSERTION_RAPIDE = ['prenom', 'telephone_hote', 'checkin', 'wifi_nom']

// Le délai de l'aperçu après une frappe : pas une requête par touche.
export const KB_DELAI_APERCU = 400

// Les bornes de l'endpoint (api/ecran/connaissance.js), dites AVANT l'envoi :
// la zone éditable n'a pas de `maxlength`, et un refus serveur après coup
// coûte un aller-retour pour un texte que l'hôte doit de toute façon raccourcir.
export const KB_MAX_TEXTE = 4000
export const KB_MAX_SUJET = 200

/**
 * Le texte d'une zone d'édition, balises rendues en `{cle}`.
 * ⚠ LE NAVIGATEUR DÉCIDE DU BALISAGE D'UN RETOUR À LA LIGNE : Chrome pose des
 * `<div>`, Firefox des `<br>`. Les deux se lisent ici en `\n`, une seule fois —
 * une ligne vide de Chrome est `<div><br></div>`.
 */
export function kbVersTexte (noeud) {
  let s = ''
  for (const n of noeud.childNodes) {
    if (n.nodeType === 3) { s += n.nodeValue; continue }
    if (n.nodeType !== 1) continue
    if (n.dataset && n.dataset.balise) { s += '{' + n.dataset.balise + '}'; continue }
    if (n.tagName === 'BR') { s += '\n'; continue }
    if (n.tagName === 'DIV' || n.tagName === 'P') {
      if (s && !s.endsWith('\n')) s += '\n'
      s += kbVersTexte(n)
      continue
    }
    s += kbVersTexte(n)
  }
  // L'espace insécable et l'espace de largeur nulle (posé après une étiquette
  // pour y garder le curseur) ne sont pas du texte de l'hôte.
  return s.replace(/ /g, ' ').replace(/​/g, '')
}

/**
 * Monte l'écran dans `racine`.
 * @param {object}   o
 * @param {Element}  o.racine     le conteneur (corps du volet, ou main de la page)
 * @param {function} o.appel      (chemin, corpsPost?) => Promise<json> ; lève avec `status`
 * @param {function} o.t          i18n
 * @param {function} o.esc        échappement HTML
 * @param {string}   [o.bien]     référence provider du logement demandé
 * @param {string}   [o.resa]     réservation du fil ouvert, pour l'aperçu
 * @param {boolean}  [o.selecteur] la vue pose son propre sélecteur (téléphone)
 * @param {function} [o.onBien]   prévenu quand le logement affiché change
 * @param {function} [o.utiliser] `({ texte, resa, ref, sujet }) => void` : la page
 *   hôte qui a une conversation ouverte le passe, et chaque réponse prête porte
 *   alors un bouton « Utiliser » (spec kb-utiliser-reponse). Sans lui — la page
 *   téléphone, ou Messages sans fil ouvert — aucun bouton.
 * @param {Document} [o.doc]      le document (le banc en injecte un)
 */
export function monterConnaissance ({ racine, appel, t, esc, bien = null, resa = null,
  selecteur = false, onBien = null, utiliser = null, doc = null }) {
  const d = doc || racine.ownerDocument
  const icone = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="/shared/icons.svg#${id}"/></svg>`
  // Le dernier logement ANNONCÉ à `onBien` : distinct de `etat.ref`, que le
  // sélecteur pose AVANT la lecture — comparer à lui ne déclenchait jamais
  // l'annonce après un changement au sélecteur (constat de review : l'adresse
  // de la page téléphone gardait l'ancien `?bien=`).
  let refAnnoncee = bien ? String(bien) : null
  // Le logement de la conversation, figé au montage : « Utiliser » n'existe que
  // tant que la vue montre CE logement (R2 — jamais le wifi d'une autre maison).
  const bienDuFil = resa && bien ? String(bien) : null
  const etat = {
    ref: bien ? String(bien) : null,
    donnees: null, erreur: null, chargement: false,
    mode: 'liste',          // 'liste' | 'edition' | 'fait'
    edition: null,          // { id, sujetInitial, texteInitial, lisibleInitial }
    fait: null,             // { cle, initial }
    note: null,             // { texte, ok }
    apercu: null,           // { texte, prenom } de l'éditeur
    refus: null,            // { id, lignes: [texte], remplir: cle|null } — « Utiliser » refusé
    detruite: false
  }
  let minuteur = null
  let dernierRange = null
  let generation = 0       // une réponse en retard ne repeint pas un autre bien

  const balise = (cle) => ((etat.donnees && etat.donnees.balises) || []).find(b => b.cle === cle)
  const libelleDe = (cle) => (balise(cle) || {}).libelle || cle
  const marqueurs = () => ((etat.donnees && etat.donnees.balises) || []).map(b => b.marqueur).filter(Boolean)
  const date = (iso) => {
    const x = new Date(iso)
    if (!Number.isFinite(x.getTime())) return ''
    try { return window.I18n.date(x, { day: 'numeric', month: 'short', year: 'numeric' }) } catch { return x.toISOString().slice(0, 10) }
  }

  // ─── Lecture ──────────────────────────────────────────────────────────
  async function recharger (ref) {
    if (ref !== undefined) etat.ref = ref ? String(ref) : null
    const g = ++generation
    etat.chargement = true
    etat.erreur = null
    peindre()
    const q = new URLSearchParams()
    if (etat.ref) q.set('bien', etat.ref)
    if (resa) q.set('resa', String(resa))
    try {
      const r = await appel('/api/ecran/connaissance' + (q.toString() ? '?' + q : ''))
      if (g !== generation || etat.detruite) return
      etat.donnees = r
      etat.refus = null
      const vu = r && r.bien ? String(r.bien.ref) : null
      etat.ref = vu
      if (vu !== refAnnoncee) {
        refAnnoncee = vu
        if (typeof onBien === 'function') onBien(vu)
      }
    } catch (e) {
      if (g !== generation || etat.detruite) return
      etat.donnees = null
      etat.erreur = e && e.status === 403 ? 'acces' : 'lecture'
    }
    etat.chargement = false
    peindre()
  }

  // ─── Peinture ─────────────────────────────────────────────────────────
  const segmentsHtml = (segments) => (segments || []).map(s => (s.cle
    ? `<span class="kb-etiquette${s.vide ? ' kb-etiquette--vide' : ''}">${esc(s.libelle)}</span>`
    : esc(s.texte))).join('')

  // ⚠ UNE INFORMATION ABSENTE SE VOIT EN ROUGE DANS L'APERÇU AUSSI : le
  // remplaceur y pose son marqueur (« [WIFI NOM] »), et c'est exactement ce
  // que le voyageur lirait. On le colore, on ne le cache pas.
  function apercuHtml (texte) {
    let h = esc(texte || '')
    for (const m of marqueurs()) {
      const e = esc(m)
      h = h.split(e).join(`<span class="kb-manque">${e}</span>`)
    }
    return h
  }

  function enTete () {
    const r = etat.donnees || {}
    const b = r.bien
    const photo = b && b.photo
      ? `<img class="kb-bien__photo" src="${esc(b.photo)}" alt="" width="40" height="40" loading="lazy">`
      : `<span class="kb-bien__photo kb-bien__photo--vide">${icone('i-home')}</span>`
    if (!selecteur) return b ? `<div class="kb-bien">${photo}<span class="kb-bien__nom">${esc(b.nom)}</span></div>` : ''
    const options = (r.biens || []).map(x =>
      `<option value="${esc(x.ref)}"${b && x.ref === b.ref ? ' selected' : ''}>${esc(x.nom || x.ref)}</option>`).join('')
    return `<label class="kb-bien">${photo}<span class="sr-only">${esc(t('messages.drawer_property'))}</span>
      <select data-kb-bien ${etat.mode !== 'liste' ? 'disabled' : ''}>${options}</select></label>`
  }

  // ⚠ « UTILISER » N'EXISTE QUE POUR LE VOYAGEUR ET LE LOGEMENT DE LA
  // CONVERSATION — spec kb-utiliser-reponse §2. Trois conditions, toutes
  // nécessaires : la page l'a demandé, le serveur dit que l'aperçu est fait pour
  // CETTE réservation (`duFil`, R1), et la vue montre encore le logement du fil
  // (R2). Une seule qui manque, et le bouton n'est pas peint.
  function utilisable () {
    const v = etat.donnees && etat.donnees.voyageur
    return typeof utiliser === 'function' && !!resa && !!bienDuFil
      && etat.ref === bienDuFil && !!v && v.duFil === true && String(v.resa) === String(resa)
  }

  function carteHtml (c) {
    const badges = (c.aRevoir ? `<span class="kb-badge kb-badge--revoir">${esc(t('kb.to_review'))}</span>` : '')
      + (c.horsIa ? `<span class="kb-badge kb-badge--horsia">${icone('i-lock')}${esc(t('kb.no_ai'))}</span>` : '')
    const pied = c.verifieLe
      ? esc(t('kb.checked_on', { date: date(c.verifieLe) }))
      : esc(t('kb.never_checked'))
    const carte = `<button type="button" class="kb-carte" data-kb-ouvrir="${esc(c.id)}">
      <span class="kb-carte__tete">${icone('i-message')}<span class="kb-carte__sujet">${esc(c.sujet)}</span>${badges}</span>
      <span class="kb-carte__texte">${segmentsHtml(c.segments)}</span>
      <span class="kb-carte__pied caption muted">${pied}</span>
    </button>`
    if (!utilisable()) return carte
    const refus = etat.refus && etat.refus.id === String(c.id) ? etat.refus : null
    const lignes = refus ? refus.lignes.map(l =>
      `<p class="kb-note" role="status" data-kb-refus>${esc(l)}</p>`).join('') : ''
    // ⚠ « LE REMPLIR » SE FAIT SUR PLACE, SOUS LE REFUS (décision de Thierry du
    // 8 novembre 2026) : les infos d'accueil vivent dans la fiche du logement,
    // mais on ne quitte pas la conversation pour en compléter une.
    const fait = etat.mode === 'fait' && etat.fait && etat.fait.carte === String(c.id)
      ? ((etat.donnees && etat.donnees.faits) || []).find(x => x.cle === etat.fait.cle) : null
    const editeur = fait ? editeurInfoHtml(fait, { t, esc }) : ''
    const remplir = refus && refus.remplir && !fait
      ? `<button type="button" class="kb-lien" data-kb-remplir="${esc(refus.remplir)}">${esc(t('kb.fill_it'))}</button>` : ''
    // L'adresse est la seule info qui ne se remplit pas ici : elle vit dans la
    // fiche du logement (une seule adresse, décision du 8 novembre 2026).
    const versFiche = refus && refus.fiche && lienFiche()
      ? `<a class="kb-lien" href="${esc(lienFiche())}" data-kb-vers-fiche>${esc(t('kb.open_listing'))}</a>` : ''
    return `<div class="kb-carte-bloc">${carte}${lignes}${editeur}
      <div class="kb-carte-bloc__actions">${remplir}${versFiche}
        <button type="button" class="btn btn--secondary kb-utiliser" data-kb-utiliser="${esc(c.id)}">${esc(t('kb.use'))}</button>
      </div>
    </div>`
  }

  // Ce qui empêche d'utiliser une réponse TELLE QUELLE (R3). Rend `null` si elle
  // peut partir. Le serveur a fait le remplacement pour CE voyageur : on ne
  // refait rien ici, on lit ses trois signaux.
  function refusDe (c) {
    const lignes = []
    const manquants = Array.isArray(c.manquants) ? c.manquants : []
    const inconnues = Array.isArray(c.inconnues) ? c.inconnues : []
    if (manquants.length) lignes.push(t('kb.use_missing', { liste: manquants.map(libelleDe).join(', ') }))
    if (c.codeNonResolu === true) lignes.push(t('kb.use_code'))
    if (inconnues.length) lignes.push(t('kb.use_unknown', { liste: inconnues.join(', ') }))
    if (!lignes.length && !String(c.apercu || '').trim()) lignes.push(t('kb.use_empty'))
    // ⚠ LA DERNIÈRE GARDE LIT LE TEXTE LUI-MÊME (constat 3 de la review) : un
    // repère du remplaceur ou une accolade restée (`{wifi-mdp}`, que la
    // reconnaissance des balises ne voit pas) ne va jamais dans la conversation,
    // quel que soit le signal qui aurait dû le dire.
    const apercu = String(c.apercu || '')
    if (!lignes.length && (marqueurs().some(m => apercu.includes(m)) || /\{[^{}]*\}/.test(apercu))) {
      lignes.push(t('kb.use_incomplete'))
    }
    if (!lignes.length) return null
    // « Le remplir » ouvre la PREMIÈRE information manquante qui vit dans la
    // base de ce logement — là où l'hôte la complète, dans la même vue.
    const faits = (etat.donnees && etat.donnees.faits) || []
    const remplir = manquants.find(cle => faits.some(f => f.cle === cle)) || null
    return { id: String(c.id), lignes, remplir, fiche: manquants.includes('adresse') }
  }

  function utiliserReponse (id) {
    // Pendant une lecture, la liste peinte est celle d'AVANT : utiliser l'une de
    // ses réponses poserait l'ancien texte (constat 5 de la review).
    if (etat.chargement) return
    const c = ((etat.donnees || {}).reponses || []).find(x => String(x.id) === String(id))
    if (!c || !utilisable()) return
    const refus = refusDe(c)
    etat.refus = refus
    if (refus) { peindre(); return }
    utiliser({ texte: String(c.apercu), resa: String(resa), ref: etat.ref, sujet: c.sujet })
  }

  // ⚠ LES INFOS D'ACCUEIL ONT QUITTÉ LA BASE pour la fiche du logement (lot du
  // 8 novembre 2026, décision de Thierry du 6 novembre). La base dit où elles
  // sont ; elle ne les montre plus. L'UUID du bien vient du serveur : la page
  // de la fiche s'ouvre par lui.
  function lienFiche () {
    const b = etat.donnees && etat.donnees.bien
    return b && b.id ? `/logements/${encodeURIComponent(b.id)}` : null
  }
  function infosDansLaFicheHtml () {
    const lien = lienFiche()
    return `<p class="caption muted kb-info" data-kb-infos-fiche>${esc(t('kb.info_in_listing'))}${lien
      ? ` <a class="kb-lien" href="${esc(lien)}">${esc(t('kb.open_listing'))}</a>` : ''}</p>`
  }

  function noteHtml () {
    if (!etat.note) return ''
    return `<p class="kb-note${etat.note.ok ? ' kb-note--ok' : ''}" role="status" data-kb-note>${esc(etat.note.texte)}</p>`
  }

  function listeHtml () {
    const r = etat.donnees
    const reponses = r.reponses || []
    const cartes = reponses.length
      ? reponses.map(carteHtml).join('')
      : `<p class="caption muted kb-vide">${esc(t('kb.empty'))}</p>`
    const migration = r.migration === false
      ? `<p class="caption muted kb-info">${esc(t('kb.migration_missing'))}</p>` : ''
    return `${enTete()}${noteHtml()}${migration}
      <div class="kb-section">
        <h3 class="kb-section__titre">${esc(t('kb.ready_replies'))}</h3>
        <button type="button" class="kb-lien" data-kb-ajouter>${icone('i-plus')}${esc(t('kb.add'))}</button>
      </div>
      <div class="kb-cartes">${cartes}</div>
      ${infosDansLaFicheHtml()}`
  }

  function editeurHtml () {
    const e = etat.edition
    const autres = ((etat.donnees && etat.donnees.balises) || []).filter(b => !KB_INSERTION_RAPIDE.includes(b.cle))
    const rapides = KB_INSERTION_RAPIDE.filter(c => balise(c)).map(c =>
      `<button type="button" class="kb-inserer" data-kb-inserer="${esc(c)}">${esc(libelleDe(c))}</button>`).join('')
    const prenom = etat.apercu && etat.apercu.prenom
    const titreApercu = prenom ? t('kb.preview_for', { name: prenom }) : t('kb.preview')
    return `${enTete()}
      <div class="kb-editeur" data-kb-editeur>
        <label class="kb-champ"><span class="caption muted">${esc(t('kb.subject'))}</span>
          <input data-kb-sujet maxlength="200" autocomplete="off"></label>
        <div class="kb-champ"><span class="caption muted" id="kb-message-titre">${esc(t('kb.message'))}</span>
          <div class="kb-message" contenteditable="true" role="textbox" aria-multiline="true"
            aria-labelledby="kb-message-titre" data-kb-message></div></div>
        <div class="kb-insertion"><span class="caption muted">${esc(t('kb.insert'))}</span>
          ${rapides}
          <button type="button" class="kb-inserer" data-kb-autres aria-expanded="false">${esc(t('kb.other'))}</button>
          <div class="kb-autres" data-kb-liste-autres hidden>${autres.map(b =>
            `<button type="button" class="kb-inserer" data-kb-inserer="${esc(b.cle)}">${esc(b.libelle)}</button>`).join('')}</div>
        </div>
        <div class="kb-apercu"><span class="caption muted" data-kb-apercu-titre>${esc(titreApercu)}</span>
          <p class="kb-apercu__texte" data-kb-apercu>${etat.apercu ? apercuHtml(etat.apercu.texte) : ''}</p></div>
        <label class="kb-interrupteur"><input type="checkbox" data-kb-lisible>
          <span><span class="kb-interrupteur__titre">${esc(t('kb.ai_can_use'))}</span>
          <span class="caption muted">${esc(t('kb.ai_can_use_hint'))}</span></span></label>
        ${noteHtml()}
        <div class="kb-actions">
          <button type="button" class="btn btn--primary" data-kb-enregistrer>${esc(t('kb.save'))}</button>
          <button type="button" class="kb-lien" data-kb-annuler>${esc(t('kb.cancel'))}</button>
          ${e && e.id != null ? `<button type="button" class="kb-supprimer" data-kb-supprimer>${esc(t('kb.delete'))}</button>` : ''}
        </div>
      </div>`
  }

  function peindre () {
    if (etat.detruite) return
    if (etat.chargement && !etat.donnees) {
      racine.innerHTML = `<p class="muted small kb-vide">${esc(t('common.loading'))}</p>`
      return
    }
    if (etat.erreur) {
      racine.innerHTML = `<p class="caption muted kb-vide">${esc(t(etat.erreur === 'acces' ? 'kb.no_access' : 'messages.load_error'))}</p>`
      return
    }
    if (!etat.donnees) return
    if (!etat.donnees.bien) {
      racine.innerHTML = `<p class="muted small kb-vide">${esc(t('messages.empty'))}</p>`
      return
    }
    racine.innerHTML = `<div class="kb">${etat.mode === 'edition' ? editeurHtml() : listeHtml()}</div>`
    if (etat.mode === 'edition') remplirEditeur()
    if (etat.mode === 'fait') {
      const champ = racine.querySelector('[data-acc-saisie]')
      if (champ) champ.focus()
    }
  }

  // L'éditeur se remplit APRÈS la peinture, par le DOM et jamais par du HTML
  // concaténé : le sujet et le texte de l'hôte n'entrent ainsi dans aucune
  // chaîne interprétée.
  function remplirEditeur () {
    const e = etat.edition
    const sujet = racine.querySelector('[data-kb-sujet]')
    const zone = racine.querySelector('[data-kb-message]')
    const lisible = racine.querySelector('[data-kb-lisible]')
    sujet.value = e.sujetCourant
    lisible.checked = e.lisibleCourant
    zone.textContent = ''
    for (const s of e.segmentsCourants) {
      if (s.cle) zone.appendChild(etiquette(s.cle, s.vide === true))
      else ajouterTexte(zone, s.texte)
    }
  }

  // ⚠ UNE BALISE SANS VALEUR RESTE ROUGE DANS L'ÉDITEUR AUSSI. Chargée, elle
  // porte le `vide` du serveur ; insérée, on lit le bloc « Infos du logement »
  // que le serveur a rendu — même règle que `lib/connaissance.js` (une balise de
  // la BASE dont la valeur manque), sans la recalculer.
  function videAInsertion (cle) {
    const b = balise(cle)
    if (!b || b.origine !== 'base') return false
    // L'adresse n'est plus une info de la base : elle vient de la fiche, et le
    // serveur dit seulement si elle y est.
    if (cle === 'adresse') return !(etat.donnees && etat.donnees.bien && etat.donnees.bien.adresse === true)
    const f = ((etat.donnees && etat.donnees.faits) || []).find(x => x.cle === cle)
    return !f || f.aRemplir === true
  }

  function etiquette (cle, vide = videAInsertion(cle)) {
    const n = d.createElement('span')
    n.className = 'kb-etiquette' + (vide ? ' kb-etiquette--vide' : '')
    n.contentEditable = 'false'
    n.dataset.balise = cle
    n.textContent = libelleDe(cle)
    return n
  }

  function ajouterTexte (parent, texte, avant = null) {
    const lignes = String(texte || '').split('\n')
    lignes.forEach((l, i) => {
      if (i > 0) parent.insertBefore(d.createElement('br'), avant)
      if (l) parent.insertBefore(d.createTextNode(l), avant)
    })
  }

  // ─── Éditeur ──────────────────────────────────────────────────────────
  function ouvrirEditeur (id) {
    const r = etat.donnees
    const c = id == null ? null : (r.reponses || []).find(x => String(x.id) === String(id))
    if (id != null && !c) return
    etat.edition = {
      id: c ? c.id : null,
      sujetInitial: c ? c.sujet : '', texteInitial: c ? c.brut : '', lisibleInitial: c ? !c.horsIa : true,
      sujetCourant: c ? c.sujet : '', segmentsCourants: c ? c.segments : [], lisibleCourant: c ? !c.horsIa : true
    }
    etat.apercu = c ? { texte: c.apercu, prenom: r.voyageur && r.voyageur.prenom } : null
    // Un aperçu demandé pour l'éditeur PRÉCÉDENT ne peint pas celui-ci.
    demandeApercu++
    if (minuteur) { clearTimeout(minuteur); minuteur = null }
    etat.mode = 'edition'
    etat.note = null
    peindre()
    const champ = racine.querySelector(c ? '[data-kb-message]' : '[data-kb-sujet]')
    if (champ) champ.focus()
  }

  function lireEditeur () {
    const sujet = racine.querySelector('[data-kb-sujet]')
    const zone = racine.querySelector('[data-kb-message]')
    const lisible = racine.querySelector('[data-kb-lisible]')
    if (!sujet || !zone || !lisible) return null
    return {
      sujet: sujet.value.trim(),
      texte: kbVersTexte(zone).replace(/\n+$/, ''),
      lisible: lisible.checked === true
    }
  }

  // ⚠ UNE ÉCRITURE EN VOL N'EST PLUS UNE SAISIE PERDUE — constat MESURÉ de la
  // seconde review. L'hôte clique Enregistrer puis change de volet avant la
  // réponse : la note disait « pas enregistrée » alors que le POST aboutissait,
  // et il retapait sa réponse pour se heurter au 409 « sujet existe ».
  function enEdition () {
    if (enCours) return false
    if (etat.mode === 'fait' && etat.fait) {
      const champ = racine.querySelector('[data-acc-saisie]')
      return !!champ && champ.value.trim() !== String(etat.fait.initial || '').trim()
    }
    if (etat.mode !== 'edition' || !etat.edition) return false
    const l = lireEditeur()
    if (!l) return false
    const e = etat.edition
    return l.sujet !== String(e.sujetInitial).trim() || l.texte !== String(e.texteInitial).replace(/\n+$/, '')
      || l.lisible !== e.lisibleInitial
  }

  function memoriserCurseur () {
    const zone = racine.querySelector('[data-kb-message]')
    const sel = d.getSelection && d.getSelection()
    if (!zone || !sel || !sel.rangeCount) return
    const r = sel.getRangeAt(0)
    if (zone.contains(r.startContainer)) dernierRange = r.cloneRange()
  }

  // ⚠ L'INSERTION SE FAIT AU CURSEUR, ET LE CURSEUR A ÉTÉ PERDU AU CLIC : cliquer
  // un bouton « Insérer » sort le focus de la zone. On pose donc l'étiquette à
  // la dernière position connue DANS la zone, et à la fin s'il n'y en a pas.
  function inserer (cle) {
    const zone = racine.querySelector('[data-kb-message]')
    if (!zone || !balise(cle)) return
    let range = dernierRange && zone.contains(dernierRange.startContainer) ? dernierRange : null
    if (!range) { range = d.createRange(); range.selectNodeContents(zone); range.collapse(false) }
    range.deleteContents()
    const n = etiquette(cle)
    // Un espace de largeur nulle APRÈS l'étiquette : sans lui, le curseur ne
    // peut pas se poser derrière un élément non éditable, et la frappe suivante
    // atterrit avant l'étiquette. `kbVersTexte` le retire.
    const apres = d.createTextNode('​')
    range.insertNode(apres)
    range.insertNode(n)
    const r2 = d.createRange()
    r2.setStartAfter(apres); r2.collapse(true)
    const sel = d.getSelection && d.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(r2) }
    dernierRange = r2.cloneRange()
    zone.focus()
    planifierApercu(0)
  }

  function planifierApercu (delai = KB_DELAI_APERCU) {
    if (minuteur) clearTimeout(minuteur)
    minuteur = setTimeout(() => { minuteur = null; rafraichirApercu() }, delai)
  }

  // ⚠ UN NUMÉRO PAR DEMANDE D'APERÇU — constat MESURÉ de review : deux frappes
  // rapprochées lancent deux demandes, et si la première revient APRÈS la
  // seconde, l'aperçu montrait l'ancien texte sous le nouveau. Seule la
  // dernière demande partie a le droit de peindre.
  let demandeApercu = 0
  async function rafraichirApercu () {
    const l = lireEditeur()
    if (!l || !etat.ref) return
    const g = generation
    const n = ++demandeApercu
    try {
      const r = await appel('/api/ecran/connaissance',
        { action: 'apercu', bien: etat.ref, texte: l.texte, ...(resa ? { resa: String(resa) } : {}) })
      if (n !== demandeApercu || g !== generation || etat.mode !== 'edition' || etat.detruite) return
      etat.apercu = { texte: (r.apercu || {}).texte || '', prenom: r.voyageur && r.voyageur.prenom }
      const p = racine.querySelector('[data-kb-apercu]')
      if (p) p.innerHTML = apercuHtml(etat.apercu.texte)
      const titre = racine.querySelector('[data-kb-apercu-titre]')
      if (titre) titre.textContent = etat.apercu.prenom ? t('kb.preview_for', { name: etat.apercu.prenom }) : t('kb.preview')
    } catch (e) { /* un aperçu raté ne bloque rien : le texte reste à l'écran */ }
  }

  // Le texte d'une erreur d'écriture, et seulement ce qu'on sait dire.
  // ⚠ « RÉESSAYEZ » SEULEMENT QUAND RÉESSAYER PEUT SERVIR — constat de review :
  // un texte trop long ou une réponse supprimée ailleurs ne passeront pas
  // mieux au second clic.
  function texteErreur (e) {
    if (e && e.status === 409) return t('kb.subject_exists')
    if (e && e.status === 503) return t('kb.migration_missing')
    if (e && e.status === 403) return t('kb.no_access')
    if (e && e.status === 404) return t('kb.not_found')
    if (e && e.status === 400 && e.code === 'trop_long') return t('kb.too_long')
    return t('kb.save_error')
  }

  let enCours = false
  async function enregistrer () {
    if (enCours) return
    const l = lireEditeur()
    if (!l) return
    if (!l.sujet) { etat.note = { texte: t('kb.subject_required') }; repeindreNote(); return }
    if (!l.texte.trim()) { etat.note = { texte: t('kb.message_required') }; repeindreNote(); return }
    if (l.texte.length > KB_MAX_TEXTE || l.sujet.length > KB_MAX_SUJET) {
      etat.note = { texte: t('kb.too_long') }; repeindreNote(); return
    }
    enCours = true
    geler(true)
    const e = etat.edition
    try {
      await appel('/api/ecran/connaissance', {
        action: 'enregistrer', bien: etat.ref, type: 'faq',
        ...(e.id != null ? { id: e.id } : {}),
        key: l.sujet, value: l.texte, lisible_par_ia: l.lisible
      })
      etat.mode = 'liste'; etat.edition = null; etat.apercu = null
      await recharger()
      etat.note = { texte: t('kb.saved'), ok: true }
      peindre()
    } catch (err) {
      // ⚠ LE TEXTE DE L'HÔTE N'EST PAS PERDU : on garde ce qu'il a tapé dans
      // l'état de l'éditeur avant de repeindre la note.
      e.sujetCourant = l.sujet; e.lisibleCourant = l.lisible
      etat.note = { texte: texteErreur(err) }
      repeindreNote()
    } finally {
      enCours = false
      geler(false)
    }
  }

  async function supprimer () {
    const e = etat.edition
    if (!e || e.id == null || enCours) return
    const choix = await confirmerDansLaPage({
      doc: d,
      titre: t('kb.delete_title', { subject: e.sujetInitial }),
      // « l'IA ne s'en servira plus » serait faux d'une réponse Hors IA
      // (recette du 7 novembre 2026) : la phrase suit l'état ENREGISTRÉ.
      texte: t(e.lisibleInitial === false ? 'kb.delete_text_hors_ia' : 'kb.delete_text'),
      fermer: t('messages.close'),
      boutons: [
        { cle: 'supprimer', libelle: t('kb.delete') },
        { cle: 'garder', libelle: t('kb.keep'), principal: true }
      ]
    })
    if (choix !== 'supprimer') return
    enCours = true
    geler(true)
    try {
      await appel('/api/ecran/connaissance', { action: 'supprimer', bien: etat.ref, id: e.id })
      etat.mode = 'liste'; etat.edition = null; etat.apercu = null
      await recharger()
      etat.note = { texte: t('kb.deleted'), ok: true }
      peindre()
    } catch (err) {
      etat.note = { texte: texteErreur(err) }
      repeindreNote()
    } finally {
      enCours = false
      geler(false)
    }
  }

  async function enregistrerFait () {
    if (enCours || !etat.fait) return
    const champ = racine.querySelector('[data-acc-saisie]')
    if (!champ) return
    enCours = true
    geler(true)
    try {
      await enregistrerInfo(appel, { ref: etat.ref, cle: etat.fait.cle, valeur: champ.value })
      // L'aperçu se recalcule à la relecture : « Utiliser » redevient possible
      // si c'était la seule info qui manquait.
      etat.mode = 'liste'; etat.fait = null; etat.refus = null
      await recharger()
      etat.note = { texte: t('kb.saved'), ok: true }
      peindre()
    } catch (err) {
      etat.note = { texte: texteErreur(err) }
      const valeur = champ.value
      peindre()
      const neuf = racine.querySelector('[data-acc-saisie]')
      if (neuf) neuf.value = valeur
    } finally {
      enCours = false
      geler(false)
    }
  }

  // Pendant une écriture, AUCUN geste ne part : un second clic sur Enregistrer
  // ferait deux lignes, un clic sur Annuler repeindrait la liste sous une
  // réponse qui n'est pas encore revenue.
  function geler (oui) {
    racine.querySelectorAll('button, input, select').forEach(x => { x.disabled = oui === true })
    // ⚠ LE SÉLECTEUR DE LOGEMENT RESTE GELÉ HORS DE LA LISTE — constat MESURÉ de
    // review. Le dégel réactivait TOUT, donc aussi le sélecteur que la vue
    // avait désactivé en entrant dans l'éditeur : après un refus (409), l'hôte
    // changeait de logement, l'éditeur restait ouvert, et le texte tapé pour
    // un logement partait dans l'AUTRE.
    const sel = racine.querySelector('[data-kb-bien]')
    if (sel && etat.mode !== 'liste') sel.disabled = true
    const zone = racine.querySelector('[data-kb-message]')
    if (zone) zone.contentEditable = oui === true ? 'false' : 'true'
  }

  function repeindreNote () {
    const ancienne = racine.querySelector('[data-kb-note]')
    const html = noteHtml()
    if (ancienne) { ancienne.outerHTML = html; return }
    const actions = racine.querySelector('.kb-editeur .kb-actions')
    if (actions) actions.insertAdjacentHTML('beforebegin', html)
    else peindre()
  }

  function revenirALaListe () {
    etat.mode = 'liste'; etat.edition = null; etat.fait = null; etat.apercu = null; etat.note = null
    etat.refus = null
    demandeApercu++
    if (minuteur) { clearTimeout(minuteur); minuteur = null }
    peindre()
  }

  // ─── Gestes : UN écouteur par type, sur la racine ─────────────────────
  function surClic (ev) {
    const cible = ev.target.closest && ev.target.closest('button, [data-kb-ouvrir]')
    if (!cible || !racine.contains(cible) || cible.disabled) return
    if (cible.dataset.kbOuvrir != null) { ouvrirEditeur(cible.dataset.kbOuvrir); return }
    if (cible.hasAttribute('data-kb-ajouter')) { ouvrirEditeur(null); return }
    if (cible.hasAttribute('data-kb-annuler')) { revenirALaListe(); return }
    if (cible.hasAttribute('data-kb-enregistrer')) { enregistrer(); return }
    if (cible.hasAttribute('data-kb-supprimer')) { supprimer(); return }
    if (cible.hasAttribute('data-acc-enregistrer')) { enregistrerFait(); return }
    if (cible.hasAttribute('data-acc-annuler')) {
      // Annuler « Le remplir » rend la carte et son refus, pas la liste nue.
      etat.mode = 'liste'; etat.fait = null
      peindre()
      return
    }
    if (cible.dataset.kbUtiliser != null) { utiliserReponse(cible.dataset.kbUtiliser); return }
    if (cible.dataset.kbRemplir != null) {
      const f = ((etat.donnees || {}).faits || []).find(x => x.cle === cible.dataset.kbRemplir)
      if (!f || !etat.refus) return
      etat.mode = 'fait'
      etat.fait = { cle: f.cle, initial: f.valeur, carte: etat.refus.id }
      etat.note = null
      peindre()
      return
    }
    if (cible.hasAttribute('data-kb-autres')) {
      const liste = racine.querySelector('[data-kb-liste-autres]')
      if (liste) { liste.hidden = !liste.hidden; cible.setAttribute('aria-expanded', String(!liste.hidden)) }
      return
    }
    if (cible.dataset.kbInserer) { inserer(cible.dataset.kbInserer) }
  }
  // Un bouton d'insertion ne doit pas voler le curseur avant le clic.
  function surAppui (ev) {
    if (ev.target.closest && ev.target.closest('[data-kb-inserer]')) ev.preventDefault()
  }
  function surSaisie (ev) {
    if (ev.target.closest && ev.target.closest('[data-kb-message]')) { memoriserCurseur(); planifierApercu() }
  }
  function surTouche (ev) {
    if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('[data-acc-saisie]')) {
      ev.preventDefault(); enregistrerFait()
    }
  }
  function surRelache (ev) {
    if (ev.target.closest && ev.target.closest('[data-kb-message]')) memoriserCurseur()
  }
  // ⚠ UN COLLAGE ENTRE EN TEXTE BRUT. Coller du HTML (un e-mail, une page)
  // dans une zone éditable y fait entrer des balises, des styles et des liens
  // que le voyageur ne doit jamais recevoir et que `kbVersTexte` aplatirait au
  // hasard.
  function surCollage (ev) {
    const zone = ev.target.closest && ev.target.closest('[data-kb-message]')
    if (!zone) return
    ev.preventDefault()
    const brut = (ev.clipboardData && ev.clipboardData.getData('text/plain')) || ''
    const sel = d.getSelection && d.getSelection()
    let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null
    if (!range || !zone.contains(range.startContainer)) { range = d.createRange(); range.selectNodeContents(zone); range.collapse(false) }
    range.deleteContents()
    const tmp = d.createElement('span')
    ajouterTexte(tmp, brut.replace(/\r\n?/g, '\n'))
    const dernier = tmp.lastChild
    const frag = d.createDocumentFragment()
    while (tmp.firstChild) frag.appendChild(tmp.firstChild)
    range.insertNode(frag)
    if (dernier) {
      const r2 = d.createRange(); r2.setStartAfter(dernier); r2.collapse(true)
      sel.removeAllRanges(); sel.addRange(r2)
    }
    memoriserCurseur()
    planifierApercu()
  }
  function surChangement (ev) {
    const sel = ev.target.closest && ev.target.closest('[data-kb-bien]')
    if (!sel) return
    // Second verrou, côté geste : on ne change JAMAIS de logement sous un
    // éditeur ouvert, quel que soit l'état du `disabled`.
    // (Pas de verrou sur l'écriture en vol : pendant une écriture le mode n'est
    // jamais « liste », et après, la liste repeinte est le bon moment.)
    if (etat.mode !== 'liste') { sel.value = etat.ref || ''; return }
    etat.note = null
    recharger(sel.value)
  }
  const surSelection = () => memoriserCurseur()

  racine.addEventListener('click', surClic)
  racine.addEventListener('mousedown', surAppui)
  racine.addEventListener('input', surSaisie)
  racine.addEventListener('keyup', surRelache)
  racine.addEventListener('keydown', surTouche)
  racine.addEventListener('paste', surCollage)
  racine.addEventListener('change', surChangement)
  d.addEventListener('selectionchange', surSelection)

  function detruire () {
    etat.detruite = true
    if (minuteur) { clearTimeout(minuteur); minuteur = null }
    racine.removeEventListener('click', surClic)
    racine.removeEventListener('mousedown', surAppui)
    racine.removeEventListener('input', surSaisie)
    racine.removeEventListener('keyup', surRelache)
    racine.removeEventListener('keydown', surTouche)
    racine.removeEventListener('paste', surCollage)
    racine.removeEventListener('change', surChangement)
    d.removeEventListener('selectionchange', surSelection)
  }

  const pret = recharger()
  return {
    pret, racine,
    get ref () { return etat.ref },
    // La réservation pour laquelle la vue a été montée : Messages la compare au
    // fil ouvert pour savoir s'il faut la remonter (le fil a changé sous elle).
    get resa () { return resa ? String(resa) : null },
    get etat () { return etat },
    recharger, enEdition, detruire, inserer, rafraichirApercu, lireEditeur
  }
}
