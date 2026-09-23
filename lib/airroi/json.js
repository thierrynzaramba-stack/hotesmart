// lib/airroi/json.js — LIRE UNE REPONSE AIRROI SANS PERDRE UN IDENTIFIANT.
//
// ⚠ LES IDENTIFIANTS AIRBNB DEPASSENT 2^53. AirROI les rend en NOMBRES JSON ;
// `JSON.parse` les arrondit en silence : l'annonce de La bulle,
// 992723390568420450, devient 992723390568420500 — une AUTRE annonce, et tout
// appel suivant qui la reprend interroge le mauvais bien. Constate le
// 23 septembre 2026 sur moi.json.
//
// Regle : tout entier de 16 chiffres ou plus (au-dela de la precision exacte
// d'un double, qui garantit 15) est lu en TEXTE. Les grandeurs metier d'AirROI
// (prix, nuits, revenus) n'approchent jamais 16 chiffres.
//
// ⚠ ON NE TOUCHE QU'AUX VALEURS, jamais au contenu des chaines : un entier long
// deja entre guillemets reste tel quel.

function lireJson (texte) {
  if (typeof texte !== 'string') throw new Error('[airroi] reponse non textuelle')
  let sortie = ''
  let i = 0
  const n = texte.length
  while (i < n) {
    const c = texte[i]
    if (c === '"') {
      // Recopier la chaine entiere, echappements compris.
      let j = i + 1
      while (j < n && texte[j] !== '"') j += texte[j] === '\\' ? 2 : 1
      sortie += texte.slice(i, j + 1)
      i = j + 1
      continue
    }
    if ((c >= '0' && c <= '9') || c === '-') {
      let j = i + (c === '-' ? 1 : 0)
      while (j < n && texte[j] >= '0' && texte[j] <= '9') j++
      const entier = j < n && !'.eEe'.includes(texte[j])
      const chiffres = j - i - (c === '-' ? 1 : 0)
      if ((entier || j === n) && chiffres >= 16) {
        sortie += `"${texte.slice(i, j)}"`
        i = j
        continue
      }
      // Nombre ordinaire (avec decimales ou exposant eventuels).
      while (j < n && /[0-9.eE+-]/.test(texte[j])) j++
      sortie += texte.slice(i, j)
      i = j
      continue
    }
    sortie += c
    i++
  }
  return JSON.parse(sortie)
}

module.exports = { lireJson }
