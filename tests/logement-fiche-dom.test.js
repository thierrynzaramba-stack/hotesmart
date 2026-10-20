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
    prix_de_base: 120, prix_plancher: 60, voyageurs_inclus: 2, supplement_voyageur: 15,
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

test('la fiche rend ses sept blocs, titrés', () => {
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  const titres = [...d.querySelectorAll('.fic-bloc__titre')].map(x => x.textContent)
  assert.deepEqual(titres, [
    'Où il est en vente', 'Prix', 'Le logement', 'Supprimer ce logement',
    'Ménage', 'Avis des voyageurs', 'Réglages'
  ])
})

test('l en-tête porte le nom, la ville · capacité, les canaux et le FAIT DATÉ', () => {
  const d = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  assert.equal(d.querySelector('.fic-nom').textContent, 'La bulle')
  assert.match(d.querySelector('.fic-sous').textContent, /Bagnères · 2 voyageurs/)
  assert.ok(d.querySelector('.fic-canaux .log-pastille'), 'les pastilles viennent du module commun')
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
  assert.match(avec.querySelector('[data-plancher] .fic-ligne__val').textContent, /60\s*€/)
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
  const d = doc(M.ficheHtml(
    fiche({ suppression: { possible: false, motif: 'relie' } }), OUTILS(), { peutSupprimer: true }))
  const b = d.querySelector('[data-bind="supprimer"]')
  assert.ok(b.hasAttribute('disabled'))
  assert.equal(d.querySelector('[data-raison]').textContent, 'Déconnectez d’abord ses canaux.')
  assert.doesNotMatch(d.querySelector('.fic-supprimer').textContent, /réservations ou des messages/)
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

// ═══════════════════════════════════════════════════════════════════════════
// 6. Avis — la même note que la liste, des pouces neutres
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : la fiche dit la MÊME note que la carte de la liste', () => {
  // Décision de Thierry du 21 octobre : « les deux écrans doivent dire la même
  // chose ». Elle passe donc par le module commun, pas par un rendu d ici.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  const note = d.querySelector('.fic-avis .log-avis')
  assert.ok(note, 'la note vient de `avisHtml`, le rendu partagé')
  assert.match(note.textContent, /^4,9 \/ 5 · 336 avis/)
  assert.ok(note.querySelector('[data-icone="i-review"]'), 'la même étoile du sprite')
})

test('LE TEST QUI COMPTE : les pouces sont NEUTRES, et il n y a aucune légende sous les chiffres', () => {
  // « Les pouces servent uniquement à la propreté, en couleur neutre, jamais en
  // rouge — juste le compteur, sans légende » (Thierry, 21 octobre). La charte
  // §7 réserve le rouge à la suppression et aux erreurs.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), {}))
  const pouces = d.querySelector('[data-proprete]')
  assert.equal(pouces.querySelector('[data-pouce="positif"] .fic-pouce__n').textContent, '3')
  assert.equal(pouces.querySelector('[data-pouce="remarque"] .fic-pouce__n').textContent, '1')
  // Le libellé existe POUR LA VOIX, pas à l écran.
  assert.ok(pouces.querySelector('[data-pouce="remarque"] .sr-only').textContent.includes('remarques'))
  const visible = [...pouces.querySelectorAll('.fic-pouce')]
    .map(x => { const c = x.cloneNode(true); c.querySelectorAll('.sr-only').forEach(s => s.remove()); return c.textContent.trim() })
  assert.deepEqual(visible, ['3', '1'], 'juste le compteur, sans légende')
})

test('« pas encore analysé » ne se range pas dans « rien signalé »', () => {
  const d = doc(M.ficheHtml(
    fiche({ avis: { ...fiche().avis, positif: 1, remarque: 0, non_analyses: 2 } }), OUTILS(), {}))
  assert.equal(d.querySelector('[data-pouce="attente"] .fic-pouce__n').textContent, '2')
})

test('aucune propreté signalée sur la fenêtre : on le DIT, on n affiche pas trois zéros', () => {
  const d = doc(M.ficheHtml(
    fiche({ avis: { ...fiche().avis, positif: 0, remarque: 0, non_analyses: 0 } }), OUTILS(), {}))
  assert.equal(d.querySelector('[data-proprete="vide"]').textContent, 'Rien signalé sur 30 jours.')
  assert.equal(d.querySelector('[data-proprete]:not([data-proprete="vide"])'), null)
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
      suppression: { possible: false, motif: 'relie' },
      avis: { ...fiche().avis, positif: 0, remarque: 0, non_analyses: 0 } }), OUTILS(), { peutSupprimer: true }),
    M.ficheHtml(fiche({ menage: null, serrures: null, canaux: null, taxe: null, fait_date: null,
      indisponibles: ['menage', 'serrures', 'canaux', 'taxe'] }), OUTILS(), {})
  ].join('')
  const d = doc(html)
  const rendus = [...RENDUS]
  for (const n of d.querySelectorAll('.fic-ligne__cle, .fic-bloc__titre, .fic-vide, [data-non-lu], [data-raison], [data-proprete="vide"]')) {
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
  assert.equal(d.querySelectorAll('img, script, b, svg:not([data-icone])').length, 0)
  assert.match(d.querySelector('.fic-nom').textContent, /^<img src=x/)
})

test('LE TEST QUI COMPTE : aucun identifiant du partenaire ne peut atteindre l écran', () => {
  // L endpoint ne les descend pas (liste blanche de `publier`), mais si une
  // colonne `provider_*` y entrait un jour, ce test le dirait.
  const d = doc(M.ficheHtml(fiche(), OUTILS(), { peutSupprimer: true }))
  const txt = d.querySelector('#c').innerHTML
  for (const mot of ['channex', 'beds24', 'provider_property_id', 'rate_plan', 'room_type']) {
    assert.doesNotMatch(txt, new RegExp(mot, 'i'), `« ${mot} » ne doit jamais atteindre l écran`)
  }
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
    '.log-avis', '.log-avis--muet']
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
