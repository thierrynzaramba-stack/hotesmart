// tests/yf-bien-demande.test.js
// LE BIEN DEMANDE PAR L'URL — `?bien=<uuid>` sur les trois pages YieldFlow au
// menu, et `?activer=1` sur la Prediction de prix.
// Spec : docs/specs/spec-yf-bouton-calendrier.md §4 bis.
//
// ⚠ LE DEFAUT QU'ILS EMPECHENT, MESURE LE 28 OCTOBRE 2026 AVANT D'ECRIRE UNE
// LIGNE DE MENU : les trois pages remplissaient leur `<select>` de biens et
// ouvraient sur le PREMIER par ordre alphabetique. Aucune ne lisait de
// parametre d'URL. Un clic sur le bouton de « Coeur de vie 23 » aurait ouvert
// la Prediction de prix de « La bulle » — le menu aurait tenu sa promesse de
// navigation et trahi celle du BIEN.
//
// ⚠ ET LE VRAI SUJET N'EST PAS LA PRESELECTION, C'EST SA GARDE. Un identifiant
// inconnu — ou le bien d'un AUTRE compte — poserait sur le `<select>` une
// valeur qu'il ne porte pas : en HTML, `select.value = '<inconnu>'` laisse la
// valeur VIDE. L'ecran chargerait alors pour personne. `data.some(...)` est ce
// qui ferme ce cas, et c'est lui que ce fichier eprouve EN L'EXECUTANT.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')
const sansCommentaires = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ')

const PAGES = {
  'apps/yield/prix.html': 'yp-bien',
  'apps/yield/marche-global.html': 'mg-bien',
  'apps/yield/comparables.html': 'cp-bien'
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. LA GARDE EST LA, SUR LES TROIS PAGES
// ═══════════════════════════════════════════════════════════════════════════

for (const [page, id] of Object.entries(PAGES)) {
  test(`LE TEST QUI COMPTE : ${page} lit ?bien= AVEC sa garde`, () => {
    const src = sansCommentaires(lire(page))
    assert.match(src, /new URLSearchParams\(location\.search\)\.get\('bien'\)/,
      'la page ne lit pas le bien demande par l URL')
    // ⚠ LA GARDE, PAS SEULEMENT LA LECTURE. Sans `data.some(...)`, un bien
    // hors du compte viderait le selecteur — et c'est exactement le cas qu'un
    // membre delegue rencontre en premier.
    assert.match(src, new RegExp(
      "if \\(voulu && data\\.some\\(b => b\\.id === voulu\\)\\) el\\('" + id + "'\\)\\.value = voulu"),
    `la preselection de ${page} n est pas gardee par data.some(...)`)
  })
}

test('les trois pages posent la MEME garde : une copie qui derive est une page qui ment', () => {
  // Trois copies de deux lignes : le dépôt les tolère (les trois pages ont des
  // identifiants de selecteur differents), mais elles doivent rester
  // IDENTIQUES de forme. Ce test les compare entre elles.
  const formes = Object.entries(PAGES).map(([page, id]) => {
    const m = sansCommentaires(lire(page)).match(
      /const voulu = new URLSearchParams\(location\.search\)\.get\('bien'\)\s*\n\s*if \(voulu && data\.some\(b => b\.id === voulu\)\) el\('([\w-]+)'\)\.value = voulu/)
    assert.ok(m, `${page} : la forme attendue est introuvable`)
    assert.equal(m[1], id, `${page} : le selecteur vise n est pas ${id}`)
    return m[0].replace(id, '<SELECTEUR>')
  })
  assert.equal(new Set(formes).size, 1,
    'les trois copies de la garde ont divergé :\n' + formes.join('\n---\n'))
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. ET ON L'EXECUTE — sur `chargerBiens` de prix.html, la vraie fonction
// ═══════════════════════════════════════════════════════════════════════════

// ⚠ ON EXTRAIT LA VRAIE FONCTION, ON N'EN RECOPIE PAS LA LOGIQUE. Une copie
// ecrite ici serait un double plus permissif que le vrai : elle validerait du
// code qui ne peut pas tourner, et la mutation ne le verrait pas (meme double).
// L'extraction se fait par EQUILIBRE DES ACCOLADES, pas par une regex qui
// s'arrete au premier `}` venu.
function extraire (src, declaration) {
  const i = src.indexOf(declaration)
  assert.ok(i >= 0, `fonction introuvable : ${declaration}`)
  let j = src.indexOf('{', i)
  let profondeur = 0
  for (; j < src.length; j++) {
    if (src[j] === '{') profondeur++
    else if (src[j] === '}') { profondeur--; if (!profondeur) return src.slice(i, j + 1) }
  }
  throw new Error(`accolades desequilibrees : ${declaration}`)
}

const BIENS = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Ofuro Futari' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'La bulle' }
]

// Monte `chargerBiens` de prix.html dans un vrai DOM, avec l'URL demandee.
async function chargerAvec (recherche, biens = BIENS) {
  const fn = extraire(lire('apps/yield/prix.html'), 'async function chargerBiens ()')
  const dom = new JSDOM('<select id="yp-bien"></select>',
    { runScripts: 'outside-only', url: 'https://exemple.test/apps/yield/prix' + recherche })
  const { window } = dom
  const vu = { etat: null }
  window.__ctx = {
    el: (id) => window.document.getElementById(id),
    ech: (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    compteCourant: () => 'U1',
    etat: (m, e) => { vu.etat = { m, e } },
    supabase: { from: () => ({ select: () => ({ order: () => ({ eq: async () => ({ data: biens, error: null }) }) }) }) }
  }
  window.eval('const { el, ech, compteCourant, etat, supabase } = window.__ctx\n'
    + fn + '\nwindow.__chargerBiens = chargerBiens')
  const ok = await window.__chargerBiens()
  return { ok, select: window.document.getElementById('yp-bien'), vu, fermer: () => window.close() }
}

test('LE TEST QUI COMPTE : un bien connu est preselectionne', async () => {
  const r = await chargerAvec('?bien=' + BIENS[1].id)
  assert.equal(r.ok, true)
  assert.equal(r.select.value, BIENS[1].id,
    'le menu du calendrier doit ouvrir la page DU bien clique')
  // Et ce n'est pas le defaut : sans parametre, le premier l'emporte.
  assert.notEqual(BIENS[1].id, BIENS[0].id)
  r.fermer()
})

test('LE TEST QUI COMPTE : un bien INCONNU laisse le selecteur inchange', async () => {
  // ⚠ REGLE 19 — CELUI-CI NE PEUT PAS ROUGIR CONTRE LE CODE D'AVANT, et il
  // faut le dire : avant ce lot, la page ne preselectionnait RIEN, donc le
  // selecteur etait deja « inchange ». Il passerait pour une raison qui n'est
  // pas la sienne. Sa contre-epreuve se fait par MUTATION, et elle est faite :
  // remplacer la garde par `if (voulu) el('yp-bien').value = voulu` le fait
  // rougir (mesure du 28 octobre 2026, hors de l'arbre).
  //
  // ⚠ LE CAS QUI COMPTE VRAIMENT : un bien d'un AUTRE compte. Sans la garde,
  // `select.value = '<inconnu>'` rend la valeur VIDE et la page charge pour
  // personne — un ecran blanc dont personne ne sait pourquoi il est blanc.
  const sans = await chargerAvec('')
  const defaut = sans.select.value
  sans.fermer()
  assert.equal(defaut, BIENS[0].id, 'sans parametre : le premier bien, comme avant ce lot')

  for (const cas of ['?bien=cccccccc-cccc-4ccc-8ccc-cccccccccccc', '?bien=pas-un-uuid', '?bien=']) {
    const r = await chargerAvec(cas)
    assert.equal(r.select.value, defaut, `${cas} : le selecteur a bouge`)
    assert.notEqual(r.select.value, '', `${cas} : le selecteur est VIDE — la garde n a pas mordu`)
    r.fermer()
  }
})

test('la garde ne depend pas de l ORDRE : un bien demande en derniere position est trouve', async () => {
  const r = await chargerAvec('?bien=' + BIENS[1].id, [BIENS[0], { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Z' }, BIENS[1]])
  assert.equal(r.select.value, BIENS[1].id)
  r.fermer()
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. `?activer=1` OUVRE, IL N'ACTIVE JAMAIS
// ═══════════════════════════════════════════════════════════════════════════

test("LE TEST QUI COMPTE : ?activer=1 ouvre la CONFIRMATION, il n'ecrit rien", () => {
  const src = sansCommentaires(lire('apps/yield/prix.html'))
  assert.match(src, /activerDemande = new URLSearchParams\(location\.search\)\.get\('activer'\) === '1'/,
    'le parametre n est pas lu')

  // Le bloc qui consomme la demande, isole pour etre juge sur SON contenu.
  const i = src.indexOf('if (activerCeBien) {')
  assert.ok(i > 0, 'le bloc qui consomme la demande est introuvable')
  const bloc = extraire(src.slice(i), 'if (activerCeBien) {')

  // ⚠ IL APPELLE LA CONFIRMATION, PAS LA BASCULE. `confirmerBascule` ouvre le
  // parcours — fenetre obligatoire, compte des nuits releu SERVEUR, bouton
  // inerte avant le compte. `basculerPilote` ECRIT. Les confondre ferait
  // exactement ce que la decision du 22 septembre 2026 interdit.
  assert.match(bloc, /confirmerBascule\('yieldflow'\)/,
    'le parametre doit OUVRIR le parcours d activation existant')
  assert.doesNotMatch(bloc, /basculerPilote\(/,
    'JAMAIS de bascule en un clic : le parametre n ecrit rien')
  assert.doesNotMatch(bloc, /fetch\(|appel\(/,
    'aucun appel reseau ne part de la lecture du parametre')

  // ⚠ LA DEMANDE SE CONSOMME HORS DE CE BLOC — correctif de la review du
  // 28 octobre 2026. Elle etait eteinte DANS le `if`, donc DEUX chemins
  // l'esquivaient : le retour sur bien absent, et le `catch` du « reglage
  // illisible ». Un 503 laissait la demande ARMEE, et la confirmation
  // d'activation s'ouvrait plus tard TOUTE SEULE, sur un `change` du
  // selecteur — pas sur un clic de l'hote.
  // ⚠ ET MON TEST NE POUVAIT PAS LE VOIR : le banc n'evalue que le bloc
  // INTERIEUR, avec la demande posee a la main. Il etait structurellement
  // aveugle aux retours exterieurs — exactement la forme decrite par la
  // regle 22 de REVIEW.md, prise en defaut dans le lot qui l'a ecrite.
  // On garde donc la PLACE de l'extinction, au niveau de la fonction.
  assert.doesNotMatch(bloc, /activerDemande = false/,
    'l extinction ne doit plus vivre dans ce bloc : deux chemins l esquivaient')
  const fn = src.slice(src.indexOf('async function chargerPilote'), src.indexOf('function confirmerBascule'))
  const iPrise = fn.indexOf('const activerCeBien = activerDemande')
  const iEteint = fn.indexOf('activerDemande = false')
  const iRetour = fn.indexOf('if (!bien) {')
  const iCatch = fn.indexOf('catch')
  assert.ok(iPrise > 0 && iEteint > iPrise, 'la demande se prend, puis s eteint')
  assert.ok(iRetour > 0 && iEteint < iRetour, 'AVANT le retour sur bien absent')
  assert.ok(iCatch > 0 && iEteint < iCatch, 'et AVANT le catch du « reglage illisible »')
  // ⚠ ET INCONDITIONNELLEMENT — une mutation l'a montre : ma premiere version
  // ne gardait que la PLACE, donc `if (!bien) activerDemande = false` passait
  // au vert tout en reouvrant exactement le defaut (la demande survivait au
  // 503). Le geste doit etre nu : une affectation seule sur sa ligne, juste
  // apres la prise.
  assert.match(fn, /const activerCeBien = activerDemande\s*\n\s*activerDemande = false\s*\n/,
    'l extinction doit suivre la prise, seule sur sa ligne et sans condition')

  // Les QUATRE refus. Le comportement est eprouve par le test suivant, qui
  // execute le bloc ; ici on garde que la condition les porte tous les quatre,
  // dans le meme `if` — les separer en deux laisserait un chemin ouvert.
  assert.match(bloc, /if \(voulu && voulu === affiche && !yf && !bloque\)/,
    'la condition doit exiger : un bien DESIGNE, qui soit celui AFFICHE, non pilote, et basculable')
})

test("LE TEST QUI COMPTE : ?activer=1 n'ouvre RIEN si le bien affiche n'est pas celui demande", async () => {
  // ⚠ CONSTAT DE LA REVIEW DU 28 OCTOBRE 2026, ET C'EST LE PLUS GRAVE DU LOT.
  // La garde de `chargerBiens` protege le SELECTEUR : un `?bien=` inconnu le
  // laisse sur le PREMIER logement. Elle ne protegeait pas l'ACTIVATION, qui
  // s'ouvrait quand meme — sur ce premier logement.
  //
  // Le scenario : l'hote clique « Activer le pilote automatique » dans le menu
  // du calendrier pour « La bulle » ; entre-temps le bien a quitte le compte,
  // ou l'URL est un favori perime. prix.html garde « Coeur de vie 23 »
  // selectionne et ouvre la confirmation d'activation pour CELUI-LA. Un clic
  // de plus — `basculerPilote` poste `el('yp-bien').value` — et c'est le
  // mauvais logement qui passe sous YieldFlow, et qui se met a pousser des
  // prix au canal.
  //
  // ON EXECUTE LE VRAI BLOC, extrait de la page par equilibre des accolades.
  const src = sansCommentaires(lire('apps/yield/prix.html'))
  const bloc = extraire(src, 'if (activerCeBien) {')

  const essai = ({ recherche, affiche, yf = false, bloque = false }) => {
    const dom = new JSDOM(`<select id="yp-bien"><option value="${BIENS[0].id}">A</option><option value="${BIENS[1].id}">B</option></select>`,
      { runScripts: 'outside-only', url: 'https://exemple.test/apps/yield/prix' + recherche })
    const { window } = dom
    window.document.getElementById('yp-bien').value = affiche
    const vu = []
    window.__ctx = {
      el: (id) => window.document.getElementById(id),
      confirmerBascule: (v) => vu.push(v),
      yf, bloque
    }
    window.eval('const { el, confirmerBascule, yf, bloque } = window.__ctx\n'
      + 'const activerCeBien = true\n' + bloc + '\nwindow.__vu = false')
    const consommee = window.__vu === false
    window.close()
    return { ouvertures: vu, consommee }
  }

  // Le cas normal : le bien demande EST celui affiche -> le parcours s'ouvre.
  const bon = essai({ recherche: '?bien=' + BIENS[1].id + '&activer=1', affiche: BIENS[1].id })
  assert.deepEqual(bon.ouvertures, ['yieldflow'], 'le parcours doit s ouvrir sur le bien demande')

  // ⚠ LES QUATRE CAS QUI NE DOIVENT RIEN OUVRIR.
  const refus = [
    ['bien inconnu, le selecteur est reste sur le premier',
      { recherche: '?bien=cccccccc-cccc-4ccc-8ccc-cccccccccccc&activer=1', affiche: BIENS[0].id }],
    ['aucun bien designe',
      { recherche: '?activer=1', affiche: BIENS[0].id }],
    ['bien deja pilote',
      { recherche: '?bien=' + BIENS[1].id + '&activer=1', affiche: BIENS[1].id, yf: true }],
    ['bascule refusee par le serveur',
      { recherche: '?bien=' + BIENS[1].id + '&activer=1', affiche: BIENS[1].id, bloque: true }]
  ]
  for (const [quoi, cas] of refus) {
    const r = essai(cas)
    assert.deepEqual(r.ouvertures, [], `${quoi} : un parcours d activation s est ouvert`)
    // ⚠ ET LA DEMANDE EST CONSOMMEE DANS TOUS LES CAS : armee, elle
    // s'ouvrirait plus tard sur le bien que l'hote choisirait au selecteur.
    assert.equal(r.consommee, true, `${quoi} : la demande est restee armee`)
  }
})

test("le parcours d'activation garde ses deux confirmations, quelle que soit la porte", () => {
  // ⚠ REGLE 19 — NON-REGRESSION ASSUME : il est VERT contre le code d'avant,
  // et c'est son objet. Il ne garde pas un correctif, il garde un acquis.
  //
  // ⚠ CE QUE CE TEST PROTEGE N'EST PAS MON CODE, C'EST CELUI D'AVANT : le
  // parcours que `?activer=1` emprunte doit rester celui qui compte les nuits
  // SERVEUR. Le jour ou quelqu'un simplifierait `confirmerBascule` en bascule
  // directe, l'entree du calendrier deviendrait un interrupteur.
  const src = sansCommentaires(lire('apps/yield/prix.html'))
  const fn = extraire(src, 'function confirmerBascule (voulu)')
  assert.match(fn, /demanderFenetre\(\)/,
    'activer passe par la fenetre obligatoire (lot 4.6.3)')
  assert.doesNotMatch(fn, /basculerPilote\('yieldflow'\)/,
    'confirmerBascule ne doit JAMAIS basculer directement vers yieldflow')
})
