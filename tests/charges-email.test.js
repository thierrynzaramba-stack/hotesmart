// tests/charges-email.test.js — lot 5 (§14.24, §7) : une facture reçue par
// e-mail (lib/charges/email.js, et le writer lib/charges.js).
//
// CE QUE CES TESTS DÉFENDENT, dans l'ordre :
//   1. le compte vient de l'adresse RELUE, résolue en base — jamais du POST ;
//   2. une pièce n'entre que si le POST et la relecture la décrivent pareil,
//      et si ses octets font la taille relue ;
//   3. une panne fait rejouer (503), un refus définitif laisse une trace
//      visible de l'hôte, et un rejeu ne double rien ;
//   4. l'adresse range : la lecture IA ne remplace pas son entité.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { baseEnregistreuse, filtre } = require('./outils/base-enregistreuse')
const email = require('../lib/charges/email')

const A = '11111111-1111-4111-8111-111111111111'
const ENT_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const AUTRE_ENT = 'aaaaaaaa-0000-4000-8000-0000000000a9'
const BULLE = 'dddddddd-0000-4000-8000-000000000001'
const OFURO = 'dddddddd-0000-4000-8000-000000000002'
const UUID = '1a825d56-029b-4a41-b8e4-61670463431b'

const pdf = (n = 40000, graine = 'x') => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n - 9, graine)])
const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(n - 8, 1)])

// ─── Une base en mémoire : adresses, logements, charges (index uniques) ──────
function monde () {
  const etat = {
    adresses: [
      { locale: 'la-bulle.k2j9x7q4', user_id: A, entite_id: null, property_uuid: BULLE },
      { locale: 'ofuro-futari.w4n8c1rd', user_id: A, entite_id: null, property_uuid: OFURO },
      { locale: 'thierry-nzaramba.p7x2m9qa', user_id: A, entite_id: ENT_A, property_uuid: null }
    ],
    biens: [{ id: BULLE, user_id: A, archive_le: null }, { id: OFURO, user_id: A, archive_le: null }],
    charges: [],
    panneAdresse: false
  }
  const eqs = (r) => r.filtres.filter(f => f[0] === 'eq')
  const neqs = (r) => r.filtres.filter(f => f[0] === 'neq')
  const passe = (l, r) => eqs(r).every(([, c, v]) => String(l[c]) === String(v)) && neqs(r).every(([, c, v]) => String(l[c]) !== String(v))
  const b = baseEnregistreuse((r) => {
    if (r.table === 'charges_adresses_email') {
      if (etat.panneAdresse) return { data: null, error: { message: 'panne' } }
      return { data: etat.adresses.filter(l => passe(l, r)), error: null }
    }
    if (r.table === 'properties') return { data: etat.biens.filter(l => passe(l, r)), error: null }
    if (r.table === 'charges') {
      if (r.op === 'insert') {
        const x = { cree_le: new Date().toISOString(), groupe_doublon: null, signal: null, tentatives_lecture: 0, ...r.charge }
        const piece = x.justificatif_empreinte && etat.charges.some(c => c.user_id === x.user_id && c.email_uuid === x.email_uuid && c.justificatif_empreinte === x.justificatif_empreinte)
        const sf = x.statut === 'sans_facture' && etat.charges.some(c => c.user_id === x.user_id && c.email_uuid === x.email_uuid && c.statut === 'sans_facture')
        if (piece || sf) return { data: null, error: { code: '23505', message: 'duplicate key' } }
        etat.charges.push(x)
        return { data: [x], error: null }
      }
      if (r.op === 'update') {
        const cibles = etat.charges.filter(l => passe(l, r))
        for (const l of cibles) Object.assign(l, r.charge)
        return { data: cibles, error: null }
      }
      if (r.op === 'select') return { data: etat.charges.filter(l => passe(l, r)), error: null }
    }
    return { data: null, error: null }
  })
  const entites = {
    entiteDuCompte: async (compte, id) => ({ ok: true, entite: id === ENT_A && compte === A ? { id: ENT_A, nom: 'Thierry', archivee_le: null } : null }),
    // La bulle relève de l'entité ; Ofuro n'en a pas.
    entiteDuBien: async (compte, bien) => ({ ok: true, entite: bien === BULLE ? { id: ENT_A } : null }),
    // ⚠ La facture lue désigne une AUTRE entité (son SIRET) : l'adresse doit gagner.
    entitesDuCompte: async () => ({ ok: true, entites: [{ id: ENT_A, nom: 'Thierry', siret: null, archivee_le: null }, { id: AUTRE_ENT, nom: 'SCI Lue', siret: '12345678900011', archivee_le: null }] })
  }
  return { etat, db: b.client, requetes: b.requetes, gestes: b.gestes, entites }
}

// Le faux Brevo : rend les octets d'un jeton, ou un statut.
function brevo (pieces) {
  const appels = []
  const f = async (url, opts) => {
    appels.push({ url, cle: opts && opts.headers && opts.headers['api-key'] })
    const jeton = decodeURIComponent(String(url).split('/inbound/attachments/')[1])
    const p = pieces[jeton]
    if (p === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    if (typeof p === 'number') return { ok: false, status: p, arrayBuffer: async () => new ArrayBuffer(0) }
    return { ok: true, status: 200, arrayBuffer: async () => p.buffer.slice(p.byteOffset, p.byteOffset + p.length) }
  }
  return { f, appels }
}

const piecePost = (nom, type, jeton) => ({ Name: nom, ContentType: type, ContentLength: 999, DownloadToken: jeton })
const pieceRelue = (nom, type, taille) => ({ name: nom, contentType: type, contentLength: taille })

function appel (m, { destinataire = 'la-bulle.k2j9x7q4@reply.hotesmart.fr', post = [], relues, octets = {}, lire, autorise = true, maintenant } = {}) {
  const b = brevo(octets)
  const lectures = []
  const p = email.recevoir(m.db, {
    ref: { recipient: destinataire, sender: 'edf@edf.fr', subject: 'Votre facture', receivedAt: '2026-11-23T15:00:00Z', ...(relues === null ? {} : { attachments: relues === undefined ? [] : relues }) },
    item: { Attachments: post },
    uuid: UUID, expediteur: 'edf@edf.fr', sujet: 'Votre facture', texte: 'Bonjour,\nvotre facture est en ligne.', debut: 1000
  }, {
    cle: 'cle-de-test', fetch: b.f, entites: m.entites,
    lectureAutorisee: async () => autorise,
    lire: lire || (async (x) => { lectures.push(x); return { ok: true, lu: { fournisseur_nom: 'EDF', destinataire_siret: '12345678900011', montant_ttc_cents: 8420, categorie: 'energie', type_document: 'facture' } } }),
    maintenant: maintenant || (() => 2000)
  })
  return p.then(r => ({ r, appels: b.appels, lectures }))
}

test('LE TEST QUI COMPTE : un PDF envoyé à l\'adresse de La bulle entre dans le compte DE L\'ADRESSE, rangé dans le logement et son entité, puis est lu — et la lecture ne remplace PAS l\'entité de l\'adresse', async () => {
  const m = monde()
  const fichier = pdf()
  const { r, appels, lectures } = await appel(m, {
    post: [piecePost('facture.pdf', 'application/pdf', 'jeton-piece-1')],
    relues: [pieceRelue('facture.pdf', 'application/pdf', fichier.length)],
    octets: { 'jeton-piece-1': fichier }
  })
  assert.equal(r.issue, 'recue')
  assert.equal(r.trace.prises, 1)
  assert.equal(r.trace.lues, 1)
  assert.equal(appels.length, 1)
  assert.equal(appels[0].cle, 'cle-de-test')
  assert.equal(m.etat.charges.length, 1)
  const c = m.etat.charges[0]
  assert.equal(c.user_id, A)
  assert.equal(c.origine, 'email')
  assert.equal(c.email_uuid, UUID)
  assert.equal(c.email_expediteur, 'edf@edf.fr')
  assert.equal(c.email_sujet, 'Votre facture')
  assert.equal(c.bien_id, BULLE)
  assert.equal(c.statut, 'a_verifier', 'lue à l\'arrivée')
  assert.equal(c.entite_juridique_id, ENT_A, '⚠ l\'adresse range : la facture lue désignait une autre entité')
  assert.equal(c.montant_ttc_cents, 8420)
  assert.equal(c.justificatif_empreinte, crypto.createHash('sha256').update(fichier).digest('hex'))
  assert.ok(c.justificatif_chemin.startsWith(A + '/'), 'le fichier sous le compte de l\'adresse')
  const depot = m.gestes.find(g => g.nom === 'upload')
  assert.equal(depot.args[0], c.justificatif_chemin)
  assert.equal(lectures.length, 1)
  assert.equal(lectures[0].compte, A)
  // Chaque écriture de `charges` porte le compte.
  for (const q of m.requetes.filter(x => x.table === 'charges')) {
    if (q.op === 'insert') assert.equal(q.charge.user_id, A)
    else assert.equal(filtre(q, 'user_id'), A, `${q.op} filtré sur le compte`)
  }
  assert.equal(m.etat.charges.filter(x => x.statut === 'sans_facture').length, 0)
})

test('un logement SANS entité : la facture entre, rangée dans le logement, entité vide — le rappel, pas une entité devinée', async () => {
  const m = monde()
  const fichier = pdf()
  const { r } = await appel(m, {
    destinataire: 'ofuro-futari.w4n8c1rd@reply.hotesmart.fr',
    post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')],
    relues: [pieceRelue('f.pdf', 'application/pdf', fichier.length)],
    octets: { 'jeton-piece-1': fichier }
  })
  assert.equal(r.trace.rappel_entite, true)
  assert.equal(m.etat.charges[0].bien_id, OFURO)
  assert.equal(m.etat.charges[0].entite_juridique_id, null)
})

test('une adresse d\'ENTITÉ : la facture est rangée dans l\'entité, sans logement', async () => {
  const m = monde()
  const fichier = pdf()
  await appel(m, {
    destinataire: 'Thierry <thierry-nzaramba.p7x2m9qa@reply.hotesmart.fr>',
    post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')],
    relues: [pieceRelue('f.pdf', 'application/pdf', fichier.length)],
    octets: { 'jeton-piece-1': fichier }
  })
  assert.deepEqual([m.etat.charges[0].entite_juridique_id, m.etat.charges[0].bien_id], [ENT_A, null])
})

test('un logo de signature (petite image) est ignoré ; le PDF est pris ; aucune ligne « sans facture »', async () => {
  const m = monde()
  const fichier = pdf(20000)
  const logo = png(5000)
  const { r, appels } = await appel(m, {
    post: [piecePost('logo.png', 'image/png', 'jeton-logo-1'), piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')],
    relues: [pieceRelue('logo.png', 'image/png', logo.length), pieceRelue('f.pdf', 'application/pdf', fichier.length)],
    octets: { 'jeton-logo-1': logo, 'jeton-piece-1': fichier }
  })
  assert.equal(r.trace.ignorees, 1)
  assert.equal(r.trace.prises, 1)
  assert.equal(appels.length, 1, 'le logo n\'est même pas téléchargé')
  assert.equal(m.etat.charges.filter(x => x.statut === 'sans_facture').length, 0)
  assert.ok(pdf(20000).length < email.IMAGE_MIN_OCTETS, 'un PDF plus petit que le seuil des images est pris')
})

test('LE TEST QUI COMPTE : un e-mail sans pièce lisible laisse UNE ligne « sans facture lisible » avec l\'expéditeur, le sujet et le texte (retours à la ligne gardés)', async () => {
  for (const cas of [{ post: [], relues: [] }, { post: [piecePost('logo.png', 'image/png', 'jeton-logo-1')], relues: [pieceRelue('logo.png', 'image/png', 4000)] }]) {
    const m = monde()
    const { r, appels } = await appel(m, cas)
    assert.equal(r.issue, 'recue')
    assert.equal(appels.length, 0)
    assert.equal(m.etat.charges.length, 1)
    const s = m.etat.charges[0]
    assert.deepEqual([s.statut, s.motif, s.origine, s.user_id, s.bien_id], ['sans_facture', 'sans_piece', 'email', A, BULLE])
    assert.equal(s.email_expediteur, 'edf@edf.fr')
    assert.equal(s.email_sujet, 'Votre facture')
    assert.equal(s.email_texte, 'Bonjour,\nvotre facture est en ligne.')
    assert.equal(s.jour, '2026-11-23')
  }
})

test('⚠ la RELECTURE fait foi : sans liste relue, ou une liste qui ne dit pas la même chose, rien n\'est téléchargé — et l\'hôte le voit', async () => {
  const cas = [
    ['relecture_incomplete', { post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')], relues: null }],
    ['relecture_incomplete', { post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')], relues: [{ name: 'f.pdf', contentType: 'application/pdf' }] }],
    ['pieces_divergentes', { post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')], relues: [] }],
    ['pieces_divergentes', { post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')], relues: [pieceRelue('autre.pdf', 'application/pdf', 40000)] }],
    ['pieces_divergentes', { post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')], relues: [pieceRelue('f.pdf', 'image/jpeg', 40000)] }],
    ['pieces_divergentes', { post: [{ ...piecePost('f.pdf', 'application/pdf', 'jeton-piece-1'), ContentID: 'a' }], relues: [{ ...pieceRelue('f.pdf', 'application/pdf', 40000), contentId: 'b' }] }]
  ]
  for (const [motif, c] of cas) {
    const m = monde()
    const { r, appels } = await appel(m, { ...c, octets: { 'jeton-piece-1': pdf() } })
    assert.equal(appels.length, 0, motif)
    assert.deepEqual(m.etat.charges.map(x => [x.statut, x.motif]), [['sans_facture', motif]], JSON.stringify(c.relues))
    assert.deepEqual(r.trace.refusees, [motif])
  }
})

test('⚠ des octets qui ne font pas la taille RELUE n\'entrent pas — refus définitif, tracé ; aucun fichier au bucket', async () => {
  const m = monde()
  const fichier = pdf()
  const { r } = await appel(m, {
    post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')],
    relues: [pieceRelue('f.pdf', 'application/pdf', fichier.length + 1)],
    octets: { 'jeton-piece-1': fichier }
  })
  assert.equal(r.issue, 'recue')
  assert.deepEqual(m.etat.charges.map(x => [x.statut, x.motif]), [['sans_facture', 'taille_differente']])
  assert.equal(m.gestes.filter(g => g.nom === 'upload').length, 0)
})

test('une PANNE chez Brevo (5xx, 429, réseau) fait REJOUER : rien de tracé ; un 404 est définitif et se trace', async () => {
  for (const statut of [500, 503, 429]) {
    const m = monde()
    const { r } = await appel(m, {
      post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')],
      relues: [pieceRelue('f.pdf', 'application/pdf', 40000)],
      octets: { 'jeton-piece-1': statut }
    })
    assert.equal(r.rejouer, true, String(statut))
    assert.equal(m.etat.charges.length, 0)
  }
  const m = monde()
  const b = { f: async () => { throw new Error('socket hang up') } }
  const r = await email.recevoir(m.db, {
    ref: { recipient: 'la-bulle.k2j9x7q4@reply.hotesmart.fr', attachments: [pieceRelue('f.pdf', 'application/pdf', 40000)] },
    item: { Attachments: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')] }, uuid: UUID, debut: 1000
  }, { cle: 'k', fetch: b.f, entites: m.entites, maintenant: () => 2000 })
  assert.equal(r.rejouer, true)
  const m404 = monde()
  const { r: r404 } = await appel(m404, {
    post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')],
    relues: [pieceRelue('f.pdf', 'application/pdf', 40000)],
    octets: {}
  })
  assert.equal(r404.issue, 'recue')
  assert.deepEqual(m404.etat.charges.map(x => [x.statut, x.motif]), [['sans_facture', 'piece_introuvable']])
})

test('LE TEST QUI COMPTE : un REJEU du même e-mail ne crée rien — la pièce déjà entrée est reconnue, le fichier posé pour rien est effacé', async () => {
  const m = monde()
  const fichier = pdf()
  const o = {
    post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')],
    relues: [pieceRelue('f.pdf', 'application/pdf', fichier.length)],
    octets: { 'jeton-piece-1': fichier }
  }
  await appel(m, o)
  const { r } = await appel(m, o)
  assert.deepEqual([r.trace.prises, r.trace.deja], [0, 1])
  assert.equal(m.etat.charges.length, 1)
  const poses = m.gestes.filter(g => g.nom === 'upload').map(g => g.args[0])
  const effaces = m.gestes.filter(g => g.nom === 'remove').flatMap(g => g.args[0])
  assert.equal(poses.length, 2)
  assert.deepEqual(effaces, [poses[1]], 'seul le second fichier est effacé')
  // Un e-mail sans pièce rejoué : une seule ligne.
  const m2 = monde()
  await appel(m2, {})
  await appel(m2, {})
  assert.equal(m2.etat.charges.length, 1)
})

test('une adresse inconnue, changée ou d\'un logement archivé : rien n\'est écrit, rien n\'est rejoué ; une panne de lecture de l\'adresse se rejoue', async () => {
  const m = monde()
  const { r } = await appel(m, { destinataire: 'la-bulle.zzzzzzzz@reply.hotesmart.fr', post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')], relues: [pieceRelue('f.pdf', 'application/pdf', 40000)], octets: { 'jeton-piece-1': pdf() } })
  assert.deepEqual([r.issue, r.trace.raison], ['adresse_refusee', 'adresse_inconnue'])
  assert.equal(m.etat.charges.length, 0)
  m.etat.biens[0].archive_le = '2026-11-23T00:00:00Z'
  const { r: r2, appels } = await appel(m, { post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')], relues: [pieceRelue('f.pdf', 'application/pdf', 40000)], octets: { 'jeton-piece-1': pdf() } })
  assert.deepEqual([r2.issue, r2.trace.raison], ['adresse_refusee', 'bien_archive'])
  assert.equal(appels.length, 0)
  m.etat.panneAdresse = true
  const { r: r3 } = await appel(m, {})
  assert.equal(r3.rejouer, true)
  assert.equal(m.etat.charges.length, 0)
})

test('au plus 10 pièces prises ; la 11e est refusée en le disant', async () => {
  const m = monde()
  const post = []
  const relues = []
  const octets = {}
  for (let i = 0; i < 11; i++) {
    const f = pdf(40000, String(i))
    post.push(piecePost(`f${i}.pdf`, 'application/pdf', `jeton-piece-${i}`))
    relues.push(pieceRelue(`f${i}.pdf`, 'application/pdf', f.length))
    octets[`jeton-piece-${i}`] = f
  }
  const { r, appels } = await appel(m, { post, relues, octets })
  assert.equal(appels.length, 10)
  assert.equal(r.trace.prises, 10)
  assert.deepEqual(m.etat.charges.filter(x => x.statut === 'sans_facture').map(x => x.motif), ['trop_de_pieces'])
})

test('le jeton de téléchargement vient du POST : contrôlé (sinon refusé, sans appel) puis ENCODÉ dans l\'URL', async () => {
  const m = monde()
  const { appels } = await appel(m, { post: [piecePost('f.pdf', 'application/pdf', '../../events/x')], relues: [pieceRelue('f.pdf', 'application/pdf', 40000)] })
  assert.equal(appels.length, 0)
  assert.deepEqual(m.etat.charges.map(x => x.motif), ['jeton_piece_invalide'])
  const m2 = monde()
  const f = pdf()
  const { appels: a2 } = await appel(m2, { post: [piecePost('f.pdf', 'application/pdf', 'abc.DEF_123~x')], relues: [pieceRelue('f.pdf', 'application/pdf', f.length)], octets: { 'abc.DEF_123~x': f } })
  assert.equal(a2[0].url, 'https://api.brevo.com/v3/inbound/attachments/abc.DEF_123~x')
})

test('un type que la relecture annonce lisible mais qui n\'en est pas un (le CONTENU fait foi) : refusé et tracé', async () => {
  const m = monde()
  const faux = Buffer.alloc(40000, 7)
  await appel(m, { post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')], relues: [pieceRelue('f.pdf', 'application/pdf', faux.length)], octets: { 'jeton-piece-1': faux } })
  assert.deepEqual(m.etat.charges.map(x => [x.statut, x.motif]), [['sans_facture', 'type_refuse']])
  assert.equal(m.gestes.filter(g => g.nom === 'upload').length, 0)
})

test('la lecture à l\'arrivée a un budget : passé 30 s, la facture reste « à lire » (le cron la relira) ; au plafond, rien n\'est lu ; une panne IA n\'est pas un échec', async () => {
  const fichier = pdf()
  const base = { post: [piecePost('f.pdf', 'application/pdf', 'jeton-piece-1')], relues: [pieceRelue('f.pdf', 'application/pdf', fichier.length)], octets: { 'jeton-piece-1': fichier } }
  let t = 2000
  const m = monde()
  const { r, lectures } = await appel(m, { ...base, maintenant: () => (t += 16000) })
  assert.equal(lectures.length, 0)
  assert.equal(r.trace.lues, 0)
  assert.equal(m.etat.charges[0].statut, 'a_lire')

  const m2 = monde()
  const { lectures: l2 } = await appel(m2, { ...base, autorise: false })
  assert.equal(l2.length, 0)
  assert.deepEqual([m2.etat.charges[0].statut, m2.etat.charges[0].motif], ['a_lire', 'plafond_ia'])

  const m3 = monde()
  const { r: r3 } = await appel(m3, { ...base, lire: async () => ({ panne: true, motif: 'surcharge' }) })
  assert.equal(r3.issue, 'recue', 'une panne de lecture ne fait pas rejouer : la facture est entrée')
  assert.deepEqual([m3.etat.charges[0].statut, m3.etat.charges[0].motif, m3.etat.charges[0].tentatives_lecture], ['a_lire', 'panne_ia', 0])
})

test('les téléchargements ont un budget : passé 35 s, on fait rejouer plutôt que de laisser Vercel couper', async () => {
  const m = monde()
  const fichier = pdf()
  let t = 1000
  const { r } = await appel(m, {
    post: [piecePost('a.pdf', 'application/pdf', 'jeton-piece-1'), piecePost('b.pdf', 'application/pdf', 'jeton-piece-2')],
    relues: [pieceRelue('a.pdf', 'application/pdf', fichier.length), pieceRelue('b.pdf', 'application/pdf', fichier.length)],
    octets: { 'jeton-piece-1': fichier, 'jeton-piece-2': pdf(40000, 'y') },
    maintenant: () => (t += 20000)
  })
  assert.equal(r.rejouer, true)
  assert.equal(r.raison, 'delai')
})
