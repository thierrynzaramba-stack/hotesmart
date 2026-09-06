// tests/reservation-directe.test.js
// Verrou anti-surreservation (spec-reservation-manuelle.md §4, amendement capacite).

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://exemple.invalid/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'k'

const {
  nuits, occupationParNuit, nuitsIndisponibles, verifierDisponibilite
} = require('../lib/reservation-directe')

const snap = (id, arrival, departure, status = 'confirmed') =>
  ({ booking_id: id, snapshot: { provider: 'channex', status, arrival, departure } })

// ─── Les nuits d'un sejour ──────────────────────────────────────────────────

test('nuits : un sejour 12->15 occupe 12, 13, 14 — jamais la nuit de depart', () => {
  assert.deepStrictEqual(nuits('2026-10-12', '2026-10-15'), ['2026-10-12', '2026-10-13', '2026-10-14'])
  // C'est ce qui permet a l'arrivee suivante de commencer le 15 sans conflit.
  assert.deepStrictEqual(nuits('2026-10-12', '2026-10-13'), ['2026-10-12'])
  assert.deepStrictEqual(nuits('2026-10-12', '2026-10-12'), [], 'sejour de zero nuit')
  assert.deepStrictEqual(nuits(null, '2026-10-15'), [])
  assert.deepStrictEqual(nuits('pas-une-date', '2026-10-15'), [])
})

test('nuits : traverse un changement de mois et une annee bissextile', () => {
  assert.deepStrictEqual(nuits('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01'])
  assert.deepStrictEqual(nuits('2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29'])
})

// ─── Occupation ─────────────────────────────────────────────────────────────

test('occupation : seules les reservations CONFIRMED comptent', () => {
  const o = occupationParNuit([
    snap('a', '2026-10-12', '2026-10-14'),
    snap('b', '2026-10-12', '2026-10-13', 'cancelled'),
    snap('c', '2026-10-12', '2026-10-13', 'blocked')
  ])
  assert.strictEqual(o['2026-10-12'], 1, 'annulee et blocage ne comptent pas')
  assert.strictEqual(o['2026-10-13'], 1)
})

test('occupation : `exclure` evite qu\'une modification se voie elle-meme', () => {
  const lignes = [snap('a', '2026-10-12', '2026-10-15')]
  assert.strictEqual(occupationParNuit(lignes)['2026-10-12'], 1)
  assert.strictEqual(occupationParNuit(lignes, { exclure: 'a' })['2026-10-12'], undefined)
})

// ─── La regle de capacite ───────────────────────────────────────────────────

test('CAPACITE : a 1 unite, comportement identique a la regle d\'origine', () => {
  const occ = { '2026-10-12': 1, '2026-10-13': 0 }
  assert.deepStrictEqual(nuitsIndisponibles(occ, ['2026-10-12', '2026-10-13'], 1), ['2026-10-12'])
})

test('CAPACITE : a 3 unites, on refuse quand il ne reste plus d\'unite', () => {
  // Le point de l'amendement : « il existe deja une resa » n'est PAS un refus.
  const occ = { '2026-10-12': 2, '2026-10-13': 3, '2026-10-14': 4 }
  const r = nuitsIndisponibles(occ, ['2026-10-12', '2026-10-13', '2026-10-14'], 3)
  assert.deepStrictEqual(r, ['2026-10-13', '2026-10-14'], '2/3 laisse une unite libre')
})

test('CAPACITE : une valeur absente ou aberrante retombe sur 1, jamais sur 0', () => {
  // Un defaut a 0 rendrait TOUTES les nuits indisponibles ; un defaut trop grand
  // ouvrirait le verrou. 1 est le seul repli sur.
  for (const u of [undefined, null, 0, -3, 'abc']) {
    assert.deepStrictEqual(nuitsIndisponibles({ '2026-10-12': 1 }, ['2026-10-12'], u), ['2026-10-12'])
  }
})

// ─── Verification bout en bout ──────────────────────────────────────────────

// `intentions` : cles de write_locks encore valides (nuits vendues par nous et
// pas encore remontees par le feed).
function fakeSupabase ({ unites = 1, lignes = [], erreurSnap = null, bien = true,
                         intentions = [], provider = 'channex' } = {}) {
  return {
    from (table) {
      const estVerrou = table === 'write_locks'
      const q = {
        select () { return q }, eq () { return q }, gte () { return q }, lte () { return q },
        in () { return q }, gt () { return q },
        maybeSingle: async () => ({ data: bien ? { inventory_units: unites, name: 'Bien', provider } : null, error: null }),
        then (res, rej) {
          if (estVerrou) return Promise.resolve({ data: intentions.map(k => ({ key: k })), error: null }).then(res, rej)
          if (erreurSnap) return Promise.resolve({ data: null, error: { message: erreurSnap } }).then(res, rej)
          return Promise.resolve({ data: lignes, error: null }).then(res, rej)
        }
      }
      return q
    }
  }
}

test('verif : nuit libre -> ok', async () => {
  const r = await verifierDisponibilite(fakeSupabase({ lignes: [] }),
    { userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-15' })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.conflits, [])
})

test('verif : nuit occupee a 1 unite -> refus, avec les nuits en cause', async () => {
  const r = await verifierDisponibilite(fakeSupabase({ lignes: [snap('a', '2026-10-13', '2026-10-14')] }),
    { userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-15' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.raison, 'nuits_completes')
  assert.deepStrictEqual(r.conflits, ['2026-10-13'])
})

test('verif : DEUX unites, une seule occupee -> accepte', async () => {
  const r = await verifierDisponibilite(
    fakeSupabase({ unites: 2, lignes: [snap('a', '2026-10-13', '2026-10-14')] }),
    { userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-15' })
  assert.strictEqual(r.ok, true, 'il reste une unite ce soir-la')
  assert.strictEqual(r.unites, 2)
})

test('verif : un depart le jour de l\'arrivee suivante NE bloque PAS', async () => {
  // Le cas le plus frequent en exploitation : rotation le meme jour.
  const r = await verifierDisponibilite(fakeSupabase({ lignes: [snap('a', '2026-10-10', '2026-10-12')] }),
    { userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-14' })
  assert.strictEqual(r.ok, true)
})

test('verif : une erreur de lecture REMONTE, elle ne passe jamais pour « libre »', async () => {
  // Un verrou qui s'ouvre parce que la base n'a pas repondu ne protege rien.
  await assert.rejects(
    () => verifierDisponibilite(fakeSupabase({ erreurSnap: 'boom' }),
      { userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-15' }),
    /bookings_snapshot/)
})

test('verif : bien inconnu -> refus, pas une autorisation par defaut', async () => {
  const r = await verifierDisponibilite(fakeSupabase({ bien: false }),
    { userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-15' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.raison, 'bien_inconnu')
})

test('verif : dates invalides -> refus', async () => {
  const r = await verifierDisponibilite(fakeSupabase({}),
    { userId: 'u', propertyId: 'p', arrival: '2026-10-15', departure: '2026-10-12' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.raison, 'dates_invalides')
})

// ─── Verrou : proprietaire et erreurs ───────────────────────────────────────

test('VERROU : on ne libere QUE son propre verrou', async () => {
  // Si la sequence depasse le TTL, un autre processus prend le verrou. Le
  // `finally` du premier ne doit pas supprimer celui du second — sinon
  // l'exclusion mutuelle tombe precisement dans le cas lent qui la justifie.
  const { poserVerrou, libererVerrou } = require('../lib/reservation-directe')
  const filtres = []
  const sb = {
    from () {
      const q = {
        _f: {},
        delete () { q._del = true; return q },
        eq (col, val) { q._f[col] = val; return q },
        lt () { return q },
        insert: async () => ({ error: null }),
        then (res) { if (q._del) filtres.push({ ...q._f }); return Promise.resolve({ error: null }).then(res) }
      }
      return q
    }
  }
  const v = await poserVerrou(sb, { userId: 'u', propertyId: 'p' })
  assert.ok(v.jeton, 'un jeton est pose')
  await libererVerrou(sb, v.cle, v.jeton)
  const suppression = filtres[filtres.length - 1]
  assert.strictEqual(suppression.key, v.cle)
  assert.strictEqual(suppression.token, v.jeton, 'la suppression cible le jeton')
})

test('VERROU : « occupé » n\'est dit que sur une VRAIE collision (23505)', async () => {
  // Tant que la migration n'est pas appliquee, `write_locks` n'existe pas : toute
  // reservation etait refusee par « une autre saisie est en cours », indefiniment
  // et sans rapport avec la realite.
  const { poserVerrou } = require('../lib/reservation-directe')
  const avec = (err) => ({
    from: () => ({
      delete () { return this }, eq () { return this }, lt () { return this },
      insert: async () => ({ error: err }),
      then: (r) => Promise.resolve({ error: null }).then(r)
    })
  })
  const vraiConflit = await poserVerrou(avec({ code: '23505', message: 'duplicate key' }), { userId: 'u', propertyId: 'p' })
  assert.strictEqual(vraiConflit.raison, 'occupe')

  const vraiErr = console.error; console.error = () => {}
  try {
    const tableAbsente = await poserVerrou(avec({ code: '42P01', message: 'relation "write_locks" does not exist' }), { userId: 'u', propertyId: 'p' })
    assert.strictEqual(tableAbsente.raison, 'verrou_indisponible', 'pas « occupe » : ce n\'est pas une collision')
  } finally { console.error = vraiErr }
})

test('verif : le provider du bien est rendu, pour router l\'ecriture', async () => {
  // Le module ne doit jamais cabler « channex » en dur : sur un bien Beds24, il
  // posterait chez Channex une reservation portant un propId Beds24.
  const sb = {
    from () {
      const q = {
        select () { return q }, eq () { return q }, gte () { return q }, lte () { return q },
        in () { return q }, gt () { return q },
        maybeSingle: async () => ({ data: { inventory_units: 1, name: 'B', provider: 'beds24' }, error: null }),
        then: (r) => Promise.resolve({ data: [], error: null }).then(r)
      }
      return q
    }
  }
  const r = await verifierDisponibilite(sb, { userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-14' })
  assert.strictEqual(r.provider, 'beds24')
})

test('INTENTION : une nuit vendue mais pas encore remontee par le feed compte comme occupee', async () => {
  // ⚠ REGRESSION ATTRAPEE EN REVIEW. Le verrou ne couvrait que verification ->
  // envoi ; le cœur n'apprend la reservation qu'au retour du feed. L'hote saisit
  // A, lit « envoyee », saisit B trente secondes plus tard : la verification de B
  // ne voyait pas A, Channex n'oppose aucune defense, et la surreservation etait
  // creee PAR NOTRE PROPRE CHEMIN.
  const sb = fakeSupabase({ lignes: [], intentions: ['resa-nuit:u:p:2026-10-13'] })
  const r = await verifierDisponibilite(sb,
    { userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-15' })
  assert.strictEqual(r.ok, false, 'la nuit vendue est occupee, meme absente du coeur')
  assert.deepStrictEqual(r.conflits, ['2026-10-13'])
})

test('INTENTION : une lecture des intentions en echec REMONTE', async () => {
  const sb = {
    from (table) {
      const q = {
        select () { return q }, eq () { return q }, gte () { return q }, lte () { return q },
        in () { return q }, gt () { return q },
        maybeSingle: async () => ({ data: { inventory_units: 1, name: 'B', provider: 'channex' }, error: null }),
        then: (r) => Promise.resolve(table === 'write_locks'
          ? { data: null, error: { message: 'boom' } }
          : { data: [], error: null }).then(r)
      }
      return q
    }
  }
  await assert.rejects(() => verifierDisponibilite(sb,
    { userId: 'u', propertyId: 'p', arrival: '2026-10-12', departure: '2026-10-15' }), /write_locks/)
})
