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
  assert.deepEqual(h('Copie', 'checkin'), { action: 'copier', ecrire: '18:00', supprimerLigne: 'k1', fiche: null, ficheBrute: null, base: '18h', horsIa: false })
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

// ─── Le générateur du code d'arrivée : fenêtre et message lisent la MÊME heure
// (constat 3 de la relecture 1 : seule la fenêtre du rafraîchissement était
// tenue ; un retour de `ensureCodeCreated` à la base restait vert).
function chargerArrivee ({ codeExistant = null, connaissance = [], modele }) {
  const claims = []
  const taches = []
  const table = (nom) => {
    const q = {
      select () { return q }, eq () { return q }, neq () { return q }, in () { return q },
      is () { return q }, not () { return q }, lte () { return q }, gte () { return q },
      order () { return q }, range () { return q },
      insert (row) {
        if (nom === 'access_codes') claims.push(row)
        if (nom === 'agent_tasks') taches.push(row)
        const fini = { data: null, error: null }
        return {
          select: () => ({ single: async () => ({ data: { id: 'ac-neuf', ...row }, error: null }) }),
          then: (res, rej) => Promise.resolve(fini).then(res, rej)
        }
      },
      upsert () { return Promise.resolve({ data: null, error: null }) },
      update () { return q },
      single: async () => ({ data: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      limit () {
        if (nom === 'access_codes') return Promise.resolve({ data: codeExistant ? [codeExistant] : [] })
        return Promise.resolve({ data: [], error: null })
      },
      then (res, rej) {
        const data = nom === 'message_templates' ? [modele] : nom === 'knowledge' ? connaissance : []
        return Promise.resolve({ data, error: null }).then(res, rej)
      }
    }
    return q
  }
  const chemins = [
    injecter('../lib/cron-shared', {
      supabase: { from: table },
      getPropertyMode: async () => 'test',
      lireReglagesDuBien: async () => ({ mode: 'test', delais: null }),
      isAutomationPaused: async () => false
    }),
    injecter('../lib/alert-notify', { alertMissingAccessCode: async () => {} }),
    injecter('../lib/founder-notify', { reportIncident: async () => {} })
  ]
  delete require.cache[require.resolve('../lib/cles-migrees')]
  delete require.cache[require.resolve('../lib/cron-arrival-code')]
  const mod = require('../lib/cron-arrival-code')
  delete require.cache[require.resolve('../lib/cron-arrival-code')]
  for (const c of chemins) delete require.cache[c]
  return { mod, claims, taches }
}
const jourParis = (d) => new Date(Date.now() + d * 86400000).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' })

test('LE TEST QUI COMPTE : le code créé à l arrivée finit à l heure de départ de la FICHE + 1 h, pas à celle de la base', async () => {
  const { mod, claims } = chargerArrivee({
    connaissance: [{ key: 'checkout', value: '09:00' }],
    modele: { id: 't1', lock_id: 'lock-1', event_type: 'menage_done', active: true, earliest_send_time: '00:00', template_text: 'Départ {checkout}. Code : {code_acces}' }
  })
  const depart = jourParis(3)
  await mod.processArrivalCodes('u1', null,
    { id: 'P1', name: 'La bulle', provider: 'channex', address: '1 rue A', checkin_time: '17:00', checkout_time: '12:00' },
    [{ id: 'R1', arrival: jourParis(0), departure: depart, status: 'confirmed', provider: 'channex', firstName: 'Ana' }], {})
  assert.equal(claims.length, 1, 'le code est réclamé')
  const { fenetreDuCode } = require('../lib/cron-arrival-code')
  assert.equal(claims[0].ends_at, fenetreDuCode(depart, '12:00').endsAt.toISOString(), 'fin = départ de la fiche + 1 h')
  assert.notEqual(claims[0].ends_at, fenetreDuCode(depart, '09:00').endsAt.toISOString())
})

test('LE TEST QUI COMPTE : une fiche à « 12h30 » — le message et la fenêtre disent la même heure (12:30), jamais un code mort à 01:00', async () => {
  const modele = { id: 't1', lock_id: 'lock-1', event_type: 'menage_done', active: true, earliest_send_time: '00:00', template_text: 'Départ {checkout}. Code : {code_acces}' }
  const bien = { id: 'P1', name: 'La bulle', provider: 'channex', address: '1 rue A', checkout_time: '12h30' }
  const depart = jourParis(3)
  const sejour = { id: 'R1', arrival: jourParis(0), departure: depart, status: 'confirmed', provider: 'channex', firstName: 'Ana' }
  const creation = chargerArrivee({ modele })
  await creation.mod.processArrivalCodes('u1', null, bien, [sejour], {})
  const { fenetreDuCode } = require('../lib/cron-arrival-code')
  assert.equal(creation.claims[0].ends_at, fenetreDuCode(depart, '12:30').endsAt.toISOString())
  // ⚠ 12:30 et pas 11:00 (constat 7 de la relecture 2) : 11:00 est aussi le
  // DÉFAUT de la fenêtre, donc une fenêtre qui ignorait la fiche passait ici.
  assert.notEqual(creation.claims[0].ends_at, fenetreDuCode(depart, null).endsAt.toISOString())
  const envoi = chargerArrivee({ modele, codeExistant: { id: 'ac-1', seam_code_id: 's1', code: '123456', status: 'active', created_at: '2026-01-01T00:00:00Z' } })
  await envoi.mod.processArrivalCodes('u1', null, bien, [sejour], {})
  assert.equal(envoi.taches.length, 1)
  assert.match(envoi.taches[0].suggested_reply, /Départ 12:30\. Code : 123456/)
})

test('l alerte « PIN toujours absent » règle son délai sur l heure d arrivée de la FICHE', () => {
  const { pinAlertDue } = require('../lib/cron-arrival-code')
  // ⚠ DATES FIGÉES, HORLOGE INJECTÉE (constat 2 de la relecture 2) : 9 h à
  // Paris le 10 décembre 2026 (heure d'hiver, UTC+1).
  const MAINTENANT = new Date('2026-12-10T08:00:00Z')
  // Code réclamé il y a 10 min : sous le seuil d'une arrivée lointaine (30 min)
  // comme d'une arrivée à 6 h (15 min), au-dessus d'une arrivée proche (5 min).
  const code = { created_at: '2026-12-10T07:50:00Z' }
  assert.equal(pinAlertDue(code, { arrival: '2026-12-10', checkInStart: '10:00' }, { checkin_time: '19:00' }, MAINTENANT), false,
    'la fiche dit 19:00, la réservation 10:00 : c est la FICHE qui règle, on patiente')
  assert.equal(pinAlertDue(code, { arrival: '2026-12-10' }, { checkin_time: '10:00' }, MAINTENANT), true,
    'la fiche dit 10:00 (dans 1 h) : on alerte — le repli 15:00 aurait patienté')
  assert.equal(pinAlertDue(code, { arrival: '2026-12-10', checkInStart: '10:00' }, { checkin_time: '4pm' }, MAINTENANT), true,
    'une fiche illisible ne vaut rien : l heure de la réservation reprend la main')
})

test('planDeReprise : une ligne cachée à l IA est signalée, les lignes sans logement sont comptées', () => {
  const { planDeReprise } = require('../lib/heures-logement')
  const { plan, orphelines } = planDeReprise({
    biens: [{ id: 'b1', user_id: 'u1', name: 'Bien', provider_property_id: '1', checkin_time: null, checkout_time: null }],
    lignes: [
      { id: 'k1', user_id: 'u1', property_id: '1', type: 'fixed', key: 'checkin', value: '18:00', lisible_par_ia: false },
      { id: 'k2', user_id: 'u1', property_id: '99', type: 'fixed', key: 'checkin', value: '18:00' }
    ]
  })
  assert.equal(plan[0].heures.checkin.horsIa, true)
  assert.equal(plan[0].heures.checkout.horsIa, false)
  assert.equal(orphelines, 1)
})

// ─── L'exécution de la reprise (constat 8 de la relecture 1) ───────────────
function doubleReprise ({ ficheAChange = false, echecBase = false } = {}) {
  const gestes = []
  const sb = {
    from (table) {
      const g = { table, op: 'select', filtres: [] }
      const b = {
        update (c) { g.op = 'update'; g.charge = c; return b },
        delete () { g.op = 'delete'; return b },
        eq (c, v) { g.filtres.push(['eq', c, v]); return b },
        is (c, v) { g.filtres.push(['is', c, v]); return b },
        or (x) { g.filtres.push(['or', x]); return b },
        select () { return b },
        maybeSingle: async () => { gestes.push(g); return { data: ficheAChange ? null : { id: 'x' }, error: null } },
        then (res, rej) { gestes.push(g); return Promise.resolve({ error: echecBase ? { message: 'panne' } : null }).then(res, rej) }
      }
      return b
    }
  }
  return { sb, gestes }
}
const PLAN = [{ id: 'b1', userId: 'u1', nom: 'Bien', ref: '1', heures: {
  checkin: { action: 'copier', ecrire: '18:00', supprimerLigne: 'k1', ficheBrute: null },
  checkout: { action: 'ecart', ecrire: '12:00', supprimerLigne: 'k2', ficheBrute: '11:00' }
} }]

test('LE TEST QUI COMPTE : --go écrit la fiche SOUS CONDITION, puis retire la ligne de base — dans cet ordre', async () => {
  const { executerReprise } = require('../lib/heures-logement')
  const { sb, gestes } = doubleReprise()
  const bilan = await executerReprise(sb, PLAN, { supprimer: true })
  assert.deepEqual(gestes.map(g => `${g.table}:${g.op}`), ['properties:update', 'knowledge:delete', 'properties:update', 'knowledge:delete'])
  assert.ok(gestes[0].filtres.some(f => f[0] === 'is' && f[1] === 'checkin_time' && f[2] === null), 'une copie sur une fiche lue NULL exige une fiche encore NULL')
  assert.ok(gestes[2].filtres.some(f => f[0] === 'eq' && f[1] === 'checkout_time' && f[2] === '11:00'), 'un écart exige la valeur lue')
  assert.ok(gestes[1].filtres.some(f => f[1] === 'property_id' && f[2] === '1'), 'la ligne de base par la RÉFÉRENCE, jamais l UUID')
  assert.deepEqual([bilan.ecrites, bilan.supprimees, bilan.sautees.length, bilan.echecs.length], [2, 2, 0, 0])
})

test('--copier écrit la fiche et ne retire AUCUNE ligne de base (avant le merge)', async () => {
  const { executerReprise } = require('../lib/heures-logement')
  const { sb, gestes } = doubleReprise()
  const bilan = await executerReprise(sb, PLAN, { supprimer: false })
  assert.deepEqual(gestes.map(g => `${g.table}:${g.op}`), ['properties:update', 'properties:update'])
  assert.equal(bilan.supprimees, 0)
})

// Constat 4 de la relecture 2 : `.or(is.null,eq.)` ne retenait pas une fiche
// faite d'espaces, que le plan classe pourtant « vide » — sautée à chaque
// passage, avec le faux motif « la fiche a changé ».
test('une fiche faite d ESPACES se copie : l écriture exige la valeur LUE, telle quelle', async () => {
  const { planDeReprise, executerReprise } = require('../lib/heures-logement')
  const { plan } = planDeReprise({
    biens: [{ id: 'b1', user_id: 'u1', name: 'Bien', provider_property_id: '1', checkin_time: '  ', checkout_time: '' }],
    lignes: [
      { id: 'k1', user_id: 'u1', property_id: '1', type: 'fixed', key: 'checkin', value: '18:00' },
      { id: 'k2', user_id: 'u1', property_id: '1', type: 'fixed', key: 'checkout', value: '10:00' }
    ]
  })
  assert.equal(plan[0].heures.checkin.action, 'copier')
  const { sb, gestes } = doubleReprise()
  await executerReprise(sb, plan, { supprimer: false })
  const [arrivee, depart] = gestes.filter(g => g.op === 'update')
  assert.ok(arrivee.filtres.some(f => f[0] === 'eq' && f[1] === 'checkin_time' && f[2] === '  '), 'la valeur lue, espaces compris')
  assert.ok(depart.filtres.some(f => f[0] === 'eq' && f[1] === 'checkout_time' && f[2] === ''), 'la chaîne vide lue')
  assert.equal(gestes.some(g => g.filtres.some(f => f[0] === 'or')), false)
})

// ─── Le script (constats 5 et 9 de la relecture 2) ─────────────────────────
function doubleScript ({ biens, lignes, ficheAChange = false }) {
  const ecritures = []
  const sb = {
    from (table) {
      const g = { table, op: 'select', filtres: [] }
      const b = {
        select () { return b },
        order () { return b },
        limit () { return b },
        gt () { return b },
        in () { return b },
        update (c) { g.op = 'update'; g.charge = c; return b },
        delete () { g.op = 'delete'; return b },
        eq (c, v) { g.filtres.push(['eq', c, v]); return b },
        is (c, v) { g.filtres.push(['is', c, v]); return b },
        maybeSingle: async () => { ecritures.push(g); return { data: ficheAChange ? null : { id: 'x' }, error: null } },
        then (res, rej) {
          if (g.op !== 'select') ecritures.push(g)
          const data = g.op === 'select' ? (table === 'properties' ? biens : lignes) : null
          return Promise.resolve({ data, error: null }).then(res, rej)
        }
      }
      return b
    }
  }
  return { sb, ecritures }
}
const BIENS_SCRIPT = [{ id: 'b1', user_id: 'u1', name: 'Cœur', provider_property_id: '1', checkin_time: '15:00', checkout_time: null, archive_le: null }]
const LIGNES_SCRIPT = [
  { id: 'k1', user_id: 'u1', property_id: '1', type: 'fixed', key: 'checkin', value: '18:00', lisible_par_ia: false },
  { id: 'k2', user_id: 'u1', property_id: '1', type: 'fixed', key: 'checkout', value: 'midi', lisible_par_ia: false }
]

test('LE TEST QUI COMPTE : à blanc, le script lit, montre — et n écrit RIEN', async () => {
  const { lancer } = require('../scripts/reprendre-heures-fiche')
  const { sb, ecritures } = doubleScript({ biens: BIENS_SCRIPT, lignes: LIGNES_SCRIPT })
  const sortie = []
  const code = await lancer({ sb, mode: 'blanc', log: (l) => sortie.push(l), err: (l) => sortie.push(l) })
  assert.equal(code, 0)
  assert.deepEqual(ecritures, [], 'aucune écriture, aucun retrait')
  const montrer = sortie.find(l => l.startsWith('À montrer'))
  // L'action ET la mention (constat 5) : l'écart reste visible, et une ligne
  // illisible — jamais retirée — ne dit pas « la retirer la lui rend ».
  assert.match(montrer, /Cœur \(arrivée\) : ecart → 18:00, cachée à l’IA — la retirer la lui rend/)
  assert.match(montrer, /Cœur \(départ\) : illisible, cachée à l’IA(?! —)/)
})

test('un geste SAUTÉ au --go sort en code 2, jamais en 0', async () => {
  const { lancer } = require('../scripts/reprendre-heures-fiche')
  const { sb, ecritures } = doubleScript({ biens: BIENS_SCRIPT, lignes: LIGNES_SCRIPT, ficheAChange: true })
  const code = await lancer({ sb, mode: 'go', log: () => {}, err: () => {} })
  assert.equal(code, 2)
  assert.equal(ecritures.filter(g => g.op === 'delete').length, 0, 'la ligne de base reste')
})

test('fiche changée depuis la lecture : rien n est écrit, la ligne de base RESTE, et on le dit', async () => {
  const { executerReprise } = require('../lib/heures-logement')
  const { sb, gestes } = doubleReprise({ ficheAChange: true })
  const bilan = await executerReprise(sb, PLAN, { supprimer: true })
  assert.equal(gestes.filter(g => g.op === 'delete').length, 0)
  assert.equal(bilan.sautees.length, 2)
  assert.equal(bilan.ecrites, 0)
})
