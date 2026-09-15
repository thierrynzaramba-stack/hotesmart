// lib/cleaning/changement-regles.js
// DIRE A L'HOTE CE QUI A CHANGE, EN FRANCAIS.
// DOC : docs/kb/menage.md (modif = MEME COMMIT)
//
// ⚠ POURQUOI CE MODULE EXISTE. Le 15 septembre 2026, la prestataire a recu la
// main sur ses jours habituels depuis sa PWA. Cette decision ouvrait une dette
// que le lot suivant devait fermer : elle peut se retirer d'un jour sur lequel
// l'hote compte, et RIEN NE L'EN PREVIENT. Le pendant obligatoire, c'est celui-ci.
//
// ⚠ ET IL FAUT LE DIRE EN JOURS, PAS EN REGLES. « Regle #a4f2 desactivee,
// regle #b7c1 posee » ne dit rien a personne : l'hote ne sait pas ce qu'il a
// perdu. Ce qui l'interesse tient en une phrase — « Lola ne travaille plus le
// samedi » — et c'est ce que ce module calcule, en comparant les JOURS COUVERTS
// avant et apres, jamais les lignes de la table.

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']

// Les jours de semaine qu'un lot de regles couvre, tous rythmes confondus.
//
// ⚠ ON IGNORE LA CADENCE DANS CE CALCUL, ET C'EST ASSUME. « Le samedi une
// semaine sur deux » devenu « le samedi toutes les semaines » n'est pas une
// PERTE de couverture : l'hote n'a rien a rattraper, et l'annoncer comme un
// changement de jour serait faux. Les cas ou la cadence seule bouge sont dits
// autrement (« ses jours ont ete modifies »), sans nommer un jour perdu qui ne
// l'est pas.
function joursCouverts (regles) {
  const out = new Set()
  for (const r of regles || []) {
    if (!Array.isArray(r.jours)) continue          // regle illisible : elle ne dit rien
    for (const j of r.jours) if (Number.isInteger(j) && j >= 0 && j <= 6) out.add(j)
  }
  return out
}

function liste (jours) {
  const noms = [...jours].sort((a, b) => a - b).map(j => 'le ' + JOURS[j])
  if (noms.length <= 1) return noms[0] || ''
  return noms.slice(0, -1).join(', ') + ' et ' + noms[noms.length - 1]
}

// Rend `null` quand rien de visible n'a change — et l'appelant se tait alors.
//
// ⚠ SE TAIRE EST UNE DECISION, PAS UN OUBLI. L'ecran renvoie tout le reglage a
// chaque geste : rouvrir l'onglet et recocher le meme jour produit une ecriture
// sans aucun changement reel. Alerter dessus apprendrait a l'hote a ignorer ces
// messages — et c'est precisement le message qu'il ne faut pas apprendre a
// ignorer (REVIEW.md regle 3, appliquee a l'information).
function resumerChangement ({ avant, apres, prenom, aPartirDe }) {
  const a = joursCouverts(avant)
  const b = joursCouverts(apres)
  const perdus = [...a].filter(j => !b.has(j))
  const gagnes = [...b].filter(j => !a.has(j))
  const qui = prenom || 'Votre prestataire'

  if (!perdus.length && !gagnes.length) {
    // Les jours sont les memes. Le rythme a-t-il bouge ?
    // ⚠ LE RYTHME SE COMPARE SUR LES JOURS RETENUS, pas sur le tableau brut.
    // Sur `[1, 9, -1]` contre `[1]`, les jours COUVERTS sont les memes — 9 et -1
    // n'existent pas — mais les tableaux different : on annoncait « le rythme a
    // change » pour une valeur aberrante qui ne change rien. Un message qui
    // parle pour ne rien dire s'apprend a ne plus se lire.
    const rythme = r => (r || []).filter(x => Array.isArray(x.jours))
      .map(x => `${[...joursCouverts([x])].sort().join('')}:${x.cadence || 1}`)
      .filter(x => !x.startsWith(':')).sort().join('|')
    if (rythme(avant) === rythme(apres)) return null
    return { texte: `${qui} a modifié le rythme de ses jours de travail — les jours ` +
                    'restent les mêmes, une semaine sur deux a changé.',
             perdus: [], gagnes: [] }
  }

  // ⚠ LA PERTE SE DIT EN PREMIER, ET AVEC SA DATE. C'est elle qui demande un
  // geste : un logement peut se retrouver sans personne. Le gain, lui, n'engage
  // rien — et il ne suffit pas a la rendre attitree ce jour-la (c'est `weekdays`
  // qui le decide, pas la disponibilite).
  const bouts = []
  if (perdus.length) {
    bouts.push(`${qui} ne travaille plus ${liste(perdus)}` +
               (aPartirDe ? ` à partir du ${aPartirDe}` : '') + '.')
  }
  if (gagnes.length) {
    bouts.push(`${perdus.length ? 'Elle' : qui} se déclare désormais disponible ` +
               `${liste(gagnes)}` +
               (perdus.length ? '.' : '. Cela ne lui confie aucun logement : ' +
                'c\'est vous qui décidez des jours où vous lui confiez un bien.'))
  }
  return { texte: bouts.join(' '), perdus, gagnes }
}

module.exports = { resumerChangement, joursCouverts, JOURS }
