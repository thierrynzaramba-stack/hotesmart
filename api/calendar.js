// ⚠️ DOC : comportement documenté dans docs/kb/synchronisation.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce kb (MÊME COMMIT).
// api/calendar.js
// Gestion du calendrier tarifaire (source de verite : Supabase ; miroir : channel manager)
// GET  ?property_ids=a,b,c&start=YYYY-MM-DD&end=YYYY-MM-DD
//        -> inventory (calendar_inventory) + reservations (bookings) pour la plage
// POST { action:'save', property_id, segments:[ { params..., date_from, date_to, days:[...] } ] }
//        -> upsert Supabase PUIS push channel manager (ARI). Synchrone.

const { createClient } = require('@supabase/supabase-js')
const { canPushRates, RATE_PUSH_BLOCKED, estRelieAuCanal, CHANNEL_NOT_CONNECTED } = require('../lib/rate-sync')
const { ecrireCalendrier, expandDays, pousserAri, verdictPoussee, signalerPousseeRefusee } = require('../lib/calendrier-writer')
const { pilotParYield, refusEcritureTarifaire, datesTarifees } = require('../lib/pilote-tarifaire')

// ⚠ LA COLONNE DU LOT 4.5 NE DOIT PAS POUVOIR TUER LE CALENDRIER — releve en
// review. `pilote_tarifaire` est desormais dans les deux selects de biens. Si
// le code arrive sur Vercel AVANT que la migration soit appliquee, PostgREST
// fait echouer le SELECT ENTIER : plus de lecture, plus d'affichage, tout
// l'ecran tombe — et pas seulement l'ecriture qu'on voulait garder.
//
// L'ordre correct reste « migration d'abord, deploiement ensuite ». Mais un
// ordre est un geste humain, et un geste s'oublie : le repli relit sans la
// colonne. `piloteDuBien` rend alors 'calendrier' (son defaut), donc le
// calendrier fonctionne exactement comme avant le lot.
const COLS_BIEN = 'id, name, user_id, provider, capacity, base_price, prix_minimum, included_guests, extra_guest_fee, currency, provider_property_id, provider_room_type_id, provider_rate_plan_id, rate_sync_mode, pilote_tarifaire, inventory_units, orphan_autofix, orphan_price_enabled, orphan_price_mode, orphan_price_unit, orphan_price_value, last_fullsync_at'
const COLONNE_PILOTE = 'pilote_tarifaire, '
const sansPilote = cols => cols.replace(COLONNE_PILOTE, '')
const colonneAbsente = err =>
  !!err && /pilote_tarifaire/.test(String(err.message || ''))
function journaliserRepli (ou) {
  console.error(`[calendar] ${ou} : colonne pilote_tarifaire ABSENTE — `
    + 'migration 2026-09-18-pilote-tarifaire.sql non appliquee. '
    + 'Lecture repliee, le pilote est lu « calendrier » pour tous les biens.')
}

const { readStatus, colonneRawAbsente } = require('../lib/bookings-snapshot')
const { requirePermission, verifierSession, UUID_RE, REF_SURE_RE } = require('../lib/require-permission')
const { peutLire, peutEcrire } = require('../lib/permissions')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CHANNEL_API = process.env.CHANNEL_BASE_URL
const CHANNEL_KEY = process.env.CHANNEL_API_KEY

// Formatage YYYY-MM-DD en composantes LOCALES (jamais via toISOString/UTC).
// Evite le decalage d'un jour si le code tourne hors UTC (dev Mac/WSL GMT+2).
// `toLocalISO`, `expandDays`, la poussee ARI et le cœur d'ecriture vivent
// desormais dans lib/calendrier-writer.js : un writer, deux portes (lot 4.6.1).
async function channelCall(method, path, body, _attempt = 0) {
  const res = await fetch(`${CHANNEL_API}${path}`, {
    method,
    headers: { 'user-api-key': CHANNEL_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if ((res.status === 429 || res.status >= 500) && _attempt < 4) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10)
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * Math.pow(2, _attempt), 8000)
    await new Promise(r => setTimeout(r, waitMs))
    return channelCall(method, path, body, _attempt + 1)
  }
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}


// Plafond de la liste `property_ids`. Elle vient du client et n'en avait aucun :
// chaque identifiant coutait alors une verification de droits complete, et une
// liste forgee suffisait a faire expirer la fonction. La resolution se fait
// desormais en deux requetes quel qu'en soit le nombre — le plafond ne borne plus
// que la taille du `.in()`, d'ou une valeur large : aucun hote reel ne doit s'y
// heurter.
const MAX_BIENS = 200

module.exports = async function handler(req, res) {
  // ⚠ SESSION VERIFIEE ICI, INCONDITIONNELLEMENT. Se reposer sur la garde des
  // biens ne suffisait pas : quand aucun identifiant ne se resolvait, la garde
  // n'etait jamais atteinte et la requete repondait 200 avec un jeton invalide —
  // deux SELECT properties partaient en service key au passage, et la difference
  // entre 200 et 401 revelait l'existence d'un bien. Le userId est ensuite
  // repasse aux gardes, qui ne refont pas d'appel Auth.
  const userId = await verifierSession(req, res)
  if (!userId) return

  // Helper : charge les biens et verifie l'ownership.
  //
  // ⚠ CET ENDPOINT ECRIT DES PRIX ET DES DISPONIBILITES VERS LES OTA. Une erreur
  // de perimetre n'y coute pas une fuite de lecture mais des reservations : un
  // tarif ou une fermeture pousses sur le bien d'un autre compte.
  // Chaque bien demande passe donc par la garde, un par un — `property_ids` est
  // une LISTE fournie par le client, et il suffirait d'un identifiant etranger
  // glisse dans la liste pour que loadOwnedProperties le rejette silencieusement
  // (il filtre) sans que l'appelant soit refuse.
  async function loadOwnedProperties(uuids, compte) {
    const { data, error } = await supabase
      .from('properties')
      // ⚠ `user_id` EST OBLIGATOIRE, ET SON ABSENCE A COUTE TRES CHER.
      // `nuitsOccupees` l'exige (`provider_property_id` n'a pas d'unicite
      // globale) et LEVE sans lui. Comme l'appel est dans un `try`, l'exception
      // etait rattrapee par le repli « impossible de verifier les nuits deja
      // vendues » : TOUTES les ouvertures etaient retirees de la poussee, a
      // CHAQUE enregistrement du calendrier. Les tarifs partaient, les
      // disponibilites non.
      // C'est trait pour trait l'incident du 11 septembre 2026 — « 69 dates
      // tarifees mais invendables » — dont on avait ajoute les avertissements
      // sans jamais trouver la cause. Mesure du 12 septembre : HTTP 0 sur
      // availability, « 1 ouverture(s) non poussee(s) », sur un appel normal.
      .select(COLS_BIEN)
      .eq('user_id', compte)
      .in('id', uuids)
    if (error && colonneAbsente(error)) {
      journaliserRepli('loadOwnedProperties')
      const repli = await supabase.from('properties')
        .select(sansPilote(COLS_BIEN)).eq('user_id', compte).in('id', uuids)
      if (repli.error) throw new Error('Erreur lecture biens')
      return repli.data || []
    }
    if (error) throw new Error('Erreur lecture biens')
    return data || []
  }

  // Resout une LISTE d'identifiants (UUID ou provider_property_id) en DEUX
  // requetes au plus. Les inconnus sont ignores : un bien supprime encore
  // present dans la liste d'un client ne doit pas faire echouer le calendrier
  // entier — seul un bien EXISTANT mais etranger est un refus.
  async function resoudreListe(ids) {
    // ⚠ Un provider_property_id Channex EST un UUID. Une valeur au format UUID
    // doit donc etre cherchee dans LES DEUX colonnes, exactement comme le fait
    // resoudreBien : ne l'interroger que contre `id` rendait le calendrier blanc
    // (200, liste vide) pour un bien channel designe par sa reference canal,
    // alors que le POST sur le meme identifiant fonctionnait.
    const uuids = ids.filter(v => UUID_RE.test(v))
    const refs  = ids.filter(v => REF_SURE_RE.test(v))   // REF_SURE_RE accepte deja les UUID
    const COLS = 'id, name, user_id, provider, capacity, base_price, prix_minimum, included_guests, extra_guest_fee, currency, provider_property_id, provider_room_type_id, provider_rate_plan_id, rate_sync_mode, pilote_tarifaire, inventory_units, orphan_autofix, orphan_price_enabled, orphan_price_mode, orphan_price_unit, orphan_price_value, last_fullsync_at'
    const paquets = []
    if (uuids.length) paquets.push(supabase.from('properties').select(COLS).in('id', uuids))
    if (refs.length)  paquets.push(supabase.from('properties').select(COLS).in('provider_property_id', refs))
    let res2 = await Promise.all(paquets)
    if (res2.some(r => colonneAbsente(r.error))) {
      journaliserRepli('resoudreListe')
      const sans = []
      if (uuids.length) sans.push(supabase.from('properties').select(sansPilote(COLS)).in('id', uuids))
      if (refs.length)  sans.push(supabase.from('properties').select(sansPilote(COLS)).in('provider_property_id', refs))
      res2 = await Promise.all(sans)
    }
    const vus = new Set()
    const out = []
    for (const r of res2) {
      if (r.error) throw new Error('Erreur lecture biens')
      for (const b of (r.data || [])) { if (!vus.has(b.id)) { vus.add(b.id); out.push(b) } }
    }
    return out
  }

  // Verifie les droits sur CHAQUE bien demande et renvoie les biens RESOLUS.
  // Renvoie null si l'un d'eux est refuse — la garde a alors deja repondu.
  //
  // ⚠ UNE SEULE garde complete, puis evaluation en memoire. Une garde par
  // identifiant paraissait plus sure et etait en fait un deni de service : chaque
  // appel refait auth.getUser + properties + profiles + profile_permissions, et
  // `property_ids` est une liste client. Le contexte de droits, lui, est le meme
  // pour tous les biens d'un compte — il n'y a rien a regagner a le recharger.
  //
  // ⚠ Les identifiants resolus sont ensuite les SEULS utilises : la valeur
  // client ne doit jamais atteindre un `.eq('id', ...)`, `properties.id` etant
  // de type uuid (un propId Beds24 y fait echouer la requete entiere, pas
  // renvoyer zero ligne — c'est la regression SMS deja vecue).
  async function gardeSurBiens(ids, niveau) {
    if (ids.length > MAX_BIENS) {
      res.status(400).json({ error: `Trop de biens demandés (max ${MAX_BIENS})` })
      return null
    }
    const biens = await resoudreListe(ids)
    // Aucun identifiant connu : rien a renvoyer, donc rien a proteger. La session
    // est deja verifiee plus haut ; inutile de charger un profil pour repondre
    // une liste vide.
    if (!biens.length) return { biens: [], compte: null }

    const g = await requirePermission(req, res, {
      domaine: 'reservations', niveau, bien: biens[0].id, bienRequis: true, userId
    })
    if (!g.ok) return null

    for (const b of biens.slice(1)) {
      // Une requete ne porte que sur UN compte : un melange signale une tentative
      // de faire passer le bien d'un autre compte dans la liste.
      const cible = { id: b.id, ref: b.provider_property_id }
      const ok = String(b.user_id) === String(g.accountUserId) &&
                 (niveau === 'write' ? peutEcrire(g.contexte, 'reservations', cible)
                                     : peutLire(g.contexte, 'reservations', cible))
      if (!ok) {
        console.log('[calendar] refus : bien hors du compte ou du perimetre dans property_ids')
        res.status(403).json({ error: 'Droits insuffisants' })
        return null
      }
    }
    return { biens, compte: g.accountUserId }
  }

  // ===== GET : inventory + reservations =====
  if (req.method === 'GET') {
    const idsRaw = req.query.property_ids || ''
    const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean)
    const start = req.query.start
    const end = req.query.end
    if (!ids.length || !start || !end) {
      return res.status(400).json({ error: 'property_ids, start et end requis' })
    }

    // Droits en LECTURE sur chacun des biens demandes.
    const gardeGet = await gardeSurBiens(ids, 'read')
    if (!gardeGet) return

    const owned = gardeGet.biens
    const ownedIds = owned.map(p => p.id)
    if (!ownedIds.length) return res.status(200).json({ properties: [], inventory: {}, bookings: {} })

    // inventory
    // ⚠ LECTURE PAGINEE. INCIDENT DU 7 SEPTEMBRE 2026, second foyer.
    // Cette lecture est bornee par les dates, mais ca ne suffit pas : l'ecran
    // propose une periode « 1 an » (360 jours) et la selection de plusieurs
    // biens. Trois biens sur un an font 1080 lignes, et PostgREST en rend 1000
    // SANS ERREUR — sans `order by`, un sous-ensemble ARBITRAIRE.
    //
    // La consequence est pire que sur les reservations : une date absente de
    // `inventory` est rendue par shared/calendar-core.js comme `avail: 'open'`,
    // `stopSell: 'open'` et `rate = base`. Une nuit que l'hote a explicitement
    // fermee s'affiche donc OUVERTE, au prix de base — exactement la
    // surreservation que la garde d'a cote dit exister pour empecher.
    let invRows = []
    {
      const PAGE = 1000
      for (let de = 0; ; de += PAGE) {
        const { data, error } = await supabase
          .from('calendar_inventory')
          .select('property_id, date, rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd')
          .in('property_id', ownedIds)
          .gte('date', start)
          .lte('date', end)
          // L'ordre rend la pagination DETERMINISTE : sans lui, deux pages
          // peuvent se recouvrir et en oublier une troisieme.
          .order('property_id', { ascending: true })
          .order('date', { ascending: true })
          .range(de, de + PAGE - 1)
        if (error) {
          console.error('[calendar] inventory select error', error.message)
          return res.status(500).json({ error: 'Erreur lecture inventory' })
        }
        invRows = invRows.concat(data || [])
        if (!data || data.length < PAGE) break
      }
    }
    // structure : { property_id: { 'YYYY-MM-DD': {rate,...} } }
    const inventory = {}
    ownedIds.forEach(id => { inventory[id] = {} })
    ;(invRows || []).forEach(r => {
      inventory[r.property_id][r.date] = {
        rate: r.rate, avail: r.avail, stop_sell: r.stop_sell,
        min_stay_arrival: r.min_stay_arrival, min_stay_through: r.min_stay_through,
        max_stay: r.max_stay, cta: r.cta, ctd: r.ctd
      }
    })

    // reservations (table bookings_snapshot ; donnees dans snapshot jsonb, property_id = provider_property_id text)
    const bookings = {}
    ownedIds.forEach(id => { bookings[id] = [] })
    // map provider_property_id (text) -> id Supabase (uuid)
    const provToId = {}
    // provider du bien : defaut de lecture du statut pour les lignes anterieures
    // a l'unification (statut brut, sans champ provider dans le snapshot).
    const provToProvider = {}
    owned.forEach(p => {
      if (p.provider_property_id == null) return
      provToId[String(p.provider_property_id)] = p.id
      provToProvider[String(p.provider_property_id)] = p.provider
    })
    const provIds = Object.keys(provToId)
    if (provIds.length) {
      try {
        // ⚠ LE FILTRE DE FENETRE EST DANS LA REQUETE. INCIDENT DU 7 SEPTEMBRE 2026.
        // Cette lecture ne filtrait que par compte et par bien, et la fenetre
        // etait appliquee en JavaScript plus bas (`checkout < start || checkin > end`).
        // PostgREST plafonne un rendu a 1000 lignes : au-dela il en rend 1000
        // SANS ERREUR. Mesure du jour sur le compte fondateur : 1418 lignes
        // correspondantes, 1000 rendues, et les PLUS RECENTES absentes.
        //
        // La garde `snapErr` juste en dessous protege contre une lecture qui
        // ECHOUE. Elle ne protege pas contre une lecture qui REUSSIT tronquee —
        // laquelle produit exactement ce que son commentaire redoute : des nuits
        // vendues affichees libres, donc une surreservation, et sans le moindre
        // signal.
        //
        // Condition de chevauchement, identique a celle appliquee plus bas :
        // le sejour touche la fenetre si depart >= start ET arrivee <= end.
        // Meme forme que lib/cron-overbooking.js.
        // `metaSource` : la SOUS-origine, extraite de `raw` par chemin JSON (et
        // non la colonne entiere — le payload provider integral sur toute une
        // fenetre serait un transfert inutile). Elle distingue une saisie de
        // l'hote (`hotesmart-manual`) d'une vente du moteur public
        // (`hotesmart-engine`), toutes deux `ota_name: "Offline"` : sans elle,
        // la fiche proposerait de modifier un sejour deja PAYE par un voyageur.
        const lireReservations = (avecMeta) => supabase
          .from('bookings_snapshot')
          .select('booking_id, property_id, snapshot' + (avecMeta ? ', metaSource:raw->meta->>source' : ''))
          .eq('user_id', gardeGet.compte)
          .in('property_id', provIds)
          .gte('snapshot->>departure', start)
          .lte('snapshot->>arrival', end)

        let { data: snapRows, error: snapErr } = await lireReservations(true)

        // ⚠ LA COLONNE `raw` PEUT MANQUER — migration pas encore appliquee, ou
        // cache de schema PostgREST pas encore recharge apres l'avoir ete
        // (`colonneRawAbsente`, cf. lib/bookings-snapshot.js, qui defend deja ce
        // cas a l'ecriture). Sans ce repli, un hoquet de cache de schema faisait
        // echouer TOUTE la lecture des reservations : calendrier a 500, alors
        // que seul un confort d'interface depend de cette colonne. On relit donc
        // sans elle — la fiche retombe sur la garde SERVEUR (409
        // `reservation_moteur`), qui est de toute facon la seule qui compte.
        if (snapErr && colonneRawAbsente(snapErr)) {
          console.error('[calendar] colonne raw absente, lecture sans sous-origine — migration a appliquer')
          ;({ data: snapRows, error: snapErr } = await lireReservations(false))
        }

        // ⚠ Une erreur ici ne peut PAS etre avalee : sans reservations, le
        // calendrier s'affiche entierement LIBRE, et une simple panne transitoire
        // devient une surreservation. On echoue bruyamment.
        if (snapErr) {
          console.error('[calendar] lecture bookings_snapshot', snapErr.message)
          return res.status(500).json({ error: 'Erreur lecture reservations' })
        }
        if (snapRows) {
          snapRows.forEach(row => {
            const id = provToId[String(row.property_id)]
            if (!id) return
            const s = row.snapshot || {}
            const checkin = s.arrival || s.checkin || s.from || null
            const checkout = s.departure || s.checkout || s.to || null
            if (!checkin || !checkout) return
            // ne garder que ce qui chevauche la plage demandee
            if (checkout < start || checkin > end) return
            const name = [s.firstName, s.lastName].filter(Boolean).join(' ') || s.guest_name || 'Reservation'
            // `booking_id` : sans lui, aucune fiche de consultation n'est
            // possible cote calendrier — c'est la cle de tout le reste (lecture
            // du detail, modification et annulation d'une reservation directe).
            // `amount`, `commission` et `numAdult/numChild` : la fiche les
            // affiche ; les relire ailleurs imposerait un second appel.
            bookings[id].push({
              booking_id: String(row.booking_id),
              guest_name: name,
              checkin, checkout,
              source: (s.source || s.channel || 'direct'),
              status: readStatus(s, provToProvider[String(row.property_id)]),
              amount: s.amount ?? null,
              currency: s.currency || null,
              commission: s.commission ?? null,
              numAdult: s.numAdult ?? null,
              numChild: s.numChild ?? null,
              otaReservationCode: s.otaReservationCode || null,
              arrivalHour: s.arrivalHour || null,
              metaSource: row.metaSource || null,
              // ⚠ UN BOOLEEN, PAS L'ADRESSE. La fiche a besoin de savoir si les
              // messages peuvent partir — c'est tout. Faire transiter l'adresse
              // de chaque voyageur de la fenetre pour afficher un badge
              // exposerait bien plus que le besoin, dans une reponse qui couvre
              // des mois et tous les biens du compte.
              aEmail: !!s.guestEmail
            })
          })
        }
      } catch (e) {
        // Meme raison : un calendrier ampute de ses reservations est pire qu'une
        // erreur visible.
        console.error('[calendar] bookings_snapshot read echec:', e.message)
        return res.status(500).json({ error: 'Erreur lecture reservations' })
      }
    }

    // ⚠ L'EXISTENCE D'UNE CONVERSATION N'EST PAS CALCULEE ICI, et c'est delibere.
    // Premiere version (attrapee en review) : un `.in('booking_id', tousLesIds)`
    // sur `messages` pour toute la fenetre. Deux defauts, tous deux silencieux :
    //   1. `messages` est un JOURNAL — une ligne par message, pas par sejour.
    //      PostgREST plafonne un rendu a 1000 lignes SANS erreur : sur une boite
    //      active, les sejours au-dela du plafond revenaient « sans conversation »
    //      et la fiche grisait un bouton vers un fil qui existe. Exactement la
    //      troncature muette documentee 60 lignes plus haut pour bookings_snapshot.
    //   2. Sur « 1 an » et plusieurs biens, la liste d'identifiants depasse la
    //      longueur d'URL admise par PostgREST en GET — le meme mur qui a fait
    //      reecrire `intentionsSurFenetre` (lib/reservation-directe.js).
    // La fiche interroge donc `api/messages?booking_id=…` a son ouverture : une
    // seule reservation, une lecture indexee, un resultat exact.

    // `user_id` sert au controle de perimetre, pas au front : il ne ressort pas.
    const proprietesPubliques = owned.map(({ user_id, ...reste }) => reste)
    return res.status(200).json({ properties: proprietesPubliques, inventory, bookings })
  }

  // ===== POST : sauvegarde (Supabase puis push channel) =====
  if (req.method === 'POST') {
    const { action, property_id, segments } = req.body || {}

    // ⚠ TOUTES les actions POST de cet endpoint ecrivent : tarifs, sejour
    // minimum, disponibilites, et les poussent vers les OTA. Droit `reservations`
    // en ECRITURE sur le bien vise, avant toute chose.
    //
    // REGLE DE PARTAGE DES DOMAINES, pour ne pas la re-arbitrer a chaque lecture :
    // ce qui s'ecrit dans `calendar_inventory` et se pousse en ARI (tarif du jour,
    // dispo, sejour minimum, fullsync) releve de `reservations` — c'est le metier
    // du calendrier. Ce qui s'ecrit dans `properties` releve de `reglages` — c'est
    // la configuration du bien (prix par personne, autofix des nuits orphelines),
    // gardee ailleurs par ce meme domaine. Un membre peut donc tenir le calendrier
    // sans pouvoir reconfigurer le bien.
    const gardePost = await requirePermission(req, res, {
      domaine: 'reservations', niveau: 'write', bien: property_id, bienRequis: true, userId
    })
    if (!gardePost.ok) return
    const bienId = gardePost.bien.id
    const compte = gardePost.accountUserId

    // ===== FULL SYNC : pousse 500 jours d'inventaire en 2 appels (certif test 1) =====
    if (action === 'fullsync') {
      // ENQUEUE : le clic "Publier" met le bien en FILE. Le worker cron (*/5) execute
      // le push reel (runFullSync), 1 bien a la fois. Refus = 200 + { enqueued:false, reason }.
      if (!property_id) return res.status(400).json({ error: 'property_id requis' })
      const ownedFs = await loadOwnedProperties([bienId], compte)
      const bienFs = ownedFs[0]
      if (!bienFs) return res.status(403).json({ error: 'Bien non trouve' })
      if (!bienFs.provider_property_id || !bienFs.provider_rate_plan_id || !bienFs.provider_room_type_id) {
        return res.status(400).json({ error: 'Bien non connecte au canal (ids manquants)' })
      }
      // ⚠ LE PROVIDER D'ABORD. Un bien Beds24 en cours de migration porte les ids
      // de canal de sa propriete CIBLE mais garde sa cle Beds24 : les trois ids
      // sont presents et le full sync partirait vers Channex sur « 209413 ».
      if (!estRelieAuCanal(bienFs)) {
        return res.status(200).json({ enqueued: false, ...CHANNEL_NOT_CONNECTED })
      }
      // Garde 0 : le bien doit pouvoir pousser ses tarifs (mode 'managed'). En 'keep'
      // (defaut protecteur) on REFUSE la mise en file — aucun tarif ne part. Le bouton
      // "Publier" est deja masque en keep : ce garde couvre les appels hors UI (forge, rejeu).
      if (!canPushRates(bienFs)) {
        return res.status(200).json({ enqueued: false, ...RATE_PUSH_BLOCKED })
      }
      // Garde 1 : un full sync a-t-il deja ete EXECUTE il y a moins de 24h ?
      if (bienFs.last_fullsync_at) {
        const last = new Date(bienFs.last_fullsync_at).getTime()
        if (Date.now() - last < 24 * 3600 * 1000) {
          const nextAllowed = new Date(last + 24 * 3600 * 1000).toISOString()
          return res.status(200).json({ enqueued: false, reason: 'cooldown', message: 'Full sync deja effectue dans les dernieres 24h', next_allowed_at: nextAllowed })
        }
      }
      // Garde 2 : une entree active (pending/processing) existe-t-elle deja pour ce bien ?
      const { data: activeRows, error: activeErr } = await supabase
        .from('channel_sync_queue')
        .select('id, status')
        .eq('property_id', bienId)
        .in('status', ['pending', 'processing'])
        .limit(1)
      if (activeErr) { console.error('[calendar] queue read error', activeErr.message); return res.status(500).json({ error: 'Lecture file echouee' }) }
      if (activeRows && activeRows.length) {
        return res.status(200).json({ enqueued: false, reason: 'already_queued', message: 'Full sync deja en file pour ce bien', queue_status: activeRows[0].status })
      }
      // Insertion pending (l'index unique partiel garantit l'unicite cote base : anti-race)
      const { data: inserted, error: insErr } = await supabase
        .from('channel_sync_queue')
        .insert({ property_id: bienId })
        .select('id')
        .single()
      if (insErr) {
        if (insErr.code === '23505') {
          return res.status(200).json({ enqueued: false, reason: 'already_queued', message: 'Full sync deja en file pour ce bien' })
        }
        console.error('[calendar] enqueue error', insErr.message)
        return res.status(500).json({ error: 'Mise en file echouee' })
      }
      return res.status(200).json({ enqueued: true, queue_id: inserted.id })
    }

    if (action !== 'save') return res.status(400).json({ error: 'Action inconnue' })
    if (!property_id || !Array.isArray(segments) || !segments.length) {
      return res.status(400).json({ error: 'property_id et segments requis' })
    }

    // ownership + recup ids channel
    const owned = await loadOwnedProperties([bienId], compte)
    const bien = owned[0]
    if (!bien) return res.status(403).json({ error: 'Bien non autorise' })

    // ---- 1) Upsert Supabase (source de verite) ----
    // On materialise chaque segment en lignes par date (en respectant le filtre days).
    // ⚠ L'ETAT AVANT, LA FUSION ET L'UPSERT VIVENT DANS LE WRITER
    // (lib/calendrier-writer.js) : cette porte trie, garde, puis appelle.
    // Segments speciaux (config sur properties, pas sur calendar_inventory)
    const propUpdates = {}
    const dateSegments = []
    for (const seg of segments) {
      if (seg.kind === 'perPerson') {
        if (seg.included != null) propUpdates.included_guests = seg.included
        if (seg.extra_guest_fee != null) propUpdates.extra_guest_fee = seg.extra_guest_fee
      } else if (seg.kind === 'orphanConfig') {
        if (seg.orphan_autofix != null) propUpdates.orphan_autofix = !!seg.orphan_autofix
        if (seg.orphan_price_enabled != null) propUpdates.orphan_price_enabled = !!seg.orphan_price_enabled
        if (seg.orphan_price_mode != null) propUpdates.orphan_price_mode = seg.orphan_price_mode
        if (seg.orphan_price_unit != null) propUpdates.orphan_price_unit = seg.orphan_price_unit
        if (seg.orphan_price_value != null && seg.orphan_price_value !== '') propUpdates.orphan_price_value = parseFloat(seg.orphan_price_value)
      } else {
        dateSegments.push(seg)
      }
    }
    // ⚠ SECOND DOMAINE. Les segments perPerson / orphanConfig ne touchent pas au
    // calendrier : ils modifient la CONFIGURATION du bien (prix par personne,
    // autofix des nuits orphelines). Partout ailleurs ces reglages relevent de
    // `reglages` — channel-rateplan garde la config tarifaire avec ce domaine.
    // Sans ce controle, `reservations: write` suffisait a les changer.
    // ⚠ Le front pousse un segment perPerson des que l'onglet « Prix par
    // personne » a ete AFFICHE, meme sans modification. Exiger `reglages` sur sa
    // seule presence faisait perdre au membre ses changements de tarifs — pourtant
    // autorises — parce que le handler s'arretait avant l'upsert.
    // On ne garde donc que ce qui change REELLEMENT, et la garde ne se declenche
    // que s'il reste quelque chose a ecrire.
    // ⚠ `null` n'est PAS `0`. Comparer par Number() faisait disparaitre une mise a
    // zero d'un champ jusque-la NULL (extra_guest_fee, included_guests,
    // orphan_price_value) : la cle etait retiree, rien n'etait ecrit, et l'hote
    // voyait « enregistre » sans que sa valeur change.
    const memeValeur = (avant, apres) => {
      if (avant == null || apres == null) return avant == null && apres == null
      if (typeof avant === 'number' || typeof apres === 'number') return Number(avant) === Number(apres)
      return String(avant) === String(apres)
    }
    for (const cle of Object.keys(propUpdates)) {
      if (memeValeur(bien[cle], propUpdates[cle])) delete propUpdates[cle]
    }
    if (Object.keys(propUpdates).length) {
      const gardeReglages = await requirePermission(req, res, {
        domaine: 'reglages', niveau: 'write', bien: bienId, bienRequis: true, userId
      })
      if (!gardeReglages.ok) return
    }
    // ─── PILOTE TARIFAIRE : LE CALENDRIER N'ECRIT PAS LE PRIX D'UN BIEN
    //     PILOTE PAR YIELDFLOW ────────────────────────────────────────────
    // Spec §2 bis, arbitrage A : LA GARDE EST SERVEUR, le bandeau n'est qu'une
    // explication. L'ecran passe en consultation tarifaire pour ce bien, mais
    // une restriction d'UI n'est pas une restriction : sans ce refus,
    // « jamais deux ecrivains de prix » resterait un vœu qu'un appel direct
    // suffirait a briser.
    //
    // ⚠ ET LE REFUS PORTE SUR LE SEUL `rate`. La disponibilite et le
    // `stop_sell` restent au calendrier DANS LES DEUX MODES (arbitrage B) : un
    // refus qui engloberait le segment entier empecherait l'hote de FERMER une
    // nuit, et c'est la regression du 7 septembre. Un segment qui ne porte pas
    // de tarif passe donc normalement, meme en mode yieldflow.
    //
    // ⚠ PLACE ICI, ET PAS PLUS BAS. Le bloc suivant ecrit `propUpdates` dans
    // `properties` : refuser apres lui laisserait passer une ecriture. On
    // refuse AVANT toute ecriture, comme le prix plancher, et rien ne bouge.
    if (pilotParYield(bien)) {
      const tarifees = datesTarifees(dateSegments, expandDays)
      if (tarifees.length) {
        console.log(`[calendar] REFUS pilote yieldflow : ${tarifees.length} date(s) tarifees`)
        // Le message lisible va dans `error` : `shared/api-client.js` construit
        // son exception avec `data.error`, jamais avec `data.message`.
        return res.status(409).json({
          ...refusEcritureTarifaire(tarifees.length),
          dates: tarifees.slice(0, 20)
        })
      }
    }

    // ⚠ Un echec ici ne peut pas se solder par un 200 muet : l'hote lit
    // « enregistre » alors que la configuration du bien n'a pas bouge. Mais il ne
    // doit pas non plus faire perdre les TARIFS de la meme sauvegarde, qui sont
    // independants et deja autorises. On note l'echec, on continue, et on le
    // remonte dans les avertissements — sauf s'il n'y avait que de la config a
    // enregistrer, auquel cas il n'y a rien a sauver et c'est une vraie erreur.
    let echecConfig = null
    if (Object.keys(propUpdates).length) {
      const { error: pErr } = await supabase.from('properties').update(propUpdates).eq('id', bienId).eq('user_id', compte)
      if (pErr) {
        console.error('[calendar] properties update error', pErr.message)
        echecConfig = 'configuration du bien non enregistree'
        if (!dateSegments.length) {
          return res.status(500).json({ error: 'Enregistrement de la configuration echoue' })
        }
      }
    }

    // ─── LE CŒUR : UN WRITER, DEUX PORTES (lot 4.6.1) ─────────────────────
    // Plancher, relecture, fusion, upsert, poussee ARI, plafonnement du stock,
    // reaffirmation du stop_sell, journal des prix, verdict : tout vit dans
    // lib/calendrier-writer.js, et le canal interne du moteur appelle LA MEME
    // fonction. Cette porte n'a fait que ce qui lui revient : les droits, le
    // tri des segments, la garde du pilote tarifaire, la configuration du bien.
    const r = await ecrireCalendrier({
      supabase, bien, compte, dateSegments, origine: 'host', appel: channelCall
    })
    if (r.refus) return res.status(r.refus.status).json(r.refus.body)
    const { saved: rowsSaved, pushed, localOnly, pushFailed: pousseeRefusee, warnings: pushWarnings, taskIds: taskIdsSave } = r

    if (echecConfig) pushWarnings.push(echecConfig)

    return res.status(200).json({
      saved: rowsSaved,
      pushed,
      local_only: localOnly,
      // Drapeau LISIBLE PAR LE CODE : un texte dans `warnings` ne suffit pas, les
      // vues n'en affichent que le nombre. Sans lui, l'hote lisait
      // « Enregistre (1 avertissement) » puis voyait sa valeur revenir en place.
      config_saved: !echecConfig,
      // ⚠ DRAPEAU LISIBLE PAR LE CODE, pour la meme raison que `config_saved`.
      // Le front joint bien TOUS les avertissements — ma premiere lecture etait
      // fausse — mais il les prefixe « Enregistre — », un cadrage de SUCCES.
      // Le 11 septembre 2026 une poussee refusee se lisait donc « Enregistre »
      // alors que 69 dates restaient invendables. Sans ce drapeau, le front ne
      // peut pas distinguer « enregistre avec une remarque » de « enregistre
      // mais RIEN n'est parti au canal ».
      push_failed: pousseeRefusee,
      warnings: pushWarnings,
      task_ids: taskIdsSave
    })
  }

  return res.status(405).json({ error: 'Methode non autorisee' })
}

// ⚠ EXPORT SECONDAIRE, SANS TOUCHER AU DEFAUT : `module.exports` reste le
// handler. Ces trois fonctions vivent dans lib/calendrier-writer.js depuis le
// lot 4.6.1 ; elles restent exposees ici parce que des tests les tiennent par
// cette porte.
module.exports.pousserAri = pousserAri
module.exports.verdictPoussee = verdictPoussee
module.exports.signalerPousseeRefusee = signalerPousseeRefusee
