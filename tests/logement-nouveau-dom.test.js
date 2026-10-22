// tests/logement-nouveau-dom.test.js
//
// L'ECRAN V5 DE CREATION D'UN LOGEMENT (lot Logements, etape 4) et son module
// de saisie `shared/logement-nouveau.js`.
//
// ⚠ CE QUE CES TESTS DEFENDENT EN PREMIER : L'INVENTAIRE. La regle du depot est
// « la forme ne supprime jamais le fond » — une spec UI ne retire jamais une
// fonction par omission. Le premier test confronte donc les champs de la V5 a
// ceux de l'ANCIEN ecran (`pages/biens-nouveau.html`), fichier a fichier : si
// l'un disparait de la V5 sans raison ecrite, le test rougit. Vecu le 11
// octobre 2026 sur la messagerie V5 — badge d'arrivee, telephone en lien
// d'appel et etat du menage perdus, repares par Thierry en recette, pas par la
// spec.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const racine = path.join(__dirname, '..')
const page = fs.readFileSync(path.join(racine, 'pages/logement-nouveau.html'), 'utf8')
const ancien = fs.readFileSync(path.join(racine, 'pages/biens-nouveau.html'), 'utf8')
const module_ = fs.readFileSync(path.join(racine, 'shared/logement-nouveau.js'), 'utf8')
const endpoint = fs.readFileSync(path.join(racine, 'api/channel-property.js'), 'utf8')

// ⚠ CES TESTS PORTENT SUR CE QUE L'ECRAN FAIT, PAS SUR CE QUI L'EXPLIQUE.
// Mesure du 22 octobre 2026 : deux d'entre eux rougissaient sur leurs propres
// commentaires — le `⚠` des encadres tombe dans la plage des emoji, et la
// phrase qui dit de NE PAS ecrire `I18n.apply(document)` contient cette chaine.
// Un garde-fou qui lit les commentaires punit celui qui explique son code.
function sansCommentaires (src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
const pageNue = sansCommentaires(page)

const doc = (html) => new JSDOM(html).window.document

// Le module est en ES ; les tests tournent en CommonJS. On l'evalue en
// remplacant son `export` final — c'est le geste deja employe par le depot pour
// les modules d'ecran (`shared/logements-liste.js`).
function chargerModule () {
  const src = module_.replace(/^export \{[^}]*\}$/m, 'module.exports = { CHAMPS, valeursDuFormulaire, refusDeSaisie, valeurDuChamp }')
  const m = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', src)(m, m.exports)
  return m.exports
}
const M = chargerModule()

// ═══════════════════════════════════════════════════════════════════════════
// 1. L'INVENTAIRE — rien du fond ne se perd
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : les DIX champs de l ancien ecran sont tous repris', () => {
  // Les noms changent (l'ancien ecran nommait ses champs comme l'API, la V5 les
  // nomme en francais) : on compare donc par le nom d API, qui est ce que le
  // serveur recoit, et qui ne peut pas mentir.
  const attendus = ['name', 'capacity', 'currency', 'base_price', 'included_guests',
    'extra_guest_fee', 'address', 'zip_code', 'city', 'country']
  const dansLAncien = attendus.filter(n => new RegExp(`name="${n}"`).test(ancien))
  assert.deepEqual(dansLAncien, attendus, 'l ancien ecran porte bien ces dix champs')

  const dansLaV5 = M.CHAMPS.map(c => c.api)
  for (const n of attendus) {
    assert.ok(dansLaV5.includes(n), `le champ \`${n}\` de l ancien ecran a disparu de la V5`)
  }
  assert.equal(M.CHAMPS.length, 10, 'dix champs, ni plus ni moins')
})

test('chaque champ du module existe VRAIMENT dans la page', () => {
  // Un champ decrit dans le module mais absent du HTML serait toujours vide, et
  // la saisie partirait amputee sans que rien ne le dise.
  const d = doc(page)
  for (const c of M.CHAMPS) {
    assert.ok(d.querySelector('#' + c.id), `le champ #${c.id} manque dans la page`)
  }
})

test('les trois champs obligatoires le restent, et le prix de base en fait partie', () => {
  // ⚠ LE PRIX DE BASE EST OBLIGATOIRE POUR DEUX RAISONS QUE L'HOTE NE VOIT PAS :
  // il sert de plancher au plan tarifaire provisionne et il autorise
  // l'activation d'un canal (lib/garde-activation.js). Le rendre optionnel
  // deplacerait le mur au lieu de l'enlever.
  const d = doc(page)
  for (const id of ['nom', 'capacite', 'prix_base']) {
    assert.ok(d.querySelector('#' + id).hasAttribute('required'), `#${id} doit rester obligatoire`)
  }
  assert.match(endpoint, /Prix de base requis \(>0\)/,
    'le serveur doit continuer de l exiger — sinon ce test defend une regle morte')
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. LES BORNES DISENT LA MEME CHOSE QUE LE SERVEUR
// ═══════════════════════════════════════════════════════════════════════════

const saisie = { name: 'Studio Centre', capacity: 2, base_price: 80,
  included_guests: null, extra_guest_fee: null, currency: 'EUR', country: 'FR',
  address: null, zip_code: null, city: null }

test('une saisie correcte ne produit aucun refus', () => {
  assert.equal(M.refusDeSaisie(saisie), null)
})

test('LE TEST QUI COMPTE : voyageurs inclus > capacite est refuse PAR L ECRAN', () => {
  // ⚠ LA REGLE EXISTAIT AU SERVEUR, PAS A L ECRAN. L'ancien formulaire bornait
  // ce champ a 20 ; l'endpoint refuse « Voyageurs inclus invalide (1 a
  // capacite) ». Un hote qui saisissait 10 inclus pour 2 voyageurs remplissait
  // ses dix champs et recevait un 400 sans savoir lequel etait en cause.
  assert.match(endpoint, /Voyageurs inclus invalide \(1 a capacite\)/,
    'la regle doit exister au serveur : sinon l ecran est plus strict que lui')
  assert.match(ancien, /id="included_guests"[^>]*max="20"/,
    'l ancien ecran bornait bien a 20, sans regarder la capacite')

  const r = M.refusDeSaisie({ ...saisie, capacity: 2, included_guests: 10 })
  assert.equal(r && r.champ, 'voyageurs_inclus')
  assert.equal(r && r.cle, 'nouveau.faute_voyageurs_inclus')
  assert.equal(M.refusDeSaisie({ ...saisie, capacity: 4, included_guests: 4 }), null,
    'egal a la capacite est ACCEPTE : c est un maximum, pas une exclusion')
})

test('les bornes du nom, de la capacite, du prix et du supplement', () => {
  assert.equal(M.refusDeSaisie({ ...saisie, name: null }).champ, 'nom')
  assert.equal(M.refusDeSaisie({ ...saisie, name: 'x'.repeat(101) }).champ, 'nom')
  assert.equal(M.refusDeSaisie({ ...saisie, name: 'x'.repeat(100) }), null)
  assert.equal(M.refusDeSaisie({ ...saisie, capacity: 0 }).champ, 'capacite')
  assert.equal(M.refusDeSaisie({ ...saisie, capacity: 21 }).champ, 'capacite')
  assert.equal(M.refusDeSaisie({ ...saisie, capacity: 2.5 }).champ, 'capacite')
  assert.equal(M.refusDeSaisie({ ...saisie, base_price: 0 }).champ, 'prix_base')
  assert.equal(M.refusDeSaisie({ ...saisie, base_price: 100001 }).champ, 'prix_base')
  assert.equal(M.refusDeSaisie({ ...saisie, extra_guest_fee: -1 }).champ, 'supplement')
  assert.equal(M.refusDeSaisie({ ...saisie, extra_guest_fee: 0 }), null,
    'zero est un supplement valide : il dit « pas de supplement »')
})

test('les bornes de l ecran sont celles du serveur, pas d autres', () => {
  // Confrontation litterale : si le serveur change une borne, ce test rougit et
  // oblige a changer les deux.
  assert.match(endpoint, /cap < 1 \|\| cap > 20/)
  assert.match(endpoint, /basePrice <= 0 \|\| basePrice > 100000/)
  assert.match(endpoint, /extraFee < 0 \|\| extraFee > 100000/)
  assert.match(endpoint, /name\.length < 1 \|\| name\.length > 100/)
  const bornes = M.CHAMPS.reduce((o, c) => (o[c.api] = c, o), {})
  assert.equal(bornes.capacity.min, 1)
  assert.equal(bornes.capacity.max, 20)
  assert.equal(bornes.base_price.max, 100000)
  assert.equal(bornes.extra_guest_fee.max, 100000)
  assert.equal(bornes.name.max, 100)
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. LA LECTURE DU FORMULAIRE
// ═══════════════════════════════════════════════════════════════════════════

function formulaireRempli (valeurs) {
  const d = doc(page)
  for (const [id, v] of Object.entries(valeurs)) {
    const el = d.querySelector('#' + id)
    assert.ok(el, `#${id} doit exister`)
    el.value = v
  }
  return d.querySelector('[data-bind="form"]')
}

test('LE TEST QUI COMPTE : un champ vide part en `null`, jamais en chaine vide', () => {
  // ⚠ `''` PASSERAIT LES GARDES `!= null` DU SERVEUR et finirait en base : une
  // ville vide deviendrait une ville « rien », indistinguable d une ville
  // jamais saisie.
  const v = M.valeursDuFormulaire(formulaireRempli({ nom: 'Studio', capacite: '2', prix_base: '80' }))
  assert.equal(v.city, null)
  assert.equal(v.address, null)
  assert.equal(v.zip_code, null)
  assert.equal(v.included_guests, null)
  assert.equal(v.extra_guest_fee, null)
  assert.ok(!Object.values(v).includes(''), 'aucune chaine vide dans la charge envoyee')
})

test('les nombres partent en nombres, et les espaces sont retires', () => {
  const v = M.valeursDuFormulaire(formulaireRempli({
    nom: '  Studio Centre  ', capacite: '4', prix_base: '92', supplement: '15', ville: ' Toulouse '
  }))
  assert.equal(v.name, 'Studio Centre')
  assert.equal(v.city, 'Toulouse')
  assert.strictEqual(v.capacity, 4)
  assert.strictEqual(v.base_price, 92)
  assert.strictEqual(v.extra_guest_fee, 15)
})

test('la charge porte les noms attendus par l endpoint, pas ceux de l ecran', () => {
  const v = M.valeursDuFormulaire(formulaireRempli({ nom: 'Studio', capacite: '2', prix_base: '80' }))
  const attendus = ['name', 'capacity', 'currency', 'address', 'city', 'country',
    'zip_code', 'base_price', 'included_guests', 'extra_guest_fee']
  assert.deepEqual(Object.keys(v).sort(), [...attendus].sort())
  // Et l endpoint destructure bien ces noms-la.
  assert.match(endpoint, /const \{ name, capacity, currency, address, city, country, zip_code, base_price, included_guests, extra_guest_fee/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. LE DROIT : masque A L ECRAN, refuse AU SERVEUR
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : le formulaire est masque tant que le droit n est pas su', () => {
  // ⚠ `hidden` DANS LE HTML, retire par le script seulement si l hote est
  // titulaire. S il etait visible par defaut, un membre delegue remplirait dix
  // champs avant de recevoir 403 — et une panne du script laisserait le
  // formulaire ouvert a tout le monde.
  const d = doc(page)
  assert.ok(d.querySelector('[data-bind="form"]').hasAttribute('hidden'),
    'le formulaire doit naitre masque')
  assert.ok(d.querySelector('[data-bind="refus"]').hasAttribute('hidden'),
    'le message de refus aussi : un seul des deux s affiche')
})

test('le masquage est double d une garde SERVEUR qui refuse en 403', () => {
  // La regle absolue du depot : « si on retire le masquage et qu on clique, le
  // serveur refuse-t-il ? Si la reponse n est pas oui, en 403, il n y a pas de
  // garde. » Mesure du 19 octobre 2026 : la garde d alors ne filtrait rien.
  assert.match(endpoint, /compteDelegue: true/)
  assert.match(endpoint, /estTitulaireDuCompte/)
  assert.match(endpoint, /Seul le titulaire du compte peut ajouter un logement/)
  assert.match(endpoint, /res\.status\(403\)/)
})

test('la page est NON DELEGABLE, et la garde est sa premiere instruction', () => {
  // ⚠ AVANT TOUT RENDU : elle montre et ecrit pour la personne connectee, pas
  // pour le compte sur lequel on travaille. Posee plus bas, elle laisserait
  // afficher un contresens le temps du chargement.
  const script = page.slice(page.indexOf('<script type="module">'))
  const iGarde = script.indexOf('exigerCompteProprePage')
  const iAuth = script.indexOf('requireAuth')
  assert.ok(iGarde > 0, 'la garde de page non delegable doit etre presente')
  assert.ok(iGarde < iAuth, 'elle doit venir avant tout le reste')
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. LES REGLES DE LA REFONTE V5
// ═══════════════════════════════════════════════════════════════════════════

test('aucun hexa, aucun emoji, aucun nom de partenaire', () => {
  assert.equal((page.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter(h => !/^#i-/.test(h)).length, 0,
    'les couleurs viennent des jetons de theme.css')
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(pageNue),
    'aucun emoji dans ce que l hote voit — l ancien ecran en avait un dans son titre')
  assert.match(ancien, /\u{1F3E0}/u, 'l ancien ecran portait bien un emoji : ce test defend un vrai changement')
  assert.ok(!/channex|beds24/i.test(page), 'aucun nom de partenaire')
})

test('toutes les cles i18n de la page et du module existent dans les TROIS langues', () => {
  const cles = new Set([
    ...[...page.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]),
    ...[...page.matchAll(/data-i18n-attr="[^"]*:([^";]+)"/g)].map(m => m[1].trim()),
    ...[...page.matchAll(/\bt\('([^']+)'/g)].map(m => m[1]),
    ...[...module_.matchAll(/cle: '([^']+)'/g)].map(m => m[1])
  ])
  assert.ok(cles.size >= 25, `${cles.size} cles relevees : le balayage s est referme`)
  for (const lang of ['fr', 'en', 'es']) {
    const d = JSON.parse(fs.readFileSync(path.join(racine, `shared/i18n/${lang}.json`), 'utf8'))
    const manquantes = [...cles].filter(k => !(k in d))
    assert.deepEqual(manquantes, [], `cles absentes de ${lang}.json : ${manquantes.join(', ')}`)
  }
})

test('la page charge les deux feuilles V5, et aucune feuille d avant', () => {
  assert.match(page, /href="\/shared\/theme\.css"/)
  assert.match(page, /href="\/shared\/ui\.css"/)
  assert.ok(!/public\/style\.css/.test(page), 'l ancienne feuille n est plus chargee')
})

test('LE TEST QUI COMPTE : le dictionnaire est charge avant d etre lu', () => {
  // ⚠ MESURE DU 22 OCTOBRE 2026 : sans `I18n.init()`, la page s affichait
  // entierement en « nouveau.title », « nouveau.nom »… — `I18n.t` rend la CLE
  // quand le dictionnaire est vide. Et un `I18n.apply(document)` pose au
  // demarrage ne repare rien : il TAMPONNE les cles brutes par-dessus le texte.
  const script = sansCommentaires(page.slice(page.indexOf('<script type="module">')))
  assert.match(script, /await I18n\.init\(\)/, 'le dictionnaire doit etre charge')
  const iInit = script.indexOf('await I18n.init()')
  const iT = script.search(/\bt\('nouveau\./)
  assert.ok(iT === -1 || iInit < iT, 'aucune lecture de cle avant le chargement')
  assert.ok(!/I18n\.apply\(document\)/.test(script),
    'appliquer au document entier au demarrage tamponne les cles brutes')
})

test('les zones de clic font au moins 44 px', () => {
  // Charte §7, et c est au doigt que ca se juge.
  assert.match(page, /\.nou-champ input, \.nou-champ select \{[\s\S]*?min-height: 44px/)
  assert.match(page, /\.nou-actions \.btn \{ min-height: 44px; \}/)
  assert.match(page, /\.nou-retour \{[\s\S]*?min-height: 44px/)
})

test('la classe d erreur du message existe VRAIMENT dans la page', () => {
  // ⚠ `.danger` n existe dans aucune des trois feuilles du site : l ecrire
  // aurait donne un message d echec en couleur de texte normale, donc un echec
  // qui ne se voit pas. On nomme la sienne, et on la declare.
  const classes = [...page.matchAll(/classList\.(?:toggle|add|remove)\('([^']+)'/g)].map(m => m[1])
  for (const c of classes) {
    assert.match(page, new RegExp('\\.' + c.replace(/-/g, '-') + '\\s*\\{'),
      `la classe \`${c}\` est posee par le script mais n est declaree nulle part`)
  }
})
