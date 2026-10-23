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

test('LE TEST QUI COMPTE : l ecran n est JAMAIS plus permissif que le serveur', () => {
  // ⚠ CE TEST ETAIT UNE TAUTOLOGIE (review du 22 octobre 2026) : il relisait les
  // litteraux de `CHAMPS` — une metadonnee que `refusDeSaisie` n'utilisait meme
  // pas — et cherchait quatre motifs dans le texte de l'endpoint. Mutation
  // `CHAMPS.base_price.min` 1 -> 99 : 19 tests, 19 verts. Il ne confrontait rien.
  //
  // Ce qui compte n'est pas que les deux bornes soient EGALES — l'ecran a le
  // droit d'etre plus strict, et il l'est : il refuse `capacity: 2.5` que le
  // serveur tronque a 2. Ce qui est interdit est l'inverse : accepter ici ce
  // que le serveur refusera, car l'hote remplit alors dix champs pour un 400.
  //
  // On rejoue donc la validation du serveur sur un jeu de cas limites, et on
  // exige : accepte par l'ecran => accepte par le serveur.
  const duServeur = (v) => {
    // Recopie ligne a ligne du bloc POST de api/channel-property.js. Les
    // assertions qui suivent cette fonction verifient que la recopie est encore
    // fidele : si le serveur change une borne, elles rougissent.
    if (!v.name || typeof v.name !== 'string' || v.name.length < 1 || v.name.length > 100) return 'nom'
    const cap = parseInt(v.capacity, 10)
    if (!cap || cap < 1 || cap > 20) return 'capacite'
    const prix = parseFloat(v.base_price)
    if (!prix || prix <= 0 || prix > 100000) return 'prix_base'
    const inc = parseInt(v.included_guests, 10) || cap
    if (inc < 1 || inc > cap) return 'voyageurs_inclus'
    const sup = v.extra_guest_fee != null && v.extra_guest_fee !== '' ? parseFloat(v.extra_guest_fee) : null
    if (sup != null && (sup < 0 || sup > 100000)) return 'supplement'
    return null
  }

  const cas = []
  for (const name of ['Studio', '', 'x'.repeat(101)]) {
    for (const capacity of [2, 0, 21, '2.5', 'abc']) {
      for (const base_price of [80, 0, 0.5, 100001, 'abc']) {
        for (const included_guests of [null, 1, 10, 0, '2.5']) {
          for (const extra_guest_fee of [null, 0, -1, 'abc']) {
            cas.push({ ...saisie, name, capacity, base_price, included_guests, extra_guest_fee })
          }
        }
      }
    }
  }
  assert.ok(cas.length >= 300, `${cas.length} cas : le balayage s est referme`)

  const fautes = []
  let acceptesParLesDeux = 0
  for (const v of cas) {
    const ecran = M.refusDeSaisie(v)
    const serveur = duServeur(v)
    if (!ecran && serveur) fautes.push(`${JSON.stringify(v)} : l ecran accepte, le serveur refuse (${serveur})`)
    if (!ecran && !serveur) acceptesParLesDeux++
  }
  assert.deepEqual(fautes.slice(0, 5), [], `${fautes.length} cas passent l ecran et echouent au serveur`)
  assert.ok(acceptesParLesDeux > 0, 'et au moins un cas doit passer les deux : sinon on ne mesure rien')
})

test('la recopie des bornes du serveur est encore fidele', () => {
  // Si l une de ces lignes bouge, le test ci-dessus mesure un serveur qui
  // n existe plus. C est le seul endroit ou lire le texte de l endpoint se
  // justifie : on verifie que notre COPIE est a jour, pas la garde elle-meme.
  assert.match(endpoint, /cap < 1 \|\| cap > 20/)
  assert.match(endpoint, /basePrice <= 0 \|\| basePrice > 100000/)
  assert.match(endpoint, /extraFee < 0 \|\| extraFee > 100000/)
  assert.match(endpoint, /name\.length < 1 \|\| name\.length > 100/)
  assert.match(endpoint, /incGuests < 1 \|\| incGuests > cap/)
})

test('LE TEST QUI COMPTE : les bornes declarees dans le HTML sont celles qui MORDENT', () => {
  // ⚠ UNE SEULE SOURCE. Le HTML declare `min="1"` sur le prix, le module declare
  // `min: 1`, et `refusDeSaisie` lit le module. Trois ecritures de la meme
  // regle, c est trois occasions de diverger — et la page porte `novalidate`,
  // donc le navigateur n applique PLUS les attributs. Mesure du 22 octobre
  // 2026 : un logement a 0,50 EUR la nuit se creait, et le plan tarifaire
  // partait chez le partenaire a 50 centimes.
  const d = doc(page)
  for (const c of M.CHAMPS) {
    const el = d.querySelector('#' + c.id)
    if (c.min != null) assert.equal(el.getAttribute('min'), String(c.min),
      `#${c.id} : le HTML dit min=${el.getAttribute('min')}, le module dit ${c.min}`)
    if (c.max != null && c.type !== 'texte') assert.equal(el.getAttribute('max'), String(c.max),
      `#${c.id} : le HTML dit max=${el.getAttribute('max')}, le module dit ${c.max}`)
    if (c.max != null && c.type === 'texte' && el.tagName === 'INPUT') {
      assert.equal(el.getAttribute('maxlength'), String(c.max), `#${c.id} : maxlength`)
    }
  }
  // Et la borne MORD vraiment, puisque `refusDeSaisie` lit `CHAMPS`.
  assert.ok(M.refusDeSaisie({ ...saisie, base_price: 0.5 }), 'un prix sous le minimum doit etre refuse')
  assert.ok(M.refusDeSaisie({ ...saisie, capacity: '2.5' }), 'une capacite non entiere doit etre refusee, pas tronquee')
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

test('le masquage est double d une garde serveur — PROUVEE AILLEURS, PAR APPEL', () => {
  // ⚠ CE TEST ETAIT UN FAUX VERT DE SECURITE (review du 22 octobre 2026) :
  // quatre `assert.match` sur le texte de l endpoint, satisfaits ailleurs dans
  // le meme fichier. Neutraliser la garde titulaire, ou retirer
  // `compteDelegue` — le defaut exact du 19 octobre —, laissait 106 tests
  // verts. REVIEW.md regle 20 : « appeler, pas lire ».
  //
  // La preuve vit donc dans tests/creation-bien-garde-appelee.test.js, qui
  // APPELLE le handler et exige 403. Ici, on verifie seulement que cette preuve
  // existe toujours — un garde-fou deplace puis supprime ne laisse aucune trace.
  const preuve = fs.readFileSync(path.join(racine, 'tests/creation-bien-garde-appelee.test.js'), 'utf8')
  assert.match(preuve, /require\('\.\.\/api\/channel-property\.js'\)/,
    'la preuve doit charger le vrai endpoint')
  assert.match(preuve, /assert\.equal\(res\.code, 403/, 'et exiger le refus')
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

// Toutes les cles de refus que `refusDeSaisie` peut reellement rendre : on les
// provoque, une par champ, plutot que de les deviner.
function clesQueLeModulePeutRendre () {
  const vues = new Set()
  const essais = [
    { ...saisie, name: null }, { ...saisie, name: 'x'.repeat(200) },
    { ...saisie, capacity: 0 }, { ...saisie, capacity: '2.5' },
    { ...saisie, base_price: 0 }, { ...saisie, base_price: 0.5 },
    { ...saisie, included_guests: 99 }, { ...saisie, included_guests: 0 },
    { ...saisie, extra_guest_fee: -1 }, { ...saisie, extra_guest_fee: 'abc' },
    { ...saisie, city: 'x'.repeat(200) }, { ...saisie, address: 'x'.repeat(500) },
    { ...saisie, zip_code: 'x'.repeat(50) }
  ]
  for (const v of essais) {
    const r = M.refusDeSaisie(v)
    if (r) vues.add(r.cle)
  }
  return [...vues]
}

test('toutes les cles i18n de la page et du module existent dans les TROIS langues', () => {
  const cles = new Set([
    ...[...page.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]),
    ...[...page.matchAll(/data-i18n-attr="[^"]*:([^";]+)"/g)].map(m => m[1].trim()),
    ...[...page.matchAll(/\bt\('([^']+)'/g)].map(m => m[1]),
    // ⚠ LES CLES DU MODULE SE COLLECTENT EN L EXECUTANT, pas en lisant son
    // texte : il les CONSTRUIT (`'nouveau.faute_' + champ.id`), donc un motif
    // n y relevait que le prefixe. On le fait donc parler.
    ...clesQueLeModulePeutRendre()
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

test('les zones de clic declarent au moins 44 px', () => {
  // ⚠ CE TEST LISAIT LE CSS AU CARACTERE PRES (`/\.nou-actions \.btn \{ min-height: 44px; \}/`) :
  // un reformatage le faisait rougir, une regle posee plus bas qui ecrase
  // `min-height` le laissait vert. Il affirmait que le fichier contient la
  // chaine qu il contient.
  //
  // On ne peut pas calculer une hauteur rendue sans navigateur ; on verifie
  // donc la DERNIERE declaration de `min-height` pour chaque selecteur — c est
  // elle qui gagne a specificite egale — et qu aucune ne descend sous 44.
  const style = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
  const cibles = ['.nou-champ input, .nou-champ select', '.nou-actions .btn', '.nou-retour']
  for (const sel of cibles) {
    const blocs = [...style.matchAll(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g'))]
    assert.ok(blocs.length, `aucune regle pour \`${sel}\``)
    const hauteurs = blocs.flatMap(b => [...b[1].matchAll(/min-height:\s*(\d+)px/g)].map(m => Number(m[1])))
    assert.ok(hauteurs.length, `\`${sel}\` ne declare aucune min-height`)
    assert.ok(hauteurs[hauteurs.length - 1] >= 44,
      `\`${sel}\` finit a ${hauteurs[hauteurs.length - 1]}px : sous le doigt`)
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// 6. LES CORRECTIFS DE LA REVIEW DU 22 OCTOBRE 2026
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : le contexte est charge AVEC l identifiant', () => {
  // ⚠ LE BLOQUANT DE LA REVIEW. `chargerContexte()` sans argument
  // REINITIALISAIT le contexte avec `moi: undefined` ; `estTitulaire()`
  // commence par `if (!contexte.charge || !contexte.moi) return false`.
  // L ecran n affichait donc QUE son refus — pour tout le monde, titulaire
  // compris — et ne montrait jamais son formulaire. Les tests etaient verts.
  const script = page.slice(page.indexOf('<script type="module">'))
  const appels = [...script.matchAll(/chargerContexte\(([^)]*)\)/g)].map(m => m[1].trim())
  assert.ok(appels.length, 'la page doit charger le contexte')
  for (const a of appels) {
    assert.notEqual(a, '', 'un appel sans identifiant efface le contexte au lieu de le charger')
  }
})

test('LE TEST QUI COMPTE : la cause racine est fermee dans le module partage', () => {
  // Le correctif de la page ne suffit pas : la fonction ACCEPTAIT silencieusement
  // un argument manquant et detruisait l etat. La prochaine page refera l appel.
  const cc = fs.readFileSync(path.join(racine, 'shared/compte-courant.js'), 'utf8')
  const i = cc.indexOf('export async function chargerContexte')
  const j = cc.indexOf('contexte = { moi: userId', i)
  assert.ok(i !== -1 && j > i)
  assert.match(cc.slice(i, j), /if \(userId == null\)[\s\S]*?return contexte/,
    'un appel sans identifiant doit rendre le contexte EN L ETAT, pas l effacer')
})

test('LE TEST QUI COMPTE : la navigation est rendue', () => {
  // ⚠ `shared/nav.js` NE S AUTO-REND PAS : il se termine par
  // `window.HSNav = { render, renderLangSelector, renderMenu }`. Omise, la page
  // perdait les cinq entrees du haut, le menu — donc la DECONNEXION, la langue
  // et le selecteur de compte —, les initiales, et laissait au telephone un
  // bandeau NOIR VIDE colle en bas, pendant qu elle reservait 96 px pour lui.
  // L ancien ecran rendait sa navigation (`renderSidebar`).
  const script = page.slice(page.indexOf('<script type="module">'))
  assert.match(script, /HSNav\.render\(/, 'la barre du haut doit etre rendue')
  assert.match(script, /HSNav\.renderMenu\(/, 'le menu aussi : il porte la deconnexion')
  assert.match(script, /onDeconnexion:/, 'une deconnexion absente est un no-op silencieux')
  assert.match(script, /data-bind="initials"/, 'les initiales doivent etre posees')
})

test('toute page V5 qui porte une barre du bas rend sa navigation', () => {
  // ⚠ LE FILET, pour que le prochain ecran V5 ne refasse pas l omission : une
  // `.bottombar` vide devient un bandeau noir au telephone.
  const dossier = path.join(racine, 'pages')
  const oublis = []
  for (const f of fs.readdirSync(dossier)) {
    if (!f.endsWith('.html')) continue
    const html = fs.readFileSync(path.join(dossier, f), 'utf8')
    if (!/<nav class="bottombar"/.test(html)) continue
    if (!/HSNav\.render\(/.test(html)) oublis.push('pages/' + f)
  }
  assert.deepEqual(oublis, [], 'ces pages affichent une barre du bas qu elles ne remplissent jamais')
})

test('LE TEST QUI COMPTE : chaque message d erreur est RELIE a son champ', () => {
  // ⚠ Sans `aria-describedby`, un lecteur d ecran focalise sur le champ annonce
  // « Capacite maximale, invalide » et JAMAIS la phrase qui dit pourquoi, ni la
  // ligne d aide. La page n en portait aucun (review du 22 octobre 2026).
  const d = doc(page)
  const manques = []
  for (const el of d.querySelectorAll('input')) {
    const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
    if (!ids.length) { manques.push(`#${el.id} : aucun lien`); continue }
    for (const id of ids) {
      if (!d.getElementById(id)) manques.push(`#${el.id} renvoie a #${id}, qui n existe pas`)
    }
  }
  assert.deepEqual(manques, [])

  // ⚠ ET LE MESSAGE D ENVOI DOIT ETRE ANNONCE. Il apparait APRES le geste, sans
  // que le focus bouge : sans region vivante, un lecteur d ecran ne dit ni
  // « Logement cree » ni la raison d un echec — l hote attend devant un ecran
  // qui a deja repondu.
  const zone = d.querySelector('[data-bind="message"]')
  assert.ok(zone, 'la zone de message doit exister')
  assert.equal(zone.getAttribute('role'), 'status')
  assert.equal(zone.getAttribute('aria-live'), 'polite')
  const refus = d.querySelector('[data-bind="refus"]')
  assert.equal(refus.getAttribute('role'), 'status', 'le refus de droit aussi')

  // Et chaque champ que le module peut refuser a une zone pour le dire.
  for (const c of M.CHAMPS) {
    if (c.type === 'texte' && !c.max) continue
    assert.ok(d.querySelector(`[data-erreur="${c.id}"]`),
      `#${c.id} peut etre refuse, mais aucune zone ne porte son message`)
  }
})

test('le masquage ne depend pas des feuilles externes', () => {
  // ⚠ `.nou-form` declare `display: flex` sur l element qui porte `hidden`. Si
  // theme.css ET ui.css echouaient, cette declaration d AUTEUR l emporterait
  // sur le `[hidden] { display: none }` du NAVIGATEUR — les origines ne se
  // comparent pas — et le formulaire deviendrait visible.
  const style = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
  assert.match(style, /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    'la regle doit etre EN LIGNE, comme sur les quatorze pages autonomes du depot')
})

test('le succes se voit autrement que par la taille de police', () => {
  // L ancien ecran avait un bloc vert. La confirmation posee en `.caption` —
  // qui ne declare qu une taille — n avait plus aucune affordance.
  assert.match(page, /\.nou-message--fait \{[^}]*var\(--ok\)/)
  assert.match(page, /classList\.toggle\('nou-message--fait'/)
})

test('les trois exemples de saisie de l ancien ecran sont revenus', () => {
  // Adresse, code postal et ville etaient les trois seuls champs sans aucun
  // exemple : ils en avaient un avant.
  for (const champ of ['adresse', 'code_postal', 'ville']) {
    assert.match(page, new RegExp(`id="${champ}"[^>]*[\\s\\S]{0,200}?placeholder:nouveau\\.${champ}_exemple`),
      `#${champ} a perdu son exemple`)
  }
})

test('aucun libelle en dur, pays compris', () => {
  // « Belgique » et « Suisse » s affichaient en francais au milieu d une page
  // en anglais, et le test d i18n ne les voyait pas : il ne releve que les cles.
  const d = doc(page)
  for (const opt of d.querySelectorAll('#pays option')) {
    assert.ok(opt.getAttribute('data-i18n'), `le pays « ${opt.textContent} » est ecrit en dur`)
    assert.equal(opt.textContent.trim(), '', 'le libelle vient de la cle, pas du HTML')
  }
})

test('LE TEST QUI COMPTE : « 1e1 » n est pas dix pour l un et un pour l autre', () => {
  // ⚠ RELEVE A LA RE-REVIEW DU 22 OCTOBRE 2026. Un champ `type="number"`
  // CONSERVE « 1e1 » dans sa valeur — c est un nombre flottant valide, et c est
  // l accident classique de la touche « e ». `Number('1e1')` vaut 10 : l ecran
  // acceptait, en silence. Le serveur, lui, lit `parseInt('1e1', 10)` = 1.
  //
  // Ce que ca coutait : l hote voyait son 10 valide sans un mot, et le bien
  // partait chez le partenaire — propriete, type de chambre, plan tarifaire —
  // avec une capacite de UN.
  const d = doc(page)
  d.querySelector('#nom').value = 'Studio'
  d.querySelector('#prix_base').value = '80'
  d.querySelector('#capacite').value = '1e1'
  assert.equal(d.querySelector('#capacite').value, '1e1',
    'le DOM garde bien cette saisie : si ce jour vient ou il la rejette, ce test perd son objet')

  const v = M.valeursDuFormulaire(d.querySelector('[data-bind="form"]'))
  const r = M.refusDeSaisie(v)
  assert.ok(r, 'une saisie que l ecran et le serveur ne lisent pas pareil doit etre refusee')
  assert.equal(r.champ, 'capacite')

  // Et c est bien la DIVERGENCE qui est en cause, pas la valeur :
  assert.notEqual(Number(v.capacity), parseInt(v.capacity, 10),
    'Number et parseInt ne donnent pas le meme nombre ici — c est tout le probleme')
})

test('aucune saisie restee TEXTE ne passe sur un champ numerique', () => {
  // La regle generale derriere le cas ci-dessus : `valeurDuChamp` ne convertit
  // que ce qui est vraiment du type attendu ; ce qui reste une chaine n a donc
  // pas passe ce filtre, et personne ne doit le reinterpreter.
  for (const champ of M.CHAMPS.filter(c => c.type !== 'texte')) {
    for (const brut of ['1e1', ' 4 ', '4,5', '0x10', '']) {
      const v = { ...saisie, [champ.api]: brut }
      if (brut === '' && !champ.requis) continue
      const r = M.refusDeSaisie(v)
      assert.ok(r, `${champ.id} = ${JSON.stringify(brut)} doit etre refuse`)
    }
  }
})
