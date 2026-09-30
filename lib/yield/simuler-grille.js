// lib/yield/simuler-grille.js — CE QU'UN GESTE SUR LA GRILLE CHANGERAIT, AVANT
// DE L'ENREGISTRER (lot 4.6.7, decision 4 de Thierry : « N nuits vont changer
// de prix » avant d'appliquer).
//
// ⚠ LECTURE SEULE. Aucune ecriture, aucun appel au canal.
// ⚠ LE COMPTE EST CELUI DU GESTE, PAS DU PASSAGE DU JOUR. On rejoue LA MEME
// matiere (un seul `preparerContexte`) avec la grille ACTUELLE puis avec la
// grille PROPOSEE, et on ne compte que les nuits dont le prix differe entre les
// deux. Comparer la grille proposee au calendrier aurait melange au geste les
// changements que le moteur ferait de toute facon ce jour-la.
// ⚠ LA REGLE DU PRIX EST CELLE DU MOTEUR : `prixDeLaNuit` (lib/yield/contexte-
// du-bien.js), et les nuits sautees par `calculerPrix` (lib/moteur-prix.js) —
// vendues, fermees, prix de l'hote au ✎, sans ligne — ne sont jamais comptees.

const { preparerContexte, prixDeLaNuit } = require('./contexte-du-bien')
const { appliquerGrilleHote } = require('./grille-hote')
const { calculerPrix } = require('../moteur-prix')
const { fermeturesDuBien } = require('../fermetures')
const { prixHoteDuBien } = require('../prix-hote')
const { finDeFenetre } = require('../pilote-tarifaire')

/**
 * @param bien       ligne `properties` complete (select('*'))
 * @param actuels    Map niveau -> { rate_cents } : les niveaux fixes aujourd'hui
 * @param proposes   Map niveau -> { rate_cents } : apres le geste
 * @param aujourdHui 'AAAA-MM-JJ' (Paris)
 * @returns { pilote, nuits, du, au, min, max, grille } — `pilote: false` : bien
 *          non pilote, aucun prix du calendrier ne bouge (la grille ne sert
 *          qu'aux suggestions) ; `grille` : les niveaux PROPOSES.
 */
async function simulerGrille (supabase, bien, actuels, proposes, aujourdHui) {
  const fin = finDeFenetre(bien, aujourdHui)
  const ctx = await preparerContexte(supabase, bien, bien.user_id, { aujourdHui, debut: aujourdHui, fin: fin || aujourdHui, grilleHote: new Map() })
  const grilleProposee = appliquerGrilleHote(ctx.grilleCalculee, proposes)
  const niveaux = grilleProposee && grilleProposee.base && grilleProposee.base.niveaux
    ? grilleProposee.base.niveaux.map(n => ({ nom: n.nom, prix: n.prix, prix_calcule: n.prix_calcule ?? n.prix, fixe_par_hote: !!n.fixe_par_hote }))
    : null
  if (!fin) return { pilote: false, nuits: 0, du: null, au: null, min: null, max: null, grille: niveaux }
  const avant = { ...ctx, grille: appliquerGrilleHote(ctx.grilleCalculee, actuels) }
  const apres = { ...ctx, grille: grilleProposee }
  const fermetures = await fermeturesDuBien(supabase, bien.id, aujourdHui, fin)
  const prixHote = await prixHoteDuBien(supabase, bien.id, aujourdHui, fin)
  const lignes = [...ctx.parDate.values()].filter(l => l.date >= aujourdHui && l.date <= fin)
  const ouverts = ctx.ouvertureConnue ? ctx.ouverts : null
  const commun = { aujourdHui, fin, lignes, fermetures, prixHote, ouverts }
  const pA = calculerPrix({ ...commun, prix: (d, o) => prixDeLaNuit(avant, d, o) })
  const pB = calculerPrix({ ...commun, prix: (d, o) => prixDeLaNuit(apres, d, o) })
  // Le prix que chaque version POSERAIT, nuit par nuit (inchange = prix en place).
  const pose = p => {
    const m = new Map()
    for (const l of lignes) m.set(l.date, l.rate != null ? Math.round(Number(l.rate) * 100) : null)
    for (const c of p.changements) m.set(c.date, c.prix_centimes)
    return m
  }
  const a = pose(pA), b = pose(pB)
  const changes = []
  for (const [d, v] of b) if (v !== a.get(d)) changes.push({ date: d, avant_centimes: a.get(d), apres_centimes: v })
  changes.sort((x, y) => (x.date < y.date ? -1 : 1))
  const prix = changes.map(c => c.apres_centimes).filter(v => v != null)
  return { pilote: true, nuits: changes.length, du: changes[0]?.date || null, au: changes[changes.length - 1]?.date || null,
    min: prix.length ? Math.min(...prix) / 100 : null, max: prix.length ? Math.max(...prix) / 100 : null, grille: niveaux }
}

module.exports = { simulerGrille }
