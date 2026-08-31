const { supabase } = require('./cron-shared')
const billing = require('./billing')

// ─── Materialisation des biens Beds24 en table 'properties' ──────────────────
// Les biens Beds24 sont normalement fetchs LIVE a chaque cron (pas de ligne DB).
// Pour la facturation (quantite = biens avec active_at non null), on les persiste :
// une ligne properties par bien Beds24, provider='beds24'. active_at est pose a la
// PREMIERE apparition du bien dans un cron reussi, et jamais reecrit ensuite.
//
// Choix "select puis insert" (pas d'upsert) : on ne depend d'aucune contrainte unique
// (user_id, provider_property_id) cote schema, et active_at reste first-write-wins.
// Idempotent : au 2e passage le bien existe deja -> on ne touche pas active_at.
async function materializeBeds24Properties(userId, properties, results) {
  if (!Array.isArray(properties) || !properties.length) return

  let newlyActive = 0
  for (const p of properties) {
    const propId = p?.id != null ? String(p.id) : null
    if (!propId) continue

    try {
      const { data: existing, error: selErr } = await supabase
        .from('properties')
        .select('id, active_at')
        .eq('user_id', userId)
        .eq('provider', 'beds24')
        .eq('provider_property_id', propId)
        .maybeSingle()
      // Erreur de lecture (ex. colonne active_at absente) : on n'insere pas a l'aveugle.
      if (selErr) { console.error('[beds24-props] select echec', propId, selErr.message); continue }

      if (!existing) {
        // Premiere apparition : materialisation + active_at = maintenant.
        const { error: insErr } = await supabase.from('properties').insert({
          user_id:              userId,
          provider:             'beds24',
          provider_property_id: propId,
          name:                 p.name || ('Bien ' + propId),
          inventory_type:       'whole',
          city:                 p.city || null,
          country:              p.country || null,
          zip_code:             p.postcode || null,
          address:              p.address || null,
          currency:             p.currency || null,
          active_at:            new Date().toISOString()
        })
        if (insErr) console.error('[beds24-props] insert echec', propId, insErr.message)
        else {
          newlyActive++
          if (results) results.totalBeds24Materialized = (results.totalBeds24Materialized || 0) + 1
        }
      } else if (!existing.active_at) {
        // Bien deja materialise avant l'existence de active_at : on le pose maintenant.
        const { error: updErr } = await supabase
          .from('properties')
          .update({ active_at: new Date().toISOString() })
          .eq('id', existing.id)
          .is('active_at', null)
        if (updErr) console.error('[beds24-props] active_at update echec', propId, updErr.message)
        else newlyActive++
      }
      // Heures d'arrivee/depart du bien, telles que Beds24 les connait. Persistees
      // pour que le code metier n'ait jamais besoin d'appeler le provider : le
      // dispatcher (lib/booking-changes-dispatch.js) lit `properties` uniquement.
      // Le formulaire Connaissances reste prioritaire a la lecture.
      //
      // Mise a jour SEPAREE et non bloquante, hors de l'insert principal : si la
      // migration n'est pas encore appliquee, la materialisation du bien (et donc
      // la facturation) ne doit pas echouer pour autant.
      await syncPropertyHours(userId, propId, p)
    } catch (err) {
      console.error('[beds24-props] Erreur bien', propId, err.message)
    }
  }

  // De nouveaux biens sont devenus actifs ce cycle -> aligne la facturation une seule
  // fois pour le compte (no-op si beta, si aucun prix Stripe, ou si deja a jour).
  if (newlyActive > 0) {
    try { await billing.syncAccountBilling(userId) }
    catch (e) { console.error('[beds24-props] billing sync echec', userId, e.message) }
  }
}

// Aligne properties.checkin_time / checkout_time sur ce que renvoie Beds24.
// N'ecrit que si la valeur a change (evite une ecriture par bien a chaque cycle).
// Fail-safe : ne throw jamais, ne bloque pas la materialisation.
async function syncPropertyHours(userId, propId, p) {
  const checkin  = p?.checkInStart || null
  const checkout = p?.checkOutEnd  || null
  if (!checkin && !checkout) return

  try {
    const { data: row, error: selErr } = await supabase
      .from('properties')
      .select('id, checkin_time, checkout_time')
      .eq('user_id', userId)
      .eq('provider', 'beds24')
      .eq('provider_property_id', propId)
      .maybeSingle()
    // Colonnes absentes (migration non appliquee) : no-op silencieux.
    if (selErr || !row) return
    if (row.checkin_time === checkin && row.checkout_time === checkout) return

    const { error: updErr } = await supabase
      .from('properties')
      .update({ checkin_time: checkin, checkout_time: checkout })
      .eq('id', row.id)
    if (updErr) console.error('[beds24-props] heures update echec', propId, updErr.message)
  } catch (e) {
    console.error('[beds24-props] heures exception', propId, e.message)
  }
}

module.exports = { materializeBeds24Properties, syncPropertyHours }
