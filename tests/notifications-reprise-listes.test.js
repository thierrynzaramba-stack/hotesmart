// tests/notifications-reprise-listes.test.js — la reprise des listes d'alertes (PWA lot 2c-3, étape 2).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §16.3, Q25, Q29 et Q30 · KB : docs/kb/pwa.md §12.2
//
// Ce que ce fichier prouve, en APPELANT le module et le script (REVIEW.md règle 20) :
//   1. ce que délivrait une liste, et seulement ça : un canal décoché ne devient rien ;
//   2. une adresse de personne du compte → ses réglages (ce qu'elle reçoit) ;
//      le reste → des contacts, un par adresse et par ensemble d'alertes ;
//   3. la vérification suit les règles du point d'envoi, et une perte bloque ;
//   4. le script : à blanc par défaut et tout validé, refusé tant que la reprise
//      n'est pas ouverte, la ligne ÉCRITE juste, la coupure par compte, rejouable,
//      et aucune adresse en clair.

const test = require('node:test')
const assert = require('node:assert/strict')

const reprise = require('../lib/notifications/reprise-listes')
const reglagesMod = require('../lib/notifications/reglages')
const { executer } = require('../scripts/reprendre-listes-alertes')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const MEMBRE2 = '44444444-4444-4444-8444-444444444444'
const AUTRE = '33333333-3333-4333-8333-333333333333'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const URGENCES = ['urgence_ia', 'code_non_resolu', 'menage_refuse', 'disponibilites_modifiees', 'evaluation_voyageur']

const liste = (o = {}) => ({ sms_enabled: false, sms_lines: '', email_enabled: true, email_lines: '', ...o })
const sms = (lignes) => liste({ email_enabled: false, sms_enabled: true, sms_lines: lignes })
// Des réglages EFFECTIFS, comme le script les fournit (reglages.lirePlusieurs).
const effectifsAvec = (evenements) => reglagesMod.effectifs({ evenements })
const pourTous = (valeur) => Object.fromEntries(URGENCES.map(c => [c, valeur]))

// ─── 1. Ce que délivrait une liste ──────────────────────────────────────────

test('une ligne de liste se lit comme à l\'envoi : « Nom : valeur », un numéro ou un e-mail valide, le reste ignoré', () => {
  assert.deepEqual(reprise.lireListe('Gardien : +33 6 11 11 11 11\n\n  pas un numéro\n0612345678', 'sms').map(l => [l.nom, l.valeur]),
    [['Gardien', '+33 6 11 11 11 11'], ['', '0612345678']])
  assert.deepEqual(reprise.lireListe('Jean : jean@exemple.fr\nmauvais@\nmarie@exemple.fr', 'email').map(l => l.valeur), ['jean@exemple.fr', 'marie@exemple.fr'])
})

test('la lecture d\'une liste est celle de l\'envoi (`parseLines`, lib/alert-notify.js), ligne pour ligne', () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
  const { parseLines } = require('../lib/alert-notify')
  const textes = ['A : +33 6 12 34 56 78\n0612345678\n:+33611\nB:\n  \nx : 12345\n+4412345678901234', 'Jean : jean@exemple.fr\nmauvais@\n a@b.c \nNom:x@y.zz\n@a.b']
  for (const canal of ['sms', 'email']) {
    for (const t of textes) {
      assert.deepEqual(reprise.lireListe(t, canal).map(l => [l.nom, l.valeur]), parseLines(t, canal).map(l => [l.name, l.value]), `${canal} : ${t}`)
    }
  }
})

test('LE TEST QUI COMPTE : un canal décoché n\'envoyait rien — il ne devient rien', () => {
  const config = {
    'ref-1': {
      intervention: liste({ email_lines: 'g@exemple.fr', sms_enabled: false, sms_lines: '+33611111111' }),
      info_unknown: liste({ email_enabled: false, email_lines: 'i@exemple.fr' })
    },
    'ref-2': 'illisible'
  }
  const l = reprise.lignesDeLaConfig(config)
  assert.deepEqual(l.map(x => [x.ref, x.alerte, x.canal, x.valeur]), [['ref-1', 'urgences', 'email', 'g@exemple.fr']])
  assert.deepEqual(reprise.lignesDeLaConfig(null), [])
})

// ─── 2. Le plan ─────────────────────────────────────────────────────────────

const biens = new Map([['ref-1', A], ['ref-2', B]])
const titulaire = { userId: COMPTE, titulaire: true, email: 'hote@exemple.fr', telephone: '+33600000001' }
const membre = { userId: MEMBRE, titulaire: false, email: 'membre@exemple.fr', telephone: '0622222222' }
const tousDestinataires = (userId) => userId === COMPTE
const planifier = (lignes, o = {}) => reprise.planifier({ lignes, biensParRef: biens, personnes: [titulaire, membre],
  destinataire: tousDestinataires, reglages: new Map(), ...o })
const lignesDe = (config) => reprise.lignesDeLaConfig(config)

test('LE TEST QUI COMPTE : un gardien sur deux biens = UN contact, ses deux biens, ses alertes ; personne ne perd rien', () => {
  const p = planifier(lignesDe({
    'ref-1': { intervention: liste({ email_lines: 'Gardien : gardien@exemple.fr' }) },
    'ref-2': { intervention: liste({ email_lines: 'gardien@exemple.fr' }) }
  }))
  assert.deepEqual(p.contacts, [{ nom: 'Gardien', email: 'gardien@exemple.fr', telephone: null, alertes: ['urgences'], biens: [A, B].sort() }])
  assert.deepEqual([p.avant, p.pertes.length], [10, 0])
})

test('une adresse en « urgences » sur un bien et en « urgences + info » sur l\'autre = DEUX contacts — sinon le premier recevrait ce que sa liste n\'envoyait pas', () => {
  const p = planifier(lignesDe({
    'ref-1': { intervention: liste({ email_lines: 'g@exemple.fr' }) },
    'ref-2': { intervention: liste({ email_lines: 'g@exemple.fr' }), info_unknown: liste({ email_lines: 'g@exemple.fr' }) }
  }))
  assert.deepEqual(p.contacts.map(c => [c.alertes.join('+'), c.biens]), [['urgences', [A]], ['info_manquante+urgences', [B]]])
  assert.equal(p.pertes.length, 0)
})

test('LE TEST QUI COMPTE : l\'adresse du TITULAIRE passe par ses réglages, sans contact (sinon tout en double) — et seul ce qui ne part pas encore se coche', () => {
  // L'e-mail est coché par défaut : rien à changer. Le SMS ne l'est pas : il se coche.
  const p = planifier(lignesDe({ 'ref-1': { intervention: liste({ sms_enabled: true, sms_lines: '06 00 00 00 01', email_lines: 'HOTE@exemple.fr' }) } }))
  assert.deepEqual(p.contacts, [])
  assert.deepEqual(p.cocher.get(COMPTE), URGENCES.map(c => `${c}|sms`).sort())
  assert.deepEqual(p.reglagesApres.get(COMPTE).urgence_ia, { push: true, email: true, sms: true, urgent: true })
  assert.equal(p.pertes.length, 0)
  // Un événement qui ne lui irait pas passe par un contact, et ne se coche pas chez lui.
  const sauf = planifier(lignesDe({ 'ref-1': { intervention: sms('06 00 00 00 01') } }), { destinataire: (u, code) => code !== 'menage_refuse' })
  assert.deepEqual([sauf.contacts.length, sauf.cocher.get(COMPTE).includes('menage_refuse|sms'), sauf.pertes.length], [1, false, 0])
})

test('LE TEST QUI COMPTE (Q29) : un membre couvert → ses réglages seuls ; couvert en partie → ses réglages ET un contact ; sans droit → un contact seul', () => {
  const lignes = lignesDe({ 'ref-1': { intervention: sms('06 22 22 22 22') } })
  const couvert = planifier(lignes, { destinataire: () => true })
  assert.deepEqual(couvert.contacts, [])
  assert.deepEqual(couvert.cocher.get(MEMBRE), URGENCES.map(c => `${c}|sms`).sort())
  // Il a les messages, pas les ménages : ses réglages ne se cochent QUE pour ce qu'il reçoit.
  const partiel = planifier(lignes, { destinataire: (u, code) => u === COMPTE || code === 'urgence_ia' })
  assert.deepEqual(partiel.contacts.map(c => [c.telephone, c.alertes, c.biens]), [['0622222222', ['urgences'], [A]]])
  assert.deepEqual(partiel.cocher.get(MEMBRE), ['urgence_ia|sms'])
  assert.equal(partiel.pertes.length, 0)
  const aucun = planifier(lignes, { destinataire: (u) => u === COMPTE })
  assert.deepEqual([aucun.contacts.length, aucun.cocher.has(MEMBRE), aucun.pertes.length], [1, false, 0])
})

test('les droits se jugent BIEN PAR BIEN : un membre limité à un bien a ses réglages pour celui-là, un contact pour l\'autre', () => {
  const p = planifier(lignesDe({ 'ref-1': { intervention: sms('0622222222') }, 'ref-2': { intervention: sms('0622222222') } }),
    { destinataire: (u, code, bien) => u === COMPTE || bien === A })
  assert.deepEqual(p.contacts.map(c => [c.telephone, c.biens]), [['0622222222', [B]]])
  assert.equal(p.pertes.length, 0)
})

test('LE TEST QUI COMPTE (constat 4) : deux personnes au même numéro — c\'est celle qui REÇOIT qui est cochée, comme le point d\'envoi fait taire le contact', () => {
  const m1 = { userId: MEMBRE, titulaire: false, email: null, telephone: '0655555555' }
  const m2 = { userId: MEMBRE2, titulaire: false, email: null, telephone: '+33 6 55 55 55 55' }
  const p = reprise.planifier({ lignes: lignesDe({ 'ref-1': { intervention: sms('0655555555') } }), biensParRef: biens,
    personnes: [titulaire, m1, m2], destinataire: (u) => u !== MEMBRE, reglages: new Map() })
  assert.deepEqual([p.contacts.length, p.cocher.has(MEMBRE), p.cocher.get(MEMBRE2).length, p.pertes.length], [0, false, 5, 0])
})

test('LE TEST QUI COMPTE (constat S1) : une personne qui reçoit aussi un AUTRE compte n\'est jamais cochée par la liste de celui-ci — c\'est une perte, dite', () => {
  const ailleurs = { ...membre, autresComptes: true }
  const s = reprise.planifier({ lignes: lignesDe({ 'ref-1': { intervention: sms('0622222222') } }), biensParRef: biens,
    personnes: [titulaire, ailleurs], destinataire: () => true, reglages: new Map() })
  assert.equal(s.cocher.has(MEMBRE), false)
  assert.deepEqual([s.pertes.length, s.pertes[0].motif], [5, 'personne_sur_plusieurs_comptes'])
  // Ce qui lui part déjà (l'e-mail, coché par défaut) ne demande rien : ni coche, ni perte.
  const e = reprise.planifier({ lignes: lignesDe({ 'ref-1': { intervention: liste({ email_lines: 'membre@exemple.fr' }) } }), biensParRef: biens,
    personnes: [titulaire, ailleurs], destinataire: () => true, reglages: new Map() })
  assert.deepEqual([e.cocher.size, e.pertes.length], [0, 0])
})

test('ce qui part EN PLUS se compte : un canal coché pour la liste d\'un bien vaut pour tous les biens du compte', () => {
  const p = planifier(lignesDe({ 'ref-1': { intervention: sms('0600000001') } }), { biensDuCompte: [A, B] })
  assert.deepEqual([p.enPlus, p.pertes.length], [5, 0])
  // Seulement là où l'événement lui irait : un ménage refusé sur B ne lui va pas.
  const sauf = planifier(lignesDe({ 'ref-1': { intervention: sms('0600000001') } }), { biensDuCompte: [A, B], destinataire: (u, code, bien) => u === COMPTE && !(bien === B && code === 'menage_refuse') })
  assert.equal(sauf.enPlus, 4)
})

test('LE TEST QUI COMPTE (constat 5) : un bien introuvable est une PERTE — sauf décision humaine de l\'ignorer', () => {
  const lignes = lignesDe({ 'ref-supprime': { intervention: liste({ email_lines: 'g@exemple.fr' }) } })
  const p = planifier(lignes)
  assert.deepEqual([p.pertes.length, p.pertes[0].motif, p.pertes[0].ref, p.contacts.length], [5, 'bien_introuvable', 'ref-supprime', 0])
  const decide = planifier(lignes, { ignores: new Set(['ref-supprime']) })
  assert.deepEqual([decide.pertes.length, decide.ignores], [0, ['ref-supprime']])
})

test('rejouable : un contact identique déjà en base ne se recrée pas ; un contact DÉSINSCRIT non plus, et ce n\'est pas une perte', () => {
  const lignes = lignesDe({ 'ref-1': { intervention: liste({ email_lines: 'g@exemple.fr' }) } })
  const deja = planifier(lignes, { existants: [{ email: 'G@exemple.fr', telephone: null, biens: [A], alertes: ['urgences'], desinscrit_le: null }] })
  assert.deepEqual([deja.contacts.length, deja.dejaPresents, deja.pertes.length], [0, 1, 0])
  const parti = planifier(lignes, { existants: [{ email: 'g@exemple.fr', telephone: null, biens: [A], alertes: ['urgences'], desinscrit_le: '2026-11-10' }] })
  assert.deepEqual([parti.contacts.length, parti.pertes.length, parti.desinscrits], [0, 0, 5])
})

test('LE TEST QUI COMPTE (Q30) : une adresse désinscrite ne revient par AUCUN contact, même pour un autre bien', () => {
  const p = planifier(lignesDe({
    'ref-1': { intervention: liste({ email_lines: 'g@exemple.fr' }) },
    'ref-2': { intervention: liste({ email_lines: 'G@exemple.fr' }) }
  }), { existants: [{ email: 'g@exemple.fr', telephone: null, biens: [A], alertes: ['urgences'], desinscrit_le: '2026-11-10' }] })
  assert.deepEqual([p.contacts.length, p.ecartes, p.pertes.length, p.desinscrits], [0, 1, 0, 10])
})

test('LE TEST QUI COMPTE : la vérification suit les règles du point d\'envoi — un canal coupé sur le profil, un SMS sans notification, c\'est une perte', () => {
  const l = lignesDe({ 'ref-1': { intervention: sms('+33600000001') } })
  const coupe = reprise.planifier({ lignes: l, biensParRef: biens, personnes: [{ ...titulaire, smsPermis: false }], destinataire: tousDestinataires, reglages: new Map() })
  assert.deepEqual([coupe.pertes.length, [...new Set(coupe.pertes.map(a => a.motif))]], [5, ['sms_coupe_sur_le_profil']])
  // Un appareil abonné et la notification décochée : le SMS ne part pas (Q11), rien d'autre non plus.
  const muet = new Map([[COMPTE, effectifsAvec(pourTous({ push: false }))]])
  const appareil = reprise.planifier({ lignes: l, biensParRef: biens, personnes: [{ ...titulaire, appareils: 1 }], destinataire: tousDestinataires, reglages: muet })
  assert.deepEqual([...new Set(appareil.pertes.map(a => a.motif))], ['appareil_sans_notification'])
  // La notification cochée (le défaut) : elle remplace le SMS, ce n'est pas une perte — et c'est compté.
  const remplace = reprise.planifier({ lignes: l, biensParRef: biens, personnes: [{ ...titulaire, appareils: 2 }], destinataire: tousDestinataires, reglages: new Map() })
  assert.deepEqual([remplace.pertes.length, remplace.parNotification], [0, 5])
  // L'e-mail coupé sur le profil d'un membre destinataire : perte.
  const mail = lignesDe({ 'ref-1': { intervention: liste({ email_lines: 'membre@exemple.fr' }) } })
  const m = reprise.planifier({ lignes: mail, biensParRef: biens, personnes: [titulaire, { ...membre, emailPermis: false }], destinataire: () => true, reglages: new Map() })
  assert.deepEqual([m.pertes.length, m.pertes[0].motif], [5, 'email_coupe_sur_le_profil'])
})

test('un canal resté décoché dans les réglages n\'est pas une perte : la reprise le coche, sur l\'effectif de l\'événement', () => {
  const lignes = lignesDe({ 'ref-1': { intervention: liste({ email_lines: 'hote@exemple.fr' }) } })
  const p = planifier(lignes, { reglages: new Map([[COMPTE, effectifsAvec(pourTous({ email: false }))]]) })
  assert.equal(p.pertes.length, 0)
  assert.deepEqual(p.reglagesApres.get(COMPTE).menage_refuse, { push: true, email: true, sms: false, urgent: false })
})

test('la coupure met les listes de côté, et rien d\'autre ne bouge dans la config', () => {
  const config = { 'ref-1': { mode: 'auto', delais: { x: 1 }, intervention: liste({ email_lines: 'g@exemple.fr' }), info_unknown: liste() }, 'ref-2': { mode: 'test' }, divers: 'texte' }
  const c = reprise.mettreDeCote(config, '2026-11-10T00:00:00Z')
  assert.deepEqual(c['ref-1'], { mode: 'auto', delais: { x: 1 }, listes_reprises: { le: '2026-11-10T00:00:00Z', intervention: config['ref-1'].intervention, info_unknown: config['ref-1'].info_unknown } })
  assert.deepEqual([c['ref-2'], c.divers], [{ mode: 'test' }, 'texte'])
  assert.deepEqual(reprise.lignesDeLaConfig(c), [], 'plus rien à servir pour l\'ancien envoi')
})

test('une adresse se montre masquée dans un compte rendu : la première lettre d\'un e-mail, les deux derniers chiffres d\'un numéro', () => {
  assert.equal(reprise.masquer('email', 'jean.dupont@exemple.fr'), 'j***@exemple.fr')
  assert.equal(reprise.masquer('email', 'jo@exemple.fr'), '***@exemple.fr')
  assert.equal(reprise.masquer('sms', '+33698765432'), '****32')
  assert.equal(reprise.masquer('sms', '06 98 76 54 32'), '****32')
  assert.equal(reprise.masquer('sms', '123'), '****')
})

// ─── 3. L'écriture des contacts (lib/notifications/contacts.js) ─────────────

test('LE TEST QUI COMPTE : un contact ne s\'écrit que sur des biens DU COMPTE, relus en base — sinon rien n\'est écrit', async () => {
  const contacts = require('../lib/notifications/contacts')
  const { db, etat } = base({ properties: [{ id: A, user_id: COMPTE }, { id: B, user_id: AUTRE }], notifications_contacts: [] })
  const refus = await contacts.creerContacts({ compte: COMPTE, contacts: [{ email: 'g@exemple.fr', alertes: ['urgences'], biens: [A] }, { email: 'h@exemple.fr', alertes: ['urgences'], biens: [B] }], db })
  assert.deepEqual([refus.ok, refus.motif, etat.tables.notifications_contacts.length], [false, 'bien_hors_compte', 0])
  const ok = await contacts.creerContacts({ compte: COMPTE, contacts: [{ nom: ' Gardien ', telephone: '06 12 34 56 78', alertes: ['urgences', 'urgences'], biens: [A] }], db })
  assert.deepEqual([ok.ok, etat.tables.notifications_contacts[0].telephone, etat.tables.notifications_contacts[0].nom, etat.tables.notifications_contacts[0].alertes], [true, '0612345678', 'Gardien', ['urgences']])
})

test('un contact se valide avant tout : une adresse, une forme lisible, des alertes connues, au moins un bien', () => {
  const { validerContact } = require('../lib/notifications/contacts')
  const motif = (c) => validerContact(c).motif
  assert.equal(motif({ alertes: ['urgences'], biens: [A] }), 'adresse_absente')
  assert.equal(motif({ email: 'pas-un-email', alertes: ['urgences'], biens: [A] }), 'email_illisible')
  assert.equal(motif({ telephone: '12', alertes: ['urgences'], biens: [A] }), 'telephone_illisible')
  assert.equal(motif({ email: 'g@exemple.fr', alertes: ['avis'], biens: [A] }), 'alertes_illisibles')
  assert.equal(motif({ email: 'g@exemple.fr', alertes: [], biens: [A] }), 'alertes_illisibles')
  assert.equal(motif({ email: 'g@exemple.fr', alertes: ['urgences'], biens: [] }), 'biens_absents')
  assert.equal(validerContact({ email: 'g@exemple.fr', alertes: ['urgences'], biens: [A] }).ok, true)
})

// ─── 4. Le script ───────────────────────────────────────────────────────────

function base (tables = {}, { pannes = [] } = {}) {
  const etat = { tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map(l => ({ ...l }))])), ecritures: [] }
  const db = {
    from (table) {
      if (!etat.tables[table]) etat.tables[table] = []
      const q = { f: [], op: 'select', limite: null }
      const garde = () => {
        let l = etat.tables[table].filter(r => q.f.every(([op, c, v]) =>
          op === 'eq' ? r[c] === v : op === 'is' ? (r[c] ?? null) === v : op === 'in' ? v.includes(r[c]) : op === 'gt' ? String(r[c]) > String(v) : true))
        if (q.ordre) l = [...l].sort((a, b) => String(a[q.ordre]).localeCompare(String(b[q.ordre])))
        if (q.limite != null) l = l.slice(0, q.limite)
        return l
      }
      const executer = () => {
        if (pannes.includes(table)) return { data: null, error: { message: 'panne' } }
        if (q.op === 'insert') { etat.ecritures.push({ table, op: 'insert', rows: q.rows }); etat.tables[table].push(...q.rows.map(r => ({ desinscrit_le: null, id: `c${etat.tables[table].length}`, ...r }))); return { data: null, error: null } }
        if (q.op === 'upsert') {
          etat.ecritures.push({ table, op: 'upsert', row: q.row })
          const ex = etat.tables[table].find(r => r.user_id === q.row.user_id)
          if (ex) Object.assign(ex, q.row); else etat.tables[table].push({ ...q.row })
          return { data: null, error: null }
        }
        if (q.op === 'update') {
          const cibles = garde()
          etat.ecritures.push({ table, op: 'update', n: cibles.length })
          for (const r of cibles) Object.assign(r, q.maj)
          return { data: cibles.map(r => ({ ...r })), error: null }
        }
        return { data: garde().map(r => ({ ...r })), error: null }
      }
      const chaine = {
        select () { return chaine },
        eq (c, v) { q.f.push(['eq', c, v]); return chaine },
        is (c, v) { q.f.push(['is', c, v]); return chaine },
        in (c, v) { q.f.push(['in', c, v]); return chaine },
        gt (c, v) { q.f.push(['gt', c, v]); return chaine },
        order (c) { q.ordre = c; return chaine },
        limit (k) { q.limite = k; return chaine },
        insert (rows) { q.op = 'insert'; q.rows = [].concat(rows); return chaine },
        upsert (row) { q.op = 'upsert'; q.row = row; return chaine },
        update (maj) { q.op = 'update'; q.maj = maj; return chaine },
        maybeSingle () { const r = executer(); return Promise.resolve({ data: r.data ? (r.data[0] || null) : null, error: r.error }) },
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
      }
      return chaine
    }
  }
  return { db, etat }
}

const CONFIG = {
  'ref-1': { mode: 'auto', intervention: liste({ email_lines: 'Gardien : gardien@exemple.fr\nHôte : hote@exemple.fr', sms_enabled: true, sms_lines: 'Gardien : +33 6 98 76 54 32' }) }
}
const MAJ = '2026-11-01T10:00:00.000Z'
function compte (o = {}) {
  return base({
    agent_alert_config: [{ user_id: COMPTE, config: CONFIG, updated_at: MAJ }],
    properties: [{ id: A, user_id: COMPTE, provider_property_id: 'ref-1', archive_le: null }],
    profiles: [{ account_user_id: COMPTE, member_user_id: COMPTE, is_owner: true, access_mode: 'compte', email: 'hote@exemple.fr', phone: '+33600000001' }],
    notifications_reglages: [{ user_id: COMPTE, evenements: { avis: { push: false, email: false, sms: false, urgent: false } }, plages: [{ debut: '22:00', fin: '07:00', jours: [1, 2, 3, 4, 5] }], langue: 'fr' }],
    notifications_contacts: [],
    ...o
  })
}
const appels = []
const seulTitulaire = async ({ compte: c, bien }) => { appels.push(bien); return { ok: true, personnes: [{ userId: c, titulaire: true }] } }
const lancer = (o) => executer({ base: 'STAGING', repriseOuverte: true, destinataires: seulTitulaire, ecrire: () => {}, maintenant: () => '2026-11-10T00:00:00.000Z', ...o })

test('LE TEST QUI COMPTE : `--go` est refusé tant que la reprise n\'est pas ouverte — rien n\'est écrit', async () => {
  const { db, etat } = compte()
  const sorties = []
  assert.equal(reprise.REPRISE_OUVERTE, false, 'elle s\'ouvre à l\'étape 4')
  const code = await lancer({ argv: ['--go'], db, repriseOuverte: reprise.REPRISE_OUVERTE, ecrire: t => sorties.push(t) })
  assert.equal(code, 2)
  assert.equal(etat.ecritures.length, 0)
  assert.match(sorties[0], /REPRISE_OUVERTE/)
})

test('à blanc : il dit ce qu\'il ferait, n\'écrit rien, et ne montre d\'aucune adresse plus que l\'initiale ou deux chiffres', async () => {
  const { db, etat } = compte()
  const sorties = []
  assert.equal(await lancer({ argv: [], db, repriseOuverte: false, ecrire: t => sorties.push(t) }), 0)
  assert.equal(etat.ecritures.length, 0)
  const texte = sorties.join('\n')
  assert.match(texte, /3 adresse\(s\) de liste, 2 contact\(s\) à créer, 0 déjà présent\(s\), réglages cochés pour 0 personne\(s\)/)
  assert.match(texte, /seraient coupées/)
  assert.doesNotMatch(texte, /gardien@|hote@/)
  for (let i = 0; i + 3 <= '698765432'.length - 2; i++) assert.doesNotMatch(texte, new RegExp('698765432'.slice(i, i + 3)), 'aucun morceau du numéro avant ses deux derniers chiffres')
  assert.match(texte, /g\*\*\*@exemple\.fr/)
})

test('les droits se demandent avec le bien tel que les émetteurs le passent : son id ET sa référence (constat 3)', async () => {
  appels.length = 0
  const { db } = compte()
  await lancer({ argv: [], db })
  assert.ok(appels.length > 0 && appels.every(b => b.id === A && b.ref === 'ref-1'))
})

test('LE TEST QUI COMPTE (constat 1) : `--go` — la ligne ÉCRITE porte TOUS les canaux cochés, ses plages et ses autres choix intacts ; contacts créés ; listes coupées ; rejoué, rien ne double', async () => {
  // Le titulaire est dans les deux listes, et il avait décoché l'e-mail de ces événements.
  const config = { 'ref-1': { mode: 'auto', intervention: liste({ email_lines: 'hote@exemple.fr\nGardien : gardien@exemple.fr', sms_enabled: true, sms_lines: '06 00 00 00 01\nGardien : +33 6 98 76 54 32' }) } }
  const { db, etat } = compte({
    agent_alert_config: [{ user_id: COMPTE, config, updated_at: MAJ }],
    notifications_reglages: [{ user_id: COMPTE, evenements: { avis: { push: false, email: false, sms: false, urgent: false }, ...pourTous({ push: true, email: false, sms: false, urgent: true }) }, plages: [{ debut: '22:00', fin: '07:00', jours: [1, 2, 3, 4, 5] }], langue: 'fr' }]
  })
  assert.equal(await lancer({ argv: ['--go'], db }), 0)
  const r = etat.tables.notifications_reglages[0]
  for (const code of URGENCES) assert.deepEqual(r.evenements[code], { push: true, email: true, sms: true, urgent: true }, code)
  assert.deepEqual(r.evenements.avis, { push: false, email: false, sms: false, urgent: false }, 'ses choix sur les autres événements restent')
  assert.deepEqual(r.plages, [{ debut: '22:00', fin: '07:00', jours: [1, 2, 3, 4, 5] }], 'ses plages restent')
  assert.equal(r.langue, 'fr', 'sa langue reste')
  assert.deepEqual(etat.tables.notifications_contacts.map(c => [c.compte_id, c.nom, c.email, c.telephone, c.biens, c.alertes]).sort(), [
    [COMPTE, 'Gardien', 'gardien@exemple.fr', null, [A], ['urgences']],
    [COMPTE, 'Gardien', null, '+33698765432', [A], ['urgences']]
  ].sort())
  const cfg = etat.tables.agent_alert_config[0]
  assert.deepEqual([cfg.config['ref-1'].intervention, cfg.config['ref-1'].mode, cfg.config['ref-1'].listes_reprises.intervention], [undefined, 'auto', config['ref-1'].intervention])
  // L'ordre : contacts, réglages, puis la coupure.
  assert.deepEqual(etat.ecritures.map(w => w.table), ['notifications_contacts', 'notifications_reglages', 'agent_alert_config'])
  // Rejoué : plus de liste, rien de nouveau.
  const n = etat.ecritures.length
  const sorties = []
  assert.equal(await lancer({ argv: ['--go'], db, ecrire: t => sorties.push(t) }), 0)
  assert.equal(etat.ecritures.length, n)
  assert.match(sorties.join('\n'), /0 compte\(s\) avec des listes actives/)
})

test('LE TEST QUI COMPTE (constat 6) : une config modifiée entre la lecture et la coupure n\'est PAS coupée — ses listes restent en service, sortie 1', async () => {
  const { db, etat } = compte()
  const versRelue = { from: (t) => {
    const c = db.from(t)
    if (t !== 'agent_alert_config') return c
    const update = c.update
    c.update = (maj) => { etat.tables.agent_alert_config[0].updated_at = '2026-11-09T00:00:00.000Z'; return update.call(c, maj) }
    return c
  } }
  const sorties = []
  assert.equal(await lancer({ argv: ['--go'], db: versRelue, ecrire: t => sorties.push(t) }), 1)
  assert.ok(etat.tables.agent_alert_config[0].config['ref-1'].intervention, 'la liste est toujours là')
  assert.match(sorties.join('\n'), /config_modifiee_entre_temps — listes toujours en service/)
})

test('une perte bloque le compte : rien n\'est écrit, ses listes restent, sortie 1', async () => {
  const { db, etat } = compte()
  const planifier = (o) => ({ ...reprise.planifier(o), pertes: [{ canal: 'email', valeur: 'g@exemple.fr', code: 'urgence_ia', motif: 'aucun_contact' }] })
  const sorties = []
  assert.equal(await lancer({ argv: ['--go'], db, planifier, ecrire: t => sorties.push(t) }), 1)
  assert.equal(etat.ecritures.length, 0)
  assert.match(sorties.join('\n'), /1 perte\(s\) : rien n'est écrit pour ce compte, ses listes restent en service/)
})

test('un bien introuvable bloque le compte, et `--ignorer-bien=` lève le blocage sur décision', async () => {
  const config = { ...CONFIG, 'ref-vieux': { intervention: liste({ email_lines: 'gardien@exemple.fr' }) } }
  const bloque = compte({ agent_alert_config: [{ user_id: COMPTE, config, updated_at: MAJ }] })
  const s1 = []
  assert.equal(await lancer({ argv: [], db: bloque.db, ecrire: t => s1.push(t) }), 1)
  assert.match(s1.join('\n'), /bien ref-vieux : bien_introuvable/)
  const decide = compte({ agent_alert_config: [{ user_id: COMPTE, config, updated_at: MAJ }] })
  const s2 = []
  assert.equal(await lancer({ argv: ['--go', '--ignorer-bien=ref-vieux'], db: decide.db, ecrire: t => s2.push(t) }), 0)
  assert.match(s2.join('\n'), /bien\(s\) ignoré\(s\) sur décision : ref-vieux/)
})

test('à blanc, il valide ce que le `--go` écrirait : des réglages en base non réécrivables bloquent dès l\'à blanc (constat 6)', async () => {
  const { db, etat } = compte({ notifications_reglages: [{ user_id: COMPTE, evenements: { code_disparu: { push: true } }, plages: [] }] })
  const sorties = []
  const config = { 'ref-1': { intervention: sms('06 00 00 00 01') } }
  etat.tables.agent_alert_config[0].config = config
  assert.equal(await lancer({ argv: [], db, ecrire: t => sorties.push(t) }), 1)
  assert.match(sorties.join('\n'), /non réécrivables/)
  assert.equal(etat.ecritures.length, 0)
})

test('les appareils, les permis et les autres comptes se lisent comme au point d\'envoi', async () => {
  const config = { 'ref-1': { intervention: sms('06 00 00 00 01') } }
  // Un appareil : le SMS du titulaire devient sa notification, et c'est dit.
  const equipe = compte({ agent_alert_config: [{ user_id: COMPTE, config, updated_at: MAJ }], push_abonnements: [{ id: 'p1', user_id: COMPTE }] })
  const s1 = []
  assert.equal(await lancer({ argv: [], db: equipe.db, ecrire: t => s1.push(t) }), 0)
  assert.match(s1.join('\n'), /5 envoi\(s\) SMS de liste deviennent une notification/)
  // Le SMS coupé sur son profil : perte, rien d'écrit.
  const coupe = compte({ agent_alert_config: [{ user_id: COMPTE, config, updated_at: MAJ }] })
  coupe.etat.tables.profiles[0].notify_sms = false
  const s2 = []
  assert.equal(await lancer({ argv: ['--go'], db: coupe.db, ecrire: t => s2.push(t) }), 1)
  assert.deepEqual([coupe.etat.ecritures.length, /sms_coupe_sur_le_profil/.test(s2.join('\n'))], [0, true])
  // Membre d'un autre compte : perte dite, rien d'écrit.
  const ailleurs = compte({ agent_alert_config: [{ user_id: COMPTE, config, updated_at: MAJ }] })
  ailleurs.etat.tables.profiles.push({ account_user_id: AUTRE, member_user_id: COMPTE, is_owner: false, access_mode: 'compte' })
  const s3 = []
  assert.equal(await lancer({ argv: ['--go'], db: ailleurs.db, ecrire: t => s3.push(t) }), 1)
  assert.deepEqual([ailleurs.etat.ecritures.length, /personne_sur_plusieurs_comptes/.test(s3.join('\n'))], [0, true])
})

test('une lecture en panne arrête le compte, sans rien écrire', async () => {
  for (const table of ['properties', 'profiles', 'push_abonnements', 'notifications_reglages', 'notifications_contacts']) {
    const { db, etat } = compte()
    const panneDe = base({}, { pannes: [table] }).db
    const mixte = { from: (t) => (t === table ? panneDe.from(t) : db.from(t)) }
    const code = await lancer({ argv: ['--go'], db: mixte })
    assert.deepEqual([code, etat.ecritures.length], [1, 0], table)
  }
  const { db, etat } = compte()
  assert.equal(await lancer({ argv: ['--go'], db, destinataires: async () => ({ ok: false }) }), 1)
  assert.equal(etat.ecritures.length, 0)
})

test('les contacts existants se lisent PAR CURSEUR : une adresse désinscrite au-delà de la première page n\'est pas recréée (constat 8)', async () => {
  const existants = Array.from({ length: 600 }, (_, i) => ({ id: `x${String(i).padStart(4, '0')}`, compte_id: COMPTE, email: `autre${i}@exemple.fr`, telephone: null, biens: [A], alertes: ['urgences'], desinscrit_le: null }))
  existants.push({ id: 'x9999', compte_id: COMPTE, email: 'gardien@exemple.fr', telephone: null, biens: [B], alertes: ['urgences'], desinscrit_le: '2026-11-09' })
  const config = { 'ref-1': { intervention: liste({ email_lines: 'gardien@exemple.fr' }) } }
  const { db, etat } = compte({ agent_alert_config: [{ user_id: COMPTE, config, updated_at: MAJ }], notifications_contacts: existants })
  assert.equal(await lancer({ argv: ['--go'], db }), 0)
  assert.equal(etat.tables.notifications_contacts.length, 601, 'aucun contact recréé pour l\'adresse désinscrite')
})

test('`--compte=` ne reprend que ce compte ; un compte sans liste active ne compte pas', async () => {
  const { db, etat } = compte({ agent_alert_config: [{ user_id: COMPTE, config: CONFIG, updated_at: MAJ }, { user_id: AUTRE, config: { 'ref-9': { intervention: liste({ email_enabled: false, email_lines: 'x@exemple.fr' }) } } }] })
  const sorties = []
  await lancer({ argv: [`--compte=${AUTRE}`], db, ecrire: t => sorties.push(t) })
  assert.match(sorties.join('\n'), /0 compte\(s\) avec des listes actives/)
  assert.equal(etat.ecritures.length, 0)
})
