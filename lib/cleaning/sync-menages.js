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
//
// ⚠ ISOLATION MULTI-COMPTES : le filtre sur user_id est OBLIGATOIRE. Le dispatcher
// traite un lot multi-comptes et charge les tokens de tous les hotes du lot en une
// passe ; un token « tous les biens » (property_ids vide) d'un hote B satisferait
// sinon n'importe quel bien d'un hote A. La PWA prestataire lit menage_events par
// TOKEN seul (api/menages-public.js) — le prestataire de B verrait les voyageurs
// de A. La RLS ne protege pas ici : le dispatcher tourne en service key.
function tokensPourBien(tokens, propertyId, userId) {
  return (tokens || []).filter(t =>
    t.user_id === userId &&
    (!t.property_ids?.length || t.property_ids.includes(String(propertyId)))
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

  const destinataires = tokensPourBien(tokens, event.property_id, event.user_id)
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

  // Un insert en echec ne doit PAS interrompre la boucle : sinon les prestataires
  // suivants ne sont jamais notifies, et comme l'evenement est marque traite
  // (garde anti-boucle) ils ne le seront jamais. On notifie tout le monde, puis
  // on remonte l'echec une fois a la fin.
  let written = 0
  const echecs = []
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
    if (error) echecs.push(error.message)
    else written++
  }
  if (echecs.length) {
    const err = new Error(`menage_events insert (${echecs.length}/${destinataires.length}) : ${echecs[0]}`)
    err.written = written
    throw err
  }
  return { written }
}

// Contexte partage, charge une seule fois par cycle (aucun appel provider).
//
// Les biens et les connaissances sont indexes par `user_id|provider_property_id` :
// provider_property_id n'a AUCUNE contrainte d'unicite globale (cf. commentaire de
// lib/cron-beds24-props.js), deux hotes peuvent donc porter le meme identifiant
// provider — une map indexee sur le seul propId melangerait leurs biens.
function cle(userId, propertyId) { return `${userId}|${String(propertyId)}` }

async function loadContext(userIds, propertyIds) {
  const propIds = propertyIds.map(String)

  // ⚠ Les erreurs sont REMONTEES : un select en echec renverrait une liste vide,
  // indiscernable de « cet hote n'a pas de prestataire » — un chemin de succes.
  // Les evenements seraient consommes et marques traites, et un cycle entier de
  // notifications serait perdu en silence pour tous les hotes du lot.
  const { data: tokens, error: tokensErr } = await supabase
    .from('public_tokens')
    .select('token, property_ids, user_id')
    .in('user_id', userIds)
  if (tokensErr) throw new Error(`lecture public_tokens : ${tokensErr.message}`)

  // `provider` est indispensable au routage d'envoi (Beds24 vs channel) ;
  // `address`, `checkin_time` et `checkout_time` alimentent les placeholders des
  // templates. Les heures sont posees par la couche sync (lib/cron-beds24-props.js)
  // pour que le code metier n'ait jamais a interroger le provider.
  const { data: props, error: propsErr } = await supabase
    .from('properties')
    .select('id, user_id, provider_property_id, name, provider, address, checkin_time, checkout_time')
    .in('user_id', userIds)
    .in('provider_property_id', propIds)
  if (propsErr) throw new Error(`lecture properties : ${propsErr.message}`)

  // Placeholders configures par l'hote : {telephone_hote}, {checkin}, {checkout},
  // {adresse}. Source de verite cote HoteSmart (apps/agent-ai/knowledge.html).
  // knowledge.property_id n'est pas ecrit de facon homogene : selon le parcours,
  // l'interface y met le provider_property_id OU l'UUID properties.id. On
  // interroge donc les deux, et on indexe le resultat sur le provider_property_id
  // (la cle du reste du flux).
  const uuidParPropId = {}
  ;(props || []).forEach(p => { if (p.id) uuidParPropId[String(p.id)] = String(p.provider_property_id) })
  const clesKnowledge = [...new Set([...propIds, ...Object.keys(uuidParPropId)])]

  const { data: knowledgeRows, error: kbErr } = await supabase
    .from('knowledge')
    .select('user_id, property_id, key, value')
    .in('user_id', userIds)
    .in('property_id', clesKnowledge)
    .eq('type', 'fixed')
  if (kbErr) throw new Error(`lecture knowledge : ${kbErr.message}`)

  const propsByKey = {}
  ;(props || []).forEach(p => { propsByKey[cle(p.user_id, p.provider_property_id)] = p })

  const knowledgeByKey = {}
  ;(knowledgeRows || []).forEach(r => {
    // Ramene une eventuelle cle UUID vers le provider_property_id.
    const propId = uuidParPropId[String(r.property_id)] || String(r.property_id)
    const k = cle(r.user_id, propId)
    knowledgeByKey[k] = knowledgeByKey[k] || {}
    knowledgeByKey[k][r.key] = r.value
  })

  return { tokens: tokens || [], propsByKey, knowledgeByKey, cle }
}

module.exports = { syncMenageEvent, loadContext, tokensPourBien, cle, TYPES_DIFFUSES }
