// lib/cron-stats.js
// ═══════════════════════════════════════════════════════════════════════════
// LA LIGNE DE MESURE D'UN PASSAGE, ET SA LECTURE EN CLASSEMENT.
//
// Une ligne par passage dans `cron_stats` (cron, date, detail par tache en
// JSON), purgee a 30 jours. Demande de Thierry du 22 octobre 2026 : c'est le
// classement sur 48 h qui decidera du decoupage du cron et de l'ordre
// d'optimisation — pas une intuition de lecture de code.
//
// ⚠ L'ECRITURE NE DOIT JAMAIS FAIRE ECHOUER LE CRON (exigence explicite). Elle
// ne leve donc jamais, et elle n'ATTEND PAS plus de `delaiMs` : une base lente
// ne doit pas manger le budget des 60 s d'un cycle qui, lui, envoie des
// messages au voyageur et cree des codes de serrure. C'est la meme mecanique
// que `lib/ia/journal.js` — et pour la meme raison.
//
// ⚠ LA LECTURE PASSE PAR DEUX FONCTIONS SQL, ET C'EST UNE NECESSITE, PAS UN
// GOUT. A 288 passages par jour pour `cron` et 144 pour `cron-messages`, sept
// jours font plus de 3000 lignes — au-dela de la troncature SILENCIEUSE de
// Supabase a 1000 lignes (le piege nomme au CLAUDE.md), et plusieurs megaoctets
// de JSON a rapatrier pour n'en afficher que dix lignes. L'agregation se fait
// donc dans la base, par `cron_stats_classement` et `cron_stats_par_jour`
// (migrations/2026-10-22-cron-stats.sql), en SECURITY INVOKER : la RLS de la
// table continue de mordre pour la cle publique.
// ═══════════════════════════════════════════════════════════════════════════

const TABLE = 'cron_stats'
const MARQUEUR_PURGE = 'cron-stats-purge'
const JOURS_DE_CONSERVATION = 30
const ECRITURE_MAX_MS = 2500

const absente = (e) => /cron_stats/.test(String(e && e.message))
  && /(does not exist|schema cache|not find)/i.test(String(e && e.message))
let absenceDite = false

function direLAbsenceUneFois (quoi) {
  if (absenceDite) return
  absenceDite = true
  console.error(`[cron-stats] ${quoi} absent : migration 2026-10-22-cron-stats non appliquee`)
}

/**
 * Ecrit le detail d'un passage. Ne leve JAMAIS, n'attend pas plus de `delaiMs`.
 * Rend { ok, raison } — jamais une exception, jamais un rejet.
 */
async function ecrireLePassage (sb, detail, { delaiMs = ECRITURE_MAX_MS, maintenant = Date.now } = {}) {
  let minuteur
  try {
    if (!detail || !detail.cron) return { ok: false, raison: 'detail_vide' }
    const ligne = {
      cron: detail.cron,
      commence_le: detail.commence_le || new Date(maintenant()).toISOString(),
      termine_le: new Date(maintenant()).toISOString(),
      duree_ms: Math.round(detail.duree_ms || 0),
      requetes: detail.requetes || 0,
      appels_externes: detail.appels_externes || 0,
      taches: detail.taches || [],
      totaux: detail.totaux || null,
    }
    const enRetard = new Promise(resolve => { minuteur = setTimeout(() => resolve({ enRetard: true }), delaiMs) })
    const r = await Promise.race([sb.from(TABLE).insert(ligne), enRetard])
    if (r && r.enRetard) {
      console.error(`[cron-stats] ecriture en retard (> ${delaiMs} ms) : le cycle continue sans l attendre`)
      return { ok: false, raison: 'en_retard' }
    }
    const { error } = r || {}
    if (!error) return { ok: true }
    if (absente(error)) { direLAbsenceUneFois('la table cron_stats'); return { ok: false, raison: 'table_absente' } }
    console.error('[cron-stats] passage non journalise :', error.message)
    return { ok: false, raison: 'erreur' }
  } catch (e) {
    console.error('[cron-stats] passage non journalise :', e && e.message)
    return { ok: false, raison: 'exception' }
  } finally { clearTimeout(minuteur) }
}

/**
 * Purge a 30 jours, UNE FOIS PAR JOUR (marqueur `cron_logs`, meme mecanique
 * que la purge des tentatives). Sans marqueur, le `delete` repartirait a
 * chacun des 288 ticks quotidiens : une requete de plus par passage, dans le
 * compteur meme qu'on est en train de mesurer.
 * Ne leve jamais.
 */
async function purgerSiDue (sb, { maintenant = Date.now, jours = JOURS_DE_CONSERVATION } = {}) {
  try {
    const { data } = await sb.from('cron_logs').select('last_run').eq('id', MARQUEUR_PURGE).maybeSingle()
    const dernier = data && data.last_run ? new Date(data.last_run) : null
    const now = new Date(maintenant())
    if (dernier && now - dernier < 24 * 3600 * 1000) return { purgees: 0, saute: true }

    const limite = new Date(now.getTime() - jours * 24 * 3600 * 1000).toISOString()
    const { error } = await sb.from(TABLE).delete().lt('commence_le', limite)
    if (error) {
      if (absente(error)) { direLAbsenceUneFois('la table cron_stats'); return { purgees: 0, raison: 'table_absente' } }
      console.error('[cron-stats] purge en echec :', error.message)
      return { purgees: 0, raison: 'erreur' }
    }
    // ⚠ Marqueur ECRIT et son echec DIT : un marqueur muet fait repartir la
    // purge a chaque tick, et personne ne le verrait (lecon de la purge des
    // tentatives, constat de review).
    const { error: errMarqueur } = await sb.from('cron_logs').upsert({
      id: MARQUEUR_PURGE, last_run: now.toISOString(),
      total_messages: 0, total_replies: 0, errors: []
    }, { onConflict: 'id' })
    if (errMarqueur) console.error('[cron-stats] marqueur de purge non ecrit :', errMarqueur.message)
    return { purgees: null, faite: true, avant: limite }
  } catch (e) {
    console.error('[cron-stats] purge en echec :', e && e.message)
    return { purgees: 0, raison: 'exception' }
  }
}

/**
 * Le classement des taches sur une fenetre : trie par REQUETES puis par TEMPS
 * (l'ordre demande), avec le total par jour.
 * ⚠ `ms` est la somme des `ms_seul` : la seule qui ne compte pas deux fois le
 * temps d'une tache emboitee (lib/metriques-cron.js).
 */
async function classement (sb, { heures = 24, cron = null, limite = 10, maintenant = Date.now } = {}) {
  const depuis = new Date(maintenant() - heures * 3600 * 1000).toISOString()
  const rep = await sb.rpc('cron_stats_classement', { depuis, quel_cron: cron })
  if (rep.error) {
    const fonctionAbsente = /not find|does not exist|schema cache/i.test(String(rep.error.message))
    return {
      ok: false, depuis,
      raison: fonctionAbsente ? 'migration_non_appliquee' : 'erreur',
      detail: rep.error.message,
    }
  }
  const lignes = (rep.data || []).map(l => ({
    cron: l.cron, tache: l.tache,
    passages: Number(l.passages) || 0,
    appels: Number(l.appels) || 0,
    ms: Number(l.ms) || 0,
    requetes: Number(l.requetes) || 0,
    externes: Number(l.externes) || 0,
    travail: Number(l.travail) || 0,
  }))
  // ⚠ TRI DEMANDE : requetes d'abord, temps ensuite. Le temps seul designe les
  // taches qui ATTENDENT un partenaire ; les requetes designent celles qui
  // chargent la base — et c'est la base qui est le sujet du decoupage.
  lignes.sort((a, b) => (b.requetes - a.requetes) || (b.ms - a.ms) || a.tache.localeCompare(b.tache))

  const parJour = await sb.rpc('cron_stats_par_jour', { depuis })
  const jours = parJour.error ? [] : (parJour.data || []).map(j => ({
    jour: j.jour, cron: j.cron,
    passages: Number(j.passages) || 0,
    ms: Number(j.ms) || 0,
    requetes: Number(j.requetes) || 0,
    externes: Number(j.externes) || 0,
  })).sort((a, b) => String(b.jour).localeCompare(String(a.jour)) || a.cron.localeCompare(b.cron))

  return {
    ok: true, depuis, heures,
    taches: lignes.length,
    classement: Number.isFinite(limite) && limite > 0 ? lignes.slice(0, limite) : lignes,
    par_jour: jours,
    par_jour_erreur: parJour.error ? parJour.error.message : undefined,
  }
}

/**
 * Le dernier passage de chaque cron, detail compris : de quoi lire UN cycle
 * pendant la mesure, sans attendre l'agregat.
 * ⚠ Lecture BORNEE (`limit`), comme toute lecture du depot.
 */
async function derniersPassages (sb, { combien = 6 } = {}) {
  const { data, error } = await sb.from(TABLE)
    .select('cron, commence_le, duree_ms, requetes, appels_externes, taches, totaux')
    .order('commence_le', { ascending: false })
    .limit(combien)
  if (error) {
    if (absente(error)) { direLAbsenceUneFois('la table cron_stats'); return { ok: false, raison: 'table_absente' } }
    return { ok: false, raison: 'erreur', detail: error.message }
  }
  const vus = new Map()
  for (const l of (data || [])) if (!vus.has(l.cron)) vus.set(l.cron, l)
  return { ok: true, passages: [...vus.values()] }
}

module.exports = {
  ecrireLePassage, purgerSiDue, classement, derniersPassages,
  TABLE, MARQUEUR_PURGE, JOURS_DE_CONSERVATION, ECRITURE_MAX_MS,
}
