// tests/heures-logement.test.js
// Les heures d'arrivée et de départ vivent dans la FICHE du logement, et nulle
// part ailleurs (spec docs/specs/spec-heures-logement.md, décisions de Thierry
// du 22 novembre 2026).
//
// ⚠ CE QUE CES TESTS GARDENT, ET POURQUOI ILS EXISTENT : avant ce lot, l'heure
// avait TROIS sources (la base de connaissance, l'heure Beds24, le défaut) et
// chaque lecteur choisissait la sienne. Le message d'arrivée, la fenêtre du
// code d'accès et l'alerte « ménage pas fait » pouvaient donc dire trois
// heures différentes au même voyageur. Chaque test ci-dessous ferme un de ces
// chemins.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'
const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')
const { JSDOM } = require('jsdom')

function injecter (chemin, exports) {
  const abs = require.resolve(chemin)
  const m = new Module(abs)
  m.exports = exports
  m.loaded = true
  require.cache[abs] = m
  return abs
}

// ─── La forme : « HH:MM », jamais une heure devinée ─────────────────────────
test('normaliserHeure : quatre formes lisibles, tout le reste refusé', () => {
  const { normaliserHeure } = require('../lib/heures-logement')
  const cas = {
    '16:00': '16:00', '16:00:00': '16:00', '16h': '16:00', '16h30': '16:30', '16 h 30': '16:30',
    '9:05': '09:05', ' 18:00 ': '18:00', '23:59': '23:59', '00:00': '00:00',
    '9:5': null, '25:00': null, '24:00': null, '16:60': null, '4pm': null, 'midi': null, '': null, '  ': null
  }
  for (const [brut, attendu] of Object.entries(cas)) assert.equal(normaliserHeure(brut), attendu, JSON.stringify(brut))
  assert.equal(normaliserHeure(null), null)
  assert.equal(normaliserHeure(undefined), null)
})

// ─── Une seule source : la fiche ───────────────────────────────────────────
test('LE TEST QUI COMPTE : une ligne `checkin` restée dans la base ne passe plus devant la fiche', () => {
  const { remplacerBalises, replisDuBien } = require('../lib/balises')
  const replis = replisDuBien({ checkin_time: '16:00', checkout_time: '11:00' })
  const r = remplacerBalises('{checkin} / {checkout}', { connaissance: { checkin: '15:00', checkout: '09:00' }, replis })
  assert.equal(r.texte, '16:00 / 11:00')
  // Fiche vide : le DÉFAUT, jamais la base (décision 4 : le voyageur garde
  // 18:00 / 10:00 d'ici à ce que l'hôte complète).
  const vide = remplacerBalises('{checkin} / {checkout}', { connaissance: { checkin: '15:00', checkout: '09:00' }, replis: replisDuBien({}) })
  assert.equal(vide.texte, '18:00 / 10:00')
  assert.deepEqual(vide.manquants, [], 'une heure absente n est pas un manque : le défaut part')
})

test('Beds24 : l heure de la fiche passe DEVANT celle du partenaire (décision 3)', () => {
  const { replisDuBien, heureDeLaFiche } = require('../lib/balises')
  const objet = { checkInStart: '14:00', checkOutEnd: '12:00', checkinFiche: '17:00', checkoutFiche: '10:30' }
  assert.equal(replisDuBien(objet).checkin, '17:00')
  assert.equal(replisDuBien(objet).checkout, '10:30')
  // Sans décoration (chemins qui lisent `properties`), la colonne de la fiche.
  assert.equal(heureDeLaFiche({ checkin_time: ' 16:00 ' }, 'checkin'), '16:00')
  // Une décoration NULLE ne retombe pas sur l'heure du partenaire : c'est la
  // fiche qui a parlé, et elle est vide.
  assert.equal(heureDeLaFiche({ checkInStart: '14:00', checkinFiche: null }, 'checkin'), null)
})

// ─── Beds24 ne remplit que le vide ─────────────────────────────────────────
function chargerSync (ligne) {
  const ecritures = []
  const q = (table) => {
    const filtres = []
    let charge = null
    const b = {
      select () { return b },
      eq (c, v) { filtres.push(['eq', c, v]); return b },
      is (c, v) { filtres.push(['is', c, v]); return b },
      or (expr) { filtres.push(['or', expr]); return b },
      update (c) { charge = c; return b },
      maybeSingle: async () => ({ data: ligne, error: null }),
      then (res, rej) {
        if (charge) ecritures.push({ table, charge, filtres: [...filtres] })
        return Promise.resolve({ error: null }).then(res, rej)
      }
    }
    return b
  }
  const chemins = [
    injecter('../lib/cron-shared', { supabase: { from: q } }),
    injecter('../lib/billing', { syncAccountBilling: async () => {} }),
    injecter('../lib/cles-migrees', { clesMigrees: async () => new Set() }),
    injecter('../lib/biens-vivants', { clesArchivees: async () => ({ complet: true, cles: new Set() }), cleDuBien: (u, p) => `${u}|${p}` })
  ]
  delete require.cache[require.resolve('../lib/cron-beds24-props')]
  const mod = require('../lib/cron-beds24-props')
  delete require.cache[require.resolve('../lib/cron-beds24-props')]
  for (const c of chemins) delete require.cache[c]
  return { mod, ecritures }
}

test('LE TEST QUI COMPTE : la synchro Beds24 n écrase JAMAIS une heure de la fiche', async () => {
  const { mod, ecritures } = chargerSync({ id: 'b1', checkin_time: '17:00', checkout_time: '10:30' })
  await mod.syncPropertyHours('u1', '111', { checkInStart: '15:00', checkOutEnd: '11:00' })
  assert.deepEqual(ecritures, [], 'la fiche est pleine : rien ne part')
})

test('fiche vide : Beds24 remplit, colonne par colonne, au format HH:MM, avec la condition « vide » posée en base', async () => {
  const { mod, ecritures } = chargerSync({ id: 'b1', checkin_time: null, checkout_time: '10:30' })
  await mod.syncPropertyHours('u1', '111', { checkInStart: '15:00:00', checkOutEnd: '11:00' })
  assert.equal(ecritures.length, 1, 'seule l arrivée est vide')
  assert.deepEqual(ecritures[0].charge, { checkin_time: '15:00' })
  assert.ok(ecritures[0].filtres.some(f => f[0] === 'or' && f[1] === 'checkin_time.is.null,checkin_time.eq.'),
    'entre la lecture et l écriture, l hôte a pu saisir son heure : la base le vérifie')
})

test('une heure Beds24 illisible n entre pas dans la fiche', async () => {
  const { mod, ecritures } = chargerSync({ id: 'b1', checkin_time: null, checkout_time: null })
  await mod.syncPropertyHours('u1', '111', { checkInStart: 'flexible', checkOutEnd: '25:00' })
  assert.deepEqual(ecritures, [])
})

// ─── Le message qui porte le code, et la fenêtre du code ───────────────────
test('LE TEST QUI COMPTE : le message du code d accès annonce l heure de la FICHE, pas celle de la base ni de la réservation', () => {
  const { buildMessageDetaille } = require('../lib/message-builder')
  const r = buildMessageDetaille(
    { template_text: 'Arrivée {checkin}, départ {checkout}, code {code_acces}' },
    { firstName: 'Ana', arrival: '2026-12-01', departure: '2026-12-03', checkInStart: '13:00', checkOutEnd: '08:00' },
    'Ana', '4321', { checkin: '15:00', checkout: '09:00' },
    { id: 'P1', name: 'La bulle', address: '1 rue A', checkin_time: '17:00', checkout_time: '12:00' })
  assert.equal(r.texte, 'Arrivée 17:00, départ 12:00, code 4321')
})

test('LE TEST QUI COMPTE : la fenêtre du code (rafraîchissement) finit à l heure de départ de la FICHE', async () => {
  const lus = []
  const generes = []
  const reponses = {
    properties: (f) => (f.select === 'checkout_time' ? { data: { checkout_time: '12:00' }, error: null } : { data: [{ automation_paused: false }], error: null }),
    access_codes: () => ({ data: { id: 'ac1', lock_id: 'l1', seam_code_id: 's1', status: 'active' }, error: null }),
    api_keys: () => ({ data: { seam_api_key: 'k', user_id: 'u1' }, error: null }),
    locks: () => ({ data: { seam_device_id: 'd1', label: 'Porte' }, error: null }),
    knowledge: () => { throw new Error('la base ne porte plus d heure : elle ne doit plus être lue') }
  }
  const from = (table) => {
    const f = { table }
    const b = {
      select (c) { f.select = c; return b },
      eq (c, v) { f[c] = v; return b },
      neq () { return b },
      not () { return b },
      is (c, v) { f[`is_${c}`] = v; return b },
      limit () { return b },
      order () { return b },
      update () { f.update = true; return b },
      insert: async () => ({ error: null }),
      maybeSingle: async () => { lus.push({ ...f }); return reponses[table](f) },
      single: async () => { lus.push({ ...f }); return reponses[table](f) },
      then (res, rej) { lus.push({ ...f }); return Promise.resolve(f.update ? { error: null } : reponses[table](f)).then(res, rej) }
    }
    return b
  }
  const chemins = [
    injecter('../lib/cron-shared', { supabase: { from } }),
    injecter('../lib/alert-notify', { alertMissingAccessCode: async () => {} }),
    injecter('../lib/founder-notify', { reportIncident: async () => {} }),
    injecter('../lib/providers/seam', {
      generateCode: async (a) => { generes.push(a); return { seam_code_id: 's2', code: '9999', starts_at: a.startsAt, ends_at: a.endsAt } },
      deleteCode: async () => {}
    })
  ]
  delete require.cache[require.resolve('../lib/cron-access')]
  const { refreshAccessCode } = require('../lib/cron-access')
  delete require.cache[require.resolve('../lib/cron-access')]
  try {
    await refreshAccessCode('B1', { propertyId: 'P1', arrival: '2026-12-01', departure: '2026-12-03', firstName: 'Ana' }, 'u1')
  } finally {
    for (const c of chemins) delete require.cache[c]
  }
  assert.equal(generes.length, 1, 'un code est généré')
  // 12:00 à Paris (hiver, UTC+1) + 1 h = 12:00Z.
  assert.equal(generes[0].endsAt, '2026-12-03T12:00:00.000Z')
  const lecture = lus.find(l => l.table === 'properties' && l.select === 'checkout_time')
  assert.ok(lecture, 'l heure de départ est lue dans la fiche')
  assert.equal(lecture.user_id, 'u1')
  assert.equal(lecture.provider_property_id, 'P1', 'par la référence du partenaire, jamais l UUID')
  assert.ok(!lus.some(l => l.table === 'knowledge'), 'la base n est plus lue pour l heure')
})

// ─── La reprise base → fiche ───────────────────────────────────────────────
test('planDeReprise : copier, identique, écart, illisible, normaliser, à compléter — et l archivé n est pas touché', () => {
  const { planDeReprise } = require('../lib/heures-logement')
  const biens = [
    { id: 'b1', user_id: 'u1', name: 'Copie', provider_property_id: '1', checkin_time: null, checkout_time: '' },
    { id: 'b2', user_id: 'u1', name: 'Pareil', provider_property_id: '2', checkin_time: '16:00:00', checkout_time: '11:00' },
    { id: 'b3', user_id: 'u1', name: 'Ecart', provider_property_id: '3', checkin_time: '15:00', checkout_time: null },
    { id: 'b4', user_id: 'u1', name: 'Rien', provider_property_id: '4', checkin_time: '16:00:00', checkout_time: null },
    { id: 'b5', user_id: 'u1', name: 'Archive', provider_property_id: '5', checkin_time: null, checkout_time: null, archive_le: '2026-11-01' },
    { id: 'b6', user_id: 'u2', name: 'AutreCompte', provider_property_id: '1', checkin_time: null, checkout_time: null }
  ]
  const lignes = [
    { id: 'k1', user_id: 'u1', property_id: '1', type: 'fixed', key: 'checkin', value: '18h' },
    { id: 'k2', user_id: 'u1', property_id: '1', type: 'fixed', key: 'checkout', value: '12:00' },
    { id: 'k3', user_id: 'u1', property_id: '2', type: 'fixed', key: 'checkin', value: '16:00' },
    { id: 'k4', user_id: 'u1', property_id: '3', type: 'fixed', key: 'checkin', value: '18:00' },
    { id: 'k5', user_id: 'u1', property_id: '3', type: 'fixed', key: 'checkout', value: 'vers midi' },
    { id: 'k6', user_id: 'u1', property_id: '5', type: 'fixed', key: 'checkin', value: '18:00' },
    { id: 'k7', user_id: 'u1', property_id: '1', type: 'faq', key: 'checkin', value: 'une FAQ, pas une heure' }
  ]
  const { plan, archives } = planDeReprise({ biens, lignes })
  const h = (nom, cle) => plan.find(b => b.nom === nom).heures[cle]
  assert.equal(archives, 1)
  assert.equal(plan.some(b => b.nom === 'Archive'), false)
  assert.deepEqual(h('Copie', 'checkin'), { action: 'copier', ecrire: '18:00', supprimerLigne: 'k1', fiche: null, base: '18h' })
  assert.equal(h('Copie', 'checkout').action, 'copier', 'une fiche VIDE (chaîne vide) se remplit aussi')
  assert.deepEqual([h('Pareil', 'checkin').action, h('Pareil', 'checkin').ecrire, h('Pareil', 'checkin').supprimerLigne], ['identique', '16:00', 'k3'])
  assert.deepEqual([h('Pareil', 'checkout').action, h('Pareil', 'checkout').ecrire], ['rien', null])
  assert.deepEqual([h('Ecart', 'checkin').action, h('Ecart', 'checkin').ecrire], ['ecart', '18:00'], 'l heure tapée par l hôte l emporte')
  assert.deepEqual([h('Ecart', 'checkout').action, h('Ecart', 'checkout').ecrire, h('Ecart', 'checkout').supprimerLigne], ['illisible', null, null],
    'une forme illisible n est ni écrite ni supprimée')
  assert.deepEqual([h('Rien', 'checkin').action, h('Rien', 'checkin').ecrire], ['normaliser', '16:00'])
  assert.equal(h('Rien', 'checkout').action, 'a_completer')
  // Le rapprochement se fait par COMPTE et référence : la ligne de u1 ne
  // remplit pas le bien de u2 qui porte la même référence.
  assert.equal(h('AutreCompte', 'checkin').action, 'a_completer')
})

// ─── L'écran : « À compléter », le champ heure, l'avertissement Airbnb ─────
let M, A
test.before(async () => {
  M = await import('../shared/logement-fiche.js')
  A = await import('../shared/accueil-voyageur.js')
})
const fs = require('node:fs')
const path = require('node:path')
const FR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', 'fr.json'), 'utf8'))
const OUTILS = {
  t: (k, v = {}) => { assert.ok(FR[k] != null, `clé absente : ${k}`); return FR[k].replace(/\{(\w+)\}/g, (_, n) => v[n]) },
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function fiche ({ checkin = '', checkout = '', canaux = [{ ota: 'airbnb', titre: 'x', actif: true, mappe: true, listing_url: null }], archive = null } = {}) {
  const { faits } = require('../lib/connaissance')
  return {
    bien: { id: 'b1', archive_le: archive },
    canaux,
    accueil: { faits: faits([], { replis: { checkin, checkout } }) }
  }
}
const corps = (html) => new JSDOM(`<body>${html}</body>`).window.document

test('LE TEST QUI COMPTE : une heure absente se dit « À compléter », avec ce que le voyageur reçoit d ici là', () => {
  const d = corps(M.accueilHtml(fiche(), OUTILS))
  const ligne = d.querySelector('[data-acc-ligne="checkin"]')
  assert.match(ligne.textContent, /À compléter/)
  assert.match(ligne.textContent, /le voyageur reçoit 18:00 par défaut/)
  assert.ok(ligne.querySelector('.kb-a-remplir'), 'en rouge')
  assert.match(d.querySelector('[data-acc-ligne="checkout"]').textContent, /10:00 par défaut/)
  // Remplie : l'heure, sans mention.
  const plein = corps(M.accueilHtml(fiche({ checkin: '15:00', checkout: '10:00' }), OUTILS))
  assert.equal(plein.querySelector('[data-acc-ligne="checkin"] .kb-fait__valeur').textContent, '15:00')
  assert.doesNotMatch(plein.body.textContent, /À compléter|synchronisée/)
})

test('le crayon ouvre un champ HEURE, obligatoire, avec l aide qui le dit avant le clic', () => {
  const d = corps(M.accueilHtml(fiche({ checkin: '16:00' }), OUTILS, { enEdition: 'checkin' }))
  const champ = d.querySelector('[data-acc-edition="checkin"] input[data-acc-saisie]')
  assert.equal(champ.getAttribute('type'), 'time')
  assert.ok(champ.hasAttribute('required'))
  assert.equal(champ.getAttribute('value'), '16:00')
  assert.match(d.querySelector('[data-acc-edition="checkin"]').textContent, /L’heure est obligatoire\./)
  // Une info qui n'est pas une heure garde son champ texte.
  const wifi = corps(M.accueilHtml(fiche(), OUTILS, { enEdition: 'wifi_nom' }))
  assert.equal(wifi.querySelector('[data-acc-edition="wifi_nom"] input').getAttribute('type'), null)
})

test('LE TEST QUI COMPTE : l avertissement Airbnb — arrivée après 16:00 ET canal Airbnb en vente, sinon rien', () => {
  const avec = (o) => corps(M.accueilHtml(fiche(o), OUTILS)).querySelector('[data-acc-airbnb]')
  assert.match(avec({ checkin: '18:00' }).textContent, /Airbnb demande une arrivée au plus tard à 16:00\./)
  assert.equal(avec({ checkin: '16:00' }), null, '16:00 tout juste : dans la limite')
  assert.equal(avec({ checkin: '15:30' }), null)
  assert.equal(avec({ checkin: '' }), null, 'À compléter : rien à comparer')
  assert.equal(avec({ checkin: '18:00', canaux: [{ ota: 'booking', titre: 'x', actif: true, mappe: true }] }), null, 'pas d Airbnb')
  assert.equal(avec({ checkin: '18:00', canaux: [{ ota: 'airbnb', titre: 'x', actif: false, mappe: true }] }), null, 'Airbnb pas en vente')
  assert.equal(avec({ checkin: '18:00', canaux: null }), null, 'canaux non lus : on ne prévient pas sur ce qu on ignore')
  // Le départ n'est pas concerné.
  const d = corps(M.accueilHtml(fiche({ checkin: '15:00', checkout: '18:00' }), OUTILS))
  assert.equal(d.querySelector('[data-acc-airbnb]'), null)
})

test('un logement archivé montre ses heures sans crayon, et n est pas « À compléter »', () => {
  const d = corps(M.accueilHtml(fiche({ archive: '2026-11-01' }), OUTILS))
  assert.equal(d.querySelector('[data-acc-modifier]'), null)
  assert.doesNotMatch(d.body.textContent, /À compléter/)
  assert.match(d.querySelector('[data-acc-ligne="checkin"]').textContent, /18:00/)
})
