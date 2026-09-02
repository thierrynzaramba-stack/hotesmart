// tests/pages-non-delegables.test.js
//
// ⚠ LE CONTRESENS QUE CES TESTS FERMENT, trouvé au test humain.
// Masquer une entrée de menu ne ferme pas la page. `/settings` et `/connexions`
// s'ouvraient par URL directe pendant qu'on travaillait sur un compte partagé,
// et affichaient les données de L'APPELANT sans le dire : on lisait
// « vous agissez sur un compte partagé » dans la barre, et sa propre équipe ou
// ses propres clés PMS dans la page.
//
// Ce n'est pas une fuite — chacun voit les siennes — mais c'est pire à l'usage :
// on croit modifier un compte et on en modifie un autre.
//
// Ces tests figent le RECENSEMENT. Une page ajoutée au dépôt sans être classée
// fait échouer le dernier test : c'est ce qui empêche l'oubli.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')

// ─── Le recensement ─────────────────────────────────────────────────────────

// Pages qui montrent les données de la PERSONNE connectée, jamais celles du
// compte courant. Elles doivent refuser quand on est basculé.
const NON_DELEGABLES = [
  'pages/settings.html',            // équipe et droits du compte de l'appelant
  'pages/connexions.html',          // clés PMS — RLS `auth.uid()` stricte
  'pages/abonnement.html',          // facturation — domaine non délégable
  'pages/compte.html',              // identité pure
  'pages/onboarding.html',          // l'onboarding est celui de la personne
  'pages/biens-nouveau.html',       // la création de bien n'est pas déléguée
  'pages/biens-detail.html',        // connexion des annonces — `reglages`
  'apps/serrures/index.html',       // clé Seam
  'apps/sms/index.html',            // clé Brevo
  'apps/agent-ai/config.html',      // agent_prompting — `reglages`
  'apps/agent-ai/knowledge.html',   // knowledge — `reglages`
  'apps/agent-ai/messages.html',    // message_templates — `reglages`
  'apps/agent-ai/analyze.html',     // conversations + clé Beds24
  'apps/menages/prestataires.html'  // public_tokens — réservé au titulaire
]

// Pages qui fonctionnent RÉELLEMENT sur le compte courant : elles ne doivent
// surtout pas porter le garde-fou, sinon un membre n'a plus rien à consulter.
const DELEGABLES = [
  'pages/index.html',               // biens via channel-property
  'pages/biens.html',               // idem
  'pages/biens-calendrier.html',    // listProperties + calendrier par ressource
  'pages/calendrier-mobile.html',   // idem
  'apps/menages/index.html',        // délégué en vague 1
  'apps/agent-ai/messagerie.html',  // délégué en vague 1
  'pages/avis.html'                 // api/avis honore X-Compte (compteDelegue), domaine `avis`
]

// ─── Un test par page non délégable ─────────────────────────────────────────

for (const page of NON_DELEGABLES) {
  test(`${page} : refuse l'accès quand on est basculé`, () => {
    const html = lire(page)
    // ⚠ On verifie l'APPEL, pas seulement l'import. Ma premiere version testait
    // `includes('exigerCompteProprePage')` : retirer l'appel en laissant l'import
    // la laissait passer — le test ne voyait pas une page devenue ouverte.
    assert.ok(/await\s+exigerCompteProprePage\s*\(/.test(html),
      `${page} montre les données de l'appelant : elle doit APPELER le garde-fou`)
    assert.ok(/import\s*\{[^}]*exigerCompteProprePage[^}]*\}\s*from\s*'\/shared\/compte-courant\.js'/.test(html),
      `${page} appelle le garde-fou sans l'importer`)
    // ⚠ AVANT toute lecture de données : refuser après aurait déjà interrogé la
    // base et, pire, affiché brièvement le contenu.
    const iGarde = html.search(/await\s+exigerCompteProprePage\s*\(/)
    const iAuth  = html.indexOf('requireAuth()')
    if (iAuth > 0) {
      assert.ok(iGarde < iAuth,
        `${page} : le garde-fou doit précéder le chargement des données`)
    }
  })
}

// ─── Les pages déléguées ne doivent PAS le porter ───────────────────────────

for (const page of DELEGABLES) {
  test(`${page} : reste accessible sur un compte partagé`, () => {
    const html = lire(page)
    assert.ok(!html.includes('exigerCompteProprePage'),
      `${page} fonctionne sur le compte courant : le garde-fou l'y rendrait inutilisable`)
  })
}

// ─── Le filet : aucune page ne doit rester non classée ──────────────────────

test('RECENSEMENT : toute page authentifiée est classée', () => {
  // ⚠ C'est ce test qui empêche l'oubli. Une page ajoutée demain sans décision
  // sur sa délégabilité le fait échouer — on ne découvre pas le contresens en
  // production, comme cette fois-ci.
  const dossiers = [
    ...fs.readdirSync(path.join(racine, 'pages')).map(f => 'pages/' + f),
    ...fs.readdirSync(path.join(racine, 'apps')).flatMap(d => {
      const p = path.join(racine, 'apps', d)
      return fs.statSync(p).isDirectory()
        ? fs.readdirSync(p).map(f => `apps/${d}/${f}`) : []
    })
  ].filter(f => f.endsWith('.html'))

  // Pages publiques ou sans données de compte : hors du classement.
  const HORS_PERIMETRE = [
    'pages/login.html', 'pages/forgot-password.html', 'pages/reset-password.html',
    'pages/airbnb-retour.html', 'pages/guide.html', 'pages/invitation.html',
    'pages/diagnostic.html', 'pages/channels-test.html',
    'apps/menages/public.html'   // PWA prestataire : jeton, pas de session
  ]

  const classees = new Set([...NON_DELEGABLES, ...DELEGABLES, ...HORS_PERIMETRE])
  const oubliees = dossiers.filter(f => !classees.has(f))
  assert.deepStrictEqual(oubliees, [],
    'pages non classées : décidez si elles sont délégables, puis ajoutez-les à la liste')
})

test('le garde-fou est UNIQUE et partagé', () => {
  // ⚠ Recopié page par page, il divergerait — et c'est exactement ainsi qu'une
  // page finit par être oubliée.
  const source = lire('shared/compte-courant.js')
  assert.ok(source.includes('export async function exigerCompteProprePage'),
    'le garde-fou vit dans shared/compte-courant.js')
  for (const page of NON_DELEGABLES) {
    const html = lire(page)
    assert.ok(!html.includes('function exigerCompteProprePage'),
      `${page} redéfinit le garde-fou au lieu de l'importer`)
  }
})

test('le refus dit quoi faire, pas seulement non', () => {
  const source = lire('shared/compte-courant.js')
  assert.ok(source.includes('concerne votre propre compte'), 'le motif doit être explicite')
  assert.ok(source.includes('Rebasculez'), 'la sortie doit être indiquée')
  assert.ok(source.includes('hs-rebasculer'), 'un bouton doit permettre de revenir')
})
