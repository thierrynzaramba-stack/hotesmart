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
// ⚠ 4 des 8 rouges contre le code d'avant sont des rouges par `undefined`
// (fonctions absentes), qui ne prouvent rien seuls : ils ont ete passes en
// review contre des mutations du code neuf (pas de retrait par la pression,
// amincie jamais vraie, max au lieu de min, segment ignore, hors reference
// ignore, plafond arrondi vers le haut, pression non fiable qui retire) —
// chacune fait rougir un test.

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

test('LE TEST QUI COMPTE : aucune prime au-dessus du plafond', () => {
  const s = nuit({ preuveN1: preuve(400) })
  assert.equal(s.prix, 295)
  assert.equal(s.prime_exceptionnel.plafonne, true)
  assert.match(s.prime_exceptionnel.resume, /^Plafonné à 295 €.*Vous pouvez poser un prix plus haut à la main/)
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

test('une prime sur une seule vente est une « référence amincie » — dite sur la ligne seulement si elle distingue', () => {
  // Bien a plusieurs unites : une vente sur deux possibles, ca se dit.
  const multi = nuit({ preuveN1: preuve(195), bien: { prix_minimum: 1, inventory_units: 2 } })
  assert.equal(multi.prime_exceptionnel.reference_amincie, true)
  assert.equal(multi.prime_exceptionnel.amincie_systematique, false)
  assert.match(multi.prime_exceptionnel.resume, /référence amincie : une seule vente/)
  assert.equal(nuit({ preuveN1: preuve(195, { ventes: 2 }), bien: { prix_minimum: 1, inventory_units: 2 } })
    .prime_exceptionnel.reference_amincie, false)
  // ⚠ Bien a une unite : TOUJOURS une seule vente — un drapeau systematique ne
  // dit rien sur la ligne, il passe en legende (review V2.0.7).
  const une = nuit({ preuveN1: preuve(195) })
  assert.equal(une.prime_exceptionnel.reference_amincie, true)
  assert.equal(une.prime_exceptionnel.amincie_systematique, true)
  assert.doesNotMatch(une.prime_exceptionnel.resume, /amincie/)
})

test('LE TEST QUI COMPTE : « je ne sais pas » n est pas « non vendue »', () => {
  const avenir = nuit({ preuveN1: { date: '2026-11-14', prix: null, pas_encore_passee: true, meme_segment: true } })
  assert.equal(avenir.prix, 165)
  assert.equal(avenir.prime_exceptionnel.motif_sans_prime, S.MOTIFS_SANS_PRIME.PAS_ENCORE_PASSEE)
  assert.doesNotMatch(avenir.prime_exceptionnel.resume, /n’a pas été vendue/)
  const inconnu = nuit({ preuveN1: { date: '2025-11-15', prix: null, prix_inconnu: true, meme_segment: true } })
  assert.equal(inconnu.prime_exceptionnel.motif_sans_prime, S.MOTIFS_SANS_PRIME.PRIX_INCONNU)
  assert.match(inconnu.prime_exceptionnel.resume, /a été vendue, mais son prix n’est pas exploitable/)
})

test('preuveN1 : une nuit comparable a venir ne prouve rien, meme reservee', () => {
  const { preuveN1 } = require('../lib/yield/contexte-du-bien')
  const { nuitComparable } = require('../lib/yield/comparable')
  const loin = '2027-11-20'   // samedi, a plus d'un an
  const cible = nuitComparable(loin, { contexte: CTX }).date
  assert.ok(cible > '2026-09-22', `comparable ${cible} a venir`)
  const p = preuveN1({ contexte: CTX, auj: '2026-09-23', finRef: '2026-09-22',
    ventesParDate: new Map([[cible, [{ prix: 250, hors_reference: false }]]]) }, loin)
  assert.equal(p.pas_encore_passee, true)
  assert.equal(p.prix, null, 'un prix pose par YieldFlow sur une reservation a venir n est pas un prix obtenu')
})

test('ventesParDateDe : annulee exclue, long sejour et prix nul marques, jamais perdus', () => {
  const { ventesParDateDe } = require('../lib/yield/contexte-du-bien')
  const v = ventesParDateDe([
    { compte: false, nuits: [{ date: '2025-11-15', prix: 400 }] },                    // annulee
    { compte: true, long_sejour: true, nuits: [{ date: '2025-11-15', prix: 90 }] },   // degressif
    { compte: true, nuits: [{ date: '2025-11-15', prix: 190 }] },
    { compte: true, nuits: [{ date: '2025-11-16', prix: null }, { date: '2025-11-17', prix: 0 }] }
  ])
  assert.deepEqual(v.get('2025-11-15'), [{ prix: 90, hors_reference: true }, { prix: 190, hors_reference: false }])
  assert.deepEqual(v.get('2025-11-16'), [{ prix: null, hors_reference: false }], 'vendue sans prix : gardee')
  assert.deepEqual(v.get('2025-11-17'), [{ prix: null, hors_reference: false }])
  const { preuveN1 } = require('../lib/yield/contexte-du-bien')
  const { nuitComparable } = require('../lib/yield/comparable')
  const cible = nuitComparable(SAMEDI, { contexte: CTX }).date
  const seule = preuveN1({ contexte: CTX, finRef: '2026-09-22', ventesParDate: new Map([[cible, [{ prix: null, hors_reference: false }]]]) }, SAMEDI)
  assert.equal(seule.prix_inconnu, true)
})

test('LE TEST QUI COMPTE : pression −1 et delai +1 laissent Exceptionnel — la prime est retiree PAR suggerer', () => {
  const s = nuit({ delaiJours: 90, preuveN1: preuve(195), pression: { ecart: -0.26, fiable: true } })
  assert.equal(s.niveau, 'Exceptionnel', 'depart Exceptionnel, −1 +1')
  assert.equal(s.prix, 165)
  assert.equal(s.prime_exceptionnel.motif_sans_prime, S.MOTIFS_SANS_PRIME.PRIME_RETIREE)
  assert.match(s.couches.find(c => c.nom === 'fourchette').resume, /^Prime retirée — ce mois se vend 26 % moins bien/)
  // ⚠ ET LA PRIME SE JUGE SUR LE NIVEAU FINAL, PAS SUR LE DEPART (mutation
  // non detectee en review) : parti d'Exceptionnel, descendu a Tres haut par
  // la pression, la nuit n'a pas de fourchette du tout.
  const descendue = nuit({ delaiJours: 30, preuveN1: preuve(195), pression: { ecart: -0.26, fiable: true } })
  assert.equal(descendue.niveau, 'Très haut')
  assert.equal(descendue.prix, 155)
  assert.equal(descendue.fourchette_exceptionnel, undefined)
})

test('hors du niveau Exceptionnel : aucune fourchette ; la preuve d un SAMEDI ne releve pas un mardi', () => {
  // ⚠ CE TEST A CHANGE LE 23 SEPTEMBRE 2026 (regle 17) : il exigeait que la
  // preuve ne soit jamais calculee hors d'Exceptionnel. Le point B (plancher
  // N-1 a tous les niveaux) la lit desormais partout — une fois par nuit.
  let appels = 0
  const s = S.suggerer({ date: MARDI, grille: grille(), contexte: CTX, ouverte: true, delaiJours: 30,
    bien: { prix_minimum: 1 }, preuveN1: () => { appels++; return preuve(250) } })   // preuve : un samedi
  assert.equal(s.niveau, 'Base')
  assert.equal(s.fourchette_exceptionnel, undefined)
  assert.equal(appels, 1)
  assert.equal(s.prix, 115, 'samedi (Exceptionnel chez ce bien) et mardi (Base) : autre type de nuit')
  assert.equal(s.releve_n1, undefined, 'rien ne bouge : B reste muet')
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

test('LE TEST QUI COMPTE : le plafond est le prix atteint par au moins DEUX reservations', () => {
  // ⚠ CE TEST A CHANGE DE VERDICT LE 23 SEPTEMBRE 2026, ET C'EST VOULU (regle 17) :
  // il exigeait « le prix le plus eleve obtenu ». Arbitrage de Thierry (option b) :
  // une seule reservation ne fixe pas ce que la machine pose seule.
  const prix = [...Array(40).fill(100), ...Array(40).fill(150), 257, 295]
  const g = S.grilleDeBase(prix, { reservations: 30, prixParReservation: [100, 150, 257, 295] })
  assert.equal(g.plafond_brut, 257, 'la 2e reservation la plus chere')
  assert.equal(g.plafond, 255, 'arrondi VERS LE BAS : jamais au-dessus de ce que deux reservations ont paye')
  // La vente aberrante isolee est neutralisee — parce qu'elle est seule.
  const aberrant = S.grilleDeBase([...Array(40).fill(100), ...Array(40).fill(150), 190, 900],
    { reservations: 30, prixParReservation: [100, 150, 190, 900] })
  assert.ok(aberrant.niveaux[4].prix < 190, 'jeu d essai : il y a de la place au-dessus du niveau')
  assert.equal(aberrant.plafond, 190)
  // Moins de deux reservations, ou pas de place au-dessus du niveau : pas de fourchette.
  assert.equal(S.grilleDeBase(Array(40).fill(100), { reservations: 30, prixParReservation: [300] }).plafond, null)
  assert.equal(S.grilleDeBase(Array(40).fill(100), { reservations: 30, prixParReservation: [100, 100] }).plafond, null)
  assert.equal(nuit({ g: { plafond: null }, preuveN1: preuve(195) }).prix, 165)
})

test('LE TEST QUI COMPTE : le plafond est une DONNEE VIVANTE — construireGrille le recalcule depuis les reservations', () => {
  const ecl = (d, prix, id, extra = {}) => ({ compte: true, booking_id: id, ...extra, nuits: [{ date: d, prix, hors_reference: false }] })
  const base = []
  for (let i = 0; i < 40; i++) base.push(ecl(`2025-0${1 + (i % 9)}-${String(10 + (i % 18)).padStart(2, '0')}`, 100 + (i % 4) * 20, `B${i}`))
  const g1 = S.construireGrille([...base, ecl('2025-02-14', 295, 'V')], { contexte: CTX, debut: '2025-01-01', fin: '2025-12-31' })
  const g2 = S.construireGrille([...base, ecl('2025-02-14', 295, 'V'), ecl('2025-12-31', 280, 'R')], { contexte: CTX, debut: '2025-01-01', fin: '2025-12-31' })
  assert.ok(g2.base.plafond > g1.base.plafond, `une 2e reservation plus chere fait monter le plafond (${g1.base.plafond} → ${g2.base.plafond})`)
  assert.equal(g2.base.plafond, 280)
  // ⚠ MEME ENSEMBLE FILTRE QUE LA PREUVE : un long sejour ou une nuit hors
  // reference ne fixe pas le plafond (et `ventesParDateDe` les marque).
  const g3 = S.construireGrille([...base, ecl('2025-02-14', 295, 'V'),
    ecl('2025-03-01', 400, 'L', { long_sejour: true }),
    { compte: true, booking_id: 'H', nuits: [{ date: '2025-04-01', prix: 400, hors_reference: true }] },
    { compte: false, booking_id: 'A', nuits: [{ date: '2025-05-01', prix: 400, hors_reference: false }] }],
  { contexte: CTX, debut: '2025-01-01', fin: '2025-12-31' })
  assert.equal(g3.base.plafond, g1.base.plafond, 'long sejour, hors reference et annulee ne fixent pas le plafond')
  const { ventesParDateDe } = require('../lib/yield/contexte-du-bien')
  const v = ventesParDateDe([ecl('2025-03-01', 400, 'L', { long_sejour: true }),
    { compte: false, booking_id: 'A', nuits: [{ date: '2025-05-01', prix: 400 }] }])
  assert.equal(v.get('2025-03-01')[0].hors_reference, true, 'et ne prouvent rien')
  assert.equal(v.get('2025-05-01'), undefined)
})

test('LE TEST QUI COMPTE : une nuit plafonnee le DIT, et dit la sortie', () => {
  const f = S.primeExceptionnel({ niveau: { prix: 165 }, plafond: 255, plafondBrut: 257,
    preuve: { date: '2026-02-14', prix: 295, ventes: 1, meme_segment: true } })
  assert.equal(f.prix, 255)
  assert.equal(f.plafonne, true)
  assert.equal(f.resume, 'Plafonné à 255 € — le 14/02/2026 s’est vendu 295 €, mais une seule réservation a atteint ce prix. Vous pouvez poser un prix plus haut à la main (✎).')
  // Coupee par l'arrondi seulement : pas « une seule fois » (ce serait faux).
  const r = S.primeExceptionnel({ niveau: { prix: 165 }, plafond: 255, plafondBrut: 257,
    preuve: { date: '2025-12-31', prix: 257, ventes: 1, meme_segment: true } })
  assert.equal(r.prix, 255)
  assert.doesNotMatch(r.resume, /une seule réservation/)
  assert.match(r.resume, /^Plafonné à 255 € — le prix rond sous les 257 € atteints par deux réservations/)
  // Sous le plafond : pas de mention.
  assert.equal(S.primeExceptionnel({ niveau: { prix: 165 }, plafond: 255, plafondBrut: 257,
    preuve: { date: '2026-02-28', prix: 195, ventes: 1, meme_segment: true } }).plafonne, false)
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
