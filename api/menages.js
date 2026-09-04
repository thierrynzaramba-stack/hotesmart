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
const { refsDuPerimetre, filtrePerimetreSql, peutLire } = require('../lib/permissions')
const { echeanceOffre, chargerLiaisons, chargerDisponibilites,
        deciderParGarde } = require('../lib/cleaning/assign')
const { notifierAssignation, notifierProposition } = require('../lib/cleaning/notifier-prestataire')

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
  if (req.method === 'POST') {
    const action = req.body && req.body.action
    if (action === 'liaisons') return await ecrireLiaisons(req, res)
    return await reassigner(req, res)
  }
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
      // `id` (UUID) est indispensable a l'ecran Prestataires : `/api/membres`
      // attend `permissions.property_ids` en UUID, alors que tout le domaine
      // menage raisonne en `provider_property_id`. Les deux sont donc exposes,
      // sous deux noms distincts — les confondre est le piege n°1 du depot.
      .select('id, provider_property_id, name, provider')
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
      uuid:     p.id,
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
    // Les coordonnees des prestataires : sur demande, et sous le droit
    // `prestataires` comme le reste de l'annuaire (voir plus bas).
    const avecContacts = String(req.query.contacts || '') === '1'

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
    let liaisons = []
    let rapprochement = 'ok'
    const { data: mn, error: errMn } = await supabase.from('menages')
      // `assignment_reason` porte « Refuse par X. » : sans elle, un refus est
      // indiscernable d'un menage jamais assigne, et l'hote ne sait pas qu'il
      // doit agir.
      .select('booking_id, property_id, departure_date, provider_id, status, assigned_by, assignment_reason, offered_to, offer_expires_at')
      .eq('user_id', userId)
      .in('property_id', properties.map(p => p.id))
      .neq('status', 'cancelled')
      .gte('departure_date', from || '1900-01-01')
      .lte('departure_date', to || '2999-12-31')
      .limit(MAX_LIGNES)
    if (errMn) console.error('[menages] lecture assignations echec', errMn.message)
    else menages = mn || []

    // ⚠ LA LISTE DES PERSONNES RELEVE DU DOMAINE `prestataires`, PAS DE `menages`.
    // Ce commit pose lui-meme cette separation pour l'ecriture ; la lecture doit
    // la respecter, sinon un membre `menages: read` / `prestataires: none`
    // obtient l'annuaire des femmes de menage du compte — les identifiants avec.
    // Sans ce droit, l'ecran affiche les pastilles (les prenoms viennent de la
    // meme liste, donc rien ne s'affiche) mais pas le selecteur : c'est
    // exactement ce qu'on veut, il ne pourrait de toute facon pas reassigner.
    if (peutLire(garde.contexte, 'prestataires', null)) {
      const { data: pr, error: errPr } = await supabase.from('profiles')
        .select('id, first_name, active, pwa_token' + (avecContacts ? ', phone, email' : ''))
        .eq('account_user_id', userId).eq('access_mode', 'lien')
        .order('first_name', { ascending: true })
      if (errPr) console.error('[menages] lecture prestataires echec', errPr.message)
      else {
        // ⚠ LE RAPPROCHEMENT LIEN <-> PROFIL SE FAIT ICI, PAR LE JETON.
        // L'ecran le faisait en comparant des PRENOMS : or `public_tokens.label`
        // vaut « Prenom Nom » quand un nom de famille existe, alors que cette
        // reponse n'expose que le prenom. Un accent, une casse, un renommage ou
        // un homonyme suffisaient a rompre le rapprochement — et l'ecran
        // affichait alors « lien seul, aucun menage assignable » sur une
        // prestataire parfaitement fonctionnelle, dont les rangs devenaient
        // definitivement non modifiables.
        // Le jeton lui-meme ne sort JAMAIS : on rend l'ID de sa ligne
        // `public_tokens`, que cet ecran connait deja.
        const jetons = (pr || []).map(x => x.pwa_token).filter(Boolean)
        let parJeton = new Map()
        let rapprochementSur = true
        if (jetons.length) {
          const { data: pt, error: errPt } = await supabase.from('public_tokens')
            .select('id, token').eq('user_id', userId).in('token', jetons)
          // ⚠ L'ERREUR EST LUE. Ignoree, `parJeton` restait vide et TOUS les
          // `public_token_id` valaient null : l'ecran affichait « lien seul,
          // aucun menage assignable » sur chaque prestataire, leurs rangs
          // devenaient non modifiables, et surtout « retirer » retombait sur la
          // branche « supprimer le lien seul » — profil et liaisons laisses
          // actifs, donc des menages attribues d'office a quelqu'un qui ne les
          // verra jamais. Une panne de lecture ne doit pas degrader vers le
          // comportement dangereux en silence.
          if (errPt) {
            console.error('[menages] rapprochement des jetons echec', errPt.message)
            rapprochementSur = false
          }
          parJeton = new Map((pt || []).map(t => [t.token, t.id]))
        }
        prestataires = (pr || []).map(x => ({
          id: x.id, prenom: x.first_name, actif: x.active !== false,
          a_lien: !!x.pwa_token,
          // Les coordonnees ne sortent que si l'appelant les demande.
          // ⚠ CE N'EST PAS UNE GARDE DE DROIT — la garde, c'est
          // `peutLire(..., 'prestataires')` ci-dessus, et elle est inchangee :
          // qui l'a franchie obtient les coordonnees en ajoutant `contacts=1`.
          // C'est un opt-in qui evite une exposition INCIDENTE : le planning
          // (`apps/menages/index.html`) appelle le meme endpoint et ne lit que
          // `id`, `prenom` et `actif` ; sans cet opt-in, il recevait les numeros
          // personnels de tout le personnel de menage sans jamais les afficher.
          // Une donnee qu'un ecran n'utilise pas n'a pas a transiter par lui.
          ...(avecContacts ? { telephone: x.phone || null, email: x.email || null } : {}),
          public_token_id: x.pwa_token ? (parJeton.get(x.pwa_token) || null) : null
        }))
        // L'ecran doit pouvoir distinguer « ce lien n'a pas de profil » d'« on
        // n'a pas pu le savoir ».
        rapprochement = rapprochementSur ? 'ok' : 'indisponible'
      }

      // Les liaisons bien <-> prestataire. ⚠ `requires_ack` EST EXPOSE : c'est
      // lui, et non le rang, qui dit si un menage nait porte d'office ou
      // seulement propose (§12.3). Sans lui, l'ecran continuait d'annoncer
      // « referente » a partir du rang — et promettait des menages assignes
      // d'office a quelqu'un qui devait confirmer.
      const { data: lia, error: errLia } = await supabase.from('property_cleaning_providers')
        .select('property_id, provider_id, rang, requires_ack, weekdays, active')
        .eq('user_id', userId).eq('active', true)
      if (errLia) console.error('[menages] lecture liaisons echec', errLia.message)
      else liaisons = lia || []
    }

    t.top('mapping')
    console.log(t.ligne(` biens=${properties.length} resas=${bookings.length} menages=${menages.length}${tronque ? ' TRONQUE' : ''}`))
    return res.status(200).json({ properties, bookings, tronque, menages, prestataires, liaisons, rapprochement })
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

  // ⚠ DEUX GESTES DISTINCTS, et l'hote choisit lequel.
  //   `proposer` — elle confirme. Garde son plancher de deux heures.
  //   `assigner` — transfert IMMEDIAT, sans aucune limite de delai. C'est le
  //     geste d'urgence : quelqu'un se decommande a deux heures du depart, et il
  //     faut que le menage soit fait. Elle est notifiee, et le menage apparait
  //     aussitot dans sa PWA.
  // Le defaut reste `proposer` quand le temps le permet : engager quelqu'un sans
  // son accord doit rester un choix explicite, pas ce qui arrive par defaut.
  const { property_id, booking_id, departure_date, provider_id, mode } = req.body || {}
  const geste = mode === 'assigner' ? 'assigner' : 'proposer'
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
    .select('id, provider_id, status, offered_to')
    .eq('user_id', userId).eq('property_id', String(property_id))
    .eq('booking_id', String(booking_id)).eq('departure_date', departure_date)
    .maybeSingle()
  if (errLire) {
    console.error('[menages] lecture menage echec', errLire.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  if (!avant) return res.status(404).json({ error: 'Ménage introuvable' })
  // ⚠ Un menage ANNULE ne se reassigne pas : le prochain cycle du cron le
  // re-annulerait aussitot, et l'hote verrait son geste defait sans un mot.
  // La reservation n'existe plus (ou a change de date) — c'est elle qu'il faut
  // regarder, pas l'affectation.
  if (avant.status === 'cancelled') {
    return res.status(409).json({ error: 'Ce ménage est annulé : sa réservation n\'existe plus' })
  }

  // ⚠ `requires_ack` DECIDE DE L'ENGAGEMENT, PAS LE RANG (spec §12.3, lot 3.3) :
  // reassigner vers quelqu'un qui n'a rien a confirmer l'engage d'office ; vers
  // quelqu'un qui doit confirmer, on propose. La reassignation manuelle emprunte
  // le meme chemin que l'automate, sinon deux regles d'engagement coexisteraient.
  // Lire le rang ici condamnait une attitree du week-end en rang 2 a confirmer
  // pour toujours, et interdisait a une seconde personne rodee d'etre assignee
  // d'office sans la promouvoir rang 1 devant la titulaire.
  // ⚠ REASSIGNER N'EST PAS PROPOSER (regle du 4 septembre 2026).
  //   - vers le REFERENT du bien : il PORTE le menage, tout de suite.
  //   - vers quelqu'un d'autre : on lui PROPOSE. Le menage reste chez son
  //     porteur actuel tant qu'elle n'a pas accepte — il ne quitte ni son
  //     planning ni sa responsabilite. Ecraser `provider_id` laissait un
  //     logement sans personne pendant tout le temps de la reflexion.
  let maj = { updated_at: new Date().toISOString() }
  let reponse = {}

  if (!choisi) {
    // Desassigner : plus de porteur, et la proposition en cours tombe avec.
    maj = { ...maj, provider_id: null, status: 'unassigned', assigned_by: 'manual',
            offered_to: null, offered_at: null, offer_expires_at: null,
            accepted_at: null,
            assignment_reason: 'Desassigne a la main par l\'hote.' }
    reponse = { status: 'unassigned', provider_id: null, prenom: null }
  } else if (choisi.id === avant.provider_id) {
    // ⚠ RE-CHOISIR LA PORTEUSE = RETIRER LA PROPOSITION.
    // C'etait le geste manquant : aucune action ne permettait d'annuler une
    // proposition en gardant la porteuse. « — personne — » retirait AUSSI la
    // porteuse, l'inverse de l'intention. Et si elle n'etait pas rang 1, la
    // resélectionner partait sur la branche « proposer » et ecrivait
    // `offered_to = provider_id` — viole `menages_offre_pas_a_soi`, donc 500.
    maj = { ...maj, offered_to: null, offered_at: null, offer_expires_at: null,
            assignment_reason: `Proposition retiree par l'hote : reste chez ${choisi.first_name}.` }
    reponse = { status: avant.status, provider_id: avant.provider_id,
                offered_to: null, prenom: choisi.first_name, retiree: true }
  } else {
    const { data: liaison, error: errLiaison } = await supabase.from('property_cleaning_providers')
      .select('rang, requires_ack').eq('user_id', userId).eq('property_id', String(property_id))
      .eq('provider_id', choisi.id).eq('active', true).maybeSingle()
    // ⚠ Ignoree, une panne transitoire degradait une personne assignee d'office
    // en simple sollicitee : elle recevait une proposition a confirmer pour un
    // menage qui aurait du lui revenir sans rien demander.
    if (errLiaison) {
      console.error('[menages] lecture de la liaison echec', errLiaison.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    // ⚠ `requires_ack` ABSENT vaut « doit confirmer », jamais « d'office » —
    // meme defaut que la colonne et que `garde.js`. Engager quelqu'un parce
    // qu'une lecture a manque une colonne serait le pire des deux resultats.
    // Une personne SANS liaison sur ce bien (l'hote depanne avec quelqu'un d'un
    // autre bien) doit confirmer : rien ne dit qu'elle a accepte ce bien-la.
    const dOffice = !!liaison && liaison.requires_ack === false

    // Celle qui n'a rien a confirmer est TOUJOURS assignee directement : c'est
    // le sens de `requires_ack = false`. Pour les autres, c'est le geste demande
    // qui tranche.
    if (dOffice || geste === 'assigner') {
      maj = { ...maj, provider_id: choisi.id, status: 'accepted', assigned_by: 'manual',
              offered_to: null, offered_at: null, offer_expires_at: null,
              accepted_at: new Date().toISOString(),
              assignment_reason: dOffice
                ? `Assignee d'office sur ce bien, posee a la main par l'hote.`
                : `Assigne directement par l'hote (sans confirmation).` }
      reponse = { status: 'accepted', provider_id: choisi.id, prenom: choisi.first_name,
                  assignee: true }
    } else {
      // ⚠ UNE PROPOSITION DOIT LAISSER UN VRAI DELAI DE REPONSE. Passe la veille
      // du depart a 18 h, elle serait morte-nee : on refuse, et l'hote assigne
      // directement s'il le souhaite.
      // ⚠ `echeanceOffre` NE REND PLUS JAMAIS NULL depuis le retrait du plancher
      // (8568741) : on propose a tout moment, et une veille deja passee retombe
      // sur une heure. Le 409 « trop tard pour proposer » qui vivait ici etait
      // donc devenu inatteignable — retire plutot que laisse en garde-fou d'un
      // plancher qui n'existe plus. La garde reste cote base : une proposition
      // sans echeance viole `menages_offre_datee`.
      const echeance = echeanceOffre(departure_date)
      if (!echeance) {
        console.error('[menages] echeance introuvable — proposition refusee')
        return res.status(500).json({ error: 'Proposition impossible' })
      }
      maj = { ...maj, offered_to: choisi.id, offered_at: new Date().toISOString(),
              offer_expires_at: echeance,
              assignment_reason: `Propose a ${choisi.first_name} par l'hote.` }
      reponse = { status: avant.status, provider_id: avant.provider_id,
                  offered_to: choisi.id, prenom: choisi.first_name, expire_le: echeance }
    }
  }

  const { error: errMaj } = await supabase.from('menages').update(maj).eq('id', avant.id)
  if (errMaj) {
    console.error('[menages] reassignation echec', errMaj.message)
    return res.status(500).json({ error: 'Réassignation impossible' })
  }

  await supabase.from('menage_assignment_log').insert({
    user_id: userId, menage_id: avant.id,
    event: reponse.retiree ? 'offer_withdrawn' : (maj.offered_to ? 'offered' : 'manual_assign'),
    from_provider_id: avant.provider_id,
    to_provider_id: maj.offered_to || maj.provider_id || null,
    actor: 'host',
    reason: reponse.retiree
      ? 'Proposition retiree : le menage reste chez son porteur.'
      : (maj.offered_to
          ? `Propose a ${choisi.first_name} : le menage reste chez son porteur jusqu'a acceptation.`
          : (choisi ? `Vers ${choisi.first_name}.` : 'Menage laisse sans prestataire.'))
  })

  // ⚠ NOTIFIER, MAIS APRES AVOIR ECRIT. L'assignation est deja en base : un
  // envoi qui echoue ne doit ni la defaire, ni faire echouer la requete. On dit
  // a l'hote ce qui est REELLEMENT parti, plutot que de lui promettre un SMS.
  let notif = { sms: false, email: false }
  if (reponse.assignee && choisi) {
    // ⚠ L'erreur est LUE : `provider_property_id` n'a pas de contrainte d'unicite,
    // et `maybeSingle` rend une erreur sur deux lignes. Ignoree, le SMS partait
    // sans nom de bien, en silence.
    const { data: bien, error: errBien } = await supabase.from('properties')
      .select('name').eq('user_id', userId).eq('provider_property_id', String(property_id)).maybeSingle()
    if (errBien) console.error('[menages] nom du bien illisible', errBien.message)
    const base = (process.env.PUBLIC_BASE_URL || 'https://hotesmart.vercel.app').replace(/\/+$/, '')
    try {
      notif = await notifierAssignation({
        userId, providerId: choisi.id, propertyName: bien && bien.name,
        propertyId: String(property_id),
        departureDate: departure_date, lien: `${base}/apps/menages/public`
      })
    } catch (e) { console.error('[menages] notification assignation echec', e.message) }
  }

  return res.status(200).json({ success: true, ...reponse, notifiee: notif })
}

// ─── Qui intervient sur quel bien, et a quel rang (spec §11.2) ──────────────
//
// ⚠ REMPLACE L'ENSEMBLE des liaisons de CE prestataire : les biens absents du
// corps sont DESACTIVES, pas supprimes. Une liaison supprimee emporterait avec
// elle la trace de qui intervenait sur ce bien — or les menages passes la
// referencent par leur `provider_id`, et l'historique de qualite s'appuie
// dessus.
//
// ⚠ LE RANG EST PAR BIEN. Le cas reel est mixte : suppleante ici, referente
// ailleurs. Un rang unique par personne aurait ete a refaire.
async function ecrireLiaisons (req, res) {
  const appelant = await verifierSession(req, res)
  if (!appelant) return

  const garde = await requirePermission(req, res, {
    domaine: 'prestataires', niveau: 'write', userId: appelant, compteDelegue: true })
  if (!garde.ok) return
  const userId = garde.accountUserId

  const { provider_id, liaisons } = req.body || {}
  if (!provider_id) return res.status(400).json({ error: 'Prestataire manquant' })
  if (!Array.isArray(liaisons)) return res.status(400).json({ error: 'Liaisons manquantes' })

  // Le prestataire doit etre un profil `lien` DE CE COMPTE (REVIEW.md regle 11).
  const { data: prof, error: errProf } = await supabase.from('profiles')
    .select('id, first_name, active').eq('id', String(provider_id))
    .eq('account_user_id', userId).eq('access_mode', 'lien').maybeSingle()
  if (errProf) {
    console.error('[menages] verification profil echec', errProf.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  if (!prof) return res.status(400).json({ error: 'Prestataire inconnu' })

  // Chaque bien doit etre dans le perimetre de l'appelant ET du compte.
  const refs = refsDuPerimetre(garde.contexte)
  const voulues = []
  const vues = new Set()
  for (const l of liaisons) {
    const ref = String(l && l.property_id || '')
    const rang = Number(l && l.rang)
    if (!ref) return res.status(400).json({ error: 'Bien manquant dans une liaison' })
    // ⚠ REF_SQL_SURE, comme partout ailleurs : cette reference finit interpolee
    // dans un filtre PostgREST plus bas. Aucun chemin d'ecriture connu ne place
    // un guillemet dans `provider_property_id`, mais le depot a un garde nomme
    // pour ce motif et il n'y a pas de raison de faire exception.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) {
      return res.status(400).json({ error: 'Référence de bien invalide' })
    }
    if (!Number.isInteger(rang) || rang < 1 || rang > 9) {
      return res.status(400).json({ error: 'Rang invalide' })
    }
    if (Array.isArray(refs) && !refs.map(String).includes(ref)) {
      return res.status(403).json({ error: 'Bien hors périmètre' })
    }
    // ⚠ Un bien repete produirait deux lignes de meme cle de conflit dans un
    // seul upsert : Postgres refuse (42P10), et l'endpoint rendrait 500 APRES
    // avoir desactive les liaisons — la prestataire perdrait ses biens sans en
    // recuperer aucun.
    if (vues.has(ref)) return res.status(400).json({ error: 'Bien en double dans la demande' })
    vues.add(ref)
    voulues.push({ ref, rang })
  }

  const { data: biensDuCompte, error: errBiens } = await supabase.from('properties')
    .select('provider_property_id').eq('user_id', userId)
    .not('provider_property_id', 'is', null)
  if (errBiens) {
    console.error('[menages] lecture biens echec', errBiens.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  const duCompte = new Set((biensDuCompte || []).map(b => String(b.provider_property_id)))
  for (const v of voulues) {
    if (!duCompte.has(v.ref)) return res.status(403).json({ error: 'Bien hors du compte' })
  }

  // 1. Desactiver ce qui n'est plus voulu.
  //
  // ⚠ BORNE AU PERIMETRE DE L'APPELANT. Les biens AJOUTES etaient confrontes au
  // perimetre, les biens RETIRES ne l'etaient pas : tout ce qui n'etait pas dans
  // la liste envoyee etait desactive, y compris hors perimetre. Un gestionnaire
  // limite au bien A retirait ainsi la referente des biens B et C — dont les
  // prochains menages naissaient non assignes, SANS alerte (un bien sans liaison
  // n'est pas considere en panne). Un corps `liaisons: []` coupait la prestataire
  // de tous les biens du compte depuis un perimetre d'un seul bien.
  // C'est REVIEW.md regle 11 dans l'autre sens : la donnee client agissait sur
  // des ressources qu'elle ne designe pas.
  const gardees = voulues.map(v => v.ref)
  let desactivation = supabase.from('property_cleaning_providers')
    .update({ active: false })
    .eq('user_id', userId).eq('provider_id', prof.id)
  if (Array.isArray(refs)) {
    // Perimetre restreint : on ne touche QUE ses biens. `refs` vide -> aucune
    // desactivation, ce qui est le comportement sur (il ne gere aucun bien).
    desactivation = desactivation.in('property_id', refs.map(String))
  }
  if (gardees.length) desactivation = desactivation.not('property_id', 'in', `(${gardees.map(r => `"${r}"`).join(',')})`)
  const { error: errDes } = await desactivation
  if (errDes) {
    console.error('[menages] desactivation liaisons echec', errDes.message)
    return res.status(500).json({ error: 'Enregistrement impossible' })
  }

  // 2. Poser ou remettre les voulues.
  //
  // ⚠ `requires_ack` DOIT ETRE POSE A LA CREATION. Il vaut `true` par defaut en
  // base : sans cette ligne, une prestataire que l'hote vient de designer comme
  // referente ne portait plus rien d'office — ses menages lui etaient seulement
  // PROPOSES, et restaient sans personne si elle ne repondait pas. Le formulaire
  // n'a pas encore de reglage dedie (lot 3.5) : il traduit son choix
  // referente/suppleante, exactement comme la reprise de la migration
  // (`requires_ack = false where rang = 1`).
  //
  // ⚠ ON NE LE RECALCULE QUE SI LE RANG CHANGE. Deux fautes symetriques a eviter :
  //   - le recalculer TOUJOURS ecraserait un `requires_ack` regle finement — une
  //     suppleante rodee passee d'office sans etre promue — a chaque
  //     enregistrement de la fiche, sans que personne comprenne pourquoi elle
  //     redemande confirmation ;
  //   - ne JAMAIS le recalculer rendait la promotion impossible : echanger les
  //     rangs de deux personnes depuis leurs deux fiches ne changeait rien, la
  //     nouvelle rang 1 restait « a confirmer », et aucun ecran n'expose encore
  //     `requires_ack` pour corriger (lot 3.5).
  // Le rang envoye est donc une INTENTION : quand il bouge, il retranche.
  const { data: connues, error: errConnues } = await supabase
    .from('property_cleaning_providers')
    .select('property_id, rang, requires_ack')
    .eq('user_id', userId).eq('provider_id', prof.id)
  if (errConnues) {
    console.error('[menages] lecture liaisons connues echec', errConnues.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  const ackConnu = new Map((connues || []).map(l => [String(l.property_id), l]))
  // `true` = cette liaison garde son reglage ; `false` = le rang vient de bouger,
  // l'intention de l'ecran l'emporte.
  const ackConserve = v => {
    const l = ackConnu.get(v.ref)
    return l && Number(l.rang) === Number(v.rang) ? l.requires_ack : null
  }

  if (voulues.length) {
    const { error: errUp } = await supabase.from('property_cleaning_providers')
      .upsert(voulues.map(v => ({
        user_id: userId, property_id: v.ref, provider_id: prof.id,
        rang: v.rang, active: true,
        requires_ack: ackConserve(v) === null ? v.rang !== 1 : ackConserve(v)
      })), { onConflict: 'user_id,property_id,provider_id' })
    if (errUp) {
      console.error('[menages] upsert liaisons echec', errUp.message)
      return res.status(500).json({ error: 'Enregistrement impossible' })
    }
  }

  // ⚠ AVERTISSEMENT, PAS BLOCAGE. Un bien qui n'a plus PERSONNE D'OFFICE verra
  // ses prochains menages naitre en simple proposition — ou non assignes si
  // personne ne repond : l'hote doit le savoir, mais c'est sa decision — le lui
  // refuser le laisserait sans issue le jour ou une prestataire s'en va.
  //
  // ⚠ LE CRITERE EST `requires_ack`, PLUS LE RANG (§12.3). Un bien dont le rang 1
  // doit confirmer n'a pas de porteuse d'office, et l'ancien test le declarait
  // pourtant couvert. La cle de reponse garde son nom (`sans_referent`) : c'est
  // le contrat de `apps/menages/prestataires.html`.
  const { data: apres } = await supabase.from('property_cleaning_providers')
    // `provider_id` sert au rattrapage immediat plus bas : c'est l'etat APRES
    // cette ecriture qui decide, pas ce que l'appelant vient d'envoyer.
    .select('property_id, provider_id, rang, requires_ack, weekdays')
    .eq('user_id', userId).eq('active', true)
  const avecReferent = new Set((apres || [])
    .filter(l => l.requires_ack === false).map(l => String(l.property_id)))
  // ⚠ L'avertissement reste DANS le perimetre de l'appelant : sinon la reponse
  // lui rend les references des biens qu'il n'a pas le droit de voir.
  const visibles = Array.isArray(refs)
    ? [...duCompte].filter(ref => refs.map(String).includes(ref))
    : [...duCompte]
  const sansReferent = visibles.filter(ref =>
    (apres || []).some(l => String(l.property_id) === ref) && !avecReferent.has(ref))

  // ⚠ RATTRAPAGE IMMEDIAT DES MENAGES A VENIR SANS PERSONNE.
  //
  // Le cron le fait deja a chaque cycle — mais jusqu'a cinq minutes plus tard,
  // et rien a l'ecran n'explique ce vide. Le premier test humain reel est tombe
  // exactement dedans : une referente venait d'etre posee sur un bien, son
  // planning etait vide, et il fallait deviner qu'il suffisait d'attendre.
  //
  // ⚠ SEULEMENT LES MENAGES A VENIR, ET SEULEMENT `unassigned` :
  //   - jamais le PASSE : reecrire l'histoire attribuerait a quelqu'un un
  //     travail qu'il n'a pas fait, et l'attribution des avis suit cette meme
  //     assignation. Le cron, lui, couvre sa fenetre — c'est son role de
  //     reconcilier, pas celui d'un geste d'interface ;
  //   - jamais `orphaned` : quelqu'un a refuse, c'est une decision humaine ;
  //   - jamais `assigned_by='manual'` : l'hote a tranche ;
  //   - jamais un menage deja assigne : ce serait defaire une offre en cours.
  //
  // ⚠ CHAQUE MENAGE EST DECIDE PAR LA GARDE DE SON JOUR (§12.1, lot 3.3). La
  // version precedente ecrivait LE MEME prestataire sur tous les menages a venir
  // du bien — le rang 1 — quelle que soit leur date : une attitree du week-end
  // heritait des menages du mardi, et une personne en conge des menages de son
  // absence. Deux ecrans donnaient alors deux reponses differentes a la meme
  // question.
  const rattrapage = await rattraperMenagesSansPersonne(userId, voulues.map(v => v.ref))
  if (rattrapage.erreur) console.error('[menages] rattrapage echec', rattrapage.erreur)

  return res.status(200).json({ success: true, sans_referent: sansReferent,
                                rattrapes: rattrapage.rattrapes })
}

// ─── Rattrapage immediat des menages sans personne (lot 3.3) ────────────────
//
// L'hote vient de lier une prestataire a des biens. Le cron ferait le meme
// travail au cycle suivant, mais jusqu'a cinq minutes plus tard, et rien a
// l'ecran n'expliquerait ce vide : le premier test humain reel est tombe
// exactement dedans.
//
// ⚠ MEME MOTEUR QUE LE CRON — `deciderParGarde`, par JOUR. Recopier ici une
// regle d'assignation, c'etait garantir qu'elle diverge : c'est ce qui s'est
// produit (« rang 1 = accepted » ecrit sur tous les menages a venir, quel que
// soit le jour).
//
// ⚠ UNE PANNE NE FAIT PAS ECHOUER L'ENREGISTREMENT DES LIAISONS. Elles sont
// deja ecrites ; le rattrapage est un confort, le cron repassera.
async function rattraperMenagesSansPersonne (userId, refs) {
  const bilan = { rattrapes: 0, erreur: null }
  const biens = [...new Set((refs || []).map(String))].filter(Boolean)
  if (!biens.length) return bilan
  const maintenant = Date.now()
  const aujourdhui = new Date(maintenant).toISOString().slice(0, 10)

  try {
    // ⚠ `assigned_by` NULL DOIT PASSER. Un menage cree sans aucune liaison porte
    // `assigned_by = null` : `.neq('assigned_by','manual')` l'aurait ECARTE (en
    // SQL, `null <> 'manual'` ne vaut pas vrai), c'est-a-dire exclu du rattrapage
    // precisement le cas que ce rattrapage existe pour traiter.
    const { data: menages, error: errLire } = await supabase.from('menages')
      .select('id, user_id, property_id, departure_date')
      .eq('user_id', userId).in('property_id', biens)
      .eq('status', 'unassigned').is('provider_id', null).is('offered_to', null)
      .or('assigned_by.is.null,assigned_by.neq.manual')
      .gte('departure_date', aujourdhui)
      .order('departure_date', { ascending: true })
      .limit(500)
    if (errLire) { bilan.erreur = errLire.message; return bilan }
    if (!menages || !menages.length) return bilan

    const liaisonsParBien = await chargerLiaisons(supabase, menages.map(m => ({
      userId, propertyId: m.property_id
    })))
    const dispos = await chargerDisponibilites(supabase, [userId], {
      du: menages[0].departure_date, au: menages[menages.length - 1].departure_date
    })

    // Groupe par destination ET par echeance : deux departs de dates
    // differentes ne partagent pas la meme echeance de proposition.
    const groupes = new Map()
    for (const m of menages) {
      const bien = {
        userId, propertyId: String(m.property_id),
        liaisons: liaisonsParBien.get(`${userId}|${String(m.property_id)}`) || [],
        regles: dispos.regles, exceptions: dispos.exceptions
      }
      const choix = deciderParGarde(bien, m.departure_date, { maintenant })
      if (!choix.providerId && !choix.offeredTo) continue
      const echeance = choix.offeredTo ? echeanceOffre(m.departure_date, maintenant) : null
      const k = `${choix.providerId}|${choix.offeredTo}|${echeance}`
      if (!groupes.has(k)) groupes.set(k, { choix, echeance, menages: [] })
      groupes.get(k).menages.push(m)
    }

    const journal = []
    const aNotifier = []
    for (const { choix, echeance, menages: lot } of groupes.values()) {
      const iso = new Date(maintenant).toISOString()
      const { data: maj, error: errRat } = await supabase.from('menages')
        .update({
          provider_id: choix.providerId,
          offered_to: choix.offeredTo || null,
          offer_expires_at: choix.offeredTo ? echeance : null,
          status: choix.providerId ? 'accepted' : (choix.offeredTo ? 'offered' : 'unassigned'),
          assigned_by: 'auto',
          assignment_reason: choix.raison,
          assignment_mode: 'garde',
          accepted_at: choix.providerId ? iso : null,
          offered_at: choix.offeredTo ? iso : null,
          updated_at: iso
        })
        // ⚠ Les memes conditions que la lecture, POSEES DANS L'UPDATE : entre les
        // deux, le cron a pu assigner ces menages. Zero ligne = il a ete plus
        // rapide, et c'est un resultat normal.
        .in('id', lot.map(m => m.id))
        .eq('status', 'unassigned').is('provider_id', null).is('offered_to', null)
        // ⚠ `property_id` EST RELU. Le groupe est indexe par (destination,
        // echeance) et PAS par bien : deux biens differents tombent dans le meme
        // groupe des que la meme personne est retenue avec la meme echeance —
        // le cas nominal quand l'hote lie une prestataire a plusieurs biens d'un
        // coup. Notifier avec le bien du PREMIER menage du lot annoncait
        // « Appartement A » pour un menage de l'Appartement B, et comptait le SMS
        // sur le mauvais bien.
        .select('id, user_id, property_id, departure_date')
      if (errRat) { bilan.erreur = errRat.message; continue }
      bilan.rattrapes += (maj || []).length
      for (const m of (maj || [])) {
        journal.push({
          user_id: m.user_id, menage_id: m.id,
          event: choix.offeredTo ? 'offered' : 'assigned',
          to_provider_id: choix.offeredTo || choix.providerId, actor: 'host',
          reason: 'Prestataire liee au bien : menages a venir rattrapes, garde du jour.'
        })
        if (choix.offeredTo) {
          aNotifier.push({ providerId: choix.offeredTo, propertyId: m.property_id,
                           departureDate: m.departure_date, expireLe: echeance })
        }
      }
    }
    if (journal.length) await supabase.from('menage_assignment_log').insert(journal)

    // ⚠ UNE PROPOSITION MUETTE EXPIRE SANS QUE PERSONNE NE SACHE QU'ON LUI A
    // DEMANDE QUELQUE CHOSE. Le cron ne repassera pas dessus — l'offre y est
    // deja posee — donc c'est ici ou nulle part. Best-effort et PLAFONNE : la
    // fenetre de proposition borne deja la source, ce plafond protege la cle
    // Brevo de l'hote d'un geste qui toucherait beaucoup de biens d'un coup.
    const MAX_NOTIFS = 10
    for (const n of aNotifier.slice(0, MAX_NOTIFS)) {
      try {
        const { data: bien } = await supabase.from('properties')
          .select('name').eq('user_id', userId)
          .eq('provider_property_id', String(n.propertyId)).maybeSingle()
        const base = (process.env.PUBLIC_BASE_URL || 'https://hotesmart.vercel.app').replace(/\/+$/, '')
        await notifierProposition({
          userId, providerId: n.providerId, propertyName: bien && bien.name,
          propertyId: String(n.propertyId), departureDate: n.departureDate,
          expireLe: n.expireLe, lien: `${base}/apps/menages/public`
        })
      } catch (e) { console.error('[menages] notification proposition echec', e.message) }
    }
  } catch (e) {
    bilan.erreur = e.message
  }
  return bilan
}
