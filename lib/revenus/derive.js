/* ============================================================================
   LES COLONNES DERIVEES D'UNE RESERVATION — architecture decidee par Thierry
   le 27 octobre 2026.

   Le bloc « Revenus nets » lisait `bookings_snapshot.raw` — le payload provider
   INTEGRAL — a chaque ouverture de l'accueil. Mesure du depot pour cette
   lecture exacte : 3,8 Mo et 569-961 ms (docs/kb/performance.md). Le payload
   n'est plus lu qu'UNE FOIS : ici, au moment ou la reservation est ecrite.

   ⚠ CETTE FONCTION EST PURE, ET C'EST TOUT SON INTERET. Elle ne lit aucune
   base, n'appelle aucune horloge, ne journalise rien. Elle prend ce que le
   writer a sous la main et rend dix valeurs. Un calcul d'argent qui ne peut
   etre eprouve qu'en production n'est pas eprouve.

   ⚠ ET ELLE NE CALCULE RIEN ELLE-MEME : elle COMPOSE les regles qui existent.
     · `lib/revenus/net-hote.js`      ce que l'hote touche, net ou brut marque ;
     · `lib/revenus/versement.js`     a quelle DATE, par canal ;
     · `lib/yield/eclatement.js`      le prix voyageur et la date de VENTE ;
     · `lib/bookings-snapshot-status.js`  le statut canonique.
   Une cinquieme implementation du prix voyageur serait la dette 17 rouverte —
   « l'ecran et le moteur passent par la meme assemblee ».

   ⚠ POURQUOI UN NUMERO DE VERSION. `VERSION` change des que le CALCUL change —
   pas quand les delais changent (le trigger SQL s'en charge). Sans ce numero,
   un correctif de regle ne rattraperait que les reservations ecrites APRES lui,
   et les anciennes garderaient un chiffre faux pour toujours. Le rattrapage
   nocturne reprend toute ligne d'une version anterieure.
   ========================================================================== */

const { netDuSejour } = require('./net-hote')
const { dateDeVersement, canalNormalise } = require('./versement')
const { dateDeVente } = require('../yield/eclatement')
const { readStatus } = require('../bookings-snapshot-status')

// ⚠ A INCREMENTER QUAND LA REGLE DE CALCUL CHANGE, et a ne PAS toucher quand
// seuls les delais bougent. Un numero qu'on incremente « au cas ou » fait
// recalculer 1 436 lignes chaque nuit pour rien.
const VERSION = 1

// Les dix colonnes, nommees une seule fois. Le writer, le script de
// remplissage, le rattrapage et les tests lisent TOUS cette liste : une colonne
// ajoutee ici arrive partout, et une colonne oubliee quelque part ne peut pas
// se produire.
const COLONNES = [
  'property_uuid', 'canal', 'statut_canonique', 'montant_net_cents',
  'montant_est_brut', 'commission_cents', 'date_versement',
  'motif_non_calculable', 'derive_le', 'derive_version'
]

const centimes = (euros) =>
  (Number.isFinite(euros) ? Math.round(euros * 100) : null)

/**
 * Les dix colonnes derivees d'une reservation.
 *
 * @param snapshot  le snapshot normalise
 * @param raw       le payload provider integral (peut etre absent)
 * @param options   { delais, uuidDuBien, provider, maintenant }
 *   `delais`      la table de `delais_versement`, via `tableDesDelais` ;
 *   `uuidDuBien`  l'UUID resolu depuis la cle provider, ou `null` ;
 *   `provider`    le provider par defaut, pour les lignes anterieures a
 *                 l'unification qui ne portent pas ce champ ;
 *   `maintenant`  l'instant a inscrire dans `derive_le`. ⚠ INJECTE : une
 *                 fonction pure n'appelle pas l'horloge, et un test qui ne peut
 *                 pas figer le temps ne peut pas comparer deux executions.
 */
function deriverRevenus (snapshot, raw, options = {}) {
  const { delais = {}, uuidDuBien = null, provider = null, maintenant = null } = options
  const s = snapshot || {}

  // ⚠ LES COLONNES SONT POSEES POUR TOUS LES STATUTS, y compris les annulees,
  // et c'est une decision. L'agregat SQL ne prend que `confirmed` — mais
  // l'information existe alors en base, gratuitement, pour le jour ou l'on
  // saura compter les annulations payees. Mesure du 27 octobre 2026 : rien dans
  // le payload ne distingue « ce que l'hote a garde » de « le prix initial du
  // sejour qui n'a pas eu lieu ». `Listing Cancellation Host Fee` ne le dit pas
  // — c'est la COMMISSION Airbnb, lisible sur 33/33 lignes, confirmees
  // comprises (docs/kb/prix-voyageur.md). Deriver sans compter ne coute rien ;
  // compter sans savoir porterait au total le prix entier d'un sejour annule.
  const statut = readStatus(s, provider)

  const montant = netDuSejour(s, raw, provider)

  // ⚠ LA DATE DE VENTE EST QUALIFIEE AVANT D'ETRE UTILISEE. Le canal direct se
  // verse « reservation + N jours », et une reservation IMPORTEE porte dans
  // `raw.inserted_at` la date de MIGRATION, pas sa date de vente — mesure du
  // depot, 11 jours de delai apparent contre 2 pour les natives.
  const vente = dateDeVente(s, raw, provider)

  const quand = dateDeVersement({
    canal: s.source,
    arrivee: s.arrival,
    depart: s.departure,
    reserve_le: vente.valeur,
    reserve_le_fiable: vente.fiable === false ? false : undefined,
    versement_stripe: s.versement_stripe || (raw && raw.versement_stripe) || null
  }, delais)

  // ⚠ UN SEUL MOTIF, ET C'EST CELUI QUI BLOQUE LE PLUS TOT. Deux colonnes
  // peuvent manquer pour deux raisons differentes ; la colonne `motif` est
  // unique. On garde donc celui du MONTANT en priorite : sans montant, la date
  // ne sert a rien, alors qu'un montant sans date reste une information
  // (l'ecran la compte « sans date de versement »).
  const motif = montant.motif || quand.motif || null

  return {
    property_uuid: uuidDuBien || null,
    // Le canal NORMALISE, par la seule table d'orthographes du domaine
    // (`abb`, `bdc`, `Offline`, `bookingcom`...). Le stocker BRUT obligerait
    // l'agregat SQL a normaliser — donc a reecrire une regle JS en SQL, et a
    // la laisser deriver au premier canal ajoute.
    //
    // ⚠ MA PREMIERE VERSION LISAIT `montant.canal_normalise`, UN CHAMP QUI
    // N'EXISTE PAS. `netDuSejour` ne le rend pas : mesure faite avant de
    // laisser la ligne. La branche etait donc morte et le repli faisait tout
    // le travail — un `||` qui cache que son premier terme ne vaut jamais rien.
    // C'est le troisieme code mort deguise de ce chantier, et il se trouve
    // toujours de la meme facon : en verifiant que le champ lu existe.
    canal: canalNormalise(s.source),
    statut_canonique: statut || null,
    montant_net_cents: centimes(montant.valeur),
    // ⚠ `null` ET NON `false` QUAND LE MONTANT MANQUE : « on ne sait pas si
    // c'est un brut » n'est pas « ce n'est pas un brut ». Un `false` ferait
    // compter la ligne comme un net parfaitement connu.
    montant_est_brut: montant.valeur == null ? null : montant.net === false,
    commission_cents: centimes(montant.commission),
    date_versement: quand.jour || null,
    motif_non_calculable: motif,
    derive_le: maintenant || null,
    derive_version: VERSION
  }
}

/**
 * Cette ligne a-t-elle besoin d'etre (re)derivee ?
 *
 * ⚠ TROIS CAS, ET LE TROISIEME EST CELUI QU'ON OUBLIE :
 *   · jamais derivee (`derive_le` nul) ;
 *   · INVALIDEE par le trigger SQL quand un delai a change (il met `derive_le`
 *     a nul sans effacer les valeurs — l'ecran continue d'afficher un chiffre
 *     d'un jour, jamais un trou) ;
 *   · derivee par une VERSION ANTERIEURE de la regle de calcul.
 */
function aDeriver (ligne) {
  if (!ligne) return false
  if (ligne.derive_le == null) return true
  const v = Number(ligne.derive_version)
  return !Number.isInteger(v) || v < VERSION
}

module.exports = { deriverRevenus, aDeriver, COLONNES, VERSION }
