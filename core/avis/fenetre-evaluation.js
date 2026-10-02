// core/avis/fenetre-evaluation.js
// DOC : docs/kb/protocole-coeur.md et docs/specs/spec-evaluation-voyageur.md
//       (modif = MEME COMMIT)
//
// ACTION `avis.evaluer` — LA FENETRE D'EVALUATION DU VOYAGEUR.
//
// Le bus (shared/hs-bus.js) fournit la fenetre, ce module fournit le contenu.
// Il recoit { conteneur, params, identite, fermer, action } et n'en sort pas :
// aucune app ne connait ce fichier.
//
// ⚠ CET ECRAN NE DECIDE RIEN. Il coche des niveaux, il montre un texte, il
// demande confirmation. Les notes sont un calcul deterministe du serveur, le
// garde-fou du negatif s'applique au serveur, et le perimetre par bien est
// verifie au serveur. Tout ce qui est refuse ici est refuse la-bas aussi — sans
// quoi il suffirait d'ouvrir la console pour passer outre.
//
// ⚠ ET IL NE MENT PAS SUR CE QU'IL NE SAIT PAS. Un refus nomme par le serveur
// est affiche TEL QUEL, avec son motif. Une evaluation qui revient a l'hote
// parce que l'IA a refuse de rediger doit le DIRE : sinon il decouvre un
// formulaire rempli sans comprendre pourquoi il l'a sur les bras.

import { appel as appelParDefaut } from './appel.js'
import { hsBus } from '../../shared/hs-bus.js'

// ─── La mise en page, embarquee ─────────────────────────────────────────────
// ⚠ LE STYLE VIT AVEC LE MODULE (constat de Thierry en production, 2 octobre
// 2026 : « 0 css et mise en page »). La fenetre s'ouvre depuis quatre ecrans
// (page Avis, messagerie, deux calendriers) et la PWA de la prestataire ; une
// feuille par page, c'est quatre copies qui divergent — ou, comme ici, aucune.
// Injecte une seule fois par document, sur les couleurs du site quand elles
// existent (variables de /public/style.css), avec un repli sinon (PWA).
const STYLE_ID = 'hs-avis-style'
const STYLE = `
.hs-avis { font-size: 14px; line-height: 1.45; color: var(--text, #1a1a1a); }
.hs-avis h2 { font-size: 17px; font-weight: 600; margin: 0 28px 2px 0; }
.hs-avis-etat { margin: 0 0 14px; font-size: 12.5px; color: var(--text2, #6b6b6b); }
.hs-avis-questions { border: 0; margin: 0 0 6px; padding: 0; min-width: 0; }
.hs-avis-questions legend { font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text2, #6b6b6b); padding: 0; margin-bottom: 6px; }
.hs-avis-critere { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 0.5px solid #e6e2dd; }
.hs-avis-critere:first-of-type { border-top: 0; }
.hs-avis-critere span { flex: 1 1 auto; min-width: 0; }
.hs-avis-critere select { flex: 0 0 auto; max-width: 55%; font: inherit; font-size: 13.5px; padding: 6px 8px; border: 1px solid #d9d4ce; border-radius: 8px; background: var(--bg, #fff); color: inherit; }
.hs-avis-compte-rendu { font-size: 12.5px; color: var(--text2, #6b6b6b); margin: 4px 0 14px; }
.hs-avis-remarque, .hs-avis-texte, .hs-avis-prive { display: block; margin: 0 0 12px; }
.hs-avis-remarque span, .hs-avis-texte span, .hs-avis-prive span { display: block; font-size: 12.5px; font-weight: 500; margin-bottom: 4px; }
.hs-avis textarea { display: block; width: 100%; box-sizing: border-box; font: inherit; font-size: 14px; padding: 8px 10px; border: 1px solid #d9d4ce; border-radius: 8px; background: var(--bg, #fff); color: inherit; resize: vertical; }
.hs-avis textarea[readonly] { background: var(--bg2, #f5f5f3); }
.hs-avis-note { display: block; font-size: 12px; color: var(--text2, #6b6b6b); margin-top: 4px; }
.hs-avis-message { background: #eef5ee; color: #2e5e3a; border-radius: 8px; padding: 8px 10px; margin: 0 0 12px; font-size: 13px; }
.hs-avis-erreur { background: #fbeceb; color: #b3261e; border-radius: 8px; padding: 8px 10px; margin: 0 0 12px; font-size: 13px; }
.hs-avis-vide, .hs-avis-attente { color: var(--text2, #6b6b6b); font-size: 13px; }
.hs-avis-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.hs-avis-actions button { font: inherit; font-size: 13.5px; padding: 9px 14px; min-height: 40px; border-radius: 10px; border: 1px solid #d9d4ce; background: var(--bg, #fff); color: inherit; cursor: pointer; }
.hs-avis-actions button:disabled { opacity: .5; cursor: default; }
.hs-avis-actions .hs-avis-principal { background: #C97B5C; border-color: #C97B5C; color: #fff; font-weight: 600; }
.hs-avis-actions [data-avis="abandonner"] { color: #b3261e; }
.hs-avis-actions [data-avis="fermer"] { margin-left: auto; }
@media (max-width: 480px) {
  .hs-avis-critere { flex-wrap: wrap; }
  .hs-avis-critere select { max-width: 100%; width: 100%; }
  .hs-avis-actions button { flex: 1 1 auto; }
  .hs-avis-actions [data-avis="fermer"] { margin-left: 0; }
}
`
export function poserStyle (doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return
  const s = doc.createElement('style')
  s.id = STYLE_ID
  s.textContent = STYLE
  doc.head.appendChild(s)
}

const ETAT_LISIBLE = {
  a_remplir: 'À remplir',
  soumise_prestataire: 'Remplie par la prestataire',
  a_valider: 'À valider',
  publiee: 'Publiée',
  echec_publication: 'Échec de publication',
  expiree: 'Délai dépassé',
  abandonnee: 'Abandonnée',
}

// Les motifs que le serveur peut rendre, en francais. Un motif inconnu est
// AFFICHE tel quel plutot que masque : mieux vaut un mot technique qu'un silence.
const MOTIF_LISIBLE = {
  negatif_a_valider: 'Cet avis est négatif : seul l’hôte peut le publier.',
  pouvoir_insuffisant: 'Votre profil soumet les évaluations, il ne les publie pas.',
  texte_absent: 'Il n’y a pas encore de texte à publier.',
  deja_publiee: 'Cette évaluation est déjà publiée.',
  expiree: 'Le délai de la plateforme est passé : cette évaluation ne peut plus être publiée.',
  deja_en_cours: 'Une publication est déjà en cours pour cette évaluation.',
  auto_en_cours: 'Une publication automatique est en cours pour cette évaluation : rechargez la page.',
  auto_annulee: 'Vous avez repris l’évaluation : la publication automatique a renoncé.',
  reponses_hors_grille: 'Des réponses manquent, ou ne correspondent plus à la grille.',
  grille_figee_illisible: 'La grille enregistrée avec cette évaluation est illisible : contactez le support.',
  reference_ota_absente: 'La plateforme n’a pas encore ouvert d’avis pour ce séjour.',
  sans_objet_ota: 'La plateforme n’a pas encore ouvert d’avis pour ce séjour.',
  ia_contredit_les_boutons: 'La rédaction automatique a produit un texte qui contredisait vos réponses. Écrivez-le vous-même.',
  ia_cite_la_prestataire: 'La rédaction automatique citait le prénom de la prestataire. Écrivez le texte vous-même.',
  ia_recopie_le_prive: 'La rédaction automatique recopiait la note privée dans le texte public. Écrivez-le vous-même.',
  ia_illisible: 'La rédaction automatique n’a rien produit d’exploitable. Écrivez le texte vous-même.',
  ia_indisponible: 'La rédaction automatique est momentanément indisponible. Réessayez, ou écrivez le texte vous-même.',
  langue_non_verifiable: 'Cet avis est négatif et le texte doit être écrit dans une langue que nous ne savons pas relire automatiquement. Écrivez-le vous-même.',
  aucune_reponse: 'Aucun critère n’est rempli : il n’y a rien à rédiger.',
  abandonnee: 'Cette évaluation a été abandonnée : elle ne se publie plus.',
  statut_incompatible: 'Cette évaluation n’est pas dans un état qui permet de la publier.',
  sans_reponses: 'Aucune réponse n’est enregistrée : il n’y a rien à publier.',
  etat_provider_inconnu: 'La plateforme ne dit pas si l’avis est déjà parti. Réessayez dans quelques minutes.',
  deja_chez_le_provider: 'L’avis était déjà parti chez la plateforme : il est maintenant marqué publié.',
  grille_sans_jugement: 'La grille ne produit ni note ni recommandation : complétez-la dans Réglages.',
  provider_inconnu: 'La plateforme de ce séjour est inconnue : contactez le support.',
  prestataire_non_autorisee: 'L’hôte ne vous a pas autorisée à participer aux évaluations.',
  reponses_de_l_hote: 'L’hôte a répondu à cette évaluation : c’est lui qui la publie.',
}

const echapper = (t) => String(t == null ? '' : t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const dateFr = (d) => {
  if (!d) return ''
  const x = new Date(d)
  return isNaN(x) ? '' : x.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * Le point d'entree du bus.
 * @param {Object} ctx { conteneur, params, identite, fermer, action, deps? }
 */
export async function ouvrir (ctx = {}) {
  const { conteneur, params = {}, fermer = () => {} } = ctx
  const appel = (ctx.deps && ctx.deps.appel) || appelParDefaut
  // Le delai avant fermeture apres un enregistrement de la prestataire (tests : 0).
  const delaiFermeture = (ctx.deps && ctx.deps.delaiFermeture !== undefined) ? ctx.deps.delaiFermeture : 1500
  const confirmer = (ctx.deps && ctx.deps.confirmer) || ((m) => (typeof window !== 'undefined' ? window.confirm(m) : false))
  if (!conteneur) throw new Error('[avis] la fenetre d evaluation exige un conteneur')

  // L'etat vit ici, et nulle part ailleurs : pas de variable de module, sinon
  // deux ouvertures successives se marcheraient dessus.
  const etat = { evaluation: null, criteres: [], role: null, reponses: {}, message: null, erreur: null, occupe: false }

  poserStyle(conteneur.ownerDocument)
  const afficher = () => { conteneur.innerHTML = rendre(etat); brancher() }

  // ─── Chargement ─────────────────────────────────────────────────────────
  conteneur.innerHTML = '<p class="hs-avis-attente">Chargement de l’évaluation…</p>'
  try {
    const data = await appel(`avis?action=evaluation&booking_uid=${encodeURIComponent(params.booking_uid)}`)
    etat.evaluation = data.evaluation || {}
    etat.criteres = data.criteres || []
    etat.role = data.role || 'hote'
    // ⚠ DES L'OUVERTURE, pas seulement apres un enregistrement. Une prestataire
    // « valider » qui reouvre une evaluation deja complete doit voir son bouton
    // de publication tout de suite : la spec §11 bis dit « elle relit, puis elle
    // publie ». Constat de review.
    etat.peutPublier = data.peut_publier === true
    etat.negatif = data.negatif === true
    // Les reponses deja enregistrees pre-cochent le formulaire : la prestataire
    // a peut-etre deja rempli sa part.
    etat.reponses = { ...(etat.evaluation.answers_cleaner || {}), ...(etat.evaluation.answers_host || {}) }
  } catch (err) {
    // ⚠ UN ECHEC DE CHARGEMENT SE DIT DANS LA FENETRE, il ne la fait pas
    // disparaitre. Le bus fermerait la fenetre et repondrait « indisponible »
    // si on levait, et l'utilisateur verrait son bouton ne rien faire.
    conteneur.innerHTML = `<div class="hs-avis"><h2>Évaluation du voyageur</h2>`
      + `<p class="hs-avis-erreur">${echapper(err.statut === 403
        ? 'Ce séjour n’est pas dans votre périmètre.'
        : err.statut === 404
          ? 'Aucune évaluation n’existe pour ce séjour.'
          : err.message)}</p>`
      + `<div class="hs-avis-actions"><button type="button" data-avis="fermer">Fermer</button></div></div>`
    const b = conteneur.querySelector('[data-avis="fermer"]')
    if (b) b.addEventListener('click', () => fermer())
    return { charge: false }
  }

  // ─── Les actions ────────────────────────────────────────────────────────
  const avecOccupe = (fn) => async (...args) => {
    if (etat.occupe) return
    etat.occupe = true; etat.erreur = null; etat.message = null; afficher()
    try { await fn(...args) } finally { etat.occupe = false; afficher() }
  }

  const enregistrer = avecOccupe(async () => {
    // ⚠ ON N'ENVOIE QUE LES CRITERES OUVERTS A CE ROLE. Le serveur refuse les
    // autres par une erreur nommee ; les envoyer quand meme ferait echouer une
    // saisie valide parce que le formulaire a pre-coche la part de l'autre.
    // ⚠ ON ENVOIE AUSSI LES EFFACEMENTS. Une cle a `null` dit « je retire ma
    // reponse » ; l'omettre laissait l'ancienne en base.
    const miennes = {}
    for (const c of etat.criteres) {
      if (etat.reponses[c.cle] != null) miennes[c.cle] = etat.reponses[c.cle]
      else if (c.cle in etat.reponses) miennes[c.cle] = null
    }
    try {
      const r = await appel('avis?action=eval-reponses', {
        methode: 'POST',
        corps: { action: 'eval-reponses', booking_uid: etat.evaluation.booking_uid || params.booking_uid, reponses: miennes },
      })
      etat.evaluation.status = r.status
      etat.peutPublier = r.peut_publier
      etat.negatif = r.negatif
      // ⚠ LA PRESTATAIRE QUI N'A RIEN A PUBLIER A FINI (recette du 2 octobre
      // 2026) : la fenetre restait ouverte, avec le motif brut du serveur
      // (« avis negatif : l hote tranche… ») — un jugement qui ne la regarde
      // pas. Un merci, puis la fenetre se ferme. Elle ne reste ouverte que si
      // elle a elle-meme un texte a relire et a publier.
      if (etat.role === 'prestataire' && r.peut_publier === false && r.status !== 'a_remplir') {
        etat.message = 'Merci, vos réponses sont enregistrées. L’hôte prend la suite.'
        setTimeout(() => fermer(), delaiFermeture)
        return
      }
      if (r.redaction && r.redaction.ok) {
        etat.evaluation.public_text = r.redaction.public_text
        etat.message = 'Réponses enregistrées, et le texte a été rédigé.'
      } else if (r.redaction && !r.redaction.ok) {
        // ⚠ LE REFUS DE REDACTION SE DIT. C'est la raison pour laquelle
        // l'evaluation revient a l'hote.
        etat.message = 'Réponses enregistrées. ' + (MOTIF_LISIBLE[r.redaction.motif] || `Rédaction refusée : ${r.redaction.motif}`)
      } else {
        etat.message = `Réponses enregistrées. ${r.motif || ''}`.trim()
      }
    } catch (err) { etat.erreur = messageDErreur(err) }
  })

  const redigerTexte = avecOccupe(async () => {
    try {
      const r = await appel('avis?action=eval-texte', {
        methode: 'POST',
        corps: { action: 'eval-texte', booking_uid: etat.evaluation.booking_uid || params.booking_uid, remarque: etat.remarque || null },
      })
      etat.evaluation.public_text = r.public_text
      etat.evaluation.private_note = r.private_note
      etat.message = 'Texte rédigé. Relisez-le, modifiez-le si besoin.'
    } catch (err) { etat.erreur = messageDErreur(err) }
  })

  const publier = avecOccupe(async () => {
    // ⚠ CONFIRMATION EXPLICITE AVANT UN AVIS NEGATIF (garde-fou §3 de la spec).
    // Elle ne remplace pas le garde-fou serveur — qui, lui, interdit a une
    // prestataire de publier un negatif — elle protege l'HOTE d'un clic.
    if (etat.negatif || estNegatifAffiche(etat)) {
      const texte = 'Cet avis est NÉGATIF et sera visible par les futurs hôtes de ce voyageur.\n\n'
        + 'Chez Airbnb, un avis publié ne se reprend pas.\n\nConfirmez-vous la publication ?'
      if (!confirmer(texte)) { etat.message = 'Publication annulée.'; return }
    }
    try {
      const r = await appel('avis?action=eval-publier', {
        methode: 'POST',
        corps: {
          action: 'eval-publier',
          booking_uid: etat.evaluation.booking_uid || params.booking_uid,
          public_text: etat.evaluation.public_text || undefined,
        },
      })
      etat.evaluation.status = r.status
      etat.evaluation.published_at = r.published_at
      // ⚠ L'EVENEMENT DU COEUR, pour que l'app qui a ouvert la fenetre se mette
      // a jour (le bandeau de la messagerie, la fiche du calendrier). Sans bus
      // (tests, page sans lui), rien ne part : ce n'est pas une erreur.
      if (r.status === 'publiee' && hsBus && (etat.evaluation.booking_uid || params.booking_uid)) {
        try { hsBus.emettre('avis.evaluation_publiee', { booking_uid: etat.evaluation.booking_uid || params.booking_uid, published_at: r.published_at }) } catch { /* sans auditeur, sans effet */ }
      }
      // ⚠ LA SIMULATION SE DIT. Un « Avis publie » identique dans les deux modes
      // ferait croire a une recette qu'elle vient d'envoyer un avis reel.
      etat.message = r.simulation
        ? 'Avis « publié » EN SIMULATION : rien n’a été envoyé à la plateforme.'
        : 'Avis publié.'
    } catch (err) { etat.erreur = messageDErreur(err) }
  })

  const abandonner = avecOccupe(async () => {
    if (!confirmer('Abandonner cette évaluation ? Elle ne sera plus proposée.')) return
    try {
      const r = await appel('avis?action=eval-abandon', {
        methode: 'POST',
        corps: { action: 'eval-abandon', booking_uid: etat.evaluation.booking_uid || params.booking_uid },
      })
      etat.evaluation.status = r.status
      etat.message = 'Évaluation abandonnée.'
    } catch (err) { etat.erreur = messageDErreur(err) }
  })

  function brancher () {
    conteneur.querySelectorAll('[data-avis-critere]').forEach(el => {
      el.addEventListener('change', () => {
        // ⚠ REVENIR A « — choisir — » EFFACE LA REPONSE, il ne la laisse pas en
        // base. Constat de review : la valeur devenait `null` et l'envoi ignorait
        // les `null`, donc la reponse deja enregistree survivait a son
        // decochage — l'hote croyait avoir retire son jugement.
        etat.reponses[el.dataset.avisCritere] = el.value || null
        etat.aEfface = etat.aEfface || !el.value
        // On ne redessine pas tout : le focus se perdrait au milieu du
        // formulaire. Seul le bloc d'etat change.
        const b = conteneur.querySelector('[data-avis="compte-rendu"]')
        if (b) b.textContent = compteRendu(etat)
      })
    })
    const t = conteneur.querySelector('[data-avis="texte"]')
    if (t) t.addEventListener('input', () => {
      etat.evaluation.public_text = t.value
      // ⚠ UN TEXTE MODIFIE N'EST EN BASE QU'A LA PUBLICATION. Le dire, plutot que
      // de le laisser perdre en silence a la fermeture de la fenetre.
      const avis = conteneur.querySelector('[data-avis="texte-non-enregistre"]')
      if (avis) avis.textContent = 'Ce texte ne sera enregistré qu’à la publication.'
    })
    const r = conteneur.querySelector('[data-avis="remarque"]')
    if (r) r.addEventListener('input', () => { etat.remarque = r.value })
    const brancherBouton = (nom, fn) => {
      const b = conteneur.querySelector(`[data-avis="${nom}"]`)
      if (b) b.addEventListener('click', fn)
    }
    brancherBouton('enregistrer', enregistrer)
    brancherBouton('rediger', redigerTexte)
    brancherBouton('publier', publier)
    brancherBouton('abandonner', abandonner)
    brancherBouton('fermer', () => fermer())
  }

  afficher()
  return { charge: true, role: etat.role, statut: etat.evaluation.status }
}

// ─── Rendu ──────────────────────────────────────────────────────────────────
// Sorti de `ouvrir` pour etre lisible, et testable sur un etat donne.

function estNegatifAffiche (etat) {
  // Ce que l'ecran peut voir du negatif SANS le serveur : un niveau coche qui
  // porte le drapeau. Ce n'est pas le juge — le serveur l'est — mais cela suffit
  // a declencher la confirmation avant un clic.
  for (const c of etat.criteres || []) {
    const choisi = (etat.reponses || {})[c.cle]
    if (!choisi) continue
    const niv = (c.niveaux || []).find(n => n.cle === choisi)
    if (!niv) continue
    if (niv.negatif || niv.note === 1 || niv.recommande === false) return true
    // ⚠ LA QUATRIEME REGLE, celle de lib/avis/notes-evaluation.js : un critere de
    // recommandation dont le niveau coche ne porte pas de booleen vaut NEGATIF —
    // « je ne sais pas » n'est pas « oui ». Elle manquait ici, donc une grille
    // figee anterieure aux contraintes declenchait le garde-fou serveur sans que
    // la fenetre demande confirmation. Deux definitions du negatif finissent par
    // diverger davantage. Constat de review.
    if (c.categorie === 'recommandation' && typeof niv.recommande !== 'boolean') return true
  }
  return false
}

function compteRendu (etat) {
  const total = (etat.criteres || []).length
  const faits = (etat.criteres || []).filter(c => (etat.reponses || {})[c.cle] != null).length
  const reste = total - faits
  if (!total) return 'Aucune question ne vous est ouverte sur cette évaluation.'
  if (reste > 0) return `${faits} question(s) sur ${total} — il en reste ${reste}.`
  return estNegatifAffiche(etat)
    ? `${total} question(s) sur ${total}. Cet avis sera NÉGATIF : l’hôte devra le valider.`
    : `${total} question(s) sur ${total}. Rien de négatif.`
}

function rendre (etat) {
  const e = etat.evaluation || {}
  const publiee = e.status === 'publiee'
  const fige = ['publiee', 'expiree', 'abandonnee'].includes(e.status)
  const peutRediger = etat.role === 'hote' && !fige
  const peutPublier = !fige && (etat.role === 'hote' || etat.peutPublier === true)

  const entete = `<h2>Évaluation du voyageur</h2>`
    + `<p class="hs-avis-etat">${echapper(ETAT_LISIBLE[e.status] || e.status || '')}`
    + (e.published_at ? ` · publiée le ${echapper(dateFr(e.published_at))}` : '')
    + (e.deadline_at && !publiee ? ` · à publier avant le ${echapper(dateFr(e.deadline_at))}` : '')
    + `</p>`

  const questions = (etat.criteres || []).length
    ? `<fieldset class="hs-avis-questions"${fige ? ' disabled' : ''}><legend>Ce qui s’est passé</legend>`
      + etat.criteres.map(c => {
        const choisi = (etat.reponses || {})[c.cle] || ''
        const options = [`<option value="">— choisir —</option>`]
          .concat((c.niveaux || []).map(n =>
            `<option value="${echapper(n.cle)}"${n.cle === choisi ? ' selected' : ''}>${echapper(n.libelle || n.cle)}</option>`))
          .join('')
        return `<label class="hs-avis-critere"><span>${echapper(c.libelle || c.cle)}</span>`
          + `<select data-avis-critere="${echapper(c.cle)}">${options}</select></label>`
      }).join('')
      + `</fieldset>`
    : `<p class="hs-avis-vide">Aucune question ne vous est ouverte sur cette évaluation.</p>`

  // ⚠ LA NOTE PRIVEE NE S'AFFICHE QUE POUR L'HOTE. Le serveur ne l'envoie pas a
  // une prestataire ; ce test est une seconde barriere, pas la premiere.
  const prive = etat.role === 'hote' && e.private_note
    ? `<label class="hs-avis-prive"><span>Note privée au voyageur (jamais publique)</span>`
      + `<textarea readonly rows="2">${echapper(e.private_note)}</textarea></label>`
    : ''

  const remarque = peutRediger
    ? `<label class="hs-avis-remarque"><span>Remarque pour la rédaction (privée, non publiée)</span>`
      + `<textarea data-avis="remarque" rows="2" placeholder="Ce que l’IA doit savoir sans le recopier">${echapper(etat.remarque || '')}</textarea></label>`
    : ''

  // Le texte public : modifiable par l'hote, en lecture seule pour une
  // prestataire qui doit le relire avant de publier.
  const texte = (e.public_text != null || peutRediger)
    ? `<label class="hs-avis-texte"><span>Texte public${etat.role === 'hote' ? '' : ' (relisez-le avant de publier)'}</span>`
      + `<textarea data-avis="texte" rows="5"${etat.role === 'hote' && !fige ? '' : ' readonly'}>${echapper(e.public_text || '')}</textarea>`
      + `<small data-avis="texte-non-enregistre" class="hs-avis-note"></small></label>`
    : ''

  const boutons = [
    !fige && (etat.criteres || []).length ? `<button type="button" data-avis="enregistrer"${etat.occupe ? ' disabled' : ''}>Enregistrer mes réponses</button>` : '',
    peutRediger ? `<button type="button" data-avis="rediger"${etat.occupe ? ' disabled' : ''}>Rédiger le texte</button>` : '',
    peutPublier ? `<button type="button" data-avis="publier" class="hs-avis-principal"${etat.occupe ? ' disabled' : ''}>Publier l’avis</button>` : '',
    etat.role === 'hote' && !fige ? `<button type="button" data-avis="abandonner"${etat.occupe ? ' disabled' : ''}>Ne pas évaluer</button>` : '',
    `<button type="button" data-avis="fermer">Fermer</button>`,
  ].filter(Boolean).join('')

  return `<div class="hs-avis">${entete}`
    + (etat.erreur ? `<p class="hs-avis-erreur">${echapper(etat.erreur)}</p>` : '')
    + (etat.message ? `<p class="hs-avis-message">${echapper(etat.message)}</p>` : '')
    + questions
    + `<p class="hs-avis-compte-rendu" data-avis="compte-rendu">${echapper(compteRendu(etat))}</p>`
    + remarque + texte + prive
    + `<div class="hs-avis-actions">${boutons}</div></div>`
}

function messageDErreur (err) {
  if (err && err.motif && MOTIF_LISIBLE[err.motif]) return MOTIF_LISIBLE[err.motif]
  if (err && err.motif) return `${err.message} (${err.motif})`
  if (err && err.statut === 403) return 'Ce séjour n’est pas dans votre périmètre.'
  return (err && err.message) || 'Erreur inattendue'
}

export { rendre, compteRendu, estNegatifAffiche, MOTIF_LISIBLE, ETAT_LISIBLE, messageDErreur }
