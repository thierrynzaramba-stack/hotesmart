// lib/guestflow/brouillons-dus.js
// LA PASSE QUI FAIT PARTIR LES BROUILLONS ECHUS (chantier « delai de reponse
// IA », lot 2). Spec : docs/specs/spec-delai-reponse-ia.md §4.4.
//
// ⚠ BRANCHEE DANS api/cron.js (passe `brouillons_dus`, avant le dispatch)
// depuis le go de Thierry du 27 octobre 2026. Cet en-tete a affirme le
// contraire pendant la duree du lot — une affirmation fausse en tete du module
// le plus dangereux du chantier, celui qui ENVOIE, et qui ne rougirait jamais
// (constat 9 de la revue).
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

// ⚠ REQUIRE PARESSEUX, ET LE MOTIF QUE J'AVAIS ECRIT ETAIT FAUX : il annoncait
// un cycle d'import, alors que `lib/cron-classify.js` importe
// `journal-envoi-ia.js`, pas ce module-ci — il n'y a donc pas de cycle (constat
// relevé par la troisieme revue, sans consequence).
// Le motif REEL, et il suffit : `cron-classify` instancie un client Supabase et
// charge toute la chaine de classification a l'import. Le charger en tete
// obligerait chaque appelant de cette passe a porter cet environnement.
function fermerTachesPauseLazy (...args) {
  const { fermerTachesPause } = require('../cron-classify')
  if (typeof fermerTachesPause !== 'function') return Promise.resolve()
  return fermerTachesPause(...args)
}
const { formeExploitable, minutesValides } = require('./delais-contrat')
const { estAnnulationVoyageur } = require('../bookings-snapshot-status')
const { journaliserReponseIA } = require('./journal-envoi-ia')
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

// Sous ce reste de cycle, on ne commence plus un envoi. Aligne sur le seuil de
// `executerAutoValidations` (20 s), pour la meme raison : laisser de la marge
// au poste suivant plutot que de finir le sien au prix du cycle.
const RESTE_MIN_MS = 20 * 1000

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
    .select('id, user_id, property_id, book_id, updated_at, send_after')
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
        // ⚠ LA SUSPENSION S'EFFACE AUSSI (constat 5) : desarmer en la laissant
        // produisait un etat sans issue — « vous modifiez » pour toujours, sans
        // lien de reprise et sans reprise automatique possible.
        suspendu_le: null,
        summary: (t.send_after ? "Envoi différé interrompu" : "Envoi interrompu")
          + " : impossible de savoir si le message est parti. "
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
    // ⚠ LE FONDATEUR N'EST ALERTE QUE POUR UN ENVOI DIFFERE (constat 6 de la
    // troisieme revue). `reserverProposition` pose `sending` meme sans
    // echeance : un hote qui clique « Envoyer » sur une proposition en
    // validation manuelle puis ferme son onglet laissait donc une orpheline —
    // et avant ce lot, fermer l'onglet en cours d'envoi n'alertait personne.
    // Le resume aussi etait faux : « Envoi DIFFERE interrompu » alors que rien
    // n'etait differe.
    if (!t.send_after) continue
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

// ─── 1 bis. Les suspensions DORMANTES reprennent toutes seules ───────────────
//
// ⚠ SANS CETTE REPRISE, LA SUSPENSION ANNULE LE PARACHUTE (decision 4 de
// Thierry, 27 octobre 2026). J'avais specifie l'inverse — une suspension
// definitive — et son argument tranche : il suffirait d'OUVRIR un brouillon
// pour que l'oubli redevienne possible, exactement ce que le differe existe
// pour empecher.
//
// Trente minutes sans modification : `updated_at` bouge a chaque geste de
// l'hote sur la tache (ouverture, enregistrement du brouillon), donc son age
// mesure l'inactivite, pas l'anciennete de la tache.
//
// ⚠ L'ECHEANCE REPART AVEC LE TEMPS QUI RESTAIT, 5 MINUTES AU MINIMUM, et ce
// temps se CALCULE : `send_after - suspendu_le` est ce qui restait quand
// l'hote a ouvert le brouillon. Meme regle que l'action `reprendre` de
// api/messages.js — et c'est la MEME phrase ecrite deux fois, donc une dette
// a surveiller (le jour ou le plancher change, il change aux deux endroits).
const SUSPENSION_DORMANTE_MS = 30 * 60 * 1000
const REPRISE_MIN_MS = 5 * 60 * 1000

async function reprendreSuspensionsDormantes (sb, { maintenant, results, bilan }) {
  const limite = new Date(maintenant - SUSPENSION_DORMANTE_MS).toISOString()
  const { data, error } = await sb.from('agent_tasks')
    .select('id, user_id, property_id, send_after, suspendu_le, updated_at')
    .eq('status', 'pending_validation')
    .not('suspendu_le', 'is', null)
    .not('send_after', 'is', null)
    .lt('updated_at', limite)
    .limit(MAX_PAR_CYCLE)
  if (error) {
    results?.errors?.push({ context: 'brouillons_suspensions_lecture', error: error.message })
    return
  }
  for (const t of data || []) {
    const echeance = Date.parse(t.send_after)
    const suspension = Date.parse(t.suspendu_le)
    if (!Number.isFinite(echeance) || !Number.isFinite(suspension)) continue
    const restait = Math.max(REPRISE_MIN_MS, echeance - suspension)
    const nouvelle = new Date(maintenant + restait).toISOString()
    const { data: reprise, error: eU } = await sb.from('agent_tasks')
      .update({ suspendu_le: null, send_after: nouvelle, updated_at: new Date(maintenant).toISOString() })
      .eq('id', t.id).eq('status', 'pending_validation')
      .not('suspendu_le', 'is', null)
      .select('id')
    if (eU) { results?.errors?.push({ context: 'brouillons_suspension_reprise', error: eU.message }); continue }
    if (!reprise || !reprise.length) continue
    bilan.reprises++
    console.log(`[BrouillonsDus] suspension dormante reprise (tache ${t.id}) — echeance ${nouvelle}`)
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
async function encoreLegitime (sb, tache, { maintenant, biens, reglages, reservations, echecLecture }) {
  // ⚠ UNE PANNE DE LECTURE EMPECHE L'ENVOI, ELLE NE L'AUTORISE PAS — constat 5
  // de la revue, et mon repli etait INVERSE par rapport au contrat. Quand la
  // lecture de `agent_alert_config` echouait, `reglages` restait vide, `d`
  // valait `undefined`, et la garde « repasse en validation manuelle » etait
  // SAUTEE : le brouillon partait. Or `lireReglagesDuBien` rend
  // `{ mode: 'test' }` en cas de panne, et `delaiDeReponse` en deduit
  // `manuel` : tout le reste du chantier refuse quand il ne sait pas.
  if (echecLecture && echecLecture.reglages) return { ok: false, motif: 'reglages_illisibles' }
  if (echecLecture && echecLecture.biens) return { ok: false, motif: 'biens_illisibles' }

  const bien = biens.get(cle(tache.user_id, tache.property_id))
  if (!bien) return { ok: false, motif: 'bien_introuvable' }

  // Kill switch par bien : decision de Thierry du 9 octobre 2026 — en pause,
  // aucune reponse automatique, ni maintenant ni a la reprise.
  if (bien.automation_paused === true) return { ok: false, motif: 'automatisation_en_pause' }

  // Le reglage, RELU : l'hote a pu repasser le bien en validation manuelle.
  // ⚠ UNE ENTREE DISPARUE DU BLOB REFUSE AUSSI : `undefined` n'est pas une
  // permission. Le repli du contrat, quand on ne sait pas, est « manuel ».
  const d = reglages.get(cle(tache.user_id, tache.property_id))
  if (!d) return { ok: false, motif: 'reglage_introuvable' }
  if (d.delais && 'reponse_ia' in d.delais) {
    const v = d.delais.reponse_ia
    if (v === null) return { ok: false, motif: 'repasse_en_validation_manuelle' }
    if (!minutesValides(v)) return { ok: false, motif: 'reglage_hors_contrat' }
  } else if (d.mode !== 'auto') {
    return { ok: false, motif: 'repasse_en_validation_manuelle' }
  }

  // ⚠ L'ANNULATION, QUE MON COMMENTAIRE PROMETTAIT SANS LA VERIFIER
  // (constat 7). Rien d'autre ne purge `agent_tasks` a l'annulation : un
  // voyageur qui annule pendant la fenetre de differe recevait la reponse.
  const snap = reservations ? reservations.parTache.get(cle(tache.user_id, tache.book_id)) : undefined
  if (reservations && reservations.echec) return { ok: false, motif: 'reservations_illisibles' }
  // Une reservation absente du cœur n'est pas une permission non plus : sans
  // elle, on ne connait ni le statut, ni le canal de sortie.
  if (!snap) return { ok: false, motif: 'reservation_introuvable' }
  if (estAnnulationVoyageur(snap, bien.provider)) return { ok: false, motif: 'reservation_annulee' }

  // Sejour termine : au-dela du depart, une reponse automatique n'a plus
  // d'objet — et le voyageur a souvent deja recu l'enquete de satisfaction.
  if (tache.departure) {
    const finDuJour = Date.parse(`${String(tache.departure).slice(0, 10)}T23:59:59Z`)
    if (Number.isFinite(finDuJour) && maintenant > finDuJour) {
      return { ok: false, motif: 'sejour_termine' }
    }
  }
  return { ok: true, bien, snapshot: snap }
}

// ─── 4. Les lectures annexes, GROUPEES ───────────────────────────────────────
// ⚠ LA CLE PORTE LE COMPTE, ET LES DEUX LECTURES SONT FILTREES PAR COMPTE.
// Constat 13 de la revue, et c'est une FUITE ENTRE COMPTES : mes Map etaient
// clees sur le seul `provider_property_id`, et `reglages.set(ref, …)`
// parcourait les configs de TOUS les comptes du lot croisees avec TOUTES les
// refs. Des que deux comptes partagent une ref provider — un bien en bascule,
// un bien re-provisionne, une ref non UUID —, le reglage ET le
// `automation_paused` d'un autre compte gouvernaient l'envoi. Un bien en pause
// aurait pu envoyer.
//
// Le precedent du depot le fait deja : `lib/cleaning/sync-menages-entite.js`
// filtre par `.in('user_id', …)`. Je ne l'avais pas suivi.
const cle = (userId, ref) => String(userId) + '|' + String(ref)

async function chargerLeContexte (sb, taches, { results }) {
  const biens = new Map()
  const reglages = new Map()
  const echecLecture = { biens: false, reglages: false }
  if (!taches.length) return { biens, reglages, echecLecture }

  const refs = [...new Set(taches.map(t => String(t.property_id)))]
  const comptes = [...new Set(taches.map(t => String(t.user_id)))]

  // ⚠ UN `in(...)` PAR LOT, PAS UNE REQUETE PAR TACHE. A 30 taches sur 5 biens,
  // la version naive faisait 30 lectures de `properties` pour 5 lignes utiles.
  const { data: lignes, error } = await sb.from('properties')
    .select('id, name, provider, provider_property_id, automation_paused, user_id')
    .in('user_id', comptes)
    .in('provider_property_id', refs)
  if (error) {
    echecLecture.biens = true
    results?.errors?.push({ context: 'brouillons_dus_biens', error: error.message })
  }
  for (const b of lignes || []) biens.set(cle(b.user_id, b.provider_property_id), b)

  // Le blob de reglages est UN par compte : une lecture par compte, pas par bien.
  const { data: configs, error: eC } = await sb.from('agent_alert_config')
    .select('user_id, config')
    .in('user_id', comptes)
  if (eC) {
    echecLecture.reglages = true
    results?.errors?.push({ context: 'brouillons_dus_reglages', error: eC.message })
  }
  for (const c of configs || []) {
    for (const ref of refs) {
      const entree = c.config && c.config[ref]
      if (!entree) continue
      reglages.set(cle(c.user_id, ref), {
        mode: entree.mode || 'test',
        delais: formeExploitable(entree.delais) ? entree.delais : null
      })
    }
  }
  return { biens, reglages, echecLecture }
}

// ─── Les RESERVATIONS du lot : le canal de sortie, et l'annulation ──────────
//
// ⚠ DEUX CONSTATS GRAVES DE LA REVUE EN DEPENDENT.
//
// 2. `envoyerParDefaut` passait `String(tache.book_id)` — un identifiant NU.
//    `sendGuestMessage` pose alors `{ canal: CANAL.OTA }` sans consulter
//    `canalPour`, et l'avertissement est ecrit dans le depot
//    (lib/cron-classify.js) : « `booking` : l'objet de la RESERVATION, pas
//    seulement son identifiant. C'est lui qui porte `source` et `guestEmail`,
//    donc le CANAL de sortie. » Une reservation directe ou `Offline` dont la
//    reponse etait differee partait vers la messagerie OTA — 422
//    `not_supported` chez Channex, et la dette 3 rouverte pour tout le chemin
//    differe.
//
// 7. Mon commentaire promettait que l'annulation etait reverifiee. Elle ne
//    l'etait pas, et rien d'autre ne purge `agent_tasks` a l'annulation : un
//    voyageur qui annule pendant la fenetre de differe recevait quand meme la
//    reponse (« a bientot », un code d'acces…).
async function chargerLesReservations (sb, taches, { results }) {
  const parTache = new Map()
  if (!taches.length) return { parTache, echec: false }
  const comptes = [...new Set(taches.map(t => String(t.user_id)))]
  const ids = [...new Set(taches.map(t => String(t.book_id)))]
  const { data, error } = await sb.from('bookings_snapshot')
    .select('user_id, booking_id, snapshot')
    .in('user_id', comptes)
    .in('booking_id', ids)
  if (error) {
    results?.errors?.push({ context: 'brouillons_dus_reservations', error: error.message })
    return { parTache, echec: true }
  }
  for (const r of data || []) parTache.set(cle(r.user_id, r.booking_id), r.snapshot || null)
  return { parTache, echec: false }
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
  const bilan = { examines: 0, envoyes: 0, reportes: 0, abandonnes: 0, orphelines: 0, reprises: 0,
    erreurs: 0, interrompu: false }

  // ⚠ UN BUDGET MUR, PARCE QUE CETTE PASSE ENVOIE. Le plafond par cycle borne
  // le NOMBRE de brouillons ; il ne borne pas le TEMPS. Trente envois lents
  // (un appel provider chacun) mangeraient les 60 s de `maxDuration` et
  // affameraient le dispatch des changements de reservation, qui tourne apres
  // et qui est deja le poste le plus couteux du cycle.
  //
  // Meme discipline que `executerAutoValidations` : on ne COMMENCE pas un envoi
  // quand il reste moins que le seuil, et le reliquat part au cycle suivant.
  // Un envoi deja commence n'est jamais coupe — c'est entre le claim et
  // l'ecriture du statut que se trouve le seul endroit ou le voyageur peut
  // recevoir un message sans que la tache le dise.
  const resteMs = typeof opts.resteMs === 'function' ? opts.resteMs : null
  const budgetEpuise = () => resteMs !== null && resteMs() < RESTE_MIN_MS

  if (budgetEpuise()) {
    bilan.interrompu = true
    console.log('[BrouillonsDus] budget du cycle epuise avant de commencer — reporte au cycle suivant')
    return bilan
  }

  await reprendreOrphelines(sb, { maintenant, results, bilan })
  // ⚠ CETTE JUSTIFICATION ETAIT FAUSSE (constat 11). J'avais ecrit qu'une
  // suspension reprise devait pouvoir partir dans le MEME cycle : c'est
  // impossible par construction, puisque le plancher de 5 minutes place
  // toujours la nouvelle echeance dans le futur, hors de portee du `lte` de
  // `lireLesDues`. L'ordre des deux passes est donc INOFFENSIF, et il reste ici
  // par simple lisibilite : on remet de l'ordre dans les suspensions avant de
  // regarder ce qui est du.
  await reprendreSuspensionsDormantes(sb, { maintenant, results, bilan })

  const dues = await lireLesDues(sb, { maintenant, plafond, results })
  if (dues === null) { bilan.erreurs++; return bilan }
  if (!dues.length) return bilan

  const { biens, reglages, echecLecture } = await chargerLeContexte(sb, dues, { results })
  const reservations = await chargerLesReservations(sb, dues, { results })

  for (const tache of dues) {
    if (budgetEpuise()) {
      bilan.interrompu = true
      console.log(`[BrouillonsDus] budget du cycle epuise apres ${bilan.envoyes} envoi(s)`
        + ` — ${dues.length - bilan.examines} brouillon(s) reportes au cycle suivant`)
      break
    }
    bilan.examines++

    // ⚠ LA SOURDINE AVANT LE CLAIM, ET SEULEMENT POUR UN BROUILLON MODIFIE
    // (decision 7 de Thierry, 27 octobre 2026). Un brouillon JAMAIS TOUCHE part
    // la nuit comme en journee : la sourdine protege le texte incertain de
    // l'hote, pas la reponse de l'IA. Reporter avant de claimer evite de poser
    // un `sending` qu'on relacherait aussitot.
    if (tache.modifie_le) {
      // ⚠ LA MEME CLE QU'AILLEURS : `user_id|ref`. J'avais corrige
      // `encoreLegitime` et oublie CE point de lecture — la sourdine aurait
      // continue de lire la config d'un autre compte (constat 13), et ses
      // tests l'ont montre en rougissant.
      const d = reglages.get(cle(tache.user_id, tache.property_id))
      const sourdine = d && d.delais ? d.delais.sourdine : null
      const r = echeanceApresSourdine(maintenant, sourdine)
      if (r.repoussee) {
        // ⚠ AUCUNE ALERTE N'EST ENVOYEE ICI, ET MON COMMENTAIRE L'AFFIRMAIT
        // (constat 10). Il disait « l'alerte part a la fin de la plage, et
        // l'envoi quinze minutes apres » : le REPORT est bien en place, mais
        // l'alerte elle-meme est au lot 3. Donc, aujourd'hui, le texte modifie
        // par l'hote sort de la plage de nuit sans qu'il soit prevenu, et les
        // quinze minutes de grace ne protegent rien — elles sont posees pour
        // que le lot 3 n'ait qu'a brancher l'envoi de l'alerte.
        // Dette ecrite au KB : un report sans son alerte est un demi-garde-fou.
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
    // ⚠ LE CLAIM REJOUE LE FILTRE DE LA LECTURE, ET IL RELIT LE TEXTE — constat
    // GRAVE de la troisieme revue. Il ne conditionnait que sur le STATUT, alors
    // que `lireLesDues` filtre aussi `suspendu_le` et capture `suggested_reply`
    // a l'instant de la lecture.
    //
    // Entre les deux, il s'ecoule le chargement du contexte, celui des
    // reservations, et les envois des taches precedentes — jusqu'a vingt
    // secondes. Si l'hote ouvre et enregistre son brouillon dans cette fenetre
    // (`enregistrerBrouillon` pose `suspendu_le` ET le nouveau texte, sans
    // toucher au statut), le claim reussissait, `encoreLegitime` ne regardait
    // jamais `suspendu_le`, et le voyageur recevait L'ANCIEN TEXTE DE L'IA —
    // la version que l'hote etait en train de corriger, son edition perdue.
    // C'est exactement ce que la regle 2 du chantier existe pour empecher.
    //
    // Deux corrections dans la meme requete : la condition `suspendu_le is
    // null`, et `suggested_reply` relu dans le `select` — ce qu'on envoie est
    // ce qui etait en base AU MOMENT DU CLAIM, pas trente secondes avant.
    const { data: prise, error: eClaim } = await sb.from('agent_tasks')
      .update({ status: STATUT_EN_COURS, updated_at: new Date(maintenant).toISOString() })
      .eq('id', tache.id).eq('status', 'pending_validation')
      .is('suspendu_le', null)
      .select('id, suggested_reply')
    if (eClaim) { bilan.erreurs++; results?.errors?.push({ context: 'brouillon_claim', error: eClaim.message }); continue }
    if (!prise || !prise.length) {
      console.log(`[BrouillonsDus] tache ${tache.id} prise ou suspendue entre-temps — rien a faire`)
      continue
    }

    const garde = await encoreLegitime(sb, tache,
      { maintenant, biens, reglages, reservations, echecLecture })
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

    // Le texte RELU au claim fait foi (constat 1) : celui de la lecture initiale
    // peut avoir ete remplace par l'hote entre-temps.
    const texte = prise[0].suggested_reply
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
        ? opts.envoyer(garde.bien, tache, texte, garde.snapshot)
        : envoyerParDefaut(sb, garde.bien, tache, texte, garde.snapshot))
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

    // ⚠ LE JOURNAL DU CŒUR, QUE CE CHEMIN NE FAISAIT PAS DU TOUT (constat 1,
    // GRAVE). Le voyageur recevait la reponse et elle n'existait nulle part :
    // l'hote voyait un fil sans reponse, `conversations` etait muet, et au
    // message suivant l'IA pouvait repondre une SECONDE FOIS a la meme
    // question. Le module est partage avec le chemin immediat — une seule
    // copie des quatre ecritures.
    // ⚠ INJECTABLE, comme l'envoi : c'est ce qui permet de PROUVER par test que
    // le journal du cœur est bien appele — le constat 1 de la revue etait
    // precisement son absence, et aucun test ne pouvait le voir.
    const journaliser = opts.journaliser || journaliserReponseIA
    // ⚠ LA REF PROVIDER, PAS L'UUID — ET C'EST LA REGLE DURE DU DEPOT :
    // « properties.id = UUID ; property_id des tables enfant = TEXT (provider
    // propId). Ne JAMAIS joindre naivement uuid vs text. »
    //
    // Je passais `garde.bien`, dont `.id` est l'UUID. Le journal ecrivait donc
    // `conversations.property_id = <UUID>` et `recordMessage({ propertyId:
    // <UUID> })`, alors que `hasNewerTaskOrConv` lit `conversations` avec la
    // REF provider : la ligne ne matchait JAMAIS. Donc, au message suivant,
    // l'IA pouvait repondre une seconde fois a la meme question — exactement le
    // defaut que le constat 1 de la premiere revue avait ferme, rouvert par la
    // cle. Et la ligne `messages` echappait au filtre de perimetre par bien de
    // /api/messages, donc au regroupement du fil.
    //
    // `tache.property_id` EST la ref provider (c'est `cron-classify` qui l'y a
    // ecrite). Le reste du bien sert pour `provider` et le nom.
    await journaliser(sb, {
      userId: tache.user_id,
      property: { ...garde.bien, id: tache.property_id },
      bookingId: tache.book_id,
      guestName: tache.guest_name, guestMessage: tache.guest_message,
      texte, canal: envoi.canal,
      // ⚠ Le snapshot porte `source`, pas `ota` (constat 10). Passer
      // `undefined` coutait une requete de plus par envoi, pour une valeur
      // qu'on a sous la main.
      ota: (garde.snapshot && garde.snapshot.source) || null,
      origine: 'ia_differee', results,
      // ⚠ CONSTAT 7 : le chemin immediat ferme les taches « reçu pendant la
      // pause », le differe ne le faisait pas — une divergence dans le module
      // cree pour les empecher. Decision de Thierry du 9 octobre 2026.
      fermerPause: fermerTachesPauseLazy
    })

    // ⚠ LE `.select()` N'ETAIT PAS LA, ET LE STATUT POUVAIT NE PAS S'ECRIRE
    // SANS QUE RIEN NE LE DISE (constat 4). Scenario : le cron claime et
    // commence l'envoi ; l'hote clique « Ne pas envoyer » ; la tache passe a
    // `ignored` ; le cron finit son envoi, son UPDATE conditionne sur
    // `sending` ne touche AUCUNE ligne — et `bilan.envoyes++` montait quand
    // meme. Le voyageur avait recu le message, l'hote lisait « rejetee », et
    // rien ne le disait.
    const { data: close, error: eFin } = await sb.from('agent_tasks')
      .update({ status: 'done', send_after: null, updated_at: new Date(maintenant).toISOString() })
      .eq('id', tache.id).eq('status', STATUT_EN_COURS)
      .select('id')
    if (eFin || !close || !close.length) {
      // L'envoi EST parti et le statut n'a pas suivi : on le DIT fort. C'est le
      // seul endroit ou le claim ne protege plus.
      bilan.erreurs++
      const motif = eFin ? eFin.message : 'la tache a change d etat pendant l envoi (clos par l hote ?)'
      results?.errors?.push({ context: 'brouillon_statut_apres_envoi',
        booking_id: String(tache.book_id), error: motif })
      console.error(`[BrouillonsDus] ⚠ ENVOI PARTI mais statut non ecrit (tache ${tache.id}) : ${motif}`)
      try {
        const { reportIncident } = require('../founder-notify')
        await reportIncident('brouillon_envoye_sans_statut', {
          userId: tache.user_id, propertyId: String(tache.property_id), threshold: 1,
          detail: `La reponse differee de la reservation ${tache.book_id} EST PARTIE au voyageur, `
            + `mais la tache ${tache.id} n'a pas pu etre marquee envoyee (${motif}). `
            + `L'hote peut la croire non envoyee.`
        })
      } catch (e) { console.error('[BrouillonsDus] incident non enregistre', e.message) }
      continue
    }
    bilan.envoyes++
    console.log(`[BrouillonsDus] tache ${tache.id} envoyee (${envoi.canal || 'canal inconnu'})`)
  }

  return bilan
}

// L'envoi reel : il passe par le routage commun, jamais par un provider en dur.
//
// ⚠ L'OBJET DE LA RESERVATION, PAS SON IDENTIFIANT (constat 2 de la revue).
// `sendGuestMessage` lit `source` et `guestEmail` pour choisir le canal : avec
// un identifiant nu il pose `{ canal: OTA }` sans consulter `canalPour`, et une
// reservation directe ou `Offline` partait vers la messagerie OTA — 422
// `not_supported`, dette 3 rouverte pour tout le chemin differe.
async function envoyerParDefaut (sb, bien, tache, texte, snapshot) {
  const { sendGuestMessage } = require('../cron-messages')
  const { data: k } = await sb.from('api_keys')
    .select('api_key').eq('user_id', tache.user_id).maybeSingle()
  // ⚠ LE SNAPSHOT N'A PAS D'`id`, ET SANS LUI TOUT ENVOI DIFFERE CIBLAIT LA
  // RESERVATION « undefined » (constat 3, grave). `sendGuestMessage` calcule
  // `bookingId = estObjet ? String(booking.id) : String(booking)` : un
  // snapshot brut donne donc `String(undefined)`, passe tel quel a
  // `channex.sendMessage`, a `sendViaBeds24` et a la cle de fil de l'e-mail.
  // Le chemin immediat construit `{ id: bookingId, ...snap }` ; je passais le
  // snapshot nu.
  //
  // ⚠ ET AUCUN TEST NE L'ATTRAPAIT, parce qu'ils injectent tous `opts.envoyer`.
  // Un chemin que les tests ne traversent jamais n'est pas teste : celui-ci a
  // desormais le sien (`tests/guestflow-brouillons-dus.test.js`,
  // « envoyerParDefaut »).
  return sendGuestMessage(k && k.api_key, bien,
    { id: String(tache.book_id), ...(snapshot || {}) }, texte,
    { userId: tache.user_id, eventType: 'reponse_ia_differee' })
}

module.exports = {
  envoyerBrouillonsDus, reprendreOrphelines, reprendreSuspensionsDormantes, encoreLegitime,
  MAX_PAR_CYCLE, SENDING_ORPHELIN_MS, RESTE_MIN_MS, SUSPENSION_DORMANTE_MS, REPRISE_MIN_MS, STATUT_EN_COURS
}
