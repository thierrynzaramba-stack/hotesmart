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

test('tachesOuvertes : seulement les sejours A VENIR ou EN COURS (regle du 11 octobre)', async () => {
  const R = await charger()
  const taches = [
    { id: 'a', book_id: 'B1', property_id: '101', status: 'pending_validation' },  // sejour en cours
    { id: 'b', book_id: 'B2', property_id: '102', status: 'pending' },             // sejour fini, message recent : NE compte PLUS
    { id: 'v', book_id: 'B5', property_id: '101', status: 'pending_validation' },  // sejour a venir
    { id: 'd', book_id: 'B4', property_id: '101', status: 'pending' }              // rien de connu : fermee
  ]
  const ouvertes = R.tachesOuvertes(taches, {
    aujourdHui: '2026-10-10',
    bookings: [
      { id: 'B1', propId: '101', departure: '2026-10-12' },
      { id: 'B5', propId: '101', departure: '2026-10-28' }
    ]
  })
  assert.deepEqual(ouvertes.map(x => x.id), ['a', 'v'],
    'un sejour termine ne produit plus de « message a traiter », meme recent')
  // ⚠ REPLI SUR LES DATES DE LA TACHE (releve en review) : une tache dont le
  // sejour n'est pas dans `bookings` (page 1 seulement, droit menages absent,
  // panne) survit par son propre `departure` a venir.
  const repli = R.tachesOuvertes([
    { id: 'r1', book_id: 'X1', property_id: '101', departure: '2026-10-20' },
    { id: 'r2', book_id: 'X2', property_id: '101', departure: '2026-09-01' },
    { id: 'r3', book_id: 'X3', property_id: '101' }
  ], { aujourdHui: '2026-10-10', bookings: [] })
  assert.deepEqual(repli.map(x => x.id), ['r1'],
    'le depart a venir porte par la tache suffit ; passe ou inconnu, non')
})

test('LE TEST QUI COMPTE : l ecran ne convertit plus la note — plus de `noteSur5` ici', async () => {
  // Retiree le 20 octobre 2026. Elle divisait par deux une moyenne que
  // `lib/stats-avis.js` avait DEJA arrondie : deux arrondis pour une note, donc
  // Colomiers affichait 4,8 la ou le calcul juste donne 4,7. La conversion vit
  // desormais cote serveur, dans `lib/avis/echelle.js`, et les endpoints
  // descendent `note_sur_5`.
  const R = await charger()
  assert.equal(R.noteSur5, undefined,
    'une seconde conversion a l ecran reintroduirait le double arrondi')
  const source = fs.readFileSync(path.join(__dirname, '..', 'pages', 'aujourdhui.html'), 'utf8')
  assert.doesNotMatch(source, /noteSur5/, 'la page ne doit plus convertir')
  // ⚠ LA PAGE NE NOMME PLUS `note_sur_5` DEPUIS L'ETAPE 4, et ce n'est pas une
  // perte : elle le nommait pour l'ETOILE de chaque carte de logement, et les
  // cartes partent avec le bloc « Vos logements » (inventaire I28). La note
  // s'affiche maintenant par le module partage `shared/avis-recents.js`, qui
  // lit `note_sur_5` et le rend — teste chez lui, `tests/avis-recents-dom.test.js`.
  // Ce qui compte ici est l'invariant : AUCUNE conversion a l'ecran.
  assert.match(source, /avis-recents/,
    'la page ne passe plus par le module qui rend la note — qui la rend, alors ?')
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
  // ⚠ RETARGE AU LOT (b) : LA LECTURE A DEMENAGE, L'ACQUITTEMENT NON.
  // La page faisait `GET /api/incidents-acquitter?type=overbooking` ; cette
  // lecture est maintenant un bloc de l'appel d'ecran. L'ACQUITTEMENT, lui,
  // reste un POST depuis la page — c'est un geste de l'hote, pas un
  // chargement — et il garde son droit d'ecriture.
  const html = lire('pages/aujourdhui.html')
  const endpoint = lire('api/ecran/aujourdhui.js')
  // La lecture, cote serveur, et sur le bon type d'incident.
  assert.ok(/from\('automation_incidents'\)/.test(endpoint),
    'l endpoint d ecran ne lit plus les incidents : l alarme disparaitrait de l accueil')
  assert.ok(/'overbooking'/.test(endpoint), 'il lit les incidents sans filtrer la surreservation')
  // ⚠ ET SEULS LES NON ACQUITTES : sans ce filtre, une alarme eteinte
  // reapparaitrait a chaque chargement, et l acquittement ne servirait a rien.
  assert.ok(/is\('acquitted_at', null\)/.test(endpoint),
    'l endpoint ne filtre pas les alarmes deja acquittees')
  // L acquittement, cote page.
  assert.ok(/method: 'POST'[\s\S]{0,200}\/api\/incidents-acquitter|\/api\/incidents-acquitter'[\s\S]{0,60}method: 'POST'/.test(html))
  assert.ok(html.includes("peutEcrire('reservations')"), 'le bouton d\'acquittement suit le droit de l\'endpoint')
})

// ═══════════════════════════════════════════════════════════════════════════
// La note affichée sur l'accueil — le constat M2 de la revue du 20 octobre 2026
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ CE BLOC EXISTE PARCE QUE DEUX MUTATIONS SURVIVAIENT. La revue a mesuré que
// remplacer `note.note_sur_5` par `note.moyenne` dans les DEUX endroits faisait
// disparaître la note du bandeau ET l'étoile de chaque logement — en silence,
// avec 33 tests sur 33 au vert. Le seul garde-fou était un `assert.match` sur
// la chaîne `note_sur_5`, que la ligne 457 satisfaisait à elle seule.
//
// On exerce donc les DEUX expressions telles qu'elles sont écrites dans la
// page, et pas une copie : les réécrire ici ferait un test qui reste vert le
// jour où la page les perd.
const { JSDOM } = require('jsdom')

// Extrait une expression de la page, de son ancre jusqu'à la fin de la ligne
// suivante — la forme des deux ternaires de la page.
function expressionDeLaPage (ancre, lignes) {
  const src = lire('pages/aujourdhui.html').split('\n')
  const i = src.findIndex(l => l.includes(ancre))
  assert.notEqual(i, -1, `ancre introuvable dans pages/aujourdhui.html : ${ancre}`)
  return src.slice(i, i + lignes).join('\n')
}

function contexteDeRendu (dom) {
  return {
    document: dom.window.document, window: dom.window,
    $: (s) => dom.window.document.querySelector(s),
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    icone: (id, cls = 'icon') => `<svg class="${cls}" data-icone="${id}"></svg>`,
    t: (k, v = {}) => `[${k}]${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')}`,
    // ⚠ Le VRAI format du moteur : « 4,7 » et pas « 4.7 ».
    I18n: { num: (x, o) => new Intl.NumberFormat('fr', o).format(x) }
  }
}

// ⚠ LE BANDEAU « Note · 30 j » EST RETIRE A L'ETAPE 1, ET SON TEST AVEC LUI.
// L'invariant qu'il gardait — « la note descend DEJA sur 5, l'ecran ne la
// redivise pas, sinon Colomiers affiche 4,8 au lieu de 4,7 » — n'est pas perdu :
// le test suivant le tient sur l'etoile de CHAQUE logement, qui reste a
// l'ecran, et il reviendra sur l'en-tete du bloc « Derniers avis » a l'etape 2.
// Le supprimer sans dire ou l'invariant continue de vivre serait exactement le
// retrait par omission que l'inventaire de ce lot existe pour empecher.
test('LE TEST QUI COMPTE (M2) : la page ne FORMATE plus aucune note elle-meme', async () => {
  // ⚠ CE TEST GARDAIT L'ETOILE DE CHAQUE CARTE DE LOGEMENT, qui n'existe plus :
  // les cartes partent avec le bloc « Vos logements » a l'etape 4 (inventaire
  // I28). Il tenait trois choses, et voici ou chacune est passee :
  //   · « 4,9 et non 2,5 » — la note n'est pas reconvertie : tenu ci-dessus
  //     (`noteSur5` absente de la page) et par le module partage ;
  //   · « un bien sans note n'affiche pas d'etoile a zero » — tenu dans
  //     `shared/avis-recents.js` et teste chez lui ;
  //   · « data-icone="i-review" » — l'icone de l'etoile, qui vit maintenant
  //     dans le module.
  //
  // Ce qui reste a garder sur la PAGE est l'invariant de frontiere : elle ne
  // formate aucune note, donc aucun arrondi ne peut y naitre. Un deuxieme
  // arrondi est exactement ce qui faisait afficher 4,8 a Colomiers la ou le
  // calcul juste donne 4,7.
  const source = fs.readFileSync(path.join(__dirname, '..', 'pages', 'aujourdhui.html'), 'utf8')
  const code = source.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('<!--')).join('\n')
  for (const interdit of [/noteSur5/, /\/\s*10\b/, /toFixed\s*\(\s*1\s*\)/]) {
    assert.doesNotMatch(code, interdit,
      `la page formate ou reconvertit une note : ${interdit}`)
  }
  // Et la note qu'elle garde en memoire est celle du serveur, telle quelle.
  assert.match(code, /etat\.noteGlobale = lu \? lu\.global : null/,
    'la note globale n est plus prise telle quelle du serveur')
})
test("LE TEST QUI COMPTE : la banniere de surreservation est RENDUE, pas seulement lue", () => {
  // ⚠ LE CONSTAT LE PLUS GRAVE DE LA REVIEW. En deplacant la lecture des
  // alarmes vers l'appel d'ecran, j'ai emporte l'appel de rendu avec elle :
  // l'ancienne `chargerAlarmes()` finissait par `renderAlarmes(); renderTitre()`.
  // Mesure : `grep -rn renderAlarmes` ne trouvait QUE sa definition, dans tout
  // le depot. La banniere ne pouvait donc plus jamais s'afficher — et avec
  // elle le bouton « Acquitter », que cette page designe comme « le SEUL moyen
  // d'arreter la reemission des SMS » (spec-reservation-manuelle.md §4).
  // L'alarme comptait dans le total « a traiter » sans que rien ne la montre,
  // et l'alerte au fondateur ne pouvait plus etre eteinte.
  // ⚠ HORS COMMENTAIRES — ET MA PREMIERE VERSION COMPTAIT LES MENTIONS.
  // J'avais ecrit un long commentaire expliquant le defaut, qui citait
  // `renderAlarmes()` DEUX fois : `assert.ok(appels >= 2)` etait donc satisfait
  // par mon propre commentaire. Le garde-fou du constat le plus grave de la
  // review precedente aurait survecu a la suppression de l'appel reel.
  const html = lire('pages/aujourdhui.html')
  // ⚠ PAS DE PASSE `/* */` SUR CETTE PAGE : elle en detruit presque tout le
  // script (un `/*` de CSS, un `*/` dans une chaine, et le depouilleur avale
  // le fichier — mesure du 23 octobre 2026 : la definition elle-meme
  // disparaissait). Les lignes ENTIEREMENT commentees suffisent : c'est la
  // forme de tous les commentaires de ce depot.
  const code = html.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const definitions = (code.match(/function renderAlarmes\s*\(/g) || []).length
  const appels = (code.match(/renderAlarmes\(\)/g) || []).length
  assert.strictEqual(definitions, 1, 'renderAlarmes doit etre defini une fois')
  assert.ok(appels >= 2,
    `renderAlarmes n'est appele ${appels - 0} fois hors de sa definition : la banniere `
    + 'de surreservation ne peut pas s afficher, et le bouton d acquittement est injoignable')
  // Il doit etre dans la liste de rendu du chargement, pas seulement ailleurs.
  assert.match(code, /renderEvenements\(\);[^\n]*renderAlarmes\(\)/,
    'renderAlarmes n est pas dans la liste de rendu du chargement')
})

test("LE TEST QUI COMPTE : l'acquittement retire l'alarme et REND, sans relire le reseau", () => {
  // `chargerAlarmes()` ne fait plus d'appel reseau depuis ce lot : elle relit
  // `etat.ecran.alarmes`, la reponse CAPTUREE au chargement, qui contient
  // encore l'incident qu'on vient d'acquitter — et aucun rendu ne suivait.
  // L'hote voyait le bouton rester sur « Acquittement… », l'alarme rester a
  // l'ecran, puis, en recliquant, un ECHEC : le POST est idempotent
  // (`.is('acquitted_at', null)`), donc le second part en 404 et le bouton
  // bascule sur « Reessayer ». Un acquittement reussi rapporte comme un echec.
  const html = lire('pages/aujourdhui.html')
  const bloc = (html.match(/async function acquitter[\s\S]*?\n\}/) || [''])[0]
  assert.ok(bloc, 'la fonction acquitter a disparu')
  assert.ok(!/await chargerAlarmes\(\)/.test(bloc),
    'acquitter relit `etat.ecran.alarmes`, qui contient encore l alarme acquittee')
  assert.match(bloc, /etat\.alarmes\s*=\s*\(etat\.alarmes \|\| \[\]\)\.filter/,
    'l alarme acquittee n est pas retiree de l etat')
  assert.match(bloc, /etat\.ecran\.alarmes\s*=\s*etat\.ecran\.alarmes\.filter/,
    'la reponse gardee en etat garde l alarme : un rechargement partiel la ferait revenir')
  // ⚠ `renderTitre()` N'EST PLUS DANS CETTE PAIRE, ET CE N'EST PAS UN OUBLI.
  // L'ancienne ligne resume comptait l'alarme dans son « N a traiter » : la
  // retirer de l'etat sans re-rendre le titre laissait un compte faux. Depuis
  // l'etape 1, le seul compte de l'ecran est celui de « A valider », qui compte
  // les TACHES — une alarme acquittee ne le change pas. Re-rendre le titre
  // serait du bruit, et le laisser ici ferait croire a un lien qui n'existe plus.
  assert.match(bloc, /renderAlarmes\(\)/,
    'rien ne re-rend apres l acquittement')
  assert.ok(!/renderTitre/.test(bloc),
    'renderTitre a ete retire a l etape 1 : son appel ici ne peut etre qu un reste')
})

test("LE TEST QUI COMPTE : l'affichage instantane n'affirme aucun faux zero", () => {
  // ⚠ LE LOT VENDAIT CE PREMIER AFFICHAGE, ET IL AFFICHAIT FAUX. Le cache ne
  // porte pas les sejours (`/api/menages`, hors de l'appel d'ecran) : a ce
  // point `etat.bookings` est VIDE. Rendre « A valider », le sous-titre compte
  // et les cartes de biens depuis cet etat donnait « 0 arrivee · 0 depart ·
  // 0 a traiter » et « Aucune arrivee prevue » sur chaque bien — des FAITS,
  // affirmes, puis dementis une seconde plus tard.
  const html = lire('pages/aujourdhui.html')
  const bloc = (html.match(/const duCache = CacheEcran\.lire[\s\S]*?\n  \}/) || [''])[0]
  assert.ok(bloc, 'la branche du cache a disparu')
  assert.ok(!/renderTitre\(\)/.test(bloc),
    'le premier affichage rend le sous-titre compte : « 0 arrivee · 0 depart » sans avoir lu les sejours')
  assert.ok(!/renderTaches\(\)/.test(bloc),
    'le premier affichage rend « A valider » : la regle des taches a besoin des sejours, '
    + 'et les taches ne sont plus dans le cache (elles portent le code d acces)')
  // ⚠ LA LISTE, PAS LA SEQUENCE. Ma premiere version exigeait la chaine
  // « renderCompteurs(); renderBiens() » au caractere : ajouter un rendu
  // legitime entre les deux — les derniers avis, etape 2 — faisait rougir un
  // test qui n'avait rien a dire sur cet ajout. Ce qui compte n'est pas
  // l'ordre des appels, c'est QUELS blocs le cache a le droit de peindre :
  // ceux dont il porte vraiment les donnees. Un rendu de plus ici doit etre un
  // choix, et c'est cette assertion qui oblige a le declarer.
  const rendus = [...bloc.matchAll(/\b(render[A-Za-z]+)\(\)/g)].map(m => m[1]).sort()
  assert.deepEqual(rendus, ['renderCompteurs', 'renderDerniersAvis', 'renderRevenus'],
    'le premier affichage peint autre chose que ce que le cache porte : ' + rendus.join(', ')
    + '. Les sejours n y sont pas (ils viennent de /api/menages), les taches et les '
    + 'alarmes non plus (le cache refuse de les ecrire).')
  // ⚠ ET LA MEME REGLE, TRANSPOSEE AU BLOC QUI A REMPLACE LES CARTES. L'ancienne
  // assertion gardait « `etat.menagesOk === true ? (e.prochaineArrivee` » : la
  // carte d'un bien n'affirmait « Aucune arrivee prevue » qu'apres avoir lu les
  // sejours. Les cartes partent a l'etape 4 ; la regle, elle, ne part pas —
  // c'est la meme famille de faux zero, sur une autre donnee.
  //
  // Dans « Revenus nets », le faux zero serait un total a 0 € affiche alors que
  // la lecture a echoue : l'hote lirait « ce mois n'a rien rapporte », un FAIT.
  // Le bloc doit donc refuser de peindre un total sans `rev.total`.
  assert.match(html, /if \(!rev \|\| !rev\.total\)/,
    'le bloc revenus peint un total sans verifier qu il a ete lu')
  assert.match(html, /revenue\.unavailable/,
    'une lecture de revenus en echec s afficherait comme un mois a zero euro')
  // Et l'ordre compte : le refus AVANT toute peinture de chiffre.
  //
  // ⚠ L'INVARIANT EST « LE TOTAL N'EST PAS DEREFERENCE AVANT SA GARDE », et
  // cette assertion a ete reformulee DEUX FOIS le 26 octobre 2026 :
  //
  //   · elle cherchait d'abord la chaine
  //     `$('[data-bind="revenue-total"]').textContent = euros` AU CARACTERE.
  //     Ajouter la garde « tous les sejours non calculables » a change la forme
  //     de l'affectation sans toucher a l'invariant, et le test a rougi en
  //     annoncant « le total est peint avant le refus » — ce qui etait FAUX.
  //     C'est le defaut que le test voisin declare avoir corrige (« LA LISTE,
  //     PAS LA SEQUENCE ») : il vivait encore ici.
  //   · puis j'ai cherche le NŒUD `revenue-total`, et c'etait faux aussi : sa
  //     premiere occurrence est dans `videDuTotal()`, la fonction de repli que
  //     le refus APPELLE. Elle est donc definie avant lui, par construction.
  //
  // Ce qui ne peut pas se contourner : `rev.total` est lu dans une variable
  // APRES la garde, et c'est cette variable que le bandeau peint.
  const blocRevenus = (html.match(/function renderRevenus[\s\S]*?\n\}/) || [''])[0]
  const iRefus = blocRevenus.indexOf('if (!rev || !rev.total)')
  const iLecture = blocRevenus.indexOf('const T = rev.total')
  assert.ok(iRefus > -1, 'le refus a disparu de renderRevenus')
  assert.ok(iLecture > -1, 'le total n est plus lu dans `T` : ce test ne mesure plus rien')
  assert.ok(iRefus < iLecture,
    'le total est dereference avant que le refus ne soit evalue')
  // Et c'est bien `T` que le bandeau peint, pas `rev.total` en direct.
  const apres = blocRevenus.slice(iLecture)
  assert.match(apres, /revenue-total[\s\S]{0,400}euros\(T\./,
    'le bandeau peint autre chose que le total garde')
})

test("LE TEST QUI COMPTE : un echec de l'appel d'ecran ne re-date pas le cache", () => {
  // Sans ce garde, le cache ne perimait JAMAIS : `etat.ecran` garde l'objet
  // restaure du cache quand l'appel echoue, et la suite le reecrivait avec un
  // horodatage NEUF. Deux jours de 503 et l'hote lisait les chiffres de lundi,
  // re-dates a chaque ouverture, le plafond de 12 h hors d'atteinte. Pire cas :
  // un membre revoque en cours de session recoit 403 de la garde et continue
  // de voir les chiffres du compte dont il vient d'etre retire.
  const html = lire('pages/aujourdhui.html')
  // ⚠ « RESOLUE » N'EST PAS « REPONDUE », et ma premiere version se contentait
  // de la promesse tenue. `appel()` fait `r.json().catch(() => ({}))` : un 200
  // porteur de HTML — la panne que la memoire du projet decrit sous « URL sans
  // /api/v1 : 200 + HTML = 0 bien silencieux » — rend `{}` et RESOUT. On
  // effacait alors l'age, on affichait un ecran vide, et on ECRASAIT un bon
  // cache par `{}` pour 12 h. `jour` est le champ que l'endpoint rend toujours.
  assert.match(html, /chargerEcran\(\)\.then\(r => \{ ecranFrais = !!\(r && r\.jour\) \}\)/,
    'une reponse vide ou illisible passe pour une reponse du serveur')
  assert.match(html, /if \(ecranFrais && etat\.ecran\) CacheEcran\.ecrire/,
    'le cache est reecrit meme quand l appel d ecran a echoue')
  assert.match(html, /if \(ecranFrais\) etat\.ageCache = null/,
    'l age repasse a « frais » alors que les donnees viennent du cache')
})

test("LE TEST QUI COMPTE : le compte de « A valider » ne s'affiche qu'APRES avoir LU", () => {
  // ⚠ CE TEST A CHANGE DE CIBLE A L'ETAPE 1, ET PAS D'INVARIANT. Il gardait la
  // ligne resume — « {date} · N arrivees · N departs · N a traiter » —, retiree
  // le 24 octobre 2026 sur decision de Thierry. Ce qu'elle portait de precieux
  // n'etait pas la phrase : c'etait la regle « un compte est un FAIT, et il
  // demande d'avoir lu ». Le compte survit a cote du titre « A valider », donc
  // la regle le suit.
  //
  // L'histoire, gardee parce qu'elle se rejouera : `renderEvenements` etait
  // garde, `renderBiens` l'a ete ensuite, et `renderTitre` comptait toujours
  // sur `etat.bookings` — vide quand `/api/menages` echoue. L'hote lisait
  // « indisponible » dans la liste ET « 0 arrivee · 0 depart » dans le titre du
  // MEME ecran.
  const html = lire('pages/aujourdhui.html')
  const bloc = (html.match(/function renderTaches[\s\S]*?\n\}/) || [''])[0]
  assert.ok(bloc, 'renderTaches a change de forme')
  // La garde est en tete de la fonction : sans elle, le compte s'ecrirait
  // meme quand la lecture des taches a echoue.
  const iGarde = bloc.indexOf('if (!etat.tachesOk)')
  const iCompte = bloc.indexOf('validate-count')
  assert.ok(iGarde >= 0, 'le compte ne verifie plus que les taches ont ete LUES')
  assert.ok(iCompte > iGarde,
    'le compte s ecrit avant la garde : une lecture en echec afficherait un nombre invente')
  assert.match(bloc, /validate\.count_capped/,
    'le compte ne porte pas le « + » quand le serveur a plafonne la liste')
  // Et il ne dit RIEN plutot que « 0 » : un zero a cote d'un titre se lit comme
  // un fait, et la liste en dessous dit deja « rien a valider ».
  assert.match(bloc, /visibles\.length\s*\n?\s*\?/,
    'le compte affiche « 0 » au lieu de se taire')
})

test("LE TEST QUI COMPTE : des biens ILLISIBLES ne s'affichent pas comme « aucun bien »", () => {
  // L'endpoint rend `null` quand il n'a pas pu lire. `section.hidden = !length`
  // faisait disparaitre la section, les notes et les indicateurs sans
  // explication — en laissant « + Ajouter un bien » visible.
  // ⚠ TRANSPOSE A `renderRevenus` (etape 4) : le bloc « Vos logements » est
  // remplace par « Revenus nets », et les TROIS etats que ce test garde sont
  // repris mot pour mot — lecture en echec, pas encore lue, lue et vide.
  const html = lire('pages/aujourdhui.html')
  const bloc = (html.match(/function renderRevenus[\s\S]*?\n  if \(vide\) vide\.hidden = true/) || [''])[0]
  assert.ok(bloc, 'renderRevenus a change de forme')
  assert.match(bloc, /!Array\.isArray\(etat\.biens\)/,
    'une lecture de biens en echec est traitee comme une liste vide')
  assert.match(bloc, /revenue\.unavailable/, 'rien ne dit a l hote que la lecture a echoue')

  // ⚠ ET LE RISQUE JUMEAU, NE A L'ETAPE 1 : « Ajoutez votre premier logement »
  // sur un compte qui en a quatre. `etat.biens` vaut `[]` tant que l'appel
  // d'ecran n'a pas repondu ; l'etat vide ne se montre que si la liste a
  // VRAIMENT ete lue. Le module commun porte la meme garde pour la page
  // Logements, et pour la meme raison : a l'onboarding, une reconciliation
  // contre une liste amputee CREE des biens en double chez le canal.
  assert.match(bloc, /const listeLue = !!\(etat\.ecran && Array\.isArray\(etat\.ecran\.biens\)\)/,
    'l etat vide ne verifie pas que la liste a ete lue')
  const iLue = bloc.indexOf('listeLue')
  const iVide = bloc.indexOf("etatHtml('vide'")
  assert.ok(iVide > iLue, 'l etat vide s affiche avant de savoir si la liste a ete lue')
})

test("LE TEST QUI COMPTE : une liste de taches PLAFONNEE s'affiche avec un « + »", () => {
  // L'endpoint annonce `tronquees: ['taches']` des aujourd'hui — 222 taches
  // ouvertes pour un plafond de 200. Afficher le nombre exact serait un compte
  // faux avec aplomb, et `tronquees` etait un signal que PERSONNE ne lisait.
  const html = lire('pages/aujourdhui.html')
  assert.match(html, /function tachesPlafonnees/, 'rien ne lit le drapeau de troncature')
  assert.match(html, /tronquees[\s\S]{0,120}includes\('taches'\)/,
    'le drapeau de troncature des taches n est pas lu')
  assert.match(html, /tachesPlafonnees\(\)\s*\n?\s*\?\s*t\('validate\.capped'/,
    "le compte affiche ne porte pas le « + » quand la liste est plafonnee")
})

test("LE TEST QUI COMPTE : au premier affichage, les biens arrivent AVANT les notes", () => {
  // `chargerNotes` boucle SUR `etat.biens` pour remplir `notesParBien` : appele
  // avant, il tourne sur `[]` et les etoiles manquent au premier affichage —
  // celui que ce lot, le KB et la spec promettent tous les trois.
  const html = lire('pages/aujourdhui.html')
  const bloc = (html.match(/const duCache = CacheEcran\.lire[\s\S]*?\n  \}/) || [''])[0]
  const iBiens = bloc.indexOf('etat.biens = await lireBiens()')
  const iNotes = bloc.indexOf('chargerNotes()')
  assert.ok(iBiens >= 0 && iNotes >= 0, 'la branche du cache a change de forme')
  assert.ok(iBiens < iNotes,
    'les notes sont chargees avant les biens : leur boucle tourne sur une liste vide')
})

test('le bloc revenus distingue « calcul en cours » de « non calculable »', () => {
  // ⚠ UN TEST DE FORME, ET JE L'ASSUME. Le bloc des revenus n'a pas de harnais
  // DOM dans ce fichier — les trois tests voisins lisent deja le code par
  // `indexOf`. Ce qui est mesure PAR APPEL, dans
  // tests/ecran-aujourdhui-isolation.test.js, c'est la DECISION : l'endpoint
  // refuse de rendre un chiffre quand le calcul n'est pas fini. Ici on verifie
  // seulement que la page ne reduit pas les deux motifs a un seul mot.
  //
  // POURQUOI CA COMPTE : « non calculable » decrit un defaut — il n'y a rien a
  // attendre. « Calcul en cours » decrit un etat transitoire : les minutes qui
  // suivent le collage d'une migration, ou une nuit de rattrapage. Afficher le
  // premier pour le second fait conclure a une panne, et c'est ce qu'un hote
  // signale au fondateur.
  const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'aujourdhui.html'), 'utf8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(code, /revenus_calcul_en_cours/,
    'la page ne lit plus le motif « calcul en cours » : les deux etats se confondent')
  assert.match(code, /t\(calculEnCours\(\) \? 'revenue\.computing' : 'revenue\.unavailable'\)/,
    'le total ne choisit plus son motif')
  // ⚠ ET LES DEUX CLEFS EXISTENT DANS LES TROIS LANGUES, sinon l'ecran
  // afficherait la clef brute — le defaut que `scripts/i18n-check.js` garde,
  // verifie ici parce que cette clef est neuve.
  for (const langue of ['fr', 'en', 'es']) {
    const dict = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'shared', 'i18n', `${langue}.json`), 'utf8'))
    for (const clef of ['revenue.computing', 'revenue.unavailable']) {
      assert.ok(dict[clef] && String(dict[clef]).trim(),
        `${langue}.json n a pas de texte pour ${clef}`)
    }
    assert.notStrictEqual(dict['revenue.computing'], dict['revenue.unavailable'],
      `${langue}.json : les deux motifs disent la meme phrase, donc la distinction est perdue`)
  }
})
