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
// ⚠ AIRROI DATE SES MOIS EN `YYYY-MM`, PAS `YYYY-MM-DD`, et ma premiere version
// exigeait un jour complet : sur la vraie reponse, `lignesCloses` rendait ZERO
// ligne — en silence, par un `continue`. La bande du realise n'aurait jamais
// existe, et aucun de mes onze tests ne le voyait parce que MA PROPRE FIXTURE
// inventait `${mois}-01`, une forme que le provider ne rend pas.
// Mesure sur `tests/fixtures/airroi/labulle-60.json` : 26 mois fournis, 0 ligne.
// Le depot portait deja la preuve du bon format — `lib/marche/grille-marche.js`
// lit les MEMES lignes avec `String(d).slice(0, 7)`.
// On accepte donc les deux formes, et on ne devine rien d'autre.
const moisDe = (d) => {
  const v = String(d == null ? '' : d)
  if (estMois(v)) return v
  return estJour(v) ? v.slice(0, 7) : null
}
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
function lignesFutures ({ listingId, jours, aujourdhui, releveLe }) {
  // ⚠ LA FENETRE SE DECOUPE SUR LA DATE DE LA CAPTURE, PAS SUR CELLE DU CRON.
  // La ligne est DATEE par `releve_le` (la capture, parfois vieille de 90 jours
  // a cause du cache AirROI) : la decouper sur `aujourdhui` ferait une ligne qui
  // dit « relevee le 5 octobre » et mesure a partir du 28. Deux passages sur la
  // MEME capture produiraient alors des lignes differentes sous la MEME cle
  // d'unicite, et `ignoreDuplicates` garderait silencieusement la premiere —
  // impossible de savoir laquelle est en base.
  const borne = estJour(releveLe) ? releveLe : aujourdhui
  if (!estJour(borne)) return []
  const parMois = new Map()
  for (const j of Array.isArray(jours) ? jours : []) {
    const jour = j && j.date
    // ⚠ LE PASSE DU CALENDRIER EST ECARTE : AirROI rend des jours deja ecoules
    // (le releve mesure ci-dessus commencait a la date du jour de capture).
    // Les garder melangerait du passe non clos a la bande du futur.
    if (!estJour(jour) || String(jour) < borne) continue
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
      // ⚠ UNE COUVERTURE PARTIELLE EST UN MOTIF, et elle manquait. Le
      // calendrier commence a la date de capture et porte ~360 jours : son
      // PREMIER mois et son DERNIER sont tronques. Mesure sur le calendrier
      // reel : octobre couvert sur 4 nuits sur 31, ecrit avec `motif: null`,
      // donc trace a cote d'une courbe qui porte le mois entier — l'hote lit
      // « mes comparables font dix fois moins que moi ».
      motif: [
        b.mesurees < joursDuMois(mois) ? `mois couvert sur ${b.mesurees} nuit(s) sur ${joursDuMois(mois)}` : null,
        b.sansPrix > 0 ? `prix affiché absent sur ${b.sansPrix} nuit(s) indisponible(s)` : null
      ].filter(Boolean).join(' ; ') || null,
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
// La borne de lecture des comparables actifs du parc. Au-dela, on refuse
// plutot que de travailler sur une liste tronquee.
const RETENUS_MAX = 2000

// Le mois d'un instant ISO, en UTC.
// ⚠ LE JOUR ET LE MOIS SE LISENT A PARIS, PAS EN UTC, et c'est le meme fuseau
// que celui de l'ecran (`jourDeParis()` dans `api/ecran/revenus-annee.js`).
// En UTC, le 1er d'un mois entre 00 h et 02 h heure de Paris, le writer croit
// le mois precedent encore courant : le mois qui vient de clore n'est pas
// capture, et le marqueur est pose sur l'ancien mois. C'est la classe deja
// nommee au registre — « meme FUSEAU que le code mesure ».
const AParis = (iso) => {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  // `en-CA` rend « YYYY-MM-DD », et `timeZone` fait le decalage saisonnier.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d)
}
const moisDeInstant = (iso) => { const j = AParis(iso); return j ? j.slice(0, 7) : null }
const jourDeInstant = (iso) => AParis(iso)

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
  // ⚠ UNE FABRIQUE OU UNE INSTANCE : le cron passe une fabrique pour ne pas
  // construire un client AirROI a chacun de ses 288 ticks quotidiens.
  const faireClient = typeof deps.client === 'function' ? deps.client : () => deps.client
  const maintenant = deps.now || (() => Date.now())
  if (!sb || !deps.client) return { skipped: 'dependances_absentes' }
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

  // Les logements qui ont des comparables actifs.
  // ⚠ J'AVAIS ECRIT « le moins recemment releve d'abord » : il n'y a AUCUN
  // `order` ici, et `comparables_retenus` ne porte pas de date de releve.
  // C'etait l'ordre rendu par PostgreSQL, et c'est ce qui cachait le constat
  // n°2. L'ordre n'a plus d'importance depuis que le filtre « deja fait ce
  // mois-ci » ecarte les biens traites : le premier NON FAIT est pris.
  // ⚠ `.limit()` APRES `.select()` : l'ordre de la chaine PostgREST n'est pas
  // libre, et un modificateur pose avant leve chez le vrai client.
  const { data: retenus, error: errR } = await sb
    .from('comparables_retenus')
    .select('property_id, listing_id, user_id')
    .eq('actif', true)
    .limit(RETENUS_MAX + 1)
  if (errR) {
    results?.errors?.push({ context: MARQUEUR, error: errR.message })
    return { skipped: 'comparables_illisibles' }
  }
  if (!retenus || !retenus.length) return { skipped: 'aucun_comparable' }
  // ⚠ UNE TRONCATURE NE PASSE PAS EN SILENCE. On demande UN de plus que la
  // borne : si on le recoit, il en existe au moins un autre, et le parc n'est
  // plus entier — donc le choix du bien a relever ne peut plus etre affirme.
  // Meme geste que `BIENS_MAX + 1` dans l'endpoint, a cote.
  if (retenus.length > RETENUS_MAX) {
    results?.errors?.push({
      context: MARQUEUR,
      error: `plus de ${RETENUS_MAX} comparables actifs : la liste est tronquee, aucun releve`
    })
    return { skipped: 'liste_tronquee' }
  }

  const parBien = new Map()
  for (const r of retenus) {
    const k = String(r.property_id)
    if (!parBien.has(k)) parBien.set(k, { property_id: k, user_id: r.user_id, listings: [] })
    parBien.get(k).listings.push(String(r.listing_id))
  }

  // ⚠ LA CADENCE EST PAR BIEN, ET NON GLOBALE — c'est le constat n°2 de la
  // review, MESURE : avec un verrou mensuel global, le premier bien traite
  // posait le marqueur, tous les ticks suivants du mois rendaient
  // `skipped: 'cadence'`, et le mois d'avant n'etant plus dans la fenetre, le
  // MEME bien repassait en tete. Sur 3 biens et 7 passages etales sur 5 mois :
  // un seul bien releve, les deux autres JAMAIS. La pastille d'un bien sur
  // deux n'aurait montre aucune bande, en silence.
  //
  // ⚠ ET LE TEMOIN EST LA DATE D'ECRITURE (`created_at`), PAS `releve_le`.
  // `releve_le` est la date de la CAPTURE AirROI, qui peut avoir 90 jours a
  // cause du cache : un bien releve aujourd'hui depuis une capture de juillet
  // n'apparaissait donc jamais comme « fait ce mois-ci », et il repassait a
  // chaque tick pendant que les autres attendaient.
  const { data: dejaFaits, error: errF } = await sb
    .from('comparables_releves')
    .select('property_id')
    .gte('created_at', `${moisCourant}-01T00:00:00Z`)
    .limit(20000)
  if (errF) {
    results?.errors?.push({ context: MARQUEUR, error: errF.message })
    return { skipped: 'releves_illisibles' }
  }
  const faits = new Set((dejaFaits || []).map(x => String(x.property_id)))
  const cible = [...parBien.values()].find(b => !faits.has(b.property_id))
  if (!cible) {
    // Tout le parc est releve ce mois-ci. Le marqueur evite de relire la liste
    // a chaque tick du reste du mois — c'est son SEUL role desormais.
    if (marqueur.ecrire) await marqueur.ecrire(new Date(maintenant()).toISOString(), 0)
    return { skipped: 'tout_releve' }
  }
  // ⚠ LE MARQUEUR GLOBAL NE BLOQUE PLUS RIEN, il n'est qu'un raccourci : s'il
  // dit « ce mois-ci » ET que le parc est effectivement fait, on sort au-dessus.
  // On ne s'y fie jamais seul.

  const ctx = { userId: cible.user_id, propertyId: cible.property_id }
  const client = faireClient()
  const lignes = []
  const erreurs = []

  // ⚠ LE BUDGET SE JUGE AVANT DE PAYER, PAS AU MILIEU. Le plafond par bien
  // (5 $ sur 90 jours) est PARTAGE avec l'etude de marche, qui coute deja
  // « 3,50 a 4,50 $ par bien » (lib/airroi/cout.js). Ce lot ajoute deux points
  // d'appel par comparable : 8 comparables = 1,60 $. Sur un bien qui vient
  // d'etre etudie, le refus tombe DANS la boucle — et comme chaque annonce est
  // isolee par son try/catch, le passage ecrivait les comparables d'avant le
  // refus, posait le marqueur, et le mois passait pour releve. Le min/max
  // reposait alors sur 2 comparables sur 8, sans que rien ne le dise.
  // Le client expose `estimer` et `marge` exactement pour cela.
  try {
    if (typeof client.estimer === 'function' && typeof client.marge === 'function') {
      const appels = cible.listings.flatMap(id => ([
        { endpoint: 'GET /listings/metrics/all', params: { listing_id: String(id), num_months: 60, currency: 'native' } },
        { endpoint: 'GET /listings/live/calendar', params: { listing_id: String(id), currency: 'native' } }
      ]))
      const [cout, marge] = await Promise.all([client.estimer(appels), client.marge(ctx)])
      if (cout > marge) {
        results?.errors?.push({
          context: MARQUEUR,
          error: `releve de ${cible.property_id} reporte : ${cout.toFixed(2)} $ pour ${marge.toFixed(2)} $ disponibles`
        })
        // ⚠ AUCUN MARQUEUR : le mois n'est pas releve, il est REPORTE. Le poser
        // ferait attendre le mois suivant pour un bien qu'on n'a pas touche.
        return { skipped: 'budget_insuffisant', bien: cible.property_id, cout, marge }
      }
    }
  } catch (e) {
    results?.errors?.push({ context: MARQUEUR, error: 'budget illisible : ' + (e && e.message) })
    return { skipped: 'budget_illisible' }
  }
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
      for (const l of lignesFutures({ listingId, jours: c && c.donnees && c.donnees.results, aujourdhui, releveLe })) {
        lignes.push({ ...l, user_id: cible.user_id, property_id: cible.property_id, releve_le: releveLe })
      }
    } catch (e) { erreurs.push({ listingId, ou: 'calendrier', message: e && e.message }) }
  }

  let ecrites = 0
  if (lignes.length) {
    // ⚠ `ignoreDuplicates` : une photo deja ecrite ne se reecrit pas, et son
    // refus n'est pas une erreur — c'est la regle « un releve n'ecrase jamais
    // le precedent », appliquee par la cle d'unicite.
    // ⚠ ON COMPTE CE QUI EST ENTRE, PAS CE QU'ON A ENVOYE. Avec
    // `ignoreDuplicates`, un passage qui rejoue une photo deja en base insere
    // ZERO ligne : annoncer `lignes.length` serait un nombre ecrit a la main,
    // qui ne rougit jamais. `.select('id')` fait dire a la base ce qu'elle a
    // vraiment accepte.
    const { data: entrees, error: errI } = await sb.from('comparables_releves')
      .upsert(lignes, { onConflict: 'property_id,listing_id,mois,releve_le', ignoreDuplicates: true })
      .select('id')
    if (errI) {
      results?.errors?.push({ context: MARQUEUR, error: errI.message })
      return { skipped: 'ecriture_refusee', erreurs }
    }
    ecrites = Array.isArray(entrees) ? entrees.length : 0
  }
  for (const e of erreurs) results?.errors?.push({ context: MARQUEUR, error: `${e.listingId} ${e.ou}: ${e.message}` })
  // ⚠ LE MARQUEUR N'EST POSE QUE SI QUELQUE CHOSE EST VRAIMENT ENTRE. Mon
  // commentaire affirmait deja cette regle, et le code ne la tenait pas : si
  // les deux appels de CHAQUE annonce levaient (AirROI en panne, cle absente,
  // quota), `lignes` restait vide, le bloc d'ecriture etait saute — et le
  // marqueur etait pose quand meme. Le mois passait pour releve, et il fallait
  // attendre le suivant. Constat n°15 de la review.
  if (marqueur.ecrire && ecrites > 0 && !erreurs.length) {
    await marqueur.ecrire(new Date(maintenant()).toISOString(), ecrites)
  }
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
