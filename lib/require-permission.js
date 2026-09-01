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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Un identifiant provider ne contient ni virgule ni parenthese : tout le reste
// est refuse AVANT d'atteindre la requete.
const REF_SURE_RE = /^[A-Za-z0-9_-]{1,64}$/

// Resout le bien designe par le client, quelle que soit la forme de son
// identifiant (UUID properties.id ou provider_property_id TEXT).
//
// ⚠ DEUX PIEGES, tous deux rencontres :
//
//  1. `id` est de type uuid. Interroger `id.eq.209413` fait echouer TOUTE la
//     requete avec « invalid input syntax for type uuid » — pas un resultat
//     vide, une ERREUR. La branche `id` n'est donc interrogee que si la valeur
//     EST un UUID. Sans cela, tout endpoint recevant un propId Beds24 repondait
//     404 « Bien introuvable » (regression reelle : les SMS ne partaient plus).
//  2. La valeur client est interpolee dans un filtre `.or(...)`. Une virgule ou
//     une parenthese y injecterait des filtres PostgREST supplementaires : le
//     format est donc valide en amont.
async function resoudreBien(ref) {
  if (ref == null || ref === '') return null
  const valeur = String(ref)

  if (UUID_RE.test(valeur)) {
    const { data } = await supabase
      .from('properties')
      .select('id, user_id, name, provider, provider_property_id')
      .or(`id.eq.${valeur},provider_property_id.eq.${valeur}`)
      .maybeSingle()
    return data || null
  }

  if (!REF_SURE_RE.test(valeur)) {
    console.warn('[require-permission] identifiant de bien au format refuse')
    return null
  }
  const { data } = await supabase
    .from('properties')
    .select('id, user_id, name, provider, provider_property_id')
    .eq('provider_property_id', valeur)
    .maybeSingle()
  return data || null
}

// Resout la RESERVATION designee par le client -> compte proprietaire et bien.
// Meme principe que resoudreBien : c'est la ressource qui designe le compte, pas
// l'appelant. Sans cela, un bookingId suffirait a agir sur la reservation d'un
// autre compte (cas reel : api/channel-message.js envoyait un message au
// voyageur de n'importe quelle reservation).
async function resoudreBooking(bookingId) {
  if (bookingId == null || bookingId === '') return null
  // ⚠ La cle d'unicite est (user_id, booking_id), PAS booking_id seul : deux
  // comptes peuvent porter le meme identifiant de reservation. maybeSingle()
  // echouerait alors, transformant une ambiguite en 404 silencieux. On lit donc
  // toutes les lignes et on REFUSE explicitement en cas d'ambiguite — echouer
  // fermé, mais en le disant.
  const { data, error } = await supabase
    .from('bookings_snapshot')
    .select('user_id, booking_id, property_id, snapshot')
    .eq('booking_id', String(bookingId))
  if (error) { console.error('[require-permission] lecture reservation', error.message); return null }
  if (!data || !data.length) return null
  if (data.length > 1) {
    console.error(`[require-permission] booking_id ${bookingId} present sur ${data.length} comptes : refus`)
    return { ambigu: true }
  }
  return data[0]
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
 * Verifie la session SEULE et renvoie l'identifiant de l'appelant (null si la
 * garde a deja repondu 401).
 *
 * A utiliser quand un endpoint doit lire quelque chose AVANT de savoir quels
 * droits demander (api/beds24.js resout la reservation pour en deduire le bien).
 * Sans elle, ces lectures se faisaient en service key AVANT toute
 * authentification : une requete sans jeton valide declenchait une requete SQL et
 * pouvait meme obtenir une reponse (409 « reservation ambigue »), donc un oracle
 * d'existence. Le `userId` obtenu se repasse a requirePermission, qui evite alors
 * un second aller-retour Auth.
 */
async function verifierSession(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) { res.status(401).json({ error: 'Non autorisé' }); return null }
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) { res.status(401).json({ error: 'Session invalide' }); return null }
  return data.user.id
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
async function requirePermission(req, res, { domaine, niveau = 'read', bien = null, bienRequis = false, booking = null, bookingRequis = false, userId: userIdVerifie = null } = {}) {
  // ─── 1. Session ───
  // `userIdVerifie` : session deja validee par verifierSession (ou par un appel
  // precedent dans la meme requete). Il n'est JAMAIS fourni par le client — c'est
  // un parametre interne d'endpoint. Le passer evite de refaire un appel Auth par
  // verification, ce qui rendait une liste de biens couteuse au point d'etre un
  // deni de service.
  let userId = userIdVerifie
  if (!userId) {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) { res.status(401).json({ error: 'Non autorisé' }); return { ok: false } }
    const { data: userData, error: authError } = await supabase.auth.getUser(token)
    if (authError || !userData?.user) { res.status(401).json({ error: 'Session invalide' }); return { ok: false } }
    userId = userData.user.id
  }

  // ─── 2a. La reservation designee par le client, revalidee serveur ───
  // Elle DESIGNE le bien : un bookingId ne peut donc pas servir a agir sur la
  // reservation d'un autre compte.
  let bookingResolu = null
  if (booking != null && booking !== '') {
    bookingResolu = await resoudreBooking(booking)
    if (!bookingResolu) {
      res.status(404).json({ error: 'Réservation introuvable' })
      return { ok: false }
    }
    if (bookingResolu.ambigu) {
      res.status(409).json({ error: 'Réservation ambiguë' })
      return { ok: false }
    }
    // ⚠ La RESERVATION FAIT FOI : le `bien` eventuellement fourni par le client
    // est IGNORE. Sans cela, un membre au perimetre limite au bien A pouvait
    // ecrire au voyageur d'une reservation du bien B en passant `bien = A` — la
    // garde validait A, et l'action portait sur B.
    bien = bookingResolu.property_id
    if (bien == null || bien === '') {
      // Une reservation sans bien ne permet aucune verification de perimetre :
      // un membre restreint passerait. On refuse.
      console.error(`[require-permission] reservation ${booking} sans property_id : refus`)
      res.status(409).json({ error: 'Réservation sans bien rattaché' })
      return { ok: false }
    }
  } else if (bookingRequis) {
    res.status(400).json({ error: 'Identifiant de réservation requis' })
    return { ok: false }
  }

  // ─── 2b. Le bien designe par le client, revalide serveur ───
  let bienResolu = null
  if (bien != null && bien !== '') {
    bienResolu = await resoudreBien(bien)
    if (!bienResolu && !bookingResolu) {
      // Bien inconnu : 404 plutot que 403, pour ne pas distinguer « n'existe pas »
      // de « ne vous appartient pas » — mais AUCUNE donnee n'est renvoyee.
      res.status(404).json({ error: 'Bien introuvable' })
      return { ok: false }
    }
    // Bien issu d'une RESERVATION mais absent de `properties` (bien supprime,
    // snapshot non materialise) : on ne bloque pas un envoi qui fonctionnait, la
    // reference TEXTE de la reservation suffit a verifier le perimetre.
  } else if (bienRequis) {
    res.status(400).json({ error: 'Identifiant de bien requis' })
    return { ok: false }
  }

  // ─── 3. Le compte cible vient de la RESSOURCE, jamais de l'appelant ───
  // La reservation prime : si le bien resolu n'est pas celui de la reservation,
  // c'est une tentative de faire passer une ressource pour une autre.
  if (bookingResolu && bienResolu && String(bookingResolu.user_id) !== String(bienResolu.user_id)) {
    console.log('[require-permission] refus : booking et bien de comptes differents')
    res.status(403).json({ error: 'Droits insuffisants' })
    return { ok: false }
  }
  const accountUserId = bookingResolu ? bookingResolu.user_id
                      : bienResolu    ? bienResolu.user_id
                      : userId

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
    return { ok: true, userId, accountUserId, bien: bienResolu, booking: bookingResolu, contexte: null }
  }

  if (!DOMAINES.includes(domaine)) {
    console.error('[require-permission] domaine inconnu :', domaine)
    res.status(500).json({ error: 'Configuration de droits invalide' })
    return { ok: false }
  }

  // ─── 5. Droits ───
  const { profil, permissions } = await chargerProfil(userId, accountUserId)
  const contexte = { userId, accountUserId, profil, permissions }
  // La reference du perimetre vient de la reservation quand il y en a une, sinon
  // du bien resolu. `ref` reste renseigne meme si le bien n'est pas materialise.
  const cible = bookingResolu
    ? { id: bienResolu ? bienResolu.id : null, ref: bookingResolu.property_id }
    : bienResolu
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

  return { ok: true, userId, accountUserId, bien: bienResolu, booking: bookingResolu, contexte }
}

/**
 * Garde pour une action visant un CANAL (channel_id fourni par le client).
 *
 * Le canal ne dit pas a qui il appartient : il faut le demander au gestionnaire
 * de canaux, en tirer le bien, puis verifier les droits sur ce bien. Sans cela,
 * un `channel_id` suffit a agir sur le canal d'un autre compte — y compris a le
 * SUPPRIMER (cas reel : api/channel-bcom-write.js action=delete, et les actions
 * activate/deactivate/delete de api/channel-mapping.js).
 *
 * `channelCall` est fourni par l'appelant : chaque endpoint a le sien, avec sa
 * cle et son URL de base.
 *
 * ⚠ L'appel au gestionnaire de canaux precede necessairement la verification —
 * un appelant peut donc apprendre qu'un channel_id existe. Fuite d'existence
 * residuelle, acceptee : les identifiants ne sont pas devinables et la reponse
 * du provider n'est jamais renvoyee avant le controle.
 */
async function requirePermissionPourCanal(req, res, { channelId, channelCall, domaine = 'reglages', niveau = 'write', userId = null } = {}) {
  if (!channelId) {
    res.status(400).json({ error: 'channel_id requis' })
    return { ok: false }
  }

  let bienDuCanal = null
  try {
    const ch = await channelCall('GET', `/channels/${encodeURIComponent(channelId)}`)
    const attrs = ch?.json?.data?.attributes || {}
    bienDuCanal = Array.isArray(attrs.properties) ? attrs.properties[0] : null
  } catch (e) {
    console.error('[require-permission] lecture canal echec', e.message)
    res.status(502).json({ error: 'Lecture du canal impossible' })
    return { ok: false }
  }

  if (!bienDuCanal) {
    res.status(404).json({ error: 'Canal introuvable ou sans bien rattaché' })
    return { ok: false }
  }

  const garde = await requirePermission(req, res, { domaine, niveau, bien: bienDuCanal, bienRequis: true, userId })
  if (!garde.ok) return { ok: false }
  return { ...garde, bienDuCanal }
}

// UUID_RE / REF_SURE_RE sont exportes pour que les endpoints qui resolvent une
// LISTE de biens (api/calendar.js) trient les identifiants avec EXACTEMENT les
// memes regles qu'ici. Une seconde definition ailleurs finirait par diverger, et
// c'est ce tri qui empeche un non-UUID d'atteindre une colonne uuid.
module.exports = { requirePermission, requirePermissionPourCanal, verifierSession, resoudreBien, resoudreBooking, chargerProfil, UUID_RE, REF_SURE_RE }
