// tests/yf-ecran-evenements-sejours-page.test.js — 4b, étape 2 : la page.
// Sous chaque nuit d'un événement ouvert, les séjours de cette année et des
// années passées ; les pastilles des années ; le libellé au singulier.
// Spec : docs/specs/spec-yf-ecran-evenements.md §16.
//
// ⚠ LES DONNÉES SONT CELLES DE LA VRAIE ASSEMBLÉE (tests/outils/banc-evenements.js),
// séjours compris : la page est éprouvée sur la forme exacte du serveur.
// ⚠ DATES FIGÉES : l'assemblée reçoit `aujourdHui` ; la page ne lit pas l'horloge.
// Le banc n'a pas les vacances de Noël 2025 : leur alignement est le REPLI à
// 52 semaines (`alignement: 'semaines'`) — c'est aussi ce qu'on veut voir dit.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { reponseEcran, monter, NOEL } = require('./outils/banc-evenements')

const RENDU = path.join(__dirname, '..', 'shared/yield-evenements-rendu.js')
const FR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared/i18n/fr.json'), 'utf8'))

const decaler = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
const ecl = (debut, n, o = {}) => ({
  compte: o.compte !== false,
  nuits: Array.from({ length: n }, (_, i) => ({ date: decaler(debut, i) })),
  prix_par_nuit: o.prix === undefined ? 150 : o.prix,
  canal: o.canal || 'airbnb',
  date_vente: o.vente || null,
  date_vente_fiable: !!o.vente
})

// Cette année : du 22 au 24 décembre 2026, vendu le 1er novembre (51 jours).
// L'an dernier : du 23 au 25 décembre 2025 (en face, reculé de 52 semaines),
// vendu le 1er novembre 2025 (52 jours). Et un séjour de juin 2024 : le bien
// vendait déjà en 2024, pas en 2023.
const SEJOURS = [
  ecl('2026-12-22', 3, { vente: '2026-11-01T10:00:00Z' }),
  ecl('2025-12-23', 3, { vente: '2025-11-01T08:00:00Z', canal: 'BookingCom' }),
  ecl('2024-06-01', 2, { prix: 90 })
]

async function ouvrirNoel (b) {
  await b.cliquer(b.$$('.yfe-barre').find(x => x.dataset.ouvrir.startsWith(NOEL + '|')))
  return (date) => b.$$('.yfe-ev--ouvert [data-nuit]').find(j => j.dataset.nuit === date)
}
const lignesDe = (cellule) => [...cellule.querySelectorAll('.yfe-sejour')]

test('LE TEST QUI COMPTE : chaque nuit porte la même pile, dans le même ordre — cette année, puis chaque année qui a un historique', async () => {
  const d = await reponseEcran({ eclatements: SEJOURS })
  const noel = d.evenements.find(e => e.cle === NOEL)
  assert.deepEqual(noel.annees.map(a => [a.annee, a.alignement]), [[2025, 'semaines'], [2024, 'semaines']],
    'la fixture : deux années passées, pas 2023 (le bien ne vendait pas encore)')
  const b = await monter({ ecran: async () => d })
  const nuit = await ouvrirNoel(b)
  const cellules = b.$$('.yfe-ev--ouvert [data-nuit]')
  assert.ok(cellules.length >= 14)
  for (const c of cellules) {
    assert.deepEqual(lignesDe(c).map(l => [...l.classList].find(x => /^yfe-sejour--a\d$/.test(x))),
      ['yfe-sejour--a0', 'yfe-sejour--a1', 'yfe-sejour--a2'], c.dataset.nuit)
  }
  // La pile est MUETTE pour un lecteur d'écran : le nom de la case la dit.
  assert.equal(nuit('2026-12-22').querySelector('.yfe-pile').getAttribute('aria-hidden'), 'true')
})

test('LE TEST QUI COMPTE : une barre est continue — arrondie à ses vraies extrémités, le prix sur chaque nuit, le délai au bout', async () => {
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: SEJOURS }) })
  const nuit = await ouvrirNoel(b)
  const a0 = date => lignesDe(nuit(date))[0]
  const classes = date => [...a0(date).classList].filter(x => /--(debut|fin|suite-avant|suite-apres|vendue)$/.test(x)).sort()
  assert.deepEqual(classes('2026-12-22'), ['yfe-sejour--debut', 'yfe-sejour--suite-apres', 'yfe-sejour--vendue'])
  assert.deepEqual(classes('2026-12-23'), ['yfe-sejour--suite-apres', 'yfe-sejour--suite-avant', 'yfe-sejour--vendue'])
  assert.deepEqual(classes('2026-12-24'), ['yfe-sejour--fin', 'yfe-sejour--suite-avant', 'yfe-sejour--vendue'])
  for (const date of ['2026-12-22', '2026-12-23', '2026-12-24']) assert.equal(a0(date).querySelector('.yfe-sejour__prix').textContent, '150 €')
  assert.equal(a0('2026-12-22').querySelector('.yfe-sejour__delai'), null, 'le délai au bout, pas au début')
  assert.equal(a0('2026-12-24').querySelector('.yfe-sejour__delai').textContent, '−51 j')
  // La nuit d'avant et celle d'après : « — », pas encore réservées.
  assert.equal(a0('2026-12-21').querySelector('.yfe-sejour__prix').textContent, '—')
  assert.ok(a0('2026-12-25').classList.contains('yfe-sejour--vide'))
})

test('LE TEST QUI COMPTE : au bord d’une semaine, la barre est COUPÉE — elle ne déborde pas vers une case qui n’est pas sa voisine', async () => {
  // Du samedi 26 au mardi 29 décembre 2026 : le dimanche finit une rangée, le
  // lundi en commence une autre.
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: [...SEJOURS, ecl('2026-12-26', 4)] }) })
  const nuit = await ouvrirNoel(b)
  const a0 = date => [...lignesDe(nuit(date))[0].classList]
  assert.ok(a0('2026-12-27').includes('yfe-sejour--suite-avant'))
  assert.ok(!a0('2026-12-27').includes('yfe-sejour--suite-apres'), 'le dimanche ne déborde pas vers la rangée du dessous')
  assert.ok(!a0('2026-12-28').includes('yfe-sejour--suite-avant'), 'le lundi ne déborde pas vers la rangée du dessus')
  assert.ok(!a0('2026-12-28').includes('yfe-sejour--debut'), 'coupée, pas commencée : carrée')
  assert.ok(a0('2026-12-28').includes('yfe-sejour--suite-apres'))
})

test('LE TEST QUI COMPTE : une ligne passée met en face la nuit `date − décalage` du serveur — ni plus, ni moins', async () => {
  const d = await reponseEcran({ eclatements: SEJOURS })
  const b = await monter({ ecran: async () => d })
  const nuit = await ouvrirNoel(b)
  // 22 décembre 2026 moins 364 jours = 23 décembre 2025 : la première nuit du séjour 2025.
  const a1 = date => lignesDe(nuit(date))[1]
  assert.ok(a1('2026-12-22').classList.contains('yfe-sejour--debut'))
  assert.ok(a1('2026-12-24').classList.contains('yfe-sejour--fin'))
  assert.equal(a1('2026-12-24').querySelector('.yfe-sejour__delai').textContent, '−52 j')
  assert.ok(a1('2026-12-25').classList.contains('yfe-sejour--vide'), 'le 26 décembre 2025 est resté vide')
  // L'année sur le LUNDI seulement.
  assert.deepEqual(lignesDe(nuit('2026-12-21')).map(l => (l.querySelector('.yfe-sejour__an') || {}).textContent), ['26', '25', '24'])
  assert.equal(nuit('2026-12-22').querySelector('.yfe-sejour__an'), null)
  // Et le nom de la case le dit en mots, canal compris.
  assert.match(nuit('2026-12-23').getAttribute('aria-label'),
    /2025 · séjour de 3 nuits · 150 € la nuit · Booking\.com · réservé 52 jours avant l’arrivée/)
  assert.match(nuit('2026-12-23').getAttribute('aria-label'), /2026 · séjour de 3 nuits · 150 € la nuit · Airbnb · réservé 51 jours avant l’arrivée/)
  assert.match(nuit('2026-12-23').getAttribute('aria-label'), /2024 · restée vide/)
})

test('LE TEST QUI COMPTE : toucher une nuit en dit les séjours EN TEXTE VISIBLE — le téléphone n’a pas de survol', async () => {
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: SEJOURS }) })
  const nuit = await ouvrirNoel(b)
  await b.cliquer(nuit('2026-12-24'))
  const detail = b.$('.yfe-ev--ouvert .yfe-detail').textContent
  assert.match(detail, /2026 · séjour de 3 nuits · 150 € la nuit · Airbnb · réservé 51 jours avant l’arrivée/)
  assert.match(detail, /2025 · séjour de 3 nuits/)
})

test('LE TEST QUI COMPTE : les pastilles des années disent leur bilan, et le repli à 52 semaines est DIT', async () => {
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: SEJOURS }) })
  await ouvrirNoel(b)
  const pastilles = b.$$('.yfe-ev--ouvert [data-couche]')
  assert.deepEqual(pastilles.map(p => [p.dataset.couche, p.textContent, p.getAttribute('aria-pressed')]),
    [['n1', '2025 · 450 € · 3 nuits', 'true'], ['n2', '2024 · 0 € · aucune nuit', 'true']])
  const zone = b.$('.yfe-ev--ouvert .yfe-couches').textContent
  assert.match(zone, /Votre choix est gardé d’un événement à l’autre et d’une saison à l’autre\./)
  assert.match(zone, /2025 : l’événement n’a pas été trouvé cette année-là — comparé aux mêmes jours de semaine, 52 semaines avant\./)
  assert.match(zone, /2024 : .*104 semaines avant\./)
})

test('LE TEST QUI COMPTE (S2) : éteindre une année la retire de TOUTES les nuits tout de suite, et l’écrit — ligne de l’appelant, compte délégué compris', async () => {
  const b = await monter({ compteDelegue: true, ecran: async () => reponseEcran({ eclatements: SEJOURS }) })
  const nuit = await ouvrirNoel(b)
  await b.cliquer(b.$('.yfe-ev--ouvert [data-couche="n1"]'))
  assert.equal(b.$('.yfe-ev--ouvert [data-couche="n1"]').getAttribute('aria-pressed'), 'false')
  for (const c of b.$$('.yfe-ev--ouvert [data-nuit]')) {
    assert.equal(c.querySelectorAll('.yfe-sejour--a1').length, 0, c.dataset.nuit)
    assert.equal(c.querySelectorAll('.yfe-sejour--a2').length, 1)
  }
  assert.doesNotMatch(nuit('2026-12-23').getAttribute('aria-label'), /2025 ·/)
  const put = b.journal.fetch.filter(f => f.methode === 'PUT')
  assert.equal(put.length, 1)
  assert.equal(put[0].url, '/api/ecran/evenements')
  assert.deepEqual(put[0].corps, { couches: { eteintes: ['n1'] } })
  assert.equal(put[0].entetes['X-Compte'], b.COMPTE)
  assert.equal(b.w.document.activeElement, b.$('.yfe-ev--ouvert [data-couche="n1"]'), 'le focus reste sur la pastille')
  // Et le cache garde le choix — sans les séjours.
  const c = b.cache.lire('yield-evenements', b.MOI, b.COMPTE)
  const corps = c && (c.data || c.donnees || c.valeur || c)
  assert.deepEqual(corps.couches, { eteintes: ['n1'], lisibles: true })
  assert.equal('sejours' in corps, false)
})

test('LE TEST QUI COMPTE : un enregistrement refusé le DIT, garde le choix de la visite — même après une relecture de l’écran', async () => {
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: SEJOURS }), couchesEcriture: async () => ({ status: 503, corps: { error: 'ecriture_impossible' } }) })
  await ouvrirNoel(b)
  await b.cliquer(b.$('.yfe-ev--ouvert [data-couche="n2"]'))
  await b.attendre(5)
  assert.match(b.$('.yfe-ev--ouvert .yfe-couches').textContent, /Votre choix n’a pas pu être enregistré : il vaut pour cette visite\./)
  assert.equal(b.$('.yfe-ev--ouvert [data-couche="n2"]').getAttribute('aria-pressed'), 'false')
  // La relecture qui suit un geste rend les couches du serveur (rien d'éteint) :
  // la visite garde son choix.
  await b.w.charger()
  await b.attendre(5)
  assert.equal(b.$('.yfe-ev--ouvert [data-couche="n2"]').getAttribute('aria-pressed'), 'false')
  assert.equal(b.$$('.yfe-ev--ouvert .yfe-sejour--a2').length, 0)
})

test('LE TEST QUI COMPTE (S2) : les couches éteintes par le serveur arrivent éteintes ; illisibles, tout est allumé et c’est dit', async () => {
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: SEJOURS, couches: { eteintes: ['n2'], lisibles: true } }) })
  await ouvrirNoel(b)
  assert.equal(b.$('.yfe-ev--ouvert [data-couche="n2"]').getAttribute('aria-pressed'), 'false')
  assert.equal(b.$$('.yfe-ev--ouvert .yfe-sejour--a2').length, 0)
  assert.ok(b.$$('.yfe-ev--ouvert .yfe-sejour--a1').length > 0)
  const b2 = await monter({ ecran: async () => reponseEcran({ eclatements: SEJOURS, couches: { eteintes: [], lisibles: false } }) })
  await ouvrirNoel(b2)
  assert.match(b2.$('.yfe-ev--ouvert .yfe-couches').textContent, /Votre choix n’a pas pu être lu : toutes les années sont affichées\./)
})

test('LE TEST QUI COMPTE (§16.7, point 3) : un écran peint depuis le cache n’a PAS de pile — elle arrive avec la réponse du serveur', async () => {
  const r = await import(RENDU)
  const d = await reponseEcran({ eclatements: SEJOURS })
  let pendantLAttente = null
  const b = await monter({
    cache: r.pourLeCache(d),
    ecran: async (url, w) => {
      // L'écran du cache est peint : on ouvre Noël et on regarde, AVANT la réponse.
      const barre = [...w.document.querySelectorAll('.yfe-barre')].find(x => x.dataset.ouvrir.startsWith(NOEL + '|'))
      barre.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
      pendantLAttente = {
        cases: w.document.querySelectorAll('.yfe-ev--ouvert [data-nuit]').length,
        piles: w.document.querySelectorAll('.yfe-ev--ouvert .yfe-pile').length
      }
      return d
    }
  })
  assert.ok(pendantLAttente.cases > 0, 'l’événement est bien ouvert depuis le cache')
  assert.equal(pendantLAttente.piles, 0, 'pas une ligne « — » sur une nuit peut-être vendue')
  assert.ok(b.$$('.yfe-ev--ouvert .yfe-pile').length > 0, 'la réponse du serveur apporte la pile')
})

test('LE TEST QUI COMPTE : une nuit passée pas encore jouée, ou d’avant la première vente, n’est jamais écrite « — »', async () => {
  const r = await import(RENDU)
  const data = {
    aujourdhui: '2026-11-09',
    sejours: { liste: [{ debut: '2025-12-23', fin: '2025-12-25', nuits: 3, prix_nuit: 150, canal: 'airbnb', delai: 52 }], premiere_nuit: '2025-12-01' }
  }
  const e = { annees: [{ recul: 1, annee: 2025, decalage: 364 }, { recul: 2, annee: 2024, decalage: 728 }] }
  // Le 20 novembre 2027 reculé d'un an : le 21 novembre 2026, pas encore joué.
  assert.deepEqual(r.pileDeLaNuit('2027-11-20', e, data).map(l => l.etat), ['vide', 'a_venir', 'avant'])
  const fmt = { t: (k, v = {}) => FR[k].replace(/\{(\w+)\}/g, (m, c) => (v[c] !== undefined ? String(v[c]) : m)), money: n => `${n} €` }
  const pile = r.pileDeLaNuit('2027-11-20', e, data)
  assert.deepEqual(pile.map(l => r.phraseDeLigne(l, fmt)), ['2027 · pas encore réservée', '2025 · pas encore passée', '2024 · le logement ne vendait pas encore'])
  // Sans liste (écran du cache) : pas de pile du tout.
  assert.equal(r.pileDeLaNuit('2027-11-20', e, { aujourdhui: '2026-11-09' }), null)
  // Une année éteinte n'a pas de ligne.
  assert.deepEqual(r.pileDeLaNuit('2026-12-23', e, data, ['n1']).map(l => l.recul), [0, 2])
})

test('le libellé de l’envoi est au singulier pour UNE nuit (promis au chef de file le 10 novembre 2026)', async () => {
  const r = await import(RENDU)
  const vus = []
  const fmt = { t: (k, v) => { vus.push([k, v]); return k }, money: n => `${n} €`, date: (d, o) => new Date(d).toLocaleDateString('fr-FR', o) }
  r.effetDuGeste({ confirmation: { pilote: true, nuits: 1, du: '2026-12-23', au: '2026-12-23', min: 95, max: 95 } }, fmt)
  assert.deepEqual(vus.find(([k]) => k === 'yfe.effet_envoi')[1], { n: 1 })
  assert.match(FR['yfe.effet_envoi'], /one \{YieldFlow l’enverra aux plateformes/)
  assert.match(FR['yfe.effet_envoi'], /other \{YieldFlow les enverra aux plateformes/)
})

test('règles V5 : la feuille de 4b n’a aucun hexa, et la barre suit le jeton --sejour', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'shared/yield-evenements.css'), 'utf8')
  const bloc = css.slice(css.indexOf('4b : les séjours'), css.indexOf('Téléphone : la même grille'))
  assert.ok(bloc.length > 200)
  assert.doesNotMatch(bloc, /#[0-9a-f]{3,8}\b/i)
  for (const pct of ['60%', '40%', '25%']) assert.match(bloc, new RegExp(`var\\(--sejour\\) ${pct}`))
})

// ─── Correctifs de la review de l'étape 2 (12 novembre 2026) ─────────────────

const ES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared/i18n/es.json'), 'utf8'))
// Un fmt sur un VRAI dictionnaire, pluriel ICU du socle compris.
const fmtDe = (dict, lang) => ({
  t: (k, v = {}) => String(dict[k])
    .replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g, (_, c, corps) => {
      const n = Number(v[c]); const f = {}
      for (const m of corps.matchAll(/(=\d+|\w+)\s*\{([^{}]*)\}/g)) f[m[1]] = m[2]
      return (f['=' + n] ?? f[new Intl.PluralRules(lang).select(n)] ?? f.other ?? '').replace(/#/g, String(n))
    })
    .replace(/\{(\w+)\}/g, (m, c) => (v[c] !== undefined ? String(v[c]) : m)),
  money: n => `${n} €`
})
const differe = () => { let liberer; const p = new Promise(r => { liberer = r }); return { p, liberer } }
const couchesDuCache = async (b) => {
  const c = b.cache.lire('yield-evenements', b.MOI, b.COMPTE)
  return c && c.donnees && c.donnees.couches
}

test('LE TEST QUI COMPTE (constat 1) : deux clics rapides — UN seul PUT en vol, puis l’état COURANT ; la base, la page et le cache finissent d’accord', async () => {
  const base = []
  const premier = differe()
  const b = await monter({
    ecran: async () => reponseEcran({ eclatements: SEJOURS }),
    couchesEcriture: async (corps) => {
      base.push(corps.couches.eteintes.slice())
      if (base.length === 1) { await premier.p; return { status: 200, corps: {} } }
      return { status: 200, corps: {} }
    }
  })
  await ouvrirNoel(b)
  await b.cliquer(b.$('.yfe-ev--ouvert [data-couche="n1"]'))
  await b.cliquer(b.$('.yfe-ev--ouvert [data-couche="n2"]'))
  assert.deepEqual(base, [['n1']], 'le second clic ne part pas pendant que le premier est en vol')
  assert.equal(b.$('.yfe-ev--ouvert [data-couche="n2"]').getAttribute('aria-pressed'), 'false', 'le dessin, lui, suit tout de suite')
  premier.liberer()
  await b.attendre(8)
  assert.deepEqual(base, [['n1'], ['n1', 'n2']], 'au retour, c’est l’état COURANT qui part')
  assert.deepEqual(await couchesDuCache(b), { eteintes: ['n1', 'n2'], lisibles: true })
  assert.equal(b.$('.yfe-ev--ouvert .yfe-couches .yfe-message'), null)
})

test('LE TEST QUI COMPTE (constats 1 et 16) : seul le DERNIER envoi parle — un échec dépassé par un succès ne s’affiche pas', async () => {
  const base = []
  const premier = differe()
  const b = await monter({
    ecran: async () => reponseEcran({ eclatements: SEJOURS }),
    couchesEcriture: async (corps) => {
      base.push(corps.couches.eteintes.slice())
      if (base.length === 1) { await premier.p; return { status: 503, corps: { error: 'ecriture_impossible' } } }
      return { status: 200, corps: {} }
    }
  })
  await ouvrirNoel(b)
  await b.cliquer(b.$('.yfe-ev--ouvert [data-couche="n1"]'))
  await b.cliquer(b.$('.yfe-ev--ouvert [data-couche="n2"]'))
  premier.liberer()
  await b.attendre(8)
  assert.deepEqual(base, [['n1'], ['n1', 'n2']])
  assert.equal(b.$('.yfe-ev--ouvert .yfe-couches .yfe-message'), null, 'pas de « non enregistré » sous un choix enregistré')
  assert.equal(b.$('[data-bind="couches-annonce"]').textContent, '')
  assert.deepEqual(await couchesDuCache(b), { eteintes: ['n1', 'n2'], lisibles: true })
})

test('LE TEST QUI COMPTE (constat 16) : un enregistrement refusé n’écrit PAS le cache — il garde ce que le serveur a', async () => {
  const b = await monter({
    ecran: async () => reponseEcran({ eclatements: SEJOURS }),
    couchesEcriture: async () => ({ status: 503, corps: { error: 'ecriture_impossible' } })
  })
  await ouvrirNoel(b)
  assert.deepEqual(await couchesDuCache(b), { eteintes: [], lisibles: true }, 'le chargement a mis la réponse en cache')
  await b.cliquer(b.$('.yfe-ev--ouvert [data-couche="n2"]'))
  await b.attendre(5)
  assert.deepEqual(await couchesDuCache(b), { eteintes: [], lisibles: true })
  // Et une relecture ne l'y met pas non plus : le serveur n'a rien accepté.
  await b.w.charger()
  await b.attendre(5)
  assert.deepEqual(await couchesDuCache(b), { eteintes: [], lisibles: true })
  assert.equal(b.$('.yfe-ev--ouvert [data-couche="n2"]').getAttribute('aria-pressed'), 'false', 'la visite garde son choix')
})

test('LE TEST QUI COMPTE (constat 1) : une relecture lue AVANT l’enregistrement ne remet pas l’ancien choix en cache', async () => {
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: SEJOURS }) })
  await ouvrirNoel(b)
  await b.cliquer(b.$('.yfe-ev--ouvert [data-couche="n1"]'))
  await b.attendre(5)
  assert.deepEqual(await couchesDuCache(b), { eteintes: ['n1'], lisibles: true })
  // Le serveur du banc répond toujours « rien d'éteint » : une réponse lue
  // avant l'enregistrement.
  await b.w.charger()
  await b.attendre(5)
  assert.deepEqual(await couchesDuCache(b), { eteintes: ['n1'], lisibles: true }, 'le cache garde ce que le serveur a ACCEPTÉ')
})

test('LE TEST QUI COMPTE (constat 16) : un écran peint depuis le cache ne réécrit pas le cache au clic — la réponse du serveur s’en charge', async () => {
  const r = await import(RENDU)
  const cacheMod = await import(path.join(__dirname, '..', 'shared/cache-ecran.js'))
  const d = await reponseEcran({ eclatements: SEJOURS })
  let pendantLAttente = null
  const b = await monter({
    cache: r.pourLeCache(d),
    ecran: async (url, w) => {
      const barre = [...w.document.querySelectorAll('.yfe-barre')].find(x => x.dataset.ouvrir.startsWith(NOEL + '|'))
      barre.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
      const pastille = w.document.querySelector('.yfe-ev--ouvert [data-couche="n1"]')
      pastille.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
      for (let i = 0; i < 8; i++) await new Promise(res => setTimeout(res, 0))
      const c = cacheMod.lire('yield-evenements', 'u-moi', 'u-moi')
      pendantLAttente = c && c.donnees && c.donnees.couches
      return d
    }
  })
  assert.deepEqual(pendantLAttente, { eteintes: [], lisibles: true }, 'l’écran ancien n’a pas réécrit le cache')
  await b.attendre(5)
  assert.deepEqual(await couchesDuCache(b), { eteintes: ['n1'], lisibles: true }, 'la réponse fraîche, elle, garde le choix accepté')
})

test('LE TEST QUI COMPTE (constat 3) : sous les vacances de Noël 2026, les nuits de janvier 2027 disent « 2026 » — l’année de l’occurrence, servie par le serveur', async () => {
  const d = await reponseEcran({ eclatements: SEJOURS })
  const noel = d.evenements.find(e => e.cle === NOEL && e.debut.startsWith('2026-12'))
  assert.equal(noel.annee, 2026)
  const b = await monter({ ecran: async () => d })
  const nuit = await ouvrirNoel(b)
  assert.ok(nuit('2027-01-02'), 'la fixture montre le 2 janvier 2027')
  const nom = nuit('2027-01-02').getAttribute('aria-label')
  assert.match(nom, /2026 · pas encore réservée/)
  assert.doesNotMatch(nom, /2027 ·/)
  assert.match(nom, /2025 ·/)
  // Le rendu suit `e.annee` ; sans elle (vieille réponse), l'année de la nuit.
  const r = await import(RENDU)
  const data = { aujourdhui: '2026-11-09', sejours: { liste: [], premiere_nuit: '2024-01-01' } }
  assert.equal(r.pileDeLaNuit('2027-01-04', { annee: 2026, annees: [] }, data)[0].annee, 2026)
  assert.equal(r.pileDeLaNuit('2027-01-04', { annees: [] }, data)[0].annee, 2027)
})

test('LE TEST QUI COMPTE (constat 4) : une nuit bloquée sans séjour ne dit pas « pas encore réservée » sous « vendue »', async () => {
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: SEJOURS, vendues: { '2026-12-27': ['blocage-1'] } }) })
  const nuit = await ouvrirNoel(b)
  const ligne0 = lignesDe(nuit('2026-12-27'))[0]
  assert.ok(ligne0.classList.contains('yfe-sejour--occupee'), [...ligne0.classList].join(' '))
  assert.equal(ligne0.querySelector('.yfe-sejour__prix'), null, 'pas de « — »')
  assert.equal(ligne0.getAttribute('title'), null)
  const nom = nuit('2026-12-27').getAttribute('aria-label')
  assert.match(nom, /vendue/)
  assert.doesNotMatch(nom, /2026 · pas encore réservée/)
  // Une nuit libre voisine, elle, le dit toujours.
  assert.match(nuit('2026-12-26').getAttribute('aria-label'), /2026 · pas encore réservée/)
})

test('LE TEST QUI COMPTE (constat 5) : arrivé « illisible », un choix enregistré efface le message', async () => {
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: SEJOURS, couches: { eteintes: [], lisibles: false } }) })
  await ouvrirNoel(b)
  await b.cliquer(b.$('.yfe-ev--ouvert [data-couche="n1"]'))
  await b.attendre(5)
  const zone = b.$('.yfe-ev--ouvert .yfe-couches').textContent
  assert.doesNotMatch(zone, /n’a pas pu être lu/)
  assert.match(zone, /Votre choix est gardé d’un événement à l’autre/)
})

test('constat 7 : un séjour réservé le jour même dit « J0 », jamais « −0 j »', async () => {
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: [...SEJOURS, ecl('2026-12-26', 2, { vente: '2026-12-26T09:00:00Z' })] }) })
  const nuit = await ouvrirNoel(b)
  assert.equal(lignesDe(nuit('2026-12-27'))[0].querySelector('.yfe-sejour__delai').textContent, 'J0')
  assert.match(nuit('2026-12-27').getAttribute('aria-label'), /réservé le jour de l’arrivée/)
})

test('constat 8 : « Direct » se traduit, que la source soit `Offline` ou `direct` ; une source inconnue reste telle quelle', async () => {
  const r = await import(RENDU)
  const fmt = fmtDe(ES, 'es')
  const ligne = canal => ({ recul: 0, annee: 2026, etat: 'vendue', sejour: { nuits: 2, prix_nuit: 100, canal, delai: 3 } })
  assert.match(r.phraseDeLigne(ligne('Offline'), fmt), /· Directo ·/)
  assert.match(r.phraseDeLigne(ligne('direct'), fmt), /· Directo ·/)
  assert.match(r.phraseDeLigne(ligne('BookingCom'), fmt), /· Booking\.com ·/)
  assert.match(r.phraseDeLigne(ligne('Abritel'), fmt), /· Abritel ·/)
})

test('constat 9 : « séjour d’une nuit » au singulier, en toutes lettres', async () => {
  const r = await import(RENDU)
  const l = { recul: 0, annee: 2026, etat: 'vendue', sejour: { nuits: 1, prix_nuit: 100, canal: 'airbnb', delai: 3 } }
  assert.match(r.phraseDeLigne(l, fmtDe(FR, 'fr')), /2026 · séjour d’une nuit ·/)
})

test('constat 11 : l’échec s’annonce dans la région de la page, une fois ; la liste le montre sans rôle', async () => {
  const b = await monter({ ecran: async () => reponseEcran({ eclatements: SEJOURS }), couchesEcriture: async () => ({ status: 503, corps: {} }) })
  const nuit = await ouvrirNoel(b)
  await b.cliquer(b.$('.yfe-ev--ouvert [data-couche="n2"]'))
  await b.attendre(5)
  const region = b.$('[data-bind="couches-annonce"]')
  assert.equal(region.getAttribute('role'), 'status')
  assert.match(region.textContent, /n’a pas pu être enregistré/)
  assert.ok(!b.$('.yfe-liste').contains(region), 'hors de la liste, qui se repeint')
  assert.equal(b.$$('.yfe-ev--ouvert .yfe-couches [role]').length, 0)
  // Toucher une nuit repeint la liste ; le message reste visible, sans rôle.
  await b.cliquer(nuit('2026-12-23'))
  assert.match(b.$('.yfe-ev--ouvert .yfe-couches .yfe-message').textContent, /n’a pas pu être enregistré/)
  assert.equal(b.$$('.yfe-ev--ouvert .yfe-couches [role]').length, 0)
})

test('constat 12 : un recul inconnu n’entre ni dans une classe ni dans `data-couche`', async () => {
  const r = await import(RENDU)
  const fmt = fmtDe(FR, 'fr')
  fmt.money = n => `${n} €`
  const e = { annees: [{ recul: '1" onclick="x', annee: 2025, decalage: 364, ca: 0, nuits: 0 }, { recul: 7, annee: 2019, decalage: 2184, ca: 0, nuits: 0 }, { recul: 2, annee: 2024, decalage: 728, ca: 0, nuits: 0 }] }
  const html = r.rendreCouches(e, { couches: { eteintes: [] } }, fmt)
  assert.deepEqual([...html.matchAll(/data-couche="([^"]*)"/g)].map(m => m[1]), ['n2'])
  assert.doesNotMatch(html, /onclick/)
  const data = { aujourdhui: '2026-11-09', sejours: { liste: [], premiere_nuit: '2020-01-01' } }
  assert.deepEqual(r.pileDeLaNuit('2026-12-23', e, data).map(l => l.recul), [0, 2])
})

test('LE TEST QUI COMPTE (constat 15) : la page soustrait le décalage DU SERVEUR — 357 jours (calé sur l’événement), 365 (date fixe)', async () => {
  // Un seul séjour passé, du 29 au 31 décembre 2025 : avec 364 jours, le
  // 22 décembre 2026 tomberait le 23 décembre 2025, resté vide.
  const passe = [ecl('2025-12-29', 3, { vente: '2025-12-01T08:00:00Z' }), ecl('2024-06-01', 2, { prix: 90 })]
  for (const [decalage, attendu] of [[357, { '2026-12-21': 'debut', '2026-12-22': null, '2026-12-23': 'fin' }], [365, { '2026-12-29': 'debut', '2026-12-30': null, '2026-12-31': 'fin' }]]) {
    const d = await reponseEcran({ eclatements: passe })
    const noel = d.evenements.find(e => e.cle === NOEL && e.debut.startsWith('2026-12'))
    noel.annees[0].decalage = decalage
    const b = await monter({ ecran: async () => d })
    const nuit = await ouvrirNoel(b)
    for (const [date, bout] of Object.entries(attendu)) {
      const a1 = lignesDe(nuit(date))[1]
      assert.ok(a1.classList.contains('yfe-sejour--vendue'), `${decalage} : ${date}`)
      if (bout) assert.ok(a1.classList.contains('yfe-sejour--' + bout), `${decalage} : ${date} ${bout}`)
    }
    // Et la nuit d'avant le séjour passé, en face, est vide.
    const avant = Object.keys(attendu)[0]
    const veille = new Date(Date.parse(avant + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10)
    assert.ok(lignesDe(nuit(veille))[1].classList.contains('yfe-sejour--vide'), `${decalage} : ${veille}`)
  }
})

test('LE TEST QUI COMPTE (recette du 18 novembre 2026, constat 14) : la nuit choisie et la nuit focalisée passent AU-DESSUS des barres, et SOUS l’éditeur collé', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'shared/yield-evenements.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const zDe = sel => {
    const regles = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].split(',').map(x => x.trim()).includes(sel))
    const z = regles.map(m => (m[2].match(/z-index:\s*(\d+)/) || [])[1]).filter(Boolean)
    return z.length ? Number(z[z.length - 1]) : null
  }
  const barre = zDe('.yfe-sejour--vendue')
  const editeur = zDe('.yfe-editeur')
  for (const sel of ['.yfe-jour[aria-pressed="true"]', '.yfe-jour:focus-visible']) {
    const z = zDe(sel)
    assert.ok(z !== null && z > barre, `${sel} : z-index ${z} au-dessus des barres (${barre})`)
    assert.ok(z <= editeur, `${sel} : z-index ${z} pas au-dessus de l’éditeur (${editeur}), qui vient après dans la page`)
    const regle = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(m => m[1].split(',').map(x => x.trim()).includes(sel) && /z-index/.test(m[2]))
    assert.match(regle[2], /position:\s*relative/, `${sel} : un z-index sans position ne fait rien`)
  }
})
