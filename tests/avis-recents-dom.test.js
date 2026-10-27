// tests/avis-recents-dom.test.js — le bloc « Derniers avis » de l'accueil.
//
// Étape 2 du lot Aujourd'hui V5. Le rendu vit dans `shared/avis-recents.js` et
// pas dans la balise `<script>` de la page, précisément pour qu'il se teste ici
// sans extraction à la regex.
//
// Les quatre qui comptent :
//   1. `null` n'est pas `[]` — « Pas encore d'avis » sur une lecture ratée est
//      un mensonge, et l'hôte en a peut-être trois cent trente-six ;
//   2. un bloc REFUSÉ n'entre pas dans le DOM, il ne se masque pas ;
//   3. aucune ACTION dans ce bloc : c'est un résumé (spec §3) ;
//   4. pas d'étoiles, et jamais « 0 / 5 » quand la note est inconnue.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

let M
test.before(async () => { M = await import('../shared/avis-recents.js') })

const FR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', 'fr.json'), 'utf8'))
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// Le dictionnaire RÉEL : un test qui inventerait ses textes ne dirait rien sur
// les clés que la page demande.
const t = (cle, vars = {}) => {
  let s = FR[cle]
  assert.ok(s != null, `clé i18n absente de fr.json : ${cle}`)
  s = s.replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g, (_, k, corps) => {
    const n = Number(vars[k] ?? 0)
    const cas = {}
    corps.replace(/(=\d+|\w+)\s*\{([^{}]*)\}/g, (__, c, v) => { cas[c] = v })
    const choisi = cas[`=${n}`] ?? cas[new Intl.PluralRules('fr').select(n)] ?? cas.other ?? ''
    return choisi.replace(/#/g, String(n))
  })
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`))
}
const icone = (id) => `<svg data-icone="${id}"></svg>`
const nombre = (x, d = 1) => new Intl.NumberFormat('fr', { minimumFractionDigits: d, maximumFractionDigits: d }).format(x)
const libelleDuCanal = (c) => ({ airbnb: 'Airbnb', booking: 'Booking.com' })[String(c.ota || '').toLowerCase()] || null
const dateEnClair = (iso) => `le-${String(iso).slice(0, 10)}`
const OUTILS = { t, esc, icone, nombre, libelleDuCanal, dateEnClair }

const doc = (html) => new JSDOM(`<!doctype html><body><div id="c">${html}</div></body>`).window.document

const BIENS = [{ id: 'u1', provider_property_id: '209413', name: 'La bulle', photo_url: '/p.jpg' }]
const AVIS = (extra = {}) => ({
  id: 'a1', bien_ref: '209413', ota: 'airbnb', recu_le: '2026-10-20T10:00:00Z',
  note_sur_5: 4.8, texte: 'Séjour parfait, on reviendra.', voyageur: 'Claire B.', ...extra
})
const NOTES = { global: { note_sur_5: 4.8, notes: 336 } }

// ═══════════════════════════════════════════════════════════════════════════
// 1. Les quatre états
// ═══════════════════════════════════════════════════════════════════════════

test("LE TEST QUI COMPTE : `null` n'est pas `[]` — une lecture ratée ne dit pas « aucun avis »", () => {
  const illisible = M.vueDesAvis({ derniers: null, notes: NOTES, biens: BIENS })
  assert.equal(illisible.etat, 'illisible')
  const d = doc(M.blocAvisHtml(illisible, OUTILS))
  assert.match(d.body.textContent, /pas lisibles/)
  assert.doesNotMatch(d.body.textContent, /Pas encore/,
    'une panne de lecture affirme une absence : l hôte en a peut-être trois cents')

  const vide = M.vueDesAvis({ derniers: [], notes: NOTES, biens: BIENS })
  assert.equal(vide.etat, 'vide')
  assert.match(doc(M.blocAvisHtml(vide, OUTILS)).body.textContent, /Pas encore/)
})

test("LE TEST QUI COMPTE : un bloc REFUSÉ n'entre pas dans le DOM", () => {
  // Règle absolue du dépôt : on ne montre jamais ce qui mène à un refus, et un
  // bloc masqué par CSS reste lisible dans la source.
  const vue = M.vueDesAvis({ derniers: [AVIS()], notes: NOTES, biens: BIENS, refuse: true })
  assert.equal(vue.etat, 'refus')
  assert.equal(M.blocAvisHtml(vue, OUTILS), '')
  assert.equal(M.enTeteAvisHtml(vue, OUTILS), '')
  assert.deepEqual(vue.cartes, [], 'les avis traversent la vue d un profil qui n y a pas droit')
})

test('une liste rend une carte par avis, dans l ordre reçu', () => {
  const vue = M.vueDesAvis({
    derniers: [AVIS({ id: 'a1' }), AVIS({ id: 'a2' }), AVIS({ id: 'a3' })],
    notes: NOTES, biens: BIENS
  })
  assert.equal(vue.etat, 'liste')
  const d = doc(M.blocAvisHtml(vue, OUTILS))
  assert.deepEqual([...d.querySelectorAll('[data-avis]')].map(x => x.dataset.avis), ['a1', 'a2', 'a3'])
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Ce qu'une carte dit, et ce qu'elle ne dit pas
// ═══════════════════════════════════════════════════════════════════════════

test("LE TEST QUI COMPTE : aucune ACTION dans ce bloc", () => {
  // Spec §3 : ni répondre, ni évaluer — c'est un résumé. Un bouton ici ouvrirait
  // un geste que ce lot ne livre pas, et une carte cliquable mènerait nulle part.
  const vue = M.vueDesAvis({ derniers: [AVIS()], notes: NOTES, biens: BIENS })
  const d = doc(M.blocAvisHtml(vue, OUTILS))
  assert.equal(d.querySelectorAll('button, a, [data-bind]').length, 0,
    'une action est rendue dans une carte d avis')
})

test("LE TEST QUI COMPTE : pas d'étoiles, et jamais « 0 / 5 » sur une note inconnue", () => {
  const avecNote = doc(M.blocAvisHtml(M.vueDesAvis({ derniers: [AVIS()], notes: NOTES, biens: BIENS }), OUTILS))
  assert.match(avecNote.body.textContent, /4,8 \/ 5/, 'la note se lit en chiffres')
  assert.equal(avecNote.querySelectorAll('[data-icone="i-review"]').length, 0,
    'une étoile est rendue : la spec les interdit, et une demi-étoile ne se lit pas à la voix')

  // ⚠ `null` = l'échelle de la source est inconnue (dette 76). Afficher « 0 / 5 »
  // serait la pire valeur possible sur un avis peut-être excellent.
  const sansNote = doc(M.blocAvisHtml(
    M.vueDesAvis({ derniers: [AVIS({ note_sur_5: null })], notes: NOTES, biens: BIENS }), OUTILS))
  assert.doesNotMatch(sansNote.body.textContent, /0 \/ 5/)
  assert.equal(sansNote.querySelector('.avis-note'), null, 'la pastille reste vide plutôt que fausse')
  assert.match(sansNote.body.textContent, /Séjour parfait/, 'le commentaire, lui, reste affiché')
})

test('un bien introuvable ne fait pas disparaître l avis', () => {
  // `property_id_ref` n'a pas de clé étrangère : un re-keying ou un bien
  // supprimé laisse des avis dont la référence ne désigne plus rien
  // (avis-voyageurs.md §15). La carte se rend sans nom de logement.
  const vue = M.vueDesAvis({ derniers: [AVIS({ bien_ref: 'disparu' })], notes: NOTES, biens: BIENS })
  assert.equal(vue.etat, 'liste')
  assert.equal(vue.cartes[0].bien, null)
  const d = doc(M.blocAvisHtml(vue, OUTILS))
  assert.match(d.body.textContent, /Airbnb/, 'le reste du contexte survit')
  assert.doesNotMatch(d.body.textContent, /La bulle/)
})

test('la jointure se fait sur la clé PROVIDER, jamais sur l UUID', () => {
  // CLAUDE.md : « properties.id = UUID ; property_id des tables enfant = TEXT ».
  // Joindre sur l UUID rendrait toutes les cartes sans logement.
  const vue = M.vueDesAvis({ derniers: [AVIS({ bien_ref: 'u1' })], notes: NOTES, biens: BIENS })
  assert.equal(vue.cartes[0].bien, null,
    'la vue a joint sur properties.id : la clé d un avis est la clé provider')
})

test('sans droit `reservations`, la carte se rend sans nom de voyageur', () => {
  const vue = M.vueDesAvis({ derniers: [AVIS({ voyageur: null })], notes: NOTES, biens: BIENS })
  const d = doc(M.blocAvisHtml(vue, OUTILS))
  assert.equal(d.querySelector('.avis-qui'), null)
  assert.match(d.body.textContent, /La bulle · Airbnb/, 'le contexte ne doit pas garder un séparateur orphelin')
})

test('le texte du voyageur est ÉCHAPPÉ', () => {
  const vue = M.vueDesAvis({
    derniers: [AVIS({ texte: '<img src=x onerror=alert(1)> "parfait"', voyageur: '<b>Claire</b>' })],
    notes: NOTES, biens: BIENS
  })
  const d = doc(M.blocAvisHtml(vue, OUTILS))
  assert.equal(d.querySelectorAll('img').length, 1, 'seule la photo du bien est une image')
  assert.equal(d.querySelector('.avis-qui b'), null)
  assert.match(d.body.textContent, /onerror=alert\(1\)/, 'le texte s affiche, comme texte')
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. L'en-tête chiffré
// ═══════════════════════════════════════════════════════════════════════════

test("LE TEST QUI COMPTE : la moyenne et le compte parlent de la MÊME population", () => {
  // `notesDuPerimetre` ne rend que les avis NOTÉS. Afficher le total des avis à
  // côté d une moyenne calculée sur un sous-ensemble ferait deux chiffres qui
  // ne parlent pas de la même chose — « 336 avis visibles dont 332 notes » est
  // mesuré en production et nommé dans lib/logement/lecture.js.
  const vue = M.vueDesAvis({ derniers: [AVIS()], notes: { global: { note_sur_5: 4.7, notes: 332 } }, biens: BIENS })
  assert.equal(vue.note_sur_5, 4.7)
  assert.equal(vue.nombre, 332)
  const d = doc(M.enTeteAvisHtml(vue, OUTILS))
  assert.match(d.body.textContent, /4,7 \/ 5/)
  // ⚠ « NOTES », ET C'EST LE POINT DU TEST. Le libelle disait « N avis » la ou
  // il compte les avis NOTES — deux populations sous un seul mot.
  assert.match(d.body.textContent, /332 avis notés sur 30 jours/)
})

test("une moyenne illisible n'emporte pas les commentaires", () => {
  // Deux lectures du même appel d écran, qui peuvent échouer séparément.
  const vue = M.vueDesAvis({ derniers: [AVIS()], notes: null, biens: BIENS })
  assert.equal(vue.etat, 'liste', 'les commentaires disparaissent avec la moyenne')
  assert.equal(vue.note_sur_5, null)
  assert.equal(M.enTeteAvisHtml(vue, OUTILS), '', 'un en-tête sans chiffre ne se rend pas')
  assert.match(doc(M.blocAvisHtml(vue, OUTILS)).body.textContent, /Séjour parfait/)
})

test('la note descend déjà sur 5 : le bloc ne la reconvertit jamais', () => {
  // L invariant que la bande « Note · 30 j », retirée à l étape 1, portait
  // jusqu ici. Colomiers affichait 4,8 pour un calcul juste à 4,7 quand la page
  // divisait une moyenne déjà arrondie.
  const vue = M.vueDesAvis({ derniers: [AVIS({ note_sur_5: 4.7 })], notes: { global: { note_sur_5: 4.7, notes: 69 } }, biens: BIENS })
  const texte = doc(M.enTeteAvisHtml(vue, OUTILS)).body.textContent
    + doc(M.blocAvisHtml(vue, OUTILS)).body.textContent
  assert.doesNotMatch(texte, /2,3|2,4/, 'la note a été redivisée')
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. La forme vit dans la feuille partagée
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : la FORME du bloc vit dans shared/ui.css, en un seul endroit', () => {
  // Même règle que `.log-canaux` et `.log-etat` : un rendu partagé dont la
  // forme vit dans une page ne se voit nulle part ailleurs — et deux copies
  // divergent.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  for (const sel of ['.grid-avis', '.avis-carte', '.avis-photo', '.avis-note', '.avis-texte', '.clamp-3']) {
    assert.ok(new RegExp(`^${sel.replace('.', '\\.')}[\\s,{]`, 'm').test(ui), `${sel} absent de shared/ui.css`)
  }
  // ⚠ ET LA GRILLE SE DÉCLARE AVANT LA RÈGLE DU TÉLÉPHONE. `.scroll-x` et
  // `.grid-avis` ont la MÊME spécificité : c est l ordre de déclaration qui
  // tranche, pas la media query. Déclarée après, elle remettrait `display: grid`
  // au téléphone et le défilement horizontal n aurait jamais lieu.
  const iGrille = ui.indexOf('\n.grid-avis {')
  const iMobile = ui.indexOf('.scroll-x .avis-carte')
  assert.ok(iGrille > 0 && iMobile > 0, 'les deux règles doivent exister')
  assert.ok(iGrille < iMobile,
    '.grid-avis est déclarée APRÈS la règle du téléphone : elle l écrase, et la bande ne défile plus')
})
