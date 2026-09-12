// lib/yield/eclatement.js
// DOC : docs/kb/eclatement-yield.md (modif = MEME COMMIT)
// Spec : docs/specs/spec-yieldflow-v1.md §6 (etape 3, lot 3.1)
//
// LECTURE SEULE, FONCTIONS PURES. Aucune base, aucun reseau, aucun provider :
// on recoit des lignes de `bookings_snapshot` deja lues et on rend des nuits.
// C'est ce qui permet de les eprouver sur les pieces reelles.
//
// LE SOCLE DE TOUT LE MOTEUR. Chaque indicateur de l'etape 3 — CA, RevPAR,
// nuitees, prix moyen, delai — se calcule sur ces nuits. Une erreur ici les
// fausse tous, du meme facteur, sans qu'aucun ne paraisse aberrant.

const { nuitsDuSejour } = require('../price-log')
const { STATUS, readStatus } = require('../bookings-snapshot-status')

// ⚠ LISTE BLANCHE, JAMAIS LISTE NOIRE (spec §6).
// `status !== 'cancelled'` ferait entrer `blocked`, `request` et `demapped`
// dans les ventes. Seul `confirmed` occupe le logement et produit du CA.
const STATUTS_COMPTES = [STATUS.CONFIRMED]

// Au-dela, un sejour releve de la location au mois : son prix par nuit n'est
// pas comparable a celui d'un court sejour, et il ecraserait les moyennes.
const SEUIL_LONG_SEJOUR = 24

// ─── Prix paye par le VOYAGEUR ──────────────────────────────────────────────
// Regles etablies a l'etape 0 et gravees au §9 de la spec, verifiees sur
// 1 463 payloads reels. Ne JAMAIS lire `snapshot.amount` directement : sur le
// canal Airbnb de Channex il porte un NET HOTE, 22,85 % sous le prix voyageur.
function prixVoyageur (snapshot, raw, defaultProvider = null) {
  const s = snapshot || {}
  const r = raw || {}
  const canal = String(s.source || '').trim().toLowerCase()
  // ⚠ `provider` PEUT MANQUER sur les lignes ecrites avant l'unification.
  // `defaultProvider` est le meme contrat que `readStatus` : l'appelant qui
  // connait la source la passe, sinon on lit le snapshot.
  const provider = String(s.provider || defaultProvider || '').toLowerCase()
  const nombre = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null }

  if (provider === 'beds24') {
    const p = nombre(r.price)
    if (p != null) return { valeur: p, source: 'beds24.price' }
    // ⚠ REPLI SUR LA SOMME DES CHARGES, POUR LES SAISIES DIRECTES.
    // La spec §9 le prevoit et le writer l'implemente deja
    // (`montantBeds24` : « les 5 replis observes sont tous direct »). Sans lui,
    // 5 reservations reelles perdent leur CA alors que le montant est la.
    // La condition porte sur la source ET sur la commission, jamais sur la
    // seule commission : une resa OTA dont Beds24 remet price et commission a
    // zero ferait sinon entrer un NET HOTE dans un champ « total voyageur ».
    if (canal === 'direct' && !(Number(r.commission) > 0)) {
      const charges = (r.invoiceItems || [])
        .filter(i => i && i.type === 'charge')
        .reduce((somme, i) => somme + (Number(i.lineTotal) || 0), 0)
      if (charges > 0) return { valeur: charges, source: 'beds24.charges (saisie directe)' }
    }
    return { valeur: null, source: 'beds24.price', raison: 'price nul et aucun repli' }
  }

  if (provider === 'channex') {
    if (canal === 'airbnb') {
      // ⚠ LE DISCRIMINANT EST `meta.amount_type`, PAS LE NOM DU CANAL.
      // « Payout Amount » est un reglage que HoteSmart pose a la connexion
      // (`booking_amount_settings`) : un canal repris ailleurs peut servir un
      // `amount` deja brut, et y ajouter la retenue rendrait ~23 % AU-DESSUS
      // du prix paye. On refuse plutot que de supposer.
      if (r.meta?.amount_type !== 'Payout Amount') {
        return { valeur: null, source: 'channex.airbnb', raison: `amount_type inattendu : ${r.meta?.amount_type || 'absent'}` }
      }
      // ⚠ LE HOST FEE EST VALIDE, PAS SEULEMENT CAPTURE.
      // `[\d.]+` accepte « 1.2.3 » ou « . » : `Number()` rend alors NaN, et
      // NaN n'est pas `null` — le chemin « prix calculable » etait pris, chaque
      // nuit valait NaN, et UNE SEULE ligne de ce type rendait NaN le CA du
      // mois et toute somme en aval. Un NaN ne se voit pas : il se propage.
      // ⚠ ANCREE SUR LA FIN DE LIGNE, sinon elle TRONQUE au lieu de refuser :
      // sur « 1.2.3 » une regex non ancree capture « 1.2 » et rend un prix
      // credible mais faux. Les notes Airbnb portent une valeur par ligne.
      const m = /Listing Cancellation Host Fee: *(\d+(?:\.\d+)?) *(?:\r?\n|$)/.exec(r.notes || '')
      const a = nombre(r.amount)
      const frais = m ? Number(m[1]) : null
      if (a == null) return { valeur: null, source: 'channex.airbnb', raison: 'amount nul ou absent' }
      if (frais == null || !Number.isFinite(frais) || frais < 0) {
        return { valeur: null, source: 'channex.airbnb', raison: 'Host Fee illisible dans notes' }
      }
      const total = a + frais
      if (!Number.isFinite(total) || total <= 0) {
        return { valeur: null, source: 'channex.airbnb', raison: 'total non fini' }
      }
      return { valeur: total, source: 'channex.airbnb (amount + Host Fee)' }
    }
    if (canal === 'bookingcom' || canal === 'booking.com') {
      // Somme sur TOUTES les chambres : `amount` couvre la reservation entiere.
      // ⚠ UNE SOMME PARTIELLE N'EST PAS UN PRIX.
      // Sauter une chambre dont le `guest_view` est illisible rendait un total
      // AMPUTE d'une chambre entiere, etiquete comme valide. « On refuse
      // plutot que de supposer » vaut aussi ici.
      const chambres = r.rooms || []
      if (!chambres.length) {
        return { valeur: null, source: 'channex.booking', raison: 'aucune chambre' }
      }
      let total = 0
      for (const ro of chambres) {
        const gv = ro?.meta?.price_details?.guest_view?.total
        const brut = gv ? Number(gv.amount) : null
        if (!Number.isFinite(brut)) {
          return { valeur: null, source: 'channex.booking', raison: 'guest_view illisible sur une chambre' }
        }
        total += brut / Math.pow(10, gv.decimal_places ?? 2)
      }
      return total > 0
        ? { valeur: total, source: 'channex.booking (guest_view.total)' }
        : { valeur: null, source: 'channex.booking', raison: 'total nul' }
    }
    // Offline : ecrit par HoteSmart lui-meme (primitive CRS), brut par
    // construction. SEUL ce canal retombe sur `amount`.
    if (canal === 'offline') {
      const a = nombre(r.amount)
      return a == null
        ? { valeur: null, source: 'channex.offline', raison: 'amount nul ou absent' }
        : { valeur: a, source: 'channex.offline (amount)' }
    }
    // ⚠ AUCUN REPLI SILENCIEUX SUR `amount` — spec §9, regle 2.
    // La branche « offline » etait un attrape-tout : n'importe quel `ota_name`
    // inconnu (Expedia, VRBO…) y prenait `amount` pour un prix voyageur. Si ce
    // canal sert un net hote, c'est ~23 % sous le prix paye, SANS SIGNAL.
    // Un couple (provider, canal) non prevu doit echouer BRUYAMMENT.
    return { valeur: null, source: 'channex.canal_inconnu', raison: `canal non prevu : ${s.source}` }
  }

  return { valeur: null, source: 'provider inconnu', raison: String(provider) }
}

// ─── Date de VENTE, en JOURS ────────────────────────────────────────────────
// ⚠ EN JOURS, JAMAIS EN INSTANTS (spec §9.3, lecon de l'etape 0).
// `bookingTime` porte une heure, `arrival` est un jour nu : comparer les deux
// comme des instants declarait « posterieures a l'arrivee » les 162 ventes
// faites le matin meme — le delai 0, soit 11 % de l'historique, et precisement
// ce que la courbe de pickup existe pour mesurer.
function dateDeVente (snapshot, raw, defaultProvider = null) {
  const s = snapshot || {}
  const r = raw || {}
  const jour = (v) => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null)
  // ⚠ MEME CONTRAT QUE `readStatus` : une ligne ecrite avant l'unification ne
  // porte AUCUN champ `provider`. Sans ce repli, elle tombait dans la branche
  // Channex, rendait « inserted_at absent » — et perdait sa date de vente
  // alors que `raw.bookingTime` etait la.
  const provider = String(s.provider || defaultProvider || '').toLowerCase()

  if (provider === 'beds24') {
    const j = jour(r.bookingTime)
    if (!j) return { valeur: null, fiable: false, raison: 'bookingTime absent' }
    // Vendu APRES le jour d'arrivee : donnee corrompue, pas un delai 0.
    if (s.arrival && j > s.arrival) {
      return { valeur: j, fiable: false, raison: 'posterieure a l arrivee' }
    }
    return { valeur: j, fiable: true, source: 'beds24.bookingTime' }
  }

  const j = jour(r.inserted_at)
  if (!j) return { valeur: null, fiable: false, raison: 'inserted_at absent' }
  // ⚠ UNE RESERVATION IMPORTEE PORTE LA DATE DE MIGRATION, PAS DE VENTE.
  // Mesure : 11 jours de delai apparent pour les importees contre 2 pour les
  // natives. Le pont `demapped` (plus bas) rend la vraie date quand elle existe.
  if (r.meta?.is_imported === true) {
    return { valeur: j, fiable: false, raison: 'importee : date de migration', source: 'channex.inserted_at' }
  }
  return { valeur: j, fiable: true, source: 'channex.inserted_at' }
}

// ─── Pont `demapped` → date de vente reelle ─────────────────────────────────
// Une reservation reprise par la migration existe en DEUX exemplaires : la
// Beds24 `demapped` (qui porte le vrai `bookingTime`) et la Channex
// `confirmed` (qui est comptee, mais dont `inserted_at` vaut la migration).
// On ne compte JAMAIS la demappee : on lui emprunte sa seule date.
//
// ⚠ DEUX GARDES, exigees par la spec §6 :
//   - MEME BIEN en plus du meme code OTA ;
//   - REFUS si plus de deux lignes partagent le code — au-dela, on ne sait plus
//     laquelle est la jumelle de laquelle, et apparier au hasard donnerait une
//     date de vente fausse a une vraie reservation.
function construirePontDemapped (lignes, defaultProvider = null) {
  const parCle = new Map()
  for (const l of lignes || []) {
    const s = l.snapshot || {}
    const code = s.otaReservationCode
    if (!code) continue
    // ⚠ LA CLE PORTE LE COMPTE. `provider_property_id` n'a AUCUNE unicite
    // globale — deux hotes d'un meme property manager partagent l'espace de
    // numerotation (regle gravee dans `lib/nuits-occupees.js`). Sans le compte,
    // deux hotes melangent leurs lignes dans un meme groupe : appariement
    // croise, ou groupe de 3+ qui fait perdre un pont valide.
    const cle = `${l.user_id}|${l.property_id}|${code}`
    if (!parCle.has(cle)) parCle.set(cle, [])
    parCle.get(cle).push(l)
  }
  const pont = new Map()
  const refus = []
  for (const [cle, groupe] of parCle) {
    if (groupe.length < 2) continue
    if (groupe.length > 2) { refus.push({ cle, lignes: groupe.length }); continue }
    const dem = groupe.find(l => readStatus(l.snapshot || {}, defaultProvider) === STATUS.DEMAPPED)
    const vive = groupe.find(l => readStatus(l.snapshot || {}, defaultProvider) === STATUS.CONFIRMED)
    if (!dem || !vive) continue
    const dv = dateDeVente(dem.snapshot, dem.raw, defaultProvider)
    if (!dv.fiable || !dv.valeur) continue
    pont.set(`${vive.user_id}|${vive.booking_id}`, { date: dv.valeur, depuis: dem.booking_id })
  }
  return { pont, refus }
}

// ─── Eclatement ─────────────────────────────────────────────────────────────
/**
 * Rend les NUITS d'une reservation, avec leur part de prix.
 *
 * ⚠ REPARTITION UNIFORME, DECISION DE THIERRY DU 12 SEPTEMBRE 2026.
 * Channex fournit un detail par nuit (`days_breakdown`, parfois inegal :
 * 85,04 / 85,04 / 85,03) ; Beds24 non. L'utiliser creerait deux precisions
 * selon le provider — la meme question aurait deux reponses. On repartit donc
 * uniformement partout : l'homogeneite vaut plus que ces centimes dans un
 * moteur qui compare des annees entre elles.
 * CONSEQUENCE ASSUMEE : le differentiel week-end/semaine REELLEMENT paye est
 * lisse dans le realise. Le signal prix-par-nuit non lisse vit dans
 * `price_display_log`, pas ici. Voir docs/kb/eclatement-yield.md.
 */
function eclater (ligne, options = {}) {
  const { joursExclus = null, pont = null, defaultProvider = null } = options
  const s = ligne?.snapshot || {}
  const raw = ligne?.raw || {}
  // ⚠ LE STATUT SE LIT PAR `readStatus`, JAMAIS EN BRUT.
  // Regle gravee dans `lib/nuits-occupees.js`. Les lignes ecrites AVANT
  // l'unification portent le vocabulaire BRUT du provider : un snapshot Beds24
  // `status: 'new'` — qui signifie CONFIRME — etait ecarte comme « hors liste
  // blanche », et la reservation disparaissait du CA ET des nuitees, sans la
  // moindre erreur.
  const statutCanonique = readStatus(s, options.defaultProvider)

  const base = {
    booking_id: ligne?.booking_id ?? null,
    property_id: ligne?.property_id ?? null,
    statut: statutCanonique,
    provider: s.provider ?? null,
    canal: s.source ?? null,
    compte: STATUTS_COMPTES.includes(statutCanonique),
    nuits: [],
    prix_total: null,
    prix_par_nuit: null,
    long_sejour: false,
    // Voyageurs du sejour, pour l'occupation EN PERSONNES (lot 3.2).
    // `null` quand le provider ne les sert pas : une occupation en personnes
    // calculee sur des zeros serait fausse et credible.
    personnes: personnesDuSejour(s),
    date_vente: null,
    date_vente_fiable: false,
    ecarte: null
  }

  // Liste blanche : tout ce qui n'est pas `confirmed` est rendu SANS nuits,
  // avec sa raison — jamais supprime en silence.
  if (!base.compte) {
    return { ...base, ecarte: `statut ${statutCanonique} hors liste blanche` }
  }

  const nuits = nuitsDuSejour(s.arrival, s.departure)
  if (!nuits.length) return { ...base, ecarte: 'sejour sans nuit (dates absentes ou inversees)' }

  const pv = prixVoyageur(s, raw, defaultProvider)
  if (pv.valeur == null) {
    // On rend les nuits QUAND MEME : une nuit sans prix reste une nuitee
    // occupee, elle compte au taux d'occupation. Seul le CA l'ignore.
    return {
      ...base,
      nuits: nuits.map(d => ({ date: d, prix: null, hors_reference: estExclue(d, joursExclus) })),
      ecarte: `prix non calculable : ${pv.raison || pv.source}`,
      long_sejour: nuits.length > SEUIL_LONG_SEJOUR,
      ...dateVenteFinale(ligne, s, raw, pont, defaultProvider)
    }
  }

  const parNuit = pv.valeur / nuits.length
  return {
    ...base,
    nuits: nuits.map(d => ({ date: d, prix: parNuit, hors_reference: estExclue(d, joursExclus) })),
    prix_total: pv.valeur,
    prix_par_nuit: parNuit,
    source_prix: pv.source,
    // ⚠ MARQUE, PAS TRAITE A PART ICI. Le prorata mensuel est une regle
    // d'AGREGATION (`ventilationMensuelle`), pas d'eclatement : les nuits
    // restent les nuits. Marquer permet aux moyennes de les ecarter.
    long_sejour: nuits.length > SEUIL_LONG_SEJOUR,
    ...dateVenteFinale(ligne, s, raw, pont, defaultProvider)
  }
}

// ⚠ MARQUEES, PAS SUPPRIMEES (exigence de Thierry).
// Une nuit hors reference reste une nuit vendue : elle compte au realise, et
// n'est ecartee que du calcul de la REFERENCE. La supprimer ici la retirerait
// aussi du CA reel, ce qui serait faux.
// ⚠ `null` PLUTOT QUE ZERO quand le provider ne sert rien.
// `numAdult` absent vaut `undefined`, pas 0 : compter 0 personne sur une nuit
// occupee tirerait l'occupation en personnes vers le bas sans qu'aucun chiffre
// ne paraisse faux. L'agregation compte alors ces nuits a part.
function personnesDuSejour (snapshot) {
  const a = Number(snapshot?.numAdult)
  const e = Number(snapshot?.numChild)
  const total = (Number.isFinite(a) ? a : 0) + (Number.isFinite(e) ? e : 0)
  return total > 0 ? total : null
}

function estExclue (jour, joursExclus) {
  if (!joursExclus) return false
  return joursExclus.has ? joursExclus.has(jour) : !!joursExclus[jour]
}

function dateVenteFinale (ligne, s, raw, pont, defaultProvider = null) {
  const cle = `${ligne?.user_id}|${ligne?.booking_id}`
  const emprunt = pont && pont.get ? pont.get(cle) : null
  if (emprunt) {
    return { date_vente: emprunt.date, date_vente_fiable: true, date_vente_source: `pont demapped (${emprunt.depuis})` }
  }
  const dv = dateDeVente(s, raw, defaultProvider)
  return { date_vente: dv.valeur, date_vente_fiable: dv.fiable, date_vente_source: dv.source || dv.raison }
}

// ─── Prorata mensuel des longs sejours ──────────────────────────────────────
// ⚠ REGLE DE CALCUL, PAS DE STOCKAGE (spec §5).
// Un sejour de deux mois ne doit pas verser tout son CA au mois de son
// arrivee : chaque mois recoit la part qui lui revient, au prorata de SES
// nuits. Avec une repartition uniforme, cela revient a sommer les nuits du
// mois — ce qui est exactement ce que fait cette fonction, et c'est voulu :
// une seule regle, verifiable.
function ventilationMensuelle (eclatement) {
  const parMois = new Map()
  for (const n of eclatement?.nuits || []) {
    const mois = String(n.date).slice(0, 7)
    const e = parMois.get(mois) || { mois, nuits: 0, nuits_avec_prix: 0, prix: 0, nuits_hors_reference: 0 }
    e.nuits++
    // ⚠ `nuits_avec_prix` EST INDISPENSABLE, pas decoratif.
    // 79 reservations Beds24 reelles ont `price = 0` : leurs nuits comptent au
    // taux d'occupation, jamais au CA. Sans ce compteur, `prix ÷ nuits` rend
    // exactement le prix moyen biaise vers le bas que le KB interdit — et
    // l'agregat ne donnait AUCUN moyen de s'en garder.
    if (n.prix != null && Number.isFinite(n.prix)) { e.prix += n.prix; e.nuits_avec_prix++ }
    if (n.hors_reference) e.nuits_hors_reference++
    parMois.set(mois, e)
  }
  return [...parMois.values()].sort((a, b) => a.mois.localeCompare(b.mois))
}

module.exports = {
  STATUTS_COMPTES,
  personnesDuSejour,
  SEUIL_LONG_SEJOUR,
  prixVoyageur,
  dateDeVente,
  construirePontDemapped,
  eclater,
  ventilationMensuelle
}
