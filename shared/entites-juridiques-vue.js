// shared/entites-juridiques-vue.js — l'écran « Entités juridiques » (Réglages).
// Spec : docs/specs/spec-facture-voyageur.md §5.1 · KB : docs/kb/entites-juridiques.md
//
// Un seul endpoint (`/api/entites-juridiques`) : GET peint tout l'écran, POST
// porte un geste à la fois. L'écran est RÉSERVÉ AU TITULAIRE (la page appelle
// `exigerCompteProprePage`) et le serveur le garantit : écriture `facturation`,
// non délégable.
//
// Trois parties : les entités actives (une carte chacune, avec sa
// numérotation), « Vos logements » (l'entité de chaque logement — décision de
// Thierry du 8 novembre 2026 : le choix vit ICI, pas sur la fiche du logement),
// et les entités archivées.
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
      : code === 'prefixe_fige' ? t('ej.err_prefixe_fige')
        : code === 'numero_trop_bas' ? t('ej.err_numero_trop_bas')
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

/**
 * Monte l'écran.
 * @param {object} o
 * @param {Element} o.racine
 * @param {{ lire: Function, ecrire: Function }} o.api  le client partagé (jeton, X-Compte)
 * @param {Function} o.t     I18n.t
 * @param {Function} o.esc   échappement HTML
 * @param {Function} o.confirmer  (titre, texte) → Promise<boolean>
 */
function monterEntites ({ racine, api, t, esc, confirmer, langue = 'fr' }) {
  let etat = null           // la dernière réponse du GET
  let edition = null        // { id|null } : la carte en cours d'édition, ou la création

  async function charger () {
    try {
      etat = await api.lire()
    } catch (e) {
      racine.innerHTML = `<p class="ej-vide">${esc(e && e.status === 403 ? t('ej.no_access') : t('ej.err_panne'))}</p>`
      return
    }
    peindre()
  }

  async function geste (corps, form) {
    try {
      await api.ecrire(corps)
      edition = null
      await charger()
      return true
    } catch (e) {
      if (form) montrerRefus(form, e, t)
      else racine.querySelector('.ej-bandeau').textContent = t('ej.err_generic')
      return false
    }
  }

  function carte (e) {
    const num = etat.numerotations[e.id]
    if (edition && edition.id === e.id) {
      return `<article class="card ej-carte" data-entite="${esc(e.id)}">${formulaireHtml(e, t, esc, langue)}</article>`
    }
    const badges = e.par_defaut ? `<span class="badge">${esc(t('ej.default_badge'))}</span>` : ''
    const numero = num ? `
      <div class="ej-num" data-num="${esc(e.id)}">
        <p class="small">${esc(t('ej.num_next', { numero: num.prochain }))}</p>
        <button type="button" class="btn btn--secondary" data-action="numerotation">${esc(t('ej.num_edit'))}</button>
      </div>` : ''
    return `
    <article class="card ej-carte" data-entite="${esc(e.id)}">
      <div class="ej-carte__tete"><h2 class="h2 ej-nom">${esc(e.nom)}</h2>${badges}</div>
      <p class="muted small">${resume(e, t, esc).join('<br>')}</p>
      ${numero}
      <div class="ej-actions">
        <button type="button" class="btn btn--secondary" data-action="modifier">${esc(t('ej.edit'))}</button>
        ${e.par_defaut ? '' : `<button type="button" class="btn btn--secondary" data-action="defaut">${esc(t('ej.make_default'))}</button>`}
        <button type="button" class="btn btn--secondary" data-action="archiver">${esc(t('ej.archive'))}</button>
      </div>
    </article>`
  }

  function numerotationHtml (e) {
    const s = etat.numerotations[e.id]
    return `
    <form class="ej-form ej-form--num" novalidate>
      <p class="small muted">${esc(t('ej.num_help'))}</p>
      ${s.prefixe_fige ? `<p class="small">${esc(t('ej.num_locked'))}</p>` : ''}
      <div class="ej-duo">
        <div class="ej-champ" data-champ="prefixe">
          <label for="ej-prefixe">${esc(t('ej.num_prefix'))}</label>
          <input id="ej-prefixe" maxlength="12" value="${esc(s.prefixe)}"${s.prefixe_fige ? ' readonly' : ''} aria-describedby="ej-prefixe-err">
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
    const archivees = etat.entites.filter(e => e.archivee_le)
    const defaut = actives.find(e => e.par_defaut)
    const creation = edition && edition.id === null
      ? `<article class="card ej-carte" data-entite="">${formulaireHtml(null, t, esc, langue)}</article>` : ''
    const vide = !actives.length && !creation ? `
      <div class="card ej-vide">
        <h2 class="h2">${esc(t('ej.empty_title'))}</h2>
        <p class="muted">${esc(t('ej.empty_text'))}</p>
      </div>` : ''
    const options = (sel) => [`<option value=""${sel ? '' : ' selected'}>${esc(defaut ? t('ej.bien_defaut', { nom: defaut.nom }) : t('ej.bien_defaut_aucune'))}</option>`]
      .concat(actives.map(e => `<option value="${esc(e.id)}"${sel === e.id ? ' selected' : ''}>${esc(e.nom)}</option>`)).join('')
    const biens = etat.biens.length ? etat.biens.map(b => `
      <div class="ej-bien">
        <label for="ej-bien-${esc(b.id)}" class="ej-bien__nom">${esc(b.nom)}</label>
        <select id="ej-bien-${esc(b.id)}" data-bien="${esc(b.id)}">${options(b.entite_id)}</select>
      </div>`).join('') : `<p class="muted">${esc(t('ej.biens_vide'))}</p>`
    const archive = archivees.length ? `
      <details class="ej-archivees">
        <summary>${esc(t('ej.archived_section'))} (${archivees.length})</summary>
        ${archivees.map(e => `<div class="ej-archivee"><strong>${esc(e.nom)}</strong> <span class="badge">${esc(t('ej.archived_badge'))}</span>
          <p class="muted small">${resume(e, t, esc).join('<br>')}</p></div>`).join('')}
      </details>` : ''
    racine.innerHTML = `
      <p class="ej-bandeau" role="alert"></p>
      ${vide}
      <div class="ej-liste">${actives.map(carte).join('')}${creation}</div>
      ${edition ? '' : `<button type="button" class="btn btn--primary ej-ajouter" data-action="ajouter">${esc(t('ej.add'))}</button>`}
      <section class="card ej-biens">
        <h2 class="h2">${esc(t('ej.biens_title'))}</h2>
        <p class="muted small">${esc(t('ej.biens_help'))}</p>
        ${biens}
      </section>
      ${archive}`
    brancher()
  }

  function brancher () {
    racine.querySelector('[data-action="ajouter"]')?.addEventListener('click', () => { edition = { id: null }; peindre() })
    racine.querySelectorAll('.ej-carte').forEach(c => {
      const id = c.dataset.entite || null
      const form = c.querySelector('.ej-form')
      if (form && !form.classList.contains('ej-form--num')) {
        brancherFormulaire(form, {
          surAnnuler: () => { edition = null; peindre() },
          surEnvoi: (entite) => geste(id ? { action: 'modifier', id, entite } : { action: 'creer', entite }, form)
        })
      }
      c.querySelector('[data-action="modifier"]')?.addEventListener('click', () => { edition = { id }; peindre() })
      c.querySelector('[data-action="defaut"]')?.addEventListener('click', () => geste({ action: 'defaut', id }))
      c.querySelector('[data-action="archiver"]')?.addEventListener('click', async () => {
        if (await confirmer(t('ej.archive_confirm_title'), t('ej.archive_confirm_text'))) geste({ action: 'archiver', id })
      })
      c.querySelector('[data-action="numerotation"]')?.addEventListener('click', () => {
        const zone = c.querySelector('.ej-num')
        const e = etat.entites.find(x => x.id === id)
        zone.innerHTML = numerotationHtml(e)
        const f = zone.querySelector('form')
        f.querySelector('[data-action="annuler"]').addEventListener('click', () => peindre())
        f.addEventListener('submit', (ev) => {
          ev.preventDefault()
          geste({ action: 'numerotation', id, numerotation: {
            prefixe: f.querySelector('#ej-prefixe').value.trim(),
            prochain_numero: Number(f.querySelector('#ej-prochain').value.trim())
          } }, f)
        })
      })
    })
    racine.querySelectorAll('select[data-bien]').forEach(s => {
      s.addEventListener('change', () => geste({ action: 'rattacher', property_uuid: s.dataset.bien, entite_id: s.value || null }))
    })
  }

  return charger()
}

export { CHAMPS, REGIMES, champVisible, valeursDuFormulaire, resume, formulaireHtml, exerciceHtml, montrerRefus, monterEntites }
