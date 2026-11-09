// tests/entites-juridiques-dom.test.js — la fenêtre « Facturation » de la fiche
// d'un logement (shared/entites-juridiques-vue.js), D2 bis.
// Spec : docs/specs/spec-facture-voyageur.md §4 (D2 bis), §5.1 · KB : docs/kb/entites-juridiques.md
//
// Ce que ce fichier prouve, en MONTANT la vue dans un vrai DOM :
//   1. Aucun texte en dur : avec un `t` qui rend la clé entre crochets, tout ce
//      qui s'affiche est une clé ou une donnée du serveur.
//   2. L'entité de CE logement est dite en tête — ou son absence, ou son
//      archivage (P4) ; aucune « entité par défaut ».
//   3. Les gestes portent le logement : choisir, retirer, créer (choisie pour
//      ce logement), modifier, régler la numérotation ; un membre ne voit
//      AUCUN geste (le serveur refuse de toute façon).
//   4. Le formulaire suit le type et le régime, un champ caché part vide, un
//      refus se pose sous son champ ; la numérotation auto / manuelle.
//   5. Un appel à l'ouverture ; un geste = un envoi + une relecture.
//   6. La fenêtre : voile, Échap et croix ferment, focus enfermé puis rendu.
//   7. L'ancienne page n'existe plus, ni son onglet dans les Réglages.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const racine = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(racine, 'shared/entites-juridiques-vue.js'), 'utf8')

function chargerModule () {
  const code = src.replace(/^export \{([^}]*)\}$/m, (m, noms) => `module.exports = {${noms}}`)
  const m = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', code)(m, m.exports)
  return m.exports
}
const V = chargerModule()

const t = (k, v) => `[${k}${v ? ' ' + Object.values(v).join(' ') : ''}]`
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const BIEN = 'aaaaaaaa-0000-4000-8000-000000000001'
const E1 = { id: 'e1', type: 'personne_physique', nom: 'Thierry Exemple', adresse_ligne1: '1 rue Haute', code_postal: '65200', ville: 'Bagnères', regime_tva: 'exonere', taux_tva: null, archivee_le: null, debut_exercice: null, numerotation_factures: 'auto' }
const E2 = { id: 'e2', type: 'societe', forme_juridique: 'SCI', nom: 'SCI Le Florian', regime_tva: 'assujetti', taux_tva: 10, archivee_le: null, debut_exercice: '07-01', numerotation_factures: 'auto' }
const ETAT = () => ({
  titulaire: true,
  bien: { id: BIEN, nom: 'La bulle', entite_id: 'e2' },
  entites: [{ ...E1 }, { ...E2 }],  // des COPIES : un test qui modifie une entite ne contamine pas les suivants
  numerotations: { e1: { prefixe: 'F', prochain_numero: 1, dernier_emis: null, fige: false, prochain: 'F-2026-0001' },
    e2: { prefixe: 'HS', prochain_numero: 12, dernier_emis: 11, fige: true, prochain: 'HS-2026-0012' } }
})

async function monter (etat = ETAT(), { ecrire, surChangement } = {}) {
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  const doc = dom.window.document
  const appels = []
  const lectures = []
  const api = {
    lire: async (bien) => { lectures.push(bien); return JSON.parse(JSON.stringify(etat)) },
    ecrire: ecrire || (async (corps) => { appels.push(corps); return { ok: true } })
  }
  global.document = doc
  await V.monterFenetre({ racine: doc.getElementById('r'), api, bien: BIEN, t, esc, langue: 'fr', surChangement })
  return { doc, r: doc.getElementById('r'), appels, lectures, win: dom.window }
}
const attendre = () => new Promise(r => setTimeout(r, 0))

function textesVisibles (el) {
  const out = []
  const walk = (n) => {
    if (n.nodeType === 3) { const s = n.textContent.trim(); if (s) out.push(s) }
    else if (n.nodeType === 1 && !n.hidden) n.childNodes.forEach(walk)
  }
  walk(el)
  return out
}

test('LE TEST QUI COMPTE : aucun texte en dur — tout est une clé ej.* ou une donnée du serveur', async () => {
  const { r } = await monter()
  const donnees = ['Thierry Exemple', 'SCI Le Florian', 'SCI', '1 rue Haute, 65200 Bagnères', 'HS-2026-0012', 'F-2026-0001']
  for (const s of textesVisibles(r)) {
    assert.ok(s.startsWith('[') || donnees.some(d => s.includes(d)) || s === ']', `texte en dur : « ${s} »`)
  }
})

test('LE TEST QUI COMPTE : l\'entité de CE logement est dite en tête, et marquée dans la liste', async () => {
  const { r, lectures } = await monter()
  assert.deepEqual(lectures, [BIEN], 'la fenêtre lit LE logement de la fiche')
  assert.equal(r.querySelector('.ej-actuelle').textContent, '[ej.actuelle SCI Le Florian]')
  const cartes = [...r.querySelectorAll('.ej-carte')]
  assert.deepEqual(cartes.map(c => c.dataset.entite), ['e1', 'e2'])
  assert.ok(cartes[1].textContent.includes('[ej.badge_actuelle]'))
  assert.ok(!cartes[0].textContent.includes('[ej.badge_actuelle]'))
  // Celle du logement : « Retirer » ; l'autre : « Choisir ».
  assert.ok(cartes[1].querySelector('[data-action="retirer"]') && !cartes[1].querySelector('[data-action="choisir"]'))
  assert.ok(cartes[0].querySelector('[data-action="choisir"]') && !cartes[0].querySelector('[data-action="retirer"]'))
  assert.doesNotMatch(r.innerHTML, /default|defaut/i, 'plus aucune entité par défaut')
})

test('LE TEST QUI COMPTE : sans entité, la fenêtre le DIT — aucun repli sur une autre', async () => {
  const etat = ETAT()
  etat.bien.entite_id = null
  const { r } = await monter(etat)
  assert.equal(r.querySelector('.ej-alerte').textContent, '[ej.aucune]')
  assert.equal(r.querySelector('.ej-actuelle'), null)
  assert.equal(r.querySelectorAll('[data-action="retirer"]').length, 0)
  assert.equal(r.querySelectorAll('[data-action="choisir"]').length, 2)
})

test('une entité ARCHIVÉE sur ce logement : la fenêtre dit qu\'il ne facture plus, et ne la propose pas', async () => {
  const etat = ETAT()
  etat.entites.push({ ...E1, id: 'e3', nom: 'Ancienne SARL', archivee_le: '2026-11-01T00:00:00Z' })
  etat.bien.entite_id = 'e3'
  const { r } = await monter(etat)
  assert.equal(r.querySelector('.ej-alerte').textContent, '[ej.actuelle_archivee Ancienne SARL]')
  assert.equal(r.querySelector('.ej-carte[data-entite="e3"]'), null)
})

test('un compte sans entité : la fenêtre le dit, et propose d\'en créer une', async () => {
  const { r } = await monter({ titulaire: true, bien: { id: BIEN, nom: 'La bulle', entite_id: null }, entites: [], numerotations: {} })
  assert.ok(r.textContent.includes('[ej.empty_text]'))
  assert.ok(r.querySelector('[data-action="ajouter"]'))
})

test('LE TEST QUI COMPTE : un membre (non titulaire) ne voit AUCUN geste', async () => {
  const etat = ETAT()
  etat.titulaire = false
  etat.numerotations.e2.fige = false
  const { r } = await monter(etat)
  assert.equal(r.querySelectorAll('button').length, 0, 'ni choisir, ni retirer, ni modifier, ni régler, ni créer')
  assert.equal(r.querySelector('.ej-actuelle').textContent, '[ej.actuelle SCI Le Florian]', 'mais il lit l\'entité')
})

test('les gestes portent le logement : choisir, retirer', async () => {
  const { r, appels } = await monter()
  r.querySelector('.ej-carte[data-entite="e1"] [data-action="choisir"]').click()
  await attendre(); await attendre()
  assert.deepEqual(appels[0], { action: 'rattacher', entite_id: 'e1', property_uuid: BIEN })
  r.querySelector('.ej-carte[data-entite="e2"] [data-action="retirer"]').click()
  await attendre(); await attendre()
  assert.deepEqual(appels[1], { action: 'rattacher', entite_id: null, property_uuid: BIEN })
})

test('LE TEST QUI COMPTE : créer depuis la fenêtre — le formulaire suit le type et le régime, un champ caché part VIDE', async () => {
  const { r, appels } = await monter()
  r.querySelector('[data-action="ajouter"]').click()
  const f = r.querySelector('.ej-carte[data-entite=""] form')
  const visible = (api) => !f.querySelector(`[data-champ="${api}"]`).hidden
  assert.deepEqual([visible('forme_juridique'), visible('capital'), visible('taux_tva')], [false, false, false])
  f.querySelector('input[value="societe"]').checked = true
  f.querySelector('#ej-regime').value = 'assujetti'
  f.dispatchEvent(new f.ownerDocument.defaultView.Event('change', { bubbles: true }))
  assert.deepEqual([visible('forme_juridique'), visible('capital'), visible('taux_tva')], [true, true, true])
  f.querySelector('#ej-nom').value = 'SCI Neuve'
  f.querySelector('#ej-forme').value = 'SCI'
  f.querySelector('#ej-taux').value = '5,5'
  f.querySelector('input[value="personne_physique"]').checked = true
  f.querySelector('#ej-regime').value = 'exonere'
  f.dispatchEvent(new f.ownerDocument.defaultView.Event('change', { bubbles: true }))
  f.querySelector('#ej-exercice-jour').value = '01'
  f.querySelector('#ej-exercice-mois').value = '07'
  f.dispatchEvent(new f.ownerDocument.defaultView.Event('submit', { cancelable: true }))
  await attendre()
  assert.equal(appels.length, 1)
  assert.equal(appels[0].action, 'creer')
  assert.equal(appels[0].property_uuid, BIEN, 'créée depuis CE logement')
  const e = appels[0].entite
  assert.deepEqual([e.type, e.nom, e.regime_tva, e.forme_juridique, e.taux_tva, e.debut_exercice, e.numerotation_factures],
    ['personne_physique', 'SCI Neuve', 'exonere', '', '', '07-01', 'auto'])
})

test('modifier : le formulaire s\'ouvre sur la carte, garde le choix de numérotation, et part avec l\'id', async () => {
  const etat = ETAT()
  etat.entites[0].numerotation_factures = 'manuel'
  delete etat.numerotations.e1
  const { r, appels } = await monter(etat)
  r.querySelector('.ej-carte[data-entite="e1"] [data-action="modifier"]').click()
  const f = r.querySelector('.ej-carte[data-entite="e1"] form')
  assert.equal(f.querySelector('#ej-nom').value, 'Thierry Exemple')
  f.dispatchEvent(new f.ownerDocument.defaultView.Event('submit', { cancelable: true }))
  await attendre()
  assert.equal(appels[0].action, 'modifier')
  assert.equal(appels[0].id, 'e1')
  assert.equal(appels[0].entite.numerotation_factures, 'manuel', 'la modification ne remet pas en automatique')
})

test('la numérotation : automatique réglable, figée sans bouton, manuelle sans suite ; le numéro ne se coupe pas', async () => {
  const etat = ETAT()
  const { r } = await monter(etat)
  const c1 = r.querySelector('.ej-carte[data-entite="e1"]')
  const c2 = r.querySelector('.ej-carte[data-entite="e2"]')
  assert.ok(c1.querySelector('[data-action="numerotation"]'))
  assert.ok(!c2.querySelector('[data-action="numerotation"]'), 'figée : plus de réglage')
  assert.ok(c2.textContent.includes('[ej.num_fige]'))
  assert.equal(c2.querySelector('.ej-numero').textContent, 'HS-2026-0012', 'le numéro dans son propre élément')
  assert.match(src, /\.ej-numero \{ white-space: nowrap/)
  const manuel = ETAT()
  manuel.entites[0].numerotation_factures = 'manuel'
  delete manuel.numerotations.e1
  const m = await monter(manuel)
  const cm = m.r.querySelector('.ej-carte[data-entite="e1"]')
  assert.ok(cm.textContent.includes('[ej.num_manual_info]'))
  assert.ok(!cm.textContent.includes('F-2026-0001'))
})

test('régler la numérotation : le geste part avec le logement ; un refus « suite figée » le dit dans le formulaire', async () => {
  const refus = Object.assign(new Error('x'), { code: 'suite_figee', status: 409 })
  const appels = []
  const { r } = await monter(ETAT(), { ecrire: async (corps) => { appels.push(corps); throw refus } })
  r.querySelector('.ej-carte[data-entite="e1"] [data-action="numerotation"]').click()
  const f = r.querySelector('.ej-carte[data-entite="e1"] form.ej-form--num')
  f.querySelector('#ej-prefixe').value = 'HS'
  f.querySelector('#ej-prochain').value = '12'
  f.dispatchEvent(new f.ownerDocument.defaultView.Event('submit', { cancelable: true }))
  await attendre()
  assert.deepEqual(appels, [{ action: 'numerotation', id: 'e1', numerotation: { prefixe: 'HS', prochain_numero: 12 }, property_uuid: BIEN }])
  assert.equal(f.querySelector('.ej-message').textContent, '[ej.err_suite_figee]')
})

test('le choix de numérotation part avec l\'entité', () => {
  const dom = new JSDOM(`<div>${V.formulaireHtml(null, t, esc, 'fr')}</div>`)
  const f = dom.window.document.querySelector('form.ej-form')
  assert.equal(f.querySelector('input[name="ej-numerotation"]:checked').value, 'auto')
  f.querySelector('input[name="ej-numerotation"][value="manuel"]').checked = true
  assert.equal(V.valeursDuFormulaire(f).numerotation_factures, 'manuel')
})

test('le début d\'exercice : vide s\'il n\'est pas choisi, « incomplet » (donc refusé) s\'il manque le jour ou le mois', () => {
  const dom = new JSDOM(`<div>${V.formulaireHtml(null, t, esc, 'fr')}</div>`)
  const f = dom.window.document.querySelector('form.ej-form')
  assert.equal(V.valeursDuFormulaire(f).debut_exercice, '', 'aucune année civile supposée')
  f.querySelector('#ej-exercice-mois').value = '01'
  assert.equal(V.valeursDuFormulaire(f).debut_exercice, 'incomplet')
  f.querySelector('#ej-exercice-jour').value = '15'
  assert.equal(V.valeursDuFormulaire(f).debut_exercice, '01-15')
})

test('un refus nommé se pose sous SON champ, avec aria-invalid', () => {
  const dom = new JSDOM(`<div>${V.formulaireHtml(E2, t, esc, 'fr')}</div>`)
  const f = dom.window.document.querySelector('form.ej-form')
  V.montrerRefus(f, { code: 'entree_invalide', champ: 'siret' }, t)
  const bloc = f.querySelector('[data-champ="siret"]')
  assert.equal(bloc.querySelector('.ej-erreur').hidden, false)
  assert.equal(bloc.querySelector('.ej-erreur').textContent, '[ej.err_champ]')
  assert.equal(bloc.querySelector('input').getAttribute('aria-invalid'), 'true')
  V.montrerRefus(f, { code: 'panne' }, t)
  assert.equal(f.querySelector('.ej-message').textContent, '[ej.err_panne]')
  assert.equal(bloc.querySelector('input').getAttribute('aria-invalid'), null, 'l\'ancien refus est effacé')
})

test('un geste refusé sans formulaire : la fenêtre se repeint depuis l\'état lu, et le bandeau le dit', async () => {
  const refus = async () => { const e = new Error('archivee'); e.status = 409; e.code = 'archivee'; throw e }
  const { r } = await monter(ETAT(), { ecrire: refus })
  r.querySelector('.ej-carte[data-entite="e1"] [data-action="choisir"]').click()
  await attendre(); await attendre()
  assert.equal(r.querySelector('.ej-bandeau').textContent, '[ej.err_archivee]')
  assert.ok(r.querySelector('.ej-carte[data-entite="e2"] [data-action="retirer"]'), 'l\'état lu est toujours celui affiché')
})

test('LE TEST QUI COMPTE : un appel à l\'ouverture ; un geste = un envoi + une relecture, et la fiche est prévenue', async () => {
  // La case PERFORMANCE de la spec (§9) : on compte les appels.
  const etat = ETAT()
  const compte = { lire: 0, ecrire: 0 }
  const recus = []
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  global.document = dom.window.document
  const api = {
    lire: async () => { compte.lire++; return JSON.parse(JSON.stringify(etat)) },
    ecrire: async () => { compte.ecrire++; return { ok: true } }
  }
  const r = dom.window.document.getElementById('r')
  await V.monterFenetre({ racine: r, api, bien: BIEN, t, esc, langue: 'fr', surChangement: (e) => recus.push(e.bien.entite_id) })
  assert.deepEqual(compte, { lire: 1, ecrire: 0 })
  r.querySelector('.ej-carte[data-entite="e1"] [data-action="choisir"]').click()
  await attendre(); await attendre()
  assert.deepEqual(compte, { lire: 2, ecrire: 1 })
  assert.deepEqual(recus, ['e2'], 'la fiche reçoit l\'état relu')
})

test('une lecture refusée ou en panne : la fenêtre le dit, sans liste', async () => {
  for (const [status, cle] of [[403, '[ej.no_access]'], [503, '[ej.err_panne]']]) {
    const dom = new JSDOM('<!doctype html><div id="r"></div>')
    global.document = dom.window.document
    const r = dom.window.document.getElementById('r')
    const api = { lire: async () => { const e = new Error('x'); e.status = status; throw e }, ecrire: async () => ({}) }
    await V.monterFenetre({ racine: r, api, bien: BIEN, t, esc })
    assert.equal(r.textContent.trim(), cle)
    assert.equal(r.querySelectorAll('button').length, 0)
  }
})

test('une donnée du serveur est échappée, jamais interprétée', async () => {
  const etat = ETAT()
  etat.entites[0].nom = '<img src=x onerror=alert(1)>'
  etat.bien.entite_id = 'e1'
  const { r } = await monter(etat)
  assert.equal(r.querySelector('img'), null)
  assert.ok(r.textContent.includes('<img src=x onerror=alert(1)>'))
})

test('LE TEST QUI COMPTE : la fenêtre — voile, Échap et croix ferment, la tabulation reste dedans, le focus revient', async () => {
  const dom = new JSDOM('<!doctype html><button id="ouvrir">o</button><button id="apres">a</button>')
  const doc = dom.window.document
  global.document = doc
  const api = { lire: async () => ETAT(), ecrire: async () => ({ ok: true }) }
  let fermetures = 0
  doc.getElementById('ouvrir').focus()
  const f = V.ouvrirFenetre({ doc, api, bien: BIEN, t, esc, surFermeture: () => { fermetures++ } })
  await f.pret
  const boite = doc.querySelector('.ej-fenetre')
  assert.equal(boite.getAttribute('role'), 'dialog')
  assert.equal(boite.getAttribute('aria-modal'), 'true')
  assert.ok(doc.getElementById('ej-styles'), 'les styles sont posés une fois')
  assert.ok(boite.querySelector('.ej-carte'), 'le contenu est monté dans la fenêtre')
  // Tab depuis le dernier élément revient au premier.
  const focusables = [...boite.querySelectorAll('button, input, select')]
  focusables[focusables.length - 1].focus()
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  assert.equal(doc.activeElement, focusables[0], 'la tabulation est enfermée')
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(doc.querySelector('.ej-fenetre'), null)
  assert.equal(doc.querySelector('.ej-voile'), null)
  assert.equal(doc.activeElement, doc.getElementById('ouvrir'), 'le focus revient d\'où il venait')
  assert.equal(fermetures, 1)
  // La croix et le voile ferment aussi ; les styles ne sont pas posés deux fois.
  const g = V.ouvrirFenetre({ doc, api, bien: BIEN, t, esc })
  await g.pret
  doc.querySelector('.ej-fenetre [data-action="fermer"]').click()
  assert.equal(doc.querySelector('.ej-fenetre'), null)
  const h = V.ouvrirFenetre({ doc, api, bien: BIEN, t, esc })
  await h.pret
  doc.querySelector('.ej-voile').click()
  assert.equal(doc.querySelector('.ej-fenetre'), null)
  assert.equal(doc.querySelectorAll('#ej-styles').length, 1)
})

test('LE TEST QUI COMPTE : l\'ancienne page n\'existe plus, ni son onglet, et la vue n\'a aucun hexa', () => {
  assert.equal(fs.existsSync(path.join(racine, 'pages/entites-juridiques.html')), false)
  const settings = fs.readFileSync(path.join(racine, 'pages/settings.html'), 'utf8')
  assert.doesNotMatch(settings, /entites-juridiques/)
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /#[0-9a-fA-F]{3,8}\b/, 'aucun hexa dans la vue')
  assert.doesNotMatch(src, /window\.confirm|alert\(/)
})

test('les refus de la fenêtre ne réveillent pas la barre d\'erreur générique (recette du 9 novembre 2026)', () => {
  // La fenêtre dit elle-même ses refus (sous le champ, dans le bandeau) : le
  // client les déclare « gérés », et la barre ne les répète pas
  // (tests/barre-erreur-prod.test.js prouve le côté barre).
  const client = fs.readFileSync(path.join(racine, 'shared/api-client.js'), 'utf8')
  const bloc = client.slice(client.indexOf('entitesJuridiques: {'), client.indexOf('}', client.indexOf('entitesJuridiques: {') + 30) + 200)
  assert.match(bloc, /lire: \(bien\) => apiCall\(`entites-juridiques\?bien=\$\{encodeURIComponent\(bien\)\}`, 'GET', null, \{ refusGeres: \[400, 404, 409, 503\] \}\)/)
  assert.match(bloc, /ecrire: \(corps\) => apiCall\('entites-juridiques', 'POST', corps, \{ refusGeres: \[400, 404, 409, 503\] \}\)/)
  assert.match(client, /const gere = Array\.isArray\(refusGeres\) && refusGeres\.includes\(res\.status\)/)
  assert.match(client, /if \(gere\) erreur\.gere = true/)
  assert.match(client, /logger\.error\('API', err\.message, \{ endpoint, \.\.\.\(err && err\.gere \? \{ gere: true \} : \{\}\) \}\)/)
})

