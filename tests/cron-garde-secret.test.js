// tests/cron-garde-secret.test.js
// UN SECRET ABSENT NE DOIT PAS OUVRIR LA PORTE.
//
// LE DEFAUT QU'IL EMPECHE, trouve par un audit du 1er octobre 2026 :
// `api/cron.js` comparait `req.headers.authorization` a
// `` `Bearer ${process.env.CRON_SECRET}` ``. Sur un deploiement ou la variable
// manque, la comparaison porte sur le litteral « Bearer undefined » — qu'il
// suffit d'envoyer. N'importe qui sur Internet declenchait alors le cycle
// COMPLET : poussee de disponibilites chez le gestionnaire de canaux, pilote
// tarifaire, messages automatiques au voyageur, creation de codes de serrure,
// facturation Stripe, alertes hote et fondateur.
//
// ⚠ CE DEFAUT ETAIT CONNU ET ECRIT. Le commentaire de `api/cron-messages.js`
// disait, depuis le 21 septembre 2026 : « la parade existe deja dans le depot
// (`api/backfill-beds24-host.js`) ; `api/cron.js` ne l'a pas ». Un defaut note
// n'est pas un defaut corrige, et personne ne relit les commentaires des
// fichiers voisins. Ce test, lui, se relit tout seul a chaque `npm test`.
//
// Contre-epreuve faite hors de l'arbre : avec le code d'avant (bd8e306), les
// deux tests « secret absent » rougissent.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
// ⚠ `api/cron.js` charge `lib/billing.js`, qui instancie Stripe AU CHARGEMENT du
// module : sans cle, le `require` leve avant meme qu'on ait pu appeler le
// handler. Note au passage, hors sujet de ce test mais pas sans consequence : un
// deploiement sans `STRIPE_SECRET_KEY` fait donc echouer le cycle entier, pas
// seulement la facturation.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_pour_les_tests'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

// ⚠ LES ENDPOINTS SONT CHARGES A NEUF A CHAQUE FOIS, parce qu'ils lisent
// `process.env` au moment de l'appel pour le secret, mais creent leur client
// Supabase au CHARGEMENT. Sans ce double neuf, le premier test fixerait
// l'environnement des suivants.
const ENDPOINTS = ['../api/cron', '../api/cron-messages']

function preparer () {
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs)
  // ⚠ UN CLIENT QUI REFUSE TOUT. Si un test franchissait la garde par erreur, le
  // cycle ne pourrait rien ecrire : un test de securite ne doit pas pouvoir
  // devenir l'incident qu'il decrit.
  const refus = () => { throw new Error('[test] aucun acces base ne doit avoir lieu') }
  m.exports = { createClient: () => new Proxy({}, { get: () => refus }) }
  m.loaded = true
  require.cache[abs] = m
  for (const e of ENDPOINTS) { try { delete require.cache[require.resolve(e)] } catch {} }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}
const req = (autorisation) => ({ method: 'POST', query: {}, body: {}, headers: autorisation ? { authorization: autorisation } : {} })

// Pose l'environnement, appelle, restaure. Toujours par ce chemin : un test qui
// laisse `CRON_SECRET` derriere lui contamine les suivants.
async function appeler (endpoint, secret, autorisation) {
  const avant = process.env.CRON_SECRET
  if (secret === null) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = secret
  preparer()
  try {
    const handler = require(endpoint)
    const res = reponse()
    await handler(req(autorisation), res)
    return res
  } finally {
    if (avant === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = avant
  }
}

for (const endpoint of ENDPOINTS) {
  const nom = endpoint.replace('../api/', '')

  test(`LE TEST QUI COMPTE : ${nom} — « Bearer undefined » ne passe PAS quand le secret est absent`, async () => {
    const res = await appeler(endpoint, null, 'Bearer undefined')
    assert.strictEqual(res.code, 503, `${nom} doit se fermer, pas s ouvrir`)
    assert.match(String(res.body && res.body.error), /non configur/i)
  })

  test(`${nom} — un secret absent ferme l endpoint, meme sans en-tete du tout`, async () => {
    const res = await appeler(endpoint, null, null)
    assert.strictEqual(res.code, 503)
  })

  test(`${nom} — avec un secret pose, un mauvais en-tete rend 401`, async () => {
    const res = await appeler(endpoint, 'le-vrai-secret', 'Bearer pas-le-bon')
    assert.strictEqual(res.code, 401)
  })

  test(`${nom} — avec un secret pose, « Bearer undefined » rend 401 lui aussi`, async () => {
    const res = await appeler(endpoint, 'le-vrai-secret', 'Bearer undefined')
    assert.strictEqual(res.code, 401)
  })

  test(`${nom} — sans en-tete et avec un secret pose, c est 401`, async () => {
    const res = await appeler(endpoint, 'le-vrai-secret', null)
    assert.strictEqual(res.code, 401)
  })
}

// ⚠ LE CONTROLE QUI EMPECHE LA RECHUTE — PAR LE COMPORTEMENT, PAS PAR LA FORME.
//
// Premiere version : une expression reguliere cherchait `if (!process.env.
// CRON_SECRET` dans le texte des fichiers. Une review l'a eprouvee par sept
// mutations, et elle se trompait DANS LES DEUX SENS :
//
//   garde correcte hoistee (`const S = process.env.CRON_SECRET; if (!S)`)  -> ROUGE a tort
//   garde correcte avec une espace (`if (! process.env.CRON_SECRET)`)      -> ROUGE a tort
//   garde presente mais EN COMMENTAIRE                                     -> vert a tort
//   garde presente mais MORTE (pas de `return`)                            -> vert a tort
//   garde placee APRES la comparaison, donc inutile                        -> vert a tort
//
// Le premier faux positif etait le plus couteux : `const SECRET = process.env.X`
// puis `if (!SECRET || ...)` est l'idiome DOMINANT du depot pour ce genre de
// garde — les deux webhooks l'ecrivent ainsi. Un garde-fou qui rougit sur
// l'ecriture usuelle pousse a de-hoister du code juste pour le faire taire.
//
// On ne cherche donc plus la FORME du garde : on APPELLE chaque endpoint qui
// lit `CRON_SECRET`, sans la variable, et on exige qu'il refuse. Un garde en
// commentaire, mort, ou place trop tard ne refuse pas — et se voit.
test('LE TEST QUI COMPTE : tout endpoint qui lit CRON_SECRET REFUSE quand il est absent', async () => {
  const fs = require('node:fs')
  const dossier = path.join(__dirname, '..', 'api')
  const concernes = fs.readdirSync(dossier)
    .filter(f => f.endsWith('.js'))
    .filter(f => /process\.env\.CRON_SECRET/.test(fs.readFileSync(path.join(dossier, f), 'utf8')))

  // ⚠ SI LA LISTE SE VIDE, LE TEST NE PROUVE PLUS RIEN. Un renommage de la
  // variable, un deplacement des endpoints : le balayage rendrait « aucun
  // fautif » sur zero fichier examine, et passerait au vert pour de bon.
  assert.ok(concernes.length >= 2,
    `au moins deux endpoints devraient lire CRON_SECRET, ${concernes.length} trouve(s) : `
    + `la variable a-t-elle ete renommee, ou les endpoints deplaces ?`)

  const fautifs = []
  for (const f of concernes) {
    const chemin = `../api/${f.replace(/\.js$/, '')}`
    const avant = process.env.CRON_SECRET
    delete process.env.CRON_SECRET
    preparer()
    try {
      const handler = require(chemin)
      if (typeof handler !== 'function') continue   // pas un endpoint HTTP
      const res = reponse()
      // ⚠ LES DEUX FORMES D'AUTORISATION QU'ON A VUES DANS CE DEPOT : l'en-tete
      // (les crons) et la query (`api/backfill-beds24-host.js`). On envoie les
      // deux, chacune avec la valeur qu'un attaquant deduirait d'une variable
      // absente.
      await handler({
        method: 'POST', body: {}, query: { secret: 'undefined' },
        headers: { authorization: 'Bearer undefined' },
      }, res)
      // Refuser, c'est 4xx ou 5xx. Tout le reste — 200, ou pas de reponse du
      // tout — veut dire que la porte s'est ouverte.
      if (!(res.code >= 400)) fautifs.push(`${f} (rendu : ${res.code === null ? 'aucune reponse' : res.code})`)
    } catch (e) {
      // Une exception au chargement n'est pas une porte ouverte, mais elle
      // empeche de conclure : on le DIT plutot que de compter le fichier comme
      // sain.
      fautifs.push(`${f} (inexaminable : ${String(e.message).slice(0, 60)})`)
    } finally {
      if (avant === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = avant
    }
  }
  assert.deepStrictEqual(fautifs, [],
    `ces endpoints ne refusent pas quand CRON_SECRET est absent : ${fautifs.join(' | ')}`)
})
