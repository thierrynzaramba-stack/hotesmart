// tests/menages-a-traiter.test.js — la règle « ce qui mérite une alerte ».
// Lot Ménages V5, étape 2. Module PUR : testé pour de vrai, pas par lecture
// de fichier.
//
// ⚠ CE QUI EST EN JEU. Cette fonction décide de ce que l'hôte voit en rouge
// et du chiffre ambre de sa navigation. Deux fautes la rendraient nuisible :
// crier sur ce qui suit son cours normal (il apprend à ne plus regarder), ou
// taire un ménage que personne ne fera (il l'apprend du voyageur).
//
// ⚠ LE TEMPS EST INJECTÉ (`maintenant`), donc les dates sont FIGÉES : règle
// du dépôt — dates relatives si le test lit l'horloge, figées s'il injecte.

const test = require('node:test')
const assert = require('node:assert/strict')

const AUJ = '2026-10-13'
const MAINTENANT = Date.parse('2026-10-13T09:00:00Z')

const BIENS = [
  { id: '101', name: 'La bulle', photo: 'p.jpg' },
  { id: '102', name: 'Cœur de vie 23', photo: null }
]
const REGINA = { id: 'p-regina', prenom: 'Régina', actif: true, a_regler: false }

const menage = (o = {}) => ({
  propertyId: '101', bookingId: 'b1', date: '2026-10-20', status: 'accepted',
  fait: false, porteur: null, proposeesA: [], expireLe: null, raison: null,
  retour: null, differe: false, ...o
})
const appeler = (o = {}) => {
  const { lignesATraiter } = require('../shared/menages-a-traiter.js')
  return lignesATraiter({ biens: BIENS, aujourdhui: AUJ, maintenant: MAINTENANT, ...o })
}

// ─── Ce qui DOIT alerter ────────────────────────────────────────────────────

test('un ménage à venir que personne ne porte entre dans la bulle', async () => {
  const l = appeler({ menages: [menage()] })
  assert.equal(l.length, 1)
  assert.equal(l[0].type, 'non_assigne')
  assert.equal(l[0].bienNom, 'La bulle')
  assert.equal(l[0].photo, 'p.jpg')
})

test('un départ PASSÉ jamais marqué fait entre dans la bulle', async () => {
  const l = appeler({ menages: [menage({ date: '2026-10-10', porteur: REGINA })] })
  assert.equal(l.length, 1)
  assert.equal(l[0].type, 'non_termine')
  assert.equal(l[0].qui.prenom, 'Régina', 'et il dit QUI devait le faire')
})

test('une remarque de propreté confirmée entre dans la bulle, sous le droit avis', async () => {
  const m = menage({ date: '2026-10-10', fait: true, porteur: REGINA,
                     retour: { verdict: 'remarque', extrait: 'Poussière', prive: true } })
  const avec = appeler({ menages: [m], avecAvis: true })
  assert.deepEqual(avec.map(x => x.type), ['mauvais_retour'])
  const sans = appeler({ menages: [m], avecAvis: false })
  assert.deepEqual(sans, [], 'sans le droit `avis`, pas un mot du retour')
})

test('les jours sans AUCUNE prestataire font UNE ligne par bien, avec leur nombre', async () => {
  const garde = [{ propertyId: '101', gere: true, jours: [
    { date: '2026-10-14', trou: true }, { date: '2026-10-15', trou: true },
    { date: '2026-10-16', trou: false }, { date: '2026-10-20', trou: true }
  ] }]
  const l = appeler({ garde })
  assert.equal(l.length, 1, 'une ligne, pas trois')
  assert.equal(l[0].type, 'sans_personnel')
  assert.equal(l[0].nbJours, 3)
  assert.equal(l[0].date, '2026-10-14', 'datée du PREMIER jour sans personne')
})

// ─── Ce qui ne doit PAS alerter ─────────────────────────────────────────────

test('une proposition qui court normalement n\'est PAS une alerte (décision §13)', async () => {
  // Départ dans une semaine, le tour est en cours : le moteur fait son
  // travail, rien ne demande un geste de l'hôte.
  const l = appeler({ menages: [menage({ date: '2026-10-20', proposeesA: [REGINA] })] })
  assert.deepEqual(l, [])
})

test('... mais une proposition sans réponse À MOINS DE 48 h en est une', async () => {
  const l = appeler({ menages: [menage({ date: '2026-10-14', proposeesA: [REGINA] })] })
  assert.deepEqual(l.map(x => x.type), ['non_pris'])
  assert.equal(l[0].qui.prenom, 'Régina')
})

test('un ménage DIFFÉRÉ n\'entre jamais dans la bulle (Q2)', async () => {
  // Le départ est loin : la proposition partira à l'approche. Rien à traiter.
  const l = appeler({ menages: [menage({ date: '2026-12-01', differe: true })] })
  assert.deepEqual(l, [])
})

test('un ménage porté, ou déjà fait, n\'entre pas dans la bulle', async () => {
  const l = appeler({ menages: [
    menage({ porteur: REGINA }),
    menage({ bookingId: 'b2', date: '2026-10-10', fait: true, porteur: REGINA })
  ] })
  assert.deepEqual(l, [])
})

test('un bien NON CONFIÉ ne produit aucun « sans personnel » (3 septembre 2026)', async () => {
  // L'hôte qui fait son ménage lui-même ne doit pas voir de rouge permanent.
  const garde = [{ propertyId: '101', gere: false, jours: [{ date: '2026-10-14', trou: true }] }]
  assert.deepEqual(appeler({ garde }), [])
})

test('les trous PASSÉS ne comptent pas : on n\'alerte pas sur ce qui est derrière', async () => {
  const garde = [{ propertyId: '101', gere: true, jours: [
    { date: '2026-10-11', trou: true }, { date: '2026-10-12', trou: true }
  ] }]
  assert.deepEqual(appeler({ garde }), [])
})

test('un ménage d\'un bien hors de la liste est IGNORÉ, jamais rendu sans nom', async () => {
  // Périmètre délégué : le serveur a filtré les biens, pas forcément tout le
  // reste. Une ligne « (sans nom) · 20 octobre » ne veut rien dire.
  const l = appeler({ menages: [menage({ propertyId: '999' })] })
  assert.deepEqual(l, [])
})

// ─── L'ordre, et le compte ──────────────────────────────────────────────────

test('le tri suit la spec : type d\'abord, date ensuite', async () => {
  const garde = [{ propertyId: '102', gere: true, jours: [{ date: '2026-10-30', trou: true }] }]
  const menages = [
    menage({ bookingId: 'm1', date: '2026-10-11', porteur: REGINA }),              // non terminé
    menage({ bookingId: 'm2', date: '2026-10-25' }),                               // non assigné, tard
    menage({ bookingId: 'm3', date: '2026-10-18' }),                               // non assigné, tôt
    menage({ bookingId: 'm4', date: '2026-10-14', proposeesA: [REGINA] })          // non pris
  ]
  const l = appeler({ garde, menages })
  assert.deepEqual(l.map(x => x.type),
    ['sans_personnel', 'non_assigne', 'non_assigne', 'non_pris', 'non_termine'])
  assert.deepEqual(l.filter(x => x.type === 'non_assigne').map(x => x.date),
    ['2026-10-18', '2026-10-25'], 'et dans chaque type, par date')
})

test('comptesParType rend les cinq compteurs, zéros compris', async () => {
  const { comptesParType, TYPES } = require('../shared/menages-a-traiter.js')
  const c = comptesParType(appeler({ menages: [menage()] }))
  assert.deepEqual(Object.keys(c), TYPES, 'les cinq types, toujours, dans l\'ordre')
  assert.equal(c.non_assigne, 1)
  assert.equal(c.non_termine, 0, 'un type sans ligne vaut zéro, pas undefined')
})

test('rien à traiter : aucune ligne — la bulle saura se taire', async () => {
  assert.deepEqual(appeler({}), [])
})

// ─── Les trois trous trouvés en revue de c197a10 ────────────────────────────

test('un ménage REFUSÉ par tout le monde alerte, même si le départ est loin', async () => {
  // ⚠ LE CAS QUI MANQUAIT. Un refus efface la proposition et pose
  // `assigned_by = 'manual'` : le moteur ne reprendra PAS ce ménage. Le
  // serveur, lui, rend `differe: true` (pas de porteur, pas d'offre, un
  // responsable existe ce jour-là) — un drapeau qui ne regarde pas le
  // statut. Se fier à lui seul rendait le refus invisible jusqu'à J−7,
  // alors que c'est exactement ce qui demande une décision humaine.
  // Décision §13 / Q2 : « plus de preneur possible » OU « moins de 48 h ».
  const l = appeler({ menages: [menage({ date: '2026-11-20', status: 'orphaned', differe: true })] })
  assert.deepEqual(l.map(x => x.type), ['non_assigne'])
})

test('une offre EXPIRÉE alerte : personne ne la porte, et elle est morte', async () => {
  // Vécu « erreur avalée, cron à 200 » : 24 h de panne d'escalade invisible.
  // Tant que `proposee_a` reste renseigné, le départ lointain suffisait à
  // taire l'alerte — l'écran annonçait le calme sur une offre périmée.
  const l = appeler({ menages: [menage({ date: '2026-11-20', proposeesA: [REGINA],
                                         expireLe: '2026-10-10T18:00:00Z' })] })
  assert.deepEqual(l.map(x => x.type), ['non_pris'])
})

test('un bien NON CONFIÉ ne produit AUCUNE alerte de couverture (3 septembre 2026)', async () => {
  // L'hôte qui fait ses ménages lui-même : le moteur n'alerte jamais sur ces
  // biens (`aucuneLiaison`), et la bulle doit dire la même chose. Sinon :
  // une ligne par départ, en permanence, et un badge ambre qui ne redescend
  // jamais — le bruit que ce module existe pour éviter. Il ne pourrait même
  // pas les solder : le writer de « fait » est la PWA de la prestataire.
  const garde = [{ propertyId: '101', gere: false, jours: [] }]
  const menages = [
    menage({ bookingId: 'a', date: '2026-10-20' }),                      // à venir, personne
    menage({ bookingId: 'b', date: '2026-10-10', porteur: null })        // passé, non fait
  ]
  assert.deepEqual(appeler({ garde, menages }), [])
})

test('... mais un MAUVAIS RETOUR d\'un bien non confié reste dit', async () => {
  // Ce n'est pas une alerte de couverture : c'est la parole d'un voyageur
  // sur un séjour. Elle vaut pour l'hôte même s'il a fait le ménage.
  const garde = [{ propertyId: '101', gere: false, jours: [] }]
  const m = menage({ date: '2026-10-10', fait: true,
                     retour: { verdict: 'remarque', extrait: 'Poussière', prive: true } })
  assert.deepEqual(appeler({ garde, menages: [m], avecAvis: true }).map(x => x.type), ['mauvais_retour'])
})

test('un bien SANS ligne de garde du tout reste traité (le serveur peut n\'en rendre aucune)', async () => {
  // Absence d'information ≠ « non confié » : sans ligne `garde`, on ne peut
  // pas conclure que le bien n'est confié à personne. On alerte donc, comme
  // avant — c'est le `gere: false` EXPLICITE qui fait taire, lui seul.
  const l = appeler({ menages: [menage({ date: '2026-10-20' })] })
  assert.deepEqual(l.map(x => x.type), ['non_assigne'])
})

test('chaque ligne de ménage porte son bookingId — sans lui, aucun geste ne sait quoi valider', async () => {
  const l = appeler({ menages: [
    menage({ bookingId: 'x1', date: '2026-10-20' }),                      // non assigné
    menage({ bookingId: 'x2', date: '2026-10-10', porteur: REGINA }),     // non terminé
    menage({ bookingId: 'x3', date: '2026-10-14', proposeesA: [REGINA] }) // non pris
  ] })
  assert.equal(l.length, 3)
  for (const x of l) assert.ok(x.bookingId, `${x.type} sans bookingId`)
  assert.deepEqual(l.map(x => x.bookingId).sort(), ['x1', 'x2', 'x3'])
})

// ─── « Non validé » : elle ne sait peut-être pas qu'elle doit venir ────────
//
// ⚠ LA QUESTION A CHANGÉ LE 14 OCTOBRE 2026, et c'est tout l'objet de ces
// tests. Elle était « a-t-elle ouvert sa page ? » — une réponse par PERSONNE,
// tirée de `public_tokens.pwa_vue_le`, qui ne disait rien d'un ménage en
// particulier : elle ouvre sa page lundi, l'hôte lui en ajoute un mardi, et
// plus rien ne les distinguait. Elle est désormais « a-t-elle validé CE
// ménage ? », et la réponse est sur le ménage (`vuLe`, posé par le bouton
// « Vu » de sa page).
//
// ⚠ DEUX SOURCES, DEUX SITUATIONS, et les confondre serait la faute :
//   - ELLE LE PORTE → `vuLe` tranche, et `vues` n'entre pas dans la règle ;
//   - ON LUI PROPOSE → rien à valider (accepter EST la validation), donc la
//     seule question reste « sait-elle qu'on lui demande quelque chose ? », et
//     c'est la dernière ouverture de sa page qui y répond, comme avant.

const LENA = { id: 'p-lena', prenom: 'Lena', actif: true }
const DEMAIN = '2026-10-14'
const AVANT = '2026-10-10T08:00:00Z'   // sa dernière ouverture
const APRES = '2026-10-12T08:00:00Z'   // ce qui la concerne, posé après

test('un ménage à elle qu\'elle n\'a pas validé, à J−1 : alerte', async () => {
  const l = appeler({
    menages: [menage({ date: DEMAIN, porteur: REGINA, vuLe: null })],
    vues: { 'p-regina': AVANT }, vuesLues: true
  })
  assert.deepEqual(l.map(x => x.type), ['pas_vu'])
  assert.equal(l[0].qui.prenom, 'Régina', 'et il dit QUI appeler')
  assert.equal(l[0].vueLe, AVANT, 'la date d\'ouverture reste AFFICHÉE, sans entrer dans la règle')
  assert.equal(l[0].nbMenages, 1)
})

test('... elle tape « Vu », l\'alerte disparaît', async () => {
  // ⚠ ET MÊME SI SA PAGE N'A JAMAIS ÉTÉ OUVERTE AILLEURS. L'ancienne règle
  // concluait sur l'ouverture du LIEN ; une validation posée sur ce ménage-là
  // est une réponse plus forte, et elle gagne.
  const l = appeler({
    menages: [menage({ date: DEMAIN, porteur: REGINA, vuLe: '2026-10-13T07:30:00Z' })],
    vues: { 'p-regina': null }, vuesLues: true
  })
  assert.deepEqual(l, [], 'validé : il n\'y a plus rien à signaler')
})

test('... et un départ à J+5 n\'alerte pas : le temps de regarder reste entier', async () => {
  const l = appeler({
    menages: [menage({ date: '2026-10-18', porteur: REGINA, vuLe: null })],
    vues: { 'p-regina': AVANT }, vuesLues: true
  })
  assert.deepEqual(l, [])
})

test('un départ PASSÉ non validé ne dit que « non terminé » — on ne valide pas le passé', async () => {
  // ⚠ LE GARDE-FOU DU 14 OCTOBRE. Avec `vuLe`, un départ de la semaine
  // dernière jamais validé alerterait POUR TOUJOURS : `non_termine` le dit
  // déjà, et mieux. Même borne que le bouton de sa page (`estAValider`).
  const l = appeler({
    menages: [menage({ date: '2026-10-10', porteur: REGINA, vuLe: null })],
    vues: { 'p-regina': AVANT }, vuesLues: true
  })
  assert.deepEqual(l.map(x => x.type), ['non_termine'])
})

test('UNE PANNE DE LECTURE DES OUVERTURES N\'ÉTEINT PLUS l\'alerte d\'une porteuse', async () => {
  // ⚠ CE QUE LE CHANGEMENT GAGNE. L'alerte dépendait d'une lecture de
  // `public_tokens` : un timeout PostgREST la faisait taire entièrement, et
  // l'hôte lisait le calme. La réponse est maintenant sur le ménage.
  const m = [menage({ date: DEMAIN, porteur: REGINA, vuLe: null })]
  assert.deepEqual(appeler({ menages: m, vues: {}, vuesLues: false }).map(x => x.type), ['pas_vu'])
  assert.deepEqual(appeler({ menages: m }).map(x => x.type), ['pas_vu'],
    'et sans l\'information du tout, l\'alerte tient aussi')
  // ⚠ MAIS ELLE NE DIT PLUS « page jamais ouverte » : on n'a rien lu.
  assert.equal(appeler({ menages: m })[0].vueLe, undefined)
})

test('un serveur qui ne sert pas `vuLe` se TAIT (il n\'accuse pas toute l\'équipe)', async () => {
  // ⚠ `undefined` ≠ `null`. Une version antérieure de /api/garde ne connaît
  // pas la colonne : peindre « pas vu » partout accuserait tout le monde
  // sur une absence de donnée. On se tait, et le vérificateur de migration est
  // là pour que ce silence ne dure pas.
  const l = appeler({
    menages: [menage({ date: DEMAIN, porteur: REGINA })],
    vues: { 'p-regina': AVANT }, vuesLues: true
  })
  assert.deepEqual(l, [])
})

test('un ménage DÉJÀ FAIT ne produit pas « pas vu » : elle y est allée', async () => {
  const l = appeler({
    menages: [menage({ date: '2026-10-13', porteur: REGINA, fait: true, vuLe: null })],
    vues: { 'p-regina': AVANT }, vuesLues: true
  })
  assert.deepEqual(l, [])
})

test('« pas vu » vaut AUSSI sur un bien non confié : ce n\'est pas une alerte de couverture', async () => {
  // L'hôte a mis quelqu'un à la main sur un bien qu'il gère lui-même : si
  // cette personne ne l'a pas lu, le logement sera découvert quand même.
  const garde = [{ propertyId: '101', gere: false, jours: [] }]
  const l = appeler({
    garde, menages: [menage({ date: DEMAIN, porteur: REGINA, vuLe: null })],
    vues: { 'p-regina': AVANT }, vuesLues: true
  })
  assert.deepEqual(l.map(x => x.type), ['pas_vu'])
})

test('UNE LIGNE PAR PERSONNE, avec son ménage le PLUS PROCHE', async () => {
  // Trois départs qu'elle n'a pas validés sont un seul coup de téléphone.
  const l = appeler({
    menages: [
      menage({ bookingId: 'b1', date: '2026-10-15', porteur: REGINA, vuLe: null }),
      menage({ bookingId: 'b2', date: DEMAIN, porteur: REGINA, vuLe: null }),
      menage({ bookingId: 'b3', date: '2026-10-13', porteur: REGINA, vuLe: null })
    ],
    vues: { 'p-regina': AVANT }, vuesLues: true
  })
  const pv = l.filter(x => x.type === 'pas_vu')
  assert.equal(pv.length, 1, 'une seule ligne pour Régina')
  assert.equal(pv[0].date, '2026-10-13', 'celle du départ le plus proche')
  assert.equal(pv[0].nbMenages, 3, 'et elle dit combien il y en a')
})

// ─── La PROPOSITION, elle, garde l'ancienne règle ──────────────────────────

test('une PROPOSITION non vue alerte aussi, et nomme la personne sollicitée', async () => {
  const l = appeler({
    menages: [menage({ date: DEMAIN, proposeesA: [LENA], etapes: { propose: APRES }, vuLe: null })],
    vues: { 'p-lena': AVANT }, vuesLues: true
  })
  // `non_pris` sort aussi : le départ est imminent et personne ne le porte.
  // Les deux disent une chose différente, et toutes deux sont vraies.
  assert.deepEqual(l.map(x => x.type), ['non_pris', 'pas_vu'])
  assert.equal(l.find(x => x.type === 'pas_vu').qui.prenom, 'Lena')
})

test('... et une NOTE changée après son ouverture alerte : « le code a changé »', async () => {
  // La proposition est ancienne, mais la consigne vient de bouger — c'est
  // exactement ce qu'elle doit lire avant de répondre.
  const l = appeler({
    menages: [menage({ date: DEMAIN, proposeesA: [LENA],
                       etapes: { propose: '2026-10-01T08:00:00Z' }, noteLe: APRES, vuLe: null })],
    vues: { 'p-lena': AVANT }, vuesLues: true
  })
  assert.deepEqual(l.map(x => x.type), ['non_pris', 'pas_vu'])
})

test('JAMAIS ouverte, sur une proposition : alerte sans condition de date', async () => {
  // Rien à comparer, et c'est précisément le problème : on lui demande
  // quelque chose pour demain et elle n'a jamais ouvert son lien.
  const l = appeler({
    menages: [menage({ date: DEMAIN, proposeesA: [LENA], vuLe: null })],
    vues: { 'p-lena': null }, vuesLues: true
  })
  assert.deepEqual(l.map(x => x.type), ['non_pris', 'pas_vu'])
  assert.equal(l.find(x => x.type === 'pas_vu').vueLe, null)
})

test('une PANNE de lecture se TAIT sur une PROPOSITION (elle n\'accuse pas au hasard)', async () => {
  // Sans ce garde-fou, un timeout PostgREST rendait une carte vide — donc
  // « aucune ne l'a jamais ouverte », donc une pleine page de rouge.
  const m = [menage({ date: DEMAIN, proposeesA: [LENA], etapes: { propose: APRES }, vuLe: null })]
  assert.deepEqual(appeler({ menages: m, vues: {}, vuesLues: false }).map(x => x.type), ['non_pris'])
  assert.deepEqual(appeler({ menages: m }).map(x => x.type), ['non_pris'])
})

test('une personne ABSENTE de la carte ne produit rien : son lien n\'existe plus', async () => {
  // Retirée de l'équipe, la ligne `public_tokens` est supprimée. Annoncer
  // « page jamais ouverte » sur un lien qui n'existe plus serait faux.
  const l = appeler({
    menages: [menage({ date: DEMAIN, proposeesA: [LENA], etapes: { propose: APRES }, vuLe: null })],
    vues: { 'p-regina': AVANT }, vuesLues: true
  })
  assert.deepEqual(l.map(x => x.type), ['non_pris'])
})

test('un jalon INCONNU ne devine pas : pas d\'alerte sur une date qu\'on ignore', async () => {
  // Une proposition peut n'avoir aucune date. Alerter « elle ne l'a pas vue »
  // accuserait au hasard.
  const l = appeler({
    menages: [menage({ date: DEMAIN, proposeesA: [LENA], etapes: {}, vuLe: null })],
    vues: { 'p-lena': AVANT }, vuesLues: true
  })
  assert.deepEqual(l.map(x => x.type), ['non_pris'])
})

test('le tri place « pas vu » après les alertes de couverture et avant le passé', async () => {
  const { TYPES } = require('../shared/menages-a-traiter.js')
  assert.deepEqual(TYPES,
    ['sans_personnel', 'non_assigne', 'non_pris', 'pas_vu', 'non_termine', 'mauvais_retour'])
})

test('la borne de l\'imminence est EXPORTÉE : la bulle et la fiche ne la recalculent pas', async () => {
  // ⚠ UN BANDEAU VERT AU-DESSUS D'UNE LIGNE ROUGE sur la même personne est ce
  // qu'un hôte ne pardonne pas. L'en-tête de la fiche prestataire lit la même
  // fenêtre que la bulle depuis le 14 octobre 2026 — recopier `+2 jours` dans
  // la page garantissait qu'un jour l'un des deux change seul.
  const { limiteDeLImminence, JOURS_IMMINENT } = require('../shared/menages-a-traiter.js')
  assert.equal(JOURS_IMMINENT, 2)
  assert.equal(limiteDeLImminence('2026-10-13'), '2026-10-15')
  // Et elle franchit un changement de mois sans se tromper.
  assert.equal(limiteDeLImminence('2026-10-30'), '2026-11-01')
})
