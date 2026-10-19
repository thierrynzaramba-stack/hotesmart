// tests/stop-sell-non-confirme.test.js
// UNE FERMETURE NON CONFIRMEE EST UN ECHEC, ET ELLE SONNE.
//
// ⚠ POURQUOI C'EST LA PRIORITE ABSOLUE DU CHANTIER (decision de Thierry).
// `lib/channel-availability.js` restitue l'intention de l'hote apres chaque
// poussee de stock — « ECRIRE LA DISPONIBILITE LEVE LE STOP-SELL », mesure du
// 7 septembre 2026 en production : quatre nuits d'un bien volontairement ferme
// sont redevenues vendables sur Airbnb et Booking.com.
//
// Cette restitution se croit faite sur n'importe quel 2xx. Un `200` portant une
// page HTML — URL mal reglee, page d'erreur d'un pare-feu, maintenance —
// journalise donc « stop_sell restitue », et l'incident `stop_sell_perdu` NE
// PART PAS. Des dates fermees redeviennent vendables EN SILENCE, et la
// surreservation suit.
//
// ⚠ ET LA COPIE DE `channelCall` DE CE FICHIER N'A AUCUNE DES GARDES DE
// L'ORIGINAL : ni rattrapage des pannes reseau, ni reessai sur 429/5xx. Un
// `fetch` qui leve y remonte NU — `lib/calendrier-writer.js:674` le documente
// deja (« un appel reseau non protege »). Un appel qui leve n'est pas davantage
// une confirmation.
//
// ⚠ ON NE SORT JAMAIS : le partenaire ET la base sont simules par `global.fetch`,
// que `supabase-js` utilise lui aussi. Aucune ecriture, nulle part.

process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = 'cle-de-test'
process.env.CHANNEL_BASE_URL = 'http://faux.partenaire/api/v1'
process.env.CHANNEL_API_KEY = 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')

const BIEN = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
               user_id: '11111111-1111-1111-1111-111111111111',
               provider_rate_plan_id: 'RP-1' }
const PROP = 'P-1'

// Un monde simule : le partenaire repond ce qu'on lui dit, la base rend la
// memoire d'intention, et on retient les incidents poses.
function monde ({ partenaire, intention = [{ date: '2026-11-01', stop_sell: true },
                                           { date: '2026-11-02', stop_sell: true }] }) {
  const vrai = global.fetch
  const incidents = []
  const appelsPartenaire = []
  global.fetch = async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('faux.partenaire')) {
      appelsPartenaire.push({ url: u, methode: opts.method, corps: opts.body })
      if (partenaire instanceof Error) throw partenaire
      return new Response(partenaire.statut === 204 ? null : partenaire.corps,
        { status: partenaire.statut,
          headers: { 'content-type': partenaire.type || 'application/json' } })
    }
    if (u.includes('calendar_inventory')) {
      return new Response(JSON.stringify(intention),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('automation_incidents')) {
      let corps = {}
      try { corps = JSON.parse(opts.body || '{}') } catch {}
      incidents.push(Array.isArray(corps) ? corps[0] : corps)
      return new Response(JSON.stringify([{ id: 'inc-1' }]),
        { status: 201, headers: { 'content-type': 'application/json' } })
    }
    // Tout le reste de la base : une reponse vide et valide.
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { incidents, appelsPartenaire, restore: () => { global.fetch = vrai } }
}

const HTML = { statut: 200, type: 'text/html',
               corps: '<!DOCTYPE html><html>Service Unavailable</html>' }
const CONFIRME = { statut: 200,
                   corps: JSON.stringify({ data: [{ id: 'tache-42', type: 'task' }] }) }

function charger () {
  delete require.cache[require.resolve('../lib/channel-availability')]
  delete require.cache[require.resolve('../lib/founder-notify')]
  return require('../lib/channel-availability')
}

// ─── Le test qui compte ────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : un 200 + HTML sur la reaffirmation fait SONNER stop_sell_perdu', async () => {
  const m = monde({ partenaire: HTML })
  try {
    const { reaffirmerStopSell } = charger()
    await reaffirmerStopSell(BIEN, PROP, '2026-11-01', '2026-11-02', 'essai')
    assert.equal(m.appelsPartenaire.length >= 1, true, 'le partenaire n a pas ete appele')
    const perdus = m.incidents.filter(i => i.type === 'stop_sell_perdu')
    assert.equal(perdus.length, 1,
      `${perdus.length} incident(s) stop_sell_perdu : des dates fermees sont redevenues `
      + 'vendables en silence')
    const d = JSON.stringify(perdus[0].detail || {})
    assert.match(d, /2026-11-01/, 'l incident ne nomme pas les dates concernees')
  } finally { m.restore() }
})

test('LE TEST QUI COMPTE : une reponse CONFIRMEE ne sonne pas', async () => {
  // ⚠ LA CONTRE-EPREUVE, ET ELLE PESE AUTANT. `stop_sell_perdu` dit « des dates
  // fermees sont redevenues vendables » : c'est l'alarme la plus grave du
  // systeme. Si elle sonne sur une restitution reussie, elle devient du bruit,
  // et l'anti-spam masquera la vraie le jour ou elle arrivera.
  const m = monde({ partenaire: CONFIRME })
  try {
    const { reaffirmerStopSell } = charger()
    await reaffirmerStopSell(BIEN, PROP, '2026-11-01', '2026-11-02', 'essai')
    const perdus = m.incidents.filter(i => i.type === 'stop_sell_perdu')
    assert.deepEqual(perdus, [], 'une restitution REUSSIE a fait sonner l alarme')
  } finally { m.restore() }
})

test('LE TEST QUI COMPTE : un appel qui LEVE est un echec, pas une confirmation', async () => {
  // La copie de `channelCall` de ce fichier n'a pas le rattrapage de l'original :
  // une panne reseau y remonte nue. Un appel qui leve n'est pas une confirmation —
  // et il ne doit pas non plus faire tomber l'appelant sans rien dire.
  const m = monde({ partenaire: new Error('ECONNRESET') })
  try {
    const { reaffirmerStopSell } = charger()
    await reaffirmerStopSell(BIEN, PROP, '2026-11-01', '2026-11-02', 'essai')
    const perdus = m.incidents.filter(i => i.type === 'stop_sell_perdu')
    assert.equal(perdus.length, 1, 'une panne reseau n a pas fait sonner l alarme')
  } finally { m.restore() }
})

test('LE TEST QUI COMPTE : un 200 sans identifiant de tache ne SONNE PAS — et c est delibere', async () => {
  // ⚠ CE TEST FIGE UNE DECISION, PAS UNE CERTITUDE, et il faut le lire comme ca.
  // Le POST ARI rend un identifiant de tache — Channex applique en differe —,
  // donc un 200 sans identifiant ne PROUVE pas que la fermeture a ete prise.
  // Mais la forme reelle du `POST /restrictions` n'est PAS mesuree :
  // `lib/calendrier-writer.js:127` lit `data[0].id` en tolerant `null`, aucune
  // doc ne la confirme, et le faux partenaire du test historique de ce fichier
  // rend `{ data: {} }`, sans identifiant.
  //
  // Faire sonner `stop_sell_perdu` sur cette seule base ferait crier l'alarme la
  // plus grave du systeme a CHAQUE fermeture legitime — et l'anti-spam
  // masquerait la vraie le jour ou elle arrive. On journalise donc, sans
  // alarmer, jusqu'a une mesure reelle : elle demande une ECRITURE chez le
  // partenaire, interdite pendant les tests. Dette a trancher avec Thierry.
  const m = monde({ partenaire: { statut: 200, corps: JSON.stringify({ data: [] }) } })
  try {
    const { reaffirmerStopSell } = charger()
    await reaffirmerStopSell(BIEN, PROP, '2026-11-01', '2026-11-02', 'essai')
    const perdus = m.incidents.filter(i => i.type === 'stop_sell_perdu')
    assert.deepEqual(perdus, [],
      'un 200 sans identifiant de tache a fait sonner l alarme : elle criera a chaque '
      + 'fermeture legitime si c est la forme reelle du partenaire')
  } finally { m.restore() }
})

test('aucune intention memorisee : rien a restituer, et aucune alarme', async () => {
  // Le bien n'est ferme nulle part : l'absence d'alarme est le comportement juste.
  const m = monde({ partenaire: HTML, intention: [] })
  try {
    const { reaffirmerStopSell } = charger()
    await reaffirmerStopSell(BIEN, PROP, '2026-11-01', '2026-11-02', 'essai')
    assert.deepEqual(m.appelsPartenaire, [], 'le partenaire a ete appele pour rien')
    assert.deepEqual(m.incidents.filter(i => i.type === 'stop_sell_perdu'), [])
  } finally { m.restore() }
})

test('une intention OUVERTE qui echoue ne sonne pas : rien n est perdu', async () => {
  // `stop_sell_perdu` ne vaut que pour des dates FERMEES. Une restitution
  // d'ouverture ratee ne met personne en danger de surreservation.
  const m = monde({ partenaire: HTML,
                    intention: [{ date: '2026-11-01', stop_sell: false }] })
  try {
    const { reaffirmerStopSell } = charger()
    await reaffirmerStopSell(BIEN, PROP, '2026-11-01', '2026-11-02', 'essai')
    assert.deepEqual(m.incidents.filter(i => i.type === 'stop_sell_perdu'), [],
      'une intention ouverte a fait sonner « stop-sell perdu »')
  } finally { m.restore() }
})
