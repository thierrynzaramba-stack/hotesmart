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
// 2026, après la seconde review) : après un PDF piégé, un fil terminé ne rend
// pas sa mémoire au système — l'allocateur la garde pour le processus. Huit
// tours « PDF piégé tué à sa borne, vrai tableau » laissaient 1,6 Go
// résidents, encore 500 ms après, et montaient à 2,1 Go : au-delà des 2 Go
// d'une fonction, sans qu'aucun travail n'ait dépassé sa borne. (Une photo
// HEIC, elle, rend sa mémoire en fil : troisième review HEIC.) Un processus
// qui meurt rend TOUT, dans les deux cas, et sa mémoire se lit exactement
// (/proc/<pid>/status), sans compter celle des autres requêtes.
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
// ⚠ CE QUE L'ENFANT HÉRITE (troisième review du crédit, S2) : rien d'autre que
// ces variables-là. Il fait tourner pdf.js ou libheif sur un fichier hostile,
// avec accès au réseau ; hérité, `process.env` lui donnait toutes les clés du
// projet. `NODE_OPTIONS` ne passe pas non plus. Les variables du système
// restent, pour que le binaire Node démarre sur la plateforme.
const ENV_ENFANT = ['PATH', 'LD_LIBRARY_PATH', 'TZ', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR']
const STDERR_GARDE = 4096

class FilProcessus extends EventEmitter {
  constructor (fichier, { workerData, resourceLimits } = {}) {
    super()
    const execArgv = []
    if (resourceLimits && resourceLimits.maxOldGenerationSizeMb) execArgv.push(`--max-old-space-size=${resourceLimits.maxOldGenerationSizeMb}`)
    this.workerData = workerData
    this.mort = false
    this.stdout = null
    this.stderr = null
    this.finStderr = ''
    const env = {}
    for (const k of ENV_ENFANT) if (process.env[k] !== undefined) env[k] = process.env[k]
    // `execArgv` explicite et `env` réduit : l'enfant n'hérite ni des options
    // du parent (`--test`, `--require` d'un banc, `NODE_OPTIONS`), ni de ses
    // secrets. `advanced` : les octets passent tels quels, sans JSON.
    this.enfant = require('node:child_process').fork(fichier, [], {
      execArgv,
      env,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    // Les derniers octets de son stderr : c'est lui qui dit si un avortement
    // est un tas plein (troisième review du crédit, mineur 4).
    this.enfant.stderr.on('data', (d) => { this.finStderr = (this.finStderr + d.toString('utf8')).slice(-STDERR_GARDE) })
    this.enfant.once('message', (m) => this.emit('message', m))
    // `on`, pas `once` (troisième review du crédit, S3) : un EPIPE puis une
    // sortie avortée font DEUX erreurs, et la seconde, sans écouteur, tuait
    // le processus parent avec toutes les requêtes en cours.
    this.enfant.on('error', (e) => this.emit('error', e))
    this.enfant.once('exit', (code, signal) => {
      this.mort = true
      const conclure = () => {
        if (signal === 'SIGABRT') {
          const tasPlein = /heap out of memory/i.test(this.finStderr)
          this.emit('error', Object.assign(new Error(tasPlein ? 'tas plein' : `avorté : ${this.finStderr.trim().split('\n').pop() || 'sans message'}`.slice(0, 200)),
            { code: tasPlein ? 'ERR_WORKER_OUT_OF_MEMORY' : 'ERR_ENFANT_AVORTE' }))
        }
        this.emit('exit', code === null ? signal : code)
      }
      // Un avortement se lit à son dernier mot : on attend la fin du stderr,
      // 200 ms au plus. (Pas l'événement `close` : il ne vient jamais si le
      // canal a été coupé avant la sortie.)
      const err = this.enfant.stderr
      if (signal !== 'SIGABRT' || !err || err.readableEnded) return conclure()
      let fait = false
      const une = () => { if (!fait) { fait = true; conclure() } }
      err.once('end', une)
      err.once('close', une)
      setTimeout(une, 200).unref()
    })
  }

  postMessage (entree) {
    this.enfant.send({ entree, workerData: this.workerData }, (err) => { if (err) this.emit('error', err) })
  }

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
  return { max, attente: [], enCours: false, cleEnCours: null, repos: new Map() }
}

// ⚠ LE REPOS D'UN COMPTE (troisième review du crédit, S1) : un compte dont le
// travail vient d'être coupé — délai entier dépassé, ou mémoire — attend ce
// temps avant d'en relancer un. Sans lui, un compte relançait un PDF de
// 20 s toutes les 2 s, et les autres ne passaient qu'une fois sur 30 s.
const REPOS_MS = 60 * 1000

// Un travail qui a ATTENDU et à qui il reste moins que ça ne lance pas
// d'enfant : il serait tué avant d'avoir rien fait (troisième review HEIC,
// mineur 6).
const RESTE_MIN_MS = 500

// LA file des travaux lourds de l'instance : HEIC et tableaux d'amortissement.
const FILE_LOURDE = creerFile({ max: 2 })

/**
 * Lance `fichier` (un script enfant qui reçoit UN message par
 * `process.on('message')` et répond UNE fois par `process.send`) avec
 * `entree`, dans la file `file`. Rend la réponse de l'enfant ; lève
 * `PanneFil` :
 *   · `occupe` — la file est pleine ; OU le compte (`cle`) a déjà un travail
 *     en cours ou en attente, ou se repose après un travail coupé ; OU le
 *     travail a attendu son tour et n'a pas eu son délai entier (seconde
 *     review, mineur 2 : un document honnête placé derrière un document lent
 *     n'est pas « trop long », il réessaie) ;
 *   · `delai` — l'enfant a eu son délai entier et ne l'a pas tenu ;
 *   · `memoire` — l'enfant a dépassé sa borne de mémoire, ou son tas ;
 *   · `garde_aveugle` — sous Linux, sa mémoire ne se lit pas ;
 *   · `fil_impossible`, `fil_en_erreur` (un avortement qui n'est pas un tas
 *     plein compris), `fil_sorti_<code>`.
 * `deps.Worker` : un double pour les tests (par défaut, un processus enfant :
 * `FilProcessus`) ; `deps.rss` : la mesure de sa mémoire, pour un double.
 */
function executer (file, { fichier, entree, transfert = [], delaiMs, limites = null, workerData, memoireMax = MEMOIRE_MAX_DEFAUT, cle = null }, deps = {}) {
  if (file.enCours && file.attente.length >= file.max) return Promise.reject(new PanneFil('occupe'))
  // ⚠ UN COMPTE, UNE PLACE (troisième review HEIC, constat de sécurité 1) :
  // la file est commune à tous les hôtes de l'instance, et un seul compte qui
  // gardait trois demandes en vol la tenait pour tous (mesuré : 0 photo sur 9
  // pour un autre compte). En cours ou en attente, la clé est prise : la
  // seconde demande du même compte — photo ou tableau — est « occupé ».
  if (cle !== null && (file.cleEnCours === cle || file.attente.some((t) => t.cle === cle))) return Promise.reject(new PanneFil('occupe'))
  if (cle !== null && (file.repos.get(cle) || 0) > Date.now()) return Promise.reject(new PanneFil('occupe', 'repos'))
  return new Promise((resolve, reject) => {
    const tache = { cle, fichier, entree, transfert, limites, workerData, memoireMax, delaiMs, echeance: Date.now() + delaiMs, resolve, reject, deps, minuteur: null }
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
  // A-t-il attendu ? Alors un délai dépassé n'est pas SON délai.
  const aAttendu = reste < tache.delaiMs - 50
  if (reste <= 0 || (aAttendu && reste < RESTE_MIN_MS)) { tache.reject(new PanneFil('occupe')); suivante(file); return }
  file.enCours = true
  file.cleEnCours = tache.cle
  // La place et la clé sont rendues AVANT la réponse : l'appelant qui
  // enchaîne aussitôt un autre travail trouve la file libre.
  const liberer = () => { file.enCours = false; file.cleEnCours = null; suivante(file) }
  lancer(tache, reste).then(
    (r) => { liberer(); tache.resolve(r) },
    (e) => {
      const coupe = e instanceof PanneFil && (e.motif === 'delai' || e.motif === 'memoire')
      if (coupe && !aAttendu && tache.cle !== null) mettreAuRepos(file, tache.cle)
      liberer()
      tache.reject(aAttendu && e instanceof PanneFil && e.motif === 'delai' ? new PanneFil('occupe') : e)
    })
}

function mettreAuRepos (file, cle) {
  const maintenant = Date.now()
  for (const [c, t] of file.repos) if (t <= maintenant) file.repos.delete(c)
  file.repos.set(cle, maintenant + REPOS_MS)
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
    // ⚠ Sous Linux, un vrai enfant dont la mémoire ne se lit pas n'est pas
    // borné : on REFUSE le travail (troisième review du crédit, mineur 3),
    // après trois relevés muets (un enfant qui meurt ne se lit plus non plus).
    // Ailleurs (poste de développement), on le dit une fois.
    const aveugleRefuse = process.platform === 'linux' && !deps.rss && typeof fil.memoire === 'function'
    let muets = 0
    let dit = false
    garde = setInterval(() => {
      const v = mesure()
      if (v === null) {
        muets++
        if (aveugleRefuse && muets >= 3 && !fil.mort) finir(() => reject(new PanneFil('garde_aveugle')))
        else if (!aveugleRefuse && !dit) { dit = true; console.error('[fil-isole] mémoire de l\'enfant illisible : garde inactive pour', fichier) }
        return
      }
      muets = 0
      if (v > memoireMax) finir(() => reject(new PanneFil('memoire', `au-delà de ${Math.round(memoireMax / MO)} Mo`)))
    }, deps.intervalleGardeMs || INTERVALLE_GARDE_MS)
    minuteur = setTimeout(() => finir(() => reject(new PanneFil('delai'))), delaiMs)
    fil.once('message', (m) => finir(() => resolve(m)))
    // `on`, pas `once` : une seconde erreur ne doit jamais trouver la porte
    // vide (troisième review du crédit, S3). `finir` ne répond qu'une fois.
    fil.on('error', (e) => finir(() => reject(new PanneFil(e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memoire' : 'fil_en_erreur', e && e.message))))
    fil.once('exit', (code) => finir(() => reject(new PanneFil(`fil_sorti_${code}`))))
    try {
      fil.postMessage(entree, transfert)
    } catch (e) {
      finir(() => reject(new PanneFil('fil_en_erreur', e && e.message)))
    }
  })
}

module.exports = { creerFile, executer, PanneFil, FilProcessus, FILE_LOURDE, MEMOIRE_MAX_DEFAUT, DELAI_MORT_MS, RESTE_MIN_MS, REPOS_MS, ENV_ENFANT }
