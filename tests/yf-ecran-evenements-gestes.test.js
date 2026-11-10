// tests/yf-ecran-evenements-gestes.test.js — LES GESTES de la page « Ce qui
// fait bouger vos prix » (lot 4, 4a, étape 3). Spec :
// docs/specs/spec-yf-ecran-evenements.md §4 (des dates aux positions), §5, §6,
// §7 (inventaire), §14 (réalisé).
//
// ⚠ LES GESTES SE JUGENT SUR LE VRAI RÉSOLVEUR, PAS SUR LEUR FORME. Les tests
// purs ne vérifient pas « telle liste d'opérations » : ils appliquent les
// opérations aux lignes par l'outil du SERVEUR (`lignesApres`, celui de la
// simulation), réassemblent l'écran avec ces lignes, et regardent ce que dit
// chaque nuit — la choisie ET les autres. C'est le seul juge qui ne recopie pas
// la règle qu'il contrôle.
//
// ⚠ DATES FIGÉES : l'assemblée reçoit `aujourdHui` (banc), et la page ne lit
// pas l'horloge pour ce qu'elle écrit.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { reponseEcran, monter, materiauxDuBanc, NOEL } = require('./outils/banc-evenements')
const { lignesApres, cleDePosition: cleServeur } = require('../lib/yield/simuler-positions')
const { validerPosition } = require('../lib/yield/reglages-position')
const P = require('../lib/yield/positions')

const RENDU = path.join(__dirname, '..', 'shared/yield-evenements-rendu.js')
const ligne = (id, p, niveau) => ({ id, evenement: NOEL, zone: p.zone, rang: p.rang ?? null, jour: p.jour ?? null, nuit: p.nuit ?? null, niveau })

// Noël 2026 (zone C) : du samedi 19 décembre au dimanche 3 janvier, 16 nuits.
// Avant : le 1er week-end n'a que le vendredi 18 ; le 2e, le 11 et le 12.
const VEN_11 = '2026-12-11'
const SAM_12 = '2026-12-12'
const VEN_18 = '2026-12-18'
const SAM_19 = '2026-12-19'
const DIM_20 = '2026-12-20'

async function noelDe (lignes = []) {
  const d = await reponseEcran({ lignes })
  return { d, e: d.evenements.find(x => x.cle === NOEL) }
}

// LE SCÉNARIO : ce qu'un hôte peut avoir posé, y compris ce que l'écran ne
// pose plus lui-même (« toutes les nuits » sans rang : une recette en SQL).
async function scenario () {
  const { e } = await noelDe()
  const pos = new Map(e.positions.map(p => [p.date, p]))
  return [
    { id: 'we-2', evenement: NOEL, zone: 'avant', rang: 2, jour: null, nuit: null, niveau: 'Haut' },
    ligne('sam-12', pos.get(SAM_12), 'Moyen'),
    ligne('sam-19', pos.get(SAM_19), 'Exceptionnel'),
    { id: 'tout', evenement: NOEL, zone: 'evenement', rang: null, jour: null, nuit: null, niveau: 'Très haut' },
    ligne('dim-20', pos.get(DIM_20), 'calcul')
  ]
}

// Ce que dit chaque nuit de la fenêtre APRÈS le geste : le réglage qui la tient.
async function apres (lignes, ops) {
  const proposees = lignesApres(lignes, ops)
  const d = await reponseEcran({ lignes: proposees })
  return new Map(d.nuits.map(n => [n.date, n.regle ? { niveau: n.regle.niveau, cle: n.regle.cle } : null]))
}
async function avant (lignes) { return apres(lignes, []) }

function memesAilleurs (a, b, choix) {
  for (const [date, r] of a) {
    if (choix.has(date)) continue
    assert.deepEqual(b.get(date), r, `${date} n'était pas choisie et a changé`)
  }
}

test('le navigateur parle la langue du serveur : même clé de position, même borne par geste, même « au calcul »', async () => {
  const r = await import(RENDU)
  const exemples = [
    { evenement: NOEL, zone: 'avant', rang: 2, jour: null, nuit: null },
    { evenement: NOEL, zone: 'avant', rang: '2', jour: 'samedi', nuit: '' },
    { evenement: 'ferie:noel', zone: 'evenement', rang: null, jour: null, nuit: 'date' },
    { evenement: NOEL, zone: 'evenement', rang: undefined, jour: undefined, nuit: undefined }
  ]
  for (const p of exemples) assert.equal(r.cleDePosition(p), cleServeur(p))
  const api = fs.readFileSync(path.join(__dirname, '..', 'api/yield-evenements.js'), 'utf8')
  assert.equal(r.POSITIONS_PAR_GESTE, Number(api.match(/const POSITIONS_PAR_GESTE = (\d+)/)[1]))
  assert.equal(r.CALCUL, P.CALCUL)
})

test('LE TEST QUI COMPTE : la couverture de chaque nuit commence par la ligne que le résolveur retient', async () => {
  const lignes = await scenario()
  const { d, e } = await noelDe(lignes)
  const regle = new Map(d.nuits.map(n => [n.date, n.regle]))
  let vues = 0
  for (const p of e.positions) {
    const r = regle.get(p.date)
    // Une nuit tenue par un AUTRE événement : si Noël la couvre aussi, c'est
    // que l'autre passe avant — et la position le dit (`devant`).
    if (r && r.cle !== NOEL) { if ((p.lignes || []).length) assert.equal(p.devant, r.cle, `${p.date} : tenue ailleurs sans « devant »`); continue }
    if (!r) { assert.ok(!(p.lignes || []).length, `${p.date} : couverte sans être réglée`); continue }
    assert.equal(p.lignes[0], r.ligne, `${p.date} : la première ligne de la couverture n'est pas celle du résolveur`)
    vues++
  }
  assert.ok(vues >= 18, `${vues} nuits contrôlées`)
  // Une ligne plus large suit, dans l'ordre : le samedi 12, puis son week-end.
  assert.deepEqual(e.positions.find(p => p.date === SAM_12).lignes, ['sam-12', 'we-2'])
  assert.deepEqual(e.positions.find(p => p.date === SAM_19).lignes, ['sam-19', 'tout'])
  // ⚠ Une ligne du rayonnement SANS RANG n'agit pas (elle part en `rang_requis`) :
  // elle ne couvre rien.
  const { e: e2 } = await noelDe([{ id: 'sans-rang', evenement: NOEL, zone: 'avant', rang: null, jour: null, nuit: null, niveau: 'Haut' }])
  assert.ok(e2.positions.every(p => !p.lignes), 'une ligne sans rang ne couvre aucune nuit')
})

test('« tout l’événement » et « tout le rayonnement » : les nuits de l’événement, les week-ends de la zone AFFICHÉE', async () => {
  const r = await import(RENDU)
  const { e } = await noelDe()
  assert.deepEqual(r.selectionTout(e, 'evenement'), e.nuits)
  assert.deepEqual(r.selectionTout(e, 'rayonnement'), [], 'sans largeur posée, aucun week-end affiché')
  const large = { ...e, largeur: { avant: 2, apres: 1 } }
  assert.deepEqual(r.selectionTout(large, 'rayonnement').sort(), [VEN_11, SAM_12, VEN_18, '2027-01-08', '2027-01-09'].sort())
})

test('LE TEST QUI COMPTE (Q2, B) : « tout l’événement » + un niveau = une ligne PAR NUIT, jamais un joker — et chaque nuit le prend', async () => {
  const r = await import(RENDU)
  const lignes = await scenario()
  const { e } = await noelDe(lignes)
  const choix = new Set(r.selectionTout(e, 'evenement'))
  const ops = r.operationsPourNiveau(e, choix, 'Haut', lignes)
  assert.equal(ops.length, e.nuits.length)
  for (const o of ops) {
    assert.ok(o.rang != null || o.nuit != null, `un joker : ${JSON.stringify(o)}`)
    assert.ok(validerPosition(o).ok, `refusée par l'écrivain : ${JSON.stringify(o)}`)
  }
  const a = await avant(lignes)
  const b = await apres(lignes, ops)
  for (const date of choix) assert.deepEqual(b.get(date), { niveau: 'Haut', cle: NOEL }, date)
  memesAilleurs(a, b, choix)
})

test('LE TEST QUI COMPTE : un week-end ENTIER choisi = une ligne de week-end, et la ligne d’une de ses nuits se retire — sinon elle la battrait', async () => {
  const r = await import(RENDU)
  const lignes = await scenario()
  const { e } = await noelDe(lignes)
  const choix = new Set([VEN_11, SAM_12])
  const ops = r.operationsPourNiveau(e, choix, 'Base', lignes)
  assert.deepEqual(ops.map(o => [o.zone, o.rang, o.jour, o.niveau]).sort(), [['avant', 2, 'samedi', null], ['avant', 2, null, 'Base']].sort())
  const a = await avant(lignes)
  const b = await apres(lignes, ops)
  assert.deepEqual(b.get(VEN_11), { niveau: 'Base', cle: NOEL })
  assert.deepEqual(b.get(SAM_12), { niveau: 'Base', cle: NOEL }, 'le samedi garderait « Moyen » si sa ligne restait')
  memesAilleurs(a, b, choix)
  // ⚠ UN WEEK-END COUPÉ (le 1er avant n'a que le vendredi 18) s'écrit par sa
  // nuit : une ligne de week-end prendrait, une autre année, un samedi que
  // l'hôte n'a pas vu.
  const coupe = r.operationsPourNiveau(e, new Set([VEN_18]), 'Haut', lignes)
  assert.deepEqual(coupe.map(o => [o.zone, o.rang, o.jour]), [['avant', 1, 'vendredi']])
})

test('LE TEST QUI COMPTE : « Remettre en automatique » rend CHAQUE nuit choisie au calcul, et ne touche à aucune autre', async () => {
  const r = await import(RENDU)
  const lignes = await scenario()
  const { e } = await noelDe(lignes)
  const a = await avant(lignes)
  const cas = [
    // Le défaut que la couverture ferme : retirer la ligne du samedi 12
    // rendait la main à celle du week-end — la nuit restait « Haut ».
    { choix: [SAM_12], attendu: [['avant', 2, 'samedi', 'calcul']] },
    // Le week-end entier : sa ligne ET celle du samedi partent, aucune ligne « au calcul ».
    { choix: [VEN_11, SAM_12], attendu: [['avant', 2, null, null], ['avant', 2, 'samedi', null]] },
    // « toutes les nuits » tient les autres nuits : le 19 est rendu au calcul par SA position.
    { choix: [SAM_19], attendu: [['evenement', 1, 'samedi', 'calcul']] },
    // Tout l'événement : « toutes les nuits » part avec les lignes de nuit ;
    // le 20, déjà « au calcul », garde sa ligne.
    { choix: e.nuits, attendu: null }
  ]
  for (const c of cas) {
    const choix = new Set(c.choix)
    const ops = r.operationsPourRetrait(e, choix, lignes)
    if (c.attendu) assert.deepEqual(ops.map(o => [o.zone, o.rang, o.jour, o.niveau]).sort(), c.attendu.sort(), c.choix.join(' '))
    for (const o of ops) assert.ok(validerPosition(o, { retrait: o.niveau === null }).ok, JSON.stringify(o))
    const b = await apres(lignes, ops)
    for (const date of choix) {
      const x = b.get(date)
      assert.ok(x === null || x.niveau === 'calcul', `${date} reste réglée (${JSON.stringify(x)}) après « Remettre en automatique » sur ${c.choix.length} nuit(s)`)
    }
    memesAilleurs(a, b, choix)
  }
})

test('« Remettre en automatique » sur des nuits déjà au calcul ne demande rien ; retirer une ligne sans nuit vise CETTE ligne', async () => {
  const r = await import(RENDU)
  const lignes = await scenario()
  const { e } = await noelDe(lignes)
  assert.deepEqual(r.operationsPourRetrait(e, new Set([DIM_20]), lignes), [])
  const { e: libre } = await noelDe()
  assert.deepEqual(r.operationsPourRetrait(libre, new Set([SAM_19, DIM_20]), []), [])
  const l = { id: 'x', evenement: NOEL, zone: 'evenement', rang: 3, jour: 'lundi', nuit: null, niveau: 'Haut' }
  assert.deepEqual(r.operationsPourLigne(l), [{ evenement: NOEL, zone: 'evenement', rang: 3, jour: 'lundi', nuit: null, niveau: null }])
})

test('« chaque année » : sur une période dont une nuit est tenue par un réglage de l’hôte (ou des crans d’avant) — jamais pour une ligne qui n’agit pas', async () => {
  const r = await import(RENDU)
  const idxDe = d => r.indexerNuits(d.nuits)
  const { d, e } = await noelDe()
  assert.equal(r.porteUnReglage(e, idxDe(d)), false)
  const p = e.positions.find(x => x.date === SAM_19)
  const auCalcul = await noelDe([ligne('a', p, 'calcul')])
  assert.equal(r.porteUnReglage(auCalcul.e, idxDe(auCalcul.d)), false, 'une ligne « au calcul » seule')
  // ⚠ CONSTAT DE REVIEW : une ligne sans nuit cette année (« le 3e lundi »)
  // et une ligne `rang_requis` ne règlent aucune nuit.
  const inertes = await noelDe([
    { id: 'l3', evenement: NOEL, zone: 'evenement', rang: 3, jour: 'lundi', nuit: null, niveau: 'Haut' },
    { id: 'sr', evenement: NOEL, zone: 'avant', rang: null, jour: null, nuit: null, niveau: 'Haut' }
  ])
  assert.equal(r.porteUnReglage(inertes.e, idxDe(inertes.d)), false, 'des lignes qui n’agissent pas')
  const regle = await noelDe([ligne('a', p, 'Haut')])
  assert.equal(r.porteUnReglage(regle.e, idxDe(regle.d)), true)
  assert.equal(r.porteUnReglage({ ...e, reglage_d_avant: { crans: 1, cle: NOEL, partage: false } }, idxDe(d)), true)
})

const REVEILLON = 'commercial:reveillon_noel'
const JEU_24 = '2026-12-24'

test('LE TEST QUI COMPTE (review) : deux événements sur une nuit — le serveur dit qui la reprendrait (`relais`) et qui passe avant (`devant`)', async () => {
  const { e: noel0 } = await noelDe()
  const p24 = noel0.positions.find(p => p.date === JEU_24)
  const d = await reponseEcran({ lignes: [
    { id: 'rev', evenement: REVEILLON, zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: 'Exceptionnel' },
    ligne('noel-24', p24, 'Haut')
  ] })
  const noel = d.evenements.find(x => x.cle === NOEL)
  const rev = d.evenements.find(x => x.cle === REVEILLON)
  assert.equal(noel.positions.find(p => p.date === JEU_24).devant, REVEILLON, 'le réveillon passe avant les vacances')
  assert.deepEqual(rev.positions.find(p => p.date === JEU_24).relais, { niveau: 'Haut', cle: NOEL }, 'sans le réveillon, Noël reprend le 24')
  assert.equal(rev.positions.find(p => p.date === JEU_24).devant, undefined)
  // Sans réglage ailleurs, rien n'est dit.
  const { e: seul } = await noelDe([ligne('noel-24', p24, 'Haut')])
  assert.ok(seul.positions.every(p => !p.devant && !p.relais))
})

test('LE TEST QUI COMPTE : `relais` et `devant` sont ceux de `positionsDuContexte` sur toute la matière — les raccourcis de l’assemblée ne changent rien', async () => {
  // L'assemblée résout seulement ce qui est inconnu, sur les seules dates
  // utiles, avec les occurrences calculées une fois (mesure : 24 résolutions
  // et 148 ms ramenées à 6 ms). Le juge, ici, est la version sans raccourci.
  const { e: noel0 } = await noelDe()
  const p24 = noel0.positions.find(p => p.date === JEU_24)
  const octobre = { id: 'ev-salon-2', nom: 'Salon du chocolat', segment: 'evenement:salon_du_chocolat', date_debut: '2027-10-14', date_fin: '2027-10-17' }
  const lignes = [
    { id: 'rev', evenement: REVEILLON, zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: 'Exceptionnel' },
    ligne('noel-24', p24, 'Haut'),
    { id: 'we-2', evenement: NOEL, zone: 'avant', rang: 2, jour: null, nuit: null, niveau: 'Moyen' },
    { id: 'f25', evenement: 'ferie:noel', zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: 'calcul' },
    { id: 'salon', evenement: 'evenement:salon_du_chocolat', zone: 'evenement', rang: null, jour: null, nuit: null, niveau: 'Haut' }
  ]
  const o = { lignes, evenementsEnPlus: [octobre] }
  const d = await reponseEcran(o)
  const m = materiauxDuBanc(o)
  const ref = ls => P.positionsDuContexte({ ...m, lignes: ls }).parNuit
  const parNuit = ref(lignes)
  const dansLaFenetre = new Set(d.nuits.map(n => n.date))
  let compares = 0
  for (const cle of new Set(d.evenements.filter(e => e.positions.length).map(e => e.cle))) {
    const occs = d.evenements.filter(e => e.cle === cle)
    const autres = lignes.filter(l => l.evenement !== cle)
    const sans = ref(autres)
    const auCalcul = new Map()
    for (const e of occs) for (const p of e.positions) auCalcul.set(`${p.zone}|${p.rang}|${p.jour}|${p.nuit}`, { id: `h:${p.date}`, evenement: cle, zone: p.zone, rang: p.rang ?? null, jour: p.jour ?? null, nuit: p.nuit ?? null, niveau: 'calcul' })
    const devant = ref([...autres, ...auCalcul.values()])
    for (const e of occs) {
      for (const p of e.positions) {
        if (!dansLaFenetre.has(p.date)) continue
        const s = sans.get(p.date)
        const v = devant.get(p.date)
        const attenduRelais = s && s.cle !== cle && s.niveau !== 'calcul' ? { niveau: s.niveau, cle: s.cle } : undefined
        const attenduDevant = v && v.cle !== cle ? v.cle : undefined
        assert.deepEqual(p.relais, attenduRelais, `${cle} ${p.date} : relais`)
        assert.equal(p.devant, attenduDevant, `${cle} ${p.date} : devant`)
        compares++
      }
    }
  }
  assert.ok(compares > 300, `${compares} positions comparées`)
  assert.ok(parNuit.size)
})

test('LE TEST QUI COMPTE (review) : « Remettre en automatique » depuis le réveillon rend le 24 au CALCUL — pas aux vacances de Noël', async () => {
  const r = await import(RENDU)
  const { e: noel0 } = await noelDe()
  const p24 = noel0.positions.find(p => p.date === JEU_24)
  const cas = [
    // Le réveillon et Noël règlent le 24 : retirer celui du réveillon le donnait à Noël.
    [{ id: 'rev', evenement: REVEILLON, zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: 'Exceptionnel' }, ligne('noel-24', p24, 'Haut')],
    // Seul Noël règle le 24 : la page disait « déjà en automatique ».
    [ligne('noel-24', p24, 'Haut')]
  ]
  for (const lignes of cas) {
    const d = await reponseEcran({ lignes })
    const rev = d.evenements.find(x => x.cle === REVEILLON)
    const choix = new Set([JEU_24])
    const ops = r.operationsPourRetrait(rev, choix, lignes)
    assert.deepEqual(ops, [{ evenement: REVEILLON, zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: 'calcul' }])
    const a = await avant(lignes)
    const b = await apres(lignes, ops)
    assert.equal(b.get(JEU_24).niveau, 'calcul', `le 24 reste réglé : ${JSON.stringify(b.get(JEU_24))}`)
    memesAilleurs(a, b, choix)
  }
})

test('LE TEST QUI COMPTE (review) : depuis Noël, le 24 tenu par le réveillon est NOMMÉ — rien de ce qu’on pose ici ne s’y applique', async () => {
  const r = await import(RENDU)
  const { e: noel0 } = await noelDe()
  const p24 = noel0.positions.find(p => p.date === JEU_24)
  const lignes = [{ id: 'rev', evenement: REVEILLON, zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: 'Exceptionnel' }]
  const d = await reponseEcran({ lignes })
  const noel = d.evenements.find(x => x.cle === NOEL)
  assert.deepEqual(r.nuitsTenuesAilleurs(noel, new Set([JEU_24, SAM_19]), r.indexerNuits(d.nuits)), [{ date: JEU_24, cle: REVEILLON, auCalcul: false }])
  // Tenue « au calcul » par le réveillon, la nuit est déjà en automatique : la page le sait.
  const auCalcul = await reponseEcran({ lignes: [{ ...lignes[0], niveau: 'calcul' }] })
  const noelC = auCalcul.evenements.find(x => x.cle === NOEL)
  assert.deepEqual(r.nuitsTenuesAilleurs(noelC, new Set([JEU_24]), r.indexerNuits(auCalcul.nuits)), [{ date: JEU_24, cle: REVEILLON, auCalcul: true }])
  assert.deepEqual(r.operationsPourRetrait(noel, new Set([JEU_24]), lignes), [], 'rien à écrire ici')
  // Et un niveau posé depuis Noël n'y change rien (la page l'a dit avant).
  const ops = r.operationsPourNiveau(noel, new Set([JEU_24]), 'Base', lignes)
  const b = await apres(lignes, ops)
  assert.deepEqual(b.get(JEU_24), { niveau: 'Exceptionnel', cle: REVEILLON })
  void p24
})

test('LE TEST QUI COMPTE (review) : une ligne LARGE ne se retire jamais — elle décide d’autres nuits, une autre occurrence ou une autre année', async () => {
  const r = await import(RENDU)
  // Le Salon du chocolat, déclaré deux fois dans la fenêtre : 19-21 mars et
  // 14-17 octobre 2027. Le jeudi d'octobre n'a pas de position en mars.
  const SALON = 'evenement:salon_du_chocolat'
  const octobre = { id: 'ev-salon-2', nom: 'Salon du chocolat', segment: SALON, date_debut: '2027-10-14', date_fin: '2027-10-17' }
  const lignes = [{ id: 'tout', evenement: SALON, zone: 'evenement', rang: null, jour: null, nuit: null, niveau: 'Haut' }]
  const d = await reponseEcran({ lignes, evenementsEnPlus: [octobre] })
  const mars = d.evenements.find(x => x.cle === SALON && x.debut === '2027-03-19')
  const choix = new Set(r.selectionTout(mars, 'evenement'))
  const ops = r.operationsPourRetrait(mars, choix, lignes)
  assert.ok(ops.every(o => o.niveau === 'calcul' && o.rang != null), `une ligne large retirée : ${JSON.stringify(ops)}`)
  const proposees = lignesApres(lignes, ops)
  const avantN = new Map((await reponseEcran({ lignes, evenementsEnPlus: [octobre] })).nuits.map(n => [n.date, n.regle && n.regle.niveau]))
  const apresN = new Map((await reponseEcran({ lignes: proposees, evenementsEnPlus: [octobre] })).nuits.map(n => [n.date, n.regle && n.regle.niveau]))
  for (const date of choix) assert.equal(apresN.get(date), 'calcul', date)
  // ⚠ UNE POSITION VAUT POUR TOUTES LES OCCURRENCES (Q2, B) : le 1er vendredi,
  // samedi et dimanche d'octobre SONT les positions choisies en mars — ils
  // suivent. Le jeudi 14, position qu'aucune nuit de mars ne porte, garde le
  // niveau de la ligne large : c'est lui que la review a vu tomber.
  for (const date of ['2027-10-15', '2027-10-16', '2027-10-17']) assert.equal(apresN.get(date), 'calcul', `${date} : même position qu'en mars`)
  assert.equal(avantN.get('2027-10-14'), 'Haut')
  assert.equal(apresN.get('2027-10-14'), 'Haut', 'le jeudi d’octobre, jamais choisi, a perdu son niveau')
  // ⚠ LE WEEK-END COUPÉ : la ligne de week-end vaut aussi pour le samedi des
  // années où il est entier — choisir le seul vendredi la masque, sans la retirer.
  const we = [{ id: 'we-1', evenement: NOEL, zone: 'avant', rang: 1, jour: null, nuit: null, niveau: 'Haut' }]
  const { e } = await noelDe(we)
  assert.deepEqual(r.operationsPourRetrait(e, new Set([VEN_18]), we).map(o => [o.zone, o.rang, o.jour, o.niveau]), [['avant', 1, 'vendredi', 'calcul']])
})

// ─── La page ────────────────────────────────────────────────────────────────

const ouvrirNoel = async (b) => b.cliquer(b.$$('.yfe-barre').find(x => x.dataset.ouvrir.startsWith(NOEL + '|')))
const nuitDe = (b, date) => b.$$('.yfe-ev--ouvert [data-nuit]').find(j => j.dataset.nuit === date)
const ecritures = (b) => b.journal.fetch.filter(f => f.url === '/api/yield-evenements')
const lectures = (b) => b.journal.fetch.filter(f => f.url.startsWith('/api/ecran/evenements'))
const CONF = { pilote: true, nuits: 2, du: SAM_19, au: DIM_20, min: 140, max: 155 }

test('LE TEST QUI COMPTE (masquage + garde) : sans droit d’écriture, aucun geste — toucher une nuit en montre le détail', async () => {
  const d = await reponseEcran()
  const b = await monter({ ecran: async () => ({ ...d, droits_ecriture: false }) })
  await ouvrirNoel(b)
  for (const s of ['[data-niveau]', '[data-tout]', '[data-largeur]', '[data-auto]', '[data-retirer-ligne]', '[data-crans-retirer]']) {
    assert.equal(b.$(s), null, `${s} visible sans droit`)
  }
  await b.cliquer(nuitDe(b, SAM_19))
  assert.equal(nuitDe(b, SAM_19).getAttribute('aria-pressed'), 'true')
  assert.ok(b.$('.yfe-ev--ouvert .yfe-detail'))
  assert.equal(b.$('.yfe-editeur'), null)
  assert.equal(ecritures(b).length, 0)
})

test('LE TEST QUI COMPTE : depuis le cache, l’événement ouvert ne porte aucun geste ; la réponse fraîche les rend', async () => {
  const r = await import(RENDU)
  const d = await reponseEcran()
  const noel = d.evenements.find(e => e.cle === NOEL)
  const id = r.idEvenement(noel)
  let gestesPendantLeCache = null
  const b = await monter({
    cache: r.pourLeCache(d),
    ecran: async (url, w) => {
      // La page a peint le cache ; on ouvre Noël AVANT la réponse.
      const barre = [...w.document.querySelectorAll('.yfe-barre')].find(x => x.dataset.ouvrir === id)
      barre.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
      gestesPendantLeCache = !!w.document.querySelector('.yfe-ev--ouvert [data-tout], .yfe-ev--ouvert [data-largeur]')
      return d
    }
  })
  assert.equal(gestesPendantLeCache, false, 'un geste offert sur un écran du cache')
  assert.ok(b.$('.yfe-ev--ouvert [data-tout="evenement"]'), 'la réponse fraîche rend les gestes')
})

test('LE TEST QUI COMPTE (spec §4) : choisir, régler, CONFIRMER — « N nuits vont changer de prix », puis le nombre renvoyé, puis l’écran relu', async () => {
  const d = await reponseEcran()
  const noel = d.evenements.find(e => e.cle === NOEL)
  const pos = new Map(noel.positions.map(p => [p.date, p]))
  const corps = []
  const b = await monter({
    compteDelegue: true,
    ecran: async () => d,
    ecriture: async (methode, c) => {
      corps.push({ methode, c })
      if (c.simuler) return { corps: { simulation: true, confirmation: CONF, visees: {}, sans_nuit: [], hors_zone: [] } }
      return { corps: { ok: true, ecrites: [], envoi: 'immediat', confirmation: CONF } }
    }
  })
  await ouvrirNoel(b)
  await b.cliquer(nuitDe(b, SAM_19))
  await b.cliquer(nuitDe(b, DIM_20))
  assert.equal(nuitDe(b, SAM_19).getAttribute('aria-pressed'), 'true')
  assert.match(b.$('.yfe-editeur').textContent, /2 nuits/)
  // Les cinq pastilles, chiffre et prix écrits (règle 2).
  const pastilles = b.$$('.yfe-editeur [data-niveau]')
  assert.equal(pastilles.length, 5)
  assert.match(pastilles[2].textContent, /3 · Haut/)
  assert.equal(ecritures(b).length, 0, 'choisir ne coûte aucun appel')

  await b.cliquer(pastilles[2])
  await b.attendre()
  const sim = corps[0]
  assert.equal(sim.methode, 'PUT')
  assert.equal(sim.c.simuler, true)
  assert.equal(sim.c.bien, d.bien)
  assert.deepEqual(sim.c.positions, [SAM_19, DIM_20].map(x => ({ evenement: NOEL, zone: 'evenement', rang: pos.get(x).rang, jour: pos.get(x).jour, nuit: null, niveau: 'Haut' })))
  assert.equal(ecritures(b)[0].entetes['X-Compte'], b.COMPTE, 'le compte délégué voyage avec le geste')
  const zone = b.$('.yfe-editeur .yfe-geste')
  assert.match(zone.textContent, /2 nuits vont changer de prix/)
  assert.match(zone.textContent, /dans les 5 minutes/)
  assert.equal(b.w.document.activeElement, b.$('[data-geste-appliquer]'), 'le focus va à « Appliquer »')

  const avantRelecture = lectures(b).length
  await b.cliquer(b.$('[data-geste-appliquer]'))
  await b.attendre(6)
  assert.equal(corps[1].c.simuler, undefined)
  assert.deepEqual(corps[1].c.confirme, { nuits: 2 })
  assert.deepEqual(corps[1].c.positions, sim.c.positions, 'on confirme ce qu’on a montré')
  assert.equal(lectures(b).length, avantRelecture + 1, 'l’écran se relit après le geste')
  assert.match(b.$('.yfe-ev--ouvert .yfe-message').textContent, /Enregistré\. YieldFlow enverra/)
  assert.equal(b.$('.yfe-editeur'), null, 'le choix est vidé')
})

test('LE TEST QUI COMPTE : le nombre a changé entre l’annonce et le clic (409) — la page redemande avec le NOUVEAU nombre', async () => {
  const d = await reponseEcran()
  const corps = []
  let tour = 0
  const b = await monter({
    ecran: async () => d,
    ecriture: async (methode, c) => {
      corps.push(c)
      if (c.simuler) return { corps: { simulation: true, confirmation: CONF, visees: {}, sans_nuit: [] } }
      tour++
      if (tour === 1) return { status: 409, corps: { error: 'a_confirmer', confirmation: { ...CONF, nuits: 3, au: '2026-12-21' }, visees: {}, sans_nuit: [] } }
      return { corps: { ok: true, ecrites: [], envoi: 'immediat', confirmation: { ...CONF, nuits: 3 } } }
    }
  })
  await ouvrirNoel(b)
  await b.cliquer(nuitDe(b, SAM_19))
  await b.cliquer(b.$('[data-niveau="Haut"]'))
  await b.attendre()
  await b.cliquer(b.$('[data-geste-appliquer]'))
  await b.attendre()
  assert.match(b.$('.yfe-geste').textContent, /a changé depuis l’annonce/)
  assert.match(b.$('.yfe-geste').textContent, /3 nuits vont changer de prix/)
  await b.cliquer(b.$('[data-geste-appliquer]'))
  await b.attendre(6)
  assert.deepEqual(corps.map(c => c.confirme && c.confirme.nuits).filter(Boolean), [2, 3])
})

test('un bien non piloté : la confirmation ne parle d’aucun envoi aux plateformes ; une ouverture illisible ne promet rien', async () => {
  const r = await import(RENDU)
  const f = { t: k => k, money: n => `${n} €`, date: () => 'x' }
  assert.deepEqual(r.effetDuGeste({ confirmation: { pilote: false, nuits: 0 } }, f), ['yfe.effet_non_pilote'])
  assert.deepEqual(r.effetDuGeste({ confirmation: { pilote: true, ouverture_inconnue: true, nuits: 0 } }, f), ['yfe.effet_ouverture_inconnue'])
  assert.deepEqual(r.effetDuGeste({ confirmation: { pilote: true, nuits: 0 } }, f), ['yfe.effet_aucune'])
  assert.ok(r.effetDuGeste({ confirmation: CONF }, f).includes('yfe.effet_envoi'))
  assert.equal(r.phraseEnregistre({ confirmation: { pilote: false, nuits: 4 }, envoi: 'immediat' }, f), 'yfe.enregistre')
  assert.equal(r.phraseEnregistre({ confirmation: CONF, envoi: 'passage_quotidien' }, f), 'yfe.enregistre_quotidien')
  assert.equal(r.phraseEnregistre({ confirmation: CONF, envoi: 'immediat' }, f), 'yfe.enregistre_5min')
})

test('LE TEST QUI COMPTE : rien à remettre en automatique = aucun appel ; un refus, une panne, un arrêt en route se DISENT', async () => {
  const d = await reponseEcran()
  let reponse = null
  const b = await monter({ ecran: async () => d, ecriture: async (m, c) => reponse(m, c) })
  await ouvrirNoel(b)
  await b.cliquer(nuitDe(b, SAM_19))
  await b.cliquer(b.$('[data-auto]'))
  assert.match(b.$('.yfe-geste').textContent, /déjà en automatique/)
  assert.equal(ecritures(b).length, 0)

  reponse = async () => ({ status: 403, corps: { error: 'permission_refusee' } })
  await b.cliquer(b.$('[data-niveau="Haut"]'))
  await b.attendre()
  assert.match(b.$('.yfe-geste').textContent, /pas le droit/)

  reponse = async () => { throw new TypeError('Failed to fetch') }
  await b.cliquer(b.$('[data-geste-annuler]'))
  await b.cliquer(b.$('[data-niveau="Haut"]'))
  await b.attendre()
  assert.match(b.$('.yfe-geste').textContent, /n’a pas répondu/)

  // ⚠ ARRÊTÉ EN ROUTE : ce qui est écrit se dit, et l'écran se relit.
  reponse = async (m, c) => (c && c.simuler
    ? { corps: { simulation: true, confirmation: CONF, visees: {}, sans_nuit: [] } }
    : { status: 503, corps: { error: 'ecriture_impossible', ecrites: [{ position: 'x' }], confirmation: CONF } })
  await b.cliquer(b.$('[data-geste-annuler]'))
  await b.cliquer(b.$('[data-niveau="Haut"]'))
  await b.attendre()
  const lu = lectures(b).length
  await b.cliquer(b.$('[data-geste-appliquer]'))
  await b.attendre(6)
  assert.match(b.$('.yfe-ev--ouvert').textContent, /1 réglage a été écrit/)
  assert.equal(lectures(b).length, lu + 1)
})

test('LE TEST QUI COMPTE : un geste en vol bloque les autres — un seul geste à la fois', async () => {
  const d = await reponseEcran()
  let relache
  const b = await monter({
    ecran: async () => d,
    ecriture: async () => { await new Promise(res => { relache = res }); return { corps: { simulation: true, confirmation: CONF, visees: {}, sans_nuit: [] } } }
  })
  await ouvrirNoel(b)
  await b.cliquer(nuitDe(b, SAM_19))
  await b.cliquer(b.$('[data-niveau="Haut"]'))
  assert.ok(b.$$('.yfe-editeur [data-niveau]').every(x => x.disabled), 'les pastilles restent cliquables pendant le calcul')
  assert.ok(b.$('[data-largeur][data-pas="1"]').disabled)
  await b.cliquer(b.$('[data-niveau="Base"]'))
  assert.equal(ecritures(b).length, 1, 'un second geste est parti')
  relache()
  await b.attendre(6)
  assert.ok(b.$('[data-geste-appliquer]'))
})

test('LE TEST QUI COMPTE : la zone + / − écrit la LARGEUR de l’événement (PATCH, sans confirmation), bornée de 0 à 4', async () => {
  const d = await reponseEcran()
  const corps = []
  const b = await monter({ ecran: async () => d, ecriture: async (methode, c) => { corps.push({ methode, c }); return { corps: { reglage: {} } } } })
  await ouvrirNoel(b)
  assert.equal(b.$('[data-tout="rayonnement"]'), null, 'sans zone affichée, pas de « tout le rayonnement »')
  assert.ok(b.$('[data-largeur="avant"][data-pas="-1"]').disabled, '0 ne descend pas')
  await b.cliquer(b.$('[data-largeur="avant"][data-pas="1"]'))
  await b.attendre(6)
  assert.deepEqual(corps[0], { methode: 'PATCH', c: { bien: d.bien, segment: NOEL, weekends_avant: 1 } })
  const large = await reponseEcran({ reglages: new Map([[NOEL, { segment: NOEL, actif: true, crans: null, weekends_avant: 4, weekends_apres: 2 }]]) })
  const b2 = await monter({ ecran: async () => large, ecriture: async () => ({ corps: {} }) })
  await ouvrirNoel(b2)
  assert.ok(b2.$('[data-largeur="avant"][data-pas="1"]').disabled, '4 ne monte pas')
  await b2.cliquer(b2.$('[data-tout="rayonnement"]'))
  assert.equal(b2.$$('.yfe-ev--ouvert [data-nuit][aria-pressed="true"]').length, 7 + 4, 'les week-ends affichés : 4 avant (7 nuits), 2 après (4 nuits)')
})

test('LE TEST QUI COMPTE (Q6) : les crans d’avant se retirent après CONFIRMATION — et un réglage commun le dit', async () => {
  const reglages = new Map([['week_end_prolonge', { segment: 'week_end_prolonge', crans: 1, actif: true }], [NOEL, { segment: NOEL, crans: -1, actif: true }]])
  const d = await reponseEcran({ reglages })
  const corps = []
  const b = await monter({ ecran: async () => d, ecriture: async (methode, c) => { corps.push({ methode, c }); return { corps: { reglage: {} } } } })
  await ouvrirNoel(b)
  assert.match(b.$('.yfe-ev--ouvert .yfe-ev__tete').textContent, /chaque année/)
  await b.cliquer(b.$('[data-crans-retirer]'))
  assert.equal(corps.length, 0, 'le premier clic ne retire rien')
  assert.match(b.$('.yfe-ev--ouvert').textContent, /reprendront le niveau calculé/)
  await b.cliquer(b.$('[data-crans-confirmer]'))
  await b.attendre(6)
  assert.deepEqual(corps[0], { methode: 'PATCH', c: { bien: d.bien, segment: NOEL, crans: null } })
  assert.match(b.$('.yfe-ev--ouvert .yfe-message').textContent, /Enregistré/)
  // Le réglage commun à tous les week-ends prolongés.
  const wep = d.evenements.find(e => e.type === 'week_end_prolonge' && e.reglage_d_avant)
  const b2 = await monter({ ecran: async () => d, ecriture: async () => ({ corps: {} }) })
  await b2.cliquer(b2.$$('.yfe-barre').find(x => x.dataset.ouvrir === `${wep.cle}|${wep.debut}`))
  await b2.cliquer(b2.$('[data-crans-retirer]'))
  assert.match(b2.$('.yfe-ev--ouvert').textContent, /commun à toutes les périodes de ce type/)
})

test('LE TEST QUI COMPTE (spec §5) : une ligne sans nuit se retire par son bouton — le geste vise CETTE ligne, confirmé comme les autres', async () => {
  const lignes = [{ id: 'l-lundi', evenement: NOEL, zone: 'evenement', rang: 3, jour: 'lundi', nuit: null, niveau: 'Haut' }]
  const d = await reponseEcran({ lignes })
  const corps = []
  const b = await monter({
    ecran: async () => d,
    ecriture: async (m, c) => { corps.push(c); return { corps: c.simuler ? { simulation: true, confirmation: { pilote: false, nuits: 0 }, visees: {}, sans_nuit: [] } : { ok: true, ecrites: [], envoi: 'immediat', confirmation: { pilote: false } } } }
  })
  await ouvrirNoel(b)
  const bouton = b.$('.yfe-ev--ouvert [data-retirer-ligne="l-lundi"]')
  assert.ok(bouton, 'le « 3e lundi » qui n’existe pas cette année porte son bouton')
  await b.cliquer(bouton)
  await b.attendre()
  assert.deepEqual(corps[0].positions, [{ evenement: NOEL, zone: 'evenement', rang: 3, jour: 'lundi', nuit: null, niveau: null }])
  assert.match(b.$('.yfe-ev--ouvert .yfe-geste').textContent, /pas piloté/)
  await b.cliquer(b.$('[data-geste-appliquer]'))
  await b.attendre(6)
  assert.deepEqual(corps[1].confirme, { nuits: 0 })
})

test('LE TEST QUI COMPTE : un geste ne survit pas à un changement de logement — sa confirmation ne s’affiche jamais sous l’autre', async () => {
  // ⚠ PLUSIEURS GARDES, ET LE TEST LES ÉPROUVE ENSEMBLE : la réponse tardive
  // est ignorée (`toujours`), et changer de logement comme ouvrir un événement
  // oublient le geste ET le choix (`oublierGestes`). Une seule ôtée ne se voit
  // pas — c'est voulu : le geste emporte `bien`, et une confirmation sous un
  // autre nom écrirait sur le premier. Contre-épreuve : `toujours` toujours
  // vrai et `oublierGestes` vidé, il rougit (spec §14).
  const d = await reponseEcran()
  const autre = { ...d, bien: d.biens[1].id }
  let relache
  const corps = []
  const b = await monter({
    ecran: async (url) => (url.includes(d.biens[1].id) ? autre : d),
    ecriture: async (m, c) => { corps.push(c); await new Promise(res => { relache = res }); return { corps: { simulation: true, confirmation: CONF, visees: {}, sans_nuit: [] } } }
  })
  await ouvrirNoel(b)
  await b.cliquer(nuitDe(b, SAM_19))
  await b.cliquer(b.$('[data-niveau="Haut"]'))
  await b.choisir(b.$('[data-bind="bien"]'), d.biens[1].id)
  relache()
  await b.attendre(6)
  await ouvrirNoel(b)
  assert.equal(b.$('[data-geste-appliquer]'), null, 'la confirmation du premier logement s’affiche sous le second')
  assert.equal(corps.length, 1)
})

test('LE TEST QUI COMPTE : après un geste enregistré, si la relecture échoue, plus aucun geste ne part sur les lignes d’avant', async () => {
  const d = await reponseEcran()
  let lectures = 0
  const b = await monter({
    ecran: async () => { lectures++; if (lectures > 1) { const e = new Error('panne'); e.status = 500; throw e } return d },
    ecriture: async (m, c) => ({ corps: c.simuler ? { simulation: true, confirmation: CONF, visees: {}, sans_nuit: [] } : { ok: true, ecrites: [], envoi: 'immediat', confirmation: CONF } })
  })
  await ouvrirNoel(b)
  await b.cliquer(nuitDe(b, SAM_19))
  await b.cliquer(b.$('[data-niveau="Haut"]'))
  await b.attendre()
  await b.cliquer(b.$('[data-geste-appliquer]'))
  await b.attendre(6)
  assert.equal(lectures, 2)
  assert.match(b.$('[data-bind="age"]').textContent, /mise à jour n’a pas pu se faire/)
  assert.equal(b.$('.yfe-ev--ouvert [data-tout]'), null, 'un geste offert sur un écran qui ignore le précédent')
  assert.match(b.$('.yfe-ev--ouvert .yfe-message').textContent, /Enregistré/, 'ce qui est écrit reste dit')
})

test('LE TEST QUI COMPTE (review, sécurité) : pendant un changement de logement, l’écran de l’ancien n’offre AUCUN geste — et rien ne s’écrit', async () => {
  // Le scénario mesuré par la review : la réponse du nouveau logement tarde,
  // la frise de l'ancien reste peinte, on y ouvre Noël et on règle — le PUT
  // partait sur l'ancien, puis « Appliquer » restait offert sous le nouveau nom.
  // ⚠ QUATRE GARDES ENSEMBLE : l'écran de l'ancien ne se repeint plus pendant
  // le changement (re-review), rien ne s'y ouvre, rien ne s'y règle
  // (`changementEnCours`), et la réponse d'un autre logement oublie tout
  // (`recevoir`). Contre-épreuve : les quatre ôtées, il rougit.
  const d = await reponseEcran()
  const autre = { ...d, bien: d.biens[1].id }
  let relache
  const b = await monter({
    ecran: async (url) => {
      if (!url.includes(d.biens[1].id)) return d
      await new Promise(res => { relache = res })
      return autre
    },
    ecriture: async () => ({ corps: { simulation: true, confirmation: CONF, visees: {}, sans_nuit: [] } })
  })
  // Noël est OUVERT sur l'ancien logement quand on change.
  await ouvrirNoel(b)
  const barreNoel = b.$$('.yfe-barre').find(x => x.dataset.ouvrir.startsWith(NOEL + '|'))
  await b.choisir(b.$('[data-bind="bien"]'), d.biens[1].id)
  assert.equal(b.$$('.yfe-barre').length, 0, 'la frise de l’ancien logement reste peinte pendant le changement')
  // Un repeint pendant l'attente (un filtre touché) : rien de l'ancien ne revient,
  // et le sélecteur garde le logement DEMANDÉ.
  b.$('[data-bind="filtres"]').hidden = false
  await b.cliquer(b.$('[data-filtre="officiel"]'))
  assert.equal(b.$$('.yfe-ev').length, 0, 'un repeint pendant le changement remet les cartes de l’ancien logement')
  assert.equal(b.$('[data-bind="bien"]').value, d.biens[1].id, 'le sélecteur revient sur l’ancien logement')
  // Une barre gardée en mémoire (un double clic, un lecteur d'écran) n'ouvre rien.
  await b.cliquer(barreNoel)
  for (const s of ['[data-tout]', '[data-niveau]', '[data-largeur]', '[data-nuit]']) assert.equal(b.$(s), null, `${s} offert sur l’écran de l’ancien logement`)
  relache()
  await b.attendre(6)
  assert.equal(ecritures(b).length, 0, 'une écriture est partie')
  await ouvrirNoel(b)
  assert.ok(b.$('[data-tout="evenement"]'), 'le nouveau logement se règle une fois relu')
})

test('l’éditeur NOMME les nuits tenues par un autre événement ; « Remettre en automatique » sur elles le dit, sans appel', async () => {
  const lignes = [{ id: 'rev', evenement: REVEILLON, zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: 'Exceptionnel' }]
  const d = await reponseEcran({ lignes })
  const b = await monter({ ecran: async () => d, ecriture: async () => ({ corps: {} }) })
  await ouvrirNoel(b)
  await b.cliquer(nuitDe(b, JEU_24))
  assert.match(b.$('.yfe-editeur').textContent, /1 nuit choisie est réglée par « Réveillon de Noël », qui passe avant/)
  await b.cliquer(b.$('[data-auto]'))
  assert.match(b.$('.yfe-geste').textContent, /Cette nuit est réglée par « Réveillon de Noël », qui passe avant : c’est depuis cet événement/)
  // Une nuit tenue ailleurs ET une libre : le message compte (re-review).
  await b.cliquer(b.$('[data-geste-annuler]'))
  await b.cliquer(nuitDe(b, SAM_19))
  await b.cliquer(b.$('[data-auto]'))
  assert.match(b.$('.yfe-geste').textContent, /1 nuit choisie est réglée par « Réveillon de Noël ».*Les autres sont déjà en automatique/)
  assert.equal(ecritures(b).length, 0)
})

test('une nuit qu’un autre événement tient « au calcul » est déjà en automatique : « Remettre en automatique » le dit (re-review)', async () => {
  const lignes = [{ id: 'rev', evenement: REVEILLON, zone: 'evenement', rang: null, jour: null, nuit: 'date', niveau: 'calcul' }]
  const d = await reponseEcran({ lignes })
  const b = await monter({ ecran: async () => d, ecriture: async () => ({ corps: {} }) })
  await ouvrirNoel(b)
  await b.cliquer(nuitDe(b, JEU_24))
  await b.cliquer(b.$('[data-auto]'))
  assert.match(b.$('.yfe-geste').textContent, /déjà en automatique/)
  assert.doesNotMatch(b.$('.yfe-geste').textContent, /depuis cet événement/)
  assert.equal(ecritures(b).length, 0)
})

test('une session expirée (401) le dit ; un retrait sans effet ne parle pas d’un « niveau choisi »', async () => {
  const r = await import(RENDU)
  const f = { t: k => k, money: n => `${n} €`, date: () => 'x' }
  assert.deepEqual(r.effetDuGeste({ confirmation: { pilote: true, nuits: 0 } }, f, { retrait: true }), ['yfe.effet_aucune_retrait'])
  const d = await reponseEcran()
  const b = await monter({ ecran: async () => d, ecriture: async () => ({ status: 401, corps: { error: 'non_authentifie' } }) })
  await ouvrirNoel(b)
  await b.cliquer(nuitDe(b, SAM_19))
  await b.cliquer(b.$('[data-niveau="Haut"]'))
  await b.attendre()
  assert.match(b.$('.yfe-geste').textContent, /session a expiré/)
})

test('le focus survit aux gestes : « + » de la zone, « Effacer le choix », « Annuler »', async () => {
  const d = await reponseEcran()
  const b = await monter({ ecran: async () => d, ecriture: async (m, c) => ({ corps: c.simuler ? { simulation: true, confirmation: CONF, visees: {}, sans_nuit: [] } : {} }) })
  await ouvrirNoel(b)
  await b.cliquer(b.$('[data-largeur="apres"][data-pas="1"]'))
  await b.attendre(6)
  assert.equal(b.w.document.activeElement, b.$('[data-largeur="apres"][data-pas="1"]'))
  await b.cliquer(nuitDe(b, SAM_19))
  await b.cliquer(b.$('[data-choix-vider]'))
  assert.equal(b.w.document.activeElement, b.$('[data-tout="evenement"]'))
  await b.cliquer(nuitDe(b, SAM_19))
  await b.cliquer(b.$('[data-niveau="Haut"]'))
  await b.attendre()
  await b.cliquer(b.$('[data-geste-annuler]'))
  assert.equal(b.w.document.activeElement, b.$('.yfe-editeur [data-niveau]'))
})

test('le focus sur la section « sans événement » : « Annuler » revient à la ligne, « Appliquer » ne retombe pas sur la page (re-review)', async () => {
  const orphelines = [
    { id: 'o-1', evenement: 'evenement:festival_jazz', zone: 'evenement', rang: 1, jour: 'samedi', nuit: null, niveau: 'Haut' },
    { id: 'o-2', evenement: 'evenement:festival_jazz', zone: 'evenement', rang: 1, jour: 'dimanche', nuit: null, niveau: 'Haut' }
  ]
  let lignes = orphelines
  const b = await monter({
    ecran: async () => reponseEcran({ lignes }),
    ecriture: async (m, c) => {
      if (c.simuler) return { corps: { simulation: true, confirmation: { pilote: false, nuits: 0 }, visees: {}, sans_nuit: [] } }
      lignes = orphelines.filter(l => l.id !== 'o-1')
      return { corps: { ok: true, ecrites: [], envoi: 'immediat', confirmation: { pilote: false, nuits: 0 } } }
    }
  })
  await ouvrirNoel(b)
  await b.cliquer(b.$('.yfe-sans-evenement [data-retirer-ligne="o-1"]'))
  await b.attendre()
  assert.ok(b.$('.yfe-sans-evenement .yfe-geste'), 'la confirmation s’affiche dans la section')
  await b.cliquer(b.$('.yfe-sans-evenement [data-geste-annuler]'))
  assert.equal(b.w.document.activeElement, b.$('[data-retirer-ligne="o-1"]'), 'le focus saute sur une autre carte')
  await b.cliquer(b.$('[data-retirer-ligne="o-1"]'))
  await b.attendre()
  await b.cliquer(b.$('[data-geste-appliquer]'))
  await b.attendre(8)
  assert.notEqual(b.w.document.activeElement, b.w.document.body, 'le focus retombe sur la page')
  assert.equal(b.w.document.activeElement, b.$('[data-retirer-ligne="o-2"]'))
})
