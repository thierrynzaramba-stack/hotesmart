// api/reservation-directe.js
// DOC : docs/kb/reservation-directe.md (modif = MEME COMMIT)
//
// Saisie manuelle d'une reservation directe, depuis le calendrier.
// Spec : docs/specs/spec-reservation-manuelle.md §5.
//
// POST   { propertyId, arrival, departure, prixParNuit, currency, customer,
//          occupancy, reference }  -> cree la reservation chez Channex
// PUT    { propertyId, bookingId, arrival?, departure?, prixParNuit?,
//          occupancy? }            -> la modifie (champ absent = valeur du cœur)
// DELETE { propertyId, bookingId }                       -> l'annule
//
// ⚠ POST et PUT passent les MEMES gardes : verrou anti-surreservation et plafond
// de voyageurs. Deplacer un sejour, c'est vendre d'autres nuits — un chemin de
// modification moins garde suffirait a contourner la creation.
//
// ⚠ AUCUN MONTANT TOTAL N'EST ACCEPTE DU CLIENT : seul `prixParNuit` est lu, et
// le total en est recalcule. Un total fourni serait une porte ouverte a une
// reservation a 1 € pour sept nuits.
//
// ⚠ CE MODULE N'ECRIT JAMAIS `bookings_snapshot`. La reservation entre dans le
// cœur par le feed/webhook, comme n'importe quelle reservation OTA — c'est la
// regle « provider -> cœur -> apps », et c'est ce qui garantit que menage,
// messages et codes fonctionnent sans une ligne de code specifique.
//
// ⚠ CHANNEX SEULEMENT. L'ecriture CRS n'existe pas cote Beds24 : les hotes
// Beds24 gardent leur interface. Le refus est explicite, jamais silencieux.

const { requirePermission } = require('../lib/require-permission')
const { createClient } = require('@supabase/supabase-js')
const { creerReservationDirecte, modifierReservationDirecte, verifierDisponibilite, nuits } = require('../lib/reservation-directe')
const { getProvider } = require('../lib/channels')
const { isActiveStatus, readStatus } = require('../lib/bookings-snapshot-status')
const { colonneRawAbsente } = require('../lib/bookings-snapshot')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Le bien, avec ce qu'il faut pour construire un payload CRS complet.
async function bienDuCompte (accountUserId, propertyId) {
  const { data, error } = await supabase
    .from('properties')
    .select('name, provider, provider_property_id, provider_room_type_id, provider_rate_plan_id, currency, base_price, capacity')
    .eq('user_id', accountUserId)
    .eq('provider_property_id', String(propertyId))
    .maybeSingle()
  if (error) throw new Error(`lecture properties : ${error.message}`)
  return data
}

// ─── Occupation validee ──────────────────────────────────────────────────────
// ⚠ PARTAGEE PAR LA CREATION ET LA MODIFICATION, ET C'EST LE POINT.
// Ces gardes ont une histoire : `{adults: 10, children: -7}` donnait 3 <= 4,
// garde franchie et `adults: 10` transmis tel quel ; `{children: {}}` donnait
// NaN, et toute comparaison avec NaN etant fausse, la garde etait simplement
// sautee ; `infants` echappait au compte. Les recopier dans un second chemin
// d'ecriture, c'est se donner deux endroits ou les reperdre — la modification
// deplace exactement les memes voyageurs dans exactement le meme logement.
//
// ⚠ CHAQUE COMPTEUR EST VALIDE SEPAREMENT, et c'est la somme VALIDEE qui part.
// `capacity` = nombre de PERSONNES (a ne pas confondre avec `inventory_units`,
// qui compte les logements louables).
function occupationValidee (occupancy, capacite) {
  const entierPositif = (v, defaut) => {
    const n = v === undefined || v === null ? defaut : Number(v)
    return Number.isInteger(n) && n >= 0 ? n : null
  }
  const adultes = entierPositif(occupancy?.adults, 1)
  const enfants = entierPositif(occupancy?.children, 0)
  const bebes   = entierPositif(occupancy?.infants, 0)
  if (adultes === null || enfants === null || bebes === null) {
    return { erreur: { status: 400, corps: { error: 'Nombre de voyageurs invalide.' } } }
  }
  if (adultes < 1) {
    return { erreur: { status: 400, corps: { error: 'Il faut au moins un adulte.' } } }
  }
  const personnes = adultes + enfants + bebes
  if (capacite > 0 && personnes > capacite) {
    // `error` porte la PHRASE : api-client construit son Error a partir de ce
    // champ, et l'hote lisait « capacite_depassee » a l'ecran.
    return { erreur: { status: 400, corps: {
      error: `Ce bien accueille ${capacite} personne${capacite > 1 ? 's' : ''} au maximum — ${personnes} demandées.`,
      code: 'capacite_depassee'
    } } }
  }
  return { adultes, enfants, bebes, personnes }
}

// ─── La reservation, lue dans le CŒUR, et seulement si elle est a nous ───────
// ⚠ ON NE TOUCHE QUE CE QU'ON A CREE. Une reservation OTA doit etre modifiee ou
// annulee chez l'OTA ; la toucher par le CRS produirait une divergence entre ce
// que voit le voyageur et ce que voit l'hote. La verification porte sur le CŒUR,
// jamais sur ce que le client affirme — un `offline: true` envoye par le front
// ne prouve rien.
async function reservationOfflineDuCoeur (accountUserId, providerPropertyId, bookingId) {
  // `raw` : le payload provider integral. Il porte ce que le snapshot resume ne
  // garde pas — le CLIENT COMPLET (mail, telephone, pays, langue) et `meta`.
  const lire = (avecRaw) => supabase
    .from('bookings_snapshot')
    .select(avecRaw ? 'snapshot, raw' : 'snapshot')
    .eq('user_id', accountUserId)
    .eq('property_id', String(providerPropertyId))
    .eq('booking_id', String(bookingId))
    .maybeSingle()

  let { data: ligne, error } = await lire(true)
  // ⚠ Meme repli qu'a la lecture du calendrier : la colonne peut manquer
  // (migration, ou cache de schema PostgREST pas encore recharge). Sans lui, la
  // modification devenait impossible sur tout un parc. Avec, elle reste possible
  // — le client se reconstruit alors depuis le resume, ce qui est degrade mais
  // pas faux, et la garde « vente du moteur » retombe sur le statut seul.
  if (error && colonneRawAbsente(error)) {
    console.error('[resa-directe] colonne raw absente, lecture degradee — migration a appliquer')
    ;({ data: ligne, error } = await lire(false))
  }
  if (error) {
    console.error('[resa-directe] lecture snapshot echec', error.message)
    return { erreur: { status: 500, corps: { error: 'Lecture impossible' } } }
  }
  if (!ligne) return { erreur: { status: 404, corps: { error: 'Réservation introuvable' } } }

  const source = String(ligne.snapshot?.source || '').toLowerCase()
  if (source !== 'offline') {
    // ⚠ LA PHRASE VA DANS `error`, LE CODE DANS `code`. `shared/api-client.js`
    // construit son exception avec `data.error` — pas avec `data.message` : un
    // code technique dans `error` affichait « reservation_ota » a l'hote, et
    // l'explication restait dans un champ que personne ne lit. Regle deja
    // gravee dans api/calendar.js et appliquee par `occupationValidee`.
    return { erreur: { status: 403, corps: {
      error: `Cette réservation vient de ${ligne.snapshot?.source || 'une plateforme'} : elle doit être gérée chez elle.`,
      code: 'reservation_ota'
    } } }
  }
  return { snapshot: ligne.snapshot, raw: ligne.raw || {} }
}

// ─── Forme d'un refus rendu au front ─────────────────────────────────────────
// ⚠ `resultat` (lib/reservation-directe.js) porte sa phrase dans `message` et
// n'a AUCUNE cle `error`. Or `shared/api-client.js` construit son exception avec
// `data.error` seul : un refus « Plus d'unite disponible sur : 2026-09-20 »
// arrivait a l'hote en « Erreur serveur », et le detail des nuits en conflit —
// la seule information utile — restait dans un champ que personne ne lit.
// On expose donc la phrase dans `error`, en gardant `raison`, `conflits` et
// `unites` pour qui veut le detail machine.
function reponseRefus (resultat) {
  return {
    ...resultat,
    error: resultat.message || 'La demande a ete refusee.',
    code: resultat.raison || null
  }
}

// ─── Repartition du prix nuit par nuit ───────────────────────────────────────
// ⚠ LA SOMME DES `days` DOIT VALOIR EXACTEMENT `amount`. Channex valide la
// coherence entre `departure_date`, les `days` et le total, et rejette l'ecart
// en 422. Avec 33.335 sur 3 nuits, la somme des jours valait 100.02 et le total
// 100.01 : l'arrondi au centime se fait AVANT la repartition.
function repartirParNuit (parNuit, listeNuits) {
  const cents = Math.round(parNuit * 100)
  const days = {}
  listeNuits.forEach(n => { days[n] = (cents / 100).toFixed(2) })
  const total = ((cents * listeNuits.length) / 100).toFixed(2)
  return { days, total }
}

module.exports = async (req, res) => {
  // ⚠ `write` : creer une reservation engage le logement aupres d'un voyageur et
  // ferme la vente sur tous les canaux. La verification est refaite ICI, cote
  // serveur : le calendrier teste deja `peutEcrire('reservations')`, mais une
  // garde d'interface n'est pas une garde.
  const { propertyId, bookingId } = req.body || {}
  if (!propertyId) return res.status(400).json({ error: 'propertyId manquant' })

  // ⚠ `bien` + `bienRequis` : SANS EUX, LE PERIMETRE N'EST PAS VERIFIE.
  // `dansPerimetre` (lib/permissions.js) rend `true` des que `bien` est nul : un
  // membre delegue en `property_scope: 'selected'`, limite au bien A, pourrait
  // creer et annuler des reservations sur le bien B du meme compte. Le controle
  // de compte seul ne suffit pas — c'est la classe de fuite fermee au chantier
  // profils et droits, et tous les endpoints d'ecriture passent ces options.
  const garde = await requirePermission(req, res, {
    domaine: 'reservations', niveau: 'write', compteDelegue: true,
    bien: String(propertyId), bienRequis: true
  })
  if (!garde.ok) return

  let bien
  try { bien = await bienDuCompte(garde.accountUserId, propertyId) }
  catch (e) {
    console.error('[resa-directe] lecture bien echec', e.message)
    return res.status(500).json({ error: 'Lecture impossible' })
  }
  // Bien absent du compte : on ne distingue pas « inexistant » de « pas a vous ».
  if (!bien) return res.status(404).json({ error: 'Bien introuvable' })

  if (bien.provider !== 'channex' && bien.provider !== 'channel') {
    return res.status(400).json({
      error: 'provider_sans_ecriture',
      message: `La saisie directe n'est pas disponible sur ce bien (${bien.provider}).`
    })
  }

  // ─── Creation ──────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    // ⚠ `amount` N'EST PAS LU DU CLIENT. Un POST forge avec `amount: 1` aurait
    // cree chez Channex une reservation a 1 € pour sept nuits ; avec une valeur
    // non numerique, `montant()` jette et l'endpoint rendait un 500 sans corps.
    // Le total est TOUJOURS recalcule a partir du prix par nuit valide ici.
    const { arrival, departure, currency, customer, occupancy, reference, prixParNuit } = req.body || {}
    const listeNuits = nuits(arrival, departure)
    if (!listeNuits.length) return res.status(400).json({ error: 'Dates invalides' })
    if (!bien.provider_room_type_id || !bien.provider_rate_plan_id) {
      return res.status(400).json({
        error: 'bien_incomplet',
        message: "Ce bien n'a pas de type de chambre ou de tarif configuré chez le canal."
      })
    }

    // Prix par nuit : celui fourni, sinon le prix de base du bien. Le total en
    // decoule — on ne fait jamais confiance a un total envoye par le client.
    const parNuit = Number(prixParNuit ?? bien.base_price)
    if (!Number.isFinite(parNuit) || parNuit <= 0) {
      return res.status(400).json({ error: 'Prix par nuit invalide' })
    }

    // ⚠ PLAFOND DE VOYAGEURS REVERIFIE ICI. Le formulaire l'annonce et le bloque,
    // mais une garde d'interface n'est pas une garde : rien n'empeche un appel
    // direct. Detail des cas fermes : `occupationValidee` ci-dessus.
    const occ = occupationValidee(occupancy, Number(bien.capacity) || 0)
    if (occ.erreur) return res.status(occ.erreur.status).json(occ.erreur.corps)
    const { adultes, enfants, bebes } = occ

    const { days, total } = repartirParNuit(parNuit, listeNuits)

    // `creerReservationDirecte` et `payloadCRS` LEVENT volontairement (lecture
    // en echec, champ obligatoire manquant) : sans ce try, l'hote recevait un
    // 500 sans corps JSON, et le front — qui parse avant de tester `ok` — lui
    // affichait une SyntaxError au lieu d'un message.
    let resultat
    try {
      resultat = await creerReservationDirecte(supabase, {
      userId: garde.accountUserId,
      propertyId: bien.provider_property_id,
      resa: {
        roomTypeId: bien.provider_room_type_id,
        ratePlanId: bien.provider_rate_plan_id,
        arrival, departure, days,
        amount: total,
        currency: currency || bien.currency || 'EUR',
        customer: customer || {},
        occupancy: { adults: adultes, children: enfants, infants: bebes },
        // `meta` = sous-origine. `ota_name` porte deja l'origine (« Offline »).
        meta: { source: 'hotesmart-manual', ...(reference ? { reference_interne: String(reference) } : {}) },
        // Code unique et lisible : c'est notre seule cle de deduplication cote
        // Channex si un appel devait etre rejoue.
        otaReservationCode: `HS-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
        }
      })
    } catch (e) {
      console.error('[resa-directe] creation exception', e.message)
      return res.status(500).json({ error: 'exception', message: "La réservation n'a pas pu être créée. Rien n'a été enregistré." })
    }

    if (!resultat.ok) {
      // 409 pour un conflit de disponibilite : c'est un refus METIER, pas une
      // erreur technique, et l'interface doit pouvoir les distinguer.
      const conflit = resultat.raison === 'nuits_completes' || resultat.raison === 'verrou_occupe'
      return res.status(conflit ? 409 : 400).json(reponseRefus(resultat))
    }
    return res.status(200).json({
      ok: true, bookingId: resultat.bookingId, nuits: resultat.nuits,
      message: 'Réservation envoyée. Elle apparaîtra dans HôteSmart au prochain rafraîchissement.'
    })
  }

  // ─── Annulation ────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!bookingId) return res.status(400).json({ error: 'bookingId manquant' })

    // ⚠ ON N'ANNULE QUE CE QU'ON A CREE — verifie dans le cœur, pas sur parole
    // du client. Detail : `reservationOfflineDuCoeur` ci-dessus.
    const lu = await reservationOfflineDuCoeur(garde.accountUserId, bien.provider_property_id, bookingId)
    if (lu.erreur) return res.status(lu.erreur.status).json(lu.erreur.corps)

    // Meme exigence qu'a la creation : sans room type ni rate plan, `payloadCRS`
    // jette et l'endpoint rendait un 500 sans corps.
    if (!bien.provider_room_type_id || !bien.provider_rate_plan_id) {
      return res.status(400).json({
        error: 'bien_incomplet',
        message: "Ce bien n'a pas de type de chambre ou de tarif configuré chez le canal."
      })
    }

    const s = lu.snapshot
    const listeNuits = nuits(s.arrival, s.departure)
    if (!listeNuits.length) return res.status(400).json({ error: 'Réservation sans dates exploitables' })

    // ⚠ LA SOMME DES `days` DOIT VALOIR EXACTEMENT `amount`.
    // Un simple `amount / nuits` arrondi par nuit donne 33,33 x 3 = 99,99 pour
    // 100,00 : Channex valide deja la coherence entre `departure_date` et les
    // `days`, et rejetterait l'ecart en 422. Le reliquat va sur la derniere nuit.
    const total = Math.round(Number(s.amount || 0) * 100)
    const base = Math.floor(total / listeNuits.length)
    const days = {}
    listeNuits.forEach((n, i) => {
      const cents = i === listeNuits.length - 1 ? total - base * (listeNuits.length - 1) : base
      days[n] = (cents / 100).toFixed(2)
    })

    // Payload COMPLET, days inclus : Channex revalide tout a chaque ecriture et
    // rejette une annulation partielle (mesure du protocole).
    let envoi
    try {
      envoi = await getProvider('channex').cancelBooking(bookingId, bien.provider_property_id, {
      roomTypeId: bien.provider_room_type_id,
      ratePlanId: bien.provider_rate_plan_id,
      arrival: s.arrival, departure: s.departure, days,
      amount: s.amount || 0, currency: s.currency || bien.currency || 'EUR',
      customer: { name: s.firstName || '', surname: s.lastName || '' },
      occupancy: { adults: s.numAdult ?? 1, children: s.numChild ?? 0 },
        otaReservationCode: s.otaReservationCode || String(bookingId)
      })
    } catch (e) {
      console.error('[resa-directe] annulation exception', e.message)
      return res.status(500).json({ error: 'exception', message: "L'annulation n'a pas pu être transmise." })
    }
    if (!envoi.ok) {
      console.error('[resa-directe] annulation echec', envoi.status, JSON.stringify(envoi.erreurs || {}).slice(0, 200))
      return res.status(400).json({ error: 'echec_crs', message: "L'annulation n'a pas pu être transmise." })
    }
    return res.status(200).json({
      ok: true,
      message: 'Annulation envoyée. Les dates seront rouvertes au prochain rafraîchissement.'
    })
  }

  // ─── Modification ──────────────────────────────────────────────────────────
  // Dates, prix vendu et nombre de voyageurs, depuis la fiche du calendrier.
  //
  // ⚠ LES MEMES GARDES QU'A LA CREATION, SANS EXCEPTION. Deplacer un sejour sur
  // d'autres nuits, c'est vendre ces nuits-la : le verrou anti-surreservation et
  // le plafond de voyageurs valent ici mot pour mot. Un chemin de modification
  // moins garde que la creation suffirait a contourner celle-ci — creer sur des
  // dates libres, puis deplacer sur des dates prises.
  //
  // ⚠ CHAMPS NON FOURNIS = CEUX DU CŒUR. Channex revalide TOUT le payload a
  // chaque ecriture et rejette une modification partielle : on repart donc du
  // snapshot complet et on n'y remplace que ce que l'hote a change.
  if (req.method === 'PUT') {
    if (!bookingId) return res.status(400).json({ error: 'bookingId manquant' })

    const lu = await reservationOfflineDuCoeur(garde.accountUserId, bien.provider_property_id, bookingId)
    if (lu.erreur) return res.status(lu.erreur.status).json(lu.erreur.corps)
    const s = lu.snapshot

    // ⚠ SEUL UN SEJOUR `confirmed` SE MODIFIE — SINON IL RESSUSCITERAIT.
    // L'annulation est un PUT porteur de `status: 'cancelled'` ; la modification
    // est le MEME PUT sans ce champ. Envoyer le payload de modification sur un
    // sejour annule le remet donc `confirmed` chez Channex, referme les nuits que
    // l'hote venait de liberer, et l'endpoint repondrait 200 « Modification
    // envoyée ». Le calendrier masque deja les annulees et les `demapped`, mais
    // une garde d'interface n'est pas une garde.
    // `isActiveStatus` plutot qu'un test d'annulation : il ferme du meme coup
    // `demapped` et tout statut non confirme a venir.
    if (!isActiveStatus(s, 'channex')) {
      return res.status(409).json({
        error: `Cette réservation n'est pas active (${readStatus(s, 'channex')}) : elle ne peut plus être modifiée.`,
        code: 'reservation_non_modifiable'
      })
    }

    // ⚠ UNE VENTE DU MOTEUR PUBLIC N'EST PAS UNE SAISIE DE L'HOTE, bien que les
    // deux portent `ota_name: "Offline"`. Le voyageur a PAYE par Stripe : en
    // deplacer les dates ou le prix depuis le planning ne declencherait ni
    // remboursement ni complement, et ne toucherait pas la ligne de vente. Tant
    // que ce raccordement n'existe pas, on refuse — en disant ou aller.
    const sousOrigine = String(lu.raw?.meta?.source || '')
    if (sousOrigine === 'hotesmart-engine') {
      return res.status(409).json({
        error: 'Cette réservation vient du moteur de réservation et a été payée en ligne : '
             + 'sa modification doit passer par un remboursement ou un complément, pas par le planning.',
        code: 'reservation_moteur'
      })
    }

    if (!bien.provider_room_type_id || !bien.provider_rate_plan_id) {
      return res.status(400).json({
        error: 'bien_incomplet',
        message: "Ce bien n'a pas de type de chambre ou de tarif configuré chez le canal."
      })
    }

    const { arrival, departure, occupancy, prixParNuit } = req.body || {}
    const arrivee = arrival || s.arrival
    const depart  = departure || s.departure
    const listeNuits = nuits(arrivee, depart)
    if (!listeNuits.length) return res.status(400).json({ error: 'Dates invalides' })

    // ⚠ `amount` N'EST PAS LU DU CLIENT, ici non plus : l'accepter rouvrirait,
    // sur le chemin de modification, la reservation a 1 € pour sept nuits que la
    // creation ferme. Deux chemins, et la distinction n'est pas cosmetique :
    //
    //  - PRIX FOURNI -> total = prix x nuits, reparti uniformement.
    //  - PRIX ABSENT et NOMBRE DE NUITS INCHANGE -> on garde le montant EXACT du
    //    cœur, reliquat sur la derniere nuit (comme le chemin d'annulation).
    //    ⚠ Recalculer depuis `amount / nuits` arrondi au centime DERIVE : 100,00
    //    sur 3 nuits donnait 33,33 x 3 = 99,99, et sur 7 nuits 14,29 x 7 =
    //    100,03. Un hote qui ne corrige que le nombre de voyageurs changeait
    //    ainsi, sans le savoir, le prix de vente du sejour.
    //  - PRIX ABSENT et DUREE CHANGEE -> le total du cœur ne veut plus rien dire
    //    pour cette duree : on repart du prix par nuit, arrondi une seule fois.
    const listeActuelle = nuits(s.arrival, s.departure)
    const memeDuree = listeActuelle.length === listeNuits.length
    const totalActuelCents = Math.round(Number(s.amount || 0) * 100)

    let days, total
    if (prixParNuit === undefined || prixParNuit === null) {
      if (memeDuree && totalActuelCents > 0) {
        // ⚠ LA SOMME DES `days` DOIT VALOIR EXACTEMENT `amount` : Channex rejette
        // l'ecart en 422. Le reliquat va sur la derniere nuit.
        const base = Math.floor(totalActuelCents / listeNuits.length)
        days = {}
        listeNuits.forEach((n, i) => {
          const cents = i === listeNuits.length - 1
            ? totalActuelCents - base * (listeNuits.length - 1)
            : base
          days[n] = (cents / 100).toFixed(2)
        })
        total = (totalActuelCents / 100).toFixed(2)
      } else {
        const parNuit = totalActuelCents > 0 && listeActuelle.length > 0
          ? (totalActuelCents / 100) / listeActuelle.length
          : Number(bien.base_price)
        if (!Number.isFinite(parNuit) || parNuit <= 0) {
          return res.status(400).json({ error: 'Prix par nuit invalide' })
        }
        ;({ days, total } = repartirParNuit(parNuit, listeNuits))
      }
    } else {
      const parNuit = Number(prixParNuit)
      if (!Number.isFinite(parNuit) || parNuit <= 0) {
        return res.status(400).json({ error: 'Prix par nuit invalide' })
      }
      ;({ days, total } = repartirParNuit(parNuit, listeNuits))
    }

    // Plafond de voyageurs REVERIFIE : voir `occupationValidee`. A defaut de
    // compteurs fournis, ceux du cœur — `numAdult`/`numChild`, jamais `infants`
    // que le snapshot ne porte pas.
    const occ = occupationValidee(
      occupancy || { adults: s.numAdult ?? 1, children: s.numChild ?? 0 },
      Number(bien.capacity) || 0
    )
    if (occ.erreur) return res.status(occ.erreur.status).json(occ.erreur.corps)

    // ⚠ LE CLIENT EST REPRIS DE `raw`, PAS DU SNAPSHOT RESUME.
    // `payloadCRS` reecrit l'objet `customer` en entier a chaque ecriture, et
    // remplit d'un `null` tout champ absent. Le snapshot ne garde que le prenom
    // et le nom : le reconstruire a partir de lui EFFACAIT chez Channex le mail
    // et le telephone du voyageur — a chaque correction de dates. Meme raison
    // pour `arrival_hour`, que la fiche affiche et que le resume porte bien.
    const clientRaw = lu.raw?.customer || {}
    const customer = {
      name:     clientRaw.name    || s.firstName || '',
      surname:  clientRaw.surname || s.lastName  || '',
      mail:     clientRaw.mail    || null,
      phone:    clientRaw.phone   || null,
      country:  clientRaw.country || null,
      language: clientRaw.language || 'fr'
    }

    // `modifierReservationDirecte` et `payloadCRS` LEVENT volontairement : sans
    // ce try, l'hote recevrait un 500 sans corps JSON, donc une SyntaxError a
    // l'ecran — le front parse avant de tester `ok`.
    let resultat
    try {
      resultat = await modifierReservationDirecte(supabase, {
        userId: garde.accountUserId,
        propertyId: bien.provider_property_id,
        bookingId,
        resa: {
          roomTypeId: bien.provider_room_type_id,
          ratePlanId: bien.provider_rate_plan_id,
          arrival: arrivee, departure: depart, days,
          amount: total,
          currency: s.currency || bien.currency || 'EUR',
          customer,
          // L'heure d'arrivee survit a la modification : le resume la porte, la
          // fiche l'affiche, et `payloadCRS` l'efface si on ne la redonne pas.
          arrivalHour: s.arrivalHour || null,
          occupancy: { adults: occ.adultes, children: occ.enfants, infants: occ.bebes },
          // ⚠ `meta` EST CONSERVE, jamais reecrit : il porte la sous-origine du
          // sejour (quel moteur, quel lien de vente). L'ecraser par
          // « hotesmart-manual » ferait passer pour une saisie de l'hote une
          // reservation qui n'en est pas une, et perdrait `link_label`.
          meta: (lu.raw?.meta && Object.keys(lu.raw.meta).length)
            ? lu.raw.meta
            : { source: 'hotesmart-manual' },
          // ⚠ LE CODE OTA NE CHANGE PAS : c'est la cle de deduplication du
          // sejour chez Channex. En regenerer un ferait entrer la modification
          // dans le cœur comme une reservation NEUVE, a cote de l'ancienne.
          otaReservationCode: s.otaReservationCode || String(bookingId)
        }
      })
    } catch (e) {
      console.error('[resa-directe] modification exception', e.message)
      return res.status(500).json({ error: 'exception', message: "La réservation n'a pas pu être modifiée. Rien n'a été changé." })
    }

    if (!resultat.ok) {
      // 409 pour un conflit de disponibilite : refus METIER, pas erreur technique.
      const conflit = resultat.raison === 'nuits_completes' || resultat.raison === 'verrou_occupe'
      return res.status(conflit ? 409 : 400).json(reponseRefus(resultat))
    }
    return res.status(200).json({
      ok: true, bookingId: resultat.bookingId, nuits: resultat.nuits,
      message: 'Modification envoyée. Elle apparaîtra dans HôteSmart au prochain rafraîchissement.'
    })
  }

  return res.status(405).json({ error: 'Méthode non autorisée' })
}
