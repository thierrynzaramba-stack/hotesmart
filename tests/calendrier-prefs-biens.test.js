// tests/calendrier-prefs-biens.test.js — LA LISTE DES BIENS EST COMMUNE AUX
// DEUX ECRANS, MAIS UN DEFAUT N'EST PAS UN CHOIX.
//
// LE DEFAUT QU'ILS EMPECHENT (constat 2 de l'inventaire des bugs UI V5,
// 17 octobre 2026). Sous 900 px, le calendrier n'affiche qu'UN bien — c'est
// voulu, un planning multi-biens ne tient pas sur un telephone. Mais
// `ecrirePrefs` enregistrait `choisis` a CHAQUE geste (changer de mois,
// changer de vue), donc ce defaut du telephone s'ecrivait dans la preference
// COMMUNE `hs_cal_v5_prefs`. A la reouverture sur ordinateur, le planning
// n'affichait plus qu'un bien. L'hote croyait ses biens disparus sans avoir
// rien decide, et rien a l'ecran ne disait pourquoi.
//
// ⚠ ON EXECUTE LE VRAI CODE DE LA PAGE, pas une copie : les deux fonctions de
// preference et `chargerBiens` sont DECOUPEES dans `pages/calendrier.html` et
// evaluees telles quelles. Un double resterait vert pendant que la page ment.
//
// ⚠ AUCUNE DATE ICI : ce fichier ne lit pas l'horloge.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('node:vm')

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'pages', 'calendrier.html'), 'utf8')

function bloc (debut, fin) {
  const a = PAGE.indexOf(debut)
  const b = PAGE.indexOf(fin, a)
  assert.ok(a >= 0 && b > a, `bloc introuvable dans la page : ${debut}`)
  return PAGE.slice(a, b)
}
const PREFS = bloc("const PREFS_CLE = 'hs_cal_v5_prefs'", '// ─── Toasts')
const CHARGER = bloc('async function chargerBiens', 'function bornesLecture')

// Trois biens pilotables et un Beds24, comme en production.
const BIENS = [
  { id: 'u1', name: 'La bulle', provider: 'channex' },
  { id: 'u2', name: 'Cœur de vie 23', provider: 'channex' },
  { id: 'u3', name: 'Ofuro Futari', provider: 'channex' },
  { id: 'u9', name: 'Vieux Beds', provider: 'beds24' }
]

// Un localStorage de poche : le meme objet survit aux deux « ecrans », c'est
// tout l'interet — la preference est COMMUNE.
function memoire (depart = null) {
  const boite = { v: depart }
  return {
    getItem: () => boite.v,
    setItem: (_, val) => { boite.v = val },
    lu: () => (boite.v == null ? null : JSON.parse(boite.v))
  }
}

// `large` = l'ordinateur (>= 900 px). Le reste du contexte est reduit a ce que
// les deux fonctions touchent.
function ecran ({ large, stock, biens = BIENS }) {
  const etat = { biens: [], choisis: [], choisisDefinis: false, months: 3, decalage: 0, annee: null, mois: null, vueMobile: 'rate' }
  const ctx = {
    etat,
    localStorage: stock,
    VUES: [{ id: 'rate' }, { id: 'menage' }],
    estLarge: () => large,
    api: { channel: { listProperties: async () => ({ properties: biens }) } },
    JSON, Number, Array, Object, console
  }
  vm.createContext(ctx)
  vm.runInContext(PREFS + '\n' + CHARGER + '\n' +
    'this.lirePrefs = lirePrefs; this.ecrirePrefs = ecrirePrefs; this.chargerBiens = chargerBiens', ctx)
  return ctx
}

// ⚠ UNE COPIE DANS NOTRE REALM AVANT DE COMPARER. Les tableaux que la page
// construit naissent DANS le contexte `vm` : leur prototype `Array` n'est pas
// le notre, et `assert.deepEqual` strict refuse alors deux listes pourtant
// identiques. On compare les valeurs, pas les royaumes.
const liste = (ctx) => [...ctx.etat.choisis]

// Ouvrir la page : lire les preferences, retenir le lien profond, puis charger
// les biens — l'ordre exact de `init()`.
async function ouvrir (opts) {
  const ctx = ecran(opts)
  ctx.lirePrefs()
  ctx.etat.bienDemande = opts.bien || null
  await ctx.chargerBiens()
  return ctx
}

test('LE TEST QUI COMPTE : le telephone n’ampute pas la liste de l’ordinateur', async () => {
  const stock = memoire()

  // 1. Le telephone s'ouvre : un seul bien, c'est le defaut voulu.
  const tel = await ouvrir({ large: false, stock })
  assert.deepEqual(liste(tel), ['u1'], 'le telephone montre un seul bien')

  // 2. L'hote change de mois — un geste qui enregistre les preferences.
  tel.etat.mois = 11; tel.etat.annee = 2026
  tel.ecrirePrefs()

  // 3. Il rouvre sur son ordinateur : les TROIS biens pilotables sont la.
  const bureau = await ouvrir({ large: true, stock })
  assert.deepEqual(liste(bureau), ['u1', 'u2', 'u3'],
    'l’ordinateur garde ses biens : le defaut du telephone ne s’enregistre pas')
})

test('le mois, la periode et la vue continuent de se retenir', async () => {
  const stock = memoire()
  const tel = await ouvrir({ large: false, stock })
  Object.assign(tel.etat, { mois: 11, annee: 2026, months: 6, vueMobile: 'menage' })
  tel.ecrirePrefs()
  assert.equal(stock.lu().choisis, undefined, 'la liste des biens n’est pas ecrite')

  const apres = await ouvrir({ large: false, stock })
  assert.deepEqual([apres.etat.mois, apres.etat.annee, apres.etat.months, apres.etat.vueMobile],
    [11, 2026, 6, 'menage'], 'les gestes de l’hote, eux, se retiennent')
})

test('un choix VOULU, lui, s’enregistre et vaut sur les deux ecrans', async () => {
  const stock = memoire()
  const tel = await ouvrir({ large: false, stock })
  // Le geste « ajouter un bien » : la page pose les deux marques ensemble.
  tel.etat.choisis = ['u1', 'u3']
  tel.etat.choisisDefinis = true
  tel.ecrirePrefs()
  assert.deepEqual(stock.lu().choisis, ['u1', 'u3'])
  assert.equal(stock.lu().choisisParLHote, true, 'le drapeau dit que c’est un choix')

  const bureau = await ouvrir({ large: true, stock })
  assert.deepEqual(liste(bureau), ['u1', 'u3'], 'l’ordinateur honore le choix du telephone')
})

test('L’AUTO-REPARATION : une preference ecrite AVANT le correctif est tenue pour un defaut', async () => {
  // Pas de drapeau : exactement ce que le telephone avait enregistre.
  const stock = memoire(JSON.stringify({ choisis: ['u1'], months: 3, annee: null, mois: null, vueMobile: 'rate' }))
  const bureau = await ouvrir({ large: true, stock })
  assert.deepEqual(liste(bureau), ['u1', 'u2', 'u3'],
    'l’ordinateur recalcule son defaut au lieu de subir la liste amputee')
})

test('l’ordre des biens, lui, est un choix : il survit', async () => {
  const stock = memoire()
  const bureau = await ouvrir({ large: true, stock })
  // Le glisser-deposer : meme marque que l’ajout (`onOrdre`).
  bureau.etat.choisis = ['u3', 'u1', 'u2']
  bureau.etat.choisisDefinis = true
  bureau.ecrirePrefs()
  const apres = await ouvrir({ large: true, stock })
  assert.deepEqual(liste(apres), ['u3', 'u1', 'u2'])
})

test('un bien retire du compte sort de la liste, et le defaut revient s’il n’en reste aucun', async () => {
  const stock = memoire()
  const bureau = await ouvrir({ large: true, stock })
  bureau.etat.choisis = ['u3']
  bureau.etat.choisisDefinis = true
  bureau.ecrirePrefs()

  // u3 n'existe plus : la liste se vide, donc le defaut reprend la main.
  const sansU3 = await ouvrir({ large: true, stock, biens: BIENS.filter(b => b.id !== 'u3') })
  assert.deepEqual(liste(sansU3), ['u1', 'u2'])
})

// ─── Le lien profond ?bien= (constat 1 de la revue de 3fa1d8f) ──────────────
// Il arrive de la tuile « Calendrier » de l'accueil, du lien « réservation »
// de /messages, de la fiche d'un bien et de la redirection déclarative
// /biens/:id/calendrier. C'est le chemin le PLUS frequent vers cette page.

test('LE LIEN PROFOND N’EST PAS UN CHOIX : il met le bien en tete, il n’isole pas', async () => {
  const stock = memoire()
  const bureau = await ouvrir({ large: true, stock, bien: 'u2' })
  assert.deepEqual(liste(bureau), ['u2', 'u1', 'u3'],
    'le bien demande passe en tete, les autres restent')
  assert.equal(bureau.etat.choisisDefinis, false, 'un lien n’est pas une decision de l’hote')
})

test('et le premier geste apres un lien profond ne grave rien', async () => {
  const stock = memoire()
  const bureau = await ouvrir({ large: true, stock, bien: 'u2' })
  bureau.etat.mois = 11; bureau.etat.annee = 2026
  bureau.ecrirePrefs()
  assert.equal(stock.lu().choisis, undefined, 'la liste n’est pas enregistree')

  // Il rouvre /calendrier sans lien : il retrouve TOUS ses biens, dans l'ordre.
  const apres = await ouvrir({ large: true, stock })
  assert.deepEqual(liste(apres), ['u1', 'u2', 'u3'])
})

test('au telephone, le lien profond prend la place unique', async () => {
  const tel = await ouvrir({ large: false, stock: memoire(), bien: 'u3' })
  assert.deepEqual(liste(tel), ['u3'], 'un seul bien au telephone, et c’est celui demande')
})

test('un lien profond honore le choix de l’hote sans le defaire', async () => {
  const stock = memoire(JSON.stringify({ choisis: ['u1', 'u3'], choisisParLHote: true, months: 3, annee: null, mois: null, vueMobile: 'rate' }))
  const bureau = await ouvrir({ large: true, stock, bien: 'u3' })
  assert.deepEqual(liste(bureau), ['u3', 'u1'], 'le bien demande passe en tete DE SA liste')
  bureau.ecrirePrefs()
  assert.equal(stock.lu().choisisParLHote, true, 'son choix reste un choix')
})

test('un ?bien= inconnu du compte est ignore, il ne vide pas le planning', async () => {
  const bureau = await ouvrir({ large: true, stock: memoire(), bien: 'inconnu' })
  assert.deepEqual(liste(bureau), ['u1', 'u2', 'u3'])
})

test('un ?bien= qui designe un bien Beds24 est ignore : il n’est pas pilotable', async () => {
  const bureau = await ouvrir({ large: true, stock: memoire(), bien: 'u9' })
  assert.deepEqual(liste(bureau), ['u1', 'u2', 'u3'])
})

// ─── Le franchissement des 900 px (constat 2 de la revue de 3fa1d8f) ────────

test('LE SEUIL SE FRANCHIT DANS LES DEUX SENS : le defaut suit l’ecran', async () => {
  const stock = memoire()
  const ctx = ecran({ large: false, stock })
  ctx.lirePrefs()
  await ctx.chargerBiens()
  assert.deepEqual(liste(ctx), ['u1'], 'telephone : un bien')

  // Le telephone tourne en paysage : `chargerBiens` est rappele.
  ctx.estLarge = () => true
  await ctx.chargerBiens()
  assert.deepEqual(liste(ctx), ['u1', 'u2', 'u3'], 'paysage : les trois reviennent')

  // Et dans l'autre sens.
  ctx.estLarge = () => false
  await ctx.chargerBiens()
  assert.deepEqual(liste(ctx), ['u1'], 'portrait : un seul a nouveau')
})

test('mais un choix de l’hote traverse le seuil sans bouger', async () => {
  const stock = memoire()
  const ctx = ecran({ large: true, stock })
  ctx.lirePrefs()
  await ctx.chargerBiens()
  ctx.etat.choisis = ['u3', 'u1']
  ctx.etat.choisisDefinis = true
  ctx.estLarge = () => false
  await ctx.chargerBiens()
  assert.deepEqual(liste(ctx), ['u3', 'u1'], 'ce qu’il a choisi ne se recalcule pas')
})

test('un bien Beds24 n’entre jamais dans le defaut', async () => {
  const bureau = await ouvrir({ large: true, stock: memoire() })
  assert.ok(!bureau.etat.choisis.includes('u9'), 'Beds24 reste hors du planning pilotable')
})

// ⚠ CE QUE LE HARNAIS NE PEUT PAS EXECUTER. Les tests ci-dessus posent
// `etat.bienDemande` eux-memes, comme `init()` le fait : ils eprouvent le
// TRAITEMENT du lien profond, pas sa LECTURE. La garde qui suit tient l'autre
// bout — elle lit le vrai bloc de `init()` dans la page.
test('init() retient le ?bien= sans en faire une decision de l’hote', () => {
  const i = PAGE.indexOf('etat.bienDemande = new URLSearchParams')
  assert.ok(i > 0, 'init() doit poser etat.bienDemande depuis l’URL')
  const bloc = PAGE.slice(i, i + 400)
  assert.ok(!/choisisDefinis\s*=\s*true/.test(bloc),
    'le lien profond ne doit jamais marquer choisisDefinis')
  assert.ok(!/etat\.choisis\s*=\s*\[\s*bienDemande/.test(PAGE),
    'le lien profond ne touche plus etat.choisis dans init() : c’est chargerBiens qui l’applique, APRES le defaut')
})
