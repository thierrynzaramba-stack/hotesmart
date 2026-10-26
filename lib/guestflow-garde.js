// lib/guestflow-garde.js
//
// LE GARDE-FOU DES APPELS IA DE L'AGENT GUESTFLOW (incident du 8 octobre 2026).
//
// Vecu : quatre fils (trois sur Ofuro Futari, en pause volontaire, un sur Cœur
// de vie 23) etaient reclasses par l'IA a CHAQUE cycle de 5 minutes, sans que
// rien ne les marque traites — 48 appels par heure sur Sonnet 5.5, jusqu'a
// epuiser le credit Anthropic ; puis 264 incidents `api_credit` en une
// journee, un par appel en echec, chaque echec rejoue au cycle suivant.
//
// Deux regles, quoi qu'il arrive en aval :
//   1. PLAFOND : au plus 3 appels IA REUSSIS par fil (reservation) sur 24
//      heures glissantes (les echecs n'y comptent pas : une coupure de credit
//      ne doit pas bloquer les fils 24 h apres la recharge — revue de ecce019). Atteint, il est SIGNALE (un incident par fil et par jour)
//      et le fil attend : c'est l'hote qui reprend la main.
//   2. DELAI CROISSANT apres un echec : 5 min, 10, 20, 40… plafonne a 6 h. Un
//      echec (credit coupe compris) n'est jamais rejoue a chaque cycle.
//
// ⚠ LE JOURNAL EST LA PREUVE : `guestflow_appels_ia`, une ligne par appel
// (fil, modele, succes ou erreur). Il dit enfin combien d'appels partent par
// heure et avec quel modele — ce que le cron ne journalisait pas.
// ⚠ TABLE ABSENTE (migration en retard) : on laisse passer et on le DIT, une
// fois par cycle — couper l'agent parce qu'une migration manque serait pire.
// Toute AUTRE panne de lecture : on n'appelle pas ce cycle-ci (prudence : on ne
// sait pas si le plafond est atteint).

const PLAFOND_JOUR = 3
const FENETRE_MS = 24 * 3600 * 1000
const DELAI_BASE_MS = 5 * 60 * 1000
const DELAI_MAX_MS = 6 * 3600 * 1000
const TABLE = 'guestflow_appels_ia'
// Assez de lignes pour voir 3 succes entre des echecs (un echec est retente au
// plus toutes les 5 min, puis de plus en plus rarement : quelques dizaines sur
// 24 h au plus).
const LECTURE_MAX = 50

const tableAbsente = (e) => /guestflow_appels_ia/.test(String(e && e.message)) && /(does not exist|schema cache)/i.test(String(e && e.message))

// Le delai apres `echecs` echecs consecutifs (1 → 5 min, 2 → 10 min…).
function delaiApresEchecs (echecs) {
  if (echecs <= 0) return 0
  return Math.min(DELAI_MAX_MS, DELAI_BASE_MS * 2 ** (echecs - 1))
}

/**
 * Decide si l'agent peut appeler l'IA pour ce fil. Pure sur les lignes lues.
 * @param lignes  appels du fil sur 24 h, du plus recent au plus ancien : [{ ok, created_at }]
 * @returns { ok: true } | { ok: false, motif: 'plafond' | 'attente_echec', prochain? }
 */
function decider (lignes, maintenant) {
  if (lignes.filter(l => l.ok).length >= PLAFOND_JOUR) return { ok: false, motif: 'plafond' }
  let echecs = 0
  for (const l of lignes) { if (l.ok) break; echecs++ }
  if (echecs) {
    const prochain = Date.parse(lignes[0].created_at) + delaiApresEchecs(echecs)
    if (maintenant < prochain) return { ok: false, motif: 'attente_echec', prochain: new Date(prochain).toISOString() }
  }
  return { ok: true }
}

/**
 * ⚠ `enPause` EST UNE FONCTION, PAS UN BOOLEEN, ET C'EST VOULU : elle n'est
 * appelee QUE si le plafond est atteint. `isAutomationPaused` fait une lecture
 * Supabase par appel (aucun cache), et la consulter a chaque cycle pour chaque
 * fil ajouterait une requete par fil pour une information qui ne sert qu'au
 * moment de signaler.
 */
async function peutAppeler (sb, { userId, propertyId, bookingId, results = null, maintenant = Date.now(), signaler = null, enPause = null }) {
  const { data, error } = await sb.from(TABLE).select('ok, created_at')
    .eq('user_id', userId).eq('booking_id', String(bookingId))
    .gte('created_at', new Date(maintenant - FENETRE_MS).toISOString())
    .order('created_at', { ascending: false }).limit(LECTURE_MAX)
  if (error) {
    if (tableAbsente(error)) {
      if (results && !results.guestflowJournalAbsent) {
        results.guestflowJournalAbsent = true
        results.errors?.push({ context: 'guestflow_journal_absent', error: 'migration 2026-10-08-guestflow-appels-ia non appliquee : plafond et delai inactifs' })
      }
      return { ok: true, journal: false }
    }
    results?.errors?.push({ context: 'guestflow_garde_lecture', booking_id: String(bookingId), error: error.message })
    return { ok: false, motif: 'lecture' }
  }
  const d = decider(data || [], maintenant)
  if (!d.ok && d.motif === 'plafond' && typeof signaler === 'function') {
    // ⚠ UN BIEN EN PAUSE VOLONTAIRE N'EST PAS SIGNALE (vecu du 26 octobre 2026,
    // Ofuro Futari, en pause depuis le 6 octobre par decision de Thierry).
    // L'incident dit « il s'arrete sur ce fil, repondez au voyageur a la main »
    // — or en pause, l'hote repond a la main a CHAQUE message, par definition :
    // le kill switch coupe tout l'automatique sortant. L'alerte ne lui apprend
    // donc rien, et elle le reveille sur un bien qu'il a fait taire exprès.
    //
    // ⚠ CE QUI N'EST PAS RETIRE, ET C'EST LA MOITIE QUI COMPTE : le PLAFOND
    // s'applique quand meme — aucun 4e appel — et la tache VISIBLE de l'hote
    // est posee par l'appelant comme pour tout autre bien. On retire le
    // reveil, pas la garde ni la trace. Un message de voyageur ne disparait
    // jamais parce qu'un bien est en pause.
    const pause = typeof enPause === 'function' ? await enPause() : false
    if (pause) {
      console.log(`[guestflow-garde] plafond atteint booking ${bookingId} — bien en pause, aucun incident`)
    } else {
      await signalerPlafond(sb, { userId, propertyId, bookingId, maintenant, signaler })
    }
  }
  return { ...d, journal: true }
}

// Un incident par fil et par jour (jamais un par cycle).
async function signalerPlafond (sb, { userId, propertyId, bookingId, maintenant, signaler }) {
  try {
    const { data, error } = await sb.from('automation_incidents').select('id')
      .eq('type', 'guestflow_plafond').eq('user_id', userId).eq('detail->>booking_id', String(bookingId))
      .gte('created_at', new Date(maintenant - FENETRE_MS).toISOString()).limit(1)
    // Lecture impossible : on ne signale pas (un fil retenu le serait a chaque
    // cycle) ; la tache visible de l'hote, elle, est posee.
    if (error) { console.error('[guestflow-garde] incidents illisibles :', error.message); return }
    if (data && data.length) return
    await signaler('guestflow_plafond', {
      userId, propertyId: String(propertyId), threshold: 1, fenetreMs: FENETRE_MS,
      detail: { booking_id: String(bookingId),
        message: `L'agent a deja appele l'IA ${PLAFOND_JOUR} fois en 24 h pour la reservation ${bookingId} : il s'arrete sur ce fil. Repondez au voyageur a la main.` },
    })
  } catch (e) { console.error('[guestflow-garde] plafond non signale :', e.message) }
}

// Une ligne par appel. Fail-safe : ne leve jamais.
async function noterAppel (sb, { userId, propertyId, bookingId, ok, modele = null, erreur = null }) {
  try {
    const { error } = await sb.from(TABLE).insert({
      user_id: userId, property_id: String(propertyId), booking_id: String(bookingId),
      ok: Boolean(ok), modele, erreur: erreur ? String(erreur).slice(0, 300) : null,
    })
    if (error && !tableAbsente(error)) console.error('[guestflow-garde] appel non note :', error.message)
  } catch (e) { console.error('[guestflow-garde] appel non note :', e.message) }
}

module.exports = { peutAppeler, noterAppel, decider, delaiApresEchecs, PLAFOND_JOUR, DELAI_MAX_MS }
