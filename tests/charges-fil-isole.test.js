// tests/charges-fil-isole.test.js — LA FILE DES TRAVAUX LOURDS
// (lib/charges/fil-isole.js ; spec §14.20, seconde review du lot crédit,
// constat de sécurité S1 et mineurs 1 à 3).
//
// Un PDF de 8 Ko faisait monter le processus à 5,4 Go : le tas JavaScript ne
// compte pas les tampons. Le travail tourne dans un PROCESSUS enfant, dont la
// mémoire résidente est relevée toutes les 25 ms, un seul à la fois par
// instance — HEIC et tableaux confondus.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { EventEmitter } = require('node:events')
const { executer, creerFile, PanneFil, FILE_LOURDE } = require('../lib/charges/fil-isole')

const attendre = (ms) => new Promise((r) => setTimeout(r, ms))

// Un double de `Worker` : compte les vivants, répond (ou pas), meurt quand on le tue.
function fabrique ({ repond = 20, jamais = false, mortLente = 0 } = {}) {
  const etat = { vivants: 0, maxVivants: 0, crees: 0, nes: [], morts: [] }
  class Faux extends EventEmitter {
    constructor () {
      super()
      etat.crees++; etat.vivants++; etat.nes.push(Date.now())
      etat.maxVivants = Math.max(etat.maxVivants, etat.vivants)
      this.mort = false
      this.stdout = null; this.stderr = null
    }
    postMessage () {
      if (!jamais) setTimeout(() => { if (!this.mort) this.emit('message', { ok: true }) }, repond)
    }
    async terminate () {
      if (this.mort) return
      await attendre(mortLente)
      this.mort = true; etat.vivants--; etat.morts.push(Date.now())
    }
  }
  return { Worker: Faux, etat }
}
const tache = (o = {}) => ({ fichier: 'x', entree: 1, delaiMs: 1000, ...o })

test('LE TEST QUI COMPTE (S1) : un enfant qui dépasse sa borne de mémoire est TUÉ — « memoire », et la file repart', async () => {
  const f = fabrique({ jamais: true })
  let v = 10
  const file = creerFile()
  const t0 = Date.now()
  await assert.rejects(executer(file, tache({ memoireMax: 100 }), { Worker: f.Worker, rss: () => (v += 30), intervalleGardeMs: 5 }),
    (e) => e instanceof PanneFil && e.motif === 'memoire')
  assert.ok(Date.now() - t0 < 500, 'tué à la mesure, pas au délai')
  assert.deepEqual([f.etat.crees, f.etat.vivants], [1, 0])
  const g = fabrique()
  assert.deepEqual(await executer(file, tache(), { Worker: g.Worker }), { ok: true })
})

test('la place ne se libère qu\'une fois l\'enfant MORT (seconde review, mineur 1)', async () => {
  const f = fabrique({ repond: 10, mortLente: 80 })
  const file = creerFile()
  await Promise.all([executer(file, tache(), { Worker: f.Worker }), executer(file, tache(), { Worker: f.Worker })])
  assert.equal(f.etat.maxVivants, 1)
  assert.ok(f.etat.nes[1] >= f.etat.morts[0], 'le second naît après la mort du premier')
})

test('LE TEST QUI COMPTE (mineur 2) : un travail qui a ATTENDU n\'est pas « trop long » — il est « occupé » ; seul, il l\'est', async () => {
  const file = creerFile()
  // Seul, un enfant muet : `delai`.
  await assert.rejects(executer(file, tache({ delaiMs: 40 }), { Worker: fabrique({ jamais: true }).Worker }), (e) => e.motif === 'delai')
  // Derrière un travail de 80 ms, un délai de 40 ms expire dans la file : `occupe`, sans enfant.
  const lent = fabrique({ repond: 80 })
  const premier = executer(file, tache(), { Worker: lent.Worker })
  await assert.rejects(executer(file, tache({ delaiMs: 40 }), { Worker: lent.Worker }), (e) => e.motif === 'occupe')
  await premier
  assert.equal(lent.etat.crees, 1)
  // Derrière lui, un délai de 150 ms : il démarre avec ~70 ms, son enfant muet les dépasse — `occupe`, pas `delai`.
  const lent2 = fabrique({ repond: 80 })
  const p = executer(file, tache(), { Worker: lent2.Worker })
  await assert.rejects(executer(file, tache({ delaiMs: 150 }), { Worker: fabrique({ jamais: true }).Worker }), (e) => e.motif === 'occupe')
  await p
})

test('LE TEST QUI COMPTE (mineur 3) : HEIC et tableaux partagent UNE file — jamais deux enfants vivants', async () => {
  const { convertirIsole } = require('../lib/charges/heic')
  const { lireTableauIsole } = require('../lib/charges/credit-tableau')
  const f = fabrique({ repond: 30 })
  const r = await Promise.all([
    convertirIsole(Buffer.from('x'), { max: 1e7 }, { Worker: f.Worker }).then(() => 'photo', (e) => e.motif),
    lireTableauIsole(Buffer.from('%PDF'), {}, { Worker: f.Worker }).then((x) => (x.panne ? x.panne : 'tableau')),
    convertirIsole(Buffer.from('x'), { max: 1e7 }, { Worker: f.Worker }).then(() => 'photo', (e) => e.motif),
    lireTableauIsole(Buffer.from('%PDF'), {}, { Worker: f.Worker }).then((x) => (x.panne ? x.panne : 'tableau'))
  ])
  assert.deepEqual(r, ['reponse_vide', 'tableau', 'reponse_vide', 'occupe'], 'trois passent l\'un après l\'autre, le quatrième trouve la file pleine')
  assert.equal(f.etat.maxVivants, 1)
  assert.equal(FILE_LOURDE.max, 2)
})

test('LE TEST QUI COMPTE (troisième review HEIC, S1) : UN compte, UNE place — en cours ou en attente, sa seconde demande est « occupé », photo ou tableau ; un autre compte passe', async () => {
  const file = creerFile()
  const f = fabrique({ repond: 40 })
  const demande = (cle) => executer(file, tache({ cle }), { Worker: f.Worker }).then(() => 'ok', (e) => e.motif)
  // A convertit ; A redemande ; B attend ; A redemande encore.
  assert.deepEqual(await Promise.all([demande('A'), demande('A'), demande('B'), demande('A')]), ['ok', 'occupe', 'ok', 'occupe'])
  // C convertit, A ATTEND, A redemande : la clé en attente est prise aussi.
  assert.deepEqual(await Promise.all([demande('C'), demande('A'), demande('A')]), ['ok', 'ok', 'occupe'])
  // Une photo et un tableau du même compte, ensemble : le second est « occupé ».
  const { convertirIsole } = require('../lib/charges/heic')
  const { lireTableauIsole } = require('../lib/charges/credit-tableau')
  const g = fabrique({ repond: 40 })
  const r = await Promise.all([
    convertirIsole(Buffer.from('x'), { max: 1e7, cle: 'D' }, { Worker: g.Worker }).then(() => 'photo', (e) => e.motif),
    lireTableauIsole(Buffer.from('%PDF'), { cle: 'D' }, { Worker: g.Worker }).then((x) => (x.panne ? x.panne : 'tableau'))
  ])
  assert.deepEqual(r, ['reponse_vide', 'occupe'])
})

test('la place et la clé sont rendues AVANT la réponse : le compte qui enchaîne aussitôt passe', async () => {
  const file = creerFile()
  const f = fabrique({ repond: 10 })
  await executer(file, tache({ cle: 'A' }), { Worker: f.Worker })
  assert.deepEqual(await executer(file, tache({ cle: 'A' }), { Worker: f.Worker }), { ok: true })
})

test('un travail qui a attendu et à qui il reste moins de RESTE_MIN_MS ne lance pas d\'enfant : « occupé » (troisième review HEIC, mineur 6)', async () => {
  const { RESTE_MIN_MS } = require('../lib/charges/fil-isole')
  const file = creerFile()
  const devant = fabrique({ repond: 200 })
  const p = executer(file, tache({ delaiMs: 3000 }), { Worker: devant.Worker })
  const derriere = fabrique({ repond: 10 })
  const juste = executer(file, tache({ delaiMs: 200 + RESTE_MIN_MS - 150 }), { Worker: derriere.Worker }).then(() => 'ok', (e) => e.motif)
  await p
  assert.equal(await juste, 'occupe')
  assert.equal(derriere.etat.crees, 0, 'aucun enfant lancé')
})

test('LE TEST QUI COMPTE (troisième review, S3) : DEUX erreurs du même enfant ne tuent pas le parent — une seule réponse', async () => {
  class DeuxErreurs extends EventEmitter {
    constructor () { super(); this.stdout = null; this.stderr = null }
    postMessage () { setTimeout(() => { this.emit('error', new Error('write EPIPE')); this.emit('error', Object.assign(new Error('tas plein'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })) }, 5) }
    async terminate () {}
  }
  await assert.rejects(executer(creerFile(), tache(), { Worker: DeuxErreurs }), (e) => e.motif === 'fil_en_erreur' && /EPIPE/.test(e.detail))
  await attendre(20)
})

test('un envoi qui lève à l\'enfant est une panne rendue, pas une promesse pendue', async () => {
  class EnvoiImpossible extends EventEmitter {
    constructor () { super(); this.stdout = null; this.stderr = null }
    postMessage () { throw new Error('ERR_IPC_CHANNEL_CLOSED') }
    async terminate () {}
  }
  const t0 = Date.now()
  await assert.rejects(executer(creerFile(), tache({ delaiMs: 5000 }), { Worker: EnvoiImpossible }), (e) => e.motif === 'fil_en_erreur')
  assert.ok(Date.now() - t0 < 1000)
})

test('sous Linux, un enfant dont la mémoire ne se lit pas est REFUSÉ « garde_aveugle » (troisième review, mineur 3)', { skip: process.platform !== 'linux' && 'Linux seulement' }, async () => {
  class Aveugle extends EventEmitter {
    constructor () { super(); this.stdout = null; this.stderr = null; this.mort = false }
    postMessage () {}
    memoire () { return null }
    async terminate () { this.mort = true }
  }
  const t0 = Date.now()
  await assert.rejects(executer(creerFile(), tache({ delaiMs: 5000 }), { Worker: Aveugle }), (e) => e.motif === 'garde_aveugle')
  assert.ok(Date.now() - t0 < 1000)
})

test('LE TEST QUI COMPTE (troisième review, S1) : un compte dont le travail a été COUPÉ se repose — l\'autre compte passe', async () => {
  const file = creerFile()
  await assert.rejects(executer(file, tache({ cle: 'A', delaiMs: 40 }), { Worker: fabrique({ jamais: true }).Worker }), (e) => e.motif === 'delai')
  await assert.rejects(executer(file, tache({ cle: 'A' }), { Worker: fabrique().Worker }), (e) => e.motif === 'occupe' && e.detail === 'repos')
  assert.deepEqual(await executer(file, tache({ cle: 'B' }), { Worker: fabrique().Worker }), { ok: true })
  // Coupé pour la mémoire aussi.
  let v = 0
  await assert.rejects(executer(file, tache({ cle: 'C', memoireMax: 10 }), { Worker: fabrique({ jamais: true }).Worker, rss: () => (v += 20), intervalleGardeMs: 5 }), (e) => e.motif === 'memoire')
  await assert.rejects(executer(file, tache({ cle: 'C' }), { Worker: fabrique().Worker }), (e) => e.motif === 'occupe')
  // Un refus du FICHIER (réponse normale) ne met pas au repos.
  assert.deepEqual(await executer(file, tache({ cle: 'D' }), { Worker: fabrique().Worker }), { ok: true })
  assert.deepEqual(await executer(file, tache({ cle: 'D' }), { Worker: fabrique().Worker }), { ok: true })
})

test('une photo HEIC a sa propre borne, plus haute que celle d\'un tableau (troisième review, mineur 5 : une photo de 48 Mpx monte à ~790 Mo)', async () => {
  const { convertirIsole, MEMOIRE_CONVERSION } = require('../lib/charges/heic')
  const { MEMOIRE_MAX_DEFAUT } = require('../lib/charges/fil-isole')
  assert.ok(MEMOIRE_CONVERSION > 1024 * 1024 * 1024)
  class Photo extends EventEmitter {
    constructor () { super(); this.stdout = null; this.stderr = null }
    postMessage () { setTimeout(() => this.emit('message', { ok: true, jpeg: Uint8Array.from([0xFF, 0xD8, 0xFF]) }), 60) }
    async terminate () {}
  }
  const r = await convertirIsole(Buffer.from('x'), { max: 1e7 }, { Worker: Photo, rss: () => MEMOIRE_MAX_DEFAUT + 400 * 1024 * 1024, intervalleGardeMs: 5 })
  assert.equal(r.length, 3)
})

// ─── Le vrai processus ──────────────────────────────────────────────────────
const enfants = () => {
  try { return fs.readFileSync(`/proc/self/task/${process.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean) } catch (e) { return [] }
}

test('LE TEST QUI COMPTE (S1, en vrai) : un PDF de quelques Ko dont le contenu répète un flux légal est refusé « trop lourd » — l\'enfant tué, aucun ne survit', { skip: !fs.existsSync('/proc/self/status') && 'mesure Linux' }, async () => {
  const { lireTableauIsole } = require('../lib/charges/credit-tableau')
  // Le piège v11 de la review : un flux de 3,9 Mo, SOUS sa borne, appelé
  // 40 fois par /Contents. Le pré-contrôle n'y voit rien — c'est la garde.
  const flux = zlib.deflateSync(Buffer.alloc(3900 * 1024))
  const objets = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [${Array(40).fill('4 0 R').join(' ')}] >>\nendobj\n`
  ]
  const piege = Buffer.concat([Buffer.from('%PDF-1.7\n' + objets.join('')), Buffer.from(`4 0 obj\n<< /Length ${flux.length} /Filter /FlateDecode >>\nstream\n`), flux, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')])
  assert.ok(piege.length < 16 * 1024, `${piege.length} octets`)
  const r = await lireTableauIsole(piege, { memoireMax: 96 * 1024 * 1024 })
  assert.deepEqual(r, { ok: false, code: 'tableau_illisible', detail: 'trop_lourd' })
  assert.deepEqual(enfants(), [], 'l\'enfant est mort')
  // Et un vrai tableau (fictif) se lit, sous la même borne réduite.
  const vrai = await lireTableauIsole(fs.readFileSync(path.join(__dirname, 'fixtures', 'charges', 'tableau-tourne.pdf')), { memoireMax: 96 * 1024 * 1024 })
  assert.equal(vrai.ok, true)
  assert.deepEqual(enfants(), [], 'tué après UNE lecture réussie aussi')
})

test('un enfant dont le tas JavaScript déborde avorte — « memoire », pas une panne muette', async () => {
  await assert.rejects(executer(creerFile(), {
    fichier: path.join(__dirname, 'fixtures', 'charges', 'enfant-tas-plein.js'),
    entree: 1,
    delaiMs: 15000,
    limites: { maxOldGenerationSizeMb: 32 },
    memoireMax: 4 * 1024 * 1024 * 1024
  }), (e) => e instanceof PanneFil && e.motif === 'memoire' && e.detail === 'tas plein', 'le TAS, lu dans son stderr — pas la garde de 4 Go')
  assert.deepEqual(enfants(), [])
})

test('un enfant qui avorte SANS tas plein est une panne, pas « memoire » (troisième review, mineur 4) : le fichier n\'est pas accusé', async () => {
  await assert.rejects(executer(creerFile(), {
    fichier: path.join(__dirname, 'fixtures', 'charges', 'enfant-avorte.js'), entree: 1, delaiMs: 15000
  }), (e) => e instanceof PanneFil && e.motif === 'fil_en_erreur' && /avorté/.test(e.detail))
  assert.deepEqual(enfants(), [])
})

test('LE TEST QUI COMPTE (troisième review, S2) : l\'enfant n\'hérite PAS des secrets du parent, ni de NODE_OPTIONS', async () => {
  const { ENV_ENFANT } = require('../lib/charges/fil-isole')
  process.env.SECRET_TEMOIN_CHARGES = 'ne-doit-pas-passer'
  try {
    const { noms, tas } = await executer(creerFile(), { fichier: path.join(__dirname, 'fixtures', 'charges', 'enfant-env.js'), entree: 1, delaiMs: 15000, limites: { maxOldGenerationSizeMb: 64 } })
    // Et le tas de l'enfant est bien celui qu'on lui donne (troisième review, mineur 5).
    assert.ok(tas < 200 * 1024 * 1024, `${Math.round(tas / 1048576)} Mo`)
    assert.ok(!noms.includes('SECRET_TEMOIN_CHARGES'))
    assert.ok(!noms.includes('NODE_OPTIONS'))
    for (const n of noms) assert.ok(ENV_ENFANT.includes(n), `${n} hérité`)
  } finally { delete process.env.SECRET_TEMOIN_CHARGES }
})

test('le canal coupé, l\'enfant part, sans qu\'on le tue — et la sortie se conclut quand même (sur `exit`, pas sur `close`)', async () => {
  const { FilProcessus } = require('../lib/charges/fil-isole')
  const f = new FilProcessus(path.join(__dirname, '..', 'lib', 'charges', 'credit-tableau-fil.js'))
  const parti = new Promise((r) => f.once('exit', r))
  f.enfant.disconnect()
  const code = await Promise.race([parti, new Promise((r) => setTimeout(() => r('toujours vivant'), 3000))])
  if (code === 'toujours vivant') await f.terminate()
  assert.equal(code, 0)
})
