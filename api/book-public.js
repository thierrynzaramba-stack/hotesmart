// api/book-public.js
// DOC : docs/kb/moteur-reservation.md (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §4 (etape 1)
//
// ENDPOINT PUBLIC DU MOTEUR DE RESERVATION — LECTURE SEULE.
// Sert la page /book/<token>. Aucune authentification : le jeton EST le droit
// d'acces. Modele repris de `api/menages-public.js`, deja eprouve.
//
// CE QU'IL N'EST PAS
// - Il n'ECRIT rien. Pas de reservation, pas de donnee personnelle, pas de trace
//   du voyageur. L'etape 1 est en lecture pure (spec §4) ; le paiement et la
//   creation arrivent aux etapes 2 et 3, par d'autres chemins.
// - Il ne lit AUCUN provider. Les trois sources sont des tables HoteSmart.
//   C'est la regle d'architecture « provider -> cœur -> apps » (CLAUDE.md).
//
// CE QU'IL NE DOIT JAMAIS RENDRE
// `user_id`, le jeton du lien, son coefficient, son label, `provider*`, l'UUID du
// bien, l'adresse exacte, et
// la RAISON pour laquelle une nuit est indisponible. Un voyageur n'a pas a
// savoir si une nuit est fermee par choix ou deja vendue.
//
// PAS D'EN-TETE CORS — VOLONTAIRE
// La page est servie par le meme domaine que cet endpoint : le navigateur n'a
// besoin d'aucune permission croisee. Ajouter `Access-Control-Allow-Origin: *`
// laisserait n'importe quel site lire le calendrier de n'importe quel bien
// depuis le navigateur de ses visiteurs. Ca vaudra aussi pour l'iframe (v2) :
// une iframe qui charge /book reste sur ce domaine.
//
// PAS D'EN-TETE X-Frame-Options — VOLONTAIRE AUSSI
// Decision 3 gravee : la page reste embarquable. On n'en introduit pas.

const { createClient } = require('@supabase/supabase-js')
const {
  bornerJours,
  estDateIso,
  ajouterJours,
  raisonNonVendable,
  construireCalendrier,
  nuitPublique,
  validerSejour
} = require('../lib/moteur-reservation')
const { intentionsSurFenetre } = require('../lib/reservation-directe')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// Le jeton est `crypto.randomBytes(32).toString('base64url')` : 43 caracteres de
// l'alphabet base64url. On rejette tout le reste AVANT d'interroger la base —
// une valeur exotique n'a aucune chance d'exister, autant ne pas la router
// jusqu'a Postgres.
const JETON_VALIDE = /^[A-Za-z0-9_-]{43}$/

// Champs du LIEN. `label` (la provenance) et `price_coefficient` restent au
// serveur : le premier partira dans le `meta` de la reservation (etape 3), le
// second est deja applique aux prix rendus. Les publier apprendrait au voyageur
// qu'il paie 110 % du tarif d'un autre site.
const CHAMPS_LIEN = 'id, property_id, token, label, price_coefficient, active'

// Champs publiables du bien. Liste FERMEE : on enumere ce qui sort, jamais ce
// qui ne sort pas. Un `select('*')` ici publierait `user_id` et les
// identifiants provider au premier ajout de colonne.
const CHAMPS_BIEN = 'id, user_id, name, city, country, currency, capacity, ' +
  'included_guests, extra_guest_fee, base_price, inventory_units, ' +
  'checkin_time, checkout_time, provider, provider_property_id'

function bienPublic (bien) {
  return {
    nom: bien.name,
    ville: bien.city || null,
    pays: bien.country || null,
    devise: bien.currency || 'EUR',
    capacite: Math.max(1, Number(bien.capacity) || 1),
    voyageurs_inclus: Number(bien.included_guests) || Math.max(1, Number(bien.capacity) || 1),
    supplement_voyageur: Number(bien.extra_guest_fee) || 0,
    heure_arrivee: bien.checkin_time || null,
    heure_depart: bien.checkout_time || null
  }
}

// Aujourd'hui en UTC. Meme convention que lib/moteur-reservation.js : une date de
// calendrier est un jour civil, jamais un instant local.
function aujourdhui () {
  return new Date().toISOString().slice(0, 10)
}

module.exports = async function handler (req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') {
    // L'etape 1 est en lecture seule. Un POST ici n'est pas « pas encore
    // implemente », c'est hors contrat.
    return res.status(405).json({ error: 'methode_non_autorisee' })
  }

  const token = String(req.query.token || '')
  if (!JETON_VALIDE.test(token)) {
    return res.status(404).json({ error: 'lien_inconnu' })
  }

  // ─── Le jeton resout un LIEN, pas un bien ──────────────────────────────────
  // Un bien peut vivre sur plusieurs sites (§3 ter, ajout 1). Le lien porte donc
  // le bien, le coefficient de prix ET la provenance, tous les trois d'un coup.
  let lien, bien
  try {
    const { data, error } = await supabase
      .from('booking_links')
      .select(CHAMPS_LIEN)
      .eq('token', token)
      .maybeSingle()
    // ⚠ Une erreur de lecture ne doit jamais passer pour « lien inconnu » : le
    // voyageur verrait une page morte et l'hote croirait son lien revoque.
    if (error) throw new Error(`lecture booking_links : ${error.message}`)
    lien = data
  } catch (e) {
    console.error('[book-public]', e.message)
    return res.status(500).json({ error: 'indisponible' })
  }

  // Un lien revoque est indistinguable d'un lien inexistant, VOLONTAIREMENT :
  // repondre differemment dirait a qui detient un ancien jeton qu'il a bien
  // existe. Desactiver un lien doit le fermer, pas le confirmer.
  if (!lien || lien.active !== true) return res.status(404).json({ error: 'lien_inconnu' })

  try {
    const { data, error } = await supabase
      .from('properties')
      .select(CHAMPS_BIEN)
      .eq('id', lien.property_id)
      .maybeSingle()
    if (error) throw new Error(`lecture properties : ${error.message}`)
    bien = data
  } catch (e) {
    console.error('[book-public]', e.message)
    return res.status(500).json({ error: 'indisponible' })
  }

  // Le lien existe mais son bien a disparu. La cascade FK l'interdit en
  // principe ; si ca arrive quand meme, c'est un 404, pas un 500 muet.
  if (!bien) return res.status(404).json({ error: 'lien_inconnu' })

  const blocage = raisonNonVendable(bien)
  if (blocage) {
    // 200, pas 404 : le lien est valide, c'est le bien qui n'est pas ouvert a la
    // vente. La page affiche un message sobre ; `raison` sert au diagnostic.
    return res.status(200).json({ ouvert: false, raison: blocage, bien: bienPublic(bien) })
  }

  const debut = estDateIso(req.query.debut) && req.query.debut >= aujourdhui()
    ? req.query.debut
    : aujourdhui()
  const jours = bornerJours(req.query.jours)

  let calendrier
  try {
    calendrier = await chargerCalendrier(bien, lien, debut, jours)
  } catch (e) {
    console.error('[book-public] calendrier', e.message)
    return res.status(500).json({ error: 'indisponible' })
  }

  // ─── Devis ─────────────────────────────────────────────────────────────────
  // Le total affiche au voyageur est CALCULE ICI, jamais recu de la page. Ce
  // chemin est deja celui que l'etape 2 verrouillera avant de creer un
  // PaymentIntent : le montant a encaisser ne doit avoir qu'une seule source.
  if (req.query.action === 'devis') {
    const devis = validerSejour({
      calendrier,
      bien,
      lien,
      arrival: String(req.query.arrivee || ''),
      departure: String(req.query.depart || ''),
      personnes: Number(req.query.personnes)
    })
    return res.status(200).json({
      ouvert: true,
      ok: devis.ok,
      raison: devis.raison,
      minimum: devis.minimum || null,
      maximum: devis.maximum || null,
      nuits: devis.nuits.length,
      detail: devis.ok ? devis.detail : [],
      total: devis.total,
      devise: bien.currency || 'EUR'
    })
  }

  return res.status(200).json({
    ouvert: true,
    bien: bienPublic(bien),
    debut,
    jours,
    // Le lendemain de la derniere nuit publiee est un DEPART valide : on n'y dort
    // pas. Sans cette borne, la page rendait la derniere nuit de la fenetre
    // inreservable alors que le serveur, lui, l'acceptait — divergence trouvee
    // en review.
    depart_max: calendrier.length ? ajouterJours(calendrier[calendrier.length - 1].date, 1) : debut,
    nuits: calendrier.map(nuitPublique)
  })
}

// ─── Lecture du cœur ─────────────────────────────────────────────────────────
async function chargerCalendrier (bien, lien, debut, jours) {
  const fin = new Date(`${debut}T00:00:00Z`)
  fin.setUTCDate(fin.getUTCDate() + jours)
  const finIso = fin.toISOString().slice(0, 10)

  // ⚠ PIEGE DE CLE, deja documente : `calendar_inventory.property_id` porte
  // l'UUID de `properties`, alors que `bookings_snapshot.property_id` porte
  // l'identifiant PROVIDER en TEXT. Les deux tables se lisent donc avec des cles
  // differentes pour le meme bien. Les intervertir rend zero ligne en silence —
  // c'est-a-dire un calendrier entierement libre au prix de base.
  const { data: inventaire, error: eInv } = await supabase
    .from('calendar_inventory')
    .select('date, rate, avail, stop_sell, min_stay_arrival, min_stay_through, max_stay, cta, ctd')
    .eq('property_id', bien.id)
    .gte('date', debut)
    .lte('date', finIso)
  if (eInv) throw new Error(`calendar_inventory : ${eInv.message}`)

  // Le filtre `user_id` est OBLIGATOIRE : `provider_property_id` n'a aucune
  // unicite globale, deux hotes peuvent porter le meme identifiant provider.
  // Sans lui, le calendrier d'un hote fermerait des nuits a cause des
  // reservations d'un autre.
  const { data: snapshots, error: eSnap } = await supabase
    .from('bookings_snapshot')
    .select('booking_id, snapshot')
    .eq('user_id', bien.user_id)
    .eq('property_id', String(bien.provider_property_id))
    .gte('snapshot->>departure', debut)
    .lte('snapshot->>arrival', finIso)
  // ⚠ Une erreur ici ne doit JAMAIS passer pour « aucune reservation » : le
  // calendrier afficherait libres des nuits deja vendues. On remonte.
  if (eSnap) throw new Error(`bookings_snapshot : ${eSnap.message}`)

  // Nuits vendues par nous et pas encore rendues par le feed. Sans elles, une
  // reservation saisie a la main il y a deux minutes laisse ses nuits affichees
  // libres ici. Une erreur de lecture remonte (elle ne vaut pas « aucune »).
  const intentions = await intentionsSurFenetre(supabase, {
    userId: bien.user_id, propertyId: String(bien.provider_property_id), debut, fin: finIso
  })

  return construireCalendrier({ bien, lien, inventaire, snapshots, intentions, debut, jours })
}
