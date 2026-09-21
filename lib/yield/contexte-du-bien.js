// lib/yield/contexte-du-bien.js — TOUT CE QUI FAIT LE PRIX D'UN BIEN, LU UNE FOIS.
// Lot 4.6.4 (moteur de prix). Spec : docs/specs/spec-yieldflow-v1.md §2 ter.
//
// ⚠ POURQUOI CE FICHIER EXISTE. `api/yield-prix.js` assemble, pour l'ecran, la
// grille du bien, le contexte (vacances, feries, evenements, dates
// commerciales, reglages), la pression par mois, l'ouverture et les nuits
// vendues — puis appelle `S.suggerer` nuit par nuit. Le moteur de prix a
// besoin EXACTEMENT de la meme matiere, avec les memes bornes : un prix
// calcule par le moteur et un prix suggere a l'ecran doivent etre le meme
// chiffre, sinon l'hote lit deux verites. Ce module est cette matiere, en un
// seul endroit ; `preparerContexte` ne decide de rien, `prixDeLaNuit` applique
// la regle des modules purs.
//
// ⚠ DETTE ASSUMEE (registre, ligne 17) : l'endpoint n'appelle pas encore ce
// module — il garde sa propre assemblee, historique du lot 4.4. Les deux
// suivent les memes constantes (ANS_REFERENCE = 3, contexte = historique ∪
// fenetre ∪ 404 jours de comparables) ; l'unification est le premier geste du
// lot suivant, pas de celui-ci.
//
// ⚠ CE MODULE LIT, IL N'ECRIT RIEN.

const { estJourISO, joursOuverts } = require('./capacite')
const { grilleDuBien } = require('./grille-du-bien')
const { evenementsDuBien } = require('./evenements')
const { datesCommerciales } = require('./dates-commerciales')
const { reglagesDuBien, reglagePour } = require('./reglages-segment')
const { lireVacances } = require('./vacances')
const { pickup, DRAPEAUX } = require('./pickup')
const { nuitsOccupees } = require('../nuits-occupees')
const R = require('./reference')
const S = require('./suggestion')

const ANS_REFERENCE = 3
const JOURS_COMPARABLES = 364 + 40

function decaler (iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function reculerAns (iso, n) {
  const [a, m, j] = iso.split('-')
  const c = `${Number(a) - n}-${m}-${j}`
  if (estJourISO(c)) return c
  const repli = `${Number(a) - n}-${m}-28`
  return estJourISO(repli) ? repli : null
}
const finDeMois = c => {
  const [a, m] = c.split('-').map(Number)
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10)
}

/**
 * Prepare tout ce qu'il faut pour tarifer les nuits de [debut, fin].
 *
 * @param bien     ligne `properties` complete (select('*'))
 * @param compte   user_id du compte (les reservations se lisent PAR COMPTE)
 * @param options  { aujourdHui, debut, fin, lignes? }
 *                 `lignes` : les lignes calendar_inventory deja lues par
 *                 l'appelant sur [debut, fin] (evite une relecture).
 * @returns ctx = { auj, grille, contexte, reglages, pressionParMois, ouverts,
 *                  ouvertureConnue, vendues, parDate, eclatements }
 */
async function preparerContexte (supabase, bien, compte, options = {}) {
  const { aujourdHui, debut, fin } = options
  if (!estJourISO(aujourdHui) || !estJourISO(debut) || !estJourISO(fin) || fin < debut) {
    throw new Error('[contexte] fenetre invalide')
  }
  const auj = aujourdHui
  const debutHistorique = reculerAns(auj, ANS_REFERENCE)
  const finRef = decaler(auj, -1)
  if (!debutHistorique) throw new Error('[contexte] historique invalide')
  const debutContexte = [debutHistorique, decaler(debut, -JOURS_COMPARABLES)].sort()[0]
  const finContexte = [fin, auj].sort()[1]

  // Le contexte : vacances, evenements declares, dates commerciales (moins
  // celles que l'hote a coupees).
  const vacances = await lireVacances(supabase, debutContexte, finContexte)
  const declares = await evenementsDuBien(supabase, bien.id, debutContexte, finContexte)
  const reglages = await reglagesDuBien(supabase, bien.id)
  const coupees = new Set()
  for (const [cle, r] of reglages) if (r.actif === false) coupees.add(cle)
  const commerciales = datesCommerciales(debutContexte, finContexte, { desactivees: coupees })
  const contexte = R.construireContexte({
    zoneBien: bien.zone_scolaire, vacances, evenements: [...declares, ...commerciales],
    debut: debutContexte, fin: finContexte
  })

  // La grille, sur l'historique ancre sur aujourd'hui.
  const { eclatements, grille } = await grilleDuBien(supabase, bien, compte, {
    contexte, debut: debutHistorique, fin: finRef
  })

  // La memoire d'intention, sur la fenetre ET sur les mois N-1 dont la
  // pression a besoin.
  const mois = []
  for (let c = debut.slice(0, 7); c <= fin.slice(0, 7); c = decaler(`${c}-01`, 32).slice(0, 7)) mois.push(c)
  const clesCapacite = new Set()
  for (const c of mois) { clesCapacite.add(c); clesCapacite.add(`${Number(c.slice(0, 4)) - 1}-${c.slice(5)}`) }
  const triCap = [...clesCapacite].sort()
  const debutCal = `${triCap[0]}-01`
  const finCal = finDeMois(triCap[triCap.length - 1])
  let lignesCal = options.lignesCal || null
  if (!lignesCal) {
    lignesCal = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('calendar_inventory')
        .select('date, rate, avail, stop_sell').eq('property_id', bien.id)
        .gte('date', debutCal).lte('date', finCal).order('date').range(from, from + 999)
      if (error) throw new Error(`calendar_inventory : ${error.message}`)
      lignesCal.push(...(data || []))
      if (!data || data.length < 1000) break
    }
  }

  // La pression, par mois (pickup vs N-1) — un ecart sur un denominateur
  // partiel ne deplace pas un prix (`fiable: false`).
  const capacitesMois = new Map()
  for (const c of triCap) {
    capacitesMois.set(c, await joursOuverts(supabase, bien, `${c}-01`, finDeMois(c),
      { aujourdHui: auj, estimerLePasse: true, lignes: lignesCal }))
  }
  const pressionParMois = new Map()
  for (const cle of mois) {
    const pk = pickup(eclatements, { periode: cle, pivot: auj, granularite: 'mois',
      capacites: capacitesMois, capacitePersonnes: bien.capacity })
    const c = pk.vs_n1 && pk.vs_n1.ca ? pk.vs_n1.ca : null
    const degrade = (pk.drapeaux || []).find(x =>
      x === DRAPEAUX.PORTEFEUILLE_RECONSTRUIT || x === DRAPEAUX.DATES_INCOMPLETES_N1)
    pressionParMois.set(cle, {
      ecart: c && c.variation != null ? c.variation : null,
      fiable: !degrade, motif_non_fiable: degrade || null
    })
  }

  // L'ouverture, telle que la capacite la lit (une seule regle).
  const capacite = await joursOuverts(supabase, bien, debut, fin,
    { aujourdHui: auj, estimerLePasse: false, lignes: lignesCal })
  const ouvertureConnue = !!(capacite && capacite.calculable && capacite.detail)
  const ouverts = new Set(ouvertureConnue ? capacite.detail : [])
  const parDate = new Map(lignesCal.map(l => [l.date, l]))
  const vendues = await nuitsOccupees(supabase, bien.provider_property_id, debut, fin, { userId: compte })

  return { auj, bien, grille, contexte, reglages, pressionParMois, ouverts, ouvertureConnue,
    motifOuverture: ouvertureConnue ? null : (capacite ? capacite.raison : 'capacite_non_calculable'),
    vendues, parDate, eclatements, debut, fin }
}

/**
 * Le prix d'UNE nuit, par la regle du moteur de suggestion — la meme que
 * l'ecran. `ouverte` est fourni par l'appelant : le moteur d'ouverture sait
 * qu'il va ouvrir la nuit, l'entretien lit la memoire.
 * @returns sortie de `S.suggerer` : { prix (euros) | null, non_calculable: [motifs], ... }
 */
function prixDeLaNuit (ctx, date, { ouverte = null, vendue = null } = {}) {
  const seg = R.segmenterJour(date, ctx.contexte)
  const pr = ctx.pressionParMois.get(date.slice(0, 7)) || null
  const delai = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${ctx.auj}T00:00:00Z`)) / 86400000)
  const estVendue = vendue != null ? vendue
    : (ctx.vendues[date] || []).length >= Math.max(1, Number(ctx.bien.inventory_units) || 1)
  return S.suggerer({
    date, grille: ctx.grille, contexte: ctx.contexte, ouverte, vendue: estVendue, delaiJours: delai,
    pression: pr && pr.ecart != null ? { ecart: pr.ecart, fiable: pr.fiable !== false, motif_non_fiable: pr.motif_non_fiable || null } : null,
    reglage: reglagePour(ctx.reglages, seg),
    bien: ctx.bien
  })
}

module.exports = { preparerContexte, prixDeLaNuit, ANS_REFERENCE, JOURS_COMPARABLES }
