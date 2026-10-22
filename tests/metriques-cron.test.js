// tests/metriques-cron.test.js
// LE COMPTEUR DU CYCLE — ce qu'il compte, ce qu'il n'invente pas, et ce qu'il
// ne doit jamais casser.
//
// ⚠ TROIS PROPRIETES TIENNENT TOUT LE LOT, et chacune a sa raison d'etre :
//  1. le compteur est pose SUR LE CLIENT (interception de `fetch`) : un module
//     neuf est compte sans qu'on ait pense a lui ;
//  2. l'attribution va a la tache la plus INTERIEURE : sinon le total vaut le
//     double et le classement designe le parent au lieu du coupable ;
//  3. un compteur ne casse JAMAIS l'appel qu'il observe, et ne compte RIEN
//     hors passage — une instance Vercel tiede garde ses modules.
//
// ⚠ L'horloge est INJECTEE partout : regle du depot (« dates figees s'il
// injecte le temps »). Aucun test d'ici ne lit l'heure reelle.

const test = require('node:test')
const assert = require('node:assert')
const C = require('../lib/metriques-cron')

// Une horloge qu'on avance a la main. `pas()` fait couler le temps.
function horlogeFigee (depart = 1_700_000_000_000) {
  let t = depart
  const h = () => t
  h.pas = (ms) => { t += ms }
  return h
}

// Pose un faux `fetch` global, rend de quoi le retirer. Le compteur se posera
// PAR-DESSUS lui : c'est exactement ce que fait la production, ou le vrai
// `fetch` est celui de Node.
function fauxFetch (reponse = 'ok') {
  const avant = globalThis.fetch
  const appels = []
  globalThis.fetch = async (url, opts) => { appels.push({ url: String(url), opts }); return reponse }
  return { appels, restaurer: () => { globalThis.fetch = avant } }
}

// ─── 1. Classement des hotes ────────────────────────────────────────────────

test('une URL Supabase est une REQUETE, pas un appel externe', () => {
  const avant = process.env.SUPABASE_URL
  process.env.SUPABASE_URL = 'https://ortyofzzdsthlhqmzsnq.supabase.co'
  try {
    assert.equal(C.classer('https://ortyofzzdsthlhqmzsnq.supabase.co/rest/v1/properties?select=id').genre, 'supabase')
    // Un AUTRE projet Supabase reste une requete : un script pointe sur
    // staging ne doit pas faire disparaitre la moitie du cout.
    assert.equal(C.classer('https://autreprojet.supabase.co/rest/v1/x').genre, 'supabase')
  } finally { process.env.SUPABASE_URL = avant }
})

test('chaque partenaire est nomme, et un hote inconnu garde son nom', () => {
  assert.equal(C.classer('https://staging.channex.io/api/v1/properties').cible, 'channex')
  assert.equal(C.classer('https://api.channex.io/api/v1/bookings').cible, 'channex')
  assert.equal(C.classer('https://beds24.com/api/v2/bookings').cible, 'beds24')
  assert.equal(C.classer('https://connect.getseam.com/locks/list').cible, 'seam')
  assert.equal(C.classer('https://api.brevo.com/v3/smtp/email').cible, 'brevo')
  // Un hote qu'on n'a pas prevu doit APPARAITRE : c'est ainsi qu'on apprend
  // qu'AirROI ou l'API adresse sont dans le cycle.
  const inconnu = C.classer('https://api.airroi.com/v1/listings')
  assert.equal(inconnu.genre, 'externe')
  assert.equal(inconnu.cible, 'api.airroi.com')
})

test('⚠ anthropic.com est IGNORE par l interception — il se compte a l enveloppe IA', () => {
  // MESURE DU 22 OCTOBRE 2026 : le SDK Anthropic capture `fetch` a la
  // CONSTRUCTION du client. Un compteur pose apres voit zero appel. Les
  // appels Haiku arrivent donc par `compterAppelExterne`, et compter AUSSI
  // l'hote ici donnerait le double le jour ou un client serait construit
  // apres la pose.
  assert.equal(C.classer('https://api.anthropic.com/v1/messages').genre, 'ignore')
})

test('une URL illisible est comptee, et nommee comme telle', () => {
  // Elle ne doit pas disparaitre : une requete non comptee est un cout
  // invisible, et c'est exactement ce que ce lot existe pour supprimer.
  assert.equal(C.classer('pas-une-url').cible, 'url-illisible')
  assert.equal(C.classer(undefined).cible, 'url-illisible')
  // Une Request porte son URL dans `.url`.
  assert.equal(C.classer({ url: 'https://beds24.com/api/v2/x' }).cible, 'beds24')
})

// ─── 2. Le comptage par tache ───────────────────────────────────────────────

test('les requetes d une tache lui sont attribuees', async () => {
  const f = fauxFetch()
  const h = horlogeFigee()
  const p = C.demarrerPassage({ cron: 'cron', horloge: h })
  try {
    await p.mesure('tache_a', async () => {
      await fetch('https://projet.supabase.co/rest/v1/a')
      await fetch('https://projet.supabase.co/rest/v1/b')
      h.pas(120)
    })
    await p.mesure('tache_b', async () => {
      await fetch('https://beds24.com/api/v2/bookings')
      h.pas(30)
    })
    const d = p.terminer()
    const a = d.taches.find(t => t.nom === 'tache_a')
    const b = d.taches.find(t => t.nom === 'tache_b')
    assert.equal(a.req, 2)
    assert.equal(a.ms, 120)
    assert.equal(b.req, 0)
    assert.deepEqual(b.ext, { beds24: 1 })
    assert.equal(d.requetes, 2)
    assert.equal(d.appels_externes, 1)
    // Les deux appels sont bien PARTIS : le compteur observe, il n'avale pas.
    assert.equal(f.appels.length, 3)
  } finally { C.retirerLeCompteur(); f.restaurer() }
})

test('⚠ une tache emboitee compte POUR ELLE, pas aussi pour son parent', async () => {
  // Le defaut qu'il empeche : `api/cron.js` mesure `user_abc` qui mesure
  // `snapshots[209413]`. Attribuer la requete aux deux fait un total du
  // double, et met le PARENT en tete du classement — donc fait decouper le
  // mauvais morceau.
  const f = fauxFetch()
  const h = horlogeFigee()
  const p = C.demarrerPassage({ horloge: h })
  try {
    await p.mesure('parent', async () => {
      await fetch('https://projet.supabase.co/rest/v1/parent')
      h.pas(10)
      await p.mesure('enfant', async () => {
        await fetch('https://projet.supabase.co/rest/v1/enfant1')
        await fetch('https://projet.supabase.co/rest/v1/enfant2')
        h.pas(500)
      })
      h.pas(10)
    })
    const d = p.terminer()
    const parent = d.taches.find(t => t.nom === 'parent')
    const enfant = d.taches.find(t => t.nom === 'enfant')
    assert.equal(enfant.req, 2)
    assert.equal(parent.req, 1, 'le parent ne porte que SES requetes')
    assert.equal(d.requetes, 3, 'et le total ne compte rien deux fois')
    // La duree, elle, ne se desemboite pas : `ms` est l'horloge, `ms_seul`
    // retire les enfants. Seule la somme des `ms_seul` vaut le passage.
    assert.equal(parent.ms, 520)
    assert.equal(parent.ms_seul, 20)
    assert.equal(enfant.ms, 500)
    assert.equal(enfant.ms_seul, 500)
  } finally { C.retirerLeCompteur(); f.restaurer() }
})

test('une meme tache mesuree deux fois s additionne et compte ses passages', async () => {
  const f = fauxFetch()
  const h = horlogeFigee()
  const p = C.demarrerPassage({ horloge: h })
  try {
    for (const _ of [1, 2, 3]) {
      await p.mesure('import_bien', async () => { await fetch('https://projet.supabase.co/rest/v1/x'); h.pas(7) })
    }
    const d = p.terminer()
    const t = d.taches.find(x => x.nom === 'import_bien')
    assert.equal(t.n, 3)
    assert.equal(t.req, 3)
    assert.equal(t.ms, 21)
  } finally { C.retirerLeCompteur(); f.restaurer() }
})

test('les requetes faites HORS de toute tache apparaissent, elles ne disparaissent pas', async () => {
  // `api/cron.js` lit les cles Beds24 et les jetons publics AVANT la premiere
  // tache, et ecrit `cron_logs` APRES la derniere. Les cacher ferait mentir le
  // total du passage — et ce sont des requetes qu'un decoupage devra porter.
  const f = fauxFetch()
  const h = horlogeFigee()
  const p = C.demarrerPassage({ horloge: h })
  try {
    await fetch('https://projet.supabase.co/rest/v1/api_keys')
    await fetch('https://projet.supabase.co/rest/v1/public_tokens')
    h.pas(40)
    await p.mesure('une_tache', async () => { h.pas(60) })
    const d = p.terminer()
    const hors = d.taches.find(t => t.nom === C.HORS_TACHE)
    assert.ok(hors, 'la ligne « hors tache » doit exister')
    assert.equal(hors.req, 2)
    assert.equal(hors.ms_seul, 40)
    assert.equal(d.requetes, 2)
    // La somme des `ms_seul` vaut la duree du passage.
    assert.equal(d.taches.reduce((s, t) => s + t.ms_seul, 0), d.duree_ms)
  } finally { C.retirerLeCompteur(); f.restaurer() }
})

// ─── 3. Le travail fait ─────────────────────────────────────────────────────

test('le travail fait se lit sur les compteurs que le cycle remplit deja', async () => {
  // AUCUN compteur ajoute dans les modules : on photographie `results` avant
  // et apres chaque tache. Un module neuf qui remplit `results` est donc
  // mesure sans l'avoir demande.
  const h = horlogeFigee()
  const results = { totalMessages: 0, totalPrixChanges: 0, errors: [] }
  const p = C.demarrerPassage({ horloge: h, resultats: () => results, compteurDeFetch: false })
  try {
    await p.mesure('messages', async () => { results.totalMessages += 3; h.pas(5) })
    await p.mesure('pilote', async () => { results.totalPrixChanges += 12; results.errors.push({ x: 1 }); h.pas(5) })
    const d = p.terminer()
    assert.deepEqual(d.taches.find(t => t.nom === 'messages').travail, { totalMessages: 3 })
    assert.deepEqual(d.taches.find(t => t.nom === 'pilote').travail, { totalPrixChanges: 12, errors: 1 })
  } finally { C.retirerLeCompteur() }
})

test('⚠ le travail d un enfant n est pas recompte chez son parent', async () => {
  const h = horlogeFigee()
  const results = { totalMessages: 0 }
  const p = C.demarrerPassage({ horloge: h, resultats: () => results, compteurDeFetch: false })
  try {
    await p.mesure('parent', async () => {
      results.totalMessages += 1
      await p.mesure('enfant', async () => { results.totalMessages += 10 })
    })
    const d = p.terminer()
    assert.deepEqual(d.taches.find(t => t.nom === 'enfant').travail, { totalMessages: 10 })
    assert.deepEqual(d.taches.find(t => t.nom === 'parent').travail, { totalMessages: 1 })
  } finally { C.retirerLeCompteur() }
})

// ─── 4. Ce que le compteur ne doit jamais faire ─────────────────────────────

test('⚠ HORS PASSAGE, RIEN N EST COMPTE — et une instance tiede ne melange pas deux invocations', async () => {
  const f = fauxFetch()
  const h = horlogeFigee()
  const p1 = C.demarrerPassage({ horloge: h })
  await p1.mesure('t', async () => { await fetch('https://projet.supabase.co/rest/v1/x') })
  const d1 = p1.terminer()
  assert.equal(d1.requetes, 1)
  // Entre deux invocations, le module reste charge : les appels d'un endpoint
  // quelconque ne doivent pas se retrouver dans le passage suivant.
  assert.equal(C.passageEnCours(), false)
  await fetch('https://projet.supabase.co/rest/v1/pendant-ce-temps')
  const p2 = C.demarrerPassage({ horloge: h })
  const d2 = p2.terminer()
  assert.equal(d2.requetes, 0, 'le passage neuf part de zero')
  C.retirerLeCompteur(); f.restaurer()
})

test('⚠ un compteur ne casse JAMAIS l appel qu il observe', async () => {
  const avant = globalThis.fetch
  // Un `fetch` dont l'URL explose quand on la lit : le classement doit
  // echouer en silence, et l'appel partir quand meme.
  const piege = { toString () { throw new Error('url hostile') }, get url () { throw new Error('url hostile') } }
  globalThis.fetch = async () => 'la vraie reponse'
  const p = C.demarrerPassage({ horloge: horlogeFigee() })
  try {
    assert.equal(await fetch(piege), 'la vraie reponse')
    const d = p.terminer()
    assert.equal(d.requetes, 0)
  } finally { C.retirerLeCompteur(); globalThis.fetch = avant }
})

test('l enveloppe rend la valeur du vrai fetch, avec ses arguments intacts', async () => {
  const avant = globalThis.fetch
  let vus = null
  globalThis.fetch = async (...args) => { vus = args; return { ok: true, marque: 'reponse' } }
  const p = C.demarrerPassage({ horloge: horlogeFigee() })
  try {
    const r = await fetch('https://projet.supabase.co/rest/v1/x', { method: 'POST', body: '{}' })
    assert.equal(r.marque, 'reponse')
    assert.equal(vus.length, 2)
    assert.equal(vus[1].method, 'POST')
    p.terminer()
  } finally { C.retirerLeCompteur(); globalThis.fetch = avant }
})

test('⚠ la pose est idempotente : deux passages n empilent pas deux enveloppes', async () => {
  const f = fauxFetch()
  const h = horlogeFigee()
  const p1 = C.demarrerPassage({ horloge: h })
  p1.terminer()
  const p2 = C.demarrerPassage({ horloge: h })
  try {
    await p2.mesure('t', async () => { await fetch('https://projet.supabase.co/rest/v1/x') })
    const d = p2.terminer()
    assert.equal(d.requetes, 1, 'une requete compte UNE fois, pas deux')
  } finally { C.retirerLeCompteur(); f.restaurer() }
})

test('si quelqu un a remplace fetch entre-temps, le compteur se repose', async () => {
  // Une suite de tests remplace `globalThis.fetch` en permanence. En
  // production, c'est le cas d'un module qui installe son propre client. Sans
  // cette repose, le passage suivant compterait zero sans rien dire.
  const f1 = fauxFetch()
  const p1 = C.demarrerPassage({ horloge: horlogeFigee() })
  p1.terminer()
  f1.restaurer()
  const f2 = fauxFetch()
  const p2 = C.demarrerPassage({ horloge: horlogeFigee() })
  try {
    await p2.mesure('t', async () => { await fetch('https://projet.supabase.co/rest/v1/x') })
    assert.equal(p2.terminer().requetes, 1)
    assert.equal(f2.appels.length, 1)
  } finally { C.retirerLeCompteur(); f2.restaurer() }
})

test('les appels Haiku arrivent par compterAppelExterne, et seulement dans un passage', async () => {
  C.compterAppelExterne('haiku') // hors passage : ne doit rien casser
  const h = horlogeFigee()
  const p = C.demarrerPassage({ horloge: h, compteurDeFetch: false })
  try {
    await p.mesure('classification', async () => {
      C.compterAppelExterne('haiku')
      C.compterAppelExterne('haiku')
    })
    const d = p.terminer()
    assert.deepEqual(d.taches.find(t => t.nom === 'classification').ext, { haiku: 2 })
    assert.equal(d.appels_externes, 2)
  } finally { C.retirerLeCompteur() }
})

test('⚠ LE TRAVAIL FAIT ENTRE DEUX TACHES N EST PAS PERDU : il tombe dans « hors tache »', async () => {
  // CONSTAT DE REVIEW, ET C'ETAIT LE PLUS COUTEUX DU LOT. Huit taches de
  // `api/cron.js` affectaient leur bilan APRES le retour de `mesure`
  // (`results.totalPrixChanges = bilan.prix_changes`), donc entre deux
  // photographies : le delta n'etait attribue a personne, et le total du
  // passage disait ZERO la ou le pilote venait de changer quarante prix. Les
  // affectations sont passees dans la callback ; cette ligne-ci garde le
  // filet, pour que plus aucun chiffre ne puisse disparaitre.
  const h = horlogeFigee()
  const results = { totalPrixChanges: 0 }
  const p = C.demarrerPassage({ horloge: h, resultats: () => results, compteurDeFetch: false })
  try {
    await p.mesure('pilote', async () => { h.pas(10) })
    results.totalPrixChanges += 40   // « apres le retour de mesure »
    const d = p.terminer()
    assert.deepEqual(d.taches.find(t => t.nom === 'pilote').travail, {})
    const hors = d.taches.find(t => t.nom === C.HORS_TACHE)
    assert.deepEqual(hors.travail, { totalPrixChanges: 40 })
    assert.equal(hors.travail_total, 40)
  } finally { C.retirerLeCompteur() }
})

test('le travail d une tache ne se retrouve PAS en double dans « hors tache »', async () => {
  const h = horlogeFigee()
  const results = { totalMessages: 0 }
  const p = C.demarrerPassage({ horloge: h, resultats: () => results, compteurDeFetch: false })
  try {
    await p.mesure('messages', async () => { results.totalMessages += 7; h.pas(10) })
    const d = p.terminer()
    const hors = d.taches.find(t => t.nom === C.HORS_TACHE)
    assert.deepEqual(hors ? hors.travail : {}, {})
    assert.equal(d.totaux.travail.totalMessages, 7)
  } finally { C.retirerLeCompteur() }
})

test('⚠ une enveloppe TIERCE posee par-dessus la notre ne fait pas compter deux fois', async () => {
  // CONSTAT DE REVIEW : le marqueur n'etait lu que sur le `fetch` le plus
  // EXTERIEUR. Un tiers qui s'installe au-dessus du notre entre deux passages
  // faisait reposer un second compteur, et chaque requete comptait DOUBLE, en
  // silence, pour toute la vie de l'instance.
  const f = fauxFetch()
  const p1 = C.demarrerPassage({ horloge: horlogeFigee() })
  p1.terminer()
  // Un tiers s'installe par-dessus, en gardant la chaine.
  const notre = globalThis.fetch
  const tiers = function (...args) { return notre.apply(this, args) }
  tiers.__hs_vrai = notre
  globalThis.fetch = tiers
  const p2 = C.demarrerPassage({ horloge: horlogeFigee() })
  try {
    await p2.mesure('t', async () => { await fetch('https://projet.supabase.co/rest/v1/x') })
    assert.equal(p2.terminer().requetes, 1, 'une requete compte UNE fois, pas deux')
  } finally { C.retirerLeCompteur(); f.restaurer() }
})

// ─── 5. Le detail reste borne ───────────────────────────────────────────────

test('⚠ le detail d un passage est PLAFONNE, et le reste est agrege, pas jete', async () => {
  // Une colonne JSON qui grandit avec le parc couterait plus cher que ce
  // qu'elle mesure. Mais jeter les petites taches ferait mentir le total.
  const h = horlogeFigee()
  const p = C.demarrerPassage({ horloge: h, compteurDeFetch: false })
  try {
    for (let i = 0; i < C.TACHES_MAX + 25; i++) {
      await p.mesure(`tache_${i}`, async () => { C.compterAppelExterne('channex'); h.pas(1) })
    }
    const d = p.terminer()
    assert.equal(d.taches.length, C.TACHES_MAX)
    assert.equal(d.totaux.tronquees, 26)
    const agregee = d.taches[d.taches.length - 1]
    // ⚠ LE NOM EST FIXE, ET LE NOMBRE DANS UN CHAMP (constat de review) :
    // `cron_stats_classement` groupe par le nom, donc « (3 autres taches) » et
    // « (5 autres taches) » devenaient deux lignes distinctes du classement,
    // capables d'occuper le top 10 a elles seules.
    assert.equal(agregee.nom, C.AUTRES_TACHES)
    assert.equal(agregee.nom, '(autres taches)')
    assert.equal(agregee.autres, 26)
    assert.equal(agregee.n, 26)
    // Le total, lui, porte TOUT : 65 appels externes, pas 39.
    assert.equal(d.appels_externes, C.TACHES_MAX + 25)
  } finally { C.retirerLeCompteur() }
})

test('le classement d un passage est trie par requetes puis par temps', async () => {
  const f = fauxFetch()
  const h = horlogeFigee()
  const p = C.demarrerPassage({ horloge: h })
  try {
    await p.mesure('lente_sans_requete', async () => { h.pas(5000) })
    await p.mesure('deux_requetes', async () => {
      await fetch('https://projet.supabase.co/rest/v1/a'); await fetch('https://projet.supabase.co/rest/v1/b'); h.pas(10)
    })
    await p.mesure('une_requete', async () => { await fetch('https://projet.supabase.co/rest/v1/c'); h.pas(10) })
    const noms = p.terminer().taches.map(t => t.nom)
    assert.deepEqual(noms.slice(0, 2), ['deux_requetes', 'une_requete'])
  } finally { C.retirerLeCompteur(); f.restaurer() }
})

// ─── 6. L interface du chrono d avant ───────────────────────────────────────

test('⚠ le passage porte EXACTEMENT l interface du chrono d avant', async () => {
  // `api/cron.js` appelle `chrono.mesure`, `chrono.total` et `chrono.resume`
  // en quarante points. Un lot de mesure qui reecrit le code qu'il mesure ne
  // mesure plus le meme code : l'interface ne bouge pas.
  const h = horlogeFigee()
  const p = C.demarrerPassage({ horloge: h, compteurDeFetch: false, journal: { log () {} } })
  try {
    assert.equal(typeof p.mesure, 'function')
    assert.equal(typeof p.total, 'function')
    assert.equal(typeof p.resume, 'function')
    const rendu = await p.mesure('t', async () => { h.pas(42); return 'la valeur rendue' })
    assert.equal(rendu, 'la valeur rendue', 'mesure rend ce que la fonction rend')
    assert.equal(p.total(), 42)
    assert.match(p.resume(), /^\[Cron\]\[chrono\] TOTAL 42ms \| t=42ms$/)
  } finally { C.retirerLeCompteur() }
})

test('une tache qui leve est quand meme mesuree, et l erreur passe', async () => {
  const h = horlogeFigee()
  const p = C.demarrerPassage({ horloge: h, compteurDeFetch: false, journal: { log () {} } })
  try {
    await assert.rejects(() => p.mesure('qui_leve', async () => { h.pas(9); throw new Error('boum') }), /boum/)
    const d = p.terminer()
    assert.equal(d.taches.find(t => t.nom === 'qui_leve').ms, 9)
  } finally { C.retirerLeCompteur() }
})

test('terminer() peut etre appele apres un passage mal fini', async () => {
  const h = horlogeFigee()
  const p = C.demarrerPassage({ horloge: h, compteurDeFetch: false })
  h.pas(100)
  const d = p.terminer()
  assert.equal(d.duree_ms, 100)
  assert.equal(C.passageEnCours(), false)
  // Un second appel ne leve pas : le cron l'appelle dans un `finally`.
  assert.equal(p.terminer().duree_ms, 100)
})
