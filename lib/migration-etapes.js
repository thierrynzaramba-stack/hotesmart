// lib/migration-etapes.js
// LA VERITE DE CHAQUE ETAPE DE MIGRATION — point unique.
// Spec : docs/specs/spec-assistant-migration.md
//
// Regle de Thierry (9 septembre 2026) : chaque mecanisme du chantier est une
// ETAPE de l'assistant, pas un script d'operateur. L'etat vit ICI ; l'endpoint
// (api/migration.js) l'expose, les scripts l'appellent. Un script qui garderait
// sa propre logique deviendrait un second writer — le defaut deja paye trois
// fois dans ce depot.
//
// ⚠ LECTURE SEULE. Ce module n'ecrit rien : il DIT ou en est un bien. Les
// actions vivent dans l'endpoint, et chacune montre avant d'agir.

const { jugerPrixDuCoeur } = require('./garde-activation')

const HORIZON_PRIX_JOURS = 400

// Les champs que le produit CONSOMME reellement (regle du 8 septembre :
// un champ existe s'il a un consommateur). `base_price` n'en fait pas partie —
// un bien peut vendre sans, ses nuits tarifees font foi.
const CHAMPS_FICHE = ['capacity', 'property_type', 'timezone', 'currency']

function etape (id, titre, etat, detail, action = null) {
  return { id, titre, etat, detail, action }
}

// ─── 1. L'historique des reservations ────────────────────────────────────────
async function etatReservations (supabase, bien) {
  const { count, error } = await supabase
    .from('bookings_snapshot')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', String(bien.provider_property_id))
  if (error) return etape('rapatriement_reservations', 'Historique des reservations', 'bloque',
    `Lecture impossible : ${error.message}`)

  if (!count) {
    return etape('rapatriement_reservations', 'Historique des reservations', 'a_faire',
      'Aucune reservation dans le coeur. Sans historique, la migration perdrait le passe du logement.',
      'rapatrier_reservations')
  }

  // Le payload brut est le vrai critere : un snapshot sans `raw` a perdu ce que
  // le provider savait, et on ne le retrouvera plus apres la deconnexion.
  const { count: sansRaw } = await supabase
    .from('bookings_snapshot')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', String(bien.provider_property_id))
    .is('raw', null)

  if (sansRaw) {
    return etape('rapatriement_reservations', 'Historique des reservations', 'a_faire',
      `${count} reservations, mais ${sansRaw} sans payload brut. A completer avant toute deconnexion.`,
      'rapatrier_reservations')
  }
  return etape('rapatriement_reservations', 'Historique des reservations', 'fait',
    `${count} reservations, payload brut complet.`)
}

// ─── 2. La fiche provider brute ──────────────────────────────────────────────
async function etatFicheBrute (supabase, bien) {
  const { data, error } = await supabase
    .from('property_snapshots')
    .select('raw, fetched_at, updated_at')
    .eq('user_id', bien.user_id).eq('provider', bien.provider)
    .eq('property_id', String(bien.provider_property_id)).maybeSingle()
  if (error) return etape('rapatriement_fiche', 'Fiche du logement', 'bloque',
    `Lecture impossible : ${error.message}`)
  if (!data) return etape('rapatriement_fiche', 'Fiche du logement', 'a_faire',
    'La fiche du provider n\'a jamais ete rapatriee.', 'rapatrier_fiche')

  const champs = compterFeuilles(data.raw)
  return etape('rapatriement_fiche', 'Fiche du logement', 'fait',
    `${champs} champs conserves, releve le ${String(data.fetched_at).slice(0, 10)}.`,
    'rapatrier_fiche')
}

function compterFeuilles (o) {
  if (o === null || typeof o !== 'object') return 1
  if (Array.isArray(o)) return o.length ? compterFeuilles(o[0]) : 1
  return Object.keys(o).reduce((n, k) => n + compterFeuilles(o[k]), 0)
}

// ─── 3. La fiche unifiee ─────────────────────────────────────────────────────
function etatFicheUnifiee (bien) {
  const manquants = CHAMPS_FICHE.filter(c => bien[c] == null || bien[c] === '')
  if (manquants.length) {
    return etape('fiche_unifiee', 'Fiche unifiee', 'a_faire',
      `Champs non renseignes : ${manquants.join(', ')}. La creation du logement chez le nouveau provider les demande.`,
      'remplir_fiche')
  }
  return etape('fiche_unifiee', 'Fiche unifiee', 'fait',
    `Capacite ${bien.capacity}, type ${bien.property_type}, fuseau ${bien.timezone}.`,
    'remplir_fiche')
}

// ─── 4. L'amorcage des prix ──────────────────────────────────────────────────
async function etatPrix (supabase, bien) {
  const debut = new Date().toISOString().slice(0, 10)
  const fin = new Date(Date.now() + HORIZON_PRIX_JOURS * 86400000).toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('calendar_inventory').select('date, rate')
    .eq('property_id', bien.id).gte('date', debut).lte('date', fin)
    .not('rate', 'is', null).order('date').limit(1000)
  if (error) return etape('amorcage_prix', 'Prix par date', 'bloque',
    `Lecture impossible : ${error.message}`)

  const avec = (data || []).filter(r => Number(r.rate) > 0)
  if (!avec.length) {
    const base = Number(bien.base_price)
    if (base > 0) {
      return etape('amorcage_prix', 'Prix par date', 'fait',
        `Aucun prix par date, mais un prix de base de ${base} € couvre toutes les nuits.`,
        'amorcer_prix')
    }
    return etape('amorcage_prix', 'Prix par date', 'a_faire',
      'Aucun prix dans le coeur. Les nuits sans prix partent FERMEES : rien ne se vendrait.',
      'amorcer_prix')
  }
  return etape('amorcage_prix', 'Prix par date', 'fait',
    `${avec.length} nuit(s) tarifee(s), de ${avec[0].date} a ${avec[avec.length - 1].date}. `
    + 'Les nuits sans prix partent fermees — c\'est voulu.',
    'amorcer_prix')
}

// ─── 5. La garde d'activation ────────────────────────────────────────────────
async function etatGarde (supabase, bien) {
  const juge = await jugerPrixDuCoeur(supabase, bien)
  if (!juge.pret) {
    return etape('garde_activation', 'Publication autorisee', 'bloque', juge.message)
  }
  return etape('garde_activation', 'Publication autorisee', 'fait',
    'Le coeur detient de quoi vendre : activer un canal ne publiera pas un prix par defaut.')
}

// ─── L'etat complet d'un bien ────────────────────────────────────────────────
async function etatMigration (supabase, bien) {
  const etapes = [
    await etatReservations(supabase, bien),
    await etatFicheBrute(supabase, bien),
    etatFicheUnifiee(bien),
    await etatPrix(supabase, bien),
    await etatGarde(supabase, bien)
  ]
  return {
    bien: { id: bien.id, nom: bien.name, provider: bien.provider },
    pretes: etapes.filter(e => e.etat === 'fait').length,
    total: etapes.length,
    bloquees: etapes.filter(e => e.etat === 'bloque').map(e => e.id),
    etapes
  }
}

module.exports = { etatMigration, CHAMPS_FICHE, HORIZON_PRIX_JOURS }
