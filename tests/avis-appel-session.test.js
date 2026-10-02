// tests/avis-appel-session.test.js — l'appel du domaine avis porte la session
// MEME quand la page ne publie pas `window._supabase` (recette du 2 octobre
// 2026 : fiche prestataire et calendriers partaient sans jeton → « Non autorisé »).
const test = require('node:test')
const assert = require('node:assert')

let creerAppel
test.before(async () => { ({ creerAppel } = await import('../core/avis/appel.js')) })

const session = (jeton) => ({ auth: { getSession: async () => ({ data: { session: { access_token: jeton } } }) } })
function fauxFetch () {
  const appels = []
  const fn = async (url, opts) => { appels.push({ url, opts }); return { ok: true, json: async () => ({ ok: true }) } }
  return { appels, fn }
}

test('LE TEST QUI COMPTE : sans window._supabase, le jeton vient du client partage', async () => {
  const f = fauxFetch()
  const appel = creerAppel({ global: {}, fetch: f.fn, supabase: session('jeton-partage') })
  await appel('avis?action=prestataire-reglages-maj', { methode: 'POST', corps: { a: 1 } })
  assert.strictEqual(f.appels[0].opts.headers.Authorization, 'Bearer jeton-partage')
})

test('la session publiee par la page reste prioritaire', async () => {
  const f = fauxFetch()
  const appel = creerAppel({ global: { _supabase: session('jeton-page') }, fetch: f.fn, supabase: session('autre') })
  await appel('avis?action=grille')
  assert.strictEqual(f.appels[0].opts.headers.Authorization, 'Bearer jeton-page')
})

test('sans aucune session, la requete part sans jeton et le serveur tranche', async () => {
  const f = fauxFetch()
  const appel = creerAppel({ global: {}, fetch: f.fn, supabase: null })
  await appel('avis?action=grille')
  assert.strictEqual(f.appels[0].opts.headers.Authorization, undefined)
})
