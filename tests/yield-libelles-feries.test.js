// tests/yield-libelles-feries.test.js
// LE NOM COURANT D'UN FÉRIÉ, À L'AFFICHAGE, SANS TOUCHER AU MOTEUR.
//
// ⚠ DÉCISION DE THIERRY DU 2 NOVEMBRE 2026 : « correction à l'AFFICHAGE
// seulement, jamais dans le moteur. Le nom interne (la clé du segment et de
// ses réglages) ne change pas. » La recette du 1er novembre avait vu
// « Week-end du Armistice 1918 » : faux en français, et le nom officiel d'un
// férié n'est pas ce qu'un hôte a en tête.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')

// ⚠ LES NOMS VIENNENT DE LA SOURCE, PAS D'UNE LISTE RECOPIÉE. Une liste
// recopiée ici vieillirait en silence le jour où un férié serait ajouté,
// renommé, ou verrait son orthographe changer — et c'est précisément ce qui
// s'est produit en écrivant cette table (voir le test de l'apostrophe).
function feriesDuMoteur () {
  const src = lire('lib/yield/jours-feries.js')
  const noms = [...src.matchAll(/poser\(.+?,\s*'((?:[^'\\]|\\.)*)'\s*\)/g)]
    .map((m) => m[1].replace(/\\'/g, "'"))
  // ⚠ NON-VACUITÉ : une extraction vide satisferait toutes les assertions qui
  // suivent. Je m'y suis fait prendre deux fois en préparant cette table — un
  // motif `[^,]+` ne traversait pas `jourUTC(an, 11, 11)` et rendait zéro nom,
  // pendant que le contrôle annonçait « aucun férié sans entrée ».
  assert.ok(noms.length >= 10,
    `extraction des feries douteuse (${noms.length}) : la mesure ne vaut rien`)
  return noms
}

let T = null
test.before(async () => { ({ LIBELLE_FERIE: T } = await import('../shared/yield-libelles-feries.js')) })

test('LE TEST QUI COMPTE : les onze feries du moteur ont une entree, et aucune entree n est orpheline', () => {
  const noms = feriesDuMoteur()
  const sans = noms.filter((n) => !(n in T))
  const orphelines = Object.keys(T).filter((c) => !noms.includes(c))
  assert.deepEqual(sans, [],
    'ces feries n ont pas de libelle d affichage :\n' + sans.join('\n')
    + '\nIls rendraient « Week-end — <nom interne> », le repli, au lieu du nom courant.')
  assert.deepEqual(orphelines, [],
    'ces entrees ne correspondent a aucun ferie du moteur :\n' + orphelines.join('\n')
    + '\nUne entree qui ne sert a rien est une entree qui a vieilli.')
})

test('LE TEST QUI COMPTE : l apostrophe de la cle est celle du MOTEUR, pas la typographique', () => {
  // ⚠ CE TEST EXISTE PARCE QUE J'AI FAIT L'ERREUR. `lib/yield/jours-feries.js`
  // pose 'Jour de l\'An' avec U+0027 ; ecrite avec U+2019, la cle ne matche
  // JAMAIS et le repli rend « Week-end — Jour de l'An » sans que rien ne
  // rougisse. Le test ci-dessus l attrape deja ; celui-ci NOMME la cause, pour
  // que le prochain qui voit rouge sache quoi regarder.
  const cles = Object.keys(T).filter((c) => /[’']/.test(c))
  assert.ok(cles.length > 0, 'au moins une cle porte une apostrophe, sinon ce test ne mesure rien')
  const typographiques = cles.filter((c) => c.includes('’'))
  assert.deepEqual(typographiques, [],
    'ces cles portent une apostrophe TYPOGRAPHIQUE (U+2019) :\n' + typographiques.join('\n')
    + '\nLe moteur ecrit U+0027 : la recherche echouerait en silence.')
})

test('LE TEST QUI COMPTE : aucun « du » devant une voyelle, aucun « Lundi de »', () => {
  // Les deux fautes que la table existe pour empecher, et que Thierry a
  // nommees : « Week-end du Ascension » et « Week-end du Lundi de Paques ».
  const devantVoyelle = Object.entries(T)
    .filter(([, v]) => /^du [aeiouyàâéèêîïôûœh]/i.test(v)).map(([k, v]) => `${k} -> ${v}`)
  assert.deepEqual(devantVoyelle, [],
    'ces libelles mettent « du » devant une voyelle :\n' + devantVoyelle.join('\n'))
  const lundi = Object.entries(T).filter(([, v]) => /Lundi/.test(v)).map(([k, v]) => `${k} -> ${v}`)
  assert.deepEqual(lundi, [],
    'ces libelles gardent « Lundi » :\n' + lundi.join('\n')
    + '\nOn dit « le week-end de Paques », pas « le week-end du Lundi de Paques ».')
})

test('LE TEST QUI COMPTE : le titre se compose, et un ferie inconnu ne casse pas la phrase', async () => {
  const { titreWeekEnd } = await import('../shared/yield-libelles-feries.js')
  assert.equal(titreWeekEnd('Armistice 1918'), 'Week-end du 11 novembre')
  assert.equal(titreWeekEnd('Ascension'), 'Week-end de l’Ascension')
  assert.equal(titreWeekEnd('Lundi de Pâques'), 'Week-end de Pâques')
  // ⚠ LE REPLI SE DIT PLUTOT QUE DE MENTIR. Deux feries rayonnant sur le meme
  // week-end sont joints par « et » en amont (lib/yield/reference.js), et un
  // ferie ajoute un jour n aurait pas d entree. On rend le nom tel quel,
  // precede d un tiret : moins joli, mais ca se voit.
  // ⚠ CETTE ASSERTION A ROUGI AU CORRECTIF DU CONSTAT 1, et c'etait son role :
  // elle figeait le repli sur un nom COMPOSE, qui se traduit desormais.
  assert.equal(titreWeekEnd('Armistice 1918 et Toussaint'),
    'Week-end du 11 novembre et du 1er novembre')
  // Le repli ne vaut plus que pour un ferie reellement inconnu.
  assert.equal(titreWeekEnd('Fete du Houblon'), 'Week-end — Fete du Houblon')
  assert.equal(titreWeekEnd(null), null)
  assert.equal(titreWeekEnd(''), null)
})

test('LE TEST QUI COMPTE : le MOTEUR n est pas touche — les cles internes sont intactes', () => {
  // ⚠ C'EST LA MOITIE QUI PROTEGE LES REGLAGES DEJA POSES. Un reglage vit sur
  // la cle du SEGMENT, pas sur le libelle : si quelqu un « simplifiait » en
  // renommant le ferie a la source, tous les reglages poses dessus
  // deviendraient orphelins en base, en silence.
  const src = lire('lib/yield/jours-feries.js')
  for (const attendu of ['Armistice 1918', 'Victoire 1945', 'Fête nationale',
    'Lundi de Pâques', 'Ascension', 'Lundi de Pentecôte']) {
    assert.ok(src.includes(`'${attendu}'`),
      `lib/yield/jours-feries.js doit garder le nom interne « ${attendu} » :`
      + ' c est la cle du segment et de ses reglages, pas un libelle.')
  }
  // Et la table ne doit pas vivre dans le moteur.
  assert.ok(!src.includes('11 novembre'),
    'le nom COURANT ne doit pas entrer dans le moteur : il est d affichage')
})

test("LE TEST QUI COMPTE : aucun ferie ne retombe sur son nom interne DANS LE TITRE DE WEEK-END", async () => {
  // ⚠⚠ LE TITRE DE CE TEST A ETE RESTREINT EN REVIEW, PARCE QU'IL PROMETTAIT
  // PLUS QUE CE QU'IL TIENT. Il s'appelait « aucun ferie du moteur ne retombe
  // sur son nom interne A L'ECRAN » — or il ne mesure que le chemin
  // `titreWeekEnd`, c'est-a-dire la seule ligne « week-end prolonge ».
  //
  // ⚠ ET DEUX AUTRES CHEMINS GARDENT LE NOM INTERNE, MESURES SUR LA FENETRE
  // SERVIE : la ligne du FERIE lui-meme (`lib/yield/reference.js` pose
  // `libelle: feries.get(iso)`, donc « Armistice 1918 ») et la ligne du PONT
  // (`libelle: \`pont ${ponts.get(iso)}\`», donc « pont Armistice 1918 »).
  // L'hote lit donc « Armistice 1918 » et « pont Armistice 1918 » juste a cote
  // de « Week-end du 11 novembre ».
  //
  // Les etendre est une DECISION PRODUIT, pas une correction : Thierry a
  // demande la regle « Week-end du <nom courant> », pas le renommage des
  // lignes de ferie et de pont. Elle lui est posee. En attendant, ce titre dit
  // ce que ce test garde, et rien de plus : un titre qui promet trop est un
  // faux vert a lui tout seul.
  // ⚠ C'EST LA GARDE QUE THIERRY A DEMANDEE, et elle ne lit pas le code : elle
  // l'EXECUTE. `titreWeekEnd` a un repli — « Week-end — <nom interne> » — qui
  // existe pour ne pas casser la phrase sur un ferie inconnu ou sur deux feries
  // joints par « et ». Ce repli est une SORTIE DE SECOURS : si un ferie du
  // moteur l'emprunte, c'est que la table a vieilli, et l'hote lit
  // « Week-end — Armistice 1918 » au lieu de « Week-end du 11 novembre ».
  //
  // ⚠ UN TEST QUI SE CONTENTERAIT DE COMPARER LES CLES NE VERRAIT PAS CA : une
  // cle presente mais avec une valeur vide, ou un repli qui changerait de
  // forme, passeraient. On verifie donc le TEXTE RENDU, ferie par ferie.
  const { titreWeekEnd } = await import('../shared/yield-libelles-feries.js')
  // ⚠ ON RECONNAIT LE REPLI A SON TIRET, PAS A LA PRESENCE DU NOM INTERNE.
  // Ma premiere version testait `titre.includes(nom)` et rougissait sur
  // « Week-end de l’Ascension » — dont le nom courant CONTIENT legitimement le
  // nom interne. Un proxy mal choisi accuse du code juste.
  //
  // ⚠ ET ON EXIGE AUSSI L'ARTICLE : une entree posee a la va-vite
  // (`'Ascension': 'Ascension'`) passerait le seul test du tiret, et rendrait
  // « Week-end Ascension ». Les quatre formes valides sont « du », « de »,
  // « de l’ » et « de la ».
  // ⚠ CE MOTIF A ETE CORRIGE EN REVIEW, ET IL ETAIT FAUX DE DEUX FACONS.
  // Il s'ecrivait `/^Week-end (du |de |de l’|de la )/` : toute chaine
  // commencant par « de l’ » ou « de la » commence DEJA par « de », donc les
  // deux dernieres alternatives etaient mortes et le controle reel valait
  // « du » OU « de ». Consequence mesuree : `'Armistice 1918': 'de Armistice
  // 1918'` passait.
  // Et il ne demandait RIEN APRES L'ARTICLE : `'Toussaint': 'du '` passait les
  // sept tests en rendant « Week-end du », alors qu'un commentaire d'ici
  // annoncait qu'une valeur vide serait vue.
  // Maintenant : l'article est ancre, et il doit etre suivi de quelque chose.
  const FORME = /^Week-end (?:du|de|de l’|de la) \S|^Week-end de l’\S/
  const retombes = []
  for (const nom of feriesDuMoteur()) {
    const titre = titreWeekEnd(nom)
    if (!titre || titre.includes('—') || !FORME.test(titre)) retombes.push(`${nom} -> ${titre}`)
  }
  assert.deepEqual(retombes, [],
    'ces feries retombent sur leur nom INTERNE a l ecran :\n' + retombes.join('\n')
    + '\n\nLe repli « Week-end — <nom> » est une sortie de secours pour un ferie'
    + ' inconnu, pas pour les onze que le moteur pose. Ajoute leur entree dans'
    + ' shared/yield-libelles-feries.js, avec son article.')
})

test('LE TEST QUI COMPTE : la DATE du libelle est celle du ferie, pas celle d un autre', async () => {
  // ⚠ RELEVE EN REVIEW, ET MUTATION A L'APPUI : echanger les valeurs de
  // `Toussaint` et `Assomption` laissait les 7 tests VERTS. L'ecran aurait
  // annonce « Week-end du 1er novembre » pour le week-end du 15 aout.
  // Pour une table de dates ECRITE A LA MAIN, la date fausse est l'erreur la
  // plus probable — et c'etait la seule que rien n'attrapait.
  //
  // ⚠ ET ELLE EST DERIVABLE, donc on ne la recopie pas : le moteur place
  // chaque ferie a une date, on la lui demande et on la compare au libelle.
  // Seuls les huit a date FIXE sont verifiables ainsi ; les trois mobiles
  // n'ont pas de date, et leur libelle ne porte pas de chiffre.
  const { LIBELLE_FERIE } = await import('../shared/yield-libelles-feries.js')
  const { joursFeriesEntre } = require('../lib/yield/jours-feries.js')
  const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet',
    'aout', 'septembre', 'octobre', 'novembre', 'decembre']
  const sansAccent = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  // Une annee pleine suffit : chaque ferie y passe une fois.
  const feries = joursFeriesEntre('2027-01-01', '2027-12-31')
  assert.ok(feries && feries.size >= 10,
    `le moteur doit rendre les feries de l annee (${feries ? feries.size : 0}) :`
    + ' sans eux cette mesure ne vaut rien')
  const faux = []
  for (const [iso, nom] of feries) {
    const libelle = LIBELLE_FERIE[nom]
    if (!libelle || !/\d/.test(libelle)) continue      // les trois mobiles
    const [, m, j] = iso.split('-')
    const jour = String(Number(j))
    const attendu = `${jour === '1' ? '1er' : jour} ${MOIS[Number(m) - 1]}`
    if (sansAccent(libelle) !== `du ${attendu}`) faux.push(`${nom} (${iso}) -> « ${libelle} », attendu « du ${attendu} »`)
  }
  assert.deepEqual(faux, [],
    'ces libelles ne portent pas la date du ferie :\n' + faux.join('\n')
    + '\nUne date fausse est l erreur la plus probable d une table ecrite a la main.')
})

test('LE TEST QUI COMPTE : un nom COMPOSE se traduit entierement, ou pas du tout', async () => {
  // ⚠ RELEVE EN REVIEW, ET MESURE SUR LA FENETRE SERVIE : le moteur joint les
  // feries d'une meme chaine par « et » (lib/yield/reference.js), et cette cle
  // composee n'a aucune entree dans la table. « Ascension et Victoire 1945 »
  // tombe dans la fenetre 2026-11-02 -> 2027-11-02, donc l'ecran rendait
  // « Week-end — Ascension et Victoire 1945 » : les noms INTERNES, le defaut
  // meme que ce lot corrige. Recurrence mesuree 2026-2045 : huit annees.
  const { titreWeekEnd } = await import('../shared/yield-libelles-feries.js')
  assert.equal(titreWeekEnd('Ascension et Victoire 1945'),
    'Week-end de l’Ascension et du 8 mai')
  assert.equal(titreWeekEnd('Noël et Jour de l\'An'),
    'Week-end du 25 décembre et du 1er janvier')
  // ⚠ TOUT OU RIEN : une phrase a moitie traduite aurait l'air juste.
  assert.equal(titreWeekEnd('Ascension et Machin 1999'),
    'Week-end — Ascension et Machin 1999')
})

test('LE TEST QUI COMPTE : les noms composes de la FENETRE SERVIE sont tous traduits', async () => {
  // ⚠ CELUI-CI NE RAISONNE PAS, IL REGARDE : on demande au moteur les
  // week-ends prolonges de la fenetre que l'endpoint sert (aujourd'hui -> +1 an,
  // api/yield-evenements.js) et on exige que CHACUN ait un titre traduit.
  // C'est ce qui aurait attrape le defaut sans qu'une review le trouve.
  const { weekEndsProlonges } = require('../lib/yield/reference.js')
  const { titreWeekEnd } = await import('../shared/yield-libelles-feries.js')
  const auj = new Date().toISOString().slice(0, 10)
  const fin = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10)
  const we = weekEndsProlonges(auj, fin)
  assert.ok(we && we.size > 0,
    `aucun week-end prolonge sur ${auj} -> ${fin} : la mesure ne vaut rien`)
  const retombes = []
  for (const nom of new Set(we.values())) {
    const t = titreWeekEnd(nom)
    if (!t || t.includes('—')) retombes.push(`${nom} -> ${t}`)
  }
  assert.deepEqual(retombes, [],
    `ces noms de la fenetre servie (${auj} -> ${fin}) retombent sur le repli :\n`
    + retombes.join('\n'))
})

test('LE CONTRE-CONTROLE : le repli existe toujours, et il se voit', async () => {
  // ⚠ SANS LUI, LE TEST CI-DESSUS SERAIT VERT POUR UNE FONCTION QUI RENVERRAIT
  // N IMPORTE QUOI DE NON VIDE (regle 22). Ici on prouve que le repli est bien
  // la, et qu'il est RECONNAISSABLE — c'est ce qui permet au test precedent de
  // le detecter.
  const { titreWeekEnd } = await import('../shared/yield-libelles-feries.js')
  const inconnu = titreWeekEnd('Fete du Houblon')
  assert.equal(inconnu, 'Week-end — Fete du Houblon')
  assert.ok(inconnu.includes('—'), 'le repli doit rester reconnaissable a son tiret')
})
