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
  // ⚠ ET LES BARRES DE LA FRISE : trop étroites pour l'écrire, elles le
  // portent dans leur nom accessible et leur infobulle (review de l'étape 2).
  const frise = r.rendreFrise(d, idx, null, fmt)
  const barres = [...frise.matchAll(/<button type="button" class="yfe-niv yfe-niv--(\d) yfe-barre"[^>]*title="([^"]*)"[^>]*aria-label="([^"]*)"/g)]
  assert.ok(barres.length > 10, `${barres.length} barres`)
  for (const [, n, titre, aria] of barres) {
    assert.ok(titre.includes(`${n} · yfe.niveau_${n}`) && aria.includes(`${n} · yfe.niveau_${n}`), `barre ${n} sans son chiffre : ${titre}`)
  }
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
  // ⚠ ON REGARDE L'ÉCRAN AU MOMENT DE L'APPEL, avant la réponse (review de
  // l'étape 2 : sans cela, retirer la peinture depuis le cache restait vert).
  let avantReponse = null
  const pBanc = monter({ cache: vieux, ecran: async (url, w) => {
    avantReponse = { url, legende: w.document.querySelector('[data-bind="legende"]').textContent, barres: w.document.querySelectorAll('.yfe-barre').length, age: w.document.querySelector('[data-bind="age"]').hidden }
    await retenue
    return d
  } })
  await new Promise(res => setTimeout(res, 20))
  assert.ok(avantReponse, 'l’appel est parti')
  assert.match(avantReponse.legende, /11\d\d €/, 'le cache est peint AVANT la réponse')
  assert.ok(avantReponse.barres > 10)
  assert.equal(avantReponse.age, false, 'et il dit qu’il s’agit des dernières données connues')
  assert.equal(avantReponse.url, `/api/ecran/evenements?bien=${d.bien}`, 'sans logement dans l’adresse, on demande celui du cache')
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

test('LE TEST QUI COMPTE (§5) : toucher une nuit en montre le détail EN TEXTE VISIBLE — « sans votre réglage », prix posé à la main, vendue', async () => {
  // ⚠ PAS DANS UN `title` SEULEMENT (review de l'étape 2) : au toucher et au
  // clavier, un `title` n'existe pas.
  const libre = await reponseEcran()
  const noel = libre.evenements.find(e => e.cle === NOEL)
  const p = noel.positions.find(x => x.date === '2026-12-22')
  const d = await reponseEcran({ lignes: [ligneDe(NOEL, p, 'Exceptionnel', 'l-1')], vendues: { '2026-12-23': [{ id: 'x' }] }, prixHote: new Map([['2026-12-24', 18900]]) })
  const b = await monter({ ecran: async () => d })
  await b.cliquer(b.$$('.yfe-barre').find(x => x.dataset.ouvrir.startsWith(NOEL + '|')))
  const nuit = (date) => b.$$('.yfe-ev--ouvert [data-nuit]').find(j => j.dataset.nuit === date)
  assert.equal(nuit('2026-12-22').tagName, 'BUTTON', 'une nuit se touche : c’est un bouton')
  assert.ok(nuit('2026-12-22').classList.contains('yfe-jour--regle'))
  assert.match(nuit('2026-12-22').getAttribute('aria-label'), /sans votre réglage : \d · /)
  await b.cliquer(nuit('2026-12-22'))
  const detail = () => b.$('.yfe-ev--ouvert .yfe-detail')
  assert.match(detail().textContent, /5 · Exceptionnel · 165 €/)
  assert.match(detail().textContent, /sans votre réglage : \d · \S+ · ?|sans votre réglage : \d · /)
  assert.equal(nuit('2026-12-22').getAttribute('aria-pressed'), 'true')
  assert.equal(b.w.document.activeElement, nuit('2026-12-22'), 'le focus reste sur la nuit touchée')
  await b.cliquer(nuit('2026-12-23'))
  assert.match(detail().textContent, /vendue/)
  await b.cliquer(nuit('2026-12-24'))
  assert.match(detail().textContent, /prix posé à la main : 189 €/)
  assert.equal(b.journal.fetch.length, 1, 'aucun appel de plus pour lire une nuit')
})

test('LE TEST QUI COMPTE : une nuit réglée par un AUTRE événement le dit, en le nommant — et un nom saisi par l’hôte est échappé', async () => {
  // Les vacances de Noël règlent le 24 (le 1er jeudi) ; ouvert depuis le
  // réveillon, le 24 dit par QUI il est réglé.
  const libre = await reponseEcran()
  const noel = libre.evenements.find(e => e.cle === NOEL)
  const p24 = noel.positions.find(x => x.date === '2026-12-24')
  const d = await reponseEcran({ lignes: [ligneDe(NOEL, p24, 'Haut', 'n-24')] })
  const b = await monter({ ecran: async () => d })
  await b.cliquer(b.$$('.yfe-barre').find(x => x.dataset.ouvrir === 'commercial:reveillon_noel|2026-12-24'))
  const rev = b.$$('.yfe-ev--ouvert [data-nuit]').find(j => j.dataset.nuit === '2026-12-24')
  await b.cliquer(rev)
  assert.match(b.$('.yfe-ev--ouvert .yfe-detail').textContent, /réglée par « Vacances de Noël — votre zone »/)
  // Un nom saisi par l'hôte, piégé : il ne devient jamais du HTML.
  const piege = '<img src=x onerror=alert(1)>'
  const segment = 'evenement:img_src_x_onerror_alert_1'
  const p = await reponseEcran({ evenementsEnPlus: [{ id: 'ev-piege', nom: piege, segment, date_debut: '2027-04-09', date_fin: '2027-04-11' }] })
  const occ = p.evenements.find(e => e.cle === segment)
  const sam = occ.positions.find(x => x.zone === 'evenement' && x.jour === 'samedi')
  const p2 = await reponseEcran({ evenementsEnPlus: [{ id: 'ev-piege', nom: piege, segment, date_debut: '2027-04-09', date_fin: '2027-04-11' }], lignes: [ligneDe(segment, sam, 'Haut', 'l-p')] })
  const b2 = await monter({ ecran: async () => p2 })
  // (le logo de la barre du haut est la seule image légitime de la page)
  assert.equal(b2.$$('img[src="x"]').length, 0, 'le nom de l’hôte a été interprété comme du HTML')
  await b2.cliquer(b2.$$('.yfe-barre').find(x => x.dataset.ouvrir.startsWith(segment + '|')))
  const nuit = b2.$$('.yfe-ev--ouvert [data-nuit]').find(j => j.dataset.nuit === sam.date)
  await b2.cliquer(nuit)
  assert.equal(b2.$$('img[src="x"]').length, 0)
  assert.ok(b2.$$('.yfe-ev__nom').some(x => x.textContent === piege), 'le nom s’affiche en texte')
})

test('LE TEST QUI COMPTE (sécurité) : une réponse qui ne se met pas en cache EFFACE le cache — un membre qui n’a plus aucun logement', async () => {
  const d = await reponseEcran()
  const r = await import(RENDU)
  const b = await monter({ cache: r.pourLeCache(d), ecran: async () => ({ aujourdhui: '2026-11-09', biens: [], bien: null }) })
  assert.equal(b.cache.lire('yield-evenements', b.MOI, b.COMPTE), null, 'l’écran du logement perdu reste dans le navigateur')
  assert.equal(b.$$('.yfe-barre').length, 0)
  assert.match(b.$('[data-bind="alertes"]').textContent, /Aucun logement accessible/)
  // Un logement non calculable non plus ne se garde pas (on n'y repeindrait rien de juste).
  const nu = await monter({ cache: r.pourLeCache(d), ecran: async () => ({ ...d, nuits: undefined, evenements: undefined, fenetre: undefined, indisponible: 'calcul_impossible' }) })
  assert.equal(nu.cache.lire('yield-evenements', nu.MOI, nu.COMPTE), null)
})

test('LE TEST QUI COMPTE : une panne APRÈS un changement de logement ne laisse pas l’écran de l’ancien sous le nom du nouveau', async () => {
  const d = await reponseEcran()
  const autre = '33333333-3333-4333-8333-333333333333'
  const b = await monter({ ecran: async (url) => { if (/bien=/.test(url)) throw Object.assign(new Error('panne'), { status: 503 }); return d } })
  await b.choisir(b.$('[data-bind="bien"]'), autre)
  assert.equal(b.$$('.yfe-barre').length, 0, 'la frise de La bulle ne reste pas')
  assert.equal(b.$('[data-bind="legende"]').textContent, '')
  assert.match(b.$('[data-bind="liste"]').textContent, /Impossible de charger/)
  assert.equal(b.$('[data-bind="bien-zone"]').hidden, false, 'le sélecteur reste, pour choisir un autre logement')
  assert.equal(b.$('[data-bind="bien"]').value, autre)
})

test('LE TEST QUI COMPTE : un logement demandé qui n’est plus servi (404) — l’adresse est nettoyée et la page se relit sans lui', async () => {
  const d = await reponseEcran()
  const perime = '44444444-4444-4444-8444-444444444444'
  const b = await monter({ url: `https://hs.test/apps/yield/evenements?bien=${perime}`, ecran: async (url) => { if (url.includes(perime)) throw Object.assign(new Error('bien_introuvable'), { status: 404 }); return d } })
  assert.deepEqual(b.journal.fetch.map(f => f.url), [`/api/ecran/evenements?bien=${perime}`, '/api/ecran/evenements'])
  assert.equal(b.w.location.search, '')
  assert.ok(b.$$('.yfe-barre').length > 10)
  // ⚠ ET SI LA RELECTURE ÉCHOUE, l'écran du logement refusé ne reste pas
  // (re-review de l'étape 2, constat de sécurité résiduel).
  const r = await import(RENDU)
  const echec = await monter({ cache: r.pourLeCache(d), ecran: async (url) => { throw Object.assign(new Error('x'), { status: url.includes(d.bien) ? 404 : 503 }) } })
  assert.deepEqual(echec.journal.fetch.map(f => f.url), [`/api/ecran/evenements?bien=${d.bien}`, '/api/ecran/evenements'])
  assert.equal(echec.$$('.yfe-barre').length, 0, 'l’écran d’un logement refusé reste affiché')
  assert.equal(echec.$('[data-bind="legende"]').textContent, '')
  assert.equal(echec.cache.lire('yield-evenements', echec.MOI, echec.COMPTE), null)
  // Un 403 dit le refus, pas « réessayez ».
  const refus = await monter({ ecran: async () => { throw Object.assign(new Error('Droit'), { status: 403 }) } })
  assert.match(refus.$('[data-bind="liste"]').textContent, /pas accès à cet écran/)
})

test('LE TEST QUI COMPTE : une réponse en retard est ignorée — A puis B puis C, B arrive après C', async () => {
  const d = await reponseEcran()
  const B = '33333333-3333-4333-8333-333333333333'
  const C = '55555555-5555-4555-8555-555555555555'
  const biens = [...d.biens, { id: C, nom: 'Ofuro Futari' }]
  let lacherB
  const retenueB = new Promise(r => { lacherB = r })
  const b = await monter({ ecran: async (url) => {
    if (url.includes(B)) { await retenueB; return { ...d, biens, bien: B } }
    if (url.includes(C)) return { ...d, biens, bien: C }
    return { ...d, biens }
  } })
  const sel = b.$('[data-bind="bien"]')
  sel.value = B; sel.dispatchEvent(new b.w.Event('change', { bubbles: true }))
  await b.choisir(sel, C)
  assert.match(b.$('[data-bind="sous-titre"]').textContent, /Ofuro Futari/)
  lacherB()
  await b.attendre(6)
  assert.match(b.$('[data-bind="sous-titre"]').textContent, /Ofuro Futari/, 'la réponse de B, arrivée après C, a été peinte')
  assert.equal(b.$('[data-bind="bien"]').value, C)
  assert.equal(b.cache.lire('yield-evenements', b.MOI, b.COMPTE).donnees.bien, C)
})

test('LE TEST QUI COMPTE (« un null dit pourquoi ») : légende et nuit non calculables disent leur motif, par la table du moteur', async () => {
  const r = await import(RENDU)
  const { motif } = await import(path.join(__dirname, '..', 'shared/yield-motifs.js'))
  const fmtFr = { ...fmt, motif }
  const legende = r.rendreLegende(null, 'segment_sous_le_seuil', fmtFr)
  assert.ok(legende.includes(motif('segment_sous_le_seuil').quoi.replace(/'/g, '&#39;')) || legende.includes(motif('segment_sous_le_seuil').quoi), legende)
  const e = { cle: 'ferie:noel', nuits: ['2026-12-25'], actif: true }
  const phrases = r.phrasesDeLaNuit({ date: '2026-12-25', nuit: { date: '2026-12-25', niveau: null, prix: null, non_calculable: ['aucune_grille'] } }, e, { evenements: [] }, fmtFr)
  assert.match(phrases[0], new RegExp(motif('aucune_grille').quoi.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  // Un réglage posé qui ne s'applique pas le dit, avec son niveau.
  const p2 = r.phrasesDeLaNuit({ date: '2026-12-25', nuit: { date: '2026-12-25', niveau: null, prix: null, non_calculable: ['aucune_grille'], reglage_non_applique: { niveau: 'Haut', motif: 'aucune_grille' } } }, e, { evenements: [] }, fmtFr)
  assert.ok(p2.some(x => x.startsWith('yfe.reglage_non_applique{"niveau":"3 · yfe.niveau_3"}')), p2.join(' | '))
  // Jamais un tiret pour un prix absent.
  const p3 = r.phrasesDeLaNuit({ date: '2026-12-25', nuit: { date: '2026-12-25', niveau: 'Haut', prix: null } }, e, { evenements: [] }, fmtFr)
  assert.deepEqual(p3, ['3 · yfe.niveau_3 · yfe.prix_non_calculable'])
})

test('LE TEST QUI COMPTE (décision 8) : un réglage dont l’événement n’a pas lieu cette année est SIGNALÉ, hors des cartes', async () => {
  const r = await import(RENDU)
  // Une ligne sur un événement de l'hôte qui n'existe pas dans la fenêtre.
  const d = await reponseEcran({ lignes: [{ id: 'l-x', evenement: 'evenement:festival_disparu', zone: 'evenement', rang: 1, jour: 'samedi', nuit: null, niveau: 'Haut' }] })
  const sn = d.reglages_position.sans_nuit.filter(x => x.motif === 'evenement_absent')
  assert.equal(sn.length, 1, 'le serveur le signale')
  const html = r.rendreListe(d, r.indexerNuits(d.nuits), { filtre: 'tous', ouvert: null }, fmt, x => x)
  assert.match(html, /yfe\.sans_evenement_titre/)
  assert.match(html, /yfe\.motif_evenement_absent/)
  assert.equal(sn[0].type, 'evenement')
  // Sans nom connu, la clé rendue lisible — jamais la clé brute.
  assert.match(html, /Festival disparu/)
  assert.doesNotMatch(html, /evenement:festival_disparu/)
  // Un pont qui n'existe pas cette année (Noël 2026 tombe un vendredi) : le
  // serveur porte son nom et son type, et la page le titre par la table.
  const pont = await reponseEcran({ lignes: [{ id: 'l-p', evenement: 'pont:pont_noel', zone: 'evenement', rang: null, jour: null, nuit: null, niveau: 'Haut' }] })
  const sp = pont.reglages_position.sans_nuit.find(x => x.cle === 'pont:pont_noel')
  assert.deepEqual([sp.motif, sp.type, sp.nom], ['evenement_absent', 'pont', 'Noël'])
  const htmlPont = r.rendreListe(pont, r.indexerNuits(pont.nuits), { filtre: 'tous', ouvert: null }, { ...fmt, francais: true }, x => x)
  assert.match(htmlPont, /Pont du 25 décembre/)
})

test('une ligne `rang_requis` reste sur la carte de son événement, pas dans « pas d’événement cette année »', async () => {
  const r = await import(RENDU)
  const d = await reponseEcran({ lignes: [{ id: 'l-r', evenement: NOEL, zone: 'avant', rang: null, jour: null, nuit: null, niveau: 'Haut' }] })
  const sn = d.reglages_position.sans_nuit.find(x => x.motif === 'rang_requis')
  assert.ok(sn && !sn.occurrence)
  const noel = d.evenements.find(e => e.cle === NOEL)
  const html = r.rendreListe(d, r.indexerNuits(d.nuits), { filtre: 'tous', ouvert: r.idEvenement(noel) }, fmt, x => x)
  assert.doesNotMatch(html, /yfe\.sans_evenement_titre/)
  assert.match(html, /yfe\.sans_nuit_titre[\s\S]*yfe\.motif_rang_requis/)
})

test('la table des fériés nomme les fériés en français ; l’égalité des cinq niveaux avec le moteur est tenue', async () => {
  const r = await import(RENDU)
  const S = require('../lib/yield/suggestion')
  assert.deepEqual(r.NIVEAUX, S.NIVEAUX.map(n => n.nom))
  const fr = { ...fmt, francais: true }
  assert.equal(r.nomEvenement({ type: 'ferie', nom: 'Armistice 1918', cle: 'ferie:armistice_1918' }, fr.t, true), '11 novembre')
  assert.equal(r.nomEvenement({ type: 'pont', nom: 'Ascension', cle: 'pont:pont_ascension' }, fr.t, true), 'Pont de l’Ascension')
  assert.equal(r.nomEvenement({ type: 'week_end_prolonge', nom: 'Lundi de Pâques', cle: 'week_end_prolonge:lundi_de_paques' }, fr.t, true), 'Week-end de Pâques')
  // Hors du français, la composition i18n.
  assert.equal(r.nomEvenement({ type: 'pont', nom: 'Ascension', cle: 'pont:pont_ascension' }, fr.t, false), 'yfe.nom_pont{"nom":"Ascension"}')
})

test('LE TEST QUI COMPTE (règles V5) : aucun hexa dans la page, le rendu et la feuille ; chaque clé yfe existe en fr, en et es', () => {
  const fs = require('node:fs')
  const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  for (const f of ['apps/yield/evenements.html', 'shared/yield-evenements-rendu.js', 'shared/yield-evenements.css']) {
    const code = lire(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b(?![-\w])/, `${f} porte un hexa`)
  }
  const langues = ['fr', 'en', 'es'].map(l => JSON.parse(lire(`shared/i18n/${l}.json`)))
  const code = lire('apps/yield/evenements.html') + lire('shared/yield-evenements-rendu.js')
  const statiques = [...new Set([...code.matchAll(/'(yfe\.[a-z0-9_]+[a-z0-9])'/g)].map(m => m[1]))]
  // Les familles composées à l'exécution, nommées une par une.
  const dynamiques = [
    ...['officiel', 'commercial', 'mien'].map(x => 'yfe.famille_' + x),
    ...[1, 2, 3, 4, 5].map(n => 'yfe.niveau_' + n),
    ...['position_absente', 'evenement_absent', 'rang_requis'].map(x => 'yfe.motif_' + x),
    ...['bien_non_raccorde', 'calcul_impossible', 'configuration_incomplete'].map(x => 'yfe.indisponible_' + x),
    ...['nuit_date', 'nuit_samedi_rattache', 'avant', 'apres', 'avant_jour', 'apres_jour', 'avant_sans_rang', 'apres_sans_rang'].map(x => 'yfe.pos_' + x)
  ]
  assert.ok(statiques.length > 40, `${statiques.length} clés lues : la lecture a échoué`)
  for (const k of [...statiques, ...dynamiques]) {
    for (const [i, l] of langues.entries()) assert.ok(k in l, `${k} absente en ${['fr', 'en', 'es'][i]}`)
  }
})
