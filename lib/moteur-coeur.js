// lib/moteur-coeur.js
// DOC : docs/kb/moteur-reservation.md (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §4 et §5
//
// LA LECTURE DU CŒUR POUR LE MOTEUR DE RESERVATION.
// Extrait de `api/book-public.js` a l'etape 2, quand un second endpoint
// (`api/book-pay.js`) a eu besoin exactement des memes lectures. Deux copies de
// ces requetes auraient diverge — et une divergence ici veut dire que la page
// affiche un calendrier et que le paiement en calcule un autre.
//
// Ce module TOUCHE Supabase (contrairement a lib/moteur-reservation.js, qui
// reste pur). Il ne fait que LIRE : aucune ecriture n'a sa place ici.
//
// LES TROIS SOURCES, toutes des tables HoteSmart — jamais un provider :
//   properties + booking_links | calendar_inventory | bookings_snapshot + write_locks

const { construireCalendrier } = require('./moteur-reservation')
const { intentionsSurFenetre } = require('./reservation-directe')

// Le jeton est `crypto.randomBytes(32).toString('base64url')` : 43 caracteres de
// l'alphabet base64url. On rejette tout le reste AVANT d'interroger la base.
const JETON_VALIDE = /^[A-Za-z0-9_-]{43}$/

// Champs du LIEN. `label` (la provenance) et `price_coefficient` restent au
// serveur : le premier partira dans le `meta` de la reservation (etape 3), le
// second est deja applique aux prix rendus. Les publier apprendrait au voyageur
// qu'il paie 110 % du tarif d'un autre site.
const CHAMPS_LIEN = 'id, property_id, token, label, price_coefficient, active'

// Champs publiables du bien. Liste FERMEE : on enumere ce qui sort, jamais ce
// qui ne sort pas. Un `select('*')` ici publierait `user_id` et les identifiants
// provider au premier ajout de colonne.
const CHAMPS_BIEN = 'id, user_id, name, city, country, currency, capacity, ' +
  'included_guests, extra_guest_fee, base_price, inventory_units, ' +
  'checkin_time, checkout_time, provider, provider_property_id'

// ─── Resolution du jeton ─────────────────────────────────────────────────────
// Un jeton resout un LIEN, pas un bien : un bien peut vivre sur plusieurs sites
// (§3 ter, ajout 1). Le lien porte le bien, le coefficient ET la provenance.
//
// Rend { lien, bien } ou { erreur } — `erreur` vaut 'lien_inconnu' (404) ou
// 'indisponible' (500). Les deux cas ne se confondent jamais : une panne de
// lecture qui passerait pour « lien inconnu » ferait voir au voyageur une page
// morte, et croire a l'hote que son lien est revoque.
async function resoudreLien (supabase, token) {
  if (!JETON_VALIDE.test(String(token || ''))) return { erreur: 'lien_inconnu' }

  let lien
  try {
    const { data, error } = await supabase
      .from('booking_links').select(CHAMPS_LIEN).eq('token', token).maybeSingle()
    if (error) throw new Error(`lecture booking_links : ${error.message}`)
    lien = data
  } catch (e) {
    console.error('[moteur-coeur]', e.message)
    return { erreur: 'indisponible' }
  }

  // Un lien revoque est indistinguable d'un lien inexistant, VOLONTAIREMENT :
  // repondre differemment dirait a qui detient un ancien jeton qu'il a existe.
  if (!lien || lien.active !== true) return { erreur: 'lien_inconnu' }

  let bien
  try {
    const { data, error } = await supabase
      .from('properties').select(CHAMPS_BIEN).eq('id', lien.property_id).maybeSingle()
    if (error) throw new Error(`lecture properties : ${error.message}`)
    bien = data
  } catch (e) {
    console.error('[moteur-coeur]', e.message)
    return { erreur: 'indisponible' }
  }

  // Le lien existe mais son bien a disparu. La cascade FK l'interdit en
  // principe ; si ca arrive quand meme, c'est un 404, pas un 500 muet.
  if (!bien) return { erreur: 'lien_inconnu' }

  return { lien, bien }
}

// ─── Le calendrier ───────────────────────────────────────────────────────────
async function chargerCalendrier (supabase, bien, lien, debut, jours, tenuePropre) {
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

  // Nuits vendues par nous et pas encore rendues par le feed — y compris les
  // nuits tenues pendant un paiement en cours.
  const intentions = await intentionsSurFenetre(supabase, {
    userId: bien.user_id, propertyId: String(bien.provider_property_id), debut, fin: finIso
  })

  return construireCalendrier({ bien, lien, inventaire, snapshots, intentions, tenuePropre, debut, jours })
}

module.exports = { JETON_VALIDE, CHAMPS_LIEN, CHAMPS_BIEN, resoudreLien, chargerCalendrier }
