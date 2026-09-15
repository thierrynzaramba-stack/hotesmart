// lib/channels/channex.js
// Moteur Channex. Même contrat que beds24.js.
// Marque blanche absolue : variables CHANNEL_* (jamais CHANNEX_*),
// aucune mention "channex" exposée côté utilisateur.
// credentials : non utilisé (clé API globale via env), gardé pour le contrat.
// ctx.propertyId = properties.provider_property_id (uuid Channex)

const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const { recordMessage } = require('../record-message')
const BASE = process.env.CHANNEL_BASE_URL          // ex: https://staging.channex.io/api/v1
const KEY  = process.env.CHANNEL_API_KEY

// ⚠ LE POST N'EST JAMAIS REESSAYE, ET C'EST DELIBERE.
// `fetch` rejette aussi APRES que le serveur a traite la requete : une socket
// coupee pendant la lecture de la reponse est indiscernable d'une requete jamais
// partie. Rejouer un POST /bookings creerait alors une SECONDE reservation sur les
// memes nuits — deux resas, dispo fermee deux fois, deux revisions dans le feed —
// et Channex n'oppose aucune defense a la surreservation (mesure du protocole).
// Un echec visible vaut mieux qu'un doublon silencieux : l'appelant decidera.
// GET et PUT sont idempotents, eux : les rejouer est sans consequence.
const METHODES_REJOUABLES = new Set(['GET', 'PUT', 'HEAD', 'DELETE'])

// Base du backoff, injectable pour que les tests n'attendent pas reellement.
const BACKOFF_MS = Number(process.env.CHANNEL_BACKOFF_MS ?? 1000)

// Vraies pannes reseau : le code vient de `e.cause` (undici). Une URL invalide ou
// un corps non serialisable ne sont PAS des pannes reseau — les rejouer ferait
// d'une variable d'environnement manquante un timeout de fonction Vercel de 15 s
// au lieu d'un echec immediat, en accusant le reseau dans les logs.
const CODES_RESEAU = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
  'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'
])
const estPanneReseau = e => CODES_RESEAU.has(e?.cause?.code) || CODES_RESEAU.has(e?.code)

async function channelCall(method, path, body, _attempt = 0) {
  // Serialise AVANT le try : un corps non serialisable est une faute de
  // programmation, pas un incident reseau, et doit echouer tout de suite.
  const corps = body ? JSON.stringify(body) : undefined
  const rejouable = METHODES_REJOUABLES.has(String(method).toUpperCase())

  let r
  try {
    r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'user-api-key': KEY, 'Content-Type': 'application/json' },
      body: corps
    })
    // La LECTURE DU CORPS est dans le try : une coupure a cet instant leve aussi,
    // et laisser cette ligne dehors rendait l'exception nue que ce bloc pretend
    // supprimer — l'appelant teste `ok`, il ne doit jamais avoir a attraper.
    var text = await r.text()
  } catch (e) {
    if (estPanneReseau(e) && rejouable && _attempt < 4) {
      await new Promise(res => setTimeout(res, Math.min(BACKOFF_MS * Math.pow(2, _attempt), 8 * BACKOFF_MS)))
      return channelCall(method, path, body, _attempt + 1)
    }
    const cause = e?.cause?.code || e?.code || 'inconnue'
    console.error(`[channel] ${method} ${path} echec (${cause}) apres ${_attempt + 1} essai(s) :`, e.message)
    return {
      ok: false, status: 0,
      json: { errors: { code: estPanneReseau(e) ? 'network_error' : 'call_error', title: e.message, cause } }
    }
  }

  if ((r.status === 429 || r.status >= 500) && rejouable && _attempt < 4) {
    const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10)
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(BACKOFF_MS * Math.pow(2, _attempt), 8 * BACKOFF_MS)
    await new Promise(res => setTimeout(res, waitMs))
    return channelCall(method, path, body, _attempt + 1)
  }
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: r.ok, status: r.status, json }
}
// Récupère les réservations d'un bien (représentation "dernière révision connue").
// NB : le flux entrant temps réel passe par le webhook + feed (api/channel-webhook.js
// et lib/cron-channel-feed.js). Cette fonction sert aux relectures ponctuelles.
//
// ⚠ PAGINE. L'API plafonne par defaut a DIX reservations par page et annonce le
// reste dans `meta.total` — mesure sur Colomiers : 10 rendues sur 18 existantes.
// Sans pagination, `api/channel-events.js` (import initial a l'activation d'un
// bien) n'ecrivait donc que les dix dernieres reservations dans le coeur, en
// silence : un hote activant un bien a cinquante reservations n'en aurait vu que
// dix, et les quarante autres n'auraient exist  qu'au passage d'une revision.
// Meme famille que la troncature de fetchBookingsHistory cote Beds24.
const PAGE_LIMITE = 100
const PAGE_MAX = 50          // 5 000 reservations : borne de securite, jamais atteinte

async function getReservations(ctx) {
  const { propertyId } = ctx
  const out = []
  for (let page = 1; page <= PAGE_MAX; page++) {
    const r = await channelCall('GET',
      `/bookings?filter[property_id]=${propertyId}&pagination[page]=${page}&pagination[limit]=${PAGE_LIMITE}`)
    if (!r.ok) {
      console.error('[channel] getReservations echec', r.status, r.json)
      return out                     // ce qui est deja lu n'est pas perdu
    }
    const lot = Array.isArray(r.json?.data) ? r.json.data : []
    out.push(...lot.map(b => ({ id: b.id, ...b.attributes })))

    // ⚠ `meta.total` est teste EN PREMIER, et c'est deliberé. Si Channex plafonne
    // ou ignore `pagination[limit]` — son defaut est 10 —, la page 1 rend moins de
    // PAGE_LIMITE lignes et une sortie sur ce seul critere retournerait un
    // resultat tronque, exactement le defaut qu'on corrige ici. On ne s'arrete sur
    // une page courte qu'apres avoir constate qu'on a bien tout, et on CRIE sinon.
    const total = r.json?.meta?.total
    // Tout est la : on s'arrete.
    if (typeof total === 'number' && out.length >= total) return out
    // Page vide : plus rien a lire, et c'est la SEULE sortie sure quand `total`
    // manque. Sans elle, une API qui ignore `pagination[page]` ferait empiler
    // 50 fois la meme page.
    if (!lot.length) return out
    // Page courte MAIS `total` annonce davantage : c'est le cas ou Channex plafonne
    // ou ignore `pagination[limit]` (son defaut est 10). On CONTINUE — s'arreter
    // ici rendrait 10 reservations sur 18, la troncature meme qu'on corrige.
    if (lot.length < PAGE_LIMITE && typeof total !== 'number') return out
  }
  console.warn(`[channel] getReservations ${propertyId} : plafond de ${PAGE_MAX} pages atteint`)
  return out
}

// Envoi d'un message au voyageur, au niveau du booking.
// bookingId = bookings_snapshot.booking_id (id booking Channex).
// Prérequis : app "messages" installée sur la propriété (fait au provisioning).
// Erreurs notables : 403 = app messages absente, 422 = OTA sans support messages.
async function sendMessage(ctx, { bookingId, message }) {
  const r = await channelCall('POST', `/bookings/${bookingId}/messages`, {
    message: { message }
  })
  if (!r.ok) {
    const code = r.json?.errors?.code || ('HTTP ' + r.status)
    console.error('[channel] sendMessage echec', bookingId, code)
  }
  return { success: r.ok, status: r.status, data: r.json }
}

// Lecture des messages d'un booking (sender: 'guest' | 'property').
async function getMessages(ctx, bookingId) {
  const r = await channelCall('GET', `/bookings/${bookingId}/messages`)
  if (!r.ok) {
    console.error('[channel] getMessages echec', bookingId, r.status)
    return []
  }
  return Array.isArray(r.json?.data) ? r.json.data.map(m => ({ id: m.id, ...m.attributes })) : []
}

// Push ARI : dispo (0/1 pour whole), tarifs.
// ari = [{ room_type_id, date_from, date_to, availability?, rate? }]
async function updateAvailability(ctx, ari) {
  const { propertyId } = ctx
  const values = (Array.isArray(ari) ? ari : [ari]).map(v => ({
    property_id: propertyId,
    ...v
  }))
  const r = await channelCall('POST', '/availability', { values })
  if (!r.ok) console.error('[channel] updateAvailability echec', r.status, r.json)
  return { success: r.ok, data: r.json }
}

// Clé API statique : pas de refresh OAuth.
async function refreshToken(ctx) {
  return { success: true }
}

// Grain propriete pour Channex : les messages arrivent par webhook push
// (handleMessage les ecrit dans conversations). On lit donc la base, pas l API.
// ⚠ CETTE FONCTION LISAIT `conversations` ET ETIQUETAIT TOUT EN 'guest'.
// C'etait le vrai defaut « repondre deux fois au voyageur », mesure le
// 14 septembre 2026. `conversations` ne porte que les messages du VOYAGEUR en
// attente de reponse : l'agent IA ne voyait donc JAMAIS ce que l'hote avait
// ecrit lui-meme depuis l'app Airbnb. Pire, le `sender: 'guest'` etait en dur,
// si bien que la garde de l'appelant — « si le dernier message du fil vient de
// l'hote, il n'y a rien a traiter » — ne pouvait PAS se declencher pour un bien
// Channex. Elle existait, elle etait juste, et elle etait morte.
//
// On lit desormais le COEUR (`messages`), qui porte les deux sens depuis que
// l'import rapatrie les reponses de l'hote. C'est la regle du depot : provider
// -> coeur -> app, jamais l'app qui devine.
//
// ⚠ LE COMPTE EST OBLIGATOIRE. `property_id` est la cle PROVIDER, qui n'a
// aucune unicite globale : sans `user_id`, le fil d'un hote pourrait etre servi
// a l'agent d'un autre. L'ancienne version ne le filtrait pas — elle lisait
// `conversations` de la meme facon. Corrige au passage.
//
// ⚠ ET UNE FENETRE, parce qu'on ne relit plus « ce qui attend une reponse »
// mais TOUT le fil : un bien actif porte des milliers de messages, et le
// cap PostgREST a 1000 lignes tronquerait EN SILENCE.
//
// ⚠ ON LIT LES PLUS RECENTS, PAS LES PLUS ANCIENS. La version precedente
// ordonnait en ASCENDANT avec la meme limite : elle rendait donc les 500 plus
// VIEUX messages de la fenetre, et laissait tomber les plus recents — la
// troncature silencieuse qu'elle disait empecher, a l'autre bout. L'appelant
// calcule `lastGuestTime` la-dessus : avec un fil ampute de sa fin, la garde
// `derniere reponse >= dernier message du voyageur` se satisfait a tort et
// l'agent SE TAIT sur un fil qui attend. Muet, donc invisible.
// On trie desormais en DESCENDANT — la limite mord sur le vieux, qui ne sert
// a rien ici — puis on rend l'ordre chronologique attendu par l'appelant.
const JOURS_DE_FIL = 30
const MESSAGES_MAX = 500

async function getPropertyMessages(ctx) {
  const propId = ctx.providerPropertyId || ctx.propertyId
  const userId = ctx.userId
  if (!userId) {
    console.error('[channel] getPropertyMessages sans userId — refus (cloisonnement par compte)')
    return []
  }
  const depuis = new Date(Date.now() - JOURS_DE_FIL * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('messages')
    .select('booking_id, direction, sender, body, sent_at')
    .eq('user_id', userId)
    .eq('property_id', String(propId))
    .gte('sent_at', depuis)
    .order('sent_at', { ascending: false })
    .limit(MESSAGES_MAX)
  if (error) { console.error('[channel] getPropertyMessages echec', error.message); return [] }
  // Remis en ordre chronologique : le tri descendant ne sert qu'a choisir QUELS
  // messages la limite garde, jamais dans quel ordre l'appelant les recoit.
  return (data || []).slice().reverse().map(m => ({
    bookingId: m.booking_id || null,
    // ⚠ LE SENS FAIT FOI, PAS LE LIBELLE D'EXPEDITEUR. `sender` vaut
    // 'guest' | 'host' | 'ai' | 'auto' | 'system' : pour l'appelant, la seule
    // question est « est-ce le voyageur ou nous ». Un message 'auto' parti de
    // nos modeles est, pour lui, un message de l'hote — et c'est exactement ce
    // qui doit l'empecher de repondre une seconde fois.
    sender: m.direction === 'inbound' ? 'guest' : 'host',
    message: m.body || '',
    time: m.sent_at || null
  }))
}

// ⚠ UN INSTANT SANS FUSEAU EST AMBIGU. Channex rend `inserted_at` sous la forme
// « 2026-07-22T15:50:10.405 », sans Z ni décalage. Tout consommateur qui fait
// `new Date()` dessus le lit en heure LOCALE : a Paris, deux heures d'ecart avec
// la meme valeur relue depuis Postgres (« …+00:00 »). Mesure du 14 septembre
// 2026 : 83 messages de Colomiers dupliques par l'import pour cette seule raison.
// On rend le fuseau explicite au point d'entree, une fois, plutot que dans
// chaque lecteur.
// ⚠ LE MOTIF TOLERE LES MINUTES ABSENTES — CORRECTIF DE REVIEW.
// Ma premiere version exigeait `[+-]\d{2}:?\d{2}`, donc elle ne reconnaissait pas
// « …+02 » (decalage aux heures seules), qui est legal en ISO 8601 et accepte
// par Postgres. Elle y collait un Z : « …+02Z » — une valeur VALIDE transformee
// en valeur invalide, que Postgres refuse, donc un message PERDU. Un
// normalisateur pose a une frontiere provider est precisement l'endroit ou l'on
// ne parie pas sur la forme du lendemain.
//
// ⚠ ET IL REND `null` TEL QUEL. `String(null)` donne « null », a quoi on
// aurait ajoute un Z. Le seul site d'appel garde deja contre le nul, mais une
// fonction exportee ne se repose pas sur la prudence de ses appelants.
function enUTC (v) {
  if (v == null) return null
  const s = String(v)
  // ⚠ UNE DATE SEULE N'EST PAS UN DECALAGE. « 2026-07-22 » se termine par
  // « -22 », que le motif de decalage reconnait a tort. Sans consequence — une
  // date seule est lue en UTC par ECMA-262 — mais une regle qui se trompe par
  // chance ne tient pas au prochain format. On la traite donc a part.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // Decalage deja present : Z, ±HH:MM, ±HHMM, ou ±HH (legal en ISO 8601, et
  // accepte par Postgres — le mutiler en « …+02Z » ferait REFUSER la ligne).
  return /(Z|[+-]\d{2}(:?\d{2})?)$/.test(s) ? s : s + 'Z'
}

// Normalise le provider d'un message_thread Channex vers notre vocabulaire ota.
function normOta(provider) {
  switch (provider) {
    case 'BookingCom': return 'booking'
    case 'Airbnb':     return 'airbnb'
    case 'Expedia':    return 'expedia'
    default:           return provider ? String(provider).toLowerCase() : null
  }
}

// Import de l'historique des messages d'un bien (equivalent "Pull" pour les messages).
// Flux : GET /message_threads?filter[property_id] (pagine) -> pour chaque thread,
// GET /message_threads/:id/messages (pagine) -> recordMessage (idempotent via
// provider_msg_id = id du message Channex). Re-executable sans doublon.
// Prerequis : app messages installee (sinon 403 -> error 'messages_app_absent').
// ctx.userId = proprietaire HoteSmart (requis) ; ctx.propertyId = provider_property_id.
// ctx.debug=true -> capture les reponses brutes du 1er thread-list et du 1er
// thread-messages (validation filtre property_id + egalite thread.booking.id).
async function importMessages(ctx) {
  const propId = ctx.propertyId || ctx.providerPropertyId
  const userId = ctx.userId
  if (!userId || !propId) {
    console.error('[channel] importMessages params manquants', { userId, propId })
    return { imported: 0, skipped: 0, error: 'missing_params' }
  }

  const debug = ctx.debug ? { threads_raw: null, first_thread_messages_raw: null } : null
  const LIMIT = 100
  let imported = 0
  let skipped = 0
  let threadPage = 1

  // ⚠ IMPORT INCREMENTAL : `depuis` ecarte les fils qui n'ont pas bouge.
  // Un import complet des quatre biens coute 49 appels et 3,9 s — inacceptable
  // toutes les cinq minutes sur un cycle deja a 40-56 s pour un plafond de 60.
  // Les fils Channex portent un `updated_at` : lister coute UN appel par bien,
  // et on ne va chercher les messages que des fils qui ont bouge. En regime
  // courant c'est zero a deux fils, soit ~300 ms pour tout le parc.
  const depuis = ctx.depuis ? new Date(enUTC(ctx.depuis)).getTime() : null
  // ⚠ BUDGET MUR : une echeance absolue, pas un compteur d'appels. Le cycle a
  // un plafond dur de 60 s et l'import passe APRES les codes d'acces : s'il
  // deborde, ce sont les etapes SUIVANTES qui sautent. Il s'arrete de lui-meme.
  const echeance = ctx.echeance || null
  const depasse = () => echeance != null && Date.now() > echeance
  let filsVus = 0
  let filsLus = 0
  let filsIgnores = 0
  let interrompu = null
  let plusRecent = null
  let annonceFaite = false

  while (true) {
    const tr = await channelCall('GET', `/message_threads?filter[property_id]=${propId}&pagination[page]=${threadPage}&pagination[limit]=${LIMIT}`)
    if (debug && threadPage === 1) debug.threads_raw = tr.json
    if (!tr.ok) {
      const code = tr.json?.errors?.code || ('HTTP ' + tr.status)
      if (tr.status === 403) return { imported, skipped, error: 'messages_app_absent', _debug: debug }
      console.error('[channel] importMessages threads echec', tr.status, code)
      return { imported, skipped, error: code, _debug: debug }
    }
    const threads = Array.isArray(tr.json?.data) ? tr.json.data : []
    if (threads.length === 0) break

    for (const th of threads) {
      const attr = th.attributes || {}
      const bookingId = th.relationships?.booking?.data?.id || null
      const ota = normOta(attr.provider)
      filsVus++

      const bouge = attr.updated_at ? new Date(enUTC(attr.updated_at)).getTime() : null

      // ⚠ LE BUDGET SE CONSULTE AVANT LE `continue`, PAS APRES — BLOQUANT 2.
      // Il etait teste apres le saut des fils inchanges : une page entiere de
      // fils ignores ne le consultait donc JAMAIS, et `if (interrompu) break`
      // ne pouvait pas etre vrai. Mesure de la review : 40 pages de fils, 41
      // appels, aucune interruption — soit ~3,3 s pour un seul bien, x4 biens,
      // bien au-dela du budget du parc, sans abstention ni incident.
      if (depasse()) { interrompu = 'budget'; break }

      if (depuis != null && bouge != null && bouge <= depuis) {
        filsIgnores++
        // ⚠ UN FIL IGNORE EST UN FIL VU EN ENTIER : son instant peut faire
        // avancer le marqueur. C'est meme indispensable, sinon le marqueur
        // resterait bloque au premier fil inchange et l'import relirait
        // indefiniment la meme fenetre.
        if (bouge != null && (plusRecent == null || bouge > plusRecent)) plusRecent = bouge
        continue
      }
      filsLus++

      // ⚠ L'ANNONCE TOMBE AVANT LA PREMIERE ECRITURE, JAMAIS APRES.
      // Regle de Thierry, 14 septembre 2026 : une ecriture de masse deliberee
      // s'annonce, sinon sa seule facon de distinguer notre geste d'une boucle
      // d'ecriture est de nous le demander. Ce jour-la, 173 lignes creees en une
      // heure ont declenche l'alerte « croissance anormale » dix minutes apres
      // qu'on lui ait dit que tout allait bien.
      // L'estimation vient de `message_count`, que Channex porte sur le fil :
      // elle est disponible SANS aucun appel supplementaire, et avant d'ecrire.
      if (!annonceFaite && typeof ctx.avantEcriture === 'function') {
        annonceFaite = true
        const estimation = threads
          .filter(t => {
            const b = t.attributes?.updated_at ? new Date(enUTC(t.attributes.updated_at)).getTime() : null
            return depuis == null || b == null || b > depuis
          })
          .reduce((n, t) => n + (Number(t.attributes?.message_count) || 0), 0)
        try { await ctx.avantEcriture({ fils: filsVus, messages: estimation }) }
        catch (e) { console.error('[channel] annonce prealable echouee, import poursuivi :', e.message) }
      }

      // ⚠ ET DANS LA PAGINATION DES MESSAGES — BLOQUANT 1, LE PLUS GRAVE.
      // `depasse()` n'etait consulte qu'ENTRE deux fils : une fois entre dans un
      // fil, la boucle etait sans garde. Mesure de la review : echeance a +30 ms
      // sur un fil de 6000 messages -> 362 ms, 62 appels, et la passe se
      // declarait COMPLETE. Avec le vrai Supabase (~3 aller-retours par message)
      // c'est plusieurs MINUTES. Le cycle est deja a 40-56 s pour un plafond de
      // 60 : ce qui saute, c'est tout ce qui SUIT — file ARI, poll du feed,
      // sondes d'alerting, et le heartbeat `cron_logs`. La panne du 10 septembre
      // par le timeout au lieu de l'exception, avec la surveillance aveugle en
      // prime.
      let filComplet = true
      let msgPage = 1
      while (true) {
        if (depasse()) { interrompu = 'budget'; filComplet = false; break }
        const mr = await channelCall('GET', `/message_threads/${th.id}/messages?pagination[page]=${msgPage}&pagination[limit]=${LIMIT}`)
        if (debug && debug.first_thread_messages_raw === null) debug.first_thread_messages_raw = mr.json
        if (!mr.ok) {
          // 422 = OTA sans support messages, 403 = app absente : on saute ce thread.
          console.error('[channel] importMessages messages echec', th.id, mr.status)
          // ⚠ ET LE FIL EST INCOMPLET — RELEVE EN REVIEW. Un 500 sur la page 2
          // laissait le fil compte comme lu, son instant dans le marqueur, et la
          // passe declaree complete : les 100 messages suivants — dont la reponse
          // de l'hote — n'entraient JAMAIS dans le coeur et n'auraient PLUS
          // JAMAIS ete relus. Seule trace : un `console.error`. C'est exactement
          // la perte definitive que le marqueur est cense empecher.
          filComplet = false
          break
        }
        const msgs = Array.isArray(mr.json?.data) ? mr.json.data : []
        if (msgs.length === 0) break

        for (const m of msgs) {
          const ma = m.attributes || {}
          const isGuest = ma.sender === 'guest'
          const res = await recordMessage({
            userId,
            provider:      'channex',
            propertyId:    propId,
            bookingId,
            direction:     isGuest ? 'inbound' : 'outbound',
            sender:        isGuest ? 'guest' : 'host',
            body:          ma.message || '',
            providerMsgId: m.id || null,
            ota,
            // ⚠ CHANNEX REND UN INSTANT SANS FUSEAU (« 2026-07-22T15:50:10.405 »).
            // Transmis tel quel, il est lu en heure LOCALE par `new Date()` chez
            // tout consommateur — 83 messages de Colomiers ont ete dupliques pour
            // cette seule raison le 14 septembre 2026. On le rend explicite ICI,
            // au point d'entree du provider, pour qu'aucun consommateur n'ait a
            // deviner. La base, elle, l'interpretait deja correctement en UTC :
            // le defaut ne se voyait donc QUE dans les comparaisons en memoire.
            sentAt:        ma.inserted_at ? enUTC(ma.inserted_at) : null,
            kind:          'message'
          })
          if (res && res.skipped) skipped++
          else if (res && res.ok) imported++
        }

        const meta = mr.json?.meta || {}
        const limit = meta.limit || msgs.length
        if (msgs.length < limit) break
        msgPage++
      }

      // Le marqueur ne retient que ce qui a ete vu EN ENTIER.
      if (filComplet && bouge != null && (plusRecent == null || bouge > plusRecent)) {
        plusRecent = bouge
      }
      if (!filComplet && !interrompu) interrompu = 'fil_incomplet'
      if (interrompu) break
    }

    if (interrompu) break

    const meta = tr.json?.meta || {}
    const limit = meta.limit || threads.length
    if (threads.length < limit) break
    threadPage++
  }

  // ⚠ LE MARQUEUR N'AVANCE QUE SI LA PASSE EST ALLEE AU BOUT. Interrompue par
  // le budget, elle a pu sauter des fils qui avaient bouge : avancer quand meme
  // les perdrait DEFINITIVEMENT — on ne les relirait jamais. Une passe tronquee
  // ne coute qu'un cycle de retard ; un marqueur avance a tort coute un fil.
  return {
    imported, skipped, interrompu,
    fils: { vus: filsVus, lus: filsLus, ignores: filsIgnores },
    jusqua: interrompu ? null : (plusRecent != null ? new Date(plusRecent).toISOString() : null),
    _debug: debug
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ÉCRITURE CRS — reservation directe (spec-reservation-manuelle.md §3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Primitive d'ecriture partagee par la saisie manuelle (phase 2) et le futur
// moteur de reservation direct (phase 3). Aucun module metier n'appelle Channex
// en direct : tout passe par ici.
//
// TOUT CE BLOC EST MESURE, pas suppose — protocole CRS du 6 septembre 2026 sur le
// staging « test 2 ». Les six comportements verifies :
//   1. creation      -> la dispo se ferme sur les nuits occupees (bornes libres)
//   2. modification  -> anciennes nuits rouvertes, nouvelles fermees
//   3. annulation    -> dispo restauree ; la REPONSE ne porte ni dates ni rooms,
//                       mais la revision du feed les porte
//   4. feed          -> new / modified / cancelled, comme une revision OTA normale
//   5. surreservation-> ACCEPTEE (HTTP 200, stock a -1) : aucune defense provider
//   6. meta custom   -> rendu intact dans le feed (cles triees), absent de la reponse

// `ota_name` d'une reservation directe. Mesure : « Offline » est accepte et
// Channex genere un unique_id prefixe `OFL-` (distinct de `BDC-`/`ABB-`), donc il
// la traite comme un canal a part entiere. « Direct », « Website », « Manual »,
// « Booking CRS » et « Channex » sont TOUS refuses en `unknown provider` — d'ou
// la tentation d'emprunter le nom d'un OTA reel, qui polluerait les statistiques
// par canal. Ne pas y revenir.
const OTA_DIRECT = 'Offline'

// ⚠ PAYLOAD TOUJOURS COMPLET, MEME POUR ANNULER.
// Mesure : un PUT d'annulation dont `rooms[].days` est partiel est rejete en 422
// (« departure_date is not equal to maximum date + 1 day in rooms.days »).
// Channex revalide l'integralite du payload a chaque ecriture ; il n'existe pas
// de mise a jour partielle. Cette fonction est donc la seule forme autorisee.
//
// `days` : le prix NUIT PAR NUIT, de l'arrivee au dernier soir. La nuit de depart
// n'en fait pas partie — c'est ce qui laisse la borne libre pour l'arrivee
// suivante (verifie au point 1 : sejour 12->15, seules les nuits 12, 13 et 14
// passent a 0).
// ⚠ LES CHAMPS OBLIGATOIRES SONT REFUSES ICI, PAS AU CRS.
// `JSON.stringify` SUPPRIME les cles `undefined` : un champ oublie disparaissait
// du payload et revenait en 422 opaque — ou pire, passait. Et `String(undefined)`
// envoie la chaine « undefined » dans un champ de montant. Cette fonction est
// l'unique primitive d'ecriture du produit : ce qui manque doit se voir ici.
//
// `currency` est EXIGE, jamais devine : un bien en GBP dont l'appelant oublie la
// devise creerait une reservation au meme montant numerique en EUR, sans signal.
//
// `otaReservationCode` est EXIGE parce qu'il est notre seule cle de
// deduplication cote Channex — sans lui, impossible de savoir si un POST parti
// deux fois a cree deux reservations.
const CHAMPS_REQUIS = ['roomTypeId', 'ratePlanId', 'arrival', 'departure', 'amount', 'currency', 'otaReservationCode']

function montant (valeur, champ) {
  const n = Number(valeur)
  if (!Number.isFinite(n) || n < 0) throw new Error(`[channel] ${champ} invalide : ${JSON.stringify(valeur)}`)
  // Deux decimales : un total flottant donnerait « 0.30000000000000004 ».
  return n.toFixed(2)
}

function payloadCRS (propertyId, resa, statut) {
  if (!propertyId) throw new Error('[channel] payloadCRS : propertyId manquant')
  const r = resa || {}
  const manquants = CHAMPS_REQUIS.filter(c => r[c] === undefined || r[c] === null || r[c] === '')
  if (manquants.length) throw new Error(`[channel] payloadCRS : champ(s) manquant(s) — ${manquants.join(', ')}`)
  if (!r.days || !Object.keys(r.days).length) throw new Error('[channel] payloadCRS : `days` vide (prix nuit par nuit obligatoire)')

  const {
    roomTypeId, ratePlanId, arrival, departure,
    days, amount, currency,
    customer = {}, occupancy = {}, meta, otaReservationCode, arrivalHour
  } = r

  const jours = {}
  for (const [d, v] of Object.entries(days)) jours[d] = montant(v, `days[${d}]`)

  const booking = {
    property_id:          propertyId,
    ota_name:             OTA_DIRECT,
    ota_reservation_code: otaReservationCode,
    arrival_date:         arrival,
    departure_date:       departure,
    currency,
    customer: {
      name:     customer.name || '',
      surname:  customer.surname || '',
      mail:     customer.mail || null,
      phone:    customer.phone || null,
      country:  customer.country || null,
      language: customer.language || 'fr'
    },
    occupancy: {
      adults:   occupancy.adults ?? 1,
      children: occupancy.children ?? 0,
      infants:  occupancy.infants ?? 0
    },
    amount: montant(amount, 'amount'),
    rooms: [{
      room_type_id: roomTypeId,
      rate_plan_id: ratePlanId,
      days: jours,
      occupancy: {
        adults:   occupancy.adults ?? 1,
        children: occupancy.children ?? 0,
        infants:  occupancy.infants ?? 0
      },
      amount: montant(amount, 'amount')
    }]
  }
  // `meta` porte la SOUS-origine (saisie hote vs moteur direct), jamais l'origine :
  // celle-ci est deja dans ota_name. Omis s'il est vide, pour ne pas ecrire `{}`.
  if (meta && Object.keys(meta).length) booking.meta = meta
  if (arrivalHour) booking.arrival_hour = arrivalHour
  if (statut) booking.status = statut
  return { booking }
}

// Forme de retour unique des trois fonctions : { ok, id, status, erreurs, json }.
// ⚠ AUCUNE ERREUR N'EST AVALEE (lecon des reviews du chantier historique) : un
// echec est LOGGE et remonte avec son detail, jamais transforme en succes vide.
// Le cœur n'est PAS ecrit ici : la reservation y entrera par le feed/webhook
// standard. La reponse ne sert qu'a obtenir l'id et a detecter un echec — elle
// n'est pas une source fiable (a l'annulation elle ne porte ni dates ni rooms).
function resultat (op, r) {
  if (!r.ok) {
    const details = r.json?.errors ? JSON.stringify(r.json.errors) : String(r.status)
    console.error(`[channel] ${op} echec ${r.status} : ${details.slice(0, 300)}`)
    return { ok: false, status: r.status, erreurs: r.json?.errors || null, json: r.json }
  }
  return { ok: true, status: r.status, id: r.json?.data?.id || null, json: r.json }
}

// ⚠ POST NON REJOUE (cf. METHODES_REJOUABLES) : une panne reseau rend un echec,
// jamais un doublon. L'appelant qui veut reessayer doit d'abord verifier, via
// `ota_reservation_code`, qu'aucune reservation n'a ete creee entre-temps.
async function createBooking (propertyId, resa) {
  return resultat('createBooking', await channelCall('POST', '/bookings', payloadCRS(propertyId, resa)))
}

async function updateBooking (bookingId, propertyId, resa) {
  return resultat('updateBooking', await channelCall('PUT', `/bookings/${bookingId}`, payloadCRS(propertyId, resa)))
}

// L'annulation est un PUT porteur de `status: cancelled` et du payload COMPLET :
// `DELETE /bookings/:id` et `PUT /bookings/:id/cancel` n'existent pas (404 mesure).
async function cancelBooking (bookingId, propertyId, resa) {
  return resultat('cancelBooking', await channelCall('PUT', `/bookings/${bookingId}`, payloadCRS(propertyId, resa, 'cancelled')))
}

// L'app `booking_crs` doit etre installee sur le bien, sinon POST /bookings rend
// 403 (mesure). A appeler au provisioning d'un bien Channex, comme l'app messages.
async function installerCRS (propertyId) {
  return resultat('installerCRS', await channelCall('POST', '/applications/install', {
    application_installation: { property_id: propertyId, application_code: 'booking_crs' }
  }))
}

// ─── La fiche du bien, brute (etape 1B) ──────────────────────────────────────
// Ce que Channex sait du bien, tel qu'il le sert. On rapatrie la propriete, ses
// room_types et ses rate_plans : les trois portent la commercialisation, et un
// bien sans ses plans tarifaires n'est pas une fiche, c'est un nom.
//
// ⚠ AUCUN ELAGAGE. C'est le principe du rapatriement : ce qu'on ne sait pas
// encore lire aujourd'hui doit rester lisible demain.
async function getPropertyRaw (ctx) {
  const { propertyId } = ctx
  const p = await channelCall('GET', `/properties/${propertyId}`)
  if (!p.ok) {
    console.error('[channel] getPropertyRaw echec', p.status, p.json)
    return null
  }
  const bien = p.json?.data
  if (!bien) return null

  const out = { id: bien.id, type: bien.type, ...(bien.attributes || {}) }

  // ⚠ UNE FICHE PARTIELLE NE DEVIENT JAMAIS LA VERITE DU COEUR.
  // Constat de review : rendre `out` ampute quand un sous-appel echoue faisait
  // ECRASER en base une fiche complete par une fiche sans ses plans tarifaires
  // — brut perdu, `updated_at` qui ment, `raw_hash` qui oscille d'un passage a
  // l'autre. Un rapatriement incomplet doit ressembler a un echec, pas a une
  // fiche. On rend `null` : le writer ne verra rien a ecrire.
  const rt = await listeComplete(`/room_types?filter[property_id]=${propertyId}`)
  if (!rt) { console.error('[channel] getPropertyRaw : room_types indisponibles, fiche abandonnee'); return null }
  out.room_types = rt

  const rp = await listeComplete(`/rate_plans?filter[property_id]=${propertyId}`)
  if (!rp) { console.error('[channel] getPropertyRaw : rate_plans indisponibles, fiche abandonnee'); return null }
  out.rate_plans = rp

  return out
}

// ⚠ CHANNEX PLAFONNE A 10 PAR DEFAUT, ET NE LE DIT PAS.
// C'est ecrit deux fois dans ce fichier (getReservations) et ca a deja coute
// une troncature silencieuse en production. Un bien qui depasse 10 rate_plans
// — un plan de base plus les derives par canal, c'est vite atteint apres une
// migration OTA — verrait ses plans coupes SANS que rien ne bouge : l'empreinte
// resterait stable, le compte de champs plausible, et la fiche fausse pour
// toujours. La troncature stable est pire que la bruyante.
//
// Rend `null` sur echec — jamais une liste partielle qu'on prendrait pour
// complete.
const PAGE_FICHE = 100
const PAGES_MAX_FICHE = 20

async function listeComplete (chemin) {
  const sep = chemin.includes('?') ? '&' : '?'
  const out = []
  for (let page = 1; page <= PAGES_MAX_FICHE; page++) {
    const r = await channelCall('GET', `${chemin}${sep}pagination[page]=${page}&pagination[limit]=${PAGE_FICHE}`)
    if (!r.ok) { console.error('[channel] listeComplete echec', chemin, r.status); return null }
    const lot = Array.isArray(r.json?.data) ? r.json.data : []
    out.push(...lot.map(x => ({ id: x.id, ...(x.attributes || {}) })))

    const total = r.json?.meta?.total
    if (typeof total === 'number' && out.length >= total) return out
    if (!lot.length) return out
    // Page courte sans `total` : rien d'autre a lire de sur.
    if (lot.length < PAGE_FICHE && typeof total !== 'number') return out
  }
  // Plafond atteint : on ne rend PAS une liste qu'on sait peut-etre tronquee.
  console.error('[channel] listeComplete : plafond de pages atteint sur', chemin)
  return null
}

module.exports = {
  // Exporte POUR ETRE EPROUVE. Sans ca, aucun test ne pouvait l'appeler : le
  // seul test qui le visait lisait le fichier et asserait huit espaces
  // d'alignement du site d'appel — il rougissait sur un reformatage et restait
  // vert quand on vidait la fonction. Releve en review le 14 septembre 2026.
  enUTC,
  getReservations, getPropertyMessages, sendMessage, getMessages, updateAvailability,
  getPropertyRaw,
  // Expose pour l'assistant de migration (lib/migration-provisionner.js) : la
  // regle du depot veut que tout code canal passe par lib/channels, donc
  // l'etape ne peut pas reimplementer son propre appel HTTP.
  channelCall,
  refreshToken, importMessages,
  createBooking, updateBooking, cancelBooking, installerCRS, payloadCRS, OTA_DIRECT
}
