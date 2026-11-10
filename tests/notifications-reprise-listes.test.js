// tests/notifications-reprise-listes.test.js — la reprise des listes d'alertes (PWA lot 2c-3, étape 2).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §16.3, Q25 et Q29 · KB : docs/kb/pwa.md §12.2
//
// Ce que ce fichier prouve, en APPELANT le module et le script (REVIEW.md règle 20) :
//   1. ce que délivrait une liste, et seulement ça : un canal décoché ne devient rien ;
//   2. le titulaire et les membres couverts → leurs réglages ; les autres → des
//      contacts, un par adresse et par ensemble d'alertes ;
//   3. la vérification : personne ne perd un destinataire, et une perte bloque ;
//   4. le script : à blanc par défaut, refusé tant que les listes envoient,
//      rejouable, et aucune adresse en clair dans son compte rendu.

const test = require('node:test')
const assert = require('node:assert/strict')

const reprise = require('../lib/notifications/reprise-listes')
const { executer } = require('../scripts/reprendre-listes-alertes')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const URGENCES = ['urgence_ia', 'code_non_resolu', 'menage_refuse', 'disponibilites_modifiees', 'evaluation_voyageur']

const liste = (o = {}) => ({ sms_enabled: false, sms_lines: '', email_enabled: true, email_lines: '', ...o })

// ─── 1. Ce que délivrait une liste ──────────────────────────────────────────

test('une ligne de liste se lit comme à l\'envoi : « Nom : valeur », un numéro ou un e-mail valide, le reste ignoré', () => {
  assert.deepEqual(reprise.lireListe('Gardien : +33 6 11 11 11 11\n\n  pas un numéro\n0612345678', 'sms').map(l => [l.nom, l.valeur]),
    [['Gardien', '+33 6 11 11 11 11'], ['', '0612345678']])
  assert.deepEqual(reprise.lireListe('Jean : jean@exemple.fr\nmauvais@\nmarie@exemple.fr', 'email').map(l => l.valeur), ['jean@exemple.fr', 'marie@exemple.fr'])
})

test('LE TEST QUI COMPTE : un canal décoché n\'envoyait rien — il ne devient rien', () => {
  const config = {
    'ref-1': {
      intervention: liste({ email_lines: 'g@exemple.fr', sms_enabled: false, sms_lines: '+33611111111' }),
      info_unknown: liste({ email_enabled: false, email_lines: 'i@exemple.fr' })
    },
    mode: 'auto',
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
const effectifs = new Map()
const planifier = (lignes, o = {}) => reprise.planifier({ lignes, biensParRef: biens, personnes: [titulaire, membre],
  destinataire: tousDestinataires, reglages: effectifs, ...o })
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

test('LE TEST QUI COMPTE : l\'adresse du TITULAIRE coche le canal dans ses réglages, sans contact (sinon tout en double)', () => {
  const p = planifier(lignesDe({ 'ref-1': { intervention: liste({ sms_enabled: true, sms_lines: '06 00 00 00 01', email_lines: 'HOTE@exemple.fr' }) } }))
  assert.deepEqual(p.contacts, [])
  assert.deepEqual(p.cocher.get(COMPTE), URGENCES.flatMap(c => [`${c}|email`, `${c}|sms`]).sort())
  assert.equal(p.reglagesApres.get(COMPTE).urgence_ia.sms, true)
  assert.equal(p.pertes.length, 0)
  // La même règle que pour un membre : un événement qui ne lui irait pas passe
  // par un contact, et n'est pas coché chez lui.
  const sauf = planifier(lignesDe({ 'ref-1': { intervention: liste({ email_lines: 'hote@exemple.fr' }) } }), { destinataire: (u, code) => code !== 'menage_refuse' })
  assert.deepEqual([sauf.contacts.length, sauf.cocher.get(COMPTE).includes('menage_refuse|email'), sauf.pertes.length], [1, false, 0])
})

test('LE TEST QUI COMPTE (Q29) : un membre couvert → ses réglages seuls ; couvert en partie → ses réglages ET un contact', () => {
  const lignes = lignesDe({ 'ref-1': { intervention: liste({ email_lines: 'membre@exemple.fr' }) } })
  const couvert = planifier(lignes, { destinataire: () => true })
  assert.deepEqual(couvert.contacts, [])
  assert.deepEqual(couvert.cocher.get(MEMBRE), URGENCES.map(c => `${c}|email`).sort())
  // Il a les messages, pas les ménages : l'urgence de l'IA par ses réglages, le
  // reste par le contact — et ses réglages ne se cochent QUE pour ce qu'il reçoit.
  const partiel = planifier(lignes, { destinataire: (u, code) => u === COMPTE || code === 'urgence_ia' })
  assert.deepEqual(partiel.contacts.map(c => [c.email, c.alertes, c.biens]), [['membre@exemple.fr', ['urgences'], [A]]])
  assert.deepEqual(partiel.cocher.get(MEMBRE), ['urgence_ia|email'])
  assert.equal(partiel.pertes.length, 0)
  // Aucun droit : un contact seul, ses réglages intacts.
  const aucun = planifier(lignes, { destinataire: (u) => u === COMPTE })
  assert.deepEqual([aucun.contacts.length, aucun.cocher.has(MEMBRE), aucun.pertes.length], [1, false, 0])
})

test('les droits se jugent BIEN PAR BIEN : un membre limité à un bien a ses réglages pour celui-là, un contact pour l\'autre', () => {
  const p = planifier(lignesDe({
    'ref-1': { intervention: liste({ email_lines: 'membre@exemple.fr' }) },
    'ref-2': { intervention: liste({ email_lines: 'membre@exemple.fr' }) }
  }), { destinataire: (u, code, bien) => u === COMPTE || bien === A })
  assert.deepEqual(p.contacts.map(c => [c.email, c.biens]), [['membre@exemple.fr', [B]]])
  assert.equal(p.pertes.length, 0)
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

test('un bien introuvable est dit, et ne compte pas comme une perte (aucun événement ne peut plus y naître)', () => {
  const p = planifier(lignesDe({ 'ref-supprime': { intervention: liste({ email_lines: 'g@exemple.fr' }) } }))
  assert.deepEqual([p.inconnus, p.contacts.length, p.avant, p.pertes.length], [['ref-supprime'], 0, 0, 0])
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
  const sms = lignesDe({ 'ref-1': { intervention: liste({ email_enabled: false, sms_enabled: true, sms_lines: '+33600000001' }) } })
  // Le titulaire a coupé le SMS de son propre profil : la liste l'envoyait quand même, plus rien ne partirait.
  const coupe = reprise.planifier({ lignes: sms, biensParRef: biens, personnes: [{ ...titulaire, smsPermis: false }], destinataire: tousDestinataires, reglages: effectifs })
  assert.deepEqual([...new Set(coupe.pertes.map(a => a.motif))], ['sms_coupe_sur_le_profil'])
  assert.equal(coupe.pertes.length, 5)
  // Un appareil abonné et la notification décochée : le SMS ne part pas (Q11), rien d'autre non plus.
  const muet = new Map([[COMPTE, { evenements: Object.fromEntries(URGENCES.map(c => [c, { push: false }])) }]])
  const appareil = reprise.planifier({ lignes: sms, biensParRef: biens, personnes: [{ ...titulaire, appareils: 1 }], destinataire: tousDestinataires, reglages: muet })
  assert.deepEqual([...new Set(appareil.pertes.map(a => a.motif))], ['appareil_sans_notification'])
  // La notification cochée : elle remplace le SMS, ce n'est pas une perte — et c'est compté.
  const notif = new Map([[COMPTE, { evenements: Object.fromEntries(URGENCES.map(c => [c, { push: true }])) }]])
  const remplace = reprise.planifier({ lignes: sms, biensParRef: biens, personnes: [{ ...titulaire, appareils: 2 }], destinataire: tousDestinataires, reglages: notif })
  assert.deepEqual([remplace.pertes.length, remplace.parNotification], [0, 5])
  // L'e-mail coupé sur le profil d'un membre destinataire : perte.
  const mail = lignesDe({ 'ref-1': { intervention: liste({ email_lines: 'membre@exemple.fr' }) } })
  const m = reprise.planifier({ lignes: mail, biensParRef: biens, personnes: [titulaire, { ...membre, emailPermis: false }], destinataire: () => true, reglages: effectifs })
  assert.deepEqual([m.pertes.length, m.pertes[0].motif], [5, 'email_coupe_sur_le_profil'])
})

test('un canal resté décoché dans les réglages n\'est pas une perte : la reprise le coche', () => {
  const lignes = lignesDe({ 'ref-1': { intervention: liste({ email_lines: 'hote@exemple.fr' }) } })
  const coupe = planifier(lignes, { reglages: new Map([[COMPTE, { evenements: Object.fromEntries(URGENCES.map(c => [c, { email: false, push: true }])) }]]) })
  assert.equal(coupe.pertes.length, 0)
  assert.deepEqual(coupe.reglagesApres.get(COMPTE).menage_refuse, { email: true, push: true })
})

test('une adresse se montre masquée dans un compte rendu', () => {
  assert.equal(reprise.masquer('email', 'jean.dupont@exemple.fr'), 'j***@exemple.fr')
  assert.equal(reprise.masquer('sms', '+33612345678'), '+336****5678')
  assert.equal(reprise.masquer('sms', '123'), '****')
})

// ─── 3. Le script ───────────────────────────────────────────────────────────

function base (tables = {}, { pannes = [] } = {}) {
  const etat = { tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map(l => ({ ...l }))])), ecritures: [] }
  const db = {
    from (table) {
      if (!etat.tables[table]) etat.tables[table] = []
      const q = { f: [], op: 'select', limite: null }
      const garde = () => {
        let l = etat.tables[table].filter(r => q.f.every(([op, c, v]) =>
          op === 'eq' ? r[c] === v : op === 'in' ? v.includes(r[c]) : op === 'gt' ? String(r[c]) > String(v) : true))
        if (q.ordre) l = [...l].sort((a, b) => String(a[q.ordre]).localeCompare(String(b[q.ordre])))
        if (q.limite != null) l = l.slice(0, q.limite)
        return l
      }
      const executer = () => {
        if (pannes.includes(table)) return { data: null, error: { message: 'panne' } }
        if (q.op === 'insert') { etat.ecritures.push({ table, op: 'insert', rows: q.rows }); etat.tables[table].push(...q.rows.map(r => ({ desinscrit_le: null, ...r }))); return { data: null, error: null } }
        if (q.op === 'upsert') {
          etat.ecritures.push({ table, op: 'upsert', row: q.row })
          const ex = etat.tables[table].find(r => r.user_id === q.row.user_id)
          if (ex) Object.assign(ex, q.row); else etat.tables[table].push({ ...q.row })
          return { data: null, error: null }
        }
        return { data: garde().map(r => ({ ...r })), error: null }
      }
      const chaine = {
        select () { return chaine },
        eq (c, v) { q.f.push(['eq', c, v]); return chaine },
        in (c, v) { q.f.push(['in', c, v]); return chaine },
        gt (c, v) { q.f.push(['gt', c, v]); return chaine },
        order (c) { q.ordre = c; return chaine },
        limit (k) { q.limite = k; return chaine },
        insert (rows) { q.op = 'insert'; q.rows = [].concat(rows); return chaine },
        upsert (row) { q.op = 'upsert'; q.row = row; return chaine },
        maybeSingle () { const r = executer(); return Promise.resolve({ data: r.data ? (r.data[0] || null) : null, error: r.error }) },
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
      }
      return chaine
    }
  }
  return { db, etat }
}

const CONFIG = {
  'ref-1': { intervention: liste({ email_lines: 'Gardien : gardien@exemple.fr\nHôte : hote@exemple.fr', sms_enabled: true, sms_lines: 'Gardien : +33 6 11 11 11 11' }) }
}
function compte (o = {}) {
  return base({
    agent_alert_config: [{ user_id: COMPTE, config: CONFIG }],
    properties: [{ id: A, user_id: COMPTE, provider_property_id: 'ref-1', archive_le: null }],
    profiles: [{ account_user_id: COMPTE, member_user_id: COMPTE, is_owner: true, access_mode: 'compte', email: 'hote@exemple.fr', phone: '+33600000001' }],
    notifications_reglages: [{ user_id: COMPTE, evenements: { avis: { push: false, email: false, sms: false, urgent: false } }, plages: [{ debut: '22:00', fin: '07:00', jours: [1, 2, 3, 4, 5] }], langue: 'fr' }],
    notifications_contacts: [],
    ...o
  })
}
const seulTitulaire = async ({ compte: c }) => ({ ok: true, personnes: [{ userId: c, titulaire: true }] })

test('LE TEST QUI COMPTE : `--go` est refusé tant que les anciennes listes envoient — rien n\'est écrit', async () => {
  const { db, etat } = compte()
  const sorties = []
  const code = await executer({ argv: ['--go'], db, base: 'STAGING', listesCoupees: undefined, destinataires: seulTitulaire, ecrire: t => sorties.push(t) })
  assert.equal(code, 2)
  assert.equal(etat.ecritures.length, 0)
  assert.match(sorties[0], /en double/)
})

test('à blanc : il dit ce qu\'il ferait, n\'écrit rien, et n\'affiche aucune adresse en clair', async () => {
  const { db, etat } = compte()
  const sorties = []
  const code = await executer({ argv: [], db, base: 'STAGING', listesCoupees: false, destinataires: seulTitulaire, ecrire: t => sorties.push(t) })
  assert.equal(code, 0)
  assert.equal(etat.ecritures.length, 0)
  const texte = sorties.join('\n')
  assert.match(texte, /3 adresse\(s\) de liste, 2 contact\(s\) à créer, 0 déjà présent\(s\), réglages cochés pour 1 personne\(s\) \(titulaire\)/)
  assert.doesNotMatch(texte, /gardien@exemple\.fr|hote@exemple\.fr|\+33611111111|\+33 6 11/)
  assert.match(texte, /g\*\*\*@exemple\.fr/)
})

test('LE TEST QUI COMPTE : `--go`, les listes coupées — les contacts sont créés, ses réglages cochés SANS perdre ses plages ni ses choix ; rejoué, rien ne double', async () => {
  const { db, etat } = compte()
  const ecrire = () => {}
  assert.equal(await executer({ argv: ['--go'], db, base: 'STAGING', listesCoupees: true, destinataires: seulTitulaire, ecrire }), 0)
  assert.deepEqual(etat.tables.notifications_contacts.map(c => [c.compte_id, c.nom, c.email, c.telephone, c.biens, c.alertes]).sort(), [
    [COMPTE, 'Gardien', 'gardien@exemple.fr', null, [A], ['urgences']],
    [COMPTE, 'Gardien', null, '+33611111111', [A], ['urgences']]
  ].sort())
  const r = etat.tables.notifications_reglages[0]
  assert.equal(r.evenements.urgence_ia.email, true)
  assert.deepEqual(r.evenements.avis, { push: false, email: false, sms: false, urgent: false }, 'ses choix sur les autres événements restent')
  assert.deepEqual(r.plages, [{ debut: '22:00', fin: '07:00', jours: [1, 2, 3, 4, 5] }], 'ses plages restent')
  assert.equal(r.langue, 'fr', 'sa langue reste')
  // Rejoué : rien de nouveau.
  const avant = etat.ecritures.filter(w => w.table === 'notifications_contacts').length
  assert.equal(await executer({ argv: ['--go'], db, base: 'STAGING', listesCoupees: true, destinataires: seulTitulaire, ecrire }), 0)
  assert.equal(etat.ecritures.filter(w => w.table === 'notifications_contacts').length, avant)
  assert.equal(etat.tables.notifications_contacts.length, 2)
})

test('une perte bloque le compte : rien n\'est écrit, sortie 1', async () => {
  const { db, etat } = compte()
  const planifier = (o) => ({ ...reprise.planifier(o), pertes: [{ canal: 'email', valeur: 'g@exemple.fr', code: 'urgence_ia' }] })
  const sorties = []
  const code = await executer({ argv: ['--go'], db, base: 'STAGING', listesCoupees: true, destinataires: seulTitulaire, planifier, ecrire: t => sorties.push(t) })
  assert.equal(code, 1)
  assert.equal(etat.ecritures.length, 0)
  assert.match(sorties.join('\n'), /1 perte\(s\) : rien n'est écrit pour ce compte/)
})

test('une lecture en panne arrête le compte, sans rien écrire', async () => {
  for (const table of ['properties', 'profiles', 'push_abonnements', 'notifications_reglages', 'notifications_contacts']) {
    const { db, etat } = compte()
    const panneDe = base({}, { pannes: [table] }).db
    const mixte = { from: (t) => (t === table ? panneDe.from(t) : db.from(t)) }
    const code = await executer({ argv: ['--go'], db: mixte, base: 'STAGING', listesCoupees: true, destinataires: seulTitulaire, ecrire: () => {} })
    assert.deepEqual([code, etat.ecritures.length], [1, 0], table)
  }
  const droitsEnPanne = async () => ({ ok: false })
  const { db, etat } = compte()
  assert.equal(await executer({ argv: ['--go'], db, base: 'STAGING', listesCoupees: true, destinataires: droitsEnPanne, ecrire: () => {} }), 1)
  assert.equal(etat.ecritures.length, 0)
})

test('les appareils et les permis se lisent comme au point d\'envoi : le SMS du titulaire équipé devient sa notification, et c\'est dit', async () => {
  const config = { 'ref-1': { intervention: liste({ email_enabled: false, sms_enabled: true, sms_lines: '06 00 00 00 01' }) } }
  const { db, etat } = compte({ agent_alert_config: [{ user_id: COMPTE, config }], push_abonnements: [{ id: 'p1', user_id: COMPTE, endpoint: 'https://push.exemple/1' }] })
  const sorties = []
  assert.equal(await executer({ argv: [], db, base: 'STAGING', listesCoupees: false, destinataires: seulTitulaire, ecrire: t => sorties.push(t) }), 0)
  assert.match(sorties.join('\n'), /5 envoi\(s\) SMS de liste deviennent une notification/)
  // Le titulaire a coupé le SMS sur son profil : perte, rien d'écrit.
  const coupe = compte({ agent_alert_config: [{ user_id: COMPTE, config }] })
  coupe.etat.tables.profiles[0].notify_sms = false
  const s2 = []
  assert.equal(await executer({ argv: ['--go'], db: coupe.db, base: 'STAGING', listesCoupees: true, destinataires: seulTitulaire, ecrire: t => s2.push(t) }), 1)
  assert.equal(coupe.etat.ecritures.length, 0)
  assert.match(s2.join('\n'), /sms_coupe_sur_le_profil/)
  assert.doesNotMatch(s2.join('\n'), /0600000001|\+33600000001/)
  assert.equal(etat.ecritures.length, 0)
})

test('`--compte=` ne reprend que ce compte ; un compte sans liste active ne compte pas', async () => {
  const AUTRE = '33333333-3333-4333-8333-333333333333'
  const { db, etat } = compte({ agent_alert_config: [{ user_id: COMPTE, config: CONFIG }, { user_id: AUTRE, config: { 'ref-9': { intervention: liste({ email_enabled: false, email_lines: 'x@exemple.fr' }) } } }] })
  const sorties = []
  await executer({ argv: [`--compte=${AUTRE}`], db, base: 'STAGING', listesCoupees: false, destinataires: seulTitulaire, ecrire: t => sorties.push(t) })
  assert.match(sorties.join('\n'), /0 compte\(s\) avec des listes actives/)
  assert.equal(etat.ecritures.length, 0)
})
