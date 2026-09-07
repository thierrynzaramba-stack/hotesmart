// tests/book-page-selection.test.js
// Spec : docs/specs/spec-moteur-reservation.md §4 — DOC : docs/kb/moteur-reservation.md
//
// POURQUOI CE FICHIER EXISTE.
// `pages/book.html` porte la logique de selection des dates, et elle n'avait
// AUCUN test. Sur douze constats de review du chantier, CINQ etaient dans ce
// fichier — dont deux correctifs qui se sont averes INERTES parce qu'un `return`
// premature les court-circuitait. Un commentaire qui affirme un correctif ne
// prouve rien ; ces tests, si.
//
// On evalue le <script> de la page tel quel dans un contexte VM, avec un DOM
// minimal. Aucune copie du code : si la page change, le test suit.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'book.html'), 'utf8')
const source = html.match(/<script>\n([\s\S]*?)<\/script>/)[1]

// ─── DOM minimal ────────────────────────────────────────────────────────────
// Juste ce que `caseJour` et `rendreCalendrier` touchent.
function faireElement (tag) {
  return {
    tag, className: '', innerHTML: '', type: '', disabled: false,
    dataset: {}, hidden: false, textContent: '', enfants: [],
    attributs: {},
    setAttribute (k, v) { this.attributs[k] = v },
    getAttribute (k) { return this.attributs[k] },
    appendChild (e) { this.enfants.push(e); return e },
    querySelectorAll () { return [] }
  }
}

function contexte () {
  const ctx = {
    document: {
      createElement: faireElement,
      getElementById: () => faireElement('div'),
      documentElement: {},
      addEventListener: () => {},
      querySelectorAll: () => []
    },
    navigator: { languages: ['fr-FR'], language: 'fr-FR' },
    location: { pathname: '/book/' + 'a'.repeat(43), search: '' },
    URLSearchParams,
    Intl,
    fetch: async () => ({ ok: false, status: 500 }),
    console
  }
  vm.createContext(ctx)
  vm.runInContext(source, ctx)
  return ctx
}

// ─── Harnais de fenetre ─────────────────────────────────────────────────────
const jour = (debut, n) => {
  const d = new Date(debut + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function poser (ctx, { debut, nuits, fermees = [], arrivee = null, depart = null }) {
  const parDate = {}
  for (let i = 0; i < nuits; i++) {
    const iso = jour(debut, i)
    parDate[iso] = { date: iso, prix: 80, disponible: !fermees.includes(iso) }
  }
  ctx.parDate = parDate
  ctx.nuits = Object.values(parDate)
  ctx.departMax = jour(debut, nuits)
  ctx.arrivee = arrivee
  ctx.depart = depart
  ctx.bien = { nom: 'Test', devise: 'EUR', capacite: 4 }
  ctx.limiteDepart = ctx.calculerLimiteDepart()
  return parDate
}

const caseDe = (ctx, iso) => ctx.caseJour(iso, Number(iso.slice(8, 10)))

// ─── La borne de depart ─────────────────────────────────────────────────────
test('sans nuit fermee, on peut partir le lendemain de la derniere nuit', () => {
  const ctx = contexte()
  poser(ctx, { debut: '2026-10-01', nuits: 10, arrivee: '2026-10-01' })
  assert.equal(ctx.limiteDepart, '2026-10-11')
})

test('la borne s arrete a la premiere nuit fermee — on en repart le matin', () => {
  const ctx = contexte()
  poser(ctx, { debut: '2026-10-01', nuits: 10, fermees: ['2026-10-04'], arrivee: '2026-10-01' })
  assert.equal(ctx.limiteDepart, '2026-10-04')
})

test('la borne franchit le changement d annee', () => {
  const ctx = contexte()
  poser(ctx, { debut: '2026-12-28', nuits: 8, arrivee: '2026-12-28' })
  assert.equal(ctx.limiteDepart, '2027-01-05')
})

test('sans arrivee, aucune borne', () => {
  const ctx = contexte()
  poser(ctx, { debut: '2026-10-01', nuits: 10 })
  assert.equal(ctx.limiteDepart, null)
})

test('365 nuits : la borne se calcule sans boucler', () => {
  const ctx = contexte()
  const t0 = Date.now()
  poser(ctx, { debut: '2026-10-01', nuits: 365, arrivee: '2026-10-01' })
  assert.equal(ctx.limiteDepart, '2027-10-01')
  assert.ok(Date.now() - t0 < 1000, 'calcul anormalement long')
})

// ─── CONSTAT DE REVIEW : la case de depart_max doit vivre ───────────────────
test('la derniere nuit publiee EST reservable : la case de depart_max est cliquable', () => {
  // Le `return` sur `!parDate[iso]` sortait AVANT le calcul du depart : la case
  // de `departMax` restait morte et la derniere nuit etait inreservable —
  // exactement ce que `depart_max` disait corriger.
  const ctx = contexte()
  poser(ctx, { debut: '2026-10-01', nuits: 10, arrivee: '2026-10-10' })
  assert.equal(ctx.limiteDepart, '2026-10-11')
  const c = caseDe(ctx, '2026-10-11')
  assert.equal(c.disabled, false, 'la case du depart hors fenetre doit etre cliquable')
  assert.ok(!/vide/.test(c.className), 'elle ne doit pas etre rendue « vide »')
})

test('hors choix de depart, une date hors fenetre reste morte', () => {
  const ctx = contexte()
  poser(ctx, { debut: '2026-10-01', nuits: 10 })
  const c = caseDe(ctx, '2026-10-11')
  assert.equal(c.disabled, true)
  assert.ok(/vide/.test(c.className))
})

// ─── CONSTAT DE REVIEW : desactiver, pas seulement reactiver ────────────────
test('une nuit libre AU-DELA d une nuit fermee n est pas cliquable comme depart', () => {
  // Elle n avait jamais ete desactivee : le voyageur la cliquait et recevait
  // « une des nuits n est plus disponible » sans savoir laquelle.
  const ctx = contexte()
  poser(ctx, { debut: '2026-10-01', nuits: 10, fermees: ['2026-10-03', '2026-10-04'], arrivee: '2026-10-01' })
  assert.equal(ctx.limiteDepart, '2026-10-03')
  assert.equal(caseDe(ctx, '2026-10-03').disabled, false, 'on repart le matin du 03')
  assert.equal(caseDe(ctx, '2026-10-07').disabled, true, 'le 07 est libre mais inatteignable')
})

test('une nuit prise garde son style « pris », meme pendant le choix du depart', () => {
  // Repeindre tout le calendrier en « libre » privait le voyageur du seul
  // repere visuel qui explique le refus.
  const ctx = contexte()
  poser(ctx, { debut: '2026-10-01', nuits: 10, fermees: ['2026-10-04'], arrivee: '2026-10-01' })
  assert.ok(/pris/.test(caseDe(ctx, '2026-10-04').className), 'le barre doit rester')
})

test('les dates dans la borne restent cliquables comme depart', () => {
  const ctx = contexte()
  poser(ctx, { debut: '2026-10-01', nuits: 10, arrivee: '2026-10-02' })
  assert.equal(caseDe(ctx, '2026-10-05').disabled, false)
})

test('une date anterieure a l arrivee reste cliquable : elle recommence la selection', () => {
  const ctx = contexte()
  poser(ctx, { debut: '2026-10-01', nuits: 10, arrivee: '2026-10-05' })
  assert.equal(caseDe(ctx, '2026-10-02').disabled, false)
})

// ─── Marque blanche et i18n ─────────────────────────────────────────────────
test('les trois langues portent exactement les memes cles', () => {
  const ctx = contexte()
  const cles = l => Object.keys(ctx.T[l]).sort().join(',')
  assert.equal(cles('es'), cles('fr'), 'ES diverge de FR')
  assert.equal(cles('en'), cles('fr'), 'EN diverge de FR')
})

test('chaque langue a 12 mois et 7 jours', () => {
  const ctx = contexte()
  for (const l of ['fr', 'es', 'en']) {
    assert.equal(ctx.T[l].mois.length, 12, `mois manquants en ${l}`)
    assert.equal(ctx.T[l].jours.length, 7, `jours manquants en ${l}`)
  }
})

test('aucun libelle traduit ne laisse un {n} non substitue', () => {
  const ctx = contexte()
  for (const l of ['fr', 'es', 'en']) {
    for (const [cle, val] of Object.entries(ctx.T[l])) {
      if (typeof val !== 'string' || !val.includes('{n}')) continue
      assert.ok(/^r_/.test(cle), `${l}.${cle} porte un {n} hors message de refus`)
    }
  }
})

test('MARQUE BLANCHE : la page ne prononce jamais le nom du produit', () => {
  // Amendement §4 bis : la marque affichee est celle de l hote, jamais la notre.
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, '')                       // commentaires HTML
    .replace(/^\s*\/\/.*$/gm, '')                          // commentaires JS de ligne
  assert.ok(!/H[oô]teSmart/i.test(visible),
    'la page publique mentionne HoteSmart hors commentaires')
})

test('la page est autonome : aucun CSS ni JS externe', () => {
  // La marque blanche ne doit dependre d aucune feuille de style HoteSmart, et
  // la page doit rester embarquable sans trainer le design system derriere.
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'feuille de style externe')
  assert.ok(!/<script[^>]+src=/i.test(html), 'script externe')
})


// ─── CONSTATS DE REVIEW (etape 3) ──────────────────────────────────────────

test('la confirmation se RE-REND au changement de langue', () => {
  // Elle est ecrite en innerHTML, donc invisible a `[data-t]` : sans re-rendu,
  // un voyageur qui bascule en ES/EN voyait toute la page changer SAUF sa
  // confirmation.
  const ctx = contexte()
  assert.equal(typeof ctx.rendreConfirmation, 'function')
  const src = source.slice(source.indexOf('function appliquerLangue'),
                           source.indexOf('function appliquerLangue') + 900)
  assert.match(src, /rendreConfirmation\(\)/,
    'appliquerLangue doit re-rendre la confirmation')
})

test('la devise de la confirmation vient de la REPONSE, pas de `bien`', () => {
  // `chargerConfirmation` court en parallele de `charger()` : si elle gagne la
  // course, `bien` est encore null et le total s'affichait en EUR.
  assert.match(source, /function argent\(v, devise\)/)
  assert.match(source, /argent\(d\.total, d\.devise\)/)
})

test('le jeton est resolu AVANT le traitement du retour de paiement', () => {
  // `afficherRetour()` tourne avant `charger()` et a besoin du jeton pour lire
  // la confirmation : le resoudre dans `charger()` le laissait nul.
  assert.ok(source.indexOf('resoudreJeton();') < source.indexOf('afficherRetour();'))
})

test('le nettoyage d URL ne retire QUE les parametres de retour', () => {
  // `location.pathname` tout sec effacait aussi `?token=`, et la page affichait
  // « lien inconnu » au lieu du calendrier.
  assert.match(source, /q\.delete\('paiement'\)/)
  assert.match(source, /q\.delete\('t'\)/)
  assert.ok(!/replaceState\(\{\}, '', location\.pathname\);/.test(source),
    'le chemin nu ne doit plus etre ecrit tel quel')
})

test('les trois etats de confirmation ont un libelle dans les trois langues', () => {
  const ctx = contexte()
  for (const l of ['fr', 'es', 'en']) {
    for (const k of ['conf_booked', 'conf_paid', 'conf_refunded']) {
      assert.ok(ctx.T[l][k] && ctx.T[l][k].length > 10, `${l}.${k}`)
    }
  }
})

test('les quatre politiques d annulation sont dites dans les trois langues', () => {
  const ctx = contexte()
  for (const l of ['fr', 'es', 'en']) {
    for (const p of ['non_remboursable', 'j14', 'j7', 'flexible_j2']) {
      assert.ok(ctx.T[l]['pol_' + p], `${l}.pol_${p} manquant`)
    }
  }
})


test('une reservation REMBOURSEE n affiche pas de conditions d annulation', () => {
  // ⚠ Constate a la validation reelle : la page disait « vous avez ete
  // integralement rembourse » PUIS « cette reservation n est pas remboursable ».
  // Une politique d annulation n a de sens que sur un sejour qui tient encore.
  const bloc = source.slice(source.indexOf('function rendreConfirmation'),
                            source.indexOf('function ligne('))
  assert.match(bloc, /if \(d\.statut !== 'refunded'\) \{/)
  const posPol = bloc.indexOf("t['pol_' + d.politique_annulation]")
  const posGarde = bloc.indexOf("d.statut !== 'refunded'")
  assert.ok(posGarde >= 0 && posGarde < posPol, 'la garde doit preceder l affichage')
})
