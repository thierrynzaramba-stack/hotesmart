// core/avis/ecran-reglages.js
// DOC : docs/specs/spec-evaluation-voyageur.md §4.7 (modif = MEME COMMIT)
//
// L'ONGLET « AVIS » DE /settings : la grille d'evaluation, les mots-cles, le ton
// et la signature.
//
// ⚠ CET ECRAN N'EST PAS LE JUGE. Les deux regles que l'hote ne peut pas defaire
// — une note 1 est negative, un refus de recommander est negatif — sont tenues
// par la BASE (contraintes CHECK) et verifiees par le serveur avant ecriture.
// Ce que l'ecran fait, c'est les rendre EVIDENTES : la case « negatif » d'une
// note 1 est cochee et desactivee, avec la raison ecrite a cote. Un hote ne doit
// pas decouvrir la regle par un message d'erreur.
//
// ⚠ ET IL NE PRE-INSERE RIEN. La grille par defaut est une constante du code
// (decision du 30 septembre 2026 : pas de seed sur 30 000 comptes). L'ecran la
// montre comme point de depart ; rien n'est ecrit tant que l'hote n'enregistre
// pas.

import { appel as appelParDefaut } from './appel.js'

const CATEGORIE_LISIBLE = {
  cleanliness: 'Propreté',
  communication: 'Communication',
  respect_house_rules: 'Respect du règlement',
  recommandation: 'Recommandation',
}
const REMPLI_LISIBLE = { prestataire: 'La prestataire', hote: 'L’hôte', les_deux: 'Les deux' }

const echapper = (t) => String(t == null ? '' : t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// Une note 1 est toujours negative, un refus de recommander aussi (spec §4.2).
export function negatifForce (niveau, categorie) {
  if (categorie === 'recommandation') return niveau.recommande === false
  return Number(niveau.note) === 1
}

/**
 * Monte l'ecran dans un conteneur.
 * @returns {Promise<{ charge: boolean }>}
 */
// ─── La mise en page, embarquee (comme la fenetre d'evaluation) ─────────────
// L'ecran vit desormais dans l'app Avis (decision de Thierry du 2 octobre 2026
// au soir) : ses styles voyagent avec lui, au lieu de rester dans /settings.
const STYLE_ID = 'hs-avis-reglages-style'
const STYLE = `
.hs-avis-reglages .card-title { font-size: 15px; font-weight: 500; margin-bottom: 4px; }
.hs-avis-reglages .card-sub { font-size: 12.5px; color: var(--text2, #6b6b6b); margin-bottom: 14px; line-height: 1.5; }
.hs-avis-reglages .hs-critere { margin-bottom: 12px; }
.hs-avis-reglages .hs-critere-entete { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.hs-avis-reglages .hs-critere-entete input[type=text] { flex: 1 1 240px; min-width: 0; }
.hs-avis-reglages .hs-niveaux { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.hs-avis-reglages .hs-niveau { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.hs-avis-reglages .hs-niveau input[type=text] { flex: 1 1 180px; min-width: 0; }
.hs-avis-reglages .hs-niveau-negatif { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text2, #6b6b6b); }
.hs-avis-reglages .hs-niveau-force { font-size: 11px; color: var(--text2, #6b6b6b); }
.hs-avis-reglages .hs-reglage { display: block; margin-bottom: 10px; font-size: 13px; }
.hs-avis-reglages .hs-reglage span { display: block; margin-bottom: 4px; color: var(--text2, #6b6b6b); }
.hs-avis-reglages .hs-reglage input, .hs-avis-reglages .hs-reglage select { width: 100%; box-sizing: border-box; }
.hs-avis-reglages input[type=text], .hs-avis-reglages input[type=number], .hs-avis-reglages select { font: inherit; font-size: 13.5px; padding: 6px 8px; border: 1px solid #d9d4ce; border-radius: 8px; background: var(--bg, #fff); color: inherit; }
.hs-avis-reglages .hs-avis-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.hs-avis-reglages .hs-avis-actions button, .hs-avis-reglages .hs-critere button { font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 8px; border: 1px solid #d9d4ce; background: var(--bg, #fff); color: inherit; cursor: pointer; }
.hs-avis-reglages .hs-avis-principal { background: #C97B5C !important; border-color: #C97B5C !important; color: #fff !important; font-weight: 600; }
.hs-avis-reglages .hs-avis-erreur { color: #b3261e; font-size: 13px; }
.hs-avis-reglages .hs-avis-message { color: #1b5e20; font-size: 13px; }
.hs-avis-reglages .hs-auto-bien { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 9px 0; border-top: 0.5px solid #e6e2dd; }
.hs-avis-reglages .hs-auto-bien:first-of-type { border-top: 0; }
.hs-avis-reglages .hs-auto-nom { flex: 1 1 200px; display: flex; align-items: center; gap: 8px; font-size: 14px; }
.hs-avis-reglages .hs-auto-delai { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.hs-avis-reglages .hs-auto-delai input { width: 80px; }
.hs-avis-reglages .hs-auto-message { flex: 1 1 100%; font-size: 12px; }
@media (max-width: 560px) {
  .hs-avis-reglages .hs-niveau, .hs-avis-reglages .hs-critere-entete { flex-direction: column; align-items: stretch; }
  .hs-avis-reglages .hs-niveau input[type=text], .hs-avis-reglages .hs-critere-entete input[type=text] { flex: 1 1 auto; }
}
`
export function poserStyle (doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return
  const s = doc.createElement('style')
  s.id = STYLE_ID
  s.textContent = STYLE
  doc.head.appendChild(s)
}

export async function monter (conteneur, options = {}) {
  const appel = options.appel || appelParDefaut
  const avertir = options.avertir || (() => {})
  if (!conteneur) throw new Error('[avis] l ecran de reglages exige un conteneur')
  poserStyle(conteneur.ownerDocument)

  const etat = { criteres: [], config: null, tons: ['chaleureux', 'sobre'], defaut: [], occupe: false, message: null, erreur: null }

  conteneur.innerHTML = '<p class="hs-avis-attente">Chargement des réglages…</p>'
  try {
    const [grille, config, auto] = await Promise.all([
      appel('avis?action=grille'), appel('avis?action=config'),
      // La publication automatique, bien par bien : une panne ne prive pas
      // l'hote de sa grille, le bloc dira qu'il est illisible.
      appel('avis?action=auto-validation').catch(err => ({ erreur: err.message || 'Réglages illisibles' })),
    ])
    etat.defaut = grille.defaut || []
    etat.config = config.compte || { keywords: [], tone: 'chaleureux', signature: '' }
    etat.tons = config.tons || etat.tons
    etat.autoBornes = (auto && auto.bornes) || { min: 1, max: 336 }
    etat.autoBiens = (auto && auto.biens) || []
    etat.autoErreur = (auto && auto.erreur) || null
    etat.autoMessages = {}
    // ⚠ SANS CRITERE EN BASE, ON PART DE LA GRILLE PAR DEFAUT — affichee, pas
    // enregistree. L'hote voit ce qui s'applique aujourd'hui, et peut le
    // modifier ; s'il n'enregistre pas, rien ne change.
    etat.criteres = (grille.compte || []).length
      ? (grille.compte || []).map(depuisServeur)
      : (grille.defaut || []).map(depuisDefaut)
    etat.surDefaut = !(grille.compte || []).length
    // Des criteres en base mais AUCUN actif : une activation a echoue, et la
    // grille du compte est vide — donc aucune evaluation ne peut se remplir.
    etat.inactifs = (grille.compte || []).length > 0 && !(grille.compte || []).some(c => c.actif !== false)
    // ⚠ ET ON DIT SI UN BIEN A SA PROPRE GRILLE. Cet ecran ne regle que le
    // niveau COMPTE ; une grille de bien le surcharge et rendrait la phrase
    // « sur tous vos biens » fausse.
    etat.biensAvecGrille = grille.biens_avec_grille || 0
  } catch (err) {
    conteneur.innerHTML = `<p class="hs-avis-erreur">${echapper(err.message || 'Réglages illisibles')}</p>`
    return { charge: false }
  }

  const afficher = () => { conteneur.innerHTML = rendre(etat); brancher() }

  function brancher () {
    // Les champs de la configuration.
    const lier = (nom, fn) => {
      const el = conteneur.querySelector(`[data-reglage="${nom}"]`)
      if (el) el.addEventListener('input', () => fn(el.value))
    }
    lier('mots', (v) => { etat.config.keywords = v.split(',').map(x => x.trim()).filter(Boolean) })
    lier('signature', (v) => { etat.config.signature = v })
    const ton = conteneur.querySelector('[data-reglage="ton"]')
    if (ton) ton.addEventListener('change', () => { etat.config.tone = ton.value })

    // La publication automatique, BIEN PAR BIEN (§10 bis, option A) : chaque
    // ligne s'enregistre seule, au geste — la case l'active ou la coupe, le
    // delai part quand on quitte le champ.
    conteneur.querySelectorAll('[data-auto-case]').forEach(el => el.addEventListener('change', () => {
      const id = el.dataset.autoCase
      const b = etat.autoBiens.find(x => x.property_id === id)
      ecrireAuto(id, el.checked ? ((b && b.heuresSaisies) || (b && b.heures) || 48) : null)
    }))
    conteneur.querySelectorAll('[data-auto-heures]').forEach(el => el.addEventListener('change', () => {
      const id = el.dataset.autoHeures
      const b = etat.autoBiens.find(x => x.property_id === id)
      if (b) b.heuresSaisies = el.value === '' ? null : Number(el.value)
      ecrireAuto(id, el.value === '' ? '' : Number(el.value))
    }))

    // Les critères.
    conteneur.querySelectorAll('[data-critere]').forEach(el => {
      const i = Number(el.dataset.critere)
      const champ = el.dataset.champ
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
        etat.criteres[i][champ] = el.value
        // ⚠ CHANGER LA CATEGORIE CHANGE CE QU'UN NIVEAU PEUT PORTER : une
        // categorie notee exige une note et interdit « recommande », et
        // l'inverse pour « recommandation ». On redessine, sinon l'ecran
        // proposerait des champs que la base refusera.
        if (champ === 'categorie') { etat.criteres[i].niveaux = etat.criteres[i].niveaux.map(n => vidangerNiveau(n, el.value)); afficher() }
      })
    })
    conteneur.querySelectorAll('[data-niveau]').forEach(el => {
      const [i, j] = el.dataset.niveau.split(':').map(Number)
      const champ = el.dataset.champ
      const evenement = el.type === 'checkbox' ? 'change' : (el.tagName === 'SELECT' ? 'change' : 'input')
      el.addEventListener(evenement, () => {
        const n = etat.criteres[i].niveaux[j]
        if (champ === 'negatif') n.negatif = el.checked
        else if (champ === 'note') { n.note = el.value === '' ? null : Number(el.value); afficher() }
        else if (champ === 'recommande') { n.recommande = el.value === '' ? null : el.value === 'oui'; afficher() }
        else n[champ] = el.value
      })
    })

    const bouton = (nom, fn) => conteneur.querySelectorAll(`[data-action="${nom}"]`).forEach(b => b.addEventListener('click', fn))
    bouton('ajouter-critere', () => {
      etat.criteres.push({ libelle: '', categorie: 'cleanliness', rempli_par: 'hote', rang: etat.criteres.length + 1,
        niveaux: [{ cle: 'bon', libelle: 'Bon', rang: 1, note: 5, negatif: false }] })
      afficher()
    })
    conteneur.querySelectorAll('[data-action="retirer-critere"]').forEach(b => b.addEventListener('click', () => {
      etat.criteres.splice(Number(b.dataset.index), 1); afficher()
    }))
    conteneur.querySelectorAll('[data-action="ajouter-niveau"]').forEach(b => b.addEventListener('click', () => {
      const c = etat.criteres[Number(b.dataset.index)]
      const n = c.niveaux.length + 1
      c.niveaux.push(vidangerNiveau({ cle: `niveau-${n}`, libelle: '', rang: n, note: 3, negatif: false }, c.categorie))
      afficher()
    }))
    conteneur.querySelectorAll('[data-action="retirer-niveau"]').forEach(b => b.addEventListener('click', () => {
      const [i, j] = b.dataset.index.split(':').map(Number)
      etat.criteres[i].niveaux.splice(j, 1); afficher()
    }))
    bouton('revenir-defaut', () => {
      etat.criteres = (etat.defaut || []).map(depuisDefaut); etat.surDefaut = true; etat.message = null; afficher()
    })
    bouton('enregistrer', enregistrer)
  }

  // Le reglage d'UN bien. Le delai se verifie avant l'envoi ; l'ecran ne garde
  // jamais une valeur que le serveur n'a pas prise.
  async function ecrireAuto (id, heures) {
    const b = etat.autoBornes || { min: 1, max: 336 }
    const bien = etat.autoBiens.find(x => x.property_id === id)
    if (!bien) return
    if (heures !== null && !(Number.isInteger(heures) && heures >= b.min && heures <= b.max)) {
      etat.autoMessages[id] = { texte: `Un nombre entier d’heures entre ${b.min} et ${b.max}.`, ton: 'erreur' }
      afficher(); return
    }
    try {
      const r = await appel('avis?action=auto-validation-maj', {
        methode: 'POST', corps: { action: 'auto-validation-maj', property_id: id, heures },
      })
      bien.heures = r.heures
      etat.autoMessages[id] = { texte: r.heures ? `Activée : publication ${r.heures} h après la part de la prestataire.` : 'Désactivée.', ton: 'ok' }
    } catch (err) {
      etat.autoMessages[id] = { texte: err.message || 'Réglage non enregistré.', ton: 'erreur' }
    }
    afficher()
  }

  async function enregistrer () {
    if (etat.occupe) return
    etat.occupe = true; etat.erreur = null; etat.message = null; afficher()
    try {
      // ⚠ LES CLES DE NIVEAUX SE DERIVENT DU LIBELLE, et restent uniques par
      // critere. Un doublon ferait refuser la grille par le serveur, avec un
      // message que l'hote ne pourrait pas relier a ce qu'il a tape.
      const criteres = etat.criteres.map((c, i) => ({
        libelle: c.libelle, categorie: c.categorie, rempli_par: c.rempli_par, rang: i + 1,
        niveaux: c.niveaux.map((n, j) => ({
          cle: cleDe(n, j, c.niveaux),
          libelle: n.libelle, rang: j + 1,
          note: c.categorie === 'recommandation' ? null : (n.note == null ? null : Number(n.note)),
          ...(c.categorie === 'recommandation' ? { recommande: n.recommande === true } : {}),
          // La regle forcee est appliquee ICI aussi, pour que l'hote ne puisse
          // pas envoyer une grille que la base refusera.
          negatif: negatifForce(n, c.categorie) ? true : Boolean(n.negatif),
        })),
      }))
      await appel('avis?action=grille-maj', { methode: 'POST', corps: { action: 'grille-maj', criteres } })
      await appel('avis?action=config-maj', {
        methode: 'POST',
        corps: {
          action: 'config-maj',
          keywords: etat.config.keywords || [],
          tone: etat.config.tone || 'chaleureux',
          signature: etat.config.signature || null,
        },
      })
      etat.surDefaut = false
      etat.message = 'Réglages enregistrés.'
      avertir('Réglages des avis enregistrés.', 'ok')
    } catch (err) {
      etat.erreur = err.message || 'Enregistrement impossible'
      avertir(etat.erreur, 'err')
    } finally {
      etat.occupe = false; afficher()
    }
  }

  afficher()
  return { charge: true, surDefaut: etat.surDefaut }
}

// ─── Conversions ────────────────────────────────────────────────────────────
// ⚠ `actif` SE GARDE. Constat de review : il etait jete, donc un hote dont
// l'activation avait echoue revoyait sa grille comme si elle s'appliquait. La
// promesse « c'est visible et reparable » n'etait tenue que sur « reparable ».
const depuisServeur = (c) => ({
  libelle: c.libelle, categorie: c.categorie, rempli_par: c.rempli_par, rang: c.rang, actif: c.actif,
  niveaux: (c.niveaux || []).map(n => ({ cle: n.cle, libelle: n.libelle, rang: n.rang, note: n.note, recommande: n.recommande, negatif: n.negatif })),
})
const depuisDefaut = (c) => ({
  libelle: c.libelle, categorie: c.categorie, rempli_par: c.rempli_par, rang: c.rang,
  niveaux: (c.niveaux || []).map(n => ({ cle: n.cle, libelle: n.libelle, rang: n.rang, note: n.note, recommande: n.recommande, negatif: n.negatif })),
})

// Un niveau qui change de categorie perd ce qui n'y a plus de sens.
export function vidangerNiveau (n, categorie) {
  if (categorie === 'recommandation') {
    // ⚠ LE DRAPEAU SE DEDUIT DE LA VALEUR RETENUE, pas de celle d'avant.
    // Premiere version : `recommande` devenait `false` (parce que la valeur
    // d'origine etait `undefined`) tandis que `negatif` restait a `false` —
    // c'est-a-dire un refus de recommander SANS son drapeau, exactement ce que
    // la contrainte `avis_niveaux_refus_est_negatif` refuse. L'hote aurait
    // decouvert la regle par un message Postgres.
    const recommande = n.recommande === true
    return { cle: n.cle, libelle: n.libelle, rang: n.rang, note: null, recommande, negatif: recommande ? Boolean(n.negatif) : true }
  }
  const note = n.note == null ? 3 : Number(n.note)
  return { cle: n.cle, libelle: n.libelle, rang: n.rang, note, negatif: note === 1 ? true : Boolean(n.negatif) }
}

// Une cle lisible, derivee du libelle, unique dans son critere.
export function cleDe (niveau, index, freres) {
  const base = String(niveau.libelle || niveau.cle || `niveau-${index + 1}`)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `niveau-${index + 1}`
  const avant = (freres || []).slice(0, index)
    .filter(f => String(f.libelle || f.cle || '').toLowerCase() === String(niveau.libelle || niveau.cle || '').toLowerCase()).length
  return avant ? `${base}-${avant + 1}` : base
}

// ─── Rendu ──────────────────────────────────────────────────────────────────
export function rendre (etat) {
  const config = etat.config || {}
  const tons = (etat.tons || []).map(t =>
    `<option value="${echapper(t)}"${config.tone === t ? ' selected' : ''}>${t === 'sobre' ? 'Sobre et factuel' : 'Chaleureux'}</option>`).join('')

  const bloquesConfig = `<div class="card"><div class="card-title">Comment l’IA écrit vos avis</div>`
    + `<div class="card-sub">Ces réglages orientent la rédaction. Ils ne changent jamais les notes, qui viennent de vos boutons.</div>`
    + `<label class="hs-reglage"><span>Mots que vous aimez employer (séparés par des virgules)</span>`
    + `<input type="text" data-reglage="mots" value="${echapper((config.keywords || []).join(', '))}" placeholder="soigneux, discret, ponctuel"></label>`
    + `<label class="hs-reglage"><span>Ton</span><select data-reglage="ton">${tons}</select></label>`
    + `<label class="hs-reglage"><span>Signature en fin de texte (facultative)</span>`
    + `<input type="text" data-reglage="signature" value="${echapper(config.signature || '')}" placeholder="Thierry"></label></div>`

  const criteres = (etat.criteres || []).map((c, i) => rendreCritere(c, i)).join('')

  const bornes = etat.autoBornes || { min: 1, max: 336 }
  const lignesAuto = (etat.autoBiens || []).map(b => {
    const actif = b.heures !== null && b.heures !== undefined
    const m = (etat.autoMessages || {})[b.property_id]
    const verrou = b.modifiable ? '' : ' disabled'
    return `<div class="hs-auto-bien">`
      + `<label class="hs-auto-nom"><input type="checkbox" data-auto-case="${echapper(b.property_id)}"${actif ? ' checked' : ''}${verrou}> ${echapper(b.nom || 'Bien')}</label>`
      + `<label class="hs-auto-delai"><input type="number" min="${bornes.min}" max="${bornes.max}" step="1" data-auto-heures="${echapper(b.property_id)}" `
      + `value="${actif ? echapper(String(b.heures)) : ''}"${actif && b.modifiable ? '' : ' disabled'} placeholder="48"> h</label>`
      + (m ? `<small class="hs-auto-message" style="color:${m.ton === 'erreur' ? '#b3261e' : '#2e5e3a'}">${echapper(m.texte)}</small>` : '')
      + `</div>`
  }).join('')
  const blocAuto = `<div class="card"><div class="card-title">Publication automatique</div>`
    + `<div class="card-sub">Quand votre prestataire a rempli sa part et que vous ne réagissez pas, l’évaluation part seule : `
    + `vos questions restées sans réponse prennent le meilleur niveau, et le texte de l’IA est conservé. `
    + `Vous êtes prévenu quelques heures avant. Un avis négatif n’est jamais publié automatiquement : il vous attend toujours. `
    + `La publication tombe dans tous les cas au moins 12 heures avant la fin du délai d’Airbnb. `
    + `Elle se règle bien par bien, et chaque ligne est prise en compte aussitôt.</div>`
    + (etat.autoErreur ? `<p class="hs-avis-erreur">${echapper(etat.autoErreur)}</p>` : '')
    + (lignesAuto || (etat.autoErreur ? '' : '<p class="card-sub">Aucun bien dans votre périmètre.</p>'))
    + `</div>`

  const entete = `<div class="card"><div class="card-title">Votre grille d’évaluation</div>`
    // ⚠ UNE GRILLE INACTIVE SE DIT, ET EN PREMIER. C'est le seul cas ou aucune
    // evaluation ne peut se remplir, et il ne se voyait nulle part.
    + (etat.inactifs
      ? `<div class="card-sub hs-avis-erreur">Votre grille est enregistrée mais N’EST PAS ACTIVE : `
        + `aucune évaluation ne peut être remplie. Enregistrez-la de nouveau pour la remettre en service.</div>`
      : '')
    + `<div class="card-sub">`
    + (etat.surDefaut
      ? 'Vous utilisez la grille par défaut. Modifiez-la et enregistrez pour en faire la vôtre.'
      : etat.biensAvecGrille
        // ⚠ La phrase d'avant disait « sur tous vos biens », ce qui est FAUX des
        // qu'un bien a sa propre grille : `grilleDe` fait primer le bien.
        ? `Votre grille remplace la grille par défaut, sauf sur ${etat.biensAvecGrille} bien(s) qui ont la leur.`
        : 'Votre grille remplace la grille par défaut sur vos biens.')
    + ` Deux règles ne se défont pas : une note 1 est toujours négative, et un refus de recommander aussi. `
    + `Un avis négatif repasse toujours par vous.</div></div>`

  return `<div class="hs-avis-reglages">`
    + (etat.erreur ? `<p class="hs-avis-erreur">${echapper(etat.erreur)}</p>` : '')
    + (etat.message ? `<p class="hs-avis-message">${echapper(etat.message)}</p>` : '')
    + entete + criteres
    + `<div class="hs-avis-actions">`
    + `<button type="button" data-action="ajouter-critere">Ajouter un critère</button>`
    + `<button type="button" data-action="revenir-defaut">Revenir à la grille par défaut</button>`
    + `</div>`
    + bloquesConfig
    + blocAuto
    + `<div class="hs-avis-actions"><button type="button" class="hs-avis-principal" data-action="enregistrer"${etat.occupe ? ' disabled' : ''}>Enregistrer</button></div>`
    + `</div>`
}

function rendreCritere (c, i) {
  const categories = Object.entries(CATEGORIE_LISIBLE).map(([k, v]) =>
    `<option value="${k}"${c.categorie === k ? ' selected' : ''}>${echapper(v)}</option>`).join('')
  const remplis = Object.entries(REMPLI_LISIBLE).map(([k, v]) =>
    `<option value="${k}"${c.rempli_par === k ? ' selected' : ''}>${echapper(v)}</option>`).join('')

  const niveaux = (c.niveaux || []).map((n, j) => {
    const force = negatifForce(n, c.categorie)
    const champNote = c.categorie === 'recommandation'
      ? `<select data-niveau="${i}:${j}" data-champ="recommande">`
        + `<option value="oui"${n.recommande === true ? ' selected' : ''}>Je recommande</option>`
        + `<option value="non"${n.recommande === false ? ' selected' : ''}>Je ne recommande pas</option></select>`
      : `<select data-niveau="${i}:${j}" data-champ="note">`
        + [5, 4, 3, 2, 1].map(v => `<option value="${v}"${Number(n.note) === v ? ' selected' : ''}>${v} / 5</option>`).join('')
        + `</select>`
    return `<div class="hs-niveau">`
      + `<input type="text" data-niveau="${i}:${j}" data-champ="libelle" value="${echapper(n.libelle || '')}" placeholder="Ce que vous cochez">`
      + champNote
      + `<label class="hs-niveau-negatif"><input type="checkbox" data-niveau="${i}:${j}" data-champ="negatif"`
      + `${(force || n.negatif) ? ' checked' : ''}${force ? ' disabled' : ''}> Négatif`
      // ⚠ LA RAISON EST ECRITE A COTE DE LA CASE. Un hote ne doit pas decouvrir
      // la regle par un refus du serveur.
      + (force ? `<span class="hs-niveau-force"> — forcé : ${c.categorie === 'recommandation' ? 'un refus de recommander' : 'une note 1'} est toujours négatif</span>` : '')
      + `</label>`
      + `<button type="button" data-action="retirer-niveau" data-index="${i}:${j}" aria-label="Retirer ce niveau">×</button>`
      + `</div>`
  }).join('')

  return `<div class="card hs-critere">`
    + `<div class="hs-critere-entete">`
    + `<input type="text" data-critere="${i}" data-champ="libelle" value="${echapper(c.libelle || '')}" placeholder="La question, telle que vous la lirez">`
    + `<select data-critere="${i}" data-champ="categorie">${categories}</select>`
    + `<select data-critere="${i}" data-champ="rempli_par">${remplis}</select>`
    + `<button type="button" data-action="retirer-critere" data-index="${i}" aria-label="Retirer ce critère">Retirer</button>`
    + `</div>`
    + `<div class="hs-niveaux">${niveaux}</div>`
    + `<button type="button" data-action="ajouter-niveau" data-index="${i}">Ajouter un niveau</button>`
    + `</div>`
}

export { CATEGORIE_LISIBLE, REMPLI_LISIBLE }
