// tests/connaissance-page.test.js — la page téléphone /connaissance, la
// redirection de l'ancienne page, et le « Hors IA » appliqué au modèle
// (KB V5, lot 3).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(RACINE, f), 'utf8')
const sansCommentaires = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const PAGE = lire('pages/connaissance.html')

test('LE TEST QUI COMPTE : la page téléphone charge nav.js et n enregistre JAMAIS de service worker', () => {
  // ⚠ L'APPLI EST INSTALLABLE EN PRODUCTION (PWA lot 1) : c'est `shared/nav.js`
  // qui pose le manifeste et enregistre le service worker, une fois, pour
  // toutes les pages. Une page qui en enregistrerait un elle-même ouvrirait une
  // seconde portée, et un second cache que personne ne vide.
  assert.match(PAGE, /<script src="\/shared\/nav\.js"><\/script>/)
  const code = sansCommentaires(PAGE)
  assert.ok(!/serviceWorker/.test(code), 'aucun appel au service worker dans la page')
  assert.ok(!/\/sw\.js/.test(code))
})

test('la page monte LA vue partagée, avec son sélecteur, et ne recopie aucune règle', () => {
  const code = sansCommentaires(PAGE)
  assert.match(code, /import \{ monterConnaissance \} from '\/shared\/connaissance-vue\.js'/)
  assert.match(code, /selecteur: true/)
  // Le volet de Messages monte la MÊME vue : la règle « le mobile suit
  // l'ordinateur » se tient par un seul module, jamais par deux copies.
  // Et Messages la charge À LA DEMANDE : jamais au chargement de la page.
  const messages = sansCommentaires(lire('pages/messages.html'))
  assert.match(messages, /await import\('\/shared\/connaissance-vue\.js'\)/)
  assert.ok(!/^import [^\n]*connaissance-vue/m.test(messages), 'aucun import statique : Messages ne paie pas le module')
  // Aucun appel direct à la base depuis la page : un écran = un endpoint.
  assert.ok(!/supabase\.from\(/.test(code))
  assert.ok(!/from\('knowledge'\)/.test(sansCommentaires(lire('shared/connaissance-vue.js'))))
})

test('venue d une conversation, le retour de la page rouvre CETTE conversation (recette du 7 novembre 2026)', () => {
  const code = sansCommentaires(PAGE)
  assert.match(code, /<a [^>]*href="\/pages\/messages"[^>]*data-bind="retour"/, 'sans conversation : la liste')
  // La réservation est lue À L'ARRIVÉE : changer de logement sur la page
  // l'efface de l'adresse, pas du retour.
  assert.match(code, /const resa = params\.get\('resa'\)\s*\n\s*if \(resa\) \$\('\[data-bind="retour"\]'\)\.href = '\/pages\/messages\?conv=' \+ encodeURIComponent\(resa\)/)
  assert.ok(code.indexOf("params.get('resa')") < code.indexOf('monterConnaissance({'), 'lue avant que la vue ne réécrive l adresse')
})

test('/connaissance est routée vers la page, et l ancienne page redirige vers le volet', () => {
  const vercel = JSON.parse(lire('vercel.json'))
  const r = (vercel.rewrites || []).find(x => x.source === '/connaissance')
  assert.ok(r, 'rewrite /connaissance')
  assert.equal(r.destination, '/pages/connaissance', 'cleanUrls : jamais de .html dans la destination')
  const ancienne = lire('apps/agent-ai/knowledge.html')
  assert.match(ancienne, /http-equiv="refresh" content="0;url=\/messages\?volet=connaissance"/)
  assert.match(ancienne, /location\.replace\('\/messages\?volet=connaissance'\)/)
  // ⚠ ET ELLE N'ÉCRIT PLUS RIEN : c'était son enregistrement (supprimer tout le
  // logement, réinsérer) qui aurait effacé « vérifiée le » et « Hors IA ».
  assert.ok(!/from\('knowledge'\)/.test(ancienne))
  assert.ok(!/Beds24/.test(sansCommentaires(ancienne)), 'l import Beds24 n est pas repris (décision du 5 novembre 2026)')
})

test('aucun écran V5 ne garde le bouton « Importer depuis Beds24 »', () => {
  for (const f of ['shared/connaissance-vue.js', 'pages/connaissance.html', 'api/ecran/connaissance.js']) {
    assert.ok(!/channel-property|Importer depuis Beds24|importFromBeds24/.test(sansCommentaires(lire(f))), f)
  }
})

test('LE TEST QUI COMPTE : « Hors IA » sort l entrée du contexte envoyé au MODÈLE', () => {
  // ⚠ ON APPELLE LE BÂTISSEUR, celui des quatre chemins de l'IA (cron Beds24,
  // cron Channex, proposition à la demande, simulateur). Un cadenas affiché à
  // l'écran et ignoré ici mentirait à l'hôte — et la valeur partirait au
  // voyageur.
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
  const { buildKnowledgeText } = require('../lib/cron-classify')
  const texte = buildKnowledgeText([
    { type: 'fixed', key: 'wifi_nom', value: 'RESEAU-OUVERT', lisible_par_ia: true },
    { type: 'fixed', key: 'code_immeuble', value: 'SECRET-IMMEUBLE', lisible_par_ia: false },
    { type: 'faq', key: 'Parking', value: 'Gratuit', lisible_par_ia: true },
    { type: 'faq', key: 'Boîte à clés', value: 'SECRET-BOITE', lisible_par_ia: false },
    // ⚠ COLONNE ABSENTE (migration pas encore passée) : l'IA lit, comme avant.
    { type: 'faq', key: 'Animaux', value: 'Acceptés' }
  ])
  assert.ok(texte.includes('RESEAU-OUVERT'))
  assert.ok(texte.includes('Gratuit'))
  assert.ok(texte.includes('Acceptés'), 'sans la colonne, rien n est coupé')
  assert.ok(!texte.includes('SECRET-IMMEUBLE'), 'un fait Hors IA ne part pas au modèle')
  assert.ok(!texte.includes('SECRET-BOITE'), 'une réponse Hors IA ne part pas au modèle')
  // Tout Hors IA : un contexte vide, pas une rubrique vide.
  assert.equal(buildKnowledgeText([{ type: 'faq', key: 'x', value: 'y', lisible_par_ia: false }]), '')
  assert.equal(buildKnowledgeText([]), '')
})

test('LE TEST QUI COMPTE : l IA lit ce que le voyageur recevrait — adresse de la FICHE, horaires effectifs', () => {
  // Spec Accueil du voyageur, S3 : sans les replis, l'IA perdait l'adresse le
  // jour où la ligne de la base disparaît, et ignorait les horaires de la fiche.
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
  const { buildKnowledgeText } = require('../lib/cron-classify')
  const { replisDuBien } = require('../lib/balises')
  const replis = replisDuBien({ address: '12 rue Fiche', checkin_time: '16:00' })
  const texte = buildKnowledgeText([
    { type: 'fixed', key: 'adresse', value: '9 rue Ancienne', lisible_par_ia: true },
    { type: 'fixed', key: 'wifi_nom', value: 'RESEAU', lisible_par_ia: true },
    { type: 'fixed', key: 'equip_lits', value: 'deux lits', lisible_par_ia: true }
  ], { replis })
  assert.ok(texte.includes('- adresse : 12 rue Fiche'), texte)
  assert.ok(!texte.includes('9 rue Ancienne'), 'une adresse restée dans la base ne part plus au modèle')
  assert.ok(texte.includes('- checkin : 16:00'), 'l heure de la fiche')
  assert.ok(texte.includes('- checkout : 10:00'), 'le défaut, comme l envoi')
  assert.ok(texte.includes('- wifi_nom : RESEAU'))
  assert.ok(!texte.includes('wifi_mdp'), 'une info vide n est pas inventée')
  assert.ok(texte.includes('- equip_lits : deux lits'), 'une clé sans balise reste lue')
  // ⚠ « HORS IA » COUVRE AUSSI LE REPLI : l'hôte a dit « pas à l'IA » pour
  // cette info, la fiche ne la lui rend pas par la bande.
  const cache = buildKnowledgeText([{ type: 'fixed', key: 'checkin', value: '15:00', lisible_par_ia: false }], { replis })
  assert.ok(!/checkin/.test(cache), cache)
  // Sans le bien (appelant ancien) : la base seule, sauf l'adresse.
  const sansBien = buildKnowledgeText([{ type: 'fixed', key: 'adresse', value: '9 rue Ancienne' }, { type: 'fixed', key: 'checkin', value: '15:00' }])
  assert.ok(!sansBien.includes('9 rue Ancienne'))
  assert.ok(sansBien.includes('- checkin : 15:00'))
})

test('les quatre chemins de l IA lisent `lisible_par_ia` (select *) et passent par le bâtisseur', () => {
  for (const f of ['lib/cron-classify.js', 'api/simulate.js', 'api/guestflow-proposer.js']) {
    const src = sansCommentaires(lire(f))
    const lectures = src.match(/from\('knowledge'\)[\s\S]{0,40}?\.select\('([^']*)'\)/g) || []
    assert.ok(lectures.length, f + ' lit knowledge')
    for (const l of lectures) assert.match(l, /select\('\*'\)/, f + ' : la colonne doit venir avec la ligne')
    // ⚠ ET AVEC LES REPLIS DU BIEN (spec Accueil du voyageur, S3) : sans eux,
    // l'IA perd l'adresse, qui ne vit plus que dans la fiche du logement.
    const appels = src.match(/buildKnowledgeText\(knowledge \|\| \[\][^\n]*/g) || []
    assert.ok(appels.length, f + ' passe par le bâtisseur')
    for (const a of appels) assert.match(a, /\{ replis: replisDuBien\(/, f + ' : ' + a)
  }
})

test('« où le remplir » nomme la FICHE du logement, avec l étiquette que l écran affiche', () => {
  // Lot « Accueil du voyageur » (8 novembre 2026) : ces infos ont quitté la
  // base pour la fiche du logement ; l'adresse vit dans le bloc « Le logement ».
  const { OU_REMPLIR, DE_LA_BASE, etiquetteDe } = require('../lib/balises')
  for (const cle of DE_LA_BASE) {
    const attendu = cle === 'adresse'
      ? 'Logements → <nom du logement> → Le logement → Adresse'
      : `Logements → <nom du logement> → Accueil du voyageur → ${etiquetteDe(cle)}`
    assert.equal(OU_REMPLIR[cle], attendu, cle)
  }
  // Les blocs nommés existent dans la fiche, sous ces mots.
  const fr = require('../shared/i18n/fr.json')
  assert.equal(fr['fiche.bloc_accueil'], 'Accueil du voyageur')
  assert.equal(fr['fiche.bloc_logement'], 'Le logement')
})
