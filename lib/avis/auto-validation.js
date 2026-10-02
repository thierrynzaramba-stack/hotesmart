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
// ⚠ UNE PUBLICATION IRREVERSIBLE NE COMMENCE PAS EN FIN DE CYCLE. Le cron est
// tue a 60 s (maxDuration) : tue entre la prise et l'ecriture du statut, il
// laisserait un avis parti sans trace. Sous 20 s de reste, on s'arrete
// (constat de securite S2 de la revue de 59243cb).
const RESTE_MINIMUM_MS = 20000

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

// Le reglage effectif d'un bien : celui du bien s'il en porte un, sinon celui du
// compte. ⚠ UNE LIGNE DE BIEN NULLE HERITE (revue de 59243cb, M3) : une ligne
// de bien nait de n'importe quelle surcharge (mots-cles, ton), et la lire comme
// « desactivee » coupait l'auto-validation en silence pendant que la page Avis
// disait « activee ». Une erreur de lecture se dit.
async function lireHeures (sb, { userId, propertyId }) {
  const { data, error } = await sb.from('avis_config')
    .select('property_id, auto_validation_heures')
    .eq('user_id', userId)
    .or(`property_id.eq.${propertyId},property_id.is.null`)
  if (error) return { erreur: error.message }
  const liste = data || []
  const lire = (c) => { const h = c ? normaliserHeures(c.auto_validation_heures) : null; return h === undefined ? null : h }
  const duBien = lire(liste.find(c => c.property_id))
  return { heures: duBien !== null ? duBien : lire(liste.find(c => !c.property_id)) }
}

// Le meilleur niveau d'un critere : la NOTE la plus haute parmi les niveaux non
// negatifs — « je recommande » pour la recommandation. ⚠ PAS LE PREMIER RANG
// (revue de 59243cb, M1) : rien n'impose a l'hote de ranger ses niveaux du
// meilleur au pire, et le premier rang aurait pu publier un 2/5. A note egale,
// le premier rang.
function meilleurNiveau (critere) {
  const niveaux = [...(critere.niveaux || [])].sort((a, b) => (a.rang || 0) - (b.rang || 0))
  if (critere.categorie === 'recommandation') {
    const oui = niveaux.find(n => !n.negatif && n.recommande === true)
    return oui ? oui.cle : null
  }
  let bon = null
  for (const n of niveaux) {
    if (n.negatif || typeof n.note !== 'number') continue
    if (!bon || n.note > bon.note) bon = n
  }
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
  + 'auto_publier_le, auto_rappel_le, ota_review_id, answers_host, answers_cleaner, grille_figee, public_text, language, filled_by_profile'

/**
 * Un passage du cron : les rappels, puis les publications echues.
 *
 * `outils` vient de api/avis.js — la redaction et la publication par le chemin
 * de l'hote (verrou, idempotence, simulation hors production) : il n'y a pas de
 * second chemin de publication.
 *   - rediger(evaluation, { siAutoPublierLe }) → { ok, public_text } | { ok: false, motif, transitoire } | { panne }
 *     (le texte ne s'ecrit que si l'horloge n'a pas bouge : motif `auto_reprise` sinon)
 *   - publier(evaluation)  → { code, body } — relit la ligne SOUS LE VERROU et
 *     refuse si l'hote a reagi apres la prise (motif `auto_annulee`)
 * `resteMs()` : le temps qui reste au cycle ; sous 20 s, plus de publication.
 *
 * Ne leve jamais.
 */
async function executerAutoValidations (sb, { maintenant = Date.now(), outils, deps = {}, seulement = null, resteMs = null } = {}) {
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
      .lte('auto_publier_le', iso(maintenant + RAPPEL_AVANT_MS))
      // ⚠ SEULEMENT CE QUI N'A PAS ETE RAPPELE (revue de 59243cb, M2) : sans
      // ce filtre, les vingt premieres, deja rappelees, se relisaient a chaque
      // passage et la vingt-et-unieme n'etait jamais rappelee a temps.
      .is('auto_rappel_le', null))
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
        const { error: eR } = await sb.from('guest_evaluations').update({ auto_rappel_le: iso(maintenant) })
          .eq('id', e.id).eq('user_id', e.user_id)
        if (eR) { bilan.erreurs++; console.error('[avis] auto-validation : rappel non marque', e.booking_uid, eR.message) }
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
    let pris = null
    for (const e of echues || []) {
      try {
        if (TERMINAUX.has(e.status)) { await desarmer(e, 'statut ' + e.status); continue }
        if (!e.deadline_at || Date.parse(e.deadline_at) <= maintenant) {
          // Un retard de la file se DIT (revue de 59243cb, M2) : jamais un
          // desarmement muet.
          await desarmer(e, 'echeance passee')
          await prevenirEchec(e, 'le délai de la plateforme est passé avant la publication automatique')
          continue
        }
        if (hoteARepondu(e)) { await desarmer(e, 'l hote a repondu'); continue }

        // 1. La config est relue : desactivee entre-temps → rien.
        const cfg = await lireHeures(sb, { userId: e.user_id, propertyId: e.property_id })
        // Illisible : report d'une heure, pour ne pas rester en tete de la file.
        if (cfg.erreur) { bilan.erreurs++; await reprogrammer(e, iso(maintenant + REPORT_SANS_OBJET_MS)); continue }
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

        // Au-dela du plafond, ou trop pres de la fin du cycle, la suite attend
        // le passage suivant.
        if (tentatives >= PLAFOND_PUBLICATIONS) continue
        if (resteMs && resteMs() < RESTE_MINIMUM_MS) break
        tentatives++

        // 4. Le texte de l'IA est conserve ; s'il manque, il est redige.
        // ⚠ ET IL NE S'ECRIT QUE SI L'HORLOGE N'A PAS BOUGE (revue de 59243cb,
        // S3) : un hote qui a demande son propre texte entre-temps a arrete
        // l'horloge, et le sien n'est pas ecrase.
        if (!e.public_text) {
          const r = await outils.rediger(complete, { siAutoPublierLe: e.auto_publier_le })
          if (!r.ok && r.motif === 'auto_reprise') continue
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
        pris = e

        // 5. Par le chemin de l'hote. ⚠ La publication RELIT la ligne sous son
        // verrou, et refuse si l'hote a reagi apres la prise (S1).
        const p = await outils.publier(complete)
        pris = null
        if (p.code === 200) {
          bilan.publiees++
          const j = await journaliser(sb, {
            userId: e.user_id, type: 'avis.auto_publiee', sujet: e.id,
            charge: { booking_uid: e.booking_uid, completees: Object.keys(complement), simulation: Boolean(p.body && p.body.simulation) },
          })
          if (!j.ok) console.error('[avis] auto-validation : evenement non journalise', j.erreur)
        } else if (p.body && (p.body.motif === 'deja_en_cours' || p.body.motif === 'auto_annulee')) {
          // L'hote publie lui-meme, ou vient de reagir : ce n'est pas un echec.
          console.log('[avis] auto-validation : l hote a la main', e.booking_uid, p.body.motif)
        } else {
          bilan.echecs++
          await prevenirEchec(e, `${(p.body && p.body.error) || 'la plateforme a refusé'}. `
            + `Réponses posées automatiquement, à vérifier : ${Object.keys(complement).join(', ') || 'aucune'}`)
        }
      } catch (err) {
        bilan.erreurs++
        console.error('[avis] auto-validation : exception', e.booking_uid, err.message)
        // Prise faite, publication interrompue : l'hote le sait (S2).
        if (pris) await prevenirEchec(pris, 'la publication automatique a été interrompue — vérifiez son état avant de republier')
        pris = null
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
  HEURES_MIN, HEURES_MAX, MARGE_AVANT_ECHEANCE_MS, RAPPEL_AVANT_MS, PLAFOND_PASSAGE, PLAFOND_PUBLICATIONS, RESTE_MINIMUM_MS,
}
