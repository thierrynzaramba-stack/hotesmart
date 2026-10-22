// tests/diagnostic-cout-du-cron.test.js
// LE CLASSEMENT DU COUT DU CRON SUR LA PAGE DE DIAGNOSTIC, ET SA PORTE.
//
// ⚠ POURQUOI UNE GARDE SERVEUR ET PAS UN MASQUAGE. Regle absolue du depot :
// un element masque parce que l'utilisateur n'y a pas droit se double d'une
// garde serveur, et le test qui tranche est « si on retire le masquage et
// qu'on clique, le serveur refuse-t-il ? ». Ici il n'y a meme PAS de
// masquage — la carte est visible sur une page de developpement — donc la
// garde serveur est la seule chose qui tient. Elle est eprouvee ici dans les
// trois cas : pas de session, session valide mais pas le fondateur, et
// variable de configuration absente.
//
// ⚠ ET `domaine: 'titulaire'` NE FILTRE RIEN TOUT SEUL. Sans ressource
// designee, le compte cible est celui de l'appelant, qui en est titulaire par
// definition : c'est ecrit dans lib/require-permission.js, et c'est exactement
// le defaut du 19 octobre 2026 sur la creation d'un bien. La garde du
// fondateur est donc VERIFIEE au-dela de lui.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const FONDATEUR = { id: 'f0000000-0000-4000-8000-000000000001', email: 'fondateur@exemple.fr' }
const HOTE = { id: 'a0000000-0000-4000-8000-000000000002', email: 'un.hote@exemple.fr' }

const MODULES = ['../api/diagnostic', '../lib/require-permission', '../lib/reponse-partenaire', '../lib/cron-stats']

const LIGNES = [
  { cron: 'cron', tache: 'lente_sans_requete', passages: 10, appels: 10, ms: 90000, requetes: 0, externes: 0, travail: 0 },
  { cron: 'cron', tache: 'dispatch_changements', passages: 10, appels: 10, ms: 20000, requetes: 1800, externes: 40, travail: 30 },
  { cron: 'cron', tache: 'sonde_croissance', passages: 10, appels: 10, ms: 1000, requetes: 1800, externes: 0, travail: 0 },
]

function preparer ({ utilisateur = FONDATEUR, rpc = null, lignes = LIGNES } = {}) {
  const vus = []
  const client = {
    auth: {
      getUser: async () => utilisateur
        ? ({ data: { user: utilisateur }, error: null })
        : ({ data: null, error: { message: 'invalide' } }),
    },
    from () {
      const q = {
        select () { return q }, eq () { return q }, order () { return q },
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then (ok, ko) { return Promise.resolve({ data: [], error: null }).then(ok, ko) },
      }
      return q
    },
    rpc: async (nom, args) => {
      vus.push({ nom, args })
      if (rpc) return rpc(nom, args)
      if (nom === 'cron_stats_classement') return { data: lignes, error: null }
      return { data: [{ jour: '2026-10-22', cron: 'cron', passages: 288, ms: 11520000, requetes: 89000, externes: 400 }], error: null }
    },
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return { vus }
}

function reponse () {
  const r = { code: 200, body: null }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}

async function appeler (query = {}, { jeton = 'un-jeton', fondateur = FONDATEUR.email, ...reste } = {}) {
  const etat = preparer(reste)
  const avant = process.env.FOUNDER_EMAIL
  if (fondateur === null) delete process.env.FOUNDER_EMAIL
  else process.env.FOUNDER_EMAIL = fondateur
  try {
    const handler = require('../api/diagnostic')
    const res = reponse()
    await handler({ method: 'GET', query: { check: 'cron_stats', ...query }, headers: jeton ? { authorization: `Bearer ${jeton}` } : {} }, res)
    return { res, ...etat }
  } finally {
    if (avant === undefined) delete process.env.FOUNDER_EMAIL
    else process.env.FOUNDER_EMAIL = avant
  }
}

// ─── La porte ───────────────────────────────────────────────────────────────

test('sans session : 401, et aucun chiffre', async () => {
  const { res } = await appeler({}, { jeton: null })
  assert.equal(res.code, 401)
  assert.equal(res.body.classement, undefined)
})

test('session invalide : 401', async () => {
  const { res } = await appeler({}, { utilisateur: null })
  assert.equal(res.code, 401)
})

test('⚠ UN HOTE CONNECTE EST REFUSE EN 403, ET LE CORPS NE PORTE AUCUN CHIFFRE', async () => {
  // Le cout de la plateforme — quelles taches tournent, a quelle cadence, pour
  // quel volume — n'est pas une donnee de client.
  const { res, vus } = await appeler({}, { utilisateur: HOTE })
  assert.equal(res.code, 403)
  assert.equal(res.body.error, 'Réservé au fondateur')
  assert.equal(res.body.classement, undefined)
  assert.equal(res.body.par_jour, undefined)
  // ⚠ ET LE REFUS EST PRONONCE AVANT LA LECTURE : aucune requete d'agregation
  // n'est partie. Un refus apres la lecture laisse fuir par les temps de
  // reponse, et coute la lecture pour rien.
  assert.equal(vus.length, 0)
})

test('⚠ FOUNDER_EMAIL absente : refus, et le refus DIT sa cause', async () => {
  // Sans ce motif, une variable manquante sur un projet se lit « je n'ai pas
  // le droit » et on cherche du cote des droits. Lecon du 30 septembre 2026 :
  // un diagnostic qui ne diagnostique pas sa propre porte est inutile.
  const { res } = await appeler({}, { fondateur: null })
  assert.equal(res.code, 403)
  assert.match(res.body.motif, /FOUNDER_EMAIL/)
})

test('la comparaison du courriel ignore la casse et les espaces', async () => {
  const { res } = await appeler({}, {
    utilisateur: { ...FONDATEUR, email: '  FONDATEUR@Exemple.FR ' },
    fondateur: 'fondateur@exemple.fr',
  })
  assert.equal(res.code, 200)
})

// ─── Le classement ──────────────────────────────────────────────────────────

test('le fondateur lit le classement, trie par requetes puis par temps', async () => {
  const { res } = await appeler()
  assert.equal(res.code, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.classement.map(l => l.tache),
    ['dispatch_changements', 'sonde_croissance', 'lente_sans_requete'])
  assert.equal(res.body.par_jour[0].passages, 288)
})

test('la fenetre vaut 24 h par defaut, 7 jours sur demande, et rien d autre', async () => {
  const d24 = await appeler()
  assert.equal(d24.res.body.fenetre, '24h')
  const d7 = await appeler({ fenetre: '7j' })
  assert.equal(d7.res.body.fenetre, '7j')
  // Une fenetre inventee retombe sur 24 h : le client ne choisit pas la taille
  // d'une lecture.
  const dBidon = await appeler({ fenetre: '400j' })
  assert.equal(dBidon.res.body.fenetre, '24h')
  const ecart = (d) => Date.parse(d.res.body.depuis)
  assert.ok(ecart(d24) - ecart(d7) > 140 * 3600 * 1000, '7j remonte bien plus loin que 24h')
})

test('⚠ la limite venant du client est PLAFONNEE', async () => {
  const beaucoup = Array.from({ length: 500 }, (_, i) => ({
    cron: 'cron', tache: `t${i}`, passages: 1, appels: 1, ms: i, requetes: i, externes: 0, travail: 0,
  }))
  const { res } = await appeler({ limite: '9999' }, { lignes: beaucoup })
  assert.equal(res.body.classement.length, 200)
  assert.equal(res.body.taches_mesurees, 500, 'le total vu reste dit')
  const { res: r2 } = await appeler({ limite: 'beaucoup' }, { lignes: beaucoup })
  assert.equal(r2.body.classement.length, 10, 'une limite illisible retombe sur dix')
})

test('⚠ la migration non appliquee se dit en clair, pas en « erreur serveur »', async () => {
  const { res } = await appeler({}, {
    rpc: () => ({ data: null, error: { message: 'Could not find the function public.cron_stats_classement' } }),
  })
  assert.equal(res.code, 503)
  assert.match(res.body.error, /migration 2026-10-22-cron-stats/)
})

test('un check inconnu reste refuse', async () => {
  const etat = preparer()
  const handler = require('../api/diagnostic')
  const res = reponse()
  await handler({ method: 'GET', query: { check: 'cout_du_cron' }, headers: {} }, res)
  assert.equal(res.code, 400)
  assert.equal(etat.vus.length, 0)
})
