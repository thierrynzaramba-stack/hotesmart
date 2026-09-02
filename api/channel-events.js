// api/channel-events.js
// 2e webhook SEPARE — events CANAL + AVIS.
//
// Le webhook booking/message reste dans api/channel-webhook.js : code CERTIFIE
// Channex, NON modifie, et la certification PMS est en revue. C'est la raison
// d'etre de ce fichier, et c'est aussi pourquoi les avis atterrissent ici.
//
// ELARGISSEMENT DU PROPOS ASSUME. Ce fichier ne traite plus seulement le canal :
// il route aussi `updated_review` vers ota_reviews. Le choix a ete pese contre un
// 3e webhook dedie, plus propre semantiquement. Deux raisons l'ont emporte : le
// gestionnaire de canaux peut refuser un webhook de plus (ce fichier prevoit deja
// ce refus pour le 2e), et le poll quotidien de lib/cron-channel-reviews.js
// reste la source de verite — ce webhook n'apporte que la fraicheur.
//
// Events traites : new_channel, updated_channel, activate_channel, updated_review.
//
// But : quand l'hote mappe + active un canal dans l'iframe Channex, automatiser
// le post-mapping SANS action manuelle :
//   resolution du bien -> pull bookings -> import messages -> channel_ready=true.
//
// Securite : meme secret partage que channel-webhook.js (header x-channel-webhook-secret).

const { createClient } = require('@supabase/supabase-js')
const { getProvider } = require('../lib/channels')
// Writer unique de bookings_snapshot (audit E3/E4/E5).
const { saveBookingSnapshots } = require('../lib/bookings-snapshot')
const billing = require('../lib/billing')
// Writer commun avec le poll quotidien : un seul endroit ecrit ota_reviews, et
// un seul connait la contrainte d'idempotence.
const { preparerAvis, upsertAvis } = require('../lib/cron-channel-reviews')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY
const WEBHOOK_SECRET = process.env.CHANNEL_WEBHOOK_SECRET
const VERCEL_BYPASS = process.env.VERCEL_BYPASS_TOKEN

// Domaines sous lesquels cette application est servie. La cible du webhook est
// construite ICI, a partir de cette liste, et JAMAIS fournie par le client.
//
// ⚠ Pourquoi c'est vital : le corps du webhook envoye au gestionnaire contient
// CHANNEL_WEBHOOK_SECRET et le bypass de protection Vercel. Laisser le client
// choisir l'hote, c'est lui laisser faire livrer ces deux secrets chez lui —
// puis, avec le secret partage, forger des events sur le webhook certifie.
// Valider le seul CHEMIN ne suffit pas : "https://evil.example.com/api/
// channel-events" a un chemin parfaitement valide.
const DOMAINES_APP = ['hotesmart.vercel.app']

function urlWebhookDeCeFichier (req) {
  const host = String(req.headers?.host || '').toLowerCase().split(':')[0]
  const domaine = DOMAINES_APP.includes(host) ? host : DOMAINES_APP[0]
  return `https://${domaine}/api/channel-events`
}

// Events canal ecoutes par ce 2e webhook.
// ⚠ Elargir ce masque ne suffit PAS sur un webhook deja enregistre : il faut le
// mettre a jour cote Channex (PUT), ce que fait l'action 'register' ci-dessous.
const CHANNEL_EVENTS = 'new_channel;updated_channel;activate_channel;updated_review'

async function channelCall(method, path, body) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Bien HoteSmart proprietaire d'un provider_property_id (id property Channex).
async function ownerOfProperty(providerPropertyId) {
  const { data } = await supabase
    .from('properties')
    .select('id, user_id, provider, provider_property_id, name')
    .eq('provider_property_id', providerPropertyId)
    .maybeSingle()
  return data || null
}

// Snapshot bookings_snapshot : ecriture via le writer unique lib/bookings-snapshot.js.
// Le mapping Channex (fromChannex) est partage avec le webhook et le feed : plus de
// duplication de schema, plus de divergence possible (audit E3/E4).

// Chaine post-mapping, idempotente, pour un bien deja resolu.
async function runPostMapping(owner) {
  const providerPropertyId = owner.provider_property_id
  const out = { property_id: providerPropertyId, bookings: 0, messages: null, ready: false }
  const provider = getProvider(owner.provider || 'channex')

  // 1) PULL bookings -> upsert bookings_snapshot (onConflict user_id,booking_id -> idempotent).
  let bookings = []
  try {
    bookings = await provider.getReservations({ propertyId: providerPropertyId })
  } catch (e) {
    console.error('[channel-events] getReservations echec', e.message)
  }
  if (bookings.length) {
    // Reserve : confirmer les noms d'attributs bookings au 1er passage reel.
    console.log('[channel-events] 1er booking keys:', Object.keys(bookings[0] || {}))
  }
  // Import initial : ecriture par lot (une seule relecture groupee cote writer).
  // initialImport -> les changements sont materialises DEJA traites. getReservations
  // n'a aucune fenetre de date : sans ce drapeau, activer un bien enverrait un
  // message de bienvenue a chaque reservation a venir prise il y a des mois.
  const saved = await saveBookingSnapshots(supabase, {
    userId:     owner.user_id,
    propertyId: providerPropertyId,
    provider:   'channex',
    bookings,
    initialImport: true
  })
  // Les lignes deja a jour comptent : a la reactivation d'un bien deja importe,
  // tout est identique et `saved` vaut 0 — annoncer « 0 reservation » ferait
  // croire a un import rate.
  out.bookings = saved.saved + (saved.inchanges || 0)
  if (saved.failed) console.error('[channel-events] upsert booking echec x' + saved.failed)

  // 2) IMPORT messages (dedup interne provider_msg_id -> idempotent).
  if (typeof provider.importMessages === 'function') {
    try {
      const r = await provider.importMessages({
        userId: owner.user_id,
        propertyId: providerPropertyId,
        providerPropertyId
      })
      out.messages = r && typeof r === 'object' ? { imported: r.imported, skipped: r.skipped, error: r.error } : r
    } catch (e) {
      console.error('[channel-events] importMessages echec', e.message)
    }
  }

  // 3) Marque le bien pret + horodate l'activation et REARME le rattrapage messages.
  // channel_ready_at = fenetre de rattrapage cron (les threads OTA arrivent en differe).
  // messages_backfilled=false a CHAQUE activation : rejoue l'import pour cette activation
  // (idempotent via provider_msg_id). Non bloquant si les colonnes manquent encore.
  const { error: readyErr } = await supabase
    .from('properties')
    .update({ channel_ready: true, channel_ready_at: new Date().toISOString(), messages_backfilled: false })
    .eq('id', owner.id)
  if (readyErr) console.error('[channel-events] channel_ready update echec', readyErr.message)
  else out.ready = true

  // active_at = 1re activation reussie du bien (base de la facturation). First-write-wins :
  // le filtre .is('active_at', null) garantit qu'on ne reecrit JAMAIS une valeur existante,
  // meme si le bien est reactive plus tard (contrairement a channel_ready_at, reecrit a chaque fois).
  // Non bloquant si la colonne manque encore.
  const { data: activated, error: activeErr } = await supabase
    .from('properties')
    .update({ active_at: new Date().toISOString() })
    .eq('id', owner.id)
    .is('active_at', null)
    .select('id')
  if (activeErr) console.error('[channel-events] active_at update echec', activeErr.message)

  // 1re activation de CE bien -> aligne la facturation du compte (no-op si beta).
  if (activated && activated.length) {
    try { await billing.syncAccountBilling(owner.user_id) }
    catch (e) { console.error('[channel-events] billing sync echec', e.message) }
  }

  return out
}

// ─── Avis voyageur (event `updated_review`) ─────────────────────────────────
// Le payload du webhook n'est pas documente : selon la forme, il porte l'avis
// complet ou seulement son identifiant. On accepte les deux et on relit chez le
// provider quand on n'a qu'un id — la relecture donne de toute facon l'etat le
// plus frais, ce qui est le seul interet de ce webhook face au poll.
function extraireAvisDuPayload(payload) {
  const p = payload || {}
  // Forme JSON:API complete : { data: { id, attributes, relationships } }
  if (p.data?.attributes) return { item: p.data }
  if (p.attributes) return { item: p }
  // Sinon on cherche un identifiant.
  const id = p.review_id || p.id || p.data?.id
  return id ? { id: String(id) } : {}
}

async function traiterAvis(payload, res) {
  const trouve = extraireAvisDuPayload(payload)
  let item = trouve.item

  if (!item) {
    if (!trouve.id) {
      console.error('[channel-events] updated_review sans avis ni identifiant exploitable')
      return res.status(200).json({ ok: true, reason: 'review_sans_id' })
    }
    const r = await channelCall('GET', `/reviews/${trouve.id}`)
    if (!r.ok) {
      // 200 volontaire : un webhook en erreur serait rejoue par le provider, et
      // le poll quotidien rattrapera cet avis de toute facon.
      console.error('[channel-events] relecture de l\'avis echouee', trouve.id, r.status)
      return res.status(200).json({ ok: false, reason: 'review_illisible', channel_status: r.status })
    }
    item = r.json?.data
    if (!item) return res.status(200).json({ ok: true, reason: 'review_vide' })
  }

  // MEME writer que le poll quotidien : meme resolution du bien (donc meme garde
  // de cloisonnement), meme resolution de la reservation, meme contrainte
  // d'idempotence. Rejouer un avis deja recu est sans effet.
  const prep = await preparerAvis(supabase, item)
  if (prep.erreur) {
    console.error('[channel-events] avis non preparable')
    return res.status(200).json({ ok: false, reason: 'review_non_preparable' })
  }
  if (prep.ignore) {
    // bien_inconnu / bien_ambigu : on n'ecrit pas, et ce n'est pas une erreur.
    return res.status(200).json({ ok: true, reason: 'ignored:' + prep.ignore })
  }

  const ecriture = await upsertAvis(supabase, prep.ligne)
  if (ecriture.error) {
    console.error('[channel-events] upsert avis echec', ecriture.error.message)
    return res.status(200).json({ ok: false, reason: 'upsert_echec' })
  }

  console.log('[channel-events] avis ecrit', prep.ligne.external_review_id,
              '| resolu:', prep.resolu === true)
  return res.status(200).json({ ok: true, written: 1, resolved: prep.resolu === true })
}

module.exports = async function handler(req, res) {
  // ===== REGISTER du 2e webhook (appel authentifie user, comme channel-webhook 'register') =====
  if (req.method === 'POST' && req.body?.action === 'register') {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ error: 'Non autorise' })
    const { data: u } = await supabase.auth.getUser(token)
    if (!u?.user) return res.status(401).json({ error: 'Session invalide' })

    // ⚠ GARDE 1 — la cible est construite cote serveur, pas recue.
    // Une premiere version validait le `callback_url` du client par son chemin.
    // Insuffisant : le chemin de "https://evil.example.com/api/channel-events"
    // est valide, et le POST de creation y aurait fait livrer, en clair,
    // CHANNEL_WEBHOOK_SECRET et le bypass Vercel — de quoi ensuite forger des
    // events sur le webhook certifie. On ne valide donc plus une donnee client :
    // on ne l'utilise pas (REVIEW.md regle 11).
    const callbackUrl = urlWebhookDeCeFichier(req)

    // Le front envoie deja cette constante. Un ecart signale un appelant qui se
    // trompe de cible : on le dit plutot que de l'ignorer en silence.
    const demande = req.body.callback_url
    if (demande && String(demande) !== callbackUrl) {
      return res.status(400).json({
        error: 'callback_url non conforme',
        reason: "Cet endpoint n'enregistre que son propre webhook ; la cible est determinee par le serveur.",
        attendu: callbackUrl
      })
    }

    // Le webhook de ce fichier est probablement DEJA enregistre avec un masque
    // plus etroit : un POST creerait un doublon ou serait refuse, et le nouvel
    // event ne serait jamais recu. On cherche donc l'existant pour le mettre a
    // jour (PUT), et on ne cree qu'a defaut.
    let existant = null
    let masqueExistant = ''
    const liste = await channelCall('GET', '/webhooks')
    if (!liste.ok) {
      // On ne cree PAS a l'aveugle : sans la liste, impossible de savoir si le
      // webhook existe deja, et un POST produirait un doublon — donc double
      // livraison de chaque event et double execution de runPostMapping.
      console.error('[channel-events] lecture des webhooks impossible', liste.status, JSON.stringify(liste.json))
      return res.status(200).json({
        ok: false, registered: false, updated: false,
        channel_status: liste.status,
        reason: "Impossible de lire les webhooks existants : on n'en cree pas a l'aveugle (risque de doublon et de double livraison). Reessayer plus tard."
      })
    }
    const tous = liste.json?.data || []
    const trouve = tous.find(w =>
      (w.attributes?.callback_url || w.callback_url) === callbackUrl)
    if (trouve) {
      existant = trouve.id || trouve.attributes?.id
      masqueExistant = String(trouve.attributes?.event_mask || trouve.event_mask || '')
      // Une entree trouvee mais sans identifiant sautait la garde 2 et tombait
      // sur la creation, donc sur un doublon. On s'arrete au lieu de continuer.
      if (!existant) {
        console.error('[channel-events] webhook trouve sans identifiant exploitable')
        return res.status(200).json({
          ok: false, registered: false, updated: false,
          reason: "Un webhook existe deja sur cette URL mais son identifiant est illisible : creation refusee pour ne pas produire de doublon."
        })
      }
    }

    if (existant) {
      // ⚠ GARDE 2, redondante et voulue — ne jamais toucher au webhook certifie.
      // Si une URL changeait un jour et passait la garde 1, ce filet reste : un
      // webhook qui porte booking ou message est celui de channel-webhook.js.
      if (/\bbooking\b|\bmessage\b/i.test(masqueExistant)) {
        console.error('[channel-events] refus de modifier un webhook portant booking/message')
        return res.status(409).json({
          ok: false, registered: false, updated: false,
          reason: "Ce webhook porte les events booking/message : c'est celui du code certifie, il n'est pas modifiable ici."
        })
      }

      // Le PUT renvoie headers et request_params : si le gestionnaire remplace
      // l'objet au lieu de le fusionner, les omettre ferait perdre le secret
      // partage — toutes les livraisons suivantes seraient alors rejetees en
      // 401 par notre propre garde — et le bypass de protection Vercel.
      const maj = await channelCall('PUT', `/webhooks/${existant}`, {
        webhook: {
          callback_url: callbackUrl,
          event_mask: CHANNEL_EVENTS,
          property_id: null,
          is_global: true,
          is_active: true,
          send_data: true,
          headers: { 'X-Channel-Webhook-Secret': WEBHOOK_SECRET },
          request_params: VERCEL_BYPASS ? { 'x-vercel-protection-bypass': VERCEL_BYPASS } : {}
        }
      })
      // Meme reserve que pour la creation : un refus doit etre lisible, pas un
      // crash. Sans cette mise a jour, `updated_review` n'arrive jamais et le
      // poll quotidien reste seul — degrade, pas casse.
      if (!maj.ok) {
        console.error('[channel-events] mise a jour du masque refusee', maj.status, JSON.stringify(maj.json))
        return res.status(200).json({
          ok: false,
          registered: false,
          updated: false,
          channel_status: maj.status,
          reason: "Le gestionnaire de canaux a refuse la mise a jour du masque d'events (ajout de updated_review). Les avis continueront d'arriver par le poll quotidien.",
          detail: maj.json?.errors || maj.json
        })
      }
      return res.status(200).json({
        ok: true, registered: true, updated: true,
        event_mask: CHANNEL_EVENTS, webhook: maj.json?.data || maj.json
      })
    }

    const reg = await channelCall('POST', '/webhooks', {
      webhook: {
        callback_url: callbackUrl,
        event_mask: CHANNEL_EVENTS,
        property_id: null,
        is_global: true,
        is_active: true,
        send_data: true,
        headers: { 'X-Channel-Webhook-Secret': WEBHOOK_SECRET },
        request_params: VERCEL_BYPASS ? { 'x-vercel-protection-bypass': VERCEL_BYPASS } : {}
      }
    })

    // Reserve "plusieurs webhooks autorises ?" : si Channex refuse un 2e webhook,
    // message clair, pas de crash (200 + registered:false).
    if (!reg.ok) {
      console.error('[channel-events] register 2e webhook refuse', reg.status, JSON.stringify(reg.json))
      return res.status(200).json({
        ok: false,
        registered: false,
        channel_status: reg.status,
        reason: "Le gestionnaire de canaux a refuse l'enregistrement du 2e webhook (events canal). Verifier s'il autorise plusieurs webhooks par compte.",
        detail: reg.json?.errors || reg.json
      })
    }
    return res.status(201).json({ ok: true, registered: true, event_mask: CHANNEL_EVENTS, webhook: reg.json?.data || reg.json })
  }

  // ===== RECEPTION d'un event canal =====
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode non autorisee' })
  }

  // Secret partage (meme mecanisme que channel-webhook.js).
  const got = req.headers['x-channel-webhook-secret']
  if (!WEBHOOK_SECRET || got !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'secret invalide' })
  }

  const { event, payload } = req.body || {}
  if (!event) return res.status(400).json({ error: 'event manquant' })

  // Log complet au 1er passage (reserves : property_id / channel_id presents ? forme du payload ?).
  console.log('[channel-events] event recu:', event, '| payload keys:', Object.keys(payload || {}))
  console.log('[channel-events] payload complet:', JSON.stringify(payload || {}))

  try {
    // ===== AVIS VOYAGEUR =====
    // Traite AVANT la garde des events canal : ce n'est pas un event de mapping,
    // il ne doit pas passer par la chaine de resolution de canal.
    //
    // ⚠ try/catch PROPRE, qui ne rejoint pas le catch global du handler. Celui-ci
    // repond 500, donc "retente" cote provider : une coupure reseau vers le
    // gestionnaire ou une exception Supabase aurait suffi a lancer une boucle de
    // rejeu, et a reveiller le canal fondateur (reportIncident webhook_error)
    // pour un incident qui n'en est pas un. Le poll quotidien rattrape.
    if (event === 'updated_review') {
      try {
        return await traiterAvis(payload, res)
      } catch (e) {
        console.error('[channel-events] exception sur updated_review:', e.message)
        return res.status(200).json({ ok: false, reason: 'review_exception' })
      }
    }

    // Seuls les events de mapping/activation declenchent la chaine (idempotents entre eux).
    if (event !== 'new_channel' && event !== 'updated_channel' && event !== 'activate_channel') {
      return res.status(200).json({ ok: true, reason: 'ignored:' + event })
    }

    // Resolution du/des provider_property_id du canal.
    // Le payload activate_channel ne porte PAS de property_id (seulement
    // {title, channel_id, ota_name}) -> fallback : lire l'objet canal.
    // Structure reelle (test 7) : data.attributes.properties = [UUID...] et
    // data.relationships.properties.data[].id = memes UUID = nos provider_property_id.
    let providerPropertyIds = []
    if (payload?.property_id) {
      providerPropertyIds = [payload.property_id]
    } else if (payload?.channel_id) {
      const ch = await channelCall('GET', `/channels/${payload.channel_id}`)
      if (!ch.ok) console.error('[channel-events] GET /channels echec', ch.status, JSON.stringify(ch.json))
      const d = ch.json?.data || {}
      const fromAttrs = Array.isArray(d.attributes?.properties) ? d.attributes.properties : []
      const fromRel = Array.isArray(d.relationships?.properties?.data)
        ? d.relationships.properties.data.map(x => x && x.id) : []
      providerPropertyIds = [...new Set([...fromAttrs, ...fromRel])].filter(Boolean)
    }

    if (!providerPropertyIds.length) {
      console.warn('[channel-events] property_id introuvable (payload + canal), event', event, 'channel_id', payload?.channel_id)
      return res.status(200).json({ ok: true, reason: 'no_property_id' })
    }

    // Un canal peut porter plusieurs proprietes : on traite chacune (idempotent).
    const results = []
    for (const ppid of providerPropertyIds) {
      const owner = await ownerOfProperty(ppid)
      if (!owner) {
        console.warn('[channel-events] bien inconnu', ppid)
        results.push({ property_id: ppid, reason: 'unknown_property' })
        continue
      }
      const r = await runPostMapping(owner)
      console.log('[channel-events]', event, 'traite', JSON.stringify(r))
      results.push(r)
    }
    return res.status(200).json({ ok: true, event, results })
  } catch (err) {
    console.error('[channel-events]', err.message)
    try { await require('../lib/founder-notify').reportIncident('webhook_error', { threshold: 3, detail: `channel-events: ${err.message}` }) } catch (e) {}
    return res.status(500).json({ ok: false })   // 5xx -> Channex retente
  }
}
