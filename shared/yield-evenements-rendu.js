// shared/yield-evenements-rendu.js — LE RENDU DE « CE QUI FAIT BOUGER VOS PRIX ».
// Lot 4 du chantier, sous-lot 4a, étape 2 (lecture seule).
// Spec : docs/specs/spec-yf-ecran-evenements.md §5, §6, §9 et §12.
// La page : apps/yield/evenements.html. Les données : GET /api/ecran/evenements.
//
// ⚠ FONCTIONS PURES : ni réseau, ni horloge, ni DOM. Elles reçoivent la réponse
// de l'appel d'écran et rendent du HTML. Les tests les appellent directement.
//
// ⚠ AUCUN CALCUL DE PRIX NI DE POSITION ICI. Le niveau et le prix de chaque
// nuit viennent du serveur (`prixDeLaNuit`, la porte du moteur) ; la position
// de chaque nuit aussi (`positions`, `week_ends`). Ce module RANGE et MONTRE.
//
// ⚠ RÈGLES V5 : aucun hexa, aucun texte en dur (tout passe par `t`), et le
// niveau colore la PASTILLE ou la CASE, jamais la ligne (règle 1 de Thierry) ;
// le CHIFFRE du niveau est toujours écrit (règle 2) : « 3 · Haut ».

export const NIVEAUX = ['Base', 'Moyen', 'Haut', 'Très haut', 'Exceptionnel']
export const rangNiveau = nom => NIVEAUX.indexOf(nom)

const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
const JOUR_MS = 86400000

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const enMs = iso => Date.parse(`${iso}T00:00:00Z`)
const versIso = ms => new Date(ms).toISOString().slice(0, 10)
const decaler = (iso, n) => versIso(enMs(iso) + n * JOUR_MS)
// 0 = lundi … 6 = dimanche
const jourSemaine = iso => (new Date(enMs(iso)).getUTCDay() + 6) % 7
// Une date ISO lue comme un jour LOCAL, pour l'afficher (I18n.date).
const dateLocale = iso => { const [a, m, j] = iso.split('-').map(Number); return new Date(a, m - 1, j) }

/** « 3 · Haut » — le chiffre d'abord, toujours (règle 2). */
export function etiquetteNiveau (nom, t) {
  const i = rangNiveau(nom)
  return i < 0 ? '' : `${i + 1} · ${t('yfe.niveau_' + (i + 1))}`
}
/** La classe de la pastille d'un niveau (shared/yield-evenements.css). */
export const classeNiveau = nom => (rangNiveau(nom) < 0 ? 'yfe-niv' : `yfe-niv yfe-niv--${rangNiveau(nom) + 1}`)

/** Le nom affiché d'un événement : le nom brut du serveur, composé selon son type. */
export function nomEvenement (e, t) {
  const nom = e.nom || e.cle
  if (e.type === 'vacances_zone') return t('yfe.nom_vacances_zone', { nom })
  if (e.type === 'vacances_autre') return t('yfe.nom_vacances_autre', { nom })
  if (e.type === 'pont') return t('yfe.nom_pont', { nom })
  if (e.type === 'week_end_prolonge') return t('yfe.nom_week_end_prolonge', { nom })
  return nom
}

/** Les nuits de la réponse, rangées par date. */
export const indexerNuits = nuits => new Map((nuits || []).map(n => [n.date, n]))

// Le niveau le plus fréquent d'une liste ; à égalité, le plus haut.
function modeNiveau (noms) {
  const compte = new Map()
  for (const n of noms) if (rangNiveau(n) >= 0) compte.set(n, (compte.get(n) || 0) + 1)
  let meilleur = null
  for (const [n, c] of compte) {
    if (!meilleur || c > compte.get(meilleur) || (c === compte.get(meilleur) && rangNiveau(n) > rangNiveau(meilleur))) meilleur = n
  }
  return meilleur
}

/**
 * LE TITRE D'UNE PÉRIODE = SON NIVEAU, RÉGLAGES PAR NUIT COMPRIS (spec §6 :
 * l'ancien écran calculait le titre sans les nuits posées à la main).
 * Le week-end, ce sont les nuits de vendredi et de samedi (registre §3).
 * @returns { semaine, weekend, max, regle } — `regle` : une nuit de l'événement
 *          ou de son rayonnement porte un réglage de CET événement.
 */
export function resumeEvenement (e, idx) {
  const semaine = []
  const weekend = []
  let max = null
  for (const d of e.nuits || []) {
    const n = idx.get(d)
    if (!n || rangNiveau(n.niveau) < 0) continue
    const j = jourSemaine(d)
    ;(j === 4 || j === 5 ? weekend : semaine).push(n.niveau)
    if (max === null || rangNiveau(n.niveau) > rangNiveau(max)) max = n.niveau
  }
  const regle = (e.positions || []).some(p => { const n = idx.get(p.date); return !!(n && n.regle && n.regle.cle === e.cle) })
  return { semaine: modeNiveau(semaine), weekend: modeNiveau(weekend), max, regle }
}

/** Les mois de la fenêtre (le 13e partiel compris), placés en % de la frise. */
export function moisDeLaFenetre (fenetre) {
  const total = (enMs(fenetre.fin) - enMs(fenetre.debut)) / JOUR_MS + 1
  const out = []
  let cur = `${fenetre.debut.slice(0, 7)}-01`
  while (cur <= fenetre.fin) {
    const [a, m] = cur.split('-').map(Number)
    const suivant = versIso(Date.UTC(a, m, 1))
    const d0 = cur < fenetre.debut ? fenetre.debut : cur
    out.push({ cle: cur.slice(0, 7), date: dateLocale(cur), gauche: (enMs(d0) - enMs(fenetre.debut)) / JOUR_MS / total * 100 })
    cur = suivant
  }
  return out
}

/**
 * LA FRISE : une barre par événement pris en compte, placée au jour près, sur
 * des couloirs qui ne se chevauchent pas. Couleur = le niveau le plus haut de
 * ses nuits (la maquette).
 */
export function barresDeLaFrise (evenements, idx, fenetre) {
  const total = (enMs(fenetre.fin) - enMs(fenetre.debut)) / JOUR_MS + 1
  const couloirs = []
  const out = []
  for (const e of [...evenements].filter(x => x.actif).sort((a, b) => a.debut.localeCompare(b.debut))) {
    const a = Math.max(0, (enMs(e.debut) - enMs(fenetre.debut)) / JOUR_MS)
    const b = Math.min(total, (enMs(e.fin) - enMs(fenetre.debut)) / JOUR_MS + 1)
    if (b <= 0 || a >= total) continue
    // ⚠ LA FIN D'UNE BARRE EST CELLE QU'ON DESSINE, PAS CELLE DES NUITS : une
    // date d'une nuit s'élargit à 1,2 % pour rester cliquable, et c'est cette
    // largeur qui doit tenir le couloir (sinon l'Ascension et la Victoire 1945,
    // à deux jours l'une de l'autre, se recouvraient).
    const largeur = Math.max(1.2, (b - a) / total * 100)
    const finDessinee = a + largeur / 100 * total
    let c = couloirs.findIndex(fin => fin <= a - 1)
    if (c < 0) { c = couloirs.length; couloirs.push(0) }
    couloirs[c] = finDessinee
    out.push({ e, couloir: c, gauche: a / total * 100, largeur, niveau: resumeEvenement(e, idx).max })
  }
  return { barres: out, couloirs: couloirs.length }
}

/** Les événements rangés par mois de leur première nuit dans la fenêtre. */
export function groupesParMois (evenements, fenetre, filtre = 'tous') {
  const groupes = new Map()
  for (const e of evenements) {
    if (filtre !== 'tous' && e.famille !== filtre) continue
    const d = e.debut < fenetre.debut ? fenetre.debut : e.debut
    const cle = d.slice(0, 7)
    if (!groupes.has(cle)) groupes.set(cle, [])
    groupes.get(cle).push(e)
  }
  return [...groupes.entries()].sort((x, y) => x[0].localeCompare(y[0]))
    .map(([cle, liste]) => ({ cle, date: dateLocale(`${cle}-01`), evenements: liste }))
}

/**
 * LE CALENDRIER D'UN ÉVÉNEMENT OUVERT : des semaines entières, lundi →
 * dimanche (la maquette). Il montre les nuits de l'événement, les week-ends de
 * la zone AFFICHÉE (la largeur posée ; sans largeur, aucun), et toute nuit
 * réglée par cet événement au-delà de la zone — la décision A du 7 novembre
 * 2026 interdit qu'un prix réglé soit hors de la vue de l'hôte.
 * @returns [{ debut, fin, jours: [{ date, zone, nuit }] }]
 *   zone : 'evenement' | 'rayonnement' | 'hors_zone' | 'hors'
 */
export function semainesDeLEvenement (e, idx) {
  const avant = Number.isInteger(e.largeur && e.largeur.avant) ? e.largeur.avant : 0
  const apres = Number.isInteger(e.largeur && e.largeur.apres) ? e.largeur.apres : 0
  const dedans = new Set(e.nuits || [])
  const zoneDe = new Map()
  for (const w of e.week_ends || []) {
    const affiche = w.rang <= (w.zone === 'avant' ? avant : apres)
    for (const d of w.nuits) zoneDe.set(d, affiche ? 'rayonnement' : 'hors_zone')
  }
  const montrees = [...dedans]
  for (const [d, z] of zoneDe) {
    const n = idx.get(d)
    if (z === 'rayonnement' || (n && n.regle && n.regle.cle === e.cle)) montrees.push(d)
  }
  if (!montrees.length) return []
  montrees.sort()
  let debut = decaler(montrees[0], -2)
  let fin = decaler(montrees[montrees.length - 1], 2)
  debut = decaler(debut, -jourSemaine(debut))
  fin = decaler(fin, 6 - jourSemaine(fin))
  const semaines = []
  for (let lundi = debut; lundi <= fin; lundi = decaler(lundi, 7)) {
    const jours = []
    for (let i = 0; i < 7; i++) {
      const date = decaler(lundi, i)
      const zone = dedans.has(date) ? 'evenement' : (zoneDe.get(date) || 'hors')
      jours.push({ date, zone, nuit: idx.get(date) || null })
    }
    semaines.push({ debut: lundi, fin: decaler(lundi, 6), jours })
  }
  return semaines
}

/** Le libellé d'une ligne de réglage par position (« le 2e samedi »…). */
export function libellePosition (l, t, jourLong) {
  if (l.nuit) return t('yfe.pos_nuit_' + l.nuit)
  const jour = l.jour ? jourLong(l.jour) : null
  if (l.zone === 'evenement') return l.rang && jour ? t('yfe.pos_evenement', { rang: l.rang, jour }) : t('yfe.pos_tout')
  const sens = l.zone === 'avant' ? 'avant' : 'apres'
  if (!l.rang) return t('yfe.pos_' + sens + '_sans_rang')
  return jour ? t('yfe.pos_' + sens + '_jour', { rang: l.rang, jour }) : t('yfe.pos_' + sens, { rang: l.rang })
}

// ─── Le HTML ────────────────────────────────────────────────────────────────

/**
 * @param fmt { t, money(n), date(Date, opts), heure(Date) }
 */
export function rendreLegende (niveaux, motif, fmt) {
  if (!niveaux || !niveaux.length) return `<p class="yfe-alerte">${esc(fmt.t('yfe.niveaux_non_calculables'))}</p>`
  return niveaux.map(n => `<span class="${classeNiveau(n.nom)} yfe-niv--legende">${esc(etiquetteNiveau(n.nom, fmt.t))} <span class="yfe-niv__prix num">${esc(fmt.money(n.prix))}</span></span>`).join('')
}

export function rendreFrise (data, idx, ouvert, fmt) {
  const mois = moisDeLaFenetre(data.fenetre)
  const { barres, couloirs } = barresDeLaFrise(data.evenements || [], idx, data.fenetre)
  const etiquettes = mois.map(m => `<span class="yfe-frise__mois" style="inset-inline-start:${m.gauche.toFixed(3)}%">${esc(fmt.date(m.date, { month: 'short' }))}</span>`).join('')
  const traits = mois.map(m => `<span class="yfe-frise__trait" style="inset-inline-start:${m.gauche.toFixed(3)}%"></span>`).join('')
  const lignes = barres.map(b => {
    const nom = nomEvenement(b.e, fmt.t)
    const id = idEvenement(b.e)
    return `<button type="button" class="${classeNiveau(b.niveau)} yfe-barre" data-ouvrir="${esc(id)}" aria-pressed="${ouvert === id}"`
      + ` style="inset-inline-start:${b.gauche.toFixed(3)}%;width:${b.largeur.toFixed(3)}%;top:${b.couloir * 22 + 4}px"`
      + ` title="${esc(nom)}" aria-label="${esc(fmt.t('yfe.ouvrir_aria', { nom }))}">${esc(nom)}</button>`
  }).join('')
  return `<div class="yfe-frise__mois-ligne">${etiquettes}</div>`
    + `<div class="yfe-frise__piste" style="height:${Math.max(1, couloirs) * 22 + 8}px">${traits}${lignes}</div>`
}

/** L'identifiant d'un événement dans la page (une clé peut revenir deux années). */
export const idEvenement = e => `${e.cle}|${e.debut}`

function resumeHtml (r, fmt) {
  if (!r.max) return `<span class="yfe-resume muted">${esc(fmt.t('yfe.non_calculable'))}</span>`
  const pastille = (nom, cle) => `<span class="${classeNiveau(nom)}">${esc(cle ? fmt.t(cle, { niveau: etiquetteNiveau(nom, fmt.t) }) : etiquetteNiveau(nom, fmt.t))}</span>`
  if (r.semaine && r.weekend && r.semaine !== r.weekend) return pastille(r.semaine, 'yfe.semaine') + pastille(r.weekend, 'yfe.weekend')
  return pastille(r.semaine || r.weekend || r.max)
}

function datesHtml (e, fmt) {
  const opts = { day: 'numeric', month: 'short', year: 'numeric' }
  const debut = fmt.date(dateLocale(e.debut), opts)
  const n = (e.nuits || []).length
  const quand = e.debut === e.fin ? debut : fmt.t('yfe.dates', { debut, fin: fmt.date(dateLocale(e.fin), opts) })
  return `${quand} · ${fmt.t('yfe.nuits', { n })}`
}

function crans (n, fmt) {
  const signe = n > 0 ? '+' : n < 0 ? '−' : ''
  return signe + fmt.t('yfe.crans', { n: Math.abs(n) })
}

function rendreJour (j, e, fmt) {
  const d = dateLocale(j.date)
  const num = d.getDate()
  const mois = num === 1 || jourSemaine(j.date) === 0 ? fmt.date(d, { month: 'short' }) : ''
  const n = j.nuit
  const classes = ['yfe-jour', 'yfe-jour--' + j.zone]
  const titre = [fmt.date(d, { weekday: 'long', day: 'numeric', month: 'long' })]
  let corps = ''
  if (!n) {
    classes.push('yfe-jour--vide')
    titre.push(fmt.t('yfe.hors_periode'))
    corps = `<span class="yfe-jour__vide">${esc(fmt.t('yfe.hors_periode'))}</span>`
  } else if (rangNiveau(n.niveau) < 0) {
    titre.push(fmt.t('yfe.non_calculable'))
    corps = `<span class="yfe-jour__vide">${esc(fmt.t('yfe.non_calculable'))}</span>`
  } else {
    titre.push(etiquetteNiveau(n.niveau, fmt.t) + (n.prix != null ? ' · ' + fmt.money(n.prix) : ''))
    corps = `<span class="${classeNiveau(n.niveau)}">${esc(etiquetteNiveau(n.niveau, fmt.t))}</span>`
      + (n.prix != null ? `<span class="yfe-jour__prix num">${esc(fmt.money(n.prix))}</span>` : '')
  }
  const marques = []
  if (n && n.regle && n.regle.cle === e.cle) {
    classes.push('yfe-jour--regle')
    marques.push(fmt.t('yfe.regle_court'))
    if (n.sans_reglage && n.sans_reglage.niveau) {
      titre.push(fmt.t('yfe.sans_reglage', { niveau: etiquetteNiveau(n.sans_reglage.niveau, fmt.t), prix: n.sans_reglage.prix != null ? fmt.money(n.sans_reglage.prix) : '—' }))
    }
    if (n.regle.hors_zone_affichee) titre.push(fmt.t('yfe.hors_zone_titre'))
  } else if (n && n.regle) {
    // Réglée, mais par un AUTRE événement (le réveillon dans les vacances de
    // Noël) : la nuit le dit, pour que l'hôte sache où la régler.
    titre.push(fmt.t('yfe.regle_ailleurs'))
  }
  if (n && n.prix_hote != null) {
    marques.push(fmt.t('yfe.prix_main', { prix: fmt.money(n.prix_hote) }))
    titre.push(fmt.t('yfe.prix_main_titre', { prix: fmt.money(n.prix_hote) }))
  }
  if (n && n.vendue) { marques.push(fmt.t('yfe.vendue')); titre.push(fmt.t('yfe.vendue')) }
  return `<div class="${classes.join(' ')}" title="${esc(titre.join(' · '))}">`
    + `<span class="yfe-jour__tete"><span class="yfe-jour__num num">${num}</span><span class="yfe-jour__mois">${esc(mois)}</span></span>`
    + `<span class="yfe-jour__corps">${corps}</span>`
    + (marques.length ? `<span class="yfe-jour__marques">${marques.map(m => `<span>${esc(m)}</span>`).join('')}</span>` : '')
    + `</div>`
}

function rendreCalendrier (e, idx, fmt) {
  const semaines = semainesDeLEvenement(e, idx)
  if (!semaines.length) return ''
  const lundi = semaines[0].debut
  const tete = Array.from({ length: 7 }, (_, i) => `<span>${esc(fmt.date(dateLocale(decaler(lundi, i)), { weekday: 'short' }))}</span>`).join('')
  const corps = semaines.map(s => {
    const etiquette = fmt.t('yfe.semaine_du', { debut: fmt.date(dateLocale(s.debut), { day: 'numeric', month: 'short' }), fin: fmt.date(dateLocale(s.fin), { day: 'numeric', month: 'short' }) })
    return `<span class="yfe-cal__sep">${esc(etiquette)}</span><div class="yfe-cal__semaine">${s.jours.map(j => rendreJour(j, e, fmt)).join('')}</div>`
  }).join('')
  return `<div class="yfe-cal"><div class="yfe-cal__tete">${tete}</div>${corps}</div>`
}

function rendreSansNuit (e, data, fmt, jourLong) {
  const rp = data.reglages_position || {}
  const lignes = new Map((rp.lignes || []).map(l => [l.id, l]))
  const miennes = (rp.sans_nuit || []).filter(x => x.cle === e.cle && (!x.occurrence || x.occurrence.debut === e.debut))
  if (!miennes.length) return ''
  const items = miennes.map(x => {
    const l = lignes.get(x.ligne)
    const quoi = l ? libellePosition(l, fmt.t, jourLong) : ''
    return `<li>${esc(quoi)} — ${esc(fmt.t('yfe.motif_' + x.motif))}</li>`
  }).join('')
  return `<div class="yfe-sans-nuit"><p class="small">${esc(fmt.t('yfe.sans_nuit_titre'))}</p><ul>${items}</ul></div>`
}

/**
 * La liste, par mois. `ouvert` : l'identifiant de l'événement déplié, ou null.
 * @param jourLong (nomFrancaisDuJour) → nom du jour dans la langue de la page
 */
export function rendreListe (data, idx, ui, fmt, jourLong) {
  const groupes = groupesParMois(data.evenements || [], data.fenetre, ui.filtre)
  if (!groupes.length) return `<p class="muted">${esc(fmt.t((data.evenements || []).length ? 'yfe.aucun_dans_filtre' : 'yfe.vide'))}</p>`
  return groupes.map(g => {
    const cartes = g.evenements.map(e => {
      const id = idEvenement(e)
      const ouvert = ui.ouvert === id
      const r = resumeEvenement(e, idx)
      const badges = [`<span class="yfe-badge">${esc(fmt.t('yfe.famille_' + e.famille))}</span>`]
      if (r.regle) badges.push(`<span class="yfe-badge yfe-badge--regle">${esc(fmt.t('yfe.regle_par_vous'))}</span>`)
      if (!e.actif) badges.push(`<span class="yfe-badge">${esc(fmt.t('yfe.coupe'))}</span>`)
      let detail = ''
      if (ouvert) {
        const avant = e.reglage_d_avant
          ? `<p class="small">${esc(fmt.t(e.reglage_d_avant.partage ? 'yfe.crans_avant_partage' : 'yfe.crans_avant', { crans: crans(e.reglage_d_avant.crans, fmt) }))}</p>` : ''
        const legende = `<p class="yfe-legende-zones caption"><span class="yfe-lz yfe-lz--evenement"></span>${esc(fmt.t('yfe.legende_evenement'))}`
          + `<span class="yfe-lz yfe-lz--rayonnement"></span>${esc(fmt.t('yfe.legende_rayonnement'))}`
          + `<span class="yfe-lz yfe-lz--regle"></span>${esc(fmt.t('yfe.legende_regle'))}</p>`
        detail = `<div class="yfe-ev__detail">`
          + (e.actif ? legende + rendreCalendrier(e, idx, fmt) : `<p class="muted small">${esc(fmt.t('yfe.coupe_detail'))}</p>`)
          + avant + rendreSansNuit(e, data, fmt, jourLong) + `</div>`
      }
      return `<article class="yfe-ev${ouvert ? ' yfe-ev--ouvert' : ''}" data-ev="${esc(id)}">`
        + `<button type="button" class="yfe-ev__tete" data-ouvrir="${esc(id)}" aria-expanded="${ouvert}">`
        + `<span class="yfe-ev__titre"><span class="yfe-ev__nom">${esc(nomEvenement(e, fmt.t))}</span>${badges.join('')}</span>`
        + `<span class="yfe-ev__dates small muted">${esc(datesHtml(e, fmt))}</span>`
        + `<span class="yfe-ev__resume">${e.actif ? resumeHtml(r, fmt) : ''}</span>`
        + `</button>${detail}</article>`
    }).join('')
    return `<section class="yfe-mois"><h2 class="yfe-mois__titre">${esc(fmt.date(g.date, { month: 'long', year: 'numeric' }))}</h2>${cartes}</section>`
  }).join('')
}

/** Le nom d'un jour (« samedi ») dans la langue de la page, par une date de référence. */
export function jourLongPar (date) {
  // Le lundi 3 janvier 2028 : une référence quelconque, seul le jour compte.
  return jour => {
    const i = JOURS.indexOf(jour)
    return i < 0 ? jour : date(new Date(2028, 0, 3 + i), { weekday: 'long' })
  }
}

/** Ce qu'on garde dans le cache du navigateur : jamais l'état d'une nuit (vendue, ouverte, ✎). */
export function pourLeCache (data) {
  if (!data || !Array.isArray(data.nuits)) return data
  return { ...data, nuits: data.nuits.map(({ vendue, ouverte, prix_hote, prix_calendrier, ...reste }) => reste) }
}
