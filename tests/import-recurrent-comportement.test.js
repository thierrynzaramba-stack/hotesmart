// tests/import-recurrent-comportement.test.js
// LES TESTS QUI MANQUAIENT — ecrits AVANT les correctifs, et rouges sur le code
// actuel. C'est la condition posee par Thierry : « corrige ses 4 bloquants un
// par un, contre-epreuves ».
//
// La review du lot 3 a desarme trois gardes reelles et la suite entiere est
// restee VERTE : mes onze tests etaient des `readFileSync` + `includes`, alors
// que les deux unites sont explicitement concues pour etre pilotees
// (`echeance`, `depuis`, `avantEcriture`, `supabase` injectes). Ici on les
// PILOTE.

process.env.TZ = 'Europe/Paris'
process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = 'test-key'
process.env.CHANNEL_BASE_URL = 'http://localhost:9/api/v1'
process.env.CHANNEL_API_KEY = 'k'

const test = require('node:test')
const assert = require('node:assert')

// `recordMessage` neutralise : on mesure le PILOTAGE, pas l'ecriture.
const cheminRecord = require.resolve('../lib/record-message')
let ecritures = 0
require.cache[cheminRecord] = {
  id: cheminRecord, filename: cheminRecord, loaded: true,
  exports: { recordMessage: async () => {
    ecritures++
    // ⚠ CHAQUE ECRITURE COUTE DU TEMPS. C'est la ou il part reellement :
    // ~3 aller-retours Supabase par message. Sans ca, aucun test ne peut faire
    // expirer un budget A L'INTERIEUR d'un lot de messages — precisement la
    // garde qui manquait, et qui a tue le cron dedie en production.
    if (global.__coutEcriture) global.__coutEcriture()
    return { ok: true }
  } }
}

const { importMessages } = require('../lib/channels/channex')

// ─── Un faux Channex, pilote par `fetch` ────────────────────────────────────
let appels = 0
function poserProvider ({ pagesDeFils = 1, filsParPage = 1, pagesDeMessages = 1,
                         updatedAt = '2026-09-14T10:00:00', msParAppel = 0,
                         avancer = null, messagesParPage = 100 }) {
  appels = 0
  global.fetch = async (url) => {
    appels++
    // ⚠ HORLOGE PILOTEE : chaque appel coute un pas EXACT, sans attendre
    // reellement. C'est ce qui rend la coupure du budget reproductible.
    if (avancer) avancer()
    // ⚠ CHAQUE APPEL COUTE DU TEMPS REEL. Sans ca, un faux provider instantane
    // ne peut JAMAIS faire expirer un budget mur pendant une passe : le
    // controle entre deux fils suffirait a tout arreter, et le test passerait
    // sans jamais atteindre la pagination des messages — celle qui n'est pas
    // gardee. C'est le piege qui a rendu ma premiere version de ce test verte.
    if (msParAppel) await new Promise(r => setTimeout(r, msParAppel))
    const u = String(url)
    if (u.includes('/message_threads?')) {
      const page = Number((u.match(/pagination\[page\]=(\d+)/) || [])[1] || 1)
      const data = page > pagesDeFils ? [] : Array.from({ length: filsParPage }, (_, i) => ({
        id: `fil-${page}-${i}`,
        attributes: { provider: 'Airbnb', updated_at: updatedAt, message_count: 3 },
        relationships: { booking: { data: { id: `resa-${page}-${i}` } } }
      }))
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data, meta: { limit: filsParPage } }) }
    }
    // messages d'un fil
    const page = Number((u.match(/pagination\[page\]=(\d+)/) || [])[1] || 1)
    const data = page > pagesDeMessages ? [] : Array.from({ length: messagesParPage }, (_, i) => ({
      id: `msg-${page}-${i}`,
      attributes: { sender: i % 2 ? 'guest' : 'property', message: 'texte', inserted_at: '2026-09-14T09:00:00' }
    }))
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data, meta: { limit: messagesParPage } }) }
  }
}

test('LE BLOQUANT 1 : le budget mur est consulte DANS la pagination des messages', async () => {
  // ⚠ MESURE DE LA REVIEW : echeance a +30 ms sur un fil de 6000 messages ->
  // 362 ms, 62 appels, et la passe se declarait COMPLETE. Avec le vrai Supabase
  // (~3 aller-retours par message), plusieurs MINUTES. Le cycle est deja a
  // 40-56 s pour un plafond de 60 : ce qui saute, c'est tout ce qui suit —
  // y compris le heartbeat `cron_logs`, donc la surveillance devient aveugle.
  // Le budget est VIVANT quand on entre dans le fil, et expire pendant la
  // pagination de ses messages : c'est le seul chemin qui prouve la garde
  // interne.
  poserProvider({ pagesDeFils: 1, filsParPage: 1, pagesDeMessages: 60, msParAppel: 3 })
  ecritures = 0
  const r = await importMessages({
    userId: 'u', propertyId: 'p',
    echeance: Date.now() + 15   // vivant a l'entree, mort au bout de ~5 appels
  })
  assert.equal(r.interrompu, 'budget', 'la passe se DECLARE interrompue')
  assert.ok(appels < 20, `elle s arrete dans le fil, sans lire ses 60 pages (${appels} appels)`)
  assert.ok(ecritures < 1500, `et n ecrit pas les 6000 messages (${ecritures})`)
})

test('LE BLOQUANT 2 : le budget est consulte meme quand tous les fils sont IGNORES', async () => {
  // Le `continue` de la selection incrementale sautait AVANT le controle de
  // budget, et `if (interrompu) break` ne pouvait donc jamais etre vrai.
  // Mesure de la review : 40 pages de fils, 41 appels, aucune interruption.
  poserProvider({ pagesDeFils: 40, filsParPage: 100, pagesDeMessages: 1, updatedAt: '2026-01-01T00:00:00' })
  const r = await importMessages({
    userId: 'u', propertyId: 'p',
    depuis: '2026-09-01T00:00:00Z',   // tous les fils sont anterieurs
    echeance: Date.now() - 1
  })
  assert.equal(r.interrompu, 'budget', 'la passe se declare interrompue')
  assert.ok(appels <= 3, `elle ne parcourt pas les 40 pages (${appels} appels)`)
})

test('LE BLOQUANT 1 bis : une passe INTERROMPUE ne rend pas de marqueur', async () => {
  // Sinon les fils sautes par le budget seraient perdus DEFINITIVEMENT.
  poserProvider({ pagesDeFils: 1, filsParPage: 1, pagesDeMessages: 60, msParAppel: 3 })
  const r = await importMessages({ userId: 'u', propertyId: 'p', echeance: Date.now() + 15 })
  assert.equal(r.jusqua, null, 'aucun marqueur : la passe n a pas tout vu')
})

test('LA MUTATION RESTEE VERTE : une passe COMPLETE rend bien un marqueur', async () => {
  // La contre-epreuve `depuis: r.jusqua -> null` laissait la suite verte : le
  // marqueur etait detruit a chaque passe, donc import complet perpetuel.
  poserProvider({ pagesDeFils: 1, filsParPage: 1, pagesDeMessages: 1, updatedAt: '2026-09-14T10:00:00' })
  const r = await importMessages({ userId: 'u', propertyId: 'p', echeance: Date.now() + 60000 })
  assert.equal(r.interrompu, null, 'la passe va au bout')
  assert.ok(r.jusqua, 'et elle rend un marqueur')
  assert.equal(new Date(r.jusqua).toISOString(), '2026-09-14T10:00:00.000Z',
    'qui est l instant du fil le plus recent, lu en UTC')
})

test('LE FIL INCOMPLET : une erreur en cours de pagination n avance PAS le marqueur', async () => {
  // ⚠ RELEVE EN REVIEW. `if (!mr.ok) break` sortait de la boucle interne : le
  // fil etait compte comme lu, son instant entrait dans le marqueur, et la passe
  // se declarait COMPLETE. Un 500 sur la page 2 — apres les quatre reessais de
  // `channelCall` — et les 100 messages suivants, dont la reponse de l'hote,
  // n'entraient JAMAIS dans le coeur et n'auraient PLUS JAMAIS ete relus. Seule
  // trace : un `console.error`. C'est exactement la perte definitive que le
  // marqueur existe pour empecher.
  appels = 0
  global.fetch = async (url) => {
    appels++
    const u = String(url)
    if (u.includes('/message_threads?')) {
      const page = Number((u.match(/pagination\[page\]=(\d+)/) || [])[1] || 1)
      const data = page > 1 ? [] : [{
        id: 'fil-1',
        attributes: { provider: 'Airbnb', updated_at: '2026-09-14T10:00:00', message_count: 200 },
        relationships: { booking: { data: { id: 'resa-1' } } }
      }]
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data, meta: { limit: 1 } }) }
    }
    const page = Number((u.match(/pagination\[page\]=(\d+)/) || [])[1] || 1)
    // La page 2 tombe : le fil est LU A MOITIE.
    if (page === 2) return { ok: false, status: 500, headers: { get: () => null }, text: async () => '{}' }
    const data = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${page}-${i}`,
      attributes: { sender: 'guest', message: 'texte', inserted_at: '2026-09-14T09:00:00' }
    }))
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data, meta: { limit: 100 } }) }
  }

  const r = await importMessages({ userId: 'u', propertyId: 'p', echeance: Date.now() + 60000 })
  assert.equal(r.jusqua, null,
    'aucun marqueur : le fil n a pas ete vu en entier, il doit etre relu au cycle suivant')
  assert.equal(r.interrompu, 'fil_incomplet', 'et la passe DIT pourquoi elle est incomplete')
})

test('L ANNONCE PREALABLE tombe AVANT la premiere ecriture', async () => {
  poserProvider({ pagesDeFils: 1, filsParPage: 40, pagesDeMessages: 1 })
  ecritures = 0
  let ecrituresAuMomentDeLAnnonce = null
  await importMessages({
    userId: 'u', propertyId: 'p', echeance: Date.now() + 60000,
    avantEcriture: async () => { ecrituresAuMomentDeLAnnonce = ecritures }
  })
  assert.equal(ecrituresAuMomentDeLAnnonce, 0,
    'aucune ligne ecrite quand l annonce part — sinon elle explique une croissance deja faite')
  assert.ok(ecritures > 0, 'et l import a bien ecrit ensuite')
})

// ─── L'ORCHESTRATEUR : marqueur, abstention, incident ───────────────────────

const cheminNotify = require.resolve('../lib/founder-notify')
const incidents = []
require.cache[cheminNotify] = {
  id: cheminNotify, filename: cheminNotify, loaded: true,
  exports: { reportIncident: async (type, o) => { incidents.push({ type, ...o }); return true } }
}
const { importerMessagesDuBien } = require('../lib/cron-channel-messages-sync')

// Faux Supabase borne a `cron_logs`, avec panne de lecture a la demande.
function fauxCronLogs ({ etat = null, lectureEnEchec = false } = {}) {
  const journal = { upserts: [] }
  const api = {
    from () {
      // ⚠ LE DOUBLE PROJETTE LES COLONNES, COMME POSTGREST — ET SON ABSENCE DE
      // PROJECTION A LAISSE PASSER LE DEFAUT CENTRAL DE CE LOT. Il rendait
      // l'objet ENTIER quel que soit le `select`, donc le code pouvait lire
      // `data.errors` sans jamais l'avoir demande : en production la colonne
      // n'arrivait pas, le point de reprise n'etait jamais relu, et le correctif
      // etait inerte. Un double plus riche que la vraie table (REVIEW.md
      // regle 8), dans sa forme la plus cher payee.
      let colonnes = null
      const q = {
        select: (cols) => {
          colonnes = String(cols || '').split(',').map(c => c.trim()).filter(Boolean)
          return q
        },
        eq: () => q,
        maybeSingle: async () => {
          if (lectureEnEchec) return { data: null, error: { message: 'Gateway Timeout' } }
          if (!etat) return { data: null, error: null }
          if (!colonnes || !colonnes.length) return { data: etat, error: null }
          const projete = {}
          for (const c of colonnes) if (c in etat) projete[c] = etat[c]
          return { data: projete, error: null }
        },
        upsert: async (row) => { journal.upserts.push(row); return { error: null } }
      }
      return q
    }
  }
  return { api, journal }
}

const BIEN = { user_id: 'hote-A', provider_property_id: 'p1', name: 'Le 23' }

test('LE BLOQUANT 3 : un etat ILLISIBLE n ECRASE PAS le marqueur', async () => {
  // ⚠ Le commentaire du module dit exactement ce qu'il ne faut pas faire
  // — « retomber sur `null` relancerait un import COMPLET » — et le code le
  // faisait, en pire : il le PERSISTAIT. `sAbstenir` recevait un etat force a
  // `{ depuis: null }` et l'upsert ecrivait `last_run: null`. Un timeout de
  // pooler d'UNE SECONDE suffisait a effacer le marqueur ; le cycle suivant
  // repartait d'un import complet du bien, avec l'alerte de croissance en prime.
  const { api, journal } = fauxCronLogs({ lectureEnEchec: true })
  const r = await importerMessagesDuBien(api, BIEN, { echeance: Date.now() + 5000, results: {} })

  assert.equal(r.abstenu, true, 'on s abstient')
  const ecrase = journal.upserts.find(u => u.last_run === null)
  assert.ok(!ecrase, 'AUCUNE ecriture ne met le marqueur a null')
})

test('LE BLOQUANT 3 bis : l abstention s ACCUMULE, et l incident finit par partir', async () => {
  // `etat.abstentions` etait code en dur a 0 sur le chemin « illisible » : le
  // compteur restait a 1 indefiniment, et `messages_import_suspendu`
  // (declenche a === 3) ne pouvait JAMAIS partir sur ce motif. L'etat le plus
  // silencieux etait celui qui ne s'annoncait pas.
  incidents.length = 0
  let abstentions = 0
  for (let cycle = 1; cycle <= 3; cycle++) {
    // L'etat lu reflete ce que les cycles precedents ont ecrit.
    const { api, journal } = fauxCronLogs({ etat: { last_run: '2026-09-01T00:00:00Z', total_messages: abstentions }, lectureEnEchec: false })
    // Cycle en retard : abstention volontaire, chemin nomme.
    await importerMessagesDuBien(api, BIEN, { echeance: Date.now() - 1, results: {} })
    const u = journal.upserts[journal.upserts.length - 1]
    assert.ok(u, `cycle ${cycle} : un etat est ecrit`)
    assert.equal(u.last_run, '2026-09-01T00:00:00Z', `cycle ${cycle} : le marqueur est CONSERVE`)
    abstentions = u.total_messages
    assert.equal(abstentions, cycle, `cycle ${cycle} : le compte d abstentions suit`)
  }
  assert.equal(incidents.length, 1, 'a la troisieme, l incident part — une fois, pas a chaque cycle')
  assert.equal(incidents[0].type, 'messages_import_suspendu')
})

const { ordonnerPourImport } = require('../lib/cron-channel-messages-sync')

test('LE BLOQUANT 4 : le plus ANCIENNEMENT importe passe en premier', async () => {
  // ⚠ L'echeance etait posee AVANT la boucle par bien, donc elle mesurait le
  // CYCLE, pas l'import : templates, classification, `fetchChannelBookings` et
  // codes Seam la consommaient, et des le 2e ou 3e bien `reste <
  // RELIQUAT_MINIMAL_MS` -> abstention `cycle_en_retard` a CHAQUE cycle. Au 3e,
  // un incident partait ; ensuite plus rien, et les messages des derniers biens
  // de la liste n'etaient JAMAIS importes. L'ordre de `props` n'etant pas
  // garanti par le SELECT, ce n'etaient meme pas toujours les memes.
  //
  // Deux correctifs : une echeance propre a la PHASE d'import (structurel), et
  // un ordre EQUITABLE — celui qu'on a le moins servi passe devant.
  const etats = [
    { id: 'messages_import:hote-A:recent', last_run: '2026-09-14T10:00:00Z' },
    { id: 'messages_import:hote-A:vieux',  last_run: '2026-09-01T00:00:00Z' }
    // `jamais` n'a aucune ligne : il n'a jamais ete importe.
  ]
  const api = { from () {
    const q = { select: () => q, in: () => q, then: (r) => Promise.resolve({ data: etats, error: null }).then(r) }
    return q
  } }
  const biens = [
    { user_id: 'hote-A', provider_property_id: 'recent' },
    { user_id: 'hote-A', provider_property_id: 'jamais' },
    { user_id: 'hote-A', provider_property_id: 'vieux' }
  ]
  const ordre = (await ordonnerPourImport(api, biens)).map(b => b.provider_property_id)
  assert.deepEqual(ordre, ['jamais', 'vieux', 'recent'],
    'jamais importe d abord, puis le plus ancien : si le budget manque, ce sont toujours '
    + 'les mieux servis qui sautent, jamais les memes oublies')
})

test('LE BLOQUANT 4 bis : une lecture des marqueurs en echec ne change pas l ordre', async () => {
  // Retomber sur un ordre arbitraire reintroduirait l inequite que ce tri
  // existe pour supprimer — et silencieusement.
  const api = { from () {
    const q = { select: () => q, in: () => q, then: (r) => Promise.resolve({ data: null, error: { message: 'Gateway Timeout' } }).then(r) }
    return q
  } }
  const biens = [{ user_id: 'u', provider_property_id: 'a' }, { user_id: 'u', provider_property_id: 'b' }]
  const ordre = (await ordonnerPourImport(api, biens)).map(b => b.provider_property_id)
  assert.deepEqual(ordre, ['a', 'b'], 'l ordre d origine est conserve, sans invention')
})

// ─── LE BLOCAGE DU 15 SEPTEMBRE 2026, ET SA SORTIE ──────────────────────────
//
// ⚠ CE QUI S'EST PASSE EN PRODUCTION. Quatre biens, marqueur d'anteriorite a
// `null`, 125 abstentions D'AFFILEE, et l'annonce d'ecriture de masse repartie a
// chaque cycle avec exactement le meme compte (« ~56 messages sur 1 fil »).
// La cause : le marqueur n'avance que sur une passe COMPLETE, et un fil plus
// long que le budget de 2,5 s ne peut jamais l'etre. Chaque cycle recommencait
// le fil depuis sa page 1. L'import n'avancait pas d'une ligne, et la seule
// alarme qui le disait s'etait tue au 3e cycle.
//
// ⚠ CE TEST PILOTE LE VRAI `importMessages`, il ne lit pas le source : c'est le
// COMPORTEMENT sur plusieurs cycles qui est en cause, pas la presence d'une
// ligne de code.
//
// ⚠ ET IL PILOTE AUSSI L'HORLOGE. Une premiere version mesurait un budget MUR
// avec de vrais `setTimeout` : elle passait seule et rougissait une fois sur
// trois dans la suite complete, ou les fichiers tournent en parallele et ou
// quelques millisecondes de gigue deplacent la coupure. Un test instable
// deviendrait un rouge de plus qu'on apprend a ignorer — la dette qu'on passe
// deja son temps a compter. `Date.now` est donc remplace : chaque appel au
// provider avance l'horloge d'un pas EXACT, et la coupure tombe toujours au
// meme endroit, quelle que soit la charge de la machine.

function avecHorlogePilotee (pasParAppel, corps) {
  const vraiNow = Date.now
  let horloge = 1000000
  Date.now = () => horloge
  const avancer = () => { horloge += pasParAppel }
  return Promise.resolve(corps(avancer)).finally(() => { Date.now = vraiNow })
}

test('un fil plus long que le budget FINIT par entrer, cycle apres cycle', async () => {
  // Un seul fil, six pages de messages, et un budget qui n'en laisse passer que
  // deux ou trois par cycle : sans reprise, on resterait sur la page 1 a vie.
  // ⚠ MARGES LARGES, ET C'EST DELIBERE. Ce test pilote un budget MUR : sur une
  // suite qui tourne en parallele, quelques millisecondes de gigue suffisent a
  // deplacer la coupure. Un test instable deviendrait un rouge de plus qu'on
  // apprend a ignorer — la dette qu'on passe deja son temps a compter. On rend
  // donc chaque appel franchement couteux devant le budget, et on laisse assez
  // de cycles pour que le resultat ne depende pas de l'endroit exact de la
  // coupure.
  const CYCLES = 30
  let reprise = null
  let annonces = 0
  let abouti = false
  let interruptions = 0

  await avecHorlogePilotee(25, async (avancer) => {
    for (let c = 0; c < CYCLES && !abouti; c++) {
      poserProvider({ pagesDeFils: 1, filsParPage: 1, pagesDeMessages: 6, avancer })
      const r = await importMessages({
        userId: 'u', propertyId: 'p', depuis: null, reprise,
        echeance: Date.now() + 110,
        avantEcriture: async () => { annonces++ }
      })
      reprise = r.reprise || reprise
      if (r.interrompu) interruptions++
      else abouti = true
    }
  })

  // ⚠ LE TEST NE PROUVE RIEN SI RIEN N'A ETE COUPE. Sans interruption, le
  // budget aura suffi d'un coup et la reprise n'aura jamais servi.
  assert.ok(interruptions >= 1, 'le budget doit bien couper au moins une passe')
  assert.ok(abouti, `l'import doit aboutir en ${CYCLES} cycles — il est resté bloqué`)
  // ⚠ ET L'ANNONCE NE PART QU'UNE FOIS : c'est le meme lot qu'on continue.
  assert.strictEqual(annonces, 1,
    `l'ecriture de masse s'annonce au debut, pas a chaque cycle (${annonces} annonces)`)
})

test('CONTRE-EPREUVE : sans point de reprise, on reste sur la meme page a vie', async () => {
  // ⚠ Sans cette contre-epreuve, le test ci-dessus passerait aussi sur le code
  // fautif le jour ou le budget suffirait par accident. On rejoue ici le
  // comportement d'avant — `reprise` jamais transmise — et on verifie qu'il ne
  // sort PAS du premier fil.
  const pages = []
  await avecHorlogePilotee(25, async (avancer) => {
    for (let c = 0; c < 5; c++) {
      poserProvider({ pagesDeFils: 1, filsParPage: 1, pagesDeMessages: 6, avancer })
      const r = await importMessages({
        userId: 'u', propertyId: 'p', depuis: null, reprise: null,   // <- le defaut
        echeance: Date.now() + 110
      })
      assert.ok(r.interrompu, 'la passe est bien tronquee')
      pages.push(r.reprise ? r.reprise.page : null)
    }
  })
  assert.strictEqual(pages.length, 5, 'les cinq passes sont tronquees')
  // ⚠ `new Set([null,null,…]).size === 1` EST AUSSI VRAI, et la contre-epreuve
  // restait donc VERTE sans le correctif — satisfaite par son absence. On exige
  // d'abord qu'un point EXISTE, puis qu'il ne bouge pas.
  assert.ok(pages[0] != null, 'un point de reprise est bien produit')
  assert.ok(pages.every(p => p != null && p === pages[0]),
    `sans reprise transmise, chaque cycle repart au meme point : ${pages.join(',')}`)
  assert.strictEqual(new Set(pages).size, 1,
    `sans reprise, chaque cycle repart au meme point : ${pages.join(',')}`)
})

test('la reprise ne s\'applique QU\'AU fil quittee', async () => {
  // ⚠ L'appliquer a un autre fil sauterait ses premieres pages — la perte
  // definitive que le marqueur existe pour empecher.
  poserProvider({ pagesDeFils: 1, filsParPage: 2, pagesDeMessages: 2, msParAppel: 1 })
  const r = await importMessages({
    userId: 'u', propertyId: 'p', depuis: null,
    reprise: { fil: 'un-fil-qui-n-est-pas-la', page: 5 },
    echeance: Date.now() + 5000
  })
  assert.ok(!r.interrompu, 'la passe va au bout')
  assert.strictEqual(r.reprise, null, 'et le point de reprise est effacé')
  // Les deux fils ont ete lus en entier : aucune page sautee.
  assert.strictEqual(r.fils.lus, 2)
})

test('LE TEST QUI MANQUAIT : le point de reprise fait un ALLER-RETOUR par la base', async () => {
  // ⚠ SANS CE TEST, LE CORRECTIF ETAIT INERTE ET LA SUITE VERTE. La persistance
  // n'etait couverte que par un grep de source (`reprise: reprise || etat.reprise`)
  // — une assertion que le defaut satisfaisait pleinement, puisqu'il portait sur
  // le `select`, pas sur cette ligne. Les tests de comportement, eux, se
  // passaient la reprise DE LA MAIN A LA MAIN entre deux appels. Personne ne
  // relisait jamais ce qui avait ete ecrit.
  const { api, journal } = fauxCronLogs({
    etat: { last_run: null, total_messages: 4,
            errors: [{ fil: 'fil-X', page: 4, count: 56, motif: 'budget' }] }
  })
  let recu = null
  poserProvider({ pagesDeFils: 1, filsParPage: 1, pagesDeMessages: 1 })
  const vraiFetch = global.fetch
  global.fetch = async (url) => vraiFetch(url)

  const { importerMessagesDuBien } = require('../lib/cron-channel-messages-sync')
  const { getProvider } = require('../lib/channels')
  const vrai = getProvider('channex').importMessages
  getProvider('channex').importMessages = async (ctx) => { recu = ctx; return { imported: 0 } }
  try {
    await importerMessagesDuBien(api, { bien: BIEN, results: {}, echeance: Date.now() + 60000 })
  } finally {
    getProvider('channex').importMessages = vrai
  }

  assert.ok(recu, 'le provider est bien appele')
  assert.deepStrictEqual(recu.reprise, { fil: 'fil-X', page: 4, count: 56 },
    'le point de reprise ECRIT au cycle precedent doit etre RELU et transmis, `count` compris')
  assert.ok(journal.upserts.length >= 0)
})

test('LE BUDGET BORNE AUSSI L INTERIEUR D UNE PAGE', async () => {
  // ⚠ MESURE EN REEL LE 16 SEPTEMBRE 2026 : le cron dedie est mort en
  // `FUNCTION_INVOCATION_TIMEOUT` a 60 s. Le budget n'etait consulte qu'ENTRE
  // deux pages — or une page de 100 messages, c'est ~300 aller-retours Supabase
  // sans un seul controle. Une fonction qui meurt ne rend pas son bilan ET
  // n'ecrit pas l'etat du bien en cours : la passe ne laisse AUCUNE trace, et le
  // cycle suivant recommence. Une garde entre les pages ne borne rien quand le
  // travail est DANS la page.
  //
  // ⚠ Le compteur d'ecritures est celui du double de `recordMessage`, en haut de
  // ce fichier : c'est lui qui mesure le travail REELLEMENT fait.
  const avant = ecritures
  const vraiNow = Date.now
  let horloge = 1000000
  Date.now = () => horloge
  global.__coutEcriture = () => { horloge += 10 }   // 10 ms par message ecrit
  try {
    poserProvider({ pagesDeFils: 1, filsParPage: 1, pagesDeMessages: 1, messagesParPage: 40 })
    const r = await importMessages({
      userId: 'u', propertyId: 'p', depuis: null,
      echeance: Date.now() + 100          // dix messages, puis la coupure
    })
    assert.ok(r.interrompu, 'la passe est tronquee')
    assert.ok(r.reprise && r.reprise.page === 1,
      'et la reprise designe LA MEME page : les deja-ecrits sont dedupliques')
  } finally {
    Date.now = vraiNow
    global.__coutEcriture = null
  }
  const faites = ecritures - avant
  assert.ok(faites > 0 && faites < 40,
    `le lot doit etre coupe EN COURS : ${faites} ecritures sur 40`)
})
