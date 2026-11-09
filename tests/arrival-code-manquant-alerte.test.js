// tests/arrival-code-manquant-alerte.test.js
// Dette 137 — le message du CODE D'ACCES et une information manquante.
//
// Decision de Thierry du 9 novembre 2026, option (a) : le message du code PART
// meme s'il lui manque une information (fiche sans adresse, typiquement) —
// sans lui la porte reste fermee —, et l'hote est PREVENU. Avant ce lot, le
// marqueur « [ADRESSE] » partait en mode Auto sans que personne le sache.
//
// On traverse le VRAI `processArrivalCodes` en mode Auto, avec des doubles pour
// tout ce qui sortirait du processus : la base (`cron-shared`), l'envoi
// (`cron-messages`), le journal du cœur (`record-message`), les alertes
// (`founder-notify`, `alert-notify`). Harnais de
// tests/arrival-code-adresse-fiche.test.js.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

// Les libelles se lisent sur le VRAI module, avant que le double le remplace.
const { LABELS, SANS_SMS } = require('../lib/founder-notify')

const MODELE = {
  id: 'tmpl-1', lock_id: 'lock-1', event_type: 'menage_done', active: true,
  earliest_send_time: '00:00',
  template_text: 'Bonjour {prenom}, adresse : {adresse}. Code : {code_acces}'
}

function doubler (relatif, exports) {
  const abs = require.resolve(path.join(__dirname, '..', relatif))
  const m = new Module(abs)
  m.exports = exports
  m.loaded = true
  require.cache[abs] = m
}

function charger ({ mode = 'auto', envoi = { ok: true }, pin = '123456', modele = MODELE } = {}) {
  const vus = { envois: [], alertes: [], taches: [], pinManquant: 0, journal: 0, codesActives: 0 }
  const table = (nom) => {
    const q = {
      select () { return q }, eq () { return q }, neq () { return q }, in () { return q },
      is () { return q }, not () { return q }, lte () { return q }, gte () { return q },
      order () { return q }, range () { return q },
      update (row) { if (nom === 'access_codes' && row.status === 'active') vus.codesActives++; return q },
      insert (row) {
        if (nom === 'agent_tasks') vus.taches.push(row)
        return Promise.resolve({ data: null, error: null })
      },
      upsert () { return Promise.resolve({ data: null, error: null }) },
      single: async () => ({ data: nom === 'locks' ? { seam_device_id: 'dev-1' } : null }),
      maybeSingle: async () => ({ data: null, error: null }),
      limit () {
        if (nom === 'access_codes') {
          // Code ancien : aucun delai d'attente. `pin` null = PIN pas encore
          // pose par la serrure (le message doit etre RETENU).
          return Promise.resolve({ data: [{
            id: 'ac-1', seam_code_id: null, code: pin, status: 'active',
            created_at: '2026-01-01T00:00:00Z'
          }] })
        }
        return Promise.resolve({ data: [], error: null })
      },
      then (res, rej) {
        const data = nom === 'message_templates' ? [modele] : []
        return Promise.resolve({ data, error: null }).then(res, rej)
      }
    }
    return q
  }

  doubler('lib/cron-shared.js', {
    supabase: { from: table },
    getPropertyMode: async () => mode,
    lireReglagesDuBien: async () => ({ mode, delais: null }),
    isAutomationPaused: async () => false
  })
  doubler('lib/cron-messages.js', {
    sendGuestMessage: async (cle, bien, booking, message) => { vus.envois.push(message); return envoi },
    noterEnvoi: async () => {}
  })
  doubler('lib/record-message.js', { recordMessage: async () => { vus.journal++; return { ok: true } } })
  doubler('lib/founder-notify.js', {
    reportIncident: async (type, opts) => { vus.alertes.push({ type, ...opts }); return { recorded: true } }
  })
  doubler('lib/alert-notify.js', {
    alertMissingAccessCode: async () => { vus.pinManquant++ }
  })
  delete require.cache[require.resolve('../lib/cles-migrees')]
  delete require.cache[require.resolve('../lib/cron-arrival-code')]
  const mod = require('../lib/cron-arrival-code')
  return { mod, vus }
}

const jour = (d) => new Date(Date.now() + d * 86400000)
  .toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' })
const arrivante = () => ({
  id: 'ARRIVANTE', arrival: jour(0), departure: jour(2), status: 'confirmed',
  provider: 'channex', firstName: 'Ana', lastName: 'Lopez'
})
const BIEN_SANS_ADRESSE = { id: '0db6b39b', name: 'La bulle', provider: 'channex', address: '' }
const BIEN_AVEC_ADRESSE = { ...BIEN_SANS_ADRESSE, address: '4 rue du bourg vieux', zip_code: '65200', city: 'Bagnères-de-Bigorre' }
const incompletes = (vus) => vus.alertes.filter(a => a.type === 'message_envoye_incomplet')

test('LE TEST QUI COMPTE : fiche sans adresse, mode Auto — le code PART et l hote est PREVENU', async () => {
  const { mod, vus } = charger()
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})

  assert.strictEqual(vus.envois.length, 1, 'le code doit partir : sans lui la porte reste fermee')
  assert.ok(vus.envois[0].includes('123456'))
  const a = incompletes(vus)
  assert.strictEqual(a.length, 1, 'l hote doit etre prevenu, une fois')
  assert.strictEqual(a[0].userId, 'u1')
  assert.strictEqual(a[0].propertyId, '0db6b39b')
  assert.strictEqual(a[0].threshold, 1)
  assert.match(a[0].detail, /ENVOYÉ/)
  assert.match(a[0].detail, /Ana Lopez/)
  // Le NOM de l'information et le chemin de saisie AVEC le nom du logement —
  // jamais la cle technique ni le gabarit.
  assert.match(a[0].detail, /il manque : Adresse/)
  assert.match(a[0].detail, /Logements → La bulle → Le logement → Adresse/)
  assert.ok(!a[0].detail.includes('<nom du logement>'))
  assert.ok(!/\badresse\b/.test(a[0].detail.replace(/Adresse/g, '')), 'cle brute dans l alerte')
})

// Non-regression (vert contre le code d'avant) : rougit contre une alerte
// posee sans condition sur les manquants — verifie.
test('fiche avec adresse : le code part, aucune alerte', async () => {
  const { mod, vus } = charger()
  await mod.processArrivalCodes('u1', null, BIEN_AVEC_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 1)
  assert.ok(vus.envois[0].includes('4 rue du bourg vieux, 65200 Bagnères-de-Bigorre'))
  assert.strictEqual(incompletes(vus).length, 0)
  assert.strictEqual(vus.alertes.length, 0)
})

// Non-regression : rougit contre une alerte posee sans condition — verifie.
test('modele sans {adresse} et fiche vide : rien ne manque, aucune alerte', async () => {
  // On ne previent QUE de ce que le modele demande vraiment.
  const { mod, vus } = charger({ modele: { ...MODELE, template_text: 'Bonjour {prenom}. Code : {code_acces}' } })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 1)
  assert.strictEqual(incompletes(vus).length, 0)
})

test('le canal refuse l envoi : l alerte ne dit pas « envoye », elle renvoie a la tache', async () => {
  const { mod, vus } = charger({ envoi: { ok: false, reason: 'pas de messagerie' } })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.taches.length, 1, 'la tache de transmission manuelle existe deja')
  const a = incompletes(vus)
  assert.strictEqual(a.length, 1)
  assert.ok(!/ENVOYÉ/.test(a[0].detail), `l alerte ne doit pas annoncer un envoi qui n a pas eu lieu : ${a[0].detail}`)
  assert.match(a[0].detail, /dans vos tâches/)
})

// Non-regression : rougit contre une alerte posee aussi en mode Test — verifie.
test('mode Test : pas d alerte — la tache a valider montre le texte a l hote', async () => {
  const { mod, vus } = charger({ mode: 'test' })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 0)
  assert.strictEqual(vus.taches.length, 1)
  assert.strictEqual(incompletes(vus).length, 0)
})

// Non-regression : rougit contre une alerte posee AVANT la garde du code — verifie.
test('PIN pas encore pose ET adresse manquante : la garde du code gagne, rien ne part', async () => {
  // L'option (a) n'affaiblit pas `hasUnresolvedCode` : un message sans code
  // reste RETENU. Et l'alerte « envoye incomplet » ne sonne pas pour un
  // message qui n'est pas parti.
  const { mod, vus } = charger({ pin: null })
  await mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {})
  assert.strictEqual(vus.envois.length, 0)
  assert.strictEqual(incompletes(vus).length, 0)
})

test('l alerte qui echoue ne casse pas la suite de l envoi : journal du coeur et code active', async () => {
  // Garde une regression : sans le try/catch de l'alerte, l'exception remonte
  // au `catch` general de l'envoi — le code est deja parti, donc rien ne se
  // voit chez le voyageur, mais le message manque au fil du coeur et le code
  // n'est jamais passe a « active ». Verifie contre cette version fautive.
  const { vus } = charger()
  doubler('lib/founder-notify.js', { reportIncident: async () => { throw new Error('Brevo en panne') } })
  delete require.cache[require.resolve('../lib/cron-arrival-code')]
  const mod = require('../lib/cron-arrival-code')
  await assert.doesNotReject(() => mod.processArrivalCodes('u1', null, BIEN_SANS_ADRESSE, [arrivante()], {}))
  assert.strictEqual(vus.envois.length, 1)
  assert.strictEqual(vus.journal, 1, 'le message envoye doit entrer dans le fil du coeur')
  assert.strictEqual(vus.codesActives, 1, 'le code doit passer a « active »')
})

test('buildMessageDetaille rend les manquants ; buildMessage garde son contrat (une chaine)', () => {
  const { buildMessage, buildMessageDetaille } = require('../lib/message-builder')
  const r = buildMessageDetaille(MODELE, arrivante(), 'Ana', '123456', {}, BIEN_SANS_ADRESSE)
  assert.deepStrictEqual(r.manquants, ['adresse'])
  assert.ok(r.texte.includes('[ADRESSE]'))
  assert.strictEqual(buildMessage(MODELE, arrivante(), 'Ana', '123456', {}, BIEN_SANS_ADRESSE), r.texte)
  assert.strictEqual(buildMessage({ template_text: '  ' }, arrivante(), 'Ana', '1', {}, {}), null)
  assert.strictEqual(buildMessageDetaille({ template_text: '' }, arrivante(), 'Ana', '1', {}, {}), null)
})

test('le type d alerte a un libelle, et il part aussi par SMS', () => {
  assert.ok(LABELS.message_envoye_incomplet, 'sinon l objet de l alerte porterait la cle brute')
  assert.ok(!SANS_SMS.has('message_envoye_incomplet'))
})
