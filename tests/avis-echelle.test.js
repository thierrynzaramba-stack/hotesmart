// tests/avis-echelle.test.js — L'ECHELLE DES NOTES, ramenee sur 5.
//
// Decision de Thierry du 20 octobre 2026 : « tout sur 5. Les notes Booking
// (/10) sont divisees par 2 avant la moyenne, ponderee par le nombre d'avis de
// chaque canal. Un arrondi a une decimale, jamais d'arrondi intermediaire. »
//
// Les trois qui comptent :
//   1. le test que Thierry a pose lui-meme : 10 Airbnb a 5 + 10 Booking a 8 => 4,5 ;
//   2. aucun arrondi intermediaire — 9,65/10 fait 4,8, pas 4,9 ;
//   3. un zero n'est pas une note : c'est l'objet d'avis vide.

const test = require('node:test')
const assert = require('node:assert/strict')
const E = require('../lib/avis/echelle')

const avis = (n, ota, overall_score) => Array.from({ length: n }, () => ({ ota, overall_score }))

test('LE TEST QUI COMPTE (Thierry, 20 octobre 2026) : 10 Airbnb a 5 etoiles + 10 Booking a 8 => 4,5 / 5', () => {
  // ⚠ LES NOTES SONT ECRITES COMME LA BASE LES PORTE. Airbnb note sur 5 etoiles
  // chez lui, mais livre la note DEJA ramenee sur 10 : « 5 etoiles » arrive a
  // 10. Mesure du 20 octobre 2026 sur les 702 avis de production : 563 notes
  // Airbnb sur 598 depassent 5, ce qui est impossible sur une echelle a 5, et
  // les categories d'un sejour parfait valent 10.
  const r = E.noteSur5Des([...avis(10, 'airbnb', 10), ...avis(10, 'booking', 8)])
  assert.equal(r.note_sur_5, 4.5)
  assert.equal(r.notes, 20)
})

test('la meme regle tient si une source livre VRAIMENT du /5', () => {
  // C'est la raison d'etre de la table : le jour ou une source en /5 arrive,
  // une ligne suffit et tous les ecrans suivent. Ici on l'eprouve par la
  // fonction de conversion elle-meme.
  assert.equal(E.surCinq(10, 'airbnb'), 5, '10 sur l echelle du coeur = 5 / 5')
  assert.equal(E.surCinq(8, 'booking'), 4, '8 / 10 = 4 / 5')
  assert.equal(E.surCinq(5, 'booking'), 2.5)
})

test('LE TEST QUI COMPTE : AUCUN ARRONDI INTERMEDIAIRE', () => {
  // Moyenne exacte sur 10 : 9,65. Arrondir d abord (9,7) puis diviser donne
  // 4,9 ; le calcul exact donne 4,825, donc 4,8.
  assert.equal(E.noteSur5Des([
    { ota: 'airbnb', overall_score: 9.5 },
    { ota: 'airbnb', overall_score: 9.8 },
    { ota: 'airbnb', overall_score: 9.65 }
  ]).note_sur_5, 4.8)
  // Un seul avis a 9,65 : meme raisonnement, meme resultat.
  assert.equal(E.noteSur5Des([{ ota: 'airbnb', overall_score: 9.65 }]).note_sur_5, 4.8)

  // ⚠ LE CAS QUI TRANCHE, et les deux precedents ne le faisaient pas : arrondir
  // CHAQUE note avant de sommer donne un autre chiffre. 9,9 et 9,7 valent 4,95
  // et 4,85 ; leur moyenne exacte est 4,90. Arrondies d'abord (5,0 et 4,9),
  // elles donnent 4,95, qui remonte a 5,0 — une note PARFAITE affichee sur deux
  // avis qui ne le sont pas.
  assert.equal(E.noteSur5Des([
    { ota: 'airbnb', overall_score: 9.9 },
    { ota: 'airbnb', overall_score: 9.7 }
  ]).note_sur_5, 4.9)
})

test('LA PONDERATION EST PAR AVIS — un canal a 300 avis pese 300', () => {
  // Moyenner les MOYENNES de chaque canal donnerait (5,0 + 2,5) / 2 = 3,75.
  // Ponderer par le nombre d avis : (5,0 x 10 + 2,5 x 1) / 11 = 4,77 => 4,8.
  assert.equal(E.noteSur5Des([...avis(10, 'airbnb', 10), ...avis(1, 'booking', 5)]).note_sur_5, 4.8)
})

test('LE TEST QUI COMPTE : zero n est pas une note, c est l objet d avis VIDE', () => {
  // Mesure du 20 octobre 2026 : les 33 zeros d Airbnb sont exactement les 33
  // avis masques. Le jour ou Airbnb en revele un, il deviendrait visible a 0 —
  // et ferait tomber la note du logement sur rien.
  assert.equal(E.surCinq(0, 'airbnb'), null)
  assert.equal(E.noteSur5Des([{ ota: 'airbnb', overall_score: 10 }, { ota: 'airbnb', overall_score: 0 }]).note_sur_5, 5)
  assert.equal(E.noteSur5Des([{ ota: 'airbnb', overall_score: 10 }, { ota: 'airbnb', overall_score: 0 }]).notes, 1)
})

test('LE TEST QUI COMPTE : un avis SANS NOTE ne descend pas la note a zero', () => {
  // Si `noteSur5Des` comptait les avis sans note dans son diviseur, un logement
  // a 10 avis parfaits et 10 detections de messages afficherait 2,5 / 5.
  const r = E.noteSur5Des([...avis(10, 'airbnb', 10), ...avis(10, 'direct', null)])
  assert.equal(r.note_sur_5, 5)
  assert.equal(r.notes, 10, 'seuls les avis NOTES comptent dans le diviseur')
})

test('LE TEST QUI COMPTE (dette 76) : la source se reconnait par EGALITE EXACTE, jamais par sous-chaine', () => {
  // `includes` faisait qu'un canal dont le nom CONTIENT celui d'un canal connu
  // heritait de son echelle — `bookingsync` prenait celle de `booking` — et
  // l'alarme utilisait le MEME test, donc ne se declenchait pas sur ces cas :
  // la seule classe d'erreur contre laquelle elle existait passait en silence.
  assert.equal(E.echelleDe('booking'), 10)
  for (const faux of ['bookingsync', 'booking.com.br', 'airbnb-clone', 'myairbnb', 'bookings']) {
    assert.equal(E.echelleDe(faux), null, `${faux} ne doit PAS heriter d une echelle`)
  }
  // La casse et les espaces, eux, ne sont pas une autre source.
  assert.equal(E.echelleDe('  AirBnB  '), 10)
})

test('LE TEST QUI COMPTE (dette 76) : une source INCONNUE n est pas convertie — jamais de division par defaut', () => {
  // Vrbo, HomeAway et Expedia notent sur 5 : supposer /10 aurait affiche leurs
  // avis a la MOITIE de leur valeur, sans un mot. Une note fausse est pire
  // qu'une note absente — elle a l'air d'une note.
  for (const source of ['vrbo', 'expedia', 'homeaway', 'bookingsync', 'tripadvisor', 'direct']) {
    assert.equal(E.surCinq(10, source), null, `${source} : pas d echelle connue, pas de conversion`)
    assert.equal(E.surCinq(4.5, source), null)
  }
  // Et ses notes ne comptent pas dans la moyenne, sans faire disparaitre celles
  // des sources connues.
  const r = E.noteSur5Des([
    { ota: 'airbnb', overall_score: 10 },
    { ota: 'vrbo', overall_score: 5 }
  ])
  assert.equal(r.note_sur_5, 5)
  assert.equal(r.notes, 1, 'la note de la source inconnue ne compte pas dans le diviseur')
})

test('une note absente, vide ou illisible ne compte pas — et ne vaut jamais zero', () => {
  for (const v of [null, undefined, '', 'bien', NaN, -2]) {
    assert.equal(E.surCinq(v, 'airbnb'), null, `${String(v)} n est pas une note`)
  }
  assert.deepEqual(E.noteSur5Des([]), { note_sur_5: null, notes: 0 })
  assert.deepEqual(E.noteSur5Des(null), { note_sur_5: null, notes: 0 })
  assert.deepEqual(E.noteSur5Des([{ ota: 'direct', overall_score: null }]), { note_sur_5: null, notes: 0 },
    'un avis sans note n est pas un avis a 0 / 5')
})

test('LE TEST QUI COMPTE : la table des echelles correspond a la MESURE', () => {
  // Se tromper d echelle divise ou double la note d un logement, et personne ne
  // le verra : 4,9 comme 9,8 ont l air d une note. Ce test fige ce qui a ete
  // mesure le 20 octobre 2026 — l ajout d une source sans mesure le fera rougir.
  // ⚠ SEULES LES SOURCES MESUREES. Une cle « au cas ou » dont la valeur egale le
  // defaut n'a qu'un effet : eteindre l'alarme de source inconnue, pile pour le
  // canal pour lequel elle a ete construite (constat m4 de la revue).
  assert.deepEqual(E.ECHELLE_PAR_CANAL, { airbnb: 10, booking: 10 })
  // ⚠ IL N'Y A PLUS DE DEFAUT (dette 76) : une source hors table n'est pas
  // convertie. Le garder exporte inviterait a s'en servir.
  assert.equal(E.ECHELLE_PAR_DEFAUT, undefined)
})

test('un canal inconnu, un `ota` absent : aucune echelle, donc aucune conversion', () => {
  for (const o of ['un-canal-de-demain', null, undefined, '']) {
    assert.equal(E.echelleDe(o), null)
    assert.equal(E.surCinq(9, o), null)
  }
})

test('le nom du canal se lit sans se soucier de la casse ni des espaces', () => {
  assert.equal(E.echelleDe('Airbnb'), 10)
  assert.equal(E.echelleDe('BOOKING'), 10)
  assert.equal(E.echelleDe(' booking '), 10)
  // Mais une VARIANTE est une autre source : `booking.com` ne parvient jamais
  // en base, `normaliserOta` l ayant deja ramene a `booking`.
  assert.equal(E.echelleDe('booking.com'), null)
})

// ═══════════════════════════════════════════════════════════════════════════
// Les constats de la revue de c9fa086
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE (M1) : un EX AEQUO a .x5 s arrondit pareil, quel que soit le NOMBRE d avis', () => {
  // Le defaut mesure : toutes les notes a 9,7 font une moyenne exacte de 4,85,
  // et l arrondi flottant rendait 4,9 a n=1, 4,8 a n=20, 4,9 a n=100, 4,8 a
  // n=332. Autrement dit UN AVIS DE PLUS, identique aux autres, faisait bouger
  // la note de 0,1. La bulle a 332 notes.
  const notes = (n) => Array.from({ length: n }, () => ({ ota: 'airbnb', overall_score: 9.7 }))
  const vus = new Set()
  for (const n of [1, 2, 3, 5, 10, 20, 33, 50, 99, 100, 200, 332, 400, 1000, 5000]) {
    vus.add(E.noteSur5Des(notes(n)).note_sur_5)
  }
  assert.deepEqual([...vus], [4.9], `quatre bascules pour la meme moyenne : ${[...vus].join(', ')}`)
})

test('M1 : la regle de demi est AU PLUS PROCHE, LE DEMI VERS LE HAUT, et elle est ecrite', () => {
  const une = (note) => E.noteSur5Des([{ ota: 'airbnb', overall_score: note }]).note_sur_5
  assert.equal(une(9.7), 4.9, '4,85 monte')
  assert.equal(une(9.5), 4.8, '4,75 monte')
  assert.equal(une(9.3), 4.7, '4,65 monte')
  assert.equal(une(9.1), 4.6, '4,55 monte')
  // Et juste en dessous d un demi, on descend.
  assert.equal(E.noteSur5Des([{ ota: 'airbnb', overall_score: 9.699 }]).note_sur_5, 4.8)
})

test('M1 : la somme reste exacte sur un gros volume — 5 000 avis ne derivent pas', () => {
  const l = [
    ...Array.from({ length: 2500 }, () => ({ ota: 'airbnb', overall_score: 10 })),
    ...Array.from({ length: 2500 }, () => ({ ota: 'booking', overall_score: 7.5 }))
  ]
  // (5,0 + 3,75) / 2 = 4,375 -> 4,4 (le demi monte)
  assert.equal(E.noteSur5Des(l).note_sur_5, 4.4)
})

test('LE TEST QUI COMPTE (M2) : une note HORS ECHELLE est ecartee, jamais affichee ni plafonnee', () => {
  // Une source sur 100 non mesuree rendait « 50,0 / 5 ». La plafonner a 5
  // serait pire : on affirmerait une note parfaite qu on ne connait pas.
  assert.equal(E.surCinq(50, 'une-source-sur-100'), null)
  const r = E.noteSur5Des([{ ota: 'airbnb', overall_score: 10 }, { ota: 'une-source-sur-100', overall_score: 50 }])
  assert.equal(r.note_sur_5, 5)
  assert.equal(r.notes, 1, 'la note hors echelle ne compte pas dans le diviseur')
})

test('LE TEST QUI COMPTE (M3) : la resolution par NOM fonctionne — eprouvee par une table injectee', () => {
  // Toutes les sources mesurees valent 10 : tant que c est le cas, aucun test
  // ne peut distinguer `echelleDe` d un `return 10`, et la mutation qui
  // supprime la boucle reste verte. Avec une table injectee, elle rougit.
  const table = { airbnb: 5, booking: 10 }
  assert.equal(E.echelleDe('airbnb', table), 5)
  // ⚠ `booking.com` n'arrive JAMAIS en base : `normaliserOta` le ramene a
  // `booking` (lib/cron-channel-reviews.js). La table porte ce que le writer
  // ecrit, pas ce que le partenaire appelle son canal.
  assert.equal(E.echelleDe('booking.com', table), null)
  assert.equal(E.echelleDe('booking', table), 10)
  assert.equal(E.echelleDe('inconnu', table), null, 'hors table = pas d echelle')
  assert.equal(E.surCinq(5, 'airbnb', table), 5, '5 / 5 sur une source en /5')
  assert.equal(E.surCinq(5, 'booking', table), 2.5, '5 / 10 sur une source en /10')
  // Et l enonce de Thierry, dans SA lecture : Airbnb vraiment sur 5.
  const r = E.noteSur5Des([
    ...Array.from({ length: 10 }, () => ({ ota: 'airbnb', overall_score: 5 })),
    ...Array.from({ length: 10 }, () => ({ ota: 'booking', overall_score: 8 }))
  ], { table })
  assert.equal(r.note_sur_5, 4.5, 'meme resultat que sur les donnees reelles')
})

test('m2 : une cle ajoutee doit etre celle que le WRITER ecrit, pas celle qu on aimerait', () => {
  // `normaliserOta` de lib/cron-channel-reviews.js ne connait que airbnb,
  // bookingcom et booking.com, et laisse passer le reste en minuscules :
  // « HomeAway » devient `homeaway`, jamais `vrbo`. Une table qui ne porterait
  // que `vrbo` ne matcherait donc rien.
  assert.equal(E.echelleDe('homeaway', { vrbo: 5 }), null,
    'la cle `vrbo` ne rattrape pas ce que le writer ecrit')
  assert.equal(E.echelleDe('homeaway', { homeaway: 7 }), 7)
})

test('m4 : une source NON MESUREE n est pas dans la table, et ne l est pas « au cas ou »', () => {
  // Une cle « au cas ou » valant la meme chose que le defaut faisait taire le
  // signal pour un canal qu on n a jamais vu. Il n y a plus de defaut, et la
  // table ne porte que ce qui a ete mesure.
  for (const source of ['expedia', 'homeaway', 'vrbo', 'tripadvisor']) {
    assert.equal(E.echelleDe(source), null, `${source} n a pas d echelle connue`)
  }
})

test('LE TEST QUI COMPTE (GRAVE 2) : une source hors table SONNE, elle ne se contente pas d un console.warn', async () => {
  // « UN `console.error` NE REVEILLE PERSONNE » — regle gravee en tete de
  // `lib/canaux-du-bien.js`, et que le registre prescrivait deja pour cette
  // dette. Le silence coute plus cher depuis la correspondance exacte : la
  // consequence d une source hors table est passee de « note divisee par deux »
  // (fausse, mais VISIBLE) a « note absente » (juste, mais INVISIBLE).
  const sonneries = []
  const alarme = async (clef, detail) => { sonneries.push({ clef, detail }) }
  // ⚠ L ARDOISE EST PARTAGEE PAR LE MODULE : les tests precedents de ce fichier
  // ont deja rencontre vrbo, expedia et les autres. On la vide pour partir d un
  // etat connu — un test qui herite de l etat d un autre mesure les deux.
  await E.sonnerSourcesInconnues(() => {})

  // Rien rencontre : rien ne sonne. Une alarme qui sonne a vide ne se lit plus.
  await E.sonnerSourcesInconnues(alarme)
  assert.deepEqual(sonneries, [])

  // Une source hors table, rencontree pendant une conversion.
  E.noteSur5Des([{ ota: 'vrbo', overall_score: 5 }, { ota: 'airbnb', overall_score: 10 }])
  const vues = await E.sonnerSourcesInconnues(alarme)
  assert.deepEqual(vues, ['vrbo'])
  assert.equal(sonneries.length, 1)
  assert.equal(sonneries[0].clef, 'avis_echelle_inconnue')
  assert.deepEqual(sonneries[0].detail.sources, ['vrbo'])
  assert.match(sonneries[0].detail.effet, /ne sont pas converties/)
  assert.match(sonneries[0].detail.geste, /ECHELLE_PAR_CANAL/)

  // ⚠ L ARDOISE SE VIDE : sinon la meme source sonnerait a chaque lecture, et
  // l alarme deviendrait le bruit qu on apprend a ignorer.
  await E.sonnerSourcesInconnues(alarme)
  assert.equal(sonneries.length, 1)

  // Une source CONNUE ne declenche rien, meme apres coup.
  E.noteSur5Des([{ ota: 'booking', overall_score: 8 }])
  await E.sonnerSourcesInconnues(alarme)
  assert.equal(sonneries.length, 1, 'une alarme qui sonne sur du normal ne se lit plus')

  // Un `ota` absent est signale lui aussi : c est le symptome d un SELECT
  // auquel il manque la colonne, et il ferait disparaitre TOUTES les notes.
  E.noteSur5Des([{ overall_score: 9 }])
  await E.sonnerSourcesInconnues(alarme)
  assert.deepEqual(sonneries[1].detail.sources, ['(vide)'])
})

test('LE TEST QUI COMPTE (GRAVE 1) : les TROIS lecteurs demandent `ota` dans leur SELECT', () => {
  // ⚠ CE TEST EXISTE PARCE QUE DEUX MUTATIONS SURVIVAIENT. Avant la
  // correspondance exacte, oublier `ota` dans un SELECT etait INERTE : le
  // defaut /10 etait justement l echelle reelle des deux canaux. Depuis, c est
  // une perte TOTALE et silencieuse — `/logements` perd l etoile de tous les
  // biens, `/avis` perd la note de chaque carte et sa tuile passe a « — ».
  // Aucun rouge, aucun 500, aucune alerte : seulement un warn « (vide) ».
  // Mesure de la revue : retirer `ota` du select de `lib/logement/lecture.js`
  // ou de `CHAMPS` d `api/avis.js` laissait 5684 tests sur 5684 au vert.
  const fs = require('node:fs')
  const path = require('node:path')
  const racine = path.join(__dirname, '..')
  // ⚠ LES LECTEURS SE DECOUVRENT, ILS NE S ENUMERENT PAS. Une liste en dur
  // vieillit de deux facons : elle rate le lecteur ajoute demain, et elle
  // rougit a tort sur une branche ou l un des fichiers n existe pas encore (le
  // lot Logements n est pas sur toutes les branches). On cherche donc qui
  // convertit une note, et on exige de chacun qu il demande la colonne.
  const { execSync } = require('node:child_process')
  const trouves = execSync(
    'grep -rl "microSurCinq\\|noteSur5Des\\|assemblerCartes" --include=*.js lib api core 2>/dev/null || true',
    { encoding: 'utf8', cwd: racine }).trim()
  // ⚠ `assemblerCartes` EN FAIT PARTIE : son appelant lit la base pour elle, et
  // oublier `ota` dans CE select a exactement le meme effet — c'est l'une des
  // deux mutations que la revue a vues survivre.
  const lecteurs = (trouves ? trouves.split('\n') : [])
    .filter(f => !f.startsWith('lib/avis/echelle.js'))   // le module lui-meme
  assert.ok(lecteurs.length >= 2, `${lecteurs.length} lecteur(s) trouve(s) : la recherche ne mesure plus rien`)
  for (const fichier of lecteurs) {
    const src = fs.readFileSync(path.join(racine, fichier), 'utf8')
    // Le select qui alimente la conversion doit porter `ota`. On cherche la
    // liste de colonnes la plus proche : toute chaine de colonnes citant
    // `overall_score` doit aussi citer `ota`.
    // Une LISTE DE COLONNES, et pas n importe quelle chaine : des identifiants
    // separes par des virgules. Sans ce resserrement, `overall_score: 0` —
    // un objet litteral — passait pour un select.
    const selects = (src.match(/['`][^'`]*\boverall_score\b[^'`]*['`]/g) || [])
      .filter(x => /^['`][a-z_0-9,\s`$]+['`]$/i.test(x) && x.includes(','))
    if (selects.length) {
      // Famille 1 : il LIT la base. Sa liste de colonnes doit porter `ota`.
      for (const sel of selects) {
        assert.match(sel, /\bota\b/,
          `${fichier} : ${sel} ne demande pas \`ota\` — sans elle, TOUTES les notes disparaissent en silence`)
      }
    } else {
      // Famille 2 : il CONVERTIT des lignes qu'on lui passe (lib/avis/cartes.js
      // en est). Il doit alors transmettre la source a la conversion — l'oubli
      // a exactement le meme effet, et il est tout aussi muet.
      assert.match(src, /(microSurCinq|surCinq)\([^)]*\.ota\b|noteSur5Des\(/,
        `${fichier} convertit une note sans transmettre \`ota\``)
    }
  }
})

test('GRAVE 1 : sans `ota`, la note est perdue — et c est bien ce qu on veut qu il arrive', () => {
  // La contre-epreuve du test precedent : on verifie que l absence de la
  // colonne a bien l effet redoute, pour que le garde-fou ci-dessus ne soit pas
  // une incantation.
  const sansOta = E.noteSur5Des([{ overall_score: 10 }, { overall_score: 9 }])
  assert.deepEqual(sansOta, { note_sur_5: null, notes: 0 })
  const avecOta = E.noteSur5Des([{ ota: 'airbnb', overall_score: 10 }, { ota: 'airbnb', overall_score: 9 }])
  assert.deepEqual(avecOta, { note_sur_5: 4.8, notes: 2 })
})
