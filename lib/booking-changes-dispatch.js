// lib/booking-changes-dispatch.js
// DOC : docs/kb/booking-changes.md (modif = MEME COMMIT)
//
// Distribue les changements de reservation (table booking_change_events, produits
// par le writer lib/bookings-snapshot.js) aux trois consommateurs, dans l'ordre :
//   1. menages        -> lib/cleaning/sync-menages.js  (menage_events)
//   2. codes d'acces  -> lib/cron-access.js            (cancel / refresh)
//   3. templates      -> lib/cron-messages.js          (booking_confirmed sur 'new')
//
// GARDE ANTI-BOUCLE (la regle la plus importante de ce module) : un evenement est
// marque processed_at MEME SI un consommateur echoue. L'echec est trace dans
// automation_incidents et dans processing_errors, mais l'evenement n'est JAMAIS
// rejoue automatiquement. Un retraitement en boucle sur une erreur permanente
// couterait bien plus cher qu'une notification manquee — c'est la lecon des
// 79 350 faux menage_events.

const { supabase } = require('./cron-shared')
const { reportIncident } = require('./founder-notify')
const { isActiveStatus } = require('./bookings-snapshot-status')
const { syncMenageEvent, loadContext, cle } = require('./cleaning/sync-menages')
const { cancelAccessCode, refreshAccessCode } = require('./cron-access')
const { triggerTemplates } = require('./cron-messages')
const { cloturerVente, rouvrirApresAnnulation } = require('./price-log')

// Lot volontairement petit : chaque evenement 'new' peut declencher un appel
// Haiku (~2 s) et un appel Seam, et api/cron.js est plafonne a maxDuration 60 s
// (vercel.json). Un lot de 200 epuisait le budget avant les sondes d'alerting et
// le heartbeat cron_logs. Le reliquat part au cycle suivant, 5 minutes plus tard.
const LOT_MAX = 25
// Budget mur : on arrete proprement plutot que de se faire tuer par Vercel au
// milieu d'un evenement (entre les consommateurs et le marquage processed_at,
// ce qui rejouerait l'evenement indefiniment).
const BUDGET_MS = 25000

// Reconstruit l'objet « booking » attendu par les consommateurs historiques a
// partir du snapshot unifie. Les champs utilises sont : id, propertyId,
// firstName, lastName, arrival, departure, source (hasMessagingThread).
function bookingDepuisSnapshot(event, snapshot) {
  const s = snapshot || {}
  return {
    id:         event.booking_id,
    propertyId: event.property_id,
    firstName:  s.firstName || '',
    lastName:   s.lastName || '',
    arrival:    s.arrival || null,
    departure:  s.departure || null,
    source:     s.source || null,
    // ⚠ SANS CE CHAMP, TOUTE LA GARDE D'EMPREINTE EST INERTE SUR CE CHEMIN.
    // `triggerTemplates` calcule l'empreinte par `codeOtaBrut(booking)`, qui
    // lit `apiReference` / `ota_reservation_code` / `otaReservationCode`. Cet
    // objet-ci n'en portait AUCUN : l'empreinte valait donc `null`, la garde
    // etait sautee entierement, et `message_sent_log` etait ecrit avec
    // `stay_key = NULL` — donc invisible a la garde suivante.
    //
    // MESURE DU 10 SEPTEMBRE 2026, 21:10. Au mapping Airbnb de La bulle,
    // Channex a livre trois sejours qui existaient deja sous la cle Beds24.
    // Le message `booking_confirmed` — LE MESSAGE DE BIENVENUE — est reparti
    // aux TROIS voyageurs, qui l'avaient recu les 5, 7 et 9 septembre. Leurs
    // lignes de journal portaient pourtant la bonne empreinte
    // (`stay_key = HMXJPMDJEN`, etc.) : la garde ne l'a pas lue parce qu'elle
    // n'avait rien a comparer.
    //
    // C'est exactement le dommage que l'empreinte de sejour existe pour
    // empecher, et la regle que Thierry a gravee : « il ne faut pas envoyer
    // des messages deja envoyes au voyageur ». Le mecanisme etait bon ; il
    // etait branche sur un objet amputé.
    otaReservationCode: s.otaReservationCode || null
  }
}

// ─── Consommateur 2 : codes d'acces ──────────────────────────────────────────
// Memes regles qu'avant l'unification : annulation -> suppression du code ;
// modification de dates -> regeneration. Un changement du nombre de voyageurs
// ne touche pas au code.
async function consommateurCodesAcces(event, booking) {
  if (event.type === 'cancelled') {
    await cancelAccessCode(String(event.booking_id), event.user_id)
    return
  }
  if (event.type === 'modified') {
    const c = event.changes || {}
    if (c.arrival || c.departure) {
      await refreshAccessCode(String(event.booking_id), booking, event.user_id)
    }
  }
}

// Reconstruit le bien au format attendu par les consommateurs historiques, qui
// recevaient auparavant l'objet BRUT de l'API Beds24.
//   - `provider` commande le routage d'envoi (lib/cron-messages.js sendGuestMessage) :
//     sans lui, un hote Channex-only partirait vers sendViaBeds24 sans cle -> echec
//     silencieux, et message_sent_log etant ecrit AVANT l'envoi, jamais rejoue.
//   - address / phone / checkin / checkout alimentent les placeholders des
//     templates ({adresse}, {telephone_hote}, {checkin}, {checkout}).
function propertyDepuisContexte(event, ctx) {
  const k = cle(event.user_id, event.property_id)
  const p = ctx.propsByKey[k] || {}
  const kb = ctx.knowledgeByKey[k] || {}
  return {
    id:           event.property_id,
    name:         p.name || null,
    provider:     p.provider || event.provider || null,
    address:      kb.adresse || p.address || '',
    phone:        kb.telephone_hote || '',
    // Le formulaire Connaissances prime ; a defaut, les heures synchronisees
    // depuis le provider. Sans ce repli, un hote Beds24 n'ayant jamais ouvert le
    // formulaire recevait 18:00/10:00 (defauts codes en dur) dans son
    // booking_confirmed, alors que son template d'arrivee affichait l'heure
    // reelle : deux messages contradictoires au meme voyageur.
    checkInStart: kb.checkin  || p.checkin_time  || null,
    checkOutEnd:  kb.checkout || p.checkout_time || null
  }
}

// ─── Consommateur 3 : templates evenementiels ────────────────────────────────
async function consommateurTemplates(event, booking, ctx, snapshot) {
  if (event.type !== 'new') return

  // La detection et l'effet sont decouples par la file : entre les deux, la
  // reservation a pu etre annulee (le feed Channex draine plusieurs revisions
  // en une passe, et un evenement peut attendre jusqu'a 5 minutes). Sans cette
  // re-verification, on souhaite la bienvenue a un voyageur dont la reservation
  // n'existe plus — et message_sent_log rend l'envoi non rejouable.
  if (snapshot && !isActiveStatus(snapshot, event.provider)) {
    console.log(`[dispatch] booking_confirmed ignore ${event.booking_id} : reservation plus active`)
    return
  }

  const property = propertyDepuisContexte(event, ctx)
  await triggerTemplates(event.user_id, ctx.beds24KeyByUser[event.user_id] || null, property, booking, 'booking_confirmed', ctx.results)
}

// ─── Consommateur 4 : journal des prix affiches ──────────────────────────────
// Fige le prix affiche des nuits qui viennent d'etre vendues.
// Spec : docs/specs/spec-yieldflow-v1.md §4 — docs/kb/price-log.md
//
// ⚠ AUCUN APPEL PROVIDER (regle 6). Tout vient du snapshot deja ecrit par la
// couche sync : c'est precisement pourquoi ce travail est ici, dans le
// dispatcher, et pas dans un cron qui reinterrogerait Beds24 ou Channex.
//
// ⚠ LE DISPATCHER PORTE LA CLE PROVIDER, LE JOURNAL PORTE L'UUID.
// `event.property_id` est le `provider_property_id` (regle 10) ; le journal est
// cle sur `properties.id` (decision E6). Passer l'un pour l'autre ne leverait
// aucune erreur — un `update ... eq('property_id', '169567')` sur une colonne
// uuid ne rend simplement AUCUNE ligne — et le journal resterait vide sans que
// rien ne le signale. On resout par le contexte, et on refuse de travailler si
// la resolution echoue.
async function consommateurJournalPrix (event, ctx, snapshot) {
  // Seule une reservation qui OCCUPE la nuit la retire de la vente. Un
  // `blocked`, un `request` ou une annulation ne ferment aucune ligne.
  //
  // ⚠ `modified` COMPTE AUSSI, DES QUE LES DATES BOUGENT — releve en review.
  // Une reservation prolongee du 15 au 18 vend les nuits 16 et 17 qui
  // n'existaient pas au `new` : leur ligne resterait courante indefiniment et
  // le moteur les compterait « affichees, jamais vendues ». C'est exactement la
  // condition que `consommateurCodesAcces` applique deja quelques lignes plus
  // haut pour regenerer un code — les memes dates, la meme raison.
  //
  // `cloturerVente` est idempotent : il ne ferme que des lignes COURANTES, donc
  // repasser sur les nuits deja figees au `new` ne les touche pas.
  const datesOntBouge = event.type === 'modified' &&
    !!(event.changes?.arrival || event.changes?.departure)
  const estAnnulation = event.type === 'cancelled'
  if (event.type !== 'new' && !datesOntBouge && !estAnnulation) return
  // Une annulation n'a evidemment pas de statut actif : on ne l'exige que pour
  // les chemins qui FERMENT des nuits.
  if (!estAnnulation && (!snapshot || !isActiveStatus(snapshot, event.provider))) return

  const bien = ctx.propsByKey[cle(event.user_id, event.property_id)]
  if (!bien?.id) {
    // On le DIT plutot que de sortir en silence : un journal qui ne se ferme
    // jamais ressemble trait pour trait a un journal sans vente.
    console.warn(`[dispatch] journal des prix : bien introuvable pour ${event.property_id}`)
    return
  }

  // ─── Annulation : on ne ressuscite pas la vente, on rouvre la nuit ────────
  // Decision de Thierry : la ligne vendue dit la verite (cette nuit A ETE
  // vendue a ce prix), on n'y touche pas. On ouvre une NOUVELLE ligne courante
  // au dernier prix connu du calendrier — ce que l'OTA re-affiche des que la
  // dispo rouvre.
  if (estAnnulation) {
    // `calendar_inventory` est clee sur l'UUID (exception a la regle 10, comme
    // ce journal) : on ne passe PAS `event.property_id`, qui est la cle
    // provider.
    const bilan = await rouvrirApresAnnulation(supabase, {
      propertyId:   bien.id,
      bookingUid:   event.booking_id,
      basePriceEur: bien.base_price
    })
    if (bilan.rouvertes || bilan.sans_prix) {
      console.log(`[dispatch] journal des prix, annulation : ${JSON.stringify(bilan)}`)
    }
    return
  }

  const bilan = await cloturerVente(supabase, {
    propertyId: bien.id,
    arrival:    snapshot.arrival,
    departure:  snapshot.departure,
    bookingUid: event.booking_id
  })
  // Zero ligne fermee n'est PAS une anomalie : le journal n'est pas retroactif,
  // et une nuit vendue sans prix pousse depuis sa creation n'a rien a fermer.
  // On ne trace que ce qui a bouge.
  if (bilan.fermees) {
    console.log(`[dispatch] journal des prix : ${bilan.fermees}/${bilan.nuits} nuit(s) figee(s)`)
  }
}

// ─── Boucle principale ───────────────────────────────────────────────────────
async function dispatchBookingChanges(results) {
  const out = { traites: 0, menageEvents: 0, echecs: 0 }

  const { data: events, error } = await supabase
    .from('booking_change_events')
    .select('*')
    .is('processed_at', null)
    .order('created_at', { ascending: true })
    .limit(LOT_MAX)

  if (error) {
    // Table absente (migration non appliquee) : no-op silencieux, le cron continue.
    console.error('[dispatch] lecture booking_change_events echec', error.message)
    return out
  }
  if (!events?.length) return out

  // Contexte commun : prestataires, noms de biens, cles Beds24 (une seule lecture).
  const userIds     = [...new Set(events.map(e => e.user_id))]
  const propertyIds = [...new Set(events.map(e => String(e.property_id)))]
  const { tokens, propsByKey, knowledgeByKey } = await loadContext(userIds, propertyIds)

  const { data: keys, error: keysErr } = await supabase
    .from('api_keys').select('user_id, api_key').in('user_id', userIds).not('api_key', 'is', null)
  if (keysErr) {
    // Sans les cles, tout evenement Beds24 partirait vers un envoi voue a
    // l'echec — en ayant deja paye l'appel Haiku et ecrit message_sent_log, qui
    // interdit definitivement le renvoi. On preserve le lot pour le cycle suivant.
    console.error('[dispatch] lecture api_keys echec, lot reporte', keysErr.message)
    try { await reportIncident('booking_change_dispatch', { threshold: 1, detail: `lecture api_keys echec : ${keysErr.message}` }) } catch (e) {}
    return out
  }
  const beds24KeyByUser = {}
  ;(keys || []).forEach(k => { beds24KeyByUser[k.user_id] = k.api_key })

  // Snapshots des bookings concernes (etat courant, deja ecrit par le writer).
  // Indexes par user_id|booking_id : la cle primaire de bookings_snapshot est
  // (user_id, booking_id), deux hotes peuvent donc porter le meme booking_id.
  // Une map indexee sur le seul booking_id enverrait le voyageur d'un hote dans
  // le message et le code d'acces d'un autre.
  const { data: snapRows, error: snapErr } = await supabase
    .from('bookings_snapshot')
    .select('user_id, booking_id, snapshot')
    .in('user_id', userIds)
    .in('booking_id', [...new Set(events.map(e => String(e.booking_id)))])
  if (snapErr) {
    // Sans les snapshots, les consommateurs travailleraient sur des donnees
    // vides (voyageur « Voyageur », dates nulles) et les evenements seraient
    // pourtant marques traites. On reporte le lot au cycle suivant.
    console.error('[dispatch] lecture bookings_snapshot echec, lot reporte', snapErr.message)
    try { await reportIncident('booking_change_dispatch', { threshold: 1, detail: `lecture bookings_snapshot echec : ${snapErr.message}` }) } catch (e) {}
    return out
  }
  const snapByBooking = {}
  ;(snapRows || []).forEach(r => { snapByBooking[cle(r.user_id, r.booking_id)] = r.snapshot || {} })

  const ctx = { tokens, propsByKey, knowledgeByKey, beds24KeyByUser, results }

  const debut = Date.now()
  for (const event of events) {
    // Arret propre avant le plafond Vercel : etre tue entre les consommateurs et
    // le marquage processed_at rejouerait l'evenement a chaque cycle.
    if (Date.now() - debut > BUDGET_MS) {
      console.log(`[dispatch] budget atteint, ${out.traites} evenements traites, reliquat au prochain cycle`)
      break
    }
    const snapshot = snapByBooking[cle(event.user_id, event.booking_id)] || null
    const booking  = bookingDepuisSnapshot(event, snapshot)
    const erreurs  = []

    // 1. Menages
    try {
      const r = await syncMenageEvent(event, {
        snapshot,
        propertyName: (propsByKey[cle(event.user_id, event.property_id)] || {}).name || null,
        tokens
      })
      out.menageEvents += r.written || 0
    } catch (e) {
      // Compte partiel : certains prestataires ont pu etre notifies avant l'echec.
      out.menageEvents += e.written || 0
      erreurs.push({ consommateur: 'menages', erreur: e.message })
    }

    // 2. Codes d'acces
    try { await consommateurCodesAcces(event, booking) }
    catch (e) { erreurs.push({ consommateur: 'codes_acces', erreur: e.message }) }

    // 3. Templates
    try { await consommateurTemplates(event, booking, ctx, snapshot) }
    catch (e) { erreurs.push({ consommateur: 'templates', erreur: e.message }) }

    // 4. Journal des prix affiches (YieldFlow etape 1)
    // En dernier, et c'est deliberé : ce consommateur ne touche NI le voyageur
    // NI le prestataire. Son echec ne doit jamais retarder un message de
    // bienvenue ou un code d'arrivee — il est trace dans processing_errors
    // comme les autres, et la ligne de journal se rattrape a la main.
    try { await consommateurJournalPrix(event, ctx, snapshot) }
    catch (e) { erreurs.push({ consommateur: 'journal_prix', erreur: e.message }) }

    // Marquage INCONDITIONNEL (garde anti-boucle).
    const { error: markErr } = await supabase
      .from('booking_change_events')
      .update({
        processed_at:     new Date().toISOString(),
        processing_errors: erreurs.length ? erreurs : null
      })
      .eq('id', event.id)
    if (markErr) {
      // Le marquage EST la garde anti-boucle : s'il echoue, l'evenement revient
      // au prochain cycle et les effets sont rejoues. Ne jamais laisser passer
      // en silence.
      console.error('[dispatch] marquage echec', event.id, markErr.message)
      try {
        await reportIncident('booking_change_dispatch', {
          userId: event.user_id, propertyId: event.property_id, threshold: 1,
          detail: `marquage processed_at echec (evenement ${event.id}) : ${markErr.message} — RISQUE DE REJEU`
        })
      } catch (e) {}
    }

    if (erreurs.length) {
      out.echecs++
      try {
        // userId/propertyId renseignes : sans eux, founder-notify regroupe tous
        // les hotes dans un seul seau anti-spam — le premier incident d'un hote
        // masquerait pendant une heure ceux de tous les autres.
        await reportIncident('booking_change_dispatch', {
          userId:     event.user_id,
          propertyId: event.property_id,
          threshold:  3,
          detail: `booking ${event.booking_id} (${event.type}) : ` +
                  erreurs.map(e => `${e.consommateur}=${e.erreur}`).join(' | ')
        })
      } catch (e) { /* l'alerting ne doit jamais bloquer le cycle */ }
    }
    out.traites++
  }

  console.log(`[dispatch] evenements=${out.traites} menage_events=${out.menageEvents} echecs=${out.echecs}`)
  if (results) {
    results.totalBookingEvents = (results.totalBookingEvents || 0) + out.menageEvents
    results.totalBookingChanges = (results.totalBookingChanges || 0) + out.traites
  }
  return out
}

module.exports = { dispatchBookingChanges, bookingDepuisSnapshot, consommateurCodesAcces, propertyDepuisContexte }
