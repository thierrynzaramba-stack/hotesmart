// lib/avis/auto-validation.js
//
// L'AUTO-VALIDATION DE L'EVALUATION DU VOYAGEUR (spec §10 bis, demande de
// Thierry du 2 octobre 2026).
//
// L'hote regle « valider automatiquement apres X heures sans reaction »
// (`avis_config.auto_validation_heures`, nul = desactivee). Quand la prestataire
// a fini sa part, l'horloge part (`guest_evaluations.auto_publier_le`) ; toute
// reaction de l'hote l'arrete. A l'echeance, les questions de l'hote restees
// sans reponse prennent le MEILLEUR niveau de leur grille, le texte de l'IA est
// conserve (redige s'il manque), et l'evaluation part par le chemin de l'hote.
//
// ⚠ JAMAIS UN AVIS NEGATIF. Si les reponses le rendent negatif, rien ne part :
// il attend l'hote, toujours.
//
// ⚠ JAMAIS DE BALAYAGE. Deux requetes par passage, toutes deux sur l'index
// partiel `guest_evaluations_auto_publier_idx` (seules les evaluations
// programmees y sont), plafonnees.
//
// ⚠ L'ECHEANCE TOMBE AVANT CELLE D'AIRBNB : `auto_publier_le` est plafonne a
// l'echeance − 12 heures. Une evaluation dont ce plafond est deja passe ne se
// programme pas.

const { hoteARepondu, journaliser } = require('./evaluations')
const { estNegatif } = require('./notes-evaluation')

const HEURE = 3600000
const HEURES_MIN = 1
const HEURES_MAX = 336                         // 14 jours : la fenetre d'Airbnb
const MARGE_AVANT_ECHEANCE_MS = 12 * HEURE
const RAPPEL_AVANT_MS = 6 * HEURE
const REPORT_SANS_OBJET_MS = HEURE
const PLAFOND_PASSAGE = 20
// Une redaction coute un appel au modele (~2 s), une publication un appel au
// provider : au plus cinq par passage, le reste au passage suivant (5 min).
const PLAFOND_PUBLICATIONS = 5
const TERMINAUX = new Set(['publiee', 'abandonnee', 'expiree', 'echec_publication'])

const marqueurRappelAuto = (bookingUid) => `[AUTO: avis auto rappel ${bookingUid}]`
const marqueurEchecAuto = (bookingUid) => `[AUTO: avis auto echec ${bookingUid}]`

// Le reglage tel que l'hote l'envoie : nul (desactivee) ou un entier d'heures.
// Rend `undefined` pour une valeur invalide : l'appelant refuse, il ne devine pas.
function normaliserHeures (v) {
  if (v === null || v === undefined || v === '' || v === false) return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < HEURES_MIN || n > HEURES_MAX) return undefined
  return n
}

// Quand publier : maintenant + X heures, plafonne a l'echeance − 12 heures.
// Nul quand il ne faut rien programmer (desactivee, pas d'echeance, trop tard).
function echeanceAuto ({ maintenant = Date.now(), heures, deadline }) {
  if (!heures || !deadline) return null
  const plafond = Date.parse(deadline) - MARGE_AVANT_ECHEANCE_MS
  if (!(plafond > maintenant)) return null
  return new Date(Math.min(maintenant + heures * HEURE, plafond)).toISOString()
}

// Le reglage effectif d'un bien. ⚠ UNE LIGNE DE BIEN PREVAUT, MEME NULLE : elle
// desactive alors l'auto-validation sur ce bien. Le sens prudent d'une
// ambiguite — on publie moins, jamais plus. Une erreur de lecture se dit.
async function lireHeures (sb, { userId, propertyId }) {
  const { data, error } = await sb.from('avis_config')
    .select('property_id, auto_validation_heures')
    .eq('user_id', userId)
    .or(`property_id.eq.${propertyId},property_id.is.null`)
  if (error) return { erreur: error.message }
  const liste = data || []
  const ligne = liste.find(c => c.property_id) || liste.find(c => !c.property_id) || null
  const heures = ligne ? normaliserHeures(ligne.auto_validation_heures) : null
  return { heures: heures === undefined ? null : heures }
}

// Le meilleur niveau d'un critere : le premier par rang qui n'est pas negatif —
// « je recommande » pour la recommandation.
function meilleurNiveau (critere) {
  const niveaux = [...(critere.niveaux || [])].sort((a, b) => (a.rang || 0) - (b.rang || 0))
  const bon = niveaux.find(n => !n.negatif && (critere.categorie !== 'recommandation' || n.recommande === true))
  return bon ? bon.cle : null
}

// Les reponses qui manquent, au meilleur niveau. SEULES les questions de l'hote
// se completent : une question de la prestataire vide veut dire que sa part
// n'est pas finie, et rien ne part. Leve si la grille ne le permet pas.
function completerAuMeilleur (grille, evaluation) {
  const deja = { ...(evaluation.answers_cleaner || {}), ...(evaluation.answers_host || {}) }
  const complement = {}
  for (const c of (grille && grille.criteres) || []) {
    const v = deja[c.cle]
    if (v !== undefined && v !== null && v !== '') continue
    if (c.rempli_par !== 'hote') throw new Error(`la question « ${c.cle} » de la prestataire est sans réponse`)
    const cle = meilleurNiveau(c)
    if (!cle) throw new Error(`la question « ${c.cle} » n’a aucun niveau favorable`)
    complement[c.cle] = cle
  }
  return complement
}

const COLONNES = 'id, user_id, property_id, property_id_ref, booking_uid, status, deadline_at, '
  + 'auto_publier_le, ota_review_id, answers_host, answers_cleaner, grille_figee, public_text, language, filled_by_profile'

/**
 * Un passage du cron : les rappels, puis les publications echues.
 *
 * `outils` vient de api/avis.js — la redaction et la publication par le chemin
 * de l'hote (verrou, idempotence, simulation hors production) : il n'y a pas de
 * second chemin de publication.
 *   - rediger(evaluation)  → { ok, public_text } | { ok: false, motif, transitoire } | { panne }
 *   - publier(evaluation)  → { code, body }
 *
 * Ne leve jamais.
 */
async function executerAutoValidations (sb, { maintenant = Date.now(), outils, deps = {}, seulement = null } = {}) {
  const bilan = { rappels: 0, lues: 0, publiees: 0, reportees: 0, desarmees: 0, echecs: 0, erreurs: 0 }
  const { noterEtEnvoyer, dateHeureFr } = require('./notifications')
  const iso = (ms) => new Date(ms).toISOString()
  const filtrer = (q) => (Array.isArray(seulement) ? q.in('booking_uid', seulement) : q)

  // Ecrire `auto_publier_le` SEULEMENT s'il n'a pas bouge depuis la lecture :
  // une reaction de l'hote entre-temps (qui le remet a nul) gagne toujours.
  const reprogrammer = async (e, valeur, extra = {}) => {
    const { data, error } = await sb.from('guest_evaluations')
      .update({ auto_publier_le: valeur, ...extra })
      .eq('id', e.id).eq('user_id', e.user_id).eq('auto_publier_le', e.auto_publier_le)
      .select('id')
    if (error) { bilan.erreurs++; console.error('[avis] auto-validation : ecriture refusee', e.id, error.message); return false }
    return Array.isArray(data) && data.length > 0
  }
  const desarmer = async (e, motif) => {
    if (await reprogrammer(e, null)) {
      bilan.desarmees++
      console.log('[avis] auto-validation desarmee', e.booking_uid, motif)
    }
  }
  const nomDuBien = async (e) => {
    const { data } = await sb.from('properties').select('name')
      .eq('id', e.property_id).eq('user_id', e.user_id).maybeSingle()
    return data && data.name ? ` (${data.name})` : ''
  }
  const prevenirEchec = async (e, raison) => {
    try {
      await noterEtEnvoyer(sb, {
        userId: e.user_id, propertyRef: e.property_id_ref, bookingUid: e.booking_uid,
        marqueur: marqueurEchecAuto(e.booking_uid), nom: 'Évaluation du voyageur', deps,
        summary: `L’évaluation du voyageur${await nomDuBien(e)} n’a pas été publiée automatiquement : `
          + `${raison}. Elle vous attend sur la page Avis.`,
      })
    } catch (err) { console.error('[avis] auto-validation : echec non signale', e.booking_uid, err.message) }
  }

  try {
    // ─── 1. Les rappels, six heures avant ─────────────────────────────────
    const { data: proches, error: eP } = await filtrer(sb.from('guest_evaluations')
      .select(COLONNES)
      .gt('auto_publier_le', iso(maintenant))
      .lte('auto_publier_le', iso(maintenant + RAPPEL_AVANT_MS)))
      .order('auto_publier_le', { ascending: true })
      .limit(PLAFOND_PASSAGE)
    if (eP) { bilan.erreurs++; console.error('[avis] auto-validation : rappels illisibles', eP.message) }
    for (const e of proches || []) {
      if (TERMINAUX.has(e.status)) continue
      try {
        const ok = await noterEtEnvoyer(sb, {
          userId: e.user_id, propertyRef: e.property_id_ref, bookingUid: e.booking_uid,
          marqueur: marqueurRappelAuto(e.booking_uid), nom: 'Évaluation du voyageur', deps,
          summary: `L’évaluation du voyageur${await nomDuBien(e)} sera publiée automatiquement `
            + `à partir du ${dateHeureFr(e.auto_publier_le)} si vous ne réagissez pas. `
            + 'Vos questions restées sans réponse prendront le meilleur niveau. Ouvrez la page Avis pour la reprendre.',
        })
        if (ok) bilan.rappels++
      } catch (err) { bilan.erreurs++; console.error('[avis] auto-validation : rappel echoue', e.booking_uid, err.message) }
    }

    // ─── 2. Les publications echues ───────────────────────────────────────
    const { data: echues, error } = await filtrer(sb.from('guest_evaluations')
      .select(COLONNES)
      .lte('auto_publier_le', iso(maintenant)))
      .order('auto_publier_le', { ascending: true })
      .limit(PLAFOND_PASSAGE)
    if (error) { bilan.erreurs++; console.error('[avis] auto-validation : lecture impossible', error.message); return bilan }
    bilan.lues = (echues || []).length

    let tentatives = 0
    for (const e of echues || []) {
      try {
        if (TERMINAUX.has(e.status)) { await desarmer(e, 'statut ' + e.status); continue }
        if (!e.deadline_at || Date.parse(e.deadline_at) <= maintenant) { await desarmer(e, 'echeance passee'); continue }
        if (hoteARepondu(e)) { await desarmer(e, 'l hote a repondu'); continue }

        // 1. La config est relue : desactivee entre-temps → rien.
        const cfg = await lireHeures(sb, { userId: e.user_id, propertyId: e.property_id })
        if (cfg.erreur) { bilan.erreurs++; continue }
        if (!cfg.heures) { await desarmer(e, 'reglage desactive'); continue }

        // Sans objet review Channex, rien ne peut partir (§9 bis) : on attend
        // une heure, jusqu'au plafond avant l'echeance d'Airbnb.
        if (!e.ota_review_id) {
          const suivant = maintenant + REPORT_SANS_OBJET_MS
          if (suivant >= Date.parse(e.deadline_at) - MARGE_AVANT_ECHEANCE_MS) {
            await desarmer(e, 'la plateforme n a pas ouvert d avis avant l echeance')
            await prevenirEchec(e, 'la plateforme n’a pas ouvert d’avis pour ce séjour à temps')
            continue
          }
          if (await reprogrammer(e, iso(suivant))) bilan.reportees++
          continue
        }

        // 2. Les questions de l'hote sans reponse : le meilleur niveau.
        const grille = e.grille_figee
        let complement
        try {
          if (!grille || !Array.isArray(grille.criteres) || !grille.criteres.length) throw new Error('grille absente')
          complement = completerAuMeilleur(grille, e)
        } catch (err) {
          await desarmer(e, err.message); await prevenirEchec(e, err.message); bilan.echecs++; continue
        }
        const complete = { ...e, answers_host: { ...(e.answers_host || {}), ...complement } }

        // 3. JAMAIS UN AVIS NEGATIF.
        let negatif
        try { negatif = estNegatif({ ...(complete.answers_cleaner || {}), ...complete.answers_host }, grille) }
        catch (err) { negatif = null }
        if (negatif !== false) {
          await desarmer(e, 'avis negatif ou illisible')
          await prevenirEchec(e, 'un avis négatif attend toujours votre décision')
          continue
        }

        // Au-dela du plafond, la suite attend le passage suivant.
        if (tentatives >= PLAFOND_PUBLICATIONS) continue
        tentatives++

        // 4. Le texte de l'IA est conserve ; s'il manque, il est redige.
        if (!e.public_text) {
          const r = await outils.rediger(complete)
          if (r.panne || (!r.ok && r.transitoire)) {
            // Une panne passe : on reessaie dans une heure, avant le plafond.
            const suivant = maintenant + REPORT_SANS_OBJET_MS
            if (suivant < Date.parse(e.deadline_at) - MARGE_AVANT_ECHEANCE_MS && await reprogrammer(e, iso(suivant))) bilan.reportees++
            else { await desarmer(e, 'redaction indisponible'); await prevenirEchec(e, 'le texte n’a pas pu être rédigé') }
            continue
          }
          if (!r.ok) {
            await desarmer(e, 'redaction refusee ' + r.motif)
            await prevenirEchec(e, 'le texte n’a pas pu être rédigé')
            bilan.echecs++
            continue
          }
        }

        // La prise : les reponses completees s'ecrivent ET l'horloge s'arrete,
        // en une ecriture conditionnee — une reaction de l'hote entre-temps
        // gagne, et deux passages concurrents ne publient pas deux fois.
        if (!(await reprogrammer(e, null, { answers_host: complete.answers_host }))) continue

        // 5. Par le chemin de l'hote.
        const p = await outils.publier(complete)
        if (p.code === 200) {
          bilan.publiees++
          const j = await journaliser(sb, {
            userId: e.user_id, type: 'avis.auto_publiee', sujet: e.id,
            charge: { booking_uid: e.booking_uid, completees: Object.keys(complement), simulation: Boolean(p.body && p.body.simulation) },
          })
          if (!j.ok) console.error('[avis] auto-validation : evenement non journalise', j.erreur)
        } else {
          bilan.echecs++
          await prevenirEchec(e, (p.body && p.body.error) || 'la plateforme a refusé')
        }
      } catch (err) {
        bilan.erreurs++
        console.error('[avis] auto-validation : exception', e.booking_uid, err.message)
      }
    }
  } catch (err) {
    bilan.erreurs++
    console.error('[avis] auto-validation : exception', err.message)
  }
  return bilan
}

module.exports = {
  executerAutoValidations, normaliserHeures, echeanceAuto, lireHeures,
  completerAuMeilleur, meilleurNiveau, marqueurRappelAuto, marqueurEchecAuto,
  HEURES_MIN, HEURES_MAX, MARGE_AVANT_ECHEANCE_MS, RAPPEL_AVANT_MS, PLAFOND_PASSAGE, PLAFOND_PUBLICATIONS,
}
