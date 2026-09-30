// tests/retrait-fenetre.test.js — lot 4.6.6, REDUIRE LA FENETRE D'UN BIEN
// PILOTE RETIRE DE LA VENTE LES NUITS QUI EN SORTENT (decision de Thierry du
// 30 septembre 2026).
//
// CE QU'ILS DEFENDENT, dans l'ordre d'importance :
//   1. jamais « fermee chez nous, ouverte chez le canal » : si le canal refuse,
//      l'etat d'avant est RETABLI et aucune ligne n'est supprimee ;
//   2. jamais de ligne `stop_sell` laissee en base apres un retrait accepte —
//      elle serait lue comme une intention de l'hote (le reliquat du
//      10 septembre) : les lignes sont SUPPRIMEES, la nuit redevient « pas
//      encore ouverte » ;
//   3. l'ecriture s'annonce AVANT d'ecrire, et sans trace rien n'est ecrit ;
//   4. une nuit vendue, ou fermee entre-temps, n'est jamais touchee ;
//   5. l'endpoint : la fenetre est reduite AVANT le retrait (le pilote ne
//      rouvre pas entre les deux), retablie si le retrait echoue, et le
//      nombre confirme doit etre celui d'aujourd'hui.
//
// ⚠ CES TESTS EXECUTENT LE WRITER (faux client, faux canal), ils ne le lisent pas.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const etat = { occupees: {}, ordre: [] }
const origine = Module._load
Module._load = function (d, ...reste) {
  if (/\/price-log$/.test(d)) {
    const vrai = origine.apply(this, [d, ...reste])
    return { ...vrai, enregistrerPrixPousses: async () => ({ ecrites: 0 }) }
  }
  if (/\/nuits-occupees$/.test(d)) return { nuitsOccupees: async () => etat.occupees }
  if (/\/founder-notify$/.test(d)) return { reportIncident: async () => ({}) }
  if (/\/channel-availability$/.test(d)) return { reaffirmerStopSell: async () => ({}) }
  return origine.apply(this, [d, ...reste])
}
const { retirerDeLaVente } = require('../lib/calendrier-writer')
const { nuitsQuiSortent } = require('../lib/retrait-fenetre')
test.after(() => { Module._load = origine })

const ID = 'b1b1b1b1-0000-4000-8000-000000000001'
const COMPTE = 'a1a1a1a1-0000-4000-8000-000000000001'
const BIEN = {
  id: ID, user_id: COMPTE, name: 'Loft', provider: 'channex',
  provider_property_id: 'P1', provider_room_type_id: 'RT1', provider_rate_plan_id: 'RP1',
  rate_sync_mode: 'managed', pilote_tarifaire: 'yieldflow',
  pilote_fenetre_type: 'jours', pilote_fenetre_valeur: 10,
  base_price: 100, prix_minimum: 3000, capacity: 2, included_guests: 2, extra_guest_fee: 0, inventory_units: 1
}

// Faux client : `calendar_inventory` vivant (lecture filtree, upsert, delete
// conditionnel) ; `automation_incidents` rend la trace si l'annonce a eu lieu.
function fausseBase (lignes, { annonceEnregistree = true } = {}) {
  const table = new Map(lignes.map(l => [l.date, { property_id: ID, ...l }]))
  const journal = []
  const client = {
    table, journal,
    from (nom) {
      const q = { f: {}, inn: null, sup: null, plage: null, del: false }
      q.select = () => q
      q.eq = (c, v) => { q.f[c] = v; return q }
      q.in = (c, v) => { q.inn = [c, v]; return q }
      q.gt = (c, v) => { q.sup = [c, v]; return q }
      q.gte = () => q; q.lte = () => q; q.order = () => q; q.limit = () => q
      q.range = (a, b) => { q.plage = [a, b]; return q }
      q.maybeSingle = async () => ({ data: null, error: null })
      const filtre = () => [...table.values()].filter(l =>
        Object.entries(q.f).every(([c, v]) => l[c] === v) &&
        (!q.inn || q.inn[1].includes(l[q.inn[0]])) &&
        (!q.sup || l[q.sup[0]] > q.sup[1])).sort((a, b) => (a.date < b.date ? -1 : 1))
      q.delete = () => { q.del = true; return q }
      q.upsert = async (rows) => {
        journal.push({ geste: 'upsert', dates: rows.map(r => r.date), stop_sell: [...new Set(rows.map(r => r.stop_sell))] })
        for (const r of rows) table.set(r.date, { ...table.get(r.date), ...r })
        return { error: null }
      }
      q.then = (res) => {
        if (nom === 'automation_incidents') return Promise.resolve({ data: annonceEnregistree && etat.ordre.includes('annonce') ? [{ id: 1 }] : [], error: null }).then(res)
        if (nom !== 'calendar_inventory') return Promise.resolve({ data: [], error: null }).then(res)
        const out = filtre()
        if (q.del) {
          for (const l of out) table.delete(l.date)
          journal.push({ geste: 'delete', dates: out.map(l => l.date) })
        }
        return Promise.resolve({ data: q.plage ? out.slice(q.plage[0], q.plage[1] + 1) : out, error: null }).then(res)
      }
      return q
    }
  }
  return client
}
const canal = (ok = true) => {
  const f = async (m, chemin, corps) => { f.appels.push({ chemin, corps }); return { ok, status: ok ? 200 : 500, json: {} } }
  f.appels = []
  return f
}
const annonce = async () => { etat.ordre.push('annonce'); return {} }
const OUVERTES = ['2026-12-01', '2026-12-02', '2026-12-03'].map(date => ({ date, stop_sell: false, avail: 1, rate: 120 }))

test('LE TEST QUI COMPTE : canal d accord — fermee chez le canal, PUIS lignes supprimees ; aucune ligne stop_sell ne reste', async () => {
  etat.ordre = []
  const sb = fausseBase(OUVERTES)
  const appel = canal(true)
  const r = await retirerDeLaVente({ supabase: sb, bien: BIEN, compte: COMPTE, dates: OUVERTES.map(l => l.date), appel, deps: { reportIncident: annonce } })
  assert.deepEqual(r, { ok: true, retirees: 3, demandees: 3 })
  assert.deepEqual(sb.journal.map(j => j.geste), ['upsert', 'delete'])
  assert.deepEqual(sb.journal[0].stop_sell, [true])
  assert.ok(appel.appels.some(a => a.chemin === '/availability'), 'la fermeture est partie au canal')
  assert.equal(sb.table.size, 0, 'plus aucune ligne : les nuits sont « pas encore ouvertes »')
})

test('LE TEST QUI COMPTE : canal refuse — etat d avant RETABLI, rien supprime, jamais « fermee chez nous, ouverte chez le canal »', async () => {
  etat.ordre = []
  const sb = fausseBase(OUVERTES.map(l => ({ ...l })))
  const r = await retirerDeLaVente({ supabase: sb, bien: BIEN, compte: COMPTE, dates: OUVERTES.map(l => l.date), appel: canal(false), deps: { reportIncident: annonce } })
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'canal_refuse')
  assert.deepEqual(sb.journal.map(j => j.geste), ['upsert', 'upsert'], 'fermeture puis retablissement, aucune suppression')
  assert.deepEqual(sb.journal[1].stop_sell, [false])
  assert.deepEqual([...sb.table.values()].map(l => [l.date, l.stop_sell, l.avail]),
    [['2026-12-01', false, 1], ['2026-12-02', false, 1], ['2026-12-03', false, 1]])
})

test('l ecriture s annonce AVANT d ecrire ; sans trace de l annonce, rien n est ecrit', async () => {
  etat.ordre = []
  const sb = fausseBase(OUVERTES.map(l => ({ ...l })), { annonceEnregistree: false })
  const appel = canal(true)
  const r = await retirerDeLaVente({ supabase: sb, bien: BIEN, compte: COMPTE, dates: OUVERTES.map(l => l.date), appel, deps: { reportIncident: annonce } })
  assert.deepEqual([r.ok, r.raison], [false, 'annonce'])
  assert.deepEqual(sb.journal, [])
  assert.equal(appel.appels.length, 0)
})

test('une nuit FERMEE entre la confirmation et le geste n est pas touchee', async () => {
  etat.ordre = []
  const lignes = [...OUVERTES.map(l => ({ ...l })), { date: '2026-12-04', stop_sell: true, avail: 0, rate: 120 }]
  const sb = fausseBase(lignes)
  const r = await retirerDeLaVente({ supabase: sb, bien: BIEN, compte: COMPTE, dates: [...OUVERTES.map(l => l.date), '2026-12-04'], appel: canal(true), deps: { reportIncident: annonce } })
  assert.deepEqual(r, { ok: true, retirees: 3, demandees: 3 })
  assert.deepEqual([...sb.table.values()].map(l => l.date), ['2026-12-04'], 'la fermeture de l hote reste')
})

test('nuitsQuiSortent : les nuits OUVERTES apres la nouvelle fin, moins les vendues ; une fenetre inchangee range aussi un reliquat', async () => {
  const lignes = [
    { date: '2026-10-05', stop_sell: false, avail: 1 },   // dans la fenetre
    { date: '2026-10-20', stop_sell: false, avail: 1 },   // sort
    { date: '2026-10-21', stop_sell: false, avail: 0 },   // sort ? vendue
    { date: '2026-10-22', stop_sell: true, avail: 0 },    // fermee : jamais listee
    { date: '2026-11-30', stop_sell: false, avail: 1 }]   // sort
  etat.occupees = { '2026-10-21': [{ id: 'resa' }] }
  const sb = fausseBase(lignes)
  const q = await nuitsQuiSortent(sb, BIEN, { type: 'jours', valeur: 10 }, '2026-10-01')
  assert.deepEqual([q.nouvelleFin, q.dates, q.vendues, q.reduction], ['2026-10-11', ['2026-10-20', '2026-11-30'], 1, false])
  const plus = await nuitsQuiSortent(sb, BIEN, { type: 'jours', valeur: 5 }, '2026-10-01')
  assert.deepEqual([plus.nouvelleFin, plus.dates, plus.reduction], ['2026-10-06', ['2026-10-20', '2026-11-30'], true])
  etat.occupees = {}
})

// ─── L'endpoint ─────────────────────────────────────────────────────────────
function chargerEndpoint ({ sortantes, retrait }) {
  const gestes = []
  const bienBase = { ...BIEN }
  const sb = {
    from (nom) {
      const q = { maj: null }
      q.select = () => q; q.eq = () => q
      q.maybeSingle = async () => ({ data: { ...bienBase }, error: null })
      q.update = (maj) => { q.maj = maj; gestes.push(['update', maj.pilote_fenetre_valeur ?? maj.pilote_tarifaire]); return q }
      q.then = (res) => Promise.resolve({ error: null }).then(res)
      return q
    }
  }
  const chemins = {
    '@supabase/supabase-js': { createClient: () => sb },
    '/require-permission': { requirePermission: async () => ({ ok: true, bien: { id: ID }, accountUserId: COMPTE }) },
    '/retrait-fenetre': { nuitsQuiSortent: async () => ({ dates: sortantes, vendues: 0, reduction: true, nouvelleFin: '2026-10-11', ancienneFin: '2026-10-31' }) },
    '/channel-fullsync': { channelCall: async () => ({ ok: true }) },
    '/ouverture-marqueur': { effacerMarqueur: async () => ({}), lireMarqueur: async () => null, jourParis: () => '2026-10-01' }
  }
  const avant = Module._load
  Module._load = function (d, ...reste) {
    for (const [cle, val] of Object.entries(chemins)) if (d === cle || d.endsWith(cle)) return val
    if (/\/calendrier-writer$/.test(d)) return { retirerDeLaVente: async (o) => { gestes.push(['retrait', o.dates.length]); return retrait } }
    return avant.apply(this, [d, ...reste])
  }
  delete require.cache[require.resolve('../api/yield-pilote')]
  const api = require('../api/yield-pilote')
  Module._load = avant
  const appeler = body => new Promise(resolve => {
    let code = 200
    const res = { status (c) { code = c; return res }, setHeader () {}, json: corps => resolve({ code, corps }) }
    api({ method: 'POST', query: {}, body: { bien: ID, ...body }, headers: {} }, res)
  })
  return { appeler, gestes }
}

test('LE TEST QUI COMPTE (endpoint) : sans le nombre confirme, 409 et RIEN n est ecrit ; avec, la fenetre d abord, le retrait ensuite', async () => {
  const e = chargerEndpoint({ sortantes: ['2026-10-20', '2026-10-21'], retrait: { ok: true, retirees: 2 } })
  const sans = await e.appeler({ fenetre: { type: 'jours', valeur: 10 } })
  assert.equal(sans.code, 409)
  assert.equal(sans.corps.code, 'retrait_a_confirmer')
  assert.deepEqual(sans.corps.retrait, { nuits: 2, du: '2026-10-20', au: '2026-10-21', vendues: 0, fin: '2026-10-11' })
  assert.deepEqual(e.gestes, [])
  const faux = await e.appeler({ fenetre: { type: 'jours', valeur: 10 }, retrait_confirme: 5 })
  assert.equal(faux.code, 409, 'un nombre perime redemande')
  const ok = await e.appeler({ fenetre: { type: 'jours', valeur: 10 }, retrait_confirme: 2 })
  assert.equal(ok.code, 200)
  assert.equal(ok.corps.retirees, 2)
  assert.deepEqual(e.gestes, [['update', 10], ['retrait', 2]], 'fenetre reduite AVANT le retrait')
})

test('LE TEST QUI COMPTE (endpoint) : retrait refuse — la fenetre d avant est RETABLIE et l erreur dite', async () => {
  const e = chargerEndpoint({ sortantes: ['2026-10-20'], retrait: { ok: false, raison: 'canal_refuse', message: 'Le canal a refusé.' } })
  const r = await e.appeler({ fenetre: { type: 'jours', valeur: 5 }, retrait_confirme: 1 })
  assert.equal(r.code, 502)
  assert.equal(r.corps.code, 'retrait_canal_refuse')
  assert.equal(r.corps.fenetre_retablie, true)
  assert.deepEqual(e.gestes, [['update', 5], ['retrait', 1], ['update', 10]], 'reduite, retrait refuse, retablie a 10')
})

test('endpoint : fenetre inchangee MAIS des nuits en vente au-dela — le retrait a lieu (c est ainsi qu un reliquat se range)', async () => {
  const e = chargerEndpoint({ sortantes: ['2026-10-20'], retrait: { ok: true, retirees: 1 } })
  const r = await e.appeler({ fenetre: { type: 'jours', valeur: 10 }, retrait_confirme: 1 })
  assert.equal(r.code, 200)
  assert.deepEqual(e.gestes, [['update', 10], ['retrait', 1]])
  const rien = chargerEndpoint({ sortantes: [], retrait: { ok: true, retirees: 0 } })
  const r2 = await rien.appeler({ fenetre: { type: 'jours', valeur: 10 } })
  assert.equal(r2.corps.change, false, 'rien a retirer, meme fenetre : rien a faire')
  assert.deepEqual(rien.gestes, [])
})

test('LE TEST QUI COMPTE (frontiere) : retirerDeLaVente ne sait QUE fermer — aucun prix, aucune ouverture ne part au canal', async () => {
  etat.ordre = []
  const sb = fausseBase(OUVERTES.map(l => ({ ...l })))
  const appel = canal(true)
  await retirerDeLaVente({ supabase: sb, bien: BIEN, compte: COMPTE, dates: OUVERTES.map(l => l.date), appel, deps: { reportIncident: annonce } })
  const valeurs = appel.appels.flatMap(a => (a.corps && a.corps.values) || [])
  assert.ok(valeurs.length > 0)
  for (const v of valeurs) {
    assert.ok(!('rate' in v) && !('rates' in v), `aucun prix pousse : ${JSON.stringify(v)}`)
    if ('availability' in v) assert.equal(v.availability, 0)
    if ('stop_sell' in v) assert.equal(v.stop_sell, true)
  }
  // Et sa signature n'a pas d'entree de prix : seules des dates.
  const src = require('fs').readFileSync(require.resolve('../lib/calendrier-writer'), 'utf8')
  const sig = /async function retirerDeLaVente \(\{([^}]*)\}/.exec(src)[1].split(',').map(x => x.trim().split(/\s|=/)[0]).filter(Boolean)
  assert.deepEqual(sig, ['supabase', 'bien', 'compte', 'dates', 'appel', 'deps'])
})
