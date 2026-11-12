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
