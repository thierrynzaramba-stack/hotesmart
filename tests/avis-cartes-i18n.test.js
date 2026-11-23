// tests/avis-cartes-i18n.test.js — les textes des cartes d'avis vivent dans
// shared/i18n/*.json, et le repli francais du module leur est IDENTIQUE.
//
// ⚠ POURQUOI CE TEST EXISTE. `core/avis/cartes.js` porte un repli francais
// (`TEXTES_FR`) pour s'afficher sans la page (tests, autre hote) ; la page lui
// passe `I18n.t`. Deux copies d'un meme texte divergent toujours : celle-ci ne
// peut plus diverger sans rougir. Et une cle utilisee par le module mais
// absente d'une langue afficherait la CLE a l'ecran (« avis.recents »).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const langue = (l) => JSON.parse(fs.readFileSync(path.join(racine, `shared/i18n/${l}.json`), 'utf8'))

test('le repli francais du module est IDENTIQUE a shared/i18n/fr.json', async () => {
  const { TEXTES_FR } = await import('../core/avis/cartes.js')
  const fr = langue('fr')
  const cles = Object.keys(TEXTES_FR)
  assert.ok(cles.length > 50, `trop peu de textes (${cles.length}) : l extraction ne mesure rien`)
  for (const k of cles) assert.equal(fr[k], TEXTES_FR[k], `« ${k} » differe entre le module et fr.json`)
})

test('chaque cle que le module demande existe dans les trois langues, non vide', async () => {
  const src = fs.readFileSync(path.join(racine, 'core/avis/cartes.js'), 'utf8')
  // Les cles ecrites en toutes lettres, et les familles construites (`'avis.v_' + v`).
  const directes = [...src.matchAll(/T\('(avis\.[a-z0-9_]*[a-z0-9])'\s*[,)]/g)].map(m => m[1])
  const familles = {
    'avis.v_': ['positif', 'remarque', 'rien_signale'],
    'avis.etat_': ['a_remplir', 'soumise_prestataire', 'a_valider', 'publiee', 'echec_publication', 'expiree', 'abandonnee', 'evaluee_ailleurs'],
    'avis.origine_': ['humain', 'ia', 'ia_valide', 'ia_presta', 'ia_auto', 'ailleurs', 'ia_inconnue'],
    'avis.p_': ['sms', 'email', 'oral', 'message'],
    'avis.recu_': ['sms', 'email', 'oral', 'message'],
  }
  for (const prefixe of Object.keys(familles)) assert.ok(src.includes(`'${prefixe}' +`), `famille ${prefixe} introuvable dans le module : la liste du test est perimee`)
  const cles = new Set([...directes, ...Object.entries(familles).flatMap(([p, s]) => s.map(x => p + x))])
  assert.ok(cles.size > 50, 'extraction vide')
  for (const l of ['fr', 'en', 'es']) {
    const d = langue(l)
    for (const k of cles) assert.ok(typeof d[k] === 'string' && d[k].trim(), `${l} : « ${k} » absente ou vide`)
  }
})

test('les origines connues du serveur ont toutes leur traduction', () => {
  // Les cles d'origine viennent de lib/avis/cartes.js : la liste est LUE, pas recopiee.
  const src = fs.readFileSync(path.join(racine, 'lib/avis/cartes.js'), 'utf8')
  const bloc = src.slice(src.indexOf('const ORIGINES = {'), src.indexOf('}', src.indexOf('const ORIGINES = {')))
  const cles = [...bloc.matchAll(/^\s*([a-z_]+):/gm)].map(m => m[1])
  // Et l'origine deduite du statut, sans colonne (« rédigé par l’IA » seul).
  for (const m of src.matchAll(/\{ cle: '([a-z_]+)', libelle:/g)) cles.push(m[1])
  assert.ok(cles.length >= 6, 'extraction vide')
  for (const l of ['fr', 'en', 'es']) {
    const d = langue(l)
    for (const c of new Set(cles)) assert.ok(d['avis.origine_' + c], `${l} : origine « ${c} » sans traduction`)
  }
})

test('le pluriel du repli suit la meme syntaxe que I18n (1 jour / 2 jours)', async () => {
  const { rendre } = await import('../core/avis/cartes.js')
  const att = (j) => ({ cartes: { attente: [{ cle: 's:1', section: 'attente', bien: 'B', avis: [], evaluation: { booking_uid: 'b', etat: 'a_remplir', evaluable: true, jours_restants: j } }], recents: [], anciens: null }, anciens_total: 0 })
  assert.match(rendre(att(2)), /2 jours restants/)
  assert.match(rendre(att(5)), /5 jours restants/)
  assert.match(rendre(att(1)), /Dernier jour/)
})
