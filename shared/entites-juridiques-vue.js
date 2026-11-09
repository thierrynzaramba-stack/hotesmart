// shared/entites-juridiques-vue.js — la fenêtre « Facturation » de la fiche
// d'un logement : l'entité juridique qui émet ses factures.
// Spec : docs/specs/spec-facture-voyageur.md §4 (D2 bis), §5.1 · KB : docs/kb/entites-juridiques.md
//
// ⚠ D2 BIS (Thierry, 9 nov. 2026, 12 h 08) : plus de page « Entités
// juridiques », plus d'entité par défaut. Sur la fiche d'un logement, une
// fenêtre montre l'entité de CE logement (ou « aucune : il ne peut pas
// facturer ») et la liste des entités du compte, avec :
//   - « Choisir pour ce logement » / « Retirer de ce logement » (elle reste
//     disponible pour les autres logements) ;
//   - « Modifier » (numérotation comprise) et « Régler la numérotation » ;
//   - « Nouvelle entité » : créée depuis ce logement, elle est choisie pour lui.
//
// Un seul endpoint (`/api/entites-juridiques?bien=`) : GET à l'ouverture, POST
// un geste à la fois puis une relecture. Les gestes ne sont montrés qu'au
// TITULAIRE (`titulaire` de la réponse) — et le serveur refuse les autres en
// 403 : ce n'est pas un masquage.
//
// RÈGLES : aucun hexa, aucun texte en dur (clés `ej.*`), tout texte venu du
// serveur passe par `esc`.

// Les champs du formulaire. `pour` : quand le champ s'affiche — toujours, pour
// une société, ou pour un régime assujetti.
const CHAMPS = [
  { id: 'ej-nom', api: 'nom', cle: 'ej.f_nom', requis: true, max: 200 },
  { id: 'ej-forme', api: 'forme_juridique', cle: 'ej.f_forme', aide: 'ej.f_forme_ph', pour: 'societe', max: 60 },
  { id: 'ej-adresse1', api: 'adresse_ligne1', cle: 'ej.f_adresse1', max: 200 },
  { id: 'ej-adresse2', api: 'adresse_ligne2', cle: 'ej.f_adresse2', max: 200 },
  { id: 'ej-cp', api: 'code_postal', cle: 'ej.f_cp', max: 20, duo: 'ville' },
  { id: 'ej-ville', api: 'ville', cle: 'ej.f_ville', max: 120, duo: 'ville' },
  { id: 'ej-pays', api: 'pays', cle: 'ej.f_pays', max: 2, defaut: 'FR' },
  { id: 'ej-siret', api: 'siret', cle: 'ej.f_siret', max: 30 },
  { id: 'ej-tva', api: 'tva_intracom', cle: 'ej.f_tva', max: 30 },
  { id: 'ej-taux', api: 'taux_tva', cle: 'ej.f_taux', pour: 'assujetti', max: 6, mode: 'decimal' },
  { id: 'ej-capital', api: 'capital', cle: 'ej.f_capital', pour: 'societe', max: 60 },
  { id: 'ej-rcs', api: 'rcs', cle: 'ej.f_rcs', pour: 'societe', max: 120 },
  { id: 'ej-email', api: 'email', cle: 'ej.f_email', max: 200, type: 'email' },
  { id: 'ej-tel', api: 'telephone', cle: 'ej.f_tel', max: 40, type: 'tel' }
]
const REGIMES = ['exonere', 'franchise', 'assujetti']
// Numerotation des factures (Q5 bis, Thierry, 9 nov. 2026).
const NUMEROTATIONS = ['auto', 'manuel']

/** Un champ s'affiche-t-il pour ce type et ce régime ? */
function champVisible (c, type, regime) {
  if (!c.pour) return true
  if (c.pour === 'societe') return type === 'societe'
  if (c.pour === 'assujetti') return regime === 'assujetti'
  return true
}

/** Lit le formulaire et rend l'entité à envoyer. Un champ caché part vide. */
function valeursDuFormulaire (form) {
  const type = form.querySelector('input[name="ej-type"]:checked')?.value || ''
  const regime = form.querySelector('#ej-regime')?.value || ''
  const e = { type, regime_tva: regime }
  for (const c of CHAMPS) {
    const el = form.querySelector('#' + c.id)
    e[c.api] = el && champVisible(c, type, regime) ? el.value.trim() : ''
  }
  // Le debut d'exercice : jour et mois, les deux ou rien (« MM-JJ »).
  const jour = form.querySelector('#ej-exercice-jour')?.value || ''
  const mois = form.querySelector('#ej-exercice-mois')?.value || ''
  e.debut_exercice = jour && mois ? `${mois}-${jour}` : (jour || mois ? 'incomplet' : '')
  e.numerotation_factures = form.querySelector('input[name="ej-numerotation"]:checked')?.value || 'auto'
  return e
}

/** Les options jour et mois du debut d'exercice ; noms de mois par Intl. */
function exerciceHtml (valeur, t, esc, langue) {
  const [mm, jj] = typeof valeur === 'string' && valeur.includes('-') ? valeur.split('-') : ['', '']
  const deux = (n) => String(n).padStart(2, '0')
  const nomMois = (m) => {
    try { return new Intl.DateTimeFormat(langue || 'fr', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2001, m - 1, 1))) } catch (e) { return deux(m) }
  }
  const jours = ['<option value=""></option>'].concat(Array.from({ length: 31 }, (_, i) => deux(i + 1))
    .map(d => `<option value="${d}"${d === jj ? ' selected' : ''}>${Number(d)}</option>`)).join('')
  const moisOpt = ['<option value=""></option>'].concat(Array.from({ length: 12 }, (_, i) => deux(i + 1))
    .map(m => `<option value="${m}"${m === mm ? ' selected' : ''}>${esc(nomMois(Number(m)))}</option>`)).join('')
  return `
    <fieldset class="ej-champ" data-champ="debut_exercice">
      <legend>${esc(t('ej.f_exercice'))}</legend>
      <div class="ej-duo">
        <select id="ej-exercice-jour" aria-label="${esc(t('ej.f_exercice_jour'))}" aria-describedby="ej-exercice-err">${jours}</select>
        <select id="ej-exercice-mois" aria-label="${esc(t('ej.f_exercice_mois'))}" aria-describedby="ej-exercice-err">${moisOpt}</select>
      </div>
      <span class="ej-aide">${esc(t('ej.f_exercice_aide'))}</span>
      <span class="ej-erreur" id="ej-exercice-err" hidden></span>
    </fieldset>`
}

/** Le choix de numérotation : automatique (défaut) ou manuelle. */
function numerotationChoixHtml (valeur, t, esc) {
  const v = NUMEROTATIONS.includes(valeur) ? valeur : 'auto'
  const radios = NUMEROTATIONS.map(n => `
      <label class="ej-radio"><input type="radio" name="ej-numerotation" value="${n}"${v === n ? ' checked' : ''}>
        <span>${esc(t('ej.num_mode_' + n))}</span></label>`).join('')
  return `
    <fieldset class="ej-champ" data-champ="numerotation_factures">
      <legend>${esc(t('ej.f_numerotation'))}</legend>
      <div class="ej-radios">${radios}</div>
      <span class="ej-aide">${esc(t('ej.f_numerotation_aide'))}</span>
      <span class="ej-erreur" id="ej-numerotation-err" hidden></span>
    </fieldset>`
}

/** Les lignes de résumé d'une entité, déjà échappées. */
function resume (e, t, esc) {
  const l = []
  const forme = e.type === 'societe' ? (e.forme_juridique || t('ej.type_societe')) : t('ej.type_personne')
  l.push(esc(forme))
  const adresse = [e.adresse_ligne1, e.adresse_ligne2, [e.code_postal, e.ville].filter(Boolean).join(' ')]
    .filter(Boolean).map(esc).join(', ')
  if (adresse) l.push(adresse)
  if (e.siret) l.push(esc(t('ej.siret_label', { siret: e.siret })))
  if (e.regime_tva === 'assujetti') l.push(esc(t('ej.tva_assujetti', { taux: String(e.taux_tva ?? '') })))
  else if (e.regime_tva) l.push(esc(t('ej.tva_' + e.regime_tva)))
  if (e.debut_exercice) {
    const [mm, jj] = e.debut_exercice.split('-')
    l.push(esc(t('ej.exercice_label', { date: `${jj}/${mm}` })))
  }
  return l
}

function formulaireHtml (e, t, esc, langue) {
  const v = e || { type: 'personne_physique', regime_tva: 'exonere', pays: 'FR' }
  const valeur = (c) => esc(v[c.api] ?? (c.defaut || ''))
  const champ = (c) => `
    <div class="ej-champ" data-champ="${c.api}"${champVisible(c, v.type, v.regime_tva) ? '' : ' hidden'}>
      <label for="${c.id}">${esc(t(c.cle))}${c.requis ? ' *' : ''}</label>
      <input id="${c.id}" type="${c.type || 'text'}" maxlength="${c.max}" value="${valeur(c)}"
        ${c.mode ? `inputmode="${c.mode}"` : ''} ${c.aide ? `placeholder="${esc(t(c.aide))}"` : ''}
        aria-describedby="${c.id}-err">
      <span class="ej-erreur" id="${c.id}-err" hidden></span>
    </div>`
  const avant = CHAMPS.filter(c => !['ej-taux', 'ej-capital', 'ej-rcs', 'ej-email', 'ej-tel', 'ej-siret', 'ej-tva'].includes(c.id))
  const types = ['personne_physique', 'societe'].map(ty => `
      <label class="ej-radio"><input type="radio" name="ej-type" value="${ty}"${v.type === ty ? ' checked' : ''}>
        <span>${esc(t(ty === 'societe' ? 'ej.type_societe' : 'ej.type_personne'))}</span></label>`).join('')
  const regimes = REGIMES.map(r => `<option value="${r}"${v.regime_tva === r ? ' selected' : ''}>${esc(t('ej.regime_' + r))}</option>`).join('')
  return `
  <form class="ej-form" novalidate>
    <fieldset class="ej-champ" data-champ="type">
      <legend>${esc(t('ej.f_type'))}</legend>
      <div class="ej-radios">${types}</div>
      <span class="ej-erreur" id="ej-type-err" hidden></span>
    </fieldset>
    ${avant.map(champ).join('')}
    ${CHAMPS.filter(c => ['ej-siret', 'ej-tva'].includes(c.id)).map(champ).join('')}
    <div class="ej-champ" data-champ="regime_tva">
      <label for="ej-regime">${esc(t('ej.f_regime'))} *</label>
      <select id="ej-regime" aria-describedby="ej-regime-err">${regimes}</select>
      <span class="ej-erreur" id="ej-regime-err" hidden></span>
    </div>
    ${CHAMPS.filter(c => ['ej-taux', 'ej-capital', 'ej-rcs', 'ej-email', 'ej-tel'].includes(c.id)).map(champ).join('')}
    ${exerciceHtml(v.debut_exercice, t, esc, langue)}
    ${numerotationChoixHtml(v.numerotation_factures, t, esc)}
    <p class="ej-message" role="status" aria-live="polite"></p>
    <div class="ej-actions">
      <button type="submit" class="btn btn--primary">${esc(t('ej.save'))}</button>
      <button type="button" class="btn btn--secondary" data-action="annuler">${esc(t('ej.cancel'))}</button>
    </div>
  </form>`
}

/** Montre le refus d'un champ sous le champ, sinon dans la zone de message. */
function montrerRefus (form, err, t) {
  form.querySelectorAll('.ej-erreur').forEach(s => { s.hidden = true; s.textContent = '' })
  form.querySelectorAll('[aria-invalid]').forEach(i => i.removeAttribute('aria-invalid'))
  const msg = form.querySelector('.ej-message')
  const champ = err && err.champ
  const bloc = champ ? form.querySelector(`[data-champ="${champ}"]`) : null
  const code = err && err.code
  const texte = code === 'panne' ? t('ej.err_panne')
    : code === 'archivee' ? t('ej.err_archivee')
      : code === 'suite_figee' ? t('ej.err_suite_figee')
        : champ ? t('ej.err_champ') : t('ej.err_generic')
  if (bloc) {
    const s = bloc.querySelector('.ej-erreur')
    s.textContent = texte; s.hidden = false
    const input = bloc.querySelector('input, select')
    if (input) { input.setAttribute('aria-invalid', 'true'); input.focus() }
    if (msg) msg.textContent = ''
  } else if (msg) {
    msg.textContent = texte
  }
}

function brancherFormulaire (form, { surEnvoi, surAnnuler }) {
  const majVisibles = () => {
    const type = form.querySelector('input[name="ej-type"]:checked')?.value
    const regime = form.querySelector('#ej-regime')?.value
    for (const c of CHAMPS) {
      const bloc = form.querySelector(`[data-champ="${c.api}"]`)
      if (bloc) bloc.hidden = !champVisible(c, type, regime)
    }
  }
  form.addEventListener('change', majVisibles)
  form.querySelector('[data-action="annuler"]').addEventListener('click', surAnnuler)
  form.addEventListener('submit', (ev) => { ev.preventDefault(); surEnvoi(valeursDuFormulaire(form)) })
}

// Un numéro de facture ne se coupe jamais en fin de ligne (« HS-2026- » /
// « 0012 » au téléphone, recette du 9 novembre 2026). Le texte traduit est
// échappé PUIS le numéro y est posé dans son propre élément.
const MARQUE = '\u0001'
function numeroHtml (prochain, t, esc) {
  return esc(t('ej.num_next', { numero: MARQUE })).replace(MARQUE, `<span class="ej-numero">${esc(prochain)}</span>`)
}

// Les styles de la fenêtre, posés UNE fois par le module (précédent :
// shared/temperature-calendrier.js) : la fenêtre s'ouvre depuis une page qui
// ne les charge pas, et une feuille de plus coûterait une requête.
const STYLES = `
  .ej-voile { position: fixed; inset: 0; z-index: 68; background: rgb(0 0 0 / 0.4); }
  .ej-fenetre { position: fixed; z-index: 69; inset-block-start: 50%; inset-inline-start: 50%;
    transform: translate(-50%, -50%); width: min(640px, calc(100vw - 24px)); max-height: min(92vh, 900px);
    display: flex; flex-direction: column; gap: var(--gap-m); padding: 20px; overflow: auto;
    background: var(--surface); border-radius: var(--radius-card); box-shadow: var(--shadow-hover); }
  .ej-fenetre__tete { display: flex; align-items: flex-start; gap: var(--gap-s); }
  .ej-fenetre__titre { flex: 1; min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .ej-corps { display: flex; flex-direction: column; gap: var(--gap-m); }
  .ej-actuelle { margin: 0; }
  .ej-alerte { margin: 0; color: var(--danger); }
  .ej-liste { display: flex; flex-direction: column; gap: var(--gap-m); margin: 0; padding: 0; list-style: none; }
  .ej-carte { display: flex; flex-direction: column; gap: var(--gap-s); }
  .ej-carte__tete { display: flex; align-items: center; gap: var(--gap-s); flex-wrap: wrap; }
  .ej-nom { margin: 0; overflow-wrap: anywhere; }
  .ej-carte p { margin: 0; }
  .ej-actions { display: flex; gap: var(--gap-s); flex-wrap: wrap; }
  .ej-actions .btn, .ej-ajouter { min-height: 44px; }
  .ej-ajouter { align-self: flex-start; }
  .ej-num { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-s);
    flex-wrap: wrap; padding-top: var(--gap-s); border-top: 1px solid var(--line); }
  .ej-numero { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ej-form { display: flex; flex-direction: column; gap: var(--gap-m); width: 100%; }
  .ej-champ { display: flex; flex-direction: column; gap: 6px; border: 0; padding: 0; margin: 0; min-width: 0; }
  .ej-champ label, .ej-champ legend { font-size: var(--fs-caption); font-weight: 600; color: var(--ink); padding: 0; }
  .ej-champ input, .ej-champ select { width: 100%; box-sizing: border-box; min-height: 44px; padding: 10px 12px;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
    color: var(--ink); font: inherit; font-size: var(--fs-body); }
  .ej-champ input:focus-visible, .ej-champ select:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; border-color: var(--ink); }
  .ej-champ [aria-invalid="true"] { border-color: var(--danger); }
  .ej-erreur { font-size: var(--fs-caption); color: var(--danger); }
  .ej-aide { font-size: var(--fs-caption); color: var(--muted); }
  .ej-radios { display: flex; gap: 0 var(--gap-m); flex-wrap: wrap; }
  .ej-radio { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; font-weight: 400; }
  .ej-radio input { width: 18px; height: 18px; min-height: 0; }
  .ej-duo { display: grid; gap: var(--gap-m); grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); }
  .ej-message, .ej-bandeau { margin: 0; color: var(--danger); }
  .ej-message:empty, .ej-bandeau:empty { display: none; }
  @media (max-width: 560px) {
    .ej-actions { flex-direction: column; align-items: stretch; }
    .ej-actions .btn, .ej-ajouter { width: 100%; }
  }
`
function injecterStyles (doc) {
  if (!doc || doc.getElementById('ej-styles')) return
  const s = doc.createElement('style')
  s.id = 'ej-styles'
  s.textContent = STYLES
  doc.head.appendChild(s)
}

/**
 * Monte le contenu de la fenêtre dans `racine`.
 * @param {object} o
 * @param {Element} o.racine
 * @param {{ lire: Function, ecrire: Function }} o.api  le client partagé (`lire(bien)`, `ecrire(corps)`)
 * @param {string}   o.bien   l'UUID du logement de la fiche
 * @param {Function} o.t      I18n.t
 * @param {Function} o.esc    échappement HTML
 * @param {Function} [o.surChangement]  appelée avec l'état relu après chaque geste réussi
 * @returns {Promise<void>}   résolue une fois le premier état peint
 */
function monterFenetre ({ racine, api, bien, t, esc, langue = 'fr', surChangement = null }) {
  let etat = null           // la dernière réponse du GET
  let mode = null           // null | { edition: id|null } | { numerotation: id }

  async function charger () {
    try {
      etat = await api.lire(bien)
    } catch (e) {
      etat = null
      racine.innerHTML = `<p class="ej-alerte" role="alert">${esc(e && e.status === 403 ? t('ej.no_access') : t('ej.err_panne'))}</p>`
      return false
    }
    peindre()
    return true
  }

  async function geste (corps, form) {
    try {
      await api.ecrire({ ...corps, property_uuid: bien })
    } catch (e) {
      if (form) { montrerRefus(form, e, t); return false }
      // ⚠ SANS FORMULAIRE (un bouton) : on repeint depuis le dernier état lu,
      // et le bandeau dit pourquoi.
      peindre()
      const b = racine.querySelector('.ej-bandeau')
      if (b) b.textContent = t(e && e.code === 'archivee' ? 'ej.err_archivee' : e && e.code === 'panne' ? 'ej.err_panne' : 'ej.err_generic')
      return false
    }
    mode = null
    if (await charger() && typeof surChangement === 'function') {
      try { surChangement(etat) } catch (e) { /* la fiche se débrouille */ }
    }
    return true
  }

  function carte (e) {
    const actuelle = etat.bien.entite_id === e.id
    if (mode && mode.edition === e.id) {
      return `<li class="card ej-carte" data-entite="${esc(e.id)}">${formulaireHtml(e, t, esc, langue)}</li>`
    }
    const titulaire = etat.titulaire === true
    const num = etat.numerotations[e.id]
    let numero = ''
    if (e.numerotation_factures === 'manuel') {
      numero = `<div class="ej-num"><p class="small">${esc(t('ej.num_manual_info'))}</p></div>`
    } else if (num && mode && mode.numerotation === e.id) {
      numero = `<div class="ej-num">${numerotationHtml(num)}</div>`
    } else if (num) {
      numero = `<div class="ej-num"><p class="small">${numeroHtml(num.prochain, t, esc)}</p>${
        num.fige ? `<p class="small muted">${esc(t('ej.num_fige'))}</p>`
          : titulaire ? `<button type="button" class="btn btn--secondary" data-action="numerotation">${esc(t('ej.num_edit'))}</button>` : ''}</div>`
    }
    const actions = titulaire ? `
      <div class="ej-actions">
        ${actuelle
          ? `<button type="button" class="btn btn--secondary" data-action="retirer">${esc(t('ej.retirer'))}</button>`
          : `<button type="button" class="btn btn--primary" data-action="choisir">${esc(t('ej.choisir'))}</button>`}
        <button type="button" class="btn btn--secondary" data-action="modifier">${esc(t('ej.edit'))}</button>
      </div>` : ''
    return `
    <li class="card ej-carte" data-entite="${esc(e.id)}">
      <div class="ej-carte__tete"><h3 class="h3 ej-nom">${esc(e.nom)}</h3>${actuelle ? `<span class="badge">${esc(t('ej.badge_actuelle'))}</span>` : ''}</div>
      <p class="muted small">${resume(e, t, esc).join('<br>')}</p>
      ${numero}
      ${actions}
    </li>`
  }

  function numerotationHtml (s) {
    return `
    <form class="ej-form ej-form--num" novalidate>
      <p class="small muted">${esc(t('ej.num_help'))}</p>
      <div class="ej-duo">
        <div class="ej-champ" data-champ="prefixe">
          <label for="ej-prefixe">${esc(t('ej.num_prefix'))}</label>
          <input id="ej-prefixe" maxlength="12" value="${esc(s.prefixe)}" aria-describedby="ej-prefixe-err">
          <span class="ej-erreur" id="ej-prefixe-err" hidden></span>
        </div>
        <div class="ej-champ" data-champ="prochain_numero">
          <label for="ej-prochain">${esc(t('ej.num_start'))}</label>
          <input id="ej-prochain" inputmode="numeric" maxlength="6" value="${esc(String(s.prochain_numero))}" aria-describedby="ej-prochain-err">
          <span class="ej-erreur" id="ej-prochain-err" hidden></span>
        </div>
      </div>
      <p class="ej-message" role="status" aria-live="polite"></p>
      <div class="ej-actions">
        <button type="submit" class="btn btn--primary">${esc(t('ej.save'))}</button>
        <button type="button" class="btn btn--secondary" data-action="annuler">${esc(t('ej.cancel'))}</button>
      </div>
    </form>`
  }

  function peindre () {
    const actives = etat.entites.filter(e => !e.archivee_le)
    const sienne = etat.entites.find(e => e.id === etat.bien.entite_id) || null
    // L'entité de CE logement, ou son absence — en tête, parce que c'est ce
    // que l'hôte vient vérifier. Une archivée ne facture plus (P4).
    const actuelle = !sienne
      ? `<p class="ej-alerte">${esc(t('ej.aucune'))}</p>`
      : sienne.archivee_le
        ? `<p class="ej-alerte">${esc(t('ej.actuelle_archivee', { nom: sienne.nom }))}</p>`
        : `<p class="ej-actuelle">${esc(t('ej.actuelle', { nom: sienne.nom }))}</p>`
    const creation = mode && mode.edition === null
      ? `<li class="card ej-carte" data-entite="">${formulaireHtml(null, t, esc, langue)}</li>` : ''
    const vide = !actives.length && !creation ? `<p class="muted">${esc(t('ej.empty_text'))}</p>` : ''
    const ajouter = etat.titulaire === true && !mode
      ? `<button type="button" class="btn btn--secondary ej-ajouter" data-action="ajouter">${esc(t('ej.add'))}</button>` : ''
    racine.innerHTML = `
      <p class="ej-bandeau" role="alert"></p>
      ${actuelle}
      ${vide}
      <ul class="ej-liste">${actives.map(carte).join('')}${creation}</ul>
      ${ajouter}`
    brancher()
  }

  function brancher () {
    racine.querySelector('[data-action="ajouter"]')?.addEventListener('click', () => { mode = { edition: null }; peindre() })
    racine.querySelectorAll('.ej-carte').forEach(c => {
      const id = c.dataset.entite || null
      const form = c.querySelector('form.ej-form')
      if (form && !form.classList.contains('ej-form--num')) {
        brancherFormulaire(form, {
          surAnnuler: () => { mode = null; peindre() },
          surEnvoi: (entite) => geste(id ? { action: 'modifier', id, entite } : { action: 'creer', entite }, form)
        })
      }
      if (form && form.classList.contains('ej-form--num')) {
        form.querySelector('[data-action="annuler"]').addEventListener('click', () => { mode = null; peindre() })
        form.addEventListener('submit', (ev) => {
          ev.preventDefault()
          geste({ action: 'numerotation', id, numerotation: {
            prefixe: form.querySelector('#ej-prefixe').value.trim(),
            prochain_numero: Number(form.querySelector('#ej-prochain').value.trim())
          } }, form)
        })
      }
      c.querySelector('[data-action="choisir"]')?.addEventListener('click', () => geste({ action: 'rattacher', entite_id: id }))
      c.querySelector('[data-action="retirer"]')?.addEventListener('click', () => geste({ action: 'rattacher', entite_id: null }))
      c.querySelector('[data-action="modifier"]')?.addEventListener('click', () => { mode = { edition: id }; peindre() })
      c.querySelector('[data-action="numerotation"]')?.addEventListener('click', () => { mode = { numerotation: id }; peindre() })
    })
  }

  return charger().then(() => undefined)
}

/**
 * Ouvre la fenêtre par-dessus la page (voile + boîte, Échap et la croix
 * ferment, la tabulation reste dedans, le focus revient d'où il venait).
 * @returns {{ fermer: Function, pret: Promise<void> }}
 */
function ouvrirFenetre ({ doc, api, bien, t, esc, langue = 'fr', surChangement = null, surFermeture = null }) {
  const d = doc || document
  injecterStyles(d)
  const avant = d.activeElement
  const voile = d.createElement('div')
  voile.className = 'ej-voile'
  const boite = d.createElement('div')
  boite.className = 'ej-fenetre'
  boite.setAttribute('role', 'dialog')
  boite.setAttribute('aria-modal', 'true')
  boite.setAttribute('aria-labelledby', 'ej-fenetre-titre')
  boite.innerHTML = `
    <div class="ej-fenetre__tete">
      <h2 class="h2 ej-fenetre__titre" id="ej-fenetre-titre">${esc(t('ej.fenetre_titre'))}</h2>
      <button type="button" class="btn btn--secondary btn--icon" data-action="fermer" aria-label="${esc(t('ej.fermer'))}">×</button>
    </div>
    <div class="ej-corps"><p class="muted small">${esc(t('common.loading'))}</p></div>`
  let ferme = false
  const fermer = () => {
    if (ferme) return
    ferme = true
    d.removeEventListener('keydown', surTouche, true)
    voile.remove(); boite.remove()
    try { if (avant && typeof avant.focus === 'function') avant.focus() } catch (e) {}
    if (typeof surFermeture === 'function') { try { surFermeture() } catch (e) {} }
  }
  // ⚠ `aria-modal` SANS PIÈGE DE FOCUS EST UN MENSONGE (constat mesuré sur
  // shared/confirmer.js) : la tabulation reste dans la fenêtre.
  const focusables = () => [...boite.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')]
    .filter(el => !el.closest('[hidden]'))
  function surTouche (e) {
    if (e.key === 'Escape') { e.preventDefault(); fermer(); return }
    if (e.key !== 'Tab') return
    const liste = focusables()
    if (!liste.length) return
    const premier = liste[0]
    const dernier = liste[liste.length - 1]
    const actif = d.activeElement
    if (!boite.contains(actif)) { e.preventDefault(); premier.focus(); return }
    if (e.shiftKey && actif === premier) { e.preventDefault(); dernier.focus(); return }
    if (!e.shiftKey && actif === dernier) { e.preventDefault(); premier.focus() }
  }
  boite.querySelector('[data-action="fermer"]').addEventListener('click', fermer)
  voile.addEventListener('click', fermer)
  d.addEventListener('keydown', surTouche, true)
  d.body.appendChild(voile)
  d.body.appendChild(boite)
  try { boite.querySelector('[data-action="fermer"]').focus() } catch (e) {}
  const pret = monterFenetre({ racine: boite.querySelector('.ej-corps'), api, bien, t, esc, langue, surChangement })
  return { fermer, pret }
}

export {
  CHAMPS, REGIMES, NUMEROTATIONS, champVisible, valeursDuFormulaire, resume, formulaireHtml, exerciceHtml,
  numerotationChoixHtml, montrerRefus, numeroHtml, monterFenetre, ouvrirFenetre
}
