// lib/cron-rattacher-menages.js
// Rattache un avis au MENAGE qui a precede le sejour (spec-prestataires §6).
//
// C'est la voie NORMALE d'attribution, et la seule pour tout menage futur :
// `prestataire_periodes` n'est qu'une exception bornee a des faits declares.
//
// ⚠ UN AVIS NON RATTACHABLE RESTE NON RATTACHE. On ne prend pas « le menage le
// plus proche » faute de mieux : un menage attribue a tort fait tomber un
// reproche sur la mauvaise personne, ce qui coute plus cher qu'une case vide.

const { supabase } = require('./cron-shared')

const MARQUEUR   = 'rattacher_menages'
const PERIODE_MS = 24 * 60 * 60 * 1000
const LOT_MAX    = 200
const BUDGET_MS  = 15000

async function rattacherMenages (results, deps = {}) {
  const sb = deps.supabase || supabase
  const maintenant = deps.now || (() => Date.now())

  if (!deps.forcer) {
    const { data: m } = await sb.from('cron_logs').select('last_run').eq('id', MARQUEUR).maybeSingle()
    if (m?.last_run && (maintenant() - new Date(m.last_run).getTime()) < PERIODE_MS) {
      return { skipped: 'cadence' }
    }
  }
  const { error: errMarq } = await sb.from('cron_logs').upsert({
    id: MARQUEUR, last_run: new Date(maintenant()).toISOString(),
    total_messages: 0, total_replies: 0, errors: []
  }, { onConflict: 'id' })
  if (errMarq) {
    results?.errors?.push({ context: 'rattacher_menages', error: 'marqueur: ' + errMarq.message })
    return { skipped: 'marqueur_illisible' }
  }

  const bilan = { lus: 0, rattaches: 0, sans_menage: 0, erreurs: 0 }
  const echeance = maintenant() + BUDGET_MS

  // Les avis qui ont une reservation resolue mais pas encore de menage.
  // Ceux sans booking_uid ne sont pas lus : rien ne permettrait de les
  // rattacher, et le poll retente leur resolution a chaque passage.
  const { data: avis, error } = await sb.from('ota_reviews')
    .select('id, user_id, booking_uid, property_id_ref')
    .is('menage_event_id', null)
    .not('booking_uid', 'is', null)
    .limit(LOT_MAX)
  if (error) {
    console.error('[rattacher-menages] lecture echec:', error.message)
    results?.errors?.push({ context: 'rattacher_menages', error: error.message })
    return { ...bilan, interrompu: 'db' }
  }
  if (!avis || !avis.length) return bilan

  for (const a of avis) {
    if (maintenant() > echeance) { bilan.interrompu = 'budget'; break }
    bilan.lus++

    // ⚠ Le menage est cherche sur LE MEME COMPTE et LE MEME BIEN, par le
    // booking_id commun aux deux tables. Chercher par booking_id seul
    // rattacherait l'avis d'un hote au menage d'un autre : `booking_id` n'a
    // aucune unicite globale (REVIEW.md regle 1).
    const { data: menages, error: e } = await sb.from('menage_events')
      .select('id')
      .eq('user_id', a.user_id)
      .eq('property_id', a.property_id_ref)
      .eq('booking_id', String(a.booking_uid))
      .limit(2)
    if (e) { bilan.erreurs++; console.error('[rattacher-menages] lecture menage:', e.message); continue }

    // Zero menage : rien a rattacher. DEUX menages pour la meme reservation :
    // on ne devine pas lequel a prepare le sejour — la case reste vide, et le
    // prochain passage retentera si la situation se clarifie.
    if (!menages || menages.length !== 1) { bilan.sans_menage++; continue }

    const { error: eMaj } = await sb.from('ota_reviews')
      .update({ menage_event_id: menages[0].id })
      .eq('id', a.id).eq('user_id', a.user_id)
    if (eMaj) { bilan.erreurs++; console.error('[rattacher-menages] update:', eMaj.message) }
    else bilan.rattaches++
  }

  if (bilan.erreurs > 0) {
    results?.errors?.push({ context: 'rattacher_menages', error: bilan.erreurs + ' rattachements en echec' })
  }
  if (bilan.lus > 0) console.log('[rattacher-menages] bilan', JSON.stringify(bilan))
  if (results) results.totalMenagesRattaches = (results.totalMenagesRattaches || 0) + bilan.rattaches
  return bilan
}

module.exports = { rattacherMenages }
