// tests/rate-plans-derives.test.js
// LE TROU : un bien neuf naissait INCONNECTABLE a Booking.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

// Un faux client Supabase minimal : `.from().select().eq().eq().eq().maybeSingle()`
// et `.from().upsert()`. Il enregistre ce qui lui est demande.
function faussSupabase ({ existant = null, erreurLecture = null, erreurUpsert = null } = {}) {
  const journal = { upserts: [], filtres: [] }
  const chaine = {
    select () { return chaine },
    eq (col, val) { journal.filtres.push([col, val]); return chaine },
    maybeSingle () { return Promise.resolve({ data: existant, error: erreurLecture }) },
    upsert (rows, opts) { journal.upserts.push({ rows, opts }); return Promise.resolve({ error: erreurUpsert }) }
  }
  return { from () { return chaine }, journal }
}

const BIEN = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  name: 'Test',
  currency: 'EUR',
  capacity: 2,
  provider: 'channex',
  provider_property_id: 'bbbbbbbb-0000-0000-0000-000000000002',
  provider_rate_plan_id: 'base-rp',
  provider_room_type_id: 'rt-1'
}

function fauxAppel (reponses) {
  const vus = []
  return {
    vus,
    appel: async (methode, chemin, corps) => {
      vus.push({ methode, chemin, corps })
      const cle = `${methode} ${chemin}`
      const r = reponses[cle] || reponses[methode] || { ok: true, json: {} }
      return typeof r === 'function' ? r(corps) : r
    }
  }
}

test('LE TEST QUI COMPTE : le provisionnement pose les derives, sinon le bien est inconnectable', () => {
  // Mesure du 10 septembre 2026 : `api/channel-property.js` s'arretait au
  // « Tarif Standard ». Aucune ligne dans `property_channel_rate_plans`, aucun
  // derive. Or le mapping Booking doit pointer le tarif DERIVE du canal, jamais
  // la base — `action=map` de api/channel-bcom-write.js refuse desormais en son
  // absence. Un bien neuf etait donc litteralement inconnectable a Booking, et
  // ca touchait TOUT nouvel hote : Colomiers ne l'avait pas revele parce que
  // ses derives avaient ete crees a la main.
  const src = lire('api/channel-property.js')
  assert.ok(src.includes("require('../lib/rate-plans-derives')"), 'le module est importe')
  assert.ok(src.includes('await poserDerivesParDefaut(supabase, channelCall, insertData)'),
    'et appele avec la fiche INSEREE (c est elle qui porte l id et les ids provider)')
  // ⚠ APRES l'INSERT : avant, `insertData` n'existe pas et le bien n'a pas d'id.
  // ⚠ On compare a l'APPEL, pas au `require` : celui-ci est en tete de
  // fichier, donc avant l'INSERT, et la comparaison serait toujours fausse.
  assert.ok(src.indexOf('.insert({') < src.indexOf('await poserDerivesParDefaut('),
    'apres l INSERT Supabase')
  // L'echec doit etre RENDU : c'est le silence qui avait laisse le trou ouvert.
  assert.ok(src.includes('derives\n      })') || /derives\s*\n\s*\}\)/.test(src),
    'le resultat est rendu a l appelant')
})

test('LE TEST QUI COMPTE : une seule logique, l endpoint manuel consomme le module', () => {
  // La dupliquer aurait garanti la divergence des deux chemins.
  const ep = lire('api/channel-rateplan.js')
  assert.ok(ep.includes("require('../lib/rate-plans-derives')"), 'importe')
  assert.ok(ep.includes('await creerDerive(supabase, channelCall, prop, channel)'), 'appele')
  // La creation du rate plan enfant ne doit plus etre ecrite dans l'endpoint.
  const bloc = ep.slice(ep.indexOf("if (action === 'create_derived')"),
    ep.indexOf("if (action === 'inspect')"))
  assert.ok(!bloc.includes("rate_mode: 'derived'"),
    'la construction du payload enfant a bien quitte l endpoint')
})

test('creerDerive : idempotent — un derive existant ne declenche aucun appel provider', async () => {
  const { creerDerive } = require('../lib/rate-plans-derives')
  const sb = faussSupabase({ existant: { id: 'x', provider_rate_plan_id: 'deja-la' } })
  const { vus, appel } = fauxAppel({})
  const r = await creerDerive(sb, appel, BIEN, 'booking')
  assert.equal(r.ok, true)
  assert.equal(r.deja, true)
  assert.equal(r.derivedRatePlanId, 'deja-la')
  assert.equal(vus.length, 0, 'aucun appel Channex : le provisionnement est rejouable')
  assert.equal(sb.journal.upserts.length, 0, 'et aucune ecriture')
  // ⚠ `role=derived` DOIT etre dans le filtre : sans lui la ligne sentinelle
  // `channel='base'` passerait pour un derive.
  assert.ok(sb.journal.filtres.some(([c, v]) => c === 'role' && v === 'derived'))
})

test('creerDerive : la base prend une ligne sentinelle, le canal son derive', async () => {
  const { creerDerive } = require('../lib/rate-plans-derives')
  const sb = faussSupabase({ existant: null })
  const { vus, appel } = fauxAppel({
    'GET /rate_plans/base-rp': { ok: true, json: { data: { attributes: {
      sell_mode: 'per_person', options: [{ occupancy: 2, is_primary: true }] } } } },
    'POST /rate_plans': { ok: true, json: { data: { id: 'enfant-1' } } }
  })
  const r = await creerDerive(sb, appel, BIEN, 'booking')
  assert.equal(r.ok, true)
  assert.equal(r.derivedRatePlanId, 'enfant-1')

  // ⚠ LE SELL_MODE EST CLONE DU BASE. Un derive « par personne » sous un base
  // « par chambre » enverrait des prix qui ne veulent rien dire.
  assert.equal(r.sellMode, 'per_person')
  const cree = vus.find(v => v.methode === 'POST').corps.rate_plan
  assert.equal(cree.sell_mode, 'per_person')
  assert.equal(cree.rate_mode, 'derived')
  assert.equal(cree.parent_rate_plan_id, 'base-rp')
  // Neutre : +0 %, min stay herite. Il ne change rien avant la regle de l'hote.
  assert.deepEqual(cree.options[0].derived_option, { rate: [['increase_by_percent', '0']] })
  assert.equal(cree.inherit_min_stay_arrival, true)

  const rows = sb.journal.upserts[0].rows
  assert.equal(sb.journal.upserts[0].opts.onConflict, 'property_id,channel')
  const base = rows.find(x => x.channel === 'base')
  const der = rows.find(x => x.channel === 'booking')
  assert.equal(base.role, 'base')
  assert.equal(base.provider_rate_plan_id, 'base-rp')
  assert.equal(der.role, 'derived')
  assert.equal(der.provider_rate_plan_id, 'enfant-1')
  assert.equal(der.derive_value, 0, 'la regle de l hote reste a poser')
})

test('creerDerive : un bien sans base rate plan est refuse AVANT tout appel', async () => {
  const { creerDerive } = require('../lib/rate-plans-derives')
  const sb = faussSupabase({})
  const { vus, appel } = fauxAppel({})
  for (const manque of ['provider_rate_plan_id', 'provider_room_type_id']) {
    const bien = { ...BIEN, [manque]: null }
    const r = await creerDerive(sb, appel, bien, 'booking')
    assert.equal(r.ok, false)
    assert.equal(r.raison, 'provisionnement_incomplet')
  }
  assert.equal(vus.length, 0, 'aucun appel provider sur un bien incomplet')
})

test('creerDerive : liaison DB en echec -> l id de l enfant est RENDU', async () => {
  // ⚠ SANS CET ID, UN SECOND PASSAGE CREERAIT UN DEUXIEME ENFANT.
  // Le mapping n'aurait alors plus de cible unique : `choisirTarifDerive`
  // (api/channel-bcom-write.js) refuse en 409 sur doublon. L'echec de liaison
  // doit donc rendre l'enfant deja cree cote provider, pas un echec sec.
  const { creerDerive } = require('../lib/rate-plans-derives')
  const sb = faussSupabase({ existant: null, erreurUpsert: { message: 'boum' } })
  const { appel } = fauxAppel({
    'GET /rate_plans/base-rp': { ok: true, json: { data: { attributes: { sell_mode: 'per_room', options: [] } } } },
    'POST /rate_plans': { ok: true, json: { data: { id: 'orphelin-1' } } }
  })
  const r = await creerDerive(sb, appel, BIEN, 'booking')
  assert.equal(r.ok, false)
  assert.equal(r.raison, 'liaison_db')
  assert.equal(r.derivedRatePlanId, 'orphelin-1', 'l enfant cree est nomme')
})

test('poserDerivesParDefaut : booking ET airbnb, et un echec n arrete pas l autre', async () => {
  const { poserDerivesParDefaut, CANAUX_PAR_DEFAUT } = require('../lib/rate-plans-derives')
  assert.deepEqual(CANAUX_PAR_DEFAUT, ['booking', 'airbnb'])

  const sb = faussSupabase({ existant: null })
  let n = 0
  const appel = async (methode, chemin) => {
    if (methode === 'GET') {
      return { ok: true, json: { data: { attributes: { sell_mode: 'per_room', options: [] } } } }
    }
    n++
    // Le premier POST echoue, le second reussit : l'un ne doit pas emporter l'autre.
    return n === 1
      ? { ok: false, status: 502, json: { errors: 'non' } }
      : { ok: true, json: { data: { id: 'enfant-' + n } } }
  }
  const r = await poserDerivesParDefaut(sb, appel, BIEN)
  assert.equal(Object.keys(r).length, 2)
  assert.equal(r.booking.ok, false)
  assert.equal(r.airbnb.ok, true, 'airbnb est pose malgre l echec de booking')
})

test('poserDerivesParDefaut : une exception est capturee, jamais propagee', async () => {
  // ⚠ NON BLOQUANT COMME LES INSTALLATIONS D'APPLICATIONS. Une exception qui
  // remonte ferait echouer la CREATION DU BIEN, et le rollback supprimerait la
  // propriete chez le provider — pour un derive manquant, qui se rattrape.
  const { poserDerivesParDefaut } = require('../lib/rate-plans-derives')
  const sb = faussSupabase({ existant: null })
  const appel = async () => { throw new Error('reseau coupe') }
  const r = await poserDerivesParDefaut(sb, appel, BIEN)
  assert.equal(r.booking.ok, false)
  assert.equal(r.booking.raison, 'exception')
  assert.equal(r.airbnb.raison, 'exception')
})
