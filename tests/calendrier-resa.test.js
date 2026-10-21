// tests/calendrier-resa.test.js
// Etape 3 : fiche de reservation et ajout depuis le calendrier
// (spec-reservation-manuelle.md §5).
//
// Ces tests portent sur ce qui est verifiable sans navigateur : la forme des
// donnees servies par l'endpoint calendrier, et les invariants du front qu'on
// peut lire dans le fichier (gardes de droits, absence de bouton trompeur).

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const PAGE_BRUTE = fs.readFileSync(path.join(__dirname, '..', 'pages', 'calendrier.html'), 'utf8')
// ⚠ On teste le CODE, pas les commentaires. Les explications citent volontiers
// ce qu'on a supprime (« l'ancienne version faisait SRC[idx % 3] ») : chercher
// ces chaines dans le fichier brut ferait echouer un test sur sa propre
// documentation.
const PAGE = PAGE_BRUTE.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
const MOBILE = fs.readFileSync(path.join(__dirname, '..', 'pages', 'calendrier.html'), 'utf8')
const CAL = fs.readFileSync(path.join(__dirname, '..', 'api', 'calendar.js'), 'utf8')
// Chantier calendrier mobile (30 septembre 2026) : la regle des reservations vit
// dans un module COMMUN aux deux ecrans. Les tests qui la cherchaient dans la
// page ordinateur la cherchent la ou elle est, et verifient que la page
// l'importe (REVIEW.md regle 17 : le test suit la regle, pas son emplacement).
const MODULE = fs.readFileSync(path.join(__dirname, '..', 'shared', 'calendrier-resa.js'), 'utf8')
const MOBILE_CODE = MOBILE.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// ─── L'endpoint sert ce qu'il faut a la fiche ───────────────────────────────

test('front : le bien porte provider_property_id, sans quoi RIEN ne fonctionne', () => {
  // RETARGE 13/10/2026 : les anciennes pages redirigent vers la V5.
  assert.match(PAGE, /propertyId: bien\.provider_property_id/)
})

test('front : le nom du voyageur est echappe dans l\'attribut ET le libelle', () => {
  assert.match(PAGE, /title="\$\{esc\(\(r\.name \|\| ''\)/)
  assert.match(PAGE, /\$\{esc\(court\)\}/)
})

test('front : la saisie clavier ne demarre que depuis une cellule focalisee, en vue Prix', () => {
  // L'ancien bug : une frappe demarrait l'edition DERRIERE une modale.
  // V5 : le raccourci vit sur la CELLULE, les chiffres refusent hors vue Prix.
  assert.match(PAGE, /td\.addEventListener\('keydown'/)
  assert.match(PAGE, /if \(chiffre && etat\.vueMobile !== 'rate'\) return/)
})

test('front : le bouton de validation est reinitialise a chaque ouverture', () => {
  // V5 : la feuille est RECONSTRUITE a chaque ouverture ; sur un refus le
  // bouton est REACTIVE explicitement.
  assert.match(PAGE, /bouton\.disabled = true/)
  assert.match(PAGE, /bouton\.disabled = false/)
})

test('calendrier : chaque reservation porte son booking_id', () => {
  // Sans lui, le bandeau n'est qu'un rectangle : aucune fiche n'est possible.
  assert.match(CAL, /booking_id:\s*String\(row\.booking_id\)/)
  // Liste de colonnes non figee : `metaSource` s'y est ajoutee le 15 septembre
  // 2026. L'invariant teste reste que `booking_id` est bien lu et servi.
  assert.match(CAL, /\.select\('booking_id, property_id, snapshot/)
})

test('calendrier : le detail necessaire a la fiche est servi', () => {
  for (const champ of ['amount', 'currency', 'commission', 'numAdult', 'numChild', 'otaReservationCode']) {
    assert.ok(CAL.includes(champ + ':'), `${champ} doit etre servi par l'endpoint`)
  }
})

// ─── La source n'est plus tiree au sort ─────────────────────────────────────

test('calendrier : la source vient du cœur, pas d\'un index', () => {
  // ⚠ REGRESSION HISTORIQUE. mapResa faisait `SRC[idx % 3]` : airbnb, booking et
  // direct en rotation par index. Les pastilles de canal etaient donc fausses —
  // une reservation Airbnb pouvait s'afficher « direct ».
  // ⚠ ET SUR LE TELEPHONE, qui l'avait garde jusqu'au 30 septembre 2026.
  for (const code of [PAGE, MOBILE_CODE]) {
    assert.ok(!/SRC\[idx\s*%\s*3\]/.test(code), 'la source ne doit plus dependre de l\'index')
    assert.ok(!/const SRC\s*=\s*\[/.test(code), 'le tableau de sources factices a disparu')
    assert.match(code, /from '\/shared\/calendrier-resa\.js'/)
  }
  assert.match(MODULE, /export function familleSource/)
  assert.match(MODULE, /sourceBrute/)
})

test('calendrier : « Offline » est reconnu comme une reservation directe', () => {
  assert.match(MODULE, /export function estOffline/)
  assert.match(MODULE, /'offline'/)
})

// ─── Aucun bouton qui promet un pouvoir qu'on n'a pas ───────────────────────

test('fiche : les actions exigent Offline + Channex + droit + pas lecture seule', () => {
  // V5 : la regle est LE module (droitsResa), appele avec le droit reel.
  assert.match(PAGE, /droitsResa\(bien, r, peutEcrire\('reservations'\) && !etat\.lectureSeule\)/)
  assert.match(PAGE, /\$\{droits\.modifiable \?/)
})

test('fiche : une reservation OTA explique POURQUOI elle n\'est pas modifiable', () => {
  assert.match(MODULE, /modifiable uniquement chez/)
  assert.match(PAGE, /esc\(droits\.note \|\| ''\)/)
})

test('ajout : la reservation reste fermee hors Channex, et tout l\'ajout sans droit', () => {
  assert.match(PAGE, /\$\{channex \? '' : 'disabled'\}/)
  assert.match(PAGE, /cal\.booking_channex_only/)
    // ⚠ MOTIF ASSOUPLI LE 21 OCTOBRE 2026. Il exigeait la ligne SUR UNE SEULE
    // LIGNE : reformater le retour anticipe de `renderFlottante` — pour qu'il
    // libere aussi la place reservee a la barre — faisait rougir ce test et
    // deux autres, sans qu'aucune regle n'ait bouge. Un test doit tenir la
    // CONDITION, pas sa typographie. La preuve dans le DOM, elle, vit dans
    // tests/calendrier-saisie-prix-dom.test.js (« sans droit d'ecriture :
    // aucun geste ne selectionne » et « en lecture seule : meme refus »).
  assert.match(PAGE, /if \(!jours\.length \|\| etat\.lectureSeule \|\| !peutEcrire\('reservations'\)\)[\s\S]{0,40}barre\.hidden = true/)
  assert.match(PAGE, /\$\{mobile && peut \? `<button type="button" class="cal-btn-plus"/)
})

// ─── La fiche reste ouvrable en consultation ────────────────────────────────

test('fiche : la consultation reste ouverte en lecture seule', () => {
  assert.match(PAGE, /\[data-resa\]'\)\.forEach\(b => b\.addEventListener\('click', \(\) => ouvrirFicheResa\(/)
})

// ─── Le cœur n'est jamais ecrit par le front ────────────────────────────────

test('ajout : aucune ecriture directe du snapshot depuis la page', () => {
  assert.ok(!PAGE.includes('bookings_snapshot'),
    'la reservation doit revenir par le feed, jamais etre ecrite par le calendrier')
})

test('ajout : confirmation en DEUX temps, sans affirmer ce qui n\'est pas vrai', () => {
  // « envoyee » est un fait ; le coeur n'apprend la resa que par le feed.
  assert.match(PAGE, /cal\.booking_sent/)
  const FR = fs.readFileSync(path.join(__dirname, '..', 'shared/i18n/fr.json'), 'utf8')
  assert.match(FR, /Envoyée au canal/)
  assert.match(PAGE, /setTimeout\(\(\) => charger\(\), 8000\)/)
})

// ─── Desktop d'abord ────────────────────────────────────────────────────────

// ⚠ REECRIT LE 30 SEPTEMBRE 2026 (REVIEW.md regle 17). La version d'origine
// figeait « DESKTOP D'ABORD : le mobile reste en consultation pure » (spec §5),
// qui prevoyait le chemin mobile « sur besoin reel constate ». Le besoin est
// venu (Thierry, chantier calendrier mobile) : le mobile porte la fiche,
// l'ajout et la modification — par la MEME regle et les MEMES appels que
// l'ordinateur (tests/calendrier-mobile-parite.test.js).
test('MOBILE RATTRAPE (30 septembre 2026) : fiche et ajout sur telephone, par la regle commune', () => {
  // V5 : UNE page pour les deux ecrans — par CONSTRUCTION.
  assert.ok(PAGE.includes('function brancherMobile'), 'le telephone est branche')
  assert.ok(PAGE.includes('ouvrirFicheResa'), 'la fiche existe sur mobile')
  assert.ok(PAGE.includes("appel('/api/reservation-directe'"), 'l ajout existe (writer unique)')
})

// ─── L'endpoint d'ecriture ──────────────────────────────────────────────────

const API = fs.readFileSync(path.join(__dirname, '..', 'api', 'reservation-directe.js'), 'utf8')

test('endpoint : garde serveur en ecriture, pas seulement l\'interface', () => {
  assert.match(API, /domaine: 'reservations', niveau: 'write'/)
  assert.match(API, /compteDelegue: true/)
})

test('endpoint : refuse les biens non Channex explicitement', () => {
  assert.match(API, /provider_sans_ecriture/)
})

test('endpoint : n\'annule QUE des reservations Offline, verifiees dans le cœur', () => {
  // Une reservation OTA doit etre annulee chez l'OTA ; la toucher par le CRS
  // creerait une divergence entre ce que voit le voyageur et ce que voit l'hote.
  assert.match(API, /source !== 'offline'/)
  assert.match(API, /reservation_ota/)
  assert.ok(API.includes("from('bookings_snapshot')"), 'la verification porte sur le cœur, pas sur le client')
})

test('endpoint : le total est recalcule, jamais recu du client', () => {
  // ⚠ CE TEST PASSAIT A TORT. Il ne verifiait qu'une chaine de caracteres,
  // pendant que le code faisait `amount: amount ?? total` — un POST forge avec
  // `amount: 1` creait une reservation a 1 € pour sept nuits.
  assert.match(API, /const total = \(\(cents \* listeNuits\.length\) \/ 100\)/)
  assert.ok(!/amount\s*\?\?\s*total/.test(API), '`amount` du client ne doit jamais servir')
  assert.ok(!/\bamount,\s*currency/.test(API), '`amount` ne doit meme pas etre destructure du body')
  assert.match(API, /amount: total/, 'le total recalcule est le seul montant envoye')
})

test('endpoint : le PERIMETRE par bien est verifie, pas seulement le compte', () => {
  // `dansPerimetre` rend true des que `bien` est nul : sans ces options, un
  // membre limite au bien A pourrait ecrire sur le bien B du meme compte.
  assert.match(API, /bien: String\(propertyId\)/)
  assert.match(API, /bienRequis: true/)
})

test('endpoint : les appels qui LEVENT sont entoures d\'un try', () => {
  // payloadCRS et verifierDisponibilite jettent volontairement ; sans try,
  // l'hote recevait un 500 sans corps JSON, donc une SyntaxError a l'ecran.
  const post = API.slice(API.indexOf("if (req.method === 'POST')"), API.indexOf("if (req.method === 'DELETE')"))
  assert.ok(/try \{[\s\S]*creerReservationDirecte/.test(post), 'creation protegee')
  const del = API.slice(API.indexOf("if (req.method === 'DELETE')"))
  assert.ok(/try \{[\s\S]*cancelBooking/.test(del), 'annulation protegee')
  assert.ok(del.includes('bien_incomplet'), 'room type / rate plan verifies aussi a l\'annulation')
})

test('endpoint : la somme des days vaut EXACTEMENT le montant', () => {
  // 100,00 sur 3 nuits : 33,33 x 3 = 99,99, que Channex rejetterait.
  assert.match(API, /Math\.round\(Number\(s\.amount/)
  assert.match(API, /total - base \* \(listeNuits\.length - 1\)/)
})

test('endpoint : un conflit de disponibilite rend 409, pas 400', () => {
  assert.match(API, /nuits_completes/)
  assert.match(API, /409/)
})

// ─── Retouches du formulaire (7 septembre 2026) ─────────────────────────────

test('formulaire : prenom et nom sont DEUX champs', () => {
  assert.match(PAGE, /data-aj="prenom"/)
  assert.match(PAGE, /data-aj="nom"/)
  assert.ok(!PAGE.includes("nomComplet.split(' ')"))
  assert.match(PAGE, /name: prenom/)
  assert.match(PAGE, /surname: nom/)
})

test('formulaire : le TOTAL du sejour est affiche avant validation', () => {
  assert.match(PAGE, /majCapaciteEtTotal/)
  assert.match(PAGE, /cal\.total_stay/)
  assert.match(PAGE, /\[data-aj\]'\)\.forEach\(x => x\.addEventListener\('input', majCapaciteEtTotal\)\)/)
})

test('formulaire : les voyageurs sont plafonnes a la CAPACITE du bien', () => {
  assert.ok((PAGE.match(/messageCapacite\(adultes, enfants, Number\(bien\.capacity\) \|\| 99\)/g) || []).length >= 3)
  assert.ok(!/au maximum — vous en avez saisi/.test(PAGE))
  assert.match(MODULE, /au maximum/)
})

test('endpoint : le plafond de capacite est REVERIFIE cote serveur', () => {
  // Une garde d'interface n'est pas une garde : rien n'empeche un appel direct.
  assert.match(API, /capacite_depassee/)
  assert.match(API, /personnes > capacite/)
  assert.match(API, /capacity/)
})

// ─── Durcissement issu de la review du 7 septembre ──────────────────────────

test('endpoint : CHAQUE compteur de voyageurs est valide, pas seulement la somme', () => {
  // `{adults: 10, children: -7}` donnait 3 <= 4 : garde franchie, et `adults: 10`
  // transmis tel quel. `{children: {}}` donnait NaN, et toute comparaison avec
  // NaN etant fausse, la garde etait sautee.
  assert.match(API, /const entierPositif/)
  assert.match(API, /Number\.isInteger\(n\) && n >= 0/)
  assert.match(API, /adultes === null \|\| enfants === null \|\| bebes === null/)
})

test('endpoint : `infants` entre dans le plafond', () => {
  // Il echappait au compte : {adults:2, children:2, infants:99} passait.
  assert.match(API, /occupancy\?\.infants/)
  assert.match(API, /const personnes = adultes \+ enfants \+ bebes/)
})

test('endpoint : l\'occupancy ENVOYEE est celle qui a ete validee', () => {
  // L'objet brut du client etait reexpedie au provider, pas les valeurs verifiees.
  assert.match(API, /occupancy: \{ adults: adultes, children: enfants, infants: bebes \}/)
  assert.ok(!/occupancy: occupancy \|\| \{\}/.test(API), 'plus de reexpedition brute')
})

test('endpoint : le refus de capacite porte une PHRASE, pas un code', () => {
  // api-client construit son Error a partir de `data.error` : l'hote lisait
  // « capacite_depassee » a l'ecran.
  assert.match(API, /error: `Ce bien accueille/)
  assert.match(API, /code: 'capacite_depassee'/)
})

test('endpoint : le prix par nuit est arrondi au centime avant repartition', () => {
  // 33.335 x 3 : somme des jours 100.02 contre total 100.01, rejete en 422.
  assert.match(API, /const cents = Math\.round\(parNuit \* 100\)/)
  assert.match(API, /\(\(cents \* listeNuits\.length\) \/ 100\)/)
})

test('formulaire : le total porte la DEVISE DU BIEN, pas « € » en dur', () => {
  assert.match(PAGE, /prixIntl\(prix \* nuits, bien\.currency, langue\(\)\)/)
  assert.ok(!/toFixed\(2\) \+ ' €/.test(PAGE))
})

test('formulaire : les compteurs sont reinitialises ET verifies a l\'ouverture', () => {
  // V5 : le formulaire est RECONSTRUIT avec ses defauts, capacite verifiee
  // immediatement (majCapaciteEtTotal() a l'ouverture).
  assert.match(PAGE, /value="2" data-aj="adultes"/)
  assert.match(PAGE, /value="0" data-aj="enfants"/)
  assert.match(PAGE, /majCapaciteEtTotal\(\)/)
})

test('formulaire : l\'avertissement de capacite n\'ecrase pas le message d\'etat', () => {
  // data-aj-etat porte « Envoi… » et les refus ; la capacite a SA zone.
  assert.match(PAGE, /data-aj-capacite/)
  assert.match(PAGE, /data-aj-etat/)
})
