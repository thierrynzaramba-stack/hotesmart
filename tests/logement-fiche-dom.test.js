// tests/logement-fiche-dom.test.js — LA FICHE V5 D'UN LOGEMENT, en jsdom.
//
// Étape 2 du lot Logements. Le rendu vit dans `shared/logement-fiche.js` et pas
// dans la balise `<script>` de la page, précisément pour qu'il se teste ici
// sans extraction à la regex.
//
// Les quatre qui comptent :
//   1. un bloc REFUSÉ n'est pas rendu du tout — « on ne montre jamais ce qui
//      mène à un refus » (règle de Thierry du 20 octobre 2026) ;
//   2. un bloc qu'on n'a pas pu LIRE se dit, muet : le taire le ferait passer
//      pour vide, et « aucune prestataire » sur un bien qui en a deux est le
//      mensonge que tout ce lot interdit ;
//   3. la fiche dit la MÊME note que la liste — décision de Thierry du
//      21 octobre : « les deux écrans doivent dire la même chose » ;
//   4. Supprimer est désactivé tant que le bien est relié, avec la raison du
//      SERVEUR, pas celle que la spec d'origine annonçait.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

let M
test.before(async () => { M = await import('../shared/logement-fiche.js') })

// Le dictionnaire RÉEL, pas un double : un test qui inventerait ses propres
// textes ne dirait rien sur les clés que la page demande.
const FR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', 'fr.json'), 'utf8'))
const CLES = new Set()
const RENDUS = new Set()
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const t = (cle, vars = {}) => {
  CLES.add(cle)
  assert.notEqual(vars, null, `t('${cle}') appelé avec \`null\` : le moteur réel lève`)
  let s = FR[cle]
  assert.ok(s != null, `clé i18n absente de fr.json : ${cle}`)
  s = s.replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g, (_, k, corps) => {
    const n = Number(vars[k] ?? 0)
    const cas = {}
    corps.replace(/(=\d+|\w+)\s*\{([^{}]*)\}/g, (__, c, v) => { cas[c] = v })
    const choisi = cas[`=${n}`] ?? cas[new Intl.PluralRules('fr').select(n)] ?? cas.other ?? ''
    return choisi.replace(/#/g, String(n))
  })
  const rendu = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`))
  RENDUS.add(rendu)
  return rendu
}
const icone = (id) => `<svg data-icone="${id}"></svg>`
const nombre = (x, dec = 1) => new Intl.NumberFormat('fr', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(x)
const argent = (x, d) => new Intl.NumberFormat('fr', { style: 'currency', currency: d || 'EUR', maximumFractionDigits: 0 }).format(x)
const dateEnClair = (iso) => `le-${iso}`
const OUTILS = (extra = {}) => ({ t, esc, icone, nombre, argent, dateEnClair, ...extra })

const doc = (html) => new JSDOM(`<!doctype html><body><div id="c">${html}</div></body>`).window.document

// Une fiche complète, telle que `GET /api/logement?id=` la rend.
const fiche = (extra = {}) => ({
  bien: {
    id: 'b1', nom: 'La bulle', ville: 'Bagnères', pays: 'FR', adresse: '1 rue X',
    code_postal: '65200', capacite: 2, photo_url: null, devise: 'EUR',
    prix_de_base: 120, prix_plancher: 130, voyageurs_inclus: 2, supplement_voyageur: 15,
    mode_des_prix: 'managed', pilote_tarifaire: 'yieldflow', assistant_en_pause: false
  },
  canaux: [{ ota: 'airbnb', titre: 'x', actif: true, mappe: true, listing_url: null }],
  canaux_vu_le: '2026-10-20T08:00:00Z', canaux_echec: false,
  suppression: { possible: true, motif: null },
  avis: { fenetre_jours: 30, proprete_sur_jours: 30, total_proprete: 4, positif: 3, remarque: 1,
          rien_signale: 0, non_analyses: 0, total: 336, notes: 332, note_sur_5: 4.9 },
  taxe: { connue: true, commune: 'Bagnères' },
  fait_date: { type: 'occupe', du: null, au: '2026-10-22' },
  menage: [{ id: 'm1', prenom: 'Regina', nom: 'B.', rang: 1, requires_ack: false }],
  serrures: [{ id: 's1' }],
  indisponibles: [], refuses: [],
  ...extra
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. Les sept blocs
// ═══════════════════════════════════════════════════════════════════════════

test('la fiche rend ses blocs, titrés et dans l ordre', () => {
  // ⚠ SIX BLOCS QUAND LA SUPPRESSION EST POSSIBLE : il n y a alors rien à dire
  // en lecture seule, et un bouton qui ne part pas serait un leurre. Le
  // septième apparaît quand la suppression est REFUSÉE — c est son état qui
  // est l information.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  assert.deepEqual([...d.querySelectorAll('.fic-bloc__titre')].map(x => x.textContent), [
    'Où il est en vente', 'Prix', 'Le logement', 'Ménage', 'Avis des voyageurs', 'Réglages'
  ])

  const refuse = doc(M.ficheHtml(
    fiche({ suppression: { possible: false, motif: 'annonce_reliee' } }), OUTILS(), { peutSupprimer: true }))
  assert.deepEqual([...refuse.querySelectorAll('.fic-bloc__titre')].map(x => x.textContent), [
    'Où il est en vente', 'Prix', 'Le logement', 'Supprimer ce logement',
    'Ménage', 'Avis des voyageurs', 'Réglages'
  ])
})

test('l en-tête porte le nom, la ville · capacité et le FAIT DATÉ — mais PAS les pastilles', () => {
  const d = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  assert.equal(d.querySelector('.fic-nom').textContent, 'La bulle')
  assert.match(d.querySelector('.fic-sous').textContent, /Bagnères · 2 voyageurs/)
  // ⚠ LES PASTILLES NE SONT PLUS DANS L EN-TÊTE (décision de Thierry du
  // 21 octobre 2026, après la capture de recette). La spec §3 les y mettait,
  // et le bloc « Où il est en vente » les porte AUSSI, à cent pixels d écart :
  // la même information deux fois, dont une sans son état ni sa date.
  assert.equal(d.querySelector('.fic-entete .log-canaux'), null,
    'l en-tête ne redit pas ce que le bloc dit mieux')
  assert.equal(d.querySelector('.fic-entete .log-pastille'), null)
  // Et elles sont bien DANS le bloc, avec la classe du module commun.
  assert.equal(d.querySelectorAll('.log-canaux .log-pastille').length, 1)
  assert.equal(d.querySelector('.fic-canaux, .fic-vente'), null,
    'aucune classe de pastilles propre à la fiche : une copie diverge')
  // ⚠ LE FAIT DATÉ A QUITTÉ LA CARTE POUR VENIR ICI (décision du 20 octobre).
  const fait = d.querySelector('[data-fait]')
  assert.equal(fait.dataset.fait, 'occupe')
  assert.match(fait.textContent, /^Occupé · départ le le-2026-10-22$/)
})

test('LE TEST QUI COMPTE : un fait daté NON LU ne devient jamais « Libre », même sur la fiche', () => {
  const d = doc(M.ficheHtml(fiche({ fait_date: null }), OUTILS(), {}))
  const fait = d.querySelector('[data-fait]')
  assert.equal(fait.textContent, 'Information indisponible')
  assert.doesNotMatch(d.querySelector('.fic-entete').textContent, /Libre/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Refusé / non lu / vide — les trois ne se confondent pas
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : un bloc REFUSÉ n est pas rendu DU TOUT', () => {
  // Règle de Thierry du 20 octobre : « le bloc n est pas rendu du tout à
  // l écran. Le JSON peut le porter, l écran le cache. »
  const d = doc(M.ficheHtml(
    fiche({ menage: null, avis: null, refuses: ['menage', 'avis'] }), OUTILS(), {}))
  const titres = [...d.querySelectorAll('.fic-bloc__titre')].map(x => x.textContent)
  assert.ok(!titres.includes('Ménage'), 'le bloc Ménage ne doit pas exister')
  assert.ok(!titres.includes('Avis des voyageurs'))
  assert.doesNotMatch(d.querySelector('#c').textContent, /ménage|Avis/i)
})

test('LE TEST QUI COMPTE : un bloc qu on n a pas pu LIRE se dit, muet', () => {
  const d = doc(M.ficheHtml(
    fiche({ menage: null, serrures: null, canaux: null, indisponibles: ['menage', 'serrures', 'canaux'] }),
    OUTILS(), {}))
  const muets = [...d.querySelectorAll('[data-non-lu]')].map(x => x.textContent)
  assert.ok(muets.some(x => /équipe ménage n’est pas lisible/.test(x)))
  assert.ok(muets.some(x => /serrure n’est pas lisible/.test(x)))
  assert.ok(muets.some(x => /canaux ne sont pas lisibles/.test(x)))
  // Et le bloc EXISTE : le taire le ferait passer pour vide.
  assert.ok([...d.querySelectorAll('.fic-bloc__titre')].map(x => x.textContent).includes('Ménage'))
})

test('« lu, et vide » est une RÉPONSE, et ne se dit pas comme « pas pu lire »', () => {
  const d = doc(M.ficheHtml(
    fiche({ menage: [], serrures: [], canaux: [], taxe: { connue: false, motif: 'aucune_taxe_transmise' } }),
    OUTILS(), {}))
  assert.equal(d.querySelectorAll('[data-non-lu]').length, 0)
  const txt = d.querySelector('#c').textContent
  assert.match(txt, /Aucune prestataire sur ce logement/)
  assert.match(txt, /Aucun canal relié/)
  assert.match(txt, /Aucun barème transmis/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Prix
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : un plancher vide dit « 10 € (par défaut) », il ne disparaît pas', () => {
  // Décision de Thierry, recette du 20 octobre 2026. `prix_minimum` est
  // nullable et le moteur applique alors 10 € : ne rien afficher laisserait
  // croire qu aucun plancher ne protège le bien, alors que c est la garde qui
  // empêche une nuit de partir à zéro.
  const d = doc(M.ficheHtml(fiche({ bien: { ...fiche().bien, prix_plancher: null } }), OUTILS(), {}))
  assert.match(d.querySelector('[data-plancher] .fic-ligne__val').textContent, /10\s*€ \(par défaut\)/)
  // Un plancher réglé s affiche nu, sans la mention.
  const avec = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  assert.doesNotMatch(avec.querySelector('[data-plancher]').textContent, /par défaut/)
  assert.match(avec.querySelector('[data-plancher] .fic-ligne__val').textContent, /130\s*€/)
})

test('le mode des prix se dit en clair, et le CHOIX ne se propose qu en mode `keep`', () => {
  // Spec §3.2 : « une fois en managed, le sélecteur disparaît ». C est une
  // bascule qui ne se défait pas.
  assert.equal(M.prixAffiche({ mode_des_prix: 'managed' }).choixPossible, false)
  assert.equal(M.prixAffiche({ mode_des_prix: 'keep' }).choixPossible, true)
  const d = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  assert.equal(d.querySelector('[data-mode] .fic-ligne__val').textContent, 'HôteSmart envoie mes prix')
})

test('la devise vient du BIEN, elle n est pas supposée', () => {
  const d = doc(M.ficheHtml(fiche({ bien: { ...fiche().bien, devise: 'CHF' } }), OUTILS(), {}))
  assert.match(d.querySelector('.fic-prix').textContent, /CHF/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Le logement
// ═══════════════════════════════════════════════════════════════════════════

test('un champ vide se dit « — », il ne disparaît pas', () => {
  // À l étape 3 il devient éditable sur place : une ligne absente n offrirait
  // nulle part où écrire.
  const d = doc(M.ficheHtml(
    fiche({ bien: { ...fiche().bien, adresse: null, code_postal: null } }), OUTILS(), {}))
  const lignes = [...d.querySelectorAll('.fic-champs .fic-ligne')].map(x => x.textContent)
  assert.equal(lignes.length, 6, 'les six champs sont toujours là')
  assert.ok(lignes.some(x => /Adresse—/.test(x.replace(/\s/g, ''))))
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Supprimer — la règle du SERVEUR, pas celle de la spec d'origine
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : relié à une annonce => bouton DÉSACTIVÉ, et la raison est celle du serveur', () => {
  // La spec disait « si le bien a des réservations ou des messages ». Le
  // serveur, lui, les PURGE et refuse un bien encore relié. Décision de
  // Thierry du 21 octobre : on s aligne sur le serveur, c est lui la vraie
  // protection.
  //
  // ⚠ LE MOTIF EST `annonce_reliee`, pas `relie`. Mes trois premiers tests
  // posaient eux-mêmes la fixture `relie` — un motif que le serveur n écrit
  // nulle part — donc ils mesuraient leur propre double, et la seule raison
  // que Thierry avait demandée ne s affichait JAMAIS en vrai.
  const d = doc(M.ficheHtml(
    fiche({ suppression: { possible: false, motif: 'annonce_reliee' } }), OUTILS(), { peutSupprimer: true }))
  const b = d.querySelector('[data-bind="supprimer"]')
  assert.ok(b.hasAttribute('disabled'))
  assert.equal(d.querySelector('[data-raison]').textContent, 'Déconnectez d’abord ses canaux.')
  assert.equal(d.querySelector('[data-raison]').dataset.motif, 'annonce_reliee')
  assert.doesNotMatch(d.querySelector('.fic-supprimer').textContent, /réservations ou des messages/)
})

test('LE TEST QUI COMPTE : les motifs sont ceux du SERVEUR, découverts dans son source', () => {
  // ⚠ LISTE DÉCOUVERTE, PAS RECOPIÉE. C est ce test qui aurait vu `relie`
  // contre `annonce_reliee` : une table d affichage écrite à la main dérive du
  // serveur sans qu une seule ligne ait l air fausse, et le fourre-tout
  // « Impossible de vérifier ses canaux » absorbe l écart en silence.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'logement', 'lecture.js'), 'utf8')
  const corps = src.slice(src.indexOf('function suppressionPossible'))
  const motifs = [...new Set([...corps.slice(0, corps.indexOf('\n}')).matchAll(/motif:\s*'([a-z_]+)'/g)]
    .map(m => m[1]))]
  assert.ok(motifs.length >= 4, `${motifs.length} motif(s) découvert(s) : la découverte a échoué`)
  // ⚠ ET LE CAS GÉNÉRAL, PAS SEULEMENT LES DEUX NOMS EN DUR (re-revue de
  // 3dddb14) : un motif ajouté demain au serveur tomberait en silence dans le
  // fourre-tout, et ce test serait resté vert — exactement le défaut qu'il
  // existe pour empêcher.

  for (const motif of motifs) {
    const d = doc(M.ficheHtml(
      fiche({ suppression: { possible: motif === 'annonce_reliee' ? false : null, motif } }),
      OUTILS(), { peutSupprimer: true }))
    if (M.MOTIFS_QUI_EFFACENT.includes(motif)) {
      assert.equal(d.querySelector('.fic-supprimer'), null,
        `${motif} doit EFFACER le bloc : on ne montre pas ce qui mène à un refus`)
      continue
    }
    const r = d.querySelector('[data-raison]')
    assert.ok(r, `${motif} ne rend aucune raison`)
    assert.equal(r.dataset.motif, motif)
    // ⚠ ET LE FOURRE-TOUT NE DOIT PAS ABSORBER UN MOTIF QUI A SA PROPRE
    // PHRASE : `annonce_reliee` et `jamais_releve` disent des choses
    // différentes, et parler des canaux « illisibles » à qui n en a jamais
    // fait relever est faux.
    assert.ok(Object.prototype.hasOwnProperty.call(M.MOTIFS, motif),
      `${motif} n est pas dans la table d affichage : il tomberait en silence ` +
      'dans « Impossible de vérifier ses canaux », qui est faux')
    if (motif === 'annonce_reliee') assert.match(r.textContent, /Déconnectez/)
    if (motif === 'jamais_releve') assert.match(r.textContent, /Aucun canal n’est relié/)
  }
})

test('LE TEST QUI COMPTE (SÉCURITÉ) : `droit_refuse` du SERVEUR efface le bloc, même si le navigateur dit oui', () => {
  // ⚠ LA CLASSE DE DÉFAUT GRAVÉE AU CLAUDE.md. La page passait
  // `peutEcrire('reglages')`, qui répond pour le COMPTE COURANT et rend `true`
  // par `estTitulaire()` dès que le sélecteur est resté sur mon compte. Or
  // cette fiche IGNORE `X-Compte` : le BIEN désigne le compte. J ouvre donc la
  // fiche d un bien d un autre compte où je suis invité en lecture, et le bloc
  // s affichait — alors que le serveur avait tranché dans la MÊME réponse.
  const d = doc(M.ficheHtml(
    fiche({ suppression: { possible: null, motif: 'droit_refuse' } }),
    OUTILS(), { peutSupprimer: true }))
  assert.equal(d.querySelector('.fic-supprimer'), null)
  assert.equal(d.querySelector('[data-bind="supprimer"]'), null)
  assert.ok(![...d.querySelectorAll('.fic-bloc__titre')].map(x => x.textContent)
    .includes('Supprimer ce logement'))
})

test('LE TEST QUI COMPTE : un bien SUPPRIMABLE ne rend aucun bouton à l étape 2', () => {
  // Un bouton rouge actif qui ne part pas est un leurre, et son aide promettait
  // une confirmation qui n existe pas encore. Quand la suppression est
  // possible, l étape 2 n a rien à dire ; le bouton revient à l étape 3,
  // câblé. Quand elle est refusée, son ÉTAT est l information.
  const d = doc(M.ficheHtml(fiche({ suppression: { possible: true, motif: null } }),
    OUTILS(), { peutSupprimer: true }))
  assert.equal(d.querySelector('[data-bind="supprimer"]'), null)
  assert.doesNotMatch(d.querySelector('#c').textContent, /confirmerez en saisissant/)
})

test('LE TEST QUI COMPTE : `possible: null` DÉSACTIVE aussi — une lecture ratée n ouvre pas la suppression', () => {
  // Constat H4 de la revue de l étape 0. Si on n a pas pu lire les canaux, on
  // ne sait pas si le bien est en vente : ouvrir l action la plus destructrice
  // du produit sur une lecture ratée est le seul cas qu on ne peut pas se
  // permettre.
  for (const s of [null, { possible: null, motif: null }, {}]) {
    const d = doc(M.ficheHtml(fiche({ suppression: s }), OUTILS(), { peutSupprimer: true }))
    assert.ok(d.querySelector('[data-bind="supprimer"]').hasAttribute('disabled'), JSON.stringify(s))
  }
  // Une suppression impossible N'EST PAS une suppression refusée par droit :
  // le bloc existe, il dit pourquoi.
  const d = doc(M.ficheHtml(fiche({ suppression: { possible: null } }), OUTILS(), { peutSupprimer: true }))
  assert.equal(d.querySelector('[data-raison]').textContent, 'Impossible de vérifier ses canaux pour l’instant.')
})

test('LE TEST QUI COMPTE (SÉCURITÉ) : sans le droit d écriture, le bloc Supprimer n existe pas', () => {
  // Le masquage est un confort, pas la protection : le DELETE est gardé par
  // `reglages: write` côté serveur, et c est lui le test qui tranche. Mais on
  // ne propose pas ce qui mène à un 403.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: false }))
  assert.equal(d.querySelector('[data-bind="supprimer"]'), null)
  assert.ok(![...d.querySelectorAll('.fic-bloc__titre')].map(x => x.textContent).includes('Supprimer ce logement'))
})

// ══════════════════════════════════════════════════════════════════════════
// 6. Les avis, et le compteur de propreté qui est dans le MÉNAGE
// ══════════════════════════════════════════════════════════════════════════
//
// Correction de Thierry du 21 octobre 2026 : « les pouces de propreté vont dans
// le bloc Ménage (pas Avis), en vert/rouge comme l'écran Ménages. Le bloc
// Avis = note sur 5 + nombre d'avis seulement. »

// Le corps d'un bloc, désigné par son titre — pour ne pas confondre
// « présent dans la fiche » et « présent dans LE BON bloc ».
const blocNomme = (d, titre) => [...d.querySelectorAll('.fic-bloc')]
  .find(b => b.querySelector('.fic-bloc__titre').textContent === titre)

test('LE TEST QUI COMPTE : la fiche dit la MÊME note que la carte de la liste', () => {
  // Décision de Thierry du 21 octobre : « les deux écrans doivent dire la même
  // chose ». Elle passe donc par le module commun, pas par un rendu d ici.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  const note = d.querySelector('.fic-avis .log-avis')
  assert.ok(note, 'la note vient de `avisHtml`, le rendu partagé')
  assert.match(note.textContent, /^4,9 \/ 5 · 336 avis/)
  assert.ok(note.querySelector('[data-icone="i-review"]'), 'la même étoile du sprite')
})

test('LE TEST QUI COMPTE : les pouces sont dans le bloc MÉNAGE, et le bloc Avis ne porte QUE la note', () => {
  // « Les pouces de propreté vont dans le bloc Ménage (pas Avis) [...] Le bloc
  // Avis = note sur 5 + nombre d'avis seulement » (Thierry, 21 octobre 2026).
  const d = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  const menage = blocNomme(d, 'Ménage')
  const avis = blocNomme(d, 'Avis des voyageurs')

  assert.ok(menage.querySelector('[data-proprete]'), 'le compteur appartient au bloc Ménage')
  assert.equal(avis.querySelector('[data-proprete]'), null, 'et il n est plus dans les Avis')
  assert.equal(avis.querySelectorAll('[data-pouce]').length, 0)
  // Le bloc Avis ne dit QUE la note : rien d autre que la ligne partagée.
  assert.deepEqual([...avis.querySelector('.fic-avis').children].map(x => x.className),
    ['log-avis caption'])
  // Et le bloc Ménage garde sa prestataire : le compteur s ajoute, il ne remplace pas.
  assert.match(menage.querySelector('[data-presta]').textContent, /Regina/)
})

test('LE TEST QUI COMPTE : VERT et ROUGE, par les classes de l écran Ménages — pas une copie', () => {
  // « En vert/rouge comme l écran Ménages (charte : vert OK, rouge problème) ».
  // Le rendu porte les MÊMES classes que la note d une prestataire, et c est
  // shared/ui.css qui les colore une seule fois.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  const bon = d.querySelector('[data-pouce="positif"]')
  const mauvais = d.querySelector('[data-pouce="remarque"]')
  assert.ok(bon.classList.contains('men-note__bon'))
  assert.ok(mauvais.classList.contains('men-note__mauvais'))
  assert.equal(bon.querySelector('b').textContent, '3')
  assert.equal(mauvais.querySelector('b').textContent, '1')
  assert.ok(d.querySelector('[data-proprete]').classList.contains('men-note'))

  // La couleur vit dans la feuille PARTAGÉE, aux deux endroits à la fois.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  assert.match(ui, /^\.men-note__bon \{ color: var\(--ok\); \}$/m)
  assert.match(ui, /^\.men-note__mauvais \{ color: var\(--danger\); \}$/m)
})

test('LE TEST QUI COMPTE : le troisième compteur garde sa MISE EN FORME, pas seulement sa couleur', () => {
  // ⚠ RISQUE SIGNALÉ PAR LE CHEF DE FILE (21 octobre 2026), et il est réel :
  // `.men-note__attente` n'a pas de règle de mise en forme à lui — il est AJOUTÉ
  // à une liste de sélecteurs partagée avec `__bon` et `__mauvais`. Une
  // résolution de conflit sur `shared/ui.css` qui prendrait un seul côté le
  // ferait disparaître de cette liste en lui laissant sa couleur : le compteur
  // s'afficherait gris ET mal aligné, sans qu'une ligne rougisse nulle part.
  // Une divergence doit être un rouge, pas une découverte.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  const regles = [...ui.matchAll(/^([^\n{}]*)\{([^}]*)\}/gm)]
    .filter(m => /(^|,)\s*\.men-note__attente\s*(,|$)/.test(m[1].trim()))
  assert.ok(regles.length, '.men-note__attente n a plus aucune règle')
  const dit = regles.map(m => m[2]).join(' ')
  for (const d of ['display: inline-flex', 'align-items: center', 'gap:', 'color: var(--muted)']) {
    assert.ok(dit.includes(d), `.men-note__attente a perdu « ${d} »`)
  }
  // Et il est bien RENDU par ce nom-là : une règle sans porteur ne protège rien.
  const d = doc(M.ficheHtml(
    fiche({ avis: { ...fiche().avis, non_analyses: 2 } }), OUTILS(), {}))
  assert.ok(d.querySelector('.men-note__attente'))
})

test('LE TEST QUI COMPTE : un ZÉRO reste muet — zéro remarque n est pas un problème', () => {
  // La règle que l écran Ménages porte déjà (`men-note--vide`) : un compteur à
  // zéro est gris. Peindre « 0 » en rouge ferait crier une fiche irréprochable.
  const d = doc(M.ficheHtml(fiche({ avis: { ...fiche().avis, positif: 2, remarque: 0 } }), OUTILS(), {}))
  const mauvais = d.querySelector('[data-pouce="remarque"]')
  assert.ok(mauvais.classList.contains('men-note--vide'), 'zéro remarque : gris, pas rouge')
  assert.ok(!d.querySelector('[data-pouce="positif"]').classList.contains('men-note--vide'))

  // ⚠ ET L ORDRE DE DÉCLARATION TRANCHE, pas la spécificité : `.men-note--vide`
  // et `.men-note__mauvais` ont le même poids (une classe). Le gris ne gagne que
  // parce qu il est déclaré APRÈS. C est la leçon de `[hidden]` du CLAUDE.md,
  // au grain d une couleur : une règle placée avant ne s applique pas.
  // ⚠ ANCRÉ SUR LA DÉCLARATION DE COULEUR, ET PAS SUR LE NOM DE LA CLASSE
  // (contre-épreuve du 21 octobre 2026) : `.men-note__mauvais` apparaît d'abord
  // dans un sélecteur GROUPÉ de mise en forme, plus haut dans la feuille. Un
  // `indexOf` sur le nom seul y tombait, et la mutation « gris déclaré avant les
  // couleurs » survivait — le test lisait la bonne classe au mauvais endroit.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  const ou = (re) => { const m = ui.match(re); assert.ok(m, `${re} absent de shared/ui.css`); return m.index }
  assert.ok(ou(/^\.men-note--vide \{ color:/m) > ou(/^\.men-note__mauvais \{ color:/m),
    'la couleur grise doit être déclarée APRÈS le rouge, sinon le zéro reste rouge')
  assert.ok(ou(/^\.men-note--vide \{ color:/m) > ou(/^\.men-note__bon \{ color:/m),
    'la couleur grise doit être déclarée APRÈS le vert')
})

test('LE TEST QUI COMPTE : aucune légende sous les chiffres', () => {
  // « Juste le compteur, sans légende » (Thierry, 21 octobre). Le libellé
  // existe POUR LA VOIX, pas à l écran.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  const pouces = d.querySelector('[data-proprete]')
  assert.ok(pouces.querySelector('[data-pouce="remarque"] .sr-only').textContent.includes('remarques'))
  const visible = [...pouces.querySelectorAll('[data-pouce]')]
    .map(x => { const c = x.cloneNode(true); c.querySelectorAll('.sr-only').forEach(sr => sr.remove()); return c.textContent.trim() })
  assert.deepEqual(visible, ['3', '1'], 'juste le compteur, sans légende')
})

test('« pas encore analysé » ne se range ni dans le vert ni dans le rouge', () => {
  const d = doc(M.ficheHtml(
    fiche({ avis: { ...fiche().avis, positif: 1, remarque: 0, non_analyses: 2 } }), OUTILS(), {}))
  const attente = d.querySelector('[data-pouce="attente"]')
  assert.equal(attente.querySelector('b').textContent, '2')
  // Ni OK, ni problème : sa propre classe, grise.
  assert.ok(attente.classList.contains('men-note__attente'))
  assert.ok(!attente.classList.contains('men-note__bon'))
  assert.ok(!attente.classList.contains('men-note__mauvais'))
  const ui = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  assert.match(ui, /^\.men-note__attente \{[^}]*color: var\(--muted\)/m)
})

test('LE TEST QUI COMPTE : « rien signalé » et « aucun avis » ne disent pas la même phrase', () => {
  // ⚠ Revue de 5c0d759 : `rien_signale` n entrait dans aucune somme, donc
  // quatre avis lus et tous sans remarque disaient la MÊME chose qu une
  // fenêtre sans aucun avis. « Lu, et vide » est une RÉPONSE, distincte de
  // « on n a rien » — c est la règle de tout ce lot, et elle ne s arrêtait pas
  // à ce bloc par hasard, mais par oubli.
  const lus = doc(M.ficheHtml(fiche({ avis: { ...fiche().avis,
    positif: 0, remarque: 0, non_analyses: 0, rien_signale: 4 } }), OUTILS(), {}))
  const z1 = lus.querySelector('[data-proprete]')
  assert.equal(z1.dataset.proprete, 'rien-signale')
  assert.equal(z1.textContent, 'Rien signalé sur 30 jours.')
  // Et la phrase est dans le bloc Ménage, comme le compteur qu elle remplace.
  assert.ok(blocNomme(lus, 'Ménage').querySelector('[data-proprete]'))

  const rien = doc(M.ficheHtml(fiche({ avis: { ...fiche().avis,
    positif: 0, remarque: 0, non_analyses: 0, rien_signale: 0 } }), OUTILS(), {}))
  const z2 = rien.querySelector('[data-proprete]')
  assert.equal(z2.dataset.proprete, 'aucun')
  assert.equal(z2.textContent, 'Aucun avis sur 30 jours.')

  // Et dans les deux cas, pas de trois zéros à l écran.
  for (const d of [lus, rien]) assert.equal(d.querySelector('.men-note'), null)
})

test('LE TEST QUI COMPTE (SÉCURITÉ) : sans le droit AVIS, le compteur de propreté n existe pas non plus', () => {
  // ⚠ LE COMPTEUR A CHANGÉ DE BLOC, PAS DE DROIT. Il lit `fiche.avis`, donc le
  // domaine `avis` : le déplacer dans un bloc gardé par `menage` aurait pu le
  // faire survivre à un refus du domaine dont il vient — c est précisément ce
  // que l étape 0 interdit, « on ne montre jamais ce qui mient d un refus ».
  // ⚠ ET LE JSON PEUT PORTER LA DONNÉE QUAND MÊME. « Le JSON peut le porter,
  // l'écran le cache » (règle de Thierry du 20 octobre) : le compteur ne doit pas
  // dépendre du fait que le serveur ait AUSSI vidé le champ. Contre-épreuve du
  // 21 octobre : sans cette moitié du test, retirer la garde `refuses` du rendu
  // ne faisait rougir personne — `avis: null` suffisait à masquer l'oubli.
  const porte = doc(M.ficheHtml(
    fiche({ refuses: ['avis'] }), OUTILS(), {}))
  assert.equal(porte.querySelector('[data-proprete]'), null,
    'droit refusé : même avec les chiffres dans la réponse, l écran ne les montre pas')
  assert.equal(porte.querySelector('[data-pouce]'), null)
  assert.ok(blocNomme(porte, 'Ménage'), 'et le bloc Ménage reste')

  const d = doc(M.ficheHtml(
    fiche({ avis: null, refuses: ['avis'] }), OUTILS(), {}))
  const menage = blocNomme(d, 'Ménage')
  assert.ok(menage, 'le bloc Ménage, lui, reste : son droit n est pas refusé')
  assert.match(menage.textContent, /Regina/)
  assert.equal(d.querySelector('[data-proprete]'), null, 'aucun compteur')
  assert.equal(d.querySelector('[data-pouce]'), null)
  // Et le refus ne se dit pas : un bloc refusé n est pas rendu.
  assert.doesNotMatch(d.querySelector('#c').textContent, /propreté|avis/i)
})

test('LE TEST QUI COMPTE : chaque compteur porte SON pouce — vers le haut, vers le bas, en attente', () => {
  // ⚠ DEUX MUTATIONS SURVIVAIENT (revue de f1d6cbd) : rendre `i-thumb-up` pour
  // les DEUX compteurs, ou ne rendre aucune icône, ne faisait rougir personne.
  // C'est pourtant l'inverse exact de la demande — et pour qui ne perçoit pas la
  // couleur, l'icône est la seule marque VISIBLE qui distingue les deux chiffres.
  const d = doc(M.ficheHtml(
    fiche({ avis: { ...fiche().avis, positif: 3, remarque: 1, non_analyses: 2 } }), OUTILS(), {}))
  const ic = (id) => d.querySelector(`[data-pouce="${id}"] [data-icone]`).dataset.icone
  assert.equal(ic('positif'), 'i-thumb-up')
  assert.equal(ic('remarque'), 'i-thumb-down')
  assert.equal(ic('attente'), 'i-circle-dashed')
})

test('LE TEST QUI COMPTE (ACCESSIBILITÉ) : le libellé est là pour la VOIX et pour la SOURIS', () => {
  // « Sans légende » vaut pour le TEXTE à l'écran. Qui ne perçoit pas la couleur
  // n'a, à la souris, aucun moyen d'apprendre ce que valent « 3 » et « 1 » :
  // c'est la leçon déjà écrite pour les pastilles de la liste (`.sr-only` pour
  // la voix, `title` pour la souris), et le compteur ne portait que la moitié.
  const d = doc(M.ficheHtml(
    fiche({ avis: { ...fiche().avis, positif: 3, remarque: 1, non_analyses: 2 } }), OUTILS(), {}))
  for (const [id, mot] of [['positif', 'propreté saluée'], ['remarque', 'remarques'], ['attente', 'pas encore analysés']]) {
    const el = d.querySelector(`[data-pouce="${id}"]`)
    assert.equal(el.getAttribute('title'), mot, `${id} : le titre pour la souris`)
    assert.ok(el.querySelector('.sr-only').textContent.includes(mot), `${id} : le libellé pour la voix`)
  }
})

test('LE TEST QUI COMPTE : la séparation du compteur existe, et sa règle aussi', () => {
  // La décision « mesurée sur le banc » du 21 octobre : collé sous la dernière
  // prestataire, le compteur se lisait comme SA note. Deux mutations
  // survivaient — retirer la classe de l'une ou l'autre des deux formes.
  const avec = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  assert.ok(avec.querySelector('[data-proprete]').classList.contains('fic-proprete'))
  const vide = doc(M.ficheHtml(fiche({ avis: { ...fiche().avis,
    positif: 0, remarque: 0, non_analyses: 0, rien_signale: 4 } }), OUTILS(), {}))
  assert.ok(vide.querySelector('[data-proprete]').classList.contains('fic-proprete'))
  // Et la règle MORD : déclarée dans la page, APRÈS shared/ui.css, donc elle
  // l'emporte sur le `margin-top: 2px` de `.men-note` et sur `.fic-vide`.
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'logement.html'), 'utf8')
  assert.match(page, /^\s*\.fic-proprete \{[^}]*margin-top/m, '.fic-proprete doit avoir sa règle')
  assert.ok(page.indexOf('<style') < page.indexOf('.fic-proprete'))
  assert.ok(page.indexOf('shared/ui.css') < page.indexOf('<style'),
    'la feuille partagée doit être chargée AVANT le style de la page')
})

test('LE TEST QUI COMPTE : un `avis` MAL FORMÉ ne fait rien AFFIRMER au bloc Ménage', () => {
  // ⚠ REVUE DE f1d6cbd. `Number(x) || 0` ramenait tout à zéro : avec `{}`,
  // `'oui'` ou `42`, le bloc Ménage disait « Aucun avis sur 30 jours » pendant
  // que le bloc Avis disait « pas lisibles ». Deux états pour une seule source,
  // et c'est le Ménage qui inventait. Même garde que `avisAffiche` pour la note.
  for (const malForme of [{}, 'oui', 42, true, [], { positif: 3 }]) {
    const d = doc(M.ficheHtml(fiche({ avis: malForme }), OUTILS(), {}))
    const menage = blocNomme(d, 'Ménage')
    assert.equal(menage.querySelector('[data-proprete]'), null, `avis=${JSON.stringify(malForme)}`)
    assert.doesNotMatch(menage.textContent, /Aucun avis|Rien signalé/,
      `avis=${JSON.stringify(malForme)} : rien d'affirmé sur une réponse illisible`)
    assert.doesNotMatch(d.querySelector('#c').textContent, /null|undefined|NaN/)
  }
})

test('LE TEST QUI COMPTE : un `avis` tordu ne fait pas TOMBER la fiche', () => {
  // `poucesAffiches` rend `null` sur tout ce qui n'est pas lisible, et le
  // compteur lisait `p.vide` sans garde : `avis: 0` levait, et la page entraînait
  // tout l'écran dans l'état « panne », avec un « Réessayer » qui ne pouvait
  // pas réussir. Une fiche se rend quand même : c'est un bloc qui se tait.
  for (const tordu of [0, false, NaN, '']) {
    const html = M.ficheHtml(fiche({ avis: tordu }), OUTILS(), {})
    assert.match(html, /fic-bloc__titre/, `avis=${String(tordu)} : la fiche doit se rendre`)
    assert.ok(doc(html).querySelector('[data-proprete]') == null)
  }
})

test('les deux fonctions exportées encaissent un `refuses` qui n est pas un tableau', () => {
  // `menageHtml` et `propreteHtml` sont `export` : un appelant futur peut leur
  // passer autre chose qu'un tableau. On NORMALISE à l'entrée plutôt que de
  // tester en chemin — `refuses || []` lançait sur un objet, et une garde de
  // droit qui lève ou qui s'efface penche toujours du mauvais côté.
  for (const tordu of [undefined, null, {}, 'avis', 42]) {
    // ⚠ DIRECTEMENT SUR `propreteHtml` : appelée par `menageHtml`, la valeur est
    // déjà normalisée en chemin, et la mutation `refuses || []` survivait à un
    // test qui passait par le bloc. On éprouve la fonction, pas son appelant.
    assert.match(String(M.propreteHtml(fiche(), OUTILS(), tordu)), /data-proprete/,
      `refuses=${JSON.stringify(tordu)} : rien n'est refusé, le compteur se rend`)
    assert.match(M.menageHtml(fiche(), OUTILS(), tordu), /data-proprete/)
  }
  // Et le vrai refus, lui, efface.
  assert.equal(M.propreteHtml(fiche(), OUTILS(), ['avis']), null)
})

test('le compteur SUIT le bloc Ménage : sans le droit prestataires, il n est plus visible', () => {
  // ⚠ CE TEST DÉCRIT UNE CONSÉQUENCE, PAS UNE RÈGLE VOULUE (constat 11 de la
  // revue de f1d6cbd, à trancher par Thierry). Le compteur est désormais gardé
  // par DEUX domaines : `menage`, parce que le bloc l'est, et `avis`, parce que
  // la donnée l'est. Un membre « avis: read, prestataires: none » le voyait la
  // veille dans le bloc Avis ; il ne le voit plus nulle part. Si Thierry tranche
  // l'inverse, c'est ICI qu'on le lira.
  const d = doc(M.ficheHtml(fiche({ menage: null, refuses: ['menage'] }), OUTILS(), {}))
  assert.equal(blocNomme(d, 'Ménage'), undefined, 'le bloc Ménage est refusé')
  assert.ok(blocNomme(d, 'Avis des voyageurs'), 'les avis, eux, restent lisibles')
  assert.equal(d.querySelector('[data-proprete]'), null, 'et le compteur part avec son bloc')
  // Et rien d'un `null` recollé dans le HTML.
  assert.doesNotMatch(d.querySelector('#c').textContent, /null/)
})

test('des avis NON LUS se disent UNE fois, dans le bloc Avis — pas deux fois pour une seule source', () => {
  // Le bloc Avis porte déjà « pas lisible ». Répéter la phrase dans le bloc
  // Ménage ferait croire à deux pannes là où une seule lecture a échoué.
  const d = doc(M.ficheHtml(fiche({ avis: null, indisponibles: ['avis'] }), OUTILS(), {}))
  const dits = [...d.querySelectorAll('[data-non-lu]')].filter(x => /avis/i.test(x.textContent))
  assert.equal(dits.length, 1)
  assert.ok(blocNomme(d, 'Avis des voyageurs').contains(dits[0]))
  assert.equal(blocNomme(d, 'Ménage').querySelector('[data-proprete], [data-non-lu]'), null)
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Réglages
// ═══════════════════════════════════════════════════════════════════════════

test('les réglages disent la serrure et le barème, en LECTURE seulement', () => {
  const d = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  const txt = d.querySelector('.fic-reglages').textContent
  assert.match(txt, /Serrure1 serrure/)
  assert.match(txt, /Taxe de séjourBagnères/)
  // ⚠ LE BARÈME SEUL : aucun montant collecté ne figure ici (décision de
  // Thierry du 20 octobre) — ils restent sous `facturation`.
  assert.doesNotMatch(txt, /€|collect/i)
})

test('`origine: absent` vaut « aucun barème », pas un bloc vide qui a l air plein', () => {
  const d = doc(M.ficheHtml(
    fiche({ taxe: { connue: false, motif: 'aucune_taxe_transmise' } }), OUTILS(), {}))
  assert.match(d.querySelector('.fic-reglages').textContent, /Aucun barème transmis/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Les états qui ne sont pas une fiche
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : 404, 403 et 503 ne se disent pas de la même façon', () => {
  assert.equal(M.etatDeLaPage({ erreur: { status: 404 } }), 'introuvable')
  assert.equal(M.etatDeLaPage({ erreur: { status: 403 } }), 'refus')
  assert.equal(M.etatDeLaPage({ erreur: { status: 503 } }), 'panne')
  // Une réponse mal formée est une PANNE, jamais une fiche vide.
  for (const f of [null, {}, 'oui', [], { bien: null }]) {
    assert.equal(M.etatDeLaPage({ fiche: f }), 'panne', JSON.stringify(f))
  }
  assert.equal(M.etatDeLaPage({ fiche: fiche() }), 'fiche')
})

test('« introuvable » propose le retour, « refus » ne propose rien', () => {
  const intro = doc(M.etatHtml('introuvable'))
  assert.ok(intro.querySelector('a[href="/logements"]'))
  const refus = doc(M.etatHtml('refus'))
  assert.equal(refus.querySelector('a, button'), null, 'on ne propose pas ce qui mène à un refus')
  const panne = doc(M.etatHtml('panne'))
  assert.ok(panne.querySelector('[data-bind="reessayer"]'))
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Les gardes de forme
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : aucun texte en dur — toute chaîne visible vient de l i18n', () => {
  CLES.clear(); RENDUS.clear()
  const html = [
    M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }),
    M.ficheHtml(fiche({ menage: [], serrures: [], canaux: [], taxe: { connue: false },
      suppression: { possible: false, motif: 'annonce_reliee' },
      avis: { ...fiche().avis, positif: 0, remarque: 0, non_analyses: 0 } }), OUTILS(), { peutSupprimer: true }),
    M.ficheHtml(fiche({ menage: null, serrures: null, canaux: null, taxe: null, fait_date: null,
      indisponibles: ['menage', 'serrures', 'canaux', 'taxe'] }), OUTILS(), {})
  ].join('')
  const d = doc(html)
  const rendus = [...RENDUS]
  for (const n of d.querySelectorAll('.fic-ligne__cle, .fic-bloc__titre, .fic-vide, [data-non-lu], [data-raison], [data-proprete]')) {
    const texte = n.textContent.trim()
    if (!texte) continue
    const couvert = rendus.some(tr => {
      const nu = String(tr).replace(/\{[^}]*\}/g, '').trim()
      // ⚠ UN LIBELLÉ COURT SE COMPARE EN ENTIER. « Nom » n'a aucun mot de plus
      // de trois lettres : le filtrer par mots le rendait introuvable, et le
      // test criait au texte en dur sur une clé bel et bien traduite.
      const motif = nu.split(/\s+/).filter(m => m.length > 3)
      return motif.length ? motif.every(m => texte.includes(m)) : texte === nu
    })
    assert.ok(couvert, `texte non traduit : « ${texte} »`)
  }
  const posees = [...d.querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n)
  for (const cle of posees) assert.ok(FR[cle] != null, `clé posée et absente de fr.json : ${cle}`)
  assert.ok(CLES.size >= 20, `${CLES.size} clés seulement : le rendu n a pas été exercé`)
})

test('aucun hexa dans le module : les couleurs viennent des jetons', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'logement-fiche.js'), 'utf8')
  assert.deepEqual(source.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [])
})

test('LE TEST QUI COMPTE (SÉCURITÉ) : rien de ce que le partenaire écrit ne s exécute', () => {
  const piege = fiche({
    bien: { ...fiche().bien, nom: '<img src=x onerror=alert(1)>', adresse: '<script>alert(2)</script>', ville: '"><b>x</b>' },
    menage: [{ id: 'm', prenom: '<img src=y onerror=alert(3)>', nom: null, rang: 1 }],
    taxe: { connue: true, commune: '<svg onload=alert(4)>' }
  })
  const d = doc(M.ficheHtml(piege, OUTILS(), { peutSupprimer: true }))
  assert.equal(d.querySelectorAll('img, script, svg:not([data-icone])').length, 0)
  // ⚠ `<b>` N'EST PLUS INTERDIT EN BLOC, IL EST SITUÉ : le compteur de
  // propreté en porte un par chiffre, comme l'écran Ménages. Le piège de la
  // fixture est `'"><b>x</b>'` sur la ville : s'il s'exécutait un jour, il
  // produirait un `<b>` HORS du compteur — et c'est ce que ce test mesure.
  for (const b of d.querySelectorAll('b')) {
    assert.ok(b.parentElement.hasAttribute('data-pouce'),
      `« ${b.outerHTML} » : un \`<b>\` hors du compteur, donc du balisage injecté`)
  }
  assert.match(d.querySelector('.fic-nom').textContent, /^<img src=x/)
})

test('LE TEST QUI COMPTE : aucun identifiant du partenaire ne peut atteindre l écran', () => {
  // ⚠ CE TEST ÉTAIT INERTE (revue de 5c0d759) : il rendait la fixture par
  // défaut, qui ne porte AUCUN champ `provider_*`, et cherchait cinq mots. Si
  // `publier()` se mettait à descendre `provider_property_id`, le rendu
  // afficherait sa VALEUR — un UUID chez Channex, un nombre chez Beds24 — et
  // aucun des cinq mots. Le test ne pouvait pas rougir.
  //
  // On empoisonne donc la fiche avec les champs interdits, porteurs d une
  // valeur RECONNAISSABLE, et on exige qu elle n atteigne pas l écran.
  const MARQUEUR = 'ZZIDPARTENAIREZZ'
  const piege = fiche()
  for (const champ of ['provider', 'provider_property_id', 'provider_rate_plan_id',
    'provider_room_type_id', 'migration_target_property_id']) {
    piege.bien[champ] = MARQUEUR
  }
  piege.canaux = piege.canaux.map(c => ({ ...c, provider_property_id: MARQUEUR, rate_plan_id: MARQUEUR }))
  piege.menage = piege.menage.map(m => ({ ...m, provider_id: MARQUEUR }))
  const d = doc(M.ficheHtml(piege, OUTILS(), { peutSupprimer: true }))
  assert.doesNotMatch(d.querySelector('#c').innerHTML, new RegExp(MARQUEUR),
    'un identifiant du partenaire descendu par erreur ne doit pas se rendre')

  // Et les NOMS de colonne non plus, au cas où l un deviendrait un attribut.
  for (const mot of ['channex', 'beds24', 'provider_property_id', 'rate_plan', 'room_type']) {
    assert.doesNotMatch(d.querySelector('#c').innerHTML, new RegExp(mot, 'i'),
      `« ${mot} » ne doit jamais atteindre l écran`)
  }

  // ⚠ CE QUE CE TEST NE COUVRE PAS, ET IL FAUT LE DIRE : `libelleDuCanal`
  // retombe sur `c.titre`, le titre que le PARTENAIRE rend. Un hôte qui a
  // nommé son annonce « Airbnb compte Éric » chez le partenaire le verra tel
  // quel dans la pastille. Ce n est pas un identifiant au sens de la règle
  // (« jamais le nom du partenaire à l écran »), c est le texte de l hôte —
  // mais ce n est pas un hasard non plus, et ça se décide, pas se découvre.
})

test('toute icône demandée par le module existe au sprite — liste DÉCOUVERTE, pas recopiée', () => {
  // Une liste d'icônes écrite à la main ici ne dirait rien le jour où le module
  // en demande une de plus : un `<use href>` cassé ne rend RIEN, sans erreur de
  // console, et le pouce disparaît en silence.
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'logement-fiche.js'), 'utf8')
  const sprite = fs.readFileSync(path.join(__dirname, '..', 'shared', 'icons.svg'), 'utf8')
  const demandees = [...new Set([...source.matchAll(/'(i-[\w-]+)'/g)].map(m => m[1]))]
  assert.ok(demandees.length >= 3, `${demandees.length} icône(s) trouvée(s) : la découverte a échoué`)
  for (const id of demandees) {
    assert.ok(sprite.includes(`id="${id}"`), `icône ${id} absente de shared/icons.svg`)
  }
  // Et aucune forme dessinée dans le module : le sprite seul.
  assert.equal(source.match(/<(path|circle|rect|polyline|line)\b/), null)
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. Quand les canaux ont été relevés — et si le relevé a échoué
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : des pastilles « en vente » DISENT de quand elles datent', () => {
  // Sans la date, un état de trois jours se lit comme l'état d'aujourd'hui.
  const d = doc(M.ficheHtml(fiche({ canaux_vu_le: new Date().toISOString() }), OUTILS(), {}))
  const l = d.querySelector('[data-fraicheur]')
  assert.equal(l.dataset.fraicheur, 'fraiche')
  assert.match(l.textContent, /Canaux vérifiés/)
})

test('LE TEST QUI COMPTE : un relevé EN ÉCHEC ne se lit pas comme un succès', () => {
  const d = doc(M.ficheHtml(fiche({ canaux_echec: true }), OUTILS(), {}))
  const l = d.querySelector('[data-fraicheur]')
  assert.equal(l.dataset.fraicheur, 'echec')
  assert.equal(l.textContent, 'Le dernier relevé des canaux a échoué.')
  // L'échec PASSE DEVANT la date : « vérifié il y a 2 minutes » sur un relevé
  // qui a échoué serait faux.
  assert.doesNotMatch(l.textContent, /vérifiés/)
})

test('au-delà de 24 heures, on DIT que la vérification date — la règle vient du module commun', async () => {
  const liste = await import('../shared/logements-liste.js')
  // Dates RELATIVES : ce test lit l'horloge, il ne l'injecte pas.
  const vieux = new Date(Date.now() - liste.VIEUX_MS - 60000).toISOString()
  const d = doc(M.ficheHtml(fiche({ canaux_vu_le: vieux }), OUTILS(), {}))
  const l = d.querySelector('[data-fraicheur]')
  assert.equal(l.dataset.fraicheur, 'vieille')
  assert.match(l.textContent, /non vérifiés depuis/)
  // Et le seuil est CELUI du module commun, pas une copie : juste en deçà,
  // la ligne redevient ordinaire.
  const frais = new Date(Date.now() - liste.VIEUX_MS + 600000).toISOString()
  assert.equal(doc(M.ficheHtml(fiche({ canaux_vu_le: frais }), OUTILS(), {}))
    .querySelector('[data-fraicheur]').dataset.fraicheur, 'fraiche')
})

test('jamais de relevé : aucune ligne inventée', () => {
  const d = doc(M.ficheHtml(fiche({ canaux_vu_le: null, canaux_echec: false }), OUTILS(), {}))
  assert.equal(d.querySelector('[data-fraicheur]'), null)
  // Et sur des canaux NON LUS, le bloc dit l'ignorance, sans date.
  const nl = doc(M.ficheHtml(fiche({ canaux: null, indisponibles: ['canaux'] }), OUTILS(), {}))
  assert.equal(nl.querySelector('[data-fraicheur]'), null)
  assert.ok(nl.querySelector('[data-non-lu]'))
})

test('LE TEST QUI COMPTE : la FORME des rendus partagés vit dans shared/ui.css, en un seul endroit', () => {
  // ⚠ MESURÉ LE 21 OCTOBRE 2026 : `canauxHtml` est appelé par la liste ET par
  // la fiche, mais ses règles vivaient dans `pages/logements.html`. La fiche
  // rendait « AirbnbBooking.comReservation directe » — sans pastille, sans
  // point d'état, sans gouttière. Deux copies divergent ; une seule, non.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  const PARTAGEES = ['.log-canaux', '.log-pastille', '.log-point',
    '.log-pastille--vente', '.log-pastille--pas-ce-bien', '.log-pastille--indetermine',
    '.log-avis', '.log-avis--muet',
    // La famille du compteur de propreté, partagée avec l'écran Ménages depuis
    // la correction du 21 octobre 2026 : deux écrans, une seule charte.
    '.men-note', '.men-note__bon', '.men-note__mauvais', '.men-note--vide',
    '.men-note__attente']
  for (const sel of PARTAGEES) {
    assert.ok(new RegExp(`^${sel.replace('.', '\\.')}[\\s,{]`, 'm').test(ui),
      `${sel} absent de shared/ui.css`)
  }
  // Et AUCUNE page ne les redéfinit — sauf un `grid-area` de mise en page,
  // qui est propre à la grille de la liste au téléphone.
  const pages = path.join(__dirname, '..', 'pages')
  for (const f of fs.readdirSync(pages).filter(x => x.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(pages, f), 'utf8')
    const bloc = src.slice(src.indexOf('<style'), src.lastIndexOf('</style>'))
    for (const sel of PARTAGEES) {
      for (const m of bloc.matchAll(new RegExp(`^\\s*${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'gm'))) {
        const corps = m[1].replace(/grid-area:[^;]*;?/g, '').trim()
        assert.equal(corps, '', `${f} redéfinit ${sel} : deux copies vont diverger`)
      }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 11. L'en-tête dit ce que l'endpoint descend — assistant, calendrier
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : un assistant EN PAUSE se dit sur la fiche, comme sur la carte', () => {
  // Mesuré le 21 octobre 2026 : `assistant_en_pause` descendait depuis
  // l'étape 0 et la fiche n'en disait rien. Aucun message ne part pour ce
  // logement, et l'écran le taisait.
  const d = doc(M.ficheHtml(fiche({ bien: { ...fiche().bien, assistant_en_pause: true } }), OUTILS(), {}))
  const s = d.querySelector('[data-signal="pause"]')
  assert.ok(s, 'la pause doit être visible')
  assert.match(s.textContent, /Assistant en pause/)
  // Et rien d'inventé quand il tourne.
  assert.equal(doc(M.ficheHtml(fiche(), OUTILS(), {})).querySelector('[data-signal]'), null)
})

test('le lien Calendrier mène au bien DEMANDÉ, par la route déclarative', () => {
  const d = doc(M.ficheHtml(fiche({ bien: { ...fiche().bien, id: 'a b/c' } }), OUTILS(), {}))
  const a = d.querySelector('[data-bind="calendrier"]')
  assert.equal(a.getAttribute('href'), '/calendrier?bien=a%20b%2Fc',
    'un identifiant non encodé casserait l URL')
  // Sans identifiant, pas de lien mort.
  assert.equal(doc(M.ficheHtml(fiche({ bien: { ...fiche().bien, id: null } }), OUTILS(), {}))
    .querySelector('[data-bind="calendrier"]'), null)
})

test('LE TEST QUI COMPTE : la barre du bas ne couvre pas la fin des deux écrans', () => {
  // ⚠ MESURÉ AU BANC LE 21 OCTOBRE 2026, à 390 px : la dernière ligne du bloc
  // « Réglages » passait SOUS la barre, de 23 px. `.bottombar` est `fixed`,
  // donc le défaut revient sur toute page qui défile.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  const m = ui.match(/\.log-page,\s*\.fic-page\s*\{[^}]*padding-bottom:\s*calc\(96px \+ env\(safe-area-inset-bottom\)\)/)
  assert.ok(m, 'la marge qui dégage la barre doit vivre dans shared/ui.css, pour les DEUX écrans')

  // ⚠ ET AU MÊME POINT DE RUPTURE QUE LA BARRE (revue de 5c0d759). La marge
  // était à 860 px, la barre à 720 : entre les deux, 96 px de vide sans barre
  // à dégager, et la couverture du vrai défaut ne tenait que parce que
  // 860 > 720. Un garde-fou qui tient par hasard n'en est pas un.
  const rupture = (sel) => {
    const blocs = [...ui.matchAll(/@media \(max-width:\s*(\d+)px\)\s*\{/g)]
    let dernier = null
    for (const b of blocs) {
      const fin = ui.indexOf('\n}', b.index)
      if (ui.slice(b.index, fin).includes(sel)) dernier = Number(b[1])
    }
    return dernier
  }
  assert.equal(rupture('.log-page, .fic-page'), rupture('.bottombar {'),
    'la marge et la barre doivent apparaître à la même largeur')
  // ⚠ ET AUCUNE PAGE NE REDÉCLARE LE CONTENEUR : un `padding` raccourci
  // déclaré après la feuille commune écrase son `padding-bottom`, et le
  // défaut revient sans qu'une seule règle ait l'air fausse.
  const pages = path.join(__dirname, '..', 'pages')
  for (const f of ['logements.html', 'logement.html']) {
    const src = fs.readFileSync(path.join(pages, f), 'utf8')
    const bloc = src.slice(src.indexOf('<style'), src.lastIndexOf('</style>'))
    assert.equal(bloc.match(/^\s*\.(log|fic)-page\s*\{[^}]*\bpadding\s*:/m), null,
      `${f} redéclare le padding du conteneur : il écraserait la marge commune`)
  }
})

test('LE TEST QUI COMPTE : un fait daté PARTIEL le dit, il ne passe pas pour vérifié', () => {
  // ⚠ Revue de 5c0d759. Quand les clés partenaire sont illisibles, le serveur
  // peut encore affirmer une FERMETURE (calculée par UUID) mais pas lire les
  // réservations : il pose `indisponibles: ['fait_date']` et son commentaire
  // dit « l'écran doit savoir qu'une réservation pourrait s'y ajouter ».
  // L'écran ne lisait ce tableau que pour `avis` : il rendait « Fermé jusqu'au
  // … » en encre normale, sans réserve, là où la moitié de la source était
  // illisible.
  const d = doc(M.ficheHtml(fiche({
    fait_date: { type: 'ferme', du: null, au: '2026-12-01' },
    indisponibles: ['fait_date']
  }), OUTILS(), {}))
  const f = d.querySelector('[data-fait]')
  assert.ok(f.hasAttribute('data-partiel'), 'le fait doit se déclarer incomplet')
  assert.match(f.textContent, /réservations n’ont pas pu être lues/)
  assert.ok(f.classList.contains('fic-muet'), 'l encre normale est la marque d un fait vérifié')
  // Le fait reste AFFICHÉ : il est vrai, il est seulement incomplet.
  assert.match(f.textContent, /Fermé/)

  // Sans le drapeau, aucune réserve inventée.
  const net = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  assert.equal(net.querySelector('[data-fait]').hasAttribute('data-partiel'), false)
  assert.doesNotMatch(net.querySelector('[data-fait]').textContent, /pas pu être lues/)

  // Et un fait ABSENT ne devient pas « partiel » : il est déjà muet et dit
  // « Information indisponible » — y ajouter une réserve dirait deux fois.
  const vide = doc(M.ficheHtml(fiche({ fait_date: null, indisponibles: ['fait_date'] }), OUTILS(), {}))
  assert.equal(vide.querySelector('[data-fait]').hasAttribute('data-partiel'), false)
  assert.equal(vide.querySelector('[data-fait]').textContent, 'Information indisponible')
})

test('LE TEST QUI COMPTE : les canaux sont dits UNE SEULE FOIS, dans leur bloc', () => {
  // Décision de Thierry du 21 octobre 2026. Avant elle, l en-tête et le bloc
  // rendaient tous deux les pastilles — la même information deux fois, dont
  // une sans son état ni sa date de relevé.
  const d = doc(M.ficheHtml(fiche({ canaux: [
    { ota: 'airbnb', titre: 'a', actif: true, mappe: true },
    { ota: 'booking', titre: 'b', actif: true, mappe: true },
    { ota: 'open', titre: 'c', actif: true, mappe: true }
  ] }), OUTILS(), {}))
  const zones = [...d.querySelectorAll('.log-canaux')]
  assert.equal(zones.length, 1, 'un seul endroit dit les canaux')
  assert.equal(zones[0].querySelectorAll('.log-pastille').length, 3)
  // Et c est bien celui qui porte AUSSI la date du relevé : l information
  // complète, ou rien.
  assert.ok(zones[0].closest('.fic-bloc'), 'les pastilles vivent dans un bloc titré')
  assert.ok(zones[0].parentElement.querySelector('[data-fraicheur]'),
    'le bloc qui garde les pastilles est celui qui dit de quand elles datent')
  // La classe vient de la feuille commune, avec sa gouttière.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  assert.match(ui, /^\.log-canaux \{[^}]*gap:/m)
})

test('LE TEST QUI COMPTE : dans Réglages, un REFUS et une INDISPONIBILITÉ ne se disent pas pareil', () => {
  // ⚠ Revue de 5c0d759 : ce bloc ne lisait pas `refuses`, et la règle « un
  // bloc refusé n'est pas rendu » n'y tenait que par la coïncidence que
  // `serrures` ET `taxe` dépendent du même domaine. Qu'un seul soit refusé, et
  // l'écran disait « La serrure n'est pas lisible pour l'instant » — le message
  // de l'indisponibilité posé sur un refus de droit.
  const refuseUn = doc(M.ficheHtml(
    fiche({ serrures: null, refuses: ['serrures'] }), OUTILS(), {}))
  const bloc = refuseUn.querySelector('.fic-reglages')
  assert.ok(bloc, 'la taxe reste, donc le bloc reste')
  assert.doesNotMatch(bloc.textContent, /Serrure/, 'un refus ne se nomme pas')
  assert.doesNotMatch(bloc.textContent, /n’est pas lisible/)
  assert.match(bloc.textContent, /Taxe de séjour/)

  // Les deux refusés : plus rien à dire, donc plus de bloc du tout.
  const refuseDeux = doc(M.ficheHtml(
    fiche({ serrures: null, taxe: null, refuses: ['serrures', 'taxe'] }), OUTILS(), {}))
  assert.equal(refuseDeux.querySelector('.fic-reglages'), null)
  assert.ok(![...refuseDeux.querySelectorAll('.fic-bloc__titre')].map(x => x.textContent)
    .includes('Réglages'))

  // Et une INDISPONIBILITÉ, elle, se dit — c'est tout l'écart.
  const nonLue = doc(M.ficheHtml(
    fiche({ serrures: null, indisponibles: ['serrures'] }), OUTILS(), {}))
  assert.match(nonLue.querySelector('.fic-reglages').textContent, /serrure n’est pas lisible/)
})

test('LE TEST QUI COMPTE : une réponse MAL FORMÉE ne devient pas « Aucune prestataire »', () => {
  // ⚠ CETTE MUTATION SURVIVAIT (contre-épreuve du 21 octobre) : remplacer
  // `Array.isArray(x)` par `x != null` ne faisait rougir aucun test. Un `{}`
  // — réponse tronquée, champ renommé côté serveur — passe `!= null`, son
  // `.length` vaut `undefined`, et l'écran affirme « Aucune prestataire sur ce
  // logement » sur un bien qui en a deux. C'est le trou que `etatDeLaPage`
  // ferme au niveau de la PAGE ; il doit descendre au grain du bloc.
  for (const malForme of [{}, 'oui', 42, true]) {
    const d = doc(M.ficheHtml(fiche({
      menage: malForme, serrures: malForme, canaux: malForme
    }), OUTILS(), {}))
    const txt = d.querySelector('#c').textContent
    assert.doesNotMatch(txt, /Aucune prestataire/, `menage=${JSON.stringify(malForme)}`)
    assert.doesNotMatch(txt, /Aucun canal relié/, `canaux=${JSON.stringify(malForme)}`)
    assert.doesNotMatch(txt, /Aucune serrure|Aucun code/, `serrures=${JSON.stringify(malForme)}`)
    // Et on le DIT : « on n'a pas pu lire » est la seule réponse honnête.
    assert.ok(d.querySelectorAll('[data-non-lu]').length >= 3,
      `${JSON.stringify(malForme)} : les trois blocs doivent se déclarer non lus`)
  }
})

// ════════════════════════════════════════════════════════════════════════
// ÉTAPE 3 — l'édition sur place
// ════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE (SÉCURITÉ) : sans droit d écriture, AUCUNE case dans le DOM', () => {
  // Spec §5 : « profil en lecture : la fiche s affiche, champs en lecture seule,
  // aucun bouton d action dans le DOM ». Le masquage est un confort ; la vraie
  // protection est le `reglages:write` du PATCH, et un test de l endpoint le
  // garde. Mais on ne propose pas ce qui mène à un 403.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: false }))
  assert.equal(d.querySelectorAll('input, textarea, select').length, 0)
  assert.equal(d.querySelectorAll('[data-champ]').length, 0)
  // Et la fiche dit quand même tout ce qu elle disait à l étape 2.
  assert.match(d.querySelector('.fic-champs').textContent, /La bulle/)
  assert.match(d.querySelector('.fic-prix').textContent, /130/)
})

test('LE TEST QUI COMPTE : chaque case porte le nom du champ CÔTÉ SERVEUR', () => {
  // ⚠ Le nom rendu et le nom envoyé viennent de la MÊME table (`CHAMPS`) : une
  // case nommée autrement que ce que `PATCH` accepte s enregistrerait dans le
  // vide, en 400, ou — pire — en silence si le serveur ignore l inconnu.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  // ⚠ L'ORDRE DU DOM N'EST PAS L'ORDRE DE LA TABLE : la colonne gauche rend
  // Prix AVANT Le logement. On éprouve donc la couverture, puis l'ordre DANS
  // chaque bloc — comparer à plat ferait rougir pour une raison de mise en page.
  const noms = [...d.querySelectorAll('[data-champ]')].map(x => x.getAttribute('name'))
  assert.deepEqual([...noms].sort(), M.CHAMPS.map(c => c.nom).sort())
  const dansLeBloc = (sel) => [...d.querySelectorAll(`${sel} [data-champ]`)].map(x => x.getAttribute('name'))
  assert.deepEqual(dansLeBloc('.fic-champs'), M.champsDuBloc('logement').map(c => c.nom))
  assert.deepEqual(dansLeBloc('.fic-prix'), M.champsDuBloc('prix').map(c => c.nom))
  // Les dix noms sont ceux du contrat de PATCH, lu dans le code du serveur.
  const serveur = fs.readFileSync(path.join(__dirname, '..', 'api', 'channel-property.js'), 'utf8')
  const contrat = serveur.slice(serveur.indexOf("if (req.method === 'PATCH')"))
    .slice(0, 400)
  for (const c of M.CHAMPS) {
    assert.ok(contrat.includes(c.nom), `${c.nom} n est pas dans le contrat du PATCH`)
  }
})

test('LE TEST QUI COMPTE : chaque case a son étiquette, et elle la DÉSIGNE', () => {
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  for (const input of d.querySelectorAll('[data-champ]')) {
    const lab = d.querySelector(`label[for="${input.id}"]`)
    assert.ok(input.id, 'une case sans id ne peut pas être étiquetée')
    assert.ok(lab, `aucune étiquette ne désigne ${input.getAttribute('name')}`)
    assert.ok(lab.textContent.trim().length > 1)
  }
})

test('LE TEST QUI COMPTE : la DEVISE n est jamais une case — le serveur ne la prend pas', () => {
  // `PATCH` n accepte pas la devise (absente de son contrat), et l ancien écran
  // le disait : « devise non editable ». Une case qu on ne peut pas enregistrer
  // est un leurre.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  assert.equal(d.querySelector('[data-champ="currency"], [data-champ="devise"]'), null)
  const ligne = d.querySelector('[data-devise]')
  assert.ok(ligne, 'la devise reste AFFICHÉE')
  assert.equal(ligne.querySelector('input'), null)
  assert.match(ligne.textContent, /EUR/)
})

test('LE TEST QUI COMPTE : le plancher par défaut ne se PRÉREMPLIT pas', () => {
  // ⚠ 10 € est une garde du moteur, pas une valeur du bien. L écrire dans la
  // case la ferait ENREGISTRER au premier passage, et le bien porterait un
  // plancher que personne n a choisi — avec, derrière, un refus du serveur si
  // le prix de base est plus bas.
  const d = doc(M.ficheHtml(
    fiche({ bien: { ...fiche().bien, prix_plancher: null } }), OUTILS(), { peutSupprimer: true }))
  assert.equal(d.querySelector('[data-champ="prix_minimum"]').value, '')
  // Et le défaut se dit SOUS la case, pas dedans.
  assert.match(d.querySelector('[data-plancher-defaut]').textContent, /10/)

  // Un plancher réel, lui, se préremplit — en euros.
  const avec = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  assert.equal(avec.querySelector('[data-champ="prix_minimum"]').value, '130')
  assert.equal(avec.querySelector('[data-plancher-defaut]'), null)
})

test('LE TEST QUI COMPTE : les champs qui reconstruisent la grille sont MARQUÉS', () => {
  // `PATCH` reconstruit le plan tarifaire chez le partenaire, EN BLOQUANT, dès
  // que l un d eux est dans le corps — même inchangé. La page ne les envoie donc
  // que s ils ont bougé, et c est cette marque qui le lui dit.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  const marques = [...d.querySelectorAll('[data-grille]')].map(x => x.getAttribute('name')).sort()
  assert.deepEqual(marques, ['base_price', 'capacity', 'extra_guest_fee', 'included_guests'])
  // Et le plancher n en est PAS : c est un refus, pas un tarif — aucune
  // poussée n en découle (commentaire du serveur).
  assert.equal(d.querySelector('[data-champ="prix_minimum"]').hasAttribute('data-grille'), false)
  assert.equal(d.querySelector('[data-champ="prix_minimum"]').getAttribute('data-euros'), '1')
})

test('chaque case a sa place pour l état et pour l erreur, et l erreur est MUETTE au départ', () => {
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  for (const ligne of d.querySelectorAll('.fic-ligne--saisie')) {
    const etat = ligne.querySelector('[data-etat]')
    assert.ok(etat, 'il faut une place pour « Enregistré »')
    assert.equal(etat.getAttribute('aria-live'), 'polite', 'et la voix doit l annoncer')
    assert.equal(etat.textContent, '', 'rien n est annoncé avant le premier enregistrement')
    const err = ligne.querySelector('[data-erreur]')
    assert.ok(err && err.hasAttribute('hidden'))
  }
})

test('LE TEST QUI COMPTE (SÉCURITÉ) : ce que le partenaire écrit ne s exécute pas, même dans une case', () => {
  const piege = fiche({ bien: { ...fiche().bien, nom: '"><img src=x onerror=alert(1)>' } })
  const d = doc(M.ficheHtml(piege, OUTILS(), { peutSupprimer: true }))
  assert.equal(d.querySelectorAll('img, script').length, 0)
  assert.equal(d.querySelector('[data-champ="name"]').value, '"><img src=x onerror=alert(1)>')
})

test('LE TEST QUI COMPTE : les quatre champs de GRILLE ont un bouton, et il dit o\u00f9 \u00e7a part', () => {
  // D\u00e9cision de Thierry du 21 octobre 2026 : \u00ab pas d'enregistrement automatique
  // [pour ces quatre-l\u00e0]. Ils passent par un bouton Enregistrer propre au bloc,
  // avec la phrase Sera envoy\u00e9 \u00e0 Airbnb et Booking.com. \u00bb Ce qui part d'ici
  // n'atteint pas que notre base : il atteint les annonces.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  const blocs = [...d.querySelectorAll('.fic-envoi')].map(x => x.dataset.envoi).sort()
  assert.deepEqual(blocs, ['logement', 'prix'],
    'les deux blocs qui portent un champ de grille, et eux seuls')
  for (const zone of d.querySelectorAll('.fic-envoi')) {
    assert.ok(zone.querySelector('[data-bind="enregistrer"]'))
    assert.match(zone.querySelector('[data-envoi-aide]').textContent, /Airbnb et Booking\.com/)
    assert.ok(zone.querySelector('[data-etat]'), 'le bloc dit son \u00e9tat, comme une case')
    assert.ok(zone.querySelector('[data-erreur]').hasAttribute('hidden'))
  }
  // Et chaque bouton d\u00e9signe SON bloc : un bouton sans cible enverrait les
  // quatre champs depuis n'importe o\u00f9.
  assert.deepEqual([...d.querySelectorAll('[data-bind="enregistrer"]')].map(b => b.dataset.bloc).sort(),
    ['logement', 'prix'])
})

test('LE TEST QUI COMPTE : le bouton d envoi n est JAMAIS d\u00e9sactiv\u00e9 au rendu', () => {
  // \u26a0 Un bouton gris\u00e9 tant qu'aucun champ n'a boug\u00e9 oblige \u00e0 cliquer DEUX
  // fois : le premier clic sort de la case \u2014 donc l'activerait \u2014 sans
  // l'atteindre. Il reste cliquable et dit \u00ab aucun changement \u00e0 envoyer \u00bb.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  for (const b of d.querySelectorAll('[data-bind="enregistrer"]')) {
    assert.equal(b.hasAttribute('disabled'), false)
  }
})

test('LE TEST QUI COMPTE (S\u00c9CURIT\u00c9) : sans droit d \u00e9criture, aucun bouton d envoi non plus', () => {
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: false }))
  assert.equal(d.querySelector('.fic-envoi'), null)
  assert.equal(d.querySelector('[data-bind="enregistrer"]'), null)
  assert.doesNotMatch(d.querySelector('#c').textContent, /Airbnb et Booking\.com/)
})
