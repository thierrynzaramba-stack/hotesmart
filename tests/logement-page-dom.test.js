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

function monter ({ reponse = null, erreur = null, peutEcrireReglages = true, chemin = '/logements/b1' } = {}) {
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
    peutEcrire: (domaine) => {
      assert.equal(domaine, 'reglages', 'la suppression dépend du domaine `reglages`')
      return peutEcrireReglages
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

test('LECTURE SEULE : la page n appelle aucune écriture, et aucun endpoint partenaire', () => {
  const script = PAGE.slice(PAGE.indexOf('<script type="module">'))
  for (const motif of [/api\.\w+\.(creer|modifier|supprimer|patch|post|delete)/i,
    /method:\s*'(POST|PATCH|DELETE|PUT)'/, /channel-property/, /beds24/i, /channex/i]) {
    assert.doesNotMatch(script, motif, `l étape 2 est en lecture seule : ${motif}`)
  }
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
