/* ============================================================================
   LES REVENUS D'UN MOIS, PAR BIEN — etape 4 du lot « Aujourd'hui V5 » (spec §4).

   Ce module ne calcule rien lui-meme : il COMPOSE trois regles qui existent
   deja, et c'est tout son interet.
     · `lib/revenus/net-hote.js`      ce que l'hote touche, net ou brut marque ;
     · `lib/revenus/versement.js`     a quelle DATE il le touche, par canal ;
     · `lib/yield/eclatement.js`      le prix voyageur et la date de VENTE.
   Une quatrieme implementation du prix voyageur serait la dette 17 rouverte —
   « l'ecran et le moteur passent par la meme assemblee ».

   ⚠ UN SEJOUR NON RANGEABLE EST COMPTE ET NOMME, JAMAIS SAUTE. C'est la regle
   la plus importante de ce fichier, et elle repond a une question que j'ai
   posee a Thierry : ou va un sejour dont le versement n'est pas calculable ?
   Reponse tenue ici, conforme a `docs/kb/restitution-yield.md` : il n'entre
   dans AUCUN mois, il est compte a part avec son motif, et l'ecran le dit.
   Le sauter en silence donnerait « un total qui a l'air juste » — le defaut le
   plus couteux de tout le domaine, parce qu'il ne se voit pas : personne ne
   compte les reservations de tete pour verifier la somme.

   ⚠ ET IL Y A DEUX FACONS DE NE PAS ETRE RANGEABLE, QUI NE SE MELANGENT PAS :
     · le MONTANT n'est pas calculable (`net-hote` refuse) ;
     · la DATE de versement n'est pas calculable (`versement` refuse).
   Un sejour peut avoir un montant sans date, ou une date sans montant. Les
   confondre dans un seul compteur ferait chercher au mauvais endroit : le
   premier se repare chez le provider ou dans le payload, le second dans la
   table des delais.

   ⚠ DONNEE NON URGENTE, CALCULEE A LA LECTURE, ET C'EST UNE DETTE ASSUMEE.
   La regle d'architecture de CLAUDE.md veut un resume calcule par le cron pour
   toute donnee non urgente, et des revenus mensuels en sont. La spec du lot
   l'affecte au LOT (c), qui attend une decision de Thierry
   (docs/specs/spec-performance-pages.md) ; aucune table de resume n'existe
   encore, et `tests/ecran-ne-calcule-pas.test.js` non plus. Le cout ajoute est
   borne et mesure : UNE lecture de `bookings_snapshot` sur la fenetre du mois,
   pas les 72 requetes de `/api/yield`.
   ========================================================================== */

const { netDuSejour } = require('./net-hote')
const { dateDeVersement, moisDuVersement, estRecu } = require('./versement')
const { dateDeVente } = require('../yield/eclatement')
const { readStatus, STATUS } = require('../bookings-snapshot-status')
// ⚠ `estUnBlocage` VIENT DU DERIVATEUR, ET CE N'EST PAS UN CYCLE : derive.js
// ne tire pas mois.js. La regle d'un blocage est posee la ou le writer la
// pose, pas recopiee ici — deux copies divergent, et c'est precisement ce
// que ce correctif repare.
const { estUnBlocage } = require('./derive')

// Les deux familles de refus, nommees pour que l'ecran les traduise.
const REFUS = { montant: 'montant', date: 'date' }

/**
 * « YYYY-MM » depuis un jour civil.
 *
 * ⚠ LE MOIS EST VALIDE ENTRE 01 ET 12, comme dans `fenetreDeLecture`, et ce
 * n'est pas du zele : les deux fonctions se repondent. Ma premiere version
 * rendait « 2026-13 » pour « 2026-13-01 » pendant que `fenetreDeLecture`
 * refusait ce mois — donc l'ecran pouvait demander une fenetre nulle pour un
 * mois que ce module venait lui-meme de produire. Deux fonctions d'un meme
 * module qui ne s'accordent pas sur ce qu'est un mois valide se contredisent au
 * premier appel chaine.
 */
function moisDe (jour) {
  return /^\d{4}-(0[1-9]|1[0-2])/.test(String(jour || '')) ? String(jour).slice(0, 7) : null
}

/**
 * Un sejour, reduit a ce que le bloc « Revenus nets » a besoin de savoir.
 *
 * @param ligne   { booking_id, property_id, snapshot, raw } de `bookings_snapshot`
 * @param delais  la table de `delais_versement`, via `tableDesDelais`
 */
function lireSejour (ligne, delais, defaultProvider = null) {
  const s = (ligne && ligne.snapshot) || {}
  const r = (ligne && ligne.raw) || {}

  // ⚠ SEUL UN `confirmed` COMPTE, ET C'EST LE MODULE DU DEPOT QUI LE DIT.
  // Un sejour annule n'a pas de revenu, et un `demapped` est un doublon de
  // migration : le compter doublerait le mois. `readStatus` canonise le
  // vocabulaire des deux providers — « new » chez Beds24 est un confirme.
  const statut = readStatus(s, defaultProvider)
  if (statut !== STATUS.CONFIRMED) return { compte: false, statut }

  const montant = netDuSejour(s, r, defaultProvider)

  // ⚠ LA DATE DE VENTE EST QUALIFIEE AVANT D'ETRE UTILISEE. Le canal direct se
  // verse « reservation + 3 jours », et une reservation IMPORTEE porte dans
  // `raw.inserted_at` la date de MIGRATION, pas sa date de vente — mesure du
  // depot, 11 jours de delai apparent contre 2 pour les natives. On passe donc
  // le drapeau a `dateDeVersement`, qui refuse avec son propre motif.
  const vente = dateDeVente(s, r, defaultProvider)

  const quand = dateDeVersement({
    canal: s.source,
    arrivee: s.arrival,
    depart: s.departure,
    reserve_le: vente.valeur,
    reserve_le_fiable: vente.fiable === false ? false : undefined,
    versement_stripe: s.versement_stripe || r.versement_stripe || null
  }, delais)

  return {
    compte: true,
    statut,
    booking_id: (ligne && ligne.booking_id) || null,
    property_id: (ligne && ligne.property_id) || null,
    montant,
    versement: quand,
    mois: moisDuVersement(quand.jour)
  }
}

/**
 * Les revenus d'UN mois, par bien et au total.
 *
 * @param lignes      les lignes de `bookings_snapshot`
 * @param delais      la table de `delais_versement`
 * @param mois        « YYYY-MM »
 * @param aujourdHui  le jour civil de reference, « YYYY-MM-DD » (jamais `new Date()`
 *                    ici : l'appelant sait dans quel fuseau il compte, ce module non)
 */
function revenusDuMois (lignes, delais, mois, aujourdHui, refsConnues = null) {
  // ⚠ `aujourdHui` DOIT ETRE UN JOUR CIVIL, ET ON REFUSE SANS LUI (constat de
  // la review du 26 octobre 2026). `estRecu` rend `null` sur une date illisible,
  // donc la somme se PERDAIT des deux cotes : total 229,88 €, « Recu 0,00 € ·
  // A venir 0,00 € ». Mon commentaire plus bas jurait que la branche
  // `recu === null` existait « pour que la somme ne puisse pas se perdre » —
  // elle ne l'empechait pas, elle la perdait en silence. Inerte depuis
  // l'endpoint (`jourParis(0)` est toujours valide), mais la vue ANNEE annoncee
  // au reste du lot est exactement l'appelant futur que ce commentaire
  // pretendait couvrir.
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(aujourdHui || ''))) {
    return null
  }
  const vide = () => ({
    sejours: 0,
    recu_cents: 0,
    a_venir_cents: 0,
    total_cents: 0,
    bruts: 0,
    refuses: { montant: 0, date: 0 },
    motifs: {}
  })

  const parBien = new Map()
  const total = vide()
  // ⚠ LES REFUS DE DATE SE COMPTENT HORS MOIS, ET IL FAUT DIRE CE QUE CA
  // IMPLIQUE. Un sejour dont la DATE de versement est inconnue n'a pas de mois :
  // le ranger « dans le mois demande » serait inventer son appartenance, et ne
  // pas le compter du tout le ferait disparaitre de tous les ecrans a la fois.
  // Il va donc dans un compteur a part, que l'ecran affiche sous le total.
  //
  // ⚠ CE COMPTEUR EST DONC TOUS MOIS CONFONDUS, et l'ecran doit le dire ainsi.
  // Un hote qui regarde novembre et lit « 1 sejour sans date de versement »
  // pourrait croire qu'il s'agit d'un sejour de novembre ; il peut venir de
  // n'importe quelle periode. C'est inevitable — sans date, il n'y a pas de
  // mois a lui attribuer — mais ca ne doit pas etre tu : « N sejours sans date
  // de versement, tous mois confondus ».
  //
  // ⚠ ET UN SEJOUR SANS DATE EST COMPTE « date » MEME SI SON MONTANT MANQUE
  // AUSSI. Mesure : un canal inconnu fait echouer les DEUX — le montant
  // (`net-hote` refuse le canal) et la date (`versement` refuse le canal). Il
  // n'apparait qu'une fois, dans `refuses.date`, parce que sans date la
  // question du montant ne se pose pas : il n'entre dans aucun mois de toute
  // facon. Le `motifs` porte la vraie cause (`canal_inconnu`), donc rien n'est
  // perdu pour le diagnostic — mais le compteur `refuses.montant` ne compte
  // QUE les sejours bien dates dont le montant manque, et c'est a dessein.
  const horsMois = vide()

  // ⚠ ET UN TROISIEME COMPTEUR, PARCE QU'UN EURO PEUT SORTIR PAR UNE PORTE QUE
  // NI LE MOIS NI LE MONTANT NE GARDENT — constat GRAVE de la review du
  // 26 octobre 2026, mesure : 1 000 € d'ecart MUET entre le bandeau et la somme
  // des lignes affichees.
  //
  // `par_bien` est groupe par `bookings_snapshot.property_id`, et l'ecran ne
  // peint que les cles qui correspondent a un `provider_property_id` de la
  // liste des biens. Une cle ORPHELINE entrait donc dans `total` et sortait de
  // l'affichage sans aucune reserve — alors que les montants et les dates non
  // calculables ont chacun leur compteur. Trois sources, toutes atteignables :
  //   · `bookings_snapshot.property_id` est NULLABLE
  //     (migrations/0000-schema-initial.sql : `property_id text,`) ;
  //   · un RE-KEYING ou une bascule de provider laisse l'historique sur
  //     l'ancienne cle — c'est la cause racine deja nommee au registre, et
  //     `tests/stats-avis.test.js` garde exactement ce cas pour les avis ;
  //   · un bien supprime de `properties` dont les reservations restent.
  //
  // Et la lecture n'est PAS bornee par bien pour un titulaire (`refs === null`),
  // donc rien en amont ne filtre ces lignes.
  //
  // ⚠ `refsConnues` A `null` VEUT DIRE « JE NE SAIS PAS », PAS « AUCUNE ». Un
  // appelant qui ne passe pas la liste ne doit pas voir tous ses revenus
  // declares orphelins : on ne compte alors rien, et le compteur reste a zero.
  const connues = Array.isArray(refsConnues)
    ? new Set(refsConnues.map(r => String(r == null ? '' : r)))
    : null
  const horsBiens = vide()

  const ajouter = (acc, s) => {
    acc.sejours++
    if (s.montant.valeur == null) {
      acc.refuses.montant++
      const m = s.montant.motif || 'inconnu'
      acc.motifs[m] = (acc.motifs[m] || 0) + 1
      return
    }
    if (s.montant.net === false) acc.bruts++
    // ⚠ EN CENTIMES, ET LA SOMME SE FAIT EN ENTIERS. Additionner des flottants
    // sur trente reservations donne 1 847,9999999999998 : l'ecran afficherait
    // 1 847,99 ou 1 848,00 selon l'arrondi, et deux ecrans qui somment dans un
    // ordre different ne tomberaient pas d'accord. Le depot compte en centimes
    // partout ailleurs (`recommended_rate_cents`, `montant_cents`).
    const cents = Math.round(s.montant.valeur * 100)
    acc.total_cents += cents
    const recu = estRecu(s.versement.jour, aujourdHui)
    if (recu === true) acc.recu_cents += cents
    else if (recu === false) acc.a_venir_cents += cents
    // `recu === null` : la date n'est pas lisible, donc le sejour ne devrait pas
    // etre ici — `revenusDuMois` l'a deja ecarte. La branche existe pour que la
    // somme ne puisse pas se perdre si un appelant futur l'oublie.
  }

  for (const ligne of Array.isArray(lignes) ? lignes : []) {
    const s = lireSejour(ligne, delais, null)
    if (!s.compte) continue

    // ⚠⚠ UN BLOCAGE N'EST PAS UN SEJOUR, ET C'EST LE MODULE QUI LE SAIT
    // DESORMAIS (constat de la review du lot Revenus, 26 octobre 2026).
    //
    // La regle `est_blocage` a ete decidee par Thierry le 27 octobre : aucun
    // nom de voyageur ET `price` a zero ET aucun montant calculable. Mesure en
    // production, 1 564 lignes : 74 sejours confirmes sans aucun prix, dont
    // SOIXANTE-SIX portent ces trois indices — Beds24 envoie ses blocages comme
    // des reservations confirmees a prix nul. Les afficher « non calculable »
    // etait exact et inutile : ce ne sont pas des sejours.
    //
    // Les deux agregats SQL les excluent. Ce module, lui, ne les connaissait
    // pas : c'est `scripts/verifier-parite-revenus.js` qui les retirait AVANT
    // de l'appeler. L'oracle n'etait donc fidele que grace a un pre-filtre
    // vivant chez son appelant — et tout AUTRE appelant comptait les 66 comme
    // des sejours sans montant. La vue ANNEE annoncee au reste du lot est
    // exactement cet appelant-la, et elle n'aurait ete d'accord ni avec l'ecran
    // ni avec le SQL.
    //
    // ⚠ ET LE PRE-FILTRE DU VERIFICATEUR RESTE, parce qu'il ne fait pas la meme
    // chose : lui retire les blocages des lignes qu'il PASSE a l'oracle, ce qui
    // prouve au passage que la colonne `est_blocage` en base dit la meme chose
    // que le module. Les deux se superposent sans se contredire.
    if (estUnBlocage(ligne && ligne.snapshot, ligne && ligne.raw,
                     s.montant.valeur != null)) continue

    if (s.versement.jour == null) {
      // Pas de date : hors mois, compte et nomme.
      horsMois.sejours++
      horsMois.refuses.date++
      const m = s.versement.motif || 'inconnu'
      horsMois.motifs[m] = (horsMois.motifs[m] || 0) + 1
      continue
    }
    if (s.mois !== mois) continue

    const cle = String(s.property_id == null ? '' : s.property_id)
    if (!parBien.has(cle)) parBien.set(cle, vide())
    ajouter(parBien.get(cle), s)
    ajouter(total, s)
    // ⚠ IL ENTRE DANS `total` DANS TOUS LES CAS, et c'est voulu : l'argent a
    // bien ete touche. Ce qu'on ajoute est la possibilite de DIRE qu'il n'est
    // pas sur une ligne — sans ce compteur, le bandeau et les lignes ne
    // s'additionnent pas, et personne ne peut le voir.
    if (connues && !connues.has(cle)) ajouter(horsBiens, s)
  }

  return {
    mois,
    calcule_le: aujourdHui,
    par_bien: Object.fromEntries(parBien),
    total,
    hors_mois: horsMois,
    hors_biens: horsBiens
  }
}

/**
 * La FENETRE DE LECTURE a interroger pour servir un mois, bornee sur `arrival`.
 *
 * ⚠ ELLE SE DEDUIT DES DELAIS, ELLE N'EST PAS UNE CONSTANTE. Un sejour compte
 * au mois de son VERSEMENT, donc pour servir « novembre » il faut lire les
 * sejours dont la base de calcul tombe jusqu'a `delai` jours avant le
 * 1er novembre. Avec les trois delais d'aujourd'hui — Airbnb arrivee+1,
 * Booking depart+1, direct reservation+3 — la fenetre est de trois jours ; une
 * constante « un mois » marcherait, et c'est bien pour ca qu'il ne faut pas en
 * mettre une. Le CHECK de la table autorise `jours <= 180` : le jour ou un
 * canal se verse a 90 jours, une fenetre figee ferait DISPARAITRE ses sejours
 * du total, sans erreur et sans trou visible.
 *
 * ⚠ ET ELLE N'EST BORNABLE QUE SI **TOUS** LES CANAUX SE VERSENT SUR
 * L'ARRIVEE — correction d'un constat de la review du 26 octobre 2026.
 * On borne sur `arrival`, la colonne du coeur. Ma premiere version margeait de
 * 31 jours « parce que Booking se verse sur le DEPART », en arguant qu'au-dela
 * le depot parle de location au mois (`SEUIL_LONG_SEJOUR = 24` nuits).
 *
 * L'argument etait inverse, et la review l'a dit : ce seuil existe pour
 * MARQUER les longs sejours, c'est-a-dire pour dire qu'ils EXISTENT — ce n'est
 * pas une garantie qu'ils sont hors perimetre. Mesure, table sans canal sur
 * reservation (donc `bornable: true`) : un sejour Booking de 45 nuits, arrivee
 * le 20 septembre, depart le 4 novembre, se verse le 5 novembre — il compte en
 * novembre, et son `arrival` est HORS de la fenetre. 4 500 € hors de toute
 * requete, hors de tout compteur.
 *
 * Une marge ne peut pas fermer ce trou : il n'y a aucune borne superieure a la
 * duree d'un sejour, et en inventer une ferait disparaitre les plus gros.
 * `bornable` est donc faux des qu'un canal se verse sur le DEPART ou sur la
 * RESERVATION. La marge de 31 jours reste pour le seul cas ou elle suffit :
 * tous les canaux sur l'arrivee, ou le decalage est le delai lui-meme.
 *
 * ⚠ ET LE DRAPEAU EST GLOBAL A LA TABLE, PAS PAR CANAL, parce que la lecture
 * l'est : une seule requete sert tous les canaux. Un canal non bornable rend
 * donc la lecture entiere non bornee — c'est plus cher, et c'est le prix de ne
 * pas perdre d'argent.
 *
 * ⚠⚠ ET POUR LA BASE `reservation`, AUCUNE FENETRE SUR `arrival` NE SUFFIT —
 * c'est la limite de cette fonction, et elle la DECLARE au lieu de la taire.
 * Une reservation precede son sejour de n'importe quelle duree : un sejour
 * reserve le 29 octobre 2026 pour une arrivee en JUILLET 2027 se verse le
 * 1er novembre 2026, donc il compte en novembre — et son `arrival` est a huit
 * mois de toute fenetre raisonnable. Le borner le ferait disparaitre du total
 * en silence, ce qui est precisement le defaut que tout ce module existe pour
 * empecher.
 *
 * `bornable` vaut donc `false` des qu'un canal de la table se verse sur la
 * reservation, et l'appelant doit alors lire SANS borne de date, en paginant.
 * C'est plus cher — deux requetes au lieu d'une sur le volume actuel — et
 * c'est le prix de la justesse. Le lot (c) le remplacera par un resume.
 *
 * @returns { debut, fin, jours_de_marge, delai_max, bornable, motif }
 */
function fenetreDeLecture (mois, delais = {}) {
  // ⚠ LE MOIS SE VALIDE ENTRE 01 ET 12, PAS SEULEMENT PAR SA FORME. Defaut
  // trouve par le test : « 2026-13 » passe `^\d{4}-\d{2}$`, et
  // `Date.UTC(2026, 12, 1)` ROULE sur janvier 2027 — la fonction rendait donc
  // une fenetre parfaitement formee pour un mois qui n'existe pas, et l'ecran
  // aurait servi les revenus de janvier sous l'etiquette « mois 13 ».
  // `Date.UTC` ne refuse rien : c'est a l'appelant de borner.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mois || ''))) return null
  const regles = Object.values(delais || {}).filter(Boolean)
  const delaiMax = regles.map(r => Number(r.jours) || 0).reduce((m, j) => (j > m ? j : m), 0)
  // ⚠ `depart` AUTANT QUE `reservation` : les deux decalent la base de calcul
  // par rapport a la colonne bornee (`arrival`), et le depart peut en etre
  // separe de n'importe quelle duree.
  const horsArrivee = regles.filter(r => r.base === 'depart' || r.base === 'reservation')
  const surReservation = horsArrivee.length > 0
  const marge = 31 + delaiMax
  const [an, m] = String(mois).split('-').map(Number)
  const premier = new Date(Date.UTC(an, m - 1, 1))
  const dernier = new Date(Date.UTC(an, m, 0))
  const decale = (d, n) => {
    const x = new Date(d.getTime())
    x.setUTCDate(x.getUTCDate() + n)
    return x.toISOString().slice(0, 10)
  }
  return {
    debut: decale(premier, -marge),
    fin: decale(dernier, marge),
    jours_de_marge: marge,
    delai_max: delaiMax,
    bornable: !surReservation,
    motif: surReservation
      ? `un canal se verse sur ${[...new Set(horsArrivee.map(r => r.base))].join(' ou ')} : `
        + 'ces dates sont separees de l arrivee par une duree non bornee '
        + '(un sejour long, une reservation faite des mois a l avance), '
        + 'et aucune fenetre sur `arrival` ne les couvre'
      : null
  }
}

module.exports = { revenusDuMois, lireSejour, moisDe, fenetreDeLecture, REFUS }
