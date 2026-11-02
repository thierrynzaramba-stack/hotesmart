// lib/guestflow/journal-envoi-ia.js
// CE QU'IL FAUT ECRIRE DANS LE CŒUR QUAND UNE REPONSE IA EST PARTIE.
//
// ⚠ CE MODULE EXISTE PARCE QUE J'AVAIS OUBLIE TOUT CELA DANS LE CHEMIN DIFFERE
// (constat 1, grave, de la revue du 27 octobre 2026). `lib/cron-classify.js`
// faisait QUATRE ecritures apres un envoi reussi ; `brouillons-dus.js` n'en
// faisait AUCUNE — il posait `status: 'done'` et s'arretait la. Resultat : le
// voyageur recevait la reponse, et elle n'existait NULLE PART dans le cœur.
//
// Les trois consequences, toutes reelles :
//   · l'hote voit un fil ou sa question reste sans reponse ;
//   · le journal `conversations` est muet ;
//   · au message suivant, `preparerLot` ne voit aucune reponse cote hote —
//     donc l'IA peut repondre une SECONDE FOIS a la meme question.
//
// C'est exactement ce que la regle d'architecture du depot interdit :
// « provider → cœur → apps », et « aucune donnee n'existe seulement dans une
// app ». Une reponse partie est une donnee du cœur.
//
// ⚠ ET IL EST PARTAGE, PAS RECOPIE. Deux copies de ces quatre ecritures
// divergeraient au premier ajout — c'est la regle du depot sur les modules
// communs, et c'est ce defaut-la qui a produit le constat.

// ⚠ REQUIRE PARESSEUX, MEME RAISON QUE DANS brouillons-dus.js :
// `lib/record-message.js` INSTANCIE un client Supabase a l'import. Charge en
// tete, il obligeait chaque appelant — test, script, futur worker — a porter un
// environnement complet pour une dependance qu'il n'utilise peut-etre pas. Le
// fichier de test de la passe a cesse de charger entierement a cause de ca.
function recordMessageLazy (args) {
  return require('../record-message').recordMessage(args)
}

/**
 * Journalise une reponse IA REELLEMENT PARTIE.
 *
 * @param {object} sb        client Supabase
 * @param {object} p
 *   - userId, property (objet), bookingId
 *   - guestName, guestMessage : ce a quoi l'IA repond (journal `conversations`)
 *   - texte    : la reponse partie
 *   - canal    : le chemin REELLEMENT emprunte ('email' ou autre)
 *   - ota      : l'OTA de la reservation, pour `messages`
 *   - origine  : 'ia_auto' (envoi dans le tour) ou 'ia_differee' (a l'echeance)
 *   - results  : le collecteur d'erreurs du cron
 *   - fermerPause : fonction optionnelle (le chemin immediat la fournit)
 *
 * ⚠ AUCUNE ECRITURE N'EST FATALE : la reponse EST partie. Un journal en echec
 * se dit dans `results.errors` et n'annule rien — l'inverse (lever) ferait
 * remonter l'appelant dans un chemin d'echec alors que le voyageur a recu son
 * message, et c'est le faux vert a l'envers.
 */
async function journaliserReponseIA (sb, p) {
  const { userId, property, bookingId, guestName, guestMessage, texte,
    canal, ota, origine, results, fermerPause } = p

  const { error: eC } = await sb.from('conversations').insert({
    user_id: userId,
    property_id: String(property.id),
    guest_name: guestName,
    guest_message: guestMessage,
    agent_reply: texte,
    book_id: String(bookingId)
  })
  if (eC) results?.errors?.push({ context: 'journal_conversations', booking_id: String(bookingId), error: eC.message })

  // DOUBLE ECRITURE : la reponse IA entre AUSSI dans `messages` (le cœur).
  // UNIQUEMENT l'outbound/ai — l'inbound guest est ecrit par le webhook
  // Channex / syncMessages Beds24, qui ont le vrai `provider_msg_id`.
  // `providerMsgId: null` : on ne capture pas l'id d'envoi, la dedup est logique.
  const msgProvider = (property.provider === 'channex' || property.provider === 'channel') ? 'channex' : 'beds24'
  try {
    await recordMessageLazy({
      userId,
      provider:      msgProvider,
      propertyId:    property.id,
      bookingId:     bookingId,
      direction:     'outbound',
      sender:        'ai',
      body:          texte,
      providerMsgId: null,
      ota:           ota,
      sentAt:        null,
      kind:          'message',
      // Le chemin reellement emprunte, pas le provider du bien.
      canal:         canal === 'email' ? 'email' : 'ota',
      // Dette 66 : posee a l'envoi, jamais recalculee. `ia_differee` distingue
      // ce qui est parti A L'ECHEANCE de ce qui est parti dans le tour : c'est
      // la seule trace qui dira, dans six mois, combien de reponses le
      // parachute a reellement envoyees.
      origine:       origine
    })
  } catch (e) {
    results?.errors?.push({ context: 'journal_messages', booking_id: String(bookingId), error: e.message })
  }

  // Une tache « reçu pendant la pause » du sejour se ferme des qu'une reponse
  // part (decision de Thierry du 9 octobre 2026).
  if (typeof fermerPause === 'function') {
    try {
      await fermerPause(userId, property.id, bookingId,
        [{ source: 'ai', time: new Date(Date.now() + 1000).toISOString() }], results)
    } catch (e) {
      results?.errors?.push({ context: 'fermer_taches_pause', booking_id: String(bookingId), error: e.message })
    }
  }
}

module.exports = { journaliserReponseIA }
