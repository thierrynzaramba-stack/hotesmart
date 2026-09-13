// tests/suggestion-yield.test.js
// LE DEFAUT QU'ILS EMPECHENT : un prix suggere qu'on ne sait pas expliquer.
// Un hote n'applique pas un chiffre qui tombe du ciel — et s'il l'applique, il
// ne peut pas le defendre. Chaque euro doit se justifier par une couche nommee
// et chiffree, et deux appels identiques doivent rendre le meme prix.
//
// Spec : docs/specs/spec-yieldflow-v1.md §7.3 (etape 4, lot 4.4)

const test = require('node:test')
const assert = require('node:assert')
const S = require('../lib/yield/suggestion')
const R = require('../lib/yield/reference')

const VACANCES = [
  { zone: 'C', nom: "Vacances d'Hiver", date_debut: '2025-02-15', date_fin: '2025-03-02' },
  { zone: 'A', nom: "Vacances d'Hiver", date_debut: '2025-02-08', date_fin: '2025-02-23' },
  { zone: 'C', nom: "Vacances d'Été", date_debut: '2025-07-05', date_fin: '2025-08-31' },
  // L'ete 2026 : sans lui, une date de juillet 2026 serait « hors vacances »
  // dans le jeu d'essai, et les tests qui portent sur les vacances de la zone
  // ne testeraient rien.
  { zone: 'C', nom: "Vacances d'Été", date_debut: '2026-07-04', date_fin: '2026-08-31' }
]
const CTX = R.construireContexte({
  zoneBien: 'C', vacances: VACANCES, debut: '2023-01-01', fin: '2027-12-31'
})

function ecl (nuits, { prix = 100, id = null, long = false, exclues = [] } = {}) {
  return {
    compte: true, booking_id: id, long_sejour: long,
    date_vente: '2024-12-01', date_vente_fiable: true,
    nuits: nuits.map(d => ({ date: d, prix, hors_reference: exclues.includes(d) }))
  }
}
// ⚠ DES DATES REELLEMENT HORS VACANCES, VERIFIEES.
// Premiere version : des mardis depuis janvier, qui traversaient les vacances
// d'hiver de fevrier — l'echantillon se repartissait alors sur TROIS segments
// et aucun n'atteignait le seuil. Le meme piege qu'au lot 3.4, ou le 4 mars
// tombait dans les vacances de la zone B. Septembre-novembre est libre dans le
// jeu d'essai.
function mardis (n, prix) {
  const out = []
  const d = new Date(Date.UTC(2025, 8, 2))   // mardi 2 septembre 2025
  for (let i = 0; i < n; i++) {
    out.push(ecl([d.toISOString().slice(0, 10)], { prix, id: `M${i}` }))
    d.setUTCDate(d.getUTCDate() + 7)
  }
  return out
}
function samedis (n, prix) {
  const out = []
  const d = new Date(Date.UTC(2025, 8, 6))   // samedi 6 septembre 2025
  for (let i = 0; i < n; i++) {
    out.push(ecl([d.toISOString().slice(0, 10)], { prix, id: `S${i}` }))
    d.setUTCDate(d.getUTCDate() + 7)
  }
  return out
}
const grilleDe = (lignes) => S.construireGrille(lignes,
  { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })

// ⚠ CE FICHIER A ETE REECRIT LE 13 SEPTEMBRE 2026, ET LE DIRE IMPORTE.
// Sa version precedente verrouillait un design abandonne : une grille de cinq
// niveaux PAR SEGMENT, plus un multiplicateur jour-de-semaine sur le prix.
// Arbitrage de Thierry : UNE grille par bien, a prix ronds, et chaque contexte
// s'y POSITIONNE. Quinze tests sont tombes — c'est le signal attendu quand un
// design change, pas un accident.
//
// ⚠ CE QUE LE NOUVEAU DESIGN PERD, ET QU'IL FAUT DIRE. Un niveau n'est plus
// exactement un prix deja obtenu : il est arrondi au multiple de 5 €, et peut
// etre ETIRE pour tenir l'ecart minimal. Ce qui reste vrai — et que ces tests
// verrouillent — c'est qu'aucun niveau ne sort de l'etendue reellement vendue.

// ─── LA GRILLE DU BIEN ───────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : aucun niveau ne sort de ce qui a ete vendu', () => {
  // ⚠ L'INVARIANT QUI A SURVECU AU CHANGEMENT DE DESIGN. Les niveaux ne sont
  // plus des prix exacts, mais ils restent bornes par le moins cher et le plus
  // cher reellement obtenus : le moteur ne propose jamais un tarif que ce
  // logement n'a jamais pratique.
  const prix = [100, 105, 110, 115, 120, 125, 130, 135, 140]
  const lignes = prix.map((p, i) =>
    ecl([`2025-09-${String(1 + i).padStart(2, '0')}`], { prix: p, id: `R${i}` }))
  const g = grilleDe(lignes)
  assert.equal(g.base.fiable, true)
  assert.equal(g.base.niveaux.length, 5)
  for (const n of g.base.niveaux) {
    assert.ok(n.prix >= g.base.min && n.prix <= g.base.max,
      `${n.nom} ${n.prix} € hors de l'etendue ${g.base.min}-${g.base.max}`)
  }
})

test('LE TEST QUI COMPTE : la grille est MONOTONE, toujours', () => {
  // ⚠ RELEVE EN REVIEW, 13 septembre 2026, ET C'ETAIT LE PIRE DEFAUT DU LOT.
  // Un niveau qu'on ne pouvait pas etirer restait a sa valeur MESUREE, donc
  // sous le precedent deja etire :
  //     Base 95 | Moyen 100 | Haut 95 | Tres haut 100 | Exceptionnel 95
  // « Monter d'un niveau » baissait le prix. Deux signaux cumules rendaient le
  // prix de depart en annonçant « +2 niveaux ». Aucun test ne le voyait : celui
  // sur l'etendue passait, parce que 95 et 100 sont tous deux dans l'etendue.
  //
  // ⚠ ON EPROUVE L'INVARIANT SUR DES FORMES D'HISTORIQUE VARIEES, pas sur un
  // cas choisi : c'est precisement un cas choisi qui avait laissé passer.
  const formes = {
    'un tarif domine': [...Array(200).fill(95), ...Array(12).fill(98), 100],
    'deux tarifs': [...Array(30).fill(100), ...Array(30).fill(101)],
    'tout identique': Array(40).fill(120),
    'etendue etroite': [101, 101, 102, 102, 102, 103, 103, 103, 103, 103],
    'large': [35, 60, 90, 110, 130, 150, 180, 220, 260, 295],
    'deux paliers': [...Array(20).fill(80), ...Array(20).fill(240)]
  }
  for (const [nom, prix] of Object.entries(formes)) {
    const g = S.grilleDeBase(prix, { reservations: 20 })
    if (!g.fiable) continue
    for (let i = 1; i < g.niveaux.length; i++) {
      assert.ok(g.niveaux[i].prix >= g.niveaux[i - 1].prix,
        `${nom} : ${g.niveaux[i - 1].nom} ${g.niveaux[i - 1].prix} € puis `
        + `${g.niveaux[i].nom} ${g.niveaux[i].prix} € — la grille descend`)
    }
    // ⚠ ET AUCUN NIVEAU NE SORT DE CE QUI A ETE VENDU, sur ces memes formes.
    // L'arrondi au multiple de 5 depassait les bornes : sur un maximum vendu a
    // 103 €, « Exceptionnel » sortait a 105 €.
    for (const n of g.niveaux) {
      assert.ok(n.prix >= g.min && n.prix <= g.max,
        `${nom} : ${n.nom} ${n.prix} € hors de ${g.min}-${g.max}`)
    }
  }
})

test('LE TEST QUI COMPTE : les prix de la grille sont RONDS', () => {
  // ⚠ UN TARIF PUBLIC A DEUX DECIMALES N'EXISTE PAS. « 140,82 € » trahissait un
  // multiplicateur, et l'hote ne l'aurait defendu devant personne.
  const lignes = [100, 103, 107, 111, 118, 126, 133, 141, 149, 158].map((p, i) =>
    ecl([`2025-09-${String(1 + i).padStart(2, '0')}`], { prix: p, id: `R${i}` }))
  const g = grilleDe(lignes)
  for (const n of g.base.niveaux) {
    assert.equal(n.prix % S.PAS_ARRONDI, 0, `${n.nom} : ${n.prix} n'est pas rond`)
  }
  // ⚠ L'ORDRE DE PRIORITE EST DIT : « jamais invente » passe avant « rond ».
  // Sur un bien qui aurait tout vendu entre deux multiples de 5, aucun prix
  // rond ne tient dans l'etendue — on rend alors la valeur mesuree, bornee,
  // plutot qu'un prix jamais obtenu.
  const etroit = S.grilleDeBase([101, 101, 102, 102, 103, 103, 103, 103], { reservations: 8 })
  if (etroit.fiable) {
    for (const n of etroit.niveaux) {
      assert.ok(n.prix >= etroit.min && n.prix <= etroit.max,
        `${n.nom} ${n.prix} € hors de ${etroit.min}-${etroit.max}`)
    }
  }
})

test('LE TEST QUI COMPTE : l ecart minimal de 5 % est TENU, et l etirement DIT', () => {
  // Un tarif qui domine l'historique ecrase les quantiles : sans etirement,
  // la grille afficherait cinq crans la ou il n'y a qu'une decision possible.
  const prix = [80, 117, 117, 117, 117, 117, 117, 118, 119, 200]
  const lignes = prix.map((p, i) =>
    ecl([`2025-09-${String(1 + i).padStart(2, '0')}`], { prix: p, id: `R${i}` }))
  const g = grilleDe(lignes)
  const n = g.base.niveaux
  for (let i = 1; i < n.length; i++) {
    // Soit l'ecart est tenu, soit le niveau est DECLARE confondu : jamais
    // deux crans qui se ressemblent sans que rien ne le dise.
    const tenu = n[i].prix >= n[i - 1].prix * (1 + S.ECART_MINIMAL)
    assert.ok(tenu || n[i].confondu_avec,
      `${n[i - 1].nom} ${n[i - 1].prix} / ${n[i].nom} ${n[i].prix} : ni ecarte ni dit`)
  }
  assert.ok(n.some(x => x.etire), 'au moins un niveau devait etre etire ici')
  // ⚠ ET L'ETIREMENT NE SORT JAMAIS DU VENDU.
  for (const x of n) assert.ok(x.prix <= g.base.max)
})

test('LE TEST QUI COMPTE : sous le seuil, la grille se TAIT', () => {
  // Deux seuils, pas un : des nuits ET des reservations distinctes.
  const g = grilleDe(mardis(4, 100))
  assert.equal(g.base.fiable, false)
  assert.equal(g.base.niveaux, null)
  assert.equal(g.base.non_calculable, S.MOTIFS.SEGMENT_MINCE)
  const s = S.suggerer({ date: '2026-11-17', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 30, bien: {} })
  assert.equal(s.prix, null)
  assert.ok(s.non_calculable.includes(S.MOTIFS.SEGMENT_MINCE))
})

test('LE TEST QUI COMPTE : une seule reservation ne fait pas une grille', () => {
  // Un sejour de douze nuits passe le seuil des NUITS mais pas celui des
  // reservations : douze nuits d'un meme client ne sont pas douze mesures.
  const douze = []
  for (let i = 2; i <= 13; i++) douze.push(`2025-09-${String(i).padStart(2, '0')}`)
  const g = grilleDe([ecl(douze, { prix: 100, id: 'UNIQUE' })])
  assert.equal(g.base.fiable, false)
})

test('les longs sejours et les nuits hors reference ne fabriquent pas la grille', () => {
  const normales = mardis(9, 100)
  const long = ecl(['2025-10-01', '2025-10-02', '2025-10-03'], { prix: 999, id: 'L', long: true })
  const exclue = ecl(['2025-10-08'], { prix: 999, id: 'X', exclues: ['2025-10-08'] })
  const g = grilleDe([...normales, long, exclue])
  assert.equal(g.base.max, 100, 'ni le long sejour ni la nuit exclue ne doivent entrer')
})

// ─── LE POSITIONNEMENT DES CONTEXTES ─────────────────────────────────────────

test('LE TEST QUI COMPTE : un contexte se POSITIONNE, il n a pas sa grille', () => {
  // ⚠ C'EST LE RENVERSEMENT DE LA PASSE 5, et la phrase de Thierry :
  // « Toussaint : niveau Haut, ses week-ends : Tres haut ». Le segment ne
  // porte plus de prix — il porte un indice de niveau sur la grille du bien.
  const g = grilleDe([...mardis(9, 100), ...samedis(9, 150)])
  const hv = g.positions.get('hors_vacances')
  assert.ok(hv && hv.fiable)
  assert.equal(hv.prix, undefined, 'un positionnement ne porte AUCUN prix propre')
  assert.ok(Number.isInteger(hv.indice))
  assert.equal(hv.niveau, g.base.niveaux[hv.indice].nom)

  // Le samedi se positionne PLUS HAUT que sa periode : c'est la seule chose
  // que le jour de semaine fait desormais.
  const sam = g.positions_jour.get('hors_vacances|samedi')
  const mar = g.positions_jour.get('hors_vacances|mardi')
  assert.ok(sam.fiable && mar.fiable)
  assert.ok(sam.indice > mar.indice,
    `samedi (${sam.niveau}) devrait etre au-dessus de mardi (${mar.niveau})`)
})

test('le positionnement retient le niveau le PLUS PROCHE de la mediane', () => {
  const niveaux = [{ prix: 100 }, { prix: 120 }, { prix: 140 }]
  assert.equal(S.niveauLePlusProche(niveaux, 100), 0)
  assert.equal(S.niveauLePlusProche(niveaux, 119), 1)
  assert.equal(S.niveauLePlusProche(niveaux, 131), 2)
  // ⚠ A EGALITE, LE PLUS BAS — sans regle de depart, deux medianes symetriques
  // rendraient un niveau different d'un appel a l'autre.
  assert.equal(S.niveauLePlusProche(niveaux, 110), 0)
})

test('le couple (segment, jour) exige AUSSI trois reservations distinctes', () => {
  // Deux sejours de plusieurs samedis suffisaient a fixer le positionnement du
  // samedi : ce sont deux mesures, pas neuf.
  const g = grilleDe([
    ...mardis(9, 100),
    ecl(['2025-09-06', '2025-09-13', '2025-09-20', '2025-09-27'], { prix: 300, id: 'A' }),
    ecl(['2025-10-04', '2025-10-11', '2025-10-18', '2025-10-25'], { prix: 300, id: 'B' })
  ])
  const sam = g.positions_jour.get('hors_vacances|samedi')
  assert.equal(sam.fiable, false, 'deux reservations ne positionnent pas un jour')
})

// ─── LE PIPELINE ─────────────────────────────────────────────────────────────

const bienSansPlancher = { prix_minimum: 100 }

test('LE TEST QUI COMPTE : le prix servi EST le prix du niveau annonce', () => {
  // ⚠ L'INVARIANT QUI REND LE MENSONGE IMPOSSIBLE. Avec un multiplicateur, le
  // moteur pouvait afficher « Haut, +2 niveaux » et servir le prix neutre — le
  // defaut le plus insidieux du lot 4.4. Il n'y a plus de multiplicateur : le
  // prix EST celui d'un niveau, donc l'etiquette ne peut plus mentir.
  const g = grilleDe([...mardis(9, 100), ...samedis(9, 150)])
  for (const date of ['2026-11-03', '2026-11-07', '2026-11-14', '2026-11-21']) {
    for (const delai of [5, 30, 90]) {
      for (const ecart of [-0.5, 0, 0.5]) {
        const s = S.suggerer({ date, grille: g, contexte: CTX, ouverte: true,
          delaiJours: delai, pression: { ecart }, bien: bienSansPlancher })
        if (s.prix == null) continue
        const niveau = g.base.niveaux.find(n => n.nom === s.niveau)
        assert.ok(niveau, `niveau inconnu : ${s.niveau}`)
        assert.equal(s.prix, niveau.prix,
          `${date} J-${delai} : annonce ${s.niveau} (${niveau.prix} €), sert ${s.prix} €`)
      }
    }
  }
})

test('LE TEST QUI COMPTE : l amplitude ne depasse jamais deux niveaux', () => {
  const g = grilleDe([...mardis(9, 100), ...samedis(9, 150)])
  for (const date of ['2026-11-03', '2026-11-07', '2026-11-14']) {
    for (const delai of [0, 5, 14, 15, 59, 60, 200]) {
      for (const ecart of [-1, -0.5, -0.26, -0.25, 0, 0.25, 0.26, 0.5, 1]) {
        const s = S.suggerer({ date, grille: g, contexte: CTX, ouverte: true,
          delaiJours: delai, pression: { ecart }, bien: bienSansPlancher })
        if (s.prix == null) continue
        assert.ok(Math.abs(s.deplacement) <= S.AMPLITUDE_MAX,
          `${date} J-${delai} ecart ${ecart} : deplacement ${s.deplacement}`)
      }
    }
  }
})

test('LE TEST QUI COMPTE : chaque euro se justifie par une couche nommee', () => {
  const g = grilleDe([...mardis(9, 100), ...samedis(9, 150)])
  const s = S.suggerer({ date: '2026-11-07', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 90, pression: { ecart: 0.4 }, bien: bienSansPlancher })
  assert.ok(s.prix > 0)
  const noms = s.couches.map(c => c.nom)
  assert.ok(noms.includes('position'), 'la position de depart doit etre dite')
  assert.ok(noms.includes('pression'))
  assert.ok(noms.includes('delai'))
  for (const c of s.couches) {
    assert.ok(c.detail && c.detail.length > 0, `couche ${c.nom} sans detail`)
  }
  // ⚠ AUCUN RATIO NI AUCUNE MEDIANE EN VEDETTE : les `resume` parlent en
  // niveaux, la mecanique chiffree reste dans `detail`.
  for (const c of s.couches) {
    if (!c.resume) continue
    assert.ok(!/×|ratio|médiane|mediane/.test(c.resume),
      `« ${c.resume} » parle le langage du moteur`)
  }
})

test('l etiquette ne porte le jour QUE s il change le niveau', () => {
  // ⚠ REGLE DES COUCHES MUETTES, APPLIQUEE AU LIBELLE. « Base · mardi » sur un
  // mardi qui suit sa periode ferait une etiquette a deux termes pour une seule
  // information.
  const g = grilleDe([...mardis(9, 100), ...samedis(9, 150)])
  const mardi = S.suggerer({ date: '2026-11-03', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 30, bien: bienSansPlancher })
  const samedi = S.suggerer({ date: '2026-11-07', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 30, bien: bienSansPlancher })
  assert.equal(mardi.etiquette, mardi.niveau, 'un jour qui suit sa periode : niveau seul')
  assert.equal(samedi.etiquette, `${samedi.niveau} · samedi`)
  assert.equal(samedi.etiquette_corrigee, true)
})

test('LE TEST QUI COMPTE : un ecart NON FIABLE ne deplace aucun prix', () => {
  // ⚠ RELEVE EN REVIEW, ET LE DEFAUT AGISSAIT DEJA EN PRODUCTION.
  // Le portefeuille N-1 de La bulle porte `portefeuille_n1_reconstruit` : il
  // est reconstitue depuis l'etat final, donc sous-compte par construction —
  // annulations invisibles, dates de vente perdues a la migration. Le biais est
  // systematiquement POSITIF. Le moteur en tirait « +40 %, on monte d'un
  // niveau » : une hausse automatique causee par une lacune de donnee.
  const g = grilleDe([...mardis(9, 100), ...samedis(9, 150)])
  const base = { date: '2026-11-03', grille: g, contexte: CTX, ouverte: true,
    delaiJours: 30, bien: bienSansPlancher }
  const fiable = S.suggerer({ ...base, pression: { ecart: 0.5 } })
  const pas = S.suggerer({ ...base,
    pression: { ecart: 0.5, fiable: false, motif_non_fiable: 'portefeuille_n1_reconstruit' } })
  assert.equal(fiable.couches.find(c => c.nom === 'pression').deplacement, 1)
  assert.equal(pas.couches.find(c => c.nom === 'pression').deplacement, 0)
  assert.ok(pas.prix <= fiable.prix, 'un ecart non fiable ne doit pas faire monter')
  // ⚠ ET LE CHIFFRE RESTE MONTRE, avec sa reserve : le masquer priverait
  // l'hote d'une information vraie, seulement imprecise.
  assert.match(pas.couches.find(c => c.nom === 'pression').detail,
    /ne déplace aucun prix/)
  assert.equal(pas.couches.find(c => c.nom === 'pression').agit, false)
})

test('LE TEST QUI COMPTE : sans `bien`, le plancher GLOBAL s applique quand meme', () => {
  // ⚠ `bien || {}`, JAMAIS `bien ? … : { ok: true }`. La valeur par defaut du
  // parametre est `null`, et l'ancienne forme sautait le plancher de 10 €
  // exactement dans le cas ou il sert — « aucun reglage ».
  const g = grilleDe(mardis(9, 5))
  const s = S.suggerer({ date: '2026-11-17', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 30 })
  assert.equal(s.prix, null)
  assert.ok(s.non_calculable.includes(S.MOTIFS.SOUS_PLANCHER))
  assert.equal(s.plancher, 10)
})

test('une nuit vendue, fermee ou inconnue ne recoit AUCUN prix', () => {
  const g = grilleDe([...mardis(9, 100), ...samedis(9, 150)])
  const base = { date: '2026-11-17', grille: g, contexte: CTX, delaiJours: 30, bien: {} }
  assert.ok(S.suggerer({ ...base, ouverte: true, vendue: true })
    .non_calculable.includes(S.MOTIFS.VENDUE))
  assert.ok(S.suggerer({ ...base, ouverte: false })
    .non_calculable.includes(S.MOTIFS.FERMEE))
  // ⚠ « JE NE SAIS PAS » N'EST PAS « OUI ».
  assert.ok(S.suggerer({ ...base, ouverte: null })
    .non_calculable.includes(S.MOTIFS.OUVERTURE_INCONNUE))
})

test('une nuit PASSEE n est pas une nuit proche', () => {
  const g = grilleDe([...mardis(9, 100), ...samedis(9, 150)])
  const s = S.suggerer({ date: '2024-11-05', grille: g, contexte: CTX,
    ouverte: true, delaiJours: -120, bien: {} })
  assert.ok(s.non_calculable.includes(S.MOTIFS.NUIT_PASSEE))
  assert.equal(s.prix, null)
})

test('une grille passee par JSON n est plus une grille, et on le DIT', () => {
  // Apres un aller-retour JSON les `Map` deviennent `{}`, qui est TRUTHY : le
  // garde passait et `.get` levait un TypeError, donc un 500 au lieu d'un motif.
  const g = JSON.parse(JSON.stringify({ ...grilleDe(mardis(9, 100)),
    positions: {}, positions_jour: {} }))
  const s = S.suggerer({ date: '2026-11-17', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 30, bien: {} })
  assert.ok(s.non_calculable.includes(S.MOTIFS.PAS_DE_GRILLE))
})

test('100 % deterministe : memes entrees, meme prix', () => {
  const g = grilleDe([...mardis(9, 100), ...samedis(9, 150)])
  const appel = () => S.suggerer({ date: '2026-11-07', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 40, pression: { ecart: 0.3 }, bien: bienSansPlancher })
  assert.deepEqual(appel(), appel())
})

// ─── L emprunt au segment parent ─────────────────────────────────────────────

test('LE TEST QUI COMPTE : le moteur ne se tait JAMAIS sur un pont', () => {
  // Sans la regle d'emprunt, ce cas rendait « segment sous le seuil » : aucune
  // suggestion sur la nuit qui prend le plus de valeur de l'annee, et un
  // silence qui ne se voit pas.
  const feries = ['2025-05-01', '2025-05-08', '2025-05-29', '2025-11-11',
    '2025-12-25', '2025-07-14', '2025-04-21', '2025-06-09', '2025-01-01']
  const lignes = [...mardis(9, 100),
    ...feries.map((d, i) => ecl([d], { prix: 200, id: `F${i}` })),
    ecl(['2025-05-02'], { prix: 180, id: 'P1' }),
    ecl(['2025-05-09'], { prix: 180, id: 'P2' })]
  const g = grilleDe(lignes)
  const pont = g.positions.get('pont')
  assert.ok(pont.fiable, 'le pont doit avoir une position')
  assert.equal(pont.reference_empruntee, 'ferie')
  assert.equal(pont.indice, g.positions.get('ferie').indice)
  assert.equal(pont.echantillon_propre, 2)

  const s = S.suggerer({ date: '2026-05-15', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 30, bien: bienSansPlancher })
  assert.equal(s.reference_empruntee, 'ferie')
  assert.ok(s.prix > 0, 'un pont doit recevoir un prix')
  assert.equal(s.non_calculable.length, 0)
  assert.match(s.couches.find(c => c.nom === 'position').detail, /empruntee/)
})

test('l emprunt ne remplace jamais une mesure propre', () => {
  const feries = ['2025-05-01', '2025-05-08', '2025-05-29', '2025-11-11',
    '2025-12-25', '2025-07-14', '2025-04-21', '2025-06-09', '2025-01-01']
  const ponts = ['2025-01-02', '2025-01-03', '2025-05-02', '2025-05-09',
    '2025-05-30', '2025-11-10', '2025-12-26', '2024-05-10', '2024-11-01']
  const g = grilleDe([...mardis(9, 100),
    ...feries.map((d, i) => ecl([d], { prix: 200, id: `F${i}` })),
    ...ponts.map((d, i) => ecl([d], { prix: 300, id: `P${i}` }))])
  const pont = g.positions.get('pont')
  assert.equal(pont.fiable, true)
  assert.equal(pont.reference_empruntee, undefined)
  assert.equal(pont.mediane, 300, 'sa mediane, pas celle du parent')
})

test('si le parent est maigre lui aussi, le moteur le DIT au lieu d inventer', () => {
  // ⚠ L'EMPRUNT N'EST PAS UNE PROMESSE INCONDITIONNELLE.
  const g = grilleDe([...mardis(9, 100),
    ecl(['2025-05-01'], { prix: 200, id: 'F1' }),
    ecl(['2025-05-02'], { prix: 200, id: 'P1' })])
  const pont = g.positions.get('pont')
  assert.equal(pont.fiable, false)
  const s = S.suggerer({ date: '2026-05-15', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 30, bien: {} })
  assert.equal(s.prix, null)
  assert.ok(s.non_calculable.includes(S.MOTIFS.SEGMENT_MINCE))
})
