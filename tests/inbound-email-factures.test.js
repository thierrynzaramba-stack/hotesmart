// tests/inbound-email-factures.test.js — lot 5 (§14.24, §7) : l'AIGUILLAGE des
// adresses de factures dans api/inbound-email.js.
//
// CE QUE CES TESTS DÉFENDENT :
//   1. l'aiguillage se décide sur le destinataire RELU chez Brevo, jamais sur
//      celui du POST ;
//   2. il vient APRÈS la relecture et le refus d'une divergence, AVANT le
//      filtre des en-têtes automatiques et le refus d'un corps vide — mais le
//      score de spam s'applique ;
//   3. le chemin des voyageurs ne change pas : un e-mail de facture n'écrit
//      rien dans les fils, et le score de spam garde les voyageurs comme avant.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

process.env.SUPABASE_URL = 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = 'test'
process.env.ALERT_BREVO_API_KEY = 'cle-plateforme-de-test'
process.env.REPLY_TOKEN_SECRET = 'secret-de-test-suffisamment-long-pour-passer'

const etat = { brevo: null, ecritures: [], recus: [], issue: { issue: 'recue', trace: { prises: 1 } } }
const origine = Module._load
Module._load = function (d, ...reste) {
  if (d === '@supabase/supabase-js') return {
    createClient: () => ({
      from (table) {
        const b = {
          select: () => b, eq: () => b, gte: () => b, order: () => b, in: () => b,
          limit: async () => ({ data: [], error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
          insert: async (row) => { etat.ecritures.push({ table, row }); return { error: null } }
        }
        return b
      }
    })
  }
  if (d === '../lib/charges/email') return {
    recevoir: async (db, p, deps) => { etat.recus.push({ p, deps }); return etat.issue }
  }
  if (d === '../lib/record-message') return { recordMessage: async (o) => { etat.ecritures.push({ table: 'messages', row: o }); return { ok: true } } }
  if (d === '../lib/email-guestflow') return { envoyerHtml: async () => ({ ok: true }) }
  return origine.apply(this, [d, ...reste])
}
const fetchOrigine = global.fetch
global.fetch = async () => ({ ok: true, status: 200, json: async () => etat.brevo || {} })

const handler = require('../api/inbound-email.js')
const { adresseDeReponse } = require('../lib/jeton-reponse')
test.after(() => { Module._load = origine; global.fetch = fetchOrigine })

const FACTURES = 'la-bulle.k2j9x7q4@reply.hotesmart.fr'
const reponse = () => { const r = { code: null, corps: null }; r.status = c => { r.code = c; return r }; r.json = o => { r.corps = o; return r }; return r }
async function appel (item, relu) {
  etat.brevo = { recipient: FACTURES, sender: 'edf@edf.fr', subject: 'Votre facture', messageId: '<m1@edf.fr>', receivedAt: '2026-11-23T15:00:00Z', ...relu }
  const res = reponse()
  await handler({ method: 'POST', body: { items: [{ Uuid: ['uuid-1'], From: { Address: 'edf@edf.fr' }, Subject: 'Votre facture', MessageId: '<m1@edf.fr>', ...item }] } }, res)
  return res
}
const remettre = () => { etat.ecritures = []; etat.recus = []; etat.issue = { issue: 'recue', trace: { prises: 1 } } }

test('LE TEST QUI COMPTE : une adresse de factures RELUE part au chemin des factures — même avec List-Unsubscribe et sans aucun texte — et rien n\'entre dans les fils', async () => {
  remettre()
  const res = await appel({ Headers: { 'List-Unsubscribe': '<mailto:x>', Precedence: 'bulk' }, Attachments: [{ Name: 'f.pdf' }] })
  assert.equal(res.code, 200)
  assert.equal(res.corps.reason, 'factures_recue')
  assert.equal(etat.recus.length, 1)
  const { p, deps } = etat.recus[0]
  assert.equal(p.uuid, 'uuid-1')
  assert.equal(p.ref.recipient, FACTURES, 'la relecture, transmise telle quelle')
  assert.equal(p.expediteur, 'edf@edf.fr')
  assert.equal(p.sujet, 'Votre facture')
  assert.equal(p.texte, '', 'un e-mail de facture sans texte n\'est pas refusé')
  assert.equal(typeof p.debut, 'number')
  assert.equal(deps.cle, 'cle-plateforme-de-test')
  assert.deepEqual(etat.ecritures, [], 'ni conversation, ni message, ni tâche')
})

test('⚠ le POST ne choisit pas le chemin : To d\'une adresse de factures, mais destinataire RELU d\'un voyageur → chemin des voyageurs', async () => {
  remettre()
  const reponseVoyageur = adresseDeReponse('c87f24ce-9587-4d5e-841f-e8ef6d34edfd')
  const res = await appel({ To: [{ Address: FACTURES }], ExtractedMarkdownMessage: 'Bonjour' }, { recipient: reponseVoyageur })
  assert.equal(etat.recus.length, 0)
  assert.notEqual(res.corps.reason.startsWith('factures_'), true)
})

test('l\'aiguillage vient APRÈS le refus d\'une divergence : un POST qui contredit la relecture n\'atteint pas les factures', async () => {
  remettre()
  const res = await appel({ Subject: 'Autre chose' })
  assert.equal(res.corps.reason, 'payload_incoherent')
  assert.equal(etat.recus.length, 0)
})

test('le score de SPAM s\'applique aux factures (≥ 5 : ignoré, sans rien recevoir) ; sous le seuil, il passe', async () => {
  remettre()
  const res = await appel({ SpamScore: 6.2 })
  assert.equal(res.corps.reason, 'factures_spam_ignore')
  assert.equal(etat.recus.length, 0)
  const ok = await appel({ SpamScore: 3.3 })
  assert.equal(ok.corps.reason, 'factures_recue')
})

test('une panne du chemin des factures rend 503 (Brevo rejoue) ; une adresse refusée rend 200', async () => {
  remettre()
  etat.issue = { rejouer: true, raison: 'brevo_503' }
  const r1 = await appel({})
  assert.equal(r1.code, 503)
  assert.equal(r1.corps.reason, 'factures_panne')
  etat.issue = { issue: 'adresse_refusee', trace: { raison: 'adresse_inconnue' } }
  const r2 = await appel({})
  assert.equal(r2.code, 200)
  assert.equal(r2.corps.reason, 'factures_adresse_refusee')
})

test('⚠ le chemin des voyageurs n\'a pas bougé : leur score de spam les écarte toujours, avant toute réservation', async () => {
  remettre()
  const reponseVoyageur = adresseDeReponse('c87f24ce-9587-4d5e-841f-e8ef6d34edfd')
  const res = await appel({ SpamScore: 7, ExtractedMarkdownMessage: 'Achetez' }, { recipient: reponseVoyageur })
  assert.equal(res.corps.reason, 'automatique_ignore')
  assert.match(res.corps.motif, /score de spam 7/)
  const h = await appel({ Headers: { 'Auto-Submitted': 'auto-replied' }, ExtractedMarkdownMessage: 'Absent' }, { recipient: reponseVoyageur })
  assert.equal(h.corps.reason, 'automatique_ignore')
  assert.equal(etat.recus.length, 0)
})
