// ⚠️ DOC : comportement documenté dans docs/kb/menage.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce(s) kb (MÊME COMMIT).
const { createClient } = require('@supabase/supabase-js')
const { markReady } = require('../lib/cron-property-status')
// Statut canonique unifie (audit E5) : evite les menages fantomes sur les blocages.
const { readStatus, STATUS } = require('../lib/bookings-snapshot')
const { ratioProprete, borneDepuis } = require('../lib/stats-avis')
const { avisDuPrestataire, filtresAttribution, MAX_IDS } = require('../lib/attribution-prestataire')
const { alertMenageRefuse } = require('../lib/alert-notify')
const { extraitVerifie } = require('../lib/extrait-verifie')
// Le moteur de garde (lot 3.3) : c'est LUI qui dit qui remplace, jamais un
// « rang 2 » lu en dur — un rang 2 en conge ou non attitre ce jour-la n'est pas
// la remplacante de ce jour.
const { chargerLiaisons, chargerDisponibilites, chargerRefus,
        deciderParGarde, echeanceOffre } = require('../lib/cleaning/assign')
const { notifierProposition } = require('../lib/cleaning/notifier-prestataire')
// ⚠ `cleJour` normalise une date de calendrier a midi UTC. A minuit, le moindre
// decalage de fuseau la fait basculer d'un jour — piege deja corrige deux fois
// dans ce depot. C'est la MEME fonction que celle du moteur : deux
// normalisations differentes pour la meme date finiraient par diverger.
// ⚠ `lireRrule` est l'INVERSE de `construireRrule` : elle rend les jours, la
// cadence et l'ancre d'une regle SANS que la chaine RRULE ne descende vers le
// client (regle du §2 de la spec). C'est la meme projection que l'ecran hote
// — et elle doit l'etre : les deux calendriers peignent le meme mois.
const { cleJour, lireRrule } = require('../lib/cleaning/availability')
// ⚠ LE MEME PLAFOND QUE `api/disponibilites.js`, et pour la meme raison : l'ecran
// regle jusqu'a un an devant. Une plage au-dela n'est pas un conge, c'est une
// saisie qui a derape — et surtout une ligne que l'ecran ne montrera jamais,
// donc impossible a retirer.
const HORIZON_CONGE_JOURS = 400

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ─── QUI PORTE CE LIEN — GARDE UNIQUE DE TOUT L'ENDPOINT ────────────────────
//
// ⚠ LA GARDE PAR PROFIL PRIME, ELLE NE COEXISTE PLUS AVEC CELLE PAR BIEN.
// Jusqu'ici, un jeton sans profil gardait l'ANCIEN comportement — filtrage par
// `public_tokens.property_ids` — sous le nom de « pont de convergence ». Le pont
// etait une porte : audit du 14 septembre 2026, le lien de Tiphaine (profil
// INACTIF, sans `pwa_token`, « identite historique SANS ACCES ») rendait 200
// avec 11 reservations d'Ofuro Futari, noms et prenoms des voyageurs compris.
// La ligne `public_tokens` d'avant la convergence lui survivait, et elle suffit
// a ouvrir le planning : le filtre par personne ne s'appliquait justement pas,
// faute de personne.
//
// La regle est desormais sans exception : PAS DE PROFIL ACTIF, PAS D'ACCES.
// Un jeton ne vaut plus par lui-meme — il ne fait que DESIGNER quelqu'un, et
// c'est cette personne qui porte le droit. Une ligne `public_tokens` orpheline
// n'ouvre donc plus rien, quelle que soit sa presence en base.
//
// ⚠ `access_mode = 'lien'` EST EXIGE, comme dans lib/cleaning/notifier-prestataire.js.
// Un profil de type `compte` n'a pas de `pwa_token` aujourd'hui, mais la garde
// ne doit pas dependre de cet etat de fait : un jeton pose par erreur sur un
// profil titulaire ouvrirait sinon la PWA a un compte entier.
//
// ⚠ UNE PANNE COUPE EN 503, ELLE NE SE FAIT PAS PASSER POUR UN LIEN INVALIDE.
// Le front supprime une action de sa file d'attente sur tout 4xx : rendre 401
// sur un timeout PostgREST detruirait un « menage fait » en attente de renvoi.
//
// Rend { statut } a rendre tel quel, ou { profil } utilisable.
async function profilActifDuJeton (userId, token) {
  const { data: profil, error } = await supabase.from('profiles')
    .select('id, first_name, active')
    .eq('account_user_id', userId).eq('pwa_token', token)
    .eq('access_mode', 'lien').maybeSingle()
  if (error) {
    console.error('[menages-public] lecture du profil echec:', error.message)
    return { statut: 503 }
  }
  if (!profil || profil.active === false) return { statut: 401 }
  return { profil }
}

// Le meme refus, ecrit une seule fois : un lien sans personne derriere lui est
// invalide, et il le dit comme n'importe quel jeton inconnu — on n'apprend pas
// a un porteur de lien que la ligne existe encore en base.
function refuserPorteur (res, statut) {
  return statut === 503
    ? res.status(503).json({ error: 'Service temporairement indisponible' })
    : res.status(401).json({ error: 'Token invalide' })
}

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

    // --- markRead ---
    // ⚠ GARDE DE PORTEUR, COMME LES AUTRES ECRITURES. Ce chemin n'en avait
    // aucune : il se contentait de `.eq('token', token)`, donc un lien orphelin
    // — ou desactive — pouvait encore faire taire son fil d'actualites. Le
    // cloisonnement tenait (on ne touche que les lignes de ce jeton), mais la
    // regle « pas de profil actif, pas d'ecriture » ne souffre pas d'exception :
    // c'est en laissant un seul chemin de cote qu'on rouvre une porte.
    if (action === 'markRead' && event_ids?.length) {
      const { data: pt, error: errTok } = await supabase
        .from('public_tokens').select('user_id').eq('token', token).maybeSingle()
      if (errTok) {
        console.error('[menages-public] lecture du token echec:', errTok.message)
        return res.status(503).json({ error: 'Service temporairement indisponible' })
      }
      if (!pt) return res.status(401).json({ error: 'Token invalide' })
      const porteur = await profilActifDuJeton(pt.user_id, token)
      if (porteur.statut) return refuserPorteur(res, porteur.statut)

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
    if (action === 'declarerConge' || action === 'retirerConge') {
      return await mesConges(req, res, token, { retirer: action === 'retirerConge' })
    }

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
        // Lien sans profil actif : invalide, comme partout ailleurs.
        if (droit.refus) return refuserPorteur(res, droit.refus)
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
        // Lien sans profil actif : invalide, comme partout ailleurs.
        if (droit.refus) return refuserPorteur(res, droit.refus)
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

    // ⚠ LA GARDE DE PORTEUR PASSE AVANT LES LECTURES LOURDES — constat de review.
    // Elle etait posee apres `properties` ET `bookings_snapshot` (la fenetre
    // entiere) : un jeton orphelin ou revoque — le cas meme qui motive tout ce
    // lot — payait donc le chemin de lecture complet avant son 401, sur un
    // endpoint sans session qu'un porteur de lien peut marteler. Rien ne change
    // dans la semantique, seulement dans ce qu'un refus coute.
    const porteur = await profilActifDuJeton(userId, token)
    if (porteur.statut) return refuserPorteur(res, porteur.statut)
    const profilPresta = porteur.profil

    // Biens du prestataire : lecture de la table `properties` (dual-provider,
    // ZERO appel Beds24). Cle universelle = provider_property_id, deja utilisee par
    // les tokens (property_ids), menage_done, property_status et bookings_snapshot.
    // `provider` est indispensable pour lire le statut des lignes bookings_snapshot
    // ecrites AVANT l'unification : elles portent le statut BRUT du provider et
    // aucun champ `provider`. Sans ce defaut, un blocage proprietaire Beds24
    // ('black') retomberait sur le fallback 'confirmed' -> menage fantome.
    const { data: propRows, error: errProps } = await supabase
      .from('properties')
      .select('provider_property_id, name, provider')
      .eq('user_id', userId)
      .not('provider_property_id', 'is', null)
    // ⚠ L'ERREUR ETAIT AVALEE, trois instructions avant la garde `errSnaps`.
    // Constat de review du 7 septembre. Une panne rendait `propRows` null, donc
    // `properties` vide, donc `propIds` vide, donc le bloc de lecture des
    // reservations entierement SAUTE — et la prestataire voyait un planning
    // vide, indiscernable de « rien a faire aujourd'hui ». C'est le symptome
    // exact de l'incident du jour, atteint par une autre porte restee ouverte.
    if (errProps) {
      console.error('[menages-public] lecture properties echec:', errProps.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }

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
      // ⚠ LE FILTRE DE DATES EST DANS LA REQUETE, PAS APRES. INCIDENT DU
      // 7 SEPTEMBRE 2026.
      // Cette lecture ne filtrait que par hote et par bien, et la fenetre etait
      // appliquee en JavaScript ensuite. PostgREST plafonne un rendu a 1000
      // lignes : au-dela, il en rend 1000 SANS ERREUR et sans le dire.
      // Mesure du jour : 1418 lignes correspondantes, 1000 rendues.
      //
      // Le backfill de l'historique du 5 septembre a fait passer la table de 214
      // a 1437 lignes. Depuis, les reservations les PLUS RECENTES tombaient hors
      // du rendu : leur menage arrivait bien, la reservation non, et l'ecran —
      // qui joint les deux — n'affichait rien. Une mission assignee et acceptee
      // etait invisible pour la prestataire.
      //
      // Aggravant : sans `order by`, les 1000 lignes rendues sont ARBITRAIRES.
      // Deux appels peuvent ne pas rendre le meme ensemble.
      //
      // Filtrer sur les dates ICI ramene le rendu a quelques dizaines de lignes :
      // la troncature ne peut plus se produire. C'est ce que font deja
      // api/menages.js et lib/moteur-coeur.js.
      const { data: snaps, error: errSnaps } = await supabase
        .from('bookings_snapshot')
        .select('booking_id, property_id, snapshot')
        .eq('user_id', userId)
        .in('property_id', propIds)
        .gte('snapshot->>departure', dateFrom)
        .lte('snapshot->>departure', dateTo)
      // ⚠ L'erreur etait AVALEE. Une panne rendait `snaps` indefini, donc zero
      // reservation, donc un planning vide — indiscernable de « rien a faire
      // aujourd'hui » pour la prestataire. Meme regle que partout ailleurs sur
      // ce chemin : on coupe plutot que de rendre une liste faussement vide.
      if (errSnaps) {
        console.error('[menages-public] lecture bookings_snapshot echec:', errSnaps.message)
        return res.status(503).json({ error: 'Service temporairement indisponible' })
      }
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
        // Redondant avec le filtre SQL ci-dessus, et garde exprès : il coute
        // rien et il protege si la requete venait a changer.
        .filter(b => b.departure && b.departure >= dateFrom && b.departure <= dateTo)
    }

    // ─── FILTRAGE PAR PRESTATAIRE (spec §11.5) ─────────────────────────────
    // ⚠ LE FILTRE PASSE DU BIEN A LA PERSONNE. Tant que la PWA filtrait par
    // `public_tokens.property_ids`, deux prestataires sur un meme bien voyaient
    // chacune TOUS les menages de l'autre — le cas qui motive tout ce chantier.
    //
    // ⚠ LE PONT DE CONVERGENCE EST FERME (14 septembre 2026). Il laissait un
    // jeton sans profil retomber sur l'ANCIEN filtrage — par bien — pour ne voir
    // « que ce qui n'est assigne a personne ». Deux choses l'ont condamne :
    //   - les RESERVATIONS, elles, n'etaient filtrees par rien d'autre : le lien
    //     orphelin de Tiphaine rendait 11 sejours d'Ofuro Futari avec les noms
    //     des voyageurs, alors que ce profil est inactif et sans acces ;
    //   - un repli « par bien » est precisement ce que le lot 2.2 a remplace.
    //     Le garder en secours, c'etait garder la faille qu'on venait de fermer.
    // Desormais : pas de profil actif, pas d'acces. La garde elle-meme est posee
    // PLUS HAUT, avant les lectures lourdes — voir `profilActifDuJeton`.
    let requete = supabase.from('menages')
      .select('booking_id, property_id, departure_date, status, provider_id, offered_to, offer_expires_at')
      .eq('user_id', userId)
      .neq('status', 'cancelled')
      .gte('departure_date', dateFrom)
      .lte('departure_date', dateTo)
    // ⚠ DEUX FAMILLES DE MENAGES POUR UNE PRESTATAIRE IDENTIFIEE :
    //   - ceux qu'elle PORTE (`provider_id`), y compris ceux qu'on est en train
    //     de proposer a quelqu'un d'autre — ils restent les siens tant que
    //     personne n'a accepte ;
    //   - ceux qu'on lui PROPOSE (`offered_to`), qu'elle ne porte pas encore.
    // Les confondre, c'etait soit lui retirer un menage dont elle reste
    // responsable, soit lui en attribuer un qu'elle n'a pas accepte.
    requete = requete.or(`provider_id.eq.${profilPresta.id},offered_to.eq.${profilPresta.id}`)
    const { data: mn, error: errMen } = await requete
    // ⚠ Une liste vide par panne serait indiscernable d'« aucun menage », et la
    // prestataire conclurait qu'elle n'a rien a faire aujourd'hui.
    if (errMen) {
      console.error('[menages-public] lecture des menages echec:', errMen.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    // ⚠ TOUJOURS UN TABLEAU depuis la fermeture du pont de convergence : il n'y a
    // plus de porteur non identifie, donc plus de `null` a distinguer d'« aucun
    // menage ». Le front garde sa garde `Array.isArray` — elle ne coute rien et
    // protege d'une reponse d'une version anterieure encore en cache.
    const menagesAssignes = mn || []
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
      menages: menagesAssignes.map(m => ({
        booking_id: m.booking_id, property_id: m.property_id,
        departure_date: m.departure_date, status: m.status,
        role: m.provider_id === profilPresta.id ? 'porteur' : 'propose',
        propose: !!m.offered_to,
        expire_le: m.offered_to ? m.offer_expires_at : null
      })),
      prenom: profilPresta.first_name
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
// n'appartenir a personne. Une panne coupe.
//
// ⚠ `profilActifDuJeton` D'ABORD, ET IL REFUSE : depuis la fermeture du pont de
// convergence, un jeton sans profil actif n'ecrit plus rien du tout. La version
// precedente le laissait marquer « fait » tout menage assigne a personne.
async function menageDeCePorteur (userId, token, { propertyId, bookingId, departureDate }) {
  const porteur = await profilActifDuJeton(userId, token)
  if (porteur.statut === 503) return { erreur: true }
  if (porteur.statut) return { refus: porteur.statut }
  const profil = porteur.profil

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

  // ⚠ CELLE QUI PORTE LE MENAGE PEUT TOUJOURS LE MARQUER FAIT, meme si une
  // proposition est en cours : il reste le sien tant que personne n'a accepte.
  if (menage.provider_id === profil.id) return { autorise: true }

  // ⚠ ON NE FAIT PAS UN MENAGE QU'ON N'A PAS ACCEPTE.
  // La garde testait `status === 'offered'`, en supposant que proposition
  // impliquait ce statut. Le modele parallele casse cette equivalence : une
  // proposition posee sur un menage `unassigned` laisse le statut intact. Un
  // menage sous proposition redevenait donc « a personne » — n'importe quelle
  // prestataire identifiee du compte pouvait le marquer fait, ou le DEFAIRE,
  // avec le seul triplet (bien, reservation, date) qu'elle lit dans sa PWA.
  // C'est desormais `offered_to` qui tranche, comme partout ailleurs.
  if (menage.offered_to) {
    return menage.offered_to === profil.id
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
  // ⚠ 401 ET NON PLUS 403 : le lien lui-meme est invalide, pas seulement
  // insuffisant pour ce geste. Le distinguer laissait entendre qu'un jeton sans
  // personne reste un jeton valable — c'est exactement ce que le pont de
  // convergence supposait.
  const porteur = await profilActifDuJeton(userId, token)
  if (porteur.statut) return refuserPorteur(res, porteur.statut)
  const profil = porteur.profil

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
      regles: dispos.regles, exceptions: dispos.exceptions, conges: dispos.conges
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

  // Le profil derriere ce token.
  // ⚠ 401, ET NON PLUS UN 200 « actif: false ». Rendre 200 disait au porteur
  // « ton lien marche, mais tu n'es personne » — et surtout, c'etait la meme
  // tolerance que le pont de convergence : elle laissait vivre une ligne
  // `public_tokens` orpheline. Un lien sans personne est un lien invalide.
  // ⚠ L'erreur de lecture N'ETAIT PAS LUE ICI : une panne PostgREST rendait
  // `profil` null et se lisait « droit retire » dans la PWA, qui masquait
  // l'onglet. `profilActifDuJeton` coupe en 503, et l'onglet reste visible en
  // etat de panne — c'est le contrat que `initAvis` attend deja.
  const porteur = await profilActifDuJeton(userId, token)
  if (porteur.statut) return refuserPorteur(res, porteur.statut)
  const profil = porteur.profil

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
  // ⚠ DEUX RESOLUTIONS, DEUX USAGES — ET C'EST LE FOND DU CORRECTIF DU 14 SEPT.
  //   `filtresAttribution` -> des FILTRES, pour COMPTER. Exact, sans borne :
  //       aucun identifiant ne transite, donc rien ne plafonne le chiffre.
  //   `avisDuPrestataire`   -> des IDENTIFIANTS, pour LISTER. Borne a MAX_IDS
  //       par la longueur d'URL, et c'est legitime : une liste s'affiche par
  //       pages.
  // Les confondre est ce qui rendait le ratio de Regina faux : il heritait de la
  // borne de la liste, annoncait 150 sur 577, se declarait « tronque », et son
  // en-tete restait masquee. Une liste plafonnee n'est pas un compteur plafonne.
  const filtres = await filtresAttribution(supabase, { userId, prestataireId: profil.id })
  if (filtres.erreur) {
    console.error('[menages-public] attribution echec')
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  const ratio = await ratioProprete(supabase, { userId, periode, prestataireId: profil.id,
                                                voies: filtres.voies })

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
      : await ratioProprete(supabase, { userId, periode: periodeVue, prestataireId: profil.id,
                                        voies: filtres.voies })
    // ⚠ UNE PANNE N'EST PAS « AUCUN AVIS » : elle coupe en 503 (garde posee plus
    // haut, a la resolution unique). Sauter silencieusement laissait partir un
    // 200 avec une liste vide, indiscernable de « elle n'a aucun avis » — alors
    // que la base en contient 98 pour Regina.
    // La LISTE, elle, a besoin des identifiants — et donc de la borne.
    const att = await avisDuPrestataire(supabase, { userId, prestataireId: profil.id,
                                                   contexte: filtres.contexte })
    if (att.erreur) {
      console.error('[menages-public] attribution (liste) echec')
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    if (att.ids.length) {
      // ⚠ `att.tronque` SEUL. La seconde branche — `att.ids.length > MAX_IDS` —
      // ne pouvait jamais etre vraie : `avisDuPrestataire` rend deja
      // `toutes.slice(0, MAX_IDS)`. Une condition morte donne l'illusion d'une
      // double garde et survit aux relectures ; celle-ci masquait que le
      // drapeau n'a qu'une source.
      listeTronquee = att.tronque === true
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

  // ⚠ 401, ET NON PLUS 403 : sans personne derriere, le lien est invalide, pas
  // seulement sans droit. Meme regle que partout depuis la fermeture du pont de
  // convergence — voir `profilActifDuJeton`.
  const porteur = await profilActifDuJeton(pt.user_id, token)
  if (porteur.statut) return { erreur: porteur.statut }
  const profil = porteur.profil

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
  // ⚠ LE MEME CONTRAT QUE LE CHEMIN NOMINAL, `conges` COMPRIS. Depuis que la
  // reponse porte des conges, une branche qui les omet fait lever le front des
  // qu'il itere `data.conges` : la prestataire sans droit verrait un ecran casse
  // au lieu du message « gérées par votre employeur ». Une reponse partielle est
  // un piege pose pour le lot d'apres.
  if (qui.erreur === 403) {
    return res.status(200).json({ autorise: false, exceptions: [], conges: [], regles: [] })
  }
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

  // Les regles recurrentes.
  // ⚠ LE LIBELLE NE SUFFIT PAS, et l'avoir cru a rendu l'ecran inutilisable.
  // Tant que la PWA n'affichait qu'une liste de phrases, « le week-end, une
  // semaine sur deux » disait tout. Depuis « Mes jours de travail » (15 sept.
  // 2026), elle PEINT un calendrier : sans `jours`, `cadence` et `ancre`, aucune
  // journee n'est reconnue comme travaillee, le mois sort entierement rouge et
  // plus aucune absence d'un jour n'est declarable — l'ecran precedent, lui,
  // envoyait toujours. Le defaut ne se voyait pas sur un profil SANS regle,
  // c'est-a-dire sur le seul qu'on regardait.
  const { data: regles, error: errR } = await supabase.from('provider_availability_rules')
    .select('id, label, rrule').eq('user_id', qui.userId).eq('provider_id', qui.profil.id)
    .eq('active', true).order('created_at', { ascending: true }).limit(50)
  if (errR) {
    console.error('[menages-public] lecture regles echec:', errR.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }

  // ⚠ LES CONGES SONT BORNES SUR LEUR FIN, pas sur leur debut : un conge commence
  // le mois dernier et qui court encore doit apparaitre, sinon elle croit l'avoir
  // perdu et le repose par-dessus.
  const { data: conges, error: errC } = await supabase.from('conges_plages')
    .select('id, debut, fin, motif, source')
    .eq('user_id', qui.userId).eq('provider_id', qui.profil.id)
    .gte('fin', aujourdhui)
    .order('debut', { ascending: true }).limit(200)
  if (errC) {
    console.error('[menages-public] lecture conges echec:', errC.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }

  return res.status(200).json({
    autorise: true,
    modifiable: qui.niveau === 'write',
    prenom: qui.profil.first_name,
    exceptions: exceptions || [],
    conges: conges || [],
    // ⚠ LES REGLES SORTENT EN LECTURE SEULE, ET C'EST UNE DECISION PRODUIT
    // (15 septembre 2026) : ses jours de travail sont l'ORGANISATION DU TRAVAIL,
    // reglee par l'hote. Elle declare ses ABSENCES — un jour, ou une plage —
    // elle ne redessine pas son planning. Le front n'affiche donc aucun controle
    // sur ces lignes ; le serveur, lui, n'expose simplement aucune action.
    //
    // ⚠ LECTURE SEULE N'EST PAS « SANS FORME ». On rend de quoi DESSINER la
    // regle, jamais de quoi la reecrire : la chaine RRULE ne sort pas, et aucune
    // action ne la prend en entree. Une regle illisible sort avec `jours: null`
    // — l'ecran le dit au lieu de peindre un mois entier en vert.
    regles: (regles || []).map(r => {
      const forme = lireRrule(r.rrule)
      return {
        id: r.id,
        label: r.label,
        jours: forme ? forme.jours : null,
        cadence: forme ? forme.cadence : null,
        ancre: forme ? forme.ancre : null
      }
    })
  })
}

// Elle pose ou retire un CONGE — une PLAGE (15 septembre 2026).
//
// ⚠ MEME GARDE QUE LES ABSENCES D'UN JOUR, pour la meme raison : elle ne retire
// que ce qu'elle a declare (`source = 'prestataire'`). Un conge pose par l'HOTE
// n'est pas le sien a defaire — le lui laisser effacer la remettrait candidate
// sur des jours dont il l'avait retiree, sans qu'il l'apprenne.
async function mesConges (req, res, token, { retirer }) {
  const qui = await celleQuiDeclare(token, { ecriture: true })
  if (qui.erreur === 401) return res.status(401).json({ error: 'Token invalide' })
  if (qui.erreur === 403) {
    return res.status(403).json({ error: 'Vos absences sont gérées par votre employeur' })
  }
  if (qui.erreur) return res.status(503).json({ error: 'Service temporairement indisponible' })

  if (retirer) {
    const { id } = req.body || {}
    // ⚠ LA FORME SE VALIDE ICI, SINON LA PANNE MENT. Un identifiant qui n'est pas
    // un UUID fait lever PostgREST en 22P02 : la branche `error` rend alors
    // « Service temporairement indisponible » — on annonce une panne serveur pour
    // une saisie malformee, et la prestataire reessaie indefiniment. L'homologue
    // cote hote validait deja ; ce chemin ne le faisait pas.
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) {
      return res.status(400).json({ error: 'Congé inconnu' })
    }
    const { data, error } = await supabase.from('conges_plages')
      .delete()
      .eq('id', String(id))
      .eq('user_id', qui.userId).eq('provider_id', qui.profil.id)
      .eq('source', 'prestataire')
      .select('id')
    if (error) {
      console.error('[menages-public] retrait conge echec:', error.message)
      return res.status(503).json({ error: 'Service temporairement indisponible' })
    }
    if (!data || !data.length) {
      // ⚠ « RIEN A SUPPRIMER » N'EST PAS « CE N'EST PAS A VOUS » — meme nuance
      // que sur les absences d'un jour, et pour la meme raison : sur un telephone
      // en 3G, un double tap ne doit pas accuser l'employeur.
      const { data: reste, error: errLire } = await supabase.from('conges_plages')
        .select('id').eq('id', String(id))
        .eq('user_id', qui.userId).eq('provider_id', qui.profil.id).maybeSingle()
      if (errLire) {
        console.error('[menages-public] lecture conge echec:', errLire.message)
        return res.status(503).json({ error: 'Service temporairement indisponible' })
      }
      if (!reste) return res.status(200).json({ success: true, retire: true })
      return res.status(409).json({ error: 'Ce congé a été posé par votre employeur' })
    }
    return res.status(200).json({ success: true, retire: true })
  }

  const { debut, fin, motif } = req.body || {}
  const d = cleJour(debut), f = cleJour(fin)
  if (!d || !f) return res.status(400).json({ error: 'Dates invalides' })
  if (d > f) return res.status(400).json({ error: 'La date de fin précède la date de début' })
  // ⚠ PAS DE CONGE ENTIEREMENT PASSE. Un conge qui se termine hier ne change
  // rien a ce qui a eu lieu, et reecrirait l'historique sur lequel s'appuie
  // l'attribution des remarques de proprete. Un conge EN COURS, lui, passe.
  if (f < todayInParis()) return res.status(400).json({ error: 'Ces dates sont déjà passées' })
  const jours = Math.round((Date.parse(f + 'T12:00:00Z') - Date.parse(d + 'T12:00:00Z')) / 86400000) + 1
  // ⚠ LE MEME PLAFOND QUE L'HOTE, IMPORTE ET NON RECOPIE. Deux writers de la
  // meme table avec deux limites differentes, c'est l'ecart qui finit par se
  // creuser : le 400 etait code en dur ici pendant que l'autre chemin lisait
  // `HORIZON_JOURS`.
  if (jours > HORIZON_CONGE_JOURS) return res.status(400).json({ error: 'Ce congé est trop long' })
  // ⚠ ET LA DISTANCE, PAS SEULEMENT LA DUREE — garde que le chemin hote a recue
  // en review et que celui-ci n'avait pas. Un conge de cinq jours en 2099 est
  // accepte, stocke, et hors de portee de l'ecran : une ligne qu'on ne peut ni
  // voir ni retirer.
  const limite = new Date(Date.now() + HORIZON_CONGE_JOURS * 86400000).toISOString().slice(0, 10)
  if (d > limite) return res.status(400).json({ error: 'Ce congé est trop loin dans le futur' })

  // ⚠ IDEMPOTENT, COMME LE CHEMIN D'UN JOUR — et pour la meme raison, qui est
  // physique : cette PWA tourne sur un telephone en 3G, ou un tap qui ne rend
  // pas la main se rejoue. `mesIndisponibilites` s'appuie sur la contrainte
  // `(provider_id, date)` ; `conges_plages` n'en a pas, et n'en veut pas — deux
  // conges qui se chevauchent sont legitimes (prolonger en reposant par-dessus).
  // On regarde donc s'il existe DEJA une plage identique DECLAREE PAR ELLE : deux
  // taps produiraient deux lignes jumelles, elle en verrait deux dans sa liste,
  // et croirait sa premiere suppression sans effet.
  // ⚠ JAMAIS `maybeSingle()` SUR UNE TABLE SANS CONTRAINTE D'UNICITE.
  // C'etait le defaut de la premiere version de cette garde, et il etait PIRE que
  // ce qu'elle corrigeait. Le controle est un TOCTOU : deux taps concurrents —
  // exactement le scenario 3G qu'on invoque ici — passent tous deux « pas de
  // jumelle » et inserent deux lignes. Des lors, `maybeSingle()` levait en
  // PGRST116 (« multiple rows returned ») a CHAQUE declaration ulterieure de la
  // meme plage, donc 503 « Service temporairement indisponible » — DEFINITIVEMENT.
  // Et le front ne purge sa file que sur 4xx : elle aurait reessaye sans fin,
  // sans jamais pouvoir reposer ce conge.
  // On prend donc la PREMIERE, s'il y en a. Le doublon eventuel reste inerte —
  // deux plages identiques verrouillent les memes jours — et se retire comme les
  // autres depuis sa liste.
  const { data: jumelles, error: errJ } = await supabase.from('conges_plages')
    .select('id, debut, fin, motif, source')
    .eq('user_id', qui.userId).eq('provider_id', qui.profil.id)
    .eq('debut', d).eq('fin', f).eq('source', 'prestataire')
    .order('created_at', { ascending: true }).limit(1)
  if (errJ) {
    console.error('[menages-public] lecture conge jumelle echec:', errJ.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  const jumelle = (jumelles || [])[0]
  if (jumelle) return res.status(200).json({ success: true, conge: jumelle, deja: true })

  const { data, error } = await supabase.from('conges_plages')
    .insert({ user_id: qui.userId, provider_id: qui.profil.id, debut: d, fin: f,
              motif: motif ? String(motif).slice(0, 200) : null, source: 'prestataire' })
    .select('id, debut, fin, motif, source')
    .maybeSingle()
  if (error) {
    console.error('[menages-public] insert conge echec:', error.message)
    return res.status(503).json({ error: 'Service temporairement indisponible' })
  }
  return res.status(200).json({ success: true, conge: data })
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
