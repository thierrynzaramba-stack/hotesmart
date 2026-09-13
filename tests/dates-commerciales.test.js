// tests/dates-commerciales.test.js
// LE DEFAUT QU'ELLES EMPECHENT : la nuit la plus chere de l'annee comptee
// comme une nuit ordinaire. Le 31 decembre n'est PAS ferie — c'est le
// 1er janvier qui l'est — et aucun calendrier public ne connait la
// Saint-Valentin. Sans ces dates, les deux nuits qui portent le plus de valeur
// se noient dans la moyenne de celles qui en portent le moins.
//
// Spec : docs/specs/spec-yieldflow-v1.md §6 quater

const test = require('node:test')
const assert = require('node:assert')
const D = require('../lib/yield/dates-commerciales')
const { jourDeSemaine } = require('../lib/yield/reference')

// ─── LA REGLE DU WEEK-END ───────────────────────────────────────────────────

test('LE TEST QUI COMPTE : le samedi le plus proche est TOUJOURS un samedi', () => {
  // ⚠ INVARIANT SUR HUIT ANNEES, pas sur un cas choisi. Ma premiere version
  // supposait que `JOURS_SEMAINE` commençait au lundi — il commence au
  // dimanche — et rendait des VENDREDIS. Un test sur une seule annee ne
  // l'aurait pas vu : il faut que les sept jours de semaine soient traverses.
  for (let a = 2024; a <= 2035; a++) {
    const iso = `${a}-02-14`
    const s = D.samediLePlusProche(iso)
    if (s === null) continue
    assert.equal(jourDeSemaine(s), 'samedi', `${iso} (${jourDeSemaine(iso)}) -> ${s}`)
    const ecart = Math.round((Date.parse(s) - Date.parse(iso)) / 86400000)
    assert.ok(Math.abs(ecart) <= 3, `${iso} -> ${s} : ${ecart} jours, c'est un autre week-end`)
  }
})

test('vendredi, samedi et dimanche : la date se suffit', () => {
  // Elle est deja une nuit de week-end ; lui adjoindre un samedi etendrait
  // l'evenement a DEUX week-ends, ce qu'aucun voyageur ne fait.
  for (const [iso, jour] of [['2025-02-14', 'vendredi'], ['2026-02-14', 'samedi'],
    ['2027-02-14', 'dimanche']]) {
    assert.equal(jourDeSemaine(iso), jour)
    assert.equal(D.samediLePlusProche(iso), null, `${iso} est un ${jour}`)
  }
})

test('du lundi au jeudi, le samedi s\'ajoute — et il est unique', () => {
  assert.equal(D.samediLePlusProche('2028-02-14'), '2028-02-12')  // lundi -> -2
  assert.equal(D.samediLePlusProche('2030-02-14'), '2030-02-16')  // jeudi -> +2
  assert.equal(D.samediLePlusProche('2029-02-14'), '2029-02-17')  // mercredi -> +3
  // ⚠ AUCUNE EGALITE POSSIBLE, donc aucune regle d'arbitrage a inventer : un
  // moteur de prix se doit d'etre deterministe.
  for (let a = 2024; a <= 2040; a++) {
    const s = D.samediLePlusProche(`${a}-02-14`)
    assert.equal(D.samediLePlusProche(`${a}-02-14`), s)
  }
})

test('LE TEST QUI COMPTE : la regle du week-end ne vaut PAS pour les reveillons', () => {
  // ⚠ UN 31 DECEMBRE SE FETE LE 31 DECEMBRE. C'est la DATE qui est
  // l'evenement : lui adjoindre un samedi ferait payer le tarif du reveillon a
  // une nuit ordinaire, et diluerait l'echantillon du vrai reveillon.
  const o = D.datesCommerciales('2028-12-01', '2029-01-05')
  const reveillons = o.filter(x => x.segment.includes('reveillon'))
  for (const r of reveillons) {
    assert.ok(['12-24', '12-31'].includes(r.date_debut.slice(5)),
      `${r.nom} le ${r.date_debut} : ce n'est ni le 24 ni le 31`)
  }
  assert.equal(reveillons.length, 2, 'un 24 et un 31, jamais un samedi de plus')
})

// ─── Ce que rend le module ──────────────────────────────────────────────────

test('les trois dates sont rendues sous la MEME forme qu\'un evenement de l\'hote', () => {
  // ⚠ UNE SEULE FORME, DONC UNE SEULE BRANCHE dans `segmenterJour`. Deux
  // formes auraient fait deux regles a tenir d'accord.
  const o = D.datesCommerciales('2026-01-01', '2026-12-31')
  for (const x of o) {
    for (const champ of ['nom', 'segment', 'date_debut', 'date_fin', 'parent_segment']) {
      assert.ok(champ in x, `champ ${champ} absent de ${x.nom}`)
    }
    assert.equal(x.date_debut, x.date_fin, 'une date commerciale dure une nuit')
    assert.match(x.segment, /^commercial:/)
  }
  const cles = [...new Set(o.map(x => x.cle))].sort()
  assert.deepEqual(cles, ['reveillon_noel', 'reveillon_nouvel_an', 'saint_valentin'])
})

test('LE TEST QUI COMPTE : desactiver une date la fait DISPARAITRE du moteur', () => {
  // Un meuble d'affaires en centre-ville ne vit pas sa Saint-Valentin. Si la
  // desactivation ne portait pas jusqu'au moteur, l'hote la couperait a
  // l'ecran et continuerait a la voir tarifer ses nuits.
  const avec = D.datesCommerciales('2026-01-01', '2026-12-31')
  const sans = D.datesCommerciales('2026-01-01', '2026-12-31',
    { desactivees: ['saint_valentin'] })
  assert.ok(avec.some(x => x.cle === 'saint_valentin'))
  assert.ok(!sans.some(x => x.cle === 'saint_valentin'))
  // La cle de segment complete doit marcher aussi : l'ecran manipule l'une ou
  // l'autre selon les endroits, et se tromper reviendrait a ne rien couper.
  const parSegment = D.datesCommerciales('2026-01-01', '2026-12-31',
    { desactivees: new Set(['commercial:saint_valentin']) })
  assert.ok(!parSegment.some(x => x.cle === 'saint_valentin'))
})

test('une fenetre invalide ou demesuree ne rend rien plutot que de tourner', () => {
  assert.deepEqual(D.datesCommerciales('2026-12-31', '2026-01-01'), [])
  assert.deepEqual(D.datesCommerciales('2026-13-01', '2027-01-01'), [])
  assert.deepEqual(D.datesCommerciales('1800-01-01', '2200-01-01'), [])
})

test('le module est PUR : ni base, ni reseau, ni horloge', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib/yield/dates-commerciales.js'), 'utf8')
  assert.ok(!/new Date\(\)|Date\.now\(\)/.test(src),
    'une date commerciale qui lit l\'horloge devient fausse le jour ou elle passe')
  assert.ok(!/supabase|fetch\(/.test(src))
})
