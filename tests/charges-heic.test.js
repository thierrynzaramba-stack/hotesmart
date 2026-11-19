// tests/charges-heic.test.js — une photo HEIC convertie en JPEG par notre
// serveur (spec §14.19, décision de Thierry du 19 novembre 2026 : ses factures
// arrivent par SMS en HEIC, et Chrome ne sait pas les lire).
//
// ⚠ CE TEST DÉCODE UN VRAI HEIC, avec le vrai décodeur : l'échantillon
// `tests/fixtures/charges/deux-couleurs.heic` (522 octets, 96 × 64, moitié
// rouge, moitié bleue) a été fabriqué pour ce test par `pillow-heif` 1.8.1
// (encodeur x265). Une dépendance absente de `package.json`, ou un décodeur
// qui rendrait n'importe quoi, rougit ici — pas en recette.
//
// Mesuré à la main sur deux photos réelles (hors dépôt) : 1280 × 854 en
// 426 ms ; 4032 × 3024 environ (3 Mo) → 2000 × 1499 en 1,9 s, 373 Mo de
// mémoire au plus.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { heicEnJpeg, decoderPremiere, reduire, ConversionImpossible, COTE_MAX, PIXELS_MAX } = require('../lib/charges/heic')
const { typeReel } = require('../lib/charges/regles')

const ECHANTILLON = fs.readFileSync(path.join(__dirname, 'fixtures', 'charges', 'deux-couleurs.heic'))
const jpeg = require('jpeg-js')

test('LE TEST QUI COMPTE : un VRAI HEIC devient un JPEG que l\'on relit — mêmes dimensions, mêmes couleurs', async () => {
  assert.equal(typeReel(ECHANTILLON), 'image/heic')
  const sortie = await heicEnJpeg(ECHANTILLON, { max: 7 * 1024 * 1024 })
  assert.equal(typeReel(sortie), 'image/jpeg')
  const img = jpeg.decode(sortie, { useTArray: true })
  assert.deepEqual([img.width, img.height], [96, 64])
  const px = (x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3))
  const proche = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 40)
  assert.ok(proche(px(10, 30), [220, 30, 30]), `gauche rouge : ${px(10, 30)}`)
  assert.ok(proche(px(85, 30), [30, 60, 220]), `droite bleue : ${px(85, 30)}`)
})

test('ce qui n\'est pas un HEIC lisible est refusé par ConversionImpossible (motif `decodage`), jamais par une exception brute', async () => {
  for (const octets of [Buffer.from('%PDF-1.7'), ECHANTILLON.subarray(0, 200), Buffer.alloc(0)]) {
    await assert.rejects(heicEnJpeg(octets, { max: 1e7 }), (e) => e instanceof ConversionImpossible && e.motif === 'decodage')
  }
})

test('une photo qui ne tient pas sous la borne, même à la qualité la plus basse, est refusée (motif `trop_gros`)', async () => {
  await assert.rejects(heicEnJpeg(ECHANTILLON, { max: 50 }), (e) => e instanceof ConversionImpossible && e.motif === 'trop_gros')
})

test('une grande photo est réduite à 2 000 px sur son grand côté, proportions gardées — comme celles que le téléphone prépare', async () => {
  const l = 4032; const h = 3024
  const data = new Uint8ClampedArray(l * h * 4)
  for (let i = 0; i < data.length; i += 4) { data[i] = (i / 4) % l < l / 2 ? 200 : 20; data[i + 1] = 90; data[i + 2] = 40; data[i + 3] = 255 }
  const sortie = await heicEnJpeg(Buffer.from('peu importe'), { max: 7 * 1024 * 1024 },
    { decode: async () => ({ width: l, height: h, data }) })
  const img = jpeg.decode(sortie, { useTArray: true })
  assert.equal(Math.max(img.width, img.height), COTE_MAX)
  assert.equal(img.height, Math.round(h * COTE_MAX / l))
  assert.ok(sortie.length <= 7 * 1024 * 1024)
})

test('reduire : une petite image n\'est pas agrandie ; une très grande passe par des moitiés exactes', () => {
  const petite = { width: 10, height: 6, data: new Uint8ClampedArray(10 * 6 * 4).fill(7) }
  const r0 = reduire(petite)
  assert.deepEqual([r0.width, r0.height], [10, 6])
  assert.equal(r0.data, petite.data, 'rendue telle quelle')
  const r = reduire({ width: 8000, height: 10, data: new Uint8ClampedArray(8000 * 10 * 4).fill(100) })
  assert.deepEqual([r.width, r.height], [2000, 2], 'deux moitiés exactes : 8000 → 4000 → 2000')
  assert.ok(r.data.every(v => v === 100), 'une couleur unie reste unie')
})

test('le décodeur est une dépendance DÉCLARÉE du dépôt, et il ne se charge qu\'à la demande', () => {
  const p = require('../package.json')
  assert.ok(p.dependencies['heic-decode'] && p.dependencies['jpeg-js'])
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'charges', 'heic.js'), 'utf8')
  assert.doesNotMatch(source.split('\n').filter(l => !l.trim().startsWith('//')).slice(0, 40).join('\n'), /^const .*require\('heic-decode'\)/m,
    'pas de require en tête de module : un envoi PDF ne paie pas le chargement du décodeur')
})

test('typeReel : les marques HEIC et HEIF sont reconnues, AVIF ne l\'est pas', () => {
  const ftyp = (m) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp' + m), Buffer.alloc(8)])
  for (const m of ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']) assert.equal(typeReel(ftyp(m)), 'image/heic', m)
  for (const m of ['mif1', 'msf1']) assert.equal(typeReel(ftyp(m)), 'image/heif', m)
  assert.equal(typeReel(ftyp('avif')), null)
  assert.equal(typeReel(ftyp('isom')), null, 'une vidéo MP4 n\'est pas une photo')
})

test('LE TEST QUI COMPTE (mémoire) : une photo qui DÉCLARE plus de 50 Mpx est refusée AVANT d\'être décodée, et la mémoire du décodeur est rendue', async () => {
  const journal = []
  const conteneur = (width, height) => Object.assign([{ width, height, decode: async () => { journal.push('decode'); return { width, height, data: new Uint8ClampedArray(4) } } }],
    { dispose: () => journal.push('dispose') })
  await assert.rejects(decoderPremiere({ buffer: Buffer.alloc(1) }, async () => conteneur(20000, 20000)),
    (e) => e instanceof ConversionImpossible && e.motif === 'trop_grande')
  assert.deepEqual(journal, ['dispose'], 'jamais décodée, toujours libérée')
  journal.length = 0
  await decoderPremiere({ buffer: Buffer.alloc(1) }, async () => conteneur(8064, 6048))
  assert.deepEqual(journal, ['decode', 'dispose'], '48 Mpx (le plus grand capteur de téléphone) passe')
  assert.ok(8064 * 6048 <= PIXELS_MAX)
  // Le refus traverse heicEnJpeg tel quel : le motif reste lisible au journal.
  await assert.rejects(heicEnJpeg(Buffer.alloc(1), { max: 1e7 }, { decode: (o) => decoderPremiere(o, async () => conteneur(20000, 20000)) }),
    (e) => e.motif === 'trop_grande')
})
