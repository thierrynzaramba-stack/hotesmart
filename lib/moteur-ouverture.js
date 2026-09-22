// lib/moteur-ouverture.js — LE MOTEUR D'OUVERTURE (lot 4.6.3).
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter (§1 « ce que le mode fait »,
// §3 « les trois etats d'une nuit », 4.6.3 livre).
// Canal : lib/canal-calendrier.js — Writer : lib/calendrier-writer.js
// DOC : docs/kb/coeur-de-donnees.md (modif = MEME COMMIT)
//
// CE QU'IL FAIT. Pour chaque bien pilote par YieldFlow dont la fenetre est
// reglee (N jours ou N mois glissants, `lib/pilote-tarifaire.js`), il OUVRE a
// la vente les nuits qui sont dans la fenetre et sur lesquelles PERSONNE n'a
// encore rien decide. La premiere activation ouvre toute la fenetre ; ensuite,
// chaque jour, la fenetre glisse d'un jour et la nuit qui y entre s'ouvre.
//
// ⚠ CE QU'IL NE TOUCHE JAMAIS — c'est la regle du lot, plus que ce qu'il fait :
//   - une nuit couverte par une INDISPONIBILITE de l'hote (table `fermetures`) :
//     ni ouverture, ni prix, quoi qu'il arrive. Le canal la compte a part
//     (`fermees_par_l_hote`) et ce module ne la lui demande meme pas ;
//   - une nuit sur laquelle une INTENTION existe deja en memoire
//     (`calendar_inventory.stop_sell = true`, ou `avail = 0`) : fermee a la main
//     par l'hote sans objet, ou fermee « calculee ». Le moteur n'a pas le droit
//     de la rouvrir : « il ne rouvre jamais ce que l'hote a ferme » (§6) ;
//   - une nuit deja OUVERTE (`stop_sell = false`, stock > 0) : rien a faire ;
//   - une nuit VENDUE (releve en review) : elle n'a plus rien a ouvrir ni a
//     afficher, quel que soit l'etat de sa ligne — `nuitsOccupees` le dit ;
//   - une nuit au-dela de la fenetre : PAS ENCORE OUVERTE, aucun objet, aucune
//     intention. La fenetre glissera jusqu'a elle ;
//   - le passe.
//
// ⚠ UNE NUIT NE S'OUVRE JAMAIS SANS PRIX. Depuis le 8 septembre 2026, une date
// sans prix part FERMEE vers les plateformes (docs/kb/problemes.md) : l'ouvrir
// sans tarif la ferait fermer a la poussee suivante, ou vendre au prix par
// defaut du plan. D'ici le moteur de prix (4.6.4), le prix d'ouverture est
// celui que la nuit porte deja en memoire, sinon le PRIX DE BASE du bien. Une
// nuit sans l'un ni l'autre n'est pas ouverte, et elle est COMPTEE
// (`sans_prix`) : un compte qui monte est un bien sans prix de base, pas une
// panne silencieuse.
//
// ⚠ PAR LE CANAL INTERNE, JAMAIS AUTREMENT. Ce module ne lit `calendar_inventory`
// que pour DECIDER quoi demander ; il n'y ecrit jamais. Il ne parle a aucun
// provider. `demanderAuCalendrier` traduit, le writer execute — plancher,
// journal (`source = 'engine'`), poussee ARI en delta.
//
// ⚠ UNE FOIS PAR JOUR ET PAR BIEN, par marqueur `cron_logs` (`ouverture:<bien>`),
// pose APRES le travail : un passage en echec se retente au tick suivant. Le
// marqueur est EFFACE par l'endpoint du pilote a l'activation et a tout
// changement de fenetre, pour que la premiere ouverture parte au tick suivant
// (5 min) et non le lendemain.

const { demanderAuCalendrier } = require('./canal-calendrier')
const { fermeturesDuBien, nuitsFermees } = require('./fermetures')
const { pilotParYield, fenetreDuBien, finDeFenetre } = require('./pilote-tarifaire')
const { PREFIXE_MARQUEUR, jourParis, effacerMarqueur } = require('./ouverture-marqueur')
const { tarifAcceptable } = require('./yield/prix-plancher')
const { nuitsOccupees } = require('./nuits-occupees')

// ⚠ LA BOUCLE « tous les biens, une fois par jour » VIT DANS
// lib/pilote-quotidien.js (lot 4.6.5), pas ici — releve en review : deux
// boucles, deux budgets, deux formes de marqueur auraient diverge. Ce module
// ne sait ouvrir qu'UN bien.
const PAGE = 500

const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/

function decaler (jour, n) {
  const d = new Date(`${jour}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Le prix d'ouverture d'une nuit, en centimes : le prix CALCULE par la regle
// (lot 4.6.4, fourni par le pilote quotidien), sinon sa memoire, sinon le prix
// de base du bien, sinon rien. Rend { prix } ou { prix: null, raison }.
// ⚠ LE PLANCHER SE VERIFIE ICI, NUIT PAR NUIT — releve en review. Le writer
// refuse la demande ENTIERE des qu'UN tarif est sous le plancher du bien
// (docs/kb/prix-plancher.md : on ferme la date, on ne remonte jamais le prix).
// Un seul prix de base sous le plancher aurait bloque toute la fenetre, a
// chaque tick, sans jamais poser le marqueur. La nuit sous le plancher reste
// fermee et est comptee (`sous_plancher`) ; les autres s'ouvrent.
function prixDOuverture (bien, ligne, calcule = null) {
  const memoire = ligne && ligne.rate != null ? Number(ligne.rate) : NaN
  let prix = null
  if (Number.isInteger(calcule) && calcule > 0) prix = calcule
  else if (Number.isFinite(memoire) && memoire > 0) prix = Math.round(memoire * 100)
  else {
    const base = Number(bien && bien.base_price)
    if (Number.isFinite(base) && base > 0) prix = Math.round(base * 100)
  }
  if (prix == null) return { prix: null, raison: 'sans_prix' }
  const v = tarifAcceptable(prix, bien)
  if (!v.ok) return { prix: null, raison: 'sous_plancher', plancher: v.plancher }
  return { prix }
}

// ─── LA DECISION, PURE ───────────────────────────────────────────────────────
// Etant donne le bien, le jour, ses lignes de memoire sur la fenetre et ses
// indisponibilites : quelles nuits demander au calendrier, et pourquoi les
// autres ne le sont pas. Aucune lecture, aucune ecriture : un test l'execute.
// `prixHote` : Map date -> centimes, la main de l'hote (arbitrage A bis). Une
// nuit qui la porte s'ouvre A CE PRIX, avant tout calcul.
function nuitsAOuvrir ({ bien, aujourdHui, lignes, fermetures, prixCalcule = null, vendues = null, prixHote = null }) {
  const comptes = { a_ouvrir: 0, deja_ouvertes: 0, fermees_par_l_hote: 0, intention_existante: 0, sans_prix: 0, sous_plancher: 0, vendues: 0 }
  const fin = finDeFenetre(bien, aujourdHui)
  if (!fin || !pilotParYield(bien)) return { nuits: [], fin: null, comptes }
  const parLHote = nuitsFermees(fermetures || [], aujourdHui, fin)
  const parDate = new Map((lignes || []).map(l => [l.date, l]))
  const nuits = []
  for (let j = aujourdHui, n = 0; j <= fin && n < 5000; j = decaler(j, 1), n++) {
    if (parLHote.has(j)) { comptes.fermees_par_l_hote++; continue }
    if (vendues && vendues.has(j)) { comptes.vendues++; continue }
    const l = parDate.get(j)
    if (l && (l.stop_sell === true || l.avail === 0)) { comptes.intention_existante++; continue }
    if (l && l.stop_sell === false && Number(l.avail) > 0) { comptes.deja_ouvertes++; continue }
    const main = prixHote && prixHote.get ? prixHote.get(j) : null
    const { prix, raison } = prixDOuverture(bien, l, main != null ? main : (prixCalcule && prixCalcule.get ? prixCalcule.get(j) : null))
    if (prix == null) { comptes[raison]++; continue }
    nuits.push({ date: j, ouvrir: true, prix_centimes: prix })
    comptes.a_ouvrir++
  }
  return { nuits, fin, comptes }
}

// ─── UN BIEN ─────────────────────────────────────────────────────────────────
// Les nuits VENDUES de [debut, fin] : occupees a hauteur du stock du bien.
async function nuitsVendues (supabase, bien, debut, fin) {
  const occ = await nuitsOccupees(supabase, bien.provider_property_id, debut, fin, { userId: bien.user_id })
  const unites = Math.max(1, Number(bien.inventory_units) || 1)
  const out = new Set()
  for (const [date, sejours] of Object.entries(occ || {})) if ((sejours || []).length >= unites) out.add(date)
  return out
}

async function ouvrirLaFenetreDuBien (supabase, bien, { aujourdHui, appel, demander = demanderAuCalendrier, prixCalcule = null, fermetures: fermeturesFournies = null, vendues: venduesFournies = null, prixHote = null } = {}) {
  const auj = JOUR_RE.test(String(aujourdHui || '')) ? aujourdHui : jourParis()
  const fin = finDeFenetre(bien, auj)
  if (!fin) return { ok: false, refus: 'fenetre_non_reglee', message: 'Fenêtre non réglée : rien à ouvrir.' }
  // ⚠ UNE LECTURE EN ECHEC REFUSE, elle n'ouvre pas « faute d'info » : un vide
  // par erreur ferait ouvrir dans une indisponibilite (`fermeturesDuBien` leve).
  let fermetures = fermeturesFournies
  if (!fermetures) {
    try { fermetures = await fermeturesDuBien(supabase, bien.id, auj, fin) }
    catch (e) { return { ok: false, refus: 'fermetures_illisibles', message: e.message } }
  }
  const lignes = []
  for (let debut = auj; debut <= fin; debut = decaler(debut, PAGE)) {
    const finPage = decaler(debut, PAGE - 1) < fin ? decaler(debut, PAGE - 1) : fin
    const { data, error } = await supabase.from('calendar_inventory')
      .select('date, rate, avail, stop_sell').eq('property_id', bien.id).gte('date', debut).lte('date', finPage)
    if (error) return { ok: false, refus: 'memoire_illisible', message: error.message }
    lignes.push(...(data || []))
  }
  // ⚠ LES NUITS VENDUES, LUES ICI MEME quand l'appelant n'a pas de matiere :
  // une nuit occupee sans ligne serait sinon ouverte et tarifee au prix de
  // base (releve en review). Une lecture en echec refuse.
  let vendues = venduesFournies
  if (!vendues) {
    try { vendues = await nuitsVendues(supabase, bien, auj, fin) }
    catch (e) { return { ok: false, refus: 'vendues_illisibles', message: e.message } }
  }
  const decision = nuitsAOuvrir({ bien, aujourdHui: auj, lignes, fermetures, prixCalcule, vendues, prixHote })
  if (!decision.nuits.length) return { ok: true, ouvertes: 0, fin, comptes: decision.comptes, ignorees: null }
  const r = await demander(supabase, bien, { nuits: decision.nuits, aujourdHui: auj }, { appel })
  if (!r.ok) return { ok: false, refus: r.refus, message: r.message, fin, comptes: decision.comptes, ignorees: r.ignorees }
  const ignoreesN = r.ignorees ? Object.values(r.ignorees).reduce((s, t) => s + (t ? t.length : 0), 0) : 0
  // ⚠ « OK » DU CANAL N'EST PAS « PARTI » — releve en review. Le writer a deja
  // memorise l'ouverture quand la poussee ARI echoue (`pushFailed`) : au tick
  // suivant, ces nuits seraient lues « deja ouvertes » et jamais redemandees,
  // ouvertes en memoire et fermees chez le provider pour toujours. Le remede
  // qui existe deja dans le produit : la file des FULL SYNCS (500 jours,
  // reconcilie la memoire vers le canal). On y met le bien, on ne pose PAS le
  // marqueur, et on le dit. `localOnly` (bien non relie), lui, est un succes.
  if (r.ecrit && r.ecrit.pushFailed) {
    await enfilerFullSync(supabase, bien)
    return { ok: false, refus: 'poussee_refusee', fin, comptes: decision.comptes, ignorees: r.ignorees, ecrit: r.ecrit,
      message: `Ouverture mémorisée mais non poussée au canal (${(r.ecrit.warnings || []).join(' · ') || 'poussée refusée'}) : un full sync est en file.` }
  }
  return { ok: true, ouvertes: decision.nuits.length - ignoreesN, fin, comptes: decision.comptes, ignorees: r.ignorees, ecrit: r.ecrit }
}

async function enfilerFullSync (supabase, bien) {
  try {
    const { data: deja } = await supabase.from('channel_sync_queue').select('id').eq('property_id', bien.id).in('status', ['pending', 'processing']).limit(1)
    if (deja && deja.length) return
    const { error } = await supabase.from('channel_sync_queue').insert({ property_id: bien.id, status: 'pending' })
    if (error) console.error('[ouverture] full sync non enfile', bien.id, error.message)
  } catch (e) { console.error('[ouverture] full sync non enfile', bien.id, e.message) }
}

module.exports = { ouvrirLaFenetreDuBien, nuitsAOuvrir, nuitsVendues, prixDOuverture, enfilerFullSync, effacerMarqueur, PREFIXE_MARQUEUR }
