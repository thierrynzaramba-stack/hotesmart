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
 * @param {Document} [o.doc]      le document (le banc en injecte un)
 */
export function monterConnaissance ({ racine, appel, t, esc, bien = null, resa = null,
  selecteur = false, onBien = null, doc = null }) {
  const d = doc || racine.ownerDocument
  const icone = (id, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="/shared/icons.svg#${id}"/></svg>`
  // Le dernier logement ANNONCÉ à `onBien` : distinct de `etat.ref`, que le
  // sélecteur pose AVANT la lecture — comparer à lui ne déclenchait jamais
  // l'annonce après un changement au sélecteur (constat de review : l'adresse
  // de la page téléphone gardait l'ancien `?bien=`).
  let refAnnoncee = bien ? String(bien) : null
  const etat = {
    ref: bien ? String(bien) : null,
    donnees: null, erreur: null, chargement: false,
    mode: 'liste',          // 'liste' | 'edition' | 'fait'
    edition: null,          // { id, sujetInitial, texteInitial, lisibleInitial }
    fait: null,             // { cle, initial }
    note: null,             // { texte, ok }
    apercu: null,           // { texte, prenom } de l'éditeur
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

  function carteHtml (c) {
    const badges = (c.aRevoir ? `<span class="kb-badge kb-badge--revoir">${esc(t('kb.to_review'))}</span>` : '')
      + (c.horsIa ? `<span class="kb-badge kb-badge--horsia">${icone('i-lock')}${esc(t('kb.no_ai'))}</span>` : '')
    const pied = c.verifieLe
      ? esc(t('kb.checked_on', { date: date(c.verifieLe) }))
      : esc(t('kb.never_checked'))
    return `<button type="button" class="kb-carte" data-kb-ouvrir="${esc(c.id)}">
      <span class="kb-carte__tete">${icone('i-message')}<span class="kb-carte__sujet">${esc(c.sujet)}</span>${badges}</span>
      <span class="kb-carte__texte">${segmentsHtml(c.segments)}</span>
      <span class="kb-carte__pied caption muted">${pied}</span>
    </button>`
  }

  function faitHtml (f) {
    const libelle = f.sansBalise ? esc(f.cle) : esc(f.libelle)
    if (etat.mode === 'fait' && etat.fait && etat.fait.cle === f.cle) {
      return `<div class="kb-fait kb-fait--edition">
        <label class="kb-fait__libelle" for="kb-fait-saisie">${libelle}</label>
        <input id="kb-fait-saisie" data-kb-fait-saisie value="${esc(f.valeur)}" maxlength="1000" autocomplete="off">
        <div class="kb-actions">
          <button type="button" class="btn btn--primary" data-kb-fait-enregistrer>${esc(t('kb.save'))}</button>
          <button type="button" class="kb-lien" data-kb-annuler>${esc(t('kb.cancel'))}</button>
        </div>
      </div>`
    }
    // Une valeur vide AVEC un défaut (les horaires) montre ce que le voyageur
    // recevra, marqué « par défaut » — pas un « À remplir » qui serait faux.
    // … et la fiche du logement passe AVANT le défaut, comme dans le
    // remplaceur : c'est ce que le voyageur recevra vraiment.
    const vide = !String(f.valeur || '').trim()
    const valeur = f.aRemplir
      ? `<span class="kb-fait__valeur kb-a-remplir">${esc(t('kb.to_fill'))}</span>`
      : vide && f.repli
        ? `<span class="kb-fait__valeur">${esc(f.repli)} <span class="caption muted">${esc(t('kb.from_property'))}</span></span>`
        : vide && f.defaut
          ? `<span class="kb-fait__valeur">${esc(f.defaut)} <span class="caption muted">${esc(t('kb.by_default'))}</span></span>`
          : `<span class="kb-fait__valeur">${esc(f.valeur)}</span>`
    const sous = f.sansBalise ? `<span class="caption muted">${esc(t('kb.ai_only'))}</span>` : ''
    const verrou = f.horsIa ? `<span class="kb-badge kb-badge--horsia">${icone('i-lock')}${esc(t('kb.no_ai'))}</span>` : ''
    return `<div class="kb-fait">
      <span class="kb-fait__libelle">${libelle}${sous}</span>${valeur}${verrou}
      <button type="button" class="kb-icone" data-kb-modifier-fait="${esc(f.cle)}"
        aria-label="${esc(t('kb.edit_info', { info: f.sansBalise ? f.cle : f.libelle }))}">${icone('i-edit')}</button>
    </div>`
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
      <div class="kb-section">
        <h3 class="kb-section__titre">${esc(t('kb.property_info'))}</h3>
      </div>
      <div class="kb-faits">${(r.faits || []).map(faitHtml).join('')}</div>`
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
      const champ = racine.querySelector('[data-kb-fait-saisie]')
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
      const champ = racine.querySelector('[data-kb-fait-saisie]')
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
    const champ = racine.querySelector('[data-kb-fait-saisie]')
    if (!champ) return
    enCours = true
    geler(true)
    try {
      await appel('/api/ecran/connaissance', {
        action: 'enregistrer', bien: etat.ref, type: 'fixed', key: etat.fait.cle, value: champ.value.trim()
      })
      etat.mode = 'liste'; etat.fait = null
      await recharger()
      etat.note = { texte: t('kb.saved'), ok: true }
      peindre()
    } catch (err) {
      etat.note = { texte: texteErreur(err) }
      const valeur = champ.value
      peindre()
      const neuf = racine.querySelector('[data-kb-fait-saisie]')
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
    if (cible.hasAttribute('data-kb-fait-enregistrer')) { enregistrerFait(); return }
    if (cible.dataset.kbModifierFait != null) {
      const f = ((etat.donnees || {}).faits || []).find(x => x.cle === cible.dataset.kbModifierFait)
      if (!f) return
      etat.mode = 'fait'; etat.fait = { cle: f.cle, initial: f.valeur }; etat.note = null
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
    if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('[data-kb-fait-saisie]')) {
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
    get etat () { return etat },
    recharger, enEdition, detruire, inserer, rafraichirApercu, lireEditeur
  }
}
