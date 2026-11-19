// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/fil-isole.js — UN TRAVAIL LOURD DANS UN FIL À USAGE UNIQUE,
// UN SEUL À LA FOIS PAR INSTANCE
// Spec : docs/specs/spec-compte-de-charges.md §14.20 (review du lot crédit,
// constat de sécurité S1)
//
// ⚠ POURQUOI. Un fichier envoyé par un hôte peut être fabriqué pour coûter :
// un PDF de 62 Ko a tenu la review 6 à 26 s et 0,4 à 0,9 Go ; un autre, plus
// de 150 s. Dans le fil principal, c'est la fonction entière qui gèle, avec
// les requêtes des autres hôtes. Ici le travail tourne dans un fil :
//   · borné en temps (`delaiMs`, compté DEPUIS L'APPEL, attente comprise) ;
//   · borné en tas JavaScript (`resourceLimits`) ;
//   · terminé après UN travail — sa mémoire meurt avec lui ;
//   · UN SEUL vivant par instance, et une file courte : au-delà, « occupé ».
// Le même schéma tient déjà la conversion HEIC (`convertirIsole`,
// lib/charges/heic.js), écrite avant ce module.
// ═══════════════════════════════════════════════════════════════════════════

class PanneFil extends Error {
  constructor (motif, detail = null) {
    super(motif)
    this.name = 'PanneFil'
    this.motif = motif
    this.detail = detail ? String(detail).slice(0, 200) : null
  }
}

/** Une file : un fil vivant au plus, `max` travaux en attente au plus. */
function creerFile ({ max = 2 } = {}) {
  return { max, attente: [], enCours: false }
}

/**
 * Lance `fichier` (un module qui écoute UN message de `parentPort` et répond
 * UNE fois) avec `entree`, dans la file `file`. Rend la réponse du fil ;
 * lève `PanneFil` (`occupe`, `delai`, `fil_en_erreur`, `fil_sorti_<code>`).
 * `deps.Worker` : un double pour les tests.
 */
function executer (file, { fichier, entree, transfert = [], delaiMs, limites = null }, deps = {}) {
  if (file.enCours && file.attente.length >= file.max) return Promise.reject(new PanneFil('occupe'))
  return new Promise((resolve, reject) => {
    const tache = { fichier, entree, transfert, limites, echeance: Date.now() + delaiMs, resolve, reject, deps, minuteur: null }
    tache.minuteur = setTimeout(() => {
      const i = file.attente.indexOf(tache)
      if (i >= 0) { file.attente.splice(i, 1); reject(new PanneFil('delai')) }
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
  if (reste <= 0) { tache.reject(new PanneFil('delai')); suivante(file); return }
  file.enCours = true
  lancer(tache, reste)
    .then(tache.resolve, tache.reject)
    .finally(() => { file.enCours = false; suivante(file) })
}

function lancer ({ fichier, entree, transfert, limites, deps }, delaiMs) {
  const Worker = deps.Worker || require('node:worker_threads').Worker
  return new Promise((resolve, reject) => {
    let fini = false
    let minuteur = null
    let fil
    try {
      fil = new Worker(fichier, { stdout: true, stderr: true, ...(limites ? { resourceLimits: limites } : {}) })
    } catch (e) {
      reject(new PanneFil('fil_impossible', e && e.message))
      return
    }
    if (fil.stdout) fil.stdout.resume()
    if (fil.stderr) fil.stderr.resume()
    const finir = (geste) => {
      if (fini) return
      fini = true
      clearTimeout(minuteur)
      Promise.resolve().then(() => fil.terminate()).catch(() => {})
      geste()
    }
    minuteur = setTimeout(() => finir(() => reject(new PanneFil('delai'))), delaiMs)
    fil.once('message', (m) => finir(() => resolve(m)))
    fil.once('error', (e) => finir(() => reject(new PanneFil(e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memoire' : 'fil_en_erreur', e && e.message))))
    fil.once('exit', (code) => finir(() => reject(new PanneFil(`fil_sorti_${code}`))))
    fil.postMessage(entree, transfert)
  })
}

module.exports = { creerFile, executer, PanneFil }
