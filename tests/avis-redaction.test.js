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
  assert.strictEqual(r.motif, 'ia_hors_gardes')
  assert.strictEqual(c.appels.length, 2)
})

test('le prenom de la prestataire fait refuser le texte', async () => {
  const c = client(json('Merci à Amélie qui a tout remis en ordre.'))
  const r = await redigerAvis(
    { reponses: avec({ [PROPRETE]: NIV_BIEN }), prestataire: 'Amélie' },
    { anthropic: c })
  assert.strictEqual(r.motif, 'ia_hors_gardes')
})

test('la remarque privee de l’hote recopiee fait refuser le texte', async () => {
  const remarque = 'Il a insisté pour rester deux heures de plus sans prévenir, encore une fois.'
  const c = client(json(`Bonjour. ${remarque}`))
  const r = await redigerAvis(
    { reponses: avec({ [PROPRETE]: NIV_BIEN }), remarque },
    { anthropic: c })
  assert.strictEqual(r.motif, 'ia_hors_gardes')
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
  assert.match(c.appels[0], /es/)
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
