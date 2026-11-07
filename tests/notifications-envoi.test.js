// tests/notifications-envoi.test.js — le point d'envoi unique des événements de l'hôte (PWA lot 2c-1).
// Spec : docs/specs/spec-pwa-lot2-notifications.md §5, §7 et §16 · KB : docs/kb/pwa.md §10
//
// Ce que ce fichier prouve, en APPELANT les modules (REVIEW.md règle 20) :
//   1. les textes : trois langues, le bien sans texte de voyageur, l'essai qui
//      se dit essai, l'e-mail échappé, le regroupement ;
//   2. les destinataires : titulaire et membres selon leurs droits, revérifiés
//      (domaine, écriture pour la surréservation, bien, profil actif, invitation
//      acceptée, jamais un accès par lien) ;
//   3. l'envoi : la notification remplace le SMS (Q11), le dernier appareil
//      prévient par e-mail (Q13) ;
//   4. la décision appliquée : maintenant, ou la file dans la langue de la
//      personne ; un sujet = une ligne ;
//   5. la file : une ligne ne part qu'une fois, un message regroupé par personne ;
//   6. l'endpoint : l'essai et la file ne touchent que l'appelant.
//
// ⚠ TOUS LES INSTANTS SONT FIGÉS ET INJECTÉS.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const textes = require('../lib/notifications/textes')
const { destinataires } = require('../lib/notifications/destinataires')
const { envoyerMaintenant } = require('../lib/notifications/envoi')
const { notifier } = require('../lib/notifications/notifier')
const file = require('../lib/notifications/file')

const COMPTE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const AUTRE = '33333333-3333-4333-8333-333333333333'
const hiver = (jourHeure) => Date.parse(`${jourHeure}:00+01:00`)
const MIDI = hiver('2026-11-11T12:00')
const NUIT = hiver('2026-11-11T00:30')

// ─── Une base factice générique ─────────────────────────────────────────────
// Elle applique VRAIMENT ses filtres (eq, in, lte, order, limit) : un double plus
// permissif que la base validerait du code qui ne tourne pas (REVIEW.md règle 22).
function base (tables = {}, { pannes = [] } = {}) {
  const etat = { tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map(l => ({ ...l }))])), ecritures: [] }
  let n = 0
  const db = {
    from (table) {
      if (!etat.tables[table]) etat.tables[table] = []
      const q = { f: [], op: 'select', ordre: null, limite: null, retour: false }
      const garde = () => {
        let l = etat.tables[table].filter(r => q.f.every(([op, c, v]) =>
          op === 'eq' ? r[c] === v : op === 'in' ? v.includes(r[c]) : op === 'lte' ? String(r[c]) <= String(v) : true))
        if (q.ordre) l = [...l].sort((a, b) => String(a[q.ordre]).localeCompare(String(b[q.ordre])))
        if (q.limite != null) l = l.slice(0, q.limite)
        return l
      }
      const executer = () => {
        if (pannes.includes(table)) return { data: null, error: { message: 'panne' } }
        if (q.op === 'upsert') {
          etat.ecritures.push({ table, op: 'upsert', row: q.row, opts: q.opts })
          const cles = String(q.opts && q.opts.onConflict || 'id').split(',')
          const ex = etat.tables[table].find(r => cles.every(k => r[k] === q.row[k]))
          if (ex) Object.assign(ex, q.row)
          else etat.tables[table].push({ id: `id-${++n}`, ...q.row })
          return { data: null, error: null }
        }
        if (q.op === 'delete') {
          const cibles = garde()
          etat.ecritures.push({ table, op: 'delete', n: cibles.length })
          etat.tables[table] = etat.tables[table].filter(r => !cibles.includes(r))
          return { data: q.retour ? cibles.map(r => ({ ...r })) : null, error: null }
        }
        return { data: garde().map(r => ({ ...r })), error: null }
      }
      const chaine = {
        select () { if (q.op === 'delete') q.retour = true; return chaine },
        eq (c, v) { q.f.push(['eq', c, v]); return chaine },
        in (c, v) { q.f.push(['in', c, v]); return chaine },
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
const membre = (o = {}) => ({ id: 'p-membre', account_user_id: COMPTE, member_user_id: MEMBRE, is_owner: false, active: true, accepted_at: '2026-02-01', access_mode: 'compte', email: 'membre@exemple.fr', phone: '+33600000002', ...o })
const droits = (o = {}) => ({ profile_id: 'p-membre', account_user_id: COMPTE, property_scope: 'all', property_ids: [], property_refs: [],
  reservations: 'none', menages: 'none', prestataires: 'none', messages: 'none', avis: 'none', reglages: 'none', facturation: 'none', equipe: 'none', ...o })

// ─── 1. Les textes ──────────────────────────────────────────────────────────

test('les textes : trois langues, repli sur le français, le bien et les nuits, jamais un texte vide', () => {
  const d = { bien: 'La bulle', nuits: ['2026-12-24', '2026-12-25'] }
  assert.deepEqual(textes.rediger('surreservation', 'fr', d), { titre: 'Surréservation — La bulle', corps: '2 nuit(s) en conflit : 24/12, 25/12. Ouvrez HôteSmart pour arrêter cette alerte.' })
  assert.match(textes.rediger('surreservation', 'en', d).corps, /12\/24, 12\/25/)
  assert.match(textes.rediger('surreservation', 'es', d).titre, /^Sobreventa — La bulle$/)
  assert.equal(textes.rediger('surreservation', 'de', d).titre, 'Surréservation — La bulle', 'langue inconnue : le français')
  assert.match(textes.rediger('surreservation', 'fr', { ...d, relance: true }).titre, /^Relance — /)
  assert.equal(textes.rediger('inconnu', 'fr', d), null, 'pas de texte : null, jamais un vide')
  // Beaucoup de nuits : les premières, puis « et N autre(s) ».
  const longues = textes.rediger('surreservation', 'fr', { bien: 'B', nuits: ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06'] })
  assert.match(longues.corps, /01\/12, 02\/12, 03\/12, 04\/12 et 2 autre\(s\)/)
})

test('un essai se dit essai, dans chaque langue — personne ne croit à une vraie surréservation', () => {
  const ex = textes.exemple('surreservation', MIDI)
  assert.equal(ex.essai, true)
  assert.deepEqual(ex.nuits, ['2026-11-11', '2026-11-12'])
  assert.match(textes.rediger('surreservation', 'fr', ex).titre, /^Essai — Surréservation — Logement d’essai$/)
  assert.match(textes.rediger('surreservation', 'en', ex).titre, /^Test — /)
  assert.match(textes.rediger('surreservation', 'es', ex).titre, /^Prueba — /)
  assert.equal(textes.exemple('inconnu'), null)
})

test('l\'e-mail : tout est échappé, le lien n\'est qu\'un chemin du site, le sujet tient sur une ligne', () => {
  const m = textes.email({ langue: 'fr', titre: 'A <img src=x>\nBcc: x@y', corps: 'l1\n<b>l2</b>', chemin: '/pages/aujourdhui', site: 'https://s.test/' })
  assert.doesNotMatch(m.html, /<img|<b>/)
  assert.match(m.html, /href="https:\/\/s\.test\/pages\/aujourdhui"/)
  assert.doesNotMatch(m.sujet, /[\r\n]/)
  for (const chemin of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', null]) {
    assert.doesNotMatch(textes.email({ langue: 'fr', titre: 't', corps: 'c', chemin, site: 'https://s.test' }).html, /href=/, String(chemin))
  }
  assert.ok(textes.sms({ titre: 't', corps: 'x'.repeat(500) }).length <= 300)
  const dernier = textes.emailDernierAppareil({ langue: 'en', site: 'https://s.test' })
  assert.match(dernier.sujet, /no longer reach you/)
  assert.match(dernier.html, /settings\?onglet=notifications/)
})

test('le regroupement : un seul élément reste tel quel ; au-delà de cinq, « et N autre(s) »', () => {
  assert.deepEqual(textes.regrouper('fr', [{ titre: 'T', corps: 'C' }]), { titre: 'T', corps: 'C' })
  const sept = Array.from({ length: 7 }, (_, i) => ({ titre: `T${i}`, corps: 'C' }))
  const r = textes.regrouper('fr', sept)
  assert.equal(r.titre, '7 alerte(s) pendant vos heures calmes')
  assert.equal(r.corps.split('\n').length, 6)
  assert.match(r.corps, /et 2 autre\(s\)$/)
  assert.equal(textes.regrouper('es', sept).titre, '7 alerta(s) durante sus horas tranquilas')
})

// ─── 2. Les destinataires ───────────────────────────────────────────────────

test('LE TEST QUI COMPTE : le titulaire, et seulement les membres qui ont le domaine sur ce bien', async () => {
  const cas = [
    [droits({ messages: 'read' }), 'urgence_ia', null, true, 'domaine en lecture'],
    [droits({ messages: 'none' }), 'urgence_ia', null, false, 'sans le domaine'],
    [droits({ reservations: 'read' }), 'surreservation', null, false, 'la surréservation exige l\'écriture'],
    [droits({ reservations: 'write' }), 'surreservation', null, true, 'qui peut acquitter'],
    [droits({ messages: 'write' }), 'pause_automatique', null, false, 'titulaire seul (k)'],
    [droits({ messages: 'read', property_scope: 'selected', property_ids: ['uuid-1'], property_refs: ['ref-1'] }), 'urgence_ia', { ref: 'ref-2' }, false, 'bien hors périmètre'],
    [droits({ messages: 'read', property_scope: 'selected', property_ids: ['uuid-1'], property_refs: ['ref-1'] }), 'urgence_ia', { ref: 'ref-1' }, true, 'bien dans le périmètre']
  ]
  for (const [perm, code, bien, attendu, nom] of cas) {
    const { db } = base({ profiles: [proprio, membre()], profile_permissions: [perm] })
    const r = await destinataires({ compte: COMPTE, code, bien, db })
    assert.equal(r.ok, true, nom)
    assert.equal(r.personnes[0].userId, COMPTE, `${nom} : le titulaire d'abord`)
    assert.equal(r.personnes[0].email, 'hote@exemple.fr')
    assert.equal(r.personnes.some(p => p.userId === MEMBRE), attendu, nom)
  }
})

test('jamais : un profil désactivé, une invitation non acceptée, un accès par lien, un autre compte', async () => {
  const perm = droits({ messages: 'write' })
  for (const [profil, nom] of [
    [membre({ active: false }), 'désactivé'],
    [membre({ accepted_at: null }), 'invitation non acceptée'],
    [membre({ access_mode: 'lien', member_user_id: null }), 'accès par lien'],
    [membre({ account_user_id: AUTRE }), 'membre d\'un autre compte']
  ]) {
    const { db } = base({ profiles: [proprio, profil], profile_permissions: [perm] })
    const r = await destinataires({ compte: COMPTE, code: 'urgence_ia', db })
    assert.deepEqual(r.personnes.map(p => p.userId), [COMPTE], nom)
  }
  // Une panne de lecture se dit, elle ne vaut pas « personne à prévenir ».
  const { db } = base({ profiles: [proprio] }, { pannes: ['profiles'] })
  assert.deepEqual(await destinataires({ compte: COMPTE, code: 'urgence_ia', db }), { ok: false, motif: 'lecture_impossible' })
  assert.equal((await destinataires({ compte: COMPTE, code: 'inconnu', db })).motif, 'evenement_inconnu')
})

// ─── 3. L'envoi ─────────────────────────────────────────────────────────────

function envois ({ push = { ok: true, envoyes: 1, morts: 0, echecs: 0, aucun_appareil: false }, appareils = 1, cles = { publique: 'p' } } = {}) {
  const journal = []
  return {
    journal,
    deps: {
      cles,
      envoyerPush: async (o) => { journal.push(['push', o.userId, o.message.notification.title]); return push },
      compterAppareils: async () => { journal.push(['compter']); return appareils === null ? { ok: false } : { ok: true, n: appareils } },
      envoyerEmail: async (to, sujet) => { journal.push(['email', to, sujet]); return { ok: true } },
      envoyerSms: async (to, texte, ref, ctx, compte) => { journal.push(['sms', to, ctx, compte]); return { success: true } }
    }
  }
}
const PERSONNE = { userId: COMPTE, email: 'hote@exemple.fr', telephone: '+33600000001' }
const CONTENU = { titre: 'Surréservation — La bulle', corps: 'c', chemin: '/pages/aujourdhui', sujet: 's', langue: 'fr' }

test('LE TEST QUI COMPTE : la notification remplace le SMS — jamais de SMS à qui a un appareil (Q11)', async () => {
  const avec = envois()
  const b = await envoyerMaintenant({ personne: PERSONNE, canaux: ['push', 'email', 'sms'], contenu: CONTENU, compte: COMPTE, deps: avec.deps })
  assert.deepEqual([b.push, b.email, b.sms], [1, true, false])
  assert.ok(!avec.journal.some(j => j[0] === 'sms'))
  // Notification décochée pour l'événement, mais un appareil existe : pas de SMS non plus.
  const decoche = envois({ appareils: 2 })
  const b2 = await envoyerMaintenant({ personne: PERSONNE, canaux: ['email', 'sms'], contenu: CONTENU, compte: COMPTE, deps: decoche.deps })
  assert.equal(b2.sms, false)
  assert.ok(decoche.journal.some(j => j[0] === 'compter'))
  assert.ok(!decoche.journal.some(j => j[0] === 'push'), 'la notification décochée ne part pas')
  // Aucun appareil : le SMS part, par la clé DU COMPTE.
  const sans = envois({ push: { ok: true, envoyes: 0, morts: 0, echecs: 0, aucun_appareil: true } })
  const b3 = await envoyerMaintenant({ personne: PERSONNE, canaux: ['push', 'sms'], contenu: CONTENU, compte: COMPTE, deps: sans.deps })
  assert.equal(b3.sms, true)
  assert.deepEqual(sans.journal.find(j => j[0] === 'sms'), ['sms', '+33600000001', 'notification', COMPTE])
  // SMS décoché : jamais, même sans appareil.
  const b4 = await envoyerMaintenant({ personne: PERSONNE, canaux: ['push'], contenu: CONTENU, compte: COMPTE, deps: envois({ push: { ok: true, envoyes: 0, morts: 0, echecs: 0, aucun_appareil: true } }).deps })
  assert.equal(b4.sms, false)
})

test('ne pas savoir vaut « sans appareil » : un SMS de trop plutôt qu\'une alerte manquée', async () => {
  for (const [nom, o, canaux] of [
    ['lecture des appareils en panne', { push: { ok: false } }, ['push', 'sms']],
    ['comptage en panne', { appareils: null }, ['sms']],
    ['clés d\'envoi absentes', { cles: null }, ['push', 'sms']]
  ]) {
    const e = envois(o)
    const b = await envoyerMaintenant({ personne: PERSONNE, canaux, contenu: CONTENU, compte: COMPTE, deps: e.deps })
    assert.equal(b.sms, true, nom)
  }
})

test('LE TEST QUI COMPTE : le dernier appareil disparaît — un e-mail le dit, et le SMS part dès cet envoi (Q13)', async () => {
  const e = envois({ push: { ok: true, envoyes: 0, morts: 2, echecs: 0, aucun_appareil: false } })
  const b = await envoyerMaintenant({ personne: PERSONNE, canaux: ['push', 'sms'], contenu: { ...CONTENU, langue: 'es' }, compte: COMPTE, deps: e.deps })
  assert.equal(b.dernier_appareil, true)
  assert.equal(b.sms, true)
  const mail = e.journal.find(j => j[0] === 'email')
  assert.match(mail[2], /ya no le llegan/, 'dans la langue de la personne')
  // Un appareil mort sur deux : il en reste un, rien à dire, pas de SMS.
  const un = envois({ push: { ok: true, envoyes: 1, morts: 1, echecs: 0, aucun_appareil: false } })
  const b2 = await envoyerMaintenant({ personne: PERSONNE, canaux: ['push', 'sms'], contenu: CONTENU, compte: COMPTE, deps: un.deps })
  assert.deepEqual([b2.dernier_appareil, b2.sms], [false, false])
  assert.ok(!un.journal.some(j => j[0] === 'email'))
})

test('un envoi qui lève ne fait jamais lever l\'appelant', async () => {
  const deps = { cles: { publique: 'p' }, envoyerPush: async () => { throw new Error('x') }, envoyerEmail: async () => { throw new Error('x') }, envoyerSms: async () => { throw new Error('x') }, compterAppareils: async () => { throw new Error('x') } }
  const b = await envoyerMaintenant({ personne: PERSONNE, canaux: ['push', 'email', 'sms'], contenu: CONTENU, compte: COMPTE, deps })
  assert.ok(b.erreurs.length >= 2)
})

// ─── 4. La décision appliquée ───────────────────────────────────────────────

const NUIT_TOUS_LES_JOURS = { debut: '22:00', fin: '07:00', jours: [1, 2, 3, 4, 5, 6, 7] }

test('LE TEST QUI COMPTE : pendant les heures calmes, ce qui attend va dans la file, dans la langue de la personne', async () => {
  const { db, etat } = base({
    profiles: [proprio, membre()],
    profile_permissions: [droits({ reservations: 'write' })],
    notifications_reglages: [
      // Le titulaire a sorti la surréservation de ses urgences ; il est en plage.
      { user_id: COMPTE, evenements: { surreservation: { push: true, email: true, sms: false, urgent: false } }, plages: [NUIT_TOUS_LES_JOURS], langue: 'en' }
      // Le membre n'a rien réglé : les défauts, urgent, maintenant.
    ]
  })
  const e = envois()
  const b = await notifier({ compte: COMPTE, code: 'surreservation', bien: { ref: 'p1' }, donnees: { bien: 'La bulle', nuits: ['2026-12-24'] },
    chemin: '/pages/aujourdhui', sujet: 'surreservation:p1', rappel: true, maintenant: NUIT, db, deps: e.deps })
  assert.equal(b.ok, true)
  assert.deepEqual([b.destinataires, b.maintenant, b.en_attente], [2, 1, 1])
  const ligne = etat.tables.notifications_file[0]
  assert.equal(ligne.user_id, COMPTE)
  assert.deepEqual(ligne.canaux, ['push', 'email'])
  assert.equal(ligne.a, new Date(hiver('2026-11-11T07:00')).toISOString())
  assert.equal(ligne.contenu.titre, 'Overbooking — La bulle', 'rédigé dans SA langue')
  assert.equal(ligne.contenu.email, 'hote@exemple.fr')
  // Le membre, lui, est prévenu maintenant, en français.
  assert.deepEqual(e.journal.find(j => j[0] === 'push'), ['push', MEMBRE, 'Surréservation — La bulle'])
})

test('un sujet = une ligne : la relance remplace la ligne en attente au lieu d\'en empiler une', async () => {
  const { db, etat } = base({ profiles: [proprio], notifications_reglages: [{ user_id: COMPTE, evenements: { surreservation: { push: true, email: false, sms: false, urgent: false } }, plages: [NUIT_TOUS_LES_JOURS] }] })
  for (const relance of [false, true, true]) {
    await notifier({ compte: COMPTE, code: 'surreservation', donnees: { bien: 'B', nuits: ['2026-12-24'], relance }, chemin: '/', sujet: 'surreservation:p1', maintenant: NUIT, db, deps: envois().deps })
  }
  assert.equal(etat.tables.notifications_file.length, 1)
  assert.match(etat.tables.notifications_file[0].contenu.titre, /^Relance — /)
  assert.deepEqual(etat.ecritures.filter(w => w.op === 'upsert').map(w => w.opts.onConflict), ['user_id,sujet', 'user_id,sujet', 'user_id,sujet'])
})

test('des réglages illisibles ne rendent personne muet ; un événement sans texte ne part pas en blanc', async () => {
  const { db } = base({ profiles: [proprio] }, { pannes: ['notifications_reglages'] })
  const e = envois()
  const b = await notifier({ compte: COMPTE, code: 'surreservation', donnees: { bien: 'B', nuits: [] }, chemin: '/', sujet: 's', maintenant: NUIT, db, deps: e.deps })
  assert.equal(b.maintenant, 1, 'les défauts s\'appliquent : urgent, maintenant')
  assert.ok(b.erreurs.includes('reglages_illisibles'))
  const sansTexte = await notifier({ compte: COMPTE, code: 'avis', donnees: {}, chemin: '/', sujet: 's', maintenant: MIDI, db: base({ profiles: [proprio] }).db, deps: envois().deps })
  assert.deepEqual([sansTexte.maintenant, sansTexte.personne_joignable], [0, false])
  assert.ok(sansTexte.erreurs.includes('texte_absent'))
})

test('`seulement` : l\'essai d\'une personne ne prévient aucun autre membre du compte', async () => {
  const { db } = base({ profiles: [proprio, membre()], profile_permissions: [droits({ reservations: 'write' })] })
  const e = envois()
  const b = await notifier({ compte: COMPTE, code: 'surreservation', donnees: textes.exemple('surreservation', MIDI), chemin: '/', sujet: 'essai:surreservation', seulement: COMPTE, maintenant: MIDI, db, deps: e.deps })
  assert.equal(b.destinataires, 1)
  assert.deepEqual(e.journal.filter(j => j[0] === 'push').map(j => j[1]), [COMPTE])
})

// ─── 5. La file ─────────────────────────────────────────────────────────────

const ligneFile = (o = {}) => ({ id: o.id, user_id: COMPTE, compte_id: COMPTE, code: 'surreservation', sujet: 's1', canaux: ['push'], a: new Date(hiver('2026-11-11T07:00')).toISOString(),
  contenu: { titre: 'T1', corps: 'C1', chemin: '/pages/calendrier', langue: 'fr', email: 'hote@exemple.fr', telephone: '+33600000001' }, cree_le: '2026-11-11T00:00:00Z', ...o })

test('LE TEST QUI COMPTE : à la fin de la plage, UN message par personne, et une ligne ne part qu\'une fois', async () => {
  const { db, etat } = base({ notifications_file: [
    ligneFile({ id: 'a1' }),
    ligneFile({ id: 'a2', sujet: 's2', canaux: ['email'], contenu: { ...ligneFile().contenu, titre: 'T2' }, cree_le: '2026-11-11T01:00:00Z' }),
    ligneFile({ id: 'b1', user_id: MEMBRE, contenu: { ...ligneFile().contenu, titre: 'T3', email: 'membre@exemple.fr' } }),
    ligneFile({ id: 'pas-encore', a: new Date(hiver('2026-11-11T09:00')).toISOString() })
  ] })
  const e = envois()
  const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T07:05'), db, deps: e.deps })
  assert.deepEqual([bilan.dues, bilan.prises, bilan.personnes, bilan.messages], [3, 3, 2, 2])
  const pushTitulaire = e.journal.find(j => j[0] === 'push' && j[1] === COMPTE)
  assert.equal(pushTitulaire[2], '2 alerte(s) pendant vos heures calmes', 'regroupé')
  assert.ok(e.journal.some(j => j[0] === 'email' && j[1] === 'hote@exemple.fr'), 'les canaux sont réunis')
  assert.deepEqual(etat.tables.notifications_file.map(l => l.id), ['pas-encore'], 'ce qui n\'est pas dû reste')
  // Une seconde passe ne trouve rien : rien ne part deux fois.
  const e2 = envois()
  assert.equal((await file.viderFile({ maintenant: hiver('2026-11-11T07:10'), db, deps: e2.deps })).messages, 0)
  assert.equal(e2.journal.length, 0)
})

test('une seule ligne garde son écran et son sujet ; `seulement` prend tout ce qui est À SOI, tout de suite', async () => {
  const { db, etat } = base({ notifications_file: [
    ligneFile({ id: 'a1', a: new Date(hiver('2026-11-11T09:00')).toISOString() }),
    ligneFile({ id: 'b1', user_id: MEMBRE })
  ] })
  const journal = []
  const deps = { ...envois().deps, envoyerPush: async (o) => { journal.push(o.message.notification); return { ok: true, envoyes: 1, morts: 0, echecs: 0 } } }
  const bilan = await file.viderFile({ seulement: COMPTE, maintenant: hiver('2026-11-11T01:00'), db, deps })
  assert.equal(bilan.messages, 1)
  assert.equal(journal[0].navigate, '/pages/calendrier', 'son écran')
  assert.equal(journal[0].tag, 's1', 'son sujet')
  assert.deepEqual(etat.tables.notifications_file.map(l => l.id), ['b1'], 'la ligne d\'un autre reste')
})

test('la passe est plafonnée ; une panne de lecture ne lève pas', async () => {
  const lignes = Array.from({ length: 5 }, (_, i) => ligneFile({ id: `l${i}`, sujet: `s${i}` }))
  const { db, etat } = base({ notifications_file: lignes })
  const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), plafond: 3, db, deps: envois().deps })
  assert.equal(bilan.prises, 3)
  assert.equal(etat.tables.notifications_file.length, 2, 'le reliquat part au cycle suivant')
  const panne = base({ notifications_file: lignes }, { pannes: ['notifications_file'] })
  assert.equal((await file.viderFile({ db: panne.db, deps: envois().deps })).erreurs, 1)
})

// ─── 6. L'endpoint ──────────────────────────────────────────────────────────

function monterApi (tables) {
  const { db, etat } = base(tables)
  const jetons = { 'jeton-a': COMPTE, 'jeton-m': MEMBRE }
  const client = { auth: { getUser: async (j) => (jetons[j] ? { data: { user: { id: jetons[j] } }, error: null } : { data: null, error: { message: 'x' } }) }, from: (t) => db.from(t) }
  const absSupa = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const mSupa = new Module(absSupa); mSupa.exports = { createClient: () => client }; mSupa.loaded = true
  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared); mShared.exports = { supabase: client }; mShared.loaded = true
  const avant = [require.cache[absSupa], require.cache[absShared]]
  require.cache[absSupa] = mSupa
  require.cache[absShared] = mShared
  const MODULES = ['../api/push', '../lib/require-permission', '../lib/push/abonnements', '../lib/push/envoyer', '../lib/notifications/reglages', '../lib/notifications/notifier', '../lib/notifications/file', '../lib/notifications/envoi', '../lib/notifications/destinataires']
  for (const m of MODULES) delete require.cache[require.resolve(m)]
  // Les canaux réels sont remplacés : rien ne sort du test.
  const sorties = []
  const absPlat = require.resolve(path.join(__dirname, '..', 'lib/platform-notify'))
  const absSms = require.resolve(path.join(__dirname, '..', 'api/sms'))
  const avantCanaux = [require.cache[absPlat], require.cache[absSms]]
  require.cache[absPlat] = { id: absPlat, filename: absPlat, loaded: true, exports: { sendPlatformEmail: async (to) => { sorties.push(['email', to]); return { ok: true } } } }
  require.cache[absSms] = { id: absSms, filename: absSms, loaded: true, exports: { sendSms: async (to) => { sorties.push(['sms', to]); return { success: true } } } }
  const handler = require('../api/push')
  const fini = () => {
    ;[absSupa, absShared].forEach((k, i) => { if (avant[i]) require.cache[k] = avant[i]; else delete require.cache[k] })
    ;[absPlat, absSms].forEach((k, i) => { if (avantCanaux[i]) require.cache[k] = avantCanaux[i]; else delete require.cache[k] })
    for (const m of MODULES) delete require.cache[require.resolve(m)]
  }
  async function appeler ({ jeton = 'jeton-a', corps }) {
    const r = { code: null, corps: null }
    r.setHeader = () => r
    r.status = (c) => { r.code = c; return r }
    r.json = (b) => { r.corps = b; return r }
    await handler({ method: 'POST', headers: { authorization: `Bearer ${jeton}` }, body: corps }, r)
    return r
  }
  return { appeler, etat, sorties, fini }
}

test('LE TEST QUI COMPTE : l\'essai d\'un événement ne va qu\'à l\'appelant, et dit qu\'il est un essai', async () => {
  const { appeler, sorties, fini } = monterApi({ profiles: [proprio, membre()], profile_permissions: [droits({ reservations: 'write' })], push_abonnements: [] })
  try {
    const r = await appeler({ corps: { action: 'essai_evenement', code: 'surreservation' } })
    assert.equal(r.code, 200, JSON.stringify(r.corps))
    assert.equal(r.corps.bilan.destinataires, 1)
    // Sans appareil et avec les défauts de la surréservation : e-mail et SMS, au titulaire seul.
    assert.deepEqual(sorties.map(s => s[1]).sort(), ['+33600000001', 'hote@exemple.fr'])
    assert.equal((await appeler({ corps: { action: 'essai_evenement', code: 'inexistant' } })).code, 400)
  } finally { fini() }
})

test('« vider ma file » ne prend que les lignes de l\'appelant', async () => {
  const { appeler, etat, fini } = monterApi({ notifications_file: [ligneFile({ id: 'a1' }), ligneFile({ id: 'b1', user_id: MEMBRE })], push_abonnements: [] })
  try {
    const r = await appeler({ jeton: 'jeton-m', corps: { action: 'vider_ma_file' } })
    assert.equal(r.code, 200)
    assert.equal(r.corps.bilan.prises, 1)
    assert.deepEqual(etat.tables.notifications_file.map(l => l.id), ['a1'])
  } finally { fini() }
})
