// tests/aujourdhui-info-bulles.test.js — les ⓘ de la vue Annee.
//
// Demande de Thierry du 29 octobre 2026, mot pour mot : « plus aucun paragraphe
// sous la courbe ni sous le tableau. Tout passe en info-bulles ⓘ (survol /
// toucher). Chiffres et dates dynamiques. […] Une ligne a 0 ne s'affiche pas. »
//
// Ce que ce fichier demontre, et pourquoi chaque point est ici :
//   1. les quatre paragraphes ont DISPARU — pas ete masques. Un paragraphe
//      masque par `hidden` revient au premier rendu qui oublie de le remasquer ;
//   2. le TOUCHER ouvre. C'est la moitie de la demande, et sur telephone la
//      seule moitie qui existe. Le survol est en CSS, le toucher est un etat ;
//   3. la bulle n'est JAMAIS masquee par l'attribut `hidden` : cette feuille
//      ouvre `[hidden]` avec un `display: none !important` en tete, qu'aucun
//      `display: block` de classe ne peut battre. Une bulle posee en `hidden`
//      ne s'ouvrirait donc jamais, et le test qui lit `aria-expanded` serait
//      vert — exactement le faux vert que ce depot vient de payer deux fois sur
//      l'opacite des bandes ;
//   4. les textes portent des PARAMETRES (nombre de comparables, date du
//      releve, periode, annee N-1) : « chiffres et dates dynamiques ».

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const RACINE = path.join(__dirname, '..')
const PAGE = fs.readFileSync(path.join(RACINE, 'pages', 'aujourdhui.html'), 'utf8')
const CSS = fs.readFileSync(path.join(RACINE, 'shared', 'ui.css'), 'utf8')
const DICOS = ['fr', 'en', 'es'].map((l) => [l, JSON.parse(
  fs.readFileSync(path.join(RACINE, 'shared', 'i18n', `${l}.json`), 'utf8'))])

// ─── 1. Plus aucun paragraphe sous la courbe ni sous le tableau ────────────

// Les quatre `data-bind` que portaient les paragraphes retires. Les citer
// nommement est le seul moyen qu'un retour en arriere rougisse : un test qui
// compterait les `<p>` passerait sur un paragraphe renomme.
const PARAGRAPHES_RETIRES = [
  'revenue-annee-note',            // sous la courbe : ce qu'elle montre
  'revenue-annee-comparables',     // sous la bande : son nombre et sa date
  'revenue-annee-comparables-tous', // sous la bande : pourquoi il n'y en a pas
  'revenue-annee-reserves'         // sous le tableau : jusqu'a dix motifs par ` · `
]

test('aucun des quatre paragraphes de la vue Annee ne subsiste', () => {
  // ⚠ ON CHERCHE L ATTACHE RENDUE, `data-bind="…"`, pas le nom nu : les
  // commentaires de la page CITENT ces noms pour dire ce que chaque ⓘ remplace,
  // et c'est exactement ce qu'on veut qu'ils fassent. Un test sur le nom nu
  // rougirait sur la documentation du retrait.
  for (const b of PARAGRAPHES_RETIRES) {
    assert.ok(!PAGE.includes(`data-bind="${b}"`),
      `le paragraphe « ${b} » est encore attache dans la page : la demande etait de le RETIRER, pas de le masquer`)
    assert.ok(!PAGE.includes(`cache('[data-bind="${b}"]')`),
      `la page ecrit encore dans « ${b} » : le paragraphe est parti du markup mais pas du rendu`)
  }
})

test('les trois cles i18n de ces paragraphes sont retirees des trois dictionnaires', () => {
  // Une cle laissee derriere est une invitation a reposer le paragraphe, et
  // elle fausse le compte de couverture des traductions.
  for (const [langue, dico] of DICOS) {
    // ⚠ `annee_ib_total_estime` est la QUATRIEME, et sa raison d'etre retiree a
    // CHANGE depuis la revue — l'enoncer encore comme a la revue serait faux.
    // A la revue : elle redisait, derriere un survol, la phrase que
    // `revenue.note` imprimait EN CLAIR sous le bloc. La demande de Thierry qui
    // a suivi a retire ce texte en clair des deux vues ; `revenue.note` ne vit
    // donc plus que dans les deux ⓘ du total (le mois et l'annee). Ce qui reste
    // vrai, et ce qui justifie le retrait : c'etait une SECONDE cle pour UNE
    // phrase, et deux cles pour une phrase divergent a la premiere correction
    // de style. L'ⓘ pousse `revenue.note` elle-meme.
    for (const cle of ['revenue.annee_comparables_note', 'revenue.annee_note_cours',
      'revenue.annee_note_entiere', 'revenue.annee_ib_total_estime']) {
      assert.ok(!(cle in dico), `${langue}.json porte encore la cle morte ${cle}`)
    }
  }
})

// ─── 2. Les boutons ⓘ de la page ──────────────────────────────────────────

// ⚠ LE MARKUP SEUL, SANS LA BALISE `<script>` : la ⓘ des comparables est
// CONSTRUITE en JavaScript, donc son `<button>` existe aussi sous forme de
// chaine dans le script. Les compter ensemble ferait dire « trois boutons en
// dur » a une page qui en porte deux.
const MARKUP = PAGE.slice(0, PAGE.indexOf('<script type="module">'))
const SCRIPT = PAGE.slice(PAGE.indexOf('<script type="module">'))
// ⚠ ET LA VUE ANNEE SE BORNE, depuis que la vue MOIS a son ⓘ a elle (demande
// du 29 octobre : la phrase de `revenue.note` quitte le texte en clair des
// DEUX vues, donc chacune la porte dans son info-bulle). Compter sur la page
// entiere ferait dire « trois ⓘ en dur dans la vue Annee » a une page qui en a
// deux, et la quatrieme n'est pas un defaut.
const DEBUT_ANNEE = MARKUP.indexOf('<div data-bind="revenue-annee" hidden>')
const FIN_ANNEE = MARKUP.indexOf('<div class="rev-rad"', DEBUT_ANNEE)
const MARKUP_ANNEE = (() => {
  assert.ok(DEBUT_ANNEE > 0 && FIN_ANNEE > DEBUT_ANNEE,
    'les bornes de la vue Annee ne se trouvent plus dans la page')
  return MARKUP.slice(DEBUT_ANNEE, FIN_ANNEE)
})()
const BOUTONS = MARKUP_ANNEE.match(/<button[^>]*data-ibulle[^>]*>/g) || []

test('la page porte les deux ⓘ en dur de la vue Annee', () => {
  // Deux seulement : celle du total et celle du titre de la courbe. La
  // troisieme — les comparables — est CONSTRUITE a chaque rendu de la legende,
  // et c'est `tests/accueil-rapide.test.js` qui la mesure, au rendu.
  assert.strictEqual(BOUTONS.length, 2,
    `${BOUTONS.length} bouton(s) ⓘ en dur au lieu de 2 : ${BOUTONS.join(' | ')}`)
})

test('chaque ⓘ part fermee, se nomme par i18n, et n est pas un `title`', () => {
  for (const b of BOUTONS) {
    assert.match(b, /aria-expanded="false"/,
      `une ⓘ ne declare pas son etat ferme au depart : ${b}`)
    assert.match(b, /data-i18n-attr="aria-label:revenue\.annee_ib_ouvrir_\w+"/,
      `une ⓘ n est pas nommee par i18n : un lecteur d ecran annoncerait « bouton » : ${b}`)
    // ⚠ UN `title=` NE S OUVRE PAS AU TOUCHER, n est pas atteignable au clavier,
    // et son texte n est pas dans le DOM — donc intestable autrement qu en
    // lisant un attribut. C'est la demande meme qu il trahirait.
    assert.ok(!/\stitle=/.test(b), `une ⓘ passe par un \`title\` : ${b}`)
  }
})

test('la ⓘ CONSTRUITE des comparables se nomme par la meme cle i18n', () => {
  // ⚠ ELLE NE PEUT PAS PORTER `data-i18n-attr` : elle est rendue APRES que
  // l application des traductions a balaye le document. Elle interpole donc la
  // cle elle-meme — et c'est la MEME cle, sinon deux libelles divergeraient.
  // ⚠ LA CHAINE EST CONCATENEE : le `<button>` est coupe par des backticks, donc
  // aucune expression ne reconstitue la balise entiere. On compte l attache
  // `data-ibulle`, qui ne peut etre ecrite qu une fois par bouton.
  const construits = (SCRIPT.match(/data-ibulle/g) || []).length
  assert.strictEqual(construits, 1,
    `${construits} ⓘ construite(s) dans le script au lieu d une seule`)
  assert.match(SCRIPT, /data-ibulle[\s\S]{0,80}aria-expanded="false"|aria-expanded="false"[\s\S]{0,80}data-ibulle/,
    'la ⓘ construite ne part pas fermee')
  assert.match(SCRIPT, /data-ibulle[\s\S]{0,200}aria-label="\$\{esc\(t\('revenue\.annee_ib_ouvrir_comparables'\)\)\}"/,
    'la ⓘ construite n est pas nommee par sa propre cle revenue.annee_ib_ouvrir_comparables')
})

test('les trois ⓘ ont des libelles DISTINCTS et pointent chacune son texte', () => {
  // ⚠ CONSTAT 6 DE LA REVUE DE 6d82af4d. Les trois boutons partageaient la
  // meme cle (« Qu'est-ce que c'est ? ») : un hote au lecteur d'ecran
  // entendait trois fois la meme phrase en tabulant la vue Annee, sans rien
  // qui rattache chacune au total, a la courbe ou a la legende. Et sans
  // `aria-controls` vers le `role="note"`, deployer n'annoncait que le
  // changement d'etat, jamais le texte.
  // ⚠ ET UNE VERSION DE CE FICHIER EXIGEAIT LE CONTRAIRE : elle verifiait que
  // les trois partagent la cle. Un test peut figer un defaut (REVIEW.md 17).
  const cles = [...PAGE.matchAll(/aria-label:(revenue\.annee_ib_ouvrir_\w+)/g)].map(m => m[1])
  const construite = (SCRIPT.match(/t\('(revenue\.annee_ib_ouvrir_\w+)'\)/) || [])[1]
  assert.ok(construite, 'la ⓘ construite ne se nomme par aucune cle d ouverture')
  const toutes = [...cles, construite]
  assert.strictEqual(toutes.length, 3, `${toutes.length} libelle(s) d ouverture au lieu de 3 : ${toutes.join(', ')}`)
  assert.strictEqual(new Set(toutes).size, 3,
    `deux ⓘ partagent leur libelle : ${toutes.join(', ')}`)
  for (const [langue, dico] of DICOS) {
    const textes = toutes.map(c => {
      assert.ok(dico[c] != null, `${langue}.json : cle absente ${c}`)
      return dico[c]
    })
    assert.strictEqual(new Set(textes).size, 3,
      `${langue}.json : deux libelles d ouverture sont IDENTIQUES — ${textes.join(' | ')}`)
  }
  // Et chaque bouton pointe le texte qu'il ouvre.
  const controls = [...PAGE.matchAll(/aria-controls="([\w-]+)"/g)].map(m => m[1])
  assert.ok(controls.length >= 3, `${controls.length} \`aria-controls\` au lieu de 3 au moins`)
  for (const id of controls) {
    assert.ok(PAGE.includes(`id="${id}"`), `aucun element ne porte l id « ${id} » designe par un aria-controls`)
  }
})

test('aucune bulle n est masquee par l attribut `hidden`', () => {
  // ⚠ LE PIEGE QUI RENDRAIT TOUT LE RESTE VERT POUR RIEN. Voir l en-tete.
  const bulles = MARKUP.match(/<span[^>]*class="ibulle__txt"[^>]*>/g) || []
  assert.ok(bulles.length >= 2, `${bulles.length} bulle(s) trouvee(s) : le markup a change de forme`)
  for (const s of bulles) {
    assert.ok(!/\shidden[\s>]/.test(s),
      `une bulle est posee en \`hidden\` : « ${s} » — la regle [hidden] de cette feuille est \`!important\``)
  }
})

test('la vue MOIS porte la phrase de `revenue.note` dans une ⓘ, et plus en clair', () => {
  // ⚠ LE RETRAIT NE DOIT PAS ETRE UN RETRAIT DE FOND. Le paragraphe disait
  // « Montants calcules selon les delais de versement des plateformes, et non
  // confirmes par la banque » sous les DEUX vues. Retire du texte en clair, il
  // devait etre repris des deux cotes — l'annee dans `lignesIb`, le mois ici.
  assert.ok(!PAGE.includes('<p class="caption muted" data-i18n="revenue.note">'),
    'le paragraphe `revenue.note` est encore imprime en clair sous le bloc')
  const avantAnnee = MARKUP.slice(0, DEBUT_ANNEE)
  assert.match(avantAnnee, /id="ib-mois-txt" data-i18n="revenue\.note"/,
    'la vue Mois ne porte plus la phrase : elle a disparu de l ecran sans remplacement')
  assert.match(avantAnnee, /data-i18n-attr="aria-label:revenue\.mois_ib_ouvrir_total"/,
    'la ⓘ du mois n est pas nommee par i18n')
  for (const [langue, dico] of DICOS) {
    assert.ok(dico['revenue.note'] != null, `${langue}.json : la cle revenue.note a ete supprimee`)
    assert.ok(dico['revenue.mois_ib_ouvrir_total'] != null,
      `${langue}.json : cle absente revenue.mois_ib_ouvrir_total`)
  }
})

test('l ⓘ du total de l annee porte la MEME cle que le paragraphe retire', () => {
  // Une seule source pour une seule phrase : si la bulle recopiait le texte,
  // les deux versions divergeraient a la premiere correction de style.
  assert.match(SCRIPT, /lignesIb\.push\(t\('revenue\.note'\)\)/,
    'l ⓘ du total de l annee ne pousse pas `revenue.note` : la phrase a disparu de la vue Annee')
})

// ─── 3. La feuille de style : survol, clavier, toucher ─────────────────────

test('la feuille masque la bulle par defaut et l ouvre par les TROIS gestes', () => {
  const bloc = CSS.match(/\.ibulle__txt \{[^}]*\}/)
  assert.ok(bloc, 'la classe .ibulle__txt est absente de la feuille')
  assert.match(bloc[0], /display:\s*none/, 'la bulle n est pas masquee par defaut')
  for (const sel of ['.ibulle:hover .ibulle__txt', '.ibulle__btn:focus-visible + .ibulle__txt',
    '.ibulle__btn[aria-expanded="true"] + .ibulle__txt']) {
    assert.ok(CSS.includes(sel), `la feuille n ouvre pas la bulle par « ${sel} »`)
  }
})

test('le SURVOL est reserve aux pointeurs qui survolent vraiment', () => {
  // ⚠ CONSTAT 2 DE LA REVUE DE 6d82af4d, et il a survecu a quinze mutations
  // parce qu'AUCUN test ne le voyait. Sur un navigateur tactile, `:hover`
  // reste accroche a l'element touche jusqu'au prochain toucher ailleurs : le
  // premier doigt ouvre (`aria-expanded` ET `:hover`), le second rend
  // `aria-expanded` a `false` mais `:hover` ouvre toujours — la feuille ne se
  // referme pas. Le test jsdom du toucher ne lit que `aria-expanded`, donc il
  // reste vert ; et chrome-headless ne simule pas un pointeur grossier sans
  // emulation CDP. La feuille est donc le seul endroit ou ce fait se mesure.
  const hover = CSS.match(/^[^\n]*\.ibulle:hover \.ibulle__txt[^\n]*$/m)
  assert.ok(hover, 'la regle de survol a disparu de la feuille')
  // La regle doit vivre SOUS un media de pointeur fin. On coupe la feuille a
  // la regle et on verifie que le dernier `@media` ouvert avant elle est
  // celui-la.
  const avant = CSS.slice(0, CSS.indexOf(hover[0]))
  const dernierMedia = [...avant.matchAll(/@media ([^{]+)\{/g)].pop()
  assert.ok(dernierMedia && /hover:\s*hover/.test(dernierMedia[1]),
    'la regle `.ibulle:hover` n est pas sous `@media (hover: hover)` : sur telephone, '
    + 'le second toucher ne refermera pas la bulle')
  // Et le media n est pas refermé avant elle.
  const ouvrantes = (avant.match(/\{/g) || []).length
  const fermantes = (avant.match(/\}/g) || []).length
  assert.ok(ouvrantes > fermantes,
    'le `@media (hover: hover)` est deja referme quand la regle de survol arrive : elle s applique partout')
})

test('la regle [hidden] de cette feuille est bien `!important` — ce qui JUSTIFIE le test ci-dessus', () => {
  // Une mesure qui dit sa plage : si un jour `[hidden]` cessait d'etre
  // `!important`, le test « aucune bulle en hidden » deviendrait du zele, et il
  // faudrait le dire au lieu de le garder par habitude.
  assert.match(CSS, /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/,
    'la regle [hidden] n est plus !important : relire le test « aucune bulle masquee par hidden »')
})

// ─── 4. Le comportement : le TOUCHER ouvre, et tout le reste ferme ─────────

let brancherInfoBulles
test.before(async () => { ({ brancherInfoBulles } = await import('../shared/ibulle.js')) })

const banc = () => {
  const dom = new JSDOM(`<!doctype html><body>
    <span class="ibulle"><button type="button" class="ibulle__btn" aria-expanded="false" data-ibulle id="a">
      <svg></svg></button><span class="ibulle__txt" id="ta">A</span></span>
    <span class="ibulle"><button type="button" class="ibulle__btn" aria-expanded="false" data-ibulle id="b">
      <svg></svg></button><span class="ibulle__txt" id="tb">B</span></span>
    <p id="ailleurs">le reste de l ecran</p>
  </body>`)
  const d = dom.window.document
  brancherInfoBulles(d)
  const clic = (sel) => d.querySelector(sel).dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true }))
  const touche = (key) => d.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))
  const ouvert = (sel) => d.querySelector(sel).getAttribute('aria-expanded') === 'true'
  return { dom, d, clic, touche, ouvert }
}

test('un TOUCHER ouvre la bulle, un second la referme', () => {
  const { clic, ouvert } = banc()
  assert.strictEqual(ouvert('#a'), false, 'la bulle est ouverte avant tout geste')
  clic('#a')
  assert.strictEqual(ouvert('#a'), true, 'le toucher n ouvre pas : sur telephone, le texte est inatteignable')
  clic('#a')
  assert.strictEqual(ouvert('#a'), false, 'le second toucher ne referme pas')
})

test('un toucher sur l ICONE a l interieur du bouton ouvre aussi', () => {
  // ⚠ LE DOIGT TOMBE SUR LE `<svg>`, jamais sur le bouton exactement. Sans
  // `closest`, l ouverture ne marcherait que sur les deux pixels de marge.
  const { d, dom, ouvert } = banc()
  d.querySelector('#a svg').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  assert.strictEqual(ouvert('#a'), true, 'un clic sur l icone n ouvre pas la bulle')
})

test('un toucher DANS la bulle ne la referme pas', () => {
  // ⚠ CONSTAT 4 DE LA REVUE DE 6d82af4d. Le texte est un FRERE du bouton, pas
  // un descendant : `closest('[data-ibulle]')` rendait `null` sur un clic dans
  // le texte, donc le clic passait pour « ailleurs » et refermait tout. Sur
  // telephone la bulle est une feuille de quatre lignes — l'hote qui touche le
  // texte pour le lire, le faire defiler ou le selectionner le voyait
  // disparaitre.
  const { clic, ouvert } = banc()
  clic('#a')
  clic('#ta')
  assert.strictEqual(ouvert('#a'), true,
    'toucher le texte de la bulle la referme : elle est illisible au doigt')
})

test('une seule bulle a la fois', () => {
  const { clic, ouvert } = banc()
  clic('#a'); clic('#b')
  assert.strictEqual(ouvert('#b'), true, 'la seconde bulle ne s ouvre pas')
  assert.strictEqual(ouvert('#a'), false, 'deux bulles ouvertes se recouvrent')
})

test('un toucher AILLEURS referme — la seule sortie qui existe sur un telephone', () => {
  const { clic, ouvert } = banc()
  clic('#a')
  clic('#ailleurs')
  assert.strictEqual(ouvert('#a'), false, 'la bulle reste ouverte par-dessus l ecran, sans moyen de la fermer')
})

test('la touche d echappement referme, pour le clavier', () => {
  const { clic, touche, ouvert } = banc()
  clic('#a')
  touche('Enter')
  assert.strictEqual(ouvert('#a'), true, 'une touche quelconque referme la bulle')
  touche('Escape')
  assert.strictEqual(ouvert('#a'), false, 'Echap ne referme pas')
})

test('une ⓘ posee APRES le branchement repond — c est la raison d etre de la delegation', () => {
  // La ⓘ des comparables est reconstruite a chaque rendu de la legende. Un
  // ecouteur pose sur le bouton serait perdu au rendu suivant.
  const { d, dom, ouvert } = banc()
  d.body.insertAdjacentHTML('beforeend',
    '<span class="ibulle"><button type="button" aria-expanded="false" data-ibulle id="c"></button>'
    + '<span class="ibulle__txt">C</span></span>')
  d.querySelector('#c').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  assert.strictEqual(ouvert('#c'), true, 'une ⓘ rendue apres le branchement ne s ouvre pas')
})

test('brancher deux fois ne double pas les ecouteurs', () => {
  // Deux jeux d ecouteurs basculeraient DEUX fois sur un clic : la bulle
  // resterait fermee, et le defaut serait invisible a la lecture du code.
  const { d, clic, ouvert } = banc()
  brancherInfoBulles(d)
  clic('#a')
  assert.strictEqual(ouvert('#a'), true, 'le branchement est double : un toucher ouvre puis referme aussitot')
})

// ─── 5. Chiffres et dates DYNAMIQUES ───────────────────────────────────────

test('les textes des ⓘ portent leurs parametres, dans les trois langues', () => {
  // « Chiffres et dates dynamiques » : une ⓘ qui enoncerait « vos 8 logements
  // comparables » en dur mentirait des que l hote en aurait sept.
  const ATTENDUS = {
    'revenue.annee_ib_comparables': ['n', 'date'],
    'revenue.annee_ib_courbe': ['periode', 'n1'],
    'revenue.annee_ib_total_sans_montant': ['n'],
    'revenue.annee_ib_total_bruts': ['n']
  }
  for (const [langue, dico] of DICOS) {
    for (const [cle, params] of Object.entries(ATTENDUS)) {
      const s = dico[cle]
      assert.ok(s != null, `${langue}.json : cle absente ${cle}`)
      for (const p of params) {
        assert.ok(new RegExp(`\\{${p}[,}]`).test(s),
          `${langue}.json : ${cle} ne porte pas {${p}} — le chiffre serait en dur`)
      }
    }
  }
})
