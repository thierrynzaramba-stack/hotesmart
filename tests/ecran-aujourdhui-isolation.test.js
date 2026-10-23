// tests/ecran-aujourdhui-isolation.test.js
//
// L'ISOLATION ENTRE COMPTES DE `/api/ecran/aujourdhui` — lot (b) du chantier
// performance. DOC : docs/specs/spec-performance-pages.md
//
// ⚠ POURQUOI UN FICHIER ENTIER POUR UN SEUL ENDPOINT. Celui-ci regroupe DIX
// lectures qui etaient dans cinq endpoints distincts, chacun avec sa garde.
// Les dix fuites du chantier profils et droits sont toutes nees de cette
// famille : une lecture qui oublie son perimetre, dans un fichier ou les neuf
// autres l'appliquent. Un oubli y est invisible a la lecture — le bloc
// ressemble a ses voisins — et invisible a l'ecran : l'hote ne voit pas qu'un
// compteur porte les biens d'un autre.
//
// ⚠ ET LA CLE DE SERVICE CONTOURNE LA RLS. C'est le fait qui rend ce fichier
// necessaire : en base, `properties` et ses enfants sont proteges par 28
// policies, mais cet endpoint lit avec `SUPABASE_SERVICE_KEY`, donc AUCUNE ne
// s'applique. Le seul cloisonnement est celui qu'on ecrit ici, en JavaScript.
//
// Ce que ce fichier eprouve, et dans cet ordre :
//   1. le titulaire : aucun filtre de perimetre, et le compte est celui de la
//      garde — jamais celui que la requete demande ;
//   2. le membre restreint : TOUTE lecture bornee, aucune exception ;
//   3. le perimetre VIDE (`[]`) : un ecran vide, jamais l'ecran complet ;
//   4. un droit refuse : la table n'est pas meme interrogee ;
//   5. la reponse : zero reference hors perimetre, passee au tamis.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')

const TITULAIRE = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const MEMBRE    = '18920ead-f936-4e26-b62e-9a5f52b5e657'
// La bulle : le bien du membre restreint, sous ses DEUX formes de cle.
const BULLE_UUID = '091d9abf-ff86-45ce-8123-3425e6f3900f'
const BULLE_REF  = '209413'
// Et le bien d'a cote, celui qu'il ne doit jamais voir, sous ses deux formes.
const AUTRE_UUID = 'cccccccc-1111-4222-8333-444444444444'
const AUTRE_REF  = '11111'

const TOUS_DOMAINES = ['reservations', 'menages', 'messages', 'avis', 'reglages']

// ⚠ LE BANC APPLIQUE LES FILTRES, ET C'EST LE POINT DE TOUT CE FICHIER.
// Un double qui rend ses lignes sans regarder les filtres ne peut prouver
// qu'une chose : que le filtre a ete ECRIT. Il ne dit pas qu'il est EFFECTIF —
// une borne sur la mauvaise colonne, une valeur en UUID la ou la colonne est en
// TEXT, un `.in` sur une liste vide traitee comme « tous » : tout cela passe
// une lecture de code et passe un test de presence. Ici la base fausse se
// comporte comme la vraie, donc une borne absente ou fausse se lit dans la
// REPONSE, la ou l'hote la verrait.
// Le `user_id` manquant d'une ligne de fixture vaut celui du titulaire : les
// fixtures decrivent le contenu du compte, et c'est le cas courant.
const valeur = (ligne, colonne) => {
  const m = String(colonne).match(/^([a-z_]+)->>([a-z_]+)$/)
  if (m) return (ligne[m[1]] || {})[m[2]]
  return ligne[colonne]
}
function tient (ligne, f) {
  const [op, colonne] = f
  const v = valeur(ligne, colonne)
  if (op === 'eq')  return String(v) === f[2]
  if (op === 'neq') return String(v) !== f[2]
  if (op === 'in')  return f[2].includes(String(v))
  if (op === 'is')  return f[2] === null ? (v === null || v === undefined) : v === f[2]
  if (op === 'not') return f[2] === 'is' && f[3] === null ? (v !== null && v !== undefined) : true
  if (op === 'gte') return String(v) >= f[2]
  if (op === 'lte') return String(v) <= f[2]
  return true
}

// ─── Le banc ──────────────────────────────────────────────────────────────────
//
// Il remplace TROIS choses, et pas une de plus :
//   · `createClient` du SDK, pour enregistrer chaque requete et ses filtres ;
//   · `contexteDEcran`, la garde — ce fichier ne teste pas la garde (c'est
//     `tests/contexte-ecran.test.js` qui le fait), il teste ce que l'endpoint
//     fait du contexte qu'elle rend ;
//   · `notesDuPerimetre` et `etatMenage`, deux lectures d'autres modules, pour
//     observer les REFS qu'elles recoivent.
//
// ⚠ ET LE BANC NE DOUBLE PAS `lib/ecran/etat-du-code`. C'est lui qui lit
// `access_codes`, la table dont les lignes sont souvent SANS compte (bloquant
// (d) de CLAUDE.md : 50 des 65 codes de La bulle n'ont pas de `user_id`) : son
// cloisonnement passe donc par le couple `property_id` + `booking_id`, et c'est
// precisement ce qu'on veut voir partir en requete.
function banc ({ refs = null, domaines = TOUS_DOMAINES, titulaire = false,
                 methode = 'GET', lignes = {}, pannes = [] } = {}) {
  const requetes = []
  const notesVues = []
  const client = {
    from (table) {
      const r = { table, filtres: [], select: null, options: null }
      requetes.push(r)
      const q = {
        select (cols, opts) { r.select = cols; r.options = opts || null; return q },
        eq (c, v)  { r.filtres.push(['eq', c, String(v)]); return q },
        neq (c, v) { r.filtres.push(['neq', c, String(v)]); return q },
        in (c, v)  { r.filtres.push(['in', c, (v || []).map(String)]); return q },
        is (c, v)  { r.filtres.push(['is', c, v]); return q },
        not (c, o, v) { r.filtres.push(['not', c, o, v]); return q },
        gte (c, v) { r.filtres.push(['gte', c, String(v)]); return q },
        lte (c, v) { r.filtres.push(['lte', c, String(v)]); return q },
        order () { return q },
        limit (n) { r.limite = n; return q },
        then (ok, ko) {
          if (pannes.includes(table)) {
            return Promise.resolve({ data: null, count: null, error: { message: `panne ${table}` } })
              .then(ok, ko)
          }
          const gardees = (lignes[table] || [])
            .map(l => (l.user_id === undefined ? { ...l, user_id: TITULAIRE } : l))
            .filter(l => r.filtres.every(f => tient(l, f)))
          return Promise.resolve({ data: gardees, count: gardees.length, error: null })
            .then(ok, ko)
        }
      }
      return q
    }
  }

  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client

  // ⚠ LA GARDE EST DOUBLEE EN ENTIER, SINON LE CONTEXTE SERAIT CELUI DU VRAI
  // MODULE. Et elle rend la MEME forme que la vraie : `{ ok, accountUserId,
  // contexte }` — verifiee contre `lib/require-permission.js`.
  const absGarde = require.resolve('../lib/require-permission')
  const vraieGarde = require.cache[absGarde] ? require.cache[absGarde].exports : null
  const permissions = refs === null && !titulaire
    ? { property_scope: 'all', property_ids: [], property_refs: [] }
    : { property_scope: 'selected',
        property_ids: (refs || []).filter(x => x.includes('-')),
        property_refs: (refs || []).filter(x => !x.includes('-')) }
  for (const d of TOUS_DOMAINES) permissions[d] = domaines.includes(d) ? 'read' : 'none'
  const contexte = titulaire
    ? { userId: TITULAIRE, accountUserId: TITULAIRE, profil: null, permissions: null }
    : { userId: MEMBRE,
        accountUserId: TITULAIRE,
        profil: { active: true, accepted_at: '2026-01-01', member_user_id: MEMBRE,
                  account_user_id: TITULAIRE },
        permissions }
  require('../lib/require-permission')
  require.cache[absGarde].exports = Object.assign({}, vraieGarde, {
    contexteDEcran: async () => ({
      ok: true, userId: contexte.userId, accountUserId: TITULAIRE, contexte
    })
  })

  const absNotes = require.resolve('../lib/stats-avis')
  require('../lib/stats-avis')
  const vraiNotes = require.cache[absNotes].exports
  require.cache[absNotes].exports = Object.assign({}, vraiNotes, {
    notesDuPerimetre: async (sb, opts) => {
      notesVues.push(opts)
      return { global: { note_sur_5: 4.7, notes: 42 }, par_bien: {}, periode: '30j' }
    }
  })

  const absMenage = require.resolve('../lib/cron-arrival-code')
  require('../lib/cron-arrival-code')
  const vraiMenage = require.cache[absMenage].exports
  require.cache[absMenage].exports = Object.assign({}, vraiMenage,
    { etatMenage: async () => 'fait' })

  delete require.cache[require.resolve('../api/ecran/aujourdhui')]
  const handler = require('../api/ecran/aujourdhui')

  const res = { codes: [], corps: null, entetes: {},
    setHeader (k, v) { this.entetes[String(k).toLowerCase()] = v },
    status (c) { this.codes.push(c); return this },
    json (o) { this.corps = o; return this } }

  const rendre = async () => {
    try {
      await handler({ method: methode, headers: {}, query: {} }, res)
    } finally {
      require.cache[absSdk].exports.createClient = vraiCreate
      if (vraieGarde) require.cache[absGarde].exports = vraieGarde
      require.cache[absNotes].exports = vraiNotes
      require.cache[absMenage].exports = vraiMenage
      delete require.cache[require.resolve('../api/ecran/aujourdhui')]
    }
    return { res, requetes, notesVues, corps: res.corps }
  }
  return rendre
}

// Les filtres `.in` qui bornent un bien, par requete.
const bornes = (r) => r.filtres.filter(f => f[0] === 'in'
  && ['id', 'property_id', 'property_id_ref'].includes(f[1]))

// ─── 1. LE TITULAIRE ──────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : le compte lu est celui de la GARDE, jamais celui de la requete', async () => {
  // Une fuite d'une ligne : `req.query.compte` au lieu de `garde.accountUserId`.
  // C'est la forme exacte de plusieurs des dix fuites du chantier droits.
  const { requetes } = await banc({ titulaire: true })()
  const sansCompte = requetes.filter(r =>
    r.table !== 'access_codes' && !r.filtres.some(f => f[0] === 'eq' && f[1] === 'user_id'))
  assert.deepEqual(sansCompte.map(r => r.table), [],
    'une lecture part SANS `user_id` : avec la cle de service, elle lit toute la base')
  const mauvais = requetes.filter(r =>
    r.filtres.some(f => f[0] === 'eq' && f[1] === 'user_id' && f[2] !== TITULAIRE))
  assert.deepEqual(mauvais.map(r => r.table), [], 'une lecture porte un autre compte')
})

test('le titulaire n est borne par aucun perimetre, et les notes le savent', async () => {
  const { requetes, notesVues } = await banc({ titulaire: true })()
  for (const r of requetes) {
    assert.deepEqual(bornes(r), [],
      `${r.table} est borne alors que le titulaire voit tout son compte`)
  }
  assert.strictEqual(notesVues.length, 1)
  assert.strictEqual(notesVues[0].refs, null, 'les notes du titulaire sont bornees a tort')
})

// ─── 2. LE MEMBRE RESTREINT ───────────────────────────────────────────────────

test('LE TEST QUI COMPTE : CHAQUE lecture du membre restreint est bornee a ses biens', async () => {
  // ⚠ L'ASSERTION EST « TOUTES », PAS « CELLES QUE J'AI PENSE A CITER ».
  // Une liste nominative de tables vieillit mal : le bloc ajoute demain n'y
  // serait pas, et le test resterait vert en laissant fuiter la nouvelle
  // lecture. On exige donc que toute requete sur une table a bien porte sa
  // borne, et on ne nomme que les EXCEPTIONS, avec leur raison.
  const refs = [BULLE_UUID, BULLE_REF]
  const { requetes, notesVues } = await banc({ refs })()
  // ⚠ ET LES NOTES AUSSI, QUI PARTENT PAR UN AUTRE MODULE. `notesDuPerimetre`
  // porte sa propre requete : la borne ne passe pas par `bornerRef`, elle
  // passe par son argument `refs`. Un `refs: null` ici donnerait au membre la
  // note moyenne de TOUS les biens du compte — un chiffre, pas une liste, donc
  // rien a l'ecran ne trahirait la fuite.
  assert.strictEqual(notesVues.length, 1, 'les notes ne sont pas lues')
  assert.deepEqual(notesVues[0].refs, refs.map(String),
    'les notes du membre ne sont pas bornees a ses biens')
  assert.strictEqual(notesVues[0].userId, TITULAIRE, 'les notes sont lues sur un autre compte')
  // `access_codes` est borne par le couple bien + reservation, pas par le
  // perimetre : ses reservations viennent deja d'une lecture bornee.
  const aExaminer = requetes.filter(r => r.table !== 'access_codes')
  assert.ok(aExaminer.length >= 8, `seulement ${aExaminer.length} lectures observees`)
  for (const r of aExaminer) {
    const b = bornes(r)
    assert.ok(b.length >= 1,
      `${r.table} part SANS borne de bien : le membre y verrait tout le compte`)
    for (const [, , valeurs] of b) {
      assert.deepEqual(valeurs, refs.map(String),
        `${r.table} est bornee sur une autre liste que le perimetre du membre`)
    }
  }
})

test('les messages des arrivees proches sont bornes aux reservations en main', async () => {
  // Ce bloc ne porte pas de `property_id` : il est borne par `booking_id`, et
  // ces identifiants viennent de `bookings_snapshot`, deja borne. La garantie
  // est donc qu'il ne part JAMAIS sans l'une des deux bornes.
  const refs = [BULLE_UUID, BULLE_REF]
  const { requetes } = await banc({ refs, lignes: {
    bookings_snapshot: [{ booking_id: 'B1', property_id: BULLE_REF,
      snapshot: { arrival: new Date().toISOString().slice(0, 10), status: 'confirmed' } }]
  } })()
  const msgs = requetes.filter(r => r.table === 'messages')
  assert.ok(msgs.length >= 1, 'aucune lecture de messages')
  for (const r of msgs) {
    const parBien = bornes(r)
    const parResa = r.filtres.filter(f => f[0] === 'in' && f[1] === 'booking_id')
    assert.ok(parBien.length || parResa.length,
      'une lecture de messages part sans borne, ni par bien ni par reservation')
  }
  const codes = requetes.filter(r => r.table === 'access_codes')
  assert.ok(codes.length >= 1, 'les codes ne sont plus lus')
  for (const r of codes) {
    assert.ok(r.filtres.some(f => f[0] === 'in' && f[1] === 'booking_id'),
      'les codes partent sans borne de reservation')
    // ⚠ ET LE BIEN AUSSI, AJOUTE AU LOT (b). Les identifiants Beds24 sont
    // numeriques et sans unicite globale, et cette table n'a pas de `user_id`
    // renseigne : sans le bien, la ligne d'un autre compte portant le meme
    // numero traversait le reseau avant d'etre ecartee en memoire.
    assert.ok(r.filtres.some(f => f[0] === 'in' && f[1] === 'property_id'),
      'les codes partent sans borne de BIEN : un identifiant partage fuiterait')
  }
})

// ─── 3. LE PERIMETRE VIDE ─────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : un perimetre VIDE rend un ecran vide, jamais l ecran complet', async () => {
  // ⚠ C'EST LE PIEGE QUI A COUTE LE PLUS CHER A CE DEPOT. `[]` n'est pas
  // `null` : le premier veut dire « aucun bien », le second « tous ». Un
  // `if (refs) borner()` laisse le perimetre vide SANS filtre — donc tout le
  // compte visible, au membre qui a le moins de droits.
  const { requetes, corps } = await banc({ refs: [] })()
  assert.strictEqual(corps.perimetre_vide, true, 'l ecran ne dit pas que le perimetre est vide')
  const tables = requetes.map(r => r.table)
  assert.deepEqual(tables, [],
    'un perimetre vide interroge quand meme la base : ' + tables.join(', '))
  assert.deepEqual(corps.biens, [])
  assert.deepEqual(corps.taches, [])
  assert.deepEqual(corps.alarmes, [])
  assert.deepEqual(corps.arrivees, [])
  assert.deepEqual(corps.conversations, [])
  // Les compteurs valent ZERO — un fait vrai : il n'a aucun bien. Pas `null`,
  // qui dirait « indisponible », et surtout pas le compte du titulaire.
  assert.deepEqual(corps.fait_pour_vous.menages, 0)
  assert.deepEqual(corps.fait_pour_vous.surreservation, 0)
})

// ─── 4. UN DROIT REFUSE ───────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : un domaine refuse n interroge meme pas sa table', async () => {
  // Le masquage par droit ne suffit jamais (regle absolue de CLAUDE.md) : la
  // garde SERVEUR est ici, et elle se mesure a ce qui ne part pas en requete.
  const refs = [BULLE_UUID, BULLE_REF]
  const cas = [
    ['messages', ['agent_tasks', 'messages']],
    ['reglages', ['automation_incidents']],
    ['avis', []]
  ]
  for (const [domaine, interdites] of cas) {
    const garde = TOUS_DOMAINES.filter(d => d !== domaine)
    const { requetes, corps, notesVues } = await banc({ refs, domaines: garde })()
    assert.ok(corps.refuses.includes(domaine), `${domaine} n est pas annonce comme refuse`)
    for (const t of interdites) {
      assert.ok(!requetes.some(r => r.table === t),
        `${domaine} refuse, et ${t} est pourtant interrogee`)
    }
    if (domaine === 'avis') {
      assert.strictEqual(notesVues.length, 0, 'les notes sont lues sans le droit `avis`')
      assert.strictEqual(corps.notes, null, 'les notes refusees ne valent pas zero')
    }
    if (domaine === 'messages') {
      assert.strictEqual(corps.taches, null, 'les taches refusees valent une liste vide')
      assert.strictEqual(corps.conversations, null)
      assert.strictEqual(corps.etats_arrivee, null)
      assert.strictEqual(corps.fait_pour_vous.messages_ia, null)
    }
  }
})

test('LE TEST QUI COMPTE : `price_display_log` ne se lit que pour le TITULAIRE', async () => {
  // Sa RLS est `user_id = auth.uid()` : elle ne connait pas la delegation. La
  // cle de service la contourne, donc le droit se verifie ici — et un membre,
  // meme avec tous les domaines en lecture, n'y a pas acces.
  const { requetes, corps } = await banc({ refs: [BULLE_UUID, BULLE_REF] })()
  assert.ok(!requetes.some(r => r.table === 'price_display_log'),
    'un membre delegue lit `price_display_log`, dont la RLS ne connait que le titulaire')
  assert.strictEqual(corps.fait_pour_vous.prix, null, 'le compteur prix vaut un nombre pour un membre')
  const t = await banc({ titulaire: true })()
  assert.ok(t.requetes.some(r => r.table === 'price_display_log'),
    'le titulaire ne lit plus son propre journal de prix')
})

// ─── 5. LA REPONSE, AU TAMIS ──────────────────────────────────────────────────

test('LE TEST QUI COMPTE : aucune reference hors perimetre dans la reponse', async () => {
  // ⚠ LE TAMIS PORTE SUR LE JSON RENDU, PAS SUR LES REQUETES. Les deux se
  // trompent differemment : une requete peut etre bornee et la reponse porter
  // quand meme une donnee d'un autre bien (un assemblage en memoire, une
  // jointure a la main). On relit donc la sortie.
  const refs = [BULLE_UUID, BULLE_REF]
  const jour = new Date().toISOString().slice(0, 10)
  const { corps } = await banc({ refs, lignes: {
    // La base rend EXPRES des lignes des deux biens — comme si une borne
    // manquait : si l'endpoint les recopie, le tamis le dira.
    properties: [{ id: BULLE_UUID, name: 'La bulle' }, { id: AUTRE_UUID, name: 'Interdit' }],
    agent_tasks: [{ id: 1, property_id: BULLE_REF, status: 'pending', guest_name: 'Chez moi' },
      { id: 2, property_id: AUTRE_REF, status: 'pending', guest_name: 'Interdit' }],
    bookings_snapshot: [
      { booking_id: 'B1', property_id: BULLE_REF, snapshot: { arrival: jour } },
      { booking_id: 'B2', property_id: AUTRE_REF, snapshot: { arrival: jour } }
    ]
  } })()
  const json = JSON.stringify(corps)
  assert.ok(!json.includes(AUTRE_UUID), 'l UUID d un bien hors perimetre est dans la reponse')
  assert.ok(!json.includes('Interdit'), 'le nom d un bien hors perimetre est dans la reponse')
})

// ─── La forme de l endpoint ───────────────────────────────────────────────────

test('seul GET est accepte, et l en-tete prive est pose AVANT le refus', async () => {
  // L'en-tete prive vient de la garde, donc avant tout : un 405 ne doit pas
  // sortir sans lui — c'est un cache partage qui le retiendrait sinon.
  const { res } = await banc({ titulaire: true, methode: 'POST' })()
  assert.deepEqual(res.codes, [405])
  assert.strictEqual(res.entetes.allow, 'GET')
})

test('le cout s annonce : `Server-Timing` et le bloc `cout`', async () => {
  const { res, corps } = await banc({ titulaire: true })()
  assert.match(res.entetes['server-timing'] || '', /db;desc="\d+ req", total;dur=\d+/)
  assert.ok(Number.isInteger(corps.cout.requetes) && corps.cout.requetes > 0)
  assert.ok(typeof corps.calcule_le === 'string' && corps.calcule_le.endsWith('Z'),
    'l heure du calcul est exigee par la regle d architecture')
})

test('une panne de lecture se NOMME, elle ne devient pas une liste vide', async () => {
  // Regle de restitution du depot : un `null` s'affiche « non calculable » avec
  // son motif. Une liste vide dirait « rien a traiter », un FAIT.
  const { corps } = await banc({ titulaire: true, pannes: ['agent_tasks', 'automation_incidents'] })()
  assert.strictEqual(corps.taches, null)
  assert.strictEqual(corps.alarmes, null)
  assert.ok(corps.indisponibles.includes('taches'))
  assert.ok(corps.indisponibles.includes('alarmes'))
})

test('une liste PLAFONNEE le dit, pour que l ecran puisse afficher « 200+ »', async () => {
  // Mesure du 23 octobre 2026 : le compte de Thierry porte 222 taches ouvertes
  // pour un plafond de 200. La liste est donc deja tronquee aujourd'hui.
  const taches = Array.from({ length: 200 },
    (_, i) => ({ id: i, property_id: BULLE_REF, status: 'pending' }))
  const { corps } = await banc({ titulaire: true, lignes: { agent_tasks: taches } })()
  assert.ok(corps.tronquees.includes('taches'),
    'une liste au plafond passe pour complete : l ecran affiche un compte faux avec aplomb')
})
