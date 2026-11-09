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
//
// ⚠ SANS PRESTATAIRE, L'HORLOGE PART A LA NAISSANCE (decision de Thierry du
// 9 novembre 2026). Mesure du jour en production : La bulle et Coeur de vie 23
// reglees a 24 h, ZERO publication automatique depuis le 2 octobre, 14
// evaluations expirees — parce qu'aucune prestataire n'etait autorisee a
// evaluer (`eval_scope = aucun`), donc « sa part finie » n'arrivait jamais.
// Regle de Thierry : « si l'avis de la prestataire n'est pas demande, ca doit
// envoyer un message positif en 24 h ». Quand on ne demande rien a la
// prestataire du sejour (`armerSansPrestataire`), l'horloge part des la
// naissance ; a l'echeance, TOUTES les questions vides prennent le meilleur
// niveau, les siennes comprises, puisque personne ne les remplira.

const { hoteARepondu, journaliser, chargerGrille, criteresPour } = require('./evaluations')
const { estNegatif, validerGrille } = require('./notes-evaluation')

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
const TERMINAUX = new Set(['publiee', 'abandonnee', 'expiree', 'echec_publication', 'evaluee_ailleurs'])
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

// Le reglage d'un bien (decision de Thierry du 2 octobre 2026 au soir, option
// A) : une ligne par bien active dans `avis_auto_validation`, pas de ligne =
// desactivee. Plus de reglage de compte : ce qu'on lit sur la ligne du bien est
// ce qui s'applique. Une erreur de lecture se dit.
async function lireHeures (sb, { userId, propertyId }) {
  const { data, error } = await sb.from('avis_auto_validation')
    .select('heures')
    .eq('user_id', userId)
    .eq('property_id', propertyId)
    .maybeSingle()
  if (error) return { erreur: error.message }
  const h = data ? normaliserHeures(data.heures) : null
  return { heures: h === undefined ? null : h }
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
// ⚠ SAUF QUAND ON NE LUI DEMANDE RIEN (`sansPrestataire`, decision du
// 9 novembre 2026) : ses questions ne seront jamais remplies, elles prennent
// le meilleur niveau comme celles de l'hote.
const vide = (v) => v === undefined || v === null || v === ''
function completerAuMeilleur (grille, evaluation, { sansPrestataire = false } = {}) {
  const deja = { ...(evaluation.answers_cleaner || {}), ...(evaluation.answers_host || {}) }
  const complement = {}
  for (const c of (grille && grille.criteres) || []) {
    if (!vide(deja[c.cle])) continue
    if (c.rempli_par !== 'hote' && !sansPrestataire) throw new Error(`la question « ${c.cle} » de la prestataire est sans réponse`)
    const cle = meilleurNiveau(c)
    if (!cle) throw new Error(`la question « ${c.cle} » n’a aucun niveau favorable`)
    complement[c.cle] = cle
  }
  return complement
}

// ─── Demande-t-on son avis a la prestataire du sejour ? ─────────────────────
// Oui seulement si TOUT est vrai : la grille lui ouvre au moins une question,
// le menage du sejour a une prestataire, et cette prestataire est active ET
// autorisee (`eval_scope = selon_grille`, la meme regle que `criteresPour`, le
// formulaire et la publication). Sinon personne ne remplira sa part.
// ⚠ PLUSIEURS MENAGES POUR UN SEJOUR : il suffit d'UNE prestataire autorisee
// pour qu'on attende sa part (on publie moins, jamais plus tot).
// Rend { participe } ou { erreur } — une lecture en erreur n'est pas un « non ».
async function prestataireParticipe (sb, { userId, propertyRef, bookingUid, grille }) {
  if (!criteresPour(grille, 'prestataire', 'selon_grille').length) return { participe: false }
  const { data: menages, error } = await sb.from('menages')
    .select('provider_id')
    .eq('user_id', userId).eq('property_id', String(propertyRef)).eq('booking_id', String(bookingUid))
    .limit(10)
  if (error) return { erreur: `ménage illisible : ${error.message}` }
  const ids = [...new Set((menages || []).map(m => m.provider_id).filter(Boolean))]
  if (!ids.length) return { participe: false }
  const { data: profils, error: eP } = await sb.from('profiles')
    .select('id, eval_scope, active')
    .eq('account_user_id', userId).in('id', ids)
  if (eP) return { erreur: `prestataire illisible : ${eP.message}` }
  return { participe: (profils || []).some(p => p.active !== false && p.eval_scope === 'selon_grille') }
}

// ─── L'horloge sans prestataire (decision de Thierry du 9 novembre 2026) ────
// Appelee a la NAISSANCE d'une evaluation (lib/avis/naissance.js), et par
// scripts/armer-avis-sans-prestataire.js pour celles qui attendaient deja.
// ⚠ ELLE NE PART QU'UNE FOIS, ET C'EST LA BASE QUI LE DIT (revue de 6e73da3,
// constat 3). Certaines reactions de l'hote ne laissent AUCUNE trace sur la
// ligne : « Publier » ou « Rediger » sans reponse remettent l'horloge a nul,
// puis echouent. L'evaluation redevient `a_remplir`, sans reponse ni horloge —
// indiscernable d'une evaluation jamais armee. Un second armement ferait partir
// un avis que l'hote a arrete. D'ou la MARQUE `avis.auto_armee` au journal du
// coeur, posee AVANT l'horloge et lue avant tout armement : pas de marque
// possible, pas d'horloge (on publie moins, jamais une seconde fois).
//
// N'arme que ce que personne n'a touche : statut `a_remplir`, aucune reponse,
// pas d'horloge. L'ECRITURE est conditionnee aux quatre (constat 4) : une
// reponse partielle de l'hote laisse le statut a `a_remplir`, et sans la
// condition sur les reponses l'hote recevait un rappel « sera publiee
// automatiquement » sur l'evaluation qu'il remplissait.
//
// `depuis` : l'instant a partir duquel compter le delai — le depart (midi,
// heure de Paris) a la naissance du jour du depart, pas minuit (constat 2) :
// « en 24 h » se compte apres le check-out, pas pendant que le voyageur dort.
// `exigerDelaiPlein` (le script) : n'arme pas si le plafond d'Airbnb raccourcit
// le delai choisi par l'hote — Thierry a dit « avec 24 h », pas « avec ce qui
// reste » (constat 1). La decision rend alors `plafonne` pour l'afficher.
// `aBlanc` : la meme decision, sans rien ecrire (le script la montre avant --go).
//
// Rend { arme: true, quand } | { arme: false, motif } | { erreur }. Ne leve pas.
const MARQUE_ARMEE = 'avis.auto_armee'
async function armerSansPrestataire (sb, e, {
  maintenant = Date.now(), aBlanc = false, depuis = null, exigerDelaiPlein = false, par = 'naissance',
} = {}) {
  try {
    // Sans la reference du bien ou du sejour, on ne saurait pas qui fait le
    // menage : on n'arme pas plutot que de conclure « personne ».
    if (!e || !e.id || !e.user_id || !e.property_id || !e.property_id_ref || !e.booking_uid) {
      return { arme: false, motif: 'evaluation incomplete' }
    }
    if (e.status !== 'a_remplir') return { arme: false, motif: `statut ${e.status}` }
    if (e.auto_publier_le) return { arme: false, motif: 'horloge deja posee' }
    if (e.answers_host != null || e.answers_cleaner != null) {
      const reponses = { ...(e.answers_cleaner || {}), ...(e.answers_host || {}) }
      // Une colonne non nulle, meme vide, ne passerait pas la condition de
      // l'ecriture : on le dit ici plutot que d'echouer en silence plus bas.
      return { arme: false, motif: Object.values(reponses).some(v => !vide(v)) ? 'deja des reponses' : 'reponses deja ouvertes' }
    }

    const cfg = await lireHeures(sb, { userId: e.user_id, propertyId: e.property_id })
    if (cfg.erreur) return { erreur: `réglage illisible : ${cfg.erreur}` }
    if (!cfg.heures) return { arme: false, motif: 'reglage desactive' }

    const debut = Math.max(maintenant, Number.isFinite(depuis) ? depuis : maintenant)
    const quand = echeanceAuto({ maintenant: debut, heures: cfg.heures, deadline: e.deadline_at })
    if (!quand) return { arme: false, motif: 'trop pres de l echeance' }
    if (exigerDelaiPlein && Date.parse(quand) < debut + cfg.heures * HEURE) {
      return { arme: false, motif: 'delai plein impossible avant l echeance', plafonne: quand }
    }

    const { data: marques, error: eM } = await sb.from('core_events').select('id')
      .eq('user_id', e.user_id).eq('subject_type', 'guest_evaluation').eq('subject_id', String(e.id))
      .eq('type', MARQUE_ARMEE).limit(1)
    if (eM) return { erreur: `journal illisible : ${eM.message}` }
    if (Array.isArray(marques) && marques.length) return { arme: false, motif: 'deja armee une fois' }

    let grille
    try { grille = await chargerGrille(sb, { userId: e.user_id, propertyId: e.property_id }) }
    catch (err) { return { erreur: err.message } }
    const p = await prestataireParticipe(sb, {
      userId: e.user_id, propertyRef: e.property_id_ref, bookingUid: e.booking_uid, grille,
    })
    if (p.erreur) return { erreur: p.erreur }
    if (p.participe) return { arme: false, motif: 'la prestataire participe' }
    if (aBlanc) return { arme: true, quand, aBlanc: true }

    // La marque AVANT l'horloge : une marque sans horloge publie moins, une
    // horloge sans marque pourrait publier une seconde fois.
    const { error: eJ } = await sb.from('core_events').insert({
      user_id: e.user_id, type: MARQUE_ARMEE, subject_type: 'guest_evaluation', subject_id: String(e.id),
      payload: { booking_uid: e.booking_uid, quand, heures: cfg.heures, par },
    })
    if (eJ) return { erreur: `marque non posée : ${eJ.message}` }

    const { data, error } = await sb.from('guest_evaluations')
      .update({ auto_publier_le: quand })
      .eq('id', e.id).eq('user_id', e.user_id)
      .eq('status', 'a_remplir').is('auto_publier_le', null)
      .is('answers_host', null).is('answers_cleaner', null)
      .select('id')
    if (error) return { erreur: `horloge non posée : ${error.message}` }
    if (!Array.isArray(data) || !data.length) return { arme: false, motif: 'evaluation modifiee entre-temps' }
    console.log('[avis] horloge sans prestataire posee', e.booking_uid, quand, par)
    return { arme: true, quand }
  } catch (err) {
    return { erreur: err.message }
  }
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
  // `siCleanerNul` : la prise qui complete la part d'une prestataire qu'on ne
  // sollicite pas exige que sa colonne soit TOUJOURS nulle (revue de 6e73da3,
  // constat 6) — une prestataire autorisee entre-temps qui vient de cocher ne
  // voit pas son « correct » ecrase par un « impeccable ».
  const reprogrammer = async (e, valeur, extra = {}, { siCleanerNul = false } = {}) => {
    let q = sb.from('guest_evaluations')
      .update({ auto_publier_le: valeur, ...extra })
      .eq('id', e.id).eq('user_id', e.user_id).eq('auto_publier_le', e.auto_publier_le)
    if (siCleanerNul) q = q.is('answers_cleaner', null)
    const { data, error } = await q.select('id')
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
  // Une lecture en panne reporte d'une heure — mais JAMAIS au-dela du plafond
  // (revue de 6e73da3, constat 5) : une panne qui dure ne doit pas faire
  // tomber la publication dans les 12 dernieres heures d'Airbnb. Au plafond,
  // on renonce et l'hote est prevenu.
  const reporterPanne = async (e, raison) => {
    bilan.erreurs++
    const suivant = maintenant + REPORT_SANS_OBJET_MS
    if (e.deadline_at && suivant < Date.parse(e.deadline_at) - MARGE_AVANT_ECHEANCE_MS) {
      await reprogrammer(e, iso(suivant))
      return
    }
    await desarmer(e, 'panne jusqu au plafond : ' + raison)
    await prevenirEchec(e, raison)
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
        if (cfg.erreur) { await reporterPanne(e, 'le réglage de publication automatique est illisible'); continue }
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
        // ⚠ SANS COPIE FIGEE, LA GRILLE DU BIEN SE CHARGE ET SE FIGE A LA PRISE
        // (decision du 9 novembre 2026) : une evaluation armee a la naissance
        // n'a ete remplie par personne, donc jamais figee. Publier sans la
        // figer ferait publier sur la grille PAR DEFAUT (lib/avis/publication.js)
        // des reponses posees sur celle de l'hote. Une copie PRESENTE mais
        // illisible reste un refus, comme a la publication.
        let grille = e.grille_figee
        let figer = false
        if (grille === null || grille === undefined) {
          try { grille = await chargerGrille(sb, { userId: e.user_id, propertyId: e.property_id }) }
          catch (err) {
            // Une panne de lecture passe : report d'une heure, comme le reglage.
            await reporterPanne(e, 'la grille d’évaluation est illisible'); continue
          }
          figer = true
        }
        let complement
        let sansPrestataire = false
        try {
          if (!grille || !Array.isArray(grille.criteres) || !grille.criteres.length) throw new Error('grille absente')
          if (figer) validerGrille(grille)
          // Des questions de la prestataire restent vides : lui demande-t-on son
          // avis ? Oui — sa part n'est pas finie, rien ne part (comme avant).
          // Non — personne ne les remplira, elles prennent le meilleur niveau.
          // La lecture n'a lieu que dans ce cas : une part finie ne coute rien.
          const deja = { ...(e.answers_cleaner || {}), ...(e.answers_host || {}) }
          if (grille.criteres.some(c => c.rempli_par !== 'hote' && vide(deja[c.cle]))) {
            const p = await prestataireParticipe(sb, { userId: e.user_id, propertyRef: e.property_id_ref, bookingUid: e.booking_uid, grille })
            if (p.erreur) { await reporterPanne(e, 'la prestataire du ménage est illisible'); continue }
            sansPrestataire = !p.participe
          }
          complement = completerAuMeilleur(grille, e, { sansPrestataire })
        } catch (err) {
          await desarmer(e, err.message); await prevenirEchec(e, err.message); bilan.echecs++; continue
        }
        const complete = { ...e, grille_figee: grille, answers_host: { ...(e.answers_host || {}), ...complement } }

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
        // Le budget se relit JUSTE AVANT la prise : une redaction peut avoir pris
        // vingt secondes (re-revue de 74ec434).
        if (resteMs && resteMs() < RESTE_MINIMUM_MS) break
        // La grille se fige dans la MEME ecriture conditionnee : la publication
        // relit la ligne, et doit lire la grille sur laquelle on a complete.
        if (!(await reprogrammer(e, null, { answers_host: complete.answers_host, ...(figer ? { grille_figee: grille } : {}) },
          { siCleanerNul: sansPrestataire && e.answers_cleaner == null }))) continue
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
  prestataireParticipe, armerSansPrestataire,
  HEURES_MIN, HEURES_MAX, MARGE_AVANT_ECHEANCE_MS, RAPPEL_AVANT_MS, PLAFOND_PASSAGE, PLAFOND_PUBLICATIONS, RESTE_MINIMUM_MS,
}
