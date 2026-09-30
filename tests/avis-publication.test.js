// tests/avis-publication.test.js
// LA PUBLICATION D'UNE EVALUATION : UNE FOIS, ET JAMAIS REJOUEE.
// Spec docs/specs/spec-evaluation-voyageur.md §3 (garde-fous) et §6 (statuts).
//
// LE DEFAUT QU'IL EMPECHE : un avis public envoye deux fois a un voyageur, ou
// un avis negatif publie sans que l'hote l'ait valide. Chez Airbnb, un avis
// publie ne se reprend pas — il n'y a pas de second essai possible.
//
// Regle du depot, deja payee ailleurs (docs/kb/moteur-reservation.md) : « on ne
// rejoue pas ce dont on ignore s'il a abouti ». Un POST coupe en cours a
// peut-etre ete accepte : on verifie chez le provider AVANT toute nouvelle
// tentative, on ne repart jamais a l'aveugle.
const test = require('node:test')
const assert = require('node:assert')
const { publier, RefusPublication } = require('../lib/avis/publication')

const REPONSES = {
  etat: 'impeccable', degats: 'aucun', poubelles: 'fait',
  communication: 'excellente', regles: 'oui', recommande: 'oui',
}
const NEGATIF = { ...REPONSES, recommande: 'non' }

// Une evaluation prete a partir, dans l'etat attendu par `publier`.
const evaluation = (a = {}) => ({
  id: 'ev-1', user_id: 'u1', property_id_ref: 'p1', booking_uid: 'b1',
  ota_review_id: 'rev-1', ota_review_ref: 'channex-abc-123', status: 'a_valider',
  answers_host: REPONSES, public_text: 'Merci pour votre sejour.',
  private_note: null, deadline_at: new Date(Date.now() + 86400000).toISOString(),
  ...a,
})

// Un faux provider : enregistre les appels, rend ce qu'on lui dit.
function provider ({ post = { ok: true, status: 200, json: { success: true } }, etat = null } = {}) {
  const appels = []
  return {
    appels,
    async publierAvisVoyageur (reviewId, charge) { appels.push({ type: 'post', reviewId, charge }); if (post instanceof Error) throw post; return post },
    async lireAvis (reviewId) { appels.push({ type: 'get', reviewId }); return etat },
  }
}

// ─── Le garde-fou du negatif (spec §3) ──────────────────────────────────────
test('LE TEST QUI COMPTE : un avis negatif ne part pas sur le pouvoir de la prestataire', async () => {
  const p = provider()
  await assert.rejects(
    () => publier({ evaluation: evaluation({ answers_host: NEGATIF, status: 'a_valider' }), parProfil: { eval_power: 'valider' }, provider: p }),
    (e) => e instanceof RefusPublication && e.motif === 'negatif_a_valider')
  assert.deepStrictEqual(p.appels, [], 'aucun appel provider')
})

test('un avis negatif part quand c’est l’HOTE qui valide', async () => {
  const p = provider()
  const r = await publier({ evaluation: evaluation({ answers_host: NEGATIF }), parProfil: null, provider: p })
  assert.strictEqual(r.statut, 'publiee')
  assert.strictEqual(p.appels.filter(a => a.type === 'post').length, 1)
})

test('un avis NON negatif part sur le pouvoir de la prestataire', async () => {
  const p = provider()
  const r = await publier({ evaluation: evaluation(), parProfil: { eval_power: 'valider' }, provider: p })
  assert.strictEqual(r.statut, 'publiee')
})

test('la prestataire sans pouvoir ne publie pas, meme un avis flatteur', async () => {
  const p = provider()
  await assert.rejects(
    () => publier({ evaluation: evaluation(), parProfil: { eval_power: 'soumettre' }, provider: p }),
    (e) => e.motif === 'pouvoir_insuffisant')
  assert.deepStrictEqual(p.appels, [])
})

// ─── Une seule publication, jamais deux ─────────────────────────────────────
test('LE TEST QUI COMPTE : une evaluation deja publiee ne repart pas', async () => {
  const p = provider()
  await assert.rejects(
    () => publier({ evaluation: evaluation({ status: 'publiee', published_at: new Date().toISOString() }), provider: p }),
    (e) => e.motif === 'deja_publiee')
  assert.deepStrictEqual(p.appels, [])
})

test('LE TEST QUI COMPTE : apres un echec, on VERIFIE chez le provider avant de repartir', async () => {
  // Regle du depot : on ne rejoue pas ce dont on ignore s'il a abouti. Le POST
  // precedent a peut-etre ete accepte avant la coupure.
  const dejaLa = provider({ etat: { is_replied: true } })
  await assert.rejects(
    () => publier({ evaluation: evaluation({ status: 'echec_publication' }), provider: dejaLa }),
    (e) => e.motif === 'deja_chez_le_provider')
  assert.deepStrictEqual(dejaLa.appels.map(a => a.type), ['get'], 'on LIT, on ne poste pas')

  // Si le provider dit que rien n'est parti, la seconde tentative est legitime.
  const rien = provider({ etat: { is_replied: false } })
  const r = await publier({ evaluation: evaluation({ status: 'echec_publication' }), provider: rien })
  assert.strictEqual(r.statut, 'publiee')
  assert.deepStrictEqual(rien.appels.map(a => a.type), ['get', 'post'])
})

test('provider muet apres un echec : on NE REPART PAS', async () => {
  // Ne pas savoir n'est pas savoir que non.
  const muet = provider({ etat: null })
  await assert.rejects(
    () => publier({ evaluation: evaluation({ status: 'echec_publication' }), provider: muet }),
    (e) => e.motif === 'etat_provider_inconnu')
  assert.deepStrictEqual(muet.appels.map(a => a.type), ['get'])
})

// ─── Le delai de l'OTA ──────────────────────────────────────────────────────
test('delai depasse : rien ne part, et le statut le dit', async () => {
  const p = provider()
  await assert.rejects(
    () => publier({ evaluation: evaluation({ deadline_at: new Date(Date.now() - 1000).toISOString() }), provider: p }),
    (e) => e.motif === 'expiree')
  assert.deepStrictEqual(p.appels, [])
})

test('sans objet review chez l’OTA, aucun POST possible', async () => {
  const p = provider()
  await assert.rejects(
    () => publier({ evaluation: evaluation({ ota_review_id: null }), provider: p }),
    (e) => e.motif === 'sans_objet_ota')
  assert.deepStrictEqual(p.appels, [])
})

// ─── Ce qui part, et ce qui ne part pas ─────────────────────────────────────
test('LE TEST QUI COMPTE : la note privee ne part JAMAIS dans le texte public', async () => {
  const p = provider()
  await publier({ evaluation: evaluation({ private_note: 'A ne pas remettre.', public_text: 'Sejour agreable.' }), provider: p })
  const charge = p.appels.find(a => a.type === 'post').charge.review
  assert.strictEqual(charge.public_review, 'Sejour agreable.')
  assert.strictEqual(charge.private_review, 'A ne pas remettre.')
  assert.ok(!charge.public_review.includes('A ne pas remettre'))
})

test('la charge porte les notes DERIVEES des boutons, pas celles qu’on lui passe', async () => {
  const p = provider()
  // Une evaluation dont on tenterait de forcer les scores : ils sont ignores.
  await publier({ evaluation: evaluation({ scores: [{ category: 'cleanliness', rating: 1 }] }), provider: p })
  const r = p.appels.find(a => a.type === 'post').charge.review
  assert.deepStrictEqual(r.scores, [
    { category: 'cleanliness', rating: 5 },
    { category: 'communication', rating: 5 },
    { category: 'respect_house_rules', rating: 5 },
  ])
  assert.strictEqual(r.is_reviewee_recommended, true)
  assert.ok(Array.isArray(r.tags))
})

test('un texte public vide ne part pas : on ne publie pas un avis muet', async () => {
  const p = provider()
  await assert.rejects(
    () => publier({ evaluation: evaluation({ public_text: '   ' }), provider: p }),
    (e) => e.motif === 'texte_absent')
  assert.deepStrictEqual(p.appels, [])
})

// ─── Quand le provider refuse ───────────────────────────────────────────────
test('refus du provider : statut echec_publication, et AUCUN rejeu automatique', async () => {
  const p = provider({ post: { ok: false, status: 422, json: { errors: { code: 'not_supported' } } } })
  const r = await publier({ evaluation: evaluation(), provider: p })
  assert.strictEqual(r.statut, 'echec_publication')
  assert.strictEqual(r.rejouer, false, 'rien ne se rejoue tout seul')
  assert.match(r.motif, /422|not_supported/)
  assert.strictEqual(p.appels.filter(a => a.type === 'post').length, 1, 'un seul POST, jamais deux')
})

test('coupure en cours de POST : issue INCERTAINE, statut echec, pas de second essai', async () => {
  const p = provider({ post: new Error('socket hang up') })
  const r = await publier({ evaluation: evaluation(), provider: p })
  assert.strictEqual(r.statut, 'echec_publication')
  assert.strictEqual(r.incertain, true, 'l’appel est parti : on ignore s’il a abouti')
  assert.strictEqual(p.appels.filter(a => a.type === 'post').length, 1)
})

// ─── La grille figee (amendement du 30 septembre 2026) ──────────────────────
const GRILLE_HOTE = {
  criteres: [{
    cle: 'couvre_feu', libelle: 'Respect du couvre-feu',
    categorie: 'respect_house_rules', rempli_par: 'hote', rang: 1,
    niveaux: [
      { cle: 'oui', libelle: 'Oui', rang: 1, note: 5, negatif: false },
      { cle: 'non', libelle: 'Non', rang: 2, note: 1, negatif: true },
    ],
  }],
}

test('LE TEST QUI COMPTE : on publie sur la grille FIGEE, pas sur celle du code', async () => {
  const p = provider()
  await publier({ evaluation: evaluation({ grille_figee: GRILLE_HOTE, answers_host: { couvre_feu: 'oui' } }), provider: p })
  const r = p.appels.find(a => a.type === 'post').charge.review
  assert.deepStrictEqual(r.scores, [{ category: 'respect_house_rules', rating: 5 }])
  // Aucun critere de recommandation dans cette grille : le champ est ABSENT,
  // pas `undefined` — l'OTA lirait un champ vide comme un refus.
  assert.ok(!('is_reviewee_recommended' in r))
  assert.deepStrictEqual(r.tags, [], 'un critere invente par l’hote ne porte aucun tag')
})

test('LE TEST QUI COMPTE : des reponses qui ne collent pas a la grille sont un REFUS, pas un 500', async () => {
  const p = provider()
  await assert.rejects(
    () => publier({ evaluation: evaluation({ grille_figee: GRILLE_HOTE, answers_host: { etat: 'impeccable' } }), provider: p }),
    (e) => e instanceof RefusPublication && e.motif === 'reponses_hors_grille')
  assert.deepStrictEqual(p.appels, [], 'rien ne part')
})

test('le garde-fou du negatif suit la grille figee, pas la liste d’origine', async () => {
  const p = provider()
  await assert.rejects(
    () => publier({
      evaluation: evaluation({ grille_figee: GRILLE_HOTE, answers_host: { couvre_feu: 'non' } }),
      parProfil: { eval_power: 'valider' }, provider: p }),
    (e) => e.motif === 'negatif_a_valider')
  assert.deepStrictEqual(p.appels, [])
})

test('sans grille figee, la grille par defaut s’applique — les evaluations d’avant restent publiables', async () => {
  const p = provider()
  const r = await publier({ evaluation: evaluation({ grille_figee: null }), provider: p })
  assert.strictEqual(r.statut, 'publiee')
  assert.strictEqual(p.appels.find(a => a.type === 'post').charge.review.scores.length, 3)
})

// ─── Les deux colonnes de reponses ──────────────────────────────────────────
test('LE TEST QUI COMPTE : les reponses des DEUX roles sont publiees ensemble', async () => {
  // Le circuit nominal : la prestataire coche sa part, l'hote la sienne, et
  // chaque role va dans SA colonne. Un « ou » entre les deux ne gardait que
  // celle de l'hote et refusait une evaluation pourtant complete, en accusant
  // la grille figee. Constat de review.
  const p = provider()
  const r = await publier({ evaluation: evaluation({
    answers_cleaner: { etat: 'impeccable', degats: 'aucun', poubelles: 'fait' },
    answers_host: { communication: 'excellente', regles: 'oui', recommande: 'oui' },
  }), provider: p })
  assert.strictEqual(r.statut, 'publiee')
  const envoye = p.appels.find(a => a.type === 'post').charge.review
  assert.ok(envoye.scores.some(s => s.category === 'cleanliness'), 'la part de la prestataire doit partir')
  assert.ok(envoye.scores.some(s => s.category === 'communication'), 'la part de l hote aussi')
})

test('l’hote l’emporte sur la prestataire quand les deux ont repondu a la meme question', async () => {
  const p = provider()
  await publier({ evaluation: evaluation({
    answers_cleaner: { ...REPONSES, etat: 'sale' },
    answers_host: { etat: 'impeccable' },
  }), provider: p })
  const scores = p.appels.find(a => a.type === 'post').charge.review.scores
  assert.strictEqual(scores.find(s => s.category === 'cleanliness').rating, 5)
})

test('deux colonnes vides restent un refus « sans reponses »', async () => {
  await assert.rejects(
    () => publier({ evaluation: evaluation({ answers_host: null, answers_cleaner: null }), provider: provider() }),
    (e) => e instanceof RefusPublication && e.motif === 'sans_reponses')
})

// ─── Une grille figee presente mais inexploitable ───────────────────────────
test('LE TEST QUI COMPTE : une grille figee vide est un REFUS, pas un repli sur le defaut', async () => {
  // Le piege : un hote qui part de la grille par defaut et n'en change que les
  // notes garde les MEMES CLES. Rien ne leverait, et ses notes seraient
  // silencieusement remplacees par les notres.
  const p = provider()
  await assert.rejects(
    () => publier({ evaluation: evaluation({ grille_figee: { criteres: [] } }), provider: p }),
    (e) => e instanceof RefusPublication && e.motif === 'grille_figee_illisible')
  assert.strictEqual(p.appels.length, 0, 'rien ne part chez l OTA')
})

test('une grille figee rendue comme une chaine est refusee de la meme facon', async () => {
  await assert.rejects(
    () => publier({ evaluation: evaluation({ grille_figee: '{"criteres":[]}' }), provider: provider() }),
    (e) => e instanceof RefusPublication && e.motif === 'grille_figee_illisible')
})

test('une grille figee ABSENTE reste le cas normal : la grille par defaut s’applique', async () => {
  const r = await publier({ evaluation: evaluation({ grille_figee: null }), provider: provider() })
  assert.strictEqual(r.statut, 'publiee')
})

// ⚠ `grille_sans_jugement` (publication.js) N'EST PLUS ATTEIGNABLE, et c'est
// dit ici plutot que couvert par un test decoratif. Toute categorie de
// CATEGORIES est soit notee, soit `recommandation` : une grille non vide
// produit donc toujours un score ou une recommandation, et une grille vide est
// desormais arretee plus tot par `grille_figee_illisible`. Ce refus reste comme
// ceinture pour le jour ou CATEGORIES accueillera une categorie sans jugement.
// Ecrire un test qui le force aujourd'hui demanderait de falsifier la grille au
// point de ne plus rien prouver.

// ─── La cle qui part chez le provider ───────────────────────────────────────
test('LE TEST QUI COMPTE : c’est la reference du PROVIDER qui part, pas notre UUID', async () => {
  // `ota_review_id` est notre cle primaire dans ota_reviews. L'envoyer
  // construisait « POST /reviews/<uuid-a-nous>/guest_review » : 404 a chaque
  // fois. Constat de review.
  const p = provider()
  await publier({ evaluation: evaluation(), provider: p })
  assert.strictEqual(p.appels.find(a => a.type === 'post').reviewId, 'channex-abc-123')
})

test('sans reference provider resolue, on ne publie PAS sur un identifiant devine', async () => {
  const p = provider()
  await assert.rejects(
    () => publier({ evaluation: evaluation({ ota_review_ref: null }), provider: p }),
    (e) => e instanceof RefusPublication && e.motif === 'reference_ota_absente')
  assert.strictEqual(p.appels.length, 0)
})

test('la relecture de controle vise elle aussi la reference du provider', async () => {
  const p = provider({ etat: { ok: true, is_replied: false } })
  await publier({ evaluation: evaluation({ status: 'echec_publication' }), provider: p })
  assert.strictEqual(p.appels.find(a => a.type === 'get').reviewId, 'channex-abc-123')
})

test('LE TEST QUI COMPTE : une coupure reseau rend « incertain », pas « echec sur »', async () => {
  // lib/channels ne leve jamais : il rend { ok: false, status: 0 }. La branche
  // qui posait `incertain` etait donc inatteignable en production.
  const p = provider({ post: { ok: false, status: 0, json: { errors: { code: 'network_error' } } } })
  const r = await publier({ evaluation: evaluation(), provider: p })
  assert.strictEqual(r.statut, 'echec_publication')
  assert.strictEqual(r.incertain, true)
})

test('un refus franc du provider reste un echec CERTAIN', async () => {
  const p = provider({ post: { ok: false, status: 422, json: { errors: { title: 'invalid' } } } })
  const r = await publier({ evaluation: evaluation(), provider: p })
  assert.strictEqual(r.incertain, false)
})

test('LE TEST QUI COMPTE : « le provider ne dit pas » arrete tout, il ne vaut pas « non »', async () => {
  // Constat de review : lireAvis rendait Boolean(...), donc TOUJOURS un
  // booleen. Cette garde etait inatteignable sur toute reponse 200, et un
  // champ renomme chez Channex aurait fait partir un second avis.
  const p = provider({ etat: { ok: true, is_replied: undefined } })
  await assert.rejects(
    () => publier({ evaluation: evaluation({ status: 'echec_publication' }), provider: p }),
    (e) => e instanceof RefusPublication && e.motif === 'etat_provider_inconnu')
  assert.ok(!p.appels.some(a => a.type === 'post'), 'aucun second envoi')
})

test('« deja parti » arrete tout aussi, et le dit autrement', async () => {
  const p = provider({ etat: { ok: true, is_replied: true } })
  await assert.rejects(
    () => publier({ evaluation: evaluation({ status: 'echec_publication' }), provider: p }),
    (e) => e instanceof RefusPublication && e.motif === 'deja_chez_le_provider')
})

// ─── Publier une part, pas un avis ampute par accident ──────────────────────
const PART_PRESTA = { etat: 'impeccable', degats: 'aucun', poubelles: 'fait' }
const PROFIL_VALIDER = { id: 'p-presta', eval_power: 'valider' }

test('LE TEST QUI COMPTE : une prestataire ne publie PAS un avis ampute', async () => {
  // Decision de Thierry : jamais de publication partielle chez Airbnb. Un avis
  // publie ne se reprend pas, et un avis ampute est un avis faux.
  const p = provider()
  await assert.rejects(
    () => publier({
      evaluation: evaluation({ answers_host: null, answers_cleaner: PART_PRESTA }),
      parProfil: PROFIL_VALIDER, provider: p,
    }),
    (e) => e instanceof RefusPublication && e.motif === 'reponses_hors_grille')
  assert.strictEqual(p.appels.length, 0, 'rien ne part chez l OTA')
})

test('l’HOTE non plus ne publie pas un formulaire incomplet', async () => {
  // Une case oubliee doit se voir, quel que soit celui qui publie.
  await assert.rejects(
    () => publier({ evaluation: evaluation({ answers_host: PART_PRESTA }), provider: provider() }),
    (e) => e instanceof RefusPublication && e.motif === 'reponses_hors_grille')
})

test('une reponse presente mais hors grille est refusee de la meme facon', async () => {
  await assert.rejects(
    () => publier({
      evaluation: evaluation({ answers_host: null, answers_cleaner: { ...PART_PRESTA, etat: 'inconnu' } }),
      parProfil: PROFIL_VALIDER, provider: provider(),
    }),
    (e) => e instanceof RefusPublication && e.motif === 'reponses_hors_grille')
})

test('une prestataire qui n’a rien rempli ne publie pas un avis vide', async () => {
  await assert.rejects(
    () => publier({ evaluation: evaluation({ answers_host: null, answers_cleaner: {} }), parProfil: PROFIL_VALIDER, provider: provider() }),
    (e) => e instanceof RefusPublication && e.motif === 'sans_reponses')
})
