// tests/alert-regles-modifiees.test.js
// lib/alert-notify.js — `alertReglesModifiees` : la tâche du jour qui CUMULE les
// changements d'une prestataire, et le message qui part à CHAQUE changement.
//
// ⚠ CE QUI EST EN JEU (review du 2 octobre 2026). Depuis que l'hôte est prévenu
// de chaque exception d'un jour, les changements s'enchaînent : un glisser de dix
// jours, une absence posée puis retirée. Deux défauts faisaient dire FAUX à
// l'hôte sur la disponibilité d'un jour précis :
//   A. le SMS coupe le résumé à 100 caractères et on renvoyait le CUMUL : chaque
//      SMS répétait le premier changement de la journée ;
//   B. `deja.includes(texte)` écartait un texte déjà vu : absente → disponible →
//      absente, et la tâche finissait sur « disponible ».
// Envois réels remplacés par des doubles : on lit le message qui PART.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const COMPTE = 'compte-1', LENA = 'p-lena', BIEN = '204cef81'

function stub (rel, exports) {
  const abs = require.resolve(path.join(__dirname, '..', rel))
  const m = new Module(abs); m.exports = exports; m.loaded = true
  require.cache[abs] = m
}

function preparer ({ tacheDuJour = null } = {}) {
  const etat = { sms: [], emails: [], ecritures: [] }
  const client = {
    from (table) {
      const f = {}
      const chain = {
        select () { return chain },
        eq (c, v) { f[c] = v; return chain },
        order () { return chain },
        limit () {
          if (table === 'agent_tasks') {
            return Promise.resolve({ data: tacheDuJour ? [tacheDuJour] : [], error: null })
          }
          return Promise.resolve({ data: [], error: null })
        },
        single () {
          if (table === 'agent_alert_config') {
            // La configuration d'alerte n'existe QUE pour ce compte : une alerte
            // routée vers un autre compte ne partirait pas.
            const ok = f.user_id === COMPTE
            return Promise.resolve(ok
              ? { data: { config: { [BIEN]: { intervention: {
                  sms_enabled: true, sms_lines: '+33600000000',
                  email_enabled: true, email_lines: 'hote@example.com' } } } }, error: null }
              : { data: null, error: { message: 'aucune' } })
          }
          return Promise.resolve({ data: null, error: null })
        },
        insert (row) { etat.ecritures.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }) },
        update (row) {
          const q = { table, op: 'update', row, f: {} }
          etat.ecritures.push(q)
          const c2 = { eq (c, v) { q.f[c] = v; return Promise.resolve({ error: null }) } }
          return c2
        }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  stub('api/sms', { sendSms: async (to, msg) => { etat.sms.push(msg); return { ok: true } } })
  stub('lib/platform-notify', { sendPlatformEmail: async (to, sujet, html) => { etat.emails.push(html); return { ok: true } } })
  delete require.cache[require.resolve('../lib/alert-notify')]
  const { alertReglesModifiees } = require('../lib/alert-notify')
  const alerter = texte => alertReglesModifiees({
    userId: COMPTE, providerId: LENA, propertyId: BIEN, prenom: 'Lena', texte, rassurer: false })
  return { alerter, etat }
}

const ABSENTE = 'Lena s\'est déclarée absente le samedi 10 octobre 2026, depuis son application.'
const DISPO = 'Lena s\'est déclarée disponible le samedi 10 octobre 2026, depuis son application.'
const AUTRE = 'Lena s\'est déclarée disponible le dimanche 11 octobre 2026, depuis son application.'

test('premier changement du jour : une tâche pour CE compte, et un SMS qui le dit', async () => {
  const { alerter, etat } = preparer()
  await alerter(ABSENTE)
  const ins = etat.ecritures.find(e => e.table === 'agent_tasks' && e.op === 'insert')
  assert.ok(ins)
  assert.strictEqual(ins.row.user_id, COMPTE, 'la tâche est posée chez l\'hôte de la prestataire')
  assert.strictEqual(ins.row.summary, ABSENTE)
  assert.strictEqual(etat.sms.length, 1)
  assert.match(etat.sms[0], /absente le samedi 10 octobre/)
})

test('A — le second changement du jour part avec SON texte, pas avec le premier', async () => {
  const { alerter, etat } = preparer({ tacheDuJour: { id: 't1', summary: ABSENTE } })
  await alerter(AUTRE)
  assert.strictEqual(etat.sms.length, 1)
  assert.match(etat.sms[0], /dimanche 11 octobre/, 'le SMS dit ce qui vient de changer')
  assert.doesNotMatch(etat.sms[0], /samedi 10 octobre/)
  const maj = etat.ecritures.find(e => e.table === 'agent_tasks' && e.op === 'update')
  assert.ok(maj.row.summary.startsWith(ABSENTE) && maj.row.summary.endsWith(AUTRE),
    'la tâche, elle, garde tout dans l\'ordre')
})

test('B — un ALLER-RETOUR dans la journée finit sur le bon état', async () => {
  // Absente le 10, puis disponible le 10 : la tâche dit déjà les deux. Elle se
  // redéclare absente : ce changement doit s'ajouter, et partir.
  const { alerter, etat } = preparer({ tacheDuJour: { id: 't1', summary: ABSENTE + ' Puis : ' + DISPO } })
  await alerter(ABSENTE)
  const maj = etat.ecritures.find(e => e.table === 'agent_tasks' && e.op === 'update')
  assert.ok(maj, 'le changement est enregistré')
  assert.ok(maj.row.summary.endsWith(ABSENTE), 'la tâche finit sur l\'état réel : absente')
  assert.strictEqual(etat.sms.length, 1)
  assert.match(etat.sms[0], /absente le samedi 10 octobre/)
})

test('la répétition IMMÉDIATE du même changement ne renvoie rien', async () => {
  const { alerter, etat } = preparer({ tacheDuJour: { id: 't1', summary: DISPO + ' Puis : ' + ABSENTE } })
  await alerter(ABSENTE)
  assert.ok(!etat.ecritures.some(e => e.table === 'agent_tasks'), 'tâche inchangée')
  assert.strictEqual(etat.sms.length, 0)
  assert.strictEqual(etat.emails.length, 0)
})
