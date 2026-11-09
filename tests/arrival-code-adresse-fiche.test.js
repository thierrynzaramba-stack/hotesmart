// tests/arrival-code-adresse-fiche.test.js
// Le message du CODE D'ACCES et l'adresse (lot « Accueil du voyageur »).
//
// ⚠ CONSTAT BLOQUANT DE LA REVIEW 1 DU LOT. `adresse` porte `fiche: true` : le
// remplaceur ignore la ligne `adresse` de la base. Les messages programmes
// recevaient l'adresse de la fiche par leurs replis ; le chemin du code, lui,
// n'en passait AUCUN a `buildMessage`. Tout modele de code qui cite {adresse}
// serait donc parti avec « [ADRESSE] » — sa garde, `hasUnresolvedCode`, ne
// regarde que le code. C'est le seul message qui porte le PIN.
//
// On traverse le VRAI `processArrivalCodes`, jusqu'a la tache a valider (mode
// test), avec un double de `lib/cron-shared` (harnais de
// tests/arrival-code-dos-a-dos.test.js).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const MODELE = {
  id: 'tmpl-1', lock_id: 'lock-1', event_type: 'menage_done', active: true,
  earliest_send_time: '00:00',
  template_text: 'Bonjour {prenom}, adresse : {adresse}. Code : {code_acces}'
}

function charger ({ connaissance = [], modele = MODELE } = {}) {
  const taches = []
  const table = (nom) => {
    const q = {
      select () { return q }, eq () { return q }, neq () { return q }, in () { return q },
      is () { return q }, not () { return q }, lte () { return q }, gte () { return q },
      order () { return q }, range () { return q },
      insert (row) {
        if (nom === 'agent_tasks') taches.push(row)
        return Promise.resolve({ data: null, error: null })
      },
      upsert () { return Promise.resolve({ data: null, error: null }) },
      single: async () => ({ data: nom === 'locks' ? { seam_device_id: 'dev-1' } : null }),
      maybeSingle: async () => ({ data: null, error: null }),
      limit () {
        if (nom === 'access_codes') {
          // Code COMPLET et ancien : ni Seam, ni delai d'attente.
          return Promise.resolve({ data: [{
            id: 'ac-1', seam_code_id: 'seam-1', code: '123456', status: 'active',
            created_at: '2026-01-01T00:00:00Z'
          }] })
        }
        // message_sent_log vide : rien n'est encore parti ; bookings_snapshot
        // vide : premier sejour, aucun menage requis.
        return Promise.resolve({ data: [], error: null })
      },
      then (res, rej) {
        const data = nom === 'message_templates' ? [modele]
                   : nom === 'knowledge' ? connaissance : []
        return Promise.resolve({ data, error: null }).then(res, rej)
      }
    }
    return q
  }

  const abs = require.resolve(path.join(__dirname, '..', 'lib/cron-shared.js'))
  const m = new Module(abs)
  m.exports = {
    supabase: { from: table },
    // Mode TEST : le message atterrit dans une tache a valider, qu'on lit.
    getPropertyMode: async () => 'test',
    lireReglagesDuBien: async () => ({ mode: 'test', delais: null }),
    isAutomationPaused: async () => false
  }
  m.loaded = true
  require.cache[abs] = m
  delete require.cache[require.resolve('../lib/cles-migrees')]
  delete require.cache[require.resolve('../lib/cron-arrival-code')]
  const mod = require('../lib/cron-arrival-code')
  return { mod, taches }
}

const jour = (d) => new Date(Date.now() + d * 86400000)
  .toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' })
const arrivante = () => ({
  id: 'ARRIVANTE', arrival: jour(0), departure: jour(2), status: 'confirmed',
  provider: 'channex', firstName: 'Ana'
})
const texteEnvoye = (taches) => {
  assert.strictEqual(taches.length, 1, 'le message du code n a pas atteint la tache a valider')
  return taches[0].suggested_reply
}

test('LE TEST QUI COMPTE : le message du code porte l adresse de la FICHE', async () => {
  const { mod, taches } = charger()
  await mod.processArrivalCodes('u1', null,
    { id: '0db6b39b', name: 'La bulle', provider: 'channex', address: '12 rue des Lilas, Colomiers' },
    [arrivante()], {})
  const texte = texteEnvoye(taches)
  assert.ok(texte.includes('12 rue des Lilas, Colomiers'),
    `l adresse de la fiche doit atteindre le voyageur, recu : ${texte}`)
  assert.ok(!texte.includes('[ADRESSE]'), 'le marqueur part au voyageur avec son code')
  assert.ok(texte.includes('123456'))
})

test('une adresse dans la BASE seulement ne part plus (une seule adresse : la fiche)', async () => {
  const { mod, taches } = charger({ connaissance: [{ key: 'adresse', value: 'Ancienne adresse de la base' }] })
  await mod.processArrivalCodes('u1', null,
    { id: '0db6b39b', name: 'La bulle', provider: 'channex', address: '12 rue des Lilas, Colomiers' },
    [arrivante()], {})
  const texte = texteEnvoye(taches)
  assert.ok(!texte.includes('Ancienne adresse'), 'la ligne de la base a ete lue')
  assert.ok(texte.includes('12 rue des Lilas'))
})

test('sans adresse de fiche, la base ne la remplace pas', async () => {
  // ⚠ CE TEST NE DIT PAS que le marqueur doit partir : fiche vide, ce chemin
  // envoie encore « [ADRESSE] » (ecart connu, d'avant le lot, au registre des
  // dettes — review 2, constat 2). Il ne fige que la regle du lot : une ligne
  // `adresse` de la base n'est plus jamais lue.
  const { mod, taches } = charger({ connaissance: [{ key: 'adresse', value: 'Ancienne adresse de la base' }] })
  await mod.processArrivalCodes('u1', null,
    { id: '0db6b39b', name: 'La bulle', provider: 'channex', address: '' },
    [arrivante()], {})
  const texte = texteEnvoye(taches)
  assert.ok(!texte.includes('Ancienne adresse'))
})

test('chemin Beds24 : l adresse de la FICHE l emporte sur celle de l objet Beds24', async () => {
  const { mod, taches } = charger()
  await mod.processArrivalCodes('u1', 'CLE24',
    { id: '111', name: 'Gite', provider: 'beds24', address: 'Adresse Beds24',
      adresseFiche: 'Adresse de la fiche' },
    [{ ...arrivante(), provider: 'beds24' }], {})
  const texte = texteEnvoye(taches)
  assert.ok(texte.includes('Adresse de la fiche'), `recu : ${texte}`)
  assert.ok(!texte.includes('Adresse Beds24'))
})

test('le message du code n annonce pas l heure de depart synchronisee du bien : le code, lui, expire selon la base', async () => {
  // Review finale du lot, constat 2. La fin de validite du code ne lit que la
  // base (`cron-arrival-code.js`, `cron-access.js`) ; annoncer l'heure de
  // depart Beds24 (`checkOutEnd`) dans le message qui porte le PIN aurait pu
  // promettre un depart APRES l'expiration de ce PIN.
  const { mod, taches } = charger({ modele: { ...MODELE, template_text: 'Depart avant {checkout}. Code : {code_acces}' } })
  await mod.processArrivalCodes('u1', 'CLE24',
    { id: '111', name: 'Gite', provider: 'beds24', address: 'A', adresseFiche: 'A', checkOutEnd: '13:00' },
    [{ ...arrivante(), provider: 'beds24' }], {})
  const texte = texteEnvoye(taches)
  assert.ok(!texte.includes('13:00'), texte)
})

test('le message du code porte l adresse ENTIERE de la fiche (rue, code postal, ville)', async () => {
  // Recette du 9 novembre 2026 : la fiche range l'adresse en trois champs.
  const { mod, taches } = charger()
  await mod.processArrivalCodes('u1', null,
    { id: '0db6b39b', name: 'La bulle', provider: 'channex', address: '4 rue du bourg vieux', zip_code: '65200', city: 'Bagnères-de-Bigorre' },
    [arrivante()], {})
  const texte = texteEnvoye(taches)
  assert.ok(texte.includes('4 rue du bourg vieux, 65200 Bagnères-de-Bigorre'), texte)
})
