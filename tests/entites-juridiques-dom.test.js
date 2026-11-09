// tests/entites-juridiques-dom.test.js — l'écran « Entités juridiques »
// (pages/entites-juridiques.html + shared/entites-juridiques-vue.js).
// Spec : docs/specs/spec-facture-voyageur.md §5.1 · KB : docs/kb/entites-juridiques.md
//
// Ce que ce fichier prouve, en MONTANT la vue dans un vrai DOM :
//   1. Aucun texte en dur : avec un `t` qui rend la clé entre crochets, tout ce
//      qui s'affiche est une clé ou une donnée du serveur.
//   2. Le formulaire suit le type et le régime (forme, capital, RCS pour une
//      société ; taux pour un assujetti), et un champ caché part VIDE.
//   3. Le début d'exercice part en « MM-JJ », vide s'il n'est pas choisi.
//   4. Les gestes : créer, rattacher un logement, archiver SEULEMENT après
//      confirmation ; un refus nommé se pose sous son champ.
//   5. La page : non délégable AVANT tout, nav.js, aucun hexa.
//   6. La numérotation (Q5 bis) : le choix automatique / manuelle part avec
//      l'entité ; en automatique, réglable avant la première facture de
//      l'année, figée ensuite ; en manuelle, aucune suite affichée.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const racine = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(racine, 'shared/entites-juridiques-vue.js'), 'utf8')
const page = fs.readFileSync(path.join(racine, 'pages/entites-juridiques.html'), 'utf8')

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

const E1 = { id: 'e1', type: 'personne_physique', nom: 'Thierry Exemple', adresse_ligne1: '1 rue Haute', code_postal: '65200', ville: 'Bagnères', regime_tva: 'exonere', taux_tva: null, par_defaut: true, archivee_le: null, debut_exercice: null }
const E2 = { id: 'e2', type: 'societe', forme_juridique: 'SCI', nom: 'SCI Le Florian', regime_tva: 'assujetti', taux_tva: 10, par_defaut: false, archivee_le: null, debut_exercice: '07-01' }
const E3 = { id: 'e3', type: 'societe', nom: 'Ancienne SARL', regime_tva: 'franchise', par_defaut: false, archivee_le: '2026-11-01T00:00:00Z' }
const ETAT = () => ({
  titulaire: true,
  entites: [E1, E2, E3],
  biens: [{ id: 'b1', nom: 'La bulle', entite_id: null }, { id: 'b2', nom: 'Cœur de vie 23', entite_id: 'e2' }],
  numerotations: { e1: { prefixe: 'F', prochain_numero: 1, dernier_emis: null, fige: false, prochain: 'F-2026-0001' },
    e2: { prefixe: 'HS', prochain_numero: 12, dernier_emis: 11, fige: true, prochain: 'HS-2026-0012' } }
})

async function monter (etat = ETAT(), { confirmer = async () => true, ecrire } = {}) {
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  const doc = dom.window.document
  const appels = []
  const api = {
    lire: async () => JSON.parse(JSON.stringify(etat)),
    ecrire: ecrire || (async (corps) => { appels.push(corps); return { ok: true } })
  }
  // La vue n'utilise que `racine` et ses descendants.
  global.document = doc
  await V.monterEntites({ racine: doc.getElementById('r'), api, t, esc, confirmer, langue: 'fr' })
  return { doc, r: doc.getElementById('r'), appels, win: dom.window }
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
  const donnees = ['Thierry Exemple', 'SCI Le Florian', 'Ancienne SARL', 'La bulle', 'Cœur de vie 23', 'SCI',
    '1 rue Haute, 65200 Bagnères', '(1)']
  for (const s of textesVisibles(r)) {
    const ok = s.startsWith('[') || donnees.some(d => s.includes(d))
    assert.ok(ok, `texte en dur : « ${s} »`)
  }
})

test('la liste : badge par défaut, numérotation, archivées repliées, logements avec l\'entité par défaut nommée', async () => {
  const { r } = await monter()
  const cartes = [...r.querySelectorAll('.ej-carte')]
  assert.deepEqual(cartes.map(c => c.dataset.entite), ['e1', 'e2'], 'les actives seulement')
  assert.ok(cartes[0].textContent.includes('[ej.default_badge]'))
  assert.ok(!cartes[1].textContent.includes('[ej.default_badge]'))
  assert.ok(cartes[1].textContent.includes('HS-2026-0012'))
  assert.ok(cartes[1].textContent.includes('[ej.tva_assujetti 10]'))
  assert.ok(cartes[1].textContent.includes('[ej.exercice_label 01/07]'))
  assert.ok(!cartes[0].querySelector('[data-action="defaut"]'), 'déjà par défaut : pas de bouton')
  // e1 : aucune facture cette année, la suite se règle ; e2 : figée.
  assert.ok(cartes[0].querySelector('[data-action="numerotation"]'))
  assert.ok(!cartes[1].querySelector('[data-action="numerotation"]'), 'figée : plus de réglage')
  assert.ok(cartes[1].textContent.includes('[ej.num_fige]'))
  const arch = r.querySelector('details.ej-archivees')
  assert.ok(arch.textContent.includes('Ancienne SARL'))
  const sel = r.querySelector('select[data-bien="b1"]')
  assert.equal(sel.value, '')
  assert.ok(sel.options[0].textContent.includes('Thierry Exemple'), 'l\'option vide nomme l\'entité par défaut')
  assert.deepEqual([...sel.options].map(o => o.value), ['', 'e1', 'e2'], 'pas d\'entité archivée proposée')
  assert.equal(r.querySelector('select[data-bien="b2"]').value, 'e2')
})

test('le compte sans entité : l\'écran le dit, et propose d\'en ajouter une', async () => {
  const { r } = await monter({ titulaire: true, entites: [], biens: [], numerotations: {} })
  assert.ok(r.textContent.includes('[ej.empty_title]'))
  assert.ok(r.querySelector('[data-action="ajouter"]'))
  assert.ok(r.textContent.includes('[ej.biens_vide]'))
})

test('LE TEST QUI COMPTE : le formulaire suit le type et le régime ; un champ caché part VIDE', async () => {
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
  // Retour en personne physique exonérée : forme et taux ne partent plus.
  f.querySelector('input[value="personne_physique"]').checked = true
  f.querySelector('#ej-regime').value = 'exonere'
  f.dispatchEvent(new f.ownerDocument.defaultView.Event('change', { bubbles: true }))
  f.querySelector('#ej-exercice-jour').value = '01'
  f.querySelector('#ej-exercice-mois').value = '07'
  f.dispatchEvent(new f.ownerDocument.defaultView.Event('submit', { cancelable: true }))
  await attendre()
  assert.equal(appels.length, 1)
  assert.equal(appels[0].action, 'creer')
  const e = appels[0].entite
  assert.deepEqual([e.type, e.nom, e.regime_tva, e.forme_juridique, e.taux_tva, e.debut_exercice],
    ['personne_physique', 'SCI Neuve', 'exonere', '', '', '07-01'])
  assert.equal(e.numerotation_factures, 'auto', 'automatique par défaut')
})

test('LE TEST QUI COMPTE : le choix de numérotation part avec l\'entité, et se relit à la modification', () => {
  const dom = new JSDOM(`<div>${V.formulaireHtml(null, t, esc, 'fr')}</div>`)
  const f = dom.window.document.querySelector('form.ej-form')
  assert.equal(f.querySelector('input[name="ej-numerotation"]:checked').value, 'auto')
  f.querySelector('input[name="ej-numerotation"][value="manuel"]').checked = true
  assert.equal(V.valeursDuFormulaire(f).numerotation_factures, 'manuel')
  const dom2 = new JSDOM(`<div>${V.formulaireHtml({ ...E1, numerotation_factures: 'manuel' }, t, esc, 'fr')}</div>`)
  const f2 = dom2.window.document.querySelector('form.ej-form')
  assert.equal(V.valeursDuFormulaire(f2).numerotation_factures, 'manuel', 'la modification ne remet pas en automatique')
})

test('une entité en numérotation manuelle : ni suite ni réglage, une phrase qui dit que le numéro se saisit à l\'émission', async () => {
  const etat = ETAT()
  etat.entites[0] = { ...E1, numerotation_factures: 'manuel' }
  delete etat.numerotations.e1
  const { r } = await monter(etat)
  const c = r.querySelector('.ej-carte[data-entite="e1"]')
  assert.ok(c.textContent.includes('[ej.num_manual_info]'))
  assert.ok(!c.textContent.includes('F-2026-0001'))
  assert.ok(!c.querySelector('[data-action="numerotation"]'))
})

test('régler la numérotation : le geste part ; un refus « suite figée » le dit dans le formulaire', async () => {
  const refus = Object.assign(new Error('x'), { code: 'suite_figee', status: 409 })
  const appels = []
  const { r } = await monter(ETAT(), { ecrire: async (corps) => { appels.push(corps); throw refus } })
  const c = r.querySelector('.ej-carte[data-entite="e1"]')
  c.querySelector('[data-action="numerotation"]').click()
  const f = c.querySelector('form.ej-form--num')
  f.querySelector('#ej-prefixe').value = 'HS'
  f.querySelector('#ej-prochain').value = '12'
  f.dispatchEvent(new f.ownerDocument.defaultView.Event('submit', { cancelable: true }))
  await attendre()
  assert.deepEqual(appels, [{ action: 'numerotation', id: 'e1', numerotation: { prefixe: 'HS', prochain_numero: 12 } }])
  assert.equal(f.querySelector('.ej-message').textContent, '[ej.err_suite_figee]')
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

test('les gestes : rattacher un logement, archiver SEULEMENT après confirmation', async () => {
  const non = await monter(ETAT(), { confirmer: async () => false })
  non.r.querySelector('.ej-carte[data-entite="e2"] [data-action="archiver"]').click()
  await attendre(); await attendre()
  assert.equal(non.appels.length, 0, 'refusé : rien ne part')

  const { r, appels, win } = await monter()
  const sel = r.querySelector('select[data-bien="b1"]')
  sel.value = 'e2'
  sel.dispatchEvent(new win.Event('change'))
  await attendre()
  assert.deepEqual(appels[0], { action: 'rattacher', property_uuid: 'b1', entite_id: 'e2' })
  await attendre()
  const sel2 = r.querySelector('select[data-bien="b2"]')
  sel2.value = ''
  sel2.dispatchEvent(new win.Event('change'))
  await attendre()
  assert.deepEqual(appels[1], { action: 'rattacher', property_uuid: 'b2', entite_id: null }, 'retour à l\'entité par défaut')
  await attendre()
  r.querySelector('.ej-carte[data-entite="e2"] [data-action="archiver"]').click()
  await attendre(); await attendre()
  assert.deepEqual(appels[2], { action: 'archiver', id: 'e2' })
})

test('un logement rattaché à une entité ARCHIVÉE le montre, et revenir au défaut est un vrai geste', async () => {
  const etat = ETAT()
  etat.biens[0].entite_id = 'e3'
  const { r, appels, win } = await monter(etat)
  const sel = r.querySelector('select[data-bien="b1"]')
  assert.equal(sel.value, 'e3')
  assert.ok(sel.selectedOptions[0].textContent.includes('[ej.bien_archivee Ancienne SARL]'))
  assert.equal(sel.selectedOptions[0].disabled, true, 'on ne la choisit pas de nouveau')
  sel.value = ''
  sel.dispatchEvent(new win.Event('change'))
  await attendre()
  assert.deepEqual(appels[0], { action: 'rattacher', property_uuid: 'b1', entite_id: null })
})

test('LE TEST QUI COMPTE : un appel pour peindre l\'écran ; un geste = un envoi + une relecture', async () => {
  // La case PERFORMANCE de la spec (§9, point 7) : on compte les appels.
  const etat = ETAT()
  const compte = { lire: 0, ecrire: 0 }
  const dom = new JSDOM('<!doctype html><div id="r"></div>')
  global.document = dom.window.document
  const api = {
    lire: async () => { compte.lire++; return JSON.parse(JSON.stringify(etat)) },
    ecrire: async () => { compte.ecrire++; return { ok: true } }
  }
  const r = dom.window.document.getElementById('r')
  await V.monterEntites({ racine: r, api, t, esc, confirmer: async () => true, langue: 'fr' })
  assert.deepEqual(compte, { lire: 1, ecrire: 0 })
  r.querySelector('.ej-carte[data-entite="e2"] [data-action="defaut"]').click()
  await attendre(); await attendre()
  assert.deepEqual(compte, { lire: 2, ecrire: 1 })
})

test('un rattachement refusé : le menu revient à la valeur enregistrée, et le bandeau le dit', async () => {
  const refus = async () => { const e = new Error('archivee'); e.status = 409; e.code = 'archivee'; throw e }
  const { r, win } = await monter(ETAT(), { ecrire: refus })
  const sel = r.querySelector('select[data-bien="b2"]')
  sel.value = 'e1'
  sel.dispatchEvent(new win.Event('change'))
  await attendre(); await attendre()
  assert.equal(r.querySelector('select[data-bien="b2"]').value, 'e2', 'la valeur refusée ne reste pas affichée')
  assert.equal(r.querySelector('.ej-bandeau').textContent, '[ej.err_archivee]')
})

test('une donnée du serveur est échappée, jamais interprétée', async () => {
  const etat = ETAT()
  etat.entites[0].nom = '<img src=x onerror=alert(1)>'
  const { r } = await monter(etat)
  assert.equal(r.querySelector('img'), null)
  assert.ok(r.textContent.includes('<img src=x onerror=alert(1)>'))
})

test('LE TEST QUI COMPTE : la page est non délégable AVANT tout, charge nav.js, sans hexa ni service worker', () => {
  const script = page.slice(page.indexOf('<script type="module">'))
  const iGarde = script.indexOf('await exigerCompteProprePage(')
  const iAutre = script.indexOf("import { requireAuth }")
  assert.ok(iGarde > 0 && iGarde < iAutre, 'la garde de compte passe avant le reste')
  assert.match(page, /<script src="\/shared\/nav\.js"><\/script>/)
  const sansCommentaires = page.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.doesNotMatch(sansCommentaires, /#[0-9a-fA-F]{3,8}\b/, 'aucun hexa')
  assert.doesNotMatch(page, /serviceWorker\.register/)
  assert.doesNotMatch(src, /#[0-9a-fA-F]{6}\b/, 'aucun hexa dans la vue')
})
