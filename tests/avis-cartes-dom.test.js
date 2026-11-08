// tests/avis-cartes-dom.test.js — la page /avis en cartes (core/avis/cartes.js),
// en jsdom. Recette de Thierry du 7 octobre 2026 : carte unique, classement
// proprete SANS libelle en double, avis masque dit comme tel, origine de notre
// avis, trois sections dont les anciens charges a l'ouverture.
//
// ⚠ REFONTE V5 DU 8 NOVEMBRE 2026 (docs/specs/avis-v5) : la section « En
// attente de notation » est devenue la bulle « À traiter », qui recoit aussi
// les avis DETECTES dans un message. Les classes ont change (`avp-*`) ; chaque
// assertion de la recette du 7 octobre est gardee, sur le nouveau rendu.

const test = require('node:test')
const assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')

let rendre, rendreStats, monter
test.before(async () => { ({ rendre, rendreStats, monter } = await import('../core/avis/cartes.js')) })

const carte = (extra = {}) => ({
  cle: 'sejour:u1', section: 'recents', bien: 'La bulle', bien_ref: '209413', plateforme: { cle: 'airbnb' },
  voyageur: { prenom: 'Angela', nom: 'X' }, arrivee: '2026-10-01', depart: '2026-10-03', menage_par: 'Regina',
  avis: [{ id: 'a1', masque: false, note_sur_5: 5, texte: 'Parfait', extrait: null, verdict: 'positif', verdict_source: null, analyse: true, detecte: false }],
  evaluation: { booking_uid: 'u1', status: 'publiee', etat: 'publiee', echeance: null, jours_restants: null, publie_le: '2026-10-04T10:00:00Z', texte: 'Merci Angela', origine: { cle: 'ia_valide', libelle: 'rédigé par l’IA, validé par vous' }, evaluable: false },
  ...extra,
})
const donnees = (cartes, extra = {}) => ({ cartes: { attente: [], recents: [], anciens: null, ...cartes }, anciens_total: 0, ...extra })
const doc = (html) => new JSDOM(`<!doctype html><body><div id="c">${html}</div></body>`).window.document
const enAttente = (extra = {}) => carte({
  section: 'attente', avis: [{ id: 'm', masque: true }],
  evaluation: { booking_uid: 'u1', status: 'a_remplir', etat: 'a_remplir', jours_restants: 2, evaluable: true, origine: null, texte: null },
  ...extra,
})

test('LE TEST QUI COMPTE (point A) : la carte dit le sejour en tete, puis « Son avis » et « Notre avis »', () => {
  const d = doc(rendre(donnees({ recents: [carte()] }), { peutEcrire: false }))
  const li = d.querySelector('.avp-carte')
  assert.equal(li.querySelector('.avp-qui').textContent, 'Angela X')
  // Le canal : la pastille dit son nom aux lecteurs d'ecran et au survol.
  assert.equal(li.querySelector('.avp-canal--airbnb .sr-only').textContent, 'Airbnb')
  assert.equal(li.querySelector('.avp-canal--airbnb').getAttribute('title'), 'Airbnb')
  assert.match(li.querySelector('.avp-infos').textContent, /La bulle · du 1 oct\. au 3 oct\. 2026 · ménage : Regina/)
  assert.ok(li.querySelector('.avp-son'), 'le bloc « son avis »')
  assert.equal(li.querySelector('.avp-son .sr-only').textContent, 'Son avis')
  assert.equal(li.querySelector('.avp-notre .avp-lib').textContent, 'Notre avis')
  // ⚠ SUR 5, et jamais « /10 » (decision de Thierry du 20 octobre 2026).
  assert.match(li.textContent, /5,0 \/ 5/)
  assert.doesNotMatch(li.textContent, /\/10/)
  assert.match(li.textContent, /« Merci Angela »/)
})

test('LE TEST QUI COMPTE (point A) : le classement proprete n apparait QU UNE FOIS — le menu au droit d ecriture, le badge sinon', () => {
  const ecrit = doc(rendre(donnees({ recents: [carte()] }), { peutEcrire: true }))
  assert.equal(ecrit.querySelectorAll('select[data-requalif]').length, 1)
  assert.equal(ecrit.querySelectorAll('span.avp-prop').length, 0, 'pas de badge a cote du menu')
  assert.equal((ecrit.querySelector('.avp-carte').textContent.match(/Propreté saluée/g) || []).length, 1, 'le libelle une seule fois (l option choisie)')
  const lit = doc(rendre(donnees({ recents: [carte()] }), { peutEcrire: false }))
  assert.equal(lit.querySelectorAll('select[data-requalif]').length, 0)
  assert.equal(lit.querySelectorAll('span.avp-prop').length, 1)
  // Le statut ne passe jamais par la couleur seule : le badge porte une icone ET un mot.
  assert.ok(lit.querySelector('span.avp-prop--positif use[href$="#i-thumb-up"]'))
})

test('un avis pas encore analyse dit « Analyse en cours », jamais le badge gris « rien a signaler »', () => {
  const d = doc(rendre(donnees({ recents: [carte({ avis: [{ id: 'z', masque: false, texte: 'Super', analyse: false }] })] }), { peutEcrire: true }))
  assert.equal(d.querySelector('.avp-prop--attente').textContent, 'Analyse en cours')
  assert.equal(d.querySelectorAll('select[data-requalif]').length, 0, 'rien a corriger tant que rien n est classe')
})

test('LE TEST QUI COMPTE (point B) : l origine de notre avis est toujours dite', () => {
  const d = doc(rendre(donnees({ recents: [carte()] })))
  assert.equal(d.querySelector('.avp-origine').textContent, 'rédigé par l’IA, validé par vous')
  // Une origine que l'ecran ne connait pas garde le libelle du serveur.
  const inconnue = doc(rendre(donnees({ recents: [carte({ evaluation: { ...carte().evaluation, origine: { cle: 'nouvelle', libelle: 'venue d ailleurs' } } })] })))
  assert.equal(inconnue.querySelector('.avp-origine').textContent, 'venue d ailleurs')
})

test('LE TEST QUI COMPTE (point E) : un avis masque par Airbnb se dit, sans 0/10 — dans « À traiter »', () => {
  const d = doc(rendre(donnees({ attente: [enAttente()] }), { avecBus: true }))
  const ligne = d.querySelector('.avp-atraiter .avp-ligne-atraiter')
  const t = ligne.textContent
  assert.match(t, /Avis déposé, masqué par Airbnb jusqu’à votre évaluation\./)
  assert.doesNotMatch(t, /0 \/ 5|\/10/)
  assert.match(t, /2 jours restants/)
  // ⚠ L'urgence se dit en MOTS, la couleur ne fait que la souligner.
  const dernier = doc(rendre(donnees({ attente: [enAttente({ evaluation: { ...enAttente().evaluation, jours_restants: 1 } })] })))
  assert.match(dernier.querySelector('.avp-delai--urgent').textContent, /^Dernier jour$/)
  assert.equal(d.querySelector('[data-evaluer]').textContent, 'Évaluer Angela')
  // Le compteur de la bulle : une evaluation, et AUCUNE carte en double dans Recents.
  assert.equal(d.querySelector('[data-compte-atraiter]').textContent, '1')
  assert.equal(d.querySelectorAll('.avp-carte').length, 0)
})

test('« À traiter » : l etat de notre avis se dit quand il change le geste (« Remplie par la prestataire »)', () => {
  const d = doc(rendre(donnees({ attente: [enAttente({ evaluation: { ...enAttente().evaluation, status: 'soumise_prestataire', etat: 'soumise_prestataire' } })] }), { avecBus: true }))
  assert.match(d.querySelector('.avp-ligne-atraiter').textContent, /Remplie par la prestataire/)
})

test('« À traiter » recoit les DETECTIONS : citation, boutons au droit d ecriture seulement, et la carte qui n avait qu elles disparait', () => {
  const det = { id: 'd1', masque: false, detecte: true, analyse: true, verdict: 'remarque', texte: 'La douche était sale', extrait: 'douche sale' }
  const seule = carte({ cle: 'avis:d1', evaluation: null, avis: [det], voyageur: { prenom: 'Paul', nom: 'D' } })
  const d = doc(rendre(donnees({ recents: [seule, carte({ cle: 'sejour:u2' })] }), { peutEcrire: true }))
  const ligne = d.querySelector('[data-detection="d1"]')
  assert.ok(ligne, 'la detection est dans « À traiter »')
  assert.match(ligne.textContent, /« douche sale »/)
  assert.match(ligne.textContent, /Détecté dans un message · À confirmer avant d’être compté · La bulle/)
  assert.deepEqual([...ligne.querySelectorAll('[data-valider]')].map(b => b.dataset.statut), ['ignore', 'confirme'])
  assert.equal(d.querySelector('[data-compte-atraiter]').textContent, '1')
  // La carte « avis seul » n'avait que la detection : elle ne reste pas vide dans Recents.
  assert.deepEqual([...d.querySelectorAll('.avp-carte')].map(c => c.dataset.cle), ['sejour:u2'])
  const lu = doc(rendre(donnees({ recents: [seule] }), { peutEcrire: false }))
  assert.equal(lu.querySelectorAll('[data-valider]').length, 0, 'sans droit d ecriture : la detection se lit, sans bouton')
})

test('point C : trois temps ; une evaluation expiree se dit, sans bouton ; rien a faire se dit, sans ambre', () => {
  const exp = carte({ section: 'anciens', evaluation: { booking_uid: 'u1', status: 'a_remplir', etat: 'expiree', evaluable: false, origine: null, texte: null } })
  const d = doc(rendre(donnees({ anciens: [exp] }, { anciens_total: 1 }), { avecBus: true, anciensOuverts: true }))
  assert.deepEqual([...d.querySelectorAll('.avp-h2')].map(h => h.textContent), ['Récents', 'Anciens'])
  assert.equal(d.querySelector('.avp-section__tete .avp-sous').textContent, '20 derniers jours')
  assert.equal(d.querySelector('details[data-anciens] .avp-compte').textContent, '1')
  assert.ok(d.querySelector('details[data-anciens][open]'))
  assert.match(d.querySelector('details .avp-carte').textContent, /Expirée/)
  assert.match(d.querySelector('details .avp-carte').textContent, /Le délai d’évaluation est passé : Airbnb ne l’accepte plus\./)
  assert.equal(d.querySelectorAll('[data-evaluer]').length, 0)
  assert.equal(d.querySelector('.avp-rien').textContent, 'Rien ne vous attend.')
  assert.equal(d.querySelectorAll('.avp-atraiter, .badge--amber').length, 0, 'pas d ambre quand rien n attend')
})

test('les textes de section qui disent un vide ou une borne', () => {
  const vide = doc(rendre(donnees({ anciens: [] }, { anciens_tronques: true, liste_incomplete: true }), { anciensOuverts: true }))
  const t = vide.body.textContent
  assert.match(t, /Aucun séjour ces 20 derniers jours\./)
  assert.match(t, /Aucun séjour plus ancien\./)
  assert.match(t, /Les 500 séjours les plus récents seulement\./)
  assert.match(t, /La liste est incomplète : les séjours les plus anciens ne sont pas tous affichés\./)
  const ferme = doc(rendre(donnees({})))
  assert.match(ferme.querySelector('details[data-anciens]').textContent, /Chargement…/)
  const sansTexte = doc(rendre(donnees({ recents: [carte({ avis: [], evaluation: null })] })))
  assert.match(sansTexte.body.textContent, /Pas encore reçu\./)
  assert.match(sansTexte.body.textContent, /Aucune évaluation du voyageur pour ce séjour\./)
})

test('la vignette du bien : sa photo quand la liste des biens la donne, son initiale sinon', () => {
  const avec = doc(rendre({ ...donnees({ recents: [carte()] }), biens: [{ name: 'La bulle', provider_property_id: '209413', photo_url: 'https://exemple.test/b.jpg' }] }))
  assert.equal(avec.querySelector('.avp-carte img.avp-photo').getAttribute('src'), 'https://exemple.test/b.jpg')
  const sans = doc(rendre(donnees({ recents: [carte({ bien_ref: 'archive-9' })] })))
  assert.equal(sans.querySelector('.avp-carte .avp-photo--vide').textContent, 'L')
})

test('un texte long se replie, « Voir tout » le deplie', async () => {
  const long = 'x'.repeat(260)
  const dom = new JSDOM('<!doctype html><body><div id="c"></div></body>')
  global.window = dom.window
  const c = dom.window.document.getElementById('c')
  await monter(c, { charger: async () => donnees({ recents: [carte({ avis: [{ id: 'l', masque: false, texte: long, analyse: true, verdict: 'positif' }] })] }) })
  const p = c.querySelector('.avp-texte--replie')
  assert.ok(p)
  c.querySelector('[data-plus]').dispatchEvent(new dom.window.Event('click', { bubbles: true }))
  assert.equal(c.querySelectorAll('.avp-texte--replie').length, 0, 'le texte est deplie')
  assert.equal(c.querySelectorAll('[data-plus]').length, 0)
  delete global.window
})

test('XSS : un texte de voyageur ne s execute jamais', () => {
  const d = doc(rendre(donnees({ recents: [carte({ voyageur: { prenom: '<img src=x onerror=alert(1)>', nom: null }, avis: [{ id: 'a', masque: false, texte: '<script>x()</script>', analyse: true }] })] })))
  assert.equal(d.querySelectorAll('img, script').length, 0)
  const photo = doc(rendre({ ...donnees({ recents: [carte()] }), biens: [{ provider_property_id: '209413', photo_url: '" onerror="alert(1)' }] }))
  assert.equal(photo.querySelector('img.avp-photo').getAttribute('onerror'), null)
})

test('les chiffres : sur 5, une decimale a la francaise, et un echec dit comme tel', () => {
  const d = doc(rendreStats({ total: 31, note_sur_5: 4.8, notes: 27, positif: 18, remarque: 2, periode: '30j' }))
  const t = d.body.textContent
  assert.match(t, /4,8/)
  assert.match(t, /sur 5 · 27 notes/)
  assert.match(t, /31avis reçus/)
  assert.match(t, /182propreté saluée · remarques/)
  assert.ok(d.querySelector('.avp-pos use[href$="#i-thumb-up"]') && d.querySelector('.avp-neg use[href$="#i-thumb-down"]'))
  assert.match(doc(rendreStats({ erreur: true })).body.textContent, /Les compteurs n’ont pas pu être calculés\. Rechargez pour réessayer\./)
  assert.match(doc(rendreStats({ total: 0, note_sur_5: null, notes: 0, positif: 0, remarque: 0 })).body.textContent, /—/)
})

test('la traduction de la page passe partout : aucun texte francais quand `t` est fourni', () => {
  const t = (cle, v) => `[${cle}${v && v.n !== undefined ? ':' + v.n : ''}]`
  const html = rendre(donnees({ attente: [enAttente()], recents: [carte()] }, { anciens_total: 2 }), { t, avecBus: true, peutEcrire: true })
  const texte = doc(html).body.textContent
  // Ce qui reste en clair vient des DONNEES (noms, dates, texte des avis), pas de l'ecran.
  for (const mot of ['Récents', 'Anciens', 'Notre avis', 'Propreté saluée', 'Évaluer', 'jours restants', 'Avis déposé', 'ménage']) {
    assert.ok(!texte.includes(mot), `« ${mot} » est ecrit en dur dans le rendu`)
  }
  assert.match(texte, /\[avis\.jours_restants:2\]/)
})

test('monter : UN appel au chargement, les ANCIENS a l ouverture, et une correction de proprete relit la page', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="c"></div><div id="s"></div></body>')
  global.window = dom.window
  const lectures = []
  const gestes = []
  const charger = async (params) => {
    lectures.push(params)
    return donnees({ recents: [carte()], anciens: params.includes('anciens=1') ? [] : null }, { anciens_total: 3, stats: { total: 1, note_sur_5: 4.8, notes: 1, positif: 1, remarque: 0, periode: '30j' } })
  }
  const actions = { requalifier: async (id, v) => { gestes.push(`requalifier ${id} ${v}`) }, valider: async () => {} }
  const c = dom.window.document.getElementById('c')
  await monter(c, { charger, actions, peutEcrire: true, filtres: () => ({ periode: '30j' }), zoneStats: dom.window.document.getElementById('s') })
  assert.deepEqual(lectures, ['periode=30j'])
  // ⚠ SUR 5, et le libelle le dit (decision de Thierry du 20 octobre 2026).
  assert.match(dom.window.document.getElementById('s').textContent, /4,8/)
  assert.match(dom.window.document.getElementById('s').textContent, /sur 5/)
  const details = c.querySelector('details[data-anciens]')
  details.open = true
  details.dispatchEvent(new dom.window.Event('toggle'))
  await new Promise(r => setTimeout(r, 0))
  assert.equal(lectures[1], 'periode=30j&anciens=1')
  const sel = c.querySelector('select[data-requalif]')
  sel.value = 'remarque'
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(gestes, ['requalifier a1 remarque'])
  assert.equal(lectures[2], 'periode=30j&anciens=1', 'relue, anciens toujours ouverts')
  delete global.window
})

test('monter : une detection confirmee part au serveur puis la page se relit ; un echec se dit, jamais une liste vide', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="c"></div></body>')
  global.window = dom.window
  dom.window.alert = () => {}
  const det = carte({ cle: 'avis:d1', evaluation: null, avis: [{ id: 'd1', masque: false, detecte: true, analyse: true, verdict: 'remarque', texte: 'sale' }] })
  let n = 0
  const gestes = []
  const c = dom.window.document.getElementById('c')
  await monter(c, {
    charger: async () => { n++; return donnees({ recents: [det] }) },
    actions: { valider: async (id, statut) => { gestes.push(`${id} ${statut}`) } },
    peutEcrire: true,
  })
  c.querySelector('[data-statut="confirme"]').dispatchEvent(new dom.window.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(gestes, ['d1 confirme'])
  assert.equal(n, 2, 'relue apres le geste')
  const refus = dom.window.document.createElement('div')
  await monter(refus, { charger: async () => { const e = new Error('x'); e.status = 403; throw e } })
  assert.equal(refus.textContent, 'Vous n’avez pas accès aux avis de ce compte.')
  delete global.window
})

test('monter : les donnees du cache se peignent AVANT la lecture, puis la reponse les remplace', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="c"></div></body>')
  global.window = dom.window
  const c = dom.window.document.getElementById('c')
  let vuAvant = null
  await monter(c, {
    initiales: donnees({ recents: [carte({ voyageur: { prenom: 'Cache', nom: null } })] }),
    charger: async () => { vuAvant = c.querySelector('.avp-qui').textContent; return donnees({ recents: [carte()] }) },
  })
  assert.equal(vuAvant, 'Cache')
  assert.equal(c.querySelector('.avp-qui').textContent, 'Angela X')
  delete global.window
})

test('LE TEST QUI COMPTE : plus aucun « /10 » nulle part — ni sur une carte, ni dans le guide', () => {
  // Decision de Thierry du 20 octobre 2026. La tuile disait « note moyenne sur
  // 5 » et chaque carte juste en dessous affichait encore « 9/10 » : un ecran
  // portait DEUX echelles, et le guide en annoncait une troisieme fois la
  // premiere.
  const fs = require('node:fs')
  const path = require('node:path')
  const racine = path.join(__dirname, '..')
  const d = doc(rendre(donnees({ recents: [carte()] }), { peutEcrire: false }))
  assert.doesNotMatch(d.querySelector('.avp-carte').textContent, /\/\s*10\b/)
  assert.match(d.querySelector('.avp-note').textContent, /\/ 5$/)
  // Et dans ce qui s'ecrit a l'ecran, pas seulement dans ce rendu-ci.
  for (const f of ['core/avis/cartes.js', 'pages/guide.html', 'pages/avis.html', 'shared/i18n/fr.json']) {
    const src = fs.readFileSync(path.join(racine, f), 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    assert.doesNotMatch(code, /\d\s*\/\s*10\b|sur 10\b/, `${f} affiche encore une note sur 10`)
  }
})
