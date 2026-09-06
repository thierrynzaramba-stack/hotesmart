// api/reservation-directe.js
// DOC : docs/kb/reservation-directe.md (modif = MEME COMMIT)
//
// Saisie manuelle d'une reservation directe, depuis le calendrier.
// Spec : docs/specs/spec-reservation-manuelle.md §5.
//
// POST   { propertyId, arrival, departure, prixParNuit, currency, customer,
//          occupancy, reference }  -> cree la reservation chez Channex
// DELETE { propertyId, bookingId }                       -> l'annule
//
// ⚠ AUCUN MONTANT TOTAL N'EST ACCEPTE DU CLIENT : seul `prixParNuit` est lu, et
// le total en est recalcule. Un total fourni serait une porte ouverte a une
// reservation a 1 € pour sept nuits.
//
// ⚠ CE MODULE N'ECRIT JAMAIS `bookings_snapshot`. La reservation entre dans le
// cœur par le feed/webhook, comme n'importe quelle reservation OTA — c'est la
// regle « provider -> cœur -> apps », et c'est ce qui garantit que menage,
// messages et codes fonctionnent sans une ligne de code specifique.
//
// ⚠ CHANNEX SEULEMENT. L'ecriture CRS n'existe pas cote Beds24 : les hotes
// Beds24 gardent leur interface. Le refus est explicite, jamais silencieux.

const { requirePermission } = require('../lib/require-permission')
const { createClient } = require('@supabase/supabase-js')
const { creerReservationDirecte, verifierDisponibilite, nuits } = require('../lib/reservation-directe')
const { getProvider } = require('../lib/channels')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Le bien, avec ce qu'il faut pour construire un payload CRS complet.
async function bienDuCompte (accountUserId, propertyId) {
  const { data, error } = await supabase
    .from('properties')
    .select('name, provider, provider_property_id, provider_room_type_id, provider_rate_plan_id, currency, base_price')
    .eq('user_id', accountUserId)
    .eq('provider_property_id', String(propertyId))
    .maybeSingle()
  if (error) throw new Error(`lecture properties : ${error.message}`)
  return data
}

module.exports = async (req, res) => {
  // ⚠ `write` : creer une reservation engage le logement aupres d'un voyageur et
  // ferme la vente sur tous les canaux. La verification est refaite ICI, cote
  // serveur : le calendrier teste deja `peutEcrire('reservations')`, mais une
  // garde d'interface n'est pas une garde.
  const { propertyId, bookingId } = req.body || {}
  if (!propertyId) return res.status(400).json({ error: 'propertyId manquant' })

  // ⚠ `bien` + `bienRequis` : SANS EUX, LE PERIMETRE N'EST PAS VERIFIE.
  // `dansPerimetre` (lib/permissions.js) rend `true` des que `bien` est nul : un
  // membre delegue en `property_scope: 'selected'`, limite au bien A, pourrait
  // creer et annuler des reservations sur le bien B du meme compte. Le controle
  // de compte seul ne suffit pas — c'est la classe de fuite fermee au chantier
  // profils et droits, et tous les endpoints d'ecriture passent ces options.
  const garde = await requirePermission(req, res, {
    domaine: 'reservations', niveau: 'write', compteDelegue: true,
    bien: String(propertyId), bienRequis: true
  })
  if (!garde.ok) return

  let bien
  try { bien = await bienDuCompte(garde.accountUserId, propertyId) }
  catch (e) {
    console.error('[resa-directe] lecture bien echec', e.message)
    return res.status(500).json({ error: 'Lecture impossible' })
  }
  // Bien absent du compte : on ne distingue pas « inexistant » de « pas a vous ».
  if (!bien) return res.status(404).json({ error: 'Bien introuvable' })

  if (bien.provider !== 'channex' && bien.provider !== 'channel') {
    return res.status(400).json({
      error: 'provider_sans_ecriture',
      message: `La saisie directe n'est pas disponible sur ce bien (${bien.provider}).`
    })
  }

  // ─── Creation ──────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    // ⚠ `amount` N'EST PAS LU DU CLIENT. Un POST forge avec `amount: 1` aurait
    // cree chez Channex une reservation a 1 € pour sept nuits ; avec une valeur
    // non numerique, `montant()` jette et l'endpoint rendait un 500 sans corps.
    // Le total est TOUJOURS recalcule a partir du prix par nuit valide ici.
    const { arrival, departure, currency, customer, occupancy, reference, prixParNuit } = req.body || {}
    const listeNuits = nuits(arrival, departure)
    if (!listeNuits.length) return res.status(400).json({ error: 'Dates invalides' })
    if (!bien.provider_room_type_id || !bien.provider_rate_plan_id) {
      return res.status(400).json({
        error: 'bien_incomplet',
        message: "Ce bien n'a pas de type de chambre ou de tarif configuré chez le canal."
      })
    }

    // Prix par nuit : celui fourni, sinon le prix de base du bien. Le total en
    // decoule — on ne fait jamais confiance a un total envoye par le client.
    const parNuit = Number(prixParNuit ?? bien.base_price)
    if (!Number.isFinite(parNuit) || parNuit <= 0) {
      return res.status(400).json({ error: 'Prix par nuit invalide' })
    }
    const days = {}
    listeNuits.forEach(n => { days[n] = parNuit.toFixed(2) })
    const total = (parNuit * listeNuits.length).toFixed(2)

    // `creerReservationDirecte` et `payloadCRS` LEVENT volontairement (lecture
    // en echec, champ obligatoire manquant) : sans ce try, l'hote recevait un
    // 500 sans corps JSON, et le front — qui parse avant de tester `ok` — lui
    // affichait une SyntaxError au lieu d'un message.
    let resultat
    try {
      resultat = await creerReservationDirecte(supabase, {
      userId: garde.accountUserId,
      propertyId: bien.provider_property_id,
      resa: {
        roomTypeId: bien.provider_room_type_id,
        ratePlanId: bien.provider_rate_plan_id,
        arrival, departure, days,
        amount: total,
        currency: currency || bien.currency || 'EUR',
        customer: customer || {},
        occupancy: occupancy || {},
        // `meta` = sous-origine. `ota_name` porte deja l'origine (« Offline »).
        meta: { source: 'hotesmart-manual', ...(reference ? { reference_interne: String(reference) } : {}) },
        // Code unique et lisible : c'est notre seule cle de deduplication cote
        // Channex si un appel devait etre rejoue.
        otaReservationCode: `HS-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
        }
      })
    } catch (e) {
      console.error('[resa-directe] creation exception', e.message)
      return res.status(500).json({ error: 'exception', message: "La réservation n'a pas pu être créée. Rien n'a été enregistré." })
    }

    if (!resultat.ok) {
      // 409 pour un conflit de disponibilite : c'est un refus METIER, pas une
      // erreur technique, et l'interface doit pouvoir les distinguer.
      const conflit = resultat.raison === 'nuits_completes' || resultat.raison === 'verrou_occupe'
      return res.status(conflit ? 409 : 400).json(resultat)
    }
    return res.status(200).json({
      ok: true, bookingId: resultat.bookingId, nuits: resultat.nuits,
      message: 'Réservation envoyée. Elle apparaîtra dans HôteSmart au prochain rafraîchissement.'
    })
  }

  // ─── Annulation ────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!bookingId) return res.status(400).json({ error: 'bookingId manquant' })

    // ⚠ ON N'ANNULE QUE CE QU'ON A CREE. Une reservation OTA doit etre annulee
    // chez l'OTA ; la toucher par le CRS produirait une divergence entre ce que
    // voit le voyageur et ce que voit l'hote. La verification porte sur le CŒUR,
    // pas sur ce que le client affirme.
    const { data: ligne, error: eLigne } = await supabase
      .from('bookings_snapshot')
      .select('snapshot')
      .eq('user_id', garde.accountUserId)
      .eq('property_id', String(bien.provider_property_id))
      .eq('booking_id', String(bookingId))
      .maybeSingle()
    if (eLigne) {
      console.error('[resa-directe] lecture snapshot echec', eLigne.message)
      return res.status(500).json({ error: 'Lecture impossible' })
    }
    if (!ligne) return res.status(404).json({ error: 'Réservation introuvable' })

    const source = String(ligne.snapshot?.source || '').toLowerCase()
    if (source !== 'offline') {
      return res.status(403).json({
        error: 'reservation_ota',
        message: `Cette réservation vient de ${ligne.snapshot?.source || 'une plateforme'} : elle doit être annulée chez elle.`
      })
    }

    // Meme exigence qu'a la creation : sans room type ni rate plan, `payloadCRS`
    // jette et l'endpoint rendait un 500 sans corps.
    if (!bien.provider_room_type_id || !bien.provider_rate_plan_id) {
      return res.status(400).json({
        error: 'bien_incomplet',
        message: "Ce bien n'a pas de type de chambre ou de tarif configuré chez le canal."
      })
    }

    const s = ligne.snapshot
    const listeNuits = nuits(s.arrival, s.departure)
    if (!listeNuits.length) return res.status(400).json({ error: 'Réservation sans dates exploitables' })

    // ⚠ LA SOMME DES `days` DOIT VALOIR EXACTEMENT `amount`.
    // Un simple `amount / nuits` arrondi par nuit donne 33,33 x 3 = 99,99 pour
    // 100,00 : Channex valide deja la coherence entre `departure_date` et les
    // `days`, et rejetterait l'ecart en 422. Le reliquat va sur la derniere nuit.
    const total = Math.round(Number(s.amount || 0) * 100)
    const base = Math.floor(total / listeNuits.length)
    const days = {}
    listeNuits.forEach((n, i) => {
      const cents = i === listeNuits.length - 1 ? total - base * (listeNuits.length - 1) : base
      days[n] = (cents / 100).toFixed(2)
    })

    // Payload COMPLET, days inclus : Channex revalide tout a chaque ecriture et
    // rejette une annulation partielle (mesure du protocole).
    let envoi
    try {
      envoi = await getProvider('channex').cancelBooking(bookingId, bien.provider_property_id, {
      roomTypeId: bien.provider_room_type_id,
      ratePlanId: bien.provider_rate_plan_id,
      arrival: s.arrival, departure: s.departure, days,
      amount: s.amount || 0, currency: s.currency || bien.currency || 'EUR',
      customer: { name: s.firstName || '', surname: s.lastName || '' },
      occupancy: { adults: s.numAdult ?? 1, children: s.numChild ?? 0 },
        otaReservationCode: s.otaReservationCode || String(bookingId)
      })
    } catch (e) {
      console.error('[resa-directe] annulation exception', e.message)
      return res.status(500).json({ error: 'exception', message: "L'annulation n'a pas pu être transmise." })
    }
    if (!envoi.ok) {
      console.error('[resa-directe] annulation echec', envoi.status, JSON.stringify(envoi.erreurs || {}).slice(0, 200))
      return res.status(400).json({ error: 'echec_crs', message: "L'annulation n'a pas pu être transmise." })
    }
    return res.status(200).json({
      ok: true,
      message: 'Annulation envoyée. Les dates seront rouvertes au prochain rafraîchissement.'
    })
  }

  return res.status(405).json({ error: 'Méthode non autorisée' })
}
