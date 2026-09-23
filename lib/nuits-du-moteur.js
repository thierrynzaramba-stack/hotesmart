// lib/nuits-du-moteur.js — QUELLES NUITS LE MOTEUR DE PRIX TOUCHE.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter (recette du 22 septembre 2026,
// changement de dessin du 23 septembre : « deux origines, deux traitements »).
//
// POURQUOI UN MODULE A PART. La regle « quelles nuits le moteur saute » sert a
// deux endroits : le moteur lui-meme (`lib/moteur-prix.js`, `calculerPrix`) et
// la confirmation d'activation (`api/yield-pilote.js`), qui annonce a l'hote
// « N nuits ont deja un prix au calendrier ; YieldFlow va les remplacer par ses
// predictions ». Une copie dans l'endpoint deriverait : le jour ou le moteur
// saute une nuit de plus, l'ecran compterait faux. Et l'endpoint n'a pas le
// droit d'importer le moteur (il charge le canal interne — regle du 4.6.3 :
// « l'endpoint du pilote n'importe que le marqueur, jamais le moteur »). Ce
// module est PUR, a une lecture pres (`relireMemoire`), sans canal ni writer.

const { nuitsFermees } = require('./fermetures')

const decaler = (jour, n) => { const d = new Date(`${jour}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

// Pourquoi le moteur NE tarife PAS cette nuit, ou null s'il la tarife (sous
// reserve que la regle sache la calculer — « non calculable » et « vendue »
// ne se savent qu'avec la matiere du bien, pas ici).
//   parLHote : Set des nuits couvertes par une indisponibilite de l'hote
//   prixHote : Map des nuits posees depuis YieldFlow (✎) — jamais touchees
//   parDate  : Map date -> ligne calendar_inventory
//   ouverts  : Set des nuits ouvertes selon la capacite, ou null (inconnu)
function sautDuMoteur (j, { parLHote, prixHote, parDate, ouverts = null }) {
  if (parLHote && parLHote.has(j)) return 'fermees_par_l_hote'
  if (prixHote && prixHote.has(j)) return 'prix_hote'
  const l = parDate.get(j)
  if (!l) return 'sans_ligne'
  if (l.stop_sell === true || l.avail === 0) return 'fermees'
  if (ouverts && !ouverts.has(j)) return 'ouverture_inconnue'
  return null
}

// DECISION A1 / B1 (Thierry, 23 septembre 2026). Les nuits de [aujourdHui,
// fin] que le moteur va RECALCULER et qui portent DEJA un prix au calendrier.
// A1 : on ne dit pas « que vous avez definis » — la base ne sait pas qui a
// ecrit un prix du calendrier (pas d'origine dans `calendar_inventory`, et un
// prix pose par YieldFlow avant une desactivation y reste, indiscernable).
// B1 : on compte les prix en place, pas les prix qui changeront — un prix egal
// a la prediction « est remplace » par la meme valeur ; simuler la matiere a
// chaque ouverture de la confirmation couterait plusieurs secondes.
function compterPrixARemplacer ({ aujourdHui, fin, lignes, fermetures, prixHote }) {
  const parLHote = nuitsFermees(fermetures || [], aujourdHui, fin)
  const parDate = new Map((lignes || []).map(l => [l.date, l]))
  let n = 0
  for (let j = aujourdHui, k = 0; j <= fin && k < 5000; j = decaler(j, 1), k++) {
    if (sautDuMoteur(j, { parLHote, prixHote, parDate })) continue
    const l = parDate.get(j)
    if (l.rate != null && Number(l.rate) > 0) n++
  }
  return n
}

// La memoire du calendrier sur [auj, fin], par pages de 500 jours (une
// lecture PostgREST s'arrete a 1000 lignes SANS erreur).
async function relireMemoire (supabase, bien, auj, fin) {
  const lignes = []
  for (let debut = auj; debut <= fin; debut = decaler(debut, 500)) {
    const finPage = decaler(debut, 499) < fin ? decaler(debut, 499) : fin
    const { data, error } = await supabase.from('calendar_inventory')
      .select('date, rate, avail, stop_sell').eq('property_id', bien.id).gte('date', debut).lte('date', finPage)
    if (error) throw new Error(`calendar_inventory : ${error.message}`)
    lignes.push(...(data || []))
  }
  return lignes
}

module.exports = { sautDuMoteur, compterPrixARemplacer, relireMemoire }
