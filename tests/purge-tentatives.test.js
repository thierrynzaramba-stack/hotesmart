// tests/purge-tentatives.test.js
// Spec : docs/specs/spec-moteur-reservation.md §5.2 bis et §6.6
//
// CE QUE CES TESTS DEFENDENT : la decision de Thierry sur les donnees
// personnelles des voyageurs.
//   jamais payee -> ANONYMISATION a 30 jours
//   payee        -> conservation comptable, JAMAIS touchee
//
// Et le choix qui va avec : anonymiser, pas supprimer. La ligne survit pour que
// les abandons restent mesurables sans que personne ne reste identifiable.

const test = require('node:test')
const assert = require('node:assert')
const P = require('../lib/cron-purge-tentatives')

const JOUR = 24 * 60 * 60 * 1000

function base (lignes, marqueur) {
  const etat = { lignes, marqueur, majs: [] }
  etat.supabase = {
    from (nom) {
      const q = { filtres: {}, maj: null }
      const chaine = {
        select () { return chaine },
        eq (c, v) { q.filtres[c] = v; return chaine },
        neq (c, v) { q.filtres[c + '!'] = v; return chaine },
        in (c, v) { q.filtres[c + '@'] = v; return chaine },
        lt (c, v) { q.filtres[c + '<'] = v; return chaine },
        limit () { return chaine },
        update (m) { q.maj = m; return chaine },
        upsert (r) { etat.marqueur = r; return Promise.resolve({ error: null }) },
        async maybeSingle () {
          return { data: nom === 'cron_logs' ? etat.marqueur : null, error: null }
        },
        then (res) {
          if (nom === 'cron_logs') return res({ data: etat.marqueur, error: null })
          if (q.maj) {
            const ids = q.filtres['id@'] || []
            etat.lignes.forEach(l => { if (ids.includes(l.id)) Object.assign(l, q.maj) })
            etat.majs.push({ ids, maj: q.maj })
            return res({ error: null })
          }
          const statuts = q.filtres['status@'] || []
          const limite = q.filtres['created_at<']
          const exclu = q.filtres['guest_email!']
          const sel = etat.lignes.filter(l =>
            statuts.includes(l.status) && l.created_at < limite && l.guest_email !== exclu)
          return res({ data: sel.map(l => ({ id: l.id })), error: null })
        }
      }
      return chaine
    }
  }
  return etat
}

const vieux = new Date(Date.now() - 40 * JOUR).toISOString()
const recent = new Date(Date.now() - 3 * JOUR).toISOString()

const ligne = (id, status, created_at) => ({
  id, status, created_at,
  guest_first_name: 'Ana', guest_last_name: 'Lopez',
  guest_email: `${id}@exemple.com`, guest_phone: '0600000000',
  arrival: '2026-10-01', departure: '2026-10-04', amount_cents: 24000, link_id: 'l1'
})

// ─── Ce qui est anonymise ───────────────────────────────────────────────────
test('les tentatives JAMAIS PAYEES de plus de 30 jours sont anonymisees', async () => {
  const e = base([
    ligne('a', 'pending', vieux), ligne('b', 'failed', vieux), ligne('c', 'expired', vieux)
  ])
  const r = await P.purgerTentatives(e.supabase)
  assert.equal(r.anonymisees, 3)
  for (const l of e.lignes) {
    assert.equal(l.guest_email, P.ANONYME.guest_email)
    assert.equal(l.guest_first_name, '—')
    assert.equal(l.guest_phone, '—')
  }
})

test('ANONYMISATION, PAS SUPPRESSION : la ligne survit', async () => {
  // On garde de quoi mesurer les abandons — combien, sur quel lien, a quel prix
  // — sans garder de quoi identifier qui que ce soit.
  const e = base([ligne('a', 'expired', vieux)])
  await P.purgerTentatives(e.supabase)
  assert.equal(e.lignes.length, 1, 'la ligne ne disparait pas')
  const l = e.lignes[0]
  assert.equal(l.arrival, '2026-10-01')
  assert.equal(l.amount_cents, 24000)
  assert.equal(l.link_id, 'l1')
  assert.equal(l.status, 'expired')
})

// ─── Ce qui n est JAMAIS touche ─────────────────────────────────────────────
test('une tentative PAYEE n est jamais touchee, meme tres ancienne', async () => {
  // Elle porte une transaction : sa conservation releve du comptable.
  const e = base([
    ligne('a', 'paid', vieux), ligne('b', 'booked', vieux), ligne('c', 'refunded', vieux)
  ])
  const r = await P.purgerTentatives(e.supabase)
  assert.equal(r.anonymisees, 0)
  e.lignes.forEach(l => assert.equal(l.guest_email, `${l.id}@exemple.com`))
})

test('une tentative RECENTE n est pas touchee', async () => {
  const e = base([ligne('a', 'expired', recent)])
  assert.equal((await P.purgerTentatives(e.supabase)).anonymisees, 0)
  assert.equal(e.lignes[0].guest_email, 'a@exemple.com')
})

test('la liste des statuts est FERMEE : un statut neuf n est pas anonymise par defaut', async () => {
  // Un `.not(status, in, [payants])` anonymiserait tout statut ajoute plus tard,
  // y compris un statut payant.
  assert.deepEqual(P.JAMAIS_PAYEE, ['pending', 'failed', 'expired'])
  const e = base([ligne('a', 'statut_futur', vieux)])
  assert.equal((await P.purgerTentatives(e.supabase)).anonymisees, 0)
})

test('une ligne DEJA anonymisee n est pas reecrite', async () => {
  // Sinon chaque passage la reecrirait et `updated_at` mentirait sur la date de
  // la derniere anonymisation.
  const l = ligne('a', 'expired', vieux)
  l.guest_email = P.ANONYME.guest_email
  const e = base([l])
  assert.equal((await P.purgerTentatives(e.supabase)).anonymisees, 0)
  assert.equal(e.majs.length, 0)
})

// ─── La cadence ─────────────────────────────────────────────────────────────
test('la purge ne tourne QU UNE FOIS PAR JOUR', async () => {
  // Le cycle tourne toutes les 5 minutes ; balayer la table 288 fois par jour
  // pour anonymiser ce qui a 30 jours n a aucun sens.
  const e = base([ligne('a', 'expired', vieux)])
  const un = await P.purgerSiDue(e.supabase)
  assert.equal(un.anonymisees, 1)
  assert.ok(e.marqueur && e.marqueur.id === P.MARQUEUR, 'le marqueur est pose')

  const deux = await P.purgerSiDue(e.supabase)
  assert.equal(deux.saute, true, 'le second passage du jour ne fait rien')
})

test('le marqueur est pose APRES le travail : une purge ratee se retente', async () => {
  // L inverse du poll des avis, et c est delibere : ici le travail est court et
  // borne, et une purge sautee est une donnee personnelle gardee un jour de trop.
  const e = base([ligne('a', 'expired', vieux)])
  e.supabase.from = (() => {
    const vrai = base([ligne('a', 'expired', vieux)]).supabase.from
    return nom => {
      if (nom === 'booking_attempts') throw new Error('panne')
      return vrai(nom)
    }
  })()
  await assert.rejects(() => P.purgerSiDue(e.supabase))
  assert.equal(e.marqueur, undefined, 'aucun marqueur pose : le passage suivant retentera')
})
