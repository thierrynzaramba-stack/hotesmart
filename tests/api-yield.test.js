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
// Le MEME validateur que le module : une date impossible ne doit pas passer
// plus facilement dans le double que dans Postgres.
const { estJourISO } = require('../lib/yield/capacite')

function preparer ({ user = PROD, profil = null, permissions = null,
  colonnesBien = null, snapshots = [], inventaire = [], vacances = [],
  // ⚠ `echecTable` fait LEVER la lecture d'une table nommee, apres la garde.
  // Sans lui, aucun test ne pouvait eprouver qu'une lecture de
  // `calendar_inventory` en echec rend 500 plutot qu'un denominateur invente.
  exceptions = [], echecTable = null } = {}) {
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
          // ⚠ LE DOUBLE REFUSE UNE DATE QUI N'EXISTE PAS, comme Postgres.
          // `calendar_inventory.date` est de type `date` : une borne
          // « 2023-02-29 » rend l'erreur 22008, pas un resultat vide. Sans
          // cette fidelite, le double acceptait une borne impossible et la
          // regression du 20 octobre 2026 — 500 sur toute la reponse pour une
          // fenetre commencant un 29 fevrier — restait invisible.
          for (const borne of [q._gte, q._lte]) {
            if (borne && String(borne.c) === 'date' && !estJourISO(String(borne.v))) {
              return Promise.resolve({ data: null, error: {
                code: '22008',
                message: `date/time field value out of range: "${borne.v}"`
              } })
            }
          }
          if (echecTable && nom === echecTable) {
            etat.lectures.push({ table: nom, filtres: { ...q._f } })
            return Promise.resolve({ data: null, error: { message: 'panne simulee' } })
          }
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
      // ⚠ L'ASSERTION PORTE SUR LE MOTIF, PAS SUR LE COMPTE — corrige le
      // 13 septembre 2026. `jours_sans_reference` confond DEUX causes
      // opposees : « ce jour est hors de la fenetre du contexte » (le defaut
      // que ce test existe pour empecher) et « ce type de nuit n'a pas assez
      // d'historique » (une reponse legitime du moteur). Le jeu d'essai ne
      // porte que dix nuits : l'arrivee du segment « week-end prolonge » a
      // suffi a amincir l'echantillon, et le test est passe au rouge pour une
      // raison qui n'etait pas la sienne.
      const horsContexte = (p.detail || [])
        .filter(x => x.non_calculable === 'hors_fenetre_du_contexte')
      assert.deepEqual(horsContexte.map(x => x.date), [],
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

test('LE TEST QUI COMPTE : le calendrier est lu UNE fois, pas une fois par periode', () => {
  // ⚠ MESURE DU 20 OCTOBRE 2026, accueil connecte sur le compte de production.
  // L appel quotidien demande 60 jours, et `cles` y ajoute la periode
  // PRECEDENTE de chacun : 120 periodes, donc 120 lectures de
  // `calendar_inventory`, par vagues de 6 — 20 allers-retours en serie pour un
  // seul bien. Pour la page entiere : 4 biens x (120 + 26) = 584 requetes.
  // Releve par Thierry dans son navigateur : /api/yield de 1,6 s a 5,6 s par
  // appel, le dernier fini a ~15,7 s apres l ouverture de la page.
  //
  // `joursOuverts` porte la facilite pour l eviter depuis le lot 4.6
  // (`options.lignes`, avec sa propre mesure : « 2 673 ms de requetes » -> une
  // lecture). Cet endpoint ne s en servait pas.
  //
  // Parite prouvee sur les donnees REELLES, pas seulement ici :
  // `scripts/verifier-parite-capacites.js` rejoue les deux chemins avec les
  // memes fonctions de production — 730 periodes, 0 divergence, 242 582 ms ->
  // 1 777 ms (la colonne « ancien » y est serie, l endpoint faisait des vagues
  // de 6 : diviser par ~6 pour comparer a l endpoint).
  const jours = Array.from({ length: 10 }, (_, i) => `${AN}-06-${String(10 + i).padStart(2, '0')}`)
  const etat = preparer({ inventaire: jours.map(j => nuit(j)) })
  const res = reponse()
  return require('../api/yield')(req({ query: {
    property_id: BIEN.id, debut: jours[0], fin: jours[jours.length - 1], granularite: 'jour' } }), res)
    .then(() => {
      assert.strictEqual(res.code, 200)
      const lectures = etat.lectures.filter(l => l.table === 'calendar_inventory')
      assert.strictEqual(lectures.length, 1,
        `${lectures.length} lectures de calendar_inventory pour ${jours.length} jours demandes`
        + ' : le chemin « une requete par periode » est revenu')
      // ⚠ ET LA LECTURE DOIT AVOIR TROUVE SES LIGNES. `jours_ouverts > 0` ne
      // prouvait RIEN : la fenetre est passee et `estimerLePasse` compte ouvert
      // tout jour passe sans ligne, donc ce compte tenait meme si la lecture ne
      // rendait rien. Mesure a l'appui : muter la cle de lecture en
      // `provider_property_id` (le piege UUID / cle provider, paye quatre fois
      // par ce depot) laissait les 5486 tests VERTS — la lecture repartait a
      // vide, toutes les periodes passaient en ESTIMEES, et l'accueil affichait
      // un denominateur estime comme s'il etait mesure.
      // L'absence de `capacite_estimee` est la seule assertion qui exige que
      // les lignes aient ete trouvees, et classees sur le bon bien.
      const periodes = res.body.realise || []
      assert.ok(periodes.length, 'aucune periode rendue')
      assert.ok(periodes.some(p => p.jours_ouverts > 0),
        'aucune periode ne porte de jour ouvert : la lecture unique ne classe plus rien')
      const estimees = periodes.filter(p => p.capacite_estimee)
      assert.strictEqual(estimees.length, 0,
        `${estimees.length} periode(s) sur ${periodes.length} en capacite ESTIMEE`
        + ' alors que chaque jour a sa ligne : la lecture n a pas trouve ses lignes'
        + ' (mauvaise cle de lecture ?)')
    })
})

test("LE TEST QUI COMPTE : le nombre de lectures ne depend pas du nombre de periodes", () => {
  // ⚠ L'INVARIANT, PAS LE CHIFFRE. Compter « 1 » compte des PAGES : une plage
  // de plus de 1000 lignes en demande legitimement deux, et le garde-fou
  // rougirait sur du code juste. La prochaine session monterait alors le nombre
  // attendu, ce qui desarmerait la detection du chemin « une requete par
  // periode » pour tout nombre de periodes inferieur a la nouvelle borne.
  // Ce qui doit tenir, c'est que le compte NE BOUGE PAS avec les periodes.
  const serie = (n) => {
    const jours = Array.from({ length: n }, (_, i) => `${AN}-06-${String(1 + i).padStart(2, '0')}`)
    const etat = preparer({ inventaire: jours.map(j => nuit(j)) })
    const res = reponse()
    return require('../api/yield')(req({ query: {
      property_id: BIEN.id, debut: jours[0], fin: jours[jours.length - 1], granularite: 'jour' } }), res)
      .then(() => {
        assert.strictEqual(res.code, 200, `${n} jours : ${JSON.stringify(res.body)}`)
        return etat.lectures.filter(l => l.table === 'calendar_inventory').length
      })
  }
  return serie(5).then(court => serie(25).then(long => {
    assert.strictEqual(long, court,
      `${court} lecture(s) pour 5 jours mais ${long} pour 25 : le compte suit les periodes`)
  }))
})

test("LE TEST QUI COMPTE : une lecture du CALENDRIER en echec rend 500, jamais un denominateur invente", () => {
  // ⚠ TEST DE NON-REGRESSION (regle 19 de REVIEW.md, point 2) : vert contre le
  // code d'avant ce lot, ou le `throw` vivait dans `joursOuverts` lui-meme. Il
  // ne garde pas un correctif, il garde la propriete que le lot deplace — la
  // lecture est hissee, mais son echec doit toujours remonter.
  // ⚠ LA PROPRIETE SUR LAQUELLE TOUT LE LOT REPOSE, et elle n'etait affirmee
  // qu'en commentaire. Si le `throw` devenait un `console.error` + `data || []`
  // — la forme la plus courante du depot — chaque jour passe tomberait en
  // « sans ligne » donc estime ouvert : 200, denominateur faux, aucun bruit.
  // Et les deux assertions du test precedent ne le verraient pas toutes seules.
  const jours = Array.from({ length: 10 }, (_, i) => `${AN}-06-${String(10 + i).padStart(2, '0')}`)
  preparer({ inventaire: jours.map(j => nuit(j)), echecTable: 'calendar_inventory' })
  const res = reponse()
  return require('../api/yield')(req({ query: {
    property_id: BIEN.id, debut: jours[0], fin: jours[jours.length - 1], granularite: 'jour' } }), res)
    .then(() => {
      assert.strictEqual(res.code, 500,
        'une lecture du calendrier en echec passe pour une plage vide')
    })
})

test('LE TEST QUI COMPTE : une fenetre qui commence un 29 fevrier ne fait pas tomber la reponse', () => {
  // ⚠ TEST DE NON-REGRESSION (regle 19, point 2) : vert contre le code d'avant
  // ce lot, qui n'emettait jamais cette borne. Il garde le correctif du lot —
  // eprouve rouge contre la version sans le filtre `estJourISO`.
  // ⚠ REGRESSION DU 20 OCTOBRE 2026, trouvee en review et reproduite dans les
  // deux sens. `periodePrecedente` fait de l arithmetique de CHAINE :
  // `periodePrecedente('2024-02-29')` rend « 2023-02-29 », qui n existe pas, et
  // `bornesDePeriode` ne verifie que la FORME. Comme c est le minimum
  // lexicographique, cette date devenait le debut de la plage hissee et partait
  // dans le `.gte('date', …)` : Postgres refuse (22008), la lecture leve, et
  // TOUTE la reponse tombe en 500. L ancien chemin par periode ne l emettait
  // jamais — `joursOuverts` ecartait la cle avant de lire.
  //
  // Le test precedent (« un 29 fevrier ne met pas l app en panne ») ne pouvait
  // pas l attraper : il ne passe pas de `granularite`, donc « mois », ou
  // `bornesDePeriode` calcule une vraie fin de mois.
  //
  // Atteignable a la main depuis « Exploration » (date libre + « Par jour »), et
  // TOUT SEUL depuis l accueil le 29 avril 2028 : il demande
  // `debut = aujourd hui - 60`, soit 2028-02-29.
  const etat = preparer({ inventaire: [nuit('2024-02-29'), nuit('2024-03-01')] })
  const res = reponse()
  return require('../api/yield')(req({ query: {
    property_id: BIEN.id, debut: '2024-02-29', fin: '2024-03-05', granularite: 'jour' } }), res)
    .then(() => {
      assert.strictEqual(res.code, 200,
        `la fenetre du 29 fevrier rend ${res.code} : ${JSON.stringify(res.body)}`)
      // Et aucune borne impossible n est partie : le double aurait rendu 22008.
      const lectures = etat.lectures.filter(l => l.table === 'calendar_inventory')
      assert.ok(lectures.length, 'le calendrier n a pas ete lu du tout')
    })
})

// ─── DETTE 78 : le denominateur suit le numerateur ───────────────────────────
//
// ⚠ L'ASYMETRIE QUE CE LOT FERME. `eclater` retire des nuits de REFERENCE
// celles qu'une exception ou une fermeture declaree couvre, et
// `calculerIndicateurs` fait `nuiteesRef = nuitees - hors_reference` puis
// divise par `jours_ouverts` — sous le commentaire « ce qui DIVISE se calcule
// des deux cotes sur le meme perimetre ». Les deux moities n'etaient pas
// branchees sur le meme perimetre : AUCUN appelant du depot ne passait
// `joursExclus` a `joursOuverts`, donc `estimesFermes` et
// `jours_estimes_fermes_par_exception` de capacite.js etaient du code mort.
//
// Une nuit fermee n'est pas une nuit invendue (decision de Thierry).

const MOIS78 = `${AN}-06`
const joursDuMois78 = Array.from({ length: 30 }, (_, i) => `${MOIS78}-${String(i + 1).padStart(2, '0')}`)

test('LE TEST QUI COMPTE (dette 78) : une nuit DECLAREE FERMEE sort du denominateur', () => {
  // 30 jours lignes et tarifes, donc 30 ouverts. 6 nuits vendues, dont 2 dans
  // une exception declaree de 10 jours.
  //   AVANT : numerateur 4 (les 2 nuits en exception sont retirees),
  //           denominateur 30  -> TO 13,3 %
  //   APRES : numerateur 4, denominateur 20                -> TO 20,0 %
  const etat = preparer({
    inventaire: joursDuMois78.map(j => nuit(j)),
    snapshots: [
      resa('V1', `${MOIS78}-02`, `${MOIS78}-06`, 400, `${AN}-05-01`),   // 4 nuits hors exception
      resa('V2', `${MOIS78}-12`, `${MOIS78}-14`, 200, `${AN}-05-01`)    // 2 nuits DANS l exception
    ],
    exceptions: [{ id: 'e78', user_id: PROD, property_id: BIEN.id,
      date_debut: `${MOIS78}-10`, date_fin: `${MOIS78}-19`, motif: 'travaux' }]
  })
  const res = reponse()
  return require('../api/yield')(req({ query: {
    property_id: BIEN.id, debut: `${MOIS78}-01`, fin: `${MOIS78}-30`, granularite: 'mois' } }), res)
    .then(() => {
      assert.strictEqual(res.code, 200, JSON.stringify(res.body))
      const p = (res.body.realise || []).find(x => x.periode === MOIS78)
      assert.ok(p, `periode ${MOIS78} absente : ${JSON.stringify((res.body.realise || []).map(x => x.periode))}`)
      assert.strictEqual(p.jours_ouverts, 20,
        `${p.jours_ouverts} jours ouverts : les 10 jours declares fermes sont encore au denominateur`)
      assert.strictEqual(p.jours_estimes_fermes_par_exception, 10,
        'le compte des jours fermes par declaration n est pas rendu')
      // Le numerateur, lui, ne bouge pas : 6 nuitees vendues, 2 hors reference.
      assert.strictEqual(p.nuitees, 6, 'le realise doit garder TOUT ce qui est vendu')
      assert.strictEqual(p.nuitees_exclues_du_taux, 2)
      assert.strictEqual(p.taux_occupation, 0.2,
        `TO ${p.taux_occupation} : 4 nuitees de reference sur 20 jours ouverts = 0,2`)
    })
})

test('LE TEST QUI COMPTE (dette 78) : la comparaison avec l AN DERNIER n est plus flattee', () => {
  // ⚠ LA CONSEQUENCE QUI COUTE LE PLUS CHER, et que la mesure du 20 octobre
  // 2026 a mise en evidence : la fenetre ou la dette mord — le passe ancien,
  // sans memoire d intention — est PRECISEMENT le N-1 auquel `comparerAN1`
  // compare le mois courant. Une fermeture declaree l an dernier faisait
  // sous-estimer le TO de reference, donc affichait une amelioration qui
  // n existait pas.
  //
  // Les deux mois vendent EXACTEMENT la meme chose (4 nuits de reference sur
  // 20 jours ouverts) ; seul le mois N-1 porte la declaration de fermeture.
  // La variation juste est donc ZERO.
  const an1 = AN - 1
  const mois1 = `${an1}-06`
  const joursN1 = Array.from({ length: 30 }, (_, i) => `${mois1}-${String(i + 1).padStart(2, '0')}`)
  preparer({
    inventaire: [...joursDuMois78, ...joursN1].map(j => nuit(j)),
    snapshots: [
      // Le mois courant : 4 nuits, et 10 jours fermes declares.
      resa('A1', `${MOIS78}-02`, `${MOIS78}-06`, 400, `${AN}-05-01`),
      // Le mois N-1 : les memes 4 nuits, et les memes 10 jours fermes.
      resa('A0', `${mois1}-02`, `${mois1}-06`, 400, `${an1}-05-01`)
    ],
    exceptions: [
      { id: 'e78a', user_id: PROD, property_id: BIEN.id,
        date_debut: `${MOIS78}-10`, date_fin: `${MOIS78}-19`, motif: 'travaux' },
      { id: 'e78b', user_id: PROD, property_id: BIEN.id,
        date_debut: `${mois1}-10`, date_fin: `${mois1}-19`, motif: 'travaux' }
    ]
  })
  const res = reponse()
  return require('../api/yield')(req({ query: {
    property_id: BIEN.id, debut: `${MOIS78}-01`, fin: `${MOIS78}-30`, granularite: 'mois' } }), res)
    .then(() => {
      assert.strictEqual(res.code, 200, JSON.stringify(res.body))
      const p = (res.body.realise || []).find(x => x.periode === MOIS78)
      assert.ok(p && p.vs_n1, `pas de comparaison N-1 : ${JSON.stringify(p && Object.keys(p))}`)
      assert.strictEqual(p.vs_n1.periode_n1, mois1)
      assert.strictEqual(p.vs_n1.disponible, true,
        'le N-1 n est pas trouve : la comparaison ne peut rien dire')
      // Les deux mois sont identiques : la variation du TO doit etre NULLE.
      // Sans le correctif, le denominateur du N-1 valait 30 au lieu de 20,
      // son TO 13,3 % au lieu de 20 %, et la variation annoncait +50 %.
      assert.strictEqual(p.taux_occupation, 0.2)
      const v = p.vs_n1.taux_occupation
      assert.ok(v, `pas de variation de taux_occupation : ${JSON.stringify(p.vs_n1)}`)
      assert.strictEqual(v.n1, 0.2,
        `le TO de l an dernier vaut ${v.n1} au lieu de 0,2 : son denominateur garde les jours fermes`)
      assert.strictEqual(v.variation, 0,
        `la comparaison annonce ${v.variation} au lieu de 0 sur deux mois identiques`)
    })
})
