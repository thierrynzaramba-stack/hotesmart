// tests/fourchette-exceptionnel.test.js — lot V2.0.7 (23 septembre 2026).
//
// LE DEFAUT QU'ILS EMPECHENT : un moteur plafonne a 165 € alors que la nuit a
// PROUVE mieux. Sur La bulle, le niveau Exceptionnel (P92) valait 165 € quand
// 54 nuits s'etaient vendues plus cher, jusqu'a 295 € ; une nuit dont la
// comparable de l'an dernier s'etait vendue 195 € ne pouvait pas y revenir.
//
// CE QU'ILS DEFENDENT (arbitrages de Thierry, 23 septembre 2026) :
//   1. Exceptionnel est une FOURCHETTE : bas = prix du niveau, haut = le prix
//      le plus eleve deja obtenu (borne de securite, arrondie vers le bas) ;
//   2. dans la fourchette, le prix ne vient QUE de la preuve (la nuit
//      comparable N-1, meme segment, hors reference exclue), arrondie au pas
//      superieur — sans preuve, pas de prime ;
//   3. meme seuil que le plancher N-1 : sous deux pas (10 €), on ne bouge pas ;
//   4. la pression DECIDE (retire la prime a −25 %), elle n'ajoute aucun euro,
//      et le retrait se DIT ;
//   5. une prime sur une seule vente est marquee « référence amincie ».
//
// CONTRE-EPREUVE (REVIEW.md regle 19) : 8 tests sur 11 rougissent contre le
// code d'avant (aucune fourchette). Les 3 autres (« autre segment… ne prouve
// rien », « hors du niveau Exceptionnel », « l'invariant ») y passaient par
// accident — l'ancien code ne primait jamais ; ils rougissent contre une
// version NAIVE (prime sur toute preuve, sans seuil, sans conditions, sans
// plafond, preuve calculee pour toutes les nuits) : c'est ce qu'ils gardent.

const test = require('node:test')
const assert = require('node:assert')
const S = require('../lib/yield/suggestion')
const R = require('../lib/yield/reference')

const NIVEAUX = [115, 125, 140, 155, 165]
function grille ({ plafond = 295 } = {}) {
  const niveaux = S.NIVEAUX.map((n, i) => ({ ...n, prix: NIVEAUX[i], prix_mesure: NIVEAUX[i], etire: false }))
  const pos = (indice) => ({ fiable: true, indice, niveau: niveaux[indice].nom, crans: 0, echantillon: 40, reservations: 20, mediane: NIVEAUX[indice] })
  return {
    base: { fiable: true, echantillon: 854, reservations: 400, niveaux, min: 35, max: 295, plafond },
    positions: new Map([['hors_vacances', { ...pos(0), crans: 0 }]]),
    positions_jour: new Map([['hors_vacances|samedi', pos(4)], ['hors_vacances|mardi', pos(0)]])
  }
}
const CTX = R.construireContexte({ zoneBien: 'C', vacances: [], debut: '2025-01-01', fin: '2027-12-31' })
const SAMEDI = '2026-11-21'   // samedi hors vacances : Exceptionnel par la mesure du couple
const MARDI = '2026-11-17'
assert.equal(R.segmenterJour(SAMEDI, CTX).segment, 'hors_vacances')
assert.equal(R.segmenterJour(SAMEDI, CTX).jour_semaine, 'samedi')
const preuve = (prix, extra = {}) => ({ date: '2025-11-22', prix, ventes: 1, meme_segment: true, hors_reference: false, ...extra })
const nuit = (opts = {}) => S.suggerer({ date: SAMEDI, grille: grille(opts.g), contexte: CTX, ouverte: true,
  delaiJours: 30, bien: { prix_minimum: 1 }, ...opts })

test('LE TEST QUI COMPTE : une nuit Exceptionnel reprend le prix PROUVE l an dernier', () => {
  const s = nuit({ preuveN1: preuve(195) })
  assert.equal(s.niveau, 'Exceptionnel')
  assert.equal(s.prix, 195, 'le prix obtenu sur la nuit comparable, pas le bas du niveau')
  assert.deepEqual(s.fourchette_exceptionnel, { bas: 165, plafond: 295 })
  assert.equal(s.prime_exceptionnel.preuve_date, '2025-11-22')
  const c = s.couches.find(x => x.nom === 'fourchette')
  assert.ok(c && c.agit)
  assert.match(c.resume, /^Exceptionnel · 195 € — prix obtenu le 22\/11\/2025 sur la nuit comparable/)
})

test('LE TEST QUI COMPTE : sans preuve, pas de prime — jamais le plafond par defaut', () => {
  const s = nuit({ preuveN1: null })
  assert.equal(s.prix, 165)
  assert.equal(s.prime_exceptionnel.motif_sans_prime, S.MOTIFS_SANS_PRIME.PAS_DE_COMPARABLE)
  // ⚠ ET LA NUIT DIT POURQUOI elle n'a pas de prime (arbitrage 5).
  assert.match(s.couches.find(x => x.nom === 'fourchette').resume, /sans prime — pas de nuit comparable/)
})

test('arrondi au pas SUPERIEUR, et seuil de deux pas (le meme que le plancher N-1)', () => {
  assert.equal(nuit({ preuveN1: preuve(168) }).prix, 165, '3 € d ecart : on ne bouge pas')
  assert.equal(nuit({ preuveN1: preuve(174.99) }).prix, 165, 'sous 10 € : on ne bouge pas')
  assert.equal(nuit({ preuveN1: preuve(175) }).prix, 175, '10 € : on reprend')
  assert.equal(nuit({ preuveN1: preuve(177.33) }).prix, 180, 'arrondi au pas superieur, jamais sous la preuve')
  const bas = nuit({ preuveN1: preuve(160) })
  assert.equal(bas.prix, 165)
  assert.equal(bas.prime_exceptionnel.motif_sans_prime, S.MOTIFS_SANS_PRIME.PAS_PLUS_CHER)
  assert.doesNotMatch(bas.couches.find(x => x.nom === 'fourchette').resume, /d’écart/,
    'une nuit vendue moins cher n est pas « un petit ecart » (vu sur apercu reel)')
})

test('LE TEST QUI COMPTE : le plafond borne le cliquet', () => {
  const s = nuit({ preuveN1: preuve(400) })
  assert.equal(s.prix, 295)
  assert.equal(s.prime_exceptionnel.plafonne, true)
})

test('une preuve d un autre segment, hors reference ou non vendue ne prouve rien', () => {
  assert.equal(nuit({ preuveN1: preuve(250, { meme_segment: false }) }).prix, 165)
  assert.equal(nuit({ preuveN1: preuve(250, { hors_reference: true }) }).prix, 165)
  assert.equal(nuit({ preuveN1: preuve(null) }).prix, 165)
})

test('LE TEST QUI COMPTE : la pression DECIDE, n ajoute rien, et le retrait se dit', () => {
  const retire = nuit({ preuveN1: preuve(195), pression: { ecart: -0.26, fiable: true } })
  // −26 % : la pression descend aussi la nuit d'un niveau (couche existante) —
  // on regarde donc la regle de prime directement, sur le niveau Exceptionnel.
  const f = S.primeExceptionnel({ niveau: { prix: 165 }, plafond: 295, preuve: preuve(195), pression: { ecart: -0.26, fiable: true } })
  assert.equal(f.prix, null)
  assert.equal(f.motif_sans_prime, S.MOTIFS_SANS_PRIME.PRIME_RETIREE)
  assert.match(f.resume, /^Prime retirée — ce mois se vend 26 % moins bien que l’an dernier : 165 € au lieu de 195 €/)
  assert.equal(f.prix_sans_pression, 195)
  assert.ok(retire.prix <= 165, 'jamais une prime quand le mois s effondre')
  // −24 % : toute la prime (la falaise est assumee, et dite).
  assert.equal(S.primeExceptionnel({ niveau: { prix: 165 }, plafond: 295, preuve: preuve(195), pression: { ecart: -0.24, fiable: true } }).prix, 195)
  // Un portefeuille N-1 non fiable ne decide rien (meme regle que la couche pression).
  assert.equal(S.primeExceptionnel({ niveau: { prix: 165 }, plafond: 295, preuve: preuve(195), pression: { ecart: -0.5, fiable: false } }).prix, 195)
  // Une pression FORTE n'ajoute aucun euro au-dela de la preuve.
  assert.equal(S.primeExceptionnel({ niveau: { prix: 165 }, plafond: 295, preuve: preuve(195), pression: { ecart: 0.8, fiable: true } }).prix, 195)
})

test('une prime sur une seule vente est une « référence amincie »', () => {
  const une = nuit({ preuveN1: preuve(195) })
  assert.equal(une.prime_exceptionnel.reference_amincie, true)
  assert.match(une.prime_exceptionnel.resume, /référence amincie : une seule vente/)
  assert.equal(nuit({ preuveN1: preuve(195, { ventes: 2 }) }).prime_exceptionnel.reference_amincie, false)
})

test('hors du niveau Exceptionnel : aucune fourchette, et la preuve n est meme pas calculee', () => {
  let appels = 0
  const s = S.suggerer({ date: MARDI, grille: grille(), contexte: CTX, ouverte: true, delaiJours: 30,
    bien: { prix_minimum: 1 }, preuveN1: () => { appels++; return preuve(250) } })
  assert.notEqual(s.niveau, 'Exceptionnel')
  assert.equal(s.fourchette_exceptionnel, undefined)
  assert.equal(appels, 0)
})

test('LE TEST QUI COMPTE : l invariant — chaque prix est le niveau, ou une preuve arrondie, jamais au-dela du plafond', () => {
  for (let p = 100; p <= 420; p += 0.5) {
    const s = nuit({ preuveN1: preuve(p) })
    assert.ok(s.prix >= 165 && s.prix <= 295, `${p} → ${s.prix}`)
    if (s.prix !== 165) {
      assert.equal(s.prix, Math.min(295, Math.ceil(p / 5) * 5), `${p} → ${s.prix}`)
      assert.ok(p - 165 >= 10)
    }
  }
})

test('le plafond de la grille : le prix le plus eleve obtenu, arrondi VERS LE BAS ; null sans place', () => {
  const g = S.grilleDeBase([...Array(40).fill(100), ...Array(40).fill(150), 297], { reservations: 30 })
  assert.equal(g.plafond, 295, 'jamais un euro au-dessus du vendu')
  const plat = S.grilleDeBase(Array(40).fill(100), { reservations: 30 })
  assert.equal(plat.plafond, null, 'pas de place au-dessus du dernier niveau : pas de fourchette')
  assert.equal(nuit({ g: { plafond: null }, preuveN1: preuve(195) }).prix, 165)
})

test('preuveN1 du contexte : la vente la plus basse du jour, hors reference ecartee', () => {
  const { preuveN1 } = require('../lib/yield/contexte-du-bien')
  // ⚠ LA NUIT COMPARABLE SE DEMANDE A LA CASCADE, elle ne se suppose pas
  // (REVIEW.md regle 19, point 4) : la premiere version de ce test ecrivait
  // le 22 novembre 2025, la cascade retient le 15 (les samedis 7 et 14
  // novembre 2026 sont des week-ends prolonges par le 11 novembre).
  const { nuitComparable } = require('../lib/yield/comparable')
  const cible = nuitComparable(SAMEDI, { contexte: CTX }).date
  assert.equal(cible, '2025-11-15')
  const ctx = { contexte: CTX, ventesParDate: new Map([
    [cible, [{ prix: 210, hors_reference: false }, { prix: 190, hors_reference: false }, { prix: 90, hors_reference: true }]]
  ]) }
  const p = preuveN1(ctx, SAMEDI)
  assert.equal(p.date, cible, 'la cascade N-1 de l ecran')
  assert.equal(p.prix, 190)
  assert.equal(p.ventes, 2)
  assert.equal(p.meme_segment, true)
  const seule = preuveN1({ contexte: CTX, ventesParDate: new Map([[cible, [{ prix: 90, hors_reference: true }]]]) }, SAMEDI)
  assert.equal(seule.hors_reference, true)
})
