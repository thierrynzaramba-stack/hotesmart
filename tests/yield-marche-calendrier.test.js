// tests/yield-marche-calendrier.test.js — la page « Le marche » (V2.3.4) et sa
// vue d'API : LECTURE SEULE, UN LOGEMENT → SON MARCHE, deux echelles.
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - ⚠ SECURITE (review du 24 septembre 2026) : une vue qui rendait les
//     calendriers de TOUS les marches a toute session — la commune des autres
//     clients, presentee comme « le marche de votre commune » ;
//   - une page qui ecrirait (POST, PUT, DELETE) ou appellerait AirROI ;
//   - une vue qui lirait autre chose que le lien et le calendrier ;
//   - le calendrier le plus recent mal choisi (le simulacre TRIE vraiment :
//     sans l'`order`, le test rougit).
//
// ⚠ REECRIT LE 24 SEPTEMBRE 2026 (regle 17) : la premiere version exigeait
// une vue SANS logement — c'etait la faille. Le test « aucun ecran existant
// modifie » par diff git est RETIRE (review) : il dependait d'`origin`, lisait
// l'arbre de travail partage, et ne verifiait plus rien apres merge. La
// garantie se tient a la review.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const RACINE = path.join(__dirname, '..')
const PAGE = fs.readFileSync(path.join(RACINE, 'apps', 'yield', 'marche.html'), 'utf8')

test('LE TEST QUI COMPTE : la page est en lecture seule — des GET sur la vue du marche, la liste des logements, rien d autre', () => {
  const appels = [...PAGE.matchAll(/fetch\(\s*([`'"])([^`'"]*)/g)].map(m => m[2])
  assert.ok(appels.length >= 1)
  for (const u of appels) assert.ok(u.startsWith('/api/yield-marche?vue=calendrier&property_id='), `appel inattendu : ${u}`)
  assert.ok(!/method\s*:/.test(PAGE), 'aucune methode autre que GET')
  assert.ok(!/api\.airroi/i.test(PAGE), 'aucun appel AirROI')
  const tables = [...PAGE.matchAll(/supabase\.from\(\s*'([^']+)'/g)].map(m => m[1])
  assert.deepEqual(tables, ['properties'], 'la base ne sert qu a lister les logements du compte')
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(PAGE))
})

test('LE TEST QUI COMPTE : la page dit en tete ce qu elle est — une estimation du marche, pas un prix, qui ne pilote rien', () => {
  const tete = PAGE.slice(PAGE.indexOf('id="mc-avertir"'), PAGE.indexOf('id="mc-choix"'))
  assert.match(tete, /Une estimation du marché, pas un prix/)
  assert.match(tete, /ne pilote rien/)
})

test('LE TEST QUI COMPTE : deux echelles, jamais une — deux palettes, deux libelles, aucun tri commun', () => {
  assert.match(PAGE, /Échelle du pacing/)
  assert.match(PAGE, /Échelle mensuelle — ne se compare pas à celle du pacing/)
  assert.match(PAGE, /\.p-basse[\s\S]*\.m-basse/)
  assert.ok(!/\.sort\(/.test(PAGE), 'aucun tri de saisons dans la page')
})

// Un simulacre de Supabase qui APPLIQUE `eq`, `order` et `limit`.
function base (tables) {
  const lus = []
  return { lus, client: { from: t => {
    lus.push(t)
    let lignes = [...(tables[t] || [])]
    const q = {
      select: () => q,
      eq: (k, v) => { lignes = lignes.filter(l => l[k] === v); return q },
      order: (k, { ascending }) => { lignes = [...lignes].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (ascending ? 1 : -1)); return q },
      limit: n => Promise.resolve({ data: lignes.slice(0, n), error: null })
    }
    return q
  } } }
}

async function appeler (query, tables, garde = { ok: true, bien: { id: 'BIEN-A' } }) {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'factice-non-secret'
  const cheminGarde = require.resolve(path.join(RACINE, 'lib', 'require-permission'))
  const vraie = require(cheminGarde)
  const cheminSb = require.resolve('@supabase/supabase-js')
  const vraiSb = require(cheminSb)
  const gardes = []
  const b = base(tables)
  let minuterie
  try {
    require.cache[cheminGarde].exports = { ...vraie, requirePermission: async (req, res, o) => { gardes.push(o); return garde } }
    require.cache[cheminSb].exports = { ...vraiSb, createClient: () => b.client }
    delete require.cache[require.resolve(path.join(RACINE, 'api', 'yield-marche'))]
    const api = require(path.join(RACINE, 'api', 'yield-marche'))
    const reponse = await Promise.race([
      new Promise(resolve => {
        let code = 200
        const res = { status (c) { code = c; return res }, setHeader () {}, json: corps => resolve({ code, corps }) }
        const fin = api({ method: 'GET', query, headers: {} }, res)
        // Garde refusee : la vraie garde repond elle-meme ; le simulacre non.
        Promise.resolve(fin).then(() => resolve({ code, corps: null }))
      }),
      new Promise((resolve, reject) => { minuterie = setTimeout(() => reject(new Error('pas de reponse')), 5000) })
    ])
    return { ...reponse, gardes, lus: b.lus }
  } finally {
    clearTimeout(minuterie)
    require.cache[cheminGarde].exports = vraie
    require.cache[cheminSb].exports = vraiSb
  }
}

const TABLES = {
  marche_biens: [{ property_id: 'BIEN-A', pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre' }],
  marche_calendrier: [
    { pays: 'France', region: 'Occitania', localite: 'Toulouse', capture_le: '2026-12-01', calcule_le: '2026-12-01T00:00:00Z', methode: 'b' },
    { pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre', capture_le: '2026-09-24', calcule_le: '2026-09-24T00:00:00Z', methode: 'a' },
    { pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre', capture_le: '2026-10-24', calcule_le: '2026-10-24T00:00:00Z', methode: 'b' }]
}

test('LE TEST QUI COMPTE (securite) : la vue exige un logement, sous sa garde, et ne rend QUE le marche de ce logement', async () => {
  const sans = await appeler({ vue: 'calendrier' }, TABLES)
  assert.equal(sans.code, 400)
  assert.deepEqual(sans.lus, [], 'rien n est lu sans logement')
  const r = await appeler({ vue: 'calendrier', property_id: 'BIEN-A' }, TABLES)
  assert.deepEqual(r.gardes, [{ domaine: 'reservations', niveau: 'read', bien: 'BIEN-A', bienRequis: true }])
  assert.deepEqual(r.lus, ['marche_biens', 'marche_calendrier'])
  assert.equal(r.corps.calendrier.localite, 'Bagnères-de-Bigorre')
  assert.equal(r.corps.calendrier.capture_le, '2026-10-24', 'le plus recent de CE marche')
  assert.ok(!JSON.stringify(r.corps).includes('Toulouse'), 'jamais la commune d un autre client, meme plus recente')
})

test('un logement sans marche relie : « marche inconnu », jamais un autre marche ; garde refusee : rien n est lu', async () => {
  const r = await appeler({ vue: 'calendrier', property_id: 'BIEN-B' }, TABLES, { ok: true, bien: { id: 'BIEN-B' } })
  assert.equal(r.corps.etat, 'marche_inconnu')
  assert.ok(!('calendrier' in r.corps))
  const refus = await appeler({ vue: 'calendrier', property_id: 'BIEN-A' }, TABLES, { ok: false })
  assert.deepEqual(refus.lus, [])
})
