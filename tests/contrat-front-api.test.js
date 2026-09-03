// tests/contrat-front-api.test.js
// Le corps que les ÉCRANS envoient est-il accepté par les ENDPOINTS ?
//
// ⚠ POURQUOI CE TEST EXISTE — et pourquoi il aurait dû exister avant.
// La création d'un prestataire échouait entièrement en production avec
// « Action inconnue » : `apps/menages/prestataires.html` appelait
// `/api/membres` **sans** champ `action`, que l'endpoint lit avant toute autre
// chose et rejette en 400 s'il ne la connaît pas. Diagnostiqué sur la prod :
//   POST /api/membres  {first_name,…} sans action  → 400 "Action inconnue"
//   POST /api/membres  {action:'create',…}         → 401 (action reconnue)
//
// Rien ne l'a vu : 1063 tests couvraient le serveur (les handlers, leurs gardes)
// et les écrans (leurs identifiants, leur rendu), mais RIEN ne confrontait ce
// qu'un écran envoie à ce qu'un endpoint accepte. C'est l'angle mort exact entre
// les deux — la même famille que `pages-ids.test.js`, qui existe parce qu'un
// refactor avait laissé une référence à un élément supprimé.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = f => fs.readFileSync(path.join(racine, f), 'utf8')

// Les écrans qui parlent aux endpoints à actions.
const ECRANS = [
  'apps/menages/prestataires.html',
  'apps/menages/index.html',
  'apps/menages/public.html',
  'pages/settings.html',
  'pages/avis.html'
]

// Les actions réellement acceptées, LUES DANS LE CODE SERVEUR — jamais
// recopiées ici : une liste tenue à la main diverge le jour où l'on ajoute une
// action, et le test cesse de dire la vérité.
function actionsDe (fichier, motif) {
  const src = lire(fichier)
  const trouvees = new Set()
  let m
  const re = new RegExp(motif, 'g')
  while ((m = re.exec(src))) trouvees.add(m[1])
  return trouvees
}

const ACTIONS = {
  '/api/membres': actionsDe('api/membres.js', "case '([a-z_]+)':"),
  // `menages` route sur `action === 'liaisons'` puis retombe sur la
  // réassignation, qui n'a pas de nom d'action.
  '/api/menages': new Set(['liaisons', undefined]),
  '/api/menages-public': actionsDe('api/menages-public.js', "action === '([A-Za-z]+)'")
}

// Extrait les appels `fetch('/api/x', { … body: JSON.stringify({ … }) })`.
// Grossier — analyse textuelle, pas un parseur — mais c'est exactement le
// niveau qui attrape la classe d'erreur visée.
function appels (src) {
  const out = []
  const re = /fetch\(\s*[`'"]([^`'"?]*\/api\/[a-z-]+)[^`'"]*[`'"]\s*,\s*\{/g
  let m
  while ((m = re.exec(src))) {
    const url = m[1]
    const suite = src.slice(m.index, m.index + 1400)
    if (!/method:\s*['"]POST['"]/.test(suite)) continue
    const corps = suite.match(/JSON\.stringify\(\s*\{([\s\S]{0,900}?)\}\s*\)/)
    if (!corps) continue
    const act = corps[1].match(/(?:^|[\s,{])action:\s*(?:'([^']+)'|([A-Za-z?.\s'":!=&|]+))/)
    out.push({
      url,
      // Action littérale, ou expression (ternaire) : on retient les littéraux
      // qu'elle contient.
      litterale: act && act[1] ? act[1] : null,
      expression: act && !act[1] ? act[0] : null,
      brut: corps[1]
    })
  }
  return out
}

test('les actions du serveur ont bien été lues (le test ne teste pas le vide)', () => {
  // ⚠ Une liste vide rendrait toutes les assertions triviales : le test
  // passerait sur n'importe quel écran, y compris celui qui n'envoie rien.
  assert.ok(ACTIONS['/api/membres'].size >= 5,
    `actions de /api/membres introuvables : ${[...ACTIONS['/api/membres']]}`)
  assert.ok(ACTIONS['/api/membres'].has('create'))
  assert.ok(ACTIONS['/api/menages-public'].size >= 3,
    `actions de /api/menages-public introuvables : ${[...ACTIONS['/api/menages-public']]}`)
})

for (const ecran of ECRANS) {
  test(`${ecran} : chaque POST porte une action que l'endpoint accepte`, () => {
    const src = lire(ecran)
    for (const a of appels(src)) {
      const connues = ACTIONS[a.url]
      if (!connues) continue   // endpoint sans vocabulaire d'actions

      // 1. Une action DOIT être présente quand l'endpoint en exige une.
      if (a.url === '/api/membres') {
        assert.ok(a.litterale || a.expression,
          `${ecran} POST ${a.url} sans champ \`action\` : l'endpoint rejette en 400 ` +
          `« Action inconnue » AVANT même de vérifier la session. Corps : ${a.brut.trim().slice(0, 120)}…`)
      }

      // 2. Si elle est littérale, elle doit exister côté serveur.
      if (a.litterale) {
        assert.ok(connues.has(a.litterale),
          `${ecran} envoie action='${a.litterale}' à ${a.url}, que l'endpoint ne connaît pas. ` +
          `Actions acceptées : ${[...connues].filter(Boolean).join(', ')}`)
      }

      // 3. Si elle est une expression, tous ses littéraux doivent exister.
      if (a.expression) {
        for (const lit of a.expression.match(/'([A-Za-z_]+)'/g) || []) {
          const nom = lit.slice(1, -1)
          assert.ok(connues.has(nom),
            `${ecran} peut envoyer action='${nom}' à ${a.url}, inconnue du serveur.`)
        }
      }
    }
  })
}

test('le parcours de création d\'un prestataire est complet, de bout en bout', () => {
  // ⚠ LE TEST QUI MANQUAIT. Il ne suffit pas que chaque action existe : le
  // parcours entier doit tenir — créer la personne, puis lui poser ses biens et
  // leurs rangs. Il manquait l'un des deux appels, et la création échouait.
  const src = lire('apps/menages/prestataires.html')
  const posts = appels(src)

  const creation = posts.find(a => a.url === '/api/membres' && a.litterale === 'create')
  assert.ok(creation, 'la création doit appeler /api/membres action=create')
  assert.match(creation.brut, /access_mode:\s*'lien'/, 'en mode lien : un prestataire n\'a pas de compte')
  assert.match(creation.brut, /property_ids/, 'avec le périmètre, sinon sa PWA est vide')

  const liaison = posts.find(a => a.url === '/api/menages' && a.litterale === 'liaisons')
  assert.ok(liaison, 'et poser les liaisons, sinon aucun ménage ne lui sera assigné')
  assert.match(liaison.brut, /provider_id/)
  assert.match(liaison.brut, /rang/, 'avec le rang : c\'est lui qui décide de l\'engagement')

  // Les deux autres actions du cycle de vie, pour que le lot reste utilisable.
  assert.ok(posts.some(a => a.url === '/api/membres' && a.litterale === 'update'),
    'modifier un prestataire passe par /api/membres action=update')
  assert.ok(posts.some(a => a.url === '/api/membres' && a.litterale === 'deactivate'),
    'le retirer passe par /api/membres action=deactivate')
})

test('les corps envoyés à /api/membres portent `profile_id`, jamais `id`', () => {
  // ⚠ Déjà corrigé une fois : `chargerCible` lit `b.profile_id`. Envoyer `id`
  // rend 400 « Identifiant de profil requis », et l'écran sortait avant
  // d'écrire quoi que ce soit — modifier et supprimer étaient inopérants.
  const src = lire('apps/menages/prestataires.html')
  for (const a of appels(src)) {
    if (a.url !== '/api/membres') continue
    if (!/action:\s*'(update|deactivate|reactivate|regenerate|lien)'/.test(a.brut)) continue
    assert.ok(/profile_id/.test(a.brut),
      `corps sans \`profile_id\` : ${a.brut.trim().slice(0, 120)}…`)
    assert.ok(!/(?:^|[\s,{])id:/.test(a.brut),
      `corps avec \`id\` au lieu de \`profile_id\` : ${a.brut.trim().slice(0, 120)}…`)
  }
})
