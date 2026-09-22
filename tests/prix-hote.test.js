// tests/prix-hote.test.js — LA MAIN DE L'HOTE sur un bien pilote (arbitrage A bis).
// Spec : docs/specs/spec-yieldflow-v1.md §2 ter, arbitrage A bis (22 sept. 2026).
//
// CE QUE CES TESTS DEFENDENT :
//   1. le cloisonnement est dans le WHERE (compte ET bien) ;
//   2. une table absente vaut « aucune main » ; une panne LEVE (un vide par
//      erreur ferait ecraser le prix de l'hote par le moteur) ;
//   3. l'ecran : la couleur du niveau sur toute la ligne, le prix de l'hote a
//      cote du conseil YieldFlow, la pop-up des evenements.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { prixHoteDuBien, poserPrixHote, retirerPrixHote, purgerPrixHotePasses } = require('../lib/prix-hote')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const BIEN = '22222222-2222-4222-8222-222222222222'
const lire = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

function fausseBase (lignes = [], { erreur = null } = {}) {
  const journal = []
  return { journal, from (table) {
    assert.equal(table, 'prix_hote', 'ce module ne touche que sa table')
    const q = { op: 'select', f: [], ligne: null }
    q.select = () => q; q.eq = (c, v) => { q.f.push([c, v]); return q }
    q.gte = () => q; q.lte = () => q; q.lt = (c, v) => { q.lt_ = v; return q }
    q.in = (c, v) => { q.in_ = [c, v]; return q }
    q.upsert = (rows, o) => { q.op = 'upsert'; q.ligne = rows; q.opts = o; return q }
    q.delete = () => { q.op = 'delete'; return q }
    q.then = (res, rej) => {
      journal.push({ op: q.op, f: q.f, ligne: q.ligne, opts: q.opts, in_: q.in_, lt_: q.lt_ })
      if (erreur) return Promise.resolve({ data: null, error: erreur }).then(res, rej)
      if (q.op === 'delete') return Promise.resolve({ data: lignes.filter(l => !q.in_ || q.in_[1].includes(l.stay_date)), error: null }).then(res, rej)
      return Promise.resolve({ data: q.op === 'select' ? lignes : null, error: null }).then(res, rej)
    }
    return q
  } }
}

test('LE TEST QUI COMPTE : poser et retirer portent le compte ET le bien, les prix sont en centimes entiers', async () => {
  const sb = fausseBase()
  const r = await poserPrixHote(sb, { userId: COMPTE, propertyId: BIEN, nuits: [{ date: '2026-10-15', cents: 13000 }, { date: '2026-10-16', cents: 13000.4 }] })
  assert.equal(r.ok, true); assert.equal(r.posees, 2)
  const up = sb.journal.find(j => j.op === 'upsert')
  assert.deepEqual(up.ligne.map(l => [l.user_id, l.property_id, l.stay_date, l.rate_cents]), [[COMPTE, BIEN, '2026-10-15', 13000], [COMPTE, BIEN, '2026-10-16', 13000]])
  assert.equal(up.opts.onConflict, 'property_id,stay_date', 'une nuit, un seul prix de l hote')
  const sb2 = fausseBase([{ stay_date: '2026-10-15' }])
  const x = await retirerPrixHote(sb2, { userId: COMPTE, propertyId: BIEN, dates: ['2026-10-15', 'n importe quoi'] })
  assert.equal(x.ok, true); assert.deepEqual(x.retirees, ['2026-10-15'])
  const del = sb2.journal.find(j => j.op === 'delete')
  assert.ok(del.f.some(([c, v]) => c === 'user_id' && v === COMPTE) && del.f.some(([c, v]) => c === 'property_id' && v === BIEN), 'cloisonne dans le WHERE')
  assert.deepEqual(del.in_, ['stay_date', ['2026-10-15']], 'une date invalide n est pas envoyee')
})

test('une nuit invalide ou un prix nul est refuse sans ecriture', async () => {
  const sb = fausseBase()
  assert.equal((await poserPrixHote(sb, { userId: COMPTE, propertyId: BIEN, nuits: [{ date: '2026-02-30', cents: 100 }] })).raison, 'nuit_invalide')
  assert.equal((await poserPrixHote(sb, { userId: COMPTE, propertyId: BIEN, nuits: [{ date: '2026-10-15', cents: 0 }] })).raison, 'nuit_invalide')
  assert.equal((await poserPrixHote(sb, { userId: 'x', propertyId: BIEN, nuits: [] })).raison, 'parametres_invalides')
  assert.equal(sb.journal.length, 0)
})

test('LE TEST QUI COMPTE : la table ABSENTE vaut « aucune main » ; une PANNE leve — un vide par erreur ferait ecraser le prix de l hote', async () => {
  const absente = fausseBase([], { erreur: { code: 'PGRST205', message: "Could not find the table 'public.prix_hote'" } })
  assert.deepEqual(await prixHoteDuBien(absente, BIEN, '2026-10-01', '2026-10-31'), new Map())
  const panne = fausseBase([], { erreur: { code: '57014', message: 'statement timeout' } })
  await assert.rejects(() => prixHoteDuBien(panne, BIEN, '2026-10-01', '2026-10-31'), /lecture : statement timeout/)
  const ok = fausseBase([{ stay_date: '2026-10-15', rate_cents: 13000 }])
  assert.deepEqual([...await prixHoteDuBien(ok, BIEN, '2026-10-01', '2026-10-31')], [['2026-10-15', 13000]])
  await assert.rejects(() => prixHoteDuBien(ok, 'pas-un-uuid', '2026-10-01', '2026-10-31'), /uuid/)
})

test('la purge ne touche que le PASSE du bien', async () => {
  const sb = fausseBase()
  await purgerPrixHotePasses(sb, BIEN, '2026-10-01')
  const del = sb.journal.find(j => j.op === 'delete')
  assert.equal(del.lt_, '2026-10-01'); assert.ok(del.f.some(([c, v]) => c === 'property_id' && v === BIEN))
})

// ─── L'ECRAN ────────────────────────────────────────────────────────────────
const PAGE = lire('apps/yield/prix.html').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

test('LE TEST QUI COMPTE : chaque ligne a vendre porte la couleur de son NIVEAU sur toute la ligne', () => {
  // Les cinq teintes existaient (CLASSES) mais ne coloraient que les badges :
  // demande de Thierry, recette du 22 septembre 2026, « comme la maquette Excel ».
  const ligne = PAGE.slice(PAGE.indexOf('function ligne (n, barA, barN1)'), PAGE.indexOf('function pourquoi (n)'))
  assert.match(ligne, /const niveau = !passe && !n\.vendue && n\.ouverte === true && n\.suggestion != null \? \(CLASSES\[n\.niveau\] \|\| ''\) : ''/)
  assert.match(ligne, /<tr class="\$\{we \? 'we' : ''\} \$\{etat\} \$\{niveau\}/, 'la classe de niveau est SUR le tr')
  for (const c of ['n-base', 'n-moyen', 'n-haut', 'n-tres-haut', 'n-exceptionnel']) assert.match(PAGE, new RegExp(`\\.${c}\\s*\\{ background:`), `la teinte ${c} existe`)
})

test('LE TEST QUI COMPTE : sur un bien pilote, le prix se modifie sur la ligne, le conseil YieldFlow reste a cote, et la main part avec `prix_hote: true`', () => {
  const editer = PAGE.slice(PAGE.indexOf('function editerPrix (date, bouton)'), PAGE.indexOf('async function retirerPrix'))
  assert.ok(editer.includes('YieldFlow : ${conseil}'), 'le conseil reste affiche a cote de la saisie')
  assert.ok(editer.includes("apiClient.calendar.save(bien, [{ date_from: date, date_to: date, rate: v }], { prix_hote: true })"), 'la porte du calendrier, avec le drapeau explicite')
  const ligne = PAGE.slice(PAGE.indexOf('function ligne (n, barA, barN1)'), PAGE.indexOf('function pourquoi (n)'))
  assert.ok(ligne.includes("pilote && n.ouverte === true ? `<button class=\"yp-editer\" data-editer="), 'le bouton n existe que sur un bien pilote, nuit ouverte')
  assert.ok(ligne.includes('votre prix') && ligne.includes('YieldFlow : ${euros(n.suggestion)}'), 'votre prix, et ce que YieldFlow proposait')
  assert.ok(ligne.includes('data-retirer='), 'et un geste pour revenir au prix YieldFlow')
  assert.match(PAGE, /retirerPrixHote: \(propertyId, dates\)/.test(lire('shared/api-client.js')) ? /apiClient\.calendar\.retirerPrixHote/ : /jamais/, 'le retrait passe par le client API')
})

test('LE TEST QUI COMPTE : la pop-up Evenements — un calendrier en tableau, la teinte du niveau sur les cases, un CONTOUR unifie par evenement, et jamais la semaine / le week-end comme evenement', () => {
  assert.match(PAGE, /id="yp-ouvrir-ev"/); assert.match(PAGE, /id="yp-ov-ev" role="dialog"/)
  const pop = PAGE.slice(PAGE.indexOf('function rendrePopup (message = \'\')'), PAGE.indexOf('function decalerJour (iso, n)'))
  assert.ok(pop.includes('<table class="yp-cal">'), 'un tableau')
  assert.ok(pop.includes("const niveau = n && n.suggestion != null && n.ouverte === true && !n.vendue ? (CLASSES[n.niveau] || '') : ''"), 'la case porte le niveau')
  assert.ok(pop.includes("(ev.calendrier || []).filter(e => e.debut <= finMois && e.fin >= debutMois)"), 'les evenements viennent du calendrier de pilotage (segments), pas des couches jour de semaine')
  assert.ok(pop.includes("premierDuEv ? 'ev-g' : ''") && pop.includes("dernierDuEv ? 'ev-d' : ''"), 'contour : premiere et derniere case')
  assert.match(PAGE, /\.yp-cal td\.ev \{ border-top-color: var\(--ev\); border-bottom-color: var\(--ev\)/, 'haut et bas sur toutes les cases : un seul trait')
  assert.ok(pop.includes('id="ev-ajouter">Ajouter un événement'), 'le bouton')
  assert.ok(!/weekend|week-end/i.test(pop.slice(0, pop.indexOf('const entrees'))), 'aucune notion de week-end avant les entrees : ce n est pas un evenement')
  // L'ancienne page redirige vers la pop-up, et la barre laterale aussi.
  assert.match(lire('apps/yield/evenements.html'), /location\.replace\('\/apps\/yield\/prix\?evenements=1'\)/)
  assert.match(lire('components/sidebar.js'), /href="\/apps\/yield\/prix\?evenements=1"/)
})

test('correctifs de review : prix REEL affiche et ecart marque, clavier sans propagation, evenements du MOIS, plusieurs evenements par jour, retour en calendrier vide la main', () => {
  const ligne = PAGE.slice(PAGE.indexOf('function ligne (n, barA, barN1)'), PAGE.indexOf('function pourquoi (n)'))
  assert.ok(ligne.includes('const ecart = n.prix_actuel != null && Math.round(n.prix_actuel * 100) !== Math.round(n.prix_hote * 100)'), 'l ecart memoire / calendrier se voit')
  assert.ok(ligne.includes('euros(n.prix_actuel != null ? n.prix_actuel : n.prix_hote)'), 'le prix affiche est celui du calendrier')
  const editer = PAGE.slice(PAGE.indexOf('function editerPrix (date, bouton)'), PAGE.indexOf('async function retirerPrix'))
  assert.ok(editer.includes("input.addEventListener('keydown', e => { e.stopPropagation();"), 'Entree ne deplie pas la ligne')
  const pop = PAGE.slice(PAGE.indexOf('async function lireEvenements'), PAGE.indexOf('function decalerJour (iso, n)'))
  assert.ok(pop.includes("apiEv('GET', null, { debut: `${mois}-01`, fin })"), 'la fenetre du mois affiche, pas les 12 mois a venir')
  assert.ok(pop.includes('if (!parJour.has(j)) parJour.set(j, [])'), 'plusieurs evenements par jour')
  assert.ok(pop.includes('sv.incertain_apres'), 'l horizon du calendrier scolaire se dit')
  assert.match(lire('api/yield-pilote.js'), /if \(voulu === 'calendrier' && actuel === 'yieldflow'\) await viderPrixHote/)
  assert.match(lire('scripts/piloter-yieldflow.js'), /prixHote = await prixHoteDuBien\(sb, bien\.id, auj, fin\)/, 'le dry-run voit la main')
})
