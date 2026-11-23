// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/heic-fil.js — LE PROCESSUS À USAGE UNIQUE D'UNE CONVERSION HEIC
// Lancé par `convertirIsole` (lib/charges/heic.js) via lib/charges/fil-isole.js,
// tué après UNE photo : la mémoire WebAssembly du décodeur meurt avec lui
// (spec §14.19, review, constat de sécurité 1 ; §14.20, un processus plutôt
// qu'un fil). Il ne parle qu'une fois : le JPEG, le motif d'un fichier
// inconvertible, ou une panne.
// ═══════════════════════════════════════════════════════════════════════════

const { heicEnJpeg, ConversionImpossible, PanneConversion } = require('./heic')

// Le parent mort, l'enfant ne lui survit pas.
process.once('disconnect', () => process.exit(0))
process.once('message', async ({ entree, workerData }) => {
  try {
    const jpeg = await heicEnJpeg(Buffer.from(entree.buffer, entree.byteOffset, entree.byteLength), { max: workerData.max })
    process.send({ ok: true, jpeg: Uint8Array.from(jpeg) })
  } catch (e) {
    if (e instanceof ConversionImpossible) process.send({ ok: false, motif: e.motif })
    else process.send({ ok: false, panne: e instanceof PanneConversion ? e.motif : 'erreur', cause: String((e && (e.detail || e.message)) || '').slice(0, 200) })
  }
})
