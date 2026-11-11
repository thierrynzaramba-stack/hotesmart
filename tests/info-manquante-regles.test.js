// tests/info-manquante-regles.test.js — les règles de la carte « Information
// manquante » (spec docs/specs/spec-info-manquante-choix.md, étape 1).
//
// Deux modules, une même carte : lib/guestflow/rediger.js (serveur : quelles
// questions, quels choix valent, quel texte part au modèle) et
// shared/info-manquante.js (page : quelle carte montrer, quand « Rédiger » est
// possible, ce qui part au serveur). Les COPIES entre les deux, et avec
// lib/cron-classify.js, sont tenues ici : un écart est un rouge.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const R = require('../lib/guestflow/rediger')
let F
test.before(async () => { F = await import('../shared/info-manquante.js') })

const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const MIN = 60000
const il = (ms) => new Date(Date.now() - ms).toISOString()

const QUESTIONS = ['Puis-je venir avec un chien ?', 'Puis-je garer ma moto dans l’appartement ?']
const tache = (x = {}) => ({
  id: 'ti1', task_type: 'info_unknown', status: 'pending', summary: 'Chien et moto',
  sub_tasks: [
    { question: QUESTIONS[0], summary: 'animal', suggested_reply: 'NOTE INTERNE : demander le poids' },
    { question: QUESTIONS[1], summary: 'moto', suggested_reply: null }
  ],
  ...x
})

// ─── Copies ─────────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : le motif d arret recopie est CELUI du cron, au caractere', () => {
  const m = lire('lib/cron-classify.js').match(/const MOTIF_ARRET = '([^']+)'/)
  assert.ok(m, 'le motif d arret est trouve dans lib/cron-classify.js')
  assert.equal(R.MOTIF_ARRET, m[1])
  assert.ok(R.MOTIFS_SANS_QUESTION.includes(require('../lib/gardes-des-fils').MOTIF_PAUSE))
})

test('les copies du front sont celles du serveur (REPONSES, bornes)', () => {
  assert.deepEqual([...F.REPONSES], R.REPONSES)
  assert.equal(F.MAX_PRECISION, R.MAX_PRECISION)
  assert.equal(F.MAX_BROUILLON, R.MAX_BROUILLON)
})

// ─── Serveur : les questions ────────────────────────────────────────────────

test('questionsDe : les questions d une info manquante ouverte, dans l ordre, sans la note interne', () => {
  assert.deepEqual(R.questionsDe(tache()), QUESTIONS)
})

test('LE TEST QUI COMPTE : pas de carte pour une intervention, une tache close, ni les taches systeme (pause, arret)', () => {
  assert.deepEqual(R.questionsDe(tache({ task_type: 'intervention' })), [], 'decision 1 de Thierry')
  assert.deepEqual(R.questionsDe(tache({ status: 'done' })), [])
  assert.deepEqual(R.questionsDe(tache({ status: 'pending_validation' })), [])
  assert.deepEqual(R.questionsDe(tache({ summary: R.MOTIF_ARRET })), [], 'arret de l agent : sa question est le message entier')
  assert.deepEqual(R.questionsDe(tache({ summary: require('../lib/gardes-des-fils').MOTIF_PAUSE })), [])
  assert.deepEqual(R.questionsDe(null), [])
})

test('LE TEST QUI COMPTE : pas de carte pour une tache de SECOURS du cron (sortie illisible, garde emoji) — copies tenues contre la source', () => {
  const source = lire('lib/cron-classify.js')
  for (const motif of R.SOUS_TACHES_DE_SECOURS) {
    const echappe = motif.replace(/'/g, "\\'")
    assert.ok(source.includes(`summary: '${echappe}'`), `le cron ne pose plus « ${motif} » : la copie est perimee`)
    assert.deepEqual(R.questionsDe(tache({ sub_tasks: [{ question: 'Tout le message du voyageur, avec deux demandes ?', summary: motif }] })), [], motif)
    // Une seule sous-tache de secours suffit, meme a cote de vraies questions.
    assert.deepEqual(R.questionsDe(tache({ sub_tasks: [{ question: QUESTIONS[0], summary: 'animal' }, { question: 'Message entier', summary: motif }] })), [], motif + ' (mixte)')
  }
})

test('LE TEST QUI COMPTE : dans l autre sens — chaque sous-tache « message entier » a texte FIXE du cron est connue ici (review 2, constat 2)', () => {
  // Le cron pose `question: message` (le message ENTIER du voyageur) avec un
  // `summary` fixe : un motif systeme ou un texte de secours. Un texte neuf
  // ajoute au cron sans passer par ici donnerait une carte Oui / Non / Autre
  // sur un paragraphe : il doit rougir.
  const source = lire('lib/cron-classify.js')
  // Sur une ou plusieurs lignes, entre apostrophes ou guillemets doubles
  // (review 3, constat 5). Un `summary` qui n'est ni un motif ni un texte fixe
  // (`classification.reason`, la troisieme voie) ne se reconnait pas : limite
  // ecrite dans la spec.
  const trouves = [...source.matchAll(/question:\s*message,\s*summary:\s*(MOTIF_[A-Z_]+|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)]
  assert.ok(trouves.length >= 3, 'le motif de recherche ne trouve plus les sous-taches du cron')
  for (const m of trouves) {
    if (m[1].startsWith('MOTIF_')) assert.ok(['MOTIF_PAUSE', 'MOTIF_ARRET'].includes(m[1]), m[1] + ' inconnu de lib/guestflow/rediger.js')
    else {
      const texte = m[2] != null ? m[2].replace(/\\'/g, "'") : m[3].replace(/\\"/g, '"')
      assert.ok(R.SOUS_TACHES_DE_SECOURS.includes(texte), `« ${texte} » inconnu de lib/guestflow/rediger.js`)
    }
  }
  // Le motif lui-meme est eprouve : multi-lignes et guillemets doubles.
  const essai = 'sub_tasks: [{ question: message,\n      summary: "Texte de secours neuf", suggested_reply: null }]'
  const vus = [...essai.matchAll(/question:\s*message,\s*summary:\s*(MOTIF_[A-Z_]+|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)]
  assert.equal(vus.length, 1)
  assert.equal(vus[0][3], 'Texte de secours neuf')
})


test('questionsDe : sous-taches absentes, vides ou mal formees ne font pas de question ; bornes tenues', () => {
  assert.deepEqual(R.questionsDe(tache({ sub_tasks: null })), [])
  assert.deepEqual(R.questionsDe(tache({ sub_tasks: [{ question: '   ' }, { question: 42 }, null] })), [])
  const longues = Array.from({ length: 15 }, (_, i) => ({ question: 'Q' + i + 'x'.repeat(600) }))
  const q = R.questionsDe(tache({ sub_tasks: longues }))
  assert.equal(q.length, R.MAX_QUESTIONS)
  assert.ok(q.every(x => x.length <= 500))
})

// ─── Serveur : les choix ────────────────────────────────────────────────────

test('validerChoix : un choix par question, la question RENVOYEE, Autre avec sa precision', () => {
  const v = R.validerChoix([
    { question: QUESTIONS[0], reponse: 'oui' },
    { question: QUESTIONS[1], reponse: 'autre', precision: '  garage a 200 m ' }
  ], QUESTIONS)
  assert.deepEqual(v, { ok: true, choix: [
    { question: QUESTIONS[0], reponse: 'oui', precision: '' },
    { question: QUESTIONS[1], reponse: 'autre', precision: 'garage a 200 m' }
  ] })
})

test('LE TEST QUI COMPTE : des choix pris sur d ANCIENNES questions sont refuses, meme en nombre egal', () => {
  // Le cron a complete la tache entre l affichage et le clic : deux questions
  // neuves remplacent les deux lues par l hote.
  const neuves = ['Le linge est-il fourni ?', 'Y a-t-il une baignoire ?']
  const v = R.validerChoix([
    { question: QUESTIONS[0], reponse: 'oui' }, { question: QUESTIONS[1], reponse: 'non' }
  ], neuves)
  assert.deepEqual(v, { ok: false, erreur: 'questions_changees' })
  // Une question de plus : meme refus, pas « incomplet ».
  assert.equal(R.validerChoix([{ question: QUESTIONS[0], reponse: 'oui' }, { question: QUESTIONS[1], reponse: 'non' }],
    [...QUESTIONS, 'Et le wifi ?']).erreur, 'questions_changees')
})

test('validerChoix : les refus parlent', () => {
  assert.equal(R.validerChoix([], []).erreur, 'aucune_question')
  assert.equal(R.validerChoix('oui', QUESTIONS).erreur, 'choix_incomplets')
  assert.equal(R.validerChoix([{ reponse: 'oui' }, { reponse: 'non' }], QUESTIONS).erreur, 'questions_changees', 'sans question renvoyee')
  assert.equal(R.validerChoix([{ question: QUESTIONS[0], reponse: 'peut-etre' }, { question: QUESTIONS[1], reponse: 'non' }], QUESTIONS).erreur, 'choix_invalide')
  assert.equal(R.validerChoix([{ question: QUESTIONS[0], reponse: 'autre', precision: '  ' }, { question: QUESTIONS[1], reponse: 'non' }], QUESTIONS).erreur, 'precision_requise')
  assert.equal(R.validerChoix([{ question: QUESTIONS[0], reponse: 'autre', precision: 'x'.repeat(301) }, { question: QUESTIONS[1], reponse: 'non' }], QUESTIONS).erreur, 'precision_trop_longue')
})

test('validerBrouillon : vide ou trop long refuse, sinon nettoye', () => {
  assert.equal(R.validerBrouillon('  ').erreur, 'brouillon_vide')
  assert.equal(R.validerBrouillon(null).erreur, 'brouillon_vide')
  assert.equal(R.validerBrouillon('x'.repeat(R.MAX_BROUILLON + 1)).erreur, 'brouillon_trop_long')
  assert.deepEqual(R.validerBrouillon(' oui chien, non moto '), { ok: true, brouillon: 'oui chien, non moto' })
})

// ─── Serveur : le texte envoye au modele, et ce qui en revient ──────────────

test('promptRedaction (choix) : chaque decision de l hote, la langue du voyageur, rien d invente', () => {
  const p = R.promptRedaction({
    guestName: 'Anna', bienNom: 'La bulle', knowledgeText: 'Parking : rue Voltaire', consignes: 'Signer Thierry',
    fil: [{ source: 'guest', message: 'Can I come with my dog?' }, { source: 'auto', message: 'Bienvenue' }],
    choix: [{ question: QUESTIONS[0], reponse: 'oui', precision: '' }, { question: QUESTIONS[1], reponse: 'autre', precision: 'garage a 200 m' }]
  })
  assert.match(p, /langue du voyageur/)
  assert.match(p, /N'invente RIEN/)
  assert.match(p, /Décision de l'hôte : OUI/)
  assert.match(p, /Décision de l'hôte : AUTRE — garage a 200 m/)
  assert.match(p, /\[VOYAGEUR\] Can I come with my dog\?/)
  assert.match(p, /\[MESSAGE AUTOMATIQUE\] Bienvenue/)
  assert.match(p, /Parking : rue Voltaire/)
  assert.match(p, /Signer Thierry/)
  assert.doesNotMatch(p, /BROUILLON/)
})

test('promptRedaction (brouillon) : le sens de l hote garde EXACTEMENT', () => {
  const p = R.promptRedaction({ guestName: 'Anna', fil: [], brouillon: 'oui chien, non moto' })
  assert.match(p, /garde EXACTEMENT son sens/)
  assert.match(p, /BROUILLON DE L'HÔTE :\noui chien, non moto/)
  assert.doesNotMatch(p, /DÉCISIONS DE L'HÔTE/)
})

test('texteDe : le texte seul, sans guillemets autour, borne ; rien d utilisable -> vide', () => {
  assert.equal(R.texteDe({ content: [{ type: 'text', text: '« Bonjour Anna, oui ! »' }] }), 'Bonjour Anna, oui !')
  assert.equal(R.texteDe({ content: [{ type: 'text', text: '"Hello"' }] }), 'Hello')
  assert.equal(R.texteDe({ content: [{ type: 'tool_use' }] }), '')
  assert.equal(R.texteDe(null), '')
  assert.equal(R.texteDe({ content: [{ type: 'text', text: 'x'.repeat(5000) }] }).length, R.MAX_TEXTE)
})

test('le plafond de l hote est le sien : 10 par fil sur 24 h, sous sa propre etiquette', () => {
  assert.equal(R.PLAFOND_REDACTION, 10)
  assert.equal(R.FENETRE_REDACTION_MS, 24 * 3600 * 1000)
  assert.equal(R.FONCTION_IA, 'guestflow_rediger')
  assert.ok(R.PLAFOND_REDACTION > require('../lib/guestflow-garde').PLAFOND_JOUR, 'decision de Thierry : 3 est trop petit')
})

// ─── Front : quelle carte ───────────────────────────────────────────────────

const info = (x = {}) => ({ id: 'ti1', book_id: 'B1', property_id: '209413', created_at: il(30 * MIN), maj: il(20 * MIN), questions: QUESTIONS.slice(), ...x })

test('infoAAfficher : la plus recente des taches servies', () => {
  const a = info({ id: 'ancienne', maj: il(60 * MIN) })
  const b = info({ id: 'recente', maj: il(10 * MIN) })
  assert.equal(F.infoAAfficher([b, a], []).id, 'recente')
  assert.equal(F.infoAAfficher([], []), null)
  assert.equal(F.infoAAfficher(null, null), null)
  assert.equal(F.infoAAfficher([info({ questions: [] })], []), null)
})

test('LE TEST QUI COMPTE : l hote a deja repondu depuis la tache -> pas de carte (le cron ne la clot jamais)', () => {
  const messages = [
    { direction: 'inbound', kind: 'message', sent_at: il(25 * MIN) },
    { direction: 'outbound', kind: 'message', sent_at: il(5 * MIN) }
  ]
  assert.equal(F.infoAAfficher([info()], messages), null)
})

test('un message AUTOMATIQUE (modele) apres la tache ne vaut pas reponse ; un message d avant non plus', () => {
  const messages = [
    { direction: 'outbound', kind: 'message', sent_at: il(40 * MIN) },
    { direction: 'outbound', kind: 'auto', sent_at: il(5 * MIN) },
    { direction: 'inbound', kind: 'message', sent_at: il(2 * MIN) }
  ]
  assert.equal(F.infoAAfficher([info()], messages).id, 'ti1')
})

test('la reponse affichee localement (envoi depuis la carte) retire la carte aussitot', () => {
  const messages = [{ direction: 'outbound', kind: 'message', sent_at: new Date().toISOString(), _local: true }]
  assert.equal(F.infoAAfficher([info()], messages), null)
})

// ─── Front : les choix ──────────────────────────────────────────────────────

test('etatInitial / choisir / preciser / pretARediger : Rediger seulement quand tout est tranche', () => {
  let e = F.etatInitial(info())
  assert.equal(e.tacheId, 'ti1')
  assert.equal(F.pretARediger(e), false)
  e = F.choisir(e, 0, 'oui')
  assert.equal(F.pretARediger(e), false, 'une question sans choix')
  e = F.choisir(e, 1, 'autre')
  assert.equal(F.pretARediger(e), false, 'Autre sans precision')
  e = F.preciser(e, 1, '   ')
  assert.equal(F.pretARediger(e), false)
  e = F.preciser(e, 1, 'garage a 200 m')
  assert.equal(F.pretARediger(e), true)
  assert.equal(F.choisir(e, 0, 'peut-etre'), e, 'un choix inconnu ne change rien')
  assert.equal(F.choisir(e, 9, 'oui'), e)
  assert.equal(F.preciser(e, 1, 'x'.repeat(400)).choix[1].precision.length, F.MAX_PRECISION)
  assert.equal(F.pretARediger(F.etatInitial(null)), false)
})

test('choisir ne mute pas l etat precedent (rendu deterministe)', () => {
  const e0 = F.etatInitial(info())
  const e1 = F.choisir(e0, 0, 'non')
  assert.equal(e0.choix[0].reponse, null)
  assert.equal(e1.choix[0].reponse, 'non')
})

test('LE TEST QUI COMPTE : le corps envoye porte la QUESTION de chaque choix, et le serveur l accepte tel quel', () => {
  let e = F.etatInitial(info())
  e = F.preciser(F.choisir(F.choisir(e, 0, 'oui'), 1, 'autre'), 1, ' garage a 200 m ')
  const corps = F.corpsChoix(e, 'B1')
  assert.deepEqual(corps, {
    action: 'choix', bookingId: 'B1', tacheId: 'ti1',
    choix: [{ question: QUESTIONS[0], reponse: 'oui' }, { question: QUESTIONS[1], reponse: 'autre', precision: 'garage a 200 m' }]
  })
  // Le contrat de bout en bout : ce que la page envoie, le serveur le valide.
  assert.equal(R.validerChoix(corps.choix, R.questionsDe(tache())).ok, true)
})

test('memeCarte : une tache COMPLETEE par le cron (meme id, autres questions) remet l etat a zero', () => {
  const e = F.choisir(F.etatInitial(info()), 0, 'oui')
  assert.equal(F.memeCarte(e, info()), true)
  assert.equal(F.memeCarte(e, info({ questions: ['Le linge est-il fourni ?', QUESTIONS[1]] })), false)
  assert.equal(F.memeCarte(e, info({ id: 'autre' })), false)
  assert.equal(F.memeCarte(null, info()), false)
})

// ─── Front : le bouton « IA » ───────────────────────────────────────────────

test('iaPossible / corpsTexte : seulement avec du texte tape, borne comme au serveur', () => {
  assert.equal(F.iaPossible(''), false)
  assert.equal(F.iaPossible('   '), false)
  assert.equal(F.iaPossible(null), false)
  assert.equal(F.iaPossible('oui chien'), true)
  assert.equal(F.iaPossible('x'.repeat(F.MAX_BROUILLON + 1)), false)
  assert.deepEqual(F.corpsTexte(42, ' oui chien '), { action: 'texte', bookingId: '42', brouillon: 'oui chien' })
  assert.equal(R.validerBrouillon(F.corpsTexte('B1', ' oui chien ').brouillon).ok, true)
})

test('chaque refus du serveur a sa phrase, et une erreur inconnue retombe sur « reessayez »', () => {
  for (const code of ['en_pause', 'garde_ia', 'ia_indisponible', 'deja_traitee', 'questions_changees']) {
    assert.equal(F.cleErreur(code), 'messages.info.erreur.' + code)
  }
  assert.equal(F.cleErreur('sans_question'), 'messages.info.erreur.deja_traitee')
  assert.equal(F.cleErreur('deja_close'), 'messages.info.erreur.deja_traitee')
  assert.equal(F.cleErreur('n importe quoi'), 'messages.info.erreur.autre')
  assert.equal(F.cleErreur(undefined), 'messages.info.erreur.autre')
})

test('chaque cle que le module rend existe dans les trois langues', () => {
  const cles = new Set(['en_pause', 'garde_ia', 'ia_indisponible', 'deja_traitee', 'questions_changees', 'sans_question', 'deja_close', 'inconnue'].map(F.cleErreur))
  for (const lang of ['fr', 'en', 'es']) {
    const dico = JSON.parse(lire(`shared/i18n/${lang}.json`))
    for (const cle of cles) assert.ok(typeof dico[cle] === 'string' && dico[cle].trim(), `${lang} : ${cle}`)
  }
})

test('relireApres : la carte se relit quand la tache a bouge ailleurs, pas sur une panne', () => {
  for (const c of ['deja_traitee', 'sans_question', 'questions_changees', 'deja_close']) assert.equal(F.relireApres(c), true, c)
  for (const c of ['garde_ia', 'ia_indisponible', 'en_pause', undefined]) assert.equal(F.relireApres(c), false, String(c))
})
