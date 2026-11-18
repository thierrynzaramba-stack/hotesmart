// tests/reponse-prete-regles.test.js — les règles pures de l'étape 2
// (lib/guestflow/reponse-prete.js ; spec docs/specs/spec-info-manquante-choix.md §2 C).
//
// ⚠ CE QUE CES TESTS GARDENT : tout ce qui vient du modèle est VÉRIFIÉ avant
// d'être proposé à l'hôte. Une proposition fausse ne s'écrit pas seule (le
// geste de l'hôte reste nécessaire), mais une « mise à jour » qui viserait une
// autre réponse, ou une réponse prête qui nommerait un voyageur, finirait dans
// la base d'un hôte qui relit vite.

const test = require('node:test')
const assert = require('node:assert/strict')
const P = require('../lib/guestflow/reponse-prete')
const R = require('../lib/guestflow/rediger')

const EXISTANTES = [
  { id: 11, sujet: 'Animaux', texte: 'Les animaux ne sont pas acceptés.' },
  { id: 12, sujet: 'Parking', texte: 'Parking gratuit rue Voltaire.' }
]
const modele = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] })

test('questionsPourLaBase : les questions d une tâche CLOSE par l envoi restent lisibles ; les autres règles de la carte tiennent', () => {
  const t = { task_type: 'info_unknown', status: 'done', summary: 'x', sub_tasks: [{ question: 'Chien ?' }, { question: 'Moto ?' }] }
  assert.deepEqual(P.questionsPourLaBase(t), ['Chien ?', 'Moto ?'])
  assert.deepEqual(P.questionsPourLaBase({ ...t, status: 'pending' }), ['Chien ?', 'Moto ?'])
  assert.deepEqual(P.questionsPourLaBase({ ...t, status: 'ignored' }), [], 'une tâche écartée ne propose rien')
  assert.deepEqual(P.questionsPourLaBase({ ...t, task_type: 'intervention' }), [], 'une intervention n est pas une question')
  assert.deepEqual(P.questionsPourLaBase({ ...t, summary: R.MOTIF_ARRET }), [], 'tâche système')
  assert.deepEqual(P.questionsPourLaBase({ ...t, sub_tasks: [{ question: 'Tout le message', summary: R.SOUS_TACHES_DE_SECOURS[0] }] }), [], 'sous-tâche de secours')
  assert.deepEqual(P.questionsPourLaBase(null), [])
})

test('validerEnvoye : vide refusé, trop long refusé', () => {
  assert.deepEqual(P.validerEnvoye('  Oui pour le chien.  '), { ok: true, envoye: 'Oui pour le chien.' })
  assert.equal(P.validerEnvoye('   ').ok, false)
  assert.equal(P.validerEnvoye(42).ok, false)
  assert.equal(P.validerEnvoye('x'.repeat(R.MAX_TEXTE + 1)).erreur, 'envoye_trop_long')
})

test('LE TEST QUI COMPTE : le prompt ne porte ni la conversation ni le nom du voyageur, et numérote la base', () => {
  const p = P.promptReponsesPretes({ questions: ['Chien ?'], envoye: 'Oui, votre chien est le bienvenu.', existantes: EXISTANTES, bienNom: 'La bulle' })
  assert.match(p, /1\. « Chien \? »/)
  assert.match(p, /Oui, votre chien est le bienvenu\./)
  assert.match(p, /\[1\] Sujet : Animaux\n {4}Texte : Les animaux ne sont pas acceptés\./)
  assert.match(p, /\[2\] Sujet : Parking/)
  assert.doesNotMatch(p, /\b11\b|\b12\b/, 'les identifiants de la base ne partent pas au modèle')
  assert.match(p, /aucun prénom, aucun nom, aucune date/)
  assert.match(p, /N'ajoute AUCUNE information/)
  const vide = P.promptReponsesPretes({ questions: ['Chien ?'], envoye: 'Oui', existantes: [] })
  assert.match(vide, /DÉJÀ ENREGISTRÉES POUR CE LOGEMENT :\n\(aucune\)/)
})

test('jsonDe : le premier objet JSON, même entouré de texte ; null sinon', () => {
  assert.deepEqual(P.jsonDe(modele('Voici :\n{"propositions":[]}\nFin')), { propositions: [] })
  assert.equal(P.jsonDe(modele('pas de json')), null)
  assert.equal(P.jsonDe(modele('{ cassé')), null)
  assert.equal(P.jsonDe({}), null)
})

test('LE TEST QUI COMPTE : une modification vise une réponse MONTRÉE, par son numéro ; id, sujet et « avant » viennent de la base', () => {
  const r = P.propositionsDe({ propositions: [{ question: 1, action: 'modifier', ref: 1, sujet: 'Renommé', texte: 'Les chiens sont acceptés, pas les chats.' }] }, { existantes: EXISTANTES })
  assert.deepEqual(r, [{ action: 'modifier', id: 11, sujet: 'Animaux', avant: 'Les animaux ne sont pas acceptés.', texte: 'Les chiens sont acceptés, pas les chats.' }])
  // Un numéro hors de la liste, ou un identifiant de la base, ne vise rien.
  for (const ref of [0, 3, 11, '1; drop', null, 1.5]) {
    assert.deepEqual(P.propositionsDe({ propositions: [{ action: 'modifier', ref, texte: 'X' }] }, { existantes: EXISTANTES }), [], String(ref))
  }
  assert.deepEqual(P.propositionsDe({ propositions: [{ action: 'modifier', id: 11, texte: 'X' }] }, { existantes: EXISTANTES }), [], 'un id fourni par le modèle n est jamais lu')
  // Même accompagné d'un numéro valide (review 1, constat 8).
  assert.equal(P.propositionsDe({ propositions: [{ action: 'modifier', ref: 1, id: 999, texte: 'Chiens oui.' }] }, { existantes: EXISTANTES })[0].id, 11)
})

test('une création sur un sujet existant devient la modification de cette réponse (le writer refuserait la création)', () => {
  const r = P.propositionsDe({ propositions: [{ action: 'creer', sujet: '  animaux ', texte: 'Chiens acceptés.' }] }, { existantes: EXISTANTES })
  assert.deepEqual(r, [{ action: 'modifier', id: 11, sujet: 'Animaux', avant: 'Les animaux ne sont pas acceptés.', texte: 'Chiens acceptés.' }])
  const neuve = P.propositionsDe({ propositions: [{ action: 'creer', sujet: 'Stationnement moto', texte: 'Pas de moto dans le logement ; garage à 200 m.' }] }, { existantes: EXISTANTES })
  assert.deepEqual(neuve, [{ action: 'creer', sujet: 'Stationnement moto', texte: 'Pas de moto dans le logement ; garage à 200 m.' }])
})

test('LE TEST QUI COMPTE : une proposition qui nomme le voyageur est écartée (prénom ou nom, sans accent ni casse)', () => {
  const noms = ['Anna', 'Lefèvre']
  const brut = { propositions: [
    { action: 'creer', sujet: 'Chien', texte: 'Anna peut venir avec son chien.' },
    { action: 'creer', sujet: 'Moto', texte: 'Pas de moto pour M. LEFEVRE.' },
    { action: 'creer', sujet: 'Annabelle', texte: 'Pas un nom de voyageur : un mot qui le contient.' },
    { action: 'modifier', ref: 2, texte: 'Parking rue Voltaire, comme dit à Anna.' }
  ] }
  const r = P.propositionsDe(brut, { existantes: EXISTANTES, noms })
  assert.deepEqual(r.map(x => x.sujet), ['Annabelle'])
  // Un nom de moins de trois lettres ne filtre rien (il couperait des mots).
  assert.equal(P.propositionsDe({ propositions: [{ action: 'creer', sujet: 'Lit', texte: 'K' }] }, { noms: ['K'] }).length, 1)
})

test('review 1, constat 1 : anonymiser — prénom, nom, chaque partie d un nom composé, sans accent ni casse, mot entier', () => {
  assert.equal(P.anonymiser('Hello Anna! Bonjour ANNA, Annabelle.', ['Anna']), 'Hello [voyageur]! Bonjour [voyageur], Annabelle.')
  assert.equal(P.anonymiser('Cher Jean, M. LEFEVRE et Mme Lefèvre', ['Jean-Pierre', 'Lefèvre']), 'Cher [voyageur], M. [voyageur] et Mme [voyageur]')
  assert.equal(P.anonymiser('Merci Li', ['Li']), 'Merci [voyageur]', 'un nom de deux lettres reste un nom')
  assert.equal(P.anonymiser('Rien à cacher', [null, '', 'X']), 'Rien à cacher')
})

test('LE TEST QUI COMPTE (review 1, constat 2) : une proposition qui porte un code, un lien ou un numéro NEUF est écartée ; un montant reste', () => {
  const brut = { propositions: [
    { action: 'creer', sujet: 'Porte', texte: 'Le code de la porte est 4521.' },
    { action: 'creer', sujet: 'Wifi', texte: 'Le mot de passe est sur https://exemple.fr/wifi' },
    { action: 'creer', sujet: 'Urgence', texte: 'Appelez le 06 12 34 56 78.' },
    { action: 'creer', sujet: 'Contact', texte: 'Écrivez à hote@exemple.fr' },
    { action: 'creer', sujet: 'Caution', texte: 'Une caution de 1500 € est demandée ; arrivée après 16h, parking à 200 m.' },
    { action: 'modifier', ref: 2, texte: 'Parking gratuit rue Voltaire, code du portail 7788.' }
  ] }
  assert.deepEqual(P.propositionsDe(brut, { existantes: EXISTANTES }).map(p => p.sujet), ['Caution'])
  // Un numéro DÉJÀ dans la réponse d'avant n'est pas neuf : la mise à jour passe.
  const avec = [{ id: 30, sujet: 'Portail', texte: 'Code du portail 7788.' }]
  assert.equal(P.propositionsDe({ propositions: [{ action: 'modifier', ref: 1, texte: 'Code du portail 7788 ; refermez-le.' }] }, { existantes: avec }).length, 1)
})

test('review 1, constat 5 : le contrôle du nom — chaque partie d un nom composé ; pour une mise à jour, un mot déjà dans le texte d avant ne compte pas', () => {
  const noms = ['Marie-Claire', 'Hugo']
  assert.deepEqual(P.propositionsDe({ propositions: [{ action: 'creer', sujet: 'Accueil', texte: 'Marie est attendue à 16h.' }] }, { noms }), [])
  const avant = [{ id: 40, sujet: 'Accès', texte: 'Le logement est rue Victor Hugo.' }]
  const r = P.propositionsDe({ propositions: [{ action: 'modifier', ref: 1, texte: 'Le logement est rue Victor Hugo, au 2e étage.' }] }, { existantes: avant, noms })
  assert.equal(r.length, 1)
  assert.deepEqual(P.propositionsDe({ propositions: [{ action: 'creer', sujet: 'Merci', texte: 'Merci [voyageur] !' }] }), [], 'le mot neutre n entre pas dans la base')
})

test('une réponse « Hors IA » : rien ne se crée sous son sujet', () => {
  const r = P.propositionsDe({ propositions: [{ action: 'creer', sujet: 'Code wifi', texte: 'X' }] }, { existantes: EXISTANTES, sujetsReserves: ['code WIFI'] })
  assert.deepEqual(r, [])
})

test('une modification qui ne change rien est écartée ; une seule proposition par réponse visée et par sujet créé ; bornes', () => {
  const brut = { propositions: [
    { action: 'modifier', ref: 2, texte: ' parking gratuit  rue Voltaire. ' },
    { action: 'modifier', ref: 1, texte: 'Chiens acceptés.' },
    { action: 'creer', sujet: 'Animaux', texte: 'Doublon par le sujet.' },
    { action: 'creer', sujet: 'Moto', texte: 'Non.' },
    { action: 'creer', sujet: 'moto', texte: 'Doublon.' },
    { action: 'creer', sujet: 'x'.repeat(P.MAX_SUJET + 1), texte: 'Trop long.' },
    { action: 'creer', sujet: 'Long', texte: 'x'.repeat(P.MAX_TEXTE + 1) },
    { action: 'creer', sujet: '', texte: 'Sans sujet.' },
    { action: 'supprimer', ref: 1 },
    null, 'texte'
  ] }
  const r = P.propositionsDe(brut, { existantes: EXISTANTES })
  assert.deepEqual(r.map(x => [x.action, x.sujet]), [['modifier', 'Animaux'], ['creer', 'Moto']])
  assert.deepEqual(P.propositionsDe({ propositions: [{ action: 'creer', sujet: 'A', texte: 'a' }, { action: 'creer', sujet: 'B', texte: 'b' }] }, { maxPropositions: 1 }).length, 1)
  assert.deepEqual(P.propositionsDe(null), [])
  assert.deepEqual(P.propositionsDe({ propositions: 'non' }), [])
})
