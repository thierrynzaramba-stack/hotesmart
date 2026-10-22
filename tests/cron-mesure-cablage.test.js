// tests/cron-mesure-cablage.test.js
// LE CABLAGE DE LA MESURE DANS LES DEUX CRONS.
//
// Le compteur est eprouve ailleurs (tests/metriques-cron.test.js) et la ligne
// de base aussi (tests/cron-stats.test.js). Ce fichier garde ce qui ne se voit
// qu'au point de montage, et que rien d'autre ne protege :
//
//  1. le passage s'ouvre AVANT la premiere requete — sinon les lectures du
//     debut de cycle disparaissent du total, et ce sont elles qu'un decoupage
//     devra porter ;
//  2. la mesure est ecrite dans les DEUX sorties du handler, succes et echec —
//     un passage qui casse est precisement celui qu'on veut lire ;
//  3. ⚠ ET L'ECRITURE DE LA MESURE NE CHANGE RIEN A LA REPONSE DU CRON. C'est
//     l'exigence de Thierry, et elle est eprouvee EN REEL ici : une base qui
//     refuse l'insertion ne doit pas deplacer d'un caractere ce que la passe
//     rend ;
//  4. le compteur reste a UN endroit. Un compteur recopie dans trente modules
//     est faux des le trente-et-unieme.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const lire = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

// ─── 1. Le passage s'ouvre avant la premiere requete ────────────────────────

test('⚠ api/cron.js ouvre le passage AVANT sa premiere requete', () => {
  const src = lire('api/cron.js')
  const ouverture = src.indexOf('demarrerPassage(')
  const premiereRequete = src.indexOf("from('api_keys')")
  assert.ok(ouverture > 0, 'le passage doit etre ouvert')
  assert.ok(premiereRequete > 0, 'la lecture des cles Beds24 doit toujours etre la')
  assert.ok(ouverture < premiereRequete,
    'un passage ouvert apres la premiere requete perd les lectures du debut de cycle')
})

test('⚠ api/cron-messages.js aussi, et sa lecture des biens est une tache nommee', () => {
  const src = lire('api/cron-messages.js')
  const ouverture = src.indexOf('demarrerPassage(')
  const premiereRequete = src.indexOf("from('properties')")
  assert.ok(ouverture > 0 && premiereRequete > 0)
  assert.ok(ouverture < premiereRequete)
  assert.match(src, /mesure\('lecture_biens'/)
  assert.match(src, /mesure\('ordre_import'/)
  assert.match(src, /mesure\('import_bien'/)
})

// ─── 2. La mesure est ecrite dans les deux sorties ──────────────────────────

test('⚠ api/cron.js journalise son passage dans la sortie NORMALE et dans le catch global', () => {
  const src = lire('api/cron.js')
  const appels = src.match(/await journaliserLePassage\(\)/g) || []
  assert.ok(appels.length >= 2, `attendu au moins 2 appels, vu ${appels.length}`)
  // Le catch global est la sortie 500 : elle doit porter le sien.
  const catchGlobal = src.slice(src.indexOf("console.error('[Cron] Erreur globale:'"))
  assert.match(catchGlobal, /journaliserLePassage\(\)/,
    'un cycle qui casse est celui qu on veut lire')
  // ⚠ Et l'ecriture est protegee : elle ne peut pas lever vers le handler.
  // ⚠ LE BLOC SE DELIMITE PAR SA FERMETURE, PAS PAR UN NOMBRE DE CARACTERES.
  // La premiere version coupait a 500 caracteres : ajouter un commentaire de
  // dix lignes dans la fonction faisait rougir ce test sans qu'aucune regle
  // n'ait bouge — le defaut que ce fichier reproche aux autres.
  const debut = src.indexOf('const journaliserLePassage')
  const bloc = src.slice(debut, src.indexOf('\n  }\n', debut))
  assert.match(bloc, /try\s*\{[\s\S]*catch/, 'l ecriture de la mesure vit sous un try')
})

test('api/cron-messages.js journalise aussi la passe qui n a rien pu lire', () => {
  const src = lire('api/cron-messages.js')
  const avant503 = src.slice(0, src.indexOf("'Lecture des biens impossible'"))
  assert.match(avant503.slice(-400), /journaliserLePassage\(\)/)
})

test('⚠ UNE SEULE LIGNE PAR PASSAGE, meme si la journalisation est appelee deux fois', () => {
  // CONSTAT DE REVIEW : `journaliserLePassage()` est appele dans la sortie
  // normale ET dans le `catch` global. Si quelque chose levait APRES la sortie
  // normale — un `res.json` sur un corps non serialisable, des en-tetes deja
  // envoyes —, le `catch` rappelait `terminer()` et inserait une SECONDE
  // ligne avec le meme `commence_le` : le classement comptait le passage deux
  // fois, dans `count(*)` et dans toutes ses sommes.
  //
  // ⚠ CE TEST EST STRUCTUREL, ET JE LE DIS. Le chemin qui l'exerce demande une
  // levee entre la sortie normale et la fin du handler : l'atteindre sous test
  // voudrait dire rejouer le cycle complet (trente modules, appels partenaires
  // compris). On garde donc la PRESENCE du drapeau et son usage, et la
  // semantique — « deux appels, une ecriture » — est eprouvee sur la fonction
  // elle-meme dans tests/cron-stats.test.js.
  for (const f of ['api/cron.js', 'api/cron-messages.js']) {
    const src = lire(f)
    const bloc = src.slice(src.indexOf('let mesureEcrite'), src.indexOf('journaliserLePassage = async') + 220)
    assert.match(bloc, /let mesureEcrite = false/, f)
    assert.match(bloc, /if \(mesureEcrite\) return/, f)
    assert.match(bloc, /mesureEcrite = true/, f)
  }
})

// ─── 3. Le compteur reste a un seul endroit ─────────────────────────────────

test('⚠ aucun module ne compte a la main : le compteur est pose sur le client', () => {
  // Demande explicite de Thierry (« compteur posé sur le client, pas à la main
  // dans chaque module »). Le jour ou un module s'incremente lui-meme, la
  // mesure devient une collection de conventions, et le module suivant
  // l'oubliera.
  const racine = path.join(__dirname, '..')
  const fichiers = []
  for (const dossier of ['lib', 'api']) {
    const pile = [path.join(racine, dossier)]
    while (pile.length) {
      const d = pile.pop()
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const complet = path.join(d, e.name)
        if (e.isDirectory()) pile.push(complet)
        else if (e.name.endsWith('.js')) fichiers.push(complet)
      }
    }
  }
  const comptants = fichiers
    .filter(f => /compterAppelExterne/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(racine, f))
    .sort()
  // `lib/cron-shared.js` est le SEUL appelant legitime : le SDK Anthropic
  // capture `fetch` a la construction, donc l'interception ne le voit pas.
  assert.deepEqual(comptants, ['lib/cron-shared.js', 'lib/metriques-cron.js'])
})

test('l enveloppe du journal IA porte le comptage, et cron-shared le branche', () => {
  assert.match(lire('lib/ia/journal.js'), /surAppel/)
  assert.match(lire('lib/cron-shared.js'), /surAppel: \(\) => compterAppelExterne\('haiku'\)/)
})

// ─── 4. En reel : la passe de cron-messages ecrit sa ligne ──────────────────

function preparer ({ insert = () => ({ error: null }) } = {}) {
  const ecrits = []
  const client = {
    from (table) {
      const q = {
        select () { return q }, in () { return q }, not () { return q },
        eq () { return q }, order () { return q },
        limit () { return q },
        insert (ligne) { ecrits.push({ table, ligne }); return Promise.resolve(insert(ligne)) },
        upsert (ligne) { ecrits.push({ table, op: 'upsert', ligne }); return Promise.resolve({ error: null }) },
        delete () { return { lt: async () => ({ error: null }) } },
        maybeSingle: async () => ({ data: null, error: null }),
        // ⚠ LE FAUX CLIENT PASSE PAR `fetch`, COMME LE VRAI. Mesure du
        // 22 octobre 2026 : `@supabase/postgrest-js` resout `fetch` au moment
        // de la requete. Sans cet aller-retour, la ligne de mesure serait
        // verte avec zero requete partout — un test vert pour la mauvaise
        // raison, et c'est tout ce que ce fichier doit empecher.
        async then (ok, ko) {
          try { await globalThis.fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`) } catch {}
          return Promise.resolve({ data: [], error: null }).then(ok, ko)
        },
      }
      return q
    },
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../api/cron-messages', '../lib/cron-stats', '../lib/metriques-cron']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { ecrits }
}

function reponse () {
  const r = { code: 200, body: null }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}

async function passer (prepa = {}) {
  const etat = preparer(prepa)
  const avant = process.env.CRON_SECRET
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' })
  process.env.CRON_SECRET = 'secret-de-test'
  try {
    const handler = require('../api/cron-messages')
    const res = reponse()
    await handler({ method: 'POST', query: {}, headers: { authorization: 'Bearer secret-de-test' } }, res)
    return { res, ...etat }
  } finally {
    if (avant === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = avant
    try { require('../lib/metriques-cron').retirerLeCompteur() } catch {}
    globalThis.fetch = vraiFetch
  }
}

test('une passe de cron-messages ecrit UNE ligne de mesure, avec ses taches', async () => {
  const { res, ecrits } = await passer()
  assert.equal(res.code, 200)
  const lignes = ecrits.filter(e => e.table === 'cron_stats' && !e.op)
  assert.equal(lignes.length, 1)
  const ligne = lignes[0].ligne
  assert.equal(ligne.cron, 'cron-messages')
  assert.ok(Number.isFinite(ligne.duree_ms))
  const noms = ligne.taches.map(t => t.nom)
  assert.ok(noms.includes('lecture_biens'), `taches vues : ${noms.join(', ')}`)
  // ⚠ LA REQUETE DE LA TACHE EST COMPTEE, ET SUR LA BONNE TACHE. Le client de
  // ce module est cree AU CHARGEMENT, bien avant l'ouverture du passage :
  // c'est le cas qui comptait zero si l'interception se posait trop tard.
  const lecture = ligne.taches.find(t => t.nom === 'lecture_biens')
  assert.equal(lecture.req, 1)
  assert.equal(ligne.requetes >= 1, true)
})

test('⚠ UNE BASE QUI PEND NE RETIENT PAS LA PASSE PLUS DE QUELQUES SECONDES', async () => {
  // ⚠ DEFAUT QUE J'AI INTRODUIT EN CORRIGEANT LA REVIEW, et c'est pour ca que
  // ce test existe en REEL et pas en structurel. Le correctif donnait a
  // l'ecriture « le reliquat du budget » — 59 s moins la duree du cycle. Sur
  // une passe rapide, ca fait 58 s d'attente pour une insertion qui pend :
  // PLUS LONG qu'avant la review, dont le constat 2 venait justement de borner
  // cette attente. La borne est le MINIMUM des deux : ce qui reste avant le
  // mur, et ce qu'une ecriture saine met.
  const avant = Date.now()
  const { res } = await passer({ insert: () => new Promise(() => {}) })
  const mis = Date.now() - avant
  assert.equal(res.code, 200)
  assert.ok(mis < 6000, `la passe a rendu en ${mis} ms — l attente n est pas bornee`)
})

test('⚠ UNE MESURE QUI NE PEUT PAS S ECRIRE NE CHANGE RIEN A LA PASSE', async () => {
  // L'exigence de Thierry, eprouvee au point de montage : la base refuse
  // l'insertion, et la passe rend exactement la meme chose.
  const normal = await passer()
  // ⚠ ET IL FAUT DIRE QUE LA MESURE EXISTE, sinon ce test resterait vert le
  // jour ou on retirerait tout le lot : deux passes sans aucune ecriture
  // rendent evidemment le meme bilan. Contre-epreuve faite hors de l'arbre :
  // c'etait le seul test de ce fichier qui passait contre le code d'avant.
  assert.ok(normal.ecrits.some(e => e.table === 'cron_stats'), 'la passe normale ecrit sa mesure')
  const casse = await passer({ insert: () => { throw new Error('base en panne') } })
  assert.equal(casse.res.code, 200)
  assert.equal(casse.res.body.ok, true)
  assert.deepEqual(
    { ...casse.res.body, ms: 0 },
    { ...normal.res.body, ms: 0 },
    'le bilan rendu est identique, a la duree pres')
})
