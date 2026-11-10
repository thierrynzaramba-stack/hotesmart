// tests/recette-charges-script.test.js — le script de recette du compte de
// charges (scripts/recette-charges.js) : sa garde de base, et le PDF qu'il
// fabrique. Le déroulé lui-même tourne sur staging, à la main.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pdfDeRecette, factureDeRecette, refusDeBase, bilan, compteRendu } = require('../scripts/recette-charges')
const { typeReel } = require('../lib/charges/regles')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'recette-charges.js')
const lancer = (url) => spawnSync(process.execPath, [SCRIPT, '--compte=11111111-1111-4111-8111-111111111111', '--go'], {
  env: { PATH: process.env.PATH, SUPABASE_URL: url, SUPABASE_SERVICE_KEY: 'k' }, encoding: 'utf8', timeout: 20000
})

test('⚠ la recette REFUSE la production et une base inconnue, avant toute lecture', () => {
  for (const url of ['https://cjmrizpdyhrcurmgyrhs.supabase.co', 'https://inconnu123.supabase.co']) {
    const r = lancer(url)
    assert.equal(r.status, 1, url)
    assert.match(r.stderr, /REFUS : cette recette ne tourne que sur STAGING/, url)
    assert.doesNotMatch(r.stdout, /Clé de l'IA/, 'rien n’est fait après le refus')
  }
  // Contre-épreuve : staging passe la garde.
  assert.equal(refusDeBase('https://ortyofzzdsthlhqmzsnq.supabase.co'), null)
  assert.match(refusDeBase('https://cjmrizpdyhrcurmgyrhs.supabase.co'), /PRODUCTION/)
})

test('le PDF de recette est un PDF : signature lue dans le contenu, table xref juste', () => {
  const pdf = factureDeRecette({ numero: 'RE-1', ht: '100,00', tva: '20,00', ttc: '120,00', marque: 'm' })
  assert.equal(typeReel(pdf), 'application/pdf')
  const texte = pdf.toString('latin1')
  const offsets = texte.slice(texte.indexOf('xref')).split('\n').slice(3, 8).map(l => Number(l.slice(0, 10)))
  offsets.forEach((o, i) => assert.equal(texte.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `objet ${i + 1}`))
  const debutXref = parseInt(texte.split('startxref\n')[1], 10)
  assert.equal(texte.slice(debutXref, debutXref + 4), 'xref')
  assert.match(texte, /\(Total TTC : 120,00 EUR\) Tj/)
})

test('le PDF échappe les parenthèses et remplace ce qui n’est pas ASCII', () => {
  const t = pdfDeRecette(['a (b) \\ é']).toString('latin1')
  assert.match(t, /\(a \\\(b\\\) \\\\ \?\) Tj/)
})

test('⚠ le bilan : un seul échec suffit à rendre la recette EN ÉCHEC, et rien de vérifié n’est pas un succès', () => {
  assert.equal(bilan([{ ok: true }, { ok: true }]).code, 0)
  const unEchec = bilan([{ ok: true }, { ok: false }, { ok: null }])
  assert.equal(unEchec.code, 1)
  assert.match(unEchec.texte, /^RECETTE EN ÉCHEC : 1 vérification\(s\) passée\(s\), 1 en échec, 1 non vérifiée/)
  assert.equal(bilan([{ ok: null }]).code, 1, 'rien de vérifié')
  assert.equal(bilan([]).code, 1, 'rien du tout')
  const nonVu = bilan([{ ok: true }, { ok: null }])
  assert.equal(nonVu.code, 0)
  assert.match(nonVu.texte, /RECETTE OK : 1 .*1 non vérifiée/)
})

test('⚠ une vérification qui rend `null` (une charge disparue) est un ÉCHEC, pas un « non vérifié »', () => {
  const lignes = []
  const { resultats, verifier, ignorer } = compteRendu(l => lignes.push(l))
  const disparue = null
  verifier('7c lue par le cron', disparue && disparue.statut === 'a_verifier')
  verifier('2b', undefined)
  verifier('1a', true)
  ignorer('4 avec entité', 'aucune entité')
  assert.deepEqual(resultats.map(r => r.ok), [false, false, true, null])
  assert.equal(bilan(resultats).code, 1, 'la recette est EN ÉCHEC')
  assert.match(lignes[0], /^✘ 7c/)
  // Contre-épreuve : sans le `null`, le même compte rendu passe.
  const ok = compteRendu(() => {})
  ok.verifier('1a', true); ok.ignorer('4', 'raison')
  assert.equal(bilan(ok.resultats).code, 0)
})
