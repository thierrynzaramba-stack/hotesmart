// tests/menage-valide.test.js
// isMenageValidated : trouver le depart PRECEDENT d'un bien.
// Le code d'acces du voyageur suivant n'est envoye qu'apres validation du menage :
// rater ce depart precedent = envoyer le code sans attendre le menage.

// Plusieurs modules de la chaine creent un client Supabase AU CHARGEMENT
// (lib/record-message.js, lib/providers/seam.js). Des valeurs factices suffisent :
// toutes les lectures passent par le double de lib/cron-shared.js.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

// ⚠ `profils` PORTE LA VRAIE COLONNE : `pwa_token`. Depuis le 14 septembre, un
// jeton ne « couvre » un bien que si un profil ACTIF, en `access_mode = 'lien'`,
// porte ce jeton — sans quoi personne ne peut plus valider le menage et le code
// d'arrivee resterait bloque pour toujours. Un double qui ignorerait cette
// seconde lecture rendrait la garde indetectable : on pourrait la retirer sans
// qu'un test bronche.
function charger({ snapshots = [], tokens = [], profils = null, statut = null,
                   erreurProfils = null }) {
  const req = { order: null, lte: null, limit: null }
  // Par defaut, chaque jeton a un profil actif derriere lui : c'est l'etat
  // normal, et les tests ecrits AVANT cette garde doivent continuer de decrire
  // ce qu'ils decrivaient.
  const vivants = profils !== null ? profils
    : (tokens || []).map(t => ({ pwa_token: t.token })).filter(x => x.pwa_token)
  const table = (nom) => {
    const q = {
      select() { return q }, eq() { return q }, not() { return q },
      lte(col, val) { req.lte = { col, val }; return q },
      order(col, opts) { req.order = { col, ...opts }; return q },
      limit(n) { req.limit = n; return Promise.resolve({ data: snapshots }) },
      maybeSingle: async () => ({ data: nom === 'property_status' ? statut : null }),
      then(res, rej) {
        if (nom === 'profiles' && erreurProfils) {
          return Promise.resolve({ data: null, error: erreurProfils }).then(res, rej)
        }
        const data = nom === 'public_tokens' ? tokens
                   : nom === 'profiles' ? vivants : []
        return Promise.resolve({ data, error: null }).then(res, rej)
      }
    }
    return q
  }
  const abs = require.resolve(path.join(__dirname, '..', 'lib/cron-shared.js'))
  const m = new Module(abs)
  m.exports = { supabase: { from: table }, getPropertyMode: async () => 'auto', isAutomationPaused: async () => false }
  m.loaded = true
  require.cache[abs] = m

  delete require.cache[require.resolve('../lib/cron-arrival-code')]
  return { mod: require('../lib/cron-arrival-code'), req }
}

const snap = (departure, o = {}) => ({ snapshot: { provider: 'beds24', status: 'confirmed', departure, ...o } })

test('la requete trie par DATE DE DEPART, pas par updated_at', async () => {
  const { mod, req } = charger({ snapshots: [] })
  await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24')
  assert.strictEqual(req.order.col, 'snapshot->>departure',
    'trier par updated_at ne marchait que tant que le cron reecrivait toutes les lignes')
  assert.strictEqual(req.order.ascending, false)
  assert.strictEqual(req.order.nullsFirst, false, 'les lignes sans depart ne doivent pas occuper le lot')
})

test('la requete borne les departs a la date d\'arrivee', async () => {
  const { mod, req } = charger({ snapshots: [] })
  await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24')
  assert.deepStrictEqual(req.lte, { col: 'snapshot->>departure', val: '2026-09-10' })
})

test('aucun depart precedent -> premier voyageur, pas de menage requis', async () => {
  const { mod } = charger({ snapshots: [] })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true)
})

test('LE CAS PROTEGE : un depart precedent ancien bloque bien le code d\'acces', async () => {
  // Coeur de la correction. La resa terminee n'est plus reecrite par le cron ;
  // elle reste trouvee parce qu'on trie desormais sur sa DATE DE DEPART.
  // Un prestataire couvre le bien et aucun menage n'a ete valide -> on bloque.
  const { mod } = charger({
    snapshots: [snap('2026-09-08'), snap('2026-09-01'), snap('2026-08-15')],
    tokens: [{ token: 'tk-1', property_ids: [] }],   // token « tous les biens »
    statut: { last_menage_at: null }
  })
  const r = await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24')
  assert.strictEqual(r, false, 'depart precedent trouve + menage non valide -> code retenu')
})

test('sans depart precedent trouve, le code partirait sans attendre le menage', async () => {
  // Ce que produisait le tri par updated_at une fois les reecritures supprimees :
  // les resas terminees sortent du lot, plus de depart precedent, envoi immediat.
  const { mod } = charger({
    snapshots: [],                       // aucun depart precedent remonte
    tokens: [{ token: 'tk-1', property_ids: [] }],
    statut: { last_menage_at: null }
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true)
})

test('menage valide APRES le depart precedent -> code libere', async () => {
  const { mod } = charger({
    snapshots: [snap('2026-09-08')],
    tokens: [{ token: 'tk-1', property_ids: ['12345'] }],
    statut: { last_menage_at: '2026-09-09T10:00:00Z' }
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true)
})

test('menage valide AVANT le depart precedent -> code retenu', async () => {
  const { mod } = charger({
    snapshots: [snap('2026-09-08')],
    tokens: [{ token: 'tk-1', property_ids: ['12345'] }],
    statut: { last_menage_at: '2026-09-05T10:00:00Z' }
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), false)
})

test('aucun suivi menage sur le bien -> le code n\'est pas bloque', async () => {
  const { mod } = charger({
    snapshots: [snap('2026-09-08')],
    tokens: [],                          // aucun prestataire affecte
    statut: null
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true)
})

test('un jeton SANS profil actif ne couvre rien — sinon le code reste bloque pour toujours', async () => {
  // ⚠ LE CAS DANGEREUX, ET IL EST SILENCIEUX (REVIEW.md regle 8).
  // Depuis la fermeture du pont de convergence (14 septembre),
  // `api/menages-public.js` rend 401 a un lien sans profil actif : son porteur ne
  // peut plus appeler `markDone`, donc plus rien n'ecrit
  // `property_status.last_menage_at` — `markReady` en est le SEUL writer, et le
  // « marquer fait » de l'ecran hote ne vit que dans le localStorage.
  // Compter ce jeton comme « prestataire affecte » exigerait donc un menage que
  // PERSONNE ne peut plus valider : aucun code d'arrivee ne partirait plus sur ce
  // bien, pour tous les sejours suivants, et aucun ecran ne permettrait de
  // debloquer. On ne bloque pas au nom de quelqu'un qui n'existe pas.
  const { mod } = charger({
    snapshots: [snap('2026-09-08')],
    tokens: [{ token: 'orphelin', property_ids: ['12345'] }],
    profils: [],                         // aucun profil actif ne porte ce jeton
    statut: null
  })
  assert.strictEqual(
    await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true,
    'un lien orphelin ne doit pas retenir le code d\'arrivee du voyageur')
})

test('CONTRE-EPREUVE : le MEME jeton, avec un profil actif, bloque bien', async () => {
  // Sans ce test, le precedent passerait aussi si la couverture avait disparu
  // pour une tout autre raison. Meme fixture, une seule difference : quelqu'un
  // existe derriere le jeton.
  const { mod } = charger({
    snapshots: [snap('2026-09-08')],
    tokens: [{ token: 'vivant', property_ids: ['12345'] }],
    profils: [{ pwa_token: 'vivant' }],
    statut: null
  })
  assert.strictEqual(
    await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), false,
    'une prestataire reelle est affectee : le menage est exige')
})

test('PANNE de lecture des profils : le code ATTEND, il ne part pas', async () => {
  // ⚠ CONSTAT DE REVIEW, SUR UNE LECTURE QUE CE CHANTIER VENAIT D'AJOUTER.
  // Erreur avalee -> `profils` null -> aucun porteur actif -> `prestataireCouvre`
  // faux -> « ni prestataire ni menage valide, on ne bloque pas » -> le CODE
  // D'ARRIVEE part sans attendre le menage. Une garde qui s'ouvre sur une panne
  // n'est pas une garde. Le cas est ici un bien AVEC une prestataire reelle et
  // SANS `last_menage_at` : c'est celui qui tombe du mauvais cote.
  const { mod } = charger({
    snapshots: [snap('2026-09-08')],
    tokens: [{ token: 'vivant', property_ids: ['12345'] }],
    profils: [{ pwa_token: 'vivant' }],
    erreurProfils: { message: 'timeout' },
    statut: null
  })
  assert.strictEqual(
    await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), false,
    'sur une panne, on attend le menage — on n\'ouvre pas le logement')
})

test('les sejours non actifs sont ignores dans la recherche', async () => {
  const { mod } = charger({
    snapshots: [snap('2026-09-08', { status: 'cancelled' }), snap('2026-09-07', { status: 'blocked' })]
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true,
    'une annulation ou un blocage ne compte pas comme sejour precedent')
})

test('lignes anterieures a l\'unification : le provider par defaut s\'applique', async () => {
  const { mod } = charger({
    snapshots: [{ snapshot: { status: 'black', departure: '2026-09-08' } }]   // legacy, sans provider
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true,
    'un blocage proprietaire legacy ne doit pas compter comme sejour precedent')
})

test('la reservation en cours ne se compte pas elle-meme', async () => {
  const { mod } = charger({ snapshots: [{ snapshot: { provider: 'beds24', status: 'confirmed', departure: '2026-09-10', id: '77' } }] })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true)
})
