// tests/garde-colonne-selectionnee.test.js
//
// ⚠ LA CLASSE DE DEFAUTS, ET POURQUOI UN TEST GENERIQUE A ETE DEMANDE.
//
// « Une garde qui juge sur une colonne non selectionnee est une garde ouverte. »
// La colonne absente du `.select(...)` vaut `undefined`, et `undefined` passe
// toutes les comparaisons qu'une garde ecrit naturellement : `!= null` est faux,
// `<` et `>` sont faux, donc le refus ne se declenche jamais — pour personne, et
// sans une ligne d'erreur nulle part.
//
// TROIS FOIS DANS LE SEUL api/channel-property.js : `base_price` et le cran
// d'arret, `migration_target_property_id`, puis `prix_minimum` le 22 octobre
// 2026. La troisieme a TRAVERSE LA RECETTE : plancher 50 € en base, prix de
// base passe a 20 € depuis la fiche, « Enregistre », valeur persistee, aucun
// refus — alors que la lecon etait ecrite en commentaire DEUX LIGNES AU-DESSUS
// du defaut. Une regle qu'on relit a l'œil se perd ; celle-ci se mesure.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE QUE CE TEST VAUT, MESURE ET NON SUPPOSE (22 octobre 2026)
// ─────────────────────────────────────────────────────────────────────────────
//   • sur l'arbre de `main` (5f370b6), api+lib+scripts+shared : 361 lectures
//     d'une ligne, dont 285 ANALYSEES sur 126 fichiers, ZERO constat ;
//   • CONTRE-EPREUVE sur l'arbre `e016d24`, celui d'AVANT le correctif du
//     plancher : 1 constat, `api/channel-property.js  prop.prix_minimum` —
//     exactement le defaut que la recette avait trouve ;
//   • CAMPAGNE COMPLETE sur les DOUZE colonnes du select du PATCH de
//     api/channel-property.js : DIX rougissent. Les deux survivantes, `id` et
//     `pilote_tarifaire`, survivent A BON DROIT — verifie, ni `prop.id` ni
//     `prop.pilote_tarifaire` n'est lu dans ce bloc, donc leur retrait n'ouvre
//     aucune garde.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ LA PLAGE : CE TEST NE COUVRE PAS « LE DEPOT » (REVIEW.md regle 18)
// ─────────────────────────────────────────────────────────────────────────────
// Il couvre les lectures d'UNE LIGNE (`.single()` / `.maybeSingle()`). Les
// lectures de COLLECTION — 705 selects dans les quatre dossiers — sont hors de
// portee : il faudrait suivre l'alias du callback, donc une analyse de portee.
// C'est la plus grande surface non couverte, et le test la CHIFFRE pour que
// « 285 lectures analysees » ne se lise pas comme « le depot est couvert ».
//
// ⚠ ET L'INVARIANT DE TOTALITE EST LE VRAI GARDE-FOU. Les plafonds d'angles
// morts, seuls, laissaient passer la disparition d'une lecture — or les trois
// defauts vecus faisaient UNE lecture chacun. Ce test exige donc l'EGALITE
// `analysees + angles morts === lectures d'une ligne trouvees` : une lecture
// qui sort du balayage devient un rouge, et non une disparition silencieuse.
// Mesure qui a produit cette exigence : une liste de colonnes CONCATENEE
// (api/channel-bcom-write.js, dont la ligne suivante porte
// `if (!prop.provider_rate_plan_id)`) n'etait ni analysee ni comptee — retirer
// la colonne laissait 282 analysees, 0 constat, angles morts inchanges.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { analyser, sansCommentaires, clesDuSelect, fonctionsDuFichier, resoudreListe } =
  require('./outils/colonnes-selectionnees')

const RACINE = path.join(__dirname, '..')
const DOSSIERS = ['api', 'lib', 'scripts', 'shared']

// Les fichiers qui DOIVENT etre dans le balayage. Sans cette liste, un fichier
// peut en sortir en silence — mesure du 22 octobre 2026 : une chaine contenant
// ` /* ` faisait disparaitre api/channel-property.js ENTIER, et le test restait
// vert. C'est le fichier pour lequel ce lot existe.
const SENTINELLES = [
  'api/channel-property.js',
  'api/channel-bcom-write.js',
  'api/logement.js',
  'lib/logement/lecture.js'
]

test('LE TEST QUI COMPTE : aucune garde ne lit une colonne absente de son SELECT', () => {
  const { constats } = analyser({ racine: RACINE, dossiers: DOSSIERS })
  const lignes = constats.map(c =>
    `${c.fichier} : lit \`${c.variable}.${c.colonne}\` sans le selectionner ` +
    `(select : ${c.selectionnees.join(', ')})`)
  assert.deepEqual(lignes, [],
    'une colonne lue mais non selectionnee vaut `undefined` : la garde qui s en sert ne mord pas\n  - ' +
    lignes.join('\n  - '))
})

test('LE TEST QUI COMPTE : aucune lecture ne DISPARAIT du balayage', () => {
  // ⚠ L'INVARIANT DE TOTALITE. Chaque lecture d'une ligne est soit ANALYSEE,
  // soit comptee dans un angle mort nomme. L'egalite interdit la troisieme
  // possibilite — sortir du balayage sans laisser de trace —, qui est celle
  // par laquelle une liste de colonnes concatenee echappait a tout.
  const { examines, ancres, ignorees } = analyser({ racine: RACINE, dossiers: DOSSIERS })
  const angles = ignorees.forme_non_resolue + ignorees.etoile_ou_imbrique +
    ignorees.sans_select + ignorees.sans_variable
  assert.equal(examines + angles, ancres,
    `${ancres} lectures d une ligne trouvees, mais ${examines} analysees + ${angles} angles morts ` +
    `= ${examines + angles} : ${ancres - examines - angles} ont disparu sans etre comptees`)
})

test('le balayage LIT VRAIMENT le depot, dossier par dossier', () => {
  // ⚠ UN PLANCHER PAR DOSSIER, PAS UN GLOBAL. Un total unique etait gonfle par
  // `scripts/` (70 lectures jetables) : jusqu'a 70 lectures de PRODUCTION
  // pouvaient sortir du balayage sans faire rougir le total.
  // Mesure du 22 octobre 2026 : api 138, lib 76, scripts 70, shared 1.
  const api = analyser({ racine: RACINE, dossiers: ['api'] })
  const lib = analyser({ racine: RACINE, dossiers: ['lib'] })
  assert.ok(api.examines >= 130, `api : ${api.examines} lectures analysees (138 le 22 octobre 2026)`)
  assert.ok(lib.examines >= 70, `lib : ${lib.examines} lectures analysees (76 le 22 octobre 2026)`)
  assert.ok(api.fichiers.length >= 34, `api : ${api.fichiers.length} fichiers (36 le 22 octobre 2026)`)
})

test('les fichiers sentinelles sont DANS le balayage', () => {
  const { fichiers } = analyser({ racine: RACINE, dossiers: DOSSIERS })
  const absents = SENTINELLES.filter(f => !fichiers.includes(f))
  assert.deepEqual(absents, [],
    'ces fichiers doivent etre analyses ; leur absence est le faux vert du 22 octobre 2026')
})

test('les angles morts sont COMPTES, et leur taille est dite', () => {
  // ⚠ UNE EXEMPTION SE COMPTE. Mesure du 22 octobre 2026, sur les quatre
  // dossiers : forme_non_resolue 35, etoile_ou_imbrique 33, sans_variable 8,
  // sans_select 0 — et 705 lectures de COLLECTION, la grande surface non
  // couverte. Les plafonds n'attrapent qu'un effondrement ; c'est l'invariant
  // de totalite, plus haut, qui attrape la perte d'UNE lecture.
  const { ignorees } = analyser({ racine: RACINE, dossiers: DOSSIERS })
  assert.ok(ignorees.forme_non_resolue <= 45,
    `${ignorees.forme_non_resolue} listes de colonnes non resolues (35 le 22 octobre 2026)`)
  assert.ok(ignorees.etoile_ou_imbrique <= 45,
    `${ignorees.etoile_ou_imbrique} selects en \`*\` ou imbriques (33 le 22 octobre 2026)`)
  assert.ok(ignorees.sans_variable <= 15,
    `${ignorees.sans_variable} lectures dont la variable n est pas identifiee (8 le 22 octobre 2026)`)
  assert.ok(ignorees.collection > 400,
    'les lectures de collection doivent etre chiffrees : si ce compte s effondre, ' +
    'ce n est pas la surface qui a disparu, c est le comptage')
})

// ═══════════════════════════════════════════════════════════════════════════
// L'OUTIL LUI-MEME — eprouve sur des defauts PLANTES
// ═══════════════════════════════════════════════════════════════════════════

function surArbreJetable (fichiers, verifier) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'colonnes-'))
  try {
    fs.mkdirSync(path.join(d, 'api'))
    for (const [nom, contenu] of Object.entries(fichiers)) {
      fs.writeFileSync(path.join(d, 'api', nom), contenu)
    }
    verifier(analyser({ racine: d, dossiers: ['api'] }))
  } finally {
    // ⚠ `finally` : une assertion qui leve laissait le repertoire derriere elle.
    fs.rmSync(d, { recursive: true, force: true })
  }
}

const LECTURE = (select, suite) => `
  module.exports = async function (req, res) {
    const { data: prop, error } = await supabase
      .from('properties')
      .select(${select})
      .eq('id', id)
      .single()
    if (error) return res.status(503).json({})
    ${suite}
  }
`

const GARDE = 'if (Number(prix) < Number(prop.prix_minimum)) return res.status(400).json({})'

test('LE TEST QUI COMPTE : l outil VOIT un defaut plante', () => {
  surArbreJetable({ 'faux.js': LECTURE("'id, base_price'", GARDE) }, a => {
    assert.equal(a.examines, 1, 'la lecture doit etre analysee')
    assert.deepEqual(a.constats.map(c => c.colonne), ['prix_minimum'])
  })
})

test('et il ne crie pas quand la colonne EST selectionnee', () => {
  surArbreJetable({ 'sain.js': LECTURE("'id, base_price, prix_minimum'", GARDE) }, a => {
    assert.equal(a.examines, 1)
    assert.deepEqual(a.constats, [])
  })
})

test('une liste CONCATENEE est resolue, pas ignoree', () => {
  // ⚠ LE PREMIER FAUX VERT DU 22 OCTOBRE. api/channel-bcom-write.js coupe sa
  // liste en deux chaines ; le motif d'alors exigeait la parenthese collee,
  // donc la lecture n'etait NI analysee NI comptee. Retirer une colonne lue par
  // `if (!prop.provider_rate_plan_id)` ne faisait rien bouger.
  surArbreJetable({ 'concat.js': LECTURE("'id, name, ' + 'base_price'", GARDE) }, a => {
    assert.equal(a.examines, 1, 'une liste concatenee EST une liste')
    assert.deepEqual(a.constats.map(c => c.colonne), ['prix_minimum'])
  })
  surArbreJetable({ 'concat2.js': LECTURE("'id, name, ' + 'prix_minimum'", GARDE) }, a => {
    assert.deepEqual(a.constats, [], 'et l union des morceaux est la liste complete')
  })
})

test('un TERNAIRE ne garantit que l INTERSECTION de ses branches', () => {
  // api/reservation-directe.js : `.select(avecRaw ? 'snapshot, raw' : 'snapshot')`.
  // Une colonne absente d UNE branche suffit a ouvrir la garde.
  surArbreJetable({ 'tern.js': LECTURE("x ? 'id, prix_minimum' : 'id'", GARDE) }, a => {
    assert.deepEqual(a.constats.map(c => c.colonne), ['prix_minimum'],
      'la branche courte ne porte pas la colonne : la garde peut etre ouverte')
  })
  surArbreJetable({ 'tern2.js': LECTURE("x ? 'id, prix_minimum' : 'prix_minimum'", GARDE) }, a => {
    assert.deepEqual(a.constats, [], 'presente dans les DEUX branches : garantie')
  })
})

test('il suit la ligne passee a une fonction auxiliaire', () => {
  // ⚠ LA FORME DE L'OCCURRENCE `migration_target_property_id` : la garde lit
  // depuis le PARAMETRE de `canauxActifsDuBien(prop)`.
  surArbreJetable({
    'aux.js': 'function cleDuBien (p) {\n' +
      '  return p.provider_property_id || p.migration_target_property_id\n}\n' +
      LECTURE("'id, provider_property_id'", 'const cle = cleDuBien(prop)\n    if (!cle) return res.status(409).json({})')
  }, a => {
    assert.deepEqual(a.constats.map(c => c.colonne), ['migration_target_property_id'])
  })
})

test('il suit aussi une fleche sans parentheses, et un argument derriere un appel imbrique', () => {
  // 31 fleches sans parentheses dans api+lib+shared : les manquer rendait le
  // suivi aveugle. Et `garde(ctx(req), prop)` demande des parentheses appariees
  // pour trouver le rang de `prop`.
  surArbreJetable({
    'fleche.js': 'const g = p => { if (!p.prix_minimum) return false\n  return true }\n' +
      LECTURE("'id, base_price'", 'if (!g(prop)) return res.status(400).json({})')
  }, a => assert.deepEqual(a.constats.map(c => c.colonne), ['prix_minimum']))

  surArbreJetable({
    'imbrique.js': 'function garde (ctx, p) { if (!p.prix_minimum) throw new Error("x") }\n' +
      'function ctx (r) { return r }\n' +
      LECTURE("'id, base_price'", 'garde(ctx(req), prop)')
  }, a => assert.deepEqual(a.constats.map(c => c.colonne), ['prix_minimum']))
})

test('une DESTRUCTURATION et un ALIAS sont des lectures', () => {
  surArbreJetable({
    'destr.js': LECTURE("'id, base_price'",
      'const { prix_minimum } = prop\n    if (Number(p) < Number(prix_minimum)) return res.status(400).json({})')
  }, a => assert.deepEqual(a.constats.map(c => c.colonne), ['prix_minimum']))

  surArbreJetable({
    'alias.js': LECTURE("'id, base_price'",
      'const bien = prop\n    if (Number(p) < Number(bien.prix_minimum)) return res.status(400).json({})')
  }, a => assert.deepEqual(a.constats.map(c => c.colonne), ['prix_minimum']))
})

test('un REPLI qui selectionne moins n est pas un defaut', () => {
  // api/sms.js : quatre colonnes, et si la migration du 17 septembre 2026 n'est
  // pas passee, deux seulement — lectures en `?.` avec `|| null`, vide etant un
  // defaut propre. Quatre faux constats avant l'union de proximite.
  surArbreJetable({
    'repli.js': `
      module.exports = async function (req, res) {
        let { data, error: e } = await supabase
          .from('api_keys')
          .select('brevo_api_key, brevo_enabled, brevo_sender_email')
          .eq('user_id', u)
          .maybeSingle()
        if (e) {
          ({ data } = await supabase
            .from('api_keys')
            .select('brevo_api_key, brevo_enabled')
            .eq('user_id', u)
            .maybeSingle())
        }
        return res.status(200).json({ expediteur: data?.brevo_sender_email || null })
      }
    `
  }, a => assert.deepEqual(a.constats, [],
    'le repli est colle a sa lecture principale, les colonnes sont connues'))
})

test('deux lectures ELOIGNEES de la meme variable ne se pretent pas leurs colonnes', () => {
  // Le defaut de l'union par fichier : le select du PATCH voyait les colonnes
  // du select du DELETE, et deux mutations survivaient.
  surArbreJetable({
    'loin.js': `
      module.exports = async function (req, res) {
        if (req.method === 'PATCH') {
          const { data: prop } = await supabase
            .from('properties').select('id, base_price').eq('id', i).single()
          if (Number(p) < Number(prop.prix_minimum)) return res.status(400).json({})
          ${'const remplissage_pour_eloigner_les_deux_lectures = 1\n          '.repeat(14)}
          return res.status(200).json({})
        }
        if (req.method === 'DELETE') {
          const { data: prop } = await supabase
            .from('properties').select('id, prix_minimum').eq('id', i).single()
          return res.status(200).json({ plancher: prop.prix_minimum })
        }
      }
    `
  }, a => assert.deepEqual(a.constats.map(c => c.colonne), ['prix_minimum']))
})

test('une lecture SANS jugement n est pas un constat', () => {
  // ⚠ RESSERRE SUR CE QUI EST REELLEMENT INTERDIT (REVIEW.md regle 20,
  // condition 1) : la classe est « une GARDE qui juge ». Un utilitaire de
  // normalisation qui lit une colonne en repli rendait un constat sur du code
  // JUSTE — et un garde-fou qui rougit sur du code correct pousse a deformer ce
  // code pour le faire taire.
  surArbreJetable({
    'norm.js': 'function normaliser (p) {\n  const o = {}\n  o.photo = p.photo_url\n' +
      '  o.liens = p.ota_listing_urls\n  return o\n}\n' +
      LECTURE("'id, photo_url'", 'return res.status(200).json(normaliser(prop))')
  }, a => assert.deepEqual(a.constats, [],
    'les lectures d un utilitaire qui ne juge pas ne sont pas des gardes'))
})

// ═══════════════════════════════════════════════════════════════════════════
// LES PIEGES D'ANALYSE, CHACUN PAYE UNE FOIS
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : une chaine ne fait pas disparaitre son fichier', () => {
  // ⚠ LE SECOND FAUX VERT DU 22 OCTOBRE, ET LE PLUS GRAVE. `const _e = 'voir /*
  // la doc'` injecte dans api/channel-property.js faisait sortir LE FICHIER
  // ENTIER du balayage : 125 fichiers devenaient 124, zero constat, test
  // entierement vert — et c'est le fichier pour lequel ce lot existe. Meme
  // famille que `accept="image/*"`, qui avalait 470 lignes de l'outil
  // `imports-modules` le 21 octobre : la garde « un `/*` doit commencer un
  // jeton » ne protege que le `/*` COLLE a un guillemet, pas celui precede d'un
  // espace DANS la chaine.
  for (const poison of ["'voir /* la doc'", "'a//b'", '"x /* y"', '`z // t`']) {
    surArbreJetable({
      'poison.js': `const _etiquette = ${poison}\n` + LECTURE("'id, base_price'", GARDE)
    }, a => {
      assert.equal(a.examines, 1, `la chaine ${poison} ne doit pas avaler le fichier`)
      assert.deepEqual(a.constats.map(c => c.colonne), ['prix_minimum'])
    })
  }
})

test('un vrai commentaire, lui, disparait', () => {
  assert.doesNotMatch(sansCommentaires('/* prop.prix_minimum */\nconst a = 1'), /prix_minimum/)
  assert.doesNotMatch(sansCommentaires('// prop.prix_minimum\nconst a = 1'), /prix_minimum/)
  assert.match(sansCommentaires('const u = \'https://x.y\'\nconst b = 2'), /const b = 2/,
    'le `//` d une URL n est pas un commentaire')
  assert.match(sansCommentaires('const t = \'image/*\'\nconst b = 2'), /const b = 2/)
})

test('`alias:source` — la cle lue est l ALIAS', () => {
  // `cache:raw->attributes->is_hidden` : l'ecran lit `.cache`. Prendre l'apres
  // du deux-points faisait passer api/avis.js pour trois oublis.
  const cles = clesDuSelect('external_review_id, cache:raw->attributes->is_hidden, note:raw->attributes->overall_score')
  assert.ok(cles.has('cache') && cles.has('note') && cles.has('external_review_id'))
  assert.ok(!cles.has('raw->attributes->is_hidden'))
})

test('resoudreListe dit NON plutot que de deviner', () => {
  const vide = new Map()
  assert.deepEqual([...resoudreListe("'id, name'", vide).cols], ['id', 'name'])
  assert.equal(resoudreListe("'*'", vide).etoile, true)
  assert.equal(resoudreListe("'id, canaux(ota)'", vide), null, 'un select imbrique ne promet pas de liste')
  assert.equal(resoudreListe('construireListe(x)', vide), null, 'une liste calculee est NON RESOLUE, pas vide')
  assert.deepEqual([...resoudreListe("COLS + ', extra'", new Map([['COLS', 'id, name']])).cols],
    ['id', 'name', 'extra'])
})

test('les fonctions du fichier sont repertoriees avec leurs parametres', () => {
  const f = fonctionsDuFichier('async function garde (prop, options) {\n  return prop.id\n}\n')
  assert.ok(f.has('garde'))
  assert.deepEqual(f.get('garde').params, ['prop', 'options'])
  assert.match(f.get('garde').corps, /return prop\.id/)
  const g = fonctionsDuFichier('const vite = p => {\n  return p.id\n}\n')
  assert.deepEqual(g.get('vite').params, ['p'], 'une fleche sans parentheses compte aussi')
})
