// tests/avis-cartes.test.js — une carte par sejour pour tous les avis (recette
// de Thierry du 7 octobre 2026, points A a E) : l'assemblage pur
// (lib/avis/cartes.js) et l'origine de notre avis (lib/avis/origine.js).
// `maintenant` est injecte : dates figees, aucune horloge lue.

const test = require('node:test')
const assert = require('node:assert/strict')
const { assemblerCartes, origineDe } = require('../lib/avis/cartes')
const { origineALaPublication, ecrireAvecOrigine } = require('../lib/avis/origine')

const MAINTENANT = Date.parse('2026-10-08T12:00:00Z')
const ev = (uid, extra = {}) => ({ id: `e-${uid}`, booking_uid: uid, property_id: 'P1', property_id_ref: 'R1', ota: 'airbnb', status: 'a_remplir', deadline_at: '2026-10-15T12:00:00Z', published_at: null, public_text: null, ota_review_id: null, created_at: '2026-10-01T10:00:00Z', ...extra })
const av = (id, extra = {}) => ({ id, provider: 'channex', ota: 'airbnb', source: null, content: 'Très bien', content_public: 'Très bien', overall_score: 10, received_at: '2026-10-05T10:00:00Z', ai_clean_verdict: 'positif', ai_clean_excerpt: null, ai_analyzed_at: '2026-10-05T11:00:00Z', property_id_ref: 'R1', statut: 'confirme', verdict_source: null, booking_uid: null, stay_start: null, stay_end: null, guest_name: 'Sam Lee', cache: false, ...extra })
const sejours = new Map([
  ['u1', { voyageur: { prenom: 'Angela', nom: 'X' }, arrivee: '2026-10-01', depart: '2026-10-03', menagePar: 'Regina' }],
  ['u2', { voyageur: { prenom: 'Guillem', nom: 'C' }, arrivee: '2026-09-21', depart: '2026-09-22' }],
  ['u3', { voyageur: { prenom: 'Mickaël', nom: 'M' }, arrivee: '2026-08-01', depart: '2026-08-03' }],
])
const nomBien = (id, ref) => (id === 'P1' || ref === 'R1' ? 'La bulle' : null)
const assembler = (o) => assemblerCartes({ sejours, nomBien, voitSejours: true, maintenant: MAINTENANT, ...o })

test('LE TEST QUI COMPTE (point A) : un sejour = UNE carte — son avis et notre evaluation reunis, par la reservation ou par l objet de l OTA', () => {
  const r = assembler({
    evaluations: [ev('u1', { ota_review_id: 'a1' }), ev('u2', { status: 'publiee', published_at: '2026-09-25T10:00:00Z', public_text: 'Merci' })],
    avis: [av('a1', { booking_uid: null }), av('a2', { booking_uid: 'u2', received_at: '2026-09-26T10:00:00Z' })],
  })
  const toutes = [...r.attente, ...r.recents, ...r.anciens]
  assert.equal(toutes.length, 2)
  const c1 = toutes.find(c => c.cle === 'sejour:u1')
  assert.deepEqual(c1.avis.map(a => a.id), ['a1'], 'rattache par ota_review_id')
  assert.equal(c1.bien, 'La bulle')
  assert.equal(c1.menage_par, 'Regina')
  assert.deepEqual(c1.voyageur, { prenom: 'Angela', nom: 'X' })
  const c2 = toutes.find(c => c.cle === 'sejour:u2')
  assert.deepEqual(c2.avis.map(a => a.id), ['a2'], 'rattache par la reservation')
  assert.equal(c2.evaluation.texte, 'Merci')
})

test('LE TEST QUI COMPTE (point C) : trois sections — en attente triee par delai, recents sur 20 jours, anciens ; un hors delai passe « expiree » dans Anciens', () => {
  const r = assembler({
    evaluations: [
      ev('u1', { deadline_at: '2026-10-20T12:00:00Z' }),
      ev('u2', { deadline_at: '2026-10-10T12:00:00Z' }),
      ev('u3', { deadline_at: '2026-10-04T12:00:00Z' }), // hors delai
    ],
    avis: [av('vieux', { booking_uid: null, received_at: '2026-08-01T10:00:00Z' }), av('frais', { booking_uid: null, received_at: '2026-10-01T10:00:00Z' })],
  })
  assert.deepEqual(r.attente.map(c => c.cle), ['sejour:u2', 'sejour:u1'], 'le delai le plus court d abord')
  assert.deepEqual(r.attente.map(c => c.evaluation.jours_restants), [2, 12])
  const u3 = r.anciens.find(c => c.cle === 'sejour:u3')
  assert.equal(u3.evaluation.etat, 'expiree')
  assert.equal(u3.evaluation.evaluable, false)
  assert.deepEqual(r.recents.map(c => c.cle), ['avis:frais'])
  assert.ok(r.anciens.some(c => c.cle === 'avis:vieux'))
  assert.equal(r.attente.length, 2, 'le hors delai sort du compteur « vous attendent »')
})

test('LE TEST QUI COMPTE (point E) : un avis MASQUE par Airbnb se montre comme tel — jamais 0/10, ni texte ni classement', () => {
  const r = assembler({ evaluations: [ev('u1', { ota_review_id: 'm' })], avis: [av('m', { cache: true, overall_score: 0, content: null, content_public: null, ai_clean_verdict: 'rien_signale' })] })
  const a = r.attente[0].avis[0]
  // ⚠ `note_sur_5` ET PLUS `note` : la note descend convertie et arrondie une
  // seule fois (decision de Thierry du 20 octobre 2026, « plus aucun /10
  // affiche »). Un champ sur 10 qui subsisterait inviterait l'ecran a le
  // reconvertir.
  assert.deepEqual(
    { masque: a.masque, note_sur_5: a.note_sur_5, texte: a.texte, verdict: a.verdict },
    { masque: true, note_sur_5: null, texte: null, verdict: null })
  assert.equal(a.note, undefined, 'le champ sur 10 ne descend plus : il invitait a reconvertir')
  // Un champ absent n'est pas « visible » (lecture stricte du brut).
  assert.equal(assembler({ avis: [av('x', { cache: undefined })] }).recents[0].avis[0].masque, true)
  // Booking et la saisie manuelle n'ont pas de double aveugle.
  assert.equal(assembler({ avis: [av('b', { ota: 'booking', provider: 'beds24', cache: undefined })] }).recents[0].avis[0].masque, false)
})

test('SECURITE : sans le droit `reservations`, une carte d avis seul ne dit ni le voyageur ni les dates du sejour — ni la date qui la range', () => {
  const avis = [av('a', { booking_uid: 'u1', guest_name: 'Angela X', stay_start: '2026-10-01', stay_end: '2026-10-03' })]
  const sans = assemblerCartes({ avis, sejours, nomBien, voitSejours: false, maintenant: MAINTENANT })
  const c = sans.recents[0]
  assert.equal(c.voyageur, null)
  assert.equal(c.arrivee, null)
  assert.equal(c.depart, null)
  assert.equal(c.date_ref, '2026-10-05', 'la date de reception, pas la fin du sejour')
  assert.equal(c.menage_par, null, 'ni la prestataire du sejour (revue de ed445b2)')
  assert.equal(c.cle, 'avis:a', 'ni l identifiant de la reservation dans la cle')
  assert.ok(!JSON.stringify(sans).includes('2026-10-03'), 'la fin du sejour ne sort nulle part')
  // Une carte qui porte une evaluation garde l'identite : on evalue quelqu'un.
  const avec = assemblerCartes({ evaluations: [ev('u1')], avis, sejours, nomBien, voitSejours: false, maintenant: MAINTENANT })
  const carteEval = [...avec.attente, ...avec.recents, ...avec.anciens].find(c => c.evaluation)
  assert.deepEqual(carteEval.voyageur, { prenom: 'Angela', nom: 'X' })
})

test('point B : l origine de notre avis — enregistree, deduite du statut, ou « rédigé par l IA » seul', () => {
  assert.equal(origineDe({ status: 'publiee', origine_texte: 'humain' }).libelle, 'écrit par vous')
  assert.equal(origineDe({ status: 'publiee', origine_texte: 'ia_valide' }).libelle, 'rédigé par l’IA, validé par vous')
  assert.equal(origineDe({ status: 'publiee', origine_texte: 'ia_auto' }).libelle, 'rédigé par l’IA, publié automatiquement')
  assert.equal(origineDe({ status: 'evaluee_ailleurs' }).libelle, 'évalué directement sur Airbnb')
  assert.equal(origineDe({ status: 'publiee' }).libelle, 'rédigé par l’IA', 'publiee avant la colonne : ce qu on sait seulement')
  assert.equal(origineDe({ status: 'a_remplir' }), null)
})

test('point B : l origine se decide a la publication — auto, texte de l IA tel quel, ou texte de l hote', () => {
  assert.equal(origineALaPublication({ auto: true, texteEnBase: 'IA' }), 'ia_auto')
  assert.equal(origineALaPublication({ texteEnvoye: 'IA ', texteEnBase: 'IA' }), 'ia_valide', 'le meme texte, aux espaces pres')
  assert.equal(origineALaPublication({ texteEnvoye: null, texteEnBase: 'IA' }), 'ia_valide')
  assert.equal(origineALaPublication({ texteEnvoye: 'Le mien', texteEnBase: 'IA' }), 'humain')
  assert.equal(origineALaPublication({ texteEnvoye: 'Le mien', texteEnBase: null }), 'humain')
})

test('point B : une base sans la colonne (migration en retard) — l ecriture est REJOUEE sans elle, jamais perdue', async () => {
  const vus = []
  const r = await ecrireAvecOrigine(async (maj) => {
    vus.push(maj)
    return 'origine_texte' in maj ? { error: { message: 'column guest_evaluations.origine_texte does not exist' } } : { error: null }
  }, { status: 'publiee', origine_texte: 'ia_valide' })
  assert.equal(r.error, null)
  assert.deepEqual(vus, [{ status: 'publiee', origine_texte: 'ia_valide' }, { status: 'publiee' }])
  // Une autre erreur ne se rejoue pas : elle remonte.
  const autre = await ecrireAvecOrigine(async () => ({ error: { message: 'connexion perdue' } }), { status: 'publiee', origine_texte: 'humain' })
  assert.equal(autre.error.message, 'connexion perdue')
})

test('maintenant est obligatoire : la section depend du jour, jamais d une horloge lue en douce', () => {
  assert.throws(() => assemblerCartes({}), /maintenant requis/)
})

test('revue de ed445b2 : un delai depasse de quelques heures est PASSE (jamais -0 jour) ; un echec de publication passe devant tout et n expire pas', () => {
  const r = assembler({ evaluations: [
    ev('u1', { deadline_at: new Date(MAINTENANT - 3 * 3600000).toISOString() }),
    ev('u2', { deadline_at: '2026-10-20T12:00:00Z' }),
    ev('u3', { status: 'echec_publication', deadline_at: '2026-10-07T12:00:00Z' }),
  ] })
  assert.equal(r.anciens.find(c => c.cle === 'sejour:u1').evaluation.etat, 'expiree')
  assert.deepEqual(r.attente.map(c => c.cle), ['sejour:u3', 'sejour:u2'])
  const reste = assembler({ evaluations: [ev('u1', { deadline_at: new Date(MAINTENANT + 3 * 3600000).toISOString() })] })
  assert.equal(reste.attente[0].evaluation.jours_restants, 1, 'quelques heures restantes : 1 (l ecran dit « dernier jour »)')
})

test('revue de ed445b2 : le lien explicite de l evaluation passe avant la reservation de l avis', () => {
  const r = assembler({ evaluations: [ev('u1', { ota_review_id: 'a1' })], avis: [av('a1', { booking_uid: 'autre-uid' })] })
  const toutes = [...r.attente, ...r.recents, ...r.anciens]
  assert.equal(toutes.length, 1)
  assert.deepEqual(toutes[0].avis.map(a => a.id), ['a1'])
})

test('revue de ed445b2 : une prestataire qui publie est dite telle', () => {
  assert.equal(origineALaPublication({ prestataire: true, texteEnBase: 'IA' }), 'ia_presta')
  assert.equal(origineDe({ status: 'publiee', origine_texte: 'ia_presta' }).libelle, 'rédigé par l’IA, validé par la prestataire')
})

test('LE TEST QUI COMPTE (regle de Thierry du 9 octobre 2026, vecu Julien Darmon) : l avis du voyageur VISIBLE et le notre non publie — « expiree », sans bouton, hors « En attente »', () => {
  // Echeance a 5 jours (l'ancienne echeance Channex), mais l'avis est lisible.
  const r = assembler({ evaluations: [ev('u1', { ota_review_id: 'a1', deadline_at: '2026-10-13T12:00:00Z' })], avis: [av('a1', { cache: false, overall_score: 10 })] })
  assert.equal(r.attente.length, 0)
  const c = r.anciens.find(x => x.cle === 'sejour:u1')
  assert.equal(c.evaluation.etat, 'expiree')
  assert.equal(c.evaluation.evaluable, false)
  // Un objet vide et non cache (ni note ni texte) ne prouve rien : en attente.
  const vide = assembler({ evaluations: [ev('u1', { ota_review_id: 'a1', deadline_at: '2026-10-13T12:00:00Z' })], avis: [av('a1', { cache: false, overall_score: 0, content: null, content_public: null })] })
  assert.equal(vide.attente.length, 1)
  // Masque : toujours en attente.
  const m = assembler({ evaluations: [ev('u1', { ota_review_id: 'a1', deadline_at: '2026-10-13T12:00:00Z' })], avis: [av('a1', { cache: true, overall_score: 0, content: null, content_public: null })] })
  assert.equal(m.attente.length, 1)
  // Publiee : rien ne change (notre avis est parti).
  const p = assembler({ evaluations: [ev('u1', { ota_review_id: 'a1', status: 'publiee', published_at: '2026-10-01T10:00:00Z', public_text: 'Merci' })], avis: [av('a1', { cache: false })] })
  assert.equal([...p.recents, ...p.anciens][0].evaluation.etat, 'publiee')
})

// ═══════════════════════════════════════════════════════════════════════════
// Les constats de la revue de aec053c
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE (MOYEN-1) : un avis SANS NOTE rend `null`, jamais `NaN` ni zero', () => {
  // `arrondiDixiemes(NaN, 1)` rend `NaN`, et ca touchait TOUT avis sans note
  // exploitable : saisie manuelle, detection de message, avis Booking sans
  // score, note hors echelle. L'ecran s'en sortait par accident — `JSON.stringify`
  // serialise `NaN` en `null` — mais compose sans passer par JSON,
  // `core/avis/cartes.js` teste `note_sur_5 != null`, VRAI pour `NaN`, et ecrit
  // « NaN / 5 ». Et la mutation `?? 0` restait verte sur toute la suite, en
  // affichant « 0,0 / 5 » : le defaut « jamais 0/10 », par l'autre porte.
  const cas = [
    ['saisie manuelle', av('m', { provider: 'manuel', ota: 'direct', overall_score: null })],
    ['note absente', av('n', { overall_score: null })],
    ['note a zero', av('z', { overall_score: 0 })],
    ['note hors echelle', av('h', { ota: 'une-source-sur-100', overall_score: 90 })],
    ['note illisible', av('i', { overall_score: 'bien' })]
  ]
  for (const [quoi, ligne] of cas) {
    const a = assembler({ avis: [ligne] }).recents[0].avis[0]
    assert.equal(a.note_sur_5, null, `${quoi} : note_sur_5 doit etre null`)
    assert.ok(!Number.isNaN(a.note_sur_5), `${quoi} : jamais NaN`)
    assert.notEqual(a.note_sur_5, 0, `${quoi} : jamais zero`)
  }
  // Contre-epreuve : une vraie note descend bien, convertie sur 5.
  assert.equal(assembler({ avis: [av('ok', { overall_score: 9 })] }).recents[0].avis[0].note_sur_5, 4.5)
})

test('LE TEST QUI COMPTE (MOYEN-3) : un avis dont le texte ne vit que dans `content_public` garde sa carte', () => {
  // Le writer Channex pose `content: at.content || null` (le champ plat) et
  // `content_public` depuis `raw_content.public_review`. Un avis Airbnb dont le
  // texte public ne vit que dans le brut a donc `content = NULL` et
  // `content_public` rempli : le lire seul par `content` l'aurait fait passer
  // pour un objet vide — carte perdue, mais toujours compte dans la tuile.
  const r = assembler({ avis: [av('pub', { overall_score: null, content: null, content_public: 'Tout etait parfait' })] })
  assert.deepEqual(r.recents.flatMap(c => c.avis.map(x => x.id)), ['pub'])
  assert.equal(r.recents[0].avis[0].texte, 'Tout etait parfait')
  // Et sans NI l'un NI l'autre, c'est bien un objet vide : pas de carte.
  const vide = assembler({ avis: [av('vide', { overall_score: null, content: null, content_public: null })] })
  assert.deepEqual([...vide.attente, ...vide.recents, ...vide.anciens], [])
})
