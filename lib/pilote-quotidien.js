// lib/pilote-quotidien.js — LE RYTHME QUOTIDIEN DU MODE AUTO-PILOTE (lot 4.6.5).
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter (§1, §6, « 4.6.5 livre »).
// Ouverture : lib/moteur-ouverture.js — Prix : lib/moteur-prix.js
// Matiere : lib/yield/contexte-du-bien.js — Alarmes : lib/founder-notify.js
//
// CE QU'IL FAIT, une fois par jour et par bien pilote, un bien par tick du
// cron (5 min), dans cet ordre :
//   1. la MATIERE, lue une fois (grille, contexte, pression, ouverture,
//      nuits vendues) ;
//   2. l'OUVERTURE : les nuits de la fenetre sur lesquelles personne n'a rien
//      decide s'ouvrent, AVEC le prix que la regle leur donne (sinon la
//      memoire, sinon le prix de base) ;
//   3. les PRIX : chaque nuit ouverte est recalculee, et seuls les prix qui
//      CHANGENT sont demandes — le delta, jamais le calendrier entier ;
//   4. le MARQUEUR, pose apres le travail, avec le bilan des deux moteurs ;
//   5. les ALARMES, au fondateur, par `reportIncident` (persistees, anti-spam
//      24 h) — jamais pour un fait normal.
//
// ⚠ DELTA ARI, PAR CONSTRUCTION. Le canal ne recoit que les nuits a ouvrir
// et les prix qui changent ; le writer ne pousse que ce qu'on lui demande.
// Un jour sans changement ne pousse rien. Le full sync (500 jours) reste la
// reconciliation de secours, en file, quand une poussee a echoue.
//
// ⚠ CE QUI ALARME, ET CE QUI N'ALARME PAS :
//   - `pilote_poussee_refusee` : une ouverture ou des prix memorises mais non
//     poussés — la memoire et le provider divergent, un full sync est en file ;
//   - `pilote_sans_prix` : des nuits que le moteur ne peut pas ouvrir faute de
//     prix (ni memoire, ni prix de base) — l'hote a un geste a faire ;
//   - `pilote_regle_muette` : la regle ne sait tarifer AUCUNE nuit ouverte
//     (grille non fiable, historique trop mince) — les prix restent ceux en
//     place, et quelqu'un doit le savoir ;
//   - `pilote_en_retard` : un bien pilote dont le dernier passage date de plus
//     de 36 h — le cron ne passe plus, ou ce bien echoue a chaque tick.
//   Une nuit non calculable parmi d'autres, une indisponibilite, une nuit
//   fermee a la main : pas une alarme. C'est le bilan a l'ecran qui le dit.

const { ouvrirLaFenetreDuBien } = require('./moteur-ouverture')
const { entretenirLesPrix } = require('./moteur-prix')
const { preparerContexte, prixDeLaNuit } = require('./yield/contexte-du-bien')
const { fermeturesDuBien } = require('./fermetures')
const { fenetreDuBien, finDeFenetre } = require('./pilote-tarifaire')
const { joursOuverts } = require('./yield/capacite')
const { jourParis, lireMarqueur, aTourneAujourdhui, poserMarqueur } = require('./ouverture-marqueur')

const BUDGET_MS = 20000
const BIENS_PAR_PASSAGE = 1
const RETARD_MS = 36 * 3600 * 1000
const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/

let reportIncidentReel = null
function alerter (deps) {
  if (typeof deps.alerter === 'function') return deps.alerter
  if (!reportIncidentReel) reportIncidentReel = require('./founder-notify').reportIncident
  return reportIncidentReel
}

// ─── UN BIEN : matiere, ouverture, prix ─────────────────────────────────────
async function piloterLeBien (supabase, bien, deps = {}) {
  const auj = deps.aujourdHui
  const fin = finDeFenetre(bien, auj)
  if (!fin) return { ok: false, refus: 'fenetre_non_reglee', message: 'Fenêtre non réglée.' }

  let fermetures
  try { fermetures = await fermeturesDuBien(supabase, bien.id, auj, fin) }
  catch (e) { return { ok: false, refus: 'fermetures_illisibles', message: e.message } }

  // 1. La matiere. Un contexte illisible n'empeche PAS l'ouverture : elle
  // retombe sur la memoire et le prix de base, comme au 4.6.3, et le dit.
  let ctx = null, contexteErreur = null
  try { ctx = await (deps.preparer || preparerContexte)(supabase, bien, bien.user_id, { aujourdHui: auj, debut: auj, fin }) }
  catch (e) { contexteErreur = e.message }

  // 2. La regle, UNE fois par nuit (releve en review : elle tournait deux
  // fois). `deps.prix` : la regle injectee par les tests ; sinon l'ecran.
  const regle = deps.prix || ((c, d, o) => prixDeLaNuit(c, d, o))
  const resultats = new Map()
  const prixCalcule = new Map()
  let venduesCtx = null
  if (ctx) {
    const unites = Math.max(1, Number(bien.inventory_units) || 1)
    venduesCtx = new Set(Object.entries(ctx.vendues || {}).filter(([, s]) => (s || []).length >= unites).map(([d]) => d))
    for (let j = auj, n = 0; j <= fin && n < 5000; j = decalerJour(j, 1), n++) {
      const s = regle(ctx, j, { ouverte: true, vendue: venduesCtx.has(j) })
      resultats.set(j, s)
      if (s && s.prix != null) prixCalcule.set(j, Math.round(Number(s.prix) * 100))
    }
  }

  // 3. L'ouverture, au prix de la regle quand elle sait le dire.
  const ouverture = await ouvrirLaFenetreDuBien(supabase, bien, {
    aujourdHui: auj, appel: deps.appel, demander: deps.demander, prixCalcule, fermetures, vendues: venduesCtx
  })
  if (!ouverture.ok) return { ok: false, fin, ouverture, prix: null, contexte_illisible: contexteErreur }

  // ⚠ LE BUDGET SE VERIFIE ENTRE LES ETAPES (releve en review) : une premiere
  // ouverture de 500 nuits peut a elle seule manger le budget ; les prix
  // attendent le tick suivant (l'ouverture, elle, est faite et idempotente).
  if (typeof deps.tempsRestant === 'function' && deps.tempsRestant() <= 0) {
    return { ok: false, fin, ouverture, prix: { ok: false, refus: 'budget_epuise', message: 'Budget du passage épuisé après l\'ouverture : les prix au tick suivant.' }, contexte_illisible: contexteErreur }
  }

  // 4. Les prix des nuits ouvertes — apres l'ouverture, memoire relue, et
  // l'ouverture classee PAR LA CAPACITE (la meme regle que l'ecran).
  let prix = null
  if (ctx) {
    const lignes = await relireMemoire(supabase, bien, auj, fin)
    const cap = await joursOuverts(supabase, bien, auj, fin, { aujourdHui: auj, estimerLePasse: false, lignes })
    const ouverts = cap && cap.calculable && cap.detail ? new Set(cap.detail) : null
    prix = await entretenirLesPrix(supabase, bien, {
      aujourdHui: auj, appel: deps.appel, demander: deps.demander, ctx, fermetures, lignes, ouverts,
      prix: (d, o) => resultats.has(d) ? resultats.get(d) : regle(ctx, d, o)
    })
    if (ouverts == null && prix.ok) prix = { ok: false, refus: 'ouverture_inconnue', message: `Capacité non calculable (${cap && cap.raison}) : aucun prix posé.`, fin }
  } else {
    prix = { ok: false, refus: 'contexte_illisible', message: contexteErreur }
  }
  return { ok: ouverture.ok && prix.ok, fin, ouverture, prix, contexte_illisible: contexteErreur }
}

function decalerJour (jour, n) {
  const d = new Date(`${jour}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function relireMemoire (supabase, bien, auj, fin) {
  const lignes = []
  for (let debut = auj; debut <= fin; debut = decalerJour(debut, 500)) {
    const finPage = decalerJour(debut, 499) < fin ? decalerJour(debut, 499) : fin
    const { data, error } = await supabase.from('calendar_inventory')
      .select('date, rate, avail, stop_sell').eq('property_id', bien.id).gte('date', debut).lte('date', finPage)
    if (error) throw new Error(`calendar_inventory : ${error.message}`)
    lignes.push(...(data || []))
  }
  return lignes
}

// ─── LES ALARMES D'UN PASSAGE ───────────────────────────────────────────────
// ⚠ SUR TRANSITION, PAS SUR ETAT — releve en review. « Sans prix », « regle
// muette » et « matiere illisible » sont des ETATS d'un bien neuf ou mal
// regle : ils reviendraient chaque jour, et le fondateur apprendrait a les
// ignorer (235 e-mails du 18 septembre). On alarme quand l'etat APPARAIT (il
// n'etait pas dans le bilan du passage precedent), pas quand il persiste. Le
// message est STABLE (pas de compteur dedans : l'anti-spam compare le texte),
// les chiffres voyagent a cote.
function etatsDuPassage (r) {
  const o = r && r.ouverture, p = r && r.prix
  const etats = new Set()
  if ((o && o.refus === 'poussee_refusee') || (p && p.refus === 'poussee_refusee')) etats.add('pilote_poussee_refusee')
  if (o && o.comptes && o.comptes.sans_prix > 0) etats.add('pilote_sans_prix')
  if (p && p.ok && p.comptes) {
    const c = p.comptes
    if (c.calculees + c.non_calculables + c.sous_plancher >= 7 && c.calculees === 0) etats.add('pilote_regle_muette')
  }
  if (p && (p.refus === 'contexte_illisible' || p.refus === 'ouverture_inconnue')) etats.add('pilote_matiere_illisible')
  return etats
}
const MESSAGES = {
  pilote_poussee_refusee: 'Ouverture ou prix mémorisés mais non poussés au canal : un full sync est en file. Vérifier Channex.',
  pilote_sans_prix: 'Des nuits de la fenêtre restent fermées faute de prix : ni mémoire, ni prix de base. Renseigner un prix de base.',
  pilote_regle_muette: 'Aucune nuit ouverte n\'est tarifable par la règle (historique trop mince ou grille non fiable) : les prix en place restent.',
  pilote_matiere_illisible: 'La matière du prix est illisible (historique, capacité) : ouverture faite, prix non entretenus.'
}
async function alarmerSurLePassage (bien, r, deps, precedent = null) {
  const envoyer = alerter(deps)
  const base = { userId: bien.user_id, propertyId: bien.id, propertyName: bien.name, fenetreMs: 7 * 24 * 3600 * 1000 }
  const maintenant = etatsDuPassage(r)
  const avant = precedent && Array.isArray(precedent.etats) ? new Set(precedent.etats) : new Set()
  const nouvelles = [...maintenant].filter(t => !avant.has(t) || t === 'pilote_poussee_refusee')
  for (const type of nouvelles) {
    const o = r.ouverture || {}, p = r.prix || {}
    const chiffres = { ouverture: o.comptes || null, prix: p.comptes || null, motifs: p.motifs || null, refus: (o.refus || p.refus || null) }
    try { await envoyer(type, { ...base, detail: { message: MESSAGES[type], ...chiffres } }) }
    catch (e) { console.error('[pilote] alarme non envoyee', type, e.message) }
  }
  return { envoyees: nouvelles, etats: [...maintenant] }
}

// ─── LA SONDE DE RETARD ─────────────────────────────────────────────────────
// Un bien pilote dont le dernier passage date de plus de 36 h : le cron ne
// passe plus, ou ce bien echoue a chaque tick. Une fois par jour.
async function sonderLesRetards (supabase, biens, deps, maintenantMs) {
  const envoyer = alerter(deps)
  const retards = []
  for (const bien of biens) {
    const m = await lireMarqueur(supabase, bien.id)
    if (!m) continue   // jamais passe : c'est l'activation, pas un retard
    if (maintenantMs - Date.parse(m.derniere) > RETARD_MS) {
      retards.push(bien.id)
      try {
        await envoyer('pilote_en_retard', { userId: bien.user_id, propertyId: bien.id, propertyName: bien.name, fenetreMs: 24 * 3600 * 1000,
          detail: `Dernier passage du pilote YieldFlow : ${m.derniere}. Ni ouverture ni prix depuis plus de 36 h.` })
      } catch (e) { console.error('[pilote] alarme retard non envoyee', e.message) }
    }
  }
  return retards
}

// ─── TOUS LES BIENS, UN PAR TICK, UNE FOIS PAR JOUR ──────────────────────────
async function piloterLesBiens (supabase, deps = {}) {
  const maintenant = typeof deps.maintenant === 'function' ? deps.maintenant : () => Date.now()
  const auj = JOUR_RE.test(String(deps.aujourdHui || '')) ? deps.aujourdHui : jourParis(new Date(maintenant()))
  const budget = deps.budgetMs || BUDGET_MS
  const parPassage = deps.biensParPassage || BIENS_PAR_PASSAGE
  const t0 = maintenant()
  const tempsRestant = () => budget - (maintenant() - t0)
  const bilan = { jour: auj, biens: 0, traites: 0, ouvertes: 0, prix_changes: 0, sautes: 0, reportes: 0, erreurs: [], alarmes: [], retards: [], details: [] }
  const { data: biens, error } = await supabase.from('properties').select('*')
    .eq('pilote_tarifaire', 'yieldflow').not('pilote_fenetre_type', 'is', null).not('pilote_fenetre_valeur', 'is', null)
    .order('id')
  if (error) { bilan.erreurs.push({ context: 'lecture_biens', error: error.message }); return bilan }
  const pilotes = (biens || []).filter(b => fenetreDuBien(b))
  bilan.biens = pilotes.length
  for (const bien of pilotes) {
    const fenetre = fenetreDuBien(bien)
    if (maintenant() - t0 > budget || bilan.traites + bilan.erreurs.length >= parPassage) { bilan.reportes++; continue }
    if (await aTourneAujourdhui(supabase, bien.id, auj, fenetre)) { bilan.sautes++; continue }
    try {
      const precedent = await lireMarqueur(supabase, bien.id)
      const r = await piloterLeBien(supabase, bien, { ...deps, aujourdHui: auj, tempsRestant })
      const o = r.ouverture || {}, p = r.prix || {}
      console.log(`[pilote] ${bien.name} (${bien.id}) fenetre ${fenetre.valeur} ${fenetre.type} : ouverture ${o.ok ? `${o.ouvertes} ouverte(s)` : `REFUS ${o.refus}`} ${JSON.stringify(o.comptes || {})} | prix ${p.ok ? `${p.changees} changé(s)` : `REFUS ${p.refus}`} ${JSON.stringify(p.comptes || {})}`)
      bilan.details.push({ bien: bien.id, nom: bien.name, ...r })
      if (o.ok) bilan.ouvertes += o.ouvertes
      if (p.ok) bilan.prix_changes += p.changees
      const al = await alarmerSurLePassage(bien, r, deps, precedent && precedent.bilan)
      bilan.alarmes.push(...al.envoyees.map(t => ({ bien: bien.id, type: t })))
      // ⚠ LE MARQUEUR SE POSE DES QUE L'OUVERTURE EST FAITE (releve en review).
      // Une matiere illisible ou une capacite non calculable retentee a chaque
      // tick rejouerait 288 fois par jour la pagination de tout le compte ; les
      // prix attendent le lendemain, l'etat est alarme (transition) et lisible
      // a l'ecran. Une poussee refusee ou un budget epuise, eux, se retentent
      // au tick suivant : l'ouverture y est idempotente et rapide.
      const retenter = !o.ok || p.refus === 'poussee_refusee' || p.refus === 'budget_epuise'
      if (retenter) {
        bilan.erreurs.push({ bien: bien.id, refus: !o.ok ? o.refus : p.refus, error: !o.ok ? o.message : p.message })
        continue
      }
      if (!p.ok) bilan.erreurs.push({ bien: bien.id, refus: p.refus, error: p.message, marqueur: 'pose' })
      bilan.traites++
      await poserMarqueur(supabase, bien.id, maintenant(), {
        fenetre, fin: r.fin, ouvertes: o.ouvertes, comptes: o.comptes, etats: al.etats,
        prix: p.ok ? { changees: p.changees, comptes: p.comptes, motifs: p.motifs } : { refus: p.refus, message: p.message }
      })
    } catch (e) {
      bilan.erreurs.push({ bien: bien.id, error: e.message })
    }
  }
  // La sonde de retard, une fois par jour, sur TOUS les biens pilotes.
  if (deps.sonderRetards !== false) {
    const { data: s } = await supabase.from('cron_logs').select('last_run').eq('id', 'pilote:sonde-retard').maybeSingle()
    if (!s || !s.last_run || jourParis(new Date(s.last_run)) !== auj) {
      bilan.retards = await sonderLesRetards(supabase, pilotes, deps, maintenant())
      await supabase.from('cron_logs').upsert({ id: 'pilote:sonde-retard', last_run: new Date(maintenant()).toISOString(), total_messages: 0, total_replies: 0, errors: [] })
    }
  }
  return bilan
}

module.exports = { piloterLesBiens, piloterLeBien, alarmerSurLePassage, sonderLesRetards, BUDGET_MS, BIENS_PAR_PASSAGE, RETARD_MS }
