// tests/canal-calendrier.test.js — lot 4.6.1, LE CANAL INTERNE ET LE WRITER.
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter, section 2.
//
// CE QUE CES TESTS DEFENDENT, dans l'ordre d'importance :
//   1. le canal est INTERNE : aucun endpoint, aucun champ HTTP ne l'ouvre ;
//   2. un writer, deux portes : la porte HTTP et le canal appellent la MEME
//      fonction, et le comportement de la porte HTTP n'a pas bouge ;
//   3. le canal ne tarife QUE un bien pilote, n'ouvre pas au-dela de la
//      fenetre, et ne rouvre pas une nuit fermee ;
//   4. le journal retient l'ORIGINE ('engine'), pas un 'host' recopie.
//
// ⚠ CES TESTS EXECUTENT LE WRITER, ils ne le lisent pas. Un faux `supabase`
// enregistre chaque ecriture, un faux `appel` chaque POST vers le canal.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const Module = require('node:module')
const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

// Le journal et les nuits occupees sont doubles : on ne teste ici ni l'un ni
// l'autre, seulement ce que le writer leur PASSE.
const etat = { journal: [], occupees: {} }
const origine = Module._load
Module._load = function (d, ...reste) {
  if (/\/price-log$/.test(d)) {
    const vrai = origine.apply(this, [d, ...reste])
    return { ...vrai, enregistrerPrixPousses: async (sb, o) => { etat.journal.push(o); return { ecrites: Object.keys(o.nuits).length } } }
  }
  if (/\/nuits-occupees$/.test(d)) return { nuitsOccupees: async () => etat.occupees }
  if (/\/founder-notify$/.test(d)) return { reportIncident: async () => ({}) }
  if (/\/channel-availability$/.test(d)) return { reaffirmerStopSell: async () => ({}) }
  return origine.apply(this, [d, ...reste])
}
const { ecrireCalendrier } = require('../lib/calendrier-writer')
const { demanderAuCalendrier, REFUS } = require('../lib/canal-calendrier')
test.after(() => { Module._load = origine })

const AUJ = '2026-09-20'
const BIEN = {
  id: 'b-uuid-1', user_id: 'compte-A', name: 'Loft', provider: 'channex',
  provider_property_id: 'P1', provider_room_type_id: 'RT1', provider_rate_plan_id: 'RP1',
  rate_sync_mode: 'managed', pilote_tarifaire: 'yieldflow',
  pilote_fenetre_type: 'jours', pilote_fenetre_valeur: 10,
  base_price: 100, prix_minimum: 3000, capacity: 2, included_guests: 2, extra_guest_fee: 0,
  inventory_units: 1
}
const CALENDRIER = { ...BIEN, pilote_tarifaire: 'calendrier' }

// Faux client : `calendar_inventory` en lecture (lignes fournies) et en
// ecriture (enregistree). Tout le reste rend vide.
function fausseBase (lignes = []) {
  const ecritures = []
  const client = {
    ecritures,
    from (table) {
      const q = { _f: {}, _in: null }
      q.select = () => q
      q.eq = (c, v) => { q._f[c] = v; return q }
      q.in = (c, v) => { q._in = [c, v]; return q }
      q.gte = () => q; q.lte = () => q; q.order = () => q; q.limit = () => q
      q.maybeSingle = async () => ({ data: null, error: null })
      q.then = (res) => {
        if (table !== 'calendar_inventory') return Promise.resolve({ data: [], error: null }).then(res)
        const dates = q._in && q._in[0] === 'date' ? new Set(q._in[1]) : null
        const data = lignes.filter(l => !dates || dates.has(l.date))
        return Promise.resolve({ data, error: null }).then(res)
      }
      q.upsert = async (rows) => { ecritures.push({ table, rows }); return { error: null } }
      q.update = () => ({ eq: () => ({ eq: async () => ({ error: null }) }) })
      return q
    }
  }
  return client
}
function fauxAppel () {
  const appels = []
  const appel = async (method, p, body) => { appels.push({ method, path: p, body }); return { ok: true, status: 200, json: { data: { id: 't' } } } }
  appel.appels = appels
  return appel
}
const ligne = (date, extra = {}) => ({ property_id: BIEN.id, date, rate: 120, avail: 1, stop_sell: false, ...extra })

// ─── 1. Le canal est INTERNE ────────────────────────────────────────────────
test('LE TEST QUI COMPTE : aucun endpoint n expose le canal interne', () => {
  // La garde du §2 bis refuse par HTTP tout `rate` sur un bien pilote. Si un
  // endpoint appelait `demanderAuCalendrier` ou `ecrireCalendrier` avec une
  // origine venue du corps, la garde tomberait par sa porte de service.
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'api'))) {
    if (!f.endsWith('.js')) continue
    const src = lire(`api/${f}`)
    assert.ok(!/canal-calendrier/.test(src), `${f} n a pas a connaitre le canal interne`)
    if (/calendrier-writer/.test(src)) {
      assert.equal(f, 'calendar.js', `${f} : seule la porte HTTP du calendrier appelle le writer`)
      assert.ok(/origine: 'host'/.test(src), 'et elle dit qui elle est')
      assert.ok(!/origine: (req|body|String\(|\()/.test(src), 'l origine ne vient JAMAIS de la requete')
    }
  }
  const canal = lire('lib/canal-calendrier.js')
  assert.ok(/ORIGINE = 'engine'/.test(canal))
  assert.ok(!/module\.exports = async function handler|req\.body|res\.status/.test(canal), 'le canal n est pas un handler')
})

// ─── 2. Un writer, deux portes ──────────────────────────────────────────────
test('LE TEST QUI COMPTE : la porte HTTP ne porte plus AUCUNE ecriture du calendrier', () => {
  // Tout ce qui ecrit `calendar_inventory` ou pousse vers le canal vit dans le
  // writer. Il en resterait une copie dans l'endpoint qu'on aurait deux
  // verites — le defaut que le chantier « writer unique » a ferme.
  const api = lire('api/calendar.js')
  const save = api.split("if (action !== 'save')")[1]
  assert.ok(!/from\('calendar_inventory'\)[\s\S]{0,300}upsert/.test(save), 'aucun upsert dans la porte')
  assert.ok(!/POST', '\/restrictions|POST', '\/availability/.test(api), 'aucune poussee dans la porte')
  assert.ok(!/enregistrerPrixPousses\(/.test(api), 'aucun journal dans la porte')
  assert.ok(/ecrireCalendrier\(\{/.test(save), 'elle appelle le writer')
  const w = lire('lib/calendrier-writer.js')
  assert.ok(/\.upsert\(rows, \{ onConflict: 'property_id,date' \}\)/.test(w))
  assert.ok(/enregistrerPrixPousses\(supabase, \{/.test(w))
  assert.ok(!/\bres\.|\breq\./.test(w), 'le writer ne connait ni req ni res')
})

test('le writer ecrit, pousse et journalise — avec l origine qu on lui donne', async () => {
  etat.journal = []
  const sb = fausseBase([ligne('2026-09-25')])
  const appel = fauxAppel()
  const r = await ecrireCalendrier({
    supabase: sb, bien: BIEN, compte: 'compte-A', origine: 'engine', appel,
    dateSegments: [{ date_from: '2026-09-25', date_to: '2026-09-26', rate: 150, avail: 1, stop_sell: false }]
  })
  assert.ok(!r.refus, JSON.stringify(r.refus))
  assert.equal(r.saved, 2)
  const up = sb.ecritures.find(e => e.table === 'calendar_inventory')
  assert.ok(up, 'upsert de calendar_inventory')
  assert.deepEqual(up.rows.map(x => x.date).sort(), ['2026-09-25', '2026-09-26'])
  assert.ok(up.rows.every(x => x.rate === 150 && x.stop_sell === false && x.avail === 1))
  // Availability AVANT restrictions : l'ordre du 7 septembre.
  const chemins = appel.appels.map(a => a.path)
  assert.ok(chemins.indexOf('/availability') < chemins.indexOf('/restrictions'), chemins.join(' > '))
  // Le journal porte l'ORIGINE.
  assert.equal(etat.journal.length, 1)
  assert.equal(etat.journal[0].source, 'engine')
  assert.equal(etat.journal[0].propertyId, BIEN.id)
  assert.deepEqual(Object.keys(etat.journal[0].nuits).sort(), ['2026-09-25', '2026-09-26'])
})

test('le plancher tient par les deux portes : c est un refus du writer, pas de l endpoint', async () => {
  const sb = fausseBase([])
  const r = await ecrireCalendrier({
    supabase: sb, bien: BIEN, compte: 'compte-A', origine: 'engine', appel: fauxAppel(),
    dateSegments: [{ date_from: '2026-09-25', date_to: '2026-09-25', rate: 20 }]
  })
  assert.ok(r.refus, 'refuse')
  assert.equal(r.refus.status, 400)
  assert.equal(r.refus.body.code, 'prix_sous_plancher')
  assert.equal(sb.ecritures.length, 0, 'et RIEN n est ecrit')
})

// ─── 3. Les gardes du canal ─────────────────────────────────────────────────
test('LE TEST QUI COMPTE : le canal ne tarife QUE un bien pilote', async () => {
  const sb = fausseBase([])
  const r = await demanderAuCalendrier(sb, CALENDRIER,
    { aujourdHui: AUJ, nuits: [{ date: '2026-09-25', prix_centimes: 15000 }] }, { appel: fauxAppel() })
  assert.equal(r.ok, false)
  assert.equal(r.refus, REFUS.BIEN_NON_PILOTE)
  assert.ok(/main de l’hôte|main de l'hôte/.test(r.message))
  assert.equal(sb.ecritures.length, 0)
})

test('LE TEST QUI COMPTE : le canal n ouvre pas au-dela de la fenetre — il IGNORE et le dit', async () => {
  etat.journal = []
  const sb = fausseBase([])
  const appel = fauxAppel()
  const r = await demanderAuCalendrier(sb, BIEN, { aujourdHui: AUJ, nuits: [
    { date: '2026-09-25', ouvrir: true, prix_centimes: 15000 },   // dans la fenetre (fin : 30/09)
    { date: '2026-10-05', ouvrir: true, prix_centimes: 15000 }    // au-dela
  ] }, { appel })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ignorees.hors_fenetre, ['2026-10-05'])
  const up = sb.ecritures.find(e => e.table === 'calendar_inventory')
  assert.deepEqual(up.rows.map(x => x.date), ['2026-09-25'], 'seule la nuit dans la fenetre est ecrite')
  assert.equal(up.rows[0].rate, 150, 'centimes -> euros, dans la langue du writer')
  assert.equal(etat.journal[0].source, 'engine')
})

test('LE TEST QUI COMPTE : le canal ne ROUVRE pas une nuit fermee (d ici le 4.6.2)', async () => {
  const sb = fausseBase([ligne('2026-09-25', { stop_sell: true, avail: 0 })])
  const r = await demanderAuCalendrier(sb, BIEN, { aujourdHui: AUJ, nuits: [
    { date: '2026-09-25', ouvrir: true, prix_centimes: 15000 }
  ] }, { appel: fauxAppel() })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ignorees.deja_fermees, ['2026-09-25'])
  // Le PRIX passe (il attend, pret) ; l'OUVERTURE ne passe pas.
  const up = sb.ecritures.find(e => e.table === 'calendar_inventory')
  assert.equal(up.rows.length, 1)
  assert.equal(up.rows[0].rate, 150)
  assert.equal(up.rows[0].stop_sell, true, 'la fermeture est intacte')
  assert.equal(up.rows[0].avail, 0)
})

test('une demande vide ou invalide est refusee sans exception', async () => {
  const sb = fausseBase([])
  assert.equal((await demanderAuCalendrier(sb, BIEN, { nuits: [] })).refus, REFUS.DEMANDE_VIDE)
  assert.equal((await demanderAuCalendrier(sb, BIEN, null)).refus, REFUS.DEMANDE_VIDE)
  const r = await demanderAuCalendrier(sb, BIEN, { aujourdHui: AUJ, nuits: [
    { date: 'hier', prix_centimes: 100 }, { date: '2026-09-25', prix_centimes: -5 }
  ] }, { appel: fauxAppel() })
  assert.equal(r.ok, true)
  assert.equal(r.ecrit, null, 'rien a ecrire')
  assert.equal(r.ignorees.invalides.length, 2)
  assert.equal(sb.ecritures.length, 0)
})

test('le refus du writer remonte par le canal dans les mots de l hote', async () => {
  const r = await demanderAuCalendrier(fausseBase([]), BIEN, { aujourdHui: AUJ, nuits: [
    { date: '2026-09-25', prix_centimes: 500 }   // 5 EUR, sous le plancher de 30
  ] }, { appel: fauxAppel() })
  assert.equal(r.ok, false)
  assert.equal(r.refus, 'prix_sous_plancher')
  assert.ok(/NON enregistr/i.test(r.message), 'le message du plancher, pas un code')
})

// ─── 4. Le recensement du journal connait le nouveau writer ─────────────────
test('le writer est recense comme emetteur TARIFAIRE, et la porte HTTP ne l est plus', () => {
  const t = lire('tests/price-log.test.js')
  assert.ok(/'lib\/calendrier-writer\.js':\s*'tarifaire'/.test(t), 'le writer journalise ses poussees')
  assert.ok(!/'api\/calendar\.js':\s*'tarifaire'/.test(t), 'la porte ne POSTe plus /restrictions elle-meme')
})
