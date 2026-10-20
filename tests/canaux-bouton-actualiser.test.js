// tests/canaux-bouton-actualiser.test.js
// LE RELEVE A LA DEMANDE, DANS LE VRAI DOM, AVEC LE VRAI CODE DE LA PAGE.
//
// ⚠ POURQUOI CE FICHIER EXISTE. Recette du 19 octobre 2026 : un releve a
// echoue et le bouton n'a rien dit. L'endpoint rend 200 MEME en echec — c'est
// voulu, l'ecran a deja ses canaux — mais la page rechargeait sur tout 200 :
// l'hote voyait sa page clignoter et revenir identique, sans un mot. Et le
// `logger.error` de secours n'ecrit dans la console que sur localhost, donc en
// ligne il ne laissait AUCUNE trace. Une heure de diagnostic.
//
// ⚠ ON EXECUTE LE VRAI CODE DE LA PAGE, pas une copie : il est extrait de
// pages/biens.html. Une copie divergerait au premier correctif.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const FICHIER = path.join(__dirname, '..', 'pages', 'biens.html')
const PAGE = fs.readFileSync(FICHIER, 'utf8')

// Extrait une fonction de la page en comptant ses accolades.
//
// ⚠ LE `async` FAIT PARTIE DE LA FONCTION. Chercher `function <nom> (` tombe au
// milieu de `async function <nom> (` et le perdait : `relever` devenait
// synchrone et ses `await` ne compilaient plus. Une premiere version
// compensait en rendant TOUT async — et `bandeauEchec()` rendait alors une
// promesse, donc `z.innerHTML` levait. On prend la declaration telle quelle.
function fonctionDeLaPage (nom) {
  let debut = PAGE.indexOf(`function ${nom} (`)
  assert.notEqual(debut, -1, `${nom} introuvable dans pages/biens.html`)
  const avant = PAGE.slice(Math.max(0, debut - 6), debut)
  if (avant === 'async ') debut -= 6
  let p = 0
  for (let j = PAGE.indexOf('{', debut); j < PAGE.length; j++) {
    if (PAGE[j] === '{') p++
    else if (PAGE[j] === '}') { p--; if (p === 0) return PAGE.slice(debut, j + 1) }
  }
  throw new Error(`accolades non refermees pour ${nom}`)
}

// Le verrou de la page, extrait lui aussi : le redeclarer dans le test en
// ferait une copie, et le test resterait vert si la page le perdait.
function declarationDeLaPage (nom) {
  const m = PAGE.match(new RegExp('^\\s*let\\s+' + nom + '\\s*=.*$', 'm'))
  assert.ok(m, `declaration de ${nom} introuvable dans pages/biens.html`)
  return m[0].trim()
}

// Les fonctions du geste, telles qu'elles sont dans la page.
const SOURCE = [declarationDeLaPage('releveEnVol')].concat(
  ['bandeauEchec', 'direAuBandeau', 'montrerEchecDuReleve',
   'cacherEchecDuReleve', 'relever', 'boutonActualiser',
   'bindActualiserCanaux'].map(fonctionDeLaPage)).join('\n\n')

// ⚠ ET LA FEUILLE DE STYLE DE LA PAGE, DANS LE DOM DE TEST. Sans elle, un test
// qui asserte `bandeau.hidden === true` est vert alors que le bandeau est
// VISIBLE : `/biens` ne charge pas shared/ui.css, donc rien n'y applique
// `[hidden] { display: none }`, et une declaration d'auteur comme
// `display: flex` l'emporte sur la feuille du navigateur. Mesure de la revue de
// 6754f48 : un cadre vide affiche en permanence au-dessus de la liste.
const STYLE = (PAGE.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1]

function monter ({ reponse, leve = null, vuLe = 'frais' }) {
  const dom = new JSDOM(`<html><head><style>${STYLE}</style></head><body>
    <a class="btn btn-primary" id="btn-ajouter-bien" hidden>+ Ajouter un bien</a>
    <div id="canaux-echec" class="bandeau-echec" role="status" aria-live="polite" hidden></div>
    <div class="property-card"><div class="channel-badges" data-channels></div></div>
    </body></html>`)
  const { document } = dom.window
  const appels = []
  const journal = []
  let recharge = 0
  const bac = new Function('document', 'fraicheurCanaux', 'MOT_ECHEC', 'callApi',
                           'console', 'location', `
    ${SOURCE}
    return { montrerEchecDuReleve, cacherEchecDuReleve, bindActualiserCanaux,
             boutonActualiser }
  `)(
    document,
    // La regle de fraicheur a ses propres tests : on injecte son verdict, pour
    // eprouver la DECISION du bouton et rien d'autre.
    () => (vuLe === null ? null : { texte: 'peu importe', vieux: vuLe === 'vieux' }),
    'Vérification impossible pour l\'instant',
    async (m, body) => {
      appels.push([m, body])
      if (leve) throw new Error(leve)
      return reponse
    },
        // ⚠ `console`, PAS `logger`, ET LA RAISON A CHANGE. Elle etait : « le
    // gestionnaire d'erreurs allume une barre noire dont le motif technique
    // brut, et l'hote lisait deux messages pour une panne ». Depuis le
    // 20 octobre 2026, cette barre ne montre plus qu'une phrase generique, et
    // elle ignore les 401/403/404 attendus. On garde `console` ici pour une
    // autre raison, plus simple : ce fichier eprouve le RENDU, et un double de
    // `logger` y ajouterait une dependance sans rien mesurer de plus.
    { error: (...a) => journal.push(a) },
    { reload: () => { recharge++ } }
  )
  const card = document.querySelector('.property-card')
  return { ...bac, document, card, zone: card.querySelector('[data-channels]'),
           bandeau: document.getElementById('canaux-echec'),
           visible: (el) => dom.window.getComputedStyle(el).display !== 'none',
           appels, journal, recharges: () => recharge }
}

const attendre = async () => { await null; await null; await null }

// ─── Quand le bouton apparait, et ou ────────────────────────────────────────

test('un releve frais n offre AUCUN bouton sous le bien', () => {
  const m = monter({ vuLe: 'frais', reponse: { ok: true } })
  m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
  assert.equal(m.zone.querySelector('.btn-actualiser'), null,
    'un bouton est propose alors qu il n y a rien a actualiser')
})

test('un releve de plus de 24 h offre le bouton sous le bien', () => {
  const m = monter({ vuLe: 'vieux', reponse: { ok: true } })
  m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
  assert.ok(m.zone.querySelector('.btn-actualiser'))
})

test('LE TEST QUI COMPTE : le message d echec est UNIQUE et porte son bouton', async () => {
  // Le releve est au grain du compte : un message, un bouton, en haut de page.
  const m = monter({ vuLe: 'frais', reponse: { ok: true } })
  m.montrerEchecDuReleve('injoignable')
  assert.equal(m.bandeau.hidden, false, 'le bandeau est reste cache')
  assert.match(m.bandeau.textContent, /impossible/)
  assert.equal(m.document.querySelectorAll('.bandeau-echec').length, 1)
  assert.ok(m.bandeau.querySelector('.btn-actualiser'),
    'le message ne porte pas de bouton : l hote lit la panne sans pouvoir reessayer')
  // Et le bouton du bandeau fait la meme chose que celui d une carte.
  m.bandeau.querySelector('.btn-actualiser').click()
  await attendre()
  assert.deepEqual(m.appels[0], ['POST', { action: 'relever_canaux' }])
})

test('une lecture reussie efface le message', () => {
  const m = monter({ reponse: { ok: true } })
  m.montrerEchecDuReleve('injoignable')
  m.cacherEchecDuReleve()
  assert.equal(m.bandeau.hidden, true, 'le message survit a une lecture reussie')
  assert.equal(m.bandeau.textContent, '')
})

// ─── Ce que le clic fait du resultat ────────────────────────────────────────

test('LE TEST QUI COMPTE : un 200 qui dit `ok: false` ne recharge PAS et DIT le motif', async () => {
  const m = monter({ vuLe: 'vieux', reponse: { ok: false, motif: 'injoignable' } })
  m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
  m.zone.querySelector('.btn-actualiser').click()
  await attendre()
  assert.equal(m.recharges(), 0, 'la page a recharge sur un echec : le motif est perdu')
  assert.equal(m.bandeau.hidden, false, 'aucun message affiche a l hote')
  const b = m.zone.querySelector('.btn-actualiser')
  assert.equal(b.disabled, false, 'le bouton reste desactive : l hote ne peut plus reessayer')
  assert.equal(b.textContent, 'Actualiser')
  assert.equal(m.journal.length, 1, 'l echec n est pas journalise')
})

test('LE TEST QUI COMPTE : un effacement `suspendu` ne montre AUCUNE erreur a l hote', async () => {
  // ⚠ LA DISTINCTION DEMANDEE PAR THIERRY. Le disjoncteur rend `ok: false`
  // pour que le cron et l'alarme le voient, mais la lecture a REUSSI : rien
  // d'anormal pour l'hote. « Verification impossible » est reserve a un vrai
  // echec de lecture.
  const m = monter({ vuLe: 'vieux', reponse: { ok: false, motif: 'suspendu' } })
  m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
  m.zone.querySelector('.btn-actualiser').click()
  await attendre()
  // ⚠ ET L'HOTE N'EST PAS LAISSE SANS REPONSE. Dans ce cas, `vu_le` n'avance
  // pas — la lecture a reussi mais elle ne CONFIRME pas les pastilles
  // affichees. Recharger lui rendait donc une page identique, sans un mot :
  // exactement le defaut qu'on corrige. On le lui dit, en neutre.
  assert.equal(m.recharges(), 0, 'la page a recharge pour revenir a l identique, sans un mot')
  assert.equal(m.bandeau.hidden, false, 'l hote n a aucun retour a son geste')
  assert.ok(!/impossible/.test(m.bandeau.textContent),
    'un effacement suspendu est annonce comme une panne')
  assert.ok(m.bandeau.classList.contains('is-neutre'),
    'le mot du disjoncteur est affiche comme une erreur')
})

test('un 200 qui dit `ok: true` recharge, et ne laisse aucun message', async () => {
  const m = monter({ vuLe: 'vieux', reponse: { ok: true, canaux: 2, disparus: 0 } })
  m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
  m.zone.querySelector('.btn-actualiser').click()
  await attendre()
  assert.equal(m.recharges(), 1, 'la page n a pas recharge apres un releve reussi')
  assert.equal(m.bandeau.hidden, true)
})

test('une requete qui leve dit aussi le motif a l hote', async () => {
  const m = monter({ vuLe: 'vieux', reponse: null, leve: 'Erreur 503' })
  m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
  m.zone.querySelector('.btn-actualiser').click()
  await attendre()
  assert.equal(m.recharges(), 0)
  assert.equal(m.bandeau.hidden, false, 'une exception reste muette pour l hote')
  assert.equal(m.zone.querySelector('.btn-actualiser').disabled, false)
})

// ─── La zone de clic ────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : la zone de clic du bouton fait au moins 44 px', () => {
  // ⚠ CE QUE CE TEST PEUT ET NE PEUT PAS FAIRE. jsdom ne calcule aucune mise
  // en page : il n'y a pas de hauteur reelle a mesurer ici. On lit donc la
  // GEOMETRIE DECLAREE de la regle `.btn-actualiser` — `min-height`, et a
  // defaut le remplissage vertical plus la hauteur de ligne — et on verifie
  // qu'elle atteint 44 px. Mesure du 19 octobre : 74 x 19 px, a la limite du
  // cliquable, pour le seul geste de cet ecran.
  const bloc = PAGE.match(/\.btn-actualiser\s*\{([^}]*)\}/)
  assert.ok(bloc, 'la regle .btn-actualiser a disparu de la page')
  const regle = bloc[1]
  const px = (prop) => {
    const m = regle.match(new RegExp(prop + '\\s*:\\s*([0-9.]+)px'))
    return m ? Number(m[1]) : null
  }
  const minH = px('min-height')
  const padV = (() => {
    const m = regle.match(/padding\s*:\s*([0-9.]+)px/)
    return m ? Number(m[1]) * 2 : 0
  })()
  const hauteur = Math.max(minH || 0, padV + 14)   // 14 px : hauteur de ligne du texte
  assert.ok(hauteur >= 44,
    `zone de clic declaree a ${hauteur} px, il en faut 44 (min-height=${minH}, padding vertical=${padV})`)
})

// ─── Les trous trouves par la revue de 6754f48 ──────────────────────────────

test('LE TEST QUI COMPTE : le bandeau est VRAIMENT masque quand il est vide', () => {
  // ⚠ CE TEST EXISTE PARCE QUE `hidden` NE MASQUAIT RIEN. `/biens` ne charge
  // pas shared/ui.css, seule feuille du depot a porter
  // `[hidden] { display: none }`, et une declaration d'auteur comme
  // `display: flex` l'emporte toujours sur la feuille du NAVIGATEUR : la
  // specificite ne se compare pas entre origines. L'hote voyait donc un cadre
  // borde VIDE au-dessus de sa liste, a chaque visite, et
  // `cacherEchecDuReleve` ne le faisait pas partir.
  //
  // Asserter `bandeau.hidden === true` ne prouve RIEN : c'est l'attribut. On
  // mesure le `display` effectif, feuille de la page chargee.
  const m = monter({ reponse: { ok: true } })
  assert.equal(m.visible(m.bandeau), false, 'le bandeau vide est visible')
  m.montrerEchecDuReleve('injoignable')
  assert.equal(m.visible(m.bandeau), true, 'le bandeau ne s affiche pas quand il porte un message')
  m.cacherEchecDuReleve()
  assert.equal(m.visible(m.bandeau), false, 'le bandeau reste visible apres avoir ete vide')
})

test('LE TEST QUI COMPTE : un 200 SANS `ok` ne recharge pas', async () => {
  // Un 200 dont le corps n'est pas du JSON donne `{}` au client : la garde
  // `r.ok === false` ne mordait pas, et la page rechargeait en silence. Le
  // defaut du guard de channelCall, par la porte du navigateur.
  for (const reponse of [{}, { motif: 'x' }, { ok: null }]) {
    const m = monter({ vuLe: 'vieux', reponse })
    m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
    m.zone.querySelector('.btn-actualiser').click()
    await attendre()
    assert.equal(m.recharges(), 0,
      `la page a recharge sur ${JSON.stringify(reponse)}`)
    assert.equal(m.bandeau.hidden, false, 'aucun message sur une reponse sans `ok`')
  }
})

test('LE TEST QUI COMPTE : deux boutons, un seul releve en vol', async () => {
  // Il y a deux boutons — celui d'une carte de plus de 24 h et celui du
  // bandeau — et chacun ne desactivait que lui-meme : deux clics lancaient
  // deux lectures du partenaire hors cadence, et deux `noterLeReleve` en
  // lecture-puis-ecriture sur la meme ligne, ou l'increment du compteur
  // d'echecs se perd.
  const m = monter({ vuLe: 'vieux', reponse: { ok: false, motif: 'injoignable' } })
  m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
  m.montrerEchecDuReleve('injoignable')
  const deux = [...m.document.querySelectorAll('.btn-actualiser')]
  assert.equal(deux.length, 2, 'le decor du test n a pas deux boutons')
  deux[0].click()
  deux[1].click()
  await attendre()
  assert.equal(m.appels.length, 1,
    `${m.appels.length} appels au partenaire pour deux clics simultanes`)
})

test('le bouton du bandeau est reactive apres un echec, celui de la carte aussi', async () => {
  const m = monter({ vuLe: 'vieux', reponse: { ok: false, motif: 'injoignable' } })
  m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
  m.zone.querySelector('.btn-actualiser').click()
  await attendre()
  for (const b of m.document.querySelectorAll('.btn-actualiser')) {
    assert.equal(b.disabled, false, 'un bouton est reste desactive apres l echec')
  }
})

// ─── Les constats de la re-revue ────────────────────────────────────────────

test('LE TEST QUI COMPTE : le bouton masque par DROIT est vraiment masque', () => {
  // ⚠ CE GARDE-FOU N'AVAIT AUCUN FILET. « + Ajouter un bien » est masque par
  // `btn.hidden = !estTitulaireCourant` — « sinon la creation partirait sur le
  // compte du MEMBRE » —, et `.btn { display: inline-flex }` le rendait
  // VISIBLE et cliquable pour un membre delegue, faute de regle `[hidden]` sur
  // une page qui ne charge pas shared/ui.css.
  //
  // La regle globale `[hidden] { … !important }` corrige le vrai navigateur
  // mais jsdom ignore `!important` : seul le selecteur compose `.btn[hidden]`
  // est mesurable ici. Constat de la re-revue.
  const m = monter({ reponse: { ok: true } })
  const b = m.document.getElementById('btn-ajouter-bien')
  assert.equal(m.visible(b), false,
    'le bouton reserve au titulaire est visible : un membre delegue peut cliquer')
  b.hidden = false
  assert.equal(m.visible(b), true, 'le bouton ne reapparait pas pour un titulaire')
})

test('LE TEST QUI COMPTE : le plancher de cadence ne recharge pas pour rien', async () => {
  // Le serveur refuse un second relevé dans la minute. Rendu sans motif, ce
  // 200 faisait recharger la page pour la rendre identique, sans un mot : le
  // defaut meme qu'on corrige, par la porte du plancher de cadence.
  const m = monter({ vuLe: 'vieux', reponse: { ok: true, motif: 'cadence', canaux: 0, disparus: 0 } })
  m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
  m.zone.querySelector('.btn-actualiser').click()
  await attendre()
  assert.equal(m.recharges(), 0, 'la page a recharge sur un refus de cadence')
  assert.equal(m.bandeau.hidden, false, 'l hote n a aucun retour a son geste')
  assert.ok(m.bandeau.classList.contains('is-neutre'),
    'un refus de cadence est annonce comme une panne')
  assert.equal(m.bandeau.textContent.includes('Vérification faite'), true,
    'le mot neutre attendu n est pas affiche : ' + m.bandeau.textContent)
})

test('le mot neutre dit « Vérification faite », et rien de plus', async () => {
  // ⚠ DEMANDE DE THIERRY : « rien n'a change » n'est pas exact — on ne sait pas
  // si quelque chose a change, on sait que la verification a eu lieu.
  for (const motif of ['suspendu', 'cadence']) {
    const reponse = motif === 'suspendu'
      ? { ok: false, motif } : { ok: true, motif }
    const m = monter({ vuLe: 'vieux', reponse })
    m.bindActualiserCanaux(m.card, { canaux_vu_le: 'x' })
    m.zone.querySelector('.btn-actualiser').click()
    await attendre()
    assert.equal(m.bandeau.textContent.replace('Actualiser', '').trim(), 'Vérification faite',
      `le mot du cas « ${motif} » n est pas celui attendu`)
  }
})
