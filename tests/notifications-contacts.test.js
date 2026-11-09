// tests/notifications-contacts.test.js — les contacts libres (PWA lot 2c-3, étape 1).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §16.3, Q25, Q29 à Q32 · KB : docs/kb/pwa.md §12
//
// Ce que ce fichier prouve, en APPELANT les modules (REVIEW.md règle 20) :
//   1. qui est contact pour quoi : les urgences (b, j, l, m, o) et/ou l'info
//      manquante (c), sur SES biens, sur SON compte, jamais désinscrit ;
//   2. l'envoi : e-mail sans lien vers l'application mais avec la
//      désinscription, SMS sans lire d'appareil, jamais de notification ;
//   3. les heures et la langue du TITULAIRE — pas ses canaux ;
//   4. la file : une ligne par contact et par sujet, relue à la sortie ;
//   5. l'essai sur soi n'atteint jamais un contact.
//
// ⚠ TOUS LES INSTANTS SONT FIGÉS ET INJECTÉS.

const test = require('node:test')
const assert = require('node:assert/strict')

const contacts = require('../lib/notifications/contacts')
const { envoyerMaintenant } = require('../lib/notifications/envoi')
const { notifier } = require('../lib/notifications/notifier')
const file = require('../lib/notifications/file')
const textes = require('../lib/notifications/textes')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const AUTRE = '33333333-3333-4333-8333-333333333333'
const BIEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BIEN_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const hiver = (jourHeure) => Date.parse(`${jourHeure}:00+01:00`)
const MIDI = hiver('2026-11-11T12:00')
const NUIT = hiver('2026-11-11T00:30')

// ─── Une base factice qui applique VRAIMENT ses filtres ─────────────────────
// (eq, in, is, contains, lte, order, limit) : un double plus permissif que la
// base validerait du code qui ne tourne pas (REVIEW.md règle 22).
function base (tables = {}, { pannes = [] } = {}) {
  const etat = { tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map(l => ({ ...l }))])), ecritures: [], lectures: [] }
  let n = 0
  const db = {
    from (table) {
      if (!etat.tables[table]) etat.tables[table] = []
      const q = { f: [], op: 'select', ordre: null, limite: null, retour: false }
      const garde = () => {
        let l = etat.tables[table].filter(r => q.f.every(([op, c, v]) =>
          op === 'eq' ? r[c] === v
            : op === 'in' ? v.includes(r[c])
              : op === 'is' ? (r[c] == null) === (v === null)
                : op === 'contains' ? v.every(x => (r[c] || []).includes(x))
                  : op === 'lte' ? String(r[c]) <= String(v) : true))
        if (q.ordre) l = [...l].sort((a, b) => String(a[q.ordre]).localeCompare(String(b[q.ordre])))
        if (q.limite != null) l = l.slice(0, q.limite)
        return l
      }
      const executer = () => {
        if (pannes.includes(table)) return { data: null, error: { message: 'panne' } }
        if (q.op === 'upsert') {
          etat.ecritures.push({ table, op: 'upsert', row: q.row, opts: q.opts })
          const cles = String(q.opts && q.opts.onConflict || 'id').split(',')
          // Comme la base : un NULL n'entre en conflit avec rien.
          const ex = etat.tables[table].find(r => cles.every(k => r[k] != null && r[k] === q.row[k]))
          if (ex) Object.assign(ex, q.row)
          else etat.tables[table].push({ id: `id-${++n}`, ...q.row })
          return { data: null, error: null }
        }
        if (q.op === 'delete') {
          const cibles = garde()
          etat.ecritures.push({ table, op: 'delete', n: cibles.length, f: q.f })
          etat.tables[table] = etat.tables[table].filter(r => !cibles.includes(r))
          return { data: q.retour ? cibles.map(r => ({ ...r })) : null, error: null }
        }
        etat.lectures.push({ table, f: q.f })
        return { data: garde().map(r => ({ ...r })), error: null }
      }
      const chaine = {
        select () { if (q.op === 'delete') q.retour = true; return chaine },
        eq (c, v) { q.f.push(['eq', c, v]); return chaine },
        in (c, v) { q.f.push(['in', c, v]); return chaine },
        is (c, v) { q.f.push(['is', c, v]); return chaine },
        contains (c, v) { q.f.push(['contains', c, v]); return chaine },
        lte (c, v) { q.f.push(['lte', c, v]); return chaine },
        order (c) { q.ordre = c; return chaine },
        limit (k) { q.limite = k; return chaine },
        upsert (row, opts) { q.op = 'upsert'; q.row = row; q.opts = opts; return chaine },
        delete () { q.op = 'delete'; return chaine },
        maybeSingle () { const r = executer(); return Promise.resolve({ data: r.data ? (r.data[0] || null) : null, error: r.error }) },
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
      }
      return chaine
    }
  }
  return { db, etat }
}

const proprio = { id: 'p-proprio', account_user_id: COMPTE, member_user_id: COMPTE, is_owner: true, active: true, accepted_at: '2026-01-01', access_mode: 'compte', email: 'hote@exemple.fr', phone: '+33600000001' }
const contact = (o = {}) => ({ id: 'c-gardien', compte_id: COMPTE, nom: 'Gardien', email: 'gardien@exemple.fr', telephone: '+33611111111',
  biens: [BIEN], alertes: ['urgences'], jeton: 'jeton-gardien', desinscrit_le: null, ...o })
const proprietes = [
  { id: BIEN, user_id: COMPTE, provider_property_id: 'ref-1', name: 'La bulle', archive_le: null },
  { id: BIEN_2, user_id: COMPTE, provider_property_id: 'ref-2', name: 'Cœur de vie', archive_le: null }
]

// Les envois, captés : la notification, l'e-mail, le SMS, et les appareils lus.
function envois () {
  const sorties = []
  return {
    sorties,
    deps: {
      cles: { publique: 'p' },
      envoyerPush: async (o) => { sorties.push(['push', o.userId]); return { ok: true, envoyes: 1, morts: 0, echecs: 0 } },
      compterAppareils: async (o) => { sorties.push(['appareils', o.userId]); return { ok: true, n: 1 } },
      envoyerEmail: async (to, sujet, html) => { sorties.push(['email', to, sujet, html]); return { ok: true } },
      envoyerSms: async (to, texte, ref, ctx, compte) => { sorties.push(['sms', to, texte.split('\n')[0], compte]); return { success: true } }
    }
  }
}
const DONNEES_URGENCE = { bien: 'La bulle', prenom: 'Jean' }

// ─── 1. Qui est contact pour quoi ───────────────────────────────────────────

test('les deux listes d\'aujourd\'hui, et rien d\'autre : urgences (b, j, l, m, o) et info manquante (c)', () => {
  for (const code of ['urgence_ia', 'code_non_resolu', 'menage_refuse', 'disponibilites_modifiees', 'evaluation_voyageur']) {
    assert.equal(contacts.alerteDe(code), 'urgences', code)
  }
  assert.equal(contacts.alerteDe('info_manquante'), 'info_manquante')
  for (const code of ['surreservation', 'reservation', 'annulation_modification', 'brouillon_ia', 'message_voyageur', 'pause_automatique',
    'menage_sans_personne', 'menage_pas_vu', 'avis']) {
    assert.equal(contacts.alerteDe(code), null, `${code} ne va jamais à un contact`)
  }
})

test('LE TEST QUI COMPTE : un contact ne reçoit que SON alerte, sur SES biens, sur SON compte — et plus rien une fois désinscrit', async () => {
  const { db } = base({
    properties: proprietes,
    notifications_contacts: [
      contact(),
      contact({ id: 'c-info', alertes: ['info_manquante'], email: 'info@exemple.fr' }),
      contact({ id: 'c-autre-bien', biens: [BIEN_2], email: 'autre-bien@exemple.fr' }),
      contact({ id: 'c-autre-compte', compte_id: AUTRE, email: 'autre-compte@exemple.fr' }),
      contact({ id: 'c-parti', desinscrit_le: '2026-11-10T10:00:00Z', email: 'parti@exemple.fr' })
    ]
  })
  const urgence = await contacts.contactsPour({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN, ref: 'ref-1' }, db })
  assert.deepEqual(urgence.contacts.map(c => c.contactId), ['c-gardien'])
  const info = await contacts.contactsPour({ compte: COMPTE, code: 'info_manquante', bien: { id: BIEN }, db })
  assert.deepEqual(info.contacts.map(c => c.contactId), ['c-info'])
  // Sans identifiant, la référence provider retrouve le bien — sur ce compte.
  const parRef = await contacts.contactsPour({ compte: COMPTE, code: 'urgence_ia', bien: { ref: 'ref-2' }, db })
  assert.deepEqual(parRef.contacts.map(c => c.contactId), ['c-autre-bien'])
  assert.deepEqual((await contacts.contactsPour({ compte: COMPTE, code: 'reservation', bien: { id: BIEN }, db })).contacts, [])
  assert.deepEqual((await contacts.contactsPour({ compte: COMPTE, code: 'urgence_ia', bien: null, db })).contacts, [], 'sans bien, personne')
})

test('la référence d\'un bien archivé puis recréé désigne le bien ACTIF', async () => {
  const { db } = base({
    properties: [{ id: BIEN_2, user_id: COMPTE, provider_property_id: 'ref-1', archive_le: '2026-10-01' }, ...proprietes],
    notifications_contacts: [contact()]
  })
  const r = await contacts.contactsPour({ compte: COMPTE, code: 'urgence_ia', bien: { ref: 'ref-1' }, db })
  assert.deepEqual(r.contacts.map(c => c.contactId), ['c-gardien'])
})

test('une lecture en panne se dit (ok: false), elle ne rend pas « personne »', async () => {
  const { db } = base({ properties: proprietes, notifications_contacts: [contact()] }, { pannes: ['notifications_contacts'] })
  assert.deepEqual(await contacts.contactsPour({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, db }), { ok: false, motif: 'lecture_impossible' })
})

// ─── 2. L'envoi à un contact ────────────────────────────────────────────────

test('LE TEST QUI COMPTE : un contact n\'a ni notification ni appareil — son SMS part sans lire d\'appareil, son e-mail porte la désinscription', async () => {
  const e = envois()
  const b = await envoyerMaintenant({
    personne: { contact: { contactId: 'c-gardien', jeton: 'jeton-gardien' }, email: 'gardien@exemple.fr', telephone: '+33611111111' },
    canaux: ['push', 'email', 'sms'], contenu: { titre: 'Urgence — La bulle', corps: 'Jean : …', chemin: '/pages/messages?conv=1', sujet: 's', langue: 'fr' },
    compte: COMPTE, bienRef: 'ref-1', deps: e.deps
  })
  assert.deepEqual(e.sorties.map(s => s[0]), ['email', 'sms'], 'ni notification ni lecture d\'appareils')
  const html = e.sorties[0][3]
  assert.match(html, /\/api\/alertes-desinscription\?jeton=jeton-gardien/)
  assert.match(html, /Ne plus recevoir ces alertes/)
  assert.doesNotMatch(html, /pages\/messages|Ouvrir HôteSmart/, 'pas de lien vers l\'application : un contact n\'a pas de compte')
  assert.deepEqual(e.sorties[1].slice(1), ['+33611111111', 'HôteSmart — Urgence — La bulle', COMPTE], 'le SMS part sur la clé du compte')
  assert.deepEqual({ push: b.push, email: b.email, sms: b.sms }, { push: 0, email: true, sms: true })
})

test('l\'e-mail d\'un contact : la désinscription dans sa langue, et tout est échappé', () => {
  const m = textes.emailContact({ langue: 'en', titre: 'A <b>', corps: '<img>', jeton: 'j"x', site: 'https://s.test' })
  assert.match(m.html, /Stop receiving these alerts/)
  assert.match(m.html, /href="https:\/\/s\.test\/api\/alertes-desinscription\?jeton=j%22x"/)
  assert.doesNotMatch(m.html, /<b>|<img>/)
  assert.doesNotMatch(textes.emailContact({ langue: 'fr', titre: 't', corps: 'c', jeton: null }).html, /href=/, 'sans jeton, pas de lien')
})

// ─── 3. Le point d'envoi : heures et langue du titulaire ────────────────────

function compte ({ reglagesTitulaire = null, contactsEnBase = [contact()], pannes = [] } = {}) {
  return base({
    profiles: [proprio],
    profile_permissions: [],
    notifications_reglages: reglagesTitulaire ? [{ user_id: COMPTE, ...reglagesTitulaire }] : [],
    properties: proprietes,
    notifications_contacts: contactsEnBase,
    notifications_file: []
  }, { pannes })
}

test('LE TEST QUI COMPTE : le point d\'envoi prévient le contact du bien, dans la LANGUE DU TITULAIRE', async () => {
  const { db } = compte({ reglagesTitulaire: { langue: 'en', evenements: {}, plages: [] } })
  const e = envois()
  const b = await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN, ref: 'ref-1' }, donnees: DONNEES_URGENCE,
    chemin: '/pages/messages?conv=1', sujet: 'conv:1', maintenant: MIDI, db, deps: e.deps })
  const aGardien = e.sorties.filter(s => s[1] === 'gardien@exemple.fr' || s[1] === '+33611111111')
  assert.deepEqual(aGardien.map(s => s[0]), ['email', 'sms'])
  assert.match(aGardien[0][2], /^HôteSmart — Urgent — La bulle/, 'en anglais, comme le titulaire')
  assert.equal(b.contacts, 1)
})

test('LE TEST QUI COMPTE : les HEURES du titulaire, pas ses canaux — tout décoché pour lui ne fait pas taire son gardien', async () => {
  const tout = { push: false, email: false, sms: false, urgent: false }
  const NUIT_TOUS = { debut: '22:00', fin: '07:00', jours: [1, 2, 3, 4, 5, 6, 7] }
  // Le jour : tout décoché pour lui, le gardien est prévenu tout de suite.
  const jour = compte({ reglagesTitulaire: { evenements: { urgence_ia: tout }, plages: [NUIT_TOUS] } })
  const e = envois()
  await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, donnees: DONNEES_URGENCE, chemin: '/', sujet: 'conv:1', maintenant: MIDI, db: jour.db, deps: e.deps })
  assert.deepEqual(e.sorties.map(s => [s[0], s[1]]), [['email', 'gardien@exemple.fr'], ['sms', '+33611111111']], 'le titulaire, lui, ne reçoit rien')
  // La nuit, non urgent pour lui : le gardien attend la fin de SA plage.
  const nuit = compte({ reglagesTitulaire: { evenements: { urgence_ia: tout }, plages: [NUIT_TOUS] } })
  const e2 = envois()
  const b = await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, donnees: DONNEES_URGENCE, chemin: '/', sujet: 'conv:1', maintenant: NUIT, db: nuit.db, deps: e2.deps })
  assert.deepEqual(e2.sorties, [])
  assert.equal(b.en_attente, 1)
  const ligne = nuit.etat.tables.notifications_file[0]
  assert.deepEqual({ user_id: ligne.user_id, contact_id: ligne.contact_id, canaux: ligne.canaux, a: ligne.a, chemin: ligne.contenu.chemin },
    { user_id: null, contact_id: 'c-gardien', canaux: ['email', 'sms'], a: new Date(hiver('2026-11-11T07:00')).toISOString(), chemin: null })
  assert.equal(nuit.etat.ecritures.find(w => w.op === 'upsert').opts.onConflict, 'contact_id,sujet')
  // Urgent pour lui : le gardien est prévenu la nuit aussi.
  const urgent = compte({ reglagesTitulaire: { evenements: { urgence_ia: { ...tout, urgent: true } }, plages: [NUIT_TOUS] } })
  const e3 = envois()
  await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, donnees: DONNEES_URGENCE, chemin: '/', sujet: 'conv:1', maintenant: NUIT, db: urgent.db, deps: e3.deps })
  assert.deepEqual(e3.sorties.map(s => s[0]), ['email', 'sms'])
})

test('un contact sans e-mail ne reçoit que le SMS, et inversement ; un événement hors de ses listes ne lit même pas les contacts', async () => {
  const { db, etat } = compte({ contactsEnBase: [contact({ email: null }), contact({ id: 'c-mail', telephone: null, email: 'mail@exemple.fr' })] })
  const e = envois()
  await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, donnees: DONNEES_URGENCE, chemin: '/', sujet: 's', maintenant: MIDI, db, deps: e.deps })
  const aux = e.sorties.filter(s => s[1] !== 'hote@exemple.fr' && s[0] !== 'push' && s[0] !== 'appareils').map(s => [s[0], s[1]])
  assert.deepEqual(aux.sort(), [['email', 'mail@exemple.fr'], ['sms', '+33611111111']])
  const lu = etat.lectures.filter(l => l.table === 'notifications_contacts').length
  await notifier({ compte: COMPTE, code: 'reservation', bien: { id: BIEN }, donnees: { bien: 'B' }, chemin: '/', sujet: 'resa:1', maintenant: MIDI, db, deps: envois().deps })
  assert.equal(etat.lectures.filter(l => l.table === 'notifications_contacts').length, lu)
})

test('SÉCURITÉ : l\'essai sur soi (`seulement`) n\'atteint jamais un contact — il ne serait plus un essai, mais un relais', async () => {
  const { db, etat } = compte()
  const e = envois()
  const b = await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, donnees: DONNEES_URGENCE, chemin: '/', sujet: 'essai:urgence_ia',
    seulement: COMPTE, canauxPermis: ['push'], maintenant: MIDI, db, deps: e.deps })
  assert.equal(b.contacts, 0)
  assert.ok(!e.sorties.some(s => s[1] === 'gardien@exemple.fr' || s[1] === '+33611111111'))
  assert.equal(etat.lectures.filter(l => l.table === 'notifications_contacts').length, 0)
})

test('une panne de lecture des contacts se dit dans le bilan, et ne prive pas les personnes du compte', async () => {
  const { db } = compte({ pannes: ['notifications_contacts'] })
  const e = envois()
  const b = await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, donnees: DONNEES_URGENCE, chemin: '/', sujet: 's', maintenant: MIDI, db, deps: e.deps })
  assert.ok(b.erreurs.includes('contacts_illisibles'))
  assert.ok(e.sorties.some(s => s[0] === 'push' && s[1] === COMPTE), 'le titulaire reçoit quand même')
})

// ─── 4. La file : relue à la sortie ─────────────────────────────────────────

function ligneContact (o = {}) {
  return { id: 'l1', user_id: null, contact_id: 'c-gardien', compte_id: COMPTE, code: 'urgence_ia', sujet: 'conv:1', canaux: ['email', 'sms'],
    a: new Date(hiver('2026-11-11T07:00')).toISOString(), cree_le: '2026-11-11T00:30:00Z',
    contenu: { titre: 'Urgence — La bulle', corps: 'Jean : …', chemin: null, sujet: 'conv:1', langue: 'fr', bienId: BIEN, bienRef: 'ref-1' }, ...o }
}

test('LE TEST QUI COMPTE : à la fin de la plage, la ligne d\'un contact part en e-mail et SMS, avec sa désinscription', async () => {
  const { db, etat } = compte()
  etat.tables.notifications_file.push(ligneContact())
  const e = envois()
  const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), db, deps: e.deps })
  assert.equal(bilan.messages, 1)
  assert.deepEqual(e.sorties.map(s => [s[0], s[1]]), [['email', 'gardien@exemple.fr'], ['sms', '+33611111111']])
  assert.match(e.sorties[0][3], /jeton=jeton-gardien/)
  assert.equal(etat.tables.notifications_file.length, 0)
})

test('relu à la sortie : désinscrit, plus réglé pour ce bien ou cette alerte, ou d\'un autre compte — la ligne est écartée', async () => {
  for (const [nom, c] of [
    ['désinscrit', contact({ desinscrit_le: '2026-11-11T03:00:00Z' })],
    ['plus ce bien', contact({ biens: [BIEN_2] })],
    ['plus cette alerte', contact({ alertes: ['info_manquante'] })],
    ['un autre compte', contact({ compte_id: AUTRE })]
  ]) {
    const { db, etat } = compte({ contactsEnBase: [c] })
    etat.tables.notifications_file.push(ligneContact())
    const e = envois()
    const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), db, deps: e.deps })
    assert.deepEqual([bilan.ecartees, e.sorties.length], [1, 0], nom)
  }
})

test('une relecture du contact en panne laisse la ligne en file pour le cycle suivant', async () => {
  const { db, etat } = compte({ pannes: ['notifications_contacts'] })
  etat.tables.notifications_file.push(ligneContact())
  const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), db, deps: envois().deps })
  assert.equal(bilan.reportees, 1)
  assert.equal(etat.tables.notifications_file.length, 1)
})

test('un contact et une personne ne sont jamais regroupés ; « vider ma file » ne prend jamais la ligne d\'un contact', async () => {
  const { db, etat } = compte()
  etat.tables.notifications_file.push(ligneContact(), ligneContact({ id: 'l2', user_id: COMPTE, contact_id: null, canaux: ['email'] }))
  const e = envois()
  const moi = await file.viderFile({ seulement: COMPTE, maintenant: hiver('2026-11-11T08:00'), db, deps: e.deps })
  assert.equal(moi.dues, 1)
  assert.deepEqual(etat.tables.notifications_file.map(l => l.id), ['l1'])
  const tous = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), db, deps: e.deps })
  assert.equal(tous.groupes, 1)
})

test('une ligne pour personne, ou pour une personne ET un contact, est refusée avant la base', async () => {
  const { db, etat } = compte()
  for (const o of [{}, { userId: COMPTE, contactId: 'c-gardien' }]) {
    const r = await file.enfiler({ ...o, compte: COMPTE, code: 'urgence_ia', sujet: 's', canaux: ['email'], a: MIDI, contenu: {}, db })
    assert.deepEqual(r, { ok: false, motif: 'destinataire_illisible' })
  }
  assert.equal(etat.ecritures.length, 0)
})

test('ce qui vient de partir au contact retire la ligne du même sujet qui l\'attendait', async () => {
  const { db, etat } = compte()
  etat.tables.notifications_file.push(ligneContact(), ligneContact({ id: 'l2', user_id: COMPTE, contact_id: null }))
  await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, donnees: DONNEES_URGENCE, chemin: '/', sujet: 'conv:1', maintenant: MIDI, db, deps: envois().deps })
  assert.ok(!etat.tables.notifications_file.some(l => l.id === 'l1'), 'la ligne du contact est retirée')
})

// ─── 5. Une adresse du compte (Q29) ─────────────────────────────────────────

const MEMBRE = '22222222-2222-4222-8222-222222222222'
const membre = { id: 'p-membre', account_user_id: COMPTE, member_user_id: MEMBRE, is_owner: false, active: true, accepted_at: '2026-02-01',
  access_mode: 'compte', email: 'Membre@Exemple.fr', phone: '06 22 22 22 22' }
const droitsMembre = (o = {}) => ({ profile_id: 'p-membre', account_user_id: COMPTE, property_scope: 'all', property_ids: [], property_refs: [],
  reservations: 'none', menages: 'none', prestataires: 'none', messages: 'none', avis: 'none', reglages: 'none', facturation: 'none', equipe: 'none', ...o })

test('LE TEST QUI COMPTE (Q29) : un membre dont les droits couvrent l\'événement le reçoit par SES réglages, une fois ; sinon son adresse de contact le prévient', async () => {
  const contactMembre = contact({ id: 'c-membre', email: 'membre@exemple.fr', telephone: '+33622222222' })
  const tables = (droits) => base({
    profiles: [proprio, membre], profile_permissions: [droits], notifications_reglages: [],
    properties: proprietes, notifications_contacts: [contactMembre], notifications_file: []
  })
  // Droits sur les messages : l'urgence de l'IA lui arrive par ses réglages — l'adresse de contact se tait.
  const couvert = tables(droitsMembre({ messages: 'read' }))
  const e = envois()
  const b = await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, donnees: DONNEES_URGENCE, chemin: '/', sujet: 's', maintenant: MIDI, db: couvert.db, deps: e.deps })
  assert.equal(b.contacts, 0)
  assert.ok(!e.sorties.some(s => s[0] === 'sms' && s[1] === '+33622222222'), 'pas de SMS de contact en double')
  assert.ok(e.sorties.some(s => s[0] === 'push' && s[1] === MEMBRE), 'il est prévenu par ses réglages')
  // Sans les messages : il n'est pas destinataire — son adresse de contact le prévient.
  const nonCouvert = tables(droitsMembre({ messages: 'none' }))
  const e2 = envois()
  const b2 = await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, donnees: DONNEES_URGENCE, chemin: '/', sujet: 's', maintenant: MIDI, db: nonCouvert.db, deps: e2.deps })
  assert.equal(b2.contacts, 1)
  assert.deepEqual(e2.sorties.filter(s => s[1] === 'membre@exemple.fr' || s[1] === '+33622222222').map(s => s[0]), ['email', 'sms'])
})

test('l\'adresse du titulaire listée en contact ne double rien ; un autre canal du même contact part', async () => {
  const { db } = compte({ contactsEnBase: [contact({ email: 'HOTE@exemple.fr', telephone: '+33699999999' })] })
  const e = envois()
  await notifier({ compte: COMPTE, code: 'urgence_ia', bien: { id: BIEN }, donnees: DONNEES_URGENCE, chemin: '/', sujet: 's', maintenant: MIDI, db, deps: e.deps })
  assert.equal(e.sorties.filter(s => s[0] === 'email' && /hote@exemple\.fr/i.test(s[1])).length, 1, 'un seul e-mail au titulaire')
  assert.ok(e.sorties.some(s => s[0] === 'sms' && s[1] === '+33699999999'))
})

test('une adresse se compare comme la base la saisit : casse de l\'e-mail, espaces et indicatif du numéro', () => {
  assert.equal(contacts.cleEmail(' Hote@Exemple.FR '), 'hote@exemple.fr')
  for (const t of ['06 12 34 56 78', '0033 6 12 34 56 78', '+33 6.12.34.56.78', '+33612345678']) assert.equal(contacts.cleTelephone(t), '+33612345678', t)
  assert.equal(contacts.cleTelephone(''), null)
  assert.equal(contacts.cleEmail(null), null)
})
