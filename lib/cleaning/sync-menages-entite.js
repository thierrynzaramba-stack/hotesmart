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
const { chargerLiaisons, choisirPrestataire, horodatages } = require('./assign')
const { reportIncident } = require('../founder-notify')

// ⚠ SEUL `confirmed` GENERE UN MENAGE.
// `blocked` est un blocage proprietaire ou une maintenance : il occupe le
// calendrier sans voyageur, et c'est la source historique des « menages
// fantomes ». `request` n'occupe rien. `cancelled` annule ce qui existait.
// (lib/bookings-snapshot-status.js documente ce vocabulaire.)
const STATUT_AVEC_MENAGE = 'confirmed'

// Fenetre de reconciliation, en jours autour d'aujourd'hui. En arriere pour
// rattraper un menage recent qu'un cycle aurait manque ; en avant pour que la
// prestataire voie venir. Au-dela, on ne balaye pas l'historique a chaque
// cycle : il ne change plus.
const JOURS_ARRIERE = 30
const JOURS_AVANT   = 180

// Plafond de securite. Un compte qui depasserait ce nombre de menages dans la
// fenetre verrait le reliquat au cycle suivant, plutot qu'un cycle qui deborde.
const LOT_MAX = 500

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
  const bilan = { lus: 0, crees: 0, annules: 0, non_assignes: 0, alertes: 0, erreurs: 0 }

  const debut = jour(-JOURS_ARRIERE, maintenant)
  const fin   = jour(JOURS_AVANT, maintenant)

  // ⚠ Le filtre de date porte sur le JSON du snapshot : `departure` est une date
  // nue « YYYY-MM-DD », donc la comparaison textuelle est exacte et ordonnee.
  const { data: snaps, error } = await supabase.from('bookings_snapshot')
    .select('user_id, property_id, booking_id, snapshot')
    .gte('snapshot->>departure', debut)
    .lte('snapshot->>departure', fin)
    .limit(LOT_MAX)
  if (error) {
    console.error('[sync-menages-entite] lecture snapshots echec:', error.message)
    results?.errors?.push({ context: 'sync_menages_entite', error: error.message })
    return { ...bilan, interrompu: 'db' }
  }

  const lignes = (snaps || []).filter(s => s.snapshot?.departure)
  bilan.lus = lignes.length
  if (!lignes.length) return bilan

  // Les menages deja en base sur la meme fenetre.
  const userIds = [...new Set(lignes.map(l => l.user_id))]
  const { data: existants, error: errEx } = await supabase.from('menages')
    .select('id, user_id, property_id, booking_id, departure_date, status, provider_id, assigned_by')
    .in('user_id', userIds)
    .gte('departure_date', debut)
    .lte('departure_date', fin)
  if (errEx) {
    console.error('[sync-menages-entite] lecture menages echec:', errEx.message)
    results?.errors?.push({ context: 'sync_menages_entite', error: errEx.message })
    return { ...bilan, interrompu: 'db' }
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
  const journal = []
  const alertes = []
  // Ce qui EXISTE encore cote reservations : sert a reperer les menages devenus
  // sans objet (resa annulee, ou date de depart deplacee — la date fait partie
  // de l'identite, donc un deplacement fait naitre un autre menage).
  const vivants = new Set()

  for (const l of lignes) {
    const depart = l.snapshot.departure
    const statut = l.snapshot.status || STATUT_AVEC_MENAGE
    const k = `${l.user_id}|${String(l.property_id)}|${String(l.booking_id)}|${depart}`

    if (statut !== STATUT_AVEC_MENAGE) continue   // blocked / request / cancelled
    vivants.add(k)
    if (dejaLa.has(k)) continue                   // rien a faire : idempotent

    const liaisons = liaisonsParBien.get(`${l.user_id}|${String(l.property_id)}`) || []
    const choix = choisirPrestataire(liaisons)
    const dates = horodatages(choix, new Date(maintenant))

    aCreer.push({
      user_id: l.user_id,
      property_id: String(l.property_id),
      booking_id: String(l.booking_id),
      departure_date: depart,
      provider_id: choix.providerId,
      status: choix.status,
      assigned_by: choix.assignedBy,
      assignment_reason: choix.raison,
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

  // Les menages devenus sans objet. On ne les SUPPRIME pas : une prestataire a
  // pu s'organiser autour, et l'historique de qualite s'appuie dessus.
  const aAnnuler = (existants || []).filter(m =>
    m.status !== 'cancelled' && !vivants.has(cle(m)))
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

  console.log(`[sync-menages-entite] lus=${bilan.lus} crees=${bilan.crees} annules=${bilan.annules} non_assignes=${bilan.non_assignes} alertes=${bilan.alertes}`)
  return bilan
}

module.exports = { synchroniserMenages, JOURS_ARRIERE, JOURS_AVANT, LOT_MAX }
