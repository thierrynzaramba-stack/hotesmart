// tests/avis-evaluations.test.js
//
// L'orchestration : quelle grille s'applique, qui a le droit de repondre a
// quoi, et dans quel statut l'evaluation tombe ensuite. Aucune base : le
// client Supabase est un faux.
const test = require('node:test')
const assert = require('node:assert')

const {
  chargerGrille, criteresPour, deciderStatut,
  enregistrerReponses, abandonner, journaliser,
} = require('../lib/avis/evaluations')
const { GRILLE_DEFAUT } = require('../lib/avis/notes-evaluation')

// ─── Un faux Supabase, juste assez pour ce module ───────────────────────────
function faussebase ({ criteres = null, erreurLecture = null, majRendue = null, erreurMaj = null } = {}) {
  const vu = { maj: null, insere: null, filtres: [] }
  const api = {
    vu,
    from (table) {
      const chaine = {
        select: () => chaine,
        eq: (col, val) => { vu.filtres.push([col, val]); return chaine },
        or: () => chaine,
        update: (m) => { vu.maj = m; return chaine },
        insert: (l) => { vu.insere = l; return Promise.resolve({ error: erreurMaj }) },
        single: () => Promise.resolve({ data: majRendue || vu.maj, error: erreurMaj }),
        then: (r) => r({ data: criteres, error: erreurLecture }),
      }
      chaine.table = table
      return chaine
    },
  }
  return api
}

const PROP = 'prop-1'
const base = { id: 'ev-1', user_id: 'u-1', property_id: PROP, status: 'a_remplir' }

// Toutes les reponses au meilleur niveau, d'apres la grille par defaut.
const meilleur = (c) => c.categorie === 'recommandation'
  ? c.niveaux.find(n => n.recommande === true).cle
  : [...c.niveaux].sort((a, b) => b.note - a.note)[0].cle
const TOUT_BON = Object.fromEntries(GRILLE_DEFAUT.criteres.map(c => [c.cle, meilleur(c)]))
const critProprete = GRILLE_DEFAUT.criteres.find(c => c.categorie === 'cleanliness')
const NIV_SALE = critProprete.niveaux.find(n => n.negatif).cle

// ─── La transition de statut, la regle la plus lourde du chantier ───────────
test('un formulaire incomplet reste a remplir', () => {
  const d = deciderStatut({ role: 'prestataire', complet: false })
  assert.strictEqual(d.statut, 'a_remplir')
  assert.strictEqual(d.peutPublier, false)
})

test('la prestataire qui « soumet » passe la main a l’hote', () => {
  const d = deciderStatut({ role: 'prestataire', evalPower: 'soumettre', negatif: false, complet: true })
  assert.strictEqual(d.statut, 'soumise_prestataire')
  assert.strictEqual(d.peutPublier, false)
})

test('la prestataire qui « valide » publie, si rien n’est negatif', () => {
  const d = deciderStatut({ role: 'prestataire', evalPower: 'valider', negatif: false, complet: true })
  assert.strictEqual(d.peutPublier, true)
})

test('LE TEST QUI COMPTE : le pouvoir « valider » ne publie PAS un avis negatif', () => {
  const d = deciderStatut({ role: 'prestataire', evalPower: 'valider', negatif: true, complet: true })
  assert.strictEqual(d.statut, 'a_valider')
  assert.strictEqual(d.peutPublier, false)
  assert.match(d.motif, /negatif/)
})

test('l’hote qui remplit lui-meme peut publier', () => {
  const d = deciderStatut({ role: 'hote', negatif: true, complet: true })
  assert.strictEqual(d.peutPublier, true, 'l hote decide, meme sur un negatif')
})

// ─── Qui repond a quoi ──────────────────────────────────────────────────────
test('l’hote voit tous les criteres', () => {
  assert.strictEqual(criteresPour(GRILLE_DEFAUT, 'hote', 'aucun').length, GRILLE_DEFAUT.criteres.length)
})

test('eval_scope « aucun » ferme le formulaire de la prestataire', () => {
  assert.deepStrictEqual(criteresPour(GRILLE_DEFAUT, 'prestataire', 'aucun'), [])
})

test('« selon_grille » suit ce que la grille dit de chaque critere', () => {
  const vus = criteresPour(GRILLE_DEFAUT, 'prestataire', 'selon_grille')
  assert.ok(vus.length > 0)
  assert.ok(vus.every(c => c.rempli_par === 'prestataire' || c.rempli_par === 'les_deux'))
  assert.ok(!vus.some(c => c.rempli_par === 'hote'))
})

// ─── La grille chargee ──────────────────────────────────────────────────────
test('sans critere en base, c’est la grille par defaut du code', async () => {
  const g = await chargerGrille(faussebase({ criteres: [] }), { userId: 'u-1', propertyId: PROP })
  assert.strictEqual(g.defaut, true)
})

test('LE TEST QUI COMPTE : une base illisible ne se confond pas avec une grille vide', async () => {
  // Sans ce refus, une panne ferait evaluer l'hote avec NOS criteres en
  // croyant utiliser les siens.
  await assert.rejects(
    () => chargerGrille(faussebase({ erreurLecture: { message: 'timeout' } }), { userId: 'u-1', propertyId: PROP }),
    /grille illisible/)
})

test('les criteres du bien l’emportent sur ceux du compte', async () => {
  const sb = faussebase({ criteres: [
    { cle: 'du_compte', libelle: 'Compte', categorie: 'cleanliness', rempli_par: 'hote', rang: 1, property_id: null,
      avis_criteres_niveaux: [{ cle: 'a', libelle: 'A', rang: 1, note: 5, negatif: false }] },
    { cle: 'du_bien', libelle: 'Bien', categorie: 'cleanliness', rempli_par: 'hote', rang: 1, property_id: PROP,
      avis_criteres_niveaux: [{ cle: 'b', libelle: 'B', rang: 1, note: 5, negatif: false }] },
  ] })
  const g = await chargerGrille(sb, { userId: 'u-1', propertyId: PROP })
  assert.deepStrictEqual(g.criteres.map(c => c.cle), ['du_bien'])
})

// ─── L'enregistrement ───────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : la grille se fige au PREMIER remplissage', async () => {
  const sb = faussebase({ criteres: [] })
  const r = await enregistrerReponses(sb, {
    evaluation: base, reponses: TOUT_BON, role: 'hote',
  })
  assert.ok(sb.vu.maj.grille_figee, 'la copie figee doit etre ecrite')
  assert.strictEqual(sb.vu.maj.grille_figee.criteres.length, GRILLE_DEFAUT.criteres.length)
  assert.strictEqual(r.complet, true)
})

test('LE TEST QUI COMPTE : une grille deja figee n’est pas remplacee', async () => {
  const figee = { criteres: [{ cle: 'x', libelle: 'X', categorie: 'cleanliness', rempli_par: 'hote', rang: 1,
    niveaux: [{ cle: 'a', libelle: 'A', rang: 1, note: 5, negatif: false }] }] }
  const sb = faussebase({ criteres: [] })
  await enregistrerReponses(sb, {
    evaluation: { ...base, grille_figee: figee }, reponses: { x: 'a' }, role: 'hote',
  })
  assert.strictEqual(sb.vu.maj.grille_figee, undefined, 'la copie figee ne se reecrit pas')
})

test('un critere ferme au role est refuse, pas ignore', async () => {
  const sb = faussebase({ criteres: [] })
  const critHote = GRILLE_DEFAUT.criteres.find(c => c.rempli_par === 'hote')
  await assert.rejects(
    () => enregistrerReponses(sb, {
      evaluation: base, reponses: { [critHote.cle]: meilleur(critHote) },
      role: 'prestataire', evalScope: 'selon_grille',
    }),
    /n est pas ouvert a ce role/)
})

test('un avis negatif rempli par une prestataire « valider » passe a_valider', async () => {
  const sb = faussebase({ criteres: [] })
  const r = await enregistrerReponses(sb, {
    evaluation: base, reponses: { ...TOUT_BON, [critProprete.cle]: NIV_SALE },
    role: 'hote', evalPower: 'valider',
  })
  assert.strictEqual(r.negatif, true)
  assert.strictEqual(sb.vu.maj.status, 'a_valider')
})

test('une evaluation deja publiee ne se remplit plus', async () => {
  await assert.rejects(
    () => enregistrerReponses(faussebase({ criteres: [] }), {
      evaluation: { ...base, status: 'publiee' }, reponses: TOUT_BON, role: 'hote' }),
    /deja publiee/)
})

test('une evaluation expiree ne se remplit plus', async () => {
  await assert.rejects(
    () => enregistrerReponses(faussebase({ criteres: [] }), {
      evaluation: { ...base, status: 'expiree' }, reponses: TOUT_BON, role: 'hote' }),
    /delai de l OTA/)
})

test('l’ecriture porte TOUJOURS le user_id, pas seulement l’id', async () => {
  // Regle 11 : le compte cible se deduit de la donnee, et le filtre le prouve.
  const sb = faussebase({ criteres: [] })
  await enregistrerReponses(sb, { evaluation: base, reponses: TOUT_BON, role: 'hote' })
  assert.ok(sb.vu.filtres.some(([c, v]) => c === 'user_id' && v === 'u-1'))
})

// ─── L'abandon ──────────────────────────────────────────────────────────────
test('une evaluation publiee ne s’abandonne pas', async () => {
  await assert.rejects(
    () => abandonner(faussebase({}), { evaluation: { ...base, status: 'publiee' } }),
    /ne s abandonne pas/)
})

// ─── L'evenement ────────────────────────────────────────────────────────────
test('l’echec du journal est rendu, jamais avale', async () => {
  const sb = faussebase({ erreurMaj: { message: 'core_events pleine' } })
  const r = await journaliser(sb, { userId: 'u-1', type: 'avis.evaluation_publiee', sujet: 'ev-1' })
  assert.strictEqual(r.ok, false)
  assert.match(r.erreur, /core_events/)
})

test('l’evenement porte le vocabulaire du bus : domaine.evenement', async () => {
  const sb = faussebase({})
  await journaliser(sb, { userId: 'u-1', type: 'avis.evaluation_publiee', sujet: 'ev-1' })
  assert.match(sb.vu.insere.type, /^[a-z_]+\.[a-z_]+$/)
})
