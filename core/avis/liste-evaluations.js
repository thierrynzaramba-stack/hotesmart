// core/avis/liste-evaluations.js
// DOC : docs/specs/spec-evaluation-voyageur.md §8 (modif = MEME COMMIT)
//
// LA LISTE DES EVALUATIONS DU VOYAGEUR, sur la page /avis.
//
// Elle repond a une seule question : qu'est-ce qui m'attend ? D'ou l'ordre —
// ce qui expire bientot d'abord, le reste ensuite — et non l'ordre de creation,
// qui ne dit rien a personne.
//
// ⚠ ELLE N'OUVRE PAS LA FENETRE ELLE-MEME. C'est le bus qui la fournit
// (`hsBus.ouvrir('avis.evaluer', { booking_uid })`), et c'est lui qui sait si
// l'action est disponible. Un module du coeur qui appellerait directement un
// autre module du coeur court-circuiterait le contrat.

import { appel as appelParDefaut } from './appel.js'

const ETAT_LISIBLE = {
  a_remplir: 'À remplir',
  soumise_prestataire: 'Remplie par la prestataire',
  a_valider: 'À valider',
  publiee: 'Publiée',
  echec_publication: 'Échec de publication',
  expiree: 'Délai dépassé',
  abandonnee: 'Abandonnée',
}

// Ce qui demande une action de l'hote, et dans quel ordre d'urgence.
const URGENCE = { echec_publication: 0, a_valider: 1, soumise_prestataire: 2, a_remplir: 3 }
const A_FAIRE = new Set(Object.keys(URGENCE))

const echapper = (t) => String(t == null ? '' : t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const dateFr = (d) => {
  if (!d) return ''
  const x = new Date(d)
  return isNaN(x) ? '' : x.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

// Jours restants avant l'echeance, ou null.
export function joursRestants (echeance, maintenant = Date.now()) {
  if (!echeance) return null
  const x = new Date(echeance)
  if (isNaN(x)) return null
  return Math.ceil((x.getTime() - maintenant) / 86400000)
}

// ⚠ L'ORDRE DIT L'URGENCE, pas la date de creation. Ce qui expire dans deux
// jours passe devant ce qui expire dans trois semaines, et ce qui a echoue passe
// devant tout : un echec de publication est la seule chose qu'un humain doit
// regarder tout de suite.
export function trier (evaluations, maintenant = Date.now()) {
  return [...(evaluations || [])].sort((a, b) => {
    const ua = URGENCE[a.status] ?? 9
    const ub = URGENCE[b.status] ?? 9
    if (ua !== ub) return ua - ub
    const ja = joursRestants(a.echeance, maintenant)
    const jb = joursRestants(b.echeance, maintenant)
    // Une evaluation SANS echeance ne passe pas devant une qui expire demain :
    // on ne sait pas quand elle expire, donc elle attend.
    if (ja === null && jb === null) return String(b.creee_le || '').localeCompare(String(a.creee_le || ''))
    if (ja === null) return 1
    if (jb === null) return -1
    return ja - jb
  })
}

export async function monter (conteneur, options = {}) {
  const appel = options.appel || appelParDefaut
  const bus = options.bus || null
  const maintenant = options.maintenant || (() => Date.now())
  if (!conteneur) throw new Error('[avis] la liste des evaluations exige un conteneur')

  const etat = { evaluations: [], filtre: '', message: null }

  async function charger () {
    conteneur.innerHTML = '<p class="hs-avis-attente">Chargement des évaluations…</p>'
    try {
      const data = await appel(`avis?action=evaluations${etat.filtre ? `&etat=${encodeURIComponent(etat.filtre)}` : ''}`)
      etat.evaluations = data.evaluations || []
    } catch (err) {
      // ⚠ UN ECHEC SE DIT. Une section vide laisserait croire qu'il n'y a rien
      // a evaluer — le contraire de ce qu'on sait.
      conteneur.innerHTML = `<p class="hs-avis-erreur">${echapper(err.message || 'Évaluations illisibles')}</p>`
      return false
    }
    afficher()
    return true
  }

  function afficher () {
    conteneur.innerHTML = rendre(etat, maintenant())
    conteneur.querySelectorAll('[data-evaluer]').forEach(b => b.addEventListener('click', async () => {
      // ⚠ PAR LE BUS, TOUJOURS. Sans bus injecte (tests, ou page qui ne l'a pas
      // charge), le bouton n'est pas propose plutot que de ne rien faire.
      if (!bus) return
      const r = await bus.ouvrir('avis.evaluer', { booking_uid: b.dataset.evaluer })
      if (!r || r.ok !== true) {
        etat.message = 'L’évaluation n’est pas disponible pour ce séjour.'
        afficher()
        return
      }
      // Au retour de la fenetre, l'etat a pu changer : on relit.
      await charger()
    }))
    const f = conteneur.querySelector('[data-filtre]')
    if (f) f.addEventListener('change', async () => { etat.filtre = f.value; await charger() })
  }

  const ok = await charger()
  return { charge: ok, total: etat.evaluations.length }
}

export function rendre (etat, maintenant = Date.now()) {
  const liste = trier(etat.evaluations, maintenant)
  // ⚠ CE QUI EST HORS DELAI N'ATTEND PLUS PERSONNE. Le compter dans « n
  // evaluations vous attendent » enverrait chercher une action impossible.
  const aFaire = liste.filter(e => {
    if (!A_FAIRE.has(e.status)) return false
    const j = joursRestants(e.echeance, maintenant)
    return j === null || j >= 0
  })
  const horsDelai = liste.filter(e => {
    if (!A_FAIRE.has(e.status)) return false
    const j = joursRestants(e.echeance, maintenant)
    return j !== null && j < 0
  }).length

  // ⚠ TOUS LES ETATS QUE LE SERVEUR ACCEPTE. Constat de review : le filtre en
  // omettait deux (`soumise_prestataire`, `abandonnee`), donc on ne pouvait pas
  // demander a les voir seuls.
  const filtres = ['', 'a_remplir', 'soumise_prestataire', 'a_valider', 'publiee',
                   'echec_publication', 'expiree', 'abandonnee']
    .map(v => `<option value="${v}"${etat.filtre === v ? ' selected' : ''}>`
      + (v === '' ? 'Toutes' : echapper(ETAT_LISIBLE[v] || v)) + '</option>').join('')

  const entete = `<div class="hs-eval-entete">`
    + `<h2>Évaluations du voyageur</h2>`
    + `<label class="hs-eval-filtre"><span>Afficher</span><select data-filtre>${filtres}</select></label>`
    + `</div>`
    + `<p class="hs-eval-resume">`
    + (aFaire.length
      ? `${aFaire.length} évaluation(s) vous attendent.`
      : liste.length ? 'Rien ne vous attend.' : 'Aucune évaluation pour le moment.')
    + (horsDelai ? ` ${horsDelai} hors délai, plus publiable(s).` : '')
    + `</p>`

  if (!liste.length) {
    return `<div class="hs-eval">${entete}`
      // Decision D2 du 2 octobre 2026 : elle nait au depart, sans attendre la
      // plateforme — qui n'ouvre l'avis qu'apres celui du voyageur.
      + `<p class="hs-eval-vide">Une évaluation apparaît le jour du départ de chaque voyageur Airbnb. `
      + `Airbnb seulement pour l’instant.</p></div>`
  }

  const lignes = liste.map(e => {
    const j = joursRestants(e.echeance, maintenant)
    // ⚠ LE DELAI SE JUGE SUR LA DATE, PAS SUR LE STATUT. Constat de review :
    // le garde ne portait que sur les statuts terminaux, et RIEN ne bascule une
    // evaluation en `expiree` tout seul — la seule ecriture de ce statut vient
    // d'une tentative de publication. Une evaluation que personne n'a touchee
    // reste donc `a_remplir` indefiniment, et affichait « dernier jour » trois
    // semaines apres l'echeance. C'est le mensonge exact que ce garde existe
    // pour eviter.
    const termine = ['publiee', 'expiree', 'abandonnee'].includes(e.status)
    const depasse = j !== null && j < 0
    const delai = termine ? ''
      : j === null ? ''
        : depasse ? `<span class="hs-eval-urgent">délai dépassé</span>`
          : j === 0 ? `<span class="hs-eval-urgent">dernier jour</span>`
            : j <= 3 ? `<span class="hs-eval-urgent">${j} jour${j > 1 ? 's' : ''}</span>`
              : `<span class="hs-eval-delai">${j} jours</span>`
    // ⚠ ET LE BOUTON DISPARAIT QUAND LE DELAI EST PASSE (spec §6 : « au-dela,
    // bouton desactive »). Le proposer enverrait l'hote remplir un formulaire
    // dont la publication sera refusee.
    const bouton = A_FAIRE.has(e.status) && !depasse
      ? `<button type="button" data-evaluer="${echapper(e.booking_uid)}">Ouvrir</button>`
      : ''
    return `<li class="hs-eval-ligne${A_FAIRE.has(e.status) ? ' hs-eval-a-faire' : ''}">`
      + `<span class="hs-eval-bien">${echapper(e.bien || 'Bien inconnu')}</span>`
      + `<span class="hs-eval-etat">${echapper(ETAT_LISIBLE[e.status] || e.status)}</span>`
      + (e.publie_le ? `<span class="hs-eval-date">${echapper(dateFr(e.publie_le))}</span>` : '')
      + delai + bouton
      + `</li>`
  }).join('')

  return `<div class="hs-eval">${entete}`
    + (etat.message ? `<p class="hs-avis-erreur">${echapper(etat.message)}</p>` : '')
    + `<ul class="hs-eval-liste">${lignes}</ul></div>`
}

export { ETAT_LISIBLE, A_FAIRE }
