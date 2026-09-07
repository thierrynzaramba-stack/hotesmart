// tests/moteur-paiement.test.js
// Spec : docs/specs/spec-moteur-reservation.md §2 (ordre) et §5.2
//
// CE QUE CES TESTS DEFENDENT : la logique d'argent.
//   - le montant vient du DEVIS SERVEUR, en centimes entiers
//   - une cle d'idempotence = une vente = un debit
//   - les transitions de statut resistent aux webhooks rejoues et desordonnes
//   - la tenue des nuits SURVIT a la page de paiement
//   - la garde de l'etape 2 est fermee par defaut

const test = require('node:test')
const assert = require('node:assert')
const P = require('../lib/moteur-paiement')

const devis = (total, ok) => ({ ok: ok !== false, total })

// ─── Le montant ─────────────────────────────────────────────────────────────
test('le montant est en CENTIMES ENTIERS', () => {
  assert.equal(P.montantEnCentimes(devis(240)), 24000)
  assert.equal(P.montantEnCentimes(devis(94.6)), 9460)
  assert.equal(P.montantEnCentimes(devis(0.01)), 1)
})

test('les flottants ne derivent pas jusqu au debit', () => {
  // 3 x 89.99 se somme en 269.96999999999997 : arrondi au centime, pas tronque.
  assert.equal(P.montantEnCentimes(devis(89.99 * 3)), 26997)
})

test('un devis REFUSE ou absurde ne produit AUCUN montant', () => {
  // Mieux vaut ne pas encaisser que d'encaisser au hasard.
  for (const mauvais of [null, undefined, devis(240, false), devis(0), devis(-10),
                         devis(NaN), devis('gratuit')]) {
    assert.equal(P.montantEnCentimes(mauvais), null, JSON.stringify(mauvais))
  }
})

test('une devise sans decimale n est pas multipliee par cent', () => {
  // L erreur serait un facteur 100 sur le debit — elle ne se rattrape pas.
  assert.equal(P.montantStripe(devis(2400), 'JPY'), 2400)
  assert.equal(P.montantStripe(devis(2400), 'jpy'), 2400)
  assert.equal(P.montantStripe(devis(2400), 'EUR'), 240000)
  assert.equal(P.montantStripe(devis(240), null), 24000)
})

// ─── L idempotence ──────────────────────────────────────────────────────────
const vente = {
  lienId: 'lien-1', arrival: '2026-10-01', departure: '2026-10-04',
  personnes: 2, email: 'A.Voyageur@Exemple.COM'
}

test('la meme vente rend TOUJOURS la meme cle', () => {
  assert.equal(P.cleIdempotence(vente), P.cleIdempotence(vente))
  // La casse et les espaces de l e-mail ne creent pas une seconde vente.
  assert.equal(P.cleIdempotence(vente),
               P.cleIdempotence({ ...vente, email: '  a.voyageur@exemple.com  ' }))
})

test('tout ce qui change la VENTE change la cle', () => {
  const base = P.cleIdempotence(vente)
  const variantes = {
    lienId: 'lien-2', arrival: '2026-10-02', departure: '2026-10-05',
    personnes: 3, email: 'autre@exemple.com'
  }
  for (const [champ, valeur] of Object.entries(variantes)) {
    assert.notEqual(P.cleIdempotence({ ...vente, [champ]: valeur }), base, champ)
  }
})

test('LE MONTANT NE FAIT PAS partie de la cle de vente', () => {
  // ⚠ CONSTAT DE REVIEW. Il y figurait, et il DESARMAIT la protection qu il
  // croyait renforcer : une fois les nuits tenues, le devis echoue sur notre
  // propre tenue, `montantStripe` rend null, et la cle calculee au retour du
  // voyageur differait de celle de sa vente. Sa tentative deja PAYEE devenait
  // introuvable, et il lisait « ces nuits ne sont plus disponibles » a propos de
  // nuits qu il venait de payer.
  assert.equal(P.cleIdempotence({ ...vente, montant: 24000 }),
               P.cleIdempotence({ ...vente, montant: 99999 }))
  assert.equal(P.cleIdempotence({ ...vente, montant: null }), P.cleIdempotence(vente))
})

test('la cle envoyee A STRIPE est DISTINCTE, et porte le montant', () => {
  // Stripe REFUSE (400) une cle rejouee avec des parametres differents pendant
  // 24 h. Reutiliser la cle de vente bloquait le voyageur sur ces dates une
  // journee entiere des que le montant changeait.
  assert.notEqual(P.cleStripe('t1', 24000), P.cleIdempotence(vente))
  assert.equal(P.cleStripe('t1', 24000), P.cleStripe('t1', 24000), 'stable a montant egal')
  assert.notEqual(P.cleStripe('t1', 24000), P.cleStripe('t1', 25000), 'un autre prix, une autre Session')
  assert.notEqual(P.cleStripe('t1', 24000), P.cleStripe('t2', 24000))
})

test('la cle ne laisse fuir NI l e-mail NI rien de lisible', () => {
  // Elle finit dans nos journaux et chez Stripe.
  const c = P.cleIdempotence(vente)
  assert.match(c, /^bk_[0-9a-f]{40}$/)
  assert.ok(!c.includes('exemple'))
  assert.ok(!c.includes('2026-10-01'))
})

// ─── Les transitions ────────────────────────────────────────────────────────
test('le chemin normal est permis', () => {
  assert.ok(P.transitionPermise(P.ETAT.EN_ATTENTE, P.ETAT.PAYE))
  assert.ok(P.transitionPermise(P.ETAT.PAYE, P.ETAT.RESERVE))
  assert.ok(P.transitionPermise(P.ETAT.RESERVE, P.ETAT.REMBOURSE))
})

test('un webhook REJOUE apres la reservation ne fait pas RECULER la tentative', () => {
  // Stripe rejoue, et pas toujours dans l ordre. Repasser `booked` a `paid`
  // ferait recreer la reservation a l etape 3.
  assert.equal(P.transitionPermise(P.ETAT.RESERVE, P.ETAT.PAYE), false)
  assert.equal(P.transitionPermise(P.ETAT.REMBOURSE, P.ETAT.PAYE), false)
  assert.equal(P.transitionPermise(P.ETAT.EXPIRE, P.ETAT.PAYE), false)
})

test('rejouer le MEME evenement est sans effet, jamais une erreur', () => {
  for (const e of P.ETATS) assert.ok(P.transitionPermise(e, e), e)
})

test('un paiement refuse ou expire laisse retenter', () => {
  assert.ok(P.transitionPermise(P.ETAT.REFUSE, P.ETAT.EN_ATTENTE))
  assert.ok(P.transitionPermise(P.ETAT.EXPIRE, P.ETAT.EN_ATTENTE))
})

test('un remboursement est un cul-de-sac', () => {
  for (const e of P.ETATS) {
    if (e === P.ETAT.REMBOURSE) continue
    assert.equal(P.transitionPermise(P.ETAT.REMBOURSE, e), false, e)
  }
})

test('un statut inconnu n autorise rien', () => {
  assert.equal(P.transitionPermise('nimporte', P.ETAT.PAYE), false)
  assert.equal(P.transitionPermise(P.ETAT.PAYE, 'nimporte'), false)
})

// ─── La tenue des nuits ─────────────────────────────────────────────────────
test('LA TENUE SURVIT A LA PAGE DE PAIEMENT', () => {
  // Stripe n autorise pas une Session a expirer avant 30 minutes. Une tenue plus
  // courte laisserait un voyageur payer, sur la page encore ouverte, des nuits
  // que nous avons deja reliberees — et peut-etre revendues.
  assert.ok(P.TENUE_MS > P.SESSION_MINUTES * 60 * 1000,
    'la tenue doit depasser la duree de la Session')
  assert.equal(P.SESSION_MINUTES, 30, 'minimum impose par Stripe')
})

test('l expiration de la Session est un horodatage UNIX en SECONDES', () => {
  const t0 = Date.UTC(2026, 8, 7, 12, 0, 0)
  const exp = P.sessionExpireA(t0)
  assert.equal(exp, Math.floor((t0 + 30 * 60 * 1000) / 1000))
  assert.ok(exp < 1e11, 'des millisecondes seraient refusees par Stripe')
})

test('une tenue passee ou absente est expiree', () => {
  const t0 = Date.now()
  assert.equal(P.tenueExpiree({ hold_expires_at: new Date(t0 - 1000).toISOString() }, t0), true)
  assert.equal(P.tenueExpiree({ hold_expires_at: new Date(t0 + 60000).toISOString() }, t0), false)
  assert.equal(P.tenueExpiree(null, t0), true)
  assert.equal(P.tenueExpiree({}, t0), true, 'sans date, on considere expire')
})

// ─── Le voyageur ────────────────────────────────────────────────────────────
test('les coordonnees sont validees et NETTOYEES cote serveur', () => {
  const r = P.nettoyerVoyageur({ prenom: '  Ana  ', nom: ' Lopez ', email: '  A@B.CO ', tel: '06 66 46 52 90' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.voyageur, { prenom: 'Ana', nom: 'Lopez', email: 'a@b.co', tel: '06 66 46 52 90' })
})

test('un champ vide ou faux est refuse avec sa raison', () => {
  const base = { prenom: 'A', nom: 'B', email: 'a@b.co', tel: '0666465290' }
  assert.equal(P.nettoyerVoyageur({ ...base, prenom: '   ' }).raison, 'prenom_manquant')
  assert.equal(P.nettoyerVoyageur({ ...base, nom: '' }).raison, 'nom_manquant')
  assert.equal(P.nettoyerVoyageur({ ...base, email: 'pas-un-email' }).raison, 'email_invalide')
  assert.equal(P.nettoyerVoyageur({ ...base, email: 'a@b' }).raison, 'email_invalide')
  assert.equal(P.nettoyerVoyageur({ ...base, tel: '12345' }).raison, 'telephone_invalide')
  assert.equal(P.nettoyerVoyageur(null).raison, 'prenom_manquant')
})

test('les champs sont bornes : rien d illimite ne part chez le provider', () => {
  const r = P.nettoyerVoyageur({ prenom: 'a'.repeat(500), nom: 'b'.repeat(500),
                                 email: 'c'.repeat(60) + '@exemple.co', tel: '0'.repeat(200) })
  assert.equal(r.ok, true)
  assert.equal(r.voyageur.prenom.length, 80)
  assert.equal(r.voyageur.nom.length, 80)
  assert.equal(r.voyageur.tel.length, 40)
})

test('une adresse LONGUE mais valide n est pas cassee par la troncature', () => {
  // ⚠ Trouve en ecrivant ces tests. La borne etait a 160 : une adresse plus
  // longue etait coupee AVANT validation, perdait son `@`, et le voyageur lisait
  // « e-mail invalide » sur une adresse qui ne l'est pas. La RFC autorise 254.
  const longue = 'a'.repeat(200) + '@exemple.com'   // 212 caracteres, valide
  const r = P.nettoyerVoyageur({ prenom: 'A', nom: 'B', email: longue, tel: '0666465290' })
  assert.equal(r.ok, true, 'une adresse de 212 caracteres est valide')
  assert.equal(r.voyageur.email, longue.toLowerCase())
})

test('la langue est figee sur la tentative, et retombe sur le francais', () => {
  // L e-mail de confirmation doit partir dans la langue ou le voyageur a reserve.
  assert.equal(P.langueValide('es'), 'es')
  assert.equal(P.langueValide('EN'), 'en')
  for (const mauvaise of ['de', '', null, undefined, 'fr-FR', 42]) {
    assert.equal(P.langueValide(mauvaise), 'fr', String(mauvaise))
  }
})

// ─── La garde de l etape 2 ──────────────────────────────────────────────────
test('la garde est FERMEE par defaut : l absence de variable est le cas SUR', () => {
  // Tant que l etape 3 n existe pas, un paiement reussi laisserait de l argent
  // encaisse sans reservation.
  assert.equal(P.paiementAutorise({}), false)
  assert.equal(P.paiementAutorise({ BOOKING_ENGINE_PAYMENT: 'false' }), false)
  assert.equal(P.paiementAutorise({ BOOKING_ENGINE_PAYMENT: '1' }), false)
  assert.equal(P.paiementAutorise({ BOOKING_ENGINE_PAYMENT: 'TRUE' }), false)
  assert.equal(P.paiementAutorise({ BOOKING_ENGINE_PAYMENT: ' true ' }), true)
  assert.equal(P.paiementAutorise({ BOOKING_ENGINE_PAYMENT: 'true' }), true)
})


// ─── CONSTAT DE REVIEW : l expiration derive de la TENUE ───────────────────
test('l expiration de la Session se derive de la tenue, pas de l horloge', () => {
  // Sinon elle change a chaque appel, la cle d idempotence Stripe est rejouee
  // avec des parametres differents, et Stripe repond 400 pendant 24 h.
  const tenue = P.tenueExpireA()
  const a = P.sessionExpireDepuisTenue(tenue)
  const b = P.sessionExpireDepuisTenue(tenue)
  // ⚠ `assert.ok(a !== null)` D ABORD. Sans lui, ce test etait VACUEUX : il
  // passait alors que la fonction rendait `null` en permanence — `null * 1000`
  // vaut 0, et `null === null` est vrai. C est ce trou qui a laisse passer le
  // bloqueur ci-dessous. Constat de review.
  assert.ok(a !== null, 'une tenue neuve DOIT pouvoir porter une Session')
  assert.equal(a, b, 'deux appels doivent rendre la MEME valeur')
  assert.ok(a * 1000 < new Date(tenue).getTime(),
    'la Session doit expirer AVANT la tenue, jamais apres')
})

test('BLOQUEUR : une tenue neuve porte encore une Session une seconde plus tard', () => {
  // ⚠ LE DEFAUT LE PLUS GRAVE DU CHANTIER, trouve en review.
  // La tenue valait 35 min = 30 (minimum Stripe) + 5 de marge. La cible se
  // calcule depuis la POSE, le minimum depuis l INSTANT DE L APPEL : quelques
  // centaines de millisecondes de requetes suffisaient a faire passer la cible
  // sous le minimum. Mesure : `null` des 1,2 seconde apres la pose — AUCUNE
  // Session n aurait jamais pu etre creee, et la tentative repondait 409
  // pendant 35 minutes en tenant les nuits.
  const tenue = P.tenueExpireA(Date.now() - 60 * 1000)   // posee il y a 1 minute
  assert.ok(P.sessionExpireDepuisTenue(tenue) !== null,
    'une tenue posee il y a une minute doit encore porter une Session')

  const cinqMin = P.tenueExpireA(Date.now() - 5 * 60 * 1000)
  assert.ok(P.sessionExpireDepuisTenue(cinqMin) !== null,
    'et cinq minutes plus tard aussi')

  assert.ok(P.TENUE_MINUTES > P.SESSION_MINUTES + P.MARGE_MINUTES,
    'la tenue doit depasser session + marge, AVEC du jeu')
})

test('une tenue trop entamee rend null — l appelant RENOUVELLE, il ne refuse pas', () => {
  // Refuser bloquerait les dates pendant toute la duree restante, sans recours.
  assert.equal(P.sessionExpireDepuisTenue(new Date(Date.now() + 8 * 60 * 1000).toISOString()), null)
  assert.equal(P.sessionExpireDepuisTenue(new Date(Date.now() - 60 * 1000).toISOString()), null)
  // Une date illisible ne se devine pas : null, et l appelant renouvelle.
  assert.equal(P.sessionExpireDepuisTenue('pas une date'), null)
  assert.equal(P.sessionExpireDepuisTenue(null), null)
})

test('la cle Stripe change quand la TENUE est renouvelee', () => {
  // `expires_at` en derive : une tenue renouvelee change ce parametre, et Stripe
  // refuse (400) une cle rejouee avec des parametres differents. Sans la tenue
  // dans la cle, tout renouvellement bloquait le voyageur 24 h.
  const h1 = P.tenueExpireA(Date.UTC(2026, 8, 7, 12, 0, 0))
  const h2 = P.tenueExpireA(Date.UTC(2026, 8, 7, 12, 30, 0))
  assert.equal(P.cleStripe('t1', 24000, h1), P.cleStripe('t1', 24000, h1))
  assert.notEqual(P.cleStripe('t1', 24000, h1), P.cleStripe('t1', 24000, h2))
})
