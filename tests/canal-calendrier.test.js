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
// ⚠ DES UUID, comme en base : `fermeturesDuBien` refuse tout autre
// identifiant (un non-UUID sur une colonne uuid est une ERREUR Postgres, pas un
// resultat vide), et le faux client doit imposer ce que la vraie base impose.
const ID_BIEN = 'b1b1b1b1-0000-4000-8000-000000000001'
const COMPTE = 'a1a1a1a1-0000-4000-8000-000000000001'
const BIEN = {
  id: ID_BIEN, user_id: COMPTE, name: 'Loft', provider: 'channex',
  provider_property_id: 'P1', provider_room_type_id: 'RT1', provider_rate_plan_id: 'RP1',
  rate_sync_mode: 'managed', pilote_tarifaire: 'yieldflow',
  pilote_fenetre_type: 'jours', pilote_fenetre_valeur: 10,
  base_price: 100, prix_minimum: 3000, capacity: 2, included_guests: 2, extra_guest_fee: 0,
  inventory_units: 1
}
const CALENDRIER = { ...BIEN, pilote_tarifaire: 'calendrier' }

// Faux client : `calendar_inventory` en lecture (lignes fournies) et en
// ecriture (enregistree). Tout le reste rend vide.
function fausseBase (lignes = [], { fermetures = [] } = {}) {
  const ecritures = []
  const client = {
    ecritures,
    from (table) {
      const q = { _f: {}, _in: null, _lte: null, _gte: null }
      q.select = () => q
      q.eq = (c, v) => { q._f[c] = v; return q }
      q.in = (c, v) => { q._in = [c, v]; return q }
      q.gte = (c, v) => { q._gte = [c, v]; return q }; q.lte = (c, v) => { q._lte = [c, v]; return q }
      q.order = () => q; q.limit = () => q
      q.maybeSingle = async () => ({ data: null, error: null })
      q.then = (res) => {
        // Les fermetures de l'hote : croisement de periode, comme la vraie table.
        if (table === 'fermetures') {
          const out = fermetures.filter(f => (!q._lte || f[q._lte[0]] <= q._lte[1]) && (!q._gte || f[q._gte[0]] >= q._gte[1]))
          return Promise.resolve({ data: out, error: null }).then(res)
        }
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
  // ⚠ LA GARDE VISE LES HANDLERS DE L'HOTE, PAS LE DOSSIER — relevee en
  // review. `api/cron.js` est sous api/ mais n'est pas une porte de l'hote :
  // il est garde par CRON_SECRET, et c'est LUI qui appellera le canal au
  // 4.6.3. L'interdire ici aurait force un module intermediaire pour
  // contourner le motif. Ce qui est interdit : qu'un handler lise l'ORIGINE
  // dans la requete, et qu'un handler autre que la porte du calendrier
  // appelle le writer.
  const PEUT_APPELER_LE_CANAL = new Set(['cron.js'])
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'api'))) {
    if (!f.endsWith('.js')) continue
    const src = lire(`api/${f}`)
    if (/canal-calendrier/.test(src)) {
      assert.ok(PEUT_APPELER_LE_CANAL.has(f), `${f} n a pas a connaitre le canal interne`)
    }
    if (/calendrier-writer/.test(src)) {
      assert.equal(f, 'calendar.js', `${f} : seule la porte HTTP du calendrier appelle le writer`)
      assert.ok(/origine: 'host'/.test(src), 'et elle dit qui elle est')
    }
    assert.ok(!/origine:\s*\(?\s*(req|body|query)\b/.test(src), `${f} : l origine ne vient JAMAIS de la requete`)
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
    supabase: sb, bien: BIEN, compte: COMPTE, origine: 'engine', appel,
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
    supabase: sb, bien: BIEN, compte: COMPTE, origine: 'engine', appel: fauxAppel(),
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

// ─── 5. Ce que la review a trouve ───────────────────────────────────────────
test('LE TEST QUI COMPTE : la relecture du canal est PAGINEE — une nuit fermee au-dela de 1000 ne se rouvre pas', async () => {
  // PostgREST tronque a 1000 lignes SANS erreur. Une demande de 1200 nuits dont
  // la 1100e est fermee : sans pagination, elle n'entrait pas dans `fermees`
  // et `ouvrir` la rouvrait — la regle exacte que ce canal existe pour tenir.
  const jours = []
  const d = new Date('2026-09-21T00:00:00Z')
  for (let i = 0; i < 1200; i++) { jours.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1) }
  const fermeeLoin = jours[1100]
  const bien = { ...BIEN, pilote_fenetre_type: 'jours', pilote_fenetre_valeur: 1300 }
  const sb = fausseBase([ligne(fermeeLoin, { stop_sell: true, avail: 0 })])
  // Le faux client note la taille de chaque `.in()` : la vraie base refuse
  // au-dela, ce faux ne doit pas etre plus tolerant qu'elle.
  const tailles = []
  const from = sb.from.bind(sb)
  sb.from = (t) => { const q = from(t); const inn = q.in; q.in = (c, v) => { if (c === 'date') tailles.push(v.length); return inn(c, v) }; return q }
  const r = await demanderAuCalendrier(sb, bien, { aujourdHui: AUJ,
    nuits: jours.map(j => ({ date: j, ouvrir: true })) }, { appel: fauxAppel() })
  assert.equal(r.ok, true)
  assert.ok(tailles.length >= 3, `relecture paginee : ${tailles.length} page(s)`)
  assert.ok(tailles.every(n => n <= 500), `aucune page de plus de 500 : ${Math.max(...tailles)}`)
  assert.deepEqual(r.ignorees.deja_fermees, [fermeeLoin], 'la nuit fermee loin dans la liste est vue, donc pas rouverte')
})

test('sans client canal, un bien RELIE au canal est refuse AVANT toute ecriture', async () => {
  // Sinon : upsert en base, puis « appel is not a function » dans le try du
  // writer — le cœur porte des prix jamais partis, et un incident fondateur
  // part par bien traite.
  const sb = fausseBase([])
  const r = await demanderAuCalendrier(sb, BIEN, { aujourdHui: AUJ, nuits: [{ date: '2026-09-25', prix_centimes: 15000 }] })
  assert.equal(r.ok, false)
  assert.equal(r.refus, REFUS.DEMANDE_INVALIDE)
  assert.ok(/appel/.test(r.message))
  assert.equal(sb.ecritures.length, 0, 'RIEN n est ecrit')
})

test('un bien charge SANS user_id est refuse : le writer ecrirait sous un compte vide', async () => {
  // Le defaut du 12 septembre : `compte = undefined` traverse tout le writer,
  // le journal n'est pas ecrit (perte definitive), l'alerte part sans compte.
  const { user_id, ...sansCompte } = BIEN
  const sb = fausseBase([])
  const r = await demanderAuCalendrier(sb, sansCompte, { aujourdHui: AUJ, nuits: [{ date: '2026-09-25', prix_centimes: 15000 }] }, { appel: fauxAppel() })
  assert.equal(r.refus, REFUS.DEMANDE_INVALIDE)
  assert.ok(/user_id/.test(r.message))
  assert.equal(sb.ecritures.length, 0)
})

test('une nuit PASSEE est ignoree et comptee, pas poussee', async () => {
  // Une nuit d'hier poussee : Channex la refuse, le verdict crie « panne », un
  // incident part pour une nuit qui ne peut plus se vendre.
  const sb = fausseBase([])
  const r = await demanderAuCalendrier(sb, BIEN, { aujourdHui: AUJ, nuits: [
    { date: '2026-09-19', ouvrir: true, prix_centimes: 15000 },
    { date: '2026-09-25', ouvrir: true, prix_centimes: 15000 }
  ] }, { appel: fauxAppel() })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ignorees.passees, ['2026-09-19'])
  const up = sb.ecritures.find(e => e.table === 'calendar_inventory')
  assert.deepEqual(up.rows.map(x => x.date), ['2026-09-25'])
})

test('ouvrir suit le stock du bien, pas un « 1 » en dur', async () => {
  const sb = fausseBase([])
  await demanderAuCalendrier(sb, { ...BIEN, inventory_units: 3 }, { aujourdHui: AUJ,
    nuits: [{ date: '2026-09-25', ouvrir: true }] }, { appel: fauxAppel() })
  const up = sb.ecritures.find(e => e.table === 'calendar_inventory')
  assert.equal(up.rows[0].avail, 3, 'les trois unites : le plafond du writer ne peut que retirer, jamais ajouter')
})

test('un prix invalide n annule PAS l ouverture de la meme nuit', async () => {
  const sb = fausseBase([])
  const r = await demanderAuCalendrier(sb, BIEN, { aujourdHui: AUJ,
    nuits: [{ date: '2026-09-25', ouvrir: true, prix_centimes: 0 }] }, { appel: fauxAppel() })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ignorees.invalides, ['2026-09-25'], 'le prix est compte invalide')
  const up = sb.ecritures.find(e => e.table === 'calendar_inventory')
  assert.ok(up, 'mais l ouverture, valide et independante, est ecrite')
  assert.equal(up.rows[0].stop_sell, false)
  assert.equal(up.rows[0].rate, undefined, 'sans le prix')
})

// ─── 6. Les fermetures de l'hote (lot 4.6.2) ────────────────────────────────
test('LE TEST QUI COMPTE : Yield ne touche JAMAIS une fermeture de l hote — ni ouverture, ni prix', async () => {
  const fermeture = { id: 'f1', property_id: BIEN.id, date_debut: '2026-09-24', date_fin: '2026-09-26', raison: 'travaux' }
  const sb = fausseBase([], { fermetures: [fermeture] })
  etat.journal = []
  const r = await demanderAuCalendrier(sb, BIEN, { aujourdHui: AUJ, nuits: [
    { date: '2026-09-23', ouvrir: true, prix_centimes: 15000 },
    { date: '2026-09-25', ouvrir: true, prix_centimes: 15000 },   // dans la fermeture
    { date: '2026-09-27', ouvrir: true, prix_centimes: 15000 }
  ] }, { appel: fauxAppel() })
  assert.equal(r.ok, true)
  assert.deepEqual(r.ignorees.fermees_par_l_hote, ['2026-09-25'], 'comptee a part, nommee')
  const up = sb.ecritures.find(e => e.table === 'calendar_inventory')
  assert.deepEqual(up.rows.map(x => x.date), ['2026-09-23', '2026-09-27'], 'RIEN n est ecrit sur la nuit fermee — pas meme un prix')
})

test('une fermeture illisible REFUSE la demande — un vide par erreur ferait ouvrir dedans', async () => {
  const sb = fausseBase([])
  const from = sb.from.bind(sb)
  sb.from = (t) => { if (t === 'fermetures') { const q = from(t); q.then = (res) => Promise.resolve({ data: null, error: { message: 'timeout' } }).then(res); return q } return from(t) }
  const r = await demanderAuCalendrier(sb, BIEN, { aujourdHui: AUJ, nuits: [{ date: '2026-09-25', ouvrir: true }] }, { appel: fauxAppel() })
  assert.equal(r.ok, false)
  assert.equal(r.refus, REFUS.DEMANDE_INVALIDE)
  assert.match(r.message, /fermetures/)
  assert.equal(sb.ecritures.length, 0)
})

test('fermee par l hote et fermee « calculee » sont deux comptes distincts', async () => {
  // Le cron doit savoir lequel il regarde : l'un est une frontiere (jamais
  // touchee), l'autre attend la regle du moteur d'ouverture (4.6.3).
  const fermeture = { id: 'f1', property_id: BIEN.id, date_debut: '2026-09-25', date_fin: '2026-09-25', raison: 'perso' }
  const sb = fausseBase([ligne('2026-09-24', { stop_sell: true, avail: 0 })], { fermetures: [fermeture] })
  const r = await demanderAuCalendrier(sb, BIEN, { aujourdHui: AUJ, nuits: [
    { date: '2026-09-24', ouvrir: true }, { date: '2026-09-25', ouvrir: true }
  ] }, { appel: fauxAppel() })
  assert.deepEqual(r.ignorees.deja_fermees, ['2026-09-24'])
  assert.deepEqual(r.ignorees.fermees_par_l_hote, ['2026-09-25'])
})
