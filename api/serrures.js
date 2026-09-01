// api/serrures.js — Module Seam centralisé HôteSmart
// Actions : saveConfig, toggleConfig, config, getLocks, generateCode, getCodes

const { createClient } = require('@supabase/supabase-js')
const { requirePermission, verifierSession } = require('../lib/require-permission')
const { getSeamKey } = require('../lib/providers/seam')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ─── Fonction principale exportée pour usage interne ─────────────────────────
async function generateAccessCode(lockId, guestName, startsAt, endsAt, userId) {
  const apiKey = await getSeamKey(userId)
  if (!apiKey) throw new Error('Clé Seam non configurée')

  // Création du code offline (Algopin — fonctionne sans bridge)
  const response = await fetch('https://connect.getseam.com/access_codes/create', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      device_id:             lockId,
      name:                  `${guestName} - HôteSmart`,
      starts_at:             startsAt,
      ends_at:               endsAt,
      is_offline_access_code: true
    })
  })

  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message || `Seam erreur ${response.status}`)

  const accessCodeId = data.access_code?.access_code_id
  if (!accessCodeId) throw new Error('Code non créé')

  // Attendre que le code Algopin soit calculé (max 5 secondes)
  let code = data.access_code?.code
  if (!code) {
    await new Promise(r => setTimeout(r, 2000))
    const r2 = await fetch(`https://connect.getseam.com/access_codes/get?access_code_id=${accessCodeId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    })
    const d2 = await r2.json()
    code = d2.access_code?.code
  }

  return { ...data.access_code, code }
}

// getSeamKey vit dans lib/providers/seam.js — il y en avait DEUX copies, avec le
// meme repli sur la cle plateforme (voir le commentaire la-bas). Une seule
// definition, sinon le correctif n'aurait ferme que la moitie du chemin.

// ─── Handler Vercel ───────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Endpoint appele uniquement par les pages HoteSmart : pas de raison d'ouvrir
  // l'origine a tout le web.
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // ── Droits ──
  // Aucune action ne porte d'identifiant de bien : le compte cible est celui de
  // l'appelant. La garde verifie donc le DOMAINE.
  //   config / locks / saveConfig / toggleConfig -> `reglages` (la cle du compte)
  //   codes / generateCode / deleteCode          -> `reservations` (codes voyageur)
  //
  // ⚠ CE QUI PROTEGE REELLEMENT ICI, c'est la cle : `lock_id` et `code_id`
  // viennent du client et Seam ne repond que pour les appareils de la cle
  // presentee. C'est pourquoi le repli sur la cle PLATEFORME etait une fuite —
  // il faisait tomber cette borne (cf. lib/providers/seam.js).
  const actionDemandee = (req.method === 'GET' ? req.query?.action : (req.body || {}).action) || ''
  const DOMAINE_PAR_ACTION = {
    config: ['reglages', 'read'], locks: ['reglages', 'read'],
    saveConfig: ['reglages', 'write'], toggleConfig: ['reglages', 'write'],
    codes: ['reservations', 'read'],
    generateCode: ['reservations', 'write'], deleteCode: ['reservations', 'write']
  }

  const appelant = await verifierSession(req, res)
  if (!appelant) return

  const regle = Object.prototype.hasOwnProperty.call(DOMAINE_PAR_ACTION, actionDemandee)
    ? DOMAINE_PAR_ACTION[actionDemandee] : null
  if (!regle) return res.status(400).json({ error: 'Action non reconnue' })

  const garde = await requirePermission(req, res, {
    domaine: regle[0], niveau: regle[1], userId: appelant
  })
  if (!garde.ok) return
  const user = { id: garde.accountUserId }

  try {
    return await traiter(req, res, user)
  } catch (e) {
    console.error('[serrures]', e.message)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}

// Corps du handler, isole pour que getSeamKey (qui leve desormais sur panne de
// lecture) ne remonte pas en 500 brut de la plateforme.
async function traiter (req, res, user) {

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { action } = req.query

    // GET config
    if (action === 'config') {
      const { data } = await supabase
        .from('api_keys')
        .select('seam_api_key, seam_enabled')
        .eq('user_id', user.id)
        .maybeSingle()
      return res.status(200).json({
        configured: !!data?.seam_api_key,
        enabled:    data?.seam_enabled !== false
      })
    }

    // GET serrures
    if (action === 'locks') {
      const apiKey = await getSeamKey(user.id)
      if (!apiKey) return res.status(400).json({ error: 'Clé Seam non configurée' })

      const r = await fetch('https://connect.getseam.com/devices/list', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      const d = await r.json()
      return res.status(200).json({ locks: d.devices || [] })
    }

    // GET codes d'une serrure
    if (action === 'codes') {
      const { lock_id } = req.query
      const apiKey = await getSeamKey(user.id)
      if (!apiKey) return res.status(400).json({ error: 'Clé Seam non configurée' })

      const r = await fetch(`https://connect.getseam.com/access_codes/list?device_id=${lock_id}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      })
      const d = await r.json()
      return res.status(200).json({ codes: d.access_codes || [] })
    }

    return res.status(400).json({ error: 'Action non reconnue' })
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {}
    const { action } = body

    // Sauvegarder clé API
    if (action === 'saveConfig') {
      const { apiKey } = body
      if (!apiKey) return res.status(400).json({ error: 'Clé API requise' })

      // ⚠ `update` sur une ligne INEXISTANTE ne renvoie pas d'erreur : sans le
      // .select(), l'hote lisait « enregistre » alors qu'aucune cle n'etait
      // stockee, et toutes ses actions suivantes repondaient « non configuree ».
      const { data, error } = await supabase.from('api_keys')
        .update({ seam_api_key: apiKey, seam_enabled: true })
        .eq('user_id', user.id)
        .select('user_id')

      if (error) { console.error('[serrures] saveConfig', error.message); return res.status(500).json({ error: 'Enregistrement echoue' }) }
      if (!data || !data.length) {
        return res.status(409).json({ error: 'Aucune connexion PMS sur ce compte : connectez votre PMS avant la serrure.' })
      }
      return res.status(200).json({ success: true })
    }

    // Activer / désactiver
    if (action === 'toggleConfig') {
      const { enabled } = body
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) requis' })
      const { data, error } = await supabase.from('api_keys')
        .update({ seam_enabled: enabled })
        .eq('user_id', user.id)
        .select('user_id')
      if (error) { console.error('[serrures] toggleConfig', error.message); return res.status(500).json({ error: 'Mise a jour echouee' }) }
      if (!data || !data.length) return res.status(409).json({ error: 'Aucune configuration a basculer' })
      return res.status(200).json({ success: true })
    }

    // Générer un code d'accès
    if (action === 'generateCode') {
      const { lock_id, guest_name, starts_at, ends_at } = body
      if (!lock_id || !starts_at || !ends_at) {
        return res.status(400).json({ error: 'lock_id, starts_at, ends_at requis' })
      }
      try {
        const code = await generateAccessCode(lock_id, guest_name || 'Voyageur', starts_at, ends_at, user.id)
        return res.status(200).json({ success: true, code })
      } catch (err) {
        return res.status(500).json({ error: err.message })
      }
    }

    // Supprimer un code
    if (action === 'deleteCode') {
      const { code_id } = body
      const apiKey = await getSeamKey(user.id)
      if (!apiKey) return res.status(400).json({ error: 'Clé Seam non configurée' })

      const r = await fetch('https://connect.getseam.com/access_codes/delete', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_code_id: code_id })
      })
      const d = await r.json()
      return res.status(r.ok ? 200 : 500).json({ success: r.ok, data: d })
    }

    return res.status(400).json({ error: 'Action non reconnue' })
  }

  return res.status(405).json({ error: 'Méthode non autorisée' })
}

module.exports.generateAccessCode = generateAccessCode
module.exports.getSeamKey = getSeamKey
