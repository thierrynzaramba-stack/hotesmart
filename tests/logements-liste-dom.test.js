// tests/logements-liste-dom.test.js — LA LISTE V5 DES LOGEMENTS, en jsdom.
//
// Étape 1 du lot Logements. Le rendu vit dans `shared/logements-liste.js` et pas
// dans la balise `<script>` de la page, précisément pour qu'il se teste ici sans
// extraction à la regex.
//
// Les trois qui comptent :
//   1. un fait daté qu'on n'a pas pu lire ne devient JAMAIS « Libre » ;
//   2. « aucun canal relié » et « canaux non vérifiés » sont deux rendus
//      DIFFÉRENTS — les confondre est le défaut que la dette 59 a fermé ;
//   3. « Ajoutez votre premier logement » ne s'affiche que sur une lecture
//      RÉUSSIE et vide, jamais sur une panne.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

let M
test.before(async () => { M = await import('../shared/logements-liste.js') })

// Le dictionnaire RÉEL, pas un double : un test qui inventerait ses propres
// textes ne dirait rien sur les clés que la page demande.
const FR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', 'fr.json'), 'utf8'))
const CLES_DEMANDEES = new Set()
// ⚠ ON GARDE AUSSI LE TEXTE RENDU, pas seulement la cle. La garde « aucun texte
// en dur » comparait le texte affiche a la chaine BRUTE du dictionnaire : une
// cle a pluriel ICU (`{n, plural, one {# avis} other {# avis}}`) n'y survit pas
// — ses mots litteraux sont dans les accolades que la garde efface. Comparer au
// RENDU est a la fois plus simple et plus exigeant.
const RENDUS = new Set()
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const t = (cle, vars = {}) => {
  CLES_DEMANDEES.add(cle)
  // ⚠ LE DOUBLE EST AUSSI STRICT QUE LE MOTEUR. `shared/i18n/i18n.js` declare
  // `t(key, vars = {})` — un defaut qui ne couvre que `undefined` — et reduit
  // les pluriels en lisant `vars[cle]` SANS GARDE. Passer `null` y leve, et
  // faisait tomber toute la liste dans l'etat « panne » sur une carte dont les
  // avis ne sont pas lus. Un double plus permissif que le produit laisse passer
  // exactement ce defaut-la.
  assert.notEqual(vars, null, `t('${cle}') appele avec \`null\` : le moteur reel leve`)
  let s = FR[cle]
  assert.ok(s != null, `clé i18n absente de fr.json : ${cle}`)
  // Pluriels ICU, réduits à ce que le moteur du dépôt fait.
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
const dateEnClair = (iso) => `le-${iso}`
const icone = (id) => `<svg data-icone="${id}"></svg>`
// `I18n.num`, reduit a ce que le moteur du depot fait en francais : la virgule
// decimale. Un test qui formaterait en anglais laisserait passer « 4.9 ».
const nombre = (x) => new Intl.NumberFormat('fr', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(x)
const OUTILS = (extra = {}) => ({ t, esc, dateEnClair, icone, nombre, ...extra })

const doc = (html) => new JSDOM(`<!doctype html><body><div id="c">${html}</div></body>`).window.document

const bien = (extra = {}) => ({
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', nom: 'La bulle', ville: 'Bagnères',
  capacite: 2, photo_url: null, assistant_en_pause: false, canaux_echec: false,
  canaux: [{ ota: 'airbnb', titre: 'x', actif: true, mappe: true, listing_url: null }],
  fait_date: { type: 'libre', du: null, au: null, occupe: false, ferme: false },
  avis: { total: 0, notes: 0, note_sur_5: null },
  ...extra
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. Le fait daté
// ═══════════════════════════════════════════════════════════════════════════

// ⚠ LA CARTE NE PORTE PLUS LE FAIT DATE (demande de Thierry, 20 octobre 2026 :
// « au lieu de Fermé jusqu'au mercredi 21 octobre, met les avis total sur le
// logement »). La REGLE, elle, reste eprouvee ici : c'est elle qui compte, et la
// fiche (etape 2) la consomme.

test('LE TEST QUI COMPTE : un fait daté NON LU ne devient jamais « Libre »', () => {
  const dit = M.faitDateAffiche(null)
  assert.equal(dit.cle, 'logements.fait_indisponible')
  assert.equal(dit.muet, true)
  assert.doesNotMatch(t(dit.cle), /Libre/,
    'afficher « Libre » sur un bien dont on n a pas pu lire les réservations est un mensonge commercial')
})

test('les cinq types de fait daté donnent cinq phrases distinctes', () => {
  const phrase = (fait) => { const d = M.faitDateAffiche(fait); return t(d.cle, Object.fromEntries(Object.entries(d.valeurs || {}).map(([k, v]) => [k, dateEnClair(v)]))) }
  assert.equal(phrase({ type: 'occupe', du: null, au: '2026-10-22' }), 'Occupé · départ le le-2026-10-22')
  assert.equal(phrase({ type: 'ferme', du: null, au: '2026-10-21' }), 'Fermé jusqu’au le-2026-10-21')
  assert.equal(phrase({ type: 'arrivee', du: '2026-10-25', au: null }), 'Libre jusqu’au le-2026-10-25')
  assert.equal(phrase({ type: 'fermeture', du: '2026-11-02', au: '2026-11-10' }), 'Fermé du le-2026-11-02 au le-2026-11-10')
  assert.equal(phrase({ type: 'libre', du: null, au: null }), 'Libre · aucune arrivée prévue')
  // Cinq phrases, cinq textes : aucune ne doit se confondre avec une autre.
  const toutes = ['occupe', 'ferme', 'arrivee', 'fermeture', 'libre']
    .map(ty => phrase({ type: ty, du: '2026-11-02', au: '2026-11-10' }))
  assert.equal(new Set(toutes).size, 5)
})

test('un type de fait INCONNU se tait, il ne se devine pas', () => {
  assert.equal(M.faitDateAffiche({ type: 'teleportation' }).cle, 'logements.fait_indisponible')
})

test('LE TEST QUI COMPTE : le fait daté a QUITTE la carte, remplacé par les avis', () => {
  // Demande de Thierry du 20 octobre 2026. Ce qui disparaît de la carte avec la
  // fermeture : « Occupé · départ le … », « Libre jusqu'au … » et « Libre ·
  // aucune arrivée prévue ». Le fait reste dans le JSON de l'endpoint, et la
  // fiche (étape 2) l'affiche.
  const d = doc(M.carteHtml(bien({
    fait_date: { type: 'ferme', du: null, au: '2026-10-21' },
    avis: { total: 336, notes: 332, note_sur_5: 4.9 }
  }), OUTILS()))
  assert.equal(d.querySelector('[data-fait]'), null)
  const carte = d.querySelector('.log-carte').textContent
  assert.doesNotMatch(carte, /Fermé/)
  assert.match(carte, /336 avis/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Les pastilles de canaux — quatre rendus, pas deux
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : « aucun canal » et « non vérifiés » sont DEUX rendus différents', () => {
  const lu = doc(M.carteHtml(bien({ canaux: [] }), OUTILS()))
  assert.equal(lu.querySelector('[data-canaux]').dataset.canaux, 'aucun')
  assert.equal(lu.querySelector('[data-canaux]').textContent, 'Aucun canal relié')

  const nonLu = doc(M.carteHtml(bien({ canaux: null }), OUTILS()))
  assert.equal(nonLu.querySelector('[data-canaux]').dataset.canaux, 'non-lus')
  assert.equal(nonLu.querySelector('[data-canaux]').textContent, 'Canaux non vérifiés')

  assert.notEqual(lu.querySelector('[data-canaux]').textContent,
    nonLu.querySelector('[data-canaux]').textContent,
    'lire « aucun canal » quand on en a deux est exactement le défaut que la dette 59 a fermé')
})

test('les trois états d un canal sont distincts, `mappe: null` compris', () => {
  const d = doc(M.carteHtml(bien({ canaux: [
    { ota: 'airbnb', mappe: true }, { ota: 'booking', mappe: false }, { ota: 'direct', mappe: null }
  ] }), OUTILS()))
  const etats = [...d.querySelectorAll('[data-ota]')].map(x => [x.dataset.ota, x.dataset.etat])
  assert.deepEqual(etats, [['airbnb', 'vente'], ['booking', 'pas-ce-bien'], ['direct', 'indetermine']])
  // Et chaque état porte son explication au survol.
  const titres = [...d.querySelectorAll('[data-ota]')].map(x => x.getAttribute('title'))
  assert.deepEqual(titres, ['En vente', 'Pas en vente sur ce logement', 'Vérification impossible pour l’instant'])
  assert.equal(new Set(titres).size, 3)
})

test('D11 : « — inactif » a disparu au profit de « Pas en vente sur ce logement »', () => {
  const d = doc(M.carteHtml(bien({ canaux: [{ ota: 'booking', mappe: false }] }), OUTILS()))
  assert.doesNotMatch(d.body.textContent, /inactif/)
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. La carte
// ═══════════════════════════════════════════════════════════════════════════

test('D3 : une capacité vide n affiche RIEN, pas « 0 voyageur »', () => {
  const avec = doc(M.carteHtml(bien({ capacite: 4 }), OUTILS()))
  assert.equal(avec.querySelector('.log-sous').textContent, 'Bagnères · 4 voyageurs')
  const sans = doc(M.carteHtml(bien({ capacite: null }), OUTILS()))
  assert.equal(sans.querySelector('.log-sous').textContent, 'Bagnères')
  assert.doesNotMatch(sans.body.textContent, /0 voyageur|personne\(s\)/)
  // Ni ville ni capacité : la ligne n existe pas du tout.
  const rien = doc(M.carteHtml(bien({ capacite: null, ville: null }), OUTILS()))
  assert.equal(rien.querySelector('.log-sous'), null)
})

test('le pluriel suit le nombre', () => {
  const un = doc(M.carteHtml(bien({ capacite: 1 }), OUTILS()))
  assert.match(un.querySelector('.log-sous').textContent, /1 voyageur$/)
})

test('UN SEUL signal par carte, et l échec du relevé n en fait PAS partie', () => {
  const pause = doc(M.carteHtml(bien({ assistant_en_pause: true, canaux_echec: true }), OUTILS()))
  const signaux = pause.querySelectorAll('[data-signal]')
  assert.equal(signaux.length, 1, 'une carte qui crie trois fois ne dit plus rien')
  assert.equal(signaux[0].textContent, 'Assistant en pause')

  // ⚠ L ÉCHEC DU RELEVÉ A QUITTÉ LA CARTE (constat de la revue du 20 octobre).
  // Il est au grain du COMPTE — une seule ligne `canaux_releve` — donc il
  // s affichait à l identique sur chaque carte, et sans son bouton. Pire : « un
  // seul signal » faisait que la pause le MASQUAIT sur les biens en pause, donc
  // le même fait de compte apparaissait sur certaines cartes seulement.
  const echec = doc(M.carteHtml(bien({ canaux_echec: true }), OUTILS()))
  assert.equal(echec.querySelector('[data-signal]'), null)

  const rien = doc(M.carteHtml(bien(), OUTILS()))
  assert.equal(rien.querySelector('[data-signal]'), null)
})

test('LE TEST QUI COMPTE : le relevé en échec est un fait de COMPTE, dit une seule fois', () => {
  assert.equal(M.releveDuCompteEnEchec([bien(), bien({ canaux_echec: true })]), true)
  assert.equal(M.releveDuCompteEnEchec([bien(), bien()]), false)
  assert.equal(M.releveDuCompteEnEchec([]), false)
  assert.equal(M.releveDuCompteEnEchec(null), false)
})

test('la fraîcheur du compte est la PLUS ANCIENNE, et la règle des 24 h est celle du dépôt', async () => {
  const maintenant = Date.parse('2026-10-20T12:00:00Z')
  const recent = '2026-10-20T11:00:00Z'
  const vieux = '2026-10-18T12:00:00Z'
  const f = M.fraicheurDuCompte([bien({ canaux_vu_le: recent }), bien({ canaux_vu_le: vieux })], maintenant)
  assert.equal(f.quand, new Date(vieux).toISOString(),
    'montrer la plus récente ferait passer pour frais un relevé dont la moitié date')
  assert.equal(f.vieux, true)
  assert.equal(M.fraicheurDuCompte([bien({ canaux_vu_le: recent })], maintenant).vieux, false)
  assert.equal(M.fraicheurDuCompte([bien({ canaux_vu_le: null })], maintenant), null)
  // ⚠ LA MÊME VALEUR QUE `shared/properties.js`, pour qu elles ne divergent pas.
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'properties.js'), 'utf8')
  assert.match(source, /ms >= 24 \* HEURE/, 'la règle des 24 h du dépôt a changé : aligner VIEUX_MS')
  assert.equal(M.VIEUX_MS, 24 * 3600 * 1000)
})

test('LE TEST QUI COMPTE : un canal relié mais ÉTEINT ne s affiche pas « En vente »', () => {
  // L écran d aujourd hui exige les DEUX (`actif === true && mappe === true`),
  // et son commentaire dit pourquoi — défaut du 11 septembre 2026. Un canal
  // éteint chez le partenaire sur un bien mappé ne vend RIEN : un point vert
  // ferait croire à l hôte qu il vend pendant que rien ne part.
  assert.equal(M.etatDuCanal({ mappe: true, actif: true }), 'vente')
  assert.equal(M.etatDuCanal({ mappe: true, actif: false }), 'canal-eteint')
  assert.equal(M.etatDuCanal({ mappe: false, actif: true }), 'pas-ce-bien')
  assert.equal(M.etatDuCanal({ mappe: null, actif: true }), 'indetermine')
  // `actif` absent : on ne dégrade pas, `mappe` porte l information principale.
  assert.equal(M.etatDuCanal({ mappe: true }), 'vente')

  const d = doc(M.carteHtml(bien({ canaux: [{ ota: 'airbnb', mappe: true, actif: false }] }), OUTILS()))
  const p = d.querySelector('[data-ota]')
  assert.equal(p.dataset.etat, 'canal-eteint')
  assert.equal(p.getAttribute('title'), 'Canal désactivé')
})

test('LE TEST QUI COMPTE : les canaux portent leur LIBELLÉ, pas leur slug technique', () => {
  // `canaux_du_bien.ota` est normalisé en minuscules par le writer : afficher
  // le slug donnait « airbnb », « booking », et « open » pour un canal direct.
  const d = doc(M.carteHtml(bien({ canaux: [
    { ota: 'airbnb', mappe: true, actif: true }, { ota: 'booking', mappe: true, actif: true },
    { ota: 'open', titre: 'Réservation directe', mappe: true, actif: true }
  ] }), OUTILS()))
  const textes = [...d.querySelectorAll('[data-ota]')].map(x => x.firstChild.nextSibling.textContent.trim())
  assert.deepEqual(textes, ['Airbnb', 'Booking.com', 'Réservation directe'])
  // Repli ultime : ni table, ni titre.
  assert.equal(M.libelleDuCanal({ ota: 'inconnu' }), 'inconnu')
  assert.equal(M.libelleDuCanal({}), 'Canal')
})

test('l état d un canal se lit SANS la couleur ni le survol', () => {
  // À 8 px, un rond en pointillés et un rond plein sont indiscernables, et il
  // n y a pas de survol au doigt : le quatrième état n était lisible par
  // personne sur un téléphone.
  const d = doc(M.carteHtml(bien({ canaux: [{ ota: 'airbnb', mappe: null }] }), OUTILS()))
  const sr = d.querySelector('[data-ota] .sr-only')
  assert.ok(sr, 'chaque pastille doit porter son libellé pour le lecteur d écran')
  assert.match(sr.textContent, /Vérification impossible/)
})

test('la photo a un repli, et il n est pas une image cassée', () => {
  const sans = doc(M.carteHtml(bien({ photo_url: null }), OUTILS()))
  assert.equal(sans.querySelector('.log-photo img'), null)
  assert.equal(sans.querySelector('.log-photo [data-icone]').dataset.icone, 'i-home')
  const avec = doc(M.carteHtml(bien({ photo_url: 'https://x/p.jpg' }), OUTILS()))
  assert.equal(avec.querySelector('.log-photo img').getAttribute('src'), 'https://x/p.jpg')
  assert.equal(avec.querySelector('.log-photo img').getAttribute('alt'), '',
    'la photo est décorative : le nom du logement est déjà dans la carte')
})

test('le nom du logement est échappé — un nom n est pas du HTML', () => {
  const d = doc(M.carteHtml(bien({ nom: '<img src=x onerror=alert(1)>' }), OUTILS()))
  assert.equal(d.querySelectorAll('.log-nom img').length, 0)
  assert.equal(d.querySelector('.log-nom').textContent, '<img src=x onerror=alert(1)>')
})

test('AUCUN identifiant du partenaire ne peut sortir : la carte ne lit que des champs publiés', () => {
  // Contre-épreuve : on glisse des champs interdits dans l objet, et on vérifie
  // qu ils n apparaissent nulle part. L endpoint ne les descend pas — mais la
  // carte ne doit pas devenir le chemin par lequel ils sortiraient un jour.
  const piege = bien({
    provider_property_id: '209413', provider_rate_plan_id: 'RP-SECRET',
    provider: 'channex', provider_channel_id: 'CH-SECRET'
  })
  const html = M.carteHtml(piege, OUTILS())
  for (const interdit of ['209413', 'RP-SECRET', 'CH-SECRET', 'channex']) {
    assert.ok(!html.includes(interdit), `la carte laisse passer ${interdit}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Les quatre états de la page
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : « vide » et « panne » ne se confondent pas', () => {
  assert.equal(M.etatDeLaPage({ biens: [] }), 'vide')
  assert.equal(M.etatDeLaPage({ biens: [bien()] }), 'liste')
  assert.equal(M.etatDeLaPage({ erreur: { status: 503 } }), 'panne')
  assert.equal(M.etatDeLaPage({ erreur: { status: 403 } }), 'refus')
  // Pas de liste du tout, sans erreur levée : c est une panne, pas un compte vide.
  assert.equal(M.etatDeLaPage({ biens: null }), 'panne')
  assert.equal(M.etatDeLaPage({}), 'panne')
})

test('« Ajoutez votre premier logement » ne s affiche QUE sur une lecture réussie et vide', () => {
  const cles = (quoi) => [...doc(M.etatHtml(quoi)).querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n)
  assert.ok(cles('vide').includes('logements.vide_titre'))
  assert.ok(!cles('panne').includes('logements.vide_titre'),
    'le dire sur une panne ferait lire « vous n avez aucun logement » à un hôte qui en a quatre')
  assert.ok(!cles('refus').includes('logements.vide_titre'))
})

test('une panne propose de RÉESSAYER ; un refus de droit ne propose rien', () => {
  assert.ok(doc(M.etatHtml('panne')).querySelector('[data-bind="reessayer"]'))
  assert.equal(doc(M.etatHtml('refus')).querySelector('[data-bind="reessayer"]'), null,
    'proposer de réessayer un refus de droit ferait cliquer l hôte dans le vide')
  assert.deepEqual([...doc(M.etatHtml('refus')).querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n),
    ['logements.refus'])
})

test('LE TEST QUI COMPTE : l état vide ne propose RIEN à qui n a pas le droit', () => {
  // Les deux actions mènent à `/pages/connexions` et `/biens/nouveau`, deux
  // pages classées NON DÉLÉGABLES, et le POST de création refuse en 403. « On
  // ne montre jamais ce qui mène à un refus » (Thierry, 20 octobre).
  const membre = doc(M.etatHtml('vide'))
  assert.equal(membre.querySelectorAll('a').length, 0, 'défaut sans droit : aucune action')
  assert.ok([...membre.querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n)
    .includes('logements.vide_aide_membre'))

  const titulaire = doc(M.etatHtml('vide', { peutAjouter: true }))
  const liens = [...titulaire.querySelectorAll('a')].map(a => a.getAttribute('href'))
  assert.deepEqual(liens, ['/pages/connexions', '/biens/nouveau'])
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Les règles de la charte, vérifiées sur le rendu
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : aucun texte en dur — toute chaîne visible vient de l i18n', () => {
  // On rend tout ce que le module sait rendre, puis on vérifie que le texte
  // affiché est COUVERT par les clés demandées. Un libellé écrit en dur dans le
  // module passerait tous les autres tests sans jamais être traduit (défaut D1).
  CLES_DEMANDEES.clear()
  RENDUS.clear()
  const html = [
    M.carteHtml(bien({ assistant_en_pause: true, canaux: null, fait_date: null, avis: null }), OUTILS({ avisIndisponibles: true })),
    M.carteHtml(bien({ canaux: [], avis: { total: 336, notes: 332, note_sur_5: 4.9 } }), OUTILS()),
    M.carteHtml(bien({ avis: { total: 3, notes: 0, note_sur_5: null } }), OUTILS()),
    // Les quatre etats de canal, pour que la garde couvre TOUT le rendu.
    M.carteHtml(bien({ canaux: [
      { ota: 'airbnb', mappe: true, actif: true }, { ota: 'booking', mappe: true, actif: false },
      { ota: 'expedia', mappe: false }, { ota: 'vrbo', mappe: null }
    ], fait_date: { type: 'arrivee', du: '2026-11-02' } }), OUTILS()),
    M.etatHtml('vide'), M.etatHtml('vide', { peutAjouter: true }),
    M.etatHtml('refus'), M.etatHtml('panne')
  ].join('')
  const d = doc(html)
  const traductions = [...RENDUS]
  for (const noeud of d.querySelectorAll('.log-pastille, .log-avis, .log-signal, .log-sous')) {
    const texte = noeud.textContent.trim()
    if (!texte) continue
    const couvert = traductions.some(tr => {
      const motif = String(tr).replace(/\{[^}]*\}/g, '').split(/\s+/).filter(m => m.length > 3)
      return motif.length ? motif.every(m => texte.includes(m)) : false
      // ⚠ PLUS D EXEMPTION POUR LES SLUGS. Ma première version bénissait
      // nommément « airbnb » et « booking » — c est-à-dire exactement ce que
      // cette garde devait refuser : un test qui mesure son propre double. Les
      // canaux portent désormais leur libellé, et seules les DONNÉES de la
      // fixture (le nom de la ville, le libellé d un canal) sont exemptées.
    }) || /^(Bagnères|Airbnb|Booking\.com|Expedia|Vrbo)/.test(texte)
    assert.ok(couvert, `texte non traduit dans le rendu : « ${texte} »`)
  }
  // ⚠ DEUX CHEMINS DE TRADUCTION, ET LES DEUX SE VÉRIFIENT. Les cartes passent
  // par `t()` ; les zones d état posent des `data-i18n` que la page traduit
  // après insertion. Mon premier seuil ne comptait que le premier chemin, et
  // réclamait 8 clés là où il n en voyait que 6 : il mesurait la moitié du
  // rendu. Une clé `data-i18n` absente du dictionnaire afficherait la CLÉ BRUTE
  // à l écran — « logements.vide_titre » au lieu du titre.
  const posees = [...d.querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n)
  for (const cle of posees) {
    assert.ok(FR[cle] != null, `clé posée en data-i18n et absente de fr.json : ${cle}`)
  }
  const toutes = new Set([...CLES_DEMANDEES, ...posees])
  assert.ok(toutes.size >= 12, `${toutes.size} clés seulement : le rendu n a pas été exercé`)
})

test('aucun hexa dans le module : les couleurs viennent des jetons', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'logements-liste.js'), 'utf8')
  const hexas = source.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  assert.deepEqual(hexas, [], 'la charte §7 : aucun hexa, jetons de theme.css seulement')
})

test('les trois langues portent les 25 clés du lot', () => {
  const fr = Object.keys(FR).filter(k => k.startsWith('logements.'))
  assert.ok(fr.length >= 25, `${fr.length} clés logements.* en français`)
  for (const code of ['en', 'es']) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', `${code}.json`), 'utf8'))
    const manquantes = fr.filter(k => !(k in d))
    assert.deepEqual(manquantes, [], `${code} : clés manquantes`)
    // Et aucune n est restée en français par copie.
    const identiques = fr.filter(k => d[k] === FR[k] && !/^\{/.test(String(FR[k])) && String(FR[k]).length > 12)
    assert.deepEqual(identiques, [], `${code} : traductions restées en français`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. La page elle-même
// ═══════════════════════════════════════════════════════════════════════════

test('la page masque « Ajouter un logement » PAR DÉFAUT, et le serveur garde le geste', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'logements.html'), 'utf8')
  // ⚠ `hidden` DANS LE HTML, pas seulement posé en JS : entre le chargement et
  // l exécution du module, un membre délégué verrait le bouton apparaître.
  const bouton = page.match(/<a[^>]*data-bind="ajouter"[^>]*>/)
  assert.ok(bouton, 'le bouton d ajout doit exister')
  assert.match(bouton[0], /\bhidden\b/, 'il doit être masqué dès le HTML servi')
  // Le masquage n est qu un confort : la garde serveur est la protection.
  assert.match(page, /estTitulaire\(\)/)
  const garde = fs.readFileSync(path.join(__dirname, '..', 'api', 'channel-property.js'), 'utf8')
  assert.match(garde, /estTitulaireDuCompte/, 'la garde serveur de la création doit être en place')
})

test('la page ne charge AUCUN script tiers et n appelle aucun partenaire', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'logements.html'), 'utf8')
  const externes = [...page.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map(m => m[1])
  assert.deepEqual(externes, [])
  assert.ok(!/channex|beds24/i.test(page), 'aucun nom de partenaire dans la page (spec §6)')
})

test('la page sert /logements, et l ancienne liste reste intacte', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'))
  const rewrites = vercel.rewrites || []
  assert.ok(rewrites.some(r => r.source === '/logements' && r.destination === '/pages/logements'),
    'le rewrite doit exister, SANS .html (cleanUrls)')
  // ⚠ `/biens` N EST PAS TOUCHÉ à l étape 1 : Thierry doit pouvoir comparer les
  // deux écrans en recette. La redirection est l étape 4.
  assert.ok(rewrites.some(r => r.source === '/biens' && r.destination === '/pages/biens'))
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'pages', 'biens.html')))
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Les avis sur la carte (demande de Thierry, 20 octobre 2026)
// ═══════════════════════════════════════════════════════════════════════════

const ligneAvis = (avis, extra = {}) => {
  const d = doc(M.carteHtml(bien({ avis }), OUTILS(extra)))
  return d.querySelector('.log-avis')
}

test('LE TEST QUI COMPTE : la note s affiche SUR 5, pas sur 10', () => {
  // Le cœur stocke sur 10 (mesuré le 20 octobre 2026 : Airbnb comme Booking
  // montent à 10 sur les 702 avis de production) ; l écran divise par 2,
  // « partout » — décision de Thierry du lot 1, portée par `noteSur5`. Afficher
  // 9,8 ici et 4,9 sur l accueil pour le même logement serait deux vérités.
  const l = ligneAvis({ total: 336, notes: 332, note_sur_5: 4.9 })
  assert.match(l.textContent, /4,9/)
  assert.doesNotMatch(l.textContent, /9,8/)
  assert.match(l.textContent, /336 avis/, 'le TOTAL des avis, c est la demande')
  assert.equal(l.querySelector('[data-icone="i-review"]') != null, true, 'une étoile, comme sur l accueil')
})

test('un avis unique ne dit pas « 1 avis » au pluriel', () => {
  assert.match(ligneAvis({ total: 1, notes: 1, note_sur_5: 5 }).textContent, /^5,0 \/ 5 · 1 avis/)
})

test('des avis SANS NOTE : le compte, sans étoile — jamais une moyenne de zéro', () => {
  const l = ligneAvis({ total: 3, notes: 0, note_sur_5: null })
  assert.match(l.textContent, /3 avis/)
  assert.doesNotMatch(l.textContent, /0,0/)
  assert.equal(l.querySelector('[data-icone="i-review"]'), null)
})

test('aucun avis : on le DIT — « lu, et vide » est une réponse', () => {
  const l = ligneAvis({ total: 0, notes: 0, note_sur_5: null })
  assert.equal(l.textContent.trim(), 'Aucun avis')
  assert.ok(l.classList.contains('log-avis--muet'))
})

test('LE TEST QUI COMPTE : `avis: null` ne devient JAMAIS « Aucun avis »', () => {
  // Les deux causes de `null` sont indiscernables au grain du bien : pas pu lire,
  // ou pas le droit. « Aucun avis » sur un logement qui en a 336 est le même
  // mensonge que « Libre » sur un bien complet.
  assert.equal(ligneAvis(null), null, 'rien du tout : on ne montre pas ce qui mène à un refus')
  assert.equal(ligneAvis(undefined), null, 'un champ absent se traite comme un `null`')
})

test('avis non lus pour TOUT LE COMPTE : la carte le dit, muet', () => {
  // Là, le motif est connu et il n est pas un refus : la réponse porte
  // `indisponibles: ['avis']`. On le dit une fois par carte, en muet.
  const l = ligneAvis(null, { avisIndisponibles: true })
  assert.equal(l.textContent.trim(), 'Avis non lus')
  assert.ok(l.classList.contains('log-avis--muet'))
})

test('un refus de droit reste muet MEME quand une autre carte est en panne', () => {
  // `avisIndisponibles` est un fait du COMPTE : si la réponse dit « refusé », la
  // page ne passe pas le drapeau, et rien ne s affiche.
  assert.equal(ligneAvis(null, { avisIndisponibles: false }), null)
})

test('une valeur non numerique ne devient ni un compte, ni du HTML', () => {
  // ⚠ CE TEST NE MESURE PAS L ECHAPPEMENT, et son ancien nom le pretendait
  // (constat m3) : `Number('<img …>')` est NaN, donc la charge est ecartee par
  // la branche « reponse mal formee » AVANT d atteindre le HTML, et le test
  // resterait vert sans `esc`. Rien de `bien.avis` ne descend en texte : ce ne
  // sont que des nombres. Ce qu il mesure vraiment — et qui compte — c est qu une
  // reponse mal formee retombe sur « non lu », jamais sur « Aucun avis ».
  const l = ligneAvis({ total: '<img src=x onerror=alert(1)>', notes: 0, note_sur_5: null })
  assert.equal(l.dataset.avis, 'inconnu')
  assert.equal(doc(l.outerHTML).querySelectorAll('img').length, 0)
  // L echappement des DONNEES, lui, est eprouve la ou elles descendent vraiment :
  // le nom du bien et le libelle des canaux (tests de la section 6).
})

test('LE TEST QUI COMPTE (M2) : l ECHELLE de la note se dit, a la souris et a la voix', () => {
  // L icone est `aria-hidden` : sans ca, un lecteur d ecran annonce « 4,9 · 336
  // avis » sans dire sur quelle echelle — et 4,9 sur 10 serait une mauvaise note
  // au lieu d une excellente. La revue a trouve que le commentaire promettait
  // les deux et que le rendu n en portait aucun.
  const l = ligneAvis({ total: 336, notes: 332, note_sur_5: 4.9 })
  // ⚠ LE LIBELLE EST CELUI DE THIERRY, MOT POUR MOT (20 octobre 2026) : il dit
  // l'echelle ET ce qu'on a fait des notes Booking.
  assert.equal(l.getAttribute('title'), 'moyenne sur 5, notes Booking ramenées sur 5')
  assert.match(l.querySelector('.sr-only').textContent, /moyenne sur 5, notes Booking ramenées sur 5/)
  assert.match(l.textContent, /^4,9 \/ 5 · 336 avis/, 'la note porte son echelle a l ecran')
  // Pas d echelle la ou il n y a pas de note : « 3 avis » n est pas sur 5.
  const sans = ligneAvis({ total: 3, notes: 0, note_sur_5: null })
  assert.equal(sans.getAttribute('title'), null)
  assert.equal(sans.querySelector('.sr-only'), null)
})

test('LE TEST QUI COMPTE (règle V5) : l étoile est une ICÔNE du sprite, jamais un symbole texte', () => {
  // Rappel de Thierry, 20 octobre 2026 : « icône du sprite, pas le caractère ».
  // Un ★ écrit en dur ne suit ni la couleur du thème, ni la taille, ni le mode
  // sombre, et se lit « étoile noire » par un lecteur d écran — la ligne dirait
  // alors deux fois la note.
  const l = ligneAvis({ total: 336, notes: 332, note_sur_5: 4.9 })
  const svg = l.querySelector('[data-icone="i-review"]')
  assert.ok(svg, 'l étoile vient du sprite')
  assert.doesNotMatch(l.textContent, /[★☆⭐✩✪✫✬✭✮✯]/, 'aucun symbole texte dans la ligne')
  // Et nulle part dans le module, pour qu un futur rendu ne l introduise pas.
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'logements-liste.js'), 'utf8')
  assert.doesNotMatch(source, /[★☆⭐✩✪✫✬✭✮✯]/)
  // Ni dans les trois dictionnaires : un symbole glissé dans une traduction
  // passerait toutes les gardes de rendu.
  for (const lang of ['fr', 'en', 'es']) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', `${lang}.json`), 'utf8'))
    for (const [cle, texte] of Object.entries(d)) {
      if (!cle.startsWith('logements.')) continue
      assert.doesNotMatch(String(texte), /[★☆⭐✩✪✫✬✭✮✯]/, `${lang} : ${cle}`)
    }
  }
})
