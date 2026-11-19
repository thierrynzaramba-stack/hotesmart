// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/fil-isole.js — UN TRAVAIL LOURD DANS UN PROCESSUS À USAGE
// UNIQUE, UN SEUL À LA FOIS PAR INSTANCE, TOUTES FAMILLES CONFONDUES
// Spec : docs/specs/spec-compte-de-charges.md §14.20 (reviews du lot crédit,
// constat de sécurité S1)
//
// ⚠ POURQUOI. Un fichier envoyé par un hôte peut être fabriqué pour coûter :
// un PDF de 8 Ko a fait monter la seconde review à 5,4 Go et tuer le
// processus. Dans le fil principal, c'est la fonction entière qui tombe, avec
// les requêtes des autres hôtes. Ici le travail tourne À PART :
//   · borné en temps (`delaiMs`, compté DEPUIS L'APPEL, attente comprise) ;
//   · borné en tas JavaScript (`--max-old-space-size`) ;
//   · ⚠ borné en MÉMOIRE RÉSIDENTE (`memoireMax`) — seconde review : le tas
//     JavaScript ne compte pas les tampons (les flux décompressés de pdf.js,
//     le tas WebAssembly de libheif), et ce sont eux qui montent. Le
//     processus principal relève la mémoire de l'enfant toutes les 25 ms et
//     le tue au-delà ;
//   · tué après UN travail, et la place ne se libère qu'une fois l'enfant MORT
//     (seconde review, mineur 1) ;
//   · UN SEUL vivant par instance : la file `FILE_LOURDE` est COMMUNE à la
//     conversion HEIC et à la lecture des tableaux d'amortissement (seconde
//     review, mineur 3).
//
// ⚠ UN PROCESSUS, PAS UN FIL (`worker_threads`), ET C'EST MESURÉ (19 novembre
// 2026, après la seconde review) : un fil terminé ne rend pas sa mémoire au
// système — l'allocateur la garde pour le processus. Huit tours « PDF piégé,
// photo de 48 Mpx, vrai tableau » dans un même processus laissaient 1,7 Go
// résidents et montaient à 2,4 Go : au-delà des 2 Go d'une fonction, sans
// qu'aucun travail isolé n'ait dépassé sa borne. Un processus qui meurt rend
// TOUT, et sa mémoire se lit exactement (/proc/<pid>/status), sans compter
// celle des autres requêtes.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs')
const { EventEmitter } = require('node:events')

const MO = 1024 * 1024
const MEMOIRE_MAX_DEFAUT = 512 * MO
const INTERVALLE_GARDE_MS = 25
// Un enfant qui ne meurt pas dans ce délai ne bloque pas la file pour
// toujours : la place se libère et le fait est journalisé.
const DELAI_MORT_MS = 2000

class PanneFil extends Error {
  constructor (motif, detail = null) {
    super(motif)
    this.name = 'PanneFil'
    this.motif = motif
    this.detail = detail ? String(detail).slice(0, 200) : null
  }
}

/**
 * Un processus enfant (`fork`) présenté comme un `Worker` : `postMessage`,
 * `terminate`, événements `message`, `error`, `exit` — et `memoire()`, sa
 * mémoire résidente en octets (`null` hors de Linux). Le script enfant reçoit
 * UN message `{ entree, workerData }` et répond par `process.send`.
 */
class FilProcessus extends EventEmitter {
  constructor (fichier, { workerData, resourceLimits } = {}) {
    super()
    const execArgv = []
    if (resourceLimits && resourceLimits.maxOldGenerationSizeMb) execArgv.push(`--max-old-space-size=${resourceLimits.maxOldGenerationSizeMb}`)
    this.workerData = workerData
    this.mort = false
    this.stdout = null
    this.stderr = null
    // `execArgv` explicite : l'enfant n'hérite pas des options du parent
    // (`--test`, `--require` d'un banc). `advanced` : les octets passent tels
    // quels, sans JSON.
    this.enfant = require('node:child_process').fork(fichier, [], {
      execArgv,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    this.enfant.once('message', (m) => this.emit('message', m))
    this.enfant.once('error', (e) => this.emit('error', e))
    this.enfant.once('exit', (code, signal) => {
      this.mort = true
      // Un tas JavaScript plein fait avorter l'enfant (SIGABRT, code 134).
      if (signal === 'SIGABRT' || code === 134) this.emit('error', Object.assign(new Error('tas plein'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }))
      this.emit('exit', code === null ? signal : code)
    })
  }

  postMessage (entree) { this.enfant.send({ entree, workerData: this.workerData }) }

  terminate () {
    return new Promise((resolve) => {
      if (this.mort) return resolve()
      this.enfant.once('exit', () => resolve())
      this.enfant.kill('SIGKILL')
    })
  }

  memoire () {
    try {
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${this.enfant.pid}/status`, 'utf8'))
      return m ? Number(m[1]) * 1024 : null
    } catch (e) {
      return null
    }
  }
}

/** Une file : un fil vivant au plus, `max` travaux en attente au plus. */
function creerFile ({ max = 2 } = {}) {
  return { max, attente: [], enCours: false }
}

// LA file des travaux lourds de l'instance : HEIC et tableaux d'amortissement.
const FILE_LOURDE = creerFile({ max: 2 })

/**
 * Lance `fichier` (un module qui écoute UN message de `parentPort` et répond
 * UNE fois) avec `entree`, dans la file `file`. Rend la réponse du fil ;
 * lève `PanneFil` :
 *   · `occupe` — la file est pleine, OU le travail a attendu son tour et n'a
 *     pas eu son délai entier (seconde review, mineur 2 : un document honnête
 *     placé derrière un document lent n'est pas « trop long », il réessaie) ;
 *   · `delai` — le fil a eu son délai entier et ne l'a pas tenu ;
 *   · `memoire` — le fil a dépassé sa borne de mémoire ;
 *   · `fil_impossible`, `fil_en_erreur`, `fil_sorti_<code>`.
 * `deps.Worker` : un double pour les tests (par défaut, un processus enfant :
 * `FilProcessus`) ; `deps.rss` : la mesure de sa mémoire, pour un double.
 */
function executer (file, { fichier, entree, transfert = [], delaiMs, limites = null, workerData, memoireMax = MEMOIRE_MAX_DEFAUT }, deps = {}) {
  if (file.enCours && file.attente.length >= file.max) return Promise.reject(new PanneFil('occupe'))
  return new Promise((resolve, reject) => {
    const tache = { fichier, entree, transfert, limites, workerData, memoireMax, delaiMs, echeance: Date.now() + delaiMs, resolve, reject, deps, minuteur: null }
    // Un travail qui attend son tour plus que son délai part en panne SANS
    // avoir lancé de fil.
    tache.minuteur = setTimeout(() => {
      const i = file.attente.indexOf(tache)
      if (i >= 0) { file.attente.splice(i, 1); reject(new PanneFil('occupe')) }
    }, delaiMs)
    file.attente.push(tache)
    suivante(file)
  })
}

function suivante (file) {
  if (file.enCours || !file.attente.length) return
  const tache = file.attente.shift()
  clearTimeout(tache.minuteur)
  const reste = tache.echeance - Date.now()
  if (reste <= 0) { tache.reject(new PanneFil('occupe')); suivante(file); return }
  // A-t-il attendu ? Alors un délai dépassé n'est pas SON délai.
  const aAttendu = reste < tache.delaiMs - 50
  file.enCours = true
  lancer(tache, reste)
    .then(tache.resolve, (e) => tache.reject(aAttendu && e instanceof PanneFil && e.motif === 'delai' ? new PanneFil('occupe') : e))
    .finally(() => { file.enCours = false; suivante(file) })
}

function lancer ({ fichier, entree, transfert, limites, workerData, memoireMax, deps }, delaiMs) {
  const Worker = deps.Worker || FilProcessus
  return new Promise((resolve, reject) => {
    let fini = false
    let minuteur = null
    let garde = null
    let fil
    try {
      fil = new Worker(fichier, {
        stdout: true,
        stderr: true,
        ...(workerData !== undefined ? { workerData } : {}),
        ...(limites ? { resourceLimits: limites } : {})
      })
    } catch (e) {
      reject(new PanneFil('fil_impossible', e && e.message))
      return
    }
    if (fil.stdout) fil.stdout.resume()
    if (fil.stderr) fil.stderr.resume()
    // ⚠ La réponse (ou le refus) ne part qu'une fois le fil MORT : c'est elle
    // qui libère la place dans la file, donc qui lance le fil suivant.
    const finir = (geste) => {
      if (fini) return
      fini = true
      clearTimeout(minuteur)
      clearInterval(garde)
      let mort = false
      const tuer = Promise.resolve().then(() => fil.terminate()).catch(() => {}).then(() => { mort = true })
      const sursis = new Promise((r) => setTimeout(r, DELAI_MORT_MS).unref?.())
      Promise.race([tuer, sursis]).then(() => {
        if (!mort) console.error('[fil-isole] fil toujours vivant après', DELAI_MORT_MS, 'ms :', fichier)
        geste()
      })
    }
    // La mémoire de l'enfant ; un double de test donne la sienne par `deps.rss`.
    const mesure = deps.rss || (typeof fil.memoire === 'function' ? () => fil.memoire() : () => null)
    let muette = false
    garde = setInterval(() => {
      const v = mesure()
      // Hors de Linux (/proc absent), la garde ne voit rien : on le DIT, une
      // fois, plutôt que de croire le travail borné.
      if (v === null && !muette) { muette = true; console.error('[fil-isole] mémoire de l\'enfant illisible : garde inactive pour', fichier) }
      if (v !== null && v > memoireMax) finir(() => reject(new PanneFil('memoire', `au-delà de ${Math.round(memoireMax / MO)} Mo`)))
    }, deps.intervalleGardeMs || INTERVALLE_GARDE_MS)
    minuteur = setTimeout(() => finir(() => reject(new PanneFil('delai'))), delaiMs)
    fil.once('message', (m) => finir(() => resolve(m)))
    fil.once('error', (e) => finir(() => reject(new PanneFil(e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memoire' : 'fil_en_erreur', e && e.message))))
    fil.once('exit', (code) => finir(() => reject(new PanneFil(`fil_sorti_${code}`))))
    fil.postMessage(entree, transfert)
  })
}

module.exports = { creerFile, executer, PanneFil, FilProcessus, FILE_LOURDE, MEMOIRE_MAX_DEFAUT, DELAI_MORT_MS }
