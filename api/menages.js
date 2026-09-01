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
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' })
  const t = chrono()

  // ===== DROITS =====
  // Collection : aucun identifiant client, donc le compte cible est celui de
  // l'appelant. La garde verifie le domaine `menages` ; le perimetre, qui ne peut
  // pas s'evaluer bien par bien sur une collection, se traduit en FILTRE.
  //
  // ⚠ Portee reelle : inerte tant qu'il n'y a pas de selecteur de compte
  // (etape 5) — un appelant est titulaire de son propre compte. Le cablage est
  // pose pour que cette etape n'ait pas a repasser ici. Couverture : les tests
  // portent sur lib/permissions, pas sur cet endpoint.
  // Session d'abord — elle seule repond 401 — puis les droits. Deux etapes pour
  // que la trace chrono distingue la session invalide du refus de droits.
  const appelant = await verifierSession(req, res)
  t.top('auth')
  if (!appelant) { console.log(t.ligne(' -> 401')); return }

  const garde = await requirePermission(req, res, { domaine: 'menages', niveau: 'read', userId: appelant })
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

    t.top('mapping')
    console.log(t.ligne(` biens=${properties.length} resas=${bookings.length}${tronque ? ' TRONQUE' : ''}`))
    return res.status(200).json({ properties, bookings, tronque })
  } catch (err) {
    // Une requete qui rame PUIS echoue est le cas le plus interessant a
    // diagnostiquer : il doit loguer son chrono comme les autres.
    console.error('[menages] erreur', err.message)
    console.log(t.ligne(' -> 500 exception'))
    return res.status(500).json({ error: err.message })
  }
}
