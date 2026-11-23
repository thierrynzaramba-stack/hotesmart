// tests/revenus-net-hote.test.js — CE QUI ARRIVE SUR LE COMPTE DE L'HOTE
//
// Etape 4 du lot « Aujourd'hui V5 », decision Q3 de Thierry du 24 octobre 2026 :
// montants NETS, commissions deduites, hors taxe de sejour ; et quand la
// commission n'est pas connue, on affiche le BRUT et la ligne le DIT.
//
// ⚠ CE QUE CES TESTS GARDENT N'EST PAS UN CALCUL, C'EST UNE DISTINCTION : un
// `net: false` n'est pas un `valeur: null`, et aucun des deux n'est un zero.
// Les trois se ressemblent dans une somme et ne veulent pas dire la meme
// chose — « brut, commission inconnue » (un chiffre vrai mais incomplet),
// « non calculable » (aucun chiffre) et « zero » (un fait). Le depot a deja
// paye cette confusion : `docs/kb/restitution-yield.md` l'ouvre la-dessus.

const test = require('node:test')
const assert = require('node:assert/strict')
const { netDuSejour, MOTIFS } = require('../lib/revenus/net-hote')

// Les quatre formes de payload, telles que le coeur les porte.
const airbnb = (amount, fee, extra = {}, rawExtra = {}) => netDuSejour(
  { provider: 'channex', source: 'airbnb', arrival: '2026-11-10', departure: '2026-11-13', ...extra },
  { amount, meta: { amount_type: 'Payout Amount' }, notes: `Listing Cancellation Host Fee: ${fee}\n`, ...rawExtra })

const booking = (centimes, extra = {}) => netDuSejour(
  { provider: 'channex', source: 'bookingcom', ...extra },
  { rooms: [{ meta: { price_details: { guest_view: { total: { amount: centimes, decimal_places: 2 } } } } }] })

const offline = (amount) => netDuSejour({ provider: 'channex', source: 'offline' }, { amount })

const beds24 = (price, commission, canal = 'airbnb') => netDuSejour(
  { provider: 'beds24', source: canal }, { price, commission })

test('LE TEST QUI COMPTE : chez Airbnb, le net est `amount` — pas une soustraction approchee', () => {
  // ⚠ `amount` EST DEJA LE NET HOTE (reglage `Payout Amount` que HoteSmart pose
  // a la connexion), et `prixVoyageur` reconstruit le total en lui AJOUTANT le
  // Host Fee. Retirer ce meme Host Fee doit donc rendre `amount` au centime —
  // sinon c'est que l'aller-retour perd quelque chose.
  for (const [a, f] of [['400.00', '12.00'], ['333.33', '10.01'], ['0.10', '0.03'],
    ['1234.56', '37.04'], ['99.99', '3.00'], ['12.34', '0.01']]) {
    const r = airbnb(a, f)
    assert.equal(r.valeur, Number(a), `amount ${a} + fee ${f} ne rend pas ${a}`)
    assert.equal(r.net, true)
    assert.equal(r.commission, Number(f))
    assert.equal(r.motif, null)
  }
})

test('LE TEST QUI COMPTE : Booking.com rend un BRUT, et le dit', () => {
  // La commission de Booking.com n'est dans aucun payload. Le chiffre est vrai
  // — c'est bien ce que le voyageur a paye — mais il n'est pas un net.
  const r = booking(50000)
  assert.equal(r.valeur, 500)
  assert.equal(r.net, false, 'un brut annonce comme un net ferait croire a un revenu qui n existe pas')
  assert.equal(r.commission, null)
  assert.equal(r.motif, MOTIFS.commission_inconnue)
  assert.match(String(r.detail), /Booking\.com ne transmet pas/)
})

test("LE TEST QUI COMPTE : `net: false` n'est NI un zero NI un `null`", () => {
  // ⚠ LES TROIS SE RESSEMBLENT DANS UNE SOMME ET NE DISENT PAS LA MEME CHOSE.
  // C'est la seule chose que ce module existe pour tenir.
  const brut = booking(50000)            // un chiffre vrai, incomplet
  const rien = airbnb('400.00', 'xx')    // aucun chiffre
  const zero = offline('0')              // refuse en amont : 0 n'est pas un prix

  assert.equal(brut.valeur, 500)
  assert.notEqual(brut.valeur, 0, 'un brut n est pas un zero')
  assert.equal(brut.net, false)

  assert.equal(rien.valeur, null, 'un Host Fee illisible ne donne pas un chiffre')
  assert.ok(rien.motif, 'un `null` sans motif est un trou que personne ne saura expliquer')

  assert.equal(zero.valeur, null, 'un montant nul est refuse, pas rendu comme un revenu de 0 €')
  assert.ok(zero.motif)
})

test('la vente directe est nette par construction, commission ZERO et non « inconnue »', () => {
  // ⚠ ET CE N'EST PAS LA MEME CHOSE. Nous ecrivons ces reservations nous-memes
  // (primitive CRS) : personne ne preleve rien. Les dire « brut » ferait porter
  // a l'hote un doute qui n'existe pas, sur le seul canal ou il n'y a rien a
  // douter.
  const r = offline('300.00')
  assert.equal(r.valeur, 300)
  assert.equal(r.net, true)
  assert.equal(r.commission, 0)
  assert.equal(r.motif, null)
})

test('Beds24 : la commission se deduit quand elle est servie', () => {
  const r = beds24(100, 30)
  assert.equal(r.valeur, 70)
  assert.equal(r.net, true)
  assert.equal(r.commission, 30)
})

test('LE TEST QUI COMPTE : une commission a ZERO chez Beds24 ne vaut pas la meme chose selon le canal', () => {
  // ⚠ `eclatement.js` a deja grave la distinction : « une resa OTA dont Beds24
  // remet price et commission a zero » existe. Prendre ce zero pour « aucune
  // commission » transformerait un BRUT en net, et personne ne le verrait.
  const direct = beds24(100, 0, 'direct')
  assert.equal(direct.net, true, 'une vente directe sans commission EST nette')
  assert.equal(direct.commission, 0)
  assert.equal(direct.valeur, 100)

  const ota = beds24(100, 0, 'airbnb')
  assert.equal(ota.net, false, 'une OTA a commission nulle est un brut, pas un net')
  assert.equal(ota.commission, null)
  assert.equal(ota.motif, MOTIFS.commission_inconnue)
  assert.equal(ota.valeur, 100, 'le chiffre reste affichable — c est son ETIQUETTE qui change')
})

test('LE TEST QUI COMPTE : une commission qui depasse le prix est REFUSEE, pas soustraite', () => {
  // Un net negatif qu'un total absorberait ne se voit pas dans une somme de six
  // chiffres. Mesure : c'est chez Beds24 que ce cas est atteignable.
  for (const [p, c] of [[100, 150], [100, 100], [10, 10.01]]) {
    const r = beds24(p, c)
    assert.equal(r.valeur, null, `price ${p} / commission ${c} rend un chiffre`)
    assert.equal(r.motif, MOTIFS.commission_aberrante)
    assert.match(String(r.detail), /commission/)
  }
  // Et juste en dessous du seuil, ca passe : la garde ne mord pas trop large.
  assert.equal(beds24(100, 99.99).valeur, 0.01)
})

test("LE TEST QUI COMPTE : chez Airbnb, la garde « commission aberrante » est INATTEIGNABLE — et c'est mesure, pas suppose", () => {
  // ⚠ CE TEST EXISTE PARCE QUE J'AVAIS ECRIT LE CONTRAIRE. Ma premiere version
  // posait ici une garde `frais >= prix` et un commentaire jurant qu'elle
  // protegeait d'un net negatif. Elle ne peut pas mordre : `prixVoyageur` rend
  // `amount + frais`, donc le prix est toujours superieur aux frais des que
  // `amount > 0`, et `amount <= 0` est deja refuse en amont.
  //
  // Une garde inatteignable dont le commentaire jure qu'elle protege est le
  // defaut que ce depot passe son temps a corriger : elle ne rougit jamais, et
  // elle fait croire que la question est traitee. Ce test tient la verite a sa
  // place — si un jour le calcul d'Airbnb change et que ce cas devient
  // possible, il rougira et on posera une vraie garde.
  for (const [a, f] of [['10.00', '500.00'], ['0.01', '9999.00'], ['1.00', '1.00']]) {
    const r = airbnb(a, f)
    assert.equal(r.motif, null, `amount ${a} / fee ${f} : le refus est devenu atteignable, poser une vraie garde`)
    assert.equal(r.valeur, Number(a))
    assert.ok(r.valeur > 0, 'le net reste positif, par construction')
  }
})

test('un couple (provider, canal) non prevu ne rend JAMAIS un chiffre', () => {
  for (const s of [
    { provider: 'channex', source: 'expedia' },
    { provider: 'channex', source: 'vrbo' },
    { provider: 'autre', source: 'x' },
    { provider: '', source: '' },
    {}
  ]) {
    const r = netDuSejour(s, { amount: '100.00' })
    assert.equal(r.valeur, null, `${JSON.stringify(s)} rend un chiffre`)
    assert.equal(r.net, null, 'ni net ni brut : on ne sait pas')
    assert.ok(r.motif, 'un refus sans motif n envoie chercher nulle part')
  }
  // ⚠ ET CE TEST NE GARDE PAS LE CHEMIN QU'IL A L'AIR DE GARDER — je l'ai
  // mesure, et c'est pour ca que celui d'apres existe. Ces cinq payloads sont
  // refuses par `prixVoyageur` EN AMONT, donc le dernier `return` de
  // `netDuSejour` — celui qui dit « canal_inconnu » — n'est jamais atteint.
  // Contre-epreuve par mutation : remplacer ce `return` par un repli sur le
  // brut laisse la suite au VERT (`fail 0`). Le titre de ce test disait « ne
  // rend jamais un BRUT » ; il ne prouvait que « ne rend jamais un chiffre »,
  // ce qui est vrai et plus faible. C'est exactement le defaut qu'une review
  // vient de me trouver ailleurs : un test qui n'exerce pas le chemin qu'il
  // pretend garder.
})

test("LE TEST QUI COMPTE : TOUT prix calculable repart avec une etiquette net ou brut", () => {
  // ⚠ L'INVARIANT, A LA PLACE DU CHEMIN MORT. On ne peut pas atteindre le
  // dernier `return` de `netDuSejour` aujourd'hui, parce que les quatre couples
  // que `prixVoyageur` accepte sont tous traites au-dessus. Le risque reel
  // n'est donc pas ce chemin : c'est que `prixVoyageur` apprenne un CINQUIEME
  // canal et que ce module ne le suive pas. Ce test-la le voit.
  //
  // La regle gardee : si un prix est calculable, alors `net` vaut `true` ou
  // `false` — jamais `null`. Un chiffre sans etiquette entrerait dans un total
  // sans qu'on sache s'il est complet, et c'est precisement ce que la decision
  // Q3 de Thierry interdit.
  const CANAUX = ['airbnb', 'AirBNB', 'bookingcom', 'booking.com', 'offline',
    'direct', 'expedia', 'vrbo', 'homeaway', 'abritel', '', 'Offline']
  const PROVIDERS = ['channex', 'beds24', 'CHANNEX', '', null]
  const PAYLOADS = [
    { amount: '400.00', meta: { amount_type: 'Payout Amount' }, notes: 'Listing Cancellation Host Fee: 12.00\n' },
    { rooms: [{ meta: { price_details: { guest_view: { total: { amount: 50000, decimal_places: 2 } } } } }] },
    { price: 200, commission: 30 },
    { price: 200, commission: 0 },
    { amount: '150.00' }
  ]
  let calculables = 0
  for (const provider of PROVIDERS) {
    for (const source of CANAUX) {
      for (const raw of PAYLOADS) {
        const r = netDuSejour({ provider, source }, raw)
        if (r.valeur == null) {
          assert.ok(r.motif, `(${provider}/${source}) refuse sans motif`)
          continue
        }
        calculables++
        assert.ok(r.net === true || r.net === false,
          `(${provider}/${source}) rend ${r.valeur} avec net = ${String(r.net)} : un chiffre sans etiquette`)
        // Un brut dit POURQUOI il n'est pas net ; un net n'a rien a expliquer.
        if (r.net === false) assert.ok(r.motif, `(${provider}/${source}) est un brut sans motif`)
        else assert.equal(r.motif, null, `(${provider}/${source}) est net ET porte un motif`)
        assert.ok(r.valeur > 0, `(${provider}/${source}) rend un montant non positif`)
      }
    }
  }
  // ⚠ ET LE COMPTE EST CHIFFRE, PAS BORNE. Un balayage qui ne trouve aucun cas
  // calculable passerait au vert sans rien mesurer — le faux vert de cette
  // famille. 300 combinaisons essayees, 40 donnent un prix.
  //
  // ⚠ J'AVAIS ECRIT 22, DE MEMOIRE, ET CE TEST L'A ATTRAPE. C'est exactement
  // son office : un nombre suppose est indistinguable d'un nombre mesure une
  // fois qu'il est ecrit. Voici donc la decomposition, mesuree, pour que le 40
  // soit COMPRIS et pas seulement fige — un `ATTENDU` qu'on ne sait pas
  // expliquer se met a jour mecaniquement au premier rouge, et il ne garde
  // plus rien :
  //    4  channex  airbnb-like  net   (airbnb, AirBNB, offline, Offline)
  //    4  CHANNEX  airbnb-like  net   (la casse du provider est ignoree)
  //    2  channex  amount-nu    net   (offline, Offline)
  //    2  CHANNEX  amount-nu    net
  //    2  channex  booking-like BRUT  (bookingcom, booking.com)
  //    2  CHANNEX  booking-like BRUT
  //   12  beds24   com=30       net   (les 12 canaux : la commission est servie)
  //   11  beds24   com=0        BRUT  (les 11 canaux non directs)
  //    1  beds24   com=0        net   (direct : personne ne preleve)
  //   --
  //   40
  // Ce que ce compte garantit : si `prixVoyageur` apprend un cinquieme canal
  // et que ce module ne le suit pas, le total bouge et le test parle.
  assert.equal(calculables, 40,
    'le nombre de combinaisons calculables a change : un canal a ete ajoute ou retire en amont, '
    + 'verifier que `netDuSejour` le traite et mettre ce compte a jour AVEC sa decomposition')
})

test('le motif de l amont est CONSERVE, jamais ecrase par un refus generique', () => {
  // `prixVoyageur` a quatorze raisons de refuser, toutes precises. Les remplacer
  // par « prix non calculable » ferait perdre la seule information qui dit OU
  // regarder — et c'est l'hote qui appellerait pour demander pourquoi.
  const r = airbnb('400.00', '12.00', {}, { meta: { amount_type: 'Listing Base Price' } })
  assert.equal(r.valeur, null)
  assert.equal(r.motif, MOTIFS.prix_non_calculable)
  assert.match(String(r.detail), /amount_type/, 'le detail de l amont est perdu')
})

test('aucun appel ne leve, quelle que soit la forme du payload', () => {
  // Un module de revenus qui leve fait disparaitre TOUT le bloc, pas une ligne.
  for (const [s, r] of [
    [null, null], [undefined, undefined], [{}, {}],
    [{ provider: 'channex', source: 'airbnb' }, { amount: null, notes: null }],
    [{ provider: 'beds24', source: 'direct' }, { price: 'x', commission: 'y' }],
    [{ provider: 'channex', source: 'airbnb' }, { amount: '10', meta: { amount_type: 'Payout Amount' }, notes: 'Listing Cancellation Host Fee: 1.2.3\n' }]
  ]) {
    const out = netDuSejour(s, r)
    assert.ok(out && typeof out === 'object')
    assert.ok('valeur' in out && 'net' in out && 'commission' in out && 'motif' in out)
  }
})

test("LE TEST QUI COMPTE : une commission qui n'est ni un nombre ni une chaine est REFUSEE", () => {
  // ⚠ `Number(true)` VAUT 1, ET CE MODULE L'ACCEPTAIT — constat de la review du
  // 26 octobre 2026, et un trou que ma contre-epreuve par mutation a confirme :
  // retirer la garde laissait la suite au VERT, parce qu'aucun test ne passait
  // de commission piegeuse.
  //
  // Mesure, sur un `price: 200` Beds24, AVANT le correctif :
  //   commission true    -> net 199, com 1,  etiquete `net: true`
  //   commission ["30"]  -> net 170, com 30, etiquete `net: true`
  //   commission {}      -> net 170 si l'objet porte un `valueOf`
  // Un net qui n'est pas le net, et AUCUN drapeau pour le dire.
  //
  // Le module frere `lib/revenus/versement.js` ferme exactement ce trou sur dix
  // lignes de commentaire (« un booleen devenait un jour ») : les deux modules
  // du meme lot ne se tenaient pas au meme standard.
  const PIEGES = [true, false, ['30'], [30], [], {}, { valueOf: () => 30 }, () => 30, Symbol, new Date()]
  for (const c of PIEGES) {
    const r = beds24(200, c)
    assert.equal(r.net, false, `commission ${String(c)} est acceptee comme un net`)
    assert.equal(r.commission, null, `commission ${String(c)} donne un montant de commission`)
    assert.equal(r.valeur, 200, 'le prix voyageur a ete ampute par une commission inventee')
    assert.equal(r.motif, MOTIFS.commission_inconnue)
  }
  // Et les formes LEGITIMES passent toujours : un nombre, une chaine numerique.
  assert.equal(beds24(200, 30).valeur, 170)
  assert.equal(beds24(200, '30').valeur, 170)
  assert.equal(beds24(200, '30.50').valeur, 169.5)
  // Une chaine a virgule n'est pas un nombre : on refuse plutot que de deviner.
  assert.equal(beds24(200, '30,50').net, false)
})
