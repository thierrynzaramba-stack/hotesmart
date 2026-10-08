// tests/avis-redaction.test.js
//
// Ce que ces tests protegent : l'IA redige, elle ne juge pas, et ce qu'elle
// rend n'est pas cru sur parole. Aucun appel reseau : le client est injecte.
const test = require('node:test')
const assert = require('node:assert')

const {
  redigerAvis, lireReponse, contreditLesBoutons,
  citeLaPrestataire, recopieLaNotePrivee, MAX_PUBLIC,
} = require('../lib/avis/redaction')
const { GRILLE_DEFAUT } = require('../lib/avis/notes-evaluation')

// Un client factice : il rend, tour a tour, les textes qu'on lui donne.
const client = (...textes) => {
  const file = [...textes]
  const vus = []
  return {
    appels: vus,
    messages: {
      create: async (req) => {
        vus.push(req.messages[0].content)
        const t = file.length > 1 ? file.shift() : file[0]
        if (t instanceof Error) throw t
        return { content: [{ text: t }] }
      },
    },
  }
}

const json = (pub, prive = '') => JSON.stringify({ public: pub, prive })

// Des reponses qui cochent « sale » : la grille par defaut les rend negatives.
const cle = (categorie) => GRILLE_DEFAUT.criteres.find(c => c.categorie === categorie).cle
const PROPRETE = cle('cleanliness')
const critProprete = GRILLE_DEFAUT.criteres.find(c => c.categorie === 'cleanliness')
const NIV_SALE = critProprete.niveaux.find(n => n.negatif).cle
const NIV_BIEN = critProprete.niveaux.find(n => n.note === 5).cle

// ⚠ La redaction exige un formulaire COMPLET : le calcul du drapeau negatif ne
// devine pas une reponse manquante. On part donc du meilleur niveau de chaque
// critere, et on remplace celui qu'on veut eprouver.
const TOUT_BON = Object.fromEntries(GRILLE_DEFAUT.criteres.map(c => {
  const meilleur = c.categorie === 'recommandation'
    ? c.niveaux.find(n => n.recommande === true)
    : [...c.niveaux].sort((a, b) => b.note - a.note)[0]
  return [c.cle, meilleur.cle]
}))
const avec = (extra) => ({ ...TOUT_BON, ...extra })

// ─── La lecture de ce que rend le modele ────────────────────────────────────
test('un JSON entoure de ``` est quand meme lu', () => {
  const r = lireReponse('```json\n{"public":"Merci Marc","prive":""}\n```')
  assert.strictEqual(r.public_text, 'Merci Marc')
  assert.strictEqual(r.private_note, null)
})

test('un texte public vide n’est pas un texte', () => {
  assert.strictEqual(lireReponse(json('   ')), null)
})

test('du bavardage sans JSON ne passe pas pour un avis', () => {
  assert.strictEqual(lireReponse('Bien sur ! Voici votre avis.'), null)
})

test('un texte trop long est coupe, pas refuse', () => {
  const r = lireReponse(json('a'.repeat(MAX_PUBLIC + 200)))
  assert.strictEqual(r.public_text.length, MAX_PUBLIC)
})

// ─── Les garde-fous, un par un ──────────────────────────────────────────────
test('« impeccable » est un mensonge quand un bouton negatif est coche', () => {
  assert.strictEqual(contreditLesBoutons('Sejour impeccable, merci !', true), true)
  assert.strictEqual(contreditLesBoutons('Sejour impeccable, merci !', false), false)
})

test('l’eloge est reconnu meme sans accents et en anglais', () => {
  assert.strictEqual(contreditLesBoutons('Rien à signaler.', true), true)
  assert.strictEqual(contreditLesBoutons('Nothing to report.', true), true)
})

test('le prenom de la prestataire ne passe pas, meme accentue', () => {
  assert.strictEqual(citeLaPrestataire('Merci à Amélie pour tout', 'Amelie'), true)
  assert.strictEqual(citeLaPrestataire('Merci pour tout', 'Amelie'), false)
})

test('un prenom trop court ne declenche pas de faux positif', () => {
  // « Li » se trouverait dans « lit », « ligne », « lire »…
  assert.strictEqual(citeLaPrestataire('Un lit bien fait', 'Li'), false)
})

test('un prenom qui est un morceau de mot ne compte pas', () => {
  assert.strictEqual(citeLaPrestataire('Le menage etait fait', 'Ana'), false)
})

test('une phrase privee recopiee dans le public est vue', () => {
  const prive = 'Le voyageur a laisse la cuisine dans un etat inacceptable, plats sales partout.'
  assert.strictEqual(recopieLaNotePrivee(`Bonjour. ${prive} Merci.`, prive), true)
})

test('une formule courte partagee ne declenche pas l’alarme', () => {
  assert.strictEqual(recopieLaNotePrivee('Merci pour tout', 'Merci pour tout'), false)
})

// ─── Le parcours complet ────────────────────────────────────────────────────
test('un sejour sans accroc rend le texte du premier coup', async () => {
  const c = client(json('Marc a été un voyageur agréable.', 'RAS'))
  const r = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_BIEN }), prenom: 'Marc' }, { anthropic: c })
  assert.strictEqual(r.motif, null)
  assert.strictEqual(r.negatif, false)
  assert.match(r.public_text, /Marc/)
  assert.strictEqual(c.appels.length, 1)
})

test('LE TEST QUI COMPTE : un texte elogieux sur un sejour negatif est refuse, puis redemande', async () => {
  const c = client(
    json('Séjour impeccable, rien à signaler !'),
    json('Le logement a été rendu sale.'),
  )
  const r = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_SALE }) }, { anthropic: c })
  assert.strictEqual(r.negatif, true)
  assert.strictEqual(r.motif, null)
  assert.match(r.public_text, /sale/i)
  assert.strictEqual(c.appels.length, 2, 'le modele doit etre relance')
  assert.match(c.appels[1], /REFUSE/, 'la seconde consigne doit etre durcie')
})

test('LE TEST QUI COMPTE : deux textes hors gardes ne publient rien, et le disent', async () => {
  const c = client(json('Séjour impeccable !'))
  const r = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_SALE }) }, { anthropic: c })
  assert.strictEqual(r.public_text, null)
  assert.strictEqual(r.motif, 'ia_contredit_les_boutons')
  assert.strictEqual(c.appels.length, 2)
})

test('le prenom de la prestataire fait refuser le texte', async () => {
  const c = client(json('Merci à Amélie qui a tout remis en ordre.'))
  const r = await redigerAvis(
    { reponses: avec({ [PROPRETE]: NIV_BIEN }), prestataire: 'Amélie' },
    { anthropic: c })
  assert.strictEqual(r.motif, 'ia_cite_la_prestataire')
})

test('la remarque privee de l’hote recopiee fait refuser le texte', async () => {
  const remarque = 'Il a insisté pour rester deux heures de plus sans prévenir, encore une fois.'
  const c = client(json(`Bonjour. ${remarque}`))
  const r = await redigerAvis(
    { reponses: avec({ [PROPRETE]: NIV_BIEN }), remarque },
    { anthropic: c })
  assert.strictEqual(r.motif, 'ia_recopie_le_prive')
})

test('une panne du fournisseur est nommee, pas confondue avec un refus', async () => {
  const c = client(new Error('503 upstream'))
  const r = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_BIEN }) }, { anthropic: c })
  assert.strictEqual(r.motif, 'ia_indisponible')
  assert.match(r.detail, /503/)
})

test('le prompt donne les libelles coches, jamais les notes', async () => {
  const c = client(json('ok'))
  await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_SALE }) }, { anthropic: c })
  const p = c.appels[0]
  assert.match(p, new RegExp(critProprete.libelle))
  assert.ok(!/\b[1-5]\s*\/\s*5\b/.test(p), 'aucune note ne doit apparaitre dans le prompt')
})

test('la langue du voyageur est demandee explicitement', async () => {
  const c = client(json('ok'))
  await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_BIEN }), langue: 'es' }, { anthropic: c })
  // ⚠ L'ancienne assertion etait /es/, qui se trouve dans « les », « REGLES »,
  // « Ce que l'hote a coche »… Elle serait restee verte si la consigne de
  // langue disparaissait du prompt. Constat de review.
  assert.match(c.appels[0], /Langue du texte public : es/)
})

test('une grille figee ancienne sert de reference si on la passe', async () => {
  const grille = { criteres: [{ cle: 'x', libelle: 'Critère retiré depuis', categorie: 'cleanliness', niveaux: [
    { cle: 'a', libelle: 'Impeccable', rang: 1, note: 5, negatif: false },
  ] }] }
  const c = client(json('ok'))
  await redigerAvis({ reponses: { x: 'a' }, grille }, { anthropic: c })
  assert.match(c.appels[0], /Critère retiré depuis/)
})

test('LE TEST QUI COMPTE : un formulaire incomplet ne redige rien et n’appelle pas le modele', async () => {
  // Un « negatif par prudence » ferait un texte severe sur un sejour qui ne
  // l'est peut-etre pas. On refuse, on nomme, et on ne depense rien.
  const c = client(json('Séjour agréable.'))
  const r = await redigerAvis({ reponses: { [PROPRETE]: NIV_BIEN } }, { anthropic: c })
  assert.strictEqual(r.public_text, null)
  assert.strictEqual(r.motif, 'reponses_hors_grille')
  assert.strictEqual(r.negatif, null, 'on ne devine pas le drapeau')
  assert.strictEqual(c.appels.length, 0, 'aucun appel au modele')
})

test('une reponse qui ne correspond a aucun niveau est refusee de la meme facon', async () => {
  const c = client(json('Séjour agréable.'))
  const r = await redigerAvis({ reponses: avec({ [PROPRETE]: 'niveau_invente' }) }, { anthropic: c })
  assert.strictEqual(r.motif, 'reponses_hors_grille')
  assert.strictEqual(c.appels.length, 0)
})

// ─── Les garde-fous qui doivent pouvoir dire « je ne sais pas » ─────────────
test('LE TEST QUI COMPTE : une note privee COURTE recopiee est vue', () => {
  // Le plancher de 40 caracteres laissait passer les notes les plus seches.
  const prive = 'A fume dans le salon.'
  assert.strictEqual(recopieLaNotePrivee(`Bonjour. ${prive} Merci.`, prive), true)
})

test('« merci pour tout » ne declenche toujours pas l’alarme', () => {
  assert.strictEqual(recopieLaNotePrivee('Merci pour tout, bon voyage', 'Merci pour tout'), false)
})

test('une suite faite QUE de liaisons ne compte pas pour une recopie', () => {
  assert.strictEqual(recopieLaNotePrivee('il etait dans la maison avec le chien', 'dans la avec le et'), false)
})

test('LE TEST QUI COMPTE : un avis NEGATIF dans une langue non verifiable n’est pas redige', async () => {
  // « Alles war einwandfrei » passait les trois garde-fous sur un sejour ou la
  // proprete est cochee « sale ». On ne promet pas ce qu'on ne sait pas lire.
  const c = client(json('Alles war einwandfrei.'))
  const r = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_SALE }), langue: 'de' }, { anthropic: c })
  assert.strictEqual(r.public_text, null)
  assert.strictEqual(r.motif, 'langue_non_verifiable')
  assert.strictEqual(c.appels.length, 0, 'aucun appel paye pour un texte qu on ne pourra pas relire')
})

test('un sejour NON negatif dans la meme langue se redige normalement', async () => {
  // Le garde-fou des eloges ne sert que sur un negatif : rien ne justifie de
  // bloquer un avis positif en allemand.
  const c = client(json('Sehr angenehme Gäste.'))
  const r = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_BIEN }), langue: 'de' }, { anthropic: c })
  assert.strictEqual(r.motif, null)
})

test('deux reponses de charabia se distinguent d’un garde-fou viole', async () => {
  const c = client('Bien sur ! Voici votre avis.')
  const r = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_BIEN }) }, { anthropic: c })
  assert.strictEqual(r.motif, 'ia_illisible')
})

// ─── Recette de Thierry du 7 octobre 2026, points H et I ─────────────────────
// Textes PUBLIES chez Airbnb le 2 octobre 2026, recopies tels quels : ils
// doivent tous etre refuses par les garde-fous d'aujourd'hui.
const R = require('../lib/avis/redaction')
const PUBLIES_FAUTIFS = [
  ['Angela a été une excellente hôte ! Communication fluide du début à la fin, respectueuse des horaires et des règles convenues. Le logement a été quitté propre et en parfait état. Je la recommande vivement aux futurs hôtes.', 'hote'],
  ['Mickaël a été un voyageur exemplaire ! Communication fluide, respect parfait des horaires et des règles, et il a laissé le logement dans un état impeccable. Un hôte consciencieux et fiable sur lequel on peut compter. Je le recommande vivement aux futurs propriétaires.', 'hote'],
]

test('LE TEST QUI COMPTE (point H) : les deux textes publies avec l erreur sont refuses — le voyageur appele « hôte », les « propriétaires »', () => {
  for (const [t] of PUBLIES_FAUTIFS) assert.strictEqual(R.appelleLeVoyageurHote(t, 'fr'), true, t.slice(0, 40))
  assert.strictEqual(R.parleDeProprietaires(PUBLIES_FAUTIFS[1][0], 'fr'), true)
  // « hôtes » reste admis pour les LECTEURS de l'avis.
  for (const t of ['Je recommande Sam aux futurs hôtes.', 'Recommandé à tous les hôtes.', 'Un plaisir pour les autres hôtes.']) assert.strictEqual(R.appelleLeVoyageurHote(t, 'fr'), false, t)
  assert.strictEqual(R.appelleLeVoyageurHote('Sam was a great host.', 'en'), true)
  assert.strictEqual(R.appelleLeVoyageurHote('We recommend Sam to future hosts.', 'en'), false)
  assert.strictEqual(R.parleDeProprietaires('Recommended to all owners.', 'en'), true)
})

test('point H (decision du 8 octobre) : aucun genre deduit du prenom — voyageuse, il/elle, le/la recommande, he/she sont refuses', () => {
  for (const t of ['Sandra a été une voyageuse remarquable.', 'Elle a laissé le logement propre.', 'Je la recommande.', 'Je le recommande.']) assert.strictEqual(R.genreLeVoyageur(t, 'fr'), true, t)
  assert.strictEqual(R.genreLeVoyageur('Un plaisir d’accueillir Sandra, qui a pris soin du logement. Nous recommandons Sandra.', 'fr'), false)
  assert.strictEqual(R.genreLeVoyageur('She left it spotless.', 'en'), true)
  assert.strictEqual(R.genreLeVoyageur('Sam left it spotless.', 'en'), false)
})

test('LE TEST QUI COMPTE (point H) : un texte qui appelle le voyageur « hôte » est REECRIT, avec la raison dans la consigne', async () => {
  const c = client(json(PUBLIES_FAUTIFS[0][0]), json('Un plaisir d’accueillir Angela, qui a pris soin du logement. Nous recommandons Angela aux futurs hôtes.'))
  const r = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_BIEN }), prenom: 'Angela', langue: 'fr' }, { anthropic: c, hasard: () => 0 })
  assert.strictEqual(r.motif, null)
  assert.match(r.public_text, /^Un plaisir d’accueillir Angela/)
  assert.strictEqual(c.appels.length, 2)
  assert.match(c.appels[1], /le voyageur n’est jamais un hôte/)
  // Deux fois fautif : rien n'est rendu, l'hote ecrit lui-meme.
  const c2 = client(json(PUBLIES_FAUTIFS[0][0]))
  const r2 = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_BIEN }), prenom: 'Angela', langue: 'fr' }, { anthropic: c2 })
  assert.strictEqual(r2.public_text, null)
  assert.strictEqual(r2.motif, 'ia_appelle_hote')
})

test('point I : la consigne demande 2-3 phrases, une ouverture variee, les mots-cles, et interdit d affirmer un point non coche', () => {
  const p = R.construirePrompt({ coches: [{ critere: 'Propreté', niveau: 'Très propre' }], prenom: 'Sam', langue: 'fr', config: { keywords: ['cocon', 'zen'] }, negatif: false, durcir: false, ouverture: R.OUVERTURES[2] })
  assert.match(p, /2 a 3 phrases courtes/)
  assert.match(p, /Ne commence PAS par « Sam a été »/)
  assert.ok(p.includes(R.OUVERTURES[2]))
  assert.match(p, /cocon, zen\. Emploie AU MOINS UN d'entre eux/)
  assert.match(p, /Ne parle QUE des points coches/)
  assert.doesNotMatch(p, /facultatif, ne force rien/)
})

test('point I : un texte sans aucun mot-cle a une seconde chance, jamais un refus', async () => {
  const sans = json('Un plaisir d’accueillir Sam, qui a pris soin du logement.')
  const avecMot = json('Un vrai cocon laissé en ordre : un plaisir d’accueillir Sam.')
  const c = client(sans, avecMot)
  const r = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_BIEN }), prenom: 'Sam', langue: 'fr', config: { keywords: ['cocon'] } }, { anthropic: c })
  assert.match(r.public_text, /cocon/)
  assert.match(c.appels[1], /n’employait aucun des mots/)
  const c2 = client(sans)
  const r2 = await redigerAvis({ reponses: avec({ [PROPRETE]: NIV_BIEN }), prenom: 'Sam', langue: 'fr', config: { keywords: ['cocon'] } }, { anthropic: c2 })
  assert.strictEqual(r2.motif, null, 'au second essai, le texte juste sans le mot passe')
})
