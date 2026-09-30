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
const { refsDuPerimetre, filtrePerimetreSql, peutLire } = require('../lib/permissions')
const { classerUnAvis } = require('../lib/cron-reviews-classify')
const { ratioProprete, periodeNormalisee, borneDepuis, PERIODES } = require('../lib/stats-avis')
const { chargerGrille, criteresPour, enregistrerReponses, abandonner, journaliser } = require('../lib/avis/evaluations')
const { redigerAvis } = require('../lib/avis/redaction')
const { publier, RefusPublication } = require('../lib/avis/publication')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const MAX_LIGNES  = 500
const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
    return res.status(403).json({ error: 'Bien hors de votre perimetre' })
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
    return res.status(403).json({ error: 'Bien hors de votre perimetre' })
  }

  // On ne valide QUE ce qui est en attente. Reconfirmer un avis OTA n'a pas de
  // sens, et rouvrir une decision deja prise doit etre un geste explicite, pas
  // un effet de bord d'un double clic.
  if (ligne.statut !== 'detecte') {
    return res.status(409).json({ error: 'Cette entree n\'est pas en attente de validation' })
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
    return res.status(403).json({ error: 'Bien hors de votre perimetre' })
  }

  // Seule une ligne RETENUE se requalifie. Une detection en attente se tranche
  // par Confirmer / Ignorer — deux gestes pour la meme decision se
  // contrediraient — et une detection ignoree ne s'affiche plus : la
  // requalifier modifierait le verdict d'une ligne que personne ne voit, et la
  // gelerait en `humain`.
  if (ligne.statut !== 'confirme') {
    return res.status(409).json({
      error: 'Seul un avis retenu se requalifie ; une detection se confirme ou s\'ignore' })
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

// ═══ EVALUATION DU VOYAGEUR (spec evaluation-voyageur) ══════════════════════
//
// ⚠ TOUT PART DE LA LIGNE EN BASE, JAMAIS DU CORPS DE LA REQUETE (regle 11).
// L'appelant donne un id d'evaluation ; le compte, le bien et le sejour se
// lisent sur la ligne. Un corps qui annonce un autre user_id ne change rien :
// le filtre `.eq('user_id', userId)` vient du jeton, pas de lui.

// Charge l'evaluation du perimetre, ou repond a la place de l'appelant.
// Rend null quand elle a deja repondu — l'appelant s'arrete alors.
async function chargerEvaluation (req, res, garde) {
  const userId = garde.accountUserId
  const id = String(req.body?.id || req.query?.id || '').trim()
  if (!UUID_RE.test(id)) { res.status(400).json({ error: 'Identifiant invalide' }); return null }

  const { data, error } = await supabase
    .from('guest_evaluations')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) { res.status(500).json({ error: 'Lecture impossible' }); return null }
  if (!data) { res.status(404).json({ error: 'Evaluation introuvable' }); return null }

  // ⚠ LE PERIMETRE PAR BIEN, APRES la lecture du compte. Sans lui, un membre
  // limite a un bien evaluerait les voyageurs d'un autre en passant son id.
  if (!peutLire(garde.contexte, 'avis', data.property_id_ref)) {
    res.status(403).json({ error: 'Ce bien n est pas dans votre perimetre' }); return null
  }
  return data
}

// Le role de l'appelant dans l'evaluation. L'hote est celui qui n'a pas de
// reglage prestataire : eval_scope / eval_power vivent sur `profiles`.
function roleEtReglages (garde) {
  // ⚠ L'HOTE EST LE TITULAIRE, ET LUI SEUL. Pas de profil = titulaire :
  // lib/require-permission.js ne charge un profil que pour les MEMBRES d'un
  // compte, et lib/avis/publication.js pose la meme regle (« parProfil vaut
  // null quand c'est l'HOTE »).
  //
  // Un membre gestionnaire tombe donc du cote « prestataire », avec
  // `eval_power` a `soumettre` par defaut : il remplit, l'hote publie. C'est
  // le sens prudent. Deviner le rôle depuis la presence de `eval_scope`
  // faisait l'inverse — un membre sans reglage devenait hote et publiait.
  const p = garde.contexte?.profil || null
  const estPrestataire = Boolean(p)
  return {
    role: estPrestataire ? 'prestataire' : 'hote',
    evalScope: (p && p.eval_scope) || 'selon_grille',
    evalPower: (p && p.eval_power) || 'soumettre',
    profilId: (p && p.id) || null,
    // ⚠ `parProfil` EST L'OBJET, PAS L'ID, et il vaut NULL pour l'hote.
    // lib/avis/publication.js s'en sert pour deux choses : savoir si le
    // declencheur est une prestataire (donc soumise au garde-fou du negatif),
    // et lire son `eval_power`. Un id passe a sa place ferait croire que
    // l'hote est une prestataire sans pouvoir : il ne publierait plus rien.
    parProfil: p,
  }
}

// GET evaluation — la ligne, la grille qui s'applique, et les seuls criteres
// que ce role a le droit de remplir.
async function evaluationLire (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde)
  if (!e) return
  const { role, evalScope } = roleEtReglages(garde)

  // La grille FIGEE si elle existe : une evaluation deja commencee ne change
  // pas de questions en cours de route (§4.4).
  let grille = e.grille_figee && e.grille_figee.criteres && e.grille_figee.criteres.length
    ? e.grille_figee
    : null
  if (!grille) {
    try {
      grille = await chargerGrille(supabase, { userId: e.user_id, propertyId: e.property_id })
    } catch (err) {
      // Une grille illisible n'est pas une grille vide : on le dit.
      return res.status(503).json({ error: 'Grille indisponible', detail: err.message })
    }
  }

  return res.status(200).json({
    evaluation: {
      id: e.id, status: e.status, booking_uid: e.booking_uid, ota: e.ota,
      language: e.language, deadline_at: e.deadline_at,
      public_text: e.public_text, private_note: e.private_note,
      answers_cleaner: e.answers_cleaner, answers_host: e.answers_host,
      published_at: e.published_at,
    },
    role,
    criteres: criteresPour(grille, role, evalScope),
    grille_figee: Boolean(e.grille_figee),
  })
}

// POST eval-reponses — enregistre, puis dit ou l'evaluation en est.
async function evaluationRepondre (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde)
  if (!e) return
  const { role, evalScope, evalPower, profilId } = roleEtReglages(garde)
  const reponses = req.body?.reponses
  if (!reponses || typeof reponses !== 'object' || Array.isArray(reponses)) {
    return res.status(400).json({ error: 'Reponses manquantes' })
  }

  try {
    const r = await enregistrerReponses(supabase, {
      evaluation: e, reponses, role, evalScope, evalPower, parProfil: profilId,
    })
    return res.status(200).json({
      ok: true, status: r.decision.statut, peut_publier: r.decision.peutPublier,
      motif: r.decision.motif, complet: r.complet, negatif: r.negatif,
    })
  } catch (err) {
    // Une saisie refusee est un 400 nomme, pas un 500 muet.
    return res.status(400).json({ error: err.message })
  }
}

// POST eval-texte — l'IA redige. Elle ne decide de rien, et son texte reste
// modifiable : on l'enregistre en brouillon, la publication lira le champ.
async function evaluationTexte (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde)
  if (!e) return
  if (e.status === 'publiee') return res.status(409).json({ error: 'Evaluation deja publiee' })

  const { role } = roleEtReglages(garde)
  if (role !== 'hote') return res.status(403).json({ error: 'La redaction revient a l hote' })

  const [{ data: config }, { data: bien }] = await Promise.all([
    supabase.from('avis_config').select('keywords, tone, signature, property_id')
      .eq('user_id', e.user_id).or(`property_id.eq.${e.property_id},property_id.is.null`),
    supabase.from('properties').select('name').eq('id', e.property_id).maybeSingle(),
  ])
  // Le bien surcharge le compte.
  const liste = config || []
  const fusion = { ...(liste.find(c => !c.property_id) || {}), ...(liste.find(c => c.property_id) || {}) }

  const r = await redigerAvis({
    reponses: { ...(e.answers_cleaner || {}), ...(e.answers_host || {}) },
    remarque: req.body?.remarque ? String(req.body.remarque).slice(0, MAX_TEXTE) : null,
    prenom: req.body?.prenom ? String(req.body.prenom).slice(0, 80) : null,
    langue: e.language || 'en',
    prestataire: req.body?.prestataire ? String(req.body.prestataire).slice(0, 80) : null,
    config: fusion,
    grille: e.grille_figee || null,
  })

  // ⚠ UN REFUS DE GARDE-FOU SE DIT. Il ne se deguise pas en texte vide : sans
  // ce motif, l'hote verrait un champ blanc sans savoir pourquoi.
  if (!r.public_text) {
    return res.status(422).json({ error: 'Texte non genere', motif: r.motif, detail: r.detail || null, bien: bien?.name || null })
  }

  await supabase.from('guest_evaluations')
    .update({ public_text: r.public_text, private_note: r.private_note })
    .eq('id', e.id).eq('user_id', e.user_id)

  return res.status(200).json({ ok: true, public_text: r.public_text, private_note: r.private_note, negatif: r.negatif })
}

// POST eval-publier — le seul chemin vers l'OTA.
async function evaluationPublier (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde)
  if (!e) return
  const { parProfil, profilId } = roleEtReglages(garde)

  // Le texte modifie par l'hote arrive ici : c'est LUI qui part, pas celui de
  // l'IA. La spec veut que la version publiee soit stockee telle quelle.
  const evaluation = req.body?.public_text
    ? { ...e, public_text: String(req.body.public_text).slice(0, MAX_TEXTE) }
    : e

  const { channex } = require('../lib/channels')

  // ⚠ DEUX ISSUES, ET ELLES NE PASSENT PAS PAR LE MEME CHEMIN.
  // `publier` LEVE un RefusPublication quand rien n'est parti, et RETOURNE un
  // resultat quand l'appel a eu lieu — y compris pour un echec. Confondre les
  // deux ecrirait `status: undefined` sur la ligne.
  let r
  try {
    r = await publier({ evaluation, parProfil, provider: channex })
  } catch (err) {
    if (err instanceof RefusPublication) {
      // Rien n'est parti chez l'OTA. Le statut ne bouge pas, le motif est dit.
      return res.status(409).json({ error: err.message, motif: err.motif })
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
    maj.scores = r.scores || null
  }
  const { error: eMaj } = await supabase.from('guest_evaluations')
    .update(maj).eq('id', e.id).eq('user_id', e.user_id)
  // ⚠ L'AVIS EST PARTI, LA LIGNE NON. C'est le pire cas du chantier : sans ce
  // cri, une republication ulterieure doublerait l'avis chez Airbnb, ou il ne
  // se reprend pas.
  if (eMaj) console.error('[avis] PUBLIE CHEZ L OTA MAIS STATUT NON ECRIT', e.id, eMaj.message)

  if (r.statut !== 'publiee') {
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

  return res.status(200).json({ ok: true, status: r.statut, published_at: r.publie_le })
}

// POST eval-abandon — l'hote choisit de ne pas evaluer.
async function evaluationAbandonner (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde)
  if (!e) return
  const { role, profilId } = roleEtReglages(garde)
  if (role !== 'hote') return res.status(403).json({ error: 'Seul l hote abandonne une evaluation' })
  try {
    const d = await abandonner(supabase, { evaluation: e, parProfil: profilId })
    return res.status(200).json({ ok: true, status: d.status })
  } catch (err) {
    return res.status(409).json({ error: err.message })
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
    if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' })
    const garde = await requirePermission(req, res, {
      domaine: 'avis', niveau: 'write', compteDelegue: true })
    if (!garde.ok) return
    return await requalifier(req, res, garde)
  }

  // `valider` change l'etat d'une detection : ecriture.
  if (action === 'valider') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' })
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
      return res.status(405).json({ error: 'Methode non autorisee' })
    }
    const garde = await requirePermission(req, res, {
      domaine: 'avis', niveau: 'write', compteDelegue: true })
    if (!garde.ok) return
    return action === 'create' ? await creer(req, res, garde) : await sejours(req, res, garde)
  }

  // ─── Evaluation du voyageur ───────────────────────────────────────────────
  // Repondre, rediger, publier, abandonner : toutes des ECRITURES.
  const ECRITURES_EVAL = {
    'eval-reponses': evaluationRepondre,
    'eval-texte': evaluationTexte,
    'eval-publier': evaluationPublier,
    'eval-abandon': evaluationAbandonner,
  }
  if (ECRITURES_EVAL[action]) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' })
    const g = await requirePermission(req, res, {
      domaine: 'avis', niveau: 'write', compteDelegue: true })
    if (!g.ok) return
    return await ECRITURES_EVAL[action](req, res, g)
  }

  const garde = await requirePermission(req, res, {
    domaine: 'avis', niveau: 'read', compteDelegue: true })
  if (!garde.ok) return

  if (action === 'evaluation') return await evaluationLire(req, res, garde)
  if (action === 'list') return await lister(req, res, garde)
  return res.status(400).json({ error: 'Action inconnue' })
}
