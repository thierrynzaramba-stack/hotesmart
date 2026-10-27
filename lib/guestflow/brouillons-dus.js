// lib/guestflow/brouillons-dus.js
// LA PASSE QUI FAIT PARTIR LES BROUILLONS ECHUS (chantier « delai de reponse
// IA », lot 2). Spec : docs/specs/spec-delai-reponse-ia.md §4.4.
//
// ⚠ PAS ENCORE BRANCHEE DANS api/cron.js : Thierry demande sa confirmation
// qu'aucune autre session ne travaille dans ce fichier (il est regenere en
// ENTIER, jamais patche). Le module est autonome et teste ; le branchement est
// une ligne a ajouter le jour du go :
//     try { await chrono.mesure('brouillons_dus', () => envoyerBrouillonsDus(results)) }
//     catch (e) { results.errors.push({ context: 'brouillons_dus', error: e.message }) }
//
// ⚠ LA FORME EST CELLE DE `poserPropositionsDues` (lib/cleaning/sync-menages-entite.js),
// et ce n'est pas un hasard : c'est le precedent eprouve du depot pour une
// passe a echeance — bornes en SQL, `opts.maintenant` injectable, plafond par
// cycle, bilan rendu. On ne reinvente pas cette forme.
//
// ⚠ AUCUN PARCOURS PAR COMPTE NI PAR BIEN (regle des 30 000 comptes) : la
// passe lit les taches ECHUES, globalement, et le volume depend du trafic reel,
// pas du parc. Les lectures annexes (biens, cles, reservations) sont GROUPEES
// en un `in(...)` par lot, jamais une par tache.

// ⚠ LE CLIENT PAR DEFAUT SE CHARGE PARESSEUSEMENT, ET CE N'EST PAS UNE
// COMMODITE DE TEST. `require('../cron-shared')` INSTANCIE un client Supabase a
// l'import (il leve « supabaseUrl is required » sans environnement) : un module
// qui recoit son client en parametre ne doit pas en fabriquer un pour rien, et
// surtout pas au chargement. Le faire ici obligeait chaque appelant — test,
// script, futur worker — a porter un environnement complet pour une dependance
// qu'il n'utilise pas.
function clientParDefaut () {
  return require('../cron-shared').supabase
}
const { formeExploitable, minutesValides } = require('./delais-contrat')
const { echeanceApresSourdine, GRACE_APRES_ALERTE_MS } = require('./sourdine')

// Le plafond par cycle, aligne sur le precedent menage
// (`MAX_NOTIFS_PAR_CYCLE = 30`, lib/cleaning/sync-menages-entite.js) — demande
// de Thierry : le surplus part au cycle suivant.
const MAX_PAR_CYCLE = 30

// Au-dela, une tache restee `sending` est consideree comme abandonnee (crash
// entre le claim et l'envoi) et rendue a l'hote. 10 minutes = deux cycles de
// cron : assez pour qu'un envoi lent aboutisse, assez peu pour que le voyageur
// n'attende pas.
const SENDING_ORPHELIN_MS = 10 * 60 * 1000

const STATUT_EN_COURS = 'sending'

// ─── 1. Les `sending` abandonnees reviennent a l'hote ────────────────────────
// ⚠ SANS CETTE REPRISE, LE STATUT `sending` EST UN TROU NOIR. Le claim est ce
// qui ferme la course cron/clic ; son prix est qu'une tache claimee puis perdue
// (fonction tuee, deploiement en vol, panne reseau apres le claim) n'est plus
// ni visible pour l'hote ni reprise par le cron. Elle redevient donc une
// proposition a valider, et le fondateur est prevenu : si ca arrive souvent,
// c'est l'envoi qui est casse, pas la tache.
async function reprendreOrphelines (sb, { maintenant, results, bilan }) {
  const limite = new Date(maintenant - SENDING_ORPHELIN_MS).toISOString()
  const { data, error } = await sb.from('agent_tasks')
    .select('id, user_id, property_id, book_id, updated_at')
    .eq('status', STATUT_EN_COURS)
    .lt('updated_at', limite)
    .limit(MAX_PAR_CYCLE)
  if (error) {
    results?.errors?.push({ context: 'brouillons_orphelins_lecture', error: error.message })
    return
  }
  for (const t of data || []) {
    // Claim inverse, conditionne sur `sending` : si quelqu'un l'a finie entre
    // la lecture et ici, on ne la ressuscite pas.
    //
    // ⚠ ET ELLE EST DESARMEE (`send_after: null`), PAS SEULEMENT RENDUE. Mon
    // premier jet la rendait armee : la passe la relisait comme echue DANS LE
    // MEME CYCLE et la renvoyait aussitot. Or une tache restee « sending » est
    // precisement celle dont on NE SAIT PAS si l'envoi est parti — la panne a
    // pu survenir apres l'envoi et avant l'ecriture du statut (le cas que
    // `brouillon_statut_apres_envoi` signale plus bas). La renvoyer
    // automatiquement, c'est choisir le double message au voyageur plutot que
    // l'attente. On rend donc la main a l'hote, avec le doute ecrit dans le
    // resume : lui seul peut verifier le fil et trancher.
    const { data: rendue, error: eU } = await sb.from('agent_tasks')
      .update({
        status: 'pending_validation',
        send_after: null,
        summary: "Envoi différé interrompu : impossible de savoir si le message est parti. "
          + "Vérifiez le fil avant de renvoyer.",
        updated_at: new Date(maintenant).toISOString()
      })
      .eq('id', t.id).eq('status', STATUT_EN_COURS)
      .select('id')
    if (eU) { results?.errors?.push({ context: 'brouillons_orphelin_rendu', error: eU.message }); continue }
    if (!rendue || !rendue.length) continue
    bilan.orphelines++
    console.error(`[BrouillonsDus] tache ${t.id} restee « ${STATUT_EN_COURS} » depuis ${t.updated_at}`
      + ' — rendue a l hote')
    try {
      const { reportIncident } = require('../founder-notify')
      await reportIncident('brouillon_sending_orphelin', {
        userId: t.user_id, propertyId: String(t.property_id), threshold: 1,
        detail: `Le brouillon ${t.id} (reservation ${t.book_id}) est reste « en cours d envoi » `
          + `depuis ${t.updated_at} : rendu a l hote comme proposition a valider. `
          + 'Si cela se repete, c est l envoi qui est casse.'
      })
    } catch (e) { console.error('[BrouillonsDus] incident non enregistre', e.message) }
  }
}

// ─── 2. La lecture des echues : bornee, filtree, triee, plafonnee ────────────
// ⚠ C'EST CETTE REQUETE QUE LES DEUX INDEX PARTIELS SERVENT
// (migrations/2026-10-27-delai-reponse-ia.sql). Elle ne lit JAMAIS la table
// entiere : `status` + `send_after` non nul + borne d'echeance.
async function lireLesDues (sb, { maintenant, plafond, results }) {
  const { data, error } = await sb.from('agent_tasks')
    .select('id, user_id, property_id, book_id, guest_name, guest_message, guest_phone, '
      + 'arrival, departure, task_type, suggested_reply, source_thread, send_after, modifie_le')
    .eq('status', 'pending_validation')
    .not('send_after', 'is', null)
    .lte('send_after', new Date(maintenant).toISOString())
    .is('suspendu_le', null)
    .order('send_after', { ascending: true })
    .limit(plafond)
  if (error) {
    results?.errors?.push({ context: 'brouillons_dus_lecture', error: error.message })
    return null
  }
  return data || []
}

// ─── 3. Les garde-fous rejoues A L'ECHEANCE ──────────────────────────────────
// ⚠ TOUT EST REVERIFIE, ET C'EST LA RAISON D'ETRE DE CETTE FONCTION. Entre la
// pose de l'echeance et son terme, il a pu se passer des minutes ou des heures :
// l'hote a pu couper l'automatique, la reservation a pu etre annulee, le sejour
// a pu finir, et le REGLAGE a pu repasser en validation manuelle. Un brouillon
// qui part sur un etat perime est le defaut que le differe introduit.
async function encoreLegitime (sb, tache, { maintenant, biens, reglages }) {
  const bien = biens.get(String(tache.property_id))
  if (!bien) return { ok: false, motif: 'bien_introuvable' }

  // Kill switch par bien : decision de Thierry du 9 octobre 2026 — en pause,
  // aucune reponse automatique, ni maintenant ni a la reprise.
  if (bien.automation_paused === true) return { ok: false, motif: 'automatisation_en_pause' }

  // Le reglage, RELU : l'hote a pu repasser le bien en validation manuelle.
  const d = reglages.get(String(tache.property_id))
  if (d && d.delais && 'reponse_ia' in d.delais) {
    const v = d.delais.reponse_ia
    if (v === null) return { ok: false, motif: 'repasse_en_validation_manuelle' }
    if (!minutesValides(v)) return { ok: false, motif: 'reglage_hors_contrat' }
  } else if (d && d.mode === 'test') {
    return { ok: false, motif: 'repasse_en_validation_manuelle' }
  }

  // Sejour termine : au-dela du depart, une reponse automatique n'a plus
  // d'objet — et le voyageur a souvent deja recu l'enquete de satisfaction.
  if (tache.departure) {
    const finDuJour = Date.parse(`${String(tache.departure).slice(0, 10)}T23:59:59Z`)
    if (Number.isFinite(finDuJour) && maintenant > finDuJour) {
      return { ok: false, motif: 'sejour_termine' }
    }
  }
  return { ok: true, bien }
}

// ─── 4. Les lectures annexes, GROUPEES ───────────────────────────────────────
async function chargerLeContexte (sb, taches, { results }) {
  const biens = new Map()
  const reglages = new Map()
  if (!taches.length) return { biens, reglages }

  const refs = [...new Set(taches.map(t => String(t.property_id)))]
  const comptes = [...new Set(taches.map(t => String(t.user_id)))]

  // ⚠ UN `in(...)` PAR LOT, PAS UNE REQUETE PAR TACHE. A 30 taches sur 5 biens,
  // la version naive faisait 30 lectures de `properties` pour 5 lignes utiles.
  const { data: lignes, error } = await sb.from('properties')
    .select('id, name, provider, provider_property_id, automation_paused, user_id')
    .in('provider_property_id', refs)
  if (error) results?.errors?.push({ context: 'brouillons_dus_biens', error: error.message })
  for (const b of lignes || []) biens.set(String(b.provider_property_id), b)

  // Le blob de reglages est UN par compte : une lecture par compte, pas par bien.
  const { data: configs, error: eC } = await sb.from('agent_alert_config')
    .select('user_id, config')
    .in('user_id', comptes)
  if (eC) results?.errors?.push({ context: 'brouillons_dus_reglages', error: eC.message })
  for (const c of configs || []) {
    for (const ref of refs) {
      const entree = c.config && c.config[ref]
      if (!entree) continue
      reglages.set(ref, {
        mode: entree.mode || 'test',
        delais: formeExploitable(entree.delais) ? entree.delais : null
      })
    }
  }
  return { biens, reglages }
}

/**
 * Fait partir les brouillons echus.
 *
 * @param {object} results   le collecteur d'erreurs du cron (results.errors)
 * @param {object} opts
 *   - maintenant : instant injecte (ms). Defaut : l'horloge.
 *   - sb         : client Supabase (injectable pour les tests)
 *   - envoyer    : (bien, tache, texte) => { ok, canal, error } (injectable)
 *   - plafond    : nombre max de brouillons par cycle
 * @returns bilan { examines, envoyes, reportes, abandonnes, orphelines, erreurs }
 */
async function envoyerBrouillonsDus (results = null, opts = {}) {
  const sb = opts.sb || clientParDefaut()
  const maintenant = opts.maintenant || Date.now()
  const plafond = Number.isInteger(opts.plafond) ? opts.plafond : MAX_PAR_CYCLE
  const bilan = { examines: 0, envoyes: 0, reportes: 0, abandonnes: 0, orphelines: 0, erreurs: 0 }

  await reprendreOrphelines(sb, { maintenant, results, bilan })

  const dues = await lireLesDues(sb, { maintenant, plafond, results })
  if (dues === null) { bilan.erreurs++; return bilan }
  if (!dues.length) return bilan

  const { biens, reglages } = await chargerLeContexte(sb, dues, { results })

  for (const tache of dues) {
    bilan.examines++

    // ⚠ LA SOURDINE AVANT LE CLAIM, ET SEULEMENT POUR UN BROUILLON MODIFIE
    // (decision 7 de Thierry, 27 octobre 2026). Un brouillon JAMAIS TOUCHE part
    // la nuit comme en journee : la sourdine protege le texte incertain de
    // l'hote, pas la reponse de l'IA. Reporter avant de claimer evite de poser
    // un `sending` qu'on relacherait aussitot.
    if (tache.modifie_le) {
      const d = reglages.get(String(tache.property_id))
      const sourdine = d && d.delais ? d.delais.sourdine : null
      const r = echeanceApresSourdine(maintenant, sourdine)
      if (r.repoussee) {
        // L'alerte part a la fin de la plage, et l'envoi QUINZE MINUTES apres :
        // sans cette grace, l'alerte « avertirait » d'une chose deja faite.
        const nouvelle = new Date(r.echeance + GRACE_APRES_ALERTE_MS).toISOString()
        const { error } = await sb.from('agent_tasks')
          .update({ send_after: nouvelle, updated_at: new Date(maintenant).toISOString() })
          .eq('id', tache.id).eq('status', 'pending_validation')
        if (error) { bilan.erreurs++; results?.errors?.push({ context: 'brouillon_report', error: error.message }) }
        else {
          bilan.reportes++
          console.log(`[BrouillonsDus] tache ${tache.id} en sourdine — reportee a ${nouvelle}`)
        }
        continue
      }
    }

    // ⚠ LE CLAIM ATOMIQUE, AVANT TOUT ENVOI. C'est ce qui ferme la course avec
    // le clic de l'hote : zero ligne mise a jour = quelqu'un d'autre l'a prise.
    // L'ecran passe par le MEME claim (api/messages.js) et dans le MEME ordre.
    const { data: prise, error: eClaim } = await sb.from('agent_tasks')
      .update({ status: STATUT_EN_COURS, updated_at: new Date(maintenant).toISOString() })
      .eq('id', tache.id).eq('status', 'pending_validation')
      .select('id')
    if (eClaim) { bilan.erreurs++; results?.errors?.push({ context: 'brouillon_claim', error: eClaim.message }); continue }
    if (!prise || !prise.length) {
      console.log(`[BrouillonsDus] tache ${tache.id} deja prise ailleurs — rien a faire`)
      continue
    }

    const garde = await encoreLegitime(sb, tache, { maintenant, biens, reglages })
    if (!garde.ok) {
      // ⚠ ON NE SUPPRIME PAS, ON REND A L'HOTE. Le brouillon redevient une
      // proposition a valider, avec le motif dans son resume : l'hote voit
      // pourquoi rien n'est parti, et il garde la main.
      const { error } = await sb.from('agent_tasks').update({
        status: 'pending_validation', send_after: null,
        summary: `Envoi differe annulé (${garde.motif}) : vérifiez puis envoyez si besoin.`,
        updated_at: new Date(maintenant).toISOString()
      }).eq('id', tache.id).eq('status', STATUT_EN_COURS)
      if (error) { bilan.erreurs++; results?.errors?.push({ context: 'brouillon_abandon', error: error.message }) }
      else bilan.abandonnes++
      console.log(`[BrouillonsDus] tache ${tache.id} non envoyee : ${garde.motif}`)
      continue
    }

    const texte = tache.suggested_reply
    if (!texte || !String(texte).trim()) {
      const { error } = await sb.from('agent_tasks').update({
        status: 'pending_validation', send_after: null,
        summary: 'Envoi différé annulé : le brouillon est vide.',
        updated_at: new Date(maintenant).toISOString()
      }).eq('id', tache.id).eq('status', STATUT_EN_COURS)
      if (error) { bilan.erreurs++; results?.errors?.push({ context: 'brouillon_vide', error: error.message }) }
      else bilan.abandonnes++
      continue
    }

    let envoi
    try {
      envoi = await (opts.envoyer
        ? opts.envoyer(garde.bien, tache, texte)
        : envoyerParDefaut(sb, garde.bien, tache, texte))
    } catch (e) {
      envoi = { ok: false, error: e.message }
    }

    // ⚠ LE RETOUR SE LIT. Ne pas le lire, c'est promettre au fil ce qu'on n'a
    // pas tenu — et priver l'hote du seul signal qui lui dirait que son
    // voyageur attend toujours (meme regle que le chemin Auto de cron-classify).
    if (!envoi || !envoi.ok) {
      bilan.erreurs++
      const { error } = await sb.from('agent_tasks').update({
        status: 'pending_validation', send_after: null,
        summary: `Réponse différée NON DÉLIVRÉE (${String(envoi && envoi.error || 'inconnu').slice(0, 150)}) : `
          + 'vérifiez-la et renvoyez-la.',
        updated_at: new Date(maintenant).toISOString()
      }).eq('id', tache.id).eq('status', STATUT_EN_COURS)
      if (error) results?.errors?.push({ context: 'brouillon_echec_rendu', error: error.message })
      results?.errors?.push({ context: 'brouillon_envoi', property_id: String(tache.property_id),
        booking_id: String(tache.book_id), error: (envoi && envoi.error) || 'echec envoi' })
      try {
        const { reportIncident } = require('../founder-notify')
        await reportIncident('send_failure', {
          userId: tache.user_id, propertyId: String(tache.property_id),
          propertyName: garde.bien.name, threshold: 1,
          detail: `Réponse différée NON DÉLIVRÉE (réservation ${tache.book_id}) : `
            + `${(envoi && envoi.error) || 'inconnu'}. Le voyageur attend toujours.`
        })
      } catch (e) { console.error('[BrouillonsDus] incident non enregistre', e.message) }
      continue
    }

    const { error: eFin } = await sb.from('agent_tasks')
      .update({ status: 'done', send_after: null, updated_at: new Date(maintenant).toISOString() })
      .eq('id', tache.id).eq('status', STATUT_EN_COURS)
    if (eFin) {
      // ⚠ L'ENVOI EST PARTI ET LE STATUT N'A PAS SUIVI : on le DIT fort. La
      // reprise des orphelines rendrait la tache a l'hote dans 10 minutes, donc
      // un second envoi est possible — c'est le seul cas ou le claim ne protege
      // plus, et il doit etre visible, pas avale.
      results?.errors?.push({ context: 'brouillon_statut_apres_envoi',
        booking_id: String(tache.book_id), error: eFin.message })
      console.error(`[BrouillonsDus] ⚠ ENVOI PARTI mais statut non ecrit (tache ${tache.id}) : ${eFin.message}`)
    }
    bilan.envoyes++
    console.log(`[BrouillonsDus] tache ${tache.id} envoyee (${envoi.canal || 'canal inconnu'})`)
  }

  return bilan
}

// L'envoi reel : il passe par le routage commun, jamais par un provider en dur.
async function envoyerParDefaut (sb, bien, tache, texte) {
  const { sendGuestMessage } = require('../cron-messages')
  const { data: cle } = await sb.from('api_keys')
    .select('api_key').eq('user_id', tache.user_id).maybeSingle()
  return sendGuestMessage(cle && cle.api_key, bien, String(tache.book_id), texte,
    { userId: tache.user_id, eventType: 'reponse_ia_differee' })
}

module.exports = {
  envoyerBrouillonsDus, reprendreOrphelines, encoreLegitime,
  MAX_PAR_CYCLE, SENDING_ORPHELIN_MS, STATUT_EN_COURS
}
