// api/avis.js
// Lecture des avis voyageurs et saisie manuelle. Domaine `avis`.
//
// ⚠ Le front ne lit PAS ota_reviews en direct : il passe par ici. La RLS de la
// table protege les acces navigateur, mais c'est cet endpoint qui compose les
// donnees (biens, sejours) et applique le perimetre par bien de facon uniforme.
//
// Actions :
//   list    (avis: read)  — les avis du perimetre, filtrables par bien
//   sejours (avis: read)  — les reservations d'un bien, pour le rattachement
//   create  (avis: write) — un avis recu en direct (SMS, email, oral)

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { refsDuPerimetre, filtrePerimetreSql } = require('../lib/permissions')
const { classerUnAvis } = require('../lib/cron-reviews-classify')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const MAX_LIGNES  = 500
const SOURCES     = new Set(['sms', 'email', 'oral'])
const MAX_TEXTE   = 5000
const FENETRE_JRS = 30

// ⚠ STRICTEMENT LES COLONNES QUE LA PAGE AFFICHE. Rien de plus.
//
// La premiere version renvoyait la ligne quasi entiere, dont `guest_name`,
// `stay_start`, `stay_end`, `booking_uid` et `ota_reservation_id`. Un membre
// `avis: read` / `reservations: none` obtenait ainsi le NOM du voyageur et ses
// dates de sejour — la donnee meme qu'on venait de lui refuser en durcissant
// `sejours`. Fermer une action et laisser la meme donnee sortir par l'autre ne
// ferme rien : le domaine `avis` donne acces au CONTENU des avis, pas a
// l'identite des voyageurs ni a leurs sejours, qui relevent de `reservations`.
//
// `content_private` est retire pour la meme raison de moindre exposition : la
// page ne l'affiche pas, l'extrait de proprete suffit. L'ajouter un jour est une
// decision a prendre, pas un defaut a laisser.
//
// Regle a tenir en modifiant cette liste : une colonne qui n'est pas rendue par
// pages/avis.html n'a rien a y faire.
const CHAMPS = `id, provider, source, ota, content, content_public,
  overall_score, received_at, ai_clean_verdict, ai_clean_excerpt, ai_analyzed_at,
  property_id_ref`

// ─── Lecture ────────────────────────────────────────────────────────────────

async function lister (req, res, garde) {
  const userId = garde.accountUserId
  const refs   = refsDuPerimetre(garde.contexte)
  const filtre = filtrePerimetreSql(refs, 'property_id_ref')
  // Perimetre vide : le membre n'a aucun bien. Ce n'est pas une erreur.
  // `fenetre_jours` DOIT y figurer : la page l'affiche, et son absence donnait
  // « 0 remarque sur undefined j » — precisement au membre dont le perimetre est
  // vide, le cas que cette ligne existe pour traiter proprement.
  if (filtre === '') return res.status(200).json({ avis: [], biens: [], remarques30j: 0, fenetre_jours: FENETRE_JRS })

  // Le bien demande, s'il y en a un, doit appartenir au perimetre : sans cette
  // verification, un membre limite a un bien lirait les avis d'un autre en
  // passant simplement sa reference dans l'URL.
  const bienDemande = req.query?.bien ? String(req.query.bien) : null
  if (bienDemande && refs !== null && !refs.map(String).includes(bienDemande)) {
    return res.status(403).json({ error: 'Bien hors de votre perimetre' })
  }

  // Filtres d'abord, tri et borne ensuite : appliquer un filtre APRES .limit()
  // fonctionne mais se lit mal, et invite a une erreur d'ordre au prochain
  // ajout.
  let q = supabase.from('ota_reviews').select(CHAMPS).eq('user_id', userId)
  if (bienDemande) q = q.eq('property_id_ref', bienDemande)
  else if (filtre) q = q.or(filtre)
  q = q.order('received_at', { ascending: false, nullsFirst: false }).limit(MAX_LIGNES)

  const { data: avis, error } = await q
  if (error) {
    console.error('[avis] lecture echec:', error.message)
    return res.status(500).json({ error: 'Lecture impossible' })
  }

  // Les biens du perimetre, pour le filtre et le formulaire.
  let qb = supabase.from('properties')
    .select('id, name, provider_property_id, provider')
    .eq('user_id', userId)
    // Un bien pas encore provisionne chez le provider n'a pas de reference : il
    // produirait une <option value=""> qui se confond avec « Tous les biens »,
    // et que le formulaire refuserait apres l'avoir presentee comme choisie.
    .not('provider_property_id', 'is', null)
  const filtreBiens = filtrePerimetreSql(refs, 'provider_property_id')
  if (filtreBiens) qb = qb.or(filtreBiens)
  const { data: biens, error: errBiens } = await qb.order('name')
  // ⚠ Une panne n'est pas une absence. Sans ce controle, la page annoncait un
  // succes en affichant « Bien inconnu » sur TOUS les avis, avec un filtre et un
  // formulaire vides.
  if (errBiens) {
    console.error('[avis] lecture des biens echec:', errBiens.message)
    return res.status(500).json({ error: 'Lecture impossible' })
  }

  // Compteur des remarques de proprete sur la fenetre. Calcule ICI et non au
  // front : le front ne voit que les MAX_LIGNES premieres lignes.
  const depuis = new Date(Date.now() - FENETRE_JRS * 24 * 3600 * 1000).toISOString()
  let qc = supabase.from('ota_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('ai_clean_verdict', 'remarque')
  if (bienDemande) qc = qc.eq('property_id_ref', bienDemande)
  else if (filtre) qc = qc.or(filtre)
  const { count } = await qc.gte('received_at', depuis)

  return res.status(200).json({
    avis: avis || [],
    biens: biens || [],
    remarques30j: count || 0,
    fenetre_jours: FENETRE_JRS
  })
}

// Sejours d'un bien, pour le rattachement d'un avis saisi a la main.
// Tout est liste, du plus recent au plus ancien : bookings_snapshot ne garde
// qu'une fenetre de quelques semaines, une fenetre supplementaire ici n'aurait
// aucun effet. La liste s'allongera avec l'import de l'historique.
async function sejours (req, res, garde) {
  const userId = garde.accountUserId
  const bien = req.query?.bien ? String(req.query.bien) : null
  if (!bien) return res.status(400).json({ error: 'bien requis' })

  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(bien)) {
    return res.status(403).json({ error: 'Bien hors de votre perimetre' })
  }

  const { data, error } = await supabase.from('bookings_snapshot')
    .select('booking_id, snapshot')
    .eq('user_id', userId).eq('property_id', bien)
    .limit(MAX_LIGNES)
  if (error) {
    console.error('[avis] sejours echec:', error.message)
    return res.status(500).json({ error: 'Lecture impossible' })
  }

  const liste = (data || []).map(b => ({
    booking_uid: String(b.booking_id),
    arrival:     b.snapshot?.arrival || null,
    departure:   b.snapshot?.departure || null,
    nom:         [b.snapshot?.firstName, b.snapshot?.lastName].filter(Boolean).join(' ').trim() || null,
    source:      b.snapshot?.source || null
  }))
  // Tri decroissant sur l'arrivee, les sejours sans date en fin.
  liste.sort((a, b) => (b.arrival || '').localeCompare(a.arrival || ''))
  return res.status(200).json({ sejours: liste })
}

// ─── Saisie manuelle ────────────────────────────────────────────────────────

async function creer (req, res, garde) {
  const userId = garde.accountUserId
  const body = req.body || {}

  const bienRef = body.bien ? String(body.bien).trim() : ''
  const texte   = body.texte ? String(body.texte).trim() : ''
  const source  = body.source ? String(body.source).trim().toLowerCase() : ''
  const date    = body.date ? String(body.date).trim() : ''

  if (!bienRef) return res.status(400).json({ error: 'Choisissez un bien' })
  if (!texte)   return res.status(400).json({ error: 'Le texte de l\'avis est vide' })
  if (texte.length > MAX_TEXTE) return res.status(400).json({ error: 'Texte trop long' })
  if (!SOURCES.has(source)) return res.status(400).json({ error: 'Canal de reception invalide' })
  // ⚠ La FORME ne suffit pas : '2026-13-45' passe le regex, puis new Date()
  // rend Invalid Date et .toISOString() leve un RangeError — 500 au lieu de 400,
  // et l'appelant croit a une panne serveur alors que c'est sa saisie.
  let recuLe = null
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date invalide' })
    const d = new Date(date + 'T12:00:00Z')
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Date invalide' })
    // ⚠ V8 REPORTE en silence : '2026-02-30' devient le 2 mars, '2026-04-31' le
    // 1er mai. Sans ce controle, une date qui n'existe pas etait acceptee et
    // stockee decalee — donnee fausse dans le coeur, jamais signalee.
    if (d.toISOString().slice(0, 10) !== date) {
      return res.status(400).json({ error: 'Date invalide' })
    }
    recuLe = d.toISOString()
  }

  // ⚠ Le bien est resolu EN BASE, sur le compte cible, et son perimetre est
  // verifie. La reference vient du client : elle ne designe rien tant qu'elle
  // n'a pas ete confrontee (REVIEW.md regle 11).
  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(bienRef)) {
    return res.status(403).json({ error: 'Bien hors de votre perimetre' })
  }
  const { data: bien, error: errBien } = await supabase.from('properties')
    .select('id, user_id, provider_property_id')
    .eq('user_id', userId).eq('provider_property_id', bienRef).limit(2)
  if (errBien) return res.status(500).json({ error: 'Lecture impossible' })
  if (!bien || bien.length === 0) return res.status(404).json({ error: 'Bien introuvable' })
  if (bien.length > 1) return res.status(409).json({ error: 'Bien ambigu, contactez le support' })

  const ligne = {
    user_id:            userId,
    property_id:        bien[0].id,
    property_id_ref:    bien[0].provider_property_id,
    provider:           'manuel',
    source,
    ota:                'direct',
    // UUID : deux voyageurs peuvent dire la meme chose, une empreinte du
    // contenu les confondrait. Le double clic est garde au formulaire.
    external_review_id: (globalThis.crypto?.randomUUID?.() || require('crypto').randomUUID()),
    content:            texte,
    content_public:     texte,
    // Un avis recu en direct n'a ni note OTA, ni tags, ni retour prive : ces
    // colonnes restent nulles. C'est ce qui envoie la classification
    // directement a l'etage 2, le texte etant le seul signal disponible.
    received_at:        recuLe || new Date().toISOString()
  }

  // Rattachement optionnel a un sejour : il remplit l'ancrage temporel dont le
  // pricing et la fiche prestataire ont besoin.
  const bookingUid = body.booking_uid ? String(body.booking_uid).trim() : ''
  if (bookingUid) {
    const { data: snap } = await supabase.from('bookings_snapshot')
      .select('booking_id, snapshot')
      .eq('user_id', userId).eq('property_id', bienRef).eq('booking_id', bookingUid)
      .maybeSingle()
    // Un sejour introuvable ou d'un autre bien n'est pas une erreur bloquante :
    // l'avis est saisi sans ancrage plutot que perdu.
    if (snap) {
      ligne.booking_uid = String(snap.booking_id)
      ligne.stay_start  = snap.snapshot?.arrival   || null
      ligne.stay_end    = snap.snapshot?.departure || null
    }
  }

  const { data: cree, error } = await supabase.from('ota_reviews')
    .insert(ligne).select('id, external_review_id').single()
  if (error) {
    console.error('[avis] insert echec:', error.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }

  // Classification AU FIL DE L'EAU : l'hote qui vient de saisir un avis doit
  // voir son verdict tout de suite, pas au prochain cycle de cron. Un echec
  // n'est pas bloquant — ai_analyzed_at reste null, le cron reprendra.
  let verdict = null
  try {
    verdict = await classerUnAvis(supabase, { ...ligne, id: cree.id })
  } catch (e) {
    console.error('[avis] classification immediate echec:', e.message)
  }

  return res.status(201).json({ ok: true, id: cree.id, verdict: verdict ? verdict.verdict : null })
}

// ─── Routage ────────────────────────────────────────────────────────────────

module.exports = async function handler (req, res) {
  try {
    return await router(req, res)
  } catch (e) {
    // Filet global, comme api/menages.js. Sans lui, une exception imprevue
    // (date invalide, reponse provider inattendue) sortait en crash de fonction
    // Vercel : 500 nu, aucun message exploitable, et l'appelant croyait a une
    // panne serveur alors que sa saisie etait en cause.
    console.error('[avis] exception:', e && e.message)
    if (!res.headersSent) return res.status(500).json({ error: 'Erreur serveur' })
  }
}

async function router (req, res) {
  const action = String(req.query?.action || req.body?.action || 'list')

  // ⚠ `sejours` exige `write`, pas `read`, alors qu'il ne fait que LIRE.
  // Il renvoie le nom des voyageurs et leurs dates de sejour : en `read`, un
  // membre `avis: read` / `reservations: none` aurait obtenu la liste nominative
  // des occupants d'un bien — une donnee que son profil lui refuse partout
  // ailleurs. Un domaine ne doit pas en ouvrir un autre. Cette action ne sert
  // qu'au formulaire de saisie, deja reserve a `write` : rien n'est perdu.
  if (action === 'create' || action === 'sejours') {
    if (action === 'create' && req.method !== 'POST') {
      return res.status(405).json({ error: 'Methode non autorisee' })
    }
    const garde = await requirePermission(req, res, {
      domaine: 'avis', niveau: 'write', compteDelegue: true })
    if (!garde.ok) return
    return action === 'create' ? await creer(req, res, garde) : await sejours(req, res, garde)
  }

  const garde = await requirePermission(req, res, {
    domaine: 'avis', niveau: 'read', compteDelegue: true })
  if (!garde.ok) return

  if (action === 'list') return await lister(req, res, garde)
  return res.status(400).json({ error: 'Action inconnue' })
}
