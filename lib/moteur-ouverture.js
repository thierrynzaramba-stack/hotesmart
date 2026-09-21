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
const { PREFIXE_MARQUEUR, jourParis, aTourneAujourdhui, poserMarqueur, effacerMarqueur } = require('./ouverture-marqueur')

const BUDGET_MS = 25000
const PAGE = 500

const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/

function decaler (jour, n) {
  const d = new Date(`${jour}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Le prix d'ouverture d'une nuit, en centimes : sa memoire, sinon le prix de
// base du bien, sinon rien.
function prixDOuverture (bien, ligne) {
  const memoire = ligne && ligne.rate != null ? Number(ligne.rate) : NaN
  if (Number.isFinite(memoire) && memoire > 0) return Math.round(memoire * 100)
  const base = Number(bien && bien.base_price)
  if (Number.isFinite(base) && base > 0) return Math.round(base * 100)
  return null
}

// ─── LA DECISION, PURE ───────────────────────────────────────────────────────
// Etant donne le bien, le jour, ses lignes de memoire sur la fenetre et ses
// indisponibilites : quelles nuits demander au calendrier, et pourquoi les
// autres ne le sont pas. Aucune lecture, aucune ecriture : un test l'execute.
function nuitsAOuvrir ({ bien, aujourdHui, lignes, fermetures }) {
  const comptes = { a_ouvrir: 0, deja_ouvertes: 0, fermees_par_l_hote: 0, intention_existante: 0, sans_prix: 0 }
  const fin = finDeFenetre(bien, aujourdHui)
  if (!fin || !pilotParYield(bien)) return { nuits: [], fin: null, comptes }
  const parLHote = nuitsFermees(fermetures || [], aujourdHui, fin)
  const parDate = new Map((lignes || []).map(l => [l.date, l]))
  const nuits = []
  for (let j = aujourdHui, n = 0; j <= fin && n < 5000; j = decaler(j, 1), n++) {
    if (parLHote.has(j)) { comptes.fermees_par_l_hote++; continue }
    const l = parDate.get(j)
    if (l && (l.stop_sell === true || l.avail === 0)) { comptes.intention_existante++; continue }
    if (l && l.stop_sell === false && Number(l.avail) > 0) { comptes.deja_ouvertes++; continue }
    const prix = prixDOuverture(bien, l)
    if (prix == null) { comptes.sans_prix++; continue }
    nuits.push({ date: j, ouvrir: true, prix_centimes: prix })
    comptes.a_ouvrir++
  }
  return { nuits, fin, comptes }
}

// ─── UN BIEN ─────────────────────────────────────────────────────────────────
async function ouvrirLaFenetreDuBien (supabase, bien, { aujourdHui, appel, demander = demanderAuCalendrier } = {}) {
  const auj = JOUR_RE.test(String(aujourdHui || '')) ? aujourdHui : jourParis()
  const fin = finDeFenetre(bien, auj)
  if (!fin) return { ok: false, refus: 'fenetre_non_reglee', message: 'Fenêtre non réglée : rien à ouvrir.' }
  // ⚠ UNE LECTURE EN ECHEC REFUSE, elle n'ouvre pas « faute d'info » : un vide
  // par erreur ferait ouvrir dans une indisponibilite (`fermeturesDuBien` leve).
  let fermetures
  try { fermetures = await fermeturesDuBien(supabase, bien.id, auj, fin) }
  catch (e) { return { ok: false, refus: 'fermetures_illisibles', message: e.message } }
  const lignes = []
  for (let debut = auj; debut <= fin; debut = decaler(debut, PAGE)) {
    const finPage = decaler(debut, PAGE - 1) < fin ? decaler(debut, PAGE - 1) : fin
    const { data, error } = await supabase.from('calendar_inventory')
      .select('date, rate, avail, stop_sell').eq('property_id', bien.id).gte('date', debut).lte('date', finPage)
    if (error) return { ok: false, refus: 'memoire_illisible', message: error.message }
    lignes.push(...(data || []))
  }
  const decision = nuitsAOuvrir({ bien, aujourdHui: auj, lignes, fermetures })
  if (!decision.nuits.length) return { ok: true, ouvertes: 0, fin, comptes: decision.comptes, ignorees: null }
  const r = await demander(supabase, bien, { nuits: decision.nuits, aujourdHui: auj }, { appel })
  if (!r.ok) return { ok: false, refus: r.refus, message: r.message, fin, comptes: decision.comptes, ignorees: r.ignorees }
  const ignoreesN = r.ignorees ? Object.values(r.ignorees).reduce((s, t) => s + (t ? t.length : 0), 0) : 0
  return { ok: true, ouvertes: decision.nuits.length - ignoreesN, fin, comptes: decision.comptes, ignorees: r.ignorees, ecrit: r.ecrit }
}

// ─── TOUS LES BIENS PILOTES, UNE FOIS PAR JOUR ───────────────────────────────
async function ouvrirFenetres (supabase, deps = {}) {
  const maintenant = typeof deps.maintenant === 'function' ? deps.maintenant : () => Date.now()
  const auj = JOUR_RE.test(String(deps.aujourdHui || '')) ? deps.aujourdHui : jourParis(new Date(maintenant()))
  const budget = deps.budgetMs || BUDGET_MS
  const t0 = maintenant()
  const bilan = { jour: auj, biens: 0, traites: 0, ouvertes: 0, sautes: 0, reportes: 0, erreurs: [], details: [] }
  const { data: biens, error } = await supabase.from('properties').select('*')
    .eq('pilote_tarifaire', 'yieldflow').not('pilote_fenetre_type', 'is', null).not('pilote_fenetre_valeur', 'is', null)
    .order('id')
  if (error) { bilan.erreurs.push({ context: 'lecture_biens', error: error.message }); return bilan }
  bilan.biens = (biens || []).length
  for (const bien of biens || []) {
    if (!fenetreDuBien(bien)) continue
    if (maintenant() - t0 > budget) { bilan.reportes++; continue }
    if (await aTourneAujourdhui(supabase, bien.id, auj)) { bilan.sautes++; continue }
    try {
      const r = await ouvrirLaFenetreDuBien(supabase, bien, { aujourdHui: auj, appel: deps.appel, demander: deps.demander })
      bilan.details.push({ bien: bien.id, nom: bien.name, ...r })
      if (!r.ok) { bilan.erreurs.push({ bien: bien.id, refus: r.refus, error: r.message }); continue }
      bilan.traites++; bilan.ouvertes += r.ouvertes
      await poserMarqueur(supabase, bien.id, maintenant())
    } catch (e) {
      bilan.erreurs.push({ bien: bien.id, error: e.message })
    }
  }
  return bilan
}

module.exports = { ouvrirFenetres, ouvrirLaFenetreDuBien, nuitsAOuvrir, prixDOuverture, effacerMarqueur, PREFIXE_MARQUEUR, BUDGET_MS }
