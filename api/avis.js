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
const { refsDuPerimetre, filtrePerimetreSql, peutLire, peutEcrire } = require('../lib/permissions')
const { classerUnAvis } = require('../lib/cron-reviews-classify')
const { ratioProprete, periodeNormalisee, borneDepuis, PERIODES } = require('../lib/stats-avis')
const { chargerGrille, criteresPour, deciderStatut, enregistrerReponses, abandonner, journaliser } = require('../lib/avis/evaluations')
const { GRILLE_DEFAUT, CATEGORIES, REMPLI_PAR, validerGrille, estNegatif } = require('../lib/avis/notes-evaluation')
const { redigerAvis } = require('../lib/avis/redaction')
const { publier, RefusPublication } = require('../lib/avis/publication')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const MAX_LIGNES  = 500
const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ⚠ UN MESSAGE DE `lib/avis` QUI REMONTE A L'ECRAN perd son prefixe « [avis] »,
// fait pour les journaux, et prend une majuscule. Les ecrans affichent `error`
// tel quel (recette du 1er octobre 2026).
function pourLEcran (message) {
  const m = String(message || '').replace(/^\[avis\]\s*/, '')
  return m ? m.charAt(0).toUpperCase() + m.slice(1) : 'Erreur inattendue'
}
const SOURCES     = new Set(['sms', 'email', 'oral'])
const MAX_TEXTE   = 5000

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
  property_id_ref, statut, verdict_source`

// ⚠ LES DATES DE SEJOUR SORTENT SOUS LE DROIT `reservations`, PAS SOUS `avis`.
//
// Elles ne sont pas decoratives : elles disent DE QUEL SEJOUR parle l'avis, et
// sans elles l'ecran n'a que `received_at` a montrer — une date de reception qui
// se lit alors comme une date de sejour. Mais ce sont les dates d'occupation
// d'un bien, exactement ce que le bloc ci-dessus refuse a un membre
// `avis: read` / `reservations: none`, et ce pour quoi l'action `sejours` est
// montee a `write`. Les ajouter a `CHAMPS` rouvrait cette porte par l'autre
// action, avec deux commentaires opposes dans le meme fichier.
//
// La regle tranchee : le CONTENU de l'avis reste sous `avis` ; le SEJOUR qu'il
// designe suit `reservations`. Qui n'a pas ce droit voit « Recu le … », etiquete
// comme tel — l'information reste vraie, elle est seulement moins precise.
// La colonne n'est meme pas SELECTIONNEE dans ce cas : une donnee qu'on ne
// demande pas a la base ne peut pas fuiter plus tard par un oubli d'affichage.
const CHAMPS_AVEC_SEJOUR = `${CHAMPS}, stay_start, stay_end`

// ─── Lecture ────────────────────────────────────────────────────────────────

async function lister (req, res, garde) {
  const userId = garde.accountUserId
  // ⚠ Lue en TETE : le retour « perimetre vide » ci-dessous s'en sert deja.
  //
  // `PERIODES[x] !== undefined` laissait passer 'constructor', '__proto__',
  // 'toString'... — heritees du prototype — et la cle ressortait telle quelle
  // au front, qui affichait « retenus function Object() { [native code] } ».
  //
  // Cette normalisation est aujourd'hui REDONDANTE avec celle de
  // `ratioProprete` et de `borneDepuis` : une mutation qui la supprime ne fait
  // echouer aucun test, c'est verifie. On la garde parce que `periode` sert ici
  // a TROIS choses — le ratio, le filtre de liste, et la reponse au client — et
  // que la seule dont la normalisation serait garantie est la premiere.
  const periode = periodeNormalisee(String(req.query?.periode || ''))
  const refs   = refsDuPerimetre(garde.contexte)
  const filtre = filtrePerimetreSql(refs, 'property_id_ref')
  // Perimetre vide : le membre n'a aucun bien. Ce n'est pas une erreur.
  // `fenetre_jours` DOIT y figurer : la page l'affiche, et son absence donnait
  // « 0 remarque sur undefined j » — precisement au membre dont le perimetre est
  // vide, le cas que cette ligne existe pour traiter proprement.
  if (filtre === '') {
    // La periode DEMANDEE, pas '30j' fige : un membre au perimetre vide qui
    // choisit « 6 mois » lisait « sur 30 jours ».
    return res.status(200).json({
      avis: [], biens: [], periodes: Object.keys(PERIODES),
      ratio: { total: 0, positif: 0, remarque: 0, rien_signale: 0,
               non_analyses: 0, periode, depuis: borneDepuis(periode) }
    })
  }

  // Le bien demande, s'il y en a un, doit appartenir au perimetre : sans cette
  // verification, un membre limite a un bien lirait les avis d'un autre en
  // passant simplement sa reference dans l'URL.
  const bienDemande = req.query?.bien ? String(req.query.bien) : null
  if (bienDemande && refs !== null && !refs.map(String).includes(bienDemande)) {
    return res.status(403).json({ error: 'Bien hors de votre périmètre' })
  }

  // Filtres d'abord, tri et borne ensuite : appliquer un filtre APRES .limit()
  // fonctionne mais se lit mal, et invite a une erreur d'ordre au prochain
  // ajout.
  // ⚠ Ce que fait REELLEMENT cette ligne. `requirePermission` ne rend
  // `contexte: null` que pour `domaine: 'titulaire'` : ici le contexte est
  // toujours renseigne, et c'est `niveauEffectif` qui reconnait le titulaire
  // (`userId === accountUserId` -> tout). Le `!garde.contexte` est une ceinture,
  // pas le mecanisme — ne pas le lire comme la garde du titulaire.
  // La cible est `null` a dessein : on interroge le NIVEAU du domaine, le
  // perimetre des LIGNES etant deja pose par `filtre` / `bienDemande` plus bas.
  // `property_scope` etant unique par profil, le perimetre `reservations` ne
  // peut pas etre plus large que celui d'`avis`.
  const voitSejours = !garde.contexte || peutLire(garde.contexte, 'reservations', null)
  let q = supabase.from('ota_reviews')
    .select(voitSejours ? CHAMPS_AVEC_SEJOUR : CHAMPS).eq('user_id', userId)
    // Les detections ecartees par l'hote disparaissent : il a tranche.
    .neq('statut', 'ignore')
  // ⚠ LA PERIODE FILTRE AUSSI LA LISTE. Sans cela, deux selecteurs voisins et
  // visuellement identiques n'avaient pas la meme portee : la carte annoncait
  // « 2 avis retenus sur 15 jours » au-dessus d'une liste montrant des avis de
  // 2023. L'ecran se contredisait lui-meme.
  const bornePeriode = borneDepuis(periode)
  if (bornePeriode) q = q.gte('received_at', bornePeriode)
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

  // ⚠ Le ratio est calcule par lib/stats-avis.js, la MEME fonction que la fiche
  // prestataire consommera. Deux chiffres calcules differemment pour la meme
  // chose finiraient par se contredire.
  //
  // Il est calcule ICI et non au front : le front ne recoit que les MAX_LIGNES
  // premieres lignes, il ne peut pas compter juste.
  // Le perimetre transmis a la fonction : le bien demande s'il y en a un, sinon
  // les references du perimetre du membre (null = tous les biens du compte).
  const refsRatio = bienDemande ? [bienDemande] : (refs === null ? null : refs.map(String))
  const ratio = await ratioProprete(supabase, { userId, periode, refs: refsRatio })

  return res.status(200).json({
    avis: avis || [],
    biens: biens || [],
    ratio,
    periodes: Object.keys(PERIODES)
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
    return res.status(403).json({ error: 'Bien hors de votre périmètre' })
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
  if (!SOURCES.has(source)) return res.status(400).json({ error: 'Canal de réception invalide' })
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
    return res.status(403).json({ error: 'Bien hors de votre périmètre' })
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

// ─── Validation d'une detection ─────────────────────────────────────────────

const STATUTS_CIBLES = new Set(['confirme', 'ignore'])

async function valider (req, res, garde) {
  const userId = garde.accountUserId
  const id = req.body?.id ? String(req.body.id).trim() : ''
  const statut = req.body?.statut ? String(req.body.statut).trim() : ''

  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Identifiant invalide' })
  if (!STATUTS_CIBLES.has(statut)) return res.status(400).json({ error: 'Statut invalide' })

  // ⚠ La ligne est relue AVANT d'etre modifiee, sur le compte cible et dans le
  // perimetre. Un update direct par id aurait laisse un membre valider une
  // detection d'un bien hors de son perimetre — l'id vient du client
  // (REVIEW.md regle 11).
  const { data: ligne, error: errLire } = await supabase.from('ota_reviews')
    .select('id, statut, property_id_ref')
    .eq('id', id).eq('user_id', userId).maybeSingle()
  if (errLire) return res.status(500).json({ error: 'Lecture impossible' })
  if (!ligne) return res.status(404).json({ error: 'Introuvable' })

  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(String(ligne.property_id_ref))) {
    return res.status(403).json({ error: 'Bien hors de votre périmètre' })
  }

  // On ne valide QUE ce qui est en attente. Reconfirmer un avis OTA n'a pas de
  // sens, et rouvrir une decision deja prise doit etre un geste explicite, pas
  // un effet de bord d'un double clic.
  if (ligne.statut !== 'detecte') {
    return res.status(409).json({ error: 'Cette entrée n\'est pas en attente de validation' })
  }

  const { error } = await supabase.from('ota_reviews')
    .update({ statut }).eq('id', id).eq('user_id', userId)
  if (error) {
    console.error('[avis] validation echec:', error.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }
  return res.status(200).json({ ok: true, statut })
}

// ─── Requalification d'un verdict de proprete ───────────────────────────────

const VERDICTS = new Set(['positif', 'remarque', 'rien_signale'])

async function requalifier (req, res, garde) {
  const userId = garde.accountUserId
  const id = req.body?.id ? String(req.body.id).trim() : ''
  const verdict = req.body?.verdict ? String(req.body.verdict).trim() : ''

  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Identifiant invalide' })
  if (!VERDICTS.has(verdict)) return res.status(400).json({ error: 'Verdict invalide' })

  // ⚠ Relecture AVANT ecriture, sur le compte cible et dans le perimetre :
  // l'id vient du client (REVIEW.md regle 11).
  const { data: ligne, error: errLire } = await supabase.from('ota_reviews')
    .select('id, property_id_ref, ai_clean_verdict, statut, ai_analyzed_at')
    .eq('id', id).eq('user_id', userId).maybeSingle()
  if (errLire) return res.status(500).json({ error: 'Lecture impossible' })
  if (!ligne) return res.status(404).json({ error: 'Introuvable' })

  const refs = refsDuPerimetre(garde.contexte)
  if (refs !== null && !refs.map(String).includes(String(ligne.property_id_ref))) {
    return res.status(403).json({ error: 'Bien hors de votre périmètre' })
  }

  // Seule une ligne RETENUE se requalifie. Une detection en attente se tranche
  // par Confirmer / Ignorer — deux gestes pour la meme decision se
  // contrediraient — et une detection ignoree ne s'affiche plus : la
  // requalifier modifierait le verdict d'une ligne que personne ne voit, et la
  // gelerait en `humain`.
  if (ligne.statut !== 'confirme') {
    return res.status(409).json({
      error: 'Seul un avis retenu se requalifie ; une détection se confirme ou s\'ignore' })
  }

  // ⚠ L'AVIS N'EST JAMAIS SUPPRIME, ni son texte modifie. Seul le verdict
  // change : un avis reste un fait, et le faire disparaitre parce qu'on n'aime
  // pas sa lecture automatique effacerait la parole du voyageur.
  const { error } = await supabase.from('ota_reviews').update({
    ai_clean_verdict:    verdict,
    // `humain` verrouille : ni la classification ni le trigger de reanalyse ne
    // reviendront dessus.
    verdict_source:      'humain',
    verdict_modifie_at:  new Date().toISOString(),
    verdict_modifie_par: garde.userId || null,
    // L'extrait vient du modele : il ne correspond plus au verdict corrige.
    ai_clean_excerpt:    null,
    // ⚠ Un verdict humain EST une analyse. Sans cette ligne, requalifier un avis
    // dont le trigger venait de remettre ai_analyzed_at a null — ce qui arrive
    // des que le poll reecrit le texte — laissait une ligne MORTE : badge
    // « Analyse en cours » a vie, plus de selecteur donc plus de correction
    // possible, et la file ne la reprend jamais puisqu'elle est `humain`.
    ai_analyzed_at:      ligne.ai_analyzed_at || new Date().toISOString()
  }).eq('id', id).eq('user_id', userId)

  if (error) {
    console.error('[avis] requalification echec:', error.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }
  return res.status(200).json({ ok: true, verdict, verdict_source: 'humain' })
}

// ─── Routage ────────────────────────────────────────────────────────────────

// GET evaluations — la liste du perimetre, pour la page /avis.
//
// ⚠ BORNEE ET INDEXEE, JAMAIS UN BALAYAGE. Objectif de 30 000 comptes (spec
// §3) : la requete part de `user_id`, filtre le perimetre par bien en SQL, et
// plafonne. L'index `guest_evaluations_compte_idx` la sert.
async function evaluationsLister (req, res, garde) {
  const userId = garde.accountUserId
  const refs = refsDuPerimetre(garde.contexte)
  const filtre = filtrePerimetreSql(refs, 'property_id_ref')

  // ⚠ UN PERIMETRE VIDE N'EST PAS UNE ERREUR, et ce n'est pas « tout ». Sans ce
  // retour, `filtre === ''` laissait la requete sans clause de perimetre : un
  // membre sans aucun bien aurait vu TOUTES les evaluations du compte.
  if (filtre === '') return res.status(200).json({ evaluations: [], biens: [], etats: ETATS_LISTE })

  const etat = String(req.query?.etat || '').trim()
  if (etat && !ETATS_LISTE.includes(etat)) return res.status(400).json({ error: 'État inconnu' })

  // ⚠ TROIS VALEURS, PAS DEUX. `filtrePerimetreSql` rend `null` pour « tout le
  // compte » (titulaire, ou membre au perimetre complet), `''` pour « aucun
  // bien », et une expression sinon. Les confondre donnerait soit `.or(null)`
  // — qui casse — soit une requete SANS clause de perimetre pour un membre qui
  // n'a droit a rien.
  let requete = supabase.from('guest_evaluations')
    .select('id, booking_uid, property_id, property_id_ref, ota, status, language, '
      + 'deadline_at, published_at, public_text, created_at, updated_at')
    .eq('user_id', userId)
  if (filtre !== null) requete = requete.or(filtre)
  requete = requete.order('created_at', { ascending: false }).limit(MAX_LIGNES)
  if (etat) requete = requete.eq('status', etat)

  const { data, error } = await requete
  if (error) return res.status(503).json({ error: 'Évaluations illisibles', detail: error.message })

  // Les noms de biens, pour que l'ecran n'affiche pas des references provider.
  const { data: biens, error: eBiens } = await supabase.from('properties')
    .select('id, name, provider_property_id').eq('user_id', userId)
  if (eBiens) return res.status(503).json({ error: 'Biens illisibles', detail: eBiens.message })
  const nomDe = new Map((biens || []).map(b => [b.id, b.name]))

  return res.status(200).json({
    // ⚠ LE TEXTE PUBLIC N'EST PAS SERVI DANS UNE LISTE. Il n'y sert a rien, et
    // une liste est ce qui fuite le plus facilement dans une capture d'ecran.
    // Il se lit sur l'evaluation elle-meme, par `action=evaluation`.
    evaluations: (data || []).map(e => ({
      id: e.id, booking_uid: e.booking_uid, ota: e.ota, status: e.status,
      property_id: e.property_id, bien: nomDe.get(e.property_id) || null,
      langue: e.language, echeance: e.deadline_at, publie_le: e.published_at,
      a_un_texte: Boolean(String(e.public_text || '').trim()),
      creee_le: e.created_at,
    })),
    biens: (biens || []).filter(b => refs === null || refs.includes(String(b.provider_property_id)))
      .map(b => ({ id: b.id, nom: b.name })),
    etats: ETATS_LISTE,
  })
}

const ETATS_LISTE = ['a_remplir', 'soumise_prestataire', 'a_valider', 'publiee',
                     'echec_publication', 'expiree', 'abandonnee']

// ─── La configuration de redaction (mots-cles, ton, signature) ──────────────
// Spec §4.7 : elle vit dans /settings, onglet « Avis ». Deux niveaux, comme la
// grille : le compte, et un bien qui le surcharge.

const TONS = new Set(['chaleureux', 'sobre'])

async function configLire (req, res, garde) {
  const userId = garde.accountUserId
  const bien = String(req.query?.property_id || '').trim()
  if (bien && !UUID_RE.test(bien)) return res.status(400).json({ error: 'Identifiant de bien invalide' })
  if (bien && !(await bienAutorise(req, res, garde, bien, false))) return

  const requete = supabase.from('avis_config')
    .select('id, property_id, keywords, tone, signature').eq('user_id', userId)
  const { data, error } = await (bien
    ? requete.or(`property_id.eq.${bien},property_id.is.null`)
    : requete.is('property_id', null))
  if (error) return res.status(503).json({ error: 'Configuration illisible', detail: error.message })

  const liste = data || []
  return res.status(200).json({
    compte: liste.find(c => !c.property_id) || null,
    bien: bien ? (liste.find(c => c.property_id === bien) || null) : null,
    tons: [...TONS],
  })
}

async function configEcrire (req, res, garde) {
  const userId = garde.accountUserId
  const bien = req.body?.property_id ? String(req.body.property_id).trim() : null
  if (bien && !UUID_RE.test(bien)) return res.status(400).json({ error: 'Identifiant de bien invalide' })
  if (bien && !(await bienAutorise(req, res, garde, bien, true))) return
  if (!bien && !peutEcrireAuNiveauCompte(garde)) {
    return res.status(403).json({
      error: 'Les réglages de tout le compte se modifient depuis un périmètre complet. Réglez ceux d’un bien de votre périmètre.',
      motif: 'perimetre_partiel',
    })
  }

  const ton = String(req.body?.tone || 'chaleureux').trim()
  if (!TONS.has(ton)) return res.status(400).json({ error: `Ton inconnu : « ${ton} » (attendu : ${[...TONS].join(' | ')})` })

  // ⚠ LES MOTS-CLES SONT UN VOCABULAIRE, PAS UN CONTENU IMPOSE (garde-fou §3).
  // On les borne pour qu'un copier-coller de roman ne devienne pas le prompt.
  const brut = Array.isArray(req.body?.keywords) ? req.body.keywords : []
  const keywords = brut.map(k => String(k || '').trim()).filter(Boolean).slice(0, 20).map(k => k.slice(0, 40))
  const signature = req.body?.signature ? String(req.body.signature).trim().slice(0, 120) : null

  // ⚠ L'UNICITE EST PARTIELLE : (user_id) quand property_id est nul,
  // (user_id, property_id) sinon. `upsert` ne sait pas viser un index partiel,
  // donc on lit puis on ecrit — et le conflit reste impossible, ces deux index
  // etant les seuls.
  const lecture = supabase.from('avis_config').select('id').eq('user_id', userId)
  const { data: deja, error: eL } = await (bien
    ? lecture.eq('property_id', bien).maybeSingle()
    : lecture.is('property_id', null).maybeSingle())
  if (eL) return res.status(503).json({ error: 'Configuration illisible', detail: eL.message })

  const valeurs = { user_id: userId, property_id: bien, keywords, tone: ton, signature }
  const { error: eE } = deja
    ? await supabase.from('avis_config').update(valeurs).eq('id', deja.id).eq('user_id', userId)
    : await supabase.from('avis_config').insert(valeurs)
  if (eE) return res.status(503).json({ error: 'Configuration non enregistrée', detail: eE.message })

  return res.status(200).json({ ok: true, niveau: bien ? 'bien' : 'compte', mots: keywords.length })
}

// Le bien demande appartient-il au compte, et au perimetre de l'appelant ?
// Rend false APRES avoir repondu : l'appelant s'arrete alors.
async function bienAutorise (req, res, garde, bienId, ecriture) {
  const { data: bien, error } = await supabase.from('properties')
    .select('id, provider_property_id').eq('id', bienId).eq('user_id', garde.accountUserId).maybeSingle()
  if (error) { res.status(500).json({ error: 'Lecture du bien impossible' }); return false }
  if (!bien) { res.status(404).json({ error: 'Bien introuvable' }); return false }
  const cible = { id: bien.id, ref: bien.provider_property_id }
  const ok = ecriture ? peutEcrire(garde.contexte, 'avis', cible) : peutLire(garde.contexte, 'avis', cible)
  if (!ok) { res.status(403).json({ error: 'Ce bien n’est pas dans votre périmètre' }); return false }
  return true
}

// ═══ LA GRILLE D'EVALUATION, REGLEE PAR L'HOTE (spec §4.7) ══════════════════

// ⚠ ECRIRE AU NIVEAU COMPTE EXIGE LE PERIMETRE ENTIER.
// Constat de review : la garde de perimetre etait conditionnee par
// `if (bienDemande)`. Sans `property_id`, on ecrivait donc la ligne de NIVEAU
// COMPTE — celle qui sert a TOUS les biens sans grille propre — sans qu'aucun
// controle de perimetre ne soit fait. Un membre limite a un bien reglait ainsi
// les notes envoyees a Airbnb pour les biens de l'hote, et « criteres: [] »
// suffisait a effacer sa grille.
//
// `refsDuPerimetre` rend `null` quand l'appelant voit tout le compte (titulaire,
// ou membre au perimetre complet). C'est la seule situation ou « le compte » est
// dans son perimetre.
function peutEcrireAuNiveauCompte (garde) {
  return refsDuPerimetre(garde.contexte) === null
}

// GET grille — les criteres du compte et, si un bien est demande, les siens.
async function grilleLire (req, res, garde) {
  const userId = garde.accountUserId
  const bienDemande = String(req.query?.property_id || '').trim()
  if (bienDemande && !UUID_RE.test(bienDemande)) {
    return res.status(400).json({ error: 'Identifiant de bien invalide' })
  }

  // ⚠ LE PERIMETRE S'APPLIQUE AU BIEN DEMANDE. Sans ce controle, un membre
  // limite a un bien lirait la grille d'un autre en passant son identifiant.
  if (bienDemande && !(await bienAutorise(req, res, garde, bienDemande, false))) return

  const requete = supabase.from('avis_criteres')
    .select('id, libelle, categorie, rempli_par, rang, actif, property_id, '
      + 'avis_criteres_niveaux!avis_niveaux_categorie_fk(id, cle, libelle, rang, note, recommande, negatif)')
    .eq('user_id', userId)
  const { data, error } = await (bienDemande
    ? requete.or(`property_id.eq.${bienDemande},property_id.is.null`)
    : requete.is('property_id', null))
  if (error) return res.status(503).json({ error: 'Grille illisible', detail: error.message })

  const ranger = (l) => (l || []).map(c => ({
    id: c.id, libelle: c.libelle, categorie: c.categorie, rempli_par: c.rempli_par,
    rang: c.rang, actif: c.actif, property_id: c.property_id,
    niveaux: [...(c.avis_criteres_niveaux || [])].sort((a, b) => (a.rang || 0) - (b.rang || 0)),
  })).sort((a, b) => (a.rang || 0) - (b.rang || 0))

  const tout = ranger(data)

  // ⚠ COMBIEN DE BIENS ONT LEUR PROPRE GRILLE. L'ecran des reglages ne regle que
  // le niveau compte : sans ce compte, il affirmait « votre grille remplace la
  // grille par defaut sur tous vos biens », ce qui est faux des qu'un bien a la
  // sienne — `grilleDe` fait primer le bien. Constat de review.
  const { data: parBien, error: eParBien } = await supabase.from('avis_criteres')
    .select('property_id').eq('user_id', userId).not('property_id', 'is', null).eq('actif', true)
  if (eParBien) return res.status(503).json({ error: 'Grille illisible', detail: eParBien.message })
  const biensAvecGrille = new Set((parBien || []).map(c => c.property_id)).size

  return res.status(200).json({
    biens_avec_grille: biensAvecGrille,
    compte: tout.filter(c => !c.property_id),
    bien: bienDemande ? tout.filter(c => c.property_id === bienDemande) : [],
    // ⚠ LA GRILLE PAR DEFAUT EST UNE CONSTANTE DU CODE, jamais pre-inseree
    // (decision du 30 septembre 2026 : pas de seed sur 30 000 comptes). L'ecran
    // la montre comme point de depart, et n'ecrit rien tant que l'hote ne
    // change rien.
    defaut: GRILLE_DEFAUT.criteres,
    categories: CATEGORIES,
    rempli_par: REMPLI_PAR,
  })
}

// POST grille-maj — remplace la grille d'UN niveau (compte, ou un bien).
//
// ⚠ PAS DE TRANSACTION DISPONIBLE ICI. PostgREST n'en offre pas, et ajouter une
// fonction Postgres demanderait une migration de plus. On s'en passe par
// l'ORDRE des ecritures, pas en esperant qu'elles aboutissent toutes :
//
//   1. les nouveaux criteres sont crees INACTIFS, avec leurs niveaux ;
//   2. une fois tous ecrits, les anciens sont supprimes ;
//   3. les nouveaux sont actives, en dernier.
//
// Un echec a n'importe quelle etape laisse donc l'ANCIENNE grille en place et,
// au pire, des criteres inactifs — que `grilleDe` ecarte, et qui ne changent
// rien a ce que l'hote evalue. L'inverse (activer d'abord) aurait pu laisser
// une grille a moitie ecrite servir de reference a une vraie evaluation.
async function grilleEcrire (req, res, garde) {
  const userId = garde.accountUserId
  const brut = req.body?.criteres
  const bienDemande = req.body?.property_id ? String(req.body.property_id).trim() : null
  if (!Array.isArray(brut)) return res.status(400).json({ error: 'La grille attendue est une liste de critères' })
  if (brut.length > 40) return res.status(400).json({ error: 'Une grille de plus de 40 critères n’est pas raisonnable' })
  // ⚠ LES NIVEAUX SE BORNENT AUSSI. Constat de review : seuls les criteres
  // l'etaient, donc un seul critere pouvait demander une insertion de taille
  // arbitraire dans `avis_criteres_niveaux`.
  const trop = brut.findIndex(c => Array.isArray(c?.niveaux) && c.niveaux.length > 12)
  if (trop >= 0) return res.status(400).json({ error: `Le critère n°${trop + 1} a plus de 12 niveaux : une question à niveaux n’en demande pas tant` })
  if (bienDemande && !UUID_RE.test(bienDemande)) return res.status(400).json({ error: 'Identifiant de bien invalide' })

  if (bienDemande && !(await bienAutorise(req, res, garde, bienDemande, true))) return
  if (!bienDemande && !peutEcrireAuNiveauCompte(garde)) {
    return res.status(403).json({
      error: 'La grille de tout le compte se règle depuis un périmètre complet. Réglez la grille d’un bien de votre périmètre.',
      motif: 'perimetre_partiel',
    })
  }

  // ⚠ ON VALIDE AVANT D'ECRIRE, avec le MEME module que la publication.
  // Les contraintes de la base refuseraient aussi, mais avec un message
  // Postgres : l'hote a droit a une phrase qui nomme son critere.
  //
  // Les cles de niveaux sont celles que l'hote (ou l'ecran) donne ; les cles de
  // CRITERES sont leurs identifiants en base, poses par Postgres — l'ecran n'en
  // fabrique pas.
  const criteres = brut.map((c, i) => ({
    libelle: String(c?.libelle || '').trim(),
    categorie: String(c?.categorie || '').trim(),
    rempli_par: String(c?.rempli_par || 'hote').trim(),
    rang: Number.isInteger(c?.rang) ? c.rang : i + 1,
    niveaux: Array.isArray(c?.niveaux) ? c.niveaux.map((n, j) => ({
      cle: String(n?.cle || '').trim(),
      libelle: String(n?.libelle || '').trim(),
      rang: Number.isInteger(n?.rang) ? n.rang : j + 1,
      note: n?.note === null || n?.note === undefined || n?.note === '' ? null : Number(n.note),
      ...(n?.recommande === undefined || n?.recommande === null ? {} : { recommande: Boolean(n.recommande) }),
      negatif: Boolean(n?.negatif),
    })) : [],
  }))

  // Une grille VIDE est une demande legitime : « je reviens a la grille par
  // defaut ». On ne la passe donc pas a `validerGrille`, qui la refuserait.
  if (criteres.length) {
    try {
      validerGrille({ criteres: criteres.map((c, i) => ({ ...c, cle: `nouveau-${i}` })) })
    } catch (err) {
      return res.status(400).json({ error: pourLEcran(err.message), motif: 'grille_invalide' })
    }
  }

  // ─── 1. Les nouveaux, INACTIFS, avec leurs niveaux ──────────────────────
  const crees = []
  for (const c of criteres) {
    const { data: critere, error: eC } = await supabase.from('avis_criteres').insert({
      user_id: userId, property_id: bienDemande,
      libelle: c.libelle, categorie: c.categorie, rempli_par: c.rempli_par,
      rang: c.rang, actif: false,
    }).select().single()
    if (eC) {
      await nettoyerCriteres(crees)
      return res.status(400).json({ error: `« ${c.libelle} » refusé : ${eC.message}`, motif: 'critere_refuse' })
    }
    crees.push(critere.id)

    const lignes = c.niveaux.map(n => ({ ...n, critere_id: critere.id, categorie: c.categorie }))
    const { error: eN } = await supabase.from('avis_criteres_niveaux').insert(lignes)
    if (eN) {
      await nettoyerCriteres(crees)
      return res.status(400).json({ error: `Les niveaux de « ${c.libelle} » sont refusés : ${eN.message}`, motif: 'niveaux_refuses' })
    }
  }

  // ─── 2. Les anciens sont DESACTIVES, pas supprimes ──────────────────────
  // ⚠ ON NE SUPPRIME PLUS AVANT D'ACTIVER. Constat de review : l'ordre
  // « supprimer les anciens, puis activer les nouveaux » laissait, si
  // l'activation echouait, un niveau SANS AUCUN critere actif. Or `grilleDe`
  // distingue « aucune ligne » de « toutes eteintes » : des lignes inactives
  // rendent une grille VIDE, pas la grille par defaut. Toutes les evaluations du
  // compte se bloquaient alors sur « une grille sans critere ne publie rien », et
  // la fenetre affichait « aucune question ne vous est ouverte » — une phrase
  // fausse. Le commentaire promettait l'inverse.
  //
  // Desactiver est REVERSIBLE : si l'activation echoue, on rallume les anciens.
  const ciblerAnciens = () => {
    const q = supabase.from('avis_criteres').update({ actif: false }).eq('user_id', userId)
    const parNiveau = bienDemande ? q.eq('property_id', bienDemande) : q.is('property_id', null)
    return crees.length ? parNiveau.not('id', 'in', `(${crees.join(',')})`) : parNiveau
  }
  const { data: anciens, error: eLectureAnciens } = await (() => {
    const q = supabase.from('avis_criteres').select('id').eq('user_id', userId).eq('actif', true)
    const parNiveau = bienDemande ? q.eq('property_id', bienDemande) : q.is('property_id', null)
    return crees.length ? parNiveau.not('id', 'in', `(${crees.join(',')})`) : parNiveau
  })()
  if (eLectureAnciens) {
    await nettoyerCriteres(crees)
    return res.status(503).json({ error: 'L’ancienne grille n’a pas pu être lue', detail: eLectureAnciens.message })
  }
  const idsAnciens = (anciens || []).map(a => a.id)

  const { error: eEteindre } = await ciblerAnciens()
  if (eEteindre) {
    // Rien n'a bouge pour l'hote : les nouveaux sont inactifs, on les retire.
    await nettoyerCriteres(crees)
    return res.status(503).json({ error: 'L’ancienne grille n’a pas pu être retirée', detail: eEteindre.message })
  }

  // ─── 3. Les nouveaux entrent en service ─────────────────────────────────
  if (crees.length) {
    // ⚠ `.select()` POUR COMPTER. Constat de review : un `update` sans `select`
    // ne dit pas combien de lignes il a touchees. Deux enregistrements
    // simultanes pouvaient donc s'effacer l'un l'autre et rendre deux « ok »
    // pendant que le niveau se vidait.
    const { data: actives, error: eActif } = await supabase.from('avis_criteres')
      .update({ actif: true }).in('id', crees).eq('user_id', userId).select('id')
    const compte = (actives || []).length

    if (eActif || compte !== crees.length) {
      // ⚠ RATTRAPAGE : ON RALLUME LES ANCIENS. C'est tout l'interet de les avoir
      // eteints plutot que supprimes. Sans cela, le niveau resterait vide et
      // bloquerait chaque evaluation du compte.
      let rattrape = true
      if (idsAnciens.length) {
        const { error: eRallumer } = await supabase.from('avis_criteres')
          .update({ actif: true }).in('id', idsAnciens).eq('user_id', userId)
        if (eRallumer) {
          rattrape = false
          console.error('[avis] GRILLE VIDE : nouveaux non actives ET anciens non rallumes', userId, eRallumer.message)
        }
      }
      await nettoyerCriteres(crees)
      return res.status(503).json({
        error: rattrape
          ? 'La nouvelle grille n’a pas pu être activée : l’ancienne a été remise en service. Réessayez.'
          : 'La nouvelle grille n’a pas pu être activée ET l’ancienne n’a pas pu être remise : contactez le support.',
        detail: eActif ? eActif.message : `${compte} critere(s) actives sur ${crees.length}`,
        motif: rattrape ? 'activation_echouee' : 'grille_vide',
      })
    }
  }

  // ─── 4. Les anciens, devenus inutiles, s'en vont ─────────────────────────
  // ⚠ UN ECHEC ICI EST SANS CONSEQUENCE : ils sont INACTIFS, donc `grilleDe` les
  // ecarte deja. On le journalise sans faire echouer l'enregistrement, qui a
  // reussi.
  if (idsAnciens.length) {
    const { error: eSuppr } = await supabase.from('avis_criteres')
      .delete().in('id', idsAnciens).eq('user_id', userId)
    if (eSuppr) console.error('[avis] anciens criteres inactifs non supprimes', idsAnciens.join(','), eSuppr.message)
  }

  return res.status(200).json({ ok: true, criteres: crees.length, niveau: bienDemande ? 'bien' : 'compte' })
}

// Retire ce qu'on vient de creer. Les niveaux partent en cascade.
async function nettoyerCriteres (ids) {
  if (!ids || !ids.length) return
  const { error } = await supabase.from('avis_criteres').delete().in('id', ids)
  // ⚠ UN NETTOYAGE RATE NE DISPARAIT PAS. Les criteres restent INACTIFS, donc
  // sans effet sur les evaluations, mais quelqu'un doit pouvoir le savoir.
  if (error) console.error('[avis] criteres inactifs non nettoyes', ids.join(','), error.message)
}

// ═══ EVALUATION DU VOYAGEUR (spec evaluation-voyageur) ══════════════════════
//
// ⚠ TOUT PART DE LA LIGNE EN BASE, JAMAIS DU CORPS DE LA REQUETE (regle 11).
// L'appelant donne un id d'evaluation ; le compte, le bien et le sejour se
// lisent sur la ligne. Un corps qui annonce un autre user_id ne change rien :
// le filtre `.eq('user_id', userId)` vient du jeton, pas de lui.

// Charge l'evaluation du perimetre, ou repond a la place de l'appelant.
// Rend null quand elle a deja repondu — l'appelant s'arrete alors.
async function chargerEvaluation (req, res, garde, ecriture = false) {
  const userId = garde.accountUserId
  const id = String(req.body?.id || req.query?.id || '').trim()
  // ⚠ LE BUS DESIGNE UN SEJOUR, PAS UNE EVALUATION. Le protocole du coeur
  // (docs/kb/protocole-coeur.md) declare `booking_uid` comme seul parametre de
  // `avis.evaluer` et `avis.statut` : une app connait la reservation qu'elle
  // affiche, jamais l'identifiant d'une table du coeur. Les deux voies existent
  // donc, et l'unicite (user_id, booking_uid) garantit qu'elles designent la
  // meme ligne.
  const sejour = String(req.body?.booking_uid || req.query?.booking_uid || '').trim()
  if (!id && !sejour) { res.status(400).json({ error: 'Identifiant ou séjour requis' }); return null }
  if (id && !UUID_RE.test(id)) { res.status(400).json({ error: 'Identifiant invalide' }); return null }
  if (!id && sejour.length > 200) { res.status(400).json({ error: 'Séjour invalide' }); return null }

  const requete = supabase.from('guest_evaluations').select('*').eq('user_id', userId)
  const { data, error } = await (id ? requete.eq('id', id) : requete.eq('booking_uid', sejour)).maybeSingle()
  if (error) { res.status(500).json({ error: 'Lecture impossible' }); return null }
  if (!data) { res.status(404).json({ error: 'Évaluation introuvable' }); return null }

  // ⚠ LE PERIMETRE PAR BIEN, APRES la lecture du compte. Sans lui, un membre
  // limite a un bien evaluerait les voyageurs d'un autre en passant son id.
  //
  // ⚠ ET IL SE PASSE UN OBJET { id, ref }, PAS UNE CHAINE. `dansPerimetre`
  // commence par « if (!bien || (bien.id == null && bien.ref == null)) return
  // true » : sur une chaine, `.id` et `.ref` valent undefined, donc la fonction
  // rendait TRUE inconditionnellement. La garde etait un no-op, et c'est la
  // SEULE garde par bien du chantier — le routeur appelle requirePermission
  // sans `bien`. Un membre limite a un bien publiait un avis Airbnb sur le bien
  // d'a cote. Constat de review.
  //
  // ⚠ ET C'EST `peutEcrire` QUAND L'ACTION ECRIT. Un membre `avis: read` est
  // deja arrete par le routeur, mais lire le perimetre pour autoriser une
  // ecriture dit le contraire de ce qui se passe.
  const cible = { id: data.property_id, ref: data.property_id_ref }
  const autorise = ecriture
    ? peutEcrire(garde.contexte, 'avis', cible)
    : peutLire(garde.contexte, 'avis', cible)
  if (!autorise) {
    res.status(403).json({ error: 'Ce bien n’est pas dans votre périmètre' }); return null
  }
  return data
}

// Le role de l'appelant dans l'evaluation. L'hote est celui qui n'a pas de
// reglage prestataire : eval_scope / eval_power vivent sur `profiles`.
function roleEtReglages (garde) {
  // ⚠ « PRESTATAIRE » VEUT DIRE `access_mode = 'lien'`, PAS « a un profil ».
  // Decision de Thierry du 30 septembre 2026, qui renverse le choix precedent :
  // un MEMBRE du compte avec `avis: write` agit comme l'hote sur son perimetre,
  // validation des avis negatifs comprise. Les regles prestataire — perimetre
  // de questions, pouvoir `soumettre`, garde-fou du negatif — ne s'appliquent
  // qu'aux profils d'acces par LIEN.
  //
  // Le choix d'avant traitait tout membre en prestataire : un gestionnaire
  // voyait quatre actions ouvertes par ses droits et refusees une par une.
  //
  // `access_mode = 'lien'` est la convention du depot, deja exigee par
  // lib/cleaning/notifier-prestataire.js, api/menages-public.js, api/garde.js
  // et api/disponibilites.js. On ne devine pas le role, on le lit.
  const p = garde.contexte?.profil || null
  const estPrestataire = Boolean(p && p.access_mode === 'lien')
  return {
    role: estPrestataire ? 'prestataire' : 'hote',
    // ⚠ UNE VALEUR ABSENTE VAUT `aucun` : une prestataire ne remplit que si
    // l'hote l'y autorise (decision D1 du 2 octobre 2026, migration
    // 2026-10-02-avis-eval-scope-sur-autorisation.sql).
    evalScope: (estPrestataire && p.eval_scope) || 'aucun',
    evalPower: (estPrestataire && p.eval_power) || 'soumettre',
    profilId: (p && p.id) || null,
    // ⚠ `parProfil` N'EST RENSEIGNE QUE POUR UNE PRESTATAIRE, et c'est l'OBJET,
    // pas l'id. lib/avis/publication.js s'en sert pour deux choses : savoir si
    // le declencheur est soumis au garde-fou du negatif, et lire son
    // `eval_power`. Un membre passe donc `null`, comme le titulaire : il
    // valide les negatifs, conformement a la decision ci-dessus.
    parProfil: estPrestataire ? p : null,
  }
}

// GET evaluation — la ligne, la grille qui s'applique, et les seuls criteres
// que ce role a le droit de remplir.
async function evaluationLire (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde)
  if (!e) return
  const { role, evalScope, evalPower } = roleEtReglages(garde)

  // La grille FIGEE si elle existe : une evaluation deja commencee ne change
  // pas de questions en cours de route (§4.4).
  let grille = e.grille_figee && e.grille_figee.criteres && e.grille_figee.criteres.length
    ? e.grille_figee
    : null
  if (!grille) {
    try {
      grille = await chargerGrille(supabase, { userId: e.user_id, propertyId: e.property_id })
    } catch (err) {
      // ⚠ UNE GRILLE ILLISIBLE N'EST PAS UNE GRILLE VIDE — mais elle n'empeche
      // pas de dire OU EN EST l'evaluation. Constat de review : `avis.statut`
      // passe par cette action, donc une grille illisible faisait repondre
      // « indisponible » au bus, et une app masquait son bouton pour une raison
      // sans rapport avec le sejour. On rend donc l'etat, en disant que les
      // questions manquent.
      return res.status(200).json({
        evaluation: {
          id: e.id, status: e.status, ota: e.ota, language: e.language,
          deadline_at: e.deadline_at, published_at: e.published_at,
          ...(roleEtReglages(garde).role === 'hote' ? { booking_uid: e.booking_uid } : {}),
        },
        role: roleEtReglages(garde).role,
        criteres: [],
        peut_publier: false,
        grille_figee: Boolean(e.grille_figee),
        grille_indisponible: true,
        detail: err.message,
      })
    }
  }

  // ⚠ CE QU'ELLE PEUT REMPLIR N'EST PAS CE QU'ELLE PEUT VOIR. `criteresPour`
  // restreignait le formulaire, et la reponse servait quand meme le texte
  // public, la note privee, les reponses de l'hote et l'identifiant du sejour a
  // tout membre. La decision est deja gravee pour la messagerie des
  // prestataires (docs/specs/spec-prestataires-menage.md §6 : l'extrait seul,
  // jamais le nom du voyageur) ; elle vaut ici. Constat de review.
  const commun = {
    id: e.id, status: e.status, ota: e.ota,
    language: e.language, deadline_at: e.deadline_at,
  }
  // ⚠ ET UNE PRESTATAIRE QUI PEUT PUBLIER DOIT AVOIR LU CE QU'ELLE PUBLIE.
  // Decision de Thierry du 30 septembre 2026 : avec le pouvoir `valider`, elle
  // voit le TEXTE PUBLIC avant publication — elle ne publie jamais un texte
  // qu'elle n'a pas lu. La NOTE PRIVEE lui reste fermee dans tous les cas :
  // elle ne part pas dans l'avis public, et elle ne la concerne pas.
  const vue = role === 'hote'
    ? {
        ...commun,
        booking_uid: e.booking_uid,
        public_text: e.public_text, private_note: e.private_note,
        answers_cleaner: e.answers_cleaner, answers_host: e.answers_host,
        published_at: e.published_at,
      }
    : {
        ...commun,
        answers_cleaner: e.answers_cleaner,
        ...(evalPower === 'valider' ? { public_text: e.public_text } : {}),
      }

  // ⚠ `peut_publier` SE REND DES L'OUVERTURE. Constat de review : la fenetre ne
  // l'apprenait que par la reponse a `eval-reponses`. Une prestataire « valider »
  // qui reouvrait une evaluation deja complete et deja redigee n'avait donc aucun
  // bouton de publication : il fallait qu'elle re-enregistre ses reponses pour le
  // faire apparaitre. La spec §11 bis dit « elle relit, puis elle publie ».
  const reponsesToutes = { ...(e.answers_cleaner || {}), ...(e.answers_host || {}) }
  const repondu = (c) => reponsesToutes[c.cle] !== undefined && reponsesToutes[c.cle] !== null && reponsesToutes[c.cle] !== ''
  const ouverts = criteresPour(grille, role, evalScope)
  let negatif = false
  const remplis = (grille.criteres || []).filter(repondu)
  if (remplis.length) { try { negatif = estNegatif(reponsesToutes, { criteres: remplis }) } catch { negatif = true } }
  const decision = deciderStatut({
    role, evalPower, negatif,
    completRole: ouverts.length > 0 && ouverts.every(repondu),
    completTotal: (grille.criteres || []).length > 0 && (grille.criteres || []).every(repondu),
  })

  return res.status(200).json({
    evaluation: vue,
    role,
    criteres: ouverts,
    peut_publier: decision.peutPublier,
    negatif,
    grille_figee: Boolean(e.grille_figee),
  })
}

// POST eval-reponses — enregistre, puis dit ou l'evaluation en est.
async function evaluationRepondre (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde, true)
  if (!e) return
  const { role, evalScope, evalPower, profilId } = roleEtReglages(garde)
  const reponses = req.body?.reponses
  if (!reponses || typeof reponses !== 'object' || Array.isArray(reponses)) {
    return res.status(400).json({ error: 'Réponses manquantes' })
  }

  let r
  try {
    r = await enregistrerReponses(supabase, {
      evaluation: e, reponses, role, evalScope, evalPower, parProfil: profilId,
    })
  } catch (err) {
    // Une saisie refusee est un 400 nomme, pas un 500 muet.
    return res.status(400).json({ error: pourLEcran(err.message) })
  }

  const reponse = {
    ok: true, status: r.decision.statut, peut_publier: r.decision.peutPublier,
    motif: r.decision.motif, complet: r.complet, negatif: r.negatif,
  }

  // ⚠ UNE PRESTATAIRE « VALIDER » NE DOIT JAMAIS TOMBER SUR « TEXTE ABSENT »,
  // ET L'HOTE NON PLUS NE DOIT PAS HERITER D'UNE PAGE BLANCHE.
  // Decision de Thierry du 30 septembre 2026. Des que la prestataire a fini SA
  // part et que rien n'est negatif, le serveur redige. Deux suites possibles :
  //
  //   - ses criteres couvrent toute la grille : elle relit et publie ;
  //   - des criteres de l'hote restent vides : l'evaluation passe a l'hote AVEC
  //     LE TEXTE DEJA REDIGE, et c'est lui qui tranche. Jamais de publication
  //     partielle chez Airbnb.
  //
  // La redaction porte sur ce qui est COCHE : l'hote pourra la relancer une fois
  // sa part remplie, ou modifier le texte a la main.
  //
  // Un avis NEGATIF n'arrive jamais ici : `deciderStatut` l'envoie a l'hote
  // avant, et aucun appel au modele n'est paye.
  const aDejaUnTexte = Boolean(String(e.public_text || '').trim())
  // ⚠ SEUL LE POUVOIR « VALIDER » DECLENCHE LA REDACTION. Une prestataire qui
  // ne fait que soumettre ne publiera pas : l'hote redigera quand il reprendra
  // la main, et rediger ici paierait un appel au modele pour un texte qu'il
  // regenererait sans doute apres avoir rempli sa part.
  if (role === 'prestataire' && evalPower === 'valider' && r.completRole && !r.negatif && !aDejaUnTexte) {
    // ⚠ ON NE DEPEND PAS DE CE QUE L'ECRITURE RENVOIE. `enregistrerReponses`
    // rend la ligne relue, mais si ce retour arrivait vide ou partiel on
    // redigerait sur l'evaluation D'AVANT — donc sans les reponses qu'on vient
    // d'enregistrer, et le refus dirait « aucun critere rempli » juste apres
    // les avoir remplis. On reconstruit donc l'etat attendu, et le retour de la
    // base ne sert qu'a completer.
    const aJour = {
      ...e,
      ...(r.evaluation || {}),
      answers_cleaner: { ...(e.answers_cleaner || {}), ...(role === 'hote' ? {} : reponses) },
      answers_host: { ...(e.answers_host || {}), ...(role === 'hote' ? reponses : {}) },
      grille_figee: (r.evaluation && r.evaluation.grille_figee) || e.grille_figee || r.grille,
    }
    const redige = await redigerEtEnregistrer(aJour)

    if (redige.panne) {
      // Une panne de lecture n'est pas un refus de l'IA : les reponses SONT
      // enregistrees, et le statut ecrit. On le dit sans effacer ce qui a eu
      // lieu, et on ne passe pas l'evaluation a l'hote pour une panne
      // temporaire — un nouvel appel reprendra.
      return res.status(redige.panne.code).json({
        ...redige.panne.body, reponses_enregistrees: true, status: r.decision.statut,
      })
    }

    if (!redige.ok && redige.transitoire) {
      // Une panne du modele : les reponses sont enregistrees, le statut aussi,
      // et l'evaluation reste ou elle est. Un nouvel appel reprendra.
      return res.status(200).json({
        ...reponse,
        redaction: { ok: false, motif: redige.motif, detail: redige.detail, transitoire: true },
      })
    }

    if (!redige.ok) {
      // ⚠ L'IA REFUSE : L'EVALUATION PASSE A L'HOTE, AVEC LA RAISON.
      // Les deux cas prevus : un avis negatif que les garde-fous ne laissent
      // pas rediger, et une langue que la relecture ne couvre pas. Dans les
      // deux, c'est un jugement humain qu'il faut, pas un second essai.
      const { error: eStatut } = await supabase.from('guest_evaluations')
        .update({ status: 'a_valider' }).eq('id', e.id).eq('user_id', e.user_id)
      if (eStatut) console.error('[avis] passage a_valider non ecrit', e.id, eStatut.message)

      // ⚠ ET LA RAISON SURVIT A LA REQUETE. L'ecran de l'hote doit pouvoir dire
      // POURQUOI cette evaluation lui revient, y compris s'il la decouvre le
      // lendemain. Aucune colonne ne porte ce motif : il va au journal du coeur.
      const j = await journaliser(supabase, {
        userId: e.user_id, type: 'avis.redaction_refusee', sujet: e.id,
        charge: { motif: redige.motif, detail: redige.detail, par_profil: profilId, booking_uid: e.booking_uid },
      })
      if (!j.ok) console.error('[avis] refus de redaction non journalise:', j.erreur)

      return res.status(200).json({
        ...reponse,
        status: 'a_valider', peut_publier: false,
        motif: `redaction refusee : ${redige.motif}`,
        redaction: { ok: false, motif: redige.motif, detail: redige.detail },
      })
    }

    // ⚠ ELLE RELIT LE TEXTE PUBLIC, JAMAIS LA NOTE PRIVEE. Decision de Thierry :
    // la note privee ne part pas dans l'avis public et ne la concerne pas.
    reponse.redaction = { ok: true, public_text: redige.public_text }
  }

  return res.status(200).json(reponse)
}

// ─── La redaction, partagee ─────────────────────────────────────────────────
// Appelee par `eval-texte` (l'hote demande un texte) ET par `eval-reponses`
// quand une prestataire « valider » vient de terminer : elle doit relire avant
// de publier, donc le texte doit exister a ce moment-la.
//
// Rend { ok: true, public_text, private_note, negatif }
//   ou { ok: false, motif, detail }            — l'IA refuse, la raison est dite
//   ou { ok: false, panne: { code, body } }    — une lecture a echoue
async function redigerEtEnregistrer (e, { remarque = null, prenom = null } = {}) {
  // ⚠ LES ERREURS DE LECTURE SE LISENT. Constat de review : un `Promise.all`
  // destructure sans `error` faisait disparaitre EN SILENCE les mots-cles, le
  // ton et la signature de l'hote — le texte partait avec les reglages par
  // defaut, et l'hote constatait un ton qui n'est pas le sien sans jamais
  // savoir pourquoi. La meme regle vaut ici que pour la grille.
  const [rConfig, rPresta] = await Promise.all([
    supabase.from('avis_config').select('keywords, tone, signature, property_id')
      .eq('user_id', e.user_id).or(`property_id.eq.${e.property_id},property_id.is.null`),
    // ⚠ LE NOM DE LA PRESTATAIRE VIENT DE LA BASE, PAS DU CORPS DE LA REQUETE.
    // Le garde-fou « son nom n'apparait jamais dans l'avis » (spec §3) ne
    // s'executait pas du tout quand le client omettait le champ : un oubli du
    // front, un autre client ou un appel direct desarmait la garde.
    e.filled_by_profile
      ? supabase.from('profiles').select('first_name').eq('id', e.filled_by_profile).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (rConfig.error) {
    return { ok: false, panne: { code: 503, body: { error: 'Réglages de rédaction illisibles', detail: rConfig.error.message } } }
  }
  if (rPresta.error) {
    return { ok: false, panne: { code: 503, body: { error: 'Profil du remplisseur illisible', detail: rPresta.error.message } } }
  }

  // Le bien surcharge le compte.
  const liste = rConfig.data || []
  const fusion = { ...(liste.find(c => !c.property_id) || {}), ...(liste.find(c => c.property_id) || {}) }

  // ⚠ LA GRILLE FIGEE SI ELLE EXISTE, SINON CELLE DU COMPTE — jamais un repli
  // muet sur la grille par defaut. Sans cela, des reponses a une grille
  // personnalisee sortaient en « reponses_hors_grille », un motif qui accuse
  // les reponses alors que c'est la grille qui manquait.
  let grille = e.grille_figee && e.grille_figee.criteres && e.grille_figee.criteres.length
    ? e.grille_figee
    : null
  if (!grille) {
    try { grille = await chargerGrille(supabase, { userId: e.user_id, propertyId: e.property_id }) }
    catch (err) { return { ok: false, panne: { code: 503, body: { error: 'Grille indisponible', detail: err.message } } } }
  }

  // ⚠ ON REDIGE SUR CE QUI EST COCHE, PAS SUR LA GRILLE ENTIERE. Une
  // prestataire « valider » publie sa part sans attendre l'hote : les criteres
  // reserves a l'hote sont alors vides, et `redigerAvis` — qui exige toutes les
  // reponses de la grille qu'on lui donne — aurait refuse de rediger en
  // accusant les reponses. La sous-grille des criteres REPONDUS dit exactement
  // ce qu'il y a a raconter.
  const reponses = { ...(e.answers_cleaner || {}), ...(e.answers_host || {}) }
  const repondus = (grille.criteres || []).filter(c => {
    const v = reponses[c.cle]
    return v !== undefined && v !== null && v !== ''
  })
  if (!repondus.length) {
    return { ok: false, motif: 'aucune_reponse', detail: 'aucun critere rempli : il n y a rien a rediger' }
  }

  const r = await redigerAvis({
    reponses,
    remarque: remarque ? String(remarque).slice(0, MAX_TEXTE) : null,
    prenom: prenom ? String(prenom).slice(0, 80) : null,
    langue: e.language || 'en',
    prestataire: rPresta.data?.first_name || null,
    config: fusion,
    grille: { ...grille, criteres: repondus },
  })

  // ⚠ UN REFUS DE GARDE-FOU SE DIT. Il ne se deguise pas en texte vide.
  //
  // ⚠ ET UNE PANNE DU MODELE N'EST PAS UN REFUS. Credit Anthropic epuise,
  // fournisseur en vrac : un nouvel essai suffira. La marquer `transitoire`
  // evite de passer l'evaluation a l'hote avec « redaction refusee » pour une
  // indisponibilite de trente secondes — et evite d'ecrire au journal du coeur
  // un refus qui n'en est pas un.
  if (!r.public_text) {
    return {
      ok: false, motif: r.motif, detail: r.detail || null, negatif: r.negatif,
      transitoire: r.motif === 'ia_indisponible',
    }
  }

  // ⚠ UNE ECRITURE PERDUE NE REND PAS 200. Constat de review : sans cette
  // lecture, l'ecran affichait un texte que la base n'avait pas, on cliquait
  // « Publier » et on s'entendait dire qu'il n'y avait pas de texte — avec un
  // appel au modele paye a chaque nouvelle tentative.
  const { error: eTexte } = await supabase.from('guest_evaluations')
    .update({ public_text: r.public_text, private_note: r.private_note })
    .eq('id', e.id).eq('user_id', e.user_id)
  if (eTexte) {
    return { ok: false, panne: { code: 503, body: { error: 'Texte généré mais non enregistré', detail: eTexte.message } } }
  }

  return { ok: true, public_text: r.public_text, private_note: r.private_note, negatif: r.negatif }
}

// POST eval-texte — l'IA redige. Elle ne decide de rien, et son texte reste
// modifiable : on l'enregistre en brouillon, la publication lira le champ.
async function evaluationTexte (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde, true)
  if (!e) return
  if (e.status === 'publiee') return res.status(409).json({ error: 'Évaluation déjà publiée' })

  const { role } = roleEtReglages(garde)
  // Une prestataire RELIT, elle ne redige pas : le serveur redige pour elle au
  // moment ou elle termine son formulaire (voir `eval-reponses`).
  if (role !== 'hote') return res.status(403).json({ error: 'La rédaction revient à l’hôte' })

  const r = await redigerEtEnregistrer(e, { remarque: req.body?.remarque, prenom: req.body?.prenom })
  if (r.panne) return res.status(r.panne.code).json(r.panne.body)
  if (!r.ok) return res.status(422).json({ error: 'Texte non généré', motif: r.motif, detail: r.detail })

  return res.status(200).json({ ok: true, public_text: r.public_text, private_note: r.private_note, negatif: r.negatif })
}

// ─── PUBLIER POUR DE VRAI EST L'EXCEPTION, PAS LA REGLE ─────────────────────
//
// ⚠ LE VERROU A ETE INVERSE LE 30 SEPTEMBRE 2026, decision de Thierry, apres
// mesure. La premiere version demandait une variable pour SIMULER : sur staging,
// publier envoyait donc un vrai POST tant que personne n'avait rien pose. La
// variable a ete posee, et la publication est PARTIE quand meme — un
// deploiement deja construit ne relit pas les variables. Le provider a refuse
// pour une autre raison (« 422 id is invalid »), et c'est la seule chose qui a
// evite l'envoi.
//
// Un garde ouvert par defaut est un accident qui attend une occasion.
//
// Desormais : la publication est SIMULEE partout, SAUF sur la base de
// production, reconnue positivement par sa reference. Une base inconnue, une
// variable absente, une configuration a moitie faite : tout cela SIMULE. On
// echoue ferme.
//
// ⚠ ET L'OBJECTION A CETTE INVERSION A UNE REPONSE. Si la production changeait
// un jour de base Supabase, la simulation y deviendrait active et les avis
// cesseraient de partir. Ce ne serait pas silencieux pour autant : chaque
// publication simulee CRIE dans les journaux, la reponse porte
// `simulation: true`, et l'ecran affiche « publie EN SIMULATION ». L'hote le
// verrait du premier coup d'oeil. Le defaut inverse, lui, ne se voyait nulle
// part — jusqu'a l'avis reel envoye a un vrai voyageur, qui ne se reprend pas.
//
// `AVIS_PUBLICATION_REELLE=1` force l'envoi hors production, pour le jour ou on
// voudra eprouver le vrai chemin contre le Channex de test. Il faut alors le
// demander explicitement, et c'est tout l'objet du renversement.
const PROJET_PRODUCTION = 'cjmrizpdyhrcurmgyrhs'

function baseDeProduction () {
  const projet = String(process.env.SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0]
  return projet === PROJET_PRODUCTION
}

function simulationActive () {
  if (baseDeProduction()) {
    // ⚠ EN PRODUCTION, JAMAIS DE SIMULATION, quoi qu'on ait pose. Une variable
    // de recette egaree sur la prod aurait arrete toutes les publications.
    if (process.env.AVIS_PUBLICATION_SIMULEE === '1') {
      console.error('[avis] AVIS_PUBLICATION_SIMULEE est pose sur la base de PRODUCTION : ignore. Retirez cette variable.')
    }
    return false
  }
  // Hors production : simule, sauf demande explicite du contraire.
  if (process.env.AVIS_PUBLICATION_REELLE === '1') {
    console.warn('[avis] AVIS_PUBLICATION_REELLE=1 hors production : les avis partiront POUR DE VRAI chez le provider.')
    return false
  }
  return true
}

// Le double de provider. Aucun acces reseau : c'est tout son objet. Il rend la
// meme forme que lib/channels/channex.js, et journalise pour qu'une publication
// de recette laisse une trace lisible.
function providerSimule () {
  return {
    async publierAvisVoyageur (reviewId, charge) {
      // ⚠ `console.error`, PAS `console.log`. C'est ce qui rend l'inversion du
      // verrou sans danger : une simulation active la ou elle ne devrait pas
      // l'etre se voit dans les journaux d'erreur, pas noyee dans les traces.
      console.error('[avis] PUBLICATION SIMULEE — rien n est parti chez le provider. POST /reviews/%s/guest_review %s',
        reviewId, JSON.stringify(charge).slice(0, 400))
      return { ok: true, status: 200, json: { data: { id: reviewId, simulation: true } } }
    },
    async lireAvis (reviewId) {
      console.error('[avis] LECTURE SIMULEE — GET /reviews/%s', reviewId)
      return { ok: true, status: 200, is_replied: false, json: { simulation: true } }
    },
  }
}

// POST eval-publier — le seul chemin vers l'OTA.
//
// ⚠ TROIS PROTECTIONS SE SUPERPOSENT ICI, ET AUCUNE NE SUFFIT SEULE :
//   1. le verrou d'unicite, qui empeche deux envois simultanes ;
//   2. la verification de statut dans lib/avis/publication.js ;
//   3. la relecture chez le provider avant toute seconde tentative.
// Chez Airbnb, un avis publie ne se reprend pas.
const VERROU_TTL_MS = 3 * 60 * 1000
const PG_UNICITE = '23505'

async function evaluationPublier (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde, true)
  if (!e) return
  const { parProfil, profilId } = roleEtReglages(garde)

  // ⚠ LA REFERENCE DU PROVIDER SE RESOUT ICI. `ota_review_id` est NOTRE cle
  // primaire dans ota_reviews ; le provider ne connait que
  // `external_review_id`. Envoyer la premiere faisait un 404 a chaque essai.
  if (!e.ota_review_id) {
    return res.status(409).json({ error: 'La plateforme n’a pas encore ouvert d’avis pour ce séjour', motif: 'sans_objet_ota' })
  }
  const { data: objetOta, error: eOta } = await supabase
    .from('ota_reviews').select('external_review_id')
    .eq('id', e.ota_review_id).eq('user_id', e.user_id).maybeSingle()
  if (eOta) return res.status(503).json({ error: 'Référence de la plateforme illisible', detail: eOta.message })
  if (!objetOta?.external_review_id) {
    return res.status(409).json({ error: 'La référence de l’avis chez la plateforme est introuvable', motif: 'reference_ota_absente' })
  }

  // Le texte modifie par l'hote arrive ici : c'est LUI qui part, pas celui de
  // l'IA. La spec veut que la version publiee soit stockee telle quelle.
  const evaluation = {
    ...e,
    ota_review_ref: objetOta.external_review_id,
    ...(req.body?.public_text ? { public_text: String(req.body.public_text).slice(0, MAX_TEXTE) } : {}),
  }

  // ⚠ ON RESERVE LA LIGNE AVANT LE POST, PAR L'UNICITE DE `write_locks.key`.
  // Constat de review : la verification de statut se faisait EN MEMOIRE et le
  // statut n'etait ecrit qu'APRES le retour du provider. Deux onglets, un
  // double clic ou un retour de requete rejoue lisaient tous « a_valider »,
  // franchissaient la porte, et DEUX avis partaient chez Airbnb. L'unicite
  // `(user_id, booking_uid)` protege contre deux lignes, jamais contre deux
  // envois. Meme mecanisme que lib/moteur-creation.js pour le POST CRS.
  const cle = `avis-publier:${e.id}`
  const maintenant = Date.now()
  await supabase.from('write_locks').delete().eq('key', cle)
    .lt('expire_at', new Date(maintenant).toISOString())
  const { error: eVerrou } = await supabase.from('write_locks').insert({
    key: cle, token: String(e.id),
    expire_at: new Date(maintenant + VERROU_TTL_MS).toISOString(),
  })
  if (eVerrou) {
    if (eVerrou.code === PG_UNICITE) {
      return res.status(409).json({ error: 'Une publication est déjà en cours pour cette évaluation', motif: 'deja_en_cours' })
    }
    return res.status(503).json({ error: 'Verrou de publication indisponible', detail: eVerrou.message })
  }
  // ⚠ LE VERROU NE SE RELACHE PAS APRES UN SUCCES. Il expire de lui-meme, et
  // d'ici la le statut `publiee` est ecrit. Le relacher tout de suite rouvrirait
  // la fenetre entre le POST abouti et l'ecriture du statut.
  const relacher = async () => {
    try { await supabase.from('write_locks').delete().eq('key', cle) }
    catch (err) { console.error('[avis] verrou non relache', cle, err.message) }
  }

  // ⚠ PAR `getProvider`, JAMAIS UN CANAL EN DUR. Regle technique du depot, et
  // la ligne porte deja son `provider`. V1 = Airbnb via Channex uniquement,
  // donc aucun bug aujourd'hui ; la regle existe pour le jour ou ce ne sera
  // plus vrai. Constat de review.
  const { getProvider } = require('../lib/channels')
  let canal
  try {
    canal = simulationActive() ? providerSimule() : getProvider(e.provider)
  } catch (err) {
    await relacher()
    return res.status(409).json({ error: `Plateforme inconnue pour ce séjour : ${e.provider}`, motif: 'provider_inconnu' })
  }
  // ⚠ ET IL DOIT SAVOIR PUBLIER UN AVIS. Beds24 n'expose pas l'evaluation du
  // voyageur : un canal sans ces deux methodes doit se dire, pas echouer en
  // « provider.publierAvisVoyageur n est pas une fonction » au milieu du POST.
  if (typeof canal.publierAvisVoyageur !== 'function' || typeof canal.lireAvis !== 'function') {
    await relacher()
    return res.status(409).json({
      error: `Le canal ${e.provider} ne publie pas d’évaluation du voyageur`,
      motif: 'canal_sans_evaluation',
    })
  }

  // ⚠ DEUX ISSUES, ET ELLES NE PASSENT PAS PAR LE MEME CHEMIN.
  // `publier` LEVE un RefusPublication quand rien n'est parti, et RETOURNE un
  // resultat quand l'appel a eu lieu — y compris pour un echec. Confondre les
  // deux ecrirait `status: undefined` sur la ligne.
  let r
  try {
    r = await publier({ evaluation, parProfil, provider: canal })
  } catch (err) {
    await relacher()
    if (err instanceof RefusPublication) {
      // Rien n'est parti chez l'OTA.
      //
      // ⚠ SAUF POUR LE DELAI : un avis hors delai ne redeviendra jamais
      // publiable, et le laisser dans son statut d'avant le ferait relancer
      // indefiniment par la file (status, deadline_at). Spec §6.
      if (err.motif === 'expiree') {
        const { error: eExp } = await supabase.from('guest_evaluations')
          .update({ status: 'expiree' }).eq('id', e.id).eq('user_id', e.user_id)
        if (eExp) console.error('[avis] statut expiree non ecrit', e.id, eExp.message)
      }
      return res.status(409).json({ error: pourLEcran(err.message), motif: err.motif })
    }
    throw err
  }

  const maj = {
    status: r.statut,
    public_text: evaluation.public_text,
    provider_response: r.provider_response || null,
    validated_by_profile: profilId,
  }
  if (r.statut === 'publiee') {
    maj.published_at = r.publie_le
    // ⚠ LES DEUX JUGEMENTS, PAS SEULEMENT LES NOTES. La recommandation est le
    // plus lourd des deux (elle pese sur les reservations futures du voyageur)
    // et elle ne survivait nulle part apres publication. Constat de review.
    maj.scores = {
      categories: r.scores || [],
      ...(r.is_reviewee_recommended === undefined ? {} : { is_reviewee_recommended: r.is_reviewee_recommended }),
    }
  }
  const { error: eMaj } = await supabase.from('guest_evaluations')
    .update(maj).eq('id', e.id).eq('user_id', e.user_id)
  // ⚠ L'AVIS EST PARTI, LA LIGNE NON. C'est le pire cas du chantier : sans ce
  // cri, une republication ulterieure doublerait l'avis chez Airbnb, ou il ne
  // se reprend pas.
  if (eMaj) console.error('[avis] PUBLIE CHEZ L OTA MAIS STATUT NON ECRIT', e.id, eMaj.message)

  if (r.statut !== 'publiee') {
    // ⚠ ON NE RELACHE LE VERROU QUE SI L'ISSUE EST CERTAINE. Quand l'appel est
    // parti sans qu'on sache s'il a abouti, le relacher inviterait a rejouer
    // exactement ce qu'on ignore.
    if (!r.incertain) await relacher()
    return res.status(502).json({
      ok: false, status: r.statut, motif: r.motif,
      // `incertain` veut dire : l'appel est parti, on ignore s'il a abouti.
      // L'ecran doit proposer une VERIFICATION, jamais un second envoi direct.
      incertain: Boolean(r.incertain), rejouer: false,
    })
  }

  // ⚠ L'EVENEMENT NE PEUT PAS ANNULER LA PUBLICATION : l'avis est parti.
  // Mais son echec ne disparait pas non plus.
  const j = await journaliser(supabase, {
    userId: e.user_id, type: 'avis.evaluation_publiee', sujet: e.id,
    charge: { booking_uid: e.booking_uid, ota: e.ota, property_id: e.property_id },
  })
  if (!j.ok) console.error('[avis] evenement non journalise:', j.erreur)

  // ⚠ LA RECETTE DOIT SAVOIR QUE RIEN N'EST PARTI. Un « Avis publie » identique
  // dans les deux modes ferait croire a un envoi reel.
  return res.status(200).json({
    ok: true, status: r.statut, published_at: r.publie_le,
    ...(simulationActive() ? { simulation: true } : {}),
  })
}

// POST eval-abandon — l'hote choisit de ne pas evaluer.
async function evaluationAbandonner (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde, true)
  if (!e) return
  const { role, profilId } = roleEtReglages(garde)
  if (role !== 'hote') return res.status(403).json({ error: 'Seul l’hôte abandonne une évaluation' })
  try {
    const d = await abandonner(supabase, { evaluation: e, parProfil: profilId })
    return res.status(200).json({ ok: true, status: d.status })
  } catch (err) {
    return res.status(409).json({ error: pourLEcran(err.message) })
  }
}

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

  // `requalifier` corrige un verdict de proprete : ecriture.
  if (action === 'requalifier') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' })
    const garde = await requirePermission(req, res, {
      domaine: 'avis', niveau: 'write', compteDelegue: true })
    if (!garde.ok) return
    return await requalifier(req, res, garde)
  }

  // `valider` change l'etat d'une detection : ecriture.
  if (action === 'valider') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' })
    const garde = await requirePermission(req, res, {
      domaine: 'avis', niveau: 'write', compteDelegue: true })
    if (!garde.ok) return
    return await valider(req, res, garde)
  }

  // ⚠ DETTE ASSUMEE, a lire avec le bloc `CHAMPS_AVEC_SEJOUR` en tete de fichier.
  // Celui-ci pose que le SEJOUR suit `reservations` ; `sejours`, lui, sert
  // encore le nom du voyageur ET les dates a un membre `avis: write` /
  // `reservations: none`. Le compromis d'origine (ci-dessous) tient : `write`
  // est deja un cran au-dessus de `read`, et cette action ne sert qu'au
  // formulaire de saisie. Mais les deux regles ne coincident pas, et
  // l'alignement — ajouter `peutLire(ctx, 'reservations', null)` ici — est une
  // decision produit : il retirerait le rattachement a un sejour aux membres
  // qui saisissent des avis sans droit sur les reservations.
  //
  // ⚠ `sejours` exige `write`, pas `read`, alors qu'il ne fait que LIRE.
  // Il renvoie le nom des voyageurs et leurs dates de sejour : en `read`, un
  // membre `avis: read` / `reservations: none` aurait obtenu la liste nominative
  // des occupants d'un bien — une donnee que son profil lui refuse partout
  // ailleurs. Un domaine ne doit pas en ouvrir un autre. Cette action ne sert
  // qu'au formulaire de saisie, deja reserve a `write` : rien n'est perdu.
  if (action === 'create' || action === 'sejours') {
    if (action === 'create' && req.method !== 'POST') {
      return res.status(405).json({ error: 'Méthode non autorisée' })
    }
    const garde = await requirePermission(req, res, {
      domaine: 'avis', niveau: 'write', compteDelegue: true })
    if (!garde.ok) return
    return action === 'create' ? await creer(req, res, garde) : await sejours(req, res, garde)
  }

  // ─── Evaluation du voyageur ───────────────────────────────────────────────
  // Repondre, rediger, publier, abandonner : toutes des ECRITURES.
  const ECRITURES_EVAL = {
    'grille-maj': grilleEcrire,
    'config-maj': configEcrire,
    'eval-reponses': evaluationRepondre,
    'eval-texte': evaluationTexte,
    'eval-publier': evaluationPublier,
    'eval-abandon': evaluationAbandonner,
  }
  if (ECRITURES_EVAL[action]) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' })
    const g = await requirePermission(req, res, {
      domaine: 'avis', niveau: 'write', compteDelegue: true })
    if (!g.ok) return
    return await ECRITURES_EVAL[action](req, res, g)
  }

  const garde = await requirePermission(req, res, {
    domaine: 'avis', niveau: 'read', compteDelegue: true })
  if (!garde.ok) return

  if (action === 'evaluation') return await evaluationLire(req, res, garde)
  if (action === 'grille') return await grilleLire(req, res, garde)
  if (action === 'evaluations') return await evaluationsLister(req, res, garde)
  if (action === 'config') return await configLire(req, res, garde)
  if (action === 'list') return await lister(req, res, garde)
  return res.status(400).json({ error: 'Action inconnue' })
}
