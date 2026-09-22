// lib/moteur-prix.js — LE MOTEUR DE PRIX (lot 4.6.4).
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter (§1, §6, « 4.6.4 livre »).
// Matiere : lib/yield/contexte-du-bien.js — Regle : lib/yield/suggestion.js
// Canal : lib/canal-calendrier.js — DOC : docs/kb/coeur-de-donnees.md
//
// CE QU'IL FAIT. Pour un bien pilote par YieldFlow, chaque jour, il calcule le
// prix de chaque nuit OUVERTE de la fenetre par la regle du moteur de
// suggestion — la meme que l'ecran, 100 % deterministe, aucun appel d'IA —
// et ne demande au calendrier QUE les prix qui CHANGENT.
//
// ⚠ CE QU'IL NE TARIFE JAMAIS :
//   - une nuit couverte par une INDISPONIBILITE de l'hote ;
//   - une nuit FERMEE en memoire (stop_sell, ou stock a 0) ;
//   - une nuit VENDUE (elle n'a plus de prix a afficher) ;
//   - une nuit sans ligne au calendrier (pas encore ouverte : c'est le moteur
//     d'ouverture qui la tarife en l'ouvrant, avec le prix que ce module lui
//     donne) ;
//   - le passe.
//
// ⚠ LE PLANCHER EST ARME PAR LA REGLE ELLE-MEME. `S.suggerer` REFUSE une
// suggestion sous le plancher du bien (motif `suggestion_sous_le_plancher`),
// il ne la rabote jamais (docs/kb/prix-plancher.md). Ce module ne pose donc
// jamais un prix sous le plancher, et le writer, derriere le canal, le
// verifie encore.
//
// ⚠ DIFF AVANT JOURNAL. Un entretien quotidien qui redemanderait 365 prix
// identiques ferait 365 upserts et une poussee ARI pour rien — et le journal
// des prix, lui, ne bouge pas (il ne journalise qu'un changement REEL, c'est
// sa regle). On compare AVANT de demander : un prix egal au centime n'est pas
// demande. Ce qui part au canal est donc, par construction, le DELTA.
//
// ⚠ « NON CALCULABLE » N'EST PAS ZERO NI « ON BAISSE ». Une nuit dont la regle
// ne sait pas dire le prix (grille non fiable, segment mince, hors contexte)
// GARDE son prix courant, et le motif est compte : l'ecran et l'alarme le
// disent, le prix ne bouge pas.

const { demanderAuCalendrier } = require('./canal-calendrier')
const { enfilerFullSync } = require('./moteur-ouverture')
const { fermeturesDuBien, nuitsFermees } = require('./fermetures')
const { prixHoteDuBien } = require('./prix-hote')
const { pilotParYield, finDeFenetre } = require('./pilote-tarifaire')
const { preparerContexte, prixDeLaNuit } = require('./yield/contexte-du-bien')

const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/
function decaler (jour, n) {
  const d = new Date(`${jour}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const jourParis = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d)

// ─── LA DECISION, PURE ───────────────────────────────────────────────────────
// Etant donne les nuits de la fenetre, la memoire, les indisponibilites et
// une fonction de prix (la regle) : quels prix demander, et pourquoi les
// autres ne bougent pas.
//   prix(date, { ouverte }) -> { prix: euros|null, non_calculable: [motifs] }
//   ouverts : les nuits que LA CAPACITE lit ouvertes (`joursOuverts`) — la meme
//   regle que l'ecran (releve en review : une ligne sans intention ni prix est
//   « ouverture inconnue » a l'ecran, elle ne doit pas recevoir un prix ici).
//   `null` = capacite non calculable : rien n'est tarife, et c'est dit.
//   prixHote : les nuits dont l'HOTE a fixe le prix (Map date -> centimes,
//   lib/prix-hote.js) — jamais recalculees, jamais ecrasees (arbitrage A bis).
function calculerPrix ({ aujourdHui, fin, lignes, fermetures, prix, ouverts = null, prixHote = null }) {
  const comptes = { calculees: 0, changees: 0, inchangees: 0, non_calculables: 0, sous_plancher: 0,
    fermees: 0, fermees_par_l_hote: 0, vendues: 0, sans_ligne: 0, ouverture_inconnue: 0, prix_hote: 0 }
  const motifs = {}
  const changements = []
  const parLHote = nuitsFermees(fermetures || [], aujourdHui, fin)
  const parDate = new Map((lignes || []).map(l => [l.date, l]))
  for (let j = aujourdHui, n = 0; j <= fin && n < 5000; j = decaler(j, 1), n++) {
    if (parLHote.has(j)) { comptes.fermees_par_l_hote++; continue }
    if (prixHote && prixHote.has(j)) { comptes.prix_hote++; continue }
    const l = parDate.get(j)
    if (!l) { comptes.sans_ligne++; continue }
    if (l.stop_sell === true || l.avail === 0) { comptes.fermees++; continue }
    if (ouverts && !ouverts.has(j)) { comptes.ouverture_inconnue++; continue }
    const s = prix(j, { ouverte: true })
    const nc = (s && s.non_calculable) || []
    if (nc.includes('nuit_deja_vendue')) { comptes.vendues++; continue }
    if (s == null || s.prix == null) {
      if (nc.includes('suggestion_sous_le_plancher')) comptes.sous_plancher++
      else comptes.non_calculables++
      for (const m of nc) motifs[m] = (motifs[m] || 0) + 1
      continue
    }
    comptes.calculees++
    const cents = Math.round(Number(s.prix) * 100)
    const courant = l.rate != null ? Math.round(Number(l.rate) * 100) : null
    if (courant === cents) { comptes.inchangees++; continue }
    comptes.changees++
    changements.push({ date: j, prix_centimes: cents, avant_centimes: courant })
  }
  return { changements, comptes, motifs }
}

// ─── UN BIEN : lecture, calcul, canal ────────────────────────────────────────
// `ctx` peut etre fourni par l'appelant (le pilote quotidien le prepare une
// fois pour l'ouverture ET pour les prix) ; sinon il est prepare ici.
async function entretenirLesPrix (supabase, bien, deps = {}) {
  const demander = deps.demander || demanderAuCalendrier
  const auj = JOUR_RE.test(String(deps.aujourdHui || '')) ? deps.aujourdHui : jourParis()
  if (!pilotParYield(bien)) return { ok: false, refus: 'bien_non_pilote', message: 'Bien non piloté par YieldFlow.' }
  const fin = finDeFenetre(bien, auj)
  if (!fin) return { ok: false, refus: 'fenetre_non_reglee', message: 'Fenêtre non réglée : rien à tarifer.' }
  let fermetures = deps.fermetures
  if (!fermetures) {
    try { fermetures = await fermeturesDuBien(supabase, bien.id, auj, fin) }
    catch (e) { return { ok: false, refus: 'fermetures_illisibles', message: e.message } }
  }
  let ctx = deps.ctx
  if (!ctx) {
    try { ctx = await (deps.preparer || preparerContexte)(supabase, bien, bien.user_id, { aujourdHui: auj, debut: auj, fin }) }
    catch (e) { return { ok: false, refus: 'contexte_illisible', message: e.message } }
  }
  const lignes = deps.lignes || [...ctx.parDate.values()].filter(l => l.date >= auj && l.date <= fin)
  // ⚠ L'OUVERTURE SE LIT PAR LA CAPACITE — `deps.ouverts` (le pilote relit la
  // memoire apres l'ouverture et la classe), sinon celle du contexte. Une
  // capacite non calculable ne tarife rien.
  const ouverts = deps.ouverts !== undefined ? deps.ouverts : (ctx.ouvertureConnue ? ctx.ouverts : null)
  if (ouverts == null && deps.ouverts === undefined && ctx.ouvertureConnue === false) {
    return { ok: false, refus: 'ouverture_inconnue', message: `Capacité non calculable (${ctx.motifOuverture}) : aucun prix posé.`, fin }
  }
  let prixHote = deps.prixHote
  if (!prixHote) {
    try { prixHote = await prixHoteDuBien(supabase, bien.id, auj, fin) }
    catch (e) { return { ok: false, refus: 'prix_hote_illisibles', message: e.message } }
  }
  const decision = calculerPrix({ aujourdHui: auj, fin, lignes, fermetures, ouverts, prixHote,
    prix: (date, o) => (deps.prix || ((d, oo) => prixDeLaNuit(ctx, d, oo)))(date, o) })
  if (!decision.changements.length) {
    return { ok: true, changees: 0, fin, comptes: decision.comptes, motifs: decision.motifs, ignorees: null }
  }
  const nuits = decision.changements.map(c => ({ date: c.date, prix_centimes: c.prix_centimes }))
  const r = await demander(supabase, bien, { nuits, aujourdHui: auj }, { appel: deps.appel })
  if (!r.ok) return { ok: false, refus: r.refus, message: r.message, fin, comptes: decision.comptes, motifs: decision.motifs, ignorees: r.ignorees }
  // ⚠ COMME A L'OUVERTURE : le writer a deja memorise les prix quand la
  // poussee echoue ; au passage suivant, le diff dirait « inchange » et le
  // provider garderait l'ancien prix pour toujours. Le full sync (500 jours)
  // reconcilie ; on l'enfile, on ne pose pas le marqueur, on le dit.
  if (r.ecrit && r.ecrit.pushFailed) {
    await enfilerFullSync(supabase, bien)
    return { ok: false, refus: 'poussee_refusee', fin, comptes: decision.comptes, motifs: decision.motifs, ignorees: r.ignorees, ecrit: r.ecrit,
      message: `Prix mémorisés mais non poussés au canal (${(r.ecrit.warnings || []).join(' · ') || 'poussée refusée'}) : un full sync est en file.` }
  }
  const ignoreesN = r.ignorees ? Object.values(r.ignorees).reduce((s, t) => s + (t ? t.length : 0), 0) : 0
  return { ok: true, changees: nuits.length - ignoreesN, fin, comptes: decision.comptes, motifs: decision.motifs, ignorees: r.ignorees, ecrit: r.ecrit }
}

module.exports = { calculerPrix, entretenirLesPrix }
