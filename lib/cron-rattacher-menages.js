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
  // ⚠ LE CURSEUR EST LU AVANT D'ETRE REECRIT.
  // Une premiere version upsertait le marqueur de cadence avec
  // `total_messages: 0` — donc le curseur — AVANT de le lire quelques lignes
  // plus bas : `offset` valait toujours 0, la fenetre ne glissait jamais, et le
  // `suivant` ecrit en fin de passage etait ecrase au passage suivant. Aucun
  // avis n'etait saute, mais 200 avis non rattachables en tete bloquaient
  // toujours la file derriere eux — exactement le defaut a corriger.
  const { data: cur } = await sb.from('cron_logs')
    .select('total_messages').eq('id', MARQUEUR).maybeSingle()
  const offset = Number(cur?.total_messages) || 0

  // Marqueur de cadence pose avant le travail, en PRESERVANT le curseur.
  const { error: errMarq } = await sb.from('cron_logs').upsert({
    id: MARQUEUR, last_run: new Date(maintenant()).toISOString(),
    total_messages: offset, total_replies: 0, errors: []
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
  // ⚠ ORDRE STABLE ET FENETRE GLISSANTE.
  // Rien ne marque un avis « examine sans succes » : sans ordre ni curseur, la
  // requete ramenait indefiniment les memes lignes des que LOT_MAX avis
  // atteignaient cet etat, et aucun avis nouveau n'etait plus jamais examine.
  // Le curseur avance sur received_at et repart du debut a chaque cycle
  // complet : un avis non rattachable est reessaye, mais il ne bloque plus la
  // file.
  const { data: avis, error } = await sb.from('ota_reviews')
    .select('id, user_id, booking_uid, property_id_ref')
    .is('menage_event_id', null)
    .not('booking_uid', 'is', null)
    .order('received_at', { ascending: false, nullsFirst: false })
    .range(offset, offset + LOT_MAX - 1)
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
      .select('id, token')
      .eq('user_id', a.user_id)
      .eq('property_id', a.property_id_ref)
      .eq('booking_id', String(a.booking_uid))
      .order('created_at', { ascending: true })
      .limit(20)
    if (e) { bilan.erreurs++; console.error('[rattacher-menages] lecture menage:', e.message); continue }
    if (!menages || !menages.length) { bilan.sans_menage++; continue }

    // ⚠ ON DEPARTAGE PAR TOKEN, PAS PAR NOMBRE DE LIGNES.
    //
    // Une reservation produit PLUSIEURS menage_events : un par prestataire
    // notifiee (sync-menages.js boucle sur les destinataires), un par type
    // d'evenement (new / modified / cancelled), plus les notes manuelles de
    // l'hote. Exiger « exactement une ligne » ne rattachait donc presque rien —
    // mesure sur les donnees reelles : 14 reservations sur 151 ont plusieurs
    // lignes, et le cas a DEUX prestataires sur un meme bien, celui qui motive
    // tout le chantier, en aurait systematiquement.
    //
    // Ce qu'on cherche a savoir, c'est QUI a fait le menage. Toutes ces lignes
    // designent la meme personne tant qu'elles portent le meme token : 151
    // reservations sur 151 sont dans ce cas aujourd'hui.
    //
    // DEUX TOKENS = deux prestataires notifiees : on ne devine pas laquelle a
    // prepare le sejour. La case reste vide, et le passage suivant retentera si
    // la situation se clarifie.
    const tokens = new Set(menages.map(m => m.token).filter(Boolean))
    if (tokens.size !== 1) { bilan.sans_menage++; continue }
    // ⚠ On retient une ligne PORTANT LE TOKEN, pas simplement la premiere.
    // Des lignes a token null peuvent cotoyer celles de la prestataire ; prendre
    // la plus ancienne pouvait designer l'une d'elles, et l'avis aurait alors
    // pointe un menage que l'attribution — qui joint par token — n'aurait jamais
    // reconnu. Avis perdu, jamais mal attribue, mais perdu quand meme.
    const menage = menages.find(m => m.token) || null
    if (!menage) { bilan.sans_menage++; continue }

    const { error: eMaj } = await sb.from('ota_reviews')
      .update({ menage_event_id: menage.id })
      .eq('id', a.id).eq('user_id', a.user_id)
    if (eMaj) { bilan.erreurs++; console.error('[rattacher-menages] update:', eMaj.message) }
    else bilan.rattaches++
  }

  // Avance la fenetre, et repart du debut quand le lot est incomplet — c'est
  // qu'on a atteint la fin de la file.
  const suivant = (avis.length < LOT_MAX) ? 0 : offset + LOT_MAX
  await sb.from('cron_logs').upsert({
    id: MARQUEUR, last_run: new Date(maintenant()).toISOString(),
    total_messages: suivant, total_replies: 0, errors: []
  }, { onConflict: 'id' })

  if (bilan.erreurs > 0) {
    results?.errors?.push({ context: 'rattacher_menages', error: bilan.erreurs + ' rattachements en echec' })
  }
  if (bilan.lus > 0) console.log('[rattacher-menages] bilan', JSON.stringify(bilan))
  if (results) results.totalMenagesRattaches = (results.totalMenagesRattaches || 0) + bilan.rattaches
  return bilan
}

module.exports = { rattacherMenages }
