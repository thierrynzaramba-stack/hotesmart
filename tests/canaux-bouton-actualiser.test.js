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

// Les six fonctions du geste, telles qu'elles sont dans la page.
const SOURCE = ['bandeauEchec', 'montrerEchecDuReleve', 'cacherEchecDuReleve',
                'relever', 'boutonActualiser', 'bindActualiserCanaux']
  .map(fonctionDeLaPage).join('\n\n')

function monter ({ reponse, leve = null, vuLe = 'frais' }) {
  const dom = new JSDOM(`<div id="canaux-echec" class="bandeau-echec" hidden></div>
    <div class="property-card"><div data-channels></div></div>`)
  const { document } = dom.window
  const appels = []
  const journal = []
  let recharge = 0
  const bac = new Function('document', 'fraicheurCanaux', 'MOT_ECHEC', 'callApi',
                           'logger', 'location', `
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
    { error: (...a) => journal.push(a) },
    { reload: () => { recharge++ } }
  )
  const card = document.querySelector('.property-card')
  return { ...bac, document, card, zone: card.querySelector('[data-channels]'),
           bandeau: document.getElementById('canaux-echec'),
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
  assert.equal(m.bandeau.hidden, true, 'un effacement suspendu a affiche une erreur a l hote')
  assert.deepEqual(m.journal, [], 'un effacement suspendu a ete journalise comme un echec')
  assert.equal(m.recharges(), 1, 'la page n a pas recharge : l hote ne voit pas son geste aboutir')
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
