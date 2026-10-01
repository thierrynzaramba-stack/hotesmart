// api/channel-webhook.js
// Webhook ENTRANT depuis le channel manager (white-label).
// Recoit les notifications booking (new/modified/cancelled) et message voyageur.
//
// Securite : pas de signature crypto cote channel -> on valide un secret partage
// passe en header (configure a la creation du webhook, cf. action 'register').
//
// Principe booking : le webhook ne donne que l'id. On RAPPELLE le channel
// (GET /booking_revisions/:id) pour l'etat reel (les webhooks peuvent arriver
// dans le desordre), on range dans bookings_snapshot, puis on ACK la revision.

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// Writer unique de bookings_snapshot (audit E3/E4/E5) : schema commun aux deux
// providers, statut canonique, merge non destructif.
const { saveBookingSnapshot, fromChannex, STATUS } = require('../lib/bookings-snapshot')
const { requirePermission } = require('../lib/require-permission')
// ⚠ CET IMPORT AVAIT DISPARU, et la reception l'utilise (ligne ~148). Mon
// remplacement de bloc l'a emporte avec le masqueur qu'il remplacait : une
// `ReferenceError` a la premiere reservation recue, c'est-a-dire tout ce que le
// correctif pretendait ne pas toucher. Trouve en comparant les lignes SUPPRIMEES
// du diff une par une, parce que le compte ne tombait pas juste.
const { trouverBienParIdProvider } = require('../lib/bien-du-provider')

// ⚠ ON NE PARIE PLUS SUR LA FORME DE LA REPONSE, ON CHERCHE LA VALEUR.
// Premiere version : un masqueur PLAT qui retirait `headers` et `request_params`
// a deux endroits precis. Une review l'a eprouve sur huit formes de reponse
// plausibles — CINQ fuyaient. Dont deux qui ne sont pas speculatives :
//
//   `{ raw: "<texte>" }`  — fabrique par `channelCall` de CE fichier des que le
//                           provider ne rend pas du JSON (page d'un WAF, 413…) ;
//   `{ data: [ … ] }`     — la forme documentee de `/webhooks`, que
//                           `scripts/check-webhooks.js` attend deja. Le masqueur
//                           y destructurait un TABLEAU, rendant un objet a cles
//                           numeriques, secrets imbriques intacts.
//
// Et le test ne pouvait pas le voir : son double du provider produisait
// PRECISEMENT la seule forme que le masqueur savait traiter. Vert par
// construction.
//
// On balaie donc par VALEUR, recursivement, chaines comprises — c'est la regle 11
// appliquee a la SORTIE : on ne valide pas une forme, on retire ce qu'on ne veut
// pas voir sortir. Et c'est plus court que ce qu'on remplace.
function sansSecrets (rep) {
  const secrets = [WEBHOOK_SECRET, VERCEL_BYPASS].filter(v => typeof v === 'string' && v.length >= 8)
  if (!secrets.length) return rep
  const nettoyer = (v) => {
    // ⚠ `split/join` ET PAS une egalite : le secret peut etre ENCHASSE dans une
    // chaine — un message d'erreur qui recopie le corps envoye, un `raw` de page
    // HTML. Une egalite stricte l'aurait laisse passer.
    if (typeof v === 'string') {
      let r = v
      for (const s of secrets) if (r.includes(s)) r = r.split(s).join('***RETIRE***')
      return r
    }
    if (Array.isArray(v)) return v.map(nettoyer)          // le tableau reste un tableau
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, x] of Object.entries(v)) out[k] = nettoyer(x)
      return out
    }
    return v
  }
  return nettoyer(rep)
}

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY
const WEBHOOK_SECRET = process.env.CHANNEL_WEBHOOK_SECRET
const VERCEL_BYPASS = process.env.VERCEL_BYPASS_TOKEN  // bypass protection deploiement (Preview)

// ⚠ CORRECTION DE SECURITE DU 1er OCTOBRE 2026 — L'ACTION `register` SEULE.
// La reception des events, plus bas, n'est pas touchee : c'est elle que la
// certification du gestionnaire de canaux eprouve, et elle ne bouge pas d'un
// octet. `register`, elle, ne fait que CONFIGURER le webhook chez le provider.
//
// Ce qui etait ouvert : `callback_url` venait du CLIENT. Toute session valide —
// un membre delegue, un compte d'essai, sans aucun droit particulier — pouvait
// donc faire enregistrer chez le gestionnaire un webhook GLOBAL pointant chez
// elle. Le corps envoye au provider porte en clair
// `X-Channel-Webhook-Secret` et le bypass Vercel : l'appelant recevait les deux,
// puis chaque reservation et chaque message de TOUT LE PARC, et pouvait ensuite
// forger des events sur ce webhook-ci comme sur `api/channel-events.js`, qui
// partage la meme variable.
//
// Le fichier voisin a deja paye ce constat DEUX fois — la premiere version y
// validait le CHEMIN de l'URL, ce qui ne sert a rien : le chemin de
// « https://evil.example.com/api/channel-webhook » est parfaitement valide. La
// lecon y est ecrite : on ne valide pas une donnee client qui designe une
// ressource, on ne l'utilise pas.
const DOMAINES_APP = ['hotesmart.vercel.app']

// ⚠ LE MASQUE DU WEBHOOK CERTIFIE, NOMME. Il etait un litteral en deux endroits
// possibles ; `scripts/check-webhooks.js` en porte un troisieme, en dur lui
// aussi. Une divergence entre eux ne serait vue par personne. Constat de review.
const MASQUE_CERTIFIE = 'booking;message'

// ⚠ CE QUE `request_params` DOIT PORTER DEPEND DE LA CIBLE, PAS DE L'ENDROIT
// D'OU ON APPELLE. Constat CRITIQUE de review, et c'etait la classe de fuite
// exacte que cette livraison supprime : le corps du PUT lisait
// `VERCEL_BYPASS_TOKEN` de l'environnement d'EXECUTION. Lance depuis une preview
// — ce que mon propre commentaire prescrivait — il ecrasait le `request_params
// {}` du webhook de PRODUCTION par le jeton de bypass. Le gestionnaire l'aurait
// alors ajoute en QUERY STRING a chaque reservation et chaque message entrants,
// donc dans les journaux d'acces de production, en permanence.
//
// `docs/CHANNEL_TECH.md` est explicite : ce jeton est « Preview UNIQUEMENT », et
// « JAMAIS en prod (pas de mur) ». Le bypass n'a de sens que si la CIBLE est
// derriere le mur Vercel. Comme la cible est toujours un domaine de
// `DOMAINES_APP`, qui n'en est pas, elle vaut `{}`.
function parametresDeRequete (cible) {
  const hote = (() => { try { return new URL(cible).host } catch { return '' } })()
  // Un domaine applicatif n'est pas protege par le mur : aucun parametre.
  if (DOMAINES_APP.includes(hote)) return {}
  // Tout autre hote serait une preview, donc derriere le mur. Ce cas n'existe
  // pas aujourd'hui — l'action refuse de tourner hors de DOMAINES_APP — mais si
  // la liste s'ouvre un jour, le bypass suivra la cible, pas l'appelant.
  return VERCEL_BYPASS ? { 'x-vercel-protection-bypass': VERCEL_BYPASS } : {}
}

// ⚠ ELLE REND L'URL DE PRODUCTION, Y COMPRIS APPELEE DE STAGING, ET ELLE LE DIT.
// `DOMAINES_APP` n'a qu'une entree : tout hote inconnu — le projet staging, une
// preview `hotesmart-git-<branche>-…` — retombe donc sur la production. Lance de
// la, `register` enregistrerait chez le provider un webhook pointant sur la PROD
// en y mettant le secret de STAGING : la production refuserait chaque livraison
// en 401, et le gestionnaire retenterait en boucle.
//
// Le repli est GARDE volontairement — l'etape 5 de la rotation s'execute depuis
// une preview, et echouer ferme bloquerait la rotation — mais il CRIE desormais,
// et la cible effective part dans la reponse. Constat de review : un envoi qui se
// trompe de cible en silence est exactement ce que
// `docs/specs/spec-garde-environnement.md` interdit dans le meme commit.
function urlWebhookDeCeFichier (req) {
  const host = String(req.headers?.host || '').toLowerCase().split(':')[0]
  if (host && !DOMAINES_APP.includes(host)) {
    console.warn(`[channel-webhook] register appele depuis « ${host} », hors de DOMAINES_APP :`
      + ` la cible reste ${DOMAINES_APP[0]}. Si vous attendiez un webhook pour CET hote, il n'en sera pas cree.`)
  }
  const domaine = DOMAINES_APP.includes(host) ? host : DOMAINES_APP[0]
  return `https://${domaine}/api/channel-webhook`
}

// Push availability mutualise (idempotence anti-doublon webhook+poll, cf. lib/channel-availability.js)
const { pushAvailabilityOnce } = require('../lib/channel-availability')
// Double ecriture vers la table source de verite `messages` (etape 2 messagerie unifiee).
const { recordMessage } = require('../lib/record-message')
const { enUTC } = require('../lib/channels/channex')

async function channelCall(method, path, body) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: {
      'user-api-key': CHANNEL_KEY,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Retrouve le bien HoteSmart a partir de l'identifiant porte par le provider.
//
// ⚠ SUR LES DEUX COLONNES, ET C'EST VITAL PENDANT UNE MIGRATION.
// Un bien en cours de bascule porte ses canaux sur sa propriete CIBLE : le
// webhook arrive donc avec `migration_target_property_id`, pas avec
// `provider_property_id`. Chercher sur la seule cle source faisait qu'aucun bien
// ne reclamait la reservation — perdue en silence, alors que « une reservation
// OTA qui n'arrive pas dans le coeur sous 30 min » est un critere de rollback du
// plan de bascule. Point unique : lib/bien-du-provider.js.
async function ownerOfProperty(providerPropertyId) {
  // `id` (UUID) et `provider_rate_plan_id` : requis par la reaffirmation du
  // stop-sell, qui lit la memoire d'intention (calendar_inventory, cle = UUID)
  // et pousse /restrictions sur le rate plan du bien.
  return trouverBienParIdProvider(supabase, providerPropertyId, {
    colonnes: 'id, user_id, provider_property_id, migration_target_property_id, '
      + 'provider_room_type_id, provider_rate_plan_id, inventory_type'
  })
}

// ---- BOOKING ----
// Strategie Feed (recommandee certif) : le webhook n'est qu'un declencheur.
// On lit GET /booking_revisions/feed (toutes les revisions non-ack), on traite
// chacune, puis on ACK seulement apres sauvegarde reussie. Une revision ackee
// ne reapparait plus dans le feed. Robuste aux webhooks perdus / hors ordre.
async function handleBooking(_payload) {
  const processed = []
  let page = 1
  const MAX_PAGES = 10  // garde-fou

  while (page <= MAX_PAGES) {
    const r = await channelCall('GET', `/booking_revisions/feed?order[inserted_at]=asc&page=${page}`)
    if (!r.ok) {
      console.error('[channel-webhook] feed failed', r.status, r.json)
      return { ok: false, reason: 'feed_failed' }
    }

    const list = Array.isArray(r.json?.data) ? r.json.data : []
    if (list.length === 0) break  // plus rien a traiter

    for (const item of list) {
      const rev = item.attributes || {}
      const revisionId = rev.id || item.id
      const res = await saveRevision(rev, revisionId)
      if (res.saved) {
        await ackRevision(revisionId)  // ack UNIQUEMENT apres sauvegarde reussie
        processed.push(revisionId)
      } else if (res.reason === 'unknown_property') {
        // Bien non rattache a un user HoteSmart : on ack pour purger le feed.
        await ackRevision(revisionId)
      } else {
        // Erreur DB : on N'ACK PAS -> la revision restera dans le feed (retry).
        console.error('[channel-webhook] save failed, pas d ack', revisionId, res.reason)
      }
    }

    // Pagination : si moins d'une page pleine, on s'arrete.
    const limit = r.json?.meta?.limit || list.length
    if (list.length < limit) break
    page++
  }

  console.log('[channel-webhook] feed traite, revisions ackees:', processed.length)
  return { ok: true, processed: processed.length }
}

// Mappe une revision Channex -> bookings_snapshot. Ne fait PAS l'ack.
async function saveRevision(rev, revisionId) {
  const providerPropertyId = rev.property_id
  const bookingId = rev.booking_id || revisionId
  const owner = await ownerOfProperty(providerPropertyId)
  if (!owner) {
    console.warn('[channel-webhook] bien inconnu', providerPropertyId)
    return { saved: false, reason: 'unknown_property' }
  }
  // Deux biens pour un meme identifiant : on n'attribue pas la reservation au
  // premier arrive. Elle reste non ackee et repassera dans le feed.
  if (owner.ambigu) {
    console.error('[channel-webhook] identifiant AMBIGU, reservation non attribuee', providerPropertyId)
    return { saved: false, reason: 'ambiguous_property' }
  }

  // ⚠ LA CLE D'ECRITURE DU COEUR EST `provider_property_id`, PAS L'ID RECU.
  // Pendant une migration, le webhook arrive avec la propriete CIBLE, alors que
  // TOUS les lecteurs du coeur interrogent `bookings_snapshot.property_id` avec
  // `bien.provider_property_id` — le calendrier, le planning menage, et surtout
  // `nuitsOccupees`, qui alimente le verrou anti-surreservation. Ecrire sous
  // l'identifiant recu aurait enregistre la reservation sous une cle que
  // personne ne lit : la nuit vendue serait passee pour libre. Le re-keying
  // (phase 2.8) deplacera ces lignes en meme temps que les 13 autres tables.
  const cleDuCoeur = owner.provider_property_id

  // Statut Channex brut (new | modified | cancelled) normalise en canonique
  // (confirmed | cancelled) par le writer unique.
  const snapshot = fromChannex(rev)

  const saved = await saveBookingSnapshot(supabase, {
    userId:     owner.user_id,
    bookingId,
    propertyId: cleDuCoeur,   // = provider_property_id (text), JAMAIS l'id recu
    provider:   'channex',
    snapshot,
    // Le payload brut, avec `id` FORCE au booking id : la colonne `raw` doit
    // porter la meme forme quel que soit le chemin d'ecriture. api/channel-events.js
    // y met `{ id: <booking id>, ...attributs }` ; ici `rev` est une
    // booking_revision dont l'id est celui de la REVISION. Sans cela, `raw.id`
    // designerait tantot l'une tantot l'autre, et les deux formes se chasseraient
    // a chaque passage en declenchant un UPDATE sans changement de contenu.
    booking:    { ...rev, id: bookingId }
  })

  if (!saved.ok) {
    console.error('[channel-webhook] upsert booking failed', saved.error || saved.reason)
    return { saved: false, reason: 'db_error' }
  }

  console.log('[channel-webhook] booking', snapshot.status, bookingId, '->', owner.user_id)

  // Gestion dispo pour bien whole : reservation occupe la maison, annulation la libere.
  const open = (snapshot.status === STATUS.CANCELLED) ? 1 : 0
  await pushAvailabilityOnce(owner, providerPropertyId, snapshot.arrival, snapshot.departure, open, 'channel-webhook')

  return { saved: true }
}

// Ack d'une revision. Isole + log detaille : au 1er vrai webhook, les logs
// Vercel confirmeront si l'endpoint /ack repond 200 (sinon on ajuste l'URL).
async function ackRevision(revisionId) {
  const a = await channelCall('POST', `/booking_revisions/${revisionId}/ack`)
  if (!a.ok) console.error('[channel-webhook] ack failed', revisionId, a.status, a.json)
  else console.log('[channel-webhook] ack ok', revisionId)
  return a.ok
}

// ---- MESSAGE ----
async function handleMessage(payload) {
  const providerPropertyId = payload?.property_id
  const owner = await ownerOfProperty(providerPropertyId)
  if (!owner) {
    console.warn('[channel-webhook] message bien inconnu', providerPropertyId)
    return { ok: true, reason: 'unknown_property' }
  }
  if (owner.ambigu) {
    console.error('[channel-webhook] identifiant AMBIGU, message non attribue', providerPropertyId)
    return { ok: false, reason: 'ambiguous_property' }
  }
  // Meme regle que pour les reservations : le coeur est keye par
  // `provider_property_id`, pas par l'identifiant recu du provider.
  const cleDuCoeur = owner.provider_property_id

  // On ne stocke que les messages voyageur (sender 'guest')
  if (payload.sender && payload.sender !== 'guest') {
    return { ok: true, reason: 'not_guest' }
  }

  // Deduplication : Channex peut renvoyer le meme message (retry/double webhook).
  // On ignore si un message identique non repondu existe deja dans les 2 dernieres minutes.
  const since = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  const { data: dup } = await supabase
    .from('conversations')
    .select('id')
    .eq('property_id', String(providerPropertyId))
    .eq('book_id', payload.booking_id || null)
    .eq('guest_message', payload.message || '')
    .is('agent_reply', null)
    .gte('created_at', since)
    .limit(1)
  if (dup && dup.length) {
    console.log('[channel-webhook] message duplique ignore', payload.booking_id)
    return { ok: true, reason: 'duplicate' }
  }

  const { error } = await supabase
    .from('conversations')
    .insert({
      user_id:      owner.user_id,
      property_id:  String(cleDuCoeur),
      book_id:      payload.booking_id || null,
      guest_message: payload.message || '',
      guest_name:   '',
      agent_reply:  null
    })

  if (error) {
    console.error('[channel-webhook] insert message failed', error.message)
    return { ok: false, reason: 'db_error' }
  }

  // CAPTURE TEMPORAIRE : decouvrir le vrai nom du champ id de message Channex
  // sur le prochain webhook reel. A RETIRER une fois le champ identifie.
  console.log('[channel-webhook] payload message keys:', Object.keys(payload || {}))

  // DOUBLE ECRITURE (etape 2) : on ecrit AUSSI dans `messages`, sans toucher
  // a l'INSERT conversations ci-dessus. Fail-safe : recordMessage ne throw
  // jamais, son echec ne casse ni l'insert conversations ni l'ack.
  // providerMsgId : seul un champ explicite message_id est utilise (id de
  // message Channex non confirme dans le payload) -> sinon dedup logique.
  // ota = null : recordMessage resout via bookings_snapshot (gere la race).
  await recordMessage({
    userId:        owner.user_id,
    provider:      'channex',
    propertyId:    cleDuCoeur,
    bookingId:     payload.booking_id || null,
    direction:     'inbound',
    sender:        'guest',
    body:          payload.message || '',
    providerMsgId: payload.message_id || null,
    ota:           null,
    // ⚠ MEME NORMALISATION QUE L'IMPORT. Channex rend ses instants SANS fuseau,
    // et ce chemin-ci est l'AUTOMATIQUE — celui qui tourne tous les jours, quand
    // `importMessages` ne tourne que quelques fois par an. Le laisser nu ferait
    // mentir le commentaire de `channex.js`, qui promet une frontiere : « on rend
    // le fuseau explicite au point d'entree, une fois, plutot que dans chaque
    // lecteur ». Releve en review le 14 septembre 2026.
    sentAt:        enUTC(payload.inserted_at || payload.timestamp || null),
    kind:          'message'
  })

  console.log('[channel-webhook] message', payload.booking_id, '->', owner.user_id)
  return { ok: true }
}

module.exports = async function handler(req, res) {
  // -- Enregistrement du webhook global cote channel (appel authentifie user) --
  // POST avec body { action:'register', callback_url } -> cree un webhook is_global
  if (req.method === 'POST' && req.body?.action === 'register') {
    // ⚠ CETTE GARDE NE FILTRE PRESQUE RIEN, ET IL FAUT LE LIRE ICI.
    // `domaine: 'titulaire'` exige que l'appelant soit titulaire du COMPTE
    // CIBLE. Sans l'option `compteDelegue`, le compte cible est le SIEN : tout
    // utilisateur connecte est donc titulaire, et passe. `lib/require-permission.js`
    // le dit noir sur blanc — « ne pas l'utiliser pour proteger une ressource
    // GLOBALE » — et `api/diagnostic.js` repete le meme avertissement.
    //
    // Ce qu'elle apporte quand meme : elle refuse la DELEGATION, donc un membre
    // agissant au nom d'un autre compte. Ce qu'elle n'apporte pas : empecher un
    // utilisateur quelconque de declencher un enregistrement. Il ne peut plus
    // choisir la cible — c'est l'objet du correctif — mais il peut en creer
    // autant qu'il veut (voir le test « CE QUI RESTE OUVERT »).
    //
    // ⚠ UNE VERSION PRECEDENTE DE CE COMMENTAIRE DISAIT « RESERVE AU TITULAIRE,
    // une session valide ne suffit pas ». C'etait faux, et c'est exactement le
    // mecanisme du trou que ce fichier vient de payer : `profils-et-droits.md`
    // l'avait mis « hors perimetre » du balayage des droits sur la foi d'une
    // affirmation fausse. Constat de review.
    const garde = await requirePermission(req, res, { domaine: 'titulaire' })
    if (!garde.ok) return

    // ⚠ L'ACTION REFUSE DE TOURNER HORS DES DOMAINES APPLICATIFS. Constat HAUT de
    // review. `urlWebhookDeCeFichier` ne peut rendre que l'URL de production :
    // lancee depuis le projet STAGING, l'action creait donc, dans le compte de
    // canal de staging, un webhook global pointant sur la PRODUCTION et portant le
    // secret de STAGING. La production aurait refuse chaque livraison en 401, le
    // gestionnaire aurait retente en boucle, et le secret de staging n'aurait
    // jamais ete rote. Le seul signal etait un avertissement dans les journaux.
    //
    // Mon commentaire prescrivait pourtant de lancer l'etape 5 de la rotation
    // « depuis une preview » : c'etait une supposition de ma part, pas une
    // contrainte. Elle se lance depuis la PRODUCTION, et le runbook le dit.
    const hoteAppelant = String(req.headers?.host || '').toLowerCase().split(':')[0]
    if (!DOMAINES_APP.includes(hoteAppelant)) {
      console.error(`[channel-webhook] register refuse depuis « ${hoteAppelant} » : hors DOMAINES_APP`)
      return res.status(409).json({
        ok: false, registered: false, updated: false,
        error: 'Cette action ne s execute que depuis un domaine applicatif',
        reason: `Appele depuis « ${hoteAppelant} ». La cible du webhook est toujours ${DOMAINES_APP[0]} :`
          + ` lance d ailleurs, cet appel enregistrerait un webhook pointant sur la production`
          + ` avec le secret de l environnement appelant. Relancez depuis la production.`,
        attendu: DOMAINES_APP,
      })
    }

    // ⚠ LA CIBLE EST CONSTRUITE ICI, JAMAIS RECUE. Voir l'en-tete : c'est tout
    // l'objet de ce correctif.
    const callbackUrl = urlWebhookDeCeFichier(req)

    // Le front envoie deja cette valeur. Un ecart signale un appelant qui se
    // trompe de cible — ou qui essaie : on le DIT plutot que de l'ignorer en
    // silence, ce qui laisserait croire a un succes.
    const demande = req.body.callback_url
    if (demande && String(demande) !== callbackUrl) {
      return res.status(400).json({
        error: 'callback_url non conforme',
        reason: "Cet endpoint n'enregistre que son propre webhook ; la cible est determinee par le serveur.",
        attendu: callbackUrl
      })
    }

    // ⚠ ON CHERCHE L'EXISTANT AVANT DE CREER. Constat de review, et il ne s'agit
    // pas d'un doublon isole : sans limite de debit ni idempotence, le NOMBRE de
    // webhooks globaux etait choisi par l'appelant. Chaque event declenchait alors
    // autant de balayages COMPLETS du feed — jusqu'a dix pages de revisions et un
    // acquittement par revision, chacun en concurrence avec les autres sur les
    // memes lignes.
    //
    // Meme mecanique que `api/channel-events.js`, et pour la meme raison : un POST
    // aveugle cree un doublon ou se fait refuser, et dans les deux cas le webhook
    // existant garde son ancien en-tete. C'est ce qui rendait la rotation du
    // secret impossible par le code — l'etape 5 du runbook devait passer par
    // l'interface du gestionnaire.
    const liste = await channelCall('GET', '/webhooks')
    if (!liste.ok) {
      // ⚠ ON NE CREE PAS A L'AVEUGLE. Sans la liste, impossible de savoir si le
      // webhook existe : un POST produirait le doublon qu'on vient de fermer.
      console.error('[channel-webhook] lecture des webhooks impossible', liste.status)
      return res.status(200).json({
        ok: false, registered: false, updated: false,
        channel_status: liste.status,
        reason: "Impossible de lire les webhooks existants : on n'en cree pas a l'aveugle (risque de doublon et de double livraison). Reessayer plus tard.",
        detail: sansSecrets(liste.json?.errors || liste.json),
      })
    }
    // ⚠ UNE FORME INATTENDUE N'EST PAS UNE LISTE VIDE. Constat de review : un
    // `data` objet au lieu d'un tableau rendait `tous = []`, donc une CREATION —
    // exactement ce que la garde du dessus interdit quand la liste est illisible.
    if (liste.json && liste.json.data !== undefined && !Array.isArray(liste.json.data)) {
      console.error('[channel-webhook] /webhooks rend une forme inattendue : on ne cree rien')
      return res.status(200).json({
        ok: false, registered: false, updated: false,
        reason: "La liste des webhooks n'a pas la forme attendue (data n'est pas un tableau) : creation refusee pour ne pas produire de doublon.",
      })
    }
    const tous = Array.isArray(liste.json?.data) ? liste.json.data : []

    // ⚠ UNE LISTE TRONQUEE N'EST PAS UNE LISTE COMPLETE, et c'est LE constat qui
    // decide ici. Le gestionnaire pagine : son `meta` annonce `total` et `limit`
    // (10 par defaut). Au-dela de dix webhooks sur le compte, `data` n'en porte
    // que dix — et le notre peut n'y etre pas, ce qui ferait CREER un doublon
    // alors qu'il existe deja.
    //
    // ⚠ ET LE PARAMETRE `page` N'EST PAS HONORE PAR CE POINT D'APPEL. Mesure du
    // 1er octobre 2026 : `/webhooks?page=2` rend exactement la meme chose que
    // `/webhooks`. Boucler sur les pages ne reparerait donc RIEN — c'est l'erreur
    // que j'ai faite en relevant le compte, ou j'ai additionne la meme page vingt
    // fois et annonce quarante webhooks la ou il y en a deux. On ne pagine pas :
    // on REFUSE quand la liste est incomplete, parce qu'on ne peut pas conclure.
    const total = Number(liste.json?.meta?.total)
    if (Number.isFinite(total) && total > tous.length) {
      console.error(`[channel-webhook] liste tronquee : ${tous.length} rendu(s) sur ${total} — on ne cree rien`)
      return res.status(200).json({
        ok: false, registered: false, updated: false,
        reason: `Le gestionnaire annonce ${total} webhooks mais n'en rend que ${tous.length} :`
          + " la liste est tronquee et le parametre « page » n'est pas honore par ce point d'appel."
          + ' Inscription refusee pour ne pas creer un doublon de ce qui existe peut-etre deja.',
        annonces: total, rendus: tous.length,
      })
    }

    const surCetteUrl = tous.filter(w => (w.attributes?.callback_url || w.callback_url) === callbackUrl)
    const trouve = surCetteUrl[0]
    const existant = trouve ? (trouve.id || trouve.attributes?.id) : null

    // ⚠ LES DOUBLONS DEJA PRESENTS SE COMPTENT ET SE DISENT. Constat de review :
    // `find` ne rend que le premier, donc une mise a jour laissait les autres
    // vivre — chacun livrant ses propres evenements, et gardant l'ANCIEN secret
    // apres une rotation, donc bouclant en 401.
    //
    // ⚠ J'AI ECRIT « L'ETAT PROBABLE DE LA PRODUCTION EST CELUI-LA », PUIS JE L'AI
    // MESURE, ET C'ETAIT FAUX : le compte ne porte que DEUX webhooks, un par URL,
    // aucun doublon (releve en lecture seule du 1er octobre 2026). Le raisonnement
    // — l'ancien code creait a chaque appel, donc il doit y en avoir beaucoup —
    // etait plausible et faux. Le garde-fou reste, parce qu'il coute deux lignes
    // et qu'il parle de l'avenir ; sa justification, non.
    //
    // On ne les supprime pas — ce serait une ecriture non demandee sur le compte
    // partage — mais on refuse de continuer en silence. Les retirer se fait a la
    // main, et la reponse dit lesquels.
    const autres = surCetteUrl.slice(1).map(w => w.id || w.attributes?.id).filter(Boolean)
    // ⚠ ET LES WEBHOOKS GLOBAUX QUI PORTENT LE MEME MASQUE SOUS UNE AUTRE URL.
    // Le filet que le fichier voisin a et que celui-ci n'avait pas : une barre
    // finale, un domaine propre, une URL de staging suffisent a faire manquer
    // l'egalite stricte, et un second webhook `booking;message` se cree.
    const ailleurs = tous.filter(w => {
      const url = w.attributes?.callback_url || w.callback_url
      const masque = String(w.attributes?.event_mask || w.event_mask || '')
      return url !== callbackUrl && /\bbooking\b|\bmessage\b/i.test(masque)
    }).map(w => ({ id: w.id || w.attributes?.id, url: w.attributes?.callback_url || w.callback_url }))

    // Une entree trouvee SANS identifiant exploitable tomberait sur la creation,
    // donc sur le doublon. On s'arrete plutot que de continuer.
    if (trouve && !existant) {
      console.error('[channel-webhook] webhook trouve sans identifiant exploitable')
      return res.status(200).json({
        ok: false, registered: false, updated: false,
        reason: "Un webhook existe deja sur cette URL mais son identifiant est illisible : creation refusee pour ne pas produire de doublon.",
      })
    }

    // ⚠ LE CORPS EST LE MEME DANS LES DEUX CAS, en-tetes comprises. Si le
    // gestionnaire REMPLACE l'objet au lieu de le fusionner, omettre `headers`
    // ferait perdre le secret partage — et toutes les livraisons suivantes
    // seraient rejetees en 401 par notre propre garde, plus bas dans ce fichier.
    const corpsWebhook = {
      webhook: {
        callback_url: callbackUrl,
        event_mask: MASQUE_CERTIFIE,
        property_id: null,
        is_global: true,
        is_active: true,
        send_data: true,
        headers: { 'X-Channel-Webhook-Secret': WEBHOOK_SECRET },
        // Bypass protection deploiement Vercel (Preview) : Channex ajoute ces
        // parametres GET a chaque appel pour passer le mur d'authentification.
        request_params: parametresDeRequete(callbackUrl)
      }
    }

    const reg = existant
      ? await channelCall('PUT', `/webhooks/${existant}`, corpsWebhook)
      : await channelCall('POST', '/webhooks', corpsWebhook)
    // ⚠ LA REPONSE DU PROVIDER PORTE LES EN-TETES DU WEBHOOK, donc le secret et
    // le bypass. Les relayer les exposait dans la reponse HTTP : onglet reseau,
    // historique, copier-coller d'un rapport de diagnostic. Meme constat que
    // dans `api/channel-events.js`, qui ne rend que les NOMS des en-tetes.
    // La cible effective part dans la reponse : c'est elle qui permet de voir, a
    // la lecture, qu'un appel depuis staging a enregistre un webhook de prod.
    // ⚠ MISE A JOUR ET CREATION NE RENDENT PAS LE MEME CODE. Un operateur en
    // rotation doit savoir s'il a corrige l'existant ou en cree un second.
    // ⚠ `ok` ET `registered` DANS LE SUCCES AUSSI. Constat de review : le succes
    // ne les portait pas, les echecs si. `pages/diagnostic.html` ne pouvait donc
    // pas distinguer un succes d'un echec a 200 — il peignait son badge en vert
    // sur le seul code HTTP, et l'operateur fermait la fenetre de rotation sur un
    // faux vert. Meme contrat que `api/channel-events.js`.
    return res.status(reg.ok ? (existant ? 200 : 201) : 502).json({
      ok: Boolean(reg.ok),
      registered: Boolean(reg.ok),
      updated: Boolean(existant && reg.ok),
      cible: callbackUrl,
      mis_a_jour: Boolean(existant && reg.ok),
      cree: Boolean(!existant && reg.ok),
      // ⚠ CE QUI RESTE A NETTOYER A LA MAIN, nomme. Un silence ici laisserait
      // croire la rotation terminee alors que d'autres webhooks gardent l'ancien
      // secret.
      ...(autres.length ? { doublons_sur_cette_url: autres } : {}),
      ...(ailleurs.length ? { autres_webhooks_du_meme_masque: ailleurs } : {}),
      ...(autres.length || ailleurs.length
        ? { avertissement: "D'autres webhooks portent ce masque d'evenements. Ils continuent de livrer, et garderont l'ANCIEN secret apres une rotation : retirez-les a la main dans l'interface du gestionnaire." }
        : {}),
      ...sansSecrets(reg.json),
    })
  }

  // -- Reception d'un evenement (appel entrant du channel) --
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Methode non autorisee' })
  }

  // Validation du secret partage
  const got = req.headers['x-channel-webhook-secret']
  if (!WEBHOOK_SECRET || got !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'secret invalide' })
  }

  const { event, payload } = req.body || {}
  if (!event) return res.status(400).json({ error: 'event manquant' })

  try {
    let result = { ok: true, reason: 'ignored:' + event }
    if (event === 'booking') {
      result = await handleBooking(payload)
    } else if (event === 'message') {
      result = await handleMessage(payload)
    }

    // 5xx -> Channex retente (backoff). 2xx -> traite/ignore.
    //
    // ⚠ `ambiguous_property` DOIT ETRE REJOUE, comme `db_error`. Un identifiant
    // porte par deux comptes n'est pas une donnee a jeter : on refuse de
    // l'attribuer au hasard, mais le message doit revenir jusqu'a ce que
    // l'ambiguite soit levee. Sans cette ligne, la reservation ambigue revenait
    // dans le feed (non ackee) tandis que le MESSAGE du voyageur, lui, etait
    // abandonne — deux chemins qui ne faisaient pas ce que leur commentaire disait.
    if (!result.ok && (result.reason === 'db_error' || result.reason === 'ambiguous_property')) {
      return res.status(500).json({ ok: false })
    }
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[channel-webhook]', err.message)
    try { await require('../lib/founder-notify').reportIncident('webhook_error', { threshold: 3, detail: `channel-webhook: ${err.message}` }) } catch (e) {}
    return res.status(500).json({ ok: false })   // retente
  }
}
