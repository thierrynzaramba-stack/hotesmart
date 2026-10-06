// tests/avis-lire-avis-channex.test.js — « l'evaluation est-elle deja partie ? »
// (lib/channels/channex.js `lireAvis`). Constat de securite de la revue de
// 9f76ae2 : seule la PREUVE dit « partie » ; son absence dit « je ne sais pas »,
// jamais « pas partie » — sinon un second envoi part chez Airbnb.
const test = require('node:test')
const assert = require('node:assert')

// Le module cree son client Supabase au chargement : des valeurs factices
// suffisent, aucun appel ne part vers la base.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://exemple.supabase.co'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-factice'

function lireAvecReponse (attributes) {
  const avant = global.fetch
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { attributes } }) })
  delete require.cache[require.resolve('../lib/channels/channex')]
  const { lireAvis } = require('../lib/channels/channex')
  return lireAvis('rev-1').finally(() => { global.fetch = avant })
}

test('LE TEST QUI COMPTE : reply.guest_review present → partie', async () => {
  const r = await lireAvecReponse({ reply: { guest_review: { public_review: 'Merci' } }, expired_at: '2026-10-20T00:00:00' })
  assert.strictEqual(r.is_replied, true)
})

test('LE TEST QUI COMPTE : reply nul ou vide → « je ne sais pas », JAMAIS « pas partie »', async () => {
  for (const reply of [null, {}]) {
    const r = await lireAvecReponse({ reply })
    assert.strictEqual(r.is_replied, undefined, JSON.stringify(reply))
  }
  const sansCle = await lireAvecReponse({ is_hidden: true })
  assert.strictEqual(sansCle.is_replied, undefined)
})
