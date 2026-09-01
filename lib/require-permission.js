// lib/require-permission.js
// DOC : docs/kb/profils-et-droits.md (modif = MEME COMMIT)
//
// Verification des droits en TETE d'endpoint serverless. Point d'entree UNIQUE :
// aucune verification ad hoc dispersee dans les endpoints.
//
// POURQUOI. Les endpoints ecrivent en service key, qui CONTOURNE la RLS. Les
// politiques posees a l'etape 2 ne protegent que les acces directs a Supabase
// depuis le navigateur. Un endpoint qui agit au nom d'un utilisateur doit donc
// verifier lui-meme — c'est sa seule defense.
//
// LE COMPTE CIBLE EST DETERMINE PAR LA RESSOURCE, pas par l'appelant : quand un
// bien est designe, on lit son proprietaire dans `properties` et on verifie que
// l'appelant a le droit demande SUR CE COMPTE. Un identifiant de bien fourni par
// le client est ainsi toujours revalide serveur — c'est ce qui empeche de
// designer le bien d'un autre compte.

const { createClient } = require('@supabase/supabase-js')
const { peutLire, peutEcrire, DOMAINES } = require('./permissions')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Resout le bien designe par le client, quelle que soit la forme de son
// identifiant (UUID properties.id ou provider_property_id TEXT).
async function resoudreBien(ref) {
  if (ref == null || ref === '') return null
  const valeur = String(ref)
  const { data } = await supabase
    .from('properties')
    .select('id, user_id, name, provider, provider_property_id')
    .or(`id.eq.${valeur},provider_property_id.eq.${valeur}`)
    .maybeSingle()
  return data || null
}

// Charge le profil de l'appelant SUR LE COMPTE CIBLE (null s'il n'en a pas).
async function chargerProfil(userId, accountUserId) {
  const { data: profil } = await supabase
    .from('profiles')
    .select('*')
    .eq('account_user_id', accountUserId)
    .eq('member_user_id', userId)
    .maybeSingle()
  if (!profil) return { profil: null, permissions: null }
  const { data: permissions } = await supabase
    .from('profile_permissions')
    .select('*')
    .eq('profile_id', profil.id)
    .maybeSingle()
  return { profil, permissions }
}

/**
 * A appeler en TETE d'endpoint. Repond lui-meme 401/403 et renvoie ok:false ;
 * l'appelant n'a qu'a s'arreter.
 *
 * @param {string}  domaine     un de DOMAINES, ou 'titulaire' (titulaire seul)
 * @param {string}  niveau      'read' | 'write'
 * @param {*}       bien        identifiant fourni par le client (UUID ou TEXT), optionnel
 * @param {boolean} bienRequis  si true, un bien introuvable donne 404
 *
 * @returns {{ok:false}} | {{ok:true, userId, accountUserId, bien, contexte}}
 */
async function requirePermission(req, res, { domaine, niveau = 'read', bien = null, bienRequis = false } = {}) {
  // ─── 1. Session ───
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) { res.status(401).json({ error: 'Non autorisé' }); return { ok: false } }
  const { data: userData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !userData?.user) { res.status(401).json({ error: 'Session invalide' }); return { ok: false } }
  const userId = userData.user.id

  // ─── 2. Le bien designe par le client, revalide serveur ───
  let bienResolu = null
  if (bien != null && bien !== '') {
    bienResolu = await resoudreBien(bien)
    if (!bienResolu) {
      // Bien inconnu : 404 plutot que 403, pour ne pas distinguer « n'existe pas »
      // de « ne vous appartient pas » — mais AUCUNE donnee n'est renvoyee.
      res.status(404).json({ error: 'Bien introuvable' })
      return { ok: false }
    }
  } else if (bienRequis) {
    res.status(400).json({ error: 'Identifiant de bien requis' })
    return { ok: false }
  }

  // ─── 3. Le compte cible vient de la RESSOURCE, jamais de l'appelant ───
  const accountUserId = bienResolu ? bienResolu.user_id : userId

  // ─── 4. Titulaire seul (api_keys, app_logs) ───
  //
  // ⚠ PORTEE REELLE : ce mode verifie que l'appelant est titulaire du compte
  // PROPRIETAIRE DE LA RESSOURCE. Sans ressource designee, le compte cible est
  // celui de l'appelant lui-meme — il en est donc titulaire par definition, et
  // la garde ne filtre RIEN. Elle n'a de sens qu'avec un `bien`, ou sur un
  // endpoint dont les donnees appartiennent deja au compte de l'appelant.
  // Ne pas l'utiliser pour proteger une ressource GLOBALE : la protection doit
  // alors consister a ne pas renvoyer les donnees d'autrui.
  if (domaine === 'titulaire') {
    if (userId !== accountUserId) {
      res.status(403).json({ error: 'Réservé au titulaire du compte' })
      return { ok: false }
    }
    return { ok: true, userId, accountUserId, bien: bienResolu, contexte: null }
  }

  if (!DOMAINES.includes(domaine)) {
    console.error('[require-permission] domaine inconnu :', domaine)
    res.status(500).json({ error: 'Configuration de droits invalide' })
    return { ok: false }
  }

  // ─── 5. Droits ───
  const { profil, permissions } = await chargerProfil(userId, accountUserId)
  const contexte = { userId, accountUserId, profil, permissions }
  const cible = bienResolu
    ? { id: bienResolu.id, ref: bienResolu.provider_property_id }
    : null

  const autorise = niveau === 'write'
    ? peutEcrire(contexte, domaine, cible)
    : peutLire(contexte, domaine, cible)

  if (!autorise) {
    console.log(`[require-permission] refus ${domaine}/${niveau} user=${String(userId).slice(0, 8)} compte=${String(accountUserId).slice(0, 8)}${bienResolu ? ' bien=' + bienResolu.name : ''}`)
    res.status(403).json({ error: 'Droits insuffisants' })
    return { ok: false }
  }

  return { ok: true, userId, accountUserId, bien: bienResolu, contexte }
}

module.exports = { requirePermission, resoudreBien, chargerProfil }
