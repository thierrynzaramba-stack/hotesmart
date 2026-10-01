// tests/prestataires-eval-dom.test.js
// La section « Évaluation des voyageurs » de la fiche prestataire
// (apps/menages/prestataires.html), lot 5 du chantier avis, 2 octobre 2026.
//
// Ce qui compte : la fiche ne lit ni n'écrit les réglages elle-même — elle
// passe par le bus ; elle se cache quand le bus dit « indisponible » ; elle dit
// un refus au lieu d'afficher des cases qui n'enregistrent rien ; et elle ne
// garde jamais à l'écran une valeur que le serveur n'a pas prise.
//
// Même banc que tests/prestataires-formulaire-dom.test.js : le VRAI script de
// la page, exécuté dans un vrai DOM, sans ses imports.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const FICHIER = path.join(__dirname, '..', 'apps', 'menages', 'prestataires.html')
const BIENS = [{ id: 'ref-a', uuid: 'u-a', name: 'Studio' }]
const PROFIL = 'p-regina'
const LIGNE = { id: 'pt-1', label: 'Régina', visibility_days: 30, ratio_periode: '30j', property_ids: ['ref-a'] }

// `reponses` : file des réponses du bus, dans l'ordre des appels.
function monterPage (reponses) {
  const html = fs.readFileSync(FICHIER, 'utf8')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  let src = m[1]
    .replace(/^\s*import .*$/gm, '')
    .replace(/^\s*await exigerCompteProprePage\(.*$/gm, '')
    .replace(/^\s*initErrorHandler\(\)\s*$/gm, '')
    .replace(/^\s*init\(\)\s*$/gm, '')
  src += `
    globalThis.__t = {
      seed () { properties = ${JSON.stringify(BIENS)}; liaisons = []; prestataires = [${JSON.stringify(LIGNE)}]
                currentSession = { access_token: 'jwt', user: { id: 'compte-1' } }
                prestatairesProfils = [{ id: '${PROFIL}', prenom: 'Régina', nom: 'Martin', actif: true,
                                         a_lien: true, public_token_id: '${LIGNE.id}',
                                         telephone: null, email: null, permissions: { self_availability: 'write' } }]
                rapprochementSur = true },
      editPrestataire, resetForm
    }
  `
  const dom = new JSDOM(html, { url: 'https://hotesmart.vercel.app/apps/menages/prestataires', runScripts: 'outside-only' })
  const w = dom.window
  w.alert = () => {}
  w.confirm = () => true
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, sans_referent: [] }) })
  w.supabase = { from () { const c = { select: () => c, update: () => c, delete: () => c, eq: () => Object.assign(Promise.resolve({ data: [], error: null }), c), order: () => Promise.resolve({ data: [], error: null }) }; return c } }
  const appels = []
  w.hsBus = {
    async demander (action, params) {
      appels.push({ action, params: { ...params } })
      const r = reponses.shift()
      return typeof r === 'function' ? r(params) : r
    },
  }
  vm.runInContext(src, dom.getInternalVMContext())
  const $ = (id) => w.document.getElementById(id)
  return { w, t: w.__t, $, appels }
}

const attendre = () => new Promise(r => setTimeout(r, 10))
const changer = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.Event('change'))
const LU = (scope, power) => ({ ok: true, data: { ok: true, profile_id: PROFIL, eval_scope: scope, eval_power: power } })

test('le bus répond « indisponible » : la section reste cachée', async () => {
  const { t, $, appels } = monterPage([{ ok: false, raison: 'indisponible' }])
  t.seed(); t.editPrestataire(LIGNE.id); await attendre()
  assert.strictEqual(appels[0].action, 'avis.reglages_prestataire')
  assert.deepStrictEqual(appels[0].params, { profile_id: PROFIL })
  assert.strictEqual($('eval-section').style.display, 'none')
})

test('LE TEST QUI COMPTE : non autorisée, la case est décochée, le pouvoir grisé, et la fiche le dit', async () => {
  const { t, $ } = monterPage([LU('aucun', 'soumettre')])
  t.seed(); t.editPrestataire(LIGNE.id); await attendre()
  assert.strictEqual($('eval-section').style.display, '')
  assert.strictEqual($('eval-participe').checked, false)
  assert.strictEqual($('eval-pouvoir').disabled, true)
  assert.match($('eval-etat').textContent, /aucune question tant que vous ne l’y autorisez pas/)
})

test('cocher la case écrit `selon_grille` PAR LE BUS, puis peint ce que le serveur rend', async () => {
  const { t, $, appels } = monterPage([LU('aucun', 'soumettre'), LU('selon_grille', 'soumettre')])
  t.seed(); t.editPrestataire(LIGNE.id); await attendre()
  $('eval-participe').checked = true
  changer($('eval-participe'))
  await attendre()
  assert.deepStrictEqual(appels[1].params, { profile_id: PROFIL, eval_scope: 'selon_grille' })
  assert.strictEqual($('eval-participe').checked, true)
  assert.strictEqual($('eval-pouvoir').disabled, false, 'autorisée, son pouvoir se règle')
  assert.strictEqual($('eval-etat').textContent, 'Enregistré.')
})

test('changer le pouvoir écrit `eval_power`', async () => {
  const { t, $, appels } = monterPage([LU('selon_grille', 'soumettre'), LU('selon_grille', 'valider')])
  t.seed(); t.editPrestataire(LIGNE.id); await attendre()
  $('eval-pouvoir').value = 'valider'
  changer($('eval-pouvoir'))
  await attendre()
  assert.deepStrictEqual(appels[1].params, { profile_id: PROFIL, eval_power: 'valider' })
  assert.strictEqual($('eval-pouvoir').value, 'valider')
})

test('LE TEST QUI COMPTE : un refus à l’ouverture se DIT, les cases ne sont pas saisissables', async () => {
  const { t, $ } = monterPage([{ ok: true, data: { ok: false, statut: 403, motif: 'perimetre_partiel', erreur: 'Les réglages d’une prestataire engagent tous les biens.' } }])
  t.seed(); t.editPrestataire(LIGNE.id); await attendre()
  assert.strictEqual($('eval-section').style.display, '')
  assert.strictEqual($('eval-participe').disabled, true)
  assert.strictEqual($('eval-pouvoir').disabled, true)
  assert.match($('eval-etat').textContent, /engagent tous les biens/)
})

test('LE TEST QUI COMPTE : une écriture refusée ne laisse pas à l’écran une valeur que le serveur n’a pas prise', async () => {
  const { t, $, appels } = monterPage([
    LU('aucun', 'soumettre'),
    { ok: true, data: { ok: false, statut: 503, erreur: 'Réglages non enregistrés' } },
    LU('aucun', 'soumettre'),
  ])
  t.seed(); t.editPrestataire(LIGNE.id); await attendre()
  $('eval-participe').checked = true
  changer($('eval-participe'))
  await attendre()
  assert.strictEqual(appels.length, 3, 'l’échec est suivi d’une relecture')
  assert.strictEqual($('eval-participe').checked, false, 'la case revient à ce que dit le serveur')
  assert.match($('eval-etat').textContent, /Réglages non enregistrés/)
})

test('fermer la fiche cache la section', async () => {
  const { t, $ } = monterPage([LU('selon_grille', 'valider')])
  t.seed(); t.editPrestataire(LIGNE.id); await attendre()
  t.resetForm()
  assert.strictEqual($('eval-section').style.display, 'none')
})

// ─── Constats de la revue de d6c47e7 ────────────────────────────────────────
test('LE TEST QUI COMPTE : écriture ET relecture en échec — la case revient à la dernière valeur confirmée', async () => {
  const { t, $ } = monterPage([
    LU('aucun', 'soumettre'),
    { ok: false, raison: 'indisponible' },
    { ok: false, raison: 'indisponible' },
  ])
  t.seed(); t.editPrestataire(LIGNE.id); await attendre()
  $('eval-participe').checked = true
  changer($('eval-participe'))
  await attendre()
  assert.strictEqual($('eval-participe').checked, false, 'le serveur n’a rien pris')
  assert.strictEqual($('eval-participe').disabled, false)
  assert.match($('eval-etat').textContent, /n’a pas pu être enregistré/)
})

test('pendant la relecture, la case reste grisée', async () => {
  let relache
  const { t, $ } = monterPage([
    LU('aucun', 'soumettre'),
    { ok: true, data: { ok: false, statut: 503, erreur: 'non' } },
    () => new Promise(r => { relache = () => r(LU('aucun', 'soumettre')) }),
  ])
  t.seed(); t.editPrestataire(LIGNE.id); await attendre()
  $('eval-participe').checked = true
  changer($('eval-participe'))
  await attendre()
  assert.strictEqual($('eval-participe').disabled, true, 'pas de seconde écriture possible pendant la relecture')
  relache(); await attendre()
  assert.strictEqual($('eval-participe').disabled, false)
})

test('une lecture en retard d’une ouverture précédente ne repeint pas la nouvelle ouverture', async () => {
  let premiere
  const { t, $ } = monterPage([
    () => new Promise(r => { premiere = () => r(LU('selon_grille', 'valider')) }),
    LU('aucun', 'soumettre'),
  ])
  t.seed(); t.editPrestataire(LIGNE.id)          // ouverture 1 : lecture lente
  t.resetForm()
  t.editPrestataire(LIGNE.id); await attendre()   // ouverture 2 : répond vite
  premiere(); await attendre()                      // la 1 arrive en retard
  assert.strictEqual($('eval-participe').checked, false, 'c’est la seconde ouverture qui fait foi')
})
