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
const { requirePermission, verifierSession, resoudreBien } = require('../lib/require-permission')
const { refsDuPerimetre, filtrePerimetreSql } = require('../lib/permissions')

module.exports = async function handler(req, res) {
  const appelant = await verifierSession(req, res)
  if (!appelant) return

  // ===== GET : etat des biens en pause =====
  if (req.method === 'GET') {
    // Collection : aucun identifiant client, le compte cible est l'appelant. La
    // garde verifie le domaine, le perimetre se traduit en filtre (inerte tant
    // qu'il n'y a pas de selecteur de compte — etape 5).
    const garde = await requirePermission(req, res, {
      domaine: 'reglages', niveau: 'read', userId: appelant
    })
    if (!garde.ok) return
    const filtreOr = filtrePerimetreSql(refsDuPerimetre(garde.contexte), 'provider_property_id')
    if (filtreOr === '') return res.status(200).json({ paused: {} })

    let q = supabase
      .from('properties')
      .select('provider_property_id, automation_paused')
      .eq('user_id', garde.accountUserId)
    if (filtreOr) q = q.or(filtreOr)
    const { data, error } = await q
    if (error) { console.error('[property-automation] lecture', error.message); return res.status(500).json({ error: 'Erreur lecture' }) }
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

    // ⚠ Le kill switch GELE l'automatique sortant d'un bien : messages voyageur et
    // codes d'acces. C'est une action de configuration, donc `reglages` en
    // ecriture, sur le bien RESOLU — la valeur client ne designe pas le compte.
    // ⚠ Le 409 « pas encore synchronise » doit survivre a la garde : il dit a
    // l'hote d'attendre le cron, la ou un 404 « Bien introuvable » laisserait
    // croire a une erreur de sa part.
    //
    // ⚠ MAIS IL NE DOIT PAS PRECEDER LE CONTROLE DE DROITS. Emis avant la garde,
    // il devenait un oracle d'existence : 409 = ce provider_property_id n'existe
    // nulle part, 403 = il existe chez quelqu'un d'autre. La garde repond 404
    // justement pour ne pas distinguer les deux. On resout donc en amont pour
    // savoir, mais on ne differencie le message QUE pour un bien du compte : un
    // bien inconnu de la plateforme et un bien d'autrui recoivent le meme 409
    // neutre, sans rien reveler.
    const cible = await resoudreBien(provider_property_id)
    if (cible && cible.erreur) return res.status(503).json({ error: 'Service temporairement indisponible' })
    if (cible && cible.ambigu) return res.status(409).json({ error: 'Référence de bien ambiguë' })

    if (cible) {
      const garde = await requirePermission(req, res, {
        domaine: 'reglages', niveau: 'write',
        bien: provider_property_id, bienResolu: cible, bienRequis: true, userId: appelant
      })
      if (!garde.ok) return
      return await basculer(req, res, garde, { provider_property_id, paused, reason })
    }

    return res.status(409).json({ error: 'Bien pas encore synchronise. Reessayez dans quelques minutes.' })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Methode non autorisee' })
}

async function basculer (req, res, garde, { provider_property_id, paused, reason }) {
  {

    const updates = {
      automation_paused: paused,
      paused_at:         paused ? new Date().toISOString() : null,
      paused_reason:     paused ? (reason ? String(reason).slice(0, 200) : 'manuel') : null
    }

    const { data, error } = await supabase
      .from('properties')
      .update(updates)
      .eq('user_id', garde.accountUserId)
      .eq('id', garde.bien.id)
      .select('id')

    if (error) { console.error('[property-automation] update', error.message); return res.status(500).json({ error: 'Erreur mise a jour' }) }
    if (!data || !data.length) {
      // Bien pas encore materialise (Beds24 avant 1er cron) ou provider_property_id inconnu.
      return res.status(409).json({ error: 'Bien pas encore synchronise. Reessayez dans quelques minutes.' })
    }
    return res.status(200).json({ ok: true, paused, updated: data.length })
  }
}
