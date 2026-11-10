// tests/founder-notify-cle.test.js
// Dette 141, review 2, constat 1 : l'anti-spam de `reportIncident` porte sur
// (type, logement) pendant une heure. Pour un CODE D'ACCES, un second refus sur
// le meme logement le meme jour — celui qui ARRIVE, un jour de dos-a-dos — etait
// consigne sans rien envoyer. La `cle` resserre l'anti-spam a un fait (la
// reservation), sans toucher `property_id`, qui sert a la RLS.
//
// On fait tourner le VRAI `reportIncident` (seuil, anti-spam, escalade, SMS) sur
// une table `automation_incidents` en memoire qui honore les filtres utilises.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.FOUNDER_PHONE = '+33600000000'
process.env.FOUNDER_EMAIL = 'fondateur@exemple.test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const table = []
const envois = { sms: [], emails: [] }

function doubler (relatif, exports) {
  const abs = require.resolve(path.join(__dirname, '..', relatif))
  const m = new Module(abs); m.exports = exports; m.loaded = true
  require.cache[abs] = m
}

// Une table en memoire qui imite la FORME du client : un constructeur de
// requete qui accumule ses filtres et ne se resout qu'a l'attente.
function lecture () {
  const filtres = []
  let triDesc = false, borne = Infinity
  const b = {
    select: () => b,
    eq: (c, v) => { filtres.push(r => String(r[c]) === String(v)); return b },
    is: (c, v) => { filtres.push(r => (r[c] ?? null) === v); return b },
    gte: (c, v) => { filtres.push(r => r[c] >= v); return b },
    contains: (c, obj) => {
      filtres.push(r => r[c] && typeof r[c] === 'object' && Object.entries(obj).every(([k, v]) => r[c][k] === v))
      return b
    },
    order: (_, o) => { triDesc = o && o.ascending === false; return b },
    limit: (n) => { borne = n; return b },
    then (ok, ko) {
      let rows = table.filter(r => filtres.every(f => f(r)))
      if (triDesc) rows = [...rows].sort((a, z) => (a.created_at < z.created_at ? 1 : -1))
      return Promise.resolve({ data: rows.slice(0, borne), error: null }).then(ok, ko)
    }
  }
  return b
}
doubler('lib/cron-shared.js', {
  supabase: {
    from: () => ({
      ...lecture(),
      select: (...a) => lecture().select(...a),
      insert (row) {
        const ligne = { id: 'inc-' + (table.length + 1), created_at: new Date().toISOString(), acquitted_at: null, ...row }
        table.push(ligne)
        return { select: () => ({ maybeSingle: async () => ({ data: { id: ligne.id } }) }) }
      },
      update (patch) {
        return { eq: async (c, v) => { for (const r of table) if (String(r[c]) === String(v)) Object.assign(r, patch); return { error: null } } }
      }
    })
  }
})
doubler('lib/platform-notify.js', {
  sendPlatformSms: async (to, txt) => { envois.sms.push(txt); return { ok: true } },
  sendPlatformEmail: async (to, sujet, html) => { envois.emails.push({ sujet, html }); return { ok: true } }
})
delete require.cache[require.resolve('../lib/founder-notify')]
const { reportIncident } = require('../lib/founder-notify')

const remise = () => { table.length = 0; envois.sms.length = 0; envois.emails.length = 0 }
const BIEN = { userId: 'u1', propertyId: '0db6b39b', propertyName: 'La bulle', threshold: 1 }

test('jeu d essai : SANS cle, un second fait du meme type sur le meme logement dans l heure se tait (comportement general, inchange)', async () => {
  remise()
  await reportIncident('code_acces_non_envoye', { ...BIEN, detail: 'Voyageur A' })
  await reportIncident('code_acces_non_envoye', { ...BIEN, detail: 'Voyageur B' })
  assert.strictEqual(envois.sms.length, 1)
  assert.strictEqual(table.length, 2, 'les deux faits sont consignes')
})

test('LE TEST QUI COMPTE : AVEC une cle par reservation, deux codes refuses sur le meme logement alertent chacun', async () => {
  remise()
  const a = await reportIncident('code_acces_non_envoye', { ...BIEN, detail: 'Code d accès de Paul (part)', cle: 'code_acces:D' })
  const b = await reportIncident('code_acces_non_envoye', { ...BIEN, detail: 'Code d accès de Ana (arrive)', cle: 'code_acces:A' })
  assert.strictEqual(a.alerted, true)
  assert.strictEqual(b.alerted, true, 'celui qui arrive ce soir est tu')
  assert.strictEqual(envois.sms.length, 2)
  assert.ok(envois.sms[1].includes('Ana (arrive)'))
})

test('la meme cle deux fois dans l heure : la seconde se tait (l anti-spam tient toujours, par fait)', async () => {
  remise()
  await reportIncident('code_acces_non_envoye', { ...BIEN, detail: 'Code d accès de Ana', cle: 'code_acces:A' })
  const r = await reportIncident('code_acces_non_envoye', { ...BIEN, detail: 'Code d accès de Ana', cle: 'code_acces:A' })
  assert.strictEqual(r.alerted, false)
  assert.strictEqual(envois.sms.length, 1)
})

test('la cle vit dans `detail`, pas dans `property_id` (RLS), et le SMS ne montre que le message', async () => {
  remise()
  await reportIncident('code_acces_non_envoye', { ...BIEN, detail: 'Code d accès de Ana NON ENVOYÉ', cle: 'code_acces:A' })
  assert.deepStrictEqual(table[0].detail, { message: 'Code d accès de Ana NON ENVOYÉ', cle: 'code_acces:A' })
  assert.strictEqual(table[0].property_id, '0db6b39b')
  assert.ok(envois.sms[0].endsWith('Code d accès de Ana NON ENVOYÉ'), envois.sms[0])
  assert.ok(!envois.sms[0].includes('code_acces:A'))
})

test('une cle sur un type ne change rien aux autres types', async () => {
  remise()
  await reportIncident('send_failure', { ...BIEN, detail: 'Message de bienvenue' })
  await reportIncident('code_acces_non_envoye', { ...BIEN, detail: 'Code d accès de Ana', cle: 'code_acces:A' })
  await reportIncident('send_failure', { ...BIEN, detail: 'Autre message' })
  assert.strictEqual(envois.sms.length, 2, 'send_failure garde son anti-spam par logement')
})
