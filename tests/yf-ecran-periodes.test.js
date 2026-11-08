// tests/yf-ecran-periodes.test.js
// L'ECRAN « QUAND VOS PRIX BOUGENT » — la refonte du 28 octobre 2026.
// Spec : docs/specs/spec-yf-ecran-periodes.md
//
// ⚠ POURQUOI CE FICHIER EST EN PARTIE SOURCE, ET POURQUOI C'EST DIT.
// `apps/yield/prix.html` n'a pas de banc : c'est une page de 2 000 lignes sans
// i18n et sans module extractible en bloc. Le depot teste deja cette page au
// SOURCE (tests/pilote-fenetre.test.js, tests/prix-hote.test.js), et ce
// fichier suit la meme pratique — mais il EXECUTE ce qui porte de la logique :
// les dates en toutes lettres et les cinq etats d'effet sont extraits de la
// page et lances pour de vrai. Un test qui ne ferait que grep dirait que le
// code CONTIENT quelque chose, pas qu'il le FAIT.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')
const PAGE = () => lire('apps/yield/prix.html')
const sansCommentaires = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ')

// Le bloc de rendu de l'ecran, isole : c'est LUI qu'on juge, pas la page.
function blocRendu () {
  const src = sansCommentaires(PAGE())
  const i = src.indexOf('async function rendrePopup')
  const j = src.indexOf('function ligneHtml')
  assert.ok(i > 0 && j > i, 'le bloc de rendu est introuvable')
  return src.slice(i, src.indexOf('function decalerJour') > 0 ? src.indexOf('function decalerJour') : src.length)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. DOUZE MOIS, EN UN SEUL APPEL
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : la fenetre demande DOUZE mois, sans bornes', () => {
  // ⚠ LE DEFAUT QU'IL EMPECHE : `apiEv('GET', null, { debut, fin })` bridait
  // la lecture AU MOIS AFFICHE, alors que la fenetre par defaut du serveur est
  // deja prospective sur douze mois. L'ecran rechargeait donc a chaque fleche.
  const src = sansCommentaires(PAGE())
  const i = src.indexOf('async function lireEvenements')
  const fn = src.slice(i, src.indexOf('}', src.indexOf('evenements = r.data')))
  assert.match(fn, /apiEv\('GET'\)/,
    'la lecture doit se faire SANS bornes : la fenetre par defaut du serveur est deja de 12 mois')
  assert.doesNotMatch(fn, /debut:/,
    'aucune borne `debut` : elle brimerait la fenetre au mois')
  assert.doesNotMatch(fn, /fin:/, 'aucune borne `fin`')
})

test('LE TEST QUI COMPTE : plus aucune navigation par mois dans cet ecran', () => {
  // Les deux fleches ‹ › de la pop-up appelaient `charger()` — donc
  // `/api/yield-prix` — a CHAQUE mois consulte, en plus de relire les
  // evenements. Consulter douze mois coutait vingt-quatre appels.
  const bloc = blocRendu()
  assert.doesNotMatch(bloc, /ev-prec|ev-suiv/,
    'les fleches de navigation par mois doivent avoir disparu')
  assert.doesNotMatch(bloc, /decalerMois/,
    'aucun decalage de mois : l ecran montre les douze d un coup')
})

test('les mois sont GROUPES, et il y en a TREIZE quand la fenetre en touche treize', () => {
  // ⚠ CE TEST DISAIT L'INVERSE JUSQU'AU 3 NOVEMBRE 2026, et il avait tort —
  // c'est l'anomalie 2 de la recette de Thierry du 29 octobre. Il exigeait
  // `moisListe.length < 12`, donc il GARDAIT le plafond qui obligeait au repli,
  // et le repli rangeait l'occurrence du 23 octobre 2027 sous « septembre
  // 2027 ». Masquer une colonne est une mise en page ; ranger une periode sous
  // un mois ou elle n'a pas un seul jour est un FAIT FAUX.
  const bloc = blocRendu()
  assert.match(bloc, /moisListe\.length < 13/,
    'la fenetre touche 13 mois des que le jour n est pas un 1er : la frise les montre')
  assert.match(bloc, /qpb-mois/, 'les periodes doivent etre groupees par mois')
  // ⚠ ET LA TREIZIEME COLONNE SE DIT PARTIELLE, au lieu de se faire passer
  // pour un mois entier : elle ne couvre que le debut de son mois.
  assert.match(bloc, /const moisPartiel = moisListe\.length > 12/,
    'la derniere colonne doit savoir qu elle est partielle')
  const src = sansCommentaires(PAGE())
  assert.match(src, /qpb-col--partiel/, 'et le dire a l ecran')
  // ⚠ ET LA BANDE SE VOIT. Sur l'echelle d'encre, le fond des trois niveaux
  // bas est a 1,07 / 1,19 / 1,45:1 du blanc : une bande de 7 px sans lisere
  // n'est pas une bande, c'est du vide. Mesure faite sur l'apercu, pas en
  // lecture — c'est ce que l'image a montre et qu'aucun test ne disait.
  assert.match(src, /\.qpb-bande \{[^}]*border: 1px solid var\(--niveau-lisere/,
    'une bande de niveau porte le lisere de son niveau, sinon on ne la voit pas')
  assert.match(src, /--qpb-mois:\$\{moisListe\.length\}/,
    'le nombre de colonnes vient du nombre de mois, pas d un 12 en dur')
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. AUCUN MOT DU MOTEUR
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : aucun mot du moteur ne sort a l ecran', () => {
  // ⚠ LA LISTE EST CELLE DE LA SPEC §3, et elle est la raison d'etre du lot :
  // « la page evenement est inbuvable […] incomprehensible ».
  // ⚠ ON NE CHERCHE QUE LE TEXTE QUE L'HOTE LIT, et ma premiere version ne le
  // faisait pas : elle attrapait `data-reconduire` (un nom d'attribut) et
  // `{ crans: null }` (le CHAMP du serveur, qui doit rester — le modele en
  // crans ne change pas, seuls les mots changent). Un test qui confond le
  // vocabulaire de l'ecran et celui du code rend un perimetre faux, et c'est
  // la lecon du depot sur les mesures faites « sur une seule forme ».
  //
  // Le texte lu, c'est : ce qui est entre deux balises, et les attributs que
  // le navigateur AFFICHE (title, aria-label, placeholder).
  const src = sansCommentaires(PAGE())
  const rendu = src.slice(src.indexOf('async function rendrePopup'))
  const textes = [
    ...[...rendu.matchAll(/>([^<>{}`$]{3,})</g)].map(m => m[1]),
    ...[...rendu.matchAll(/(?:title|aria-label|placeholder)="([^"$]{3,})"/g)].map(m => m[1])
  ].join(' | ')
  assert.ok(textes.length > 300, 'extraction vide : ce test ne mesure plus rien')

  const INTERDITS = [
    'crans', 'laisser mesurer', 'sans effet', 'se comporte comme',
    'éclairé par', 'à déterminer', 'date commerciale'
  ]
  const fautifs = INTERDITS.filter(mot => new RegExp(mot, 'i').test(textes))
  assert.deepEqual(fautifs, [],
    `ces mots du moteur sortent a l ecran : ${fautifs.join(', ')}`)

  // ⚠ ET LE MOTIF SE PROUVE SUR UN FAUX, sinon un motif qui ne reconnait rien
  // passerait au vert sans mesurer quoi que ce soit.
  assert.ok(/crans/i.test('<span>+2 crans</span>'.match(/>([^<>]+)</)[1]),
    'le motif ne reconnait pas un mot du moteur place dans du texte')
})

test('les mots de remplacement sont bien la', () => {
  const src = PAGE()
  for (const attendu of [
    'Quand vos prix bougent', 'vacances et jours fériés', 'fêtes du calendrier',
    'ajouté par vous', 'Automatique', 'Revient l’an prochain ?', 'Ressemble à',
    // ⚠ MAJUSCULE : depuis le 28 octobre 2026, « Week-end du 11 novembre »
    // est le TITRE de la periode, plus une mention dans son detail.
    'Week-end du', 'Vacances connues jusqu’au'
  ]) {
    assert.ok(src.includes(attendu), `« ${attendu} » manque a l ecran`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. UN SEUL CODE COULEUR, ET LES TROIS COULEURS RESERVEES
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : un seul code couleur — et c est le NIVEAU', () => {
  // ⚠ CE TEST EXIGEAIT L INVERSE JUSQU AU 4 NOVEMBRE 2026, ET IL PASSAIT POUR
  // UNE MAUVAISE RAISON — constat de review. Il demandait `e-monte`,
  // `e-baisse`, `e-normal`, `e-inconnu` dans la page, et il les trouvait
  // dans DEUX COMMENTAIRES qui racontent leur retrait. Il protegeait donc
  // l inverse de ce que le lot livre, et aurait rougi au premier nettoyage de
  // commentaire : un faux vert dans les deux sens.
  const src = sansCommentaires(PAGE())
  for (const mort of ['e-monte', 'e-baisse', 'e-normal', 'qpb-effet']) {
    assert.doesNotMatch(src, new RegExp('\\b' + mort + '\\b'),
      `${mort} appartient au vocabulaire invente : il ne doit plus exister`)
  }
  // Le seul code couleur est l echelle d encre, par les classes partagees.
  assert.match(src, /class="qpb-bande \$\{cl \|\| 'qpb-bande--auto'\}"/,
    'la bande porte la classe de son NIVEAU, ou le contour « sans niveau »')
  assert.match(src, /const NIVEAU_CLASSE = \{/, 'une seule table de classes')
})

test('LE TEST QUI COMPTE : les trois couleurs reservees sont respectees', () => {
  // Decisions de Thierry, 28 octobre 2026 : le NOIR a la navigation, l AMBRE
  // a « ce que HoteSmart a fait pour vous », le BLEU a ce qui est CLIQUABLE.
  const src = sansCommentaires(PAGE())
  const regle = (sel) => {
    const m = src.match(new RegExp('\\' + sel + '[^{]*\\{([^}]*)\\}'))
    return m ? m[1] : ''
  }
  // ⚠ « MOINS CHERS » N'EXISTE PLUS, ET SON PRUNE NON PLUS. Amendement du
  // 29 octobre, code le 3 novembre : la periode affiche SON NIVEAU sur
  // l'echelle d'encre. --prune et --prune-bg etaient son seul usage produit ;
  // ils sont sortis de public/style.css dans le meme commit.
  assert.equal(regle('.qpb-effet.e-baisse'), '',
    'la regle de l etat « moins chers » ne doit plus exister')
  assert.doesNotMatch(src, /--prune/, 'le jeton ne doit plus etre reference')
  assert.match(regle('.qpb-btn-plein'), /var\(--blue\)/,
    'une action est bleue, jamais noire')
  assert.doesNotMatch(regle('.qpb-btn-plein'), /var\(--text\)\s*;/,
    'le noir est reserve a la navigation')
  // Et les jetons existent la ou vivent leurs voisins.
  const feuille = lire('public/style.css')
  assert.ok(feuille.includes('--blue:'), '--blue: manque a public/style.css')
  // ⚠ ET LES DEUX JETONS DU PRUNE NE DOIVENT PLUS Y ETRE. Un jeton sans usage
  // se recopie et se maintient pour rien — c'est la raison qui avait fait
  // retirer --blue-bg le 28 octobre, et elle vaut ici.
  for (const jeton of ['--prune:', '--prune-bg:']) {
    assert.ok(!feuille.includes(jeton), `${jeton} doit avoir quitte public/style.css`)
  }
  // ⚠ `--blue-bg` A ETE RETIRE : il n'etait reference nulle part (review du
  // 28 octobre). Un jeton inutilise se recopie et se maintient pour rien.
  assert.ok(!feuille.includes('--blue-bg'), 'un jeton inutilise ne revient pas')
  // ⚠ ET LE DOUBLON AVEC `theme.css` EST DIT, pas tu : ces pages ne chargent
  // pas le socle V5, donc sans ce jeton elles n'auraient aucun bleu.
  assert.match(feuille, /OUI, C'EST LA MEME VALEUR QUE `--info`/,
    'un doublon assume se commente, sinon la prochaine review le « corrige »')
  assert.ok(!feuille.includes('#5B2A86'), 'la valeur du prune ne doit plus etre declaree')
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. CE QUI PORTE DE LA LOGIQUE : ON L'EXECUTE
// ═══════════════════════════════════════════════════════════════════════════

// On extrait les fonctions pures de la page et on les lance. Une copie
// ecrite ici serait un double plus permissif que le vrai (REVIEW.md regle 22).
function outils () {
  const src = sansCommentaires(PAGE())
  const i = src.indexOf('const MOIS_LONG =')
  const j = src.indexOf('async function rendrePopup')
  assert.ok(i > 0 && j > i, 'les outils de date sont introuvables')
  // ⚠ LA TABLE DES EFFETS N'EST PLUS EXTRAITE : elle n'existe plus. Ce que
  // la page porte encore de PUR, ce sont les outils de date ; le niveau, lui,
  // vit dans shared/yield-niveau-periode.js et se teste directement.
  const ctx = { assert }
  vm.createContext(ctx)
  vm.runInContext(src.slice(i, j) + '\nglobalThis.O = { periodeEnLettres }', ctx)
  return ctx.O
}

test('LE TEST QUI COMPTE : les dates en toutes lettres, sans repeter l inutile', () => {
  const { periodeEnLettres } = outils()
  assert.equal(periodeEnLettres('2026-05-16', '2026-05-17'), '16 → 17 mai 2026',
    'meme mois : le mois et l annee ne se disent qu une fois')
  assert.equal(periodeEnLettres('2026-10-28', '2026-11-03'), '28 octobre → 3 novembre 2026',
    'mois different, meme annee : l annee ne se dit qu une fois')
  assert.equal(periodeEnLettres('2026-12-19', '2027-01-02'), '19 décembre 2026 → 2 janvier 2027',
    'annee differente : elle se dit des deux cotes')
  assert.equal(periodeEnLettres('2026-12-24', '2026-12-24'), '24 décembre 2026',
    'un seul jour ne fait pas une fleche')
  assert.equal(periodeEnLettres('2027-08-04'), '4 août 2027', 'une date seule')
  // Et surtout : plus aucun chiffre de mois.
  for (const d of [['2026-05-16', '2026-05-17'], ['2026-10-28', '2026-11-03']]) {
    assert.doesNotMatch(periodeEnLettres(...d), /\d{2}\/\d{2}\/\d{4}/,
      'aucune date en jj/mm/aaaa ne doit rester')
  }
})

test('LE TEST QUI COMPTE : `crans = 0` n est pas `crans = null` — DEUX tests, un pour chacun', async () => {
  // ⚠⚠ PRECISION DE THIERRY DU 3 NOVEMBRE 2026, mot pour mot : « crans = 0
  // n'est pas crans = null. 0 = mesure sans effet → la pastille affiche le
  // niveau ORDINAIRE du bien. null = inconnu → "Automatique", sans niveau
  // invente. Un test pour chacun. »
  //
  // ⚠ ET ON MESURE LE SERVEUR, PAS UNE COPIE. L'ancien test lisait deux
  // fonctions de la PAGE (`effetClasse`, `effetMot`) qui traduisaient les
  // crans en mots inventes. Ces mots sont partis ; ce qui porte la difference
  // est maintenant `niveaux_jour`, pose par lib/yield/calendrier-pilotage.js
  // avec la formule du moteur. C'est donc lui qu'on interroge.
  const { calendrier } = require('../lib/yield/calendrier-pilotage.js')
  const R = require('../lib/yield/reference.js')
  const ctx = R.construireContexte({ zoneBien: 'A', vacances: [], evenements: [], debut: '2026-11-01', fin: '2026-12-31' })
  // Une structure ordinaire a RELIEF : la semaine a Moyen (1), le week-end a
  // Haut (2). C'est ce relief que le cran doit conserver.
  const pj = new Map()
  for (const j of R.JOURS_SEMAINE) {
    pj.set(`${R.SEGMENTS.HORS_VACANCES}|${j}`,
      { fiable: true, indice: (j === 'samedi' || j === 'dimanche') ? 2 : 1 })
  }
  const lire = (cransFerie) => {
    const pos = new Map([
      [R.SEGMENTS.HORS_VACANCES, { fiable: true, indice: 1, niveau: 'Moyen', crans: 0, mediane: 100, echantillon: 50 }],
      ['ferie', cransFerie === null
        ? { fiable: false, indice: null, niveau: null, crans: null, echantillon: 0 }
        : { fiable: true, indice: 1 + cransFerie, niveau: 'x', crans: cransFerie, mediane: 120, echantillon: 20 }]
    ])
    const l = calendrier({ contexte: ctx, debut: '2026-11-01', fin: '2026-12-31',
      positions: pos, positions_jour: pj, evenements: [] })
    return l.find(e => e.segment === 'ferie')
  }

  // ── crans = 0 : une MESURE, qui dit « cette periode ne pousse rien » ──
  const zero = lire(0)
  assert.ok(zero, 'le ferie doit etre dans la liste')
  assert.equal(zero.crans, 0, 'le cas teste est bien 0, pas null')
  assert.ok(zero.niveaux_jour, 'a 0 crans, la pastille a bien un niveau : celui du bien')
  assert.equal(zero.niveaux_jour.lundi, 'Moyen', 'la semaine garde le niveau ordinaire')
  assert.equal(zero.niveaux_jour.samedi, 'Haut', 'et le week-end le sien : le relief est conserve')

  // ── crans = null : l ABSENCE de mesure, et on n invente rien ──────────
  const inconnu = lire(null)
  assert.ok(inconnu, 'le ferie doit etre dans la liste meme sans mesure')
  assert.equal(inconnu.crans, null, 'le cas teste est bien null, pas 0')
  assert.equal(inconnu.niveaux_jour, null,
    'sans mesure, AUCUN niveau — un niveau affiche sans mesure serait un chiffre faux')

  // ── et les deux ne se confondent jamais ──────────────────────────────
  assert.notDeepEqual(zero.niveaux_jour, inconnu.niveaux_jour,
    '0 et null doivent rendre deux choses differentes, sinon la distinction est perdue')

  // Ce que l ECRAN en fait : un niveau d un cote, « Automatique » de l autre.
  const M = await import('../shared/yield-niveau-periode.js')
  assert.equal(M.libellePastille(zero.niveaux_jour).principal, '2 · Moyen',
    'a 0 cran, la pastille porte le niveau ordinaire, avec son chiffre')
  assert.equal(M.libellePastille(inconnu.niveaux_jour), null,
    'sans niveau, le module ne rend RIEN : c est l ecran qui dira « Automatique »')
})

test('LE TEST QUI COMPTE : un cran POUSSE la structure en gardant ses reliefs', async () => {
  // La formule du moteur, montree a l ecran :
  //   niveau de la nuit = niveau(hors vacances | son jour) + crans
  // Un bien a relief (semaine Moyen, week-end Haut) pousse de 2 crans donne
  // Tres haut en semaine ET Exceptionnel le week-end — le meme cran, l ecart
  // conserve. C'est ce que le vocabulaire invente aplatissait.
  const { calendrier } = require('../lib/yield/calendrier-pilotage.js')
  const R = require('../lib/yield/reference.js')
  const ctx = R.construireContexte({ zoneBien: 'A', vacances: [], evenements: [], debut: '2026-11-01', fin: '2026-12-31' })
  const pj = new Map()
  for (const j of R.JOURS_SEMAINE) {
    pj.set(`${R.SEGMENTS.HORS_VACANCES}|${j}`,
      { fiable: true, indice: (j === 'samedi' || j === 'dimanche') ? 2 : 1 })
  }
  const pos = new Map([
    [R.SEGMENTS.HORS_VACANCES, { fiable: true, indice: 1, niveau: 'Moyen', crans: 0, mediane: 100, echantillon: 50 }],
    ['ferie', { fiable: true, indice: 3, niveau: 'Très haut', crans: 2, mediane: 160, echantillon: 20 }]
  ])
  const e = calendrier({ contexte: ctx, debut: '2026-11-01', fin: '2026-12-31',
    positions: pos, positions_jour: pj, evenements: [] }).find(x => x.segment === 'ferie')
  assert.equal(e.niveaux_jour.mardi, 'Très haut', 'Moyen + 2 crans')
  assert.equal(e.niveaux_jour.samedi, 'Exceptionnel', 'Haut + 2 crans — le relief est garde')

  const M = await import('../shared/yield-niveau-periode.js')
  const p = M.libellePastille(e.niveaux_jour)
  assert.equal(p.principal, '4 · Très haut', 'la pastille montre le groupe le plus nombreux')
  assert.equal(p.complement, 'week-ends 5 · Exceptionnel',
    'et nomme le week-end, parce que les jours qui different SONT le week-end du moteur')

  // ⚠ ET LE MOT « WEEK-END » NE S ECRIT QUE S IL EST VRAI. Si ce sont les
  // vendredis et samedis qui se detachent, on les NOMME : inventer
  // « week-end » pour des vendredis serait une affirmation fausse, et elle ne
  // rougirait jamais.
  const autre = {}
  for (const j of M.JOURS_ORDRE) autre[j] = (j === 'vendredi' || j === 'samedi') ? 'Très haut' : 'Haut'
  const q = M.libellePastille(autre)
  assert.equal(q.complement, 'vendredis et samedis 4 · Très haut')
  assert.doesNotMatch(q.complement, /week-end/, 'on n invente pas un week-end')

  // Et la borne du cran se verifie sur TOUS les groupes, pas sur la semaine.
  // ⚠ LA BORNE NE REFUSE QUE SI LE PAS NE CHANGERAIT RIEN, et c'est un
  // constat de review. Refuser des qu'UN groupe bute tuait ▼ pour toute la
  // periode des que la semaine etait a Base — le cas COURANT, Base etant le
  // quantile 0,25 — alors que le week-end, lui, serait bien descendu.
  const JJ = M.JOURS_ORDRE
  const mixte = Object.fromEntries(JJ.map(j => [j, (j === 'samedi' || j === 'dimanche') ? 2 : 0]))
  const utile = M.apresLePas({ structure: mixte, crans: 0, cransMax: 2 }, -1)
  assert.equal(utile.possible, true,
    'la semaine est a Base mais le week-end descendrait : le pas sert, il est offert')
  const plafond = Object.fromEntries(JJ.map(j => [j, 4]))
  const bute = M.apresLePas({ structure: plafond, crans: 0, cransMax: 2 }, 1)
  assert.equal(bute.possible, false, 'rien ne bougerait : ▲ est refuse')
  assert.match(bute.raison, /la semaine est déjà à 5 · Exceptionnel/,
    'et le bouton desactive DIT sa raison, au lieu d etre inoperant en silence')
  // ⚠ ET L ARRIVEE SE CALCULE SUR LES CRANS, PAS SUR L AFFICHAGE : avec une
  // structure a 4 et deux crans, ▼ ecrit crans = 1, donc 4 + 1 = 5 ecrete a
  // Exceptionnel — le niveau ne bouge pas, et l etiquette doit le dire.
  // ⚠ ET C'EST LE CAS QUE LA REVIEW AVAIT MESURE : structure a 4, crans +2.
  // Le clic ecrirait crans = 1, donc 4 + 1 = 5 ecrete a Exceptionnel — le
  // meme niveau qu'avant. Ma premiere version annoncait « passe a 4 · Tres
  // haut » et laissait Exceptionnel : un bouton ACTIF qui ne fait rien. Il
  // est maintenant refuse, avec sa raison.
  const haut = Object.fromEntries(JJ.map(j => [j, 4]))
  const rien = M.apresLePas({ structure: haut, crans: 2, cransMax: 2 }, -1)
  assert.equal(rien.possible, false, 'le pas ne changerait rien : il est refuse')
  assert.match(rien.raison, /déjà à 5 · Exceptionnel/, 'et il dit pourquoi')
})

test('LE TEST QUI COMPTE : « chaque annee » se voit, et JAMAIS sur une ligne automatique', () => {
  // ⚠ ANOMALIE 1 DE LA RECETTE DU 29 OCTOBRE. Un reglage est pose sur le
  // SEGMENT, sans date : il vaut pour toutes les occurrences, chaque annee.
  // Thierry : « c'est voulu, mais il faut que ca se voie. »
  //
  // ⚠ ET LE CRITERE EST `crans_ajustes`, PAS `crans` : `crans` vaut la mesure
  // du moteur quand l hote n a rien pose. L ecrire la serait faux — une ligne
  // en « Automatique » ne porte aucun reglage, donc rien ne se reconduit.
  const src = sansCommentaires(PAGE())
  assert.match(src, /const regleALaMain = e\.crans_ajustes != null/,
    'le critere reste crans_ajustes, jamais crans')
  // ⚠ ON VISE LE BALISAGE, PAS LA PREMIERE OCCURRENCE DU NOM. La regle CSS
  // porte `qpb-chaque` elle aussi, et elle vient AVANT dans le fichier :
  // chercher autour de la premiere occurrence mesurait le CSS, pas le rendu.
  assert.match(src, /\$\{regleALaMain \? '<span class="qpb-chaque"[^']*chaque année<\/span>' : ''\}/,
    '« chaque annee » doit etre conditionnee a un reglage pose a la main')
})

test('LE TEST QUI COMPTE : les libelles de feries passent par la table, dans la pop-up aussi', () => {
  // Le nom COURANT, pas le nom interne : « Week-end du 11 novembre », pas
  // « Week-end du Armistice 1918 ». A l affichage seulement — la cle du
  // segment et de ses reglages ne bouge pas d un caractere.
  const src = sansCommentaires(PAGE())
  assert.match(src, /import \{ titreWeekEnd, titreFerie, titrePont \} from '\/shared\/yield-libelles-feries\.js'/,
    'la table est importee, pas recopiee')
  assert.match(src, /const nomAffiche = /, 'et un seul endroit compose le nom affiche')
  // La frise ET la ligne doivent passer par lui : deux copies diraient un jour
  // deux noms pour la meme bande et la meme ligne.
  assert.ok((src.match(/nomAffiche\(e\)/g) || []).length >= 2,
    'la frise et la ligne lisent toutes deux le meme composeur')
})

test('LE TEST QUI COMPTE : le serveur sert positions_jour, et l ecran ne le recalcule pas', () => {
  // ⚠ ZERO REQUETE DE PLUS, ZERO APPEL DE PLUS. grilleDuBien la calcule deja
  // dans le meme appel (lib/yield/suggestion.js) et l endpoint la JETAIT.
  // Precedent etabli : api/yield-prix.js la sert deja.
  const api = lire('api/yield-evenements.js')
  assert.match(api, /positionsJour = g\.grille\.positions_jour/,
    'l endpoint doit prendre positions_jour dans la reponse qu il a deja')
  assert.match(api, /positions_jour: positionsJour/,
    'et la passer a calendrier()')
  // Et il n y a qu UN appel a grilleDuBien : si la mesure en demandait un
  // second, la case PERFORMANCE du lot serait fausse.
  assert.equal((api.match(/await grilleDuBien\(/g) || []).length, 1,
    'un seul appel a la grille, comme avant le lot')

  // ⚠ ET LA FORMULE N EST PAS REECRITE DANS L ECRAN. Si la page recalculait un
  // niveau a partir des crans, elle ferait un second moteur, qui divergerait
  // au premier changement de l autre.
  const src = sansCommentaires(PAGE())
  assert.doesNotMatch(src, /indice \+ crans|crans \+ indice/,
    'la page ne recompose jamais un niveau : elle lit niveaux_jour')
  const moteur = lire('lib/yield/calendrier-pilotage.js')
  // ⚠ LES QUATRE BRANCHES DU MOTEUR, PAS UNE SEULE — constat de review, et
  // c'etait le defaut que mon propre commentaire disait vouloir eviter. Le
  // moteur fait passer la MESURE PROPRE du couple segment|jour avant le
  // modele en crans : sans elle, un ferie du samedi mesure a Base s affichait
  // « Tres haut » dans la pop-up pendant que Prediction de prix rendait
  // « Base, 80 € ». Trois niveaux d ecart sur la meme nuit, entre deux ecrans.
  assert.match(moteur, /const indiceModele = structure \? borne\(structure\.indice \+ \(e\.crans \|\| 0\)\) : null/,
    'le modele en crans, comme dans suggestion.js')
  assert.match(moteur, /const indiceMesure = fiable\(mesure\) \? mesure\.indice : null/,
    'ET la mesure propre du couple, que le moteur fait passer AVANT')
  assert.match(moteur, /structure = fiable\(structJour\) \? structJour : \(fiable\(structSeg\) \? structSeg : null\)/,
    'ET le repli du moteur quand le jour n est pas fiable')
  assert.match(moteur, /if \(e\.crans == null\) return null/,
    'ET la regle de Thierry par-dessus : null n est jamais un niveau')
})

test('LE TEST QUI COMPTE : le repli du moteur joue, et on le MESURE', () => {
  // ⚠ UNE ASSERTION DE TEXTE NE SUFFISAIT PAS, et la mutation l'a prouve :
  // la chaine \`fiable(structSeg) ? structSeg : null\` apparait DEUX fois — dans
  // niveauxDuJour et dans structureDuJour. En retirer une laissait le test
  // vert. On execute donc, au lieu de lire.
  const { calendrier } = require('../lib/yield/calendrier-pilotage.js')
  const R = require('../lib/yield/reference.js')
  const ctx = R.construireContexte({ zoneBien: 'A', vacances: [], evenements: [], debut: '2026-08-01', fin: '2026-09-30' })
  // AUCUN jour ordinaire fiable — seul le segment « hors vacances » l'est.
  const pj = new Map()
  for (const j of R.JOURS_SEMAINE) pj.set(`${R.SEGMENTS.HORS_VACANCES}|${j}`, { fiable: false, indice: null })
  const pos = new Map([
    [R.SEGMENTS.HORS_VACANCES, { fiable: true, indice: 1, niveau: 'Moyen', crans: 0, mediane: 100, echantillon: 50 }],
    ['ferie', { fiable: true, indice: 2, niveau: 'Haut', crans: 1, mediane: 120, echantillon: 20 }]
  ])
  const e = calendrier({ contexte: ctx, debut: '2026-08-01', fin: '2026-09-30',
    positions: pos, positions_jour: pj, evenements: [] }).find(x => x.segment === 'ferie')
  // Le moteur replie sur la position du segment ordinaire : Moyen + 1 = Haut.
  assert.ok(e.niveaux_jour, 'sans le repli, la pastille dirait « Automatique » a cote d un « +1 cran »')
  assert.equal(e.niveaux_jour.lundi, 'Haut', 'Moyen (repli du segment) + 1 cran')
  // Et la structure servie a la fleche replie de la meme facon.
  assert.ok(e.structure_jour, 'la structure doit replier aussi, sinon la fleche ne promet rien')
  assert.equal(e.structure_jour.lundi, 1, 'l indice ordinaire vient du segment')
})

test('la case d un mois SANS periode garde son style', () => {
  // ⚠ Constat de review : la regle .qpb-vide avait disparu avec le bloc des
  // effets, alors que le gabarit l'emet toujours. Une case sans style, c'est
  // une colonne qui se tasse et une frise qui ne s aligne plus.
  const src = sansCommentaires(PAGE())
  assert.match(src, /<span class="qpb-vide"><\/span>/, 'le gabarit emet bien la case vide')
  assert.match(src, /\.qpb-vide \{[^}]*height: 7px/,
    'et la feuille lui donne la meme hauteur qu une bande, sinon la colonne se tasse')
})

test('LE TEST QUI COMPTE : un week-end prolonge porte son nom REEL, et une seule fois', () => {
  // ⚠ DEMANDE DE THIERRY, 28 OCTOBRE 2026. Le serveur nomme cette periode
  // « week-end prolongé (11 novembre) » — un libelle du MOTEUR — et l'ecran
  // redisait « week-end du 11 novembre » dans le detail : le meme fait deux
  // fois, dont une en vocabulaire interne.
  const src = sansCommentaires(PAGE())
  // ⚠ LA REGLE A CHANGE LE 2 NOVEMBRE 2026, ET CETTE ASSERTION A ROUGI : c'est
  // son role. Elle figeait « Week-end du ${e.ferie_voisin} », qui rendait
  // « Week-end du Armistice 1918 » — le nom INTERNE du ferie, faux en francais
  // et etranger a l'hote. Decision de Thierry : une table de libelles
  // d'affichage, a un seul endroit, et le moteur intact.
  // ⚠ LES TROIS CHEMINS PASSENT PAR LA TABLE depuis le 2 novembre 2026 : la
  // ligne du week-end, celle du ferie, et celle du pont. Avant, seule la
  // premiere etait traduite, et l hote lisait « Armistice 1918 » et « pont
  // Armistice 1918 » juste a cote de « Week-end du 11 novembre ».
  assert.match(src, /if \(e\.ferie_voisin\) return titreWeekEnd\(e\.ferie_voisin\)/,
    'la ligne du week-end passe par la table')
  // ⚠ ET LE ROUTAGE SE FAIT PAR LE SEGMENT, PAS PAR LA FORME DU TEXTE — releve
  // en review. Se fier a l absence de la table ne distingue pas l ORIGINE : un
  // evenement de l hote nomme « Noel » se serait affiche « 25 decembre ». Et
  // un prefixe `/^pont /` lu sur du texte attrape les lignes « Pont de
  // l'Ascension » du calendrier scolaire, que seule la casse epargnait.
  assert.match(src, /if \(officiel && e\.segment === 'ferie'\) return titreFerie\(e\.nom\) \|\| e\.nom/,
    'la ligne du ferie se reconnait a son SEGMENT et a son origine officielle')
  assert.match(src, /if \(officiel && e\.segment === 'pont'\)/,
    'la ligne du pont aussi')
  assert.match(src, /const officiel = e\.origine === 'officiel'/,
    'et l origine officielle protege les evenements de l hote')
  assert.match(src, /import \{ titreWeekEnd, titreFerie, titrePont \} from '\/shared\/yield-libelles-feries\.js'/,
    'les trois viennent du module partage, pas d une copie locale')
  // ⚠ ET LA REGLE NE SE RECOMPOSE PAS A LA MAIN A COTE. Une seconde
  // interpolation `Week-end du ${…}` serait une copie qui divergerait.
  assert.doesNotMatch(src, /`Week-end du \$\{/,
    'plus aucune composition manuelle du titre : elle passe par titreWeekEnd')
  // ⚠ ET EN UN SEUL : la frise et la ligne le lisent toutes deux. Deux copies
  // diraient un jour deux noms pour la meme bande et la meme ligne.
  const usages = (src.match(/nomAffiche\(e\)/g) || []).length
  assert.ok(usages >= 2, `la frise ET la ligne doivent lire la meme regle (${usages} usage(s))`)
  // ⚠ UNE ASSERTION MORTE A ETE RETIREE ICI — relevee en review. Elle testait
  // `!/Week-end du \${e.ferie_voisin}/` sur la source PRIVEE de la ligne de
  // `nomAffiche` : le `doesNotMatch` ci-dessus la subsume strictement, et son
  // exemption n'exemptait plus rien puisque cette ligne ne contient plus le
  // motif. Elle ne pouvait plus rougir pour aucune mutation, et se lisait
  // pourtant comme un garde-fou.
  // Le detail ne redit plus le week-end.
  assert.doesNotMatch(src, /· week-end du \$\{/, 'le detail ne doit plus repeter le nom')
  assert.ok(!src.includes('const colle'), 'la variable morte a ete retiree')
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. LES GESTES, ET CE QUI LES GARDE
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : les trois regles gravees des droits sont lues du SERVEUR', () => {
  // Regles de Thierry, 28 octobre 2026 — et elles correspondent exactement a
  // la table DROITS de lib/yield/calendrier-pilotage.js :
  //   · « Supprimer » seulement sur les dates ajoutees par l hote ;
  //   · vacances et jours feries : ni supprimables ni ignorables ;
  //   · fetes du calendrier : « Ne plus en tenir compte » par logement.
  // L ecran ne REDIT pas ces regles : il lit `e.droits`.
  const src = sansCommentaires(PAGE())
  const i = src.indexOf('function ligneHtml')
  const fn = src.slice(i, src.indexOf('\n  }', src.indexOf('qpb-l-${i}')))
  assert.match(fn, /e\.droits\.desactivable/, '« ne plus en tenir compte » suit le droit du serveur')
  assert.match(fn, /e\.droits\.supprimable && e\.id/, '« supprimer » suit le droit du serveur ET exige un id')
  assert.doesNotMatch(fn, /origine === 'declare'|origine === 'officiel'/,
    'l ecran ne doit pas REDIRE la table des droits : une seconde copie divergerait')
})

test('LE TEST QUI COMPTE : « remettre en automatique » n apparait que si l hote a regle', () => {
  // ⚠ Le critere est `crans_ajustes`, PAS `crans` : `crans` vaut la mesure du
  // moteur quand l hote n a rien pose, et le lien n aurait alors rien a
  // defaire. Un bouton qui ne fait rien est un bouton qui ment.
  const src = sansCommentaires(PAGE())
  assert.match(src, /const regleALaMain = e\.crans_ajustes != null/)
  assert.match(src, /regleALaMain \? `<button[^`]*qpb-auto/)
})

test('les fleches bornent a ce que le serveur accepte', () => {
  const bloc = blocRendu()
  assert.match(bloc, /Math\.max\(-max, Math\.min\(max,/,
    'une fleche qui enverrait une valeur refusee serait une fleche qui ment')
  assert.match(bloc, /if \(voulu === actuel\) return/,
    'a la borne, on n envoie rien du tout')
  const src = sansCommentaires(PAGE())
  // ⚠ L ETIQUETTE ANNONCE LE RESULTAT AVANT LE CLIC — spec §0 bis.2, et c'est
  // ce qui remplace « Baisser le prix ». « Toussaint passe a 4 · Tres haut »
  // dit ce que le geste FAIT ; « Baisser le prix » disait seulement son sens.
  // Au telephone, ou l ancien menu −4…+4 n etait pas lisible, c'est la seule
  // facon de savoir ou l on va.
  assert.match(src, /apresLePas\(\{ niveauxJour: e\.niveaux_jour, structure: e\.structure_jour,/,
    'les deux fleches passent par le meme calcul, et lui donnent la STRUCTURE')
  assert.match(src, /crans: c, cransMax: max(, pose: regleALaMain)? \}, sens\)/,
    'le pas se calcule sur les crans, pas sur les niveaux affiches')
  // ⚠ ET LE SERVEUR DOIT LA SERVIR, sinon la fleche ne promet rien.
  assert.match(lire('lib/yield/calendrier-pilotage.js'), /e\.structure_jour = structureDuJour\(p\)/,
    'la structure ordinaire par jour voyage avec la periode')
  assert.match(src, /passe à \$\{r\.apres\}/, 'l etiquette annonce le niveau d arrivee')
  assert.match(src, /impossible : \$\{r\.raison\}/,
    'et a la borne, elle DIT pourquoi — un bouton qui ne fait rien sans le dire est un bouton qui ment')
  assert.match(src, /\$\{r\.possible \? '' : ' disabled'\}/, 'le bouton est reellement desactive')
})

test('le formulaire est DERRIERE un bouton, ferme au premier rendu', () => {
  const bloc = blocRendu()
  assert.match(bloc, /<details class="qpb-ajout"/,
    'l ajout doit etre replie : un formulaire toujours deplie pousse la liste hors de l ecran')
  // ⚠ FERME AU PREMIER RENDU, ET ROUVERT SEULEMENT SI UN BROUILLON L'ATTEND.
  // L'assertion ne peut plus etre « aucun `open` » depuis que le refus
  // conserve la saisie (review du 28 octobre) : c'est le CONTRAT qu'on
  // affirme — l'etat de depart est ferme, et l'ouverture est conditionnelle.
  assert.match(bloc, /\$\{b\.ouvert \? ' open' : ''\}/,
    'l ouverture doit etre CONDITIONNELLE, jamais posee en dur')
  assert.match(sansCommentaires(PAGE()), /let brouillonAjout = \{ ouvert: false/,
    'et l etat de depart est ferme')
  assert.match(bloc, /\+ Ajouter une période/)
})

test('la lecture seule retire les gestes et garde les faits', () => {
  const src = sansCommentaires(PAGE())
  const i = src.indexOf('function ligneHtml')
  // ⚠ 6000 et non plus 3000 : la review de la chaine (8 novembre 2026) a
  // ajoute le reglage partage et la cle du retrait avant `gestes`.
  const fn = src.slice(i, i + 6000)
  assert.match(fn, /const gestes = lecture \? '' :/, 'les reglages disparaissent en lecture seule')
  assert.match(fn, /const menu = lecture \|\|/, 'le menu ⋯ disparait en lecture seule')
  const bloc = blocRendu()
  assert.match(bloc, /const ajout = lecture \? '' :/, 'l ajout disparait en lecture seule')
  // Mais la ligne, elle, reste : les faits ne se cachent pas.
  // ⚠ CE QUI RESTE LISIBLE A CHANGE DE NOM, PAS DE NATURE : l ecran ne montre
  // plus un « effet » mais LE NIVEAU de la grille. Le fait reste, et il reste
  // visible sans droit d ecriture.
  assert.match(fn, /qpb-niveau/, 'le niveau reste lisible en lecture seule')
  assert.doesNotMatch(fn, /qpb-effet/, 'l ancienne pastille d effet n existe plus')
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. LES HUIT CONSTATS DE LA REVIEW DU 28 OCTOBRE 2026
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : aucune periode ne se perd, aux DEUX bouts de la fenetre', () => {
  // ⚠ LE CONSTAT LE PLUS GRAVE DU LOT. La frise a douze colonnes, mais la
  // fenetre du serveur va d'aujourd'hui a aujourd'hui + 1 an : elle TOUCHE un
  // treizieme mois. Une periode qui y commence tombait dans aucun groupe et
  // DISPARAISSAIT — ni reglable, ni supprimable, alors qu'elle pese sur les
  // prix. Le cas le plus couteux : une date commerciale COUPEE tombant la,
  // que `api/yield-evenements.js` repousse exprès dans la liste « parce que
  // les retirer aurait rendu la desactivation IRREVERSIBLE depuis
  // l'interface » — et que ce filtre reperdait.
  const src = sansCommentaires(PAGE())
  assert.match(src, /if \(m < premierMois\) return premierMois/,
    'ce qui commence avant la fenetre va au premier mois — un rattachement VRAI')
  // ⚠ CE TEST EXIGEAIT L INVERSE JUSQU AU 3 NOVEMBRE 2026, et c'est la lecon.
  // Il demandait `if (m > dernierMois) return dernierMois` — le repli — pour
  // qu aucune periode ne se perde. L intention etait juste ; le moyen etait un
  // FAIT FAUX : une periode d octobre 2027 se rangeait sous septembre. Le
  // repli etait une solution d AFFICHAGE appliquee a une question de
  // RATTACHEMENT.
  //
  // Maintenant : la frise porte les 13 mois que la fenetre touche, donc il n y
  // a plus rien a replier. Et s il restait une entree au-dela, elle n est PAS
  // rangee de force — c'est le controle de compte qui crie.
  assert.match(src, /if \(m > dernierMois\) return null/,
    'plus de repli par le haut : on ne range pas une periode sous un mois ou elle n a aucun jour')
  assert.match(src, /if \(m && parMois\.has\(m\)\) parMois\.get\(m\)\.push/,
    'une entree hors fenetre n est pas posee — et le compte, juste dessous, le dira')
  // Et le compte retombe sur ses pieds, avec une alarme si ce n'est pas le cas.
  assert.match(src, /const posees = \[\.\.\.parMois\.values\(\)\]\.reduce/,
    'le nombre de lignes posees se compte')
  assert.match(src, /periode\(s\) perdue\(s\) a l affichage/,
    'et une perte se DIT, au lieu de passer inapercue')
  // La frise aussi : sa derniere colonne porte ce qui deborde.
  assert.match(src, /const finMois = dernier \? '9999-12-31'/,
    'sinon une bande manquerait a la frise pour une ligne qui existe')
})

test('LE TEST QUI COMPTE : la mesure du moteur est ATTEIGNABLE', () => {
  // ⚠ « (+2 aujourd'hui) » ne pouvait JAMAIS s'afficher. Sa condition etait
  // `auto && crans_mesures != null`, or `auto` vaut `crans == null` et
  // `lib/yield/calendrier-pilotage.js` pose
  // `crans = crans_ajustes ?? crans_mesures` : `crans == null` IMPLIQUE
  // `crans_mesures == null`. La condition etait une contradiction.
  const src = sansCommentaires(PAGE())
  assert.match(src, /!regleALaMain && e\.crans_mesures != null/,
    'la mesure se montre quand l hote n a rien pose ET que le moteur a mesure')
  assert.doesNotMatch(src, /auto && e\.crans_mesures != null/,
    'l ancienne condition etait inatteignable')
  // Et la contradiction se prouve : `crans` DERIVE de `crans_mesures`.
  const moteur = lire('lib/yield/calendrier-pilotage.js')
  assert.match(moteur, /e\.crans = e\.crans_ajustes != null \? e\.crans_ajustes : e\.crans_mesures/,
    'si cette regle change, la condition de l ecran est a revoir')
})

test('LE TEST QUI COMPTE : un `null` dit POURQUOI', () => {
  // ⚠ docs/kb/restitution-yield.md : un `null` s'affiche « non calculable »
  // AVEC son motif. L'ecran disait « Automatique » dans les quatre cas — y
  // compris `grille_indisponible`, ou l'endpoint journalise la panne et
  // repond 200 : les 35 periodes reviennent a `null`, et l'hote concluait que
  // le pilote s'en occupait.
  const src = sansCommentaires(PAGE())
  assert.match(src, /const NON_CALCULABLE = \{/, 'la table des motifs existe')
  for (const motif of ['grille_indisponible', 'reference_ordinaire_mince',
    'pas_d_historique_propre', 'date_desactivee']) {
    assert.ok(src.includes(motif), `le motif ${motif} doit etre traduit`)
  }
  // ⚠ ET LA LISTE EST CELLE DU MOTEUR, pas une liste recopiee : si le moteur
  // en ajoute un, ce test le dira.
  const moteur = lire('lib/yield/calendrier-pilotage.js')
  const duMoteur = [...moteur.matchAll(/'(grille_indisponible|reference_ordinaire_mince|pas_d_historique_propre)'/g)]
    .map(m => m[1])
  assert.ok(duMoteur.length >= 3, 'les motifs du moteur sont introuvables : ce test ne mesure plus rien')
  for (const m of new Set(duMoteur)) {
    assert.ok(src.includes(m), `le moteur sert « ${m} » et l ecran ne le traduit pas`)
  }
  assert.match(src, /const motif = \(c == null && !coupe\)/,
    'le motif ne s affiche que sur un null, et pas sur une periode coupee')
})

test('un refus ne perd pas ce que l hote a tape', () => {
  // ⚠ `rendrePopup(message)` reconstruit toute la fenetre : le formulaire
  // revenait FERME et VIDE. L hote tapait « Festival de jazz », oubliait une
  // date, et perdait son texte avec le refus.
  const src = sansCommentaires(PAGE())
  assert.match(src, /let brouillonAjout = /, 'le brouillon existe')
  assert.match(src, /brouillonAjout = \{ ouvert: true, nom: corps\.nom/,
    'il se releve AVANT l envoi : c est le refus qui doit le retrouver')
  assert.match(src, /\$\{b\.ouvert \? ' open' : ''\}/,
    'le formulaire se rouvre quand un brouillon l attend')
  assert.match(src, /value="\$\{ech\(b\.nom \|\| ''\)\}"/, 'et le nom y revient')
  // Un ajout REUSSI, lui, vide le brouillon.
  const i = src.indexOf('async function ajouterEvenement')
  const fn = src.slice(i, src.indexOf('async function reconduireEvenement'))
  assert.match(fn, /brouillonAjout = \{ ouvert: false[\s\S]*rechargerEvenements/,
    'un ajout reussi vide le brouillon avant de recharger')
})

test('le bouton qui ouvre l ecran, et son etiquette, parlent du BON ecran', () => {
  const src = PAGE()
  assert.match(src, /id="yp-ouvrir-ev"[^>]*>Quand vos prix bougent</,
    'le bouton porte le nom de l ecran')
  assert.match(src, /id="yp-ov-ev" role="dialog" aria-modal="true" aria-label="Quand vos prix bougent"/,
    'un lecteur d ecran annoncait « Evenements » : un nom que la fenetre ne porte plus')
  assert.doesNotMatch(src, /title="Le calendrier du mois/,
    'l infobulle promettait un calendrier que ce lot retire')
})

test('`moisLong` rend bien le mois LONG — son nom ne doit pas mentir', () => {
  const src = sansCommentaires(PAGE())
  const i = src.indexOf('const MOIS_LONG =')
  const j = src.indexOf('async function rendrePopup')
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(src.slice(i, j) + '\nglobalThis.M = moisLong', ctx)
  assert.equal(ctx.M('2026-10'), 'octobre 2026',
    'le nom annoncait le contraire de ce que la fonction faisait')
  assert.equal(ctx.M('2027-02'), 'février 2027')
})

test('LE TEST QUI COMPTE : `private, no-store` AVANT le premier refus de yield-evenements', () => {
  // ⚠ La case performance de la spec s'y etait ENGAGEE, et je ne l avais pas
  // fait. Cette reponse porte DOUZE MOIS de reglages tarifaires d un compte
  // en un seul appel depuis ce lot : sur le defaut de Vercel
  // (`public, max-age=0, must-revalidate`), un cache partage est AUTORISE a
  // la stocker.
  const src = lire('api/yield-evenements.js')
  const i = src.indexOf('module.exports = async (req, res) => {')
  const j = src.indexOf('return res.status(400)')
  assert.ok(i > 0 && j > i, 'le handler est introuvable')
  const avantLePremierRefus = src.slice(i, j)
  assert.match(avantLePremierRefus, /res\.setHeader\('cache-control', 'private, no-store'\)/,
    'l en-tete doit etre pose avant le PREMIER refus, pas avant la garde')
  assert.match(avantLePremierRefus, /res\.setHeader\('vary', 'authorization, x-compte'\)/,
    'la reponse depend du jeton ET du compte choisi')
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. LA FENETRE PASSE AU-DESSUS DU ☰
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : la fenetre passe au-dessus du bouton ☰ de la barre laterale', () => {
  // ⚠ MESURE DU 28 OCTOBRE 2026 : `components/sidebar.js` pose son ☰ en
  // `position: fixed` avec un `z-index: 1000` EN LIGNE. La fenetre etait a 60,
  // donc le ☰ passait par-dessus elle au telephone et mangeait son titre.
  const sidebar = lire('components/sidebar.js')
  const m = sidebar.match(/z-index:\s*(\d+);[\s\S]{0,400}?sidebar-toggle|sidebar-toggle[\s\S]{0,400}?z-index:\s*(\d+)/)
  assert.ok(m, 'le z-index du ☰ est introuvable : ce test ne garde plus rien')
  const zBouton = Number(m[1] || m[2])
  assert.ok(zBouton >= 1000, `le ☰ est a ${zBouton}, la mesure du lot disait 1000`)
  const page = sansCommentaires(PAGE())
  const r = page.match(/\.yp-ov \{[^}]*z-index:\s*(\d+)/)
  assert.ok(r, 'le z-index de la fenetre est introuvable')
  assert.ok(Number(r[1]) > zBouton,
    `la fenetre (${r[1]}) doit passer AU-DESSUS du ☰ (${zBouton}) : une modale est au-dessus de la chrome de la page`)
})

// ─── Review de la chaine YieldFlow, 8 novembre 2026 ───────────────────────────
test('LE TEST QUI COMPTE (review de la chaine) : une MESURE au-dela de ±2 — la fleche annonce le pas que le clic fera', async () => {
  // Le clic envoie clamp(c + sens, ±2). Un ferie mesure a +4 (structure a
  // Base) que l on baisse recoit 2 : DEUX crans de descente, pas un.
  const M = await import('../shared/yield-niveau-periode.js')
  const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
  const base = Object.fromEntries(JOURS.map(j => [j, 0]))
  const bas = M.apresLePas({ structure: base, crans: 4, cransMax: 2, pose: false }, -1)
  assert.deepEqual([bas.possible, bas.pas, bas.apres], [true, -2, '3 · Haut'])
  const haut = M.apresLePas({ structure: base, crans: 4, cransMax: 2, pose: false }, 1)
  assert.equal(haut.possible, false, '▲ enverrait 2, donc une BAISSE : refuse')
  assert.match(haut.raison, /mesure déjà \+4 crans/, 'avec la vraie raison, pas « le reglage est au maximum » quand rien n est pose')
  // Le miroir a −4 : structure a Exceptionnel.
  const exc = Object.fromEntries(JOURS.map(j => [j, 4]))
  const monte = M.apresLePas({ structure: exc, crans: -4, cransMax: 2, pose: false }, 1)
  assert.deepEqual([monte.possible, monte.pas, monte.apres], [true, 2, '3 · Haut'])
  assert.equal(M.apresLePas({ structure: exc, crans: -4, cransMax: 2, pose: false }, -1).possible, false)
  // Un reglage POSE a la borne garde son ancienne raison.
  assert.match(M.apresLePas({ structure: base, crans: 2, cransMax: 2, pose: true }, 1).raison, /déjà au maximum \(2 crans\)/)
  // Et l ecran dit le pas reel.
  const src = sansCommentaires(PAGE())
  assert.match(src, /const combien = n > 1 \? `de \$\{n\} crans` : 'd’un cran'/)
})

test('LE TEST QUI COMPTE (review de la chaine) : pas de fleches sur une periode COUPEE ; « remettre en automatique » vise la cle qui porte le reglage ; un reglage partage se dit', () => {
  const src = sansCommentaires(PAGE())
  assert.match(src, /\$\{coupe \? '' : `<div class="qpb-regl">/, 'une periode coupee n a pas de fleches')
  assert.match(src, /const cleAuto = e\.cle_reglage \|\| e\.cle/)
  assert.match(src, /data-ev-auto="\$\{ech\(cleAuto\)\}"/, 'le retrait vise la cle qui porte le reglage')
  assert.doesNotMatch(src, /data-ev-auto="\$\{ech\(e\.cle\)\}"/)
  assert.match(src, /e\.cle === 'week_end_prolonge' \? 'tous les week-ends prolongés'/, 'les week-ends prolonges partagent un seul reglage, et l etiquette le dit')
  assert.match(src, /const dit = e\.actif === false \? 'Pas prise en compte'/, 'la frise dit comme la ligne')
})
