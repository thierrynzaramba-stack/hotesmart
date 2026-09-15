// tests/prestataires-formulaire-dom.test.js
// CE QUE L'ÉCRAN LIT DANS SA PROPRE PAGE — pas seulement ce qu'il envoie.
//
// ⚠ POURQUOI CE FICHIER EXISTE, ET POURQUOI IL AURAIT DÛ EXISTER LE 4 SEPTEMBRE.
// `apps/menages/prestataires.html` écrivait les JOURS de la semaine dans
// `public_tokens.property_ids`. La ligne fautive :
//
//     [...document.querySelectorAll('#prop-checkboxes input:checked')].map(cb => cb.value)
//
// écrite le 9 avril, quand `#prop-checkboxes` ne portait QUE les cases de biens.
// Le lot 3.5 (b2f1011, 4 septembre) y a placé 7 cases de jours par bien, sans
// resserrer le sélecteur. Mesuré en production le 14 septembre :
//   Régina  → 23 entrées pour 2 biens : ["0db6b39b…","1","2","3","4","5","6","0", …]
//   Tiphaine→ 26 entrées
// Les cases d'un bien DÉCOCHÉ comptaient aussi : `disabled` n'empêche pas
// `:checked`. Et rien ne se voyait à l'écran — les valeurs "0".."6" ne
// correspondent à aucune référence de bien, donc les pastilles restaient justes.
//
// ⚠ LES 1400 TESTS NE POUVAIENT PAS LE VOIR, et c'est la vraie leçon.
// `pages-ids` vérifie que les identifiants existent, `contrat-front-api` que le
// corps envoyé correspond aux actions serveur, `js-navigateur-parse` que le
// script parse. Tous lisent le HTML comme du TEXTE. Aucun ne pouvait EXÉCUTER
// un `querySelectorAll` et constater qu'il ramasse sept cases de trop. Ce
// fichier ferme cet angle : il monte un vrai DOM, exécute le vrai script de la
// page, et regarde ce qui part réellement en base.
//
// ⚠ IL DOIT ÉCHOUER SI ON REMET LA FAUTE (REVIEW.md règle 8). La contre-épreuve
// est en bas de fichier : on rejoue la ligne d'avril sur le DOM réellement
// produit, et on vérifie qu'elle ramène bien les jours — sans quoi ce test
// passerait aussi sur le code fautif, et ne prouverait rien.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const FICHIER = path.join(__dirname, '..', 'apps', 'menages', 'prestataires.html')

// Les biens du compte, tels que `/api/menages?contacts=1` les rend :
// `id` = provider_property_id (TEXT), `uuid` = properties.id.
const BIENS = [
  { id: '0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4', uuid: 'u-bulle', name: 'La bulle' },
  { id: '1655ab32-d339-413d-b8ff-b4ccbd2a7b66', uuid: 'u-coeur', name: 'Cœur de vie l 23' },
  { id: '0544fd9a-6579-44e7-b75e-19c63a2019ba', uuid: 'u-colomiers', name: 'Colomiers' }
]
const PROFIL = 'p-regina'
const LIGNE_TOKEN = { id: 'pt-1', label: 'Régina', visibility_days: 30, ratio_periode: '30j',
                      property_ids: [BIENS[0].id, BIENS[1].id] }

// ─── Monter la page, pour de vrai ──────────────────────────────────────────
//
// ⚠ LE SCRIPT DE LA PAGE EST EXÉCUTÉ, PAS RECOPIÉ. Le recopier dans le test
// aurait produit un double qui reste vert pendant que la page, elle, est
// fausse — la faute exacte que ce fichier existe pour empêcher. On retire les
// `import` (le réseau n'existe pas ici) et l'appel final à `init()` (il
// déclencherait l'authentification), puis on évalue le reste tel quel.
function monterPage ({ liaisons = [] } = {}) {
  const html = fs.readFileSync(FICHIER, 'utf8')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, 'le script module de la page est introuvable')

  let src = m[1]
    .replace(/^\s*import .*$/gm, '')
    .replace(/^\s*await exigerCompteProprePage\(.*$/gm, '')
    .replace(/^\s*initErrorHandler\(\)\s*$/gm, '')
    .replace(/^\s*init\(\)\s*$/gm, '')

  const ecrits = []          // ce qui part vers public_tokens
  const envois = []          // ce qui part vers /api/membres et /api/menages

  // ⚠ Les doubles portent le MÊME contrat que le vrai : `/api/membres` et
  // `/api/menages` répondent 200 avec un corps exploitable, sinon `saveEdit`
  // sortirait avant d'écrire et le test passerait sans rien prouver.
  src += `
    globalThis.__t = {
      ecrits, envois,
      seed (b, l, p) { properties = b; liaisons = l; prestataires = p
                       currentSession = { access_token: 'jwt', user: { id: 'compte-1' } }
                       prestatairesProfils = [{ id: '${PROFIL}', prenom: 'Régina', nom: 'Martin',
                                                actif: true,
                                                a_lien: true, public_token_id: '${LIGNE_TOKEN.id}',
                                                telephone: null, email: null,
                                                permissions: { self_availability: 'write' } }]
                       rapprochementSur = true },
      renderPropCheckboxes, renderPrestataires, editPrestataire, saisieDesBiens,
      saveEdit, createPrestataire, perimetreRefuse
    }
  `

  // ⚠ `outside-only` : jsdom n'exécute PAS le `<script type="module">` de la
  // page — il tenterait de charger `/shared/supabase.js` par le réseau — mais
  // nous laisse évaluer NOUS-MÊMES du code dans le contexte de cette fenêtre.
  // C'est ce qu'il faut : le vrai DOM de la vraie page, et le vrai script, sans
  // les dépendances qui n'existent pas ici.
  const dom = new JSDOM(html, { url: 'https://hotesmart.vercel.app/apps/menages/prestataires',
                                runScripts: 'outside-only' })
  const w = dom.window
  w.alert = () => {}
  w.confirm = () => true
  w.fetch = async (url, opts) => {
    envois.push({ url, corps: JSON.parse((opts && opts.body) || '{}') })
    return { ok: true, status: 200, json: async () => ({ ok: true, sans_referent: [] }) }
  }
  w.ecrits = ecrits
  w.envois = envois
  // Le double de `supabase` capture l'update de `public_tokens` : c'est la
  // valeur qu'on veut inspecter, et la seule.
  w.supabase = {
    from (table) {
      const q = { table, champs: null }
      const chain = {
        update (c) { q.champs = c; return chain },
        select () { return chain }, delete () { return chain },
        order () { return Promise.resolve({ data: [], error: null }) },
        eq () { if (q.champs) { ecrits.push({ table, champs: q.champs }); q.champs = null }
                return Object.assign(Promise.resolve({ data: [], error: null }), chain) }
      }
      return chain
    }
  }
  vm.runInContext(src, dom.getInternalVMContext ? dom.getInternalVMContext() : w)
  return { w, t: w.__t || dom.window.__t, ecrits, envois, dom }
}

// Les appels qui ÉCRIVENT un périmètre — par opposition aux lectures que
// l'ouverture d'une fiche déclenche (`/api/disponibilites`).
function ecrituresDuPerimetre (envois) {
  return envois.filter(e => String(e.url).includes('/api/membres') ||
                            (e.corps && e.corps.action === 'liaisons'))
}

// ─── Le cas exact de la production ─────────────────────────────────────────

test('enregistrer une fiche n\'écrit QUE des références de biens dans property_ids', async () => {
  const { w, ecrits } = monterPage()
  const t = w.__t
  t.seed(BIENS, [
    { property_id: BIENS[0].id, provider_id: PROFIL, rang: 1, requires_ack: false, weekdays: [0, 1, 2, 3, 4, 5, 6], active: true },
    { property_id: BIENS[1].id, provider_id: PROFIL, rang: 1, requires_ack: false, weekdays: [0, 1, 2, 3, 4, 5, 6], active: true }
  ], [LIGNE_TOKEN])
  t.renderPrestataires()
  t.renderPropCheckboxes()

  // On ouvre la fiche comme l'hôte le fait : c'est `editPrestataire` qui coche
  // les 7 jours de chaque bien — y compris, et c'est le piège, ceux des biens
  // SANS liaison, dont `weekdays` est inconnu et vaut donc « tous les jours ».
  t.editPrestataire(LIGNE_TOKEN.id)
  await t.saveEdit(LIGNE_TOKEN.id)

  const maj = ecrits.find(e => e.table === 'public_tokens')
  assert.ok(maj, 'la fiche doit écrire public_tokens')
  const refs = maj.champs.property_ids
  const REFS = BIENS.map(b => b.id)

  // ⚠ L'ASSERTION QUI COMPTE : aucune valeur étrangère aux références de biens.
  // « 0 »…« 6 » sont les jours ; ce sont EXACTEMENT eux qu'on a retrouvés en
  // production, et une assertion sur la seule longueur les aurait ratés le jour
  // où un quatrième bien serait arrivé.
  const intrus = refs.filter(r => !REFS.includes(String(r)))
  assert.deepStrictEqual(intrus, [],
    'property_ids ne doit contenir que des références de biens, jamais un jour de la semaine')
  // Le périmètre du lien couvre La bulle et Cœur de vie : `editPrestataire`
  // décoche donc Colomiers, et le troisième bien ne doit pas revenir par ses
  // jours — c'est précisément par là qu'il revenait.
  assert.deepStrictEqual([...refs].sort(), LIGNE_TOKEN.property_ids.slice().sort(),
    'les deux biens du périmètre, et rien d\'autre')
})

test('décocher un bien le retire vraiment — ses jours ne le réintroduisent pas', async () => {
  // ⚠ LE CAS DANGEREUX (REVIEW.md règle 8), et il était réel : `majEtatDesRangs`
  // DÉSACTIVE les cases de jours d'un bien décoché, mais ne les décoche pas —
  // or `disabled` n'empêche pas `:checked`. Un bien retiré continuait donc de
  // verser ses sept jours dans `property_ids`.
  const { w, ecrits } = monterPage()
  const t = w.__t
  t.seed(BIENS, [], [LIGNE_TOKEN])
  t.renderPrestataires()
  t.renderPropCheckboxes()
  t.editPrestataire(LIGNE_TOKEN.id)

  const caseColomiers = w.document.getElementById('prop-' + BIENS[2].id)
  caseColomiers.checked = false
  caseColomiers.dispatchEvent(new w.Event('change'))
  await t.saveEdit(LIGNE_TOKEN.id)

  const maj = ecrits.find(e => e.table === 'public_tokens')
  const refs = (maj.champs.property_ids || []).map(String)
  assert.ok(!refs.includes(BIENS[2].id), 'le bien décoché ne doit plus être dans le périmètre')
  assert.deepStrictEqual(refs.sort(), [BIENS[0].id, BIENS[1].id].sort())
})

test('le périmètre envoyé à /api/membres décrit les MÊMES biens que public_tokens', async () => {
  // ⚠ DEUX TABLES, DEUX REPRÉSENTATIONS, UN SEUL GESTE. `profile_permissions`
  // porte des UUID, `public_tokens` des références provider : l'en-tête
  // d'api/membres.js exige qu'elles restent synchrones. Elles le sont
  // désormais par CONSTRUCTION — les deux sortent de `saisieDesBiens()` — et
  // c'est cette propriété-là qu'on verrouille, pas la valeur du jour.
  const { w, ecrits, envois } = monterPage()
  const t = w.__t
  t.seed(BIENS, [], [LIGNE_TOKEN])
  t.renderPrestataires()
  t.renderPropCheckboxes()
  t.editPrestataire(LIGNE_TOKEN.id)
  await t.saveEdit(LIGNE_TOKEN.id)

  const membres = envois.find(e => String(e.url).includes('/api/membres'))
  const refs = ecrits.find(e => e.table === 'public_tokens').champs.property_ids.map(String)
  const uuids = membres.corps.permissions.property_ids
  const attendus = BIENS.filter(b => refs.includes(b.id)).map(b => b.uuid).sort()
  assert.deepStrictEqual([...uuids].sort(), attendus,
    'même périmètre des deux côtés, dans les deux représentations')
})

test('les jours confiés partent bien dans les LIAISONS, eux', async () => {
  // Contre-épreuve du correctif : retirer les jours de `property_ids` ne doit
  // pas les perdre. Ils ont leur place — `property_cleaning_providers.weekdays`,
  // via l'action `liaisons` de /api/menages — et ils doivent y rester.
  const { w, envois } = monterPage()
  const t = w.__t
  t.seed(BIENS, [], [LIGNE_TOKEN])
  t.renderPrestataires()
  t.renderPropCheckboxes()
  t.editPrestataire(LIGNE_TOKEN.id)
  await t.saveEdit(LIGNE_TOKEN.id)

  const liaisons = envois.find(e => e.corps && e.corps.action === 'liaisons')
  assert.ok(liaisons, 'les liaisons doivent être enregistrées')
  for (const l of liaisons.corps.liaisons) {
    assert.deepStrictEqual([...l.weekdays].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6],
      'les sept jours sont confiés, et ils passent par les liaisons')
  }
})

// ─── Le périmètre VIDE, qui veut dire « tous les biens » ───────────────────

test('décocher TOUS les biens est refusé — un périmètre vide ouvre le compte entier', async () => {
  // ⚠ RÉGRESSION INTRODUITE PAR LE CORRECTIF LUI-MÊME, trouvée en review.
  // Tant que `saveEdit` relisait `#prop-checkboxes`, les sept cases de jours —
  // cochées et seulement `disabled` — gardaient le tableau NON VIDE, donc
  // restrictif. En retirant la pollution, on a rendu `[]` atteignable d'un geste
  // naturel. Or `api/menages-public.js`, `lib/cleaning/sync-menages.js` et
  // `lib/cron-arrival-code.js` lisent tous une liste vide comme « aucune
  // restriction » : la prestataire obtenait le planning, les voyageurs et les
  // codes d'arrivée de TOUS les biens du compte. La pollution masquait la faute.
  const { w, ecrits, envois } = monterPage()
  const t = w.__t
  t.seed(BIENS, [], [LIGNE_TOKEN])
  t.renderPrestataires()
  t.renderPropCheckboxes()
  t.editPrestataire(LIGNE_TOKEN.id)

  for (const b of BIENS) {
    const c = w.document.getElementById('prop-' + b.id)
    c.checked = false
    c.dispatchEvent(new w.Event('change'))
  }
  await t.saveEdit(LIGNE_TOKEN.id)

  // ⚠ RIEN N'EST ÉCRIT, NULLE PART. Refuser après l'appel à `/api/membres`
  // laisserait `profile_permissions.property_ids` à `[]` pendant que
  // `public_tokens` reste intact : deux périmètres contradictoires.
  assert.deepStrictEqual(ecrits, [], 'aucune écriture dans public_tokens')
  // ⚠ On n'exige pas `envois` VIDE : ouvrir la fiche charge les disponibilités
  // (`/api/disponibilites`), et c'est légitime. Ce qui ne doit pas partir, c'est
  // l'enregistrement lui-même.
  assert.deepStrictEqual(ecrituresDuPerimetre(envois), [],
    'ni le profil, ni les liaisons ne sont écrits')
})

test('un bien sans uuid est refusé, il n\'est plus filtré en silence', async () => {
  // ⚠ `/api/membres` reçoit des UUID, `public_tokens` des références provider.
  // Le `.filter(Boolean)` retirait un bien sans uuid d'un seul côté : les deux
  // représentations du même périmètre divergeaient sans un mot — exactement ce
  // que ce correctif prétend fermer.
  const { w, ecrits, envois } = monterPage()
  const t = w.__t
  const abimes = BIENS.map((b, i) => i === 1 ? { ...b, uuid: null } : b)
  t.seed(abimes, [], [LIGNE_TOKEN])
  t.renderPrestataires()
  t.renderPropCheckboxes()
  t.editPrestataire(LIGNE_TOKEN.id)
  await t.saveEdit(LIGNE_TOKEN.id)

  assert.deepStrictEqual(ecrits, [], 'aucune écriture tant que le périmètre est ambigu')
  assert.deepStrictEqual(ecrituresDuPerimetre(envois), [])
})

test('la création refuse le même périmètre vide, avec le même message', async () => {
  // La garde est partagée : deux formulations auraient divergé au premier
  // ajustement, et c'est le geste de l'hôte qui est le même des deux côtés.
  const { w, ecrits, envois } = monterPage()
  const t = w.__t
  t.seed(BIENS, [], [])
  t.renderPropCheckboxes()
  for (const b of BIENS) {
    const c = w.document.getElementById('prop-' + b.id)
    c.checked = false
    c.dispatchEvent(new w.Event('change'))
  }
  w.document.getElementById('presta-prenom').value = 'Nouvelle'
  w.document.getElementById('presta-nom').value = 'Dupont'
  await t.createPrestataire()
  assert.deepStrictEqual(ecrituresDuPerimetre(envois), [],
    'aucun profil créé sans périmètre exploitable')
  assert.deepStrictEqual(ecrits, [])
})

test('biens non chargés : le refus le DIT, il ne parle pas de cases à cocher', async () => {
  // ⚠ `loadProperties` met `properties = []` sur panne réseau ou HTTP. L'écran
  // affiche « Aucun bien trouvé » : répondre « Cochez au moins un bien » devant
  // un formulaire sans aucune case est un contresens — l'hôte chercherait une
  // case qui n'existe pas. Le refus protège toujours du périmètre vide ; c'est
  // le motif qui doit être vrai. Constat de review.
  const { w, ecrits, envois } = monterPage()
  const t = w.__t
  t.seed([], [], [LIGNE_TOKEN])
  t.renderPrestataires()
  t.renderPropCheckboxes()

  const motif = t.perimetreRefuse(t.saisieDesBiens())
  assert.ok(motif, 'on refuse toujours')
  assert.match(motif, /chargés/, 'le motif parle du chargement, pas de cases à cocher')
  assert.ok(!/Cochez/.test(motif))

  await t.saveEdit(LIGNE_TOKEN.id)
  assert.deepStrictEqual(ecrits, [], 'et rien n\'est écrit')
  assert.deepStrictEqual(ecrituresDuPerimetre(envois), [])
})

// ─── La contre-épreuve : ce test échouerait-il sur le code fautif ? ─────────

test('CONTRE-ÉPREUVE : le sélecteur d\'avril ramasse bien les jours, sur ce DOM', async () => {
  // ⚠ SANS CE TEST, LES QUATRE PRÉCÉDENTS NE PROUVENT RIEN. Ils passeraient
  // aussi si `renderPropCheckboxes` avait cessé de produire des cases de jours,
  // ou si le DOM monté ici ne ressemblait pas à celui du navigateur. On rejoue
  // donc la ligne exacte d'avant le correctif sur le DOM réellement produit, et
  // on exige qu'elle RATE — c'est la preuve que le piège est bien tendu.
  const { w } = monterPage()
  const t = w.__t
  t.seed(BIENS, [], [LIGNE_TOKEN])
  t.renderPrestataires()
  t.renderPropCheckboxes()
  t.editPrestataire(LIGNE_TOKEN.id)

  const ancien = [...w.document.querySelectorAll('#prop-checkboxes input:checked')].map(c => c.value)
  const REFS = BIENS.map(b => b.id)
  const intrus = ancien.filter(v => !REFS.includes(v))
  assert.ok(intrus.length > 0,
    'le sélecteur d\'avril DOIT ramasser des valeurs étrangères — sinon le piège n\'est pas tendu')
  assert.deepStrictEqual([...new Set(intrus)].sort(), ['0', '1', '2', '3', '4', '5', '6'],
    'et ces valeurs étrangères sont exactement les sept jours de la semaine')

  // ⚠ C'EST LA LIGNE DE PRODUCTION, AU CARACTÈRE PRÈS.
  // Relevée en base le 14 septembre 2026 sur le lien de Régina : 23 entrées
  // pour 2 biens — les deux références, chacune suivie de ses sept jours, plus
  // les sept jours de Colomiers, DÉCOCHÉ (ses cases sont `disabled`, pas
  // décochées, et `disabled` n'empêche pas `:checked`). Un test qui se serait
  // contenté de compter aurait raté l'ordre ; celui-ci dit exactement ce que
  // l'écran écrivait.
  assert.deepStrictEqual(ancien, [
    BIENS[0].id, '1', '2', '3', '4', '5', '6', '0',
    BIENS[1].id, '1', '2', '3', '4', '5', '6', '0',
    '1', '2', '3', '4', '5', '6', '0'
  ], 'le sélecteur d\'avril reproduit exactement la ligne trouvée en production')
  assert.strictEqual(ancien.length, 23)
})
