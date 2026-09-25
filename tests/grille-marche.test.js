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
const assert = require('node:assert/strict')
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

// ⚠ REECRIT LE 24 SEPTEMBRE 2026 (regle 17) : la premiere version exigeait
// « AUCUN niveau » sous le seuil. Thierry a renverse la decision : ne rien
// montrer, c'est repondre « non » a une question dont la reponse est « je ne
// sais pas ». Les niveaux se calculent par la MEME regle, le statut les marque.
test('LE TEST QUI COMPTE : sous le seuil, reference amincie — les niveaux QUAND MEME, marques, avec les motifs', () => {
  const deux = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', host_id: '1', mensuel: mensuel(() => 100, () => 20) },
    { listing_id: '2', host_id: '2', mensuel: mensuel(() => 110, () => 20) }] })
  assert.equal(deux.statut, 'reference_amincie')
  assert.equal(Array.isArray(deux.niveaux), true, 'des niveaux, pas null')
  assert.deepEqual(deux.niveaux.map(n => n.prix_mesure), [100, 105, 110, 110, 110], 'les quantiles des prix reellement obtenus, rien d invente')
  assert.match(deux.motifs.join(' '), /2 comparable\(s\) avec des ventes sur 12 mois, il en faut 3/)
  const peu = grilleMarche({ aujourdHui: AUJ, comparables: [1, 2, 3].map(i =>
    ({ listing_id: String(i), host_id: String(i), mensuel: mensuel(() => 100, () => 5) })) })
  assert.match(peu.motifs.join(' '), /180 nuits Airbnb sur 12 mois, il en faut 200/)
  assert.equal(peu.statut, 'reference_amincie')
  assert.equal(peu.niveaux[0].prix, 100)
  // Un comparable a plus de 50 % (3 comparables) ; a plus de 40 % des 5.
  const lourd = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', nom: 'lourd', host_id: '1', mensuel: mensuel(() => 100, () => 28) },
    { listing_id: '2', host_id: '2', mensuel: mensuel(() => 100, () => 10) },
    { listing_id: '3', host_id: '3', mensuel: mensuel(() => 100, () => 10) }] })
  assert.match(lourd.motifs.join(' '), /« lourd » pèse 58,3 % du total, au-delà de 50 %/)
  assert.equal(lourd.statut, 'reference_amincie')
  assert.ok(Array.isArray(lourd.niveaux))
  const cinq = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', nom: 'lourd', host_id: '1', mensuel: mensuel(() => 100, () => 27) },
    ...[2, 3, 4, 5].map(i => ({ listing_id: String(i), host_id: String(i), mensuel: mensuel(() => 100, () => 10) }))] })
  assert.match(cinq.motifs.join(' '), /« lourd » pèse 40,3 % du total, au-delà de 40 %/, 'une decimale : jamais « 40 % au-dela de 40 % »')
  // La seule limite gardee : trop peu de nuits pour un quantile (seuil V1, 8).
  const vide = grilleMarche({ aujourdHui: AUJ, comparables: [{ listing_id: '1', host_id: '1', mensuel: mensuel(() => 100, () => 0) }] })
  assert.equal(vide.niveaux, null)
  assert.match(vide.motifs.join(' '), /0 nuits : trop peu pour calculer des niveaux/)
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

// ─── Ajouts de la review du 24 septembre 2026 ───────────────────────────────

test('LE TEST QUI COMPTE : la fenetre suit les DONNEES, pas le calendrier — un cache ancien ne perd aucun mois', () => {
  // Le cache arrete a aout (fixture La bulle) ; releve le 15 novembre.
  const m = lire('labulle-60.json').results
  const g = grilleMarche({ comparables: [{ listing_id: '1', nom: 'x', mensuel: m }], aujourdHui: '2026-11-15' })
  assert.deepEqual(g.fenetre, { debut: '2025-09', fin: '2026-08' }, 'les 12 mois qui finissent au dernier mois connu')
  assert.equal(g.nuits, 223, 'aucun mois perdu (la premiere version en perdait 2 ici, sans bruit)')
  assert.match(g.avertissements.find(a => a.type === 'donnees_anciennes').phrase, /s’arrêtent 2 mois avant/)
  // Plusieurs comparables : la fin est le dernier mois present chez TOUS.
  const court = m.filter(x => x.date <= '2026-06')
  const g2 = grilleMarche({ comparables: [{ listing_id: '1', mensuel: m }, { listing_id: '2', mensuel: court }], aujourdHui: '2026-09-24' })
  assert.equal(g2.fenetre.fin, '2026-06')
})

test('un comparable a qui il manque des mois sur la periode : montre, jamais exclu', () => {
  const g = grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', nom: 'troue', host_id: '1', mensuel: mensuel(() => 100, () => 20).filter(l => l.date !== '2026-03') },
    { listing_id: '2', host_id: '2', mensuel: mensuel(() => 100, () => 20) },
    { listing_id: '3', host_id: '3', mensuel: mensuel(() => 100, () => 20) }] })
  assert.match(g.avertissements.find(a => a.type === 'donnees_incompletes').phrase, /« troue » : 1 mois sans donnée/)
  assert.ok(g.comparables.find(c => c.nom === 'troue').nuits > 0)
})

test('les nuits du seuil sont comptees APRES l ecart des mois a moins de 5 nuits', () => {
  // 3 comparables, mois alternes 4 et 30 nuits : 6 x 30 = 180 retenues chacun,
  // mais les 6 mois a 4 nuits ne comptent pas.
  const g = grilleMarche({ aujourdHui: AUJ, comparables: [1, 2, 3].map(i =>
    ({ listing_id: String(i), host_id: String(i), mensuel: mensuel(() => 100, (m, k) => (k % 2 ? 4 : 30)) })) })
  assert.equal(g.nuits, 540)
  const peu = grilleMarche({ aujourdHui: AUJ, comparables: [1, 2, 3].map(i =>
    ({ listing_id: String(i), host_id: String(i), mensuel: mensuel(() => 100, (m, k) => (k % 2 ? 4 : 11)) })) })
  assert.equal(peu.nuits, 198, '3 x 6 x 11 : les mois a 4 nuits (72) ne portent pas le total a 270')
  assert.equal(peu.statut, 'reference_amincie')
})

test('le poids BRUT juge le seuil : 40,05 % ne passe pas pour 40 % une fois arrondi', () => {
  // 5 comparables (seuil 40 %). Le lourd : 28 nuits x 12 = 336 ; les quatre
  // autres : 126, 126, 126, 125 -> total 839, 336/839 = 40,05 %. Arrondi au
  // millieme (premiere version), il valait 0,400 et passait.
  const autre = (i, extra) => ({ listing_id: String(i), host_id: String(i), mensuel: mensuel(() => 100, (m, k) => (k === 14 ? 10 + extra : 10)) })
  const cinq = lourd => grilleMarche({ aujourdHui: AUJ, comparables: [
    { listing_id: '1', nom: 'lourd', host_id: '1', mensuel: mensuel(() => 100, () => lourd) },
    autre(2, 6), autre(3, 6), autre(4, 6), autre(5, 5)] })
  const g = cinq(28)
  assert.equal(g.nuits, 839)
  assert.equal(g.statut, 'reference_amincie')
  assert.ok(g.motifs.some(m => /« lourd » pèse 40,0 %/.test(m)), 'le motif montre une decimale')
  // Temoin : un lourd a 27 nuits (324/827 = 39,2 %) passe.
  assert.equal(cinq(27).statut, 'fiable')
})

test('le plancher : la liste EXACTE des niveaux marques', () => {
  const g = grilleMarche({ aujourdHui: AUJ, prixMinimum: 100, comparables: [1, 2, 3].map(i =>
    ({ listing_id: String(i), host_id: String(i), mensuel: mensuel((m, k) => 80 + (k % 12) * 5, () => 20) })) })
  const sous = g.niveaux.filter(n => n.sous_plancher).map(n => n.nom)
  assert.deepEqual(sous, g.niveaux.filter(n => n.prix < 100).map(n => n.nom))
  assert.ok(sous.length >= 1 && sous.length < 5)
})

test('les drapeaux de construction voyagent (etire, confondu)', () => {
  // Des prix tres serres : la V1 etire les niveaux.
  const g = grilleMarche({ aujourdHui: AUJ, comparables: [1, 2, 3].map(i =>
    ({ listing_id: String(i), host_id: String(i), mensuel: mensuel((m, k) => 100 + (k % 3), () => 20) })) })
  assert.ok(g.niveaux.some(n => n.etire || n.confondu_avec), 'au moins un niveau etire ou confondu')
  for (const n of g.niveaux) assert.ok('prix_mesure' in n && 'etire' in n && 'confondu_avec' in n)
})

test('LE TEST QUI COMPTE : la stabilite se mesure sur les MEMES mois que les niveaux (mois a moins de 5 nuits ecartes)', () => {
  // L'annee precedente : 12 mois a 3 nuits, a 300 €. Ils ne font pas les
  // niveaux ; ils ne font pas non plus la stabilite (Thierry, decision 5
  // renversee). La premiere version les comptait et criait « +200 % ».
  const m = mensuel((mm, k) => (k < 14 ? 300 : 100), (mm, k) => (k < 14 ? 3 : 20))
  const g = grilleMarche({ aujourdHui: AUJ, comparables: [{ listing_id: '1', nom: 'x', host_id: '1', mensuel: m }] })
  assert.equal(g.comparables[0].stabilite.statut, 'non_mesurable')
  assert.match(g.avertissements.find(a => a.type === 'stabilite_non_mesurable').phrase, /0 mois d’au moins 5 nuits d’un côté, il en faut 6/)
})
