// tests/connaissance-vue-dom.test.js — la VUE de la base de connaissance V5
// (`shared/connaissance-vue.js`), montée dans un vrai DOM et CLIQUÉE.
//
// ⚠ ON MESURE DES GESTES, PAS DES LIGNES DE SOURCE. C'est la leçon du banc de
// Messages : un grep prouve qu'un texte existe, il ne prouve pas qu'un clic le
// traverse. Le VRAI module est évalué (imports retirés, `confirmer` évalué pour
// de vrai dans la même fenêtre), et chaque test regarde ce qui part au serveur
// ET ce que l'hôte voit.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const RACINE = path.join(__dirname, '..')
const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), 'utf8')
const FR = JSON.parse(lire('shared', 'i18n', 'fr.json'))
const sansModule = (src) => src
  .replace(/^import[\s\S]*?from\s*'[^']*'\s*$/gm, '')
  .replace(/^export default /gm, 'const __defaut_' + Math.random().toString(36).slice(2) + ' = ')
  .replace(/^export /gm, '')

// L'écran tel que l'endpoint le rend (forme mesurée sur api/ecran/connaissance.js).
function ecran (o = {}) {
  return {
    migration: true,
    biens: [{ ref: 'P1', nom: 'La bulle', photo: null }, { ref: 'P2', nom: 'Cœur', photo: null }],
    bien: { ref: o.ref || 'P1', nom: o.ref === 'P2' ? 'Cœur' : 'La bulle', photo: null },
    faits: [
      { cle: 'telephone_hote', libelle: 'Téléphone', balise: '{telephone_hote}', valeur: '0600000000', aRemplir: false, horsIa: false, sansBalise: false },
      { cle: 'wifi_mdp', libelle: 'Mot de passe wifi', balise: '{wifi_mdp}', valeur: '', aRemplir: true, horsIa: false, sansBalise: false },
      { cle: 'equip_lits', libelle: 'equip_lits', balise: null, valeur: 'deux lits', aRemplir: false, horsIa: false, sansBalise: true }
    ],
    reponses: o.reponses || [
      { id: 'r1', sujet: 'Wifi', brut: 'Bonjour {prenom},\nle wifi : {wifi_mdp}',
        segments: [{ texte: 'Bonjour ' }, { cle: 'prenom', libelle: 'Prénom', vide: false }, { texte: ',\nle wifi : ' }, { cle: 'wifi_mdp', libelle: 'Mot de passe wifi', vide: true }],
        verifieLe: '2026-06-01T10:00:00Z', jours: 157, aRevoir: true, horsIa: false, apercu: 'Bonjour Ana,\nle wifi : [WIFI MOT DE PASSE]' },
      { id: 'r2', sujet: 'Code immeuble', brut: 'Le code est 1234',
        segments: [{ texte: 'Le code est 1234' }], verifieLe: null, jours: null, aRevoir: false, horsIa: true, apercu: 'Le code est 1234' }
    ],
    balises: [
      { cle: 'prenom', libelle: 'Prénom', origine: 'reservation', marqueur: null },
      { cle: 'checkin', libelle: "Heure d'arrivée", origine: 'base', marqueur: null },
      { cle: 'telephone_hote', libelle: 'Téléphone', origine: 'base', marqueur: '[TÉLÉPHONE HÔTE]' },
      { cle: 'wifi_nom', libelle: 'Nom wifi', origine: 'base', marqueur: '[WIFI NOM]' },
      { cle: 'wifi_mdp', libelle: 'Mot de passe wifi', origine: 'base', marqueur: '[WIFI MOT DE PASSE]' },
      { cle: 'code_acces', libelle: "Code d'accès", origine: 'serrure', marqueur: '[CODE À INSÉRER]' }
    ],
    voyageur: { resa: 'B9', prenom: 'Ana', arrivee: '2026-11-20' }
  }
}

async function monter ({ repondre, selecteur = false, bien = 'P1', resa = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="r"></div></body></html>',
    { runScripts: 'outside-only', url: 'https://exemple.test/connaissance' })
  const w = dom.window
  w.I18n = { date: (d) => d.toISOString().slice(0, 10) }
  w.__confirm = 0
  w.confirm = () => { w.__confirm++; return true }
  w.eval(sansModule(lire('shared', 'confirmer.js')) + '\n' + sansModule(lire('shared', 'connaissance-vue.js'))
    + '\nwindow.__kb = { monterConnaissance, kbVersTexte, KB_INSERTION_RAPIDE }')
  const envois = []
  const appel = async (chemin, corps) => {
    // Copie hors du realm de la fenêtre : `deepStrictEqual` compare aussi les
    // prototypes, et un objet jsdom n'a pas l'`Object` de Node.
    envois.push({ chemin, corps: corps ? JSON.parse(JSON.stringify(corps)) : null })
    const r = repondre ? await repondre(chemin, corps) : null
    if (r && r.__statut) { const e = new Error('refus'); e.status = r.__statut; throw e }
    return r || (corps ? { ok: true } : ecran())
  }
  const t = (k, v) => {
    const s = Object.prototype.hasOwnProperty.call(FR, k) ? FR[k] : k
    return s.replace(/\{(\w+)\}/g, (_, c) => ((v || {})[c] ?? '{' + c + '}'))
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const racine = w.document.getElementById('r')
  const vue = w.__kb.monterConnaissance({ racine, appel, t, esc, bien, resa, selecteur, doc: w.document })
  await vue.pret
  return { w, d: w.document, racine, vue, envois, kb: w.__kb, fermer: () => { vue.detruire(); w.close() } }
}

const clic = (b, el) => {
  if (!el) throw new Error('clic sur un élément absent')
  el.dispatchEvent(new b.w.MouseEvent('click', { bubbles: true, cancelable: true, view: b.w }))
}
const reposer = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const lectures = (b) => b.envois.filter(e => !e.corps)
const ecritures = (b) => b.envois.filter(e => e.corps && e.corps.action !== 'apercu')

test('LE TEST QUI COMPTE : UN appel peint tout l écran, sur le logement demandé', async () => {
  const b = await monter({ bien: 'P2', resa: 'B9', repondre: () => ecran({ ref: 'P2' }) })
  assert.equal(b.envois.length, 1)
  assert.equal(b.envois[0].chemin, '/api/ecran/connaissance?bien=P2&resa=B9')
  assert.equal(b.racine.querySelectorAll('.kb-carte').length, 2)
  assert.equal(b.racine.querySelectorAll('.kb-fait').length, 3)
  b.fermer()
})

test('LE TEST QUI COMPTE : l hôte ne voit JAMAIS d accolades ; une balise vide est une étiquette ROUGE', async () => {
  const b = await monter()
  const carte = b.racine.querySelector('[data-kb-ouvrir="r1"]')
  assert.ok(!/[{}]/.test(carte.textContent), carte.textContent)
  const etiquettes = [...carte.querySelectorAll('.kb-etiquette')]
  assert.deepEqual(etiquettes.map(x => x.textContent), ['Prénom', 'Mot de passe wifi'])
  assert.ok(etiquettes[1].classList.contains('kb-etiquette--vide'))
  assert.ok(!etiquettes[0].classList.contains('kb-etiquette--vide'))
  b.fermer()
})

test('LE TEST QUI COMPTE : l ambre ne sert QU AU « À revoir », et le cadenas dit « Hors IA »', async () => {
  const b = await monter()
  const revoir = [...b.racine.querySelectorAll('.kb-badge--revoir')]
  assert.equal(revoir.length, 1, 'une seule réponse a plus de 90 jours')
  assert.equal(revoir[0].closest('[data-kb-ouvrir]').dataset.kbOuvrir, 'r1')
  assert.equal(revoir[0].textContent, 'À revoir')
  const hors = b.racine.querySelector('[data-kb-ouvrir="r2"] .kb-badge--horsia')
  assert.ok(hors, 'Hors IA sur la réponse marquée')
  assert.match(hors.innerHTML, /#i-lock/)
  assert.equal(hors.textContent, 'Hors IA')
  // Les trois états de vérification sont distincts à l'écran.
  assert.match(b.racine.querySelector('[data-kb-ouvrir="r1"] .kb-carte__pied').textContent, /^Vérifiée le 2026-06-01$/)
  assert.equal(b.racine.querySelector('[data-kb-ouvrir="r2"] .kb-carte__pied').textContent, 'Jamais vérifiée')
  b.fermer()
})

test('une information vide se dit « À remplir », en rouge ; une clé sans balise le dit aussi', async () => {
  const b = await monter()
  const faits = [...b.racine.querySelectorAll('.kb-fait')]
  const mdp = faits.find(x => x.textContent.includes('Mot de passe wifi'))
  assert.equal(mdp.querySelector('.kb-a-remplir').textContent, 'À remplir')
  const tel = faits.find(x => x.textContent.includes('Téléphone'))
  assert.equal(tel.querySelector('.kb-a-remplir'), null)
  const lits = faits.find(x => x.textContent.includes('equip_lits'))
  assert.match(lits.textContent, /Lue par l’IA seulement/)
  b.fermer()
})

test('LE TEST QUI COMPTE : ouvrir, modifier, enregistrer — le texte repart avec ses BALISES et son ID', async () => {
  const b = await monter()
  clic(b, b.racine.querySelector('[data-kb-ouvrir="r1"]'))
  const zone = b.racine.querySelector('[data-kb-message]')
  assert.equal(b.racine.querySelector('[data-kb-sujet]').value, 'Wifi')
  // Les balises sont des étiquettes dans la zone, jamais des accolades.
  assert.ok(!/[{}]/.test(zone.textContent))
  assert.deepEqual([...zone.querySelectorAll('[data-balise]')].map(x => x.dataset.balise), ['prenom', 'wifi_mdp'])
  // Aller-retour exact : ce qui est chargé est ce qui repart.
  assert.equal(b.kb.kbVersTexte(zone), 'Bonjour {prenom},\nle wifi : {wifi_mdp}')
  // L'aperçu rempli avec le vrai voyageur, l'information manquante en rouge.
  assert.equal(b.racine.querySelector('[data-kb-apercu-titre]').textContent, 'Aperçu pour Ana')
  assert.equal(b.racine.querySelector('[data-kb-apercu] .kb-manque').textContent, '[WIFI MOT DE PASSE]')
  // L'hôte ajoute une balise, décoche l'IA, enregistre.
  clic(b, b.racine.querySelector('[data-kb-inserer="telephone_hote"]'))
  b.racine.querySelector('[data-kb-lisible]').checked = false
  clic(b, b.racine.querySelector('[data-kb-enregistrer]'))
  await reposer()
  const e = ecritures(b)
  assert.equal(e.length, 1)
  assert.deepEqual(e[0].corps, {
    action: 'enregistrer', bien: 'P1', type: 'faq', id: 'r1', key: 'Wifi',
    value: 'Bonjour {prenom},\nle wifi : {wifi_mdp}{telephone_hote}', lisible_par_ia: false
  })
  // L'écran est RELU après l'écriture, et le dit.
  assert.equal(lectures(b).length, 2)
  assert.equal(b.racine.querySelector('[data-kb-note]').textContent, 'Enregistré')
  assert.equal(b.racine.querySelector('[data-kb-editeur]'), null, 'retour à la liste')
  b.fermer()
})

test('LE TEST QUI COMPTE : l insertion se fait AU CURSEUR, pas en fin de texte', async () => {
  const b = await monter()
  clic(b, b.racine.querySelector('[data-kb-ouvrir="r2"]'))
  const zone = b.racine.querySelector('[data-kb-message]')
  // Le curseur après « Le code », avant « est 1234 ».
  const texte = zone.firstChild
  const r = b.d.createRange(); r.setStart(texte, 'Le code'.length); r.collapse(true)
  const sel = b.d.getSelection(); sel.removeAllRanges(); sel.addRange(r)
  b.d.dispatchEvent(new b.w.Event('selectionchange'))
  // Le bouton est cliqué : le focus sort de la zone, la position doit tenir.
  clic(b, b.racine.querySelector('[data-kb-inserer="prenom"]'))
  assert.equal(b.kb.kbVersTexte(zone), 'Le code{prenom} est 1234')
  b.fermer()
})

test('« Autre… » ouvre TOUTES les autres balises, libellés du serveur', async () => {
  const b = await monter()
  clic(b, b.racine.querySelector('[data-kb-ajouter]'))
  const rapides = [...b.racine.querySelectorAll('.kb-insertion > [data-kb-inserer]')].map(x => x.textContent)
  assert.deepEqual(rapides, ['Prénom', 'Téléphone', "Heure d'arrivée", 'Nom wifi'], 'l ordre de la maquette')
  const liste = b.racine.querySelector('[data-kb-liste-autres]')
  assert.equal(liste.hidden, true)
  clic(b, b.racine.querySelector('[data-kb-autres]'))
  assert.equal(liste.hidden, false)
  assert.deepEqual([...liste.querySelectorAll('[data-kb-inserer]')].map(x => x.dataset.kbInserer), ['wifi_mdp', 'code_acces'])
  b.fermer()
})

test('une NOUVELLE réponse part sans id ; un sujet vide est refusé AVANT tout envoi', async () => {
  const b = await monter()
  clic(b, b.racine.querySelector('[data-kb-ajouter]'))
  clic(b, b.racine.querySelector('[data-kb-enregistrer]'))
  await reposer()
  assert.equal(ecritures(b).length, 0)
  assert.equal(b.racine.querySelector('[data-kb-note]').textContent, 'Le sujet est obligatoire')
  b.racine.querySelector('[data-kb-sujet]').value = 'Parking'
  b.racine.querySelector('[data-kb-message]').textContent = 'Gratuit devant la porte'
  clic(b, b.racine.querySelector('[data-kb-enregistrer]'))
  await reposer()
  const e = ecritures(b)
  assert.equal(e.length, 1)
  assert.ok(!('id' in e[0].corps))
  assert.equal(e[0].corps.lisible_par_ia, true, 'une réponse neuve est lisible par l IA par défaut')
  b.fermer()
})

test('LE TEST QUI COMPTE : un refus garde le texte de l hôte, et dit pourquoi', async () => {
  const b = await monter({ repondre: (chemin, corps) => (corps ? { __statut: 409 } : ecran()) })
  clic(b, b.racine.querySelector('[data-kb-ouvrir="r2"]'))
  b.racine.querySelector('[data-kb-sujet]').value = 'Wifi'
  clic(b, b.racine.querySelector('[data-kb-enregistrer]'))
  await reposer()
  assert.equal(b.racine.querySelector('[data-kb-note]').textContent, 'Une réponse porte déjà ce sujet')
  assert.ok(b.racine.querySelector('[data-kb-editeur]'), 'on reste dans l éditeur')
  assert.equal(b.racine.querySelector('[data-kb-sujet]').value, 'Wifi')
  assert.equal(b.racine.querySelector('[data-kb-enregistrer]').disabled, false, 'dégelé')
  b.fermer()
})

test('LE TEST QUI COMPTE : supprimer demande dans la PAGE ; fermer ou « Garder » ne supprime rien', async () => {
  const b = await monter()
  clic(b, b.racine.querySelector('[data-kb-ouvrir="r1"]'))
  clic(b, b.racine.querySelector('[data-kb-supprimer]'))
  await reposer()
  const boite = b.d.querySelector('[data-bind="hs-confirm"]')
  assert.ok(boite, 'une fenêtre DANS la page')
  assert.equal(b.w.__confirm, 0, 'jamais window.confirm (règle du 2 novembre 2026)')
  assert.equal(boite.querySelector('.hs-confirm__titre').textContent, 'Supprimer « Wifi » ?')
  clic(b, boite.querySelector('[data-confirm-choix="garder"]'))
  await reposer()
  assert.equal(ecritures(b).length, 0)
  clic(b, b.racine.querySelector('[data-kb-supprimer]'))
  await reposer()
  clic(b, b.d.querySelector('[data-confirm-choix="supprimer"]'))
  await reposer()
  assert.deepEqual(ecritures(b).map(x => x.corps), [{ action: 'supprimer', bien: 'P1', id: 'r1' }])
  assert.equal(b.racine.querySelector('[data-kb-note]').textContent, 'Supprimé')
  b.fermer()
})

test('une information du logement se corrige sur place ; Entrée enregistre UNE fois', async () => {
  const b = await monter()
  clic(b, b.racine.querySelector('[data-kb-modifier-fait="wifi_mdp"]'))
  const champ = b.racine.querySelector('[data-kb-fait-saisie]')
  champ.value = '  secret  '
  assert.equal(b.vue.enEdition(), true, 'une saisie non enregistrée se sait')
  champ.dispatchEvent(new b.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  champ.dispatchEvent(new b.w.KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }))
  await reposer()
  assert.deepEqual(ecritures(b).map(x => x.corps),
    [{ action: 'enregistrer', bien: 'P1', type: 'fixed', key: 'wifi_mdp', value: 'secret' }])
  b.fermer()
})

test('LE TEST QUI COMPTE : un collage entre en TEXTE BRUT', async () => {
  const b = await monter()
  clic(b, b.racine.querySelector('[data-kb-ajouter]'))
  const zone = b.racine.querySelector('[data-kb-message]')
  const ev = new b.w.Event('paste', { bubbles: true, cancelable: true })
  ev.clipboardData = { getData: (type) => (type === 'text/plain' ? 'Ligne 1\r\nLigne <b>2</b>' : '<b>gras</b>') }
  zone.dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, true)
  assert.equal(zone.querySelector('b'), null, 'aucun balisage collé')
  assert.equal(b.kb.kbVersTexte(zone), 'Ligne 1\nLigne <b>2</b>')
  b.fermer()
})

test('la zone d édition se lit pareil sous Chrome (div) et Firefox (br)', async () => {
  const b = await monter()
  const z = b.d.createElement('div')
  z.innerHTML = 'Un<div>Deux</div><div><br></div><div>Quatre <span data-balise="prenom">Prénom</span>​</div>'
  assert.equal(b.kb.kbVersTexte(z), 'Un\nDeux\n\nQuatre {prenom}')
  z.innerHTML = 'Un<br>Deux<br><br>Quatre&nbsp;fin'
  assert.equal(b.kb.kbVersTexte(z), 'Un\nDeux\n\nQuatre fin')
  b.fermer()
})

test('l aperçu se recalcule par le SERVEUR, jamais remplacé dans le navigateur', async () => {
  const b = await monter({
    repondre: (chemin, corps) => (corps && corps.action === 'apercu'
      ? { ok: true, apercu: { texte: 'Salut Lou [WIFI NOM]' }, voyageur: { prenom: 'Lou' } }
      : ecran())
  })
  clic(b, b.racine.querySelector('[data-kb-ouvrir="r2"]'))
  await b.vue.rafraichirApercu()
  const envoi = b.envois.find(e => e.corps && e.corps.action === 'apercu')
  assert.deepEqual(envoi.corps, { action: 'apercu', bien: 'P1', texte: 'Le code est 1234' })
  assert.equal(b.racine.querySelector('[data-kb-apercu-titre]').textContent, 'Aperçu pour Lou')
  assert.equal(b.racine.querySelector('[data-kb-apercu] .kb-manque').textContent, '[WIFI NOM]')
  b.fermer()
})

test('au téléphone, la vue porte le sélecteur de logement ; changer relit l écran de CE logement', async () => {
  const b = await monter({ selecteur: true, repondre: (chemin) => ecran({ ref: /bien=P2/.test(chemin) ? 'P2' : 'P1' }) })
  const sel = b.racine.querySelector('[data-kb-bien]')
  assert.deepEqual([...sel.options].map(o => o.value), ['P1', 'P2'])
  sel.value = 'P2'
  sel.dispatchEvent(new b.w.Event('change', { bubbles: true }))
  await reposer()
  assert.equal(lectures(b).pop().chemin, '/api/ecran/connaissance?bien=P2')
  assert.equal(b.vue.ref, 'P2')
  b.fermer()
})

test('un refus 403 dit « réservé au titulaire », pas un écran vide', async () => {
  const b = await monter({ repondre: () => ({ __statut: 403 }) })
  assert.equal(b.racine.textContent.trim(), 'Réservé au titulaire du compte')
  b.fermer()
})

test('le texte de l hôte n entre dans aucune chaîne interprétée (sujet et message)', async () => {
  const b = await monter({ repondre: () => ecran({ reponses: [{ id: 'x', sujet: '<img src=x onerror=alert(1)>', brut: '<b>', segments: [{ texte: '<b>' }], verifieLe: null, aRevoir: false, horsIa: false, apercu: '<i>' }] }) })
  assert.equal(b.racine.querySelector('img[src="x"]'), null)
  clic(b, b.racine.querySelector('[data-kb-ouvrir="x"]'))
  assert.equal(b.racine.querySelector('[data-kb-sujet]').value, '<img src=x onerror=alert(1)>')
  assert.equal(b.racine.querySelector('[data-kb-message] b'), null)
  assert.equal(b.racine.querySelector('[data-kb-apercu] i'), null)
  b.fermer()
})

test('dans l éditeur aussi, une balise sans valeur reste une étiquette ROUGE — chargée ou insérée', async () => {
  const b = await monter()
  clic(b, b.racine.querySelector('[data-kb-ouvrir="r1"]'))
  const zone = b.racine.querySelector('[data-kb-message]')
  assert.ok(zone.querySelector('[data-balise="wifi_mdp"]').classList.contains('kb-etiquette--vide'), 'chargée vide : rouge')
  assert.ok(!zone.querySelector('[data-balise="prenom"]').classList.contains('kb-etiquette--vide'))
  clic(b, b.racine.querySelector('[data-kb-inserer="wifi_nom"]'))
  // `wifi_nom` n'est pas dans les « Infos du logement » du fixture : à remplir.
  assert.ok(zone.querySelector('[data-balise="wifi_nom"]').classList.contains('kb-etiquette--vide'))
  clic(b, b.racine.querySelector('[data-kb-inserer="telephone_hote"]'))
  assert.ok(!zone.querySelector('[data-balise="telephone_hote"]').classList.contains('kb-etiquette--vide'), 'renseigné : pas rouge')
  b.fermer()
})
