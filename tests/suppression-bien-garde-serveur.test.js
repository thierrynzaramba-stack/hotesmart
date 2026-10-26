// tests/suppression-bien-garde-serveur.test.js
//
// ⚠ POURQUOI CE FICHIER EXISTE. La garde serveur du DELETE de logement etait
// MORTE DE DEUX FACONS INDEPENDANTES, en production, et la suite etait verte :
//
//   · elle comparait le `rate_plan_id` de chaque mapping au plan de BASE du
//     bien, alors que api/channel-mapping.js ecrit lui-meme que depuis le
//     10 septembre 2026 tous les mappings pointent le plan DERIVE et que
//     « ce match n'aboutit PLUS JAMAIS » ;
//   · et le bloc entier etait conditionne par `prop.provider_rate_plan_id`,
//     donc un bien sans plan de base ne le traversait meme pas.
//
// `tests/logement-lecture.test.js` gardait bien cette garde — mais par sa
// PRESENCE : deux occurrences de `provider === 'channex'` et la chaine du
// message. Les deux survivaient a la mort de la garde.
//
// ⚠ C'EST LA REGLE 20 DE REVIEW.md, MOT POUR MOT : « un controle de securite
// verifie un COMPORTEMENT, jamais une forme de code. Appeler, pas lire. » On
// appelle donc le handler, et on exige le refus — exactement la demande de
// Thierry : « retirer le masquage de l'ecran -> le serveur repond 409 ».
//
// ⚠ ET C'EST LA CLASSE DE DEFAUT GRAVEE AU CLAUDE.md : « UN MASQUAGE PAR DROIT
// NE SUFFIT JAMAIS ». L'ecran a ete durci deux fois (recette du 22 octobre,
// revue du 23) pour desactiver « Supprimer » sur un mappage relie ou
// indetermine. Ces tests sont la seconde ligne : ils ne regardent pas l'ecran
// du tout.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const TITULAIRE = '11111111-1111-1111-1111-111111111111'
const BIEN = '33333333-3333-3333-3333-333333333333'

// L'etat que la base simulee rendra : pilote par chaque test.
const monde = {}
// Ce que le handler a fait : mesure, pas devine.
const trace = { deletes: [], fetchs: [], lectures: [] }

const CHEMIN_PERM = path.join(__dirname, '..', 'lib', 'require-permission.js')
const vraiPermission = require(CHEMIN_PERM)

// ─────────────────────────────────────────────────────────────────────────────
// La base simulee. Chainable, et elle REFUSE une table qu'on ne lui a pas
// apprise : une table oubliee doit faire rougir le test, pas rendre `[]` —
// un `[]` silencieux sur `canaux_du_bien` serait precisement le faux vert que
// ce fichier existe pour empecher.
// ─────────────────────────────────────────────────────────────────────────────
const fabriqueBase = () => ({
  auth: { getUser: async () => ({ data: { user: { id: TITULAIRE } }, error: null }) },
  from (table) {
    const ctx = { table, suppression: false, filtres: [] }
    const repondre = (forme) => {
      // ⚠ LES FILTRES SONT ENREGISTRES, PAS SEULEMENT LES TABLES. C'est le
      // constat de la review du 26 octobre 2026, et il etait grave : le double
      // rendait `api` sur `eq()` sans rien retenir, donc une mutation qui
      // remplacait
      //     .eq('user_id', compteBien).eq('property_id', String(bienPid))
      // par
      //     .eq('property_id', String(providerId))
      // — soit la cle provider TEXT au lieu de l'UUID, « le piege UUID »,
      // PLUS la perte du cloisonnement par compte — laissait la suite ENTIERE
      // au vert (10/10 et 109/109). Deux defauts de securite invisibles.
      trace.lectures.push({ table, suppression: ctx.suppression, filtres: ctx.filtres.slice() })
      if (ctx.suppression) {
        trace.deletes.push(table)
        return { data: null, error: null }
      }
      if (table === 'properties') return { data: monde.bien, error: monde.erreurBien || null }
      if (table === 'canaux_du_bien') {
        if (monde.erreurCanaux) return { data: null, error: { message: 'panne simulee' } }
        return { data: monde.canaux || [], error: null }
      }
      if (table === 'canaux_releve') {
        if (monde.erreurReleve) return { data: null, error: { message: 'panne simulee' } }
        return { data: monde.releve === undefined ? { vu_le: '2026-10-26T08:00:00Z', ok: true, erreur: null } : monde.releve, error: null }
      }
      // Tables purgees apres la garde : elles ne doivent etre atteintes que
      // quand la suppression est autorisee.
      if (table === 'bookings_snapshot') return { data: [], error: null }
      if (['menages', 'messages', 'message_sent_log', 'conversation_flags',
           'menage_events', 'property_channel_rate_plans'].includes(table)) {
        return { data: [], error: null }
      }
      if (monde.tablesTolerees && monde.tablesTolerees.includes(table)) return { data: [], error: null }
      throw new Error(`table non apprise au double : ${table} (forme ${forme})`)
    }
    const api = {
      select () { return api },
      eq (col, val) { ctx.filtres.push([String(col), val]); return api },
      neq () { return api },
      is (col, val) { ctx.filtres.push([`is:${col}`, val]); return api },
      in () { return api },
      not () { return api },
      order () { return api },
      limit (n) { ctx.filtres.push(['limit', n]); return api },
      delete () { ctx.suppression = true; return api },
      update () { ctx.suppression = true; return api },
      range: async () => repondre('range'),
      single: async () => repondre('single'),
      maybeSingle: async () => repondre('maybeSingle'),
      then (ok, ko) { return Promise.resolve().then(() => repondre('await')).then(ok, ko) }
    }
    return api
  }
})

const origine = Module._load
Module._load = function (demande) {
  if (demande === '@supabase/supabase-js') return { createClient: () => fabriqueBase() }
  if (demande === '../lib/require-permission' || demande === './require-permission') {
    return {
      ...vraiPermission,
      // La garde de DROIT est deja eprouvee ailleurs : ici elle passe, pour que
      // ce soit la garde d'ETAT qu'on mesure. Un test qui ferait tout refuser
      // par le droit ne dirait rien de la suppression.
      requirePermission: async () => ({
        ok: true, userId: TITULAIRE, accountUserId: TITULAIRE,
        bien: { id: BIEN }, contexte: {}
      })
    }
  }
  return origine.apply(this, arguments)
}

// Le partenaire : pilote par `monde.partenaire`, et tout appel est trace.
global.fetch = async (url, opts) => {
  trace.fetchs.push(`${(opts && opts.method) || 'GET'} ${String(url)}`)
  const r = monde.partenaire || { status: 200, body: { data: {} } }
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(r.body || {}),
    json: async () => r.body || {}
  }
}

const handler = require('../api/channel-property.js')

const appeler = async () => {
  const rep = { code: null, corps: null }
  const res = {
    status (c) { rep.code = c; return res },
    json (o) { rep.corps = o; return res },
    setHeader () { return res },
    end () { return res }
  }
  await handler({
    method: 'DELETE',
    headers: { authorization: 'Bearer jeton-de-test' },
    body: { property_id: BIEN },
    query: {}
  }, res)
  return rep
}

const poser = (etat) => {
  for (const k of Object.keys(monde)) delete monde[k]
  trace.deletes.length = 0
  trace.fetchs.length = 0
  trace.lectures.length = 0
  monde.bien = {
    id: BIEN, name: 'Bien de test', provider: 'channex',
    provider_property_id: 'PROP-1', provider_rate_plan_id: 'PLAN-BASE'
  }
  Object.assign(monde, etat)
}

// ─────────────────────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : un canal RELIE fait refuser le serveur en 409', async () => {
  // Le defaut historique, et le plus couteux : l'annonce reste en vente et les
  // reservations sont effacees.
  poser({ canaux: [{ ota: 'airbnb', titre: 'Annonce', actif: true, mappe_pour_ce_bien: true }] })
  const r = await appeler()
  assert.equal(r.code, 409, `le serveur a repondu ${r.code} : un bien en vente s est supprime`)
  assert.equal(r.corps.motif, 'annonce_reliee')
  // ⚠ ET RIEN N'A ETE TOUCHE. Un 409 rendu APRES la purge serait inutile.
  assert.deepEqual(trace.deletes, [], `des donnees ont ete purgees : ${trace.deletes.join(', ')}`)
  assert.deepEqual(trace.fetchs, [], `le partenaire a ete appele : ${trace.fetchs.join(', ')}`)
})

test('LE TEST QUI COMPTE : un mappage INDETERMINE fait refuser le serveur en 409', async () => {
  // `mappe_pour_ce_bien` est NULLABLE a dessein : la migration du 19 octobre le
  // dit (« c'est le point »). `null` veut dire « je ne sais pas », et on ne
  // supprime pas sur un « je ne sais pas ».
  poser({ canaux: [{ ota: 'airbnb', titre: 'Annonce', actif: true, mappe_pour_ce_bien: null }] })
  const r = await appeler()
  assert.equal(r.code, 409)
  assert.equal(r.corps.motif, 'mapping_inconnu')
  assert.deepEqual(trace.deletes, [])
})

test('LE TEST QUI COMPTE : SANS PLAN TARIFAIRE, la garde mord quand meme', async () => {
  // ⚠ LA SECONDE MOITIE DU DEFAUT. L'ancienne garde etait conditionnee par
  // `prop.provider_rate_plan_id` : un bien sans plan de base ne la traversait
  // pas du tout. C'est l'exact cas vu en recette le 22 octobre 2026 — un bien
  // dont Airbnb etait « en vente », avec 77 reservations.
  poser({
    bien: { id: BIEN, name: 'Sans plan', provider: 'channex',
            provider_property_id: 'PROP-1', provider_rate_plan_id: null },
    canaux: [{ ota: 'airbnb', titre: 'Annonce', actif: true, mappe_pour_ce_bien: true }]
  })
  const r = await appeler()
  assert.equal(r.code, 409, 'un bien sans plan tarifaire echappe encore a la garde')
  assert.equal(r.corps.motif, 'annonce_reliee')
  assert.deepEqual(trace.deletes, [])
})

test('LE TEST QUI COMPTE : une lecture des canaux EN PANNE refuse, elle n autorise pas', async () => {
  // `null` et `[]` ne se confondent pas : passer un tableau vide sur une erreur
  // transformerait une panne de notre base en autorisation de supprimer.
  poser({ erreurCanaux: true })
  const r = await appeler()
  assert.equal(r.code, 409)
  assert.equal(r.corps.motif, 'canaux_illisibles')
  assert.deepEqual(trace.deletes, [])
})

test('LE TEST QUI COMPTE : une lecture TRONQUEE refuse', async () => {
  // Le defaut des 1000 lignes silencieuses du depot, applique a une garde :
  // une liste incomplete rendrait un « aucun canal mappe » qui ne veut rien
  // dire. La borne est a 200.
  poser({
    canaux: Array.from({ length: 200 }, (_, i) => ({
      ota: 'airbnb', titre: `A${i}`, actif: true, mappe_pour_ce_bien: false
    }))
  })
  const r = await appeler()
  assert.equal(r.code, 409, 'une lecture tronquee a autorise la suppression')
  assert.equal(r.corps.motif, 'canaux_illisibles')
  assert.deepEqual(trace.deletes, [])
})

test('LE TEST QUI COMPTE : un REFUS DU PARTENAIRE arrete tout, sans aucune purge', async () => {
  // ⚠ DECISION DE THIERRY, 26 octobre 2026. La version d'avant purgeait quand
  // meme : on obtenait une annonce qui VEND chez le partenaire et un HoteSmart
  // aveugle, reservations et messages effaces. Un bien non supprime se
  // re-supprime ; des reservations purgees ne reviennent pas.
  poser({
    canaux: [{ ota: 'airbnb', titre: 'Annonce', actif: true, mappe_pour_ce_bien: false }],
    partenaire: { status: 500, body: { errors: { detail: 'panne' } } }
  })
  const r = await appeler()
  assert.equal(r.code, 409, `le serveur a repondu ${r.code} apres un refus du partenaire`)
  assert.equal(r.corps.motif, 'partenaire_refuse')
  assert.equal(r.corps.statut_partenaire, 500)
  assert.deepEqual(trace.deletes, [], `la purge a eu lieu malgre le refus : ${trace.deletes.join(', ')}`)
  // Le message doit DIRE que rien n'a ete supprime : sans ca, l'hote croit son
  // bien parti et ne reessaie pas.
  assert.match(r.corps.error, /[Rr]ien n'a été supprimé/)
})

test('un bien SANS canal, releve a jour, se supprime : la garde ne bloque pas tout', async () => {
  // ⚠ LA CONTRE-EPREUVE INDISPENSABLE. Une garde qui refuse TOUT passerait les
  // six tests ci-dessus et serait inutilisable. Celui-ci est le seul qui
  // distingue « la garde marche » de « la garde est fermee ».
  poser({ canaux: [], partenaire: { status: 200, body: { data: {} } } })
  const r = await appeler()
  assert.equal(r.code, 200, `la suppression legitime a ete refusee : ${JSON.stringify(r.corps)}`)
  assert.equal(r.corps.deleted, true)
  assert.ok(trace.deletes.length > 0, 'la suppression a rendu 200 sans rien purger')
  assert.ok(trace.fetchs.some(f => f.startsWith('DELETE')), 'le partenaire n a pas ete appele')
})

test('un 404 du partenaire reste un succes : la propriete n y est DEJA plus', async () => {
  // Refuser la purge sur un 404 rendrait le bien definitivement insupprimable.
  poser({ canaux: [], partenaire: { status: 404, body: {} } })
  const r = await appeler()
  assert.equal(r.code, 200)
  assert.equal(r.corps.channel_deleted, true)
  assert.ok(trace.deletes.length > 0)
})

test('aucun canal et releve JAMAIS abouti : on ne conclut pas', async () => {
  // L'absence de ligne ne prouve rien si le releve n'a jamais tourne — c'est la
  // regle de l'ecran (`jamais_releve`), et le serveur la partage desormais.
  poser({ canaux: [], releve: null })
  const r = await appeler()
  assert.equal(r.code, 409)
  assert.equal(r.corps.motif, 'jamais_releve')
  assert.deepEqual(trace.deletes, [])
})

test('la garde du serveur et celle de l ecran sont LA MEME FONCTION', async () => {
  // ⚠ PAS UNE COPIE. C'est la cause racine du defaut : l'ecran a ete durci deux
  // fois, le handler jamais, parce que chacun portait sa propre regle. Le
  // handler appelle maintenant `suppressionPossible`, exportee par
  // lib/logement/lecture.js « pour qu'une regle ne soit ecrite qu'une fois ».
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'channel-property.js'), 'utf8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(code, /require\('\.\.\/lib\/logement\/lecture'\)/,
    'le handler ne tire plus la regle partagee : une copie a ete reintroduite')
  assert.match(code, /suppressionPossible\(prop, canaux,/,
    'la regle partagee n est plus appelee avec le bien et ses canaux')
  // Et l'ancien chemin — interroger le partenaire pour comparer au plan de
  // BASE — ne doit pas revenir : il n'aboutissait jamais.
  assert.ok(!/stillMapped/.test(code),
    'le match sur le plan de base est revenu : il n aboutit jamais (channel-mapping.js le dit)')
  const { suppressionPossible } = require('../lib/logement/lecture')
  assert.equal(typeof suppressionPossible, 'function')
})

test('LE TEST QUI COMPTE : la garde lit l UUID DU BIEN et le COMPTE DU BIEN', async () => {
  // ⚠ CE TEST FERME UN FAUX VERT MESURE PAR LA REVIEW DU 26 OCTOBRE 2026. Le
  // double de base rendait `api` sur chaque `eq()` sans rien retenir : une
  // mutation remplacant
  //     .eq('user_id', compteBien).eq('property_id', String(bienPid))
  // par
  //     .eq('property_id', String(providerId))
  // laissait la suite ENTIERE au vert — 10/10 ici et 109/109 dans
  // logement-lecture. Deux defauts de securite d'un coup, invisibles :
  //
  //   1. LA CLE. `canaux_du_bien.property_id` est un `uuid not null references
  //      properties(id)` (migration du 19 octobre 2026) — c'est une EXCEPTION
  //      assumee a la convention du depot (REVIEW.md §10, et les REGLES
  //      TECHNIQUES DURES du CLAUDE.md : « properties.id = UUID ; property_id
  //      des tables enfant = TEXT (provider propId) »), ou le `property_id`
  //      des tables enfant porte la cle provider en TEXT. Interroger cette colonne avec
  //      une cle provider rendrait zero ligne, donc « aucun canal mappe »,
  //      donc une AUTORISATION DE SUPPRIMER. C'est le piege UUID, que le depot
  //      a deja paye plusieurs fois — et je ne mets pas de nombre ici : les
  //      quatre endroits qui en portent un n'etaient pas d'accord entre eux
  //      (« troisieme », « quatrieme », « cinquieme »), ce qui est exactement
  //      le defaut du chiffre ecrit a la main que personne ne peut recompter.
  //   2. LE CLOISONNEMENT. Sans `user_id`, la garde lirait les canaux de tous
  //      les comptes portant le meme UUID de bien — inerte aujourd'hui (un
  //      UUID est unique) mais c'est la discipline du depot, et c'est la
  //      colonne que la RLS de cette table exige.
  poser({ canaux: [], partenaire: { status: 200, body: { data: {} } } })
  await appeler()

  const lecture = trace.lectures.find(l => l.table === 'canaux_du_bien' && !l.suppression)
  assert.ok(lecture, 'canaux_du_bien n a pas ete lu du tout : la garde ne consulte plus le coeur')
  const filtres = new Map(lecture.filtres)

  assert.equal(filtres.get('property_id'), BIEN,
    `la garde interroge property_id = ${JSON.stringify(filtres.get('property_id'))} au lieu de `
    + `l UUID du bien (${BIEN}). Une cle provider rendrait zero ligne, donc une autorisation.`)
  assert.equal(filtres.get('user_id'), TITULAIRE,
    'la garde ne filtre plus sur le compte du bien')
  assert.equal(filtres.get('is:disparu_le'), null,
    'la garde ne filtre plus les canaux disparus, ou elle les filtre autrement')
  assert.equal(filtres.get('limit'), 200,
    'la borne de prudence a change : le test de troncature ne mesure plus la bonne limite')
})

test('LE TEST QUI COMPTE : la PURGE porte le compte, et ses TROIS exemptions sont comptees', async () => {
  // Une purge qui oublierait le compte effacerait les donnees d'un autre hote
  // portant la meme cle provider. Ce cas n'est pas interdit par le schema : la
  // contrainte d'unicite est `(user_id, provider, provider_property_id)`, donc
  // deux comptes PEUVENT porter le meme numero. (Je l'avais presente comme une
  // phrase du depot : elle n'y est pas, c'est une lecture du schema, et la
  // re-review du 26 octobre a eu raison de me le faire dire autrement.)
  // `property_id` des tables enfant est du TEXT provider par convention, donc
  // la collision est possible partout ou le compte ne borne pas.
  //
  // ⚠ TROIS TABLES NE SONT PAS BORNEES PAR LE COMPTE, le code les nomme
  // lui-meme `tablesNoUser` — et mon premier diagnostic de cette liste etait
  // FAUX SUR DEUX DES TROIS (constat de la re-review du 26 octobre 2026).
  // J'avais ecrit « elles n'ont pas de colonne user_id, ce n'est pas un oubli
  // mais leur schema » et « la purge efface les lignes de tout compte portant
  // la meme cle provider, non corrigible sans migration ». Mesure, schema en
  // main :
  //
  //   · `access_codes`      : property_id TEXT, **et user_id uuid EXISTE**.
  //     Elle n'est simplement jamais remplie — c'est le bloquant (d) du
  //     CLAUDE.md, « user_id dans INSERT serrures ». Aucune migration n'est
  //     necessaire : il manque une valeur, pas une colonne. Et ses cles sont
  //     MIXTES (un writer pose la cle provider, l'autre l'UUID), donc la purge
  //     en manque deja une partie.
  //   · `calendar_inventory` et `channel_sync_queue` : property_id **uuid**,
  //     avec `references properties(id) ON DELETE CASCADE`. La purge explicite
  //     par cle provider ne peut donc RIEN effacer — 22P02, erreur avalee par
  //     un console.error — et le menage reel vient de la cascade, cloisonnee
  //     par UUID. Le risque inter-comptes que j'annoncais n'existe pas pour
  //     elles ; ce qui existe est une purge MORTE dans le fichier qu'on
  //     reecrit, et c'est le piege UUID une fois de plus.
  //
  // Une exemption se COMPTE, elle ne se decrit pas : on les enumere pour
  // qu'une QUATRIEME fasse rougir au lieu de se glisser dans la liste. Hors
  // perimetre de ce correctif, qui ne touche pas la purge — au registre.
  const SANS_COLONNE_COMPTE = ['access_codes', 'calendar_inventory', 'channel_sync_queue']

  poser({ canaux: [], partenaire: { status: 200, body: { data: {} } } })
  await appeler()

  const purges = trace.lectures.filter(l => l.suppression)
  assert.ok(purges.length > 0, 'aucune purge tracee : la suppression n a rien efface')
  const sansCompte = [...new Set(purges
    .filter(l => !l.filtres.some(([c]) => c === 'user_id'))
    .map(l => l.table))].sort()
  assert.deepEqual(sansCompte, [...SANS_COLONNE_COMPTE].sort(),
    'l inventaire des purges non bornees par le compte a change : '
    + `mesure ${JSON.stringify(sansCompte)}. Une table de plus doit etre nommee ICI, `
    + 'avec la raison — ou bornee par le compte.')
  // Et toutes les autres portent bien le compte DU BIEN, pas celui de l appelant.
  for (const l of purges.filter(x => !SANS_COLONNE_COMPTE.includes(x.table))) {
    const filtres = new Map(l.filtres)
    assert.equal(filtres.get('user_id'), TITULAIRE, `purge ${l.table} : mauvais compte`)
  }

  // ⚠ ET CHAQUE PURGE DESIGNE **CE** BIEN. C'est le trou le plus couteux
  // trouve par la re-review du 26 octobre 2026 : retirer
  // `.eq('property_id', propKey)` de la boucle des quatorze tables fait
  // effacer TOUT `bookings_snapshot`, `messages`, `menage_events`,
  // `public_tokens`, `sms_logs`... du compte en supprimant UN bien — et la
  // suite entiere restait verte (6283/6283). Le test ne regardait que le
  // compte, qui lui restait juste : la mutation effacait les bonnes lignes
  // d'un point de vue du cloisonnement, et toutes les autres en plus.
  const DESIGNE_LE_BIEN = ['property_id', 'provider_property_id', 'id', 'booking_id']
  const sansBien = purges.filter(l => !l.filtres.some(([c]) => DESIGNE_LE_BIEN.includes(c)))
  assert.deepEqual([...new Set(sansBien.map(l => l.table))], [],
    `des purges ne designent AUCUN bien : ${[...new Set(sansBien.map(l => l.table))].join(', ')}`
    + ' — elles effaceraient tout le compte')
  for (const l of purges) {
    const filtres = new Map(l.filtres)
    if (filtres.has('property_id')) {
      // `propKey` est la cle PROVIDER (regle de convention du depot), sauf pour
      // `properties` elle-meme qui se purge par son UUID.
      const attendu = l.table === 'properties' ? BIEN : 'PROP-1'
      assert.equal(String(filtres.get('property_id')), attendu,
        `purge ${l.table} : property_id vise ${filtres.get('property_id')} au lieu de ${attendu}`)
    }
    if (filtres.has('provider_property_id')) {
      assert.equal(String(filtres.get('provider_property_id')), 'PROP-1',
        `purge ${l.table} : mauvaise reference partenaire`)
    }
  }
})

test('LE TEST QUI COMPTE : les DEUX lectures de la garde sont bornees au compte du bien', async () => {
  // ⚠ DEUX AUTRES TROUS DU MEME DOUBLE, trouves par la re-review du 26 octobre
  // 2026 : retirer `.eq('user_id', compteBien)` de la lecture de `properties`
  // OU de celle de `canaux_releve` laissait la suite entiere verte
  // (6283/6283 les deux fois).
  //
  // Ce que chacune permettrait :
  //   · `properties` sans compte -> la garde statuerait, et le handler
  //     supprimerait, sur un bien d'un AUTRE compte designe par son UUID.
  //     `requirePermission` le borne en amont, mais rien ne le MESURE : c'est
  //     exactement la situation qui a produit la garde morte qu'on repare ici.
  //   · `canaux_releve` sans compte -> la garde deciderait sur l'horloge d'un
  //     autre compte, donc sur un releve qui ne parle pas de ce bien.
  poser({ canaux: [], partenaire: { status: 200, body: { data: {} } } })
  await appeler()

  for (const table of ['properties', 'canaux_releve']) {
    const lecture = trace.lectures.find(l => l.table === table && !l.suppression)
    assert.ok(lecture, `${table} n a pas ete lu : le chemin de la garde a change`)
    const filtres = new Map(lecture.filtres)
    assert.equal(filtres.get('user_id'), TITULAIRE,
      `la lecture de ${table} n est plus bornee au compte du bien`)
  }
  // Et `properties` est bien designe par son UUID, pas par une cle provider.
  const lp = new Map(trace.lectures.find(l => l.table === 'properties' && !l.suppression).filtres)
  assert.equal(lp.get('id'), BIEN, 'le bien est relu par autre chose que son UUID')
})

test('l ecran et le serveur passent la MEME VALEUR a la regle partagee', () => {
  // ⚠ UN TEST DE FORME, ET JE L'ASSUME COMME TEL — le depot dit qu'un controle
  // de securite verifie un comportement, jamais une forme. Celui-ci ne garde
  // pas une garde : il garde un CONTRAT entre deux appelants.
  //
  // L'ecran passe `releveDuCompte = horlogeLigne.vu_le` ; le handler passait la
  // LIGNE entiere, toujours truthy. Une ligne existante sans `vu_le` aurait
  // donc ete lue « releve abouti » cote serveur et « jamais releve » cote
  // ecran — la divergence meme qui a produit la garde morte.
  //
  // ⚠ ET CET ETAT N'EST PAS ATTEIGNABLE AUJOURD'HUI, donc aucun appel du
  // handler ne peut le mesurer : `noterLeReleve` pose `vu_le` des que le
  // releve a ecrit quelque chose, et une ligne sans `vu_le` porte `ok: false`,
  // donc `echecVisibleParLHote` la rattrape par l'autre moitie de la
  // condition. C'est pourquoi la contre-epreuve par mutation de cette ligne ne
  // rougit sur AUCUN test de comportement — mesure faite, `fail 0`. Un test de
  // forme est ici le seul filet possible, et il vaut mieux que rien : le jour
  // ou `noterLeReleve` changera, c'est lui qui rappellera le contrat.
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'channel-property.js'), 'utf8')
  const i = src.indexOf("if (req.method === 'DELETE')")
  const fin = src.indexOf("if (req.method === 'POST')", i)
  const bloc = src.slice(i, fin).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(bloc, /releveDuCompte = h \? \(h\.vu_le \|\| null\) : null/,
    'le handler ne passe plus `vu_le` : il diverge de l ecran sur l entree de la regle partagee')
})
