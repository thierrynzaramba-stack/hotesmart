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

// ─── « En resume » sur les 12 mois du calendrier (spec §18) ─────────────────
// PURE : la fenetre part de `premierMois` (AAAA-MM), fourni par l'appelant —
// aucune horloge ici. Rien de l'historique des ventes n'y entre.

// Les noms qu'AirROI laisse en anglais, en francais pour l'hote.
const NOMS_FR = { Easter: 'Pâques', 'Easter Monday': 'Lundi de Pâques', Christmas: 'Noël', "New Year's Day": "Jour de l'an" }
// Un nom combine par AirROI (« Christmas, Boxing Day ») se traduit morceau par morceau.
const nomFr = (nom) => String(nom).split(', ').map(n => NOMS_FR[n] || n).join(', ')

// 5c : lecture des niveaux AirROI sous les noms de la grille YieldFlow. ⚠ UNE
// LECTURE, PAS UN CALCUL CROISE : aucune donnee YieldFlow n'est lue. Pic
// correspond a deux niveaux et reste une seule ligne (§18.3).
const LECTURE_YIELDFLOW = [
  { niveau: 'creux', yieldflow: 'Base' },
  { niveau: 'modere', yieldflow: 'Moyen' },
  { niveau: 'favorable', yieldflow: 'Haut' },
  { niveau: 'pic', yieldflow: 'Très haut ou Exceptionnel' },
]

function moisPlus (m, n) {
  const [a, mm] = m.split('-').map(Number)
  const d = new Date(Date.UTC(a, mm - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function resumeDouzeMois (jours, premierMois, { nbMois = 12, couvertureMin = 0.25 } = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(premierMois || ''))) throw new Error(`[temperature-airroi] premierMois illisible : ${premierMois}`)
  const finExclue = moisPlus(premierMois, nbMois)
  const fenetre = jours.filter(j => j.jour.slice(0, 7) >= premierMois && j.jour.slice(0, 7) < finExclue)
  // Les jours que la fenetre DEVRAIT compter : une capture ancienne en couvre
  // moins, et le resume le dit (review de f229258) ; sous un quart, il se tait.
  const [a0, m0] = premierMois.split('-').map(Number)
  const joursFenetre = Math.round((Date.UTC(a0, m0 - 1 + nbMois, 1) - Date.UTC(a0, m0 - 1, 1)) / 86400000)
  const periode = { debut: premierMois, fin: moisPlus(premierMois, nbMois - 1), jours: fenetre.length, jours_fenetre: joursFenetre }
  if (!fenetre.length) return { statut: 'non_calculable', motif: 'aucun jour du modèle dans les 12 mois', periode }
  if (fenetre.length < joursFenetre * couvertureMin) return { statut: 'non_calculable', motif: `le modèle ne couvre que ${fenetre.length} jours sur ${joursFenetre}`, periode }

  // 5b : vendredi + samedi contre lundi → jeudi ; le DIMANCHE n'est d'aucun camp.
  const ecartsDe = (jdS) => fenetre.filter(j => jdS.includes(jourDeSemaine(j.jour))).map(j => j.ecart)
  const we = moyenne(ecartsDe([5, 6]))
  const sem = moyenne(ecartsDe([1, 2, 3, 4]))
  const parJour = NOMS_JOURS.map((nom, i) => ({ nom, m: moyenne(ecartsDe([i])) })).filter(x => x.m !== null)
  const tries = [...parJour].sort((a, b) => b.m - a.m)
  const diff = we !== null && sem !== null ? we - sem : null
  const semaine = {
    verdict: diff === null ? 'non_calculable' : diff > AVANTAGE_MIN ? 'week_end' : diff < -AVANTAGE_MIN ? 'semaine' : 'equilibre',
    meilleur: tries.length ? tries[0].nom : null,
    pire: tries.length ? tries[tries.length - 1].nom : null,
  }

  // 5c : combien de jours dans chaque niveau.
  const niveaux = LECTURE_YIELDFLOW.map(l => ({ ...l, jours: fenetre.filter(j => j.niveau === l.niveau).length }))

  // 5d : les occurrences qui tombent dans la fenetre ; RECURRENT si le nom
  // revient sur DEUX ANNEES de la capture — deux occurrences la meme annee ne
  // font pas un evenement recurrent (review de f229258).
  const tous = evenements(jours)
  const evts = []
  for (const e of tous) {
    for (const o of e.occurrences) {
      const dedans = o.debut.slice(0, 7) < finExclue && o.fin.slice(0, 7) >= premierMois
      if (!dedans) continue
      const ecarts = jours.filter(j => j.fete_nom === e.nom && j.jour >= o.debut && j.jour <= o.fin).map(j => j.ecart)
      evts.push({ nom: nomFr(e.nom), debut: o.debut, fin: o.fin, nuits: o.nuits, niveau: niveauDe(moyenne(ecarts)), recurrent: new Set(e.occurrences.map(x => x.debut.slice(0, 4))).size > 1 })
    }
  }
  evts.sort((a, b) => (a.debut < b.debut ? -1 : 1))
  return { statut: 'calcule', periode, semaine, niveaux, evenements: evts }
}

// ─── L'impact des vacances scolaires, zone par zone (spec §19) ──────────────
// PURE : les vacances (`school_holidays`, calendrier officiel du coeur) sont
// passees par l'appelant. Aucune donnee de vente n'entre ici.
// ⚠ UNE PERIODE = UNE OCCURRENCE D'UNE ANNEE SCOLAIRE (review de 7a11102) : une
// fenetre qui part de janvier voit la fin de Noel 2026 ET Noel 2027 ; les melanger
// faisait « differer » des dates pourtant communes aux trois zones.
const PERIODES_VACANCES = [
  { cle: 'toussaint', nom: 'Toussaint', motif: /\btoussaint\b/i },
  { cle: 'noel', nom: 'Noël', motif: /\bno[eë]l\b/i },
  { cle: 'hiver', nom: 'Hiver', motif: /\bhiver\b/i },
  { cle: 'printemps', nom: 'Printemps', motif: /\bprintemps\b/i },
  { cle: 'ete', nom: 'Été', motif: /(^|[^a-zà-ÿ])[eé]t[eé]($|[^a-zà-ÿ])/i },
]
const ZONES = ['A', 'B', 'C']
const JOUR_MS = 86400000
const sensDuDelta = (d) => (d === null ? null : d > AVANTAGE_MIN ? 'hausse' : d < -AVANTAGE_MIN ? 'baisse' : 'neutre')
// Un nom importe en forme decomposee (NFD) se lit comme en NFC.
const nomNfc = (v) => String((v && v.nom) || '').normalize('NFC')
// L'annee scolaire d'une entree : la sienne si la table la porte, sinon deduite
// (une periode qui commence d'aout a decembre ouvre l'annee scolaire).
const anneeScolaire = (v) => {
  if (v.annee_scolaire) return String(v.annee_scolaire)
  const a = Number(v.date_debut.slice(0, 4))
  return Number(v.date_debut.slice(5, 7)) >= 8 ? `${a}-${a + 1}` : `${a - 1}-${a}`
}
function joursEntre (debut, fin) {
  const out = []
  for (let t = Date.parse(`${debut}T12:00:00Z`); t <= Date.parse(`${fin}T12:00:00Z`); t += JOUR_MS) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}
// Seuils : un mois de comparaison compte au moins 7 jours de la periode (un
// janvier ou ne tombent que 3 jours de Noel ne sert pas de base) ; une
// occurrence se conclut si au moins la moitie de ses jours est dans la fenetre.
const JOURS_MOIS_BASE = 7
const PART_MIN_FENETRE = 0.5

function impactVacances (jours, vacances, premierMois, { nbMois = 12, connuesJusquau = null } = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(premierMois || ''))) throw new Error(`[temperature-airroi] premierMois illisible : ${premierMois}`)
  const finExclue = moisPlus(premierMois, nbMois)
  const debutFenetre = `${premierMois}-01`
  const finFenetre = new Date(Date.parse(`${finExclue}-01T12:00:00Z`) - JOUR_MS).toISOString().slice(0, 10)
  const fenetre = jours.filter(j => j.jour >= debutFenetre && j.jour <= finFenetre)
  // §19, review : jusqu'ou le calendrier des vacances est-il connu ? Au-dela,
  // les periodes manquent parce qu'elles ne sont pas publiees — on le dit.
  const couverture = connuesJusquau && connuesJusquau < finFenetre ? { connues_jusqu_au: connuesJusquau } : {}
  if (!fenetre.length) return { statut: 'non_calculable', motif: 'aucun jour du modèle dans les 12 mois', periodes: [], ...couverture }
  const parJour = new Map(fenetre.map(j => [j.jour, j]))
  const dans = (v, j) => j >= v.date_debut && j <= v.date_fin
  const valides = (vacances || []).filter(v => v && v.date_debut && v.date_fin && ZONES.includes(v.zone))
  // Une entree d'un seul jour n'est pas une periode (pont, « debut de l'ete »).
  const vraies = valides.filter(v => v.date_fin > v.date_debut)
  const enVacances = j => vraies.some(v => dans(v, j))
  const moyDe = js => moyenne(js.filter(j => parJour.has(j)).map(j => parJour.get(j).ecart))

  const periodes = []
  for (const p of PERIODES_VACANCES) {
    const toutes = valides.filter(v => p.motif.test(nomNfc(v)) && v.date_fin >= debutFenetre && v.date_debut <= finFenetre)
    // Les occurrences, par annee scolaire, dans l'ordre du calendrier.
    const occ = new Map()
    for (const v of toutes) { const a = anneeScolaire(v); if (!occ.has(a)) occ.set(a, []); occ.get(a).push(v) }
    for (const [annee, entrees] of [...occ.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      const base = { cle: p.cle, nom: p.nom, annee_scolaire: annee }
      const vs = entrees.filter(v => v.date_fin > v.date_debut)
      if (!vs.length) { periodes.push({ ...base, statut: 'debut_seulement' }); continue }
      const tousJours = [...new Set(vs.flatMap(v => joursEntre(v.date_debut, v.date_fin)))].sort()
      const dedans = tousJours.filter(j => j >= debutFenetre && j <= finFenetre)
      const part = dedans.length / tousJours.length
      if (part < PART_MIN_FENETRE) { periodes.push({ ...base, statut: 'hors_fenetre' }); continue }
      // Les mois de comparaison : ceux qui portent au moins 7 jours de la
      // periode ; a defaut, celui qui en porte le plus.
      const parMois = new Map()
      for (const j of tousJours) parMois.set(j.slice(0, 7), (parMois.get(j.slice(0, 7)) || 0) + 1)
      let mois = [...parMois.entries()].filter(([, n]) => n >= JOURS_MOIS_BASE).map(([m]) => m)
      if (!mois.length) mois = [[...parMois.entries()].sort((x, y) => y[1] - x[1])[0][0]]
      const hors = moyenne(fenetre.filter(j => mois.includes(j.jour.slice(0, 7)) && !enVacances(j.jour)).map(j => j.ecart))
      const pendant = moyDe(dedans)
      if (hors === null || pendant === null) {
        periodes.push({ ...base, statut: 'non_calculable', motif: hors === null ? 'aucun jour hors vacances dans les mêmes mois' : 'aucun jour de vacances mesuré' })
        continue
      }
      // Le NIVEAU du marche pendant la periode (demande de Thierry du 5 octobre
      // 2026) : la moyenne des ecarts de ses jours dans le calendrier AirROI,
      // classee comme un evenement (§18.4) — Creux, Modere, Favorable ou Pic.
      const entree = { ...base, statut: 'calcule', niveau: niveauDe(pendant), sens: sensDuDelta(pendant - hors), partielle: part < 1, zones: null, plus_porteuses: null }
      // Par zone : seulement si les dates DIFFERENT d'une zone a l'autre, dans
      // CETTE occurrence.
      if (new Set(vs.map(v => `${v.date_debut}/${v.date_fin}`)).size > 1) {
        const deltas = ZONES.map(z => {
          const js = vs.filter(v => v.zone === z).flatMap(v => joursEntre(v.date_debut, v.date_fin))
          const m = moyDe(js)
          return { zone: z, delta: m === null ? null : m - hors }
        })
        // Une zone absente ou sans jour mesure est « non mesuree », jamais « egale ».
        entree.zones = deltas.map(d => ({ zone: d.zone, sens: sensDuDelta(d.delta) }))
        const mesurees = deltas.filter(d => d.delta !== null)
        entree.zones_mesurees = mesurees.length
        // « Les plus porteuses » : seulement dans une periode qui porte le
        // marche, parmi les zones EN HAUSSE (review : une zone en baisse ne
        // « porte » rien).
        if (entree.sens === 'hausse' && mesurees.length > 1) {
          const max = Math.max(...mesurees.map(d => d.delta))
          const min = Math.min(...mesurees.map(d => d.delta))
          entree.plus_porteuses = max - min > AVANTAGE_MIN
            ? mesurees.filter(d => d.delta > AVANTAGE_MIN && max - d.delta < AVANTAGE_MIN).map(d => d.zone) : []
        }
      }
      periodes.push(entree)
    }
  }
  if (!periodes.length) return { statut: 'non_calculable', motif: 'aucune vacance scolaire publiée sur ces 12 mois', periodes: [], ...couverture }
  return { statut: 'calcule', periodes, ...couverture }
}

function resumeSur (jours, premierMois, vacances, connuesJusquau) {
  try {
    const r = resumeDouzeMois(jours, premierMois)
    // §19 : les vacances, si l'appelant les a lues ; illisibles, ce seul bloc le dit.
    if (r.statut === 'calcule') {
      r.vacances = vacances === undefined ? undefined
        : vacances === null ? { statut: 'non_calculable', motif: 'le calendrier des vacances scolaires est illisible', periodes: [] }
          : impactVacances(jours, vacances, premierMois, { connuesJusquau })
    }
    return r
  } catch (e) {
    console.error('[temperature-airroi] resume', e.message)
    return { statut: 'non_calculable', motif: 'le résumé est incalculable' }
  }
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
function pourLEcran ({ capture_le: captureLe, jours }, premierMois = null, vacances = undefined, connuesJusquau = null) {
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
    // §18 : seulement si l'appelant donne le mois de depart (l'API, a Paris).
    // Un resume en echec ne fait pas tomber le calendrier (review de f229258).
    ...(premierMois ? { resume: resumeSur(jours, premierMois, vacances, connuesJusquau) } : {}),
  }
}

module.exports = {
  METHODE, lireDerniereCapture, pourLEcran, SEUILS, NIVEAUX, NOM_NIVEAU, niveauDe, lireRelief, construireLignes, enregistrerTemperature,
  estWeekEnd, diagnosticMensuel, weekEndOuSemaine, evenements, suggestions, courbe,
  resumeDouzeMois, LECTURE_YIELDFLOW, impactVacances,
}
