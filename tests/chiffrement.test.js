// tests/chiffrement.test.js
// Spec : docs/specs/spec-moteur-reservation.md §3 bis, exigence 1
//
// CE QUE CES TESTS DEFENDENT : le premier mecanisme de chiffrement du depot.
// Il protege les cles Stripe des hotes — de quoi encaisser et rembourser chez
// eux. Ce qui suit verifie autant ce qui SORT que ce qui NE SORT PAS.

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')

process.env.BOOKING_SECRET_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')
const C = require('../lib/chiffrement')

const CLE = 'rk_test_' + 'x'.repeat(90)

test('aller-retour : ce qui entre ressort a l identique', () => {
  assert.equal(C.dechiffrer(C.chiffrer(CLE)), CLE)
  assert.equal(C.dechiffrer(C.chiffrer('é à ü 中文 🔑')), 'é à ü 中文 🔑')
})

test('le secret n apparait JAMAIS dans le chiffre', () => {
  const paquet = C.chiffrer(CLE)
  assert.ok(!paquet.includes(CLE))
  assert.ok(!paquet.includes('rk_test'))
  assert.ok(!paquet.includes(CLE.slice(8, 40)))
})

test('deux chiffrements du meme secret different (IV aleatoire)', () => {
  // Sans IV aleatoire, deux hotes qui posent la meme cle produiraient le meme
  // chiffre : on saurait qu'ils partagent un compte Stripe sans rien dechiffrer.
  assert.notEqual(C.chiffrer(CLE), C.chiffrer(CLE))
})

test('le format est versionne, en quatre segments', () => {
  const p = C.chiffrer(CLE).split(':')
  assert.equal(p.length, 4)
  assert.equal(p[0], 'v1')
  assert.ok(C.estChiffre(C.chiffrer(CLE)))
  assert.ok(!C.estChiffre(CLE), 'une cle en clair ne doit pas passer pour chiffree')
  assert.ok(!C.estChiffre('v2:a:b:c'), 'une version inconnue n est pas notre format')
})

// ─── GCM authentifie : c est POUR CA qu on l a choisi ──────────────────────
test('un chiffre ALTERE est rejete, jamais dechiffre en octets quelconques', () => {
  // En CBC, une alteration rend des octets arbitraires qu on enverrait a Stripe.
  const p = C.chiffrer(CLE)
  const casse = p.slice(0, -6) + (p.slice(-6) === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA')
  assert.throws(() => C.dechiffrer(casse))
})

test('un tag d authentification substitue est rejete', () => {
  const [v, iv, , data] = C.chiffrer(CLE).split(':')
  const autreTag = C.chiffrer(CLE).split(':')[2]
  assert.throws(() => C.dechiffrer([v, iv, autreTag, data].join(':')))
})

test('une forme cassee est rejetee, pas devinee', () => {
  for (const mauvais of ['', 'nimporte quoi', 'v1:a:b', 'v1:a:b:c:d', null, undefined, 'v9:a:b:c']) {
    assert.throws(() => C.dechiffrer(mauvais), `« ${String(mauvais)} » aurait du etre refuse`)
  }
})

test('une AUTRE cle de chiffrement ne dechiffre pas', () => {
  const paquet = C.chiffrer(CLE)
  const avant = process.env.BOOKING_SECRET_ENCRYPTION_KEY
  process.env.BOOKING_SECRET_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')
  assert.throws(() => C.dechiffrer(paquet))
  process.env.BOOKING_SECRET_ENCRYPTION_KEY = avant
  assert.equal(C.dechiffrer(paquet), CLE, 'la bonne cle marche toujours')
})

// ─── La cle de chiffrement elle-meme ────────────────────────────────────────
test('une cle de chiffrement absente ou de mauvaise taille est REFUSEE', () => {
  const avant = process.env.BOOKING_SECRET_ENCRYPTION_KEY
  for (const mauvaise of ['', crypto.randomBytes(16).toString('base64'),
                          crypto.randomBytes(31).toString('base64'), 'pas-du-base64!!']) {
    process.env.BOOKING_SECRET_ENCRYPTION_KEY = mauvaise
    assert.throws(() => C.chiffrer(CLE), `cle « ${mauvaise.slice(0, 12)} » aurait du etre refusee`)
  }
  delete process.env.BOOKING_SECRET_ENCRYPTION_KEY
  assert.throws(() => C.chiffrer(CLE), /absente/)
  process.env.BOOKING_SECRET_ENCRYPTION_KEY = avant
})

test('un base64 tronque ne passe PAS pour une cle valide', () => {
  // ⚠ Node ne LEVE PAS sur un base64 invalide : il rend un Buffer plus court.
  // Sans controle de taille, on chiffrerait avec bien moins d entropie que prevu.
  const avant = process.env.BOOKING_SECRET_ENCRYPTION_KEY
  process.env.BOOKING_SECRET_ENCRYPTION_KEY = 'AAAA'
  assert.throws(() => C.chiffrer(CLE), /octets au lieu de 32/)
  process.env.BOOKING_SECRET_ENCRYPTION_KEY = avant
})

test('chiffrer du vide est refuse', () => {
  // Un chiffre de chaine vide serait valide, et passerait plus tard pour une
  // cle posee alors qu il n y en a aucune.
  for (const rien of ['', null, undefined]) assert.throws(() => C.chiffrer(rien))
})

// ─── Ce qu on a le droit de montrer ─────────────────────────────────────────
test('l empreinte donne le mode et 4 caracteres, jamais la cle', () => {
  const e = C.empreinteCle(CLE)
  assert.equal(e.mode, 'test')
  assert.equal(e.restreinte, true)
  assert.equal(e.last4.length, 4)
  assert.ok(!JSON.stringify(e).includes(CLE.slice(0, 30)))
  assert.equal(C.empreinteCle('sk_live_abcd1234').mode, 'live')
  assert.equal(C.empreinteCle('sk_live_abcd1234').restreinte, false)
  assert.equal(C.empreinteCle('nimporte').mode, null)
})

// ─── Les journaux ───────────────────────────────────────────────────────────
test('sansSecrets masque toutes les formes de cle Stripe', () => {
  // Un message d erreur Stripe recopie volontiers la cle fautive, et les
  // journaux Vercel la garderaient lisible bien apres.
  for (const prefixe of ['sk', 'rk', 'pk', 'whsec']) {
    const cle = `${prefixe}_test_${'Z'.repeat(60)}`
    const masque = C.sansSecrets(`Stripe a refuse ${cle} (401)`)
    assert.ok(!masque.includes(cle), `${prefixe}_ non masque`)
    assert.ok(masque.includes(`${prefixe}_***`))
  }
  assert.equal(C.sansSecrets(null), '')
  assert.ok(C.sansSecrets('rien a masquer ici').includes('rien a masquer'))
})
