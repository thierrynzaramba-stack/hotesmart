// tests/escalade-alertes.test.js
// « Ça ne va pas » mérite l'heure. « Ça ne va TOUJOURS pas » mérite de l'espace.
//
// VECU LE 18 SEPTEMBRE 2026 : Colomiers avait un menage du 22 sans personne de
// garde — un fait vrai, stable, que personne ne pouvait corriger sur-le-champ.
// L'anti-spam horaire a reexpedie la MEME phrase toutes les heures : 235 e-mails
// sur le compte, au point de noyer un e-mail de test qu'on cherchait. C'est
// litteralement l'alarme qu'on apprend a ignorer.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.FOUNDER_EMAIL = 'fondateur@exemple.test'
process.env.ALERT_BREVO_API_KEY = 'cle-de-test'

const etat = { historique: [], antiSpam: [], inserts: [], maj: [], emails: [], sms: [], erreurLecture: null }

const origine = Module._load
Module._load = function (d, ...reste) {
  if (d === '@supabase/supabase-js') return {
    createClient: () => ({
      // ⚠ `limit()` REND LE BUILDER, pas une promesse. Premiere version du mock :
        // il rendait la reponse, donc le `.eq('property_id')` qui suit dans le code
        // reel s'appliquait a une Promise — la requete ne partait jamais et
        // l'escalade rendait toujours la fenetre de base. Le test echouait en
        // accusant le code, qui etait juste. Un faux client doit imiter la FORME du
        // vrai, sinon il eprouve autre chose que ce qu'on croit.
      from () {
        const b = {
          _cols: '',
          select (cols) { b._cols = String(cols || ''); return b },
          eq: () => b, is: () => b, gte: () => b, order: () => b, limit: () => b,
          insert (row) {
            etat.inserts.push(row)
            return { select: () => ({ maybeSingle: async () => ({ data: { id: 'inc-' + etat.inserts.length } }) }) }
          },
          update (patch) { etat.maj.push(patch); return b },
          then (r) {
            if (etat.erreurLecture) return Promise.resolve({ data: null, error: etat.erreurLecture }).then(r)
            // Deux lectures distinctes, deux reponses : l'escalade demande
            // `detail, created_at, acquitted_at` ; l'anti-spam demande `id, alerted`.
            const pourEscalade = b._cols.includes('acquitted_at')
            return Promise.resolve({
              data: pourEscalade ? etat.historique : etat.antiSpam, error: null
            }).then(r)
          }
        }
        return b
      }
    })
  }
  if (d === './platform-notify') return {
    sendPlatformEmail: async (to, sujet, html) => { etat.emails.push({ to, sujet, html }); return { ok: true } },
    sendPlatformSms: async (to, txt) => { etat.sms.push({ to, txt }); return { ok: true } }
  }
  return origine.apply(this, [d, ...reste])
}

const { reportIncident } = require('../lib/founder-notify')
test.after(() => { Module._load = origine })

const HEURE = 3600 * 1000
const MESSAGE = "Menage du 2026-09-22 : personne n'est de garde ce jour-la."
const ilYA = n => new Date(Date.now() - n).toISOString()

// n alertes consecutives portant le MEME message, aucune acquittee.
const historiqueDe = (n, message = MESSAGE, opts = {}) =>
  Array.from({ length: n }, (_, i) => ({
    detail: { message }, created_at: ilYA((i + 1) * HEURE),
    acquitted_at: opts.acquitteA === i ? ilYA(i * HEURE) : null
  }))

function remise (historique = []) {
  etat.historique = historique
  // L'anti-spam ne voit rien : on eprouve le CALCUL de la fenetre, pas la garde
  // qui la consomme (celle-la a deja ses tests).
  etat.antiSpam = []
  etat.inserts = []; etat.maj = []; etat.emails = []; etat.sms = []
  etat.erreurLecture = null
}

// La fenêtre retenue se lit dans le pied de l'e-mail envoyé.
const fenetreDite = () => {
  const m = /toutes les (\d+) min/.exec(etat.emails[0]?.html || '')
  return m ? Number(m[1]) : null
}

test('premiere occurrence : la fenetre reste d\'une heure', async () => {
  remise([])
  await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: MESSAGE, threshold: 1 })
  assert.strictEqual(etat.emails.length, 1, 'elle alerte')
  assert.strictEqual(fenetreDite(), 60)
})

test('LE TEST QUI COMPTE : un fait qui persiste espace l\'alerte — 1, 2, 4, 8, 16 h', async () => {
  const attendu = { 1: 120, 2: 240, 3: 480, 4: 960 }
  for (const [deja, minutes] of Object.entries(attendu)) {
    remise(historiqueDe(Number(deja)))
    await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: MESSAGE, threshold: 1 })
    assert.strictEqual(fenetreDite(), minutes, `apres ${deja} alerte(s)`)
  }
})

test('LE TEST QUI COMPTE : le plafond est 24 h, quoi qu\'il arrive', async () => {
  for (const deja of [5, 8, 20, 50]) {
    remise(historiqueDe(deja))
    await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: MESSAGE, threshold: 1 })
    assert.strictEqual(fenetreDite(), 1440, `apres ${deja} alertes`)
  }
})

test('LE TEST QUI COMPTE : un fait QUI CHANGE reveille tout de suite', async () => {
  // Un nouveau probleme ne doit pas heriter du silence gagne par l'ancien.
  remise(historiqueDe(6))
  await reportIncident('menage_non_assigne', {
    propertyId: 'P1', detail: 'Menage du 2026-10-05 : personne de garde.', threshold: 1 })
  assert.strictEqual(fenetreDite(), 60, 'retour a l\'heure')
})

test('LE TEST QUI COMPTE : un incident ACQUITTE remet le compteur a zero', async () => {
  // Quelqu'un s'en est occupe : si ca recommence, c'est une nouvelle.
  remise(historiqueDe(6, MESSAGE, { acquitteA: 2 }))
  await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: MESSAGE, threshold: 1 })
  // Deux alertes consecutives avant l'acquittement -> 1 h x 2^2 = 4 h.
  assert.strictEqual(fenetreDite(), 240)
})

test('l\'escalade part de la fenetre DEMANDEE, pas d\'une heure en dur', async () => {
  // `incident-facturation` passe deja 24 h : son escalade doit plafonner, pas
  // redescendre a une heure.
  remise(historiqueDe(1))
  await reportIncident('api_credit', { propertyId: 'P1', detail: MESSAGE, threshold: 1,
    fenetreMs: 12 * HEURE })
  assert.strictEqual(fenetreDite(), 1440, '12 h x 2 = 24 h, au plafond')
})

test('une lecture en echec rend la fenetre de base — jamais de silence', async () => {
  remise([])
  etat.erreurLecture = { message: 'timeout' }
  await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: MESSAGE, threshold: 1 })
  assert.strictEqual(etat.emails.length, 1, 'on prefere une alerte de trop a une alerte manquante')
})

// ─── Les correctifs de review ───────────────────────────────────────────────

test('LE TEST QUI COMPTE : la fenetre elargie ETOUFFE vraiment', async () => {
  // ⚠ Sans ce cas, la suite ne prouvait rien du critere : elle ne lisait que le
  // pied de l'e-mail. Une regression qui calculerait la bonne fenetre puis
  // bornerait la requete avec l'ANCIENNE laisserait tout vert — et les 235
  // e-mails reviendraient. On eprouve donc l'effet, pas l'affichage.
  remise(historiqueDe(4))                 // -> fenetre 16 h
  etat.antiSpam = [{ id: 'x', alerted: true }]   // une alerte dans cette fenetre
  await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: MESSAGE, threshold: 1 })
  assert.strictEqual(etat.emails.length, 0, 'rien ne part : le fait est deja signale')
  assert.strictEqual(etat.inserts.length, 1, 'mais l\'incident est bien persiste')
})

test('LE TEST QUI COMPTE : un AUTRE fait sur le meme bien n\'efface pas l\'anciennete', async () => {
  // `menage_non_assigne` a DEUX producteurs sur un meme bien, avec des phrases
  // differentes, dans la meme passe de cron. Rompre au premier message different
  // faisait repartir A a 1 h des que B s'intercalait : les deux s'etouffaient
  // mutuellement a l'heure — le mode de panne que ce lot corrige.
  const melange = [
    { detail: { message: 'Un AUTRE fait sur ce bien.' }, created_at: ilYA(1 * HEURE), acquitted_at: null },
    { detail: { message: MESSAGE }, created_at: ilYA(2 * HEURE), acquitted_at: null },
    { detail: { message: MESSAGE }, created_at: ilYA(3 * HEURE), acquitted_at: null },
    { detail: { message: MESSAGE }, created_at: ilYA(4 * HEURE), acquitted_at: null }
  ]
  remise(melange)
  await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: MESSAGE, threshold: 1 })
  assert.strictEqual(fenetreDite(), 480, '3 alertes du meme fait -> 8 h, malgre l\'intrus')
})

test('LE TEST QUI COMPTE : apres un long SILENCE, c\'est un episode neuf', async () => {
  // La remise a zero « par acquittement » etait du code mort : `acquitted_at`
  // n'est jamais pose sur ces incidents. Sans rupture par le silence, un fait
  // corrige puis revenu trois jours plus tard heritait du plafond de 24 h et se
  // taisait aussitot apres son premier e-mail.
  const vieux = [
    { detail: { message: MESSAGE }, created_at: ilYA(72 * HEURE), acquitted_at: null },
    { detail: { message: MESSAGE }, created_at: ilYA(96 * HEURE), acquitted_at: null },
    { detail: { message: MESSAGE }, created_at: ilYA(120 * HEURE), acquitted_at: null }
  ]
  remise(vieux)
  await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: MESSAGE, threshold: 1 })
  assert.strictEqual(fenetreDite(), 60, '72 h de silence : on repart de l\'heure')
})

test('un silence court n\'interrompt PAS l\'escalade en cours', async () => {
  // 24 h entre deux alertes, c'est le rythme normal au plafond : ce n'est pas
  // un episode neuf.
  const auPlafond = [
    { detail: { message: MESSAGE }, created_at: ilYA(24 * HEURE), acquitted_at: null },
    { detail: { message: MESSAGE }, created_at: ilYA(48 * HEURE), acquitted_at: null }
  ]
  remise(auPlafond)
  await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: MESSAGE, threshold: 1 })
  assert.strictEqual(fenetreDite(), 240, 'deux alertes comptees -> 4 h')
})

test('un message VIDE se compare comme les autres (aller-retour jsonb)', async () => {
  // `detail.message || JSON.stringify(detail)` rendait `''` cote vivant et
  // `'{"message":""}'` cote relu : jamais egaux, escalade inerte en silence.
  remise([
    { detail: { message: '' }, created_at: ilYA(1 * HEURE), acquitted_at: null },
    { detail: { message: '' }, created_at: ilYA(2 * HEURE), acquitted_at: null }
  ])
  await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: '', threshold: 1 })
  assert.strictEqual(fenetreDite(), 240, 'deux alertes identiques -> 4 h')
})

test('l\'e-mail DIT quand la fenetre a ete elargie', async () => {
  // Sinon le fondateur croit l'alerte perdue alors qu'elle est espacee.
  remise(historiqueDe(3))
  await reportIncident('menage_non_assigne', { propertyId: 'P1', detail: MESSAGE, threshold: 1 })
  assert.match(etat.emails[0].html, /élargi parce que ce fait persiste/)
})
