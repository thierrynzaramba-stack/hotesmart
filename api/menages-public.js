// ⚠️ DOC : comportement documenté dans docs/kb/menage.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce(s) kb (MÊME COMMIT).
const { createClient } = require('@supabase/supabase-js')
const { markReady } = require('../lib/cron-property-status')
// Statut canonique unifie (audit E5) : evite les menages fantomes sur les blocages.
const { readStatus, STATUS } = require('../lib/bookings-snapshot')
const { ratioProprete, borneDepuis } = require('../lib/stats-avis')
const { avisDuPrestataire, MAX_IDS } = require('../lib/attribution-prestataire')
const { alertMenageRefuse } = require('../lib/alert-notify')
const { extraitVerifie } = require('../lib/extrait-verifie')
// Le moteur de garde (lot 3.3) : c'est LUI qui dit qui remplace, jamais un
// « rang 2 » lu en dur — un rang 2 en conge ou non attitre ce jour-la n'est pas
// la remplacante de ce jour.
const { chargerLiaisons, chargerDisponibilites, chargerRefus,
        deciderParGarde, echeanceOffre } = require('../lib/cleaning/assign')
const { notifierProposition } = require('../lib/cleaning/notifier-prestataire')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { token } = req.query
  if (!token) return res.status(401).json({ error: 'Token manquant' })

  // ─── Vue « Avis » de la prestataire ───────────────────────────────────────
  if (req.method === 'GET' && req.query.action === 'avis') {
    return await avisDeLaPrestataire(req, res, token)
  }

  // ─── « Mes disponibilites » : ce qu'elle a declare ────────────────────────
  if (req.method === 'GET' && req.query.action === 'disponibilites') {
    return await mesDisponibilites(req, res, token)
  }

  if (req.method === 'POST') {
    const { action, event_ids, booking_id, property_id, departure_date } = req.body || {}

    // --- markRead : inchange ---
    if (action === 'markRead' && event_ids?.length) {
      await supabase.from('menage_events').update({ read: true })
        .in('id', event_ids).eq('token', token)
      return res.json({ success: true })
    }

    // --- accepterMenage / refuserMenage : la boucle d'acquittement (spec §11.3) ---
    //
    // ⚠ NE CONCERNE QUE LE SUPPLEANT. Le referent (rang 1) est assigne d'office
    // et son menage nait `accepted` : il n'a rien a confirmer, et Regina ne verra
    // jamais ce bouton. Un suppleant, lui, recoit une offre — l'engager sans son
    // accord reviendrait a disposer du temps de quelqu'un.
    if (action === 'accepterMenage' || action === 'refuserMenage') {
      if (!booking_id || !property_id || !departure_date) {
        return res.status(400).json({ error: 'Champs requis manquants (booking_id, property_id, departure_date)' })
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(departure_date))) {
        return res.status(400).json({ error: 'Format departure_date invalide, attendu YYYY-MM-DD' })
      }
      return await repondreALOffre(req, res, token, {
        accepte: action === 'accepterMenage',
        propertyId: property_id, bookingId: booking_id, departureDate: departure_date
      })
    }

    // --- « Mes disponibilites » (lot 3.5) : elle DECLARE, l'hote corrige ---
    //
    // ⚠ ELLE NE DECLARE QUE DES INDISPONIBILITES. Ses JOURS ATTITRES
    // (`property_cleaning_providers.weekdays`) sont une decision de l'HOTE :
    // pouvoir s'en retirer elle-meme lui permettrait de quitter un bien sans
    // qu'il l'apprenne, alors qu'il compte sur elle pour le preparer. Decision du
    // product owner, 4 septembre 2026.
    if (action === 'declarerIndisponibilite' || action === 'retirerIndisponibilite') {
      return await mesIndisponibilites(req, res, token, {
        retirer: action === 'retirerIndisponibilite'
      })
    }

    // --- markDone : nouveau, avec table menage_done + garde-fous ---
    if (action === 'markDone') {
      if (!booking_id || !property_id || !departure_date) {
        return res.status(400).json({ error: 'Champs requis manquants (booking_id, property_id, departure_date)' })
      }

      // Validation format departure_date (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(departure_date)) {
        return res.status(400).json({ error: 'Format departure_date invalide, attendu YYYY-MM-DD' })
      }

      // Garde-fou metier : on n'autorise pas un markDone sur un menage futur.
      // Regle : le voyageur doit etre parti (departure_date <= today, en heure
      // Europe/Paris). Cela evite qu'une femme de menage pre-coche par erreur,
      // ou qu'un test foire la valeur de last_menage_at pour le bien entier.
      const todayStr = todayInParis()
      if (departure_date > todayStr) {
        return res.status(400).json({
          error: 'Impossible de marquer un menage futur. Le voyageur n\'est pas encore parti.',
          today: todayStr,
          departure_date
        })
      }

      try {
        const { data: tokenData, error: errTok } = await supabase
          .from('public_tokens').select('user_id').eq('token', token).maybeSingle()
        // ⚠ UNE PANNE N'EST PAS UN TOKEN INVALIDE — et ici la difference DETRUIT
        // du travail. Le front supprime l'action de sa file d'attente sur tout
        // 4xx (le serveur a tranche, inutile de rejouer) : un timeout PostgREST
        // pendant la resynchro effacait donc silencieusement un « menage fait »,
        // et le visuel revenait en arriere. Un 503 laisse l'action en file.
        if (errTok) {
          console.error('[menages-public] lecture du token echec:', errTok.message)
          return res.status(503).json({ error: 'Service temporairement indisponible' })
        }
        if (!tokenData) return res.status(401).json({ error: 'Token invalide' })

        const userId = tokenData.user_id

        // ⚠ Garde de propriete : voir `menageDeCePorteur`.
        const droit = await menageDeCePorteur(userId, token, {
          propertyId: property_id, bookingId: booking_id, departureDate: departure_date })
        if (droit.erreur) return res.status(503).json({ error: 'Service temporairement indisponible' })
        if (droit.autorise === 'perimetre') {
          const p = await bienDansLePerimetre(userId, token, property_id)
          if (p.erreur) return res.status(503).json({ error: 'Service temporairement indisponible' })
          if (!p.autorise) return res.status(403).json({ error: 'Ce ménage ne vous est pas attribué' })
        } else if (!droit.autorise) {
          return res.status(403).json({ error: droit.motif === 'offre'
            ? 'Acceptez d\'abord ce ménage'
            : 'Ce ménage ne vous est pas attribué' })
        }

        // Insert dans menage_done. ON CONFLICT DO NOTHING grace a la contrainte unique.
        // On utilise upsert avec ignoreDuplicates pour rester idempotent.
        const { error: insertErr } = await supabase
          .from('menage_done')
          .upsert({
            user_id: userId,
            property_id: String(property_id),
            booking_id: String(booking_id),
            departure_date,
            done_by_token: token
          }, { onConflict: 'user_id,property_id,booking_id,departure_date', ignoreDuplicates: true })

        if (insertErr) {
          console.error('[Menage] Erreur insert menage_done:', insertErr.message)
          return res.status(500).json({ error: 'Erreur enregistrement menage' })
        }

        // Met a jour property_status.last_menage_at via la fonction existante
        try {
          await markReady(userId, String(property_id))
          console.log(`[Menage] ${property_id} booking ${booking_id} dep ${departure_date} -> ready`)
        } catch (err) {
          console.error('[Menage] Erreur markReady:', err.message)
          // On ne bloque pas la reponse : le menage_done est deja insere,
          // c'est la verite. property_status est secondaire.
        }

        return res.json({ success: true, message: 'Menage marque, logement pret' })
      } catch (err) {
        console.error('[Menage] markDone erreur:', err.message)
        return res.status(500).json({ error: err.message })
      }
    }

    // --- markUndone : nouveau, vraie suppression cote serveur ---
    if (action === 'markUndone') {
      if (!booking_id || !property_id || !departure_date) {
        return res.status(400).json({ error: 'Champs requis manquants (booking_id, property_id, departure_date)' })
      }

      try {
        const { data: tokenData, error: errTok } = await supabase
          .from('public_tokens').select('user_id').eq('token', token).maybeSingle()
        // ⚠ UNE PANNE N'EST PAS UN TOKEN INVALIDE — et ici la difference DETRUIT
        // du travail. Le front supprime l'action de sa file d'attente sur tout
        // 4xx (le serveur a tranche, inutile de rejouer) : un timeout PostgREST
        // pendant la resynchro effacait donc silencieusement un « menage fait »,
        // et le visuel revenait en arriere. Un 503 laisse l'action en file.
        if (errTok) {
          console.error('[menages-public] lecture du token echec:', errTok.message)
          return res.status(503).json({ error: 'Service temporairement indisponible' })
        }
        if (!tokenData) return res.status(401).json({ error: 'Token invalide' })

        const userId = tokenData.user_id

        // ⚠ Garde de propriete : voir `menageDeCePorteur`.
        const droit = await menageDeCePorteur(userId, token, {
          propertyId: property_id, bookingId: booking_id, departureDate: departure_date })
        if (droit.erreur) return res.status(503).json({ error: 'Service temporairement indisponible' })
        if (droit.autorise === 'perimetre') {
          const p = await bienDansLePerimetre(userId, token, property_id)
          if (p.erreur) return res.status(503).json({ error: 'Service temporairement indisponible' })
          if (!p.autorise) return res.status(403).json({ error: 'Ce ménage ne vous est pas attribué' })
        } else if (!droit.autorise) {
          return res.status(403).json({ error: droit.motif === 'offre'
            ? 'Acceptez d\'abord ce ménage'
            : 'Ce ménage ne vous est pas attribué' })
        }

        // Suppression de la ligne menage_done
        const { error: delErr } = await supabase
          .from('menage_done')
          .delete()
          .eq('user_id', userId)
          .eq('property_id', String(property_id))
          .eq('booking_id', String(booking_id))
          .eq('departure_date', departure_date)

        if (delErr) {
          console.error('[Menage] Erreur delete menage_done:', delErr.message)
          return res.status(500).json({ error: 'Erreur suppression menage' })
        }

        // Recalcul de last_menage_at = MAX(done_at) des menages restants pour ce bien.
        // Si plus aucun menage : on remet last_menage_at a NULL (ou on laisse tel quel ?
        // On choisit de laisser tel quel pour ne pas casser un last_menage_at venu d'ailleurs).
        const { data: latestDone } = await supabase
          .from('menage_done')
          .select('done_at')
          .eq('user_id', userId)
          .eq('property_id', String(property_id))
          .order('done_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (latestDone) {
          await supabase
            .from('property_status')
            .update({ last_menage_at: latestDone.done_at, updated_at: new Date().toISOString() })
            .eq('user_id', userId)
            .eq('property_id', String(property_id))
        }
        // Si latestDone est null, on ne touche pas a property_status :
        // last_menage_at peut venir d'autre source (cron, ancien etat) qu'on
        // ne veut pas effacer aveuglement.

        console.log(`[Menage] markUndone ${property_id} booking ${booking_id} dep ${departure_date}`)
        return res.json({ success: true, message: 'Menage decoche' })
      } catch (err) {
        console.error('[Menage] markUndone erreur:', err.message)
        return res.status(500).json({ error: err.message })
      }
    }

    return res.status(400).json({ error: 'Action inconnue' })
  }

  // --- GET planning public ---
  try {
    const { data: tokenData, error: tokenError } = await supabase
      .from('public_tokens').select('user_id, label, property_ids, visibility_days')
      .eq('token', token).maybeSingle()

    // Meme regle que les deux chemins d'ecriture ci-dessus : la panne coupe en
    // 503, elle ne se fait pas passer pour un lien invalide.
    if (tokenError) {
      console.error('[menages-public] lecture du token echec:', tokenError.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    if (!tokenData) return res.status(401).json({ error: 'Token invalide' })

    const userId         = tokenData.user_id
    const visibilityDays = tokenData.visibility_days || 30

    // Biens du prestataire : lecture de la table `properties` (dual-provider,
    // ZERO appel Beds24). Cle universelle = provider_property_id, deja utilisee par
    // les tokens (property_ids), menage_done, property_status et bookings_snapshot.
    // `provider` est indispensable pour lire le statut des lignes bookings_snapshot
    // ecrites AVANT l'unification : elles portent le statut BRUT du provider et
    // aucun champ `provider`. Sans ce defaut, un blocage proprietaire Beds24
    // ('black') retomberait sur le fallback 'confirmed' -> menage fantome.
    const { data: propRows } = await supabase
      .from('properties')
      .select('provider_property_id, name, provider')
      .eq('user_id', userId)
      .not('provider_property_id', 'is', null)

    const allowedIds = (tokenData.property_ids || []).map(String)
    const properties = (propRows || [])
      .filter(p => !allowedIds.length || allowedIds.includes(String(p.provider_property_id)))
      .map(p => ({ id: String(p.provider_property_id), name: p.name, provider: p.provider }))
    const propNameById = {}
    const propProviderById = {}
    properties.forEach(p => { propNameById[p.id] = p.name; propProviderById[p.id] = p.provider })

    const today   = new Date(); today.setHours(0,0,0,0)
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + visibilityDays)
    // On remonte aussi les 14 derniers jours pour que la femme de menage
    // puisse marquer des menages en retard (ex: depart hier, menage fait
    // le lendemain). Au-dela de 14 jours on considere que le menage est
    // perdu et ne fait plus partie du planning actif.
    const minDate  = new Date(today); minDate.setDate(minDate.getDate() - 14)
    const dateFrom = minDate.toISOString().split('T')[0]
    const dateTo   = maxDate.toISOString().split('T')[0]

    // Reservations : lecture bookings_snapshot (alimentee par la couche sync, tous
    // providers). Mappe vers la MEME forme que l'ancien retour Beds24 -> contrat
    // front inchange. Annulations exclues (pas de menage sur une reservation annulee).
    const propIds = properties.map(p => p.id)
    let allBookings = []
    if (propIds.length) {
      const { data: snaps } = await supabase
        .from('bookings_snapshot')
        .select('booking_id, property_id, snapshot')
        .eq('user_id', userId)
        .in('property_id', propIds)
      allBookings = (snaps || [])
        .map(s => {
          const snap = s.snapshot || {}
          return {
            id:        String(s.booking_id),
            propId:    String(s.property_id),
            propName:  propNameById[String(s.property_id)] || '',
            arrival:   snap.arrival || null,
            departure: snap.departure || null,
            firstName: snap.firstName || '',
            lastName:  snap.lastName || '',
            numAdult:  snap.numAdult ?? null,
            numChild:  snap.numChild ?? null,
            status:    readStatus(snap, propProviderById[String(s.property_id)])
          }
        })
        // Seul un statut canonique 'confirmed' donne lieu a un menage : un blocage
        // proprietaire Beds24 ('black') ou une demande non confirmee ('request')
        // creait un menage fantome au planning (audit E5).
        .filter(b => b.status === STATUS.CONFIRMED)
        .filter(b => b.departure && b.departure >= dateFrom && b.departure <= dateTo)
    }

    // ─── FILTRAGE PAR PRESTATAIRE (spec §11.5) ─────────────────────────────
    // ⚠ LE FILTRE PASSE DU BIEN A LA PERSONNE. Tant que la PWA filtrait par
    // `public_tokens.property_ids`, deux prestataires sur un meme bien voyaient
    // chacune TOUS les menages de l'autre — le cas qui motive tout ce chantier.
    //
    // ⚠ PONT DE CONVERGENCE — ET IL NE DOIT PAS ETRE UNE PORTE OUVERTE.
    // Un token sans profil correspondant (`profiles.pwa_token`) ne peut pas etre
    // filtre par personne. La premiere version gardait alors l'ANCIEN
    // comportement — filtrage par bien — et c'etait une fuite : l'ecran
    // `apps/menages/prestataires.html` cree un `public_tokens` SANS profil, si
    // bien qu'une prestataire creee la aurait vu tous les menages de Regina sur
    // les memes biens, noms des voyageurs compris. Exactement le scenario que ce
    // chantier existe pour empecher.
    //
    // La regle retenue se derive du modele, pas d'une date de bascule : un token
    // sans profil ne voit QUE ce qui n'est assigne a PERSONNE. Un lien legacy
    // continue donc de fonctionner tant que personne d'autre n'intervient (cas
    // de Colomiers, dont les 14 menages sont non assignes), et se ferme de
    // lui-meme des qu'une personne est assignee sur ces biens.
    const { data: profilPresta, error: errProfil } = await supabase.from('profiles')
      .select('id, first_name, active')
      .eq('account_user_id', userId).eq('pwa_token', token).maybeSingle()
    // ⚠ La panne COUPE plutot que d'elargir : sans cette garde, un timeout
    // PostgREST rendrait `profilPresta` null et la prestataire verrait de nouveau
    // les menages de tout le monde sur ses biens.
    if (errProfil) {
      console.error('[menages-public] lecture du profil echec:', errProfil.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }

    const identifiee = !!(profilPresta && profilPresta.active !== false)
    let requete = supabase.from('menages')
      .select('booking_id, property_id, departure_date, status, provider_id, offered_to, offer_expires_at')
      .eq('user_id', userId)
      .neq('status', 'cancelled')
      .gte('departure_date', dateFrom)
      .lte('departure_date', dateTo)
    // Identifiee : ses menages. Non identifiee : ceux de personne, et rien
    // d'autre — `.is('provider_id', null)`.
    // ⚠ `.in()` sur une liste VIDE n'a pas de rendu PostgREST garanti (`id=in.()`)
    // — c'est deja documente dans lib/stats-avis.js. Le cas est atteignable : un
    // token qui ne pointe que des biens supprimes. Sans bien, il n'y a rien a
    // montrer, et surtout rien a demander a la base.
    const propIdsPresta = properties.map(p => p.id)
    if (!identifiee && !propIdsPresta.length) {
      return res.json({
        bookings: [], label: tokenData.label, property_ids: allowedIds,
        visibility_days: visibilityDays, comments: [], events: [], done: [],
        menages: null, prenom: null
      })
    }
    // ⚠ DEUX FAMILLES DE MENAGES POUR UNE PRESTATAIRE IDENTIFIEE :
    //   - ceux qu'elle PORTE (`provider_id`), y compris ceux qu'on est en train
    //     de proposer a quelqu'un d'autre — ils restent les siens tant que
    //     personne n'a accepte ;
    //   - ceux qu'on lui PROPOSE (`offered_to`), qu'elle ne porte pas encore.
    // Les confondre, c'etait soit lui retirer un menage dont elle reste
    // responsable, soit lui en attribuer un qu'elle n'a pas accepte.
    requete = identifiee
      ? requete.or(`provider_id.eq.${profilPresta.id},offered_to.eq.${profilPresta.id}`)
      : requete.is('provider_id', null).is('offered_to', null).in('property_id', propIdsPresta)
    const { data: mn, error: errMen } = await requete
    // ⚠ Une liste vide par panne serait indiscernable d'« aucun menage », et la
    // prestataire conclurait qu'elle n'a rien a faire aujourd'hui.
    if (errMen) {
      console.error('[menages-public] lecture des menages echec:', errMen.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    const menagesAssignes = identifiee ? (mn || []) : null
    const siens = new Set((mn || []).map(m =>
      `${String(m.property_id)}|${String(m.booking_id)}|${m.departure_date}`))
    // ⚠ LE FILTRE S'APPLIQUE DANS LES DEUX CAS. Un seul chemin non filtre
    // suffisait a rouvrir la fuite ; il n'y en a plus.
    allBookings = allBookings.filter(b =>
      siens.has(`${b.propId}|${String(b.id)}|${b.departure}`))

    const bookingIds = allBookings.map(b => String(b.id))
    let comments = []
    if (bookingIds.length) {
      const { data: cd } = await supabase.from('menage_comments')
        .select('booking_id, departure_date, comment, property_id')
        .eq('user_id', userId).in('booking_id', bookingIds)
      comments = cd || []
    }

    // ⚠ LE FIL D'ACTUALITES EST FILTRE LUI AUSSI.
    // `menage_events` est diffuse PAR BIEN (lib/cleaning/sync-menages.js) : tout
    // token dont `property_ids` couvre le bien recoit une ligne, sans aucune
    // notion de prestataire — la table n'a pas de `provider_id`. Lu par
    // `.eq('token', …)` seul, ce fil affichait donc a une nouvelle prestataire
    // le nom du voyageur, l'arrivee et le depart de CHAQUE reservation du bien,
    // y compris les menages de quelqu'un d'autre. Le filtrage des reservations
    // ne servait a rien tant que cette porte restait ouverte.
    //
    // On garde les evenements qui portent sur un menage a elle, plus ceux qui ne
    // designent aucune reservation (les notes de l'hote, `event_type = 'note'`,
    // qui s'adressent au porteur du lien).
    const { data: eventsBruts } = await supabase.from('menage_events').select('*')
      .eq('token', token).eq('read', false)
      .gte('created_at', new Date(Date.now() - visibilityDays * 86400000).toISOString())
      .order('created_at', { ascending: false }).limit(50)
    const bookingsSiens = new Set(allBookings.map(b => `${b.propId}|${String(b.id)}`))
    const eventsData = (eventsBruts || []).filter(e =>
      e.event_type === 'note' ||
      bookingsSiens.has(`${String(e.property_id)}|${String(e.booking_id)}`))

    // NOUVEAU : on renvoie aussi la liste des menages deja faits cote serveur.
    // Le front fera l'union avec son localStorage (offline) avant affichage.
    // On filtre uniquement sur les biens autorises ET la fenetre temporelle
    // pour eviter de balancer tout l'historique.
    const propIdsForDone = (allowedIds.length ? allowedIds : properties.map(p => String(p.id)))
    let doneList = []
    if (propIdsForDone.length) {
      const { data: dd } = await supabase.from('menage_done')
        .select('booking_id, property_id, departure_date, done_at')
        .eq('user_id', userId)
        .in('property_id', propIdsForDone)
        .gte('departure_date', dateFrom)
        .lte('departure_date', dateTo)
      // ⚠ RESTREINT AUX MENAGES QUI SONT LES SIENS. Cette liste etait calculee
      // sur les biens du TOKEN : elle laissait passer les `booking_id` et les
      // dates des menages termines par l'autre prestataire — a travers le filtre
      // que ce lot vient d'installer.
      doneList = (dd || []).filter(d =>
        siens.has(`${String(d.property_id)}|${String(d.booking_id)}|${d.departure_date}`))
    }

    return res.json({
      bookings: allBookings, label: tokenData.label,
      property_ids: allowedIds, visibility_days: visibilityDays,
      comments, events: eventsData || [],
      done: doneList,
      // Le statut de chaque menage assigne : `offered` = a confirmer (suppleant),
      // `accepted` = engage. `null` quand ce token n'a pas encore de profil —
      // l'ecran ne doit alors afficher aucun etat d'assignation plutot qu'un
      // etat faux.
      // Chaque menage dit CE QU'IL EST pour celle qui regarde :
      //   role 'porteur'  -> il est a elle (une proposition peut etre en cours) ;
      //   role 'propose'  -> on le lui propose, elle ne le porte pas encore.
      // Le prenom de la personne sollicitee n'est PAS renvoye a la porteuse :
      // savoir qu'une proposition est en cours lui suffit, et le nom de sa
      // collegue ne la regarde pas plus que l'organisation de l'hote.
      menages: menagesAssignes && menagesAssignes.map(m => ({
        booking_id: m.booking_id, property_id: m.property_id,
        departure_date: m.departure_date, status: m.status,
        role: profilPresta && m.provider_id === profilPresta.id ? 'porteur' : 'propose',
        propose: !!m.offered_to,
        expire_le: m.offered_to ? m.offer_expires_at : null
      })),
      prenom: profilPresta ? profilPresta.first_name : null
    })

  } catch (err) {
    console.error('[MenagesPublic]', err)
    return res.status(500).json({ error: 'Erreur serveur' })
  }
}

// Helper : date du jour en zone Europe/Paris au format YYYY-MM-DD.
// Important : on raisonne en string pure pour eviter les pieges timezone
// (cf. catalogue bugs critiques resolus, regle "dates pures").


// ⚠ L'ETIQUETTE « RETOUR PRIVE » ECHOUE DU BON COTE : dans le doute, elle est
// POSEE.
//
// Un `content_private.includes(extrait)` ratait un cas reel : la classification
// analyse la CONCATENATION de content_public, content_private et content, et
// `extraitVerifie` tolere les ecarts d'espaces. Un extrait qui commence dans le
// public et finit dans le prive — le saut de ligne de jointure etant absorbe par
// la souplesse — n'est une sous-chaine exacte NI de l'un NI de l'autre. Il
// sortait alors avec `prive: false`, et la prestataire lisait un reproche venu
// d'un message que le voyageur n'avait pas rendu public, sans le savoir, donc
// libre de le citer ailleurs.
//
// La regle : prive DES QU'il n'est pas certainement public.
function extraitEstPrive (a) {
  const extrait = a?.ai_clean_excerpt
  if (!extrait) return false
  if (!a.content_private) return false          // pas de retour prive du tout
  // Retrouve dans le prive, meme avec des ecarts d'espaces -> prive.
  if (extraitVerifie(a.content_private, extrait)) return true
  // Retrouve INTEGRALEMENT dans le public -> public, sans ambiguite.
  if (a.content_public && extraitVerifie(a.content_public, extrait)) return false
  // Ni l'un ni l'autre : extrait a cheval, ou texte modifie depuis l'analyse.
  // On etiquette, c'est le defaut sur.
  return true
}

// ─── Vue « Avis » de la prestataire (spec-prestataires-menage §6) ───────────
//
// ⚠ CE QUE LA PRESTATAIRE VOIT, ET SEULEMENT CELA :
//   - l'EXTRAIT de proprete, jamais l'avis complet ;
//   - jamais le nom du voyageur, ni rien qui permette de l'identifier ;
//   - une mention « retour prive du voyageur » quand l'extrait en vient : elle
//     doit savoir qu'elle lit un message que le voyageur n'avait pas rendu
//     public, pour ne pas le citer ailleurs ;
//   - rien du tout si `self_view_reviews` est faux : l'hote garde la main sur
//     ce qu'il transmet.
//
// La liste et le ratio passent par la MEME fonction que /avis : deux chiffres
// calcules differemment finiraient par se contredire, et c'est celui-ci qui
// perdrait sa credibilite.
// Les quatre cles de lib/stats-avis.js, repetees ici parce que le defaut n'est
// pas le meme : « toujours » cote PWA, '30j' cote /avis.
const PERIODES_PWA = ['15j', '30j', '6mois', 'toujours']

// ⚠ CE MENAGE EST-IL LE SIEN ?
//
// `markDone` et `markUndone` ne verifiaient NI `public_tokens.property_ids`, NI
// l'assignation : ils resolvaient le token en `user_id` puis ecrivaient sur le
// `property_id` / `booking_id` fournis par le CLIENT. N'importe quel porteur de
// lien pouvait donc marquer fait — ou defaire — le menage de quelqu'un d'autre,
// sur n'importe quel bien du compte. C'est REVIEW.md regle 11 : une donnee
// client qui designe une ressource ne se valide pas, elle ne s'utilise pas.
//
// La regle est la meme que pour la LECTURE : le menage doit lui appartenir, ou
// n'appartenir a personne (token sans profil, lien legacy). Une panne coupe.
async function menageDeCePorteur (userId, token, { propertyId, bookingId, departureDate }) {
  const { data: profil, error: errProfil } = await supabase.from('profiles')
    .select('id, active').eq('account_user_id', userId).eq('pwa_token', token).maybeSingle()
  if (errProfil) return { erreur: true }

  const { data: menage, error: errMen } = await supabase.from('menages')
    .select('provider_id, status, offered_to')
    .eq('user_id', userId).eq('property_id', String(propertyId))
    .eq('booking_id', String(bookingId)).eq('departure_date', departureDate)
    .maybeSingle()
  if (errMen) return { erreur: true }

  // ⚠ Aucun menage en base : on LAISSE PASSER, en repli sur le perimetre du
  // token. La table vient d'etre creee et le writer ne couvre que J-30/J+180 ;
  // refuser ici casserait le marquage d'un menage plus ancien, que la
  // prestataire rattrape justement depuis sa PWA (fenetre de 14 jours en
  // arriere). Le cloisonnement par bien reste applique dans ce cas.
  if (!menage) return { autorise: 'perimetre' }

  const identifiee = !!(profil && profil.active !== false)

  // ⚠ CELLE QUI PORTE LE MENAGE PEUT TOUJOURS LE MARQUER FAIT, meme si une
  // proposition est en cours : il reste le sien tant que personne n'a accepte.
  if (identifiee && menage.provider_id === profil.id) return { autorise: true }

  // ⚠ ON NE FAIT PAS UN MENAGE QU'ON N'A PAS ACCEPTE.
  // La garde testait `status === 'offered'`, en supposant que proposition
  // impliquait ce statut. Le modele parallele casse cette equivalence : une
  // proposition posee sur un menage `unassigned` laisse le statut intact. Un
  // menage sous proposition redevenait donc « a personne » — n'importe quelle
  // prestataire identifiee du compte pouvait le marquer fait, ou le DEFAIRE,
  // avec le seul triplet (bien, reservation, date) qu'elle lit dans sa PWA.
  // C'est desormais `offered_to` qui tranche, comme partout ailleurs.
  if (menage.offered_to) {
    return identifiee && menage.offered_to === profil.id
      ? { autorise: false, motif: 'offre' }   // a elle, mais pas encore acceptee
      : { autorise: false }
  }

  if (!menage.provider_id) return { autorise: true }
  return { autorise: false }
}

// Les biens que ce token peut toucher. Repli quand aucun menage n'existe encore.
async function bienDansLePerimetre (userId, token, propertyId) {
  const { data: pt, error } = await supabase.from('public_tokens')
    .select('property_ids').eq('token', token).maybeSingle()
  if (error) return { erreur: true }
  const ids = (pt?.property_ids || []).map(String)
  return { autorise: !ids.length || ids.includes(String(propertyId)) }
}

// Repond a une offre de menage. Acceptation ou refus, meme chemin.
//
// ⚠ ACCEPTATION ATOMIQUE (spec §3 bis, conservee telle quelle) : la condition
// `status='offered' and provider_id=<elle>` est posee DANS l'update, pas testee
// avant. Zero ligne modifiee = l'offre n'est plus valide — expiree, retiree, ou
// reassignee a la main pendant qu'elle avait l'ecran ouvert. Deux acceptations
// concurrentes, ou une acceptation qui croise une reassignation de l'hote, ne
// peuvent pas produire de double affectation.
async function repondreALOffre (req, res, token, { accepte, propertyId, bookingId, departureDate }) {
  const { data: pt, error: errTok } = await supabase.from('public_tokens')
    .select('user_id').eq('token', token).maybeSingle()
  if (errTok) {
    console.error('[menages-public] lecture du token echec:', errTok.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  if (!pt) return res.status(401).json({ error: 'Token invalide' })
  const userId = pt.user_id

  // ⚠ Repondre a une offre suppose d'ETRE quelqu'un. Un lien sans profil ne
  // porte aucune assignation : il n'a rien a accepter, et le laisser faire
  // ecrirait une acceptation au nom de personne.
  const { data: profil, error: errProfil } = await supabase.from('profiles')
    .select('id, first_name, active').eq('account_user_id', userId).eq('pwa_token', token).maybeSingle()
  if (errProfil) {
    console.error('[menages-public] lecture du profil echec:', errProfil.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  if (!profil || profil.active === false) {
    return res.status(403).json({ error: 'Ce lien ne permet pas de répondre à une offre' })
  }

  const { data: menage, error: errMen } = await supabase.from('menages')
    .select('id, provider_id, status, offered_to')
    .eq('user_id', userId).eq('property_id', String(propertyId))
    .eq('booking_id', String(bookingId)).eq('departure_date', departureDate)
    .maybeSingle()
  if (errMen) {
    console.error('[menages-public] lecture du menage echec:', errMen.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  if (!menage) return res.status(404).json({ error: 'Ménage introuvable' })

  if (accepte) {
    // ⚠ C'EST ICI, ET SEULEMENT ICI, QUE LA RESPONSABILITE SE TRANSFERE.
    // Jusqu'a cet instant le menage etait porte par la referente ; il bascule
    // maintenant chez celle qui accepte, et la proposition s'efface.
    //
    // La condition reste ATOMIQUE, et elle porte desormais sur `offered_to` (a
    // qui on l'a propose) et sur l'echeance. La tester avant d'ecrire laisserait
    // une fenetre ou l'hote reassigne, ou l'offre expire, entre les deux.
    const { data: maj, error: errMaj } = await supabase.from('menages')
      .update({ provider_id: profil.id, status: 'accepted',
                offered_to: null, offered_at: null, offer_expires_at: null,
                // ⚠ PAS de `assigned_by: 'auto'` : ecraser un verrou pose par
                // l'hote le ferait disparaitre, et une resurrection ulterieure
                // recalculerait l'assignation contre sa decision.
                assignment_reason: `Accepte par ${profil.first_name}.`,
                accepted_at: new Date().toISOString(),
                updated_at: new Date().toISOString() })
      .eq('id', menage.id).eq('offered_to', profil.id)
      .gt('offer_expires_at', new Date().toISOString())
      // ⚠ Une PWA restee ouverte sur un menage dont la reservation a disparu
      // pouvait le repasser en `accepted` avec un porteur — un menage vivant
      // pour une reservation qui ne l'est plus.
      .neq('status', 'cancelled')
      .select('id')
    if (errMaj) {
      console.error('[menages-public] acceptation echec:', errMaj.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    // ⚠ Zero ligne : ce n'est PAS une erreur technique, c'est une course perdue.
    // On le DIT plutot que de rendre un succes : elle doit savoir que ce menage
    // ne lui revient plus, sinon elle s'organisera autour.
    if (!maj || !maj.length) {
      return res.status(409).json({ error: 'Cette offre n\'est plus disponible' })
    }
    await supabase.from('menage_assignment_log').insert({
      user_id: userId, menage_id: menage.id, event: 'accepted',
      // Le transfert est trace des deux cotes : qui le portait, qui le porte.
      from_provider_id: menage.provider_id, to_provider_id: profil.id,
      actor: 'provider',
      reason: menage.provider_id ? 'Transfert a l\'acceptation.' : null
    })
    return res.json({ success: true, status: 'accepted' })
  }

  // REFUS. ⚠ IL N'EFFACE QUE LA PROPOSITION, JAMAIS LE PORTEUR.
  //
  // Si une referente porte ce menage, il RESTE chez elle comme si de rien
  // n'etait — elle l'a toujours eu. Rien n'est decouvert, donc rien n'appelle
  // une alerte, et le selecteur de reassignation de l'hote redevient libre.
  // La version precedente mettait le menage en `orphaned` et le retirait a tout
  // le monde : un logement se retrouvait sans personne alors qu'une referente
  // le couvrait.
  //
  // Le cas grave est l'autre : PERSONNE ne porte ce menage — un bien sans
  // referente. La, il devient `orphaned`, se verrouille (le writer ne doit pas
  // le rendre a qui vient de le refuser) et l'hote est alerte.
  //
  // ⚠ LA REMPLACANTE PREND LE RELAIS (lot 3.3, §12.4). Elle est calculee AVANT
  // d'ecrire, et posee dans le MEME update : la calculer apres aurait laisse le
  // menage sans proposition — et, quand personne ne le porte, `orphaned` avec
  // une alerte — entre les deux ecritures. C'est la candidate SUIVANTE du jour,
  // en sautant celles que le journal connait deja comme ayant refuse ou laisse
  // expirer : sans cette memoire, on reproposerait a qui vient de dire non.
  const porte = !!menage.provider_id
  const suivante = await remplacanteApresRefus({
    userId, propertyId, departureDate, menageId: menage.id,
    refusee: profil.id, porteurId: menage.provider_id
  })

  const { data: maj, error: errMaj } = await supabase.from('menages')
    .update({
      ...(suivante
        ? { // La proposition n'est ecrite QUE s'il y a quelqu'un a solliciter :
            // une releve peut n'etre qu'une porteuse posee.
            ...(suivante.providerId
              ? { offered_to: suivante.providerId,
                  offered_at: new Date().toISOString(),
                  offer_expires_at: suivante.echeance }
              : { offered_to: null, offered_at: null, offer_expires_at: null }),
            // ⚠ Trois etats possibles, et un seul est faux :
            //   - quelqu'un porte deja : son statut ne bouge pas, la proposition
            //     vit A COTE ;
            //   - personne ne porte MAIS la garde du jour designe une candidate
            //     d'office : on la pose porteuse, et le menage est `accepted` ;
            //   - personne ne porte et personne d'office : `offered`.
            ...(porte ? {} : (suivante.porteuse
                  ? { provider_id: suivante.porteuse, status: 'accepted',
                      accepted_at: new Date().toISOString() }
                  : { status: 'offered' })),
            assignment_reason: suivante.providerId
              ? `Refuse par ${profil.first_name} : propose a la candidate suivante.`
              : `Refuse par ${profil.first_name} : repris par la personne de garde ce jour-la.` }
        : { offered_to: null, offered_at: null, offer_expires_at: null,
            ...(porte
              ? { assignment_reason: `Propose a ${profil.first_name}, qui a refuse : reste chez son porteur.` }
              : { status: 'orphaned', assigned_by: 'manual',
                  assignment_reason: `Refuse par ${profil.first_name}, et personne ne porte ce menage.` }) }),
      updated_at: new Date().toISOString()
    })
    .eq('id', menage.id).eq('offered_to', profil.id)
    .select('id')
  if (errMaj) {
    console.error('[menages-public] refus echec:', errMaj.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  if (!maj || !maj.length) {
    return res.status(409).json({ error: 'Cette offre n\'est plus disponible' })
  }
  await supabase.from('menage_assignment_log').insert({
    user_id: userId, menage_id: menage.id, event: 'declined',
    from_provider_id: profil.id, actor: 'provider',
    reason: 'Refus depuis la PWA.'
  })
  if (suivante && suivante.porteuse) {
    await supabase.from('menage_assignment_log').insert({
      user_id: userId, menage_id: menage.id, event: 'assigned',
      from_provider_id: profil.id, to_provider_id: suivante.porteuse,
      actor: 'cron', reason: 'Refus : le menage revient a la personne de garde ce jour-la.'
    })
  }
  if (suivante && suivante.providerId) {
    // ⚠ L'ESCALADE EST TRACEE COMME UNE PROPOSITION DE L'AUTOMATE (`actor:'cron'`) :
    // ce n'est pas la personne qui refuse qui a choisi sa remplacante.
    await supabase.from('menage_assignment_log').insert({
      user_id: userId, menage_id: menage.id, event: 'offered',
      from_provider_id: menage.provider_id || null, to_provider_id: suivante.providerId,
      actor: 'cron', reason: 'Escalade automatique apres refus : candidate suivante du jour.'
    })
    // ⚠ BEST-EFFORT, ET APRES L'ECRITURE. Une proposition muette expirerait sans
    // que la personne ait su qu'on lui demandait quelque chose.
    try {
      await notifierProposition({
        userId, providerId: suivante.providerId,
        propertyName: await nomDuBien(userId, propertyId),
        propertyId: String(propertyId),
        departureDate, expireLe: suivante.echeance,
        lien: `${(process.env.PUBLIC_BASE_URL || 'https://hotesmart.vercel.app').replace(/\/+$/, '')}/apps/menages/public`
      })
    } catch (e) { console.error('[menages-public] notification escalade echec:', e.message) }
  }
  // ⚠ ALERTE SEULEMENT SI PLUS PERSONNE NE PORTE CE MENAGE.
  // Alerter sur un refus dont la referente garde la charge serait du bruit :
  // rien n'est decouvert, elle l'a toujours eu, et l'hote finirait par ne plus
  // lire ces messages. Il est informe autrement — la mention « propose a X »
  // disparait de son planning, et le selecteur redevient libre.
  //
  // Quand PERSONNE ne le porte, en revanche, c'est un logement qui ne sera pas
  // prepare : la, l'alerte est justifiee. `alertMenageRefuse` pose une tache
  // in-app, toujours visible et sans configuration prealable, plus un SMS/email
  // best-effort — `reportIncident` n'aurait prevenu que le fondateur.
  //
  // ⚠ UNE ESCALADE REUSSIE N'ALERTE PAS NON PLUS : quelqu'un vient d'etre
  // sollicite, rien n'est decouvert. Si elle ne repond pas, l'expiration
  // reprendra la main — et alertera alors, puisque la file sera epuisee.
  if (!porte && !(suivante && (suivante.providerId || suivante.porteuse))) {
    try {
      await alertMenageRefuse({
        userId, propertyId: String(propertyId), bookingId,
        departureDate, prenom: profil.first_name
      })
    } catch (e) { console.error('[menages-public] alerte refus echec:', e.message) }
  }
  // ⚠ ON NE REND QUE CE QUI S'EST REELLEMENT PASSE — la PWA construit son
  // message dessus, et le commit c6d0553 a montre ce que coute une promesse
  // inexacte :
  //   `porte`    : quelqu'un a la charge du menage a la sortie de ce refus — soit
  //                depuis toujours, soit parce qu'on vient d'y poser la personne
  //                de garde du jour ;
  //   `escalade` : quelqu'un vient d'etre SOLLICITE. Poser une porteuse n'est pas
  //                une sollicitation : elle n'a rien a repondre.
  // ⚠ La porteuse posee ici n'est pas notifiee, comme toute assignation decidee
  // par l'automate : le menage est dans sa PWA, et personne n'attend de reponse.
  return res.json({
    success: true,
    porte: porte || !!(suivante && suivante.porteuse),
    escalade: !!(suivante && suivante.providerId)
  })
}

// Qui prend le relais apres un refus, ce jour-la.
//
// ⚠ RIEN N'EST ECRIT ICI : cette fonction CALCULE, l'appelant ecrit — dans le
// meme update que le refus, pour qu'il n'existe aucun instant ou le menage soit
// a la fois refuse et sans proposition.
//
// ⚠ UNE PANNE N'EMPECHE PAS LE REFUS. On rend `null`, et on retombe sur le
// comportement du modele parallele : le menage reste chez sa porteuse (ou
// devient `orphaned` si personne ne le porte, avec alerte a l'hote). Faire
// echouer un refus parce que le calcul de la remplacante est en panne
// obligerait la prestataire a reessayer, ou pire, la laisserait engagee.
//
// ⚠ HORS FENETRE DE PROPOSITION, `deciderParGarde` rend `offeredTo: null` : un
// depart lointain n'est pas escalade tout de suite, il le sera par le cron quand
// la date approchera — le journal du refus etant deja ecrit, la personne qui
// vient de refuser ne sera pas resollicitee.
async function remplacanteApresRefus ({ userId, propertyId, departureDate, menageId, refusee, porteurId }) {
  try {
    const liaisonsParBien = await chargerLiaisons(supabase, [{ userId, propertyId }])
    const dispos = await chargerDisponibilites(supabase, [userId], { du: departureDate, au: departureDate })
    const refus = await chargerRefus(supabase, [menageId])
    // ⚠ La ligne `declined` de CE refus n'est pas encore ecrite : sans cet ajout,
    // la remplacante calculee serait la personne qui vient de refuser.
    const exclus = new Set(refus.get(String(menageId)) || [])
    exclus.add(String(refusee))

    const bien = {
      userId, propertyId: String(propertyId),
      liaisons: liaisonsParBien.get(`${userId}|${String(propertyId)}`) || [],
      regles: dispos.regles, exceptions: dispos.exceptions
    }
    const choix = deciderParGarde(bien, departureDate, { exclus })

    // ⚠ LA PORTEUSE D'OFFICE EST RENDUE MEME SANS PERSONNE A SOLLICITER.
    // Sortir des qu'il n'y a plus de proposition jetait ce repli — et depuis la
    // restriction sur les jours attitres, `offeredTo` est nul dans TOUS les cas
    // reels tant que le lot 3.5 n'existe pas. Un menage que personne ne porte
    // alors qu'une candidate d'office est la — l'hote vient de la lier, ou son
    // conge s'est termine — partait donc en `orphaned` + verrou `manual` : plus
    // aucun chemin ne le reprend (ni le writer, ni la pose differee, ni le
    // rattrapage), et il reste sans personne pour toujours.
    // ⚠ ET JAMAIS CELLE QUI VIENT DE REFUSER. `deciderParGarde` choisit la
    // porteuse par « la premiere qui n'a rien a confirmer », SANS consulter
    // `exclus` — c'est voulu la-bas (une personne d'office ne se retire pas du
    // planning parce qu'elle a decline une proposition), mais ici ce serait
    // absurde : depuis que la fiche permet de basculer une liaison sur
    // « d'office » en un clic, une offre en cours chez quelqu'un qui devient
    // d'office et refuse lui aurait ete RECOLLEE dans la seconde, avec un
    // journal ou `from` et `to` sont la meme personne et une PWA qui lui annonce
    // que « quelqu'un a repris » son menage.
    let porteuse = porteurId ? null : (choix.providerId || null)
    if (porteuse && exclus.has(String(porteuse))) porteuse = null

    // ⚠ `menages_offre_pas_a_soi` : la responsable du jour peut etre celle qui
    // porte deja le menage. Lui proposer ce qu'elle a deja ferait echouer
    // l'update — donc le refus lui-meme. Idem si c'est la porteuse qu'on
    // s'apprete a poser.
    let proposeeA = choix.offeredTo || null
    const dejaLa = porteurId || porteuse
    if (proposeeA && dejaLa && String(proposeeA) === String(dejaLa)) proposeeA = null

    if (!proposeeA && !porteuse) return null
    return {
      providerId: proposeeA,
      echeance: proposeeA ? echeanceOffre(departureDate) : null,
      porteuse
    }
  } catch (e) {
    console.error('[menages-public] calcul de la remplacante echec:', e.message)
    return null
  }
}

// Le nom du bien, pour que le SMS dise de quoi il parle. Jamais bloquant.
async function nomDuBien (userId, propertyId) {
  const { data, error } = await supabase.from('properties')
    .select('name').eq('user_id', userId)
    .eq('provider_property_id', String(propertyId)).maybeSingle()
  // ⚠ L'erreur est LUE : `provider_property_id` n'a pas de contrainte d'unicite,
  // et `maybeSingle` rend une erreur sur deux lignes. Ignoree, le SMS partait
  // sans nom de bien, en silence.
  if (error) { console.error('[menages-public] nom du bien illisible:', error.message); return null }
  return data && data.name ? data.name : null
}

async function avisDeLaPrestataire (req, res, token) {
  // ⚠ L'ERREUR EST LUE. Un `select` en panne (timeout, 5xx transitoire) rend
  // `data` null, indiscernable d'un token inconnu : la PWA repondait alors
  // « Token invalide » a une prestataire dont le lien est parfaitement valide.
  // Un repli sur un second select avait ete tente ici pour survivre a une
  // migration non passee ; il avalait AUSSI les pannes reseau, et le ratio se
  // recalculait alors « depuis le debut » au lieu des 15 jours regles par
  // l'hote — un elargissement silencieux, la faute symetrique de celle que la
  // validation de periode ferme. Une panne coupe, elle ne devine pas.
  const { data: pt, error: errToken } = await supabase.from('public_tokens')
    .select('user_id, ratio_periode').eq('token', token).maybeSingle()
  if (errToken) {
    console.error('[menages-public] lecture du token echec:', errToken.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  if (!pt) return res.status(401).json({ error: 'Token invalide' })
  const userId = pt.user_id

  // Le profil derriere ce token. Sans profil, pas d'attribution possible : on
  // rend une vue vide plutot que d'inventer un rattachement.
  const { data: profil } = await supabase.from('profiles')
    .select('id, first_name, active')
    .eq('account_user_id', userId).eq('pwa_token', token).maybeSingle()
  if (!profil || profil.active === false) {
    return res.status(200).json({ actif: false, ratio: null, avis: [] })
  }

  // ⚠ `self_view_reviews` coupe la vue entiere. Le defaut est `true`
  // (lib/permissions.js) : l'absence de ligne de droits ne doit pas priver la
  // prestataire de ce qui la concerne.
  const { data: droits, error: errDroits } = await supabase.from('profile_permissions')
    .select('self_view_reviews').eq('profile_id', profil.id).maybeSingle()
  // ⚠ SUR UN DRAPEAU DE CONFIDENTIALITE, LA PANNE COUPE — elle n'ouvre pas.
  // L'erreur n'etait pas lue : un timeout PostgREST rendait `droits` null, et la
  // vue s'affichait ENTIEREMENT, y compris pour un hote ayant explicitement mis
  // self_view_reviews a false. Et `null` ne veut pas dire « pas de ligne » :
  // api/membres.js supprime le profil si l'insertion des droits echoue, donc une
  // ligne existe toujours.
  if (errDroits) {
    console.error('[menages-public] lecture des droits echec:', errDroits.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  if (droits && droits.self_view_reviews === false) {
    return res.status(200).json({ prenom: profil.first_name, autorise: false, ratio: null, avis: [] })
  }

  // ⚠ DEUX PERIODES, DEUX FONCTIONS. Ne pas les confondre.
  //
  // `periode` — celle que l'HOTE a reglee (public_tokens.ratio_periode) — porte
  // le ratio permanent de l'en-tete : c'est l'OBJECTIF fixe, et il n'appartient
  // pas au porteur du lien de le deplacer. Aucun parametre client ne l'atteint.
  //
  // `periodeVue` — celle que la PRESTATAIRE choisit dans l'onglet — porte le
  // dossier : son compteur et sa liste. C'est de la CONSULTATION libre, sur des
  // avis qui sont deja les siens ; l'hote garde l'interrupteur qui coupe tout
  // (`self_view_reviews`), et c'est lui la garde de confidentialite, pas cette
  // fenetre. Sans ce cloisonnement, un sélecteur dans l'onglet deplacerait
  // l'objectif affiche en haut.
  //
  // ⚠ `periodeNormalisee` retombe sur '30j' — un defaut adapte a /avis, ou la
  // periode vient d'un selecteur, mais PAS ici : une valeur inconnue (contrainte
  // tombee, correctif SQL, ou query string bricolee) retrecirait un compteur
  // sans que personne ne l'ait demande. On valide explicitement, des deux cotes.
  const brut = String(pt.ratio_periode || 'toujours')
  const periode = PERIODES_PWA.includes(brut) ? brut : 'toujours'
  // ⚠ ASYMETRIE VOULUE, a ne pas « corriger » : parametre ABSENT -> on suit
  // l'objectif de l'hote (defaut sur), parametre PRESENT mais invalide -> on
  // rend « toujours ». Une valeur bricolee n'ouvre rien de plus — la
  // consultation est libre par decision produit — et le selecteur du front a
  // exactement le meme repli, si bien que les deux ne se contredisent pas.
  const brutVue = String(req.query.periode || periode)
  const periodeVue = PERIODES_PWA.includes(brutVue) ? brutVue : 'toujours'

  // ⚠ RESOLUE UNE FOIS POUR TOUTE LA REQUETE. Deux comptages et une liste la
  // resolvaient chacun de leur cote, avec les memes arguments : trois allers-
  // retours base identiques sur un endpoint ouvert sans session, qu'un porteur
  // de lien peut marteler. Une seule resolution, partagee.
  const attribution = await avisDuPrestataire(supabase, { userId, prestataireId: profil.id })
  if (attribution.erreur) {
    console.error('[menages-public] attribution echec')
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  const ratio = await ratioProprete(supabase, { userId, periode, prestataireId: profil.id, attribution })

  // ⚠ CONTRAT A HONORER PAR L'INTERFACE PWA, QUI RESTE A ECRIRE.
  // `ratio` peut porter `erreur: true` : c'est une PANNE, pas un resultat. Le
  // front DEVRA le lire AVANT d'afficher quoi que ce soit — sans quoi il
  // montrera « 0 avis, 0 remarque » a une prestataire qui en a 98, et elle en
  // tirera une conclusion fausse.
  // On ne transforme pas cette panne en 503 ici : la vue par defaut n'affiche
  // qu'un ratio a cote du prenom, et couper toute la page pour un compteur
  // indisponible serait disproportionne. C'est a l'affichage de dire « compteurs
  // indisponibles » — comme le fait deja pages/avis.html.

  // La liste n'est chargee qu'a la demande : la vue par defaut n'affiche que le
  // ratio a cote du prenom.
  let avis = []
  let listeTronquee = false
  // Le compteur du dossier. Recalcule seulement s'il porte une autre periode que
  // l'objectif : deux comptages identiques coutent deux fois pour rien.
  let ratioVue = null
  if (req.query.detail === '1') {
    ratioVue = periodeVue === periode
      ? ratio
      : await ratioProprete(supabase, { userId, periode: periodeVue, prestataireId: profil.id, attribution })
    // ⚠ UNE PANNE N'EST PAS « AUCUN AVIS » : elle coupe en 503 (garde posee plus
    // haut, a la resolution unique). Sauter silencieusement laissait partir un
    // 200 avec une liste vide, indiscernable de « elle n'a aucun avis » — alors
    // que la base en contient 98 pour Regina.
    const att = attribution
    if (att.ids.length) {
      listeTronquee = att.tronque === true || att.ids.length > MAX_IDS
      // ⚠ La liste suit la periode CHOISIE, pas l'objectif : un compteur qui
      // annonce 30 jours au-dessus d'une liste qui en montre 15 est un ecran qui
      // se contredit.
      const borne = borneDepuis(periodeVue)
      let q = supabase.from('ota_reviews')
        // ⚠ NI `guest_name`, NI `content`, NI `content_public`, NI `raw`.
        // Seul l'extrait sort, avec de quoi le dater et savoir s'il est prive.
        // `content_public` sert UNIQUEMENT a decider de l'etiquette, cote
        // serveur ; il ne part jamais au front.
        .select('id, ai_clean_verdict, ai_clean_excerpt, content_private, content_public, received_at, stay_start, stay_end, property_id_ref')
        .eq('user_id', userId).eq('statut', 'confirme')
        // Meme borne que l'attribution : au-dela, l'URL PostgREST casse.
        .in('id', att.ids.slice(0, MAX_IDS))
        .order('received_at', { ascending: false, nullsFirst: false })
        .limit(200)
      if (borne) q = q.gte('received_at', borne)
      const { data, error: errListe } = await q
      // Une liste vide parce que la requete a rate est indiscernable de « aucun
      // avis » — et le ratio affiche a cote annoncerait, lui, un nombre non nul.
      if (errListe) {
        console.error('[menages-public] liste des avis echec:', errListe.message)
        return res.status(503).json({ error: 'Service temporairement indisponible' })
      }
      avis = (data || []).map(a => ({
        id: a.id,
        verdict: a.ai_clean_verdict,
        // L'extrait, et rien d'autre du texte.
        extrait: a.ai_clean_excerpt || null,
        // ⚠ On ne renvoie PAS content_private : on dit seulement si l'extrait en
        // provient, pour l'etiqueter. Le comparer ici evite de laisser le front
        // le deduire, donc de lui transmettre le texte prive.
        prive: extraitEstPrive(a),
        // ⚠ TROIS DATES DISTINCTES, JAMAIS FONDUES EN UNE.
        // `stay_end || received_at` presentait une date de reception comme une
        // date de sejour des que l'ancrage manquait — c'est ce qui permet a la
        // prestataire d'identifier LE menage concerne, elle ne doit pas etre
        // devinee. L'affichage etiquette ce qu'il montre ; l'import de
        // l'historique fera basculer les avis vers leur vraie date de sejour.
        sejourDebut: a.stay_start || null,
        sejourFin: a.stay_end || null,
        recuLe: a.received_at || null,
        bien: a.property_id_ref,
        // Rempli juste apres. `property_id_ref` est un identifiant provider :
        // « 287031 » ne dit rien a une femme de menage.
        bienNom: null
      }))

      // Le nom lisible du bien. Il ne peut PAS etre resolu par le front : sa
      // liste de biens est construite a partir des reservations de la fenetre
      // visible (14 jours en arriere, 30 en avant), alors qu'un avis peut
      // porter sur un sejour bien plus ancien — le bien serait alors sans nom.
      // Une panne ici ne coupe pas la liste : les avis s'affichent quand meme,
      // sans le nom du bien. L'identifiant provider n'est PAS montre en repli —
      // « 287031 » n'apprend rien a une femme de menage.
      const refs = [...new Set(avis.map(a => a.bien).filter(Boolean))]
      if (refs.length) {
        const { data: biens, error: errBiens } = await supabase.from('properties')
          .select('provider_property_id, name')
          .eq('user_id', userId).in('provider_property_id', refs)
        if (errBiens) console.error('[menages-public] noms des biens echec:', errBiens.message)
        const nomParRef = new Map((biens || []).map(b => [String(b.provider_property_id), b.name]))
        avis.forEach(a => { a.bienNom = nomParRef.get(String(a.bien)) || null })
      }
    }
  }

  return res.status(200).json({
    prenom: profil.first_name, autorise: true,
    ratio, avis, periode,
    // ⚠ Le dossier porte SON compteur et SA periode, distincts de ceux de
    // l'en-tete. Les fondre en un seul champ ferait afficher l'un a la place de
    // l'autre au premier refactor.
    ...(ratioVue ? { ratioVue, periodeVue } : {}),
    // ⚠ La liste est coupee a MAX_IDS avant meme d'interroger `ota_reviews`.
    // Sans ce drapeau, une liste partielle se lit comme la liste complete —
    // exactement la faute contre laquelle `ratio.tronque` a ete ajoute.
    ...(listeTronquee ? { listeTronquee: true } : {})
  })
}

function todayInParis() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit'
  })
  return fmt.format(new Date()) // en-CA donne YYYY-MM-DD
}

// Note isolation provider : cet endpoint ne lit/écrit AUCUN provider en direct.
// L'envoi du message d'arrivée + code voyageur est géré par la couche cron/sync
// (lib/cron-arrival-code processArrivalCodes), déclenchée quand le ménage passe
// le logement en statut 'ready'. Les anciens helpers d'envoi direct Beds24/Seam
// (saveAndSend, generateSeamCode) ont été retirés (bloc 2b) : ils étaient morts.

// ─── « MES DISPONIBILITÉS » (lot 3.5) ───────────────────────────────────────
//
// ⚠ DOUBLE GARDE, JAMAIS L'UNE SANS L'AUTRE :
//   1. le TOKEN identifie la personne (`profiles.pwa_token`) — sans profil, il
//      n'y a personne dont ce serait le calendrier, et un lien de consultation
//      ne doit pas pouvoir mettre quelqu'un en conge ;
//   2. le DROIT `self_availability` dit si elle gere ses disponibilites
//      elle-meme. A 'none', elle passe par son hote : c'est le cas d'une
//      prestataire qui ne veut pas de cet ecran, et c'est un reglage, pas un
//      oubli.
// Le token seul autoriserait n'importe quel porteur de lien du compte ; le droit
// seul ne designerait personne.
//
// ⚠ SUR CE DROIT, LE DEFAUT EST 'none' — l'inverse de `self_view_reviews`.
// Consulter ses propres avis ne change rien pour personne ; se retirer du
// planning engage le logement de quelqu'un d'autre. Une ligne de droits absente
// ne doit donc PAS ouvrir l'ecriture.
async function celleQuiDeclare (token, { ecriture }) {
  const { data: pt, error: errTok } = await supabase.from('public_tokens')
    .select('user_id').eq('token', token).maybeSingle()
  // ⚠ Une panne n'est pas un token invalide (meme motif que `markDone`).
  if (errTok) { console.error('[menages-public] lecture du token echec:', errTok.message); return { erreur: 503 } }
  if (!pt) return { erreur: 401 }

  const { data: profil, error: errProfil } = await supabase.from('profiles')
    .select('id, first_name, active').eq('account_user_id', pt.user_id)
    .eq('pwa_token', token).maybeSingle()
  if (errProfil) { console.error('[menages-public] lecture du profil echec:', errProfil.message); return { erreur: 503 } }
  if (!profil || profil.active === false) return { erreur: 403 }

  const { data: droits, error: errDroits } = await supabase.from('profile_permissions')
    .select('self_availability').eq('profile_id', profil.id).maybeSingle()
  // ⚠ UNE PANNE COUPE. Sur un droit d'ECRITURE, deviner serait pire qu'echouer.
  if (errDroits) { console.error('[menages-public] lecture des droits echec:', errDroits.message); return { erreur: 503 } }

  const niveau = (droits && droits.self_availability) || 'none'
  if (ecriture && niveau !== 'write') return { erreur: 403 }
  if (!ecriture && niveau === 'none') return { erreur: 403 }
  return { userId: pt.user_id, profil, niveau }
}

// Ce qu'elle a declare, et ce que l'hote a pose pour elle.
//
// ⚠ ELLE VOIT LES DEUX SOURCES, ET LAQUELLE EST LAQUELLE (`source`). Masquer ce
// que l'hote a pose lui ferait croire a un bug le jour ou il corrige une de ses
// declarations — et c'est precisement le geste que le modele prevoit.
async function mesDisponibilites (req, res, token) {
  const qui = await celleQuiDeclare(token, { ecriture: false })
  if (qui.erreur === 401) return res.status(401).json({ error: 'Token invalide' })
  if (qui.erreur === 403) return res.status(200).json({ autorise: false, exceptions: [], regles: [] })
  if (qui.erreur) return res.status(503).json({ error: 'Service temporairement indisponible' })

  // ⚠ FENETRE BORNEE. Sans borne, la PWA d'une prestataire de longue date
  // telechargerait des annees de conges passes sur un telephone en 3G, pour un
  // ecran qui montre les semaines a venir.
  // ⚠ EN HEURE DE PARIS, pas en UTC. Entre minuit et 2 h du matin l'ete, l'UTC est
  // encore la veille : la liste lui montrait un jour deja passe chez elle, et la
  // garde d'ecriture plus bas le laissait declarer.
  const aujourdhui = todayInParis()
  const { data: exceptions, error } = await supabase.from('provider_availability_exceptions')
    .select('id, date, available, reason, source')
    .eq('user_id', qui.userId).eq('provider_id', qui.profil.id)
    .gte('date', aujourdhui)
    .order('date', { ascending: true }).limit(200)
  if (error) {
    console.error('[menages-public] lecture disponibilites echec:', error.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }

  // Les regles recurrentes : leur LIBELLE seulement. La chaine RRULE n'a rien a
  // faire dans une PWA, et son libelle suffit a dire « le week-end, une semaine
  // sur deux ».
  const { data: regles, error: errR } = await supabase.from('provider_availability_rules')
    .select('id, label').eq('user_id', qui.userId).eq('provider_id', qui.profil.id)
    .eq('active', true).order('created_at', { ascending: true }).limit(50)
  if (errR) {
    console.error('[menages-public] lecture regles echec:', errR.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }

  return res.status(200).json({
    autorise: true,
    modifiable: qui.niveau === 'write',
    prenom: qui.profil.first_name,
    exceptions: exceptions || [],
    regles: (regles || []).map(r => ({ id: r.id, label: r.label }))
  })
}

// Elle pose ou retire une INDISPONIBILITE. Une seule forme : un jour, absente.
//
// ⚠ ELLE NE PEUT PAS SE DECLARER DISPONIBLE UN JOUR QU'ELLE NE PREND PAS.
// `available` n'est pas un parametre : une exception posee ici vaut TOUJOURS
// `false`. Ouvrir le sens inverse lui permettrait de se rendre candidate un jour
// que l'hote ne lui a pas confie — et l'ecran de l'hote, lui, garde les deux
// sens (c'est lui qui peut dire « viens exceptionnellement ce samedi »).
async function mesIndisponibilites (req, res, token, { retirer }) {
  const qui = await celleQuiDeclare(token, { ecriture: true })
  if (qui.erreur === 401) return res.status(401).json({ error: 'Token invalide' })
  if (qui.erreur === 403) {
    return res.status(403).json({ error: 'Vos absences sont gérées par votre employeur' })
  }
  if (qui.erreur) return res.status(503).json({ error: 'Service temporairement indisponible' })

  const { date } = req.body || {}
  const jour = jourValide(date)
  if (!jour) return res.status(400).json({ error: 'Date invalide' })

  // ⚠ PAS DE DECLARATION DANS LE PASSE. Se retirer d'un jour deja passe ne veut
  // rien dire — le menage a eu lieu ou non — et cela reecrirait l'historique sur
  // lequel s'appuie l'attribution des remarques de proprete.
  if (jour < todayInParis()) {
    return res.status(400).json({ error: 'Cette date est déjà passée' })
  }

  if (retirer) {
    // ⚠ ELLE NE RETIRE QUE CE QU'ELLE A DECLARE (`source = 'prestataire'`). Une
    // absence posee par l'HOTE — « tu ne travailles pas ce jour-la » — n'est pas
    // la sienne a defaire : la lui laisser effacer la remettrait candidate sur un
    // jour dont il l'avait retiree, sans qu'il l'apprenne.
    const { data, error } = await supabase.from('provider_availability_exceptions')
      .delete()
      .eq('user_id', qui.userId).eq('provider_id', qui.profil.id)
      .eq('date', jour).eq('source', 'prestataire')
      .select('id')
    if (error) {
      console.error('[menages-public] retrait indisponibilite echec:', error.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    if (!data || !data.length) {
      // ⚠ « RIEN A SUPPRIMER » N'EST PAS « CE N'EST PAS A VOUS ». Zero ligne
      // touchee couvre deux cas tres differents, et le 409 les confondait : sur
      // cette PWA en 3G, un double tap sur « Annuler » annoncait a la
      // prestataire que son employeur avait pose une absence qu'elle venait
      // elle-meme de retirer. On regarde ce qui occupe reellement ce jour.
      const { data: reste, error: errLire } = await supabase
        .from('provider_availability_exceptions')
        .select('id, source')
        .eq('user_id', qui.userId).eq('provider_id', qui.profil.id)
        .eq('date', jour).maybeSingle()
      if (errLire) {
        console.error('[menages-public] lecture exception echec:', errLire.message)
        return res.status(503).json({ error: 'Service temporairement indisponible' })
      }
      // Plus rien sur ce jour : c'est le resultat qu'elle demandait. Succes
      // idempotent, comme le chemin de declaration.
      if (!reste) return res.status(200).json({ success: true, date: jour, retiree: true })
      return res.status(409).json({ error: 'Cette absence a été posée par votre employeur' })
    }
    return res.status(200).json({ success: true, date: jour, retiree: true })
  }

  // ⚠ JAMAIS D'UPSERT NU ICI. La cible de conflit est `(provider_id, date)` : un
  // upsert met a jour la ligne existante QUELLE QU'ELLE SOIT et bascule sa
  // `source` a 'prestataire'. Une absence posee par l'HOTE devenait donc la
  // sienne — et comme elle ne peut retirer que ce qui porte sa source, elle
  // pouvait ensuite l'EFFACER en deux gestes, sans qu'il l'apprenne. C'est
  // exactement la garde que ce chemin existe pour tenir.
  //
  // La sequence est atomique et n'ecrase rien :
  //   1. mettre a jour SA ligne si elle existe (`source = 'prestataire'`) ;
  //   2. sinon inserer — et si la contrainte d'unicite refuse, c'est qu'une ligne
  //      de l'HOTE occupe ce jour. On le DIT plutot que de la remplacer.
  const ligne = { user_id: qui.userId, provider_id: qui.profil.id, date: jour,
                  available: false, source: 'prestataire' }

  const { data: maj, error: errMaj } = await supabase.from('provider_availability_exceptions')
    .update({ available: false })
    .eq('user_id', qui.userId).eq('provider_id', qui.profil.id)
    .eq('date', jour).eq('source', 'prestataire')
    .select('id, date, available, source')
  if (errMaj) {
    console.error('[menages-public] declaration indisponibilite echec:', errMaj.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  // ⚠ Un double tap sur un telephone est le cas NORMAL, pas une erreur : la
  // ligne etait deja la, on rend un succes.
  if (maj && maj.length) return res.status(200).json({ success: true, exception: maj[0] })

  const { data, error } = await supabase.from('provider_availability_exceptions')
    .insert(ligne).select('id, date, available, source').maybeSingle()
  if (error) {
    // 23505 = violation d'unicite : une ligne existe sur ce jour, et elle n'est
    // pas la sienne (l'update ci-dessus n'a rien touche).
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Votre employeur a déjà noté quelque chose sur cette date. Prévenez-le directement.' })
    }
    console.error('[menages-public] declaration indisponibilite echec:', error.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  return res.status(200).json({ success: true, exception: data })
}

// Une date de calendrier, et rien d'autre. ⚠ Pas de `new Date()` sur une chaine
// libre : « 2026-13-45 » y devient une date valide dans certains moteurs, et le
// jour ecrit ne serait pas celui qu'elle a touche.
function jourValide (date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}` ? `${m[1]}-${m[2]}-${m[3]}` : null
}
