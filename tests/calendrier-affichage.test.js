// tests/calendrier-affichage.test.js
// Retouches UI du planning desktop (16 septembre 2026) :
//   1. plus de pastille OTA dans la bulle
//   2. la page defile verticalement, en-tetes de dates collants
//   3. navigation dans le passe + sejours termines grises
//
// `computeDays` est PURE : elle est testee pour de vrai, pas par lecture de
// fichier. Le reste vit dans du CSS et du HTML, lu comme le font deja les
// autres tests du calendrier.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const lire = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
// ⚠ LES COMMENTAIRES CSS AUSSI — re-review du 21 septembre 2026 : une regle
// `table.cal { table-layout: fixed }` avalee par un `/*` jamais ferme passait
// tous les tests au vert. Une regex sur la source ne distingue pas une regle
// vivante d'une regle commentee : on retire les blocs AVANT de matcher.
const sansCommentaires = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
const PAGE_BRUTE = lire('pages', 'biens-calendrier.html')
const PAGE = sansCommentaires(PAGE_BRUTE)
const MOBILE = lire('pages', 'calendrier-mobile.html')
const CORE = lire('shared', 'calendar-core.js')

// Le module est en ESM et importe api-client : on evalue son corps sans
// l'import pour recuperer les fonctions pures. `loadCalendarData` reference
// `api`, mais on ne l'appelle pas — sa definition seule ne l'evalue pas.
const noyau = (() => {
  const src = CORE.replace(/^import .*$/m, '').replace(/^export /gm, '')
  return new Function(src + '\n; return { computeDays, toISO, CELL_W }')()
})()

// ═══════════════════════════════════════════════════════════════════════════
// 1. LA PASTILLE OTA A DISPARU DE LA BULLE
// ═══════════════════════════════════════════════════════════════════════════

test('bulle : plus de logo OTA — il mangeait la place du nom', () => {
  // Sur une bulle d'une nuit, la pastille faisait disparaitre le nom
  // entierement, sans rien apprendre que la couleur ne disait deja.
  assert.ok(!/platformLogo\(/.test(PAGE), 'plus aucun appel au logo')
  assert.ok(!/class="ava"/.test(PAGE), 'plus de conteneur de pastille')
  assert.ok(!/\.resa-bar \.ava/.test(PAGE), 'plus de style de pastille')
})

test('bulle : le nom reste le seul contenu, et le rembourrage est symetrique', () => {
  // Le retrait a gauche (padding 0 8px 0 4px) n'existait que pour loger la
  // pastille : le garder aurait decale le nom sans raison.
  const bloc = PAGE.slice(PAGE.indexOf('function barresResa'), PAGE.indexOf('function renderBienBlock'))
  assert.match(bloc, /<span class="nom">'\+nameShort\+'<\/span>/)
  assert.match(PAGE, /\.resa-bar \{[^}]*padding: 0 9px/)
})

test('la source reste lisible dans la FICHE', () => {
  // On retire un affichage, pas une information.
  assert.match(PAGE, /ligneFiche\('Canal', canal\)/)
})

test('DESKTOP SEUL : la grille mobile garde sa pastille', () => {
  assert.ok(MOBILE.includes('platformLogo'), 'le mobile n\'affiche pas le meme contenu')
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. LA PAGE DEFILE, LES EN-TETES RESTENT
// ═══════════════════════════════════════════════════════════════════════════

test('mise en page : la zone calendrier defile au lieu d\'etre coupee', () => {
  // ⚠ REGRESSION FERMEE. `.layout` est height:100vh / overflow:hidden et
  // `.main` est overflow:hidden (public/style.css) : dans ce gabarit, seul
  // `.content` porte flex:1 + overflow-y:auto. Cette page utilise `.cal-main`,
  // qui n'avait ni l'un ni l'autre — a partir de 3-4 biens, le bas de page
  // etait coupe et INACCESSIBLE, sans barre de defilement.
  assert.match(PAGE, /\.cal-main \{[^}]*flex: 1/)
  assert.match(PAGE, /\.cal-main \{[^}]*min-height: 0/,
    'sans min-height:0, un enfant flex ne descend pas sous son contenu')
  assert.match(PAGE, /\.scroll-area \{[^}]*overflow: auto/)
  assert.match(PAGE, /\.scroll-shell \{[^}]*flex: 1/)
  assert.ok(!/\.cal-main \{[^}]*padding-bottom: 100px/.test(PAGE),
    'le faux espace du bas est remplace par un vrai defilement')
})

test('mise en page : le dernier bien n\'est pas cache par la barre flottante', () => {
  assert.match(PAGE, /#blocks \{ padding-bottom: 96px/)
})

test('en-tetes : deux etages collants, le second SOUS le premier', () => {
  // La bande des mois a 0, la ligne des jours a sa hauteur. Le second `top`
  // doit etre non nul, sinon les deux se superposent.
  assert.match(PAGE, /#month-band-wrap \{[^}]*position: sticky; top: 0/)
  // ⚠ 74 px depuis le 21 septembre 2026 : la bande porte les mois ET la ligne
  // des jours (27 + 46 + 1 de trait). Un chiffre faux ferait glisser les theads
  // des biens sous la bande.
  assert.match(PAGE, /--bande-h: 74px/)
  assert.match(PAGE, /table\.cal thead th \{[^}]*position: sticky; top: var\(--bande-h\)/)
  assert.match(PAGE, /table\.cal thead \.row-label \{[^}]*top: var\(--bande-h\)/,
    'l\'angle du bien cumule les deux ancrages')
})

test('en-tetes : fond opaque, sinon le contenu defile visiblement dessous', () => {
  assert.match(PAGE, /table\.cal thead th \{[^}]*background: #fff/)
  assert.match(PAGE, /table\.month-band td \{[^}]*background: #fff/)
  assert.match(PAGE, /#month-band-wrap \{[^}]*width: max-content/,
    'sinon le fond de la bande s\'arrete a la largeur visible')
})

test('colonne figee : le libelle passe AU-DESSUS des bulles', () => {
  // ⚠ Les bulles portent z-index 2 et vivent toutes dans la PREMIERE cellule,
  // juste a droite de la colonne figee. A egalite, le dernier du DOM gagne :
  // la bulle recouvrait le libelle des qu'on defilait horizontalement.
  assert.match(PAGE, /table\.cal \.row-label \{[^}]*z-index: 3/)
  assert.ok(!/table\.cal \.row-label \{[^}]*z-index: 2/.test(PAGE))
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. LE PASSE
// ═══════════════════════════════════════════════════════════════════════════

test('computeDays : le decalage deplace REELLEMENT le depart de la grille', () => {
  const { computeDays, toISO } = noyau
  const aujourdhui = toISO(new Date())
  const avant = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return toISO(d) }

  assert.strictEqual(toISO(computeDays(1, 0)[0]), aujourdhui, 'sans decalage : aujourd\'hui')
  assert.strictEqual(toISO(computeDays(1, 0, -30)[0]), avant(-30), 'un mois en arriere')
  assert.strictEqual(toISO(computeDays(1, 0, 30)[0]), avant(30), 'un mois en avant')
})

test('computeDays : le decalage ne change ni le nombre de jours ni leur continuite', () => {
  const { computeDays, toISO } = noyau
  const a = computeDays(3, 1200), b = computeDays(3, 1200, -60)
  assert.strictEqual(a.length, b.length, 'meme fenetre, seulement deplacee')
  for (let i = 1; i < b.length; i++) {
    const ecart = (b[i] - b[i - 1]) / 86400000
    assert.strictEqual(Math.round(ecart), 1, `jours consecutifs (${toISO(b[i - 1])} -> ${toISO(b[i])})`)
  }
})

test('computeDays : une valeur de decalage aberrante ne casse pas la grille', () => {
  const { computeDays, toISO } = noyau
  const aujourdhui = toISO(new Date())
  for (const v of [undefined, null, NaN, 'abc', Infinity]) {
    assert.strictEqual(toISO(computeDays(1, 0, v)[0]), aujourdhui, `repli sur aujourd'hui pour ${String(v)}`)
  }
})

test('le jour courant est trouve par DATE, plus par position', () => {
  // ⚠ `isToday(i){ return i===0 }` etait juste tant qu'on ne naviguait pas.
  // Des le premier pas dans le passe, il peignait le repere bleu sur une date
  // quelconque — celle du bord gauche de l'ecran.
  assert.match(PAGE, /function isToday\(i\)\{ return toISO\(days\[i\]\)===ISO_AUJOURDHUI \}/)
  assert.ok(!/function isToday\(i\)\{ return i===0 \}/.test(PAGE))
  // Et la date du jour est relue a chaque construction : un onglet laisse
  // ouvert toute la nuit doit reperer le bon jour au matin.
  const bloc = PAGE.slice(PAGE.indexOf('function buildDays'), PAGE.indexOf('function isMonthStart'))
  assert.ok(bloc.includes('ISO_AUJOURDHUI=toISO(new Date())'))
})

test('navigation : trois boutons, et « Aujourd\'hui » s\'eteint quand on y est', () => {
  assert.match(PAGE, /id="btn-passe"/)
  assert.match(PAGE, /id="btn-futur"/)
  assert.match(PAGE, /id="btn-aujourdhui"/)
  assert.match(PAGE, /function majBoutonsPeriode/)
  assert.match(PAGE, /b\.disabled = \(DECALAGE===0\)/)
})

test('navigation : la grille est REBATIE, les etats ne survivent pas au decalage', () => {
  // `states` est indexe par POSITION dans `days` : le garder apres un
  // deplacement ferait lire les tarifs d'un jour sur un autre.
  assert.match(PAGE, /async function rebatirGrille/)
  const bloc = PAGE.slice(PAGE.indexOf('async function rebatirGrille'), PAGE.indexOf("document.getElementById('period-select')"))
  assert.ok(bloc.includes('Object.keys(states).forEach(k=>delete states[k])'), 'les etats sont jetes')
  assert.ok(bloc.includes('reloadInventory'), 'et l\'inventaire relu sur la nouvelle plage')
  // Changement de periode et deplacement passent par le MEME chemin.
  assert.strictEqual((PAGE.match(/rebatirGrille\(\)/g) || []).length, 4,
    'periode + passe + futur + retour a aujourd\'hui')
})

test('navigation : le decalage n\'est PAS persiste', () => {
  // Rouvrir le calendrier doit ramener sur aujourd'hui. Un hote qui retrouverait
  // sa fenetre trois mois en arriere lirait un planning « vide » et le croirait
  // casse.
  const bloc = PAGE.slice(PAGE.indexOf('function savePrefsD'), PAGE.indexOf('function loadPrefsD'))
  assert.ok(!bloc.includes('DECALAGE'), 'le decalage ne va pas dans les preferences')
})

test('sejours termines : grises, mais toujours consultables', () => {
  // On recule visuellement un sejour fini ; on ne le masque pas et on ne le
  // rend pas inerte — il se consulte pour un litige, une facture, un avis.
  assert.match(PAGE, /function resaPassee\(bk\)\{ return bk\.checkout <= ISO_AUJOURDHUI \}/)
  assert.match(PAGE, /\.resa-bar\.passee \{ opacity: 0\.45/)
  assert.match(PAGE, /\.resa-bar\.passee:hover \{ opacity: 0\.9/, 'lisible au survol')
  const bloc = PAGE.slice(PAGE.indexOf('function barresResa'), PAGE.indexOf('function renderBienBlock'))
  assert.ok(bloc.includes("(passee?' passee':'')"), 'la classe est posee')
  assert.ok(bloc.includes('séjour terminé'), 'et dite dans l\'infobulle')
  // La classe `cliquable` ne depend pas de `passee` : la fiche reste ouvrable.
  assert.ok(bloc.includes("(bk.id?' cliquable':'')"))
})

test('sejours termines : la nuit de DEPART ne compte pas comme occupee', () => {
  // Regle des nuits (docs/kb/reservation-directe.md §3) : un sejour 12->15
  // occupe 12, 13 et 14. Le 15, il est fini — d'ou `<=` et non `<`.
  assert.match(PAGE, /bk\.checkout <= ISO_AUJOURDHUI/)
})

test('passe : on y regarde, on n\'y ecrit pas', () => {
  // ⚠ CONTREPARTIE DE LA NAVIGATION. Avant elle, aucune cellule passee ne
  // pouvait etre selectionnee — elles n'etaient pas a l'ecran. Ouvrir le passe
  // sans cette garde, c'est permettre qu'une selection tiree un peu trop loin
  // pousse des tarifs sur des nuits ecoulees, vers le canal, pour rien.
  assert.match(PAGE, /function jourPasse\(i\)\{ return toISO\(days\[i\]\) < ISO_AUJOURDHUI \}/)
  const bloc = PAGE.slice(PAGE.indexOf('function renderBienBlock'), PAGE.indexOf('let isDragging'))
  assert.ok(bloc.includes("if(editable&&!jourPasse(i))c.unshift('edit-cell')"),
    'une cellule passee ne recoit pas la classe qui la rend selectionnable')
  assert.match(PAGE, /table\.cal td\.jour-passe/, 'et elle se distingue a l\'œil')
})

test('passe : AUJOURD\'HUI reste modifiable', () => {
  // `<` et non `<=` : la nuit du jour se vend encore.
  assert.ok(!/toISO\(days\[i\]\) <= ISO_AUJOURDHUI/.test(PAGE))
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. CE QUE LA REVIEW A FERME
// ═══════════════════════════════════════════════════════════════════════════

test('passe : le CLIQUER-GLISSER ne peut pas atteindre le passe non plus', () => {
  // ⚠ REGRESSION FERMEE, et elle rendait la garde precedente decorative.
  // Retirer `edit-cell` empechait seulement de DEMARRER sur une cellule passee.
  // Partir d'un jour futur et glisser vers la gauche remplissait `sel.idx` de
  // tout l'intervalle, jours passes compris — et de facon INVISIBLE, puisque
  // `updateSelectionUI` ne peint que les `edit-cell`. Tout ce qui consomme
  // `sel.idx` ensuite ecrivait sur des nuits ecoulees.
  const bloc = PAGE.slice(PAGE.indexOf('function extendSelTo'), PAGE.indexOf('function autoScrollStep'))
  assert.ok(bloc.includes('if(!jourPasse(i)) sel.idx.add(i)'), 'la plage ecarte les jours revolus')
  // Et le survol pendant le glisser passe par le MEME chemin, plus par une
  // recopie en ligne du remplissage.
  assert.ok(PAGE.includes("cell.addEventListener('mouseenter',()=>{if(!isDragging||dragBien!==bid||dragRow!==row)return;extendSelTo(idx)})"))
  // Un SEUL remplissage de plage dans toute la page, et c'est le filtre.
  assert.strictEqual((PAGE.match(/for\(let i=lo;i<=hi;i\+\+\)/g) || []).length, 1,
    'un seul endroit remplit une plage')
  assert.ok(!/for\(let i=lo;i<=hi;i\+\+\)\s*sel\.idx\.add\(i\)/.test(PAGE),
    'et il ne le fait jamais sans filtre')
})

test('passe : la popup « Plus de parametres » ne peut pas ecrire en arriere', () => {
  // ⚠ Les segments envoyes au serveur portent `date_from: sISO` — la plage
  // BRUTE, pas les jours filtres. Deux chemins y menaient : la plage pre-remplie
  // depuis une selection faite apres navigation, et une date tapee a la main.
  const bloc = PAGE.slice(PAGE.indexOf("const sSaisi=document.getElementById('range-start')"), PAGE.indexOf('let touched=0'))
  assert.ok(bloc.includes("sSaisi<ISO_AUJOURDHUI) ? ISO_AUJOURDHUI : sSaisi"), 'la borne basse est serree')
  assert.ok(bloc.includes('eISO<ISO_AUJOURDHUI'), 'une plage entierement passee est refusee')
  // Les deux boucles qui materialisent les dates portent la meme borne.
  assert.strictEqual((PAGE.match(/iso>=ISO_AUJOURDHUI/g) || []).length, 2,
    'application locale ET depliage per-date')
  assert.match(PAGE, /champDebut\.min=ISO_AUJOURDHUI/, 'le selecteur de date le dit aussi')
})

test('rebatir : l\'historique d\'annulation tombe avec les etats', () => {
  // ⚠ `undoStack` garde des snapshots de `states`, indexes par POSITION dans
  // `days`. Le conserver apres un changement de fenetre reposait les prix d'une
  // plage sur d'autres dates ; en retrecissant la periode (1 an -> 1 mois), le
  // tableau restitue etait plus long que `days` et `classesJour` levait sur
  // `days[i]` indefini, laissant le bien sans rendu.
  const bloc = PAGE.slice(PAGE.indexOf('async function rebatirGrille'), PAGE.indexOf("document.getElementById('period-select')"))
  assert.ok(bloc.includes('undoStack.length=0'), 'l\'historique est vide')
  assert.ok(bloc.includes('bu.disabled=true'), 'et le bouton re-eteint')
})

test('rebatir : une reponse en retard ne repeint pas une fenetre quittee', () => {
  // ⚠ Les fleches ne se desactivent pas pendant le chargement : deux clics
  // rapides lancent deux lectures, sans garantie d'ordre d'arrivee. Celle de -30
  // revenant apres celle de -60 ecrasait l'inventaire et les reservations, puis
  // l'etat etait reconstruit contre les `days` de -60 : dates absentes retombant
  // au prix de base, barres d'une autre plage. L'hote lisait de faux tarifs.
  const bloc = PAGE.slice(PAGE.indexOf('async function reloadInventory'))
  assert.ok(bloc.includes('const monTour=++lectureEnCours'), 'chaque lecture porte son rang')
  assert.strictEqual((bloc.match(/if\(monTour!==lectureEnCours\) return/g) || []).length, 2,
    'succes ET echec sont ignores s\'ils sont perimes')
})

test('jour courant : relu au retour sur l\'onglet, pas seulement au chargement', () => {
  // ⚠ Le commentaire promettait qu'un onglet laisse ouvert la nuit repererait le
  // bon jour au matin. C'etait faux : `buildDays` ne tourne qu'au chargement, au
  // changement de periode et a la navigation. Passe minuit, le repere restait sur
  // la veille et `jourPasse` tenait hier pour modifiable.
  assert.match(PAGE, /function verifierChangementDeJour/)
  assert.match(PAGE, /addEventListener\('visibilitychange'/)
  assert.match(PAGE, /window\.addEventListener\('focus', verifierChangementDeJour\)/)
  const bloc = PAGE.slice(PAGE.indexOf('function verifierChangementDeJour'), PAGE.indexOf("document.addEventListener('visibilitychange'"))
  assert.ok(bloc.includes('if(maintenant===ISO_AUJOURDHUI) return'), 'aucun rendu si le jour n\'a pas change')
  assert.ok(!bloc.includes('reloadInventory'), 'la plage n\'a pas bouge : un rendu suffit')
})

test('en-tete collant : le trait du bas survit a `border-collapse`', () => {
  // ⚠ Sous `border-collapse: collapse`, la bordure appartient au TABLEAU, pas a
  // la cellule : une cellule collante ne l'emporte pas avec elle et le trait
  // disparaissait des que la ligne se figeait.
  assert.match(PAGE, /table\.cal thead th \{ box-shadow: inset 0 -1px 0 #e5e5e7/)
  assert.ok(!/table\.cal thead th \{ border-bottom/.test(PAGE))
  // Et les cellules qui portent deja une ombre la recomposent : `box-shadow` ne
  // se cumule pas entre regles, la derniere gagne en entier.
  assert.match(PAGE, /thead th\.today \{ box-shadow:[^}]*inset 0 -1px 0 #e5e5e7/)
  assert.match(PAGE, /thead th\.weekend\.we-debut \{ box-shadow:[^}]*inset 0 -1px 0 #e5e5e7/)
})

test('plus de CSS mort qui attendait de devenir un defaut', () => {
  // `.bien-title` n'etait porte par aucun element (le nom du bien vit dans
  // `.bien-head`, dans le thead), et son z-index 6 serait passe au-dessus de la
  // ligne de jours desormais collante (z-index 3).
  assert.ok(!/\.bien-title \{/.test(PAGE))
  assert.ok(!/class="bien-title"/.test(PAGE))
})

// ═══════════════════════════════════════════════════════════════════════════
// DESKTOP SEUL
// ═══════════════════════════════════════════════════════════════════════════

test('DESKTOP SEUL : le mobile n\'a recu aucune de ces retouches', () => {
  for (const marqueur of ['btn-passe', 'btn-aujourdhui', 'resaPassee', 'rebatirGrille',
                          'DECALAGE', 'month-band-wrap', 'bande-h']) {
    assert.ok(!MOBILE.includes(marqueur), `${marqueur} ne doit pas exister sur mobile`)
  }
})

test('DESKTOP SEUL : le decalage de computeDays est optionnel', () => {
  // Le mobile n'appelle pas computeDays, mais la signature doit rester
  // retrocompatible pour tout appelant existant.
  assert.match(CORE, /export function computeDays\(months, containerW, decalageJours = 0\)/)
  assert.ok(!MOBILE.includes('computeDays'))
})

test('LES JOURS DU MOIS NE SONT RENDUS QU UNE FOIS, sous le mois', () => {
  // Demande de Thierry, 21 septembre 2026 : chaque bien repetait la ligne des
  // jours (nom + numero) dans son propre thead — trois biens, trois fois les
  // memes « lun 21 mar 22 … ». Les jours vivent dans la bande, sous le mois.
  const bande = PAGE.slice(PAGE.indexOf('function renderMonthBand'), PAGE.indexOf('const blocksEl'))
  assert.match(bande, /tr class="jours"/, 'la bande porte une ligne de jours')
  assert.match(bande, /class="day-name"/, 'avec le nom du jour')
  assert.match(bande, /class="day-num"/, 'et son numero')
  assert.match(bande, /classesJour\(idx\)/, 'avec les memes classes que l ancien thead (week-end, jour courant, debut de mois)')
  // ⚠ STRUCTUREL, PAS TEXTUEL — releve en review : `<colgroup>` present dans
  // la source ne prouve rien s'il est ecrit AVANT `<table>` (le parseur
  // l'ignore, et c'est ce que ma premiere version faisait). On l'exige juste
  // apres la balise d'ouverture, avec l'angle au gabarit de `.row-label`.
  assert.match(bande, /<table class="month-band"'\+tableStyle\(\)\+'>'\+colonnesHtml\(\)\+'/,
    'le colgroup est DANS la table, par le meme generateur que les biens, avec la meme largeur en ligne')
  // ⚠ LE MEME colgroup DANS LES DEUX TABLES — decalage constate par Thierry sur
  // staging (21 septembre 2026) : l'angle faisait 129 px alors que `.row-label`
  // fait 120 en border-box, et la grille des biens n'avait aucun colgroup.
  // On teste la PROPRIETE, pas la forme : les deux tables passent par le meme
  // generateur de colonnes ET la meme largeur en ligne (sans largeur non auto,
  // `table-layout: fixed` n'est pas en vigueur et les `col` ne sont que des
  // preferences).
  assert.match(PAGE, /<table class="cal"'\+tableStyle\(\)\+'>'\+colonnesHtml\(\)\+'<thead>/, 'chaque bien : largeur + colonnes')
  assert.match(PAGE, /<table class="month-band"'\+tableStyle\(\)\+'>'\+colonnesHtml\(\)\+'/, 'la bande : idem')
  assert.match(PAGE, /LABEL_W\+days\.length\*CELL_W/, 'la largeur est la somme des colonnes')
  assert.match(PAGE, /table\.cal \{[^}]*table-layout: fixed/)
  assert.match(PAGE, /table\.cal \{[^}]*border-collapse: collapse/, 'sans collapse, border-spacing ajoute 2 px par jour')
  assert.match(PAGE, /table\.month-band \{[^}]*table-layout: fixed/)
  // Chaque `/*` du style est ferme : un commentaire ouvert avale la regle suivante.
  const style = PAGE_BRUTE.slice(PAGE_BRUTE.indexOf('<style>'), PAGE_BRUTE.indexOf('</style>'))
  assert.equal((style.match(/\/\*/g) || []).length, (style.match(/\*\//g) || []).length, 'un commentaire CSS non ferme')
  // Le nom du bien : ellipsis dans sa propre boite, trait bas conserve, texte a 12 px du lisere.
  assert.match(PAGE, /\.bien-head \{[^}]*box-shadow: inset 4px 0 0 #007aff, inset 0 -1px 0 #e5e5e7/)
  assert.match(PAGE, /\.bien-head \{[^}]*padding-left: 12px/)
  assert.match(PAGE, /\.bien-head \.nom \{ display: block; overflow: hidden; text-overflow: ellipsis; \}/)
  assert.match(PAGE, /<span class="nom">'\+escapeHtmlLocal\(bien\.name\)\+'<\/span>/)
  // Un mois d'une ou deux colonnes prend son nom court, sans deborder sur le voisin.
  assert.match(PAGE, /span<3\?monthShort\[m\]:monthFull\[m\]/)
  assert.match(PAGE, /\.cal-page \* \{ box-sizing: border-box; \}/, 'la regle qui rend 120 exact')
  assert.ok(!/const LABEL_W=/.test(PAGE), 'LABEL_W vient du core, pas d une copie locale')
  assert.match(PAGE, /area\.scrollLeft - LABEL_W/, 'la selection a la souris compte depuis la meme colonne')
  // Les liseres qui entreraient dans la boite de la table : en box-shadow.
  assert.match(PAGE, /\.row-label\.bien-head \{[^}]*box-shadow: inset 4px 0 0 #007aff/)
  assert.ok(!/\.row-label\.bien-head \{[^}]*border-left/.test(PAGE))
  assert.match(PAGE, /table\.month-band \.corner \{[^}]*border-right: 1px solid #e5e5e7/)
  // Le nom du bien est ECHAPPE (XSS stocke via le titre provider).
  assert.match(PAGE, /escapeHtmlLocal\(bien\.name\)\+'<\/span><span class="cap-h">/)
  assert.match(bande, /w\.offsetHeight/, 'la hauteur de bande est mesuree apres rendu')
  assert.match(bande, /setProperty\('--bande-h'/, 'et posee sur la page : 74px n est qu un repli')
  assert.ok(!/table\.cal tr\.jours td\.weekend \.day-name/.test(PAGE), 'plus de CSS mort pour des jours qui ne sont plus dans le thead')

  const bien = PAGE.slice(PAGE.indexOf('function renderBienBlock'), PAGE.indexOf('const rows=visibleRows(bien)'))
  assert.ok(!/day-name|day-num/.test(bien), 'le thead d un bien ne rend plus les jours')
  assert.match(bien, /jour-vide/, 'ses cellules de jour restent, vides, pour l alignement')
  assert.match(bien, /bien-head/, 'et le nom du bien y reste')

  // Une seule fois dans tout le rendu : deux fabriques de jours divergeraient.
  const rendu = PAGE.slice(PAGE.indexOf('<script type="module">'))
  assert.strictEqual((rendu.match(/class="day-num"/g) || []).length, 1, 'day-num n est ecrit qu une fois dans le JS')
  // Le style suit : une bande a deux lignes, des theads sans jours.
  assert.match(PAGE, /table\.month-band tr\.jours td \{[^}]*height: 46px/)
  assert.match(PAGE, /table\.cal thead th\.jour-vide \{[^}]*height: 0/)
  assert.match(PAGE, /table\.month-band tr\.jours td\.today \{/, 'le jour courant se lit sur la bande')
  assert.match(PAGE, /table\.month-band tr\.jours td\.weekend \{/, 'le week-end aussi')
})
