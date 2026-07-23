// ⚠️ DOC : comportement documenté dans docs/kb/menage.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce(s) kb (MÊME COMMIT).
const { createClient } = require('@supabase/supabase-js')
const { markReady } = require('../lib/cron-property-status')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { token } = req.query
  if (!token) return res.status(401).json({ error: 'Token manquant' })

  if (req.method === 'POST') {
    const { action, event_ids, booking_id, property_id, departure_date } = req.body || {}

    // --- markRead : inchange ---
    if (action === 'markRead' && event_ids?.length) {
      await supabase.from('menage_events').update({ read: true })
        .in('id', event_ids).eq('token', token)
      return res.json({ success: true })
    }

    // --- markDone : nouveau, avec table menage_done + garde-fous ---
    if (action === 'markDone') {
      if (!booking_id || !property_id || !departure_date) {
        return res.status(400).json({ error: 'Champs requis manquants (booking_id, property_id, departure_date)' })
      }

      // Validation format departure_date (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(departure_date)) {
        return res.status(400).json({ error: 'Format departure_date invalide, attendu YYYY-MM-DD' })
      }

      // Garde-fou metier : on n'autorise pas un markDone sur un menage futur.
      // Regle : le voyageur doit etre parti (departure_date <= today, en heure
      // Europe/Paris). Cela evite qu'une femme de menage pre-coche par erreur,
      // ou qu'un test foire la valeur de last_menage_at pour le bien entier.
      const todayStr = todayInParis()
      if (departure_date > todayStr) {
        return res.status(400).json({
          error: 'Impossible de marquer un menage futur. Le voyageur n\'est pas encore parti.',
          today: todayStr,
          departure_date
        })
      }

      try {
        const { data: tokenData } = await supabase
          .from('public_tokens').select('user_id').eq('token', token).maybeSingle()
        if (!tokenData) return res.status(401).json({ error: 'Token invalide' })

        const userId = tokenData.user_id

        // Insert dans menage_done. ON CONFLICT DO NOTHING grace a la contrainte unique.
        // On utilise upsert avec ignoreDuplicates pour rester idempotent.
        const { error: insertErr } = await supabase
          .from('menage_done')
          .upsert({
            user_id: userId,
            property_id: String(property_id),
            booking_id: String(booking_id),
            departure_date,
            done_by_token: token
          }, { onConflict: 'user_id,property_id,booking_id,departure_date', ignoreDuplicates: true })

        if (insertErr) {
          console.error('[Menage] Erreur insert menage_done:', insertErr.message)
          return res.status(500).json({ error: 'Erreur enregistrement menage' })
        }

        // Met a jour property_status.last_menage_at via la fonction existante
        try {
          await markReady(userId, String(property_id))
          console.log(`[Menage] ${property_id} booking ${booking_id} dep ${departure_date} -> ready`)
        } catch (err) {
          console.error('[Menage] Erreur markReady:', err.message)
          // On ne bloque pas la reponse : le menage_done est deja insere,
          // c'est la verite. property_status est secondaire.
        }

        return res.json({ success: true, message: 'Menage marque, logement pret' })
      } catch (err) {
        console.error('[Menage] markDone erreur:', err.message)
        return res.status(500).json({ error: err.message })
      }
    }

    // --- markUndone : nouveau, vraie suppression cote serveur ---
    if (action === 'markUndone') {
      if (!booking_id || !property_id || !departure_date) {
        return res.status(400).json({ error: 'Champs requis manquants (booking_id, property_id, departure_date)' })
      }

      try {
        const { data: tokenData } = await supabase
          .from('public_tokens').select('user_id').eq('token', token).maybeSingle()
        if (!tokenData) return res.status(401).json({ error: 'Token invalide' })

        const userId = tokenData.user_id

        // Suppression de la ligne menage_done
        const { error: delErr } = await supabase
          .from('menage_done')
          .delete()
          .eq('user_id', userId)
          .eq('property_id', String(property_id))
          .eq('booking_id', String(booking_id))
          .eq('departure_date', departure_date)

        if (delErr) {
          console.error('[Menage] Erreur delete menage_done:', delErr.message)
          return res.status(500).json({ error: 'Erreur suppression menage' })
        }

        // Recalcul de last_menage_at = MAX(done_at) des menages restants pour ce bien.
        // Si plus aucun menage : on remet last_menage_at a NULL (ou on laisse tel quel ?
        // On choisit de laisser tel quel pour ne pas casser un last_menage_at venu d'ailleurs).
        const { data: latestDone } = await supabase
          .from('menage_done')
          .select('done_at')
          .eq('user_id', userId)
          .eq('property_id', String(property_id))
          .order('done_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (latestDone) {
          await supabase
            .from('property_status')
            .update({ last_menage_at: latestDone.done_at, updated_at: new Date().toISOString() })
            .eq('user_id', userId)
            .eq('property_id', String(property_id))
        }
        // Si latestDone est null, on ne touche pas a property_status :
        // last_menage_at peut venir d'autre source (cron, ancien etat) qu'on
        // ne veut pas effacer aveuglement.

        console.log(`[Menage] markUndone ${property_id} booking ${booking_id} dep ${departure_date}`)
        return res.json({ success: true, message: 'Menage decoche' })
      } catch (err) {
        console.error('[Menage] markUndone erreur:', err.message)
        return res.status(500).json({ error: err.message })
      }
    }

    return res.status(400).json({ error: 'Action inconnue' })
  }

  // --- GET planning public ---
  try {
    const { data: tokenData, error: tokenError } = await supabase
      .from('public_tokens').select('user_id, label, property_ids, visibility_days')
      .eq('token', token).maybeSingle()

    if (tokenError || !tokenData) return res.status(401).json({ error: 'Token invalide' })

    const userId         = tokenData.user_id
    const visibilityDays = tokenData.visibility_days || 30

    // Biens du prestataire : lecture de la table `properties` (dual-provider,
    // ZERO appel Beds24). Cle universelle = provider_property_id, deja utilisee par
    // les tokens (property_ids), menage_done, property_status et bookings_snapshot.
    const { data: propRows } = await supabase
      .from('properties')
      .select('provider_property_id, name')
      .eq('user_id', userId)
      .not('provider_property_id', 'is', null)

    const allowedIds = (tokenData.property_ids || []).map(String)
    const properties = (propRows || [])
      .filter(p => !allowedIds.length || allowedIds.includes(String(p.provider_property_id)))
      .map(p => ({ id: String(p.provider_property_id), name: p.name }))
    const propNameById = {}
    properties.forEach(p => { propNameById[p.id] = p.name })

    const today   = new Date(); today.setHours(0,0,0,0)
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + visibilityDays)
    // On remonte aussi les 14 derniers jours pour que la femme de menage
    // puisse marquer des menages en retard (ex: depart hier, menage fait
    // le lendemain). Au-dela de 14 jours on considere que le menage est
    // perdu et ne fait plus partie du planning actif.
    const minDate  = new Date(today); minDate.setDate(minDate.getDate() - 14)
    const dateFrom = minDate.toISOString().split('T')[0]
    const dateTo   = maxDate.toISOString().split('T')[0]

    // Reservations : lecture bookings_snapshot (alimentee par la couche sync, tous
    // providers). Mappe vers la MEME forme que l'ancien retour Beds24 -> contrat
    // front inchange. Annulations exclues (pas de menage sur une reservation annulee).
    const propIds = properties.map(p => p.id)
    let allBookings = []
    if (propIds.length) {
      const { data: snaps } = await supabase
        .from('bookings_snapshot')
        .select('booking_id, property_id, snapshot')
        .eq('user_id', userId)
        .in('property_id', propIds)
      allBookings = (snaps || [])
        .map(s => {
          const snap = s.snapshot || {}
          return {
            id:        String(s.booking_id),
            propId:    String(s.property_id),
            propName:  propNameById[String(s.property_id)] || '',
            arrival:   snap.arrival || null,
            departure: snap.departure || null,
            firstName: snap.firstName || '',
            lastName:  snap.lastName || '',
            numAdult:  snap.numAdult ?? null,
            numChild:  snap.numChild ?? null,
            status:    snap.status || 'new'
          }
        })
        .filter(b => b.status !== 'cancelled')
        .filter(b => b.departure && b.departure >= dateFrom && b.departure <= dateTo)
    }

    const bookingIds = allBookings.map(b => String(b.id))
    let comments = []
    if (bookingIds.length) {
      const { data: cd } = await supabase.from('menage_comments')
        .select('booking_id, departure_date, comment, property_id')
        .eq('user_id', userId).in('booking_id', bookingIds)
      comments = cd || []
    }

    const { data: eventsData } = await supabase.from('menage_events').select('*')
      .eq('token', token).eq('read', false)
      .gte('created_at', new Date(Date.now() - visibilityDays * 86400000).toISOString())
      .order('created_at', { ascending: false }).limit(50)

    // NOUVEAU : on renvoie aussi la liste des menages deja faits cote serveur.
    // Le front fera l'union avec son localStorage (offline) avant affichage.
    // On filtre uniquement sur les biens autorises ET la fenetre temporelle
    // pour eviter de balancer tout l'historique.
    const propIdsForDone = (allowedIds.length ? allowedIds : properties.map(p => String(p.id)))
    let doneList = []
    if (propIdsForDone.length) {
      const { data: dd } = await supabase.from('menage_done')
        .select('booking_id, property_id, departure_date, done_at')
        .eq('user_id', userId)
        .in('property_id', propIdsForDone)
        .gte('departure_date', dateFrom)
        .lte('departure_date', dateTo)
      doneList = dd || []
    }

    return res.json({
      bookings: allBookings, label: tokenData.label,
      property_ids: allowedIds, visibility_days: visibilityDays,
      comments, events: eventsData || [],
      done: doneList
    })

  } catch (err) {
    console.error('[MenagesPublic]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}

// Helper : date du jour en zone Europe/Paris au format YYYY-MM-DD.
// Important : on raisonne en string pure pour eviter les pieges timezone
// (cf. catalogue bugs critiques resolus, regle "dates pures").
function todayInParis() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit'
  })
  return fmt.format(new Date()) // en-CA donne YYYY-MM-DD
}

// Note isolation provider : cet endpoint ne lit/écrit AUCUN provider en direct.
// L'envoi du message d'arrivée + code voyageur est géré par la couche cron/sync
// (lib/cron-arrival-code processArrivalCodes), déclenchée quand le ménage passe
// le logement en statut 'ready'. Les anciens helpers d'envoi direct Beds24/Seam
// (saveAndSend, generateSeamCode) ont été retirés (bloc 2b) : ils étaient morts.
