// tests/aujourdhui.test.js — page « Aujourd'hui » (refonte UI V5, lot 1).
// Deux familles : les REGLES DE COMPTAGE (shared/aujourdhui.js, fonctions
// pures, dates injectees) et les REGLES VERIFIABLES de la spec §6 (aucun hexa,
// aucun emoji, aucune icone dessinee, aucune cle de texte inconnue).
//
// ⚠ Dates FIGEES et injectees (`aujourdHui`) : aucune fonction testee ne lit
// l'horloge — regle du depot, ces tests ne rougiront pas avec le calendrier.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')
// Le code, sans ses commentaires : un « ⚠ » ou le nom d'un endpoint cite dans
// un commentaire n'est ni un emoji affiche ni un appel.
const sansCommentaires = src => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')
const charger = () => import('data:text/javascript,' + encodeURIComponent(lire('shared/aujourdhui.js')))

const BIENS = [
  { id: 'u-bulle', name: 'La bulle', provider_property_id: '101', checkin_time: '16:00:00', checkout_time: '11:00:00' },
  { id: 'u-coeur', name: 'Cœur de vie 23', provider_property_id: '102', checkin_time: null, checkout_time: '10:00' }
]
const J = '2026-10-10'

// ─── Arrivees et departs ────────────────────────────────────────────────────
test('evenementsDuJour : arrivees et departs du jour, tries par heure', async () => {
  const R = await charger()
  const evts = R.evenementsDuJour({
    aujourdHui: J, biens: BIENS,
    bookings: [
      { id: 'A', propId: '101', arrival: J, departure: '2026-10-12', firstName: 'Sofia', lastName: 'G.' },
      { id: 'D', propId: '102', arrival: '2026-10-07', departure: J, firstName: 'Paul', lastName: '' },
      { id: 'X', propId: '101', arrival: '2026-10-08', departure: '2026-10-11' },   // en cours : ni l'un ni l'autre
      { id: 'Z', propId: '999', arrival: J, departure: '2026-10-11' }               // bien hors perimetre
    ]
  })
  assert.deepEqual(evts.map(e => [e.type, e.bookingId, e.heure]), [['depart', 'D', '10:00'], ['arrivee', 'A', '16:00']])
  assert.equal(evts[1].nuits, 2)
  assert.equal(evts[1].voyageur, 'Sofia G.')
  assert.equal(evts[0].voyageur, 'Paul')
})

test('evenementsDuJour : une action seulement quand le coeur la PROUVE', async () => {
  const R = await charger()
  const base = { aujourdHui: J, biens: BIENS }
  const arr = (codeEtat) => R.evenementsDuJour({ ...base,
    bookings: [{ id: 'A', propId: '101', arrival: J, departure: '2026-10-11' }],
    etatsArrivee: codeEtat ? { A: { codeEtat } } : {} })[0]
  assert.equal(arr('cree').action, 'code', 'code cree mais pas transmis : a faire')
  assert.equal(arr('transmis').action, null)
  assert.equal(arr('aucun').action, null, 'aucun code : pas de serrure, rien a reclamer')
  assert.equal(arr(null).action, null, 'etat inconnu : on ne reclame rien')

  const dep = (status) => R.evenementsDuJour({ ...base,
    bookings: [{ id: 'D', propId: '101', arrival: '2026-10-08', departure: J }],
    menages: status ? [{ booking_id: 'D', property_id: '101', status, provider_id: 'p1' }] : [],
    prestataires: [{ id: 'p1', prenom: 'Régina' }] })[0]
  assert.equal(dep('unassigned').action, 'menage')
  assert.equal(dep('orphaned').action, 'menage')
  assert.equal(dep('accepted').action, null)
  assert.equal(dep('accepted').menage.prestataire, 'Régina')
  assert.equal(dep(null).action, null, 'pas de ligne menage : rien n\'est prouve')
})

test('evenementsDuJour : la cle composite bien|reservation (un id Beds24 n\'est unique que par bien)', async () => {
  const R = await charger()
  const [e] = R.evenementsDuJour({ aujourdHui: J, biens: BIENS,
    bookings: [{ id: '7', propId: '101', arrival: '2026-10-08', departure: J }],
    menages: [{ booking_id: '7', property_id: '102', status: 'unassigned' }] })
  assert.equal(e.menage.statut, null, 'le menage du bien 102 ne s\'applique pas au bien 101')
})

test('evenementsDuJour : le prenom vient du champ `prenom` de /api/menages, le tour de `proposee_a`', async () => {
  const R = await charger()
  // Forme EXACTE de la reponse de l'endpoint (api/menages.js : `prenom`, pas
  // `first_name`) — la premiere fixture copiait la colonne et figeait le bug.
  const src = lire('api/menages.js')
  assert.ok(/id: x\.id, prenom: x\.first_name/.test(src), 'la forme de la reponse a change : revoir la page')
  const dep = (menage) => R.evenementsDuJour({ aujourdHui: J, biens: BIENS,
    bookings: [{ id: 'D', propId: '101', arrival: '2026-10-08', departure: J }],
    menages: [{ booking_id: 'D', property_id: '101', ...menage }],
    prestataires: [{ id: 'p1', prenom: 'Régina' }, { id: 'p2', prenom: 'Lou' }] })[0]
  // Proposition de l'hote : statut garde 'unassigned', le tour dans `proposee_a`.
  const propose = dep({ status: 'unassigned', provider_id: null, offered_to: null, proposee_a: ['p1', 'p2'] })
  assert.equal(propose.action, null, 'une proposition en cours n\'est pas « personne »')
  assert.equal(propose.menage.statut, 'offered')
  assert.equal(propose.menage.proposeeA, 'Régina, Lou')
  // Ligne d'avant la bascule : `offered_to` seul.
  assert.equal(dep({ status: 'offered', offered_to: 'p2' }).menage.proposeeA, 'Lou')
  // Personne, et aucun tour : a faire.
  assert.equal(dep({ status: 'orphaned', proposee_a: [] }).action, 'menage')
})

test('chiffresFenetre : nuits en exception hors du taux, capacite estimee non comptee', async () => {
  const R = await charger()
  // 3 nuits vendues dont 2 un jour en exception (jour hors des jours ouverts) :
  // le taux ne doit pas depasser 100 % (le defaut « 300 % » du moteur).
  const exc = R.chiffresFenetre([
    { periode: '2026-10-01', ca: 100, nuitees: 1, nuits_a_prix_connu: 1, jours_ouverts: 1, nuitees_hors_reference: 0 },
    { periode: '2026-10-02', ca: 100, nuitees: 1, nuits_a_prix_connu: 1, jours_ouverts: 0, nuitees_hors_reference: 1 },
    { periode: '2026-10-03', ca: 100, nuitees: 1, nuits_a_prix_connu: 1, jours_ouverts: 0, nuitees_hors_reference: 1 }
  ], '2026-10-01', '2026-10-03')
  assert.equal(exc.ca, 300, 'le CA garde toutes les nuits')
  assert.equal(R.occupation(exc.nuitees, exc.joursOuverts), 1)
  const estime = R.chiffresFenetre([
    { periode: '2026-10-01', ca: 0, nuitees: 0, nuits_a_prix_connu: 0, jours_ouverts: 1, capacite_estimee: true }
  ], '2026-10-01', '2026-10-01')
  assert.equal(estime.joursOuverts, null, 'un denominateur estime n\'est pas un fait')
})

test('ajouterJours : arithmetique sur la date, stable au changement d\'heure', async () => {
  const R = await charger()
  assert.equal(R.ajouterJours('2026-10-26', -1), '2026-10-25')
  assert.equal(R.ajouterJours('2026-10-10', -60), '2026-08-11')
  assert.equal(R.ajouterJours('2026-03-29', 1), '2026-03-30')
  assert.equal(R.ajouterJours('2026-12-31', 1), '2027-01-01')
})

// ─── Etat des biens ─────────────────────────────────────────────────────────
test('etatDesBiens : occupe ce soir = arrivee <= jour < depart ; prochaine arrivee', async () => {
  const R = await charger()
  const e = R.etatDesBiens({ aujourdHui: J, biens: BIENS, bookings: [
    { propId: '101', arrival: '2026-10-08', departure: J },            // part ce matin : libre ce soir
    { propId: '101', arrival: '2026-10-20', departure: '2026-10-22' },
    { propId: '101', arrival: '2026-10-15', departure: '2026-10-17' },
    { propId: '102', arrival: '2026-10-09', departure: '2026-10-11' }
  ] })
  assert.deepEqual(e.get('101'), { occupeCeSoir: false, prochaineArrivee: '2026-10-15' })
  assert.deepEqual(e.get('102'), { occupeCeSoir: true, prochaineArrivee: null })
})

// ─── Chiffres sur une fenetre ───────────────────────────────────────────────
const jour = (periode, ca, nuitees, ouverts, prixConnus = nuitees) =>
  ({ periode, ca, nuitees, jours_ouverts: ouverts, nuits_a_prix_connu: prixConnus })

test('chiffresFenetre : somme du CA et des jours sur la fenetre exacte', async () => {
  const R = await charger()
  const realise = [jour('2026-10-01', 100, 1, 1), jour('2026-10-02', 0, 0, 1), jour('2026-10-03', 120, 1, 1), jour('2026-10-04', 999, 1, 1)]
  assert.deepEqual(R.chiffresFenetre(realise, '2026-10-01', '2026-10-03'), { ca: 220, nuitees: 2, joursOuverts: 3 })
})

test('chiffresFenetre : une nuit sans prix rend le CA non calculable (jamais un minorant)', async () => {
  const R = await charger()
  const c = R.chiffresFenetre([jour('2026-10-01', 100, 1, 1), jour('2026-10-02', 0, 1, 1, 0)], '2026-10-01', '2026-10-02')
  assert.equal(c.ca, null)
  assert.equal(c.joursOuverts, 2, 'l\'occupation, elle, reste calculable')
})

test('chiffresFenetre : un jour sans capacite ou absent rend l\'occupation non calculable', async () => {
  const R = await charger()
  assert.equal(R.chiffresFenetre([jour('2026-10-01', 0, 0, null), jour('2026-10-02', 0, 0, 1)], '2026-10-01', '2026-10-02').joursOuverts, null)
  const manque = R.chiffresFenetre([jour('2026-10-01', 50, 1, 1)], '2026-10-01', '2026-10-02')
  assert.equal(manque.joursOuverts, null)
  assert.equal(manque.ca, null, 'un jour absent : la somme ne couvre pas la fenetre')
})

test('variation : null sans base strictement positive', async () => {
  const R = await charger()
  assert.equal(R.variation(110, 100), 0.1)
  assert.equal(R.variation(110, 0), null)
  assert.equal(R.variation(null, 100), null)
  assert.equal(R.variation(110, null), null)
})

// ─── Min / max mensuel ──────────────────────────────────────────────────────
test('minMaxMensuel : depuis le premier mois vendu, ouverts et entierement tarifes', async () => {
  const R = await charger()
  const mois = [
    { periode: '2025-09', ca: 0, nuitees: 0, jours_ouverts: 30, nuits_a_prix_connu: 0 },       // OUVERT mais avant la premiere vente : exclu
    { periode: '2025-10', ca: 0, nuitees: 0, jours_ouverts: 0, nuits_a_prix_connu: 0 },        // ferme : exclu
    { periode: '2025-11', ca: 800, nuitees: 8, jours_ouverts: 30, nuits_a_prix_connu: 8 },     // premier mois vendu
    { periode: '2025-12', ca: 2400, nuitees: 20, jours_ouverts: 31, nuits_a_prix_connu: 20 },
    { periode: '2026-01', ca: 300, nuitees: 5, jours_ouverts: 31, nuits_a_prix_connu: 3 },     // nuits sans prix
    { periode: '2026-02', ca: 0, nuitees: 0, jours_ouverts: 28, nuits_a_prix_connu: 0 }        // ouvert, rien vendu APRES la premiere vente : vrai 0
  ]
  assert.deepEqual(R.minMaxMensuel(mois, '2025-09', '2026-09'), { min: 0, max: 2400, mois: 3 })
  assert.equal(R.minMaxMensuel([], '2025-10', '2026-09'), null)
  // Aucun mois vendu : rien a afficher, jamais une fourchette de zeros.
  assert.equal(R.minMaxMensuel([{ periode: '2025-11', ca: 0, nuitees: 0, jours_ouverts: 30, nuits_a_prix_connu: 0 }], '2025-10', '2026-09'), null)
})

test('tachesOuvertes : sejour non termine OU dernier message < 7 jours', async () => {
  const R = await charger()
  const maintenant = Date.UTC(2026, 9, 10, 12)
  const taches = [
    { id: 'a', book_id: 'B1', property_id: '101', status: 'pending_validation' },  // sejour en cours
    { id: 'b', book_id: 'B2', property_id: '102', status: 'pending' },             // sejour fini, message d'hier
    { id: 'c', book_id: 'B3', property_id: '101', status: 'pending_validation' },  // sejour fini, message vieux de 8 j
    { id: 'd', book_id: 'B4', property_id: '101', status: 'pending' }              // rien de connu : fermee
  ]
  const ouvertes = R.tachesOuvertes(taches, {
    aujourdHui: '2026-10-10', maintenant,
    bookings: [{ id: 'B1', propId: '101', departure: '2026-10-12' }],
    derniersMessages: new Map([
      ['B2', new Date(maintenant - 1 * 86400000).toISOString()],
      ['B3', new Date(maintenant - 8 * 86400000).toISOString()]
    ])
  })
  assert.deepEqual(ouvertes.map(x => x.id), ['a', 'b'])
})

test('noteSur5 : le coeur stocke sur 10, l\'ecran affiche sur 5', async () => {
  const R = await charger()
  assert.equal(R.noteSur5(9.4), 4.7)
  assert.equal(R.noteSur5(10), 5)
  assert.equal(R.noteSur5(9.57), 4.8)
  assert.equal(R.noteSur5(null), null)
})

test('douzeMoisComplets : les 12 mois qui precedent le mois en cours', async () => {
  const R = await charger()
  assert.deepEqual(R.douzeMoisComplets('2026-10-10'),
    { moisDebut: '2025-10', moisFin: '2026-09', jourDebut: '2025-10-01', jourFin: '2026-09-30' })
  assert.deepEqual(R.douzeMoisComplets('2026-01-05'),
    { moisDebut: '2025-01', moisFin: '2025-12', jourDebut: '2025-01-01', jourFin: '2025-12-31' })
})

// ─── Totaux du compte ───────────────────────────────────────────────────────
test('totaux : somme des biens, occupation en points, bien non raccorde hors total', async () => {
  const R = await charger()
  const tot = R.totaux([
    { actuel: { ca: 1000, nuitees: 20, joursOuverts: 30 }, precedent: { ca: 800, nuitees: 15, joursOuverts: 30 } },
    { actuel: { ca: 500, nuitees: 10, joursOuverts: 30 }, precedent: { ca: 700, nuitees: 15, joursOuverts: 30 } },
    { nonRaccorde: true }
  ])
  assert.equal(tot.ca, 1500)
  assert.equal(tot.caVariation, 0)
  assert.equal(tot.occupation, 0.5)
  assert.equal(tot.occupationEcart, 0)
})

test('totaux : un bien illisible rend tout le total non calculable (jamais un total ampute)', async () => {
  const R = await charger()
  const tot = R.totaux([
    { actuel: { ca: 1000, nuitees: 20, joursOuverts: 30 }, precedent: { ca: 800, nuitees: 15, joursOuverts: 30 } },
    { erreur: true }
  ])
  assert.deepEqual(tot, { ca: null, caVariation: null, occupation: null, occupationEcart: null })
  const caNul = R.totaux([{ actuel: { ca: null, nuitees: 1, joursOuverts: 30 }, precedent: { ca: 10, nuitees: 1, joursOuverts: 30 } }])
  assert.equal(caNul.ca, null)
  assert.equal(caNul.caVariation, null)
  assert.ok(caNul.occupation != null)
})

// ─── Regles verifiables de la spec §6 ───────────────────────────────────────
const FICHIERS_V5 = ['pages/aujourdhui.html', 'shared/ui.css', 'shared/nav.js', 'shared/aujourdhui.js']

test('aucun hexa hors de shared/theme.css', () => {
  for (const f of FICHIERS_V5) {
    assert.ok(!/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/.test(lire(f).replace(/&#\d+;/g, '')), `${f} contient une couleur en dur`)
  }
})

test('aucun emoji dans l\'interface V5', () => {
  const emoji = /\p{Extended_Pictographic}/u
  for (const f of [...FICHIERS_V5, 'shared/i18n/fr.json', 'shared/i18n/en.json', 'shared/i18n/es.json']) {
    assert.ok(!emoji.test(sansCommentaires(lire(f))), `${f} contient un emoji`)
  }
})

test('aucune icone dessinee dans la page : <use href="/shared/icons.svg#…"> seulement', () => {
  const html = lire('pages/aujourdhui.html')
  assert.ok(!/<(path|circle|rect|polyline|line)\b/.test(html), 'forme SVG dessinee dans la page')
  const sprite = lire('shared/icons.svg')
  for (const src of [html, lire('shared/nav.js')]) {
    for (const m of src.matchAll(/icon(?:e)?\('([\w-]+)'/g)) {
      assert.ok(sprite.includes(`id="${m[1]}"`), `icone ${m[1]} absente du sprite`)
    }
    for (const m of src.matchAll(/icons\.svg#([\w-]+)/g)) {
      assert.ok(sprite.includes(`id="${m[1]}"`), `icone ${m[1]} absente du sprite`)
    }
  }
})

test('chaque cle de texte utilisee existe en francais', () => {
  const fr = JSON.parse(lire('shared/i18n/fr.json'))
  for (const f of ['pages/aujourdhui.html', 'shared/nav.js']) {
    const src = lire(f)
    const cles = new Set([
      ...[...src.matchAll(/data-i18n="([\w.]+)"/g)].map(m => m[1]),
      ...[...src.matchAll(/data-i18n-attr="[\w-]+:([\w.]+)"/g)].map(m => m[1]),
      ...[...src.matchAll(/\bt\('([\w.]+)'/g)].map(m => m[1]),
      ...[...src.matchAll(/cle: '([\w.]+)'/g)].map(m => m[1]),
      ...[...src.matchAll(/key: '([\w.]+)'/g)].map(m => m[1])
    ])
    assert.ok(cles.size > 10, `${f} : extraction des cles vide`)
    for (const k of cles) assert.ok(k in fr, `${f} : cle « ${k} » absente de fr.json`)
  }
})

test('la page ne parle a aucun provider et n\'utilise pas channel-property (appel Beds24 en direct)', () => {
  const html = sansCommentaires(lire('pages/aujourdhui.html'))
  for (const interdit of ['/api/beds24', '/api/channel-property', '/api/channel-mapping', 'beds24.com', 'channex', '/api/serrures']) {
    assert.ok(!html.toLowerCase().includes(interdit.toLowerCase()), `appel interdit : ${interdit}`)
  }
})

test('pas de tuile access_codes tant que l\'INSERT du cron ne pose pas user_id (dette 62)', () => {
  const html = sansCommentaires(lire('pages/aujourdhui.html'))
  assert.ok(!html.includes("'access_codes'"), 'la RLS rend 0 sur les lignes sans user_id : un faux zero')
  assert.ok(!/done\.codes/.test(html), 'la tuile codes ne revient qu\'avec le bloquant (d)')
})

test('chaque fetch de la page pose X-Compte', () => {
  const html = lire('pages/aujourdhui.html')
  const appels = [...html.matchAll(/fetch\(/g)]
  assert.ok(appels.length >= 2)
  for (const m of appels) {
    assert.ok(html.slice(m.index, m.index + 300).includes('enteteCompte()'), 'fetch sans enteteCompte()')
  }
})

test('l\'ancien accueil redirige vers /pages/aujourdhui, et la connexion y mene', () => {
  const index = lire('pages/index.html')
  assert.ok(index.includes("location.replace('/pages/aujourdhui'"))
  const vercel = JSON.parse(lire('vercel.json'))
  const dash = vercel.rewrites.find(r => r.source === '/dashboard')
  assert.equal(dash.destination, '/pages/aujourdhui', 'cleanUrls : destination sans .html')
})

test('l\'alarme de surreservation et son acquittement sont repris sur l\'accueil', () => {
  const html = lire('pages/aujourdhui.html')
  assert.ok(html.includes("/api/incidents-acquitter?type=overbooking"))
  assert.ok(/method: 'POST'[\s\S]{0,200}\/api\/incidents-acquitter|\/api\/incidents-acquitter'[\s\S]{0,60}method: 'POST'/.test(html))
  assert.ok(html.includes("peutEcrire('reservations')"), 'le bouton d\'acquittement suit le droit de l\'endpoint')
})
