// tests/messages-fenetre-recents.test.js
//
// `getPropertyMessages` borne sa lecture a MESSAGES_MAX. La question que ce
// fichier pose est : QUELS messages la limite garde ?
//
// Le defaut qu'il ferme : l'ordre etait ASCENDANT, donc la limite rendait les
// plus VIEUX messages de la fenetre et laissait tomber les plus recents.
// L'appelant (cron-classify) calcule `lastGuestTime` sur ce qu'il recoit :
// un fil ampute de sa FIN lui fait croire que le dernier mot est ancien, la
// garde « derniere reponse >= dernier message du voyageur » se satisfait a
// tort, et l'agent se tait sur un fil qui attend. Muet, donc invisible.
//
// ⚠ CE TEST PILOTE L'UNITE, il ne lit pas le source. Un `includes('ascending:
// false')` passerait aussi bien sur un code qui trie correctement puis rend le
// tableau a l'envers. Ici on injecte un faux PostgREST qui applique VRAIMENT
// l'ordre et la limite, et on regarde ce qui ressort.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

// ─── Faux client Supabase : applique ordre + limite comme PostgREST ──────────
function fauxClient (lignes) {
  const etat = { asc: true, limite: null, filtres: {} }
  const chain = {
    from () { return chain },
    select () { return chain },
    eq (col, val) { etat.filtres[col] = val; return chain },
    gte (col, val) { etat.filtres['gte:' + col] = val; return chain },
    order (col, opts) { etat.asc = !(opts && opts.ascending === false); return chain },
    limit (n) { etat.limite = n; return chain },
    then (resolve) {
      const tri = [...lignes].sort((a, b) =>
        etat.asc ? a.sent_at.localeCompare(b.sent_at) : b.sent_at.localeCompare(a.sent_at))
      resolve({ data: tri.slice(0, etat.limite || tri.length), error: null })
    }
  }
  return { from: chain.from, _etat: etat }
}

// Injecte le faux paquet AVANT que channex.js ne le require.
function chargerChannex (lignes) {
  const client = fauxClient(lignes)
  const vrai = Module._load
  Module._load = function (req, parent, isMain) {
    if (req === '@supabase/supabase-js') return { createClient: () => client }
    if (req === '../record-message') return { recordMessage: async () => ({ ok: true }) }
    return vrai.apply(this, arguments)
  }
  delete require.cache[require.resolve('../lib/channels/channex')]
  try {
    return { mod: require('../lib/channels/channex'), client }
  } finally {
    Module._load = vrai
    delete require.cache[require.resolve('../lib/channels/channex')]
  }
}

// 600 messages sur 20 jours : au-dela de MESSAGES_MAX (500), donc la limite mord.
function jeu (n) {
  const base = Date.now() - 20 * 24 * 3600 * 1000
  return Array.from({ length: n }, (_, i) => ({
    booking_id: 'B1',
    direction: i % 2 ? 'outbound' : 'inbound',
    sender: i % 2 ? 'host' : 'guest',
    body: 'msg-' + i,
    sent_at: new Date(base + i * 60 * 1000).toISOString()
  }))
}

test('la limite garde les messages les PLUS RECENTS, pas les plus anciens', async () => {
  const lignes = jeu(600)
  const { mod } = chargerChannex(lignes)
  const out = await mod.getPropertyMessages({ userId: 'u1', providerPropertyId: 'P1' })

  assert.strictEqual(out.length, 500, 'la limite doit mordre')
  const rendus = new Set(out.map(m => m.message))
  // Le tout dernier message du fil DOIT etre la : c'est celui sur lequel
  // l'appelant decide s'il repond.
  assert.ok(rendus.has('msg-599'), 'le message le plus recent doit etre rendu')
  // Le tout premier, lui, est celui que la limite doit sacrifier.
  assert.ok(!rendus.has('msg-0'), 'le plus ancien doit etre celui qu on laisse tomber')
})

test('le fil est rendu en ordre chronologique croissant', async () => {
  const { mod } = chargerChannex(jeu(600))
  const out = await mod.getPropertyMessages({ userId: 'u1', providerPropertyId: 'P1' })
  const temps = out.map(m => m.time)
  const trie = [...temps].sort((a, b) => a.localeCompare(b))
  assert.deepStrictEqual(temps, trie, 'l appelant attend un fil chronologique')
})

test('le compte est exige et filtre', async () => {
  const { mod, client } = chargerChannex(jeu(3))
  const sans = await mod.getPropertyMessages({ providerPropertyId: 'P1' })
  assert.deepStrictEqual(sans, [], 'sans userId, refus')

  await mod.getPropertyMessages({ userId: 'u42', providerPropertyId: 'P1' })
  assert.strictEqual(client._etat.filtres.user_id, 'u42',
    'la lecture doit etre cloisonnee par compte (cle provider sans unicite globale)')
})
