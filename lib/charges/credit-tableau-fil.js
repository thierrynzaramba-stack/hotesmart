// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/credit-tableau-fil.js — LE PROCESSUS QUI LIT UN TABLEAU
// D'AMORTISSEMENT
// Lancé par `lireTableauIsole` (lib/charges/credit-tableau.js) via
// lib/charges/fil-isole.js, et tué après UN tableau : un PDF piégé n'y coûte
// que ce processus (spec §14.20, reviews du lot crédit, constat S1). Il
// répond une fois : la lecture, telle quelle.
// ═══════════════════════════════════════════════════════════════════════════

const { lireTableau } = require('./credit-tableau')

// Le parent mort, l'enfant ne lui survit pas.
process.once('disconnect', () => process.exit(0))
process.once('message', async ({ entree }) => {
  try {
    process.send(await lireTableau(Buffer.from(entree.buffer, entree.byteOffset, entree.byteLength)))
  } catch (e) {
    process.send({ ok: false, code: 'pdf_illisible', detail: null })
  }
})
