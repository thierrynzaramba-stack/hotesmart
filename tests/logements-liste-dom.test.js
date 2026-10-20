// tests/logements-liste-dom.test.js — LA LISTE V5 DES LOGEMENTS, en jsdom.
//
// Étape 1 du lot Logements. Le rendu vit dans `shared/logements-liste.js` et pas
// dans la balise `<script>` de la page, précisément pour qu'il se teste ici sans
// extraction à la regex.
//
// Les trois qui comptent :
//   1. un fait daté qu'on n'a pas pu lire ne devient JAMAIS « Libre » ;
//   2. « aucun canal relié » et « canaux non vérifiés » sont deux rendus
//      DIFFÉRENTS — les confondre est le défaut que la dette 59 a fermé ;
//   3. « Ajoutez votre premier logement » ne s'affiche que sur une lecture
//      RÉUSSIE et vide, jamais sur une panne.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

let M
test.before(async () => { M = await import('../shared/logements-liste.js') })

// Le dictionnaire RÉEL, pas un double : un test qui inventerait ses propres
// textes ne dirait rien sur les clés que la page demande.
const FR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', 'fr.json'), 'utf8'))
const CLES_DEMANDEES = new Set()
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const t = (cle, vars = {}) => {
  CLES_DEMANDEES.add(cle)
  let s = FR[cle]
  assert.ok(s != null, `clé i18n absente de fr.json : ${cle}`)
  // Pluriels ICU, réduits à ce que le moteur du dépôt fait.
  s = s.replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g, (_, k, corps) => {
    const n = Number(vars[k] ?? 0)
    const cas = {}
    corps.replace(/(=\d+|\w+)\s*\{([^{}]*)\}/g, (__, c, v) => { cas[c] = v })
    const choisi = cas[`=${n}`] ?? cas[new Intl.PluralRules('fr').select(n)] ?? cas.other ?? ''
    return choisi.replace(/#/g, String(n))
  })
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`))
}
const dateEnClair = (iso) => `le-${iso}`
const icone = (id) => `<svg data-icone="${id}"></svg>`
const OUTILS = () => ({ t, esc, dateEnClair, icone })

const doc = (html) => new JSDOM(`<!doctype html><body><div id="c">${html}</div></body>`).window.document

const bien = (extra = {}) => ({
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', nom: 'La bulle', ville: 'Bagnères',
  capacite: 2, photo_url: null, assistant_en_pause: false, canaux_echec: false,
  canaux: [{ ota: 'airbnb', titre: 'x', actif: true, mappe: true, listing_url: null }],
  fait_date: { type: 'libre', du: null, au: null, occupe: false, ferme: false },
  ...extra
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. Le fait daté
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : un fait daté NON LU ne devient jamais « Libre »', () => {
  const d = doc(M.carteHtml(bien({ fait_date: null }), OUTILS()))
  const ligne = d.querySelector('[data-fait]')
  assert.equal(ligne.dataset.fait, 'indisponible')
  assert.equal(ligne.textContent, 'Information indisponible')
  assert.ok(ligne.classList.contains('log-fait--muet'), 'il se lit comme une absence, pas comme un fait')
  assert.doesNotMatch(d.querySelector('.log-carte').textContent, /Libre/,
    'afficher « Libre » sur un bien dont on n a pas pu lire les réservations est un mensonge commercial')
})

test('les cinq types de fait daté donnent cinq phrases distinctes', () => {
  const phrase = (fait) => doc(M.carteHtml(bien({ fait_date: fait }), OUTILS())).querySelector('[data-fait]').textContent
  assert.equal(phrase({ type: 'occupe', du: null, au: '2026-10-22' }), 'Occupé · départ le le-2026-10-22')
  assert.equal(phrase({ type: 'ferme', du: null, au: '2026-10-21' }), 'Fermé jusqu’au le-2026-10-21')
  assert.equal(phrase({ type: 'arrivee', du: '2026-10-25', au: null }), 'Libre jusqu’au le-2026-10-25')
  assert.equal(phrase({ type: 'fermeture', du: '2026-11-02', au: '2026-11-10' }), 'Fermé du le-2026-11-02 au le-2026-11-10')
  assert.equal(phrase({ type: 'libre', du: null, au: null }), 'Libre · aucune arrivée prévue')
  // Cinq phrases, cinq textes : aucune ne doit se confondre avec une autre.
  const toutes = ['occupe', 'ferme', 'arrivee', 'fermeture', 'libre']
    .map(ty => phrase({ type: ty, du: '2026-11-02', au: '2026-11-10' }))
  assert.equal(new Set(toutes).size, 5)
})

test('un type de fait INCONNU se tait, il ne se devine pas', () => {
  const d = doc(M.carteHtml(bien({ fait_date: { type: 'teleportation' } }), OUTILS()))
  assert.equal(d.querySelector('[data-fait]').textContent, 'Information indisponible')
})

test('la décision de Thierry, en bout de chaîne : une fermeture à venir n affiche pas « Libre »', () => {
  const d = doc(M.carteHtml(bien({ fait_date: { type: 'fermeture', du: '2026-11-02', au: '2026-11-10' } }), OUTILS()))
  const texte = d.querySelector('[data-fait]').textContent
  assert.match(texte, /^Fermé du /)
  assert.doesNotMatch(texte, /Libre/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Les pastilles de canaux — quatre rendus, pas deux
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : « aucun canal » et « non vérifiés » sont DEUX rendus différents', () => {
  const lu = doc(M.carteHtml(bien({ canaux: [] }), OUTILS()))
  assert.equal(lu.querySelector('[data-canaux]').dataset.canaux, 'aucun')
  assert.equal(lu.querySelector('[data-canaux]').textContent, 'Aucun canal relié')

  const nonLu = doc(M.carteHtml(bien({ canaux: null }), OUTILS()))
  assert.equal(nonLu.querySelector('[data-canaux]').dataset.canaux, 'non-lus')
  assert.equal(nonLu.querySelector('[data-canaux]').textContent, 'Canaux non vérifiés')

  assert.notEqual(lu.querySelector('[data-canaux]').textContent,
    nonLu.querySelector('[data-canaux]').textContent,
    'lire « aucun canal » quand on en a deux est exactement le défaut que la dette 59 a fermé')
})

test('les trois états d un canal sont distincts, `mappe: null` compris', () => {
  const d = doc(M.carteHtml(bien({ canaux: [
    { ota: 'airbnb', mappe: true }, { ota: 'booking', mappe: false }, { ota: 'direct', mappe: null }
  ] }), OUTILS()))
  const etats = [...d.querySelectorAll('[data-ota]')].map(x => [x.dataset.ota, x.dataset.etat])
  assert.deepEqual(etats, [['airbnb', 'vente'], ['booking', 'pas-ce-bien'], ['direct', 'indetermine']])
  // Et chaque état porte son explication au survol.
  const titres = [...d.querySelectorAll('[data-ota]')].map(x => x.getAttribute('title'))
  assert.deepEqual(titres, ['En vente', 'Pas en vente sur ce logement', 'Vérification impossible pour l’instant'])
  assert.equal(new Set(titres).size, 3)
})

test('D11 : « — inactif » a disparu au profit de « Pas en vente sur ce logement »', () => {
  const d = doc(M.carteHtml(bien({ canaux: [{ ota: 'booking', mappe: false }] }), OUTILS()))
  assert.doesNotMatch(d.body.textContent, /inactif/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. La carte
// ═══════════════════════════════════════════════════════════════════════════

test('D3 : une capacité vide n affiche RIEN, pas « 0 voyageur »', () => {
  const avec = doc(M.carteHtml(bien({ capacite: 4 }), OUTILS()))
  assert.equal(avec.querySelector('.log-sous').textContent, 'Bagnères · 4 voyageurs')
  const sans = doc(M.carteHtml(bien({ capacite: null }), OUTILS()))
  assert.equal(sans.querySelector('.log-sous').textContent, 'Bagnères')
  assert.doesNotMatch(sans.body.textContent, /0 voyageur|personne\(s\)/)
  // Ni ville ni capacité : la ligne n existe pas du tout.
  const rien = doc(M.carteHtml(bien({ capacite: null, ville: null }), OUTILS()))
  assert.equal(rien.querySelector('.log-sous'), null)
})

test('le pluriel suit le nombre', () => {
  const un = doc(M.carteHtml(bien({ capacite: 1 }), OUTILS()))
  assert.match(un.querySelector('.log-sous').textContent, /1 voyageur$/)
})

test('UN SEUL signal par carte, et la pause passe avant la vérification', () => {
  const pause = doc(M.carteHtml(bien({ assistant_en_pause: true, canaux_echec: true }), OUTILS()))
  const signaux = pause.querySelectorAll('[data-signal]')
  assert.equal(signaux.length, 1, 'une carte qui crie trois fois ne dit plus rien')
  assert.equal(signaux[0].textContent, 'Assistant en pause')

  const echec = doc(M.carteHtml(bien({ canaux_echec: true }), OUTILS()))
  assert.equal(echec.querySelector('[data-signal]').textContent, 'Vérification impossible pour l’instant')

  const rien = doc(M.carteHtml(bien(), OUTILS()))
  assert.equal(rien.querySelector('[data-signal]'), null)
})

test('la photo a un repli, et il n est pas une image cassée', () => {
  const sans = doc(M.carteHtml(bien({ photo_url: null }), OUTILS()))
  assert.equal(sans.querySelector('.log-photo img'), null)
  assert.equal(sans.querySelector('.log-photo [data-icone]').dataset.icone, 'i-home')
  const avec = doc(M.carteHtml(bien({ photo_url: 'https://x/p.jpg' }), OUTILS()))
  assert.equal(avec.querySelector('.log-photo img').getAttribute('src'), 'https://x/p.jpg')
  assert.equal(avec.querySelector('.log-photo img').getAttribute('alt'), '',
    'la photo est décorative : le nom du logement est déjà dans la carte')
})

test('le nom du logement est échappé — un nom n est pas du HTML', () => {
  const d = doc(M.carteHtml(bien({ nom: '<img src=x onerror=alert(1)>' }), OUTILS()))
  assert.equal(d.querySelectorAll('.log-nom img').length, 0)
  assert.equal(d.querySelector('.log-nom').textContent, '<img src=x onerror=alert(1)>')
})

test('AUCUN identifiant du partenaire ne peut sortir : la carte ne lit que des champs publiés', () => {
  // Contre-épreuve : on glisse des champs interdits dans l objet, et on vérifie
  // qu ils n apparaissent nulle part. L endpoint ne les descend pas — mais la
  // carte ne doit pas devenir le chemin par lequel ils sortiraient un jour.
  const piege = bien({
    provider_property_id: '209413', provider_rate_plan_id: 'RP-SECRET',
    provider: 'channex', provider_channel_id: 'CH-SECRET'
  })
  const html = M.carteHtml(piege, OUTILS())
  for (const interdit of ['209413', 'RP-SECRET', 'CH-SECRET', 'channex']) {
    assert.ok(!html.includes(interdit), `la carte laisse passer ${interdit}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Les quatre états de la page
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : « vide » et « panne » ne se confondent pas', () => {
  assert.equal(M.etatDeLaPage({ biens: [] }), 'vide')
  assert.equal(M.etatDeLaPage({ biens: [bien()] }), 'liste')
  assert.equal(M.etatDeLaPage({ erreur: { status: 503 } }), 'panne')
  assert.equal(M.etatDeLaPage({ erreur: { status: 403 } }), 'refus')
  // Pas de liste du tout, sans erreur levée : c est une panne, pas un compte vide.
  assert.equal(M.etatDeLaPage({ biens: null }), 'panne')
  assert.equal(M.etatDeLaPage({}), 'panne')
})

test('« Ajoutez votre premier logement » ne s affiche QUE sur une lecture réussie et vide', () => {
  const cles = (quoi) => [...doc(M.etatHtml(quoi)).querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n)
  assert.ok(cles('vide').includes('logements.vide_titre'))
  assert.ok(!cles('panne').includes('logements.vide_titre'),
    'le dire sur une panne ferait lire « vous n avez aucun logement » à un hôte qui en a quatre')
  assert.ok(!cles('refus').includes('logements.vide_titre'))
})

test('une panne propose de RÉESSAYER ; un refus de droit ne propose rien', () => {
  assert.ok(doc(M.etatHtml('panne')).querySelector('[data-bind="reessayer"]'))
  assert.equal(doc(M.etatHtml('refus')).querySelector('[data-bind="reessayer"]'), null,
    'proposer de réessayer un refus de droit ferait cliquer l hôte dans le vide')
  assert.deepEqual([...doc(M.etatHtml('refus')).querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n),
    ['logements.refus'])
})

test('l état vide mène au formulaire EXISTANT, pas à un écran qui n existe pas', () => {
  const liens = [...doc(M.etatHtml('vide')).querySelectorAll('a')].map(a => a.getAttribute('href'))
  assert.deepEqual(liens, ['/pages/connexions', '/biens/nouveau'])
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Les règles de la charte, vérifiées sur le rendu
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : aucun texte en dur — toute chaîne visible vient de l i18n', () => {
  // On rend tout ce que le module sait rendre, puis on vérifie que le texte
  // affiché est COUVERT par les clés demandées. Un libellé écrit en dur dans le
  // module passerait tous les autres tests sans jamais être traduit (défaut D1).
  CLES_DEMANDEES.clear()
  const html = [
    M.carteHtml(bien({ assistant_en_pause: true, canaux: null, fait_date: null }), OUTILS()),
    M.carteHtml(bien({ canaux: [], fait_date: { type: 'fermeture', du: '2026-11-02', au: '2026-11-10' } }), OUTILS()),
    M.etatHtml('vide'), M.etatHtml('refus'), M.etatHtml('panne')
  ].join('')
  const d = doc(html)
  const traductions = [...CLES_DEMANDEES].map(c => FR[c])
  for (const noeud of d.querySelectorAll('.log-pastille, .log-fait, .log-signal, .log-sous')) {
    const texte = noeud.textContent.trim()
    if (!texte) continue
    const couvert = traductions.some(tr => {
      const motif = String(tr).replace(/\{[^}]*\}/g, '').split(/\s+/).filter(m => m.length > 3)
      return motif.length ? motif.every(m => texte.includes(m)) : false
    }) || /^(Bagnères|airbnb|booking|direct)/.test(texte)
    assert.ok(couvert, `texte non traduit dans le rendu : « ${texte} »`)
  }
  // ⚠ DEUX CHEMINS DE TRADUCTION, ET LES DEUX SE VÉRIFIENT. Les cartes passent
  // par `t()` ; les zones d état posent des `data-i18n` que la page traduit
  // après insertion. Mon premier seuil ne comptait que le premier chemin, et
  // réclamait 8 clés là où il n en voyait que 6 : il mesurait la moitié du
  // rendu. Une clé `data-i18n` absente du dictionnaire afficherait la CLÉ BRUTE
  // à l écran — « logements.vide_titre » au lieu du titre.
  const posees = [...d.querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n)
  for (const cle of posees) {
    assert.ok(FR[cle] != null, `clé posée en data-i18n et absente de fr.json : ${cle}`)
  }
  const toutes = new Set([...CLES_DEMANDEES, ...posees])
  assert.ok(toutes.size >= 12, `${toutes.size} clés seulement : le rendu n a pas été exercé`)
})

test('aucun hexa dans le module : les couleurs viennent des jetons', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'logements-liste.js'), 'utf8')
  const hexas = source.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  assert.deepEqual(hexas, [], 'la charte §7 : aucun hexa, jetons de theme.css seulement')
})

test('les trois langues portent les 25 clés du lot', () => {
  const fr = Object.keys(FR).filter(k => k.startsWith('logements.'))
  assert.ok(fr.length >= 25, `${fr.length} clés logements.* en français`)
  for (const code of ['en', 'es']) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', `${code}.json`), 'utf8'))
    const manquantes = fr.filter(k => !(k in d))
    assert.deepEqual(manquantes, [], `${code} : clés manquantes`)
    // Et aucune n est restée en français par copie.
    const identiques = fr.filter(k => d[k] === FR[k] && !/^\{/.test(String(FR[k])) && String(FR[k]).length > 12)
    assert.deepEqual(identiques, [], `${code} : traductions restées en français`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. La page elle-même
// ═══════════════════════════════════════════════════════════════════════════

test('la page masque « Ajouter un logement » PAR DÉFAUT, et le serveur garde le geste', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'logements.html'), 'utf8')
  // ⚠ `hidden` DANS LE HTML, pas seulement posé en JS : entre le chargement et
  // l exécution du module, un membre délégué verrait le bouton apparaître.
  const bouton = page.match(/<a[^>]*data-bind="ajouter"[^>]*>/)
  assert.ok(bouton, 'le bouton d ajout doit exister')
  assert.match(bouton[0], /\bhidden\b/, 'il doit être masqué dès le HTML servi')
  // Le masquage n est qu un confort : la garde serveur est la protection.
  assert.match(page, /estTitulaire\(\)/)
  const garde = fs.readFileSync(path.join(__dirname, '..', 'api', 'channel-property.js'), 'utf8')
  assert.match(garde, /estTitulaireDuCompte/, 'la garde serveur de la création doit être en place')
})

test('la page ne charge AUCUN script tiers et n appelle aucun partenaire', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'logements.html'), 'utf8')
  const externes = [...page.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map(m => m[1])
  assert.deepEqual(externes, [])
  assert.ok(!/channex|beds24/i.test(page), 'aucun nom de partenaire dans la page (spec §6)')
})

test('la page sert /logements, et l ancienne liste reste intacte', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'))
  const rewrites = vercel.rewrites || []
  assert.ok(rewrites.some(r => r.source === '/logements' && r.destination === '/pages/logements'),
    'le rewrite doit exister, SANS .html (cleanUrls)')
  // ⚠ `/biens` N EST PAS TOUCHÉ à l étape 1 : Thierry doit pouvoir comparer les
  // deux écrans en recette. La redirection est l étape 4.
  assert.ok(rewrites.some(r => r.source === '/biens' && r.destination === '/pages/biens'))
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'pages', 'biens.html')))
})
