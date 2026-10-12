// tests/lecture-seule.test.js
// Vague 2 : aucun bouton d'ecriture visible pour un membre en LECTURE.
//
// ⚠ LE CONSTAT DU TEST HUMAIN. Bascule avec `menages: read`, le bouton
// « ✓ Marquer fait » restait ACTIF dans le planning.
//
// Diagnostic : ce bouton n'ecrit RIEN en base — il ne touche que le
// localStorage. Donc ni faille de perimetre, ni refus serveur : une troisieme
// possibilite que la question n'envisageait pas. Il n'en devait pas moins
// disparaitre, car il donne l'illusion d'une action partagee.
//
// La regle que ces tests figent : sur une page delegable, TOUT declencheur
// d'ecriture est retire quand le droit manque. Pas grise — retire, avec un
// message qui dit pourquoi.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const lire = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

// Chaque page delegable, avec le domaine qui commande ses ecritures.
const PAGES = [
  ['apps/menages/index.html',        'menages'],
  ['pages/calendrier.html',    'reservations'],
  ['pages/biens.html',               'reservations'],
  ['pages/aujourdhui.html',           'reservations']
]

for (const [page, domaine] of PAGES) {
  test(`${page} : garde ses ecritures derriere un droit`, () => {
    const html = lire(page)
    assert.ok(/peutEcrire\s*\(|estTitulaire\s*\(/.test(html),
      `${page} ecrit sans jamais consulter les droits`)
  })
}

test('menages : « Marquer fait » disparait en lecture seule', () => {
  // Le constat exact du test humain.
  const html = lire('apps/menages/index.html')
  const i = html.indexOf("if (!peutEcrire('menages'))")
  assert.ok(i > 0, 'le bloc de lecture seule doit exister')
  const bloc = html.slice(i, i + 700)
  assert.ok(bloc.includes("getElementById('modal-done')"),
    '« Marquer fait » doit etre retire comme le champ de note')
  assert.ok(bloc.includes("getElementById('btn-save-comment')"),
    'le bouton d\'enregistrement de note aussi')
})

test('menages : openModal ne suppose pas le bouton present', () => {
  // ⚠ Retirer un element sans proteger ce qui le lit ensuite casse la page pour
  // le membre — exactement le genre de regression que ce lot doit eviter.
  const html = lire('apps/menages/index.html')
  const i = html.indexOf("const btn = document.getElementById('modal-done')")
  assert.ok(i > 0)
  assert.ok(html.slice(i, i + 160).includes('if (btn)'),
    'le code qui suit doit tolerer un bouton absent')
})

// RETARGE le 13 octobre 2026 : les anciennes pages calendrier redirigent
// vers la V5 (une page, deux ecrans) — memes PROPRIETES, motifs V5.
test('calendrier : ni edition en ligne ni barre d\'action en lecture', () => {
  const html = lire('pages/calendrier.html')
  assert.ok(/mousedown', \(e\) => \{\n      if \(etat\.lectureSeule \|\| !peutEcrire\('reservations'\)\) return/.test(html),
    'la selection (donc l\'edition) refuse avant de demarrer')
  assert.ok(/if \(!jours\.length \|\| etat\.lectureSeule \|\| !peutEcrire\('reservations'\)\) \{ barre\.hidden = true/.test(html),
    'la barre d\'action se masque en lecture')
  assert.ok(html.includes('avis-lecture'), 'et la raison affichee')
})

test('calendrier mobile : la popup d\'edition ne s\'ouvre pas en lecture', () => {
  const html = lire('pages/calendrier.html')
  const i = html.indexOf("c.addEventListener('click'")
  assert.ok(i > 0)
  assert.ok(html.slice(i, i + 300).includes("etat.lectureSeule || !peutEcrire('reservations')"),
    'le tap court refuse avant de proposer une saisie')
  const j = html.indexOf("c.addEventListener('touchstart'")
  assert.ok(html.slice(j, j + 260).includes("etat.lectureSeule || !peutEcrire('reservations')"),
    'l\'appui long aussi')
})

// L'ancienne messagerie est une REDIRECTION depuis l'etape 4 du lot
// Messages V5 : la lecture seule de la nouvelle page est testee dans
// tests/messages-v5.test.js (saisie et boutons RETIRES sans droit).

test('calendrier : la barre flottante n\'est PAS supprimee du DOM', () => {
  // V5 : la barre vit dans le markup STATIQUE et se MASQUE (hidden), jamais
  // retiree ; la selection ne demarre pas en lecture (gardes mousedown et
  // touchstart) ; la CONSULTATION reste ouverte a tous : les fiches se
  // branchent SANS garde d\'ecriture.
  const html = lire('pages/calendrier.html')
  assert.ok(html.includes('data-bind="flottante"'), 'markup statique')
  assert.ok(!/flottante[^\n]*\.remove\(\)/.test(html), 'jamais retiree du DOM')
  assert.ok(/barre\.hidden = true/.test(html), 'masquee par drapeau')
  assert.ok(/\[data-resa\]'\)\.forEach\(b => b\.addEventListener\('click', \(\) => ouvrirFicheResa\(/.test(html),
    'la fiche s\'ouvre meme en lecture seule')
})

test('calendrier : l\'etat lecture seule est pose AVANT tout rendu', () => {
  // Un membre sans lecture sort sur no_access ; un membre en lecture a son
  // drapeau pose avant le premier charger(), et le bandeau le dit.
  const html = lire('pages/calendrier.html')
  const iNoAccess = html.indexOf("cal.no_access")
  const iFlag = html.indexOf("etat.lectureSeule = !peutEcrire('reservations')")
  const iPrefs = html.indexOf('lirePrefs()', iFlag - 2000)
  assert.ok(iNoAccess > 0 && iFlag > 0 && iFlag < html.indexOf('lirePrefs()', iFlag),
    'le drapeau est pose des l init, avant les prefs et tout chargement')
  assert.ok(/avis-lecture"\]'\)\.hidden = !etat\.lectureSeule/.test(html), 'et le bandeau le dit')
})

test('calendrier mobile : les zones de rendu sont STATIQUES, jamais remplacees', () => {
  // L\'ancien mobile remplacait <main> dans l\'etat vide et #grid disparaissait
  // sous #view-select. La V5 ne remplace jamais ses conteneurs : les rendus
  // ecrivent dans des data-bind fixes du markup.
  const html = lire('pages/calendrier.html')
  assert.ok(html.includes('data-bind="grille-mobile"'), 'zone fixe du telephone')
  const module_ = html.split('<script type="module">')[1] || ''
  assert.ok(module_.length > 1000, 'le module de la page est bien la')
  assert.ok(!/main\.innerHTML/.test(module_), 'aucun remplacement de <main>')
})

test('calendrier mobile : un compte 100% Beds24 n\'est pas invite a se reconnecter', () => {
  // Deux messages contradictoires sinon : « gere dans Beds24 » et, dessous,
  // « connectez votre PMS ». V5 : la branche beds24 de l\'etat vide n\'a PAS
  // le CTA onboarding.
  const html = lire('pages/calendrier.html')
  const bloc = html.split("vide.innerHTML = beds.length")[1]
  assert.ok(bloc, 'les deux etats vides sont distingues')
  const brancheBeds = bloc.split(':')[0]
  assert.ok(brancheBeds.includes('cal.empty_beds24'), 'le cas Beds24 a son propre message')
  assert.ok(!brancheBeds.includes('onboarding'), 'aucun appel a reconnecter un PMS deja connecte')
})

// ─── La limite Beds24, rendue explicite ─────────────────────────────────────

test('calendrier : les biens Beds24 sont annonces, pas seulement grises', () => {
  // V5 : le bandeau avis-beds24 nomme les biens (cal.beds24_all / some),
  // visible sans ouvrir quoi que ce soit.
  const html = lire('pages/calendrier.html')
  assert.ok(html.includes('avis-beds24'), 'un emplacement pour l\'annonce')
  assert.ok(html.includes('cal.beds24_all') && html.includes('cal.beds24_some'),
    'le message nomme les biens, 100 % Beds24 compris')
})

test('calendrier mobile : les biens Beds24 sont exclus ET annonces', () => {
  // V5 : seuls les biens pilotables sont selectionnables ; une bulle Beds24
  // est grisee et NON cliquable, et le bandeau explique.
  const html = lire('pages/calendrier.html')
  assert.ok(html.includes("etat.biens.filter(b => b.provider !== 'beds24')"),
    'les biens Beds24 ne sont pas selectionnables')
  assert.ok(/beds24 \? 'disabled' : ''/.test(html), 'bulle grisee non cliquable')
  assert.ok(html.includes('avis-beds24'), 'et leur absence est expliquee')
})
