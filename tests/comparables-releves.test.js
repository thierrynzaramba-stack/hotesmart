const test = require('node:test')
const assert = require('node:assert')
const { lignesCloses, lignesFutures, _interne } = require('../lib/marche/comparables-releves')

// ⚠ DATES FIGEES, PARCE QUE CE MODULE INJECTE LE TEMPS. `aujourdhui` est un
// parametre : aucune de ces fonctions ne lit l'horloge. Regle du depot —
// *dates relatives si le test lit l'horloge, dates figees s'il injecte le
// temps.* Des dates relatives ici rendraient les fenetres mouvantes.
const AUJ = '2026-10-15'

const mois = (m, revenue) => ({ date: `${m}-01`, revenue })
const jour = (d, available, rate) => ({ date: d, available, rate, min_nights: 2 })

test('LE TEST QUI COMPTE : le mois COURANT n est pas clos', () => {
  // Il bougera encore. L'inclure ferait entrer dans la bande du realise un
  // chiffre qui n'est pas final.
  const out = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: [mois('2026-10', 500), mois('2026-09', 400)] })
  const moisRendus = out.map(l => l.mois)
  assert.deepStrictEqual(moisRendus, ['2026-09-01'],
    `octobre 2026 est rendu comme clos alors qu il est en cours : ${JSON.stringify(moisRendus)}`)
})

test('LE TEST QUI COMPTE : un revenu absent rend `null` AVEC son motif, jamais 0', () => {
  // « Non calculable » n est jamais zero. Un montant nul sans motif devient un
  // zero des que quelqu un l additionne.
  const out = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: [mois('2026-09', null), mois('2026-08', undefined)] })
  assert.strictEqual(out.length, 2)
  for (const l of out) {
    assert.strictEqual(l.montant_estime_cents, null, 'un revenu absent est devenu un nombre')
    assert.ok(l.motif && l.motif.length > 3, `le motif manque : ${JSON.stringify(l)}`)
  }
})

test('LE TEST QUI COMPTE : les euros deviennent des CENTIMES', () => {
  const [l] = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: [mois('2026-09', 4006.5)] })
  assert.strictEqual(l.montant_estime_cents, 400650,
    `4006,50 € rendu ${l.montant_estime_cents} : l unite n est pas le centime`)
})

test('LE TEST QUI COMPTE : un champ `available` ABSENT ne compte pas comme occupe', () => {
  // ⚠ `!j.available` compterait `undefined` comme une nuit indisponible, et
  // gonflerait la bande sans que rien ne le dise. C est `=== false` qui tranche.
  const out = lignesFutures({
    listingId: '1', aujourdhui: AUJ,
    jours: [jour('2026-11-01', undefined, 100), jour('2026-11-02', false, 100), jour('2026-11-03', true, 100)]
  })
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].nuits_indisponibles, 1,
    `${out[0].nuits_indisponibles} nuits comptees indisponibles pour une seule a false`)
  assert.strictEqual(out[0].montant_affiche_cents, 10000)
  // Les trois jours ont ete MESURES, meme ceux qui sont disponibles.
  assert.strictEqual(out[0].nuits_mesurees, 3, 'la couverture du mois est fausse')
})

test('LE TEST QUI COMPTE : le PASSE du calendrier est ecarte', () => {
  // AirROI rend des jours deja ecoules. Les garder melangerait du passe non
  // clos a la bande du futur.
  const out = lignesFutures({
    listingId: '1', aujourdhui: AUJ,
    jours: [jour('2026-10-01', false, 100), jour('2026-10-20', false, 100)]
  })
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].nuits_mesurees, 1,
    'un jour anterieur a aujourd hui est entre dans le mois en cours')
})

test('LE TEST QUI COMPTE : un mois TRONQUE se declare par sa couverture', () => {
  // Le calendrier porte ~360 jours : son dernier mois est coupe. Sans
  // `nuits_mesurees`, un mois couvert sur 3 jours se lit comme un mois creux.
  const out = lignesFutures({
    listingId: '1', aujourdhui: AUJ,
    jours: [jour('2027-09-01', false, 90), jour('2027-09-02', false, 90), jour('2027-09-03', true, 90)]
  })
  const sept = out.find(l => l.mois === '2027-09-01')
  assert.ok(sept, 'le mois tronque n est pas rendu')
  assert.strictEqual(sept.nuits_mesurees, 3,
    `couverture annoncee ${sept.nuits_mesurees} pour 3 jours fournis sur 30`)
  assert.ok(sept.nuits_mesurees < _interne.joursDuMois('2027-09'),
    'le test ne demontre rien : le mois fourni est complet')
})

test('LE TEST QUI COMPTE : zero nuit indisponible est un FAIT, pas une absence', () => {
  // C est le seul `0` legitime du module : le mois a ete mesure, il est vide.
  // ⚠ UN MOIS ENTIER, ET C'EST NECESSAIRE DEPUIS LA REVIEW : un mois
  // PARTIELLEMENT couvert porte desormais un motif qui le dit. Ma premiere
  // version ne fournissait que deux jours de decembre — le motif « couvert sur
  // 2 nuits sur 31 » etait donc juste, et c'est le test qui avait tort.
  const decembre = Array.from({ length: 31 }, (_, i) => jour(`2026-12-${String(i + 1).padStart(2, '0')}`, true, 100))
  const out = lignesFutures({ listingId: '1', aujourdhui: AUJ, jours: decembre })
  assert.strictEqual(out[0].nuits_mesurees, 31, 'le mois fourni n est pas complet : le test ne demontre rien')
  assert.strictEqual(out[0].montant_affiche_cents, 0)
  assert.strictEqual(out[0].nuits_indisponibles, 0)
  assert.strictEqual(out[0].motif, null, 'un mois mesure et vide porte un motif : ce n est pas une absence')
})

test('LE TEST QUI COMPTE : un prix manquant sur une nuit occupee se DECLARE', () => {
  // La somme sous-estime. Le dire vaut mieux qu un chiffre dont personne ne
  // sait qu il est incomplet.
  const out = lignesFutures({
    listingId: '1', aujourdhui: AUJ,
    jours: [jour('2026-11-01', false, 100), jour('2026-11-02', false, 0), jour('2026-11-03', false, null)]
  })
  assert.strictEqual(out[0].nuits_indisponibles, 3)
  assert.strictEqual(out[0].montant_affiche_cents, 10000, 'un prix nul ou absent a ete somme')
  assert.match(String(out[0].motif), /2/, `le motif ne compte pas les deux nuits sans prix : « ${out[0].motif} »`)
})

test('LE TEST QUI COMPTE : les deux natures ne remplissent JAMAIS la meme colonne', () => {
  // Deux grandeurs differentes sous un meme nom finissent additionnees.
  const clos = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: [mois('2026-09', 400)] })[0]
  const futur = lignesFutures({ listingId: '1', aujourdhui: AUJ, jours: [jour('2026-11-01', false, 100)] })[0]
  assert.strictEqual(clos.nature, 'clos')
  assert.strictEqual(clos.montant_affiche_cents, null, 'un mois clos remplit la colonne du futur')
  assert.strictEqual(futur.nature, 'futur')
  assert.strictEqual(futur.montant_estime_cents, null, 'un mois futur remplit la colonne du passe')
  // Et aucune colonne ne s appelle « revenu » (regle de Thierry).
  for (const l of [clos, futur]) {
    for (const k of Object.keys(l)) {
      assert.ok(!/revenu/i.test(k), `la colonne « ${k} » s appelle revenu`)
    }
  }
})

test('LE TEST QUI COMPTE : un mois rendu DEUX FOIS ne produit qu une ligne', () => {
  // La cle d unicite le refuserait en base, mais un refus de contrainte est un
  // rapport illisible : on tranche avant d ecrire.
  const out = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: [mois('2026-09', 400), mois('2026-09', 999)] })
  assert.strictEqual(out.length, 1, 'le mois double a produit deux lignes')
  assert.strictEqual(out[0].montant_estime_cents, 40000, 'ce n est pas la premiere ligne qui a ete gardee')
})

test('RECENSEMENT : la profondeur borne les mois clos', () => {
  const vieux = Array.from({ length: 40 }, (_, i) => {
    let m = '2026-09'
    for (let k = 0; k < i; k++) m = _interne.moisPrecedent(m)
    return mois(m, 100)
  })
  const out = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: vieux })
  assert.strictEqual(out.length, _interne.PROFONDEUR_MOIS,
    `${out.length} mois rendus pour une profondeur de ${_interne.PROFONDEUR_MOIS}`)
})

// ─── L'ORCHESTRATEUR ───────────────────────────────────────────────────────
// ⚠ `releverSiDu` N'ETAIT APPELE PAR AUCUN TEST, et la review a mesure que
// quatre mutations y survivaient — dont « une photo ecrase la precedente » et
// « la date du releve devient le jour du cron », qui est la decision la plus
// importante du module.

const { releverSiDu } = require('../lib/marche/comparables-releves')

// Un double de Supabase qui repond par TABLE et retient ce qu'on lui ecrit.
function faireBase ({ retenus = [], dejaFaits = [], erreurUpsert = null } = {}) {
  const vu = { upserts: [], tables: [], filtres: [] }
  const client = {
    from (table) {
      vu.tables.push(table)
      const rep = () => table === 'comparables_retenus'
        ? { data: retenus, error: null }
        : { data: dejaFaits, error: null }
      const q = {
        select (cols) { q._cols = cols; return q },
        eq (c, v) { vu.filtres.push(['eq', c, v]); return q },
        gte (c, v) { vu.filtres.push(['gte', c, v]); return q },
        limit () { return Promise.resolve(rep()) },
        upsert (lignes, opts) {
          vu.upserts.push({ table, lignes, opts })
          return {
            select: () => Promise.resolve({
              data: erreurUpsert ? null : lignes.map((_, i) => ({ id: i + 1 })),
              error: erreurUpsert
            })
          }
        },
        then (r) { return Promise.resolve(rep()).then(r) }
      }
      return q
    }
  }
  return { client, vu }
}

// Un client AirROI qui rend des reponses REELLES de forme, datees du cache.
function faireClient ({ recupereLe = '2026-10-06' } = {}) {
  return {
    estimer: async () => 1.6,
    marge: async () => 5,
    metriquesAnnonce: async () => ({
      recupereLe: `${recupereLe}T10:00:00Z`,
      // ⚠ LA FORME D'AIRROI : `YYYY-MM`, pas `YYYY-MM-DD`.
      donnees: { results: [{ date: '2026-09', revenue: 4006 }, { date: '2026-08', revenue: 3000 }] }
    }),
    calendrierAnnonce: async () => ({
      recupereLe: `${recupereLe}T10:00:00Z`,
      donnees: { results: [{ date: '2026-11-01', available: false, rate: 100, min_nights: 2 }] }
    })
  }
}

const RETENU = { property_id: 'bien-A', listing_id: '111', user_id: 'u1' }

test("LE TEST QUI COMPTE : `releve_le` est la date de la CAPTURE, pas du cron", async () => {
  // ⚠ LA DECISION LA PLUS IMPORTANTE DU MODULE. Le cache AirROI dure 90 jours
  // et ne se contourne pas : dater du jour du cron ecrirait trois photos
  // differentes portant la MEME donnee, vieille de 0, 30 et 60 jours — et la
  // comparaison « a delai egal » reposerait sur des dates fausses.
  const { client, vu } = faireBase({ retenus: [RETENU] })
  const r = await releverSiDu({ errors: [] }, {
    supabase: client, client: faireClient({ recupereLe: '2026-10-06' }),
    now: () => new Date('2026-10-28T03:00:00Z').getTime(), forcer: true
  })
  assert.ok(r.ecrites > 0, `aucune ligne ecrite : ${JSON.stringify(r)}`)
  const lignes = vu.upserts[0].lignes
  for (const l of lignes) {
    assert.strictEqual(l.releve_le, '2026-10-06',
      `la ligne est datee du ${l.releve_le} — le jour du cron, pas celui de la capture`)
  }
})

test("LE TEST QUI COMPTE : la cle d unicite porte `releve_le`", async () => {
  // Sans lui, une photo ECRASE la precedente — et toute la raison d etre de la
  // table (« on garde tout ») disparait.
  const { client, vu } = faireBase({ retenus: [RETENU] })
  await releverSiDu({ errors: [] }, {
    supabase: client, client: faireClient(),
    now: () => new Date('2026-10-28T03:00:00Z').getTime(), forcer: true
  })
  const opts = vu.upserts[0].opts
  assert.match(String(opts.onConflict), /releve_le/,
    `la cle de conflit est « ${opts.onConflict} » : une photo ecrasera la precedente`)
  assert.strictEqual(opts.ignoreDuplicates, true,
    'un relevé deja en base leverait au lieu d etre ignore')
})

test("LE TEST QUI COMPTE : un bien DEJA RELEVE ce mois-ci est saute", async () => {
  // ⚠ LE CONSTAT n°2 DE LA REVIEW : avec un verrou mensuel GLOBAL, le premier
  // bien traite bloquait tout le mois, et le mois suivant le MEME bien
  // repassait en tete — un seul bien releve, les autres JAMAIS.
  const { client } = faireBase({
    retenus: [RETENU, { property_id: 'bien-B', listing_id: '222', user_id: 'u1' }],
    dejaFaits: [{ property_id: 'bien-A' }]
  })
  const r = await releverSiDu({ errors: [] }, {
    supabase: client, client: faireClient(),
    now: () => new Date('2026-10-28T03:00:00Z').getTime(), forcer: true
  })
  assert.strictEqual(r.bien, 'bien-B',
    `le passage a repris ${r.bien} alors qu il etait deja releve ce mois-ci`)
})

test("LE TEST QUI COMPTE : le temoin du « deja fait » est la date d ECRITURE", async () => {
  // `releve_le` peut avoir 90 jours a cause du cache : s en servir ferait
  // repasser le meme bien a chaque tick, et les autres jamais.
  const { client, vu } = faireBase({ retenus: [RETENU] })
  await releverSiDu({ errors: [] }, {
    supabase: client, client: faireClient(),
    now: () => new Date('2026-10-28T03:00:00Z').getTime(), forcer: true
  })
  const gte = vu.filtres.find(f => f[0] === 'gte')
  assert.ok(gte, 'aucun filtre de mois sur les releves deja faits')
  assert.strictEqual(gte[1], 'created_at',
    `le temoin est « ${gte[1] }» : une capture vieille de 90 jours ferait repasser le meme bien sans fin`)
})

test("LE TEST QUI COMPTE : le marqueur n est PAS pose quand tout a echoue", async () => {
  // Sinon le mois passe pour releve, et il faut attendre le suivant.
  const { client } = faireBase({ retenus: [RETENU] })
  const pannes = {
    estimer: async () => 1.6, marge: async () => 5,
    metriquesAnnonce: async () => { throw new Error('AirROI en panne') },
    calendrierAnnonce: async () => { throw new Error('AirROI en panne') }
  }
  let marque = false
  const r = await releverSiDu({ errors: [] }, {
    supabase: client, client: pannes, forcer: true,
    now: () => new Date('2026-10-28T03:00:00Z').getTime(),
    marqueur: { lire: async () => null, ecrire: async () => { marque = true } }
  })
  assert.strictEqual(r.ecrites, 0)
  assert.strictEqual(marque, false,
    'le mois est declare releve alors que tous les appels ont echoue')
})

test("LE TEST QUI COMPTE : un budget insuffisant REPORTE, il ne releve pas a moitie", async () => {
  // Le plafond par bien (5 $ / 90 jours) est PARTAGE avec l etude de marche.
  // Un refus au milieu de la boucle ecrirait les comparables d avant le refus
  // et marquerait le mois fait : le min/max reposerait sur 2 annonces sur 8.
  const { client, vu } = faireBase({ retenus: [RETENU] })
  let marque = false
  const r = await releverSiDu({ errors: [] }, {
    supabase: client, forcer: true,
    client: { ...faireClient(), estimer: async () => 1.6, marge: async () => 0.2 },
    now: () => new Date('2026-10-28T03:00:00Z').getTime(),
    marqueur: { lire: async () => null, ecrire: async () => { marque = true } }
  })
  assert.strictEqual(r.skipped, 'budget_insuffisant', `le passage a continue : ${JSON.stringify(r)}`)
  assert.strictEqual(vu.upserts.length, 0, 'des lignes ont ete ecrites malgre le refus de budget')
  assert.strictEqual(marque, false, 'le mois est marque releve alors qu il est seulement reporte')
})

test("LE TEST QUI COMPTE : le compte rendu dit ce que la BASE a accepte", async () => {
  // ⚠ AVEC `ignoreDuplicates`, REJOUER UNE PHOTO INSERE ZERO LIGNE. Annoncer
  // `lignes.length` serait un nombre ecrit a la main, qui ne rougit jamais —
  // la famille deja nommee au registre (« une affirmation dans un
  // commentaire »). La base doit avoir le dernier mot.
  //
  // ⚠ ET MA PREMIERE VERSION DE CE TEST NE MORDAIT PAS : elle assertait
  // `ecrites >= 1` et portait du code mort. Un test qui n exerce pas le cas
  // qu il nomme est pire qu absent — il rassure.
  const vu = { upserts: [] }
  const base = {
    from (table) {
      const rep = () => table === 'comparables_retenus'
        ? { data: [RETENU], error: null }
        : { data: [], error: null }
      const q = {
        select () { return q },
        eq () { return q },
        gte () { return q },
        limit () { return Promise.resolve(rep()) },
        upsert (lignes) {
          vu.upserts.push(lignes)
          // La base n accepte RIEN : tout etait deja en place.
          return { select: () => Promise.resolve({ data: [], error: null }) }
        },
        then (r) { return Promise.resolve(rep()).then(r) }
      }
      return q
    }
  }
  const r = await releverSiDu({ errors: [] }, {
    supabase: base, client: faireClient(),
    now: () => new Date('2026-10-28T03:00:00Z').getTime(), forcer: true
  })
  assert.ok(vu.upserts.length === 1 && vu.upserts[0].length > 0,
    'rien n a ete envoye : le test ne demontre rien')
  assert.strictEqual(r.ecrites, 0,
    `le compte rendu annonce ${r.ecrites} lignes ecrites alors que la base n en a accepte aucune`)
})
