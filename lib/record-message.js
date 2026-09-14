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
function instantDe (v) {
  if (!v) return NaN
  const s = String(v)
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + 'Z').getTime()
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
async function resolveOta(userId, bookingId) {
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
      kind = 'message'
    } = params || {}

    // Garde-fous minimaux (les CHECK base couvrent direction/sender, mais on
    // évite un aller-retour réseau inutile si l'appel est manifestement cassé).
    if (!userId || !provider || !propertyId || !direction || !sender) {
      console.warn('[recordMessage] params manquants', { userId, provider, propertyId, direction, sender })
      return { ok: false, error: 'missing_params' }
    }

    // OTA : si non fournie par le caller, lookup best-effort (utile surtout
    // pour l'entrant Channex qui n'a pas l'OTA sous la main).
    const resolvedOta = ota || (await resolveOta(userId, bookingId))

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
      sent_at:         sentAt || new Date().toISOString()
    }

    // ── Cas 1 : message AVEC id provider (entrants) ──────────────────────────
    // Idempotence via l'index unique PARTIEL (provider, provider_msg_id) WHERE
    // provider_msg_id is not null. Cet index partiel ne peut pas etre cible par
    // ON CONFLICT en supabase-js -> SELECT-then-INSERT. L'index reste le backstop
    // atomique : en cas de course (23505), on traite comme un skip.
    if (row.provider_msg_id) {
      const { data: exists } = await db
        .from('messages')
        .select('id')
        .eq('provider', row.provider)
        .eq('provider_msg_id', row.provider_msg_id)
        .limit(1)
      if (exists && exists.length) {
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
      if (row.direction === 'inbound' && row.booking_id && sentAt) {
        // ⚠ UNE SEULE REQUETE, SANS LE FILTRE D'INSTANT, ET LA COMPARAISON SE FAIT
        // ICI. Deux raisons. D'abord `timestamptz` se serialise de plusieurs
        // facons ('…Z' / '…+00:00') : comparer des instants, pas des chaines.
        // Ensuite ca donne GRATUITEMENT le cas qui fait peur — meme texte, meme
        // reservation, instant DIFFERENT — qui est la signature exacte d'un
        // `sent_at` mal renseigne en amont, et donc d'un doublon a venir.
        const { data: memes } = await db
          .from('messages')
          .select('id, sent_at, provider_msg_id')
          .eq('user_id', row.user_id)
          .eq('booking_id', row.booking_id)
          .eq('provider', row.provider)
          .eq('direction', 'inbound')
          .eq('body', row.body)
          .order('created_at', { ascending: false })
          .limit(10)

        const instant = instantDe(row.sent_at)
        const memeInstant = (x) => instantDe(x.sent_at) === instant
        const aReconcilier = (memes || []).find(x => memeInstant(x) && x.provider_msg_id == null)

        if (aReconcilier) {
          const { error: majErr } = await db
            .from('messages')
            .update({ provider_msg_id: row.provider_msg_id })
            .eq('id', aReconcilier.id)
            .is('provider_msg_id', null)   // course : un autre tick a pu le faire
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
            + `reconciliation impossible, doublon probable (resa ${row.booking_id})`)
        }
      }

      if (row.direction === 'outbound' && row.booking_id) {
        const { data: mien } = await db
          .from('messages')
          .select('id')
          .eq('user_id', row.user_id)
          .eq('booking_id', row.booking_id)
          .eq('direction', 'outbound')
          .eq('body', row.body)
          .is('provider_msg_id', null)
          .order('created_at', { ascending: false })
          .limit(1)
        if (mien && mien.length) {
          const { error: majErr } = await db
            .from('messages')
            .update({ provider_msg_id: row.provider_msg_id })
            .eq('id', mien[0].id)
            .is('provider_msg_id', null)   // course : un autre tick a pu le faire
          if (!majErr) return { ok: true, skipped: true, reason: 'echo_reconcilie' }
          console.warn('[recordMessage] reconciliation echo echouee', majErr.message)
        }
      }

      const { error: insErr } = await db.from('messages').insert(row)
      if (insErr) {
        // 23505 = violation unique (course rare entre SELECT et INSERT) :
        // l'index partiel a fait son office -> skip, pas une erreur (logs propres).
        if (insErr.code === '23505') {
          return { ok: true, skipped: true, reason: 'race_23505' }
        }
        console.error('[recordMessage] insert echec', insErr.message)
        return { ok: false, error: insErr.message }
      }
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
    dupQuery = row.booking_id
      ? dupQuery.eq('booking_id', row.booking_id)
      : dupQuery.is('booking_id', null)

    const { data: dup } = await dupQuery
    if (dup && dup.length) {
      return { ok: true, skipped: true, reason: 'duplicate_outbound' }
    }

    const { error: insErr } = await db.from('messages').insert(row)
    if (insErr) {
      // ⚠ 23505 = l'index unique partiel `messages_sans_msgid_unique_idx` a
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
    return { ok: true, skipped: false }

  } catch (e) {
    // Fail-safe ultime : aucune exception ne remonte au producteur.
    console.error('[recordMessage] exception', e.message)
    return { ok: false, error: e.message }
  }
}

module.exports = { recordMessage }
