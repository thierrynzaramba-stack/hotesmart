// tests/yf-ecran-evenements-page.test.js — la page « Ce qui fait bouger vos
// prix » (apps/yield/evenements.html) et son rendu (shared/yield-evenements-rendu.js).
// Lot 4, 4a, étape 2 (lecture seule). Spec : docs/specs/spec-yf-ecran-evenements.md.
//
// ⚠ LES DONNÉES SONT CELLES DE LA VRAIE ASSEMBLÉE (tests/outils/banc-evenements.js) :
// la page est éprouvée sur la forme exacte du serveur.
// ⚠ DATES FIGÉES : l'assemblée reçoit `aujourdHui`, et la page ne lit pas
// l'horloge pour ce qu'elle affiche (le serveur fixe la fenêtre).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { reponseEcran, monter, NOEL } = require('./outils/banc-evenements')

const RENDU = path.join(__dirname, '..', 'shared/yield-evenements-rendu.js')
const t = (k, v = {}) => `${k}${Object.keys(v).length ? JSON.stringify(v) : ''}`
const fmt = { t, money: n => `${n} €`, date: (d, o) => new Date(d).toLocaleDateString('fr-FR', o) }

// La ligne que la page écrira à l'étape 3 : la position reçue, plus un niveau.
const ligneDe = (cle, p, niveau, id) => ({ id, evenement: cle, zone: p.zone, rang: p.rang ?? null, jour: p.jour ?? null, nuit: p.nuit ?? null, niveau })

test('LE TEST QUI COMPTE (règle 2) : le chiffre du niveau est toujours écrit — « 3 · Haut »', async () => {
  const r = await import(RENDU)
  const tFr = (k) => ({ 'yfe.niveau_3': 'Haut', 'yfe.niveau_5': 'Exceptionnel' })[k] || k
  assert.equal(r.etiquetteNiveau('Haut', tFr), '3 · Haut')
  assert.equal(r.etiquetteNiveau('Exceptionnel', tFr), '5 · Exceptionnel')
  assert.equal(r.etiquetteNiveau('inconnu', tFr), '')
  // Et partout où une pastille est rendue : légende, liste, calendrier ouvert.
  const d = await reponseEcran()
  const idx = r.indexerNuits(d.nuits)
  const noel = d.evenements.find(e => e.cle === NOEL)
  const html = r.rendreLegende(d.niveaux, null, fmt) + r.rendreListe(d, idx, { filtre: 'tous', ouvert: r.idEvenement(noel) }, fmt, x => x)
  const pastilles = [...html.matchAll(/<span class="yfe-niv yfe-niv--(\d)[^"]*">([^<]*)/g)]
  assert.ok(pastilles.length > 20, `${pastilles.length} pastilles : le rendu doit en porter`)
  for (const [, n, texte] of pastilles) {
    // Le texte est échappé (`&quot;`) : c'est le HTML tel que la page le pose.
    assert.match(texte, new RegExp(`^(yfe\\.(semaine|weekend)\\{&quot;niveau&quot;:&quot;)?${n} · yfe\\.niveau_${n}`), `pastille ${n} sans son chiffre : « ${texte} »`)
  }
})

test('LE TEST QUI COMPTE (règle 1) : le niveau colore la pastille ou la case, jamais la carte, le mois ni la page', async () => {
  const r = await import(RENDU)
  const d = await reponseEcran()
  const idx = r.indexerNuits(d.nuits)
  const noel = d.evenements.find(e => e.cle === NOEL)
  const html = r.rendreFrise(d, idx, null, fmt) + r.rendreListe(d, idx, { filtre: 'tous', ouvert: r.idEvenement(noel) }, fmt, x => x)
  const porteurs = [...html.matchAll(/<(\w+)[^>]*class="[^"]*yfe-niv--\d/g)].map(m => m[1])
  assert.ok(porteurs.length)
  assert.deepEqual([...new Set(porteurs)].sort(), ['button', 'span'], 'seules les pastilles (span) et les barres de la frise (button) portent un niveau')
  assert.doesNotMatch(html, /<(article|section|div|main|li)[^>]*yfe-niv--/)
})

test('LE TEST QUI COMPTE (§6) : le titre d’une période = son niveau, RÉGLAGES PAR NUIT COMPRIS', async () => {
  // ⚠ C'est l'observation de la recette 2b : l'ancien écran calculait le titre
  // sans les nuits posées à la main.
  const r = await import(RENDU)
  const libre = await reponseEcran()
  const noel = libre.evenements.find(e => e.cle === NOEL)
  const avant = r.resumeEvenement(noel, r.indexerNuits(libre.nuits))
  assert.notEqual(avant.max, 'Exceptionnel', 'la fixture doit distinguer le calcul du réglage')
  assert.equal(avant.regle, false)
  const p = noel.positions.find(x => x.date === '2026-12-22')
  const regle = await reponseEcran({ lignes: [ligneDe(NOEL, p, 'Exceptionnel', 'l-1')] })
  const apres = r.resumeEvenement(regle.evenements.find(e => e.cle === NOEL), r.indexerNuits(regle.nuits))
  assert.deepEqual([apres.max, apres.regle], ['Exceptionnel', true])
  // Semaine et week-end : les nuits de vendredi et de samedi (registre §3).
  assert.ok(avant.semaine && avant.weekend, 'les vacances ont des nuits de semaine et de week-end')
})

test('LE TEST QUI COMPTE (§5, décision A) : le calendrier ouvert va du lundi au dimanche, et MONTRE une nuit réglée au-delà de la zone affichée', async () => {
  const r = await import(RENDU)
  const libre = await reponseEcran()
  const noel = libre.evenements.find(e => e.cle === NOEL)
  const sem = r.semainesDeLEvenement(noel, r.indexerNuits(libre.nuits))
  const jours = sem.flatMap(s => s.jours)
  assert.equal(new Date(`${sem[0].debut}T00:00:00Z`).getUTCDay(), 1, 'une semaine commence un lundi')
  assert.equal(new Date(`${sem[sem.length - 1].fin}T00:00:00Z`).getUTCDay(), 0, 'et finit un dimanche')
  for (const d of noel.nuits) assert.equal(jours.find(j => j.date === d).zone, 'evenement')
  // Sans largeur posée : aucun week-end de rayonnement n'est affiché.
  assert.ok(!jours.some(j => j.zone === 'rayonnement'))
  // Une nuit RÉGLÉE au 3e week-end avant, zone non élargie : elle est montrée,
  // marquée hors de la zone affichée.
  const w3 = noel.week_ends.find(w => w.zone === 'avant' && w.rang === 3)
  const p = noel.positions.find(x => x.date === w3.nuits[0])
  const regle = await reponseEcran({ lignes: [ligneDe(NOEL, p, 'Haut', 'l-w3')] })
  const e2 = regle.evenements.find(e => e.cle === NOEL)
  const j2 = r.semainesDeLEvenement(e2, r.indexerNuits(regle.nuits)).flatMap(s => s.jours)
  const vue = j2.find(j => j.date === w3.nuits[0])
  assert.ok(vue, 'la nuit réglée hors de la zone doit être dans le calendrier')
  assert.equal(vue.zone, 'hors_zone')
  assert.equal(vue.nuit.regle.hors_zone_affichee, true)
  // Zone élargie à deux week-ends avant : ils deviennent du rayonnement.
  const large = { ...noel, largeur: { avant: 2, apres: null } }
  const j3 = r.semainesDeLEvenement(large, r.indexerNuits(libre.nuits)).flatMap(s => s.jours)
  const w1 = noel.week_ends.find(w => w.zone === 'avant' && w.rang === 1)
  assert.equal(j3.find(j => j.date === w1.nuits[0]).zone, 'rayonnement')
})

test('la frise place chaque événement pris en compte sur un couloir sans chevauchement ; une date coupée n’y est pas', async () => {
  const r = await import(RENDU)
  const reglages = new Map([['commercial:saint_valentin', { segment: 'commercial:saint_valentin', actif: false, crans: null }]])
  const d = await reponseEcran({ reglages })
  const { barres } = r.barresDeLaFrise(d.evenements, r.indexerNuits(d.nuits), d.fenetre)
  assert.ok(!barres.some(b => b.e.cle === 'commercial:saint_valentin'))
  assert.equal(barres.length, d.evenements.filter(e => e.actif).length)
  const parCouloir = new Map()
  for (const b of barres) {
    const l = parCouloir.get(b.couloir) || []
    for (const x of l) assert.ok(b.gauche >= x.gauche + x.largeur - 1e-9 || x.gauche >= b.gauche + b.largeur - 1e-9, `${b.e.cle} chevauche ${x.e.cle}`)
    l.push(b); parCouloir.set(b.couloir, l)
  }
  // Treize mois : le 13e est partiel (registre §5).
  assert.equal(r.moisDeLaFenetre(d.fenetre).length, 13)
})

test('LE TEST QUI COMPTE (§8, point 3) : le cache du navigateur ne garde jamais l’état d’une nuit — vendue, ouverte, prix posé à la main', async () => {
  const r = await import(RENDU)
  const d = await reponseEcran({ vendues: { '2026-12-22': [{ id: 'x' }] }, prixHote: new Map([['2026-12-23', 18900]]) })
  assert.equal(d.nuits.find(n => n.date === '2026-12-22').vendue, true)
  const c = r.pourLeCache(d)
  for (const n of c.nuits) {
    for (const champ of ['vendue', 'ouverte', 'prix_hote', 'prix_calendrier']) assert.equal(champ in n, false, `${champ} gardé pour ${n.date}`)
  }
  assert.equal(c.nuits.find(n => n.date === '2026-12-22').niveau, d.nuits.find(n => n.date === '2026-12-22').niveau)
})

// ─── La page, dans un vrai DOM ──────────────────────────────────────────────

test('LE TEST QUI COMPTE (§8, point 1) : UN appel au chargement, et la page se peint — frise, légende, liste par mois', async () => {
  const d = await reponseEcran()
  const b = await monter({ ecran: async () => d })
  assert.deepEqual(b.journal.fetch.map(f => f.url), ['/api/ecran/evenements'])
  assert.equal(b.journal.fetch[0].entetes.Authorization, 'Bearer jeton-relu')
  assert.ok(b.$$('.yfe-barre').length > 10, 'des barres dans la frise')
  assert.equal(b.$$('[data-bind="legende"] .yfe-niv').length, 5)
  assert.ok(b.$$('.yfe-mois').length >= 5, 'la liste se range par mois')
  assert.equal(b.$('[data-bind="frise-zone"]').hidden, false)
  assert.match(b.$('[data-bind="sous-titre"]').textContent, /La bulle/)
  // Deux logements : le sélecteur apparaît.
  assert.equal(b.$('[data-bind="bien-zone"]').hidden, false)
  // ⚠ CE QUE LA PAGE ÉCRIT DANS LE CACHE est passé par `pourLeCache` : aucune
  // nuit n'y garde son état (§8, point 3).
  const garde = b.cache.lire('yield-evenements', b.MOI, b.COMPTE)
  assert.ok(garde && garde.donnees.nuits.length === d.nuits.length, 'la page garde son écran pour l’affichage instantané')
  assert.ok(garde.donnees.nuits.every(n => !('vendue' in n) && !('ouverte' in n)), 'le cache garde l’état des nuits')
})

test('LE TEST QUI COMPTE : une barre de la frise ouvre son événement — calendrier, niveau et prix de chaque nuit, sans nouvel appel', async () => {
  const d = await reponseEcran()
  const b = await monter({ ecran: async () => d })
  const barre = b.$$('.yfe-barre').find(x => x.dataset.ouvrir.startsWith(NOEL + '|'))
  await b.cliquer(barre)
  const carte = b.$$('[data-ev]').find(a => a.dataset.ev === barre.dataset.ouvrir)
  assert.ok(carte.classList.contains('yfe-ev--ouvert'))
  const jours = [...carte.querySelectorAll('.yfe-jour--evenement')]
  assert.equal(jours.length, 16, 'les seize nuits des vacances de Noël')
  for (const j of jours) {
    assert.ok(j.querySelector('.yfe-niv'), 'chaque nuit porte son niveau')
    assert.match(j.querySelector('.yfe-jour__prix').textContent, /\d+ €/, 'et son prix')
  }
  assert.equal(b.journal.fetch.length, 1, 'ouvrir un événement ne rappelle pas le serveur')
  // Re-cliquer la tête de la carte la referme.
  await b.cliquer(carte.querySelector('.yfe-ev__tete'))
  assert.equal(b.$$('.yfe-ev--ouvert').length, 0)
})

test('les filtres gardent la famille demandée ; une barre ouvre son événement même filtré', async () => {
  const d = await reponseEcran()
  const b = await monter({ ecran: async () => d })
  await b.cliquer(b.$('[data-filtre="mien"]'))
  const noms = b.$$('.yfe-ev__nom').map(x => x.textContent)
  assert.deepEqual(noms, ['Salon du chocolat'])
  assert.equal(b.$('[data-filtre="mien"]').getAttribute('aria-pressed'), 'true')
  const barre = b.$$('.yfe-barre').find(x => x.dataset.ouvrir.startsWith(NOEL + '|'))
  await b.cliquer(barre)
  assert.equal(b.$('[data-filtre="tous"]').getAttribute('aria-pressed'), 'true')
  assert.ok(b.$$('.yfe-ev--ouvert').length === 1)
})

test('LE TEST QUI COMPTE : changer de logement = UN appel, avec ce logement, et l’adresse le garde', async () => {
  const d = await reponseEcran()
  const autre = '33333333-3333-4333-8333-333333333333'
  const b = await monter({ ecran: async (url) => ({ ...d, bien: /bien=/.test(url) ? autre : d.bien }) })
  await b.choisir(b.$('[data-bind="bien"]'), autre)
  assert.deepEqual(b.journal.fetch.map(f => f.url), ['/api/ecran/evenements', `/api/ecran/evenements?bien=${autre}`])
  assert.match(b.w.location.search, new RegExp(`bien=${autre}`))
  assert.match(b.$('[data-bind="sous-titre"]').textContent, /Cœur de vie 23/)
})

test('LE TEST QUI COMPTE : l’affichage instantané vient du cache du MÊME logement — puis le serveur le remplace', async () => {
  const d = await reponseEcran()
  const r = await import(RENDU)
  let liberer
  const retenue = new Promise(res => { liberer = res })
  const vieux = { ...r.pourLeCache(d), niveaux: d.niveaux.map(n => ({ ...n, prix: n.prix + 1000 })) }
  const pBanc = monter({ cache: vieux, ecran: async () => { await retenue; return d } })
  // L'amorce attend le serveur : on regarde l'écran AVANT sa réponse.
  await new Promise(res => setTimeout(res, 20))
  liberer()
  const b = await pBanc
  assert.equal(b.$('[data-bind="age"]').hidden, true, 'la réponse du serveur efface la mention « dernières données »')
  assert.doesNotMatch(b.$('[data-bind="legende"]').textContent, /11\d\d €/, 'le serveur a remplacé le cache')
  // Un cache d'un AUTRE logement ne se peint pas : la page attend le serveur.
  const autre = await monter({ cache: { ...vieux, bien: '99999999-9999-4999-8999-999999999999' }, url: 'https://hs.test/apps/yield/evenements?bien=22222222-2222-4222-8222-222222222222', ecran: async () => { throw Object.assign(new Error('panne'), { status: 503 }) } })
  assert.equal(autre.$('[data-bind="frise-zone"]').hidden, true)
  assert.match(autre.$('[data-bind="liste"]').textContent, /Impossible de charger/)
})

test('LE TEST QUI COMPTE : un refus du serveur efface ce que le cache avait peint ; une panne le garde, et le dit', async () => {
  const d = await reponseEcran()
  const r = await import(RENDU)
  const refus = await monter({ cache: r.pourLeCache(d), ecran: async () => { throw Object.assign(new Error('Droit « réservations » requis'), { status: 403 }) } })
  assert.equal(refus.$$('.yfe-barre').length, 0, 'le cache d’un périmètre perdu ne reste pas à l’écran')
  assert.equal(refus.$('[data-bind="bien-zone"]').hidden, true)
  assert.equal(refus.cache.lire('yield-evenements', refus.MOI, refus.COMPTE), null, 'et il est oublié')
  const panne = await monter({ cache: r.pourLeCache(d), ecran: async () => { throw Object.assign(new Error('panne'), { status: 503 }) } })
  assert.ok(panne.$$('.yfe-barre').length > 10, 'une panne laisse l’écran du cache')
  assert.equal(panne.$('[data-bind="age"]').hidden, false)
  assert.match(panne.$('[data-bind="age"]').textContent, /la mise à jour n’a pas pu se faire/)
})

test('le motif d’un calcul impossible est dit, et le sélecteur reste', async () => {
  const b = await monter({ ecran: async () => ({ aujourdhui: '2026-11-09', biens: [{ id: 'a', nom: 'La bulle' }, { id: 'b', nom: 'Anglet' }], bien: 'b', droits_ecriture: true, indisponible: 'bien_non_raccorde' }) })
  assert.match(b.$('[data-bind="alertes"]').textContent, /relié à aucun canal/)
  assert.equal(b.$('[data-bind="frise-zone"]').hidden, true)
  assert.equal(b.$('[data-bind="bien-zone"]').hidden, false)
})

test('une nuit réglée DIT ce que le calcul disait ; une nuit à prix posé à la main et une nuit vendue le disent aussi', async () => {
  const libre = await reponseEcran()
  const noel = libre.evenements.find(e => e.cle === NOEL)
  const p = noel.positions.find(x => x.date === '2026-12-22')
  const d = await reponseEcran({ lignes: [ligneDe(NOEL, p, 'Exceptionnel', 'l-1')], vendues: { '2026-12-23': [{ id: 'x' }] }, prixHote: new Map([['2026-12-24', 18900]]) })
  const b = await monter({ ecran: async () => d })
  await b.cliquer(b.$$('.yfe-barre').find(x => x.dataset.ouvrir.startsWith(NOEL + '|')))
  const jour = (date) => b.$$('.yfe-ev--ouvert .yfe-jour').find(j => j.getAttribute('title').includes(new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })))
  const j22 = jour('2026-12-22')
  assert.ok(j22.classList.contains('yfe-jour--regle'))
  assert.match(j22.getAttribute('title'), /sans votre réglage : \d · /)
  assert.match(jour('2026-12-23').textContent, /vendue/)
  assert.match(jour('2026-12-24').textContent, /✎ 189 €/)
  assert.match(b.$('.yfe-ev--ouvert .yfe-badge--regle').textContent, /réglé par vous/)
})
