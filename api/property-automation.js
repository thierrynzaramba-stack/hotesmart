// api/property-automation.js — Kill switch par bien (arret d'urgence de l'automatique).
//
// GET  -> { paused: { "<provider_property_id>": true, ... } } pour les biens de l'user en pause.
// POST { provider_property_id, paused, reason? } -> bascule properties.automation_paused.
//
// Keye par provider_property_id : fonctionne pour Channex (uuid Channex) ET pour Beds24
// (id numerique) une fois le bien materialise en table par le cron. Toggle sans effet
// sur la lecture/synchro : seul l'automatique sortant est gele cote cron (voir isAutomationPaused).

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

module.exports = async function handler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Non autorise' })
  const { data: userData, error: authErr } = await supabase.auth.getUser(token)
  const user = userData?.user
  if (authErr || !user) return res.status(401).json({ error: 'Session invalide' })

  // ===== GET : etat des biens en pause =====
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('properties')
      .select('provider_property_id, automation_paused')
      .eq('user_id', user.id)
    if (error) return res.status(500).json({ error: 'Erreur lecture' })
    const paused = {}
    for (const p of (data || [])) {
      if (p.provider_property_id != null) paused[String(p.provider_property_id)] = p.automation_paused === true
    }
    return res.status(200).json({ paused })
  }

  // ===== POST : bascule =====
  if (req.method === 'POST') {
    const { provider_property_id, paused, reason } = req.body || {}
    if (provider_property_id == null || typeof paused !== 'boolean') {
      return res.status(400).json({ error: 'provider_property_id et paused (boolean) requis' })
    }

    const updates = {
      automation_paused: paused,
      paused_at:         paused ? new Date().toISOString() : null,
      paused_reason:     paused ? (reason ? String(reason).slice(0, 200) : 'manuel') : null
    }

    const { data, error } = await supabase
      .from('properties')
      .update(updates)
      .eq('user_id', user.id)
      .eq('provider_property_id', String(provider_property_id))
      .select('id')

    if (error) return res.status(500).json({ error: 'Erreur mise a jour' })
    if (!data || !data.length) {
      // Bien pas encore materialise (Beds24 avant 1er cron) ou provider_property_id inconnu.
      return res.status(409).json({ error: 'Bien pas encore synchronise. Reessayez dans quelques minutes.' })
    }
    return res.status(200).json({ ok: true, paused, updated: data.length })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Methode non autorisee' })
}
