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
  a_remplir: 'A remplir',
  soumise_prestataire: 'Remplie par la prestataire',
  a_valider: 'A valider',
  publiee: 'Publiee',
  echec_publication: 'Echec de publication',
  expiree: 'Delai depasse',
  abandonnee: 'Abandonnee',
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
    conteneur.innerHTML = '<p class="hs-avis-attente">Chargement des evaluations…</p>'
    try {
      const data = await appel(`avis?action=evaluations${etat.filtre ? `&etat=${encodeURIComponent(etat.filtre)}` : ''}`)
      etat.evaluations = data.evaluations || []
    } catch (err) {
      // ⚠ UN ECHEC SE DIT. Une section vide laisserait croire qu'il n'y a rien
      // a evaluer — le contraire de ce qu'on sait.
      conteneur.innerHTML = `<p class="hs-avis-erreur">${echapper(err.message || 'Evaluations illisibles')}</p>`
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
        etat.message = 'L evaluation n est pas disponible pour ce sejour.'
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
  const aFaire = liste.filter(e => A_FAIRE.has(e.status))

  const filtres = ['', 'a_remplir', 'a_valider', 'publiee', 'echec_publication', 'expiree']
    .map(v => `<option value="${v}"${etat.filtre === v ? ' selected' : ''}>`
      + (v === '' ? 'Toutes' : echapper(ETAT_LISIBLE[v] || v)) + '</option>').join('')

  const entete = `<div class="hs-eval-entete">`
    + `<h2>Evaluations du voyageur</h2>`
    + `<label class="hs-eval-filtre"><span>Afficher</span><select data-filtre>${filtres}</select></label>`
    + `</div>`
    + `<p class="hs-eval-resume">`
    + (aFaire.length
      ? `${aFaire.length} evaluation(s) vous attendent.`
      : liste.length ? 'Rien ne vous attend.' : 'Aucune evaluation pour le moment.')
    + `</p>`

  if (!liste.length) {
    return `<div class="hs-eval">${entete}`
      + `<p class="hs-eval-vide">Les evaluations apparaissent le jour du depart du voyageur, `
      + `quand la plateforme ouvre l avis. Airbnb seulement pour l instant.</p></div>`
  }

  const lignes = liste.map(e => {
    const j = joursRestants(e.echeance, maintenant)
    // ⚠ UNE ECHEANCE DEPASSEE NE S'AFFICHE PAS EN « -3 jours ». Le statut le dit
    // deja, et un nombre negatif se lit comme un bug.
    const delai = e.status === 'publiee' || e.status === 'expiree' || e.status === 'abandonnee'
      ? ''
      : j === null ? ''
        : j <= 0 ? `<span class="hs-eval-urgent">dernier jour</span>`
          : j <= 3 ? `<span class="hs-eval-urgent">${j} jour${j > 1 ? 's' : ''}</span>`
            : `<span class="hs-eval-delai">${j} jours</span>`
    const bouton = A_FAIRE.has(e.status)
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
