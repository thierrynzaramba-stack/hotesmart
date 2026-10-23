// api/beds24-setup.js — Échange l'invite code Beds24 contre un token
const { createClient } = require('@supabase/supabase-js')
// ⚠ LES CHAMPS DU JETON VIENNENT D'UN POINT UNIQUE. Trois writers ecrivent
// `api_keys.api_key` — l'installation et le bouton « Renouvellement » ici, le
// cron dans lib/cron-beds24.js — et un seul maintenait l'expiration. Des que
// `token_expire_le` fait AUTORITE sur « le jeton est-il vivant », un writer qui
// ne la met pas a jour la rend MENTEUSE : le cron sauterait le renouvellement
// sur un jeton mort, et la synchro de l'hote tomberait en silence (constat de
// review du 23 octobre 2026).
const { champsDuJeton } = require('../lib/cron-beds24')
const { colonneAbsente } = require('../lib/colonne-absente')

// Ecrit le jeton ET son expiration. Si la migration 2026-10-23 n'est pas
// appliquee, on retombe sur le seul `api_key` : nommer une colonne absente
// ferait echouer l'ecriture EN ENTIER, donc perdre le jeton neuf.
async function enregistrerLeJeton (supabase, userId, reponse, { upsert = false, refreshToken = undefined } = {}) {
  const { champs } = champsDuJeton(reponse, Date.now())
  const avecRefresh = refreshToken !== undefined ? { ...champs, refresh_token: refreshToken } : champs
  const ecrire = (c) => upsert
    ? supabase.from('api_keys').upsert({ user_id: userId, ...c }, { onConflict: 'user_id' })
    : supabase.from('api_keys').update(c).eq('user_id', userId)
  let { error } = await ecrire(avecRefresh)
  if (error && colonneAbsente(error)) {
    console.warn('[Beds24Setup] token_expire_le absente (migration 2026-10-23) : on n ecrit que le jeton')
    const nu = refreshToken !== undefined
      ? { api_key: reponse.token, refresh_token: refreshToken }
      : { api_key: reponse.token }
    ;({ error } = await ecrire(nu))
  }
  return error
}
const { requirePermission } = require('../lib/require-permission')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' })

  const userToken = req.headers.authorization?.replace('Bearer ', '')
  if (!userToken) return res.status(401).json({ error: 'Non autorisé' })

  // Echange du code d'invite Beds24 contre un token PMS, puis ecriture dans
  // api_keys.
  //
  // ⚠ PORTEE REELLE DE CETTE GARDE : aucune ressource n'est designee, donc le
  // compte cible est celui de l'appelant, dont il est titulaire par definition.
  // Elle ne filtre donc QUE la session — elle ne « reserve au titulaire » rien
  // du tout, contrairement a ce qu'un `domaine: 'titulaire'` laisse croire.
  // Ce n'est pas un probleme ici : toutes les ecritures qui suivent portent sur
  // `user.id`, l'appelant agit donc sur SON compte et sur aucun autre.
  // Le cloisonnement reel viendra du selecteur de compte (etape 5).
  const gardeSetup = await requirePermission(req, res, { domaine: 'titulaire' })
  if (!gardeSetup.ok) return

  const { data: userData } = await supabase.auth.getUser(userToken)
  const user = userData?.user
  if (!user) return res.status(401).json({ error: 'Utilisateur non trouvé' })

  const { action, inviteCode } = req.body || {}

  // ── Échange invite code → token ───────────────────────────────────────────
  if (action === 'setup' && inviteCode) {
    try {
      const r = await fetch('https://beds24.com/api/v2/authentication/setup', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'code': inviteCode,
          'deviceName': 'HoteSmart'
        }
      })
      const d = await r.json()
      console.log('[Beds24Setup] setup response:', JSON.stringify(d))

      if (!d.token) {
        return res.status(400).json({ error: d.error || 'Token non reçu', detail: d })
      }

      const error = await enregistrerLeJeton(supabase, user.id, d,
        { upsert: true, refreshToken: d.refreshToken || null })

      if (error) return res.status(500).json({ error: error.message })

      return res.json({
        success:      true,
        expiresIn:    d.expiresIn,
        hasRefresh:   !!d.refreshToken
      })

    } catch (err) {
      console.error('[Beds24Setup] setup error:', err)
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Refresh token → nouveau token ─────────────────────────────────────────
  if (action === 'refresh') {
    try {
      const { data: keyData } = await supabase.from('api_keys')
        .select('refresh_token').eq('user_id', user.id).single()

      if (!keyData?.refresh_token) {
        return res.status(400).json({ error: 'Pas de refresh token — reconnectez Beds24' })
      }

      const r = await fetch('https://beds24.com/api/v2/authentication/token', {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'refreshToken': keyData.refresh_token
        }
      })
      const d = await r.json()
      console.log('[Beds24Setup] refresh response:', JSON.stringify(d))

      if (!d.token) {
        return res.status(400).json({ error: d.error || 'Refresh échoué', detail: d })
      }

      const eMaj = await enregistrerLeJeton(supabase, user.id, d)
      // ⚠ UNE ECRITURE RATEE NE DOIT PAS RENDRE `success: true`. L'hote lirait
      // « renouvele » sur un jeton que la base n'a pas garde.
      if (eMaj) {
        console.error('[Beds24Setup] jeton renouvele mais NON ENREGISTRE :', eMaj.message)
        return res.status(500).json({ error: 'Jeton obtenu mais non enregistré' })
      }

      return res.json({ success: true, expiresIn: d.expiresIn })

    } catch (err) {
      console.error('[Beds24Setup] refresh error:', err)
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Statut connexion ──────────────────────────────────────────────────────
  if (action === 'status') {
    const { data } = await supabase.from('api_keys')
      .select('api_key, refresh_token')
      .eq('user_id', user.id).maybeSingle()

    return res.json({
      connected:   !!data?.api_key,
      hasRefresh:  !!data?.refresh_token
    })
  }

  return res.status(400).json({ error: 'Action inconnue' })
}
