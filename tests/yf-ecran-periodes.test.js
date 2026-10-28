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

test('les douze mois sont GROUPES, et il y en a douze, pas treize', () => {
  const bloc = blocRendu()
  assert.match(bloc, /moisListe\.length < 12/,
    'la fenetre du serveur TOUCHE un treizieme mois : la frise doit s arreter a douze')
  assert.match(bloc, /qpb-mois/, 'les periodes doivent etre groupees par mois')
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

test('LE TEST QUI COMPTE : un seul code couleur — l origine n en est plus une', () => {
  const src = PAGE()
  // ⚠ L'ancien ecran avait DEUX codes : le fond disait le niveau de prix, le
  // contour disait l'origine, et rien ne disait qu'il y en avait deux.
  assert.doesNotMatch(src, /EV_COULEUR/,
    'la table de couleurs par origine doit avoir disparu')
  assert.doesNotMatch(src, /#2A5E86|#7A3E9A|#1F6F45/,
    'les trois hexas d origine doivent avoir disparu')
  // Les quatre etats d'effet, et eux seuls.
  for (const etat of ['e-monte', 'e-baisse', 'e-normal', 'e-inconnu']) {
    assert.ok(src.includes(etat), `l etat ${etat} manque`)
  }
})

test('LE TEST QUI COMPTE : les trois couleurs reservees sont respectees', () => {
  // Decisions de Thierry, 28 octobre 2026 : le NOIR a la navigation, l AMBRE
  // a « ce que HoteSmart a fait pour vous », le BLEU a ce qui est CLIQUABLE.
  const src = sansCommentaires(PAGE())
  const regle = (sel) => {
    const m = src.match(new RegExp('\\' + sel + '[^{]*\\{([^}]*)\\}'))
    return m ? m[1] : ''
  }
  assert.match(regle('.qpb-effet.e-baisse'), /var\(--prune\)/,
    '« moins chers » doit etre prune : ni ambre (reserve), ni bleu (reserve au cliquable)')
  assert.doesNotMatch(regle('.qpb-effet.e-baisse'), /--amber|--blue/,
    '« moins chers » ne doit porter ni l ambre ni le bleu')
  assert.match(regle('.qpb-btn-plein'), /var\(--blue\)/,
    'une action est bleue, jamais noire')
  assert.doesNotMatch(regle('.qpb-btn-plein'), /var\(--text\)\s*;/,
    'le noir est reserve a la navigation')
  // Et les jetons existent la ou vivent leurs voisins.
  const feuille = lire('public/style.css')
  for (const jeton of ['--blue:', '--prune:', '--prune-bg:']) {
    assert.ok(feuille.includes(jeton), `${jeton} manque a public/style.css`)
  }
  // ⚠ `--blue-bg` A ETE RETIRE : il n'etait reference nulle part (review du
  // 28 octobre). Un jeton inutilise se recopie et se maintient pour rien.
  assert.ok(!feuille.includes('--blue-bg'), 'un jeton inutilise ne revient pas')
  // ⚠ ET LE DOUBLON AVEC `theme.css` EST DIT, pas tu : ces pages ne chargent
  // pas le socle V5, donc sans ce jeton elles n'auraient aucun bleu.
  assert.match(feuille, /OUI, C'EST LA MEME VALEUR QUE `--info`/,
    'un doublon assume se commente, sinon la prochaine review le « corrige »')
  assert.ok(feuille.includes('#5B2A86'), 'le prune demande est #5B2A86')
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
  const k = src.indexOf('const EFFET_MOT =')
  const l = src.indexOf('const ORIGINE_MOT =')
  assert.ok(k > 0 && l > k, 'la table des effets est introuvable')
  const ctx = { assert }
  vm.createContext(ctx)
  vm.runInContext(src.slice(i, j) + '\n' + src.slice(k, l)
    + '\nglobalThis.O = { periodeEnLettres, effetClasse, effetMot }', ctx)
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

test('LE TEST QUI COMPTE : `null` n est pas 0 — deux etats, deux mots, deux couleurs', () => {
  const { effetClasse, effetMot } = outils()
  // ⚠ « Automatique » veut dire « l hote laisse le moteur decider » ;
  // « prix normaux » est un reglage qu il a POSE. Les confondre afficherait
  // un reglage la ou il n y en a pas.
  assert.equal(effetClasse(null), 'inconnu')
  assert.equal(effetMot(null), 'Automatique')
  assert.equal(effetClasse(0), 'normal')
  assert.equal(effetMot(0), 'prix normaux')
  assert.notEqual(effetClasse(null), effetClasse(0))
  assert.notEqual(effetMot(null), effetMot(0))
})

test('les cinq etats de l amplitude, et PAS un de plus', () => {
  const { effetClasse, effetMot } = outils()
  // ⚠ L amplitude du moteur s arrete a DEUX (`AMPLITUDE_MAX = 2`) : il n y a
  // que « un peu » et « nettement ». Un troisieme degre serait refuse par le
  // serveur — decision de Thierry du 28 octobre : on ne touche pas au moteur.
  assert.equal(effetMot(1), 'un peu plus chers')
  assert.equal(effetMot(2), 'nettement plus chers')
  assert.equal(effetMot(-1), 'un peu moins chers')
  assert.equal(effetMot(-2), 'nettement moins chers')
  assert.equal(effetClasse(2), 'monte')
  assert.equal(effetClasse(-2), 'baisse')
  // Le mot ne contient jamais « beaucoup » : ce degre n existe pas.
  for (const c of [-2, -1, 0, 1, 2, null]) {
    assert.doesNotMatch(String(effetMot(c)), /beaucoup/,
      'un troisieme degre serait refuse par le serveur')
  }
})

test('LE TEST QUI COMPTE : un week-end prolonge porte son nom REEL, et une seule fois', () => {
  // ⚠ DEMANDE DE THIERRY, 28 OCTOBRE 2026. Le serveur nomme cette periode
  // « week-end prolongé (11 novembre) » — un libelle du MOTEUR — et l'ecran
  // redisait « week-end du 11 novembre » dans le detail : le meme fait deux
  // fois, dont une en vocabulaire interne.
  const src = sansCommentaires(PAGE())
  assert.match(src, /const nomAffiche = \(e\) => e\.ferie_voisin \? `Week-end du \$\{e\.ferie_voisin\}` : e\.nom/,
    'le nom affiche se decide en UN endroit')
  // ⚠ ET EN UN SEUL : la frise et la ligne le lisent toutes deux. Deux copies
  // diraient un jour deux noms pour la meme bande et la meme ligne.
  const usages = (src.match(/nomAffiche\(e\)/g) || []).length
  assert.ok(usages >= 2, `la frise ET la ligne doivent lire la meme regle (${usages} usage(s))`)
  assert.ok(!/Week-end du \$\{e\.ferie_voisin\}/.test(src.replace(/const nomAffiche[^\n]*\n/, '')),
    'aucune seconde copie de la regle de nommage')
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
  assert.match(src, /aria-label="Baisser le prix/, 'la fleche bas se dit')
  assert.match(src, /aria-label="Monter le prix/, 'la fleche haut se dit')
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
  const fn = src.slice(i, i + 3000)
  assert.match(fn, /const gestes = lecture \? '' :/, 'les reglages disparaissent en lecture seule')
  assert.match(fn, /const menu = lecture \|\|/, 'le menu ⋯ disparait en lecture seule')
  const bloc = blocRendu()
  assert.match(bloc, /const ajout = lecture \? '' :/, 'l ajout disparait en lecture seule')
  // Mais la ligne, elle, reste : les faits ne se cachent pas.
  assert.match(fn, /qpb-effet/, 'l effet reste lisible en lecture seule')
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
    'ce qui commence avant la fenetre va au premier mois')
  assert.match(src, /if \(m > dernierMois\) return dernierMois/,
    'ce qui commence apres va au dernier — c est le bout qui manquait')
  assert.doesNotMatch(src, /if \(parMois\.has\(m\)\) parMois\.get\(m\)\.push/,
    'plus aucun `has()` : une entree hors des douze mois serait silencieusement jetee')
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
