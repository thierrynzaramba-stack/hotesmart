// tests/beds24-jeton-expiration.test.js
//
// ⚠ LE DEFAUT : le jeton Beds24 etait renouvele a CHAQUE passage du cron, soit
// 288 fois par jour, sans jamais regarder s'il etait encore valide.
// Mesure du 23 octobre 2026 sur 209 passages depuis la borne du regroupement :
// `refresh_tokens` cumule 184 SECONDES — deuxieme poste de TEMPS du cron,
// alors qu'il n'est que 10e en requetes (2 par passage). Et le parc ne compte
// AUCUN bien Beds24 actif : on renouvelait un jeton que rien d'autre n'utilise.
//
// LA REGLE (Thierry, 23 octobre 2026) : stocker l'heure d'expiration REELLE
// donnee par `expiresIn`, et ne renouveler que lorsqu'il reste moins de
// 30 minutes, quel que soit le cas.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const MIN = 60 * 1000
const H = 60 * MIN
const T0 = Date.parse('2026-10-23T12:00:00Z')
const dans = (ms) => new Date(T0 + ms).toISOString()

// ═══════════════════════════════════════════════════════════════════════════
// LA DECISION, PURE
// ═══════════════════════════════════════════════════════════════════════════

const { doitRenouveler, dureeDeVieMs, MARGE_MAX_MS, VIE_DE_REPLI_MS } =
  require('../lib/cron-beds24')

test('LE TEST QUI COMPTE : tout doute renouvelle', () => {
  // Un jeton Beds24 expire casse TOUTE la synchro de l hote : economiser un
  // appel ne vaut pas ce risque. C est la seule asymetrie, et elle est voulue.
  assert.equal(doitRenouveler(null, T0), true, 'heure inconnue (premier passage apres la migration)')
  assert.equal(doitRenouveler(undefined, T0), true)
  assert.equal(doitRenouveler('', T0), true)
  assert.equal(doitRenouveler('pas-une-date', T0), true, 'illisible')
})

test('LE TEST QUI COMPTE : la borne des 30 minutes, de part et d autre', () => {
  assert.equal(doitRenouveler(dans(2 * H), T0), false, 'deux heures restantes : on ne touche a rien')
  assert.equal(doitRenouveler(dans(31 * MIN), T0), false, '31 minutes : encore trop tot')
  assert.equal(doitRenouveler(dans(29 * MIN), T0), true, '29 minutes : on renouvelle')
  assert.equal(doitRenouveler(dans(-1 * H), T0), true, 'deja expire : evidemment')
})

test('LE TEST QUI COMPTE : une duree de vie COURTE ne restaure pas les 288 appels', () => {
  // ⚠ Si `expiresIn` valait 600 s, « il reste moins de 30 minutes » serait
  // TOUJOURS vrai et on repartirait a chaque cycle — le defaut qu on corrige,
  // par la porte d a cote. La marge est donc le minimum de 30 min et de la
  // moitie de la duree de vie.
  const vie = 10 * MIN
  assert.equal(doitRenouveler(dans(6 * MIN), T0, vie), false,
    'il reste 6 min sur 10 : plus de la moitie, on attend')
  assert.equal(doitRenouveler(dans(4 * MIN), T0, vie), true,
    'il reste 4 min sur 10 : moins de la mi-vie, on renouvelle')
  // Et sans la borne, la regle des 30 minutes aurait dit « renouvelle » dans
  // les DEUX cas.
  assert.equal(doitRenouveler(dans(6 * MIN), T0), true,
    'contre-preuve : sans la duree de vie, 6 minutes declenchent bien')
})

test('LE TEST QUI COMPTE : expiresIn se lit, et une valeur absurde retombe sur le repli', () => {
  assert.deepEqual(dureeDeVieMs(3600), { ms: 3600 * 1000, mesuree: true },
    'l exemple de la doc Beds24 : 3600 s')
  assert.deepEqual(dureeDeVieMs(86400), { ms: 86400 * 1000, mesuree: true },
    'ce que la doc annonce : 24 h')
  for (const absurde of [undefined, null, 0, -1, 'x', NaN, 99 * 24 * 3600]) {
    const r = dureeDeVieMs(absurde)
    assert.equal(r.mesuree, false, `${absurde} doit retomber sur le repli`)
    assert.equal(r.ms, VIE_DE_REPLI_MS)
  }
})

test('LE TEST QUI COMPTE : la regle des 30 min garantit SEULE un renouvellement par jour', () => {
  // ⚠ C EST LA VERIFICATION DE LA SECONDE EXIGENCE DE THIERRY, et elle montre
  // qu aucun code de maintien en vie n est a ecrire. Le jeton de
  // renouvellement meurt apres 30 jours SANS USAGE ; il faut donc l utiliser au
  // moins une fois par jour. On calcule l intervalle que la regle impose, pour
  // les deux durees de vie que la doc laisse possibles.
  for (const vieS of [86400, 3600]) {
    const vie = vieS * 1000
    const marge = Math.min(MARGE_MAX_MS, Math.floor(vie / 2))
    const intervalle = vie - marge                 // on renouvelle a vie - marge
    const parJour = (24 * H) / intervalle
    assert.ok(parJour >= 1,
      `duree de vie ${vieS} s : ${parJour.toFixed(2)} renouvellement(s) par jour — ` +
      'il en faut au moins un pour que le jeton de renouvellement ne meure pas')
  }
  // Et l ordre de grandeur, pour que le gain soit lisible : 288 appels par jour
  // avant, contre 1,02 si la duree de vie est de 24 h.
  const avant = (24 * H) / (5 * MIN)
  assert.equal(avant, 288)
  const apres = (24 * H) / (86400 * 1000 - MARGE_MAX_MS)
  assert.ok(apres < 1.1 && apres >= 1, `${apres.toFixed(2)} par jour avec une vie de 24 h`)
})

// ═══════════════════════════════════════════════════════════════════════════
// LA FONCTION, TRAVERSEE
// ═══════════════════════════════════════════════════════════════════════════

function charger ({ lignes = [], erreurLecture = null, erreurMaj = null, reponse = null }) {
  const vu = { fetchs: 0, majs: [] }
  const client = {
    from () {
      const q = {
        select () { return q },
        not () { return q },
        update (champs) { vu.majs.push(champs); return { eq: async () => ({ error: erreurMaj }) } },
        then (ok, ko) {
          return Promise.resolve(
            erreurLecture ? { data: null, error: { message: erreurLecture } } : { data: lignes, error: null }
          ).then(ok, ko)
        }
      }
      return q
    }
  }
  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client
  for (const m of ['../lib/cron-beds24', '../lib/cron-shared']) {
    try { delete require.cache[require.resolve(m)] } catch {}
  }
  const vraiFetch = global.fetch
  global.fetch = async () => { vu.fetchs++; return { json: async () => (reponse || { token: 'neuf', expiresIn: 86400 }) } }
  const mod = require('../lib/cron-beds24')
  require.cache[absSdk].exports.createClient = vraiCreate
  return { mod, vu, restaurer: () => { global.fetch = vraiFetch } }
}

test('LE TEST QUI COMPTE : un jeton encore valide ne declenche AUCUN appel', async () => {
  const h = charger({ lignes: [{ user_id: 'u', refresh_token: 'r', token_expire_le: dans(5 * H) }] })
  try {
    const bilan = await h.mod.refreshBeds24Tokens({ maintenant: T0 })
    assert.equal(h.vu.fetchs, 0, 'c est tout l objet du lot : zero appel a Beds24')
    assert.equal(bilan.sautes, 1)
    assert.equal(bilan.renouveles, 0)
  } finally { h.restaurer() }
})

test('LE TEST QUI COMPTE : un renouvellement ENREGISTRE l expiration reelle', async () => {
  const h = charger({
    lignes: [{ user_id: 'u', refresh_token: 'r', token_expire_le: dans(10 * MIN) }],
    reponse: { token: 'neuf', expiresIn: 3600 }
  })
  try {
    const bilan = await h.mod.refreshBeds24Tokens({ maintenant: T0 })
    assert.equal(h.vu.fetchs, 1)
    assert.equal(bilan.renouveles, 1)
    const maj = h.vu.majs[0]
    assert.equal(maj.api_key, 'neuf')
    assert.equal(maj.token_expire_le, dans(3600 * 1000),
      'l expiration vient de expiresIn, pas d une constante du code')
    assert.equal(maj.token_renouvele_le, new Date(T0).toISOString())
  } finally { h.restaurer() }
})

test('LE TEST QUI COMPTE : une lecture tombee ne se lit pas « aucune cle »', async () => {
  // Sans ce test, une panne de 30 jours laisserait mourir le jeton de
  // renouvellement en silence — et rien ne le dirait avant que la synchro tombe.
  const h = charger({ erreurLecture: 'timeout' })
  try {
    const bilan = await h.mod.refreshBeds24Tokens({ maintenant: T0 })
    assert.equal(h.vu.fetchs, 0)
    assert.equal(bilan.erreur, 'timeout', 'la cause remonte')
  } finally { h.restaurer() }
})

test('LE TEST QUI COMPTE : une ECRITURE ratee ne compte pas comme un renouvellement', async () => {
  // Le jeton neuf vivrait en memoire et la base garderait l ancien avec son
  // ancienne expiration : on renouvellerait a chaque cycle sans s en apercevoir.
  const h = charger({
    lignes: [{ user_id: 'u', refresh_token: 'r', token_expire_le: null }],
    erreurMaj: { message: 'colonne absente' }
  })
  try {
    const bilan = await h.mod.refreshBeds24Tokens({ maintenant: T0 })
    assert.equal(h.vu.fetchs, 1, 'l appel a bien eu lieu')
    assert.equal(bilan.renouveles, 0, 'mais rien n est enregistre, donc rien n est renouvele')
  } finally { h.restaurer() }
})

test('LE TEST QUI COMPTE : une expiration INCONNUE renouvelle (premier passage)', async () => {
  const h = charger({ lignes: [{ user_id: 'u', refresh_token: 'r', token_expire_le: null }] })
  try {
    const bilan = await h.mod.refreshBeds24Tokens({ maintenant: T0 })
    assert.equal(h.vu.fetchs, 1, 'apres la migration, la colonne est nulle : on renouvelle')
    assert.equal(bilan.renouveles, 1)
  } finally { h.restaurer() }
})

test('LE TEST QUI COMPTE : sans la migration, on renouvelle comme AVANT le lot', async () => {
  // ⚠ LA FENETRE ENTRE LE PUSH ET LA MIGRATION, ET ELLE EST DANGEREUSE ICI.
  // Dans ce depot la migration se colle a la main APRES le push. Un `select`
  // qui nomme `token_expire_le` echoue alors en entier (42703) — et mon propre
  // garde-fou « une lecture tombee n est pas aucune cle » rendrait
  // `{ erreur }`, donc PLUS AUCUN RENOUVELLEMENT. Le jeton de renouvellement
  // meurt apres 30 jours sans usage : la fenetre de deploiement serait une
  // bombe a retardement de trente jours.
  let appels = 0
  const client = {
    from () {
      const q = {
        select (cols) { q._cols = String(cols); return q },
        not () { return q },
        update (champs) { q._champs = champs; return { eq: async () => ({ error: null }) } },
        then (ok, ko) {
          appels++
          if (q._cols && q._cols.includes('token_expire_le')) {
            return Promise.resolve({ data: null, error: { code: '42703', message: 'column api_keys.token_expire_le does not exist' } }).then(ok, ko)
          }
          return Promise.resolve({ data: [{ user_id: 'u', refresh_token: 'r' }], error: null }).then(ok, ko)
        }
      }
      return q
    }
  }
  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client
  for (const m of ['../lib/cron-beds24', '../lib/cron-shared']) {
    try { delete require.cache[require.resolve(m)] } catch {}
  }
  const vraiFetch = global.fetch
  let fetchs = 0
  global.fetch = async () => { fetchs++; return { json: async () => ({ token: 'neuf', expiresIn: 86400 }) } }
  try {
    const mod = require('../lib/cron-beds24')
    const bilan = await mod.refreshBeds24Tokens({ maintenant: T0 })
    assert.equal(bilan.sansExpiration, true, 'le repli est NOMME dans le bilan, pas silencieux')
    assert.equal(bilan.erreur, undefined, 'une colonne absente n est pas une panne')
    assert.equal(fetchs, 1, 'on renouvelle quand meme — comme avant le lot')
    assert.equal(bilan.renouveles, 1)
  } finally {
    global.fetch = vraiFetch
    require.cache[absSdk].exports.createClient = vraiCreate
    for (const m of ['../lib/cron-beds24', '../lib/cron-shared']) {
      try { delete require.cache[require.resolve(m)] } catch {}
    }
  }
})

// ─── Les constats de la review du 23 octobre 2026 ────────────────────────────

test('LE TEST QUI COMPTE : le CHEMIN REEL honore une duree de vie courte', async () => {
  // ⚠ CONSTAT 1, ET C'EST LE PLUS DUR DE CETTE REVIEW.
  // Mon garde-fou « une duree de vie courte ne restaure pas les 288 appels »
  // etait INERTE en production : le site d'appel faisait
  // `doitRenouveler(expire_le, maintenant)` — deux arguments — donc la marge
  // retombait toujours a 30 minutes. Et mon test du dessus passe le troisieme
  // argument A LA MAIN : il certifiait un chemin que le code ne prenait pas.
  // Un test vert au-dessus d un defaut vivant.
  // Mesure de la review : avec `expiresIn: 1800`, 12 appels sur 12 passages —
  // exactement le defaut que ce lot existe pour supprimer.
  //
  // Ici on traverse `refreshBeds24Tokens`, et la duree de vie se RETROUVE par
  // difference entre les deux colonnes.
  const vie = 30 * MIN                       // marge = min(30 min, 15 min) = 15 min
  const h = charger({
    lignes: [{
      user_id: 'u', refresh_token: 'r',
      token_renouvele_le: dans(-10 * MIN),   // renouvele il y a 10 min
      token_expire_le: dans(20 * MIN)        // il reste 20 min sur une vie de 30
    }]
  })
  try {
    const bilan = await h.mod.refreshBeds24Tokens({ maintenant: T0 })
    assert.equal(h.vu.fetchs, 0,
      'il reste 20 min sur une vie de 30 : plus que la mi-vie, on n appelle PAS. ' +
      'Avec la marge de 30 min par defaut, ce cas appelait a chaque cycle.')
    assert.equal(bilan.sautes, 1)
  } finally { h.restaurer() }
  // Et la contre-partie : sous la mi-vie, on renouvelle bien.
  const h2 = charger({
    lignes: [{
      user_id: 'u', refresh_token: 'r',
      token_renouvele_le: dans(-20 * MIN),
      token_expire_le: dans(10 * MIN)        // il reste 10 min sur 30
    }]
  })
  try {
    await h2.mod.refreshBeds24Tokens({ maintenant: T0 })
    assert.equal(h2.vu.fetchs, 1, 'sous la mi-vie, on renouvelle')
  } finally { h2.restaurer() }
  assert.ok(vie > 0)
})

test('LE TEST QUI COMPTE : `forcer` renouvelle meme un jeton tout neuf', () => {
  // ⚠ CONSTAT 5. `scripts/backfill-beds24-host.js` tient un jeton frais AVANT
  // un parcours de plusieurs heures. Depuis que le renouvellement est
  // conditionnel, un appel nu peut SAUTER et laisser le script demarrer sur un
  // jeton qui n a plus que trente minutes : il tomberait en 401 au milieu.
  const h = charger({ lignes: [{ user_id: 'u', refresh_token: 'r', token_expire_le: dans(20 * H) }] })
  return h.mod.refreshBeds24Tokens({ maintenant: T0, forcer: true })
    .then(bilan => {
      assert.equal(h.vu.fetchs, 1, 'forcer ignore l expiration')
      assert.equal(bilan.renouveles, 1)
    })
    .finally(() => h.restaurer())
})

test('LE TEST QUI COMPTE : le backfill FORCE, et le cron non', () => {
  // La propriete, pas la ligne : le script doit passer `forcer`, et api/cron.js
  // ne doit jamais le faire — ce serait annuler le lot.
  const fs = require('node:fs')
  const net = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert.match(net('scripts/backfill-beds24-host.js'), /refreshBeds24Tokens\(\s*\{[^}]*forcer:\s*true/,
    'le backfill tourne des heures : il lui faut un jeton vraiment frais')
  assert.ok(!/refreshBeds24Tokens\(\s*\{[^}]*forcer/.test(net('api/cron.js')),
    'le cron ne force JAMAIS : ce serait annuler le lot')
})

test('LE TEST QUI COMPTE : une duree de vie au-dela du contrat retombe sur le repli', () => {
  // ⚠ CONSTAT 3. Si Beds24 rendait la duree de vie du jeton de RENOUVELLEMENT
  // (604 800 s, une semaine), on aurait enregistre une expiration a une
  // semaine, saute le renouvellement pendant sept jours alors que le jeton
  // d ACCES meurt a 24 h, et laisse le jeton de renouvellement deriver vers sa
  // mort par inactivite.
  assert.equal(dureeDeVieMs(604800).mesuree, false, 'une semaine n est pas un contrat annonce')
  assert.equal(dureeDeVieMs(604800).ms, VIE_DE_REPLI_MS)
  assert.equal(dureeDeVieMs(86400).mesuree, true, '24 h reste accepte')
  assert.equal(dureeDeVieMs(25 * 3600).mesuree, true, 'et une marge de tolerance au-dela')
})

test('LE TEST QUI COMPTE : les TROIS writers de api_key ecrivent l expiration', () => {
  // ⚠ CONSTAT 2, ET IL ETAIT UNE REGRESSION DE CE LOT. Des que
  // `token_expire_le` fait autorite sur « le jeton est-il vivant », un writer
  // qui ne la met pas a jour la rend MENTEUSE : le cron sauterait le
  // renouvellement sur un jeton mort pendant 22 h, chaque fetch Beds24
  // repondrait 401, et la synchro de l hote tomberait EN SILENCE. Avant le lot,
  // le renouvellement inconditionnel toutes les cinq minutes le masquait.
  const fs = require('node:fs')
  const net = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  const setup = net('api/beds24-setup.js')
  // Aucune ecriture NUE de api_key : tout passe par le point unique.
  const nues = [...setup.matchAll(/\.(update|upsert)\(\s*\{[^}]*api_key[^}]*\}/g)]
    .map(m => m[0].replace(/\s+/g, ' ').slice(0, 80))
  assert.deepEqual(nues, [],
    'ces ecritures nomment api_key sans passer par champsDuJeton :\n  ' + nues.join('\n  '))
  assert.match(setup, /champsDuJeton/, 'le point unique est bien utilise')
  // Et le point unique produit TOUJOURS les trois champs.
  const { champsDuJeton } = require('../lib/cron-beds24')
  const { champs } = champsDuJeton({ token: 'x', expiresIn: 3600 }, T0)
  assert.deepEqual(Object.keys(champs).sort(),
    ['api_key', 'token_expire_le', 'token_renouvele_le'])
})
