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
const { heicEnJpeg, convertirIsole, decoderPremiere, reduire, ConversionImpossible, PanneConversion, COTE_MAX, PIXELS_MAX } = require('../lib/charges/heic')
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

// ─── Le fil à usage unique (review du lot, constat de sécurité 1) ──────────
// Le tas WebAssembly de libheif ne rétrécit jamais, et un fichier illisible le
// faisait fuir (≈ 12 Mo par échec de 10 Mo) jusqu'à geler l'instance. La
// conversion tourne donc dans un fil jeté après chaque photo. Mesuré à la main
// (/tmp, 30 puis 90 fichiers pourris de 10 Mo d'affilée dans le même
// processus) : 175 puis 165 Mo de mémoire, sans croissance, et une vraie
// photo convertie juste après ; avant la correction, la review mesurait le
// tas de 32 à 392 Mo sur 30 échecs, puis l'arrêt du module vers 200.

test('LE TEST QUI COMPTE : convertirIsole convertit un vrai HEIC ET un vrai HEIF (`mif1`) dans un fil, et rend le JPEG', async () => {
  for (const nom of ['deux-couleurs.heic', 'deux-couleurs-mif1.heif']) {
    const sortie = await convertirIsole(fs.readFileSync(path.join(__dirname, 'fixtures', 'charges', nom)), { max: 7 * 1024 * 1024 })
    const img = jpeg.decode(sortie, { useTArray: true })
    assert.deepEqual([img.width, img.height], [96, 64], nom)
  }
})

test('dans le fil, un fichier illisible reste un REFUS (ConversionImpossible) ; un délai dépassé est une PANNE', async () => {
  const pourri = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(300, 7)])
  await assert.rejects(convertirIsole(pourri, { max: 1e7 }), (e) => e instanceof ConversionImpossible && e.motif === 'decodage')
  // ⚠ 40 ms, pas 1 (dette 154) : avec 1 ms, il suffisait que l'horloge passe
  // une milliseconde entre le dépôt du travail et son lancement pour que la
  // file le refuse « occupé » AVANT d'avoir lancé le fil — mesuré machine
  // chargée : 1 fois sur 80. À 40 ms, le fil est toujours lancé, et jamais
  // fini (le seul démarrage du processus est plus long) : 40 « délai » sur 40.
  await assert.rejects(convertirIsole(ECHANTILLON, { max: 1e7, delaiMs: 40 }), (e) => e instanceof PanneConversion && e.motif === 'delai')
})

test('un module absent n\'est pas une photo illisible : PanneConversion (review, constat 2)', async () => {
  const absent = async () => { throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }) }
  await assert.rejects(heicEnJpeg(ECHANTILLON, { max: 1e7 }, { decode: absent }), (e) => e instanceof PanneConversion && e.motif === 'module_absent')
})

test('LE TEST QUI COMPTE (mémoire) : le fil PRINCIPAL ne charge jamais le décodeur, même après des échecs', () => {
  // Un processus neuf : ce fichier-ci charge le décodeur pour ses propres tests.
  const { spawnSync } = require('node:child_process')
  const script = `
    const { convertirIsole } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'charges', 'heic'))})
    const fs = require('fs')
    ;(async () => {
      const pourri = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(300, 7)])
      for (let i = 0; i < 3; i++) { try { await convertirIsole(pourri, { max: 1e7 }) } catch (e) {} }
      const j = await convertirIsole(fs.readFileSync(${JSON.stringify(path.join(__dirname, 'fixtures', 'charges', 'deux-couleurs.heic'))}), { max: 1e7 })
      const charge = Object.keys(require.cache).some(k => /heic-decode|libheif-js|jpeg-js/.test(k))
      process.stdout.write(JSON.stringify({ jpeg: j.length > 0, charge }))
    })()`
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { jpeg: true, charge: false })
  assert.doesNotMatch(r.stdout + r.stderr, /Could not parse HEIF/, 'les messages du décodeur ne vont pas aux journaux')
})

// ─── Un seul fil à la fois (seconde review, constat de sécurité 1) ─────────
// Chaque fil a son propre tas WebAssembly : trois photos de 48 Mpx en même
// temps montaient à 2,1 Go (mesure de la review). Un double de `Worker` compte
// les fils vivants et les `terminate`.
const { EventEmitter } = require('node:events')
// `mortLente` : un vrai fil met 20 à 35 ms à mourir (troisième review) — un
// double qui meurt à l'instant ne voit pas une place rendue trop tôt.
function fabriqueDeFils ({ repond = 20, jamais = false, mortLente = 0, reponse = null } = {}) {
  const etat = { vivants: 0, maxVivants: 0, crees: 0, termines: 0 }
  class FauxFil extends EventEmitter {
    constructor () {
      super()
      etat.crees++; etat.vivants++
      etat.maxVivants = Math.max(etat.maxVivants, etat.vivants)
      this.mort = false
      this.stdout = { resume () {} }
      this.stderr = { resume () {} }
    }
    postMessage () {
      if (jamais) return
      setTimeout(() => { if (!this.mort) this.emit('message', reponse || { ok: true, jpeg: Uint8Array.from([0xFF, 0xD8, 0xFF]) }) }, repond)
    }
    async terminate () {
      if (this.mort) return
      this.mort = true
      if (mortLente) await new Promise(r => setTimeout(r, mortLente))
      etat.vivants--; etat.termines++
    }
  }
  return { Worker: FauxFil, etat }
}

test('LE TEST QUI COMPTE (mémoire) : trois conversions demandées ENSEMBLE passent l\'une après l\'autre — jamais deux fils vivants, même quand un fil met du temps à mourir (troisième review, mineur 2)', async () => {
  const f = fabriqueDeFils({ repond: 30, mortLente: 15 })
  const r = await Promise.all([1, 2, 3].map(() => convertirIsole(Buffer.from('x'), { max: 1e7 }, { Worker: f.Worker })))
  assert.equal(r.length, 3)
  assert.deepEqual([f.etat.crees, f.etat.maxVivants, f.etat.termines, f.etat.vivants], [3, 1, 3, 0])
})

test('au-delà d\'une file de 2 en attente, la photo est refusée « occupé » (une panne : 503, rien d\'effacé)', async () => {
  const { FILE_MAX } = require('../lib/charges/heic')
  const f = fabriqueDeFils({ repond: 40 })
  const appels = Array.from({ length: FILE_MAX + 2 }, () => convertirIsole(Buffer.from('x'), { max: 1e7 }, { Worker: f.Worker }).then(() => 'ok', (e) => e.motif))
  assert.deepEqual(await Promise.all(appels), ['ok', 'ok', 'ok', 'occupe'])
  assert.equal(f.etat.maxVivants, 1)
})

test('LE TEST QUI COMPTE : un fil qui ne répond jamais est TUÉ au délai (seconde review, constat 2), et la file repart', async () => {
  const muet = fabriqueDeFils({ jamais: true })
  await assert.rejects(convertirIsole(Buffer.from('x'), { max: 1e7, delaiMs: 30 }, { Worker: muet.Worker }), (e) => e instanceof PanneConversion && e.motif === 'delai')
  await new Promise(r => setImmediate(r))
  assert.deepEqual([muet.etat.termines, muet.etat.vivants], [1, 0])
  const f = fabriqueDeFils()
  assert.equal((await convertirIsole(Buffer.from('x'), { max: 1e7 }, { Worker: f.Worker })).length, 3, 'la suivante passe')
})

test('une photo qui attend son tour plus que son délai part en panne « occupé » SANS lancer de fil ; le délai court depuis l\'appel', async () => {
  const lent = fabriqueDeFils({ repond: 80 })
  const premiere = convertirIsole(Buffer.from('x'), { max: 1e7, delaiMs: 1000 }, { Worker: lent.Worker })
  const t0 = Date.now()
  const seconde = convertirIsole(Buffer.from('x'), { max: 1e7, delaiMs: 30 }, { Worker: lent.Worker })
  // « occupé », pas « délai » (seconde review du lot crédit, mineur 2 ;
  // troisième review HEIC, mineur 5) : elle n'a pas eu son tour — l'écran
  // dit « réessayez dans un instant ».
  await assert.rejects(seconde, (e) => e instanceof PanneConversion && e.motif === 'occupe')
  assert.ok(Date.now() - t0 < 70, 'refusée à son délai, pas à la fin de la première')
  await premiere
  assert.equal(lent.etat.crees, 1, 'la seconde n\'a jamais eu de fil')
})

test('LE TEST QUI COMPTE (troisième review, S1) : UN compte, UNE place — sa seconde conversion est refusée « occupé », celle d\'un autre compte passe', async () => {
  const f = fabriqueDeFils({ repond: 60 })
  const r = await Promise.all([
    convertirIsole(Buffer.from('x'), { max: 1e7, cle: 'compte-a' }, { Worker: f.Worker }).then(() => 'ok', (e) => e.motif),
    convertirIsole(Buffer.from('x'), { max: 1e7, cle: 'compte-a' }, { Worker: f.Worker }).then(() => 'ok', (e) => e.motif),
    convertirIsole(Buffer.from('x'), { max: 1e7, cle: 'compte-b' }, { Worker: f.Worker }).then(() => 'ok', (e) => e.motif),
    convertirIsole(Buffer.from('x'), { max: 1e7, cle: 'compte-a' }, { Worker: f.Worker }).then(() => 'ok', (e) => e.motif)
  ])
  assert.deepEqual(r, ['ok', 'occupe', 'ok', 'occupe'], 'en cours, la clé est prise')
  // Libérée à la fin : le compte A repasse.
  assert.equal((await convertirIsole(Buffer.from('x'), { max: 1e7, cle: 'compte-a' }, { Worker: f.Worker })).length, 3)
  // EN ATTENTE aussi, la clé est prise : C convertit, A attend, A redemande.
  const r2 = await Promise.all(['compte-c', 'compte-a', 'compte-a'].map((cle) =>
    convertirIsole(Buffer.from('x'), { max: 1e7, cle }, { Worker: f.Worker }).then(() => 'ok', (e) => e.motif)))
  assert.deepEqual(r2, ['ok', 'ok', 'occupe'], 'en attente, la clé est prise')
})

test('le fil reçoit le RESTE du délai compté depuis l\'appel ; coupé après avoir attendu, c\'est « occupé » (troisième review, mineur 3)', async () => {
  const premier = fabriqueDeFils({ repond: 600 })
  const p1 = convertirIsole(Buffer.from('x'), { max: 1e7, delaiMs: 5000 }, { Worker: premier.Worker })
  const lent = fabriqueDeFils({ repond: 900 })
  const t0 = Date.now()
  // Elle attend ~600 ms, il lui en reste ~700 : son fil (900 ms) est coupé à ~1300 ms de l\'appel.
  await assert.rejects(convertirIsole(Buffer.from('x'), { max: 1e7, delaiMs: 1300 }, { Worker: lent.Worker }), (e) => e.motif === 'occupe')
  const duree = Date.now() - t0
  assert.ok(duree >= 1250 && duree < 1600, `${duree} ms : le délai court depuis l'appel, pas depuis le lancement`)
  assert.equal(lent.etat.crees, 1, 'elle a eu un fil, coupé en cours')
  await p1
})

test('une attente expirée libère sa place dans la file ; un reste trop court ne lance pas de fil (troisième review, mineurs 3 et 6)', async () => {
  const { RESTE_MIN_MS } = require('../lib/charges/heic')
  const lent = fabriqueDeFils({ repond: 150 })
  const premiere = convertirIsole(Buffer.from('x'), { max: 1e7, delaiMs: 3000 }, { Worker: lent.Worker })
  assert.equal(await convertirIsole(Buffer.from('x'), { max: 1e7, delaiMs: 20 }, { Worker: lent.Worker }).catch(e => e.motif), 'occupe')
  const r = await Promise.all([1, 2].map(() => convertirIsole(Buffer.from('x'), { max: 1e7, delaiMs: 3000 }, { Worker: lent.Worker }).then(() => 'ok', e => e.motif)))
  await premiere
  assert.deepEqual(r, ['ok', 'ok'], 'la place de l\'expirée est rendue')
  // Elle sort de la file avec moins de RESTE_MIN_MS : refusée sans fil.
  const f = fabriqueDeFils({ repond: 200 })
  const devant = convertirIsole(Buffer.from('x'), { max: 1e7, delaiMs: 3000 }, { Worker: f.Worker })
  const juste = convertirIsole(Buffer.from('x'), { max: 1e7, delaiMs: 200 + RESTE_MIN_MS - 150 }, { Worker: f.Worker }).catch(e => e.motif)
  await devant
  assert.equal(await juste, 'occupe')
  assert.equal(f.etat.crees, 1, 'aucun fil lancé pour un reste trop court')
})

test('un fil qui répond par une panne garde sa cause ; un fil qui sort sans répondre rend la place tout de suite (troisième review, mineur 4)', async () => {
  const enPanne = fabriqueDeFils({ reponse: { ok: false, panne: 'module_absent', cause: 'Cannot find module heic-decode' } })
  await assert.rejects(convertirIsole(Buffer.from('x'), { max: 1e7 }, { Worker: enPanne.Worker }),
    (e) => e instanceof PanneConversion && e.motif === 'module_absent' && /heic-decode/.test(e.detail))
  class FilQuiSort extends EventEmitter {
    constructor () { super(); this.stdout = { resume () {} }; this.stderr = { resume () {} } }
    postMessage () { setTimeout(() => this.emit('exit', 0), 5) }
    async terminate () {}
  }
  const t0 = Date.now()
  await assert.rejects(convertirIsole(Buffer.from('x'), { max: 1e7 }, { Worker: FilQuiSort }), (e) => e instanceof PanneConversion && e.motif === 'fil_sorti_0')
  assert.ok(Date.now() - t0 < 500, 'pas au délai de 15 s')
})

test('la cause d\'une panne du fil est gardée pour le journal (seconde review, constat 3)', async () => {
  class FilEnErreur extends EventEmitter {
    constructor () { super(); this.stdout = { resume () {} }; this.stderr = { resume () {} } }
    postMessage () { setTimeout(() => this.emit('error', new Error('Cannot find module jpeg-js')), 5) }
    async terminate () {}
  }
  await assert.rejects(convertirIsole(Buffer.from('x'), { max: 1e7 }, { Worker: FilEnErreur }),
    (e) => e instanceof PanneConversion && e.motif === 'fil_en_erreur' && /jpeg-js/.test(e.detail))
})
