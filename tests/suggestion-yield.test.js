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

// ─── LA GRILLE ───────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : chaque niveau est un prix REELLEMENT obtenu', () => {
  // ⚠ AUCUN POURCENTAGE INVENTE. « -10 % / +10 % » serait un chiffre sorti de
  // nulle part ; un quantile repond a « vous avez deja vendu a ce prix ce type
  // de nuit », ce qui se defend devant l'hote et se verifie dans ses donnees.
  const prix = [100, 105, 110, 115, 120, 125, 130, 135, 140]
  // Neuf jours consecutifs de septembre : tous hors vacances, tous distincts.
  const lignes = prix.map((p, i) =>
    ecl([`2025-09-${String(1 + i).padStart(2, '0')}`], { prix: p, id: `R${i}` }))
  const g = grilleDe(lignes)
  const seg = g.segments.get(R.SEGMENTS.HORS_VACANCES)
  assert.ok(seg.fiable, '9 nuits, 9 reservations : au-dessus des deux seuils')
  // Chaque niveau doit se retrouver entre le min et le max observes.
  for (const n of seg.niveaux) {
    assert.ok(n.prix >= seg.min && n.prix <= seg.max,
      `${n.nom} (${n.prix}) hors de l etendue observee ${seg.min}–${seg.max}`)
  }
  // Et la grille est croissante.
  for (let i = 1; i < seg.niveaux.length; i++) {
    assert.ok(seg.niveaux[i].prix >= seg.niveaux[i - 1].prix, 'grille non croissante')
  }
  assert.equal(seg.niveaux[S.SOCLE].nom, 'Référence')
  assert.equal(seg.niveaux[S.SOCLE].prix, 120, 'le socle est la mediane')
})

test('LE TEST QUI COMPTE : sous le seuil, la grille se TAIT', () => {
  // Meme regle que la reference — une seule dans tout le moteur. Si la
  // reference se tait, la suggestion se tait.
  const g = grilleDe(mardis(5, 100))
  const seg = g.segments.get(R.SEGMENTS.HORS_VACANCES)
  assert.equal(seg.fiable, false)
  assert.equal(seg.niveaux, null, 'aucune grille servie')
  assert.equal(seg.mediane, null)
  assert.equal(seg.non_calculable, 'segment_sous_le_seuil')
  assert.equal(seg.echantillon, 5, 'mais on DIT combien il y avait')
})

test('LE TEST QUI COMPTE : une seule reservation ne fait pas une grille', () => {
  // Huit nuits d'un meme sejour portent le meme prix : la « grille » serait un
  // point unique tire d'une reservation. Meme piege qu'a la reference.
  const sejour = ecl(['2025-01-07', '2025-01-08', '2025-01-09', '2025-01-10',
    '2025-01-13', '2025-01-14', '2025-01-15', '2025-01-16'], { prix: 300, id: 'UNIQUE' })
  const g = grilleDe([sejour])
  const seg = g.segments.get(R.SEGMENTS.HORS_VACANCES)
  assert.equal(seg.echantillon, 8, 'huit nuits')
  assert.equal(seg.reservations, 1, 'mais UNE observation')
  assert.equal(seg.fiable, false)
})

test('les longs sejours et les nuits hors reference ne fabriquent pas la grille', () => {
  const long = ecl(Array.from({ length: 28 }, (_, k) => {
    const d = new Date(Date.UTC(2025, 8, 1)); d.setUTCDate(d.getUTCDate() + k)
    return d.toISOString().slice(0, 10)
  }), { prix: 40, id: 'LONG', long: true })
  const g = grilleDe([...mardis(9, 120), long])
  const seg = g.segments.get(R.SEGMENTS.HORS_VACANCES)
  assert.equal(seg.niveaux[S.SOCLE].prix, 120, 'les 40 € du long sejour sont ecartes')
  assert.ok(g.nuits_ecartees >= 28)
})

test('LE TEST QUI COMPTE : le jour de semaine est une COUCHE, pas un axe', () => {
  // ⚠ La spec exige « correction jour-de-semaine en dernier », et ce n'est pas
  // un detail d'ordre. Croiser le segment par le jour des le socle diviserait
  // chaque echantillon par sept, et surtout ferait du jour un critere de CHOIX
  // DU NIVEAU — alors qu'un samedi ne se vend pas « a un niveau plus haut » :
  // il se vend un certain pourcentage plus cher que la mediane de son segment.
  const g = grilleDe([...mardis(9, 100), ...samedis(9, 150)])
  const seg = g.segments.get(R.SEGMENTS.HORS_VACANCES)
  // ⚠ 17, PAS 18 : le 1er novembre 2025 est un SAMEDI FERIE, et les jours
  // feries sont CALCULES — ils ne sont pas dans le jeu de vacances du test.
  // Le moteur a raison de le sortir du hors-vacances ; c'est le test qui
  // l'ignorait. C'est aussi la preuve que la segmentation ne se contente pas
  // de ce qu'on lui donne.
  assert.equal(seg.echantillon, 17, 'UN seul segment, pas deux cases par jour')
  assert.equal(g.segments.get(R.SEGMENTS.FERIE).echantillon, 1, 'et le ferie est a part')
  const rSam = g.ratios_jour.get(`${R.SEGMENTS.HORS_VACANCES}|samedi`)
  const rMar = g.ratios_jour.get(`${R.SEGMENTS.HORS_VACANCES}|mardi`)
  // ⚠ LA MEDIANE DU SEGMENT SUIT LE GROUPE MAJORITAIRE. Neuf mardis a 100 €
  // contre huit samedis a 150 € : la mediane des dix-sept nuits vaut 100, celle
  // des mardis. Le ratio du samedi porte donc TOUT l'ecart (×1,5) et celui du
  // mardi vaut 1. Ce n'est pas un defaut — c'est ce que la couche finale doit
  // faire : elle corrige un prix de segment, pas une moyenne de jours.
  assert.equal(rMar.ratio, 1, 'le jour majoritaire fixe la mediane du segment')
  assert.equal(rSam.ratio, 1.5, 'et le samedi porte tout l ecart mesure')
  assert.ok(rSam.ratio > rMar.ratio, 'le samedi vaut plus que le mardi')
  assert.equal(rSam.echantillon, 8, 'huit samedis hors vacances, le neuvieme est ferie')
  assert.equal(rMar.echantillon, 9)
})

test('un ratio de jour tire de trop peu de nuits ne s applique pas', () => {
  // Corriger un prix par un rapport tire de trois nuits serait pire que de ne
  // pas le corriger.
  const g = grilleDe([...mardis(12, 100), ...samedis(3, 400)])
  assert.equal(g.ratios_jour.get(`${R.SEGMENTS.HORS_VACANCES}|samedi`), undefined)
  assert.ok(g.ratios_jour.get(`${R.SEGMENTS.HORS_VACANCES}|mardi`))
})

// ─── LE PIPELINE ─────────────────────────────────────────────────────────────

const GRILLE = grilleDe([...mardis(12, 100), ...samedis(12, 150)])
const BIEN = { prix_minimum: 5000 }   // 50 €

test('LE TEST QUI COMPTE : chaque euro se justifie par une couche nommee', () => {
  const s = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
    ouverte: true, delaiJours: 30, pression: { ecart: 0 }, bien: BIEN })
  assert.ok(s.prix > 0)
  const noms = s.couches.map(c => c.nom)
  assert.deepStrictEqual(noms, ['socle', 'pression', 'delai', 'jour_de_semaine'],
    'les quatre couches, dans l ordre, jour de semaine EN DERNIER')
  for (const c of s.couches) {
    assert.ok(c.detail && c.detail.length > 5, `la couche ${c.nom} doit se chiffrer`)
  }
  assert.ok(s.fourchette && s.fourchette.min != null && s.fourchette.max != null,
    'la fourchette du segment est montree — elle dit si le chiffre merite confiance')
})

test('LE TEST QUI COMPTE : 100 % deterministe', () => {
  // Memes entrees, meme sortie. Un moteur de prix qui varie d'un appel a
  // l'autre est indefendable : l'hote ne peut pas verifier ce qu'on lui
  // propose, et deux ecrans ouverts afficheraient deux prix.
  const args = { date: '2026-03-07', grille: GRILLE, contexte: CTX, ouverte: true,
    delaiJours: 45, pression: { ecart: -0.3 }, bien: BIEN }
  const a = S.suggerer(args)
  const b = S.suggerer(args)
  assert.deepStrictEqual(a, b)
})

test('LE TEST QUI COMPTE : aucune suggestion sur une date FERMEE', () => {
  // ⚠ ARBITRAGE DE THIERRY. Le prix n'a aucun effet tant que la date est
  // fermee, et l'appliquer alimenterait le journal avec un tarif que personne
  // ne verra jamais — le cas que le lot 4.3 vient de corriger a l'autre bout.
  // Huit des douze prochains mois de La bulle sont dans ce cas.
  const s = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
    ouverte: false, delaiJours: 30, pression: { ecart: 0 }, bien: BIEN })
  assert.equal(s.prix, null)
  assert.ok(s.non_calculable.includes(S.MOTIFS.FERMEE))
  assert.deepStrictEqual(s.couches, [], 'et on ne calcule meme pas')
})

test('LE TEST QUI COMPTE : le plancher REFUSE, il ne rabote pas', () => {
  // Regle gravee au KB du prix plancher : on ferme la date, on ne remonte
  // jamais le prix a la place de l hote. Proposer un prix releve au plancher
  // ferait croire que le moteur le RECOMMANDE.
  const petit = grilleDe(mardis(12, 20))
  const s = S.suggerer({ date: '2026-03-03', grille: petit, contexte: CTX,
    ouverte: true, delaiJours: 30, pression: null, bien: { prix_minimum: 5000 } })
  assert.equal(s.prix, null, 'aucun prix propose')
  assert.ok(s.non_calculable.includes(S.MOTIFS.SOUS_PLANCHER))
  assert.ok(s.prix_refuse > 0, 'mais on DIT ce qui a ete refuse')
  assert.equal(s.plancher, 50)
})

test('LE TEST QUI COMPTE : l amplitude ne depasse jamais deux niveaux', () => {
  // ⚠ ARBITRAGE DE THIERRY. C'est toute la grille : le moteur ne propose jamais
  // un prix hors de ce que l hote a deja pratique sur ce segment.
  const extreme = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
    ouverte: true, delaiJours: 200, pression: { ecart: 5 }, bien: BIEN })
  assert.equal(extreme.deplacement, 2, 'deux niveaux, pas trois')
  assert.equal(extreme.niveau, 'Haut')
  const bas = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
    ouverte: true, delaiJours: 1, pression: { ecart: -0.9 }, bien: BIEN })
  assert.equal(bas.deplacement, -2)
  assert.equal(bas.niveau, 'Prudent')
})

test('LE TEST QUI COMPTE : l invariant d amplitude tient sur TOUTES les entrees', () => {
  // ⚠ LA BORNE A ±2 EST AUJOURD'HUI REDONDANTE — deux couches a ±1 ne peuvent
  // pas produire plus. La retirer ne fait donc echouer aucun cas particulier,
  // et c'est precisement pourquoi il faut tester l'INVARIANT et non la ligne :
  // le jour ou une troisieme couche s'ajoutera, ce test tombera, et c'est lui
  // qui rappellera que le moteur ne doit jamais proposer un prix hors de ce que
  // l'hote a deja pratique.
  const ecarts = [-5, -0.9, -0.26, -0.25, -0.24, 0, 0.24, 0.25, 0.26, 0.9, 5, null]
  const delais = [0, 1, 14, 15, 30, 59, 60, 200, 3650, null]
  let vus = 0
  for (const e of ecarts) {
    for (const d of delais) {
      const s = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
        ouverte: true, delaiJours: d, pression: e == null ? null : { ecart: e },
        bien: BIEN })
      if (s.prix == null) continue
      vus++
      assert.ok(Math.abs(s.deplacement) <= S.AMPLITUDE_MAX,
        `deplacement ${s.deplacement} au-dela de ±${S.AMPLITUDE_MAX} (ecart ${e}, delai ${d})`)
      // ⚠ ET LE PRIX RESTE DANS CE QUE LE LOGEMENT A DEJA PRATIQUE CE JOUR-LA.
      // C'est ce test qui a trouve le defaut : niveau Prudent 100 € × ratio
      // mardi 0,8 rendait 80 €, alors que la nuit la moins chere jamais vendue
      // etait a 100. Eprouver une propriete sur toutes les entrees attrape ce
      // qu'un cas choisi ne montre pas.
      const et = s.fourchette_jour || s.fourchette
      assert.ok(s.prix >= et.min && s.prix <= et.max,
        `${s.prix} € hors de l etendue observee ${et.min}–${et.max}`)
      assert.ok(S.NIVEAUX.some(n => n.nom === s.niveau), 'le niveau est nomme')
    }
  }
  assert.ok(vus >= 100, `l invariant doit etre eprouve largement (${vus} cas)`)
})

test('LE TEST QUI COMPTE : deux signaux dans le meme sens se DISENT', () => {
  // ⚠ ARBITRAGE DE THIERRY. C'est le cas ou la suggestion s eloigne le plus du
  // prix actuel, donc celui ou l hote veut regarder avant d appliquer.
  const cumul = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
    ouverte: true, delaiJours: 90, pression: { ecart: 0.5 }, bien: BIEN })
  assert.equal(cumul.cumul, true)
  assert.ok(cumul.couches.some(c => c.nom === 'cumul'))
  const seul = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
    ouverte: true, delaiJours: 30, pression: { ecart: 0.5 }, bien: BIEN })
  assert.equal(seul.cumul, undefined, 'un seul signal ne cumule rien')
})

test('sans N-1 comparable, la pression ne DEVINE pas', () => {
  const s = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
    ouverte: true, delaiJours: 30, pression: null, bien: BIEN })
  const p = s.couches.find(c => c.nom === 'pression')
  assert.equal(p.deplacement, 0)
  assert.match(p.detail, /aucun N-1/)
})

test('un segment sans grille se DIT, il ne retombe pas sur un autre', () => {
  // Retomber sur le segment voisin donnerait un prix credible et faux : les
  // vacances de la zone du bien valent 23 % de plus que le hors-vacances.
  const g = grilleDe(mardis(12, 100))   // seul `hors_vacances` est peuple
  // Un jour FERIE : le segment `ferie` n'a qu'une nuit dans cette grille, tres
  // loin du seuil. Retomber sur `hors_vacances` donnerait un prix credible et
  // faux — les feries se vendent 8 % plus cher sur La bulle.
  const s = S.suggerer({ date: '2026-05-01', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 30, pression: null, bien: BIEN })
  assert.equal(s.prix, null)
  assert.ok(s.non_calculable.includes(S.MOTIFS.PAS_DE_GRILLE) ||
    s.non_calculable.includes(S.MOTIFS.SEGMENT_MINCE))
})

test('une date hors du contexte charge se DIT', () => {
  const court = R.construireContexte({ zoneBien: 'C', vacances: VACANCES,
    debut: '2025-01-01', fin: '2025-12-31' })
  const s = S.suggerer({ date: '2027-03-03', grille: GRILLE, contexte: court,
    ouverte: true, delaiJours: 30, pression: null, bien: BIEN })
  assert.equal(s.prix, null)
  assert.ok(s.non_calculable.includes('hors_fenetre_du_contexte'))
})

test('le module est PUR : ni base, ni reseau, ni horloge', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../lib/yield/suggestion'), 'utf8')
  for (const interdit of ['supabase', 'fetch(', 'Date.now(', 'process.env', '.from(']) {
    assert.ok(!src.includes(interdit), `le module ne doit pas contenir ${interdit}`)
  }
  assert.ok(!/new Date\s*\(\s*\)/.test(src), 'aucune lecture de l horloge systeme')
  // Et il n'ECRIT rien, nulle part.
  for (const interdit of ['insert', 'update', 'upsert', 'delete']) {
    assert.ok(!src.includes(interdit), `ce module PROPOSE, il n ecrit pas (${interdit})`)
  }
})

test('LE TEST QUI COMPTE : « je ne sais pas » n est pas « oui »', () => {
  // ⚠ TROUVE EN EPROUVANT LE PIPELINE SUR DES DATES REELLES, pas en relisant le
  // code. Le calendrier de La bulle s'arrete au 7 decembre 2026 : au-dela, la
  // memoire d'intention n'existe pas et `ouverte` vaut `null`. La premiere
  // version suggerait quand meme un prix — pour une nuit dont personne ne sait
  // si elle est vendable. C'est la regle qui traverse tout ce chantier depuis
  // le lot 3.2, appliquee au dernier maillon.
  for (const inconnu of [null, undefined]) {
    const s = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
      ouverte: inconnu, delaiJours: 30, pression: null, bien: BIEN })
    assert.equal(s.prix, null, `ouverte=${inconnu} : aucune suggestion`)
    assert.ok(s.non_calculable.includes(S.MOTIFS.OUVERTURE_INCONNUE))
  }
  // Et « fermee » reste distinct d'« inconnu » : deux causes, deux motifs.
  const fermee = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
    ouverte: false, delaiJours: 30, pression: null, bien: BIEN })
  assert.ok(fermee.non_calculable.includes(S.MOTIFS.FERMEE))
  assert.ok(!fermee.non_calculable.includes(S.MOTIFS.OUVERTURE_INCONNUE))
  // Seul `true` ouvre la porte.
  const ouverte = S.suggerer({ date: '2026-03-03', grille: GRILLE, contexte: CTX,
    ouverte: true, delaiJours: 30, pression: null, bien: BIEN })
  assert.ok(ouverte.prix > 0)
})

// ─── LES EUROS, PAS SEULEMENT LES NOMS ───────────────────────────────────────
// ⚠ LE CONSTAT LE PLUS STRUCTURANT DE LA REVIEW : aucun test de ce fichier
// n'assertait un PRIX. Tous portaient sur `s.prix > 0`, un nom de niveau ou une
// appartenance a une fourchette — et dans le jeu d'essai d'origine, l'etendue du
// mardi etait [100, 100], donc Prudent, Reference et Haut rendaient TOUS 100 €.
// Les quatre couches, l'amplitude ±2 et le cumul ne produisaient aucun euro, et
// rien ne le disait.
//
// Ici, un couple jour DISPERSE, et des prix exacts.

// Neuf mardis de septembre-novembre 2025, prix etales de 100 a 180.
function mardisEtales () {
  const prix = [100, 110, 120, 130, 140, 150, 160, 170, 180]
  const out = []
  const d = new Date(Date.UTC(2025, 8, 2))
  for (let i = 0; i < prix.length; i++) {
    out.push(ecl([d.toISOString().slice(0, 10)], { prix: prix[i], id: `E${i}` }))
    d.setUTCDate(d.getUTCDate() + 7)
  }
  return out
}
const ETALEE = grilleDe(mardisEtales())

test('LE TEST QUI COMPTE : le pipeline produit des EUROS distincts et exacts', () => {
  const seg = ETALEE.segments.get(R.SEGMENTS.HORS_VACANCES)
  // 9 valeurs de 100 a 180 : P20 = 116, P35 = 128, P50 = 140, P65 = 152, P80 = 164.
  assert.deepStrictEqual(seg.niveaux.map(n => n.prix), [116, 128, 140, 152, 164])
  // Le ratio du mardi vaut 1 (les mardis SONT le segment), donc le prix servi
  // est exactement le niveau — l'euro se lit sans intermediaire.
  const r = ETALEE.ratios_jour.get(`${R.SEGMENTS.HORS_VACANCES}|mardi`)
  assert.equal(r.ratio, 1)

  const cas = [
    // [delai, ecart, niveau attendu, prix attendu]
    [30, 0, 'Référence', 140],
    [30, -0.3, 'Mesuré', 128],
    [30, 0.3, 'Ferme', 152],
    [5, 0, 'Mesuré', 128],
    [90, 0, 'Ferme', 152],
    [5, -0.3, 'Prudent', 116],
    [90, 0.3, 'Haut', 164]
  ]
  for (const [delai, ecart, niveau, prix] of cas) {
    const s = S.suggerer({ date: '2026-03-03', grille: ETALEE, contexte: CTX,
      ouverte: true, delaiJours: delai, pression: { ecart }, bien: BIEN })
    assert.equal(s.niveau, niveau, `délai ${delai}, écart ${ecart} : niveau`)
    assert.equal(s.prix, prix, `délai ${delai}, écart ${ecart} : ${prix} € attendus`)
  }
  // Sept combinaisons, cinq prix DISTINCTS : le pipeline bouge vraiment.
  assert.equal(new Set(cas.map(c => c[3])).size, 5)
})

test('LE TEST QUI COMPTE : un niveau annonce ne ment jamais sur l euro servi', () => {
  // ⚠ LE DEFAUT LE PLUS INSIDIEUX DU LOT. Quand l'etendue du couple (segment,
  // jour) est plus resserree que celle du segment, les cinq niveaux s'ecrasent
  // apres bornage : l'hote lisait « Haut, +2 niveaux, deux signaux dans le meme
  // sens » et voyait EXACTEMENT le prix neutre.
  //
  // Un segment large (mardis etales) et un jour homogene (samedis tous a 150) :
  // le samedi ne peut servir que 150 €, quel que soit le niveau choisi.
  const samedisPlats = []
  const d = new Date(Date.UTC(2025, 8, 6))
  for (let i = 0; i < 9; i++) {
    samedisPlats.push(ecl([d.toISOString().slice(0, 10)], { prix: 150, id: `P${i}` }))
    d.setUTCDate(d.getUTCDate() + 7)
  }
  const g = grilleDe([...mardisEtales(), ...samedisPlats])
  const rSam = g.ratios_jour.get(`${R.SEGMENTS.HORS_VACANCES}|samedi`)
  assert.equal(rSam.min, rSam.max, 'le samedi est homogene : etendue d un seul point')
  // Et le detail dira la cause JOUR pour le samedi.

  const haut = S.suggerer({ date: '2026-03-07', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 90, pression: { ecart: 0.5 }, bien: BIEN })
  const neutre = S.suggerer({ date: '2026-03-07', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 30, pression: { ecart: 0 }, bien: BIEN })
  assert.equal(haut.prix, neutre.prix, 'l etendue du jour ecrase les deux')
  // ⚠ ET LE MOTEUR LE DIT, au lieu d annoncer un deplacement qui ne s est pas
  // traduit en euros.
  assert.equal(haut.deplacement, 2, 'le niveau CHOISI reste lisible')
  assert.equal(haut.deplacement_effectif, 0, 'mais le deplacement EFFECTIF est nul')
  assert.equal(haut.niveau_effectif, 'Référence')
  assert.ok(haut.non_calculable.includes(S.MOTIFS.PIPELINE_NEUTRALISE))
  assert.ok(haut.couches.some(c => c.nom === 'neutralisation'))
  // ⚠ ET LA NEUTRALISATION ATTRAPE UNE SECONDE CAUSE, decouverte en ecrivant ce
  // test : ici les huit samedis a 150 € dominent le segment, donc P50 a P80 se
  // confondent (150 €) — le deplacement est sans effet MEME sur un mardi dont
  // l'etendue est large [100, 180]. Le motif dit l'effet, le detail dit la
  // cause. C'est ce que le moteur doit faire : l'hote ne se demande pas
  // pourquoi « +2 niveaux » n'a rien change.
  const mardi = S.suggerer({ date: '2026-03-03', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 90, pression: { ecart: 0.5 }, bien: BIEN })
  assert.equal(mardi.deplacement_effectif, 0)
  assert.ok(mardi.couches.find(c => c.nom === 'neutralisation').detail
    .includes('se confondent'), 'la cause SEGMENT, pas la cause JOUR')

  // Sur une grille reellement etalee, en revanche, le deplacement produit un euro.
  const vrai = S.suggerer({ date: '2026-03-03', grille: ETALEE, contexte: CTX,
    ouverte: true, delaiJours: 90, pression: { ecart: 0.5 }, bien: BIEN })
  assert.equal(vrai.deplacement_effectif, vrai.deplacement)
  assert.equal(vrai.prix, 164, 'niveau Haut, ratio 1')
  assert.ok(!vrai.non_calculable.includes(S.MOTIFS.PIPELINE_NEUTRALISE))
})

test('LE TEST QUI COMPTE : sans `bien`, le plancher GLOBAL s applique quand meme', () => {
  // ⚠ RELEVE EN REVIEW. `bien` a `null` est la VALEUR PAR DEFAUT du parametre,
  // et l ancienne ligne sautait alors le plancher entierement. Or
  // `plancherDuBien(null)` rend le plancher global de 10 € : cette garde existe
  // precisement pour le cas « aucun reglage ».
  const bradee = grilleDe(mardis(12, 8))
  for (const bien of [null, undefined, {}]) {
    const s = S.suggerer({ date: '2026-03-03', grille: bradee, contexte: CTX,
      ouverte: true, delaiJours: 30, pression: null, bien })
    assert.equal(s.prix, null, `bien=${bien} : 8 € est sous le plancher global`)
    assert.ok(s.non_calculable.includes(S.MOTIFS.SOUS_PLANCHER))
    assert.equal(s.plancher, 10, 'et le plancher global est DIT')
  }
})

test('LE TEST QUI COMPTE : une nuit DEJA PASSEE ne reçoit pas de suggestion', () => {
  // `-120 <= 14` etait vrai : le moteur proposait un prix prudent pour une nuit
  // consommee depuis quatre mois, en expliquant « la nuit approche ».
  const s = S.suggerer({ date: '2026-03-03', grille: ETALEE, contexte: CTX,
    ouverte: true, delaiJours: -120, pression: null, bien: BIEN })
  assert.equal(s.prix, null)
  assert.ok(s.non_calculable.includes(S.MOTIFS.NUIT_PASSEE))
  // Le jour meme (delai 0) reste tarifable : il n est pas passe.
  const aujourdHui = S.suggerer({ date: '2026-03-03', grille: ETALEE, contexte: CTX,
    ouverte: true, delaiJours: 0, pression: null, bien: BIEN })
  assert.ok(aujourdHui.prix > 0)
})

test('une grille SERIALISEE rend un motif, pas un TypeError', () => {
  // `construireGrille` rend des Map. Apres un aller-retour JSON — le chemin
  // naturel des le lot 4.5 — `segments` devient `{}`, qui est TRUTHY : le garde
  // passait et `.get` levait, donc un 500 au lieu d un motif.
  const morte = JSON.parse(JSON.stringify(ETALEE))
  assert.doesNotThrow(() => S.suggerer({ date: '2026-03-03', grille: morte,
    contexte: CTX, ouverte: true, delaiJours: 30, pression: null, bien: BIEN }))
  const s = S.suggerer({ date: '2026-03-03', grille: morte, contexte: CTX,
    ouverte: true, delaiJours: 30, pression: null, bien: BIEN })
  assert.equal(s.prix, null)
  assert.ok(s.non_calculable.includes(S.MOTIFS.PAS_DE_GRILLE))
})

test('LE TEST QUI COMPTE : le segment rendu est CELUI QUI A FAIT LE PRIX', () => {
  // ⚠ RELEVE EN REVIEW. La grille est indexee sur `segment`
  // (« vacances de la zone »), pas sur `detail` (« … : hiver ») : annoncer le
  // detail ferait lire « vacances d hiver : 144 € » alors que le chiffre est la
  // mediane de TOUTES les vacances de la zone, ete compris. C est exactement ce
  // que `reference.js` interdit — et elle, au moins, porte un drapeau `replie`.
  const ete = []
  const d = new Date(Date.UTC(2025, 6, 8))
  for (let i = 0; i < 12; i++) {
    ete.push(ecl([d.toISOString().slice(0, 10)], { prix: 200, id: `T${i}` }))
    d.setUTCDate(d.getUTCDate() + 7)
  }
  const g = grilleDe(ete)
  // ⚠ PAS LE 14 JUILLET : il est FERIE, donc `segment === detail` et le test ne
  // distinguerait rien. Le 21 est un mardi ordinaire des vacances d'ete.
  const s = S.suggerer({ date: '2026-07-21', grille: g, contexte: CTX,
    ouverte: true, delaiJours: 30, pression: null, bien: BIEN })
  assert.ok(s.prix != null, 'la grille doit repondre sur ce segment')
  assert.equal(s.segment, R.SEGMENTS.VACANCES_ZONE,
    'le segment annonce est celui qui INDEXE la grille')
  assert.equal(s.segment_detaille, `${R.SEGMENTS.VACANCES_ZONE}:été`,
    'le detail reste disponible, mais a part')
  assert.notEqual(s.segment, s.segment_detaille,
    'les deux ne doivent pas etre confondus : « vacances d ete : 200 € » serait'
    + ' la mediane de TOUTES les vacances de la zone')
})

test('le ratio d un jour exige AUSSI trois reservations distinctes', () => {
  // ⚠ RELEVE EN REVIEW : seul le compte de nuits etait teste. Deux sejours de
  // 24 nuits (sous le seuil de long sejour, donc non ecartes) suffisaient a
  // fixer le ratio ET l etendue de borne — tous les mardis geles a leur prix.
  const sejour = (debut, id) => {
    const nuits = []
    const d = new Date(debut)
    for (let k = 0; k < 24; k++) { nuits.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 7) }
    return ecl(nuits, { prix: 300, id })
  }
  // Deux sejours SEULS sur les mardis : 48 nuits, mais DEUX observations.
  const g = grilleDe([
    sejour(Date.UTC(2025, 8, 2), 'A'), sejour(Date.UTC(2025, 8, 2), 'B'),
    // De quoi peupler le segment sans toucher aux mardis.
    ...['2025-09-03', '2025-09-10', '2025-09-17', '2025-09-24',
      '2025-10-01', '2025-10-08', '2025-10-15', '2025-10-22', '2025-10-29']
      .map((d, i) => ecl([d], { prix: 120, id: `W${i}` }))
  ])
  const r = g.ratios_jour.get(`${R.SEGMENTS.HORS_VACANCES}|mardi`)
  assert.equal(r, undefined,
    'quarante-huit nuits mais DEUX reservations : aucun ratio ne doit sortir')
  // Et le mercredi, lui, a neuf reservations distinctes : son ratio existe.
  assert.ok(g.ratios_jour.get(`${R.SEGMENTS.HORS_VACANCES}|mercredi`),
    'le chemin PASSANT, pour qu un seuil de trop se voie')
})
