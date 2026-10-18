// tests/menages-fiche-regles-dom.test.js
// SES JOURS HABITUELS, COCHÉS DEPUIS LA FICHE, DANS UN VRAI DOM
// (constats de la revue de 70f805d).
//
// ⚠ POURQUOI CE FICHIER EXISTE. L'étape 2 a rendu les pastilles de jours
// cochables depuis la fiche de l'hôte. Les tests qui la couvraient lisaient le
// HTML comme du TEXTE : ils ont vu que les cases étaient là, et rien d'autre.
// La revue, elle, a trouvé trois défauts qu'aucune expression régulière ne peut
// voir, parce qu'ils vivent dans ce que le DOM devient APRÈS un clic :
//   1. le lot A partait ancré sur la semaine de la ligne B une semaine sur
//      deux — ses venues se décalaient de sept jours, sans cause visible ;
//   2. une règle HEBDOMADAIRE n'apparaissait que sur la ligne A, et le clic
//      suivant l'effaçait de la ligne B ;
//   3. une seconde case cochée pendant l'envoi de la première se perdait en
//      silence, et la première se décochait sous le doigt.
//
// ⚠ ON EXÉCUTE LE VRAI SCRIPT DE LA PAGE, pas une copie. Recopier `htmlSemaines`
// dans le test ferait un double qui reste vert pendant que la fiche est fausse.
//
// ⚠ ET TOUT EST RELATIF À AUJOURD'HUI (règle du dépôt : dates relatives si le
// test lit l'horloge). L'écran compare chaque ancre à la semaine en cours : des
// dates figées rendraient ce fichier rouge un lundi de l'année prochaine.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const HTML = fs.readFileSync(path.join(__dirname, '..', 'pages', 'menages.html'), 'utf8')
const PROFIL = 'p-lola'

const auj = new Date()
const AUJ = new Date(Date.UTC(auj.getUTCFullYear(), auj.getUTCMonth(), auj.getUTCDate(), 12))
const iso = d => d.toISOString().slice(0, 10)
const lundiDe = (d) => {
  const x = new Date(d.getTime())
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7))
  return iso(x)
}
const LUNDI = lundiDe(AUJ)
const LUNDI_SUIVANT = iso(new Date(Date.parse(LUNDI + 'T12:00:00Z') + 7 * 86400000))
const LUNDI_PRECEDENT = iso(new Date(Date.parse(LUNDI + 'T12:00:00Z') - 7 * 86400000))

// Une règle telle que `/api/disponibilites` la rend : la forme lue, pas la RRULE.
const regle = (jours, { cadence = 1, ancre = null, id = 'r' + Math.random().toString(36).slice(2, 7),
                        source = 'hote' } = {}) =>
  ({ id, label: 'Ses jours', active: true, jours, cadence, ancre, source,
     created_at: new Date().toISOString() })

const souffler = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)) }

// Un module `shared/` chargé pour de vrai : on retire ses `export` et on pose
// dans la fenêtre les noms que la page lui emprunte.
function chargerShared (w, fichier, noms) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared', fichier), 'utf8')
    .replace(/^export /gm, '')
  w.eval(`(() => {${src}\n${noms.map(n => `globalThis.${n} = ${n}`).join(';')}})()`)
}

function monter ({ regles = [], droits = 'write' } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only',
                                url: 'https://hotesmart.vercel.app/menages' })
  const w = dom.window
  const appels = []
  // L'état du serveur, que les POST font réellement bouger : un double qui
  // répondrait « ok » sans rien changer rendrait tout geste indétectable.
  const base = { regles: regles.slice() }

  const fiche = {
    personne: { id: PROFIL, prenom: 'Lola', nom: 'M.', tel: null, email: null,
                self_availability: true, vue_le: null },
    liaisons: [], biens: [], droits: { prestataires: droits, equipe: droits, avis: 'none' }
  }

  w.fetch = async (url, opts = {}) => {
    const corps = opts.body ? JSON.parse(opts.body) : null
    appels.push({ url: String(url), methode: opts.method || 'GET', corps })
    if (String(url).startsWith('/api/menages?presta=')) {
      return { ok: true, status: 200, json: async () => fiche }
    }
    if (String(url).startsWith('/api/disponibilites?')) {
      return { ok: true, status: 200, json: async () => ({
        regles: base.regles, exceptions: [], conges: [], jours: [], visibilite: null }) }
    }
    if (String(url) === '/api/disponibilites' && corps && corps.action === 'reglerJours') {
      // Ce que fait la fonction Postgres : elle REMPLACE tout ce qui est actif.
      const cadence = Number(corps.toutes_les_n_semaines) || 1
      base.regles = (corps.lots || []).filter(l => l.jours && l.jours.length)
        .map((l, i) => regle(l.jours.slice(), { cadence, ancre: l.ancre || null, id: 'srv-' + i }))
      return { ok: true, status: 200, json: async () => ({ success: true, poses: base.regles.length }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  }

  // ─── Les imports de la page, remplacés par des doubles ────────────────────
  w.requireAuth = async () => ({ access_token: 'jwt' })
  w.getUser = async () => ({ id: 'compte-1', email: 'h@ex.fr' })
  w.signOut = async () => {}
  w.initErrorHandler = () => {}
  w.logger = { error () {}, warn () {}, info () {}, debug () {} }
  w.escapeHtml = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  // ⚠ LES ALIAS COMPTENT : la page importe `escapeHtml as esc` et
  // `classesWE as classesWEDuJour`. C'est le nom LOCAL que le script utilise.
  w.esc = w.escapeHtml
  w.classesWEDuJour = () => ''
  w.compteCourant = () => null
  w.peutLire = () => true
  w.peutEcrire = () => true
  w.estTitulaire = () => true
  w.comptes = () => []
  w.basculerVers = async () => {}
  w.enteteCompte = () => ({})
  w.toISO = d => iso(new Date(d))
  w.couleurDe = () => '#888'
  w.bandeJoursHtml = () => ''
  w.classesWE = () => ''
  w.lignesATraiter = () => []
  w.nonVuPar = () => null
  w.limiteDeLImminence = (d) => iso(new Date(Date.parse(d + 'T12:00:00Z') + 30 * 86400000))
  // ⚠ CE MODULE-LÀ EST LE VRAI, pas un double. Il décide de l'état affiché en
  // haut de la fiche ; un stub le rendrait toujours « ok » et masquerait une
  // exception au premier rendu — c'est-à-dire exactement ce que ces tests
  // doivent pouvoir voir.
  chargerShared(w, 'presta-etat.js',
    ['etatDeLaPrestataire', 'defautDeLaLiaison', 'joursAffiches', 'joursApresClic', 'gesteDuJour'])
  w.hsBus = { demander: async () => null, publier () {}, ecouter () {} }
  w.brancherReordonnancement = () => {}
  w.renderSidebar = async () => {}
  w.supabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
    from () { const q = { select: () => q, eq: () => q, order: () => q, limit: () => q,
                          maybeSingle: async () => ({ data: null, error: null }),
                          then: ok => ok({ data: [], error: null }) }; return q }
  }
  // ⚠ L'i18n REND SA CLÉ, et c'est voulu : ces tests jugent des GESTES, pas des
  // phrases. Les phrases sont tenues par `tests/i18n-*` et par i18n-check.
  w.I18n = { lang: 'fr', apply () {}, t: (k, v) => k + (v ? ' ' + JSON.stringify(v) : '') }

  let src = /<script type="module">([\s\S]*?)<\/script>/.exec(HTML)[1]
    // ⚠ LES IMPORTS SE RETIRENT SUR PLUSIEURS LIGNES : l'un d'eux porte son
    // `from` à la ligne suivante, et un remplacement ligne à ligne laissait une
    // moitié d'instruction — donc une erreur de syntaxe au lieu d'un test.
    .replace(/^\s*import\s+[\s\S]*?from\s*'[^']*'\s*$/gm, '')
    .replace(/^\s*init\(\)[\s\S]*?$/gm, '')
  src += `
    globalThis.__c = { ouvrirConfig, brancherConfig, cfg, renderConfig }
  `
  w.eval(`(async () => {${src}})()`)
  return { w, appels, base, __c: () => w.__c }
}

async function ouvrir (ctx) {
  await souffler(5)
  const c = ctx.__c()
  assert.ok(c, 'le script de la page s\'est exécuté')
  c.brancherConfig()
  await c.ouvrirConfig(PROFIL)
  await souffler()
  return c
}

const cases = (w, lot) => [...w.document.querySelectorAll(`[data-cfg-regle="${lot}"]`)]
const coches = (w, lot) => cases(w, lot).filter(i => i.checked).map(i => Number(i.value)).sort()
const cocher = async (w, lot, jour) => {
  const el = w.document.querySelector(`[data-cfg-regle="${lot}"][value="${jour}"]`)
  assert.ok(el, `la case ${lot}/${jour} existe`)
  el.checked = !el.checked
  el.dispatchEvent(new w.Event('change', { bubbles: true }))
}

// ─── Constat 1 : le lot A est la semaine COURANTE ──────────────────────────

test('en quinzaine, le lot A part ancré sur la semaine en cours, quel que soit l\'ordre des règles', async () => {
  // ⚠ LE CAS QUI MENTAIT. Les deux règles sont posées dans le même geste ; rien
  // ne garantit l'ordre dans lequel la base les rend. Ici celle de la semaine
  // SUIVANTE (ligne B) arrive en premier — une semaine sur deux, c'est ce que
  // la base renvoie. L'écran lisait son ancre et l'attribuait au lot A : les
  // deux lignes partaient échangées, et ses venues se décalaient d'une semaine.
  const ctx = monter({ regles: [
    regle([6], { cadence: 2, ancre: LUNDI_SUIVANT, id: 'rB' }),   // samedi, ligne B
    regle([1], { cadence: 2, ancre: LUNDI, id: 'rA' })            // lundi, ligne A
  ] })
  const w = ctx.w
  await ouvrir(ctx)

  assert.deepEqual(coches(w, 'A'), [1], 'la ligne A montre le lundi')
  assert.deepEqual(coches(w, 'B'), [6], 'la ligne B montre le samedi')

  await cocher(w, 'A', 2)   // on ajoute le mardi à la semaine en cours
  await souffler()

  const post = ctx.appels.filter(a => a.corps && a.corps.action === 'reglerJours').pop()
  assert.ok(post, 'le geste est parti')
  assert.equal(post.corps.lots.length, 2, 'deux lots, un par ligne')
  assert.deepEqual(post.corps.lots[0].jours.slice().sort(), [1, 2], 'le lot A porte les jours de la ligne A')
  assert.equal(post.corps.lots[0].ancre, LUNDI,
    'et il est ancré sur le lundi de la semaine EN COURS, pas sur celui de la ligne B')
  assert.deepEqual(post.corps.lots[1].jours, [6], 'le lot B porte les jours de la ligne B')
  assert.equal(post.corps.lots[1].ancre, LUNDI_SUIVANT, 'ancré une semaine plus tard')
})

test('une ancre plus ancienne de parité PAIRE reste la semaine en cours', async () => {
  // Deux semaines en arrière : même parité qu'aujourd'hui, donc la règle couvre
  // bien la semaine en cours. Le réglage réécrit doit garder cette parité.
  const ilYADeuxSemaines = iso(new Date(Date.parse(LUNDI + 'T12:00:00Z') - 14 * 86400000))
  const ctx = monter({ regles: [regle([3], { cadence: 2, ancre: ilYADeuxSemaines })] })
  const w = ctx.w
  await ouvrir(ctx)
  assert.deepEqual(coches(w, 'A'), [3], 'la règle tombe sur la semaine en cours')

  await cocher(w, 'B', 5)
  await souffler()
  const post = ctx.appels.filter(a => a.corps && a.corps.action === 'reglerJours').pop()
  assert.equal(post.corps.lots[0].ancre, LUNDI, 'le lot A reste la semaine en cours')
  assert.equal(post.corps.lots[1].ancre, LUNDI_SUIVANT, 'et le lot B la suivante')
})

// ─── Constat 2 : une règle hebdomadaire vit sur les DEUX lignes ────────────

test('en quinzaine, une règle hebdomadaire s\'affiche sur les DEUX semaines', async () => {
  const ctx = monter({ regles: [
    regle([2], { cadence: 1 }),                                   // mardi, toutes les semaines
    regle([6], { cadence: 2, ancre: LUNDI })                      // samedi, une sur deux
  ] })
  const w = ctx.w
  await ouvrir(ctx)

  assert.deepEqual(coches(w, 'A'), [2, 6], 'la ligne A porte le mardi et le samedi')
  assert.deepEqual(coches(w, 'B'), [2],
    'et la ligne B porte le mardi : une règle hebdomadaire vaut pour les deux semaines')
})

test('et le geste suivant ne l\'efface pas de la semaine B', async () => {
  const ctx = monter({ regles: [
    regle([2], { cadence: 1 }),
    regle([6], { cadence: 2, ancre: LUNDI })
  ] })
  const w = ctx.w
  await ouvrir(ctx)

  await cocher(w, 'A', 4)   // on ajoute le jeudi en semaine A
  await souffler()
  const post = ctx.appels.filter(a => a.corps && a.corps.action === 'reglerJours').pop()
  assert.deepEqual(post.corps.lots[1].jours.slice().sort(), [2],
    'le mardi reste dans le lot B — sans quoi il disparaît une semaine sur deux')
})

// ─── Constat 3 : deux cases cochées à la suite ─────────────────────────────

test('cocher un second jour pendant l\'envoi du premier ne perd rien', async () => {
  // ⚠ L'USAGE NORMAL DE CES CASES. On règle rarement un seul jour : on en coche
  // trois d'affilée. Le verrou de la fiche sortait en silence sur le deuxième.
  // ⚠ ON PART D'UN RÉGLAGE EXISTANT, pas d'une liaison vierge : sans aucune
  // règle, l'écran coche les sept cases en gris (« tous les jours par défaut »)
  // et un clic DÉcoche. Ce test-ci parle d'ajouts successifs.
  const ctx = monter({ regles: [regle([1])] })   // elle vient le lundi
  const w = ctx.w
  await ouvrir(ctx)

  await cocher(w, 'A', 2)       // mardi — l'envoi part
  await cocher(w, 'A', 3)       // mercredi — pendant que le premier vole
  await souffler(80)

  const posts = ctx.appels.filter(a => a.corps && a.corps.action === 'reglerJours')
  assert.equal(posts.length, 2, 'les deux gestes sont partis')
  assert.deepEqual(posts[0].corps.lots[0].jours.slice().sort(), [1, 2], 'le premier porte le mardi')
  assert.deepEqual(posts[1].corps.lots[0].jours.slice().sort(), [1, 2, 3],
    'et le second porte le mercredi EN PLUS — rien ne s\'est perdu')
  assert.deepEqual(coches(w, 'A'), [1, 2, 3], 'l\'écran montre les trois jours cochés')
})

test('pendant l\'envoi, la case qu\'on vient de cocher reste cochée', async () => {
  const ctx = monter({ regles: [regle([1])] })
  const w = ctx.w
  await ouvrir(ctx)

  await cocher(w, 'A', 2)
  // Le repeint du verrou a déjà eu lieu ; la réponse du serveur, non. Avant le
  // correctif, ce repeint relisait `cfg.dispo` — l'état d'AVANT — et le mardi
  // disparaissait sous le doigt.
  assert.deepEqual(coches(w, 'A'), [1, 2],
    'le mardi ne se décoche pas pendant que l\'envoi vole')
  await souffler(80)
  assert.deepEqual(coches(w, 'A'), [1, 2], 'et il y est toujours après la réponse')
})

// ─── Constat 5 : une règle qu'on ne sait pas relire ferme le geste ─────────

test('une récurrence illisible ferme le geste, et la case revient à son état', async () => {
  const ctx = monter({ regles: [
    { id: 'op', label: 'Un mois sur deux', active: true, jours: null, cadence: 1, ancre: null }
  ] })
  const w = ctx.w
  await ouvrir(ctx)

  const avant = ctx.appels.length
  await cocher(w, 'A', 3)
  await souffler()
  assert.equal(ctx.appels.filter(a => a.corps && a.corps.action === 'reglerJours').length, 0,
    'rien n\'est parti : on n\'écrase pas une règle qu\'on ne sait pas relire')
  assert.deepEqual(coches(w, 'A'), [],
    'et la case cochée par le navigateur est revenue à son état — sinon l\'écran ment')
  assert.ok(ctx.appels.length >= avant)
})
