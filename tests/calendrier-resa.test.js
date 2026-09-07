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

const PAGE_BRUTE = fs.readFileSync(path.join(__dirname, '..', 'pages', 'biens-calendrier.html'), 'utf8')
// ⚠ On teste le CODE, pas les commentaires. Les explications citent volontiers
// ce qu'on a supprime (« l'ancienne version faisait SRC[idx % 3] ») : chercher
// ces chaines dans le fichier brut ferait echouer un test sur sa propre
// documentation.
const PAGE = PAGE_BRUTE.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
const MOBILE = fs.readFileSync(path.join(__dirname, '..', 'pages', 'calendrier-mobile.html'), 'utf8')
const CAL = fs.readFileSync(path.join(__dirname, '..', 'api', 'calendar.js'), 'utf8')

// ─── L'endpoint sert ce qu'il faut a la fiche ───────────────────────────────

test('front : le bien porte provider_property_id, sans quoi RIEN ne fonctionne', () => {
  // ⚠ mapBien ne le recopiait pas : JSON.stringify supprimait la cle et le
  // serveur repondait « propertyId manquant ». Creation ET annulation
  // echouaient a 100 % des cas.
  assert.match(PAGE, /provider_property_id:p\.provider_property_id/)
})

test('front : le nom du voyageur est echappe dans l\'attribut ET le libelle', () => {
  // Un nom venu d'une OTA contenant un guillemet cassait l'attribut `title`.
  assert.match(PAGE, /title="'\+escapeHtmlLocal\(bk\.name/)
  assert.match(PAGE, /const nameShort=escapeHtmlLocal\(/)
})

test('front : TOUS les overlays neutralisent le raccourci clavier', () => {
  // Le focus peut etre sur un <button> d'une modale : une frappe demarrait
  // l'edition d'un tarif DERRIERE la fenetre.
  assert.match(PAGE, /\['overlay','overlay-ajout','overlay-resa'\]/)
})

test('front : le bouton de validation est reinitialise a chaque ouverture', () => {
  // Sinon, apres une creation reussie, il restait « Envoi… » et desactive.
  const bloc = PAGE.slice(PAGE.indexOf('function ouvrirFormulaireAjout'), PAGE.indexOf('function fermerFormulaireAjout'))
  assert.ok(bloc.includes('btnV.disabled = false'))
})

test('calendrier : chaque reservation porte son booking_id', () => {
  // Sans lui, le bandeau n'est qu'un rectangle : aucune fiche n'est possible.
  assert.match(CAL, /booking_id:\s*String\(row\.booking_id\)/)
  assert.match(CAL, /\.select\('booking_id, property_id, snapshot'\)/)
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
  assert.ok(!/SRC\[idx\s*%\s*3\]/.test(PAGE), 'la source ne doit plus dependre de l\'index')
  assert.ok(!/const SRC\s*=\s*\[/.test(PAGE), 'le tableau de sources factices a disparu')
  assert.match(PAGE, /function familleSource/)
  assert.match(PAGE, /sourceBrute/)
})

test('calendrier : « Offline » est reconnu comme une reservation directe', () => {
  assert.match(PAGE, /function estOffline/)
  assert.match(PAGE, /'offline'/)
})

// ─── Aucun bouton qui promet un pouvoir qu'on n'a pas ───────────────────────

test('fiche : les actions exigent Offline + Channex + droit + pas lecture seule', () => {
  const bloc = PAGE.slice(PAGE.indexOf('function ouvrirFicheResa'), PAGE.indexOf('async function annulerResaCourante'))
  assert.ok(bloc.includes('resa.offline'), 'reserve aux reservations directes')
  assert.ok(bloc.includes('channex'), 'reserve aux biens Channex')
  assert.ok(bloc.includes("peutEcrire('reservations')"), 'exige le droit')
  assert.ok(bloc.includes('LECTURE_SEULE'), 'exclut la lecture seule')
})

test('fiche : une reservation OTA explique POURQUOI elle n\'est pas modifiable', () => {
  // Un vide laisserait croire a un bug ; on dit ou aller.
  assert.match(PAGE, /modifiable uniquement chez/)
})

test('ajout : le bouton reste cache hors Channex, sans droit ou en lecture seule', () => {
  const bloc = PAGE.slice(PAGE.indexOf('function showFloatBar'), PAGE.indexOf('function hideFloatBar'))
  assert.ok(bloc.includes("btn-ajouter-resa"))
  assert.ok(bloc.includes('channex'))
  assert.ok(bloc.includes("peutEcrire('reservations')"))
  assert.ok(bloc.includes('LECTURE_SEULE'))
  assert.ok(bloc.includes("style.display = ok ? '' : 'none'"))
})

// ─── La fiche reste ouvrable en consultation ────────────────────────────────

test('fiche : l\'ecouteur est pose AVANT la sortie « lecture seule »', () => {
  const bloc = PAGE.slice(PAGE.indexOf('function attachEvents'))
  const posEcouteur = bloc.indexOf('ouvrirFicheResa')
  const posRetour = bloc.indexOf('if(LECTURE_SEULE) return')
  assert.ok(posEcouteur > -1 && posRetour > -1)
  assert.ok(posEcouteur < posRetour,
    'consulter une reservation n\'est pas ecrire : la fiche doit s\'ouvrir meme en lecture seule')
})

// ─── Le cœur n'est jamais ecrit par le front ────────────────────────────────

test('ajout : aucune ecriture directe du snapshot depuis la page', () => {
  assert.ok(!PAGE.includes('bookings_snapshot'),
    'la reservation doit revenir par le feed, jamais etre ecrite par le calendrier')
})

test('ajout : confirmation en DEUX temps, sans affirmer ce qui n\'est pas vrai', () => {
  // « envoyee » est un fait ; « visible dans HoteSmart » ne peut pas etre affirme
  // a cet instant — la reservation n'existe dans le cœur qu'apres le feed.
  assert.match(PAGE, /Envoyée au canal/)
  assert.match(PAGE, /prochain rafraîchissement/)
})

// ─── Desktop d'abord ────────────────────────────────────────────────────────

test('DESKTOP D\'ABORD : le mobile reste en consultation pure', () => {
  // Decision gravee au §5. Le mobile ne doit porter ni fiche ni formulaire.
  assert.ok(!MOBILE.includes('ouvrirFicheResa'), 'pas de fiche sur mobile')
  assert.ok(!MOBILE.includes('btn-ajouter-resa'), 'pas de bouton d\'ajout sur mobile')
  assert.ok(!MOBILE.includes('reservationDirecte'), 'pas d\'ecriture CRS sur mobile')
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
  assert.match(API, /const total = \(parNuit \* listeNuits\.length\)/)
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
  assert.match(PAGE, /id="ajout-prenom"/)
  assert.match(PAGE, /id="ajout-nom"/)
  // L'ancienne version coupait « Prénom Nom » sur le premier espace : un nom
  // compose partait de travers.
  assert.ok(!PAGE.includes("nomComplet.split(' ')"), 'plus de decoupage a l\'espace')
  assert.match(PAGE, /name: prenom/)
  assert.match(PAGE, /surname: nom/)
})

test('formulaire : le TOTAL du sejour est affiche avant validation', () => {
  assert.match(PAGE, /function rafraichirTotal/)
  assert.match(PAGE, /Total du séjour/)
  // Recalcule a chaque frappe, pas seulement a l'ouverture.
  assert.match(PAGE, /\['ajout-prix','ajout-adultes','ajout-enfants'\]/)
})

test('formulaire : les voyageurs sont plafonnes a la CAPACITE du bien', () => {
  assert.match(PAGE, /function depassementCapacite/)
  assert.match(PAGE, /bien\.capacity/)
  assert.match(PAGE, /au maximum/)
})

test('endpoint : le plafond de capacite est REVERIFIE cote serveur', () => {
  // Une garde d'interface n'est pas une garde : rien n'empeche un appel direct.
  assert.match(API, /capacite_depassee/)
  assert.match(API, /adultes \+ enfants > capacite/)
  assert.match(API, /capacity/)
})
