// lib/cleaning/sync-menages-entite.js
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// WRITER UNIQUE de la table `menages`. Conception : spec §11.1, puis §12 (la
// garde du jour) depuis le lot 3.3.
//
// Le menage n'existait nulle part : la PWA le DERIVAIT a la volee de
// `bookings_snapshot.departure`. Il est desormais une ligne, et cette fonction
// est la seule a l'ecrire — c'est la regle du coeur de donnees
// (docs/kb/coeur-de-donnees.md) : un writer, une verite, toutes les apps lisent
// la meme chose.
//
// ⚠ NE PAS CONFONDRE AVEC `lib/cleaning/sync-menages.js`, qui ecrit
// `menage_events` : celle-la est un journal de NOTIFICATIONS (une ligne par
// prestataire notifiee ET par type d'evenement). Les deux coexistent et ne
// portent pas la meme chose.
//
// ⚠ CE QUE CE WRITER N'ECRIT PAS : le fait qu'un menage soit FAIT. `menage_done`
// reste la seule verite la-dessus (writer = la PWA, file hors ligne qui en
// depend, 118 lignes en production).
//
// Reconciliateur, pas reactif : il balaye les reservations de la fenetre a
// chaque cycle. Idempotent — deux passages consecutifs sans changement
// n'ecrivent rien.
//
// ⚠ QUI FAIT LE MENAGE SE DECIDE PAR JOURNEE (lot 3.3, §12). Le writer ne
// demande plus « qui est le rang 1 de ce bien » mais « qui est de garde CE
// JOUR-LA » — attitree (`weekdays`) et disponible (RRULE + exceptions). Un bien
// dont la titulaire ne prend pas les mardis n'a plus de titulaire le mardi, et
// c'est un resultat, pas une panne.
//
// ⚠ LES MENAGES DEJA DECIDES NE SONT JAMAIS RECALCULES (§12.5). Le nouveau
// moteur se reconnait a `assignment_mode = 'garde'` : les lignes anterieures
// portent `'priorite'` et aucun chemin de ce fichier ne les reprend. Recalculer
// un menage accepte reviendrait a defaire un engagement pris avec quelqu'un.

const { supabase } = require('../cron-shared')
const { isActiveStatus } = require('../bookings-snapshot')
const { chargerLiaisons, chargerDisponibilites, chargerRefus, deciderParGarde,
        horodatages, echeanceOffre, SANS_OFFRE, JOURS_PROPOSITION } = require('./assign')
const { notifierProposition } = require('./notifier-prestataire')
const { reportIncident } = require('../founder-notify')

// ⚠ SEUL UN SEJOUR ACTIF GENERE UN MENAGE — et le statut se lit avec
// `isActiveStatus`, JAMAIS par comparaison de texte a 'confirmed'.
//
// Une ligne ecrite AVANT l'unification du 31 aout porte le statut BRUT du
// provider (`new`, `black`...) et aucun champ `provider` : la comparer a
// 'confirmed' faisait passer une reservation vivante pour disparue, et le
// writer ANNULAIT son menage — pendant que le planning de l'hote, qui lit le
// statut canonique, continuait de l'afficher. Les snapshots Beds24 ne sont
// reecrits que pour les arrivees dans [J-1, J+90] : ces lignes existent encore.
//
// ⚠ Le `provider` DU BIEN est obligatoire en 2e argument : sans lui,
// `canonicalStatus('black', undefined)` ne trouve aucune table de
// correspondance et retombe sur 'confirmed' — le blocage proprietaire
// redeviendrait un menage fantome. C'est le meme commentaire que dans les deux
// lecteurs (api/menages.js, api/menages-public.js), et pour la meme raison.

// Fenetre de reconciliation, en jours autour d'aujourd'hui. En arriere pour
// rattraper un menage recent qu'un cycle aurait manque ; en avant pour que la
// prestataire voie venir. Au-dela, on ne balaye pas l'historique a chaque
// cycle : il ne change plus.
const JOURS_ARRIERE = 30
const JOURS_AVANT   = 180

// Plafond de securite, GLOBAL a la plateforme — pas par compte. Il n'y a ni
// curseur ni offset : le reliquat ne revient PAS de lui-meme au cycle suivant,
// il attend que la fenetre glisse. C'est acceptable parce qu'au-dela du plafond
// on cesse d'annuler (voir plus bas) : le pire cas est un menage cree en retard,
// jamais un menage supprime a tort. A remplacer par une pagination le jour ou un
// compte s'en approche.
const LOT_MAX = 500
// Les deux autres lectures ont leur propre plafond : elles portent sur d'autres
// volumes (un menage par depart, un bien par logement) et se tronquer en silence
// serait aussi grave.
const LOT_MENAGES = 2000
const LOT_BIENS = 1000
// Les propositions dues d'un cycle.
//
// ⚠ PLAFOND GLOBAL A LA PLATEFORME, PAS PAR COMPTE — comme `LOT_MAX`, et avec la
// meme dette : il n'y a ni curseur ni offset, et la requete ramene AUSSI les
// menages deja regles (une porteuse, aucune candidate a solliciter), qui
// consomment le budget sans rien produire. Trie par depart croissant, ce sont
// les departs les plus PROCHES qui passent — le bon ordre si le plafond mord,
// mais les plus lointains de la fenetre attendraient un cycle. A remplacer par
// une pagination le jour ou un compte s'en approche ; a deux comptes et sept
// jours de fenetre, on en est loin. Une troncature se voit dans les logs.
const LOT_PROPOSITIONS = 200
// ⚠ PLAFOND D'ENVOIS PAR CYCLE (REVIEW.md regle 2). La fenetre de proposition
// borne deja la source, mais une bascule de masse — un hote qui passe vingt
// biens en `requires_ack` d'un coup — ne doit pas pouvoir vider la cle Brevo
// d'un compte en un cycle. Le reliquat part au cycle suivant : les propositions
// restent posees en base, seule la notification attend cinq minutes.
const MAX_NOTIFS_PAR_CYCLE = 30
// ⚠ PLAFOND D'ECRITURES PAR CYCLE. La pose se fait ligne par ligne — sa condition
// d'atomicite (`.is('offered_to', null)`) l'impose — dans une fonction plafonnee
// a 60 s ou le dispatch, poste le plus lourd, passe juste apres. Le reliquat part
// au cycle suivant : cinq minutes de retard sur une proposition valable 48 h.
const MAX_POSES_PAR_CYCLE = 50

function jour (decalage, maintenant = Date.now()) {
  const d = new Date(maintenant + decalage * 24 * 3600 * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const j = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${j}`
}

// ⚠ Cle composite OBLIGATOIRE : ni `booking_id` ni `provider_property_id` n'ont
// d'unicite globale (REVIEW.md regle 1).
function cle (m) {
  return `${m.user_id}|${String(m.property_id)}|${String(m.booking_id)}|${m.departure_date}`
}

async function journaliser (lignes) {
  if (!lignes.length) return
  const { error } = await supabase.from('menage_assignment_log').insert(lignes)
  // Le journal est une trace, pas une garde : son echec ne doit pas empecher
  // l'assignation elle-meme. Mais il se voit dans les logs.
  if (error) console.error('[sync-menages-entite] journal echec:', error.message)
}

// Le bien tel que la garde le demande : ses liaisons, et le contexte de
// disponibilite de tout le compte.
//
// ⚠ Les maps de disponibilite sont indexees `user_id|provider_id` (REVIEW.md
// regle 1) : `garde.js` les lit avec `bien.userId`, jamais avec le seul
// `provider_id`. Une prestataire homonyme d'un autre compte ne peut donc pas
// mettre celle-ci en conge.
function bienDeGarde (userId, propertyId, liaisonsParBien, dispos) {
  return {
    userId, propertyId: String(propertyId),
    liaisons: liaisonsParBien.get(`${userId}|${String(propertyId)}`) || [],
    regles: dispos.regles, exceptions: dispos.exceptions
  }
}

// Les colonnes d'assignation d'un choix, pour les trois chemins qui les
// ecrivent (creation, resurrection, rattrapage).
//
// ⚠ UN SEUL ENDROIT QUI TRADUIT UN CHOIX EN COLONNES. Les trois chemins les
// composaient chacun de leur cote, avec la meme garde d'echeance recopiee : la
// resurrection en avait oublie une version, et un menage se retrouvait
// `cancelled` pour toujours parce que l'update violait `menages_offre_datee`.
function colonnesAssignation (choix, departureDate, maintenant) {
  const echeance = choix.offeredTo ? echeanceOffre(departureDate, maintenant) : null
  // ⚠ Une proposition sans delai de reponse n'est pas une proposition : plutot
  // qu'une offre morte-nee, on ecrit l'etat sans elle et l'hote tranchera.
  const offre = !!(choix.offeredTo && echeance)
  const statut = offre ? choix.status
    : (choix.providerId ? 'accepted' : (choix.status === 'offered' ? 'unassigned' : choix.status))
  const effectif = { ...choix, offeredTo: offre ? choix.offeredTo : null, status: statut }
  return {
    provider_id: choix.providerId,
    offered_to: offre ? choix.offeredTo : null,
    offer_expires_at: offre ? echeance : null,
    status: statut,
    assigned_by: choix.assignedBy,
    assignment_reason: offre || !choix.offeredTo ? choix.raison
      : 'Trop tard pour proposer : le menage reste en l\'etat.',
    assignment_mode: 'garde',
    ...horodatages(effectif, new Date(maintenant))
  }
}

// L'evenement du journal qui correspond a ce qui vient d'etre ecrit.
// ⚠ LA PROPOSITION L'EMPORTE SUR L'ASSIGNATION dans la trace : un menage porte
// d'office ET propose est, du point de vue de l'escalade, une proposition en
// cours. Tracer `assigned` masquerait le seul evenement auquel quelqu'un doit
// repondre.
function evenementDe (ligne) {
  if (ligne.offered_to) return 'offered'
  if (ligne.provider_id) return 'assigned'
  return 'created'
}

async function synchroniserMenages (results = null, opts = {}) {
  const maintenant = opts.maintenant || Date.now()
  const bilan = { lus: 0, crees: 0, annules: 0, ressuscites: 0, assignes_apres_coup: 0,
                  non_assignes: 0, alertes: 0, erreurs: 0, tronque: false }

  const debut = jour(-JOURS_ARRIERE, maintenant)
  const fin   = jour(JOURS_AVANT, maintenant)

  // ⚠ Le filtre de date porte sur le JSON du snapshot : `departure` est une date
  // nue « YYYY-MM-DD », donc la comparaison textuelle est exacte et ordonnee.
  const { data: snaps, error } = await supabase.from('bookings_snapshot')
    .select('user_id, property_id, booking_id, snapshot')
    .gte('snapshot->>departure', debut)
    .lte('snapshot->>departure', fin)
    // ⚠ ORDRE EXPLICITE. Sans lui, PostgREST rend un sous-ensemble different a
    // chaque cycle quand la limite mord : les menages annules a tort n'etaient
    // meme pas les memes d'un passage a l'autre.
    .order('snapshot->>departure', { ascending: true })
    .limit(LOT_MAX)
  if (error) {
    console.error('[sync-menages-entite] lecture snapshots echec:', error.message)
    results?.errors?.push({ context: 'sync_menages_entite', error: error.message })
    return { ...bilan, interrompu: 'db' }
  }

  const lignes = (snaps || []).filter(s => s.snapshot?.departure)
  bilan.lus = lignes.length
  // ⚠ LECTURE TRONQUEE = ON N'ANNULE RIEN.
  // `LOT_MAX` est un plafond GLOBAL, pas par compte. Une plateforme qui depasse
  // ce nombre de departs dans la fenetre voyait `vivants` construit sur un
  // sous-ensemble, et TOUT menage absent de ce sous-ensemble etait annule —
  // alors que sa reservation est vivante, simplement pas lue. Reproduit : 501
  // reservations vivantes, un menage annule par cycle, et jamais ressuscite
  // parce que la boucle sautait les lignes deja connues.
  // Creer reste sur : un menage manquant sera cree, au pire au cycle suivant.
  const tronque = (snaps || []).length >= LOT_MAX
  if (tronque) {
    console.warn(`[sync-menages-entite] lecture TRONQUEE a ${LOT_MAX} : aucune annulation ce cycle`)
    bilan.tronque = true
  }
  if (!lignes.length) return bilan

  // Les menages deja en base sur la meme fenetre.
  const userIds = [...new Set(lignes.map(l => l.user_id))]
  // ⚠ PLAFONNE, comme la lecture des snapshots. PostgREST tronque a 1000 lignes
  // par defaut, SANS erreur : une troncature ici ferait recreer des menages qui
  // existent (l'upsert `ignoreDuplicates` l'absorbe) mais surtout annuler ceux
  // qu'on n'a pas lus — d'ou la meme garde `tronque` que plus haut.
  const { data: existants, error: errEx } = await supabase.from('menages')
    .select('id, user_id, property_id, booking_id, departure_date, status, provider_id, assigned_by, offered_to, offer_expires_at, assignment_reason')
    .in('user_id', userIds)
    .gte('departure_date', debut)
    .lte('departure_date', fin)
    .order('departure_date', { ascending: true })
    .limit(LOT_MENAGES)
  if (errEx) {
    console.error('[sync-menages-entite] lecture menages echec:', errEx.message)
    results?.errors?.push({ context: 'sync_menages_entite', error: errEx.message })
    return { ...bilan, interrompu: 'db' }
  }
  if ((existants || []).length >= LOT_MENAGES) {
    console.warn(`[sync-menages-entite] lecture des menages TRONQUEE a ${LOT_MENAGES} : aucune annulation ce cycle`)
    bilan.tronque = true
  }
  const dejaLa = new Map((existants || []).map(m => [cle(m), m]))

  // Les liaisons de tous les biens du lot, et les disponibilites du lot, en une
  // passe chacune.
  //
  // ⚠ UNE PANNE DE LECTURE DES DISPONIBILITES COUPE LE CYCLE. Retomber sur des
  // maps vides ferait paraitre tout le monde disponible — « aucune regle =
  // disponible » — et les menages partiraient a des gens en conge, sans que rien
  // ne le signale. Une panne coupe, elle n'ouvre pas.
  let liaisonsParBien, dispos
  try {
    liaisonsParBien = await chargerLiaisons(supabase, lignes.map(l => ({
      userId: l.user_id, propertyId: l.property_id
    })))
    dispos = await chargerDisponibilites(supabase, userIds, { du: debut, au: fin })
  } catch (e) {
    console.error('[sync-menages-entite]', e.message)
    results?.errors?.push({ context: 'sync_menages_entite', error: e.message })
    return { ...bilan, interrompu: 'db' }
  }

  const aCreer = []
  const aRessusciter = []
  const aReassigner = []
  const journal = []
  const alertes = []

  // Le provider de chaque bien, indispensable pour lire le statut canonique
  // d'une ligne anterieure a l'unification. Cle composite : `provider_property_id`
  // n'a aucune unicite globale.
  const providerParBien = new Map()
  {
    // ⚠ Une troncature ICI est la pire des trois : `providerParBien` incomplet
    // fait passer un bien pour inconnu. Depuis le correctif, un bien inconnu est
    // SAUTE — donc on cree moins, jamais a tort. C'etait l'inverse avant : le
    // provider manquant faisait retomber 'black' sur 'confirmed'.
    const { data: biens, error: errBiens } = await supabase.from('properties')
      .select('user_id, provider_property_id, provider')
      .in('user_id', userIds)
      .not('provider_property_id', 'is', null)
      .limit(LOT_BIENS)
    // ⚠ Une panne ici COUPE le cycle : sans le provider, `isActiveStatus`
    // retombe sur 'confirmed' pour un blocage proprietaire — le menage fantome
    // que tout ce garde-fou existe pour empecher.
    if (errBiens) {
      console.error('[sync-menages-entite] lecture des biens echec:', errBiens.message)
      results?.errors?.push({ context: 'sync_menages_entite', error: errBiens.message })
      return { ...bilan, interrompu: 'db' }
    }
    for (const b of (biens || [])) {
      providerParBien.set(`${b.user_id}|${String(b.provider_property_id)}`, b.provider || null)
    }
  }
  // Ce qui EXISTE encore cote reservations : sert a reperer les menages devenus
  // sans objet (resa annulee, ou date de depart deplacee — la date fait partie
  // de l'identite, donc un deplacement fait naitre un autre menage).
  const vivants = new Set()

  for (const l of lignes) {
    const depart = l.snapshot.departure
    const k = `${l.user_id}|${String(l.property_id)}|${String(l.booking_id)}|${depart}`

    // ⚠ BIEN INCONNU = ON PASSE. `canonicalStatus('black', undefined)` ne trouve
    // aucune table de correspondance et retombe sur 'confirmed' : sans ce garde,
    // un blocage proprietaire redevenait un menage des que le bien n'avait plus
    // de ligne `properties` — cas atteignable, les snapshots n'etant purges par
    // rien quand un hote retire un bien. Les deux LECTEURS ne rencontrent jamais
    // ce cas : ils bornent par `.in('property_id', …)`. Le writer, lui, lit tout.
    const cleBien = `${l.user_id}|${String(l.property_id)}`
    if (!providerParBien.has(cleBien)) continue
    if (!isActiveStatus(l.snapshot, providerParBien.get(cleBien))) continue
    vivants.add(k)

    const existant = dejaLa.get(k)
    if (existant) {
      // ⚠ RESSUSCITER un menage annule a tort. `dejaLa` porte AUSSI les
      // `cancelled` : sans ce chemin, un menage annule par erreur — une lecture
      // tronquee, un statut mal lu — ne revenait JAMAIS, et disparaissait de la
      // PWA de la prestataire pour de bon.
      if (existant.status === 'cancelled') aRessusciter.push(existant)
      continue                                    // sinon : rien a faire, idempotent
    }

    // ⚠ LA DATE DE DEPART EST LE JOUR DE GARDE. Un depart deplace du samedi au
    // mardi fait naitre un AUTRE menage (la date est dans l'identite), donc
    // recalcule par la garde du mardi : la titulaire du week-end n'herite pas
    // d'un menage un jour ou elle ne prend pas.
    const bien = bienDeGarde(l.user_id, l.property_id, liaisonsParBien, dispos)
    const choix = deciderParGarde(bien, depart, { maintenant })

    aCreer.push({
      user_id: l.user_id,
      property_id: String(l.property_id),
      booking_id: String(l.booking_id),
      departure_date: depart,
      ...colonnesAssignation(choix, depart, maintenant)
    })

    if (!choix.providerId) bilan.non_assignes++
    // ⚠ ON N'ALERTE QUE SUR UN MENAGE QUE PERSONNE NE PEUT PRENDRE (§12.6).
    //   - `aucuneLiaison` : le bien n'est pas gere par l'app menage. Ce n'est pas
    //     une panne, et alerter a chaque depart noierait les vraies alertes sous
    //     du bruit permanent (decision du product owner, 3 septembre 2026) ;
    //   - proposition en cours ou differee : quelqu'un est identifie, rien n'est
    //     decouvert ;
    //   - TROU DE GARDE : le bien a des prestataires, et personne ce jour-la.
    //     Un menage existe et personne ne peut le faire : c'est le seul cas.
    //   - SANS JOURS ATTITRES REGLES : des personnes a confirmer sont liees, mais
    //     aucune n'a de jours regles, donc aucune n'est sollicitee (restriction du
    //     4 septembre). Personne ne porte ce menage : le silence porte sur le SMS,
    //     pas sur le fait qu'un logement n'a personne.
    if (choix.trouDeGarde || choix.sansJoursAttitres) {
      alertes.push({ userId: l.user_id, propertyId: String(l.property_id), depart,
                     motif: choix.sansJoursAttitres ? 'jours' : 'garde' })
    }
  }

  // ⚠ LES MENAGES NON ASSIGNES SONT REEVALUES A CHAQUE CYCLE.
  // Le writer ne reconciliait que l'EXISTENCE : un menage cree avant que l'hote
  // ne lie sa femme de menage restait orphelin pour toujours, sans alerte —
  // `aucuneLiaison` etait vrai a la creation, donc rien n'avait ete signale.
  // C'est le cas de tout nouvel hote qui branche son PMS avant de configurer.
  //
  // ⚠ ON NE TOUCHE QU'AUX MENAGES SANS PERSONNE ET SANS VERROU : jamais un
  // `assigned_by='manual'` (verrou du §3), jamais une offre en cours ou une
  // assignation acceptee — les reassigner reviendrait a defaire une decision.
  for (const m of (existants || [])) {
    // ⚠ `orphaned` = quelqu'un a REFUSE, ou toutes les candidates du jour ont ete
    // sollicitees sans suite. Le reassigner reviendrait a le rendre a la personne
    // qui vient de dire non, qui refuserait encore : une boucle dont personne ne
    // sortirait. Ce statut appelle une decision humaine — l'hote a ete alerte.
    // ⚠ Une PROPOSITION en cours n'est pas un menage sans personne : la
    // reassigner effacerait une sollicitation a laquelle quelqu'un s'apprete
    // peut-etre a repondre.
    if (m.provider_id || m.offered_to || m.assigned_by === 'manual') continue
    if (m.status === 'cancelled' || m.status === 'orphaned') continue
    if (!vivants.has(cle(m))) continue
    const bien = bienDeGarde(m.user_id, m.property_id, liaisonsParBien, dispos)
    const choix = deciderParGarde(bien, m.departure_date, { maintenant })
    // ⚠ `providerId` SEUL NE SUFFIT PAS. Un bien dont aucune candidate n'est
    // d'office rend `providerId: null` et `offeredTo: <la responsable du jour>` :
    // tester le seul porteur faisait sauter TOUS ces cas, et les menages d'un
    // hote qui ne lie que des personnes « a confirmer » n'etaient plus jamais
    // proposes a personne.
    if (!choix.providerId && !choix.offeredTo) {
      // ⚠ UN MENAGE DEJA EN BASE MERITE LA MEME ALERTE QU'UN MENAGE NEUF.
      // L'alerte n'etait poussee que dans la boucle de CREATION : un menage cree
      // avant que le probleme n'apparaisse — un depart lointain devenu proche, un
      // conge pose depuis, une restriction de jours introduite apres — restait
      // sans personne et sans que rien ne le signale, jusqu'au jour du depart.
      // La spec et le guide promettent le contraire a l'hote.
      if (choix.trouDeGarde || choix.sansJoursAttitres) {
        alertes.push({ userId: m.user_id, propertyId: String(m.property_id),
                       depart: m.departure_date,
                       motif: choix.sansJoursAttitres ? 'jours' : 'garde' })
      }
      continue
    }
    aReassigner.push({ menage: m, choix })
  }

  if (aCreer.length) {
    // `ignoreDuplicates` : deux cycles concurrents ne doivent pas se marcher
    // dessus, et la contrainte d'identite est la garde finale.
    const { data: inseres, error: errIns } = await supabase.from('menages')
      .upsert(aCreer, { onConflict: 'user_id,property_id,booking_id,departure_date', ignoreDuplicates: true })
      .select('id, user_id, provider_id, offered_to, status')
    if (errIns) {
      console.error('[sync-menages-entite] insert echec:', errIns.message)
      results?.errors?.push({ context: 'sync_menages_entite', error: errIns.message })
      bilan.erreurs++
    } else {
      bilan.crees = (inseres || []).length
      for (const m of (inseres || [])) {
        journal.push({
          user_id: m.user_id, menage_id: m.id,
          event: evenementDe(m),
          to_provider_id: m.offered_to || m.provider_id || null,
          actor: 'cron',
          reason: (m.provider_id || m.offered_to) ? null : 'Aucun prestataire assigne a la creation.'
        })
      }
    }
  }

  // Rattrapage des menages annules a tort : leur reservation est bien la.
  // ⚠ UNE RESURRECTION REND UNE LIGNE COHERENTE, PAS UN STATUT REPEINT.
  // Ecrire `status:'unassigned'` seul laissait `provider_id` et un `accepted_at`
  // perime : la PWA remontrait le menage a la prestataire pendant que son statut
  // disait « personne », l'ecran hote affichait une pastille sur un statut qui la
  // contredit, et la boucle de rattrapage — qui saute toute ligne a
  // `provider_id` renseigne — ne reparait jamais rien. On recalcule l'assignation
  // comme a la creation, avec la garde DU JOUR de ce menage.
  for (const m of aRessusciter) {
    // ⚠ UN VERROU MANUEL SURVIT A L'ANNULATION. Recalculer l'assignation d'un
    // menage verrouille — refuse par une prestataire, ou laisse sans personne
    // par l'hote — reviendrait a defaire sa decision par la bande : il suffisait
    // que la date de depart bouge puis revienne. On le ressuscite tel qu'il
    // etait : sans personne, et toujours verrouille.
    const verrouille = m.assigned_by === 'manual'
    let colonnes
    if (verrouille) {
      colonnes = { provider_id: null, ...SANS_OFFRE, status: 'orphaned',
                   assigned_by: 'manual', assignment_mode: 'garde',
                   assignment_reason: m.assignment_reason || 'Decision humaine, conservee.',
                   accepted_at: null }
    } else {
      const bien = bienDeGarde(m.user_id, m.property_id, liaisonsParBien, dispos)
      colonnes = colonnesAssignation(
        deciderParGarde(bien, m.departure_date, { maintenant }), m.departure_date, maintenant)
    }
    const { error: errRes } = await supabase.from('menages')
      .update({ ...colonnes, updated_at: new Date(maintenant).toISOString() })
      .eq('id', m.id)
    if (errRes) { console.error('[sync-menages-entite] resurrection echec:', errRes.message); bilan.erreurs++; continue }
    bilan.ressuscites++
    journal.push({ user_id: m.user_id, menage_id: m.id, event: 'created', actor: 'cron',
                   to_provider_id: colonnes.offered_to || colonnes.provider_id || null,
                   reason: 'Menage reactive : la reservation existe toujours.' })
  }

  // Assignation rattrapee des menages restes sans personne.
  //
  // ⚠ GROUPEE PAR DESTINATION **ET PAR ECHEANCE**. Un UPDATE par ligne, en
  // sequentiel, dans une fonction plafonnee a 60 s : le cas nominal — un hote qui
  // lie sa femme de menage apres avoir branche son PMS — en trouve des centaines
  // d'un coup, et c'est le dispatch, le poste le plus lourd du cycle, qui vient
  // juste apres.
  // ⚠ L'ECHEANCE FAIT PARTIE DE LA CLE. Elle etait calculee sur le PREMIER
  // menage du groupe et appliquee a tous : deux departs de dates differentes
  // partageaient la meme, et une proposition pouvait expirer APRES le depart
  // qu'elle concerne. Comme l'echeance vaut « maintenant + 48 h » pour tout
  // depart eloigne, le groupement reste large dans le cas nominal.
  const parDestination = new Map()
  for (const { menage, choix } of aReassigner) {
    const colonnes = colonnesAssignation(choix, menage.departure_date, maintenant)
    const k = `${colonnes.provider_id}|${colonnes.offered_to}|${colonnes.status}|${colonnes.offer_expires_at}`
    if (!parDestination.has(k)) parDestination.set(k, { colonnes, menages: [] })
    parDestination.get(k).menages.push(menage)
  }
  for (const { colonnes, menages } of parDestination.values()) {
    const { error: errAff } = await supabase.from('menages')
      .update({ ...colonnes, updated_at: new Date(maintenant).toISOString() })
      .in('id', menages.map(m => m.id))
    if (errAff) { console.error('[sync-menages-entite] assignation differee echec:', errAff.message); bilan.erreurs++; continue }
    bilan.assignes_apres_coup += menages.length
    for (const menage of menages) {
      journal.push({ user_id: menage.user_id, menage_id: menage.id,
                     event: evenementDe(colonnes),
                     to_provider_id: colonnes.offered_to || colonnes.provider_id || null,
                     actor: 'cron',
                     reason: 'Prestataire de garde trouvee apres la creation du menage.' })
    }
  }

  // Les menages devenus sans objet. On ne les SUPPRIME pas : une prestataire a
  // pu s'organiser autour, et l'historique de qualite s'appuie dessus.
  // ⚠ AUCUNE ANNULATION SUR UNE LECTURE TRONQUEE (voir plus haut).
  // ⚠ ON N'ANNULE PAS CE QU'ON N'A PAS PU JUGER.
  // Sauter un bien inconnu de `properties` (correctif ci-dessus) le retire aussi
  // de `vivants` : ses menages paraissaient alors disparus, et etaient annules
  // en masse. Un bien qu'on ne sait pas lire n'est pas un bien dont les sejours
  // ont disparu — c'est un bien sur lequel on ne se prononce pas.
  // Defaut trouve en ecrivant la contre-epreuve du correctif precedent, pas par
  // la review.
  const aAnnuler = tronque ? [] : (existants || []).filter(m =>
    m.status !== 'cancelled' &&
    providerParBien.has(`${m.user_id}|${String(m.property_id)}`) &&
    !vivants.has(cle(m)))
  if (aAnnuler.length) {
    const { error: errAnn } = await supabase.from('menages')
      .update({ status: 'cancelled', updated_at: new Date(maintenant).toISOString() })
      .in('id', aAnnuler.map(m => m.id))
    if (errAnn) {
      console.error('[sync-menages-entite] annulation echec:', errAnn.message)
      bilan.erreurs++
    } else {
      bilan.annules = aAnnuler.length
      for (const m of aAnnuler) {
        journal.push({
          user_id: m.user_id, menage_id: m.id, event: 'cancelled',
          from_provider_id: m.provider_id, actor: 'cron',
          reason: 'Reservation annulee ou date de depart deplacee.'
        })
      }
    }
  }

  await journaliser(journal)

  // ⚠ Une alerte PAR BIEN, pas par menage : trois departs sans personne de garde
  // sur le meme bien sont un seul probleme. `reportIncident` porte deja son
  // propre anti-spam horaire par (type, bien).
  const biensAlertes = new Set()
  for (const a of alertes) {
    const k = `${a.userId}|${a.propertyId}`
    if (biensAlertes.has(k)) continue
    biensAlertes.add(k)
    try {
      await reportIncident('menage_non_assigne', {
        userId: a.userId, propertyId: a.propertyId,
        detail: { message: a.motif === 'jours'
          ? `Menage du ${a.depart} : personne n'est assignee d'office sur ce bien, et aucune des prestataires liees n'a de jours attitres regles — aucune n'a donc ete sollicitee.`
          : `Menage du ${a.depart} : personne n'est de garde ce jour-la sur ce bien (ni attitree, ni disponible).` }
      })
      bilan.alertes++
    } catch (e) {
      console.error('[sync-menages-entite] alerte echec:', e.message)
    }
  }

  console.log(`[sync-menages-entite] lus=${bilan.lus} crees=${bilan.crees} annules=${bilan.annules} ressuscites=${bilan.ressuscites} rattrapes=${bilan.assignes_apres_coup} non_assignes=${bilan.non_assignes} alertes=${bilan.alertes}${bilan.tronque ? ' TRONQUE' : ''}`)
  return bilan
}

// ─── Expiration des propositions ────────────────────────────────────────────
//
// ⚠ UNE PROPOSITION QUI EXPIRE NE CHANGE RIEN AU PORTEUR. Elle s'efface, et le
// menage reste chez la porteuse comme si de rien n'etait — elle l'a toujours eu.
// C'est tout l'interet du modele parallele : rien n'est decouvert, et il n'y a
// donc rien a alerter en urgence.
//
// ⚠ L'ESCALADE VIENT APRES, PAS ICI. `poserPropositionsDues` tourne dans le meme
// cycle et sollicite la candidate suivante — l'expiration se contente de liberer
// la place, et le journal (`expired`) est ce qui empeche de reproposer a la
// personne qui n'a pas repondu.
//
// Le seul cas qui merite une alerte forte est celui d'un menage que PERSONNE ne
// porte : un bien sans porteuse dont la proposition expire. La, il devient
// `orphaned` et appelle une decision humaine.
async function expirerPropositions (results = null, opts = {}) {
  const maintenant = opts.maintenant || Date.now()
  const bilan = { expirees: 0, orphelins: 0, erreurs: 0 }

  const { data: expirees, error } = await supabase.from('menages')
    .select('id, user_id, property_id, departure_date, provider_id, offered_to')
    .not('offered_to', 'is', null)
    .lt('offer_expires_at', new Date(maintenant).toISOString())
    // ⚠ L'annulation n'efface pas la proposition : sans ce filtre, un menage
    // ANNULE dont l'offre expire repassait en `orphaned`, reapparaissait au
    // planning avec la pastille « refusé », et declenchait une alerte pour une
    // reservation qui n'existe plus.
    .neq('status', 'cancelled')
    .limit(200)
  if (error) {
    console.error('[expirer-offres] lecture echec:', error.message)
    results?.errors?.push({ context: 'expirer_offres', error: error.message })
    return { ...bilan, interrompu: 'db' }
  }
  if (!expirees || !expirees.length) return bilan

  // Deux sorts differents, selon qu'il reste ou non quelqu'un pour le faire.
  const portes = expirees.filter(m => m.provider_id)
  const sansPersonne = expirees.filter(m => !m.provider_id)

  if (portes.length) {
    const { error: e1 } = await supabase.from('menages')
      .update({ ...SANS_OFFRE, updated_at: new Date(maintenant).toISOString() })
      .in('id', portes.map(m => m.id))
    if (e1) { console.error('[expirer-offres] maj echec:', e1.message); bilan.erreurs++ }
    else bilan.expirees += portes.length
  }

  if (sansPersonne.length) {
    // ⚠ PAS DE VERROU `manual` ICI. Une expiration n'est pas une decision
    // humaine : `poserPropositionsDues` doit pouvoir solliciter la candidate
    // suivante au meme cycle. C'est le REFUS qui verrouille, pas le silence.
    const { error: e2 } = await supabase.from('menages')
      .update({ ...SANS_OFFRE, status: 'orphaned',
                assignment_reason: 'Proposition expiree, et personne ne porte ce menage.',
                updated_at: new Date(maintenant).toISOString() })
      .in('id', sansPersonne.map(m => m.id))
    if (e2) { console.error('[expirer-offres] maj orphelins echec:', e2.message); bilan.erreurs++ }
    else { bilan.expirees += sansPersonne.length; bilan.orphelins += sansPersonne.length }
  }

  // ⚠ On ne journalise QUE ce qui a reellement ete ecrit : une ligne `expired`
  // posee malgre une panne affirmerait que la proposition est levee alors
  // qu'elle est toujours la.
  const ecrits = new Set()
  if (bilan.expirees) {
    for (const m of expirees) if (!bilan.erreurs) ecrits.add(m.id)
  }
  const journal = expirees.filter(m => ecrits.has(m.id)).map(m => ({
    user_id: m.user_id, menage_id: m.id, event: 'expired',
    from_provider_id: m.offered_to, actor: 'cron',
    reason: m.provider_id
      ? 'Proposition expiree : le menage reste chez son porteur.'
      : 'Proposition expiree, et personne ne porte ce menage.'
  }))
  await journaliser(journal)

  // ⚠ Alerte SEULEMENT pour ce que plus personne ne porte. Alerter sur une
  // proposition expiree dont la porteuse garde la charge serait du bruit : rien
  // n'est decouvert, et l'hote finirait par ne plus lire ces messages.
  const biens = new Set()
  for (const m of sansPersonne) {
    const k = `${m.user_id}|${String(m.property_id)}`
    if (biens.has(k)) continue
    biens.add(k)
    try {
      await reportIncident('menage_non_assigne', {
        userId: m.user_id, propertyId: String(m.property_id),
        detail: { message: `Menage du ${m.departure_date} : proposition expiree et personne ne le porte.` }
      })
    } catch (e) { console.error('[expirer-offres] alerte echec:', e.message) }
  }

  console.log(`[expirer-offres] expirees=${bilan.expirees} orphelins=${bilan.orphelins}`)
  return bilan
}

// ─── Les propositions DUES ──────────────────────────────────────────────────
//
// ⚠ POURQUOI CE JOB EXISTE. Une proposition expire en 48 h au plus. Posee a la
// creation d'un menage qui part dans six mois, elle serait morte deux jours plus
// tard et la responsable du jour n'aurait plus jamais l'occasion de le prendre.
// La proposition est donc posee QUAND LE DEPART APPROCHE (`JOURS_PROPOSITION`),
// jamais a la creation d'un depart lointain. C'est aussi la garde d'envoi de
// masse de REVIEW.md regle 2 : sans elle, la premiere activation d'un compte
// Channex aurait envoye un SMS par reservation future de l'historique.
//
// ⚠ C'EST AUSSI LE CHEMIN D'ESCALADE. Apres un refus ou une expiration, la
// candidate suivante du jour est sollicitee ici — en sautant celles que le
// journal connait (`declined`, `expired`). Quand la file est epuisee, le menage
// reste chez sa porteuse : c'est l'invariant du §12.4, et l'escalade se termine
// d'elle-meme.
//
// ⚠ JAMAIS LES MENAGES ANTERIEURS AU LOT 3.3. Le filtre `assignment_mode='garde'`
// les ecarte : les 179 menages `accepted` du 4 septembre portent `'priorite'` et
// ne sont jamais repris — recalculer un menage accepte defairait un engagement.
async function poserPropositionsDues (results = null, opts = {}) {
  const maintenant = opts.maintenant || Date.now()
  const bilan = { examines: 0, proposees: 0, notifiees: 0, erreurs: 0 }

  // ⚠ Le PASSE PROCHE reste dedans (J-1) : un menage d'hier peut encore etre a
  // faire. Au-dela, proposer n'a plus d'objet.
  const debut = jour(-1, maintenant)
  const fin = jour(JOURS_PROPOSITION, maintenant)

  const { data: menages, error } = await supabase.from('menages')
    .select('id, user_id, property_id, booking_id, departure_date, provider_id, status')
    .eq('assignment_mode', 'garde')
    // ⚠ JAMAIS UN VERROU MANUEL : l'hote a tranche, et poser une proposition
    // par-dessus rouvrirait une decision qu'il a fermee.
    .eq('assigned_by', 'auto')
    .is('offered_to', null)
    // `accepted` = quelqu'un porte, on peut proposer a cote. `unassigned` =
    // personne, la proposition est le seul chemin. `cancelled` n'a plus d'objet.
    //
    // ⚠ `orphaned` EST INCLUS, ET C'EST ESSENTIEL. Une proposition qui expire sur
    // un bien sans porteuse y passe le menage (`expirerPropositions`) : l'exclure
    // ici arretait l'escalade dans le SEUL cas ou elle compte — deux candidates a
    // confirmer, la premiere ne repond pas, la seconde n'etait jamais sollicitee
    // alors qu'elle est attitree et disponible. Rien ne ressuscite ce statut
    // ailleurs.
    // ⚠ Ce qui distingue les deux `orphaned`, c'est le VERROU, pas le statut :
    // un REFUS pose `assigned_by = 'manual'` (une decision humaine, qu'on ne
    // rouvre pas) ; une EXPIRATION ne le pose pas (le silence n'est pas une
    // decision). Le filtre `assigned_by = 'auto'` ci-dessus fait donc le tri.
    .in('status', ['accepted', 'unassigned', 'orphaned'])
    .gte('departure_date', debut)
    .lte('departure_date', fin)
    .order('departure_date', { ascending: true })
    .limit(LOT_PROPOSITIONS)
  if (error) {
    console.error('[propositions-dues] lecture echec:', error.message)
    results?.errors?.push({ context: 'propositions_dues', error: error.message })
    return { ...bilan, interrompu: 'db' }
  }
  if (!menages || !menages.length) return bilan
  bilan.examines = menages.length
  if (menages.length >= LOT_PROPOSITIONS) {
    console.warn(`[propositions-dues] lecture au plafond de ${LOT_PROPOSITIONS} : des departs de la fenetre attendent le cycle suivant`)
  }

  const userIds = [...new Set(menages.map(m => m.user_id))]
  let liaisonsParBien, dispos, refus
  try {
    liaisonsParBien = await chargerLiaisons(supabase, menages.map(m => ({
      userId: m.user_id, propertyId: m.property_id
    })))
    dispos = await chargerDisponibilites(supabase, userIds, { du: debut, au: fin })
    // ⚠ SANS LE JOURNAL, L'ESCALADE BOUCLE : on reproposerait a la personne qui
    // vient de refuser, qui refuserait encore, toutes les cinq minutes.
    refus = await chargerRefus(supabase, menages.map(m => m.id))
  } catch (e) {
    console.error('[propositions-dues]', e.message)
    results?.errors?.push({ context: 'propositions_dues', error: e.message })
    return { ...bilan, interrompu: 'db' }
  }

  // Le nom des biens, pour que le SMS dise DE QUOI il parle. Une panne ici ne
  // coupe pas : un message sans nom de bien vaut mieux qu'aucun message.
  const nomParBien = new Map()
  {
    const { data: biens, error: errB } = await supabase.from('properties')
      .select('user_id, provider_property_id, name')
      .in('user_id', userIds).not('provider_property_id', 'is', null).limit(LOT_BIENS)
    if (errB) console.error('[propositions-dues] noms des biens illisibles:', errB.message)
    for (const b of (biens || [])) nomParBien.set(`${b.user_id}|${String(b.provider_property_id)}`, b.name)
  }

  const base = (process.env.PUBLIC_BASE_URL || 'https://hotesmart.vercel.app').replace(/\/+$/, '')
  const journal = []

  for (const m of menages) {
    if (bilan.proposees >= MAX_POSES_PAR_CYCLE) {
      console.warn(`[propositions-dues] plafond de ${MAX_POSES_PAR_CYCLE} atteint : reliquat au cycle suivant`)
      break
    }
    const bien = bienDeGarde(m.user_id, m.property_id, liaisonsParBien, dispos)
    const choix = deciderParGarde(bien, m.departure_date, {
      exclus: refus.get(String(m.id)) || null, maintenant
    })
    if (!choix.offeredTo) continue
    // ⚠ ON NE SE PROPOSE PAS A SOI-MEME (`menages_offre_pas_a_soi`) : la porteuse
    // actuelle peut tres bien etre la responsable du jour.
    if (m.provider_id && String(choix.offeredTo) === String(m.provider_id)) continue
    // ⚠ CE JOB NE TOUCHE JAMAIS AU PORTEUR. Un menage sans personne alors que la
    // garde en designe une d'office releve du writer, pas d'ici : le solliciter
    // laisserait un `offered` sans porteur alors qu'une porteuse est disponible.
    if (!m.provider_id && choix.providerId) continue

    const echeance = echeanceOffre(m.departure_date, maintenant)
    if (!echeance) continue

    const maj = {
      offered_to: choix.offeredTo,
      offered_at: new Date(maintenant).toISOString(),
      offer_expires_at: echeance,
      assignment_reason: choix.raison,
      updated_at: new Date(maintenant).toISOString()
    }
    // Personne ne porte : le menage passe `offered`. Quelqu'un porte : son statut
    // ne bouge pas — la proposition vit A COTE de l'assignation.
    if (!m.provider_id) maj.status = 'offered'

    // ⚠ CONDITION ATOMIQUE `.is('offered_to', null)` : entre la lecture et
    // l'ecriture, l'hote a pu proposer le menage a quelqu'un depuis son planning.
    // Zero ligne = quelqu'un a ete plus rapide, et c'est un resultat normal.
    const { data: ecrit, error: errMaj } = await supabase.from('menages')
      .update(maj).eq('id', m.id).is('offered_to', null).select('id')
    if (errMaj) {
      console.error('[propositions-dues] maj echec:', errMaj.message); bilan.erreurs++; continue
    }
    if (!ecrit || !ecrit.length) continue
    bilan.proposees++
    journal.push({ user_id: m.user_id, menage_id: m.id, event: 'offered',
                   from_provider_id: m.provider_id || null, to_provider_id: choix.offeredTo,
                   actor: 'cron',
                   reason: 'Proposition posee a l\'approche du depart, a la responsable du jour.' })

    // ⚠ NOTIFIER, MAIS APRES AVOIR ECRIT, ET BEST-EFFORT. La proposition est
    // deja en base : un envoi rate ne la defait pas. Muette, en revanche, elle
    // expirerait sans que la personne ait su qu'on lui demandait quelque chose.
    if (bilan.notifiees >= MAX_NOTIFS_PAR_CYCLE) continue
    try {
      const notif = await notifierProposition({
        userId: m.user_id, providerId: choix.offeredTo,
        propertyName: nomParBien.get(`${m.user_id}|${String(m.property_id)}`) || null,
        propertyId: String(m.property_id),
        departureDate: m.departure_date, expireLe: echeance,
        lien: `${base}/apps/menages/public`
      })
      if (notif && (notif.sms || notif.email)) bilan.notifiees++
    } catch (e) { console.error('[propositions-dues] notification echec:', e.message) }
  }

  await journaliser(journal)
  console.log(`[propositions-dues] examines=${bilan.examines} proposees=${bilan.proposees} notifiees=${bilan.notifiees}`)
  return bilan
}

module.exports = { synchroniserMenages, expirerPropositions, poserPropositionsDues,
                   JOURS_ARRIERE, JOURS_AVANT, LOT_MAX,
                   MAX_NOTIFS_PAR_CYCLE, MAX_POSES_PAR_CYCLE }
