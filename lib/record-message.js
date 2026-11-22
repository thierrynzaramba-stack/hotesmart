// lib/record-message.js
// Helper UNIQUE d'écriture dans la table source de vérité `messages`.
// Étape 2 (double écriture) : tous les producteurs appellent recordMessage()
// EN PLUS de leur écriture existante. Aucun producteur ne dépend de son succès.
//
// CommonJS. Service key (RLS sans policy → écriture serveur uniquement).
// Client dédié léger : on NE réutilise PAS cron-shared.js (qui charge le SDK
// Anthropic), on calque sur lib/channel-availability.js.

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
// Facture voyageur, étape 2a (décision de Thierry du 10 novembre 2026) : le
// lien du formulaire de facture n'est jamais écrit en clair — voir plus bas.
const { masquerLiensFacture } = require('./factures-voyageur')

// ⚠ UN INSTANT SANS FUSEAU EST LU EN HEURE LOCALE PAR JAVASCRIPT — MESURE DU
// 14 SEPTEMBRE 2026, ET C'EST CE QUI A DUPLIQUE 83 MESSAGES DE COLOMIERS.
// Channex rend `inserted_at` SANS suffixe (« 2026-07-22T15:50:10.405 »), quand
// PostgREST rend « …+00:00 » et nos propres envois « …Z ». `new Date()` traite
// le premier comme de l'heure locale : sur une machine a Paris, deux ecritures
// du MEME message se comparaient a deux heures d'ecart, la reconciliation
// echouait, et l'import inserait un doublon. En base, les deux lignes portaient
// pourtant le meme instant a la milliseconde — le defaut etait entierement dans
// la comparaison, donc invisible en relisant les donnees.
//
// ⚠ ET C'EST EXACTEMENT CE QUI A FAIT MENTIR MON APERCU : il normalisait le
// fuseau, le code non. Un apercu qui ne calcule pas comme le code ne prevoit pas
// ce que le code va faire.
// ⚠ MEME REGLE QUE `enUTC` DANS lib/channels/channex.js, ET C'EST VOULU :
// la source rend l'instant explicite, le writer ne suppose rien de ses autres
// producteurs. Toute correction ici se reporte la-bas, et reciproquement.
function instantDe (v) {
  const brut = normaliserInstant(v)
  return brut == null ? NaN : new Date(brut).getTime()
}

function normaliserInstant (v) {
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

// Fenêtre de dédup logique pour les SORTANTS sans provider_msg_id.
// 10 min couvre deux cycles du cron */5 (réémission accidentelle), sans
// risquer de masquer un envoi légitime distinct (templates = 1 par évènement).
const OUTBOUND_DEDUP_WINDOW_MS = 10 * 60 * 1000

// Résolution best-effort de l'OTA depuis la réservation.
// L'OTA vit sur la réservation, jamais sur le message :
//  - Channex : bookings_snapshot.snapshot.source (rangé par le webhook/feed)
//  - Beds24  : non stocké → renverra null (le caller cron-classify passe l'ota)
// Race Channex (message avant snapshot) → null, backfill ultérieur. Jamais throw.
//
// ⚠ LE CLIENT SE PASSE EN ARGUMENT, ET IL A MANQUE TOUT CE TEMPS.
// Cette fonction lisait `db`, qui n'existe que dans la portee de `recordMessage` :
// chaque appel levait une ReferenceError, avalee par le catch juste en dessous,
// et `resolveOta` rendait donc TOUJOURS `null`. Le lookup ecrit precisement pour
// l'entrant Channex — le seul appelant qui ne fournit pas `ota` — n'a jamais rien
// resolu, et ces messages portent `ota = null` en base. La trace etait pourtant
// dans la sortie de tests, onze fois par execution : « resolveOta echec db is not
// defined ». Un avertissement que personne ne lit est un avertissement absent.
// Trouve en review de l'etape 4 ; le defaut est anterieur (de18a64).
async function resolveOta(db, userId, bookingId) {
  if (!userId || !bookingId) return null
  try {
    const { data } = await (db || supabase)
      .from('bookings_snapshot')
      .select('snapshot')
      .eq('user_id', userId)
      .eq('booking_id', String(bookingId))
      .maybeSingle()
    return data?.snapshot?.source || null
  } catch (e) {
    console.warn('[recordMessage] resolveOta echec', e.message)
    return null
  }
}

// Écrit un message dans `messages`. Fail-safe absolu : attrape tout, ne throw
// jamais, ne casse jamais le producteur appelant.
// Retour informatif (jamais à traiter par le caller) :
//   { ok:true, skipped:false } inséré
//   { ok:true, skipped:true, reason } ignoré (doublon)
//   { ok:false, error }         échec silencieux loggé
// ⚠ LA COLONNE `canal` PEUT MANQUER, ET L'IGNORER CASSERAIT TOUTE LA MESSAGERIE.
// Elle arrive par une migration que le product owner colle a la main dans
// l'editeur Supabase : entre le deploiement de ce code et ce geste, PostgREST
// rejette l'INSERT ENTIER (PGRST204, colonne absente du cache de schema) — donc
// plus AUCUN message enregistre, entrants compris, sans qu'aucun envoi n'echoue
// pour autant. Le fil de l'hote se viderait en silence.
//
// Meme parade que pour `bookings_snapshot.raw` : on tente avec, on retombe sans,
// et on le DIT. Le repli perd l'information de canal — pas les messages.
//
// A retirer quand la migration 2026-09-17 sera passee partout.
function colonneCanalAbsente (error) {
  if (!error) return false
  const texte = `${error.code || ''} ${error.message || ''}`.toLowerCase()
  return texte.includes('pgrst204') ||
         (texte.includes('canal') && (texte.includes('column') || texte.includes('schema cache')))
}

// Meme famille pour `origine` (migration 2026-10-12, dette 66).
function colonneOrigineAbsente (error) {
  if (!error) return false
  // ⚠ L'erreur doit NOMMER la colonne (PGRST204 la nomme) : un PGRST204 sur
  // `canal` faisait retirer `origine` d'une base qui l'avait (revue 658d758).
  const texte = `${error.code || ''} ${error.message || ''}`.toLowerCase()
  return texte.includes('origine') && (texte.includes('column') || texte.includes('schema cache'))
}

// Meme famille pour `provider_thread_id` (dette 129, migration
// 2026-11-23-demandes-fils). L'erreur doit NOMMER la colonne, comme ci-dessus.
function colonneFilAbsente (error) {
  if (!error) return false
  const texte = `${error.code || ''} ${error.message || ''}`.toLowerCase()
  return texte.includes('provider_thread_id') && (texte.includes('column') || texte.includes('schema cache'))
}

async function insererMessage (db, row) {
  let { error } = await db.from('messages').insert(row)
  if (error && row.provider_thread_id !== undefined && colonneFilAbsente(error)) {
    console.error('[recordMessage] colonne `provider_thread_id` absente, repli sans elle'
      + ' — migration 2026-11-23-demandes-fils a appliquer')
    const { provider_thread_id: _fil, ...sansFil } = row
    ;({ error } = await db.from('messages').insert(sansFil))
    row = sansFil
  }
  if (error && row.origine !== undefined && colonneOrigineAbsente(error)) {
    console.error('[recordMessage] colonne `origine` absente, repli sans elle'
      + ' — migration 2026-10-12 a appliquer')
    const { origine, ...sansOrigine } = row
    ;({ error } = await db.from('messages').insert(sansOrigine))
    row = sansOrigine
  }
  if (!error || !colonneCanalAbsente(error)) return { error }
  console.error('[recordMessage] colonne `canal` absente, repli sans elle'
    + ' — migration 2026-09-17 a appliquer')
  const { canal, ...sansCanal } = row
  return await db.from('messages').insert(sansCanal)
}

// L'ORIGINE d'un envoi (dette 66) : posee par le writer AU MOMENT DE
// L'ENVOI, jamais recalculee. Liste FERMEE — une valeur inconnue devient
// null (et se logge) plutot que de casser l'envoi, la contrainte base est
// le filet.
const ORIGINES = new Set(['ia_validee', 'ia_modifiee', 'hote', 'ia_auto'])
function origineValide (origine) {
  if (origine == null) return null
  if (ORIGINES.has(origine)) return origine
  console.warn('[recordMessage] origine inconnue ignoree :', String(origine).slice(0, 40))
  return null
}

// PWA lot 2c-2 (docs/kb/pwa.md §11.2) : « Nouveau message d'un voyageur » part
// d'ICI, le writer unique de `messages` — et seulement apres une INSERTION
// reelle d'un message de voyageur, jamais pour un doublon ni pour un echo
// reconcilie (ce sont les `return` en `skipped: true`, plus haut). Le cœur
// d'abord : webhook, import recurrent, e-mail entrant passent tous par ici.
// ⚠ NE LEVE JAMAIS, et n'emporte jamais l'ecriture : le message est deja en
// base quand on arrive ici. Le client injecte (tests, outils) est transmis.
async function apresInsertion (row, params, db) {
  if (row.direction !== 'inbound' || row.sender !== 'guest') return
  try {
    const f = (params && params.notifierMessage) ||
      require('./notifications/evenements-messages').notifierMessageVoyageur
    await f({ compte: row.user_id, propertyId: row.property_id, bookingId: row.booking_id, envoyeLe: row.sent_at, db })
  } catch (e) {
    console.error('[recordMessage] notification du message echouee', e.message)
  }
}

// ── DETTE 129 : LE FIL, SECONDE CLE DE CONVERSATION ─────────────────────────
// Une DEMANDE (fil sans reservation) n'a pas de `booking_id` : toutes les
// reconciliations ci-dessous cherchaient par reservation, donc ne jouaient
// JAMAIS pour elle — mesure du 21 novembre 2026 en production, chaque message
// d'une demande y existe en DOUBLE (copie webhook sans identifiant, copie
// import avec). Le fil (`provider_thread_id`) est la cle qui manquait.
//
// ⚠ LES DEUX CLES, PAS L'UNE A LA PLACE DE L'AUTRE. Les lignes ecrites avant ce
// lot n'ont pas de fil : chercher par le seul fil manquerait leur echo, et
// l'import qui suit le deploiement dupliquerait des fils de SEJOUR qui
// marchaient. Et une demande devenue reservation a ses premieres lignes sans
// reservation : chercher par la seule reservation manquerait celles-la. On
// prend donc l'UNION des deux recherches.
async function lignesDuMemeFil (db, row, filtrer, estCandidat = (x) => x && x.provider_msg_id == null) {
  // Dedoublonnage par `id` : une ligne trouvee par la reservation ET par le
  // fil ne compte qu'une fois. Une ligne sans `id` (double de test) est gardee
  // telle quelle — en base, `id` existe toujours.
  const vues = new Map()
  const sansId = []
  const ajouter = (data) => {
    for (const x of data || []) {
      if (!x) continue
      if (x.id == null) { sansId.push(x); continue }
      if (!vues.has(x.id)) vues.set(x.id, x)
    }
  }
  // On lit aussi le fil et l'OTA de chaque ligne, pour ne completer QUE ce qui
  // manque (review 1 du lot : le fil s'ecrivait sans condition). Colonne du
  // fil pas encore la : on relit sans elle, et on ne posera pas de fil.
  const AVEC = 'id, sent_at, provider_msg_id, booking_id, ota, provider_thread_id'
  const SANS = 'id, sent_at, provider_msg_id, booking_id, ota'
  const lire = async (cle, valeur) => {
    const requete = (colonnes) => filtrer(db.from('messages')
      .select(colonnes)
      .eq('user_id', row.user_id)
      .eq(cle, valeur))
    // Sans fil chez l'appelant (Beds24, e-mail), la colonne ne sert a rien :
    // on ne la demande pas — pas de requete en echec puis rejouee pendant la
    // fenetre « code deploye, migration pas collee » (review 2 du lot, D3).
    let { data, error } = await requete(row.provider_thread_id ? AVEC : SANS)
    if (error && colonneFilAbsente(error)) {
      // La recherche PAR le fil n'a pas de sens sans la colonne.
      if (cle === 'provider_thread_id') return []
      ;({ data, error } = await requete(SANS))
    }
    return error ? [] : (data || [])
  }
  let parResa = []
  if (row.booking_id) {
    parResa = await lire('booking_id', row.booking_id)
    ajouter(parResa)
  }
  // ⚠ COUT (review 1 du lot, §4) : la recherche par le fil ne part que si la
  // recherche par la reservation n'a rien trouve a reconcilier. Pour un sejour
  // ordinaire — l'immense majorite — elle trouve la copie, et on s'arrete la.
  // Elle reste indispensable pour une demande (pas de reservation) et pour une
  // demande devenue reservation (sa copie n'a pas de reservation).
  // ⚠ « RECONCILIABLE » SELON L'APPELANT, PAS « SANS IDENTIFIANT » (review 2
  // du lot, D1). Une copie webhook du sejour au texte identique mais a un AUTRE
  // instant faisait sauter la recherche par le fil : la copie de la demande
  // n'etait jamais trouvee, et l'import inserait un doublon. Le chemin entrant
  // passe donc son propre critere (meme instant, sans identifiant).
  const dejaUnCandidat = parResa.some(estCandidat)
  if (row.provider_thread_id && !dejaUnCandidat) {
    ajouter(await lire('provider_thread_id', row.provider_thread_id))
  }
  return [...vues.values(), ...sansId]
}

// Pose sur une ligne existante ce que la nouvelle copie sait de plus : son
// identifiant provider (reconciliation d'echo), son fil, sa reservation, son
// OTA (la copie webhook n'en a pas).
// ⚠ ON N'ECRASE RIEN : chaque champ ne se pose que si la ligne lue l'avait
// VIDE — et un champ qu'on n'a pas pu lire (colonne absente) ne se pose pas.
// ⚠ JAMAIS HORS DU COMPTE (review 1 du lot, S2) : la mise a jour filtre aussi
// sur `user_id`, quelle que soit la facon dont la ligne a ete trouvee.
// ⚠ ET LA RESERVATION SE POSE, ELLE NE S'ENLEVE PAS : une demande devenue
// reservation rejoint la conversation du sejour (spec dette 129 §1, choix par
// defaut, applique ICI en continu) ; l'inverse n'arrive jamais.
async function completerLigne (db, ligne, row, { avecId = false } = {}) {
  const maj = {}
  if (avecId && row.provider_msg_id) maj.provider_msg_id = row.provider_msg_id
  if (row.booking_id && !ligne.booking_id) maj.booking_id = row.booking_id
  if (row.ota && 'ota' in ligne && !ligne.ota) maj.ota = row.ota
  const posePlusLeFil = Boolean(row.provider_thread_id && 'provider_thread_id' in ligne && !ligne.provider_thread_id)
  if (!Object.keys(maj).length && !posePlusLeFil) return { error: null }
  const ecrire = (charge) => {
    let q = db.from('messages').update(charge)
      .eq('id', ligne.id)
      .eq('user_id', row.user_id)
    if (charge.provider_msg_id) q = q.is('provider_msg_id', null)   // course : un autre tick a pu le faire
    return q
  }
  let { error } = await ecrire(posePlusLeFil ? { ...maj, provider_thread_id: row.provider_thread_id } : maj)
  if (error && posePlusLeFil && colonneFilAbsente(error)) {
    // Sans la colonne, on garde au moins la reconciliation : c'est elle qui
    // evite le doublon.
    if (!Object.keys(maj).length) return { error: null }
    ;({ error } = await ecrire(maj))
  }
  return { error }
}

async function recordMessage(params) {
  // ⚠ LE CLIENT EST INJECTABLE, ET C EST CE QUI REND CE WRITER EPROUVABLE.
  // Il est cree au chargement du module (service key), donc un test ne pouvait
  // pas observer ses requetes : la reconciliation d echo n avait aucun test de
  // COMPORTEMENT, seulement de lecture de code. C est ce silence qui a laisse
  // passer le cas entrant, et 21 messages ont ete dupliques en production.
  // Les appelants reels ne passent rien et gardent le client du module.
  const db = (params && params.supabase) || supabase
  try {
    const {
      userId,
      provider,                 // 'beds24' | 'channex' (routage interne)
      propertyId,               // provider propId (TEXT)
      bookingId = null,
      direction,                // 'inbound' | 'outbound'
      sender,                   // 'guest' | 'host' | 'ai' | 'auto' | 'system'
      body = '',
      providerMsgId = null,
      ota = null,
      sentAt = null,
      kind = 'message',
      // ⚠ PAR OU LE MESSAGE EST SORTI, ce qui n'est PAS `provider`.
      // `provider` dit d'ou vient la RESERVATION (beds24 / channex) et commande
      // le routage interne ; `canal` dit le chemin reellement emprunte. Un envoi
      // Brevo d'une resa Channex etait enregistre « channex / Offline » : la
      // table affirmait qu'il etait passe par la messagerie du canal de vente,
      // celle-la meme qui rend 422 sur ces reservations. Constat de review.
      // Defaut 'ota' : exact pour tout l'existant, et pour tous les appelants qui
      // n'ont pas a s'en soucier.
      canal = 'ota',
      // Dette 66 : qui a ecrit ce message. null = appelant d'avant la
      // colonne (imports, entrants) — la tuile ne compte que la colonne.
      origine = null,
      // Dette 129 : le fil du message chez le provider (null hors provider a
      // fils, et pour les appelants d'avant). Cle d'une DEMANDE.
      threadId = null
    } = params || {}

    // Garde-fous minimaux (les CHECK base couvrent direction/sender, mais on
    // évite un aller-retour réseau inutile si l'appel est manifestement cassé).
    if (!userId || !provider || !propertyId || !direction || !sender) {
      console.warn('[recordMessage] params manquants', { userId, provider, propertyId, direction, sender })
      return { ok: false, error: 'missing_params' }
    }

    // OTA : si non fournie par le caller, lookup best-effort (utile surtout
    // pour l'entrant Channex qui n'a pas l'OTA sous la main).
    const resolvedOta = ota || (await resolveOta(db, userId, bookingId))

    const row = {
      user_id:         userId,
      provider,
      ota:             resolvedOta,
      property_id:     String(propertyId),
      booking_id:      bookingId != null ? String(bookingId) : null,
      provider_msg_id: providerMsgId != null ? String(providerMsgId) : null,
      direction,
      sender,
      body:            body || '',
      kind:            kind || 'message',
      canal:           canal || 'ota',
      sent_at:         sentAt || new Date().toISOString()
    }
    // ⚠ LE LIEN DE FACTURE N'ENTRE JAMAIS EN CLAIR DANS LE FIL (facture
    // voyageur, étape 2a ; décision de Thierry du 10 novembre 2026). Le lien
    // `/facture#<jeton>` est une CLÉ : il ouvre les coordonnées du voyageur et
    // permet de les réécrire. En clair dans `messages`, il était lisible par la
    // base, recopié dans `agent_tasks.source_thread` et lu par l'IA. Ce writer
    // est le SEUL de la table : l'envoi, l'écho de la synchronisation et la
    // réponse e-mail du voyageur passent tous ici. ⚠ AVANT toute comparaison
    // (déduplication, écho) : notre ligne et l'écho du provider doivent porter
    // le même texte pour se reconnaître.
    row.body = masquerLiensFacture(row.body)
    const origineSure = origineValide(origine)
    if (origineSure !== null) row.origine = origineSure
    // Pose seulement quand connu : une ligne sans fil s'ecrit comme avant, et
    // le repli « colonne absente » ne concerne que les appelants qui en ont un.
    if (threadId != null && String(threadId) !== '') row.provider_thread_id = String(threadId)

    // ── Cas 1 : message AVEC id provider (entrants) ──────────────────────────
    // Idempotence via l'index unique PARTIEL (provider, provider_msg_id) WHERE
    // provider_msg_id is not null. Cet index partiel ne peut pas etre cible par
    // ON CONFLICT en supabase-js -> SELECT-then-INSERT. L'index reste le backstop
    // atomique : en cas de course (23505), on traite comme un skip.
    if (row.provider_msg_id) {
      const chercher = (colonnes) => db
        .from('messages')
        .select(colonnes)
        .eq('provider', row.provider)
        .eq('provider_msg_id', row.provider_msg_id)
        .limit(1)
      let { data: exists, error: exErr } = await chercher('id, user_id, booking_id, ota, provider_thread_id')
      // Colonne pas encore la (migration non collee) : on relit sans elle,
      // sinon le doublon passerait pour une course (23505) a chaque relecture.
      if (exErr && colonneFilAbsente(exErr)) ({ data: exists } = await chercher('id, user_id, booking_id, ota'))
      if (exists && exists.length) {
        // Dette 129 : le meme message, relu. Il apporte peut-etre ce que la
        // ligne n'avait pas — son fil (lignes d'avant ce lot), ou la
        // reservation qu'une demande a obtenue depuis. Jamais bloquant.
        // ⚠ ET SEULEMENT S'IL MANQUE QUELQUE CHOSE : l'import relit TOUS les
        // messages d'un fil qui a bouge. Ecrire a chaque relecture ferait d'un
        // fil de cent messages cent ecritures par passage du cron, pour rien.
        const ex = exists[0]
        // ⚠ LA LIGNE D'UN AUTRE COMPTE N'EST JAMAIS COMPLETEE (review 1 du lot,
        // S2). La recherche par identifiant provider ne filtre pas le compte —
        // elle sert a reconnaitre le doublon, ce qui reste vrai quel que soit
        // le compte. Mais deux biens de deux comptes peuvent porter la meme
        // reference provider : y ecrire, c'est traverser les comptes.
        // Refus par defaut : un compte illisible n'est pas le meme compte
        // (review 2 du lot ; inatteignable aujourd'hui, `user_id` est NOT NULL).
        const memeCompte = ex.user_id != null && String(ex.user_id) === String(row.user_id)
        const filManque = row.provider_thread_id && 'provider_thread_id' in ex && !ex.provider_thread_id
        const resaManque = row.booking_id && !ex.booking_id
        if (memeCompte && (filManque || resaManque)) {
          const { error: majErr } = await completerLigne(db, ex, row)
          if (majErr) console.warn('[recordMessage] complement de ligne echoue', majErr.message)
        }
        return { ok: true, skipped: true, reason: 'duplicate_inbound' }
      }

      // ── L'ECHO DU PROVIDER ──────────────────────────────────────────────
      // ⚠ MESURE LE 11 SEPTEMBRE 2026 : un message automatique parti a 21:10
      // nous est revenu de Channex a 22:09, avec un `provider_msg_id` neuf.
      // La dedup logique ne pouvait pas le voir — sa fenetre est de 10 minutes
      // et l'echo passe par CETTE branche, qui ne compare que l'identifiant.
      // Le voyageur voyait son message deux fois dans le fil.
      //
      // On RECONCILIE au lieu de supprimer : notre ligne atteste que nous avons
      // envoye (et porte `kind = 'auto'`), l'echo apporte l'identite du message
      // chez l'OTA. Poser l'identifiant sur notre ligne garde les deux
      // informations et n'en duplique aucune. Rien n'est perdu, contrairement a
      // un simple « on ignore l'echo ».
      // ⚠ ET L'ECHO EXISTE AUSSI DANS L'AUTRE SENS — MESURE LE 14 SEPTEMBRE 2026.
      // Les messages ENTRANTS ecrits par le webhook n'ont pas de
      // `provider_msg_id` : la dedup par identifiant, juste au-dessus, ne peut
      // donc pas les reconnaitre. Le jour ou `importMessages` repasse sur le
      // meme fil — c'est tout l'objet d'un import recurrent — il les reinsere.
      // Vecu : un import de rattrapage sur Ofuro Futari a duplique 21 messages
      // du voyageur Julien Darmon, d'un coup.
      //
      // ⚠ LA CLE INCLUT `sent_at`, ET C'EST LE POINT. Julien a ecrit « Ok »
      // DEUX FOIS, a 16:57:56 et a 17:43:36. Reconcilier sur le seul texte
      // aurait fusionne deux messages reels et distincts — une perte de donnee
      // deguisee en nettoyage. L'instant du provider est ce qui les separe.
      //
      // On RECONCILIE, on ne supprime pas : la ligne d'origine reste (elle peut
      // etre referencee ailleurs) et gagne l'identifiant du provider, ce qui rend
      // tout import ULTERIEUR idempotent sur elle.
      // ⚠ ON EXIGE `sentAt` DE L'APPELANT, PAS `row.sent_at` — CORRECTIF DE REVIEW.
      // `row.sent_at` n'est JAMAIS vide : plus haut, il retombe sur notre propre
      // horloge quand le producteur n'a rien fourni. Le tester ne distinguait donc
      // pas « instant du provider » de « instant de reception », et reconcilier sur
      // notre horloge n'aurait aucun sens. Quand le provider ne dit pas quand le
      // message a ete ecrit, on ne reconcilie pas : on insere, et on le DIT.
      if (row.direction === 'inbound' && (row.booking_id || row.provider_thread_id) && sentAt) {
        // ⚠ UNE SEULE REQUETE, SANS LE FILTRE D'INSTANT, ET LA COMPARAISON SE FAIT
        // ICI. Deux raisons. D'abord `timestamptz` se serialise de plusieurs
        // facons ('…Z' / '…+00:00') : comparer des instants, pas des chaines.
        // Ensuite ca donne GRATUITEMENT le cas qui fait peur — meme texte, meme
        // reservation, instant DIFFERENT — qui est la signature exacte d'un
        // `sent_at` mal renseigne en amont, et donc d'un doublon a venir.
        // Dette 129 : par la reservation ET par le fil (`lignesDuMemeFil`), avec
        // le critere de reconciliation de CE chemin (review 2 du lot, D1).
        const instant = instantDe(row.sent_at)
        const memeInstant = (x) => instantDe(x.sent_at) === instant
        const memes = await lignesDuMemeFil(db, row, q => q
          .eq('provider', row.provider)
          .eq('direction', 'inbound')
          .eq('body', row.body)
          .order('created_at', { ascending: false })
          .limit(10), x => x && memeInstant(x) && x.provider_msg_id == null)

        const aReconcilier = (memes || []).find(x => memeInstant(x) && x.provider_msg_id == null)

        if (aReconcilier) {
          const { error: majErr } = await completerLigne(db, aReconcilier, row, { avecId: true })
          if (!majErr) return { ok: true, skipped: true, reason: 'echo_entrant_reconcilie' }
          console.warn('[recordMessage] reconciliation echo entrant echouee', majErr.message)
        } else if ((memes || []).some(x => !memeInstant(x))) {
          // ⚠ CE CRI EST LA GARDE ELLE-MEME. Mesure du 14 septembre : sur 83
          // messages de Colomiers compares un a un avec Channex, l'instant du
          // coeur et celui du provider sont identiques a la milliseconde — la
          // cle exacte est donc la bonne. Mais le jour ou un producteur cesse de
          // poser le vrai instant, la reconciliation cesserait de matcher EN
          // SILENCE et chaque import recurrent dupliquerait le fil. On ne
          // relache pas la cle sur une hypothese ; on rend l'echec visible.
          console.warn('[recordMessage] entrant identique a un instant DIFFERENT — '
            + `reconciliation impossible, doublon probable (resa ${row.booking_id || '-'}, fil ${row.provider_thread_id || '-'})`)
        }
      }

      if (row.direction === 'outbound' && (row.booking_id || row.provider_thread_id)) {
        // Dette 129 : par la reservation ET par le fil — notre reponse a une
        // DEMANDE n'a pas de reservation, et son echo ne se reconnaissait pas.
        const candidats = await lignesDuMemeFil(db, row, q => q
          .eq('direction', 'outbound')
          .eq('body', row.body)
          .is('provider_msg_id', null)
          .order('created_at', { ascending: false })
          .limit(1))
        const mien = candidats.filter(x => x.provider_msg_id == null)
        if (mien.length) {
          const { error: majErr } = await completerLigne(db, mien[0], row, { avecId: true })
          if (!majErr) return { ok: true, skipped: true, reason: 'echo_reconcilie' }
          console.warn('[recordMessage] reconciliation echo echouee', majErr.message)
        }
      }

      const { error: insErr } = await insererMessage(db, row)
      if (insErr) {
        // 23505 = violation unique (course rare entre SELECT et INSERT) :
        // l'index partiel a fait son office -> skip, pas une erreur (logs propres).
        if (insErr.code === '23505') {
          return { ok: true, skipped: true, reason: 'race_23505' }
        }
        console.error('[recordMessage] insert echec', insErr.message)
        return { ok: false, error: insErr.message }
      }
      await apresInsertion(row, params, db)
      return { ok: true, skipped: false }
    }

    // ── Cas 2 : message SANS id provider (sortants générés par nous) ─────────
    // Pas de clé d'unicité base possible → dédup logique sur une fenêtre courte,
    // cohérente avec api/channel-webhook.js (même body, même résa, non répété).
    const since = new Date(Date.now() - OUTBOUND_DEDUP_WINDOW_MS).toISOString()
    let dupQuery = db
      .from('messages')
      .select('id')
      .eq('user_id', userId)
      .eq('sender', sender)
      .eq('direction', direction)
      .eq('body', row.body)
      .gte('created_at', since)
      .limit(1)
    // ⚠ DETTE 129 : SANS RESERVATION, LE FIL SEPARE DEUX PROSPECTS. Deux
    // demandes du meme bien qui disent « Bonjour » dans la meme fenetre de
    // dix minutes se confondaient : la seconde etait jetee comme doublon.
    dupQuery = row.booking_id
      ? dupQuery.eq('booking_id', row.booking_id)
      : (row.provider_thread_id
          ? dupQuery.is('booking_id', null).eq('provider_thread_id', row.provider_thread_id)
          : dupQuery.is('booking_id', null))

    const { data: dup } = await dupQuery
    if (dup && dup.length) {
      return { ok: true, skipped: true, reason: 'duplicate_outbound' }
    }

    const { error: insErr } = await insererMessage(db, row)
    if (insErr) {
      // ⚠ 23505 = l'index unique partiel `messages_sans_msgid_fil_unique_idx`
      // (successeur de `messages_sans_msgid_unique_idx`, dette 129 : le fil est
      // dans la cle, deux prospects ne se confondent plus) a
      // tranche une course que le SELECT ci-dessus ne pouvait pas voir : les
      // deux ticks ont lu avant que l'un d'eux n'ecrive. 23 groupes de doublons
      // etaient nes de cette course avant que l'index n'existe. C'est un SKIP,
      // pas une panne — le message est bien en base, ecrit par l'autre tick.
      if (insErr.code === '23505') {
        return { ok: true, skipped: true, reason: 'race_23505_outbound' }
      }
      console.error('[recordMessage] insert echec', insErr.message)
      return { ok: false, error: insErr.message }
    }
    await apresInsertion(row, params, db)
    return { ok: true, skipped: false }

  } catch (e) {
    // Fail-safe ultime : aucune exception ne remonte au producteur.
    console.error('[recordMessage] exception', e.message)
    return { ok: false, error: e.message }
  }
}

module.exports = { recordMessage }
