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

// ⚠ AUCUNE REGLE VEUT DIRE « DISPONIBLE TOUS LES JOURS », PAS « AUCUN JOUR ».
// C'est l'etage 4 de la precedence (`estDisponible` : `if (!actives.length)
// return true`), et la PWA le dit elle-meme a la prestataire. Compter un lot
// vide comme l'ensemble VIDE inversait le sens du message sur les deux gestes
// les plus frequents :
//   - PREMIER REGLAGE (aucune regle -> le samedi) : elle vient de se retirer SIX
//     jours sur sept, et l'hote lisait « elle se declare disponible le samedi ».
//     Pire : `perdus` etait vide, donc AUCUN menage propose n'etait repris — le
//     trou que ce lot existe pour fermer restait ouvert sur le cas nominal.
//   - TOUT DECOCHER : elle devient disponible 7/7, et l'hote lisait « elle ne
//     travaille plus le lundi, le mardi et le mercredi ».
//
// ⚠ MAIS DES REGLES TOUTES ILLISIBLES NE SONT PAS « AUCUNE REGLE ». `regleCouvre`
// rend `null` sur une recurrence qu'on ne sait pas relire : le moteur la compte
// et ne la fait couvrir presque rien. L'ensemble vide est alors JUSTE. On
// distingue donc l'absence de LIGNE de l'absence de jour lisible.
const SEMAINE_ENTIERE = () => new Set([0, 1, 2, 3, 4, 5, 6])
const couverture = regles => (regles || []).length ? joursCouverts(regles) : SEMAINE_ENTIERE()

// Rend `null` quand rien de visible n'a change — et l'appelant se tait alors.
//
// ⚠ SE TAIRE EST UNE DECISION, PAS UN OUBLI. L'ecran renvoie tout le reglage a
// chaque geste : rouvrir l'onglet et recocher le meme jour produit une ecriture
// sans aucun changement reel. Alerter dessus apprendrait a l'hote a ignorer ces
// messages — et c'est precisement le message qu'il ne faut pas apprendre a
// ignorer (REVIEW.md regle 3, appliquee a l'information).
function resumerChangement ({ avant, apres, prenom, aPartirDe }) {
  const a = couverture(avant)
  const b = couverture(apres)
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
    // ⚠ « AUCUNE REGLE » ET « LES SEPT JOURS, CHAQUE SEMAINE » SONT LE MEME
    // ETAT pour le moteur. Les distinguer faisait annoncer « le rythme a
    // change » a quelqu'un qui vient simplement de cocher ses sept cases : un
    // message qui parle pour ne rien dire s'apprend a ne plus se lire.
    const rythme = r => !(r || []).length ? '0123456:1'
      : (r || []).filter(x => Array.isArray(x.jours))
          .map(x => `${[...joursCouverts([x])].sort().join('')}:${x.cadence || 1}`)
          .filter(x => !x.startsWith(':')).sort().join('|')
    if (rythme(avant) === rythme(apres)) return null
    // ⚠ LE SENS COMPTE, ET LES DEUX SENS N'ONT PAS LE MEME PRIX. Passer a « une
    // semaine sur deux » SUPPRIME la moitie de ses venues — c'est une perte, et
    // l'hote doit pouvoir la lire comme telle. L'inverse les double, et
    // n'engage rien. La premiere version rendait le MEME texte dans les deux
    // sens : l'hote ne pouvait pas savoir lequel.
    const cadenceMax = r => Math.max(1, ...(r || []).filter(x => Array.isArray(x.jours))
      .map(x => Number(x.cadence) || 1))
    const cAvant = cadenceMax(avant), cApres = cadenceMax(apres)
    if (cApres > cAvant) {
      return { texte: `${qui} ne vient plus qu'une semaine sur ${cApres} sur ses jours ` +
                      'habituels — elle en fait donc moins qu\'avant.' +
                      (aPartirDe ? ` À partir du ${aPartirDe}.` : ''),
               perdus: [], gagnes: [], cadenceReduite: true }
    }
    if (cApres < cAvant) {
      return { texte: `${qui} vient désormais toutes les ${cApres > 1 ? cApres + ' semaines' : 'semaines'} ` +
                      'sur ses jours habituels, au lieu d\'une semaine sur ' + cAvant + '.',
               perdus: [], gagnes: [] }
    }
    return { texte: `${qui} a modifié le rythme de ses jours de travail — les jours ` +
                    'restent les mêmes, l\'alternance des semaines a changé.',
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
