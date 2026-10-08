// lib/avis/naissance.js
//
// QUAND UNE EVALUATION DU VOYAGEUR NAIT.
//
// Constat de la nuit du 2 octobre 2026 : aucun code ne creait de ligne
// `guest_evaluations`. Seuls les scripts de recette en inseraient ; en
// production, la liste des evaluations serait restee vide pour toujours.
//
// Mesure en production, en lecture seule : les 576 objets review Airbnb lus
// chez Channex portent TOUS une note du voyageur. Channex ne cree donc l'objet
// — la cible de la publication — que lorsque le voyageur a laisse un avis.
//
// D'ou TROIS naissances (decision de Thierry du 2 octobre 2026, spec §9 bis,
// qui remplace la D2 de la nuit) :
//   1. LE JOUR DU DEPART, pour chaque sejour Airbnb termine (`naitreAuDepart`,
//      depuis le cron, par les departs du jour lus sur index) : echeance =
//      depart + 14 jours, celle d'Airbnb. L'avis du voyageur est invisible chez
//      Airbnb avant le notre : attendre son arrivee faisait rater la plupart
//      des evaluations ;
//   2. la prestataire ouvre ses questions apres « Menage fait » : meme echeance,
//      si le cron ne l'a pas deja fait naitre ;
//   3. l'objet review Channex arrive (poll ou webhook) : il est RATTACHE a
//      l'evaluation existante, ou en cree une (`rattacherObjetsRecus`). Il ne
//      fait qu'AVANCER l'echeance, jamais la reculer.
//
// L'objet reste la cible de la publication : sans lui, l'evaluation se
// remplit mais ne part pas (refus « La plateforme n'a pas encore ouvert d'avis »).
//
// ⚠ NI POUR UN OBJET FERME. Le poll relit TOUS les avis a chaque passage : sans
// filtre, le premier passage apres la mise en production aurait cree une
// evaluation pour chacun des objets historiques rattaches (335 en production,
// depuis 2022), delais depasses compris. Seuls les objets encore OUVERTS
// (`expired_at` dans le futur) et dont l'evaluation du voyageur n'est pas deja
// partie font naitre quelque chose.
//
// ⚠ « DEJA PARTIE » NE SE LIT PAS DANS `is_replied`. Constat de review : en
// base, `ota_reviews.is_replied` veut dire « l'hote a REPONDU a l'avis du
// voyageur » — l'inverse de proche. Le lire ici aurait ecarte un objet encore
// publiable des que l'hote avait repondu, et fait naitre une evaluation pour un
// voyageur deja evalue depuis l'app Airbnb. Le bon signal est celui que
// lib/channels/channex.js lit pour la publication : `reply.guest_review` dans
// l'objet brut (mesure du 2 octobre 2026). Une evaluation ecrite dans l'APP
// Airbnb n'y apparait jamais : voir `rangerEvalueesAilleurs`.
//
// Spec docs/specs/spec-evaluation-voyageur.md §6, §7, §10.

// Le seul couple evaluable en V1 (spec §11, etape 0) : Airbnb, par Channex.
function estEvaluable ({ provider, ota } = {}) {
  return String(provider || '').toLowerCase() === 'channex'
    && String(ota || '').toLowerCase() === 'airbnb'
}

// Les champs qui disent que l'evaluation du voyageur est deja partie chez
// l'OTA. Les memes que lib/channels/channex.js (`lireAvis`).
const { ecrireAvecOrigine } = require('./origine')

const PARTI = ['guest_review', 'guest_review_submitted_at']

// ⚠ L'EVALUATION PARTIE PAR CHANNEX VIT DANS `reply.guest_review` (mesure en
// production du 2 octobre 2026, huit evaluations publiees). Les cles a la racine
// sont gardees par prudence ; elles n'ont jamais ete vues.
function evaluationDejaPartie (ligne) {
  const a = ligne && ligne.raw && ligne.raw.attributes
  if (!a || typeof a !== 'object') return false
  if (a.reply && typeof a.reply === 'object' && a.reply.guest_review) return true
  return PARTI.some(k => Boolean(a[k]))
}

// Channex rend `expired_at` SANS fuseau ('2026-09-29T18:29:33.852000') :
// `Date.parse` le lirait en heure locale. C'est de l'UTC.
function instantUTC (valeur) {
  const t = String(valeur || '')
  if (!t) return NaN
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z')
}

// Un objet review peut-il encore recevoir une evaluation ?
function objetOuvert (ligne, maintenant = Date.now()) {
  if (!ligne || evaluationDejaPartie(ligne)) return false
  if (!ligne.expired_at) return false            // on n'invente pas d'echeance
  const fin = instantUTC(ligne.expired_at)
  return Number.isFinite(fin) && fin > maintenant
}

/**
 * Fait naitre l'evaluation d'un sejour si elle n'existe pas, et lui rattache
 * l'objet review s'il est fourni et qu'elle n'en a pas encore.
 *
 * Idempotente : la contrainte `guest_evaluations_unique_sejour (user_id,
 * booking_uid)` empeche le doublon, et le rattachement ne touche qu'une ligne
 * SANS objet — il n'ecrase jamais un rattachement existant.
 *
 * @returns {{ cree: boolean, rattache: boolean } | { ignore: string } | { erreur: string }}
 */
async function assurerEvaluation (sb, {
  userId, propertyId, propertyRef, bookingUid, provider, ota,
  objet = null, menageEventId = null, language = null, echeance = null,
}) {
  if (!estEvaluable({ provider, ota })) return { ignore: 'non_evaluable' }
  if (!userId || !propertyId || !propertyRef || !bookingUid) return { ignore: 'sejour_incomplet' }

  const ligne = {
    user_id: userId,
    property_id: propertyId,
    property_id_ref: String(propertyRef),
    booking_uid: String(bookingUid),
    provider: 'channex',
    ota: 'airbnb',
    status: 'a_remplir',
    ...(menageEventId ? { menage_event_id: menageEventId } : {}),
    ...(language ? { language } : {}),
    // L'echeance : celle d'Airbnb (depart + 14 jours, §9 bis) quand on connait
    // le depart ; sinon celle de l'objet Channex.
    ...(echeance ? { deadline_at: echeance } : {}),
    ...(objet ? { ota_review_id: objet.id, ...(echeance ? {} : { deadline_at: objet.expired_at }) } : {}),
  }

  // ⚠ `ignoreDuplicates` : une evaluation deja nee n'est JAMAIS reecrite ici.
  // Son statut, ses reponses et son texte appartiennent a ceux qui l'ont remplie.
  const { data: nees, error } = await sb.from('guest_evaluations')
    .upsert(ligne, { onConflict: 'user_id,booking_uid', ignoreDuplicates: true })
    .select('id')
  if (error) return { erreur: error.message }
  const cree = Array.isArray(nees) && nees.length > 0

  if (cree || !objet) return { cree, rattache: cree && Boolean(objet) }

  // Deja nee (au depart, ou par la prestataire) : on rattache l'objet s'il
  // manque, sans jamais remplacer un objet deja rattache.
  const { data: maj, error: eMaj } = await sb.from('guest_evaluations')
    .update({ ota_review_id: objet.id })
    .eq('user_id', userId).eq('booking_uid', String(bookingUid))
    .is('ota_review_id', null)
    .select('id')
  if (eMaj) return { erreur: eMaj.message }
  const rattache = Array.isArray(maj) && maj.length > 0
  // ⚠ L'ECHEANCE NE RECULE JAMAIS (§9 bis). Celle d'une evaluation nee au
  // depart est celle d'Airbnb ; l'objet ne la remplace que si elle manque, ou
  // s'il ferme PLUS TOT — la plus proche des deux, par prudence (revue de
  // 94f9a43 : sinon la relance J-1 tomberait apres la fermeture).
  // Tentee meme sans rattachement a ce passage : si elle avait echoue au
  // precedent, rien d'autre ne la reposerait (l'evaluation sans echeance est
  // relue par `rattacherObjetsRecus`, pas ecartee).
  if (objet.expired_at) {
    for (const borne of [q => q.is('deadline_at', null), q => q.gt('deadline_at', objet.expired_at)]) {
      const { error: eD } = await borne(sb.from('guest_evaluations')
        .update({ deadline_at: objet.expired_at })
        .eq('user_id', userId).eq('booking_uid', String(bookingUid)))
      if (eD) return { erreur: eD.message }
    }
  }
  return { cree: false, rattache }
}

/**
 * Naissance 2 : apres l'ecriture d'un lot d'avis recus, les objets Airbnb
 * ouverts et rattaches a une reservation font naitre — ou completent — leur
 * evaluation.
 *
 * ⚠ NE LEVE JAMAIS. Le poll et le webhook ecrivent d'abord les avis recus, qui
 * sont la donnee du coeur ; une evaluation qui ne nait pas est un manque
 * rattrape au passage suivant, pas une raison de faire echouer l'ingestion.
 *
 * @returns {{ candidats: number, crees: number, rattaches: number, erreurs: number }}
 */
async function rattacherObjetsRecus (sb, lignes, { maintenant = Date.now() } = {}) {
  const bilan = { candidats: 0, crees: 0, rattaches: 0, erreurs: 0 }
  const lot = (Array.isArray(lignes) ? lignes : [lignes]).filter(l =>
    l && l.booking_uid && estEvaluable(l) && objetOuvert(l, maintenant))
  bilan.candidats = lot.length
  if (!lot.length) return bilan

  try {
    // Les identifiants des objets viennent de la base, pas de la ligne : le
    // lot vient d'etre ecrit par upsert, qui ne les rend pas.
    const parCompte = new Map()
    for (const l of lot) {
      if (!parCompte.has(l.user_id)) parCompte.set(l.user_id, [])
      parCompte.get(l.user_id).push(l)
    }
    for (const [userId, toutes] of parCompte) {
      // ⚠ D'ABORD CE QUI EXISTE DEJA, en une requete. Constat de review : sans
      // cette lecture, une evaluation deja rattachee coutait deux allers-retours
      // par jour pendant les trente jours de l'objet — un upsert ignore puis un
      // update sans cible — dans le budget d'un poll qui a deja du passer a
      // l'ecriture par lot pour tenir.
      const { data: deja, error: eDeja } = await sb.from('guest_evaluations')
        .select('booking_uid, ota_review_id, deadline_at')
        .eq('user_id', userId)
        .in('booking_uid', toutes.map(l => String(l.booking_uid)))
      if (eDeja) { bilan.erreurs += toutes.length; console.error('[avis] naissance : evaluations illisibles', eDeja.message); continue }
      // Rattachee = un objet ET une echeance : une echeance manquante se repare.
      const rattachees = new Set((deja || []).filter(e => e.ota_review_id && e.deadline_at).map(e => String(e.booking_uid)))
      const lignesDuCompte = toutes.filter(l => !rattachees.has(String(l.booking_uid)))
      if (!lignesDuCompte.length) continue

      const { data: objets, error } = await sb.from('ota_reviews')
        .select('id, external_review_id, expired_at')
        .eq('user_id', userId).eq('provider', 'channex')
        .in('external_review_id', lignesDuCompte.map(l => String(l.external_review_id)))
      if (error) { bilan.erreurs += lignesDuCompte.length; console.error('[avis] naissance : objets illisibles', error.message); continue }
      const parRef = new Map((objets || []).map(o => [String(o.external_review_id), o]))

      for (const l of lignesDuCompte) {
        const objet = parRef.get(String(l.external_review_id))
        if (!objet) { bilan.erreurs++; continue }
        // ⚠ L'ECHEANCE D'AIRBNB, PAS CELLE DE CHANNEX (recette de Thierry du
        // 9 octobre 2026). Nee de l'objet, une evaluation prenait `expired_at`
        // (reception + ~30 jours) : neuf evaluations affichaient « 5 a 20 jours
        // restants » alors qu'Airbnb fermait 14 jours apres le depart. L'objet
        // arrive AU DEPART (mesure du 2 octobre) : reception + 14 jours est la
        // fermeture d'Airbnb — la plus proche des deux echeances est gardee.
        const recu = instantUTC(l.received_at)
        const airbnb = Number.isFinite(recu) ? new Date(recu + FENETRE_AIRBNB_MS).toISOString() : null
        const channex = objet.expired_at || l.expired_at || null
        const echeance = airbnb && channex ? (Date.parse(airbnb) < Date.parse(channex) ? airbnb : channex) : (airbnb || channex)
        const r = await assurerEvaluation(sb, {
          userId, propertyId: l.property_id, propertyRef: l.property_id_ref,
          bookingUid: l.booking_uid, provider: l.provider, ota: l.ota,
          objet: { id: objet.id, expired_at: echeance }, echeance,
        })
        if (r.erreur) { bilan.erreurs++; console.error('[avis] naissance echouee', l.booking_uid, r.erreur) }
        else if (r.cree) bilan.crees++
        else if (r.rattache) bilan.rattaches++
      }
    }
  } catch (e) {
    bilan.erreurs++
    console.error('[avis] naissance : exception', e.message)
  }
  // Puis le rangement des evaluations deja faites sur Airbnb (spec §6).
  const r = await rangerEvalueesAilleurs(sb, lot, { maintenant })
  if (r.rangees) bilan.rangees = r.rangees
  bilan.erreurs += r.erreurs
  return bilan
}

// ─── « Evaluee sur Airbnb » (spec §6, regle de Thierry du 2 octobre au soir) ──
// Une evaluation ecrite dans l'application Airbnb n'arrive JAMAIS chez Channex.
// Mais Airbnb garde l'avis du voyageur cache tant que les deux parties n'ont pas
// ecrit le leur, ou jusqu'a la fin des 14 jours : un avis VISIBLE AVANT
// L'ECHEANCE prouve que l'hote a deja evalue. L'evaluation qui l'attendait chez
// nous passe `evaluee_ailleurs`.
//
// ⚠ SEULEMENT ce qui attend : jamais une evaluation publiee (c'est nous qui
// l'avons envoyee), expiree ou abandonnee, ni en echec de publication — un echec
// incertain reste une alarme pour un humain, pas un rangement silencieux.
// Ne leve jamais.
const EN_ATTENTE_DE_L_HOTE = ['a_remplir', 'soumise_prestataire', 'a_valider']

// ⚠ LA PREUVE EST LUE DANS L'OBJET BRUT, STRICTEMENT (revue de 9f76ae2) :
// `is_hidden` absent ou nul n'est PAS « visible » — le writer normalise
// `is_hidden === true`, donc un champ manquant y devient faux, et un payload
// partiel aurait range en masse. Et il faut un AVIS : une note ou un texte du
// voyageur — un objet vide et non cache ne prouve rien.
function avisDuVoyageurVisible (l) {
  const a = l && l.raw && l.raw.attributes
  if (!a || typeof a !== 'object' || a.is_hidden !== false) return false
  const note = Number(a.overall_score)
  return (Number.isFinite(note) && note > 0) || Boolean(a.content || a.raw_content)
}

// ⚠ L'ECHEANCE D'AIRBNB SE CALCULE SUR L'OBJET LUI-MEME (re-revue de 5c59a7b) :
// une evaluation nee de l'objet porte l'echeance de Channex (~30 jours), et
// entre J+14 et J+30 l'avis devient public parce que le delai d'Airbnb est
// ecoule, pas parce que l'hote a evalue. L'objet Channex arrive cache AU
// DEPART (mesure de production du 2 octobre 2026) : sa reception + 14 jours est
// l'echeance d'Airbnb. Sans date de reception : on ne range pas.
const FENETRE_AIRBNB_MS = 14 * 86400000
function avantLaFinAirbnb (l, maintenant) {
  const recu = instantUTC(l.received_at)
  return Number.isFinite(recu) && maintenant < recu + FENETRE_AIRBNB_MS
}

async function rangerEvalueesAilleurs (sb, lignes, { maintenant = Date.now() } = {}) {
  const bilan = { rangees: 0, erreurs: 0 }
  const visibles = (Array.isArray(lignes) ? lignes : [lignes]).filter(l =>
    l && l.booking_uid && estEvaluable(l) && objetOuvert(l, maintenant) && avisDuVoyageurVisible(l)
    && avantLaFinAirbnb(l, maintenant))
  if (!visibles.length) return bilan
  try {
    const parCompte = new Map()
    for (const l of visibles) {
      if (!parCompte.has(l.user_id)) parCompte.set(l.user_id, [])
      parCompte.get(l.user_id).push(String(l.booking_uid))
    }
    for (const [userId, sejours] of parCompte) {
      // ⚠ CONTRE L'ECHEANCE D'AIRBNB, pas celle de Channex (revue de
      // 9f76ae2) : `expired_at` vaut ~reception + 30 jours, Airbnb ferme a
      // depart + 14. Apres, l'avis devient public parce que le delai est fini,
      // pas parce que l'hote a evalue. Sans echeance connue : on ne range pas.
      const { data, error } = await ecrireAvecOrigine(maj => sb.from('guest_evaluations')
        .update(maj)
        .eq('user_id', userId).in('booking_uid', sejours).in('status', EN_ATTENTE_DE_L_HOTE)
        .gt('deadline_at', new Date(maintenant).toISOString())
        .select('id, booking_uid'),
      { status: 'evaluee_ailleurs', origine_texte: 'ailleurs', auto_publier_le: null, updated_at: new Date(maintenant).toISOString() })
      if (error) { bilan.erreurs++; console.error('[avis] rangement « evaluee sur Airbnb » refuse', error.message); continue }
      bilan.rangees += (data || []).length
      // Une trace par evaluation rangee, distincte du geste de l'hote, en UNE
      // ecriture. Ecrite apres le rangement : un echec du journal se logue, il
      // ne defait pas le rangement (la ligne garde son statut et sa date).
      if ((data || []).length) {
        const { error: eJ } = await sb.from('core_events').insert(data.map(r => ({
          user_id: userId, type: 'avis.evaluee_ailleurs', subject_type: 'guest_evaluation',
          subject_id: r.id, payload: { booking_uid: r.booking_uid, par: 'releve' },
        })))
        if (eJ) console.error('[avis] rangement non journalise', eJ.message)
      }
    }
  } catch (e) {
    bilan.erreurs++
    console.error('[avis] rangement : exception', e.message)
  }
  return bilan
}

// ─── Naissance au jour du depart (§9 bis, decision de Thierry du 2 octobre) ──
// L'evaluation nait LE JOUR DU DEPART, pour chaque sejour Airbnb termine — l'avis
// du voyageur est invisible chez Airbnb avant le notre, attendre son arrivee
// aurait fait rater la plupart des evaluations.
//
// ⚠ PAR EVENEMENT, PAS PAR BALAYAGE : la source est `menages`, qui porte un
// depart par reservation pour tous les comptes, lue par un INDEX sur
// `departure_date` — seulement les departs du jour et des deux precedents (le
// rattrapage d'un cycle manque). Jamais les reservations a venir, jamais tout.
//
// ⚠ ECHEANCE = DEPART + 14 JOURS, la fenetre d'Airbnb.
//
// Ne leve jamais : une evaluation qui ne nait pas a ce passage naitra au suivant.
const JOURS_RATTRAPAGE = 2
const FENETRE_AIRBNB_JOURS = 14
const PLAFOND_DEPARTS = 500
const STATUTS_SANS_SEJOUR = new Set(['cancelled', 'demapped', 'request', 'blocked', 'inquiry', 'black'])

const jourParis = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(ms))
const echeanceDuDepart = (depart) => new Date(Date.parse(String(depart).slice(0, 10) + 'T12:00:00Z') + FENETRE_AIRBNB_JOURS * 86400000).toISOString()

async function naitreAuDepart (sb, { maintenant = Date.now() } = {}) {
  const bilan = { departs: 0, evaluables: 0, crees: 0, erreurs: 0 }
  try {
    const jours = []
    for (let j = JOURS_RATTRAPAGE; j >= 0; j--) jours.push(jourParis(maintenant - j * 86400000))
    const { data: menages, error } = await sb.from('menages')
      .select('user_id, property_id, booking_id, departure_date, status')
      .in('departure_date', jours)
      .neq('status', 'cancelled')
      // Un ordre, pour qu'une troncature soit la meme d'un passage a l'autre :
      // le jour le plus recent d'abord, les plus anciens se rattrapent ensuite.
      .order('departure_date', { ascending: false })
      .order('booking_id', { ascending: true })
      .limit(PLAFOND_DEPARTS)
    if (error) { bilan.erreurs++; console.error('[avis] naissance au depart : menages illisibles', error.message); return bilan }
    bilan.departs = (menages || []).length
    if (!bilan.departs) return bilan
    // ⚠ UNE TRONCATURE SE DIT. Au plafond, des departs n'ont pas ete lus : le
    // passage le compte en erreur, visible dans `results.errors` du cron.
    if (bilan.departs >= PLAFOND_DEPARTS) {
      bilan.erreurs++
      console.error(`[avis] naissance au depart : plafond de ${PLAFOND_DEPARTS} departs atteint, lecture tronquee`)
    }

    const parCompte = new Map()
    for (const m of menages) {
      if (!parCompte.has(m.user_id)) parCompte.set(m.user_id, [])
      parCompte.get(m.user_id).push(m)
    }
    for (const [userId, departs] of parCompte) {
      const [snaps, biens] = await Promise.all([
        sb.from('bookings_snapshot').select('booking_id, property_id, snapshot')
          .eq('user_id', userId).in('booking_id', departs.map(d => String(d.booking_id))),
        sb.from('properties').select('id, provider_property_id')
          .eq('user_id', userId).in('provider_property_id', [...new Set(departs.map(d => String(d.property_id)))]),
      ])
      if (snaps.error || biens.error) { bilan.erreurs++; continue }
      // ⚠ D'ABORD CE QUI EST DEJA NE (revue de 94f9a43) : le cron passe toutes
      // les cinq minutes pendant trois jours ; sans cette lecture, chaque depart
      // couterait un upsert ignore a chaque passage.
      const { data: nees, error: eNees } = await sb.from('guest_evaluations').select('booking_uid')
        .eq('user_id', userId).in('booking_uid', departs.map(d => String(d.booking_id)))
      if (eNees) { bilan.erreurs++; continue }
      const dejaNees = new Set((nees || []).map(e => String(e.booking_uid)))
      const snapDe = new Map((snaps.data || []).map(s => [String(s.booking_id), s]))
      const biensParRef = new Map()
      for (const b of biens.data || []) {
        const k = String(b.provider_property_id)
        biensParRef.set(k, biensParRef.has(k) ? null : b)   // ambigu = null : on ne devine pas
      }
      for (const d of departs) {
        const snap = snapDe.get(String(d.booking_id))
        const sp = (snap && snap.snapshot) || {}
        const provider = String(sp.provider || '').toLowerCase()
        const ota = /airbnb/i.test(String(sp.source || '')) ? 'airbnb' : String(sp.source || '').toLowerCase()
        if (!snap || STATUTS_SANS_SEJOUR.has(String(sp.status || '').toLowerCase())) continue
        if (!estEvaluable({ provider, ota })) continue
        const bien = biensParRef.get(String(d.property_id))
        if (!bien) continue
        bilan.evaluables++
        if (dejaNees.has(String(d.booking_id))) continue
        const r = await assurerEvaluation(sb, {
          userId, propertyId: bien.id, propertyRef: String(d.property_id), bookingUid: String(d.booking_id),
          provider, ota, echeance: echeanceDuDepart(d.departure_date),
        })
        if (r.erreur) { bilan.erreurs++; console.error('[avis] naissance au depart echouee', d.booking_id, r.erreur) }
        else if (r.cree) bilan.crees++
      }
    }
  } catch (e) {
    bilan.erreurs++
    console.error('[avis] naissance au depart : exception', e.message)
  }
  return bilan
}

module.exports = { assurerEvaluation, rattacherObjetsRecus, rangerEvalueesAilleurs, naitreAuDepart, echeanceDuDepart, estEvaluable, objetOuvert, evaluationDejaPartie, instantUTC }
