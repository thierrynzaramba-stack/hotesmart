// tests/channel-props-une-lecture.test.js
// LE DEFAUT : la fenetre -7j/+30j de `bookings_snapshot` etait lue DEUX FOIS
// par bien et par cycle.
//
// `processMessageTemplates` la lisait pour les modeles, puis
// `lib/cron-channel-props.js` la relisait, requete identique, pour les codes
// d'acces. Mesure du 22 octobre 2026 en production : 5 requetes par cycle,
// 1440 par jour, pour la meme reponse.
//
// ⚠ ON NE DOUBLE PAS `processMessageTemplates` ICI, ET C'EST LE POINT.
// Le doubler effacerait justement la lecture qu'on accuse : le test passerait
// contre le code d'avant. On traverse donc les VRAIES fonctions, avec un double
// de `lib/cron-shared`, et on compte les requetes a `bookings_snapshot`.
//
// ⚠ ET CE QUI EST GARDE N'EST PAS SEULEMENT LE COMPTE, C'EST L'ORDRE.
// Un tableau charge d'avance aurait suffi a economiser la requete — et aurait
// avance la lecture AVANT les gardes de `processMessageTemplates`. Sur un bien
// sans modele actif, une panne de `bookings_snapshot` leverait alors avant la
// classification, dans le MEME `try`, et l'emporterait. D'ou un lecteur
// PARESSEUX, et deux tests : un bien avec modeles, un bien sans.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const BIENS = [
  { id: 'uuid-1', user_id: 'u', name: 'La bulle', provider: 'channex', provider_property_id: 'P1' },
  { id: 'uuid-2', user_id: 'u', name: 'Ofuro', provider: 'channex', provider_property_id: 'P2' }
]

function poser (abs, exports) {
  const m = new Module(abs)
  m.exports = exports
  m.loaded = true
  require.cache[abs] = m
}
const chemin = (rel) => require.resolve(path.join(__dirname, '..', rel))

// `modeles` : les modeles arrival/departure actifs du bien. Liste vide = le cas
// « aucun modele », ou `processMessageTemplates` sort avant toute lecture.
function charger ({ modeles, fenetreEnPanne = false }) {
  const vu = { fenetres: [], classifications: 0 }

  const table = (nom) => {
    const f = { eq: {}, in: {}, bornes: [] }
    const q = {
      select () { return q },
      eq (c, v) { f.eq[c] = String(v); return q },
      in (c, v) { f.in[c] = v; return q },
      gte (c) { f.bornes.push(c); return q },
      lte (c) { f.bornes.push(c); return q },
      neq () { return q }, is () { return q }, not () { return q }, gt () { return q },
      order () { return q },
      update () { return q },
      insert () { return Promise.resolve({ error: null, data: null }) },
      upsert () { return Promise.resolve({ error: null }) },
      limit () { return rendre() },
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then (r, j) { return rendre().then(r, j) }
    }
    function rendre () {
      if (nom === 'properties') {
        // Le SELECT d'entree porte `in('provider', …)` ; la lecture du coupe-circuit
        // designe un bien precis.
        if (f.in.provider) return Promise.resolve({ data: BIENS, error: null })
        return Promise.resolve({ data: [{ automation_paused: false }], error: null })
      }
      if (nom === 'bookings_snapshot') {
        // Seule la fenetre -7j/+30j nous interesse : c'est celle qu'on accuse.
        if (f.bornes.some(c => c.includes('arrival'))) {
          vu.fenetres.push(f.eq.property_id)
          if (fenetreEnPanne) return Promise.resolve({ data: null, error: { message: 'panne transitoire' } })
        }
        return Promise.resolve({ data: [{ booking_id: 'B1', snapshot: { id: 'B1', arrival: '2026-10-20', departure: '2026-10-25', status: 'confirmed' } }], error: null })
      }
      if (nom === 'message_templates') {
        // Les modeles de code d'acces : aucun, pour que les codes s'arretent la.
        if (f.eq.event_type === 'menage_done') return Promise.resolve({ data: [], error: null })
        return Promise.resolve({ data: modeles, error: null })
      }
      // Deja envoye : rien ne part. Et aucune tache, aucune conversation.
      if (nom === 'message_sent_log') return Promise.resolve({ data: [{ id: 'deja' }], error: null })
      return Promise.resolve({ data: [], error: null })
    }
    return q
  }

  poser(chemin('lib/cron-shared.js'), {
    supabase: { from: table },
    anthropic: null,
    getPropertyMode: async () => 'test',
    formatDate: () => '',
    parseDelay: () => 0,
    surAppel: () => {},
    isAutomationPaused: async () => false
  })
  poser(chemin('lib/channels/index.js'), {
    getProvider: () => ({ getPropertyMessages: async () => { vu.classifications++; return [] } })
  })
  poser(chemin('lib/contradiction-prix.js'), { surveillerContradictionPrix: async () => ({ contradiction: false }) })
  poser(chemin('lib/channels/channex.js'), { channelCall: async () => ({ ok: true, json: { data: [] } }) })
  poser(chemin('lib/founder-notify.js'), { reportIncident: async () => {}, alertMissingAccessCode: async () => {} })

  for (const m of ['lib/cron-messages.js', 'lib/cron-classify.js', 'lib/cron-arrival-code.js',
    'lib/cron-channel-props.js', 'lib/cles-migrees.js']) {
    delete require.cache[chemin(m)]
  }
  return { mod: require('../lib/cron-channel-props'), vu }
}

const resultats = () => ({ errors: [], totalMessages: 0, totalTasks: 0, totalAutoMessages: 0 })

test('LE TEST QUI COMPTE : la fenetre -7j/+30j est lue UNE SEULE FOIS par bien', async () => {
  const { mod, vu } = charger({
    modeles: [{ id: 't1', event_type: 'arrival', reference: 'arrival', offset_days: 0, active: true, send_time: '00:00' }]
  })
  const res = resultats()
  await mod.processChannelProperties(res)
  assert.deepEqual(res.errors, [], 'le cycle traverse sans erreur')
  assert.deepEqual(vu.fenetres, ['P1', 'P2'],
    `une lecture par bien, pas deux — lectures constatees : ${JSON.stringify(vu.fenetres)}`)
})

test('LE TEST QUI COMPTE : un bien SANS modele actif ne lit la fenetre qu une fois aussi', async () => {
  const { mod, vu } = charger({ modeles: [] })
  const res = resultats()
  await mod.processChannelProperties(res)
  assert.deepEqual(res.errors, [])
  assert.deepEqual(vu.fenetres, ['P1', 'P2'], 'une lecture par bien, faite par les codes d acces')
})

test('LE TEST QUI TRANCHE L ORDRE : fenetre en panne et aucun modele, la CLASSIFICATION tourne quand meme', async () => {
  // ⚠ C'EST LE SEUL TEST QUI DISTINGUE UN LECTEUR PARESSEUX D'UN TABLEAU
  // CHARGE D'AVANCE. Les deux font UNE lecture par bien : le compte ne les
  // separe pas. Ce qui les separe est l'ORDRE, et il ne se voit que quand la
  // lecture ECHOUE.
  //   · paresseux  : les modeles sortent avant de lire → la classification
  //     tourne → puis les codes demandent la fenetre, elle leve, le `try`
  //     l'attrape ;
  //   · avide      : la lecture leve AVANT les modeles → la classification
  //     n'est jamais appelee, et selon l'endroit de la lecture, c'est tout le
  //     cycle de ce bien qui tombe.
  // Contre-eprouve le 22 octobre 2026 : la mutation « avide » passait les deux
  // tests ci-dessus et rougit celui-ci.
  const { mod, vu } = charger({ modeles: [], fenetreEnPanne: true })
  const res = resultats()
  await mod.processChannelProperties(res)
  assert.equal(vu.classifications, 2,
    'la classification doit tourner sur les DEUX biens, malgre la fenetre illisible')
  assert.equal(res.errors.length, 2, 'et les deux echecs sont comptes, un par bien')
  assert.match(String(res.errors[0].error), /bookings_snapshot/)
})
