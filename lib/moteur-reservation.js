// lib/moteur-reservation.js
// DOC : docs/kb/moteur-reservation.md (modif = MEME COMMIT)
// Spec : docs/specs/spec-moteur-reservation.md §3 bis et §4 (etape 1)
//
// LE MOTEUR DE RESERVATION DIRECT — LECTURE PURE.
// Ce module ne connait ni Supabase ni Channex : il recoit des donnees deja lues
// et rend un calendrier public. C'est ce qui le rend testable sans reseau, et
// c'est ce qui garantit qu'il ne peut RIEN ecrire.
//
// POURQUOI IL NE LIT QUE LE CŒUR
// Regle d'architecture (CLAUDE.md) : aucune app ne lit un provider directement.
// Les trois sources du calendrier public sont donc toutes des tables HoteSmart :
//   - `properties`          : base_price, inventory_units, capacity, devise
//   - `calendar_inventory`  : les EXCEPTIONS (prix du jour, stop_sell, min_stay…)
//   - `bookings_snapshot`   : les nuits deja vendues, TOUTES origines confondues
//
// LE COEFFICIENT (amendement §3 ter, ajout 2 — REGLE GRAVEE)
// Chaque lien de reservation porte un `price_coefficient` en POURCENTAGE
// (defaut 100). Il s'applique a l'AFFICHAGE et a l'ENCAISSEMENT : le prix
// coefficiente est celui que le voyageur voit, celui qu'il paie, et celui qui
// partira dans la reservation CRS.
//
// ⚠ IL NE REECRIT JAMAIS LES PRIX DU CŒUR. C'est une lentille posee a la
// LECTURE, pas une ecriture. `calendar_inventory` et `properties.base_price`
// restent la verite unique, identique pour tous les canaux. Le violer creerait
// un second writer des prix — exactement ce que la decision 2 de l'etape 0 a
// refuse. Meme logique que le markup par canal des OTA.
//
// LA REGLE DU PRIX (decision 1, gravee)
// `calendar_inventory.rate` s'il existe, SINON `properties.base_price`.
// Le calendrier ne porte que les ECARTS au prix de base — exactement le meme
// principe que le stop_sell : une memoire d'exceptions, pas une grille complete.
// Un bien sans `base_price` n'est pas reservable du tout : il n'a pas de prix
// plancher, donc aucune de ses nuits n'a de prix. C'est pour cela que « une date
// sans prix » n'existe plus — le cas se traite au niveau du BIEN, pas de la nuit.

const { nuits, occupationParNuit } = require('./reservation-directe')
const { STATUS } = require('./bookings-snapshot-status')

// Un blocage proprietaire occupe le logement. L'hote peut passer outre le sien
// en saisie manuelle (phase 2) ; un voyageur ne le peut jamais.
const STATUTS_OCCUPANTS = [STATUS.CONFIRMED, STATUS.BLOCKED]

// Horizon par defaut de la page publique. Channex rend 365 jours de
// restrictions ; au-dela l'hote n'a de toute facon rien regle.
const HORIZON_JOURS = 365

// ─── Dates ───────────────────────────────────────────────────────────────────
// ⚠ TOUT EST EN UTC ICI, comme `nuits()` de lib/reservation-directe.js.
// Une date de calendrier est un jour civil, pas un instant : la manipuler avec
// l'heure locale fait basculer d'un jour en UTC+2 (piege deja rencontre a
// l'etape 0 du chantier stop_sell, scripts/audit-stop-sell.js).
function ajouterJours (dateIso, n) {
  const d = new Date(`${dateIso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function estDateIso (v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())
}

// Largeur de fenetre demandee -> largeur servie. Une seule fonction pour que
// l'API et le moteur ne puissent pas diverger.
// Absente ou inexploitable (0, texte, NaN) -> l'horizon par defaut ; sinon
// bornee a [1, HORIZON_JOURS]. Le plafond n'est pas cosmetique : sans lui,
// `?jours=99999` ferait balayer trente ans de calendrier a chaque appel public.
function bornerJours (jours) {
  const n = Math.floor(Number(jours))
  if (!Number.isFinite(n) || n <= 0) return HORIZON_JOURS
  return Math.min(n, HORIZON_JOURS)
}

function fenetre (debut, jours) {
  const out = []
  for (let i = 0; i < jours; i++) {
    const d = ajouterJours(debut, i)
    if (!d) break
    out.push(d)
  }
  return out
}

// ─── Le bien est-il vendable en direct ? ─────────────────────────────────────
// Repond AVANT toute lecture de calendrier : inutile de calculer 365 nuits pour
// un bien qui n'a pas de prix de base. Chaque refus a une raison nommee — un
// « non » muet enverrait l'hote chercher au mauvais endroit.
function raisonNonVendable (bien) {
  if (!bien) return 'bien_inconnu'

  // ⚠ SANS IDENTIFIANT PROVIDER, LE CALENDRIER EST AVEUGLE — trouve en review,
  // et c'est le defaut le plus dangereux du chantier.
  // `provider_property_id` est NULLABLE, et le depot le garde partout ailleurs
  // (api/calendar.js, api/channel-connect.js, lib/cron-channel-sync.js…). Un bien
  // provisionne a moitie — provisionnement interrompu, rollback partiel de
  // channel-property.js qui laisse justement des orphelins — peut porter un
  // `base_price` valide sans identifiant provider.
  // Alors `String(null)` vaut la chaine 'null' : la lecture de `bookings_snapshot`
  // rend zero ligne, le prefixe d'intentions `resa-nuit:<user>:null:` aussi, et la
  // page publique affiche 365 NUITS LIBRES — y compris celles deja vendues, que
  // le devis serveur valide ensuite. Seul `calendar_inventory` (clé UUID) repond
  // encore, et il ne porte que des exceptions.
  // Un calendrier qui ne peut pas voir les reservations ne doit pas vendre.
  if (!bien.provider_property_id) return 'sans_lien_provider'

  // ⚠ LE MODELE DE TENUE NE SAIT PAS COMPTER AU-DELA D'UNE UNITE.
  // Constat de review. La cle d'une tenue est `resa-nuit:<hote>:<bien>:<nuit>`
  // et c'est la cle PRIMAIRE de `write_locks` : deux voyageurs qui paient la
  // meme nuit ne produisent qu'UNE ligne — la seconde ecrase la premiere. Le
  // calendrier compte alors 1 occupation la ou il y en a 2, et l'expiration de
  // l'une libere les nuits que l'autre est en train de payer.
  //
  // A `inventory_units = 1` — tout le parc aujourd'hui, et `inventory_type`
  // n'a que 'whole' de code — les deux comptages coincident et rien ne cloche.
  // Au-dela, ils divergent, et la divergence se paie en surreservation.
  // On REFUSE plutot que de vendre sur un modele qu'on sait faux. La levee
  // demande une cle de tenue par unite : c'est un chantier, pas un correctif.
  if (Number(bien.inventory_units) > 1) return 'multi_unites_non_supporte'

  // ⚠ UN BIEN QU'ON NE SAIT PAS ECRIRE NE DOIT PAS ENCAISSER. Constat de review.
  // `lib/moteur-creation.js` refuse la creation CRS si le bien n'est pas Channex
  // ou s'il manque son room_type / rate_plan — mais il le refuse APRES le
  // paiement : l'argent est pris, puis rembourse, avec une alarme et un e-mail
  // « reservation impossible » au voyageur. Mesure du scenario : 3 nuits a 100 €
  // plus 20 €/nuit de supplement sur « coeur de vie 23 » = 360 € preleves et
  // rendus une minute plus tard.
  //
  // Ce trou existait avant la levee de `base_price` — tout bien Beds24 tarife y
  // etait expose. Mais c'est cette levee qui a retire la derniere barriere sur
  // les deux biens de Bagneres, justement Beds24 aujourd'hui. On la remplace ici,
  // AVANT le premier centime, avec exactement les memes conditions que la garde
  // d'ecriture : deux gardes qui divergeraient laisseraient un interstice.
  //
  // A la migration, ces biens deviendront Channex et la garde s'ouvrira d'elle-meme.
  if (bien.provider !== 'channex') return 'sans_ecriture_crs'
  if (!bien.provider_room_type_id || !bien.provider_rate_plan_id) return 'sans_ecriture_crs'

  // ⚠ `base_price` N'EST PLUS EXIGE — decision de Thierry du 8 septembre 2026,
  // qui REVIENT sur la decision 1 de l'etape 0 (« bien sans base_price = non
  // reservable »).
  //
  // Cette decision-la supposait qu'un prix de base existe toujours. C'est faux :
  // Thierry ne s'en sert pas, tous ses prix sont saisis PAR DATE dans le
  // calendrier. Exiger un `base_price` rendait ses deux biens de Bagneres
  // definitivement invendables en direct — l'objectif meme du chantier.
  //
  // Le filtre par NUIT fait deja le travail, proprement : `prixDeBase` rend
  // `null` quand ni l'exception du jour ni le prix de base n'existent, et
  // `construireCalendrier` marque alors la nuit invendable avec `sans_prix`.
  // Un bien sans aucun prix affiche donc 365 nuits sans prix — inesthetique,
  // honnete, et sans danger : aucune nuit ne peut etre vendue a zero.
  //
  // Ce qui reste refuse ci-dessus, ce sont les defauts STRUCTURELS : un bien
  // qu'on ne sait pas rattacher a son provider, ou dont le modele de tenue ne
  // sait pas compter les unites. Un prix absent n'est pas de cette famille.
  return null
}

// ⚠ NE JAMAIS FERMER LA VENTE SUR `paused_at` NI `automation_paused`.
// Trouve en review, et le piege est serieux : ces deux colonnes portent le KILL
// SWITCH D'AUTOMATISATION, pas une mise en pause commerciale. `lib/cron-alerting.js`
// (bloc 4) les positionne AUTOMATIQUEMENT quand une conversation IA boucle. Les y
// lire ferait qu'une boucle de messages mettrait, toute seule et sans un mot, le
// canal de vente direct de l'hote hors ligne.
//
// Le perimetre du kill switch est grave : il coupe le VOYAGEUR (messages sortants,
// codes d'acces), jamais le menage — et il n'a jamais inclus la vente.
// Voir docs/kb/alertes.md §3.
//
// L'ACTIVATION DU MOTEUR EST AILLEURS : c'est `booking_links.active` (§3 ter,
// ajout 1). Un bien sans lien actif n'a pas de page publique — c'est l'etat par
// defaut, et c'est le seul interrupteur de vente.



// ─── Prix d'une nuit ─────────────────────────────────────────────────────────
// `rate` du jour s'il est pose, sinon le prix de base du bien.
// ⚠ `rate` peut valoir 0 en base sur des lignes anciennes : un 0 n'est pas un
// prix, c'est l'absence d'exception. Le traiter comme un prix vendrait la nuit
// gratuitement.
function prixDeBase (ligne, bien) {
  const exception = ligne && ligne.rate != null ? Number(ligne.rate) : null
  if (exception != null && exception > 0) return exception
  const base = Number(bien.base_price)
  return base > 0 ? base : null
}

// ─── Le coefficient du lien ──────────────────────────────────────────────────
// Stocke en POURCENTAGE (100 = prix inchange). Rendu en multiplicateur.
// Une valeur absente, nulle, negative ou inexploitable vaut 100 : un lien dont
// le coefficient serait illisible doit vendre au prix normal, JAMAIS a zero.
// La contrainte SQL borne deja (0, 1000] ; cette garde protege le chemin de
// lecture contre une ligne ecrite avant la contrainte, ou par une autre main.
function multiplicateur (coefficient) {
  const n = Number(coefficient)
  if (!Number.isFinite(n) || n <= 0) return 1
  return n / 100
}

// Le prix affiche et encaisse pour une nuit. On arrondit AU CENTIME ICI, pas a
// la fin : le total doit etre exactement la somme des lignes que le voyageur a
// sous les yeux. Un arrondi global ferait afficher un detail qui ne s'additionne
// pas au montant preleve — le genre d'ecart qu'un voyageur remarque.
function prixCoefficiente (prixBrut, coefficient) {
  if (prixBrut == null) return null
  return arrondir(prixBrut * multiplicateur(coefficient))
}

// Supplement par voyageur au-dela des voyageurs inclus, PAR NUIT.
// Semantique reprise telle quelle du calendrier hote (pages/biens-calendrier.html
// `maxRateOf`) : `prix du jour + (personnes - inclus) x supplement`. Le defaut de
// `included_guests` est `capacity` — c'est-a-dire « tout le monde est inclus ».
function supplementVoyageurs (bien, personnes) {
  const inclus = Number(bien.included_guests) || Number(bien.capacity) || 1
  const sup = Number(bien.extra_guest_fee) || 0
  if (sup <= 0) return 0
  return Math.max(0, (Number(personnes) || 0) - inclus) * sup
}

// ─── Le calendrier public ────────────────────────────────────────────────────
// Rend une nuit par jour de la fenetre. Chaque nuit dit son prix, si elle est
// vendable, et POURQUOI elle ne l'est pas.
//
// ⚠ `indisponible` ne dit JAMAIS au voyageur laquelle des raisons s'applique :
// « ferme par l'hote » et « deja reserve » sont deux informations commerciales
// que la page ne divulgue pas. La raison est calculee ici parce que le serveur
// en a besoin pour valider un sejour ; elle est retiree avant l'envoi au
// navigateur (voir `nuitPublique`).
// `tenuePropre` : les nuits que L'APPELANT tient deja lui-meme (sa propre
// tentative de paiement en cours). Elles sont retirees de l'occupation.
//
// ⚠ SANS CELA, UNE TENTATIVE SE REFUSE ELLE-MEME. Constat de review :
// des qu'une tentative pose sa tenue, le calendrier compte ces nuits comme
// prises ; toute re-verification de CETTE tentative echoue alors sur sa PROPRE
// tenue, et le voyageur lit « une des nuits n'est plus disponible » a propos de
// nuits qu'il vient lui-meme de reserver. Les cles `resa-nuit:` ne disent pas a
// qui elles sont : c'est l'appelant qui doit nommer les siennes.
function construireCalendrier ({ bien, lien, inventaire, snapshots, intentions, tenuePropre, debut, jours }) {
  const coef = lien ? lien.price_coefficient : 100
  const dates = fenetre(debut, bornerJours(jours))
  const parDate = {}
  for (const l of inventaire || []) parDate[l.date] = l

  const unites = Math.max(1, Number(bien.inventory_units) || 1)
  const occupation = occupationParNuit(snapshots, { statuts: STATUTS_OCCUPANTS })
  // ⚠ LE CŒUR NE SAIT PAS ENCORE. Trouve en review.
  // Entre l'acceptation d'une reservation par Channex et son retour par le feed,
  // la nuit est vendue mais absente de `bookings_snapshot`. Le verrou de la
  // phase 2 compte deja ces intentions (lib/reservation-directe.js) ; le
  // calendrier public les ignorait et affichait libre une nuit que l'hote venait
  // de vendre a la main. Sans consequence tant qu'on ne fait que lire — mais
  // c'est ce meme calcul que l'etape 2 verrouillera avant d'encaisser.
  for (const [nuit, n] of Object.entries(intentions || {})) {
    occupation[nuit] = (occupation[nuit] || 0) + n
  }
  // Puis on RETIRE ce que l'appelant tient deja. Borne a 0 : une tenue qui aurait
  // expire entre la lecture et ici ne doit pas rendre l'occupation negative.
  for (const nuit of tenuePropre || []) {
    if (occupation[nuit]) occupation[nuit] = Math.max(0, occupation[nuit] - 1)
  }

  const out = []
  for (const date of dates) {
    const l = parDate[date] || null
    // Le prix du cœur, PUIS la lentille du lien. Le cœur n'est jamais touche.
    const prix = prixCoefficiente(prixDeBase(l, bien), coef)
    const vendues = occupation[date] || 0
    const restant = Math.max(0, unites - vendues)

    // Ordre des raisons : le stop-sell d'abord. C'est l'INTENTION de l'hote, et
    // elle prime sur le stock — une nuit fermee reste fermee meme s'il reste des
    // unites. Regle gravee au chantier audit stop_sell.
    let raison = null
    // ⚠ `avail === 0` FERME AUSSI. Trouve en review.
    // La memoire d'intention (`stop_sell`) n'a ete amorcee QUE sur Colomiers
    // (scripts/reconcilier-stop-sell.js, « unique, pour UN bien Channex »), et le
    // correctif qui fait ecrire `stop_sell` par le geste « Disponibilite : Fermé »
    // du calendrier mobile est recent. Sur les autres biens, une nuit fermee avant
    // ce correctif porte donc `avail = 0, stop_sell = false`.
    // L'hote la voit « Fermé » sur son propre calendrier — `pages/calendrier-mobile.html`
    // fait `isUnavail = r.avail === 0 || r.stop_sell`, `pages/biens-calendrier.html`
    // de meme. La page publique la vendait.
    //
    // Ne pas confondre avec la regle du chantier audit stop_sell : celle-ci
    // interdit de DEDUIRE l'intention du stock au moment de POUSSER. Ici on LIT,
    // et on lit comme l'hote voit. Entre vendre une nuit que l'hote croit fermee
    // et refuser une nuit qu'il croit ouverte, la premiere erreur est la pire.
    if (l && (l.stop_sell === true || l.avail === 0)) raison = 'ferme'
    else if (restant <= 0) raison = 'complet'
    else if (prix == null) raison = 'sans_prix'

    out.push({
      date,
      prix,
      disponible: raison === null,
      raison,
      restant,
      // Restrictions telles que le cœur les porte. `0` et `null` valent « aucune
      // restriction » — c'est ce qu'ecrit api/calendar.js.
      min_stay_arrival: l && l.min_stay_arrival > 1 ? Number(l.min_stay_arrival) : 1,
      min_stay_through: l && l.min_stay_through > 1 ? Number(l.min_stay_through) : 1,
      max_stay: l && l.max_stay > 0 ? Number(l.max_stay) : 0,
      cta: !!(l && l.cta),
      ctd: !!(l && l.ctd)
    })
  }
  return out
}

// Ce que le navigateur a le droit de voir. `raison` et `restant` restent au
// serveur : ils diraient au public si une nuit est fermee par choix ou vendue,
// et combien d'unites restent.
function nuitPublique (n) {
  return {
    date: n.date,
    prix: n.prix,
    disponible: n.disponible,
    min_stay_arrival: n.min_stay_arrival,
    max_stay: n.max_stay,
    cta: n.cta,
    ctd: n.ctd
  }
}

// ─── Validation d'un sejour ──────────────────────────────────────────────────
// LE SERVEUR EST LA SEULE AUTORITE. La page recalcule un total pour l'affichage
// immediat, mais rien de ce qu'elle envoie n'est cru : dates, nombre de
// personnes et total sont revalides ici a chaque fois.
//
// Rend { ok, raison, nuits, detail, total, devise }.
function validerSejour ({ calendrier, bien, lien, arrival, departure, personnes }) {
  const refus = r => ({ ok: false, raison: r, nuits: [], detail: [], total: 0 })

  if (!estDateIso(arrival) || !estDateIso(departure)) return refus('dates_invalides')
  const voulues = nuits(arrival, departure)
  if (!voulues.length) return refus('sejour_vide')

  const nb = Number(personnes)
  if (!Number.isInteger(nb) || nb < 1) return refus('voyageurs_invalides')
  const capacite = Math.max(1, Number(bien.capacity) || 1)
  if (nb > capacite) return refus('trop_de_voyageurs')

  const parDate = {}
  for (const n of calendrier) parDate[n.date] = n

  // Toutes les nuits doivent etre DANS la fenetre publiee. Une date hors
  // fenetre n'est pas « libre par defaut » : elle est inconnue, donc refusee.
  for (const d of voulues) if (!parDate[d]) return refus('hors_fenetre')

  // Chaque nuit vendable. On s'arrete a la premiere qui ne l'est pas — la page
  // n'a pas besoin de savoir laquelle.
  for (const d of voulues) if (!parDate[d].disponible) return refus('nuit_indisponible')

  // Le jour du DEPART n'est pas une nuit vendue, mais il porte sa propre
  // restriction de depart. S'il est hors fenetre, on ne peut pas la verifier :
  // on ne refuse pas pour autant — l'absence de donnee n'est pas une fermeture.
  const jourDepart = parDate[departure] || null
  if (jourDepart && jourDepart.ctd) return refus('depart_interdit')

  const premiere = parDate[voulues[0]]
  if (premiere.cta) return refus('arrivee_interdite')

  // min_stay : celui de la nuit d'arrivee (min_stay_arrival) et celui de chaque
  // nuit traversee (min_stay_through). Les deux sont exprimes en NUITS.
  if (voulues.length < premiere.min_stay_arrival) {
    return { ...refus('sejour_trop_court'), minimum: premiere.min_stay_arrival }
  }
  let through = 1
  for (const d of voulues) through = Math.max(through, parDate[d].min_stay_through)
  if (voulues.length < through) return { ...refus('sejour_trop_court'), minimum: through }

  // max_stay : 0 = aucun plafond.
  let plafond = 0
  for (const d of voulues) {
    const m = parDate[d].max_stay
    if (m > 0) plafond = plafond === 0 ? m : Math.min(plafond, m)
  }
  if (plafond > 0 && voulues.length > plafond) {
    return { ...refus('sejour_trop_long'), maximum: plafond }
  }

  // ⚠ `parDate[d].prix` est DEJA coefficiente (construireCalendrier l'a fait) :
  // le recoefficienter ici appliquerait le coefficient deux fois. Seul le
  // supplement voyageurs, qui vient du bien et non du calendrier, reste a
  // passer par la lentille.
  //
  // Le supplement EST coefficiente : le coefficient porte sur le prix de vente
  // du sejour, pas sur la seule ligne « nuitees ». Un lien a 110 % qui
  // majorerait les nuits mais pas le supplement vendrait a un taux different
  // selon le nombre de voyageurs.
  const sup = prixCoefficiente(supplementVoyageurs(bien, nb), lien ? lien.price_coefficient : 100)
  const detail = voulues.map(d => ({
    date: d,
    prix: parDate[d].prix,
    supplement: sup,
    total: arrondir(parDate[d].prix + sup)
  }))
  const total = arrondir(detail.reduce((s, l) => s + l.total, 0))

  return { ok: true, raison: null, nuits: voulues, detail, total, devise: bien.currency || 'EUR' }
}

// Les prix sont manipules en unite monetaire (euros), pas en centimes : c'est ce
// que porte `calendar_inventory.rate` et `properties.base_price`. On arrondit au
// centime a chaque etape pour qu'une somme de nuits ne derive pas en flottant.
function arrondir (n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

module.exports = {
  HORIZON_JOURS,
  STATUTS_OCCUPANTS,
  ajouterJours,
  estDateIso,
  fenetre,
  bornerJours,
  raisonNonVendable,
  prixDeBase,
  multiplicateur,
  prixCoefficiente,
  supplementVoyageurs,
  construireCalendrier,
  nuitPublique,
  validerSejour,
  arrondir
}
