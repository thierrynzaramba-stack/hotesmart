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

test('LE TEST QUI COMPTE : chaque entree porte DEUX chaines, `nom` et `article`', () => {
  // ⚠⚠ CE TEST EXISTE PARCE QUE LA TABLE A CHANGE DE FORME ET QUE TROIS
  // ASSERTIONS SONT DEVENUES VIDES SANS ROUGIR. Elles lisaient les valeurs
  // comme des CHAINES ; depuis que chaque entree est un objet, `String(objet)`
  // vaut « [object Object] », qui ne matche aucun des motifs — donc les filtres
  // rendaient toujours une liste vide, et les assertions passaient pour de bon.
  // Mesure du 2 novembre 2026 : `/^du [aeiou]/i.test(objet)` et
  // `/\d/.test(objet)` rendent tous deux `false`.
  //
  // On exige donc la FORME avant de mesurer le fond : si la table change encore
  // de structure, c'est ici que ca rougit, pas en silence ailleurs.
  const fautifs = []
  for (const [cle, v] of Object.entries(T)) {
    if (!v || typeof v !== 'object') { fautifs.push(`${cle} : pas un objet`); continue }
    if (typeof v.nom !== 'string' || !v.nom) fautifs.push(`${cle} : \`nom\` absent ou vide`)
    if (typeof v.article !== 'string' || !v.article) fautifs.push(`${cle} : \`article\` absent ou vide`)
  }
  assert.deepEqual(fautifs, [],
    'ces entrees n ont pas la forme attendue :\n' + fautifs.join('\n'))
})

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
  // ⚠ ON LIT `.article`, PAS L'OBJET. Avec `v` tel quel, `String(v)` vaut
  // « [object Object] » et ce filtre ne trouvait plus jamais rien.
  // ⚠ « du » ET « de » : relevé en review. Ne regarder que `^du` laissait
  // passer `'Ascension': { article: 'de Ascension' }` — il faut « de l’ ».
  const devantVoyelle = Object.entries(T)
    .filter(([, v]) => /^(?:du|de) [aeiouyàâéèêîïôûœh]/i.test(v.article))
    .map(([k, v]) => `${k} -> ${v.article}`)
  assert.deepEqual(devantVoyelle, [],
    'ces libelles mettent « du » devant une voyelle :\n' + devantVoyelle.join('\n'))
  // ⚠ ET SEUL L'ARTICLE PERD LE « Lundi » : la ligne du ferie, elle, garde
  // « Lundi de Paques » — c'est son nom courant (decision de Thierry).
  const lundi = Object.entries(T).filter(([, v]) => /Lundi/.test(v.article))
    .map(([k, v]) => `${k} -> ${v.article}`)
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
  // ⚠ LE TITRE DE CE TEST EST RESTREINT A CE QU'IL GARDE : le chemin
  // `titreWeekEnd`, c'est-a-dire la seule ligne « week-end prolonge ». Il
  // s'appelait « … A L'ECRAN », ce qui promettait les trois chemins alors
  // qu'il n'en mesurait qu'un. Un titre qui promet trop est un faux vert a lui
  // tout seul.
  //
  // Les trois chemins sont couverts par « sur la FENETRE SERVIE, aucun nom
  // interne n'atteint l'ecran », plus bas. (Les lignes du ferie et du pont
  // etaient encore en nom interne au 2 novembre au matin ; elles ont ete
  // traduites le meme jour, sur decision de Thierry.)
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
  // ⚠⚠ CE MOTIF A ETE CORRIGE DEUX FOIS, ET LA SECONDE CORRECTION EST LA
  // LECON. Il s'ecrivait d'abord `/^Week-end (du |de |de l’|de la )/` : toute
  // chaine commencant par « de l’ » commence deja par « de », donc les deux
  // dernieres alternatives etaient MORTES.
  //
  // Ma « correction » suivante gardait le defaut : j'avais mis les formes
  // courtes en premier et ajoute une branche `|^Week-end de l’\S` qui ne
  // pouvait jamais etre atteinte. Mesure de la review :
  // `FORME.test('Week-end de Armistice 1918')` rendait `true` — exactement le
  // cas que mon propre commentaire donnait comme refuse.
  //
  // MAINTENANT : les formes LONGUES d'abord, et un controle separe de
  // l'elision, parce qu'un motif unique ne sait pas dire « de » est juste
  // devant une consonne et faux devant une voyelle.
  // ⚠ ET IL A FALLU UNE ANTICIPATION NEGATIVE, TROUVEE EN MESURANT.
  // Meme formes longues d'abord, « Week-end de l’ » passait ENCORE : la
  // branche `de ` avalait le « l’ » comme contenu. Chaque alternative porte
  // donc sa propre exigence de contenu, et `de ` refuse d'etre suivi de « l’ ».
  const FORME = /^Week-end (?:du \S|de la \S|de l’\S|de (?!l’)\S)/
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
    const entree = LIBELLE_FERIE[nom]
    const libelle = entree && entree.article
    if (!libelle || !/\d/.test(libelle)) continue      // les trois mobiles
    const [, m, j] = iso.split('-')
    const jour = String(Number(j))
    const attendu = `${jour === '1' ? '1er' : jour} ${MOIS[Number(m) - 1]}`
    if (sansAccent(libelle) !== `du ${attendu}`) faux.push(`${nom} (${iso}) article « ${libelle} », attendu « du ${attendu} »`)
    // ⚠ ET `nom` AUSSI, et c'est un constat de review. Ce test ne mesurait que
    // `.article` : la mutation `'Toussaint': { nom: '15 août', … }` laissait
    // 11 verts. Or `nom` est precisement le champ que ce lot ajoute, et celui
    // que la ligne du ferie AFFICHE.
    if (sansAccent(entree.nom) !== attendu) faux.push(`${nom} (${iso}) nom « ${entree.nom} », attendu « ${attendu} »`)
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

test('LE TEST QUI COMPTE : sur la FENETRE SERVIE, aucun nom interne n atteint l ecran', async () => {
  // ⚠⚠ CELUI-CI NE RAISONNE PAS, IL REGARDE. On demande au moteur ce qu'il
  // posera sur la fenetre que l'endpoint sert vraiment (aujourd'hui -> +1 an,
  // api/yield-evenements.js) et on exige que CHACUN des trois chemins rende un
  // libelle traduit. C'est ce qui aurait attrape, sans review :
  //   — « Week-end — Ascension et Victoire 1945 » (noms joints par « et ») ;
  //   — « Armistice 1918 » sur la ligne du ferie ;
  //   — « pont Armistice 1918 » sur la ligne du pont.
  //
  // ⚠ ET IL COUVRE LES TROIS, parce que couvrir un seul chemin donnait un test
  // dont le TITRE promettait « a l ecran » alors qu'il ne mesurait qu'un tiers.
  const { titreWeekEnd, titreFerie, titrePont } = await import('../shared/yield-libelles-feries.js')
  const { pontsEntre, weekEndsProlonges } = require('../lib/yield/reference.js')
  const { joursFeriesEntre } = require('../lib/yield/jours-feries.js')
  const auj = new Date().toISOString().slice(0, 10)
  const fin = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10)

  const feries = joursFeriesEntre(auj, fin)
  const ponts = pontsEntre(auj, fin)
  const we = weekEndsProlonges(auj, fin)
  // ⚠ NON-VACUITE SUR LES TROIS : une Map vide satisferait tout ce qui suit.
  assert.ok(feries && feries.size >= 10, `feries sur ${auj} -> ${fin} : ${feries ? feries.size : 0}`)
  assert.ok(ponts && ponts.size > 0, `ponts sur ${auj} -> ${fin} : ${ponts ? ponts.size : 0}`)
  assert.ok(we && we.size > 0, `week-ends prolonges sur ${auj} -> ${fin} : ${we ? we.size : 0}`)

  const fautifs = []
  for (const nom of new Set(feries.values())) {
    const t = titreFerie(nom)
    if (!t) fautifs.push(`FERIE   « ${nom} » -> aucun libelle, l ecran garde le nom interne`)
  }
  for (const nom of new Set(ponts.values())) {
    const t = titrePont(nom)
    if (!t) fautifs.push(`PONT    « pont ${nom} » -> aucun libelle, l ecran garde le nom interne`)
  }
  for (const nom of new Set(we.values())) {
    const t = titreWeekEnd(nom)
    if (!t || t.includes('—')) fautifs.push(`WEEKEND « ${nom} » -> « ${t} », le repli`)
  }
  assert.deepEqual(fautifs, [],
    `sur la fenetre servie (${auj} -> ${fin}), ces libelles laissent passer un nom`
    + ' INTERNE a l ecran :\n' + fautifs.join('\n')
    + '\n\nAjoute leur entree dans shared/yield-libelles-feries.js, avec ses deux'
    + ' formes (`nom` et `article`).')
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
