// tests/facture-page-dom.test.js — la page du VOYAGEUR pour sa facture
// (pages/facture.html, facture voyageur étape 2a), rendue dans jsdom.
// Spec : docs/specs/spec-facture-voyageur.md §2, §9 ; KB : docs/kb/facture-voyageur.md
//
// Ce que ce fichier prouve, en EXÉCUTANT la page :
//   - UN appel à l'ouverture (§9), en POST, le jeton dans le CORPS — jamais
//     dans l'URL de la requête ; un jeton mal formé ne fait AUCUN appel ;
//   - la page parle la langue de la demande, et le voyageur peut en changer ;
//   - le formulaire se vérifie avant l'envoi (mêmes règles que le serveur),
//     l'enregistrement montre l'état RELU par le serveur ;
//   - chaque refus du serveur a sa phrase (lien expiré, plafond, panne) ;
//   - la page est AUTONOME et au nom de l'hôte : aucune feuille ni script
//     externe, aucune mention de HôteSmart, la règle [hidden] en ligne.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const HTML = fs.readFileSync(path.join(__dirname, '..', 'pages', 'facture.html'), 'utf8')
const JETON = 'A'.repeat(20) + '_-' + 'b'.repeat(21)

const ETAT = (extra = {}) => ({
  ok: true, langue: 'fr', statut: 'lien_envoye', modifiable: true, destinataire: null,
  sejour: { logement: 'La bulle', arrivee: '2026-12-01', depart: '2026-12-04' }, ...extra
})
const DEST = { type: 'societe', nom: 'SCI Le Florian', adresse1: '24 allée des Coustous', adresse2: null, code_postal: '65200', ville: 'Bagnères-de-Bigorre', pays: 'France', tva: 'FR12345678901', siren: '123456789' }

function ouvrir ({ hash = JETON, reponses = [{ status: 200, corps: ETAT() }], recherche = '' } = {}) {
  const appels = []
  const file = [...reponses]
  const dom = new JSDOM(HTML, {
    url: `https://hote.example/facture${recherche}#${hash}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse (window) {
      Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
      window.fetch = async (url, opts) => {
        appels.push({ url, opts, corps: JSON.parse(opts.body) })
        const r = file.length > 1 ? file.shift() : file[0]
        return { status: r.status, json: async () => r.corps }
      }
    }
  })
  return { dom, d: dom.window.document, appels, file }
}
const attendre = () => new Promise(r => setTimeout(r, 20))
const visible = (el) => el && !el.hidden

test('UN appel à l\'ouverture, en POST, le jeton dans le CORPS et jamais dans l\'URL de la requête', async () => {
  const { appels } = ouvrir()
  await attendre()
  assert.equal(appels.length, 1)
  assert.equal(appels[0].url, '/api/facture-publique')
  assert.equal(appels[0].opts.method, 'POST')
  assert.deepEqual(appels[0].corps, { action: 'lire', jeton: JETON })
  assert.ok(!appels[0].url.includes(JETON))
  assert.equal(appels[0].opts.referrerPolicy, 'no-referrer')
  assert.equal(appels[0].opts.credentials, 'omit')
})

test('un jeton mal formé : AUCUN appel, et la page le dit', async () => {
  for (const hash of ['', 'court', JETON + 'x']) {
    const { d, appels } = ouvrir({ hash })
    await attendre()
    assert.equal(appels.length, 0, `appel pour « ${hash} »`)
    assert.ok(visible(d.getElementById('erreur')))
    assert.match(d.getElementById('erreur').textContent, /not valid|n’est pas valide/)
  }
})

test('la page parle la langue de la DEMANDE (fr), dit le séjour et quand la facture sera là', async () => {
  const { d } = ouvrir()
  await attendre()
  assert.equal(d.documentElement.lang, 'fr')
  assert.equal(d.title, 'La bulle')
  assert.equal(d.querySelector('h1').textContent, 'Votre facture')
  assert.equal(d.getElementById('sejour').textContent, 'Séjour à La bulle, du 1 décembre 2026 au 4 décembre 2026')
  assert.equal(d.getElementById('etat').textContent,
    'Votre facture sera disponible sur ce lien après votre séjour, à partir du 5 décembre 2026.')
  assert.ok(visible(d.getElementById('formulaire')), 'formulaire ouvert sans destinataire')
  assert.ok(!visible(d.getElementById('recap')))
})

test('le voyageur peut changer de langue ; ?lang= l\'emporte', async () => {
  const { d } = ouvrir()
  await attendre()
  d.querySelector('#langues button[data-lang="es"]').click()
  assert.equal(d.documentElement.lang, 'es')
  assert.equal(d.querySelector('h1').textContent, 'Su factura')
  assert.match(d.getElementById('sejour').textContent, /^Estancia en La bulle/)
  const avecParam = ouvrir({ recherche: '?lang=en' })
  await attendre()
  assert.equal(avecParam.d.querySelector('h1').textContent, 'Your invoice')
})

test('le formulaire se vérifie AVANT l\'envoi : champs requis, SIREN, TVA — aucun appel sur une faute', async () => {
  const { d, appels, dom } = ouvrir()
  await attendre()
  const f = d.getElementById('formulaire')
  f.dispatchEvent(new dom.window.Event('submit', { cancelable: true }))
  await attendre()
  assert.equal(appels.length, 1, 'rien de plus que la lecture')
  for (const c of ['type', 'nom', 'adresse1', 'ville', 'pays']) assert.ok(visible(f.querySelector(`[data-erreur="${c}"]`)), c)
  // Société : les champs SIREN et TVA apparaissent, et se vérifient.
  f.querySelector('input[value="societe"]').click()
  assert.ok(visible(d.getElementById('champs-societe')))
  assert.equal(d.getElementById('libelle-nom').textContent, 'Raison sociale')
  for (const [k, v] of Object.entries({ nom: 'SCI', adresse1: '1 rue', ville: 'Pau', pays: 'France', siren: '12', tva: 'X' })) f.elements[k].value = v
  f.dispatchEvent(new dom.window.Event('submit', { cancelable: true }))
  await attendre()
  assert.equal(appels.length, 1)
  assert.ok(visible(f.querySelector('[data-erreur="siren"]')))
  assert.ok(visible(f.querySelector('[data-erreur="tva"]')))
})

test('enregistrer : le destinataire part dans le corps, la page montre l\'état RELU par le serveur', async () => {
  const { d, appels, dom } = ouvrir({ reponses: [
    { status: 200, corps: ETAT() },
    { status: 200, corps: ETAT({ statut: 'formulaire_rempli', destinataire: DEST }) }
  ] })
  await attendre()
  const f = d.getElementById('formulaire')
  f.querySelector('input[value="societe"]').click()
  for (const k of ['nom', 'adresse1', 'code_postal', 'ville', 'pays', 'tva', 'siren']) f.elements[k].value = DEST[k]
  f.dispatchEvent(new dom.window.Event('submit', { cancelable: true }))
  await attendre()
  assert.equal(appels.length, 2)
  assert.equal(appels[1].corps.action, 'enregistrer')
  assert.equal(appels[1].corps.jeton, JETON)
  assert.equal(appels[1].corps.destinataire.nom, 'SCI Le Florian')
  assert.equal(appels[1].corps.destinataire.type, 'societe')
  assert.ok(!visible(f), 'formulaire refermé')
  assert.ok(visible(d.getElementById('recap')))
  assert.match(d.getElementById('recap-liste').textContent, /SCI Le Florian/)
  assert.match(d.getElementById('recap-liste').textContent, /65200 Bagnères-de-Bigorre/)
  // « Modifier » rouvre le formulaire, pré-rempli.
  d.getElementById('modifier').click()
  assert.ok(visible(f))
  assert.equal(f.elements.nom.value, 'SCI Le Florian')
})

test('un particulier n\'envoie ni SIREN ni TVA, même s\'ils restent dans des champs cachés', async () => {
  const { d, appels, dom } = ouvrir({ reponses: [{ status: 200, corps: ETAT() }, { status: 200, corps: ETAT({ destinataire: { ...DEST, type: 'particulier' } }) }] })
  await attendre()
  const f = d.getElementById('formulaire')
  f.querySelector('input[value="societe"]').click()
  f.elements.siren.value = '123456789'
  f.querySelector('input[value="particulier"]').click()
  for (const [k, v] of Object.entries({ nom: 'Léa Martin', adresse1: '1 rue', ville: 'Pau', pays: 'France' })) f.elements[k].value = v
  f.dispatchEvent(new dom.window.Event('submit', { cancelable: true }))
  await attendre()
  assert.equal(appels[1].corps.destinataire.siren, '')
  assert.equal(appels[1].corps.destinataire.tva, '')
})

test('chaque refus du serveur a sa phrase : expiré, invalide, plafond, panne', async () => {
  const expire = ouvrir({ reponses: [{ status: 410, corps: { motif: 'lien_expire' } }] })
  await attendre()
  assert.equal(expire.d.getElementById('erreur').textContent, 'This link has expired. Ask your host for a new link.')
  const plafond = ouvrir({ reponses: [{ status: 200, corps: ETAT() }, { status: 429, corps: { motif: 'plafond' } }] })
  await attendre()
  const f = plafond.d.getElementById('formulaire')
  f.querySelector('input[value="particulier"]').click()
  for (const [k, v] of Object.entries({ nom: 'Léa', adresse1: '1 rue', ville: 'Pau', pays: 'France' })) f.elements[k].value = v
  f.dispatchEvent(new plafond.dom.window.Event('submit', { cancelable: true }))
  await attendre()
  assert.match(plafond.d.getElementById('erreur-form').textContent, /trop souvent/)
  const panne = ouvrir({ reponses: [{ status: 503, corps: { motif: 'panne' } }] })
  await attendre()
  assert.match(panne.d.getElementById('erreur').textContent, /temporarily unavailable/)
})

test('réservation annulée, facture émise : un texte, PAS de formulaire', async () => {
  for (const [statut, texte] of [['sans_objet', /annulée : aucune facture/], ['emise', /a été émise/]]) {
    const { d } = ouvrir({ reponses: [{ status: 200, corps: ETAT({ statut, modifiable: false, destinataire: statut === 'emise' ? DEST : null }) }] })
    await attendre()
    assert.match(d.getElementById('etat').textContent, texte)
    assert.ok(!visible(d.getElementById('formulaire')))
    assert.ok(!visible(d.getElementById('recap')))
  }
})

test('AUTONOME et au nom de l\'hôte : aucune ressource externe, aucune mention de HôteSmart, [hidden] en ligne', () => {
  assert.doesNotMatch(HTML, /<link[^>]+stylesheet/i)
  assert.doesNotMatch(HTML, /<script[^>]+src=/i)
  assert.doesNotMatch(HTML.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, ''), /H[ôo]teSmart/i)
  assert.match(HTML, /<style>\[hidden\] \{ display: none !important; \}<\/style>/)
  assert.match(HTML, /<meta name="robots" content="noindex">/)
  assert.match(HTML, /<meta name="referrer" content="no-referrer">/)
  // Les trois langues ont les mêmes clés : une phrase oubliée serait vide.
  const dom = new JSDOM(HTML.replace(/charger\(\);\s*<\/script>/, '</script>'), { runScripts: 'dangerously', url: 'https://x.example/facture' })
  const T = dom.window.T
  const cles = Object.keys(T.fr).sort()
  for (const lg of ['en', 'es']) assert.deepEqual(Object.keys(T[lg]).sort(), cles, lg)
})

// ─── Correctifs de la review 1 (10 novembre 2026) ──────────────────────────
test('un point collé au lien par la messagerie ne casse pas le jeton ; un caractère de jeton de plus, si', async () => {
  const avecPoint = ouvrir({ hash: JETON + '.' })
  await attendre()
  assert.equal(avecPoint.appels.length, 1)
  assert.equal(avecPoint.appels[0].corps.jeton, JETON)
  const deTrop = ouvrir({ hash: JETON + 'x' })
  await attendre()
  assert.equal(deTrop.appels.length, 0)
})

test('accessibilité : erreurs reliées et focus sur la première, enregistrement annoncé, langues nommées', async () => {
  const { d, dom } = ouvrir({ reponses: [{ status: 200, corps: ETAT() }, { status: 200, corps: ETAT({ statut: 'formulaire_rempli', destinataire: DEST }) }] })
  await attendre()
  assert.equal(d.getElementById('langues').getAttribute('aria-label'), 'Langue')
  const f = d.getElementById('formulaire')
  for (const c of ['nom', 'adresse1', 'ville', 'pays', 'siren', 'tva']) {
    const id = f.elements[c].getAttribute('aria-describedby')
    assert.equal(d.getElementById(id).getAttribute('data-erreur'), c, c)
  }
  f.querySelector('input[value="particulier"]').click()
  f.dispatchEvent(new dom.window.Event('submit', { cancelable: true }))
  await attendre()
  assert.equal(d.activeElement, f.elements.nom, 'le focus va à la première faute')
  assert.equal(f.elements.nom.getAttribute('aria-invalid'), 'true')
  for (const [k, v] of Object.entries({ nom: 'Léa', adresse1: '1 rue', ville: 'Pau', pays: 'France' })) f.elements[k].value = v
  f.dispatchEvent(new dom.window.Event('submit', { cancelable: true }))
  await attendre()
  const annonce = d.getElementById('annonce')
  assert.equal(annonce.getAttribute('role'), 'status')
  assert.equal(annonce.textContent, 'Vos coordonnées de facturation sont enregistrées.')
})

test('les motifs sans phrase à leur nom en ont une : introuvable, entrée invalide sans champ, sans objet', async () => {
  const intro = ouvrir({ reponses: [{ status: 404, corps: { motif: 'introuvable' } }] })
  await attendre()
  assert.match(intro.d.getElementById('erreur').textContent, /not valid/)
  const so = ouvrir({ reponses: [{ status: 200, corps: ETAT() }, { status: 409, corps: { motif: 'sans_objet' } }, { status: 200, corps: ETAT({ statut: 'sans_objet', modifiable: false }) }] })
  await attendre()
  const f = so.d.getElementById('formulaire')
  f.querySelector('input[value="particulier"]').click()
  for (const [k, v] of Object.entries({ nom: 'Léa', adresse1: '1 rue', ville: 'Pau', pays: 'France' })) f.elements[k].value = v
  f.dispatchEvent(new so.dom.window.Event('submit', { cancelable: true }))
  await attendre()
  assert.match(so.d.getElementById('etat').textContent, /annulée : aucune facture/, 'l\'état relu après le refus')
})
