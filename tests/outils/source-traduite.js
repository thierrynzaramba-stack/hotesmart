// tests/outils/source-traduite.js — la source d'une page, avec le TEXTE que
// l'hôte lit à côté de chaque clé de traduction (intégration V5, lot 2).
//
// ⚠ POURQUOI CET OUTIL EXISTE. Des garde-fous du dépôt lisent la SOURCE d'une
// page pour y trouver une phrase (« pas un prix », « ne pilote rien »…). Une
// page intégrée au socle V5 ne porte plus ses phrases : elle porte des CLÉS,
// et la phrase vit dans shared/i18n/fr.json. Lire la page brute rendrait ces
// garde-fous rouges pour une raison qui n'est pas la leur ; les retirer les
// rendrait aveugles. Cet outil écrit, juste après chaque clé que la page
// emploie, la phrase française que cette clé affiche : le garde-fou continue
// de chercher sa phrase AU MÊME ENDROIT de la page, et il rougit si la clé
// change de texte ou si la page cesse de l'employer.
//
// Seules les clés RÉELLES sont développées (présentes dans fr.json) : une clé
// inventée reste une clé, donc un garde-fou qui la cherche par son texte
// rougit — c'est voulu.
const fs = require('fs')
const path = require('path')

const RACINE = path.join(__dirname, '..', '..')

function sourceTraduite (rel, langue = 'fr') {
  const src = fs.readFileSync(path.join(RACINE, rel), 'utf8')
  const dico = JSON.parse(fs.readFileSync(path.join(RACINE, 'shared', 'i18n', `${langue}.json`), 'utf8'))
  return src.replace(/(["'`:])([a-z][a-z0-9_]*\.[a-z0-9_]+)(?=["'`])/g, (m, q, cle) =>
    (Object.prototype.hasOwnProperty.call(dico, cle) ? `${q}${cle}«${dico[cle]}»` : m))
}

module.exports = { sourceTraduite }
