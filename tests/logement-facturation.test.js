// tests/logement-facturation.test.js — le bloc « Facturation » de la fiche du
// logement (facture voyageur, étape 1b, D2 bis du 9 novembre 2026).
// Spec : docs/specs/spec-facture-voyageur.md §5.1 · KB : docs/kb/entites-juridiques.md
//
// Ce que ce fichier prouve :
//   1. L'ENDPOINT DE LA FICHE (api/logement.js, la vraie garde, un double du
//      client Supabase seulement — harnais repris de logement-endpoint) dit
//      l'entité du logement SANS rien en livrer d'autre que son nom ; un membre
//      la lit sans pouvoir la changer ; sans `facturation` en lecture, le bloc
//      est REFUSÉ ; une panne le rend illisible sans faire tomber la fiche.
//   2. LE BLOC (shared/logement-fiche.js) : l'entité, son absence, son
//      archivage ; le bouton seulement si le serveur l'accepte.
//   3. LA PAGE (pages/logement.html) ouvre la fenêtre au clic, la charge à la
//      demande, et repeint le bloc seul.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const TITULAIRE = '11111111-1111-1111-1111-111111111111'
const MEMBRE    = '22222222-2222-2222-2222-222222222222'
const ETRANGER  = '33333333-3333-3333-3333-333333333333'
const BIEN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const BIEN_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const BIEN_X = 'cccccccc-cccc-cccc-cccc-cccccccccccc'   // le bien d'un autre compte
const REF_A = '209413'
const REF_B = '552211'
const REF_X = '999999'

const bien = (id, user, ref, nom) => ({
  user_id: user, id, name: nom, city: 'Bagnères', country: 'FR', address: 'a',
  zip_code: '65200', capacity: 4, photo_url: null, currency: 'EUR', base_price: 120,
  prix_minimum: 60, included_guests: 2, extra_guest_fee: 15, rate_sync_mode: 'managed',
  pilote_tarifaire: false, automation_paused: false, inventory_type: 'whole',
  ota_listing_urls: null, created_at: '2026-01-01T00:00:00Z',
  provider: 'channex', provider_property_id: ref, migration_target_property_id: null,
  provider_rate_plan_id: 'RP-' + ref
})

const BIENS = [
  bien(BIEN_A, TITULAIRE, REF_A, 'La bulle'),
  bien(BIEN_B, TITULAIRE, REF_B, 'Cœur de vie 23'),
  bien(BIEN_X, ETRANGER, REF_X, 'Chez un autre')
]

const MODULES = ['../api/logement', '../lib/logement/lecture', '../lib/require-permission']

// Un `or` PostgREST, evalue comme la base l'evaluerait : `col.eq.v` et
// `col.in.(a,b)` separes par des virgules de premier niveau.
function passeOr (ligne, expr) {
  if (!expr) return true
  const branches = []
  let niveau = 0, courant = ''
  for (const c of expr) {
    if (c === '(') niveau++
    if (c === ')') niveau--
    if (c === ',' && niveau === 0) { branches.push(courant); courant = ''; continue }
    courant += c
  }
  if (courant) branches.push(courant)
  return branches.some(b => {
    const mEq = b.match(/^([a-z_]+)\.eq\.(.*)$/)
    if (mEq) return String(ligne[mEq[1]] == null ? '' : ligne[mEq[1]]) === mEq[2]
    const mIn = b.match(/^([a-z_]+)\.in\.\((.*)\)$/)
    if (mIn) return mIn[2].split(',').includes(String(ligne[mIn[1]] == null ? '' : ligne[mIn[1]]))
    return false
  })
}

function preparer ({ appelant = TITULAIRE, profils = [], permissions = [], avis = [],
  // Les tables que la purge de suppression efface, pour le COMPTAGE (étape 3).
  sejours = [], messages = [], menages = [], codes = [],
  entites = [], liens = [],
  enPanne = {}, enPanneApres = {} } = {}) {
  const vus = []
  const passages = {}
  const client = {
    auth: { getUser: async (t) => t ? ({ data: { user: { id: appelant } }, error: null }) : ({ data: null, error: { message: 'no' } }) },
    from (table) {
      const a = { table, f: {}, ins: [], or: null, limit: null, order: null, ordres: [], gte: {}, lte: {}, is: {} }
      vus.push(a)
      const donnees = () => {
        if (enPanne[table]) return { data: null, error: { message: enPanne[table] } }
        if (enPanneApres[table] != null) {
          passages[table] = (passages[table] || 0) + 1
          if (passages[table] > enPanneApres[table]) return { data: null, error: { message: 'timeout' } }
        }
        const source = { properties: BIENS, profiles: profils, profile_permissions: permissions,
          ota_reviews: avis, bookings_snapshot: sejours, messages: messages,
          menage_events: menages, access_codes: codes,
          entites_juridiques: entites, biens_entites: liens }[table] || []
        const c = source.filter(l =>
          Object.entries(a.f).every(([k, v]) => String(l[k]) === String(v)) &&
          a.ins.every(f => f.v.includes(String(l[f.c]))) &&
          passeOr(l, a.or))
        return { data: a.limit != null ? c.slice(0, a.limit) : c, error: null }
      }
      const chain = {
        // `count` / `head` honorés comme chez PostgREST (voir l'autre fichier) :
        // le comptage de la suppression ne lit aucune ligne.
        select (cols, opts) { if (opts && opts.count) { a.compte = true; a.head = opts.head === true } return chain },
        eq (c, v) { a.f[c] = v; return chain },
        in (c, v) { a.ins.push({ c, v: (v || []).map(String) }); return chain },
        gte (c, v) { a.gte[c] = v; return chain },
        lte (c, v) { a.lte[c] = v; return chain },
        is (c, v) { a.is[c] = v; return chain },
        or (e) { a.or = e; return chain },
        order (c, o) { a.ordres.push({ c, asc: !(o && o.ascending === false) }); a.order = a.ordres[0]; return chain },
        // Le plafond `max_rows = 1000` du serveur, simule comme dans l'autre
        // fichier de test : un double plus genereux que la base rend vertes des
        // gardes qui, en production, ne peuvent pas mordre.
        range (de, jusqu) {
          const r = donnees()
          if (r.error) return Promise.resolve(r)
          return Promise.resolve({ data: r.data.slice(de, de + Math.min(jusqu - de + 1, 1000)), error: null })
        },
        limit (n) { a.limit = n; const r = donnees(); return Promise.resolve(r.error ? r : { data: r.data.slice(0, Math.min(n, 1000)), error: null }) },
        maybeSingle () { const r = donnees(); return Promise.resolve({ data: r.data ? (r.data[0] || null) : null, error: r.error }) },
        then (f, g) {
          const r = donnees()
          if (!a.compte) return Promise.resolve(r).then(f, g)
          return Promise.resolve(r.error
            ? { data: null, error: r.error, count: null }
            : { data: a.head ? null : r.data, error: null, count: r.data.length }).then(f, g)
        }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  // L'alarme du fondateur ne part pas en vrai appel reseau depuis un test.
  const absN = require.resolve(path.join(__dirname, '..', 'lib', 'founder-notify'))
  const mN = new Module(absN); mN.exports = { reportIncident: async () => ({ ok: true }) }; mN.loaded = true
  require.cache[absN] = mN
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  try { require('../lib/cles-migrees')._vider() } catch {}
  return { vus }
}

const reponse = () => {
  const r = { code: null, body: null, entetes: {} }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = (k, v) => { r.entetes[k] = v }
  return r
}
const appeler = async (query = {}, headers = {}, method = 'GET') => {
  const res = reponse()
  await require('../api/logement')(
    { method, query, body: null, headers: { authorization: 'Bearer jeton', ...headers } }, res)
  return res
}

const profilDe = (compte, membre, extra = {}) => ({
  id: `prof-${membre}-${compte}`, account_user_id: compte, member_user_id: membre,
  active: true, accepted_at: '2026-01-01T00:00:00Z', ...extra
})
const droitsDe = (profileId, extra = {}) => ({
  profile_id: profileId, reservations: 'read', reglages: 'read',
  prestataires: 'read', avis: 'read', facturation: 'read',
  property_scope: 'all', property_ids: [], property_refs: [], ...extra
})


const fs = require('node:fs')
const { JSDOM } = require('jsdom')

const ENTITE = (id, nom, extra = {}) => ({
  id, user_id: TITULAIRE, type: 'societe', nom, siret: '12345678900012', adresse_ligne1: '24 allée',
  regime_tva: 'assujetti', taux_tva: 10, archivee_le: null, cree_le: '2026-11-09T00:00:00Z', ...extra
})
const E_SCI = 'eeeeeeee-0000-4000-8000-000000000001'
const LIEN_A = { property_uuid: BIEN_A, entite_id: E_SCI, user_id: TITULAIRE }

// ═══════════════════════════════════════════════════════════════════════════
// 1. L'endpoint de la fiche
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : le titulaire lit l\'entité de SON logement — le nom seul, et le droit de la changer', async () => {
  preparer({ entites: [ENTITE(E_SCI, 'SCI Le Florian')], liens: [LIEN_A] })
  const r = await appeler({ id: BIEN_A })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.facturation, { entite: { id: E_SCI, nom: 'SCI Le Florian', archivee: false }, modifier: true })
  assert.ok(!JSON.stringify(r.body).includes('12345678900012'), 'le SIRET reste dans la fenêtre')
  assert.ok(!(r.body.refuses || []).includes('facturation'))
})

test('LE TEST QUI COMPTE : un logement sans lien n\'a PAS d\'entité, même si le compte en a une (D2 bis)', async () => {
  preparer({ entites: [ENTITE(E_SCI, 'SCI Le Florian')], liens: [LIEN_A] })
  const r = await appeler({ id: BIEN_B })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.facturation, { entite: null, modifier: true })
})

test('une entité archivée se dit archivée', async () => {
  preparer({ entites: [ENTITE(E_SCI, 'Ancienne SARL', { archivee_le: '2026-11-01T00:00:00Z' })], liens: [LIEN_A] })
  const r = await appeler({ id: BIEN_A })
  assert.deepEqual(r.body.facturation.entite, { id: E_SCI, nom: 'Ancienne SARL', archivee: true })
})

test('LE TEST QUI COMPTE : un membre `facturation: read` lit l\'entité, mais ne reçoit PAS le droit de la changer', async () => {
  const p = profilDe(TITULAIRE, MEMBRE)
  preparer({ appelant: MEMBRE, profils: [p], permissions: [droitsDe(p.id, { facturation: 'read' })],
    entites: [ENTITE(E_SCI, 'SCI Le Florian')], liens: [LIEN_A] })
  const r = await appeler({ id: BIEN_A })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.facturation, { entite: { id: E_SCI, nom: 'SCI Le Florian', archivee: false }, modifier: false })
  // Et même `facturation: write` ne le donne pas : le domaine ne se délègue pas en écriture.
  const p2 = profilDe(TITULAIRE, MEMBRE)
  preparer({ appelant: MEMBRE, profils: [p2], permissions: [droitsDe(p2.id, { facturation: 'write', reglages: 'write' })],
    entites: [ENTITE(E_SCI, 'SCI Le Florian')], liens: [LIEN_A] })
  assert.equal((await appeler({ id: BIEN_A })).body.facturation.modifier, false)
})

test('LE TEST QUI COMPTE : sans `facturation` en lecture, le bloc est REFUSÉ — ni le nom, ni l\'absence ne descendent', async () => {
  const p = profilDe(TITULAIRE, MEMBRE)
  const { vus } = preparer({ appelant: MEMBRE, profils: [p], permissions: [droitsDe(p.id, { facturation: 'none' })],
    entites: [ENTITE(E_SCI, 'SCI Le Florian')], liens: [LIEN_A] })
  const r = await appeler({ id: BIEN_A })
  assert.equal(r.code, 200)
  assert.ok(!('facturation' in r.body))
  assert.ok(r.body.refuses.includes('facturation'))
  assert.ok(!JSON.stringify(r.body).includes('SCI Le Florian'))
  assert.ok(!vus.some(v => v.table === 'biens_entites' || v.table === 'entites_juridiques'), 'rien n\'est même lu')
})

test('une panne du bloc ne fait pas tomber la fiche : il se dit illisible', async () => {
  preparer({ entites: [ENTITE(E_SCI, 'SCI Le Florian')], liens: [LIEN_A], enPanne: { biens_entites: 'timeout' } })
  const r = await appeler({ id: BIEN_A })
  assert.equal(r.code, 200)
  assert.equal(r.body.facturation, null)
  assert.ok(r.body.indisponibles.includes('facturation'))
  assert.equal(r.body.bien.nom, 'La bulle', 'le reste de la fiche est là')
})

test('le bien d\'un autre compte : la fiche reste refusée, et aucune entité n\'est lue', async () => {
  const { vus } = preparer({ entites: [ENTITE(E_SCI, 'SCI')], liens: [LIEN_A] })
  const r = await appeler({ id: BIEN_X })
  assert.ok([403, 404].includes(r.code))
  assert.ok(!vus.some(v => v.table === 'biens_entites'))
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Le bloc
// ═══════════════════════════════════════════════════════════════════════════

const FR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', 'fr.json'), 'utf8'))
const t = (cle, vars = {}) => {
  const s = FR[cle]
  assert.ok(s != null, `clé i18n absente de fr.json : ${cle}`)
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`))
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const OUTILS = { t, esc, icone: () => '', nombre: String, argent: String, dateEnClair: String, liste: (xs) => xs.join(', ') }
const doc = (html) => new JSDOM(`<!doctype html><body><div id="c">${html}</div></body>`).window.document
let F
test.before(async () => { F = await import('../shared/logement-fiche.js') })

test('le bloc dit l\'entité, son absence ou son archivage, et le bouton suit le serveur', () => {
  const avec = doc(F.facturationBlocHtml({ facturation: { entite: { id: 'e', nom: 'SCI <b>', archivee: false }, modifier: true } }, OUTILS))
  assert.equal(avec.querySelector('.fic-bloc__titre').textContent, 'Facturation')
  assert.ok(avec.querySelector('[data-bloc="facturation"]'))
  assert.equal(avec.querySelector('.fic-ligne__val').textContent, 'SCI <b>', 'échappé')
  assert.equal(avec.querySelector('[data-bind="facturation"]').textContent, t('fiche.facturation_modifier'))
  const sans = doc(F.facturationBlocHtml({ facturation: { entite: null, modifier: true } }, OUTILS))
  assert.equal(sans.querySelector('[data-facturation-alerte]').textContent, t('fiche.facturation_aucune'))
  assert.equal(sans.querySelector('[data-bind="facturation"]').textContent, t('fiche.facturation_choisir'))
  const archivee = doc(F.facturationBlocHtml({ facturation: { entite: { id: 'e', nom: 'Vieille <i>', archivee: true }, modifier: true } }, OUTILS))
  assert.equal(archivee.querySelector('[data-facturation-alerte]').textContent, t('fiche.facturation_archivee', { nom: 'Vieille <i>' }), 'échappé')
  assert.equal(avec.querySelector('[data-facturation-alerte]'), null, 'une entité active : aucune alerte')
  // Mise en page (recette du 9 novembre 2026) : l'alerte est un paragraphe
  // SOUS la ligne clé/valeur, jamais un enfant de `.fic-ligne` — la ligne est
  // un flex qui ne passe pas à la ligne, et `.fic-erreur` y réclame 100 % de
  // la largeur à côté de la clé : le texte sortait du bloc à droite.
  for (const d of [sans, archivee]) {
    const alerte = d.querySelector('[data-facturation-alerte]')
    assert.equal(alerte.closest('.fic-ligne'), null, 'l\'alerte n\'est pas dans la ligne clé/valeur')
    assert.ok(alerte.previousElementSibling.classList.contains('fic-ligne'), 'elle suit la ligne « Factures émises au nom de »')
    assert.ok(alerte.classList.contains('fic-erreur'))
    assert.equal(d.querySelector('.fic-ligne__val'), null, 'pas de valeur à droite de la clé')
  }
  // jsdom ne calcule pas la mise en page : ce qui empêche un nom d'entité SANS
  // ESPACE de pousser la page (défaut D7, mesuré en review à 437 px sur un
  // écran de 375), c'est la règle de la page. Elle est gardée ici.
  const css = fs.readFileSync(path.join(__dirname, '..', 'pages', 'logement.html'), 'utf8')
  assert.match(css, /\.fic-facturation \.fic-erreur\s*\{[^}]*overflow-wrap:\s*anywhere/,
    'l\'alerte de facturation passe à la ligne même sans espace')
  const membre = doc(F.facturationBlocHtml({ facturation: { entite: null, modifier: false } }, OUTILS))
  assert.equal(membre.querySelector('[data-bind="facturation"]'), null, 'pas de bouton sans le droit du serveur')
  const illisible = doc(F.facturationBlocHtml({ facturation: null, indisponibles: ['facturation'] }, OUTILS))
  assert.equal(illisible.querySelector('[data-non-lu]').textContent, t('fiche.facturation_non_lue'))
  assert.equal(F.facturationBlocHtml({ refuses: ['facturation'] }, OUTILS), '', 'refusé (ou ancien serveur) : rien')
})

test('la fiche place le bloc dans sa colonne droite, et ne le rend pas s\'il est refusé', () => {
  const base = { canaux_releve_fait: true, bien: { id: 'b1', nom: 'La bulle', devise: 'EUR' }, canaux: [],
    suppression: { possible: true }, avis: null, taxe: null, menage: [], serrures: [], indisponibles: [], refuses: [] }
  const d = doc(F.ficheHtml({ ...base, facturation: { entite: null, modifier: true } }, OUTILS, {}))
  assert.ok(d.querySelector('.fic-col--droite [data-bloc="facturation"]'))
  const r = doc(F.ficheHtml({ ...base, refuses: ['facturation'] }, OUTILS, {}))
  assert.equal(r.querySelector('[data-bloc="facturation"]'), null)
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. La page
// ═══════════════════════════════════════════════════════════════════════════

test('la page délègue au module, chargé au clic, avec le client partagé et la fiche COURANTE', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'logement.html'), 'utf8')
  assert.match(page, /if \(ev\.target\.closest\('\[data-bind="facturation"\]'\)\) \{ ouvrirFacturation\(\); return \}/)
  // Chargé au clic, pas avec la page : aucun import statique.
  assert.match(page, /await import\('\/shared\/logement-facturation\.js'\)/)
  assert.doesNotMatch(page, /^import .*(entites-juridiques-vue|logement-facturation)/m)
  assert.match(page, /api: api\.entitesJuridiques, fiche: \(\) => ficheCourante, idDuBien/)
})

// ─── Le module du geste, exécuté dans un DOM (review 3, constat 4) ──────────

async function monterPage () {
  const dom = new JSDOM('<!doctype html><body><div id="fiche"></div></body>')
  const d = dom.window.document
  global.document = d
  const fiche = { bien: { id: 'uuid-du-bien', nom: 'La bulle' }, facturation: { entite: null, modifier: true } }
  d.getElementById('fiche').innerHTML = F.facturationBlocHtml(fiche, OUTILS)
  const lus = []
  const etat = { titulaire: true, bien: { id: 'uuid-du-bien', nom: 'La bulle', entite_id: null },
    entites: [{ id: 'e1', nom: 'SCI Le Florian', archivee_le: null, numerotation_factures: 'manuel', type: 'societe', regime_tva: 'exonere' }], numerotations: {} }
  const api = {
    lire: async (bien) => { lus.push(bien); return JSON.parse(JSON.stringify(etat)) },
    ecrire: async (corps) => { etat.bien.entite_id = corps.entite_id; return { ok: true } }
  }
  const vue = await import('../shared/entites-juridiques-vue.js')
  const LF = await import('../shared/logement-facturation.js')
  const ouvrir = () => LF.ouvrirFacturation({ doc: d, api, fiche: () => fiche, idDuBien: 'ref', outils: OUTILS, chargerVue: async () => vue })
  return { d, fiche, lus, ouvrir }
}

test('LE TEST QUI COMPTE : ouvrir, choisir, fermer, ROUVRIR — le bloc est repeint, le bouton reste vivant, le focus revient', async () => {
  const { d, fiche, lus, ouvrir } = await monterPage()
  d.querySelector('[data-bind="facturation"]').focus()
  assert.equal(await ouvrir(), true)
  assert.deepEqual(lus, ['uuid-du-bien'], 'le logement de la fiche')
  assert.equal(await ouvrir(), false, 'une seule fenêtre à la fois')
  // Choisir l'entité : le bloc de la fiche est repeint seul.
  d.querySelector('.ej-carte[data-entite="e1"] [data-action="choisir"]').click()
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(fiche.facturation, { entite: { id: 'e1', nom: 'SCI Le Florian', archivee: false }, modifier: true })
  assert.equal(d.querySelector('[data-bloc="facturation"] .fic-ligne__val').textContent, 'SCI Le Florian')
  // Fermer : le focus revient au NOUVEAU bouton ; rouvrir marche.
  d.dispatchEvent(new d.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(d.querySelector('.ej-fenetre'), null)
  assert.equal(d.activeElement, d.querySelector('[data-bind="facturation"]'))
  assert.equal(await ouvrir(), true, 'le bouton n\'est pas devenu inerte')
  d.dispatchEvent(new d.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
