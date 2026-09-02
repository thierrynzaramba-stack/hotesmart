// lib/cron-channel-reviews.js
// Poll des avis voyageurs Channex -> table `ota_reviews` (coeur de donnees).
//
// Cadence quotidienne (marqueur dans cron_logs) : un avis n'arrive qu'une fois
// par sejour, et la fenetre de reponse OTA se compte en semaines. Le webhook
// `updated_review` viendra plus tard pour la fraicheur ; ce poll reste la
// source de verite et le filet.
//
// White-label : variables CHANNEL_* (jamais CHANNEX_*).
//
// ⚠ CLOISONNEMENT (REVIEW.md regle 1). Contrairement a Beds24, Channex n'a PAS
// une cle par hote : HoteSmart tourne sous UNE cle plateforme, et `GET /reviews`
// renvoie donc les avis de TOUS les comptes melanges. Le rattachement au bon
// `user_id` passe entierement par `properties.provider_property_id`, exactement
// comme le fait deja lib/cron-channel-feed.js pour les reservations. C'est la
// seule defense : le poll tourne en service key, la RLS ne le protege pas.

const { supabase } = require('./cron-shared')

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

const MARQUEUR      = 'channel_reviews_poll'
const PERIODE_MS    = 24 * 60 * 60 * 1000
const PAGE_LIMIT    = 100
const MAX_PAGES     = 20        // 2000 avis par passage, large au-dela du besoin
const BUDGET_MS      = 20000    // part du cycle de 60 s que ce poll s'autorise

async function channelCall (method, path) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' }
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// ─── Normalisation (fonctions pures, testables sans reseau) ─────────────────

// 'AirBNB' -> 'airbnb', 'BookingCom' -> 'booking'. Tout le reste passe en
// minuscules sans etre invente : une OTA inconnue doit rester reconnaissable.
function normaliserOta (ota) {
  const brut = String(ota || '').trim().toLowerCase()
  if (!brut) return 'inconnu'
  if (brut === 'airbnb') return 'airbnb'
  if (brut === 'bookingcom' || brut === 'booking.com') return 'booking'
  return brut
}

// `raw_content` n'a PAS les memes cles selon l'OTA :
//   Airbnb  -> { public_review, private_feedback }
//   Booking -> { headline, positive, negative }  — tout est public chez Booking
// Un avis peut avoir un raw_content vide : on retombe alors sur `content`.
function extraireContenu (rawContent, ota, content) {
  const rc = rawContent || {}
  if (ota === 'booking') {
    const morceaux = [rc.headline, rc.positive, rc.negative].filter(v => v && String(v).trim())
    return {
      public: morceaux.length ? morceaux.join('\n\n') : (content || null),
      prive: null       // Booking n'a pas de retour prive
    }
  }
  // Airbnb et defaut
  const pub = rc.public_review && String(rc.public_review).trim() ? rc.public_review : null
  const prv = rc.private_feedback && String(rc.private_feedback).trim() ? rc.private_feedback : null
  return { public: pub || content || null, prive: prv }
}

// La reponse de l'hote. Channex renvoie ici un OBJET, pas une chaine, et un
// objet VIDE quand il n'y a pas de reponse — 68 des 70 avis du premier poll
// reel. Ecrit tel quel dans une colonne text, cela donnait la chaine "{}" : une
// reponse fantome sur 68 lignes, que la fiche avis aurait affichee. Le signal
// fiable est `is_replied` (2 avis sur 70).
const CLES_REPONSE = ['message', 'text', 'content', 'body', 'reply', 'comment']

function extraireReponse (reply) {
  if (!reply) return null
  if (typeof reply === 'string') return reply.trim() || null
  if (typeof reply === 'object') {
    // Forme reelle constatee : { reply: "<texte>" } quand l'hote a repondu,
    // et {} sinon. On ne lit que des cles plausibles au lieu de prendre le
    // premier champ texte venu — sinon un `created_at` finirait ecrit comme
    // reponse de l'hote. Si une OTA en introduisait une autre, rien n'est
    // perdu : `raw` garde le payload et la colonne se rattrape a un poll pres.
    for (const cle of CLES_REPONSE) {
      const v = reply[cle]
      if (typeof v === 'string' && v.trim()) return v
    }
    return null
  }
  return null
}

// Note de proprete, extraite pour la fiche prestataire. Les deux OTA nomment
// cette categorie 'clean' ; 'cleanliness' est accepte par prudence.
function extraireScoreClean (scores) {
  if (!Array.isArray(scores)) return null
  const s = scores.find(x => {
    const c = String(x?.category || '').toLowerCase()
    return c === 'clean' || c === 'cleanliness'
  })
  return s && s.score != null ? Number(s.score) : null
}

// Construit la ligne `ota_reviews` a partir d'un avis Channex. Aucune
// normalisation des notes : overall_score et les categories n'ont pas la meme
// echelle chez Booking (overall 1 pour des categories a 2.5). Convertir ici
// graverait l'erreur dans le coeur.
// Renvoie null si l'avis n'a pas d'identifiant exploitable. Ecrire la chaine
// "undefined" dans external_review_id ferait pire que polluer : l'unicite etant
// (user_id, provider, external_review_id), tous les avis sans id d'un meme
// compte s'ecraseraient sur une seule ligne.
function versLigne (item, { userId, propertyId, propertyRef }) {
  const at = item?.attributes || {}
  const externalId = at.id || item?.id
  if (!externalId) return null
  const rel = item?.relationships || {}
  const ota = normaliserOta(at.ota)
  const contenu = extraireContenu(at.raw_content, ota, at.content)

  return {
    user_id:             userId,
    property_id:         propertyId,
    property_id_ref:     propertyRef,
    provider:            'channex',
    ota,
    external_review_id:  String(externalId),
    channel_id:          rel.channel?.data?.id || null,
    listing_id:          at.meta?.listing_id ? String(at.meta.listing_id) : null,
    ota_reservation_id:  at.ota_reservation_id || null,
    provider_booking_id: rel.booking?.data?.id || null,
    guest_name:          at.guest_name || null,
    content:             at.content || null,
    content_public:      contenu.public,
    content_private:     contenu.prive,
    reply:               extraireReponse(at.reply),
    is_replied:          at.is_replied === true,
    is_hidden:           at.is_hidden === true,
    overall_score:       at.overall_score ?? null,
    score_clean:         extraireScoreClean(at.scores),
    scores:              Array.isArray(at.scores) ? at.scores : null,
    tags:                Array.isArray(at.tags) ? at.tags : null,
    received_at:         at.received_at || null,
    expired_at:          at.expired_at || null,
    is_expired:          at.is_expired === true,
    provider_updated_at: at.updated_at || null,
    raw:                 item                    // payload integral, conserve
    // ⚠ booking_uid / stay_start / stay_end sont VOLONTAIREMENT absents de cet
    // objet quand la reservation n'est pas resolue — absents, et non a null.
    // PostgREST ne met dans le DO UPDATE SET que les colonnes presentes : une
    // resolution obtenue hier survit ainsi a un passage qui ne la retrouve pas.
    // Les poser a null "pour faire propre" DETRUIRAIT cette donnee. Idem pour
    // menage_event_id, ai_clean_verdict et ai_analyzed_at, jamais ecrits ici.
  }
}

// ─── Rattachement au compte (la garde) ──────────────────────────────────────

// Renvoie { owner } | { absent: true } | { ambigu: true } | { erreur: true }.
// L'ambiguite n'est PAS une absence : `provider_property_id` n'a aucune
// contrainte d'unicite globale (deux hotes d'un meme property manager portent
// la meme reference). Deviner, ce serait ecrire l'avis d'un hote chez un autre.
async function proprietaireDuBien (sb, providerPropertyId) {
  if (!providerPropertyId) return { absent: true }
  const { data, error } = await sb
    .from('properties')
    .select('id, user_id, provider_property_id')
    .eq('provider', 'channex')
    .eq('provider_property_id', String(providerPropertyId))
    .limit(2)
  if (error) return { erreur: true, message: error.message }
  if (!data || data.length === 0) return { absent: true }
  // Deux lignes du MEME compte ne sont pas une ambiguite de cloisonnement :
  // `properties` n'a aucune unicite sur (user_id, provider_property_id) et
  // api/channel-property.js cree par INSERT nu — un double envoi du formulaire
  // suffit a doubler la ligne. Traiter ce cas comme ambigu ferait perdre TOUS
  // les avis du bien, definitivement, et en silence.
  const comptes = new Set(data.map(d => d.user_id))
  if (comptes.size > 1) return { ambigu: true }
  return { owner: data[0] }
}

// ─── Index des codes OTA, par compte ────────────────────────────────────────
// Le premier poll reel faisait UNE requete bookings_snapshot par avis : 70 avis
// = 70 allers-retours, et un passage de 26 s pour un budget de 20 s. On charge
// desormais les codes d'un compte en une fois.
//
// ⚠ La cle de cette Map est le code OTA SEUL, ce que REVIEW.md regle 1 interdit
// sur un lot multi-comptes. C'est licite ici, et seulement ici, parce que la Map
// est construite par `.eq('user_id', userId)` et rangee sous ce userId dans le
// cache appelant : le cloisonnement est porte par la structure, pas par la cle.
// Fusionner ces Maps entre comptes reintroduirait exactement la collision que la
// regle decrit.
function indexerSnapshots (lignes) {
  const index = new Map()
  const doublons = new Set()
  for (const l of lignes || []) {
    const code = l?.snapshot?.otaReservationCode
    if (!code) continue
    const cle = String(code)
    if (index.has(cle)) { doublons.add(cle); continue }
    index.set(cle, {
      booking_uid: String(l.booking_id),
      stay_start:  l.snapshot.arrival   || null,
      stay_end:    l.snapshot.departure || null
    })
  }
  // Un code porte par deux reservations du meme compte n'est pas resolvable :
  // on le retire plutot que de choisir la premiere ligne venue.
  for (const d of doublons) index.delete(d)
  return index
}

async function chargerIndexCompte (sb, userId) {
  const { data, error } = await sb
    .from('bookings_snapshot')
    .select('booking_id, snapshot')
    .eq('user_id', userId)
  if (error) return null
  return indexerSnapshots(data)
}

// ─── Writer commun (poll ET webhook) ────────────────────────────────────────
// UN SEUL endroit ecrit ota_reviews, et un seul endroit connait la contrainte
// d'idempotence. Le poll accumule des lignes et les ecrit par page ; le webhook
// n'en a qu'une. La contrainte etant la meme, rejouer un avis est sans effet.
const CONFLIT = 'user_id,provider,external_review_id'

async function upsertAvis (sb, lignes) {
  const lot = Array.isArray(lignes) ? lignes : [lignes]
  if (!lot.length) return { ecrits: 0 }
  const { error } = await sb.from('ota_reviews').upsert(lot, { onConflict: CONFLIT })
  if (error) return { ecrits: 0, error }
  return { ecrits: lot.length }
}

// Transforme UN avis provider en ligne prete a ecrire, ou dit pourquoi il ne
// doit pas l'etre. Les caches sont optionnels : le webhook n'en a pas besoin.
// Renvoie { ligne, resolu } | { ignore: '<raison>' } | { erreur: true }.
async function preparerAvis (sb, item, caches = {}) {
  const cacheOwner = caches.cacheOwner || new Map()
  const cacheIndex = caches.cacheIndex || new Map()

  const ref = item?.relationships?.property?.data?.id
  const cle = String(ref || '')

  // Un echec SQL n'est PAS mis en cache : un incident transitoire sur la
  // premiere requete d'un bien ferait sinon sauter tous ses avis pour la
  // journee entiere, le marqueur etant deja pose.
  let res = cacheOwner.get(cle)
  if (!res) {
    res = await proprietaireDuBien(sb, ref)
    if (!res.erreur) cacheOwner.set(cle, res)
  }

  if (res.erreur) return { erreur: true }
  // Un bien non rattache a HoteSmart, ou rattache de facon ambigue, n'est PAS
  // ecrit : mieux vaut un avis manquant qu'un avis chez le mauvais hote.
  if (res.absent) return { ignore: 'bien_inconnu' }
  if (res.ambigu) {
    console.error('[cron-reviews] bien ambigu, avis ignore, reference:', cle)
    return { ignore: 'bien_ambigu' }
  }

  const ligne = versLigne(item, {
    userId:      res.owner.user_id,
    propertyId:  res.owner.id,
    propertyRef: res.owner.provider_property_id
  })
  if (!ligne) return { erreur: true }

  // Index des codes OTA du compte, charge une seule fois par compte.
  if (!cacheIndex.has(ligne.user_id)) {
    cacheIndex.set(ligne.user_id, await chargerIndexCompte(sb, ligne.user_id))
  }
  const index = cacheIndex.get(ligne.user_id)
  const resa = (index && ligne.ota_reservation_id)
    ? index.get(String(ligne.ota_reservation_id)) || null
    : null
  if (resa) {
    ligne.booking_uid = resa.booking_uid
    ligne.stay_start  = resa.stay_start
    ligne.stay_end    = resa.stay_end
  }
  return { ligne, resolu: !!resa }
}

// ─── Poll principal ─────────────────────────────────────────────────────────

async function pollChannelReviews (results, deps = {}) {
  const sb = deps.supabase || supabase
  const appel = deps.channelCall || channelCall
  const maintenant = deps.now || (() => Date.now())
  if (!CHANNEL_API || !CHANNEL_KEY) return { skipped: 'non_configure' }

  // Cadence quotidienne via marqueur, sur le modele de checkTableGrowth.
  if (!deps.forcer) {
    const { data: marker } = await sb
      .from('cron_logs').select('last_run').eq('id', MARQUEUR).maybeSingle()
    if (marker?.last_run && (maintenant() - new Date(marker.last_run).getTime()) < PERIODE_MS) {
      return { skipped: 'cadence' }
    }
  }

  // ⚠ MARQUEUR POSE AVANT LE TRAVAIL, PAS APRES.
  // Le cycle de cron est plafonne a 60 s (vercel.json). Si ce poll faisait
  // deborder l'invocation, elle serait tuee avant d'ecrire son marqueur de fin :
  // le poll repartirait alors a CHAQUE tick de 5 min, en boucle, et mangerait le
  // budget des autres etapes. Poser le marqueur d'abord fait perdre au pire une
  // journee d'avis en cas d'echec — ce que le passage suivant rattrape, puisqu'il
  // relit tout et que l'upsert est idempotent.
  // Forme reprise a l'identique de lib/cron-alerting.js : onConflict explicite,
  // et total_messages/total_replies/errors fournis pour couvrir un eventuel NOT
  // NULL du schema cron_logs. Le retour EST controle : toute la garde de cadence
  // repose sur cette ecriture, et supabase-js ne leve pas, il renvoie { error }.
  // Marqueur non ecrit = poll relance a chaque tick de 5 min.
  const { error: errMarqueur } = await sb.from('cron_logs').upsert({
    id: MARQUEUR, last_run: new Date(maintenant()).toISOString(),
    total_messages: 0, total_replies: 0, errors: []
  }, { onConflict: 'id' })
  if (errMarqueur) {
    console.error('[cron-reviews] marqueur de cadence NON ecrit:', errMarqueur.message)
    results?.errors?.push({ context: 'channel_reviews', error: 'marqueur: ' + errMarqueur.message })
    return { skipped: 'marqueur_illisible' }
  }

  const bilan = {
    lus: 0, ecrits: 0, resolus: 0,
    bien_inconnu: 0, bien_ambigu: 0, erreurs: 0
  }
  // Budget mur : on rend la main au cycle plutot que de le faire tuer. Le
  // reliquat part au passage du lendemain.
  const echeance = maintenant() + BUDGET_MS
  // Cache des proprietaires : cle = reference du bien. Il ne traverse pas les
  // comptes (la reference EST le rattachement), et il est vide a chaque passage.
  const cacheOwner = new Map()
  // Index des codes OTA, UNE entree par compte (voir indexerSnapshots).
  const cacheIndex = new Map()

  let page = 1
  while (page <= MAX_PAGES) {
    if (maintenant() > echeance) { bilan.interrompu = 'budget'; break }
    const r = await appel('GET', `/reviews?order[received_at]=desc&pagination[page]=${page}&pagination[limit]=${PAGE_LIMIT}`)
    if (!r.ok) {
      console.error('[cron-reviews] lecture echec', r.status)
      results?.errors?.push({ context: 'channel_reviews', error: 'HTTP ' + r.status })
      return { ...bilan, interrompu: 'http_' + r.status }
    }
    const liste = Array.isArray(r.json?.data) ? r.json.data : []
    if (liste.length === 0) break

    const lot = []
    for (const item of liste) {
      if (maintenant() > echeance) { bilan.interrompu = 'budget'; break }
      bilan.lus++

      const prep = await preparerAvis(sb, item, { cacheOwner, cacheIndex })
      if (prep.erreur) { bilan.erreurs++; continue }
      if (prep.ignore) { bilan[prep.ignore]++; continue }
      if (prep.resolu) bilan.resolus++
      lot.push(prep.ligne)
    }

    // ECRITURE PAR LOT, une requete par page au lieu d'une par avis. L'upsert
    // unitaire coutait ~140 ms piece : 70 avis en 9,8 s, et surtout un plafond
    // d'environ 140 avis par passage une fois le budget mur atteint — au-dela,
    // les avis suivants n'auraient jamais ete ingeres, ni ce jour-la ni les
    // suivants, puisque le poll repart toujours de la page 1.
    const ecriture = await upsertAvis(sb, lot)
    if (ecriture.error) {
      bilan.erreurs += lot.length
      console.error('[cron-reviews] upsert du lot echec', ecriture.error.message)
    } else {
      bilan.ecrits += ecriture.ecrits
    }

    const limite = r.json?.meta?.limit || liste.length
    if (liste.length < limite) break
    page++
  }

  // Pas de passe de rattrapage separee : ce poll relit TOUS les avis a chaque
  // passage et retente la resolution de chacun. Une passe supplementaire rejouait
  // a l'identique ce qui venait d'echouer — 59 requetes pour zero resolution au
  // premier poll reel. Si le poll devenait un jour incremental, la resolution
  // tardive redeviendrait necessaire.

  if (bilan.interrompu === 'budget') {
    // Une troncature silencieuse est le pire des cas : elle ressemble a un
    // passage reussi. Le reliquat part au passage suivant, mais l'ecart doit
    // remonter dans les erreurs du cycle.
    console.error('[cron-reviews] passage TRONQUE sur budget, avis lus:', bilan.lus)
    results?.errors?.push({ context: 'channel_reviews', error: 'passage tronque sur budget apres ' + bilan.lus + ' avis' })
  }
  if (bilan.ecrits > 0 || bilan.bien_ambigu > 0) {
    console.log('[cron-reviews] bilan', JSON.stringify(bilan))
  }
  if (results) results.totalChannelReviews = (results.totalChannelReviews || 0) + bilan.ecrits
  return bilan
}

module.exports = {
  pollChannelReviews,
  // exportes pour les tests
  normaliserOta,
  extraireContenu,
  extraireScoreClean,
  extraireReponse,
  versLigne,
  indexerSnapshots,
  proprietaireDuBien,
  chargerIndexCompte,
  // writer commun, partage avec le webhook api/channel-events.js
  preparerAvis,
  upsertAvis
}
