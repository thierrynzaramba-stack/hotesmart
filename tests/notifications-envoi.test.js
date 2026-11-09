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

test('LE TEST QUI COMPTE : une notification qui n\'a atteint AUCUN appareil ne remplace pas le SMS (5xx, délai, 403)', async () => {
  const e = envois({ push: { ok: true, envoyes: 0, morts: 0, echecs: 2, aucun_appareil: false } })
  const b = await envoyerMaintenant({ personne: PERSONNE, canaux: ['push', 'sms'], contenu: CONTENU, compte: COMPTE, deps: e.deps })
  assert.equal(b.sms, true, 'aucun appareil n\'a reçu : le SMS part')
  assert.ok(b.erreurs.includes('push_non_livree'), 'et le bilan le dit')
  assert.equal(b.dernier_appareil, false, 'pas « dernier appareil » : ils ne sont pas morts')
  // Un appareil a reçu, un autre a échoué : la notification a remplacé le SMS.
  const un = envois({ push: { ok: true, envoyes: 1, morts: 0, echecs: 1, aucun_appareil: false } })
  assert.equal((await envoyerMaintenant({ personne: PERSONNE, canaux: ['push', 'sms'], contenu: CONTENU, compte: COMPTE, deps: un.deps })).sms, false)
})

test('ce que le titulaire a coupé sur le profil (notify_sms, notify_email) ne part pas', async () => {
  const e = envois({ push: { ok: true, envoyes: 0, morts: 0, echecs: 0, aucun_appareil: true } })
  const b = await envoyerMaintenant({ personne: { ...PERSONNE, smsPermis: false, emailPermis: false }, canaux: ['push', 'email', 'sms'], contenu: CONTENU, compte: COMPTE, deps: e.deps })
  assert.deepEqual([b.email, b.sms], [false, false])
  assert.ok(!e.journal.some(j => j[0] === 'email' || j[0] === 'sms'))
  // Et destinataires.js lit ces drapeaux sur le profil de CE compte.
  const { db } = base({ profiles: [{ ...proprio, notify_sms: false }, membre({ notify_email: false })], profile_permissions: [droits({ reservations: 'write' })] })
  const r = await destinataires({ compte: COMPTE, code: 'surreservation', db })
  assert.deepEqual(r.personnes.map(p => [p.userId, p.smsPermis, p.emailPermis]), [[COMPTE, false, true], [MEMBRE, true, false]])
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
  assert.equal(ligne.contenu.email, undefined, 'aucune coordonnée rangée : elles se relisent à la sortie')
  assert.equal(ligne.contenu.bienRef, 'p1')
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
  // Depuis le lot 2c-2, les quinze événements ont un texte (testé ci-dessous) :
  // l'absence se simule, la garde reste.
  const rediger = textes.rediger
  textes.rediger = () => null
  try {
    const sansTexte = await notifier({ compte: COMPTE, code: 'avis', donnees: {}, chemin: '/', sujet: 's', maintenant: MIDI, db: base({ profiles: [proprio] }).db, deps: envois().deps })
    assert.deepEqual([sansTexte.maintenant, sansTexte.personne_joignable], [0, false])
    assert.ok(sansTexte.erreurs.includes('texte_absent'))
  } finally { textes.rediger = rediger }
})

test('lot 2c-2 : chacun des quinze événements du catalogue a son texte, dans les trois langues, et son essai', () => {
  const { EVENEMENTS } = require('../lib/notifications/catalogue')
  const codes = EVENEMENTS.map(e => e.code)
  assert.strictEqual(codes.length, 15)
  for (const code of codes) {
    for (const l of ['fr', 'en', 'es']) {
      const t = textes.rediger(code, l, textes.exemple(code, MIDI))
      assert.ok(t && t.titre && t.corps && !/undefined|null|NaN/.test(t.titre + t.corps), `${code}/${l}`)
    }
  }
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
  contenu: { titre: 'T1', corps: 'C1', chemin: '/pages/calendrier', langue: 'fr', bienRef: 'p1' }, cree_le: '2026-11-11T00:00:00Z', ...o })
const AVEC_MEMBRE = { profiles: [proprio, membre()], profile_permissions: [droits({ reservations: 'write', avis: 'read', messages: 'read' })] }

test('LE TEST QUI COMPTE : à la fin de la plage, UN message par personne, et une ligne ne part qu\'une fois', async () => {
  const { db, etat } = base({ ...AVEC_MEMBRE, notifications_file: [
    ligneFile({ id: 'a1' }),
    ligneFile({ id: 'a2', sujet: 's2', canaux: ['push'], contenu: { ...ligneFile().contenu, titre: 'T2' }, cree_le: '2026-11-11T01:00:00Z' }),
    ligneFile({ id: 'b1', user_id: MEMBRE, contenu: { ...ligneFile().contenu, titre: 'T3' } }),
    ligneFile({ id: 'pas-encore', a: new Date(hiver('2026-11-11T09:00')).toISOString() })
  ] })
  const e = envois()
  const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T07:05'), db, deps: e.deps })
  assert.deepEqual([bilan.dues, bilan.prises, bilan.groupes, bilan.messages], [3, 3, 2, 2])
  const pushTitulaire = e.journal.find(j => j[0] === 'push' && j[1] === COMPTE)
  assert.equal(pushTitulaire[2], '2 alerte(s) pendant vos heures calmes', 'regroupé')
  assert.deepEqual(etat.tables.notifications_file.map(l => l.id), ['pas-encore'], 'ce qui n\'est pas dû reste')
  const e2 = envois()
  assert.equal((await file.viderFile({ maintenant: hiver('2026-11-11T07:10'), db, deps: e2.deps })).messages, 0)
  assert.equal(e2.journal.length, 0, 'rien ne part deux fois')
})

test('LE TEST QUI COMPTE : regroupé par personne ET PAR COMPTE — jamais le bien d\'un compte par les coordonnées d\'un autre', async () => {
  // MEMBRE est membre du compte COMPTE, et titulaire de son propre compte.
  const sonCompte = { ...proprio, id: 'p-sien', account_user_id: MEMBRE, member_user_id: MEMBRE, email: 'membre-perso@exemple.fr', phone: '+33677777777' }
  const { db } = base({ profiles: [proprio, membre(), sonCompte], profile_permissions: [droits({ reservations: 'write' })], notifications_file: [
    ligneFile({ id: 'x1', user_id: MEMBRE, compte_id: COMPTE, sujet: 'sx', canaux: ['email', 'sms'], contenu: { ...ligneFile().contenu, titre: 'Villa de COMPTE' } }),
    ligneFile({ id: 'x2', user_id: MEMBRE, compte_id: MEMBRE, sujet: 'sy', canaux: ['email', 'sms'], contenu: { ...ligneFile().contenu, titre: 'Bien de MEMBRE' } })
  ] })
  const sorties = []
  const deps = { ...envois({ cles: null }).deps,
    envoyerEmail: async (to, sujet) => { sorties.push(['email', to, sujet]); return { ok: true } },
    envoyerSms: async (to, texte, ref, ctx, compte) => { sorties.push(['sms', to, texte.split('\n')[0], compte]); return { success: true } } }
  const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), db, deps })
  assert.equal(bilan.groupes, 2, 'deux comptes, deux envois')
  assert.deepEqual(sorties.sort((a, b) => a.join().localeCompare(b.join())), [
    ['email', 'membre-perso@exemple.fr', 'HôteSmart — Bien de MEMBRE'],
    ['email', 'membre@exemple.fr', 'HôteSmart — Villa de COMPTE'],
    ['sms', '+33600000002', 'HôteSmart — Villa de COMPTE', COMPTE],
    ['sms', '+33677777777', 'HôteSmart — Bien de MEMBRE', MEMBRE]
  ])
})

test('LE TEST QUI COMPTE : les droits se relisent à la sortie — une personne désactivée pendant ses heures calmes ne reçoit rien', async () => {
  const lignes = [ligneFile({ id: 'm1', user_id: MEMBRE, canaux: ['email'] })]
  for (const [profil, perm, nom] of [
    [membre({ active: false }), droits({ reservations: 'write' }), 'désactivé'],
    [membre(), droits({ reservations: 'read' }), 'a perdu l\'écriture'],
    [membre(), droits({ reservations: 'write', property_scope: 'selected', property_ids: ['autre'], property_refs: ['autre'] }), 'a perdu le bien']
  ]) {
    const { db, etat } = base({ profiles: [proprio, profil], profile_permissions: [perm], notifications_file: lignes })
    const e = envois()
    const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), db, deps: e.deps })
    assert.equal(bilan.ecartees, 1, nom)
    assert.equal(e.journal.filter(j => j[0] === 'email').length, 0, nom)
    assert.equal(etat.tables.notifications_file.length, 0, `${nom} : la ligne est retirée, pas gardée pour toujours`)
  }
  // Et les coordonnées sont celles d'AUJOURD'HUI.
  const { db } = base({ profiles: [proprio, membre({ email: 'nouvelle@exemple.fr' })], profile_permissions: [droits({ reservations: 'write' })], notifications_file: lignes })
  const e = envois()
  await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), db, deps: e.deps })
  assert.equal(e.journal.find(j => j[0] === 'email')[1], 'nouvelle@exemple.fr')
})

test('chaque canal ne porte que SES lignes : une ligne en notification seule n\'entre ni dans l\'e-mail ni dans le SMS', async () => {
  const { db } = base({ ...AVEC_MEMBRE, notifications_file: [
    ligneFile({ id: 'a1', sujet: 's1', canaux: ['push'], contenu: { ...ligneFile().contenu, titre: 'Push seul' } }),
    ligneFile({ id: 'a2', sujet: 's2', canaux: ['email', 'sms'], contenu: { ...ligneFile().contenu, titre: 'Email et SMS' } })
  ] })
  const sorties = []
  const deps = { ...envois({ push: { ok: true, envoyes: 0, morts: 0, echecs: 0, aucun_appareil: true } }).deps,
    envoyerPush: async (o) => { sorties.push(['push', o.message.notification.title]); return { ok: true, envoyes: 0, morts: 0, echecs: 0, aucun_appareil: true } },
    envoyerEmail: async (to, sujet) => { sorties.push(['email', sujet]); return { ok: true } },
    envoyerSms: async (to, texte) => { sorties.push(['sms', texte.split('\n')[0]]); return { success: true } } }
  await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), db, deps })
  assert.deepEqual(sorties, [['push', 'Push seul'], ['email', 'HôteSmart — Email et SMS'], ['sms', 'HôteSmart — Email et SMS']])
})

test('une seule ligne garde son écran et son sujet ; `seulement` prend tout ce qui est À SOI, tout de suite', async () => {
  const { db, etat } = base({ ...AVEC_MEMBRE, notifications_file: [
    ligneFile({ id: 'a1', a: new Date(hiver('2026-11-11T09:00')).toISOString() }),
    ligneFile({ id: 'b1', user_id: MEMBRE })
  ] })
  const journal = []
  const deps = { ...envois().deps, envoyerPush: async (o) => { journal.push(o.message.notification); return { ok: true, envoyes: 1, morts: 0, echecs: 0 } } }
  const bilan = await file.viderFile({ seulement: COMPTE, maintenant: hiver('2026-11-11T01:00'), db, deps })
  assert.equal(bilan.messages, 1)
  assert.equal(journal[0].navigate, '/pages/calendrier', 'son écran')
  assert.equal(journal[0].tag, 's1', 'son sujet')
  // Recette du 8 novembre : la fin des heures calmes SONNE, même si une
  // notification du même sujet est encore affichée (sinon, remplacement muet).
  assert.equal(journal[0].renotify, true)
  assert.deepEqual(etat.tables.notifications_file.map(l => l.id), ['b1'], 'la ligne d\'un autre reste')
})

test('LE TEST QUI COMPTE : sans le temps de partir, une ligne RESTE en base — jamais prise puis perdue', async () => {
  const lignes = Array.from({ length: 35 }, (_, i) => ligneFile({ id: `l${i}`, sujet: `s${i}`, user_id: i === 0 ? COMPTE : `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000` }))
  // Budget épuisé : rien n'est pris.
  const sansTemps = base({ ...AVEC_MEMBRE, notifications_file: lignes })
  const b0 = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), resteMs: () => 1000, db: sansTemps.db, deps: envois().deps })
  assert.deepEqual([b0.prises, b0.reportees], [0, 35])
  assert.equal(sansTemps.etat.tables.notifications_file.length, 35)
  // Plafond de groupes par passe : le reliquat reste pour le cycle suivant.
  const plafond = base({ ...AVEC_MEMBRE, notifications_file: lignes })
  const b1 = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), resteMs: () => 50000, db: plafond.db, deps: envois().deps })
  assert.equal(b1.groupes, file.GROUPES_PAR_PASSE)
  assert.equal(plafond.etat.tables.notifications_file.length, 35 - file.GROUPES_PAR_PASSE)
  // Une panne de lecture ne lève pas.
  const panne = base({ notifications_file: lignes }, { pannes: ['notifications_file'] })
  assert.deepEqual((await file.viderFile({ db: panne.db, deps: envois().deps })).erreurs, ['lecture_impossible'])
})

test('ce qui part maintenant remplace la ligne du même sujet qui attendait ; la file en panne ne rend personne muet', async () => {
  const { db, etat } = base({ profiles: [proprio], notifications_file: [ligneFile({ id: 'vieille', sujet: 'surreservation:p1' })] })
  const e = envois()
  await notifier({ compte: COMPTE, code: 'surreservation', donnees: { bien: 'B', nuits: [] }, chemin: '/', sujet: 'surreservation:p1', maintenant: MIDI, db, deps: e.deps })
  assert.equal(etat.tables.notifications_file.length, 0, 'la relance a remplacé la ligne en attente')
  // La file refuse d'écrire : l'alerte part tout de suite plutôt que jamais.
  const panne = base({ profiles: [proprio], notifications_reglages: [{ user_id: COMPTE, evenements: { surreservation: { push: true, email: true, sms: false, urgent: false } }, plages: [NUIT_TOUS_LES_JOURS] }] }, { pannes: ['notifications_file'] })
  const e2 = envois()
  const b = await notifier({ compte: COMPTE, code: 'surreservation', donnees: { bien: 'B', nuits: [] }, chemin: '/', sujet: 's', maintenant: NUIT, db: panne.db, deps: e2.deps })
  assert.deepEqual([b.en_attente, b.maintenant], [0, 1])
  assert.ok(e2.journal.some(j => j[0] === 'email'))
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
    // ⚠ LA NOTIFICATION SEULE : ni e-mail plateforme ni SMS, même si les
    // réglages les cochent (un essai répété serait un relais vers n'importe
    // quelle adresse — constat de review).
    assert.deepEqual(sorties, [])
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

// ─── 7. La chaîne réelle : la surréservation jusqu'aux canaux ───────────────
// Constat de review : le test de lib/cron-overbooking.js remplace `notifier` par
// un double. Ici, la VRAIE chaîne tourne — `traiterAlarmes` → `crier` →
// `notifier` → `destinataires` → `envoyerMaintenant` — sur une base factice, et
// seuls les canaux du bout (e-mail plateforme, SMS) sont des doubles.
test('LE TEST QUI COMPTE : la surréservation, de la sonde aux canaux — le titulaire et qui peut acquitter, et eux seuls', async () => {
  const { db } = base({
    profiles: [proprio, membre(), membre({ id: 'p-lecteur', member_user_id: AUTRE, email: 'lecteur@exemple.fr', phone: '+33600000003' })],
    profile_permissions: [droits({ reservations: 'write' }), droits({ profile_id: 'p-lecteur', reservations: 'read' })],
    push_abonnements: []
  })
  const sorties = []
  const remplacer = (rel, exports) => { const k = require.resolve(rel); const avant = require.cache[k]; require.cache[k] = { id: k, filename: k, loaded: true, exports }; return () => { if (avant) require.cache[k] = avant; else delete require.cache[k] } }
  const MODULES = ['../lib/cron-overbooking', '../lib/notifications/notifier', '../lib/notifications/file', '../lib/notifications/envoi', '../lib/notifications/destinataires', '../lib/notifications/reglages', '../lib/push/abonnements', '../lib/push/envoyer']
  for (const m of MODULES) delete require.cache[require.resolve(m)]
  const capture = []
  const sondeDb = { from: () => { const q = { select: () => q, eq: () => q, is: () => q, order: () => q, gte: () => q, lt: () => q, or: () => q, range: () => q,
    insert: (row) => { capture.push(row); return { select: () => ({ maybeSingle: async () => ({ data: { id: 'inc' }, error: null }) }) } },
    update: () => q, then: (ok, ko) => Promise.resolve({ data: [], error: null }).then(ok, ko) }; return q } }
  const restaurer = [
    remplacer('../lib/cron-shared', { supabase: sondeDb }),
    remplacer('../lib/founder-notify', { envoyerAlerteBrute: async () => { sorties.push(['fondateur']) }, LABELS: {} }),
    remplacer('../lib/platform-notify', { sendPlatformEmail: async (to, sujet) => { sorties.push(['email', to, sujet]); return { ok: true } } }),
    remplacer('../api/sms', { sendSms: async (to, texte, ref, ctx, compte) => { sorties.push(['sms', to, ctx, compte]); return { success: true } } })
  ]
  try {
    const mod = require('../lib/cron-overbooking')
    // Le point d'envoi lit SA base au moment de l'envoi : la base factice des profils.
    require.cache[require.resolve('../lib/cron-shared')].exports = { supabase: db }
    const bilan = await mod.traiterAlarmes([{ userId: COMPTE, propertyId: 'p1', propertyName: 'La bulle', nuits: ['2099-01-01'], bookings: ['a', 'b'], unites: 1 }])
    assert.equal(bilan.ouverts, 1)
    const nonFondateur = sorties.filter(x => x[0] !== 'fondateur').sort((a, b) => a.join().localeCompare(b.join()))
    // Sans appareil abonné et avec les défauts (Q26) : e-mail ET SMS, par la clé du compte.
    assert.deepEqual(nonFondateur, [
      ['email', 'hote@exemple.fr', 'HôteSmart — Surréservation — La bulle'],
      ['email', 'membre@exemple.fr', 'HôteSmart — Surréservation — La bulle'],
      ['sms', '+33600000001', 'notification', COMPTE],
      ['sms', '+33600000002', 'notification', COMPTE]
    ], 'le membre en lecture seule ne reçoit rien')
    assert.ok(sorties.some(x => x[0] === 'fondateur'), 'le fondateur reste en copie')
  } finally {
    restaurer.forEach(f => f())
    for (const m of MODULES) delete require.cache[require.resolve(m)]
  }
})

// ─── 8. Seconde review ──────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : l\'essai ne prévient pas par e-mail « dernier appareil » — plus aucun relais d\'e-mail', async () => {
  const { db } = base({ profiles: [proprio] })
  const e = envois({ push: { ok: true, envoyes: 0, morts: 1, echecs: 0, aucun_appareil: false } })
  const b = await notifier({ compte: COMPTE, code: 'surreservation', donnees: textes.exemple('surreservation', MIDI), chemin: '/', sujet: 'essai:surreservation',
    seulement: COMPTE, canauxPermis: ['push'], maintenant: MIDI, db, deps: e.deps })
  assert.equal(b.derniers_appareils, 1, 'l\'appareil mort est bien vu')
  assert.ok(!e.journal.some(j => j[0] === 'email' || j[0] === 'sms'), 'mais rien ne part par e-mail ni SMS')
  // Hors essai, le même appareil mort prévient par e-mail (Q13).
  const e2 = envois({ push: { ok: true, envoyes: 0, morts: 1, echecs: 0, aucun_appareil: false } })
  await notifier({ compte: COMPTE, code: 'surreservation', donnees: { bien: 'B', nuits: [] }, chemin: '/', sujet: 's', maintenant: MIDI, db, deps: e2.deps })
  assert.ok(e2.journal.some(j => j[0] === 'email' && /ne vous arrivent plus/.test(j[2])))
})

test('LE TEST QUI COMPTE : une relecture des droits en panne laisse les lignes en base — jamais prises puis perdues', async () => {
  const { db, etat } = base({ ...AVEC_MEMBRE, notifications_file: [ligneFile({ id: 'a1' }), ligneFile({ id: 'a2', sujet: 's2' })] }, { pannes: ['profiles'] })
  const e = envois()
  const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), db, deps: e.deps })
  assert.deepEqual([bilan.prises, bilan.reportees], [0, 2])
  assert.ok(bilan.erreurs.includes('droits_illisibles'))
  assert.equal(etat.tables.notifications_file.length, 2, 'elles partiront au cycle suivant')
  assert.equal(e.journal.length, 0)
})

test('un envoi entièrement raté n\'efface pas la ligne du même sujet qui attendait', async () => {
  const { db, etat } = base({ profiles: [proprio], notifications_file: [ligneFile({ id: 'attend', sujet: 'surreservation:p1' })] })
  const rate = { cles: null, compterAppareils: async () => ({ ok: true, n: 0 }), envoyerPush: async () => ({ ok: false }),
    envoyerEmail: async () => ({ ok: false }), envoyerSms: async () => ({ success: false }) }
  const b = await notifier({ compte: COMPTE, code: 'surreservation', donnees: { bien: 'B', nuits: [] }, chemin: '/', sujet: 'surreservation:p1', maintenant: MIDI, db, deps: rate })
  assert.equal(b.personne_joignable, false)
  assert.deepEqual(etat.tables.notifications_file.map(l => l.id), ['attend'])
})

test('le bien rangé par son seul identifiant garde son périmètre à la sortie', async () => {
  const perm = droits({ reservations: 'write', property_scope: 'selected', property_ids: ['uuid-1'], property_refs: ['ref-1'] })
  const { db, etat } = base({ profiles: [proprio, membre()], profile_permissions: [perm], notifications_reglages: [
    { user_id: MEMBRE, evenements: { surreservation: { push: true, email: true, sms: false, urgent: false } }, plages: [NUIT_TOUS_LES_JOURS] }] })
  // Mis en file avec { id } seul, sur le bien du périmètre : il passe.
  await notifier({ compte: COMPTE, code: 'surreservation', bien: { id: 'uuid-1' }, donnees: { bien: 'B', nuits: [] }, chemin: '/', sujet: 'dans', maintenant: NUIT, db, deps: envois().deps })
  // Et sur un bien hors périmètre — rangé, le membre ne passe pas la décision : il n'est pas destinataire.
  const ligne = etat.tables.notifications_file.find(l => l.user_id === MEMBRE)
  assert.equal(ligne.contenu.bienId, 'uuid-1')
  // Le périmètre change pendant la plage : le bien sort du périmètre du membre.
  etat.tables.profile_permissions[0].property_ids = ['uuid-9']
  etat.tables.profile_permissions[0].property_refs = ['ref-9']
  const e = envois()
  const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T08:00'), db, deps: e.deps })
  assert.equal(bilan.ecartees, 1)
  assert.ok(!e.journal.some(j => j[1] === MEMBRE || j[1] === 'membre@exemple.fr'))
})

test('LE TEST QUI COMPTE : acquitter une surréservation retire sa ligne de la file — et ne peut pas échouer à cause d\'elle', async () => {
  const k = (rel) => require.resolve(rel)
  const remplacer = (rel, exports) => { const c = k(rel); const avant = require.cache[c]; require.cache[c] = { id: c, filename: c, loaded: true, exports }; return () => { if (avant) require.cache[c] = avant; else delete require.cache[c] } }
  const retraits = []
  let fileLeve = false
  const update = { eq: () => update, in: () => update, is: () => update, or: () => update,
    select: async () => ({ data: [{ id: 'inc-1', type: 'overbooking', property_id: 'p1' }], error: null }) }
  const restaurer = [
    remplacer('../lib/require-permission', { requirePermission: async () => ({ ok: true, userId: MEMBRE, accountUserId: COMPTE, contexte: { userId: COMPTE, accountUserId: COMPTE } }) }),
    remplacer('../lib/notifications/file', { retirerSujet: async (p) => { if (fileLeve) throw new Error('panne'); retraits.push(p); return { ok: true } } }),
    remplacer(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'), { createClient: () => ({ from: () => ({ update: () => update }) }) })
  ]
  delete require.cache[k('../api/incidents-acquitter')]
  try {
    const handler = require('../api/incidents-acquitter')
    const appeler = async () => { const r = { code: null, corps: null }; r.status = (c) => { r.code = c; return r }; r.json = (b) => { r.corps = b; return r }; r.setHeader = () => r
      await handler({ method: 'POST', headers: {}, body: { id: 'inc-1' } }, r); return r }
    const r = await appeler()
    assert.equal(r.code, 200)
    assert.equal(retraits.length, 1)
    assert.equal(retraits[0].compte, COMPTE)
    assert.equal(retraits[0].sujet, 'surreservation:p1')
    fileLeve = true
    assert.equal((await appeler()).code, 200, 'une file en panne n\'empêche pas d\'acquitter')
  } finally {
    restaurer.forEach(f => f())
    delete require.cache[k('../api/incidents-acquitter')]
  }
})

// ─── 9. Lot 2c-2 : un canal qu'une personne reçoit déjà autrement ───────────

test('LE TEST QUI COMPTE : `exclusions` retire un canal à UNE personne, et à elle seule', async () => {
  const { db } = base({ profiles: [proprio, membre()], profile_permissions: [droits({ reservations: 'read' })] })
  const e = envois()
  const b = await notifier({ compte: COMPTE, code: 'reservation', bien: { ref: 'ref-1' },
    donnees: { bien: 'La bulle', prenom: 'Jean', arrivee: '2026-12-12', depart: '2026-12-15', canal: 'Offline' },
    chemin: '/calendrier', sujet: 'resa:1', exclusions: { [COMPTE]: ['email'] }, maintenant: MIDI, db, deps: e.deps })
  assert.equal(b.ok, true)
  // Le titulaire d'une réservation directe reçoit déjà le relevé détaillé : pas d'e-mail ici.
  assert.ok(!e.journal.some(j => j[0] === 'email' && j[1] === 'hote@exemple.fr'), 'pas de second e-mail au titulaire')
  assert.ok(e.journal.some(j => j[0] === 'push' && j[1] === COMPTE), 'sa notification part')
  // Le membre, lui, n'a rien reçu d'autre : il garde ses canaux.
  assert.ok(e.journal.some(j => j[0] === 'email' && j[1] === 'membre@exemple.fr'), 'le membre reçoit son e-mail')
})

// ─── 10. Lot 2c-2 : le relevé d'une réservation directe suit les réglages ───
// (décision de Thierry du 8 novembre 2026, lib/notifications/releve.js)
const releve = require('../lib/notifications/releve')

test('LE TEST QUI COMPTE : le relevé suit les réglages de « Nouvelle réservation » — décoché, différé, ou tout de suite', async () => {
  const sans = base({})
  assert.deepEqual(await releve.decisionDuReleve({ compte: COMPTE, maintenant: MIDI, db: sans.db }), { envoyer: 'maintenant' }, 'les défauts portent l\'e-mail')
  const decoche = base({ notifications_reglages: [{ user_id: COMPTE, evenements: { reservation: { push: true, email: false, sms: false, urgent: false } }, plages: [] }] })
  assert.deepEqual(await releve.decisionDuReleve({ compte: COMPTE, maintenant: MIDI, db: decoche.db }), { envoyer: 'non', motif: 'email_decoche' })
  const calme = base({ notifications_reglages: [{ user_id: COMPTE, evenements: {}, plages: [NUIT_TOUS_LES_JOURS] }] })
  const d = await releve.decisionDuReleve({ compte: COMPTE, maintenant: NUIT, db: calme.db })
  assert.equal(d.envoyer, 'plus_tard')
  assert.equal(d.a, hiver('2026-11-11T07:00'))
  // Une arrivée le jour même passe les heures calmes, comme toute alerte du séjour.
  const imminent = await releve.decisionDuReleve({ compte: COMPTE, maintenant: NUIT, sejour: { arrivee: '2026-11-11', depart: '2026-11-12' }, db: calme.db })
  assert.equal(imminent.envoyer, 'maintenant')
  // Des réglages illisibles ne rendent pas muet.
  const panne = base({}, { pannes: ['notifications_reglages'] })
  assert.equal((await releve.decisionDuReleve({ compte: COMPTE, maintenant: MIDI, db: panne.db })).envoyer, 'maintenant')
})

test('différé : la ligne ne porte RIEN du voyageur ; à la sortie, la réservation et le bien se relisent SUR LE COMPTE de la ligne', async () => {
  const { db, etat } = base({
    bookings_snapshot: [
      // ⚠ Le même identifiant chez un AUTRE hôte (la clé du cœur est (user_id, booking_id)).
      { user_id: AUTRE, booking_id: 'b1', snapshot: { status: 'confirmed', provider: 'channex', source: 'Offline', firstName: 'Autre', guestEmail: 'autre@exemple.fr' } },
      { user_id: COMPTE, booking_id: 'b2', snapshot: { status: 'confirmed', provider: 'channex', source: 'Offline', firstName: 'Mauvaise', guestEmail: 'b2@exemple.fr' } },
      { user_id: COMPTE, booking_id: 'b1', snapshot: { status: 'confirmed', provider: 'channex', source: 'Offline', firstName: 'Jean', guestEmail: 'jean@exemple.fr' } }
    ],
    properties: [
      { user_id: AUTRE, provider_property_id: 'p1', name: 'Bien d\'un autre', cancellation_policy: 'flexible_j2' },
      { user_id: COMPTE, provider_property_id: 'p2', name: 'Mauvais bien', cancellation_policy: 'non_remboursable' },
      { user_id: COMPTE, provider_property_id: 'p1', name: 'La bulle', cancellation_policy: 'j7' }
    ]
  })
  assert.equal((await releve.differer({ compte: COMPTE, bookingId: 'b1', propertyId: 'p1', provider: 'channex', a: hiver('2026-11-11T07:00'), db })).ok, true)
  const ligne = etat.tables.notifications_file[0]
  assert.deepEqual({ sujet: ligne.sujet, code: ligne.code, canaux: ligne.canaux, contenu: ligne.contenu },
    { sujet: 'releve:b1', code: 'reservation', canaux: ['email'], contenu: { releve: { bookingId: 'b1', propertyId: 'p1', provider: 'channex' }, bienRef: 'p1' } })
  assert.ok(!JSON.stringify(ligne).includes('jean@'), 'aucune coordonnée du voyageur dans la file')
  const appels = []
  const r = await releve.envoyerDiffere({ compte: COMPTE, contenu: ligne.contenu, maintenant: MIDI, db, envoyer: async (o) => { appels.push(o); return { ok: true } } })
  assert.equal(r.ok, true)
  assert.deepEqual(appels.map(o => [o.userId, o.bookingId, o.propertyId, o.bien, o.politique, o.snapshot.guestEmail]),
    [[COMPTE, 'b1', 'p1', 'La bulle', 'j7', 'jean@exemple.fr']])
  // Seul l'AUTRE hôte a cette réservation : rien ne part, et ce n'est pas « défaite ».
  const r3 = await releve.envoyerDiffere({ compte: COMPTE, contenu: { releve: { bookingId: 'b9', propertyId: 'p1' } }, maintenant: MIDI, db,
    envoyer: async () => { throw new Error('ne doit pas partir') } })
  assert.deepEqual(r3, { ok: false, raison: 'reservation_introuvable' })
  // Défaite pendant la nuit : elle ne s'annonce pas.
  etat.tables.bookings_snapshot[2].snapshot.status = 'cancelled'
  const r2 = await releve.envoyerDiffere({ compte: COMPTE, contenu: ligne.contenu, maintenant: MIDI, db, envoyer: async () => { throw new Error('ne doit pas partir') } })
  assert.deepEqual(r2, { ok: true, ignore: true, raison: 'reservation_defaite' })
})

test('review de rattrapage, constat 2 : DEUX lignes pour la même référence (bien archivé puis recréé) — le relevé part, avec le bien ACTIF', async () => {
  const { db } = base({
    bookings_snapshot: [{ user_id: COMPTE, booking_id: 'b1', snapshot: { status: 'confirmed', provider: 'channex', source: 'Offline' } }],
    properties: [
      { user_id: COMPTE, provider_property_id: 'p1', name: 'Ancien', cancellation_policy: 'flexible_j2', archive_le: '2026-10-01T00:00:00Z' },
      { user_id: COMPTE, provider_property_id: 'p1', name: 'La bulle', cancellation_policy: 'j7', archive_le: null }
    ]
  })
  const appels = []
  const r = await releve.envoyerDiffere({ compte: COMPTE, contenu: { releve: { bookingId: 'b1', propertyId: 'p1' } }, maintenant: MIDI, db,
    envoyer: async (o) => { appels.push([o.bien, o.politique]); return { ok: true } } })
  assert.equal(r.ok, true)
  assert.deepEqual(appels, [['La bulle', 'j7']])
})

test('review de rattrapage, constat 2 : une lecture qui échoue toujours ne remet pas le relevé sans fin — au bout de REMISES_MAX, l\'incident', async () => {
  const panne = base({}, { pannes: ['bookings_snapshot'] })
  const incidents = []
  let ligne = { id: 'r1', user_id: COMPTE, compte_id: COMPTE, code: 'reservation', sujet: 'releve:b1', canaux: ['email'], a: new Date(MIDI).toISOString(),
    contenu: { releve: { bookingId: 'b1', propertyId: 'p1', provider: 'channex' }, bienRef: 'p1' } }
  const sorties = []
  for (let i = 0; i < releve.REMISES_MAX; i++) {
    const r = await releve.sortirDeLaFile({ ligne, maintenant: MIDI, db: panne.db, signaler: async (t, o) => { incidents.push([t, o.userId]) } })
    sorties.push(r.remise ? 'remise' : 'incident')
    const t = panne.etat.tables.notifications_file
    if (r.remise) { ligne = { ...ligne, contenu: t[t.length - 1].contenu }; t.length = 0 }
  }
  assert.deepEqual(sorties, [...Array(releve.REMISES_MAX - 1).fill('remise'), 'incident'])
  assert.deepEqual(incidents, [['notif_hote_non_envoyee', COMPTE]])
})

test('« suivre mes réglages » vaut au moment de partir : l\'e-mail décoché pendant la nuit retient le relevé', async () => {
  const { db } = base({
    bookings_snapshot: [{ user_id: COMPTE, booking_id: 'b1', snapshot: { status: 'confirmed', provider: 'channex', source: 'Offline' } }],
    notifications_reglages: [{ user_id: COMPTE, evenements: { reservation: { push: true, email: false, sms: false, urgent: false } }, plages: [] }]
  })
  const r = await releve.envoyerDiffere({ compte: COMPTE, contenu: { releve: { bookingId: 'b1', propertyId: 'p1' } }, maintenant: MIDI, db,
    envoyer: async () => { throw new Error('ne doit pas partir') } })
  assert.deepEqual(r, { ok: true, ignore: true, raison: 'email_decoche' })
})

test('LE TEST QUI COMPTE : un relevé différé ne se perd jamais en silence — lecture ratée remise en file, envoi raté signalé', async () => {
  const ligne = { id: 'r1', user_id: COMPTE, compte_id: COMPTE, code: 'reservation', sujet: 'releve:b1', canaux: ['email'], a: new Date(hiver('2026-11-11T07:00')).toISOString(),
    contenu: { releve: { bookingId: 'b1', propertyId: 'p1', provider: 'channex' }, bienRef: 'p1' } }
  // Le cœur en panne au moment de partir : la ligne revient.
  const panne = base({}, { pannes: ['bookings_snapshot'] })
  const incidents = []
  const r1 = await releve.sortirDeLaFile({ ligne, maintenant: MIDI, db: panne.db, signaler: async (t, o) => { incidents.push([t, o.userId]) } })
  assert.equal(r1.remise, true)
  assert.deepEqual(panne.etat.tables.notifications_file.map(l => [l.sujet, l.user_id, l.a]), [['releve:b1', COMPTE, new Date(MIDI).toISOString()]])
  assert.deepEqual(incidents, [])
  // Le relevé lui-même échoue (Brevo et repli muets) : un incident, comme le chemin immédiat.
  const ok = base({ bookings_snapshot: [{ user_id: COMPTE, booking_id: 'b1', snapshot: { status: 'confirmed', provider: 'channex' } }] })
  const r2 = await releve.sortirDeLaFile({ ligne, maintenant: MIDI, db: ok.db, envoyer: async () => ({ ok: false, raison: 'brevo muet' }),
    signaler: async (t, o) => { incidents.push([t, o.userId, o.propertyId]) } })
  assert.equal(r2.erreur, 'brevo muet')
  assert.deepEqual(incidents, [['notif_hote_non_envoyee', COMPTE, 'p1']])
})

test('LE TEST QUI COMPTE : sans le temps de partir, un relevé PRIS revient dans la file', async () => {
  const contenuReleve = { releve: { bookingId: 'b1', propertyId: 'p1', provider: 'channex' }, bienRef: 'p1' }
  const { db, etat } = base({ ...AVEC_MEMBRE, notifications_file: [
    ligneFile({ id: 'a1' }),
    ligneFile({ id: 'r1', code: 'reservation', sujet: 'releve:b1', canaux: ['email'], contenu: contenuReleve })
  ] })
  // Le temps s'épuise APRÈS la prise du groupe : le relevé n'a pas le temps de partir.
  let appels = 0
  const resteMs = () => (appels++ === 0 ? 60000 : 1000)
  const sortis = []
  const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T07:05'), db, resteMs,
    deps: { ...envois().deps, sortirReleve: async (o) => { sortis.push(o.ligne.id); return { envoye: true } } } })
  assert.deepEqual(sortis, [])
  assert.equal(bilan.reportees, 1)
  assert.deepEqual(etat.tables.notifications_file.map(l => l.sujet), ['releve:b1'], 'le relevé est de retour')
})

test('LE TEST QUI COMPTE : à la fin de la plage, le relevé part SEUL et au titulaire seul — jamais fondu dans le regroupé', async () => {
  const contenuReleve = { releve: { bookingId: 'b1', propertyId: 'p1', provider: 'channex' }, bienRef: 'p1' }
  const { db } = base({ ...AVEC_MEMBRE, notifications_file: [
    ligneFile({ id: 'a1' }),
    ligneFile({ id: 'r1', code: 'reservation', sujet: 'releve:b1', canaux: ['email'], contenu: contenuReleve }),
    // Une ligne de relevé chez un membre ne peut venir que d'une erreur : elle est écartée.
    ligneFile({ id: 'r2', user_id: MEMBRE, code: 'reservation', sujet: 'releve:b1', canaux: ['email'], contenu: contenuReleve })
  ] })
  const e = envois()
  const releves = []
  const bilan = await file.viderFile({ maintenant: hiver('2026-11-11T07:05'), db,
    deps: { ...e.deps, sortirReleve: async (o) => { releves.push([o.ligne.compte_id, o.ligne.contenu.releve.bookingId]); return { envoye: true } } } })
  assert.deepEqual(releves, [[COMPTE, 'b1']])
  assert.equal(bilan.ecartees, 1, 'la ligne du membre')
  const pushTitulaire = e.journal.find(j => j[0] === 'push' && j[1] === COMPTE)
  assert.equal(pushTitulaire[2], 'T1', 'le relevé n\'entre pas dans le regroupement : la notification reste seule')
  assert.ok(!e.journal.some(j => j[0] === 'email'), 'aucun e-mail regroupé n\'emporte le relevé')
})

// ─── 11. Lot 2c-2 : retirer une annonce sans emporter un message plus récent ─
test('retirerSujet avec un code ne retire que la ligne de CET événement (une conversation = un sujet)', async () => {
  const ligne = (code) => ligneFile({ id: code, code, sujet: 'conv:b1' })
  // La réponse différée est partie, mais un NOUVEAU message attend depuis sur ce sujet : il reste.
  const a = base({ notifications_file: [ligne('message_voyageur')] })
  await file.retirerSujet({ compte: COMPTE, sujet: 'conv:b1', code: 'brouillon_ia', db: a.db })
  assert.equal(a.etat.tables.notifications_file.length, 1)
  // L'annonce de la réponse elle-même : retirée.
  const b = base({ notifications_file: [ligne('brouillon_ia')] })
  await file.retirerSujet({ compte: COMPTE, sujet: 'conv:b1', code: 'brouillon_ia', db: b.db })
  assert.equal(b.etat.tables.notifications_file.length, 0)
})

// ─── 12. Lot 2c-2 : un émetteur léger ne charge pas le client du cron ───────
test('LE TEST QUI COMPTE : prévenir d\'un message depuis le writer ne charge ni le client du cron ni le SDK de l\'IA', () => {
  // Dans un processus neuf : le cache de ce fichier-ci a déjà tout chargé.
  const { execFileSync } = require('node:child_process')
  const script = `
    process.env.SUPABASE_URL = 'http://localhost:54321'; process.env.SUPABASE_SERVICE_KEY = 'k'
    // Des clés d'essai, générées ici et jamais affichées : sans clés, la lecture des
    // appareils n'a pas lieu et le test ne prouverait rien.
    const k = require('web-push').generateVAPIDKeys()
    process.env.PUSH_VAPID_PUBLIC = k.publicKey; process.env.PUSH_VAPID_PRIVATE = k.privateKey
    const lignes = {
      profiles: [{ id: 'p', account_user_id: 'C', member_user_id: 'C', is_owner: true, active: true, access_mode: 'compte', email: 'h@e.fr', phone: null, notify_sms: true, notify_email: true }],
      push_abonnements: [], notifications_reglages: [], properties: [], bookings_snapshot: [], messages: []
    }
    const appels = []
    const db = { from (t) { appels.push(t); const b = { select: () => b, eq: () => b, in: () => b, is: () => b, gte: () => b, order: () => b, limit: () => b,
      insert: () => Promise.resolve({ error: null }), upsert: () => Promise.resolve({ error: null }), delete: () => b, update: () => b,
      maybeSingle: () => Promise.resolve({ data: (lignes[t] || [])[0] || null, error: null }),
      then: (r) => r({ data: lignes[t] || [], error: null }) }; return b } }
    require(${JSON.stringify(require('node:path').join(__dirname, '..', 'lib', 'record-message'))}).recordMessage({ userId: 'C', provider: 'channex', propertyId: 'p1', bookingId: 'b1',
      direction: 'inbound', sender: 'guest', body: 'x', providerMsgId: 'm1', sentAt: new Date().toISOString(), supabase: db,
      notifierMessage: undefined })
      .then(() => {
        const charge = Object.keys(require.cache)
        console.log(JSON.stringify({
          cron: charge.some(k => k.endsWith('/lib/cron-shared.js')),
          ia: charge.some(k => k.includes('@anthropic-ai')),
          appareils: appels.includes('push_abonnements')
        }))
      })
  `
  const lancer = (reglages) => {
    const sortie = execFileSync(process.execPath, ['-e', script.replace('notifications_reglages: []', `notifications_reglages: ${reglages}`)],
      { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' })
    return JSON.parse(sortie.trim().split('\n').pop())
  }
  // Notification cochée (défaut) : les appareils se lisent pour l'envoi.
  const r = lancer('[]')
  assert.equal(r.appareils, true, 'les appareils se lisent par le client du writer')
  assert.deepEqual({ cron: r.cron, ia: r.ia }, { cron: false, ia: false })
  // Notification décochée : les appareils se COMPTENT quand même (Q11) — par le même client.
  const r2 = lancer(`[{ user_id: 'C', evenements: { message_voyageur: { push: false, email: true, sms: false, urgent: false } }, plages: [] }]`)
  assert.equal(r2.appareils, true)
  assert.deepEqual({ cron: r2.cron, ia: r2.ia }, { cron: false, ia: false })
})
