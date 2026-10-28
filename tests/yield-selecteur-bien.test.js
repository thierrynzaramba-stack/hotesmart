// tests/yield-selecteur-bien.test.js
// LE SELECTEUR DE LOGEMENT DES SIX ECRANS YIELDFLOW.
//
// ⚠ LE DEFAUT QU'IL EMPECHE, CONSTATE EN RECETTE SUR STAGING LE 28 OCTOBRE
// 2026 : sur `/apps/yield`, changer de logement ne changeait PAS la requete.
// `GET /api/yield` partait toujours avec le meme `property_id` — celui du
// premier bien par ordre alphabetique.
//
// ⚠ ET CE N'ETAIT PAS « GENANT », C'ETAIT TOTAL. Le selecteur n'avait aucun
// ecouteur `change`, ET le bouton « Charger » est MASQUE hors de la vue
// Exploration (`appliquerVue`), alors que la vue par defaut est Pilotage. Sur
// l'ecran tel qu'il s'ouvre, il n'existait donc AUCUN moyen de demander un
// autre logement. Un hote a plusieurs biens lisait les chiffres d'un seul,
// en croyant lire ceux qu'il avait choisis.
//
// ⚠ POURQUOI CE TEST PORTE SUR LES SIX ECRANS ET PAS SUR UN SEUL. Mesure du
// jour : cinq des six posaient bien leur ecouteur, `index.html` etait le seul
// a l'oublier. Garder le seul ecran fautif laisserait les cinq autres libres
// de le perdre a leur tour — et le defaut est invisible a la lecture d'un
// diff : il se voit en changeant de logement, sur un compte qui en a
// plusieurs.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')

// ⚠ L'ATTENDU EST NOMME, PAS DEDUIT D'UN BALAYAGE. Un ecran YieldFlow qui
// naitrait sans selecteur passerait inapercu d'une liste calculee ; ici, il
// faudra l'ajouter a la main, donc y penser.
const ECRANS = {
  'apps/yield/index.html': 'yf-bien',
  'apps/yield/prix.html': 'yp-bien',
  'apps/yield/comparables.html': 'cp-bien',
  'apps/yield/marche.html': 'mc-bien',
  'apps/yield/marche-global.html': 'mg-bien',
  'apps/yield/marche-temperature.html': 'mt-bien'
}

test('LE TEST QUI COMPTE : les six ecrans YieldFlow reagissent au changement de logement', () => {
  const sans = []
  for (const [page, id] of Object.entries(ECRANS)) {
    const src = lire(page)
    // Le selecteur existe-t-il bien sous ce nom ? Sinon ce test garde un
    // fantome, et son vert ne veut plus rien dire.
    assert.ok(src.includes(`id="${id}"`), `${page} : le selecteur ${id} est introuvable`)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
    if (!new RegExp(`el\\('${id}'\\)\\.addEventListener\\('change'`).test(code)) sans.push(page)
  }
  assert.deepEqual(sans, [],
    'ces ecrans ne reagissent pas au changement de logement :\n' + sans.join('\n')
    + '\nUn hote y lirait les chiffres d un AUTRE bien que celui qu il a choisi.')
})

test("LE TEST QUI COMPTE : sur la synthese, le bouton « Charger » ne peut pas remplacer l ecouteur", () => {
  // ⚠ C'EST CE QUI RENDAIT LE DEFAUT TOTAL, et c'est ce qu'il faut garder :
  // si quelqu'un retirait l'ecouteur en se disant « il reste le bouton », il
  // rouvrirait exactement le defaut — le bouton n'existe pas dans la vue par
  // defaut.
  const src = lire('apps/yield/index.html')
  assert.match(src, /el\('yf-charger'\)\.hidden = vue !== 'exploration'/,
    'le bouton « Charger » est masque hors de la vue Exploration')
  // Et la vue par defaut n'est pas Exploration.
  assert.match(src, /let vue = 'pilotage'/,
    'la vue par defaut est Pilotage (decision de Thierry) : le bouton y est absent')
  // ⚠ ET IL DECLENCHE PAR LA GARDE PARTAGEE, PAS PAR `charger` NU — cette
  // assertion figeait l'ancienne forme, elle a rougi au correctif du constat
  // C1 (28 octobre 2026). C'est son role : le lot d'origine posait l'appel nu.
  assert.match(src.replace(/^[ \t]*\/\/.*$/gm, ' '), /el\('yf-bien'\)\.addEventListener\('change', chargerSiPossible\)/,
    'donc le changement de logement doit declencher la lecture lui-meme')
})

// ═══════════════════════════════════════════════════════════════════════════
// LA GARDE PARTAGEE DES TROIS GESTES — constat C1 de la review du 28 octobre
// 2026, corrige sur go de Thierry le meme jour.
//
// ⚠ LE DEFAUT : `yf-bien` et `yf-annee` appelaient `charger()` NU, sans les
// deux gardes que `changerVue` applique au meme geste. Consequence mesuree :
// en vue Exploration avec une fenetre trop large, changer de logement partait
// quand meme en requete (400), ecrasait l'avertissement de `verifierEtendue`
// par une erreur technique, et `charger()` remettait `yf-charger.disabled` a
// `false` — alors que `verifierEtendue` ne repasse QUE sur changement de
// date, de detail ou de vue. L'avertissement etait donc desarme DURABLEMENT.
//
// ⚠ ET LE DEFAUT ETAIT ANTERIEUR AU LOT QUI L'A REVELE : `yf-annee` portait
// l'appel nu avant, le selecteur de logement n'a fait qu'ajouter un second
// declencheur. D'ou un test qui garde les DEUX, et pas seulement celui du lot.
//
// ⚠ POURQUOI CE TEST EXECUTE LE CODE AU LIEU DE LE LIRE (regle 13) : une
// assertion sur le texte `chargerSiPossible` resterait verte si la fonction
// perdait une de ses deux gardes. Ici on pose l'etat que `verifierEtendue`
// pose, on declenche le geste, et on compte les requetes REELLEMENT parties.

const os = require('node:os')
const { JSDOM } = require('jsdom')
const { sansCommentaires } = require('./outils/source')

const tick = () => new Promise(r => setTimeout(r, 0))

const REFUS = { ok: false, status: 400, json: async () => ({ error: 'banc de test' }) }
let banc = null
let tmp = null
let envois = []
let retenues = null

test.before(async () => {
  const page = lire('apps/yield/index.html')
  // Le DOM REEL de la page. Les scripts ne sont pas executes par jsdom (pas de
  // `runScripts`) : on veut les elements, pas `init()`.
  const dom = new JSDOM(page)
  const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/^\s*import .*$/gm, '')
    .replace(/^\s*initErrorHandler\(\)\s*$/m, '')
    .replace(/^\s*init\(\)\s*$/m, '')

  global.document = dom.window.document
  global.window = dom.window
  global.compteCourant = () => null
  global.enteteCompte = () => ({})
  // ⚠ LA REPONSE DU BANC EST UN REFUS NET. `charger()` s'arrete alors sur
  // `!r.ok` apres avoir affiche l'erreur : on mesure le DEPART de la requete
  // sans traverser tout le rendu, et sans promesse rejetee en suspens.
  global.fetch = async (url) => {
    envois.push(String(url))
    // ⚠ LE BANC SAIT RETENIR UNE REPONSE EN L'AIR. Sans ca, impossible de
    // mesurer le cas le plus ordinaire de l'ecran : l'hote choisit son
    // logement PENDANT que la lecture d'ouverture est encore en vol.
    if (retenues) return new Promise(r => retenues.push(() => r(REFUS)))
    return REFUS
  }

  tmp = path.join(os.tmpdir(), `yf-garde-${process.pid}.mjs`)
  fs.writeFileSync(tmp, script
    + '\nexport const _garde = typeof chargerSiPossible === "function" ? chargerSiPossible : null\n'
    + 'export function _poserSession (s) { session = s }\n'
    + 'export function _choisirVue (v) { vue = v }\n')
  banc = await import(`file://${tmp}`)
  banc._poserSession({ access_token: 'jeton-de-banc' })
})
test.after(() => { if (tmp) { try { fs.unlinkSync(tmp) } catch {} } })

// L'etat de l'ecran AVANT le geste, pose comme la page le pose vraiment.
function poser ({ bien = 'b-choisi' } = {}) {
  envois = []
  retenues = null
  const sel = document.getElementById('yf-bien')
  sel.innerHTML = bien ? `<option value="${bien}">Un bien</option>` : ''
  sel.value = bien || ''
  document.getElementById('yf-charger').disabled = false
  banc._choisirVue('pilotage')   // la vue par defaut de l'ecran
}

test('LE TEST QUI COMPTE : la garde partagee existe', () => {
  assert.equal(typeof banc._garde, 'function',
    'apps/yield/index.html doit porter `chargerSiPossible`, la garde que les '
    + 'trois gestes partagent. Sans elle, chaque point d appel reecrit ses '
    + 'gardes — et celui qui les oublie les desarme pour tout l ecran.')
})

test("LE TEST QUI COMPTE : fenetre trop large, changer de logement ne part PAS", async () => {
  // \u26a0 ON POSE LA VRAIE CONDITION, PAS SON REFLET. Une premiere version de
  // ce test grisait `yf-charger` pour simuler l'avertissement — donc il
  // mesurait un drapeau d'affichage, et il est reste vert quand ce drapeau a
  // cesse d'etre la bonne question. Ici : vue Exploration, fenetre d'un an au
  // detail « jour » = 365 periodes contre un plafond de 100.
  poser({ bien: 'b-choisi' })
  banc._choisirVue('exploration')
  document.getElementById('yf-debut').value = '2026-01-01'
  document.getElementById('yf-fin').value = '2026-12-31'
  document.getElementById('yf-granularite').value = 'jour'
  banc._garde()
  await tick(); await tick()
  assert.deepEqual(envois, [],
    'la fenetre demandee depasse ce que l endpoint rend : la lecture ne doit '
    + 'pas partir, sinon elle repart en 400 et son erreur ecrase l avertissement.')

  // \u26a0 LE CONTRE-CONTROLE EST DANS LE MEME TEST : la MEME fenetre, au detail
  // « mois », fait 13 periodes et doit passer. Sans lui, une garde qui refuse
  // toute Exploration serait verte.
  document.getElementById('yf-granularite').value = 'mois'
  banc._garde()
  await tick(); await tick()
  assert.equal(envois.length, 1,
    'la meme fenetre au detail « mois » tient sous le plafond : elle doit partir')
  banc._choisirVue('pilotage')
})

test("LE TEST QUI COMPTE : aucun logement selectionne, rien ne part", async () => {
  poser({ bien: '' })
  banc._garde()
  await tick(); await tick()
  assert.deepEqual(envois, [],
    'sans logement, `charger()` partirait avec un `property_id` vide et son '
    + 'erreur technique ecraserait « Aucun logement accessible sur ce compte. »')
})

// ⚠ LE CONTRE-CONTROLE, SANS LUI LES DEUX TESTS CI-DESSUS SERAIENT VERTS POUR
// UNE GARDE QUI REFUSE TOUT (regle 22).
test('LE CONTRE-CONTROLE : fenetre normale et logement choisi, la lecture part bien', async () => {
  poser({ bien: 'b-choisi' })
  banc._garde()
  await tick(); await tick()
  assert.equal(envois.length, 1, 'une requete, et une seule, doit partir')
  assert.match(envois[0], /property_id=b-choisi/,
    'et elle doit porter le logement CHOISI — le defaut d origine du lot')
})

test('LE TEST QUI COMPTE : les trois gestes passent par la garde, aucun n appelle `charger` nu', () => {
  // ⚠ COMMENTAIRES ECARTES : le fichier CITE `addEventListener('change', charger)`
  // dans le commentaire qui raconte le defaut. Compter sans ecarter rendrait ce
  // test vert sur le code fautif — le piege 2 de tests/outils/source.js.
  const code = sansCommentaires(lire('apps/yield/index.html'))
  for (const id of ['yf-bien', 'yf-annee']) {
    assert.match(code, new RegExp(`el\\('${id}'\\)\\.addEventListener\\('change', chargerSiPossible\\)`),
      `${id} doit passer par la garde partagee`)
    assert.doesNotMatch(code, new RegExp(`el\\('${id}'\\)\\.addEventListener\\('change', charger\\)`),
      `${id} appelle encore \`charger\` NU : la garde est contournee par ce geste`)
  }
  // Et `changerVue` ne recopie plus les deux gardes : il partage les memes.
  const vue = code.match(/function changerVue[\s\S]*?\n  \}/)[0]
  assert.match(vue, /chargerSiPossible\(\)/,
    'changerVue doit appeler la garde partagee')
  assert.doesNotMatch(vue, /el\('yf-charger'\)\.disabled\) return/,
    'changerVue ne doit plus porter sa propre copie des gardes : deux copies divergent')
})
// ⚠ LE CAS QUI A FAIT RENVERSER LE PREMIER CORRECTIF — releve par la review
// independante du 28 octobre 2026, APRES un premier verdict favorable.
//
// `yf-charger.disabled` porte DEUX sens, pas un : l'avertissement d'etendue
// (`verifierEtendue`), la liste vide (`chargerBiens`), ET le verrou de
// requete EN VOL pose par `charger()` lui-meme. Une garde qui lit ce drapeau
// sans distinguer les trois AVALE le changement de logement pendant toute la
// duree du `fetch` — et `/api/yield` est documente comme lent.
//
// ⚠ ET C'EST EXACTEMENT LE DEFAUT DE RECETTE QUE CE LOT FERME : l'ecran se
// peint avec le premier bien par ordre alphabetique pendant que le selecteur
// affiche celui que l'hote a choisi. Le premier correctif rouvrait donc, dans
// cette fenetre, le defaut qu'il corrigeait ailleurs.
//
// ⚠ ET AVANT CE LOT, CE CAS MARCHAIT : `charger()` nu incrementait `enCours`,
// et la reponse obsolete etait ecartee par le jeton de sequence. C'est le
// genre de regression qu'un test de non-regression ne voit pas, parce qu'elle
// naît du CORRECTIF.
test("LE TEST QUI COMPTE : une lecture EN VOL n avale pas le changement de logement", async () => {
  poser({ bien: 'bien-A' })
  retenues = []            // a partir d ici, les reponses restent en l air
  banc._garde()
  await tick(); await tick()
  assert.equal(envois.length, 1, 'la lecture du bien A doit etre partie')
  // ⚠ LE VERROU DE REQUETE EST POSE : c est `charger()` qui l a mis, pas
  // `verifierEtendue`. Le mesurer ici, sinon le test ne prouve pas qu il
  // exerce bien le cas en vol.
  assert.equal(document.getElementById('yf-charger').disabled, true,
    'charger() pose le verrou de requete le temps du fetch')

  // L hote choisit un autre logement pendant que A repond encore.
  const sel = document.getElementById('yf-bien')
  sel.innerHTML = '<option value="bien-A">A</option><option value="bien-B">B</option>'
  sel.value = 'bien-B'
  banc._garde()
  await tick(); await tick()

  assert.equal(envois.length, 2,
    'le changement de logement doit partir MEME si une lecture est en vol. '
    + 'Sinon l ecran se peint avec le bien A pendant que le selecteur dit B — '
    + 'le defaut de recette que ce lot ferme, rouvert par sa propre garde.')
  assert.match(envois[1], /property_id=bien-B/,
    'et la seconde lecture doit porter le bien CHOISI')

  retenues.forEach(f => f())
  retenues = null
  await tick(); await tick()
})
