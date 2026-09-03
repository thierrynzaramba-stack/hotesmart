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
      .select('booking_id, property_id, departure_date, provider_id, status, assigned_by, assignment_reason')
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
        .select('id, first_name, active, pwa_token')
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
          public_token_id: x.pwa_token ? (parJeton.get(x.pwa_token) || null) : null
        }))
        // L'ecran doit pouvoir distinguer « ce lien n'a pas de profil » d'« on
        // n'a pas pu le savoir ».
        rapprochement = rapprochementSur ? 'ok' : 'indisponible'
      }

      // Les liaisons bien <-> prestataire, avec leur rang. C'est ce qui decide
      // si un menage nait accepte ou propose.
      const { data: lia, error: errLia } = await supabase.from('property_cleaning_providers')
        .select('property_id, provider_id, rang, active')
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
  // ⚠ Un menage ANNULE ne se reassigne pas : le prochain cycle du cron le
  // re-annulerait aussitot, et l'hote verrait son geste defait sans un mot.
  // La reservation n'existe plus (ou a change de date) — c'est elle qu'il faut
  // regarder, pas l'affectation.
  if (avant.status === 'cancelled') {
    return res.status(409).json({ error: 'Ce ménage est annulé : sa réservation n\'existe plus' })
  }

  // ⚠ Le rang decide de l'ENGAGEMENT, pas la personne (spec §11.3) : reassigner
  // vers le referent du bien l'engage d'office ; vers un suppleant, il devra
  // confirmer. La reassignation manuelle emprunte le meme chemin que
  // l'automate, sinon deux regles d'engagement coexisteraient.
  let status = 'unassigned', offered_at = null, accepted_at = null
  if (choisi) {
    const { data: liaison, error: errLiaison } = await supabase.from('property_cleaning_providers')
      .select('rang').eq('user_id', userId).eq('property_id', String(property_id))
      .eq('provider_id', choisi.id).eq('active', true).maybeSingle()
    // ⚠ L'ERREUR EST LUE. Ignoree, une panne transitoire degradait
    // silencieusement une REFERENTE en « offered » : elle recevait une offre a
    // confirmer pour un menage qui aurait du lui etre attribue d'office, et
    // personne n'aurait su pourquoi. Les trois autres lectures de ce chemin
    // rendent deja 503 ; il n'y avait pas de raison que celle-ci fasse exception.
    if (errLiaison) {
      console.error('[menages] lecture de la liaison echec', errLiaison.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    const referent = liaison && liaison.rang === 1
    status = referent ? 'accepted' : 'offered'
    if (referent) accepted_at = new Date().toISOString()
    else offered_at = new Date().toISOString()
  }

  const { error: errMaj } = await supabase.from('menages').update({
    provider_id: choisi ? choisi.id : null,
    status,
    // ⚠ 'manual' MEME QUAND ON DESASSIGNE. Remettre `null` ici rendait le geste
    // invisible au writer, dont la garde teste `assigned_by === 'manual'` : le
    // cron rendait le menage a la referente dans les cinq minutes, avec au
    // journal un motif faux. Laisser un menage sans personne EST une decision de
    // l'hote, et elle se verrouille comme les autres.
    assigned_by: 'manual',
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
  if (voulues.length) {
    const { error: errUp } = await supabase.from('property_cleaning_providers')
      .upsert(voulues.map(v => ({
        user_id: userId, property_id: v.ref, provider_id: prof.id,
        rang: v.rang, active: true
      })), { onConflict: 'user_id,property_id,provider_id' })
    if (errUp) {
      console.error('[menages] upsert liaisons echec', errUp.message)
      return res.status(500).json({ error: 'Enregistrement impossible' })
    }
  }

  // ⚠ AVERTISSEMENT, PAS BLOCAGE. Un bien qui perd sa derniere referente verra
  // ses prochains menages naitre NON ASSIGNES : l'hote doit le savoir, mais
  // c'est sa decision — le lui refuser le laisserait sans issue le jour ou une
  // prestataire s'en va.
  const { data: apres } = await supabase.from('property_cleaning_providers')
    // `provider_id` sert au rattrapage immediat plus bas : c'est l'etat APRES
    // cette ecriture qui decide, pas ce que l'appelant vient d'envoyer.
    .select('property_id, provider_id, rang').eq('user_id', userId).eq('active', true)
  const avecReferent = new Set((apres || []).filter(l => l.rang === 1).map(l => String(l.property_id)))
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
  const aujourdhui = new Date().toISOString().slice(0, 10)
  let rattrapes = 0
  for (const v of voulues) {
    // Le referent du bien APRES cette ecriture, pas celui qu'on vient d'envoyer :
    // une autre personne peut deja etre rang 1.
    const surCeBien = (apres || []).filter(l => String(l.property_id) === v.ref)
      .sort((a, b) => a.rang - b.rang)
    if (!surCeBien.length) continue
    const { data: maj, error: errRat } = await supabase.from('menages')
      .update({
        provider_id: surCeBien[0].provider_id,
        status: surCeBien[0].rang === 1 ? 'accepted' : 'offered',
        assigned_by: 'auto',
        assignment_reason: surCeBien[0].rang === 1
          ? 'Referent du bien (rang 1), assigne d\'office.'
          : `Suppleant (rang ${surCeBien[0].rang}) : en attente de sa confirmation.`,
        assignment_mode: 'priorite',
        accepted_at: surCeBien[0].rang === 1 ? new Date().toISOString() : null,
        offered_at: surCeBien[0].rang === 1 ? null : new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId).eq('property_id', v.ref)
      .eq('status', 'unassigned').is('provider_id', null)
      .gte('departure_date', aujourdhui)
      .select('id, user_id')
    if (errRat) { console.error('[menages] rattrapage echec', errRat.message); continue }
    rattrapes += (maj || []).length
    if ((maj || []).length) {
      await supabase.from('menage_assignment_log').insert((maj || []).map(m => ({
        user_id: m.user_id, menage_id: m.id,
        event: surCeBien[0].rang === 1 ? 'assigned' : 'offered',
        to_provider_id: surCeBien[0].provider_id, actor: 'host',
        reason: 'Prestataire lie au bien : menages a venir rattrapes.'
      })))
    }
  }

  return res.status(200).json({ success: true, sans_referent: sansReferent, rattrapes })
}
