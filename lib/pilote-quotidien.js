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

  // 2. L'ouverture, avec le prix de la regle quand elle sait le dire.
  // (`deps.prix` : la regle injectee par les tests ; sinon celle de l'ecran.)
  const regle = deps.prix || ((c, d, o) => prixDeLaNuit(c, d, o))
  const prixCalcule = new Map()
  if (ctx) {
    for (let j = auj, n = 0; j <= fin && n < 5000; j = decalerJour(j, 1), n++) {
      const s = regle(ctx, j, { ouverte: true })
      if (s && s.prix != null) prixCalcule.set(j, Math.round(Number(s.prix) * 100))
    }
  }
  const ouverture = await ouvrirLaFenetreDuBien(supabase, bien, {
    aujourdHui: auj, appel: deps.appel, demander: deps.demander, prixCalcule, fermetures
  })

  // 3. Les prix des nuits ouvertes — apres l'ouverture, pour que les nuits
  // qui viennent de s'ouvrir soient relues avec leur ligne.
  let prix = null
  if (ctx) {
    prix = await entretenirLesPrix(supabase, bien, {
      aujourdHui: auj, appel: deps.appel, demander: deps.demander, ctx, fermetures,
      lignes: await relireMemoire(supabase, bien, auj, fin),
      prix: (d, o) => regle(ctx, d, o)
    })
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
async function alarmerSurLePassage (bien, r, deps) {
  const envoyer = alerter(deps)
  const base = { userId: bien.user_id, propertyId: bien.id, propertyName: bien.name, fenetreMs: 24 * 3600 * 1000 }
  const alarmes = []
  const o = r.ouverture, p = r.prix
  if ((o && o.refus === 'poussee_refusee') || (p && p.refus === 'poussee_refusee')) {
    alarmes.push(['pilote_poussee_refusee', (o && o.refus === 'poussee_refusee' ? o.message : p.message)])
  }
  if (o && o.comptes && o.comptes.sans_prix > 0) {
    alarmes.push(['pilote_sans_prix', `${o.comptes.sans_prix} nuit(s) de la fenêtre sans prix : ni mémoire, ni prix de base. Elles restent fermées.`])
  }
  if (p && p.ok && p.comptes) {
    const c = p.comptes
    const tarifables = c.calculees + c.non_calculables + c.sous_plancher
    if (tarifables >= 7 && c.calculees === 0) {
      const detail = Object.entries(p.motifs || {}).map(([m, n]) => `${m}: ${n}`).join(', ')
      alarmes.push(['pilote_regle_muette', `Aucune des ${tarifables} nuits ouvertes n'est tarifable par la règle (${detail}). Les prix en place restent.`])
    }
  }
  for (const [type, message] of alarmes) {
    try { await envoyer(type, { ...base, detail: message }) }
    catch (e) { console.error('[pilote] alarme non envoyee', type, e.message) }
  }
  return alarmes.map(a => a[0])
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
      const r = await piloterLeBien(supabase, bien, { ...deps, aujourdHui: auj })
      const o = r.ouverture || {}, p = r.prix || {}
      console.log(`[pilote] ${bien.name} (${bien.id}) fenetre ${fenetre.valeur} ${fenetre.type} : ouverture ${o.ok ? `${o.ouvertes} ouverte(s)` : `REFUS ${o.refus}`} ${JSON.stringify(o.comptes || {})} | prix ${p.ok ? `${p.changees} changé(s)` : `REFUS ${p.refus}`} ${JSON.stringify(p.comptes || {})}`)
      bilan.details.push({ bien: bien.id, nom: bien.name, ...r })
      if (r.ouverture && r.ouverture.ok) bilan.ouvertes += r.ouverture.ouvertes
      if (r.prix && r.prix.ok) bilan.prix_changes += r.prix.changees
      bilan.alarmes.push(...(await alarmerSurLePassage(bien, r, deps)).map(t => ({ bien: bien.id, type: t })))
      if (!r.ok) {
        bilan.erreurs.push({ bien: bien.id, refus: (r.ouverture && !r.ouverture.ok ? r.ouverture.refus : (r.prix && r.prix.refus)) || r.refus,
          error: (r.ouverture && !r.ouverture.ok ? r.ouverture.message : (r.prix && r.prix.message)) || r.message })
        continue
      }
      bilan.traites++
      await poserMarqueur(supabase, bien.id, maintenant(), {
        fenetre, fin: r.fin, ouvertes: r.ouverture.ouvertes, comptes: r.ouverture.comptes,
        prix: { changees: r.prix.changees, comptes: r.prix.comptes, motifs: r.prix.motifs }
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
