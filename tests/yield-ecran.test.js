// tests/yield-ecran.test.js
// LE DEFAUT QU'ILS EMPECHENT : un bloc qui disparait de l'ecran sans que rien
// ne le signale. Releve en review du recadrage : supprimer `blocProjection(d)`
// des TROIS vues laissait les 34 tests au vert — la fonction existait encore
// dans le fichier, donc les regex de `yield-motifs.test.js` matchaient toujours,
// et huit motifs devenaient muets en silence.
//
// Ici on EXECUTE le code de rendu sur une reponse fabriquee et on lit le HTML
// produit. C'est la difference entre verifier la FORME et verifier la
// CORRECTION (regle 13).
//
// Spec : docs/specs/spec-yieldflow-v1.md §7 (etape 4, lot 4.2)

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const RACINE = path.join(__dirname, '..')

// ─── On charge le VRAI code de rendu de la page ──────────────────────────────
// Les imports front (auth, sidebar, supabase) n'existent pas hors navigateur :
// on les neutralise. La table de motifs, elle, est le vrai fichier partage.
let ecran = null
let tmp = null
test.before(async () => {
  const page = fs.readFileSync(path.join(RACINE, 'apps/yield/index.html'), 'utf8')
  const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/^\s*import .*$/gm, '')
    .replace(/^\s*initErrorHandler\(\)\s*$/m, '')
    .replace(/^\s*init\(\)\s*$/m, '')
  const motifs = fs.readFileSync(path.join(RACINE, 'shared/yield-motifs.js'), 'utf8')
    .replace(/^export /gm, '')
  tmp = path.join(os.tmpdir(), `yf-ecran-${process.pid}.mjs`)
  fs.writeFileSync(tmp, `${motifs}\n${script}\nexport { rendre, choisirVue, MOTIFS }\n`
    + 'function choisirVue (v) { vue = v }\n')
  ecran = await import(`file://${tmp}`)
})
test.after(() => { if (tmp) { try { fs.unlinkSync(tmp) } catch {} } })

// ─── Une reponse d'API minimale mais REALISTE ────────────────────────────────
const AUJ = '2026-09-12'
function reponse (o = {}) {
  return {
    bien: { id: 'b1', name: 'La bulle', provider: 'channex', capacity: 2,
      zone_scolaire: 'C', prix_minimum: 9500, base_price: null },
    fenetre: { debut: '2026-09-01', fin: '2027-08-31', granularite: 'mois',
      pivot: AUJ, aujourdhui: AUJ },
    historique: { debut: '2023-09-01', fin: '2026-08-31', ans: 3 },
    realise: [], a_date: [], projection: [],
    reference: { seuil: 8, seuil_reservations: 3, fenetre: {}, nuits_vues: 680,
      nuits_sans_prix: 15, nuits_hors_reference: 0, nuits_long_sejour: 0,
      par_segment: {} },
    courbe: { paliers: [0, 7, 14, 30, 60, 90, 180], nuits_sans_date_fiable: 0,
      par_segment: {} },
    sources: { reservations: 1465, reservations_du_bien: 790,
      jours_hors_reference: 0,
      vacances: { complete: true, debut: '2022-12-17', fin: '2027-07-03',
        zones: ['A', 'B', 'C'], manque: null } },
    ...o
  }
}
const periode = (cle, o = {}) => ({
  periode: cle, reservations: 2, ca: 1000, nuitees: 10, nuits_a_prix_connu: 10,
  nuitees_hors_reference: 0, ca_hors_reference: 0, jours_ouverts: 30,
  taux_occupation: 0.33, revpar: 33.3, prix_moyen: 100, delai_median: 20,
  delais_utilises: 2, non_calculable: [],
  vs_n1: { periode_n1: '2025-09', disponible: true,
    ca: { valeur: 1000, n1: 800, ecart: 200, variation: 0.25 },
    taux_occupation: { valeur: 0.33, n1: 0.30, ecart: 0.03, variation: 0.1 } },
  ...o
})
const aDate = (cle, o = {}) => ({
  periode: cle, pivot: AUJ, periode_n1: '2025-' + cle.slice(5),
  pivot_n1: '2025-09-12', delai_jours: 19, alignement: 'delai_avant_le_debut',
  a_date: { periode: cle, ca: 500, nuitees: 5, non_calculable: [] },
  a_date_n1: { periode: '2025-' + cle.slice(5), ca: 400, nuitees: 4, non_calculable: [] },
  ecartes: {}, ecartes_n1: {}, candidats: 3, candidats_n1: 5,
  drapeaux: ['portefeuille_n1_reconstruit'],
  vs_n1: { periode_n1: '2025-' + cle.slice(5), disponible: true,
    ca: { valeur: 500, n1: 400, ecart: 100, variation: 0.25 } },
  ...o
})

// ─── LES BLOCS SONT LA, DANS CHAQUE VUE ──────────────────────────────────────

test('LE TEST QUI COMPTE : aucun bloc ne disparait sans qu on le sache', () => {
  // ⚠ C'est le test que la review reclamait : supprimer `blocProjection(d)` des
  // trois vues laissait tout vert. Ici on lit le HTML PRODUIT.
  const d = reponse({
    realise: [periode('2026-09'), periode('2025-09')],
    a_date: [aDate('2026-10')],
    projection: [{ periode: '2026-10', jours_projetes: 31, jours_sans_reference: 0,
      jours_replies: 2, prix_attendu_moyen: 130, part_attendue_a_ce_delai: 0.36,
      nuitees_finales_extrapolees: 14, nuitees_finales_min: 12,
      nuitees_finales_max: 20, non_calculable: [] }],
    reference: { ...reponse().reference,
      par_segment: { hors_vacances: { valeur: 117, echantillon: 353,
        reservations: 292, fiable: true, min: 35, max: 206, non_calculable: null } } },
    courbe: { ...reponse().courbe,
      par_segment: { hors_vacances: { segment: 'hors_vacances', nuits: 365,
        nuits_datees: 365, nuits_sans_date_fiable: 0, nuits_delai_negatif: 0,
        nuits_delai_illisible: 0, delai_median: 12, fiable: true,
        non_calculable: null,
        courbe: [0, 7, 14, 30, 60, 90, 180].map(j => ({ jours_avant: j, part_vendue: 0.5 })) } } }
  })
  const ATTENDUS = ['Réalisé', 'À date', 'Référence', 'Rythme de vente', 'Projection']
  for (const v of ['pilotage', 'bilan', 'exploration']) {
    ecran.choisirVue(v)
    const html = ecran.rendre(d)
    const titres = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map(m => m[1])
    // Le bilan n'a pas de projection : une annee revolue ne se projette pas.
    const requis = v === 'bilan' ? ATTENDUS.filter(t => t !== 'Projection') : ATTENDUS
    for (const t of requis) {
      assert.ok(titres.includes(t), `vue ${v} : le bloc « ${t} » a disparu`)
    }
  }
})

test('LE TEST QUI COMPTE : en pilotage, le portefeuille passe DEVANT le realise', () => {
  // ⚠ L'ordre dit ce qu'on regarde en premier, donc ce sur quoi on agit
  // (decision de Thierry, spec §7.1). Une app qui ouvre sur le realise ouvre
  // sur ce qu'on ne peut plus changer.
  const d = reponse({ realise: [periode('2026-09')], a_date: [aDate('2026-10')] })
  ecran.choisirVue('pilotage')
  const t = [...ecran.rendre(d).matchAll(/<h2>([^<]+)<\/h2>/g)].map(m => m[1])
  assert.ok(t.indexOf('À date') < t.indexOf('Réalisé'), 'le portefeuille doit passer devant')

  ecran.choisirVue('bilan')
  const b = [...ecran.rendre(d).matchAll(/<h2>([^<]+)<\/h2>/g)].map(m => m[1])
  assert.ok(b.indexOf('Réalisé') < b.indexOf('À date'), 'en bilan, le realise reprend la tete')
})

// ─── LA REGLE CENTRALE : JAMAIS UN CHIFFRE NU ────────────────────────────────

test('LE TEST QUI COMPTE : une periode A VENIR ne montre pas −100 %', () => {
  // Le moteur est PUR : il calcule un CA de 0 et une variation de −100 % sur un
  // mois qui n'a pas commence, a bon droit. L'ecran, lui, connait la date.
  const d = reponse({
    realise: [periode('2026-12', { ca: 0, nuitees: 0, taux_occupation: 0,
      vs_n1: { periode_n1: '2025-12', disponible: true,
        ca: { valeur: 0, n1: 3464, ecart: -3464, variation: -1 },
        taux_occupation: { valeur: 0, n1: 0.77, ecart: -0.77, variation: -1 } } })]
  })
  ecran.choisirVue('exploration')
  const html = ecran.rendre(d)
  assert.ok(!/-100\s*%/.test(html), 'un mois non commence ne « chute » pas de 100 %')
  assert.match(html, /À venir/, 'et son etat est DIT')
})

test('LE TEST QUI COMPTE : un mois EN COURS ne se compare pas a un mois complet', () => {
  // Le raisonnement est le meme mot pour mot qu'au-dessus — et en pilotage, le
  // tableau Realise ne contient plus que cette ligne : ce serait l'unique
  // chiffre de comparaison de la vue par defaut, et il serait trompeur.
  const d = reponse({
    realise: [periode('2026-09', { ca: 2005, nuitees: 14,
      vs_n1: { periode_n1: '2025-09', disponible: true,
        ca: { valeur: 2005, n1: 2527, ecart: -522, variation: -0.206 },
        taux_occupation: { valeur: 0.46, n1: 0.83, ecart: -0.37, variation: -0.44 } } })]
  })
  ecran.choisirVue('pilotage')
  const html = ecran.rendre(d)
  assert.ok(!/-21\s*%|-44\s*%/.test(html), 'pas de chute affichee sur un mois entame')
  assert.match(html, /En cours/)
})

test('LE TEST QUI COMPTE : en pilotage, le realise n affiche pas l avenir', () => {
  const d = reponse({
    realise: [periode('2026-09'), periode('2026-10'), periode('2026-11')]
  })
  ecran.choisirVue('pilotage')
  const html = ecran.rendre(d)
  assert.ok(!html.includes('octobre 2026'), 'un mois a venir n a rien a faire dans le realise')
  assert.ok(!html.includes('novembre 2026'))
  assert.match(html, /septembre 2026/, 'le mois en cours, lui, y reste')
})

test('aucune periode ecoulee : on le DIT, on n additionne pas zero', () => {
  const d = reponse({ realise: [periode('2026-10'), periode('2026-11')] })
  ecran.choisirVue('pilotage')
  const html = ecran.rendre(d)
  assert.ok(!/Périodes écoulées\s*:\s*<strong>0/.test(html),
    'un zero dur la ou la verite est « aucune periode ecoulee »')
  assert.match(html, /Aucune période écoulée/)
})

test('LE TEST QUI COMPTE : le motif PRECIS de capacite, pas le generique', () => {
  // Un hote Beds24 lisait « vous n'avez pas renseigne votre calendrier » la ou
  // la verite est « ce logement n'est pas relie au canal ».
  const d = reponse({
    realise: [periode('2025-06', { taux_occupation: null, revpar: null,
      jours_ouverts: null, non_calculable: ['capacite_non_calculable'],
      capacite_raison: 'provider_sans_memoire_intention' })]
  })
  ecran.choisirVue('bilan')
  const html = ecran.rendre(d)
  assert.match(html, /n’est pas relié au canal/, 'la vraie cause doit s afficher')
  assert.ok(!/jamais été enregistré/.test(html), 'et pas l explication generique')
})

test('LE TEST QUI COMPTE : un RevPAR sous-estime le dit, sans perdre sa valeur', () => {
  const d = reponse({
    realise: [periode('2025-06', { revpar: 102.72,
      non_calculable: ['revpar_sur_ca_partiel'], nuitees_sans_prix: 4 })]
  })
  ecran.choisirVue('bilan')
  const html = ecran.rendre(d)
  assert.match(html, /102[,.]72/, 'la valeur reste affichee')
  assert.match(html, /RevPAR sous-estimé/, 'et sa reserve aussi')
})

test('LE TEST QUI COMPTE : un N-1 disqualifie n affiche pas « 0 € »', () => {
  const d = reponse({
    a_date: [aDate('2026-10', {
      a_date_n1: { periode: '2025-10', ca: 0, nuitees: 0, non_calculable: [] },
      drapeaux: ['portefeuille_n1_reconstruit', 'aveugle_avant_bascule'],
      vs_n1: { periode_n1: '2025-10', disponible: true,
        ca: { valeur: 500, n1: 0, ecart: null, variation: null,
          non_calculable: 'aveugle_avant_bascule' } } })]
  })
  ecran.choisirVue('pilotage')
  const html = ecran.rendre(d)
  assert.match(html, /Historique non visible/, 'le drapeau remplace le zero')
  const bloc = html.slice(html.indexOf('À date'), html.indexOf('Référence'))
  assert.ok(!/<strong>0\s*€<\/strong>/.test(bloc), 'aucun « 0 € » en gras cote N-1')
})

test('LE TEST QUI COMPTE : les periodes fermees se disent EN TETE', () => {
  const d = reponse({
    a_date: ['2026-10', '2026-11', '2026-12'].map(c => aDate(c, {
      drapeaux: ['portefeuille_n1_reconstruit', 'periode_fermee_a_la_vente'] }))
  })
  ecran.choisirVue('pilotage')
  const html = ecran.rendre(d)
  assert.match(html, /3 période\(s\) fermée\(s\) à la vente/)
  // Et en tete : avant le bloc « À date ».
  assert.ok(html.indexOf('fermée(s) à la vente') < html.indexOf('<h2>À date</h2>'))
})

test('LE TEST QUI COMPTE : la projection montre une FOURCHETTE', () => {
  const d = reponse({
    projection: [{ periode: '2026-10', jours_projetes: 31, jours_sans_reference: 0,
      jours_replies: 0, prix_attendu_moyen: 130, part_attendue_a_ce_delai: 0.36,
      nuitees_finales_extrapolees: 14, nuitees_finales_min: 12,
      nuitees_finales_max: 20, intervalle_paliers: [0.25, 0.45],
      non_calculable: [] }]
  })
  ecran.choisirVue('pilotage')
  const html = ecran.rendre(d)
  assert.match(html, /de 12/, 'la borne basse')
  assert.match(html, /à 20/, 'et la borne haute')
})

test('aucun code technique brut n atteint l ecran, quelle que soit la vue', () => {
  // Le filet : on passe TOUS les motifs traduits dans les champs que l'ecran
  // relaie, et on verifie qu'aucun code `snake_case` ne ressort en clair.
  const codes = Object.keys(ecran.MOTIFS)
  const d = reponse({
    realise: [periode('2025-06', { non_calculable: codes })],
    a_date: [aDate('2026-10', { drapeaux: codes })],
    projection: [{ periode: '2026-10', jours_projetes: 31, jours_sans_reference: 0,
      jours_replies: 0, prix_attendu_moyen: null, non_calculable: codes }]
  })
  for (const v of ['pilotage', 'bilan', 'exploration']) {
    ecran.choisirVue(v)
    const html = ecran.rendre(d).replace(/title="[^"]*"/g, '')
    const bruts = [...html.matchAll(/>([a-z]+_[a-z_]+)</g)].map(m => m[1])
    assert.deepStrictEqual(bruts, [], `vue ${v} : des codes techniques sont visibles`)
    assert.ok(!html.includes('Motif non traduit'), `vue ${v} : un motif sans traduction`)
    assert.ok(!html.includes('undefined') && !html.includes('NaN'),
      `vue ${v} : une valeur non definie a fuite dans le HTML`)
  }
})
