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

// ─── 6. Le logement chez le nouveau provider ─────────────────────────────────
// L'action existait depuis le 9 septembre ; son ETAT manquait. Une etape qui
// agit sans savoir dire ou elle en est n'est pas une etape d'assistant : on ne
// peut ni la reprendre apres interruption, ni l'afficher (spec §2).
const TITRE_PROV = 'Logement cree chez le nouveau provider'

function etatProvisionnement (bien) {
  const { raisonDeRefus, motifDeRefus } = require('./migration-provisionner')

  // ⚠ LA CIBLE SE LIT AVANT LE PROVIDER, ET L'ORDRE COMPTE.
  // Apres le re-keying (phase 2.8), `provider` vaut 'channex' sur un bien qui a
  // bel et bien ete provisionne. Tester le provider d'abord aurait rendu
  // « sans objet » au moment exact ou l'on veut verifier, post-bascule, que la
  // propriete cible est celle attendue.
  if (bien.migration_target_property_id) {
    const quand = bien.migration_target_at ? `, cree le ${String(bien.migration_target_at).slice(0, 10)}` : ''
    if (!bien.provider_room_type_id || !bien.provider_rate_plan_id) {
      // Etat atteignable apres un nettoyage partiel ou l'echec `ecriture_base`.
      // ⚠ AUCUNE ACTION PROPOSEE : relancer le provisionnement se ferait refuser
      // (`deja_provisionne`). Un assistant qui propose le geste qui va echouer
      // fait perdre le temps qu'il pretend faire gagner.
      return etape('provisionner_channex', TITRE_PROV, 'bloque',
        `Propriete cible posee${quand}, mais room type ou rate plan MANQUANT : la poussee ARI `
        + 'n\'aurait pas ou aller. A reprendre a la main — poser les identifiants manquants, '
        + 'ou supprimer la propriete cible chez le provider avant de relancer la creation.')
    }
    const bascule = (bien.provider === 'channex')
      ? 'La bascule est faite : ce logement est desormais gere par le nouveau provider.'
      : `L'identifiant source (${bien.provider_property_id}) est INCHANGE : la bascule appartient au re-keying.`
    return etape('provisionner_channex', TITRE_PROV, 'fait',
      `Propriete cible en place${quand}. Room type et rate plan poses. ${bascule}`,
      'provisionner_channex')
  }

  // Un bien deja chez la cible et sans cible posee n'a jamais eu de migration a
  // faire : `sans_objet` — et surtout pas `a_faire`, qui inviterait a ecraser ses
  // identifiants de canal.
  if (bien.provider === 'channex') {
    return etape('provisionner_channex', TITRE_PROV, 'sans_objet',
      'Ce logement est deja chez le nouveau provider.')
  }

  const refus = raisonDeRefus(bien)
  if (refus) {
    return etape('provisionner_channex', TITRE_PROV, 'bloque',
      motifDeRefus(refus, bien), 'provisionner_channex')
  }
  return etape('provisionner_channex', TITRE_PROV, 'a_faire',
    'Le logement n\'existe pas encore chez le nouveau provider. '
    + 'La creation ne touche ni l\'historique, ni les canaux : aucun canal n\'existe sur la propriete creee.',
    'provisionner_channex')
}

// ─── 7. Qui gere les prix ────────────────────────────────────────────────────
// Placee AVANT la poussee, dont elle est le prealable : publier des tarifs
// suppose d'avoir choisi que HoteSmart les gere.
const TITRE_MODE = 'Qui gere les prix'

function etatModePrix (bien) {
  const { etatModeDePrix } = require('./migration-mode-prix')
  const r = etatModeDePrix(bien)
  return etape('mode_de_prix', TITRE_MODE, r.etat, r.message, r.action || null)
}

// ─── 8. Les prix et disponibilites chez le nouveau provider ──────────────────
// Plan de bascule, phase 0.3. L'etat se lit CHEZ LA CIBLE (lib/migration-ari.js) :
// « une colonne dit que c'est pousse » et « la propriete cible porte les prix »
// ne sont pas la meme phrase, et seule la seconde protege le jour J.
const TITRE_ARI = 'Prix et disponibilites chez le nouveau provider'

async function etatPousseeAri (supabase, bien, opts) {
  const { estRelieAuCanal, estEnMigration } = require('./rate-sync')
  // Un bien qui n'est pas (ou plus) en migration n'a rien a pousser « vers une
  // cible » : son ARI part par le chemin de tous les jours. On le dit, et
  // surtout on n'ouvre pas un appel reseau a chaque affichage pour rien.
  //
  // ⚠ `estEnMigration`, PAS la simple presence de la colonne cible : apres le
  // re-keying, elle reste renseignee alors que la bascule est finie. L'etape
  // serait restee evaluee a vie, un appel reseau par affichage, et aurait pu
  // rendre « a faire » sur un bien vif dont le calendrier differe legitimement
  // du coeur.
  if (!estEnMigration(bien) && estRelieAuCanal(bien)) {
    return etape('poussee_ari', TITRE_ARI, 'sans_objet',
      'Ce logement n\'est pas en migration : son calendrier part par le chemin habituel.')
  }
  const { etatAri } = require('./migration-ari')
  const r = await etatAri(supabase, bien, opts)
  return etape('poussee_ari', TITRE_ARI, r.etat, r.message, r.action || null)
}

// ─── L'etat complet d'un bien ────────────────────────────────────────────────
// `opts` porte l'appel provider injectable — les tests n'atteignent pas le reseau.
async function etatMigration (supabase, bien, opts = {}) {
  const etapes = [
    await etatReservations(supabase, bien),
    await etatFicheBrute(supabase, bien),
    etatFicheUnifiee(bien),
    await etatPrix(supabase, bien),
    await etatGarde(supabase, bien),
    etatProvisionnement(bien),
    etatModePrix(bien),
    await etatPousseeAri(supabase, bien, opts)
  ]
  // Une etape `sans_objet` ne compte ni au numerateur ni au denominateur :
  // « 5/6 » sur un bien qui n'a rien a provisionner ferait chercher un manque
  // qui n'existe pas.
  const comptees = etapes.filter(e => e.etat !== 'sans_objet')
  return {
    bien: { id: bien.id, nom: bien.name, provider: bien.provider },
    pretes: comptees.filter(e => e.etat === 'fait').length,
    total: comptees.length,
    bloquees: etapes.filter(e => e.etat === 'bloque').map(e => e.id),
    etapes
  }
}

module.exports = { etatMigration, etatProvisionnement, etatPousseeAri, etatModePrix, CHAMPS_FICHE, HORIZON_PRIX_JOURS }
