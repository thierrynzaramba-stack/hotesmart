// lib/cleaning/sync-menages.js
// DOC : docs/kb/booking-changes.md (modif = MEME COMMIT)
//
// Consommateur MENAGE des changements de reservation. Ecrit les menage_events
// destines aux prestataires, a partir des evenements produits par le writer
// (lib/bookings-snapshot.js) — donc quel que soit le provider du bien.
//
// C'est ce qui ferme l'ecart E2 de l'audit : la creation des menage_events etait
// cablee dans le chemin Beds24 (lib/cron-bookings.js), donc un bien Channex ne
// produisait AUCUNE notification prestataire.
//
// Provider-agnostique : ne lit que des tables HoteSmart, n'appelle aucun provider.
// N'ecrit que les types 'new' | 'modified' | 'cancelled' : le type 'note' est une
// note manuelle de l'hote (apps/menages/index.html) et n'est jamais touche ici.

const { supabase } = require('../cron-shared')

const TYPES_DIFFUSES = ['new', 'modified', 'cancelled']

// Prestataires concernes par un bien : token « tous les biens » (property_ids
// vide) ou token dont property_ids contient ce bien. Meme regle qu'avant.
function tokensPourBien(tokens, propertyId) {
  return (tokens || []).filter(t =>
    !t.property_ids?.length || t.property_ids.includes(String(propertyId))
  )
}

function guestName(snapshot) {
  const s = snapshot || {}
  return `${s.firstName || ''} ${s.lastName || ''}`.trim() || 'Voyageur'
}

// Ecrit un menage_event par prestataire concerne. Une reservation sans aucun
// prestataire affecte n'ecrit rien (et ce n'est pas une erreur).
async function syncMenageEvent(event, { snapshot, propertyName, tokens }) {
  if (!TYPES_DIFFUSES.includes(event.type)) return { written: 0 }

  const destinataires = tokensPourBien(tokens, event.property_id)
  if (!destinataires.length) return { written: 0, reason: 'aucun_prestataire' }

  const eventData = {
    guestName: guestName(snapshot),
    arrival:   snapshot?.arrival ?? null,
    departure: snapshot?.departure ?? null,
    numAdult:  snapshot?.numAdult ?? null,
    numChild:  snapshot?.numChild ?? null
  }
  // Le detail des modifications n'a de sens que pour 'modified' — la PWA
  // prestataire l'affiche tel quel (apps/menages/public.html).
  if (event.type === 'modified' && event.changes) eventData.changes = event.changes

  let written = 0
  for (const t of destinataires) {
    const { error } = await supabase.from('menage_events').insert({
      user_id:       event.user_id,
      booking_id:    String(event.booking_id),
      property_id:   String(event.property_id),
      property_name: propertyName || null,
      event_type:    event.type,
      event_data:    eventData,
      token:         t.token
    })
    if (error) throw new Error(`menage_events insert: ${error.message}`)
    written++
  }
  return { written }
}

// Contexte partage, charge une seule fois par cycle (aucun appel provider).
async function loadContext(userIds, propertyIds) {
  const { data: tokens } = await supabase
    .from('public_tokens')
    .select('token, property_ids, user_id')
    .in('user_id', userIds)

  const { data: props } = await supabase
    .from('properties')
    .select('provider_property_id, name')
    .in('provider_property_id', propertyIds.map(String))

  const nameByPropId = {}
  ;(props || []).forEach(p => { nameByPropId[String(p.provider_property_id)] = p.name })
  return { tokens: tokens || [], nameByPropId }
}

module.exports = { syncMenageEvent, loadContext, tokensPourBien, TYPES_DIFFUSES }
