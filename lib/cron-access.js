// ⚠️ DOC : comportement documenté dans docs/kb/codes-acces.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce(s) kb (MÊME COMMIT).
const { supabase } = require('./cron-shared')
const { alertMissingAccessCode } = require('./alert-notify')
const { reportIncident } = require('./founder-notify')

// ─── Annulation code d'accès (sur booking cancelled) ─────────────────────────
// ⚠ `userId` est OBLIGATOIRE : booking_id n'est PAS unique globalement (la cle
// primaire de bookings_snapshot est (user_id, booking_id), et deux hotes d'un
// meme property manager Beds24 partagent l'espace de numerotation). Sans ce
// filtre, l'annulation chez un hote revoquerait le code d'un voyageur chez un
// autre. L'appelant tourne en service key : la RLS ne rattrape rien ici.
async function cancelAccessCode(bookingId, userId) {
  if (!userId) {
    console.error(`[Access] cancelAccessCode sans userId, booking ${bookingId} — ignore`)
    return
  }

  await supabase
    .from('access_codes')
    .update({ status: 'deleted' })
    .eq('user_id', userId)
    .eq('booking_id', bookingId)
    .neq('status', 'deleted')

  await supabase
    .from('message_sent_log')
    .delete()
    .eq('user_id', userId)
    .eq('booking_id', bookingId)
    .eq('status', 'pending')

  console.log(`[Access] Code annulé booking ${bookingId}`)
}

// ─── Rafraîchissement code d'accès (sur modification dates) ──────────────────
// ⚠ `userId` OBLIGATOIRE : cf. cancelAccessCode. Sans lui, le refresh d'un hote
// supprimerait puis regenererait le code d'un voyageur d'un autre hote.
async function refreshAccessCode(bookingId, booking, userId) {
  if (!userId) {
    console.error(`[Access] refreshAccessCode sans userId, booking ${bookingId} — ignore`)
    return
  }

  // Dates inexploitables -> on ne touche a RIEN. Sinon l'ancien code serait
  // supprime plus bas, puis la generation echouerait sur `new Date(null)` :
  // le voyageur se retrouverait sans code du tout, sans rejeu possible.
  if (!booking?.arrival || !booking?.departure) {
    console.error(`[Access] Refresh ignore booking ${bookingId} : dates absentes (arrival=${booking?.arrival}, departure=${booking?.departure})`)
    return
  }

  // Kill switch : bien en pause -> on ne touche a rien (ni suppression de l'ancien code,
  // ni recreation). Le voyageur garde son code actuel ; l'automatique est gele.
  try {
    const { data: propRows } = await supabase
      .from('properties')
      .select('automation_paused')
      .eq('user_id', userId)
      .eq('provider_property_id', String(booking.propertyId))
      .limit(1)
    if (propRows && propRows[0]?.automation_paused === true) {
      console.log(`[Access] Refresh ignore (kill switch) booking ${bookingId}`)
      return
    }
  } catch (e) { /* defaut : on continue */ }

  const { data: existing } = await supabase
    .from('access_codes')
    .select('id, lock_id, seam_code_id, status')
    .eq('user_id', userId)
    .eq('booking_id', bookingId)
    .neq('status', 'deleted')
    .maybeSingle()
  if (!existing) return

  // La cle Seam de CET hote. Sans filtre user_id, maybeSingle() renvoie une
  // erreur des qu'au moins deux hotes ont une cle Seam — et l'ancien code aurait
  // deja ete marque supprime juste au-dessus. On la resout donc AVANT de
  // supprimer quoi que ce soit.
  const { data: keyRow } = await supabase
    .from('api_keys')
    .select('seam_api_key, user_id')
    .eq('user_id', userId)
    .not('seam_api_key', 'is', null)
    .maybeSingle()
  if (!keyRow?.seam_api_key) {
    console.error(`[Access] Refresh ignore booking ${bookingId} : pas de cle Seam pour cet hote`)
    return
  }

  await supabase
    .from('access_codes')
    .update({ status: 'deleted' })
    .eq('id', existing.id)

  const { data: lock } = await supabase
    .from('locks')
    .select('seam_device_id, label')
    .eq('id', existing.lock_id)
    .single()
  if (!lock) return

  // L'heure de depart REGLEE par l'hote, pour que la fenetre soit la meme que
  // celle du generateur. Absente : `fenetreDuCode` retombe sur 11:00 (Paris),
  // exactement comme lui — un seul defaut, au meme endroit.
  let checkoutDuBien = null
  try {
    const { data: k } = await supabase
      .from('knowledge').select('value')
      .eq('user_id', userId).eq('property_id', String(booking.propertyId))
      .eq('type', 'fixed').eq('key', 'checkout').maybeSingle()
    checkoutDuBien = k?.value || null
  } catch (e) {
    console.warn('[Access] heure de checkout illisible, repli sur le defaut :', e.message)
  }

  const { generateCode } = require('./providers/seam')
  try {
    const result = await generateCode({
      seamDeviceId: lock.seam_device_id,
      guestName:    `${booking.firstName || ''} ${booking.lastName || ''}`.trim() || 'Voyageur',
      // ⚠ LA MEME FENETRE QUE LE GENERATEUR, RELEVE EN REVIEW LE 14 SEPTEMBRE 2026.
      // Ces deux lignes portaient DEUX REGLES OPPOSEES a un caractere d'ecart :
      // `new Date('2026-09-20')` (date seule) est lu en UTC, `new Date('2026-09-20T23:59:59')`
      // (date-heure nue) est lu en heure LOCALE. Depuis une machine a Paris l'ete,
      // la fin tombait a 21:59:59Z au lieu de 23:59:59Z : le code de la serrure
      // mourait DEUX HEURES avant minuit le jour du depart, et la ligne restait
      // `active` — le voyageur qui remonte chercher un sac a 22 h 15 est dehors,
      // sans aucun signal pour l'hote.
      //
      // ⚠ MAIS LE FOND EST PIRE QUE LE FUSEAU, ET IL EN EST INDEPENDANT : les
      // DEUX producteurs de codes Seam ne disaient pas la meme chose de « la fin
      // du sejour ». `cron-arrival-code` calcule checkout + 1 h en heure de Paris
      // EXPLICITE (`fenetreDuCode`), ici on prenait minuit. Un meme sejour recevait
      // donc deux fenetres differentes selon le chemin qui l'avait cree. On appelle
      // desormais la meme fonction — une seule definition de la fin du sejour.
      //
      // Mesure du 14 septembre : ce chemin n'a JAMAIS tourne en production
      // (0 ligne sur 124 porte sa signature). Le defaut etait inerte, mais arme :
      // il se serait declenche au premier changement de dates d'un voyageur.
      ...(() => {
        const { fenetreDuCode } = require('./cron-arrival-code')
        const { startsAt, endsAt } = fenetreDuCode(booking.departure, checkoutDuBien)
        return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }
      })(),
      apiKey:       keyRow.seam_api_key
    })

    const newRow = {
      lock_id: existing.lock_id,
      booking_id: bookingId,
      property_id: String(booking.propertyId),
      seam_code_id: result.seam_code_id,
      code: result.code,
      starts_at: result.starts_at,
      ends_at: result.ends_at,
      // PIN null (génération Seam async) → 'pending' : PHASE 2 re-fetchera le PIN.
      status: result.code ? 'active' : 'pending'
    }
    const { error: insErr } = await supabase.from('access_codes').insert(newRow)
    if (insErr) {
      // 23505 : un slot actif (booking, lock) existe deja (ex. claim arrival-code
      // concurrent, via l'index unique partiel). On l'ADOPTE en UPDATE plutot que
      // d'orpheliner le code Seam qu'on vient de creer.
      if (insErr.code === '23505') {
        await supabase.from('access_codes')
          .update({ seam_code_id: result.seam_code_id, code: result.code, starts_at: result.starts_at, ends_at: result.ends_at, status: result.code ? 'active' : 'pending' })
          .eq('booking_id', bookingId).eq('lock_id', existing.lock_id).neq('status', 'deleted')
      } else {
        throw new Error(insErr.message)
      }
    }

    // PIN indisponible : ne pas injecter un code null dans le message pending,
    // alerter l'hôte. Le message se résoudra quand le PIN arrivera (PHASE 2).
    if (!result.code) {
      await alertMissingAccessCode({ userId: keyRow.user_id, propertyId: booking.propertyId, booking })
      console.warn(`[Access] Refresh booking ${bookingId} : PIN Seam null, message non mis à jour, hôte alerté`)
      return
    }

    console.log(`[Access] Code rafraîchi booking ${bookingId}: ${result.code}`)
  } catch (err) {
    console.error(`[Access] Erreur refresh booking ${bookingId}:`, err.message)
    await reportIncident('seam_failure', { userId: keyRow.user_id, propertyId: booking.propertyId, threshold: 1, detail: `Refresh code serrure échoué (booking ${bookingId}) : ${err.message}` })
  }
}

// ─── Vérification batterie serrures ──────────────────────────────────────────
// TODO : lecture batterie igloohome nécessite un bridge ou l'API igloohome
// directe (Seam ne remonte pas la batterie pour igloohome algoPIN).
async function checkBatteries(results) {
  // Placeholder — sera implémenté quand bridge igloohome ou API directe dispo
}

module.exports = {
  cancelAccessCode,
  refreshAccessCode,
  checkBatteries
}
