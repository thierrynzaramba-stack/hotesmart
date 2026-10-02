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
export async function monter (conteneur, options = {}) {
  const appel = options.appel || appelParDefaut
  const avertir = options.avertir || (() => {})
  if (!conteneur) throw new Error('[avis] l ecran de reglages exige un conteneur')

  const etat = { criteres: [], config: null, tons: ['chaleureux', 'sobre'], defaut: [], occupe: false, message: null, erreur: null }

  conteneur.innerHTML = '<p class="hs-avis-attente">Chargement des réglages…</p>'
  try {
    const [grille, config] = await Promise.all([appel('avis?action=grille'), appel('avis?action=config')])
    etat.defaut = grille.defaut || []
    etat.config = config.compte || { keywords: [], tone: 'chaleureux', signature: '' }
    etat.tons = config.tons || etat.tons
    etat.autoBornes = config.auto_validation || { min: 1, max: 336 }
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

    // L'auto-validation (§10 bis) : la case l'active, le champ dit le delai.
    const autoCase = conteneur.querySelector('[data-reglage="auto-active"]')
    if (autoCase) autoCase.addEventListener('change', () => {
      etat.config.auto_validation_heures = autoCase.checked ? (etat.dernierDelai || 48) : null
      afficher()
    })
    lier('auto-heures', (v) => {
      etat.config.auto_validation_heures = v === '' ? '' : Number(v)
      if (Number.isInteger(etat.config.auto_validation_heures)) etat.dernierDelai = etat.config.auto_validation_heures
    })

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

  async function enregistrer () {
    if (etat.occupe) return
    // Le delai se verifie AVANT tout envoi : une grille enregistree et un delai
    // refuse laisseraient l'hote avec la moitie de ses reglages.
    const h = etat.config.auto_validation_heures
    const b = etat.autoBornes || { min: 1, max: 336 }
    if (h !== null && h !== undefined && !(Number.isInteger(h) && h >= b.min && h <= b.max)) {
      etat.erreur = `Délai de publication automatique : un nombre entier d’heures entre ${b.min} et ${b.max}.`
      avertir(etat.erreur, 'err'); afficher(); return
    }
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
          auto_validation_heures: h === undefined ? null : h,
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

  const heures = config.auto_validation_heures
  const autoActive = heures !== null && heures !== undefined
  const bornes = etat.autoBornes || { min: 1, max: 336 }
  const blocAuto = `<div class="card"><div class="card-title">Publication automatique</div>`
    + `<div class="card-sub">Quand votre prestataire a rempli sa part et que vous ne réagissez pas, l’évaluation part seule : `
    + `vos questions restées sans réponse prennent le meilleur niveau, et le texte de l’IA est conservé. `
    + `Vous êtes prévenu quelques heures avant. Un avis négatif n’est jamais publié automatiquement : il vous attend toujours. `
    + `La publication tombe dans tous les cas au moins 12 heures avant la fin du délai d’Airbnb.</div>`
    + `<label class="hs-reglage"><span><input type="checkbox" data-reglage="auto-active"${autoActive ? ' checked' : ''}> `
    + `Valider automatiquement au bout d’un délai sans réaction de ma part</span></label>`
    + `<label class="hs-reglage"><span>Délai, en heures (de ${bornes.min} à ${bornes.max})</span>`
    + `<input type="number" min="${bornes.min}" max="${bornes.max}" step="1" data-reglage="auto-heures" `
    + `value="${autoActive ? echapper(String(heures)) : ''}"${autoActive ? '' : ' disabled'} placeholder="48"></label></div>`

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
