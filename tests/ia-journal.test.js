// tests/ia-journal.test.js — le journal unique des appels IA (lib/ia/journal.js,
// spec docs/specs/spec-journal-ia.md) : une ligne par appel, succes comme echec,
// avec le contexte pose par l'appelant ; le cout ; et le journal ne casse
// jamais l'appel.

const test = require('node:test')
const assert = require('node:assert/strict')
const { envelopper, avecContexteIA, ligneDAppel, coutUsd } = require('../lib/ia/journal')

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const REPONSE = { model: 'claude-haiku-4-5-20251001', usage: USAGE, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }

function baseFactice ({ insertion = async () => ({ error: null }) } = {}) {
  const lignes = []
  return { lignes, from (t) { return { insert: async (l) => { lignes.push({ table: t, ...l }); return insertion(l) } } } }
}
const clientFactice = (create) => ({ messages: { create }, autre: 'garde' })

test('LE TEST QUI COMPTE : un appel reussi ecrit UNE ligne — fonction, compte, bien, sejour, modele servi, tokens, cout', async () => {
  const sb = baseFactice()
  let t = 1000
  const client = envelopper(clientFactice(async () => { t += 250; return REPONSE }), { sb, horloge: () => t })
  const r = await avecContexteIA({ userId: 'u1', propertyId: '209413' }, () =>
    avecContexteIA({ fonction: 'avis_proprete', bookingId: 'b9' }, () => client.messages.create({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'SECRET DU PROMPT' }] })))
  assert.equal(r, REPONSE, 'la reponse passe intacte')
  assert.equal(sb.lignes.length, 1)
  const l = sb.lignes[0]
  assert.equal(l.table, 'ia_appels')
  assert.deepEqual({ fonction: l.fonction, user_id: l.user_id, property_id: l.property_id, booking_id: l.booking_id, modele: l.modele },
    { fonction: 'avis_proprete', user_id: 'u1', property_id: '209413', booking_id: 'b9', modele: 'claude-haiku-4-5-20251001' })
  assert.deepEqual([l.input_tokens, l.output_tokens, l.cout_usd, l.duree_ms, l.ok, l.erreur], [1000, 200, 0.002, 250, true, null])
  assert.ok(!JSON.stringify(sb.lignes).includes('SECRET DU PROMPT'), 'jamais le texte envoye')
})

test('LE TEST QUI COMPTE : un echec ecrit sa ligne (ok=false), previent la facturation, et RELANCE l erreur telle quelle', async () => {
  const sb = baseFactice()
  const vus = []
  const erreur = Object.assign(new Error('Your credit balance is too low'), { status: 400 })
  const client = envelopper(clientFactice(async () => { throw erreur }), { sb, surErreur: async (e) => { vus.push(e) } })
  await assert.rejects(avecContexteIA({ fonction: 'guestflow', userId: 'u1' }, () => client.messages.create({ model: 'claude-sonnet-5-5' })), e => e === erreur)
  assert.deepEqual(vus, [erreur])
  const l = sb.lignes[0]
  assert.deepEqual([l.fonction, l.ok, l.modele, l.cout_usd, l.input_tokens], ['guestflow', false, 'claude-sonnet-5-5', null, null])
  assert.match(l.erreur, /credit balance/)
})

test('un appel SANS contexte est journalise quand meme, sous « inconnue »', async () => {
  const sb = baseFactice()
  await envelopper(clientFactice(async () => REPONSE), { sb }).messages.create({})
  assert.equal(sb.lignes[0].fonction, 'inconnue')
  assert.equal(sb.lignes[0].user_id, null)
})

test('le journal ne casse JAMAIS l appel : insertion en erreur, insertion qui leve, surErreur qui leve', async () => {
  const enErreur = envelopper(clientFactice(async () => REPONSE), { sb: baseFactice({ insertion: async () => ({ error: { message: 'relation "ia_appels" does not exist' } }) }) })
  assert.equal(await enErreur.messages.create({}), REPONSE)
  const quiLeve = envelopper(clientFactice(async () => REPONSE), { sb: baseFactice({ insertion: async () => { throw new Error('reseau') } }) })
  assert.equal(await quiLeve.messages.create({}), REPONSE)
  const erreur = new Error('panne')
  const surErreurLeve = envelopper(clientFactice(async () => { throw erreur }), { sb: baseFactice(), surErreur: async () => { throw new Error('brevo') } })
  await assert.rejects(surErreurLeve.messages.create({}), e => e === erreur, 'c est l erreur de l appel qui remonte')
})

test('l enveloppe ne touche que messages.create', async () => {
  const c = envelopper(clientFactice(async () => REPONSE), { sb: baseFactice() })
  assert.equal(c.autre, 'garde')
})

test('les contextes s emboitent : une valeur absente n efface pas celle du parent, et rien ne fuit hors du bloc', async () => {
  await avecContexteIA({ userId: 'u1', propertyId: 'p1' }, async () => {
    await avecContexteIA({ fonction: 'x', propertyId: null }, async () => {
      const l = ligneDAppel({ contexte: require('../lib/ia/journal').contexteIA() })
      assert.deepEqual([l.user_id, l.property_id, l.fonction], ['u1', 'p1', 'x'])
    })
  })
  assert.deepEqual(require('../lib/ia/journal').contexteIA(), {})
})

test('le cout : Haiku 4.5 et Sonnet 5.5 au tarif du 9 octobre 2026, cache compris ; un modele non tarife n a pas de cout (null, jamais 0)', () => {
  assert.equal(coutUsd('claude-haiku-4-5-20251001', { input_tokens: 1e6, output_tokens: 1e6 }), 6)
  assert.equal(coutUsd('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 2 + 10 + 0.2 + 2.5)
  assert.equal(coutUsd('claude-opus-5-5', { input_tokens: 10 }), null)
  assert.equal(ligneDAppel({ reponse: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } }).cout_usd, null)
})

test('une erreur est tronquee a 300 caracteres, et une cle n y passe jamais (revue de 3a9c75d)', () => {
  assert.equal(ligneDAppel({ erreur: new Error('x'.repeat(1000)) }).erreur.length, 300)
  const l = ligneDAppel({ erreur: new Error('invalid x-api-key sk-ant-api03-ABCDEFGHIJKLMNOP') })
  assert.doesNotMatch(l.erreur, /ABCDEFGHIJ/)
  assert.match(l.erreur, /<masque>/)
})

test('une ecriture LENTE ne fait pas pendre l appel : au-dela du delai, la reponse part (revue de 3a9c75d)', async () => {
  const { noterAppelIA } = require('../lib/ia/journal')
  const lente = { from: () => ({ insert: () => new Promise(() => {}) }) }
  const debut = Date.now()
  await noterAppelIA(lente, { fonction: 'x', ok: true }, { delaiMs: 30 })
  assert.ok(Date.now() - debut < 1000, 'rendu apres le delai, pas pendu')
})
