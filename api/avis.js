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
const { ratioProprete, noteMoyenne, periodeNormalisee, borneDepuis, PERIODES } = require('../lib/stats-avis')
const { assemblerCartes } = require('../lib/avis/cartes')
const { origineALaPublication, ecrireAvecOrigine } = require('../lib/avis/origine')
const { chargerGrille, criteresPour, deciderStatut, enregistrerReponses, abandonner, journaliser, hoteARepondu, marquerEvalueeAilleurs } = require('../lib/avis/evaluations')
const { GRILLE_DEFAUT, CATEGORIES, REMPLI_PAR, validerGrille, estNegatif } = require('../lib/avis/notes-evaluation')
const { redigerAvis } = require('../lib/avis/redaction')
const { publier, RefusPublication } = require('../lib/avis/publication')
// Naissance 1 : la prestataire ouvre ses questions apres « Menage fait » (decision D2).
const { assurerEvaluation, echeanceDuDepart } = require('../lib/avis/naissance')
// Lot 6 : l'hote est prevenu quand la prestataire a rempli sa part (spec §10).
const { prevenirHote } = require('../lib/avis/notifications')
const { normaliserHeures, lireHeures, HEURES_MIN, HEURES_MAX } = require('../lib/avis/auto-validation')

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
      + 'deadline_at, published_at, public_text, ota_review_id, created_at, updated_at')
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

  const { sejours: contexte, avis: avisDe } = await contexteDesSejours(userId, data || [])

  return res.status(200).json({
    // ⚠ CHAQUE LIGNE DIT LE SEJOUR (demande de Thierry du 2 octobre 2026 au
    // soir) : le voyageur, les dates, le bien, qui a fait le menage, son avis
    // s'il est visible, et le notre s'il est publie. Notre texte n'est servi
    // qu'une fois PUBLIE — il est alors public chez Airbnb ; un brouillon reste
    // dans la fenetre d'evaluation, par `action=evaluation`.
    evaluations: (data || []).map(e => {
      const c = contexte.get(String(e.booking_uid)) || {}
      return {
        id: e.id, booking_uid: e.booking_uid, ota: e.ota, status: e.status,
        property_id: e.property_id, bien: nomDe.get(e.property_id) || null,
        langue: e.language, echeance: e.deadline_at, publie_le: e.published_at,
        a_un_texte: Boolean(String(e.public_text || '').trim()),
        creee_le: e.created_at,
        voyageur: c.voyageur || null,
        arrivee: c.arrivee || null, depart: c.depart || null,
        menage_par: c.menagePar || null,
        avis_voyageur: (e.ota_review_id && avisDe.get(e.ota_review_id)) || null,
        notre_avis: e.status === 'publiee' ? (e.public_text || null) : null,
      }
    }),
    biens: (biens || []).filter(b => refs === null || refs.includes(String(b.provider_property_id)))
      .map(b => ({ id: b.id, nom: b.name })),
    etats: ETATS_LISTE,
  })
}

// Les sejours d'une liste de reservations : voyageur, dates, et qui a fait le
// menage. Lectures GROUPEES par paquets (une liste `in` de plusieurs centaines
// d'identifiants depasserait la longueur d'URL), toutes cloisonnees au compte.
// ⚠ UNE PANNE ICI N'EMPECHE PAS LA LISTE : les champs manquent, l'hote voit ses
// cartes — la raison va au journal.
const PAQUET_UIDS = 100
async function sejoursDe (userId, uidsBruts) {
  const parSejour = new Map()
  const uids = [...new Set((uidsBruts || []).filter(Boolean).map(String))]
  if (!uids.length) return parSejour
  const paquets = []
  for (let i = 0; i < uids.length; i += PAQUET_UIDS) paquets.push(uids.slice(i, i + PAQUET_UIDS))
  const lire = async (fabrique) => {
    const rs = await Promise.all(paquets.map(fabrique))
    const ko = rs.find(r => r.error)
    return ko ? { data: null, error: ko.error } : { data: rs.flatMap(r => r.data || []), error: null }
  }
  const [snaps, menages] = await Promise.all([
    lire(p => supabase.from('bookings_snapshot').select('booking_id, snapshot').eq('user_id', userId).in('booking_id', p)),
    // Le menage le plus RECENT d'un depart donne le nom (un ordre, pour que ce
    // soit le meme a chaque lecture).
    lire(p => supabase.from('menages').select('booking_id, provider_id, status, created_at').eq('user_id', userId).in('booking_id', p).neq('status', 'cancelled')
      .order('created_at', { ascending: true })),
  ])
  for (const [nom, r] of [['reservations', snaps], ['menages', menages]]) {
    if (r.error) console.error(`[avis] liste : ${nom} illisibles`, r.error.message)
  }
  for (const s of snaps.data || []) {
    const sp = s.snapshot || {}
    const prenom = String(sp.firstName || '').trim()
    const nom = String(sp.lastName || '').trim()
    parSejour.set(String(s.booking_id), {
      voyageur: (prenom || nom) ? { prenom: prenom || null, nom: nom || null } : null,
      arrivee: sp.arrival ? String(sp.arrival).slice(0, 10) : null,
      depart: sp.departure ? String(sp.departure).slice(0, 10) : null,
    })
  }
  // Qui a fait le menage : la prestataire du menage de ce depart.
  const menagesTries = (menages.data || []).slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
  const prov = [...new Set(menagesTries.map(m => m.provider_id).filter(Boolean))]
  const { data: personnes, error: eP } = prov.length
    ? await supabase.from('profiles').select('id, first_name, last_name').eq('account_user_id', userId).in('id', prov)
    : { data: [], error: null }
  if (eP) console.error('[avis] liste : prestataires illisibles', eP.message)
  const nomDePersonne = new Map((personnes || []).map(p => [p.id, [p.first_name, p.last_name].filter(Boolean).join(' ')]))
  for (const m of menagesTries) {
    const c = parSejour.get(String(m.booking_id)) || {}
    if (m.provider_id && nomDePersonne.get(m.provider_id)) c.menagePar = nomDePersonne.get(m.provider_id)
    parSejour.set(String(m.booking_id), c)
  }
  return parSejour
}

// Le contexte des sejours d'une liste d'evaluations : les sejours (ci-dessus)
// et l'avis du voyageur, s'il est visible.
async function contexteDesSejours (userId, evaluations) {
  const avisDe = new Map()
  const uids = [...new Set(evaluations.map(e => String(e.booking_uid)))]
  if (!uids.length) return { sejours: new Map(), avis: avisDe }
  const objets = [...new Set(evaluations.map(e => e.ota_review_id).filter(Boolean))]
  const [parSejour, avis] = await Promise.all([
    sejoursDe(userId, uids),
    // ⚠ LA VISIBILITE SE LIT DANS LE BRUT, STRICTEMENT (revue de 5497a67, vie
    // privee) : la colonne `is_hidden` est normalisee par le writer, un champ
    // absent y devient « visible ». Meme regle que le rangement automatique.
    objets.length
      ? supabase.from('ota_reviews').select('id, content_public, overall_score, guest_name, cache:raw->attributes->is_hidden').eq('user_id', userId).in('id', objets)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (avis.error) console.error('[avis] liste : avis illisibles', avis.error.message)
  // L'avis du voyageur, SEULEMENT s'il est visible : un avis cache chez Airbnb
  // ne se montre pas ici non plus.
  for (const a of avis.data || []) {
    avisDe.set(a.id, a.cache === false
      ? { visible: true, texte: a.content_public || null, note: a.overall_score ?? null }
      : { visible: false })
  }
  for (const e of evaluations) {
    const c = parSejour.get(String(e.booking_uid)) || {}
    if (!c.voyageur && e.ota_review_id) {
      const g = (avis.data || []).find(a => a.id === e.ota_review_id)
      // Le nom porte par l'avis complete un sejour sans reservation dans le coeur.
      if (g && g.guest_name) {
        const [prenom, ...reste] = String(g.guest_name).trim().split(/\s+/)
        c.voyageur = { prenom: prenom || null, nom: reste.join(' ') || null }
      }
    }
    parSejour.set(String(e.booking_uid), c)
  }
  return { sejours: parSejour, avis: avisDe }
}

// GET cartes — UNE CARTE PAR SEJOUR, pour tous les avis (recette de Thierry du
// 7 octobre 2026, points A a E). Les avis recus et nos evaluations, assembles
// par lib/avis/cartes.js en trois sections : en attente de notation, recents
// (20 jours), anciens (servis seulement sur demande, `anciens=1`).
//
// ⚠ MEMES GARDES QUE `list` ET `evaluations` : domaine `avis` en lecture,
// perimetre par bien en SQL, le sejour (nom, dates) d'un avis seul au droit
// `reservations` seulement.
// ⚠ LES COMPTEURS PORTENT SUR TOUTE LA PERIODE, calcules par la base
// (lib/stats-avis.js) : jamais sur les lignes servies.
const MAX_AVIS_CARTES = 5000
const MAX_EVALS_CARTES = 2000
const PAGE_AVIS = 1000
async function cartesLister (req, res, garde) {
  const userId = garde.accountUserId
  const periode = periodeNormalisee(String(req.query?.periode || ''))
  const refs = refsDuPerimetre(garde.contexte)
  const filtre = filtrePerimetreSql(refs, 'property_id_ref')
  const vide = { attente: [], recents: [], anciens: [] }
  if (filtre === '') {
    return res.status(200).json({ cartes: vide, anciens_total: 0, biens: [], periodes: Object.keys(PERIODES),
      stats: { total: 0, positif: 0, remarque: 0, moyenne: null, notes: 0, periode, depuis: borneDepuis(periode) } })
  }
  const bienDemande = req.query?.bien ? String(req.query.bien) : null
  if (bienDemande && refs !== null && !refs.map(String).includes(bienDemande)) {
    return res.status(403).json({ error: 'Bien hors de votre périmètre' })
  }
  const voitSejours = !garde.contexte || peutLire(garde.contexte, 'reservations', null)
  const avecAnciens = String(req.query?.anciens || '') === '1'

  // Les evaluations du perimetre. ⚠ `origine_texte` arrive avec la migration du
  // 8 octobre : avant elle, on relit sans, et l'origine se deduit du statut.
  const champsEval = 'id, booking_uid, property_id, property_id_ref, ota, status, deadline_at, published_at, public_text, ota_review_id, created_at'
  const lireEvals = (champs) => {
    let q = supabase.from('guest_evaluations').select(champs).eq('user_id', userId)
    if (bienDemande) q = q.eq('property_id_ref', bienDemande)
    else if (filtre !== null) q = q.or(filtre)
    return q.order('created_at', { ascending: false }).limit(MAX_EVALS_CARTES)
  }
  let ev = await lireEvals(`${champsEval}, origine_texte`)
  if (ev.error && /origine_texte/.test(ev.error.message || '')) ev = await lireEvals(champsEval)
  if (ev.error) return res.status(503).json({ error: 'Évaluations illisibles', detail: ev.error.message })

  // Les avis du perimetre, PAGINES (jamais tronques en silence a 1000 lignes).
  const avis = []
  for (let debut = 0; debut < MAX_AVIS_CARTES; debut += PAGE_AVIS) {
    let q = supabase.from('ota_reviews')
      // ⚠ Sans le droit `reservations`, le nom et les dates ne sont meme pas
      // LUS (regle de CHAMPS_AVEC_SEJOUR) ; la reservation reste lue, elle range
      // l'avis dans la carte de son sejour.
      .select(`${CHAMPS}, booking_uid, ${voitSejours ? 'stay_start, stay_end, guest_name, ' : ''}cache:raw->attributes->is_hidden`)
      .eq('user_id', userId).neq('statut', 'ignore')
    if (bienDemande) q = q.eq('property_id_ref', bienDemande)
    else if (filtre) q = q.or(filtre)
    const { data, error } = await q.order('received_at', { ascending: false, nullsFirst: false }).order('id', { ascending: true })
      .range(debut, debut + PAGE_AVIS - 1)
    if (error) {
      console.error('[avis] cartes : lecture echec:', error.message)
      return res.status(500).json({ error: 'Lecture impossible' })
    }
    avis.push(...(data || []))
    if (!data || data.length < PAGE_AVIS) break
  }
  // Une borne atteinte se DIT, jamais en silence (revue de ed445b2).
  const avisTronques = avis.length >= MAX_AVIS_CARTES

  const { data: biens, error: eBiens } = await supabase.from('properties')
    .select('id, name, provider_property_id, provider').eq('user_id', userId)
    .not('provider_property_id', 'is', null).order('name')
  if (eBiens) return res.status(500).json({ error: 'Lecture impossible' })
  const nomParId = new Map((biens || []).map(b => [b.id, b.name]))
  const nomParRef = new Map((biens || []).map(b => [String(b.provider_property_id), b.name]))
  const nomBien = (id, ref) => (id && nomParId.get(id)) || (ref && nomParRef.get(String(ref))) || null

  // Les sejours, pour les seules cartes servies : on assemble une premiere fois
  // sans eux pour savoir lesquelles partent, puis on lit leurs sejours.
  const maintenant = Date.now()
  const sansSejours = assemblerCartes({ evaluations: ev.data || [], avis, nomBien, voitSejours, maintenant })
  const servies = [...sansSejours.attente, ...sansSejours.recents, ...(avecAnciens ? sansSejours.anciens : [])]
  const uids = servies.map(c => (c.cle.startsWith('sejour:') ? c.cle.slice(7) : null)).filter(Boolean)
  const sejours = await sejoursDe(userId, uids)
  const cartes = assemblerCartes({ evaluations: ev.data || [], avis, sejours, nomBien, voitSejours, maintenant })

  const refsStats = bienDemande ? [bienDemande] : (refs === null ? null : refs.map(String))
  const [ratio, moy] = await Promise.all([
    ratioProprete(supabase, { userId, periode, refs: refsStats }),
    noteMoyenne(supabase, { userId, periode, refs: refsStats }),
  ])
  const anciensTotal = cartes.anciens.length
  return res.status(200).json({
    cartes: { attente: cartes.attente, recents: cartes.recents, anciens: avecAnciens ? cartes.anciens.slice(0, MAX_LIGNES) : null },
    anciens_total: anciensTotal,
    anciens_tronques: avecAnciens && anciensTotal > MAX_LIGNES,
    // La liste lue a atteint une borne : des cartes anciennes peuvent manquer.
    liste_incomplete: avisTronques || (ev.data || []).length >= MAX_EVALS_CARTES,
    biens: (biens || []).filter(b => refs === null || refs.map(String).includes(String(b.provider_property_id)))
      .map(b => ({ name: b.name, provider_property_id: b.provider_property_id })),
    periodes: Object.keys(PERIODES),
    stats: { ...ratio, moyenne: moy.moyenne, notes: moy.notes, ...(moy.erreur ? { erreur: true } : {}) },
  })
}

const ETATS_LISTE = ['a_remplir', 'soumise_prestataire', 'a_valider', 'publiee',
                     'echec_publication', 'expiree', 'abandonnee', 'evaluee_ailleurs']

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

// ─── LA PUBLICATION AUTOMATIQUE, BIEN PAR BIEN (spec §10 bis) ───────────────
// Decision de Thierry du 2 octobre 2026 au soir (option A) : une ligne par
// bien, un interrupteur et un delai. `avis_auto_validation`, writer unique ici.
//
// GET auto-validation — les biens du PERIMETRE, chacun avec son reglage et le
// droit de le changer.
async function autoValidationLire (req, res, garde) {
  const userId = garde.accountUserId
  const { data: biens, error } = await supabase.from('properties')
    .select('id, name, provider_property_id').eq('user_id', userId).order('name', { ascending: true })
  if (error) return res.status(503).json({ error: 'Biens illisibles', detail: error.message })
  const visibles = (biens || []).filter(b => peutLire(garde.contexte, 'avis', { id: b.id, ref: b.provider_property_id }))
  const { data: lignes, error: eL } = visibles.length
    ? await supabase.from('avis_auto_validation').select('property_id, heures')
      .eq('user_id', userId).in('property_id', visibles.map(b => b.id))
    : { data: [], error: null }
  if (eL) return res.status(503).json({ error: 'Réglages illisibles', detail: eL.message })
  const heuresDe = new Map((lignes || []).map(l => [l.property_id, l.heures]))
  return res.status(200).json({
    bornes: { min: HEURES_MIN, max: HEURES_MAX },
    biens: visibles.map(b => ({
      property_id: b.id, nom: b.name,
      heures: heuresDe.has(b.id) ? heuresDe.get(b.id) : null,
      modifiable: peutEcrire(garde.contexte, 'avis', { id: b.id, ref: b.provider_property_id }),
    })),
  })
}

// POST auto-validation-maj { property_id, heures } — heures nulles = desactivee.
async function autoValidationEcrire (req, res, garde) {
  const userId = garde.accountUserId
  const bien = String(req.body?.property_id || '').trim()
  if (!UUID_RE.test(bien)) return res.status(400).json({ error: 'Identifiant de bien invalide' })
  const h = normaliserHeures(req.body?.heures)
  if (h === undefined) {
    return res.status(400).json({ error: `Délai invalide : un nombre entier d’heures entre ${HEURES_MIN} et ${HEURES_MAX}` })
  }
  if (!(await bienAutorise(req, res, garde, bien, true))) return
  const { error } = h === null
    ? await supabase.from('avis_auto_validation').delete().eq('user_id', userId).eq('property_id', bien)
    : await supabase.from('avis_auto_validation').upsert({ user_id: userId, property_id: bien, heures: h }, { onConflict: 'user_id,property_id' })
  if (error) return res.status(503).json({ error: 'Réglage non enregistré', detail: error.message })
  return res.status(200).json({ ok: true, property_id: bien, heures: h })
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

  // ⚠ La publication automatique ne s'ecrit plus ici : elle a son writer
  // unique, `auto-validation-maj`, bien par bien (spec §10 bis).
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

// ─── Les reglages d'une prestataire (action `avis.reglages_prestataire`) ────
// Lot 5, 2 octobre 2026. La fiche prestataire de l'app menage lit et ecrit,
// PAR LE BUS, les deux reglages que la spec §2.5 lui donne :
//   - `eval_scope` : participe-t-elle aux evaluations ? (`aucun` | `selon_grille`)
//     — « seulement si l'hote l'y autorise » (decision D1) ;
//   - `eval_power` : soumet-elle a l'hote, ou publie-t-elle (`soumettre` | `valider`) ?
//     Un avis negatif repasse TOUJOURS par l'hote, quel que soit ce pouvoir (§3).
//
// ⚠ TROIS GARDES, toutes avant la moindre lecture :
//   1. l'appelant n'est pas une prestataire — sinon une prestataire munie d'une
//      session s'accorderait elle-meme le pouvoir de publier ;
//   2. il voit TOUT le compte (meme regle que la grille de niveau compte) : une
//      prestataire travaille sur plusieurs biens, son pouvoir les engage tous ;
//   3. le profil vise appartient au compte de la GARDE, et c'est une prestataire
//      (`access_mode = 'lien'`). Un profil d'un autre compte et un profil
//      inexistant rendent le meme 404 : on n'apprend pas qu'il existe ailleurs.
const EVAL_SCOPES = new Set(['aucun', 'selon_grille'])
const EVAL_POWERS = new Set(['soumettre', 'valider'])

function refusReglagesPrestataire (res, garde) {
  if (roleEtReglages(garde).role === 'prestataire') {
    res.status(403).json({ error: 'Une prestataire ne règle pas ses propres pouvoirs.', motif: 'prestataire_appelante' })
    return true
  }
  if (!peutEcrireAuNiveauCompte(garde)) {
    res.status(403).json({
      error: 'Les réglages d’une prestataire engagent tous les biens : ils se modifient depuis un périmètre complet.',
      motif: 'perimetre_partiel',
    })
    return true
  }
  return false
}

async function profilPrestataire (res, garde, profileId) {
  if (!UUID_RE.test(String(profileId || ''))) {
    res.status(400).json({ error: 'Identifiant de prestataire invalide' }); return null
  }
  const { data, error } = await supabase.from('profiles')
    .select('id, first_name, access_mode, eval_scope, eval_power')
    .eq('id', profileId).eq('account_user_id', garde.accountUserId).maybeSingle()
  if (error) { res.status(503).json({ error: 'Profil illisible', detail: error.message }); return null }
  if (!data) { res.status(404).json({ error: 'Prestataire introuvable' }); return null }
  if (data.access_mode !== 'lien') {
    res.status(409).json({
      error: 'Ce profil n’est pas une prestataire : ses droits se règlent dans Équipe et droits.',
      motif: 'pas_une_prestataire',
    })
    return null
  }
  return data
}

const vueReglages = (p) => ({
  profile_id: p.id,
  // Une valeur absente se lit comme le serveur la juge : `aucun`, `soumettre`.
  eval_scope: EVAL_SCOPES.has(p.eval_scope) ? p.eval_scope : 'aucun',
  eval_power: EVAL_POWERS.has(p.eval_power) ? p.eval_power : 'soumettre',
})

// GET prestataire-reglages
async function prestataireReglagesLire (req, res, garde) {
  if (refusReglagesPrestataire(res, garde)) return
  const p = await profilPrestataire(res, garde, req.query?.profile_id)
  if (!p) return
  return res.status(200).json({ ok: true, ...vueReglages(p) })
}

// POST prestataire-reglages-maj { profile_id, eval_scope?, eval_power? }
async function prestataireReglagesEcrire (req, res, garde) {
  if (refusReglagesPrestataire(res, garde)) return
  const corps = req.body || {}
  const maj = {}
  if (corps.eval_scope !== undefined) {
    if (!EVAL_SCOPES.has(corps.eval_scope)) return res.status(400).json({ error: `Participation inconnue : « ${corps.eval_scope} »` })
    maj.eval_scope = corps.eval_scope
  }
  if (corps.eval_power !== undefined) {
    if (!EVAL_POWERS.has(corps.eval_power)) return res.status(400).json({ error: `Pouvoir inconnu : « ${corps.eval_power} »` })
    maj.eval_power = corps.eval_power
  }
  if (!Object.keys(maj).length) return res.status(400).json({ error: 'Aucun réglage à modifier' })

  const p = await profilPrestataire(res, garde, corps.profile_id)
  if (!p) return
  // ⚠ LES MEMES CONDITIONS DANS L'UPDATE que dans la lecture : compte de la
  // garde et acces par lien. Entre les deux requetes, le profil ne peut pas
  // changer de compte ni devenir un membre sans que l'ecriture echoue.
  const { data, error } = await supabase.from('profiles').update(maj)
    .eq('id', p.id).eq('account_user_id', garde.accountUserId).eq('access_mode', 'lien')
    .select('id, eval_scope, eval_power')
  if (error) return res.status(503).json({ error: 'Réglages non enregistrés', detail: error.message })
  if (!Array.isArray(data) || data.length !== 1) return res.status(409).json({ error: 'Le profil a changé pendant l’enregistrement : rechargez la fiche.' })
  return res.status(200).json({ ok: true, ...vueReglages(data[0]) })
}

// ─── La PWA prestataire : identite par JETON (`avis.questions_prestataire`) ─
// Lot 5, 2 octobre 2026. Une prestataire n'a pas de compte : elle entre par le
// lien de sa PWA. Le jeton ne vaut rien par lui-meme — il DESIGNE une personne,
// et c'est elle qui porte le droit (meme regle que api/menages-public.js).
//
// Cinq gardes, toutes avant la moindre ecriture, puis les MEMES fonctions que
// la session (lecture, reponses, publication) avec une garde BORNEE :
//   1. le jeton designe un profil ACTIF en acces par lien, sur le compte de la
//      ligne `public_tokens` ;
//   2. le menage (bien, reservation, date de depart) est LE SIEN —
//      `menages.provider_id` est elle. Pas de repli « dans le perimetre du
//      lien » : evaluer un sejour engage plus qu'un menage marque fait ;
//   3. le menage est MARQUE FAIT (`menage_done`) : les questions viennent
//      apres, jamais avant (spec §8.6) ;
//   4. le sejour est Airbnb par Channex, le seul evaluable en V1 ;
//   5. l'hote l'a AUTORISEE (`eval_scope = selon_grille`, decision D1). Sans
//      autorisation, rien ne nait : une evaluation qu'elle ne pourrait pas
//      remplir n'a rien a faire en base.
//
// ⚠ UNE PANNE COUPE EN 503, ELLE NE SE FAIT PAS PASSER POUR UN LIEN INVALIDE —
// comme dans api/menages-public.js.
const JOUR_RE = /^\d{4}-\d{2}-\d{2}$/
const JOURS_EVALUABLES = 30

async function porteurDuJeton (token) {
  const { data: pt, error } = await supabase.from('public_tokens')
    .select('user_id').eq('token', token).maybeSingle()
  if (error) return { statut: 503 }
  if (!pt) return { statut: 401 }
  const { data: profil, error: eP } = await supabase.from('profiles')
    .select('id, first_name, active, accepted_at, eval_scope, eval_power')
    .eq('account_user_id', pt.user_id).eq('pwa_token', token)
    .eq('access_mode', 'lien').maybeSingle()
  if (eP) return { statut: 503 }
  if (!profil || profil.active === false) return { statut: 401 }
  return { userId: pt.user_id, profil }
}

// Le sejour de CE menage, s'il est a elle, fait, et evaluable.
async function sejourDuMenage (userId, profil, { propertyRef, bookingId, departureDate }) {
  const { data: menage, error } = await supabase.from('menages')
    .select('provider_id').eq('user_id', userId).eq('property_id', propertyRef)
    .eq('booking_id', bookingId).eq('departure_date', departureDate).maybeSingle()
  if (error) return { statut: 503 }
  if (!menage || menage.provider_id !== profil.id) {
    return { statut: 403, corps: { error: 'Ce ménage ne vous est pas attribué', motif: 'menage_pas_a_elle' } }
  }
  const { data: fait, error: eF } = await supabase.from('menage_done')
    .select('booking_id').eq('user_id', userId).eq('property_id', propertyRef)
    .eq('booking_id', bookingId).eq('departure_date', departureDate).maybeSingle()
  if (eF) return { statut: 503 }
  if (!fait) return { statut: 409, corps: { error: 'Marquez d’abord le ménage comme fait.', motif: 'menage_pas_fait' } }

  const { data: biens, error: eB } = await supabase.from('properties')
    .select('id, provider_property_id').eq('user_id', userId).eq('provider_property_id', propertyRef)
  if (eB) return { statut: 503 }
  if (!Array.isArray(biens) || biens.length !== 1) {
    return { statut: 409, corps: { error: 'Bien introuvable ou ambigu : contactez votre hôte.', motif: 'bien_ambigu' } }
  }
  const { data: snap, error: eS } = await supabase.from('bookings_snapshot')
    .select('booking_id, snapshot').eq('user_id', userId).eq('property_id', propertyRef)
    .eq('booking_id', bookingId).maybeSingle()
  if (eS) return { statut: 503 }
  const sp = (snap && snap.snapshot) || {}
  const provider = String(sp.provider || '').toLowerCase()
  const ota = /airbnb/i.test(String(sp.source || '')) ? 'airbnb' : String(sp.source || '').toLowerCase()
  if (!snap || provider !== 'channex' || ota !== 'airbnb') {
    return { statut: 409, corps: { error: 'Ce séjour ne s’évalue pas ici : seuls les séjours Airbnb le sont.', motif: 'non_evaluable' } }
  }
  return { bien: { id: biens[0].id, ref: String(propertyRef) }, bookingUid: String(snap.booking_id), provider, ota }
}

// La garde d'une prestataire entrée par son lien : role prestataire, `avis:
// write` sur CE SEUL bien. Elle a la forme d'une garde de session pour que la
// lecture, les reponses et la publication s'appliquent sans copie — avec leurs
// gardes (negatif, pouvoir, couverture de la grille, autorisation).
function gardeDuJeton (userId, profil, bien) {
  const pseudo = 'jeton:' + profil.id
  const p = {
    ...profil, access_mode: 'lien', active: true,
    accepted_at: profil.accepted_at || 'lien',
    member_user_id: pseudo, account_user_id: userId,
  }
  return {
    ok: true, accountUserId: userId, userId: pseudo,
    contexte: {
      userId: pseudo, accountUserId: userId, profil: p,
      permissions: { avis: 'write', property_scope: 'selected', property_ids: [bien.id], property_refs: [bien.ref] },
    },
  }
}

async function routePwa (req, res, action) {
  const attendue = action === 'pwa-evaluation' ? 'GET' : 'POST'
  if (req.method !== attendue) return res.status(405).json({ error: 'Méthode non autorisée' })
  const src = attendue === 'GET' ? (req.query || {}) : (req.body || {})
  const token = String((req.query && req.query.token) || src.token || '')
  if (!token || token.length > 200) return res.status(401).json({ error: 'Lien invalide' })

  const propertyRef = String(src.property_id || '').trim()
  const bookingId = String(src.booking_id || '').trim()
  const departureDate = String(src.departure_date || '').trim()
  if (!propertyRef || !bookingId || propertyRef.length > 100 || bookingId.length > 200 || !JOUR_RE.test(departureDate)) {
    return res.status(400).json({ error: 'Ménage non identifié (bien, réservation, date de départ)' })
  }
  // ⚠ UN DEPART RECENT SEULEMENT. Constat de revue : un menage ancien, a elle et
  // fait, faisait naitre une evaluation sans echeance qui restait pour toujours
  // dans la liste de l'hote. La fenetre est celle de Channex (`expired_at =
  // received_at + 30 jours`, mesure du 24 septembre 2026).
  const ageJours = (Date.now() - Date.parse(departureDate + 'T00:00:00Z')) / 86400000
  if (!(ageJours >= -1 && ageJours <= JOURS_EVALUABLES)) {
    return res.status(409).json({ error: 'Ce séjour n’est plus évaluable.', motif: 'non_evaluable' })
  }

  const porteur = await porteurDuJeton(token)
  if (porteur.statut === 503) return res.status(503).json({ error: 'Service temporairement indisponible' })
  if (porteur.statut) return res.status(401).json({ error: 'Lien invalide' })
  const { userId, profil } = porteur

  if (profil.eval_scope !== 'selon_grille') {
    return res.status(403).json({ error: 'L’hôte ne vous a pas autorisée à participer aux évaluations.', motif: 'prestataire_non_autorisee' })
  }

  const sejour = await sejourDuMenage(userId, profil, { propertyRef, bookingId, departureDate })
  if (sejour.statut === 503) return res.status(503).json({ error: 'Service temporairement indisponible' })
  if (sejour.statut) return res.status(sejour.statut).json(sejour.corps)

  // ⚠ LA NAISSANCE N'A LIEU QU'A L'OUVERTURE. Repondre ou publier suppose une
  // evaluation deja nee : on ne la cree pas sur un POST.
  if (action === 'pwa-evaluation') {
    const n = await assurerEvaluation(supabase, {
      userId, propertyId: sejour.bien.id, propertyRef: sejour.bien.ref,
      bookingUid: sejour.bookingUid, provider: sejour.provider, ota: sejour.ota,
      // L'echeance d'Airbnb : depart + 14 jours (§9 bis).
      echeance: echeanceDuDepart(departureDate),
    })
    // Le message de la base reste dans les journaux : un porteur de lien n'a pas a le lire.
    if (n.erreur) { console.error('[avis] pwa : naissance echouee', n.erreur); return res.status(503).json({ error: 'Évaluation indisponible' }) }
  }

  const { data: ev, error } = await supabase.from('guest_evaluations')
    .select('id').eq('user_id', userId).eq('booking_uid', sejour.bookingUid).maybeSingle()
  if (error) return res.status(503).json({ error: 'Évaluation illisible' })
  if (!ev) return res.status(404).json({ error: 'Évaluation introuvable' })

  const garde = gardeDuJeton(userId, profil, sejour.bien)
  // ⚠ L'IDENTIFIANT DE L'EVALUATION VIENT DU SERVEUR, jamais du client : on
  // ecrase tout `id` ou `booking_uid` que la requete porterait.
  const requete = {
    ...req,
    query: { ...(req.query || {}), id: ev.id, booking_uid: undefined },
    body: { ...(req.body || {}), id: ev.id, booking_uid: undefined },
  }
  if (action === 'pwa-evaluation') return await evaluationLire(requete, res, garde)
  if (action === 'pwa-reponses') return await evaluationRepondre(requete, res, garde)
  return await evaluationPublier(requete, res, garde)
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
        // Le detail technique pour l'hote seulement (constat de revue du lot 5).
        ...(roleEtReglages(garde).role === 'hote' ? { detail: err.message } : {}),
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
        // La publication automatique programmee (§10 bis), nul sinon.
        auto_publier_le: e.auto_publier_le || null,
      }
    : {
        ...commun,
        answers_cleaner: e.answers_cleaner,
        // ⚠ ET SEULEMENT SI L'HOTE L'A AUTORISEE : une prestataire `aucun` ne
        // participe a rien, elle ne lit donc pas le texte (constat de securite
        // du 2 octobre 2026, avec la garde de lib/avis/publication.js).
        //
        // ⚠ ET SEULEMENT UN TEXTE REDIGE POUR ELLE (revue de 57a79d6, vie
        // privee) : celui de l'hote ou de l'auto-validation cite le prenom du
        // voyageur, qu'elle ne voit jamais (spec prestataires §6).
        ...(evalPower === 'valider' && evalScope === 'selon_grille' && e.texte_sans_voyageur === true ? { public_text: e.public_text } : {}),
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
    hoteARepondu: hoteARepondu(e),
  })

  // Un texte qui n'est pas le sien ne se publie pas par elle : l'hote tranche.
  const texteDeLHote = role === 'prestataire' && e.public_text && e.texte_sans_voyageur !== true
  return res.status(200).json({
    evaluation: vue,
    role,
    criteres: ouverts,
    peut_publier: decision.peutPublier && !texteDeLHote,
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

  // L'hote qui repond reagit : il prend la main, ou il est refuse si une
  // publication automatique est en cours.
  if (role === 'hote' && !(await laMainALHote(e, res))) return

  // L'auto-validation de l'hote (§10 bis) : son horloge part quand la
  // prestataire finit sa part. Un reglage illisible ne programme RIEN — le sens
  // prudent : on publie moins, jamais plus.
  let autoValidationHeures = null
  if (role === 'prestataire') {
    const cfg = await lireHeures(supabase, { userId: e.user_id, propertyId: e.property_id })
    if (cfg.erreur) console.error('[avis] auto-validation : reglage illisible', e.id, cfg.erreur)
    else autoValidationHeures = cfg.heures
  }

  let r
  try {
    r = await enregistrerReponses(supabase, {
      evaluation: e, reponses, role, evalScope, evalPower, parProfil: profilId, autoValidationHeures,
    })
  } catch (err) {
    // Une saisie refusee est un 400 nomme, pas un 500 muet.
    return res.status(400).json({ error: pourLEcran(err.message) })
  }

  // ⚠ UN TEXTE DE L'HOTE (ou de l'auto-validation) DEJA LA : elle ne le
  // publiera pas (re-revue de 0d29f03) — l'ecran ne lui montre pas un bouton
  // qui finirait en refus, et l'evaluation revient a l'hote.
  const texteDeLHote = role === 'prestataire' && Boolean(String(e.public_text || '').trim()) && e.texte_sans_voyageur !== true
  const reponse = {
    ok: true, status: r.decision.statut, peut_publier: r.decision.peutPublier && !texteDeLHote,
    motif: texteDeLHote ? 'un texte de l hote existe : il publie' : r.decision.motif, complet: r.complet, negatif: r.negatif,
  }

  // ⚠ L'HOTE EST PREVENU QUAND LA PRESTATAIRE A FINI SA PART et que
  // l'evaluation lui revient (spec §10, lot 6). Une seule fois par sejour : le
  // marqueur de la tache le garantit. Jamais quand elle publie elle-meme — il
  // n'y a alors rien a lui demander. Ne leve jamais.
  const avertirHote = async () => {
    if (role !== 'prestataire') return
    const { data: bien } = await supabase.from('properties').select('name')
      .eq('id', e.property_id).eq('user_id', e.user_id).maybeSingle()
    await prevenirHote(supabase, {
      evaluation: e,
      prenomPrestataire: garde.contexte?.profil?.first_name || null,
      nomBien: bien?.name || null,
    })
  }
  if (role === 'prestataire' && r.completRole && !r.decision.peutPublier) await avertirHote()

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
  // ⚠ ET SEULEMENT SI SES REPONSES ONT CHANGE. Constat de revue : une
  // redaction refusee (langue non couverte, modele indisponible) laisse
  // l'evaluation sans texte ; chaque nouvel envoi des MEMES reponses relancait
  // un appel paye — rejouable par quiconque porte le lien de la PWA.
  const avant = e.answers_cleaner || {}
  const apres = { ...avant, ...reponses }
  const reponsesChangees = Object.keys(apres).some(k => apres[k] !== avant[k])
  if (role === 'prestataire' && evalPower === 'valider' && r.completRole && !r.negatif && !aDejaUnTexte && reponsesChangees) {
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
    // La prestataire relit ce texte : jamais le prenom du voyageur dedans.
    const redige = await redigerEtEnregistrer(aJour, { avecPrenom: false })

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
      // L'evaluation revient a l'hote : il est prevenu (idempotent).
      await avertirHote()

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
// La langue et le prenom du voyageur, lus dans SA reservation (le coeur).
// ⚠ Constat de production du 2 octobre 2026 : `language` etait nul sur toutes
// les evaluations nees au depart, et la redaction partait en anglais pour un
// voyageur francais (la reservation Airbnb dit `customer.language = fr`). Le
// prenom, connu de la reservation, n'etait utilise que s'il etait saisi a la main.
async function voyageurDeLaReservation (e) {
  const { data, error } = await supabase.from('bookings_snapshot').select('snapshot, raw')
    .eq('user_id', e.user_id).eq('booking_id', String(e.booking_uid)).maybeSingle()
  if (error) console.error('[avis] reservation illisible pour la redaction', e.id, error.message)
  if (!data) return { langue: null, prenom: null }
  const sp = data.snapshot || {}
  const raw = data.raw || {}
  const attributs = raw.attributes || raw
  const client = attributs.customer || raw.customer || {}
  const brute = String(client.language || client.locale || sp.language || raw.lang || '').trim().toLowerCase()
  // Un code de langue (« fr », « fr-FR », « pt_BR »), jamais un nom en toutes lettres.
  const langue = /^[a-z]{2}($|[-_])/.test(brute) ? brute.slice(0, 2) : null
  const prenom = String(sp.firstName || client.name || '').trim().split(/\s+/)[0] || null
  return { langue, prenom }
}

// `avecPrenom` : faux quand c'est la PRESTATAIRE qui declenche la redaction —
// elle relit le texte, et le nom du voyageur ne lui est jamais montre
// (docs/specs/spec-prestataires-menage.md §6).
async function redigerEtEnregistrer (e, { remarque = null, prenom = null, siAutoPublierLe = null, avecPrenom = true } = {}) {
  const voyageur = await voyageurDeLaReservation(e)
  if (!e.language && voyageur.langue) {
    e = { ...e, language: voyageur.langue }
    const { error: eL } = await supabase.from('guest_evaluations')
      .update({ language: voyageur.langue }).eq('id', e.id).eq('user_id', e.user_id).is('language', null)
    if (eL) console.error('[avis] langue non enregistree', e.id, eL.message)
  }
  const prenomVoyageur = avecPrenom ? (prenom || voyageur.prenom) : null
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
    prenom: prenomVoyageur ? String(prenomVoyageur).slice(0, 80) : null,
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
  //
  // ⚠ POUR L'AUTO-VALIDATION, LE TEXTE NE S'ECRIT QUE SI L'HORLOGE N'A PAS BOUGE
  // (S3, revue de 59243cb) : un hote qui a demande le sien entre-temps l'a
  // arretee, et son texte n'est pas ecrase par celui des « meilleurs niveaux ».
  // ⚠ JAMAIS SUR UNE EVALUATION TERMINEE (re-revue de 74ec434) : un texte
  // demande par l'hote pendant une publication arrivait apres elle et
  // remplacait en base le texte reellement parti chez la plateforme.
  let ecriture = supabase.from('guest_evaluations')
    // Le repere de vie privee : vrai seulement pour un texte redige SANS le voyageur.
    .update({ public_text: r.public_text, private_note: r.private_note, texte_sans_voyageur: !avecPrenom })
    .eq('id', e.id).eq('user_id', e.user_id)
    .in('status', ['a_remplir', 'soumise_prestataire', 'a_valider', 'echec_publication'])
  if (siAutoPublierLe) ecriture = ecriture.eq('auto_publier_le', siAutoPublierLe).select('id')
  const { data: ecrit, error: eTexte } = await ecriture
  if (eTexte) {
    return { ok: false, panne: { code: 503, body: { error: 'Texte généré mais non enregistré', detail: eTexte.message } } }
  }
  if (siAutoPublierLe && (!Array.isArray(ecrit) || !ecrit.length)) {
    return { ok: false, motif: 'auto_reprise', detail: 'l hote a repris l evaluation pendant la redaction' }
  }

  return { ok: true, public_text: r.public_text, private_note: r.private_note, negatif: r.negatif }
}

// ⚠ UNE REACTION DE L'HOTE ARRETE L'AUTO-VALIDATION (§10 bis) : une reponse,
// un texte, une publication, un abandon. Ne leve jamais : l'auto-validation
// relit de toute facon les reponses de l'hote avant de publier.
//
// ⚠ ET ELLE NE PASSE PLUS PENDANT UNE PUBLICATION AUTOMATIQUE (constat de
// securite S1 de la revue de 59243cb). Une reaction ecrite APRES la prise du
// cron (reponse « je ne recommande pas », abandon) passait, et l'avis partait
// quand meme — negatif ou abandonne. Deux portes, avant toute ecriture de l'hote :
//   1. l'horloge chargee est arretee de facon CONDITIONNELLE : si le cron l'a
//      prise entre-temps, rien ne correspond, et l'hote est refuse ;
//   2. une publication en cours (verrou `avis-publier:<id>` vivant) refuse aussi.
// En face, la publication automatique relit la ligne sous son verrou et renonce
// si quoi que ce soit a bouge depuis sa prise. Le residu : une ecriture de
// l'hote qui passerait la porte 2 dans les millisecondes ou le cron pose son
// verrou et relit — note au registre (dette 48).
//
// Rend true si l'hote a la main, false APRES avoir repondu 409.
async function laMainALHote (e, res) {
  if (e.auto_publier_le) {
    const { data, error } = await supabase.from('guest_evaluations')
      .update({ auto_publier_le: null })
      .eq('id', e.id).eq('user_id', e.user_id).eq('auto_publier_le', e.auto_publier_le)
      .select('id')
    if (error) { res.status(503).json({ error: 'Évaluation indisponible', detail: error.message }); return false }
    if (!Array.isArray(data) || !data.length) {
      res.status(409).json({ error: 'Une publication automatique est en cours pour cette évaluation : rechargez la page.', motif: 'auto_en_cours' })
      return false
    }
  }
  const { data: verrou, error: eV } = await supabase.from('write_locks').select('key')
    .eq('key', `avis-publier:${e.id}`).gt('expire_at', new Date().toISOString()).maybeSingle()
  if (eV) { res.status(503).json({ error: 'Verrou de publication illisible', detail: eV.message }); return false }
  if (verrou) {
    res.status(409).json({ error: 'Une publication est en cours pour cette évaluation : rechargez la page.', motif: 'deja_en_cours' })
    return false
  }
  return true
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
  if (!(await laMainALHote(e, res))) return

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

// `options.auto` : appel INTERNE de l'auto-validation (jamais depuis la requete
// HTTP) — { answers_host } tels que la prise du cron les a ecrits.
async function evaluationPublier (req, res, garde, options = {}) {
  const e = await chargerEvaluation(req, res, garde, true)
  if (!e) return
  const { parProfil, profilId } = roleEtReglages(garde)
  // Publier, c'est reagir : l'horloge de l'auto-validation s'arrete — sauf si
  // c'est l'auto-validation elle-meme qui publie (elle l'a deja prise).
  if (!parProfil && !options.auto && e.auto_publier_le) {
    const { data, error } = await supabase.from('guest_evaluations')
      .update({ auto_publier_le: null })
      .eq('id', e.id).eq('user_id', e.user_id).eq('auto_publier_le', e.auto_publier_le)
      .select('id')
    if (error) return res.status(503).json({ error: 'Évaluation indisponible', detail: error.message })
    if (!Array.isArray(data) || !data.length) {
      return res.status(409).json({ error: 'Une publication automatique est en cours pour cette évaluation : rechargez la page.', motif: 'auto_en_cours' })
    }
  }

  // ⚠ LA REFERENCE DU PROVIDER SE RESOUT ICI. `ota_review_id` est NOTRE cle
  // primaire dans ota_reviews ; le provider ne connait que
  // `external_review_id`. Envoyer la premiere faisait un 404 a chaque essai.
  if (!e.ota_review_id) {
    return res.status(409).json({ error: 'La plateforme n’a pas encore ouvert d’avis pour ce séjour', motif: 'sans_objet_ota' })
  }
  const { data: objetOta, error: eOta } = await supabase
    .from('ota_reviews').select('external_review_id, received_at, provider, ota, cache:raw->attributes->is_hidden, note:raw->attributes->overall_score, texte:raw->attributes->content')
    .eq('id', e.ota_review_id).eq('user_id', e.user_id).maybeSingle()
  if (eOta) return res.status(503).json({ error: 'Référence de la plateforme illisible', detail: eOta.message })
  if (!objetOta?.external_review_id) {
    return res.status(409).json({ error: 'La référence de l’avis chez la plateforme est introuvable', motif: 'reference_ota_absente' })
  }
  // ⚠ L'AVIS DU VOYAGEUR EST VISIBLE : LA FENETRE D'AIRBNB EST FERMEE (regle de
  // Thierry du 9 octobre 2026). Airbnb ne revele l'avis qu'une fois les deux
  // avis ecrits ou le delai passe : on ne peut plus commenter. L'evaluation
  // passe « expiree », rien ne part — l'auto-validation passe par ici aussi.
  // Lu dans le brut, strictement : `is_hidden === false` ET une note ou un texte
  // (un objet vide et non cache ne prouve rien — revue de 9f76ae2).
  // ⚠ JAMAIS SUR UN ECHEC DE PUBLICATION (revue de 1ad5881) : notre avis est
  // peut-etre parti — c'est justement pour cela qu'Airbnb a revele celui du
  // voyageur. Seule la relecture chez le provider (lib/avis/publication.js) le
  // sait : on la laisse faire.
  // Avis visible AVANT reception + 14 jours : l'hote a evalue directement sur
  // Airbnb (`evaluee_ailleurs`, spec §6) ; apres, la fenetre est fermee (`expiree`).
  const { voyageurAEcrit, FENETRE_AIRBNB_MS } = require('../lib/avis/naissance')
  if (e.status !== 'echec_publication' && String(objetOta.ota).toLowerCase() === 'airbnb'
      && voyageurAEcrit({ is_hidden: objetOta.cache, overall_score: objetOta.note, content: objetOta.texte })) {
    const recu = Date.parse(objetOta.received_at || '')
    const ailleurs = Number.isFinite(recu) && Date.now() < recu + FENETRE_AIRBNB_MS
    const statut = ailleurs ? 'evaluee_ailleurs' : 'expiree'
    const { error: eExp } = await supabase.from('guest_evaluations')
      .update({ status: statut, auto_publier_le: null, updated_at: new Date().toISOString(), ...(ailleurs ? { origine_texte: 'ailleurs' } : {}) })
      .eq('id', e.id).eq('user_id', e.user_id)
      .in('status', ['a_remplir', 'soumise_prestataire', 'a_valider'])
    if (eExp) console.error(`[avis] statut ${statut} non ecrit`, e.id, eExp.message)
    return res.status(409).json({ error: ailleurs ? 'L’avis du voyageur est déjà visible : vous l’avez déjà évalué sur Airbnb.' : 'L’avis du voyageur est déjà visible : Airbnb a fermé l’évaluation.', motif: statut })
  }

  // Le texte modifie par l'hote arrive ici : c'est LUI qui part, pas celui de
  // l'IA. La spec veut que la version publiee soit stockee telle quelle.
  let evaluation = {
    ...e,
    ota_review_ref: objetOta.external_review_id,
    // ⚠ SEUL L'HOTE REMPLACE LE TEXTE. Constat de re-revue : n'importe quel role
    // pouvait envoyer le sien, donc une prestataire `valider` publiait un texte
    // libre au lieu de celui qu'elle a relu.
    ...(req.body?.public_text && roleEtReglages(garde).role === 'hote'
      ? { public_text: String(req.body.public_text).slice(0, MAX_TEXTE) } : {}),
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
  // ⚠ LES REPONSES DE L'HOTE SE RELISENT SOUS LE VERROU (option B, revue de
  // 0c0483b). L'evaluation a ete chargee avant : un hote qui enregistre ses
  // reponses pendant ce temps verrait l'avis partir sur la seule part de la
  // prestataire. La relecture referme cette fenetre ; celle qui reste (entre
  // la relecture et le POST) est de l'ordre de l'appel provider.
  // ⚠ ET L'AUTO-VALIDATION RELIT TOUTE LA LIGNE SOUS LE VERROU (S1, revue de
  // 59243cb) : un statut termine, des reponses de l'hote qui ne sont plus celles
  // de la prise, ou un avis devenu negatif — elle renonce. Le verrou pose, plus
  // aucune reaction de l'hote ne passe (`laMainALHote`).
  if (options.auto) {
    const { data: frais, error: eFrais } = await supabase.from('guest_evaluations')
      .select('status, answers_host, answers_cleaner, auto_publier_le').eq('id', e.id).eq('user_id', e.user_id).maybeSingle()
    if (eFrais || !frais) {
      await relacher()
      return res.status(503).json({ error: 'Évaluation illisible', detail: eFrais ? eFrais.message : 'introuvable' })
    }
    const memes = JSON.stringify(trier(frais.answers_host)) === JSON.stringify(trier(options.auto.answers_host))
    let negatif = true
    try { negatif = estNegatif({ ...(frais.answers_cleaner || {}), ...(frais.answers_host || {}) }, e.grille_figee) } catch { negatif = true }
    if (!memes || negatif || frais.auto_publier_le || ['publiee', 'abandonnee', 'expiree', 'evaluee_ailleurs'].includes(frais.status)) {
      await relacher()
      return res.status(409).json({ error: 'L’hôte a repris l’évaluation : la publication automatique renonce.', motif: 'auto_annulee' })
    }
    evaluation = { ...evaluation, answers_host: frais.answers_host, answers_cleaner: frais.answers_cleaner }
  }
  if (parProfil) {
    const { data: frais, error: eFrais } = await supabase.from('guest_evaluations')
      .select('answers_host').eq('id', e.id).eq('user_id', e.user_id).maybeSingle()
    if (eFrais || !frais) {
      await relacher()
      return res.status(503).json({ error: 'Évaluation illisible', detail: eFrais ? eFrais.message : 'introuvable' })
    }
    evaluation = { ...evaluation, answers_host: frais.answers_host }
  }

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

  // L'origine de notre avis (point B) : decidee ICI, ou l'on sait si le texte
  // parti est celui en base (l'IA) ou celui que l'hote a envoye, et si c'est
  // l'auto-validation qui publie.
  const texteDeLHoteEnvoye = req.body?.public_text && roleEtReglages(garde).role === 'hote' ? req.body.public_text : null
  const maj = {
    status: r.statut,
    public_text: evaluation.public_text,
    ...(r.statut === 'publiee' ? { origine_texte: origineALaPublication({ auto: Boolean(options.auto), prestataire: roleEtReglages(garde).role === 'prestataire', texteEnvoye: texteDeLHoteEnvoye, texteEnBase: e.public_text }) } : {}),
    // Un texte remplace par l'hote peut citer le voyageur : il n'est plus « sans voyageur ».
    ...(req.body?.public_text && roleEtReglages(garde).role === 'hote' ? { texte_sans_voyageur: false } : {}),
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
  const { error: eMaj } = await ecrireAvecOrigine(m => supabase.from('guest_evaluations')
    .update(m).eq('id', e.id).eq('user_id', e.user_id), maj)
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
  if (!(await laMainALHote(e, res))) return
  try {
    const d = await abandonner(supabase, { evaluation: e, parProfil: profilId })
    return res.status(200).json({ ok: true, status: d.status })
  } catch (err) {
    return res.status(409).json({ error: pourLEcran(err.message) })
  }
}

// ─── Pour l'auto-validation du cron (lib/avis/auto-validation.js) ───────────
// Le MEME chemin que l'hote, avec la garde du TITULAIRE du compte : verrou,
// idempotence, relecture chez le provider, simulation hors production. Il n'y a
// pas de second chemin de publication.
// Un objet de reponses, cles triees : deux ecritures identiques se comparent egales.
function trier (o) {
  return o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]])) : o
}
function gardeDuTitulaire (userId) {
  return { ok: true, accountUserId: userId, userId, contexte: { userId, accountUserId: userId, profil: null, permissions: null } }
}
const outilsAutoValidation = {
  rediger: (e, { siAutoPublierLe } = {}) => redigerEtEnregistrer(e, { siAutoPublierLe }),
  publier: async (e) => {
    const sortie = { code: 200, body: null }
    const res = {
      headersSent: false,
      status (c) { sortie.code = c; return res },
      json (b) { sortie.body = b; res.headersSent = true; return res },
    }
    await evaluationPublier({ method: 'POST', query: {}, body: { id: e.id } }, res, gardeDuTitulaire(e.user_id),
      { auto: { answers_host: e.answers_host } })
    return sortie
  },
}

// POST eval-ailleurs — l'hote l'a deja faite dans l'application Airbnb (spec §6).
async function evaluationAilleurs (req, res, garde) {
  const e = await chargerEvaluation(req, res, garde, true)
  if (!e) return
  const { role, profilId } = roleEtReglages(garde)
  if (role !== 'hote') return res.status(403).json({ error: 'Seul l’hôte range une évaluation' })
  if (!(await laMainALHote(e, res))) return
  try {
    const d = await marquerEvalueeAilleurs(supabase, { evaluation: e, parProfil: profilId })
    const j = await journaliser(supabase, {
      userId: e.user_id, type: 'avis.evaluee_ailleurs', sujet: e.id,
      charge: { booking_uid: e.booking_uid, par: 'hote', par_profil: profilId },
    })
    if (!j.ok) console.error('[avis] rangement non journalise:', j.erreur)
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

  // La PWA prestataire n'a pas de session : son identite est son jeton, valide
  // par `routePwa` et jamais crue sur parole. Avant toute garde de session.
  if (action === 'pwa-evaluation' || action === 'pwa-reponses' || action === 'pwa-publier') {
    return await routePwa(req, res, action)
  }

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
    'auto-validation-maj': autoValidationEcrire,
    'eval-reponses': evaluationRepondre,
    'eval-texte': evaluationTexte,
    'eval-publier': evaluationPublier,
    'eval-abandon': evaluationAbandonner,
    'eval-ailleurs': evaluationAilleurs,
    'prestataire-reglages-maj': prestataireReglagesEcrire,
  }
  if (ECRITURES_EVAL[action]) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' })
    const g = await requirePermission(req, res, {
      domaine: 'avis', niveau: 'write', compteDelegue: true })
    if (!g.ok) return
    return await ECRITURES_EVAL[action](req, res, g)
  }

  // Lire les reglages d'une prestataire exige l'ECRITURE, comme l'action du
  // manifeste : seul celui qui peut les changer a besoin de les voir.
  if (action === 'prestataire-reglages') {
    const g = await requirePermission(req, res, {
      domaine: 'avis', niveau: 'write', compteDelegue: true })
    if (!g.ok) return
    return await prestataireReglagesLire(req, res, g)
  }

  const garde = await requirePermission(req, res, {
    domaine: 'avis', niveau: 'read', compteDelegue: true })
  if (!garde.ok) return

  if (action === 'evaluation') return await evaluationLire(req, res, garde)
  if (action === 'grille') return await grilleLire(req, res, garde)
  if (action === 'evaluations') return await evaluationsLister(req, res, garde)
  if (action === 'config') return await configLire(req, res, garde)
  if (action === 'auto-validation') return await autoValidationLire(req, res, garde)
  if (action === 'list') return await lister(req, res, garde)
  if (action === 'cartes') return await cartesLister(req, res, garde)
  return res.status(400).json({ error: 'Action inconnue' })
}

module.exports.outilsAutoValidation = outilsAutoValidation
