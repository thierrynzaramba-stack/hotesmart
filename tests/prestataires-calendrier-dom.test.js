// tests/prestataires-calendrier-dom.test.js
// LE CALENDRIER DES JOURS DE TRAVAIL, DANS UN VRAI DOM (lot 2b).
//
// ⚠ POURQUOI UN TEST DOM ET PAS UN TEST DE TEXTE. Le 15 septembre au matin, un
// sélecteur écrit en avril ramassait sept cases de trop et écrivait les jours de
// la semaine dans la liste des biens d'une prestataire. Aucun des 1400 tests ne
// pouvait le voir : ils lisaient le HTML comme du TEXTE. Ce calendrier est bien
// plus interactif que ce formulaire — clic, glissé, verrouillage, deux lignes
// A/B — et le juger sur son source serait répéter la même erreur en plus grand.
//
// ⚠ ON EXÉCUTE LE VRAI SCRIPT DE LA PAGE, pas une copie. Le recopier produirait
// un double qui reste vert pendant que la page est fausse.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const FICHIER = path.join(__dirname, '..', 'apps', 'menages', 'prestataires.html')
const PROFIL = 'p-regina'

// ⚠ UNE DATE FIGÉE SERAIT UNE DETTE DE PLUS (règle du dépôt : dates relatives si
// le test lit l'horloge). Le calendrier lit `new Date()` : on calcule donc tout
// par rapport à aujourd'hui, et ce fichier ne rougira pas tout seul dans un mois.
const auj = new Date()
const AUJ = new Date(Date.UTC(auj.getUTCFullYear(), auj.getUTCMonth(), auj.getUTCDate(), 12))
const iso = d => d.toISOString().slice(0, 10)
const dans = n => iso(new Date(AUJ.getTime() + n * 86400000))

function monterPage ({ regles = [], exceptions = [], conges = [] } = {}) {
  const html = fs.readFileSync(FICHIER, 'utf8')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, 'le script module de la page est introuvable')

  let src = m[1]
    .replace(/^\s*import .*$/gm, '')
    .replace(/^\s*await exigerCompteProprePage\(.*$/gm, '')
    .replace(/^\s*initErrorHandler\(\)\s*$/gm, '')
    .replace(/^\s*init\(\)\s*$/gm, '')

  const appels = []
  const etat = { regles, exceptions, conges }

  src += `
    globalThis.__c = {
      appels,
      seed () { currentSession = { access_token: 'jwt', user: { id: 'compte-1' } } },
      chargerDisponibilites, rechargerDispo, estLibre, congeDe, peindreMois,
      etatDispo: () => dispo
    }
  `

  const dom = new JSDOM(html, { url: 'https://hotesmart.vercel.app/apps/menages/prestataires',
                                runScripts: 'outside-only' })
  const w = dom.window
  w.alert = () => {}
  w.appels = appels
  // ⚠ LE DOUBLE REJOUE LE CONTRAT DU SERVEUR, y compris ses EFFETS. Un stub qui
  // répondrait « ok » sans changer l'état rendrait tous les gestes indétectables :
  // on repeindrait toujours la même chose, et le test passerait sur du vide.
  w.fetch = async (url, opts) => {
    const corps = opts && opts.body ? JSON.parse(opts.body) : null
    appels.push({ url: String(url), corps })
    if (String(url).startsWith('/api/disponibilites')) {
      if (corps && corps.action === 'poserException') {
        etat.exceptions = etat.exceptions.filter(e => e.date !== corps.date)
          .concat([{ id: 'e' + appels.length, date: corps.date, available: corps.available, source: 'hote' }])
      }
      if (corps && corps.action === 'retirerException') {
        etat.exceptions = etat.exceptions.filter(e => e.id !== corps.id)
      }
      if (corps && corps.action === 'poserConge') {
        etat.conges = etat.conges.concat([{ id: 'c' + appels.length, debut: corps.debut,
                                            fin: corps.fin, motif: corps.motif, source: 'hote' }])
      }
      if (corps && corps.action === 'retirerConge') {
        etat.conges = etat.conges.filter(c => c.id !== corps.id)
      }
      if (corps && corps.action === 'retirerRegle') {
        etat.regles = etat.regles.filter(r => r.id !== corps.id)
      }
      if (corps && corps.action === 'poserRegle') {
        etat.regles = etat.regles.concat([{ id: 'r' + appels.length, label: 'règle', active: true,
          jours: corps.jours, cadence: corps.toutes_les_n_semaines, ancre: corps.depuis }])
      }
      return { ok: true, status: 200, json: async () => ({
        regles: etat.regles, exceptions: etat.exceptions, conges: etat.conges,
        success: true }) }
    }
    return { ok: true, status: 200, json: async () => ({ properties: [], liaisons: [], prestataires: [] }) }
  }
  w.supabase = { from () { const c = { select: () => c, eq: () => c, update: () => c,
    order: () => Promise.resolve({ data: [], error: null }) }; return c } }

  vm.runInContext(src, dom.getInternalVMContext())
  return { w, t: w.__c, etat }
}

const cases = w => [...w.document.querySelectorAll('#dispo-months .dispo-case')]
  .filter(el => el.dataset.jour)
const caseDu = (w, j) => w.document.querySelector(`#dispo-months .dispo-case[data-jour="${j}"]`)

// ⚠ jsdom 26 N'IMPLÉMENTE PAS `PointerEvent`. La page écoute `pointerdown` /
// `pointerover` / `pointerup` — des types d'événements parfaitement supportés
// par les navigateurs, mais que le double DOM ne sait construire que sous forme
// d'`Event` générique. On dispatche donc l'événement par son TYPE, ce que la
// page écoute réellement ; elle ne lit de `PointerEvent` que `pointerId`, et
// seulement derrière une garde `if (el.setPointerCapture)`.
const pointe = (w, el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }))
const relacher = w => w.dispatchEvent(new w.Event('pointerup'))
const souffler = (ms = 40) => new Promise(r => setTimeout(r, ms))

// ─── Le calendrier existe, et il couvre un an ──────────────────────────────

test('deux mois affichés, et la navigation atteint un an devant', async () => {
  const { w, t } = monterPage()
  t.seed()
  await t.chargerDisponibilites(PROFIL)

  assert.ok(cases(w).length > 50, 'deux mois de jours sont peints')
  assert.strictEqual(w.document.getElementById('dispo-prec').disabled, true,
    'on ne remonte pas avant le mois courant')
  // On avance jusqu'au bout : la borne doit être atteignable, et s'arrêter.
  const suiv = w.document.getElementById('dispo-suiv')
  let pas = 0
  while (!suiv.disabled && pas < 40) { suiv.click(); pas++ }
  assert.strictEqual(pas, 11, 'onze pas pour couvrir douze mois, puis la borne')
  assert.match(w.document.getElementById('dispo-horizon').textContent, /jusqu/,
    'l\'horizon est annoncé, pas deviné')
})

test('sans aucune règle, tous les jours sont verts — et l\'écran DIT le piège', async () => {
  // ⚠ « Aucune règle = disponible » est la règle du moteur depuis le lot 3.1.
  // Tout décocher ne rend pas absente : ça rend disponible PARTOUT, l'inverse du
  // geste attendu. C'est l'avertissement le plus important de cet écran.
  const { w, t } = monterPage({ regles: [] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  assert.strictEqual(cases(w).filter(c => c.classList.contains('off')).length, 0)
  assert.match(w.document.getElementById('dispo-hint').textContent, /TOUS les jours/)
})

// ─── Les congés VERROUILLENT — c'est ce que ce lot rend vrai ───────────────

test('un congé barre ses jours, les rend non cliquables, et le dit', async () => {
  const debut = dans(3), fin = dans(6)
  const { w, t } = monterPage({ conges: [{ id: 'c1', debut, fin, motif: 'Vacances', source: 'hote' }] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)

  const dedans = caseDu(w, dans(4))
  assert.ok(dedans.classList.contains('conge'), 'le jour porte la marque du congé')
  assert.strictEqual(dedans.getAttribute('tabindex'), '-1', 'il sort du parcours clavier')
  assert.match(dedans.getAttribute('title'), /Vacances/, 'le motif est dit')
  assert.match(dedans.getAttribute('title'), /supprimez le congé/,
    'et le geste pour le libérer aussi — sans ça, l\'hôte cherche un bouton qui n\'existe pas')

  const dehors = caseDu(w, dans(8))
  assert.ok(!dehors.classList.contains('conge'))
})

test('cliquer un jour VERROUILLÉ n\'écrit rien', async () => {
  // ⚠ LE CAS DANGEREUX. Gratter un jour au milieu d'un congé laisserait une
  // plage qui dit une chose et un calendrier qui en montre une autre.
  const { w, t } = monterPage({ conges: [{ id: 'c1', debut: dans(3), fin: dans(6), source: 'hote' }] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  const avant = t.appels.length
  const el = caseDu(w, dans(4))
  pointe(w, el, 'pointerdown')
  relacher(w)
  await souffler(10)
  assert.strictEqual(t.appels.length, avant, 'aucune requête n\'est partie')
})

test('la liste des congés distingue qui l\'a posé, et permet de le retirer', async () => {
  const { w, t } = monterPage({
    conges: [{ id: 'c1', debut: dans(3), fin: dans(6), motif: 'Vacances', source: 'prestataire' }] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  const zone = w.document.getElementById('dispo-conges')
  assert.match(zone.textContent, /déclaré par elle/)
  const bouton = zone.querySelector('[data-conge]')
  assert.ok(bouton, 'un bouton de retrait existe')

  bouton.click()
  await souffler(20)
  const retrait = t.appels.find(a => a.corps && a.corps.action === 'retirerConge')
  assert.ok(retrait, 'le retrait part')
  assert.strictEqual(retrait.corps.id, 'c1')
  assert.ok(!caseDu(w, dans(4)).classList.contains('conge'), 'et le jour se libère')
})

// ─── Le clic et le glissé ──────────────────────────────────────────────────

test('cliquer un jour vert le passe en rouge, et pose une exception', async () => {
  const { w, t } = monterPage()
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  const j = dans(2)
  assert.ok(!caseDu(w, j).classList.contains('off'), 'vert au départ')

  pointe(w, caseDu(w, j), 'pointerdown')
  relacher(w)
  await souffler(30)

  const pose = t.appels.find(a => a.corps && a.corps.action === 'poserException')
  assert.ok(pose, 'une exception est posée')
  assert.strictEqual(pose.corps.date, j)
  assert.strictEqual(pose.corps.available, false)
  assert.ok(caseDu(w, j).classList.contains('off'), 'et le jour devient rouge')
  assert.ok(caseDu(w, j).classList.contains('manuel'),
    'le point dit qu\'il est réglé à la main — sans lui, retirer la récurrence laisserait ' +
    'des jours inexplicables')
})

test('recliquer un jour réglé à la main le REND À LA RÉCURRENCE', async () => {
  // ⚠ Il ne bascule pas une troisième fois : l'exception est RETIRÉE, et le jour
  // reprend ce que la règle en dit. Sans ça, on empilerait des exceptions
  // redondantes que plus rien n'expliquerait.
  const j = dans(2)
  const { w, t } = monterPage({ exceptions: [{ id: 'e1', date: j, available: false, source: 'hote' }] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  assert.ok(caseDu(w, j).classList.contains('off'))

  pointe(w, caseDu(w, j), 'pointerdown')
  relacher(w)
  await souffler(30)

  const retrait = t.appels.find(a => a.corps && a.corps.action === 'retirerException')
  assert.ok(retrait, 'l\'exception est retirée, pas inversée une seconde fois')
  assert.strictEqual(retrait.corps.id, 'e1')
  assert.ok(!caseDu(w, j).classList.contains('manuel'), 'le point disparaît avec elle')
})

test('un glissé bascule toute la plage dans le MÊME sens', async () => {
  // ⚠ Le sens est celui du PREMIER jour touché. Basculer chaque jour selon son
  // propre état donnerait un damier — l'inverse du geste « je pose trois jours
  // d'absence ».
  const { w, t } = monterPage({ exceptions: [{ id: 'e1', date: dans(3), available: false, source: 'hote' }] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)

  pointe(w, caseDu(w, dans(2)), 'pointerdown')
  pointe(w, caseDu(w, dans(3)), 'pointerover')
  pointe(w, caseDu(w, dans(4)), 'pointerover')
  relacher(w)
  await souffler(60)

  for (const j of [dans(2), dans(3), dans(4)]) {
    assert.ok(caseDu(w, j).classList.contains('off'), `${j} doit être absent`)
  }
})

test('le passé ne se modifie pas', async () => {
  const { w, t } = monterPage()
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  const hier = caseDu(w, dans(-1))
  if (!hier) return                       // le 1er du mois, hier n'est pas affiché
  assert.ok(hier.classList.contains('passe'))
  const avant = t.appels.length
  pointe(w, hier, 'pointerdown')
  relacher(w)
  await souffler(10)
  assert.strictEqual(t.appels.length, avant)
})

// ─── Semaine A / Semaine B ─────────────────────────────────────────────────

test('deux règles en quinzaine affichent DEUX lignes et les lettres A/B', async () => {
  const lundi = (() => { const d = new Date(AUJ); return iso(new Date(d.getTime() -
    ((d.getUTCDay() + 6) % 7) * 86400000)) })()
  const lundiB = iso(new Date(new Date(lundi + 'T12:00:00Z').getTime() + 7 * 86400000))
  const { w, t } = monterPage({ regles: [
    { id: 'rA', label: 'A', active: true, jours: [6, 0], cadence: 2, ancre: lundi },
    { id: 'rB', label: 'B', active: true, jours: [1, 2], cadence: 2, ancre: lundiB }
  ] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)

  const tags = [...w.document.querySelectorAll('#dispo-recur .dispo-tag')].map(e => e.textContent.trim())
  assert.deepStrictEqual(tags, ['Semaine A', 'Semaine B'])
  assert.match(w.document.getElementById('dispo-recur').textContent, /Cette semaine est une/,
    'l\'ancrage est ÉCRIT — sans lui, « une semaine sur deux » ne désigne rien')

  const lettres = [...w.document.querySelectorAll('#dispo-months .dispo-sem')]
    .map(e => e.textContent.trim()).filter(Boolean)
  assert.ok(lettres.includes('A') && lettres.includes('B'),
    'la lettre est rappelée à gauche de chaque semaine, pas seulement dans le réglage')
})

test('« Une semaine sur deux… » dédouble la ligne et garde les jours', async () => {
  const { w, t } = monterPage({ regles: [
    { id: 'r1', label: 'simple', active: true, jours: [1, 3], cadence: 1, ancre: dans(0) } ] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  assert.strictEqual(w.document.querySelectorAll('#dispo-recur .dispo-ligne-jours').length, 1)

  w.document.getElementById('btn-alt').click()
  await souffler(40)

  assert.strictEqual(w.document.querySelectorAll('#dispo-recur .dispo-ligne-jours').length, 2,
    'deux lignes après la bascule')
  const pose = t.appels.filter(a => a.corps && a.corps.action === 'poserRegle')
  assert.ok(pose.length >= 1)
  assert.strictEqual(pose[pose.length - 1].corps.toutes_les_n_semaines, 2)
  assert.deepStrictEqual(pose[pose.length - 1].corps.jours, [1, 3],
    'les jours de la semaine A sont conservés, pas réinventés')
})

test('AUCUNE chaîne RRULE ne transite par l\'écran, dans aucun sens', async () => {
  // ⚠ Décision gravée au §2 de la spec. L'écran envoie des jours et une cadence ;
  // le serveur produit le standard. Une RRULE acceptée depuis le client serait
  // une expression exécutée sur les données d'un autre compte.
  const { w, t } = monterPage({ regles: [
    { id: 'r1', label: 'simple', active: true, jours: [1], cadence: 1, ancre: dans(0) } ] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  w.document.getElementById('btn-alt').click()
  await souffler(40)
  for (const a of t.appels) {
    assert.ok(!JSON.stringify(a.corps || {}).includes('RRULE'),
      'aucun corps ne doit porter de RRULE')
    assert.ok(!JSON.stringify(a.corps || {}).includes('DTSTART'))
  }
  assert.ok(!w.document.getElementById('dispo-recur').textContent.includes('FREQ='),
    'et rien n\'en affiche')
})

// ─── Les huit constats de la review, chacun avec son test ─────────────────

test('AUCUNE capture de pointeur — elle casserait le glissé dans un vrai navigateur', async () => {
  // ⚠ LE FAUX VERT QUE CE FICHIER DISAIT VOULOIR FERMER, ET QU'IL PORTAIT.
  // `setPointerCapture` retargette TOUS les événements suivants vers l'élément
  // capturant, `pointerover` compris : `e.target.closest()` rendrait toujours la
  // case de départ, et un glissé sur trois jours n'en basculerait qu'un. Le test
  // passait parce que jsdom n'implémente pas cette méthode. On l'interdit donc
  // par le source — c'est le seul endroit où un DOM ne peut pas nous aider.
  const src = fs.readFileSync(FICHIER, 'utf8')
  const vivants = src.split('\n').filter(l => l.includes('setPointerCapture') && !l.trim().startsWith('//'))
  assert.deepStrictEqual(vivants, [],
    'aucun appel vivant à setPointerCapture : il casserait le glissé en production')
})

test('le sens du glissé vient de l\'ANCRE, même en glissant vers le PASSÉ', async () => {
  // ⚠ LE CAS QUI RENVERSAIT LE GESTE. Mercredi déjà rouge, jeudi et vendredi
  // verts. L'hôte glisse de VENDREDI vers MERCREDI pour poser trois absences.
  // En prenant le sens sur la plus petite date — mercredi, rouge — les trois
  // jours passaient VERTS et l'absence du mercredi était effacée.
  const mer = dans(2), jeu = dans(3), ven = dans(4)
  const { w, t } = monterPage({ exceptions: [{ id: 'e1', date: mer, available: false, source: 'hote' }] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  assert.ok(caseDu(w, mer).classList.contains('off'), 'mercredi part rouge')

  pointe(w, caseDu(w, ven), 'pointerdown')      // l'ancre est VENDREDI, qui est vert
  pointe(w, caseDu(w, jeu), 'pointerover')
  pointe(w, caseDu(w, mer), 'pointerover')
  relacher(w)
  await souffler(80)

  for (const j of [mer, jeu, ven]) {
    assert.ok(caseDu(w, j).classList.contains('off'),
      `${j} doit être absent : le geste partait d'un jour vert, il pose des absences`)
  }
})

test('le survol ne retient ni le passé ni un jour de congé', async () => {
  // Sans ces gardes, `cibleSel` étirait la sélection sur des jours que la boucle
  // ignore : l'hôte voyait un contour bien plus large que ce qui allait changer.
  const { w, t } = monterPage({ conges: [{ id: 'c1', debut: dans(5), fin: dans(7), source: 'hote' }] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  pointe(w, caseDu(w, dans(2)), 'pointerdown')
  pointe(w, caseDu(w, dans(6)), 'pointerover')   // en plein congé
  const selectionnes = [...w.document.querySelectorAll('#dispo-months .dispo-case.sel')]
  assert.ok(!selectionnes.some(e => e.dataset.jour === dans(6)),
    'un jour de congé n\'entre pas dans la sélection')
  relacher(w)
  await souffler(40)
})

test('DEUX règles héritées fusionnent — aucun jour ne disparaît au premier clic', async () => {
  // ⚠ L'ancien écran posait autant de règles qu'on cliquait sur « Ajouter ».
  // N'en montrer qu'une faisait un écran qui se contredit — les cases disaient
  // lundi, le calendrier peignait aussi les samedis — puis le premier changement
  // retirait tout et ne reposait que la ligne affichée.
  const { w, t } = monterPage({ regles: [
    { id: 'r1', label: 'lundis', active: true, jours: [1], cadence: 1, ancre: dans(0) },
    { id: 'r2', label: 'samedis', active: true, jours: [6], cadence: 1, ancre: dans(0) }
  ] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  const coches = [...w.document.querySelectorAll('#dispo-recur input[data-lot="A"]:checked')]
    .map(c => Number(c.value)).sort()
  assert.deepStrictEqual(coches, [1, 6],
    'les cases montrent l\'union — sinon elles contredisent le calendrier')
})

test('une règle qu\'on ne sait pas relire est DITE, et retirée au remplacement', async () => {
  // ⚠ Elle compte pour le moteur mais n'apparaît dans aucune case. Sans message,
  // l'écran affirmerait « aucune règle » sur quelqu'un qui en a une ; et sans
  // retrait, le « remplacement » serait une addition définitive.
  const { w, t } = monterPage({ regles: [
    { id: 'opaque', label: 'tous les jours', active: true, jours: null, cadence: null, ancre: null }
  ] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  assert.match(w.document.getElementById('dispo-hint').textContent, /ne sait pas afficher/,
    'l\'écran dit qu\'une règle lui échappe')

  const c = w.document.querySelector('#dispo-recur input[data-lot="A"]')
  c.checked = true
  c.dispatchEvent(new w.Event('change', { bubbles: true }))
  await souffler(60)
  const retraits = t.appels.filter(a => a.corps && a.corps.action === 'retirerRegle')
  assert.ok(retraits.some(r => r.corps.id === 'opaque'),
    'la règle opaque est retirée comme les autres : un remplacement remplace')
})

test('« Une semaine sur deux… » fonctionne SANS aucun jour coché', async () => {
  // ⚠ C'est le parcours d'une prestataire qu'on vient de créer : aucune règle.
  // Le bouton ne posait rien, donc le mode n'était pas déduit, donc l'écran
  // repeignait une ligne simple — il paraissait mort.
  const { w, t } = monterPage({ regles: [] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  w.document.getElementById('btn-alt').click()
  await souffler(60)
  assert.strictEqual(w.document.querySelectorAll('#dispo-recur .dispo-ligne-jours').length, 2,
    'les deux lignes apparaissent même sans règle préalable')
})

test('« Cette semaine est une semaine A » est vrai PAR CONSTRUCTION', async () => {
  // ⚠ La première version désignait A par l'ordre des ancrages : vider la ligne A
  // faisait remonter B, et la phrase changeait de lettre sans que personne ne
  // l'ait demandé. A est désormais, par définition, le lot qui couvre la semaine
  // en cours — la phrase devient une tautologie, donc toujours juste.
  const lundiProchain = (() => { const d = new Date(AUJ)
    const l = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000)
    return iso(new Date(l.getTime() + 7 * 86400000)) })()
  // Une seule règle, ancrée sur la semaine SUIVANTE : elle ne couvre pas celle-ci.
  const { w, t } = monterPage({ regles: [
    { id: 'rB', label: 'B', active: true, jours: [1], cadence: 2, ancre: lundiProchain }
  ] })
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  const txt = w.document.getElementById('dispo-recur').textContent
  assert.match(txt, /Cette semaine est une\s+semaine A/,
    'la phrase dit toujours A — c\'est la définition, pas une supposition')
  const coches = [...w.document.querySelectorAll('#dispo-recur input[data-lot="B"]:checked')]
  assert.strictEqual(coches.length, 1,
    'et la règle qui ne couvre pas cette semaine est bien sur la ligne B')
})

test('un échec du serveur PENDANT un glissé est dit, il n\'est pas avalé', async () => {
  const { w, t } = monterPage()
  t.seed()
  await t.chargerDisponibilites(PROFIL)
  let dits = []
  w.alert = m => dits.push(String(m))
  // Le serveur refuse la deuxième écriture.
  let n = 0
  const vrai = w.fetch
  w.fetch = async (url, opts) => {
    const corps = opts && opts.body ? JSON.parse(opts.body) : null
    if (corps && corps.action === 'poserException' && ++n === 2) {
      return { ok: false, status: 503, json: async () => ({ error: 'Service temporairement indisponible' }) }
    }
    return vrai(url, opts)
  }
  pointe(w, caseDu(w, dans(2)), 'pointerdown')
  pointe(w, caseDu(w, dans(3)), 'pointerover')
  pointe(w, caseDu(w, dans(4)), 'pointerover')
  relacher(w)
  await souffler(80)
  assert.ok(dits.length, 'l\'hôte est prévenu que la plage n\'est pas passée en entier')
})
