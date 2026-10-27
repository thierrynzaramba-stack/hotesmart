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
        select (_cols, opts = {}) { q.head = !!opts.head; q.count = opts.count || null; return chain },
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
      function reponse () {
        if (erreurs[table]) return { data: null, count: null, error: { message: erreurs[table] } }
        if (table === 'properties') return { data: bien, count: null, error: null }
        const tout = lignes[table] || []
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
      return { ok: true, accountUserId: COMPTE, bien: { id: BIEN } }
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
const PILOTE = { id: BIEN, name: 'La bulle', pilote_tarifaire: 'yieldflow', pilote_fenetre_type: 'jours', pilote_fenetre_valeur: 120 }
const MANUEL = { id: BIEN, name: 'Ofuro Futari', pilote_tarifaire: 'calendrier', pilote_fenetre_type: null, pilote_fenetre_valeur: null }
const PLEIN = {
  price_display_log: [{ id: 1 }, { id: 2 }, { id: 3 }],
  yield_events: [{ id: 'e1' }, { id: 'e2' }],
  comparables_retenus: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
  marche_biens: [{ localite: 'Bagnères-de-Bigorre' }]
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
  for (const table of ['price_display_log', 'yield_events', 'comparables_retenus', 'marche_biens']) {
    const q = vues.find(v => v.table === table)
    assert.equal(q.filtres.user_id, COMPTE, `${table} : pas de filtre de compte`)
    assert.equal(q.filtres.property_id, BIEN, `${table} : pas de filtre de bien`)
  }
  const bien = vues.find(v => v.table === 'properties')
  assert.equal(bien.filtres.user_id, COMPTE, 'le bien lui-meme se lit sur le compte')
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

test('le nombre de requetes annonce dans Server-Timing est le vrai', async () => {
  for (const [bien, attendu] of [[PILOTE, 5], [MANUEL, 4]]) {
    const vues = doubles({ bien, lignes: PLEIN })
    const res = await appeler()
    const reelles = vues.filter(v => v.table !== '__garde').length
    assert.equal(reelles, attendu, `${bien.pilote_tarifaire} : ${reelles} requetes au lieu de ${attendu}`)
    assert.match(res.entetes['server-timing'], new RegExp(`desc="${attendu} req"`),
      `Server-Timing doit annoncer ${attendu}`)
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
