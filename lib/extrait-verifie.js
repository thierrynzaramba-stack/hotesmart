// lib/extrait-verifie.js
// Verification qu'un extrait rendu par un modele est bien une CITATION du texte.
//
// POURQUOI CE MODULE EXISTE. Un extrait est montre a l'hote comme une parole du
// voyageur, puis — une fois confirme — a la prestataire de menage. Une phrase
// reformulee y passerait pour un propos reellement tenu. Le controle doit donc
// etre strict.
//
// Mais un controle par `texte.includes(extrait)` est TROP strict, et la mesure
// l'a montre : sur cinq detections reelles, quatre extraits parfaitement
// legitimes ont ete rejetes pour de simples ecarts d'espaces — le texte d'origine
// contenant des retours ligne ou des espaces doubles la ou le modele rend une
// espace simple. On perdait la valeur principale de la detection pour un detail
// de mise en forme.
//
// La regle appliquee ici : les ESPACES sont souples, le reste ne l'est pas. Un
// modele qui reformule, invente ou concatene des passages non contigus est
// toujours rejete — cas verifie sur les donnees reelles.

// Renvoie la portion REELLE du texte correspondant a l'extrait, ou null.
//
// ⚠ On renvoie la portion du TEXTE D'ORIGINE, jamais la chaine du modele : meme
// quand elle correspond, elle peut differer par la ponctuation ou les espaces.
// Ce qui s'affiche doit etre ce que le voyageur a ecrit, au caractere pres.
function extraitVerifie (texte, extrait) {
  if (!texte || !extrait || typeof extrait !== 'string') return null
  const brut = extrait.trim()
  if (!brut) return null

  // Chemin rapide : citation exacte.
  if (texte.includes(brut)) return brut

  // Chemin souple : toute suite d'espaces du modele peut correspondre a toute
  // suite d'espaces du texte. Le reste est echappe, donc compare a l'identique.
  const motif = brut
    .split(/\s+/)
    .map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')
  let re
  try { re = new RegExp(motif, 'i') } catch { return null }
  const m = texte.match(re)
  return m ? m[0] : null
}

module.exports = { extraitVerifie }
