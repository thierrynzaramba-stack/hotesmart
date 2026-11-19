// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/heic-fil.js — LE FIL À USAGE UNIQUE D'UNE CONVERSION HEIC
// Lancé par `convertirIsole` (lib/charges/heic.js), terminé après UNE photo :
// la mémoire WebAssembly du décodeur meurt avec lui (spec §14.19, review,
// constat de sécurité 1). Il ne parle qu'une fois : le JPEG, le motif d'un
// fichier inconvertible, ou une panne.
// ═══════════════════════════════════════════════════════════════════════════

const { parentPort, workerData } = require('node:worker_threads')
const { heicEnJpeg, ConversionImpossible, PanneConversion } = require('./heic')

parentPort.once('message', async (octets) => {
  try {
    const jpeg = await heicEnJpeg(Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength), { max: workerData.max })
    const sortie = Uint8Array.from(jpeg)
    parentPort.postMessage({ ok: true, jpeg: sortie }, [sortie.buffer])
  } catch (e) {
    if (e instanceof ConversionImpossible) parentPort.postMessage({ ok: false, motif: e.motif })
    else parentPort.postMessage({ ok: false, panne: e instanceof PanneConversion ? e.motif : 'erreur' })
  }
})
