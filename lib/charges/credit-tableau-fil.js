// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/credit-tableau-fil.js — LE FIL QUI LIT UN TABLEAU D'AMORTISSEMENT
// Lancé par `lireTableauIsole` (lib/charges/credit-tableau.js) et terminé
// après UN tableau : un PDF piégé n'y coûte que ce fil (spec §14.20, review du
// lot crédit, constat S1). Il répond une fois : la lecture, telle quelle.
// ═══════════════════════════════════════════════════════════════════════════

const { parentPort } = require('node:worker_threads')
const { lireTableau } = require('./credit-tableau')

parentPort.once('message', async (octets) => {
  try {
    parentPort.postMessage(await lireTableau(Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength)))
  } catch (e) {
    parentPort.postMessage({ ok: false, code: 'pdf_illisible', detail: null })
  }
})
