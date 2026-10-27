// tests/revenus-derive.test.js — LES COLONNES DERIVEES D'UNE RESERVATION
//
// Architecture decidee par Thierry le 27 octobre 2026 : le payload provider
// n'est lu qu'UNE FOIS, a l'ecriture de la reservation, et l'ecran lit un
// agregat SQL. Ce fichier garde la fonction qui fait cette lecture unique.
//
// ⚠ CE QU'ELLE A DE PARTICULIER : elle ecrit en base ce que l'ecran affichera
// des mois plus tard. Une erreur ici ne se voit pas au prochain rendu — elle se
// fige dans 1 436 lignes, et il faut un rattrapage pour la defaire. C'est la
// raison du numero de VERSION, et la raison pour laquelle cette fonction est
// PURE : elle doit pouvoir etre eprouvee entierement hors base.

const test = require('node:test')
const assert = require('node:assert/strict')
const { deriverRevenus, aDeriver, COLONNES, VERSION } = require('../lib/revenus/derive')
const { tableDesDelais } = require('../lib/revenus/versement')

const DELAIS = tableDesDelais([
  { canal: 'airbnb', base: 'arrivee', jours: 1 },
  { canal: 'booking', base: 'depart', jours: 1 },
  { canal: 'direct', base: 'reservation', jours: 3 }
])

// ⚠ DATES ET INSTANT FIGES : cette fonction N'APPELLE PAS l'horloge, elle
// recoit `maintenant`. Regle du depot — « dates relatives si le test lit
// l'horloge, dates figees s'il injecte le temps ».
const T = '2026-10-27T04:00:00.000Z'

const airbnb = (amount, fee, extra = {}, rawExtra = {}) => deriverRevenus(
  { provider: 'channex', source: 'airbnb', status: 'new', arrival: '2026-11-05', departure: '2026-11-08', ...extra },
  { amount, meta: { amount_type: 'Payout Amount' }, notes: `Listing Cancellation Host Fee: ${fee}\n`, inserted_at: '2026-09-01T10:00:00Z', ...rawExtra },
  { delais: DELAIS, uuidDuBien: 'uuid-1', maintenant: T })

const booking = (centimes, extra = {}) => deriverRevenus(
  { provider: 'channex', source: 'bookingcom', status: 'new', arrival: '2026-11-10', departure: '2026-11-12', ...extra },
  { rooms: [{ meta: { price_details: { guest_view: { total: { amount: centimes, decimal_places: 2 } } } } }], inserted_at: '2026-09-01T10:00:00Z' },
  { delais: DELAIS, uuidDuBien: 'uuid-2', maintenant: T })

test('LE TEST QUI COMPTE : les colonnes posees sont EXACTEMENT celles de la liste', () => {
  // ⚠ LA LISTE EST LA SOURCE UNIQUE. Le writer, le script de remplissage, le
  // rattrapage et la migration la nomment tous : une colonne ajoutee a la
  // fonction sans l'etre a la liste serait posee par le writer et ignoree par
  // le rattrapage — donc juste sur les reservations neuves et fausse sur les
  // anciennes, ce qui est le pire des deux mondes.
  const d = airbnb('400.00', '12.00')
  assert.deepEqual(Object.keys(d).sort(), [...COLONNES].sort())
  // ⚠ LE COMPTE NE S'ECRIT PLUS DANS LE TITRE, ET C'EST VOLONTAIRE. Ce test
  // s'appelait « les ONZE colonnes », et il a fallu le renommer deux jours de
  // suite — `est_blocage` le 27 octobre, `derive_raw_hash` le meme jour. Un
  // nombre dans un nom de test est un nombre a maintenir, pour une information
  // que `COLONNES.length` porte deja.
  //
  // Ce qui compte n'est pas le compte : c'est que la fonction pose EXACTEMENT
  // les colonnes de la liste, ni plus ni moins — l'assertion `deepEqual`
  // ci-dessus. On garde quand meme un plancher, pour qu'une liste videe par
  // accident ne rende pas ce test vert.
  assert.ok(COLONNES.length >= 12, `COLONNES n'a que ${COLONNES.length} entree(s)`)
  // Et chacune est posee — pas une seule `undefined`, qui laisserait la colonne
  // intacte cote Postgres au lieu de l'ecrire.
  for (const c of COLONNES) {
    assert.ok(c in d, `${c} manque`)
    assert.notEqual(d[c], undefined, `${c} vaut undefined : l upsert ne l ecrirait pas`)
  }
})

test('LE TEST QUI COMPTE : un sejour Airbnb rend le NET, au centime', () => {
  const d = airbnb('400.00', '12.00')
  assert.equal(d.canal, 'airbnb')
  assert.equal(d.statut_canonique, 'confirmed')
  assert.equal(d.montant_net_cents, 40000, 'le net doit etre `amount`, au centime')
  assert.equal(d.montant_est_brut, false)
  assert.equal(d.commission_cents, 1200)
  assert.equal(d.date_versement, '2026-11-06', 'Airbnb verse arrivee + 1 jour')
  assert.equal(d.motif_non_calculable, null)
  assert.equal(d.derive_le, T)
  assert.equal(d.derive_version, VERSION)
})

test('LE TEST QUI COMPTE : Booking.com rend un BRUT, marque comme tel', () => {
  const d = booking(50000)
  assert.equal(d.canal, 'booking')
  assert.equal(d.montant_net_cents, 50000)
  assert.equal(d.montant_est_brut, true, 'un brut annonce comme un net ferait croire a un revenu qui n existe pas')
  assert.equal(d.commission_cents, null)
  assert.equal(d.date_versement, '2026-11-13', 'Booking verse depart + 1 jour')
  assert.equal(d.motif_non_calculable, 'commission_inconnue')
})

test("LE TEST QUI COMPTE : `montant_est_brut` vaut `null` quand le MONTANT manque", () => {
  // ⚠ « ON NE SAIT PAS SI C'EST UN BRUT » N'EST PAS « CE N'EST PAS UN BRUT ».
  // Un `false` ferait compter la ligne comme un net parfaitement connu, et
  // l'agregat SQL la verrait dans `sans_montant` ET hors de `bruts` — deux
  // compteurs qui se contredisent sur la meme ligne.
  const casse = airbnb('400.00', '1.2.3')   // Host Fee illisible
  assert.equal(casse.montant_net_cents, null)
  assert.equal(casse.montant_est_brut, null, 'un montant inconnu est annonce « pas un brut »')
  assert.ok(casse.motif_non_calculable, 'un null sans motif est un trou que personne ne saura expliquer')
})

test("LE TEST QUI COMPTE : une reservation IMPORTEE ne prend pas la date de MIGRATION", () => {
  // Le canal direct se verse « reservation + 3 jours », et une reservation
  // importee porte dans `raw.inserted_at` la date de MIGRATION, pas sa date de
  // vente — mesure du depot, 11 jours de delai apparent contre 2 pour les
  // natives. La ranger au mois de la migration mettrait le revenu d'un sejour
  // vendu l'an dernier dans le mois ou nous avons bascule le bien.
  const commun = { provider: 'channex', source: 'offline', status: 'new', arrival: '2026-11-20', departure: '2026-11-23' }
  const importee = deriverRevenus(commun,
    { amount: '300.00', inserted_at: '2026-11-01T10:00:00Z', meta: { is_imported: true } },
    { delais: DELAIS, uuidDuBien: 'uuid-1', maintenant: T })
  assert.equal(importee.date_versement, null, 'la date de migration a servi de date de vente')
  assert.equal(importee.motif_non_calculable, 'date_de_vente_non_fiable',
    'le motif doit nommer la cause : « date manquante » enverrait chercher chez le provider')
  // ⚠ ET LE MONTANT RESTE CALCULE : une date douteuse n'empeche pas de savoir
  // combien. L'ecran comptera ce sejour « sans date de versement », avec son
  // montant connu — pas comme une reservation dont on ne sait rien.
  assert.equal(importee.montant_net_cents, 30000)

  const native = deriverRevenus(commun,
    { amount: '300.00', inserted_at: '2026-11-01T10:00:00Z' },
    { delais: DELAIS, uuidDuBien: 'uuid-1', maintenant: T })
  assert.equal(native.date_versement, '2026-11-04', 'reservation du 01/11 + 3 jours')
})

test("LE TEST QUI COMPTE : les ANNULEES sont derivees, pas comptees", () => {
  // ⚠ DECISION DU 27 OCTOBRE 2026, ET ELLE A DEUX MOITIES.
  // On DERIVE : l'information existe alors en base, gratuitement, pour le jour
  // ou l'on saura compter les annulations payees (Airbnb verse une partie en
  // cas d'annulation tardive).
  // On ne COMPTE PAS : l'agregat SQL filtre `statut_canonique = 'confirmed'`,
  // parce que rien dans le payload ne distingue « ce que l'hote a garde » de
  // « le prix initial du sejour qui n'a pas eu lieu ».
  // `Listing Cancellation Host Fee` ne le dit pas — c'est la COMMISSION
  // Airbnb, lisible sur 33/33 lignes, confirmees comprises
  // (docs/kb/prix-voyageur.md). Compter sur `amount` porterait au total le
  // prix ENTIER d'un sejour annule : un revenu invente.
  const a = airbnb('310.00', '9.00', { status: 'cancelled' })
  assert.equal(a.statut_canonique, 'cancelled', 'le statut doit etre pose, c est lui qui exclut')
  assert.equal(a.montant_net_cents, 31000, 'le montant est derive quand meme')
  assert.ok(a.date_versement, 'la date est derivee quand meme')

  // Et `demapped` aussi : c'est un doublon de migration, jamais un revenu.
  const d = airbnb('888.00', '20.00', { status: 'demapped' })
  assert.equal(d.statut_canonique, 'demapped')
})

test("LE TEST QUI COMPTE : `property_uuid` a `null` est une INFORMATION, pas un echec silencieux", () => {
  // La resolution de la cle provider vers l'UUID du bien peut echouer : cle
  // laissee par un re-keying, bien supprime, `property_id` nul. La colonne
  // porte alors `null` — et c'est ce `null` qui permet a l'agregat de COMPTER
  // cet argent a part (`revenus_hors_mois.hors_biens`). Avant cette colonne,
  // l'ecart etait muet : 1 000 EUR mesures entre le bandeau et les lignes.
  const sans = deriverRevenus(
    { provider: 'channex', source: 'airbnb', status: 'new', arrival: '2026-11-05', departure: '2026-11-08' },
    { amount: '400.00', meta: { amount_type: 'Payout Amount' }, notes: 'Listing Cancellation Host Fee: 12.00\n' },
    { delais: DELAIS, uuidDuBien: null, maintenant: T })
  assert.equal(sans.property_uuid, null)
  // Le reste est derive normalement : un bien non resolu n'empeche pas de
  // connaitre le montant ni la date.
  assert.equal(sans.montant_net_cents, 40000)
  assert.equal(sans.date_versement, '2026-11-06')
})

test('LE TEST QUI COMPTE : le canal est NORMALISE, par la seule table du depot', () => {
  // Le stocker brut obligerait l'agregat SQL a normaliser — donc a reecrire une
  // regle JS en SQL, et a la laisser deriver au premier canal ajoute.
  const cas = [
    ['airbnb', 'airbnb'], ['AirBNB', 'airbnb'], ['abb', 'airbnb'],
    ['bookingcom', 'booking'], ['booking.com', 'booking'], ['bdc', 'booking'],
    ['offline', 'direct'], ['Offline', 'direct'], ['direct', 'direct'],
    ['expedia', null], ['', null]
  ]
  for (const [brut, attendu] of cas) {
    const d = deriverRevenus(
      { provider: 'channex', source: brut, status: 'new', arrival: '2026-11-05', departure: '2026-11-08' },
      { amount: '100.00' }, { delais: DELAIS, uuidDuBien: 'uuid-1', maintenant: T })
    assert.equal(d.canal, attendu, `« ${brut} » devient ${String(d.canal)} au lieu de ${String(attendu)}`)
  }
})

test("LE TEST QUI COMPTE : `aDeriver` reconnaît les TROIS cas, dont la version perimee", () => {
  // ⚠ LE TROISIEME EST CELUI QU'ON OUBLIE. Sans lui, un correctif de regle ne
  // rattrape que les reservations ecrites APRES lui, et les anciennes gardent
  // un chiffre faux pour toujours.
  assert.equal(aDeriver({}), true, 'jamais derivee')
  assert.equal(aDeriver({ derive_le: null }), true, 'jamais derivee')
  assert.equal(aDeriver({ derive_le: T, derive_version: VERSION }), false, 'a jour')
  assert.equal(aDeriver({ derive_le: T, derive_version: VERSION - 1 }), true, 'version perimee')
  assert.equal(aDeriver({ derive_le: T }), true, 'version absente')
  assert.equal(aDeriver({ derive_le: T, derive_version: 'x' }), true, 'version illisible')
  // ⚠ ET UNE VERSION PLUS RECENTE NE SE RECALCULE PAS : un deploiement en cours
  // peut faire tourner l'ancien code a cote du neuf. Redescendre une ligne a
  // une version anterieure la ferait osciller a chaque passage du cron.
  assert.equal(aDeriver({ derive_le: T, derive_version: VERSION + 1 }), false,
    'une ligne derivee par une version PLUS RECENTE est recalculee : les deux versions se la disputeraient')
  // `null` n'est pas une ligne.
  assert.equal(aDeriver(null), false)
  assert.equal(aDeriver(undefined), false)
})

test('aucun appel ne leve, quelle que soit la forme du payload', () => {
  // Une fonction du writer qui leve fait echouer l'upsert de la reservation —
  // donc perdre une reservation, pas une colonne.
  for (const [s, r, o] of [
    [null, null, {}], [undefined, undefined, undefined], [{}, {}, {}],
    [{ provider: 'channex', source: 'airbnb' }, { amount: null, notes: null }, { delais: DELAIS }],
    [{ provider: 'beds24', source: 'direct' }, { price: 'x', commission: 'y' }, { delais: {} }],
    [{ status: 42 }, { amount: [] }, { delais: null, uuidDuBien: 0 }]
  ]) {
    const d = deriverRevenus(s, r, o)
    assert.ok(d && typeof d === 'object')
    assert.deepEqual(Object.keys(d).sort(), [...COLONNES].sort())
    assert.equal(d.derive_version, VERSION)
  }
})

test('deux appels sur la meme entree rendent la MEME chose', () => {
  // ⚠ UNE FONCTION QUI DERIVE L'ARGENT DOIT ETRE DETERMINISTE, sinon le
  // rattrapage nocturne change les chiffres sans qu'aucune donnee ait bouge —
  // et l'hote voit son mois varier d'un jour a l'autre.
  const a = airbnb('333.33', '10.01')
  const b = airbnb('333.33', '10.01')
  assert.deepEqual(a, b)
})

// ═══════════════════════════════════════════════════════════════════════════
// `est_blocage` — un blocage n'est pas un sejour (decision de Thierry du
// 27 octobre 2026, apres mesure en production)
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : les TROIS conditions sont cumulees', () => {
  // ⚠ MESURE EN PRODUCTION, 1 564 lignes : 74 sejours confirmes sans prix
  // voyageur, dont 66 portant « aucun nom » ET « price a zero ». Beds24 envoie
  // ses blocages comme des reservations confirmees a prix nul.
  //
  // Thierry en avait decide DEUX. La mesure a exige la troisieme : un blocage
  // n'a PAS de revenu. Voir le test suivant.
  const { estUnBlocage } = require('../lib/revenus/derive')
  // Les trois reunies : c'est un blocage.
  assert.equal(estUnBlocage({}, { price: 0 }, false), true)
  assert.equal(estUnBlocage({}, { price: '0' }, false), true)
  assert.equal(estUnBlocage({ guest_name: '   ' }, { price: '0.00' }, false), true)
  // Chacune qui manque suffit a en faire un sejour.
  assert.equal(estUnBlocage({ guest_name: 'C. B.' }, { price: 0 }, false), false,
    'un sejour OFFERT a un nom : ce n est pas un blocage')
  assert.equal(estUnBlocage({}, { price: 250 }, false), false,
    'un prix non nul n est pas un blocage, meme sans nom transmis')
  assert.equal(estUnBlocage({}, { price: 0 }, true), false,
    'un montant calculable interdit de classer blocage')
})

test("LE TEST QUI COMPTE : un montant CALCULABLE interdit le classement blocage", () => {
  // ⚠ CINQ LIGNES REELLES, trouvees en eprouvant l heuristique contre la
  // production : classees blocage par les deux premiers indices, ET portant un
  // montant. Leur revenu aurait disparu du total, sans motif et sans compteur.
  //
  // La cause est un repli de `eclatement.js` : pour une saisie DIRECTE sans
  // commission, il somme les `invoiceItems` quand `price` est nul. Une saisie
  // directe a `price = 0`, sans nom, mais avec des charges facturees, porte
  // donc un vrai prix.
  const { estUnBlocage } = require('../lib/revenus/derive')
  assert.equal(estUnBlocage({}, { price: 0 }, true), false)
  // Et le chemin complet : une saisie directe Beds24 avec charges.
  const d = deriverRevenus(
    { provider: 'beds24', source: 'direct', status: 'confirmed', arrival: '2026-11-05', departure: '2026-11-08' },
    { price: 0, commission: 0, invoiceItems: [{ type: 'charge', lineTotal: 320 }] },
    { delais: DELAIS, uuidDuBien: 'uuid-1', maintenant: T })
  assert.equal(d.montant_net_cents, 32000, 'le repli sur les charges doit donner un montant')
  assert.equal(d.est_blocage, false,
    'une ligne qui a rapporte 320 EUR est classee blocage : son revenu disparait du total')
})

test("LE TEST QUI COMPTE : `price` VIDE n'est pas `price` ZERO", () => {
  // ⚠ `Number('')` VAUT 0, et ce serait le defaut le plus couteux de cette
  // fonction : une chaine vide — « aucun prix transmis » — deviendrait « prix
  // zero », donc un blocage, donc une ligne exclue du total. Un revenu reel qui
  // disparait parce qu'un champ etait vide.
  //
  // « Prix zero » est un FAIT que le provider affirme ; « prix absent » est une
  // absence. Meme regle que `delaiEnJours` dans le module frere.
  const { estUnBlocage } = require('../lib/revenus/derive')
  for (const prix of ['', '   ', null, undefined, true, false, [], {}, NaN]) {
    assert.equal(estUnBlocage({}, { price: prix }, false), false,
      `price=${JSON.stringify(prix)} est pris pour un zero affirme`)
  }
  assert.equal(estUnBlocage({}, {}, false), false, 'price absent n est pas un zero')
  // Et un zero AFFIRME, lui, compte.
  for (const prix of [0, '0', '0.00', '0.0']) {
    assert.equal(estUnBlocage({}, { price: prix }, false), true,
      `price=${JSON.stringify(prix)} est un zero affirme`)
  }
})

test("LE TEST QUI COMPTE : `est_blocage` ne touche PAS `statut_canonique`", () => {
  // Decision explicite de Thierry. Requalifier une ligne `confirmed` en
  // `blocked` sur une heuristique changerait un comportement qui n'a rien a
  // voir avec les revenus : ce statut gouverne aussi le menage.
  const d = deriverRevenus(
    { provider: 'beds24', source: 'direct', status: 'confirmed', arrival: '2026-11-05', departure: '2026-11-08' },
    { price: 0 },
    { delais: DELAIS, uuidDuBien: 'uuid-1', maintenant: T })
  assert.equal(d.est_blocage, true)
  assert.equal(d.statut_canonique, 'confirmed',
    'le statut a ete requalifie : le menage de ce sejour changerait de comportement')
})

test("LE TEST QUI COMPTE : la VERSION a monte, donc le rattrapage reprend tout", () => {
  // ⚠ PREMIER USAGE REEL DU NUMERO DE VERSION. Toute ligne derivee en version 1
  // ne porte pas `est_blocage` — elle vaut donc `null`, et les agregats la
  // comptent comme un sejour. Sans ce numero, la nouvelle regle ne vaudrait que
  // pour les reservations ecrites apres elle, et les 1 436 anciennes garderaient
  // leur classement d'avant.
  const { aDeriver, VERSION, COLONNES } = require('../lib/revenus/derive')
  assert.ok(VERSION >= 2, 'la version n a pas monte avec la nouvelle regle')
  // ⚠ LE COMPTE SUIT LA LISTE, il ne la decrit pas. Douze depuis que
  // `derive_raw_hash` s'est ajoutee (dette 112, 27 octobre 2026).
  assert.equal(COLONNES.length, 12, 'une colonne derivee a disparu de la liste')
  assert.ok(COLONNES.includes('est_blocage'))
  assert.ok(COLONNES.includes('derive_raw_hash'))
  // Une ligne de la version precedente est reprise.
  assert.equal(aDeriver({ derive_le: T, derive_version: VERSION - 1 }), true)
  // ⚠ ET UNE LIGNE A JOUR NE L'EST PAS — a condition que son empreinte
  // corresponde. Sans `raw_hash`, la question de la peremption ne se pose pas.
  assert.equal(aDeriver({ derive_le: T, derive_version: VERSION }), false)
  assert.equal(aDeriver({ derive_le: T, derive_version: VERSION, raw_hash: 'a', derive_raw_hash: 'a' }), false)
})

test('LE TEST QUI COMPTE : une ligne dont le PAYLOAD a change est reprise', () => {
  // ⚠ DETTE 112. `aDeriver` avait trois cas — jamais derivee, version perimee,
  // version illisible — et il en manquait un quatrieme : le payload a change
  // DEPUIS le calcul. Une telle ligne garde `derive_le` non nul et sa version a
  // jour, donc elle echappait aux deux requetes du rattrapage, et rien ne la
  // reprenait jamais.
  //
  // Mesure d'origine sur staging : j'ai corrige deux fois le `raw` d'une ligne,
  // et `montant_net_cents` comme `derive_le` sont restes identiques au centime
  // et a la milliseconde.
  const { aDeriver, VERSION } = require('../lib/revenus/derive')
  const base = { derive_le: T, derive_version: VERSION }

  // Les deux empreintes concordent : rien a faire.
  assert.equal(aDeriver({ ...base, raw_hash: 'aaa', derive_raw_hash: 'aaa' }), false)
  // Le payload a change depuis le calcul : a reprendre.
  assert.equal(aDeriver({ ...base, raw_hash: 'bbb', derive_raw_hash: 'aaa' }), true,
    'une ligne dont le payload a change n est pas reprise : son montant restera fige')
  // ⚠ ET UNE EMPREINTE DE REFERENCE ABSENTE EST AUSSI UNE RAISON DE REPRENDRE :
  // c'est l'etat de toute ligne derivee AVANT la migration du 27 octobre 2026.
  // Sans ce cas, la peremption de ces lignes-la resterait indetectable a vie, et
  // la dette ne serait fermee que pour l'avenir. Le cout est borne et unique —
  // le rattrapage plafonne a 2 000 lignes par nuit, la production en porte 1 436.
  assert.equal(aDeriver({ ...base, raw_hash: 'aaa', derive_raw_hash: null }), true,
    'une ligne sans empreinte de reference n est pas reprise : sa peremption restera invisible')
  // ⚠ MAIS SANS `raw_hash`, LA QUESTION NE SE POSE PAS : il n'y a pas de
  // payload a comparer, donc rien a reprendre de ce chef.
  assert.equal(aDeriver({ ...base, raw_hash: null, derive_raw_hash: null }), false)
  assert.equal(aDeriver({ ...base }), false, 'une ligne sans empreinte du tout est reprise a tort')
})

// ─── L'INVARIANT, PLUTOT QU'UN TEST PAR APPELANT ────────────────────────────

test('RECENSEMENT : tout appel a deriverRevenus passe l empreinte du payload', () => {
  // ⚠ CE TEST EXISTE PARCE QUE DEUX APPELANTS SUR QUATRE L'OUBLIAIENT, et que
  // l'oubli ne casse rien de visible : `deriverRevenus` fait
  // `derive_raw_hash: options.empreinteDuRaw ?? null`, donc il ecrit `null`
  // dans la colonne qui sert a detecter la peremption. La ligne reste candidate
  // apres avoir ete derivee, le rattrapage la reprend chaque nuit, a vie, et il
  // ECRASE l'empreinte que le writer avait posee.
  //
  // Le writer, lui, avait son test. Le rattrapage et le script de remplissage
  // n'en avaient aucun — et le script de remplissage n'est couvert par AUCUN
  // test du depot, c'est un programme en ligne de commande. Un test par
  // appelant aurait laisse le prochain a decouvert : on garde l'INVARIANT.
  const path = require('node:path')
  const fs = require('node:fs')
  const racine = path.join(__dirname, '..')
  const { fichiersJs } = require('./outils/source')
  const fichiers = []
  for (const dossier of ['api', 'lib', 'scripts']) {
    const abs = path.join(racine, dossier)
    if (fs.existsSync(abs)) fichiers.push(...fichiersJs(abs, dossier))
  }

  const sansEmpreinte = []
  for (const f of fichiers) {
    const src = fs.readFileSync(path.join(racine, f), 'utf8')
    let i = src.indexOf('deriverRevenus(')
    while (i !== -1) {
      // On decoupe sur les parentheses APPARIEES : s'arreter au premier `)`
      // couperait l'appel au milieu de son objet d'options, et le test
      // declarerait un manque la ou l'option est presente.
      let p = 0
      let j = src.indexOf('(', i)
      const debut = j
      for (; j < src.length; j++) {
        if (src[j] === '(') p++
        else if (src[j] === ')') { p--; if (p === 0) break }
      }
      const appel = src.slice(debut, j + 1)
      // Une ligne d'import ou de re-export n'est pas un appel.
      if (appel.length > 2 && !appel.startsWith('()') && !appel.includes('empreinteDuRaw')) {
        sansEmpreinte.push(`${f} (position ${i})`)
      }
      i = src.indexOf('deriverRevenus(', i + 1)
    }
  }
  assert.deepStrictEqual(sansEmpreinte, [],
    'ces appels a deriverRevenus n ont pas d empreinteDuRaw : ils ecriront null\n'
    + 'dans derive_raw_hash, donc leurs lignes seront reprises a chaque passage\n'
    + 'du rattrapage, a vie, et l empreinte du writer sera ecrasee.\n'
    + sansEmpreinte.join('\n'))
})
