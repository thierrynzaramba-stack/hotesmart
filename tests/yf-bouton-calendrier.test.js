// tests/yf-bouton-calendrier.test.js
// L'ACCES YIELDFLOW DEPUIS LE CALENDRIER V5 — le bouton et son menu.
// Spec : docs/specs/spec-yf-bouton-calendrier.md §3, §4 et §6 bis.
//
// ⚠ CE FICHIER EXECUTE LA PAGE, IL NE LA GREPE PAS. Il monte le banc
// (tests/outils/banc-calendrier.js), qui evalue le VRAI module de
// pages/calendrier.html dans un vrai DOM : un test qui cherche une chaine dans
// le source dit que le code CONTIENT quelque chose, pas qu'il le FAIT.
//
// ⚠ LE DEFAUT QU'IL EMPECHE, ET C'EST LE PLUS COUTEUX DU LOT : que le menu
// parte compter au CHARGEMENT du calendrier. L'exception datee du 28 octobre
// 2026 a la regle « donnee non urgente = resume pre-calcule » ne tient QUE
// parce que le comptage suit un geste. Un `/api/yield-menu` qui partirait avec
// la page, pour chaque bien, serait exactement le defaut mesure le 22 octobre
// 2026 sur l'accueil — `/api/yield` deux fois par bien, 72 requetes, 586 Ko.
// Deux tests le gardent : « aucun appel au chargement » et « un seul appel,
// pour le seul bien clique ».

const test = require('node:test')
const assert = require('node:assert/strict')
const { monter, peupler, geste, FR } = require('./outils/banc-calendrier')

const PILOTE = {
  id: '11111111-1111-4111-8111-111111111111', name: 'La bulle', provider: 'channex',
  provider_property_id: '209413', capacity: 2, base_price: 120, currency: 'EUR',
  included_guests: 2, extra_guest_fee: 0, pilote_tarifaire: 'yieldflow'
}
const MANUEL = {
  id: '22222222-2222-4222-8222-222222222222', name: 'Ofuro Futari', provider: 'channex',
  provider_property_id: '209414', capacity: 4, base_price: 95, currency: 'EUR',
  included_guests: 2, extra_guest_fee: 10, pilote_tarifaire: 'calendrier'
}
const BEDS24 = {
  id: '33333333-3333-4333-8333-333333333333', name: 'Studio Beds24', provider: 'beds24',
  provider_property_id: '77', capacity: 2, base_price: 80, currency: 'EUR',
  included_guests: 2, extra_guest_fee: 0, pilote_tarifaire: 'calendrier'
}

// La reponse du menu, telle que `api/yield-menu.js` la rend.
const FAITS = (o = {}) => ({
  bien: PILOTE.id, pilote: 'yieldflow', peut_basculer: true, raison: null,
  fenetre: { type: 'jours', valeur: 120 }, fenetre_fin: '2027-02-25',
  marche: 'Bagnères-de-Bigorre', evenements: 3, comparables: 7,
  prix_ajustes: 12, jours: 7, ...o
})

// Monte le banc et rend les biens donnes. `reponses` : ce que le reseau rend,
// par chemin — le banc observe `fetch`, donc on traverse le vrai `appel()`.
function banc ({ large = true, biens = [PILOTE, MANUEL], faits = FAITS(), ecriture = true } = {}) {
  const b = monter({
    large,
    ecriture,
    appel: async (chemin) => {
      if (chemin.startsWith('/api/yield-menu')) return faits
      return {}
    }
  })
  peupler(b, { biens, jours: 1 })
  return b
}
const boutons = (b) => [...b.doc.querySelectorAll('[data-yf]')]
const menu = (b) => b.doc.querySelector('[data-bind="yf-menu"]')
const appelsMenu = (b) => b.envois.filter(e => e.chemin.startsWith('/api/yield-menu'))
// Le banc rend les DEUX ecrans ; au telephone un seul bien est affiche.
const bouton = (b, bien) => boutons(b).find(x => x.dataset.yf === bien.id)

// ═══════════════════════════════════════════════════════════════════════════
// 1. LE BOUTON
// ═══════════════════════════════════════════════════════════════════════════

for (const large of [true, false]) {
  const ecran = large ? 'ordinateur' : 'telephone'
  test(`LE TEST QUI COMPTE : le bouton est pose sur les DEUX ecrans (${ecran})`, () => {
    // ⚠ UNE SEULE CONSTRUCTION — `identiteBien()` — POUR LES DEUX ECRANS.
    // Une copie par ecran diverge : vecu du 30 septembre 2026, la couleur des
    // reservations corrigee a l'ordinateur et jamais au telephone.
    const b = banc({ large, biens: [PILOTE] })
    assert.equal(boutons(b).length, 1, `aucun bouton YieldFlow au ${ecran}`)
    b.fermer()
  })
}

test('LE TEST QUI COMPTE : deux etats, lus dans pilote_tarifaire', () => {
  const b = banc()
  const on = bouton(b, PILOTE)
  const off = bouton(b, MANUEL)
  assert.ok(on.classList.contains('cal-yf--on'), 'bien pilote : bleu plein')
  assert.ok(!on.classList.contains('cal-yf--off'))
  assert.ok(off.classList.contains('cal-yf--off'), 'pilote calendrier : contour gris')
  assert.ok(!off.classList.contains('cal-yf--on'))
  b.fermer()
})

test("LE TEST QUI COMPTE : l'aria-label est traduit ET porte le nom du bien", () => {
  // Un libelle « YieldFlow » seul, repete par logement, ne dit a personne
  // DUQUEL il parle : c'est la demande de Thierry, et c'est aussi ce qui rend
  // la page utilisable a la voix.
  const b = banc()
  const attenduOn = FR['cal.yf_open_on'].replace('{nom}', PILOTE.name)
  const attenduOff = FR['cal.yf_open_off'].replace('{nom}', MANUEL.name)
  assert.equal(bouton(b, PILOTE).getAttribute('aria-label'), attenduOn)
  assert.equal(bouton(b, MANUEL).getAttribute('aria-label'), attenduOff)
  assert.ok(attenduOn.includes('La bulle') && attenduOn !== FR['cal.yf_open_on'],
    'le nom du bien doit etre substitue, pas laisse en {nom}')
  b.fermer()
})

test('un bien Beds24 ne porte pas le bouton : YieldFlow ne pilote que Channex', () => {
  const b = banc({ biens: [BEDS24, PILOTE] })
  assert.deepEqual(boutons(b).map(x => x.dataset.yf), [PILOTE.id],
    'un bouton qui ouvre un menu sans issue est pire qu une absence')
  b.fermer()
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. RIEN N'EST CALCULE AU CHARGEMENT (l'exception datee ne tient qu'a ca)
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : aucun appel au menu au CHARGEMENT du calendrier', async () => {
  // ⚠ REGLE 19 — CE TEST EST UN NON-REGRESSION, ET IL FAUT LE DIRE : il ne
  // peut PAS rougir contre le code d'avant, ou le menu n'existait pas. Ce
  // qu'il garde n'est pas un etat passe du depot, c'est tout etat FUTUR ou le
  // comptage partirait avec la page. Sa contre-epreuve se fait donc par
  // MUTATION, et elle est faite : brancher `appel('/api/yield-menu…')` dans
  // `brancherYf` le fait rougir.
  //
  // ⚠ ET MA PREMIERE VERSION NE MORDAIT PAS — LA MUTATION L'A PROUVE. Elle
  // lisait `envois` AUSSITOT apres `peupler()`, alors que `appel()` attend
  // d'abord `getSession()` : le `fetch` part une micro-tache plus tard. Le
  // test voyait donc zero appel y compris quand le code en lancait deux, et
  // il aurait ete vert pour toujours sur le seul defaut qu'il existe pour
  // empecher. On laisse la boucle d'evenements tourner avant de compter.
  const b = banc({ biens: [PILOTE, MANUEL] })
  for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0))
  assert.equal(appelsMenu(b).length, 0,
    'le comptage doit suivre un GESTE : au chargement, il serait paye par bien et par ouverture d ecran')
  b.fermer()
})

test('LE TEST QUI COMPTE : un clic = UN appel, pour le SEUL bien clique', async () => {
  const b = banc()
  geste(b, bouton(b, MANUEL), 'click')
  await new Promise(r => setTimeout(r, 0))
  const vus = appelsMenu(b)
  assert.equal(vus.length, 1, 'un seul appel par ouverture')
  assert.ok(vus[0].chemin.includes(encodeURIComponent(MANUEL.id)),
    `l appel doit porter le bien clique : ${vus[0].chemin}`)
  assert.ok(!vus[0].chemin.includes(PILOTE.id), 'aucun autre bien n est compte')
  assert.equal(vus[0].methode, 'GET', 'le menu LIT, il n ecrit pas')
  b.fermer()
})

test("LE TEST QUI COMPTE : ouvrir le menu n'ecrit RIEN — jamais de bascule en un clic", async () => {
  const b = banc()
  geste(b, bouton(b, MANUEL), 'click')
  await new Promise(r => setTimeout(r, 0))
  // ⚠ LA GARDE PORTE SUR LA FORME, PAS SUR UN NOM : tout envoi non-GET, et
  // tout appel aux deux endpoints qui ecrivent. La bascule du pilote reste le
  // parcours d'activation, avec sa confirmation comptee SERVEUR.
  const ecritures = b.envois.filter(e => e.methode !== 'GET')
  assert.deepEqual(ecritures, [], 'le menu a envoye une ecriture')
  for (const interdit of ['/api/yield-pilote', '/api/calendar', '/api/yield-grille']) {
    assert.ok(!b.envois.some(e => e.chemin.startsWith(interdit)),
      `le menu joint ${interdit} : la bascule ne part jamais du calendrier`)
  }
  b.fermer()
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. LE MENU
// ═══════════════════════════════════════════════════════════════════════════

// `clavier: true` = un clic sans geste de pointeur (`detail === 0`), ce que le
// navigateur envoie sur Entree ou Espace. C'est ce qui decide si le menu
// deplace le focus.
async function ouvrir (b, bien, { clavier = false } = {}) {
  geste(b, bouton(b, bien), 'click', clavier ? { detail: 0 } : {})
  await new Promise(r => setTimeout(r, 0))
  return menu(b)
}

test('les quatre entrees, dans l ordre, vers les pages EXISTANTES du bien', async () => {
  const b = banc()
  const m = await ouvrir(b, PILOTE)
  const liens = [...m.querySelectorAll('.cal-yf-menu__entree')]
  assert.deepEqual(liens.map(a => a.querySelector('span').textContent), [
    FR['cal.yf_prediction'], FR['cal.yf_market'], FR['cal.yf_events'], FR['cal.yf_comparables']
  ], 'l ordre des entrees est une demande de Thierry')
  const href = liens.map(a => a.getAttribute('href'))
  // ⚠ « Evenements » VISE `prix?evenements=1` ET C'EST VOULU :
  // `apps/yield/evenements.html` est une REDIRECTION vers cette URL depuis le
  // 22 septembre 2026 — l'ecran Evenements est une pop-up DANS la Prediction
  // de prix. Et « Donnees marche » vise `marche-global`, la seule des trois
  // pages marche qui soit au menu.
  assert.ok(href[0].startsWith('/apps/yield/prix?'), href[0])
  assert.ok(href[1].startsWith('/apps/yield/marche-global?'), href[1])
  assert.ok(href[2].startsWith('/apps/yield/prix?') && href[2].includes('evenements=1'), href[2])
  assert.ok(href[3].startsWith('/apps/yield/comparables?'), href[3])
  for (const h of href) {
    assert.ok(h.includes('bien=' + PILOTE.id),
      `chaque entree ouvre la page DU BIEN : ${h}`)
  }
  b.fermer()
})

test('LE TEST QUI COMPTE : la ligne ambre est un FAIT — masquee a 0 et masquee si illisible', async () => {
  // ⚠ « 0 » N'EST PAS « JE NE SAIS PAS ». Un 0 de remplacement transforme une
  // absence en fait, et l'ecran l'affiche avec l'aplomb des vrais chiffres.
  // Les deux cas se taisent, et AUCUN n'ecrit « 0 prix ajuste ».
  const avec = banc({ faits: FAITS({ prix_ajustes: 12 }) })
  let m = await ouvrir(avec, PILOTE)
  const ligne = m.querySelector('.cal-yf-menu__ajuste')
  assert.ok(ligne, 'la ligne ambre manque alors que 12 prix ont ete ajustes')
  // ⚠ LE TEXTE QUE L'HOTE LIT, PAS LA CLE NI LA CHAINE ICU. Comparer a
  // `FR['cal.yf_adjusted']` compare la chaine a elle-meme : vert meme si le
  // pluriel ne s'applique pas. Ici on exige le francais rendu.
  assert.equal(ligne.textContent.trim(), '12 prix ajustés cette semaine')
  avec.fermer()

  // ⚠ ET LE SINGULIER, parce que « 1 prix ajusté(s) » est exactement ce que
  // Thierry a refuse le 28 octobre 2026. Le dictionnaire porte un pluriel
  // ICU ; ce test est ce qui empeche qu'on le remplace par un « (s) ».
  const un = banc({ faits: FAITS({ prix_ajustes: 1 }) })
  const mUn = await ouvrir(un, PILOTE)
  assert.equal(mUn.querySelector('.cal-yf-menu__ajuste').textContent.trim(),
    '1 prix ajusté cette semaine')
  assert.ok(!/\(s\)/.test(mUn.textContent), 'aucun « (s) » dans le menu')
  un.fermer()

  for (const [quoi, n] of [['zero', 0], ['illisible', null]]) {
    const b = banc({ faits: FAITS({ prix_ajustes: n }) })
    m = await ouvrir(b, PILOTE)
    assert.equal(m.querySelector('.cal-yf-menu__ajuste'), null,
      `la ligne ambre s affiche alors que le compte est ${quoi}`)
    assert.ok(!/\b0\b/.test(m.textContent), 'un « 0 » est ecrit la ou il n y a rien a dire')
    b.fermer()
  }
})

test("la ligne ambre n'existe pas sur un bien non pilote", async () => {
  const b = banc({ faits: FAITS({ pilote: 'calendrier', prix_ajustes: 9 }) })
  const m = await ouvrir(b, MANUEL)
  assert.equal(m.querySelector('.cal-yf-menu__ajuste'), null,
    'un bien en prix manuels n a pas de prix ajustes par le moteur')
  b.fermer()
})

test('les reperes s affichent quand ils sont servis, et SE TAISENT sinon', async () => {
  const avec = banc()
  let m = await ouvrir(avec, PILOTE)
  let reperes = [...m.querySelectorAll('.cal-yf-menu__repere')].map(e => e.textContent)
  assert.deepEqual(reperes, ['120 jours', 'Bagnères-de-Bigorre', '3 à venir', '7 retenus'])
  avec.fermer()

  // ⚠ ZERO COMPARABLE DIT « A CHOISIR », PAS « 0 RETENUS » (demande de
  // Thierry, 28 octobre 2026) : un zero mesure appelle un geste, il n'annonce
  // pas un echec. Et il reste DISTINCT de l'illisible, qui n'affiche rien.
  const zero = banc({ faits: FAITS({ comparables: 0 }) })
  m = await ouvrir(zero, PILOTE)
  const r0 = [...m.querySelectorAll('.cal-yf-menu__repere')].map(e => e.textContent)
  assert.ok(r0.includes('À choisir'), `repere a zero : ${JSON.stringify(r0)}`)
  assert.ok(!r0.some(x => /^0\b/.test(x)), 'un « 0 » brut est affiche')
  zero.fermer()

  // Tout illisible : les quatre entrees restent CLIQUABLES, et aucun repere
  // n'est invente. Une panne de confort ne ferme pas le menu.
  const sans = banc({ faits: FAITS({ fenetre: null, marche: null, evenements: null, comparables: null }) })
  m = await ouvrir(sans, PILOTE)
  assert.equal(m.querySelectorAll('.cal-yf-menu__repere').length, 0, 'un repere a ete invente')
  assert.equal(m.querySelectorAll('.cal-yf-menu__entree').length, 4, 'les entrees doivent rester')
  sans.fermer()
})

test('LE TEST QUI COMPTE : une panne du menu ne ferme pas le menu', async () => {
  // Les quatre entrees menent a des pages qui savent se charger seules : se
  // taire sur les reperes est tout ce qu'on doit perdre.
  const b = monter({ appel: async () => ({ __statut: 503, __corps: { error: 'illisible' } }) })
  peupler(b, { biens: [PILOTE], jours: 1 })
  const m = await ouvrir(b, PILOTE)
  assert.equal(m.hidden, false, 'le menu s est ferme sur une panne de reperes')
  assert.equal(m.querySelectorAll('.cal-yf-menu__entree').length, 4)
  assert.equal(m.querySelectorAll('.cal-yf-menu__repere').length, 0)
  b.fermer()
})

test('le pied : « Reglages » sur un bien pilote, « Activer » sinon — et jamais une bascule', async () => {
  const pilote = banc()
  let m = await ouvrir(pilote, PILOTE)
  let pied = m.querySelector('.cal-yf-menu__pied')
  assert.ok(pied, 'le pied manque')
  assert.equal(pied.textContent.trim(), FR['cal.yf_settings'])
  assert.ok(pied.querySelector('a').getAttribute('href').includes('bien=' + PILOTE.id))
  assert.ok(!pied.querySelector('a').getAttribute('href').includes('activer=1'))
  pilote.fermer()

  const manuel = banc({ faits: FAITS({ pilote: 'calendrier' }) })
  m = await ouvrir(manuel, MANUEL)
  pied = m.querySelector('.cal-yf-menu__pied')
  assert.equal(pied.textContent.trim(), FR['cal.yf_activate'])
  const href = pied.querySelector('a').getAttribute('href')
  assert.ok(href.includes('activer=1') && href.includes('bien=' + MANUEL.id), href)
  // ⚠ C'EST UN LIEN, PAS UN BOUTON D'ECRITURE : il OUVRE le parcours
  // d'activation existant, avec sa confirmation comptee serveur.
  assert.equal(pied.querySelector('button'), null, 'le pied ne porte aucun bouton d action')
  manuel.fermer()
})

test("sans le droit « reglages » en ecriture, le pied n'est pas propose", async () => {
  // ⚠ ET CE MASQUAGE NE PROTEGE RIEN : c'est la garde SERVEUR de
  // `/api/yield-pilote` (reglages write) qui refuse la bascule. Le menu ne
  // fait qu'ouvrir une page — le masquage evite de proposer un geste qui
  // finirait en refus, il ne tient aucun droit.
  const b = banc({ ecriture: false })
  const m = await ouvrir(b, PILOTE)
  assert.equal(m.querySelector('.cal-yf-menu__pied'), null)
  assert.equal(m.querySelectorAll('.cal-yf-menu__entree').length, 4,
    'les quatre entrees de LECTURE restent : elles ne demandent aucun droit d ecriture')
  assert.ok(b.domaines.includes('reglages'),
    'le pied doit interroger le domaine « reglages », pas « reservations »')
  b.fermer()
})

test('la pastille d etat dit le mode, et le menu nomme le bien', async () => {
  const on = banc()
  let m = await ouvrir(on, PILOTE)
  assert.equal(m.querySelector('.cal-yf-menu__pastille').textContent, FR['cal.yf_state_on'])
  assert.equal(m.querySelector('.cal-yf-menu__bien').textContent, PILOTE.name)
  on.fermer()
  const off = banc({ faits: FAITS({ pilote: 'calendrier' }) })
  m = await ouvrir(off, MANUEL)
  assert.equal(m.querySelector('.cal-yf-menu__pastille').textContent, FR['cal.yf_state_off'])
  assert.equal(m.querySelector('.cal-yf-menu__bien').textContent, MANUEL.name)
  off.fermer()
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. OUVERTURE ET FERMETURE
// ═══════════════════════════════════════════════════════════════════════════

test('un second clic sur le meme bouton referme le menu', async () => {
  const b = banc()
  await ouvrir(b, PILOTE)
  assert.equal(menu(b).hidden, false)
  await ouvrir(b, PILOTE)
  assert.equal(menu(b).hidden, true, 'le menu doit se refermer')
  assert.equal(bouton(b, PILOTE).getAttribute('aria-expanded'), 'false')
  b.fermer()
})

test('la touche d echappement ferme, et un seul menu est ouvert a la fois', async () => {
  const b = banc()
  await ouvrir(b, PILOTE)
  assert.equal(bouton(b, PILOTE).getAttribute('aria-expanded'), 'true')
  await ouvrir(b, MANUEL)
  assert.equal(bouton(b, PILOTE).getAttribute('aria-expanded'), 'false',
    'le bouton du bien precedent reste annonce ouvert')
  assert.equal(bouton(b, MANUEL).getAttribute('aria-expanded'), 'true')
  b.doc.dispatchEvent(new b.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(menu(b).hidden, true)
  assert.equal(bouton(b, MANUEL).getAttribute('aria-expanded'), 'false')
  b.fermer()
})

test("LE TEST QUI COMPTE : on ne propose pas une activation qu'on ne peut pas tenir", async () => {
  // ⚠ RECETTE DE THIERRY DU 28 OCTOBRE 2026, POINT 6, SUR STAGING. Il clique
  // « Activer le pilote automatique » sur « Maison Jardin » : la page s'ouvre
  // sur le bon bien, et RIEN ne se passe — ni parcours, ni confirmation.
  //
  // Mesure du jour sur staging : ce bien est en `rate_sync_mode = 'keep'`
  // (« Je garde mes prix »), donc `peut_basculer = false`, code
  // `pilote_refuse_keep`. Ce n'etait PAS l'absence de grille, et ce n'etait
  // pas un bug du parcours : le refus est JUSTE — YieldFlow proposerait des
  // prix que rien ne pousse aux plateformes.
  //
  // Le defaut est en amont : le menu PROMETTAIT un geste impossible. Un bouton
  // qui ne fait rien au clic est le pire des deux mondes — l'hote ne sait ni
  // que c'est refuse, ni pourquoi, ni quoi faire.
  const RAISON = 'Ce logement est réglé sur « Je garde mes prix » : activez d’abord l’envoi des prix.'
  const refuse = banc({ biens: [MANUEL], faits: FAITS({ pilote: 'calendrier', peut_basculer: false, raison: RAISON }) })
  const m = await ouvrir(refuse, MANUEL)
  const pied = m.querySelector('.cal-yf-menu__pied')
  assert.ok(pied, 'le pied doit exister pour porter la raison')
  assert.equal(pied.querySelector('.cal-yf-menu__activer'), null,
    'aucun bouton d activation sur un bien qui ne peut pas basculer')
  assert.equal(pied.textContent.trim(), RAISON,
    'la raison de la regle doit etre AFFICHEE, pas remplacee par un texte a nous')
  // Et les quatre entrees de lecture restent : elles, rien ne les empeche.
  assert.equal(m.querySelectorAll('.cal-yf-menu__entree').length, 4)
  refuse.fermer()

  // Le bien basculable, lui, garde son bouton.
  const ok = banc({ biens: [MANUEL], faits: FAITS({ pilote: 'calendrier', peut_basculer: true }) })
  const mo = await ouvrir(ok, MANUEL)
  assert.ok(mo.querySelector('.cal-yf-menu__activer'), 'un bien basculable garde son bouton')
  assert.equal(mo.querySelector('.cal-yf-menu__refus'), null)
  ok.fermer()
})

test("tant qu'on ne SAIT pas, on ne promet rien : aucun bouton au premier rendu", async () => {
  // ⚠ LE CLIGNOTEMENT EST UNE PROMESSE AUSSI. Le menu s'ouvre avant la
  // reponse ; afficher le bouton d'activation puis le retirer ferait voir a
  // l'hote un geste qui lui est ensuite repris. Sur un bien NON pilote, le
  // pied attend de savoir.
  let resoudre
  const b = monter({ appel: () => new Promise(r => { resoudre = r }) })
  peupler(b, { biens: [MANUEL], jours: 1 })
  geste(b, bouton(b, MANUEL), 'click')
  await new Promise(r => setTimeout(r, 0))
  assert.equal(menu(b).hidden, false, 'le menu doit s ouvrir tout de suite')
  assert.equal(menu(b).querySelector('.cal-yf-menu__activer'), null,
    'le bouton d activation ne doit pas apparaitre avant qu on sache s il est possible')
  assert.ok(menu(b).querySelector('.cal-yf-menu__attente'), 'la ligne d attente doit etre la')
  // La reponse arrive : le bouton apparait, une seule fois.
  resoudre(FAITS({ pilote: 'calendrier', peut_basculer: true }))
  await new Promise(r => setTimeout(r, 0))
  assert.ok(menu(b).querySelector('.cal-yf-menu__activer'))
  b.fermer()
})

test("LE TEST QUI COMPTE : l'etat vient de la REPONSE, pas de la page chargee il y a une heure", async () => {
  // ⚠ CONSTAT DE LA RE-REVIEW DU 28 OCTOBRE 2026. `bien.pilote_tarifaire` date
  // du CHARGEMENT du calendrier. L'hote active le pilote dans un autre onglet,
  // revient sur le calendrier reste ouvert, clique le bouton : le menu
  // annoncait « Prix manuels » et proposait « Activer le pilote automatique »
  // sur un bien DEJA pilote — et ce clic ne menait nulle part, puisque la page
  // d'arrivee refuse d'ouvrir un parcours sur un bien pilote. Un cul-de-sac,
  // alors que la valeur fraiche etait dans la reponse qu'on venait de lire.
  const b = banc({ biens: [MANUEL], faits: FAITS({ pilote: 'yieldflow', prix_ajustes: 4 }) })
  const m = await ouvrir(b, MANUEL)
  assert.equal(m.querySelector('.cal-yf-menu__pastille').textContent, FR['cal.yf_state_on'],
    'la pastille doit suivre la reponse du serveur')
  assert.ok(m.querySelector('.cal-yf-menu__ajuste'),
    'la ligne ambre existe des que le serveur dit que le bien est pilote')
  assert.equal(m.querySelector('.cal-yf-menu__pied').textContent.trim(), FR['cal.yf_settings'],
    'le pied ne doit plus proposer d activer un bien deja pilote')
  assert.ok(!m.querySelector('.cal-yf-menu__pied a').getAttribute('href').includes('activer=1'),
    'le lien menerait a un parcours que la page d arrivee refuserait d ouvrir')
  b.fermer()

  // Et l'inverse : le serveur dit « calendrier » sur un bien que la page
  // croyait pilote.
  const inverse = banc({ biens: [PILOTE], faits: FAITS({ pilote: 'calendrier', prix_ajustes: 9 }) })
  const mi = await ouvrir(inverse, PILOTE)
  assert.equal(mi.querySelector('.cal-yf-menu__pastille').textContent, FR['cal.yf_state_off'])
  assert.equal(mi.querySelector('.cal-yf-menu__ajuste'), null,
    'aucun prix ajuste a annoncer sur un bien que le serveur dit en prix manuels')
  inverse.fermer()
})

test("LE TEST QUI COMPTE : le focus survit a l'arrivee des reperes", async () => {
  // ⚠ CONSTAT DE LA RE-REVIEW DU 28 OCTOBRE 2026. Le menu s'ouvre tout de
  // suite et focalise sa premiere entree ; les reperes arrivent cent
  // millisecondes plus tard et REMPLACENT le contenu. Le noeud focalise est
  // detruit, le focus retombe sur `body` : l'hote au clavier voit sa
  // tabulation repartir du haut du document, menu ouvert, fleches inertes.
  const b = banc()
  const m = await ouvrir(b, PILOTE, { clavier: true })
  assert.ok(m.contains(b.doc.activeElement),
    'apres l arrivee des reperes, le focus doit etre reste DANS le menu')
  assert.ok(b.doc.activeElement.classList.contains('cal-yf-menu__entree'),
    `le focus est sur ${b.doc.activeElement.tagName}.${b.doc.activeElement.className}`)
  b.fermer()

  // ⚠ ET AU DOIGT, ON NE DEPLACE RIEN. `focus()` peindrait un anneau que
  // l'hote n'a pas demande — vu sur l'apercu du 28 octobre 2026, un cadre noir
  // sur la premiere entree au telephone.
  const tactile = banc()
  const mt = await ouvrir(tactile, PILOTE)
  assert.ok(!mt.contains(tactile.doc.activeElement),
    'un menu ouvert au doigt ne doit pas prendre le focus')
  tactile.fermer()
})

test('la fenetre au singulier dit « 1 jour », jamais « 1 jours »', async () => {
  // ⚠ CONSTAT DE LA RE-REVIEW : ces deux cles etaient restees en
  // substitution simple quand les trois autres passaient au pluriel ICU. Et
  // une fenetre d'UN jour est atteignable — le formulaire d'activation offre
  // un `min="1"`. En espagnol, « 1 meses » pour une fenetre d'un mois.
  for (const [fenetre, attendu] of [
    [{ type: 'jours', valeur: 1 }, '1 jour'],
    [{ type: 'jours', valeur: 120 }, '120 jours'],
    [{ type: 'mois', valeur: 1 }, '1 mois'],
    [{ type: 'mois', valeur: 6 }, '6 mois']
  ]) {
    const b = banc({ faits: FAITS({ fenetre }) })
    const m = await ouvrir(b, PILOTE)
    const r = m.querySelector('.cal-yf-menu__repere').textContent
    assert.equal(r, attendu, `fenetre ${fenetre.valeur} ${fenetre.type}`)
    b.fermer()
  }
})

test('LE TEST QUI COMPTE : le focus ne revient au bouton que sur une fermeture DEMANDEE', async () => {
  // ⚠ CONSTAT DE LA REVIEW DU 28 OCTOBRE 2026. Reprendre le focus a CHAQUE
  // chemin de fermeture faisait deux degats, tous deux invisibles au
  // developpeur et bien visibles chez l'hote :
  //   · il ouvre le menu, puis clique une case de prix pour taper un montant.
  //     La case est `tabIndex = 0` et sa saisie vit dans un `keydown` : le clic
  //     dehors fermait le menu ET ramenait le focus sur le bouton, donc le
  //     chiffre tombait sur le bouton. Aucun prix saisi, rien pour dire
  //     pourquoi.
  //   · un defilement ferme le menu : `focus()` ramenait le bandeau du bien
  //     dans la vue, donc DEFAISAIT le defilement.
  const b = banc()
  const btn = bouton(b, PILOTE)

  // 1. Clic DEHORS : le menu se ferme, et le focus NE revient PAS au bouton.
  await ouvrir(b, PILOTE)
  const cible = b.doc.querySelector('[data-bind="grilles"]') || b.doc.body
  cible.dispatchEvent(new b.window.MouseEvent('click', { bubbles: true, view: b.window }))
  assert.equal(menu(b).hidden, true, 'un clic dehors doit fermer le menu')
  assert.notEqual(b.doc.activeElement, btn,
    'le focus est revenu au bouton apres un clic ailleurs : la frappe suivante y tombera')

  // 2. DEFILEMENT : meme regle.
  await ouvrir(b, PILOTE)
  b.window.dispatchEvent(new b.window.Event('scroll'))
  assert.equal(menu(b).hidden, true, 'un defilement doit fermer le menu')
  assert.notEqual(b.doc.activeElement, btn,
    'le focus est revenu au bouton apres un defilement : il defait le geste de l hote')

  // 3. ECHAPPEMENT : fermeture DEMANDEE, le focus revient — c'est ce qu'on
  //    attend quand la main est au clavier.
  await ouvrir(b, PILOTE, { clavier: true })
  b.doc.dispatchEvent(new b.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(menu(b).hidden, true)
  assert.equal(b.doc.activeElement, btn,
    'apres Echappement, le focus doit revenir au bouton qui a ouvert le menu')

  // 4. SECOND CLIC sur le meme bouton : fermeture demandee aussi.
  await ouvrir(b, PILOTE)
  b.doc.body.focus()
  await ouvrir(b, PILOTE)
  assert.equal(menu(b).hidden, true)
  assert.equal(b.doc.activeElement, btn, 'un second clic sur le bouton lui rend le focus')
  b.fermer()
})

test('le voile n existe qu au telephone', async () => {
  const grand = banc({ large: true })
  await ouvrir(grand, PILOTE)
  assert.equal(grand.doc.querySelector('[data-bind="yf-voile"]').hidden, true,
    'pas de voile a l ordinateur : le popover se ferme au clic dehors')
  grand.fermer()
  const petit = banc({ large: false, biens: [PILOTE] })
  await ouvrir(petit, PILOTE)
  assert.equal(petit.doc.querySelector('[data-bind="yf-voile"]').hidden, false,
    'le volet du bas doit poser son voile')
  petit.fermer()
})
