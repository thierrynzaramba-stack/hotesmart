// tests/avis-cartes-dom.test.js — la page /avis en cartes (core/avis/cartes.js),
// en jsdom. Recette de Thierry du 7 octobre 2026 : carte unique, classement
// proprete SANS libelle en double, avis masque dit comme tel, origine de notre
// avis, trois sections dont les anciens charges a l'ouverture.

const test = require('node:test')
const assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')

let rendre, monter
test.before(async () => { ({ rendre, monter } = await import('../core/avis/cartes.js')) })

const carte = (extra = {}) => ({
  cle: 'sejour:u1', section: 'recents', bien: 'La bulle', plateforme: { cle: 'airbnb' },
  voyageur: { prenom: 'Angela', nom: 'X' }, arrivee: '2026-10-01', depart: '2026-10-03', menage_par: 'Regina',
  avis: [{ id: 'a1', masque: false, note: 10, texte: 'Parfait', extrait: null, verdict: 'positif', verdict_source: null, analyse: true, detecte: false }],
  evaluation: { booking_uid: 'u1', status: 'publiee', etat: 'publiee', echeance: null, jours_restants: null, publie_le: '2026-10-04T10:00:00Z', texte: 'Merci Angela', origine: { cle: 'ia_valide', libelle: 'rédigé par l’IA, validé par vous' }, evaluable: false },
  ...extra,
})
const donnees = (cartes, extra = {}) => ({ cartes: { attente: [], recents: [], anciens: null, ...cartes }, anciens_total: 0, ...extra })
const doc = (html) => new JSDOM(`<!doctype html><body><div id="c">${html}</div></body>`).window.document

test('LE TEST QUI COMPTE (point A) : la carte dit le sejour en tete, puis « Son avis » et « Notre avis »', () => {
  const d = doc(rendre(donnees({ recents: [carte()] }), { peutEcrire: false }))
  const li = d.querySelector('.hs-carte')
  assert.equal(li.querySelector('.hs-carte-qui').textContent, 'Angela X')
  assert.equal(li.querySelector('.badge-src').textContent, 'Airbnb')
  assert.match(li.querySelector('.hs-carte-infos').textContent, /La bulle · du 1 oct\. au 3 oct\. 2026 · ménage : Regina/)
  const blocs = [...li.querySelectorAll('.hs-carte-libelle')].map(x => x.textContent)
  assert.deepEqual(blocs, ['Son avis', 'Notre avis'])
  assert.match(li.textContent, /10\/10/)
  assert.match(li.textContent, /« Merci Angela »/)
})

test('LE TEST QUI COMPTE (point A) : le classement proprete n apparait QU UNE FOIS — le menu au droit d ecriture, le badge sinon', () => {
  const ecrit = doc(rendre(donnees({ recents: [carte()] }), { peutEcrire: true }))
  assert.equal(ecrit.querySelectorAll('select[data-requalif]').length, 1)
  assert.equal(ecrit.querySelectorAll('span.badge-prop').length, 0, 'pas de badge a cote du menu')
  assert.equal((ecrit.querySelector('.hs-carte').textContent.match(/Propreté saluée/g) || []).length, 1, 'le libelle une seule fois (l option choisie)')
  const lit = doc(rendre(donnees({ recents: [carte()] }), { peutEcrire: false }))
  assert.equal(lit.querySelectorAll('select[data-requalif]').length, 0)
  assert.equal(lit.querySelectorAll('span.badge-prop').length, 1)
})

test('LE TEST QUI COMPTE (point B) : l origine de notre avis est toujours dite', () => {
  const d = doc(rendre(donnees({ recents: [carte()] })))
  assert.equal(d.querySelector('.hs-carte-origine').textContent, 'rédigé par l’IA, validé par vous')
})

test('LE TEST QUI COMPTE (point E) : un avis masque par Airbnb se dit, sans 0/10', () => {
  const masque = carte({ avis: [{ id: 'm', masque: true }], evaluation: { booking_uid: 'u1', status: 'a_remplir', etat: 'a_remplir', jours_restants: 2, evaluable: true, origine: null, texte: null } })
  const d = doc(rendre(donnees({ attente: [{ ...masque, section: 'attente' }] }), { avecBus: true }))
  const t = d.querySelector('.hs-carte').textContent
  assert.match(t, /Avis déposé, masqué par Airbnb jusqu’à votre évaluation\./)
  assert.doesNotMatch(t, /0\/10/)
  assert.match(t, /2 jours restants/)
  const dernier = rendre(donnees({ attente: [{ ...masque, section: 'attente', evaluation: { ...masque.evaluation, jours_restants: 1 } }] }))
  assert.match(dernier, /dernier jour/)
  assert.equal(d.querySelector('[data-evaluer]').textContent, 'Évaluer Angela')
  assert.match(d.querySelector('.hs-eval-resume').textContent, /^1 évaluation vous attend\.$/)
})

test('point C : trois sections ; une evaluation expiree se dit, sans bouton', () => {
  const exp = carte({ section: 'anciens', evaluation: { booking_uid: 'u1', status: 'a_remplir', etat: 'expiree', evaluable: false, origine: null, texte: null } })
  const d = doc(rendre(donnees({ anciens: [exp] }, { anciens_total: 1 }), { avecBus: true, anciensOuverts: true }))
  assert.deepEqual([...d.querySelectorAll('.hs-section h2')].map(h => h.textContent.replace(/\s+/g, ' ').trim()), ['En attente de notation 0', 'Récents 20 derniers jours', 'Anciens 1'])
  assert.ok(d.querySelector('details[data-anciens][open]'))
  assert.match(d.querySelector('details .hs-carte').textContent, /Expirée/)
  assert.equal(d.querySelectorAll('[data-evaluer]').length, 0)
  assert.equal(d.querySelector('.hs-eval-resume').textContent, 'Rien ne vous attend.')
})

test('XSS : un texte de voyageur ne s execute jamais', () => {
  const d = doc(rendre(donnees({ recents: [carte({ voyageur: { prenom: '<img src=x onerror=alert(1)>', nom: null }, avis: [{ id: 'a', masque: false, texte: '<script>x()</script>', analyse: true }] })] })))
  assert.equal(d.querySelectorAll('img, script').length, 0)
})

test('monter : les ANCIENS ne se lisent qu a l ouverture, et une correction de proprete relit la page', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="c"></div><div id="s"></div></body>')
  global.window = dom.window
  const appels = []
  const appel = async (chemin, methode, corps) => {
    appels.push(corps ? `${methode} ${corps.action}` : chemin)
    return donnees({ recents: [carte()], anciens: chemin.includes('anciens=1') ? [] : null }, { anciens_total: 3, stats: { total: 1, moyenne: 9.6, notes: 1, positif: 1, remarque: 0, periode: '30j' } })
  }
  const c = dom.window.document.getElementById('c')
  await monter(c, { appel, peutEcrire: true, filtres: () => ({ periode: '30j' }), zoneStats: dom.window.document.getElementById('s') })
  assert.deepEqual(appels, ['avis?action=cartes&periode=30j'])
  assert.match(dom.window.document.getElementById('s').textContent, /9,6/)
  const details = c.querySelector('details[data-anciens]')
  details.open = true
  details.dispatchEvent(new dom.window.Event('toggle'))
  await new Promise(r => setTimeout(r, 0))
  assert.equal(appels[1], 'avis?action=cartes&periode=30j&anciens=1')
  const sel = c.querySelector('select[data-requalif]')
  sel.value = 'remarque'
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 0))
  assert.equal(appels[2], 'POST requalifier')
  assert.equal(appels[3], 'avis?action=cartes&periode=30j&anciens=1', 'relue, anciens toujours ouverts')
  delete global.window
})
