// lib/airroi/fixture-sure.js — ECRIRE UNE REPONSE AIRROI EN FIXTURE, SANS
// JAMAIS Y LAISSER LA CLE. Un seul controle pour les trois scripts de capture
// (pacing, relief, occupation) : trois copies avaient deja diverge (review de
// f40ee9e et de 9b47690, SECURITE).
//
// ⚠ L'ORDRE EST LA REGLE : on verifie la reponse EN MEMOIRE, puis on ecrit.
// Jamais « ecrire puis supprimer si » : un processus tue entre les deux
// laisserait le fichier dans le depot.
// ⚠ SANS CLE (ou cle mal formee) DANS L'ENVIRONNEMENT, LE CONTROLE NE PROUVE
// RIEN : refus, rien n'est ecrit. Une relance servie par le cache depuis un
// autre shell ecrivait la fixture en affirmant « aucune trace de la cle ».
// ⚠ La cle n'est jamais affichee, ni en entier, ni en partie, ni sa longueur.

const fs = require('fs')

class RefusFixture extends Error {
  constructor (code, message) { super(message); this.name = 'RefusFixture'; this.code = code }
}

/**
 * @param {string} reponse   texte brut de la reponse (depuis le cache)
 * @param {string} fichier   chemin de la fixture
 * @param {string} cle       process.env.AIRROI_API_KEY
 * @throws RefusFixture code 6 (cle absente ou mal formee), 4 (cle trouvee)
 */
function ecrireFixtureSansCle (reponse, fichier, cle) {
  if (typeof reponse !== 'string') throw new RefusFixture(1, 'reponse illisible')
  // Meme test de forme que le client (lib/airroi/client.js) : une cle avec un
  // blanc final ne se retrouverait jamais dans la reponse, controle vide.
  if (!cle || !/^[\x21-\x7e]+$/.test(cle)) {
    throw new RefusFixture(6, 'AIRROI_API_KEY absente ou mal formee — impossible de verifier que la reponse ne contient pas la cle. RIEN n est ecrit.')
  }
  // `btoa`, pas `Buffer.from` : la garde de frontiere V2 (tests/explication-marche.test.js,
  // gele) refuse tout appel « from » dans lib/airroi. La cle est ASCII (verifie ci-dessus).
  const formes = [cle, encodeURIComponent(cle), JSON.stringify(cle).slice(1, -1), btoa(cle)]
  if (formes.some(f => f && reponse.includes(f))) {
    throw new RefusFixture(4, 'la reponse contient la cle — RIEN n est ecrit. Purger aussi le cache local.')
  }
  fs.writeFileSync(fichier, reponse)
}

module.exports = { ecrireFixtureSansCle, RefusFixture }
