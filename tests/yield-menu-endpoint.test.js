// tests/yield-menu-endpoint.test.js
// L'ENDPOINT DU MENU YIELDFLOW — `api/yield-menu.js` et `lib/yield/menu-calendrier.js`.
// Spec : docs/specs/spec-yf-bouton-calendrier.md §5, §6 et §7.
//
// ⚠ CE QU'IL GARDE, DANS L'ORDRE DE CE QUE ÇA COUTERAIT :
//   1. que l'endpoint reste en LECTURE SEULE — il sert un menu, pas un
//      interrupteur ; la bascule du pilote a sa garde ailleurs ;
//   2. que `private, no-store` soit pose AVANT LE PREMIER REFUS, 405 compris
//      (dette 90) — un refus parle du compte appelant ;
//   3. que les trois comptages ne RAPATRIENT RIEN (`head: true`) : PostgREST
//      tronque a 1000 lignes SANS erreur, et c'est la famille de defauts la
//      plus silencieuse du depot ;
//   4. qu'un fait illisible rende `null` et JAMAIS 0 : un 0 de remplacement
//      transforme une absence en fait ;
//   5. qu'un bien NON pilote ne paie pas le comptage du moteur.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')

const BIEN = '11111111-1111-4111-8111-111111111111'
const COMPTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

// ─── Le double de Supabase ────────────────────────────────────────────────
// ⚠ IL HONORE `head` ET `count`, ET IL ENREGISTRE LES FILTRES. Un double qui
// les note sans les appliquer laisserait passer un `select()` qui rapatrie
// tout : la suite serait verte et la production tronquerait a 1000 lignes
// sans un mot. Et un double aveugle a ses filtres ne prouve que « quelque
// chose a ete filtre », pas « par le bon compte ».
function doubles ({ bien = {}, lignes = {}, erreurs = {} } = {}) {
  const vues = []
  const client = {
    from (table) {
      const q = { table, filtres: {}, gte: null, head: false, count: null }
      vues.push(q)
      const chain = {
        select (cols, opts = {}) { q.colonnes = String(cols || ''); q.head = !!opts.head; q.count = opts.count || null; return chain },
        eq (c, v) { q.filtres[c] = v; return chain },
        gte (c, v) { q.gte = [c, v]; return chain },
        order () { return chain },
        // ⚠ `maybeSingle()` REND UNE LIGNE, PAS UN TABLEAU — et mon premier
        // double rendait le tableau. Le menu voyait alors `marche = null`
        // partout : un double plus PERMISSIF aurait cache un vrai defaut,
        // celui-la en fabriquait un. Dans les deux cas, c'est le double qu'il
        // faut corriger, pas l'assertion.
        maybeSingle: async () => {
          const r = reponse()
          if (r.error) return r
          return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: null }
        },
        then (ok, ko) { return Promise.resolve(reponse()).then(ok, ko) }
      }
      // ⚠ LE DOUBLE APPLIQUE SES FILTRES, IL NE SE CONTENTE PAS DE LES NOTER.
      // Sans ca, un endpoint qui oublierait `.eq('property_id', …)` rendrait
      // les lignes de TOUS les biens et la suite resterait verte : le test du
      // marche de chaque bien (demande de Thierry, 28 octobre 2026) serait un
      // faux vert, et le defaut se verrait chez l'hote, pas ici.
      const garde = (l) => Object.entries(q.filtres)
        .every(([c, v]) => !(c in l) || String(l[c]) === String(v))
      function reponse () {
        if (erreurs[table]) return { data: null, count: null, error: { message: erreurs[table] } }
        if (table === 'properties') {
          const tous = (Array.isArray(bien) ? bien : bien ? [bien] : []).filter(garde)
          return { data: tous[0] || null, count: null, error: null }
        }
        const tout = (lignes[table] || []).filter(garde)
        return { data: q.head ? null : tout, count: q.count === 'exact' ? tout.length : null, error: null }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(racine, 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m

  // La garde : on la remplace pour n'eprouver QUE cet endpoint. Ce qu'elle
  // fait est deja garde par `tests/cache-prive-endpoints.test.js` et par les
  // recensements de garde du depot.
  const absGarde = require.resolve(path.join(racine, 'lib/require-permission.js'))
  const g = new Module(absGarde)
  const vraie = fs.existsSync(absGarde)
  g.exports = {
    requirePermission: async (req, res, o) => {
      vues.push({ table: '__garde', filtres: { domaine: o.domaine, niveau: o.niveau, bien: o.bien, bienRequis: o.bienRequis } })
      return { ok: true, accountUserId: COMPTE, bien: { id: o.bien } }
    },
    UUID_RE: /^[0-9a-f-]{36}$/i,
    posterEnTetesPrives: () => {}
  }
  g.loaded = true
  assert.ok(vraie, 'lib/require-permission.js doit exister')
  require.cache[absGarde] = g

  for (const mod of ['../api/yield-menu', '../lib/yield/menu-calendrier']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return vues
}

function reponse () {
  const r = { code: null, corps: null, entetes: {} }
  r.setHeader = (k, v) => { r.entetes[String(k).toLowerCase()] = v; return r }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.corps = b; return r }
  return r
}
const appeler = async (req = {}) => {
  const res = reponse()
  await require('../api/yield-menu')({ method: 'GET', query: { bien: BIEN }, headers: {}, ...req }, res)
  return res
}
const PILOTE = { id: BIEN, name: 'La bulle', pilote_tarifaire: 'yieldflow', rate_sync_mode: 'managed', pilote_fenetre_type: 'jours', pilote_fenetre_valeur: 120 }
const MANUEL = { id: BIEN, name: 'Ofuro Futari', pilote_tarifaire: 'calendrier', rate_sync_mode: 'managed', pilote_fenetre_type: null, pilote_fenetre_valeur: null }
// « Je garde mes prix » : HoteSmart ne pousse aucun tarif, donc YieldFlow ne
// peut rien piloter. Mesure sur staging le 28 octobre 2026 : « Recette —
// Maison Jardin » est exactement dans cet etat.
const KEEP = { ...MANUEL, name: 'Maison Jardin', rate_sync_mode: 'keep' }
const PLEIN = {
  price_display_log: [{ id: 1, property_id: BIEN }, { id: 2, property_id: BIEN }, { id: 3, property_id: BIEN }],
  yield_events: [{ id: 'e1', property_id: BIEN }, { id: 'e2', property_id: BIEN }],
  comparables_retenus: [{ id: 1, property_id: BIEN }, { id: 2, property_id: BIEN }, { id: 3, property_id: BIEN }, { id: 4, property_id: BIEN }],
  marche_biens: [{ property_id: BIEN, localite: 'Bagnères-de-Bigorre' }]
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. LECTURE SEULE, ET LES REFUS
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : no-store est pose AVANT le premier refus, 405 compris', async () => {
  // ⚠ DETTE 90 : avant la GARDE ne suffit pas. Un 405 de methode et un 400 de
  // parametre manquant sont des reponses de compte eux aussi — partir
  // cachables, c'est laisser un cache partage les detenir.
  doubles({ bien: PILOTE, lignes: PLEIN })
  for (const [quoi, req, code] of [
    ['405 methode', { method: 'POST' }, 405],
    ['400 parametre', { query: {} }, 400]
  ]) {
    const res = await appeler(req)
    assert.equal(res.code, code, quoi)
    assert.equal(res.entetes['cache-control'], 'private, no-store', `${quoi} : en-tete absent`)
    assert.equal(res.entetes.vary, 'authorization, x-compte', `${quoi} : vary absent`)
  }
})

test('405 annonce Allow: GET, et aucune methode d ecriture n est servie', async () => {
  doubles({ bien: PILOTE, lignes: PLEIN })
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await appeler({ method })
    assert.equal(res.code, 405, method)
    assert.equal(res.entetes.allow, 'GET')
  }
})

test('LE TEST QUI COMPTE : ni l endpoint ni son module n ecrivent', () => {
  // La FORME, pas un nom : tout verbe d'ecriture de PostgREST.
  const sansCommentaires = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  for (const f of ['api/yield-menu.js', 'lib/yield/menu-calendrier.js']) {
    const src = sansCommentaires(lire(f))
    for (const verbe of ['insert', 'update', 'upsert', 'delete', 'rpc']) {
      assert.doesNotMatch(src, new RegExp('\\.' + verbe + '\\s*\\('),
        `${f} appelle .${verbe}() : cet endpoint sert un menu, il n ecrit pas`)
    }
  }
})

test('la garde demandee est « reservations » en LECTURE, et le bien est requis', async () => {
  const vues = doubles({ bien: PILOTE, lignes: PLEIN })
  await appeler()
  const g = vues.find(v => v.table === '__garde')
  assert.ok(g, 'aucune garde appelee')
  assert.deepEqual(g.filtres, { domaine: 'reservations', niveau: 'read', bien: BIEN, bienRequis: true })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. CE QUE L'ENDPOINT REND
// ═══════════════════════════════════════════════════════════════════════════

test('un bien pilote : les cinq faits, et la fenetre calculee par la regle du moteur', async () => {
  doubles({ bien: PILOTE, lignes: PLEIN })
  const res = await appeler()
  assert.equal(res.code, 200)
  const d = res.corps
  assert.equal(d.pilote, 'yieldflow')
  assert.deepEqual(d.fenetre, { type: 'jours', valeur: 120 })
  assert.match(String(d.fenetre_fin), /^\d{4}-\d{2}-\d{2}$/, 'la fin de fenetre doit etre une date')
  assert.equal(d.marche, 'Bagnères-de-Bigorre')
  assert.equal(d.evenements, 2)
  assert.equal(d.comparables, 4)
  assert.equal(d.prix_ajustes, 3)
  assert.equal(d.jours, 7)
})

test('LE TEST QUI COMPTE : les trois comptages ne rapatrient RIEN (head: true)', async () => {
  // PostgREST rend 1000 lignes SANS erreur. Un comptage qui rapatrie se
  // tronque en silence des qu'un bien pilote depuis un an est regarde.
  const vues = doubles({ bien: PILOTE, lignes: PLEIN })
  await appeler()
  for (const table of ['price_display_log', 'yield_events', 'comparables_retenus']) {
    const q = vues.find(v => v.table === table)
    assert.ok(q, `aucune lecture de ${table}`)
    assert.equal(q.head, true, `${table} : le comptage rapatrie des lignes`)
    assert.equal(q.count, 'exact', `${table} : le compte doit etre exact`)
  }
})

test('LE TEST QUI COMPTE : chaque lecture est cloisonnee par le COMPTE et par le bien', async () => {
  const vues = doubles({ bien: PILOTE, lignes: PLEIN })
  await appeler()
  // Les trois tables que NOUS ecrivons portent le compte ET le bien.
  for (const table of ['price_display_log', 'yield_events', 'comparables_retenus']) {
    const q = vues.find(v => v.table === table)
    assert.equal(q.filtres.user_id, COMPTE, `${table} : pas de filtre de compte`)
    assert.equal(q.filtres.property_id, BIEN, `${table} : pas de filtre de bien`)
  }
  // ⚠ `marche_biens` SE LIT SUR LE BIEN SEUL, et c'est un choix, pas un oubli
  // (review du 28 octobre 2026). Les QUATRE lecteurs existants de cette table
  // font pareil ; son `user_id` est une copie figee a la liaison, et filtrer
  // dessus ferait taire ce menu le jour ou elle divergerait, pendant que « Le
  // marche global » afficherait toujours le marche.
  const marche = vues.find(v => v.table === 'marche_biens')
  assert.equal(marche.filtres.property_id, BIEN, 'marche_biens : pas de filtre de bien')
  assert.equal(marche.filtres.user_id, undefined,
    'marche_biens ne doit pas filtrer sur user_id : les quatre autres lecteurs ne le font pas')
  // Le cloisonnement ne repose donc PAS sur ce filtre, mais sur le bien
  // lui-meme : il est lu sur `id` ET `user_id`, et un bien d'un autre compte
  // rend 404 avant toute autre lecture.
  const bien = vues.find(v => v.table === 'properties')
  assert.equal(bien.filtres.user_id, COMPTE, 'le bien lui-meme se lit sur le compte')
  assert.equal(bien.filtres.id, BIEN, 'et sur son identifiant')
})

test('LE TEST QUI COMPTE : le comptage du moteur porte la SOURCE et SEPT jours', async () => {
  const vues = doubles({ bien: PILOTE, lignes: PLEIN })
  await appeler()
  const q = vues.find(v => v.table === 'price_display_log')
  assert.equal(q.filtres.source, 'engine',
    "« ajuste » veut dire PAR LE MOTEUR : 'host' est la main de l hote, 'seed' une ligne d amorcage")
  assert.ok(q.gte && q.gte[0] === 'created_at', 'la borne porte sur created_at')
  const jours = (Date.now() - Date.parse(q.gte[1])) / 86400000
  assert.ok(Math.abs(jours - 7) < 0.01, `la borne doit etre a 7 jours, elle est a ${jours}`)
})

test('LE TEST QUI COMPTE : un bien NON pilote ne paie pas le comptage du moteur', async () => {
  const vues = doubles({ bien: MANUEL, lignes: PLEIN })
  const res = await appeler()
  assert.equal(res.corps.pilote, 'calendrier')
  assert.equal(res.corps.prix_ajustes, null, 'aucun prix ajuste a annoncer sur un bien en prix manuels')
  assert.equal(vues.filter(v => v.table === 'price_display_log').length, 0,
    'une requete dont on jettera le resultat est une requete de trop')
  assert.equal(res.corps.fenetre, null)
  assert.equal(res.corps.fenetre_fin, null)
})

test('LE TEST QUI COMPTE : chaque bien lit SON marche, ses evenements, ses comparables', async () => {
  // ⚠ DEMANDE DE THIERRY, 28 OCTOBRE 2026, NEE D'UN DOUTE SUR L'APERCU : les
  // deux logements y affichaient le MEME marche relie. C'etait un artefact du
  // banc a stubs — mais « c'est surement le stub » n'est pas une reponse, et
  // la seule qui vaille est un test qui le prouve sur le vrai code.
  //
  // Le defaut qu'il empeche est de ceux qui ne se voient pas : un
  // `.eq('property_id', …)` oublie sur UNE des quatre lectures ferait lire a
  // un bien les donnees d'un AUTRE — tous du meme compte, donc aucune fuite,
  // mais un hote a qui l'on montre le marche du voisin et qui tarife dessus.
  const AUTRE = '22222222-2222-4222-8222-222222222222'
  const deuxBiens = [
    { ...PILOTE, id: BIEN, name: 'La bulle' },
    { ...MANUEL, id: AUTRE, name: 'Ofuro Futari' }
  ]
  const lignes = {
    marche_biens: [
      { property_id: BIEN, localite: 'Bagneres-de-Bigorre' },
      { property_id: AUTRE, localite: 'Colomiers' }
    ],
    yield_events: [
      { id: 'e1', property_id: BIEN }, { id: 'e2', property_id: BIEN }, { id: 'e3', property_id: BIEN },
      { id: 'e4', property_id: AUTRE }
    ],
    comparables_retenus: [
      { id: 1, property_id: BIEN }, { id: 2, property_id: BIEN },
      { id: 3, property_id: AUTRE }, { id: 4, property_id: AUTRE }, { id: 5, property_id: AUTRE }
    ],
    price_display_log: [{ id: 1, property_id: BIEN }]
  }
  const attendu = {
    [BIEN]: { marche: 'Bagneres-de-Bigorre', evenements: 3, comparables: 2, prix_ajustes: 1 },
    [AUTRE]: { marche: 'Colomiers', evenements: 1, comparables: 3, prix_ajustes: null }
  }
  for (const id of [BIEN, AUTRE]) {
    doubles({ bien: deuxBiens, lignes })
    const res = await appeler({ query: { bien: id } })
    assert.equal(res.code, 200)
    assert.equal(res.corps.bien, id, 'la reponse ne parle pas du bien demande')
    for (const [champ, valeur] of Object.entries(attendu[id])) {
      assert.equal(res.corps[champ], valeur,
        `${id} : ${champ} vaut ${res.corps[champ]} au lieu de ${valeur} — une lecture n est pas cloisonnee par le bien`)
    }
  }
  // Le contre-controle qui empeche la tautologie : si les deux biens avaient
  // les memes valeurs, ce test ne separerait rien et serait vert pour rien.
  assert.notEqual(attendu[BIEN].marche, attendu[AUTRE].marche)
  assert.notEqual(attendu[BIEN].evenements, attendu[AUTRE].evenements)
  assert.notEqual(attendu[BIEN].comparables, attendu[AUTRE].comparables)
})

test('Server-Timing annonce un PLANCHER, et il le dit', async () => {
  // ⚠ CE TEST A CHANGE DE SENS A LA RE-REVIEW DU 28 OCTOBRE 2026, et c'est le
  // point. Il affirmait que le compte etait EXACT, en filtrant `__garde` —
  // c'est-a-dire en excluant les requetes de `requirePermission` des deux
  // cotes de l'egalite. Il etait donc d'accord avec le CODE, pas avec la
  // requete reelle : la garde fait une a deux lectures de plus (resoudreBien
  // toujours, chargerProfil pour un membre delegue), et le navigateur
  // recevait un nombre sous-estime.
  // Un test qui exclut la meme chose des deux cotes ne mesure rien.
  for (const [bien, lectures] of [[PILOTE, 5], [MANUEL, 4]]) {
    const vues = doubles({ bien, lignes: PLEIN })
    const res = await appeler()
    const propres = vues.filter(v => v.table !== '__garde').length
    assert.equal(propres, lectures, `${bien.pilote_tarifaire} : ${propres} lectures au lieu de ${lectures}`)
    // Le nombre annonce est celui des lectures du handler...
    assert.match(res.entetes['server-timing'], new RegExp(`desc="${lectures} req`),
      `Server-Timing doit annoncer ${lectures}`)
    // ...et l'en-tete DIT qu'il ne compte pas tout.
    assert.match(res.entetes['server-timing'], /plancher/,
      'un compte qui exclut la garde doit s annoncer comme un plancher, pas comme un total')
    assert.match(res.entetes['server-timing'], /garde/,
      'et il doit nommer ce qu il ne compte pas')
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. L'ILLISIBLE REND `null`, JAMAIS 0
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : un fait illisible rend null, et les autres sont servis', async () => {
  // ⚠ ET LE MENU REPOND QUAND MEME 200. Une panne sur un repere de confort ne
  // doit pas fermer un menu dont les quatre entrees savent se charger seules.
  for (const table of ['price_display_log', 'yield_events', 'comparables_retenus', 'marche_biens']) {
    doubles({ bien: PILOTE, lignes: PLEIN, erreurs: { [table]: 'colonne absente' } })
    const res = await appeler()
    assert.equal(res.code, 200, `${table} illisible ferme le menu`)
    const champ = { price_display_log: 'prix_ajustes', yield_events: 'evenements', comparables_retenus: 'comparables', marche_biens: 'marche' }[table]
    assert.equal(res.corps[champ], null, `${table} illisible doit rendre null`)
    assert.notEqual(res.corps[champ], 0, 'un 0 de remplacement transforme une absence en fait')
    // Les autres faits, eux, sont toujours la.
    for (const [t, c] of Object.entries({ yield_events: 'evenements', comparables_retenus: 'comparables' })) {
      if (t !== table) assert.ok(Number.isInteger(res.corps[c]), `${c} a disparu avec ${table}`)
    }
  }
})

test('LE TEST QUI COMPTE : le verdict de bascule est servi AVEC sa raison', async () => {
  // Recette de Thierry du 28 octobre 2026, point 6 : le menu proposait
  // « Activer le pilote automatique » sur un bien qui ne peut pas basculer.
  // L'ecran ne peut le savoir que si l'endpoint le DIT.
  doubles({ bien: MANUEL, lignes: PLEIN })
  let res = await appeler()
  assert.equal(res.corps.peut_basculer, true, 'un bien en « managed » est basculable')
  assert.equal(res.corps.raison, null, 'pas de raison quand il n y a pas de refus')

  doubles({ bien: KEEP, lignes: PLEIN })
  res = await appeler()
  assert.equal(res.corps.peut_basculer, false, 'un bien en « keep » ne peut pas basculer')
  assert.match(String(res.corps.raison), /garde mes prix/,
    'la raison vient de la regle, et elle dit QUEL GESTE debloque')
  // ⚠ L'APOSTROPHE DE LA REGLE EST DROITE, PAS TYPOGRAPHIQUE : mon premier
  // motif portait « ’ » et ne mordait pas sur un texte parfaitement correct.
  // Le motif accepte les deux formes plutot que d'imposer la mienne.
  assert.match(String(res.corps.raison), /Activez d['’]abord l['’]envoi des prix/,
    'un refus muet renverrait l hote a l ecran sans qu il sache quoi faire')
})

test('LE TEST QUI COMPTE : la colonne que lit la regle est SELECTIONNEE', async () => {
  // ⚠ UNE GARDE QUI JUGE SUR UNE COLONNE NON SELECTIONNEE EST UNE GARDE QUI
  // MENT — la lecon est gravee dans `yield-pilote.js` et
  // `channel-property.js`. `peutPasserEnYieldflow` ne lit QUE
  // `rate_sync_mode` : absente du select, elle vaudrait `undefined`, donc
  // « ne pousse pas ses prix », donc « basculable = false » POUR TOUS LES
  // BIENS. Le menu dirait a chaque hote que son activation est impossible.
  const vues = doubles({ bien: PILOTE, lignes: PLEIN })
  await appeler()
  const q = vues.find(v => v.table === 'properties')
  assert.ok(q.colonnes.includes('rate_sync_mode'),
    `le select des biens ne porte pas rate_sync_mode : ${q.colonnes}`)
})

test('le bien illisible, lui, est un 503 : on ne sert pas un menu sur un etat invente', async () => {
  // ⚠ LA DIFFERENCE EST VOULUE. Un repere manquant se tait ; l'ETAT DU PILOTE,
  // non : l'afficher « prix manuels » parce qu'on n'a pas su lire ferait croire
  // a l'hote qu'il sait ou il en est. C'est la regle de `apps/yield/prix.html`
  // — « un reglage qu'on ne sait pas lire ne s'affiche pas calendrier ».
  doubles({ bien: PILOTE, lignes: PLEIN, erreurs: { properties: 'injoignable' } })
  const res = await appeler()
  assert.equal(res.code, 503)
  assert.equal(res.entetes['cache-control'], 'private, no-store')
})

test('un bien introuvable rend 404, pas un menu vide', async () => {
  doubles({ bien: null, lignes: PLEIN })
  const res = await appeler()
  assert.equal(res.code, 404)
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. LE MODULE DES FAITS, SEUL
// ═══════════════════════════════════════════════════════════════════════════

test('la semaine du compteur est GLISSANTE, pas civile', () => {
  doubles()
  const { borneSemaine, JOURS_COMPTEUR } = require('../lib/yield/menu-calendrier')
  assert.equal(JOURS_COMPTEUR, 7)
  // ⚠ UNE SEMAINE CIVILE AFFICHERAIT 0 CHAQUE LUNDI MATIN. L'hote lit « cette
  // semaine » comme « ces derniers jours » : c'est ce que le compteur dit.
  const t = Date.UTC(2026, 9, 28, 9, 30)
  assert.equal(borneSemaine(t), new Date(t - 7 * 864e5).toISOString())
  const lundi = Date.UTC(2026, 9, 26, 8, 0)
  assert.ok(borneSemaine(lundi) < new Date(lundi).toISOString(),
    'la borne regarde en arriere, quel que soit le jour de la semaine')
})
