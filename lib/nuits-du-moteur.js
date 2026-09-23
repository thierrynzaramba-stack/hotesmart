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
// module ne fait que LIRE (memoire, indisponibilites, prix YieldFlow, ventes) :
// ni canal, ni writer.

const { nuitsFermees, fermeturesDuBien } = require('./fermetures')
const { nuitsOccupees } = require('./nuits-occupees')
const { prixHoteDuBien } = require('./prix-hote')
const { finDeFenetre } = require('./pilote-tarifaire')

const decaler = (jour, n) => { const d = new Date(`${jour}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

// Pourquoi le moteur NE tarife PAS cette nuit, ou null s'il la tarife (sous
// reserve que la regle sache la calculer — « non calculable » ne se sait
// qu'avec la matiere du bien, pas ici).
//   parLHote : Set des nuits couvertes par une indisponibilite de l'hote
//   prixHote : Map des nuits posees depuis YieldFlow (✎) — jamais touchees
//   parDate  : Map date -> ligne calendar_inventory
//   ouverts  : Set des nuits ouvertes selon la capacite, ou null (pas de filtre)
//   vendues  : Set des nuits VENDUES (`nuitsVendues`), ou null. Le moteur de
//              prix les reconnait par la regle (`nuit_deja_vendue`) ; le
//              compte de la confirmation, qui n'a pas la matiere, les lit ici
//              (releve en review : une reservation n'ecrit pas dans
//              `calendar_inventory`, une nuit vendue y garde avail=1 et son
//              prix — sans ce Set, « YieldFlow va les remplacer » comptait des
//              sejours deja reserves).
function sautDuMoteur (j, { parLHote, prixHote, parDate, ouverts = null, vendues = null }) {
  if (parLHote && parLHote.has(j)) return 'fermees_par_l_hote'
  if (prixHote && prixHote.has(j)) return 'prix_hote'
  const l = parDate.get(j)
  if (!l) return 'sans_ligne'
  if (l.stop_sell === true || l.avail === 0) return 'fermees'
  if (ouverts && !ouverts.has(j)) return 'ouverture_inconnue'
  if (vendues && vendues.has(j)) return 'vendues'
  return null
}

// Les nuits VENDUES de [debut, fin] : occupees a hauteur du stock du bien.
// Une seule definition, pour le moteur d'ouverture et pour le compte.
async function nuitsVendues (supabase, bien, debut, fin) {
  const occ = await nuitsOccupees(supabase, bien.provider_property_id, debut, fin, { userId: bien.user_id })
  const unites = Math.max(1, Number(bien.inventory_units) || 1)
  const out = new Set()
  for (const [date, sejours] of Object.entries(occ || {})) if ((sejours || []).length >= unites) out.add(date)
  return out
}

// DECISION A1 / B1 (Thierry, 23 septembre 2026). Les nuits de [aujourdHui,
// fin] que le moteur va RECALCULER et qui portent DEJA un prix au calendrier.
// A1 : on ne dit pas « que vous avez definis » — la base ne sait pas qui a
// ecrit un prix du calendrier (pas d'origine dans `calendar_inventory`, et un
// prix pose par YieldFlow avant une desactivation y reste, indiscernable).
// B1 : on compte les prix en place, pas les prix qui changeront — un prix egal
// a la prediction « est remplace » par la meme valeur ; simuler la matiere a
// chaque ouverture de la confirmation couterait plusieurs secondes.
function compterPrixARemplacer ({ aujourdHui, fin, lignes, fermetures, prixHote, vendues = null }) {
  const parLHote = nuitsFermees(fermetures || [], aujourdHui, fin)
  const parDate = new Map((lignes || []).map(l => [l.date, l]))
  let n = 0
  for (let j = aujourdHui, k = 0; j <= fin && k < 5000; j = decaler(j, 1), k++) {
    if (sautDuMoteur(j, { parLHote, prixHote, parDate, vendues })) continue
    const l = parDate.get(j)
    if (l.rate != null && Number(l.rate) > 0) n++
  }
  return n
}

// Le compte pour la confirmation d'activation, sur la fenetre SAISIE : toutes
// les lectures, puis la regle. Rend { nuits, fin } ou null (illisible — l'ecran
// le dit, il n'annonce jamais 0). `bien` doit porter id, user_id,
// provider_property_id, inventory_units ; le compte vient de la garde.
async function prixCalendrierARemplacer (supabase, bien, fenetre, aujourdHui) {
  // Le bien peut etre encore en mode calendrier : la fenetre est celle saisie.
  const fin = finDeFenetre({ ...bien, pilote_tarifaire: 'yieldflow', pilote_fenetre_type: fenetre.type, pilote_fenetre_valeur: fenetre.valeur }, aujourdHui)
  if (!fin) return null
  try {
    const [lignes, fermetures, prixHote, vendues] = await Promise.all([
      relireMemoire(supabase, bien, aujourdHui, fin),
      fermeturesDuBien(supabase, bien.id, aujourdHui, fin),
      prixHoteDuBien(supabase, bien.id, aujourdHui, fin),
      // Un bien sans identifiant provider n'a aucune reservation a lire.
      bien.provider_property_id ? nuitsVendues(supabase, bien, aujourdHui, fin) : Promise.resolve(new Set())
    ])
    return { nuits: compterPrixARemplacer({ aujourdHui, fin, lignes, fermetures, prixHote, vendues }), fin }
  } catch (e) {
    console.error('[nuits-du-moteur] compte des prix du calendrier illisible', bien.id, e.message)
    return null
  }
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

module.exports = { sautDuMoteur, nuitsVendues, compterPrixARemplacer, prixCalendrierARemplacer, relireMemoire }
