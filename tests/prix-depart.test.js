// tests/prix-depart.test.js — les prix de depart d'un bien en 8 cases, ancre ×
// forme (spec §22.11 de docs/kb/chantier-nouveau-bien.md, decisions de Thierry
// du 5 octobre 2026). Fonction pure : aucune base, aucun reseau ; `aujourdhui`
// est injecte (dates figees : le test n'a pas d'horloge).
//
// CE QU'ILS EMPECHENT (vecu du 5 octobre 2026) :
//   - un prix week-end qui DISPARAIT (cran de 1 a 3 €, « Moyen » sous « Base ») ;
//   - un hote compte deux fois parce qu'il a deux annonces ;
//   - une strategie qui recopie un seul bien ou sort du marche ;
//   - un ecart faible ou une montee ratee LISSES au lieu d'etre dits.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { lireJson } = require('../lib/airroi/json')
const P = require('../lib/marche/prix-depart')

const AUJ = '2026-10-05'
const jours = n => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${AUJ}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10))
const JOURS = jours(200)
const estWE = j => [5, 6].includes(new Date(`${j}T00:00:00Z`).getUTCDay())
// La saison du segment, CONTINUE (comme dans les vrais calendriers) : un sommet
// en fevrier, +30 % au plus. Une saison en marches d'escalier ferait des
// egalites aux seuils des quarts (voir le test des egalites).
const saison = j => 1 + 0.3 * Math.max(0, Math.cos((Date.parse(`${j}T00:00:00Z`) - Date.parse('2027-02-10T00:00:00Z')) / (86400000 * 365) * 2 * Math.PI))
// Une annonce synthetique : base × saison × prime week-end.
const annonce = (id, hote, base, { prime = 1.25, position = 'equivalent', plat = false } = {}) => ({
  listing_id: id, hote, position,
  jours: JOURS.map(j => ({ date: j, rate: Math.round(base * (plat ? 1 : saison(j)) * (estWE(j) ? prime : 1) * 100) / 100, min_nights: 2 })),
})
const cinq = (opts = {}) => [annonce('1', 'A', 80, opts), annonce('2', 'B', 110, opts), annonce('3', 'C', 130, opts), annonce('4', 'D', 150, opts), annonce('5', 'E', 200, opts)]
const caseDe = (r, n, t) => r.cases.find(c => c.niveau === n && c.type === t)
// Une phase 1 preparee (comme `phase1DuMarche` la rend) : chaque jour a sa
// saison, chaque case sa forme.
const UNES = Object.fromEntries(['creux', 'modere', 'favorable', 'pic'].flatMap(n => ['semaine', 'weekend'].map(t => [`${n}/${t}`, 1])))
const PH = (niveau, formes = UNES) => ({ localite: 'Bagnères-de-Bigorre', niveaux: new Map(JOURS.map(j => [j, niveau(j)])), formes, prime_week_end_pct: 7.8 })

test('LE TEST QUI COMPTE (vecu, loft de recette, 5 octobre 2026) : les 8 cases, 7 hotes, le prix week-end garde, tout monte', () => {
  const f = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'prix-depart-loft-2026-10-05.json'), 'utf8'))
  const r = P.prixDeDepart({ calendriers: f.comparables, strategie: 'qualite', aujourdhui: '2026-10-05' })
  assert.equal(r.statut, 'calcule')
  assert.deepEqual([r.comparables, r.hotes], [9, 7], '9 annonces, 7 hotes : Charles et Cassandra ne comptent qu une fois')
  assert.equal(r.niveaux_source, 'segment')
  assert.deepEqual(r.ancres, { agressif: 140, juste: 158, qualite: 165 }, 'l ancre reste sur TOUS les hotes (regle d)')
  // Regle (d), 6 octobre 2026 : 6 hotes sur 7 bougent leurs prix ; l'hote a prix
  // fixe ne fait plus la forme — la saison et la prime week-end s'ouvrent
  // (Creux semaine 157 → 149, Tres haut week-end 202 → 208 en prix marche).
  assert.equal(r.hotes_mouvants, 6)
  const attendu = { 'creux/semaine': [133, 149, 156], 'creux/weekend': [157, 177, 185], 'modere/semaine': [140, 158, 165], 'modere/weekend': [168, 189, 198],
    'favorable/semaine': [140, 158, 165], 'favorable/weekend': [176, 198, 208], 'pic/semaine': [154, 173, 182], 'pic/weekend': [184, 208, 218] }
  for (const c of r.cases) assert.deepEqual([c.strategies.agressif, c.strategies.juste, c.strategies.qualite], attendu[`${c.niveau}/${c.type}`], `${c.niveau}/${c.type}`)
  assert.deepEqual(r.alertes, [], 'tout monte')
  assert.deepEqual(r.serre, { agressif_juste: 16, juste_qualite: 7 }, 'le marche serre est DIT')
  // Le week-end garde sa prime a chaque niveau.
  for (const n of P.NIVEAUX) assert.ok(caseDe(r, n, 'weekend').prix - caseDe(r, n, 'semaine').prix >= 15, n)
})

test('le week-end se mesure sur les NUITS du vendredi et du samedi (dette 30)', () => {
  assert.equal(P.typeDe('2026-10-09'), 'weekend', 'vendredi')
  assert.equal(P.typeDe('2026-10-10'), 'weekend', 'samedi')
  assert.equal(P.typeDe('2026-10-11'), 'semaine', 'dimanche soir : on repart lundi')
})

test('LE TEST QUI COMPTE : la prime week-end de chaque hote, mesuree contre SON propre prix, survit — et la saison du segment fait monter les niveaux', () => {
  const r = P.prixDeDepart({ calendriers: cinq(), strategie: 'juste', aujourdhui: AUJ })
  assert.equal(r.statut, 'calcule')
  assert.equal(r.niveaux_source, 'segment')
  for (const n of P.NIVEAUX) {
    const se = caseDe(r, n, 'semaine')
    const we = caseDe(r, n, 'weekend')
    if (se.statut === 'calcule' && we.statut === 'calcule') assert.ok(Math.abs(we.forme / se.forme - 1.25) < 0.02, `${n} : prime 25 % gardee (${we.forme} / ${se.forme})`)
  }
  assert.ok(caseDe(r, 'pic', 'semaine').prix > caseDe(r, 'creux', 'semaine').prix, 'la saison monte')
  assert.deepEqual(r.alertes, [])
})

test('LE TEST QUI COMPTE : un hote = une voix — une seconde annonce du meme hote ne deplace pas les ancres', () => {
  const seul = P.prixDeDepart({ calendriers: cinq(), strategie: 'juste', aujourdhui: AUJ })
  const double = P.prixDeDepart({ calendriers: [...cinq(), annonce('6', 'E', 200)], strategie: 'juste', aujourdhui: AUJ })
  assert.deepEqual([double.hotes, double.comparables], [5, 6])
  assert.deepEqual(double.ancres, seul.ancres)
})

test('moins de 5 hotes independants : rien n est calcule, et c est dit', () => {
  const r = P.prixDeDepart({ calendriers: [...cinq().slice(0, 4), annonce('6', 'D', 160)], strategie: 'juste', aujourdhui: AUJ })
  assert.equal(r.statut, 'non_calculable')
  assert.match(r.motif, /4 hôtes indépendants parmi vos comparables : il en faut au moins 5/)
})

test('les strategies se placent aux PERCENTILES 25 / 50 / 75 des ancres, jamais aux bords', () => {
  const r = P.prixDeDepart({ calendriers: cinq({ plat: true, prime: 1 }), phase1: PH(() => 'modere'), strategie: 'juste', aujourdhui: AUJ })
  // Ancres 80, 110, 130, 150, 200 : P25 = 110, P50 = 130, P75 = 150.
  assert.deepEqual(r.ancres, { agressif: 110, juste: 130, qualite: 150 })
})

test('les positions decalent l ancre d un quart de la largeur au plus', () => {
  const dessus = P.prixDeDepart({ calendriers: cinq({ plat: true, prime: 1, position: 'dessus' }), phase1: PH(() => 'modere'), strategie: 'juste', aujourdhui: AUJ })
  // Largeur des ancres 200 − 80 = 120 ; un quart : +30 €.
  assert.deepEqual(dessus.ancres, { agressif: 140, juste: 160, qualite: 180 })
  assert.equal(dessus.position, 1)
})

test('regle (d) : moins de 2 hotes qui bougent — la forme vient de la PHASE 1 (ses saisons, ses formes), et c est dit ; sans phase 1, non calculable', () => {
  const plats = cinq({ plat: true })
  const formes = { ...UNES, 'pic/semaine': 1.2, 'pic/weekend': 1.3 }
  const repli = P.prixDeDepart({ calendriers: plats, phase1: PH(j => (j.slice(5, 7) === '12' ? 'pic' : 'creux'), formes), strategie: 'juste', aujourdhui: AUJ })
  assert.equal(repli.niveaux_source, 'phase1')
  assert.equal(repli.phase1_localite, 'Bagnères-de-Bigorre')
  assert.equal(repli.hotes_mouvants, 0)
  // Ancre P50 = 130 € (tous les hotes) ; la forme est celle de la phase 1, ramenee
  // dans la fourchette des hotes (80 a 200 €).
  assert.equal(caseDe(repli, 'creux', 'semaine').prix, 130)
  assert.equal(caseDe(repli, 'pic', 'semaine').prix, 156)
  assert.equal(caseDe(repli, 'pic', 'weekend').prix, 169)
  assert.ok(repli.jours.filter(j => j.niveau).every(j => j.source === 'marche'))
  const sans = P.prixDeDepart({ calendriers: plats, strategie: 'juste', aujourdhui: AUJ })
  assert.equal(sans.statut, 'non_calculable')
  assert.match(sans.motif, /^0 de vos hôtes change ses prix au fil des saisons \(il en faut 2\), et les saisons du marché de votre ville ne couvrent pas les 6 prochains mois/)
  // Une phase 1 sans formes (prix du marche absents) : non calculable aussi.
  assert.equal(P.prixDeDepart({ calendriers: plats, phase1: { ...PH(() => 'creux'), formes: null }, strategie: 'juste', aujourdhui: AUJ }).statut, 'non_calculable')
})

test('LE TEST QUI COMPTE (regle d) : la FORME ne vient que des hotes qui bougent — trois hotes fixes ne l ecrasent plus ; l ANCRE reste sur tous', () => {
  // Deux hotes qui bougent (saison +30 %, prime 25 %), trois a prix fixe.
  const mixte = [annonce('1', 'A', 80, { plat: true, prime: 1 }), annonce('2', 'B', 110), annonce('3', 'C', 130, { plat: true, prime: 1 }), annonce('4', 'D', 150), annonce('5', 'E', 200, { plat: true, prime: 1 })]
  const r = P.prixDeDepart({ calendriers: mixte, strategie: 'juste', aujourdhui: AUJ })
  assert.equal(r.niveaux_source, 'segment')
  assert.equal(r.hotes_mouvants, 2)
  // L'ancre de chaque hote = son prix de semaine habituel (mediane sur 6 mois) ;
  // les strategies = P25 / P50 / P75 sur les CINQ, fixes compris.
  const fin = '2027-04-04' // 182 nuits a partir du 5 octobre
  const med = xs => { const t = [...xs].sort((a, b) => a - b); const m = Math.floor(t.length / 2); return t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2 }
  const ancres = mixte.map(c => med(c.jours.filter(n => n.date <= fin && !estWE(n.date)).map(n => n.rate)))
  assert.deepEqual(r.ancres, { agressif: Math.round(P.percentile(ancres, 0.25)), juste: Math.round(P.percentile(ancres, 0.5)), qualite: Math.round(P.percentile(ancres, 0.75)) }, 'P25 / P50 / P75 des 5 hotes')
  for (const n of P.NIVEAUX) {
    const se = caseDe(r, n, 'semaine')
    const we = caseDe(r, n, 'weekend')
    if (se.statut === 'calcule' && we.statut === 'calcule') assert.ok(Math.abs(we.forme / se.forme - 1.25) < 0.02, `${n} : la prime des hotes qui bougent (${we.forme} / ${se.forme})`)
  }
  // La saison des hotes qui bougent s'ouvre (×0,82 → ×1,07 en semaine) : sur
  // les cinq, la mediane serait restee a ×1,00 dans toutes les cases (3 fixes).
  assert.ok(caseDe(r, 'pic', 'semaine').forme - caseDe(r, 'creux', 'semaine').forme >= 0.2, 'la saison des hotes qui bougent')
  // La prime d'information est la mediane sur TOUS les hotes : 3 fixes sur 5.
  assert.equal(r.prime_week_end.comparables, 0)
})

test('regle (d) : la prime week-end est une INFORMATION — comparables (tous les hotes) et marche de la ville (phase 1), sans effet sur le prix', () => {
  const avec = P.prixDeDepart({ calendriers: cinq(), phase1: PH(() => 'creux'), strategie: 'juste', aujourdhui: AUJ })
  const sans = P.prixDeDepart({ calendriers: cinq(), strategie: 'juste', aujourdhui: AUJ })
  assert.deepEqual(avec.prime_week_end, { comparables: 25, marche: 7.8, localite: 'Bagnères-de-Bigorre' })
  assert.deepEqual(sans.prime_week_end, { comparables: 25, marche: null, localite: null })
  assert.deepEqual(avec.cases, sans.cases, 'aucun effet sur le prix')
})

test('regle (d) : phase1DuMarche — les saisons nommees deviennent les niveaux, les prix affiches du marche donnent la forme', () => {
  const pacing = JOURS.map(j => ({ date: j, available_rate_avg: (j < '2026-12-01' ? 100 : 130) * (estWE(j) ? 1.1 : 1) }))
  const ph = P.phase1DuMarche({ localite: 'X', saisons: [{ debut: '2026-10-05', fin: '2026-11-30', saison: 'basse' }, { debut: '2026-12-01', fin: '2027-04-30', saison: 'tres_forte' }],
    pacing, ecarts: [{ ecart_prix_pct: 7.1 }, { ecart_prix_pct: null }, { ecart_prix_pct: 8.5 }], aujourdhui: AUJ })
  assert.equal(ph.niveaux.get('2026-10-06'), 'creux')
  assert.equal(ph.niveaux.get('2027-02-10'), 'pic')
  assert.equal(ph.prime_week_end_pct, 7.8)
  // Mediane de semaine sur 6 mois : 130 (plus de jours en tres forte saison).
  assert.ok(Math.abs(ph.formes['pic/semaine'] - 1) < 0.001)
  assert.ok(Math.abs(ph.formes['creux/semaine'] - 100 / 130) < 0.001)
  assert.ok(Math.abs(ph.formes['pic/weekend'] - 1.1) < 0.001)
  assert.equal(ph.formes['modere/semaine'], undefined, 'une saison absente : pas de forme')
  assert.equal(P.phase1DuMarche({ saisons: [], pacing: [], ecarts: [], aujourdhui: AUJ }).formes, null)
})

test('jamais hors marche : le prix reste dans la fourchette de sa case', () => {
  const r = P.prixDeDepart({ calendriers: cinq({ position: 'dessus' }), strategie: 'qualite', aujourdhui: AUJ })
  for (const c of r.cases.filter(x => x.statut === 'calcule')) for (const v of Object.values(c.strategies)) assert.ok(v >= c.fourchette.bas && v <= c.fourchette.haut, `${c.niveau}/${c.type}`)
})

test('LE TEST QUI COMPTE : une montee ratee est SIGNALEE, jamais lissee', () => {
  // Les hotes vendent leurs week-ends d'hiver MOINS cher que leurs semaines.
  const inverses = cinq().map(c => ({ ...c, jours: c.jours.map(n => ({ ...n, rate: estWE(n.date) && saison(n.date) > 1.2 ? n.rate * 0.6 : n.rate })) }))
  const r = P.prixDeDepart({ calendriers: inverses, strategie: 'juste', aujourdhui: AUJ })
  assert.ok(r.alertes.some(a => a.type === 'weekend'), 'week-end sous la semaine : dit')
  const c = r.alertes.find(a => a.type === 'weekend')
  assert.equal(caseDe(r, c.niveau, 'weekend').strategies[c.strategie], c.prix, 'le prix affiche est le prix calcule, pas un prix retouche')
})

test('un marche serre (moins de 10 € entre deux strategies) est DIT', () => {
  const serres = [annonce('1', 'A', 100), annonce('2', 'B', 104), annonce('3', 'C', 106), annonce('4', 'D', 108), annonce('5', 'E', 112)]
  const r = P.prixDeDepart({ calendriers: serres, strategie: 'juste', aujourdhui: AUJ })
  assert.ok(r.serre && r.serre.juste_qualite < 10)
  const large = P.prixDeDepart({ calendriers: cinq(), strategie: 'juste', aujourdhui: AUJ })
  assert.equal(large.serre, null)
})

test('un hote a plus du double des autres dans TOUTES les cases est signale, jamais ecarte', () => {
  const r = P.prixDeDepart({ calendriers: [...cinq().slice(0, 4), annonce('5', 'E', 600)], strategie: 'juste', aujourdhui: AUJ })
  assert.deepEqual(r.a_verifier, ['5'])
  assert.equal(r.hotes, 5, 'toujours compte')
})

test('seules les nuits des 6 prochains mois comptent — ni le passe, ni au-dela', () => {
  const loin = cinq().map(c => ({ ...c, jours: [...c.jours, { date: '2025-01-03', rate: 9999 }, { date: '2027-09-03', rate: 9999 }] }))
  const r = P.prixDeDepart({ calendriers: loin, strategie: 'juste', aujourdhui: AUJ })
  const reference = P.prixDeDepart({ calendriers: cinq(), strategie: 'juste', aujourdhui: AUJ })
  assert.deepEqual(r.cases, reference.cases)
})

test('strategie ou date absente : non calculable, jamais un prix', () => {
  assert.equal(P.prixDeDepart({ calendriers: cinq(), strategie: null, aujourdhui: AUJ }).statut, 'non_calculable')
  assert.equal(P.prixDeDepart({ calendriers: cinq(), strategie: 'juste', aujourdhui: null }).statut, 'non_calculable')
})

test('une saison en marches d escalier : un niveau vide est NON CALCULABLE, et dit — jamais rempli au hasard', () => {
  const marches = cinq().map(c => ({ ...c, jours: c.jours.map(n => ({ ...n, rate: Math.round(c.jours[0].rate / (estWE(c.jours[0].date) ? 1.25 : 1) * (['12', '01', '02', '03'].includes(n.date.slice(5, 7)) ? 1.2 : 1) * (estWE(n.date) ? 1.25 : 1) * 100) / 100 })) }))
  const r = P.prixDeDepart({ calendriers: marches, strategie: 'juste', aujourdhui: AUJ })
  const vides = r.cases.filter(c => c.statut === 'non_calculable')
  assert.ok(vides.length > 0)
  assert.ok(vides.every(c => /hôte avec des prix dans cette case/.test(c.motif)))
})

// ─── Constats de la review de b745bb8 ───────────────────────────────────────
test('LE TEST QUI COMPTE (review de b745bb8) : un PLATEAU (hotes a prix fixe, une nuit sur cinq plus chere) — les nuits ordinaires restent ensemble, jamais classees « pic »', () => {
  const plateau = ['A', 'B', 'C', 'D', 'E'].map((h, i) => ({ listing_id: String(i + 1), hote: h,
    jours: JOURS.map((j, k) => ({ date: j, rate: (80 + 30 * i) * (k % 5 === 0 ? 1.3 : 1) })) }))
  const r = P.prixDeDepart({ calendriers: plateau, strategie: 'juste', aujourdhui: AUJ })
  assert.equal(r.niveaux_source, 'segment')
  const pic = caseDe(r, 'pic', 'semaine')
  const ordinaires = r.cases.filter(c => c.statut === 'calcule' && c.niveau !== 'pic')
  assert.ok(ordinaires.length > 0, 'les nuits ordinaires ont leur niveau')
  for (const c of ordinaires) assert.ok(Math.abs(c.forme - 1) < 0.01, `${c.niveau}/${c.type} : prix ordinaire`)
  assert.ok(pic.statut === 'calcule' && Math.abs(pic.forme - 1.3) < 0.01, 'le pic porte les nuits cheres, et elles seules')
})

test('review de b745bb8 : un hote INCONNU ne se compte pas en silence — le calcul refuse et dit pourquoi', () => {
  const r = P.prixDeDepart({ calendriers: [...cinq().slice(0, 4), { ...annonce('5', 'E', 200), hote: null }], strategie: 'juste', aujourdhui: AUJ })
  assert.equal(r.statut, 'non_calculable')
  assert.match(r.motif, /l’hôte de 1 comparable n’est pas identifié/)
})

test('review de b745bb8 : la forme d un hote a deux annonces — chacune rapportee a SON prix, une case incomplete ne biaise rien', () => {
  // Chaque hote : une seconde annonce, trois fois plus chere, SANS aucune nuit de
  // week-end. Avant le correctif, son prix de semaine entrait dans l'ancre de
  // l'hote mais pas dans son prix de week-end : la prime s'effondrait.
  const secondes = cinq().map(c => ({ ...c, listing_id: `${c.listing_id}b`, jours: c.jours.filter(n => !estWE(n.date)).map(n => ({ ...n, rate: n.rate * 3 })) }))
  const r = P.prixDeDepart({ calendriers: [...cinq(), ...secondes], strategie: 'juste', aujourdhui: AUJ })
  for (const n of P.NIVEAUX) {
    const we = caseDe(r, n, 'weekend')
    const se = caseDe(r, n, 'semaine')
    if (we.statut === 'calcule' && se.statut === 'calcule') assert.ok(Math.abs(we.forme / se.forme - 1.25) < 0.03, `${n} : la prime week-end de 25 % reste (${we.forme} / ${se.forme})`)
  }
})

test('review de b745bb8 : le repli dit le MANQUE de donnees, distinct d une absence de saison', () => {
  const rares = cinq().map(c => ({ ...c, jours: c.jours.slice(0, 5) }))
  const r = P.prixDeDepart({ calendriers: rares, strategie: 'juste', aujourdhui: AUJ })
  assert.equal(r.statut, 'non_calculable')
  assert.match(r.motif, /^trop peu de nuits avec un prix chez 5 de vos hôtes pour savoir s’ils changent leurs prix/)
})

// ─── §22.13 : le niveau de CHAQUE jour, sur 12 mois ─────────────────────────
test('LE TEST QUI COMPTE (§22.13) : 12 mois jour par jour — « mesure » sur 6 mois, « estime » au-dela (repli B), rien sans 3 hotes', () => {
  const an = n => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${AUJ}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10))
  const JOURS_AN = an(365)
  const hotes = ['A', 'B', 'C', 'D', 'E'].map((h, i) => ({ listing_id: String(i + 1), hote: h,
    jours: JOURS_AN.map(j => ({ date: j, rate: Math.round((80 + 30 * i) * saison(j) * (estWE(j) ? 1.25 : 1) * 100) / 100 })) }))
  const r = P.prixDeDepart({ calendriers: hotes, strategie: 'juste', aujourdhui: AUJ })
  assert.equal(r.jours.length, 365)
  assert.ok(r.jours.slice(0, 182).every(j => j.source === 'mesure' && j.niveau))
  assert.ok(r.jours.slice(182).every(j => j.source === 'estime' && j.niveau))
  assert.equal(r.jours[0].date, AUJ)
  // Au loin, deux hotes seulement ont un prix : pas de niveau, et c'est dit (null).
  const peu = hotes.map((h, i) => (i < 3 ? { ...h, jours: h.jours.filter(n => n.date < JOURS_AN[200]) } : h))
  const r2 = P.prixDeDepart({ calendriers: peu, strategie: 'juste', aujourdhui: AUJ })
  assert.ok(r2.jours.slice(200).every(j => j.niveau === null && j.source === null))
})

test('LE TEST QUI COMPTE (§22.13, vecu du 6 octobre 2026) : des prix lointains PLATS (prime week-end perdue) ne fabriquent ni pic de semaine ni creux de week-end', () => {
  const an = Array.from({ length: 365 }, (_, i) => new Date(Date.parse(`${AUJ}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10))
  const hotes = ['A', 'B', 'C', 'D', 'E'].map((h, i) => ({ listing_id: String(i + 1), hote: h,
    jours: an.map((j, k) => ({ date: j, rate: (80 + 30 * i) * (k < 182 ? saison(j) * (estWE(j) ? 1.25 : 1) : 1.1) })) }))
  const r = P.prixDeDepart({ calendriers: hotes, strategie: 'juste', aujourdhui: AUJ })
  const loin = r.jours.filter(j => j.source === 'estime')
  const niveaux = new Set(loin.map(j => j.niveau))
  assert.equal(niveaux.size, 1, `un seul niveau au loin, faute de saison visible (vu : ${[...niveaux]})`)
  assert.ok(!niveaux.has('pic') && !niveaux.has('creux'), 'ni faux pic, ni faux creux')
})
