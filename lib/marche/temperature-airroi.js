// lib/marche/temperature-airroi.js — LE PIPELINE AIRROI : le calendrier de
// temperature. Spec : docs/kb/chantier-nouveau-bien.md §15.
//
// ⚠ PIPELINE ETANCHE (decision de Thierry du 4 octobre 2026). Ce module ne lit
// QUE la reponse d'AirROI (`POST /price-recommendation/calendar-prices`, base
// 100). Rien de l'historique des ventes n'entre ici : l'historique a son propre
// pipeline (§14), et un module d'assemblage les reunira en aval.
//
// ⚠ AUCUN PRIX : les valeurs sont des facteurs en base 100. Le niveau d'un jour
// se lit sur son ECART a la base, en points.
//
// ⚠ `market_demand` EST EXCLU DE L'ECART (decision validee le 4 octobre) : il
// regarde devant lui depuis le jour de la capture et fausse les jours
// lointains. Il est garde a part, lisible dans le detail d'un jour.
//
// Seul writer de `marche_temperature_airroi` (migration
// 2026-10-04-marche-temperature-airroi.sql). Ajout seul.

// La version de la methode : a changer a chaque changement de regle qui deplace
// un niveau (seuils, composantes de l'ecart, definition du week-end).
const METHODE = 'airroi-t1-2026-10-04'

// Les 4 niveaux, sur l'ecart en points autour de la base 100 (§15.4).
const SEUILS = { creux: -3, favorable: 2, pic: 7 }
const NIVEAUX = ['creux', 'modere', 'favorable', 'pic']
const NOM_NIVEAU = { creux: 'Creux', modere: 'Modéré', favorable: 'Favorable', pic: 'Pic' }

function niveauDe (ecart) {
  if (!Number.isFinite(ecart)) throw new Error(`[temperature-airroi] ecart illisible : ${ecart}`)
  if (ecart < SEUILS.creux) return 'creux'
  if (ecart < SEUILS.favorable) return 'modere'
  if (ecart < SEUILS.pic) return 'favorable'
  return 'pic'
}

const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/
// Une date REELLE : « 2026-02-30 » a la bonne forme, mais n'existe pas.
const jourValide = (j) => JOUR_RE.test(String(j || '')) && new Date(`${j}T12:00:00Z`).toISOString().slice(0, 10) === j
// L'identite du modele : prix = 100 + les quatre composantes. Si elle ne tient
// plus, AirROI a change de format (une base qui n'est plus 100…) : on refuse.
const TOLERANCE = 0.02
const arrondi = (x) => Math.round(x * 100) / 100

// ─── La lecture de la reponse AirROI ────────────────────────────────────────
// Une reponse qu'on ne sait pas lire LEVE : un jour illisible ne devient pas
// un jour « modere » en silence.
function lireRelief (reponse) {
  const recos = reponse && Array.isArray(reponse.recommendations) ? reponse.recommendations : null
  if (!recos || !recos.length) throw new Error('[temperature-airroi] reponse sans aucune recommandation')
  const capture = reponse.coverage && reponse.coverage.calculation_date
  if (!JOUR_RE.test(String(capture || ''))) throw new Error('[temperature-airroi] date de calcul illisible')
  const vus = new Set()
  const jours = recos.map((r) => {
    if (!r || !jourValide(r.date)) throw new Error(`[temperature-airroi] jour illisible : ${r && r.date}`)
    if (vus.has(r.date)) throw new Error(`[temperature-airroi] jour en double : ${r.date}`)
    vus.add(r.date)
    // ⚠ `null` et '' valent 0 pour `Number` : un champ absent LEVE, il ne
    // devient pas un zero.
    const prix = r.price == null || r.price === '' ? NaN : Number(r.price)
    if (!Number.isFinite(prix)) throw new Error(`[temperature-airroi] prix illisible le ${r.date}`)
    const comp = (code) => {
      const e = (Array.isArray(r.explanation) ? r.explanation : []).find(x => x && x.code === code)
      if (!e) throw new Error(`[temperature-airroi] composante « ${code} » absente le ${r.date}`)
      const v = e.amount == null || e.amount === '' ? NaN : Number(e.amount)
      if (!Number.isFinite(v)) throw new Error(`[temperature-airroi] composante « ${code} » illisible le ${r.date}`)
      return { v, e }
    }
    const saison = comp('seasonality').v
    const semaine = comp('day_of_week').v
    const fete = comp('known_holiday_event')
    const demande = comp('market_demand').v
    if (Math.abs(100 + saison + semaine + fete.v + demande - prix) > TOLERANCE) {
      throw new Error(`[temperature-airroi] le ${r.date}, le prix ne vaut pas 100 + ses composantes : format AirROI change ?`)
    }
    const nomFete = Array.isArray(fete.e.details) && fete.e.details.length ? fete.e.details.join(', ') : null
    // L'ecart SANS la demande du marche : saison + jour de semaine + evenement.
    const ecart = arrondi(saison + semaine + fete.v)
    return {
      jour: r.date, prix_base100: prix, saison, semaine, fete: fete.v,
      fete_nom: nomFete, demande, ecart, niveau: niveauDe(ecart),
    }
  }).sort((a, b) => (a.jour < b.jour ? -1 : 1))
  return { capture_le: capture, jours }
}

// Les lignes a stocker, PURE.
function construireLignes ({ marche, reponse }) {
  const champs = ['country', 'region', 'locality']
  if (!marche || !champs.every(k => typeof marche[k] === 'string' && marche[k].trim())) {
    throw new Error('[temperature-airroi] marche illisible : pays, region et localite requis')
  }
  const { capture_le: captureLe, jours } = lireRelief(reponse)
  return jours.map(j => ({
    pays: marche.country, region: marche.region, localite: marche.locality,
    capture_le: captureLe, methode: METHODE, ...j,
  }))
}

// Le writer. Ajout seul, en UNE ecriture ; une capture deja stockee est
// refusee par la contrainte d'unicite, et c'est dit.
async function enregistrerTemperature (supabase, lignes) {
  if (!Array.isArray(lignes) || !lignes.length) throw new Error('[temperature-airroi] rien a enregistrer')
  const { error } = await supabase.from('marche_temperature_airroi').insert(lignes)
  if (error) {
    if (error.code === '23505') {
      throw new Error(`[temperature-airroi] capture du ${lignes[0].capture_le} deja stockee pour ${lignes[0].localite} (methode ${lignes[0].methode}) : rien n'est reecrit`)
    }
    throw new Error(`[temperature-airroi] ecriture : ${error.message}`)
  }
  return lignes.length
}

// ─── Les analyses (§15.5), PURES ────────────────────────────────────────────
// Elles prennent des jours { jour, ecart, niveau, fete_nom } et ne rendent
// jamais de prix.

// ⚠ LE WEEK-END, CE SONT LES NUITS DU VENDREDI ET DU SAMEDI (decision validee
// le 4 octobre : la regle de la page §14 et de la location courte). Le jour est
// lu en UTC a partir de « AAAA-MM-JJ » : aucun decalage de fuseau.
const NOMS_JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const jourDeSemaine = (jour) => new Date(`${jour}T12:00:00Z`).getUTCDay()
const estWeekEnd = (jour) => [5, 6].includes(jourDeSemaine(jour))
const moyenne = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const AVANTAGE_MIN = 1

function diagnosticMensuel (jours) {
  const parMois = new Map()
  for (const j of jours) {
    const m = j.jour.slice(0, 7)
    if (!parMois.has(m)) parMois.set(m, [])
    parMois.get(m).push(j)
  }
  return [...parMois.entries()].map(([mois, js]) => {
    const tous = moyenne(js.map(j => j.ecart))
    const we = moyenne(js.filter(j => estWeekEnd(j.jour)).map(j => j.ecart))
    const sem = moyenne(js.filter(j => !estWeekEnd(j.jour)).map(j => j.ecart))
    const diff = we !== null && sem !== null ? we - sem : 0
    return {
      mois,
      jours: js.length,
      niveau: niveauDe(tous),
      niveau_week_end: we === null ? null : niveauDe(we),
      niveau_semaine: sem === null ? null : niveauDe(sem),
      avantage: diff > AVANTAGE_MIN ? 'week_end' : diff < -AVANTAGE_MIN ? 'semaine' : 'egal',
      evenements: [...new Set(js.map(j => j.fete_nom).filter(Boolean))],
    }
  })
}

function weekEndOuSemaine (jours) {
  const parJour = NOMS_JOURS.map((nom, i) => {
    const m = moyenne(jours.filter(j => jourDeSemaine(j.jour) === i).map(j => j.ecart))
    return { jour_semaine: nom, niveau: m === null ? null : niveauDe(m), moyenne: m }
  }).filter(x => x.moyenne !== null)
  const tries = [...parJour].sort((a, b) => b.moyenne - a.moyenne)
  const mois = diagnosticMensuel(jours)
  const compte = (a) => mois.filter(m => m.avantage === a).length
  const we = moyenne(jours.filter(j => estWeekEnd(j.jour)).map(j => j.ecart))
  const sem = moyenne(jours.filter(j => !estWeekEnd(j.jour)).map(j => j.ecart))
  const diff = we !== null && sem !== null ? we - sem : 0
  return {
    // Lundi en tete, comme un calendrier francais.
    par_jour: [...parJour.slice(1), ...parJour.slice(0, 1)].map(({ jour_semaine, niveau }) => ({ jour_semaine, niveau })),
    meilleur: tries.length ? tries[0].jour_semaine : null,
    pire: tries.length ? tries[tries.length - 1].jour_semaine : null,
    mois_week_end: compte('week_end'),
    mois_semaine: compte('semaine'),
    mois_egaux: compte('egal'),
    verdict: diff > AVANTAGE_MIN ? 'week_end' : diff < -AVANTAGE_MIN ? 'semaine' : 'equilibre',
  }
}

// Les jours CONSECUTIFS portant le meme nom forment une occurrence.
function evenements (jours) {
  const parNom = new Map()
  let courante = null
  for (const j of jours) {
    const precedent = courante && new Date(`${courante.fin}T12:00:00Z`)
    const contigu = precedent && (new Date(`${j.jour}T12:00:00Z`) - precedent) === 86400000
    if (j.fete_nom && courante && courante.nom === j.fete_nom && contigu) {
      courante.fin = j.jour
      courante.ecarts.push(j.ecart)
      continue
    }
    courante = null
    if (!j.fete_nom) continue
    courante = { nom: j.fete_nom, debut: j.jour, fin: j.jour, ecarts: [j.ecart] }
    if (!parNom.has(j.fete_nom)) parNom.set(j.fete_nom, [])
    parNom.get(j.fete_nom).push(courante)
  }
  return [...parNom.entries()].map(([nom, occ]) => ({
    nom,
    niveau: niveauDe(moyenne(occ.flatMap(o => o.ecarts))),
    occurrences: occ.map(o => ({ debut: o.debut, fin: o.fin, nuits: o.ecarts.length })),
  })).sort((a, b) => (a.occurrences[0].debut < b.occurrences[0].debut ? -1 : 1))
}

// Les suggestions pour YieldFlow : AFFICHEES SEULEMENT (decision du 4 octobre),
// rien n'est ecrit dans les evenements du pilote.
const NOM_SAISON = { pic: 'Haute saison', favorable: 'Saison favorable', creux: 'Basse saison' }
function suggestions (jours) {
  const mois = diagnosticMensuel(jours)
  const saisons = []
  for (const m of mois) {
    const der = saisons[saisons.length - 1]
    if (der && der.niveau === m.niveau && der.suite === m.mois) { der.fin = m.mois; der.suite = moisSuivant(m.mois); continue }
    saisons.push({ niveau: m.niveau, debut: m.mois, fin: m.mois, suite: moisSuivant(m.mois) })
  }
  const saisonnieres = saisons.filter(s => s.niveau !== 'modere').map(s => ({
    nom: NOM_SAISON[s.niveau], type: 'saisonnier', debut: s.debut, fin: s.fin, niveau: s.niveau, recurrent: true,
  }))
  const ponctuels = evenements(jours).map(e => ({
    nom: e.nom, type: 'ponctuel', debut: e.occurrences[0].debut, fin: e.occurrences[0].fin,
    niveau: e.niveau, recurrent: e.occurrences.length > 1,
  }))
  return [...saisonnieres, ...ponctuels]
}
function moisSuivant (m) {
  const [a, mm] = m.split('-').map(Number)
  return mm === 12 ? `${a + 1}-01` : `${a}-${String(mm + 1).padStart(2, '0')}`
}

// La courbe : la moyenne mensuelle des ecarts, en points (jamais un prix).
function courbe (jours) {
  return diagnosticMensuel(jours).map(m => {
    const js = jours.filter(j => j.jour.startsWith(m.mois))
    return { mois: m.mois, ecart: arrondi(moyenne(js.map(j => j.ecart))) }
  })
}

// ─── La lecture pour l'ecran (lot T2) ───────────────────────────────────────
// ⚠ LE SEUL ENDROIT QUI LIT LA TABLE : le writer unique est aussi son lecteur,
// l'API passe par lui (garde « writer unique » des tests).
// ⚠ 1000, LE PLAFOND DE POSTGREST (revue de 9f3adf4) : au-dela, la reponse est
// tronquee SANS erreur. Une capture en compte 729 ; si elle atteint le plafond,
// on le dit au lieu de servir un calendrier ampute.
const PLAFOND_JOURS = 1000
async function lireDerniereCapture (supabase, marche) {
  const filtre = (q) => q.eq('pays', marche.pays).eq('region', marche.region).eq('localite', marche.localite).eq('methode', METHODE)
  const d = await filtre(supabase.from('marche_temperature_airroi').select('capture_le'))
    .order('capture_le', { ascending: false }).limit(1)
  if (d.error) return { erreur: d.error.message }
  const capture = (d.data || [])[0] && d.data[0].capture_le
  if (!capture) return { capture_le: null, jours: [] }
  const j = await filtre(supabase.from('marche_temperature_airroi').select('jour, ecart, niveau, fete_nom, saison, semaine, fete, demande'))
    .eq('capture_le', capture).order('jour', { ascending: true }).range(0, PLAFOND_JOURS - 1)
  if (j.error) return { erreur: j.error.message }
  // ⚠ UNE LECTURE TRONQUEE SE DIT : au plafond, des jours manqueraient en
  // silence (la regle des 1000 lignes de PostgREST, vecue sur bookings_snapshot).
  if ((j.data || []).length >= PLAFOND_JOURS) return { erreur: `lecture tronquee a ${PLAFOND_JOURS} jours` }
  const jours = (j.data || []).map(x => ({ ...x, ecart: Number(x.ecart), saison: Number(x.saison), semaine: Number(x.semaine), fete: Number(x.fete), demande: Number(x.demande) }))
  return { capture_le: capture, jours }
}

// Ce que l'ECRAN recoit (spec §15.6) : des niveaux, des sens, des noms, et
// l'ecart mensuel en points pour la courbe. ⚠ JAMAIS `prix_base100`, jamais une
// composante chiffree. Le SENS d'une composante : au-dela d'un demi-point.
const SEUIL_SENS = 0.5
const sens = (v) => (v > SEUIL_SENS ? 'haut' : v < -SEUIL_SENS ? 'bas' : 'neutre')
function pourLEcran ({ capture_le: captureLe, jours }) {
  return {
    capture_le: captureLe,
    seuils: { ...SEUILS },
    jours: jours.map(j => ({
      jour: j.jour, niveau: j.niveau, week_end: estWeekEnd(j.jour), evenement: j.fete_nom || null,
      sens: { saison: sens(j.saison), semaine: sens(j.semaine), evenement: sens(j.fete), demande: sens(j.demande) },
    })),
    mois: diagnosticMensuel(jours),
    week_end_ou_semaine: weekEndOuSemaine(jours),
    evenements: evenements(jours),
    suggestions: suggestions(jours),
    courbe: courbe(jours),
  }
}

module.exports = {
  METHODE, lireDerniereCapture, pourLEcran, SEUILS, NIVEAUX, NOM_NIVEAU, niveauDe, lireRelief, construireLignes, enregistrerTemperature,
  estWeekEnd, diagnosticMensuel, weekEndOuSemaine, evenements, suggestions, courbe,
}
