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

// Ouvrir la page : lire les preferences, puis charger les biens.
async function ouvrir (opts) {
  const ctx = ecran(opts)
  ctx.lirePrefs()
  await ctx.chargerBiens()
  return ctx
}

test('LE TEST QUI COMPTE : le telephone n’ampute pas la liste de l’ordinateur', async () => {
  const stock = memoire()

  // 1. Le telephone s'ouvre : un seul bien, c'est le defaut voulu.
  const tel = await ouvrir({ large: false, stock })
  assert.deepEqual(tel.etat.choisis, ['u1'], 'le telephone montre un seul bien')

  // 2. L'hote change de mois — un geste qui enregistre les preferences.
  tel.etat.mois = 11; tel.etat.annee = 2026
  tel.ecrirePrefs()

  // 3. Il rouvre sur son ordinateur : les TROIS biens pilotables sont la.
  const bureau = await ouvrir({ large: true, stock })
  assert.deepEqual(bureau.etat.choisis, ['u1', 'u2', 'u3'],
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
  assert.deepEqual(bureau.etat.choisis, ['u1', 'u3'], 'l’ordinateur honore le choix du telephone')
})

test('L’AUTO-REPARATION : une preference ecrite AVANT le correctif est tenue pour un defaut', async () => {
  // Pas de drapeau : exactement ce que le telephone avait enregistre.
  const stock = memoire(JSON.stringify({ choisis: ['u1'], months: 3, annee: null, mois: null, vueMobile: 'rate' }))
  const bureau = await ouvrir({ large: true, stock })
  assert.deepEqual(bureau.etat.choisis, ['u1', 'u2', 'u3'],
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
  assert.deepEqual(apres.etat.choisis, ['u3', 'u1', 'u2'])
})

test('un bien retire du compte sort de la liste, et le defaut revient s’il n’en reste aucun', async () => {
  const stock = memoire()
  const bureau = await ouvrir({ large: true, stock })
  bureau.etat.choisis = ['u3']
  bureau.etat.choisisDefinis = true
  bureau.ecrirePrefs()

  // u3 n'existe plus : la liste se vide, donc le defaut reprend la main.
  const sansU3 = await ouvrir({ large: true, stock, biens: BIENS.filter(b => b.id !== 'u3') })
  assert.deepEqual(sansU3.etat.choisis, ['u1', 'u2'])
})

test('un bien Beds24 n’entre jamais dans le defaut', async () => {
  const bureau = await ouvrir({ large: true, stock: memoire() })
  assert.ok(!bureau.etat.choisis.includes('u9'), 'Beds24 reste hors du planning pilotable')
})
