// tests/grille-marche.test.js — la grille du marche (lot V2.5), fonction pure.
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - une grille qui fait peser autant un comparable a 15 % d'occupation qu'un
//     a 78 % (ponderation par nuits, arbitrage 2) ;
//   - une grille « quand meme » sous le seuil (regle 8 : reference amincie, les
//     nombres reels, AUCUN niveau) ;
//   - la selection prouvee (les 3 jacuzzis de La bulle, dont 2 du meme
//     gestionnaire) REJETEE par un seuil sur le gestionnaire (arbitrage 1
//     corrige : c'est un AVERTISSEMENT) ;
//   - un comparable instable EXCLU d'office (regle 17 : montre, jamais exclu) ;
//   - une seconde copie des regles de la V1 (les niveaux viennent de
//     `grilleDeBase`).
//
// Donnees : les hotes et identifiants REELS des trois jacuzzis
// (tests/fixtures/airroi/comps-labulle.json) ; leurs mois sont SYNTHETIQUES —
// les metriques mensuelles des comparables ne sont pas dans les fixtures, et
// aucun appel reel n'a ete fait (cle non disponible, 24 septembre 2026).
//
// CONTRE-EPREUVE (regle 19) : contre une version non ponderee (chaque mois
// compte une fois), « ponderation par nuits » rougit ; contre une version ou le
// gestionnaire est un SEUIL, « la selection prouvee » rougit ; contre une
// version qui exclut les instables, « un instable est montre » rougit ; contre
// une version sans seuil, « reference amincie » rougit.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { lireJson } = require('../lib/airroi/json')
const { grilleMarche, fenetreDouzeMois, nuitsDuMois } = require('../lib/marche/grille-marche')
const { grilleDeBase } = require('../lib/yield/suggestion')

const FIX = path.join(__dirname, 'fixtures', 'airroi')
const lire = f => lireJson(fs.readFileSync(path.join(FIX, f), 'utf8'))
const AUJ = '2026-09-24'
const jours = m => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()

// 26 mois synthetiques : 2024-07 → 2026-08 ; `nuitsParMois` et `prix` par mois.
function mensuel (prixDe, nuitsDe) {
  const out = []
  for (let i = 0; i < 26; i++) {
    const d = new Date(Date.UTC(2024, 6 + i, 1))
    const m = d.toISOString().slice(0, 7)
    const n = nuitsDe(m, i)
    out.push({ date: m, occupancy: n / jours(m), average_daily_rate: prixDe(m, i), revenue: n * prixDe(m, i) })
  }
  return out
}
const COMPS = lire('comps-labulle.json').listings
const reel = nom => {
  const c = COMPS.find(x => x.listing_info.listing_name.startsWith(nom))
  return { listing_id: String(c.listing_info.listing_id), nom: c.listing_info.listing_name,
    host_id: String(c.host_info.host_id), host_name: c.host_info.host_name, cohost_ids: c.host_info.cohost_ids.map(String) }
}
const COZY = reel('Cozy nest'), QUATRE = reel('The 4th'), DUO = reel('Romantic Duo')

test('la fenetre : les 12 derniers mois COMPLETS, le mois courant exclu', () => {
  assert.deepEqual(fenetreDouzeMois(AUJ), { debut: '2025-09', fin: '2026-08' })
  assert.deepEqual(fenetreDouzeMois('2027-01-01'), { debut: '2026-01', fin: '2026-12' })
})

test('LE TEST QUI COMPTE : les nuits d un mois = occupation x jours du mois (La bulle : 223 nuits, le chiffre d AirROI)', () => {
  const m = lire('labulle-60.json').results
  assert.equal(nuitsDuMois(m.find(x => x.date === '2026-08')), 21, '0,677 x 31')
  const g = grilleMarche({ comparables: [{ listing_id: '1', mensuel: m }], aujourdHui: AUJ })
  assert.equal(g.nuits, 223, 'le total des 12 mois = les 223 nuits d AirROI sur La bulle (cadrage §3 bis)')
})

test('LE TEST QUI COMPTE : la selection prouvee (3 jacuzzis, 2 du meme gestionnaire) est FIABLE, et avertit', () => {
  const g = grilleMarche({ aujourdHui: AUJ, comparables: [
    { ...COZY, mensuel: mensuel(() => 150, () => 24) },
    { ...QUATRE, mensuel: mensuel(() => 130, () => 21) },
    { ...DUO, mensuel: mensuel(() => 120, () => 5) }] })
  assert.equal(g.statut, 'fiable', 'le gestionnaire n est pas un seuil')
  assert.equal(g.source, 'marche')
  const a = g.avertissements.find(x => x.type === 'gestionnaire_dominant')
  assert.ok(a, 'mais il est DIT')
  assert.match(a.phrase, /^2 de vos 3 comparables appartiennent au même gestionnaire \(Stephen\) \(9\d % du poids\)/)
})

test('le gestionnaire se lit par l hote ET les co-hotes, jamais par professional_management', () => {
  assert.equal(COMPS.find(x => x.listing_info.listing_name.startsWith('Cozy nest')).host_info.professional_management, false, 'le piege : false pour Instant Pyrenees')
  const g = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', nom: 'A', host_id: '10', cohost_ids: ['99'], mensuel: mensuel(() => 100, () => 20) },
    { listing_id: '2', nom: 'B', host_id: '20', cohost_ids: ['99'], mensuel: mensuel(() => 110, () => 20) },
    { listing_id: '3', nom: 'C', host_id: '30', cohost_ids: [], mensuel: mensuel(() => 120, () => 20) }] })
  assert.ok(g.avertissements.some(x => x.type === 'gestionnaire_dominant' && x.comparables.length === 2), 'un co-hote commun = un gestionnaire')
})

test('LE TEST QUI COMPTE : ponderation par NUITS — un comparable qui vend peu pese peu', () => {
  // ⚠ JEU D'ESSAI CHOISI POUR QUE LA PONDERATION CHANGE LA MEDIANE (la premiere
  // version donnait la meme, pondere ou non : la contre-epreuve l'a montre).
  // Pondere : 47 nuits sur 63 a 100 € -> mediane 100. Non pondere (chaque
  // comparable-mois a egalite) : {100, 100, 110, 300} -> mediane 105.
  const g = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', nom: 'gros', host_id: '1', mensuel: mensuel(() => 100, () => 24) },
    { listing_id: '2', nom: 'gros bis', host_id: '2', mensuel: mensuel(() => 100, () => 23) },
    { listing_id: '3', nom: 'moyen', host_id: '3', mensuel: mensuel(() => 110, () => 10) },
    { listing_id: '4', nom: 'petit', host_id: '4', mensuel: mensuel(() => 300, () => 6) }] })
  assert.equal(g.statut, 'fiable')
  // Le quantile MESURE (avant arrondi et etirement a 5 % de la V1, qui pousse
  // ici Moyen a 105 € parce que Base vaut deja 100 €).
  assert.equal(g.niveaux.find(n => n.nom === 'Moyen').prix_mesure, 100, 'la mediane PONDEREE reste au prix du gros volume')
  assert.ok(g.comparables.find(c => c.nom === 'petit').poids < 0.1)
})

test('les mois a moins de 5 nuits sont ecartes, pas le comparable', () => {
  const g = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', host_id: '1', mensuel: mensuel(() => 100, (m, i) => (i % 2 ? 4 : 20)) },
    { listing_id: '2', host_id: '2', mensuel: mensuel(() => 100, () => 20) },
    { listing_id: '3', host_id: '3', mensuel: mensuel(() => 100, () => 20) }] })
  const c = g.comparables.find(x => x.listing_id === '1')
  assert.equal(c.mois_retenus, 6)
  assert.equal(c.mois_ecartes, 6)
})

test('LE TEST QUI COMPTE : sous le seuil, reference amincie — les nombres reels, AUCUN niveau', () => {
  const deux = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', host_id: '1', mensuel: mensuel(() => 100, () => 20) },
    { listing_id: '2', host_id: '2', mensuel: mensuel(() => 110, () => 20) }] })
  assert.equal(deux.statut, 'reference_amincie')
  assert.equal(deux.niveaux, null, 'jamais un chiffre invente')
  assert.match(deux.motifs.join(' '), /2 comparable\(s\) avec des ventes sur 12 mois, il en faut 3/)
  const peu = grilleMarche({ aujourdHui: AUJ, comparables: [1, 2, 3].map(i =>
    ({ listing_id: String(i), host_id: String(i), mensuel: mensuel(() => 100, () => 5) })) })
  assert.match(peu.motifs.join(' '), /180 nuits Airbnb sur 12 mois, il en faut 200/)
  assert.equal(peu.niveaux, null, '180 nuits : aucun niveau, meme si la V1 saurait en calculer')
  // Un comparable a plus de 50 % (3 comparables) ; a plus de 40 % des 5.
  const lourd = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', nom: 'lourd', host_id: '1', mensuel: mensuel(() => 100, () => 28) },
    { listing_id: '2', host_id: '2', mensuel: mensuel(() => 100, () => 10) },
    { listing_id: '3', host_id: '3', mensuel: mensuel(() => 100, () => 10) }] })
  assert.match(lourd.motifs.join(' '), /« lourd » pèse 58,3 % du total, au-delà de 50 %/)
  assert.equal(lourd.niveaux, null)
  const cinq = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', nom: 'lourd', host_id: '1', mensuel: mensuel(() => 100, () => 27) },
    ...[2, 3, 4, 5].map(i => ({ listing_id: String(i), host_id: String(i), mensuel: mensuel(() => 100, () => 10) }))] })
  assert.match(cinq.motifs.join(' '), /« lourd » pèse 40,3 % du total, au-delà de 40 %/, 'une decimale : jamais « 40 % au-dela de 40 % »')
})

test('LE TEST QUI COMPTE : un comparable instable est MONTRE, jamais exclu', () => {
  const g = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', nom: 'monte', host_id: '1', mensuel: mensuel((m) => (m >= '2025-09' ? 127 : 100), () => 20) },
    { listing_id: '2', host_id: '2', mensuel: mensuel(() => 100, () => 20) },
    { listing_id: '3', host_id: '3', mensuel: mensuel(() => 100, () => 20) }] })
  const c = g.comparables.find(x => x.nom === 'monte')
  assert.equal(c.stabilite.statut, 'instable')
  assert.equal(c.stabilite.phrase, 'niveau instable : +27 % en un an')
  assert.ok(c.nuits > 0 && c.poids > 0, 'il compte dans la grille')
  assert.ok(g.avertissements.some(a => a.type === 'niveau_instable'))
  // Moins de 6 mois avec ventes d'un cote : non mesurable.
  const n = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', nom: 'jeune', host_id: '1', mensuel: mensuel(() => 100, (m) => (m >= '2025-06' ? 20 : 0)) }] })
  assert.equal(n.comparables[0].stabilite.statut, 'non_mesurable')
})

test('LE TEST QUI COMPTE : les niveaux sont ceux de la V1 — grilleDeBase, sans seconde copie', () => {
  const comps = [
    { listing_id: '1', host_id: '1', mensuel: mensuel((m, i) => 90 + (i % 12) * 7, () => 18) },
    { listing_id: '2', host_id: '2', mensuel: mensuel((m, i) => 110 + (i % 12) * 5, () => 22) },
    { listing_id: '3', host_id: '3', mensuel: mensuel((m, i) => 130 + (i % 12) * 3, () => 15) }]
  const g = grilleMarche({ aujourdHui: AUJ, comparables: comps })
  const prix = []
  for (const c of comps) for (const l of c.mensuel) if (l.date >= '2025-09' && l.date <= '2026-08') {
    const n = Math.round(l.occupancy * jours(l.date)); for (let k = 0; k < n; k++) prix.push(l.average_daily_rate)
  }
  const v1 = grilleDeBase(prix, { reservations: 3 })
  assert.deepEqual(g.niveaux.map(n => n.prix), v1.niveaux.map(n => n.prix))
  assert.deepEqual(g.niveaux.map(n => n.nom), ['Base', 'Moyen', 'Haut', 'Très haut', 'Exceptionnel'])
  for (let i = 1; i < 5; i++) assert.ok(g.niveaux[i].prix >= g.niveaux[i - 1].prix, 'monotone')
  assert.ok(g.niveaux.every(n => n.prix % 5 === 0 || n.prix === v1.max || n.prix === v1.min), 'prix ronds')
})

test('le plancher reste arme : un niveau dessous est marque et dit', () => {
  const g = grilleMarche({ aujourdHui: AUJ, prixMinimum: 100, comparables: [1, 2, 3].map(i =>
    ({ listing_id: String(i), host_id: String(i), mensuel: mensuel((m, k) => 80 + (k % 12) * 5, () => 20) })) })
  assert.ok(g.niveaux.some(n => n.sous_plancher))
  assert.match(g.avertissements.find(a => a.type === 'sous_plancher').phrase, /sous votre prix plancher \(100 €\) : on ne descend pas/)
})
