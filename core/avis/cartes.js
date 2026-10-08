// core/avis/cartes.js
// DOC : docs/kb/avis-voyageurs.md §14 (modif = MEME COMMIT)
//
// LA PAGE /avis : UNE CARTE PAR SEJOUR, POUR TOUS LES AVIS (recette de Thierry
// du 7 octobre 2026). Les compteurs en tete, puis trois sections :
//   1. En attente de notation — triees par delai restant ;
//   2. Recents — les 20 derniers jours ;
//   3. Anciens — repliee, lue seulement quand on l'ouvre.
//
// Chaque carte : en tete le voyageur, le bien, les dates, la plateforme et la
// prestataire ; le bloc « Son avis » (note, texte, classement proprete avec son
// menu de correction) ; le bloc « Notre avis » (texte, statut, origine).
//
// ⚠ L'ASSEMBLAGE EST AU SERVEUR (lib/avis/cartes.js, action `cartes`). Ici on
// affiche, et on ne decide d'aucun droit : le serveur revalide chaque geste.
// ⚠ ELLE N'OUVRE PAS LA FENETRE D'EVALUATION ELLE-MEME : le bus la fournit
// (`hsBus.ouvrir('avis.evaluer', …)`), comme l'ancienne liste.

const ECHAPPER = (t) => String(t == null ? '' : t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const ETAT_LISIBLE = {
  a_remplir: 'À remplir',
  soumise_prestataire: 'Remplie par la prestataire',
  a_valider: 'À valider',
  publiee: 'Publiée',
  echec_publication: 'Échec de publication',
  expiree: 'Expirée',
  abandonnee: 'Abandonnée',
  evaluee_ailleurs: 'Évaluée sur Airbnb',
}

const VERDICTS = [['positif', 'Propreté saluée'], ['remarque', 'Remarque propreté'], ['rien_signale', 'Propreté non évoquée']]
const LIB_VERDICT = Object.fromEntries(VERDICTS)
// Icones de pouce en SVG : lisibles quelle que soit la police (un emoji ne l'est pas).
const POUCE_HAUT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 21h4V9H2v12zM23 10a2 2 0 0 0-2-2h-6.3l1-4.6v-.3a1.5 1.5 0 0 0-.4-1L14 1 7.6 7.4A2 2 0 0 0 7 8.8V19a2 2 0 0 0 2 2h9a2 2 0 0 0 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7v-2z"/></svg>'
const POUCE_BAS = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 3h-4v12h4V3zM1 14a2 2 0 0 0 2 2h6.3l-1 4.6v.3a1.5 1.5 0 0 0 .4 1L10 23l6.4-6.4a2 2 0 0 0 .6-1.4V5a2 2 0 0 0-2-2H6a2 2 0 0 0-1.8 1.2l-3 7.1c-.1.2-.2.5-.2.7v2z"/></svg>'
const LIB_COURT = { '15j': 'sur 15 jours', '30j': 'sur 30 jours', '6mois': 'sur 6 mois', toujours: 'depuis toujours' }

// ⚠ UNE DATE DE SEJOUR (« 2026-09-21 ») SE LIT EN JOUR LOCAL : `new Date` la
// lirait en UTC, et un hote a l'ouest de l'UTC verrait la veille.
function dateFr (d, avecAnnee = false) {
  if (!d) return ''
  const jour = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d))
  const x = jour ? new Date(Number(jour[1]), Number(jour[2]) - 1, Number(jour[3])) : new Date(d)
  return isNaN(x) ? '' : x.toLocaleDateString('fr-FR', avecAnnee ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' })
}

function plateforme (p) {
  if (!p) return ['autre', 'Avis']
  if (p.cle === 'airbnb') return ['airbnb', 'Airbnb']
  if (p.cle === 'booking') return ['booking', 'Booking']
  if (p.cle === 'direct') {
    const s = { sms: 'SMS', email: 'Email', oral: 'De vive voix', message: 'Messagerie' }[p.source]
    return [p.source && s ? p.source === 'message' ? 'messagerie' : p.source : 'autre', s || 'Direct']
  }
  return ['autre', p.cle]
}

// Le classement proprete : le MENU seul quand on peut corriger, le badge seul
// sinon — jamais les deux, qui affichaient deux fois le meme libelle (point A).
function proprete (a, peutEcrire) {
  if (a.masque) return ''
  if (!a.analyse) return '<span class="badge-prop attente">Analyse en cours</span>'
  if (a.detecte) return a.verdict && LIB_VERDICT[a.verdict] ? `<span class="badge-prop ${a.verdict}">${LIB_VERDICT[a.verdict]}</span>` : ''
  const corrige = a.verdict_source === 'humain' ? '<span class="corrige">corrigé</span>' : ''
  if (!peutEcrire) return (a.verdict && LIB_VERDICT[a.verdict] ? `<span class="badge-prop ${a.verdict}">${LIB_VERDICT[a.verdict]}</span>` : '') + corrige
  const opts = VERDICTS.map(([v, l]) => `<option value="${v}"${a.verdict === v ? ' selected' : ''}>${l}</option>`).join('')
  return `<select class="requalif badge-prop ${ECHAPPER(a.verdict || '')}" data-requalif="${ECHAPPER(a.id)}" title="Corriger ce classement" aria-label="Classement propreté">${opts}</select>${corrige}`
}

function blocSonAvis (a, peutEcrire, i) {
  if (a.masque) {
    return '<div class="hs-carte-bloc"><span class="hs-carte-libelle">Son avis</span>'
      + '<p class="hs-carte-gris">Avis déposé, masqué par Airbnb jusqu’à votre évaluation.</p></div>'
  }
  const detection = a.detecte
    ? '<div class="bandeau-detecte"><span class="titre">Détecté dans un message</span><span>À confirmer avant d’être compté</span>'
      + (peutEcrire ? `<div class="actions"><button class="btn-mini ok" data-valider="${ECHAPPER(a.id)}" data-statut="confirme">Confirmer</button>`
        + `<button class="btn-mini" data-valider="${ECHAPPER(a.id)}" data-statut="ignore">Ignorer</button></div>` : '')
      + '</div>'
    : ''
  const texte = a.texte || ''
  const long = texte.length > 220
  return `<div class="hs-carte-bloc${a.detecte ? ' detecte' : ''}">${detection}`
    + `<div class="hs-carte-ligne"><span class="hs-carte-libelle">Son avis</span>`
    + (a.note != null ? `<span class="hs-carte-note">${ECHAPPER(a.note)}/10</span>` : '')
    + `${proprete(a, peutEcrire)}</div>`
    + (a.extrait ? `<div class="avis-extrait">« ${ECHAPPER(a.extrait)} »</div>` : '')
    + (texte
      ? `<p class="avis-texte${long ? ' replie' : ''}" id="txt-${i}">${ECHAPPER(texte)}</p>${long ? `<button class="avis-plus" data-plus="${i}">Voir tout</button>` : ''}`
      : '<p class="hs-carte-gris">Sans commentaire écrit.</p>')
    + '</div>'
}

function delai (j) {
  if (j === null || j === undefined) return ''
  // Un jour restant ou moins : moins de 24 h, c'est le dernier jour.
  if (j <= 1) return '<span class="hs-eval-urgent">dernier jour</span>'
  if (j <= 3) return `<span class="hs-eval-urgent">${j} jour${j > 1 ? 's' : ''} restant${j > 1 ? 's' : ''}</span>`
  return `<span class="hs-eval-delai">${j} jours restants</span>`
}

function blocNotreAvis (c, avecBus) {
  const e = c.evaluation
  const prenom = (c.voyageur && c.voyageur.prenom) || 'ce voyageur'
  if (!e) {
    return '<div class="hs-carte-bloc hs-carte-notre"><span class="hs-carte-libelle">Notre avis</span>'
      + '<p class="hs-carte-gris">Aucune évaluation du voyageur pour ce séjour.</p></div>'
  }
  const etat = ETAT_LISIBLE[e.etat] || e.etat
  const tete = `<div class="hs-carte-ligne"><span class="hs-carte-libelle">Notre avis</span>`
    + `<span class="hs-carte-etat">${ECHAPPER(etat)}${e.publie_le ? ` le ${ECHAPPER(dateFr(e.publie_le))}` : ''}</span>`
    + (e.evaluable ? delai(e.jours_restants) : '') + '</div>'
  // ⚠ L'ORIGINE TOUJOURS DITE quand il y a un avis (point B).
  const origine = e.origine ? `<p class="hs-carte-origine">${ECHAPPER(e.origine.libelle)}</p>` : ''
  const corps = e.texte
    ? `<p>« ${ECHAPPER(e.texte)} »</p>`
    : e.evaluable
      ? (avecBus ? `<button type="button" class="hs-eval-bouton" data-evaluer="${ECHAPPER(e.booking_uid)}">Évaluer ${ECHAPPER(prenom)}</button>` : '')
      : e.etat === 'expiree' ? '<p class="hs-carte-gris">Le délai d’évaluation est passé : Airbnb ne l’accepte plus.</p>' : ''
  return `<div class="hs-carte-bloc hs-carte-notre">${tete}${corps}${origine}</div>`
}

function carte (c, opts, n) {
  const [classe, libelle] = plateforme(c.plateforme)
  const v = c.voyageur
  const qui = v ? [v.prenom, v.nom].filter(Boolean).join(' ') : ''
  const sejour = c.arrivee && c.depart ? `du ${dateFr(c.arrivee)} au ${dateFr(c.depart, true)}`
    : c.depart ? `départ le ${dateFr(c.depart, true)}`
      : c.recu_le ? `reçu le ${dateFr(c.recu_le, true)}` : ''
  const infos = [c.bien || 'Bien inconnu', sejour, c.menage_par ? `ménage : ${c.menage_par}` : ''].filter(Boolean)
  const avis = c.avis.length
    ? c.avis.map((a, k) => blocSonAvis(a, opts.peutEcrire, `${n}-${k}`)).join('')
    : '<div class="hs-carte-bloc"><span class="hs-carte-libelle">Son avis</span><p class="hs-carte-gris">Pas encore reçu.</p></div>'
  return `<li class="hs-carte${c.section === 'attente' ? ' hs-carte-a-faire' : ''}" data-cle="${ECHAPPER(c.cle)}">`
    + `<div class="hs-carte-tete"><span class="hs-carte-qui">${ECHAPPER(qui || 'Voyageur')}</span>`
    + `<span class="badge-src ${classe}">${ECHAPPER(libelle)}</span></div>`
    + `<div class="hs-carte-infos">${infos.map(ECHAPPER).join(' · ')}</div>`
    + avis + blocNotreAvis(c, opts.avecBus)
    + '</li>'
}

const liste = (cartes, opts, base) => `<ul class="hs-cartes">${cartes.map((c, i) => carte(c, opts, `${base}${i}`)).join('')}</ul>`

export function rendreStats (s) {
  if (!s) return ''
  if (s.erreur) {
    return '<div class="stat-card alerte" style="grid-column:1/-1"><div class="stat-val">—</div>'
      + '<div class="stat-lab">Les compteurs n’ont pas pu être calculés. Rechargez pour réessayer.</div></div>'
  }
  const p = LIB_COURT[s.periode] || ''
  const moy = s.moyenne == null ? '—' : String(s.moyenne).replace('.', ',')
  return `<div class="stat-card"><div class="stat-val">${ECHAPPER(s.total)}</div><div class="stat-lab">avis reçus ${ECHAPPER(p)}</div></div>`
    + `<div class="stat-card"><div class="stat-val">${ECHAPPER(moy)}</div><div class="stat-lab">note moyenne sur 10${s.notes ? ` (${ECHAPPER(s.notes)} notes)` : ''}</div></div>`
    + `<div class="stat-card ${s.remarque > 0 ? 'alerte' : ''}"><div class="stat-val ratio"><span class="ratio-item pos">${POUCE_HAUT}${ECHAPPER(s.positif)}</span>`
    + `<span class="ratio-item neg">${POUCE_BAS}${ECHAPPER(s.remarque)}</span></div><div class="stat-lab">propreté saluée / remarques ${ECHAPPER(p)}</div></div>`
}

/**
 * @param data   reponse de `avis?action=cartes`
 * @param opts   { peutEcrire, avecBus, anciensOuverts }
 */
export function rendre (data, opts = {}) {
  const c = (data && data.cartes) || { attente: [], recents: [], anciens: null }
  const attente = c.attente || []
  const recents = c.recents || []
  const n = attente.length
  const resume = n ? `${n} évaluation${n > 1 ? 's' : ''} vous attend${n > 1 ? 'ent' : ''}.` : 'Rien ne vous attend.'
  const anciensTotal = Number(data && data.anciens_total) || 0
  const anciens = Array.isArray(c.anciens)
    ? (c.anciens.length ? liste(c.anciens, opts, 'a') : '<p class="hs-carte-gris">Aucun séjour plus ancien.</p>')
      + (data.anciens_tronques ? '<p class="hs-carte-gris">Les 500 séjours les plus récents seulement.</p>' : '')
    : '<p class="hs-carte-gris">Chargement…</p>'
  return `<p class="hs-eval-resume">${resume}</p>`
    + (data && data.liste_incomplete ? '<p class="hs-avis-erreur">La liste est incomplète : les séjours les plus anciens ne sont pas tous affichés.</p>' : '')
    + `<section class="hs-section"><h2>En attente de notation <span class="hs-compte">${n}</span></h2>`
    + (n ? liste(attente, opts, 'w') : '<p class="hs-carte-gris">Aucune évaluation à faire en ce moment.</p>') + '</section>'
    + `<section class="hs-section"><h2>Récents <span class="hs-sous">20 derniers jours</span></h2>`
    + (recents.length ? liste(recents, opts, 'r') : '<p class="hs-carte-gris">Aucun séjour ces 20 derniers jours.</p>') + '</section>'
    + `<details class="hs-section" data-anciens${opts.anciensOuverts ? ' open' : ''}><summary><h2>Anciens <span class="hs-compte">${anciensTotal}</span></h2></summary>`
    + anciens + '</details>'
}

/**
 * Monte la liste dans `conteneur`, les compteurs dans `zoneStats`.
 * @param options.appel       (chemin, methode?, corps?) → donnees ; LEVE sur echec
 * @param options.bus         hsBus, pour ouvrir la fenetre d'evaluation
 * @param options.peutEcrire  droit d'ecriture sur `avis` (confort : le serveur revalide)
 * @param options.filtres     () → { periode, bien }
 * @param options.surDonnees  rappel avec la reponse (biens, periodes) pour la page
 */
export async function monter (conteneur, options = {}) {
  if (!conteneur) throw new Error('[avis] les cartes exigent un conteneur')
  const { appel, bus = null, peutEcrire = false, filtres = () => ({}), surDonnees = () => {}, zoneStats = null } = options
  if (typeof appel !== 'function') throw new Error('[avis] les cartes exigent un appel')
  const etat = { data: null, anciensOuverts: false }
  const chemin = (anciens) => {
    const f = filtres() || {}
    return 'avis?action=cartes'
      + (f.periode ? `&periode=${encodeURIComponent(f.periode)}` : '')
      + (f.bien ? `&bien=${encodeURIComponent(f.bien)}` : '')
      + (anciens ? '&anciens=1' : '')
  }
  const afficher = () => {
    conteneur.innerHTML = rendre(etat.data, { peutEcrire, avecBus: Boolean(bus), anciensOuverts: etat.anciensOuverts })
    if (zoneStats) { zoneStats.innerHTML = rendreStats(etat.data && etat.data.stats); zoneStats.hidden = false }
  }
  async function charger () {
    try {
      etat.data = await appel(chemin(etat.anciensOuverts))
    } catch (err) {
      // ⚠ UN ECHEC SE DIT : une liste vide laisserait croire qu'il n'y a rien.
      conteneur.innerHTML = `<p class="hs-avis-erreur">${ECHAPPER(err && err.status === 403 ? 'Vous n’avez pas accès aux avis de ce compte.' : (err && err.message) || 'Avis illisibles')}</p>`
      if (zoneStats) zoneStats.hidden = true
      return false
    }
    surDonnees(etat.data)
    afficher()
    return true
  }

  conteneur.addEventListener('toggle', async (ev) => {
    const d = ev.target
    if (!d || !d.matches || !d.matches('[data-anciens]')) return
    etat.anciensOuverts = d.open
    if (d.open && !(etat.data && Array.isArray(etat.data.cartes.anciens))) await charger()
  }, true)
  conteneur.addEventListener('change', async (ev) => {
    const id = ev.target && ev.target.dataset && ev.target.dataset.requalif
    if (!id) return
    ev.target.disabled = true
    try { await appel('avis', 'POST', { action: 'requalifier', id, verdict: ev.target.value }) } catch (err) { window.alert((err && err.message) || 'Correction impossible.') }
    // On RELIT dans tous les cas : en echec, l'ecran ne garde pas un choix que la base n'a pas.
    await charger()
  })
  conteneur.addEventListener('click', async (ev) => {
    const t = ev.target
    if (!t || !t.dataset) return
    if (t.dataset.valider) {
      if (t.disabled) return
      t.disabled = true
      try { await appel('avis', 'POST', { action: 'valider', id: t.dataset.valider, statut: t.dataset.statut }); await charger() } catch (err) { t.disabled = false; window.alert((err && err.message) || 'Action impossible.') }
      return
    }
    if (t.dataset.plus) {
      const p = conteneur.ownerDocument.getElementById(`txt-${t.dataset.plus}`)
      if (p) p.classList.remove('replie')
      t.remove()
      return
    }
    if (t.dataset.evaluer) {
      // ⚠ PAR LE BUS, TOUJOURS. Sans bus, le bouton n'est pas propose.
      if (!bus) return
      const r = await bus.ouvrir('avis.evaluer', { booking_uid: t.dataset.evaluer })
      if (!r || r.ok !== true) { window.alert('L’évaluation n’est pas disponible pour ce séjour.'); return }
      // Au retour de la fenetre, l'etat a pu changer : on relit.
      await charger()
    }
  })

  const ok = await charger()
  return { charge: ok, recharger: charger }
}

export { ETAT_LISIBLE }
