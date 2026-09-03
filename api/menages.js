// ⚠️ DOC : comportement documenté dans docs/kb/menage.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce kb (MÊME COMMIT).
// api/menages.js
// Planning ménage de l'HÔTE (apps/menages/index.html).
//
// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD  (bornes optionnelles, sur la date de départ)
//   -> { properties: [{ id, name, provider }],
//        bookings:   [{ id, propId, propName, arrival, departure, firstName,
//                       lastName, numAdult, numChild }] }
//
// Provider-agnostique (ecart E1 de l'audit d'unification) : lit UNIQUEMENT des
// tables HoteSmart. La page appelait auparavant /api/beds24 en direct, donc un
// hote Channex voyait un planning VIDE.
//
// Cle universelle = properties.provider_property_id (TEXT), deja utilisee par
// menage_comments, menage_done, public_tokens et bookings_snapshot. Le front
// s'en sert tel quel pour ses filtres et ses ecritures.
//
// Securite : le token de session est verifie serveur (auth.getUser), puis chaque
// requete est filtree sur user_id. Le client service-key contourne la RLS, ce
// filtre est donc la seule defense.

const { createClient } = require('@supabase/supabase-js')
const { isActiveStatus } = require('../lib/bookings-snapshot')
const { requirePermission, verifierSession } = require('../lib/require-permission')
const { refsDuPerimetre, filtrePerimetreSql } = require('../lib/permissions')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// Garde-fou explicite : au-dela, c'est que l'appelant n'a pas borne sa fenetre.
// Le planning en renvoie l'alerte plutot que de tronquer en silence.
const MAX_LIGNES = 5000

// Chrono par etape : loge une seule ligne en fin de requete. Permet d'identifier
// l'etape lente sans instrumenter a l'aveugle (une page a deja mis 41 s sans
// qu'aucune requete mesuree cote serveur ne depasse 300 ms).
function chrono() {
  const t0 = Date.now()
  let dernier = t0
  const etapes = []
  return {
    top(nom) { const n = Date.now(); etapes.push(`${nom}=${n - dernier}ms`); dernier = n },
    ligne(suffixe) { return `[menages] ${etapes.join(' ')} total=${Date.now() - t0}ms${suffixe || ''}` }
  }
}

module.exports = async function handler(req, res) {
  // ⚠ La REASSIGNATION est un POST, garde par `prestataires: write` et non par
  // `menages`. Consulter le planning et decider QUI le fait ne sont pas le meme
  // droit : un membre `menages: read` voit les menages sans pouvoir toucher aux
  // affectations. Meme separation que celle deja posee sur `public_tokens`.
  if (req.method === 'POST') return await reassigner(req, res)
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' })
  const t = chrono()

  // ===== DROITS =====
  // Collection : aucun identifiant client ne designe le compte, c'est donc
  // l'en-tete X-Compte qui le fait — revalide par la garde. Le perimetre, qui ne
  // peut pas s'evaluer bien par bien sur une collection, se traduit en FILTRE.
  //
  // ⚠ ENDPOINT DELEGABLE (etape 5, lot 3). Ce qu'il expose est sensible : le
  // planning de menage porte les dates de sejour, les noms des voyageurs et le
  // nombre d'occupants. Deux barrieres, et les deux comptent :
  //   1. le filtre de perimetre ci-dessous, sur les BIENS ;
  //   2. les reservations bornees a ces biens (`.in(property_id, …)` plus bas).
  // La seconde n'est pas redondante : sans elle, une lecture directe de
  // bookings_snapshot renverrait tout le compte.
  //
  // Session d'abord — elle seule repond 401 — puis les droits. Deux etapes pour
  // que la trace chrono distingue la session invalide du refus de droits.
  const appelant = await verifierSession(req, res)
  t.top('auth')
  if (!appelant) { console.log(t.ligne(' -> 401')); return }

  const garde = await requirePermission(req, res, {
    domaine: 'menages', niveau: 'read', userId: appelant, compteDelegue: true })
  if (!garde.ok) { console.log(t.ligne(' -> 403')); return }
  const userId = garde.accountUserId
  const filtreRef = filtrePerimetreSql(refsDuPerimetre(garde.contexte), 'provider_property_id')
  if (filtreRef === '') return res.status(200).json({ properties: [], bookings: [] })

  try {
    // ===== BIENS (tous providers) =====
    let qProps = supabase
      .from('properties')
      .select('provider_property_id, name, provider')
      .eq('user_id', userId)
      .not('provider_property_id', 'is', null)
    if (filtreRef) qProps = qProps.or(filtreRef)
    const { data: propRows, error: propErr } = await qProps
      .order('name', { ascending: true })
    t.top('properties')
    if (propErr) {
      console.error('[menages] lecture properties echec', propErr.message)
      console.log(t.ligne(' -> 500 properties'))
      return res.status(500).json({ error: 'Erreur lecture biens' })
    }

    const properties = (propRows || []).map(p => ({
      id:       String(p.provider_property_id),
      name:     p.name || `Bien ${p.provider_property_id}`,
      provider: p.provider || null
    }))
    if (!properties.length) {
      console.log(t.ligne(' -> aucun bien'))
      return res.status(200).json({ properties: [], bookings: [] })
    }

    const nomParId = {}
    const providerParId = {}
    properties.forEach(p => { nomParId[p.id] = p.name; providerParId[p.id] = p.provider })

    // ===== RESERVATIONS (bookings_snapshot, alimente par la couche sync) =====
    // Bornes optionnelles sur la date de depart (= date du menage).
    const from = typeof req.query.from === 'string' ? req.query.from : null
    const to   = typeof req.query.to   === 'string' ? req.query.to   : null

    // ⚠ Filtre et tri portes cote SQL. Sans eux, PostgREST tronque a 1000 lignes
    // par defaut, dans un ordre non deterministe : des menages de la semaine en
    // cours pouvaient disparaitre du planning sans la moindre erreur. La date de
    // depart vit dans le jsonb -> operateur `snapshot->>departure`.
    let requete = supabase
      .from('bookings_snapshot')
      .select('booking_id, property_id, snapshot')
      .eq('user_id', userId)
      .in('property_id', properties.map(p => p.id))
    if (from) requete = requete.gte('snapshot->>departure', from)
    if (to)   requete = requete.lte('snapshot->>departure', to)

    const { data: snaps, error: snapErr } = await requete
      .order('snapshot->>departure', { ascending: true })
      .limit(MAX_LIGNES)
    t.top('snapshots')
    if (snapErr) {
      console.error('[menages] lecture bookings_snapshot echec', snapErr.message)
      console.log(t.ligne(' -> 500 snapshots'))
      return res.status(500).json({ error: 'Erreur lecture réservations' })
    }

    const bookings = (snaps || [])
      .map(r => {
        const s = r.snapshot || {}
        const propId = String(r.property_id)
        return {
          id:        String(r.booking_id),
          propId,
          propName:  nomParId[propId] || '',
          arrival:   s.arrival || null,
          departure: s.departure || null,
          firstName: s.firstName || '',
          lastName:  s.lastName || '',
          numAdult:  s.numAdult ?? null,
          numChild:  s.numChild ?? null,
          _snapshot: s
        }
      })
      // Seul un statut canonique 'confirmed' donne lieu a un menage : une
      // annulation, un blocage proprietaire Beds24 ('black') ou une demande non
      // confirmee ('request') ne doivent pas apparaitre au planning (audit E5).
      //
      // ⚠ Le provider du bien est OBLIGATOIRE en 2e argument : une ligne ecrite
      // AVANT l'unification porte le statut BRUT du provider et aucun champ
      // `provider`. Sans ce defaut, canonicalStatus('black', undefined) ne trouve
      // aucune table de correspondance et retombe sur 'confirmed' — le blocage
      // proprietaire redeviendrait un menage fantome.
      .filter(b => isActiveStatus(b._snapshot, providerParId[b.propId]))
      .filter(b => b.departure)
      // Filet : les bornes sont deja appliquees en SQL, on rejoue la comparaison
      // pour ne rien laisser passer si la colonne jsonb etait absente.
      .filter(b => (!from || b.departure >= from) && (!to || b.departure <= to))
      .map(({ _snapshot, ...b }) => b)

    const tronque = (snaps || []).length >= MAX_LIGNES
    if (tronque) console.warn(`[menages] lecture tronquee a ${MAX_LIGNES} lignes (user ${userId}) — fenetre trop large`)

    // ===== QUI FAIT QUOI (spec §11.6) =====
    // Les menages assignes de la fenetre, et les prestataires du compte pour
    // alimenter le selecteur de reassignation.
    //
    // ⚠ Une panne ici ne coupe PAS le planning : sans assignation, l'ecran
    // affiche les menages sans pastille — degrade, mais utilisable. C'est
    // l'inverse du choix fait cote PWA, ou une liste vide se lirait comme
    // « rien a faire » ; ici l'hote voit ses reservations, qui ne mentent pas.
    let menages = []
    let prestataires = []
    const { data: mn, error: errMn } = await supabase.from('menages')
      .select('booking_id, property_id, departure_date, provider_id, status, assigned_by')
      .eq('user_id', userId)
      .in('property_id', properties.map(p => p.id))
      .neq('status', 'cancelled')
      .gte('departure_date', from || '1900-01-01')
      .lte('departure_date', to || '2999-12-31')
      .limit(MAX_LIGNES)
    if (errMn) console.error('[menages] lecture assignations echec', errMn.message)
    else menages = mn || []

    const { data: pr, error: errPr } = await supabase.from('profiles')
      .select('id, first_name, active')
      .eq('account_user_id', userId).eq('access_mode', 'lien')
      .order('first_name', { ascending: true })
    if (errPr) console.error('[menages] lecture prestataires echec', errPr.message)
    else prestataires = (pr || []).map(x => ({ id: x.id, prenom: x.first_name, actif: x.active !== false }))

    t.top('mapping')
    console.log(t.ligne(` biens=${properties.length} resas=${bookings.length} menages=${menages.length}${tronque ? ' TRONQUE' : ''}`))
    return res.status(200).json({ properties, bookings, tronque, menages, prestataires })
  } catch (err) {
    // Une requete qui rame PUIS echoue est le cas le plus interessant a
    // diagnostiquer : il doit loguer son chrono comme les autres.
    console.error('[menages] erreur', err.message)
    console.log(t.ligne(' -> 500 exception'))
    return res.status(500).json({ error: err.message })
  }
}

// ─── Reassignation manuelle d'un menage (spec §11.6) ────────────────────────
//
// ⚠ `assigned_by='manual'` VERROUILLE le menage : le writer ne le reassignera
// jamais (verrou du §3). C'est le sens meme du geste — l'hote a tranche, un
// automate ne revient pas dessus.
//
// ⚠ Le menage est designe par son IDENTITE, pas par un id opaque venu du client
// (REVIEW.md regle 11) : on ne fait pas confiance a un identifiant pour dire a
// quel compte appartient la ressource. Le `user_id` du filtre vient de la garde.
async function reassigner (req, res) {
  const appelant = await verifierSession(req, res)
  if (!appelant) return

  const garde = await requirePermission(req, res, {
    domaine: 'prestataires', niveau: 'write', userId: appelant, compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId

  const { property_id, booking_id, departure_date, provider_id } = req.body || {}
  if (!property_id || !booking_id || !departure_date) {
    return res.status(400).json({ error: 'Champs requis manquants (property_id, booking_id, departure_date)' })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(departure_date))) {
    return res.status(400).json({ error: 'Format departure_date invalide, attendu YYYY-MM-DD' })
  }

  // Le bien doit etre DANS LE PERIMETRE de l'appelant. Sans ce controle, une
  // reference passee dans le corps de la requete suffirait a reassigner le
  // menage d'un bien qu'il n'a pas le droit de voir.
  const refs = refsDuPerimetre(garde.contexte)
  if (Array.isArray(refs) && !refs.map(String).includes(String(property_id))) {
    return res.status(403).json({ error: 'Bien hors périmètre' })
  }

  // Le prestataire vise doit etre un profil `lien` ACTIF DU MEME COMPTE. Un
  // UUID venu du client ne designe rien tant qu'il n'a pas ete confronte au
  // compte : sans cette verification, on rattacherait le menage d'un hote au
  // profil d'un autre — et les avis de propreté suivraient.
  let choisi = null
  if (provider_id) {
    const { data: prof, error: errProf } = await supabase.from('profiles')
      .select('id, first_name, active').eq('id', String(provider_id))
      .eq('account_user_id', userId).eq('access_mode', 'lien').maybeSingle()
    if (errProf) {
      console.error('[menages] verification profil echec', errProf.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    if (!prof) return res.status(400).json({ error: 'Prestataire inconnu' })
    if (prof.active === false) return res.status(400).json({ error: 'Ce prestataire est désactivé' })
    choisi = prof
  }

  const { data: avant, error: errLire } = await supabase.from('menages')
    .select('id, provider_id, status')
    .eq('user_id', userId).eq('property_id', String(property_id))
    .eq('booking_id', String(booking_id)).eq('departure_date', departure_date)
    .maybeSingle()
  if (errLire) {
    console.error('[menages] lecture menage echec', errLire.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  if (!avant) return res.status(404).json({ error: 'Ménage introuvable' })

  // ⚠ Le rang decide de l'ENGAGEMENT, pas la personne (spec §11.3) : reassigner
  // vers le referent du bien l'engage d'office ; vers un suppleant, il devra
  // confirmer. La reassignation manuelle emprunte le meme chemin que
  // l'automate, sinon deux regles d'engagement coexisteraient.
  let status = 'unassigned', offered_at = null, accepted_at = null
  if (choisi) {
    const { data: liaison } = await supabase.from('property_cleaning_providers')
      .select('rang').eq('user_id', userId).eq('property_id', String(property_id))
      .eq('provider_id', choisi.id).eq('active', true).maybeSingle()
    const referent = liaison && liaison.rang === 1
    status = referent ? 'accepted' : 'offered'
    if (referent) accepted_at = new Date().toISOString()
    else offered_at = new Date().toISOString()
  }

  const { error: errMaj } = await supabase.from('menages').update({
    provider_id: choisi ? choisi.id : null,
    status,
    assigned_by: choisi ? 'manual' : null,
    assignment_reason: choisi
      ? `Reassigne a la main par l'hote (${status === 'accepted' ? 'referent du bien' : 'suppleant, en attente de confirmation'}).`
      : 'Desassigne a la main par l\'hote.',
    offered_at, accepted_at,
    updated_at: new Date().toISOString()
  }).eq('id', avant.id)
  if (errMaj) {
    console.error('[menages] reassignation echec', errMaj.message)
    return res.status(500).json({ error: 'Réassignation impossible' })
  }

  // Le journal est immuable : il porte la trace du changement, pas son resultat.
  await supabase.from('menage_assignment_log').insert({
    user_id: userId, menage_id: avant.id, event: 'manual_assign',
    from_provider_id: avant.provider_id, to_provider_id: choisi ? choisi.id : null,
    actor: 'host',
    reason: choisi ? `Vers ${choisi.first_name}.` : 'Menage laisse sans prestataire.'
  })

  return res.status(200).json({
    success: true, status,
    provider_id: choisi ? choisi.id : null,
    prenom: choisi ? choisi.first_name : null
  })
}
