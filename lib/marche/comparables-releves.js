// lib/marche/comparables-releves.js — LES RELEVES DES COMPARABLES.
// Seul writer de `comparables_releves` (migration
// 2026-10-28-comparables-releves.sql). Spec : docs/specs/spec-revenus-comparables.md.
//
// ⚠ UN RELEVE, PAS UN ETAT (decision de Thierry du 28 octobre 2026).
// `releve_le` est dans la cle d'unicite : une photo n'ecrase jamais la
// precedente. On garde tout, parce que le cache AirROI dure 90 jours — un mois
// clos non releve deviendrait irrecuperable, et il faudrait le racheter.
//
// ⚠ DEUX GRANDEURS, DEUX COLONNES, ET AUCUNE NE S'APPELLE « revenu » :
//   `montant_estime_cents`  (mois CLOS)  = le champ `revenue` d'AirROI ;
//   `montant_affiche_cents` (mois FUTUR) = la somme des `rate` des nuits
//                                          `available = false`.
// La seconde est une estimation a partir des PRIX AFFICHES, pas un chiffre
// d'affaires — et `available = false` confond une nuit vendue, une nuit que
// l'hote a fermee et une nuit invendable par sejour minimum
// (docs/kb/pickup-yield.md : « fermé à la vente » n'est pas « n'a rien vendu »).
//
// ⚠ FONCTIONS PURES : ni base, ni reseau, ni horloge. `aujourdhui` est TOUJOURS
// passe. C'est ce qui rend ce module eprouvable a n'importe quelle date, et
// c'est la regle du depot — *dates figees si le test injecte le temps*.

const SOURCE_CLOS = 'listings/metrics/all'
const SOURCE_FUTUR = 'listings/live/calendar'

// Combien de mois clos on remplit au premier passage. 24 = deux ans, ce que
// l'ecran compare au plus (N et N-1).
const PROFONDEUR_MOIS = 24

const estJour = (d) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(d || ''))
const estMois = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''))
const moisDe = (jour) => (estJour(jour) ? String(jour).slice(0, 7) : null)
const premierJour = (mois) => (estMois(mois) ? `${mois}-01` : null)

// Le nombre de jours d'un mois. ⚠ `Date.UTC(an, m, 0)` rend le DERNIER jour du
// mois precedent, donc le compte du mois `m` : pas de table de 28/30/31, et les
// annees bissextiles se reglent seules.
function joursDuMois (mois) {
  if (!estMois(mois)) return 0
  const [an, m] = mois.split('-').map(Number)
  return new Date(Date.UTC(an, m, 0)).getUTCDate()
}

// Le mois precedant celui de `jour`. Le dernier mois CLOS, donc.
function moisPrecedent (mois) {
  if (!estMois(mois)) return null
  const [an, m] = mois.split('-').map(Number)
  const d = new Date(Date.UTC(an, m - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// ⚠ `Number(null)` VAUT 0, ET C'EST LE PIEGE. Ma premiere version ecrivait
// `Number.isFinite(Number(v))` : un `revenue` ABSENT devenait donc **0 €**, pas
// `null` — l'absence transformee en fait, dans le module meme qui existe pour
// ne pas le faire. Trouve par son propre test, pas a la relecture.
// ⚠ Et `Number('')` vaut 0 aussi, `Number(' ')` egalement : on refuse donc les
// vides AVANT de convertir, plutot que de se fier a `isFinite`.
// (Meme famille que `typeof NaN === 'number'`, deja paye sur la vue Annee.)
const cents = (v) => {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/**
 * Les lignes des mois CLOS d'une annonce, depuis `GET /listings/metrics/all`.
 *
 * ⚠ UN MOIS N'EST CLOS QUE S'IL EST STRICTEMENT AVANT LE MOIS COURANT. Le mois
 * en cours n'est pas clos — il bougera encore —, et l'inclure ferait entrer
 * dans la bande du realise un chiffre qui n'est pas final.
 *
 * @param o.mensuel  les lignes d'AirROI : [{ date, revenue, ... }]
 * @param o.aujourdhui 'YYYY-MM-DD', injecte
 * @returns [{ mois, nature:'clos', montant_estime_cents, motif, source }]
 */
function lignesCloses ({ listingId, mensuel, aujourdhui, profondeur = PROFONDEUR_MOIS }) {
  if (!estJour(aujourdhui)) return []
  const dernierClos = moisPrecedent(moisDe(aujourdhui))
  if (!dernierClos) return []
  // La borne basse : `profondeur` mois avant le dernier clos, inclus.
  let borne = dernierClos
  for (let i = 1; i < profondeur; i++) borne = moisPrecedent(borne)

  const vues = new Set()
  const out = []
  for (const l of Array.isArray(mensuel) ? mensuel : []) {
    const mois = moisDe(l && l.date)
    if (!mois || mois > dernierClos || mois < borne) continue
    // ⚠ UN MOIS RENDU DEUX FOIS NE COMPTE QU'UNE : la cle d'unicite le
    // refuserait en base, mais un refus de contrainte est un rapport illisible.
    // On tranche ici, et on garde la PREMIERE ligne — l'ordre d'AirROI.
    if (vues.has(mois)) continue
    vues.add(mois)
    const montant = cents(l && l.revenue)
    out.push({
      listing_id: String(listingId),
      mois: premierJour(mois),
      nature: 'clos',
      montant_estime_cents: montant,
      montant_affiche_cents: null,
      nuits_indisponibles: null,
      nuits_mesurees: null,
      // ⚠ LE MOTIF VIT AVEC LE `null`. Un montant nul sans motif devient un
      // zero des que quelqu'un l'additionne.
      motif: montant === null ? 'revenu absent du relevé AirROI' : null,
      source: SOURCE_CLOS
    })
  }
  return out
}

/**
 * Les lignes des mois A VENIR d'une annonce, depuis `GET /listings/live/calendar`.
 *
 * ⚠ CE N'EST PAS DU « DEJA RESERVE », et le nom des colonnes le dit.
 * `available = false` veut dire « pas reservable » : une nuit vendue, une nuit
 * que l'hote a fermee et une nuit bloquee par un sejour minimum s'y
 * ressemblent. On compte des NUITS INDISPONIBLES et on somme des PRIX
 * AFFICHES.
 *
 * ⚠ ET `nuits_mesurees` N'EST PAS DECORATIF : le calendrier porte ~360 jours,
 * donc son dernier mois est TRONQUE. Sans ce compte, un mois couvert sur
 * 9 jours se lirait comme un mois creux.
 *
 * @param o.jours  [{ date, available, rate, min_nights }]
 */
function lignesFutures ({ listingId, jours, aujourdhui }) {
  if (!estJour(aujourdhui)) return []
  const parMois = new Map()
  for (const j of Array.isArray(jours) ? jours : []) {
    const jour = j && j.date
    // ⚠ LE PASSE DU CALENDRIER EST ECARTE : AirROI rend des jours deja ecoules
    // (le releve mesure ci-dessus commencait a la date du jour de capture).
    // Les garder melangerait du passe non clos a la bande du futur.
    if (!estJour(jour) || String(jour) < aujourdhui) continue
    const mois = moisDe(jour)
    if (!parMois.has(mois)) parMois.set(mois, { mesurees: 0, indispo: 0, cents: 0, sansPrix: 0 })
    const b = parMois.get(mois)
    b.mesurees++
    // ⚠ `=== false` ET NON `!j.available` : un champ ABSENT n'est pas une nuit
    // indisponible. `undefined` est faux, donc `!j.available` compterait comme
    // occupee toute nuit dont AirROI aurait omis le champ — et gonflerait la
    // bande sans que rien ne le dise.
    if (j.available !== false) continue
    b.indispo++
    const c = cents(j.rate)
    if (c === null || c <= 0) { b.sansPrix++; continue }
    b.cents += c
  }
  const out = []
  for (const [mois, b] of [...parMois.entries()].sort()) {
    out.push({
      listing_id: String(listingId),
      mois: premierJour(mois),
      nature: 'futur',
      montant_estime_cents: null,
      // ⚠ AUCUNE NUIT INDISPONIBLE N'EST UN FAIT, PAS UNE ABSENCE : le mois a
      // ete mesure, et il est vide. C'est le seul `0` legitime de ce module.
      montant_affiche_cents: b.cents,
      nuits_indisponibles: b.indispo,
      nuits_mesurees: b.mesurees,
      // Un montant PARTIEL se declare : il sous-estime, et le dire vaut mieux
      // que de rendre un chiffre dont personne ne sait qu'il est incomplet.
      motif: b.sansPrix > 0 ? `prix affiché absent sur ${b.sansPrix} nuit(s) indisponible(s)` : null,
      source: SOURCE_FUTUR
    })
  }
  return out
}

// ─── L'ORCHESTRATEUR ───────────────────────────────────────────────────────
//
// ⚠ LA DATE DU RELEVE EST CELLE DE LA CAPTURE, PAS CELLE DU PASSAGE DU CRON,
// et c'est la decision la plus importante de ce module.
//
// Le client AirROI sert son cache pendant 90 jours et **n'offre aucun moyen de
// le contourner** (`FRAICHEUR_JOURS` est fige par point d'appel,
// lib/airroi/client.js). Un cron mensuel qui daterait sa photo du JOUR DU
// PASSAGE ecrirait donc trois photos differentes portant la meme donnee, vieille
// de 0, 30 et 60 jours — et la comparaison « a delai egal » reposerait sur des
// dates fausses.
//
// On date donc la ligne par `recupereLe`, que le client rend pour une reponse
// servie du cache comme pour un appel frais. Consequence assumee, et qui doit
// etre DITE : les photos arrivent au rythme du cache (~90 jours), pas tous les
// mois. La cle d'unicite fait le reste — trois passages sur la meme capture
// ecrivent la meme ligne, donc une seule.
//
// ⚠ Rendre des photos VRAIMENT mensuelles demanderait d'ajouter une option de
// fraicheur au client AirROI (`lib/airroi/`), et de payer ~3 fois plus. C'est
// une decision de Thierry, pas la mienne : elle touche un module qu'il m'a
// demande de ne pas modifier sans le prevenir, et elle engage de l'argent.

const MARQUEUR = 'comparables_releves'

// Le mois d'un instant ISO, en UTC.
const moisDeInstant = (iso) => {
  const d = new Date(iso)
  return Number.isFinite(d.getTime())
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    : null
}
const jourDeInstant = (iso) => {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null
}

/**
 * Un passage : UN logement, et seulement s'il n'a pas deja ete releve ce
 * mois-ci.
 *
 * ⚠ UN BIEN PAR TICK, comme le pilote quotidien : le cout AirROI est reel
 * (0,10 $ par comparable et par point d'appel), et un passage qui traiterait
 * tout le parc d'un coup depasserait les garde-fous au milieu, laissant la
 * moitie du travail fait sans qu'on sache laquelle.
 *
 * @returns {skipped} ou {bien, lignes, ecrites, erreurs}
 */
async function releverSiDu (results, deps = {}) {
  const sb = deps.supabase
  const client = deps.client
  const maintenant = deps.now || (() => Date.now())
  if (!sb || !client) return { skipped: 'dependances_absentes' }
  const aujourdhui = jourDeInstant(maintenant())
  const moisCourant = moisDeInstant(maintenant())

  // ⚠ LA CADENCE SE LIT SUR LE MOIS, PAS SUR UNE DUREE EN MILLISECONDES. Un
  // `>= 30 jours` ferait deriver le releve d'un mois sur l'autre, et finirait
  // par sauter un mois une fois par an.
  // ⚠ LE MARQUEUR DE CADENCE EST INJECTE, ET C'EST UNE REGLE D'ARCHITECTURE,
  // pas un gout. `cron_logs` n'est pas une table V2 : un module de
  // `lib/marche/` n'a pas le droit de la nommer, et
  // `tests/explication-marche.test.js` le refuse. La frontiere a raison — le
  // marche calcule, le cron cadence. On recoit donc deux fonctions.
  const marqueur = deps.marqueur || {}
  if (!deps.forcer) {
    const dernier = marqueur.lire ? await marqueur.lire() : null
    if (dernier && moisDeInstant(dernier) === moisCourant) return { skipped: 'cadence' }
  }

  // Les logements qui ont des comparables actifs, le moins recemment releve
  // d'abord. ⚠ `.limit()` APRES `.select()` : l'ordre de la chaine PostgREST
  // n'est pas libre, et un modificateur pose avant leve chez le vrai client.
  const { data: retenus, error: errR } = await sb
    .from('comparables_retenus')
    .select('property_id, listing_id, user_id')
    .eq('actif', true)
    .limit(2000)
  if (errR) {
    results?.errors?.push({ context: MARQUEUR, error: errR.message })
    return { skipped: 'comparables_illisibles' }
  }
  if (!retenus || !retenus.length) return { skipped: 'aucun_comparable' }

  const parBien = new Map()
  for (const r of retenus) {
    const k = String(r.property_id)
    if (!parBien.has(k)) parBien.set(k, { property_id: k, user_id: r.user_id, listings: [] })
    parBien.get(k).listings.push(String(r.listing_id))
  }

  // Lequel traiter ? Celui dont le dernier releve est le plus ancien — ou qui
  // n'en a aucun. ⚠ On lit les releves de CE mois seulement : un bien deja fait
  // ce mois-ci ne se refait pas, meme si le marqueur global a saute.
  const { data: dejaFaits } = await sb
    .from('comparables_releves')
    .select('property_id')
    .gte('releve_le', `${moisCourant}-01`)
    .limit(5000)
  const faits = new Set((dejaFaits || []).map(x => String(x.property_id)))
  const cible = [...parBien.values()].find(b => !faits.has(b.property_id))
  if (!cible) {
    // Tout le parc est releve ce mois-ci : on pose le marqueur pour ne pas
    // relire la liste a chaque tick du reste du mois.
    if (marqueur.ecrire) await marqueur.ecrire(new Date(maintenant()).toISOString(), 0)
    return { skipped: 'tout_releve' }
  }

  const ctx = { userId: cible.user_id, propertyId: cible.property_id }
  const lignes = []
  const erreurs = []
  for (const listingId of cible.listings) {
    // ⚠ CHAQUE ANNONCE EST ISOLEE : une annonce retiree d'Airbnb rend 404, et
    // elle ne doit pas emporter les sept autres. Le passage rend ce qu'il a pu.
    try {
      const m = await client.metriquesAnnonce(listingId, ctx)
      const releveLe = jourDeInstant(m && m.recupereLe) || aujourdhui
      for (const l of lignesCloses({ listingId, mensuel: m && m.donnees && m.donnees.results, aujourdhui })) {
        lignes.push({ ...l, user_id: cible.user_id, property_id: cible.property_id, releve_le: releveLe })
      }
    } catch (e) { erreurs.push({ listingId, ou: 'mois', message: e && e.message }) }
    try {
      const c = await client.calendrierAnnonce(listingId, ctx)
      const releveLe = jourDeInstant(c && c.recupereLe) || aujourdhui
      for (const l of lignesFutures({ listingId, jours: c && c.donnees && c.donnees.results, aujourdhui })) {
        lignes.push({ ...l, user_id: cible.user_id, property_id: cible.property_id, releve_le: releveLe })
      }
    } catch (e) { erreurs.push({ listingId, ou: 'calendrier', message: e && e.message }) }
  }

  let ecrites = 0
  if (lignes.length) {
    // ⚠ `ignoreDuplicates` : une photo deja ecrite ne se reecrit pas, et son
    // refus n'est pas une erreur — c'est la regle « un releve n'ecrase jamais
    // le precedent », appliquee par la cle d'unicite.
    const { error: errI } = await sb.from('comparables_releves')
      .upsert(lignes, { onConflict: 'property_id,listing_id,mois,releve_le', ignoreDuplicates: true })
    if (errI) {
      results?.errors?.push({ context: MARQUEUR, error: errI.message })
      return { skipped: 'ecriture_refusee', erreurs }
    }
    ecrites = lignes.length
  }
  for (const e of erreurs) results?.errors?.push({ context: MARQUEUR, error: `${e.listingId} ${e.ou}: ${e.message}` })
  // ⚠ LE MARQUEUR N'EST POSE QU'APRES L'ECRITURE. Pose avant, un passage qui
  // echouerait au milieu ferait croire le mois releve, et le bien suivant
  // attendrait le mois d'apres.
  if (marqueur.ecrire) await marqueur.ecrire(new Date(maintenant()).toISOString(), ecrites)
  return { bien: cible.property_id, lignes: lignes.length, ecrites, erreurs }
}

module.exports = {
  lignesCloses,
  lignesFutures,
  releverSiDu,
  MARQUEUR,
  // Pour les tests : la geometrie du calendrier, plutot que de la recopier.
  _interne: { joursDuMois, moisPrecedent, moisDe, premierJour, cents, PROFONDEUR_MOIS, SOURCE_CLOS, SOURCE_FUTUR }
}
