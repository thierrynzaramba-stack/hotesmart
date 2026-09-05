// lib/bookings-snapshot.js
// DOC : docs/kb/bookings-snapshot.md (modif = MEME COMMIT)
// SEUL WRITER AUTORISÉ de la table `bookings_snapshot`.
//
// Pourquoi ce module (audit d'unification, écarts E3/E4/E5) : cinq writers
// écrivaient la même ligne avec des schémas différents (7 champs côté
// lib/cron-bookings.js, 12 ou 13 ailleurs) et des vocabulaires de statut
// divergents (Beds24 `black`/`inquiry` vs Channex `new`/`modified`). Résultat :
// snapshot non déterministe selon l'ordre d'exécution du cron, et ménages
// fantômes sur les statuts non reconnus par les lecteurs.
//
// Règles :
//  1. Schéma unique et complet (voir EMPTY_SNAPSHOT), `provider` TOUJOURS rempli.
//  2. Statut canonique normalisé à l'écriture (confirmed|cancelled|blocked|request).
//  3. Merge non destructif : un champ absent (undefined) du snapshot entrant ne
//     remet JAMAIS à null la valeur déjà en base. Un champ fourni à null est en
//     revanche une information ("ce provider sait qu'il n'y a pas de valeur").
//  4. Aucun appel provider ici : ce module ne fait que normaliser et persister.
//
// property_id reste TEXT = properties.provider_property_id (convention repo).
// Le pont vers properties.id (UUID) se fera via un helper dédié (chantier E6).

// ─── Statuts canoniques ──────────────────────────────────────────────────────
// Definis dans lib/bookings-snapshot-status.js (module partage avec la detection
// de changements, pour eviter un cycle d'imports). Re-exportes plus bas : les
// appelants continuent d'importer depuis ce fichier.
const {
  STATUS,
  ALL_STATUSES,
  canonicalStatus,
  readStatus,
  isActiveStatus
} = require('./bookings-snapshot-status')

// Detection neutre des changements de reservation (module sans effet de bord).
const { detectChange } = require('./booking-changes')
const { createHash } = require('crypto')

// ─── Schéma unique ───────────────────────────────────────────────────────────
const EMPTY_SNAPSHOT = {
  provider:           undefined,  // 'beds24' | 'channex' — toujours renseigné à l'écriture
  status:             undefined,  // canonique
  statusRaw:          undefined,  // statut brut provider, conservé pour debug
  arrival:            undefined,
  departure:          undefined,
  arrivalHour:        undefined,
  firstName:          undefined,
  lastName:           undefined,
  numAdult:           undefined,
  numChild:           undefined,
  source:             undefined,  // plateforme d'origine (airbnb, booking, direct…)
  otaReservationCode: undefined,  // référence OTA — clé de rattachement des avis voyageurs
  amount:             undefined,  // total facture au VOYAGEUR, jamais le net hote
  commission:         undefined,  // commission OTA, stockee a part (cf. fromBeds24)
  currency:           undefined
}
const SNAPSHOT_FIELDS = Object.keys(EMPTY_SNAPSHOT)

// ─── Mappers provider -> schéma unique ───────────────────────────────────────
// Un champ que le provider ne sait pas fournir est laissé `undefined` (et non
// null) : le merge le préservera au lieu de l'écraser.

// ⚠ LE MONTANT EST `price`, PAS LA SOMME DES invoiceItems.
// Le commentaire precedent affirmait « amount non fourni sur cet endpoint » :
// c'etait faux, et `amount` etait donc vide sur 0/1413 lignes Beds24 mesurees,
// contre 18/18 cote Channex. Un module revenus ou yield aurait lu zero pour tout
// un provider sans qu'aucune erreur ne se declenche.
//
// `price` et `commission` sont servis a 100 %, avec ou sans includeInvoiceItems.
//
// La somme des invoiceItems, elle, N'EST PAS HOMOGENE — sa semantique depend du
// canal (mesure sur les 1231 reservations facturees du bien 209413) :
//   airbnb  846/846 : somme(charge) = price - commission  -> net HOTE
//   booking 253/253 : somme(charge) = price               -> total VOYAGEUR
//   direct  132     : commission nulle, les deux se confondent
// La retenir donnerait un champ valant un net sur un canal et un brut sur
// l'autre : ~19 % d'ecart systematique entre Airbnb et Booking, invisible a la
// lecture. `price` est la seule grandeur de meme sens partout.
//
// Repli : uniquement sur une SAISIE DIRECTE sans commission. La condition porte
// sur la source ET sur la commission, pas sur la seule commission : une
// reservation OTA dont Beds24 remet price et commission a 0 tout en conservant la
// ligne de payout ferait sinon entrer un net hote dans un champ « total voyageur »
// — l'ecart de ~19 % que tout ce bloc cherche a empecher. Aucun cas de cette forme
// dans les 1413 reservations mesurees (les 5 replis observes sont tous `direct`),
// mais l'invariant doit tenir sans dependre des donnees du jour.
function totalCharges(booking) {
  return (booking.invoiceItems || [])
    .filter(i => i.type === 'charge')
    .reduce((somme, i) => somme + (Number(i.lineTotal) || 0), 0)
}

// Meme regle de source que le champ `source` du snapshot.
function estSaisieDirecte(b) {
  const source = String(b.channel || b.apiSource || b.referer || 'direct').toLowerCase()
  return source === 'direct'
}

// Rien d'exploitable -> `undefined`, PAS `null`. Beds24 ne distingue pas « sejour
// gratuit » de « montant non renseigne » : price vaut 0 dans les deux cas (189
// lignes sur 1413, dont 109 annulees). Rendre null affirmerait « ce provider sait
// qu'il n'y a pas de valeur » et effacerait a chaque cycle un montant deja en
// base. `undefined` laisse le merge non destructif faire son travail.
function montantBeds24(b) {
  if (Number(b.price) > 0) return Number(b.price)
  if (estSaisieDirecte(b) && !Number(b.commission)) {
    const charges = totalCharges(b)
    if (charges > 0) return charges
  }
  return undefined
}

function fromBeds24(booking) {
  const b = booking || {}
  return {
    provider:           'beds24',
    status:             canonicalStatus(b.status, 'beds24'),
    statusRaw:          b.status || null,
    arrival:            b.arrival || null,
    departure:          b.departure || null,
    arrivalHour:        undefined,                 // non fourni par l'API v2 bookings
    firstName:          b.firstName || '',
    lastName:           b.lastName || '',
    numAdult:           b.numAdult ?? null,
    numChild:           b.numChild ?? null,
    source:             b.channel || b.apiSource || b.referer || 'direct',
    otaReservationCode: b.apiReference || null,
    amount:             montantBeds24(b),
    commission:         Number(b.commission) > 0 ? Number(b.commission) : undefined,
    currency:           undefined                  // reellement non servi par cet endpoint
  }
}

// Channex sert les montants en CHAINES ('82.21'), Beds24 en nombres (160). Sans
// conversion, `amount` porterait deux types selon le provider et un cumul
// (`total += snapshot.amount`) donnerait une concatenation ou un NaN selon l'ordre
// des lignes — sur le champ meme dont on promet qu'il est « la seule grandeur de
// meme sens partout ». `undefined` quand il n'y a rien, comme cote Beds24, pour
// que le merge preserve l'existant au lieu de l'effacer.
function nombreOuRien(valeur) {
  const n = Number(valeur)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// Couvre indifféremment une réservation Channex (GET reservations) et une
// booking_revision (webhook / feed) : mêmes noms de champs côté Channex.
function fromChannex(booking) {
  const b = booking || {}
  const occ = b.occupancy || {}
  const customer = b.customer || {}
  return {
    provider:           'channex',
    status:             canonicalStatus(b.status, 'channex'),
    statusRaw:          b.status || null,
    arrival:            b.arrival_date || null,
    departure:          b.departure_date || null,
    arrivalHour:        b.arrival_hour || null,
    firstName:          customer.name || '',
    lastName:           customer.surname || '',
    numAdult:           occ.adults || null,
    numChild:           occ.children || null,
    source:             b.ota_name || 'direct',
    otaReservationCode: b.ota_reservation_code || null,
    amount:             nombreOuRien(b.amount),        // Channex sert deja le total voyageur
    commission:         nombreOuRien(b.ota_commission),
    currency:           b.currency || null
  }
}

const MAPPERS = { beds24: fromBeds24, channex: fromChannex }

function mapBooking(provider, booking) {
  const fn = MAPPERS[String(provider || '').toLowerCase()]
  if (!fn) throw new Error(`[bookings-snapshot] provider inconnu: ${provider}`)
  return fn(booking)
}

// ─── Comparaison stable (insensible a l'ordre des cles) ──────────────────────
// ⚠ POSTGRES JSONB NE CONSERVE PAS L'ORDRE DES CLES.
// Verifie sur la base : le mapper produit
//   provider, status, statusRaw, arrival, departure, ...
// et la meme ligne relue rend
//   amount, source, status, arrival, currency, ...
// (jsonb trie par longueur de cle puis alphabetiquement).
//
// La comparaison du snapshot y echappait par accident : `merged` derive de
// `previous` par spread, donc les deux portent l'ordre de la base. Le `raw`, lui,
// arrive du provider et se compare a un jsonb relu : un JSON.stringify naif les
// declarerait TOUJOURS differents, et chaque cycle reecrirait toutes les lignes
// pour rien — exactement ce que la garde « ligne inchangee » a ferme.
//
// On trie donc les cles recursivement avant de comparer.
//
// ⚠ CETTE FONCTION GARDE L'ORDRE DES TABLEAUX ; `canoniqueStringify` (plus bas)
// ne le garde PAS. Les deux coexistent volontairement et n'ont pas le meme role :
//   - `stableStringify` / `memeContenu` : comparaison STRICTE, utilisee pour le
//     snapshot normalise (qui ne contient aucun tableau).
//   - `canoniqueStringify` / `empreinte`   : comparaison du PAYLOAD BRUT, ou
//     l'ordre des tableaux n'est pas fiable — l'API Channex rend
//     `days_breakdown` dans un ordre different a chaque appel. Voir la note
//     detaillee sur `empreinte`.
//
// ⚠ DEUX LIMITES CONNUES, sans consequence sur l'usage prevu mais a garder en tete :
//  - `undefined` est rendu comme `'null'` (JSON.stringify(undefined) vaut undefined) :
//    la fonction ne distingue donc pas « absent » de « null ». C'est pourquoi les
//    appelants normalisent `existingRaw` a `null` avant de comparer, et pourquoi
//    `empreinte(undefined)` rend `null` plutot qu'une empreinte de 'null'.
//  - un objet a cles non enumerables (une Date, une instance de classe) rend `'{}'`,
//    donc deux valeurs distinctes se compareraient egales. Sans risque ici : `raw`
//    vient toujours d'un JSON (reponse provider ou jsonb relu), jamais d'objets vifs.
function stableStringify(valeur) {
  if (valeur === null || typeof valeur !== 'object') return JSON.stringify(valeur) ?? 'null'
  if (Array.isArray(valeur)) return '[' + valeur.map(stableStringify).join(',') + ']'
  const cles = Object.keys(valeur).sort()
  return '{' + cles.map(k => JSON.stringify(k) + ':' + stableStringify(valeur[k])).join(',') + '}'
}

// ─── Empreinte du payload brut ───────────────────────────────────────────────
// Le writer doit savoir si le `raw` a bouge, sans le rapatrier. Relire la colonne
// a chaque cycle coutait jusqu'a 1,2 Mo par requete cote Channex (200 lignes de
// ~6 Ko) et ~350 Ko cote Beds24, toutes les 5 minutes, pour une simple egalite.
// L'empreinte tient en 64 caracteres et se compare aussi bien.
//
// ⚠ L'EMPREINTE IGNORE L'ORDRE DES TABLEAUX, contrairement a stableStringify.
// Mesure sur l'API Channex : deux appels consecutifs au MEME endpoint rendent
// `rooms[].meta.days_breakdown` dans un ordre different (3 reservations sur 18).
//   appel 1 : 2026-07-22, 2026-07-23, 2026-07-24
//   appel 2 : 2026-07-24, 2026-07-22, 2026-07-23
// Meme contenu, ordre aleatoire. Avec une empreinte sensible a l'ordre, ces
// lignes se reecrivaient a CHAQUE passage, indefiniment — le backfill n'etait pas
// idempotent et le cron aurait fait de meme toutes les 5 minutes.
//
// L'ordre d'un tableau rendu par une API n'est donc pas une donnee fiable : on le
// neutralise pour DECIDER s'il faut ecrire.
//
// ⚠ Consequence a assumer : quand l'empreinte correspond, l'UPDATE est saute, donc
// le `raw` en base garde l'ordre du PREMIER payload ecrit, pas du dernier recu.
// C'est sans importance ici — cet ordre est justement celui dont on vient de
// montrer qu'il ne veut rien dire. Le contenu, lui, est bien a jour : toute
// difference reelle change l'empreinte et declenche la reecriture.
function canoniqueStringify(valeur) {
  if (valeur === null || typeof valeur !== 'object') return JSON.stringify(valeur) ?? 'null'
  if (Array.isArray(valeur)) return '[' + valeur.map(canoniqueStringify).sort().join(',') + ']'
  const cles = Object.keys(valeur).sort()
  return '{' + cles.map(k => JSON.stringify(k) + ':' + canoniqueStringify(valeur[k])).join(',') + '}'
}

function empreinte(valeur) {
  if (valeur === undefined || valeur === null) return null
  return createHash('sha256').update(canoniqueStringify(valeur)).digest('hex')
}

// La colonne `raw` peut manquer : migration pas encore appliquee, ou cache de
// schema PostgREST pas encore recharge juste apres l'avoir ete. PostgREST rend
// alors PGRST204. On teste aussi le message, les codes ayant deja bouge.
function colonneRawAbsente(error) {
  if (!error) return false
  const texte = `${error.code || ''} ${error.message || ''}`.toLowerCase()
  return texte.includes('pgrst204') ||
         (texte.includes('raw') && (texte.includes('column') || texte.includes('schema cache')))
}

function memeContenu(a, b) {
  return stableStringify(a) === stableStringify(b)
}

// ─── Merge non destructif ────────────────────────────────────────────────────
// `undefined` = non fourni -> on garde l'existant. Tout le reste (y compris null)
// écrase. Les champs hors schéma déjà présents en base sont conservés.
function mergeSnapshot(previous, incoming) {
  const out = { ...(previous || {}) }
  for (const key of SNAPSHOT_FIELDS) {
    const value = (incoming || {})[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

// ─── Journal des changements ─────────────────────────────────────────────────
// Une ligne par changement detecte, consommee ensuite par
// lib/booking-changes-dispatch.js. Fail-safe : si la table n'existe pas encore
// (migration non appliquee) ou si l'insert echoue, on log et on continue — le
// snapshot doit etre ecrit quoi qu'il arrive.
// `initialImport` : import initial d'un bien (activation d'un canal). Les
// evenements sont ecrits DEJA marques traites — la file materialise l'historique
// sans rien distribuer. Sans cela, activer un bien Channex envoie un message de
// bienvenue a chaque reservation a venir deja prise il y a des mois, et inonde
// la PWA prestataire. La garde d'anciennete ne couvre que le passe.
async function recordChangeEvent(supabase, { userId, bookingId, propertyId, provider, change, initialImport }) {
  try {
    const { error } = await supabase.from('booking_change_events').insert({
      user_id:     userId,
      booking_id:  String(bookingId),
      property_id: String(propertyId),
      provider,
      type:        change.type,
      changes:     change.changes,
      processed_at:      initialImport ? new Date().toISOString() : null,
      processing_errors: initialImport ? [{ consommateur: 'import_initial', erreur: 'materialise sans distribution' }] : null
    })
    if (error) console.error('[bookings-snapshot] booking_change_events insert echec', error.message)
    return !error
  } catch (e) {
    console.error('[bookings-snapshot] booking_change_events exception', e.message)
    return false
  }
}

// ─── Écriture ────────────────────────────────────────────────────────────────
// supabase : client service-key fourni par l'appelant (aucun client créé ici,
// pour rester testable et sans dépendance croisée entre /api et /lib).
// existing : snapshot déjà lu par l'appelant (évite une seconde lecture).
// Fail-safe : ne throw jamais, renvoie { ok:false, reason }.
async function saveBookingSnapshot(supabase, { userId, bookingId, propertyId, provider, booking, snapshot, existing, existingPropertyId, existingRawHash, budgetRaw, initialImport } = {}) {
  try {
    if (!userId || !bookingId || !propertyId) {
      return { ok: false, reason: 'missing_keys' }
    }

    const incoming = snapshot || mapBooking(provider, booking)
    if (!incoming.provider) incoming.provider = String(provider || '').toLowerCase() || null

    // Payload provider integral (spec §4). `undefined` = l'appelant n'en fournit
    // pas (il a mappe lui-meme sans transmettre la source) : on ne touche pas a la
    // colonne, on n'ecrase jamais un raw connu par du vide.
    const rawEntrant = booking === undefined ? undefined : booking

    let previous = existing
    let previousPropertyId = existingPropertyId
    let previousRawHash = existingRawHash ?? null
    if (previous === undefined) {
      const { data } = await supabase
        .from('bookings_snapshot')
        .select('snapshot, property_id, raw_hash')
        .eq('user_id', userId)
        .eq('booking_id', String(bookingId))
        .maybeSingle()
      previous = data?.snapshot || null
      previousPropertyId = data?.property_id
      previousRawHash = data?.raw_hash ?? null
    }

    const merged = mergeSnapshot(previous, incoming)

    // Ligne strictement inchangee : ni ecriture, ni evenement.
    //
    // Le cron repassait sur TOUTES les reservations de chaque bien a chaque cycle
    // (~90 par bien, un upsert chacune, en serie) : c'est ce qui faisait durer
    // l'etape `classify` 9 a 17 s par bien et amenait le cycle a 40-56 s pour un
    // plafond de 60 s. Sur un cycle nominal ou rien ne bouge, il n'y a
    // strictement rien a ecrire.
    //
    // La comparaison porte sur le snapshot FUSIONNE : un mapper qui n'apporte
    // aucune valeur nouvelle produit un merged identique a l'existant. Aucun
    // changement ne peut etre manque, puisque detectChange compare les deux memes
    // objets — s'ils sont identiques, il n'y a par definition rien a signaler.
    //
    // ⚠ property_id N'EST PAS dans le snapshot, mais c'est bien une colonne de la
    // ligne, et la contrainte porte sur (user_id, booking_id) : une reservation
    // deplacee vers un autre bien garde des dates, un statut et un voyageur
    // identiques. Comparer le seul snapshot laisserait la ligne accrochee a
    // l'ancien bien pour toujours — fantome sur l'ancien, invisible sur le
    // nouveau, car les lecteurs filtrent sur property_id. On ne saute donc que si
    // le property_id en base est CONNU et deja le bon ; s'il est inconnu
    // (l'appelant a fourni `existing` sans lui), on ecrit, par prudence.
    const memePropriete = previousPropertyId !== undefined &&
                          String(previousPropertyId) === String(propertyId)
    if (previous && memePropriete && memeContenu(merged, previous)) {
      // Contenu NORMALISE inchange : aucun evenement, quoi qu'il arrive au raw.
      // C'est la regle gravee (spec §4) : « un evenement si et seulement si
      // merged change ; le raw est stocke, jamais compare ».
      //
      // Le payload provider a pu bouger sans qu'aucun des 14 champs ne change
      // (une ligne de facture ajoutee, un modifiedTime, un champ OTA interne).
      // On rafraichit alors le raw SEUL, par un UPDATE cible qui NE TOUCHE PAS
      // `updated_at` : cette colonne signifie « dernier changement de contenu
      // normalise », et tout le reste du produit la lit ainsi (surveillance de
      // cycle, tri des lecteurs, diagnostic). Un upsert la reecrirait.
      //
      // La comparaison porte sur l'EMPREINTE, pas sur le payload : relire le raw
      // a chaque cycle couterait jusqu'a 1,2 Mo par requete cote Channex, pour
      // une simple egalite.
      const hashEntrant = empreinte(rawEntrant)
      if (rawEntrant !== undefined && hashEntrant !== previousRawHash) {
        // Budget de rafraichissements : ces UPDATE sont SEQUENTIELS et vivent
        // dans le cron */5. Au premier cycle apres la migration, toutes les lignes
        // ont un raw vide — jusqu'a 500 par bien via cron-classify — et autant
        // d'allers-retours feraient depasser le plafond de 60 s de la fonction
        // Vercel, coupant le cycle avant les codes d'acces et les messages.
        // On en fait donc un nombre borne par appel : le remplissage s'etale sur
        // quelques cycles, sans rien perdre et sans jamais mettre le cron en peril.
        if (budgetRaw && budgetRaw.restant <= 0) {
          return { ok: true, snapshot: merged, previous, change: null, inchange: true, rawDiffere: true }
        }
        if (budgetRaw) budgetRaw.restant--

        const { error } = await supabase
          .from('bookings_snapshot')
          .update({ raw: rawEntrant, raw_hash: hashEntrant })
          .eq('user_id', userId)
          .eq('booking_id', String(bookingId))
        if (error) {
          // Le raw est un enrichissement : son echec ne doit pas faire echouer un
          // cycle dont le contenu normalise est deja a jour. On le dit et on passe.
          console.error('[bookings-snapshot] maj raw echec', bookingId, error.message)
          return { ok: true, snapshot: merged, previous, change: null, inchange: true, rawEchec: true }
        }
        return { ok: true, snapshot: merged, previous, change: null, inchange: true, rawMisAJour: true }
      }
      return { ok: true, snapshot: merged, previous, change: null, inchange: true }
    }

    // Detection du changement AVANT l'upsert : c'est le seul instant ou l'etat
    // precedent et l'etat entrant coexistent. Le snapshot reste l'unique memoire
    // d'etat ; l'evenement produit est consomme plus tard par le dispatcher.
    // Fail-safe absolu : une detection en echec ne doit jamais empecher
    // l'ecriture du snapshot (la synchro des reservations prime).
    let change = null
    try {
      change = detectChange(previous, merged, provider)
    } catch (e) {
      console.error('[bookings-snapshot] detectChange exception', e.message)
    }

    // ⚠ ORDRE CRITIQUE : le changement est journalise AVANT l'upsert.
    // Le snapshot est la seule memoire d'etat : une fois avance, le changement
    // n'est plus detectable. Journaliser apres signifierait qu'un insert en
    // echec (migration pas encore appliquee, coupure reseau) perd le changement
    // DEFINITIVEMENT et en silence — plus jamais de notification menage, de
    // message de bienvenue ni d'annulation de code pour cette reservation.
    // Dans l'ordre inverse, un upsert en echec laisse au pire un evenement en
    // double au cycle suivant : du bruit, pas une perte.
    if (change) {
      const journalise = await recordChangeEvent(supabase, {
        userId,
        bookingId,
        propertyId,
        provider: merged.provider || provider || null,
        change,
        initialImport
      })
      if (!journalise) {
        // On n'avance PAS le snapshot : le changement sera redetecte au prochain
        // cycle, quand la table sera disponible.
        console.error('[bookings-snapshot] changement non journalise, snapshot non avance', bookingId)
        return { ok: false, reason: 'change_not_recorded', snapshot: merged, previous, change }
      }
    }

    // `raw` n'est pose que si l'appelant l'a fourni : une cle absente de l'objet
    // upserte laisse la colonne intacte cote Postgres (ON CONFLICT DO UPDATE SET
    // ne touche que les colonnes citees). Un appelant qui mappe lui-meme sans
    // transmettre la source ne peut donc pas effacer un raw deja conserve.
    const ligne = {
      user_id:     userId,
      booking_id:  String(bookingId),
      property_id: String(propertyId),
      snapshot:    merged,
      updated_at:  new Date().toISOString()
    }
    if (rawEntrant !== undefined) {
      ligne.raw = rawEntrant
      ligne.raw_hash = empreinte(rawEntrant)
    }

    let { error } = await supabase
      .from('bookings_snapshot')
      .upsert(ligne, { onConflict: 'user_id,booking_id' })

    // ⚠ REPLI SI LA COLONNE `raw` MANQUE — sinon le trou est bien pire qu'un
    // upsert rate. L'evenement est journalise AVANT l'upsert (voir plus haut) et
    // le snapshot n'est pas avance : un echec PERMANENT (migration pas encore
    // appliquee, cache de schema PostgREST pas encore recharge apres l'avoir ete)
    // ferait redetecter le meme changement a CHAQUE cycle */5, et le dispatcher
    // renverrait indefiniment message de bienvenue, menage et code d'acces.
    // Le commentaire de l'ordre d'ecriture suppose un echec transitoire ; ici il
    // ne l'est pas. On reessaie donc sans le payload brut : le contenu normalise
    // passe, l'evenement est consomme une fois, et seul l'enrichissement attend.
    if (error && colonneRawAbsente(error)) {
      console.error('[bookings-snapshot] colonne raw absente, repli sans payload brut — migration a appliquer')
      delete ligne.raw
      delete ligne.raw_hash
      ;({ error } = await supabase
        .from('bookings_snapshot')
        .upsert(ligne, { onConflict: 'user_id,booking_id' }))
    }

    if (error) {
      console.error('[bookings-snapshot] upsert echec', bookingId, error.message)
      return { ok: false, reason: 'db_error', error: error.message }
    }

    return { ok: true, snapshot: merged, previous, change }
  } catch (e) {
    console.error('[bookings-snapshot] exception', e.message)
    return { ok: false, reason: 'exception', error: e.message }
  }
}

// Écriture d'un LOT de réservations d'un même bien.
// Les boucles d'import (cron Beds24, activation d'un canal) appelaient
// saveBookingSnapshot par booking : le writer relisait alors la ligne une par une,
// soit 2N allers-retours Supabase. Ici la relecture se fait en UN select par lot,
// le merge non destructif étant inchangé. Le pré-chargement reste dans le writer
// pour qu'aucun appelant n'ait à le réimplémenter.
// Fail-safe : ne throw jamais, renvoie le compte des écritures.
const SELECT_CHUNK = 200

// Rafraichissements de `raw` autorises par appel. Ces UPDATE sont sequentiels et
// vivent dans le cron */5 : au premier cycle apres la migration toutes les lignes
// ont un raw vide, et cron-classify peut en presenter jusqu'a 500 par bien. Les
// faire toutes d'un coup depasserait le plafond de 60 s de la fonction Vercel et
// couperait le cycle avant les codes d'acces et les messages. Le remplissage
// s'etale donc sur quelques cycles — rien n'est perdu, seulement differe.
const RAW_PAR_CYCLE = 60

async function saveBookingSnapshots(supabase, { userId, propertyId, provider, bookings, initialImport, budgetRaw } = {}) {
  const out = { saved: 0, failed: 0, inchanges: 0, rawMisAJour: 0, rawEchecs: 0, rawDifferes: 0, results: [] }
  try {
    const list = (bookings || []).filter(b => b && b.id)
    if (!userId || !propertyId || !list.length) return out

    // Budget partage par tout le lot (l'appelant peut en fournir un commun a
    // plusieurs biens pour borner le cycle entier).
    const budget = budgetRaw || { restant: RAW_PAR_CYCLE }

    // Relecture groupée des snapshots existants (par tranches, pour ne pas
    // construire un IN(...) sans limite).
    const existingByBooking = {}
    const propIdByBooking = {}
    const rawHashByBooking = {}
    const ids = list.map(b => String(b.id))
    for (let i = 0; i < ids.length; i += SELECT_CHUNK) {
      const chunk = ids.slice(i, i + SELECT_CHUNK)
      // On relit l'EMPREINTE du payload, jamais le payload : rapatrier `raw` a
      // chaque cycle couterait jusqu'a 1,2 Mo par requete cote Channex (200 x 6 Ko)
      // et ~350 Ko cote Beds24, toutes les 5 minutes, pour une simple egalite.
      const { data, error } = await supabase
        .from('bookings_snapshot')
        .select('booking_id, snapshot, property_id, raw_hash')
        .eq('user_id', userId)
        .in('booking_id', chunk)
      if (error) {
        // Lecture impossible : on retombe sur la relecture unitaire du writer
        // (plus lente mais correcte) plutôt que d'écraser à l'aveugle.
        console.error('[bookings-snapshot] prefetch echec', error.message)
        return await saveEachWithoutPrefetch(supabase, { userId, propertyId, provider, list, out, initialImport, budget })
      }
      ;(data || []).forEach(r => {
        existingByBooking[String(r.booking_id)] = r.snapshot || null
        propIdByBooking[String(r.booking_id)] = r.property_id
        rawHashByBooking[String(r.booking_id)] = r.raw_hash ?? null
      })
    }

    for (const b of list) {
      const r = await saveBookingSnapshot(supabase, {
        userId,
        bookingId:  b.id,
        propertyId,
        provider,
        booking:    b,
        existing:   existingByBooking[String(b.id)] ?? null,
        existingPropertyId: propIdByBooking[String(b.id)],
        existingRawHash:    rawHashByBooking[String(b.id)] ?? null,
        budgetRaw:  budget,
        initialImport
      })
      out.results.push(r)
      if (r.rawMisAJour) out.rawMisAJour++
      if (r.rawEchec) out.rawEchecs++
      if (r.rawDiffere) out.rawDifferes++
      if (r.inchange) out.inchanges++
      else if (r.ok) out.saved++
      else out.failed++
    }
    if (out.inchanges) console.log(`[bookings-snapshot] ${out.inchanges}/${list.length} inchangees, non reecrites`)
    if (out.rawMisAJour) console.log(`[bookings-snapshot] ${out.rawMisAJour} raw rafraichis sans evenement`)
    // Un echec systematique (droit manquant, colonne absente) doit sauter aux yeux
    // dans le resume de cycle : sans cette ligne, tout paraissait sain — « N
    // inchangees, non reecrites » — pendant que `raw` restait vide indefiniment.
    if (out.rawEchecs) console.error(`[bookings-snapshot] ⚠ ${out.rawEchecs}/${list.length} maj de raw EN ECHEC`)
    if (out.rawDifferes) console.log(`[bookings-snapshot] ${out.rawDifferes} raw differes (budget du cycle atteint), reprise au cycle suivant`)
    return out
  } catch (e) {
    console.error('[bookings-snapshot] saveBookingSnapshots exception', e.message)
    return out
  }
}

// Repli quand la relecture groupée échoue : chaque appel relit sa propre ligne.
async function saveEachWithoutPrefetch(supabase, { userId, propertyId, provider, list, out, initialImport, budget }) {
  for (const b of list) {
    const r = await saveBookingSnapshot(supabase, {
      userId, bookingId: b.id, propertyId, provider, booking: b, initialImport,
      budgetRaw: budget
    })
    out.results.push(r)
    // Meme comptage que le chemin nominal : sinon les compteurs rendus au cron
    // ne veulent pas dire la meme chose selon le chemin emprunte.
    if (r.rawMisAJour) out.rawMisAJour++
    if (r.rawEchec) out.rawEchecs++
    if (r.rawDiffere) out.rawDifferes++
    if (r.inchange) out.inchanges++
    else if (r.ok) out.saved++
    else out.failed++
  }
  return out
}

module.exports = {
  STATUS,
  ALL_STATUSES,
  EMPTY_SNAPSHOT,
  SNAPSHOT_FIELDS,
  canonicalStatus,
  readStatus,
  isActiveStatus,
  fromBeds24,
  fromChannex,
  montantBeds24,
  totalCharges,
  nombreOuRien,
  mapBooking,
  mergeSnapshot,
  stableStringify,
  canoniqueStringify,
  memeContenu,
  empreinte,
  colonneRawAbsente,
  RAW_PAR_CYCLE,
  saveBookingSnapshot,
  saveBookingSnapshots,
  recordChangeEvent
}
