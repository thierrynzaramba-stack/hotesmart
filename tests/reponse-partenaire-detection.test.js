// tests/reponse-partenaire-detection.test.js
// ETAPE 1 DU CHANTIER « 200 SANS JSON » : ON OBSERVE, ON NE CHANGE RIEN.
//
// ⚠ CE QUE CETTE ETAPE DOIT FAIRE, ET SURTOUT CE QU'ELLE NE DOIT PAS FAIRE.
// `channelCall` rangeait une reponse non-JSON en `{ raw: text }` et gardait le
// succes du code HTTP : un 200 portant une page HTML devenait une reponse
// VALIDE annoncant une liste vide. Dix-huit copies de cette fonction, dont
// quatre tirent une conclusion DESTRUCTRICE
// (docs/kb/reponse-200-sans-json.md).
//
// Les quatre chemins se corrigent ENSUITE, un par un. Ici on veut seulement
// SAVOIR : le cas se produit-il, et ou ? Aucune trace n'existe aujourd'hui, par
// construction — le defaut est muet.
//
// ⚠ DONC : la surveillance ne doit JAMAIS changer la valeur rendue, JAMAIS
// lever, et JAMAIS retarder le chemin normal. Les trois sont des tests.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  verdictDeLaReponse, cheminNormalise, surveillerReponse, CADENCE_MS
} = require('../lib/reponse-partenaire')

// Une base simulee : elle retient ce qu'on lui demande, et peut echouer.
function baseSimulee ({ dernieres = [], lectureEnEchec = false,
                        ecritureEnEchec = false } = {}) {
  const trace = { lectures: [], insertions: [], majs: [] }
  // ⚠ ELLE APPLIQUE REELLEMENT SES FILTRES. Premiere version : elle rendait
  // `dernieres` quoi qu'on lui demande, donc le `gte` de la fenetre de cadence
  // etait IGNORE — et le test « au-dela de la fenetre » ne pouvait pas passer.
  // C'est le meme defaut de harnais que celui releve en revue sur
  // tests/canaux-du-bien.test.js : un filtre qu'on ne pose pas se voit alors
  // meme quand le resultat serait juste par ailleurs.
  const table = (nom) => {
    const conditions = []
    const filtres = []
    const q = {
      select () { return q },
      eq (k, v) { conditions.push({ k, v }); filtres.push(r => String(r[k]) === String(v)); return q },
      gte (k, v) { conditions.push({ k, v, op: 'gte' }); filtres.push(r => r[k] != null && r[k] >= v); return q },
      order () { return q },
      limit () { return q },
      insert (l) { trace.insertions.push({ nom, ligne: l })
        return Promise.resolve({ error: ecritureEnEchec ? { message: 'refus' } : null }) },
      update (maj) {
        const o = { nom, maj, conditions: [...conditions],
          eq (k, v) { o.conditions.push({ k, v }); return o },
          then (res) { trace.majs.push(o); return res({ error: null }) } }
        return o
      },
      then (res) {
        trace.lectures.push({ nom, conditions: [...conditions] })
        if (lectureEnEchec) return res({ data: null, error: { message: 'lecture refusee' } })
        return res({ data: dernieres.filter(r => filtres.every(f => f(r))), error: null })
      }
    }
    return q
  }
  return { from: table, trace }
}

const HTML = '<!DOCTYPE html><html><body>Service Unavailable</body></html>'

// ─── Le verdict : qu'est-ce qu'une reponse inexploitable ? ──────────────────

test('LE TEST QUI COMPTE : un 2xx sans JSON exploitable est detecte', () => {
  assert.equal(verdictDeLaReponse({ statut: 200, texte: HTML }).code, 'reponse_non_json')
  assert.equal(verdictDeLaReponse({ statut: 201, texte: 'pas du json' }).code, 'reponse_non_json')
  // Du JSON, mais pas la forme du partenaire.
  assert.equal(verdictDeLaReponse({ statut: 200, texte: '{"message":"maintenance"}' }).code,
    'forme_inattendue')
  assert.equal(verdictDeLaReponse({ statut: 200, texte: '[]' }).code, 'forme_inattendue')
  assert.equal(verdictDeLaReponse({ statut: 200, texte: '{"data":null}' }).code, 'forme_inattendue')
  // Un corps vide sur une LECTURE.
  assert.equal(verdictDeLaReponse({ statut: 200, texte: '', methode: 'GET' }).code, 'reponse_vide')
})

test('LE TEST QUI COMPTE : une reponse NORMALE n est jamais signalee', () => {
  // ⚠ LA CONTRE-EPREUVE, ET ELLE COMPTE AUTANT. Une detection qui crie sur du
  // trafic normal se fait eteindre en deux jours.
  const sain = [
    { statut: 200, texte: '{"data":[],"meta":{"total":0}}' },   // compte vide
    { statut: 200, texte: '{"data":{"id":"x"}}' },              // une ressource
    { statut: 200, texte: '{"meta":{"limit":10}}' },            // pagination seule
    { statut: 422, texte: '{"errors":{"code":"validation"}}' }, // un refus franc
    { statut: 204, texte: '', methode: 'DELETE' },              // suppression
    { statut: 200, texte: '', methode: 'POST' },                // ecriture sans corps
    { statut: 500, texte: HTML }                                // deja un echec HTTP
  ]
  for (const r of sain) {
    const v = verdictDeLaReponse(r)
    assert.equal(v.valide, true,
      `signale a tort : ${r.statut} ${JSON.stringify(r.texte).slice(0, 40)} -> ${v.code}`)
  }
})

// ─── Le chemin normalise : aucun identifiant du partenaire en base ──────────

test('LE TEST QUI COMPTE : le chemin perd les identifiants du partenaire', () => {
  const n = cheminNormalise
  assert.equal(n('/channels/0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4'), '/channels/:id')
  assert.equal(n('/channels/0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4/mappings/abc-123'),
    '/channels/:id/mappings/:id')
  assert.equal(n('/properties/8232ff8a-e1aa-475f-9fe1-f1b3c8e58109'), '/properties/:id')
  // Les parametres de requete partent aussi : ils portent des filtres par bien.
  assert.equal(n('/bookings?filter[property_id]=8232ff8a-e1aa&pagination[page]=2'),
    '/bookings')
  // Et un identifiant numerique ou opaque n'echappe pas.
  assert.equal(n('/reviews/123456'), '/reviews/:id')
  assert.equal(n('/booking_revisions/abc123def456/ack'), '/booking_revisions/:id/ack')
  // Un chemin sans identifiant reste lisible.
  assert.equal(n('/channels'), '/channels')
  assert.equal(n('/availability'), '/availability')
})

// ─── La surveillance : elle observe, et elle ne gene jamais ─────────────────

test('LE TEST QUI COMPTE : la surveillance ne change RIEN et ne leve JAMAIS', async () => {
  // Base qui refuse tout : lecture ET ecriture.
  const sb = baseSimulee({ lectureEnEchec: true, ecritureEnEchec: true })
  const r = await surveillerReponse({
    fichier: 'lib/essai.js', methode: 'GET', chemin: '/channels',
    statut: 200, texte: HTML, sb, alarme: () => { throw new Error('alarme cassee') }
  })
  // Elle rend un simple compte rendu, jamais la reponse de l'appelant.
  assert.equal(typeof r, 'object')
  assert.equal(r.leve, undefined, 'la surveillance a leve')
})

test('un 2xx sans JSON pose UNE ligne, et sonne', async () => {
  const sb = baseSimulee()
  const alarmes = []
  await surveillerReponse({
    fichier: 'lib/channel-availability.js', methode: 'POST', chemin: '/restrictions',
    statut: 200, texte: HTML, sb, alarme: (c, d) => alarmes.push([c, d])
  })
  assert.equal(sb.trace.insertions.length, 1, 'aucune ligne posee')
  const l = sb.trace.insertions[0].ligne
  assert.equal(sb.trace.insertions[0].nom, 'reponses_partenaire_invalides')
  assert.equal(l.fichier, 'lib/channel-availability.js')
  assert.equal(l.code, 'reponse_non_json')
  assert.equal(l.statut, 200)
  assert.equal(l.chemin, '/restrictions')
  assert.ok(l.extrait && l.extrait.length <= 300, 'extrait absent ou trop long')
  assert.equal(alarmes.length, 1, `${alarmes.length} alarme(s)`)
  assert.equal(alarmes[0][0], 'reponse_partenaire_invalide')
})

test('une reponse SAINE ne touche pas la base', async () => {
  const sb = baseSimulee()
  const alarmes = []
  await surveillerReponse({
    fichier: 'lib/essai.js', methode: 'GET', chemin: '/channels',
    statut: 200, texte: '{"data":[],"meta":{"total":0}}', sb,
    alarme: (c) => alarmes.push(c)
  })
  assert.deepEqual(sb.trace.insertions, [], 'une reponse saine a ecrit en base')
  assert.deepEqual(sb.trace.lectures, [], 'une reponse saine a LU la base : cout sur le chemin normal')
  assert.deepEqual(alarmes, [])
})

test('LE TEST QUI COMPTE : une panne qui dure ne fabrique pas mille lignes', async () => {
  // ⚠ LA CADENCE. Un partenaire qui repond HTML a chaque appel produirait une
  // ligne par appel — et `channelCall` est appele des dizaines de fois par
  // cycle de cron. On regroupe dans une fenetre, et on incremente.
  const recente = {
    id: 'L1', fichier: 'lib/essai.js', code: 'reponse_non_json',
    occurrences: 7, vu_le: new Date(Date.now() - 60000).toISOString()
  }
  const sb = baseSimulee({ dernieres: [recente] })
  const alarmes = []
  await surveillerReponse({
    fichier: 'lib/essai.js', methode: 'GET', chemin: '/channels',
    statut: 200, texte: HTML, sb, alarme: (c) => alarmes.push(c)
  })
  assert.deepEqual(sb.trace.insertions, [], 'une seconde occurrence a pose une NOUVELLE ligne')
  assert.equal(sb.trace.majs.length, 1, 'le compteur n a pas ete incremente')
  assert.equal(sb.trace.majs[0].maj.occurrences, 8)
  assert.deepEqual(alarmes, [], 'la cadence a sonne une seconde fois')
})

test('au-dela de la fenetre, une nouvelle ligne et une nouvelle alarme', async () => {
  const vieille = {
    id: 'L1', fichier: 'lib/essai.js', code: 'reponse_non_json',
    occurrences: 7, vu_le: new Date(Date.now() - CADENCE_MS - 60000).toISOString()
  }
  const sb = baseSimulee({ dernieres: [vieille] })
  const alarmes = []
  await surveillerReponse({
    fichier: 'lib/essai.js', methode: 'GET', chemin: '/channels',
    statut: 200, texte: HTML, sb, alarme: (c) => alarmes.push(c)
  })
  assert.equal(sb.trace.insertions.length, 1)
  assert.equal(alarmes.length, 1)
})

test('la lecture de la cadence porte son filtre de fichier ET de code', async () => {
  // Sans ces filtres, la panne d'un fichier etoufferait celle d'un autre.
  const sb = baseSimulee()
  await surveillerReponse({
    fichier: 'api/calendar.js', methode: 'POST', chemin: '/availability',
    statut: 200, texte: HTML, sb, alarme: () => {}
  })
  const l = sb.trace.lectures[0]
  assert.ok(l, 'aucune lecture de cadence')
  assert.ok(l.conditions.some(c => c.k === 'fichier' && c.v === 'api/calendar.js'),
    'la lecture ne filtre pas par fichier')
  assert.ok(l.conditions.some(c => c.k === 'code' && c.v === 'reponse_non_json'),
    'la lecture ne filtre pas par code')
})

test('l extrait est borne et le chemin normalise AVANT d entrer en base', async () => {
  const sb = baseSimulee()
  await surveillerReponse({
    fichier: 'api/channel-mapping.js', methode: 'DELETE',
    chemin: '/channels/0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4/mappings/xyz-9',
    statut: 200, texte: 'x'.repeat(5000), sb, alarme: () => {}
  })
  const l = sb.trace.insertions[0].ligne
  assert.equal(l.chemin, '/channels/:id/mappings/:id',
    'un identifiant du partenaire est entre en base')
  assert.equal(l.extrait.length, 300)
})

// ─── LA COUVERTURE : les dix-huit copies, nommées une par une ──────────────

// ⚠ CETTE LISTE EST ECRITE A LA MAIN, ET C'EST VOULU. Elle est la seule chose
// qui dira qu'une DIX-NEUVIEME copie est apparue sans surveillance — une liste
// derivee du code ne verrait que ce que le code contient deja.
// Inventaire d'origine : docs/kb/reponse-200-sans-json.md.
const COPIES = [
  'lib/channels/channex.js',          // la reference : elle REFUSE, et elle note
  'api/calendar.js',
  'api/channel-airbnb-connect.js',
  'api/channel-bcom-activate.js',
  'api/channel-bcom-write.js',
  'api/channel-bcom.js',
  'api/channel-connect.js',
  'api/channel-events.js',
  'api/channel-mapping.js',
  'api/channel-property.js',
  'api/channel-rateplan.js',
  'api/channel-webhook.js',
  'api/diagnostic.js',
  'lib/channel-availability.js',
  'lib/channel-fullsync.js',
  'lib/cron-channel-feed.js',
  'lib/cron-channel-reviews.js'
]

// ⚠ UNE EXEMPTION SE COMPTE, ELLE NE SE DECRIT PAS. Les scripts de `scripts/`
// appellent aussi le partenaire, et ils ne sont PAS surveilles. La raison est la
// meme pour tous : ce sont des outils lances A LA MAIN, dont la sortie est lue
// par un humain au moment ou il les lance — s'ils recoivent une page HTML, il
// le voit. Et surtout, AUCUN n'est deploye : Vercel ne sert que `api/` et le
// site statique, `lib/` n'arrive qu'embarque par `api/`.
//
// ⚠ ET LE BALAYAGE A TROUVE HUIT DE PLUS QUE L'INVENTAIRE DU MATIN. Celui-ci
// comptait les fichiers portant la ligne de repli `{ raw: text }` — ces huit
// appellent le partenaire autrement. Le compte de « dix-huit copies » de
// docs/kb/reponse-200-sans-json.md porte donc sur les copies de `channelCall`,
// pas sur tout ce qui parle au partenaire. La liste ci-dessous les nomme.
const EXEMPTES = [
  'scripts/check-webhooks.js',          // jetable, « a supprimer apres usage »
  'scripts/_tmp-restore.js',
  'scripts/audit-stop-sell.js',
  'scripts/etat-bascule-la-bulle.js',
  'scripts/mapper-airbnb-second-bien.js',
  'scripts/mapper-booking-la-bulle.js',
  'scripts/reconcilier-stop-sell.js',
  'scripts/staging-tarifs.js',
  'scripts/supprimer-residus-phase0.js'
]

test('LE TEST QUI COMPTE : les dix-huit copies de channelCall sont surveillees', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const RACINE = path.join(__dirname, '..')
  const sans = []
  for (const f of COPIES) {
    const s = fs.readFileSync(path.join(RACINE, f), 'utf8')
    if (!/surveillerReponse\s*\(/.test(s)) sans.push(f)
  }
  assert.deepEqual(sans, [],
    `${sans.length} copie(s) de channelCall sans surveillance : ` + sans.join(', '))
  // ⚠ LE COMPTE SE LIT, IL NE SE SUPPOSE PAS. 17 copies de `channelCall` dans
  // le code deploye, toutes surveillees, et 9 outils de `scripts/` exemptes
  // nommement. Si l'un des deux nombres change, ce test le dit.
  assert.equal(COPIES.length, 17, `${COPIES.length} copies surveillees au lieu de 17`)
  assert.equal(EXEMPTES.length, 9, `${EXEMPTES.length} exemptions au lieu de 9`)
})

test('LE TEST QUI COMPTE : aucune DIX-NEUVIEME copie n est apparue', () => {
  // ⚠ C'EST LE SEUL TEST QUI VERRA LA PROCHAINE COPIE. On balaye le depot a la
  // recherche de la signature de ces fonctions — la lecture du corps en texte
  // puis un `JSON.parse` de secours — et on exige que chaque fichier trouve
  // soit dans la liste ci-dessus, soit exempte nommement.
  const fs = require('node:fs')
  const path = require('node:path')
  const RACINE = path.join(__dirname, '..')
  const trouves = []
  const parcourir = (rel) => {
    for (const e of fs.readdirSync(path.join(RACINE, rel), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const r = path.join(rel, e.name)
      if (e.isDirectory()) { parcourir(r); continue }
      if (!e.name.endsWith('.js')) continue
      const s = fs.readFileSync(path.join(RACINE, r), 'utf8')
      // La signature : un appel au partenaire avec sa cle, et une lecture du
      // corps en texte. C'est ce qui definit une copie de `channelCall`.
      if (/user-api-key/.test(s) && /await\s+res\.text\(\)|await\s+r\.text\(\)/.test(s)) {
        trouves.push(r)
      }
    }
  }
  for (const d of ['api', 'lib', 'scripts']) parcourir(d)
  const inconnus = trouves.filter(f => !COPIES.includes(f) && !EXEMPTES.includes(f))
  assert.deepEqual(inconnus, [],
    `${inconnus.length} fichier(s) appellent le partenaire sans etre dans la liste : `
    + inconnus.join(', ') + '\n  -> brancher `surveillerReponse`, ou exempter nommement.')

  // ⚠ ET L'INVERSE AUSSI : un exempte qui a disparu doit se voir, sinon la
  // liste se remplit de noms morts et son compte ne veut plus rien dire.
  const disparus = EXEMPTES.filter(f => !trouves.includes(f))
  assert.deepEqual(disparus, [],
    'exemption(s) qui ne correspondent plus a aucun fichier appelant le '
    + 'partenaire : ' + disparus.join(', ') + ' — a retirer de la liste.')

  // ⚠ ET AUCUN FICHIER DEPLOYE NE DOIT ETRE EXEMPTE. Vercel sert `api/` et le
  // site ; `lib/` arrive embarque par `api/`. Un exempte hors de `scripts/`
  // serait donc une copie non surveillee EN PRODUCTION.
  const deployeExempte = EXEMPTES.filter(f => !f.startsWith('scripts/'))
  assert.deepEqual(deployeExempte, [],
    'fichier(s) DEPLOYE(S) exempte(s) de surveillance : ' + deployeExempte.join(', '))
})

test('LE TEST QUI COMPTE : chaque appel de surveillance ne nomme que des variables declarees', () => {
  // ⚠ CE TEST EXISTE PARCE QUE `node -c` NE VOIT PAS LES PORTEES. Le patch qui
  // a branche les copies ecrivait `methode: method, chemin: path, statut:
  // res.status` partout. Or `api/channel-connect.js` n'a pas de `channelCall` :
  // c'est un `fetch` EN LIGNE dans un handler. Resultat mesure :
  //   · `method` et `path` ne sont declares NULLE PART dans ce fichier ->
  //     `ReferenceError` a chaque appel, iframe de connexion cassee ;
  //   · `res` existe — mais c'est la reponse HTTP du handler, et `res.status`
  //     y est une FONCTION. Un identifiant qui existe sans rien signifier de
  //     juste est le pire des deux cas.
  //
  // ⚠ CE QU'IL VERIFIE EXACTEMENT. Pas la portee lexicale — les modules gardent
  // leur `channelCall` prive et l'executer demanderait de monter leurs clients
  // et leur environnement. Il verifie que chaque identifiant nomme dans l'appel
  // est DECLARE quelque part dans le fichier, en parametre ou en variable.
  // C'est plus faible qu'une analyse de portee, et ca suffit a la classe de
  // defaut qui a mordu : `method` et `path` n'etaient declares nulle part.
  const fs = require('node:fs')
  const path = require('node:path')
  const RACINE = path.join(__dirname, '..')
  const fautes = []

  for (const f of COPIES) {
    const src = fs.readFileSync(path.join(RACINE, f), 'utf8')
    const i = src.indexOf('surveillerReponse({')
    if (i === -1) { fautes.push(`${f} : appel introuvable`); continue }
    const argus = src.slice(i, src.indexOf('})', i))
    const nommes = [...argus.matchAll(/:\s*([A-Za-z_$][\w$]*)(?:\.[\w$]+)?/g)]
      .map(m => m[1])
      .filter(v => !['true', 'false', 'null', 'undefined'].includes(v))
    for (const v of new Set(nommes)) {
      const enParametre = new RegExp(
        `(?:function[^(]*|=>\\s*)?\\(([^)]*\\b${v}\\b[^)]*)\\)\\s*(?:=>|\\{)`).test(src)
      const enVariable = new RegExp(`\\b(?:const|let|var)\\s+(?:\\{[^}]*\\b${v}\\b[^}]*\\}|${v}\\b)`).test(src)
      if (!enParametre && !enVariable) {
        fautes.push(`${f} : « ${v} » n'est declare nulle part dans le fichier`)
      }
    }
  }
  assert.deepEqual(fautes, [], '\n  ' + fautes.join('\n  '))
})
