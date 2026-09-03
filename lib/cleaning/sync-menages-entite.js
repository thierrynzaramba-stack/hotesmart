// lib/cleaning/sync-menages-entite.js
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// WRITER UNIQUE de la table `menages`. Conception : spec §11.1.
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

const { supabase } = require('../cron-shared')
const { isActiveStatus } = require('../bookings-snapshot')
const { chargerLiaisons, choisirPrestataire, horodatages, echeanceOffre, SANS_OFFRE } = require('./assign')
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
    .select('id, user_id, property_id, booking_id, departure_date, status, provider_id, assigned_by, offered_to, offer_expires_at')
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

  // Les liaisons de tous les biens du lot, en une passe.
  let liaisonsParBien
  try {
    liaisonsParBien = await chargerLiaisons(supabase, lignes.map(l => ({
      userId: l.user_id, propertyId: l.property_id
    })))
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

    const liaisons = liaisonsParBien.get(`${l.user_id}|${String(l.property_id)}`) || []
    const choix = choisirPrestataire(liaisons)
    const dates = horodatages(choix, new Date(maintenant))

    // ⚠ Une proposition sans delai de reponse n'est pas une proposition : si
    // l'echeance serait deja passee, le menage reste simplement non assigne et
    // l'hote tranchera. Mieux vaut une case vide qu'une offre morte-nee.
    const echeance = choix.offeredTo ? echeanceOffre(depart, maintenant) : null
    const proposable = !choix.offeredTo || !!echeance

    aCreer.push({
      user_id: l.user_id,
      property_id: String(l.property_id),
      booking_id: String(l.booking_id),
      departure_date: depart,
      provider_id: choix.providerId,
      offered_to: proposable ? (choix.offeredTo || null) : null,
      offer_expires_at: proposable ? echeance : null,
      status: proposable ? choix.status : 'unassigned',
      assigned_by: choix.assignedBy,
      assignment_reason: proposable ? choix.raison
        : 'Aucun referent, et trop tard pour proposer au suppleant.',
      assignment_mode: 'priorite',
      ...dates
    })

    if (!choix.providerId) {
      bilan.non_assignes++
      // ⚠ ON N'ALERTE QUE SI LE BIEN A AU MOINS UNE LIAISON ACTIVE.
      // Un bien sans aucun prestataire lie n'est pas en panne : il n'est pas
      // gere par l'app menage, et alerter a chaque depart noierait les vraies
      // alertes sous du bruit permanent. Decision du product owner, 3 septembre
      // 2026. Le cas « le bien a des prestataires mais aucun n'est assignable »
      // n'existe pas encore en mode `priorite` — il apparaitra avec les
      // disponibilites — mais la garde est posee du bon cote des maintenant.
      if (!choix.aucuneLiaison) {
        alertes.push({ userId: l.user_id, propertyId: String(l.property_id), depart })
      }
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
    // ⚠ `orphaned` = quelqu'un a REFUSE. Le reassigner reviendrait a le rendre a
    // la personne qui vient de dire non, qui refuserait encore : une boucle dont
    // personne ne sortirait. Ce statut appelle une decision humaine — l'hote a
    // ete alerte, c'est a lui de trancher. L'escalade automatique vers la
    // candidate suivante reste reportee (spec §3 bis).
    // ⚠ Une PROPOSITION en cours n'est pas un menage sans personne : la
    // reassigner effacerait une sollicitation a laquelle quelqu'un s'apprete
    // peut-etre a repondre.
    if (m.provider_id || m.offered_to || m.assigned_by === 'manual') continue
    if (m.status === 'cancelled' || m.status === 'orphaned') continue
    if (!vivants.has(cle(m))) continue
    const liaisons = liaisonsParBien.get(`${m.user_id}|${String(m.property_id)}`) || []
    const choix = choisirPrestataire(liaisons)
    // ⚠ `providerId` SEUL NE SUFFIT PLUS. Depuis le modele parallele, un bien
    // sans referent rend `providerId: null` et `offeredTo: <suppleant>` : tester
    // le seul porteur faisait sauter TOUS ces cas, et les menages d'un hote qui
    // ne lie qu'un rang 2 n'etaient plus jamais proposes a personne.
    if (!choix.providerId && !choix.offeredTo) continue
    aReassigner.push({ menage: m, choix })
  }

  if (aCreer.length) {
    // `ignoreDuplicates` : deux cycles concurrents ne doivent pas se marcher
    // dessus, et la contrainte d'identite est la garde finale.
    const { data: inseres, error: errIns } = await supabase.from('menages')
      .upsert(aCreer, { onConflict: 'user_id,property_id,booking_id,departure_date', ignoreDuplicates: true })
      .select('id, user_id, provider_id, status')
    if (errIns) {
      console.error('[sync-menages-entite] insert echec:', errIns.message)
      results?.errors?.push({ context: 'sync_menages_entite', error: errIns.message })
      bilan.erreurs++
    } else {
      bilan.crees = (inseres || []).length
      for (const m of (inseres || [])) {
        journal.push({
          user_id: m.user_id, menage_id: m.id,
          event: m.provider_id ? (m.status === 'offered' ? 'offered' : 'assigned') : 'created',
          to_provider_id: m.provider_id, actor: 'cron',
          reason: m.provider_id ? null : 'Aucun prestataire assigne a la creation.'
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
  // comme a la creation.
  for (const m of aRessusciter) {
    // ⚠ UN VERROU MANUEL SURVIT A L'ANNULATION. Recalculer l'assignation d'un
    // menage verrouille — refuse par une prestataire, ou laisse sans personne
    // par l'hote — reviendrait a defaire sa decision par la bande : il suffisait
    // que la date de depart bouge puis revienne. On le ressuscite tel qu'il
    // etait : sans personne, et toujours verrouille.
    const verrouille = m.assigned_by === 'manual'
    const liaisons = verrouille ? [] : (liaisonsParBien.get(`${m.user_id}|${String(m.property_id)}`) || [])
    const choix = verrouille
      ? { providerId: null, offeredTo: null, status: 'orphaned', assignedBy: 'manual',
          raison: m.assignment_reason || 'Decision humaine, conservee.' }
      : choisirPrestataire(liaisons)
    const dates = horodatages(choix, new Date(maintenant))
    // ⚠ MEME GARDE QU'A LA CREATION. `echeanceOffre` rend null quand l'echeance
    // serait deja passee ; ecrire `offered_to` sans echeance viole la contrainte
    // `menages_offre_datee`, l'update echoue, et le menage reste `cancelled`
    // POUR TOUJOURS — invisible de la PWA comme du planning, sans alerte.
    const echeanceRes = choix.offeredTo ? echeanceOffre(m.departure_date, maintenant) : null
    const proposableRes = !choix.offeredTo || !!echeanceRes
    const { error: errRes } = await supabase.from('menages').update({
      provider_id: choix.providerId,
      offered_to: proposableRes ? (choix.offeredTo || null) : null,
      offer_expires_at: proposableRes ? echeanceRes : null,
      status: proposableRes ? choix.status : 'unassigned',
      assigned_by: choix.assignedBy, assignment_reason: choix.raison,
      assignment_mode: 'priorite', ...dates,
      updated_at: new Date(maintenant).toISOString()
    }).eq('id', m.id)
    if (errRes) { console.error('[sync-menages-entite] resurrection echec:', errRes.message); bilan.erreurs++; continue }
    bilan.ressuscites++
    journal.push({ user_id: m.user_id, menage_id: m.id, event: 'created', actor: 'cron',
                   to_provider_id: choix.providerId,
                   reason: 'Menage reactive : la reservation existe toujours.' })
  }

  // Assignation rattrapee des menages restes sans personne.
  //
  // ⚠ GROUPEE PAR DESTINATION. Un UPDATE par ligne, en sequentiel, dans une
  // fonction plafonnee a 60 s : le cas nominal — un hote qui lie sa femme de
  // menage apres avoir branche son PMS — en trouve des centaines d'un coup, et
  // c'est le dispatch, le poste le plus lourd du cycle, qui vient juste apres.
  // Les menages a rattraper partagent le meme choix des qu'ils sont sur le meme
  // bien : on les regroupe.
  const parDestination = new Map()
  for (const { menage, choix } of aReassigner) {
    const k = `${choix.providerId}|${choix.offeredTo}|${choix.status}`
    if (!parDestination.has(k)) parDestination.set(k, { choix, menages: [] })
    parDestination.get(k).menages.push(menage)
  }
  for (const { choix, menages } of parDestination.values()) {
    const dates = horodatages(choix, new Date(maintenant))
    const echeanceAff = choix.offeredTo ? echeanceOffre(menages[0].departure_date, maintenant) : null
    const proposableAff = !choix.offeredTo || !!echeanceAff
    const { error: errAff } = await supabase.from('menages').update({
      provider_id: choix.providerId,
      offered_to: proposableAff ? (choix.offeredTo || null) : null,
      offer_expires_at: proposableAff ? echeanceAff : null,
      status: proposableAff ? choix.status : 'unassigned',
      assigned_by: choix.assignedBy, assignment_reason: choix.raison,
      assignment_mode: 'priorite', ...dates,
      updated_at: new Date(maintenant).toISOString()
    }).in('id', menages.map(m => m.id))
    if (errAff) { console.error('[sync-menages-entite] assignation differee echec:', errAff.message); bilan.erreurs++; continue }
    bilan.assignes_apres_coup += menages.length
    for (const menage of menages) {
      journal.push({ user_id: menage.user_id, menage_id: menage.id,
                     event: choix.status === 'offered' ? 'offered' : 'assigned',
                     to_provider_id: choix.providerId, actor: 'cron',
                     reason: 'Prestataire lie apres la creation du menage.' })
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

  // ⚠ Une alerte PAR BIEN, pas par menage : trois departs non assignables sur le
  // meme bien sont un seul probleme. `reportIncident` porte deja son propre
  // anti-spam horaire par (type, bien).
  const biensAlertes = new Set()
  for (const a of alertes) {
    const k = `${a.userId}|${a.propertyId}`
    if (biensAlertes.has(k)) continue
    biensAlertes.add(k)
    try {
      await reportIncident('menage_non_assigne', {
        userId: a.userId, propertyId: a.propertyId,
        detail: { message: `Menage du ${a.depart} sans prestataire assigne alors que le bien en a au moins un de lie.` }
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
// menage reste chez la referente comme si de rien n'etait — elle l'a toujours
// eu. C'est tout l'interet du modele parallele : rien n'est decouvert, et il n'y
// a donc rien a alerter en urgence.
//
// Le seul cas qui merite une alerte forte est celui d'un menage que PERSONNE ne
// porte : un bien sans referente dont la proposition expire. La, il devient
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
  // proposition expiree dont la referente garde la charge serait du bruit : rien
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

module.exports = { synchroniserMenages, expirerPropositions, JOURS_ARRIERE, JOURS_AVANT, LOT_MAX }
