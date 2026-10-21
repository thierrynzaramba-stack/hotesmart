// tests/logement-page-dom.test.js — LE COMPORTEMENT DE LA PAGE /logements/:id.
//
// Même raison d'être que `tests/logements-page-dom.test.js` : le MODULE de
// rendu est couvert par `tests/logement-fiche-dom.test.js`, mais la PAGE porte
// quatre choses que le module ne voit pas — d'où vient l'identifiant, qui a le
// droit de se voir proposer la suppression, ce qu'on affiche quand la lecture
// échoue, et le verrou qui empêche deux lectures concurrentes.
//
// On EXTRAIT les fonctions de la page telles qu'elles sont écrites. Les
// redéclarer ici en ferait des copies, et le test resterait vert le jour où la
// page les perdrait.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const FICHIER = path.join(__dirname, '..', 'pages', 'logement.html')
const PAGE = fs.readFileSync(FICHIER, 'utf8')

function extraire (source, debut, quoi) {
  assert.notEqual(debut, -1, `${quoi} introuvable`)
  if (source.slice(Math.max(0, debut - 6), debut) === 'async ') debut -= 6
  let p = 0
  for (let j = source.indexOf('{', debut); j < source.length; j++) {
    if (source[j] === '{') p++
    else if (source[j] === '}') { p--; if (p === 0) return source.slice(debut, j + 1) }
  }
  throw new Error(`accolades non refermées pour ${quoi}`)
}
const fonctionDeLaPage = (nom) =>
  extraire(PAGE, PAGE.indexOf(`function ${nom} (`), `${nom} dans pages/logement.html`)

function ligneDeLaPage (motif, etiquette) {
  const m = PAGE.match(motif)
  assert.ok(m, `${etiquette} introuvable dans pages/logement.html`)
  return m[0].trim()
}

// ⚠ LE VRAI `escapeHtml`, EXTRAIT DE SON FICHIER. Il ne s'importe pas ici (ses
// `import` portent des chemins absolus de navigateur), mais le recopier ferait
// mesurer au test son propre double : un échappement plus clément que le vrai
// laisserait passer exactement ce qu'on cherche.
const PROPS = fs.readFileSync(path.join(__dirname, '..', 'shared', 'properties.js'), 'utf8')
const ESCAPE_HTML = extraire(PROPS, PROPS.indexOf('export function escapeHtml'), 'escapeHtml')
  .replace('export function', 'function')

// La garde de droit du bouton Supprimer, telle qu'elle est écrite.
const GARDE_SUPPRIMER = ligneDeLaPage(
  /^\s*cible\.innerHTML = ficheHtml\(.*$/m, 'la garde du bouton Supprimer')

// Le squelette réel : son `<main>` tel quel, pour qu'un `data-bind` renommé
// dans la page fasse rougir le test.
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + 7)

let M
test.before(async () => { M = await import('../shared/logement-fiche.js') })

const FR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', 'fr.json'), 'utf8'))

function monter ({ reponse = null, erreur = null, peutEcrireReglages = true, chemin = '/logements/b1', peutEcrireReservations = true } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><style>[hidden]{display:none !important}</style></head>
     <body>${MAIN}</body></html>`,
    { pretendToBeVisual: true, url: `https://x.test${chemin}` })
  const { window } = dom
  const etat = { appels: 0, demandes: [] }

  const I18n = {
    lang: 'fr',
    // ⚠ LE DOUBLE EST AUSSI STRICT QUE LE MOTEUR : `t(cle, vars = {})` lit
    // `vars[k]` sans garde, donc `t(cle, null)` LÈVE en vrai. Un double
    // tolérant avait laissé passer un `null` qui faisait tomber la liste
    // entière dans « panne » (revue de l'étape 1).
    t: (k, v = {}) => {
      assert.notEqual(v, null, `t('${k}') appelé avec null : le moteur réel lève`)
      assert.ok(FR[k] != null, `clé i18n absente de fr.json : ${k}`)
      return `[${k}]`
    },
    date: (d, o) => `EN-CLAIR(${d.toISOString().slice(0, 10)}${o && o.year ? '+an' : ''})`,
    num: (x, o) => new Intl.NumberFormat('fr', o).format(x),
    apply: () => {}
  }
  const api = {
    logement: {
      fiche: async (id) => { etat.appels++; etat.demandes.push(id); if (erreur) throw erreur; return reponse }
    }
  }

  const contexte = {
    window, document: window.document, location: window.location,
    I18n, api, logger: { error: () => {}, info: () => {} },
    Date, decodeURIComponent, Number, Intl, String, JSON, setTimeout,
    ficheHtml: M.ficheHtml, etatHtml: M.etatHtml, etatDeLaPage: M.etatDeLaPage,
    // ⚠ DEUX DOMAINES DEPUIS L'ÉTAPE 3, ET C'EST LE FOND DU SUJET : la
    // suppression et les champs dépendent de `reglages`, mais « Publier mes
    // prix » est gardé côté serveur par `reservations`. Un double qui
    // répondrait la même chose aux deux masquerait une confusion de droits.
    peutEcrire: (domaine) => {
      assert.ok(['reglages', 'reservations'].includes(domaine),
        `droit demandé hors des deux domaines de la fiche : ${domaine}`)
      return domaine === 'reglages' ? peutEcrireReglages : peutEcrireReservations
    },
    etatTest: etat
  }

  const source = `
    ${ESCAPE_HTML}
    const esc = escapeHtml
    const t = (k, v) => I18n.t(k, v)
    const $ = (s) => document.querySelector(s)
    ${ligneDeLaPage(/^\s*const icone = .*$/m, 'le rendu des icônes')}
    ${ligneDeLaPage(/^const idDuBien = .*$/m, 'la lecture de l identifiant')}
    ${fonctionDeLaPage('dateEnClair')}
    ${ligneDeLaPage(/^const nombre = [\s\S]*?^\}$/m, 'le formateur de nombre')}
    ${ligneDeLaPage(/^const argent = [\s\S]*?^\}$/m, 'le formateur de montant')}
    ${ligneDeLaPage(/^const liste = [\s\S]*?^\}$/m, 'la conjonction de la langue')}
    ${ligneDeLaPage(/^const OUTILS = .*$/m, 'les outils du rendu')}
    ${fonctionDeLaPage('montrerEtat')}
    ${ligneDeLaPage(/^let enVol = .*$/m, 'le verrou enVol')}
    ${fonctionDeLaPage('charger')}
    globalThis.__charger = charger
    globalThis.__montrerEtat = montrerEtat
    globalThis.__id = idDuBien
    globalThis.__outils = OUTILS
  `
  vm.createContext(contexte)
  vm.runInContext(source, contexte)
  return { window, doc: window.document, ctx: contexte, etat }
}

const fiche = (extra = {}) => ({
  bien: {
    id: 'b1', nom: 'La bulle', ville: 'Bagnères', pays: 'FR', adresse: '1 rue X',
    code_postal: '65200', capacite: 2, photo_url: null, devise: 'EUR',
    prix_de_base: 120, prix_plancher: 130, voyageurs_inclus: 2, supplement_voyageur: 15,
    mode_des_prix: 'managed', pilote_tarifaire: 'yieldflow', assistant_en_pause: false
  },
  canaux: [{ ota: 'airbnb', titre: 'x', actif: true, mappe: true, listing_url: null }],
  canaux_vu_le: '2026-10-20T08:00:00Z', canaux_echec: false,
  suppression: { possible: true, motif: null },
  avis: { fenetre_jours: 30, proprete_sur_jours: 30, total_proprete: 4, positif: 3,
          remarque: 1, rien_signale: 0, non_analyses: 0, total: 336, notes: 332, note_sur_5: 4.9 },
  taxe: { connue: true, commune: 'Bagnères' },
  fait_date: { type: 'occupe', du: null, au: '2026-10-22' },
  menage: [{ id: 'm1', prenom: 'Regina', nom: 'B.', rang: 1, requires_ack: false }],
  serrures: [], indisponibles: [], refuses: [], ...extra
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. D'où vient l'identifiant
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : l identifiant vient du CHEMIN, et il est décodé', () => {
  // ⚠ La route est `/logements/:id` (décision de Thierry du 21 octobre 2026).
  // Une référence partenaire est acceptée par la garde serveur : elle peut
  // porter des caractères encodés, et les passer bruts ferait un 404 sur un
  // bien qui existe.
  assert.equal(monter({ chemin: '/logements/b1' }).ctx.__id, 'b1')
  assert.equal(monter({ chemin: '/logements/209413' }).ctx.__id, '209413')
  assert.equal(monter({ chemin: '/logements/a%20b' }).ctx.__id, 'a b')
  // ⚠ PAS D'IDENTIFIANT : CE N'EST PAS UN 404 (revue de 5c0d759 — mon
  // commentaire décrivait un comportement que le code ne produit pas).
  // `GET /api/logement?id=` part dans la branche LISTE côté serveur, qui rend
  // 200 avec le portefeuille. L'écran le jette et affiche « panne ».
  // Aucune fuite — même compte, même garde —, mais il faut le dire juste.
  assert.equal(monter({ chemin: '/logements' }).ctx.__id, '')
  assert.equal(monter({ chemin: '/logements/' }).ctx.__id, '')
})

test('l identifiant du chemin est celui qu on DEMANDE au serveur', async () => {
  const { ctx, etat } = monter({ chemin: '/logements/209413', reponse: fiche() })
  await ctx.__charger()
  assert.deepEqual(etat.demandes, ['209413'])
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Les trois façons d'échouer
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : une PANNE n affiche jamais une fiche vide', async () => {
  const { doc, ctx } = monter({ erreur: Object.assign(new Error('boom'), { status: 503 }) })
  await ctx.__charger()
  const zone = doc.querySelector('[data-bind="etat"]')
  assert.equal(zone.hidden, false)
  assert.ok([...zone.querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n).includes('fiche.panne'))
  assert.equal(doc.querySelector('[data-bind="fiche"]').innerHTML, '',
    'un nom et un prix absents feraient croire à une perte de données')
  assert.ok(zone.querySelector('[data-bind="reessayer"]'))
})

test('404 et 403 se disent autrement, et le REFUS ne propose rien', async () => {
  const intro = monter({ erreur: Object.assign(new Error('x'), { status: 404 }) })
  await intro.ctx.__charger()
  const z1 = intro.doc.querySelector('[data-bind="etat"]')
  assert.deepEqual([...z1.querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n),
    ['fiche.introuvable', 'fiche.retour'])
  assert.ok(z1.querySelector('a[href="/logements"]'), 'on propose le retour à la liste')

  const refus = monter({ erreur: Object.assign(new Error('x'), { status: 403 }) })
  await refus.ctx.__charger()
  const z2 = refus.doc.querySelector('[data-bind="etat"]')
  assert.deepEqual([...z2.querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n), ['fiche.refus'])
  assert.equal(z2.querySelector('a, button'), null, 'on ne propose jamais ce qui mène à un refus')
})

test('LE TEST QUI COMPTE : une réponse MAL FORMÉE est une panne, pas une fiche', async () => {
  for (const r of [null, {}, { bien: null }, 'oui']) {
    const { doc, ctx } = monter({ reponse: r })
    await ctx.__charger()
    assert.equal(doc.querySelector('[data-bind="etat"]').hidden, false, JSON.stringify(r))
    assert.equal(doc.querySelector('[data-bind="fiche"]').innerHTML, '')
  }
})

test('LE TEST QUI COMPTE : « Réessayer » rappelle la lecture, et prend le focus', async () => {
  const { doc, ctx, etat } = monter({ erreur: Object.assign(new Error('boom'), { status: 503 }) })
  await ctx.__charger()
  assert.equal(etat.appels, 1)
  const bouton = doc.querySelector('[data-bind="reessayer"]')
  assert.equal(doc.activeElement, bouton, 'sans ça, le clavier repart du début du document')
  bouton.click()
  await new Promise(r => setTimeout(r, 0))
  assert.equal(etat.appels, 2, 'le bouton doit être CÂBLÉ, pas seulement affiché')
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Le chargement se termine, dans les trois cas
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : la fiche ne reste pas « occupée » à vie', async () => {
  const ok = monter({ reponse: fiche() })
  assert.equal(ok.doc.querySelector('[data-bind="fiche"]').getAttribute('aria-busy'), 'true')
  await ok.ctx.__charger()
  assert.equal(ok.doc.querySelector('[data-bind="fiche"]').hasAttribute('aria-busy'), false)
  assert.equal(ok.doc.querySelector('[data-bind="chargement"]').hidden, true)

  for (const status of [403, 404, 503]) {
    const ko = monter({ erreur: Object.assign(new Error('x'), { status }) })
    await ko.ctx.__charger()
    assert.equal(ko.doc.querySelector('[data-bind="fiche"]').hasAttribute('aria-busy'), false, String(status))
    assert.equal(ko.doc.querySelector('[data-bind="chargement"]').hidden, true, String(status))
  }
})

test('deux lectures concurrentes ne se chevauchent pas, et le verrou se RELÂCHE', async () => {
  const { ctx, etat } = monter({ reponse: fiche() })
  await Promise.all([ctx.__charger(), ctx.__charger()])
  assert.equal(etat.appels, 1, 'le second appel doit être refusé pendant que le premier est en vol')
  await ctx.__charger()
  assert.equal(etat.appels, 2, 'un verrou qui ne se relâche pas fige la page sur un écran mort')
})

test('une seconde lecture REMPLACE la fiche, elle ne s ajoute pas', async () => {
  const { doc, ctx } = monter({ reponse: fiche() })
  await ctx.__charger()
  await ctx.__charger()
  assert.equal(doc.querySelectorAll('.fic-entete').length, 1)
})

test('revenir d une panne à une fiche REFERME la zone d état', async () => {
  const { doc, ctx } = monter({ reponse: fiche() })
  ctx.__montrerEtat('panne')
  assert.equal(doc.querySelector('[data-bind="etat"]').hidden, false)
  await ctx.__charger()
  assert.equal(doc.querySelector('[data-bind="etat"]').hidden, true,
    'un message de panne au-dessus d une fiche valide fait croire à une panne')
  assert.ok(doc.querySelector('.fic-entete'))
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Sécurité — le droit, le titre, l'échappement réel
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE (SÉCURITÉ) : la garde du bouton Supprimer n est pas INVERSÉE', async () => {
  // La mutation qui survivrait sans ce test : `peutSupprimer: !peutEcrire(…)`.
  // Chercher la CHAÎNE dans le source la laisserait intacte.
  //
  // ⚠ ET CE N EST PLUS LA SEULE GARDE. Revue de 5c0d759 : `peutEcrire` répond
  // pour le COMPTE COURANT, alors que cette fiche est gardée par la RESSOURCE
  // — le bien désigne le compte, `X-Compte` y est ignoré. Le refus du SERVEUR
  // (`motif: 'droit_refuse'`) est souverain ; ce test vérifie les deux, et le
  // test du module vérifie que le motif efface le bloc.
  const reliee = () => fiche({ suppression: { possible: false, motif: 'annonce_reliee' } })

  const ecrit = monter({ reponse: reliee(), peutEcrireReglages: true })
  await ecrit.ctx.__charger()
  assert.ok(ecrit.doc.querySelector('[data-bind="supprimer"]'),
    'un profil en écriture doit lire la raison du refus')

  const lecture = monter({ reponse: reliee(), peutEcrireReglages: false })
  await lecture.ctx.__charger()
  assert.equal(lecture.doc.querySelector('[data-bind="supprimer"]'), null,
    'on ne propose pas une action que le serveur refusera en 403')
  assert.doesNotMatch(lecture.doc.body.textContent, /\[fiche\.supprimer/)

  // Le navigateur dit oui, le serveur dit non : c est le serveur qui gagne.
  const divergent = monter({
    reponse: fiche({ suppression: { possible: null, motif: 'droit_refuse' } }),
    peutEcrireReglages: true
  })
  await divergent.ctx.__charger()
  assert.equal(divergent.doc.querySelector('.fic-supprimer'), null,
    'le refus du serveur est souverain, même quand peutEcrire rend true')
})

test('LE TEST QUI COMPTE (SÉCURITÉ) : avec le VRAI échappement, rien ne s exécute', async () => {
  const { doc, ctx } = monter({
    reponse: fiche({
      bien: { ...fiche().bien, nom: '<img src=x onerror=alert(1)>', ville: '"><script>alert(2)</script>' },
      menage: [{ id: 'm', prenom: '<svg onload=alert(3)>', nom: null, rang: 1 }]
    })
  })
  await ctx.__charger()
  const f = doc.querySelector('[data-bind="fiche"]')
  assert.equal(f.querySelectorAll('img, script, svg:not([data-icone]):not([aria-hidden])').length, 0)
  assert.match(doc.querySelector('.fic-nom').textContent, /^<img src=x/)
})

test('le titre du document porte le nom du bien, et ne tombe pas sur un bien sans nom', async () => {
  const avec = monter({ reponse: fiche() })
  await avec.ctx.__charger()
  assert.equal(avec.doc.title, 'HôteSmart — La bulle')

  const sans = monter({ reponse: fiche({ bien: { ...fiche().bien, nom: null } }) })
  await sans.ctx.__charger()
  assert.doesNotMatch(sans.doc.title, /null|undefined/)
  // ⚠ ET PAS LE NOM DE LA LISTE : le repli était `t('fiche.retour')`, qui vaut
  // « Logements » — l'onglet annonçait la liste pour une fiche.
  assert.equal(sans.doc.title, 'HôteSmart')
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Les formats de la page
// ═══════════════════════════════════════════════════════════════════════════

test('les formats passent par I18n, jamais par la main', async () => {
  const { ctx } = monter({ reponse: fiche() })
  const o = ctx.__outils
  // ⚠ L'ANNÉE N'APPARAÎT QUE SI ELLE DIFFÈRE DE L'ANNÉE COURANTE. Dates
  // RELATIVES : ce test lit l'horloge, il ne la reçoit pas.
  const an = new Date().getFullYear()
  assert.equal(o.dateEnClair(`${an}-06-15`), `EN-CLAIR(${an}-06-15)`)
  assert.equal(o.dateEnClair(`${an + 2}-06-15`), `EN-CLAIR(${an + 2}-06-15+an)`)
  assert.equal(o.dateEnClair(null), '')
  // ⚠ CE QUI N'EST PAS UNE DATE SE REND TEL QUEL, jamais « Invalid Date ».
  // Mesuré : une date hors calendrier (`2026-02-30`) est ROULÉE par le
  // parseur, pas rejetée — inoffensif ici, le serveur rend une colonne `date`
  // de Postgres, donc toujours un jour qui existe. On ne fige donc pas ce
  // roulement : on garde la garde qui compte.
  assert.equal(o.dateEnClair('pas-une-date'), 'pas-une-date')
  assert.equal(o.dateEnClair(''), '')
  // La devise vient du bien.
  assert.match(o.argent(95, 'CHF'), /CHF/)
  assert.match(o.argent(95, null), /€/)
  assert.equal(o.nombre(4.9), '4,9')
})

test('la page n invente aucun texte : toute clé qu elle pose existe en français', async () => {
  // Le double de `I18n.t` lève sur une clé absente ; ce test l exerce sur les
  // quatre états, pour qu une clé posée dans un seul chemin ne passe pas.
  for (const m of [
    monter({ reponse: fiche(), peutEcrireReglages: true }),
    monter({ reponse: fiche({ menage: null, canaux: null, taxe: null, fait_date: null,
      indisponibles: ['menage', 'canaux', 'taxe'], suppression: { possible: false, motif: 'relie' } }) }),
    monter({ erreur: Object.assign(new Error('x'), { status: 404 }) }),
    monter({ erreur: Object.assign(new Error('x'), { status: 503 }) })
  ]) {
    await m.ctx.__charger()
    for (const n of m.doc.querySelectorAll('[data-i18n]')) {
      assert.ok(FR[n.dataset.i18n] != null, `clé posée et absente de fr.json : ${n.dataset.i18n}`)
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Les gardes de forme de la page
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : la page écrit PAR LE CLIENT D API, jamais par un appel direct', () => {
  // ⚠ CE TEST A CHANGÉ DE CONTRAT À L'ÉTAPE 3, sur go de Thierry : la fiche
  // n'est plus en lecture seule. Ce qu'il garde désormais est plus étroit et
  // plus utile — la page ne fabrique AUCUN appel à la main (pas de `fetch`, pas
  // de méthode écrite en dur), elle passe par `shared/api-client.js`, qui pose
  // le jeton, l'en-tête de compte et la lecture des refus. Un appel à la main
  // les oublierait, et c'est ainsi qu'un écran finit par parler au partenaire.
  // ⚠ HORS COMMENTAIRES, comme l'épreuve des emoji le fait déjà plus bas : la
  // règle vise ce que la page FAIT, pas ce qu'elle explique. Un commentaire qui
  // nomme `provider_property_id` pour dire qu'on envoie l'UUID à la place est
  // exactement ce qu'on veut lire dans six mois.
  const script = PAGE.slice(PAGE.indexOf('<script type="module">'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  for (const motif of [/\bfetch\s*\(/, /method:\s*'(POST|PATCH|DELETE|PUT)'/,
    /\/api\//, /beds24/i, /channex/i, /provider_property_id/]) {
    assert.doesNotMatch(script, motif, `la page ne doit pas porter : ${motif}`)
  }
  // Et les écritures qu'elle fait sont NOMMÉES : si une sixième apparaît, ce
  // test la fait lire à quelqu'un.
  const appels = [...script.matchAll(/api\.(\w+)\.(\w+)\s*\(/g)].map(m => `${m[1]}.${m[2]}`)
  const connus = new Set(['logement.fiche', 'logement.compterSuppression',
    'bien.modifier', 'bien.supprimer', 'bien.pause', 'bien.photo', 'calendar.fullsync'])
  for (const a of appels) assert.ok(connus.has(a), `appel non prévu par l'étape 3 : ${a}`)
})

test('aucun hexa et aucun emoji dans la page : jetons de theme.css et sprite', () => {
  assert.deepEqual(PAGE.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [])
  // ⚠ HORS COMMENTAIRES, comme `tests/aujourdhui.test.js` le fait pour le
  // socle : `⚠` est la marque des commentaires du dépôt, et la règle « aucun
  // emoji » vise ce que l'hôte LIT.
  const sansCommentaires = PAGE
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '')
  assert.deepEqual(sansCommentaires.match(/\p{Extended_Pictographic}/gu) || [], [])
  // Aucune forme SVG dessinée dans la page : le sprite seul.
  assert.equal(sansCommentaires.match(/<(path|circle|rect|polyline|line)\b/) , null)
  const sprite = fs.readFileSync(path.join(__dirname, '..', 'shared', 'icons.svg'), 'utf8')
  for (const m of PAGE.matchAll(/icons\.svg#([\w-]+)/g)) {
    assert.ok(sprite.includes(`id="${m[1]}"`), `icone ${m[1]} absente du sprite`)
  }
})

test('le menu complet est rendu : une page déléguée garde son sélecteur de compte', () => {
  // Constat de la revue de l étape 1 : un menu réduit laisse un hôte basculé
  // sur le compte d un autre sans moyen de revenir.
  const appel = PAGE.slice(PAGE.indexOf('HSNav.renderMenu('))
  for (const clef of ['comptes:', 'compteActif:', 'onCompte:', 'onDeconnexion:', 'reglages:', 'avis:', 'outils:']) {
    assert.ok(appel.includes(clef), `renderMenu sans \`${clef}\``)
  }
})

test('la route /logements/:id est déclarée dans vercel.json', () => {
  // `cleanUrls: true` : la destination est SANS `.html`, sinon 404 (règle dure
  // du dépôt).
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'))
  const r = (v.rewrites || []).find(x => x.source === '/logements/:id')
  assert.ok(r, 'sans la réécriture, /logements/b1 rend 404')
  assert.equal(r.destination, '/pages/logement')
})

// ════════════════════════════════════════════════════════════════════════
// ÉTAPE 3 — ce que la page ENVOIE quand on sort d'une case
// ════════════════════════════════════════════════════════════════════════

// La vraie fonction de la page, pas une copie.
const VALEUR_A_ENVOYER = fonctionDeLaPage('valeurAEnvoyer')
const valeurAEnvoyer = vm.runInNewContext(`(${VALEUR_A_ENVOYER.replace('function valeurAEnvoyer', 'function')})`)

const CH = (nom) => ({ nom, type: nom === 'name' ? 'texte' : 'montant' })

test('LE TEST QUI COMPTE : le plancher part en CENTIMES, saisi en euros', () => {
  // Le défaut ×100 trouvé en revue de l'étape 2 était dans l'autre sens : la
  // lecture. Ici c'est l'écriture, et le serveur attend des CENTIMES
  // (`prix_minimum invalide (centimes, > 0)`).
  const euros = { nom: 'prix_minimum', type: 'montant', euros: true }
  assert.equal(valeurAEnvoyer(euros, '130'), 13000)
  assert.equal(valeurAEnvoyer(euros, '95,50'), 9550, 'la virgule décimale est ce que tape un francophone')
  assert.equal(valeurAEnvoyer(euros, ''), null, 'vide = pas de plancher propre, et le serveur l accepte')
})

test('LE TEST QUI COMPTE : une virgule ne doit JAMAIS devenir `null` en silence', () => {
  // `Number('1,5')` vaut `NaN`, et `NaN` sérialisé en JSON devient `null` : le
  // champ serait EFFACÉ au lieu d être refusé. Le serveur a déjà payé ce
  // défaut sur le supplément par voyageur (sa garde `Number.isFinite` le dit).
  assert.equal(valeurAEnvoyer(CH('base_price'), '149,90'), 149.9)
  // Et ce qui n est pas un nombre ne part pas du tout : `undefined` = on
  // n envoie rien, l écran dit pourquoi.
  for (const brut of ['abc', '12 euros', '--', '1.2.3']) {
    assert.equal(valeurAEnvoyer(CH('base_price'), brut), undefined, brut)
  }
})

test('un texte vidé part à vide, un nombre vidé part à `null`', () => {
  // Ce sont deux contrats différents côté serveur : `address` accepte la chaîne
  // vide (il la range en `null`), `extra_guest_fee` attend `null`.
  assert.equal(valeurAEnvoyer({ nom: 'address', type: 'texte' }, '  '), '')
  assert.equal(valeurAEnvoyer(CH('extra_guest_fee'), '  '), null)
})

test('un entier reste entier : la capacité ne part pas à 2,5', () => {
  assert.equal(valeurAEnvoyer({ nom: 'capacity', type: 'entier' }, '2,5'), 3)
  assert.equal(valeurAEnvoyer({ nom: 'capacity', type: 'entier' }, '4'), 4)
})

test('LE TEST QUI COMPTE : un NOM VIDÉ est refusé par l écran — le serveur, lui, se tait', () => {
  // ⚠ `PATCH` n écrit le nom que `if (name !== undefined && String(name).trim())`.
  // Effacé, le champ est ignoré EN SILENCE, avec un 200 : l écran dirait
  // « Enregistré » sur un geste sans effet. On vérifie les deux bouts — la
  // garde dans la page, et la condition dans le serveur qui la justifie.
  const fn = fonctionDeLaPage('enregistrerChamp')
  assert.match(fn, /champ\.nom === 'name' && saisi === ''/,
    'la page doit refuser un nom vide avant d appeler')
  assert.match(fn, /fiche\.nom_requis/)
  const serveur = fs.readFileSync(path.join(__dirname, '..', 'api', 'channel-property.js'), 'utf8')
  assert.match(serveur, /if \(name !== undefined && String\(name\)\.trim\(\)\)/,
    'si le serveur se met à refuser un nom vide, cette garde d écran peut disparaître')
})

test('LE TEST QUI COMPTE : un champ INCHANGÉ ne part pas', () => {
  // Un champ de grille renvoyé pour rien reconstruit le plan tarifaire chez le
  // partenaire, EN BLOQUANT — à chaque clic à côté d une case.
  const fn = fonctionDeLaPage('enregistrerChamp')
  assert.match(fn, /if \(saisi === String\(avant\)\) \{ direEtat\(champ\.nom, null\); return \}/)
  assert.match(fn, /valeurDeSaisie\(champ, bienCourant\)/,
    'la référence doit venir du bien courant, pas de la case elle-même')
})

test('LE TEST QUI COMPTE : les enregistrements sont MIS EN FILE, pas lancés en parallèle', () => {
  // `PATCH` reconstruit la grille en bloquant : deux appels croisés sur le même
  // bien se liraient l un l autre à moitié écrits.
  assert.match(PAGE, /let file = Promise\.resolve\(\)/)
  assert.match(PAGE, /const enfiler =/)
  assert.match(fonctionDeLaPage('enregistrerChamp'), /await enfiler\(/)
})

test('LE TEST QUI COMPTE : l écouteur est DÉLÉGUÉ, et il écoute `change`', () => {
  // Posé case par case, il disparaîtrait au rechargement de la fiche (la page
  // réécrit tout son `innerHTML`). Et sur `input`, il partirait à chaque lettre.
  const ligne = ligneDeLaPage(/\$\('\[data-bind="fiche"\]'\)\.addEventListener\([^)]*/, 'l écouteur de saisie')
  assert.match(ligne, /'change'/)
  assert.doesNotMatch(PAGE, /addEventListener\('input'/)
})

test('l erreur du serveur s affiche SOUS le champ, et la case reprend la valeur enregistrée', () => {
  // Spec §3.3 : « erreurs serveur affichées sous le champ ». Et laisser la
  // saisie refusée à l écran ferait croire qu elle est enregistrée.
  const fn = fonctionDeLaPage('enregistrerChamp')
  assert.match(fn, /direEtat\(champ\.nom, 'erreur', e\.details \|\| e\.message/,
    'le DETAIL du refus passe avant le code machine')
  assert.match(fn, /input\.value = valeurDeSaisie\(champ, bienCourant\)/)
})

test('LE TEST QUI COMPTE : ce que le serveur n a PAS fait se dit', () => {
  // `PATCH` rend `note` quand il n a pas pu reconstruire la grille (bien sans
  // prix de base). Le taire laisserait croire que les prix ont suivi.
  assert.match(fonctionDeLaPage('enregistrerChamp'), /r\.note/)
})

test('LE TEST QUI COMPTE : un champ de GRILLE ne s enregistre pas tout seul', () => {
  // Les six autres gardent l enregistrement automatique : c est la d\u00e9cision de
  // Thierry, et elle ne vise que ce qui part chez Airbnb et Booking.com.
  const fn = fonctionDeLaPage('enregistrerChamp')
  assert.match(fn, /if \(champ\.grille\) return/,
    'l enregistrement automatique doit sauter les champs de grille')
  // Et le d\u00e9part est AVANT le moindre appel : un `return` plac\u00e9 apr\u00e8s laisserait
  // partir le PATCH.
  assert.ok(fn.indexOf('if (champ.grille) return') < fn.indexOf('api.bien.modifier'))
})

// \u26a0 ON FAIT TOURNER `envoyerBloc` POUR DE VRAI, dans un contexte isol\u00e9.
// Compter les occurrences de `api.bien.modifier` dans le TEXTE ne prouve rien :
// un appel plac\u00e9 dans une boucle n'en fait toujours qu'une (contre-\u00e9preuve du
// 21 octobre 2026, la mutation survivait). Ici on compte les appels R\u00c9ELS.
function lancerEnvoi ({ bien, saisies, reponse = {}, erreur = null }) {
  const appels = []
  const etats = []
  const cases = {}
  for (const [nom, valeur] of Object.entries(saisies)) cases[nom] = { value: valeur }
  const sandbox = {
    CHAMPS: M.CHAMPS,
    valeurDeSaisie: M.valeurDeSaisie,
    valeurAEnvoyer,
    vuDuChamp: null,
    bienCourant: bien,
    idDuBien: 'b1',
    CSS: { escape: (x) => x },
    $: (sel) => {
      const m = sel.match(/data-champ="([^"]+)"/)
      return m ? (cases[m[1]] || null) : null
    },
    direEtat: (cible, quoi, texte) => etats.push([cible, quoi, texte]),
    enfiler: (f) => f(),
    t: (cle) => cle,
    logger: { error: () => {} },
    api: { bien: { modifier: async (id, corps) => {
      appels.push({ id, corps })
      if (erreur) throw erreur
      return reponse
    } } }
  }
  const src = `${fonctionDeLaPage('vuDuChamp')}\nvuDuChamp = vuDuChamp\n${fonctionDeLaPage('envoyerBloc')}`
  const ctx = vm.createContext(sandbox)
  vm.runInContext(src, ctx)
  // \u26a0 PAR COPIE, PAS PAR R\u00c9F\u00c9RENCE. Un objet n\u00e9 dans le contexte `vm` a le
  // prototype de CE realm : `deepEqual` le refuse contre un objet d'ici avec
  // \u00ab same structure but not reference-equal \u00bb, alors que tout est juste.
  const copie = (x) => JSON.parse(JSON.stringify(x))
  return { appels, etats, ctx, copie, lancer: (bloc) =>
    vm.runInContext('envoyerBloc({ dataset: { bloc: BLOC }, disabled: false })'
      .replace('BLOC', JSON.stringify(bloc)), ctx) }
}

const BIEN_PAGE = {
  nom: 'La bulle', capacite: 2, adresse: 'a', code_postal: '65200', ville: 'B', pays: 'FR',
  prix_de_base: 120, prix_plancher: 130, voyageurs_inclus: 2, supplement_voyageur: 15
}

test('LE TEST QUI COMPTE : le bloc part en UN SEUL appel, avec les champs CHANG\u00c9S', async () => {
  // Le serveur reconstruit le plan tarifaire une fois par appel : trois appels
  // feraient trois reconstructions, et la troisi\u00e8me lirait ce que la deuxi\u00e8me
  // a laiss\u00e9.
  const e = lancerEnvoi({ bien: BIEN_PAGE,
    saisies: { base_price: '149', included_guests: '3', extra_guest_fee: '15' } })
  await e.lancer('prix')
  assert.equal(e.appels.length, 1, 'UN seul appel pour tout le bloc')
  // Et le suppl\u00e9ment, inchang\u00e9, n'en fait pas partie : l'envoyer pour rien
  // reconstruirait la grille sans raison.
  assert.deepEqual(e.copie(e.appels[0].corps), { base_price: 149, included_guests: 3 })
  assert.equal(e.etats.at(-1)[1], 'enregistre')
})

test('LE TEST QUI COMPTE : un bloc ne touche QUE ses champs', async () => {
  // Le bouton de \u00ab Le logement \u00bb n'envoie pas les prix, et r\u00e9ciproquement.
  const e = lancerEnvoi({ bien: BIEN_PAGE, saisies: { capacity: '4', base_price: '149' } })
  await e.lancer('logement')
  assert.deepEqual(e.copie(e.appels[0].corps), { capacity: 4 })
})

test('cliquer sans rien avoir chang\u00e9 n appelle RIEN, et le dit', async () => {
  const e = lancerEnvoi({ bien: BIEN_PAGE, saisies: { base_price: '120', included_guests: '2' } })
  await e.lancer('prix')
  assert.equal(e.appels.length, 0)
  assert.deepEqual(e.copie(e.etats.at(-1).map(x => x === undefined ? null : x)), ['bloc:prix', 'rien', null])
})

test('LE TEST QUI COMPTE : une saisie qui n est pas un nombre n appelle pas le serveur', async () => {
  const e = lancerEnvoi({ bien: BIEN_PAGE, saisies: { base_price: 'cent', included_guests: '3' } })
  await e.lancer('prix')
  assert.equal(e.appels.length, 0, 'rien ne part tant qu une case est illisible')
  assert.equal(e.etats.at(-1)[1], 'erreur')
})

test('LE TEST QUI COMPTE : un refus remet les cases \u00e0 la valeur enregistr\u00e9e', async () => {
  const refus = Object.assign(new Error('grille_non_reconstructible'),
    { details: 'Ce logement n a pas de prix de base.' })
  const e = lancerEnvoi({ bien: BIEN_PAGE, saisies: { base_price: '149' }, erreur: refus })
  await e.lancer('prix')
  assert.equal(e.etats.at(-1)[2], 'Ce logement n a pas de prix de base.',
    'le DETAIL du refus, pas le code machine')
  // La case a repris la valeur du serveur : un refus laiss\u00e9 \u00e0 l'\u00e9cran se lirait
  // comme un envoi r\u00e9ussi.
  assert.equal(vm.runInContext('$(\'[data-champ="base_price"]\').value', e.ctx), '120')
})

test('LE TEST QUI COMPTE : ce que le serveur n a pas fait se dit, m\u00eame sur un 200', async () => {
  const e = lancerEnvoi({ bien: BIEN_PAGE, saisies: { base_price: '149' },
    reponse: { note: 'La grille n a pas ete reconstruite.' } })
  await e.lancer('prix')
  assert.equal(e.etats.at(-1)[2], 'La grille n a pas ete reconstruite.')
})

test('cliquer sans rien avoir chang\u00e9 le DIT, au lieu d appeler pour rien', () => {
  const fn = fonctionDeLaPage('envoyerBloc')
  assert.match(fn, /if \(!saisies\.length\) \{ direEtat\(cible, 'rien'\); return \}/)
})

test('LE TEST QUI COMPTE : un refus d envoi remet les cases \u00e0 la valeur enregistr\u00e9e', () => {
  const fn = fonctionDeLaPage('envoyerBloc')
  assert.match(fn, /direEtat\(cible, 'erreur', e\.details \|\| e\.message/)
  assert.match(fn, /input\.value = valeurDeSaisie\(champ, bienCourant\)/)
  // Et le bouton redevient cliquable quoi qu il arrive.
  assert.match(fn, /finally \{\s*bouton\.disabled = false/)
})

// \u2500\u2500\u2500 L'interrupteur de l'assistant, ex\u00e9cut\u00e9 pour de vrai \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function lancerBascule ({ enPause, accepte = true, erreur = null }) {
  const demandes = []
  const appels = []
  const sandbox = {
    bienCourant: { assistant_en_pause: enPause },
    idDuBien: 'b1',
    t: (cle) => cle,
    logger: { error: () => {} },
    $: () => null,
    majAssistant: (v) => appels.push(['maj', v]),
    direEtatBrut: (zone, quoi, texte) => appels.push(['etat', quoi, texte]),
    demander: async (opts) => { demandes.push(opts); return accepte },
    api: { bien: { pause: async (id, paused) => {
      appels.push(['pause', id, paused])
      if (erreur) throw erreur
      return { ok: true }
    } } }
  }
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fonctionDeLaPage('basculerAssistant'), ctx)
  const bouton = { dataset: { enPause: enPause ? '1' : '' }, disabled: false }
  sandbox.__bouton = bouton
  return { demandes, appels, bouton,
    lancer: () => vm.runInContext('basculerAssistant(__bouton)', ctx) }
}

test('LE TEST QUI COMPTE : COUPER l assistant se confirme, et un refus n appelle RIEN', async () => {
  // Couper arr\u00eate les messages et les codes d acc\u00e8s : c est une d\u00e9cision.
  const refuse = lancerBascule({ enPause: false, accepte: false })
  await refuse.lancer()
  assert.equal(refuse.demandes.length, 1, 'la confirmation doit \u00eatre demand\u00e9e')
  assert.equal(refuse.appels.filter(a => a[0] === 'pause').length, 0,
    'un refus ne doit RIEN envoyer')

  const accepte = lancerBascule({ enPause: false, accepte: true })
  await accepte.lancer()
  assert.equal(accepte.appels.filter(a => a[0] === 'pause').length, 1)
  assert.equal(accepte.appels.find(a => a[0] === 'pause')[2], true, 'on demande bien la PAUSE')
})

test('LE TEST QUI COMPTE : REPRENDRE ne se confirme pas \u2014 l inoffensif n apprend pas \u00e0 valider sans lire', async () => {
  const e = lancerBascule({ enPause: true })
  await e.lancer()
  assert.equal(e.demandes.length, 0, 'aucune question pour r\u00e9tablir l \u00e9tat normal')
  assert.equal(e.appels.find(a => a[0] === 'pause')[2], false)
  assert.ok(e.appels.some(a => a[0] === 'maj' && a[1] === false), 'l interrupteur suit')
})

test('LE TEST QUI COMPTE : un refus du serveur ne fait pas mentir l interrupteur', async () => {
  // Si le serveur refuse, l \u00e9tat affich\u00e9 ne doit pas bouger : un interrupteur
  // qui bascule sans que rien n ait chang\u00e9 est un mensonge qui survit au
  // rechargement suivant.
  const e = lancerBascule({ enPause: false, accepte: true,
    erreur: Object.assign(new Error('409'), { details: 'Bien pas encore synchronis\u00e9.' }) })
  await e.lancer()
  assert.equal(e.appels.filter(a => a[0] === 'maj').length, 0, 'l interrupteur ne bascule pas')
  const etat = e.appels.find(a => a[0] === 'etat')
  assert.equal(etat[1], 'erreur')
  assert.equal(etat[2], 'Bien pas encore synchronis\u00e9.')
  assert.equal(e.bouton.disabled, false, 'et le bouton redevient cliquable')
})
