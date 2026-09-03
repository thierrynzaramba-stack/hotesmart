// ⚠️ DOC : comportement documenté dans docs/kb/menage.md — si tu modifies/ajoutes/supprimes une fonctionnalité ici, mets à jour ce(s) kb (MÊME COMMIT).
const { createClient } = require('@supabase/supabase-js')
const { markReady } = require('../lib/cron-property-status')
// Statut canonique unifie (audit E5) : evite les menages fantomes sur les blocages.
const { readStatus, STATUS } = require('../lib/bookings-snapshot')
const { ratioProprete, borneDepuis } = require('../lib/stats-avis')
const { avisDuPrestataire, MAX_IDS } = require('../lib/attribution-prestataire')
const { extraitVerifie } = require('../lib/extrait-verifie')

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

  if (req.method === 'POST') {
    const { action, event_ids, booking_id, property_id, departure_date } = req.body || {}

    // --- markRead : inchange ---
    if (action === 'markRead' && event_ids?.length) {
      await supabase.from('menage_events').update({ read: true })
        .in('id', event_ids).eq('token', token)
      return res.json({ success: true })
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
    // ⚠ PONT DE CONVERGENCE, ASSUME ET BORNE. Un token sans profil correspondant
    // (`profiles.pwa_token`) garde l'ancien comportement : filtrage par bien.
    // C'est la dette `profiles` <-> `public_tokens` du §6 : couper l'acces d'un
    // lien legacy en le rendant vide serait une panne silencieuse pour la
    // personne qui l'utilise. Regina, elle, est deja convergee.
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

    let menagesAssignes = null
    if (profilPresta && profilPresta.active !== false) {
      const { data: mn, error: errMen } = await supabase.from('menages')
        .select('booking_id, property_id, departure_date, status')
        .eq('user_id', userId)
        .eq('provider_id', profilPresta.id)
        .neq('status', 'cancelled')
        .gte('departure_date', dateFrom)
        .lte('departure_date', dateTo)
      // Meme raison : une liste vide par panne serait indiscernable d'« aucun
      // menage », et la prestataire conclurait qu'elle n'a rien a faire.
      if (errMen) {
        console.error('[menages-public] lecture des menages echec:', errMen.message)
        return res.status(503).json({ error: 'Service temporairement indisponible' })
      }
      menagesAssignes = mn || []
      const siens = new Set(menagesAssignes.map(m =>
        `${String(m.property_id)}|${String(m.booking_id)}|${m.departure_date}`))
      allBookings = allBookings.filter(b =>
        siens.has(`${b.propId}|${String(b.id)}|${b.departure}`))
    }

    const bookingIds = allBookings.map(b => String(b.id))
    let comments = []
    if (bookingIds.length) {
      const { data: cd } = await supabase.from('menage_comments')
        .select('booking_id, departure_date, comment, property_id')
        .eq('user_id', userId).in('booking_id', bookingIds)
      comments = cd || []
    }

    const { data: eventsData } = await supabase.from('menage_events').select('*')
      .eq('token', token).eq('read', false)
      .gte('created_at', new Date(Date.now() - visibilityDays * 86400000).toISOString())
      .order('created_at', { ascending: false }).limit(50)

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
      doneList = dd || []
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
      menages: menagesAssignes,
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
