// tests/api-yield.test.js
// LE DEFAUT QU'ILS EMPECHENT : un ecran de yield qui affiche des chiffres FAUX
// et credibles. Constate a la premiere lecture reelle de cet endpoint —
// `resoudreBien` ne rend que six colonnes, donc `zone_scolaire` valait
// `undefined`, donc AUCUN jour ne tombait dans « vacances de la zone du bien »
// et tout partait en « vacances d'une autre zone » : une reference de 143 EUR
// sur un segment dont la mesure dit qu'il ne porte aucun signal. C'est le
// defaut du 11 septembre 2026 (`user_id` absent du SELECT), a l'identique.
//
// Spec : docs/specs/spec-yieldflow-v1.md §6 et §7 (etape 4, lot 4.1)

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = 'compte-prod', AUTRE = 'compte-autre', MEMBRE = 'membre'

// Un bien COMPLET : toutes les colonnes dont le moteur depend.
const BIEN = {
  id: '091d9abf-ff86-45ce-8123-3425e6f3900f', user_id: PROD, name: 'La bulle',
  provider: 'channex', provider_property_id: '0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4',
  provider_room_type_id: 'rt', provider_rate_plan_id: 'rp',
  base_price: 95, capacity: 2, zone_scolaire: 'C', prix_minimum: 9500,
  rate_sync_mode: 'managed', inventory_units: 1
}
const BIEN_TIERS = { ...BIEN, id: '9f3c0000-3333-4444-9999-bbbbbbbbbbbb',
  user_id: AUTRE, name: 'Chez un autre', provider_property_id: '999999' }
const BIENS = [BIEN, BIEN_TIERS]

const MODULES = ['../lib/require-permission', '../lib/permissions', '../api/yield']

function preparer ({ user = PROD, profil = null, permissions = null,
  colonnesBien = null, snapshots = [], inventaire = [], vacances = [],
  exceptions = [] } = {}) {
  const etat = { ecritures: [], lectures: [], pages: 0 }
  const fiche = colonnesBien
    ? Object.fromEntries(Object.entries(BIEN).filter(([k]) => colonnesBien.includes(k)))
    : BIEN

  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
      : { data: null, error: { message: 'x' } }) },
    from (nom) {
      const q = {
        _f: {}, _or: null, _gte: null, _lte: null,
        select () { return q },
        eq (c, v) { q._f[c] = v; return q },
        or (e) { q._or = e; return q },
        in () { return q }, neq () { return q }, not () { return q }, is () { return q },
        order () { return q }, limit () { return q },
        gte (c, v) { q._gte = { c, v }; return q },
        lte (c, v) { q._lte = { c, v }; return q },
        // ⚠ UNE PAGINATION QUI PAGINE VRAIMENT — releve en review. Rendre tout
        // a `from = 0` puis `[]` n'exercait jamais la condition de sortie
        // `data.length < 1000` du lecteur.
        range (a, b) {
          etat.pages++
          const tout = rep(nom, q, true).data || []
          return Promise.resolve({ data: tout.slice(a, b + 1), error: null })
        },
        insert (r) { etat.ecritures.push({ table: nom, row: r }); return Promise.resolve({ error: null }) },
        upsert (r) { etat.ecritures.push({ table: nom, row: r }); return Promise.resolve({ error: null }) },
        update (r) { etat.ecritures.push({ table: nom, row: r }); return q },
        delete () { etat.ecritures.push({ table: nom, row: 'delete' }); return q },
        single: async () => rep(nom, q), maybeSingle: async () => rep(nom, q),
        then (ok, ko) { return Promise.resolve(rep(nom, q, true)).then(ok, ko) }
      }
      function rep (nom, q, tableau = false) {
        etat.lectures.push({ table: nom, filtres: { ...q._f } })
        if (nom === 'properties') {
          if (q._or) {
            const m = String(q._or).match(/^id\.eq\.([^,]+),/)
            const b = BIENS.find(x => x.id === (m && m[1])) || null
            return { data: tableau ? (b ? [b] : []) : b, error: null }
          }
          // ⚠ C'EST ICI QUE SE JOUE LE TEST DE LA COLONNE MANQUANTE : la
          // relecture complete de l'endpoint rend la fiche AMPUTEE si le test
          // le demande.
          if (q._f.id === BIEN.id) return { data: tableau ? [fiche] : fiche, error: null }
          const b = BIENS.find(x => x.id === q._f.id) || null
          return { data: tableau ? (b ? [b] : []) : b, error: null }
        }
        if (nom === 'profiles') {
          const ok = profil && profil.account_user_id === q._f.account_user_id &&
            profil.member_user_id === q._f.member_user_id
          return { data: ok ? profil : null, error: null }
        }
        if (nom === 'profile_permissions') return { data: permissions, error: null }
        if (nom === 'bookings_snapshot') {
          const rows = snapshots.filter(s => q._f.user_id == null || s.user_id === q._f.user_id)
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        if (nom === 'calendar_inventory') {
          // ⚠ LE DOUBLE HONORE LA CLE ET LES BORNES. Ignorer `property_id`
          // laissait passer le piege n° 10 du depot (UUID vs cle provider) :
          // le calendrier d'un bien etait servi pour n'importe quel autre.
          const rows = inventaire.filter(l =>
            (q._f.property_id == null || l.property_id === q._f.property_id) &&
            (q._gte == null || l[q._gte.c] >= q._gte.v) &&
            (q._lte == null || l[q._lte.c] <= q._lte.v))
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        if (nom === 'school_holidays') {
          const rows = vacances.filter(v =>
            (q._lte == null || v[q._lte.c] <= q._lte.v) &&
            (q._gte == null || v[q._gte.c] >= q._gte.v))
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        if (nom === 'yield_exceptions') {
          const rows = exceptions.filter(e =>
            q._f.property_id == null || e.property_id === q._f.property_id)
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        return { data: tableau ? [] : null, error: null }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}
const req = (o = {}) => ({ method: 'GET', headers: { authorization: 'Bearer tok' },
  query: { property_id: BIEN.id }, body: {}, ...o })
const profilActif = (o = {}) => ({ id: 'p1', account_user_id: PROD, member_user_id: MEMBRE,
  active: true, accepted_at: '2026-09-01', ...o })
const perms = (o = {}) => ({ profile_id: 'p1', property_scope: 'all', property_ids: [],
  property_refs: [], reservations: 'none', menages: 'none', prestataires: 'none',
  messages: 'none', avis: 'none', reglages: 'none', facturation: 'none', equipe: 'none', ...o })

// ─── Gardes ──────────────────────────────────────────────────────────────────

test('yield : sans jeton -> 401', async () => {
  preparer({ user: null })
  const res = reponse()
  await require('../api/yield')(req({ headers: {} }), res)
  assert.strictEqual(res.code, 401)
})

test('yield : POST -> 405, la lecture ne s ecrit pas', async () => {
  preparer({})
  const res = reponse()
  await require('../api/yield')(req({ method: 'POST' }), res)
  assert.strictEqual(res.code, 405)
})

test('yield : sans property_id -> 400', async () => {
  preparer({})
  const res = reponse()
  await require('../api/yield')(req({ query: {} }), res)
  assert.strictEqual(res.code, 400)
})

test('LE TEST QUI COMPTE : un bien ETRANGER est refuse', async () => {
  // La service key contourne RLS : cet endpoint est la SEULE barriere. Un
  // 200 ici servirait le chiffre d'affaires d'un autre compte.
  const etat = preparer({})
  const res = reponse()
  await require('../api/yield')(req({ query: { property_id: BIEN_TIERS.id } }), res)
  assert.ok(res.code === 403 || res.code === 404, `attendu 403/404, recu ${res.code}`)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('yield : membre sans droit reservations -> 403', async () => {
  preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ reservations: 'none' }) })
  const res = reponse()
  await require('../api/yield')(req(), res)
  assert.strictEqual(res.code, 403)
})

test('yield : membre avec reservations=read -> passe', async () => {
  // Le chemin PASSANT, pour qu'un 403 de trop se voie tout de suite.
  preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ reservations: 'read' }) })
  const res = reponse()
  await require('../api/yield')(req(), res)
  assert.strictEqual(res.code, 200)
})

// ─── Le defaut qui a motive ce fichier ───────────────────────────────────────

test('LE TEST QUI COMPTE : une colonne manquante est REFUSEE, pas subie', async () => {
  // ⚠ LE DEFAUT DU 11 SEPTEMBRE, A L'IDENTIQUE. `resoudreBien` ne rend que
  // six colonnes. Sans relecture complete :
  //   - `zone_scolaire` absente → tout part en « vacances d'une autre zone »,
  //     le seul segment qui ne porte aucun signal de prix ;
  //   - `base_price` absente → taux d'occupation et RevPAR `null` partout ;
  //   - `capacity` absente → occupation en personnes jamais calculable.
  // Aucune erreur, des chiffres credibles, et une reference fausse.
  for (const absente of ['base_price', 'capacity', 'zone_scolaire', 'prix_minimum']) {
    const gardees = Object.keys(BIEN).filter(c => c !== absente)
    preparer({ colonnesBien: gardees })
    const res = reponse()
    await require('../api/yield')(req(), res)
    assert.strictEqual(res.code, 500, `${absente} manquante : un 200 servirait des chiffres faux`)
    assert.match(res.body.error, new RegExp(absente), 'et on DIT laquelle manque')
  }
})

test('la fiche complete du bien remonte dans la reponse', async () => {
  preparer({})
  const res = reponse()
  await require('../api/yield')(req(), res)
  assert.strictEqual(res.code, 200)
  // Ces quatre valeurs decident de tout le calcul : si elles sont nulles ici,
  // c'est que la relecture complete a saute.
  assert.strictEqual(res.body.bien.zone_scolaire, 'C')
  assert.strictEqual(res.body.bien.capacity, 2)
  assert.strictEqual(res.body.bien.base_price, 95)
  assert.strictEqual(res.body.bien.prix_minimum, 9500)
})

// ─── Fenetres ────────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : la fenetre HISTORIQUE est gardee, pas seulement la demandee', async () => {
  // La fenetre reellement lue vaut la demandee PLUS trois ans. La garde du
  // haut ne portait que sur la demandee : une fenetre acceptee pouvait faire
  // lever `joursExclus` au milieu du traitement, ou rendre des capacites vides
  // — donc « je ne sais pas » sur tout l ecran, sans qu on sache pourquoi.
  preparer({})
  const res = reponse()
  await require('../api/yield')(req({ query: {
    property_id: BIEN.id, debut: '2020-01-01', fin: '2026-12-31' } }), res)
  assert.strictEqual(res.code, 400)
  assert.match(res.body.error, /trop large/)
})

test('yield : fin avant debut -> 400', async () => {
  preparer({})
  const res = reponse()
  await require('../api/yield')(req({ query: {
    property_id: BIEN.id, debut: '2026-06-01', fin: '2026-01-01' } }), res)
  assert.strictEqual(res.code, 400)
})

test('yield : granularite inconnue retombe sur « mois », elle ne casse pas', async () => {
  preparer({})
  const res = reponse()
  await require('../api/yield')(req({ query: {
    property_id: BIEN.id, granularite: 'trimestre' } }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.fenetre.granularite, 'mois')
})

// ─── Ce que l endpoint ne doit JAMAIS faire ──────────────────────────────────

test('LE TEST QUI COMPTE : lecture seule, AUCUNE ecriture', async () => {
  // Le lot 4.1 est un socle de LECTURE. Une ecriture ici contournerait le
  // chemin normal du calendrier — donc le journal des prix, donc la validation
  // de l hote.
  const etat = preparer({})
  const res = reponse()
  await require('../api/yield')(req(), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(etat.ecritures, [], 'un endpoint de lecture a ecrit')
})

test('LE TEST QUI COMPTE : le snapshot est lu CLOISONNE par compte', async () => {
  // Le pont demapped exige de lire TOUTES les reservations, pas seulement
  // celles du bien : une ligne `demapped` d un ancien provider porte la date
  // de vente d origine. Sans filtre par compte, ce sont les reservations de
  // TOUS les hotes qui entreraient dans le calcul.
  const etat = preparer({})
  const res = reponse()
  await require('../api/yield')(req(), res)
  assert.strictEqual(res.code, 200)
  const lecturesSnap = etat.lectures.filter(l => l.table === 'bookings_snapshot')
  assert.ok(lecturesSnap.length, 'le snapshot doit etre lu')
  for (const l of lecturesSnap) {
    assert.strictEqual(l.filtres.user_id, PROD, 'lecture du snapshot sans filtre de compte')
  }
})

test('une panne de lecture donne 500, jamais un ecran vide a 200', async () => {
  // Un 200 avec des tableaux vides ferait lire « ce bien n a rien vendu » —
  // le faux negatif que tout ce chantier combat, jusque dans la gestion
  // d erreur.
  const etat = preparer({})
  const res = reponse()
  // On casse la lecture du snapshot APRES la garde.
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const vrai = require.cache[abs].exports.createClient
  require.cache[abs].exports.createClient = () => {
    const c = vrai()
    const from = c.from.bind(c)
    c.from = (nom) => {
      if (nom !== 'bookings_snapshot') return from(nom)
      const q = { select: () => q, eq: () => q, order: () => q,
        range: () => Promise.resolve({ data: null, error: { message: 'timeout' } }) }
      return q
    }
    return c
  }
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  await require('../api/yield')(req(), res)
  assert.strictEqual(res.code, 500)
  assert.deepStrictEqual(etat.ecritures, [])
})

// ─── LE CALCUL TOURNE VRAIMENT ───────────────────────────────────────────────
// ⚠ RELEVE EN REVIEW : les quatorze premiers tests passaient `snapshots: []` et
// `inventaire: []`. Les six modules tournaient donc sur des tableaux vides dans
// 100 % des cas — si l'endpoint filtrait le snapshot sur `bien.id` (UUID) au
// lieu de `bien.provider_property_id` (TEXT), le piege n° 10 du depot et
// justement celui que l'en-tete de ce fichier dit combattre, TOUS seraient
// restes au vert. Les assertions ne portaient que sur des codes HTTP.

const AN = new Date().getFullYear()

// Une reservation de deux nuits, a la forme reelle d'une ligne snapshot.
function resa (bookingId, arrivee, depart, prix, vente, propId = BIEN.provider_property_id) {
  return {
    user_id: PROD, booking_id: bookingId, property_id: propId,
    snapshot: { provider: 'channex', source: 'Booking.com', status: 'confirmed',
      arrival: arrivee, departure: depart, price: prix, numAdult: 2 },
    // ⚠ LA VRAIE FORME DU PAYLOAD CHANNEX/BOOKING. `prixVoyageur` lit
    // `rooms[].meta.price_details.guest_view.total`, jamais `amount` — c'est
    // la regle du KB (`amount` Airbnb est un NET HOTE). Un faux payload
    // simplifie aurait rendu un prix `null` et un CA de zero : le test aurait
    // « passe » en ne mesurant rien.
    raw: {
      inserted_at: `${vente}T10:00:00Z`,
      rooms: [{ meta: { price_details: { guest_view: {
        total: { amount: prix * 100, decimal_places: 2 } } } } }]
    }
  }
}
function nuit (date, rate = 100, propId = BIEN.id) {
  return { property_id: propId, date, rate, avail: 1, stop_sell: false }
}

test('LE TEST QUI COMPTE : le snapshot se lit sur la CLE PROVIDER, pas sur l UUID', () => {
  // `bookings_snapshot.property_id` porte la cle PROVIDER (TEXT) ; `properties.id`
  // est un UUID. Les confondre rend un CA de zero sur un bien qui vend — sans
  // la moindre erreur. C'est le piege que ce depot a paye plusieurs fois.
  const debut = `${AN}-06-01`, fin = `${AN}-06-30`
  const etat = preparer({
    snapshots: [resa('B1', `${AN}-06-10`, `${AN}-06-12`, 240, `${AN}-05-01`)],
    inventaire: [nuit(`${AN}-06-10`), nuit(`${AN}-06-11`)]
  })
  const res = reponse()
  return require('../api/yield')(req({ query: { property_id: BIEN.id, debut, fin } }), res)
    .then(() => {
      assert.strictEqual(res.code, 200)
      const juin = res.body.realise.find(r => r.periode === `${AN}-06`)
      assert.ok(juin, 'la periode doit exister')
      assert.strictEqual(juin.nuitees, 2, 'la resa doit etre RATTACHEE au bien')
      assert.strictEqual(juin.ca, 240)
      assert.strictEqual(res.body.sources.reservations_du_bien, 1)
    })
})

test('une reservation portant la cle d un AUTRE bien n entre pas dans le calcul', () => {
  const debut = `${AN}-06-01`, fin = `${AN}-06-30`
  preparer({
    snapshots: [resa('B9', `${AN}-06-10`, `${AN}-06-12`, 999, `${AN}-05-01`, '999999')],
    inventaire: [nuit(`${AN}-06-10`)]
  })
  const res = reponse()
  return require('../api/yield')(req({ query: { property_id: BIEN.id, debut, fin } }), res)
    .then(() => {
      assert.strictEqual(res.code, 200)
      assert.strictEqual(res.body.sources.reservations_du_bien, 0)
      const juin = res.body.realise.find(r => r.periode === `${AN}-06`)
      assert.strictEqual(juin.ca, 0, 'le CA d un autre bien ne doit pas fuiter')
    })
})

test('LE TEST QUI COMPTE : le N-1 est CHARGE, sinon la comparaison est un faux negatif', () => {
  // `comparerAN1` ne cherche que dans le tableau qu'on lui passe — c'est un
  // contrat, et c'est l'endpoint qui doit le respecter en chargeant l'annee
  // precedente. Sans cela, « periode_n1_absente » partout, indiscernable d'un
  // bien qui n'existait pas.
  const debut = `${AN}-06-01`, fin = `${AN}-06-30`
  preparer({
    snapshots: [
      resa('B1', `${AN}-06-10`, `${AN}-06-12`, 240, `${AN}-05-01`),
      resa('B0', `${AN - 1}-06-10`, `${AN - 1}-06-11`, 100, `${AN - 1}-05-01`)
    ],
    inventaire: [nuit(`${AN}-06-10`), nuit(`${AN}-06-11`), nuit(`${AN - 1}-06-10`)]
  })
  const res = reponse()
  return require('../api/yield')(req({ query: { property_id: BIEN.id, debut, fin } }), res)
    .then(() => {
      const juin = res.body.realise.find(r => r.periode === `${AN}-06`)
      assert.strictEqual(juin.vs_n1.periode_n1, `${AN - 1}-06`)
      assert.strictEqual(juin.vs_n1.ca.n1, 100, 'le N-1 doit etre CHARGE et trouve')
      assert.strictEqual(juin.vs_n1.ca.ecart, 140)
    })
})

test('LE TEST QUI COMPTE : la periode ENTIERE est segmentee, pas la seule fenetre', () => {
  // ⚠ RELEVE EN REVIEW. Le contexte etait bati sur la fenetre DEMANDEE alors
  // que la projection porte sur le mois COMPLET : avec une fenetre finissant
  // le 12, les jours du 13 au 30 rendaient « hors_fenetre_du_contexte » et
  // l'hote lisait « je ne sais pas » sur dix-huit jours dont la reference
  // existe.
  const debut = `${AN}-06-01`, fin = `${AN}-06-12`
  preparer({
    snapshots: Array.from({ length: 10 }, (_, i) =>
      resa(`R${i}`, `${AN - 1}-06-${String(i + 1).padStart(2, '0')}`,
        `${AN - 1}-06-${String(i + 2).padStart(2, '0')}`, 100, `${AN - 1}-01-01`)),
    inventaire: Array.from({ length: 30 }, (_, i) =>
      nuit(`${AN}-06-${String(i + 1).padStart(2, '0')}`))
  })
  const res = reponse()
  return require('../api/yield')(req({ query: { property_id: BIEN.id, debut, fin } }), res)
    .then(() => {
      assert.strictEqual(res.code, 200)
      const p = res.body.projection.find(x => x.periode === `${AN}-06`)
      assert.ok(p, 'la projection du mois doit exister')
      assert.strictEqual(p.jours_sans_reference, 0,
        'aucun jour du mois ne doit tomber hors du contexte')
    })
})

test('LE TEST QUI COMPTE : granularite « jour » sur un an est REFUSEE, pas subie', () => {
  // ⚠ RELEVE EN REVIEW. `JOURS_MAX` bornait les jours, pas les periodes : avec
  // le detail « par jour » et trois ans d historique, l endpoint lançait 1 461
  // requetes et rendait 1,2 Mo. L ecran restait sur « Lecture… » puis tombait.
  const etat = preparer({})
  const res = reponse()
  return require('../api/yield')(req({ query: {
    property_id: BIEN.id, debut: `${AN}-01-01`, fin: `${AN}-12-31`, granularite: 'jour' } }), res)
    .then(() => {
      assert.strictEqual(res.code, 400)
      assert.match(res.body.error, /trop de périodes/)
      assert.strictEqual(etat.lectures.filter(l => l.table === 'calendar_inventory').length, 0,
        'et AUCUNE lecture de capacite n est partie')
    })
})

test('granularite « jour » sur une fenetre courte reste possible', () => {
  // Le chemin PASSANT : la borne ne doit pas fermer un usage legitime.
  preparer({ inventaire: [nuit(`${AN}-06-10`), nuit(`${AN}-06-11`)] })
  const res = reponse()
  return require('../api/yield')(req({ query: {
    property_id: BIEN.id, debut: `${AN}-06-10`, fin: `${AN}-06-11`, granularite: 'jour' } }), res)
    .then(() => assert.strictEqual(res.code, 200))
})

test('LE TEST QUI COMPTE : un 29 fevrier ne met pas l app en panne', () => {
  // ⚠ RELEVE EN REVIEW. `reculerAns` faisait de l arithmetique de chaine :
  // 2024-02-29 moins trois ans donnait « 2021-02-29 », qui n existe pas.
  // `joursDeLaPeriode` rend alors `[]` — pas `null` — donc les gardes
  // laissaient passer, les capacites partaient vides, et le traitement
  // s arretait plus loin sur un 500 opaque.
  preparer({ inventaire: [nuit('2024-02-29')] })
  const res = reponse()
  return require('../api/yield')(req({ query: {
    property_id: BIEN.id, debut: '2024-02-29', fin: '2024-03-31' } }), res)
    .then(() => {
      assert.strictEqual(res.code, 200, `un 29 fevrier doit passer, recu ${res.code}`)
      assert.strictEqual(res.body.historique.debut, '2021-02-28', 'replie sur le 28')
    })
})

test('un bien NON RACCORDE le dit, il n affiche pas des zeros', () => {
  // La colonne existe et vaut `null` : aucune reservation ne lui correspond,
  // donc CA 0, nuitees 0, reference vide — et aucun motif. La verite est
  // « ce logement n est pas raccorde ».
  const sansCle = Object.keys(BIEN)
  preparer({ colonnesBien: sansCle })
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const vrai = require.cache[abs].exports.createClient
  require.cache[abs].exports.createClient = () => {
    const c = vrai()
    const from = c.from.bind(c)
    c.from = (nom) => {
      const q = from(nom)
      if (nom !== 'properties') return q
      const m = q.maybeSingle.bind(q)
      q.maybeSingle = async () => {
        const r = await m()
        if (r.data && r.data.id === BIEN.id && !r.data.provider_property_id === false) {
          return { data: { ...r.data, provider_property_id: null }, error: null }
        }
        return r
      }
      return q
    }
    return c
  }
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  const res = reponse()
  return require('../api/yield')(req(), res).then(() => {
    assert.strictEqual(res.code, 409)
    assert.match(res.body.error, /raccordé/)
  })
})

test('un pivot dans le FUTUR est ramene a aujourd hui', () => {
  // Sinon le « a date » rend le realise final : le contraire de ce que
  // l indicateur promet.
  preparer({})
  const res = reponse()
  return require('../api/yield')(req({ query: {
    property_id: BIEN.id, pivot: '2999-12-31' } }), res)
    .then(() => {
      assert.strictEqual(res.code, 200)
      assert.strictEqual(res.body.fenetre.pivot, res.body.fenetre.aujourdhui)
    })
})
