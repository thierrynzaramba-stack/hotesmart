// tests/cron-messages-dedie.test.js
// L'IMPORT DES MESSAGES A SON PROPRE CRON.
//
// ⚠ POURQUOI IL A FALLU L'EN SORTIR, MESURE SUR QUATRE CYCLES CONSECUTIFS
// (15 septembre 2026, production) :
//   Colomiers     abstentions 130 -> 133   motif = budget
//   Ofuro Futari  abstentions 131 -> 134   motif = budget
//   La bulle      abstentions 130 -> 133   motif = cycle_en_retard
//   Coeur de vie  abstentions 127 -> 130   motif = cycle_en_retard
// Les deux premiers biens consommaient les 8 s du parc sans aboutir, les deux
// suivants n'etaient MEME PAS APPELES. Marqueur a `null` depuis 133 cycles,
// 1189 messages en base inchanges d'un bout a l'autre.
//
// ⚠ ET `BUDGET_MS` N'ETAIT PAS LE LEVIER : `cycle_en_retard` se decide AVANT
// lui. C'est l'ORDRE DE PASSAGE qui affamait l'import.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CRON_SECRET = 'secret-de-test'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const BIENS = [
  { id: 'u1', user_id: 'hote', provider_property_id: 'p1', name: 'La bulle' },
  { id: 'u2', user_id: 'hote', provider_property_id: 'p2', name: 'Colomiers' }
]

function preparer ({ biens = BIENS, erreurBiens = null, importJette = false,
                     surImport = null } = {}) {
  const etat = { imports: [], budgets: [], filtres: {}, table: null, colonnes: null, borne: null }
  // ⚠ LE DOUBLE MEMORISE LES FILTRES, et son mutisme a laisse passer le
  // retrecissement du perimetre : il resolvait `not()` quel que soit le
  // `select`, donc retirer le filtre de provider n'aurait fait rougir aucun
  // test. Un double qui ne regarde pas ce qu'on lui demande ne teste pas la
  // requete, il teste la plomberie (REVIEW.md regle 8).
  const client = {
    from (table) {
      etat.table = table
      const chain = {
        select (cols) { etat.colonnes = cols; return chain },
        eq (c, v) { etat.filtres[c] = v; return chain },
        in (c, v) { etat.filtres[c + '_in'] = v; return chain },
        not (c, op, v) { etat.filtres[c + '_not'] = op + ' ' + v; return chain },
        // ⚠ C'EST `limit` QUI RESOUT, parce que c'est le DERNIER maillon de la
        // vraie requete. Faire resoudre `not` rendait la chaine plus courte que
        // la vraie : `.limit()` n'existait plus, et le double levait au premier
        // appel. Il vaut mieux qu'il leve que d'accepter une forme que
        // PostgREST refuserait — mais il devait suivre la requete, pas
        // l'inverse.
        limit (n) {
          etat.borne = n
          return Promise.resolve(erreurBiens ? { data: null, error: erreurBiens }
                                             : { data: biens, error: null })
        }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m

  const absSync = require.resolve(path.join(__dirname, '..', 'lib/cron-channel-messages-sync.js'))
  const vrai = require('../lib/cron-channel-messages-sync')
  const ms = new Module(absSync)
  ms.exports = {
    ...vrai,
    ordonnerPourImport: async (_s, props) => props,
    importerMessagesDuBien: async (_s, bien, opts) => {
      if (surImport) surImport()
      if (importJette) throw new Error('panne ' + bien.provider_property_id)
      etat.imports.push(bien.provider_property_id)
      etat.budgets.push({ echeance: opts.echeance, budgetBienMs: opts.budgetBienMs })
      opts.results.messagesImportes = (opts.results.messagesImportes || 0) + 3
    }
  }
  ms.loaded = true
  require.cache[absSync] = ms

  try { delete require.cache[require.resolve('../api/cron-messages')] } catch {}
  return { etat, handler: require('../api/cron-messages') }
}

const reponse = () => { const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }; r.json = b => { r.body = b; return r }; return r }
const req = (o = {}) => ({ method: 'GET', headers: { authorization: 'Bearer secret-de-test' }, ...o })

// ─── La garde ──────────────────────────────────────────────────────────────

test('sans CRON_SECRET configure, l endpoint est FERME — 503, pas ouvert', async () => {
  // ⚠ Sans cette garde, un deploiement ou la variable manque compare au
  // litteral `Bearer undefined` — qu il suffit d envoyer.
  const vrai = process.env.CRON_SECRET
  delete process.env.CRON_SECRET
  try {
    const { etat, handler } = preparer({})
    const res = reponse()
    await handler({ method: 'GET', headers: { authorization: 'Bearer undefined' } }, res)
    assert.strictEqual(res.code, 503)
    assert.strictEqual(etat.imports.length, 0)
  } finally { process.env.CRON_SECRET = vrai }
})

test('sans le secret, le cron ne fait RIEN — 401', async () => {
  // ⚠ Un import declenchable de l'exterieur serait un moyen de faire ecrire la
  // base par n'importe qui, et de bruler le quota d'appels Channex de l'hote.
  for (const h of [{}, { authorization: 'Bearer faux' }, { authorization: 'secret-de-test' }]) {
    const { etat, handler } = preparer({})
    const res = reponse()
    await handler({ method: 'GET', headers: h }, res)
    assert.strictEqual(res.code, 401, JSON.stringify(h))
    assert.strictEqual(etat.imports.length, 0)
  }
})

// ─── Le budget, qui est toute la raison d'etre de ce cron ──────────────────

test('chaque bien recoit un budget PROPRE, bien plus large que dans le cycle', async () => {
  // ⚠ LE CŒUR DU LOT. Dans le cycle principal, l'import se contentait de ce qui
  // restait apres les codes d'acces : 8 s pour tout le parc. Seul, il dispose
  // des 60 s de sa fonction.
  const { etat, handler } = preparer({})
  await handler(req(), reponse())
  const { BUDGET_BIEN_DEDIE_MS, BUDGET_PARC_DEDIE_MS, BUDGET_MS } =
    require('../lib/cron-channel-messages-sync')
  assert.strictEqual(etat.budgets.length, 2)
  for (const b of etat.budgets) {
    assert.strictEqual(b.budgetBienMs, BUDGET_BIEN_DEDIE_MS)
  }
  assert.ok(BUDGET_BIEN_DEDIE_MS > BUDGET_MS,
    'le budget dedie doit depasser celui du cycle, sinon rien ne change')
  assert.ok(BUDGET_PARC_DEDIE_MS <= 55000,
    'et rester sous les 60 s de la fonction, avec de la marge pour repondre')
})

test('UNE SEULE echeance pour tout le parc, posee au demarrage', async () => {
  // ⚠ LECON DU BLOQUANT 4 : une echeance posee avant la boucle metier mesure le
  // CYCLE, pas l'import. Ici la boucle n'a rien devant elle.
  const { etat, handler } = preparer({})
  await handler(req(), reponse())
  assert.strictEqual(new Set(etat.budgets.map(b => b.echeance)).size, 1,
    'les deux biens partagent la meme echeance de parc')
})

// ─── Le comportement ──────────────────────────────────────────────────────

test('tous les biens sont importes, et le bilan les compte', async () => {
  const { etat, handler } = preparer({})
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(etat.imports, ['p1', 'p2'])
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.biens, 2)
  assert.strictEqual(res.body.importes, 6)
})

test('une panne sur UN bien ne prive pas les suivants', async () => {
  // Meme regle que dans le cycle principal : son propre `try`, par bien.
  const { etat, handler } = preparer({ importJette: true })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 200, 'le cron aboutit quand meme')
  assert.strictEqual(res.body.erreurs, 2, 'les deux pannes sont comptees')
  assert.strictEqual(etat.imports.length, 0)
})

test('les erreurs sont DANS LE CORPS, jamais dans le code HTTP', async () => {
  // ⚠ « Diagnostiquer un cron = lire results.errors, pas le code HTTP » — 24 h
  // de panne totale invisible derriere un 200, le 10 septembre 2026. Et un 500
  // ferait retenter Vercel sur un travail deja absorbe par bien.
  const { handler } = preparer({ importJette: true })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 200)
  assert.ok(Array.isArray(res.body.errors) && res.body.errors.length === 2)
  assert.match(res.body.errors[0].error, /panne/)
})

test('une lecture des biens en echec COUPE, elle n importe rien', async () => {
  const { etat, handler } = preparer({ erreurBiens: { message: 'timeout' } })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(etat.imports.length, 0)
})

// ─── Le cablage, qui ne se suppose pas ────────────────────────────────────

test('l import N EST PLUS dans le cycle principal — un seul appelant', async () => {
  // ⚠ DEUX APPELANTS = DEUX PASSES CONCURRENTES sur le meme bien. Elles ne se
  // corrompraient pas — le marqueur est un upsert, `recordMessage` deduplique —
  // mais doubleraient le cout et rendraient les mesures illisibles. Et c'est
  // surtout le retour exact du defaut qu'on vient de mesurer.
  const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  assert.ok(!/importerMessagesDuBien\s*\(/.test(lire('lib/cron-channel-props.js')),
    'le cycle principal ne doit plus importer les messages')
  assert.match(lire('api/cron-messages.js'), /importerMessagesDuBien\(/,
    'et le cron dedie, si')
})

test('le PERIMETRE couvre la marque blanche, pas seulement `channex`', async () => {
  // ⚠ LE DEFAUT TROUVE EN REVIEW, ET C'ETAIT UNE PANNE MUETTE. `'channel'` est
  // la valeur MARQUE BLANCHE, traitee en paire partout dans le depot, et
  // `properties.provider` n'a aucune contrainte qui l'empeche. Filtrer sur le
  // seul `'channex'` faisait disparaitre ces biens de la file : pas d'erreur,
  // pas d'abstention, pas d'incident — leur marqueur n'aurait plus jamais bouge
  // et `messages_import_suspendu` n'aurait pas pu partir.
  const { etat, handler } = preparer({})
  await handler(req(), reponse())
  assert.strictEqual(etat.table, 'properties')
  assert.deepStrictEqual(etat.filtres.provider_in, ['channex', 'channel'],
    'les deux valeurs du couple channel-manager')
  assert.strictEqual(etat.filtres.provider, undefined,
    'et pas un `eq` sur une seule')
  // ⚠ Et la lecture est BORNEE : Supabase tronque a 1000 lignes sans erreur.
  assert.ok(etat.borne > 0, 'la lecture des biens est bornee explicitement')
})

test('passe l echeance du parc, les biens restants ne sont PAS touches', async () => {
  // ⚠ Chaque bien non atteint faisait une lecture d etat PUIS un upsert
  // d abstention `cycle_en_retard` — pour un bien qu on n a meme pas essaye.
  // Ca pollue le compteur qui a servi a diagnostiquer le blocage, et ferait
  // partir le rappel periodique pour une file d attente normale, pas pour une
  // panne. Ne rien ecrire est mieux : `ordonnerPourImport` les fait passer en
  // tete a la passe suivante.
  //
  // ⚠ HORLOGE PILOTEE, PAS DE MINUTERIE. Une premiere version avancait le temps
  // avec un `setInterval` : le test ne rendait jamais la main. Ici c est le
  // premier import qui consomme le budget, de facon exacte et reproductible.
  const { BUDGET_PARC_DEDIE_MS } = require('../lib/cron-channel-messages-sync')
  const vraiNow = Date.now
  let horloge = 1000000
  Date.now = () => horloge
  try {
    const { etat, handler } = preparer({
      // Le premier bien brule tout le budget du parc.
      surImport: () => { horloge += BUDGET_PARC_DEDIE_MS + 1 }
    })
    const res = reponse()
    await handler(req(), res)
    assert.deepStrictEqual(etat.imports, ['p1'], 'seul le premier bien est tente')
    assert.strictEqual(res.body.traites, 1)
    assert.strictEqual(res.body.non_atteints, 1, 'et le bilan le DIT')
  } finally { Date.now = vraiNow }
})

test('le cron est DECLARE dans vercel.json, sinon il ne tourne jamais', async () => {
  // ⚠ Un endpoint sans entree de cron est un fichier mort : rien ne l appelle,
  // et l import resterait bloque en silence — avec, en plus, l illusion d avoir
  // corrige. C est le pendant de « une migration ecrite n est pas une migration
  // appliquee ».
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'))
  const c = (v.crons || []).find(x => x.path === '/api/cron-messages')
  assert.ok(c, 'le cron dedie doit etre declare')
  assert.match(c.schedule, /^\*\/\d+ \* \* \* \*$/, 'a une cadence reguliere')
  const f = (v.functions || {})['api/cron-messages.js']
  assert.ok(f && f.maxDuration >= 60,
    'avec sa duree maximale — sinon il est coupe avant la fin, comme avant')
  // ⚠ LE BUDGET DU PARC DOIT TENIR DANS LA DUREE DECLAREE, avec de la marge
  // pour repondre et ecrire les etats. Les deux valeurs vivent dans deux
  // fichiers : rien ne les relie, sauf ce test.
  const { BUDGET_PARC_DEDIE_MS } = require('../lib/cron-channel-messages-sync')
  assert.ok(BUDGET_PARC_DEDIE_MS + 10000 <= f.maxDuration * 1000,
    `budget parc ${BUDGET_PARC_DEDIE_MS} ms contre maxDuration ${f.maxDuration} s : `
    + 'il faut au moins 10 s de marge')
  // Et le cycle principal garde la sienne.
  assert.ok((v.crons || []).some(x => x.path === '/api/cron'))
})
