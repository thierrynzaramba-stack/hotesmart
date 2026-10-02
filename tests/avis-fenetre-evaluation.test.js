// tests/avis-fenetre-evaluation.test.js
// La fenetre d'evaluation du voyageur (core/avis/fenetre-evaluation.js) dans un
// DOM (jsdom), avec l'appel serveur INJECTE : aucun reseau, aucune session.
//
// CE QU'ILS PROTEGENT : un ecran qui publierait un avis negatif sans confirmer,
// qui montrerait la note privee a une prestataire, qui enverrait au serveur des
// reponses a des questions qui ne lui sont pas ouvertes, ou qui ferait
// disparaitre un refus nomme derriere un silence.
const test = require('node:test')
const assert = require('node:assert')
const { JSDOM } = require('jsdom')

let ouvrir, compteRendu, estNegatifAffiche, messageDErreur
test.before(async () => {
  ({ ouvrir, compteRendu, estNegatifAffiche, messageDErreur } = await import('../core/avis/fenetre-evaluation.js'))
})

function dom () {
  const d = new JSDOM('<!doctype html><body><div id="c"></div></body>', { pretendToBeVisual: true })
  global.CustomEvent = d.window.CustomEvent
  return d.window.document
}

// Trois criteres ouverts a l'hote, dont un qui peut etre negatif.
const CRITERES = [
  { cle: 'etat', libelle: 'Etat du logement', categorie: 'cleanliness', niveaux: [
    { cle: 'impeccable', libelle: 'Impeccable', rang: 1, note: 5, negatif: false },
    { cle: 'sale', libelle: 'Sale', rang: 2, note: 1, negatif: true },
  ] },
  { cle: 'regles', libelle: 'Respect des regles', categorie: 'respect_house_rules', niveaux: [
    { cle: 'oui', libelle: 'Oui', rang: 1, note: 5, negatif: false },
    { cle: 'non', libelle: 'Non', rang: 2, note: 1, negatif: true },
  ] },
]

// Un faux appel serveur : enregistre ce qu'on lui demande, rend ce qu'on lui dit.
function faussAppel (reponses = {}) {
  const appels = []
  return {
    appels,
    fn: async (chemin, opts = {}) => {
      appels.push({ chemin, ...opts })
      for (const [motif, rep] of Object.entries(reponses)) {
        if (chemin.includes(motif)) {
          if (rep instanceof Error) throw rep
          return typeof rep === 'function' ? rep(opts) : rep
        }
      }
      return {}
    },
  }
}

const EVALUATION = {
  id: 'e1', booking_uid: 'BK-1', status: 'a_remplir', ota: 'airbnb',
  language: 'fr', deadline_at: '2026-10-20T00:00:00Z',
  public_text: null, private_note: null, answers_cleaner: null, answers_host: null,
}

const chargement = (extra = {}) => ({
  'action=evaluation': { evaluation: { ...EVALUATION, ...(extra.evaluation || {}) }, role: extra.role || 'hote', criteres: extra.criteres || CRITERES },
  ...(extra.autres || {}),
})

async function monter (extra = {}, deps = {}) {
  const document = dom()
  const conteneur = document.getElementById('c')
  const a = faussAppel(chargement(extra))
  const ferme = []
  const r = await ouvrir({
    conteneur, params: { booking_uid: 'BK-1' }, fermer: () => ferme.push(true),
    deps: { appel: a.fn, confirmer: deps.confirmer || (() => true), ...(deps.delaiFermeture !== undefined ? { delaiFermeture: deps.delaiFermeture } : {}) },
  })
  return { document, conteneur, appels: a.appels, resultat: r, ferme }
}

// ─── Le chargement ──────────────────────────────────────────────────────────
test('la fenetre affiche les questions ouvertes au role', async () => {
  const { conteneur, resultat } = await monter()
  assert.strictEqual(resultat.charge, true)
  assert.strictEqual(conteneur.querySelectorAll('[data-avis-critere]').length, 2)
  assert.match(conteneur.textContent, /Etat du logement/)
  assert.match(conteneur.textContent, /Respect des regles/)
})

test('LE TEST QUI COMPTE : un sejour hors perimetre le DIT, il ne laisse pas une boite vide', async () => {
  // Si ce module levait, le bus fermerait la fenetre et repondrait
  // « indisponible » : l'utilisateur verrait son bouton ne rien faire.
  const document = dom()
  const conteneur = document.getElementById('c')
  const err = new Error('Ce bien n est pas dans votre perimetre'); err.statut = 403
  const r = await ouvrir({
    conteneur, params: { booking_uid: 'BK-1' }, fermer: () => {},
    deps: { appel: async () => { throw err } },
  })
  assert.strictEqual(r.charge, false)
  assert.match(conteneur.textContent, /périmètre/)
  assert.ok(conteneur.querySelector('[data-avis="fermer"]'), 'un bouton pour sortir')
})

test('une evaluation sans question ouverte le dit au lieu d’afficher un formulaire vide', async () => {
  const { conteneur } = await monter({ criteres: [] })
  assert.match(conteneur.textContent, /Aucune question/)
  assert.strictEqual(conteneur.querySelector('[data-avis="enregistrer"]'), null)
})

// ─── Ce qu'on envoie au serveur ─────────────────────────────────────────────
test('LE TEST QUI COMPTE : on n’envoie QUE les criteres ouverts a ce role', async () => {
  // Le formulaire pre-coche la part de la prestataire pour que l'hote la voie.
  // L'envoyer telle quelle ferait refuser une saisie valide par le serveur.
  const { conteneur, appels } = await monter({
    role: 'prestataire',
    criteres: [CRITERES[0]],
    evaluation: { answers_cleaner: { etat: 'impeccable' }, answers_host: { regles: 'oui' } },
  })
  conteneur.querySelector('[data-avis="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 0))
  const envoi = appels.find(a => a.chemin.includes('eval-reponses'))
  assert.ok(envoi, 'un enregistrement doit partir')
  assert.deepStrictEqual(Object.keys(envoi.corps.reponses), ['etat'])
})

test('le sejour part dans le corps, jamais un identifiant de table du coeur', async () => {
  const { conteneur, appels } = await monter()
  conteneur.querySelector('[data-avis-critere="etat"]').value = 'impeccable'
  conteneur.querySelector('[data-avis="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 0))
  const envoi = appels.find(a => a.chemin.includes('eval-reponses'))
  assert.strictEqual(envoi.corps.booking_uid, 'BK-1')
})

// ─── Le garde-fou du negatif ────────────────────────────────────────────────
test('LE TEST QUI COMPTE : publier un avis negatif demande une confirmation', async () => {
  let demande = null
  const document = dom()
  const conteneur = document.getElementById('c')
  const a = faussAppel(chargement({ evaluation: { public_text: 'Texte', status: 'a_valider' } }))
  await ouvrir({
    conteneur, params: { booking_uid: 'BK-1' }, fermer: () => {},
    deps: { appel: a.fn, confirmer: (m) => { demande = m; return false } },
  })
  conteneur.querySelector('[data-avis-critere="etat"]').value = 'sale'
  conteneur.querySelector('[data-avis-critere="etat"]').dispatchEvent(new document.defaultView.Event('change'))
  conteneur.querySelector('[data-avis="publier"]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.ok(demande, 'la confirmation doit etre demandee')
  assert.match(demande, /NÉGATIF/)
  assert.ok(!a.appels.some(x => x.chemin.includes('eval-publier')), 'refus = rien ne part')
})

test('un avis non negatif publie sans confirmation', async () => {
  let demandes = 0
  const document = dom()
  const conteneur = document.getElementById('c')
  const a = faussAppel({ ...chargement({ evaluation: { public_text: 'Texte', status: 'a_valider' } }),
                         'eval-publier': { ok: true, status: 'publiee', published_at: '2026-10-01T10:00:00Z' } })
  await ouvrir({
    conteneur, params: { booking_uid: 'BK-1' }, fermer: () => {},
    deps: { appel: a.fn, confirmer: () => { demandes++; return true } },
  })
  conteneur.querySelector('[data-avis-critere="etat"]').value = 'impeccable'
  conteneur.querySelector('[data-avis-critere="etat"]').dispatchEvent(new document.defaultView.Event('change'))
  conteneur.querySelector('[data-avis="publier"]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.strictEqual(demandes, 0)
  assert.ok(a.appels.some(x => x.chemin.includes('eval-publier')))
})

test('le compte rendu annonce un avis negatif avant tout clic', () => {
  const etat = { criteres: CRITERES, reponses: { etat: 'sale', regles: 'oui' } }
  assert.match(compteRendu(etat), /NÉGATIF/)
  assert.strictEqual(estNegatifAffiche(etat), true)
})

test('il compte les questions qui restent', () => {
  assert.match(compteRendu({ criteres: CRITERES, reponses: { etat: 'impeccable' } }), /il en reste 1/)
})

// ─── Ce que voit une prestataire ────────────────────────────────────────────
test('LE TEST QUI COMPTE : une prestataire ne voit pas la note privee, meme si elle arrivait', async () => {
  // Le serveur ne l'envoie pas. Ce test est la seconde barriere : un jour, un
  // champ de plus dans la reponse ne doit pas la faire apparaitre a l'ecran.
  const { conteneur } = await monter({
    role: 'prestataire', criteres: [CRITERES[0]],
    evaluation: { private_note: 'A laisse la cuisine sale.', public_text: 'Texte public' },
  })
  assert.ok(!conteneur.textContent.includes('cuisine sale'))
  assert.match(conteneur.textContent, /relisez-le avant de publier/i)
})

test('l’hote, lui, voit la note privee', async () => {
  const { conteneur } = await monter({ evaluation: { private_note: 'A laisse la cuisine sale.' } })
  assert.match(conteneur.textContent, /cuisine sale/)
})

test('une prestataire ne peut pas modifier le texte public', async () => {
  const { conteneur } = await monter({ role: 'prestataire', criteres: [CRITERES[0]], evaluation: { public_text: 'Texte' } })
  assert.ok(conteneur.querySelector('[data-avis="texte"]').hasAttribute('readonly'))
})

test('une prestataire ne redige pas, et n’abandonne pas', async () => {
  const { conteneur } = await monter({ role: 'prestataire', criteres: [CRITERES[0]] })
  assert.strictEqual(conteneur.querySelector('[data-avis="rediger"]'), null)
  assert.strictEqual(conteneur.querySelector('[data-avis="abandonner"]'), null)
})

// ─── Les refus nommes ───────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un refus de redaction est AFFICHE, avec sa raison', async () => {
  // C'est la raison pour laquelle l'evaluation revient a l'hote. La taire lui
  // ferait decouvrir un formulaire rempli sans comprendre pourquoi.
  const document = dom()
  const conteneur = document.getElementById('c')
  const a = faussAppel({ ...chargement(), 'eval-reponses': {
    ok: true, status: 'a_valider', peut_publier: false,
    redaction: { ok: false, motif: 'ia_cite_la_prestataire' },
  } })
  await ouvrir({ conteneur, params: { booking_uid: 'BK-1' }, fermer: () => {}, deps: { appel: a.fn, confirmer: () => true } })
  conteneur.querySelector('[data-avis="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.match(conteneur.textContent, /citait le prénom de la prestataire/)
})

test('un refus de publication nomme est traduit, pas masque', async () => {
  const document = dom()
  const conteneur = document.getElementById('c')
  const err = new Error('un avis negatif est valide par l hote'); err.statut = 409; err.motif = 'negatif_a_valider'
  const a = faussAppel({ ...chargement({ evaluation: { public_text: 'Texte' } }), 'eval-publier': err })
  await ouvrir({ conteneur, params: { booking_uid: 'BK-1' }, fermer: () => {}, deps: { appel: a.fn, confirmer: () => true } })
  conteneur.querySelector('[data-avis="publier"]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.match(conteneur.textContent, /seul l’hôte peut le publier/)
})

test('un motif INCONNU est affiche tel quel plutot que passe sous silence', () => {
  const err = new Error('refus'); err.motif = 'motif_de_demain'
  assert.match(messageDErreur(err), /motif_de_demain/)
})

// ─── Les etats terminaux ────────────────────────────────────────────────────
test('une evaluation publiee ne propose plus de publier ni de modifier', async () => {
  const { conteneur } = await monter({ evaluation: { status: 'publiee', published_at: '2026-10-01T10:00:00Z', public_text: 'Texte' } })
  assert.strictEqual(conteneur.querySelector('[data-avis="publier"]'), null)
  assert.strictEqual(conteneur.querySelector('[data-avis="enregistrer"]'), null)
  assert.ok(conteneur.querySelector('[data-avis="texte"]').hasAttribute('readonly'))
  assert.match(conteneur.textContent, /publiée le/)
})

test('une evaluation expiree ne propose plus rien non plus', async () => {
  const { conteneur } = await monter({ evaluation: { status: 'expiree' } })
  assert.strictEqual(conteneur.querySelector('[data-avis="publier"]'), null)
  assert.match(conteneur.textContent, /Délai dépassé/)
})

test('le bouton Fermer appelle la fermeture du bus', async () => {
  const { conteneur, ferme } = await monter()
  conteneur.querySelector('[data-avis="fermer"]').click()
  assert.strictEqual(ferme.length, 1)
})

// ─── L'echappement ──────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un libelle de critere ne peut pas injecter de balise', async () => {
  // Les libelles viennent de la grille de l'hote : c'est une saisie utilisateur.
  const { conteneur } = await monter({
    criteres: [{ cle: 'x', libelle: '<img src=x onerror=alert(1)>', niveaux: [{ cle: 'a', libelle: 'A' }] }],
  })
  assert.strictEqual(conteneur.querySelectorAll('img').length, 0)
  assert.match(conteneur.textContent, /<img src=x/)
})

// ─── Les correctifs de la revue du lot 4 ────────────────────────────────────
test('LE TEST QUI COMPTE : une prestataire « valider » voit son bouton Publier DES L’OUVERTURE', async () => {
  // Constat de review : `peut_publier` n'arrivait que par la reponse a
  // `eval-reponses`. Elle devait donc re-enregistrer ses reponses pour faire
  // apparaitre le bouton, alors que la spec dit « elle relit, puis elle publie ».
  const document = dom()
  const conteneur = document.getElementById('c')
  const a = faussAppel({ 'action=evaluation': {
    evaluation: { ...EVALUATION, status: 'a_valider', public_text: 'Texte pret' },
    role: 'prestataire', criteres: [CRITERES[0]], peut_publier: true, negatif: false,
  } })
  await ouvrir({ conteneur, params: { booking_uid: 'BK-1' }, fermer: () => {}, deps: { appel: a.fn, confirmer: () => true } })
  assert.ok(conteneur.querySelector('[data-avis="publier"]'), 'le bouton doit etre la sans rien cliquer')
})

test('LE TEST QUI COMPTE : decocher un niveau EFFACE la reponse au lieu de la laisser en base', async () => {
  // Constat de review : la valeur devenait `null` et l'envoi ignorait les `null`,
  // donc la reponse survivait a son decochage. L'hote croyait avoir retire son
  // jugement.
  const { conteneur, appels, document } = await monter({ evaluation: { answers_host: { etat: 'sale' } } })
  const sel = conteneur.querySelector('[data-avis-critere="etat"]')
  sel.value = ''
  sel.dispatchEvent(new document.defaultView.Event('change'))
  conteneur.querySelector('[data-avis="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 0))
  const envoi = appels.find(x => x.chemin.includes('eval-reponses'))
  assert.strictEqual(envoi.corps.reponses.etat, null, 'l effacement doit partir')
})

test('un texte modifie annonce qu’il n’est pas encore enregistre', async () => {
  const { conteneur, document } = await monter({ evaluation: { public_text: 'Texte' } })
  const t = conteneur.querySelector('[data-avis="texte"]')
  t.value = 'Texte modifie'
  t.dispatchEvent(new document.defaultView.Event('input'))
  assert.match(conteneur.textContent, /ne sera enregistré qu’à la publication/)
})

test('LE TEST QUI COMPTE : « je ne sais pas » sur la recommandation compte comme negatif a l’ecran aussi', () => {
  // La quatrieme regle de lib/avis/notes-evaluation.js manquait ici : une grille
  // figee anterieure aux contraintes declenchait le garde-fou serveur sans que la
  // fenetre demande confirmation.
  const etat = {
    criteres: [{ cle: 'reco', categorie: 'recommandation', niveaux: [{ cle: 'non', libelle: 'Non' }] }],
    reponses: { reco: 'non' },
  }
  assert.strictEqual(estNegatifAffiche(etat), true)
})

test('une grille indisponible n’empeche pas de savoir OU EN EST l’evaluation', async () => {
  // Constat de review : `avis.statut` passe par cette action. Une grille illisible
  // faisait repondre « indisponible » au bus, et l'app masquait son bouton pour
  // une raison sans rapport avec le sejour.
  const document = dom()
  const conteneur = document.getElementById('c')
  const a = faussAppel({ 'action=evaluation': {
    evaluation: { ...EVALUATION, status: 'a_valider' }, role: 'hote', criteres: [],
    grille_indisponible: true,
  } })
  const r = await ouvrir({ conteneur, params: { booking_uid: 'BK-1' }, fermer: () => {}, deps: { appel: a.fn } })
  assert.strictEqual(r.charge, true)
  assert.strictEqual(r.statut, 'a_valider')
})

// ─── Recette du 2 octobre 2026 : la prestataire a fini, la fenetre se ferme ─
test('LE TEST QUI COMPTE : la prestataire qui n’a rien a publier lit un merci, et la fenetre se ferme', async () => {
  const { conteneur, ferme } = await monter({
    role: 'prestataire', criteres: [CRITERES[0]],
    evaluation: { answers_cleaner: { etat: 'sale' } },
    autres: { 'action=eval-reponses': { ok: true, status: 'a_valider', peut_publier: false, negatif: true, motif: 'avis negatif : l hote tranche, quel que soit le pouvoir' } },
  }, { delaiFermeture: 0 })
  conteneur.querySelector('[data-avis="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 10))
  assert.match(conteneur.textContent, /Merci, vos réponses sont enregistrées/)
  assert.ok(!/l hote tranche/.test(conteneur.textContent), 'le motif brut ne lui est pas montre')
  assert.strictEqual(ferme.length, 1, 'la fenetre se ferme')
})

test('une prestataire qui PEUT publier garde la fenetre pour relire', async () => {
  const { conteneur, ferme } = await monter({
    role: 'prestataire', criteres: [CRITERES[0]],
    evaluation: { answers_cleaner: { etat: 'impeccable' } },
    autres: { 'action=eval-reponses': { ok: true, status: 'a_valider', peut_publier: true, negatif: false, redaction: { ok: true, public_text: 'Merci.' } } },
  }, { delaiFermeture: 0 })
  conteneur.querySelector('[data-avis="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 10))
  assert.strictEqual(ferme.length, 0)
  assert.match(conteneur.textContent, /texte a été rédigé/)
})
