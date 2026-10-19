// tests/reponse-partenaire-execution.test.js
// LES DIX-SEPT COPIES, EXECUTEES — PAS RELUES.
//
// ⚠ POURQUOI CE FICHIER EXISTE, ET C'EST UNE DEMANDE DE THIERRY. Les dix-sept
// `channelCall` ont ete branchees par un patch quasi mecanique, puis verifiees
// EN LECTURE : par une revue, puis par un test qui controle que les
// identifiants nommes sont declares. Et c'est exactement ce qui a laisse passer
// le defaut de `api/channel-connect.js` — une lecture l'avait valide.
//
// Ici, on EXECUTE. Pour chaque copie, la vraie fonction est extraite du
// fichier, montee avec un `fetch` simule et une surveillance espionnee, et on
// verifie les deux promesses, dans les deux cas :
//
//   JSON sain    -> valeur rendue IDENTIQUE a celle du code d'avant, 0 incident
//   200 + HTML   -> valeur rendue IDENTIQUE a celle du code d'avant, 1 incident
//
// ⚠ « IDENTIQUE » SE MESURE, IL NE SE SUPPOSE PAS. On ne compare pas a une
// valeur ecrite a la main : on monte DEUX FOIS la meme fonction — une fois
// telle quelle, une fois avec la ligne de surveillance RETIREE — et on compare
// les deux retours. C'est la seule facon de prouver « on ne change rien ».

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')

// Les seize copies qui portent une fonction `channelCall`. `api/channel-connect.js`
// n'en a pas — c'est un `fetch` EN LIGNE dans son handler — et il a son propre
// test plus bas.
const COPIES = [
  'api/calendar.js', 'api/channel-airbnb-connect.js', 'api/channel-bcom-activate.js',
  'api/channel-bcom-write.js', 'api/channel-bcom.js', 'api/channel-events.js',
  'api/channel-mapping.js', 'api/channel-property.js', 'api/channel-rateplan.js',
  'api/channel-webhook.js', 'api/diagnostic.js', 'lib/channel-availability.js',
  'lib/channel-fullsync.js', 'lib/cron-channel-feed.js', 'lib/cron-channel-reviews.js',
  'lib/channels/channex.js'
]

// ⚠ LE TEMOIN EST LE CODE D'AVANT LE CHANTIER, PAS « LE MEME SANS LA LIGNE ».
// Une premiere version comparait le montage AVEC surveillance a un montage ou
// la ligne d'observation etait retiree. Une mutation qui touche les DEUX — par
// exemple un champ ajoute a la valeur rendue — y etait invisible par
// construction : contre-epreuve faite, elle ne rougissait pas. Le temoin juste
// est la fonction telle qu'elle etait AVANT le branchement, lue dans git.
const AVANT = '4dada3e^'

// ⚠ UN TEMOIN FIGE DANS GIT INTERDIT TOUTE EVOLUTION, ET C'EST CE QUI EST
// ARRIVE. Ce test comparait la fonction de CHAQUE copie a sa version d'avant le
// branchement. Des que `lib/channel-availability.js` a legitimement change — a
// l'etape 2 du chantier, qui lui pose les gardes de l'original —, il a rougi
// sans qu'aucun defaut existe.
//
// On garde donc les DEUX comparaisons, chacune pour ce qu'elle prouve :
//   · AVEC contre SANS la ligne de surveillance : la surveillance est inerte.
//     Vaut pour toutes les copies, toujours, et survit aux evolutions ;
//   · contre le temoin git : la valeur rendue n'a pas bouge depuis le
//     branchement. Vaut pour les copies qu'AUCUN chantier n'a touchees, et une
//     copie qui evolue sort de cette liste NOMMEMENT, avec sa raison.
const EVOLUEES = {
  'lib/channel-availability.js':
    'etape 2 du chantier : les gardes de l original (panne reseau, verdict de '
    + 'forme) lui ont ete posees, donc sa valeur rendue CHANGE volontairement — '
    + 'un 2xx inexploitable y rend desormais `ok: false`. '
    + 'tests/stop-sell-non-confirme.test.js la tient.'
}

function sourceDAvant (fichier) {
  const { execFileSync } = require('node:child_process')
  return execFileSync('git', ['-C', RACINE, 'show', `${AVANT}:${fichier}`],
                      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
}

// Extrait la fonction `channelCall` d'un texte, en comptant ses accolades.
function fonctionChannelCall (fichier, texte) {
  const src = texte != null ? texte : fs.readFileSync(path.join(RACINE, fichier), 'utf8')
  const m = src.match(/async function channelCall\s*\(/)
  assert.ok(m, `${fichier} : aucune fonction channelCall`)
  const debut = m.index
  let p = 0
  for (let j = src.indexOf('{', debut); j < src.length; j++) {
    if (src[j] === '{') p++
    else if (src[j] === '}') { p--; if (p === 0) return src.slice(debut, j + 1) }
  }
  throw new Error(`${fichier} : accolades non refermees`)
}

// Monte la fonction avec ses dependances simulees. `avecSurveillance: false`
// retire la ligne d'observation : c'est le code d'AVANT, notre temoin.
function monter (fichier, { reponse, dAvant = false, sansSurveillance = false }) {
  let source = dAvant
    ? fonctionChannelCall(fichier, sourceDAvant(fichier))
    : fonctionChannelCall(fichier)
  if (sansSurveillance) {
    source = source
      .replace(/\s*await surveillerReponse\(\{[\s\S]*?\}\)\n/, '\n')
      .replace(/\s*await noter\([^)]*\)\n/, '\n')
  }
  const incidents = []
  const appels = []
  const faux = async (url, opts) => {
    appels.push({ url, methode: (opts && opts.method) || 'GET' })
    return new Response(reponse.statut === 204 ? null : reponse.corps, {
      status: reponse.statut,
      headers: { 'content-type': reponse.type || 'application/json' }
    })
  }
  // ⚠ LES DEPENDANCES SONT INJECTEES PAR LE MEME NOM QUE DANS LE FICHIER.
  // `require` est fourni pour que `channex.js`, qui charge la surveillance
  // paresseusement, tombe sur notre espion et non sur le vrai module.
  // ⚠ LE MODULE SIMULE DOIT PORTER TOUTE SA SURFACE. Il ne rendait que
  // `surveillerReponse` : des que `lib/channel-availability.js` a demande aussi
  // `verdictDeLaReponse` — a l'etape 2 du chantier —, les trois tests sont
  // tombes sur un `TypeError` qui n'avait rien a voir avec ce qu'ils mesurent.
  // On garde donc le vrai module, et on ne remplace QUE l'observation.
  const vrai = require('../lib/reponse-partenaire')
  const faireRequire = (chemin) => {
    if (/reponse-partenaire/.test(chemin)) return { ...vrai, surveillerReponse: espion }
    return require(chemin)
  }
  // ⚠ LES COPIES APPELLENT LA SURVEILLANCE SANS CONDITION : c'est le MODULE qui
  // decide s'il y a un incident. Un espion qui compte chaque appel comptait donc
  // un incident sur un JSON parfaitement sain. Il appelle donc le VRAI verdict —
  // celui-la meme qui est sous test — et ne retient que les reponses jugees
  // inexploitables.
  const { verdictDeLaReponse } = require('../lib/reponse-partenaire')
  const espion = async (o) => {
    appels.push({ surveillance: true })
    if (!verdictDeLaReponse(o).valide) incidents.push(o)
    return { signale: true }
  }

  // ⚠ CHAQUE COPIE A SES PROPRES AIDES LOCALES — `assertAllowed`, des garde-fous
  // de debit, des compteurs. On les decouvre dans le texte extrait et on les
  // remplace par des doublures inoffensives. Les MEMES doublures servent aux
  // deux montages (avec et sans surveillance), donc la comparaison des valeurs
  // rendues reste valable : c'est elle qui prouve « on ne change rien ».
  const FOURNIS = ['fetch', 'CHANNEL_API', 'CHANNEL_KEY', 'CHANNEL_APP_BASE',
                   'surveillerReponse', 'require', 'console', 'Response',
                   'channelCall', 'JSON', 'Promise', 'Number', 'String', 'Object',
                   'Array', 'Math', 'Date', 'parseInt', 'parseFloat', 'setTimeout',
                   'encodeURIComponent', 'Boolean', 'isNaN', 'AbortController',
                   'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
                   'function', 'await', 'new', 'throw']
  // ⚠ ON DOUBLE TOUT CE QUI VIENT DU FICHIER, pas seulement les fonctions.
  // `METHODES_REJOUABLES` n'est jamais suivie d'une parenthese, `assertAllowed`
  // l'est : on collecte donc TOUS les identifiants du texte extrait, on retire
  // ceux qu'on fournit, les mots du langage, les parametres de la fonction et
  // ce qu'elle declare elle-meme. Le reste vient de la portee du module, et on
  // le double.
  const MOTS = new Set(['const', 'let', 'var', 'else', 'try', 'of', 'in', 'true',
    'false', 'null', 'undefined', 'async', 'await', 'break', 'continue', 'delete',
    'void', 'instanceof', 'this', 'default', 'case', 'do', 'finally', 'function',
    'return', 'if', 'for', 'while', 'switch', 'catch', 'throw', 'new', 'typeof'])
  const declares = new Set(
    [...source.matchAll(/\b(?:const|let|var)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))/g)]
      .flatMap(m => (m[1] || m[2] || '').split(','))
      .map(x => x.trim().split(':').pop().trim())
      .filter(Boolean))
  const params = new Set((source.match(/channelCall\s*\(([^)]*)\)/) || [, ''])[1]
    .split(',').map(x => x.trim().split('=')[0].trim()).filter(Boolean))
  const fournis = new Set(FOURNIS)
  const inconnus = [...new Set([...source.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)]
    .map(m => m[1]))]
    .filter(n => !fournis.has(n) && !MOTS.has(n) && !declares.has(n) && !params.has(n))
    // Les proprietes (`.foo`) ne sont pas des variables : on les ecarte.
    .filter(n => !new RegExp(`\\.\\s*${n}\\b`).test(source)
                 || new RegExp(`(^|[^.\\w$])${n}\\b`, 'm').test(source))

  const fn = new Function(
    ...FOURNIS.slice(0, 8), ...inconnus,
    `${source}\nreturn channelCall`
  )(faux, 'https://faux.partenaire/api/v1', 'cle-de-test', 'https://faux.partenaire',
    espion, faireRequire, { log () {}, error () {}, warn () {} }, Response,
    // ⚠ UNE DOUBLURE PERMISSIVE : appelable, et toute propriete lue rend une
    // fonction qui rend `undefined`. `METHODES_REJOUABLES.has(m)` vaut donc
    // `undefined` — faux —, ce qui desactive les reessais : le MEME effet dans
    // les deux montages, donc la comparaison tient.
    ...inconnus.map(() => new Proxy(function () {}, {
      get: () => () => undefined,
      apply: () => undefined
    })))
  return { fn, incidents, appels, doublures: inconnus }
}

const SAIN = { statut: 200, corps: JSON.stringify({ data: [{ id: 'x' }], meta: { total: 1 } }) }
const HTML = { statut: 200, corps: '<!DOCTYPE html><html>Service Unavailable</html>',
               type: 'text/html' }

// ─── Le tableau d'execution ────────────────────────────────────────────────

test('LE TEST QUI COMPTE : JSON sain — valeur IDENTIQUE et AUCUN incident, pour les 16', async () => {
  const fautes = []
  for (const f of COPIES) {
    const avec = monter(f, { reponse: SAIN })
    // La surveillance est-elle inerte ? Toujours verifiable.
    const inerte = monter(f, { reponse: SAIN, sansSurveillance: true })
    const rI = await inerte.fn('GET', '/channels')
    // Et la valeur a-t-elle bouge depuis le branchement ? Seulement pour les
    // copies qu'aucun chantier n'a touchees.
    const sans = EVOLUEES[f] ? null : monter(f, { reponse: SAIN, dAvant: true })
    const rA = await avec.fn('GET', '/channels')
    if (JSON.stringify(rA) !== JSON.stringify(rI)) {
      fautes.push(`${f} : la SURVEILLANCE change la valeur rendue (JSON sain)\n      avec = ${JSON.stringify(rA)}\n      sans = ${JSON.stringify(rI)}`)
    }
    if (sans) {
      const rS = await sans.fn('GET', '/channels')
      if (JSON.stringify(rA) !== JSON.stringify(rS)) {
        fautes.push(`${f} : valeur CHANGEE sur un JSON sain, par rapport au code d avant\n      avec = ${JSON.stringify(rA)}\n      avant = ${JSON.stringify(rS)}\n      -> si c est volontaire, inscrire ce fichier dans EVOLUEES avec sa raison`)
      }
    }
    if (avec.incidents.length !== 0) {
      fautes.push(`${f} : ${avec.incidents.length} incident(s) sur un JSON SAIN`)
    }
  }
  assert.deepEqual(fautes, [], '\n  ' + fautes.join('\n  '))
})

test('LE TEST QUI COMPTE : 200 + HTML — valeur IDENTIQUE et UN incident, pour les 16', async () => {
  const fautes = []
  for (const f of COPIES) {
    const avec = monter(f, { reponse: HTML })
    // La surveillance est-elle inerte ? Toujours verifiable.
    const inerte = monter(f, { reponse: HTML, sansSurveillance: true })
    const rI = await inerte.fn('GET', '/channels')
    // Et la valeur a-t-elle bouge depuis le branchement ? Seulement pour les
    // copies qu'aucun chantier n'a touchees.
    const sans = EVOLUEES[f] ? null : monter(f, { reponse: HTML, dAvant: true })
    const rA = await avec.fn('GET', '/channels')
    if (JSON.stringify(rA) !== JSON.stringify(rI)) {
      fautes.push(`${f} : la SURVEILLANCE change la valeur rendue (200 + HTML)\n      avec = ${JSON.stringify(rA)}\n      sans = ${JSON.stringify(rI)}`)
    }
    if (sans) {
      const rS = await sans.fn('GET', '/channels')
      if (JSON.stringify(rA) !== JSON.stringify(rS)) {
        fautes.push(`${f} : valeur CHANGEE sur un 200 + HTML, par rapport au code d avant\n      avec = ${JSON.stringify(rA)}\n      avant = ${JSON.stringify(rS)}\n      -> si c est volontaire, inscrire ce fichier dans EVOLUEES avec sa raison`)
      }
    }
    if (avec.incidents.length !== 1) {
      fautes.push(`${f} : ${avec.incidents.length} incident(s) au lieu d un sur un 200 + HTML`)
    } else {
      const i = avec.incidents[0]
      if (i.fichier !== f) fautes.push(`${f} : l incident annonce « ${i.fichier} »`)
      if (i.statut !== 200) fautes.push(`${f} : statut ${JSON.stringify(i.statut)} au lieu de 200`)
      if (i.chemin !== '/channels') fautes.push(`${f} : chemin « ${i.chemin} »`)
      if (String(i.methode).toUpperCase() !== 'GET') fautes.push(`${f} : methode « ${i.methode} »`)
      if (typeof i.texte !== 'string' || !i.texte.includes('DOCTYPE')) {
        fautes.push(`${f} : le corps recu n est pas transmis a la surveillance`)
      }
    }
  }
  assert.deepEqual(fautes, [], '\n  ' + fautes.join('\n  '))
})

test('LE TEST QUI COMPTE : un incident nomme le BON fichier, jamais celui du voisin', async () => {
  // ⚠ UN COPIER-COLLER ENTRE DEUX FICHIERS PASSERAIT INAPERCU AUTREMENT : une
  // ligne de surveillance qui annonce le fichier du voisin rendrait toute la
  // mesure inutilisable, puisque le fichier est la seule information qui dit
  // CE QUE le code a conclu de cette reponse.
  const vus = new Set()
  for (const f of COPIES) {
    const m = monter(f, { reponse: HTML })
    await m.fn('GET', '/channels')
    assert.equal(m.incidents[0].fichier, f, `${f} annonce « ${m.incidents[0].fichier} »`)
    assert.ok(!vus.has(m.incidents[0].fichier), `deux copies annoncent ${f}`)
    vus.add(m.incidents[0].fichier)
  }
  assert.equal(vus.size, COPIES.length)
})

test('api/channel-connect.js : son `fetch` en ligne observe aussi, et sans rien casser', async () => {
  // ⚠ CELUI-LA N'A PAS DE `channelCall` : c'est un `fetch` EN LIGNE dans son
  // handler, et c'est exactement pourquoi le patch mecanique l'avait casse —
  // `method` et `path` n'y existent pas. On ne peut pas extraire une fonction :
  // on verifie donc sur le texte que les trois valeurs sont LITTERALES ou
  // tirees de la reponse du partenaire (`r`), jamais des noms que le patch
  // avait supposes.
  const src = fs.readFileSync(path.join(RACINE, 'api/channel-connect.js'), 'utf8')
  const i = src.indexOf('surveillerReponse({')
  assert.notEqual(i, -1, 'aucune surveillance dans api/channel-connect.js')
  const appel = src.slice(i, src.indexOf('})', i))
  assert.match(appel, /methode:\s*'POST'/, 'la methode n est pas litterale')
  assert.match(appel, /chemin:\s*'\/auth\/one_time_token'/, 'le chemin n est pas litteral')
  assert.match(appel, /statut:\s*r\.status/, 'le statut ne vient pas de la reponse du partenaire')
  assert.ok(!/statut:\s*res\.status/.test(appel),
    '`res` est la reponse HTTP du handler : `res.status` y est une FONCTION')
})
